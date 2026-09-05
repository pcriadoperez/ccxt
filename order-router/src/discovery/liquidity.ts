import ccxt from 'ccxt';
import type { Logger } from 'pino';

// Ranks symbols by real traded volume rather than by how many venues list them. Those are very
// different things: an obscure token can be listed on 20 exchanges and trade nothing, while the
// pairs that actually matter for routing are a short head. Volume comes from reference venues via
// fetchTickers, which is one REST call per venue rather than per symbol.
export interface LiquidityRanking {
    ranked: string[];
    // How many reference venues actually produced volume data. Zero means `ranked` is the input
    // order wearing a ranking's name — see isUsableRanking.
    referencesSucceeded: number;
    referencesAttempted: number;
}

// Symbols with no volume data sort last but are NOT dropped: a symbol the reference exchanges do
// not list should fall to the tail, not vanish outright. Pure, so the ordering is testable without
// a network call.
export function rankByVolume (candidates: string[], volume: Map<string, number>): string[] {
    return [...candidates].sort((a, b) => (volume.get(b) ?? 0) - (volume.get(a) ?? 0));
}

// With no reference venue behind it, the sort above is a no-op and the "most liquid" head is
// whatever order discovery happened to enumerate. Discovery runs ONCE, at boot, so accepting that
// silently pins the router to a junk symbol universe for the entire process lifetime — on the
// strength of one transient network blip — while logging that it trimmed to the most-liquid
// symbols. The caller must treat this as a boot failure, not a warning.
export function isUsableRanking (ranking: { referencesSucceeded: number; referencesAttempted: number }): boolean {
    return ranking.referencesSucceeded > 0;
}

export async function rankSymbolsByLiquidity (
    candidates: string[],
    referenceExchanges: string[],
    logger: Logger,
): Promise<LiquidityRanking> {
    const candidateSet = new Set(candidates);
    const volume = new Map<string, number>();
    let referencesSucceeded = 0;

    for (const id of referenceExchanges) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ExchangeClass = (ccxt as any)[id];
        if (!ExchangeClass) continue;
        const exchange = new ExchangeClass({ enableRateLimit: true });
        try {
            await exchange.loadMarkets();
            const tickers = await exchange.fetchTickers();
            for (const [symbol, t] of Object.entries(tickers)) {
                if (!candidateSet.has(symbol)) continue;
                // quoteVolume is directly comparable across symbols (it is denominated in the
                // quote currency); baseVolume is not, since 1 BTC != 1 DOGE.
                const qv = (t as { quoteVolume?: number }).quoteVolume;
                if (typeof qv === 'number' && Number.isFinite(qv) && qv > 0) {
                    volume.set(symbol, (volume.get(symbol) ?? 0) + qv);
                }
            }
            referencesSucceeded += 1;
            logger.info({ exchange: id, ranked: volume.size }, 'liquidity reference loaded');
        } catch (err) {
            logger.warn({ exchange: id, err: String(err) }, 'liquidity reference failed, continuing');
        } finally {
            try { await exchange.close(); } catch { /* best effort */ }
        }
    }

    return { ranked: rankByVolume(candidates, volume), referencesSucceeded, referencesAttempted: referenceExchanges.length };
}
