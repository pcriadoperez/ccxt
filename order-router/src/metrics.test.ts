import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from './cache/orderBookCache.js';
import { buildMetricsRegistry } from './metrics.js';
import type { CachedOrderBook } from './types.js';

function book (overrides: Partial<CachedOrderBook> = {}): CachedOrderBook {
    return {
        exchangeId: 'kraken',
        symbol: 'BTC/USDT',
        bids: [{ price: 100, amount: 5 }],
        asks: [{ price: 101, amount: 5 }],
        exchangeTimestamp: Date.now(),
        receivedAt: Date.now(),
        sequence: 1,
        ...overrides,
    };
}

function makeRegistry (cache: OrderBookCache, staleBookMs = 5000, wsCount = 0) {
    return buildMetricsRegistry({ cache, staleBookMs, getWsConnectionCount: () => wsCount });
}

test('exposes exchange health as metrics derived from the cache', async () => {
    const cache = new OrderBookCache();
    cache.initHealth('kraken');
    cache.recordUpdate('kraken');
    cache.recordUpdate('kraken');
    cache.recordReconnect('kraken');
    const text = await makeRegistry(cache).metrics();

    assert.match(text, /order_router_exchange_connected\{exchange="kraken"\} 1/);
    assert.match(text, /order_router_exchange_updates_total\{exchange="kraken"\} 2/);
    assert.match(text, /order_router_exchange_reconnects_total\{exchange="kraken"\} 1/);
});

test('a disconnected exchange reports connected=0', async () => {
    const cache = new OrderBookCache();
    cache.initHealth('kraken');
    cache.recordUpdate('kraken');
    cache.recordError('kraken', 'socket closed');
    const text = await makeRegistry(cache).metrics();
    assert.match(text, /order_router_exchange_connected\{exchange="kraken"\} 0/);
});

test('last_update_age rises with staleness rather than reporting zero', async () => {
    // The key alerting signal: a silently dead subscription keeps connected=1 while data rots.
    const cache = new OrderBookCache();
    cache.initHealth('kraken');
    cache.recordUpdate('kraken');
    const health = cache.getHealth()[0];
    health!.lastUpdateAt = Date.now() - 30_000;

    const text = await makeRegistry(cache).metrics();
    const match = /order_router_exchange_last_update_age_seconds\{exchange="kraken"\} ([\d.]+)/.exec(text);
    assert.ok(match, 'age metric present');
    assert.ok(Number(match![1]) >= 29, `age should reflect ~30s staleness, got ${match![1]}`);
});

test('an exchange that never updated reports uptime, not zero age', async () => {
    // Otherwise a connector that never produced a single message looks identical to one that
    // just updated — the exact failure that would go unnoticed.
    const cache = new OrderBookCache();
    cache.initHealth('kraken');
    const text = await makeRegistry(cache).metrics();
    const match = /order_router_exchange_last_update_age_seconds\{exchange="kraken"\} ([\d.]+)/.exec(text);
    assert.ok(match);
    assert.ok(Number(match![1]) > 0, 'never-updated exchange must not report age 0');
});

test('counts cached books, symbols and stale books', async () => {
    const cache = new OrderBookCache();
    cache.setBook(book());
    cache.setBook(book({ exchangeId: 'coinbase' }));
    cache.setBook(book({ symbol: 'ETH/USDT', receivedAt: Date.now() - 60_000 }));

    const text = await makeRegistry(cache, 5000).metrics();
    assert.match(text, /order_router_cached_books 3/);
    assert.match(text, /order_router_cached_symbols 2/);
    assert.match(text, /order_router_stale_books 1/);
});

test('stale book counting respects the configured threshold', async () => {
    const cache = new OrderBookCache();
    cache.setBook(book({ receivedAt: Date.now() - 10_000 }));
    assert.equal(cache.countStaleBooks(5_000), 1, 'older than threshold => stale');
    assert.equal(cache.countStaleBooks(60_000), 0, 'within threshold => fresh');
});

test('reports open websocket stream connections', async () => {
    const cache = new OrderBookCache();
    const text = await makeRegistry(cache, 5000, 7).metrics();
    assert.match(text, /order_router_ws_stream_connections 7/);
});

test('includes default process metrics for event loop lag and heap', async () => {
    // Event loop lag is the first thing to degrade when WS volume outruns the single thread.
    const text = await makeRegistry(new OrderBookCache()).metrics();
    assert.match(text, /order_router_nodejs_eventloop_lag_seconds/);
    assert.match(text, /order_router_nodejs_heap_size_used_bytes/);
});
