import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { buildServer } from './server.js';
import type { CachedOrderBook } from '../types.js';

const silentLogger = pino({ level: 'silent' });

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

async function buildTestServer () {
    const cache = new OrderBookCache();
    const feeRegistry = new FeeRegistry();
    const app = await buildServer(cache, feeRegistry, silentLogger);
    return { app, cache, feeRegistry };
}

test('GET /health returns ok', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    await app.close();
});

test('GET /symbols reflects the cache contents', async () => {
    const { app, cache } = await buildTestServer();
    cache.setBook(book({ symbol: 'BTC/USDT' }));
    cache.setBook(book({ symbol: 'ETH/USDT', exchangeId: 'coinbase' }));

    const response = await app.inject({ method: 'GET', url: '/symbols' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(new Set(response.json().symbols), new Set(['BTC/USDT', 'ETH/USDT']));
    await app.close();
});

test('GET /exchanges/status reflects recorded health', async () => {
    const { app, cache } = await buildTestServer();
    cache.initHealth('kraken');
    cache.recordUpdate('kraken');

    const response = await app.inject({ method: 'GET', url: '/exchanges/status' });
    assert.equal(response.statusCode, 200);
    const status = response.json().exchanges.find((e: { exchangeId: string }) => e.exchangeId === 'kraken');
    assert.equal(status.connected, true);
    await app.close();
});

test('GET /orderbook/:exchange/:symbol returns 404 when nothing is cached', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/orderbook/kraken/BTC%2FUSDT' });
    assert.equal(response.statusCode, 404);
    await app.close();
});

test('GET /orderbook/:exchange/:symbol returns the cached book', async () => {
    const { app, cache } = await buildTestServer();
    cache.setBook(book());

    const response = await app.inject({ method: 'GET', url: '/orderbook/kraken/BTC%2FUSDT' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().exchangeId, 'kraken');
    await app.close();
});

test('GET /price/best/:symbol requires a positive amount', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/price/best/BTC%2FUSDT?side=buy&amount=0' });
    assert.equal(response.statusCode, 400);
    await app.close();
});

test('GET /price/best/:symbol returns a ranked result for a valid request', async () => {
    const { app, cache, feeRegistry } = await buildTestServer();
    cache.setBook(book());
    feeRegistry.setFee('kraken', 'BTC/USDT', 0.001);

    const response = await app.inject({ method: 'GET', url: '/price/best/BTC%2FUSDT?side=buy&amount=1' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.best.exchangeId, 'kraken');
    assert.equal(body.best.fullyFillable, true);
    await app.close();
});

test('GET /price/best/:symbol defaults to buy side when side is omitted', async () => {
    const { app, cache } = await buildTestServer();
    cache.setBook(book({ asks: [{ price: 101, amount: 1 }], bids: [{ price: 1, amount: 1 }] }));

    const response = await app.inject({ method: 'GET', url: '/price/best/BTC%2FUSDT?amount=1' });
    const body = response.json();
    assert.equal(body.side, 'buy');
    assert.equal(body.best.averagePrice, 101);
    await app.close();
});
