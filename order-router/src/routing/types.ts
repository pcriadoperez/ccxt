import type { RoutingQuote } from '../types.js';

export const ROUTE_STRATEGIES = ['best_single', 'split_optimal', 'split_capped'] as const;
export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

export type UnroutableReason =
    | 'no_market'
    // Distinct from no_market: a path DOES exist, the router just cannot solve this shape. Kept
    // separate so a caller can retry with amountIn instead of concluding the assets are unlisted.
    | 'exact_out_multi_hop_unsupported'
    | 'no_venues_matched_filter'
    | 'all_books_stale'
    | 'no_liquidity'
    | 'insufficient_depth';

export interface RouteLeg {
    exchangeId: string;
    amount: number;
    averagePrice: number;
    takerFeeRate: number;
    feeCost: number;
    effectivePrice: number;
}

export interface RouteHop {
    pair: string;
    side: 'buy' | 'sell';
    base: string;
    quote: string;
    amountIn: number;
    amountOut: number;
    legs: RouteLeg[];
    feeCost: number;
    feeCurrency: string;
    fullyFillable: boolean;
    // The best fee-adjusted price available anywhere for an infinitesimally small order — the
    // frictionless benchmark. Null when no fresh venue could be priced.
    referencePrice: number | null;
    // How much worse this hop's size actually executes than referencePrice, in basis points.
    // Positive is always worse, on both sides. Isolates the cost of consuming depth: fees and the
    // staleness penalty are already in both halves of the comparison.
    impactBps: number | null;
    quotes: RoutingQuote[];
    freshVenueCount: number;
}

// One candidate route the router evaluated, whether or not it won. Reported so the choice is
// auditable — "why this venue?" was already answerable from quotes[]; this answers "why this
// market?" for conversions that could go more than one way.
export interface ConsideredPath {
    pairs: string[];
    // The intermediary asset, or null for a direct market.
    bridge: string | null;
    amountOut: number;
    fullyFillable: boolean;
    // amountOut after the per-extra-hop penalty. This, not amountOut, decides the winner.
    score: number;
    chosen: boolean;
}

export interface RouteOptions {
    strategy: RouteStrategy;
    includeFees: boolean;
    maxVenues: number;
    minLegNotional: number;
    staleBookMs: number;
    requestId: string;
    exchanges?: Set<string>;
    certifiedOnly: boolean;
    requireFullFill: boolean;
    stalenessPenaltyBps: number;
    // How much better a multi-hop route must be, per extra hop, before it beats a direct market.
    // A second order is a second chance for the price to move between fills, and that risk is not
    // in the book — so a bridge that wins by a hair is not actually the better trade.
    hopPenaltyBps: number;
}

export interface RouteResult {
    requestId: string;
    calculatedAt: number;
    calculatedAtIso: string;
    from: string;
    to: string;
    // What the route actually ACHIEVES on each side. Both are 0 when the route is unroutable —
    // echoing the request back as an outcome would show a caller a fill that will not happen.
    amountIn: number;
    amountOut: number;
    // What was asked for, in the units of exactSide ('in' -> `from`, 'out' -> `to`). Compare
    // against amountIn/amountOut to see how much of the request was satisfied.
    requestedAmount: number;
    // Which side the caller pinned. The other side is the computed result.
    exactSide: 'in' | 'out';
    strategy: RouteStrategy;
    includeFees: boolean;
    exchangesFilter: string[] | null;
    certifiedOnly: boolean;
    staleBookMs: number;
    stalenessPenaltyBps: number;
    hopPenaltyBps: number;
    // Echoed so a caller can confirm the safety flag they sent was actually applied. Without it a
    // request that lost the flag in transit is indistinguishable from one that never set it.
    requireFullFill: boolean;
    hops: RouteHop[];
    effectiveRate: number | null;
    // End-to-end frictionless rate: the hops' reference prices chained together. What you would
    // get if size were free.
    referenceRate: number | null;
    // How far effectiveRate falls short of referenceRate, in basis points. The end-to-end cost of
    // size, across every hop.
    impactBps: number | null;
    fullyFillable: boolean;
    fillRatio: number;
    unfilledAmount: number;
    unroutableReason: UnroutableReason | null;
    unroutableHopIndex: number | null;
    warnings: string[];
    savingVsBestSingleBps: number | null;
    // Every candidate market path considered, winner flagged. Empty when only one path existed.
    pathsConsidered: ConsideredPath[];
}
