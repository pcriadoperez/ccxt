import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { computeBestPrice } from './bestPrice.js';
import type { CachedOrderBook } from '../types.js';

function book (overrides: Partial<CachedOrderBook>): CachedOrderBook {
    return {
        exchangeId: 'test-exchange',
        symbol: 'BTC/USDT',
        bids: [{ price: 100, amount: 10 }],
        asks: [{ price: 101, amount: 10 }],
        exchangeTimestamp: Date.now(),
        receivedAt: Date.now(),
        sequence: 1,
        ...overrides,
    };
}

test('picks the exchange with the best fee-adjusted price, not just the best raw price', () => {
    const cache = new OrderBookCache();
    const fees = new FeeRegistry();

    // exchangeA has the better raw ask (100) but a much higher fee than exchangeB's (100.5).
    cache.setBook(book({ exchangeId: 'exchangeA', asks: [{ price: 100, amount: 5 }] }));
    cache.setBook(book({ exchangeId: 'exchangeB', asks: [{ price: 100.5, amount: 5 }] }));
    fees.setFee('exchangeA', 'BTC/USDT', 0.01);
    fees.setFee('exchangeB', 'BTC/USDT', 0.0005);

    const result = computeBestPrice(cache, fees, 'BTC/USDT', 'buy', 1, 5000);

    // A: 100 * 1.01 = 101; B: 100.5 * 1.0005 = 100.55025 -> B wins despite the worse raw price.
    assert.equal(result.best?.exchangeId, 'exchangeB');
});

test('walks the book across levels to compute a volume-weighted average price', () => {
    const cache = new OrderBookCache();
    const fees = new FeeRegistry();
    fees.setFee('test-exchange', 'BTC/USDT', 0);

    cache.setBook(book({
        asks: [
            { price: 100, amount: 1 },
            { price: 101, amount: 1 },
            { price: 102, amount: 10 },
        ],
    }));

    const result = computeBestPrice(cache, fees, 'BTC/USDT', 'buy', 2, 5000);

    // Fills 1 @ 100 + 1 @ 101 = 201 notional / 2 = 100.5 average.
    assert.equal(result.best?.averagePrice, 100.5);
    assert.equal(result.best?.filledAmount, 2);
    assert.equal(result.best?.fullyFillable, true);
});

test('marks a quote not fully fillable when the book lacks enough depth', () => {
    const cache = new OrderBookCache();
    const fees = new FeeRegistry();
    cache.setBook(book({ asks: [{ price: 100, amount: 1 }] }));

    const result = computeBestPrice(cache, fees, 'BTC/USDT', 'buy', 5, 5000);

    assert.equal(result.best?.fullyFillable, false);
    assert.equal(result.best?.filledAmount, 1);
});

test('sell side walks the bid side, not the ask side', () => {
    const cache = new OrderBookCache();
    const fees = new FeeRegistry();
    fees.setFee('test-exchange', 'BTC/USDT', 0);
    cache.setBook(book({
        bids: [{ price: 99, amount: 3 }],
        asks: [{ price: 500, amount: 3 }], // deliberately implausible, must not be used for a sell
    }));

    const result = computeBestPrice(cache, fees, 'BTC/USDT', 'sell', 2, 5000);

    assert.equal(result.best?.averagePrice, 99);
});

test('excludes stale books from ranking', () => {
    const cache = new OrderBookCache();
    const fees = new FeeRegistry();
    cache.setBook(book({ receivedAt: Date.now() - 60_000 })); // 60s old

    const result = computeBestPrice(cache, fees, 'BTC/USDT', 'buy', 1, 5000); // 5s staleness cutoff

    assert.equal(result.best, undefined);
    assert.equal(result.quotes.length, 1); // still reported, just not eligible as "best"
});

test('returns no best quote when no books exist for the symbol', () => {
    const cache = new OrderBookCache();
    const fees = new FeeRegistry();

    const result = computeBestPrice(cache, fees, 'NONEXISTENT/USDT', 'buy', 1, 5000);

    assert.equal(result.best, undefined);
    assert.deepEqual(result.quotes, []);
});
