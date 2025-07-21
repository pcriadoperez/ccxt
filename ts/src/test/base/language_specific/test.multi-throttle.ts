/* eslint-disable */
import { MultiThrottler, ThrottleRule } from '../../../base/functions/multi-throttle.js'

function testMultiThrottle () {

    const delta = 50 // Allow more tolerance for multi-rule complexity

    console.log('Testing Multi-Rule Throttler Implementation')

    // Test case 1: Single rule (should behave like original throttler)
    async function testSingleRule () {
        console.log('\n=== Test 1: Single Rule ===')
        
        const rules: ThrottleRule[] = [
            {
                id: 'weight',
                capacity: 10,
                refillRate: 1 / 100, // 1 token per 100ms
                tokens: 10,
                intervalType: 'MINUTE',
                intervalNum: 1
            }
        ]
        
        const throttler = new MultiThrottler(rules)
        const start = performance.now()
        
        // Use up initial tokens, then should throttle
        for (let i = 0; i < 15; i++) {
            await throttler.throttle({ weight: 1 })
        }
        
        const end = performance.now()
        const elapsed = end - start
        
        // Should take roughly 500ms for the 5 extra requests (5 * 100ms)
        const expected = 500
        const passed = Math.abs(elapsed - expected) < delta * 2
        console.log(`Single rule test: ${passed ? 'PASSED' : 'FAILED'} - ${elapsed}ms (expected ~${expected}ms)`)
    }

    // Test case 2: Multiple rules - both limits enforced
    async function testMultipleRules () {
        console.log('\n=== Test 2: Multiple Rules ===')
        
        const rules: ThrottleRule[] = [
            {
                id: 'requests',
                capacity: 5,
                refillRate: 1 / 200, // 1 request per 200ms
                tokens: 5,
                intervalType: 'SECOND',
                intervalNum: 1
            },
            {
                id: 'weight',
                capacity: 20,
                refillRate: 1 / 100, // 1 weight per 100ms
                tokens: 20,
                intervalType: 'MINUTE',
                intervalNum: 1
            }
        ]
        
        const throttler = new MultiThrottler(rules)
        const start = performance.now()
        
        // Make requests with weight=2, should be limited by request count first
        for (let i = 0; i < 8; i++) {
            await throttler.throttle({ requests: 1, weight: 2 })
        }
        
        const end = performance.now()
        const elapsed = end - start
        
        // Should be limited by request rule (3 extra * 200ms = 600ms)
        const expected = 600
        const passed = Math.abs(elapsed - expected) < delta * 3
        console.log(`Multiple rules test: ${passed ? 'PASSED' : 'FAILED'} - ${elapsed}ms (expected ~${expected}ms)`)
    }

    // Test case 3: Binance-style rate limits
    async function testBinanceStyle () {
        console.log('\n=== Test 3: Binance-style Rate Limits ===')
        
        const rules: ThrottleRule[] = [
            {
                id: 'RAW_REQUESTS',
                capacity: 6000,
                refillRate: 6000 / (60 * 1000), // 6000 per minute
                tokens: 10, // Start with few tokens
                intervalType: 'MINUTE',
                intervalNum: 1
            },
            {
                id: 'REQUEST_WEIGHT',
                capacity: 1200,
                refillRate: 1200 / (60 * 1000), // 1200 per minute
                tokens: 5, // Start with few tokens
                intervalType: 'MINUTE',
                intervalNum: 1
            },
            {
                id: 'ORDERS',
                capacity: 100,
                refillRate: 100 / (10 * 1000), // 100 per 10 seconds
                tokens: 3, // Start with few tokens
                intervalType: 'SECOND',
                intervalNum: 10
            }
        ]
        
        const throttler = new MultiThrottler(rules)
        const start = performance.now()
        
        // Simulate order placement - high weight, uses order limit
        for (let i = 0; i < 6; i++) {
            await throttler.throttle({ 
                RAW_REQUESTS: 1, 
                REQUEST_WEIGHT: 10, 
                ORDERS: 1 
            })
        }
        
        const end = performance.now()
        const elapsed = end - start
        
        // Should be limited by ORDERS (3 extra * 100ms = 300ms)
        const expected = 300
        const passed = Math.abs(elapsed - expected) < delta * 2
        console.log(`Binance-style test: ${passed ? 'PASSED' : 'FAILED'} - ${elapsed}ms (expected ~${expected}ms)`)
    }

    // Test case 4: Rule priority and fallback
    async function testRulePriority () {
        console.log('\n=== Test 4: Rule Priority ===')
        
        const rules: ThrottleRule[] = [
            {
                id: 'strict',
                capacity: 3,
                refillRate: 1 / 500, // Very slow refill
                tokens: 3,
                intervalType: 'SECOND',
                intervalNum: 5
            },
            {
                id: 'lenient',
                capacity: 100,
                refillRate: 1 / 10, // Fast refill
                tokens: 100,
                intervalType: 'MINUTE',
                intervalNum: 1
            }
        ]
        
        const throttler = new MultiThrottler(rules)
        const start = performance.now()
        
        // Should be limited by the strict rule
        for (let i = 0; i < 6; i++) {
            await throttler.throttle({ strict: 1, lenient: 1 })
        }
        
        const end = performance.now()
        const elapsed = end - start
        
        // Should be limited by strict rule (3 extra * 500ms = 1500ms)
        const expected = 1500
        const passed = Math.abs(elapsed - expected) < delta * 5
        console.log(`Rule priority test: ${passed ? 'PASSED' : 'FAILED'} - ${elapsed}ms (expected ~${expected}ms)`)
    }

    // Test case 5: Error handling
    async function testErrorHandling () {
        console.log('\n=== Test 5: Error Handling ===')
        
        const rules: ThrottleRule[] = [
            {
                id: 'test',
                capacity: 1,
                refillRate: 1 / 100,
                tokens: 1,
                intervalType: 'SECOND',
                intervalNum: 1
            }
        ]
        
        const throttler = new MultiThrottler(rules, { maxCapacity: 2 })
        
        try {
            // Fill up the queue beyond capacity
            const promises = []
            for (let i = 0; i < 5; i++) {
                promises.push(throttler.throttle({ test: 1 }))
            }
            console.log('Error handling test: FAILED - Should have thrown error')
        } catch (error) {
            console.log('Error handling test: PASSED - Correctly threw error for queue overflow')
        }
    }

    // Test case 6: Different interval types
    async function testIntervalTypes () {
        console.log('\n=== Test 6: Interval Types ===')
        
        const rules: ThrottleRule[] = [
            {
                id: 'seconds',
                capacity: 2,
                refillRate: 1 / 100, // 1 per 100ms
                tokens: 2,
                intervalType: 'SECOND',
                intervalNum: 1
            },
            {
                id: 'minutes',
                capacity: 5,
                refillRate: 1 / 50, // 1 per 50ms
                tokens: 5,
                intervalType: 'MINUTE',
                intervalNum: 1
            }
        ]
        
        const throttler = new MultiThrottler(rules)
        const start = performance.now()
        
        for (let i = 0; i < 4; i++) {
            await throttler.throttle({ seconds: 1, minutes: 1 })
        }
        
        const end = performance.now()
        const elapsed = end - start
        
        // Should be limited by seconds rule (2 extra * 100ms = 200ms)
        const expected = 200
        const passed = Math.abs(elapsed - expected) < delta
        console.log(`Interval types test: ${passed ? 'PASSED' : 'FAILED'} - ${elapsed}ms (expected ~${expected}ms)`)
    }

    // Run all tests
    async function runAllTests () {
        await testSingleRule()
        await testMultipleRules()
        await testBinanceStyle()
        await testRulePriority()
        await testErrorHandling()
        await testIntervalTypes()
        console.log('\n=== Multi-Throttler Tests Complete ===')
    }

    // Run tests sequentially to avoid interference
    runAllTests()
}

export default testMultiThrottle