// Regression tests for issues found in code review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../ts/db.js';
import { EventBus } from '../../ts/events.js';
import type { MarketEvent } from '../../ts/events.js';
import { Engine } from '../../ts/engine.js';
import type { Alert } from '../../ts/alerts.js';
import { Dispatcher } from '../../ts/delivery.js';
import { KIND_DEFAULTS, parseSpec } from '../../ts/rules.js';
import type { RuleSpec } from '../../ts/rules.js';
import { clusterNews } from '../../ts/news.js';
import type { NewsItem } from '../../ts/news.js';
import { numberCheck } from '../../ts/ai/numbercheck.js';
import { ListingTracker } from '../../ts/market/trackers.js';
import { MarketState } from '../../ts/market/state.js';
import { venueProblem } from '../../ts/capabilities.js';
import { loadConfig } from '../../ts/config.js';
import { esc } from '../../ts/format.js';
import { parseShorthand } from '../../ts/parse.js';
import { makeState, setMajors } from '../helpers/fixtures.js';

function engineSetup () {
    const now = { t: 1_800_000_000_000 };
    const store = new Store (':memory:');
    const state = makeState (now);
    const bus = new EventBus ();
    const alerts: Alert[] = [];
    const engine = new Engine (store, state, bus, (a) => alerts.push (a));
    engine.now = () => now.t;
    store.ensureUser (1, { kind: 'dm', dailyBudget: 50 });
    const add = (spec: unknown, mode: 'once' | 'repeat' = 'repeat') => {
        const r = parseSpec (spec) as { ok: true, spec: RuleSpec };
        const rule = store.insertRule ({ chatId: 1, spec: r.spec, mode, cooldownS: KIND_DEFAULTS[r.spec.kind].cooldownS, expiresAt: null, paused: false, breakQuiet: false, source: 'shorthand' });
        engine.markDirty ();
        return rule;
    };
    return { now, store, state, bus, engine, alerts, add };
}

test ('channels get each event once (engine forwards only new events)', () => {
    const { bus, engine } = engineSetup ();
    const posted: MarketEvent[] = [];
    engine.onNewEvent = (ev) => posted.push (ev);
    const ev: MarketEvent = { key: 'macro:fomc-x', type: 'macro', data: { title: 'FOMC', at: 0, source: 'Fed' }, ts: 0 };
    for (let i = 0; i < 10; i++) {
        bus.emit (ev);
    }
    assert.equal (posted.length, 1);
});

test ('a news story keeps its id when more publishers cover it', () => {
    const t = Date.parse ('2026-11-08T12:00:00Z');
    const a: NewsItem = { publisher: 'A', title: 'Protocol X exploited for $12M in flash loan attack', link: 'https://a/1', published: t - 7_200_000, description: '' };
    const b: NewsItem = { publisher: 'B', title: 'Protocol X exploited, $12M drained in flash loan attack', link: 'https://b/1', published: t - 3_600_000, description: '' };
    const c: NewsItem = { publisher: 'C', title: 'Protocol X flash loan attack: $12M exploited', link: 'https://c/1', published: t, description: '' };
    const id2 = clusterNews ([ a, b ])[0].id;
    const id3 = clusterNews ([ a, b, c ])[0].id;
    assert.equal (id2, id3);
});

test ('"once" works for event-driven rules too', () => {
    const { bus, alerts, add, store } = engineSetup ();
    add ({ kind: 'listing', venues: [], markets: [ 'spot' ] }, 'once');
    bus.emit ({ key: 'listing:okx:A/USDT', type: 'listing', venue: 'okx', symbol: 'A/USDT', base: 'A', data: { market: 'spot' }, ts: 0 });
    bus.emit ({ key: 'listing:okx:B/USDT', type: 'listing', venue: 'okx', symbol: 'B/USDT', base: 'B', data: { market: 'spot' }, ts: 0 });
    assert.equal (alerts.length, 1);
    assert.equal (store.countRules (1), 0);
});

test ('a sustained big move alerts once, not every half hour', () => {
    const { now, state, engine, bus } = engineSetup ();
    const evs: MarketEvent[] = [];
    bus.on ((e) => {
        if (e.type === 'bigmove') {
            evs.push (e);
        }
    });
    for (const v of [ 'binance', 'okx', 'kraken', 'coinbase' ]) {
        state.ok (v);
    }
    for (let i = 0; i < 200; i++) { // 100 minutes at 30s steps; BTC jumps 5% at minute 20 and stays there
        now.t += 30_000;
        setMajors (state, now.t, i < 40 ? 100_000 : 105_000);
        state.updateMedians ();
        engine.tick ();
    }
    assert.equal (evs.length, 1);
});

test ('Daily Brief is never merged into other alerts', async () => {
    const store = new Store (':memory:');
    store.ensureUser (1, { kind: 'dm', dailyBudget: 50 });
    const sent: string[] = [];
    const d = new Dispatcher (store, async (_c, html) => {
        sent.push (html);
        return { message_id: sent.length };
    }, () => undefined);
    d.enqueue ({ chatId: 1, priority: 3, ttlMs: 60_000, html: 'BRIEF', summary: 'Daily Brief', countsAgainstBudget: false, buttons: 'none', createdAt: Date.now () });
    d.enqueue ({ chatId: 1, priority: 1, ttlMs: 60_000, html: 'ALERT', summary: 'a', countsAgainstBudget: true, buttons: 'alert', createdAt: Date.now () });
    await d.pump ();
    assert.deepEqual (sent, [ 'ALERT' ]);
    d.lastSent.clear ();
    await d.pump ();
    assert.deepEqual (sent, [ 'ALERT', 'BRIEF' ]);
});

test ('a data gap does not produce a fake % move', () => {
    const now = { t: 0 };
    const s = makeState (now);
    for (let i = 0; i <= 130; i++) {
        s.ring ('median|BTC').push (i * 30_000, 100);
    }
    s.ring ('median|BTC').push (130 * 30_000 + 3 * 3_600_000, 106); // 3h silence, then one new sample
    assert.equal (s.change ('median|BTC', 3_600_000), undefined);
});

test ('number check catches "99k", invented percentages and flipped signs', () => {
    const data = { price: 100_000, change24hPct: -3.41, venues: 4 };
    assert.equal (numberCheck ('BTC is trading at 99k', data).ok, false);
    assert.equal (numberCheck ('BTC is at 100k', data).ok, true);
    assert.equal (numberCheck ('up 45% today', data).ok, false);
    assert.equal (numberCheck ('+3.41% in 24h', data).ok, false);
    assert.equal (numberCheck ('-3.41% in 24h, down 3.41%', data).ok, true);
    assert.equal (numberCheck ('on 4 venues over 24h', data).ok, true);
    assert.equal (numberCheck ('$5 fee', data).ok, false);
});

test ('Hyperliquid k-tokens resolve; real K coins are not mangled', () => {
    const s = makeState ({ t: 0 });
    assert.deepEqual (s.resolve ('hyperliquid', 'PEPE', 'perp'), { symbol: 'KPEPE/USDC:USDC', multiplier: 1000 });
    assert.deepEqual (MarketState.normalizeBase ('KPEPE'), { base: 'PEPE', multiplier: 1000 });
    assert.deepEqual (MarketState.normalizeBase ('KAS'), { base: 'KAS', multiplier: 1 });
});

test ('a reactivated market is not announced as a new listing', () => {
    const base = Array.from ({ length: 100 }, (_, i) => 'C' + i + '/USD');
    const t = new ListingTracker ();
    t.observe ('kraken', base);
    const without = base.filter ((x) => x !== 'C1/USD');
    t.observe ('kraken', without);
    t.observe ('kraken', without);
    assert.equal (t.observe ('kraken', without)[0].change, 'removed');
    t.observe ('kraken', base);
    assert.deepEqual (t.observe ('kraken', base), []);
});

test ('funding re-arm works for a positive lower bound', () => {
    const { now, state, engine, alerts, add } = engineSetup ();
    state.ok ('okx');
    add ({ kind: 'funding', base: 'BTC', venues: [ 'okx' ], high: null, low: 0.0001 });
    const set = (rate: number) => {
        now.t += 5 * 3_600_000; // past the 4h cooldown each step
        state.ok ('okx');
        state.setFunding ('okx', new Map ([ [ 'BTC/USDT:USDT', { rate, intervalH: 8, intervalAssumed: false, ts: now.t } ] ]));
        engine.tick ();
    };
    set (0.0003);
    set (0.00005); // fires
    set (0.00009); // still below the threshold: must not re-arm
    set (0.00005);
    assert.equal (alerts.length, 1);
    set (0.0002); // back above 0.0001 + 20%: re-armed
    set (0.00005);
    assert.equal (alerts.length, 2);
});

test ('rules on venues that cannot serve them are rejected before saving', () => {
    const cfg = loadConfig ({} as any);
    assert.match (venueProblem (parseShorthand ('btc > 100k upbit')!.spec, cfg)!, /Upbit doesn't support price alerts/);
    assert.match (venueProblem (parseShorthand ('funding eth > 0.1% mexc')!.spec, cfg)!, /MEXC doesn't support funding alerts/);
    assert.equal (venueProblem (parseShorthand ('listings upbit')!.spec, cfg), undefined);
    assert.equal (venueProblem (parseShorthand ('btc > 100k kraken')!.spec, cfg), undefined);
});

test ('quotes are escaped for use inside href attributes', () => {
    assert.equal (esc ('https://x.example/?a="b"'), 'https://x.example/?a=&quot;b&quot;');
});
