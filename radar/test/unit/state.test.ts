import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketState, Ring, intervalHours, to8h, toApr } from '../../ts/market/state.js';
import { makeState, setMajors } from '../helpers/fixtures.js';

test ('ring buffer keeps spacing, finds values at a time and wraps', () => {
    const r = new Ring (5, 1000);
    for (let i = 0; i < 8; i++) {
        r.push (i * 1000, i);
    }
    assert.equal (r.length, 5);
    assert.deepEqual (r.oldest (), { t: 3000, v: 3 });
    assert.deepEqual (r.at (5500), { t: 5000, v: 5 });
    assert.equal (r.at (100), undefined);
    r.push (7500, 99); // within min gap: replaces the latest value
    assert.deepEqual (r.latest (), { t: 7000, v: 99 });
});

test ('funding normalization: per interval -> 8h-equivalent and APR', () => {
    assert.deepEqual (intervalHours ('1h'), { hours: 1, assumed: false });
    assert.deepEqual (intervalHours (undefined), { hours: 8, assumed: true });
    const hourly = { rate: 0.0001, intervalH: 1 };
    assert.ok (Math.abs (to8h (hourly) - 0.0008) < 1e-12);
    assert.ok (Math.abs (toApr ({ rate: 0.00112, intervalH: 8 }) - 1.2264) < 1e-9); // 0.112%/8h = 122.6% APR
});

test ('resolve maps coins to markets, including multiplied perps', () => {
    const now = { t: 1_000_000 };
    const s = makeState (now);
    assert.deepEqual (s.resolve ('binance', 'btc', 'spot'), { symbol: 'BTC/USDT', multiplier: 1 });
    assert.deepEqual (s.resolve ('kraken', 'BTC', 'spot'), { symbol: 'BTC/USD', multiplier: 1 });
    assert.deepEqual (s.resolve ('binance', 'PEPE', 'perp'), { symbol: '1000PEPE/USDT:USDT', multiplier: 1000 });
    assert.deepEqual (s.resolve ('hyperliquid', 'PEPE', 'perp'), { symbol: 'kPEPE/USDC:USDC', multiplier: 1000 });
    assert.deepEqual (s.resolve ('hyperliquid', 'BTC', 'perp'), { symbol: 'BTC/USDC:USDC', multiplier: 1 });
    assert.equal (s.resolve ('kraken', 'BTC', 'perp'), undefined);
    assert.deepEqual (MarketState.normalizeBase ('1000PEPE'), { base: 'PEPE', multiplier: 1000 });
    assert.deepEqual (MarketState.normalizeBase ('1INCH'), { base: '1INCH', multiplier: 1 });
});

test ('median price converts quotes to USD and ignores stale data', () => {
    const now = { t: 10_000_000 };
    const s = makeState (now);
    setMajors (s, now.t, 100_000);
    s.setTickers ('okx', new Map ([ [ 'BTC/USDT', { last: 100_600, ts: now.t } ] ]));
    const m = s.medianPrice ('BTC')!;
    assert.equal (m.price, 100_000);
    assert.ok (m.venues.length >= 3);
    now.t += 120_000; // everything is now 2 minutes old
    assert.equal (s.medianPrice ('BTC'), undefined);
});

test ('% change needs history covering the window', () => {
    const now = { t: 0 };
    const s = makeState (now);
    for (let i = 0; i <= 120; i++) {
        now.t = i * 30_000;
        s.ring ('median|BTC').push (now.t, 100 + i * 0.05);
    }
    const ch = s.change ('median|BTC', 3_600_000)!;
    assert.ok (ch.pct > 5.5 && ch.pct < 6.1);
    assert.equal (s.change ('median|BTC', 4 * 3_600_000), undefined);
});

test ('degraded venues: never connected, silent, or reporting maintenance', () => {
    const now = { t: 1_000_000 };
    const s = makeState (now);
    assert.equal (s.isDegraded ('binance'), true);
    s.ok ('binance');
    assert.equal (s.isDegraded ('binance'), false);
    s.healthOf ('binance').exchangeStatus = 'maintenance';
    assert.equal (s.isDegraded ('binance'), true);
    s.healthOf ('binance').exchangeStatus = 'ok';
    now.t += 61_000;
    assert.equal (s.isDegraded ('binance'), true);
});
