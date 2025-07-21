
//@ts-nocheck
/*  ------------------------------------------------------------------------ */

import { now, sleep } from './time.js';
/*  ------------------------------------------------------------------------ */

// Individual throttle rule interface
export interface ThrottleRule {
    id: string;
    capacity: number;
    refillRate: number;
    tokens: number;
    intervalType?: string;
    intervalNum?: number;
    description?: string;
}

// Cost specification for multi-rule throttling
export interface ThrottleCost {
    [ruleId: string]: number;
}

// Enhanced throttler supporting multiple concurrent rate limits
class Throttler {
    private rules: Map<string, ThrottleRule>;
    private queue: Array<{ resolver: () => void; cost: ThrottleCost | number }>;
    private running: boolean;
    private lastTimestamps: Map<string, number>;
    private config: any; // Legacy config for backward compatibility

    constructor(rulesOrConfig: ThrottleRule[] | any) {
        this.rules = new Map();
        this.queue = [];
        this.running = false;
        this.lastTimestamps = new Map();

        if (Array.isArray(rulesOrConfig)) {
            // New multi-rule initialization
            for (const rule of rulesOrConfig) {
                this.rules.set(rule.id, { ...rule });
                this.lastTimestamps.set(rule.id, now());
            }
            this.config = null;
        } else {
            // Legacy single-rule initialization
            this.config = {
                'refillRate': 1.0,
                'delay': 0.001,
                'capacity': 1.0,
                'maxCapacity': 2000,
                'tokens': 0,
                'cost': 1.0,
            };
            Object.assign(this.config, rulesOrConfig || {});
            
            // Create a default rule for backward compatibility
            const defaultRule: ThrottleRule = {
                id: 'default',
                capacity: this.config.capacity,
                refillRate: this.config.refillRate,
                tokens: this.config.tokens
            };
            this.rules.set('default', defaultRule);
            this.lastTimestamps.set('default', now());
        }
    }

    private refillTokens() {
        const currentTime = now();
        
        for (const [ruleId, rule] of this.rules) {
            const lastTimestamp = this.lastTimestamps.get(ruleId) || currentTime;
            const elapsed = currentTime - lastTimestamp;
            const tokensToAdd = rule.refillRate * elapsed;
            rule.tokens = Math.min(rule.capacity, rule.tokens + tokensToAdd);
            this.lastTimestamps.set(ruleId, currentTime);
        }
        
        // Update legacy config for backward compatibility
        if (this.config) {
            const defaultRule = this.rules.get('default');
            if (defaultRule) {
                this.config.tokens = defaultRule.tokens;
            }
        }
    }

    private canConsume(cost: ThrottleCost | number): boolean {
        if (typeof cost === 'number') {
            // Legacy single cost
            const defaultRule = this.rules.get('default');
            return defaultRule ? defaultRule.tokens >= cost : false;
        }
        
        // Multi-rule cost - check all rules
        for (const [ruleId, ruleCost] of Object.entries(cost)) {
            const rule = this.rules.get(ruleId);
            if (!rule || rule.tokens < ruleCost) {
                return false;
            }
        }
        return true;
    }

    private consume(cost: ThrottleCost | number) {
        if (typeof cost === 'number') {
            // Legacy single cost
            const defaultRule = this.rules.get('default');
            if (defaultRule) {
                defaultRule.tokens -= cost;
                if (this.config) {
                    this.config.tokens = defaultRule.tokens;
                }
            }
        } else {
            // Multi-rule cost
            for (const [ruleId, ruleCost] of Object.entries(cost)) {
                const rule = this.rules.get(ruleId);
                if (rule) {
                    rule.tokens -= ruleCost;
                }
            }
        }
    }

    async loop() {
        while (this.running && this.queue.length > 0) {
            this.refillTokens();
            
            const { resolver, cost } = this.queue[0];
            
            if (this.canConsume(cost)) {
                this.consume(cost);
                resolver();
                this.queue.shift();
                // Context switch
                await Promise.resolve();
                
                if (this.queue.length === 0) {
                    this.running = false;
                }
            } else {
                // Wait before checking again
                const delay = this.config?.delay || 0.001;
                await sleep(delay * 1000);
            }
        }
    }

    throttle(cost: ThrottleCost | number = undefined): Promise<void> {
        let resolver: () => void;
        const promise = new Promise<void>((resolve) => {
            resolver = resolve;
        });

        const maxCapacity = this.config?.maxCapacity || 2000;
        if (this.queue.length > maxCapacity) {
            throw new Error(`throttle queue is over maxCapacity (${maxCapacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526`);
        }

        // Handle undefined cost
        if (cost === undefined) {
            if (this.config) {
                cost = this.config.cost;
            } else {
                // Default multi-rule cost
                cost = { 'default': 1 };
            }
        }

        this.queue.push({ resolver, cost });

        if (!this.running) {
            this.running = true;
            this.loop();
        }

        return promise;
    }

    // Get current status of all rules
    getStatus(): { [ruleId: string]: { tokens: number; capacity: number; utilization: number } } {
        this.refillTokens();
        
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

    // Set tokens for a specific rule (useful for updating from API response headers)
    setTokens(ruleId: string, tokens: number) {
        const rule = this.rules.get(ruleId);
        if (rule) {
            rule.tokens = Math.max(0, Math.min(rule.capacity, tokens));
            this.lastTimestamps.set(ruleId, now());
            
            // Update legacy config if this is the default rule
            if (ruleId === 'default' && this.config) {
                this.config.tokens = rule.tokens;
            }
        }
    }

    // Get specific rule
    getRule(ruleId: string): ThrottleRule | undefined {
        return this.rules.get(ruleId);
    }

    // Check if this is a multi-rule throttler
    isMultiRule(): boolean {
        return this.rules.size > 1 || (this.rules.size === 1 && !this.rules.has('default'));
    }
}

export {
    Throttler,
    ThrottleRule,
    ThrottleCost,
};

// Legacy alias for backward compatibility
export { Throttler as MultiThrottler };

// ----------------------------------------
