# Router beta — product plan

Status: **shipped.** This is the design the running service implements, and the document to read
first. It supersedes [`dashboard-plan.md`](./dashboard-plan.md) entirely, and replaces the storage
decisions in [`auth-plan.md`](./auth-plan.md) §3 — Postgres is the source of truth and `keys.json`
is a projection of it. The line the earlier draft carried, that nothing here is in use yet, is no
longer true of anything below.

## The goal, concretely

One URL you can send to your boss. He opens the homepage, understands what the router is, signs up,
gets an API key, and makes a working call — without talking to you. You get an admin login, watch
usage and keys, and run a soft launch **independent of CCXT infrastructure and CCXT's roadmap**, so
CCXT can decide afterwards whether to adopt it.

Everything below is subordinate to that. Volume expectation for the beta: **~100 requests/day.**

---

## 1. Blocker first: 27 GB on the docs box

Measured on the live VM. I initially called this a leak; a 200-second sample says otherwise:

| | |
|---|---|
| Router cgroup | 27.12 GB, **flat** |
| Shard pid 41586 | 20.54 GB, **flat to 2 decimal places over 200 s** |
| Sibling shards | 0.44 / 0.57 / 1.07 GB |
| Order books cached | 543 |
| Swap in use | 29.6 of 32 GB |
| Major page faults | 8.9 M |

**It is not growing — it is a sticky high-water mark.** V8 grew the heap to a startup peak and never
returned it to the OS. That peak is explainable: ~60 exchanges call `loadMarkets()` at once, and the
initial order-book snapshots land at the same time. Measured directly against coinbase:

```
coinbase   10 symbols  10,128 updates/75s   44,137 levels per update   129,016 levels retained
lbank      10 symbols     123 updates/75s      200 levels per update
bitstamp   10 symbols      90 updates/75s      888 levels per update
```

Coinbase alone is ~125 updates/sec at up to 44,000 levels each — roughly **6 million level objects
allocated per second**, for ten symbols. Production runs fifty.

**Passing `limit` does not fix it** (measured): `watchOrderBookForSymbols(symbols, 200)` still
returned 44,091 levels per update and retained 128,907. The depth lives inside ccxt.pro's own
`OrderBook`, and for coinbase the limit argument does not shrink it.

What I have *not* done is prove which allocation produced the peak — a 60-second probe at 10 symbols
is stable (ΔRSS ~10 MB), so the condition is scale- and startup-dependent and I could not reproduce
20 GB. The next step that would settle it is a heap snapshot from the live shard
(`--heapsnapshot-signal=SIGUSR2`, which costs a restart).

**Fixes, cheapest first:**

1. **`--max-old-space-size` per shard worker** (e.g. 1024). V8 grows the heap because nothing tells
   it not to; a cap forces collection instead of growth. The live working set is 543 books, so the
   cap is far above what is actually needed. One line in the fork options.
2. **Stagger startup harder.** The peak is concurrent `loadMarkets()` + first snapshots. Serialise
   exchange startup within a shard rather than starting all of them together.
3. **Drop coinbase's full-depth feed, or drop coinbase from the beta set.** 6 M allocations/sec buys
   depth the router demonstrably does not use — a 5 M USDT order filled in under 50 levels per venue.

This is worth doing regardless of the product work, because the box is **CCXT's docs and playground
infrastructure** (`ccxt-docs-3005`, `ccxt-playground`, `egress-proxy`) and the router is currently
swapping it. It also has to be done before Postgres goes on the same machine.

---

## 2. Deployment shape for the beta

Everything on this VM, everything behind the existing nginx, everything **logically separate from
CCXT's own site and docs** — separate app, separate database, separate code, no shared components
with `ccxt-fumadocs`.

| Path | Serves |
|---|---|
| `docs.ccxt.com/router/` | homepage, docs, signup, dashboard |
| `docs.ccxt.com/router/api/` | the public API (today's `/route`, `/stream/route`, …) |
| `docs.ccxt.com/router/admin/` | admin dashboard — authn/authz, absent from the public spec |

This is explicitly a beta address. Because the API base URL moves when the product gets its own
domain, **the docs must never hard-code it** — one config value, substituted into every snippet, so
the move is a one-line change rather than a docs rewrite.

Postgres runs on this VM in Docker (§1 first). No managed service, no second host, no third-party
data processor — consistent with CCXT's stance on privacy and self-hosting.

---

## 3. One database. Postgres. Nothing else.

You are right that two databases made no sense. The SQLite spool existed to survive a *remote*
Postgres being unreachable; with Postgres on the same VM, a Postgres outage is a box event and the
router is affected anyway. It bought nothing and cost a whole second system. **Deleted.**

The durable buffer is the thing that is already durable: **the audit log file on disk.** The
ingester tails it and keeps its cursor *in Postgres*, committed in the same transaction as the rows
— so a Postgres restart replays from the last committed offset, idempotently, with no second store.

```
router ──pino audit stream──▶ audit log file ──ingester (cursor in PG)──▶ Postgres
```

### 3.1 What gets deleted from the current implementation

Nothing here is load-bearing yet, so:

- **`keys.json` as the source of truth** — gone. Postgres holds keys.
- **The `keys create|revoke|delete` CLI write path** — gone. Key management is the dashboard.
- **The legacy `ORDER_ROUTER_API_KEY` bridge** — gone. It existed to migrate a live shared key;
  there is nothing live to migrate.
- **The `DEV_API_KEY` fallback** — gone. Replaced by a seeded admin account.

What survives untouched is the part that earned it: `lookup()` is still **one SHA-256 and one
`Map.get`** against an in-memory snapshot. The narrow `lookup/reload/listAll` interface was chosen
so the backing store could be swapped, and this is that swap.

**The router still does not query Postgres per request.** It loads keys into the Map at boot,
refreshes every 10 s, and writes a local snapshot file *purely as a boot cache* — so a Postgres
restart cannot leave the router unable to authenticate anyone. Revocation latency stays 10 s.

### 3.2 Schema

Designed so that **growing does not mean migrating**: append-only event tables, time-ordered UUIDs,
partitioning present from day one (even though one partition is plenty at 100 req/day), and no
column that only makes sense at small scale.

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,          -- scrypt N=16384 (N=2**15 throws on Node 22, verified)
  is_admin      boolean NOT NULL DEFAULT false,   -- never settable from signup input
  plan          text NOT NULL DEFAULT 'beta',
  created_at    timestamptz NOT NULL DEFAULT now(),
  email_verified_at timestamptz         -- unused in beta; the column exists so adding email later
);                                      -- is not a migration

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY,       -- v7, time-ordered
  display_id    text UNIQUE NOT NULL,   -- 'k_…' — what appears in logs, tickets, invoices
  user_id       uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  hash          char(64) UNIQUE NOT NULL,
  last4         char(4) NOT NULL,
  rate_limit_max integer CHECK (rate_limit_max IS NULL OR rate_limit_max <= 10000),
  ws_max_connections integer CHECK (ws_max_connections IS NULL OR ws_max_connections <= 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  UNIQUE (user_id, name)
);
```

`k_<8 hex>` stops being the identity: 32 bits, **no collision check anywhere in the current code**,
and reusable after delete. The failure mode is two customers' usage merging into one invoice line.
UUID primary key, `display_id` for humans, ids never reused.

**Requests, and the array question.** You are right that a route is not flat. Two child tables
rather than `jsonb`:

```sql
CREATE TABLE requests (
  id            uuid NOT NULL,
  ts            timestamptz NOT NULL,
  key_id        uuid REFERENCES api_keys(id),   -- NULL for unauthenticated (401) requests
  user_id       uuid,
  route         text NOT NULL,                  -- route TEMPLATE, never the raw URL
  status        smallint NOT NULL,
  duration_ms   real NOT NULL,
  -- request
  from_asset text, to_asset text, amount_in numeric, amount_out_req numeric,
  strategy text, exact_side text,
  -- outcome
  amount_in_actual numeric, amount_out numeric, effective_rate numeric,
  impact_bps real, fill_ratio real, fully_fillable boolean, unroutable_reason text,
  -- caller metadata (see 3.3)
  ip inet, user_agent text, origin text,
  request_id text,                              -- caller-supplied. UNTRUSTED — never a key
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);

CREATE TABLE request_hops (
  request_id uuid NOT NULL, ts timestamptz NOT NULL,
  hop_index smallint NOT NULL, pair text NOT NULL, side text NOT NULL,
  amount_in numeric, amount_out numeric, fee_cost numeric, fee_currency text,
  reference_price numeric, impact_bps real, fully_fillable boolean,
  PRIMARY KEY (ts, request_id, hop_index)
) PARTITION BY RANGE (ts);

CREATE TABLE request_legs (
  request_id uuid NOT NULL, ts timestamptz NOT NULL,
  hop_index smallint NOT NULL, exchange_id text NOT NULL,
  amount numeric, average_price numeric, taker_fee_rate numeric, fee_cost numeric,
  PRIMARY KEY (ts, request_id, hop_index, exchange_id)
) PARTITION BY RANGE (ts);
```

**Why normalised and not `jsonb`:** the questions worth asking are relational — *which venues do we
route to most, and for how much volume?*, *how often does a bridge beat the direct market?*, *what
is our average impact by pair?* Those are `GROUP BY exchange_id` and `GROUP BY pair`, which are
trivial on columns and awkward on `jsonb` even with a GIN index. Row multiplication is irrelevant at
this volume (one request ≈ 1–2 hops ≈ 2–6 legs, so ~600 rows/day), and columnar child tables are
exactly the shape ClickHouse wants if you ever move.

`jsonb` would be the right call if the shape were unstable or rarely queried. It is neither.

**Deliberately not stored:** the full response body. `quotes[]` alone carries ~40 venues per hop and
is a diagnostic that is stale in seconds. If you later want bodies for support, gzip them into object
storage keyed by `requests.id` — do not put them in a table.

### 3.3 Caller metadata — yes, but not "headers"

Store `ip`, `user_agent` and `origin`. They answer real questions: which SDK, which region, is this
one person or twenty, is a spike abuse or a customer.

**Do not store headers wholesale.** `x-api-key` and `authorization` are headers; a blanket capture
puts live credentials in the database and in every backup. Explicit allowlist of three fields, never
a loop over `request.headers`.

`ip` is personal data under GDPR and you are operating from the Netherlands. For a beta with a
handful of known users that is fine, but it needs a line in the privacy policy before the first
external signup, and `user_id` is denormalised onto every row so "delete my data" is one statement.

### 3.4 Retention: forever, for now

Agreed. At ~100 req/day that is **36,500 request rows/year** — a few MB. Keeping everything through
beta is strictly more useful than any retention policy.

The tables are partitioned monthly anyway, so introducing retention later is `DROP TABLE` on a
partition rather than a migration. Nothing about the schema changes when volume does.

### 3.5 Rollups

`usage_hour (hour_start, key_id, route, status_class) → requests, duration_sum`, maintained by the
ingester in the same transaction as the detail rows. At beta volume you could compute the dashboard
straight from `requests` — the rollup exists so that the query the dashboard runs is the same query
at 100 req/day and at 1,000 req/s. Changing that query later is the migration this avoids.

---

## 4. Scaling later without redoing this

Your constraint — *move machines without changing schema or infra* — is the design goal, not an
afterthought. What makes it hold:

| Change | What moves |
|---|---|
| Bigger VM | Nothing. Config. |
| Postgres to its own host | One connection string. The ingester and dashboard already speak to it over a socket; only the router must never hold that string. |
| Router horizontally scaled | Each instance keeps its own in-memory key snapshot and its own audit log; each runs an ingester writing to the same Postgres. The `requests` PK is `(ts, uuid)` so there is no shared sequence to contend on. |
| Postgres → ClickHouse for events | `requests` / `request_hops` / `request_legs` are append-only, have no foreign keys *pointing into* them, and are time-partitioned. They move as a unit; `users`, `api_keys` and `usage_hour` stay in Postgres. |

The one thing that would force a rewrite is putting the router's auth on a database round-trip. It
is not, and the router deliberately does not get the connection string.

---

## 5. Signup without email

Email is deferred until sign-off, so beta signup is: **email + password → account → API key shown
once → a working curl on the same page.** No verification mail, no password reset link.

Consequences, stated rather than discovered later:

- Email is an unverified label. Fine while you know every user; it is the first thing to fix before
  a public launch.
- **Password reset is manual** — you reset it from the admin dashboard. Build that button now; it is
  five minutes and its absence is the first support request you will get.
- Abuse control is the admin's revoke button plus a per-IP signup rate limit, not verification.
- `email_verified_at` exists in the schema from day one, so switching it on later is a behaviour
  change, not a migration.

When you do add it: an `@ccxt.com` sender or any provider works, and the only code change is gating
key issuance on `email_verified_at IS NOT NULL`.

---

## 6. The site

Separate from CCXT's docs in every sense — own app, own styling, own content, no shared build.

| Page | Content |
|---|---|
| **Home** | What it does in one screen. The differentiators are real and measured — say them plainly: asset-to-asset (`from`/`to`, no side to get backwards), book-walked rather than top-of-book, every bridge compared (live: `USDC→TRY` routes via **ETH**, ~9 bps better than the obvious USDT path), price impact reported, splits that save a measured 0.19–2.2 bps. |
| **Docs — developers** | Auth, endpoints, errors, rate limits, copy-paste snippets. Generated from `openapi/openapi.yaml` so it cannot drift from the API. |
| **Docs — traders** | What impact means and when to act on it; when splitting helps; why a route bridged; what `fillRatio` is telling you. Prose, not reference. |
| **Sign up** | Email + password → key shown once → a filled-in curl **on the same page**. |
| **Dashboard** | Your keys, your usage. Admin sees everyone's. |

The homepage-to-working-call path is the only funnel that matters for the demo: one page, one form,
one copy-paste command with the key already substituted.

Admin routes are simply absent from `openapi/openapi.yaml`. That is documentation hygiene; the
security is authz (§7).

---

## 7. Exposed dashboard — the controls that make it safe

- **scrypt N=16384.** `N=2**15` throws `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` on Node 22 — verified;
  `128·N·r` is one byte over the 32 MiB `maxmem` default. Throttle per-IP before the KDF runs.
- **TOTP on the admin account.** On loopback it was optional because SSH was the boundary. There is
  no SSH boundary now; the password is the only thing between the internet and key minting.
- `Secure; HttpOnly; SameSite=Lax`, `__Host-` prefix, CSRF token on every mutation, session id
  rotated on login.
- **Two principals, one boundary.** Every customer query filtered by `user_id` from the *session*,
  never from the request. `is_admin` is not in any input struct. Server-side ceilings on
  `rate_limit_max` and `ws_max_connections` (in the schema above) — a key minted with `1e9` is an
  outage lever aimed at the router.

> **Defect this design must avoid:** `x-request-id` is caller-supplied, so using it as the ingest
> idempotency key would let a customer pin it to a constant, collapse every request into one row and
> get unlimited free calls. It is stored as a join key to the log and documented as untrusted;
> dedup is on the server-minted `requests.id`.

---

## 8. Order of work

1. **Fix §1.** Cap shard heap, stagger startup, reconsider coinbase. Independent of everything else
   and currently degrading CCXT's docs box.
2. Postgres in Docker + schema + seed an admin user.
3. Rip out `keys.json`, the CLI write path, and the legacy/dev key bridges; point `ApiKeyStore` at
   Postgres with the boot-cache snapshot.
4. Ingester: audit stream → Postgres, cursor committed with the rows.
5. Admin dashboard — you are the only user, so this is the shortest path to something usable.
6. Signup + customer dashboard.
7. Homepage + docs.

Steps 1–4 are invisible to anyone but you and can ship immediately. 5–7 are the demo.

## 9. Still open

1. **Who owns it.** CCXT's product, developed independently — but that needs to be true in the
   repository too. Does this stay in `pcriadoperez/ccxt` on a branch, or move to its own repo before
   it holds real accounts? It affects the ToS, the data controller, and who can deploy.
2. **The privacy line** for storing `ip` before the first external signup.
3. **Whether the beta URL is acceptable to show a boss.** `docs.ccxt.com/router/` works technically;
   it also tells him this is a side project on someone else's box. That may be exactly right for a
   validation exercise — worth being deliberate about rather than defaulting into.
