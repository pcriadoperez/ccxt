import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { RoutingQuote } from '../types.js';

export const ROUTE_STRATEGIES = ['best_single', 'split_optimal', 'split_capped'] as const;
export type RouteStrategy = (typeof ROUTE_STRATEGIES)[number];

export interface RouteLeg {
    exchangeId: string;
    amount: number;
    averagePrice: number;
    takerFeeRate: number;
    feeCost: number;
    effectivePrice: number;
}

export interface RouteResult {
    requestId: string;
    calculatedAt: number;
    calculatedAtIso: string;
    symbol: string;
    side: 'buy' | 'sell';
    amount: number;
    strategy: RouteStrategy;
    includeFees: boolean;
    route: RouteLeg[];
    filledAmount: number;
    fullyFillable: boolean;
    routeVwap: number | undefined;
    routeNotional: number;
    totalFeeCost: number;
    savingVsBestSingleBps: number | undefined;
    quotes: RoutingQuote[];
}

export interface RouteOptions {
    strategy: RouteStrategy;
    includeFees: boolean;
    maxVenues: number;
    minLegNotional: number;
    staleBookMs: number;
    requestId: string;
}

interface ConsolidatedLevel {
    exchangeId: string;
    rawPrice: number;
    effectivePrice: number;
    takerFeeRate: number;
    amount: number;
}

function walkBook (levels: { price: number; amount: number }[], amount: number) {
    let remaining = amount;
    let notional = 0;
    let filled = 0;
    for (const level of levels) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, level.amount);
        notional += take * level.price;
        filled += take;
        remaining -= take;
    }
    return filled === 0
        ? { averagePrice: undefined as number | undefined, filledAmount: 0 }
        : { averagePrice: notional / filled, filledAmount: filled };
}

// Fee-adjusting each level BEFORE merging is the whole trick. Merging on raw price and applying
// fees afterwards picks the wrong levels: 78,400 on a 0.10% venue is genuinely worse than 78,420
// on a 0.035% one, and a raw-price sort cannot see that.
function buildConsolidatedBook (
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    symbol: string,
    side: 'buy' | 'sell',
    opts: RouteOptions,
    allowedExchanges?: Set<string>,
): ConsolidatedLevel[] {
    const now = Date.now();
    const levels: ConsolidatedLevel[] = [];
    for (const book of cache.getBooksForSymbol(symbol)) {
        if (now - book.receivedAt > opts.staleBookMs) continue;
        if (allowedExchanges && !allowedExchanges.has(book.exchangeId)) continue;
        const fee = opts.includeFees ? feeRegistry.getFee(book.exchangeId, symbol) : 0;
        for (const lvl of (side === 'buy' ? book.asks : book.bids)) {
            levels.push({
                exchangeId: book.exchangeId,
                rawPrice: lvl.price,
                // Buy: fees make the level dearer. Sell: fees cut your proceeds.
                effectivePrice: side === 'buy' ? lvl.price * (1 + fee) : lvl.price * (1 - fee),
                takerFeeRate: fee,
                amount: lvl.amount,
            });
        }
    }
    // Buy wants the cheapest effective levels first; sell wants the richest.
    levels.sort((a, b) => (side === 'buy' ? a.effectivePrice - b.effectivePrice : b.effectivePrice - a.effectivePrice));
    return levels;
}

function allocate (levels: ConsolidatedLevel[], amount: number) {
    const perVenue = new Map<string, { amount: number; rawNotional: number; feeCost: number; fee: number }>();
    let remaining = amount;
    for (const lvl of levels) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, lvl.amount);
        const entry = perVenue.get(lvl.exchangeId) ?? { amount: 0, rawNotional: 0, feeCost: 0, fee: lvl.takerFeeRate };
        entry.amount += take;
        entry.rawNotional += take * lvl.rawPrice;
        // Fee cost is the gap between effective and raw notional — signed the same way for both
        // sides, so it always reads as "what the fee cost you".
        entry.feeCost += Math.abs(take * lvl.effectivePrice - take * lvl.rawPrice);
        perVenue.set(lvl.exchangeId, entry);
        remaining -= take;
    }
    return { perVenue, filledAmount: amount - remaining };
}

function toLegs (perVenue: ReturnType<typeof allocate>['perVenue'], side: 'buy' | 'sell'): RouteLeg[] {
    const legs: RouteLeg[] = [];
    for (const [exchangeId, v] of perVenue) {
        const averagePrice = v.rawNotional / v.amount;
        legs.push({
            exchangeId,
            amount: v.amount,
            averagePrice,
            takerFeeRate: v.fee,
            feeCost: v.feeCost,
            effectivePrice: side === 'buy' ? averagePrice * (1 + v.fee) : averagePrice * (1 - v.fee),
        });
    }
    return legs.sort((a, b) => b.amount - a.amount);
}

export function computeRoute (
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    opts: RouteOptions,
): RouteResult {
    const now = Date.now();

    // Per-venue quotes are kept purely as the diagnostic "what was considered, and why was it
    // excluded" view — they are not what the route is computed from.
    const quotes: RoutingQuote[] = [];
    for (const book of cache.getBooksForSymbol(symbol)) {
        const bookAgeMs = now - book.receivedAt;
        const fee = opts.includeFees ? feeRegistry.getFee(book.exchangeId, symbol) : 0;
        const { averagePrice, filledAmount } = walkBook(side === 'buy' ? book.asks : book.bids, amount);
        quotes.push({
            exchangeId: book.exchangeId,
            side,
            requestedAmount: amount,
            filledAmount,
            averagePrice,
            effectivePriceWithFee: averagePrice === undefined
                ? undefined
                : side === 'buy' ? averagePrice * (1 + fee) : averagePrice * (1 - fee),
            takerFeeRate: fee,
            fullyFillable: filledAmount >= amount,
            bookAgeMs,
        });
    }

    // Baseline: the best single venue, always computed so savingVsBestSingleBps is meaningful
    // even when the caller asked for a split.
    const usable = quotes.filter((q) => q.effectivePriceWithFee !== undefined && q.bookAgeMs <= opts.staleBookMs);
    const bestSingle = usable.slice().sort((a, b) => {
        if (a.fullyFillable !== b.fullyFillable) return a.fullyFillable ? -1 : 1;
        const ap = a.effectivePriceWithFee as number;
        const bp = b.effectivePriceWithFee as number;
        return side === 'buy' ? ap - bp : bp - ap;
    })[0];

    let legs: RouteLeg[] = [];
    let filledAmount = 0;

    if (opts.strategy === 'best_single') {
        if (bestSingle) {
            const only = new Set([bestSingle.exchangeId]);
            const res = allocate(buildConsolidatedBook(cache, feeRegistry, symbol, side, opts, only), amount);
            legs = toLegs(res.perVenue, side);
            filledAmount = res.filledAmount;
        }
    } else {
        let res = allocate(buildConsolidatedBook(cache, feeRegistry, symbol, side, opts), amount);

        if (opts.strategy === 'split_capped' && res.perVenue.size > opts.maxVenues) {
            // Greedy approximation, not a proven optimum: run unconstrained, keep the venues
            // carrying the most volume, then re-solve restricted to them. Exhaustive subset
            // search would be C(n, k) and is not worth it at ~40 candidate venues.
            const keep = new Set(
                [...res.perVenue.entries()]
                    .sort((a, b) => b[1].amount - a[1].amount)
                    .slice(0, opts.maxVenues)
                    .map(([ex]) => ex),
            );
            res = allocate(buildConsolidatedBook(cache, feeRegistry, symbol, side, opts, keep), amount);
        }

        // Drop dust legs that would be rejected by venue minimum-order rules, then re-solve
        // without those venues so the freed size is actually reallocated rather than lost.
        if (opts.minLegNotional > 0) {
            const tooSmall = new Set(
                [...res.perVenue.entries()]
                    .filter(([, v]) => v.rawNotional < opts.minLegNotional)
                    .map(([ex]) => ex),
            );
            if (tooSmall.size > 0 && tooSmall.size < res.perVenue.size) {
                const keep = new Set([...res.perVenue.keys()].filter((ex) => !tooSmall.has(ex)));
                res = allocate(buildConsolidatedBook(cache, feeRegistry, symbol, side, opts, keep), amount);
            }
        }

        legs = toLegs(res.perVenue, side);
        filledAmount = res.filledAmount;
    }

    const routeNotional = legs.reduce((s, l) => s + l.amount * l.effectivePrice, 0);
    const totalFeeCost = legs.reduce((s, l) => s + l.feeCost, 0);
    const routeVwap = filledAmount > 0 ? routeNotional / filledAmount : undefined;

    let savingVsBestSingleBps: number | undefined;
    if (routeVwap !== undefined && bestSingle?.effectivePriceWithFee !== undefined) {
        const single = bestSingle.effectivePriceWithFee;
        // Buy: cheaper is better. Sell: richer is better. Positive always means "the route beat
        // the single-venue baseline".
        const diff = side === 'buy' ? single - routeVwap : routeVwap - single;
        savingVsBestSingleBps = (diff / single) * 10000;
    }

    return {
        requestId: opts.requestId,
        calculatedAt: now,
        calculatedAtIso: new Date(now).toISOString(),
        symbol,
        side,
        amount,
        strategy: opts.strategy,
        includeFees: opts.includeFees,
        route: legs,
        filledAmount,
        fullyFillable: filledAmount >= amount,
        routeVwap,
        routeNotional,
        totalFeeCost,
        savingVsBestSingleBps,
        quotes,
    };
}
