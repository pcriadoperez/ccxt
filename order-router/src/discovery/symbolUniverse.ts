import ccxt, { Exchange } from 'ccxt';
import type { Logger } from 'pino';

export interface SymbolUniverse {
    // Only symbols tradable on >= minExchangesPerSymbol exchanges — the routable set.
    routableSymbolsByExchange: Map<string, string[]>;
    // Already-instantiated, already-loadMarkets()'d ccxt.pro instances, keyed by exchange id —
    // handed off to ExchangeConnector so it doesn't need a second loadMarkets() round trip.
    loadedExchanges: Map<string, Exchange>;
    exchangesFailed: Map<string, string>;
    totalUniqueSymbols: number;
    routableSymbolCount: number;
}

export interface RoutableSymbols {
    routableSymbolsByExchange: Map<string, string[]>;
    totalUniqueSymbols: number;
    routableSymbolCount: number;
}

async function runWithConcurrency<T, R> (
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    async function runner (): Promise<void> {
        while (next < items.length) {
            const idx = next++;
            results[idx] = await worker(items[idx] as T);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
    return results;
}

// Pure: given each exchange's already-loaded market symbol list, keeps only symbols that appear
// on >= minExchangesPerSymbol exchanges. A symbol on exactly one exchange has nothing to route
// between, so it's excluded from the routable set (though its exchange can still appear in the
// input — it just won't get any watch loops started for it). Split out from buildSymbolUniverse
// so this logic — the actual "what's worth subscribing to" decision — is unit-testable without a
// network call.
export function computeRoutableSymbols (
    marketsByExchange: Map<string, string[]>,
    minExchangesPerSymbol: number,
): RoutableSymbols {
    const exchangesBySymbol = new Map<string, Set<string>>();
    for (const [exchangeId, symbols] of marketsByExchange) {
        for (const symbol of symbols) {
            let set = exchangesBySymbol.get(symbol);
            if (!set) {
                set = new Set();
                exchangesBySymbol.set(symbol, set);
            }
            set.add(exchangeId);
        }
    }

    const routableSymbols = new Set<string>();
    for (const [symbol, exchangeSet] of exchangesBySymbol) {
        if (exchangeSet.size >= minExchangesPerSymbol) {
            routableSymbols.add(symbol);
        }
    }

    const routableSymbolsByExchange = new Map<string, string[]>();
    for (const [exchangeId, symbols] of marketsByExchange) {
        const routable = symbols.filter((s) => routableSymbols.has(s));
        if (routable.length > 0) {
            routableSymbolsByExchange.set(exchangeId, routable);
        }
    }

    return {
        routableSymbolsByExchange,
        totalUniqueSymbols: exchangesBySymbol.size,
        routableSymbolCount: routableSymbols.size,
    };
}

// Loads markets for every candidate exchange (bounded concurrency, tolerant of individual
// failures — one geo-blocked/rate-limited exchange doesn't abort discovery for the rest), then
// delegates to computeRoutableSymbols for the actual filtering decision.
export async function buildSymbolUniverse (
    exchangeIds: string[],
    minExchangesPerSymbol: number,
    concurrency: number,
    logger: Logger,
): Promise<SymbolUniverse> {
    const loadedExchanges = new Map<string, Exchange>();
    const marketsByExchange = new Map<string, string[]>();
    const exchangesFailed = new Map<string, string>();

    await runWithConcurrency(exchangeIds, concurrency, async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ExchangeClass = (ccxt.pro as any)[id];
        if (!ExchangeClass) {
            exchangesFailed.set(id, 'no ccxt.pro class for this id');
            return;
        }
        const exchange: Exchange = new ExchangeClass({ enableRateLimit: true });
        try {
            await exchange.loadMarkets();
            const symbols = Object.keys(exchange.markets ?? {});
            marketsByExchange.set(id, symbols);
            loadedExchanges.set(id, exchange);
            logger.info({ exchange: id, marketCount: symbols.length }, 'loaded markets');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            exchangesFailed.set(id, message);
            logger.warn({ exchange: id, err: message }, 'loadMarkets failed during discovery, skipping');
        }
    });

    const routable = computeRoutableSymbols(marketsByExchange, minExchangesPerSymbol);

    return {
        ...routable,
        loadedExchanges,
        exchangesFailed,
    };
}
