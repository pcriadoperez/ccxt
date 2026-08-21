# ccxt-migrate

Codemod and AI-agent handoff for moving a project from [pmxt](https://github.com/pmxt-dev/pmxt)
(`pmxtjs` / `pmxt`) to [CCXT](https://github.com/ccxt/ccxt).

Full guide: **https://github.com/ccxt/ccxt/blob/master/wiki/Migrate-From-PMXT.md**

```bash
npx ccxt-migrate@latest
```

Scans the current directory, prints a plan, asks before writing. Commit or stash first.

```bash
npx ccxt-migrate@latest src tests          # only these paths
npx ccxt-migrate@latest --dry-run          # preview the diff, write nothing
npx ccxt-migrate@latest --yes              # skip the confirmation
npx ccxt-migrate@latest --report OUT.md    # where to write the report
npx ccxt-migrate@latest prompt             # print the AI-agent prompt
npx ccxt-migrate@latest rules              # print the full mapping tables
```

## Both languages, one command

`.ts` `.tsx` `.js` `.mjs` `.cjs` files are migrated to CCXT for TypeScript/JavaScript,
`.py` files to CCXT for Python. It picks the right flavour per file: plain `ccxt`,
`ccxt.pro` when the file subscribes to a stream, `ccxt.async_support` for async Python.

## What it does

- rewrites `pmxtjs` / `pmxt` imports to `ccxt`
- maps venue classes to CCXT exchange ids and converts constructor options
  (Python keyword arguments become CCXT's config dict)
- drops `pmxtApiKey` — CCXT talks to the venue directly, there is no hosted API
- renames methods (`fetchAllOrders` → `fetchOrders`, `unwatchOrderBook` → `unWatchOrderBook`, …)
- reorders arguments where signatures differ, including `fetchOHLCV`'s `since`/`limit`
  swap and `createOrder`'s object-to-positional change
- maps error classes (`MarketNotFound` → `BadSymbol`, `PmxtError` → `ExchangeError`, …)
- writes a `MIGRATION-REPORT.md` covering every change and every gap

## What it deliberately does not do

pmxt is a prediction-market aggregator; CCXT is a spot and derivatives library. Only
`Hyperliquid` and `GeminiTitan` exist in both, and even there the product surface differs.
For anything else the codemod leaves the `pmxtjs` import in place — so your project still
compiles — and reports the call sites instead of emitting code that cannot work.

It also leaves a `TODO(ccxt-migrate)` marker rather than guessing at:

- **unified symbols** — it cannot know a CLOB token id should become `'BTC/USDC:USDC'`
- **response shapes** — CCXT returns plain dicts and arrays where pmxt returns typed
  objects, and rewriting field access blindly would silently corrupt working code

Running it twice over the same file is refused, because a second pass would clobber the
`pmxtjs` imports it kept on purpose.

## After running it

```bash
grep -rn "TODO(ccxt-migrate)" .
npm uninstall pmxtjs && npm install ccxt      # TypeScript / JavaScript
pip uninstall pmxt && pip install ccxt        # Python
```

Or hand the rest to an AI agent — `npx ccxt-migrate@latest prompt` prints a ready-to-paste
prompt, and `npx skills add ccxt/ccxt` installs the `ccxt-migrate` skill that teaches an
assistant the whole mapping.

## Development

```bash
npm install
npm run build                    # ts/ -> js/
npm test                         # snapshot tests over test/fixtures
UPDATE_SNAPSHOTS=1 npm test      # refresh the snapshots after a rules change
```

`ts/rules.ts` is the single source of truth for the mapping tables — the codemod, the
`rules` command and the docs all read from it.

## License

MIT
