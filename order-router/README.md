# order-router

Smart order router built on [ccxt](https://github.com/ccxt/ccxt). Maintains live L2 order books
for configured exchanges/symbols over WebSocket, caches them in-process, and serves best-execution
price lookups that account for order size (book-walking, not just top-of-book) and taker fees.

This is a standalone service that *depends on* ccxt as a library — it does not modify `ts/src/**`
and is not part of the ccxt build/transpile pipeline.

## Architecture

```
Fastify API (reads in-process cache only, no network hop on the read path)
        │
OrderBookCache (Map<exchange, Map<symbol, L2 book>>, in-memory)
        │
ExchangeConnector × N (one per exchange, isolated failure domain, ccxt.pro watchOrderBook loop)
```

- **In-memory is the hot path.** A single instance's API reads never touch Redis/network — see
  `src/cache/orderBookCache.ts`. Redis is not wired up in v1 (single-instance scope); it becomes
  relevant only when running multiple API replicas that need to share connector state, at which
  point a connector-writes-to-Redis-pubsub / API-replica-subscribes pattern is the natural extension.
- **Book-walking, not best-bid/ask.** `/price/best/:symbol` requires an `amount` and walks each
  exchange's cached book to that depth, computing the volume-weighted average price plus taker fee —
  because for any non-trivial order size, the venue with the best top-of-book price is not
  necessarily the venue with the best price for your actual size.
- **Per-exchange isolation.** Each `ExchangeConnector` owns its own WS connection(s) and
  reconnects with exponential backoff independently; one exchange misbehaving (rate limit,
  disconnect storm) never affects others or the API.
- **Push-on-change, not polling.** `OrderBookCache` extends `EventEmitter` and emits
  `update:<symbol>` whenever a book changes; `/stream/best/:symbol` subscribes to that instead of
  polling on a fixed interval, coalescing bursts into at most one computed result per event-loop
  tick via `setImmediate`. A poll-based design costs CPU proportional to `poll_rate x client_count`
  regardless of whether anything changed — doesn't hold up once client/message volume is large.

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
Redis pub/sub in the background (never queried synchronously per-request):

```
Collector(s) --publish--> Redis pub/sub --async subscribe--> API replica 1 (own in-process Map)
                                         --async subscribe--> API replica 2 (own in-process Map)
```

Under that pattern the API layer could legitimately be a different language later (including
Rust) without paying a per-request Redis cost — but only build this once request volume actually
requires multiple replicas, not preemptively.

### WebSocket connection scale — connection count vs. message throughput

These have very different limits and it's easy to conflate them:

- **Connection count is not the bottleneck.** ccxt.pro multiplexes: most exchanges get one WS
  connection per exchange (a few venues cap subscriptions-per-socket, e.g. ~200 streams, forcing a
  handful of extra connections — ccxt handles this internally). Node's event loop handles
  thousands of concurrent outbound sockets fine since I/O is async (epoll-backed); the real ceiling
  is OS file descriptors (`ulimit -n`), trivially raised, not thread count. Going from 5 to 50
  exchanges, or 2 to 500 symbols, is a non-issue in connection terms.
- **Aggregate message throughput on the single JS thread is the actual risk.** Every WS message
  still gets JSON-parsed and diff-merged on one thread. The benchmark above shows KuCoin alone at
  ~480 msg/s for *one* symbol; many exchanges × many symbols could reach tens of thousands of
  msg/s aggregate, at which point event-loop lag (and therefore added latency) is real. This needs
  load-testing with production-scale exchange/symbol counts, not assumption.
- **Mitigation path, in order of when you'd need it:** (1) already done — push-on-change instead
  of polling, see above; (2) when profiling shows single-thread CPU is the bottleneck, shard
  exchanges across multiple OS **processes** (not `worker_threads` sharing one event loop — a CPU
  spike on one exchange's connector shouldn't add latency to another's), each with its own
  in-memory cache for its shard.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/exchanges/status` | per-exchange WS health: connected, last update age, update/reconnect counts |
| GET | `/symbols` | symbols currently cached |
| GET | `/orderbook/:exchange/:symbol` | cached L2 book snapshot (symbol URL-encoded, e.g. `BTC%2FUSDT`) |
| GET | `/price/best/:symbol?side=buy\|sell&amount=<qty>` | book-walked, fee-adjusted best execution price across exchanges |
| WS | `/stream/best/:symbol?side=&amount=` | pushes the same result every 250ms |

## Config (env vars)

| Var | Default |
|---|---|
| `PORT` | `8080` |
| `ORDER_ROUTER_EXCHANGES` | `kraken,coinbase,kucoin,bitget,gate` |
| `ORDER_ROUTER_SYMBOLS` | `BTC/USDT,ETH/USDT` |
| `ORDER_ROUTER_STALE_BOOK_MS` | `5000` — quotes from books older than this are excluded from ranking |
| `LOG_LEVEL` | `info` |

## Run

```bash
npm install
npm run dev        # tsx watch
# or
npm run build && npm start
# or
docker compose up --build
```

## Benchmark (`benchmark/ws-latency.mjs`)

`npm run bench:ws` measures WS update rate, message latency, and cached book depth per exchange.

### Results from this dev sandbox — read the caveats before trusting these numbers

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

## Known gaps / next steps

- Re-run the benchmark from unrestricted, NTP-synced infra, including Binance/Bybit/OKX.
- Order *execution* routing (actually placing orders) is out of scope for this milestone — see
  the repo's live-trading safety rules (25 USD/trade cap, no live `withdraw()` testing) before
  building that; it needs API keys, risk limits, and per-exchange cleanup logic.
- No Redis/multi-instance story yet — single instance only, by design (see Architecture above).
- No Prometheus `/metrics` endpoint yet — `/exchanges/status` covers health for now.
- Depth-limited exchanges (Kraken, Gate, others with capped WS depth) should fall back to REST
  `fetchOrderBook` snapshots when a requested `amount` exceeds cached depth, rather than silently
  reporting `fullyFillable: false`.
