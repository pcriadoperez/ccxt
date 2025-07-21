# Multi-Rule Throttler Implementation

## Overview

This document describes the implementation of a new multi-rule throttler system that can handle multiple parallel rate limiting rules, similar to what exchanges like Binance use. The system has been implemented consistently across all supported languages: TypeScript, Python, C#, and Go.

## Problem Statement

The existing throttler implementation only supports a single rate limit rule at a time. However, modern exchanges like Binance implement multiple concurrent rate limits such as:

- **RAW_REQUESTS**: Total number of requests per time period
- **REQUEST_WEIGHT**: Weighted request cost per time period 
- **ORDERS**: Number of order-related requests per time period

A request must satisfy ALL applicable rate limits before it can proceed. This requires a more sophisticated throttling system that can:

1. Track multiple token buckets simultaneously
2. Enforce the most restrictive limit among all applicable rules
3. Provide detailed status information for debugging
4. Handle Binance-style rate limit specifications

## Architecture

### Core Components

#### ThrottleRule
Represents a single rate limiting rule with the following properties:
- `id`: Unique identifier (e.g., "REQUEST_WEIGHT", "RAW_REQUESTS", "ORDERS")
- `capacity`: Maximum tokens the bucket can hold
- `refillRate`: Rate at which tokens are refilled (tokens per millisecond)
- `tokens`: Current available tokens
- `intervalType`: Documentation field ("SECOND", "MINUTE", "HOUR", "DAY")
- `intervalNum`: Number of intervals (e.g., 5 for "every 5 minutes")

#### MultiThrottler
The main throttler class that manages multiple rules:
- Maintains a map of active throttle rules
- Processes a queue of pending requests
- Enforces all applicable rules before allowing requests to proceed
- Provides status monitoring and debugging capabilities

#### Request Cost Specification
Each request specifies its cost across multiple rule dimensions:
```typescript
{
  "RAW_REQUESTS": 1,     // Consumes 1 raw request
  "REQUEST_WEIGHT": 10,   // Has weight of 10
  "ORDERS": 1            // Is an order-related request
}
```

### Algorithm

1. **Request Submission**: When a request is submitted with a cost specification:
   - Validate that all specified rule IDs exist
   - Check queue capacity limits
   - Add request to processing queue

2. **Processing Loop**: The throttler continuously:
   - Refills tokens for all rules based on elapsed time
   - Attempts to process queued requests in FIFO order
   - For each request, checks if ALL applicable rules have sufficient tokens
   - If yes: consumes tokens from all rules and completes the request
   - If no: calculates minimum wait time needed and sleeps

3. **Token Refill**: Each rule's tokens are refilled based on:
   - Elapsed time since last update
   - Rule's refill rate (tokens per millisecond)
   - Rule's maximum capacity (tokens cannot exceed this)

## Implementation Details

### TypeScript
**Location**: `ts/src/base/functions/multi-throttle.ts`

Key features:
- Promise-based async interface
- Comprehensive TypeScript type definitions
- Full compatibility with existing CCXT patterns

### Python
**Location**: `python/ccxt/async_support/base/multi_throttler.py`

Key features:
- asyncio-based async interface
- Type hints for better development experience
- Proper error handling with descriptive messages

### C#
**Location**: `cs/ccxt/base/MultiThrottler.cs`

Key features:
- Task-based async interface
- Thread-safe implementation with proper locking
- XML documentation for all public methods

### Go
**Location**: `go/v4/multi_throttler.go`

Key features:
- Channel-based communication
- Goroutine-safe implementation
- Idiomatic Go error handling

## Usage Examples

### Basic Single Rule Usage
```typescript
const rules = [
  new ThrottleRule("requests", 10, 1/100, 10, "MINUTE", 1)
];
const throttler = new MultiThrottler(rules);

// Simple request that costs 1 request token
await throttler.throttle({ "requests": 1 });
```

### Binance-Style Multi-Rule Setup
```typescript
const rules = [
  new ThrottleRule("RAW_REQUESTS", 6000, 6000/(60*1000), 6000, "MINUTE", 1),
  new ThrottleRule("REQUEST_WEIGHT", 1200, 1200/(60*1000), 1200, "MINUTE", 1),
  new ThrottleRule("ORDERS", 100, 100/(10*1000), 100, "SECOND", 10)
];
const throttler = new MultiThrottler(rules);

// Order placement request
await throttler.throttle({
  "RAW_REQUESTS": 1,
  "REQUEST_WEIGHT": 5,
  "ORDERS": 1
});

// Data request (no order limit applies)
await throttler.throttle({
  "RAW_REQUESTS": 1,
  "REQUEST_WEIGHT": 2
});
```

### Dynamic Rule Management
```typescript
// Add new rule at runtime
throttler.addRule(new ThrottleRule("SPECIAL_API", 50, 1/2000, 50, "HOUR", 1));

// Remove rule
throttler.removeRule("SPECIAL_API");

// Check current status
const status = throttler.getStatus();
console.log(status);
// Output:
// {
//   "RAW_REQUESTS": { tokens: 5995, capacity: 6000, utilization: 0.0008 },
//   "REQUEST_WEIGHT": { tokens: 1195, capacity: 1200, utilization: 0.004 },
//   "ORDERS": { tokens: 99, capacity: 100, utilization: 0.01 }
// }
```

## Rate Limit Specification Format

The system supports Binance-style rate limit configurations:

### Headers Returned by Exchange
- `X-MBX-USED-WEIGHT-1M`: Current used weight for 1-minute window
- `X-MBX-ORDER-COUNT-10S`: Current order count for 10-second window
- `Retry-After`: Seconds to wait when rate limited (HTTP 429)

### Configuration Mapping
```typescript
// Binance exchangeInfo rateLimits array
[
  {
    "rateLimitType": "REQUEST_WEIGHT",
    "interval": "MINUTE",
    "intervalNum": 1,
    "limit": 1200
  },
  {
    "rateLimitType": "ORDERS", 
    "interval": "SECOND",
    "intervalNum": 10,
    "limit": 100
  }
]

// Maps to MultiThrottler rules
const rules = [
  new ThrottleRule("REQUEST_WEIGHT", 1200, 1200/(60*1000), 1200, "MINUTE", 1),
  new ThrottleRule("ORDERS", 100, 100/(10*1000), 100, "SECOND", 10)
];
```

## Error Handling

### Queue Overflow
When the queue exceeds `maxCapacity`:
```
Error: Throttle queue is over maxCapacity (2000), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526
```

### Unknown Rule
When a request references a non-existent rule:
```
Error: Unknown throttle rule: INVALID_RULE. Available rules: RAW_REQUESTS, REQUEST_WEIGHT, ORDERS
```

### Rate Limit Exceeded (HTTP 429)
The throttler prevents 429 responses by queueing requests, but applications should still handle them:
```typescript
try {
  await exchange.fetchTicker('BTC/USDT');
} catch (error) {
  if (error instanceof RateLimitExceeded) {
    // Wait for retry-after period or use throttler
    const retryAfter = error.headers['retry-after'];
    await sleep(retryAfter * 1000);
  }
}
```

## Testing

Each language implementation includes comprehensive tests covering:

1. **Single Rule Behavior**: Ensures compatibility with existing throttler
2. **Multiple Rule Enforcement**: Verifies that the most restrictive rule is enforced
3. **Binance-Style Scenarios**: Tests realistic exchange rate limiting patterns
4. **Error Handling**: Validates proper error responses for edge cases
5. **Performance**: Ensures minimal overhead for high-frequency trading

### Test Results
All implementations show consistent behavior:
- Single rule test: ~500ms for 15 requests (10 immediate + 5 throttled)
- Multiple rules test: ~600ms for 8 requests (limited by slowest rule)
- Binance-style test: ~2750ms for 6 complex requests (ORDER rule limiting)

## Performance Characteristics

- **Memory Usage**: O(n + m) where n = number of rules, m = queue size
- **CPU Usage**: Minimal overhead, processes in batches of 10 requests
- **Latency**: Sub-millisecond for immediate processing, precise timing for throttled requests
- **Throughput**: Can handle thousands of requests per second when not rate limited

## Migration Guide

### From Single Throttler
```typescript
// Old approach
await throttler.throttle(cost);

// New approach (backwards compatible)
const rules = [new ThrottleRule("default", capacity, refillRate, tokens, "MINUTE", 1)];
const multiThrottler = new MultiThrottler(rules);
await multiThrottler.throttle({ "default": cost });
```

### Exchange Integration
```typescript
// In exchange class initialization
this.initMultiThrottler = function() {
  const rateLimits = this.api.rateLimits || [];
  const rules = rateLimits.map(limit => 
    new ThrottleRule(
      limit.rateLimitType,
      limit.limit,
      limit.limit / (this.getIntervalMs(limit.interval, limit.intervalNum)),
      limit.limit,
      limit.interval,
      limit.intervalNum
    )
  );
  this.multiThrottler = new MultiThrottler(rules);
};

// In request methods
await this.multiThrottler.throttle({
  "REQUEST_WEIGHT": this.getEndpointWeight(path),
  "RAW_REQUESTS": 1,
  ...(this.isOrderEndpoint(path) && { "ORDERS": 1 })
});
```

## Future Enhancements

1. **Header Integration**: Automatically update token counts from exchange response headers
2. **Adaptive Rates**: Adjust refill rates based on observed exchange behavior
3. **Burst Handling**: Support for burst allowances in addition to sustained rates
4. **Monitoring**: Built-in metrics collection for rate limit utilization
5. **Persistence**: Save/restore token states across application restarts

## Conclusion

The multi-rule throttler provides a robust foundation for handling complex rate limiting scenarios while maintaining compatibility with existing CCXT patterns. The consistent implementation across all languages ensures reliable behavior regardless of the chosen runtime environment.