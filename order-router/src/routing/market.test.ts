import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { resolveDirectHop, candidatePaths, candidatePairs, DEFAULT_BRIDGES } from './market.js';
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
    stalenessPenaltyBps: 0, hopPenaltyBps: 0, includeQuotes: true, ...o,
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

    const paths = candidatePaths(cache, 'SOL', 'BTC', DEFAULT_BRIDGES);
    assert.equal(paths.length, 1, 'SOL -> USDT -> BTC should be the only reachable path');
    assert.equal(paths[0]!.bridge, 'USDT');
    assert.deepEqual(paths[0]!.hops.map((h) => `${h.pair}:${h.side}`), ['SOL/USDT:sell', 'BTC/USDT:buy']);
    assert.deepEqual(candidatePaths(cache, 'SOL', 'BTC', []), [], 'no bridges means no bridging');
    assert.deepEqual(candidatePairs(cache, 'SOL', 'BTC', DEFAULT_BRIDGES).sort(), ['BTC/USDT', 'SOL/USDT']);
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

test('quotes report raw and fee-adjusted prices as different numbers', () => {
    // These two fields exist precisely so a caller can see what the fee costs. Reporting the
    // adjusted price as both would hide it while still looking correct.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, 10]], [[99, 10]]));
    fees.setFee('a', 'BTC/USDT', 0.01);

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] },
        OPTS({ includeFees: true }));
    const q = r.hops[0]!.quotes[0]!;
    assert.equal(q.averagePrice, 100, 'averagePrice must be the RAW book VWAP');
    assert.ok(Math.abs(q.effectivePriceWithFee! - 101) < 1e-9, 'effectivePriceWithFee must include the 1% taker fee');
});

test('exact-out over a bridge is refused distinctly from an unreachable pair', () => {
    // Both are "we cannot route this", but the caller's next move differs: retry with amountIn
    // versus give up on the asset. Collapsing them into no_market would send them the wrong way.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, 1000]], [[10, 1000]]));
    cache.setBook(book('a', 'BTC/USDT', [[50, 1000]], [[50, 1000]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountOut: 1, bridges: ['USDT'] }, OPTS());
    assert.equal(r.unroutableReason, 'exact_out_multi_hop_unsupported');
    const unreachable = computeRoute(cache, fees, { from: 'DOGE', to: 'SHIB', amountOut: 1, bridges: ['USDT'] }, OPTS());
    assert.equal(unreachable.unroutableReason, 'no_market');
});

test('the pinned side is reported as exactly the requested amount, not float noise', () => {
    // The notional walk divides by price and multiplies back, so the spend accumulates residue:
    // this exact book fills 100 USDT as 99.99999999999999. Left unsnapped, a caller checking
    // `amountIn >= 100` or `fillRatio === 1` reads a complete fill as a partial one.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[3.3, 0.7], [7.7, 0.9], [11.1, 500]], [[1, 1]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 100, bridges: [] }, OPTS());
    assert.notEqual(r.hops[0]!.amountIn, 100, 'precondition: the raw walk really does leave residue here');
    assert.equal(r.amountIn, 100, 'the pinned side must be reported as exactly what was requested');
    assert.equal(r.fillRatio, 1);
    assert.equal(r.fullyFillable, true);
    assert.deepEqual(r.warnings, [], 'float noise must not surface as a partial-fill warning');
});

test('a real shortfall is never snapped away as float noise', () => {
    // The counterpart to the snap: it must be tight enough that an actual partial fill still
    // reads as one. A 1% shortfall is not rounding.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, 0.99]], [[99, 1]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] }, OPTS());
    assert.equal(r.fullyFillable, false);
    assert.ok(r.amountOut < 1, `expected a partial fill, got ${r.amountOut}`);
    assert.ok(r.warnings.some((w) => w.startsWith('partial_fill')));
});
