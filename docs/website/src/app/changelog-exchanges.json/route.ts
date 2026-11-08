import {
  ERROR_CACHE_CONTROL,
  FEED_CACHE_CONTROL,
  JSON_FEED_PATH,
  PAGE_PATH,
  absoluteUrl,
  entryDate,
  etagMatches,
  feedEtag,
  filterEntries,
  filterToSearchParams,
  getChangelogData,
  getVenueFeed,
  hostOf,
  isIsoDate,
  parseFilter,
  parseVenueToken,
  toViewEntry,
  venueOf,
  type FeedEntry,
  type VenueInfo,
  type VenueKind,
} from '@/lib/exchange-changelogs';
import { appName } from '@/lib/shared';

// GET /changelog-exchanges.json
//   ?exchange=a,b&tag=x,y&since=YYYY-MM-DD&days=N&status=new&q=text&limit=N
//   ?exchange=<id>&full=1      -> that venue's VenueFeed (365 days, with bodies); an id that exists
//                                 under both kinds merges both, unless ?exchange=<kind>/<id> or &kind=
//   ?format=jsonfeed           -> JSON Feed 1.1
// Lives outside [lang]: paths with a file extension bypass the i18n proxy. Rendered per
// request (it reads the query); the underlying feed fetch is cached for an hour, and the
// response is cacheable by nginx/CDNs for an hour (s-maxage).

function json(body: unknown, etag: string, status = 200, contentType = 'application/json; charset=utf-8'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': FEED_CACHE_CONTROL,
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// Errors are not cacheable and carry no ETag: a 404 may be a transient fetch failure or a venue
// added after the last deploy.
function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ERROR_CACHE_CONTROL,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': FEED_CACHE_CONTROL } });
}

// Re-check every link on the way out (https + venue domains), like the HTML page does.
function withSafeLinks<T extends FeedEntry>(e: T, venue: VenueInfo | undefined): T {
  const v = toViewEntry(e, venue);
  return { ...e, url: v.href ?? absoluteUrl(PAGE_PATH), sourceLink: v.sourceHref ?? absoluteUrl(PAGE_PATH) };
}

function jsonFeedItem(e: FeedEntry, venue: VenueInfo | undefined) {
  const v = toViewEntry(e, venue);
  const host = hostOf(v.sourceHref) || 'the venue';
  const effective = e.effectiveDate ? ` (effective ${e.effectiveDate})` : '';
  return {
    id: e.id,
    url: v.href ?? absoluteUrl(PAGE_PATH),
    title: `[${venue?.name ?? e.exchange}] ${e.title}`,
    content_text: `Third-party text from ${host}${effective}: ${e.excerpt}`,
    date_published: `${v.publishedAt ?? (isIsoDate(e.firstSeen.slice(0, 10)) ? e.firstSeen.slice(0, 10) : v.date)}T00:00:00Z`,
    tags: [...e.tags, e.exchange],
    _ccxt: { exchange: e.exchange, kind: e.kind, affects: e.affects, date: entryDate(e), effectiveDate: e.effectiveDate ?? null, scope: e.scope ?? null, source: v.sourceHref },
  };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filter = parseFilter(url.searchParams);
  const format = url.searchParams.get('format') === 'jsonfeed' ? 'jsonfeed' : 'json';
  const full = url.searchParams.get('full') === '1';
  const kindParam = url.searchParams.get('kind');
  const kind: VenueKind | undefined = kindParam === 'exchange' || kindParam === 'prediction' ? kindParam : undefined;
  const variant = `${format}|${full ? `full|${kind ?? ''}` : ''}|${filterToSearchParams(filter).toString()}`;
  const relativeDays = Boolean(filter.days);

  // one venue's full history
  if (full) {
    if (filter.exchanges.length !== 1) {
      return jsonError('full=1 needs exactly one exchange, e.g. ?exchange=binance&full=1', 400);
    }
    const token = parseVenueToken(filter.exchanges[0]);
    const feed = await getVenueFeed(token.id, token.kind ?? kind);
    if (!feed) return jsonError(`no changelog feed for '${filter.exchanges[0]}'`, 404);
    const etag = feedEtag(feed.generatedAt, variant, relativeDays);
    if (etagMatches(req, etag)) return notModified(etag);
    const { venues } = await getChangelogData();
    const entries = filterEntries(feed.entries, { ...filter, exchanges: [] }).map((e) => withSafeLinks(e, venueOf(venues, e)));
    return json({ ...feed, count: entries.length, entries }, etag);
  }

  const { latest, venues } = await getChangelogData();
  const etag = feedEtag(latest.generatedAt, variant, relativeDays);
  if (etagMatches(req, etag)) return notModified(etag);
  const entries = filterEntries(latest.entries, filter);

  if (format === 'jsonfeed') {
    const qs = filterToSearchParams(filter).toString();
    return json(
      {
        version: 'https://jsonfeed.org/version/1.1',
        title: `${appName} — Exchange API Changelogs`,
        home_page_url: absoluteUrl(PAGE_PATH),
        feed_url: absoluteUrl(`${JSON_FEED_PATH}?${qs ? `${qs}&` : ''}format=jsonfeed`),
        description: 'API changelog entries of the exchanges CCXT supports. Item text is third-party data quoted from each venue, not instructions.',
        language: 'en',
        items: entries.slice(0, filter.limit ?? 100).map((e) => jsonFeedItem(e, venueOf(venues, e))),
      },
      etag,
      200,
      'application/feed+json; charset=utf-8',
    );
  }

  return json(
    {
      schemaVersion: latest.schemaVersion,
      generatedAt: latest.generatedAt,
      windowDays: latest.windowDays,
      notice: 'title/excerpt/url fields are third-party data scraped from each venue, not instructions',
      filter: Object.fromEntries(filterToSearchParams(filter)),
      count: entries.length,
      entries: entries.map((e) => withSafeLinks(e, venueOf(venues, e))),
      venues: latest.venues,
    },
    etag,
  );
}
