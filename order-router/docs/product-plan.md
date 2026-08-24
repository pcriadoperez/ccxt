# From service to product — implementation plan

Status: **plan, not shipped.** Supersedes the storage and exposure sections of
[`dashboard-plan.md`](./dashboard-plan.md); its verified security findings still apply.
Builds on [`auth-plan.md`](./auth-plan.md), which shipped.

## What changed

The owner has decided:

1. The admin dashboard **is exposed to the internet** with username + password, for ergonomics.
   Admin routes stay **out of the public OpenAPI spec**.
2. Usage moves to **a database**, self-hosted in Docker rather than a managed service — CCXT values
   privacy, security and open source.
3. **Keys move into it too**, with `created_at`, and **every response is recorded against the key
   that made it**.
4. There will be a **public site**: homepage, docs for developers *and* traders, and **self-serve
   signup → API key → first call**.

(1) and (3)+(4) together fire two of the Postgres triggers written down in `dashboard-plan.md` §5.3
— *usage settles invoices* and *per-request retention is required*. So: Postgres, now. The rest of
this document is how, without breaking the thing that already works.

---

## 0. Blocker: the router is leaking ~20 GB, on CCXT's docs box

**This has to be fixed before any database lands anywhere near that machine**, and it is worth
fixing regardless. Measured on the live box:

| | |
|---|---|
| Router cgroup | **27.13 GB** |
| One shard worker (pid 41586) | **20.51 GB** |
| Its three sibling shards | 0.44 / 0.57 / 1.07 GB |
| Order books actually cached | **543** |
| Swap in use | **29.6 GB of 32 GB** |
| Major page faults, router | **8.9 million** |
| Cumulative full memory stall since boot | ~10 minutes |

543 books cannot justify 20 GB — that is ~50 MB per book. It is not book data, and the 20–40×
spread across otherwise-identical shard workers says it is one shard, not a design cost. The likely
culprit is reconnect churn accumulating client state: **11,436 error lines for bitfinex** alone
(the orderbook-checksum loop), 4,492 deepcoin, 3,707 lbank, 2,669 onetrading — 25,428 error lines in
~5 hours.

The box is not dedicated to the router. It also runs `ccxt-docs-3005`, `ccxt-playground` and
`egress-proxy` — this is **CCXT's docs and playground infrastructure**, and the router is currently
swapping it. That is an operational risk to CCXT's own services, not just to routing latency.

**Consequence for this plan:** "host Postgres in Docker on the local machine" is not blocked by
Postgres being heavy. It is blocked by a leak. Fix the leak, then the same box plausibly has room —
or put the database on a second VM at the same provider, which satisfies the self-hosting
requirement just as well and keeps customer data off the docs box.

---

## 1. Database

### 1.1 Postgres. Not Redis, and not ClickHouse yet.

**Redis is the wrong choice**, on four independent grounds, any one sufficient:

- **Durability is a configuration, not a guarantee.** AOF `everysec` loses up to a second; default
  RDB loses up to a snapshot interval. "We may have lost the last second of your billing rows" is
  not a sentence you get to say about money. `auth-plan.md` §1.1 already rejected Redis for merely
  holding auth data; invoicing sharpens that from a preference into a disqualifier.
- **No uniqueness constraints, no foreign keys, no multi-key transactions.** `UNIQUE(lower(email))`,
  "this key belongs to this user", and "issue the invoice and mark the usage billed, atomically" all
  become hand-rolled `WATCH`/`MULTI` plus secondary indexes you maintain yourself. Every one is a
  future billing dispute.
- **RAM-resident.** Per-request rows at 10 req/s are 26 M rows/month — the most expensive possible
  gigabyte to hold, on a box that is already swapping.
- **Aggregation.** "My usage last month by day and endpoint" is one `GROUP BY` in SQL. In Redis it
  is either a pre-materialised counter per (user, day, route) — making you the aggregation engine,
  with no ability to re-aggregate when you get it wrong — or a `SCAN`.

Redis has exactly one good future role here: a shared rate-limit counter, if a second router host
ever appears. Not the system of record.

**ClickHouse is the right tool for the events table and the wrong tool for the accounts.** It has no
real transactions or constraints, which is what user accounts and invoices need. Running both from
day one is two databases for one developer to operate. So: **Postgres only for v1**, with the events
table shaped so it can move later without touching anything else — append-only, no foreign keys
*into* it, time-partitioned. Trigger for adding ClickHouse: the events table exceeds what a
partition-drop retention policy can comfortably hold, i.e. sustained >100 req/s with >90-day
retention. Note ClickHouse is also memory-hungry; it is not a way to avoid §0.

### 1.2 Where it runs

Self-hosted, in Docker, at the same provider — **but not on the docs box until §0 is fixed.**

| Option | Verdict |
|---|---|
| Second small VM at WorldStream, Postgres in Docker | **Recommended.** Self-hosted, same jurisdiction, no third-party data processor, and customer data is not on the docs/playground box. ~10 ms away. |
| Same box, after fixing the leak | Viable once the router is back to a sane footprint. Cheapest. Accepts that a router memory bug can take out customer accounts. |
| Managed (Neon/Supabase/RDS) | Rejected per the owner's stated preference, despite lower operational cost. |

Backups are now a real requirement, because this holds customer accounts: `pg_dump` nightly plus WAL
archiving to off-box storage, and **a restore actually tested once**. An untested backup is a belief.

### 1.3 The hot path does not move

This is the invariant that outranks everything: **if the database is down, `/route` keeps
answering.** The design achieves that structurally rather than by promise.

```
Postgres (api_keys)  ──5s──▶  sync process  ──writeKeyFile()──▶  keys.json  ──10s poll──▶  router
```

`keys.json` stays exactly as it is today, and **`keyStore.ts` and `auth.ts` are not modified at
all** — same single SHA-256, same single `Map.get`, same mtime poll, same atomic rename. What
changes is only *who writes the file*: it stops being hand-authored and becomes a **materialised
projection** of the `api_keys` table.

- Postgres unreachable → the sync writes nothing → the file is unchanged → every existing key keeps
  authenticating, indefinitely. New signups do not go live; routing does not notice.
- Revocation latency becomes 5 s + 10 s = **15 s** worst case, against 10 s today. Acceptable, and
  worth stating because revocation latency is a security property.
- Enforced by **withholding the credential**: the router's systemd unit must not contain a Postgres
  connection string. Same spirit as "shards do not get the key store" in `auth-plan.md` §1.7.

The CLI keeps working against `keys.json` for break-glass, and gains a `--from-db` mode.

### 1.4 Schema

```sql
-- Identity ------------------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           citext NOT NULL,
  password_hash   text NOT NULL,           -- scrypt N=16384 (see §2.1)
  email_verified_at timestamptz,
  plan            text NOT NULL DEFAULT 'free',
  is_admin        boolean NOT NULL DEFAULT false,   -- never settable from signup input
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);

-- Keys: the projection source ------------------------------------------------
CREATE TABLE api_keys (
  id                 uuid PRIMARY KEY,     -- v7, time-ordered
  display_id         text UNIQUE NOT NULL, -- 'k_xxxxxxxx' — what appears in logs and invoices
  user_id            uuid NOT NULL REFERENCES users(id),
  name               text NOT NULL,
  hash               char(64) NOT NULL UNIQUE,   -- sha256 hex, unchanged from today
  last4              char(4) NOT NULL,
  note               text NOT NULL DEFAULT '',
  rate_limit_max     integer,              -- NULL = plan default; CHECK'd ceiling
  ws_max_connections integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,
  revoked_at         timestamptz,
  UNIQUE (user_id, name)
);
```

**`k_<8 hex>` must stop being the identity.** It is 32 bits, generated with **no collision check at
all** (`cli/keys.ts` checks `name` uniqueness, never `id`), and `delete` frees it for reuse. Birthday
collision is ~1.2% at 10,000 keys. The failure mode is *two customers' usage merging into one
invoice line* — the worst bug class this system can have — and reuse silently re-attributes a
deleted key's history to a new customer. So: `uuid` primary key, `display_id` for humans, **ids
never reused**. Enforce it in the schema: revoke `DELETE` on `api_keys` for the app role, and let the
`requests` foreign key make deletion impossible while history exists. Revocation is the only kill.

```sql
-- Per-request records --------------------------------------------------------
CREATE TABLE requests (
  ts            timestamptz  NOT NULL,
  key_id        uuid         NOT NULL REFERENCES api_keys(id),
  user_id       uuid         NOT NULL,     -- denormalised: "delete my data" is one DELETE
  route         text         NOT NULL,     -- TEMPLATE, never the raw URL
  status        smallint     NOT NULL,
  duration_ms   real         NOT NULL,
  from_asset    text, to_asset text,
  amount_in     numeric, amount_out numeric,
  effective_rate numeric, impact_bps real,
  unroutable_reason text,
  fully_fillable boolean,
  request_id    text,                      -- join key to the log. UNTRUSTED — see below
  ip_hash       bytea,                     -- hashed, never the IP
  spool_epoch   bigint NOT NULL,
  spool_seq     bigint NOT NULL,
  PRIMARY KEY (ts, spool_epoch, spool_seq)
) PARTITION BY RANGE (ts);
```

**Two things about "store every response":**

**Do not store the response body.** A route body is ~1.1 KB measured, landing ~1.4 KB as inline
`jsonb` — *below* Postgres's ~2 KB TOAST threshold, so it is **not compressed**. At 100 req/s over a
35-day window that is **~423 GB**. The same bodies gzipped into object storage, keyed by
`request_id`, are roughly 1–2% of that. Same data, ~70× the cost. Bodies stay in the log for its
rotation window; typed metadata (above, ~200 B/row) answers support, disputes and billing.

**This data is trading intention.** `from=USDT&to=BTC&amountIn=5000000` says a customer is about to
move $5 M. Its value decays to zero in ~5 seconds (`staleBookMs`); its liability is permanent. Hash
IPs, denormalise `user_id` so deletion is one partitioned `DELETE`, and write the retention window
into the ToS *before* collecting.

> **Defect found while designing this.** `server.ts` honours a caller-supplied `x-request-id` as
> `request.id`. It is therefore **attacker-controlled**, and using it as the ingest idempotency key —
> the obvious choice — would let a customer send a constant value, collapse every request into one
> `ON CONFLICT DO NOTHING` row, and get **unlimited free API calls**. Two customers sending the same
> value would silently drop each other's usage. The dedup key must be server-minted:
> `(ts, spool_epoch, spool_seq)` assigned by the spool. `request_id` is still stored as the join to
> the log, and documented as untrusted.

Retention by partition drop, which is O(1) rather than a multi-million-row `DELETE`:

| Table | Retention | ~Rows/month @10 req/s |
|---|---|---|
| `requests` (detail) | 90 days, monthly partitions | 26 M |
| `usage_hour` (rollup) | forever | ~7 k / key |

### 1.5 Ingestion — the router never waits on the database

```
router ──pino audit stream──▶ audit log ──tailer──▶ SQLite spool ──batched COPY──▶ Postgres
```

SQLite does not disappear from `dashboard-plan.md`; it is **demoted** to exactly the role that plan
predicted — a local durable spool. That demotion is what makes a database outage invisible to the
router: the spool backs up on disk, bounded, and drains when Postgres returns. The cursor commits in
the same transaction as the rows, so replay is idempotent.

Rotate the audit stream with `create`, **not `copytruncate`** — under `copytruncate` a tailer
silently loses everything between its committed offset and the truncation, which is a recurring
undercount presented as success.

---

## 2. The exposed dashboard and customer login

The owner has overruled loopback-only. These are the controls that make the exposed version safe;
the reasoning from `dashboard-plan.md` §3 still applies except where noted.

### 2.1 Login

- **scrypt, N=16384.** Verified on this exact Node (v22.22.1): `N=2**15` throws
  `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` — `128·N·r` is one byte over the 32 MiB `maxmem` default.
  N=16384 costs 22 ms. Cap in-flight verifications and throttle per-IP *before* the KDF runs.
- **TOTP is now mandatory for the admin account.** On loopback it was optional because SSH was the
  real boundary. There is no SSH boundary any more; the password is the only thing between the
  internet and key minting.
- Cookies are now genuinely `https` on a real domain, so `Secure; HttpOnly; SameSite=Lax` and a
  `__Host-` prefix all apply — the localhost caveat from the previous plan is gone. **CSRF tokens on
  every mutation stay**, because `SameSite` is a defence-in-depth layer, not the control.
- Rotate the session id on login (session fixation).

### 2.2 Two principals, one boundary

Operator (full admin) and customer (own keys and usage only). The ways this boundary leaks, each
needing an explicit control:

| Leak | Control |
|---|---|
| IDOR on key ids | Every query filtered by `user_id` from the session, never from the request |
| Mass assignment at signup | `is_admin` is not in any input struct; set only by SQL |
| Shared session table | One table, but the admin flag is read from `users` per request, not cached in the cookie |
| Admin routes discoverable | Separate route prefix and separate app; authz, not obscurity, is the control |

### 2.3 Signup abuse

Self-serve signup mints credentials against a service whose per-key defaults include a WebSocket
allowance. Required: email verification before a key works, signup rate limits per IP and per email
domain, disposable-domain blocklist, a hard cap of keys per account, and **server-side ceilings on
`rate_limit_max` / `ws_max_connections`** — a key minted with `rate_limit_max: 1e9` is a targeted
outage lever aimed at the process whose death costs minutes of degraded routing.

### 2.4 Keeping admin out of the public spec

`openapi/openapi.yaml` documents customer routes only, and is served as a static file. Admin routes
live in a separate app with no spec. This is *documentation hygiene*, not a security control — the
security is §2.2.

---

## 3. The public site

Three surfaces, one deployment:

| Surface | Content |
|---|---|
| **Homepage** | What the router does, in one screen. The differentiators are real and measurable — say them: asset-to-asset addressing (no `side` to get backwards), book-walked not top-of-book, bridge comparison (live: `USDC→TRY` routes via ETH, beating the obvious USDT path by ~9 bps), reported price impact, split routing with measured bps savings. |
| **Docs — developers** | Endpoints, auth, errors, rate limits, SDK snippets, the OpenAPI spec. Generated from `openapi/openapi.yaml` so it cannot drift. |
| **Docs — traders** | What price impact means and when to act on it, when splitting helps, why a route bridged, what `fillRatio` is telling you. Prose, not reference. |
| **Signup** | email → verify → key shown once → a working `curl` on the same page. |

The shortest path from landing page to a working call is the product's real conversion funnel: it
should be **one page, one form, one copy-paste command**, with the key pre-filled into the snippet.

**Tech:** CCXT already runs `ccxt-fumadocs` on this box. Reusing that stack keeps one docs toolchain
for the org rather than introducing a second, and it already handles two-audience navigation. The
signup/dashboard app is a separate small server-rendered app — no SPA, no build step to maintain.

---

## 4. Blockers only the owner can clear

1. **The domain.** You cannot sell a product from `docs.ccxt.com/router/`. This needs either DNS
   delegation for a subdomain of `ccxt.com` from whoever controls it, or a separate domain. Nothing
   in §3 ships without this decision.
2. **Where the database lives** — second VM, or this box after §0 is fixed.
3. **Email provider** for verification and password reset. Self-hosting SMTP is a deliverability
   project; a provider is the pragmatic answer even for a privacy-conscious org, since the content is
   "click to verify", not customer data.
4. **Is this CCXT's product or yours?** It changes the domain, the ToS, the data controller, and
   where the code lives. Worth settling before the schema holds real customer accounts.

## 5. Suggested order

1. **Fix the leak (§0).** Independent of everything else, and currently degrading CCXT's docs box.
2. Postgres + schema + the `api_keys → keys.json` projection. Router untouched; `keys.json` keeps
   working exactly as now, so this is reversible.
3. Ingestion pipeline (audit stream → spool → Postgres) and `usage_hour`.
4. Dashboard: admin first (you are the only user), then customer views.
5. Signup + email verification.
6. Marketing site + docs.

Steps 2–3 are safe to ship before the domain question is answered; steps 4–6 are not.
