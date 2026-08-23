import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { computeRoute, stalenessPenaltyFraction, type RouteOptions } from './route.js';
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
    minLegNotional: 0, staleBookMs: 5000, requestId: 'test-req', certifiedOnly: false, requireFullFill: false, stalenessPenaltyBps: 0, hopPenaltyBps: 0, ...o,
});

// Adapter over the v2 asset-to-asset contract, expressed in the old symbol+side terms these
// tests were written against. Buying BASE means spending QUOTE for an exact BASE amount; selling
// means spending an exact BASE amount. Bridging is disabled so each case exercises one hop.
function run (
    cache: OrderBookCache, fees: FeeRegistry, symbol: string,
    side: 'buy' | 'sell', amount: number, opts: RouteOptions,
) {
    const [base, quote] = symbol.split('/') as [string, string];
    const req = side === 'buy'
        ? { from: quote, to: base, amountOut: amount, bridges: [] }
        : { from: base, to: quote, amountIn: amount, bridges: [] };
    const r = computeRoute(cache, fees, req, opts);
    const hop = r.hops[0];
    return {
        ...r,
        route: hop?.legs ?? [],
        quotes: hop?.quotes ?? [],
        freshVenueCount: hop?.freshVenueCount ?? 0,
        totalFeeCost: r.hops.reduce((s, h) => s + h.feeCost, 0),
        filledAmount: side === 'buy' ? r.amountOut : r.amountIn,
        routeVwap: r.amountIn > 0 && r.amountOut > 0
            ? (side === 'buy' ? r.amountIn / r.amountOut : r.amountOut / r.amountIn)
            : null,
    };
}

test('split_optimal beats best_single by consuming cheap levels across venues', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    // A is cheapest but shallow; B has the rest. A single venue cannot capture both.
    cache.setBook(book('a', [[100, 1]]));
    cache.setBook(book('b', [[101, 10]]));
    fees.setFee('a', 'BTC/USDT', 0); fees.setFee('b', 'BTC/USDT', 0);

    const single = run(cache, fees, 'BTC/USDT', 'buy', 3, OPTS({ strategy: 'best_single' }));
    const split = run(cache, fees, 'BTC/USDT', 'buy', 3, OPTS());

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

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.equal(r.route[0]!.exchangeId, 'b', 'fee-adjusted merge must prefer b despite worse raw price');
});

test('includeFees=false zeroes fee cost and leaves effective price equal to raw', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 10]]));
    fees.setFee('a', 'BTC/USDT', 0.01);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ includeFees: false }));
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
    const uncapped = run(cache, fees, 'BTC/USDT', 'buy', 5, OPTS());
    const capped = run(cache, fees, 'BTC/USDT', 'buy', 5, OPTS({ strategy: 'split_capped', maxVenues: 2 }));

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
    const r = run(cache, fees, 'BTC/USDT', 'buy', 2, OPTS({ minLegNotional: 50 }));
    assert.deepEqual(r.route.map((l) => l.exchangeId), ['real']);
    assert.equal(r.filledAmount, 2, 'size dropped from the dust leg must be reallocated, not lost');
});

test('sell side ranks by highest proceeds and fees reduce them', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[1, 1]], [[100, 10]]));
    cache.setBook(book('b', [[1, 1]], [[101, 10]]));
    fees.setFee('a', 'BTC/USDT', 0); fees.setFee('b', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'sell', 1, OPTS());
    assert.equal(r.route[0]!.exchangeId, 'b', 'sell must prefer the higher bid');
    assert.equal(r.routeVwap, 101);
});

test('stale books are excluded from the route entirely', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    const stale = book('stale', [[1, 100]]); stale.receivedAt = Date.now() - 60_000;
    cache.setBook(stale);
    cache.setBook(book('fresh', [[100, 10]]));
    fees.setFee('stale', 'BTC/USDT', 0); fees.setFee('fresh', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.deepEqual(r.route.map((l) => l.exchangeId), ['fresh'], 'a stale venue must never win on price');
});

test('empty cache yields an empty route rather than a null special case', () => {
    const r = run(new OrderBookCache(), new FeeRegistry(), 'NONE/USDT', 'buy', 1, OPTS());
    assert.deepEqual(r.route, []);
    assert.equal(r.filledAmount, 0);
    assert.equal(r.fullyFillable, false);
    assert.equal(r.routeVwap, null);
});

test('carries the request id and a calculation timestamp for auditing', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 10]]));
    const before = Date.now();
    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ requestId: 'req-abc' }));
    assert.equal(r.requestId, 'req-abc');
    assert.ok(r.calculatedAt >= before && r.calculatedAt <= Date.now());
    assert.equal(new Date(r.calculatedAtIso).getTime(), r.calculatedAt, 'iso and epoch must agree');
});

test('partial fill is reported honestly rather than inflating the price', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 0.5]]));
    fees.setFee('a', 'BTC/USDT', 0);
    const r = run(cache, fees, 'BTC/USDT', 'buy', 5, OPTS());
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
    const r = run(cache, fees, 'BTC/USDT', 'buy', 0.01, OPTS({ minLegNotional: 1_000_000 }));
    assert.equal(r.route.length, 1);
    assert.equal(r.filledAmount, 0.01);
});

test('exchanges filter restricts routing to the named venues', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('binance', [[100, 10]]));
    cache.setBook(book('kraken', [[101, 10]]));
    cache.setBook(book('someother', [[99, 10]]));   // cheapest, but not requested
    for (const ex of ['binance', 'kraken', 'someother']) fees.setFee(ex, 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1,
        OPTS({ exchanges: new Set(['binance', 'kraken']) }));

    assert.deepEqual(r.route.map((l) => l.exchangeId), ['binance']);
    assert.ok(!r.quotes.some((q) => q.exchangeId === 'someother'), 'excluded venue must not appear in quotes either');
    assert.deepEqual(r.exchangesFilter, ['binance', 'kraken']);
});

test('an empty exchanges list means no venues, not all venues', () => {
    // Widening an explicitly empty allowlist would be the opposite of what was asked.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('binance', [[100, 10]]));
    fees.setFee('binance', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ exchanges: new Set() }));
    assert.deepEqual(r.route, []);
    assert.equal(r.filledAmount, 0);
});

test('certified flag restricts to ccxt-certified venues', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('binance', [[101, 10]]));    // certified
    cache.setBook(book('p2b', [[100, 10]]));        // cheaper, NOT certified
    fees.setFee('binance', 'BTC/USDT', 0); fees.setFee('p2b', 'BTC/USDT', 0);

    const open = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.equal(open.route[0]!.exchangeId, 'p2b', 'unfiltered should take the cheaper venue');

    const cert = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ certifiedOnly: true }));
    assert.equal(cert.route[0]!.exchangeId, 'binance', 'certified-only must skip the cheaper uncertified venue');
    assert.equal(cert.certifiedOnly, true);
});

test('exchanges and certified compose as an intersection', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('binance', [[101, 10]]));    // in list AND certified
    cache.setBook(book('p2b', [[100, 10]]));        // in list, NOT certified
    fees.setFee('binance', 'BTC/USDT', 0); fees.setFee('p2b', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1,
        OPTS({ exchanges: new Set(['binance', 'p2b']), certifiedOnly: true }));
    assert.deepEqual(r.route.map((l) => l.exchangeId), ['binance']);
});

test('an empty route explains itself: all books stale', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    const b = book('binance', [[100, 10]]); b.receivedAt = Date.now() - 60_000;
    cache.setBook(b); fees.setFee('binance', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.deepEqual(r.route, []);
    assert.equal(r.unroutableReason, 'all_books_stale');
    assert.equal(r.freshVenueCount, 0);
    assert.equal(r.staleBookMs, 5000, 'threshold must be echoed so bookAgeMs is interpretable');
});

test('an empty route explains itself: filter matched nothing', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('binance', [[100, 10]]));
    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ exchanges: new Set(['kraken']) }));
    assert.equal(r.unroutableReason, 'no_venues_matched_filter');
});

test('a widened staleness window recovers an otherwise-empty route', () => {
    // The escape hatch for callers who would rather have an old price than none.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    const b = book('binance', [[100, 10]]); b.receivedAt = Date.now() - 30_000;
    cache.setBook(b); fees.setFee('binance', 'BTC/USDT', 0);

    assert.equal(run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS()).route.length, 0);
    const loose = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ staleBookMs: 60_000 }));
    assert.equal(loose.route.length, 1);
    assert.equal(loose.unroutableReason, null);
    assert.equal(loose.staleBookMs, 60_000);
});

test('a successful route reports no unroutable reason', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('binance', [[100, 10]])); fees.setFee('binance', 'BTC/USDT', 0);
    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.equal(r.unroutableReason, null);
    assert.equal(r.freshVenueCount, 1);
});

test('a partial fill warns loudly that routeVwap prices only the filled size', () => {
    // The dangerous misread: request 10,000, fill 900, and quote routeVwap as if it were the
    // price for 10,000. fillRatio and warnings exist to make that impossible to miss.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 1]]));
    fees.setFee('a', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 10, OPTS());
    assert.equal(r.fullyFillable, false);
    assert.equal(r.filledAmount, 1);
    assert.equal(r.unfilledAmount, 9);
    assert.ok(Math.abs(r.fillRatio - 0.1) < 1e-9);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /partial_fill/);
    assert.match(r.warnings[0]!, /FILLED/);
});

test('requireFullFill refuses a partial rather than quoting one', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 1]]));
    fees.setFee('a', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 10, OPTS({ requireFullFill: true }));
    assert.deepEqual(r.route, []);
    assert.equal(r.filledAmount, 0);
    assert.equal(r.routeVwap, null, 'must not price a fill that will not happen');
    assert.equal(r.unroutableReason, 'insufficient_depth');
});

test('requireFullFill still returns a route when depth is sufficient', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 100]]));
    fees.setFee('a', 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 10, OPTS({ requireFullFill: true }));
    assert.equal(r.fullyFillable, true);
    assert.equal(r.filledAmount, 10);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.unroutableReason, null);
});

test('a full fill carries no warnings and a fill ratio of 1', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 100]]));
    fees.setFee('a', 'BTC/USDT', 0);
    const r = run(cache, fees, 'BTC/USDT', 'buy', 5, OPTS());
    assert.equal(r.fillRatio, 1);
    assert.deepEqual(r.warnings, []);
});

test('split_capped must not return an unfillable set when a fillable one exists', () => {
    // The top-N-by-volume heuristic picks venues by how much they carried in the UNCONSTRAINED
    // solve — which favours venues that were cheap at the top, not venues that are deep. With
    // N=2 that can select two thin venues and miss a fillable pair entirely. This is a
    // correctness failure, not an approximation-quality one.
    // Unconstrained fill of 10: thin1 takes 4, thin2 takes 4, deep takes the remaining 2.
    // Top-2 BY VOLUME is therefore {thin1, thin2} = 8 units — cannot fill 10. Yet {thin1, deep}
    // fills it easily. The heuristic selects on the wrong quantity.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('cheapThin1', [[100, 4]]));
    cache.setBook(book('cheapThin2', [[100.1, 4]]));
    cache.setBook(book('deepPricey', [[200, 1000]]));
    for (const ex of ['cheapThin1', 'cheapThin2', 'deepPricey']) fees.setFee(ex, 'BTC/USDT', 0);

    const r = run(cache, fees, 'BTC/USDT', 'buy', 10, OPTS({ strategy: 'split_capped', maxVenues: 2 }));
    assert.equal(r.fullyFillable, true,
        `a 2-venue route exists (deep + either thin) but got ${r.filledAmount} of 10 from ${r.route.map((l) => l.exchangeId)}`);
});

test('staleness penalty demotes an older book even when its raw price is better', () => {
    // A stale quote is not the same product as a live one — the price may no longer exist. With
    // no penalty the older, cheaper venue wins; with a penalty the fresh one should.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    const old = book('staleButCheap', [[100, 10]]); old.receivedAt = Date.now() - 4000;
    cache.setBook(old);
    cache.setBook(book('freshDearer', [[100.5, 10]]));
    fees.setFee('staleButCheap', 'BTC/USDT', 0); fees.setFee('freshDearer', 'BTC/USDT', 0);

    assert.equal(run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS()).route[0]!.exchangeId,
        'staleButCheap', 'unpenalised, the cheaper stale book wins');
    assert.equal(
        run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS({ stalenessPenaltyBps: 50 })).route[0]!.exchangeId,
        'freshDearer', 'penalised, freshness outweighs a 50bp-equivalent price edge');
});

test('staleness penalty grows with the square root of age', () => {
    assert.equal(stalenessPenaltyFraction(0, 100), 0);
    assert.equal(stalenessPenaltyFraction(5000, 0), 0, 'zero bps disables it');
    const oneSec = stalenessPenaltyFraction(1000, 100);
    const fourSec = stalenessPenaltyFraction(4000, 100);
    assert.ok(Math.abs(fourSec / oneSec - 2) < 1e-9, '4x the age should double the penalty, not quadruple it');
});

test('zero-amount legs are not emitted', () => {
    // Float accumulation can leave a venue with an effectively-zero share; surfacing that as a
    // leg would be an unplaceable order.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', [[100, 1]]));
    cache.setBook(book('b', [[101, 1]]));
    fees.setFee('a', 'BTC/USDT', 0); fees.setFee('b', 'BTC/USDT', 0);
    const r = run(cache, fees, 'BTC/USDT', 'buy', 1, OPTS());
    assert.ok(r.route.every((l) => l.amount > 0), `got a zero leg: ${JSON.stringify(r.route)}`);
});
