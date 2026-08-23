# Multi-key API authentication — implementation plan (v1)

Status: **plan, not shipped.** Supersedes the single shared key in `src/api/auth.ts` and the
"stopgap, not an auth system" note in README § Security.

## The ask, restated

> "Something very simple at the beginning where it's easy to create and delete keys and be able to
> relate the key to the requests made by that key."

Three requirements, in priority order:

1. **Simple.** No IAM. No OAuth, no JWT, no user accounts, no database server, no new daemon.
2. **Create/delete easily** by an operator with SSH on the single VM (`/opt/order-router`,
   `order-router.service`, env at `/opt/order-router/env`).
3. **Attribution.** Every request resolvable to the key that made it, joined to the existing
   `requestId` + `/route` audit record.

Everything below is chosen against those three, in that order.

## Verdict up front

| Decision | Choice |
|---|---|
| Storage | **JSON file**, `/opt/order-router/keys.json`, mode `0600`, atomic-rename writes |
| Load model | Read once at boot into `Map<sha256hex, ApiKeyRecord>`; reload on `SIGHUP` **and** on a 10 s mtime poll |
| Key format | `or_live_` + 43 chars base64url (32 random bytes) |
| Hashing | Bare `SHA-256`, hex, **unsalted, no KDF** — see § 2.3 |
| Lookup | Hash the presented key, one `Map.get`. O(1), no iteration, no per-key compare |
| Lifecycle | **CLI only** (`npm run keys:create|list|revoke|delete`). No admin HTTP endpoint in v1 |
| Hook position | **Unchanged**: `preValidation` via `fastify-plugin`, plus `setNotFoundHandler`. Do not touch |
| Attribution | `keyId` + `keyName` bound via `childLoggerFactory` → present on *every* log line for the request |
| Migration | Env key is loaded as a synthetic record `k_legacy`; both schemes valid simultaneously |
| Shards | Do **not** get the key store. Only the HTTP-serving parent and the MCP process load it |

---

## 1. Storage

### 1.1 The comparison

| | JSON file | SQLite | Redis |
|---|---|---|---|
| New daemon / process to run and monitor | no | no | **yes** |
| New native dependency | no | `better-sqlite3` (node-gyp / prebuild churn on every Node bump) | `ioredis` (pure JS) |
| Survives restart | yes | yes | only with AOF/RDB configured correctly — a silent-data-loss footgun |
| Operator can read it with `cat` | **yes** | needs `sqlite3` CLI | needs `redis-cli` |
| Operator can back it up | `cp` | `.backup` | `BGSAVE` + copy the dump |
| Concurrent writers | poor (we have exactly one: the CLI) | good | good |
| Query "which keys exist" | `jq` | SQL | `SCAN` + `HGETALL` per key |
| Fits "single VM, no external state" | yes | yes | **no** — README explicitly has no Redis/cross-host story |

### 1.2 Verdict: JSON file

We are storing **tens of keys, written by a human, a few times a year, and read once per process
boot.** That workload has no property that a database provides. Concretely:

- The service is a **reader**. Nothing on the request path writes to the store (see § 1.5 for the
  one exception and how it's kept off the hot path). The write concurrency SQLite exists to solve
  does not occur.
- Redis is disqualified twice over: it adds a second process to the availability story of a
  service whose README already lists "a dead process is an outage" as an open blocker, and its
  durability is a configuration property rather than a guarantee. Trading durable auth data for a
  cache's durability model is the wrong direction.
- SQLite is the *right* answer at a different scale, and § 8 names the trigger to move (>1,000 keys,
  or wanting per-request usage counters persisted). Today it buys indexes we don't need and a
  native module we'd have to rebuild on every Node upgrade.
- "Operator can edit it" is a real requirement, not a nicety. When the CLI is broken at 3 a.m., the
  fix for a compromised key is `vim keys.json`, set `revokedAt`, save. That is worth a lot.

### 1.3 Exact file format

`/opt/order-router/keys.json`, owned by the service user, mode `0600`. Path from
`ORDER_ROUTER_KEYS_FILE` (default `./data/keys.json` for dev; the systemd unit sets the absolute
path). Added to `.gitignore` alongside `dist/`.

```json
{
  "version": 1,
  "keys": [
    {
      "id": "k_7f3a91c2",
      "name": "acme-trading-desk",
      "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "last4": "x7Qa",
      "createdAt": "2026-08-23T10:14:02.113Z",
      "createdBy": "pablo",
      "revokedAt": null,
      "lastUsedAt": "2026-08-24T09:01:55.402Z",
      "note": "issued for the docs.ccxt.com demo",
      "rateLimitMax": null,
      "wsMaxConnections": null
    }
  ]
}
```

Field-by-field, with the reasoning that matters:

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Loader **hard-fails** on an unknown version rather than guessing. Adding `scopes` in v2 bumps this. |
| `id` | `k_` + 8 hex | Independent of the secret. This is the thing that goes in logs, metrics, tickets, invoices. Stable forever. |
| `name` | string | Human label, unique-enforced by the CLI so `keys:revoke acme-desk` works without looking up an id. |
| `hash` | 64 hex chars | `sha256(plaintext)`. The **only** representation of the secret that exists after creation. |
| `last4` | 4 chars | Last 4 chars of the plaintext. Lets an operator match a user's screenshot to a row without a hash lookup. 4 chars of base64url = 24 bits, which is not a meaningful reduction of a 256-bit secret. |
| `createdAt` / `createdBy` | ISO 8601 / `$SUDO_USER \|\| $USER` | Who issued it. Cheap, and the first question asked in an incident. |
| `revokedAt` | ISO 8601 or `null` | Non-null ⇒ the key is not loaded into the lookup map. **Revocation is the default kill action**; the row survives so `keyId` in a year-old log line still resolves to a name. |
| `lastUsedAt` | ISO 8601 or `null` | Answers "which of these 12 keys is dead and can be revoked?". See § 1.5 for why this is not a hot-path write. |
| `note` | string | Free text. |
| `rateLimitMax` | number or `null` | Per-key override of `ORDER_ROUTER_RATE_LIMIT_MAX`. `null` = global default. |
| `wsMaxConnections` | number or `null` | Per-key override of `ORDER_ROUTER_WS_MAX_CONNECTIONS_PER_KEY`. |

**No `scopes` field in v1.** A stored-but-unenforced `scopes` array is a footgun: an operator sets
`"scopes": ["read"]`, assumes it's enforced, and it isn't. The schema `version` is the extension
point instead. If a `scopes` key appears in a v1 file, the loader **rejects the file** rather than
ignoring it — an explicit error beats a silent no-op.

### 1.4 Write semantics

Only the CLI writes. Every write is: serialise → `write` to `keys.json.tmp` in the same directory →
`fsync` → `rename()`. `rename()` within a filesystem is atomic, so a reader either sees the whole
old file or the whole new one, never a truncation. `chmod 0600` on the tmp file *before* writing
content, so the secrets never briefly exist as world-readable.

### 1.5 `lastUsedAt` without touching the hot path

Persisting `lastUsedAt` on every request would put a disk write on a ~0.3 ms request path and make
the file a contended read-write resource. Instead:

- The auth path sets `record.lastUsedAt = Date.now()` **in memory only** (a field write, ~0 cost).
- A `setInterval(…, 60_000).unref()` flusher re-reads the file, merges `lastUsedAt` into rows that
  still exist (by `id`), and atomic-renames. Rows the CLI deleted meanwhile are not resurrected.
  Also flushed on `SIGTERM` before exit.
- Last-write-wins between the flusher and the CLI is harmless because they touch disjoint fields —
  the flusher only ever writes `lastUsedAt`.

This is the one piece of v1 with moving parts that could be cut. If it causes trouble, drop it and
answer the same question from the access log (§ 5). It is included because "which key is dead" is
the most common operational question and grepping logs for *absence* is much worse than reading a
field.

### 1.6 Reload — how a new key goes live without a restart

Restarting the router is expensive: at discovery scale it rebuilds the whole order-book cache and
the `/route` answers are degraded for minutes. Creating a key must not cost that.

Two triggers, both landing in the same `reload()`:

1. **`SIGHUP`** — for "right now". `ExecReload=/bin/kill -HUP $MAINPID` in the unit, so
   `sudo systemctl reload order-router` works.
2. **mtime poll**, every 10 s (`fs.statSync`, ~10 syscalls/min — free). This is the default path and
   the reason the CLI needs no privileges beyond writing one file.

The poll is not redundant belt-and-braces. The failure it removes is the dangerous one: an operator
revokes a compromised key, forgets the reload, and the key keeps working indefinitely with no
error anywhere. Revocation that silently doesn't revoke is a security bug, not an inconvenience.

Rejected: `fs.watch`. Atomic-rename writes make it fire inconsistently across platforms and
filesystems (it can report on the inode we no longer have open, double-fire, or miss entirely).
A 10 s stat is boring and correct.

**Failure modes on load are deliberately asymmetric:**

| Situation | At boot | On reload |
|---|---|---|
| File missing | empty store, `logger.warn`, **start anyway** | keep previous snapshot, warn |
| File malformed / bad `version` | **refuse to start** | **keep previous snapshot**, `logger.error`, do not swap |
| File valid | load | atomic swap of the whole Map |

Missing-at-boot must not be fatal, or deploying the code before creating the file bricks startup.
Malformed-on-reload must never wipe the live store, or a fat-fingered `vim` becomes a total outage.
The swap is a single assignment of a freshly-built Map, so no request ever observes a half-built one.

**The dev fallback survives, with its existing reasoning intact.** If the file is missing *and*
`ORDER_ROUTER_API_KEY` is unset, load the existing well-known `DEV_API_KEY`
(`dev-local-key-change-me`) as a synthetic record `{ id: 'k_dev', name: 'insecure-dev-key' }` and
emit the same loud startup warning as today. Without this, `npm run dev` and every existing local
workflow break on first run with a 401 and no obvious cause. The property that matters is
unchanged: an unconfigured deployment is *obviously* wrong (a well-known literal plus a warning)
rather than *subtly* wrong. Its record is flagged so `keys:list` prints it as `(insecure default)`,
and it is suppressed the moment either a real key file or the env var exists.

### 1.7 Shards do not get the store

Explicitly: `src/sharding/shardWorker.ts` never serves HTTP and never sees a request header. It
owns ccxt connectors and pushes book/health/fee messages to the parent over IPC. The key store is
loaded in exactly **two** processes:

- the parent (`src/index.ts` → `buildServer`), which is the only HTTP listener, and
- the MCP process (`src/mcp/server.ts`), which has its own listener on :8081.

Shards must **not** load it — the rebalance path restarts shards, and having them re-read and
re-poll a secrets file for no reason is pure downside (more file handles, more surface, a second
place a stale snapshot could hide).

---

## 2. Key format

### 2.1 On the wire

```
or_live_kQ8vN2pR7wZ3xL9mT4bY6cF1hJ5sD0aG8nV2eU7iO3x7Qa
└──┬──┘ └──────────────────────┬──────────────────────┘
  prefix              43 chars base64url = 32 random bytes
```

- Generated as `'or_live_' + randomBytes(32).toString('base64url')`.
- 256 bits of CSPRNG entropy. Total length 51 chars. Alphabet `[A-Za-z0-9_-]`, so it is safe in a
  header, a URL, a shell argument and a JSON string with no escaping.
- Validation regex: `/^or_(live|test)_[A-Za-z0-9_-]{43}$/`.
- `or_test_` is reserved for a future staging deployment. v1 only mints `or_live_`; the loader
  accepts both so a staging box can be stood up later without a format change.

### 2.2 Why the prefix earns its 8 characters

1. **Secret scanning.** GitHub push protection, `gitleaks`, and `trufflehog` all match on
   distinctive literal prefixes. A bare 43-char base64 blob is indistinguishable from a hash, a
   nonce, or a base64'd image and will never be caught. `or_live_` is a greppable, registrable
   pattern — the single highest-value property here, because the realistic leak is a key pasted
   into a repo, a Jupyter notebook, or a Slack message, not a break of the store.
2. **Log hygiene.** We can assert in CI that no captured log output ever contains `or_live_`, and
   we can add a pino redaction rule keyed on the pattern. That test is only writable because the
   prefix exists.
3. **Support.** A user can paste `or_live_kQ8v…` (prefix + first 4) into a ticket with no risk, and
   `last4` closes the identification. Nobody has to ask "can you send me the key".
4. **Environment safety.** When staging exists, an `or_test_` key pasted into production fails with
   an unambiguous cause instead of a generic 401.

### 2.3 Hashing: SHA-256, unsalted, no KDF — deliberately

This looks wrong to anyone with password-storage instincts. It isn't, and the reasoning should
live next to the code:

- The secret is **256 bits from a CSPRNG**, not a human-chosen password. There is no dictionary, no
  reuse across sites, no rainbow table. The entire threat a KDF defends against (offline guessing
  of a low-entropy secret) does not exist.
- bcrypt/argon2 would cost **milliseconds per request** on a service whose whole route computation
  is ~0.3 ms. Auth would become 95% of the request. That is not a trade, it's a regression.
- **A per-key salt would break the design.** Salted hashes cannot be looked up — you must try each
  candidate salt in turn, which is O(N), re-introduces the "which key matched" timing signal, and
  hands an attacker a CPU-amplification lever. Unsalted SHA-256 is precisely what makes the O(1)
  constant-time-by-construction lookup in § 4 possible.
- This is the same reasoning GitHub and Stripe apply to API tokens (as opposed to passwords).

What we get: if `keys.json` leaks, the attacker has 64-hex digests of 256-bit random values and no
way back to a usable credential. Which is the actual requirement.

---

## 3. Lifecycle operations

### 3.1 CLI, not an admin HTTP endpoint

**Verdict: CLI.** An admin HTTP endpoint is the recursion trap, and it has no non-circular answer:

- Protect it with an API key that has an `admin` flag ⇒ that key must be bootstrapped
  out-of-band ⇒ you need the CLI anyway ⇒ the endpoint is pure addition, not a replacement.
- Protect it with a separate `ORDER_ROUTER_ADMIN_KEY` in the env file ⇒ that is *exactly the shared
  static secret design we are replacing*, now guarding key **creation** instead of key **use**.
  Strictly worse blast radius: leaking it mints keys rather than reading quotes.
- Either way it is a permanently-exposed privilege-escalation surface reachable by anyone who can
  reach :443, on a service whose only current auth defect is that it has one shared secret.

The operator already has SSH to `/opt/order-router` — that is how the env file gets edited today.
A CLI adds capability with zero new network surface. A read-only `GET /admin/keys` bound to
loopback behind nginx `allow 10.0.0.0/8` is a defensible v2 if a dashboard is ever wanted; a
create/delete endpoint is not, until there is a real identity system behind it.

### 3.2 Command surface

New file `src/cli/keys.ts`, compiled to `dist/cli/keys.js`. No new dependency — `node:util`'s
`parseArgs` covers this.

```jsonc
// package.json
"scripts": {
  "keys:create": "node dist/cli/keys.js create",
  "keys:list":   "node dist/cli/keys.js list",
  "keys:revoke": "node dist/cli/keys.js revoke",
  "keys:delete": "node dist/cli/keys.js delete"
}
```

```bash
# create — prints the plaintext exactly once, to stdout, and never again
$ npm run keys:create -- --name acme-desk --note "docs demo" --rate-limit 1200
  id         k_7f3a91c2
  name       acme-desk
  key        or_live_kQ8vN2pR7wZ3xL9mT4bY6cF1hJ5sD0aG8nV2eU7iO3x7Qa
  created    2026-08-23T10:14:02.113Z
  ! This is the only time the key is shown. It is stored hashed and cannot be recovered.
  ! Live within 10s (mtime poll), or immediately with: sudo systemctl reload order-router

# list — never shows a key, only its identity
$ npm run keys:list
  ID          NAME              CREATED      LAST USED    RL     STATUS
  k_7f3a91c2  acme-desk         2026-08-23   2026-08-24   1200   active     …x7Qa
  k_2b8e01ff  mcp-prod          2026-08-23   2026-08-24   -      active     …9mLp
  k_legacy    legacy-shared-key -            2026-08-24   -      active     (env)
  k_4c1d77aa  old-intern-laptop 2026-06-01   2026-06-14   -      revoked    …p2Kd
$ npm run keys:list -- --json          # jq-able, same fields
$ npm run keys:list -- --include-revoked

# revoke — the default kill action; row survives so old log lines still resolve
$ npm run keys:revoke -- acme-desk           # accepts id or name
  revoked k_7f3a91c2 (acme-desk) at 2026-08-24T11:02:10.551Z

# delete — removes the row entirely; refuses without --yes
$ npm run keys:delete -- k_4c1d77aa --yes
  deleted k_4c1d77aa. WARNING: 'keyId":"k_4c1d77aa"' in existing logs is now unresolvable.
```

On the VM, as the service user, no root needed for the common case:

```bash
sudo -u order-router node /opt/order-router/dist/cli/keys.js create --name acme-desk
```

`revoke` vs `delete` is a real distinction and the CLI should push people toward `revoke`:
`revoke` keeps attribution intact forever; `delete` is only for a key created by mistake that never
made a request. Both take effect on the next reload; both are equally immediate for new requests.

Every CLI mutation also writes one JSON line to stderr with `event: "key_admin"`, `action`,
`id`, `name`, `actor` — so that if the operator redirects it, key management is auditable too.
(Wiring it into the service's own log stream is v2; the CLI is a different process.)

---

## 4. Runtime lookup path

### 4.1 The two properties that must not regress

Both are already correct in `src/api/server.ts` and both are preserved **by not moving anything**:

1. **Auth stays at `preValidation`, registered through `fastify-plugin`.** `@fastify/rate-limit`
   attaches its check as a *route-level* `onRequest` hook, and route-level `onRequest` hooks run
   after every instance-level `onRequest` hook — so an instance-level auth hook at `onRequest`
   precedes the limiter regardless of registration order, and every 401 short-circuits before being
   counted (measured: 30 wrong-key requests against a limit of 10 returned 401×30, never 429).
   `preValidation` runs after the entire `onRequest` chain, so the limiter fires first.
2. **`setNotFoundHandler` keeps re-checking auth**, because `preValidation` only runs for *matched*
   routes; without it an unknown path 404s before auth and hands out a route-enumeration oracle.

The only change inside both is *what* the check calls: `store.lookup(presented)` instead of
`safeCompare(presented, apiKey)`. Position, hook name, plugin wrapper, and the 401 body all stay
byte-identical.

**The WS corollary.** The FD leak (~1,700 sockets/sec) happened because a rejection at `onRequest`
set `reply.sent`, halting the hook chain, so `@fastify/websocket`'s own `onRequest` hook never ran,
`request.ws` was never set, and its `onResponse` cleanup no-oped on a socket Node had already
handed off. Rule for this change, stated as a rule so a future reviewer can enforce it:

> **No new rejection may be added at `onRequest`, `preParsing`, or anywhere before
> `@fastify/websocket`'s own `onRequest` hook has run.** Auth rejections happen at `preValidation`;
> per-key stream rejections happen *inside* the websocket handler via `socket.close(1013)`, which
> is post-upgrade and closes cleanly. Both existing regression tests stay, with a revoked key added
> to their path lists.

### 4.2 The store interface

```ts
// src/api/keyStore.ts
export interface ApiKeyRecord {
    id: string; name: string; hash: string; last4: string;
    createdAt: string; createdBy: string;
    revokedAt: string | null; lastUsedAt: string | null;
    note: string;
    rateLimitMax: number | null; wsMaxConnections: number | null;
}

export class ApiKeyStore {
    // hex sha256 -> record. Revoked keys are NOT in this map, so revocation is a load-time
    // filter rather than a per-request branch.
    private byHash = new Map<string, ApiKeyRecord>();

    lookup (presented: string): ApiKeyRecord | undefined {
        // One digest, one Map hit. No iteration over keys, ever — see 4.5.
        const digest = createHash('sha256').update(presented, 'utf8').digest('hex');
        const record = this.byHash.get(digest);
        if (record !== undefined) record.lastUsedAt = new Date().toISOString();
        return record;
    }

    reload (): void { /* atomic swap; keeps the previous Map on parse failure */ }
    listAll (): ApiKeyRecord[] { /* includes revoked; for the CLI */ }
}
```

### 4.3 Wiring, in lifecycle order

```
TCP accept
  └─ genReqId(rawReq)                    ← requestId minted here (was: inside /route)
  └─ childLoggerFactory(logger, …, rawReq)  ← binds { reqId, keyId, keyName } onto request.log
  └─ instance onRequest hooks            ← (none of ours)
  └─ route onRequest hooks
       └─ @fastify/websocket sets request.ws     ← must not be short-circuited before this
       └─ @fastify/rate-limit: keyGenerator, then max()   ← counts EVERY request, incl. bad auth
  └─ preValidation
       └─ order-router-auth  ← store.lookup(); 401 here. Position unchanged.
  └─ handler (/route, /stream/best upgrade, …)
  └─ onResponse
       └─ prom histogram (existing)
       └─ access log line  { event: "request", keyId, … }   ← new
```

Resolution is memoised per request so the limiter's `keyGenerator`, the limiter's `max()`, the auth
hook, the not-found handler and the WS handler all share **one** digest:

```ts
app.decorateRequest('apiKeyRecord', null);
app.decorateRequest('apiKeyResolved', false);

function resolveKey (request: FastifyRequest): ApiKeyRecord | undefined {
    if (!request.apiKeyResolved) {
        const presented = extractApiKey(request.headers as Record<string, unknown>);
        request.apiKeyRecord = presented === undefined ? null : (store.lookup(presented) ?? null);
        request.apiKeyResolved = true;
    }
    return request.apiKeyRecord ?? undefined;
}
```

Rate limiter (verified against `@fastify/rate-limit@11.2.0` types — `max` accepts
`(req, key) => number`, `keyGenerator` returns `string`):

```ts
await app.register(rateLimit, {
    // Per-key override; global default otherwise.
    max: (request) => resolveKey(request)?.rateLimitMax ?? rateLimitMax,
    timeWindow: rateLimitWindowMs,
    keyGenerator: (request) => {
        const record = resolveKey(request);
        // Bucket by the stable key ID, never by the secret: the secret then never becomes a key
        // in the limiter's LRU (heap dumps, core dumps), and the bucket survives a future
        // key rotation for the same client. Invalid/absent key still buckets by IP, so a
        // rotating fake key cannot mint fresh buckets. Prefixes prevent an `x-api-key: 1.2.3.4`
        // from ever colliding with an IP bucket.
        return record !== undefined ? `key:${record.id}` : `ip:${request.ip}`;
    },
    allowList: (request) => isPublicPath(request.url),
    addHeaders: { /* unchanged */ },
});
```

Auth hook (`src/api/auth.ts`), same position, same response bytes:

```ts
export function makeAuthHook (store: ApiKeyStore) {
    return async function authHook (request, reply): Promise<void> {
        if (isPublicPath(request.url)) return;
        if (resolveKey(request) === undefined) {
            // Still does not distinguish missing / wrong / revoked — one oracle-free response.
            await reply.code(401).send({ error: 'unauthorized' });
        }
    };
}
```

WS handler — the only substantive change is the bookkeeping key:

```ts
// Auth already passed at preValidation, so the record is guaranteed present. The old
// `?? 'unknown'` fallback disappears, and the map is no longer keyed by a live secret.
const record = resolveKey(request)!;
const connectionKey = record.id;
const cap = record.wsMaxConnections ?? wsMaxConnectionsPerKey;
```

`safeCompare()` becomes **unused and should be deleted** along with its unit tests. Its
constant-time property is now provided structurally (§ 4.5) rather than by a compare. Deleting it
is deliberate: leaving an unreferenced crypto helper in the tree invites a future caller to reach
for the O(N) pattern it enables. `extractApiKey()` and `isPublicPath()` are unchanged.

### 4.4 Hot-path cost — measured, not estimated

Benchmarked on this machine (Node 22), 500k iterations, 5,000 keys in the map:

| Path | Cost |
|---|---|
| **New:** `sha256(51 chars)` + `Map.get` (hit) | **0.334 µs** |
| **New:** same, miss | 0.351 µs |
| **Current:** `safeCompare` = 2× sha256 + `timingSafeEqual` | 1.006 µs |

Auth gets **~3× cheaper**, because we drop from two digests plus a constant-time compare to one
digest plus a hash-map hit. Against a ~300 µs route computation that is **0.1% of the budget**, and
it is flat in key count — 5,000 keys cost the same as 1. The memoisation means it's paid once per
request, not once per consumer of the record.

### 4.5 Timing safety with N keys

The naive multi-key implementation — loop over every record calling `timingSafeEqual` — is wrong
twice: it is O(N), and its runtime reveals the *position* of the matching key in the list, which is
a genuine oracle plus a CPU-amplification lever for an attacker sending long garbage keys.

Hash-then-lookup avoids both by construction:

- Exactly one SHA-256 over the presented bytes. SHA-256 is constant-time in its input content, and
  its cost varies only with input *length*, which the attacker already knows because they chose it.
- Exactly one `Map.get`. The only thing observable is hit vs. miss — which is precisely what the
  401 already tells the caller. No per-key comparison ever runs, so nothing can leak *which* key
  matched or how many keys exist.

**Honest residual:** V8's `Map` is a hash table, so a lookup is not *formally* constant-time —
bucket collisions exist. Exploiting it would require steering digest placement, i.e. finding
SHA-256 preimages with chosen output prefixes. We accept this. There is no constant-time map in
Node, and the argument above is the actual guarantee, not the benchmark.

### 4.6 The MCP server (`src/mcp/server.ts`)

The MCP process authenticates its own callers and must be covered, or it is an unauthenticated
bypass around the router's auth on :8081.

- It loads **the same `keys.json`** (same path, same reload rules, same fail-closed-on-malformed).
  It runs on the same VM and reads the same file — no IPC, no shared memory, no sync problem.
- Its inbound check becomes `store.lookup(provided)` in place of `safeCompare(provided, apiKey)`.
  The existing ordering there is already right and must stay: **rate-limit first, then return the
  auth verdict**, bucketing by `key:${record.id}` when valid and `ip:${remoteAddress}` otherwise.
- **It forwards the caller's own key upstream**, replacing the current "one key for both inbound and
  upstream". This is the important change: the router's audit log then attributes the request to
  the real end client rather than to "the MCP server", and per-key rate limits and per-key WS caps
  apply end-to-end. `RouterClientOptions.apiKey` is already per-request-constructible —
  `handleMcpRequest` already builds a fresh `McpServer` per request and passes `apiKey` in, so this
  is a one-line change from a module constant to the presented value.
- Rejected alternative: a dedicated service key plus an `x-forwarded-key-id` header. It would make
  the router bucket every MCP caller into one limiter bucket, so a single MCP user could starve
  every other one, and it would require the router to *trust* a caller-supplied identity header.
- Double-counting is intentional: a call through MCP consumes one unit at the MCP limiter and one at
  the router's. With a 1:1 tool→request mapping and the same `max`, both exhaust together, so
  there's no practical loss and it's defence in depth.
- If the store cannot be read, the MCP process **fails closed** — every request 401s and it logs
  loudly. It must never fall back to a static key.

---

## 5. Attribution

### 5.1 Fields

Two fields, everywhere: **`keyId`** (`k_7f3a91c2`) and **`keyName`** (`acme-desk`).

- `keyId` is what queries join on — stable, opaque, survives a rename.
- `keyName` is denormalised into the log line on purpose. Logs get read months later, often by
  someone without the current `keys.json`; a line that says only `k_7f3a91c2` is an unresolvable
  reference the moment the row is deleted.
- **Never** the plaintext key. **Never** the hash either — a hash in a log lets anyone with log
  access offline-verify a guessed key without touching the server. There is no reason to log it.

### 5.2 Where it's bound: `childLoggerFactory`

Fastify 5 (confirmed present in `fastify@5.10.0`) lets you supply the per-request child logger,
receiving the raw request. Doing the binding here means **every** log line for that request carries
the fields — including Fastify's own `incoming request` and `request completed` lines — with no
extra hooks and no reliance on reassigning `request.log`:

```ts
const app = Fastify({
    loggerInstance: logger,
    trustProxy: options.trustProxy ?? config.trustProxy,

    // Honour a caller-supplied x-request-id so their trace id and ours match. Charset- and
    // length-capped: pino JSON-escapes, so this isn't log injection, but an unbounded
    // caller-controlled string in every log line is not something to hand out.
    genReqId: (req) => {
        const h = req.headers['x-request-id'];
        return (typeof h === 'string' && /^[\w.\-]{1,200}$/.test(h)) ? h : randomUUID();
    },

    childLoggerFactory (rootLogger, bindings, opts, rawReq) {
        const presented = extractApiKey(rawReq.headers as Record<string, unknown>);
        const record = presented === undefined ? undefined : store.lookup(presented);
        return rootLogger.child({
            ...bindings,
            keyId: record?.id ?? null,
            keyName: record?.name ?? null,
        }, opts);
    },
});
```

`keyId: null` on an unauthenticated request is deliberate — it makes failed-auth traffic
greppable as a first-class thing rather than as an absent field.

Moving `requestId` minting to `genReqId` is a simplification worth taking: `/route` currently mints
it inline, so only `/route` has one. With `genReqId`, `request.id` exists for every request, pino
puts it on every line as `reqId`, and `/route`'s response body keeps working by using
`requestId: request.id`. The `x-request-id` echo header and the ≤200-char rule are preserved.

### 5.3 Three log surfaces

**a) `/route` audit record — existing, extended.** Two explicit fields plus a stable event name.
Explicit rather than relying on the child logger, because this is the record a billing or
"why did you route it there?" dispute is settled from, and it should be self-contained:

```ts
request.log.info({
    event: 'route_recommendation',          // ← new: grep on a field, not a message string
    keyId: request.apiKeyRecord?.id ?? null,   // ← new
    keyName: request.apiKeyRecord?.name ?? null, // ← new
    requestId,
    /* … all existing fields unchanged … */
}, 'route recommendation');
```

Note this also switches the call from the closure-scoped `logger` to `request.log`, so the child
bindings apply.

**b) Access log — new.** One line per request, folded into the **existing** `onResponse` hook that
already feeds the prom histogram, so it adds no new lifecycle surface:

```ts
app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    httpDuration.observe({ /* unchanged */ });
    request.log.info({
        event: 'request',
        method: request.method,
        route,                       // route TEMPLATE, not raw url — same cardinality discipline
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
    }, 'request completed');
});
```

This is what actually answers requirement 3. The `/route` audit record only covers routing
recommendations; the access line covers `/orderbook`, `/symbols`, `/metrics`, 401s and 404s too —
i.e. *every request key X made*.

**c) WS stream open/close — new, two lines.** `{ event: 'stream_open' | 'stream_close', keyId,
keyName, symbol, side, amount, durationMs }`. Long-lived sockets otherwise produce exactly zero
access-log lines despite being the most expensive thing a key can do.

### 5.4 Answering "show me every request key X made last week"

Log destination — **stated as an assumption, since the systemd unit and logrotate config are not in
this repo**: pino writes newline-delimited JSON to stdout, which under systemd goes either to a file
(`StandardOutput=append:/var/log/order-router/router.log`, rotated by logrotate) or to the journal.
Both recipes below; pick the one matching the box. Note `NODE_ENV=production` must be set in
`/opt/order-router/env` or `pino-pretty` engages and the output is not JSON — worth asserting in a
deploy check.

```bash
# 0. Find the key id
$ npm run keys:list | grep acme-desk        #  -> k_7f3a91c2

# 1. Every request, file logs, last 7 days (pino `time` is epoch ms)
$ SINCE=$(date -d '7 days ago' +%s%3N)
$ zcat -f /var/log/order-router/router.log* \
  | jq -c --argjson since "$SINCE" \
      'select(.keyId=="k_7f3a91c2" and .event=="request" and .time>=$since)'

# 1b. Same, journald
$ journalctl -u order-router --since '7 days ago' -o cat \
  | jq -c 'select(.keyId=="k_7f3a91c2" and .event=="request")'

# 2. Readable table
$ zcat -f /var/log/order-router/router.log* \
  | jq -r 'select(.keyId=="k_7f3a91c2" and .event=="request")
           | [(.time/1000|todate), .method, .route, .statusCode, .durationMs] | @tsv'

# 3. Volume by key, last 24h — "who is hammering us?"
$ zcat -f /var/log/order-router/router.log* \
  | jq -r 'select(.event=="request") | .keyName // "unauthenticated"' \
  | sort | uniq -c | sort -rn

# 4. Just this key's routing decisions, with the amounts
$ zcat -f /var/log/order-router/router.log* \
  | jq -c 'select(.keyId=="k_7f3a91c2" and .event=="route_recommendation")
           | {t:(.time/1000|todate), from, to, amountIn, amountOut, effectiveRate, requestId}'

# 5. Follow one request end to end (access line + audit line share reqId)
$ zcat -f /var/log/order-router/router.log* | jq -c 'select(.reqId=="<uuid>")'

# 6. Brute-force signal: failed auth by source
$ zcat -f /var/log/order-router/router.log* \
  | jq -r 'select(.event=="request" and .statusCode==401) | .req.remoteAddress' \
  | sort | uniq -c | sort -rn
```

Retention is whatever logrotate is configured for — that is the real limit on how far back "last
week" can reach, and it should be checked (and probably raised to 30 days) as part of this work.

### 5.5 The raw key must never appear in logs

Enforced four ways, because one is not enough:

1. **Design.** The record handed to the logger has no plaintext field to leak — the store never
   retains it past the digest.
2. **Redaction, as defence in depth.** In `src/logger.ts`:
   ```ts
   redact: {
       paths: ['req.headers["x-api-key"]', 'req.headers.authorization',
               'headers["x-api-key"]', 'headers.authorization'],
       censor: '[redacted]',
   }
   ```
   Fastify's default serialiser does not log headers, but `LOG_LEVEL=trace`, an ad-hoc
   `log.info({ headers })`, or a future error path all would. This makes it structurally impossible.
3. **Never in an error message.** 401 bodies stay `{ error: 'unauthorized' }` with no echo of what
   was presented.
4. **A test that greps for it** (§ 7). Requests are made with a distinctive key value, all log
   output is captured, and the test asserts the string appears zero times. This is the single
   highest-value test in the plan — it fails loudly the first time someone adds a debug line.

### 5.6 Not in `/metrics`

No `keyId` label on any Prometheus series. The codebase already applies exactly this discipline to
`/orderbook/:exchange/:symbol` (route template, never raw URL), and per-key labels are the same
unbounded-cardinality trap once self-serve keys exist. If per-key traffic is wanted on a dashboard,
derive it from the access log. A single scalar `router_api_keys_active` (no labels) is safe and
worth adding.

---

## 6. Migration — live service, zero outage

Constraints: `docs.ccxt.com/router` is live; one shared key sits in `/opt/order-router/env`; a
deployed MCP server forwards a key upstream; a router restart rebuilds the order-book cache and
degrades `/route` for minutes.

**The whole plan hangs on one mechanism: the env key is loaded into the store as a synthetic
record**, so the old and new schemes are valid simultaneously and no client has to change in
lockstep with a deploy.

```ts
// keyStore load, after parsing the file
const envKey = process.env['ORDER_ROUTER_API_KEY'];
if (envKey && envKey.length > 0) {
    // Suppressible from the file: a row {"id":"k_legacy","revokedAt":"…"} kills the env key
    // via a 10s reload, without needing a restart to drop the env var.
    if (!tombstoned('k_legacy')) {
        byHash.set(sha256hex(envKey), {
            id: 'k_legacy', name: 'legacy-shared-key', /* … */
        });
    }
}
```

| Phase | Action | Restart? | Rollback |
|---|---|---|---|
| **0. Ship** | Merge the code. `ORDER_ROUTER_API_KEY` still in env; no `keys.json` on the box yet (missing file = empty store + warn, not fatal). | – | – |
| **1. Deploy router** | One planned restart, off-peak. Verify: `/health` 200; the *old* key still 200s on `/symbols`; log lines now carry `keyId:"k_legacy"`. | **1×, planned** | previous build; env key untouched |
| **2. Issue keys** | `keys:create --name mcp-prod`, `--name docs-site`, `--name pablo-cli`. Distribute out of band. | none (10 s reload) | `keys:delete` |
| **3. Cut over MCP** | Deploy the MCP build that reads the store and forwards the caller's key. Restart the MCP process — it is a stateless proxy with no book state, so this restart is genuinely free. Point its own callers at their new keys. Both schemes still work, so ordering doesn't matter. | MCP only | previous MCP build |
| **4. Watch** | `jq 'select(.keyId=="k_legacy")'` daily. Chase stragglers by IP from the access log. | – | – |
| **5. Retire legacy** | When `k_legacy` shows zero requests for 7 consecutive days: add `{"id":"k_legacy","name":"legacy-shared-key","revokedAt":"…"}` to `keys.json`. Takes effect on the next 10 s poll. | **none** | delete the tombstone row |
| **6. Tidy** | Remove `ORDER_ROUTER_API_KEY` from `/opt/order-router/env` at the next deploy (systemd reads `EnvironmentFile` at start, so this needs a restart — but by then it's dead weight, not a live credential). | next deploy | – |

Notes that matter:

- **Do not delete `ORDER_ROUTER_API_KEY` from the env file until after the rollback window closes.**
  Rollback to the old build requires it. `keys.json` is additive and simply ignored by the old
  build, so rollback is `systemctl stop && ln -sfn <previous> && systemctl start`.
- Phase 5 revokes the legacy key **without a restart** precisely because the tombstone lives in the
  file rather than depending on the env var going away. That is the reason for the tombstone
  mechanism; without it, killing the shared key would cost the outage this plan exists to avoid.
- The CI smoke test (`.github/workflows/order-router.yml`) keeps passing unchanged through phase 5 —
  it sets `ORDER_ROUTER_API_KEY=ci-smoke-key` and asserts 401/200/401, which the legacy bridge
  satisfies exactly. Add a second smoke step that creates a key via the CLI and asserts it works,
  so both paths are covered.
- `docker-compose.yml` keeps working via the same bridge; a follow-up can mount a `keys.json`.
- The OpenAPI `securitySchemes` block needs no change — the header names and formats are identical.

---

## 7. Testing plan

Style matches the existing suite exactly: `node:test`, `assert/strict`, real `buildServer` +
`app.inject()`, a real listening server only where the bug lives in the socket path.

### 7.1 `src/api/keyStore.test.ts` (new)

| # | Test |
|---|---|
| 1 | valid file parses; every field round-trips |
| 2 | unknown `version` ⇒ throws at boot; a `scopes` field present in a v1 file ⇒ throws |
| 3 | `lookup(validKey)` returns the record; `lookup(unknown)` returns `undefined` |
| 4 | `lookup` returns `undefined` for a key whose row has `revokedAt` set |
| 5 | **adversarial:** presenting the stored *hash* as the key does not authenticate |
| 6 | **adversarial:** a valid key with one char appended/removed does not match (no prefix match) |
| 7 | `lookup('')` and a 10 KB garbage key return `undefined` without throwing |
| 8 | reload picks up an added key and stops honouring a removed one |
| 9 | reload on malformed JSON keeps the previous snapshot, does not throw, logs an error |
| 10 | missing file at boot ⇒ empty store, no throw |
| 11 | atomic write: a reader during 200 concurrent CLI writes never sees invalid JSON |
| 12 | `create()` returns the plaintext once and **the plaintext bytes do not appear anywhere in the file** |
| 13 | key format matches `/^or_live_[A-Za-z0-9_-]{43}$/`; 10k creates yield 10k distinct keys |
| 14 | legacy bridge: with `ORDER_ROUTER_API_KEY` set, `lookup(envKey).id === 'k_legacy'`; a `k_legacy` tombstone in the file suppresses it |
| 14b | dev fallback: no file **and** no env var ⇒ `lookup(DEV_API_KEY).id === 'k_dev'` + a startup warning; suppressed as soon as either a key file row or the env var exists |
| 15 | `lastUsedAt` flush merges only that field and does not resurrect a row deleted meanwhile |

### 7.2 `src/api/server.test.ts` (extend — existing tests keep passing unchanged)

| # | Test | Why |
|---|---|---|
| 16 | two distinct valid keys both get 200 on `/symbols` | the thing single-key auth cannot express |
| 17 | revoked key ⇒ 401, and the body is **byte-identical** to unknown-key and missing-key | no oracle for "was this key ever real?" |
| 18 | unknown path + valid key ⇒ 404; unknown path + revoked/absent key ⇒ 401 | **regression:** `setNotFoundHandler` must consult the store |
| 19 | **auth-before-rate-limiter regression** — 12 wrong-key requests at max 5 must include a 429 | existing test, keep verbatim |
| 20 | same, but with a **revoked** key | revoked rejection is a *new* code path that could accidentally be moved earlier |
| 21 | rotating fake keys still throttled (IP bucket) | existing test, keep verbatim |
| 22 | key A exhausts its bucket ⇒ A gets 429 while key **B** still gets **200** | today's version can only assert A-vs-invalid; this is the real per-key-fairness assertion |
| 23 | a key with `rateLimitMax: 2` throttles at 2 while the default key does not | per-key limit override |
| 24 | **WS-upgrade-leak regression** — 10 raw TCP upgrades × `['/stream/best/…','/symbols','/nonexistent']`, then `getConnections() <= 2` | existing test, keep verbatim, **plus** a 4th pass using a revoked key |
| 25 | per-key WS cap: key A at cap 1 refused a 2nd socket (1013) while key B connects fine | upgrades the existing test, whose comment notes a 2nd valid identity wasn't available |
| 26 | a key with `wsMaxConnections: 1` is capped at 1 while the default key is not | per-key WS override |
| 27 | closing a stream frees the slot; the count is keyed by `record.id` not by the secret | existing test, adapted |
| 28 | **timing-safety (architectural):** with 10,000 keys loaded, `lookup` performs exactly one digest and one map get — instrument a counter on the store and assert `=== 1` for a hit, a miss, and the last-inserted key | the O(N)-iteration mistake is caught by construction rather than by a clock |
| 29 | **timing-safety (statistical smoke):** with 10,000 keys, median lookup time for first-inserted / last-inserted / missing are within 3× of each other | coarse on purpose; documented as a smoke check, not a proof — see § 4.5 |

### 7.3 Attribution tests (new, in `server.test.ts`)

Capture logs by building the server with a pino instance over a collecting `Writable` — the
existing `buildServer(cache, feeRegistry, logger, …)` signature already allows this.

| # | Test |
|---|---|
| 30 | `/route` with key A ⇒ a log line with `event: "route_recommendation"`, `keyId: "k_a"`, `keyName: "acme-desk"`, and the same `requestId` as the response body |
| 31 | every request emits exactly one `event: "request"` line, including `/health`, a 401, and a 404 |
| 32 | a 401 line carries `keyId: null` (greppable failed-auth), not an absent field |
| 33 | `reqId` is identical across the access line and the audit line for one request; a caller-supplied `x-request-id` is honoured and echoed; a 300-char or newline-containing one is replaced by a fresh uuid |
| 34 | **`/stream/best` emits `stream_open` and `stream_close` with `keyId` and a `durationMs`** |
| 35 | **raw key never logged:** drive `/route`, `/symbols`, a 401, a 404 and a WS open/close with `or_live_TESTKEY…`; assert the captured log buffer contains that string **zero times**, and likewise contains its sha256 zero times |

### 7.4 MCP (`src/mcp/server.test.ts`, extend)

| # | Test |
|---|---|
| 36 | inbound: valid store key ⇒ `tools/list` succeeds; revoked key ⇒ 401; unknown ⇒ 401 |
| 37 | the upstream fixture receives `x-api-key: <the caller's own key>`, not a service key |
| 38 | MCP limiter still counts failed auth before returning 401 (mirrors #19 on :8081) |
| 39 | unreadable/malformed store at boot ⇒ every request 401s; no fallback to a static key |

### 7.5 CLI (`src/cli/keys.test.ts`, new)

Run in-process against a temp dir; no subprocess spawn needed.

| # | Test |
|---|---|
| 40 | `create` → `list` shows the row, with the key absent from the listing output |
| 41 | `create` with a duplicate `--name` is rejected |
| 42 | `revoke` by id and by name both work; the row survives with `revokedAt` set |
| 43 | `delete` without `--yes` refuses; with `--yes` removes the row |
| 44 | end-to-end: create → server reload → 200; revoke → reload → 401 |

### 7.6 CI

`.github/workflows/order-router.yml` gains one smoke step after the existing one: create a key via
the CLI, curl `/symbols` with it expecting 200, revoke it, `kill -HUP`, curl again expecting 401.
The existing three assertions (401 unauth / 200 with `ORDER_ROUTER_API_KEY` / 401 wrong key) stay
untouched and pass via the legacy bridge.

---

## 8. Deliberately not in v1

| Not doing | Why | Where it goes |
|---|---|---|
| **Scopes** | An unenforced field is worse than no field. Every current endpoint is read-only, so there is nothing to separate yet | v2, with `version: 2` |
| **Admin HTTP endpoint** | The recursion trap (§ 3.1). Adds permanent network surface for zero capability over SSH | v2 as read-only + loopback, if ever |
| **Expiry / `expiresAt`** | Nothing in the current customer set has a natural expiry, and an unmonitored expiry is a self-inflicted outage | v2 |
| **Quotas / billing hooks** | Rate limiting is abuse protection, not metering. Metering needs a durable counter, i.e. the SQLite move | v2 |
| **Self-serve signup** | Requires accounts, email verification, abuse handling, a UI — a different project | later |
| **Key rotation windows** | Already emergent: create new → distribute → revoke old, with both live in between. No feature needed. A `supersededBy` field to *record* a rotation is v2 | v2 (cosmetic) |
| **Per-key IP allowlists** | nginx does this better and already fronts the service | never, probably |
| **Encrypted-at-rest store / HSM** | The file contains only digests of 256-bit random values; encryption adds a key-management problem to protect data that is already useless when stolen | never |
| **OAuth / JWT / user accounts** | Explicitly out of scope | never at this size |
| **Redis / multi-host store** | No cross-host story exists anywhere in this service | when there are 2 VMs |
| **Key-management actions in the service's own log stream** | The CLI is a separate process writing to its own stderr | v2 |

### The one borderline item: closing live sockets on revoke

`/stream/best` sockets authenticate **once**, at upgrade. Revoking a key does not close its open
streams; they run until the client disconnects or the heartbeat reaps them, and the next reconnect
gets a 401.

The fix is ~10 lines: track `Map<keyId, Set<socket>>` alongside the existing count, and on store
reload close (`1008`) any socket whose `keyId` is no longer in the map. **Recommendation: include
it**, because "delete a key" is half of what was actually asked for, and a revocation that leaves a
live data feed running is a correctness gap in that feature, not a missing extra. It is also the
first thing to cut if the change is running long — the exposure is a read-only quote stream, bounded
by the heartbeat, on a key the operator has already decided to kill.

Whichever way it goes, **the behaviour gets a test** so it is a decision rather than an accident.

### Natural v2, in order

1. **Scopes** — `read` (all GETs), `stream` (`/stream/best`), `metrics` (`/metrics`). Bump to
   `version: 2`; loader rejects a v1 file containing scopes, so the upgrade is unambiguous.
2. **Quotas** — a monthly request budget per key, fed by the `event: "request"` access line, exposed
   at `GET /usage`. This is where the JSON file starts to hurt.
3. **Expiry + `supersededBy`** — makes rotation legible in `keys:list` rather than tribal knowledge.
4. **SQLite** — trigger: >1,000 keys, or wanting persisted per-request counters. The store interface
   in § 4.2 is deliberately narrow (`lookup` / `reload` / `listAll`) so the swap is behind it.
5. **Read-only admin HTTP + a small dashboard**, loopback + nginx allowlist only.
6. **Billing hooks** — downstream of (2), not before it.

---

## Appendix: files touched

| Path | Change |
|---|---|
| `src/api/keyStore.ts` | **new** — load, atomic write, reload, `lookup`, `lastUsedAt` flush |
| `src/api/auth.ts` | `makeAuthHook(store)`; `resolveKey` memo; **delete `safeCompare`**; `resolveApiKey` folds into the store's legacy/dev bridge; `extractApiKey` / `isPublicPath` / `DEV_API_KEY` unchanged |
| `src/api/server.ts` | `genReqId`, `childLoggerFactory`, limiter `keyGenerator`/`max`, WS `connectionKey` → `record.id`, access-log line in the existing `onResponse`, `event` + `keyId` + `keyName` in the `/route` audit record. **Hook positions unchanged.** |
| `src/mcp/server.ts` | store-backed inbound auth; forward the caller's key upstream; fail closed |
| `src/cli/keys.ts` | **new** — create / list / revoke / delete |
| `src/logger.ts` | `redact` paths for `x-api-key` and `authorization` |
| `src/config.ts` | `keysFile` (`ORDER_ROUTER_KEYS_FILE`), `keysReloadPollMs` (10 000) |
| `src/index.ts` | build the store, install the `SIGHUP` handler, pass it to `buildServer` |
| `package.json` | `keys:*` scripts |
| `.gitignore` | `keys.json`, `data/` |
| `README.md` | rewrite § Security; new § "Managing API keys"; update the config table and the production-readiness row |
| `.github/workflows/order-router.yml` | one extra smoke step (create → 200 → revoke → 401) |
| `openapi/openapi.yaml` | no change needed — header names and formats are identical |
