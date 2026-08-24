import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkSymbols, normalizeLevels, isPermanentError } from './exchangeConnector.js';

test('chunkSymbols splits into groups no larger than the given size', () => {
    const symbols = Array.from({ length: 125 }, (_, i) => `SYM${i}`);
    const chunks = chunkSymbols(symbols, 50);

    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]?.length, 50);
    assert.equal(chunks[1]?.length, 50);
    assert.equal(chunks[2]?.length, 25);
    assert.deepEqual(chunks.flat(), symbols);
});

test('chunkSymbols on an empty array returns no chunks', () => {
    assert.deepEqual(chunkSymbols([], 50), []);
});

test('chunkSymbols with size >= symbol count returns one chunk', () => {
    const symbols = ['a', 'b', 'c'];
    assert.deepEqual(chunkSymbols(symbols, 50), [symbols]);
});

test('normalizeLevels drops levels missing price or amount', () => {
    const levels: [number | undefined, number | undefined][] = [
        [100, 1],
        [undefined, 1],
        [100, undefined],
        [101, 2],
    ];

    assert.deepEqual(normalizeLevels(levels), [
        { price: 100, amount: 1 },
        { price: 101, amount: 2 },
    ]);
});

test('normalizeLevels on an all-valid input passes through unchanged', () => {
    const levels: [number | undefined, number | undefined][] = [[100, 1], [99, 2]];
    assert.deepEqual(normalizeLevels(levels), [{ price: 100, amount: 1 }, { price: 99, amount: 2 }]);
});

test('permanent failures are recognised so they are abandoned, not retried forever', () => {
    // A venue needing credentials fails instantly and identically on every retry. Treating that
    // as transient produced a busy loop that wrote ~930MB / 22M log lines and starved the CPU
    // that working venues needed.
    assert.equal(isPermanentError('cex requires "apiKey" credential'), true);
    assert.equal(isPermanentError('luno requires "apiKey" credential'), true);
    assert.equal(isPermanentError('someex watchOrderBook() is not supported yet'), true);
    assert.equal(isPermanentError('authentication failed'), true);
});

test('transient failures stay retryable', () => {
    // These recover on their own; abandoning them would permanently drop a healthy venue.
    assert.equal(isPermanentError('connection closed by remote'), false);
    assert.equal(isPermanentError('request timed out (10000 ms)'), false);
    assert.equal(isPermanentError('socket hang up'), false);
    assert.equal(isPermanentError('subscribe over limit, max:1000'), false);
});

test('books are truncated before they can cross the IPC boundary', () => {
    // The measurement that forced this: coinbase streams 44,298 levels per update at ~165/sec.
    // Serialised that is ~31 MB/s per exchange into a pipe the parent cannot drain — process.send
    // returned false on 96.3% of calls and libuv queued the rest, putting one shard at 19.8GB RSS
    // with a flat 62MB heap. An isolation test attributed it precisely: bare stream 131MB,
    // +normalize 180MB, +stringify 193MB, +process.send 5,444MB.
    const huge: [number, number][] = Array.from({ length: 44_298 }, (_, i) => [100 + i, 1]);
    assert.equal(normalizeLevels(huge).length, 44_298, 'unbounded by default, as ccxt hands it over');
    assert.equal(normalizeLevels(huge, 500).length, 500);
    // Truncation must keep the TOP of the book — those are the levels an order actually fills from.
    assert.equal(normalizeLevels(huge, 3)[0]!.price, 100);
    assert.equal(normalizeLevels(huge, 3)[2]!.price, 102);
});

test('truncation still leaves an order of magnitude more depth than routing uses', () => {
    // A 5,000,000 USDT order was measured filling in under 50 levels per venue. The default has to
    // stay comfortably above that, or the fix for a memory problem becomes a routing problem.
    const levels: [number, number][] = Array.from({ length: 2000 }, (_, i) => [100 + i * 0.01, 1]);
    const kept = normalizeLevels(levels, 500);
    assert.ok(kept.length >= 500, 'the default must not starve a large order');
    // 500 levels of 1 unit each is 500 units of depth on a book whose top level is 100 — far beyond
    // any order this router has been measured filling.
    assert.equal(kept.reduce((s, l) => s + l.amount, 0), 500);
});

test('a partial or malformed level is still dropped, not counted against the depth budget', () => {
    const mixed: [number | undefined, number | undefined][] = [
        [100, 1], [undefined, 1], [101, undefined], [102, 2], [103, 3],
    ];
    const kept = normalizeLevels(mixed, 3);
    assert.deepEqual(kept.map((l) => l.price), [100, 102, 103],
        'incomplete levels must not consume depth that a real level could have used');
});
