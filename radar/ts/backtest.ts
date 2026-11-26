// "Would have fired N times in the last 30 days", shown on confirmation cards.
// One cached historical request per (venue, market, kind); skipped quietly if the venue is unavailable.

import type { RuleSpec } from './rules.js';
import type { MarketState } from './market/state.js';

export type ExchangeGetter = (id: string) => any;

const cache = new Map<string, { at: number, rows: number[][] }> ();
const TTL = 3_600_000;

async function cached (key: string, load: () => Promise<number[][]>): Promise<number[][]> {
    const c = cache.get (key);
    if (c && Date.now () - c.at < TTL) {
        return c.rows;
    }
    const rows = await load ();
    cache.set (key, { at: Date.now (), rows });
    return rows;
}

function withTimeout<T> (p: Promise<T>, ms: number): Promise<T> {
    return Promise.race ([ p, new Promise<T> ((_, rej) => setTimeout (() => rej (new Error ('timeout')), ms)) ]);
}

// Count crossings in a series with the same arm/re-arm logic as the engine.
export function countCrossings (values: number[], cond: (v: number) => boolean, rearm: (v: number) => boolean): number {
    let armed = values.length ? !cond (values[0]) : true;
    let n = 0;
    for (const v of values) {
        if (armed && cond (v)) {
            n += 1;
            armed = false;
        } else if (!armed && rearm (v)) {
            armed = true;
        }
    }
    return n;
}

export async function backtest (spec: RuleSpec, state: MarketState, getEx: ExchangeGetter, timeoutMs = 8000): Promise<{ count: number, days: number, venue: string } | undefined> {
    try {
        if (spec.kind === 'price' || spec.kind === 'move') {
            const venue = spec.venue === 'median' ? ([ 'coinbase', 'kraken', 'okx', 'binance' ].find ((v) => state.resolve (v, spec.base, spec.market)) || '') : spec.venue;
            const r = venue ? state.resolve (venue, spec.base, spec.market) : undefined;
            if (!r) {
                return undefined;
            }
            const ex = getEx (venue);
            const bars = await withTimeout (cached ('ohlcv|' + venue + '|' + r.symbol, async () => await ex.fetchOHLCV (r.symbol, '1h', Date.now () - 30 * 86_400_000, 720)), timeoutMs);
            if (bars.length < 48) {
                return undefined;
            }
            if (spec.kind === 'price') {
                const T = spec.value;
                const closes = bars.map ((b) => b[4] / r.multiplier);
                const highs = bars.map ((b) => (spec.op === 'above' ? b[2] : b[3]) / r.multiplier);
                const series = highs.map ((h, i) => (spec.op === 'above' ? Math.max (h, closes[i]) : Math.min (h, closes[i])));
                const count = countCrossings (series, (v) => spec.op === 'above' ? v >= T : v <= T, (v) => spec.op === 'above' ? v <= T * 0.995 : v >= T * 1.005);
                return { count, days: Math.round (bars.length / 24), venue };
            }
            const w = Math.max (1, Math.round (spec.windowMin / 60));
            const pcts: number[] = [];
            for (let i = w; i < bars.length; i++) {
                pcts.push ((bars[i][4] - bars[i - w][4]) / bars[i - w][4] * 100);
            }
            const P = spec.pct;
            const cond = (v: number) => spec.direction === 'both' ? Math.abs (v) >= P : (spec.direction === 'up' ? v >= P : v <= -P);
            return { count: countCrossings (pcts, cond, (v) => Math.abs (v) < P * 0.6), days: Math.round (bars.length / 24), venue };
        }
        if (spec.kind === 'funding' && spec.base !== '*') {
            const venues = spec.venues.length ? spec.venues : [ ...state.funding.keys () ];
            const venue = venues.find ((v) => state.resolve (v, spec.base, 'perp'));
            if (!venue) {
                return undefined;
            }
            const r = state.resolve (venue, spec.base, 'perp')!;
            const ex = getEx (venue);
            if (!ex.has['fetchFundingRateHistory']) {
                return undefined;
            }
            const f = state.funding.get (venue)?.get (r.symbol);
            const intervalH = f ? f.intervalH : 8;
            const rows = await withTimeout (cached ('funding|' + venue + '|' + r.symbol, async () => {
                const hist = await ex.fetchFundingRateHistory (r.symbol, Date.now () - 30 * 86_400_000);
                return hist.map ((h: any) => [ h.timestamp, h.fundingRate ]);
            }), timeoutMs);
            if (rows.length < 10) {
                return undefined;
            }
            const values = rows.map ((x) => x[1] * 8 / intervalH);
            const cond = (v: number) => (spec.high !== null && v > spec.high) || (spec.low !== null && v < spec.low);
            const rearm = (v: number) => (spec.high === null || v < spec.high - 0.2 * Math.abs (spec.high)) && (spec.low === null || v > spec.low + 0.2 * Math.abs (spec.low));
            const days = Math.max (1, Math.round ((rows[rows.length - 1][0] - rows[0][0]) / 86_400_000));
            return { count: countCrossings (values, cond, rearm), days, venue };
        }
    } catch {
        return undefined;
    }
    return undefined;
}
