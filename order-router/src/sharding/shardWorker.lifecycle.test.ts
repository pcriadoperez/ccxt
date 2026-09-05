import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RelayOrderBookCache } from './relayCache.js';
import type { CachedOrderBook } from '../types.js';

// A shard orphaned during startup never exited. The `disconnect` handler — the shard's only
// instruction to die when the parent goes away — was registered at the END of runShard, after every
// connector had finished starting. Startup is the longest window in the process's life (bounded
// concurrency over N exchanges, each doing loadMarkets and a first snapshot), and it was the one
// window with no handler: a parent that died or rebalanced mid-startup left a shard holding its
// sockets and its heap, answering to nobody, until the box was restarted.
//
// Source-level, because the behavioural version needs a real fork and a parent that dies at exactly
// the right moment. What matters is the ORDER of two statements, and that is legible here.

const SRC = readFileSync(fileURLToPath(new URL('./shardWorker.ts', import.meta.url)), 'utf8');

test('the disconnect handler is registered before any connector starts', () => {
    const disconnect = SRC.indexOf("process.on('disconnect'");
    assert.notEqual(disconnect, -1, 'the shard must exit when the parent goes away');
    const runShard = SRC.indexOf('async function runShard');
    assert.ok(disconnect < runShard,
        'the disconnect handler must be registered at module load, not inside runShard');
});

test('the init handler is what starts the shard, and it comes after the disconnect handler', () => {
    // The ordering only holds if nothing re-registers or overrides it later.
    assert.equal(SRC.split("process.on('disconnect'").length - 1, 1, 'exactly one disconnect handler');
    assert.ok(SRC.indexOf("process.on('disconnect'") < SRC.indexOf("process.on('message'"));
});

function book (symbol = 'BTC/USDT'): CachedOrderBook {
    return {
        exchangeId: 'kraken',
        symbol,
        bids: [{ price: 100, amount: 5 }],
        asks: [{ price: 101, amount: 5 }],
        exchangeTimestamp: Date.now(),
        receivedAt: Date.now(),
        sequence: 1,
    };
}

test('relays every book without retaining it', async () => {
    // A shard uses its cache purely as an event bus — it forwards to the parent and never reads a
    // book back. Retaining them anyway meant a full second copy of every book the shard owns, held
    // inside the one process that has a hard heap ceiling, for nothing.
    const cache = new RelayOrderBookCache();
    const relayed: CachedOrderBook[] = [];
    cache.on('book', (b: CachedOrderBook) => relayed.push(b));

    cache.setBook(book('BTC/USDT'));
    cache.setBook(book('ETH/USDT'));

    assert.equal(relayed.length, 2, 'both updates reached the parent');
    assert.equal(cache.getBookCount(), 0, 'and neither is still held here');
    assert.deepEqual(cache.getBooksForSymbol('BTC/USDT'), []);
    assert.deepEqual(cache.listSymbols(), []);
});

test('per-symbol update events still fire, so nothing downstream changes shape', () => {
    const cache = new RelayOrderBookCache();
    let updates = 0;
    cache.on('update:BTC/USDT', () => { updates += 1; });
    cache.setBook(book('BTC/USDT'));
    assert.equal(updates, 1);
});

test('health is still retained — it is small, and the shard reads it back every flush', () => {
    // The shard flushes cache.getHealth() to the parent on a timer, so this half must keep working.
    const cache = new RelayOrderBookCache();
    cache.initHealth('kraken');
    cache.recordUpdate('kraken');
    cache.recordUpdate('kraken');
    const health = cache.getHealth();
    assert.equal(health.length, 1);
    assert.equal(health[0]?.updateCount, 2);
    assert.equal(health[0]?.connected, true);
});

test('the shard worker actually uses the relay, not the retaining cache', () => {
    // Source-level: instantiating the worker means forking a process that opens live exchange
    // websockets. The fact that matters is which cache it constructs.
    assert.ok(SRC.indexOf('new RelayOrderBookCache()') !== -1);
    assert.equal(SRC.indexOf('new OrderBookCache()'), -1, 'a shard must not retain books it never reads');
});
