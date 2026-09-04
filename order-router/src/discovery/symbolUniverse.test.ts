import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoutableSymbols } from './symbolUniverse.js';

test('a symbol on exactly one exchange is excluded from the routable set', () => {
    const markets = new Map([
        ['kraken', ['BTC/USDT', 'ONLY_ON_KRAKEN/USDT']],
        ['coinbase', ['BTC/USDT']],
    ]);

    const result = computeRoutableSymbols(markets, 2);

    assert.deepEqual(result.routableSymbolsByExchange.get('kraken'), ['BTC/USDT']);
    assert.deepEqual(result.routableSymbolsByExchange.get('coinbase'), ['BTC/USDT']);
    assert.equal(result.totalUniqueSymbols, 2);
    assert.equal(result.routableSymbolCount, 1);
});

test('an exchange with zero routable symbols is absent from the result map', () => {
    const markets = new Map([
        ['kraken', ['BTC/USDT']],
        ['coinbase', ['BTC/USDT']],
        ['lonely', ['NOBODY_ELSE_HAS/USDT']],
    ]);

    const result = computeRoutableSymbols(markets, 2);

    assert.equal(result.routableSymbolsByExchange.has('lonely'), false);
});

test('minExchangesPerSymbol threshold is inclusive', () => {
    const markets = new Map([
        ['a', ['X/USDT']],
        ['b', ['X/USDT']],
        ['c', ['X/USDT']],
    ]);

    assert.equal(computeRoutableSymbols(markets, 3).routableSymbolCount, 1);
    assert.equal(computeRoutableSymbols(markets, 4).routableSymbolCount, 0);
});

test('empty input produces empty output, not an error', () => {
    const result = computeRoutableSymbols(new Map(), 2);
    assert.equal(result.totalUniqueSymbols, 0);
    assert.equal(result.routableSymbolCount, 0);
    assert.equal(result.routableSymbolsByExchange.size, 0);
});
