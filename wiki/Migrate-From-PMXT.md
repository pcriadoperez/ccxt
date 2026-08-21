# Migrate from pmxt to CCXT

pmxt models its SDK on CCXT's, so most of a migration is mechanical — and the mechanical
part is a single command. What is *not* mechanical is venue coverage, instrument
identifiers and response shapes, so this page gives you a codemod for the first part and
an AI-agent prompt for the second.

## Before you start: check your venues

**pmxt is a prediction-market aggregator. CCXT is a spot and derivatives exchange
library.** They overlap in API design, not in market coverage.

| pmxt venue | CCXT |
|---|---|
| `Hyperliquid` | [`hyperliquid`](exchanges/hyperliquid.md) — spot + perpetuals |
| `GeminiTitan` | [`gemini`](exchanges/gemini.md) — spot |
| `Polymarket`, `PolymarketUS`, `Kalshi`, `Limitless`, `Probable`, `Baozi`, `Myriad`, `Opinion`, `Metaculus`, `Smarkets`, `SuiBets`, `Rain`, `Hunch` | no CCXT integration |

Even for the two that do map, the product surface differs: pmxt addresses those venues'
prediction markets, CCXT addresses their spot and perpetual markets.

So this migration makes sense when you are moving crypto trading off pmxt's hosted API
onto CCXT's direct-to-venue model — 100+ exchanges, no middleman API key, no hosted
custody. If your project trades prediction markets, CCXT has nothing to point those calls
at, and the tooling below will tell you exactly which call sites are affected rather than
producing code that cannot work. A project can use both libraries side by side; the
codemod is built to leave that door open.

---

## Use an AI agent (recommended)

An AI coding agent can run the codemod, work through the markers it leaves, resolve the
symbols that need real market data to resolve, and verify the result against a live
endpoint. Give the agent this prompt:

```
Migrate this project from pmxt to CCXT.

Read the migration guide at https://github.com/ccxt/ccxt/blob/master/wiki/Migrate-From-PMXT.md
(also published on docs.ccxt.com) as the source of truth for the migration, and load the `ccxt-migrate` skill if your tooling supports skills
(`npx skills add ccxt/ccxt`). Also load the language skill for this codebase —
`ccxt-typescript` or `ccxt-python`.

Start by running the codemod for the mechanical half:

    npx ccxt-migrate@latest --report MIGRATION-REPORT.md

Read MIGRATION-REPORT.md before you touch anything else. Its "Not migrated"
section is the part that matters: pmxt is a prediction-market aggregator and
CCXT is a spot/derivatives library, so any Polymarket, Kalshi, Limitless or
similar venue in this codebase has no CCXT equivalent at all. Do not invent
one, do not silently swap in an unrelated exchange, and do not delete the
feature. Tell me which call sites are affected and stop for a decision on them.

Then work through every `TODO(ccxt-migrate)` marker the codemod left:

- Replace pmxt `outcomeId` / `market_id` values with unified CCXT symbols.
  Call `loadMarkets()` once and look at the real keys — never guess a symbol.
- Rewrite response handling for CCXT's shapes: order-book levels are
  `[price, amount]` arrays, OHLCV rows are `[timestamp, open, high, low, close, volume]`
  arrays, and `fetchBalance()` returns a dict keyed by currency code with
  free/used/total.
- Convert any pmxt callback-style `watch*` subscription into CCXT Pro's
  await-in-a-loop pattern, and make sure `close()` is called on shutdown.
- Remove the pmxt hosted-session plumbing (`pmxtApiKey`, `getAuthNonce`,
  `loginWithSignature`, `logout`). CCXT talks to the venue directly and signs
  every request from the credentials on the exchange instance.
- Swap the dependency: remove `pmxtjs`/`pmxt`, add `ccxt`.

Explain the plan in plain language before making broad changes. Follow the
documented mapping and keep moving unless a change is destructive, credentials
are missing, or the correct migration is genuinely ambiguous — then ask me.

Verify before you claim it works: type-check or lint the project, run its tests,
then smoke-test against a live *public* endpoint (`fetchTicker`, `fetchOrderBook`)
with no API keys involved. Never place a live order to verify a migration.

Finish with a summary of what changed, what you verified, and every call site
that still has no CCXT equivalent.
```

`npx ccxt-migrate@latest prompt` prints this same prompt, so you can pipe it straight
into your agent.

### Set up agent docs first

The `ccxt-migrate` skill teaches an agent the whole mapping — venues, methods, errors,
response shapes, the CCXT Pro subscription pattern, and how to verify safely. Install it
alongside the language skills:

```bash
npx skills add ccxt/ccxt
```

That works with Claude Code, Cursor, Copilot, Windsurf, Codex and 30+ other assistants.
See [AI Skills](AI-Skills.md) for the alternatives.

---

## Or run the codemod on its own

```bash
npx ccxt-migrate@latest
```

It scans the current directory, prints a plan, and asks before writing. Commit or stash
first.

```bash
npx ccxt-migrate@latest src tests          # only these paths
npx ccxt-migrate@latest --dry-run          # preview the diff, write nothing
npx ccxt-migrate@latest --yes              # skip the confirmation
npx ccxt-migrate@latest --report OUT.md    # where to write the report
npx ccxt-migrate@latest rules              # print the full mapping tables
```

One command covers both languages: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs` files are
migrated to CCXT for TypeScript/JavaScript, `.py` files to CCXT for Python. It picks the
right flavour per file — plain `ccxt`, `ccxt.pro` when the file subscribes to a stream,
`ccxt.async_support` for async Python.

### What the codemod does

- rewrites `pmxtjs` / `pmxt` imports to `ccxt`
- maps venue classes to CCXT exchange ids, and converts constructor options
  (in Python, pmxt's keyword arguments become CCXT's config dict)
- drops `pmxtApiKey` — CCXT has no hosted API to authenticate against
- renames methods (`fetchAllOrders` → `fetchOrders`, `unwatchOrderBook` → `unWatchOrderBook`, …)
- reorders arguments where the signatures differ, including `fetchOHLCV`'s
  `limit`/`since` swap and `createOrder`'s object-to-positional change
- maps error classes (`MarketNotFound` → `BadSymbol`, `PmxtError` → `ExchangeError`, …)

### What it deliberately does not do

It leaves a `TODO(ccxt-migrate)` comment instead of guessing, for:

- **unified symbols** — it cannot know that a CLOB token id should become `'BTC/USDC:USDC'`
- **response shapes** — rewriting field access blindly would silently corrupt working code
- **venues CCXT does not cover** — it keeps the `pmxtjs` import for those, so your project
  still compiles and you can decide per call site

It also refuses to run twice over the same file, because a second pass would clobber the
`pmxtjs` imports it kept on purpose. Resolve the markers instead of re-running.

Then:

```bash
grep -rn "TODO(ccxt-migrate)" .
npm uninstall pmxtjs && npm install ccxt      # TypeScript / JavaScript
pip uninstall pmxt && pip install ccxt        # Python
```

---

## What actually changes

### Setup

```javascript
// before — pmxt, through pmxt's hosted API
import { Hyperliquid } from 'pmxtjs';
const venue = new Hyperliquid ({
    pmxtApiKey: process.env.PMXT_API_KEY,
    walletAddress: process.env.WALLET_ADDRESS,
    privateKey: process.env.PRIVATE_KEY,
});

// after — CCXT, straight to the venue
import ccxt from 'ccxt';
const venue = new ccxt.hyperliquid ({
    'walletAddress': process.env.WALLET_ADDRESS,
    'privateKey': process.env.PRIVATE_KEY,
});
```

```python
# before
import pmxt
venue = pmxt.Hyperliquid(pmxt_api_key="...", wallet_address="0x...", private_key="0x...")

# after — note: a config dict with camelCase keys, not keyword arguments
import ccxt
venue = ccxt.hyperliquid({
    'walletAddress': '0x...',
    'privateKey': '0x...',
})
```

There is no `pmxtApiKey` equivalent and no session handshake. CCXT signs every request
from the credentials on the instance, so `getAuthNonce()`, `loginWithSignature()`,
`logout()` and `isSessionActive()` all disappear.

### Identifiers

The single biggest change. pmxt addresses an instrument by `outcomeId`; CCXT uses a
**unified symbol**: `'BTC/USDT'` for spot, `'BTC/USDC:USDC'` for a linear swap,
`'BTC/USD:BTC-241227'` for a dated future. Load the real ones rather than guessing:

```javascript
const markets = await exchange.loadMarkets ();
console.log (Object.keys (markets).slice (0, 20));
```

### Response shapes

pmxt returns typed objects with attribute access. CCXT returns plain dicts and arrays.

| | pmxt | CCXT |
|---|---|---|
| Markets | `UnifiedMarket[]` — `.marketId`, `.outcomes` | dict keyed by symbol — `market['symbol']`, `['precision']`, `['limits']` |
| Order book | `book.bids[0].price` / `.size` | `book['bids'][0][0]` (price), `[0][1]` (amount) |
| OHLCV | `candle.close` | `candle[4]` — rows are `[timestamp, open, high, low, close, volume]` |
| Balance | `Balance[]` — `.currency`, `.available` | `balance['USDT']['free']` / `['used']` / `['total']` |
| Order | `.marketId` + `.outcomeId`, status `canceled`/`rejected` | `['symbol']`, `['id']`, `['status']` in `open`/`closed`/`canceled` |
| Position | `.size`, `.unrealizedPnL` | `['contracts']`, `['unrealizedPnl']`, `['side']` |
| Prices | `0.0`–`1.0` probability | quote-currency price, unbounded |

That last row is the one that bites. Anything assuming a 0–1 range — percentage
formatting, implied probability, spread thresholds, position sizing — is wrong after the
migration and will not raise an error.

### Methods

| pmxt | CCXT |
|---|---|
| `fetchMarkets(params)` | `loadMarkets()` — returns a map keyed by symbol; no query/sort/limit filters |
| `fetchMarket(id)` | `market(symbol)` — synchronous, reads the loaded cache |
| `fetchOrderBook(outcomeId, limit)` | `fetchOrderBook(symbol, limit, params)` |
| `fetchOHLCV(outcomeId, resolution, limit, start, end)` | `fetchOHLCV(symbol, timeframe, since, limit, params)` |
| `fetchTrades(outcomeId, { limit })` | `fetchTrades(symbol, since, limit, params)` |
| `fetchBalance(address)` | `fetchBalance(params)` — credentials identify the account |
| `fetchPositions(address)` | `fetchPositions(symbols, params)` |
| `createOrder({ marketId, outcomeId, side, type, amount, price })` | `createOrder(symbol, type, side, amount, price, params)` |
| `buildOrder()` + `submitOrder()` | `createOrder()` — CCXT signs and submits in one call |
| `cancelOrder(orderId)` | `cancelOrder(id, symbol, params)` |
| `fetchOrder(orderId)` | `fetchOrder(id, symbol, params)` |
| `fetchAllOrders(params)` | `fetchOrders(symbol, since, limit, params)` |
| `watchOrderBook(outcomeId)` | `watchOrderBook(symbol, limit, params)` — CCXT Pro |
| `unwatchOrderBook(outcomeId)` | `unWatchOrderBook(symbol, params)` — note the capital W |

`since` is a millisecond integer, not a `Date`. Whatever pmxt took as `end` is usually
`params['until']` in CCXT — check your exchange's page.

`npx ccxt-migrate@latest rules` prints the complete table, including every pmxt method
with no CCXT equivalent.

### Errors

pmxt's error hierarchy is modelled on CCXT's, so most names carry over unchanged:
`BadRequest`, `AuthenticationError`, `PermissionDenied`, `OrderNotFound`,
`RateLimitExceeded`, `InvalidOrder`, `InsufficientFunds`, `NetworkError`,
`ExchangeNotAvailable`, `NotSupported`.

The ones that move: `PmxtError` → `ExchangeError`, `MarketNotFound` → `BadSymbol`,
`EventNotFound` → `BadSymbol`, `ValidationError` → `BadRequest`, `NotFoundError` →
`ExchangeError`.

### WebSocket

CCXT Pro never uses callbacks. Every `watch*` method returns the next update from an
`await`, so you call it in a loop:

```javascript
import ccxt from 'ccxt';
const exchange = new ccxt.pro.binance ();
while (true) {
    const orderbook = await exchange.watchOrderBook ('BTC/USDT');
    console.log (orderbook['bids'][0], orderbook['asks'][0]);
}
```

```python
import ccxt.pro as ccxt
exchange = ccxt.binance()
while True:
    orderbook = await exchange.watch_order_book('BTC/USDT')
```

Always `close()` on shutdown — CCXT Pro and `ccxt.async_support` hold open sockets.

### Features with no CCXT equivalent

`fetchEvents`, `fetchSeries` and the rest of the event/series model; `Router`,
`fetchArbitrage`, `fetchMatches`, `compareMarketPrices`, `fetchHedges`; `firehose`;
`getExecutionPrice`; the escrow and SQL helpers.

Some are a few lines of your own code on top of CCXT — walking an order book to compute
an execution price, comparing tickers from two exchanges. The codemod lists every one it
found so you can decide, rather than removing them silently.

---

## Capabilities are per-exchange

CCXT's unified API is a superset. Not every exchange implements every method, and some
implement it with a different scope, so check before relying on it:

```javascript
if (!exchange.has['fetchOHLCV']) { /* fall back */ }
```

A concrete example: `hyperliquid.has['fetchTrades']` is `true`, but hyperliquid's
`fetchTrades` is user-scoped and needs a wallet address, where on most exchanges it is a
public endpoint. Read your exchange's page rather than assuming.

---

## Verify

In this order:

1. Type-check or lint the project.
2. Run its test suite.
3. Smoke-test a **live public endpoint** with no credentials:

```javascript
const exchange = new ccxt.kraken ();
await exchange.loadMarkets ();
console.log (await exchange.fetchTicker ('BTC/USD'));
```

4. Only then exercise authenticated read paths (`fetchBalance`, `fetchPositions`).

**Do not place a live order to verify a migration.** Use `exchange.setSandboxMode (true)`
on an exchange with a testnet if you need to exercise the order path.

## See also

- [Manual](Manual.md) — the unified API specification
- [CCXT Pro Manual](ccxt.pro.manual.md) — WebSocket methods
- [Supported Exchanges](Exchange-Markets.md)
- [AI Skills](AI-Skills.md) — including `ccxt-migrate`
- [Install](Install.md)
