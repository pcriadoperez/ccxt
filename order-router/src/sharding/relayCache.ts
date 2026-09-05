import { OrderBookCache } from '../cache/orderBookCache.js';
import type { CachedOrderBook } from '../types.js';

// The cache a shard worker uses. A shard is a WRITE path only: it forwards every book to the
// parent over IPC and never reads one back — the API server lives in the parent and answers from
// the parent's cache. Storing them here as well meant a full second copy of every book the shard
// owns (two maps, `books` and `bySymbol`), retained for the life of the process, inside the one
// process that runs under a hard `--max-old-space-size` ceiling. That is the memory a shard is
// most likely to die of and the memory nothing ever reads.
//
// Health is deliberately still retained: it is one small record per exchange, and the shard reads
// it back every flush interval to send the parent a snapshot.
export class RelayOrderBookCache extends OrderBookCache {
    override setBook (book: CachedOrderBook): void {
        // Same two events the base class emits, in the same order — the shard's relay and any
        // per-symbol subscriber see no difference. Only the retention is dropped.
        this.emit(`update:${book.symbol}`);
        this.emit('book', book);
    }
}
