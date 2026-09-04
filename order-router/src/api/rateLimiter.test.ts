import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixedWindowRateLimiter } from './rateLimiter.js';

test('allows up to max then denies within the window', () => {
    const limiter = new FixedWindowRateLimiter(3, 60_000);
    const results = [1, 2, 3, 4, 5].map(() => limiter.consume('k').allowed);
    assert.deepEqual(results, [true, true, true, false, false]);
});

test('separate bucket keys have independent budgets', () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    limiter.consume('a'); limiter.consume('a');
    assert.equal(limiter.consume('a').allowed, false);
    assert.equal(limiter.consume('b').allowed, true, 'a different bucket is unaffected');
});

test('the window resets after it expires', () => {
    const limiter = new FixedWindowRateLimiter(1, 1000);
    const t0 = 1_000_000;
    assert.equal(limiter.consume('k', t0).allowed, true);
    assert.equal(limiter.consume('k', t0 + 500).allowed, false, 'still inside the window');
    assert.equal(limiter.consume('k', t0 + 1500).allowed, true, 'window rolled over');
});

test('reports limit, remaining and a positive reset', () => {
    const limiter = new FixedWindowRateLimiter(2, 60_000);
    const first = limiter.consume('k');
    assert.equal(first.limit, 2);
    assert.equal(first.remaining, 1);
    assert.ok(first.resetSeconds > 0);
    limiter.consume('k');
    assert.equal(limiter.consume('k').remaining, 0, 'remaining never goes negative');
});

test('expired buckets are pruned so attacker-controlled keys cannot grow memory without bound', () => {
    const limiter = new FixedWindowRateLimiter(10, 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 1200; i++) limiter.consume(`ip-${i}`, t0);
    assert.ok(limiter.bucketCount > 1000, 'buckets accumulated within the window');
    limiter.consume('trigger', t0 + 5000);
    assert.ok(limiter.bucketCount < 100, `expired buckets pruned, got ${limiter.bucketCount}`);
});
