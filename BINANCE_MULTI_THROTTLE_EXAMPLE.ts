// Example modification for Binance to support multi-rule throttling
// This shows how to adapt the current single-cost system to multi-rule costs

import Exchange from './abstract/binance.js';
import { MultiThrottler, ThrottleRule } from './base/functions/multi-throttle.js';

export default class binance extends Exchange {
    describe() {
        return this.deepExtend(super.describe(), {
            'id': 'binance',
            'name': 'Binance',
            'rateLimit': 50, // This becomes base rate for backward compatibility
            
            // NEW: Multi-rule rate limit specification
            'rateLimits': [
                {
                    'id': 'RAW_REQUESTS',
                    'capacity': 6000,
                    'refillRate': 6000 / (60 * 1000), // 6000 per minute
                    'intervalType': 'MINUTE',
                    'intervalNum': 1,
                    'description': 'Total requests per minute'
                },
                {
                    'id': 'REQUEST_WEIGHT', 
                    'capacity': 1200,
                    'refillRate': 1200 / (60 * 1000), // 1200 per minute
                    'intervalType': 'MINUTE',
                    'intervalNum': 1,
                    'description': 'Weighted requests per minute'
                },
                {
                    'id': 'ORDERS',
                    'capacity': 100,
                    'refillRate': 100 / (10 * 1000), // 100 per 10 seconds
                    'intervalType': 'SECOND',
                    'intervalNum': 10,
                    'description': 'Order-related requests per 10 seconds'
                }
            ],

            'api': {
                'sapi': {
                    'get': {
                        // MODIFIED: Instead of single cost, specify multi-rule costs
                        'system/status': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 1
                            // No ORDERS cost - this endpoint doesn't use order limits
                        },
                        'accountSnapshot': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 2400 // Weight(IP): 2400
                        },
                        'margin/account': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 10
                        },
                        'margin/order': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 10,
                            'ORDERS': 1 // This is an order-related endpoint
                        },
                        // Conditional costs based on parameters
                        'margin/crossMarginData': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': { 'default': 1, 'noCoin': 5 } // Dynamic based on parameters
                        },
                        // Dynamic costs based on limit parameter
                        'margin/allOrders': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': { 
                                'byLimit': [
                                    [500, 10],    // limit <= 500: weight = 10
                                    [1000, 20],   // limit <= 1000: weight = 20
                                    [5000, 50]    // limit <= 5000: weight = 50
                                ]
                            }
                        }
                    },
                    'post': {
                        'margin/order': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 6, // Weight(UID): 6
                            'ORDERS': 1
                        },
                        'margin/transfer': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 600 // Weight(UID): 600
                        },
                        'capital/withdraw/apply': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 1,
                            // Additional rate limit: 10 requests per second
                            'WITHDRAWALS': 1 // Could add withdrawal-specific limits
                        }
                    },
                    'delete': {
                        'margin/order': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 10,
                            'ORDERS': 1
                        }
                    }
                },
                'private': {
                    'get': {
                        'account': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 20
                        },
                        'openOrders': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': { 'default': 6, 'noSymbol': 80 }
                        }
                    },
                    'post': {
                        'order': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 4, // Weight(UID): 4
                            'ORDERS': 1
                        },
                        'order/test': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 4
                            // No ORDERS cost for test orders
                        }
                    },
                    'delete': {
                        'order': {
                            'RAW_REQUESTS': 1,
                            'REQUEST_WEIGHT': 4,
                            'ORDERS': 1
                        }
                    }
                }
            }
        });
    }

    // NEW: Initialize multi-rule throttler
    initThrottler() {
        const rateLimits = this.safeValue(this.describe(), 'rateLimits', []);
        const rules = rateLimits.map(limit => 
            new ThrottleRule(
                limit.id,
                limit.capacity,
                limit.refillRate,
                limit.capacity, // Start with full capacity
                limit.intervalType,
                limit.intervalNum
            )
        );
        
        this.multiThrottler = new MultiThrottler(rules);
        
        // Keep backward compatibility with single throttler
        super.initThrottler();
    }

    // MODIFIED: Enhanced cost calculation for multi-rule system
    calculateRateLimiterCost(api, method, path, params, config = {}) {
        const result = {};
        
        // Handle different cost types for each rule
        for (const [ruleId, ruleConfig] of Object.entries(config)) {
            if (typeof ruleConfig === 'number') {
                // Simple numeric cost
                result[ruleId] = ruleConfig;
            } else if (typeof ruleConfig === 'object') {
                // Complex cost calculation
                if ('noCoin' in ruleConfig && !('coin' in params)) {
                    result[ruleId] = ruleConfig.noCoin;
                } else if ('noSymbol' in ruleConfig && !('symbol' in params)) {
                    result[ruleId] = ruleConfig.noSymbol;
                } else if ('byLimit' in ruleConfig && ('limit' in params)) {
                    const limit = params.limit;
                    const byLimit = ruleConfig.byLimit;
                    for (const [threshold, cost] of byLimit) {
                        if (limit <= threshold) {
                            result[ruleId] = cost;
                            break;
                        }
                    }
                } else {
                    result[ruleId] = this.safeValue(ruleConfig, 'default', 1);
                }
            }
        }
        
        // Ensure we always have at least RAW_REQUESTS cost
        if (!('RAW_REQUESTS' in result)) {
            result['RAW_REQUESTS'] = 1;
        }
        
        // If no REQUEST_WEIGHT specified, use legacy cost calculation
        if (!('REQUEST_WEIGHT' in result)) {
            const legacyCost = super.calculateRateLimiterCost(api, method, path, params, config);
            result['REQUEST_WEIGHT'] = legacyCost;
        }
        
        return result;
    }

    // MODIFIED: Use multi-rule throttling
    async throttle(cost = undefined) {
        if (this.enableRateLimit && this.multiThrottler) {
            if (typeof cost === 'number') {
                // Legacy single cost - convert to multi-rule
                await this.multiThrottler.throttle({
                    'RAW_REQUESTS': 1,
                    'REQUEST_WEIGHT': cost
                });
            } else if (typeof cost === 'object') {
                // Multi-rule cost
                await this.multiThrottler.throttle(cost);
            } else {
                // Default cost
                await this.multiThrottler.throttle({
                    'RAW_REQUESTS': 1,
                    'REQUEST_WEIGHT': 1
                });
            }
        }
        
        // Keep backward compatibility
        return super.throttle(typeof cost === 'object' ? cost['REQUEST_WEIGHT'] : cost);
    }

    // MODIFIED: Update request method to use multi-rule costs
    async request(path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined, config = {}) {
        // Calculate multi-rule costs
        const costs = this.calculateRateLimiterCost(api, method, path, params, config);
        
        // Apply throttling
        await this.throttle(costs);
        
        // Make the actual request
        const response = await super.request(path, api, method, params, headers, body, config);
        
        // OPTIONAL: Update rate limits from response headers
        this.updateRateLimitsFromHeaders(response.headers);
        
        return response;
    }

    // NEW: Update rate limits based on response headers
    updateRateLimitsFromHeaders(headers) {
        if (!this.multiThrottler) return;
        
        // Update REQUEST_WEIGHT from X-MBX-USED-WEIGHT-* headers
        const weightHeader = headers['x-mbx-used-weight-1m'];
        if (weightHeader !== undefined) {
            const usedWeight = parseInt(weightHeader);
            const remainingWeight = 1200 - usedWeight; // Assuming 1200 limit
            this.multiThrottler.setTokens('REQUEST_WEIGHT', Math.max(0, remainingWeight));
        }
        
        // Update ORDERS from X-MBX-ORDER-COUNT-* headers  
        const orderHeader = headers['x-mbx-order-count-10s'];
        if (orderHeader !== undefined) {
            const usedOrders = parseInt(orderHeader);
            const remainingOrders = 100 - usedOrders; // Assuming 100 limit
            this.multiThrottler.setTokens('ORDERS', Math.max(0, remainingOrders));
        }
    }

    // NEW: Get current rate limit status
    getRateLimitStatus() {
        if (!this.multiThrottler) {
            return super.getRateLimitStatus?.() || {};
        }
        
        return this.multiThrottler.getStatus();
    }

    // Example usage in trading methods
    async createOrder(symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets();
        const market = this.market(symbol);
        
        // The cost will be automatically calculated and applied based on the API configuration
        // For 'order' endpoint: RAW_REQUESTS=1, REQUEST_WEIGHT=4, ORDERS=1
        
        return super.createOrder(symbol, type, side, amount, price, params);
    }

    async fetchBalance(params = {}) {
        // Cost will be: RAW_REQUESTS=1, REQUEST_WEIGHT=20
        return super.fetchBalance(params);
    }

    async fetchOpenOrders(symbol = undefined, since = undefined, limit = undefined, params = {}) {
        // Cost depends on whether symbol is provided:
        // With symbol: RAW_REQUESTS=1, REQUEST_WEIGHT=6  
        // Without symbol: RAW_REQUESTS=1, REQUEST_WEIGHT=80
        return super.fetchOpenOrders(symbol, since, limit, params);
    }
}

// Usage examples:

// 1. The system automatically handles rate limiting for different endpoint types:
//    - Data endpoints use RAW_REQUESTS + REQUEST_WEIGHT
//    - Order endpoints add ORDERS limit
//    - Costs are calculated automatically from API config

// 2. Monitor rate limit status:
//    const status = exchange.getRateLimitStatus();
//    console.log(status);
//    // Output:
//    // {
//    //   RAW_REQUESTS: { tokens: 5995, capacity: 6000, utilization: 0.0008 },
//    //   REQUEST_WEIGHT: { tokens: 1150, capacity: 1200, utilization: 0.042 },
//    //   ORDERS: { tokens: 98, capacity: 100, utilization: 0.02 }
//    // }

// 3. The system prevents 429 errors by queueing requests when limits are reached

// 4. Response headers automatically update token counts for precise tracking