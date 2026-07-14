import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkSymbols, normalizeLevels } from './exchangeConnector.js';

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
