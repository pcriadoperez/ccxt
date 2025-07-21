import asyncio
import time
from typing import Dict, List, Optional, Any


class ThrottleRule:
    """Represents a single rate limiting rule"""
    
    def __init__(self, id: str, capacity: float, refill_rate: float, tokens: float, 
                 interval_type: str, interval_num: int):
        self.id = id  # Unique identifier for the rule
        self.capacity = capacity  # Maximum tokens this rule can hold
        self.refill_rate = refill_rate  # Rate at which tokens are refilled (tokens per millisecond)
        self.tokens = tokens  # Current available tokens
        self.interval_type = interval_type  # For documentation/debugging ('SECOND', 'MINUTE', 'HOUR', 'DAY')
        self.interval_num = interval_num  # Number of intervals


class MultiThrottlerConfig:
    """Configuration options for the MultiThrottler"""
    
    def __init__(self, max_capacity: int = 2000, delay: float = 0.001):
        self.max_capacity = max_capacity  # Maximum queue size before throwing errors
        self.delay = delay  # Sleep delay between checks (in seconds)


class QueueItem:
    """Queue item representing a pending request"""
    
    def __init__(self, resolver, cost: Dict[str, float], timestamp: float):
        self.resolver = resolver
        self.cost = cost
        self.timestamp = timestamp


class MultiThrottler:
    """
    Multi-rule throttler that can enforce multiple rate limiting rules simultaneously.
    Supports Binance-style rate limiting with different rule types (REQUEST_WEIGHT, RAW_REQUESTS, ORDERS, etc.)
    """
    
    def __init__(self, rules: List[ThrottleRule], config: Optional[MultiThrottlerConfig] = None):
        self.rules: Dict[str, ThrottleRule] = {}
        
        # Initialize rules map
        for rule in rules:
            # Clone rule to avoid mutations
            cloned_rule = ThrottleRule(
                rule.id, rule.capacity, rule.refill_rate, 
                rule.tokens, rule.interval_type, rule.interval_num
            )
            self.rules[rule.id] = cloned_rule

        self.config = config or MultiThrottlerConfig()
        self.queue: List[QueueItem] = []
        self.running = False

    def add_rule(self, rule: ThrottleRule) -> None:
        """Add or update a throttling rule"""
        cloned_rule = ThrottleRule(
            rule.id, rule.capacity, rule.refill_rate, 
            rule.tokens, rule.interval_type, rule.interval_num
        )
        self.rules[rule.id] = cloned_rule

    def remove_rule(self, rule_id: str) -> bool:
        """Remove a throttling rule"""
        return self.rules.pop(rule_id, None) is not None

    def get_status(self) -> Dict[str, Dict[str, float]]:
        """Get current status of all rules"""
        status = {}
        
        for rule_id, rule in self.rules.items():
            status[rule_id] = {
                'tokens': rule.tokens,
                'capacity': rule.capacity,
                'utilization': 1 - (rule.tokens / rule.capacity)
            }
        
        return status

    def _can_process(self, cost: Dict[str, float]) -> bool:
        """Check if a request can be processed immediately (all rules have sufficient tokens)"""
        for rule_id, rule_cost in cost.items():
            rule = self.rules.get(rule_id)
            if not rule:
                raise ValueError(f"Unknown throttle rule: {rule_id}")
            
            if rule.tokens < rule_cost:
                return False
        return True

    def _consume_tokens(self, cost: Dict[str, float]) -> None:
        """Consume tokens from all applicable rules"""
        for rule_id, rule_cost in cost.items():
            rule = self.rules.get(rule_id)
            if rule:
                rule.tokens -= rule_cost

    def _refill_tokens(self, elapsed: float) -> None:
        """Refill tokens for all rules based on elapsed time"""
        for rule in self.rules.values():
            tokens_to_add = rule.refill_rate * elapsed
            rule.tokens = min(rule.tokens + tokens_to_add, rule.capacity)

    def _calculate_wait_time(self, cost: Dict[str, float]) -> float:
        """Calculate the minimum time needed for a request to be processable"""
        max_wait_time = 0.0

        for rule_id, rule_cost in cost.items():
            rule = self.rules.get(rule_id)
            if not rule:
                continue

            if rule.tokens < rule_cost:
                tokens_needed = rule_cost - rule.tokens
                wait_time = tokens_needed / rule.refill_rate
                max_wait_time = max(max_wait_time, wait_time)

        return max_wait_time

    async def _loop(self) -> None:
        """Main processing loop"""
        last_timestamp = time.time() * 1000  # Convert to milliseconds

        while self.running and len(self.queue) > 0:
            current_time = time.time() * 1000  # Convert to milliseconds
            elapsed = current_time - last_timestamp
            last_timestamp = current_time

            # Refill tokens for all rules
            self._refill_tokens(elapsed)

            # Process as many items from the queue as possible
            processed = 0
            while len(self.queue) > 0:
                item = self.queue[0]
                
                if self._can_process(item.cost):
                    self._consume_tokens(item.cost)
                    if not item.resolver.done():
                        item.resolver.set_result(None)
                    self.queue.pop(0)
                    processed += 1
                    
                    # Allow other async operations to run
                    if processed % 10 == 0:
                        await asyncio.sleep(0)
                else:
                    # Can't process this item yet, break and wait
                    break

            # If no items were processed, wait before trying again
            if processed == 0 and len(self.queue) > 0:
                wait_time = self._calculate_wait_time(self.queue[0].cost)
                sleep_time = min(wait_time / 1000, self.config.delay)  # Convert to seconds
                await asyncio.sleep(sleep_time)

            # Stop if queue is empty
            if len(self.queue) == 0:
                self.running = False

    async def throttle(self, cost: Dict[str, float]) -> None:
        """
        Submit a request to be throttled according to the defined rules
        
        Args:
            cost: Dictionary mapping rule IDs to their costs for this request
        
        Returns:
            Promise that resolves when the request can proceed
        """
        # Validate that all cost rules exist
        for rule_id in cost.keys():
            if rule_id not in self.rules:
                available_rules = ', '.join(self.rules.keys())
                raise ValueError(f"Unknown throttle rule: {rule_id}. Available rules: {available_rules}")

        # Check queue capacity
        if len(self.queue) >= self.config.max_capacity:
            raise RuntimeError(f'Throttle queue is over maxCapacity ({self.config.max_capacity}), see https://github.com/ccxt/ccxt/issues/11645#issuecomment-1195695526')

        # Create future for this request
        future = asyncio.Future()

        # Add to queue
        item = QueueItem(
            resolver=future,
            cost=cost,
            timestamp=time.time() * 1000
        )
        self.queue.append(item)

        # Start processing loop if not already running
        if not self.running:
            self.running = True
            asyncio.ensure_future(self._loop())  # Don't await here to allow immediate return

        return await future

    def get_queue_length(self) -> int:
        """Get the current queue length"""
        return len(self.queue)

    def is_running(self) -> bool:
        """Check if the throttler is currently running"""
        return self.running

    def reset(self) -> None:
        """Reset all token buckets to their capacity"""
        for rule in self.rules.values():
            rule.tokens = rule.capacity

    def set_tokens(self, rule_id: str, tokens: float) -> None:
        """Manually set tokens for a specific rule (useful for testing)"""
        rule = self.rules.get(rule_id)
        if rule:
            rule.tokens = max(0, min(tokens, rule.capacity))