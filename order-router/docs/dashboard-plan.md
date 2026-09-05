# Admin dashboard + usage storage — implementation plan (v1)

Status: **superseded, kept for its reasoning.** The dashboard shipped, but NOT in the shape
described here: it is served at `/router` on `:443` behind nginx, with self-serve signup and
session cookies, per [`product-plan.md`](./product-plan.md). The loopback-plus-`ssh -L` model below
— and the "**never** an nginx location on `:443`" line in the table — describe a deployment that
was deliberately not taken. What survives is the threat reasoning: read it as the argument the
shipped design had to answer, not as a constraint on it.

## The ask

> "A simple dashboard, where I can log in, see the keys, create, revoke and see the usage per key.
> How would you build this. At what point do we need to move the storing of the requests to a
> database like postgres?"

## Verdict up front

| Decision | Choice |
|---|---|
| Where it runs | **Separate process**, `order-router-admin.service`, own unix user |
| How it is reached | `127.0.0.1:8088` + `ssh -L`. **Never** an nginx location on `:443` |
| Login | One operator, scrypt **N=16384** (not 2¹⁵ — see §3.1), CSRF token + Origin check |
| Key mutations | Shared `mutateKeyFile()` with **compare-and-swap**, adopted by the CLI too |
| Usage collection | Router emits a **dedicated audit stream**; the admin process tails it |
| Usage storage | **SQLite**, hourly rollups, kept forever |
| Router changes | One pino destination. No new hooks, no new routes, no new rejection paths |
| Postgres | **Not now, and not on this box.** Triggers in §5.3 |

---

## 1. Why a dashboard is allowed when `auth-plan.md` banned an admin endpoint

The auth plan rejected an admin HTTP endpoint, and the argument was not about the word "endpoint":

> …it has no non-circular answer to its own credential. Guard it with an admin-flagged key and that
> key must still be bootstrapped out of band; guard it with a separate static secret and you have
> rebuilt exactly the shared-secret design we are replacing, now protecting key **creation** instead
> of key **use**.

Every clause of that survives a rename to "dashboard". What dissolves it is **removing the network
exposure, not the mutation surface**.

Bound to loopback on a box whose firewall permits only 22/80/443, the only way to reach the port is
to already hold SSH. And that credential strictly dominates anything the dashboard offers: an SSH
holder can already `cat keys.json`, run `keys create`, edit the file in vim, and restart the
service. The dashboard therefore adds **zero new authority and zero new bootstrap secret**. It is a
nicer front-end on capability the operator already has.

That is the whole answer, and it only holds while the port stays off `:443`.

> **Written down as forbidden:** nginx already proxies a path prefix, so adding
> `location /router/admin/` is four lines. Do not. If internet access is ever genuinely needed, the
> answer is a client certificate or an `allow <fixed IP>`, plus a second factor — not a password on
> the public internet, which is *worse* than the admin-flagged API key the plan already rejected,
> because a human-chosen password is guessable where 256 CSPRNG bits are not.

**Better than the SSH tunnel, if available:** a WireGuard mesh (Tailscale et al). It needs no
inbound port, no DNS and no new hostname; it gives the dashboard a private IP, which *also*
dissolves the localhost CSRF problem in §3.2; and it works from a phone. Same security argument,
strictly better ergonomics. The SSH tunnel is the no-new-dependencies fallback.

## 2. Where it runs — separate process

Availability decides this before anything else does. A router restart rebuilds the entire order-book
cache and degrades `/route` for **minutes**; the README already lists "a dead process is an outage"
as an open risk. In-process means every CSS tweak costs that.

Three more reasons stack on top:

- It is the cleanest possible answer to the hook-ordering constraint. A separate process adds
  literally zero middleware to the router — nothing at `onRequest`, nothing before
  `@fastify/websocket`, no new rejection path. The invariants in `server.ts` survive untouched by
  construction rather than by review.
- **The router process writes no files at all today** (verified: no `writeFileSync` /
  `createWriteStream` / `appendFileSync` outside the CLI and key store). Its disk behaviour is a
  property worth keeping.
- Memory isolation on a box with **~1 GB available**. `MemoryMax=192M` makes the dashboard the first
  thing the kernel kills if it misbehaves, rather than the router.

```ini
# /etc/systemd/system/order-router-admin.service
[Service]
User=order-router-admin
ExecStart=/usr/bin/node /opt/order-router/dist/admin/server.js
MemoryMax=192M
CPUWeight=20
Nice=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/order-router/keys.json /var/lib/order-router
RestrictAddressFamilies=AF_INET AF_UNIX
SystemCallFilter=@system-service
```

A design whose entire security argument is process placement should spend the ten lines that make
the placement mean something.

## 3. Login

### 3.1 Password hashing — the opposite call from API keys, and one landmine

API keys are stored as **unsalted SHA-256, no KDF**. A login password is **salted scrypt**. That is
not inconsistency, and the reason should sit next to the code so nobody "fixes" one into the other:

|  | API key | Admin password |
|---|---|---|
| Entropy | 256 CSPRNG bits | ~40 bits, human-chosen, reused across sites |
| Offline guessing | no dictionary exists | the entire threat |
| Lookup shape | by digest, over N keys | by username, N=1 |
| Cost budget | once per request, vs a 0.3 ms route | once per login, ~10×/day |

A salt would break the key store (salted hashes can't be looked up → O(N) scan → leaks *which* key
matched). With N=1 that objection has no occupant.

> **Landmine, verified on this exact Node (v22.22.1):** `scryptSync(pw, salt, 32, {N: 2**15, r: 8})`
> throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`. Node's default `maxmem` is 32 MiB and `128·N·r` is
> exactly 33,554,432 — one byte over. **Use N=16384** (16 MiB, measured **22 ms**), or pass `maxmem`
> explicitly. 2¹⁵ is the value you'd reach for by default and it fails at runtime, not at review.

Set over SSH: `npm run admin:passwd`. Cap in-flight verifications at 2 and throttle per-IP *before*
the KDF runs — 16 MiB × unbounded concurrency inside a 192 MB cgroup is a self-DoS.

### 3.2 CSRF — `SameSite` does not work here

**`SameSite=Strict` provides zero protection on localhost.** A cookie's "site" is scheme +
registrable domain; **the port is not part of it**. So `http://localhost:3000` and
`http://localhost:8088` are same-site, and the admin session cookie is attached in full to POSTs
originating from *any other listener on the operator's laptop* — dev servers, Electron apps,
anything. On a developer machine that set is non-empty by definition.

Required instead:

1. A per-session CSRF token in a hidden form field, compared with `timingSafeEqual`.
2. An `Origin`/`Host` allowlist on every mutating request, rejecting anything unexpected.
3. **Session id rotation on login** — without it, a same-site cookie write is textbook session
   fixation (attacker plants an id, operator logs in, attacker's id is now authenticated).
4. `HttpOnly; SameSite=Strict; Path=/`. **No `Secure`** — the page is `http://localhost` over an SSH
   tunnel, so `Secure` would prevent the cookie being set at all; SSH supplies the transport
   encryption `Secure` exists to guarantee. Worth a comment, or someone will "fix" it.

Sessions are a `Map<tokenHash, {expiresAt}>` in the process. One user, one process, one machine —
losing sessions on restart is a feature. Session ids go back to bare SHA-256 for the same reason API
keys do: 256 CSPRNG bits, O(1) lookup.

### 3.3 XSS

Any XSS here is same-origin and therefore **mints keys** — the tunnel and SameSite are both
irrelevant to it. Server-rendered HTML with contextual escaping (not string concatenation) over
every operator-controlled field: `name`, `note`, `createdBy` (which is `$SUDO_USER`), audit detail.
CSP `default-src 'self'`, no `unsafe-inline`, nonce for any inline script.

## 4. Key mutations — two writers is the new problem

Today the CLI is the only writer, so read-modify-write is safe by luck. The dashboard makes it two.
A lockfile with a stale-breaker is a *lost-update machine*: writer A stalls, B breaks the lock at
30 s, B writes a revocation, A completes from its stale copy and **un-revokes the killed key**.

Use **compare-and-swap** instead: re-`stat` (inode + mtime + size) immediately before `rename`, and
abort if anything changed. That also covers the 3 a.m. `vim keys.json` path, which takes no lock at
all. Never auto-break; fail loudly.

Extract `mutateKeyFile()` into `keyStore.ts` and have the **CLI adopt it too** — that fixes a latent
gap in today's behaviour as a side effect.

Also required, and missing today: **server-side caps on `rateLimitMax` and `wsMaxConnections`**. A
key minted with `rateLimitMax: 1e9` is a targeted-outage lever aimed at the process whose death
costs minutes of degraded routing. Cap in `mutateKeyFile()`, not in the form.

| Operation | Where |
|---|---|
| create, revoke, edit limits | UI **and** CLI |
| **delete** | **CLI only** — irreversible, destroys attribution, rare |

## 5. Usage per key

### 5.1 The log cannot be the usage store

Measured on the live box:

- An access line is **277 bytes**; a `route_recommendation` line is **1,151 bytes** → ~1.4 KB per
  routed request.
- Log rotation is `size 200M, rotate 4` → a hard ceiling of ~1 GB.
- The log currently holds **12 event lines out of 1,952,180** — 0.0006%. It is overwhelmingly
  connector diagnostics.

| Sustained rate | Requests/day | Raw bytes/day | How long a 1 GB window holds |
|---|---|---|---|
| 0.1 req/s | 8,640 | 12 MB | 81 days |
| **1 req/s** | 86,400 | 123 MB | **8 days** |
| 10 req/s | 864,000 | 1.2 GB | 0.8 days |

So "usage last month" from the log is not slow — it is **silently partial**. A wrong number, not an
error. And the retention window *shrinks as traffic grows*, which is exactly backwards for a usage
record. This is true at today's volume, not eventually.

### 5.2 The pipeline

```
router ──(pino second destination)──> /var/log/order-router-audit.log
                                                │
                              admin process tails it with a byte cursor
                                                │
                       ┌────────────────────────┴────────────────────────┐
                       │  ONE SQLite transaction: rollup rows + cursor   │
                       └─────────────────────────────────────────────────┘
```

**Router change: one pino destination.** The `event`-bearing records go to their own file instead of
being buried in connector noise. That keeps the tailer reading a small clean stream, gives the audit
data its own rotation policy, and — importantly — is a change to the *existing* logging path, not
new I/O logic on the hot path. Rotate it with `create`, **not `copytruncate`**: under `copytruncate`
a tailer silently loses everything between its committed offset and the truncation point, which is a
recurring undercount presented as success.

**Commit the cursor in the same transaction as the rows.** That single property makes replay
idempotent and crash-safe: you either advanced and counted, or you did neither. It is what makes
`ON CONFLICT DO UPDATE SET requests = requests + excluded.requests` safe.

```sql
CREATE TABLE usage_hour (
  hour_start   INTEGER NOT NULL,   -- unix hour bucket
  key_id       TEXT    NOT NULL,
  route        TEXT    NOT NULL,   -- route TEMPLATE, never the raw URL
  status_class INTEGER NOT NULL,   -- 2, 4, 5 — not the exact code
  requests     INTEGER NOT NULL,
  duration_sum REAL    NOT NULL,
  PRIMARY KEY (hour_start, key_id, route, status_class)
) WITHOUT ROWID;

CREATE TABLE ingest_cursor (stream TEXT PRIMARY KEY, offset INTEGER, inode INTEGER);
```

`route` template not raw URL, `status_class` not status code — the same cardinality discipline
`/metrics` already applies, carried into SQL. No per-symbol breakdown, for the same reason.

**Hours, kept forever. One table, no compaction job.** Minute-granularity and a retention ladder
were both considered and cut: nothing in the ask needs them, and a nightly multi-million-row
`DELETE` is a third code path that can produce wrong numbers. Debugging a spike is the log's job for
the few days anyone cares.

| Keys | Rows/year | SQLite size/year |
|---|---|---|
| 10 | 263k | **~39 MB** |
| 100 | 2.6M | ~394 MB |
| 1,000 | 26M | ~3.9 GB |

*(assumes ~3 route×status pairs touched per key per hour, ~150 B/row with the index)*

`node:sqlite` is built into Node 22 — no native module, no node-gyp churn on Node upgrades. It emits
an experimental warning; that is the cost.

> **Why the router does not write the counters itself.** `node:sqlite` is **synchronous**. Putting it
> on the event loop of a service that ships per-shard event-loop-utilization metrics *because that
> loop is the product* is exactly wrong. If the router is ever made to count, the sink must be a
> non-blocking append or a datagram socket that drops when full — and the only permitted location is
> inside the **existing** `onResponse` hook, which runs after the response is sent and cannot
> reorder anything upstream.

### 5.3 When does this need Postgres?

**Not for the dashboard, and not for anything currently visible.** SQLite serves the numbers above
for years.

More importantly: **Postgres cannot go on this box.** ~1 GB is available; a minimal PG16 wants
~330 MB steady, and the OOM killer gets a coin-flip at the process whose restart costs minutes of
degraded routing. "Move to Postgres" therefore means "move off-box" — a topology change, not a
storage swap. Budget for it accordingly.

The triggers are **topological and commercial**, not byte counts:

| # | Trigger | Why SQLite stops working |
|---|---|---|
| **T1** | A **second host** serves traffic | One file on one box cannot be the shared write target. This will almost certainly fire first. |
| **T2** | Usage **settles invoices** | Money rows and usage rows must be transactionally consistent and reconcilable. A dispute needs per-request detail, not hourly sums. |
| **T3** | **Per-request retention** is required | 1 req/s ≈ 0.5 GB/month; 10 req/s ≈ 5.2 GB/month. SQLite can hold it; this box cannot. |
| **T4** | Concurrent analytical readers | One writer + ad-hoc dashboards start contending. |

Note what is *not* on that list: request volume alone. Rollups are indifferent to it — 1 req/s and
1,000 req/s produce the same number of hourly rows. Volume only matters once T2 or T3 forces you to
keep the requests themselves.

**The migration is an extension, not a rewrite,** because the pipeline shape survives it: the tailer
gains a second consumer, SQLite is demoted to a durable local spool so a remote-DB outage cannot
touch the box, and the schema and every query carry over unchanged.

There is also a **transport** trigger, distinct from storage: above ~500 req/s, tailing a text log
becomes the bottleneck and the router should emit to a socket instead. That changes the transport
and leaves the schema alone.

## 6. What the dashboard shows

| View | Content |
|---|---|
| Keys | id, name, created, createdBy, note, limits, status, `…last4`, **last used** (from `usage_hour`, not from a field the server writes) |
| Key detail | requests/day sparkline (30d), by route, by status class, mean duration |
| Create | name + note + optional limits → shows the key **once**, then never again |
| Revoke | confirm → writes `revokedAt` → live within 10 s |
| Audit | append-only admin action log: who did what, when |

Polls every 10 s. A WebSocket for a page one person looks at is not worth the code.

## 7. Deliberately not in v1

- **Postgres, in any form.** Triggers are written down; none has fired.
- **Any nginx exposure.** Loopback + SSH only. The upgrade path (client certs + TOTP + `Secure`
  cookie) is specified, not built.
- **TOTP.** Behind SSH the password is already the second factor after the SSH key. It becomes a
  hard prerequisite the day the nginx path is taken.
- **Delete from the UI.** CLI only.
- **Any customer-facing view.** No per-tenant login, no signup. That needs an identity system this
  service deliberately does not have.
- **Invoicing, pricing, plans.** The pipeline is shaped so these extend it; none is built.
- **Per-request rows.** The log answers those questions for as long as anyone cares.
- **Percentiles.** Count and duration sum only, so mean is available; `/metrics` already carries the
  latency histogram.
- **A frontend build step.** Server-rendered HTML, three static files, no bundler, no CDN.
- **Any change to the router beyond the pino destination.**

## 8. Open questions I would want answered before building

1. **Is a WireGuard mesh available?** If yes it replaces the SSH tunnel and removes the localhost
   CSRF problem outright. Materially changes §3.2.
2. **Does `k_<8 hex>` (32 bits, reusable after `delete`) need to become the billing primary key?** If
   usage ever settles money, a reused id silently merges two customers. Widening it is free now and
   expensive later.
3. **Where do alerts go?** Ingest lag, reconciliation divergence and disk-full are all detectable and
   currently have no delivery path on this box. An alert nobody receives is worse than none, because
   it gets booked as mitigation.
