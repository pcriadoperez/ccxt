// Ingestion: one CCXT instance per venue, polling loops with backoff, writing into the shared MarketState.
// Users never trigger exchange calls from here; cost scales with venues and markets, not with users.

import ccxt from 'ccxt';
import type { Config } from '../config.js';
import { SPOT_ONLY_VENUES, MAJORS, STABLECOINS } from '../config.js';
import { EventBus } from '../events.js';
import { MarketState, intervalHours } from './state.js';
import type { Funding, MarketInfo, Tick, WalletNet } from './state.js';
import { ListingTracker, WalletTracker } from './trackers.js';
import type { Store } from '../db.js';

type Log = (msg: string) => void;

export class Ingestor {
    cfg: Config;
    state: MarketState;
    bus: EventBus;
    store: Store;
    log: Log;
    exchanges = new Map<string, any> ();
    listings: ListingTracker;
    wallets: WalletTracker;
    fundingIntervals = new Map<string, { at: number, map: Record<string, string> }> ();
    timers: NodeJS.Timeout[] = [];
    stopped = false;
    // Bases and codes that users referenced in rules; set by the engine.
    extraPerpBases = new Set<string> ();
    trackedWalletCodes = new Set<string> ([ ...MAJORS, ...STABLECOINS ]);
    statusMonitor = new Map<string, { down: boolean, since?: number, healthySince?: number }> ();

    constructor (cfg: Config, state: MarketState, bus: EventBus, store: Store, log: Log = (m) => console.log (m)) {
        this.cfg = cfg;
        this.state = state;
        this.bus = bus;
        this.store = store;
        this.log = log;
        this.listings = new ListingTracker (store.kvGet ('listing_baselines') || {});
        this.wallets = new WalletTracker (store.kvGet ('wallet_baselines') || {});
    }

    allVenues (): string[] {
        return [ ...new Set ([ ...this.cfg.venues, ...this.cfg.listingVenues ]) ];
    }

    exchange (id: string): any {
        let ex = this.exchanges.get (id);
        if (!ex) {
            const Cls = (ccxt as any)[id];
            if (!Cls) {
                throw new Error ('unknown exchange ' + id);
            }
            ex = new Cls ({ enableRateLimit: true, timeout: 15_000, ...(this.cfg.credentials[id] || {}) });
            this.exchanges.set (id, ex);
        }
        return ex;
    }

    start (): void {
        for (const venue of this.allVenues ()) {
            const core = this.cfg.venues.indexOf (venue) !== -1;
            const iv = this.cfg.intervals;
            this.loop (venue, 'markets', core ? iv.marketsCoreMs : iv.marketsListingMs, () => this.pollMarkets (venue), 0);
            if (!core) {
                continue;
            }
            this.loop (venue, 'tickers', iv.tickersMs, () => this.pollTickers (venue), 3_000);
            this.loop (venue, 'funding', iv.fundingMs, () => this.pollFunding (venue), 8_000);
            this.loop (venue, 'oi', iv.openInterestMs, () => this.pollOpenInterest (venue), 15_000);
            this.loop (venue, 'currencies', iv.currenciesMs, () => this.pollCurrencies (venue), 20_000);
            this.loop (venue, 'status', iv.statusMs, () => this.pollStatus (venue), 10_000);
        }
        const t = setInterval (() => this.checkHealth (), 15_000);
        this.timers.push (t);
        const m = setInterval (() => this.state.updateMedians (), 15_000);
        this.timers.push (m);
    }

    stop (): void {
        this.stopped = true;
        for (const t of this.timers) {
            clearTimeout (t);
            clearInterval (t);
        }
        this.timers = [];
    }

    // Polling loop with exponential backoff on repeated errors (geo-blocks, outages).
    private loop (venue: string, name: string, everyMs: number, fn: () => Promise<void>, initialDelayMs: number): void {
        let failures = 0;
        const run = async () => {
            if (this.stopped) {
                return;
            }
            try {
                await fn ();
                failures = 0;
            } catch (e: any) {
                failures += 1;
                this.state.error (venue, e);
                if (failures === 1 || failures % 10 === 0) {
                    this.log ('[' + venue + '] ' + name + ' failed (' + failures + '): ' + (e?.constructor?.name || '') + ' ' + String (e?.message || e).slice (0, 160));
                }
            }
            if (this.stopped) {
                return;
            }
            const backoff = failures > 2 ? Math.min (2 ** (failures - 2), 16) : 1;
            const jitter = 0.9 + Math.random () * 0.2;
            const t = setTimeout (run, everyMs * backoff * jitter);
            this.timers.push (t);
        };
        const t = setTimeout (run, initialDelayMs + Math.random () * 1000);
        this.timers.push (t);
    }

    // ---------------------------------------------------------------- markets + listings

    async pollMarkets (venue: string): Promise<void> {
        const ex = this.exchange (venue);
        const markets: Record<string, any> = await ex.loadMarkets (true);
        const list: MarketInfo[] = [];
        const active: string[] = [];
        for (const m of Object.values (markets)) {
            if (m.type !== 'spot' && m.type !== 'swap') {
                continue;
            }
            list.push ({ symbol: m.symbol, base: m.base, quote: m.quote, settle: m.settle, type: m.type, linear: m.linear, contractSize: m.contractSize, active: m.active, taker: m.taker });
            if (m.active !== false) {
                active.push (m.symbol);
            }
        }
        this.state.setMarkets (venue, list);
        this.state.ok (venue);
        const changes = this.listings.observe (venue, active);
        this.store.kvSet ('listing_baselines', this.listings.snapshot ());
        for (const c of changes) {
            const info = (markets as any)[c.symbol];
            const base = info ? MarketState.normalizeBase (info.base).base : c.symbol.split ('/')[0];
            const marketKind = info && info.type === 'swap' ? 'perp' : 'spot';
            this.bus.emit ({
                key: (c.change === 'added' ? 'listing:' : 'delisting:') + venue + ':' + c.symbol,
                type: c.change === 'added' ? 'listing' : 'delisting',
                venue,
                symbol: c.symbol,
                base,
                data: { market: marketKind, quote: info?.quote },
                ts: Date.now (),
            });
        }
    }

    // ---------------------------------------------------------------- tickers

    async pollTickers (venue: string): Promise<void> {
        const ex = this.exchange (venue);
        if (!ex.has['fetchTickers']) {
            return;
        }
        if (!this.state.markets.has (venue)) {
            return; // wait for markets
        }
        const types = SPOT_ONLY_VENUES.has (venue) ? [ 'spot' ] : [ 'spot', 'swap' ];
        const known = this.state.markets.get (venue)!;
        const ticks = new Map<string, Tick> ();
        const now = Date.now ();
        let errors = 0;
        for (const type of types) {
            try {
                const params: Record<string, any> = { type };
                if (type === 'swap' && (venue === 'bybit' || venue === 'binance')) {
                    params.subType = 'linear';
                }
                const res: Record<string, any> = await ex.fetchTickers (undefined, params);
                for (const t of Object.values (res)) {
                    const info = known.get (t.symbol);
                    if (!info || (info.type !== type && types.length > 1)) {
                        continue;
                    }
                    ticks.set (t.symbol, {
                        last: num (t.last ?? t.close),
                        bid: num (t.bid),
                        ask: num (t.ask),
                        mark: num (t.markPrice),
                        pct24: num (t.percentage),
                        quoteVolume: num (t.quoteVolume),
                        ts: now,
                    });
                }
            } catch (e) {
                errors += 1;
                if (errors === types.length) {
                    throw e;
                }
                this.state.error (venue, e);
            }
        }
        this.state.setTickers (venue, ticks);
    }

    // ---------------------------------------------------------------- funding

    async pollFunding (venue: string): Promise<void> {
        const ex = this.exchange (venue);
        if (!ex.has['fetchFundingRates']) {
            return;
        }
        const res: Record<string, any> = await ex.fetchFundingRates ();
        const intervals = await this.fundingIntervalMap (venue, ex);
        const now = Date.now ();
        const rows = new Map<string, Funding> ();
        for (const f of Object.values (res)) {
            const rate = num (f.fundingRate);
            if (rate === undefined) {
                continue;
            }
            const iv = intervalHours (f.interval || intervals[f.symbol]);
            const candidates = [ f.fundingTimestamp, f.nextFundingTimestamp ].map (num).filter ((x): x is number => x !== undefined && x > now);
            rows.set (f.symbol, {
                rate,
                intervalH: iv.hours,
                intervalAssumed: iv.assumed,
                settleTs: candidates.length ? Math.min (...candidates) : undefined,
                mark: num (f.markPrice),
                ts: now,
            });
        }
        this.state.setFunding (venue, rows);
    }

    // Venues that omit the interval in fetchFundingRates expose fetchFundingIntervals; refresh hourly.
    private async fundingIntervalMap (venue: string, ex: any): Promise<Record<string, string>> {
        if (!ex.has['fetchFundingIntervals']) {
            return {};
        }
        const cached = this.fundingIntervals.get (venue);
        if (cached && Date.now () - cached.at < 3_600_000) {
            return cached.map;
        }
        try {
            const res: Record<string, any> = await ex.fetchFundingIntervals ();
            const map: Record<string, string> = {};
            for (const f of Object.values (res)) {
                if (f.interval) {
                    map[f.symbol] = f.interval;
                }
            }
            this.fundingIntervals.set (venue, { at: Date.now (), map });
            return map;
        } catch {
            this.fundingIntervals.set (venue, { at: Date.now (), map: cached?.map || {} });
            return cached?.map || {};
        }
    }

    // ---------------------------------------------------------------- open interest

    async pollOpenInterest (venue: string): Promise<void> {
        const ex = this.exchange (venue);
        if (!ex.has['fetchOpenInterest'] && !ex.has['fetchOpenInterests']) {
            return;
        }
        const bases = new Set ([ ...MAJORS, ...this.extraPerpBases ]);
        const symbols: string[] = [];
        for (const base of bases) {
            const r = this.state.resolve (venue, base, 'perp');
            if (r) {
                symbols.push (r.symbol);
            }
        }
        const now = Date.now ();
        if (ex.has['fetchOpenInterests']) {
            const res: Record<string, any> = await ex.fetchOpenInterests (symbols);
            for (const oi of Object.values (res)) {
                const v = num (oi.openInterestAmount ?? oi.openInterestValue);
                if (v !== undefined && symbols.indexOf (oi.symbol) !== -1) {
                    this.state.setOpenInterest (venue, oi.symbol, v, now);
                }
            }
            return;
        }
        for (const s of symbols.slice (0, 30)) {
            const oi = await ex.fetchOpenInterest (s);
            const v = num (oi.openInterestAmount ?? oi.openInterestValue);
            if (v !== undefined) {
                this.state.setOpenInterest (venue, s, v, now);
            }
        }
    }

    // ---------------------------------------------------------------- deposit / withdrawal status

    async pollCurrencies (venue: string): Promise<void> {
        const ex = this.exchange (venue);
        if (!ex.has['fetchCurrencies']) {
            return;
        }
        const res: Record<string, any> = (await ex.fetchCurrencies ()) || {};
        const data = new Map<string, Map<string, WalletNet>> ();
        const snap: Record<string, Record<string, { deposit?: boolean, withdraw?: boolean }>> = {};
        let informative = 0;
        for (const [ code, c ] of Object.entries (res)) {
            const nets = new Map<string, WalletNet> ();
            const snapNets: Record<string, { deposit?: boolean, withdraw?: boolean }> = {};
            const networks = c.networks || {};
            for (const [ netId, n ] of Object.entries<any> (networks)) {
                const w = { deposit: bool (n.deposit), withdraw: bool (n.withdraw) };
                if (w.deposit !== undefined || w.withdraw !== undefined) {
                    nets.set (netId, w);
                    snapNets[netId] = w;
                }
            }
            if (nets.size === 0) {
                const w = { deposit: bool (c.deposit), withdraw: bool (c.withdraw) };
                if (w.deposit !== undefined || w.withdraw !== undefined) {
                    nets.set ('*', w);
                    snapNets['*'] = w;
                }
            }
            if (nets.size > 0) {
                informative += 1;
                data.set (code, nets);
                snap[code] = snapNets;
            }
        }
        if (informative === 0) {
            return; // venue does not report wallet status without keys (or at all)
        }
        this.state.setWallets (venue, data);
        const changes = this.wallets.observe (venue, snap, this.trackedWalletCodes);
        this.store.kvSet ('wallet_baselines', this.wallets.snapshot ());
        for (const c of changes) {
            this.bus.emit ({
                key: 'wallet:' + venue + ':' + c.code + ':' + c.network + ':' + c.field + ':' + c.to + ':' + Math.floor (Date.now () / 600_000),
                type: 'wallet',
                venue,
                code: c.code,
                data: { network: c.network, field: c.field, from: c.from, to: c.to },
                ts: Date.now (),
            });
        }
    }

    // ---------------------------------------------------------------- exchange status

    async pollStatus (venue: string): Promise<void> {
        const ex = this.exchange (venue);
        if (!ex.has['fetchStatus']) {
            return;
        }
        const s = await ex.fetchStatus ();
        this.state.healthOf (venue).exchangeStatus = s?.status;
    }

    // Degraded for 2+ minutes => "down" event; healthy for 10+ minutes after that => "recovered".
    checkHealth (now = Date.now ()): void {
        for (const venue of this.cfg.venues) {
            const h = this.state.health.get (venue);
            if (!h || h.lastOk === 0) {
                continue; // never connected (e.g. geo-blocked): not an outage we can report
            }
            const degraded = this.state.isDegraded (venue, Math.max (60_000, this.cfg.intervals.tickersMs * 6));
            let m = this.statusMonitor.get (venue);
            if (!m) {
                m = { down: false };
                this.statusMonitor.set (venue, m);
            }
            if (degraded) {
                m.healthySince = undefined;
                if (m.since === undefined) {
                    m.since = now;
                }
                if (!m.down && now - m.since >= 120_000) {
                    m.down = true;
                    this.bus.emit ({ key: 'status:' + venue + ':down:' + m.since, type: 'status', venue, data: { state: 'down', since: m.since, reason: h.exchangeStatus && h.exchangeStatus !== 'ok' ? 'exchange reports ' + h.exchangeStatus : (h.lastError || 'no data') }, ts: now });
                }
            } else {
                m.since = undefined;
                if (m.down) {
                    if (m.healthySince === undefined) {
                        m.healthySince = now;
                    }
                    if (now - m.healthySince >= 600_000) {
                        m.down = false;
                        this.bus.emit ({ key: 'status:' + venue + ':up:' + now, type: 'status', venue, data: { state: 'recovered' }, ts: now });
                        m.healthySince = undefined;
                    }
                }
            }
        }
    }
}

function num (x: unknown): number | undefined {
    if (x === undefined || x === null) {
        return undefined;
    }
    const n = Number (x);
    return Number.isFinite (n) ? n : undefined;
}

function bool (x: unknown): boolean | undefined {
    return typeof x === 'boolean' ? x : undefined;
}
