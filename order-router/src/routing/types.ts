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
    // Denominated in the hop's own input/output assets, so a multi-hop route chains without the
    // caller having to work out which currency each number is in.
    amountIn: number;
    amountOut: number;
    legs: RouteLeg[];
    feeCost: number;
    // Fees are charged in different currencies on different hops (USDT on SOL->USDT, BTC on
    // USDT->BTC). Summing them into one number would be adding different units, so the currency
    // is explicit per hop and there is deliberately no cross-hop fee total.
    feeCurrency: string;
    fullyFillable: boolean;
    // Per hop, because "which hop was considered against what" is unanswerable from a flat list.
    quotes: RoutingQuote[];
    freshVenueCount: number;
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
    hops: RouteHop[];
    // Units of `to` per unit of `from`, all-in. The single number most callers actually want.
    effectiveRate: number | null;
    fullyFillable: boolean;
    fillRatio: number;
    unfilledAmount: number;
    unroutableReason: UnroutableReason | null;
    // Which hop failed, so a multi-hop failure is diagnosable. Null when routing succeeded.
    unroutableHopIndex: number | null;
    warnings: string[];
    savingVsBestSingleBps: number | null;
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
}
