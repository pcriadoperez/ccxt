/**
 * Multi-Window Rate Throttler for CCXT
 *
 * Addresses key issues with the current throttler:
 * 1. Window-based configuration (e.g., "60 requests per minute") instead of refillRate
 * 2. Support for multiple parallel rate limiters (e.g., per-second AND per-minute limits)
 * 3. Dynamic limit updates from exchange response headers
 * 4. Starts at full capacity (no waiting on startup)
 */
/**
 * Time interval types matching exchange specifications
 * SECOND => S, MINUTE => M, HOUR => H, DAY => D
 */
export type RateLimitInterval = 'second' | 'minute' | 'hour' | 'day';
/**
 * Rate limit types based on exchange APIs
 */
export type RateLimitType = 'requests' | 'weight' | 'orders';
/**
 * Configuration for a single rate limit window
 */
export interface RateLimitConfig {
    /** Type of rate limit */
    type?: RateLimitType;
    /** Maximum number of requests (or weight) allowed in the window */
    limit: number;
    /** Time interval for the window */
    interval: RateLimitInterval;
    /** Number of intervals (e.g., intervalNum=5 with interval='minute' means "every 5 minutes") */
    intervalNum?: number;
    /** Human-readable identifier for this rate limit */
    id?: string;
}
/**
 * Single window-based rate limiter using sliding window algorithm
 */
export declare class WindowRateLimiter {
    private config;
    private requests;
    private windowMs;
    constructor(config: RateLimitConfig);
    /**
     * Calculate window size in milliseconds
     */
    private calculateWindowMs;
    /**
     * Remove requests outside the current window
     */
    private pruneOldRequests;
    /**
     * Get current usage (sum of costs in current window)
     */
    getCurrentUsage(currentTime?: number): number;
    /**
     * Get available capacity
     */
    getAvailableCapacity(currentTime?: number): number;
    /**
     * Check if request can proceed
     */
    canProceed(cost: number, currentTime?: number): boolean;
    /**
     * Calculate time to wait until request can proceed
     */
    getTimeToWait(cost: number, currentTime?: number): number;
    /**
     * Record a request
     */
    recordRequest(cost: number, currentTime?: number): void;
    /**
     * Update the limit dynamically (e.g., from exchange headers)
     */
    updateLimit(newLimit: number): void;
    /**
     * Get configuration
     */
    getConfig(): Readonly<Required<RateLimitConfig>>;
    /**
     * Get info about current state
     */
    getInfo(): {
        id: string;
        limit: number;
        usage: number;
        available: number;
        windowMs: number;
    };
}
/**
 * Configuration for MultiWindowThrottler
 */
export interface MultiWindowThrottlerConfig {
    /** Array of rate limit configurations */
    rateLimits: RateLimitConfig[];
    /** Default cost for requests */
    defaultCost?: number;
    /** Maximum queue capacity */
    maxCapacity?: number;
    /** Delay between checks when waiting (ms) */
    delay?: number;
}
/**
 * Multi-window throttler that manages multiple rate limiters in parallel
 * Provides the same interface as the legacy Throttler for compatibility
 */
export declare class MultiWindowThrottler {
    private limiters;
    private queue;
    private running;
    private defaultCost;
    private maxCapacity;
    private delay;
    constructor(config: MultiWindowThrottlerConfig);
    /**
     * Main processing loop
     */
    private loop;
    /**
     * Throttle a request (main API method, compatible with legacy Throttler)
     */
    throttle(cost?: number): Promise<void>;
    /**
     * Update rate limits dynamically (e.g., from exchange response headers)
     *
     * @param limiterId - ID of the limiter to update
     * @param newLimit - New limit value
     */
    updateLimit(limiterId: string, newLimit: number): void;
    /**
     * Get info about all rate limiters
     */
    getInfo(): Array<ReturnType<WindowRateLimiter['getInfo']>>;
    /**
     * Get a specific limiter by ID
     */
    getLimiter(limiterId: string): WindowRateLimiter | undefined;
}
