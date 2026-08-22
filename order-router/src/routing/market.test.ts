import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { resolveDirectHop, resolveBridgedHops, DEFAULT_BRIDGES } from './market.js';
import { computeRoute, type RouteOptions } from './route.js';
import type { CachedOrderBook } from '../types.js';

function book (
    exchangeId: string, symbol: string,
    asks: [number, number][], bids: [number, number][],
): CachedOrderBook {
    return {
        exchangeId, symbol,
        asks: asks.map(([price, amount]) => ({ price, amount })),
        bids: bids.map(([price, amount]) => ({ price, amount })),
        exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
    };
}
const OPTS = (o: Partial<RouteOptions> = {}): RouteOptions => ({
    strategy: 'split_optimal', includeFees: false, maxVenues: 3, minLegNotional: 0,
    staleBookMs: 5000, requestId: 'test', certifiedOnly: false, requireFullFill: false,
    stalenessPenaltyBps: 0, ...o,
});

test('direction is derived from the asset pair, not supplied by the caller', () => {
    const cache = new OrderBookCache();
    cache.setBook(book('a', 'BTC/USDT', [[100, 1]], [[99, 1]]));

    // USDT -> BTC is a BUY of BTC/USDT; BTC -> USDT is a SELL of the very same pair. Getting this
    // backwards is the classic symbol+side bug the v2 contract removes.
    assert.deepEqual(resolveDirectHop(cache, 'USDT', 'BTC'),
        { pair: 'BTC/USDT', base: 'BTC', quote: 'USDT', side: 'buy' });
    assert.deepEqual(resolveDirectHop(cache, 'BTC', 'USDT'),
        { pair: 'BTC/USDT', base: 'BTC', quote: 'USDT', side: 'sell' });
    assert.equal(resolveDirectHop(cache, 'SOL', 'DOGE'), null);
});

test('bridging finds a two-hop path when no direct market exists', () => {
    const cache = new OrderBookCache();
    cache.setBook(book('a', 'SOL/USDT', [[10, 100]], [[10, 100]]));
    cache.setBook(book('a', 'BTC/USDT', [[100, 100]], [[100, 100]]));

    const hops = resolveBridgedHops(cache, 'SOL', 'BTC', DEFAULT_BRIDGES);
    assert.ok(hops, 'SOL -> USDT -> BTC should be reachable');
    assert.deepEqual(hops!.map((h) => `${h.pair}:${h.side}`), ['SOL/USDT:sell', 'BTC/USDT:buy']);
    assert.equal(resolveBridgedHops(cache, 'SOL', 'BTC', []), null, 'no bridges means no bridging');
});

test('exact-in is a notional walk: spending a fixed quote budget, not buying a fixed size', () => {
    // Buy BTC with exactly 1,000 USDT against a book of 100 @ 5 and 200 @ 5. A quantity walk
    // would misread 1000 as "1000 BTC"; the notional walk must stop when the money is gone:
    // 5 units at 100 = 500 spent, then 2.5 units at 200 = the remaining 500.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, 5], [200, 5]], [[99, 1]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] }, OPTS());
    assert.equal(r.exactSide, 'in');
    assert.ok(Math.abs(r.amountIn - 1000) < 1e-9, `spent ${r.amountIn}, expected 1000`);
    assert.ok(Math.abs(r.amountOut - 7.5) < 1e-9, `received ${r.amountOut} BTC, expected 7.5`);
    assert.equal(r.fullyFillable, true);
});

test('exact-in stops at the book, not at the budget, when depth runs out', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, 1]], [[99, 1]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] }, OPTS());
    assert.equal(r.fullyFillable, false);
    assert.ok(Math.abs(r.amountIn - 100) < 1e-9, 'only 100 USDT of depth existed');
    assert.equal(r.requestedAmount, 1000);
    assert.ok(Math.abs(r.unfilledAmount - 900) < 1e-9);
    assert.match(r.warnings[0]!, /partial_fill/);
});

test('a multi-hop route chains realised output into the next hop', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    // Sell 10 SOL at 10 USDT = 100 USDT, then buy BTC at 50 USDT = 2 BTC.
    cache.setBook(book('a', 'SOL/USDT', [[10, 1000]], [[10, 1000]]));
    cache.setBook(book('a', 'BTC/USDT', [[50, 1000]], [[50, 1000]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] }, OPTS());
    assert.equal(r.hops.length, 2);
    assert.ok(Math.abs(r.hops[0]!.amountOut - 100) < 1e-9, 'hop 1 should realise 100 USDT');
    assert.ok(Math.abs(r.hops[1]!.amountIn - 100) < 1e-9, 'hop 2 must be funded by hop 1 output');
    assert.ok(Math.abs(r.amountOut - 2) < 1e-9);
    assert.ok(Math.abs(r.effectiveRate! - 0.2) < 1e-9, 'end-to-end rate is BTC per SOL');
    assert.ok(r.warnings.some((w) => w.startsWith('multi_hop')), 'the caller must be told it was bridged');
});

test('fees are reported per hop in their own currency, never summed across hops', () => {
    // Hop 1 charges USDT, hop 2 charges USDT here — but the guarantee that matters is that each
    // hop names its own fee currency, so a caller never adds SOL fees to BTC fees.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, 1000]], [[10, 1000]]));
    cache.setBook(book('a', 'BTC/USDT', [[50, 1000]], [[50, 1000]]));
    fees.setFee('a', 'SOL/USDT', 0.001); fees.setFee('a', 'BTC/USDT', 0.002);

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] },
        OPTS({ includeFees: true }));
    assert.equal(r.hops[0]!.feeCurrency, 'USDT');
    assert.equal(r.hops[1]!.feeCurrency, 'USDT');
    assert.ok(r.hops[0]!.feeCost > 0 && r.hops[1]!.feeCost > 0);
    assert.equal((r as unknown as Record<string, unknown>)['totalFeeCost'], undefined,
        'a cross-currency fee total would be a meaningless number');
});

test('an unreachable asset pair is unroutable with no_market, not an empty fill', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, 1]], [[99, 1]]));

    const r = computeRoute(cache, fees, { from: 'DOGE', to: 'SHIB', amountIn: 1, bridges: DEFAULT_BRIDGES }, OPTS());
    assert.equal(r.unroutableReason, 'no_market');
    assert.deepEqual(r.hops, []);
    assert.equal(r.effectiveRate, null);
});

test('the failing hop is identified by index on a multi-hop route', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, 1000]], [[10, 1000]]));
    // Hop 2's book exists but is empty on the side the route needs.
    cache.setBook(book('a', 'BTC/USDT', [], [[50, 1000]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] }, OPTS());
    assert.equal(r.unroutableHopIndex, 1, 'hop 0 succeeded; the failure is downstream');
    assert.equal(r.hops.length, 2, 'the partial path is still returned for diagnosis');
});
