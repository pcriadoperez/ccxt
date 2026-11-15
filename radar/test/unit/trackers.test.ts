import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListingTracker, WalletTracker } from '../../ts/market/trackers.js';

const base = Array.from ({ length: 100 }, (_, i) => 'C' + i + '/USDT');

test ('first snapshot only sets the baseline', () => {
    const t = new ListingTracker ();
    assert.deepEqual (t.observe ('binance', base), []);
});

test ('a new market needs two consecutive sightings', () => {
    const t = new ListingTracker ();
    t.observe ('binance', base);
    assert.deepEqual (t.observe ('binance', [ ...base, 'NEW/USDT' ]), []);
    assert.deepEqual (t.observe ('binance', [ ...base, 'NEW/USDT' ]), [ { venue: 'binance', symbol: 'NEW/USDT', change: 'added' } ]);
    assert.deepEqual (t.observe ('binance', [ ...base, 'NEW/USDT' ]), []);
});

test ('a flicker (seen once, then gone) is not a listing', () => {
    const t = new ListingTracker ();
    t.observe ('okx', base);
    t.observe ('okx', [ ...base, 'X/USDT' ]);
    t.observe ('okx', base);
    assert.deepEqual (t.observe ('okx', [ ...base, 'X/USDT' ]), []);
});

test ('a removal needs three consecutive absences', () => {
    const t = new ListingTracker ();
    t.observe ('kraken', base);
    const without = base.filter ((s) => s !== 'C5/USDT');
    assert.deepEqual (t.observe ('kraken', without), []);
    assert.deepEqual (t.observe ('kraken', without), []);
    assert.deepEqual (t.observe ('kraken', without), [ { venue: 'kraken', symbol: 'C5/USDT', change: 'removed' } ]);
});

test ('a partial response (>5% smaller) is ignored entirely', () => {
    const t = new ListingTracker ();
    t.observe ('gate', base);
    const partial = base.slice (0, 80);
    for (let i = 0; i < 5; i++) {
        assert.deepEqual (t.observe ('gate', partial), []);
    }
});

test ('baselines survive a restart via snapshot()', () => {
    const t = new ListingTracker ();
    t.observe ('binance', base);
    t.observe ('binance', [ ...base, 'NEW/USDT' ]);
    const restored = new ListingTracker (JSON.parse (JSON.stringify (t.snapshot ())));
    assert.equal (restored.observe ('binance', [ ...base, 'NEW/USDT' ]).length, 1);
});

test ('wallet status changes need two confirmations and report both directions', () => {
    const w = new WalletTracker ();
    const open = { USDT: { TRC20: { deposit: true, withdraw: true } } };
    const paused = { USDT: { TRC20: { deposit: true, withdraw: false } } };
    assert.deepEqual (w.observe ('okx', open), []);
    assert.deepEqual (w.observe ('okx', paused), []);
    assert.deepEqual (w.observe ('okx', paused), [ { venue: 'okx', code: 'USDT', network: 'TRC20', field: 'withdraw', from: true, to: false } ]);
    assert.deepEqual (w.observe ('okx', paused), []);
    w.observe ('okx', open);
    assert.equal (w.observe ('okx', open)[0].to, true);
});

test ('wallet changes for untracked codes are absorbed silently', () => {
    const w = new WalletTracker ();
    w.observe ('gate', { JUNK: { ERC20: { deposit: true } } }, new Set ([ 'USDT' ]));
    w.observe ('gate', { JUNK: { ERC20: { deposit: false } } }, new Set ([ 'USDT' ]));
    assert.deepEqual (w.observe ('gate', { JUNK: { ERC20: { deposit: false } } }, new Set ([ 'USDT' ])), []);
});
