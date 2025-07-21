package ccxt

import (
	"context"
	"sync"
	"time"
)

// CustomThrottler interface for custom throttler implementations
type CustomThrottler interface {
	Throttle(ctx context.Context, cost float64) error
}

// Throttler is the default token bucket throttler implementation
type Throttler struct {
	config map[string]interface{}
	queue  []throttleRequest
	mutex  sync.Mutex
}

type throttleRequest struct {
	cost     float64
	resolver chan struct{}
}

// NewThrottler creates a new throttler with the given configuration
func NewThrottler(config map[string]interface{}) *Throttler {
	defaultConfig := map[string]interface{}{
		"refillRate":  1.0,
		"delay":       0.001,
		"capacity":    1.0,
		"maxCapacity": 2000.0,
		"tokens":      0.0,
		"cost":        1.0,
	}

	// Merge with provided config
	for k, v := range config {
		defaultConfig[k] = v
	}

	return &Throttler{
		config: defaultConfig,
		queue:  make([]throttleRequest, 0),
	}
}

// Throttle implements the CustomThrottler interface
func (t *Throttler) Throttle(ctx context.Context, cost float64) error {
	if cost == 0 {
		cost = t.config["cost"].(float64)
	}

	// Simple implementation for Go - just sleep based on cost
	delay := time.Duration(cost*1000) * time.Millisecond
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(delay):
		return nil
	}
}

// SimpleDelayThrottler implements a simple delay-based throttler
type SimpleDelayThrottler struct {
	delay time.Duration
}

// NewSimpleDelayThrottler creates a new simple delay throttler
func NewSimpleDelayThrottler(delayMs int) *SimpleDelayThrottler {
	return &SimpleDelayThrottler{
		delay: time.Duration(delayMs) * time.Millisecond,
	}
}

// Throttle implements the CustomThrottler interface
func (s *SimpleDelayThrottler) Throttle(ctx context.Context, cost float64) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(s.delay):
		return nil
	}
}

// CustomTokenBucketThrottler implements a token bucket throttler with custom parameters
type CustomTokenBucketThrottler struct {
	tokens     float64
	capacity   float64
	refillRate float64
	lastRefill time.Time
	mutex      sync.Mutex
}

// NewCustomTokenBucketThrottler creates a new token bucket throttler
func NewCustomTokenBucketThrottler(capacity, refillRate float64) *CustomTokenBucketThrottler {
	return &CustomTokenBucketThrottler{
		tokens:     capacity,
		capacity:   capacity,
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

// Throttle implements the CustomThrottler interface
func (t *CustomTokenBucketThrottler) Throttle(ctx context.Context, cost float64) error {
	t.mutex.Lock()
	defer t.mutex.Unlock()

	// Refill tokens based on time passed
	now := time.Now()
	timePassed := now.Sub(t.lastRefill).Seconds()
	t.tokens = min(t.capacity, t.tokens+timePassed*t.refillRate)
	t.lastRefill = now

	// If not enough tokens, wait
	if t.tokens < cost {
		waitTime := (cost - t.tokens) / t.refillRate
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(waitTime * float64(time.Second))):
			t.tokens = 0
		}
	} else {
		t.tokens -= cost
	}

	return nil
}

// AdaptiveThrottler implements an adaptive throttler that adjusts based on response times
type AdaptiveThrottler struct {
	baseDelay     time.Duration
	maxDelay      time.Duration
	currentDelay  time.Duration
	successCount  int
	errorCount    int
	mutex         sync.Mutex
}

// NewAdaptiveThrottler creates a new adaptive throttler
func NewAdaptiveThrottler(baseDelayMs, maxDelayMs int) *AdaptiveThrottler {
	return &AdaptiveThrottler{
		baseDelay:    time.Duration(baseDelayMs) * time.Millisecond,
		maxDelay:     time.Duration(maxDelayMs) * time.Millisecond,
		currentDelay: time.Duration(baseDelayMs) * time.Millisecond,
	}
}

// Throttle implements the CustomThrottler interface
func (a *AdaptiveThrottler) Throttle(ctx context.Context, cost float64) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(a.currentDelay):
		return nil
	}
}

// OnSuccess should be called after successful requests
func (a *AdaptiveThrottler) OnSuccess() {
	a.mutex.Lock()
	defer a.mutex.Unlock()

	a.successCount++
	if a.successCount >= 10 {
		// Reduce delay on success
		a.currentDelay = max(a.baseDelay, time.Duration(float64(a.currentDelay)*0.9))
		a.successCount = 0
	}
}

// OnError should be called after failed requests
func (a *AdaptiveThrottler) OnError() {
	a.mutex.Lock()
	defer a.mutex.Unlock()

	a.errorCount++
	if a.errorCount >= 3 {
		// Increase delay on errors
		a.currentDelay = min(a.maxDelay, time.Duration(float64(a.currentDelay)*1.5))
		a.errorCount = 0
	}
}

// ExchangeAwareThrottler implements a rate limiter that respects exchange-specific limits
type ExchangeAwareThrottler struct {
	exchangeID string
	limits     map[string]exchangeLimit
	mutex      sync.Mutex
}

type exchangeLimit struct {
	requests  int
	window    time.Duration
	lastReset time.Time
}

// NewExchangeAwareThrottler creates a new exchange-aware throttler
func NewExchangeAwareThrottler(exchangeID string) *ExchangeAwareThrottler {
	t := &ExchangeAwareThrottler{
		exchangeID: exchangeID,
		limits:     make(map[string]exchangeLimit),
	}
	t.initializeLimits()
	return t
}

func (e *ExchangeAwareThrottler) initializeLimits() {
	// Example limits for different exchanges
	exchangeLimits := map[string]struct {
		requests int
		window   time.Duration
	}{
		"binance": {requests: 1200, window: 60 * time.Second}, // 1200 requests per minute
		"coinbase": {requests: 30, window: time.Second},       // 30 requests per second
		"kraken":  {requests: 15, window: time.Second},        // 15 requests per second
	}

	if limit, exists := exchangeLimits[e.exchangeID]; exists {
		e.limits["default"] = exchangeLimit{
			requests:  limit.requests,
			window:    limit.window,
			lastReset: time.Now(),
		}
	}
}

// Throttle implements the CustomThrottler interface
func (e *ExchangeAwareThrottler) Throttle(ctx context.Context, cost float64) error {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	limit, exists := e.limits["default"]
	if !exists {
		// No specific limit, use default delay
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
			return nil
		}
	}

	now := time.Now()

	// Reset counter if window has passed
	if now.Sub(limit.lastReset) > limit.window {
		limit.requests = limit.requests
		limit.lastReset = now
	}

	// If we've exceeded the limit, wait
	if limit.requests <= 0 {
		waitTime := limit.window - now.Sub(limit.lastReset)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(waitTime):
			limit.requests = limit.requests
			limit.lastReset = time.Now()
		}
	}

	limit.requests -= int(cost)
	e.limits["default"] = limit

	return nil
}

// ExponentialBackoffThrottler implements exponential backoff throttling
type ExponentialBackoffThrottler struct {
	initialDelay   time.Duration
	maxDelay       time.Duration
	backoffFactor  float64
	currentDelay   time.Duration
	consecutiveErrors int
	mutex          sync.Mutex
}

// NewExponentialBackoffThrottler creates a new exponential backoff throttler
func NewExponentialBackoffThrottler(initialDelayMs, maxDelayMs int, backoffFactor float64) *ExponentialBackoffThrottler {
	initialDelay := time.Duration(initialDelayMs) * time.Millisecond
	return &ExponentialBackoffThrottler{
		initialDelay:  initialDelay,
		maxDelay:      time.Duration(maxDelayMs) * time.Millisecond,
		backoffFactor: backoffFactor,
		currentDelay:  initialDelay,
	}
}

// Throttle implements the CustomThrottler interface
func (e *ExponentialBackoffThrottler) Throttle(ctx context.Context, cost float64) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(e.currentDelay):
		return nil
	}
}

// OnSuccess resets the delay on success
func (e *ExponentialBackoffThrottler) OnSuccess() {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	e.currentDelay = e.initialDelay
	e.consecutiveErrors = 0
}

// OnError increases the delay on error with exponential backoff
func (e *ExponentialBackoffThrottler) OnError() {
	e.mutex.Lock()
	defer e.mutex.Unlock()

	e.consecutiveErrors++
	e.currentDelay = min(e.maxDelay, time.Duration(float64(e.currentDelay)*e.backoffFactor))
}

// Helper functions
func min(a, b time.Duration) time.Duration {
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