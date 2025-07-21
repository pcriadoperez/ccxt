/**
 * Represents a single rate limiting rule
 */
interface ThrottleRule {
    id: string;
    capacity: number;
    refillRate: number;
    tokens: number;
    intervalType: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY';
    intervalNum: number;
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
    maxCapacity?: number;
    delay?: number;
}
/**
 * Multi-rule throttler that can enforce multiple rate limiting rules simultaneously
 * Supports Binance-style rate limiting with different rule types (REQUEST_WEIGHT, RAW_REQUESTS, ORDERS, etc.)
 */
declare class MultiThrottler {
    private rules;
    private config;
    private queue;
    private running;
    constructor(rules: ThrottleRule[], config?: MultiThrottlerConfig);
    /**
     * Add or update a throttling rule
     */
    addRule(rule: ThrottleRule): void;
    /**
     * Remove a throttling rule
     */
    removeRule(ruleId: string): boolean;
    /**
     * Get current status of all rules
     */
    getStatus(): {
        [ruleId: string]: {
            tokens: number;
            capacity: number;
            utilization: number;
        };
    };
    /**
     * Check if a request can be processed immediately (all rules have sufficient tokens)
     */
    private canProcess;
    /**
     * Consume tokens from all applicable rules
     */
    private consumeTokens;
    /**
     * Refill tokens for all rules based on elapsed time
     */
    private refillTokens;
    /**
     * Calculate the minimum time needed for a request to be processable
     */
    private calculateWaitTime;
    /**
     * Main processing loop
     */
    private loop;
    /**
     * Submit a request to be throttled according to the defined rules
     * @param cost Object mapping rule IDs to their costs for this request
     * @returns Promise that resolves when the request can proceed
     */
    throttle(cost: ThrottleCost): Promise<void>;
    /**
     * Get the current queue length
     */
    getQueueLength(): number;
    /**
     * Check if the throttler is currently running
     */
    isRunning(): boolean;
    /**
     * Reset all token buckets to their capacity
     */
    reset(): void;
    /**
     * Manually set tokens for a specific rule (useful for testing)
     */
    setTokens(ruleId: string, tokens: number): void;
}
export { MultiThrottler, ThrottleRule, ThrottleCost, MultiThrottlerConfig, };
