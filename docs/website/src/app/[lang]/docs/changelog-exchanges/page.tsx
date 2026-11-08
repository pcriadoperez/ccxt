import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { AlertTriangle, CheckCircle2, ExternalLink } from 'lucide-react';
import { ChangelogExplorer } from '@/components/changelog-explorer';
import {
  JSON_FEED_PATH,
  MD_PATH,
  PAGE_PATH,
  XML_FEED_PATH,
  addDays,
  entryDate,
  ANY_HOST,
  formatTimestamp,
  getChangelogData,
  hostOf,
  safeHref,
  toViewEntry,
  utcDay,
  venueKey,
  venueOf,
  type SourceHealth,
  type VenueInfo,
} from '@/lib/exchange-changelogs';
import { source } from '@/lib/source';
import { appName, basePath } from '@/lib/shared';

// Incremental static regeneration: rebuilt at most hourly (and on demand via
// POST /api/revalidate/changelog). Filters are applied client-side from the URL, so this
// server component must never read searchParams (that would make it dynamic).
// generateStaticParams returns [] (nothing prerendered at build): without it the dynamic [lang]
// segment makes the route render on every request and `revalidate` is ignored. Each locale
// renders on first request, then is cached. Every locale shows the same English content.
export const revalidate = 3600;

export function generateStaticParams(): { lang: string }[] {
  return [];
}

const TITLE = 'Exchange API Changelogs';
const DESCRIPTION =
  'Daily-collected API changelogs of every exchange and prediction market CCXT supports: deprecations, breaking changes, new endpoints and rate-limit updates, in one timeline with RSS and JSON feeds.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: {
    // one canonical (English) for every locale variant of this page
    canonical: `${basePath}${PAGE_PATH}`,
    types: {
      'application/rss+xml': [{ title: `${appName} — ${TITLE} (RSS)`, url: `${basePath}${XML_FEED_PATH}` }],
      'application/atom+xml': [{ title: `${appName} — ${TITLE} (Atom)`, url: `${basePath}${XML_FEED_PATH}?format=atom` }],
      'application/feed+json': [{ title: `${appName} — ${TITLE} (JSON Feed)`, url: `${basePath}${JSON_FEED_PATH}?format=jsonfeed` }],
      'text/markdown': [{ title: TITLE, url: `${basePath}${MD_PATH}` }],
    },
  },
  openGraph: {
    type: 'website',
    siteName: appName,
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: `${basePath}/og/home`, width: 1200, height: 630 }],
  },
};

const EXTERNAL_REL = 'nofollow noopener noreferrer';

// docs path for a venue only when the site actually has that page
function withDocPaths(venues: Map<string, VenueInfo>): Map<string, VenueInfo> {
  const out = new Map<string, VenueInfo>();
  for (const [key, v] of venues) {
    const slugs = v.kind === 'prediction' ? ['prediction', v.id] : ['exchanges', v.id];
    out.set(key, { ...v, docPath: source.getPage(slugs) ? v.docPath : null });
  }
  return out;
}

interface CoverageRow {
  venue: VenueInfo;
  sources: SourceHealth[];
  healthy: number;
  latestDate: string | null;
}

export default async function Page() {
  const { latest, health, venues: rawVenues } = await getChangelogData();
  const venues = withDocPaths(rawVenues);
  const today = utcDay();

  const entries = latest.entries
    .map((e) => toViewEntry(e, venueOf(venues, e)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.firstSeen.localeCompare(a.firstSeen));

  const since7 = addDays(today, -7);
  const since30 = addDays(today, -30);
  const last7 = latest.entries.filter((e) => entryDate(e) >= since7).length;
  const last30 = latest.entries.filter((e) => entryDate(e) >= since30).length;
  const upcoming = latest.entries.filter((e) => e.effectiveDate && e.effectiveDate > today).length;
  const healthyCount = health.sources.filter((s) => s.ok).length;

  // coverage table: one row per venue from health.json (+ venues with no sources listed)
  const byVenue = new Map<string, SourceHealth[]>();
  for (const s of health.sources) {
    const key = venueKey(s.kind, s.venue);
    byVenue.set(key, [...(byVenue.get(key) ?? []), s]);
  }
  const summaries = new Map(latest.venues.map((v) => [venueKey(v.kind, v.id), v]));
  const coverage: CoverageRow[] = [...venues.values()]
    .map((venue) => {
      const sources = byVenue.get(venue.key) ?? [];
      const dates = [summaries.get(venue.key)?.latestDate, ...sources.map((s) => s.latestDate)].filter((d): d is string => Boolean(d)).sort();
      return { venue, sources, healthy: sources.filter((s) => s.ok).length, latestDate: dates.at(-1) ?? null };
    })
    .sort((a, b) => a.venue.name.localeCompare(b.venue.name));
  const degraded = coverage.filter((r) => r.healthy < r.sources.length).length;

  const updated = latest.generatedAt || health.generatedAt;
  const toc = [
    { title: 'Timeline', url: '#timeline', depth: 2 },
    { title: 'Coverage', url: '#coverage', depth: 2 },
    { title: 'Feeds & API', url: '#feeds', depth: 2 },
  ];

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{TITLE}</DocsTitle>
      <DocsDescription className="mb-0">
        API changes announced by the exchanges and prediction markets CCXT supports, collected daily from their official
        changelogs. Use it to spot deprecations and breaking changes before they reach your bot.
      </DocsDescription>

      <dl className="not-prose grid grid-cols-2 gap-2 border-b pb-6 sm:grid-cols-4">
        <Stat label="Venues monitored" value={String(venues.size)} />
        <Stat
          label="Sources healthy"
          value={`${healthyCount}/${health.sources.length}`}
          tone={health.sources.length && healthyCount < health.sources.length ? 'warn' : 'ok'}
        />
        <Stat label="Entries (7d / 30d)" value={`${last7} / ${last30}`} hint={upcoming ? `${upcoming} upcoming` : undefined} />
        <Stat
          label="Last updated"
          value={updated ? <time dateTime={updated}>{formatTimestamp(updated)}</time> : 'unavailable'}
          small
        />
      </dl>

      <DocsBody>
        <h2 id="timeline">Timeline</h2>
        <p className="text-sm">
          Grouped by the date a change takes effect (or was published). Titles link to the venue&apos;s own changelog;
          excerpts are third-party text, shown verbatim as plain text.
        </p>
        <ChangelogExplorer entries={entries} venues={[...venues.values()]} today={today} />

        <h2 id="coverage">Coverage</h2>
        <p className="text-sm">
          {coverage.length} venues, {health.sources.length} changelog sources.{' '}
          {degraded
            ? `${degraded} ${degraded === 1 ? 'venue has' : 'venues have'} a degraded source — those changes may arrive late or need a manual check.`
            : 'All sources fetched successfully on the last run.'}
        </p>
        <CoverageTable rows={coverage} />

        <h2 id="feeds">Feeds &amp; API</h2>
        <p>Every view of the timeline maps to a feed URL — use the <strong>Subscribe</strong> button above, or build one by hand:</p>
        <ul>
          <li>
            <a href={`${basePath}${XML_FEED_PATH}`}><code>{XML_FEED_PATH}</code></a> — RSS 2.0 (add <code>?format=atom</code> for Atom), latest 100 items.
          </li>
          <li>
            <a href={`${basePath}${JSON_FEED_PATH}`}><code>{JSON_FEED_PATH}</code></a> — JSON (add <code>?format=jsonfeed</code> for JSON Feed 1.1,
            or <code>?exchange=&lt;id&gt;&amp;full=1</code> for one venue&apos;s 365-day history with bodies).
          </li>
          <li>
            <a href={`${basePath}${MD_PATH}`}><code>{MD_PATH}</code></a> — this page as Markdown for LLM agents.
          </li>
        </ul>
        <p>
          Filters (all optional, comma-separated): <code>exchange=binance,okx</code> (a bare id covers every kind;{' '}
          <code>prediction/binance</code> picks one), <code>tag=breaking,deprecation</code>,{' '}
          <code>since=YYYY-MM-DD</code>, <code>days=30</code>, <code>q=text</code>, <code>limit=50</code>. Responses carry an{' '}
          <code>ETag</code>, so pollers can send <code>If-None-Match</code>.
        </p>
      </DocsBody>
    </DocsPage>
  );
}

function Stat({ label, value, hint, tone, small }: { label: string; value: ReactNode; hint?: string; tone?: 'ok' | 'warn'; small?: boolean }) {
  return (
    <div className="rounded-xl border bg-fd-card px-3 py-2.5">
      <dt className="text-xs text-fd-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 flex items-center gap-1.5 font-semibold tabular-nums ${small ? 'text-sm' : 'text-lg'}`}>
        {tone === 'warn' ? <AlertTriangle className="size-4 text-amber-500" aria-label="some sources degraded" /> : null}
        {value}
      </dd>
      {hint ? <dd className="text-[11px] leading-4 text-amber-700 dark:text-amber-300">{hint}</dd> : null}
    </div>
  );
}

function CoverageTable({ rows }: { rows: CoverageRow[] }) {
  if (rows.length === 0) {
    return <p className="not-prose rounded-xl border border-dashed px-4 py-6 text-center text-sm text-fd-muted-foreground">Coverage data is not available right now.</p>;
  }
  return (
    <div className="not-prose overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Changelog sources per venue and their status on the last collector run</caption>
        <thead className="border-b bg-fd-muted/40 text-left text-xs text-fd-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">Venue</th>
            <th scope="col" className="px-3 py-2 font-semibold">Sources</th>
            <th scope="col" className="hidden px-3 py-2 font-semibold sm:table-cell">Status</th>
            <th scope="col" className="hidden px-3 py-2 font-semibold sm:table-cell">Latest date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ venue, sources, healthy, latestDate }) => (
            <tr key={venue.key} className="border-b align-top last:border-0">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {venue.docPath ? (
                  <Link href={venue.docPath} className="hover:text-fd-primary hover:underline">{venue.name}</Link>
                ) : (
                  venue.name
                )}
                <span className="block font-mono text-[11px] leading-4 font-normal text-fd-muted-foreground">
                  {venue.id}{venue.kind === 'prediction' ? ' · prediction' : ''}
                </span>
                {/* phones: status moves under the venue so the sources column keeps its width */}
                <span className="mt-1 block font-normal sm:hidden">
                  <StatusCell sources={sources} healthy={healthy} />
                </span>
              </th>
              <td className="px-3 py-2">
                {sources.length === 0 ? <span className="text-fd-muted-foreground">—</span> : null}
                <ul className="flex flex-col gap-0.5">
                  {sources.map((s) => {
                    const href = safeHref(s.link, ANY_HOST);
                    const label = hostOf(href) || s.id;
                    return (
                      <li key={s.id} className="flex flex-wrap items-center gap-1 text-xs">
                        {href ? (
                          <a href={href} target="_blank" rel={EXTERNAL_REL} className="inline-flex items-center gap-1 text-fd-foreground hover:text-fd-primary hover:underline">
                            <span>{breakableHost(label)}</span>
                            <ExternalLink className="size-3 shrink-0 text-fd-muted-foreground" aria-hidden />
                          </a>
                        ) : (
                          <span>{label}</span>
                        )}
                        <span className="text-fd-muted-foreground">({s.type}{s.role === 'secondary' ? ', secondary' : ''})</span>
                      </li>
                    );
                  })}
                </ul>
              </td>
              <td className="hidden px-3 py-2 sm:table-cell">
                <StatusCell sources={sources} healthy={healthy} />
              </td>
              <td className="hidden whitespace-nowrap px-3 py-2 font-mono text-xs text-fd-muted-foreground sm:table-cell">{latestDate ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Let narrow columns wrap host names at the dots instead of mid-label.
function breakableHost(host: string): ReactNode[] {
  return host.split('.').flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, `.${part}`]));
}

function StatusCell({ sources, healthy }: { sources: SourceHealth[]; healthy: number }) {
  if (sources.length === 0) return <span className="text-xs text-fd-muted-foreground">not monitored</span>;
  const bad = sources.filter((s) => !s.ok);
  if (bad.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] leading-4 font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-3" aria-hidden /> ok
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <span className="inline-flex w-fit items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] leading-4 font-medium text-amber-700 dark:text-amber-300">
        <AlertTriangle className="size-3" aria-hidden /> degraded ({healthy}/{sources.length})
      </span>
      {bad.map((s) => (
        <span key={s.id} className="text-[11px] leading-4 text-fd-muted-foreground">
          {s.expectBlocked ? `${s.id}: ${s.expectBlocked}` : `${s.id}: failing for ${s.consecutiveFailures} ${s.consecutiveFailures === 1 ? 'run' : 'runs'}`}
        </span>
      ))}
    </span>
  );
}
