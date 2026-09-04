import type { RoutingQuote } from '../types.js';
import type { BalanceBook } from './balances.js';

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
    | 'insufficient_depth'
    // The market could have filled this; the caller's wallet could not. Reported separately
    // because the alternatives all blame the venues for a shortfall that is not theirs.
    | 'insufficient_balance';

export interface RouteLeg {
    exchangeId: string;
    amount: number;
    averagePrice: number;
    takerFeeRate: number;
    feeCost: number;
    effectivePrice: number;
    // Whether this leg was cut short by the caller's balance rather than by the book. An executor
    // reads it as "more was available here, you just could not pay for it" — a different situation
    // from a venue that ran out of depth, and the two need different follow-up.
    balanceLimited: boolean;
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
    // Venues considered for this hop after the exchange/certified filters, whether or not they
    // were fresh and whether or not quotes[] was returned. Distinguishes "the filters excluded
    // everything" from "every book was stale" without depending on the diagnostic being requested.
    venueCount: number;
    freshVenueCount: number;
    // A THIRD bucket beside the two above, for the same reason they are separate from each other:
    // a venue the caller has no money on was neither excluded by a filter nor stale, and folding
    // it into either counter would make that counter lie. Counted over the venues a wallet COULD
    // have funded — fresh, with depth on the side being traded — so it equals freshVenueCount when
    // no balances were supplied. Counting the others too made "every venue that could trade was
    // unfunded" unreachable whenever the money sat on a stale or wrong-sided venue, which is the
    // commonest wallet-vs-market case there is.
    fundedVenueCount: number;
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
    // Whether to compute and return the per-venue quotes[] diagnostic. It is ~90% of a response's
    // bytes and is a "why these venues?" explanation, not an input to any decision — so a stream
    // pushing many times a second does not want it by default.
    includeQuotes: boolean;
    // How much better a multi-hop route must be, per extra hop, before it beats a direct market.
    // A second order is a second chance for the price to move between fills, and that risk is not
    // in the book — so a bridge that wins by a hair is not actually the better trade.
    hopPenaltyBps: number;
    // What the caller holds, or null for unconstrained. Consumed INSIDE the path solver — the
    // source amount is clamped before any candidate is scored and each venue gets a spending
    // budget during the greedy walk — because a constraint applied to the answer afterwards can
    // only mutilate the winner, never change which path wins.
    balances: BalanceBook | null;
    // Whether a balance shortfall clamps the request or refuses it. 'cap' is the default because
    // requireFullFill is the opt-in flag for "refuse rather than shrink", and a second knob with
    // the opposite polarity would be a coin flip.
    balanceMode: 'cap' | 'require';
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
    // The balances that were applied, canonicalised and key-sorted, or null when none were sent.
    // Echoed for the same reason requireFullFill is: /route declares its query type to Fastify
    // without a JSON schema, so a server that predates this feature IGNORES balances and answers
    // byte-identically to one that never received them. A client must verify this field before
    // executing, or it is trading a plan computed against a portfolio the server never saw.
    balancesApplied: string | null;
    balanceMode: 'cap' | 'require';
    // The ceiling the wallet put on amountIn, or null when unconstrained. Carried separately from
    // requestedAmount precisely so fillRatio cannot lie: asking for 50k while holding 40k reports
    // requestedAmount 50000, fillRatio 0.8 and balanceCapAmountIn 40000, not a full fill of 40k.
    balanceCapAmountIn: number | null;
    balanceEntryCount: number;
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
