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
