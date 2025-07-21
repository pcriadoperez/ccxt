# CCXT Throttle System Refactor

## Overview
Successfully refactored the CCXT throttle system to support multi-rule rate limiting while maintaining full backward compatibility. The architecture now separates concerns: logic is in the base Exchange class, while weight configurations remain in exchange-specific files.

## Key Changes

### 1. Enhanced Throttler (`ts/src/base/functions/throttle.ts`)
- **Replaced** the single-rule throttler with a unified throttler supporting both single and multi-rule scenarios
- **Added** interfaces `ThrottleRule` and `ThrottleCost` for type safety
- **Maintains** full backward compatibility with existing single-rule configurations
- **Auto-detects** whether to use single or multi-rule mode based on initialization

### 2. Enhanced Exchange Base Class (`ts/src/base/Exchange.ts`)
- **Added** logic in `initThrottler()` to automatically initialize multi-rule throttling when `rateLimits` are defined
- **Enhanced** `calculateRateLimiterCost()` to handle multi-rule cost calculations
- **Added** `getRateLimitStatus()` and `updateRateLimitsFromHeaders()` methods
- **Added** `isOrderEndpoint()` method for automatic order endpoint detection
- **Integrated** header-based rate limit updates in `fetch2()`

### 3. Simplified Binance Implementation (`ts/src/binance.ts`)
- **Removed** all custom throttling logic (moved to base Exchange class)
- **Kept only** weight configurations and Binance-specific header update logic
- **Added** `rateLimits` configuration with three rules:
  - `RAW_REQUESTS`: 6000 per minute
  - `REQUEST_WEIGHT`: 1200 per minute  
  - `ORDERS`: 100 per 10 seconds
- **Updated** endpoint configurations with multi-rule costs

## Architecture Benefits

### ✅ **Clean Separation of Concerns**
- **Logic**: Base Exchange class handles all throttling logic
- **Configuration**: Exchange-specific files contain only weight configurations
- **Headers**: Exchange-specific overrides for response header parsing

### ✅ **Full Backward Compatibility**
- **Legacy exchanges** without `rateLimits` continue using single-rule throttling
- **Legacy endpoints** with `{ cost: 10 }` automatically work with multi-rule throttling
- **Existing code** requires no changes

### ✅ **Automatic Multi-Rule Support**
- **Any exchange** can add `rateLimits` configuration to enable multi-rule throttling
- **Legacy costs** are automatically converted to multi-rule format
- **Order endpoints** automatically get `ORDERS` cost added

## Usage Examples

### Multi-Rule Endpoint Configuration
```typescript
// In binance.ts API configuration
'order': {
    'RAW_REQUESTS': 1,
    'REQUEST_WEIGHT': 4,
    'ORDERS': 1
},

// Legacy configuration (still works)
'account': 20
```

### Conditional Costs
```typescript
'openOrders': {
    'RAW_REQUESTS': 1,
    'REQUEST_WEIGHT': { 'default': 6, 'noSymbol': 80 },
    'ORDERS': 1
}
```

### Rate Limit Monitoring
```typescript
const exchange = new binance();
const status = exchange.getRateLimitStatus();
console.log(status);
// {
//   RAW_REQUESTS: { tokens: 5999, capacity: 6000, utilization: 0.0002 },
//   REQUEST_WEIGHT: { tokens: 1196, capacity: 1200, utilization: 0.0033 },
//   ORDERS: { tokens: 99, capacity: 100, utilization: 0.01 }
// }
```

## Implementation Details

### Rate Limit Configuration
```typescript
'rateLimits': [
    {
        'id': 'RAW_REQUESTS',
        'capacity': 6000,
        'refillRate': 6000 / (60 * 1000), // 6000 per minute
        'intervalType': 'MINUTE',
        'intervalNum': 1,
        'description': 'Total requests per minute'
    },
    // ... more rules
]
```

### Automatic Legacy Conversion
- Single cost `20` becomes `{ RAW_REQUESTS: 1, REQUEST_WEIGHT: 20 }`
- Order endpoints automatically get `ORDERS: 1` added
- Complex cost calculations (byLimit, noSymbol, etc.) work with each rule

### Header-Based Updates
- Response headers automatically update token counts
- Exchange-specific patterns supported (e.g., `x-mbx-used-weight-1m`)
- Real-time rate limit tracking without API calls

## Testing
Comprehensive testing verified:
- ✅ Multi-rule cost calculation
- ✅ Legacy cost conversion  
- ✅ Conditional costs based on parameters
- ✅ Order endpoint auto-detection
- ✅ Response header integration
- ✅ Backward compatibility

## Migration Path
1. **Immediate**: All existing exchanges continue working unchanged
2. **Gradual**: Exchanges can add `rateLimits` configuration when needed
3. **Future**: Endpoint costs can be enhanced with multi-rule specifications

This refactor provides a solid foundation for supporting complex API rate limiting requirements while maintaining the simplicity and backward compatibility that CCXT users expect.