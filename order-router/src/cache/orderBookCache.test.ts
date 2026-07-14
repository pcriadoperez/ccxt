import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from './orderBookCache.js';
import type { CachedOrderBook } from '../types.js';

function book (exchangeId: string, symbol: string): CachedOrderBook {
    return {
        exchangeId,
        symbol,
        bids: [{ price: 1, amount: 1 }],
        asks: [{ price: 2, amount: 1 }],
        exchangeTimestamp: Date.now(),
        receivedAt: Date.now(),
        sequence: 1,
    };
}

test('getBook returns undefined until a book is set, then returns it', () => {
    const cache = new OrderBookCache();
    assert.equal(cache.getBook('kraken', 'BTC/USDT'), undefined);
    const b = book('kraken', 'BTC/USDT');
    cache.setBook(b);
    assert.deepEqual(cache.getBook('kraken', 'BTC/USDT'), b);
});

test('getBooksForSymbol returns only books for that symbol, across exchanges', () => {
    const cache = new OrderBookCache();
    cache.setBook(book('kraken', 'BTC/USDT'));
    cache.setBook(book('coinbase', 'BTC/USDT'));
    cache.setBook(book('kraken', 'ETH/USDT'));

    const result = cache.getBooksForSymbol('BTC/USDT');
    assert.equal(result.length, 2);
    assert.deepEqual(new Set(result.map((b) => b.exchangeId)), new Set(['kraken', 'coinbase']));
});

test('listSymbols de-duplicates symbols across exchanges', () => {
    const cache = new OrderBookCache();
    cache.setBook(book('kraken', 'BTC/USDT'));
    cache.setBook(book('coinbase', 'BTC/USDT'));
    cache.setBook(book('kraken', 'ETH/USDT'));

    assert.deepEqual(new Set(cache.listSymbols()), new Set(['BTC/USDT', 'ETH/USDT']));
});

test('setBook emits a symbol-scoped update event and a generic book event', () => {
    const cache = new OrderBookCache();
    let symbolEventFired = false;
    let genericEventBook: CachedOrderBook | undefined;
    cache.on('update:BTC/USDT', () => { symbolEventFired = true; });
    cache.on('book', (b: CachedOrderBook) => { genericEventBook = b; });

    const b = book('kraken', 'BTC/USDT');
    cache.setBook(b);

    assert.equal(symbolEventFired, true);
    assert.deepEqual(genericEventBook, b);
});

test('setBook does not emit the wrong symbol-scoped event', () => {
    const cache = new OrderBookCache();
    let wrongEventFired = false;
    cache.on('update:ETH/USDT', () => { wrongEventFired = true; });

    cache.setBook(book('kraken', 'BTC/USDT'));

    assert.equal(wrongEventFired, false);
});

test('health lifecycle: init -> update -> error -> reconnect', () => {
    const cache = new OrderBookCache();
    cache.initHealth('kraken');
    let health = cache.getHealth().find((h) => h.exchangeId === 'kraken');
    assert.equal(health?.connected, false);
    assert.equal(health?.updateCount, 0);

    cache.recordUpdate('kraken');
    health = cache.getHealth().find((h) => h.exchangeId === 'kraken');
    assert.equal(health?.connected, true);
    assert.equal(health?.updateCount, 1);

    cache.recordError('kraken', 'boom');
    health = cache.getHealth().find((h) => h.exchangeId === 'kraken');
    assert.equal(health?.connected, false);
    assert.equal(health?.lastError, 'boom');

    cache.recordReconnect('kraken');
    health = cache.getHealth().find((h) => h.exchangeId === 'kraken');
    assert.equal(health?.reconnectCount, 1);
});

test('recordUpdate/recordError/recordReconnect on an unknown exchange is a silent no-op', () => {
    const cache = new OrderBookCache();
    // No initHealth() called — none of these should throw.
    assert.doesNotThrow(() => cache.recordUpdate('ghost'));
    assert.doesNotThrow(() => cache.recordError('ghost', 'x'));
    assert.doesNotThrow(() => cache.recordReconnect('ghost'));
    assert.equal(cache.getHealth().length, 0);
});

test('setHealth overwrites wholesale (mirrors a shard worker\'s already-computed state)', () => {
    const cache = new OrderBookCache();
    cache.setHealth({
        exchangeId: 'kraken',
        connected: true,
        lastUpdateAt: 12345,
        updateCount: 99,
        reconnectCount: 3,
        lastError: undefined,
    });
    const health = cache.getHealth().find((h) => h.exchangeId === 'kraken');
    assert.equal(health?.updateCount, 99);
    assert.equal(health?.reconnectCount, 3);
});
