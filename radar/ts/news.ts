// News for the Daily Brief: publisher RSS feeds (headline + link only), clustered across publishers.
// Exploit reports become breaking events only when at least two independent publishers carry them.

import { createHash } from 'node:crypto';
import type { EventBus } from './events.js';

export interface NewsItem {
    publisher: string;
    title: string;
    link: string;
    published: number;
    description: string;
}

export interface NewsCluster {
    id: string;
    title: string;
    items: NewsItem[];
    publishers: string[];
    latest: number;
    summary?: string; // AI-condensed one-liner, number-checked against the sources
}

export const FEEDS: Array<{ publisher: string, url: string }> = [
    { publisher: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { publisher: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
    { publisher: 'The Block', url: 'https://www.theblock.co/rss.xml' },
    { publisher: 'Decrypt', url: 'https://decrypt.co/feed' },
];

const UA = 'ccxt-radar/0.1 (+https://github.com/ccxt/ccxt)';

function decode (s: string): string {
    return decodeEntities (s.replace (/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace (/<[^>]+>/g, ' '))
        .replace (/<[^>]+>/g, ' ') // entity-encoded HTML (e.g. &lt;p&gt;) becomes tags only after decoding
        .replace (/\s+/g, ' ')
        .trim ();
}

function decodeEntities (s: string): string {
    return s
        .replace (/&#(\d+);/g, (_, n) => String.fromCharCode (Number (n)))
        .replace (/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode (parseInt (n, 16)))
        .replace (/&quot;/g, '"').replace (/&apos;|&#39;/g, "'").replace (/&lt;/g, '<').replace (/&gt;/g, '>').replace (/&nbsp;/g, ' ').replace (/&amp;/g, '&');
}

function tag (block: string, name: string): string {
    const m = block.match (new RegExp ('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
    return m ? decode (m[1]) : '';
}

export function parseRss (xml: string, publisher: string): NewsItem[] {
    const items: NewsItem[] = [];
    for (const m of xml.matchAll (/<item[\s>][\s\S]*?<\/item>/gi)) {
        const block = m[0];
        const title = tag (block, 'title');
        let link = tag (block, 'link');
        if (!link) {
            const g = block.match (/<guid[^>]*>([\s\S]*?)<\/guid>/i);
            link = g ? decode (g[1]) : '';
        }
        const date = tag (block, 'pubDate') || tag (block, 'dc:date');
        const published = Date.parse (date);
        if (!title || !/^https?:\/\//.test (link)) {
            continue;
        }
        items.push ({ publisher, title, link, published: Number.isFinite (published) ? published : Date.now (), description: tag (block, 'description').slice (0, 400) });
    }
    return items;
}

const STOP = new Set ('a an the to of in on for and or with as at by from is are was be its it this that after over into says said amid new crypto cryptocurrency market markets price prices'.split (' '));

function tokens (title: string): Set<string> {
    return new Set (title.toLowerCase ().replace (/[^a-z0-9$ ]/g, ' ').split (/\s+/).filter ((w) => w.length > 2 && !STOP.has (w)));
}

function jaccard (a: Set<string>, b: Set<string>): number {
    let inter = 0;
    for (const x of a) {
        if (b.has (x)) {
            inter += 1;
        }
    }
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

export function clusterNews (items: NewsItem[], threshold = 0.34): NewsCluster[] {
    const sorted = [ ...items ].sort ((a, b) => b.published - a.published);
    const clusters: Array<NewsCluster & { tok: Set<string> }> = [];
    for (const it of sorted) {
        const tok = tokens (it.title);
        let best: (NewsCluster & { tok: Set<string> }) | undefined;
        let bestScore = 0;
        for (const c of clusters) {
            const s = jaccard (tok, c.tok);
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        if (best && bestScore >= threshold) {
            best.items.push (it);
            if (best.publishers.indexOf (it.publisher) === -1) {
                best.publishers.push (it.publisher);
            }
            best.latest = Math.max (best.latest, it.published);
            for (const t of tok) {
                best.tok.add (t);
            }
        } else {
            clusters.push ({ id: createHash ('sha1').update (it.link).digest ('hex').slice (0, 10), title: it.title, items: [ it ], publishers: [ it.publisher ], latest: it.published, tok });
        }
    }
    // Stable id: the oldest article's link, so a story keeps its id as more publishers cover it.
    return clusters.map (({ tok, ...c }) => {
        const oldest = c.items.reduce ((a, b) => (b.published < a.published ? b : a));
        return { ...c, id: createHash ('sha1').update (oldest.link).digest ('hex').slice (0, 10) };
    });
}

// Rank: more publishers first, then recency. Drops obvious sponsored/PR items.
export function rankClusters (clusters: NewsCluster[], sinceMs: number, now = Date.now ()): NewsCluster[] {
    return clusters
        .filter ((c) => c.latest >= now - sinceMs)
        .filter ((c) => !/sponsored|press release|\[pr\]|partner content/i.test (c.title))
        .sort ((a, b) => (b.publishers.length - a.publishers.length) || (b.latest - a.latest));
}

const EXPLOIT_RE = /\b(exploit(?:ed)?|hack(?:ed|er|ers)?|drain(?:ed)?|stolen|breach(?:ed)?|attack(?:er|ed)?)\b/i;

export class NewsDesk {
    items: NewsItem[] = [];
    clusters: NewsCluster[] = [];
    lastFetch = 0;
    lastErrors: string[] = [];
    bus?: EventBus;
    fetchFn: typeof fetch;
    summarizer?: (clusters: NewsCluster[]) => Promise<Record<string, string>>;

    constructor (bus?: EventBus, fetchFn: typeof fetch = fetch) {
        this.bus = bus;
        this.fetchFn = fetchFn;
    }

    async refresh (now = Date.now ()): Promise<void> {
        const all: NewsItem[] = [];
        const errors: string[] = [];
        await Promise.all (FEEDS.map (async (f) => {
            try {
                const res = await this.fetchFn (f.url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml, text/xml' }, redirect: 'follow', signal: AbortSignal.timeout (15_000) });
                if (!res.ok) {
                    throw new Error ('HTTP ' + res.status);
                }
                all.push (...parseRss (await res.text (), f.publisher));
            } catch (e: any) {
                errors.push (f.publisher + ': ' + (e?.message || e));
            }
        }));
        this.lastErrors = errors;
        if (all.length === 0) {
            return;
        }
        const keepSince = now - 48 * 3_600_000;
        const seen = new Set<string> ();
        this.items = [ ...all, ...this.items ].filter ((it) => {
            if (it.published < keepSince || seen.has (it.link)) {
                return false;
            }
            seen.add (it.link);
            return true;
        });
        const previous = new Map (this.clusters.map ((c) => [ c.id, c.summary ]));
        this.clusters = clusterNews (this.items);
        for (const c of this.clusters) {
            const s = previous.get (c.id);
            if (s) {
                c.summary = s;
            }
        }
        this.lastFetch = now;
        await this.summarize (now);
        this.detectExploits (now);
    }

    private async summarize (now: number): Promise<void> {
        if (!this.summarizer) {
            return;
        }
        const todo = rankClusters (this.clusters, 24 * 3_600_000, now).slice (0, 8).filter ((c) => !c.summary);
        if (todo.length === 0) {
            return;
        }
        try {
            const out = await this.summarizer (todo);
            for (const c of todo) {
                if (out[c.id]) {
                    c.summary = out[c.id];
                }
            }
        } catch (e: any) {
            this.lastErrors.push ('summarizer: ' + (e?.message || e));
        }
    }

    detectExploits (now = Date.now ()): void {
        if (!this.bus) {
            return;
        }
        for (const c of this.clusters) {
            if (c.publishers.length < 2 || c.latest < now - 6 * 3_600_000) {
                continue;
            }
            if (!c.items.some ((it) => EXPLOIT_RE.test (it.title))) {
                continue;
            }
            const sources = c.publishers.map ((p) => {
                const it = c.items.find ((x) => x.publisher === p)!;
                return { publisher: p, link: it.link };
            });
            this.bus.emit ({ key: 'exploit:' + c.id, type: 'exploit', data: { title: c.title, sources }, ts: now });
        }
    }

    top (n: number, now = Date.now ()): NewsCluster[] {
        return rankClusters (this.clusters, 24 * 3_600_000, now).slice (0, n);
    }

    about (term: string, sinceMs = 24 * 3_600_000, now = Date.now ()): NewsCluster[] {
        const re = new RegExp ('\\b' + term.replace (/[^a-z0-9]/gi, '') + '\\b', 'i');
        return rankClusters (this.clusters, sinceMs, now).filter ((c) => c.items.some ((it) => re.test (it.title)));
    }
}
