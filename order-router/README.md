# order-router

Smart order router built on [ccxt](https://github.com/ccxt/ccxt). Discovers every ccxt.pro
exchange, loads their markets, and subscribes to the *routable* symbol universe — every symbol
tradable on 2+ exchanges — over WebSocket. Caches live L2 order books in-process and serves
best-execution price lookups that account for order size (book-walking, not just top-of-book) and
taker fees.

This is a standalone service that *depends on* ccxt as a library — it does not modify `ts/src/**`
and is not part of the ccxt build/transpile pipeline.

## Architecture

```
Fastify API (reads in-process cache only, no network hop on the read path)
        │
OrderBookCache + FeeRegistry (in-memory, EventEmitter-based)
        │
        ├── single-process mode (ORDER_ROUTER_SHARD_COUNT=1): ExchangeConnector × N in this process
        │
        └── sharded mode (ORDER_ROUTER_SHARD_COUNT>1): child_process per shard, each running its
            own ExchangeConnector × N, relaying book/health/fee writes to the parent over IPC
```

- **In-memory is the hot path.** The API's read path is always a plain in-process `Map` lookup —
  see `src/cache/orderBookCache.ts`. In sharded mode, a shard's connector writes cross a process
  boundary via IPC (same-host pipe, no external DB, no request-time cost — see "Why single-process
  Node..." below), but the API's *reads* never do, whether sharded or not.
- **Book-walking, not best-bid/ask.** `/price/best/:symbol` requires an `amount` and walks each
  exchange's cached book to that depth, computing the volume-weighted average price plus taker fee —
  because for any non-trivial order size, the venue with the best top-of-book price is not
  necessarily the venue with the best price for your actual size.
- **Per-exchange isolation.** Each `ExchangeConnector` owns its own WS connection(s) and
  reconnects with exponential backoff (plus jitter — see below) independently; one exchange
  misbehaving never affects others or the API.
- **Push-on-change, not polling.** `OrderBookCache` extends `EventEmitter` and emits
  `update:<symbol>` whenever a book changes; `/stream/best/:symbol` subscribes to that instead of
  polling on a fixed interval, coalescing bursts into at most one computed result per event-loop
  tick via `setImmediate`.

### Discovery: only subscribe where routing has value

A symbol listed on exactly one exchange has nothing to route between — subscribing to it costs a
WS subscription, memory, and CPU for zero comparative value. Measured directly across just 5
exchanges (Kraken, Coinbase, KuCoin, Bitget, Gate): **9,412 unique unified symbols, of which only
2,102 (22%) trade on 2+ of those exchanges.** The other 78% are single-exchange noise for a router.

`ORDER_ROUTER_DISCOVER_ALL=true` turns this on: `src/discovery/exchangeDiscovery.ts` lists every
ccxt.pro exchange with `has.watchOrderBook` (76 out of 80 exchange classes, checked locally with no
network calls), `src/discovery/symbolUniverse.ts` loads markets for all of them (bounded
concurrency, tolerant of individual failures — one geo-blocked exchange doesn't abort discovery),
and builds a `symbol -> Set<exchangeId>` index. Only symbols meeting `ORDER_ROUTER_MIN_EXCHANGES_PER_SYMBOL`
(default 2) become subscriptions.

### Subscription mechanics — what actually broke in testing, and the fixes

Naively spawning one independent `watchOrderBook(symbol)` loop per routable symbol (the original
v1 design) does not survive contact with real exchanges once the symbol count gets large. Live
testing against Kraken/Coinbase/KuCoin/Bitget/Gate with their full routable symbol sets (up to
~1,700+ symbols on one exchange) surfaced three distinct failures, each with a specific fix:

1. **Reconnect storms.** With N independent per-symbol loops, any shared-connection hiccup fails
   all N simultaneously; with identical backoff timers they all retry in lockstep, repeatedly
   re-triggering exchange-side rate limits. Observed: 1,000–2,500+ reconnects within 15 seconds on
   KuCoin/Bitget. Fix: **prefer `watchOrderBookForSymbols(symbols)`** (one batched subscription)
   over per-symbol loops wherever the exchange supports it (24 of the exchanges checked do,
   including all of Kraken/Coinbase/KuCoin/Bitget in this test set — only Gate in this set falls
   back to per-symbol), and add **full jitter to backoff** so loops that failed together don't
   retry together.
2. **Per-message/per-connection subscription caps.** Even batched, sending hundreds of symbols in
   one `watchOrderBookForSymbols` call trips server-side limits — observed directly: Bitget
   (`"subscribe over limit, max:1000"`), KuCoin (rejects an overlong comma-joined topic string).
   Fix: **chunk into `ORDER_ROUTER_MAX_SYMBOLS_PER_SUBSCRIPTION`-sized groups** (default 50), each
   its own independent watch loop, with staggered startup (`LOOP_START_STAGGER_MS`) so chunks
   don't all subscribe in the same instant either.
3. **Session-wide caps that chunking alone can't fix.** Coinbase rejected the connection outright
   with `"too many L2 streams requested in a single session"` even with message-size chunking,
   because the cap is on *total concurrent channels for the whole session*, not per message — many
   chunks running concurrently still open that many channels cumulatively. Fix:
   **`ORDER_ROUTER_MAX_SYMBOLS_PER_EXCHANGE`**, a per-exchange total-symbol cap (format
   `"coinbase:25,other:100"`) applied before chunking, truncating (with a logged warning) rather
   than subscribing past a known session limit.

None of these limits are documented anywhere reliable per-exchange — they were found empirically,
the same way `skip-tests.json` accumulates exchange quirks in the main ccxt repo. Expect to tune
`ORDER_ROUTER_MAX_SYMBOLS_PER_EXCHANGE` further per exchange under real production load; this is
not a solved, closed problem, it's a starting point validated against live connections.

### Why single-process Node instead of splitting collector (TS) and API (e.g. Rust) via Redis

Considered and rejected for now: a dedicated TS/ccxt collector process publishing to Redis, with a
separate Rust API layer reading from Redis for speed. The math doesn't favor it:

- An in-process `Map` read is ~100ns. Even a local (same-host) Redis read is ~0.1–0.3ms once you
  count the round trip and (de)serialization — 1,000–3,000x slower — and that cost lands on every
  request if the API queries Redis synchronously.
- The gain from a Rust HTTP/serialization layer over Node's (Fastify) is on the order of tens of
  µs per request. That's dwarfed by the Redis tax you'd introduce to get it, and both are dwarfed
  by exchange WS round-trip time (tens of ms) — the actual latency floor.
- Splitting also means two more language runtimes, two more build/deploy pipelines, and a
  cross-language wire protocol, for a net-negative latency change.

Redis becomes worth it only for **horizontal scaling across hosts**, not raw speed — and even then,
each API replica should keep its own in-memory copy of the cache, updated **asynchronously** via
Redis pub/sub in the background (never queried synchronously per-request). This service's own
sharding (below) already establishes that pattern using Node's built-in IPC instead of Redis, since
sharding today is same-host; swapping the transport for cross-host Redis pub/sub later, keeping the
same "write path is async, read path is always local" shape, is a natural extension, not a rewrite.

### Scaling: connection count vs. message throughput vs. single-thread CPU

- **Connection count is not the bottleneck.** ccxt.pro multiplexes: most exchanges get one WS
  connection per exchange. Node's event loop handles thousands of concurrent outbound sockets fine
  since I/O is async (epoll-backed); the real ceiling is OS file descriptors (`ulimit -n`),
  trivially raised, not thread count.
- **Aggregate message throughput on a single JS thread is the real risk once the routable symbol
  count is large.** Every WS message still gets JSON-parsed and diff-merged on one thread. At full
  discovery scale (76 exchanges, thousands of routable symbols) this plausibly exceeds one
  process's comfortable throughput budget.
- **Fix: process sharding.** `ORDER_ROUTER_SHARD_COUNT>1` splits the discovered/routable exchange
  list across `child_process` workers (`src/sharding/`), load-balanced by symbol count (a rough
  proxy for message rate — no per-symbol throughput data exists yet to balance more precisely).
  Each shard runs its own connectors and cache; the parent process merges book/health/fee updates
  from all shards via IPC into the cache the API reads from. A CPU spike in one shard's connector
  doesn't add latency to another's (separate OS processes, not `worker_threads` sharing one event
  loop). Not benchmarked yet against real per-shard throughput — see Known gaps.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/exchanges/status` | per-exchange WS health: connected, last update age, update/reconnect counts |
| GET | `/symbols` | symbols currently cached |
| GET | `/orderbook/:exchange/:symbol` | cached L2 book snapshot (symbol URL-encoded, e.g. `BTC%2FUSDT`) |
| GET | `/price/best/:symbol?side=buy\|sell&amount=<qty>` | book-walked, fee-adjusted best execution price across exchanges |
| WS | `/stream/best/:symbol?side=&amount=` | pushes on book change (event-driven, not polled) |

## Security

> **Status: stopgap, not an auth system.** A single shared API key with a hardcoded development
> fallback. No rotation, no per-client keys, no revocation, no scopes, no TLS termination of its
> own. It closes the "anyone on the network can read everything" hole; it is not what this should
> ship with to a real public audience. See Known gaps.

**Authentication** (`src/api/auth.ts`). All routes except `/health` require a key, supplied as
either `X-API-Key: <key>` or `Authorization: Bearer <key>`.

- `/health` is deliberately unauthenticated so orchestrator liveness probes work before any
  credential is injectable; it exposes only `status` and process uptime. Everything else —
  including `/exchanges/status`, which leaks the venue list — is protected.
- Keys are compared through SHA-256 digests + `timingSafeEqual`, not `===`. Digesting first makes
  both sides a fixed 32 bytes, so the comparison leaks neither key length nor common prefix
  through timing, and can't throw on a length mismatch.
- The auth hook runs at `onRequest`, i.e. **before routing**, so unknown paths return `401` rather
  than `404` — no oracle for enumerating which routes exist. Missing and wrong keys produce
  byte-identical responses for the same reason.
- Unset `ORDER_ROUTER_API_KEY` falls back to the well-known literal `dev-local-key-change-me` and
  logs a loud warning at startup. That default grants no security; it exists so local dev works
  and so an unconfigured deployment is obviously wrong rather than subtly wrong.

**Rate limiting** (`@fastify/rate-limit`). Default 600 requests / 60s.

- Registered *before* the auth hook, so a flood of invalid keys burns rate-limit budget instead of
  reaching the key comparison unbounded.
- Bucketed **per API key** (falling back to IP only where no key is present), so one client can't
  exhaust another's budget and clients behind a shared NAT aren't collectively throttled.
- `/health` is exempt — a throttled liveness probe reads as an outage to an orchestrator and would
  trigger restarts under exactly the load where that's worst.
- Responses carry `x-ratelimit-*` and `retry-after`.

The MCP server authenticates its own callers with the same key and forwards it upstream; without
that it would be an unauthenticated bypass around the router's auth.

## MCP server (`src/mcp/`)

A separate process (`npm run mcp` / `npm run mcp:dev`) exposing the same public endpoints as MCP
tools over the [Streamable HTTP transport](https://modelcontextprotocol.io/), so an MCP client
(Claude Code, Claude Desktop, etc.) can query the router directly. It's a thin proxy — `src/mcp/tools.ts`
just calls the router's own REST API (`ORDER_ROUTER_API_URL`, default `http://localhost:8080`) —
not a second implementation of the routing logic, so its behavior is exactly the REST API's
behavior. Runs on its own port (`ORDER_ROUTER_MCP_PORT`, default `8081`) and its own process,
decoupled from the router's hot path — an MCP client's traffic never touches the router's
in-memory cache or event loop directly.

| Tool | Maps to |
|---|---|
| `get_health` | `GET /health` |
| `get_exchanges_status` | `GET /exchanges/status` |
| `list_symbols` | `GET /symbols` |
| `get_order_book` (`exchange`, `symbol`) | `GET /orderbook/:exchange/:symbol` |
| `get_best_price` (`symbol`, `side`, `amount`) | `GET /price/best/:symbol?side=&amount=` |

Run both together:

```bash
npm run build
node dist/index.js &                          # router on :8080
ORDER_ROUTER_API_URL=http://localhost:8080 node dist/mcp/server.js &  # MCP on :8081
```

or `docker compose up --build`, which starts both as separate containers on the same network
(the MCP container points `ORDER_ROUTER_API_URL` at the router container's Docker DNS name).

To connect from an MCP client: add an HTTP MCP server pointed at `http://<host>:8081/mcp`. Verified
live end-to-end (real `Client`/`StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`
against a running router with live exchange data) during development — not just the unit tests.

## Config (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `ORDER_ROUTER_DISCOVER_ALL` | `false` | `true` = dynamically discover all exchanges/routable symbols (see Discovery above). `false` = use the explicit lists below. |
| `ORDER_ROUTER_EXCLUDE_EXCHANGES` | (none) | Comma-separated exchange ids to skip, discovery or explicit mode. |
| `ORDER_ROUTER_MIN_EXCHANGES_PER_SYMBOL` | `2` | Discovery mode only — symbol must trade on this many exchanges to be routable. |
| `ORDER_ROUTER_LOAD_MARKETS_CONCURRENCY` | `8` | Discovery mode only — bounded concurrency for the loadMarkets() fan-out. |
| `ORDER_ROUTER_MAX_SYMBOLS_PER_SUBSCRIPTION` | `50` | Max symbols per `watchOrderBookForSymbols` chunk. |
| `ORDER_ROUTER_MAX_SYMBOLS_PER_EXCHANGE` | (none) | Per-exchange total-symbol cap, e.g. `"coinbase:25"`. See Subscription mechanics above. |
| `ORDER_ROUTER_SHARD_COUNT` | `1` | `>1` forks that many child-process shards across the (discovered or explicit) exchange list. |
| `ORDER_ROUTER_EXCHANGES` | `kraken,coinbase,kucoin,bitget,gate` | Explicit mode only. |
| `ORDER_ROUTER_SYMBOLS` | `BTC/USDT,ETH/USDT` | Explicit mode only. |
| `ORDER_ROUTER_STALE_BOOK_MS` | `5000` | Quotes from books older than this are excluded from ranking. |
| `ORDER_ROUTER_API_KEY` | `dev-local-key-change-me` | **Set this in any real deployment.** The default grants no security and logs a warning. |
| `ORDER_ROUTER_RATE_LIMIT_MAX` | `600` | Requests per window, per API key. |
| `ORDER_ROUTER_RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window. |
| `LOG_LEVEL` | `info` | |

## Run

```bash
npm install
npm run dev        # tsx watch, explicit exchange/symbol list (fast local iteration)
# or
npm run build && npm start
# or full discovery + sharding, e.g. 4 shards:
ORDER_ROUTER_DISCOVER_ALL=true ORDER_ROUTER_SHARD_COUNT=4 npm start
# or
docker compose up --build
```

Sharding (`ORDER_ROUTER_SHARD_COUNT>1`) forks compiled `dist/sharding/shardWorker.js` — build first
(`npm run build`) before using it; `npm run dev` (tsx) does not support sharding today.

## Testing

```bash
npm test    # node:test via tsx, no network required
```

49 tests, all offline — no live exchange connections, no mocked `fetch` (HTTP-touching code is
tested against real local fixtures: `node:http` servers for the MCP proxy layer, Fastify's
`inject()` for the REST API, `node:child_process`-free logic-only tests for sharding). Coverage:

| Area | File | What's covered |
|---|---|---|
| Book-walking / fee ranking | `src/routing/bestPrice.test.ts` | VWAP across levels, fee-adjusted ranking beats raw-price ranking, partial fills, buy vs. sell side, stale-book exclusion |
| In-memory cache | `src/cache/orderBookCache.test.ts` | get/set, per-symbol event scoping, health lifecycle, unknown-exchange no-ops |
| Fee registry | `src/cache/feeRegistry.test.ts` | fallback, per-(exchange,symbol) scoping, event emission (used for shard IPC) |
| Symbol universe filtering | `src/discovery/symbolUniverse.test.ts` | the ≥N-exchange routability rule, threshold edge cases, empty input |
| Subscription chunking | `src/connectors/exchangeConnector.test.ts` | `chunkSymbols`/`normalizeLevels` pure helpers extracted from the connector |
| Shard load-balancing | `src/sharding/orchestrator.test.ts` | every exchange assigned exactly once, greedy balance, shard-count edge cases |
| REST API | `src/api/server.test.ts` | all 5 HTTP routes via Fastify `inject()` against a real in-memory cache |
| MCP proxy layer | `src/mcp/tools.test.ts` | URL construction, error propagation, against a real local HTTP fixture |
| MCP protocol | `src/mcp/server.test.ts` | real `Client`/`McpServer` over `InMemoryTransport` — tool listing, tool calls, Zod input validation surfacing as MCP tool errors |

Not covered by unit tests (needs live exchanges, covered by manual verification during
development instead — see git history / PR description): `ExchangeConnector`'s actual WS
lifecycle (reconnect/backoff/jitter against a real socket), discovery's `loadMarkets()` network
calls, and sharding's actual `child_process` IPC (verified live, not by an automated test, since
that requires spawning real subprocesses with real network access).

## Continuous integration

`.github/workflows/order-router.yml` runs on any change under `order-router/` (and nothing else —
this service is not part of ccxt's transpile pipeline). On Node 22 it runs `npm ci`, `npm run build`
(type-check), `npm test` (the offline suite), then two smoke steps that boot the real processes and
assert over HTTP that `/health` is reachable unauthenticated, that a protected route returns `401`
without a key and `200` with the right one, that a *wrong* key is still rejected, and that the MCP
endpoint rejects an unauthenticated JSON-RPC call. Those smoke assertions were verified locally
before being committed.

## Benchmarks

### `npm run bench:multi-connect` — simultaneous multi-exchange connections

Answers "does this actually hold N live exchange connections at once", which no unit test can.
Connects to each candidate exchange, holds for a set duration, reports message counts and failures.

**Measured from this sandbox — 34 attempted, 28 connected simultaneously, 75s hold:**

| | |
|---|---|
| Connected | **28 / 34** |
| Total messages | 28,518 (~380 msg/s aggregate) |
| Errors | 0 on 27 of 28 connected exchanges (lbank: 3) |
| Peak RSS | 230 MB |
| Heap used | 62 MB |

Highest-volume: kucoin (14,809 msgs), poloniex (7,500), gate (1,791), htx (676), bitget (563),
coinbase (493). Median time-to-first-message ~1.8s.

The 6 failures are all explainable, none are router bugs:

| Exchange | Reason |
|---|---|
| `mexc` | needs the optional `protobufjs` peer dep to decode WS frames — installable, not yet done |
| `cex`, `luno` | require API credentials even for public WS |
| `okx`, `binanceus`, `independentreserve` | no data within 20s — the same egress geo-restriction that blocks Binance/Bybit from this sandbox |

Note this is 28 exchanges × 1 symbol. It validates *connection* concurrency, not the full
55k-subscription symbol load — that still needs unrestricted infra (see Known gaps).

### `npm run bench:load` — REST API load test

`autocannon` against a **running** router, so numbers include real auth, rate limiting, book
walking and serialization. Raise `ORDER_ROUTER_RATE_LIMIT_MAX` for the run or you'll measure the
limiter instead of the service.

**Measured: 50 connections, 8s per scenario, 5 live exchanges cached, 0 non-2xx on every
authenticated path:**

| Scenario | req/s | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| `/health` (baseline, no auth, no cache read) | 13,779 | 3ms | 5ms | 9ms | 244ms |
| `/symbols` (iterates whole cache) | 8,138 | 5ms | 7ms | 11ms | 28ms |
| `/orderbook/:ex/:sym` (map lookup + serialize full book) | 6,628 | 7ms | 9ms | 13ms | 209ms |
| `/price/best` small order (walks every exchange book) | 6,397 | 7ms | 9ms | 12ms | 254ms |
| `/price/best` large order (walks deeper) | 4,302 | 11ms | 13ms | 18ms | 292ms |
| unauthenticated (expect 401) | 13,693 | 3ms | 4ms | 6ms | 179ms |

Two things worth reading off this: the routing work itself is cheap (best-price with a large order
still clears 4.3k req/s), and **auth rejection is as cheap as `/health`** — so an unauthenticated
flood costs the server roughly nothing per request and isn't a DoS amplifier.

Caveat: single machine, client and server sharing CPU, so absolute throughput is a floor rather
than a ceiling, and the `max` outliers (~250ms) include client-side scheduling noise.

### `npm run bench:ws` — per-exchange WS latency and book depth

Measures WS update rate, message latency, and cached book depth per exchange.

#### Results from this dev sandbox — read the caveats before trusting these numbers

1. **Binance, Bybit, OKX were unreachable from this sandbox.** Binance/Bybit REST calls returned
   `451`/`403` geo-compliance blocks; OKX's WS connection timed out. This is specific to this
   container's egress IP, not a ccxt limitation. These three are typically the deepest/fastest
   venues in production and **must be re-benchmarked from the actual deployment host** before
   finalizing the exchange list.
2. **Absolute latency figures are unreliable.** Several exchanges reported negative
   exchange-timestamp-to-receipt latency, meaning this container's clock is not NTP-synced against
   exchange time sources. Re-run with `chrony`/NTP synced on the benchmark host for trustworthy
   absolute numbers. Update frequency and book depth (below) don't depend on clock sync and are valid.

| Exchange | Updates / 30s | Book depth (levels) |
|---|---|---|
| KuCoin | 14,432 (~480/s) | 60–245 |
| Kraken | 3,219 (~107/s) | 10 (fixed) |
| Gate | 944 (~31/s) | 50 (fixed) |
| Coinbase | 483 (~16/s) | 1,070–1,103 (near-full L2) |
| Bitget | 281 (~9/s) | 500 (fixed) |

Takeaway: Kraken/Gate cap streamed depth at 10/50 levels, which limits how large an order can be
routed confidently before you'd need a periodic REST depth-snapshot fallback for those venues.
Coinbase streams close to the full book.

## Production readiness

Not ready to expose publicly. Honest status of the blockers:

| Blocker | Status |
|---|---|
| No authentication | **Partly closed** — shared-key auth exists and is tested, but it's a stopgap: no rotation, no per-client keys, no revocation, no scopes (see Security) |
| No rate limiting | **Closed** — per-key limiting, tested, `/health` exempt |
| Never load tested | **Closed** — see Benchmarks; 4.3k–13.8k req/s depending on endpoint |
| Never run against many exchanges at once | **Closed for connection concurrency** — 28 simultaneous live exchanges verified. **Still open for full symbol load** (55k subscriptions) |
| Not in CI | **Closed** — build + tests + boot/auth smoke tests on every change |
| Binance/Bybit/OKX never live-tested | **Open** — geo-blocked from every environment available here |
| No TLS, runs plain HTTP | **Open** — assumes a terminating proxy in front; not documented or provisioned |
| No soak testing | **Open** — longest continuous run is minutes, not hours/days |
| No metrics/alerting | **Open** — only `/exchanges/status` |
| No HA/failover | **Open** — a dead process is an outage |

## Known gaps / next steps

- Re-run the benchmark from unrestricted, NTP-synced infra, including Binance/Bybit/OKX, and at
  full discovery scale (76 exchanges) rather than the 5-exchange subset reachable from this sandbox.
- Replace shared-key auth with something real (per-client keys + rotation + revocation) before any
  public exposure, and put TLS termination in front.
- Install `protobufjs` to unblock `mexc` WS decoding (one dependency; not yet done).
- Soak test: hours-to-days continuous run with `process.memoryUsage()` tracked, to find leaks and
  slow connection drift that a 75-second test can't.
- `ORDER_ROUTER_MAX_SYMBOLS_PER_EXCHANGE` needs real per-exchange tuning under production load —
  the value used in testing (`coinbase:25`) got that one exchange stable but is a starting point,
  not a researched limit. KuCoin also still showed a nonzero (but much reduced, ~30 vs ~1,500
  before the fixes) reconnect rate at ~680 routable symbols that wasn't fully root-caused.
- Shard load-balancing is by symbol count only (a proxy for message rate) — no real per-symbol
  throughput data exists yet to balance more precisely; revisit once shards are under real load.
- Order *execution* routing (actually placing orders) is out of scope for this milestone — see
  the repo's live-trading safety rules (25 USD/trade cap, no live `withdraw()` testing) before
  building that; it needs API keys, risk limits, and per-exchange cleanup logic.
- No Redis/cross-host story yet — sharding today is same-host via IPC only (see Architecture).
- No Prometheus `/metrics` endpoint yet — `/exchanges/status` covers health for now.
- Depth-limited exchanges (Kraken, Gate, others with capped WS depth) should fall back to REST
  `fetchOrderBook` snapshots when a requested `amount` exceeds cached depth, rather than silently
  reporting `fullyFillable: false`.
