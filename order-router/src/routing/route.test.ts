import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { computeRoute, type RouteOptions } from './route.js';
import type { CachedOrderBook } from '../types.js';

function book (exchangeId: string, asks: [number, number][], bids: [number, number][] = [[1, 1]]): CachedOrderBook {
    return {
        exchangeId, symbol: 'BTC/USDT',
        asks: asks.map(([price, amount]) => ({ price, amount })),
        bids: bids.map(([price, amount]) => ({ price, amount })),
        exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
    };
}
const OPTS = (o: Partial<RouteOptions> = {}): RouteOptions => ({
    strategy: 'split_optimal', includeFees: true, maxVenues: 3,
    minLegNotional: 0, staleBookMs: 5000, requestId: 'test-req', ...o,
});

test('split_optimal beats best_single by consuming cheap levels across venues', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    // A is cheapest but shallow; B has the rest. A single venue cannot capture both.
    cache.setBook(book('a', [[100, 1]]));
    cache.setBook(book('b', [[101, 10]]));
    fees.setFee('a', 'BTC/USDT', 0); fees.setFee('b', 'BTC/USDT', 0);

    const single = computeRoute(cache, fees, 'BTC/USDT', 'buy', 3, OPTS({ strategy: 'best_single' }));
    const split = computeRoute(cache, fees, 'BTC/USDT', 'buy', 3, OPTS());

    assert.equal(single.route.length, 1);
    assert.equal(single.routeVwap, 101, 'best_single must use one venue only');
    assert.equal(split.route.length, 2);
    // 1 @ 100 + 2 @ 101 = 302 / 3
    assert.ok(Math.abs(split.routeVwap! - 302 / 3) < 1e-9);
    assert.ok(split.savingVsBestSingleBps! > 0, 'split should report positive saving');
});

test('levels are fee-adjusted BEFORE merging, so a cheap-but-costly venue loses', () => {
    // Raw price says A wins (100 < 100.5). Fees invert it: A=100*1.01=101, B=100.5*1.0001=100.51.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 10]]));
    cache.setBook(book('b', [[100.5, 10]]));
    fees.setFee('a', 'BTC/USDT', 0.01);
    fees.setFee('b', 'BTC/USDT', 0.0001);

    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.equal(r.route[0]!.exchangeId, 'b', 'fee-adjusted merge must prefer b despite worse raw price');
});

test('includeFees=false zeroes fee cost and leaves effective price equal to raw', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 10]]));
    fees.setFee('a', 'BTC/USDT', 0.01);

    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ includeFees: false }));
    assert.equal(r.totalFeeCost, 0);
    assert.equal(r.route[0]!.effectivePrice, r.route[0]!.averagePrice);
    assert.equal(r.route[0]!.takerFeeRate, 0);
});

test('split_capped limits the number of venues', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    for (const [i, ex] of ['a', 'b', 'c', 'd', 'e'].entries()) {
        cache.setBook(book(ex, [[100 + i, 1]]));
        fees.setFee(ex, 'BTC/USDT', 0);
    }
    const uncapped = computeRoute(cache, fees, 'BTC/USDT', 'buy', 5, OPTS());
    const capped = computeRoute(cache, fees, 'BTC/USDT', 'buy', 5, OPTS({ strategy: 'split_capped', maxVenues: 2 }));

    assert.ok(uncapped.route.length > 2);
    assert.ok(capped.route.length <= 2, `expected <=2 venues, got ${capped.route.length}`);
});

test('minLegNotional suppresses dust legs and reallocates the freed size', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('dust', [[99, 0.001]]));   // best price but a tiny, unusable leg
    cache.setBook(book('real', [[100, 10]]));
    fees.setFee('dust', 'BTC/USDT', 0); fees.setFee('real', 'BTC/USDT', 0);

    // 50 sits between the dust leg (~0.099) and the real leg (~200). A threshold above BOTH
    // would trip the all-legs-too-small guard instead — covered separately below.
    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 2, OPTS({ minLegNotional: 50 }));
    assert.deepEqual(r.route.map((l) => l.exchangeId), ['real']);
    assert.equal(r.filledAmount, 2, 'size dropped from the dust leg must be reallocated, not lost');
});

test('sell side ranks by highest proceeds and fees reduce them', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[1, 1]], [[100, 10]]));
    cache.setBook(book('b', [[1, 1]], [[101, 10]]));
    fees.setFee('a', 'BTC/USDT', 0); fees.setFee('b', 'BTC/USDT', 0);

    const r = computeRoute(cache, fees, 'BTC/USDT', 'sell', 1, OPTS());
    assert.equal(r.route[0]!.exchangeId, 'b', 'sell must prefer the higher bid');
    assert.equal(r.routeVwap, 101);
});

test('stale books are excluded from the route entirely', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    const stale = book('stale', [[1, 100]]); stale.receivedAt = Date.now() - 60_000;
    cache.setBook(stale);
    cache.setBook(book('fresh', [[100, 10]]));
    fees.setFee('stale', 'BTC/USDT', 0); fees.setFee('fresh', 'BTC/USDT', 0);

    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.deepEqual(r.route.map((l) => l.exchangeId), ['fresh'], 'a stale venue must never win on price');
});

test('empty cache yields an empty route rather than a null special case', () => {
    const r = computeRoute(new OrderBookCache(), new FeeRegistry(), 'NONE/USDT', 'buy', 1, OPTS());
    assert.deepEqual(r.route, []);
    assert.equal(r.filledAmount, 0);
    assert.equal(r.fullyFillable, false);
    assert.equal(r.routeVwap, undefined);
});

test('carries the request id and a calculation timestamp for auditing', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 10]]));
    const before = Date.now();
    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ requestId: 'req-abc' }));
    assert.equal(r.requestId, 'req-abc');
    assert.ok(r.calculatedAt >= before && r.calculatedAt <= Date.now());
    assert.equal(new Date(r.calculatedAtIso).getTime(), r.calculatedAt, 'iso and epoch must agree');
});

test('partial fill is reported honestly rather than inflating the price', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 0.5]]));
    fees.setFee('a', 'BTC/USDT', 0);
    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 5, OPTS());
    assert.equal(r.filledAmount, 0.5);
    assert.equal(r.fullyFillable, false);
    assert.equal(r.routeVwap, 100);
});

test('when every leg is below minLegNotional the route is kept rather than emptied', () => {
    // Suppressing all legs would turn "your order is small" into "no liquidity exists", which is
    // both wrong and less useful than returning the small fills.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 10]]));
    fees.setFee('a', 'BTC/USDT', 0);
    const r = computeRoute(cache, fees, 'BTC/USDT', 'buy', 0.01, OPTS({ minLegNotional: 1_000_000 }));
    assert.equal(r.route.length, 1);
    assert.equal(r.filledAmount, 0.01);
});
