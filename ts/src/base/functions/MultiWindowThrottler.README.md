# Multi-Window Rate Throttler

A comprehensive rate limiting solution for CCXT that addresses the limitations of the legacy throttler.

## Key Features

### 1. **Window-Based Configuration**
Configure rate limits using intuitive window specifications instead of abstract refillRates.

```typescript
// Old way (confusing):
{ refillRate: 1/50, capacity: 100 }

// New way (clear):
{ limit: 100, interval: 'minute', intervalNum: 1 }
// Means: 100 requests per 1 minute
```

### 2. **Multiple Parallel Rate Limiters**
Exchanges often have multiple rate limits that must all be satisfied simultaneously.

```typescript
// Binance example: weight-based AND request-count limits
const throttler = new MultiWindowThrottler({
    rateLimits: [
        {
            limit: 1200,           // 1200 weight per minute
            interval: 'minute',
            type: 'weight',
            id: 'REQUEST_WEIGHT_1M',
        },
        {
            limit: 50,             // 50 requests per 10 seconds
            interval: 'second',
            intervalNum: 10,
            type: 'requests',
            id: 'RAW_REQUESTS_10S',
        },
    ],
});
```

### 3. **Dynamic Limit Updates**
Update rate limits in real-time based on exchange response headers.

```typescript
// Update limits from X-MBX-USED-WEIGHT-1M header
const usedWeight = parseInt(response.headers['x-mbx-used-weight-1m']);
throttler.updateLimit('REQUEST_WEIGHT_1M', 1200); // Reset to exchange's current limit

// Or update based on Retry-After header
if (response.status === 429) {
    const retryAfter = parseInt(response.headers['retry-after']);
    // Adjust limits accordingly
}
```

### 4. **Starts at Full Capacity**
Unlike the legacy throttler, this starts ready to send requests immediately.

```typescript
// Old throttler: waits for bucket to fill (users had to wait)
// New throttler: assumes no prior requests, starts at full capacity

await throttler.throttle(); // Immediate - no waiting!
```

### 5. **Intelligent Cost Handling**
Automatically handles different cost types for different limiter types.

```typescript
// When you call throttle(100):
// - Weight limiters count it as 100 weight
// - Request limiters count it as 1 request
// - Order limiters count it as 1 order

await throttler.throttle(100); // High-weight endpoint
// Weight limiter: -100
// Request limiter: -1
```

## API Reference

### `WindowRateLimiter`

Single rate limiter with sliding window algorithm.

```typescript
const limiter = new WindowRateLimiter({
    limit: 60,              // Maximum requests in window
    interval: 'minute',     // Time interval: 'second' | 'minute' | 'hour' | 'day'
    intervalNum: 1,         // Number of intervals (optional, default: 1)
    type: 'requests',       // Type: 'requests' | 'weight' | 'orders'
    id: 'my_limiter',       // Identifier (optional)
});

// Check if request can proceed
if (limiter.canProceed(cost)) {
    limiter.recordRequest(cost);
    // Make request
}

// Get current state
const info = limiter.getInfo();
// {
//   id: 'my_limiter',
//   limit: 60,
//   usage: 25,
//   available: 35,
//   windowMs: 60000
// }
```

### `MultiWindowThrottler`

Manages multiple rate limiters with a queue.

```typescript
const throttler = new MultiWindowThrottler({
    rateLimits: [
        { limit: 100, interval: 'minute', type: 'requests' },
        { limit: 1200, interval: 'minute', type: 'weight' },
    ],
    defaultCost: 1,         // Default cost for requests (optional)
    maxCapacity: 2000,      // Maximum queue size (optional)
    delay: 0.001,           // Polling delay in seconds (optional)
});

// Throttle a request
await throttler.throttle();        // Uses defaultCost
await throttler.throttle(5);       // Custom cost
await throttler.throttle(100);     // High-cost request

// Get info about all limiters
const info = throttler.getInfo();
console.log(info); // Array of limiter states

// Update a limiter dynamically
throttler.updateLimit('weight_limiter_id', 2400);
```

## Usage Examples

### Example 1: Binance-like Configuration

```typescript
import { MultiWindowThrottler } from './base/functions/MultiWindowThrottler.js';

const throttler = new MultiWindowThrottler({
    rateLimits: [
        {
            // Raw request limit
            limit: 1200,
            interval: 'minute',
            type: 'requests',
            id: 'raw_requests',
        },
        {
            // Weight-based limit (heavy endpoints consume more)
            limit: 6000,
            interval: 'minute',
            type: 'weight',
            id: 'request_weight',
        },
        {
            // Short-interval burst protection
            limit: 50,
            interval: 'second',
            intervalNum: 10,
            type: 'requests',
            id: 'burst_protection',
        },
    ],
    defaultCost: 1,
});

// Lightweight endpoint (weight: 1)
await throttler.throttle(1);

// Medium endpoint (weight: 10)
await throttler.throttle(10);

// Heavy endpoint (weight: 40)
await throttler.throttle(40);

// Update from response headers
function updateFromHeaders(headers) {
    const usedWeight = headers['x-mbx-used-weight-1m'];
    if (usedWeight) {
        throttler.updateLimit('request_weight', 6000);
    }
}
```

### Example 2: OKX-like Sub-Account Limits

```typescript
const throttler = new MultiWindowThrottler({
    rateLimits: [
        {
            // Sub-account limit: 1000 orders per 2 seconds
            limit: 1000,
            interval: 'second',
            intervalNum: 2,
            type: 'orders',
            id: 'sub_account_orders',
        },
        {
            // Per-instrument limit
            limit: 60,
            interval: 'second',
            intervalNum: 2,
            type: 'orders',
            id: 'per_instrument_orders',
        },
    ],
});

// Place orders
for (let i = 0; i < 100; i++) {
    await throttler.throttle(1);
    // Place order
}
```

### Example 3: Kraken-like Complex Decay System

```typescript
// For Kraken's complex tier-based system, you can use multiple limiters
const throttler = new MultiWindowThrottler({
    rateLimits: [
        {
            // Starter tier: 60 per minute
            limit: 60,
            interval: 'minute',
            type: 'requests',
            id: 'starter_tier',
        },
    ],
});

// When user upgrades tier, update the limit
function upgradeTier(newTier: 'starter' | 'intermediate' | 'pro') {
    const limits = {
        starter: 60,
        intermediate: 125,
        pro: 180,
    };
    throttler.updateLimit('starter_tier', limits[newTier]);
}
```

### Example 4: Handling 429 Responses

```typescript
async function makeRequest(endpoint, cost = 1) {
    await throttler.throttle(cost);

    try {
        const response = await fetch(endpoint);

        if (response.status === 429) {
            // Rate limited - update from headers
            const retryAfter = response.headers.get('retry-after');
            if (retryAfter) {
                console.log(`Rate limited. Retry after ${retryAfter}s`);
                await new Promise(resolve => setTimeout(resolve, parseInt(retryAfter) * 1000));
            }

            // Optionally: back off by reducing effective limit
            const info = throttler.getInfo();
            for (const limiter of info) {
                throttler.updateLimit(limiter.id, Math.floor(limiter.limit * 0.8));
            }

            // Retry
            return makeRequest(endpoint, cost);
        }

        return response;
    } catch (error) {
        throw error;
    }
}
```

### Example 5: Monitoring and Metrics

```typescript
// Periodically log throttler status
setInterval(() => {
    const info = throttler.getInfo();
    for (const limiter of info) {
        const percentUsed = (limiter.usage / limiter.limit * 100).toFixed(1);
        console.log(
            `${limiter.id}: ${limiter.usage}/${limiter.limit} ` +
            `(${percentUsed}% used, ${limiter.available} available)`
        );
    }
}, 10000); // Every 10 seconds
```

## Interval Types

The throttler supports four interval types matching exchange specifications:

| Interval   | Duration | Exchange Letter |
|-----------|----------|-----------------|
| `second`  | 1 second | S               |
| `minute`  | 60 seconds | M             |
| `hour`    | 3600 seconds | H           |
| `day`     | 86400 seconds | D          |

Use `intervalNum` to multiply the interval:

```typescript
{ interval: 'second', intervalNum: 5 }  // 5 seconds
{ interval: 'minute', intervalNum: 15 } // 15 minutes
```

## Rate Limiter Types

### `requests`
Counts each API call as 1 request, regardless of the cost parameter.

```typescript
await throttler.throttle(100); // Counts as 1 request
```

### `weight`
Uses the cost parameter as weight. Heavy endpoints consume more weight.

```typescript
await throttler.throttle(100); // Counts as 100 weight
```

### `orders`
Similar to requests, counts each order-related operation as 1.

```typescript
await throttler.throttle(1); // Counts as 1 order
```

## Migration from Legacy Throttler

### Old Configuration
```typescript
const throttler = new Throttler({
    refillRate: 1/50,    // 1 token per 50ms = 20 per second
    capacity: 100,       // Max burst
    tokens: 0,           // Start empty (users wait)
});
```

### New Configuration
```typescript
const throttler = new MultiWindowThrottler({
    rateLimits: [
        {
            limit: 20,
            interval: 'second',
            type: 'requests',
        },
    ],
});
// Starts at full capacity - no waiting!
```

## Performance Considerations

1. **Sliding Window**: Uses true sliding window algorithm for accurate rate limiting
2. **Efficient Pruning**: Automatically removes old requests from tracking
3. **Minimal Overhead**: Checks are O(n) where n is the number of requests in the current window
4. **Memory Efficient**: Old requests are pruned regularly

## Error Handling

### Queue Overflow
```typescript
try {
    await throttler.throttle();
} catch (error) {
    if (error.message.includes('maxCapacity')) {
        console.error('Too many requests queued');
        // Handle queue overflow
    }
}
```

### Rate Limit Exceeded
The throttler handles rate limits by queuing requests automatically. However, you should still handle 429 responses from the exchange:

```typescript
if (response.status === 429) {
    // Exchange rate limited despite throttler
    // This can happen if:
    // 1. Limits were configured incorrectly
    // 2. Exchange changed limits
    // 3. Multiple API clients sharing same limits
}
```

## Testing

Comprehensive tests are included in `test.MultiWindowThrottler.ts`. Run with:

```bash
npx tsx ts/src/test/base/language_specific/test.MultiWindowThrottler.ts
```

All tests include:
- Basic window rate limiting
- Weight-based limiting
- Multiple parallel limiters
- Dynamic limit updates
- Sliding window behavior
- Queue overflow protection
- Real-world exchange scenarios

## Best Practices

1. **Configure Conservatively**: Set limits slightly below exchange limits to account for timing variations
2. **Monitor Usage**: Use `getInfo()` to track usage patterns
3. **Handle 429s**: Always handle rate limit responses from exchanges
4. **Update Dynamically**: Use response headers to stay in sync with exchange limits
5. **Use Appropriate Types**: Match limiter types to exchange specifications

## License

MIT License - Same as CCXT
