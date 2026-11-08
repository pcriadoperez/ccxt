# Changelog source registry

One JSON file per venue: `registry/exchange/<id>.json` or `registry/prediction/<id>.json`.
The file name must equal `id`, and `kind` must match the directory. A venue is identified by
kind + id: `exchange/binance.json` and `prediction/binance.json` are two venues (each with its own
entries and feed file); source ids stay globally unique. The shape is
`VenueConfig` / `SourceConfig` in [`../collector/src/types.ts`](../collector/src/types.ts);
the collector validates every file on each run (`src/registry.ts`) and refuses to run on
any error, including unknown fields, so typos fail loudly.

Check a file without fetching anything:

```bash
cd exchange-changelogs/collector
npm run collect -- --venue bybit --data /tmp/changelog-scratch   # validates the whole registry first
```

`--venue` takes `id` (every kind with that id) or `kind/id` (`--venue prediction/binance`).

## Venue fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | ccxt id (`bybit`; prediction venues: the id under `ts/src/prediction/`). Lowercase letters/digits. |
| `kind` | yes | `exchange` or `prediction` (must match the directory). |
| `name` | yes | Display name (`"Bybit"`). |
| `subclasses` | no | ccxt ids that inherit this venue's changes (`["bybiteu", "bybitid"]`). They are added to each entry's `affects`. |
| `domains` | yes | Hostnames entry links may point to, no scheme (`["bybit.com", "bybit-exchange.github.io"]`). A domain also allows its subdomains. Entry links outside these domains, or not `https:`, are replaced by the source link (tag `link-rewritten`). The host of each source's `link ?? url` must be listed. |
| `sources` | yes | Array of sources (may be empty for a venue with nothing to watch yet). |

## Source fields

| Field | Types | Meaning |
|---|---|---|
| `id` | all | Globally unique, `<venue>-<slug>` (`bybit-v5`, `okx-log`). Never rename: it is part of every entry id. |
| `type` | all | `rss`, `md`, `html`, `json` or `hash` (see below). |
| `url` | all | What is fetched. https only. For GitHub files use `raw.githubusercontent.com`. May contain `{yyyy}` and `{mm}` (UTC year/month) for month-partitioned changelogs (see `months`). |
| `link` | all | Human-facing page (defaults to `url`). Entry anchors are appended to it. Must be on a venue domain. Same `{yyyy}`/`{mm}` placeholders. |
| `months` | all | With `{yyyy}`/`{mm}` in `url`: how many months to fetch, the current UTC month and the `months - 1` before it (default 2, max 12; with `months: 1` the 404 current month on the 1st is an empty run, not drift). The files are parsed newest first and combined; each entry links to its own month's `link`. A 404 for the current month counts as empty (the new file may not exist yet on the 1st); any other failure fails the source. No conditional GET. A month leaving the window never marks its entries removed (only ids of the fetched months are tracked), and the drift check compares against the previous run's entries of the months still fetched. Bitget: `"url": ".../changelog/{yyyy}-{mm}.md", "months": 2`. |
| `discover` | all | `{ "url": ..., "pattern": ... }` for files whose name changes per deploy (hashed JS bundles). The collector fetches `discover.url`, takes the first capture group of `pattern` (absolute or relative to `discover.url`) and fetches that instead of `url`; `url` then only records the last known value. Validators (ETag) are sent only when the discovered url is the same as last run. Pattern not found = failure. BingX: `"discover": { "url": "https://bingx-api.github.io/docs-v3/", "pattern": "src=[\"']?(\\./static/js/app\\.[0-9a-f]+\\.js)" }`. |
| `role` | all | `primary` (default) or `secondary` (testnet changelogs, help-center announcements, blogs). |
| `scope` | all | Free text shown in the UI: `spot`, `derivatives`, `websocket`, `all` ... |
| `headers` | all | Extra request headers, e.g. `{ "Accept-Language": "en-US" }`. |
| `sharedWith` | all | Other venues this changelog also covers (`kraken` source with `["krakenfutures"]`): `"id"` (resolved in the source's own kind first, then the other kind) or `"kind/id"` (`"exchange/hyperliquid"`). They and their subclasses go into `affects`, the entries also appear in their per-venue feed files, and the source counts in their `sources`/`healthy` summary. Must exist in the registry and not be the venue itself. |
| `expectBlocked` | all | Known reason the source cannot be fetched from a datacenter (Cloudflare, geo-block). Still attempted; shown as degraded, not alerted. |
| `slice.from` / `slice.to` | md | Regexes matched against whole lines: content starts at the first `from` line (inclusive) and ends before the first `to` line after it. `from` not found = parse failure. |
| `slice.selector` | html, hash | CSS selector of the container holding the changelog (first match). Not found = parse failure. Default: `body`. |
| `split.heading` | md | Regex tested against ATX heading lines (`"^##\\s+\\d{4}-\\d{2}-\\d{2}"`). Default `"^##\\s+"`. Every matching heading starts an entry that runs until the next matching heading or the next heading with fewer `#`. Non-matching deeper headings (`### REST API`) stay in the body. Headings inside code fences (also fences opened inside list items, `  - ```json`) are ignored. Anchors are GitHub-style slugs, unique per file (`rest`, `rest-1`, `rest-2`). Front matter, `import`/`export` lines and JSX tags are dropped; links become their text. |
| `split.heading` | html | CSS selector list of entry headings (`"h2"`, `"h2, h3"`). Default `"h2"`. Entry = heading + following siblings until the next matching element or any real heading `h1`-`h6` of the same or higher level. The split element may be a non-heading (`"p:has(> strong:only-child)"`, `"p > strong"`): ordinary siblings (`p`, `ul`, `table` ...) stay in the entry and any real heading ends it; an inline match (`strong`, `b`, `span` ...) stands for its block (the rest of that block is the start of the body). Heading `id` (or the id/anchor inside it) becomes the entry anchor. |
| `split.item` | html | CSS selector for row-style changelogs (`"table tr:has(td)"`, `".release-card"`). Each match is one entry; title = first `h1-h6/strong/b` inside it (left out of the body, with a ` - ` separator right after an inline title), else the first line of its text. Use `heading` or `item`, not both. |
| `date.from` | all | Where the entry date lives: `title`, `body`, `pubDate` (rss/json `dateText`) or `anchor` (heading id). Default: rss `pubDate`; others try `dateText` → title → enclosing higher-level heading → anchor → body. With an explicit `from`, only that place (then the enclosing heading) is used. A date read from the body dates the entry but is not part of its id (a body edit is a revision). Hash sources are never dated. |
| `date.pattern` | all | Regex with one capture group holding the date text, applied to the `from` text (`"^(\\d{4}-\\d{2}-\\d{2})"` on OKX anchors). A future date read with a pattern is the entry's `effectiveDate` even when the body names an earlier effective date (Bitget preview: `live trading expected on <date>` wins over `Effective date: demo trading on <date>`). |
| `date.order` | all | `ymd`, `mdy` or `dmy`: disambiguates numeric dates like `03/04/2026`. Default: `/` = mdy, `.` and `-` = dmy; impossible readings (day > 12) are fixed automatically. |
| `titleFilter` | all | Regex (case-insensitive): keep only entries whose title (or an rss `<category>`) matches. |
| `excludeFilter` | all | Regex (case-insensitive): drop entries whose title matches. |
| `mapper` | json | File name in `collector/src/mappers/` (without `.ts`). Required for json. The body does not have to be JSON (see below). |
| `strip` | html, hash | CSS selectors removed before extraction (`script`, `style`, `nav`, `noscript`, `template`, `iframe`, `svg` are always removed). |
| `minEntries` | all | Fewer parsed entries than this = "parser drift" failure. Default 1 (hash: 0). |

Dates understood: ISO (`2026-11-05`, with or without time), `2026/11/05`, `2026.11.05`, mixed
separators (`2026.05-12`), `2026-OCT-01` / `2026-Mar-9`, `05.11.2026`, `11/05/2026`,
`Nov 5, 2026`, `5 Nov 2026`, `November 5th, 2026`, `2026年11月5日`, RFC 822 pubDates. Years
outside 2015..next year are ignored. A date after today becomes `effectiveDate` (scheduled
change). Phrases followed closely by a date set `effectiveDate` too: "Effective date:",
"Effective Time:", "Effective <date>", "effective from", "will take effect on",
"Release <date>", "go live on", "will be deprecated/removed/retired on", Korean
"적용 예정일" / "적용 일시" / "시행", Chinese "生效时间" / "生效日期". For rss sources, a
dated link fragment that differs from pubDate (Kalshi `#november-12-2026`) is the
`effectiveDate`; the fragment is also the entry anchor.

Titles are plain text: HTML, markdown emphasis (`**`, `*`, `__`, backticks), blockquote/alert
markers (`> [!WARNING]`) and zero-width characters are removed. Titles that are only a date or
a version (`## 2026-11-05`) are displayed as `2026-11-05: <summary>`, cut at a word boundary
around 140 characters; the id still uses the raw heading. The summary is a short heading-like
first paragraph before any list (Deribit: "Delayed publication of large Block RFQ trades"; not a
sentence, a `Label:` line or a bare date), else the first top-level list item that is not a
rollout schedule line (`Testnet: <date>`, `Mainnet: <date>`), wrapped lines joined, else the
first paragraph. Excerpts drop letter openings ("Dear developers, this is the ... team.",
"안녕하세요. ...입니다."). `---` separator lines are dropped from bodies
and excerpts.

## Examples per type

### rss (RSS 2.0, RDF or Atom)

```json
{
    "id": "kalshi",
    "kind": "prediction",
    "name": "Kalshi",
    "domains": ["kalshi.com"],
    "sources": [
        { "id": "kalshi-changelog", "type": "rss", "url": "https://docs.kalshi.com/changelog/rss.xml", "link": "https://docs.kalshi.com/changelog" }
    ]
}
```

Blog feeds that mix announcements with API changes: add `"titleFilter": "API|Change ?Log"`
and `"role": "secondary"`. The item `guid` (Atom `id`) is the stable entry key.

### md (GitHub CHANGELOG.md, Docusaurus .mdx, docs `.md` exports)

```json
{
    "id": "bybit-v5",
    "type": "md",
    "url": "https://raw.githubusercontent.com/bybit-exchange/docs/master/docs/changelog/v5.mdx",
    "link": "https://bybit-exchange.github.io/docs/changelog/v5",
    "split": { "heading": "^##\\s+\\d{4}-\\d{2}-\\d{2}" }
}
```

Only part of a file: `"slice": { "from": "^## Changelog", "to": "^## Appendix" }`.
Entries are anchored with a GitHub/Docusaurus slug of the heading (`#2026-11-05`).

### html (server-rendered pages: Slate, ReadMe, Mintlify, GitBook ...)

```json
{
    "id": "okx-log",
    "type": "html",
    "url": "https://www.okx.com/docs-v5/log_en/",
    "slice": { "selector": ".content" },
    "split": { "heading": "h2" }
}
```

On OKX (Slate) each `h1` is a date and each `h2` a change: the `h1` above an `h2` dates it.
`"date": { "from": "anchor", "pattern": "^(\\d{4}-\\d{2}-\\d{2})" }` would read the date from
ids like `2026-10-27-new-bbo-...` instead, but leaves the "Upcoming Changes" entries undated.
Tables or cards: `"split": { "item": "table tbody tr" }`.
Client-side rendered pages (empty `<body>` without JavaScript) do not work: look for an RSS
feed, a `.md` export (`<page>.md`, `llms.txt`), the GitHub source, or fall back to `hash`.

### json (APIs)

```json
{
    "id": "htx-updates",
    "type": "json",
    "url": "https://www.htx.com/oplt/api/open_api/update_record?pageNum=1&pageSize=10000",
    "headers": { "Accept-Language": "en-us" },
    "mapper": "htx"
}
```

A mapper is `export default function (data: unknown, raw: string, ctx: MapperContext): RawEntry[]`
in `collector/src/mappers/<name>.ts` (see `htx.ts`). `data` is the parsed JSON, or `undefined`
when the body is not JSON (a JS bundle, CSV ...: parse `raw` then, as `bingx.ts` does);
`ctx` is `{ source, url, now }`. It is loaded by name; no registration needed.
Return `dateText` (raw date string) and a stable `guid` when the API has one.

### hash (no changelog: watch the page itself)

```json
{
    "id": "bit2c-api",
    "type": "hash",
    "url": "https://bit2c.co.il/home/api",
    "slice": { "selector": "main" },
    "strip": ["#server_timestamp_clock", ".cookie-banner"]
}
```

The first run stores a snapshot. Afterwards each change of the normalized text that adds or
removes lines produces one "Docs changed: <scope, else the link path>" entry
(`dateKind: firstSeen`) listing the added lines; a pure reordering produces nothing. Give each
hash source a short `scope` so these titles tell pages apart. ISO
timestamps, clock times, unix times, long hex ids and csrf/nonce tokens are ignored; add
`strip` selectors for anything else that changes on every request.

## Failure rules (per source, recorded in `feed/health.json`)

- HTTP error, timeout, challenge/WAF page (202 empty body, 403, 451, 429, Cloudflare/Akamai/AWS
  WAF/Imperva markers) → failure; previous data is kept.
- Parse error (bad feed, `slice.from`/`slice.selector` not found, mapper error) → failure.
- `discover` pattern not found, or a 404 for any month but the current one → failure.
- Fewer than `minEntries` entries, or fewer than half of the previous run's count → "parser drift" failure.
- First successful run of a source: all entries are `backfill: true`. Later, more than 25 new
  ids in one run are also marked backfill (a re-keyed parser, not 25 real changes).
- An id absent for 3 consecutive successful runs gets `removedAt` (never deleted).
- Entries of a source that was deleted from the registry (or of a deleted venue) are kept in
  `data/entries/` but left out of every feed file.
