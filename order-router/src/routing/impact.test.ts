import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { computeRoute, type RouteOptions } from './route.js';
import type { CachedOrderBook } from '../types.js';

function book (
    exchangeId: string, symbol: string, bids: [number, number][], asks: [number, number][],
): CachedOrderBook {
    return {
        exchangeId, symbol,
        bids: bids.map(([price, amount]) => ({ price, amount })),
        asks: asks.map(([price, amount]) => ({ price, amount })),
        exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
    };
}
const OPTS = (o: Partial<RouteOptions> = {}): RouteOptions => ({
    strategy: 'split_optimal', includeFees: false, maxVenues: 5, minLegNotional: 0,
    staleBookMs: 5000, requestId: 'test', certifiedOnly: false, requireFullFill: false,
    stalenessPenaltyBps: 0, hopPenaltyBps: 0, includeQuotes: true, ...o,
});
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

test('an order that fits inside the top level has zero impact', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[99, 10]], [[100, 10]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] }, OPTS());
    assert.equal(r.hops[0]!.referencePrice, 100);
    assert.ok(close(r.hops[0]!.impactBps!, 0), `expected 0 bps, got ${r.hops[0]!.impactBps}`);
    assert.ok(close(r.impactBps!, 0));
});

test('impact grows with size as the order reaches deeper levels', () => {
    // Buy 2 against 1 @ 100 then 10 @ 110: VWAP 105 against a 100 benchmark is 500 bps of impact.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[99, 10]], [[100, 1], [110, 10]]));

    const small = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] }, OPTS());
    const large = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 2, bridges: [] }, OPTS());
    assert.ok(close(small.hops[0]!.impactBps!, 0));
    assert.ok(close(large.hops[0]!.impactBps!, 500), `expected 500 bps, got ${large.hops[0]!.impactBps}`);
    assert.ok(large.hops[0]!.impactBps! > small.hops[0]!.impactBps!);
});

test('impact is positive on a sell too — positive always means worse', () => {
    // Selling 2 into 1 @ 100 then 10 @ 90 realises 95 against a 100 benchmark. A raw difference
    // would come out negative here; the sign is normalised so callers never have to branch.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, 1], [90, 10]], [[101, 10]]));

    const r = computeRoute(cache, fees, { from: 'BTC', to: 'USDT', amountIn: 2, bridges: [] }, OPTS());
    assert.equal(r.hops[0]!.side, 'sell');
    assert.equal(r.hops[0]!.referencePrice, 100);
    assert.ok(close(r.hops[0]!.impactBps!, 500), `expected +500 bps, got ${r.hops[0]!.impactBps}`);
});

test('the benchmark is the best price anywhere, not the chosen venue own top of book', () => {
    // A cheap-but-tiny venue sets the benchmark even when the route cannot use it. Measuring
    // against the chosen venue instead would report zero impact for an order that demonstrably
    // paid more than the market's best available price.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('cheapTiny', 'BTC/USDT', [[98, 1]], [[100, 0.0001]]));
    cache.setBook(book('deepDearer', 'BTC/USDT', [[98, 1]], [[101, 1000]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] },
        OPTS({ strategy: 'best_single' }));
    assert.equal(r.hops[0]!.legs[0]!.exchangeId, 'deepDearer', 'only the deep venue can fill 1');
    assert.equal(r.hops[0]!.referencePrice, 100, 'the benchmark comes from the cheap venue');
    assert.ok(close(r.hops[0]!.impactBps!, 100), `expected ~100 bps, got ${r.hops[0]!.impactBps}`);
});

test('fees do not show up as impact — both sides of the comparison carry them', () => {
    // Impact must isolate the cost of consuming depth. A flat fee shifts the benchmark and the
    // achieved price by the same factor, so it has to cancel out.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[99, 10]], [[100, 1], [110, 10]]));
    fees.setFee('a', 'BTC/USDT', 0.01);

    const withFees = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 2, bridges: [] },
        OPTS({ includeFees: true }));
    const without = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 2, bridges: [] },
        OPTS({ includeFees: false }));
    assert.ok(close(withFees.hops[0]!.impactBps!, without.hops[0]!.impactBps!),
        `fees changed impact: ${withFees.hops[0]!.impactBps} vs ${without.hops[0]!.impactBps}`);
    // ...but they DO show up in the price itself, which is the point of keeping them separate.
    assert.ok(withFees.hops[0]!.referencePrice! > without.hops[0]!.referencePrice!);
});

test('the end-to-end benchmark chains the hops reference prices', () => {
    // Sell SOL at 10 then buy BTC at 50: frictionless, 10 SOL is worth 0.2 BTC per SOL. The
    // second leg is thin, so the realised rate falls short and the shortfall is the impact.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, 1000]], [[10, 1000]]));
    cache.setBook(book('a', 'BTC/USDT', [[49, 1000]], [[50, 1], [100, 1000]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] }, OPTS());
    assert.equal(r.hops.length, 2);
    assert.ok(close(r.referenceRate!, 0.2), `expected a 0.2 benchmark rate, got ${r.referenceRate}`);
    // 100 USDT buys 1 BTC at 50, then 0.5 BTC at 100 => 1.5 BTC for 10 SOL.
    assert.ok(close(r.amountOut, 1.5));
    assert.ok(close(r.effectiveRate!, 0.15));
    assert.ok(close(r.impactBps!, 2500), `expected 2500 bps end to end, got ${r.impactBps}`);
    assert.ok(close(r.hops[0]!.impactBps!, 0), 'the first leg was deep enough to cost nothing');
    assert.ok(r.hops[1]!.impactBps! > 0, 'all of the impact came from the second leg');
});

test('impact is null rather than zero when there is nothing to benchmark against', () => {
    // Zero would read as "no impact", which is a much stronger claim than "unknown".
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    const stale = book('a', 'BTC/USDT', [[99, 10]], [[100, 10]]);
    stale.receivedAt = Date.now() - 60_000;
    cache.setBook(stale);

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] }, OPTS());
    assert.equal(r.unroutableReason, 'all_books_stale');
    assert.equal(r.impactBps, null);
    assert.equal(r.referenceRate, null);
    assert.equal(r.hops[0]!.referencePrice, null);
    assert.equal(r.hops[0]!.impactBps, null);
});

test('splitting across venues reduces impact versus the best single venue', () => {
    // The economic case for split routing, stated in the units a trader thinks in.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[99, 10]], [[100, 1], [130, 100]]));
    cache.setBook(book('b', 'BTC/USDT', [[99, 10]], [[101, 1], [131, 100]]));
    cache.setBook(book('c', 'BTC/USDT', [[99, 10]], [[102, 1], [132, 100]]));

    const single = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 3, bridges: [] },
        OPTS({ strategy: 'best_single' }));
    const split = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountOut: 3, bridges: [] },
        OPTS({ strategy: 'split_optimal' }));
    assert.equal(split.hops[0]!.legs.length, 3);
    assert.ok(split.hops[0]!.impactBps! < single.hops[0]!.impactBps!,
        `split ${split.hops[0]!.impactBps} should beat single ${single.hops[0]!.impactBps}`);
});
