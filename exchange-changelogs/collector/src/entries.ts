// ParsedEntry (adapter output) -> ChangelogEntry candidate: filters, dates, ids, links, tags.
import { SCHEMA_VERSION } from './types.ts';
import type { ChangelogEntry, SourceConfig, VenueConfig } from './types.ts';
import type { ParsedEntry } from './adapters/types.ts';
import { extractDate, findDate, findEffectiveDate, isoDay, type DateOrder } from './dates.ts';
import { entryHash, entryId, entryKey, sha256 } from './ids.ts';
import { cleanBody, cleanTitle, makeExcerpt, markdownToPlain, oneLine, truncate } from './normalize.ts';
import { sharedTargets, type Registry } from './registry.ts';
import { ruleTags } from './tags.ts';

// Display titles built from a body summary are cut at a word boundary around this length.
export const SUMMARY_TITLE_CHARS = 140;

export interface BuildContext {
    venue: VenueConfig;
    source: SourceConfig;
    affects: string[];
    now: Date;
    firstRun: boolean;
    partitions?: Map<string, string>;   // filled with entry id -> ParsedEntry.partition (month sources)
}

export function sourceLink (source: SourceConfig): string {
    return source.link ?? source.url;
}

export function hostAllowed (host: string, domains: string[]): boolean {
    const h = host.toLowerCase ();
    return domains.some ((d) => h === d.toLowerCase () || h.endsWith ('.' + d.toLowerCase ()));
}

// https and on one of the venue's registry domains, else null
export function checkLink (href: string | undefined, domains: string[]): string | null {
    if (!href) {
        return null;
    }
    try {
        const u = new URL (href);
        return (u.protocol === 'https:' && hostAllowed (u.hostname, domains)) ? u.toString () : null;
    } catch {
        return null;
    }
}

export function applyFilters (source: SourceConfig, entries: ParsedEntry[]): ParsedEntry[] {
    const keep = source.titleFilter ? new RegExp (source.titleFilter, 'i') : null;
    const drop = source.excludeFilter ? new RegExp (source.excludeFilter, 'i') : null;
    return entries.filter ((e) => {
        if (keep && !keep.test (e.title) && !(e.categories ?? []).some ((c) => keep.test (c))) {
            return false;
        }
        return !(drop && drop.test (e.title));
    });
}

// Anchors are slugs ("november-12-2026", "27-october-2026-—-spot"): retry with dashes as spaces.
export function anchorDate (anchor: string | undefined, order: DateOrder | undefined, now: Date, pattern?: string): string | null {
    if (!anchor) {
        return null;
    }
    return extractDate (anchor, pattern, order, now) ?? extractDate (anchor.replace (/[-_]+/g, ' '), pattern, order, now);
}

// The date the venue put on the entry, from the configured location (stable: used in the id).
export function baseDate (raw: ParsedEntry, title: string, body: string, source: SourceConfig, now: Date): string | null {
    const cfg = source.date ?? {};
    const from = cfg.from ?? (source.type === 'rss' ? 'pubDate' : undefined);
    const order = cfg.order;
    const pick = (text: string | undefined) => extractDate (text, cfg.pattern, order, now);
    if (from === 'anchor') {
        return anchorDate (raw.anchor, order, now, cfg.pattern) ?? findDate (raw.context, order, now);
    }
    if (from) {
        const text = { title, body, pubDate: raw.dateText }[from];
        return pick (text) ?? findDate (raw.context, order, now);
    }
    return pick (raw.dateText) ?? pick (title) ?? findDate (raw.context, order, now) ?? anchorDate (raw.anchor, order, now, cfg.pattern) ?? pick (body);
}

// True when a text says nothing beyond a date or version ("2026-11-05", "v1.2.0 (2026-11-05)",
// "Release 10.11.2026").
export function dateOrVersionOnly (text: string): boolean {
    const words = text.replace (/\b(?:20\d\d|\d{1,2}(?:st|nd|rd|th)?|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*|v?\d+(?:\.\d+)+|release|update[sd]?|changelog|change log|changes|version)\b/gi, '')
        .replace (/[^\p{L}]+/gu, '');
    return words.length < 3;
}

// Headings like "2026-11-05" or "v1.2.0 (2026-11-05)" say nothing in a timeline: append a
// summary of the body (see bodySummary), cut at a word boundary. Ids still use the raw title.
export function displayTitle (title: string, body: string): string {
    if (!dateOrVersionOnly (title)) {
        return title;
    }
    const summary = bodySummary (body);
    if (!summary) {
        return title;
    }
    return cleanTitle (`${title}: ${truncate (summary, SUMMARY_TITLE_CHARS)}`);
}

const BULLET = /^[-*+]\s+|^\d+[.)]\s+/;
const SKIP_LINE = /^(?:#{1,6}\s|\||```|~~~|>\s*\[!|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
// "Testnet: Jul 10th, 2026 06:00 UTC", "**Mainnet:** ...": rollout schedule lines, not the change
const SCHEDULE_BULLET = /^(?:\*\*|__)?(?:testnet|mainnet|demo(?: trading)?|production|prod|live(?: trading)?|sandbox|staging|uat|downtime|release date|effective (?:date|time)|date|time)(?:\*\*|__)?\s*:/i;
const HEADING_LIKE_WORDS = 16;
const HEADING_LIKE_CHARS = 120;

// First paragraph of lines (plain text), from line index `from` up to `to` (exclusive).
function firstParagraph (lines: string[], from: number, to: number): string {
    const parts: string[] = [];
    for (const l of lines.slice (from, to)) {
        const t = l.trim ().replace (/^>\s*/, '');
        if (!t || SKIP_LINE.test (t)) {
            if (parts.length) {
                break;
            }
            continue;
        }
        parts.push (t);
    }
    return markdownToPlain (parts.join (' '));
}

// A short line that reads like a heading ("Delayed publication of large Block RFQ trades"), not a
// sentence ("No removed endpoints. Two behaviour changes ..."), a label ("REST and WebSocket API:")
// or a bare date (Gate: "2026-11-03" above the list).
function headingLike (text: string): boolean {
    return text.length > 0 && text.length <= HEADING_LIKE_CHARS && text.split (/\s+/).length <= HEADING_LIKE_WORDS && !/[.:;,!?]$/.test (text) && !dateOrVersionOnly (text);
}

// A heading-like first paragraph before any list (Deribit RSS: "Delayed publication of ...", then
// prose, then bullets), else the first top-level bullet that is not a rollout schedule line
// ("Testnet: <date>", "Mainnet: <date>"), with its continuation lines, else the first paragraph.
export function bodySummary (body: string): string {
    const lines = body.split ('\n');
    const bullets = lines.map ((l, i) => (BULLET.test (l) ? i : -1)).filter ((i) => i !== -1);
    const firstBullet = bullets.length ? bullets[0] : lines.length;
    const lead = firstParagraph (lines, 0, firstBullet);
    if (bullets.length && headingLike (lead)) {
        return lead;
    }
    const start = bullets.find ((i) => !SCHEDULE_BULLET.test (lines[i].replace (BULLET, '').trim ())) ?? bullets[0];
    if (start === undefined) {
        return firstParagraph (lines, 0, lines.length).replace (/[:;,]\s*$/, '');
    }
    const parts: string[] = [ lines[start].replace (BULLET, '') ];
    for (const l of lines.slice (start + 1)) {
        // continuation: indented, not a nested bullet, not blank
        if (!l.trim () || !/^\s+\S/.test (l) || BULLET.test (l.trim ())) {
            break;
        }
        parts.push (l.trim ());
    }
    return markdownToPlain (parts.join (' ')).replace (/[:;,]\s*$/, '');
}

// Body characters that tell apart entries sharing a key (same date and title, or same undated title).
const DISCRIMINATOR_CHARS = 200;

// Ids for one run. The key is `source|guid` or `source|date|title`, where `date` never comes from
// the body (a body edit must stay a revision, not re-key the entry). Keys shared by several
// entries are disambiguated by content, counting from the bottom of the page: the bottom-most
// keeps the plain key (changelogs are newest first, so a new item on top never takes over an
// older item's id), the others get a hash of the start of their body, and only identical bodies
// fall back to a position suffix (also counted from the bottom).
export function assignKeys (items: { base: string; body: string }[]): string[] {
    const groups = new Map<string, number[]> ();
    items.forEach ((it, i) => groups.set (it.base, [ ...(groups.get (it.base) ?? []), i ]));
    const keys = items.map ((it) => it.base);
    for (const [ base, idx ] of groups) {
        if (idx.length < 2) {
            continue;
        }
        const used = new Set<string> ([ base ]);
        for (const i of idx.slice (0, -1).reverse ()) {
            const withBody = `${base}|b:${sha256 (oneLine (items[i].body).toLowerCase ().slice (0, DISCRIMINATOR_CHARS)).slice (0, 16)}`;
            let key = withBody;
            for (let n = 2; used.has (key); n++) {
                key = `${withBody}|#${n}`;
            }
            used.add (key);
            keys[i] = key;
        }
    }
    return keys;
}

export function buildEntries (raws: ParsedEntry[], ctx: BuildContext): ChangelogEntry[] {
    const { venue, source, now } = ctx;
    const nowIso = now.toISOString ();
    const today = isoDay (now);
    const link = sourceLink (source);
    const prepared: { raw: ParsedEntry; title: string; body: string; date: string | null; base: string }[] = [];
    for (const raw of applyFilters (source, raws)) {
        const title = cleanTitle (raw.title);
        if (!title) {
            continue;
        }
        const body = cleanBody (raw.body ?? '');
        // hash sources: the body lists added page lines, any date in them is not the change date
        const synthetic = source.type === 'hash';
        const date = synthetic ? null : baseDate (raw, title, body, source, now);
        const idDate = synthetic ? null : baseDate (raw, title, '', source, now);
        prepared.push ({ raw, title, body, date, base: entryKey (source.id, raw.guid, idDate, title) });
    }
    const keys = assignKeys (prepared);
    const out: ChangelogEntry[] = [];
    prepared.forEach (({ raw, title, body, date }, i) => {
        const synthetic = source.type === 'hash';
        const stated = synthetic ? null : findEffectiveDate (title + '\n' + body, source.date?.order, now);
        // rss: a dated link fragment that differs from pubDate is the scheduled date (Kalshi "#november-12-2026")
        let fragment: string | null = null;
        if (source.type === 'rss' && raw.anchor) {
            const f = anchorDate (raw.anchor, source.date?.order, now);
            fragment = (f && f !== extractDate (raw.dateText, undefined, source.date?.order, now)) ? f : null;
        }
        let publishedAt: string | null = date;
        let effectiveDate: string | undefined = fragment ?? stated ?? undefined;
        if (date && date > today) {
            // future-dated heading/item = scheduled change. A date read with an explicit
            // date.pattern is the one the registry chose ("live trading expected on <date>"), so it
            // wins over the first effective-date phrase in the body ("demo trading on <date>").
            publishedAt = null;
            effectiveDate = source.date?.pattern ? (fragment ?? date) : (effectiveDate ?? date);
        }
        if (effectiveDate && publishedAt && effectiveDate === publishedAt) {
            effectiveDate = undefined;
        }
        const candidateUrl = raw.link ?? (raw.anchor ? `${link.split ('#')[0]}#${encodeURIComponent (raw.anchor)}` : undefined);
        const checked = checkLink (candidateUrl, venue.domains);
        const tags = ruleTags (title, body);
        if (candidateUrl && !checked) {
            tags.push ('link-rewritten');
        }
        const id = entryId (keys[i]);
        if (raw.partition && ctx.partitions) {
            ctx.partitions.set (id, raw.partition);
        }
        out.push ({
            schemaVersion: SCHEMA_VERSION,
            id,
            kind: venue.kind,
            exchange: venue.id,
            affects: ctx.affects,
            source: source.id,
            sourceType: source.type,
            sourceLink: link,
            ...(source.scope ? { scope: source.scope } : {}),
            title: displayTitle (title, body),
            excerpt: makeExcerpt (body) || title,
            body,
            url: checked ?? link,
            publishedAt,
            ...(effectiveDate ? { effectiveDate } : {}),
            dateKind: effectiveDate ? 'effective' : (publishedAt ? 'published' : 'firstSeen'),
            firstSeen: nowIso,
            lastSeen: nowIso,
            hash: entryHash (title, body),
            backfill: ctx.firstRun,
            tags,
            ccxt: { status: 'new' },
        });
    });
    return out;
}

// ccxt ids an entry affects: the venue, its subclasses, and every sharedWith venue (+ subclasses).
export function affectsFor (venue: VenueConfig, source: SourceConfig, registry: Registry): string[] {
    const ids = [ venue.id, ...(venue.subclasses ?? []) ];
    for (const other of sharedTargets (registry, venue, source)) {
        ids.push (other.id, ...(other.subclasses ?? []));
    }
    return [ ...new Set (ids) ];
}
