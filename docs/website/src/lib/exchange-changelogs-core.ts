// Client-safe half of the exchange-changelogs data layer: types, URL-filter parsing,
// filtering, link sanitizing and view shaping. No node APIs and no zod here, so the
// client explorer (components/changelog-explorer.tsx) can import it. The server loader
// (fetch / disk, zod validation) lives in ./exchange-changelogs.ts and re-exports this.
//
// The types mirror exchange-changelogs/collector/src/types.ts (a separate package that
// must not be imported here). Keep them in sync when SCHEMA_VERSION changes.
//
// Everything in a feed was scraped from third-party sites: render it as text only and
// send every link through safeHref().

export const SCHEMA_VERSION = 1 as const;

export type VenueKind = 'exchange' | 'prediction';

export interface FeedEntry {
  schemaVersion: number;
  id: string;
  kind: VenueKind;
  exchange: string;
  affects: string[];
  source: string;
  sourceType: string;
  sourceLink: string;
  scope?: string;
  title: string;
  excerpt: string;
  url: string;
  publishedAt: string | null;
  effectiveDate?: string;
  dateKind: string;
  firstSeen: string;
  lastSeen: string;
  hash: string;
  removedAt?: string;
  backfill: boolean;
  tags: string[];
  ccxt: { status: string; issue?: number; pr?: number };
}

export interface ChangelogEntry extends FeedEntry {
  body?: string;
  revisions?: { at: string; hash: string }[];
}

export interface VenueSummary {
  id: string;
  kind: VenueKind;
  name: string;
  subclasses: string[];
  domains: string[];        // registry domains (hosts entry links may point to); [] in older feeds
  sources: number;
  healthy: number;
  latestDate: string | null;
  entryCount: number;
  unmonitored?: string;     // reason the venue has no monitorable source (no sources, shown muted)
}

export interface LatestFeed {
  schemaVersion: number;
  generatedAt: string;
  windowDays: number;
  entries: FeedEntry[];
  venues: VenueSummary[];
}

export interface VenueFeed {
  schemaVersion: number;
  generatedAt: string;
  venue: VenueSummary;
  entries: ChangelogEntry[];
}

export interface SourceHealth {
  id: string;
  venue: string;
  kind: VenueKind;
  type: string;
  link: string;
  role: 'primary' | 'secondary';
  ok: boolean;
  expectBlocked?: string;
  lastRunAt: string;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  entryCount: number;
  latestDate: string | null;
}

export interface HealthFeed {
  schemaVersion: number;
  generatedAt: string;
  sources: SourceHealth[];
}

export const EMPTY_LATEST: LatestFeed = { schemaVersion: SCHEMA_VERSION, generatedAt: '', windowDays: 0, entries: [], venues: [] };
export const EMPTY_HEALTH: HealthFeed = { schemaVersion: SCHEMA_VERSION, generatedAt: '', sources: [] };

// Tag vocabulary of the collector (src/tags.ts). Unknown tags still render, these are
// just the ones offered as filter chips, in display order.
export const CHANGELOG_TAGS = [
  'deprecation', 'breaking', 'new-endpoint', 'rate-limit', 'websocket', 'auth', 'param-change', 'market', 'maintenance',
] as const;
export const WARNING_TAGS = new Set(['deprecation', 'breaking']);
export const DAY_RANGES = [7, 30, 90] as const;
export const DEFAULT_DAYS = 30;

export const PAGE_PATH = '/docs/changelog-exchanges';
export const JSON_FEED_PATH = '/changelog-exchanges.json';
export const XML_FEED_PATH = '/changelog-exchanges.xml';
export const MD_PATH = '/docs/changelog-exchanges.md';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// filter token: "binance" (every kind with that id) or "prediction/binance" (one venue)
const VENUE_TOKEN_RE = /^(?:(?:exchange|prediction)\/)?[a-z0-9][a-z0-9_-]{0,63}$/;

export function isVenueId(id: string): boolean {
  return ID_RE.test(id);
}

export function isVenueToken(token: string): boolean {
  return VENUE_TOKEN_RE.test(token);
}

// Venues are identified by kind + id: exchange/binance and prediction/binance are two venues.
export function venueKey(kind: VenueKind, id: string): string {
  return `${kind}/${id}`;
}

export function parseVenueToken(token: string): { kind?: VenueKind; id: string } {
  const i = token.indexOf('/');
  return i === -1 ? { id: token } : { kind: token.slice(0, i) as VenueKind, id: token.slice(i + 1) };
}

// Does an entry belong to the venue a filter token names? A bare id matches every kind (and
// entries shared with that id via `affects`); "kind/id" only that kind.
export function matchesVenue(e: Pick<FeedEntry, 'kind' | 'exchange' | 'affects'>, token: string): boolean {
  const { kind, id } = parseVenueToken(token);
  if (kind && e.kind !== kind) return false;
  return e.exchange === id || e.affects.includes(id);
}

// A real calendar day (rejects 2026-13-45 and 2026-02-31).
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

// The day an entry is filed under: coalesce(effectiveDate, publishedAt, firstSeen).
export function entryDate(e: Pick<FeedEntry, 'effectiveDate' | 'publishedAt' | 'firstSeen'>): string {
  if (isIsoDate(e.effectiveDate)) return e.effectiveDate;
  if (isIsoDate(e.publishedAt)) return e.publishedAt;
  const d = typeof e.firstSeen === 'string' ? e.firstSeen.slice(0, 10) : '';
  return isIsoDate(d) ? d : '1970-01-01';
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

// Pass as `domains` to safeHref for links that come from our own registry (source pages).
export const ANY_HOST = 'any' as const;

function hostAllowed(host: string, domains: readonly string[] | typeof ANY_HOST): boolean {
  if (domains === ANY_HOST) return true;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Returns `url` only when it is an absolute https: URL whose host is one of `domains`
 * (or a subdomain of one; an empty list allows nothing, ANY_HOST allows any https host).
 * Anything else (javascript:, data:, http:, relative, off-domain, credentials in the URL)
 * yields `fallback`.
 */
export function safeHref(url: unknown, domains: readonly string[] | typeof ANY_HOST, fallback: string | null = null): string | null {
  if (typeof url !== 'string' || url.length > 2048) return fallback;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return fallback;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return fallback;
  if (!hostAllowed(u.hostname.toLowerCase(), domains === ANY_HOST ? ANY_HOST : domains.map((d) => d.toLowerCase()))) return fallback;
  return u.toString();
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// Registry-ish domain of a trusted link (source pages come from our registry), minus www.
export function baseDomain(url: string | null | undefined): string {
  return hostOf(url).toLowerCase().replace(/^www\./, '');
}

// Hosts that serve many unrelated owners: never derived as a venue's allowed link domain (a
// raw.githubusercontent.com source link must not allow links to any repository).
const SHARED_HOST_RE = /(?:^|\.)(?:githubusercontent\.com|github\.com|github\.io|gitlab\.com|gitlab\.io|gitbook\.io|notion\.site|medium\.com|pypi\.org|npmjs\.com)$/;

export function isSharedHost(host: string): boolean {
  return SHARED_HOST_RE.test(host.toLowerCase());
}

// Docs route for a venue — same rule as build/wiki-to-fumadocs.ts.
export function venueDocPath(kind: VenueKind, id: string): string {
  return kind === 'prediction' ? `/docs/prediction/${id}` : `/docs/exchanges/${id}`;
}

// ---------------------------------------------------------------------------
// filters (shared by the explorer URL state and the .json/.xml/.md routes)
// ---------------------------------------------------------------------------

export interface ChangelogFilter {
  exchanges: string[];
  tags: string[];
  since?: string;
  days?: number;
  status: string[];
  q: string;
  limit?: number;
}

function list(params: URLSearchParams, key: string, re: RegExp): string[] {
  const out = new Set<string>();
  for (const raw of params.getAll(key)) {
    for (const part of raw.split(',')) {
      const v = part.trim().toLowerCase();
      if (v && re.test(v)) out.add(v);
    }
  }
  return [...out].slice(0, 200);
}

function intParam(params: URLSearchParams, key: string, min: number, max: number): number | undefined {
  const raw = params.get(key);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.min(max, Math.max(min, Number(raw)));
}

export function parseFilter(params: URLSearchParams): ChangelogFilter {
  const since = params.get('since') ?? undefined;
  return {
    exchanges: list(params, 'exchange', VENUE_TOKEN_RE),
    tags: list(params, 'tag', /^[a-z0-9-]{1,40}$/),
    since: isIsoDate(since) ? since : undefined,
    days: intParam(params, 'days', 1, 3650),
    status: list(params, 'status', /^[a-z-]{1,20}$/),
    q: (params.get('q') ?? '').trim().slice(0, 200),
    limit: intParam(params, 'limit', 1, 1000),
  };
}

// Stable query string (same filter -> same string), used for URLs and ETags.
export function filterToSearchParams(f: Partial<ChangelogFilter>): URLSearchParams {
  const p = new URLSearchParams();
  if (f.exchanges?.length) p.set('exchange', [...f.exchanges].sort().join(','));
  if (f.tags?.length) p.set('tag', [...f.tags].sort().join(','));
  if (f.since) p.set('since', f.since);
  if (f.days) p.set('days', String(f.days));
  if (f.status?.length) p.set('status', [...f.status].sort().join(','));
  if (f.q) p.set('q', f.q);
  if (f.limit) p.set('limit', String(f.limit));
  return p;
}

// Earliest day included by a filter (since and days combine to the later bound).
export function filterStartDay(f: Pick<ChangelogFilter, 'since' | 'days'>, today: string = utcDay()): string | undefined {
  const fromDays = f.days ? addDays(today, -f.days) : undefined;
  if (f.since && fromDays) return f.since > fromDays ? f.since : fromDays;
  return f.since ?? fromDays;
}

export function filterEntries<T extends FeedEntry>(entries: readonly T[], f: ChangelogFilter, today: string = utcDay()): T[] {
  const start = filterStartDay(f, today);
  const tags = new Set(f.tags);
  const status = new Set(f.status);
  const q = f.q.toLowerCase();
  const out = entries.filter((e) => {
    if (f.exchanges.length && !f.exchanges.some((t) => matchesVenue(e, t))) return false;
    if (tags.size && !e.tags.some((t) => tags.has(t))) return false;
    if (status.size && !status.has(e.ccxt.status)) return false;
    if (start && entryDate(e) < start) return false;
    if (q && !`${e.title}\n${e.excerpt}`.toLowerCase().includes(q)) return false;
    return true;
  });
  out.sort((a, b) => entryDate(b).localeCompare(entryDate(a)) || b.firstSeen.localeCompare(a.firstSeen));
  return f.limit ? out.slice(0, f.limit) : out;
}

// ---------------------------------------------------------------------------
// view shaping: what the explorer actually renders (links already sanitized)
// ---------------------------------------------------------------------------

export interface VenueInfo {
  key: string;              // venueKey(kind, id)
  id: string;
  name: string;
  kind: VenueKind;
  docPath: string | null;   // null when the docs site has no page for this venue
  domains: string[];        // hosts entry links may point to
}

export interface ViewEntry {
  id: string;
  kind: VenueKind;
  exchange: string;
  affects: string[];
  title: string;
  excerpt: string;
  body?: string;
  href: string | null;       // entry link (sanitized), null = render title as text
  sourceHref: string | null; // source page (sanitized)
  sourceHost: string;
  scope?: string;
  date: string;              // grouping day
  publishedAt: string | null;
  effectiveDate?: string;
  firstSeen: string;
  tags: string[];
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '');
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 50) : []);

// Defensive: also used on JSON fetched by the browser, so it never trusts field types.
export function toViewEntry(raw: Partial<ChangelogEntry>, venue: VenueInfo | undefined): ViewEntry {
  const sourceLink = str(raw.sourceLink, 2048);
  const sourceHref = safeHref(sourceLink, ANY_HOST);
  // registry domains; else the source link's own domain unless it is a shared host; else only
  // the source link itself (fail closed)
  const fallback = baseDomain(sourceHref);
  const domains = venue?.domains.length ? venue.domains : (fallback && !isSharedHost(fallback) ? [fallback] : []);
  const effectiveDate = isIsoDate(raw.effectiveDate) ? raw.effectiveDate : undefined;
  const publishedAt = isIsoDate(raw.publishedAt) ? raw.publishedAt : null;
  const firstSeen = str(raw.firstSeen, 40);
  const body = str(raw.body);
  return {
    id: str(raw.id, 128),
    kind: raw.kind === 'prediction' ? 'prediction' : 'exchange',
    exchange: str(raw.exchange, 64),
    affects: strArr(raw.affects),
    title: str(raw.title, 300),
    excerpt: str(raw.excerpt, 600),
    ...(body ? { body } : {}),
    href: safeHref(raw.url, domains, sourceHref),
    sourceHref,
    sourceHost: hostOf(sourceHref),
    scope: str(raw.scope, 80) || undefined,
    date: entryDate({ effectiveDate, publishedAt, firstSeen }),
    publishedAt,
    effectiveDate,
    firstSeen,
    tags: strArr(raw.tags),
  };
}

// Hosts each venue's entries may link to: the registry `domains` from VenueSummary.domains.
// Feeds written before VenueSummary carried `domains` fall back to the base domains of the
// source links in health.json + entries (never shared hosts like raw.githubusercontent.com).
// Keyed by venueKey(kind, id): exchange/binance and prediction/binance keep their own lists.
export function venueDomainsFrom(
  entries: readonly Pick<FeedEntry, 'kind' | 'exchange' | 'sourceLink'>[],
  health: HealthFeed,
  venues: readonly Pick<VenueSummary, 'kind' | 'id' | 'domains'>[] = [],
): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  const put = (venue: string, d: string) => {
    if (!m.has(venue)) m.set(venue, new Set());
    m.get(venue)!.add(d);
  };
  const isHost = (d: string) => /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d);
  for (const v of venues) for (const d of v.domains ?? []) if (isHost(d.toLowerCase())) put(venueKey(v.kind, v.id), d.toLowerCase());
  const fromRegistry = new Set(m.keys());
  const add = (key: string, link: string) => {
    if (fromRegistry.has(key)) return;
    const d = baseDomain(safeHref(link, ANY_HOST));
    if (d && !isSharedHost(d)) put(key, d);
  };
  for (const s of health.sources) add(venueKey(s.kind, s.venue), s.link);
  for (const e of entries) add(venueKey(e.kind, e.exchange), e.sourceLink);
  return new Map([...m].map(([k, v]) => [k, [...v]]));
}

export function groupByDay<T extends { date: string }>(entries: readonly T[]): { day: string; entries: T[] }[] {
  const groups: { day: string; entries: T[] }[] = [];
  for (const e of entries) {
    const last = groups.at(-1);
    if (last && last.day === e.date) last.entries.push(e);
    else groups.push({ day: e.date, entries: [e] });
  }
  return groups;
}

export function formatDay(day: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(t);
}

export function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  return `${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(t)} UTC`;
}
