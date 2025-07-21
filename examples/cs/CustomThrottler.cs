using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using ccxt;

namespace CustomThrottlerExamples
{
    // Example 1: Simple delay-based throttler
    public class SimpleDelayThrottler : ICustomThrottler
    {
        private readonly int delayMs;

        public SimpleDelayThrottler(int delayMs = 1000)
        {
            this.delayMs = delayMs;
        }

        public async Task Throttle(object cost = null)
        {
            // Simple delay regardless of cost
            await Task.Delay(delayMs);
        }
    }

    // Example 2: Token bucket throttler with custom logic
    public class CustomTokenBucketThrottler : ICustomThrottler
    {
        private double tokens;
        private readonly double capacity;
        private readonly double refillRate;
        private DateTime lastRefill;
        private readonly object lockObject = new object();

        public CustomTokenBucketThrottler(double capacity = 10.0, double refillRate = 1.0)
        {
            this.tokens = capacity;
            this.capacity = capacity;
            this.refillRate = refillRate;
            this.lastRefill = DateTime.UtcNow;
        }

        public async Task Throttle(object cost = null)
        {
            double requestCost = cost != null ? Convert.ToDouble(cost) : 1.0;

            lock (lockObject)
            {
                // Refill tokens
                var now = DateTime.UtcNow;
                var elapsed = (now - lastRefill).TotalSeconds;
                var tokensToAdd = elapsed * refillRate;
                tokens = Math.Min(capacity, tokens + tokensToAdd);
                lastRefill = now;

                // Check if we have enough tokens
                if (tokens < requestCost)
                {
                    // Calculate wait time
                    var waitTime = (requestCost - tokens) / refillRate;
                    tokens = 0;
                    
                    // Wait outside the lock
                    Task.Delay(TimeSpan.FromSeconds(waitTime)).Wait();
                }
                else
                {
                    tokens -= requestCost;
                }
            }
        }
    }

    // Example 3: Adaptive throttler that adjusts based on response times
    public class AdaptiveThrottler : ICustomThrottler
    {
        private TimeSpan baseDelay;
        private TimeSpan maxDelay;
        private TimeSpan currentDelay;
        private int successCount;
        private int errorCount;
        private readonly object lockObject = new object();

        public AdaptiveThrottler(TimeSpan baseDelay, TimeSpan maxDelay)
        {
            this.baseDelay = baseDelay;
            this.maxDelay = maxDelay;
            this.currentDelay = baseDelay;
        }

        public async Task Throttle(object cost = null)
        {
            TimeSpan delay;
            lock (lockObject)
            {
                delay = currentDelay;
            }

            await Task.Delay(delay);
        }

        public void OnSuccess()
        {
            lock (lockObject)
            {
                successCount++;
                if (successCount >= 5)
                {
                    // Reduce delay on success
                    currentDelay = TimeSpan.FromMilliseconds(Math.Max(baseDelay.TotalMilliseconds, currentDelay.TotalMilliseconds / 2));
                    successCount = 0;
                    errorCount = 0;
                }
            }
        }

        public void OnError()
        {
            lock (lockObject)
            {
                errorCount++;
                if (errorCount >= 3)
                {
                    // Increase delay on errors
                    currentDelay = TimeSpan.FromMilliseconds(Math.Min(maxDelay.TotalMilliseconds, currentDelay.TotalMilliseconds * 2));
                    successCount = 0;
                    errorCount = 0;
                }
            }
        }
    }

    // Example 4: Exchange-aware throttler
    public class ExchangeAwareThrottler : ICustomThrottler
    {
        private readonly Dictionary<string, TimeSpan> exchangeRates;
        private readonly TimeSpan defaultRate;
        private readonly object lockObject = new object();

        public ExchangeAwareThrottler()
        {
            exchangeRates = new Dictionary<string, TimeSpan>
            {
                { "binance", TimeSpan.FromMilliseconds(100) },
                { "coinbase", TimeSpan.FromMilliseconds(500) },
                { "kraken", TimeSpan.FromMilliseconds(200) }
            };
            defaultRate = TimeSpan.FromMilliseconds(1000);
        }

        public async Task Throttle(object cost = null)
        {
            // Use default rate (in real implementation, you'd get exchange name from context)
            await Task.Delay(defaultRate);
        }

        public TimeSpan GetRateForExchange(string exchangeId)
        {
            lock (lockObject)
            {
                return exchangeRates.TryGetValue(exchangeId, out var rate) ? rate : defaultRate;
            }
        }
    }

    class Program
    {
        static async Task Main(string[] args)
        {
            Console.WriteLine("=== CCXT C# Custom Throttler Examples ===\n");

            // Example 1: Simple delay throttler
            Console.WriteLine("1. Simple Delay Throttler Example:");
            var simpleThrottler = new SimpleDelayThrottler(500); // 500ms delay
            
            // Create exchange with custom throttler
            var exchange = new Binance(new Dictionary<string, object>
            {
                { "customThrottler", simpleThrottler },
                { "enableRateLimit", true }
            });

            // Test the throttler
            var start = DateTime.UtcNow;
            await simpleThrottler.Throttle(1.0);
            var elapsed = DateTime.UtcNow - start;
            Console.WriteLine($"   Throttled request took: {elapsed.TotalMilliseconds:F0}ms");

            // Example 2: Token bucket throttler
            Console.WriteLine("\n2. Token Bucket Throttler Example:");
            var tokenThrottler = new CustomTokenBucketThrottler(5.0, 1.0); // 5 tokens, 1 token/sec refill
            
            start = DateTime.UtcNow;
            for (int i = 0; i < 3; i++)
            {
                await tokenThrottler.Throttle(2.0); // Each request costs 2 tokens
                Console.WriteLine($"   Request {i + 1} completed");
            }
            elapsed = DateTime.UtcNow - start;
            Console.WriteLine($"   Total time for 3 requests: {elapsed.TotalMilliseconds:F0}ms");

            // Example 3: Adaptive throttler
            Console.WriteLine("\n3. Adaptive Throttler Example:");
            var adaptiveThrottler = new AdaptiveThrottler(TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(2));
            
            start = DateTime.UtcNow;
            for (int i = 0; i < 3; i++)
            {
                await adaptiveThrottler.Throttle(1.0);
                adaptiveThrottler.OnSuccess(); // Simulate successful request
                Console.WriteLine($"   Adaptive request {i + 1} completed");
            }
            elapsed = DateTime.UtcNow - start;
            Console.WriteLine($"   Total time for 3 adaptive requests: {elapsed.TotalMilliseconds:F0}ms");

            // Example 4: Exchange-aware throttler
            Console.WriteLine("\n4. Exchange-Aware Throttler Example:");
            var exchangeThrottler = new ExchangeAwareThrottler();
            
            start = DateTime.UtcNow;
            await exchangeThrottler.Throttle(1.0);
            elapsed = DateTime.UtcNow - start;
            Console.WriteLine($"   Exchange-aware request took: {elapsed.TotalMilliseconds:F0}ms");

            Console.WriteLine("\n=== Examples completed ===");
        }
    }
}