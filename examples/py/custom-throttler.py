#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Example usage of custom throttlers in CCXT Python
"""

import ccxt
import asyncio
import time
from ccxt.base.throttle import CustomThrottler, SimpleDelayThrottler, CustomTokenBucketThrottler, AdaptiveThrottler, ExchangeAwareThrottler

# Example 1: Simple delay-based throttler
def example_simple_delay():
    print("=== Example 1: Simple Delay Throttler ===")
    
    # Create exchange with custom throttler
    exchange = ccxt.binance({
        'customThrottler': SimpleDelayThrottler(delay_seconds=0.5)  # 500ms delay between requests
    })
    
    try:
        # This will be throttled by the custom throttler
        ticker = exchange.fetch_ticker('BTC/USDT')
        print(f"Ticker: {ticker['symbol']} - Price: {ticker['last']}")
    except Exception as e:
        print(f"Error: {e}")

# Example 2: Custom token bucket throttler
def example_token_bucket():
    print("\n=== Example 2: Token Bucket Throttler ===")
    
    # Create exchange with custom token bucket throttler
    exchange = ccxt.coinbase({
        'customThrottler': CustomTokenBucketThrottler(capacity=10.0, refill_rate=2.0)  # 10 tokens, 2 per second refill
    })
    
    try:
        # Multiple requests will be throttled according to token bucket algorithm
        for i in range(3):
            ticker = exchange.fetch_ticker('BTC/USDT')
            print(f"Request {i+1}: {ticker['symbol']} - Price: {ticker['last']}")
            time.sleep(0.1)  # Small delay between requests
    except Exception as e:
        print(f"Error: {e}")

# Example 3: Adaptive throttler
def example_adaptive():
    print("\n=== Example 3: Adaptive Throttler ===")
    
    # Create adaptive throttler
    adaptive_throttler = AdaptiveThrottler(base_delay=0.1, max_delay=2.0)
    
    # Create exchange with adaptive throttler
    exchange = ccxt.kraken({
        'customThrottler': adaptive_throttler
    })
    
    try:
        # Make some requests
        for i in range(5):
            ticker = exchange.fetch_ticker('BTC/USDT')
            print(f"Request {i+1}: {ticker['symbol']} - Price: {ticker['last']}")
            
            # Simulate success/failure to test adaptive behavior
            if i % 2 == 0:
                adaptive_throttler.on_success()
                print("  -> Reported success")
            else:
                adaptive_throttler.on_error()
                print("  -> Reported error")
                
            time.sleep(0.1)
    except Exception as e:
        print(f"Error: {e}")

# Example 4: Exchange-aware throttler
def example_exchange_aware():
    print("\n=== Example 4: Exchange-Aware Throttler ===")
    
    # Create exchange-aware throttler for Binance
    exchange = ccxt.binance({
        'customThrottler': ExchangeAwareThrottler('binance')
    })
    
    try:
        # This will respect Binance's rate limits
        ticker = exchange.fetch_ticker('BTC/USDT')
        print(f"Ticker: {ticker['symbol']} - Price: {ticker['last']}")
        
        # Make a few more requests to see throttling in action
        for i in range(3):
            ticker = exchange.fetch_ticker('ETH/USDT')
            print(f"Request {i+1}: {ticker['symbol']} - Price: {ticker['last']}")
            time.sleep(0.1)
    except Exception as e:
        print(f"Error: {e}")

# Example 5: Custom throttler implementation
class MyCustomThrottler(CustomThrottler):
    """Custom throttler that implements exponential backoff"""
    
    def __init__(self, initial_delay=0.1, max_delay=5.0, backoff_factor=2.0):
        self.current_delay = initial_delay
        self.max_delay = max_delay
        self.backoff_factor = backoff_factor
        self.consecutive_errors = 0
    
    async def throttle(self, cost=None):
        # Wait for the current delay
        await asyncio.sleep(self.current_delay)
    
    def on_success(self):
        """Reset delay on success"""
        self.current_delay = 0.1
        self.consecutive_errors = 0
        print(f"  -> Success, reset delay to {self.current_delay}s")
    
    def on_error(self):
        """Increase delay on error with exponential backoff"""
        self.consecutive_errors += 1
        self.current_delay = min(self.max_delay, self.current_delay * self.backoff_factor)
        print(f"  -> Error #{self.consecutive_errors}, increased delay to {self.current_delay:.2f}s")

def example_custom_implementation():
    print("\n=== Example 5: Custom Implementation ===")
    
    # Create custom throttler
    custom_throttler = MyCustomThrottler(initial_delay=0.1, max_delay=2.0, backoff_factor=1.5)
    
    # Create exchange with custom throttler
    exchange = ccxt.binance({
        'customThrottler': custom_throttler
    })
    
    try:
        # Make some requests
        for i in range(5):
            ticker = exchange.fetch_ticker('BTC/USDT')
            print(f"Request {i+1}: {ticker['symbol']} - Price: {ticker['last']}")
            
            # Simulate some errors to test exponential backoff
            if i in [1, 3]:
                custom_throttler.on_error()
            else:
                custom_throttler.on_success()
                
            time.sleep(0.1)
    except Exception as e:
        print(f"Error: {e}")

# Example 6: Async usage with custom throttler
async def example_async_usage():
    print("\n=== Example 6: Async Usage ===")
    
    # Create async exchange with custom throttler
    exchange = ccxt.async_support.binance({
        'customThrottler': SimpleDelayThrottler(delay_seconds=0.2)
    })
    
    try:
        # Make async requests
        ticker = await exchange.fetch_ticker('BTC/USDT')
        print(f"Async ticker: {ticker['symbol']} - Price: {ticker['last']}")
        
        # Make another request
        ticker2 = await exchange.fetch_ticker('ETH/USDT')
        print(f"Async ticker2: {ticker2['symbol']} - Price: {ticker2['last']}")
        
    except Exception as e:
        print(f"Error: {e}")
    finally:
        await exchange.close()

def main():
    """Run all examples"""
    print("CCXT Custom Throttler Examples")
    print("=" * 50)
    
    # Run synchronous examples
    example_simple_delay()
    example_token_bucket()
    example_adaptive()
    example_exchange_aware()
    example_custom_implementation()
    
    # Run async example
    asyncio.run(example_async_usage())
    
    print("\n" + "=" * 50)
    print("All examples completed!")

if __name__ == "__main__":
    main()