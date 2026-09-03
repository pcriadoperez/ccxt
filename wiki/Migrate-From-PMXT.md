# Migrate from pmxt to CCXT

pmxt models its SDK on CCXT's, so most of a migration is mechanical — and the mechanical
part is a single command. What is *not* mechanical is venue coverage, instrument
identifiers and response shapes, so this page gives you a codemod for the first part and
an AI-agent prompt for the second.

## Before you start: check your venues

Since **ccxt 4.5.77** there is a dedicated [`ccxt.prediction`](Prediction-Markets.md)
namespace, built on the same events → markets → outcomes model pmxt uses and the same
`0.0`–`1.0` pricing. For the venues it covers this is close to a drop-in move.

| pmxt venue | CCXT |
|---|---|
| `Polymarket`, `PolymarketUS` | `ccxt.prediction.polymarket` |
| `Kalshi`, `KalshiDemo` | `ccxt.prediction.kalshi` (demo via `setSandboxMode(true)`) |
| `Limitless` | `ccxt.prediction.limitless` |
| `Myriad` | `ccxt.prediction.myriad` |
| `Opinion` | `ccxt.prediction.opinion` |
| `Hyperliquid` | `ccxt.prediction.hyperliquid` — or [`hyperliquid`](exchanges/hyperliquid.md) for its spot/perp markets |
| `GeminiTitan` | [`gemini`](exchanges/gemini.md) — **spot only**, so this one is a product-surface change |
| `Probable`, `Baozi`, `Metaculus`, `Smarkets`, `SuiBets`, `Rain`, `Hunch` | no CCXT integration |
| `Router`, `Mock` | no cross-venue router in CCXT; use `setSandboxMode(true)` instead of the test double |

`ccxt.prediction` does not exist before 4.5.77 — check `ccxt.version` before relying on it.

If your project uses one of the venues in the last two rows, CCXT has nothing to point
those calls at, and the tooling below tells you exactly which call sites are affected
rather than producing code that cannot work. A project can use both libraries side by
side; the codemod is built to leave that door open.

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
For anything about the pmxt side — what a method returns, what a venue class
supports — read pmxt's own docs rather than inferring it from the call site:
https://github.com/pmxt-dev/pmxt#readme and https://www.pmxt.dev/docs.

Start by running the codemod for the mechanical half:

    npx ccxt-migrate@latest --report MIGRATION-REPORT.md

Read MIGRATION-REPORT.md before you touch anything else. Since ccxt 4.5.77 a
`ccxt.prediction` namespace covers Polymarket, Kalshi, Limitless, Myriad,
Opinion and Hyperliquid's prediction markets, with the same events/markets/
outcomes model and the same 0..1 pricing as pmxt — those are near drop-in.
Check `ccxt.version` first, since the namespace does not exist before 4.5.77.
The report's "Not migrated" section is what matters: Probable, Baozi,
Metaculus, Smarkets, SuiBets, Rain, Hunch and pmxt's Router have no CCXT
equivalent at all. Do not invent one, do not silently swap in an unrelated
exchange, and do not delete the feature. Tell me which call sites are affected
and stop for a decision on them.

Then work through every `TODO(ccxt-migrate)` marker the codemod left:

- Identifiers: on prediction venues CCXT accepts the raw `outcomeId` you
  already have, so leave those values alone; `fetchEvents({query})` returns
  outcomes carrying both a readable handle (`outcome`) and that raw id. Note
  `fetchEvents` must be scoped by query/queries/tags/eventId/slug. Only on a
  crypto venue do you need a unified symbol — call `loadMarkets()` and read the
  real keys, never guess one.
- Rewrite response handling for CCXT's shapes: order-book levels are
  `[price, amount]` arrays, OHLCV rows are `[timestamp, open, high, low, close, volume]`
  arrays, and `fetchBalance()` returns a dict keyed by currency code with
  free/used/total.
- Convert any pmxt callback-style `watch*` subscription into CCXT Pro's
  await-in-a-loop pattern, and make sure `close()` is called on shutdown.
- Remove the pmxt hosted-session plumbing (`pmxtApiKey`, `getAuthNonce`,
  `loginWithSignature`, `logout`). CCXT talks to the venue directly and signs
  every request from the credentials on the exchange instance.
- Swap the dependency: remove `pmxtjs`/`pmxt`, add `ccxt` (>= 4.5.77 if
  you need the prediction namespace).

Explain the plan in plain language before making broad changes. Follow the
documented mapping and keep moving unless a change is destructive, credentials
are missing, or the correct migration is genuinely ambiguous — then ask me.

Then review the whole diff adversarially, assuming a regression is in there.
Every touched call site can now do something different and still compile. pmxt
called its hosted API and CCXT calls the venue directly, so the literal requests
will differ — what must match is the intent of each call: same instrument, same
time window, same limit, same order side/amount/price, same account. Check
specifically for: `fetchOHLCV`'s `since`/`limit` swap and a dropped `end`;
price scale (only when the target is a crypto venue — prediction venues keep the
0–1 scale, so thresholds carry over untouched); array-vs-object response
shapes failing silently; `createOrder` positional slots and amount units;
options the codemod reported as dropped; error classes whose hierarchy changed;
and `fetchBalance`/`fetchPositions` call sites that used to take a per-address
argument and now always return the same account. Set `exchange.verbose = true`
and read what actually goes out on the wire rather than reasoning about it. If
the project has tests, they should pass unchanged — a test you edited to make
green is a behaviour change, and you need to tell me about it.

Verify before you claim it works: type-check or lint the project, run its tests,
then smoke-test against a live *public* endpoint (`fetchTicker`, `fetchOrderBook`)
with no API keys involved. Never place a live order to verify a migration.

Finish with a summary of what changed, what you verified, every regression the
review turned up and how you resolved it, and every call site that still has no
CCXT equivalent.
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
right flavour per file — `ccxt.prediction` for prediction venues, plain `ccxt`,
`ccxt.pro` when the file subscribes to a stream, or `ccxt.async_support` for async
Python.

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

- **crypto-venue symbols** — moving to a crypto exchange, it cannot know which unified
  symbol a CLOB token id should become (prediction venues keep the id, so nothing to guess)
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

**On prediction venues, your `outcomeId` values keep working.** CCXT addresses an outcome
by a readable handle like `TRUMP_ACQUIRE_GREENLAND_2027:YES`, and also accepts the raw
outcome id — the same CLOB token id pmxt gave you. Both return the identical book:

```javascript
const exchange = new ccxt.prediction.polymarket ();
const events = await exchange.fetchEvents ({ 'query': 'Trump' });   // must be scoped
const outcome = events[0]['markets'][0]['outcomes'][0];
await exchange.fetchOrderBook (outcome['outcome']);     // the handle
await exchange.fetchOrderBook (outcome['outcomeId']);   // the raw id — also accepted
```

`fetchEvents` must be scoped by at least one of `query`, `queries`, `tags`, `eventId` or
`slug`, otherwise it throws `ArgumentsRequired`. For an unscoped browse use `fetchMarkets()`.

**On crypto venues** — the `GeminiTitan` → `gemini` case — there is no outcome id, and you
need a **unified symbol**: `'BTC/USDT'` for spot, `'BTC/USDC:USDC'` for a linear swap.
Load the real ones rather than guessing:

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
| Prices | `0.0`–`1.0` probability | prediction venues: **also `0.0`–`1.0` per share**. Crypto venues: quote-currency, unbounded |

That last row only bites when you move to a *crypto* venue: there, anything assuming a
0–1 range — percentage formatting, implied probability, spread thresholds, position
sizing — is wrong after the migration and will not raise an error. Prediction-to-
prediction keeps the scale, so that code is untouched.

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

`Router`, `fetchArbitrage`, `fetchMatches`, `compareMarketPrices`, `fetchHedges`;
`firehose`; the escrow and SQL helpers.

The event model is **no longer** on this list: `fetchEvents` and `fetchEvent` are real
CCXT methods, `fetchEvents({ tags })` stands in for `fetchSeries`, and `fetchTradeQuote`
covers `getExecutionPrice` on AMM venues (on CLOB venues, walk the order book yourself).

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

## Check for regressions

The migration is only done if the code still does the same thing, and every call site the
codemod touched can now behave differently **and still compile**. Read the diff once
assuming a regression is in it.

pmxt calls its hosted API and CCXT calls the venue directly, so the literal HTTP requests
will never match — that is expected, not a bug. What must match is the *intent* of each
call: same instrument, same time window, same limit, same order side/amount/price, same
account.

These are the ones that compile:

| Regression | How to catch it |
|---|---|
| **Wrong time window** — `fetchOHLCV`'s `limit` and start time swap position, and pmxt's `end` has no slot | Is `since` a millisecond integer, not a `Date`? Did `end` become `params['until']` or vanish? |
| **Price scale** — *crypto targets only.* `ccxt.prediction.*` keeps the `0.0`–`1.0` scale; a crypto venue changes it to quote-currency | Only when the target is a crypto exchange: every threshold, spread check, percentage format and position-size calculation downstream of a price is suspect |
| **Response shape** — `book.bids[0].price` → `book['bids'][0][0]` | Arithmetic on an array throws, but truthiness checks and string interpolation fail silently |
| **Order semantics** — `createOrder({...})` → positional `(outcome, type, side, amount, price)` | Did `type` and `side` swap? On prediction venues `amount` is shares and `price` stays 0..1; on crypto venues check `market['contractSize']` |
| **Dropped arguments** — `loadMarkets()` takes no filters | Every drop is listed in `MIGRATION-REPORT.md`; re-implement client-side if the code needed it |
| **Error hierarchy** — `MarketNotFound` → `BadSymbol`, `PmxtError` → `ExchangeError` | A broad catch that used to swallow everything may now let a different error through |
| **Account identity** — `fetchBalance(address)` → credentials on the instance | Code that queried several addresses now returns the same account from all of those call sites |
| **Request pacing** — CCXT enables `enableRateLimit` by default | Code relying on pmxt's aggregated pacing may hit a venue limit the hosted layer absorbed |

Then look at the wire instead of reasoning about it. `exchange.verbose = true` (or
`--verbose` in [ccxt-cli](ccxt-cli.md)) prints every outbound request and raw response;
run the migrated path and check the market id, window, limit and order fields against
what the pmxt version was asking for.

If the project has tests, they should pass **unchanged**. A test you had to edit to make
it green is a behaviour change — possibly the right one, but never a silent one.

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
- pmxt's own documentation, for the source side of the migration:
  [github.com/pmxt-dev/pmxt](https://github.com/pmxt-dev/pmxt#readme) and
  [www.pmxt.dev/docs](https://www.pmxt.dev/docs)
