# -*- coding: utf-8 -*-

"""Throttler implementations for CCXT"""

import asyncio
import time
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any

class CustomThrottler(ABC):
    """Abstract base class for custom throttlers"""
    
    @abstractmethod
    async def throttle(self, cost: Optional[float] = None) -> None:
        """Throttle the request based on the cost"""
        pass

class Throttler:
    """Default token bucket throttler implementation"""
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = {
            'refillRate': 1.0,
            'delay': 0.001,
            'capacity': 1.0,
            'maxCapacity': 2000,
            'tokens': 0,
            'cost': 1.0,
        }
        if config:
            self.config.update(config)
        self.queue = []
        self.running = False

    async def loop(self):
        last_timestamp = time.time()
        while self.running:
            if not self.queue:
                self.running = False
                break
                
            resolver, cost = self.queue[0]
            if self.config['tokens'] >= 0:
                self.config['tokens'] -= cost
                resolver()
                self.queue.pop(0)
                await asyncio.sleep(0)  # context switch
                if not self.queue:
                    self.running = False
            else:
                await asyncio.sleep(self.config['delay'])
                current = time.time()
                elapsed = current - last_timestamp
                last_timestamp = current
                tokens = self.config['tokens'] + (self.config['refillRate'] * elapsed)
                self.config['tokens'] = min(tokens, self.config['capacity'])

    def throttle(self, cost: Optional[float] = None) -> asyncio.Future:
        """Throttle a request with the given cost"""
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        
        if len(self.queue) > self.config['maxCapacity']:
            raise Exception(f'throttle queue is over maxCapacity ({self.config["maxCapacity"]})')
        
        cost = cost if cost is not None else self.config['cost']
        self.queue.append((future.set_result, cost))
        
        if not self.running:
            self.running = True
            asyncio.create_task(self.loop())
        
        return future

# Example custom throttler implementations

class SimpleDelayThrottler(CustomThrottler):
    """Simple delay-based throttler"""
    
    def __init__(self, delay_seconds: float = 1.0):
        self.delay_seconds = delay_seconds
    
    async def throttle(self, cost: Optional[float] = None) -> None:
        await asyncio.sleep(self.delay_seconds)

class CustomTokenBucketThrottler(CustomThrottler):
    """Custom token bucket throttler with configurable parameters"""
    
    def __init__(self, capacity: float = 10.0, refill_rate: float = 1.0):
        self.tokens = capacity
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.last_refill = time.time()
    
    async def throttle(self, cost: float = 1.0) -> None:
        # Refill tokens based on time passed
        now = time.time()
        time_passed = now - self.last_refill
        self.tokens = min(self.capacity, self.tokens + time_passed * self.refill_rate)
        self.last_refill = now
        
        # If not enough tokens, wait
        if self.tokens < cost:
            wait_time = (cost - self.tokens) / self.refill_rate
            await asyncio.sleep(wait_time)
            self.tokens = 0
        else:
            self.tokens -= cost

class AdaptiveThrottler(CustomThrottler):
    """Adaptive throttler that adjusts based on response times"""
    
    def __init__(self, base_delay: float = 0.1, max_delay: float = 5.0):
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.current_delay = base_delay
        self.success_count = 0
        self.error_count = 0
    
    async def throttle(self, cost: Optional[float] = None) -> None:
        await asyncio.sleep(self.current_delay)
    
    def on_success(self) -> None:
        """Call this method after successful requests"""
        self.success_count += 1
        if self.success_count >= 10:
            # Reduce delay on success
            self.current_delay = max(self.base_delay, self.current_delay * 0.9)
            self.success_count = 0
    
    def on_error(self) -> None:
        """Call this method after failed requests"""
        self.error_count += 1
        if self.error_count >= 3:
            # Increase delay on errors
            self.current_delay = min(self.max_delay, self.current_delay * 1.5)
            self.error_count = 0

class ExchangeAwareThrottler(CustomThrottler):
    """Rate limiter that respects exchange-specific limits"""
    
    def __init__(self, exchange_id: str):
        self.exchange_id = exchange_id
        self.limits = {}
        self._initialize_limits()
    
    def _initialize_limits(self) -> None:
        """Initialize exchange-specific rate limits"""
        exchange_limits = {
            'binance': {'requests': 1200, 'window': 60.0},  # 1200 requests per minute
            'coinbase': {'requests': 30, 'window': 1.0},    # 30 requests per second
            'kraken': {'requests': 15, 'window': 1.0},      # 15 requests per second
        }
        
        if self.exchange_id in exchange_limits:
            limit = exchange_limits[self.exchange_id]
            self.limits['default'] = {
                'requests': limit['requests'],
                'window': limit['window'],
                'last_reset': time.time()
            }
    
    async def throttle(self, cost: float = 1.0) -> None:
        limit = self.limits.get('default')
        if not limit:
            # No specific limit, use default delay
            await asyncio.sleep(0.1)
            return
        
        now = time.time()
        
        # Reset counter if window has passed
        if now - limit['last_reset'] > limit['window']:
            limit['requests'] = limit['requests']
            limit['last_reset'] = now
        
        # If we've exceeded the limit, wait
        if limit['requests'] <= 0:
            wait_time = limit['window'] - (now - limit['last_reset'])
            await asyncio.sleep(wait_time)
            limit['requests'] = limit['requests']
            limit['last_reset'] = time.time()
        
        limit['requests'] -= cost