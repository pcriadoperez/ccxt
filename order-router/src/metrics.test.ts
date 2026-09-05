import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from './cache/orderBookCache.js';
import { buildMetricsRegistry, countReportingShards } from './metrics.js';
import { shardRestartCounts } from './sharding/orchestrator.js';
import { LoopRegistry } from './cache/loopRegistry.js';
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
    return buildMetricsRegistry({ cache, staleBookMs, getWsConnectionCount: () => wsCount, loopRegistry: new LoopRegistry() });
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

test('exposes per-shard event loop utilisation so saturation is visible', async () => {
    // Starvation is otherwise SILENT: a saturated shard keeps its sockets open, logs nothing, and
    // simply stops delivering book updates. Utilisation is the only clean signal.
    const cache = new OrderBookCache();
    const loopRegistry = new LoopRegistry();
    loopRegistry.set('shard-0', { utilization: 0.97, lagP50Ms: 12, lagP99Ms: 340, lagMaxMs: 900 });
    loopRegistry.set('shard-1', { utilization: 0.21, lagP50Ms: 1, lagP99Ms: 4, lagMaxMs: 9 });
    const text = await buildMetricsRegistry({
        cache, staleBookMs: 5000, getWsConnectionCount: () => 0, loopRegistry,
    }).metrics();

    assert.match(text, /order_router_shard_event_loop_utilization\{shard="shard-0"\} 0\.97/);
    assert.match(text, /order_router_shard_event_loop_utilization\{shard="shard-1"\} 0\.21/);
    assert.match(text, /order_router_shard_event_loop_lag_p99_ms\{shard="shard-0"\} 340/);
});

test('a shard that stops reporting shows a rising report age', async () => {
    // Distinguishes "shard is busy" from "shard is gone" — a dead shard reports nothing at all.
    const loopRegistry = new LoopRegistry();
    loopRegistry.set('shard-0', { utilization: 0.5, lagP50Ms: 1, lagP99Ms: 2, lagMaxMs: 3 });
    const text = await buildMetricsRegistry({
        cache: new OrderBookCache(), staleBookMs: 5000, getWsConnectionCount: () => 0, loopRegistry,
    }).metrics();
    assert.match(text, /order_router_shard_loop_report_age_seconds\{shard="shard-0"\}/);
});

test('crossed books are exposed per exchange and start at zero', async () => {
    const cache = new OrderBookCache();
    cache.initHealth('deepcoin');
    cache.initHealth('kraken');
    cache.recordCrossed('deepcoin');
    cache.recordCrossed('deepcoin');
    const text = await makeRegistry(cache).metrics();

    assert.match(text, /order_router_exchange_crossed_books_total\{exchange="deepcoin"\} 2/);
    // A healthy venue must report an explicit 0 rather than being absent, or the alert
    // "crossed_books_total > 0" would silently have nothing to fire against.
    assert.match(text, /order_router_exchange_crossed_books_total\{exchange="kraken"\} 0/);
});

test('an exchange that has never resynced reports -1 rather than 0', async () => {
    const cache = new OrderBookCache();
    cache.initHealth('kraken');
    const text = await makeRegistry(cache).metrics();
    assert.match(text, /order_router_exchange_last_resync_seconds\{exchange="kraken"\} -1/);
});

test('dropped stream frames are counted and exported', async () => {
    // A frame dropped for a slow consumer used to be invisible in every direction at once — no
    // metric, no log, nothing on the wire — so a saturated socket looked exactly like a quiet
    // market. This is the operator's half of that signal.
    const { Registry } = await import('prom-client');
    const { buildStreamDropCounter } = await import('./metrics.js');
    const registry = new Registry();
    const counter = buildStreamDropCounter(registry);
    assert.match(await registry.metrics(), /order_router_stream_frames_dropped_total 0/);
    counter.inc();
    counter.inc();
    assert.match(await registry.metrics(), /order_router_stream_frames_dropped_total 2/);
});

test('a shard that never started is visible as a gap between expected and reporting', async () => {
    // The whole point: a shard that never came up is ABSENT from every other series. No exchange
    // series (the parent only learns of an exchange over IPC from the shard that owns it), no shard
    // series (loopRegistry is populated by the shard's own reports), no restart counter. Silence
    // reads exactly like health, so the only alertable form is a count of what SHOULD be there.
    const loopRegistry = new LoopRegistry();
    loopRegistry.set('shard-0', { utilization: 0.5, lagP50Ms: 1, lagP99Ms: 2, lagMaxMs: 3 });
    const text = await buildMetricsRegistry({
        cache: new OrderBookCache(), staleBookMs: 5000, getWsConnectionCount: () => 0, loopRegistry,
        expectedShards: 4,
    }).metrics();

    assert.match(text, /order_router_shards_expected 4/);
    assert.match(text, /order_router_shards_reporting 1/);
});

test('a shard that has stopped reporting stops counting as present', async () => {
    // A dead shard's last report lingers in the registry forever, so counting entries would report
    // a shard that has been gone for an hour as reporting.
    const now = Date.now();
    const fresh: [string, { updatedAt: number }][] = [['shard-0', { updatedAt: now - 1000 }]];
    const stale: [string, { updatedAt: number }][] = [['shard-1', { updatedAt: now - 600_000 }]];
    assert.equal(countReportingShards([...fresh, ...stale], now), 1);
    assert.equal(countReportingShards([], now), 0);
});

test('shard restarts are counted per shard, so a crash-looping shard is alertable', async () => {
    // Respawn is silent by design (capped backoff, no fatal), which is right for recovery and wrong
    // for observability: 3 of 4 shards were once running with no alert at all.
    shardRestartCounts.set('shard-2', 7);
    try {
        const text = await buildMetricsRegistry({
            cache: new OrderBookCache(), staleBookMs: 5000, getWsConnectionCount: () => 0,
            loopRegistry: new LoopRegistry(),
        }).metrics();
        assert.match(text, /order_router_shard_restarts_total\{shard="shard-2"\} 7/);
    } finally {
        shardRestartCounts.delete('shard-2');
    }
});
