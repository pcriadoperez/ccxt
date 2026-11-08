// Server-side loader for the exchange-changelogs feed files (see
// exchange-changelogs/collector/src/types.ts for the contract: LatestFeed, VenueFeed,
// HealthFeed). Pure helpers live in ./exchange-changelogs-core.ts (client-safe) and are
// re-exported from here.
//
// Source of the files:
//   - EXCHANGE_CHANGELOGS_DIR set   -> read <dir>/latest.json, <dir>/health.json,
//                                      <dir>/<kind>/<id>.json from disk (local preview)
//   - otherwise                     -> fetch from EXCHANGE_CHANGELOGS_URL (default: the
//                                      changelog-data branch on raw.githubusercontent.com),
//                                      cached for 1h and tagged 'exchange-changelogs' so
//                                      POST /api/revalidate/changelog can refresh it.
//
// Never throws: a missing/invalid file yields the last good copy this process saw, or an
// empty valid feed. Unknown fields are tolerated (zod strips them); a malformed entry is
// dropped instead of failing the whole feed.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { basePath, siteUrl } from './shared';
import {
  EMPTY_HEALTH,
  EMPTY_LATEST,
  isIsoDate,
  isVenueId,
  utcDay,
  venueDocPath,
  venueKey,
  venueDomainsFrom,
  type ChangelogEntry,
  type FeedEntry,
  type HealthFeed,
  type LatestFeed,
  type SourceHealth,
  type VenueFeed,
  type VenueInfo,
  type VenueKind,
  type VenueSummary,
} from './exchange-changelogs-core';

export * from './exchange-changelogs-core';

export const CHANGELOG_CACHE_TAG = 'exchange-changelogs';
export const CHANGELOG_REVALIDATE_SECONDS = 3600;
const DEFAULT_URL = 'https://raw.githubusercontent.com/ccxt/ccxt/changelog-data/feed';

// ---------------------------------------------------------------------------
// zod schemas (mirror of the contract; lenient on values that may grow)
// ---------------------------------------------------------------------------

// a real calendar day: a malformed date would otherwise reach `new Date()` in the feed routes
const isoDay = z.string().refine(isIsoDate);
const kind = z.enum(['exchange', 'prediction']);
const text = (max: number) => z.string().transform((s) => s.slice(0, max));

const feedEntrySchema = z.object({
  schemaVersion: z.number(),
  id: z.string().min(1).max(128),
  kind,
  exchange: z.string().min(1).max(64),
  affects: z.array(z.string()).catch([]),
  source: z.string(),
  sourceType: z.string(),
  sourceLink: z.string(),
  scope: z.string().optional().catch(undefined),
  title: text(300),
  excerpt: text(600).catch(''),
  url: z.string(),
  publishedAt: isoDay.nullable().catch(null),
  effectiveDate: isoDay.optional().catch(undefined),
  dateKind: z.string().catch('firstSeen'),
  firstSeen: z.string(),
  lastSeen: z.string().catch(''),
  hash: z.string().catch(''),
  removedAt: z.string().optional().catch(undefined),
  backfill: z.boolean().catch(false),
  tags: z.array(z.string()).catch([]),
  ccxt: z.object({
    status: z.string(),
    issue: z.number().optional().catch(undefined),
    pr: z.number().optional().catch(undefined),
  }).catch({ status: 'new' }),
});

const changelogEntrySchema = feedEntrySchema.extend({
  body: text(8000).optional().catch(undefined),
  revisions: z.array(z.object({ at: z.string(), hash: z.string() })).optional().catch(undefined),
});

const venueSummarySchema = z.object({
  id: z.string().min(1),
  kind,
  name: z.string(),
  subclasses: z.array(z.string()).catch([]),
  domains: z.array(z.string()).catch([]),
  sources: z.number().catch(0),
  healthy: z.number().catch(0),
  latestDate: z.string().nullable().catch(null),
  entryCount: z.number().catch(0),
});

const sourceHealthSchema = z.object({
  id: z.string(),
  venue: z.string(),
  kind,
  type: z.string(),
  link: z.string(),
  role: z.enum(['primary', 'secondary']).catch('primary'),
  ok: z.boolean(),
  expectBlocked: z.string().optional().catch(undefined),
  lastRunAt: z.string().catch(''),
  lastOkAt: z.string().nullable().catch(null),
  lastError: z.string().nullable().catch(null),
  consecutiveFailures: z.number().catch(0),
  entryCount: z.number().catch(0),
  latestDate: z.string().nullable().catch(null),
});

const envelope = z.object({ schemaVersion: z.number(), generatedAt: z.string() });

// Parse an array item-by-item, keeping only the valid ones.
function each<T>(schema: z.ZodType<T>, items: unknown): T[] {
  if (!Array.isArray(items)) return [];
  const out: T[] = [];
  for (const it of items) {
    const r = schema.safeParse(it);
    if (r.success) out.push(r.data);
  }
  return out;
}

function parseLatest(raw: unknown): LatestFeed | null {
  const env = envelope.extend({ windowDays: z.number().catch(0), entries: z.unknown(), venues: z.unknown() }).safeParse(raw);
  if (!env.success) return null;
  return {
    schemaVersion: env.data.schemaVersion,
    generatedAt: env.data.generatedAt,
    windowDays: env.data.windowDays,
    entries: each<FeedEntry>(feedEntrySchema, env.data.entries),
    venues: each<VenueSummary>(venueSummarySchema, env.data.venues),
  };
}

function parseHealth(raw: unknown): HealthFeed | null {
  const env = envelope.extend({ sources: z.unknown() }).safeParse(raw);
  if (!env.success) return null;
  return { schemaVersion: env.data.schemaVersion, generatedAt: env.data.generatedAt, sources: each<SourceHealth>(sourceHealthSchema, env.data.sources) };
}

function parseVenue(raw: unknown): VenueFeed | null {
  const env = envelope.extend({ venue: venueSummarySchema, entries: z.unknown() }).safeParse(raw);
  if (!env.success) return null;
  return {
    schemaVersion: env.data.schemaVersion,
    generatedAt: env.data.generatedAt,
    venue: env.data.venue,
    entries: each<ChangelogEntry>(changelogEntrySchema, env.data.entries),
  };
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

// Last successfully parsed copy per file, so a transient fetch failure during an ISR
// regeneration doesn't replace a good page with an empty one for an hour.
const lastGood = new Map<string, unknown>();

async function readJson(rel: string): Promise<unknown> {
  const dir = process.env.EXCHANGE_CHANGELOGS_DIR;
  if (dir) {
    return JSON.parse(await readFile(join(dir, rel), 'utf8'));
  }
  const base = (process.env.EXCHANGE_CHANGELOGS_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const res = await fetch(`${base}/${rel}`, {
    next: { revalidate: CHANGELOG_REVALIDATE_SECONDS, tags: [CHANGELOG_CACHE_TAG] },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${rel}`);
  return res.json();
}

async function load<T>(rel: string, parse: (raw: unknown) => T | null): Promise<T | null> {
  try {
    const parsed = parse(await readJson(rel));
    if (parsed) {
      lastGood.set(rel, parsed);
      return parsed;
    }
    console.warn(`[exchange-changelogs] ${rel}: unexpected shape`);
  } catch (err) {
    console.warn(`[exchange-changelogs] ${rel}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return (lastGood.get(rel) as T | undefined) ?? null;
}

export async function getLatestFeed(): Promise<LatestFeed> {
  return (await load('latest.json', parseLatest)) ?? EMPTY_LATEST;
}

export async function getHealthFeed(): Promise<HealthFeed> {
  return (await load('health.json', parseHealth)) ?? EMPTY_HEALTH;
}

// One venue with bodies (last 365 days). Without `kind`, every kind latest.json lists for the id
// (exchange/binance + prediction/binance) is loaded and their entries merged. Only venues listed
// in latest.json are fetched, so unknown ids cost no origin request (unless latest.json itself is
// unavailable, then both kinds are tried).
export async function getVenueFeed(id: string, venueKind?: VenueKind): Promise<VenueFeed | null> {
  if (!isVenueId(id)) return null;
  const latest = await getLatestFeed();
  let kinds: VenueKind[];
  if (latest.venues.length) {
    kinds = latest.venues.filter((v) => v.id === id && (!venueKind || v.kind === venueKind)).map((v) => v.kind);
  } else {
    kinds = venueKind ? [venueKind] : ['exchange', 'prediction'];
  }
  const feeds: VenueFeed[] = [];
  for (const k of kinds) {
    const feed = await load(`${k}/${id}.json`, parseVenue);
    if (feed) feeds.push(feed);
  }
  if (feeds.length <= 1) return feeds[0] ?? null;
  const seen = new Set<string>();
  const entries = feeds.flatMap((f) => f.entries).filter((e) => !seen.has(e.id) && Boolean(seen.add(e.id)));
  return { ...feeds[0], entries };
}

// latest + health, plus per-venue display info (name, kind, docs path, link domains)
// for every venue that appears in either file, keyed by venueKey(kind, id).
export async function getChangelogData(): Promise<{ latest: LatestFeed; health: HealthFeed; venues: Map<string, VenueInfo> }> {
  const [latest, health] = await Promise.all([getLatestFeed(), getHealthFeed()]);
  const domains = venueDomainsFrom(latest.entries, health, latest.venues);
  const venues = new Map<string, VenueInfo>();
  const add = (id: string, name: string, k: VenueKind) => {
    const key = venueKey(k, id);
    if (!venues.has(key) && isVenueId(id)) venues.set(key, { key, id, name: name || id, kind: k, docPath: venueDocPath(k, id), domains: domains.get(key) ?? [] });
  };
  for (const v of latest.venues) add(v.id, v.name, v.kind);
  for (const e of latest.entries) add(e.exchange, e.exchange, e.kind);
  for (const s of health.sources) add(s.venue, s.venue, s.kind);
  return { latest, health, venues };
}

// ---------------------------------------------------------------------------
// helpers for the machine-readable outputs (.json / .xml / .md routes)
// ---------------------------------------------------------------------------

export const FEED_CACHE_CONTROL = 'public, s-maxage=3600, stale-while-revalidate=86400';
// error responses (bad query, venue file missing or failing to load) must not be cached
export const ERROR_CACHE_CONTROL = 'no-store';

// Weak ETag over the data version + the request shape. A `days=` window moves at UTC midnight,
// so `relativeDays` adds the current day (else pollers would get 304 with yesterday's window).
export function feedEtag(generatedAt: string, variant: string, relativeDays = false): string {
  const day = relativeDays ? `|${utcDay()}` : '';
  return `W/"${createHash('sha256').update(`${generatedAt}|${variant}${day}`).digest('hex').slice(0, 32)}"`;
}

// The venue a feed entry belongs to.
export function venueOf(venues: Map<string, VenueInfo>, e: { kind: VenueKind; exchange: string }): VenueInfo | undefined {
  return venues.get(venueKey(e.kind, e.exchange));
}

export function etagMatches(req: Request, etag: string): boolean {
  const inm = req.headers.get('if-none-match');
  if (!inm) return false;
  return inm.split(',').some((t) => {
    const v = t.trim();
    return v === '*' || v === etag || v.replace(/^W\//, '') === etag.replace(/^W\//, '');
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

// Inline markdown: escape what could form a link/image ([ ]), HTML (< >), code or emphasis.
export function escapeMarkdownInline(s: string): string {
  return s.replace(/\s+/g, ' ').trim().replace(/([\\`*_[\]<>])/g, '\\$1');
}

// Absolute URL of a docs-app path (feeds must not use relative links).
export function absoluteUrl(path: string): string {
  return `${siteUrl}${basePath}${path}`;
}
