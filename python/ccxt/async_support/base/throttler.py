import asyncio
import collections
from time import time
from typing import Dict, List, Optional, Union


class ThrottleRule:
    """Individual throttle rule for rate limiting."""
    
    def __init__(self, id: str, capacity: float, refill_rate: float, tokens: float,
                 interval_type: Optional[str] = None, interval_num: int = 1, 
                 description: Optional[str] = None):
        self.id = id
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = tokens
        self.interval_type = interval_type
        self.interval_num = interval_num
        self.description = description


class Throttler:
    """Enhanced throttler supporting multiple concurrent rate limits."""
    
    def __init__(self, rules_or_config, loop=None):
        self.loop = loop
        self.rules: Dict[str, ThrottleRule] = {}
        self.queue = collections.deque()
        self.running = False
        self.last_timestamps: Dict[str, float] = {}
        self.config = None  # Legacy config for backward compatibility
        
        if isinstance(rules_or_config, list):
            # New multi-rule initialization
            for rule in rules_or_config:
                if isinstance(rule, dict):
                    rule_obj = ThrottleRule(
                        rule['id'], rule['capacity'], rule['refill_rate'], 
                        rule['capacity'], rule.get('interval_type'), 
                        rule.get('interval_num', 1), rule.get('description')
                    )
                else:
                    rule_obj = rule
                self.rules[rule_obj.id] = rule_obj
                self.last_timestamps[rule_obj.id] = time() * 1000
        else:
            # Legacy single-rule initialization
            self.config = {
                'refillRate': 1.0,
                'delay': 0.001,
                'cost': 1.0,
                'tokens': 0,
                'maxCapacity': 2000,
                'capacity': 1.0,
            }
            self.config.update(rules_or_config or {})
            
            # Create a default rule for backward compatibility
            default_rule = ThrottleRule(
                'default',
                self.config['capacity'],
                self.config['refillRate'],
                self.config['tokens']
            )
            self.rules['default'] = default_rule
            self.last_timestamps['default'] = time() * 1000

    def refill_tokens(self):
        """Refill tokens for all rules based on elapsed time."""
        current_time = time() * 1000
        
        for rule_id, rule in self.rules.items():
            last_timestamp = self.last_timestamps.get(rule_id, current_time)
            elapsed = current_time - last_timestamp
            tokens_to_add = rule.refill_rate * elapsed
            rule.tokens = min(rule.capacity, rule.tokens + tokens_to_add)
            self.last_timestamps[rule_id] = current_time
        
        # Update legacy config for backward compatibility
        if self.config and 'default' in self.rules:
            self.config['tokens'] = self.rules['default'].tokens

    def can_consume(self, cost) -> bool:
        """Check if the cost can be consumed from available tokens."""
        if isinstance(cost, (int, float)):
            # Legacy single cost
            default_rule = self.rules.get('default')
            return default_rule and default_rule.tokens >= cost
        
        if isinstance(cost, dict):
            # Multi-rule cost - check all rules
            for rule_id, rule_cost in cost.items():
                rule = self.rules.get(rule_id)
                if not rule or rule.tokens < rule_cost:
                    return False
            return True
        
        return False

    def consume(self, cost):
        """Consume tokens for the given cost."""
        if isinstance(cost, (int, float)):
            # Legacy single cost
            default_rule = self.rules.get('default')
            if default_rule:
                default_rule.tokens -= cost
                if self.config:
                    self.config['tokens'] = default_rule.tokens
        elif isinstance(cost, dict):
            # Multi-rule cost
            for rule_id, rule_cost in cost.items():
                rule = self.rules.get(rule_id)
                if rule:
                    rule.tokens -= rule_cost

    async def looper(self):
        """Main throttling loop."""
        while self.running and self.queue:
            self.refill_tokens()
            
            if self.queue:
                future, cost = self.queue[0]
                
                # Handle undefined cost
                if cost is None:
                    if self.config:
                        cost = self.config['cost']
                    else:
                        cost = {'default': 1}
                
                if self.can_consume(cost):
                    self.consume(cost)
                    self.queue.popleft()
                    if not future.done():
                        future.set_result(None)
                    # Context switch
                    await asyncio.sleep(0)
                    
                    if len(self.queue) == 0:
                        self.running = False
                    continue
            
            # Wait before checking again
            delay = self.config['delay'] if self.config else 0.001
            await asyncio.sleep(delay)

    def __call__(self, cost=None):
        """Throttle with the given cost (legacy interface)."""
        return self.throttle(cost)

    async def throttle(self, cost=None):
        """Throttle with the given cost."""
        future = asyncio.Future()
        
        max_capacity = self.config['maxCapacity'] if self.config else 2000
        if len(self.queue) > max_capacity:
            raise RuntimeError(f'throttle queue is over maxCapacity ({max_capacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526')
        
        self.queue.append((future, cost))
        
        if not self.running:
            self.running = True
            asyncio.ensure_future(self.looper(), loop=self.loop)
        
        await future

    def get_status(self) -> Dict:
        """Get current status of all rules."""
        self.refill_tokens()
        
        status = {}
        for rule_id, rule in self.rules.items():
            status[rule_id] = {
                'tokens': rule.tokens,
                'capacity': rule.capacity,
                'utilization': 1.0 - (rule.tokens / rule.capacity)
            }
        return status

    def set_tokens(self, rule_id: str, tokens: float):
        """Set tokens for a specific rule (useful for updating from API response headers)."""
        rule = self.rules.get(rule_id)
        if rule:
            rule.tokens = max(0, min(rule.capacity, tokens))
            self.last_timestamps[rule_id] = time() * 1000
            
            # Update legacy config if this is the default rule
            if rule_id == 'default' and self.config:
                self.config['tokens'] = rule.tokens

    def get_rule(self, rule_id: str) -> Optional[ThrottleRule]:
        """Get specific rule."""
        return self.rules.get(rule_id)

    def is_multi_rule(self) -> bool:
        """Check if this is a multi-rule throttler."""
        return len(self.rules) > 1 or (len(self.rules) == 1 and 'default' not in self.rules)
