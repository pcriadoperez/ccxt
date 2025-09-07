
//@ts-nocheck
/*  ------------------------------------------------------------------------ */

import { now, sleep } from './time.js';
/*  ------------------------------------------------------------------------ */

// Multi-rule throttler with backward compatibility for single-rule configs
// Rule fields: id, refillRate, delay (global), capacity, maxCapacity (global), tokens, cost

class Throttler {
    constructor (config) {
        this.config = {
            'refillRate': 1.0,
            'delay': 0.001,
            'capacity': 1.0,
            'maxCapacity': 2000,
            'tokens': 0,
            'cost': 1.0,
        };
        Object.assign (this.config, config);
        // If multi-rule config provided, normalize rules
        this.rules = undefined;
        if (Array.isArray (this.config['rules'])) {
            // deep-clone minimal fields for internal use
            this.rules = this.config['rules'].map ((r, idx) => ({
                'id': (r['id'] !== undefined) ? r['id'] : ('rule' + idx.toString ()),
                'refillRate': (r['refillRate'] !== undefined) ? r['refillRate'] : this.config['refillRate'],
                'capacity': (r['capacity'] !== undefined) ? r['capacity'] : this.config['capacity'],
                'tokens': (r['tokens'] !== undefined) ? r['tokens'] : 0,
                'cost': (r['cost'] !== undefined) ? r['cost'] : this.config['cost'],
            }));
            // ensure stable ids
            const seen = {};
            for (let i = 0; i < this.rules.length; i++) {
                const id = this.rules[i]['id'];
                if (seen[id]) {
                    this.rules[i]['id'] = this.rules[i]['id'] + ':' + i.toString ();
                }
                seen[this.rules[i]['id']] = true;
            }
        }
        this.queue = [];
        this.running = false;
    }

    // determine if the head of queue can run given current tokens across rules
    canRunHead () {
        if (this.queue.length === 0) {
            return false;
        }
        const head = this.queue[0];
        if (!this.rules) { // legacy single-rule mode
            return this.config['tokens'] >= 0;
        }
        // multi-rule mode
        const costs = head.cost;
        for (let i = 0; i < this.rules.length; i++) {
            const rule = this.rules[i];
            const ruleId = rule['id'];
            let cost = 0;
            if (costs === undefined) {
                cost = rule['cost'];
            } else if (typeof costs === 'number') {
                // if a specific 'default' rule exists, apply to that; otherwise apply to all rules
                const hasDefault = this.rules.find ((r) => r['id'] === 'default') !== undefined;
                if (hasDefault) {
                    cost = (ruleId === 'default') ? costs : 0;
                } else {
                    cost = costs;
                }
            } else if (typeof costs === 'object') {
                cost = (costs[ruleId] !== undefined) ? costs[ruleId] : 0;
            }
            if (cost > 0 && rule['tokens'] < 0) {
                return false;
            }
        }
        return true;
    }

    async loop () {
        let lastTimestamp = now ();
        while (this.running) {
            if (this.queue.length === 0) {
                this.running = false;
                break;
            }
            const { resolver, cost } = this.queue[0];
            if (this.canRunHead ()) {
                // consume tokens and resolve
                if (!this.rules) {
                    const consume = (cost === undefined) ? this.config['cost'] : cost;
                    this.config['tokens'] -= consume;
                } else {
                    for (let i = 0; i < this.rules.length; i++) {
                        const rule = this.rules[i];
                        const ruleId = rule['id'];
                        let consume = 0;
                        if (cost === undefined) {
                            consume = rule['cost'];
                        } else if (typeof cost === 'number') {
                            const hasDefault = this.rules.find ((r) => r['id'] === 'default') !== undefined;
                            if (hasDefault) {
                                consume = (ruleId === 'default') ? cost : 0;
                            } else {
                                consume = cost;
                            }
                        } else if (typeof cost === 'object') {
                            consume = (cost[ruleId] !== undefined) ? cost[ruleId] : 0;
                        }
                        if (consume !== 0) {
                            rule['tokens'] -= consume;
                        }
                    }
                }
                resolver ();
                this.queue.shift ();
                // contextswitch
                await Promise.resolve ();
                if (this.queue.length === 0) {
                    this.running = false;
                }
            } else {
                await sleep (this.config['delay'] * 1000);
                const current = now ();
                const elapsed = current - lastTimestamp;
                lastTimestamp = current;
                if (!this.rules) {
                    const tokens = this.config['tokens'] + (this.config['refillRate'] * elapsed);
                    this.config['tokens'] = Math.min (tokens, this.config['capacity']);
                } else {
                    for (let i = 0; i < this.rules.length; i++) {
                        const rule = this.rules[i];
                        const tokens = rule['tokens'] + (rule['refillRate'] * elapsed);
                        rule['tokens'] = Math.min (tokens, rule['capacity']);
                    }
                }
            }
        }
    }

    throttle (cost = undefined) {
        let resolver;
        const promise = new Promise ((resolve, reject) => {
            resolver = resolve;
        });
        if (this.queue.length > this.config['maxCapacity']) {
            throw new Error ('throttle queue is over maxCapacity (' + this.config['maxCapacity'].toString () + '), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526');
        }
        // in multi-rule mode, cost can be a number or a map of ruleId->cost
        const effectiveCost = (cost === undefined) ? undefined : cost;
        this.queue.push ({ resolver, cost: effectiveCost });
        if (!this.running) {
            this.running = true;
            this.loop ();
        }
        return promise;
    }
}

export {
    Throttler,
};

// ----------------------------------------
