import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { computeRoute, pathScore, comparePaths, type RouteOptions } from './route.js';
import { DEFAULT_BRIDGES } from './market.js';
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
    strategy: 'split_optimal', includeFees: false, maxVenues: 3, minLegNotional: 0,
    staleBookMs: 5000, requestId: 'test', certifiedOnly: false, requireFullFill: false,
    stalenessPenaltyBps: 0, hopPenaltyBps: 0, ...o,
});
const DEEP = 1_000_000;

test('the cheaper bridge wins, not the first one listed', () => {
    // USDT is tried first because it is usually deepest — but "usually" is not "always", and
    // committing to the first bridge that happened to have both legs left real money on the table.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));   // 100 USDT -> 1 BTC
    cache.setBook(book('a', 'SOL/USDC', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDC', [[50, DEEP]], [[50, DEEP]]));     // 100 USDC -> 2 BTC

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: DEFAULT_BRIDGES }, OPTS());
    assert.equal(r.hops[1]!.pair, 'BTC/USDC', `routed via ${r.hops.map((h) => h.pair).join(' -> ')}`);
    assert.ok(Math.abs(r.amountOut - 2) < 1e-9, `expected 2 BTC via USDC, got ${r.amountOut}`);
});

test('a thin direct market loses to a deep bridged route', () => {
    // The case that makes path comparison worth its cost: a direct pair exists, so the old
    // first-match-wins logic would have taken it, but it is priced far worse than going around.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [[0.0005, DEEP]], [[0.0005, DEEP]]));  // direct: 10 SOL -> 0.005 BTC
    cache.setBook(book('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));       // 10 SOL -> 1000 USDT
    cache.setBook(book('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]])); // 1000 USDT -> 0.01 BTC

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: DEFAULT_BRIDGES },
        OPTS({ hopPenaltyBps: 5 }));
    assert.equal(r.hops.length, 2, 'the bridge is worth two hops here');
    assert.ok(Math.abs(r.amountOut - 0.01) < 1e-9, `expected 0.01 BTC bridged, got ${r.amountOut}`);
    const direct = r.pathsConsidered.find((p) => p.bridge === null);
    assert.ok(direct, 'the direct market must still be reported as considered');
    assert.equal(direct!.chosen, false);
    assert.ok(Math.abs(direct!.amountOut - 0.005) < 1e-9);
});

test('a direct market wins when it is genuinely better', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [[0.002, DEEP]], [[0.002, DEEP]]));   // direct: 10 SOL -> 0.02 BTC
    cache.setBook(book('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]])); // bridged: 0.01 BTC

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: DEFAULT_BRIDGES }, OPTS());
    assert.equal(r.hops.length, 1);
    assert.equal(r.hops[0]!.pair, 'SOL/BTC');
    assert.ok(Math.abs(r.amountOut - 0.02) < 1e-9);
});

// A bridge that wins by a hair is not actually the better trade: the second order is a second
// chance for the price to move between fills, and that risk is not in the order book.
function marginalBridgeCache () {
    const cache = new OrderBookCache();
    cache.setBook(book('a', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));      // direct: 100 USDT -> 1 BTC
    cache.setBook(book('a', 'USDC/USDT', [[1, DEEP]], [[1, DEEP]]));         // 100 USDT -> 100 USDC
    cache.setBook(book('a', 'BTC/USDC', [[99.98, DEEP]], [[99.98, DEEP]]));  // 100 USDC -> 1.0002 BTC
    return cache;
}

test('the hop penalty blocks a bridge that only wins by a hair', () => {
    const r = computeRoute(marginalBridgeCache(), new FeeRegistry(),
        { from: 'USDT', to: 'BTC', amountIn: 100, bridges: DEFAULT_BRIDGES }, OPTS({ hopPenaltyBps: 5 }));
    assert.equal(r.hops.length, 1, 'a 2bp edge does not justify a second order at a 5bp penalty');
    const bridged = r.pathsConsidered.find((p) => p.bridge === 'USDC')!;
    assert.ok(bridged.amountOut > r.amountOut, 'the bridge really did produce more, on raw output');
    assert.ok(bridged.score < r.pathsConsidered.find((p) => p.bridge === null)!.score,
        'but it loses once the extra hop is priced');
});

test('a zero hop penalty compares purely on rate', () => {
    const r = computeRoute(marginalBridgeCache(), new FeeRegistry(),
        { from: 'USDT', to: 'BTC', amountIn: 100, bridges: DEFAULT_BRIDGES }, OPTS({ hopPenaltyBps: 0 }));
    assert.equal(r.hops.length, 2, 'with the penalty off, any edge at all wins');
    assert.ok(r.amountOut > 1);
});

test('the hop penalty is charged per EXTRA hop, never to a direct market', () => {
    assert.equal(pathScore(100, 1, 5), 100, 'a direct market is not penalised');
    assert.equal(pathScore(100, 2, 5), 100 * (1 - 0.0005));
    assert.equal(pathScore(100, 3, 5), 100 * (1 - 0.0010), 'two extra hops cost twice');
    assert.equal(pathScore(100, 2, 0), 100, 'zero disables it');
});

test('a fully-fillable path beats a better-priced partial one', () => {
    // Rate is meaningless on size you cannot actually get. Same rule the venue ranking uses.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [[0.05, 1]], [[0.05, 1]]));            // great rate, only 1 SOL deep
    cache.setBook(book('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]])); // worse rate, unlimited

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: DEFAULT_BRIDGES }, OPTS());
    assert.equal(r.fullyFillable, true);
    assert.equal(r.hops.length, 2, 'the thin direct market cannot take 10 SOL, however good its price');
    const direct = r.pathsConsidered.find((p) => p.bridge === null)!;
    assert.equal(direct.fullyFillable, false);
    assert.ok(direct.amountOut > r.amountOut, 'and it did score better on raw output — which is the trap');
});

test('pathsConsidered names every candidate and flags exactly one winner', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [[0.001, DEEP]], [[0.001, DEEP]]));
    cache.setBook(book('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]]));
    cache.setBook(book('a', 'SOL/USDC', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(book('a', 'BTC/USDC', [[100_000, DEEP]], [[100_000, DEEP]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: DEFAULT_BRIDGES }, OPTS());
    assert.deepEqual(r.pathsConsidered.map((p) => p.bridge), [null, 'USDT', 'USDC']);
    assert.equal(r.pathsConsidered.filter((p) => p.chosen).length, 1);
    const chosen = r.pathsConsidered.find((p) => p.chosen)!;
    assert.deepEqual(chosen.pairs, r.hops.map((h) => h.pair), 'the flagged winner must be the route returned');
});

test('a single candidate reports no alternatives rather than an empty comparison', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));
    const r = computeRoute(cache, fees, { from: 'USDT', to: 'BTC', amountIn: 100, bridges: DEFAULT_BRIDGES }, OPTS());
    assert.deepEqual(r.pathsConsidered, [], 'there was nothing to choose between');
    assert.equal(r.hops.length, 1);
});

test('an empty bridges list forces direct-only, even when a better bridge exists', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [[0.0001, DEEP]], [[0.0001, DEEP]]));
    cache.setBook(book('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: [] }, OPTS());
    assert.equal(r.hops.length, 1);
    assert.equal(r.hops[0]!.pair, 'SOL/BTC');
});

test('the winning path keeps full diagnostics, and losing paths report no venue detail', () => {
    // Candidate comparison solves every path without per-venue quotes, then re-solves only the
    // winner with them. What is externally observable is the asymmetry: the returned hops carry
    // complete quotes, while pathsConsidered carries only outcomes.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [[0.0001, DEEP]], [[0.0001, DEEP]]));
    cache.setBook(book('a', 'SOL/USDT', [[100, DEEP]], [[100, DEEP]]));
    cache.setBook(book('b', 'SOL/USDT', [[99, DEEP]], [[99, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100_000, DEEP]], [[100_000, DEEP]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: DEFAULT_BRIDGES }, OPTS());
    // The WINNING path must still carry full diagnostics — it is re-solved after the comparison.
    assert.equal(r.hops[0]!.quotes.length, 2, 'both venues on the winning first leg must be reported');
    assert.equal(r.hops[0]!.freshVenueCount, 2);
    assert.ok(r.pathsConsidered.length > 1);
    for (const p of r.pathsConsidered) {
        assert.deepEqual(Object.keys(p).sort(),
            ['amountOut', 'bridge', 'chosen', 'fullyFillable', 'pairs', 'score'],
            'a considered path reports outcomes only — no per-venue payload for a path nobody took');
    }
});

test('an extreme hop penalty still picks the best bridge, not the first-listed one', () => {
    // pathScore clamps at 0, so once hopPenaltyBps saturates, EVERY multi-hop candidate scores
    // exactly 0 and score alone can no longer order them. Ranking then fell through to a stable
    // sort and returned whichever path candidatePaths happened to emit first — the first bridge in
    // the list, regardless of output. The caller asked to prefer direct, and silently got a worse
    // bridge instead.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[100, DEEP]], [[100, DEEP]]));   // -> 1 BTC
    cache.setBook(book('a', 'SOL/USDC', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDC', [[50, DEEP]], [[50, DEEP]]));     // -> 2 BTC, and listed second

    for (const hopPenaltyBps of [0, 5, 9999, 10_000]) {
        const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT', 'USDC'] },
            OPTS({ hopPenaltyBps }));
        assert.ok(Math.abs(r.amountOut - 2) < 1e-9,
            `at ${hopPenaltyBps} bps got ${r.amountOut} via ${r.hops.map((h) => h.pair).join('>')}`);
    }
});

test('a dead direct market never beats a live bridged one', () => {
    // A direct market that produces nothing scores 0. So does every bridge once the penalty
    // saturates — and the direct one is emitted first. Ranking on score alone therefore returned
    // the DEAD path and reported the whole request unroutable, while pathsConsidered sat there
    // listing a working alternative.
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/BTC', [], []));                          // listed, but empty
    cache.setBook(book('a', 'SOL/USDT', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[99, DEEP]], [[100, 0.4]]));

    for (const hopPenaltyBps of [5, 10_000]) {
        const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] },
            OPTS({ hopPenaltyBps }));
        assert.equal(r.unroutableReason, null, `unroutable at ${hopPenaltyBps} bps despite a live bridge`);
        assert.ok(r.amountOut > 0, `got nothing at ${hopPenaltyBps} bps`);
    }
});

test('comparePaths orders on every criterion, not just score', () => {
    const p = (o: Partial<{ fullyFillable: boolean; amountOut: number; score: number; hopCount: number }>) =>
        ({ fullyFillable: false, amountOut: 1, score: 1, hopCount: 1, ...o });
    assert.ok(comparePaths(p({ fullyFillable: true, score: 0 }), p({ score: 999 })) < 0, 'fillable first');
    assert.ok(comparePaths(p({ amountOut: 1, score: 0 }), p({ amountOut: 0, score: 0 })) < 0, 'live beats dead');
    assert.ok(comparePaths(p({ score: 2 }), p({ score: 1 })) < 0, 'then higher score');
    assert.ok(comparePaths(p({ score: 0, hopCount: 1 }), p({ score: 0, hopCount: 2 })) < 0, 'then fewer hops');
    assert.ok(comparePaths(p({ score: 0, hopCount: 2, amountOut: 2 }), p({ score: 0, hopCount: 2, amountOut: 1 })) < 0,
        'then raw output, so clamped-to-zero scores still order');
});

test('an over-large early hop is trimmed back to what the next hop can actually absorb', () => {
    // Without this the router recommends selling 10 SOL to buy 0.01 BTC and stranding the other
    // 99 USDT in the bridge asset — a trade nobody wants — and then reports fillRatio 1 and
    // unfilledAmount 0, because only the pinned side was ever measured. The warning text read
    // "partial_fill: only 100.00%".
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[99, DEEP]], [[100, 0.01]]));    // absorbs ~1 USDT, no more

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] }, OPTS());
    assert.ok(Math.abs(r.amountIn - 0.1) < 1e-9, `should only sell the SOL that converts, sold ${r.amountIn}`);
    assert.ok(Math.abs(r.amountOut - 0.01) < 1e-9);
    assert.equal(r.fullyFillable, false);
    assert.ok(Math.abs(r.fillRatio - 0.01) < 1e-9, `fillRatio ${r.fillRatio} must reflect the real conversion`);
    assert.ok(Math.abs(r.unfilledAmount - 9.9) < 1e-9, `unfilled ${r.unfilledAmount}`);
    // The three fields must agree with each other and with the prose.
    assert.match(r.warnings[0]!, /only 1\.00%/);
    assert.ok(Math.abs(r.hops[0]!.amountOut - r.hops[1]!.amountIn) < 1e-9,
        'no capital may be left stranded between hops');
});

test('a route whose hops all fill is never marked trimmed', () => {
    const cache = new OrderBookCache(); const fees = new FeeRegistry();
    cache.setBook(book('a', 'SOL/USDT', [[10, DEEP]], [[10, DEEP]]));
    cache.setBook(book('a', 'BTC/USDT', [[99, DEEP]], [[100, DEEP]]));

    const r = computeRoute(cache, fees, { from: 'SOL', to: 'BTC', amountIn: 10, bridges: ['USDT'] }, OPTS());
    assert.equal(r.fullyFillable, true);
    assert.equal(r.fillRatio, 1);
    assert.equal(r.unfilledAmount, 0);
    assert.deepEqual(r.warnings.filter((w) => w.startsWith('partial_fill')), []);
});
