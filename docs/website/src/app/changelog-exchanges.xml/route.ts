import { Feed } from 'feed';
import {
  FEED_CACHE_CONTROL,
  PAGE_PATH,
  XML_FEED_PATH,
  absoluteUrl,
  escapeHtml,
  etagMatches,
  feedEtag,
  filterEntries,
  filterToSearchParams,
  getChangelogData,
  hostOf,
  isIsoDate,
  parseFilter,
  toViewEntry,
  venueOf,
} from '@/lib/exchange-changelogs';
import { appName, basePath, siteUrl } from '@/lib/shared';

// GET /changelog-exchanges.xml — RSS 2.0 (Atom 1.0 with ?format=atom), latest 100 items,
// same filters as the .json route (?exchange=&tag=&since=&days=&status=&q=&limit=).
// Outside [lang] like blog/rss.xml: paths with a file extension bypass the i18n proxy.
// Item text is third-party data: it is HTML-escaped (shown as literal text by readers)
// and prefixed with where it came from; links are re-checked with safeHref.

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filter = parseFilter(url.searchParams);
  const atom = url.searchParams.get('format') === 'atom';
  const qs = filterToSearchParams(filter).toString();

  const { latest, venues } = await getChangelogData();
  const etag = feedEtag(latest.generatedAt, `${atom ? 'atom' : 'rss'}|${qs}`, Boolean(filter.days));
  if (etagMatches(req, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': FEED_CACHE_CONTROL } });
  }

  const entries = filterEntries(latest.entries, { ...filter, limit: Math.min(filter.limit ?? 100, 100) });
  const pageUrl = absoluteUrl(PAGE_PATH);
  const selfQs = [qs, atom ? 'format=atom' : ''].filter(Boolean).join('&');
  const selfUrl = absoluteUrl(`${XML_FEED_PATH}${selfQs ? `?${selfQs}` : ''}`);
  const scope = filter.exchanges.length ? ` — ${filter.exchanges.join(', ')}` : '';

  const feed = new Feed({
    title: `${appName} — Exchange API Changelogs${scope}`,
    id: pageUrl,
    link: pageUrl,
    description: 'API changelog entries of the exchanges and prediction markets CCXT supports, collected daily. Item text is third-party data quoted from each venue.',
    language: 'en',
    favicon: `${siteUrl}${basePath}/icon.svg`,
    copyright: `Entry text © the respective venues; feed © ${new Date().getFullYear()} CCXT`,
    updated: latest.generatedAt ? new Date(latest.generatedAt) : undefined,
    ttl: 60,
    feedLinks: atom ? { atom: selfUrl } : { rss: selfUrl },
  });

  for (const e of entries) {
    const venue = venueOf(venues, e);
    const v = toViewEntry(e, venue);
    const host = hostOf(v.sourceHref) || 'the venue';
    const effective = e.effectiveDate ? ` Effective ${e.effectiveDate}.` : '';
    const seen = e.firstSeen.slice(0, 10);
    const day = v.publishedAt ?? (isIsoDate(seen) ? seen : v.date);   // validated days only
    feed.addItem({
      id: `urn:ccxt-changelog:${e.id}`, // Atom ids must be URIs; RSS uses guid
      guid: e.id,
      link: v.href ?? pageUrl,
      // Atom titles are type="html" (RSS readers treat them alike): escape like the description;
      // titles are CDATA
      title: escapeHtml(`[${venue?.name ?? e.exchange}] ${v.title}`).replaceAll(']]>', ']] >'),
      description: escapeHtml(`Third-party text from ${host}:${effective} ${v.excerpt}`),
      date: new Date(`${day}T00:00:00Z`),
      category: [...e.tags, e.exchange].map((name) => ({ name })),
    });
  }

  return new Response(atom ? feed.atom1() : feed.rss2(), {
    headers: {
      'Content-Type': atom ? 'application/atom+xml; charset=utf-8' : 'application/rss+xml; charset=utf-8',
      'Cache-Control': FEED_CACHE_CONTROL,
      ETag: etag,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
