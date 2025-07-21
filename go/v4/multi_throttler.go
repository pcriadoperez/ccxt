package ccxt

import (
	"fmt"
	"sync"
	"time"
)

// ThrottleRule represents a single rate limiting rule
type ThrottleRule struct {
	ID           string  // Unique identifier for the rule
	Capacity     float64 // Maximum tokens this rule can hold
	RefillRate   float64 // Rate at which tokens are refilled (tokens per millisecond)
	Tokens       float64 // Current available tokens
	IntervalType string  // For documentation/debugging ('SECOND', 'MINUTE', 'HOUR', 'DAY')
	IntervalNum  int     // Number of intervals
}

// NewThrottleRule creates a new throttle rule
func NewThrottleRule(id string, capacity, refillRate, tokens float64, intervalType string, intervalNum int) *ThrottleRule {
	return &ThrottleRule{
		ID:           id,
		Capacity:     capacity,
		RefillRate:   refillRate,
		Tokens:       tokens,
		IntervalType: intervalType,
		IntervalNum:  intervalNum,
	}
}

// Clone creates a copy of the throttle rule
func (r *ThrottleRule) Clone() *ThrottleRule {
	return &ThrottleRule{
		ID:           r.ID,
		Capacity:     r.Capacity,
		RefillRate:   r.RefillRate,
		Tokens:       r.Tokens,
		IntervalType: r.IntervalType,
		IntervalNum:  r.IntervalNum,
	}
}

// MultiThrottlerConfig holds configuration options for the MultiThrottler
type MultiThrottlerConfig struct {
	MaxCapacity int     // Maximum queue size before throwing errors
	Delay       float64 // Sleep delay between checks (in seconds)
}

// NewMultiThrottlerConfig creates a new configuration with default values
func NewMultiThrottlerConfig() *MultiThrottlerConfig {
	return &MultiThrottlerConfig{
		MaxCapacity: 2000,
		Delay:       0.001,
	}
}

// QueueItem represents a pending request in the queue
type QueueItem struct {
	channel   chan struct{}
	cost      map[string]float64
	timestamp int64
}

// MultiThrottler enforces multiple rate limiting rules simultaneously
// Supports Binance-style rate limiting with different rule types (REQUEST_WEIGHT, RAW_REQUESTS, ORDERS, etc.)
type MultiThrottler struct {
	rules   map[string]*ThrottleRule
	config  *MultiThrottlerConfig
	queue   []*QueueItem
	running bool
	mutex   sync.Mutex
}

// NewMultiThrottler creates a new multi-rule throttler
func NewMultiThrottler(rules []*ThrottleRule, config *MultiThrottlerConfig) *MultiThrottler {
	rulesMap := make(map[string]*ThrottleRule)
	
	// Initialize rules map with clones to avoid mutations
	for _, rule := range rules {
		rulesMap[rule.ID] = rule.Clone()
	}

	if config == nil {
		config = NewMultiThrottlerConfig()
	}

	return &MultiThrottler{
		rules:   rulesMap,
		config:  config,
		queue:   make([]*QueueItem, 0),
		running: false,
	}
}

// AddRule adds or updates a throttling rule
func (mt *MultiThrottler) AddRule(rule *ThrottleRule) {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	mt.rules[rule.ID] = rule.Clone()
}

// RemoveRule removes a throttling rule
func (mt *MultiThrottler) RemoveRule(ruleID string) bool {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	
	if _, exists := mt.rules[ruleID]; exists {
		delete(mt.rules, ruleID)
		return true
	}
	return false
}

// GetStatus returns the current status of all rules
func (mt *MultiThrottler) GetStatus() map[string]map[string]float64 {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	
	status := make(map[string]map[string]float64)
	
	for ruleID, rule := range mt.rules {
		status[ruleID] = map[string]float64{
			"tokens":      rule.Tokens,
			"capacity":    rule.Capacity,
			"utilization": 1 - (rule.Tokens / rule.Capacity),
		}
	}
	
	return status
}

// canProcess checks if a request can be processed immediately (all rules have sufficient tokens)
func (mt *MultiThrottler) canProcess(cost map[string]float64) error {
	for ruleID, ruleCost := range cost {
		rule, exists := mt.rules[ruleID]
		if !exists {
			var availableRules []string
			for id := range mt.rules {
				availableRules = append(availableRules, id)
			}
			return fmt.Errorf("unknown throttle rule: %s. Available rules: %v", ruleID, availableRules)
		}
		
		if rule.Tokens < ruleCost {
			return nil // Cannot process yet, but not an error
		}
	}
	return nil // Can process
}

// consumeTokens consumes tokens from all applicable rules
func (mt *MultiThrottler) consumeTokens(cost map[string]float64) {
	for ruleID, ruleCost := range cost {
		if rule, exists := mt.rules[ruleID]; exists {
			rule.Tokens -= ruleCost
		}
	}
}

// refillTokens refills tokens for all rules based on elapsed time
func (mt *MultiThrottler) refillTokens(elapsed float64) {
	for _, rule := range mt.rules {
		tokensToAdd := rule.RefillRate * elapsed
		rule.Tokens = min(rule.Tokens+tokensToAdd, rule.Capacity)
	}
}

// calculateWaitTime calculates the minimum time needed for a request to be processable
func (mt *MultiThrottler) calculateWaitTime(cost map[string]float64) float64 {
	maxWaitTime := 0.0

	for ruleID, ruleCost := range cost {
		rule, exists := mt.rules[ruleID]
		if !exists {
			continue
		}

		if rule.Tokens < ruleCost {
			tokensNeeded := ruleCost - rule.Tokens
			waitTime := tokensNeeded / rule.RefillRate
			maxWaitTime = max(maxWaitTime, waitTime)
		}
	}

	return maxWaitTime
}

// loop is the main processing loop
func (mt *MultiThrottler) loop() {
	lastTimestamp := float64(time.Now().UnixNano()) / 1e6 // Convert to milliseconds

	for mt.running {
		mt.mutex.Lock()
		
		if len(mt.queue) == 0 {
			mt.running = false
			mt.mutex.Unlock()
			return
		}

		currentTime := float64(time.Now().UnixNano()) / 1e6 // Convert to milliseconds
		elapsed := currentTime - lastTimestamp
		lastTimestamp = currentTime

		// Refill tokens for all rules
		mt.refillTokens(elapsed)

		// Process as many items from the queue as possible
		processed := 0
		for len(mt.queue) > 0 {
			item := mt.queue[0]
			
			if err := mt.canProcess(item.cost); err != nil {
				mt.mutex.Unlock()
				// Close channel with error
				close(item.channel)
				return
			}
			
			if err := mt.canProcess(item.cost); err == nil {
				// Check if we can actually process (tokens available)
				canProcess := true
				for ruleID, ruleCost := range item.cost {
					rule := mt.rules[ruleID]
					if rule.Tokens < ruleCost {
						canProcess = false
						break
					}
				}
				
				if canProcess {
					mt.consumeTokens(item.cost)
					mt.queue = mt.queue[1:] // Remove from queue
					processed++
					
					// Signal completion
					close(item.channel)
					
					// Allow other operations to run
					if processed%10 == 0 {
						mt.mutex.Unlock()
						time.Sleep(time.Microsecond) // Brief yield
						mt.mutex.Lock()
					}
				} else {
					// Can't process this item yet, break and wait
					break
				}
			} else {
				// Error in cost validation
				mt.mutex.Unlock()
				close(item.channel)
				return
			}
		}

		var waitTime float64
		var item *QueueItem
		
		// If no items were processed, calculate wait time
		if processed == 0 && len(mt.queue) > 0 {
			item = mt.queue[0]
			waitTime = mt.calculateWaitTime(item.cost)
		}
		
		mt.mutex.Unlock()

		if item != nil {
			sleepTime := min(waitTime, mt.config.Delay*1000) // Convert to milliseconds
			time.Sleep(time.Duration(sleepTime) * time.Millisecond)
		} else {
			// Small delay to prevent tight loop
			time.Sleep(time.Millisecond)
		}
	}
}

// Throttle submits a request to be throttled according to the defined rules
func (mt *MultiThrottler) Throttle(cost map[string]float64) error {
	// Validate that all cost rules exist
	mt.mutex.Lock()
	for ruleID := range cost {
		if _, exists := mt.rules[ruleID]; !exists {
			var availableRules []string
			for id := range mt.rules {
				availableRules = append(availableRules, id)
			}
			mt.mutex.Unlock()
			return fmt.Errorf("unknown throttle rule: %s. Available rules: %v", ruleID, availableRules)
		}
	}

	// Check queue capacity
	if len(mt.queue) >= mt.config.MaxCapacity {
		mt.mutex.Unlock()
		return fmt.Errorf("throttle queue is over maxCapacity (%d), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526", mt.config.MaxCapacity)
	}

	// Create channel for this request
	channel := make(chan struct{})

	// Add to queue
	item := &QueueItem{
		channel:   channel,
		cost:      cost,
		timestamp: time.Now().UnixNano() / 1e6, // Convert to milliseconds
	}
	mt.queue = append(mt.queue, item)

	// Start processing loop if not already running
	if !mt.running {
		mt.running = true
		go mt.loop() // Don't wait for completion
	}
	
	mt.mutex.Unlock()

	// Wait for completion
	<-channel
	return nil
}

// GetQueueLength returns the current queue length
func (mt *MultiThrottler) GetQueueLength() int {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	return len(mt.queue)
}

// IsRunning checks if the throttler is currently running
func (mt *MultiThrottler) IsRunning() bool {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	return mt.running
}

// Reset resets all token buckets to their capacity
func (mt *MultiThrottler) Reset() {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	
	for _, rule := range mt.rules {
		rule.Tokens = rule.Capacity
	}
}

// SetTokens manually sets tokens for a specific rule (useful for testing)
func (mt *MultiThrottler) SetTokens(ruleID string, tokens float64) {
	mt.mutex.Lock()
	defer mt.mutex.Unlock()
	
	if rule, exists := mt.rules[ruleID]; exists {
		rule.Tokens = max(0, min(tokens, rule.Capacity))
	}
}

// Helper functions
func min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}