# exchange-changelogs

A daily job that collects the API changelogs of the exchanges and prediction markets ccxt
supports, stores them as entries, and publishes the feeds rendered at
<https://docs.ccxt.com/docs/changelog-exchanges>.

It is deterministic: plain HTTP fetches and per-source adapters (RSS, Markdown, HTML, JSON,
page hash), no browser and no LLM. Everything fetched is untrusted text: it is reduced to
plain text / light markdown, links are restricted to each venue's domains, and AI-agent
footers (GitBook "Agent Instructions") are stripped.

This directory is self-contained (its own `package.json` and lockfile) and is not part of the
ccxt build or transpilers.

```
exchange-changelogs/
  collector/            TypeScript collector (Node >= 22, run with tsx)
    src/                collect.ts, build-feed.ts, adapters/, mappers/, types.ts (shared contract)
    spec/               offline specs + fixtures saved from real pages
  registry/             one JSON per venue: exchange/<id>.json, prediction/<id>.json (see registry/README.md)
  data/                 gitignored here; lives on the "changelog-data" branch
```

## Run it

```bash
cd exchange-changelogs/collector
npm ci
npm run run -- --venue bybit          # collect + build-feed for one venue (every kind with that id)
npm run run -- --venue prediction/binance   # one venue of one kind
npm run run                           # everything
npm run collect -- --source okx-log   # one source, no feed
npm run build-feed                    # rebuild data/feed/ from data/entries/
npm run spec && npm run typecheck     # offline specs
```

Options (all commands): `--venue a,b` (`id` or `kind/id`), `--source x,y`, `--data <dir>` (default
`exchange-changelogs/data`), `--registry <dir>` (default `exchange-changelogs/registry`).
`collect` prints a per-source table (status, entries, new, revised, removed, latest date,
error). It exits 0 even when sources fail (health records it) and 1 on registry errors.

Fetching is polite: User-Agent `ccxt-changelog-bot/1.0 (+https://github.com/ccxt/ccxt)`,
at most 2 concurrent requests per host and 8 overall, 30 s timeout, 2 retries with backoff,
`Retry-After` honored, conditional GET with the stored ETag / Last-Modified (304 = unchanged).
Validators are only sent while the source's registry entry and the collector's `PARSER_VERSION`
(`collector/src/collect.ts`) are the same as on the run that stored them, so a url, filter or
selector fix is applied on the next run; bump `PARSER_VERSION` when a parser change should
re-parse every source. Month-partitioned sources (`{yyyy}`/`{mm}` in `url`, `months`, default 2)
fetch one file per month without conditional GET; `discover` sources first fetch an index page to
find the current url (for hashed bundle names) and send validators only when that url did not
change. Bot-challenge markers fail a source on error statuses; a 2xx page only fails on
interstitial markers (e.g. `gokuProps`, `_cf_chl_opt`) and only when it is under 20 KB.

## Data layout (`data/`)

| Path | Content |
|---|---|
| `state/sources/<sourceId>.json` | ETag, Last-Modified, `configHash` (registry entry the validators belong to), content hash, run counters, ids of the last run, missing-run counters, health; `resolvedUrl` (discover) and `months` (ids per fetched month) |
| `snapshots/<sourceId>.txt` | normalized text of the last successful fetch (hash input, handy for debugging selectors) |
| `entries/<kind>/<venueId>.jsonl` | every entry ever seen for the venue (`ChangelogEntry`, full bodies), merged by id |
| `feed/latest.json` | `LatestFeed`: 90-day window, no bodies, newest first, at most 1.5 MB (oldest trimmed) |
| `feed/<kind>/<venueId>.json` | `VenueFeed`: last 365 days with bodies and revisions, including entries of other venues' sources shared with it (`sharedWith`); undated backfill entries and `removedAt` entries are left out, as in `latest.json`; at most 1.5 MB (oldest trimmed) |
| `feed/health.json` | `HealthFeed`: one row per registry source |
| `feed/sources.json` | registry summary for the UI (venues, domains, sources, links) |

Entry ids are `sha256("<sourceId>|<guid>")`, or `sha256("<sourceId>|<date>|<normalized title>")`
without a guid, where `date` comes from the configured place (title, anchor, pubDate, context)
but never from the body, so a body edit is a revision rather than a new id. When several entries
of one run share a key, the bottom-most keeps it and the others get `|b:<hash of the first 200
body characters>` (a position suffix, counted from the bottom, only for identical bodies), so a
new item on top of a newest-first page never takes over an older item's id. HTX and BingX guids
leave out the summary text for the same reason. Hash sources (`Docs changed: …`) are always
`dateKind: firstSeen`: dates inside the added lines are not the change date. A changed body
adds a `revisions[]` item; an id missing for 3 successful runs gets `removedAt`. For `rss`
sources only items dated after the oldest item still in the feed can go missing (feeds carry
the newest N items; rolling off the end is not a deletion). The first successful run of a
source marks everything `backfill`, as does the mass-new guard (> 25 new ids in a later run),
which also gives the absent ids they replace `removedAt` right away. Feeds are sorted by
`coalesce(effectiveDate, publishedAt, firstSeen)`, newest first. Venues are keyed by
kind + id everywhere (`exchange/binance` and `prediction/binance` are separate feed files);
`VenueSummary` carries the venue's registry `domains`, and its `sources`/`healthy` counts
include shared sources. Entries of sources no longer in the registry are left out of the
feeds. All shapes are in
[`collector/src/types.ts`](collector/src/types.ts) (`SCHEMA_VERSION` 1).

Rule tags (`collector/src/tags.ts`): `deprecation`, `breaking`, `new-endpoint`, `rate-limit`,
`websocket`, `auth`, `maintenance`, `param-change`, `market`, plus `link-rewritten` when an
entry link was replaced by the source link. `breaking` and `deprecation` ignore negated
phrasings ("No removed endpoints", "no breaking changes", "not removed", "non-breaking",
"no existing fields are modified or removed"; not across a sentence end or a "but"). `market`
means a listing change (new markets/symbols/contracts, listings, delistings), not a mention of
perpetuals, contracts or market data.

## How docs.ccxt.com consumes it

The docs site fetches `feed/latest.json` (and `feed/<kind>/<id>.json` when one venue is
selected) from the raw URL of the `changelog-data` branch with ISR
(`revalidate: 3600`, tag `exchange-changelogs`), validates it against the same schema and
renders text only (no HTML from entries; links pass a `safeHref()` check against the venue's
`domains` from `VenueSummary`, keyed by kind + id, falling back to the source-link domain for older
feeds except on shared hosts such as raw.githubusercontent.com; with no domain the entry links to
its source page). Venue filters accept `id` (every kind) or `kind/id`; `?exchange=<id>&full=1`
merges both kinds' files for an id that exists under both. After each run the workflow calls `POST https://docs.ccxt.com/api/revalidate/changelog` with the
`DOCS_REVALIDATE_SECRET` and makes one warm-up GET of the page.

## Production

`.github/workflows/exchange-changelogs.yml` runs daily at 05:23 UTC (and on
`workflow_dispatch` with `venue` / `dry_run` inputs), only on `ccxt/ccxt`:

1. job `collect` (read-only token): checks out the orphan branch `changelog-data` as a worktree
   at `exchange-changelogs/data` (created on the first run), runs `npm ci && npm run run` in
   `collector/` and uploads `data/` as an artifact;
2. job `publish` (the only job with `contents: write`; runs no npm and no repository code):
   checks out `changelog-data` into a fresh repo, replaces its tree with the artifact and commits
   it as `[Automated changes] changelog data <date>` with hooks disabled (the language CI
   workflows ignore `[Automated changes]` commits, and nothing lands on master);
3. waits ~5 minutes (raw.githubusercontent.com caches the branch for about 300 s) and
   revalidates docs.ccxt.com.

The data can move to its own repository (`ccxt/exchange-changelogs`) later without code
changes: only the checkout/push steps and the docs data URL change. That move is worth doing
once the history grows: a default `git clone` of ccxt/ccxt fetches every branch head, so the
daily snapshots and entries reach every contributor clone (until then, squash the branch
yearly).

## Adding or fixing a source

1. Edit or add `registry/<kind>/<id>.json` (field reference: [registry/README.md](registry/README.md)).
2. `npm run run -- --venue <id> --data /tmp/changelog-scratch` and check the table,
   `data/snapshots/<sourceId>.txt` and `data/feed/<kind>/<id>.json`.
3. For a new adapter behaviour, save a trimmed real page under `collector/spec/fixtures/`
   and add a spec next to the existing ones.
