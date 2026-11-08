// Macro calendar: FOMC decisions (Federal Reserve calendar) and US CPI / jobs releases (BLS iCal feed).
// Both are official, public-domain sources.

export interface MacroEvent {
    id: string;
    title: string;
    at: number; // ms UTC
    source: string;
}

function etToUtc (y: number, mo: number, d: number, h: number, mi: number): number {
    // Find the UTC instant whose New York wall time equals the given time.
    const guess = Date.UTC (y, mo - 1, d, h + 5, mi);
    for (const off of [ 4, 5 ]) {
        const t = Date.UTC (y, mo - 1, d, h + off, mi);
        const s = new Intl.DateTimeFormat ('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format (new Date (t));
        if (s === String (h).padStart (2, '0') + ':' + String (mi).padStart (2, '0')) {
            return t;
        }
    }
    return guess;
}

// 2026 FOMC meetings: the statement is released at 2:00 pm ET on the second day.
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
const FOMC_2026: Array<[number, number]> = [ [ 1, 28 ], [ 3, 18 ], [ 4, 29 ], [ 6, 17 ], [ 7, 29 ], [ 9, 16 ], [ 10, 28 ], [ 12, 9 ] ];

export function fomcEvents (): MacroEvent[] {
    return FOMC_2026.map (([ m, d ]) => ({ id: 'fomc-2026-' + m + '-' + d, title: 'FOMC rate decision', at: etToUtc (2026, m, d, 14, 0), source: 'Federal Reserve' }));
}

export function parseBlsIcs (ics: string): MacroEvent[] {
    const out: MacroEvent[] = [];
    for (const block of ics.split ('BEGIN:VEVENT').slice (1)) {
        const summary = (block.match (/SUMMARY[^:]*:(.+)/) || [])[1]?.trim () || '';
        let title: string | undefined;
        if (/Consumer Price Index/i.test (summary)) {
            title = 'US CPI';
        } else if (/Employment Situation/i.test (summary)) {
            title = 'US jobs report';
        } else if (/Producer Price Index/i.test (summary)) {
            title = 'US PPI';
        }
        if (!title) {
            continue;
        }
        const dt = block.match (/DTSTART([^:]*):(\d{8})T?(\d{4})?/);
        if (!dt) {
            continue;
        }
        const y = Number (dt[2].slice (0, 4));
        const mo = Number (dt[2].slice (4, 6));
        const d = Number (dt[2].slice (6, 8));
        const hm = dt[3] || '0830';
        const at = /Z$/.test (block.match (/DTSTART[^\n]*/)?.[0] || '')
            ? Date.UTC (y, mo - 1, d, Number (hm.slice (0, 2)), Number (hm.slice (2, 4)))
            : etToUtc (y, mo, d, Number (hm.slice (0, 2)), Number (hm.slice (2, 4)));
        out.push ({ id: 'bls-' + title.replace (/\W/g, '') + '-' + dt[2], title, at, source: 'BLS' });
    }
    return out;
}

export class MacroCalendar {
    events: MacroEvent[] = fomcEvents ();
    lastError?: string;
    fetchFn: typeof fetch;

    constructor (fetchFn: typeof fetch = fetch) {
        this.fetchFn = fetchFn;
    }

    async refresh (): Promise<void> {
        try {
            const res = await this.fetchFn ('https://www.bls.gov/schedule/news_release/bls.ics', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ccxt-radar/0.1; +https://github.com/ccxt/ccxt)' }, signal: AbortSignal.timeout (15_000) });
            if (!res.ok) {
                throw new Error ('HTTP ' + res.status);
            }
            const bls = parseBlsIcs (await res.text ());
            if (bls.length) {
                this.events = [ ...fomcEvents (), ...bls ].sort ((a, b) => a.at - b.at);
            }
            this.lastError = undefined;
        } catch (e: any) {
            this.lastError = String (e?.message || e); // keep FOMC dates; CPI dates are skipped until the feed answers
        }
    }

    upcoming (fromMs: number, toMs: number): MacroEvent[] {
        return this.events.filter ((e) => e.at >= fromMs && e.at < toMs);
    }
}
