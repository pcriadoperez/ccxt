# Custom Throttler Support for CCXT

This document describes the custom throttler feature that allows users to implement their own rate limiting logic when initializing exchanges in CCXT.

## Overview

The custom throttler feature enables users to pass their own throttler implementation when creating an exchange instance. This allows for:

- Custom rate limiting strategies
- Exchange-specific throttling rules
- Adaptive throttling based on response times
- Integration with external rate limiting services
- Fine-grained control over request timing

## Supported Languages

- **TypeScript/JavaScript**
- **Python**
- **Go**
- **C#**

## Usage

### TypeScript/JavaScript

```typescript
import ccxt from 'ccxt';

// Define a custom throttler
class MyCustomThrottler implements CustomThrottler {
    async throttle(cost?: number): Promise<void> {
        // Your custom throttling logic here
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Use the custom throttler
const exchange = new ccxt.binance({
    customThrottler: new MyCustomThrottler(),
    enableRateLimit: true
});
```

### Python

```python
import ccxt
import asyncio

# Define a custom throttler
class MyCustomThrottler(ccxt.base.throttle.CustomThrottler):
    async def throttle(self, cost=None):
        # Your custom throttling logic here
        await asyncio.sleep(1.0)

# Use the custom throttler
exchange = ccxt.binance({
    'customThrottler': MyCustomThrottler(),
    'enableRateLimit': True
})
```

### Go

```go
package main

import (
    "context"
    "time"
    "github.com/ccxt/ccxt/go/v4"
)

// Define a custom throttler
type MyCustomThrottler struct{}

func (t *MyCustomThrottler) Throttle(ctx context.Context, cost float64) error {
    // Your custom throttling logic here
    time.Sleep(time.Second)
    return nil
}

// Use the custom throttler
exchange := ccxt.NewBinance(map[string]interface{}{
    "customThrottler": &MyCustomThrottler{},
    "enableRateLimit": true,
})
```

### C#

```csharp
using ccxt;
using System.Threading.Tasks;

// Define a custom throttler
public class MyCustomThrottler : ICustomThrottler
{
    public async Task Throttle(object cost = null)
    {
        // Your custom throttling logic here
        await Task.Delay(1000);
    }
}

// Use the custom throttler
var exchange = new Binance(new Dictionary<string, object>
{
    { "customThrottler", new MyCustomThrottler() },
    { "enableRateLimit", true }
});
```

## Interface Definitions

### TypeScript/JavaScript

```typescript
interface CustomThrottler {
    throttle(cost?: number): Promise<void>;
}
```

### Python

```python
class CustomThrottler(ABC):
    @abstractmethod
    async def throttle(self, cost: Optional[float] = None) -> None:
        pass
```

### Go

```go
type CustomThrottler interface {
    Throttle(ctx context.Context, cost float64) error
}
```

### C#

```csharp
public interface ICustomThrottler
{
    Task Throttle(object cost = null);
}
```

## Example Implementations

### 1. Simple Delay Throttler

A basic throttler that adds a fixed delay between requests.

**TypeScript:**
```typescript
class SimpleDelayThrottler implements CustomThrottler {
    private delayMs: number;

    constructor(delayMs: number = 1000) {
        this.delayMs = delayMs;
    }

    async throttle(cost?: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
}
```

**Python:**
```python
class SimpleDelayThrottler(CustomThrottler):
    def __init__(self, delay_seconds=1.0):
        self.delay_seconds = delay_seconds
    
    async def throttle(self, cost=None):
        await asyncio.sleep(self.delay_seconds)
```

**Go:**
```go
type SimpleDelayThrottler struct {
    delayMs int64
}

func (t *SimpleDelayThrottler) Throttle(ctx context.Context, cost float64) error {
    time.Sleep(time.Duration(t.delayMs) * time.Millisecond)
    return nil
}
```

**C#:**
```csharp
public class SimpleDelayThrottler : ICustomThrottler
{
    private readonly int delayMs;

    public SimpleDelayThrottler(int delayMs = 1000)
    {
        this.delayMs = delayMs;
    }

    public async Task Throttle(object cost = null)
    {
        await Task.Delay(delayMs);
    }
}
```

### 2. Token Bucket Throttler

A more sophisticated throttler that implements token bucket algorithm.

**TypeScript:**
```typescript
class TokenBucketThrottler implements CustomThrottler {
    private tokens: number;
    private capacity: number;
    private refillRate: number;
    private lastRefill: number;

    constructor(capacity: number = 10, refillRate: number = 1) {
        this.tokens = capacity;
        this.capacity = capacity;
        this.refillRate = refillRate;
        this.lastRefill = Date.now();
    }

    async throttle(cost: number = 1): Promise<void> {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        const tokensToAdd = elapsed * this.refillRate;
        this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
        this.lastRefill = now;

        if (this.tokens < cost) {
            const waitTime = (cost - this.tokens) / this.refillRate * 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.tokens = 0;
        } else {
            this.tokens -= cost;
        }
    }
}
```

### 3. Adaptive Throttler

A throttler that adjusts its behavior based on success/error rates.

**TypeScript:**
```typescript
class AdaptiveThrottler implements CustomThrottler {
    private baseDelay: number;
    private maxDelay: number;
    private currentDelay: number;
    private successCount: number = 0;
    private errorCount: number = 0;

    constructor(baseDelay: number = 100, maxDelay: number = 2000) {
        this.baseDelay = baseDelay;
        this.maxDelay = maxDelay;
        this.currentDelay = baseDelay;
    }

    async throttle(cost?: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, this.currentDelay));
    }

    onSuccess(): void {
        this.successCount++;
        if (this.successCount >= 5) {
            this.currentDelay = Math.max(this.baseDelay, this.currentDelay / 2);
            this.successCount = 0;
            this.errorCount = 0;
        }
    }

    onError(): void {
        this.errorCount++;
        if (this.errorCount >= 3) {
            this.currentDelay = Math.min(this.maxDelay, this.currentDelay * 2);
            this.successCount = 0;
            this.errorCount = 0;
        }
    }
}
```

### 4. Exchange-Aware Throttler

A throttler that applies different rates for different exchanges.

**TypeScript:**
```typescript
class ExchangeAwareThrottler implements CustomThrottler {
    private exchangeRates: Map<string, number>;
    private defaultRate: number;

    constructor() {
        this.exchangeRates = new Map([
            ['binance', 100],
            ['coinbase', 500],
            ['kraken', 200]
        ]);
        this.defaultRate = 1000;
    }

    async throttle(cost?: number, exchangeId?: string): Promise<void> {
        const rate = exchangeId ? this.exchangeRates.get(exchangeId) || this.defaultRate : this.defaultRate;
        await new Promise(resolve => setTimeout(resolve, rate));
    }
}
```

## Integration with Exchange Methods

The custom throttler is automatically used by the exchange when making API calls. The exchange will call your throttler's `throttle` method before each request.

### Example with API Calls

```typescript
// Create exchange with custom throttler
const exchange = new ccxt.binance({
    customThrottler: new MyCustomThrottler(),
    enableRateLimit: true
});

// These calls will use your custom throttler
const ticker = await exchange.fetchTicker('BTC/USDT');
const orderbook = await exchange.fetchOrderBook('BTC/USDT');
```

## Best Practices

1. **Thread Safety**: Ensure your throttler implementation is thread-safe if used in multi-threaded environments.

2. **Error Handling**: Handle errors gracefully in your throttler implementation.

3. **Context Awareness**: Use the `cost` parameter to implement different throttling strategies based on request cost.

4. **Performance**: Keep your throttler implementation efficient to avoid adding unnecessary overhead.

5. **Logging**: Consider adding logging to your throttler for debugging and monitoring.

## Migration from Default Throttler

If you're currently using the default throttler and want to switch to a custom one:

1. Implement the `CustomThrottler` interface for your language
2. Pass your custom throttler instance in the exchange configuration
3. Set `enableRateLimit: true` to ensure throttling is enabled
4. Test your implementation thoroughly

## Troubleshooting

### Common Issues

1. **Throttler not being called**: Ensure `enableRateLimit` is set to `true`
2. **Type errors**: Make sure your throttler implements the correct interface
3. **Performance issues**: Check that your throttler implementation is efficient
4. **Thread safety issues**: Use proper synchronization in multi-threaded environments

### Debugging

Add logging to your throttler to debug issues:

```typescript
class DebugThrottler implements CustomThrottler {
    async throttle(cost?: number): Promise<void> {
        console.log(`Throttling request with cost: ${cost}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('Throttling complete');
    }
}
```

## Examples Directory

Complete working examples for each language can be found in:

- TypeScript: `/examples/ts/custom-throttler.ts`
- Python: `/examples/py/custom-throttler.py`
- Go: `/examples/go/custom-throttler.go`
- C#: `/examples/cs/CustomThrottler.cs`

## Contributing

When contributing custom throttler implementations:

1. Follow the interface definitions exactly
2. Include comprehensive error handling
3. Add unit tests for your implementation
4. Document any additional features or parameters
5. Ensure thread safety for concurrent usage

## License

This feature is part of the CCXT library and follows the same licensing terms.