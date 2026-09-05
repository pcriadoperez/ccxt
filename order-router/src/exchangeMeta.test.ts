import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCertified, certifiedExchanges } from './exchangeMeta.js';

test('reads certification from ccxt without a network call', () => {
    const list = certifiedExchanges();
    assert.ok(list.length > 10, `expected a meaningful certified set, got ${list.length}`);
    assert.ok(list.includes('binance'));
    assert.ok(list.includes('okx'));
});

test('isCertified distinguishes certified from uncertified venues', () => {
    assert.equal(isCertified('binance'), true);
    assert.equal(isCertified('p2b'), false);
    assert.equal(isCertified('not-a-real-exchange'), false);
});
