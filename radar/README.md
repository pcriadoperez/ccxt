# CCXT Radar

A free Telegram bot that watches the major crypto exchanges through [CCXT](https://github.com/ccxt/ccxt) and sends the alerts you set up, by tapping buttons or by describing them in plain language, plus one short Daily Brief with the news and the numbers. Every alert has a **Reproduce with CCXT** button that returns the code that fetches the same data.

It never asks for API keys, never trades and never moves funds.

## Run it in 5 minutes

1. **Create a bot**: open [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. **Optional, for the AI assistant**: create a free key at [openrouter.ai/keys](https://openrouter.ai/keys). The bot uses OpenRouter's free router (`openrouter/free`) by default.
3. **Install and start** (Node 22.13 or newer):

```bash
cd radar
```

```bash
npm install
```

```bash
cp .env.example .env    # then put TELEGRAM_BOT_TOKEN (and OPENROUTER_API_KEY) in .env
```

```bash
npm start
```

4. Open your bot in Telegram and send `/start`.

Host it in the EU or Asia: **Binance and Bybit block US IP addresses**. The bot keeps working on the other venues if some are unreachable and reports them on `/status`.

With Docker:

```bash
docker build -t ccxt-radar radar
```

```bash
docker run -d --name radar --env-file radar/.env -v radar-data:/data ccxt-radar
```

## What to try

| Try | Expect |
|---|---|
| `/start` | Onboarding: pick what to follow, coins, loudness, your local time, Daily Brief time. Rules are created for you. |
| `btc > 100k` (no slash needed) | A confirmation card with the current price and a 30-day backtest. Nothing is saved until you tap **Save**. |
| `sol 5% 4h`, `eth -10% from 3400`, `funding eth > 0.1% bybit`, `funding any`, `gap btc 20%`, `settle btc`, `oi btc 8% 1h`, `listings binance upbit`, `wallet usdt`, `status`, `depeg` | One card per alert type. Add a venue, `perp`, `mark`, `once` or `repeat`. |
| "ping me if ETH funding on Bybit goes crazy" | AI turns it into the same card, listing what it assumed. Needs `OPENROUTER_API_KEY`. |
| "where is SOL cheapest right now?" | AI answer built only from the bot's data; any number not in the data replaces the answer with the plain data view. |
| "should I buy ETH?" | A fixed refusal: the bot describes, never recommends. |
| `/p eth`, `/funding btc`, `/status`, `/listings`, `/wallet usdt` | Lookups from shared state (no extra exchange calls). |
| On an alert: **Reproduce with CCXT** · **Why might this be?** · **Mute 4h** · **Looks wrong** | Python/JS/Go/CLI snippet · short AI note from data and headlines · per-rule mute · report. |
| `/brief now`, `/brief 08:00`, `/quiet 23-07`, `/budget 20`, `/pause 8h`, `/breaking`, `/tz Europe/Madrid`, `/watch add sol`, `/list`, `/code`, `/forget` | Settings and data controls. |
| Add the bot to a group, then `/setup` as an admin | Presets (majors moves, listings, funding extremes, outages, Daily Brief) and a post cap. Members use `/p`, `/funding`, `/status`, `/ask`. |

Alerts fire on **crossings**: a rule whose condition is already true when you save it waits for the value to move back and cross again. Move rules need history, which builds up while the bot runs (up to the rule's window).

## Tests

```bash
npm test          # 69 unit + integration tests, offline (fake Telegram API, fake AI, fake markets)
```

```bash
npm run smoke     # live: polls the real exchanges once and prints prices, funding, wallets, news and a Brief
```

```bash
npm run typecheck
```

## How it works

```
ts/main.ts            wiring; headless mode (prints alerts) when TELEGRAM_BOT_TOKEN is unset
ts/market/ingest.ts   one CCXT instance per venue: bulk fetchTickers (10s), fetchFundingRates (60s),
                      open interest (60s), fetchCurrencies (5m), fetchStatus (1m), loadMarkets diff (90s/3m)
ts/market/state.ts    shared in-memory state: tickers, funding (normalized to 8h and APR), rolling windows,
                      medians, symbol resolution incl. 1000PEPE / kPEPE style multipliers
ts/market/trackers.ts listing and wallet change detection with confirmations and partial-response guard
ts/engine.ts          evaluates every rule on shared data: crossing, re-arm margin, cooldown, freshness,
                      degraded-venue muting, global monitors (big moves), event fan-out with dedupe
ts/delivery.ts        priority queues, TTL, quiet hours, daily budget (excess goes to the Brief), merging,
                      25 msg/s global, 1/s per chat, 20/min per group, 429 backoff, 403 = blocked
ts/bot.ts             grammY bot: onboarding, confirmation cards, /list, buttons, groups, AI chat
ts/ai/                OpenRouter client, assistant (intent → validated rule; grounded answers), number check
ts/news.ts            publisher RSS (CoinDesk, Cointelegraph, The Block, Decrypt), clustering, exploit
                      detection (2+ publishers)
ts/calendar.ts        FOMC dates (Federal Reserve) and CPI/jobs releases (BLS iCal)
ts/views.ts           lookups, Daily Brief, data objects for the AI
ts/channels.ts        optional public channels (listings, movers, funding, status, brief)
ts/db.ts              SQLite (node:sqlite) storage with the spec's retention rules
```

Users never trigger exchange calls (except the one cached historical request behind a card's backtest), so cost grows with venues and markets, not with users.

## Differences from the product spec (this test build)

- **Storage**: SQLite in one process instead of Postgres + Redis. Fine for testing and small deployments; the module boundaries match the spec.
- **Data**: REST polling (bulk tickers every 10s) instead of WebSocket streams for the top markets. Price alerts land within ~10–20s instead of ≤5s.
- **Not included**: `/arb` (moved to a later phase), Telegram Mini App, languages other than English, the public status page, Grafana metrics.
- **AI**: OpenRouter free router via JSON mode, without tool calling (free models are inconsistent with tools). The bot gathers the data first and checks every number in the answer against it.
- **Groups**: the post cap is enforced as a daily budget (cap × 24), not per hour.

## Safety

- One official handle; `/about` and `/start` warn about clones.
- No user keys of any kind. Optional project keys must be read-only.
- `/forget` deletes a user immediately. Deliveries are kept 30 days, AI transcripts 7 days.
- Every alert names its source venue and the CCXT method; data age is shown; degraded venues are muted, not trusted.
