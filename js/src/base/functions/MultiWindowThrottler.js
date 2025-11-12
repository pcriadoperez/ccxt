/**
 * Multi-Window Rate Throttler for CCXT
 *
 * Addresses key issues with the current throttler:
 * 1. Window-based configuration (e.g., "60 requests per minute") instead of refillRate
 * 2. Support for multiple parallel rate limiters (e.g., per-second AND per-minute limits)
 * 3. Dynamic limit updates from exchange response headers
 * 4. Starts at full capacity (no waiting on startup)
 */
import { now } from './time.js';
/**
 * Single window-based rate limiter using sliding window algorithm
 */
export class WindowRateLimiter {
    constructor(config) {
        this.config = {
            type: config.type || 'requests',
            limit: config.limit,
            interval: config.interval,
            intervalNum: config.intervalNum || 1,
            id: config.id || `${config.type || 'requests'}_${config.limit}_per_${config.intervalNum || 1}_${config.interval}`,
        };
        this.requests = [];
        this.windowMs = this.calculateWindowMs();
    }
    /**
     * Calculate window size in milliseconds
     */
    calculateWindowMs() {
        const baseMs = {
            'second': 1000,
            'minute': 60 * 1000,
            'hour': 60 * 60 * 1000,
            'day': 24 * 60 * 60 * 1000,
        };
        return baseMs[this.config.interval] * this.config.intervalNum;
    }
    /**
     * Remove requests outside the current window
     */
    pruneOldRequests(currentTime) {
        const cutoff = currentTime - this.windowMs;
        // Remove requests older than the window
        while (this.requests.length > 0 && this.requests[0].timestamp < cutoff) {
            this.requests.shift();
        }
    }
    /**
     * Get current usage (sum of costs in current window)
     */
    getCurrentUsage(currentTime = now()) {
        this.pruneOldRequests(currentTime);
        return this.requests.reduce((sum, req) => sum + req.cost, 0);
    }
    /**
     * Get available capacity
     */
    getAvailableCapacity(currentTime = now()) {
        const usage = this.getCurrentUsage(currentTime);
        return Math.max(0, this.config.limit - usage);
    }
    /**
     * Check if request can proceed
     */
    canProceed(cost, currentTime = now()) {
        const available = this.getAvailableCapacity(currentTime);
        return available >= cost;
    }
    /**
     * Calculate time to wait until request can proceed
     */
    getTimeToWait(cost, currentTime = now()) {
        this.pruneOldRequests(currentTime);
        if (this.canProceed(cost, currentTime)) {
            return 0;
        }
        // Calculate how much capacity we need to free up
        const usage = this.getCurrentUsage(currentTime);
        const needed = usage + cost - this.config.limit;
        // Find when enough old requests will expire
        let freedCapacity = 0;
        for (const req of this.requests) {
            freedCapacity += req.cost;
            if (freedCapacity >= needed) {
                // This request will expire at: req.timestamp + windowMs
                const expireTime = req.timestamp + this.windowMs;
                return Math.max(0, expireTime - currentTime);
            }
        }
        // Should not reach here if logic is correct
        return this.windowMs;
    }
    /**
     * Record a request
     */
    recordRequest(cost, currentTime = now()) {
        this.requests.push({
            timestamp: currentTime,
            cost,
        });
    }
    /**
     * Update the limit dynamically (e.g., from exchange headers)
     */
    updateLimit(newLimit) {
        this.config.limit = newLimit;
    }
    /**
     * Get configuration
     */
    getConfig() {
        return this.config;
    }
    /**
     * Get info about current state
     */
    getInfo() {
        const currentTime = now();
        const usage = this.getCurrentUsage(currentTime);
        return {
            id: this.config.id,
            limit: this.config.limit,
            usage,
            available: this.config.limit - usage,
            windowMs: this.windowMs,
        };
    }
}
/**
 * Multi-window throttler that manages multiple rate limiters in parallel
 * Provides the same interface as the legacy Throttler for compatibility
 */
export class MultiWindowThrottler {
    constructor(config) {
        this.limiters = config.rateLimits.map(limitConfig => new WindowRateLimiter(limitConfig));
        this.queue = [];
        this.running = false;
        this.defaultCost = config.defaultCost || 1;
        this.maxCapacity = config.maxCapacity || 2000;
        this.delay = config.delay || 0.001;
    }
    /**
     * Main processing loop
     */
    async loop() {
        while (this.running && this.queue.length > 0) {
            const request = this.queue[0];
            const currentTime = now();
            // Check all limiters
            const canProceedAll = this.limiters.every(limiter => limiter.canProceed(request.cost, currentTime));
            if (canProceedAll) {
                // Record the request in all limiters
                this.limiters.forEach(limiter => limiter.recordRequest(request.cost, currentTime));
                // Resolve the promise
                request.resolver();
                this.queue.shift();
                // Context switch
                await Promise.resolve();
                if (this.queue.length === 0) {
                    this.running = false;
                }
            }
            else {
                // Calculate how long to wait
                const waitTimes = this.limiters.map(limiter => limiter.getTimeToWait(request.cost, currentTime));
                const maxWait = Math.max(...waitTimes);
                // Wait a short delay (not the full wait time, as we check frequently)
                await new Promise(resolve => setTimeout(resolve, Math.min(this.delay * 1000, maxWait)));
            }
        }
    }
    /**
     * Throttle a request (main API method, compatible with legacy Throttler)
     */
    async throttle(cost) {
        const requestCost = cost !== undefined ? cost : this.defaultCost;
        // Check queue capacity
        if (this.queue.length >= this.maxCapacity) {
            throw new Error(`Throttle queue is over maxCapacity (${this.maxCapacity}), ` +
                `see https://docs.ccxt.com/#/README?id=maximum-requests-capacity`);
        }
        // Create promise for this request
        const promise = new Promise((resolve) => {
            this.queue.push({
                resolver: resolve,
                cost: requestCost,
                timestamp: now(),
            });
        });
        // Start the loop if not running
        if (!this.running) {
            this.running = true;
            this.loop();
        }
        return promise;
    }
    /**
     * Update rate limits dynamically (e.g., from exchange response headers)
     *
     * @param limiterId - ID of the limiter to update
     * @param newLimit - New limit value
     */
    updateLimit(limiterId, newLimit) {
        const limiter = this.limiters.find(l => l.getConfig().id === limiterId);
        if (limiter) {
            limiter.updateLimit(newLimit);
        }
    }
    /**
     * Get info about all rate limiters
     */
    getInfo() {
        return this.limiters.map(limiter => limiter.getInfo());
    }
    /**
     * Get a specific limiter by ID
     */
    getLimiter(limiterId) {
        return this.limiters.find(l => l.getConfig().id === limiterId);
    }
}
