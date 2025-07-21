//@ts-nocheck
/*  ------------------------------------------------------------------------ */
import { now, sleep } from './time.js';
/**
 * Multi-rule throttler that can enforce multiple rate limiting rules simultaneously
 * Supports Binance-style rate limiting with different rule types (REQUEST_WEIGHT, RAW_REQUESTS, ORDERS, etc.)
 */
class MultiThrottler {
    constructor(rules, config = {}) {
        this.rules = new Map();
        // Initialize rules map
        for (const rule of rules) {
            this.rules.set(rule.id, { ...rule }); // Clone to avoid mutations
        }
        this.config = {
            maxCapacity: 2000,
            delay: 0.001,
            ...config
        };
        this.queue = [];
        this.running = false;
    }
    /**
     * Add or update a throttling rule
     */
    addRule(rule) {
        this.rules.set(rule.id, { ...rule });
    }
    /**
     * Remove a throttling rule
     */
    removeRule(ruleId) {
        return this.rules.delete(ruleId);
    }
    /**
     * Get current status of all rules
     */
    getStatus() {
        const status = {};
        for (const [ruleId, rule] of this.rules) {
            status[ruleId] = {
                tokens: rule.tokens,
                capacity: rule.capacity,
                utilization: 1 - (rule.tokens / rule.capacity)
            };
        }
        return status;
    }
    /**
     * Check if a request can be processed immediately (all rules have sufficient tokens)
     */
    canProcess(cost) {
        for (const [ruleId, ruleCost] of Object.entries(cost)) {
            const rule = this.rules.get(ruleId);
            if (!rule) {
                throw new Error(`Unknown throttle rule: ${ruleId}`);
            }
            if (rule.tokens < ruleCost) {
                return false;
            }
        }
        return true;
    }
    /**
     * Consume tokens from all applicable rules
     */
    consumeTokens(cost) {
        for (const [ruleId, ruleCost] of Object.entries(cost)) {
            const rule = this.rules.get(ruleId);
            if (rule) {
                rule.tokens -= ruleCost;
            }
        }
    }
    /**
     * Refill tokens for all rules based on elapsed time
     */
    refillTokens(elapsed) {
        for (const rule of this.rules.values()) {
            const tokensToAdd = rule.refillRate * elapsed;
            rule.tokens = Math.min(rule.tokens + tokensToAdd, rule.capacity);
        }
    }
    /**
     * Calculate the minimum time needed for a request to be processable
     */
    calculateWaitTime(cost) {
        let maxWaitTime = 0;
        for (const [ruleId, ruleCost] of Object.entries(cost)) {
            const rule = this.rules.get(ruleId);
            if (!rule)
                continue;
            if (rule.tokens < ruleCost) {
                const tokensNeeded = ruleCost - rule.tokens;
                const waitTime = tokensNeeded / rule.refillRate;
                maxWaitTime = Math.max(maxWaitTime, waitTime);
            }
        }
        return maxWaitTime;
    }
    /**
     * Main processing loop
     */
    async loop() {
        let lastTimestamp = now();
        while (this.running && this.queue.length > 0) {
            const currentTime = now();
            const elapsed = currentTime - lastTimestamp;
            lastTimestamp = currentTime;
            // Refill tokens for all rules
            this.refillTokens(elapsed);
            // Process as many items from the queue as possible
            let processed = 0;
            while (this.queue.length > 0) {
                const item = this.queue[0];
                if (this.canProcess(item.cost)) {
                    this.consumeTokens(item.cost);
                    item.resolver();
                    this.queue.shift();
                    processed++;
                    // Allow other async operations to run
                    if (processed % 10 === 0) {
                        await Promise.resolve();
                    }
                }
                else {
                    // Can't process this item yet, break and wait
                    break;
                }
            }
            // If no items were processed, wait before trying again
            if (processed === 0 && this.queue.length > 0) {
                const waitTime = this.calculateWaitTime(this.queue[0].cost);
                const sleepTime = Math.min(waitTime, this.config.delay * 1000);
                await sleep(sleepTime);
            }
            // Stop if queue is empty
            if (this.queue.length === 0) {
                this.running = false;
            }
        }
    }
    /**
     * Submit a request to be throttled according to the defined rules
     * @param cost Object mapping rule IDs to their costs for this request
     * @returns Promise that resolves when the request can proceed
     */
    async throttle(cost) {
        // Validate that all cost rules exist
        for (const ruleId of Object.keys(cost)) {
            if (!this.rules.has(ruleId)) {
                throw new Error(`Unknown throttle rule: ${ruleId}. Available rules: ${Array.from(this.rules.keys()).join(', ')}`);
            }
        }
        // Check queue capacity
        if (this.queue.length >= this.config.maxCapacity) {
            throw new Error(`Throttle queue is over maxCapacity (${this.config.maxCapacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526`);
        }
        // Create promise for this request
        let resolver;
        const promise = new Promise((resolve) => {
            resolver = resolve;
        });
        // Add to queue
        this.queue.push({
            resolver: resolver,
            cost,
            timestamp: now()
        });
        // Start processing loop if not already running
        if (!this.running) {
            this.running = true;
            this.loop(); // Don't await here to allow immediate return
        }
        return promise;
    }
    /**
     * Get the current queue length
     */
    getQueueLength() {
        return this.queue.length;
    }
    /**
     * Check if the throttler is currently running
     */
    isRunning() {
        return this.running;
    }
    /**
     * Reset all token buckets to their capacity
     */
    reset() {
        for (const rule of this.rules.values()) {
            rule.tokens = rule.capacity;
        }
    }
    /**
     * Manually set tokens for a specific rule (useful for testing)
     */
    setTokens(ruleId, tokens) {
        const rule = this.rules.get(ruleId);
        if (rule) {
            rule.tokens = Math.max(0, Math.min(tokens, rule.capacity));
        }
    }
}
export { MultiThrottler, };
// ----------------------------------------
