import type { OrderBookCache } from '../cache/orderBookCache.js';

export interface ResolvedHop {
    pair: string;
    base: string;
    quote: string;
    side: 'buy' | 'sell';
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

// Two-hop fallback through a bridge asset, for pairs no venue lists directly (SOL -> BTC is
// usually SOL -> USDT -> BTC). Candidates are ordered by how commonly they are quoted, and the
// first bridge with BOTH legs available wins — a cheapest-bridge search would require solving
// every candidate route, which is not worth it when the list is this short and USDT dominates.
export function resolveBridgedHops (
    cache: OrderBookCache,
    from: string,
    to: string,
    bridges: string[],
): ResolvedHop[] | null {
    for (const bridge of bridges) {
        if (bridge === from || bridge === to) continue;
        const first = resolveDirectHop(cache, from, bridge);
        const second = resolveDirectHop(cache, bridge, to);
        if (first && second) return [first, second];
    }
    return null;
}

// Ordered by liquidity: a bridge earlier in the list is tried first, so an exotic pair routes
// through the deepest available intermediary rather than whichever one happens to exist.
export const DEFAULT_BRIDGES = ['USDT', 'USDC', 'BTC', 'ETH'];
