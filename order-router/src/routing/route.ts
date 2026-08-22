import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { resolveDirectHop, resolveBridgedHops } from './market.js';
import { solveHop } from './engine.js';
import type { RouteHop, RouteOptions, RouteResult, UnroutableReason } from './types.js';

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

function emptyResult (
    req: RouteRequest, opts: RouteOptions, now: number,
    reason: UnroutableReason, hopIndex: number | null, hops: RouteHop[] = [],
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
        stalenessPenaltyBps: opts.stalenessPenaltyBps,
        hops, effectiveRate: null, fullyFillable: false, fillRatio: 0,
        unfilledAmount: requested,
        unroutableReason: reason, unroutableHopIndex: hopIndex, warnings: [],
        savingVsBestSingleBps: null,
    };
}

export function computeRoute (
    cache: OrderBookCache, feeRegistry: FeeRegistry, req: RouteRequest, opts: RouteOptions,
): RouteResult {
    const now = Date.now();
    const exactSide: 'in' | 'out' = req.amountIn !== undefined ? 'in' : 'out';
    const requested = req.amountIn ?? req.amountOut ?? 0;

    const direct = resolveDirectHop(cache, req.from, req.to);
    const path = direct ? [direct] : resolveBridgedHops(cache, req.from, req.to, req.bridges);
    if (!path) return emptyResult(req, opts, now, 'no_market', null);

    // Exact-out on a multi-hop route would require solving backwards from the destination, which
    // is a different traversal per hop; not supported yet rather than silently approximated.
    if (exactSide === 'out' && path.length > 1) {
        return emptyResult(req, opts, now, 'no_market', null);
    }

    const hops: RouteHop[] = [];
    let bestSingleEff: number | null = null;

    if (exactSide === 'in') {
        // Chain forward: each hop's realised output funds the next. Hops are solved sequentially,
        // NOT jointly — hop 1's split is chosen without knowing what hop 2 would prefer, so the
        // result is a good route rather than a provably optimal one. Joint optimisation is a
        // min-cost flow over the asset graph and is deliberately out of scope here.
        let carry = requested;
        for (let i = 0; i < path.length; i++) {
            const h = path[i]!;
            // Amount is in the hop's INPUT asset: base when selling it, quote when buying with it.
            const byBase = h.side === 'sell';
            const sol = solveHop(cache, feeRegistry, h, carry, byBase, opts);
            if (i === 0) bestSingleEff = sol.bestSingleEffective;
            hops.push(sol.hop);
            carry = sol.hop.amountOut;
            if (carry <= 0) {
                return emptyResult(req, opts, now, classify(sol.hop, opts), i, hops);
            }
        }
    } else {
        const h = path[0]!;
        // Amount is in the hop's OUTPUT asset: base when buying it, quote when selling into it.
        const byBase = h.side === 'buy';
        const sol = solveHop(cache, feeRegistry, h, requested, byBase, opts);
        bestSingleEff = sol.bestSingleEffective;
        hops.push(sol.hop);
        if (sol.hop.amountOut <= 0) {
            return emptyResult(req, opts, now, classify(sol.hop, opts), 0, hops);
        }
    }

    const amountIn = hops[0]!.amountIn;
    const amountOut = hops[hops.length - 1]!.amountOut;
    const achieved = exactSide === 'in' ? amountIn : amountOut;
    const fillRatio = requested > 0 ? achieved / requested : 0;
    const fullyFillable = hops.every((h) => h.fullyFillable);
    const unfilledAmount = Math.max(0, requested - achieved);

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
        savingVsBestSingleBps = (diff / bestSingleEff) * 10000;
    }

    return {
        requestId: opts.requestId, calculatedAt: now, calculatedAtIso: new Date(now).toISOString(),
        from: req.from, to: req.to, amountIn, amountOut, requestedAmount: requested, exactSide,
        strategy: opts.strategy, includeFees: opts.includeFees,
        exchangesFilter: opts.exchanges ? [...opts.exchanges].sort() : null,
        certifiedOnly: opts.certifiedOnly, staleBookMs: opts.staleBookMs,
        stalenessPenaltyBps: opts.stalenessPenaltyBps,
        hops,
        effectiveRate: amountIn > 0 ? amountOut / amountIn : null,
        fullyFillable, fillRatio, unfilledAmount,
        unroutableReason: null, unroutableHopIndex: null,
        warnings, savingVsBestSingleBps,
    };
}

function classify (hop: RouteHop, opts: RouteOptions): UnroutableReason {
    if (hop.quotes.length === 0) return 'no_venues_matched_filter';
    if (hop.freshVenueCount === 0) return 'all_books_stale';
    if (opts.requireFullFill) return 'insufficient_depth';
    return 'no_liquidity';
}
