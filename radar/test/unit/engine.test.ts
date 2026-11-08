import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../ts/db.js';
import { EventBus } from '../../ts/events.js';
import { Engine } from '../../ts/engine.js';
import type { Alert } from '../../ts/alerts.js';
import { KIND_DEFAULTS, parseSpec } from '../../ts/rules.js';
import type { RuleSpec } from '../../ts/rules.js';
import { makeState, setMajors } from '../helpers/fixtures.js';

function setup () {
    const now = { t: 1_800_000_000_000 };
    const store = new Store (':memory:');
    const state = makeState (now);
    const bus = new EventBus ();
    const alerts: Alert[] = [];
    const engine = new Engine (store, state, bus, (a) => alerts.push (a));
    engine.now = () => now.t;
    for (const v of [ 'binance', 'okx', 'kraken', 'coinbase', 'hyperliquid' ]) {
        state.ok (v);
    }
    store.ensureUser (1, { kind: 'dm', dailyBudget: 10 });
    const add = (spec: unknown, mode?: 'once' | 'repeat') => {
        const r = parseSpec (spec);
        assert.ok (r.ok, JSON.stringify (r));
        const s = (r as { ok: true, spec: RuleSpec }).spec;
        const d = KIND_DEFAULTS[s.kind];
        const rule = store.insertRule ({ chatId: 1, spec: s, mode: mode || d.mode, cooldownS: d.cooldownS, expiresAt: null, paused: false, breakQuiet: false, source: 'shorthand' });
        engine.markDirty ();
        return rule;
    };
    return { now, store, state, bus, engine, alerts, add };
}

test ('price rule fires on crossing, not when already past the level', () => {
    const { now, state, engine, alerts, add, store } = setup ();
    setMajors (state, now.t, 101_000);
    add ({ kind: 'price', base: 'BTC', op: 'above', value: 100_000 });
    engine.tick ();
    assert.equal (alerts.length, 0, 'already above when created: no alert');
    now.t += 10_000;
    setMajors (state, now.t, 99_000);
    engine.tick ();
    now.t += 10_000;
    setMajors (state, now.t, 100_500);
    engine.tick ();
    assert.equal (alerts.length, 1);
    assert.match (alerts[0].html, /Price above 100,000/);
    assert.equal (store.rulesForChat (1).length, 0, 'once rules remove themselves');
});

test ('repeat price rule re-arms only after moving back by 0.5%', () => {
    const { now, state, engine, alerts, add } = setup ();
    setMajors (state, now.t, 99_000);
    add ({ kind: 'price', base: 'BTC', op: 'above', value: 100_000 }, 'repeat');
    engine.tick ();
    const step = (p: number) => {
        now.t += 10_000;
        setMajors (state, now.t, p);
        engine.tick ();
    };
    step (100_100);
    step (99_800); // back below, but not by 0.5%
    step (100_200);
    assert.equal (alerts.length, 1);
    step (99_400); // re-armed
    step (100_300);
    assert.equal (alerts.length, 2);
});

test ('price rule on a venue ignores stale or degraded data', () => {
    const { now, state, engine, alerts, add } = setup ();
    setMajors (state, now.t, 99_000);
    add ({ kind: 'price', base: 'BTC', venue: 'okx', op: 'above', value: 100_000 });
    engine.tick ();
    now.t += 120_000; // okx silent for 2 minutes => degraded
    state.tickers.get ('okx')!.set ('BTC/USDT', { last: 105_000, ts: now.t - 120_000 });
    engine.tick ();
    assert.equal (alerts.length, 0);
});

test ('move rule uses the median history window', () => {
    const { now, state, engine, alerts, add } = setup ();
    add ({ kind: 'move', base: 'ETH', venue: 'median', pct: 5, windowMin: 60 });
    for (let i = 0; i <= 130; i++) {
        now.t += 30_000;
        const price = i < 120 ? 3000 : 3000 * 1.06;
        setMajors (state, now.t, 100_000, price);
        state.updateMedians ();
        engine.tick ();
    }
    assert.equal (alerts.length, 1);
    assert.match (alerts[0].html, /ETH \+6\.00% in 1h/);
});

test ('funding rule normalizes intervals and reports other venues', () => {
    const { now, state, engine, alerts, add } = setup ();
    add ({ kind: 'funding', base: 'BTC', venues: [], high: 0.0005, low: null });
    state.setFunding ('okx', new Map ([ [ 'BTC/USDT:USDT', { rate: 0.0001, intervalH: 8, intervalAssumed: false, ts: now.t } ] ]));
    state.setFunding ('hyperliquid', new Map ([ [ 'BTC/USDC:USDC', { rate: 0.00004, intervalH: 1, intervalAssumed: false, ts: now.t } ] ]));
    engine.tick ();
    assert.equal (alerts.length, 0);
    now.t += 60_000;
    state.setFunding ('hyperliquid', new Map ([ [ 'BTC/USDC:USDC', { rate: 0.0001, intervalH: 1, intervalAssumed: false, settleTs: now.t + 600_000, ts: now.t } ] ])); // 0.08%/8h
    engine.tick ();
    assert.equal (alerts.length, 1);
    assert.match (alerts[0].html, /Hyperliquid \+0\.010% \/ 1h \(8h-eq \+0\.080%/);
    assert.match (alerts[0].html, /OKX \+0\.010%/);
    assert.equal (alerts[0].context?.venue, 'hyperliquid');
});

test ('funding gap rule compares APR across venues', () => {
    const { now, state, engine, alerts, add } = setup ();
    add ({ kind: 'fundinggap', base: 'BTC', aprGap: 0.2 });
    state.setFunding ('okx', new Map ([ [ 'BTC/USDT:USDT', { rate: 0.0001, intervalH: 8, intervalAssumed: false, ts: now.t } ] ]));
    state.setFunding ('hyperliquid', new Map ([ [ 'BTC/USDC:USDC', { rate: 0.0001, intervalH: 1, intervalAssumed: false, ts: now.t } ] ]));
    engine.tick (); // 0.0001*3*365 = 10.95% vs 87.6% => gap 76.65%; but a new rule starts disarmed when already true
    assert.equal (alerts.length, 0);
    now.t += 60_000;
    state.setFunding ('hyperliquid', new Map ([ [ 'BTC/USDC:USDC', { rate: 0.00001, intervalH: 1, intervalAssumed: false, ts: now.t } ] ]));
    engine.tick ();
    now.t += 60_000;
    state.setFunding ('hyperliquid', new Map ([ [ 'BTC/USDC:USDC', { rate: 0.0001, intervalH: 1, intervalAssumed: false, ts: now.t } ] ]));
    engine.tick ();
    assert.equal (alerts.length, 1);
    assert.match (alerts[0].html, /Funding gap · BTC perps/);
});

test ('settlement reminder fires once per settlement', () => {
    const { now, state, engine, alerts, add } = setup ();
    add ({ kind: 'settle', base: 'BTC', venues: [ 'okx' ], minutesBefore: 15 });
    const settle = now.t + 10 * 60_000;
    state.setFunding ('okx', new Map ([ [ 'BTC/USDT:USDT', { rate: 0.0001, intervalH: 8, intervalAssumed: false, settleTs: settle, ts: now.t } ] ]));
    engine.tick ();
    engine.tick ();
    assert.equal (alerts.length, 1);
    assert.match (alerts[0].html, /Funding settles in 10m/);
});

test ('events fan out to matching rules once (natural-key dedupe)', () => {
    const { bus, alerts, add } = setup ();
    add ({ kind: 'listing', venues: [ 'binance' ], markets: [ 'spot' ] });
    add ({ kind: 'wallet', code: 'USDT', venues: [] });
    add ({ kind: 'breaking', types: [ 'status' ] });
    const listing = { key: 'listing:binance:NEW/USDT', type: 'listing' as const, venue: 'binance', symbol: 'NEW/USDT', base: 'NEW', data: { market: 'spot' }, ts: 0 };
    bus.emit (listing);
    bus.emit (listing);
    bus.emit ({ key: 'listing:okx:X/USDT', type: 'listing', venue: 'okx', symbol: 'X/USDT', base: 'X', data: { market: 'spot' }, ts: 0 });
    bus.emit ({ key: 'listing:binance:P/USDT:USDT', type: 'listing', venue: 'binance', symbol: 'P/USDT:USDT', base: 'P', data: { market: 'perp' }, ts: 0 });
    assert.equal (alerts.length, 1);
    bus.emit ({ key: 'wallet:okx:USDT:TRC20:withdraw:false:1', type: 'wallet', venue: 'okx', code: 'USDT', data: { network: 'TRC20', field: 'withdraw', from: true, to: false }, ts: 0 });
    // the wallet rule matches, and the breaking 'status' rule matches stablecoin withdrawal halts
    assert.equal (alerts.length, 3);
    assert.match (alerts[1].html, /Withdrawals paused · USDT on TRC20/);
});

test ('muted rules are skipped', () => {
    const { now, state, engine, alerts, add } = setup ();
    setMajors (state, now.t, 99_000);
    const rule = add ({ kind: 'price', base: 'BTC', op: 'above', value: 100_000 }, 'repeat');
    engine.tick ();
    engine.mute (rule.id, 3_600_000);
    now.t += 10_000;
    setMajors (state, now.t, 101_000);
    engine.tick ();
    assert.equal (alerts.length, 0);
    assert.equal (engine.isMuted (rule.id), true);
});

test ('depeg needs 2 minutes of sustained deviation', () => {
    const { now, state, engine, alerts, add } = setup ();
    add ({ kind: 'depeg', codes: [ 'USDT' ], threshold: 0.005 });
    setMajors (state, now.t);
    engine.tick ();
    for (let i = 0; i < 6; i++) {
        now.t += 30_000;
        setMajors (state, now.t);
        state.setTickers ('kraken', new Map ([ [ 'USDT/USD', { last: 0.99, ts: now.t } ] ]));
        state.setTickers ('coinbase', new Map ([ [ 'USDT/USD', { last: 0.991, ts: now.t } ] ]));
        engine.tick ();
        if (i < 3) {
            assert.equal (alerts.length, 0, 'not yet sustained at step ' + i);
        }
    }
    assert.equal (alerts.length, 1);
    assert.match (alerts[0].html, /Depeg · USDT/);
});
