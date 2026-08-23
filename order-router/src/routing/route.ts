import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { candidatePaths, type CandidatePath, type ResolvedHop } from './market.js';
import { solveHop, createSolveCache, type SolveCache } from './engine.js';
import type { ConsideredPath, RouteHop, RouteOptions, RouteResult, UnroutableReason } from './types.js';

export * from './types.js';
export { stalenessPenaltyFraction, isVenueAllowed } from './engine.js';

export interface RouteRequest {
    from: string;
    to: string;
    // Exactly one is set. amountIn is denominated in `from`, amountOut in `to` — never ambiguous,
    // unlike a bare `amount` whose meaning depended on side.
    amountIn?: number;
    amountOut?: number;
    bridges: string[];
}

// Amount is in the hop's INPUT asset: base when selling it, quote when buying with it.
const inputIsBase = (hop: ResolvedHop): boolean => hop.side === 'sell';

interface SolvedPath {
    candidate: CandidatePath;
    hops: RouteHop[];
    bestSingleEffective: number | null;
    amountOut: number;
    fullyFillable: boolean;
    score: number;
    // Index of the hop that produced nothing, or null if the whole path filled something.
    deadHopIndex: number | null;
    // An earlier hop was cut back because a later one could not absorb its output.
    trimmed: boolean;
}

// Walks a path forward, each hop's realised output funding the next. Hops are solved
// sequentially, NOT jointly — hop 1's split is chosen without knowing what hop 2 would prefer, so
// the result is a good route rather than a provably optimal one. Joint optimisation is a min-cost
// flow over the asset graph and is deliberately out of scope here.
function solvePathExactIn (
    cache: OrderBookCache, fees: FeeRegistry, candidate: CandidatePath,
    amountIn: number, opts: RouteOptions, collectQuotes: boolean, memo: SolveCache,
): SolvedPath {
    const hops: RouteHop[] = [];
    let bestSingleEffective: number | null = null;
    let carry = amountIn;
    let deadHopIndex: number | null = null;
    for (let i = 0; i < candidate.hops.length; i++) {
        const h = candidate.hops[i]!;
        const sol = solveHop(cache, fees, h, carry, inputIsBase(h), opts, { collectQuotes }, memo);
        if (i === 0) bestSingleEffective = sol.bestSingleEffective;
        hops.push(sol.hop);
        carry = sol.hop.amountOut;
        if (carry <= 0) { deadHopIndex = i; break; }
    }
    // Backward trim. The forward pass can have an early hop consume everything it was offered while
    // a later hop absorbs only a fraction of it — which would recommend selling 10 SOL to buy 0.01
    // BTC and strand the other 99 USDT in the bridge asset. Nobody wants that trade. So walk back
    // and re-solve each earlier hop for exactly what the next one actually took.
    let trimmed = false;
    if (deadHopIndex === null && hops.length > 1) {
        for (let i = hops.length - 2; i >= 0; i--) {
            const needed = hops[i + 1]!.amountIn;
            const produced = hops[i]!.amountOut;
            if (produced <= needed * (1 + 1e-12)) continue;
            const h = candidate.hops[i]!;
            // Re-solve this hop against its OUTPUT rather than its input: base units when buying
            // the base, quote units when selling into it.
            const retrimmed = solveHop(cache, fees, h, needed, h.side === 'buy', opts, { collectQuotes }, memo);
            // Only accept a trim that actually delivers what the next hop needs; a hop whose book
            // cannot hit the reduced target exactly is left as it was rather than made worse.
            if (retrimmed.hop.amountOut >= needed * (1 - 1e-9)) {
                hops[i] = retrimmed.hop;
                if (i === 0) bestSingleEffective = retrimmed.bestSingleEffective;
                trimmed = true;
            }
        }
    }
    const amountOut = deadHopIndex === null ? hops[hops.length - 1]!.amountOut : 0;
    // A trimmed route did NOT convert everything it was asked to, even though every hop now fills
    // its own (reduced) target — so hop-level flags alone can no longer answer this.
    const fullyFillable = deadHopIndex === null && !trimmed && hops.every((h) => h.fullyFillable);
    return {
        candidate, hops, bestSingleEffective, amountOut, fullyFillable, deadHopIndex, trimmed,
        score: pathScore(amountOut, candidate.hops.length, opts.hopPenaltyBps),
    };
}

// A longer path must be better by more than the penalty to win. Charged per EXTRA hop, so a
// direct market is never penalised. Clamped at 0 because a negative score would be meaningless in
// the response — which means score ALONE cannot order paths at an extreme penalty, where every
// multi-hop candidate collapses to 0. comparePaths() carries the tie-breaks that keep ordering
// sane there; do not rank on score by itself.
export function pathScore (amountOut: number, hopCount: number, hopPenaltyBps: number): number {
    const extraHops = Math.max(0, hopCount - 1);
    if (extraHops === 0 || hopPenaltyBps <= 0) return amountOut;
    return amountOut * Math.max(0, 1 - (hopPenaltyBps * extraHops) / 10_000);
}

// Ranks candidate paths best-first. Every criterion exists because leaving it out produced a wrong
// answer:
//   1. A path that fills completely beats one that does not — rate is meaningless on size you
//      cannot get.
//   2. A path that produces SOMETHING beats one that produces nothing. Without this, a dead direct
//      market (score 0) ties a live bridged one at a high penalty and wins on listing order, and
//      the whole request is then reported unroutable while pathsConsidered lists the alternative.
//   3. Score, the penalty-adjusted output — the actual preference being expressed.
//   4. Fewer hops, which is what the penalty was trying to say once it saturated.
//   5. Raw output, so paths whose scores were clamped to the same 0 still order sensibly.
// Without 2, 4 and 5 an extreme hopPenaltyBps made the choice fall through to whichever path
// candidatePaths happened to emit first.
export function comparePaths (
    a: { fullyFillable: boolean; amountOut: number; score: number; hopCount: number },
    b: { fullyFillable: boolean; amountOut: number; score: number; hopCount: number },
): number {
    if (a.fullyFillable !== b.fullyFillable) return a.fullyFillable ? -1 : 1;
    const aLive = a.amountOut > 0;
    const bLive = b.amountOut > 0;
    if (aLive !== bLive) return aLive ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.hopCount !== b.hopCount) return a.hopCount - b.hopCount;
    return b.amountOut - a.amountOut;
}

function toConsidered (solved: SolvedPath, chosen: boolean): ConsideredPath {
    return {
        pairs: solved.candidate.hops.map((h) => h.pair),
        bridge: solved.candidate.bridge,
        amountOut: solved.amountOut,
        fullyFillable: solved.fullyFillable,
        score: solved.score,
        chosen,
    };
}

function emptyResult (
    req: RouteRequest, opts: RouteOptions, now: number,
    reason: UnroutableReason, hopIndex: number | null,
    hops: RouteHop[] = [], pathsConsidered: ConsideredPath[] = [],
): RouteResult {
    const exactSide = req.amountIn !== undefined ? 'in' : 'out';
    const requested = req.amountIn ?? req.amountOut ?? 0;
    return {
        requestId: opts.requestId, calculatedAt: now, calculatedAtIso: new Date(now).toISOString(),
        from: req.from, to: req.to,
        amountIn: 0, amountOut: 0, requestedAmount: requested, exactSide,
        strategy: opts.strategy, includeFees: opts.includeFees,
        exchangesFilter: opts.exchanges ? [...opts.exchanges].sort() : null,
        certifiedOnly: opts.certifiedOnly, staleBookMs: opts.staleBookMs,
        stalenessPenaltyBps: opts.stalenessPenaltyBps, hopPenaltyBps: opts.hopPenaltyBps,
        requireFullFill: opts.requireFullFill,
        hops, effectiveRate: null, referenceRate: null, impactBps: null,
        fullyFillable: false, fillRatio: 0, unfilledAmount: requested,
        unroutableReason: reason, unroutableHopIndex: hopIndex, warnings: [],
        savingVsBestSingleBps: null, pathsConsidered,
    };
}

export function computeRoute (
    cache: OrderBookCache, feeRegistry: FeeRegistry, req: RouteRequest, opts: RouteOptions,
): RouteResult {
    const now = Date.now();
    const exactSide: 'in' | 'out' = req.amountIn !== undefined ? 'in' : 'out';
    const requested = req.amountIn ?? req.amountOut ?? 0;

    const candidates = candidatePaths(cache, req.from, req.to, req.bridges);
    if (candidates.length === 0) return emptyResult(req, opts, now, 'no_market', null);
    // Shared across every candidate path AND the winner's re-solve: the same market appears in
    // more than one candidate, and the winner is solved twice.
    const memo = createSolveCache();

    let hops: RouteHop[];
    let bestSingleEff: number | null;
    let pathsConsidered: ConsideredPath[] = [];
    let deadHopIndex: number | null;
    let trimmed = false;

    if (exactSide === 'out') {
        // Exact-out over a bridge would require solving backwards from the destination, which is a
        // different traversal per hop; refused rather than silently approximated. Reported
        // distinctly from no_market so the caller knows to retry with amountIn rather than
        // concluding the two assets are unreachable.
        const direct = candidates.find((c) => c.bridge === null);
        if (!direct) return emptyResult(req, opts, now, 'exact_out_multi_hop_unsupported', null);
        const h = direct.hops[0]!;
        // Amount is in the hop's OUTPUT asset: base when buying it, quote when selling into it.
        const sol = solveHop(cache, feeRegistry, h, requested, h.side === 'buy', opts, { collectQuotes: true }, memo);
        hops = [sol.hop];
        bestSingleEff = sol.bestSingleEffective;
        deadHopIndex = sol.hop.amountOut <= 0 ? 0 : null;
    } else {
        // Compare every candidate market path and take the best, rather than committing to
        // whichever one was found first. Losing paths are solved WITHOUT their per-venue quote
        // arrays, which are a reporting detail nobody sees for a path that was not chosen.
        const solved = candidates.map((c) =>
            solvePathExactIn(cache, feeRegistry, c, requested, opts, candidates.length === 1, memo));
        const ranked = solved.slice().sort((a, b) => comparePaths(
            { fullyFillable: a.fullyFillable, amountOut: a.amountOut, score: a.score, hopCount: a.candidate.hops.length },
            { fullyFillable: b.fullyFillable, amountOut: b.amountOut, score: b.score, hopCount: b.candidate.hops.length },
        ));
        let winner = ranked[0]!;
        if (candidates.length > 1) {
            // Re-solve the winner with quotes now that the comparison is over.
            winner = solvePathExactIn(cache, feeRegistry, winner.candidate, requested, opts, true, memo);
            pathsConsidered = solved.map((s) => toConsidered(s, s.candidate === winner.candidate));
        }
        hops = winner.hops;
        bestSingleEff = winner.bestSingleEffective;
        deadHopIndex = winner.deadHopIndex;
        trimmed = winner.trimmed;
    }

    if (deadHopIndex !== null) {
        return emptyResult(req, opts, now, classify(hops[deadHopIndex]!, opts), deadHopIndex, hops, pathsConsidered);
    }

    let amountIn = hops[0]!.amountIn;
    let amountOut = hops[hops.length - 1]!.amountOut;
    // Snap the pinned side back to exactly what was asked for when the gap is float accumulation
    // (walking many levels leaves 0.9999999999999998 for a requested 1). Left unsnapped, a caller
    // doing `amountOut >= requested` sees a full fill as a partial one. The tolerance is relative
    // and far below any real dust: a genuine shortfall is orders of magnitude larger.
    const pinned = exactSide === 'in' ? amountIn : amountOut;
    if (pinned !== requested && Math.abs(pinned - requested) <= requested * 1e-9) {
        if (exactSide === 'in') amountIn = requested;
        else amountOut = requested;
    }
    const achieved = exactSide === 'in' ? amountIn : amountOut;
    const fillRatio = requested > 0 ? achieved / requested : 0;
    // Both conditions are needed. Hop flags alone miss a trimmed route (every hop fills its own
    // reduced target, yet the request did not go through); the ratio alone misses a single hop that
    // filled the pinned side while reporting itself short.
    const fullyFillable = !trimmed && fillRatio >= 1 - 1e-9 && hops.every((h) => h.fullyFillable);
    const unfilledAmount = Math.max(0, requested - achieved);
    const effectiveRate = amountIn > 0 ? amountOut / amountIn : null;

    // Chain the hops' frictionless prices into one end-to-end benchmark rate, then measure the
    // realised rate against it. A buy's reference price is quote-per-base, so its contribution to
    // an out-per-in rate is the reciprocal.
    let referenceRate: number | null = null;
    let impactBps: number | null = null;
    if (hops.length > 0 && hops.every((h) => h.referencePrice !== null && h.referencePrice > 0)) {
        referenceRate = hops.reduce(
            (rate, h) => rate * (h.side === 'buy' ? 1 / (h.referencePrice as number) : (h.referencePrice as number)),
            1);
        if (effectiveRate !== null && referenceRate > 0) {
            impactBps = ((referenceRate - effectiveRate) / referenceRate) * 10_000;
        }
    }

    const warnings: string[] = [];
    if (!fullyFillable && achieved > 0) {
        warnings.push(
            `partial_fill: only ${(fillRatio * 100).toFixed(2)}% of the requested ${exactSide === 'in' ? req.from : req.to} `
            + `could be routed. effectiveRate prices the FILLED portion only; the remainder would cost more.`,
        );
    }
    if (hops.length > 1) {
        warnings.push(
            `multi_hop: routed via ${hops.map((h) => h.pair).join(' -> ')}. Hops are solved sequentially, not `
            + `jointly, so this is a good route rather than a provably optimal one. Each hop carries its own `
            + `execution risk and fees (see feeCurrency per hop).`,
        );
    }

    let savingVsBestSingleBps: number | null = null;
    if (hops.length === 1 && bestSingleEff !== null && hops[0]!.legs.length > 0) {
        const h = hops[0]!;
        const vwap = h.side === 'buy' ? h.amountIn / h.amountOut : h.amountOut / h.amountIn;
        const diff = h.side === 'buy' ? bestSingleEff - vwap : vwap - bestSingleEff;
        savingVsBestSingleBps = (diff / bestSingleEff) * 10_000;
    }

    return {
        requestId: opts.requestId, calculatedAt: now, calculatedAtIso: new Date(now).toISOString(),
        from: req.from, to: req.to, amountIn, amountOut, requestedAmount: requested, exactSide,
        strategy: opts.strategy, includeFees: opts.includeFees,
        exchangesFilter: opts.exchanges ? [...opts.exchanges].sort() : null,
        certifiedOnly: opts.certifiedOnly, staleBookMs: opts.staleBookMs,
        stalenessPenaltyBps: opts.stalenessPenaltyBps, hopPenaltyBps: opts.hopPenaltyBps,
        requireFullFill: opts.requireFullFill,
        hops, effectiveRate, referenceRate, impactBps,
        fullyFillable, fillRatio, unfilledAmount,
        unroutableReason: null, unroutableHopIndex: null,
        warnings, savingVsBestSingleBps, pathsConsidered,
    };
}

function classify (hop: RouteHop, opts: RouteOptions): UnroutableReason {
    if (hop.quotes.length === 0 && hop.freshVenueCount === 0) return 'no_venues_matched_filter';
    if (hop.freshVenueCount === 0) return 'all_books_stale';
    if (opts.requireFullFill) return 'insufficient_depth';
    return 'no_liquidity';
}
