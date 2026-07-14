import { EventEmitter } from 'node:events';
import type { CachedOrderBook, ExchangeHealth } from '../types.js';

// In-process hot-path cache. Reads are plain Map lookups (no network hop) —
// this is deliberate: a single router instance should never touch Redis on
// the read path. See order-router/README.md for the multi-instance story.
//
// Emits 'update:<symbol>' whenever a book for that symbol changes, so
// consumers (e.g. the WS stream endpoint) can push on change instead of
// polling — polling on a fixed interval per connected client wastes CPU
// proportional to (poll rate x client count) regardless of whether anything
// changed, which matters once WS message/client volume is large.
export class OrderBookCache extends EventEmitter {
    private books = new Map<string, CachedOrderBook>();
    private health = new Map<string, ExchangeHealth>();

    constructor () {
        super();
        // Each 'update:<symbol>' event can have many WS stream subscribers;
        // Node's default cap of 10 listeners/event is for leak detection on
        // typical emitters, not applicable here.
        this.setMaxListeners(0);
    }

    private key (exchangeId: string, symbol: string): string {
        return `${exchangeId}:${symbol}`;
    }

    setBook (book: CachedOrderBook): void {
        this.books.set(this.key(book.exchangeId, book.symbol), book);
        this.emit(`update:${book.symbol}`);
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
