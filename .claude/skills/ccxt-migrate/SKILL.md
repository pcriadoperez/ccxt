---
name: ccxt-migrate
description: Migrate a project from pmxt (pmxtjs / pmxt, the prediction-market SDK) to CCXT, in TypeScript/JavaScript or Python. Covers the ccxt-migrate codemod, the pmxt-to-CCXT method/error/venue mapping, response-shape differences, WebSocket subscription rewrites, and how to verify the result against a live exchange. Use when a codebase imports pmxtjs or pmxt and the user wants to move it to ccxt, or asks how a pmxt call maps onto CCXT.
---

# Migrating from pmxt to CCXT

pmxt models its API on CCXT's, so most call sites map cleanly. The hard parts are not
the method names — they are **venue coverage**, **instrument identifiers**, and
**response shapes**. Work in that order.

## 0. Read this before you start

Since **ccxt 4.5.77** there is a dedicated `ccxt.prediction` namespace covering
**Polymarket, Kalshi, Limitless, Myriad, Opinion** and **Hyperliquid's prediction
markets** — the same events → markets → outcomes model pmxt uses, and the same 0..1
pricing. For those venues this is a near drop-in move, not a rewrite:

```js
const exchange = new ccxt.prediction.polymarket ();
```

Verify the version before you rely on it — `ccxt.prediction` does not exist before 4.5.77:

```js
console.log (ccxt.version, Object.keys (ccxt.prediction ?? {}));
```

Venues CCXT still has **no** integration for: `Probable`, `Baozi`, `Metaculus`,
`Smarkets`, `SuiBets`, `Rain`, `Hunch`, plus pmxt's `Router` (no cross-venue router in
CCXT) and `Mock` (use `setSandboxMode(true)`). If the codebase uses one of those, **say
so and stop for a decision** — do not substitute an unrelated exchange, invent an
exchange id, or quietly delete the feature. The honest outcomes are: keep pmxt for those
venues (a project can use both), drop the feature, or move to a venue CCXT covers.

`GeminiTitan` is the one partial case: CCXT's `gemini` is spot only, so moving it is a
product-surface change, not a swap.

For anything about the *source* side of the migration — what a pmxt method returns, what
a venue class supports, what the hosted session layer does — read pmxt's own docs rather
than inferring it from the call site: <https://github.com/pmxt-dev/pmxt#readme> (the
Documentation URL both `pmxtjs` and `pmxt` declare) and <https://www.pmxt.dev/docs>.
The tables below cover the mapping, not pmxt's own semantics.

## 1. Run the codemod first

```bash
npx ccxt-migrate@latest --report MIGRATION-REPORT.md
```

Add paths to narrow it (`npx ccxt-migrate@latest src tests`), `--dry-run` to preview,
`--yes` to skip the confirmation. It handles TypeScript, JavaScript and Python, and
picks the right CCXT flavour per file: `ccxt.prediction` for prediction venues, `ccxt`,
`ccxt.pro` when the file subscribes, or `ccxt.async_support` for async Python.

It only does what it can do safely — imports, constructors, method renames, argument
reordering, error classes — and drops a `TODO(ccxt-migrate)` marker everywhere a human
judgement call is needed. **Read `MIGRATION-REPORT.md` before editing anything**; its
"Not migrated" section is the coverage gap, not a codemod limitation.

The codemod refuses to run twice over the same file (it would clobber the `pmxtjs`
imports it deliberately kept). Resolve the markers instead of re-running.

`npx ccxt-migrate@latest rules` prints the full mapping tables if you need to look one up.

## 2. Resolve the TODO markers

```bash
grep -rn "TODO(ccxt-migrate)" .
```

### Identifiers

**Prediction venues: your `outcomeId` values keep working.** CCXT addresses an outcome by
a readable handle like `TRUMP_ACQUIRE_GREENLAND_2027:YES`, but it also accepts the raw
outcome id — the same CLOB token id pmxt used. Verified live against Polymarket: passing
the raw `outcomeId` to `fetchOrderBook` returns the identical book. So leave those
variables alone unless you want the friendlier handle:

```js
const events = await exchange.fetchEvents ({ 'query': 'Trump' });
const outcome = events[0]['markets'][0]['outcomes'][0];
outcome['outcome'];    // 'TRUMP_ACQUIRE_GREENLAND_2027:YES' — the handle
outcome['outcomeId'];  // the raw id, what pmxt gave you
```

Note `fetchEvents` **must be scoped** by at least one of `query`, `queries`, `tags`,
`eventId` or `slug`, or it throws `ArgumentsRequired` on every venue. For an unscoped
browse use `fetchMarkets()`.

**Crypto venues** (the `GeminiTitan` → `gemini` case) are the opposite: there is no
outcome id, and you need a real unified symbol — `'BTC/USDT'`, `'BTC/USDC:USDC'`. Never
guess one; load them:

```js
const markets = await exchange.loadMarkets ();
console.log (Object.keys (markets).slice (0, 20));
```

### Response shapes

pmxt returns typed objects with attribute access; CCXT returns plain dicts and arrays.

| | pmxt | CCXT |
|---|---|---|
| Markets | `UnifiedMarket[]`, `.marketId`, `.outcomes` | dict keyed by symbol, `market['symbol']`, `['precision']`, `['limits']` |
| Order book | `book.bids[0].price` / `.size` | `book['bids'][0][0]` (price), `[0][1]` (amount) |
| OHLCV | `candle.close` | `candle[4]` — rows are `[timestamp, open, high, low, close, volume]` |
| Balance | `Balance[]`, `.currency`, `.available` | `balance['USDT']['free']` / `['used']` / `['total']` |
| Order | `.marketId` + `.outcomeId`, status `canceled`/`rejected` | `['symbol']`, `['id']`, `['status']` in `open`/`closed`/`canceled` |
| Position | `.size`, `.unrealizedPnL` | `['contracts']`, `['unrealizedPnl']`, `['side']` |
| Prices | `0.0`–`1.0` probability | prediction venues: **also `0.0`–`1.0`**, so the numbers carry over. Crypto venues: quote-currency, unbounded |

Prices are only a trap when the target is a **crypto** venue: there, code assuming a 0–1
range (percentage formatting, implied probability, spread thresholds, position sizing)
breaks. Prediction-to-prediction keeps the 0–1 scale, so that code is fine.

### Argument order

The codemod rewrites these, but check its work:

| pmxt | CCXT |
|---|---|
| `fetchOHLCV(outcomeId, resolution, limit, start, end)` | `fetchOHLCV(outcome, timeframe, since, limit, params)` — `limit` and the start time swap places, `end` has no slot |
| `fetchTrades(outcomeId, { limit })` | `fetchTrades(outcome, since, limit, params)` |
| `createOrder({ marketId, outcomeId, side, type, amount, price })` | `createOrder(outcome, type, side, amount, price, params)` — `amount` is shares, `price` stays 0..1 |
| `cancelOrder(orderId)` | `cancelOrder(id, outcome, params)` |
| `fetchAllOrders(params)` | `fetchOrders(outcome, since, limit, params)` |

(On crypto venues the first argument is a unified symbol instead of an outcome handle;
everything else about the order is the same.)

`since` is a millisecond integer, not a `Date`. Anything pmxt took as `end` usually
becomes `params['until']` — check the exchange's page in the CCXT docs.

### Authentication

Delete the pmxt hosted-session plumbing entirely: `pmxtApiKey`, `getAuthNonce()`,
`loginWithSignature()`, `logout()`, `isSessionActive()`. CCXT talks to the venue
directly and signs every request from the credentials on the instance. There is no
CCXT-hosted service and no session to establish.

```js
const exchange = new ccxt.prediction.hyperliquid ({
    'walletAddress': process.env.WALLET_ADDRESS,
    'privateKey': process.env.PRIVATE_KEY,
});
```

Note that Python CCXT takes a **config dict with camelCase keys**, not kwargs. And
`ccxt.prediction` is **async-only** — `ccxt.prediction.<id>` *is* the async class, so
every call needs `await` and an async caller:

```python
import ccxt.prediction
exchange = ccxt.prediction.polymarket()
events = await exchange.fetch_events({'query': 'Trump'})
await exchange.close()
```

Credentials go in the same config dict:

```python
exchange = ccxt.prediction.hyperliquid({
    'walletAddress': os.environ['WALLET_ADDRESS'],
    'privateKey': os.environ['PRIVATE_KEY'],
})
```

### WebSocket

CCXT Pro never uses callbacks. Every `watch*` method returns the next update from an
`await`; you call it in a loop.

```js
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

`unwatchOrderBook` is spelled `unWatchOrderBook` in CCXT (capital W). Always `close()`
the exchange on shutdown — CCXT Pro and `ccxt.async_support` hold open sockets.

### Things with no CCXT equivalent

`Router`, `fetchArbitrage`, `fetchMatches`, `compareMarketPrices`, `fetchHedges`,
`firehose`, the escrow and SQL helpers. Report each one; do not fake it. Some are a few
lines of your own code on top of CCXT (comparing two exchanges' tickers); say which, and
let the user decide.

Three that **used to** be on this list and are no longer:

- `fetchEvents` / `fetchEvent` — real CCXT methods now. `fetchEvents` must be scoped by
  `query`, `queries`, `tags`, `eventId` or `slug`.
- `fetchSeries` — no first-class series object, but `fetchEvents({ tags })` resolves to
  Kalshi series, Polymarket tag listings, Limitless categories and Myriad searches.
- `getExecutionPrice` — `fetchTradeQuote` covers it on AMM venues. On CLOB venues there
  is still no quote endpoint, so walk the order book yourself.

## 3. Capabilities are per-exchange

CCXT's unified API is a superset — not every exchange implements every method, and some
implement it with different scope. Check before relying on it:

```js
if (!exchange.has['fetchOHLCV']) { /* fall back */ }
```

Real example: `hyperliquid.has['fetchTrades']` is `true`, but its `fetchTrades` is
user-scoped and needs a wallet address, unlike most exchanges where it is public. Read
the exchange's page in the docs rather than assuming.

## 4. Swap the dependency

```bash
npm uninstall pmxtjs && npm install ccxt      # TypeScript / JavaScript
pip uninstall pmxt && pip install ccxt        # Python
```

Leave `pmxtjs` / `pmxt` installed if the project keeps any venue CCXT does not cover.

## 5. Adversarially review the diff for behaviour changes

A migration is only done if the code still does the same thing. Every call site the
codemod touched is a place where it can now do something subtly different **and still
compile**. So make one deliberate pass over the whole diff in an adversarial frame:
assume a regression is in there and go find it. Do not read for whether the new code
looks reasonable — for each changed call, ask what the exchange now receives compared to
what it received before.

Be precise about what "the same" means. pmxt calls its hosted API; CCXT signs and calls
the venue directly, so the literal HTTP requests will never match, and it is not a bug
that they don't. What must match is the **intent** of each call: same instrument, same
time window, same limit, same order side/amount/price, same account.

These are the regressions that compile. Check the diff against every one:

| # | Regression | How to catch it |
|---|---|---|
| 1 | **Wrong time window.** `fetchOHLCV(outcomeId, resolution, limit, start, end)` → `fetchOHLCV(symbol, timeframe, since, limit)` — `limit` and the start time swap position, and `end` has no slot at all. | For every `fetchOHLCV` / `fetchTrades` / `fetchOrders`: is `since` a millisecond integer (not a `Date`, not seconds)? Did `end` become `params['until']`, or get dropped? |
| 2 | **Price scale — crypto venues only.** On `ccxt.prediction.*` prices stay `0.0`–`1.0`, so thresholds carry over untouched. Moving to a *crypto* venue (`GeminiTitan` → `gemini`) changes them to unbounded quote-currency. | Only if the target is a crypto exchange: find every threshold, spread check, percentage format and position-size calculation downstream of a price. `if (price > 0.95)` becomes dead code there. |
| 3 | **Response shape.** `book.bids[0].price` → `book['bids'][0][0]`; `candle.close` → `candle[4]`. | Arithmetic on a value that is now an array gives `NaN` in JS and raises in Python — but truthiness checks, string interpolation and JSON serialisation fail *silently*. |
| 4 | **Order semantics.** `createOrder({ marketId, outcomeId, side, type, amount, price })` → `createOrder(symbol, type, side, amount, price)`. | Confirm `type` and `side` did not swap slots, and that `amount` means the same unit on the target exchange (contracts vs base currency — check `market['contractSize']`). |
| 5 | **Dropped arguments.** `loadMarkets()` takes no filters; the order adapters drop pmxt-only options. | Every drop is listed in `MIGRATION-REPORT.md`. If the code depended on a filter, re-implement it client-side rather than losing it. |
| 6 | **Error handling.** `MarketNotFound` → `BadSymbol`, `PmxtError` → `ExchangeError`. | The names changed *and* the hierarchy did. A broad `except PmxtError` that used to swallow everything may now let a different error escape — or catch one it should not. |
| 7 | **Account identity.** pmxt took an address: `fetchBalance(address)`, `fetchPositions(address)`. CCXT uses the credentials on the instance. | If the code queried more than one address, every one of those call sites now returns the *same* account. Easy to miss, expensive to ship. |
| 8 | **Subscription delivery.** Callback-style `watch*` → CCXT Pro's await-in-a-loop. | Does the loop drop updates while its body runs? Is `close()` called on shutdown? Two concurrent watch loops on one symbol behave differently from two callbacks. |
| 9 | **Request pacing.** CCXT sets `enableRateLimit` true by default and throttles per exchange. | Code that relied on pmxt's aggregated pacing may now run slower, or hit a venue limit that pmxt's hosted layer used to absorb. |

Then stop reasoning about it and look at the wire. `exchange.verbose = true` (JS and
Python) or `--verbose` (`ccxt-cli`) prints every outbound request and the raw response.
Run the migrated path, read what actually went out, and check it against what the pmxt
version was asking for — market id, window, limit, order fields. That is the strongest
evidence available without placing an order.

If the project has tests, the bar is that they pass **unchanged**. A test you edited to
make it green is a behaviour change; it may be the correct one, but it is never a silent
one — report it.

## 6. Verify

In this order, and do not skip to the last one:

1. Type-check / lint the project.
2. Run its test suite.
3. Smoke-test against a **live public endpoint** with no credentials:

```js
const exchange = new ccxt.kraken ();
await exchange.loadMarkets ();
console.log (await exchange.fetchTicker ('BTC/USD'));
```

4. Only then test authenticated read paths (`fetchBalance`, `fetchPositions`).

**Never place a live order to verify a migration.** If you must exercise the order path,
use `exchange.setSandboxMode (true)` on an exchange that supports a testnet. If a real
order is genuinely unavoidable, ask the user first, keep the notional under 25 USD, and
cancel it in a `finally` block.

## 7. Report back

Say what changed, what you verified and how, every regression the review in step 5 turned
up and how you resolved it, and every call site that still has no CCXT equivalent. A
migration that silently dropped a venue is a failed migration even if everything compiles
— and so is one that silently changed what the exchange receives.

## Reference

- Full mapping tables: `npx ccxt-migrate@latest rules`, or https://github.com/ccxt/ccxt/blob/master/wiki/Migrate-From-PMXT.md
- CCXT manual: https://docs.ccxt.com/#/README
- pmxt docs (the source side): https://github.com/pmxt-dev/pmxt#readme and https://www.pmxt.dev/docs
- Language skills: `ccxt-typescript`, `ccxt-python`
