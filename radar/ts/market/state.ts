// Shared, in-memory market state. Ingestion writes it once per venue; every rule and user reads the same data.

import { MAJORS, MEDIAN_VENUES, STABLECOINS } from '../config.js';
import type { MarketKind } from '../rules.js';

export interface Tick {
    last?: number;
    bid?: number;
    ask?: number;
    mark?: number;
    pct24?: number;
    quoteVolume?: number;
    ts: number; // when we observed it (exchange timestamp if newer data was not available)
}

export interface Funding {
    rate: number; // per interval, fraction
    intervalH: number;
    intervalAssumed: boolean;
    settleTs?: number;
    mark?: number;
    ts: number;
}

export interface WalletNet {
    deposit?: boolean;
    withdraw?: boolean;
}

export interface VenueHealth {
    lastOk: number;
    lastError?: string;
    lastErrorAt?: number;
    consecutiveErrors: number;
    exchangeStatus?: string; // from fetchStatus
    degradedSince?: number;
}

export interface MarketInfo {
    symbol: string;
    base: string;
    quote: string;
    settle?: string;
    type: string;
    linear?: boolean;
    contractSize?: number;
    active?: boolean;
    taker?: number;
}

// Fixed-capacity ring buffer of (time, value) samples, used for % move windows and OI windows.
export class Ring {
    readonly cap: number;
    readonly minGapMs: number;
    private t: Float64Array;
    private v: Float64Array;
    private head = 0; // next write position
    private size = 0;

    constructor (cap: number, minGapMs: number) {
        this.cap = cap;
        this.minGapMs = minGapMs;
        this.t = new Float64Array (cap);
        this.v = new Float64Array (cap);
    }

    push (time: number, value: number): void {
        if (!Number.isFinite (value)) {
            return;
        }
        if (this.size > 0) {
            const lastIdx = (this.head - 1 + this.cap) % this.cap;
            if (time - this.t[lastIdx] < this.minGapMs) {
                this.v[lastIdx] = value; // keep the latest value within the gap, without adding a sample
                return;
            }
        }
        this.t[this.head] = time;
        this.v[this.head] = value;
        this.head = (this.head + 1) % this.cap;
        this.size = Math.min (this.size + 1, this.cap);
    }

    get length (): number {
        return this.size;
    }

    latest (): { t: number, v: number } | undefined {
        if (this.size === 0) {
            return undefined;
        }
        const i = (this.head - 1 + this.cap) % this.cap;
        return { t: this.t[i], v: this.v[i] };
    }

    oldest (): { t: number, v: number } | undefined {
        if (this.size === 0) {
            return undefined;
        }
        const i = (this.head - this.size + this.cap) % this.cap;
        return { t: this.t[i], v: this.v[i] };
    }

    // The latest sample at or before `time`.
    at (time: number): { t: number, v: number } | undefined {
        let lo = 0;
        let hi = this.size - 1;
        let found = -1;
        const start = (this.head - this.size + this.cap) % this.cap;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const idx = (start + mid) % this.cap;
            if (this.t[idx] <= time) {
                found = idx;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return found === -1 ? undefined : { t: this.t[found], v: this.v[found] };
    }

    // Min and max values in [from, now].
    range (from: number): { min: number, max: number } | undefined {
        if (this.size === 0) {
            return undefined;
        }
        let min = Infinity;
        let max = -Infinity;
        const start = (this.head - this.size + this.cap) % this.cap;
        for (let k = 0; k < this.size; k++) {
            const idx = (start + k) % this.cap;
            if (this.t[idx] >= from) {
                min = Math.min (min, this.v[idx]);
                max = Math.max (max, this.v[idx]);
            }
        }
        return Number.isFinite (min) ? { min, max } : undefined;
    }
}

// Multiplied perp contracts: the venue lists 1000 units (or k units) as one contract.
export const MULTIPLIER_PREFIXES: Array<{ prefix: string, mult: number }> = [
    { prefix: '1000000', mult: 1_000_000 },
    { prefix: '10000', mult: 10_000 },
    { prefix: '1000', mult: 1000 },
    { prefix: 'k', mult: 1000 },
];

export function intervalHours (interval: string | undefined): { hours: number, assumed: boolean } {
    if (interval) {
        const m = String (interval).match (/^(\d+)(h|m)$/);
        if (m) {
            const n = Number (m[1]);
            return { hours: m[2] === 'h' ? n : n / 60, assumed: false };
        }
    }
    return { hours: 8, assumed: true };
}

export function to8h (f: Pick<Funding, 'rate' | 'intervalH'>): number {
    return f.rate * (8 / f.intervalH);
}

export function toApr (f: Pick<Funding, 'rate' | 'intervalH'>): number {
    return f.rate * (24 / f.intervalH) * 365;
}

const HISTORY_CAP = 3000; // 25h at 30s spacing

export class MarketState {
    tickers = new Map<string, Map<string, Tick>> ();
    funding = new Map<string, Map<string, Funding>> ();
    openInterest = new Map<string, Map<string, { value: number, ts: number }>> ();
    markets = new Map<string, Map<string, MarketInfo>> ();
    wallets = new Map<string, Map<string, Map<string, WalletNet>>> (); // venue -> code -> network -> status
    walletsAvailable = new Set<string> ();
    health = new Map<string, VenueHealth> ();
    history = new Map<string, Ring> ();
    watched = new Set<string> (); // keys "venue|symbol" whose history we keep
    watchedBases = new Set<string> (MAJORS); // bases with a median price history

    now: () => number = () => Date.now ();

    // ---------------------------------------------------------------- writes

    setMarkets (venue: string, list: MarketInfo[]): void {
        const m = new Map<string, MarketInfo> ();
        for (const info of list) {
            m.set (info.symbol, info);
        }
        this.markets.set (venue, m);
    }

    setTickers (venue: string, ticks: Map<string, Tick>): void {
        let current = this.tickers.get (venue);
        if (!current) {
            current = new Map ();
            this.tickers.set (venue, current);
        }
        for (const [ symbol, t ] of ticks) {
            current.set (symbol, t);
            const key = venue + '|' + symbol;
            if (this.watched.has (key) && t.last !== undefined) {
                this.ring (key).push (t.ts, t.last);
            }
        }
        this.ok (venue);
    }

    setFunding (venue: string, rows: Map<string, Funding>): void {
        this.funding.set (venue, rows);
        this.ok (venue);
    }

    setOpenInterest (venue: string, symbol: string, value: number, ts: number): void {
        let m = this.openInterest.get (venue);
        if (!m) {
            m = new Map ();
            this.openInterest.set (venue, m);
        }
        m.set (symbol, { value, ts });
        this.ring ('oi|' + venue + '|' + symbol, 60_000).push (ts, value);
    }

    setWallets (venue: string, data: Map<string, Map<string, WalletNet>>): void {
        this.wallets.set (venue, data);
        this.walletsAvailable.add (venue);
    }

    ok (venue: string): void {
        const h = this.healthOf (venue);
        h.lastOk = this.now ();
        h.consecutiveErrors = 0;
    }

    error (venue: string, err: unknown): void {
        const h = this.healthOf (venue);
        h.consecutiveErrors += 1;
        h.lastError = err instanceof Error ? (err.constructor.name + ': ' + err.message).slice (0, 200) : String (err);
        h.lastErrorAt = this.now ();
    }

    healthOf (venue: string): VenueHealth {
        let h = this.health.get (venue);
        if (!h) {
            h = { lastOk: 0, consecutiveErrors: 0 };
            this.health.set (venue, h);
        }
        return h;
    }

    ring (key: string, minGapMs = 30_000): Ring {
        let r = this.history.get (key);
        if (!r) {
            r = new Ring (HISTORY_CAP, minGapMs);
            this.history.set (key, r);
        }
        return r;
    }

    // Recompute median prices for watched bases and push them into history.
    updateMedians (): void {
        const now = this.now ();
        for (const base of this.watchedBases) {
            const med = this.medianPrice (base);
            if (med) {
                this.ring ('median|' + base).push (now, med.price);
            }
        }
    }

    // ---------------------------------------------------------------- reads

    // A venue is degraded when it has not answered for a while or reports maintenance.
    isDegraded (venue: string, maxSilenceMs = 60_000): boolean {
        const h = this.health.get (venue);
        if (!h || h.lastOk === 0) {
            return true;
        }
        if (h.exchangeStatus && h.exchangeStatus !== 'ok') {
            return true;
        }
        return this.now () - h.lastOk > maxSilenceMs;
    }

    // Resolve a coin like "ETH" to a concrete market symbol on a venue.
    resolve (venue: string, baseIn: string, kind: MarketKind, quote?: string): { symbol: string, multiplier: number } | undefined {
        const mk = this.markets.get (venue);
        if (!mk) {
            return undefined;
        }
        const baseU = baseIn.toUpperCase ();
        if (kind === 'spot') {
            const quotes = quote ? [ quote.toUpperCase () ] : [ 'USDT', 'USD', 'USDC' ];
            for (const q of quotes) {
                const s = baseU + '/' + q;
                const info = mk.get (s);
                if (info && info.type === 'spot' && info.active !== false) {
                    return { symbol: s, multiplier: 1 };
                }
            }
            return undefined;
        }
        const settles = [ 'USDT', 'USDC' ];
        const prefixes = [ { prefix: '', mult: 1 }, ...MULTIPLIER_PREFIXES ];
        for (const settle of settles) {
            for (const p of prefixes) {
                const s = p.prefix + baseU + '/' + settle + ':' + settle;
                const info = mk.get (s);
                if (info && info.type === 'swap' && info.active !== false) {
                    return { symbol: s, multiplier: p.mult };
                }
            }
        }
        return undefined;
    }

    // Base coin with the multiplier prefix removed ("1000PEPE" -> "PEPE").
    static normalizeBase (base: string): { base: string, multiplier: number } {
        for (const p of MULTIPLIER_PREFIXES) {
            if (base.startsWith (p.prefix) && base.length > p.prefix.length && /^[A-Z]/.test (base.slice (p.prefix.length))) {
                return { base: base.slice (p.prefix.length), multiplier: p.mult };
            }
        }
        return { base, multiplier: 1 };
    }

    tick (venue: string, symbol: string): Tick | undefined {
        return this.tickers.get (venue)?.get (symbol);
    }

    // Fresh price for a market. `field` 'mark' falls back to funding mark price.
    price (venue: string, symbol: string, field: 'last' | 'mark' = 'last', maxAgeMs = 60_000): { value: number, ts: number } | undefined {
        const now = this.now ();
        const t = this.tick (venue, symbol);
        if (field === 'mark') {
            if (t && t.mark !== undefined && now - t.ts <= maxAgeMs) {
                return { value: t.mark, ts: t.ts };
            }
            const f = this.funding.get (venue)?.get (symbol);
            if (f && f.mark !== undefined && now - f.ts <= Math.max (maxAgeMs, 180_000)) {
                return { value: f.mark, ts: f.ts };
            }
            return undefined;
        }
        if (t && t.last !== undefined && now - t.ts <= maxAgeMs) {
            return { value: t.last, ts: t.ts };
        }
        return undefined;
    }

    // Approximate USD value of a stablecoin, from USD pairs (Kraken, Coinbase) or 1 if unknown.
    stableUsd (code: string): number {
        if (code === 'USD') {
            return 1;
        }
        const values: number[] = [];
        for (const venue of [ 'kraken', 'coinbase' ]) {
            const p = this.price (venue, code + '/USD');
            if (p) {
                values.push (p.value);
            }
        }
        return values.length ? median (values) : 1;
    }

    // Median spot price in USD across MEDIAN_VENUES (falls back to any core venue).
    medianPrice (base: string, maxAgeMs = 60_000): { price: number, venues: string[], ts: number } | undefined {
        const pts: Array<{ venue: string, usd: number, ts: number }> = [];
        const venues = [ ...MEDIAN_VENUES, ...[ ...this.tickers.keys () ].filter ((v) => MEDIAN_VENUES.indexOf (v) === -1) ];
        for (const venue of venues) {
            const r = this.resolve (venue, base, 'spot');
            if (!r) {
                continue;
            }
            const p = this.price (venue, r.symbol, 'last', maxAgeMs);
            if (!p) {
                continue;
            }
            const quote = r.symbol.split ('/')[1];
            const usd = p.value * this.stableUsd (quote);
            pts.push ({ venue, usd, ts: p.ts });
            if (pts.length >= 5) {
                break;
            }
        }
        if (pts.length === 0) {
            return undefined;
        }
        return { price: median (pts.map ((p) => p.usd)), venues: pts.map ((p) => p.venue), ts: Math.min (...pts.map ((p) => p.ts)) };
    }

    // Spot prices for a base on every venue that lists it, in the market's own quote.
    pricesAcross (base: string, kind: MarketKind = 'spot'): Array<{ venue: string, symbol: string, price: number, usd: number, pct24?: number, ts: number }> {
        const rows: Array<{ venue: string, symbol: string, price: number, usd: number, pct24?: number, ts: number }> = [];
        for (const venue of this.tickers.keys ()) {
            const r = this.resolve (venue, base, kind);
            if (!r) {
                continue;
            }
            const t = this.tick (venue, r.symbol);
            const p = this.price (venue, r.symbol);
            if (!t || !p) {
                continue;
            }
            const quote = r.symbol.split ('/')[1].split (':')[0];
            rows.push ({ venue, symbol: r.symbol, price: p.value, usd: p.value * this.stableUsd (quote) / r.multiplier, pct24: t.pct24, ts: p.ts });
        }
        return rows;
    }

    fundingAcross (base: string): Array<{ venue: string, symbol: string, f: Funding, multiplier: number }> {
        const out: Array<{ venue: string, symbol: string, f: Funding, multiplier: number }> = [];
        for (const [ venue, rows ] of this.funding) {
            const r = this.resolve (venue, base, 'perp');
            if (!r) {
                continue;
            }
            const f = rows.get (r.symbol);
            if (f) {
                out.push ({ venue, symbol: r.symbol, f, multiplier: r.multiplier });
            }
        }
        return out;
    }

    // Top perps on a venue by 24h quote volume (used for '*' funding rules and boards).
    topPerps (venue: string, n: number): string[] {
        const t = this.tickers.get (venue);
        const mk = this.markets.get (venue);
        if (!t || !mk) {
            return [];
        }
        const rows: Array<{ s: string, qv: number }> = [];
        for (const [ s, tick ] of t) {
            const info = mk.get (s);
            if (info && info.type === 'swap' && info.linear !== false && tick.quoteVolume) {
                rows.push ({ s, qv: tick.quoteVolume });
            }
        }
        rows.sort ((a, b) => b.qv - a.qv);
        return rows.slice (0, n).map ((r) => r.s);
    }

    // Bases whose perp is in the top-N by volume on at least `minVenues` venues (filters single-venue junk perps).
    liquidPerpBases (n: number, minVenues = 2): Set<string> {
        const counts = new Map<string, number> ();
        for (const venue of this.tickers.keys ()) {
            const seen = new Set<string> ();
            for (const s of this.topPerps (venue, n)) {
                const info = this.markets.get (venue)?.get (s);
                if (info) {
                    seen.add (MarketState.normalizeBase (info.base).base);
                }
            }
            for (const b of seen) {
                counts.set (b, (counts.get (b) || 0) + 1);
            }
        }
        return new Set ([ ...counts ].filter (([ , c ]) => c >= minVenues).map (([ b ]) => b));
    }

    // Percent change over a window from history. Returns undefined until enough history exists.
    change (key: string, windowMs: number): { pct: number, from: number, to: number, fromTs: number, toTs: number } | undefined {
        const r = this.history.get (key);
        if (!r) {
            return undefined;
        }
        const last = r.latest ();
        const first = r.oldest ();
        if (!last || !first) {
            return undefined;
        }
        // require the history to cover at least 90% of the window
        if (last.t - first.t < windowMs * 0.9) {
            return undefined;
        }
        const then = r.at (last.t - windowMs) || first; // history covers >= 90% of the window: measure from the oldest sample
        if (!then || then.v === 0) {
            return undefined;
        }
        return { pct: (last.v - then.v) / then.v * 100, from: then.v, to: last.v, fromTs: then.t, toTs: last.t };
    }

    isStable (code: string): boolean {
        return STABLECOINS.indexOf (code.toUpperCase ()) !== -1;
    }
}

export function median (xs: number[]): number {
    const s = [ ...xs ].sort ((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
