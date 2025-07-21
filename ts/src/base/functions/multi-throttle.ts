//@ts-nocheck
/*  ------------------------------------------------------------------------ */

import { now, sleep } from './time.js';

/*  ------------------------------------------------------------------------ */

/**
 * Represents a single rate limiting rule
 */
interface ThrottleRule {
    id: string;                    // Unique identifier for the rule (e.g., 'REQUEST_WEIGHT', 'RAW_REQUESTS', 'ORDERS')
    capacity: number;              // Maximum tokens this rule can hold
    refillRate: number;            // Rate at which tokens are refilled (tokens per millisecond)
    tokens: number;                // Current available tokens
    intervalType: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY'; // For documentation/debugging
    intervalNum: number;           // Number of intervals (e.g., 5 for "every 5 minutes")
}

/**
 * Cost specification for a request - maps rule IDs to their costs
 */
interface ThrottleCost {
    [ruleId: string]: number;
}

/**
 * Configuration options for the MultiThrottler
 */
interface MultiThrottlerConfig {
    maxCapacity?: number;          // Maximum queue size before throwing errors
    delay?: number;                // Sleep delay between checks (in seconds)
}

/**
 * Queue item representing a pending request
 */
interface QueueItem {
    resolver: () => void;
    cost: ThrottleCost;
    timestamp: number;
}

/**
 * Multi-rule throttler that can enforce multiple rate limiting rules simultaneously
 * Supports Binance-style rate limiting with different rule types (REQUEST_WEIGHT, RAW_REQUESTS, ORDERS, etc.)
 */
class MultiThrottler {
    private rules: Map<string, ThrottleRule>;
    private config: MultiThrottlerConfig;
    private queue: QueueItem[];
    private running: boolean;

    constructor(rules: ThrottleRule[], config: MultiThrottlerConfig = {}) {
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
    addRule(rule: ThrottleRule): void {
        this.rules.set(rule.id, { ...rule });
    }

    /**
     * Remove a throttling rule
     */
    removeRule(ruleId: string): boolean {
        return this.rules.delete(ruleId);
    }

    /**
     * Get current status of all rules
     */
    getStatus(): { [ruleId: string]: { tokens: number; capacity: number; utilization: number } } {
        const status: { [ruleId: string]: { tokens: number; capacity: number; utilization: number } } = {};
        
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
    private canProcess(cost: ThrottleCost): boolean {
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
    private consumeTokens(cost: ThrottleCost): void {
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
    private refillTokens(elapsed: number): void {
        for (const rule of this.rules.values()) {
            const tokensToAdd = rule.refillRate * elapsed;
            rule.tokens = Math.min(rule.tokens + tokensToAdd, rule.capacity);
        }
    }

    /**
     * Calculate the minimum time needed for a request to be processable
     */
    private calculateWaitTime(cost: ThrottleCost): number {
        let maxWaitTime = 0;

        for (const [ruleId, ruleCost] of Object.entries(cost)) {
            const rule = this.rules.get(ruleId);
            if (!rule) continue;

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
    private async loop(): Promise<void> {
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
                } else {
                    // Can't process this item yet, break and wait
                    break;
                }
            }

            // If no items were processed, wait before trying again
            if (processed === 0 && this.queue.length > 0) {
                const waitTime = this.calculateWaitTime(this.queue[0].cost);
                const sleepTime = Math.min(waitTime, this.config.delay! * 1000);
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
    async throttle(cost: ThrottleCost): Promise<void> {
        // Validate that all cost rules exist
        for (const ruleId of Object.keys(cost)) {
            if (!this.rules.has(ruleId)) {
                throw new Error(`Unknown throttle rule: ${ruleId}. Available rules: ${Array.from(this.rules.keys()).join(', ')}`);
            }
        }

        // Check queue capacity
        if (this.queue.length >= this.config.maxCapacity!) {
            throw new Error(`Throttle queue is over maxCapacity (${this.config.maxCapacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526`);
        }

        // Create promise for this request
        let resolver: () => void;
        const promise = new Promise<void>((resolve) => {
            resolver = resolve;
        });

        // Add to queue
        this.queue.push({
            resolver: resolver!,
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
    getQueueLength(): number {
        return this.queue.length;
    }

    /**
     * Check if the throttler is currently running
     */
    isRunning(): boolean {
        return this.running;
    }

    /**
     * Reset all token buckets to their capacity
     */
    reset(): void {
        for (const rule of this.rules.values()) {
            rule.tokens = rule.capacity;
        }
    }

    /**
     * Manually set tokens for a specific rule (useful for testing)
     */
    setTokens(ruleId: string, tokens: number): void {
        const rule = this.rules.get(ruleId);
        if (rule) {
            rule.tokens = Math.max(0, Math.min(tokens, rule.capacity));
        }
    }
}

export {
    MultiThrottler,
    ThrottleRule,
    ThrottleCost,
    MultiThrottlerConfig,
};

// ----------------------------------------