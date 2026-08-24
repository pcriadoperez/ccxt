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
//
// Also emits generic 'book' and 'health' events (not scoped to one symbol) —
// used only by a shard worker (see src/sharding/) to relay writes to the
// parent process's cache over IPC. A non-sharded instance has no listeners
// on these and pays nothing for them.
export class OrderBookCache extends EventEmitter {
    private books = new Map<string, CachedOrderBook>();
    // Secondary index symbol -> exchangeId -> book. Routing asks "every venue quoting this
    // symbol" many times per request, and answering that by scanning the whole book map is
    // O(total books) each time — at full discovery scale (~42k books) that dominated route
    // latency entirely. The index makes the lookup proportional to the number of venues on that
    // one symbol instead. Writes stay O(1); the extra memory is one Map per symbol holding
    // references to books already stored.
    private bySymbol = new Map<string, Map<string, CachedOrderBook>>();
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
        let venues = this.bySymbol.get(book.symbol);
        if (venues === undefined) {
            venues = new Map();
            this.bySymbol.set(book.symbol, venues);
        }
        venues.set(book.exchangeId, book);
        this.emit(`update:${book.symbol}`);
        this.emit('book', book);
    }

    getBook (exchangeId: string, symbol: string): CachedOrderBook | undefined {
        return this.books.get(this.key(exchangeId, symbol));
    }

    getBooksForSymbol (symbol: string): CachedOrderBook[] {
        const venues = this.bySymbol.get(symbol);
        return venues === undefined ? [] : Array.from(venues.values());
    }

    // Whether ANY venue quotes this symbol. Routing resolves an asset pair to a market by asking
    // this two to four times per request, so it must not materialise the symbol list to answer.
    hasSymbol (symbol: string): boolean {
        return this.bySymbol.has(symbol);
    }

    listSymbols (): string[] {
        return Array.from(this.bySymbol.keys());
    }

    getBookCount (): number {
        return this.books.size;
    }

    // Books too old to be used for ranking. Uses receivedAt rather than the exchange-supplied
    // timestamp deliberately: exchange clocks drift and some venues omit the field entirely, so
    // local arrival time is the only measure that is consistently present and monotonic here.
    countStaleBooks (staleBookMs: number): number {
        const cutoff = Date.now() - staleBookMs;
        let stale = 0;
        for (const book of this.books.values()) {
            if (book.receivedAt < cutoff) {
                stale += 1;
            }
        }
        return stale;
    }

    initHealth (exchangeId: string): void {
        const h: ExchangeHealth = {
            exchangeId,
            connected: false,
            lastUpdateAt: undefined,
            updateCount: 0,
            reconnectCount: 0,
            lastError: undefined,
            crossedCount: 0,
            lastResyncAt: undefined,
        };
        this.health.set(exchangeId, h);
        this.emit('health', h);
    }

    // Overwrites a health record wholesale — used by the parent process in sharded mode to mirror
    // a shard worker's already-computed health state, rather than recomputing counters locally.
    setHealth (health: ExchangeHealth): void {
        this.health.set(health.exchangeId, health);
    }

    recordUpdate (exchangeId: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        const wasDisconnected = !h.connected;
        h.connected = true;
        h.lastUpdateAt = Date.now();
        h.updateCount += 1;
        h.lastError = undefined;
        // Deliberately not emitted on every call: this runs once per book update, which can be
        // hundreds/sec for a busy symbol — a shard worker instead flushes health snapshots on a
        // slow timer (see src/sharding/shardWorker.ts) rather than doubling IPC traffic with a
        // 'health' event per 'book' event. Reconnect transitions are still emitted immediately.
        if (wasDisconnected) {
            this.emit('health', h);
        }
    }

    recordError (exchangeId: string, message: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.connected = false;
        h.lastError = message;
        this.emit('health', h);
    }

    // A crossed book is corrupt rather than merely stale, so it is counted separately: staleness
    // is expected and self-correcting, corruption is neither and needs a resync to clear.
    recordCrossed (exchangeId: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.crossedCount += 1;
        this.emit('health', h);
    }

    recordResync (exchangeId: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.lastResyncAt = Date.now();
        this.emit('health', h);
    }

    recordReconnect (exchangeId: string): void {
        const h = this.health.get(exchangeId);
        if (!h) return;
        h.reconnectCount += 1;
        this.emit('health', h);
    }

    getHealth (): ExchangeHealth[] {
        return Array.from(this.health.values());
    }
}
