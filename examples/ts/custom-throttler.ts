import ccxt from 'ccxt';
import { CustomThrottler } from '../src/base/functions/throttle.js';

// Example 1: Simple delay-based throttler
class SimpleDelayThrottler implements CustomThrottler {
    private delayMs: number;

    constructor(delayMs: number = 1000) {
        this.delayMs = delayMs;
    }

    async throttle(cost?: number): Promise<void> {
        // Simple delay regardless of cost
        await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }
}

// Example 2: Token bucket throttler with custom logic
class CustomTokenBucketThrottler implements CustomThrottler {
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
        // Refill tokens based on time passed
        const now = Date.now();
        const timePassed = (now - this.lastRefill) / 1000; // seconds
        this.tokens = Math.min(this.capacity, this.tokens + timePassed * this.refillRate);
        this.lastRefill = now;

        // If not enough tokens, wait
        if (this.tokens < cost) {
            const waitTime = ((cost - this.tokens) / this.refillRate) * 1000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.tokens = 0;
        } else {
            this.tokens -= cost;
        }
    }
}

// Example 3: Adaptive throttler that adjusts based on response times
class AdaptiveThrottler implements CustomThrottler {
    private baseDelay: number;
    private maxDelay: number;
    private currentDelay: number;
    private successCount: number;
    private errorCount: number;

    constructor(baseDelay: number = 100, maxDelay: number = 5000) {
        this.baseDelay = baseDelay;
        this.maxDelay = maxDelay;
        this.currentDelay = baseDelay;
        this.successCount = 0;
        this.errorCount = 0;
    }

    async throttle(cost?: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, this.currentDelay));
    }

    // Method to be called after each request
    onSuccess(): void {
        this.successCount++;
        if (this.successCount >= 10) {
            // Reduce delay on success
            this.currentDelay = Math.max(this.baseDelay, this.currentDelay * 0.9);
            this.successCount = 0;
        }
    }

    onError(): void {
        this.errorCount++;
        if (this.errorCount >= 3) {
            // Increase delay on errors
            this.currentDelay = Math.min(this.maxDelay, this.currentDelay * 1.5);
            this.errorCount = 0;
        }
    }
}

// Example 4: Rate limiter that respects exchange-specific limits
class ExchangeAwareThrottler implements CustomThrottler {
    private exchangeId: string;
    private limits: Map<string, { requests: number; window: number; lastReset: number }>;

    constructor(exchangeId: string) {
        this.exchangeId = exchangeId;
        this.limits = new Map();
        this.initializeLimits();
    }

    private initializeLimits(): void {
        // Example limits for different exchanges
        const exchangeLimits = {
            'binance': { requests: 1200, window: 60000 }, // 1200 requests per minute
            'coinbase': { requests: 30, window: 1000 },   // 30 requests per second
            'kraken': { requests: 15, window: 1000 },     // 15 requests per second
        };

        const limit = exchangeLimits[this.exchangeId as keyof typeof exchangeLimits];
        if (limit) {
            this.limits.set('default', {
                requests: limit.requests,
                window: limit.window,
                lastReset: Date.now()
            });
        }
    }

    async throttle(cost: number = 1): Promise<void> {
        const limit = this.limits.get('default');
        if (!limit) {
            // No specific limit, use default delay
            await new Promise(resolve => setTimeout(resolve, 100));
            return;
        }

        const now = Date.now();
        
        // Reset counter if window has passed
        if (now - limit.lastReset > limit.window) {
            limit.requests = limit.requests;
            limit.lastReset = now;
        }

        // If we've exceeded the limit, wait
        if (limit.requests <= 0) {
            const waitTime = limit.window - (now - limit.lastReset);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            limit.requests = limit.requests;
            limit.lastReset = Date.now();
        }

        limit.requests -= cost;
    }
}

// Usage examples
async function exampleUsage() {
    // Example 1: Using simple delay throttler
    const exchange1 = new ccxt.binance({
        customThrottler: new SimpleDelayThrottler(500) // 500ms delay between requests
    });

    // Example 2: Using custom token bucket throttler
    const exchange2 = new ccxt.coinbase({
        customThrottler: new CustomTokenBucketThrottler(20, 2) // 20 tokens, 2 per second refill
    });

    // Example 3: Using adaptive throttler
    const adaptiveThrottler = new AdaptiveThrottler(100, 2000);
    const exchange3 = new ccxt.kraken({
        customThrottler: adaptiveThrottler
    });

    // Example 4: Using exchange-aware throttler
    const exchange4 = new ccxt.binance({
        customThrottler: new ExchangeAwareThrottler('binance')
    });

    try {
        // Use the exchanges with custom throttlers
        const ticker1 = await exchange1.fetchTicker('BTC/USDT');
        console.log('Ticker 1:', ticker1.symbol);

        const ticker2 = await exchange2.fetchTicker('BTC/USDT');
        console.log('Ticker 2:', ticker2.symbol);

        const ticker3 = await exchange3.fetchTicker('BTC/USDT');
        console.log('Ticker 3:', ticker3.symbol);
        adaptiveThrottler.onSuccess(); // Report success

        const ticker4 = await exchange4.fetchTicker('BTC/USDT');
        console.log('Ticker 4:', ticker4.symbol);

    } catch (error) {
        console.error('Error:', error);
        adaptiveThrottler.onError(); // Report error for adaptive throttler
    }
}

// Run the example
exampleUsage().catch(console.error);