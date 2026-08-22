import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { RoutingQuote } from '../types.js';
import { isCertified } from '../exchangeMeta.js';
import type { RouteLeg, RouteOptions, RouteHop } from './types.js';
import type { ResolvedHop } from './market.js';

interface ConsolidatedLevel {
    exchangeId: string;
    rawPrice: number;
    effectivePrice: number;
    takerFeeRate: number;
    amount: number;
}

export function stalenessPenaltyFraction (ageMs: number, penaltyBps: number): number {
    if (penaltyBps <= 0 || ageMs <= 0) return 0;
    return (penaltyBps * Math.sqrt(ageMs / 1000)) / 10_000;
}

export function isVenueAllowed (id: string, opts: Pick<RouteOptions, 'exchanges' | 'certifiedOnly'>): boolean {
    if (opts.exchanges && !opts.exchanges.has(id)) return false;
    if (opts.certifiedOnly && !isCertified(id)) return false;
    return true;
}

function buildBook (
    cache: OrderBookCache, fees: FeeRegistry, hop: ResolvedHop, opts: RouteOptions, allow?: Set<string>,
): ConsolidatedLevel[] {
    const now = Date.now();
    const levels: ConsolidatedLevel[] = [];
    for (const book of cache.getBooksForSymbol(hop.pair)) {
        if (now - book.receivedAt > opts.staleBookMs) continue;
        if (allow && !allow.has(book.exchangeId)) continue;
        if (!isVenueAllowed(book.exchangeId, opts)) continue;
        const fee = opts.includeFees ? fees.getFee(book.exchangeId, hop.pair) : 0;
        const stale = stalenessPenaltyFraction(now - book.receivedAt, opts.stalenessPenaltyBps);
        for (const lvl of (hop.side === 'buy' ? book.asks : book.bids)) {
            const feeAdj = hop.side === 'buy' ? lvl.price * (1 + fee) : lvl.price * (1 - fee);
            levels.push({
                exchangeId: book.exchangeId,
                rawPrice: lvl.price,
                effectivePrice: hop.side === 'buy' ? feeAdj * (1 + stale) : feeAdj * (1 - stale),
                takerFeeRate: fee,
                amount: lvl.amount,
            });
        }
    }
    levels.sort((a, b) => (hop.side === 'buy' ? a.effectivePrice - b.effectivePrice : b.effectivePrice - a.effectivePrice));
    return levels;
}

interface Allocation {
    perVenue: Map<string, { amount: number; rawNotional: number; effNotional: number; feeCost: number; fee: number }>;
    baseFilled: number;
    quoteSpent: number;
}

// `target` is interpreted in BASE units when byBase, else in QUOTE units. Exact-in on a buy
// ("spend 50k USDT") is a notional walk, which is a genuinely different traversal from the
// quantity walk — you stop when the money runs out, not when the size is reached.
function allocate (levels: ConsolidatedLevel[], target: number, byBase: boolean): Allocation {
    const perVenue: Allocation['perVenue'] = new Map();
    let baseFilled = 0;
    let quoteSpent = 0;
    let remaining = target;
    for (const lvl of levels) {
        if (remaining <= 1e-15) break;
        const takeBase = byBase
            ? Math.min(remaining, lvl.amount)
            : Math.min(remaining / lvl.effectivePrice, lvl.amount);
        if (takeBase <= 0) continue;
        const eff = takeBase * lvl.effectivePrice;
        const raw = takeBase * lvl.rawPrice;
        const e = perVenue.get(lvl.exchangeId)
            ?? { amount: 0, rawNotional: 0, effNotional: 0, feeCost: 0, fee: lvl.takerFeeRate };
        e.amount += takeBase;
        e.rawNotional += raw;
        e.effNotional += eff;
        e.feeCost += Math.abs(eff - raw);
        perVenue.set(lvl.exchangeId, e);
        baseFilled += takeBase;
        quoteSpent += eff;
        remaining -= byBase ? takeBase : eff;
    }
    return { perVenue, baseFilled, quoteSpent };
}

function toLegs (alloc: Allocation, side: 'buy' | 'sell'): RouteLeg[] {
    const legs: RouteLeg[] = [];
    for (const [exchangeId, v] of alloc.perVenue) {
        if (v.amount <= 1e-12) continue;
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

export interface HopSolution {
    hop: RouteHop;
    bestSingleEffective: number | null;
}

// Solves ONE hop. `target` is in base units when byBase, else quote units.
export function solveHop (
    cache: OrderBookCache, fees: FeeRegistry, hop: ResolvedHop,
    target: number, byBase: boolean, opts: RouteOptions,
): HopSolution {
    const now = Date.now();
    const quotes: RoutingQuote[] = [];
    for (const book of cache.getBooksForSymbol(hop.pair)) {
        if (!isVenueAllowed(book.exchangeId, opts)) continue;
        const fee = opts.includeFees ? fees.getFee(book.exchangeId, hop.pair) : 0;
        const single = allocate(
            buildBook(cache, fees, hop, { ...opts, staleBookMs: Number.MAX_SAFE_INTEGER }, new Set([book.exchangeId])),
            target, byBase);
        // averagePrice must stay RAW and effectivePriceWithFee adjusted — reporting the adjusted
        // number as both would hide the fee from anyone comparing the two, which is the whole
        // point of showing them side by side.
        const venue = single.perVenue.get(book.exchangeId);
        const rawAvg = (venue && single.baseFilled > 0) ? venue.rawNotional / single.baseFilled : undefined;
        const effAvg = single.baseFilled > 0 ? single.quoteSpent / single.baseFilled : undefined;
        quotes.push({
            exchangeId: book.exchangeId,
            side: hop.side,
            requestedAmount: target,
            filledAmount: single.baseFilled,
            averagePrice: rawAvg,
            effectivePriceWithFee: effAvg,
            takerFeeRate: fee,
            fullyFillable: byBase ? single.baseFilled >= target - 1e-12 : single.quoteSpent >= target - 1e-9,
            bookAgeMs: now - book.receivedAt,
        });
    }

    const fresh = quotes.filter((q) => q.bookAgeMs <= opts.staleBookMs && q.effectivePriceWithFee !== undefined);
    const bestSingle = fresh.slice().sort((a, b) => {
        if (a.fullyFillable !== b.fullyFillable) return a.fullyFillable ? -1 : 1;
        const ap = a.effectivePriceWithFee as number;
        const bp = b.effectivePriceWithFee as number;
        return hop.side === 'buy' ? ap - bp : bp - ap;
    })[0];

    let alloc: Allocation;
    if (opts.strategy === 'best_single') {
        alloc = bestSingle
            ? allocate(buildBook(cache, fees, hop, opts, new Set([bestSingle.exchangeId])), target, byBase)
            : { perVenue: new Map(), baseFilled: 0, quoteSpent: 0 };
    } else {
        alloc = allocate(buildBook(cache, fees, hop, opts), target, byBase);

        if (opts.strategy === 'split_capped' && alloc.perVenue.size > opts.maxVenues) {
            const keep = new Set([...alloc.perVenue.entries()]
                .sort((a, b) => b[1].amount - a[1].amount).slice(0, opts.maxVenues).map(([e]) => e));
            let capped = allocate(buildBook(cache, fees, hop, opts, keep), target, byBase);
            // Feasibility repair: top-N-by-volume favours venues that were cheap at the top, not
            // deep ones, so it can select a set that cannot fill at all.
            const filled = byBase ? capped.baseFilled : capped.quoteSpent;
            if (filled < target - 1e-9) {
                const depth = new Map<string, number>();
                for (const l of buildBook(cache, fees, hop, opts)) {
                    depth.set(l.exchangeId, (depth.get(l.exchangeId) ?? 0) + l.amount);
                }
                const deepest = new Set([...depth.entries()]
                    .sort((a, b) => b[1] - a[1]).slice(0, opts.maxVenues).map(([e]) => e));
                const repaired = allocate(buildBook(cache, fees, hop, opts, deepest), target, byBase);
                if ((byBase ? repaired.baseFilled : repaired.quoteSpent) > filled) capped = repaired;
            }
            alloc = capped;
        }

        if (opts.minLegNotional > 0) {
            const dust = new Set([...alloc.perVenue.entries()]
                .filter(([, v]) => v.effNotional < opts.minLegNotional).map(([e]) => e));
            if (dust.size > 0 && dust.size < alloc.perVenue.size) {
                const keep = new Set([...alloc.perVenue.keys()].filter((e) => !dust.has(e)));
                alloc = allocate(buildBook(cache, fees, hop, opts, keep), target, byBase);
            }
        }
    }

    const achieved = byBase ? alloc.baseFilled : alloc.quoteSpent;
    if (opts.requireFullFill && achieved < target - 1e-9) {
        alloc = { perVenue: new Map(), baseFilled: 0, quoteSpent: 0 };
    }

    const legs = toLegs(alloc, hop.side);
    const amountIn = hop.side === 'buy' ? alloc.quoteSpent : alloc.baseFilled;
    const amountOut = hop.side === 'buy' ? alloc.baseFilled : alloc.quoteSpent;

    return {
        hop: {
            pair: hop.pair, side: hop.side, base: hop.base, quote: hop.quote,
            amountIn, amountOut, legs,
            feeCost: legs.reduce((s, l) => s + l.feeCost, 0),
            // Taker fees are charged in the quote currency on both sides here.
            feeCurrency: hop.quote,
            fullyFillable: (byBase ? alloc.baseFilled : alloc.quoteSpent) >= target - 1e-9,
            quotes,
            freshVenueCount: fresh.length,
        },
        bestSingleEffective: bestSingle?.effectivePriceWithFee ?? null,
    };
}
