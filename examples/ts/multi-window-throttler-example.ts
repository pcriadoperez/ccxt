/**
 * Multi-Window Rate Throttler Examples
 *
 * This file demonstrates how to use the new MultiWindowThrottler
 * with various exchange rate limit configurations.
 */

import { MultiWindowThrottler } from '../../ts/src/base/functions/MultiWindowThrottler.js';

/**
 * Example 1: Simple single rate limit
 */
async function example1Simple() {
    console.log('Example 1: Simple Rate Limiting');
    console.log('='.repeat(50));

    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 10,
                interval: 'second',
                type: 'requests',
            },
        ],
    });

    // Make 15 requests - first 10 are immediate, next 5 wait
    const start = Date.now();
    for (let i = 0; i < 15; i++) {
        await throttler.throttle();
        const elapsed = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`Request ${i + 1} at ${elapsed}s`);
    }

    console.log('');
}

/**
 * Example 2: Binance-like configuration
 * Multiple rate limits with different types
 */
async function example2Binance() {
    console.log('Example 2: Binance-like Multi-Limit');
    console.log('='.repeat(50));

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
                intervalNum: 10,
                type: 'requests',
                id: 'RAW_REQUESTS_10S',
            },
        ],
    });

    // Simulate various endpoint calls
    console.log('Calling lightweight endpoint (weight: 1)');
    await throttler.throttle(1);

    console.log('Calling medium endpoint (weight: 10)');
    await throttler.throttle(10);

    console.log('Calling heavy endpoint (weight: 100)');
    await throttler.throttle(100);

    // Check status
    const info = throttler.getInfo();
    console.log('\nThrottler Status:');
    for (const limiter of info) {
        console.log(`  ${limiter.id}:`);
        console.log(`    Usage: ${limiter.usage}/${limiter.limit}`);
        console.log(`    Available: ${limiter.available}`);
    }

    console.log('');
}

/**
 * Example 3: Dynamic limit updates
 * Simulates updating limits from exchange headers
 */
async function example3DynamicUpdates() {
    console.log('Example 3: Dynamic Limit Updates');
    console.log('='.repeat(50));

    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 100,
                interval: 'minute',
                type: 'weight',
                id: 'weight_limit',
            },
        ],
    });

    console.log('Initial limit: 100');
    console.log(`Status: ${JSON.stringify(throttler.getInfo()[0], null, 2)}`);

    // Simulate exchange upgrading our tier
    console.log('\n[Simulating tier upgrade from exchange]');
    throttler.updateLimit('weight_limit', 200);

    console.log('Updated limit: 200');
    console.log(`Status: ${JSON.stringify(throttler.getInfo()[0], null, 2)}`);

    console.log('');
}

/**
 * Example 4: Handling burst traffic
 */
async function example4BurstTraffic() {
    console.log('Example 4: Burst Traffic Handling');
    console.log('='.repeat(50));

    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 5,
                interval: 'second',
                type: 'requests',
            },
        ],
    });

    console.log('Sending burst of 10 requests (limit: 5 per second)');
    const start = Date.now();

    const promises = [];
    for (let i = 0; i < 10; i++) {
        promises.push(
            throttler.throttle().then(() => {
                const elapsed = ((Date.now() - start) / 1000).toFixed(2);
                console.log(`  Request ${i + 1} completed at ${elapsed}s`);
            })
        );
    }

    await Promise.all(promises);
    console.log('\nAll requests completed!');
    console.log('');
}

/**
 * Example 5: Weight-based rate limiting
 */
async function example5WeightBased() {
    console.log('Example 5: Weight-Based Rate Limiting');
    console.log('='.repeat(50));

    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 100,
                interval: 'second',
                type: 'weight',
                id: 'weight_limiter',
            },
            {
                limit: 10,
                interval: 'second',
                type: 'requests',
                id: 'request_limiter',
            },
        ],
    });

    console.log('Making requests with different weights:');

    // Low weight requests
    for (let i = 0; i < 5; i++) {
        await throttler.throttle(5);
        console.log(`  Light request ${i + 1} (weight: 5)`);
    }

    // One heavy request
    await throttler.throttle(50);
    console.log(`  Heavy request (weight: 50)`);

    const info = throttler.getInfo();
    console.log('\nFinal Status:');
    for (const limiter of info) {
        console.log(`  ${limiter.id}:`);
        console.log(`    Weight used: ${limiter.usage}/${limiter.limit}`);
        console.log(`    Remaining: ${limiter.available}`);
    }

    console.log('');
}

/**
 * Example 6: Monitoring usage
 */
async function example6Monitoring() {
    console.log('Example 6: Monitoring Throttler Usage');
    console.log('='.repeat(50));

    const throttler = new MultiWindowThrottler({
        rateLimits: [
            {
                limit: 20,
                interval: 'second',
                type: 'requests',
                id: 'monitor_test',
            },
        ],
    });

    // Set up monitoring
    const monitorInterval = setInterval(() => {
        const info = throttler.getInfo();
        for (const limiter of info) {
            const percentUsed = ((limiter.usage / limiter.limit) * 100).toFixed(1);
            console.log(
                `  [Monitor] ${limiter.id}: ${limiter.usage}/${limiter.limit} ` +
                `(${percentUsed}% used)`
            );
        }
    }, 500); // Monitor every 500ms

    // Make some requests
    console.log('Making 15 requests...\n');
    for (let i = 0; i < 15; i++) {
        await throttler.throttle();
        await new Promise(resolve => setTimeout(resolve, 100)); // Space them out
    }

    clearInterval(monitorInterval);
    console.log('\nMonitoring stopped');
    console.log('');
}

/**
 * Run all examples
 */
async function runAllExamples() {
    try {
        await example1Simple();
        await example2Binance();
        await example3DynamicUpdates();
        await example4BurstTraffic();
        await example5WeightBased();
        await example6Monitoring();

        console.log('='.repeat(50));
        console.log('All examples completed successfully!');
        console.log('='.repeat(50));
    } catch (error) {
        console.error('Error running examples:', error);
        process.exit(1);
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllExamples();
}

export {
    example1Simple,
    example2Binance,
    example3DynamicUpdates,
    example4BurstTraffic,
    example5WeightBased,
    example6Monitoring,
};
