/* eslint-disable */
import { WindowRateLimiter, MultiWindowThrottler, } from '../../../base/functions/MultiWindowThrottler.js';
/**
 * Comprehensive tests for Multi-Window Rate Throttler
 */
const TOLERANCE_MS = 50; // Tolerance for timing tests
function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}
function assertApprox(actual, expected, tolerance, message) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new Error(`${message} - Expected ${expected}±${tolerance}, got ${actual} (diff: ${diff})`);
    }
}
/**
 * Test 1: Basic single window rate limiter
 * Should allow requests up to limit, then throttle
 */
async function testBasicWindowLimiter() {
    console.log('Test 1: Basic single window rate limiter');
    const limiter = new WindowRateLimiter({
        limit: 10,
        interval: 'second',
        type: 'requests',
    });
    // Should start with full capacity
    const info = limiter.getInfo();
    assert(info.available === 10, 'Should start at full capacity');
    assert(info.usage === 0, 'Should start with zero usage');
    // Should allow 10 requests immediately
    for (let i = 0; i < 10; i++) {
        assert(limiter.canProceed(1), `Request ${i + 1} should be allowed`);
        limiter.recordRequest(1);
    }
    // 11th request should not be allowed
    assert(!limiter.canProceed(1), '11th request should be blocked');
    // Wait time should be approximately 1 second (when first request expires)
    const waitTime = limiter.getTimeToWait(1);
    assertApprox(waitTime, 1000, 100, 'Wait time should be ~1 second');
    console.log('✓ Test 1 passed');
}
/**
 * Test 2: Weight-based rate limiting
 * Different requests have different costs
 */
async function testWeightBasedLimiting() {
    console.log('Test 2: Weight-based rate limiting');
    const limiter = new WindowRateLimiter({
        limit: 1200,
        interval: 'minute',
        type: 'weight',
    });
    // High-weight requests
    assert(limiter.canProceed(100), 'Should allow 100-weight request');
    limiter.recordRequest(100);
    assert(limiter.canProceed(500), 'Should allow 500-weight request');
    limiter.recordRequest(500);
    // Now at 600/1200
    const info = limiter.getInfo();
    assert(info.usage === 600, 'Usage should be 600');
    assert(info.available === 600, 'Available should be 600');
    // Should allow another 600-weight request
    assert(limiter.canProceed(600), 'Should allow 600-weight request');
    limiter.recordRequest(600);
    // Should not allow any more requests
    assert(!limiter.canProceed(1), 'Should block 1-weight request when at capacity');
    console.log('✓ Test 2 passed');
}
/**
 * Test 3: Multiple parallel rate limiters
 * Must satisfy all limits simultaneously
 */
async function testMultipleParallelLimiters() {
    console.log('Test 3: Multiple parallel rate limiters');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            { limit: 10, interval: 'second', type: 'requests' },
            { limit: 100, interval: 'minute', type: 'requests' },
        ],
        defaultCost: 1,
    });
    const info = throttler.getInfo();
    assert(info.length === 2, 'Should have 2 limiters');
    assert(info[0].available === 10, 'First limiter should be at full capacity');
    assert(info[1].available === 100, 'Second limiter should be at full capacity');
    // Make 10 requests - should hit the per-second limit
    for (let i = 0; i < 10; i++) {
        await throttler.throttle(1);
    }
    const infoAfter = throttler.getInfo();
    assert(infoAfter[0].usage === 10, 'Per-second limiter should be at capacity');
    assert(infoAfter[1].usage === 10, 'Per-minute limiter should be at 10/100');
    console.log('✓ Test 3 passed');
}
/**
 * Test 4: Dynamic limit updates
 * Update limits based on exchange headers
 */
async function testDynamicLimitUpdates() {
    console.log('Test 4: Dynamic limit updates');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 100,
                interval: 'minute',
                type: 'weight',
                id: 'weight_limit_1m',
            },
        ],
    });
    // Initial limit
    let info = throttler.getInfo();
    assert(info[0].limit === 100, 'Initial limit should be 100');
    // Update limit (e.g., from X-MBX-USED-WEIGHT header)
    throttler.updateLimit('weight_limit_1m', 200);
    info = throttler.getInfo();
    assert(info[0].limit === 200, 'Updated limit should be 200');
    console.log('✓ Test 4 passed');
}
/**
 * Test 5: Sliding window behavior
 * Old requests should expire and free up capacity
 */
async function testSlidingWindow() {
    console.log('Test 5: Sliding window behavior');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            { limit: 5, interval: 'second', intervalNum: 1 },
        ],
        defaultCost: 1,
        delay: 0.01, // Faster polling for tests
    });
    const start = performance.now();
    // Make 5 requests immediately
    for (let i = 0; i < 5; i++) {
        await throttler.throttle(1);
    }
    const afterFirst5 = performance.now() - start;
    assertApprox(afterFirst5, 0, 100, 'First 5 requests should be immediate');
    // 6th request should wait ~1 second for first request to expire
    await throttler.throttle(1);
    const after6th = performance.now() - start;
    assertApprox(after6th, 1000, TOLERANCE_MS, '6th request should wait ~1 second');
    console.log('✓ Test 5 passed');
}
/**
 * Test 6: Multiple intervals (intervalNum)
 * E.g., "60 requests per 5 minutes"
 */
async function testMultipleIntervals() {
    console.log('Test 6: Multiple intervals');
    const limiter = new WindowRateLimiter({
        limit: 100,
        interval: 'second',
        intervalNum: 5, // 100 requests per 5 seconds
    });
    assert(limiter.getInfo().windowMs === 5000, 'Window should be 5000ms');
    // Should allow 100 requests immediately
    for (let i = 0; i < 100; i++) {
        assert(limiter.canProceed(1), `Request ${i + 1} should be allowed`);
        limiter.recordRequest(1);
    }
    assert(!limiter.canProceed(1), '101st request should be blocked');
    console.log('✓ Test 6 passed');
}
/**
 * Test 7: Real-world Binance-like scenario
 * Multiple weight-based limits with different intervals
 */
async function testBinanceLikeScenario() {
    console.log('Test 7: Real-world Binance-like scenario');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 1200,
                interval: 'minute',
                type: 'weight',
                id: 'REQUEST_WEIGHT_1M',
            },
            {
                limit: 50,
                interval: 'second',
                intervalNum: 10, // 50 per 10 seconds
                type: 'requests',
                id: 'RAW_REQUESTS_10S',
            },
        ],
    });
    // Simulate different endpoint costs
    // Lightweight endpoint (weight 1)
    await throttler.throttle(1);
    // Medium endpoint (weight 5)
    await throttler.throttle(5);
    // Heavy endpoint (weight 100)
    await throttler.throttle(100);
    const info = throttler.getInfo();
    // Check weight limiter
    const weightLimiter = info.find(i => i.id === 'REQUEST_WEIGHT_1M');
    assert(weightLimiter !== undefined, 'Weight limiter should exist');
    assert(weightLimiter.usage === 106, 'Weight usage should be 1+5+100=106');
    assert(weightLimiter.available === 1094, 'Weight available should be 1200-106=1094');
    // Check request limiter
    const requestLimiter = info.find(i => i.id === 'RAW_REQUESTS_10S');
    assert(requestLimiter !== undefined, 'Request limiter should exist');
    assert(requestLimiter.usage === 3, 'Request usage should be 3');
    assert(requestLimiter.available === 47, 'Request available should be 50-3=47');
    console.log('✓ Test 7 passed');
}
/**
 * Test 8: Queue overflow protection
 */
async function testQueueOverflow() {
    console.log('Test 8: Queue overflow protection');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            { limit: 1, interval: 'hour' }, // Very restrictive
        ],
        maxCapacity: 10, // Small queue
    });
    // Fill the queue
    const promises = [];
    for (let i = 0; i < 10; i++) {
        promises.push(throttler.throttle(1));
    }
    // 11th request should throw
    try {
        await throttler.throttle(1);
        assert(false, 'Should have thrown queue overflow error');
    }
    catch (e) {
        assert(e.message.includes('maxCapacity'), 'Should throw maxCapacity error');
    }
    console.log('✓ Test 8 passed');
}
/**
 * Test 9: Full capacity at startup
 * Unlike old throttler, should NOT wait on first requests
 */
async function testFullCapacityAtStartup() {
    console.log('Test 9: Full capacity at startup');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            { limit: 10, interval: 'second' },
        ],
    });
    const start = performance.now();
    // First 10 requests should be immediate (no waiting)
    for (let i = 0; i < 10; i++) {
        await throttler.throttle(1);
    }
    const elapsed = performance.now() - start;
    // Should take less than 100ms (i.e., no rate limiting delay)
    assertApprox(elapsed, 0, 100, 'First 10 requests should be immediate');
    console.log('✓ Test 9 passed');
}
/**
 * Test 10: Different interval types
 */
async function testDifferentIntervals() {
    console.log('Test 10: Different interval types');
    const intervals = [
        { interval: 'second', expectedMs: 1000 },
        { interval: 'minute', expectedMs: 60 * 1000 },
        { interval: 'hour', expectedMs: 60 * 60 * 1000 },
        { interval: 'day', expectedMs: 24 * 60 * 60 * 1000 },
    ];
    for (const { interval, expectedMs } of intervals) {
        const limiter = new WindowRateLimiter({
            limit: 100,
            interval: interval,
        });
        assert(limiter.getInfo().windowMs === expectedMs, `${interval} should be ${expectedMs}ms`);
    }
    console.log('✓ Test 10 passed');
}
/**
 * Test 11: OKX-like sub-account rate limit
 * 1000 orders per 2 seconds
 */
async function testOKXSubAccountLimit() {
    console.log('Test 11: OKX-like sub-account rate limit');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 1000,
                interval: 'second',
                intervalNum: 2,
                type: 'orders',
                id: 'SUB_ACCOUNT_ORDERS_2S',
            },
        ],
    });
    // Should allow 1000 orders immediately
    for (let i = 0; i < 1000; i++) {
        await throttler.throttle(1);
    }
    const info = throttler.getInfo();
    assert(info[0].usage === 1000, 'Should have 1000 orders in window');
    assert(info[0].available === 0, 'Should have no capacity left');
    console.log('✓ Test 11 passed');
}
/**
 * Test 12: Precise timing test
 * Verify that requests are released as the window slides
 */
async function testPreciseTiming() {
    console.log('Test 12: Precise timing test');
    const throttler = new MultiWindowThrottler({
        rateLimits: [
            { limit: 2, interval: 'second' },
        ],
        delay: 0.01, // Fast polling
    });
    const start = performance.now();
    const timestamps = [];
    // Make 5 requests
    for (let i = 0; i < 5; i++) {
        await throttler.throttle(1);
        timestamps.push(performance.now() - start);
    }
    // First 2 should be immediate
    assertApprox(timestamps[0], 0, 50, 'Request 1 should be immediate');
    assertApprox(timestamps[1], 0, 50, 'Request 2 should be immediate');
    // 3rd request waits ~1s (for request 1 to expire)
    assertApprox(timestamps[2], 1000, TOLERANCE_MS, 'Request 3 should wait ~1s');
    // 4th request waits ~1s from start (for request 2 to expire)
    assertApprox(timestamps[3], 1000, TOLERANCE_MS, 'Request 4 should wait ~1s');
    // 5th request waits ~2s from start (for request 3 to expire)
    assertApprox(timestamps[4], 2000, TOLERANCE_MS, 'Request 5 should wait ~2s');
    console.log('✓ Test 12 passed');
}
/**
 * Run all tests
 */
async function testMultiWindowThrottler() {
    console.log('='.repeat(60));
    console.log('Multi-Window Rate Throttler Tests');
    console.log('='.repeat(60));
    const tests = [
        testBasicWindowLimiter,
        testWeightBasedLimiting,
        testMultipleParallelLimiters,
        testDynamicLimitUpdates,
        testSlidingWindow,
        testMultipleIntervals,
        testBinanceLikeScenario,
        testQueueOverflow,
        testFullCapacityAtStartup,
        testDifferentIntervals,
        testOKXSubAccountLimit,
        testPreciseTiming,
    ];
    let passed = 0;
    let failed = 0;
    for (const test of tests) {
        try {
            await test();
            passed++;
        }
        catch (e) {
            console.error(`✗ ${test.name} failed:`, e.message);
            failed++;
        }
        console.log(''); // Empty line between tests
    }
    console.log('='.repeat(60));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));
    if (failed > 0) {
        throw new Error(`${failed} test(s) failed`);
    }
}
export default testMultiWindowThrottler;
