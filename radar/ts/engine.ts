// Rule engine: evaluates every active rule against the shared market state and fans out global events.
// Semantics from the spec: fire on crossing, re-arm after moving back by a margin, cooldowns, freshness gates.

import type { Store } from './db.js';
import type { EventBus, MarketEvent } from './events.js';
import { MarketState, to8h, toApr, median } from './market/state.js';
import type { Funding } from './market/state.js';
import type { Rule } from './rules.js';
import { KIND_DEFAULTS } from './rules.js';
import type { Alert } from './alerts.js';
import { alertFor, eventHtml, eventSummary, fundingAlertHtml, fundingGapHtml, moveAlertHtml, oiHtml, priceAlertHtml, settleHtml } from './alerts.js';
import { MAJORS, STABLECOINS } from './config.js';
import { fmtPct, fmtPrice, venueName } from './format.js';

export type AlertSink = (a: Alert) => void;

interface RS {
    armed: boolean;
    lastValue: number | null;
    lastFiredAt: number | null;
    cooldownUntil: number;
}

const FRESH_MS = 60_000;
const FUNDING_FRESH_MS = 5 * 60_000;
const TOP_PERPS_FOR_ANY = 50;
const BREAKING_LISTING_VENUES = new Set ([ 'binance', 'coinbase', 'upbit', 'okx', 'bybit' ]);

export class Engine {
    store: Store;
    state: MarketState;
    bus: EventBus;
    sink: AlertSink;
    rules: Rule[] = [];
    dirty = true;
    lastLoad = 0;
    depegSince = new Map<string, number> ();
    onWatchChange?: (bases: Set<string>, codes: Set<string>) => void;
    now: () => number = () => Date.now ();

    constructor (store: Store, state: MarketState, bus: EventBus, sink: AlertSink) {
        this.store = store;
        this.state = state;
        this.bus = bus;
        this.sink = sink;
        bus.on ((ev) => this.onEvent (ev));
    }

    markDirty (): void {
        this.dirty = true;
    }

    // Per-rule mute ("Mute 4h" button), persisted so restarts keep it.
    mute (ruleId: string, ms: number): void {
        const mutes = this.store.kvGet<Record<string, number>> ('mutes') || {};
        const now = this.now ();
        for (const [ k, until ] of Object.entries (mutes)) {
            if (until < now) {
                delete mutes[k];
            }
        }
        mutes[ruleId] = now + ms;
        this.store.kvSet ('mutes', mutes);
        this.markDirty ();
    }

    isMuted (ruleId: string): boolean {
        const mutes = this.store.kvGet<Record<string, number>> ('mutes') || {};
        return (mutes[ruleId] || 0) > this.now ();
    }

    loadRules (): void {
        const now = this.now ();
        if (!this.dirty && now - this.lastLoad < 30_000) {
            return;
        }
        const mutes = this.store.kvGet<Record<string, number>> ('mutes') || {};
        this.rules = this.store.activeRules ().filter ((r) => (r.expiresAt === null || r.expiresAt > now) && !((mutes[r.id] || 0) > now));
        this.dirty = false;
        this.lastLoad = now;
        this.updateWatched ();
    }

    // Tell ingestion which markets need history (for % windows) and which perps need open interest.
    updateWatched (): void {
        const watched = new Set<string> ();
        const bases = new Set<string> (MAJORS);
        const perpBases = new Set<string> ();
        const codes = new Set<string> ([ ...MAJORS, ...STABLECOINS ]);
        for (const r of this.rules) {
            const s = r.spec;
            if (s.kind === 'move' || s.kind === 'price') {
                bases.add (s.base);
                if (s.venue !== 'median') {
                    const res = this.state.resolve (s.venue, s.base, s.market);
                    if (res) {
                        watched.add (s.venue + '|' + res.symbol);
                    }
                }
            }
            if (s.kind === 'oi') {
                perpBases.add (s.base);
            }
            if (s.kind === 'wallet') {
                codes.add (s.code);
            }
        }
        this.state.watched = watched;
        for (const b of bases) {
            this.state.watchedBases.add (b);
        }
        if (this.onWatchChange) {
            this.onWatchChange (perpBases, codes);
        }
    }

    // ---------------------------------------------------------------- state helpers

    private getState (rule: Rule, key: string, initArmed: boolean): RS {
        return this.store.getRuleState (rule.id, key) || { armed: initArmed, lastValue: null, lastFiredAt: null, cooldownUntil: 0 };
    }

    private fire (rule: Rule, key: string, st: RS, value: number, alert: Alert): void {
        const now = this.now ();
        st.armed = false;
        st.lastFiredAt = now;
        st.cooldownUntil = now + rule.cooldownS * 1000;
        st.lastValue = value;
        this.store.setRuleState (rule.id, key, st);
        this.sink (alert);
        if (rule.mode === 'once') {
            this.store.deleteRule (rule.id);
            this.markDirty ();
        }
    }

    // Generic threshold check: fire when `cond` holds while armed (and out of cooldown); re-arm when `rearm` holds.
    private check (rule: Rule, key: string, value: number | undefined, cond: (v: number) => boolean, rearm: (v: number) => boolean, build: () => Alert): void {
        if (value === undefined || !Number.isFinite (value)) {
            return;
        }
        const existing = this.store.getRuleState (rule.id, key);
        // A new rule starts armed only if the condition is not already true: rules fire on crossing.
        const st = existing || { armed: !cond (value), lastValue: null, lastFiredAt: null, cooldownUntil: 0 };
        const now = this.now ();
        if (st.armed && cond (value) && now >= st.cooldownUntil) {
            this.fire (rule, key, st, value, build ());
            return;
        }
        if (!st.armed && rearm (value)) {
            st.armed = true;
        }
        st.lastValue = value;
        this.store.setRuleState (rule.id, key, st);
    }

    private venuesFor (list: string[], candidates: Iterable<string>): string[] {
        const all = [ ...candidates ];
        return list.length ? all.filter ((v) => list.indexOf (v) !== -1) : all;
    }

    // ---------------------------------------------------------------- tick

    tick (): void {
        this.loadRules ();
        for (const rule of this.rules) {
            try {
                this.evaluate (rule);
            } catch (e) {
                console.error ('[engine] rule ' + rule.id + ' failed', e);
            }
        }
        this.globalMonitors ();
    }

    evaluate (rule: Rule): void {
        const s = rule.spec;
        const now = this.now ();
        switch (s.kind) {
            case 'price': {
                let value: number | undefined;
                let ts = now;
                let symbol = s.base;
                if (s.venue === 'median') {
                    const m = this.state.medianPrice (s.base, FRESH_MS);
                    if (m && m.venues.length >= 2) {
                        value = m.price;
                        ts = m.ts;
                        symbol = s.base + '/USD (median)';
                    }
                } else {
                    if (this.state.isDegraded (s.venue)) {
                        return;
                    }
                    const r = this.state.resolve (s.venue, s.base, s.market, s.quote);
                    if (!r) {
                        return;
                    }
                    const p = this.state.price (s.venue, r.symbol, s.field, FRESH_MS);
                    if (p) {
                        value = p.value / r.multiplier;
                        ts = p.ts;
                    }
                    symbol = r.symbol;
                }
                const T = s.value;
                const cond = (v: number) => s.op === 'above' ? v >= T : v <= T;
                const rearm = (v: number) => s.op === 'above' ? v <= T * 0.995 : v >= T * 1.005;
                this.check (rule, 'p', value, cond, rearm, () => alertFor (rule,
                    priceAlertHtml ({ base: s.base, symbol, venue: s.venue, op: s.op, threshold: T, value: value!, field: s.field, ts, now, note: s.note }),
                    s.base + ' ' + (s.op === 'above' ? 'above ' : 'below ') + fmtPrice (T) + ' (' + fmtPrice (value!) + ')',
                    { kind: 'price', venue: s.venue === 'median' ? 'coinbase' : s.venue, symbol: s.venue === 'median' ? s.base + '/USD' : symbol, base: s.base }, now));
                return;
            }
            case 'move': {
                let key: string;
                let symbol = s.base;
                if (s.venue === 'median') {
                    key = 'median|' + s.base;
                } else {
                    if (this.state.isDegraded (s.venue)) {
                        return;
                    }
                    const r = this.state.resolve (s.venue, s.base, s.market);
                    if (!r) {
                        return;
                    }
                    key = s.venue + '|' + r.symbol;
                    symbol = r.symbol;
                }
                const ch = this.state.change (key, s.windowMin * 60_000);
                if (!ch || now - ch.toTs > FRESH_MS) {
                    return;
                }
                const P = s.pct;
                const cond = (v: number) => s.direction === 'both' ? Math.abs (v) >= P : (s.direction === 'up' ? v >= P : v <= -P);
                const rearm = (v: number) => Math.abs (v) < P * 0.6;
                this.check (rule, 'm', ch.pct, cond, rearm, () => alertFor (rule,
                    moveAlertHtml ({ base: s.base, venue: s.venue, pct: ch.pct, windowMin: s.windowMin, from: ch.from, to: ch.to, ts: ch.toTs, now }),
                    s.base + ' ' + fmtPct (ch.pct, 2, true) + ' in ' + s.windowMin + 'm',
                    { kind: 'move', venue: s.venue === 'median' ? 'coinbase' : s.venue, symbol: s.venue === 'median' ? s.base + '/USD' : symbol, base: s.base, windowMin: s.windowMin }, now));
                return;
            }
            case 'funding': {
                const venues = this.venuesFor (s.venues, this.state.funding.keys ());
                const cond = (v: number) => (s.high !== null && v > s.high) || (s.low !== null && v < s.low);
                const rearm = (v: number) => (s.high === null || v < s.high * 0.8) && (s.low === null || v > s.low * 0.8);
                for (const venue of venues) {
                    if (this.state.isDegraded (venue, FUNDING_FRESH_MS)) {
                        continue;
                    }
                    const rows = this.state.funding.get (venue)!;
                    let symbols: string[];
                    if (s.base === '*') {
                        const liquid = this.state.liquidPerpBases (TOP_PERPS_FOR_ANY, 2);
                        symbols = this.state.topPerps (venue, TOP_PERPS_FOR_ANY).filter ((sym) => {
                            const info = this.state.markets.get (venue)?.get (sym);
                            return info !== undefined && liquid.has (MarketState.normalizeBase (info.base).base);
                        });
                    } else {
                        const r = this.state.resolve (venue, s.base, 'perp');
                        symbols = r ? [ r.symbol ] : [];
                    }
                    for (const symbol of symbols) {
                        const f = rows.get (symbol);
                        if (!f || now - f.ts > FUNDING_FRESH_MS) {
                            continue;
                        }
                        const v8 = to8h (f);
                        this.check (rule, venue + '|' + symbol, v8, cond, rearm, () => {
                            const base = MarketState.normalizeBase (symbol.split ('/')[0]).base;
                            const others = this.state.fundingAcross (base).filter ((o) => o.venue !== venue).map ((o) => ({ venue: o.venue, f: o.f }));
                            return alertFor (rule,
                                fundingAlertHtml ({ symbol, venue, f, high: s.high, low: s.low, others, now }),
                                'Funding ' + symbol + ' ' + venueName (venue) + ' ' + fmtPct (v8 * 100, 3, true) + '/8h',
                                { kind: 'funding', venue, symbol, base }, now);
                        });
                    }
                }
                return;
            }
            case 'fundinggap': {
                const rows = this.state.fundingAcross (s.base)
                    .filter ((r) => (s.venues.length === 0 || s.venues.indexOf (r.venue) !== -1) && now - r.f.ts <= FUNDING_FRESH_MS);
                if (rows.length < 2) {
                    return;
                }
                const aprs = rows.map ((r) => toApr (r.f));
                const gap = Math.max (...aprs) - Math.min (...aprs);
                this.check (rule, 'g', gap, (v) => v >= s.aprGap, (v) => v < s.aprGap * 0.8, () => alertFor (rule,
                    fundingGapHtml ({ base: s.base, rows: rows.map ((r) => ({ venue: r.venue, f: r.f })), gap, now }),
                    s.base + ' funding gap ' + fmtPct (gap * 100, 1) + ' APR',
                    { kind: 'fundinggap', venue: rows[0].venue, symbol: rows[0].symbol, base: s.base, venues: rows.map ((r) => r.venue) }, now));
                return;
            }
            case 'settle': {
                for (const row of this.state.fundingAcross (s.base)) {
                    if (s.venues.length && s.venues.indexOf (row.venue) === -1) {
                        continue;
                    }
                    const f: Funding = row.f;
                    if (!f.settleTs) {
                        continue;
                    }
                    const left = f.settleTs - now;
                    const key = row.venue + '|' + row.symbol;
                    const st = this.getState (rule, key, true);
                    if (left > 0 && left <= s.minutesBefore * 60_000 && st.lastValue !== f.settleTs) {
                        st.lastValue = f.settleTs;
                        st.lastFiredAt = now;
                        this.store.setRuleState (rule.id, key, st);
                        this.sink (alertFor (rule, settleHtml ({ symbol: row.symbol, venue: row.venue, f, now }),
                            row.symbol + ' funding settles soon on ' + venueName (row.venue),
                            { kind: 'funding', venue: row.venue, symbol: row.symbol, base: s.base }, now));
                    }
                }
                return;
            }
            case 'oi': {
                for (const [ venue ] of this.state.openInterest) {
                    if (s.venues.length && s.venues.indexOf (venue) === -1) {
                        continue;
                    }
                    const r = this.state.resolve (venue, s.base, 'perp');
                    if (!r) {
                        continue;
                    }
                    const ch = this.state.change ('oi|' + venue + '|' + r.symbol, s.windowMin * 60_000);
                    if (!ch || now - ch.toTs > 3 * 60_000) {
                        continue;
                    }
                    this.check (rule, venue + '|' + r.symbol, ch.pct, (v) => Math.abs (v) >= s.pct, (v) => Math.abs (v) < s.pct * 0.5, () => alertFor (rule,
                        oiHtml ({ symbol: r.symbol, venue, pct: ch.pct, windowMin: s.windowMin, from: ch.from, to: ch.to, ts: ch.toTs, now }),
                        r.symbol + ' OI ' + fmtPct (ch.pct, 1, true) + ' on ' + venueName (venue),
                        { kind: 'oi', venue, symbol: r.symbol, base: s.base }, now));
                }
                return;
            }
            case 'depeg': {
                for (const code of s.codes) {
                    const p = this.stablePrice (code);
                    if (!p) {
                        continue;
                    }
                    const dev = Math.abs (p.price - 1);
                    const sinceKey = rule.id + '|' + code;
                    if (dev > s.threshold) {
                        if (!this.depegSince.has (sinceKey)) {
                            this.depegSince.set (sinceKey, now);
                        }
                    } else {
                        this.depegSince.delete (sinceKey);
                    }
                    const sustained = this.depegSince.has (sinceKey) && now - this.depegSince.get (sinceKey)! >= 120_000;
                    this.check (rule, code, sustained ? dev : 0, (v) => v > s.threshold, (v) => v < Math.min (0.002, s.threshold / 2), () => {
                        const ev: MarketEvent = { key: '', type: 'depeg', code, data: { price: p.price, venues: p.venues }, ts: now };
                        return alertFor (rule, eventHtml (ev, now), eventSummary (ev), { kind: 'depeg', venue: p.venues[0], symbol: code + '/USD', code }, now);
                    });
                }
                return;
            }
            default:
                return; // event-driven kinds are handled in onEvent
        }
    }

    // Stablecoin price in USD from direct USD pairs (Kraken, Coinbase), else implied from USDC/USDT.
    stablePrice (code: string): { price: number, venues: string[] } | undefined {
        const pts: Array<{ venue: string, p: number }> = [];
        for (const venue of [ 'kraken', 'coinbase' ]) {
            const p = this.state.price (venue, code + '/USD', 'last', FRESH_MS);
            if (p) {
                pts.push ({ venue, p: p.value });
            }
        }
        if (pts.length === 0 && code === 'USDC') {
            for (const venue of [ 'binance', 'okx', 'bybit', 'kucoin' ]) {
                const p = this.state.price (venue, 'USDC/USDT', 'last', FRESH_MS);
                if (p) {
                    pts.push ({ venue, p: p.value * this.state.stableUsd ('USDT') });
                }
            }
        }
        if (pts.length === 0) {
            return undefined;
        }
        return { price: median (pts.map ((x) => x.p)), venues: pts.map ((x) => x.venue) };
    }

    // ---------------------------------------------------------------- global monitors -> events

    globalMonitors (): void {
        const now = this.now ();
        // Unexplained big move: BTC/ETH median ±4% within 15 minutes.
        for (const base of [ 'BTC', 'ETH' ]) {
            const ch = this.state.change ('median|' + base, 15 * 60_000);
            if (ch && Math.abs (ch.pct) >= 4 && now - ch.toTs < FRESH_MS) {
                const bucket = Math.floor (now / (30 * 60_000));
                this.bus.emit ({ key: 'bigmove:' + base + ':' + bucket, type: 'bigmove', base, data: { pct: ch.pct, windowMin: 15, from: ch.from, to: ch.to }, ts: now });
            }
        }
    }

    // ---------------------------------------------------------------- events

    onEvent (ev: MarketEvent): void {
        if (!ev.key) {
            return;
        }
        if (!this.store.recordEvent (ev.key, ev.type, ev)) {
            return; // already seen
        }
        this.loadRules ();
        const now = this.now ();
        const html = eventHtml (ev, now);
        const summary = eventSummary (ev);
        for (const rule of this.rules) {
            if (this.matches (rule, ev)) {
                const a = alertFor (rule, html, summary, { kind: ev.type, venue: ev.venue, symbol: ev.symbol, code: ev.code, base: ev.base }, now, ev.key);
                if (rule.spec.kind === 'breaking') {
                    a.ttlMs = KIND_DEFAULTS.breaking.ttlS * 1000;
                }
                this.sink (a);
            }
        }
    }

    matches (rule: Rule, ev: MarketEvent): boolean {
        const s = rule.spec;
        const venueOk = (list: string[]) => list.length === 0 || (ev.venue !== undefined && list.indexOf (ev.venue) !== -1);
        switch (s.kind) {
            case 'listing':
                if (ev.type !== 'listing' && !(ev.type === 'delisting' && s.removals)) {
                    return false;
                }
                if (!venueOk (s.venues)) {
                    return false;
                }
                if (s.markets.indexOf (ev.data.market) === -1) {
                    return false;
                }
                return s.bases.length === 0 || (ev.base !== undefined && s.bases.map ((b) => b.toUpperCase ()).indexOf (ev.base) !== -1);
            case 'wallet':
                return ev.type === 'wallet' && ev.code === s.code && venueOk (s.venues);
            case 'status':
                return ev.type === 'status' && venueOk (s.venues);
            case 'breaking':
                if (ev.type === 'listing') {
                    return s.types.indexOf ('listing') !== -1 && BREAKING_LISTING_VENUES.has (ev.venue || '') && ev.data.market === 'spot';
                }
                if (ev.type === 'delisting') {
                    return s.types.indexOf ('listing') !== -1 && BREAKING_LISTING_VENUES.has (ev.venue || '') && ev.data.market === 'spot';
                }
                if (ev.type === 'status') {
                    return s.types.indexOf ('status') !== -1;
                }
                if (ev.type === 'wallet') {
                    return s.types.indexOf ('status') !== -1 && STABLECOINS.indexOf (ev.code || '') !== -1 && ev.data.field === 'withdraw';
                }
                return s.types.indexOf (ev.type as any) !== -1;
            default:
                return false;
        }
    }
}
