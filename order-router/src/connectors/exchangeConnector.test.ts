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
