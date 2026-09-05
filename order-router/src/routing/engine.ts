import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { RoutingQuote } from '../types.js';
import { isCertified } from '../exchangeMeta.js';
import type { RouteLeg, RouteOptions, RouteHop } from './types.js';
import { budgetFor, cloneBudgets, drawBudget, type HopBudgets } from './balances.js';
import type { ResolvedHop } from './market.js';

interface ConsolidatedLevel {
    exchangeId: string;
    rawPrice: number;
    effectivePrice: number;
    takerFeeRate: number;
    amount: number;
}

interface VenueBook {
    exchangeId: string;
    takerFeeRate: number;
    bookAgeMs: number;
    fresh: boolean;
    // Best-first for this venue. Source books arrive sorted (bids descending, asks ascending) and
    // both the fee and the staleness penalty are constant positive factors per venue, so the
    // transform preserves that order — no per-venue re-sort is needed.
    levels: ConsolidatedLevel[];
}

// Per-request memo. Every solve inside one computeRoute call shares the same options and the same
// instant, so a pair's fee-adjusted books and its consolidated merge are identical every time they
// are asked for — and they get asked for repeatedly once candidate paths are compared and the
// winner is re-solved for its diagnostics. Rebuilding them each time was the dominant cost.
// Sharing one snapshot also means every hop sees the same instant, so staleness cannot shift
// mid-request.
export interface SolveCache {
    venues: Map<string, VenueBook[]>;
    merged: Map<string, ConsolidatedLevel[]>;
}

export function createSolveCache (): SolveCache {
    return { venues: new Map(), merged: new Map() };
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

// Fee- and staleness-adjusts every level of every venue quoting this pair, ONCE. Everything
// downstream (the consolidated walk, each per-venue quote, every re-solve for a capped or
// dust-filtered venue subset) reads these arrays instead of rebuilding from the cache. Rebuilding
// per venue made the hop cost quadratic in venue count for no gain.
function buildVenueBooks (
    cache: OrderBookCache, fees: FeeRegistry, hop: ResolvedHop, opts: RouteOptions,
): VenueBook[] {
    const now = Date.now();
    const out: VenueBook[] = [];
    for (const book of cache.getBooksForSymbol(hop.pair)) {
        if (!isVenueAllowed(book.exchangeId, opts)) continue;
        const bookAgeMs = now - book.receivedAt;
        const takerFeeRate = opts.includeFees ? fees.getFee(book.exchangeId, hop.pair) : 0;
        const stale = stalenessPenaltyFraction(bookAgeMs, opts.stalenessPenaltyBps);
        const source = hop.side === 'buy' ? book.asks : book.bids;
        const levels: ConsolidatedLevel[] = new Array(source.length);
        for (let i = 0; i < source.length; i++) {
            const lvl = source[i]!;
            const feeAdj = hop.side === 'buy'
                ? lvl.price * (1 + takerFeeRate)
                : lvl.price * (1 - takerFeeRate);
            levels[i] = {
                exchangeId: book.exchangeId,
                rawPrice: lvl.price,
                effectivePrice: hop.side === 'buy' ? feeAdj * (1 + stale) : feeAdj * (1 - stale),
                takerFeeRate,
                amount: lvl.amount,
            };
        }
        out.push({
            exchangeId: book.exchangeId,
            takerFeeRate,
            bookAgeMs,
            fresh: bookAgeMs <= opts.staleBookMs,
            levels,
        });
    }
    return out;
}

// Merges the fresh venues (optionally restricted to `allow`) into one price-ordered book. Because
// each level was fee-adjusted BEFORE the merge, a greedy walk down this list is cost-minimal
// rather than a heuristic — that is the whole mechanic behind split routing.
function mergeFresh (venues: VenueBook[], side: 'buy' | 'sell', allow?: Set<string>): ConsolidatedLevel[] {
    const levels: ConsolidatedLevel[] = [];
    for (const v of venues) {
        if (!v.fresh) continue;
        if (allow && !allow.has(v.exchangeId)) continue;
        for (const lvl of v.levels) levels.push(lvl);
    }
    levels.sort((a, b) => (side === 'buy' ? a.effectivePrice - b.effectivePrice : b.effectivePrice - a.effectivePrice));
    return levels;
}

interface Allocation {
    perVenue: Map<string, {
        amount: number; rawNotional: number; effNotional: number; feeCost: number; fee: number;
        // The walk stopped short at this venue because the budget ran out, not because the book
        // did. The two look identical in the numbers and need different follow-up.
        budgetLimited: boolean;
    }>;
    baseFilled: number;
    quoteSpent: number;
}

const EMPTY_ALLOCATION = (): Allocation => ({ perVenue: new Map(), baseFilled: 0, quoteSpent: 0 });

// `target` is interpreted in BASE units when byBase, else in QUOTE units. Exact-in on a buy
// ("spend 50k USDT") is a notional walk, which is a genuinely different traversal from the
// quantity walk — you stop when the money runs out, not when the size is reached.
//
// `budgets` is what the caller can actually fund at each venue, in this hop's SPEND asset. It is
// drawn down here, level by level, rather than trimmed off the finished allocation: the greedy is
// cost-minimal only because it walks a price-ordered list, and a capacitated greedy over that same
// list keeps that structure, while cutting the result afterwards would take the size off whichever
// venue happened to be last rather than off the dearest levels. The budget is MUTATED, so every
// pass hands in its own clone.
function allocate (
    levels: ConsolidatedLevel[], target: number, byBase: boolean, budgets: HopBudgets | null = null,
): Allocation {
    const perVenue: Allocation['perVenue'] = new Map();
    // Venues the WALLET cut short, collected separately from the entries above. A budget that runs
    // out exactly on a level boundary leaves nothing to take at the venue's next level, so a flag
    // set only while something is still being taken never fires — and the executor is told
    // "depth-capped" about a leg that was purely wallet-capped.
    const budgetLimited = new Set<string>();
    let baseFilled = 0;
    let quoteSpent = 0;
    let remaining = target;
    for (const lvl of levels) {
        if (remaining <= 1e-15) break;
        const wanted = byBase
            ? Math.min(remaining, lvl.amount)
            : Math.min(remaining / lvl.effectivePrice, lvl.amount);
        // Capacity, not set membership: a venue the caller is only partly funded on still supplies
        // its cheap levels, up to what the wallet covers. The spend is measured in effectivePrice
        // terms because that is what the hop reports as amountIn — a budget checked against the raw
        // price would permit a route the response then prices above it.
        const capInBase = budgets === null
            ? Infinity
            : (budgets.spendIsBase
                ? budgetFor(budgets, lvl.exchangeId)
                : budgetFor(budgets, lvl.exchangeId) / lvl.effectivePrice);
        const takeBase = Math.min(wanted, capInBase);
        // Recorded BEFORE the zero-take bail-out below, which is the level the exhausted budget
        // actually shows up on.
        if (budgets !== null && capInBase < wanted) budgetLimited.add(lvl.exchangeId);
        if (takeBase <= 0) continue;
        const eff = takeBase * lvl.effectivePrice;
        const raw = takeBase * lvl.rawPrice;
        const e = perVenue.get(lvl.exchangeId)
            ?? { amount: 0, rawNotional: 0, effNotional: 0, feeCost: 0, fee: lvl.takerFeeRate, budgetLimited: false };
        if (budgets !== null) drawBudget(budgets, lvl.exchangeId, budgets.spendIsBase ? takeBase : eff);
        e.amount += takeBase;
        e.rawNotional += raw;
        e.effNotional += eff;
        e.feeCost += Math.abs(eff - raw);
        perVenue.set(lvl.exchangeId, e);
        baseFilled += takeBase;
        quoteSpent += eff;
        remaining -= byBase ? takeBase : eff;
    }
    for (const [exchangeId, e] of perVenue) e.budgetLimited = budgetLimited.has(exchangeId);
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
            balanceLimited: v.budgetLimited,
        });
    }
    return legs.sort((a, b) => b.amount - a.amount);
}

// The price an infinitesimally small order would get: the best fee- and staleness-adjusted level
// across every fresh, allowed venue. This is the frictionless benchmark price impact is measured
// against — not the chosen venue's own top of book, which would understate impact whenever the
// route had to reach past a cheaper but shallower venue.
function bestTopOfBook (venues: VenueBook[], side: 'buy' | 'sell'): number | null {
    let best: number | null = null;
    for (const v of venues) {
        if (!v.fresh || v.levels.length === 0) continue;
        const top = v.levels[0]!.effectivePrice;
        if (best === null) best = top;
        else if (side === 'buy' ? top < best : top > best) best = top;
    }
    return best;
}

export interface HopSolution {
    hop: RouteHop;
    bestSingleEffective: number | null;
}

export interface SolveHopOptions {
    // Per-venue diagnostic quotes. Skipped while comparing candidate paths, where only the
    // end-to-end output of each path matters and the losing paths are never reported in full.
    collectQuotes: boolean;
    // What the caller can fund at each venue for this hop, or null/absent when unconstrained.
    // Treated as immutable input here: every allocate() pass below draws down its OWN clone,
    // because the passes are alternative plans for the same money, not successive spends of it.
    budgets?: HopBudgets | null;
}

// Whether the per-venue pass has to run at all. It is what produces quotes[] and the best-single
// baseline, so it is unavoidable when either is wanted — but a split strategy comparing candidate
// paths needs neither, and that pass is the most expensive part of a hop.
function needsPerVenuePass (opts: RouteOptions, solveOpts: SolveHopOptions): boolean {
    return solveOpts.collectQuotes || opts.strategy === 'best_single';
}

interface SingleVenueSolve {
    filled: number;
    effective: number;
    fullyFillable: boolean;
}

// Ranks two single-venue solves for best_single. Fill first, price second — rate is meaningless on
// size you cannot get. `rankByFilled` generalises that first criterion from a flag to a comparison
// and is on ONLY when a wallet is in play: budgets can make EVERY venue capacity-bound at once, the
// flag then reads false everywhere, and the choice fell through to price — handing the whole order
// to the cheap venue holding 10 USDT while the one holding 900 sat unused. Unconstrained the flag
// still decides on its own, so those requests rank exactly as they always did.
function betterSingle (
    candidate: SingleVenueSolve, incumbent: SingleVenueSolve | undefined,
    side: 'buy' | 'sell', rankByFilled: boolean,
): boolean {
    if (incumbent === undefined) return true;
    if (candidate.fullyFillable !== incumbent.fullyFillable) return candidate.fullyFillable;
    if (rankByFilled) {
        // Relative, so two venues that filled the same size down to float noise are still settled
        // on price rather than on which of them the cache happened to list first.
        const scale = Math.max(candidate.filled, incumbent.filled);
        if (Math.abs(candidate.filled - incumbent.filled) > scale * 1e-12) {
            return candidate.filled > incumbent.filled;
        }
    }
    return side === 'buy' ? candidate.effective < incumbent.effective : candidate.effective > incumbent.effective;
}

// Solves ONE hop. `target` is in base units when byBase, else quote units.
export function solveHop (
    cache: OrderBookCache, fees: FeeRegistry, hop: ResolvedHop,
    target: number, byBase: boolean, opts: RouteOptions,
    solveOpts: SolveHopOptions = { collectQuotes: true },
    memo: SolveCache = createSolveCache(),
): HopSolution {
    // Keyed by pair AND side. Today candidatePaths can never reach one pair from both directions
    // (each hop covers a distinct pair of assets), so pair alone would be correct — but that is an
    // emergent property of how paths are built, not a local one, and it would break silently and
    // expensively the moment a longer or cyclic path type is added. The side costs nothing to key on.
    const memoKey = `${hop.pair}:${hop.side}`;
    let venues = memo.venues.get(memoKey);
    if (venues === undefined) {
        venues = buildVenueBooks(cache, fees, hop, opts);
        memo.venues.set(memoKey, venues);
    }
    // Only the unrestricted merge is memoised: the restricted ones vary per strategy pass, and
    // each is walked once.
    const mergedAll = (): ConsolidatedLevel[] => {
        let m = memo.merged.get(memoKey);
        if (m === undefined) {
            m = mergeFresh(venues!, hop.side);
            memo.merged.set(memoKey, m);
        }
        return m;
    };

    // The pristine wallet for this hop. Never spent from directly — every pass below draws down a
    // clone, because they are alternative plans for the same money.
    const budgets = solveOpts.budgets ?? null;
    // Both counted over the BOOKS rather than over what they happened to fill. freshVenueCount was
    // the same number as "venues that filled something" while every fresh book with levels filled
    // SOMETHING of a positive target — then a budget of zero, or a target clamped to zero by an
    // empty wallet, made a perfectly fresh venue fill nothing, and a counter whose job is to say
    // "every book was stale" started saying it about books that were not.
    let freshVenueCount = 0;
    // A THIRD bucket beside venueCount and freshVenueCount: an unfunded venue was neither filtered
    // out nor stale, so folding it into either would make that one lie. Read off the untouched
    // budget, so it reports the wallet rather than whatever the last allocation left behind — and
    // counted over the SAME venues freshVenueCount is, because a stale venue, or one quoting only
    // the other side, is not capacity the wallet failed to reach. Counting those as funded made
    // "every venue that could have traded was unfunded" unreachable in the two commonest shapes
    // there are, and the router went on blaming the market for the caller's wallet.
    let fundedVenueCount = 0;
    for (const v of venues) {
        if (!v.fresh || v.levels.length === 0) continue;
        freshVenueCount += 1;
        if (budgets === null || budgetFor(budgets, v.exchangeId) > 0) fundedVenueCount += 1;
    }

    const quotes: RoutingQuote[] = [];
    let bestSingle: SingleVenueSolve & { exchangeId: string } | undefined;
    // Per-venue solve: needed for the best_single strategy and for savingVsBestSingleBps, so it
    // runs whether or not the quotes array is ultimately reported — but not when neither is
    // wanted, which is the case for every losing candidate in a path comparison.
    const perVenue = needsPerVenuePass(opts, solveOpts);
    for (const v of (perVenue ? venues : [])) {
        // Each venue's own clone: this pass asks "what would this venue alone do?" of every venue,
        // and sharing one budget would let the first one answered spend the wallet for the rest.
        const single = allocate(v.levels, target, byBase, cloneBudgets(budgets));
        if (single.baseFilled <= 0) {
            if (solveOpts.collectQuotes) {
                quotes.push({
                    exchangeId: v.exchangeId, side: hop.side, requestedAmount: target,
                    filledAmount: 0, averagePrice: undefined, effectivePriceWithFee: undefined,
                    takerFeeRate: v.takerFeeRate, fullyFillable: false, bookAgeMs: v.bookAgeMs,
                });
            }
            continue;
        }
        const venueTotals = single.perVenue.get(v.exchangeId)!;
        // averagePrice must stay RAW and effectivePriceWithFee adjusted — reporting the adjusted
        // number as both would hide the fee from anyone comparing the two, which is the whole
        // point of showing them side by side.
        const rawAvg = venueTotals.rawNotional / single.baseFilled;
        const effAvg = single.quoteSpent / single.baseFilled;
        const fullyFillable = byBase
            ? single.baseFilled >= target - 1e-12
            : single.quoteSpent >= target - 1e-9;
        if (solveOpts.collectQuotes) {
            quotes.push({
                exchangeId: v.exchangeId, side: hop.side, requestedAmount: target,
                filledAmount: single.baseFilled, averagePrice: rawAvg, effectivePriceWithFee: effAvg,
                takerFeeRate: v.takerFeeRate, fullyFillable, bookAgeMs: v.bookAgeMs,
            });
        }
        if (!v.fresh) continue;
        const filled = byBase ? single.baseFilled : single.quoteSpent;
        if (betterSingle({ filled, effective: effAvg, fullyFillable }, bestSingle, hop.side, budgets !== null)) {
            bestSingle = { exchangeId: v.exchangeId, effective: effAvg, fullyFillable, filled };
        }
    }

    let alloc: Allocation;
    if (opts.strategy === 'best_single') {
        alloc = bestSingle
            ? allocate(mergeFresh(venues, hop.side, new Set([bestSingle.exchangeId])), target, byBase,
                cloneBudgets(budgets))
            : EMPTY_ALLOCATION();
    } else {
        alloc = allocate(mergedAll(), target, byBase, cloneBudgets(budgets));

        if (opts.strategy === 'split_capped' && alloc.perVenue.size > opts.maxVenues) {
            const keep = new Set([...alloc.perVenue.entries()]
                .sort((a, b) => b[1].amount - a[1].amount).slice(0, opts.maxVenues).map(([e]) => e));
            let capped = allocate(mergeFresh(venues, hop.side, keep), target, byBase, cloneBudgets(budgets));
            // Feasibility repair: top-N-by-volume favours venues that were cheap at the top, not
            // deep ones, so it can select a set that cannot fill at all.
            const filled = byBase ? capped.baseFilled : capped.quoteSpent;
            if (filled < target - 1e-9) {
                const depth = new Map<string, number>();
                for (const v of venues) {
                    if (!v.fresh) continue;
                    let total = 0;
                    for (const lvl of v.levels) total += lvl.amount;
                    depth.set(v.exchangeId, total);
                }
                const deepest = new Set([...depth.entries()]
                    .sort((a, b) => b[1] - a[1]).slice(0, opts.maxVenues).map(([e]) => e));
                const repaired = allocate(mergeFresh(venues, hop.side, deepest), target, byBase,
                    cloneBudgets(budgets));
                if ((byBase ? repaired.baseFilled : repaired.quoteSpent) > filled) capped = repaired;
            }
            alloc = capped;
        }

        if (opts.minLegNotional > 0) {
            const dust = new Set([...alloc.perVenue.entries()]
                .filter(([, v]) => v.effNotional < opts.minLegNotional).map(([e]) => e));
            if (dust.size > 0 && dust.size < alloc.perVenue.size) {
                const keep = new Set([...alloc.perVenue.keys()].filter((e) => !dust.has(e)));
                const redone = allocate(mergeFresh(venues, hop.side, keep), target, byBase, cloneBudgets(budgets));
                // The re-solve is single-pass and assumes the freed size is always absorbable
                // somewhere else. That stops being true once venues are capacity-bound: the
                // survivors may have the depth but not the funding, and then dropping a dust leg
                // SHRINKS the route instead of redistributing it. Keep the better of the two —
                // but ONLY where a budget could have caused it. minLegNotional is a hard floor the
                // caller set because their venues reject smaller orders, and applying this guard
                // unconditionally turned it into a suggestion: a survivor that merely lacked DEPTH
                // also shrinks the re-solve, and the dust leg came back on requests that sent no
                // balances at all — reported as a full fill, with a leg the venue will bounce.
                const before = byBase ? alloc.baseFilled : alloc.quoteSpent;
                const after = byBase ? redone.baseFilled : redone.quoteSpent;
                if (budgets === null || after >= before - Math.abs(before) * 1e-12) alloc = redone;
            }
        }
    }

    if (opts.requireFullFill && (byBase ? alloc.baseFilled : alloc.quoteSpent) < target - 1e-9) {
        alloc = EMPTY_ALLOCATION();
    }
    const achieved = byBase ? alloc.baseFilled : alloc.quoteSpent;

    const legs = toLegs(alloc, hop.side);
    const amountIn = hop.side === 'buy' ? alloc.quoteSpent : alloc.baseFilled;
    const amountOut = hop.side === 'buy' ? alloc.baseFilled : alloc.quoteSpent;

    // Price impact: how much worse the size actually executes than the frictionless benchmark.
    // Both sides of the comparison are fee- and staleness-adjusted, so what is left is purely the
    // cost of consuming depth. Positive always means worse, whichever way the trade runs.
    const referencePrice = bestTopOfBook(venues, hop.side);
    let impactBps: number | null = null;
    if (referencePrice !== null && referencePrice > 0 && alloc.baseFilled > 0) {
        const achievedPrice = alloc.quoteSpent / alloc.baseFilled;
        const diff = hop.side === 'buy' ? achievedPrice - referencePrice : referencePrice - achievedPrice;
        impactBps = (diff / referencePrice) * 10_000;
    }

    return {
        hop: {
            pair: hop.pair, side: hop.side, base: hop.base, quote: hop.quote,
            amountIn, amountOut, legs,
            feeCost: legs.reduce((s, l) => s + l.feeCost, 0),
            // Taker fees are charged in the quote currency on both sides here.
            feeCurrency: hop.quote,
            fullyFillable: achieved >= target - 1e-9,
            referencePrice, impactBps,
            quotes,
            venueCount: venues.length,
            freshVenueCount, fundedVenueCount,
        },
        bestSingleEffective: bestSingle?.effective ?? null,
    };
}
