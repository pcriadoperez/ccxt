import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoutableSymbols } from './symbolUniverse.js';
import { rankByVolume, isUsableRanking } from './liquidity.js';

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

test('ranks by quote volume, and keeps unknown symbols at the tail rather than dropping them', () => {
    const volume = new Map([['BTC/USDT', 1000], ['ETH/USDT', 500]]);
    const ranked = rankByVolume(['DOGE/USDT', 'ETH/USDT', 'BTC/USDT'], volume);
    assert.deepEqual(ranked, ['BTC/USDT', 'ETH/USDT', 'DOGE/USDT']);
});

test('a ranking with no reference venue behind it is not a ranking', () => {
    // Every reference venue failing leaves the volume map empty, and the sort then becomes a no-op:
    // the "most liquid" head is just whatever order discovery happened to enumerate. Trimming to
    // topSymbols on that basis pins the router to a junk symbol universe for the whole process
    // lifetime, while logging 'symbol universe trimmed to most-liquid'. One transient network blip
    // at boot is all it takes.
    assert.equal(isUsableRanking({ referencesSucceeded: 0, referencesAttempted: 2 }), false);
    assert.equal(isUsableRanking({ referencesSucceeded: 1, referencesAttempted: 2 }), true,
        'one surviving reference still gives a real volume ordering');
});

test('an unranked list is exactly the input order, which is why it must not be trusted', () => {
    const input = ['C/USDT', 'A/USDT', 'B/USDT'];
    assert.deepEqual(rankByVolume(input, new Map()), input);
});
