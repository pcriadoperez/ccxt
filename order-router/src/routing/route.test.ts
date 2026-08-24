import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { computeRoute, stalenessPenaltyFraction, type RouteOptions } from './route.js';
import { parseBalancesParam, type BalanceBook } from './balances.js';
import type { CachedOrderBook } from '../types.js';

function book (exchangeId: string, asks: [number, number][], bids: [number, number][] = [[1, 1]]): CachedOrderBook {
    return {
        exchangeId, symbol: 'BTC/USDT',
        asks: asks.map(([price, amount]) => ({ price, amount })),
        bids: bids.map(([price, amount]) => ({ price, amount })),
        exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
    };
}
// The book() above is pinned to BTC/USDT. The balance cases need several markets at once, because
// what they are proving is that a wallet changes which MARKET wins, not just which venue does.
function pairBook (
    exchangeId: string, symbol: string, bids: [number, number][], asks: [number, number][],
): CachedOrderBook {
    return {
        exchangeId, symbol,
        bids: bids.map(([price, amount]) => ({ price, amount })),
        asks: asks.map(([price, amount]) => ({ price, amount })),
        exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
    };
}
const DEEP = 1_000_000;
function balances (raw: string): BalanceBook {
    const parsed = parseBalancesParam(raw);
    assert.ok(parsed.ok, `fixture "${raw}" must parse`);
    return parsed.book;
}

const OPTS = (o: Partial<RouteOptions> = {}): RouteOptions => ({
    strategy: 'split_optimal', includeFees: true, maxVenues: 3,
    minLegNotional: 0, staleBookMs: 5000, requestId: 'test-req', certifiedOnly: false, requireFullFill: false, stalenessPenaltyBps: 0, hopPenaltyBps: 0, includeQuotes: true, balances: null, balanceMode: 'cap', ...o,
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

// A balance clamp changes WHICH PATH WINS, not just how big the winner is. That only holds because
// the clamp is applied inside the path solver, before comparePaths ranks — the two tests below are
// the ones that fail if it ever moves to the answer.
function thinDirectDeepBridge () {
    const cache = new OrderBookCache();
    cache.setBook(pairBook('a', 'SOL/BTC', [[0.002, 4]], [[0.002, 4]]));        // great rate, 4 SOL deep
    cache.setBook(pairBook('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));     // 10 SOL -> 1000 USDT
    cache.setBook(pairBook('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]])); // -> 0.01 BTC
    return cache;
}

test('a balance clamp makes a thin market fully fillable, and it then WINS comparePaths', () => {
    const cache = thinDirectDeepBridge(); const fees = new FeeRegistry();
    const req = { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] };

    // Unclamped, the direct market cannot absorb 10 SOL, so the deep bridge wins on fillability.
    const wide = computeRoute(cache, fees, req, OPTS({ includeFees: false }));
    assert.equal(wide.hops.length, 2, `expected the bridge, got ${wide.hops.map((h) => h.pair).join(' -> ')}`);
    assert.ok(Math.abs(wide.amountOut - 0.01) < 1e-12);

    // Holding only 4 SOL, the direct market fills completely — and at a better rate. A clamp
    // applied to the finished answer could only have shrunk the bridge; it could never have
    // reached back and changed the ranking.
    const held = computeRoute(cache, fees, req, OPTS({ includeFees: false, balances: balances('SOL:4') }));
    assert.equal(held.hops.length, 1, `expected the direct market, got ${held.hops.map((h) => h.pair).join(' -> ')}`);
    assert.equal(held.hops[0]!.pair, 'SOL/BTC');
    assert.ok(Math.abs(held.amountOut - 0.008) < 1e-12, `expected 0.008 BTC, got ${held.amountOut}`);
    assert.ok(held.amountOut > wide.amountOut * 0.5);
    // The winning candidate filled its clamped size, but the REQUEST did not go through.
    assert.equal(held.hops[0]!.fullyFillable, true);
    assert.equal(held.fullyFillable, false);
});

test('a fundable bridge beats an unfundable direct market', () => {
    // The mirror of the dead-direct-market incident: the direct pair is priced better and would win
    // on rate, but the caller has no money on the venue that quotes it.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('kraken', 'SOL/BTC', [[0.002, DEEP]], [[0.002, DEEP]]));
    cache.setBook(pairBook('binance', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(pairBook('binance', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]]));
    const req = { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] };

    const wide = computeRoute(cache, fees, req, OPTS({ includeFees: false }));
    assert.equal(wide.hops[0]!.pair, 'SOL/BTC', 'unconstrained, the direct market is genuinely better');

    const held = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('binance.SOL:10') }));
    assert.equal(held.hops.length, 2, 'SOL on binance cannot be sold on kraken');
    assert.ok(Math.abs(held.amountOut - 0.01) < 1e-12);
    const direct = held.pathsConsidered.find((p) => p.bridge === null);
    assert.ok(direct, 'the direct market must still be reported as considered');
    assert.equal(direct!.amountOut, 0, 'an unfundable path produces nothing, rather than being hidden');
});

test('a per-venue balance changes the SPLIT, not merely the size', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[100, 10]], [[100, 10]]));
    cache.setBook(pairBook('b', 'BTC/USDT', [[101, 10]], [[101, 10]]));
    const req = { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] };

    // Unconstrained, venue a is cheaper and deep enough to take the whole order alone.
    const wide = computeRoute(cache, fees, req, OPTS({ includeFees: false }));
    assert.equal(wide.hops[0]!.legs.length, 1);
    assert.ok(Math.abs(wide.hops[0]!.legs[0]!.amount - 10) < 1e-12);

    // Split the same 1000 USDT across the two wallets and the order has to follow the money, even
    // though the books did not move.
    const held = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('a.USDT:400,b.USDT:600') }));
    const legs = new Map(held.hops[0]!.legs.map((l) => [l.exchangeId, l]));
    assert.equal(legs.size, 2, 'the cheap venue alone can no longer be funded');
    assert.ok(Math.abs(legs.get('a')!.amount - 4) < 1e-12, `a took ${legs.get('a')!.amount}`);
    assert.ok(Math.abs(legs.get('b')!.amount - 600 / 101) < 1e-12);
    assert.ok(Math.abs(held.amountIn - 1000) < 1e-9, 'the whole ask is still spendable, just not all in one place');
    // Size-capped, not depth-capped: a had 6 more BTC on offer and the caller could not pay for it.
    assert.equal(legs.get('a')!.balanceLimited, true);
    assert.equal(legs.get('b')!.balanceLimited, false);

    // A venue the caller holds nothing on is neither filtered out nor stale, so it needs its own
    // counter — folding it into either of the other two would make that one lie.
    const oneVenue = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('a.USDT:400') }));
    assert.equal(oneVenue.hops[0]!.venueCount, 2);
    assert.equal(oneVenue.hops[0]!.freshVenueCount, 2);
    assert.equal(oneVenue.hops[0]!.fundedVenueCount, 1);
    assert.equal(oneVenue.hops[0]!.legs.length, 1);
});

test('an unfundable route says insufficient_balance rather than blaming the market', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('kraken', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));
    const req = { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] };

    // `balances=` is "I hold nothing", which fills nothing anywhere. Without its own branch the
    // answer was all_books_stale — the market blamed for the caller's wallet.
    const nothing = computeRoute(cache, fees, req, OPTS({ balances: balances('') }));
    assert.equal(nothing.unroutableReason, 'insufficient_balance');
    assert.equal(nothing.balanceEntryCount, 0);
    assert.equal(nothing.balancesApplied, '');

    // Money in the right asset but on a venue that does not quote this pair is the same answer.
    const elsewhere = computeRoute(cache, fees, req, OPTS({ balances: balances('binance.USDT:5000') }));
    assert.equal(elsewhere.unroutableReason, 'insufficient_balance');

    // An unconstrained request can never reach that branch, so the older diagnostics still mean
    // exactly what they meant.
    const stale = new OrderBookCache();
    stale.setBook({ ...pairBook('kraken', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]), receivedAt: Date.now() - 60_000 });
    assert.equal(computeRoute(stale, fees, req, OPTS()).unroutableReason, 'all_books_stale');
    assert.equal(computeRoute(new OrderBookCache(), fees, req, OPTS()).unroutableReason, 'no_market');

    // A funded wallet against a book that is merely too thin is a DEPTH problem, and must not be
    // relabelled as a wallet problem.
    const thin = new OrderBookCache();
    thin.setBook(pairBook('kraken', 'BTC/USDT', [[100, 1]], [[100, 1]]));
    const depth = computeRoute(thin, fees, req,
        OPTS({ requireFullFill: true, balances: balances('kraken.USDT:5000') }));
    assert.equal(depth.unroutableReason, 'insufficient_depth');
});

test('balanceMode=require refuses the shortfall instead of clamping it', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));
    const req = { from: 'USDT', to: 'BTC', amountIn: 50_000, bridges: [] };

    const capped = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:40000') }));
    assert.equal(capped.unroutableReason, null, 'cap is the default polarity, matching requireFullFill being opt-in');

    const required = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:40000'), balanceMode: 'require' }));
    assert.equal(required.unroutableReason, 'insufficient_balance');
    assert.equal(required.amountIn, 0);
    assert.equal(required.balanceMode, 'require');
    // Enough money is not refused merely because require was asked for.
    const enough = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:50000'), balanceMode: 'require' }));
    assert.equal(enough.unroutableReason, null);
});

test('the clamp is reported separately, so fillRatio still measures the caller\'s ask', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 50_000, bridges: [] },
        OPTS({ includeFees: false, balances: balances('USDT:40000') }));
    // Asking for 50k while holding 40k is a 80% fill of the ask, NOT a full fill of 40k. Moving the
    // clamp into requestedAmount would have made fillRatio report 1 on a route that leaves 10k of
    // the caller's intent unmet.
    assert.equal(r.requestedAmount, 50_000);
    assert.ok(Math.abs(r.amountIn - 40_000) < 1e-9);
    assert.ok(Math.abs(r.fillRatio - 0.8) < 1e-12);
    assert.equal(r.fullyFillable, false);
    assert.ok(Math.abs(r.unfilledAmount - 10_000) < 1e-9);
    assert.equal(r.balanceCapAmountIn, 40_000);
    assert.equal(r.balancesApplied, 'USDT:40000');
    assert.equal(r.balanceEntryCount, 1);
    assert.ok(r.warnings.some((w) => w.startsWith('partial_fill')));

    // Absent balances must stay indistinguishable from today's behaviour.
    const wide = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 50_000, bridges: [] },
        OPTS({ includeFees: false }));
    assert.equal(wide.balancesApplied, null);
    assert.equal(wide.balanceCapAmountIn, null);
    assert.equal(wide.balanceEntryCount, 0);
    assert.equal(wide.balanceMode, 'cap');
});

test('the dust re-solve never lowers the fill once venues are capacity-bound', () => {
    // The re-solve assumes the size freed by dropping a dust leg is absorbable elsewhere. With a
    // wallet in play the survivors can have the depth and not the funding, and then dropping the
    // leg SHRINKS the route.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[100, 9]], [[100, 9]]));
    cache.setBook(pairBook('b', 'BTC/USDT', [[110, 100]], [[110, 100]]));

    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] },
        OPTS({ includeFees: false, minLegNotional: 100, balances: balances('a.USDT:900,b.USDT:50') }));
    // a is exhausted at 900 and b can only fund 50 more, so the 50 leg is dust that nothing else
    // can take over. Suppressing it would spend 900 instead of 950 — a worse route sold as tidier.
    assert.ok(Math.abs(r.amountIn - 950) < 1e-9, `spent ${r.amountIn}, expected the dust leg kept`);
    assert.equal(r.hops[0]!.legs.length, 2);
});

test('candidate paths each see the whole wallet: no budget leaks between them', () => {
    // The solve memo is shared across every candidate AND the winner's re-solve. Candidates are
    // ALTERNATIVE plans for the same money, so a budget shared between them silently starves
    // whichever runs last — and the winner's re-solve runs last of all, which would zero the answer.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'SOL/BTC', [[0.002, DEEP]], [[0.002, DEEP]]));
    cache.setBook(pairBook('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(pairBook('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]]));
    const req = { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] };

    for (const strategy of ['split_optimal', 'best_single'] as const) {
        const r = computeRoute(cache, fees, req,
            OPTS({ strategy, includeFees: false, balances: balances('a.SOL:10') }));
        assert.ok(Math.abs(r.amountIn - 10) < 1e-12, `${strategy} spent ${r.amountIn} of 10 SOL`);
        assert.ok(Math.abs(r.amountOut - 0.02) < 1e-12, `${strategy} produced ${r.amountOut}`);
        const bridged = r.pathsConsidered.find((p) => p.bridge === 'USDT');
        assert.ok(bridged, 'the bridge must still be a considered candidate');
        assert.ok(Math.abs(bridged!.amountOut - 0.01) < 1e-12,
            `the bridge was solved against a drained wallet: ${bridged!.amountOut}`);
    }
});

// The fixture above is DELIBERATELY not the whole proof. Both of its candidates are capped to the
// same 4 SOL by the per-venue budget alone, so the direct market wins on raw output either way and
// the fillability criterion is never the thing that decides. Moving the clamp after the ranking
// left all 278 tests green. The one below makes the two designs disagree on the ANSWER.
test('the clamp precedes the ranking: a fully fillable path beats a bigger partial one', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    // Direct: a great rate but only 5 SOL deep. Bridge: a worse rate and only 3 SOL deep, yet it
    // out-produces the direct market at any size either can absorb.
    cache.setBook(pairBook('a', 'SOL/BTC', [[0.002, 5]], [[0.002, 5]]));
    cache.setBook(pairBook('a', 'SOL/USDT', [[100, 3]], [[100, 3]]));
    cache.setBook(pairBook('a', 'BTC/USDT', [[10_000, DEEP]], [[10_000, DEEP]]));
    const req = { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] };

    const held = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('SOL:4') }));
    // Clamped to 4 SOL the direct market fills COMPLETELY, and criterion 1 of comparePaths puts a
    // fully fillable path ahead of a partial one whatever the partial one produces. Rank the
    // candidates at the unclamped 10 SOL instead — and re-clamp the winner afterwards — and
    // neither is fully fillable, score decides, and the bridge wins with 0.03. That is a different
    // recommended route, which is what makes this fixture the proof and the one above merely a
    // demonstration.
    assert.equal(held.hops.length, 1, `expected the direct market, got ${held.hops.map((h) => h.pair).join(' -> ')}`);
    assert.equal(held.hops[0]!.pair, 'SOL/BTC');
    assert.ok(Math.abs(held.amountOut - 0.008) < 1e-12, `expected 0.008 BTC, got ${held.amountOut}`);
    const bridge = held.pathsConsidered.find((p) => p.bridge === 'USDT');
    assert.ok(bridge, 'the bridge must still be reported as considered');
    assert.equal(bridge!.chosen, false);
    assert.ok(bridge!.amountOut > held.amountOut,
        'the fixture only discriminates while the losing bridge OUT-PRODUCES the winner');
});

test('balanceMode=require refuses a shortfall caused by WHERE the money sits', () => {
    // The whole-wallet total says 1200 against an ask of 1000 and passes. Only kraken quotes the
    // pair, so only kraken's 600 is spendable — a 60% plan handed to a caller whose entire reason
    // for sending balanceMode=require was to never receive one.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('kraken', 'BTC/USDT', [[101, 50]], [[101, 50]]));
    const req = { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] };

    const capped = computeRoute(cache, fees, req, OPTS({
        includeFees: false, balances: balances('binance.USDT:600,kraken.USDT:600') }));
    assert.equal(capped.unroutableReason, null, 'cap still clamps — this is only about require');
    assert.ok(Math.abs(capped.amountIn - 600) < 1e-9);

    const required = computeRoute(cache, fees, req, OPTS({
        includeFees: false, balances: balances('binance.USDT:600,kraken.USDT:600'), balanceMode: 'require' }));
    assert.equal(required.unroutableReason, 'insufficient_balance');
    assert.equal(required.amountIn, 0);
    assert.equal(required.amountOut, 0);
    assert.equal(required.balanceMode, 'require');

    // The same shape via the exchanges filter: the money is real and in the right asset, and the
    // route still cannot reach it.
    const filtered = computeRoute(cache, fees, req, OPTS({
        includeFees: false, exchanges: new Set(['kraken']), balanceMode: 'require',
        balances: balances('binance.USDT:600,kraken.USDT:600') }));
    assert.equal(filtered.unroutableReason, 'insufficient_balance');

    // Enough money in the one place it can be spent is still not refused.
    const enough = computeRoute(cache, fees, req, OPTS({
        includeFees: false, balances: balances('kraken.USDT:1000'), balanceMode: 'require' }));
    assert.equal(enough.unroutableReason, null);
    assert.ok(Math.abs(enough.amountIn - 1000) < 1e-9);
});

test('balanceMode=require applies on the exact-out side too', () => {
    // The input an exact-out route needs is not known until the book is walked, so the pre-solve
    // whole-wallet check cannot run — which used to mean require was a documented no-op here and
    // the caller got a half-size plan under an all-or-nothing mode.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[2000, 10]], [[2000, 10]]));
    const req = { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] };

    const capped = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:1000') }));
    assert.ok(Math.abs(capped.amountOut - 0.5) < 1e-12, 'cap still routes the fundable half');

    const required = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:1000'), balanceMode: 'require' }));
    assert.equal(required.unroutableReason, 'insufficient_balance');
    assert.equal(required.amountOut, 0);

    const enough = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:2000'), balanceMode: 'require' }));
    assert.equal(enough.unroutableReason, null);
    assert.ok(Math.abs(enough.amountOut - 1) < 1e-12);

    // A book too thin for the ask is a DEPTH problem, and require must not relabel it — that would
    // send the caller off to move money that was never the constraint. requireFullFill is the flag
    // for refusing a market that cannot deliver.
    const thin = new OrderBookCache();
    thin.setBook(pairBook('a', 'BTC/USDT', [[2000, 0.25]], [[2000, 0.25]]));
    const depth = computeRoute(thin, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:5000'), balanceMode: 'require' }));
    assert.equal(depth.unroutableReason, null);
    assert.ok(Math.abs(depth.amountOut - 0.25) < 1e-12);
});

test('requireFullFill refuses a shortfall the WALLET caused, not just one the book caused', () => {
    // The clamp rewrites the hop target, so the hop fills its reduced 40k exactly and reports
    // itself full — and the opt-in "refuse rather than shrink" flag went inert precisely when the
    // shrinking came from the caller's own wallet.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[10, 100_000]], [[10, 100_000]]));
    const req = { from: 'USDT', to: 'BTC', amountIn: 50_000, bridges: [] };

    const wallet = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, requireFullFill: true, balances: balances('USDT:40000') }));
    assert.equal(wallet.unroutableReason, 'insufficient_balance');
    assert.equal(wallet.amountIn, 0);

    // The identical 80% shortfall caused by depth already refused, and must keep refusing with the
    // reason that names the market rather than the wallet.
    const thin = new OrderBookCache();
    thin.setBook(pairBook('a', 'BTC/USDT', [[10, 4000]], [[10, 4000]]));
    const book = computeRoute(thin, fees, req, OPTS({ includeFees: false, requireFullFill: true }));
    assert.equal(book.unroutableReason, 'insufficient_depth');
    assert.equal(book.amountIn, 0);

    // Without the flag the clamp is still a clamp: the default is cap, and this is the case the
    // whole feature exists to serve.
    const capped = computeRoute(cache, fees, req,
        OPTS({ includeFees: false, balances: balances('USDT:40000') }));
    assert.equal(capped.unroutableReason, null);
    assert.ok(Math.abs(capped.amountIn - 40_000) < 1e-9);
});

test('best_single follows the money once every venue is capacity-bound', () => {
    // best_single is the DEFAULT strategy. Its tie-break — a venue that fills the whole size beats
    // one that does not — silently stopped deciding anything once budgets made every venue
    // partial, and the choice fell through to price: the cheap venue holding 10 USDT beat the one
    // holding 900, and the router recommended spending 1% of the wallet.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[9, 1000]], [[9, 1000]]));
    cache.setBook(pairBook('b', 'BTC/USDT', [[10, 1000]], [[10, 1000]]));
    const req = { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] };

    const poorOnTheCheapVenue = computeRoute(cache, fees, req, OPTS({
        strategy: 'best_single', includeFees: false, balances: balances('a.USDT:10,b.USDT:900') }));
    assert.deepEqual(poorOnTheCheapVenue.hops[0]!.legs.map((l) => l.exchangeId), ['b']);
    assert.ok(Math.abs(poorOnTheCheapVenue.amountIn - 900) < 1e-9,
        `spent ${poorOnTheCheapVenue.amountIn} of a fundable 900`);

    // The mirror was always right, which is what made the error silent and input-dependent.
    const mirror = computeRoute(cache, fees, req, OPTS({
        strategy: 'best_single', includeFees: false, balances: balances('a.USDT:900,b.USDT:10') }));
    assert.deepEqual(mirror.hops[0]!.legs.map((l) => l.exchangeId), ['a']);
    assert.ok(Math.abs(mirror.amountIn - 900) < 1e-9);

    // Unconstrained, size does NOT outrank price: with no wallet in play two venues that both fall
    // short are still settled on the better rate, exactly as before.
    const thin = new OrderBookCache();
    thin.setBook(pairBook('cheap', 'BTC/USDT', [[9, 1]], [[9, 1]]));
    thin.setBook(pairBook('deep', 'BTC/USDT', [[10, 50]], [[10, 50]]));
    const wide = computeRoute(thin, fees, req, OPTS({ strategy: 'best_single', includeFees: false }));
    assert.deepEqual(wide.hops[0]!.legs.map((l) => l.exchangeId), ['cheap']);
});

test('minLegNotional stays a hard floor on a request that sends no balances', () => {
    // The dust re-solve keeps the pre-suppression allocation when dropping a leg would shrink the
    // route. That is only true of a wallet-bound survivor — applied unconditionally it also fires
    // when the survivor merely lacks DEPTH, and the floor the caller set because their venues
    // reject smaller orders quietly became a suggestion.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(pairBook('a', 'BTC/USDT', [[10, 1]], [[10, 1]]));                  // 10 USDT deep
    cache.setBook(pairBook('b', 'BTC/USDT', [[10.5, 8.5714286]], [[10.5, 8.5714286]])); // 90 USDT deep
    const exactIn = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] },
        OPTS({ includeFees: false, minLegNotional: 50 }));
    assert.deepEqual(exactIn.hops[0]!.legs.map((l) => l.exchangeId), ['b']);
    for (const leg of exactIn.hops[0]!.legs) {
        assert.ok(leg.amount * leg.averagePrice >= 50, `leg ${leg.exchangeId} is below the floor it set`);
    }

    // Exact-out reaches it too, and there it also reported the sub-floor route as a FULL fill —
    // promising 2 BTC that becomes 1.999 the moment the venue bounces the 0.099 leg.
    const outCache = new OrderBookCache();
    outCache.setBook(pairBook('dust', 'BTC/USDT', [[99, 0.001]], [[99, 0.001]]));
    outCache.setBook(pairBook('real', 'BTC/USDT', [[100, 1.9995]], [[100, 1.9995]]));
    const exactOut = computeRoute(outCache, fees, { from: 'USDT', to: 'BTC', amountOut: 2, bridges: [] },
        OPTS({ includeFees: false, minLegNotional: 50 }));
    assert.deepEqual(exactOut.hops[0]!.legs.map((l) => l.exchangeId), ['real']);
    assert.ok(Math.abs(exactOut.amountOut - 1.9995) < 1e-12);
    assert.equal(exactOut.fullyFillable, false, 'a route short of the ask must not report a full fill');
});

test('fundedVenueCount counts only venues the wallet could actually have funded', () => {
    const fees = new FeeRegistry();
    const req = { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] };

    // The money is on the venue whose book is too old to price. The only venue that CAN be priced
    // is unfunded — a wallet problem the router reported as no_liquidity, because a stale venue
    // counted as funded.
    const staleSide = new OrderBookCache();
    const old = pairBook('binance', 'BTC/USDT', [[10, 1000]], [[10, 1000]]);
    old.receivedAt = Date.now() - 60_000;
    staleSide.setBook(old);
    staleSide.setBook(pairBook('kraken', 'BTC/USDT', [[10, 1000]], [[10, 1000]]));
    const stale = computeRoute(staleSide, fees, req,
        OPTS({ includeFees: false, balances: balances('binance.USDT:1000') }));
    assert.equal(stale.unroutableReason, 'insufficient_balance');
    assert.equal(stale.hops[0]!.venueCount, 2);
    assert.equal(stale.hops[0]!.freshVenueCount, 1);
    assert.equal(stale.hops[0]!.fundedVenueCount, 0);

    // Same shape with no staleness at all: the funded venue quotes only the other side of the
    // market, so it has no depth to sell into this hop.
    const wrongSide = new OrderBookCache();
    wrongSide.setBook(pairBook('binance', 'BTC/USDT', [[10, 1000]], []));
    wrongSide.setBook(pairBook('kraken', 'BTC/USDT', [[10, 1000]], [[10, 1000]]));
    const oneSided = computeRoute(wrongSide, fees, req,
        OPTS({ includeFees: false, balances: balances('binance.USDT:1000') }));
    assert.equal(oneSided.unroutableReason, 'insufficient_balance');
    assert.equal(oneSided.hops[0]!.fundedVenueCount, 0);

    // The counter is gated on balances being SENT, so an unconstrained request whose books are all
    // stale still says so rather than reporting a wallet nobody described.
    const unconstrained = computeRoute(staleSide, fees, req, OPTS({ includeFees: false, exchanges: new Set(['binance']) }));
    assert.equal(unconstrained.unroutableReason, 'all_books_stale');
});

test('balanceLimited is set even when the budget runs out exactly on a level boundary', () => {
    // The flag was only ever set while something was still being taken, so a budget that lands
    // exactly on a level edge left the executor reading "depth-capped" on a leg that was purely
    // wallet-capped — and the two need different follow-up.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    // a's 10 USDT buys its 10-priced level exactly, to the unit, and nothing of the 11-priced one
    // sitting behind it — which b then has to cover at a worse price.
    cache.setBook(pairBook('a', 'BTC/USDT', [[10, 1], [11, 100]], [[10, 1], [11, 100]]));
    cache.setBook(pairBook('b', 'BTC/USDT', [[12, 1000]], [[12, 1000]]));
    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 1000, bridges: [] },
        OPTS({ includeFees: false, balances: balances('a.USDT:10,b.USDT:1000') }));
    assert.ok(Math.abs(r.amountIn - 1000) < 1e-9, `spent ${r.amountIn}`);
    const legs = new Map(r.hops[0]!.legs.map((l) => [l.exchangeId, l]));
    assert.equal(legs.get('a')!.balanceLimited, true, 'a still had 100 units on offer at 11 and no money left');
    assert.equal(legs.get('b')!.balanceLimited, false, 'b was never short of funding');
});
