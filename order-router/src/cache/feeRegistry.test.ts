import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeeRegistry } from './feeRegistry.js';

test('getFee returns the fallback when no fee has been set', () => {
    const registry = new FeeRegistry();
    assert.equal(registry.getFee('kraken', 'BTC/USDT'), 0.001);
    assert.equal(registry.getFee('kraken', 'BTC/USDT', 0.02), 0.02);
});

test('getFee returns the set fee once populated', () => {
    const registry = new FeeRegistry();
    registry.setFee('kraken', 'BTC/USDT', 0.0016);
    assert.equal(registry.getFee('kraken', 'BTC/USDT'), 0.0016);
});

test('fees are scoped per (exchange, symbol) pair', () => {
    const registry = new FeeRegistry();
    registry.setFee('kraken', 'BTC/USDT', 0.001);
    registry.setFee('coinbase', 'BTC/USDT', 0.005);
    registry.setFee('kraken', 'ETH/USDT', 0.002);

    assert.equal(registry.getFee('kraken', 'BTC/USDT'), 0.001);
    assert.equal(registry.getFee('coinbase', 'BTC/USDT'), 0.005);
    assert.equal(registry.getFee('kraken', 'ETH/USDT'), 0.002);
});

test('setFee emits a fee event with the full payload (used to relay across shard IPC)', () => {
    const registry = new FeeRegistry();
    let received: unknown;
    registry.on('fee', (msg) => { received = msg; });

    registry.setFee('kraken', 'BTC/USDT', 0.001);

    assert.deepEqual(received, { exchangeId: 'kraken', symbol: 'BTC/USDT', takerFeeRate: 0.001 });
});
