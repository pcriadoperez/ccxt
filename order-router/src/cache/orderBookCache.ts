import type { CachedOrderBook, ExchangeHealth } from '../types.js';

// In-process hot-path cache. Reads are plain Map lookups (no network hop) —
// this is deliberate: a single router instance should never touch Redis on
// the read path. See order-router/README.md for the multi-instance story.
export class OrderBookCache {
    private books = new Map<string, CachedOrderBook>();
    private health = new Map<string, ExchangeHealth>();

    private key (exchangeId: string, symbol: string): string {
        return `${exchangeId}:${symbol}`;
    }

    setBook (book: CachedOrderBook): void {
        this.books.set(this.key(book.exchangeId, book.symbol), book);
    }

    getBook (exchangeId: string, symbol: string): CachedOrderBook | undefined {
        return this.books.get(this.key(exchangeId, symbol));
    }

    getBooksForSymbol (symbol: string): CachedOrderBook[] {
        const result: CachedOrderBook[] = [];
        for (const book of this.books.values()) {
            if (book.symbol === symbol) {
                result.push(book);
            }
        }
        return result;
    }

    listSymbols (): string[] {
        const symbols = new Set<string>();
        for (const book of this.books.values()) {
            symbols.add(book.symbol);
        }
        return Array.from(symbols);
    }

    initHealth (exchangeId: string): void {
        this.health.set(exchangeId, {
            exchangeId,
            connected: false,
            lastUpdateAt: undefined,
            updateCount: 0,
            reconnectCount: 0,
            lastError: undefined,
        });
    }

    recordUpdate (exchangeId: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.connected = true;
        h.lastUpdateAt = Date.now();
        h.updateCount += 1;
        h.lastError = undefined;
    }

    recordError (exchangeId: string, message: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.connected = false;
        h.lastError = message;
    }

    recordReconnect (exchangeId: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.reconnectCount += 1;
    }

    getHealth (): ExchangeHealth[] {
        return Array.from(this.health.values());
    }
}
