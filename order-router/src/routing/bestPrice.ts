import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { BookLevel, RoutingQuote, RoutingResult } from '../types.js';

// Walks book levels to fill `amount`, returns the volume-weighted average
// price actually achievable and whether the book had enough depth to fill it.
function walkBook (levels: BookLevel[], amount: number): { averagePrice: number | undefined; filledAmount: number } {
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
    if (filled === 0) {
        return { averagePrice: undefined, filledAmount: 0 };
    }
    return { averagePrice: notional / filled, filledAmount: filled };
}

export function computeBestPrice (
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
    staleBookMs: number,
): RoutingResult {
    const books = cache.getBooksForSymbol(symbol);
    const now = Date.now();
    const quotes: RoutingQuote[] = [];

    for (const book of books) {
        const bookAgeMs = now - book.receivedAt;
        // A buy order gets filled by walking the ask side (you're paying the ask), and vice versa.
        const levels = side === 'buy' ? book.asks : book.bids;
        const { averagePrice, filledAmount } = walkBook(levels, amount);
        const takerFeeRate = feeRegistry.getFee(book.exchangeId, symbol);
        const effectivePriceWithFee = averagePrice === undefined
            ? undefined
            : side === 'buy'
                ? averagePrice * (1 + takerFeeRate)
                : averagePrice * (1 - takerFeeRate);

        quotes.push({
            exchangeId: book.exchangeId,
            side,
            requestedAmount: amount,
            filledAmount,
            averagePrice,
            effectivePriceWithFee,
            takerFeeRate,
            fullyFillable: filledAmount >= amount,
            bookAgeMs,
        });
    }

    // Prefer fully-fillable, fresh quotes; rank by effective price (lowest for buy, highest for sell).
    const usable = quotes.filter((q) => q.effectivePriceWithFee !== undefined && q.bookAgeMs <= staleBookMs);
    const ranked = usable.sort((a, b) => {
        if (a.fullyFillable !== b.fullyFillable) {
            return a.fullyFillable ? -1 : 1;
        }
        const aPrice = a.effectivePriceWithFee as number;
        const bPrice = b.effectivePriceWithFee as number;
        return side === 'buy' ? aPrice - bPrice : bPrice - aPrice;
    });

    return {
        symbol,
        side,
        amount,
        best: ranked[0],
        quotes,
    };
}
