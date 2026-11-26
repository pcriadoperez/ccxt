import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShorthand } from '../../ts/parse.js';
import { describeSpec, parseSpec } from '../../ts/rules.js';

test ('price level: "btc > 100k" fires once, median by default', () => {
    const r = parseShorthand ('btc > 100k')!;
    assert.equal (r.mode, 'once');
    assert.deepEqual ({ ...r.spec }, { kind: 'price', base: 'BTC', market: 'spot', venue: 'median', field: 'last', op: 'above', value: 100_000 });
});

test ('price level with venue, perp, mark and glued operator', () => {
    const r = parseShorthand ('/alert eth <2.5k bybit mark')!;
    assert.equal (r.spec.kind, 'price');
    if (r.spec.kind === 'price') {
        assert.equal (r.spec.venue, 'bybit');
        assert.equal (r.spec.market, 'perp');
        assert.equal (r.spec.field, 'mark');
        assert.equal (r.spec.op, 'below');
        assert.equal (r.spec.value, 2500);
    }
});

test ('word operators and repeat modifier', () => {
    const r = parseShorthand ('sol above 200 on okx repeat')!;
    assert.equal (r.mode, 'repeat');
    assert.equal (r.spec.kind === 'price' && r.spec.venue, 'okx');
});

test ('% move: unsigned is both directions, signed picks a direction', () => {
    const both = parseShorthand ('sol 5% 4h')!;
    assert.equal (both.spec.kind, 'move');
    if (both.spec.kind === 'move') {
        assert.equal (both.spec.direction, 'both');
        assert.equal (both.spec.windowMin, 240);
        assert.equal (both.spec.pct, 5);
    }
    const down = parseShorthand ('eth -3% 15m')!;
    assert.equal (down.spec.kind === 'move' && down.spec.direction, 'down');
});

test ('% from reference becomes a price rule with a note', () => {
    const r = parseShorthand ('eth -10% from 3400')!;
    assert.equal (r.spec.kind, 'price');
    if (r.spec.kind === 'price') {
        assert.equal (r.spec.op, 'below');
        assert.equal (r.spec.value, 3060);
        assert.match (r.spec.note || '', /10% below your reference 3400/);
    }
});

test ('funding: thresholds are fractions of 8h-equivalent, "any" means top perps', () => {
    const r = parseShorthand ('funding eth > 0.05% < -0.02% bybit')!;
    assert.equal (r.spec.kind, 'funding');
    if (r.spec.kind === 'funding') {
        assert.equal (r.spec.base, 'ETH');
        assert.equal (r.spec.high, 0.0005);
        assert.equal (r.spec.low, -0.0002);
        assert.deepEqual (r.spec.venues, [ 'bybit' ]);
    }
    const any = parseShorthand ('funding any')!;
    assert.equal (any.spec.kind === 'funding' && any.spec.base, '*');
});

test ('other kinds: gap, settle, oi, listings, wallet, status, depeg', () => {
    assert.equal (parseShorthand ('gap btc 20%')!.spec.kind, 'fundinggap');
    assert.equal (parseShorthand ('settle btc')!.spec.kind, 'settle');
    const oi = parseShorthand ('oi btc 8% 1h')!;
    assert.equal (oi.spec.kind === 'oi' && oi.spec.windowMin, 60);
    const l = parseShorthand ('listings binance upbit')!;
    assert.deepEqual (l.spec.kind === 'listing' && l.spec.venues, [ 'binance', 'upbit' ]);
    assert.equal (parseShorthand ('wallet usdt')!.spec.kind === 'wallet' && (parseShorthand ('wallet usdt')!.spec as any).code, 'USDT');
    assert.equal (parseShorthand ('status')!.spec.kind, 'status');
    assert.deepEqual ((parseShorthand ('depeg')!.spec as any).codes, [ 'USDT', 'USDC' ]);
});

test ('non-rules are rejected so they can go to the AI', () => {
    assert.equal (parseShorthand ('ping me if eth funding goes crazy'), undefined);
    assert.equal (parseShorthand ('where is sol cheapest?'), undefined);
    assert.equal (parseShorthand ('btc'), undefined);
});

test ('schema rejects bad specs', () => {
    assert.equal (parseSpec ({ kind: 'price', base: 'BTC', op: 'above', value: -1 }).ok, false);
    assert.equal (parseSpec ({ kind: 'funding', base: 'BTC', high: null, low: null }).ok, false);
    assert.equal (parseSpec ({ kind: 'nope' }).ok, false);
});

test ('descriptions are readable', () => {
    assert.equal (describeSpec (parseShorthand ('btc > 100k')!.spec), 'BTC rises above 100,000 · median of major venues');
    assert.match (describeSpec (parseShorthand ('funding eth > 0.1%')!.spec), /ETH perp funding \(8h-equiv\.\) above \+0\.100%/);
});
