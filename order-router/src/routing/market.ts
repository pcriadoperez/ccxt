import type { OrderBookCache } from '../cache/orderBookCache.js';

export interface ResolvedHop {
    pair: string;
    base: string;
    quote: string;
    side: 'buy' | 'sell';
}

export interface CandidatePath {
    hops: ResolvedHop[];
    // The intermediary asset, or null for a direct market.
    bridge: string | null;
}

// A pair is BASE/QUOTE. Buying the base means spending quote, and vice versa — so from/to fully
// determines the side, which is why the caller never supplies it. This is what makes symbol+side
// a special case of asset-to-asset addressing rather than a separate mode.
export function resolveDirectHop (cache: OrderBookCache, from: string, to: string): ResolvedHop | null {
    // Asks the cache directly rather than materialising the symbol list — at full discovery that
    // list is thousands of strings, and building it per request to answer two membership
    // questions was pure waste on the hot path.
    const buy = `${to}/${from}`;    // acquiring `to` by spending `from`
    if (cache.hasSymbol(buy)) {
        return { pair: buy, base: to, quote: from, side: 'buy' };
    }
    const sell = `${from}/${to}`;   // disposing of `from` to receive `to`
    if (cache.hasSymbol(sell)) {
        return { pair: sell, base: from, quote: to, side: 'sell' };
    }
    return null;
}

// Every way this conversion could be executed, direct first, then one two-hop route per bridge
// asset that has both legs listed. Enumerating rather than short-circuiting on the first match is
// what lets the router pick the cheapest path instead of the first one it happened to find:
// USDT is usually deepest, but not always, and a thin direct market can be worse than either.
export function candidatePaths (
    cache: OrderBookCache, from: string, to: string, bridges: string[],
): CandidatePath[] {
    const paths: CandidatePath[] = [];
    const direct = resolveDirectHop(cache, from, to);
    if (direct) paths.push({ hops: [direct], bridge: null });
    const seen = new Set<string>();
    for (const bridge of bridges) {
        if (bridge === from || bridge === to || seen.has(bridge)) continue;
        seen.add(bridge);
        const first = resolveDirectHop(cache, from, bridge);
        if (!first) continue;
        const second = resolveDirectHop(cache, bridge, to);
        if (!second) continue;
        paths.push({ hops: [first, second], bridge });
    }
    return paths;
}

// Every market any candidate path would touch — what a streaming subscription has to watch to
// know the answer may have changed.
export function candidatePairs (
    cache: OrderBookCache, from: string, to: string, bridges: string[],
): string[] {
    const pairs = new Set<string>();
    for (const path of candidatePaths(cache, from, to, bridges)) {
        for (const hop of path.hops) pairs.add(hop.pair);
    }
    return Array.from(pairs);
}

// Ordered by how commonly each asset is quoted, so ties and equal-quality paths resolve toward
// the deeper, more liquid intermediary.
export const DEFAULT_BRIDGES = ['USDT', 'USDC', 'BTC', 'ETH'];
