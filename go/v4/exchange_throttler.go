package ccxt

import (
	"sync"
	"time"

	u "github.com/google/uuid"
)

// ThrottleRule represents an individual rate limit rule
type ThrottleRule struct {
	ID           string
	Capacity     float64
	RefillRate   float64
	Tokens       float64
	IntervalType string
	IntervalNum  int
	Description  string
}

// NewThrottleRule creates a new throttle rule
func NewThrottleRule(id string, capacity, refillRate, tokens float64, intervalType string, intervalNum int, description string) *ThrottleRule {
	return &ThrottleRule{
		ID:           id,
		Capacity:     capacity,
		RefillRate:   refillRate,
		Tokens:       tokens,
		IntervalType: intervalType,
		IntervalNum:  intervalNum,
		Description:  description,
	}
}

// Enhanced throttler supporting multiple concurrent rate limits
type Throttler struct {
	Queue          Queue
	Running        bool
	Config         map[string]interface{} // Legacy config for backward compatibility
	Rules          map[string]*ThrottleRule
	LastTimestamps map[string]int64
	mutex          sync.RWMutex
}

// NewThrottlerFromRules creates a new multi-rule throttler
func NewThrottlerFromRules(rules []*ThrottleRule) Throttler {
	rulesMap := make(map[string]*ThrottleRule)
	timestamps := make(map[string]int64)
	
	for _, rule := range rules {
		rulesMap[rule.ID] = rule
		timestamps[rule.ID] = Milliseconds()
	}

	return Throttler{
		Queue:          NewQueue(),
		Running:        false,
		Config:         nil,
		Rules:          rulesMap,
		LastTimestamps: timestamps,
		mutex:          sync.RWMutex{},
	}
}

// NewThrottler creates a new legacy single-rule throttler
func NewThrottler(config map[string]interface{}) Throttler {
	defaultConfig := map[string]interface{}{
		"refillRate":  1.0,
		"delay":       0.001,
		"capacity":    1.0,
		"maxCapacity": 2000,
		"tokens":      0,
		"cost":        1.0,
	}

	finalConfig := ExtendMap(defaultConfig, config)
	
	// Create a default rule for backward compatibility
	defaultRule := NewThrottleRule(
		"default",
		ToFloat64(finalConfig["capacity"]),
		ToFloat64(finalConfig["refillRate"]),
		ToFloat64(finalConfig["tokens"]),
		"",
		1,
		"",
	)
	
	rulesMap := map[string]*ThrottleRule{"default": defaultRule}
	timestamps := map[string]int64{"default": Milliseconds()}

	return Throttler{
		Queue:          NewQueue(),
		Running:        false,
		Config:         finalConfig,
		Rules:          rulesMap,
		LastTimestamps: timestamps,
		mutex:          sync.RWMutex{},
	}
}

// RefillTokens refills tokens for all rules based on elapsed time
func (t *Throttler) RefillTokens() {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	currentTime := Milliseconds()
	
	for ruleID, rule := range t.Rules {
		lastTimestamp, exists := t.LastTimestamps[ruleID]
		if !exists {
			lastTimestamp = currentTime
		}
		
		elapsed := currentTime - lastTimestamp
		tokensToAdd := rule.RefillRate * float64(elapsed)
		rule.Tokens = MathMin(rule.Capacity, rule.Tokens+tokensToAdd)
		t.LastTimestamps[ruleID] = currentTime
	}
	
	// Update legacy config for backward compatibility
	if t.Config != nil {
		if defaultRule, exists := t.Rules["default"]; exists {
			t.Config["tokens"] = defaultRule.Tokens
		}
	}
}

// CanConsume checks if the cost can be consumed from available tokens
func (t *Throttler) CanConsume(cost interface{}) bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	switch c := cost.(type) {
	case float64:
		// Legacy single cost
		if defaultRule, exists := t.Rules["default"]; exists {
			return defaultRule.Tokens >= c
		}
		return false
	case map[string]interface{}:
		// Multi-rule cost - check all rules
		for ruleID, ruleCostInterface := range c {
			ruleCost := ToFloat64(ruleCostInterface)
			rule, exists := t.Rules[ruleID]
			if !exists || rule.Tokens < ruleCost {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// Consume consumes tokens for the given cost
func (t *Throttler) Consume(cost interface{}) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	switch c := cost.(type) {
	case float64:
		// Legacy single cost
		if defaultRule, exists := t.Rules["default"]; exists {
			defaultRule.Tokens -= c
			if t.Config != nil {
				t.Config["tokens"] = defaultRule.Tokens
			}
		}
	case map[string]interface{}:
		// Multi-rule cost
		for ruleID, ruleCostInterface := range c {
			ruleCost := ToFloat64(ruleCostInterface)
			if rule, exists := t.Rules[ruleID]; exists {
				rule.Tokens -= ruleCost
			}
		}
	}
}

func (t *Throttler) Throttle(cost2 interface{}) <-chan bool {
	var cost interface{}

	// Handle undefined cost
	if cost2 != nil {
		cost = cost2
	} else {
		if t.Config != nil {
			cost = ToFloat64(t.Config["cost"])
		} else {
			// Default multi-rule cost
			cost = map[string]interface{}{"default": 1.0}
		}
	}

	task := make(chan bool)

	queueElement := QueueElement{
		Cost: cost,
		Task: task,
		Id:   u.New().String(),
	}

	t.Queue.Enqueue(queueElement)

	if !t.Running {
		t.Running = true
		go t.Loop()
	}

	return task
}

func (t *Throttler) Loop() {
	for t.Running {
		if t.Queue.IsEmpty() {
			t.Running = false
			continue
		}
		
		t.RefillTokens()
		
		first, _ := t.Queue.Peek()
		task := first.Task
		cost := first.Cost

		if t.CanConsume(cost) {
			t.Consume(cost)
			
			if task != nil {
				task <- true
				close(task)
			}
			t.Queue.Dequeue()

			if t.Queue.IsEmpty() {
				t.Running = false
			}
		} else {
			// Wait before checking again
			delay := 0.001
			if t.Config != nil {
				delay = ToFloat64(t.Config["delay"])
			}
			sleepTime := delay * 1000
			time.Sleep(time.Duration(sleepTime) * time.Millisecond)
		}
	}
}

// GetStatus returns current status of all rules
func (t *Throttler) GetStatus() map[string]interface{} {
	t.RefillTokens()
	
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	status := make(map[string]interface{})
	for ruleID, rule := range t.Rules {
		status[ruleID] = map[string]interface{}{
			"tokens":      rule.Tokens,
			"capacity":    rule.Capacity,
			"utilization": 1.0 - (rule.Tokens / rule.Capacity),
		}
	}
	return status
}

// SetTokens sets tokens for a specific rule (useful for updating from API response headers)
func (t *Throttler) SetTokens(ruleID string, tokens float64) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	
	if rule, exists := t.Rules[ruleID]; exists {
		rule.Tokens = MathMax(0, MathMin(rule.Capacity, tokens))
		t.LastTimestamps[ruleID] = Milliseconds()
		
		// Update legacy config if this is the default rule
		if ruleID == "default" && t.Config != nil {
			t.Config["tokens"] = rule.Tokens
		}
	}
}

// GetRule returns a specific rule
func (t *Throttler) GetRule(ruleID string) *ThrottleRule {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return t.Rules[ruleID]
}

// IsMultiRule checks if this is a multi-rule throttler
func (t *Throttler) IsMultiRule() bool {
	t.mutex.RLock()
	defer t.mutex.RUnlock()
	
	return len(t.Rules) > 1 || (len(t.Rules) == 1 && t.Rules["default"] == nil)
}

func Milliseconds() int64 {
	return time.Now().UnixNano() / int64(time.Millisecond)
}
