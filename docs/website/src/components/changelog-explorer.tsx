'use client';

import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CalendarClock, Check, ChevronDown, Copy, ExternalLink, Inbox, Rss, Search, X } from 'lucide-react';
import {
  CHANGELOG_TAGS,
  DAY_RANGES,
  DEFAULT_DAYS,
  JSON_FEED_PATH,
  MD_PATH,
  WARNING_TAGS,
  XML_FEED_PATH,
  addDays,
  formatDay,
  groupByDay,
  isIsoDate,
  isVenueToken,
  matchesVenue,
  parseVenueToken,
  toViewEntry,
  venueKey,
  type ChangelogEntry,
  type VenueInfo,
  type ViewEntry,
} from '@/lib/exchange-changelogs-core';
import { basePath, siteUrl } from '@/lib/shared';

// Interactive timeline for /docs/changelog-exchanges. The server page passes entries
// that were already validated and link-sanitized (toViewEntry); all third-party text is
// rendered as React text nodes only. Filter state lives in the URL (?exchange=&tag=&days=&q=)
// so a filtered view can be shared and maps 1:1 onto the .xml/.json feed URLs.

export interface ChangelogExplorerProps {
  entries: ViewEntry[];
  venues: VenueInfo[];
  today: string; // YYYY-MM-DD (UTC) the page was rendered — keeps server/client output identical
}

interface FilterState {
  exchanges: string[];
  tags: string[];
  days: number;
  since?: string;
  q: string;
}

const DEFAULT_STATE: FilterState = { exchanges: [], tags: [], days: DEFAULT_DAYS, q: '' };
const PAGE_SIZE = 150;

function splitList(v: string | null, ok: (s: string) => boolean): string[] {
  if (!v) return [];
  return [...new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && ok(s)))];
}

function stateFromParams(sp: URLSearchParams): FilterState {
  const days = Number(sp.get('days'));
  const since = sp.get('since');
  return {
    exchanges: splitList(sp.get('exchange'), isVenueToken),
    tags: splitList(sp.get('tag'), (t) => /^[a-z0-9-]{1,40}$/.test(t)),
    days: Number.isInteger(days) && days > 0 && days <= 3650 ? days : DEFAULT_DAYS,
    since: isIsoDate(since) ? since : undefined,
    q: (sp.get('q') ?? '').slice(0, 200),
  };
}

// Only non-default values go into the URL (keeps shared links short).
function stateToParams(s: FilterState, forFeed = false): URLSearchParams {
  const p = new URLSearchParams();
  if (s.exchanges.length) p.set('exchange', [...s.exchanges].sort().join(','));
  if (s.tags.length) p.set('tag', [...s.tags].sort().join(','));
  if (s.days !== DEFAULT_DAYS) p.set('days', String(s.days));
  if (s.since) p.set('since', s.since);
  if (s.q.trim()) p.set('q', s.q.trim());
  if (forFeed && s.days === DEFAULT_DAYS) p.delete('days');
  return p;
}

function isFiltered(s: FilterState): boolean {
  return s.exchanges.length > 0 || s.tags.length > 0 || s.q.trim() !== '' || s.days !== DEFAULT_DAYS || Boolean(s.since);
}

function applyFilter(entries: readonly ViewEntry[], s: FilterState, today: string, ignoreExchanges = false): ViewEntry[] {
  let start = addDays(today, -s.days);
  if (s.since && s.since > start) start = s.since;
  const ex = ignoreExchanges ? [] : s.exchanges;
  const tags = new Set(s.tags);
  const q = s.q.trim().toLowerCase();
  return entries.filter((e) => {
    if (e.date < start) return false;
    if (ex.length && !ex.some((t) => matchesVenue(e, t))) return false;
    if (tags.size && !e.tags.some((t) => tags.has(t))) return false;
    if (q && !`${e.title}\n${e.excerpt}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// entry point: URL-synced state inside <Suspense> (keeps the server page static/ISR)
// ---------------------------------------------------------------------------

export function ChangelogExplorer(props: ChangelogExplorerProps) {
  return (
    <Suspense fallback={<ExplorerView {...props} state={DEFAULT_STATE} />}>
      <UrlSyncedExplorer {...props} />
    </Suspense>
  );
}

function UrlSyncedExplorer(props: ChangelogExplorerProps) {
  const sp = useSearchParams();
  const state = useMemo(() => stateFromParams(new URLSearchParams(sp.toString())), [sp]);
  const onChange = useCallback(
    (patch: Partial<FilterState>) => {
      const qs = stateToParams({ ...state, ...patch }).toString();
      // native history update: Next syncs useSearchParams without a server round trip (the page
      // does not read searchParams, so router.replace would only re-download the same payload)
      window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
    },
    [state],
  );
  return <ExplorerView {...props} state={state} onChange={onChange} />;
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

interface ViewProps extends ChangelogExplorerProps {
  state: FilterState;
  onChange?: (patch: Partial<FilterState>) => void;
}

// Filter token of a venue: its bare id when no other kind uses that id ("okx"), else kind/id
// ("exchange/binance", "prediction/binance").
function venueTokens(venues: readonly VenueInfo[]): Map<string, string> {
  const perId = new Map<string, number>();
  for (const v of venues) perId.set(v.id, (perId.get(v.id) ?? 0) + 1);
  return new Map(venues.map((v) => [v.key, (perId.get(v.id) ?? 0) > 1 ? v.key : v.id]));
}

function ExplorerView({ entries, venues, today, state, onChange }: ViewProps) {
  const venueByKey = useMemo(() => new Map(venues.map((v) => [v.key, v])), [venues]);
  const tokenByKey = useMemo(() => venueTokens(venues), [venues]);
  const venueByToken = useMemo(() => new Map(venues.map((v) => [tokenByKey.get(v.key) ?? v.key, v])), [venues, tokenByKey]);
  const single = state.exchanges.length === 1 ? state.exchanges[0] : undefined;
  const singleKnown = single !== undefined && (venueByToken.has(single) || venues.some((v) => v.id === parseVenueToken(single).id));
  const history = useVenueHistory(singleKnown ? single : undefined, venueByKey);
  const set = onChange ?? (() => {});

  // With exactly one venue selected, swap in its full 365-day history (with bodies).
  const pool = useMemo(() => {
    if (!history.entries || !single) return entries;
    return [...entries.filter((e) => !matchesVenue(e, single)), ...history.entries]
      .sort((a, b) => b.date.localeCompare(a.date) || b.firstSeen.localeCompare(a.firstSeen));
  }, [entries, history.entries, single]);

  const visible = useMemo(() => applyFilter(pool, state, today), [pool, state, today]);
  const venueCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of applyFilter(entries, state, today, true)) {
      const token = tokenByKey.get(venueKey(e.kind, e.exchange)) ?? e.exchange;
      m.set(token, (m.get(token) ?? 0) + 1);
    }
    return m;
  }, [entries, state, today, tokenByKey]);

  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => setLimit(PAGE_SIZE), [state]);
  const groups = useMemo(() => groupByDay(visible.slice(0, limit)), [visible, limit]);
  const venueCount = new Set(visible.map((e) => venueKey(e.kind, e.exchange))).size;
  // the 1y range is offered with one venue selected, and stays visible (pressed) while it applies
  const ranges: number[] = [...DAY_RANGES];
  if (single || state.days === 365) ranges.push(365);
  if (!state.since && !ranges.includes(state.days)) ranges.push(state.days);
  ranges.sort((a, b) => a - b);

  return (
    <div className="not-prose flex flex-col gap-4">
      {/* toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border bg-fd-card p-3 sm:p-4" role="search" aria-label="Filter exchange changelogs">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchBox value={state.q} onChange={(q) => set({ q })} disabled={!onChange} />
          <div className="flex flex-wrap items-center gap-2">
            <VenuePicker venues={venues} tokens={tokenByKey} counts={venueCounts} selected={state.exchanges} onChange={(exchanges) => set({ exchanges })} disabled={!onChange} />
            <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Date range">
              {ranges.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={state.days === d}
                  disabled={!onChange}
                  onClick={() => set({ days: d, since: undefined })}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring ${state.days === d ? 'bg-fd-primary text-fd-primary-foreground' : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground'}`}
                >
                  {d === 365 ? '1y' : `${d}d`}
                  <span className="sr-only"> (last {d} days)</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
          {CHANGELOG_TAGS.map((t) => {
            const on = state.tags.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                disabled={!onChange}
                onClick={() => set({ tags: on ? state.tags.filter((x) => x !== t) : [...state.tags, t] })}
                className={`rounded-full border px-2.5 py-1 text-xs leading-4 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring ${on ? activeTagClass(t) : 'text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground'}`}
              >
                {on ? <Check className="-ml-0.5 mr-1 inline size-3" aria-hidden /> : null}
                {t}
              </button>
            );
          })}
        </div>

        {state.exchanges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-fd-muted-foreground">Exchanges:</span>
            {state.exchanges.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => set({ exchanges: state.exchanges.filter((x) => x !== id) })}
                className="inline-flex items-center gap-1 rounded-full border bg-fd-secondary px-2 py-0.5 text-xs font-medium text-fd-secondary-foreground hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
              >
                {venueByToken.get(id)?.name ?? id}
                <X className="size-3" aria-hidden />
                <span className="sr-only">Remove {id} filter</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* results bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fd-muted-foreground" aria-live="polite">
          <b className="text-fd-foreground">{visible.length}</b> {visible.length === 1 ? 'change' : 'changes'} across{' '}
          <b className="text-fd-foreground">{venueCount}</b> {venueCount === 1 ? 'venue' : 'venues'}
          {state.since ? ` since ${state.since}` : ` in the last ${state.days} days`}
          {single && history.loading ? ' · loading full history…' : null}
          {single && history.entries ? ' · full 365-day history' : null}
          {isFiltered(state) && onChange ? (
            <>
              {' · '}
              <button type="button" onClick={() => onChange({ ...DEFAULT_STATE })} className="font-medium text-fd-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">
                Clear filters
              </button>
            </>
          ) : null}
        </p>
        <SubscribePanel state={state} />
      </div>

      {/* timeline */}
      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
          <Inbox className="size-8 text-fd-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">{entries.length === 0 ? 'Changelog data is not available right now.' : 'No changes match these filters.'}</p>
          <p className="max-w-sm text-xs text-fd-muted-foreground">
            {entries.length === 0
              ? 'The collector feed could not be loaded. Please check back later.'
              : 'Try a longer date range, fewer tags, or another exchange.'}
          </p>
          {entries.length > 0 && isFiltered(state) && onChange ? (
            <button type="button" onClick={() => onChange({ ...DEFAULT_STATE })} className="mt-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <ol className="flex flex-col gap-5" aria-label="Changelog timeline">
          {groups.map((g) => (
            <li key={g.day}>
              <DayHeading day={g.day} today={today} count={g.entries.length} />
              <ul className="divide-y overflow-hidden rounded-xl border bg-fd-card">
                {g.entries.map((e) => (
                  <EntryRow key={e.id} entry={e} venue={venueByKey.get(venueKey(e.kind, e.exchange))} today={today} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {visible.length > limit ? (
        <button type="button" onClick={() => setLimit((l) => l + PAGE_SIZE)} className="self-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">
          Show more ({visible.length - limit} remaining)
        </button>
      ) : null}
    </div>
  );
}

function activeTagClass(tag: string): string {
  if (tag === 'breaking') return 'border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300';
  if (tag === 'deprecation') return 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'border-fd-primary bg-fd-primary text-fd-primary-foreground';
}

function tagChipClass(tag: string): string {
  if (tag === 'breaking') return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
  if (tag === 'deprecation') return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
  if (tag === 'new-endpoint') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return 'border-fd-border bg-fd-muted text-fd-muted-foreground';
}

function DayHeading({ day, today, count }: { day: string; today: string; count: number }) {
  const upcoming = day > today;
  return (
    <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fd-foreground">
      <time dateTime={day}>{formatDay(day)}</time>
      {day === today ? <span className="rounded-full bg-fd-primary/10 px-2 py-0.5 text-[11px] leading-4 font-medium text-fd-primary">Today</span> : null}
      {upcoming ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] leading-4 font-medium text-amber-700 dark:text-amber-300">
          <CalendarClock className="size-3" aria-hidden /> Upcoming
        </span>
      ) : null}
      <span className="text-xs font-normal text-fd-muted-foreground">
        {count} {count === 1 ? 'change' : 'changes'}
      </span>
    </h3>
  );
}

const EXTERNAL_REL = 'nofollow noopener noreferrer';

function EntryRow({ entry: e, venue, today }: { entry: ViewEntry; venue?: VenueInfo; today: string }) {
  const [open, setOpen] = useState(false);
  const textId = useId();
  const full = e.body && e.body.trim() !== e.excerpt.trim() ? e.body : undefined;
  const expandable = e.excerpt.length > 180 || Boolean(full);
  const upcoming = e.effectiveDate && e.effectiveDate > today;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <VenueBadge id={e.exchange} venue={venue} />
        {e.tags.map((t) => (
          <span key={t} className={`rounded-full border px-1.5 py-px text-[11px] leading-4 font-medium ${tagChipClass(t)}`}>
            {t}
          </span>
        ))}
        {upcoming ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 px-1.5 py-px text-[11px] leading-4 font-semibold text-amber-700 dark:text-amber-300">
            <CalendarClock className="size-3" aria-hidden />
            effective {e.effectiveDate}
          </span>
        ) : null}
      </div>
      <h4 className="text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">
        {e.href ? (
          <a href={e.href} target="_blank" rel={EXTERNAL_REL} className="text-fd-foreground decoration-fd-primary/50 underline-offset-2 hover:text-fd-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">
            {e.title}
            <ExternalLink className="ml-1 inline size-3.5 align-[-2px] text-fd-muted-foreground" aria-hidden />
            <span className="sr-only"> (opens the venue&apos;s changelog in a new tab)</span>
          </a>
        ) : (
          e.title
        )}
      </h4>
      {e.excerpt || full ? (
        <div>
          <p
            id={textId}
            className={`whitespace-pre-line text-sm text-fd-muted-foreground [overflow-wrap:anywhere] ${open ? '' : 'line-clamp-2'}`}
          >
            {open && full ? full : e.excerpt}
          </p>
          {expandable ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={textId}
              onClick={() => setOpen((v) => !v)}
              className="mt-0.5 text-xs font-medium text-fd-primary underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            >
              {open ? 'Show less' : full ? 'Show details' : 'Show more'}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fd-muted-foreground">
        {e.scope ? <span>scope: <span className="font-mono">{e.scope}</span></span> : null}
        {e.publishedAt && e.publishedAt !== e.date ? <span>published {e.publishedAt}</span> : null}
        {!e.publishedAt ? <span>first seen {e.firstSeen.slice(0, 10)}</span> : null}
        {e.sourceHref ? (
          <a href={e.sourceHref} target="_blank" rel={EXTERNAL_REL} className="inline-flex items-center gap-1 hover:text-fd-primary hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">
            source: {e.sourceHost}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
        <span className="italic opacity-80">third-party text</span>
      </div>
    </li>
  );
}

function VenueBadge({ id, venue }: { id: string; venue?: VenueInfo }) {
  const prediction = venue?.kind === 'prediction';
  const cls = `inline-flex items-center rounded-md border px-1.5 py-px font-mono text-[11px] leading-4 font-semibold ${prediction ? 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'border-fd-border bg-fd-secondary text-fd-secondary-foreground'}`;
  const label = venue?.name && venue.name !== id ? `${venue.name} (${id})` : id;
  if (!venue?.docPath) return <span className={cls} title={label}>{id}</span>;
  return (
    <Link href={venue.docPath} className={`${cls} hover:border-fd-primary hover:text-fd-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring`} title={`CCXT docs for ${label}`}>
      {id}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function SearchBox({ value, onChange, disabled }: { value: string; onChange: (q: string) => void; disabled?: boolean }) {
  const [text, setText] = useState(value);
  const id = useId();
  // last value this box pushed: only a different incoming value (Clear filters, back/forward)
  // resets the input, so the URL catching up never overwrites characters typed meanwhile
  const pushed = useRef(value);
  useEffect(() => {
    if (value.trim() === pushed.current.trim()) return;
    pushed.current = value;
    setText(value);
  }, [value]);
  useEffect(() => {
    if (text.trim() === pushed.current.trim()) return;
    const t = setTimeout(() => {
      pushed.current = text;
      onChange(text);
    }, 250);
    return () => clearTimeout(t);
    // only the typed text should trigger a URL update (not a changed onChange identity)
  }, [text]);
  return (
    <div className="relative w-full sm:max-w-xs">
      <label htmlFor={id} className="sr-only">Search changelog titles and excerpts</label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fd-muted-foreground" aria-hidden />
      <input
        id={id}
        type="search"
        value={text}
        disabled={disabled}
        onChange={(ev) => setText(ev.target.value)}
        placeholder="Search titles and excerpts…"
        className="w-full rounded-lg border bg-fd-background py-1.5 pl-8 pr-3 text-sm outline-none placeholder:text-fd-muted-foreground focus:border-fd-primary focus-visible:ring-2 focus-visible:ring-fd-ring/40"
      />
    </div>
  );
}

function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>, returnFocus: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) close();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        close();
        returnFocus.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref, returnFocus]);
}

function VenuePicker({
  venues, tokens, counts, selected, onChange, disabled,
}: {
  venues: VenueInfo[]; tokens: Map<string, string>; counts: Map<string, number>; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrap, button);
  const tokenOf = (v: VenueInfo) => tokens.get(v.key) ?? v.key;
  const sorted = useMemo(
    () => [...venues].sort((a, b) => (counts.get(tokens.get(b.key) ?? b.key) ?? 0) - (counts.get(tokens.get(a.key) ?? a.key) ?? 0) || a.name.localeCompare(b.name)),
    [venues, counts, tokens],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle ? sorted.filter((v) => v.id.includes(needle) || v.name.toLowerCase().includes(needle)) : sorted;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="relative" ref={wrap}>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border bg-fd-background px-2.5 py-1.5 text-sm font-medium hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
      >
        Exchanges
        {selected.length ? <span className="rounded-full bg-fd-primary px-1.5 text-[11px] leading-4 text-fd-primary-foreground">{selected.length}</span> : <span className="text-xs text-fd-muted-foreground">all</span>}
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Filter by exchange"
          className="absolute left-0 z-30 mt-1 w-[min(18rem,calc(100vw-2rem))] rounded-xl border bg-fd-popover p-2 text-fd-popover-foreground shadow-lg"
        >
          <label className="sr-only" htmlFor={`${panelId}-q`}>Search exchanges</label>
          <input
            id={`${panelId}-q`}
            autoFocus
            value={q}
            onChange={(ev) => setQ(ev.target.value)}
            placeholder="Search exchanges…"
            className="mb-2 w-full rounded-md border bg-fd-background px-2.5 py-1.5 text-sm outline-none focus:border-fd-primary"
          />
          <ul className="max-h-64 overflow-y-auto">
            {shown.map((v) => {
              const token = tokenOf(v);
              const n = counts.get(token) ?? 0;
              return (
                <li key={v.key}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-fd-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-fd-ring">
                    <input type="checkbox" className="size-3.5 accent-[var(--color-fd-primary)]" checked={selected.includes(token)} onChange={() => toggle(token)} />
                    <span className="min-w-0 flex-1 truncate">{v.name}</span>
                    <span className="font-mono text-[11px] leading-4 text-fd-muted-foreground">{v.id}{v.kind === 'prediction' ? ' · prediction' : ''}</span>
                    <span className={`w-6 text-right text-[11px] leading-4 tabular-nums ${n ? 'text-fd-foreground' : 'text-fd-muted-foreground/60'}`}>{n}</span>
                  </label>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-2 py-3 text-center text-xs text-fd-muted-foreground">No exchange matches “{q}”.</li> : null}
          </ul>
          <div className="mt-2 flex items-center justify-between border-t pt-2 text-xs">
            <span className="text-fd-muted-foreground">{selected.length ? `${selected.length} selected` : 'All exchanges'}</span>
            <span className="flex gap-2">
              {selected.length ? (
                <button type="button" onClick={() => onChange([])} className="font-medium text-fd-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">Clear</button>
              ) : null}
              <button type="button" onClick={() => { setOpen(false); button.current?.focus(); }} className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring">Done</button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SubscribePanel({ state }: { state: FilterState }) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState(siteUrl);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, wrap, button);
  useEffect(() => setOrigin(window.location.origin), []);
  const qs = stateToParams(state, true).toString();
  const withQs = (path: string, extra?: string) => {
    const all = [qs, extra].filter(Boolean).join('&');
    return `${origin}${basePath}${path}${all ? `?${all}` : ''}`;
  };
  const rows: { label: string; url: string; hint: string }[] = [
    { label: 'RSS', url: withQs(XML_FEED_PATH), hint: 'RSS 2.0, latest 100 items' },
    { label: 'Atom', url: withQs(XML_FEED_PATH, 'format=atom'), hint: 'Atom 1.0' },
    { label: 'JSON', url: withQs(JSON_FEED_PATH), hint: 'CCXT JSON (entries + venues)' },
    { label: 'JSON Feed', url: withQs(JSON_FEED_PATH, 'format=jsonfeed'), hint: 'JSON Feed 1.1' },
    { label: 'Markdown', url: `${origin}${basePath}${MD_PATH}`, hint: 'whole page, for LLM agents (unfiltered)' },
  ];
  return (
    <div className="relative" ref={wrap}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border bg-fd-background px-2.5 py-1.5 text-sm font-medium hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
      >
        <Rss className="size-4 text-orange-500" aria-hidden />
        Subscribe
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Feed URLs for the current filter"
          className="absolute right-0 z-30 mt-1 w-[min(32rem,calc(100vw-2rem))] rounded-xl border bg-fd-popover p-3 text-fd-popover-foreground shadow-lg"
        >
          <p className="mb-2 text-xs text-fd-muted-foreground">
            {qs ? 'Feeds for the current filter.' : 'Feeds for all venues.'} Pick exchanges or tags first to narrow them.
          </p>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <FeedUrlRow key={r.label} {...r} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function FeedUrlRow({ label, url, hint }: { label: string; url: string; hint: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      document.getElementById(id)?.focus();
      (document.getElementById(id) as HTMLInputElement | null)?.select();
    }
  };
  return (
    <li>
      <label htmlFor={id} className="mb-0.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold">{label}</span>
        <span className="truncate text-fd-muted-foreground">{hint}</span>
      </label>
      <div className="flex items-center gap-1">
        <input
          id={id}
          readOnly
          value={url}
          onFocus={(ev) => ev.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border bg-fd-background px-2 py-1 font-mono text-xs outline-none focus:border-fd-primary"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-fd-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
        >
          {copied ? <Check className="size-3.5 text-emerald-600" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
          <span className="sr-only"> {label} URL</span>
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// full history for a single selected venue (fetched from the JSON route)
// ---------------------------------------------------------------------------

// `token` is a venue filter token ("okx", "prediction/binance"); a bare id of a venue that exists
// under both kinds loads both (the route merges them).
function useVenueHistory(token: string | undefined, venueByKey: Map<string, VenueInfo>): { entries?: ViewEntry[]; loading: boolean } {
  const [state, setState] = useState<{ id?: string; entries?: ViewEntry[]; loading: boolean }>({ loading: false });
  // read through a ref: a new venues array identity must not refetch the history
  const venuesRef = useRef(venueByKey);
  venuesRef.current = venueByKey;
  useEffect(() => {
    if (!token) {
      setState({ loading: false });
      return;
    }
    const ctrl = new AbortController();
    setState({ id: token, loading: true });
    fetch(`${basePath}${JSON_FEED_PATH}?exchange=${encodeURIComponent(token)}&full=1`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        const list = (data as { entries?: unknown } | null)?.entries;
        if (!Array.isArray(list)) return setState({ id: token, loading: false });
        const entries = (list as Partial<ChangelogEntry>[])
          .map((raw) => toViewEntry(raw, venuesRef.current.get(venueKey(raw.kind === 'prediction' ? 'prediction' : 'exchange', String(raw.exchange ?? '')))))
          .filter((e) => e.id && e.title && matchesVenue(e, token));
        setState({ id: token, entries, loading: false });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setState({ id: token, loading: false });
      });
    return () => ctrl.abort();
  }, [token]);
  return state.id === token ? state : { loading: false };
}
