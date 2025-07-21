package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/ccxt/ccxt/go/v4"
)

// Example 1: Simple delay-based throttler
type SimpleDelayThrottler struct {
	delayMs int64
}

func NewSimpleDelayThrottler(delayMs int64) *SimpleDelayThrottler {
	return &SimpleDelayThrottler{delayMs: delayMs}
}

func (t *SimpleDelayThrottler) Throttle(ctx context.Context, cost float64) error {
	time.Sleep(time.Duration(t.delayMs) * time.Millisecond)
	return nil
}

// Example 2: Token bucket throttler with custom logic
type CustomTokenBucketThrottler struct {
	tokens     float64
	capacity   float64
	refillRate float64
	lastRefill time.Time
	mutex      chan struct{}
}

func NewCustomTokenBucketThrottler(capacity, refillRate float64) *CustomTokenBucketThrottler {
	return &CustomTokenBucketThrottler{
		tokens:     capacity,
		capacity:   capacity,
		refillRate: refillRate,
		lastRefill: time.Now(),
		mutex:      make(chan struct{}, 1),
	}
}

func (t *CustomTokenBucketThrottler) Throttle(ctx context.Context, cost float64) error {
	t.mutex <- struct{}{} // Lock
	defer func() { <-t.mutex }() // Unlock

	// Refill tokens
	now := time.Now()
	elapsed := now.Sub(t.lastRefill).Seconds()
	tokensToAdd := elapsed * t.refillRate
	t.tokens = min(t.capacity, t.tokens+tokensToAdd)
	t.lastRefill = now

	// Check if we have enough tokens
	if t.tokens < cost {
		// Calculate wait time
		waitTime := (cost - t.tokens) / t.refillRate
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(waitTime * float64(time.Second))):
		}
		t.tokens = 0
	} else {
		t.tokens -= cost
	}

	return nil
}

// Example 3: Adaptive throttler that adjusts based on response times
type AdaptiveThrottler struct {
	baseDelay    time.Duration
	maxDelay     time.Duration
	currentDelay time.Duration
	successCount int
	errorCount   int
	mutex        chan struct{}
}

func NewAdaptiveThrottler(baseDelay, maxDelay time.Duration) *AdaptiveThrottler {
	return &AdaptiveThrottler{
		baseDelay:    baseDelay,
		maxDelay:     maxDelay,
		currentDelay: baseDelay,
		mutex:        make(chan struct{}, 1),
	}
}

func (t *AdaptiveThrottler) Throttle(ctx context.Context, cost float64) error {
	t.mutex <- struct{}{} // Lock
	defer func() { <-t.mutex }() // Unlock

	// Use current delay
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(t.currentDelay):
	}

	return nil
}

func (t *AdaptiveThrottler) OnSuccess() {
	t.mutex <- struct{}{} // Lock
	defer func() { <-t.mutex }() // Unlock

	t.successCount++
	if t.successCount >= 5 {
		// Reduce delay on success
		t.currentDelay = max(t.baseDelay, t.currentDelay/2)
		t.successCount = 0
		t.errorCount = 0
	}
}

func (t *AdaptiveThrottler) OnError() {
	t.mutex <- struct{}{} // Lock
	defer func() { <-t.mutex }() // Unlock

	t.errorCount++
	if t.errorCount >= 3 {
		// Increase delay on errors
		t.currentDelay = min(t.maxDelay, t.currentDelay*2)
		t.successCount = 0
		t.errorCount = 0
	}
}

// Example 4: Exchange-aware throttler
type ExchangeAwareThrottler struct {
	exchangeRates map[string]time.Duration
	defaultRate   time.Duration
	mutex         chan struct{}
}

func NewExchangeAwareThrottler() *ExchangeAwareThrottler {
	return &ExchangeAwareThrottler{
		exchangeRates: map[string]time.Duration{
			"binance": 100 * time.Millisecond,
			"coinbase": 500 * time.Millisecond,
			"kraken":  200 * time.Millisecond,
		},
		defaultRate: 1000 * time.Millisecond,
		mutex:       make(chan struct{}, 1),
	}
}

func (t *ExchangeAwareThrottler) Throttle(ctx context.Context, cost float64) error {
	t.mutex <- struct{}{} // Lock
	defer func() { <-t.mutex }() // Unlock

	// Use default rate (in real implementation, you'd get exchange name from context)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(t.defaultRate):
	}

	return nil
}

func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func max(a, b time.Duration) time.Duration {
	if a > b {
		return a
	}
	return b
}

func main() {
	fmt.Println("=== CCXT Go Custom Throttler Examples ===\n")

	// Example 1: Simple delay throttler
	fmt.Println("1. Simple Delay Throttler Example:")
	simpleThrottler := NewSimpleDelayThrottler(500) // 500ms delay
	
	// Create exchange with custom throttler
	exchange := ccxt.NewBinance(map[string]interface{}{
		"customThrottler": simpleThrottler,
		"enableRateLimit": true,
	})

	// Test the throttler
	start := time.Now()
	ctx := context.Background()
	
	err := simpleThrottler.Throttle(ctx, 1.0)
	if err != nil {
		log.Printf("Error: %v", err)
	}
	
	elapsed := time.Since(start)
	fmt.Printf("   Throttled request took: %v\n", elapsed)

	// Example 2: Token bucket throttler
	fmt.Println("\n2. Token Bucket Throttler Example:")
	tokenThrottler := NewCustomTokenBucketThrottler(5.0, 1.0) // 5 tokens, 1 token/sec refill
	
	start = time.Now()
	for i := 0; i < 3; i++ {
		err := tokenThrottler.Throttle(ctx, 2.0) // Each request costs 2 tokens
		if err != nil {
			log.Printf("Error: %v", err)
		}
		fmt.Printf("   Request %d completed\n", i+1)
	}
	elapsed = time.Since(start)
	fmt.Printf("   Total time for 3 requests: %v\n", elapsed)

	// Example 3: Adaptive throttler
	fmt.Println("\n3. Adaptive Throttler Example:")
	adaptiveThrottler := NewAdaptiveThrottler(100*time.Millisecond, 2*time.Second)
	
	start = time.Now()
	for i := 0; i < 3; i++ {
		err := adaptiveThrottler.Throttle(ctx, 1.0)
		if err != nil {
			log.Printf("Error: %v", err)
		}
		adaptiveThrottler.OnSuccess() // Simulate successful request
		fmt.Printf("   Adaptive request %d completed\n", i+1)
	}
	elapsed = time.Since(start)
	fmt.Printf("   Total time for 3 adaptive requests: %v\n", elapsed)

	// Example 4: Exchange-aware throttler
	fmt.Println("\n4. Exchange-Aware Throttler Example:")
	exchangeThrottler := NewExchangeAwareThrottler()
	
	start = time.Now()
	err = exchangeThrottler.Throttle(ctx, 1.0)
	if err != nil {
		log.Printf("Error: %v", err)
	}
	elapsed = time.Since(start)
	fmt.Printf("   Exchange-aware request took: %v\n", elapsed)

	fmt.Println("\n=== Examples completed ===")
}