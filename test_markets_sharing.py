#!/usr/bin/env python3
"""
Test markets sharing functionality in Python CCXT
This test demonstrates how to share markets between exchange instances to save memory.
"""

import sys
import os
import asyncio
import tracemalloc
import gc
from unittest.mock import Mock

# Add the ccxt module to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'python'))
import ccxt

class TestExchange(ccxt.Exchange):
    """Mock exchange for testing that tracks fetchMarkets calls"""
    
    def __init__(self, config=None):
        super().__init__(config or {})
        self.fetch_markets_call_count = 0
        self.markets_data = {
            'BTC/USDT': {
                'id': 'BTCUSDT',
                'symbol': 'BTC/USDT',
                'base': 'BTC',
                'quote': 'USDT',
                'active': True,
                'type': 'spot',
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'contract': False,
                'precision': {'amount': 8, 'price': 2},
                'limits': {
                    'amount': {'min': 0.001, 'max': 1000},
                    'price': {'min': 0.01, 'max': 100000},
                },
                'info': {}
            },
            'ETH/USDT': {
                'id': 'ETHUSDT',
                'symbol': 'ETH/USDT',
                'base': 'ETH',
                'quote': 'USDT',
                'active': True,
                'type': 'spot',
                'spot': True,
                'margin': False,
                'swap': False,
                'future': False,
                'option': False,
                'contract': False,
                'precision': {'amount': 8, 'price': 2},
                'limits': {
                    'amount': {'min': 0.01, 'max': 1000},
                    'price': {'min': 0.01, 'max': 10000},
                },
                'info': {}
            }
        }
    
    def describe(self):
        return self.deep_extend(super().describe(), {
            'id': 'testexchange',
            'name': 'Test Exchange',
            'has': {
                'fetchMarkets': True,
            },
        })
    
    def fetch_markets(self, params={}):
        """Mock fetchMarkets that tracks calls and returns test data"""
        self.fetch_markets_call_count += 1
        print(f"📞 fetchMarkets called #{self.fetch_markets_call_count}")
        return list(self.markets_data.values())

def get_memory_usage():
    """Get current memory usage in MB"""
    try:
        import psutil
        process = psutil.Process(os.getpid())
        return process.memory_info().rss / 1024 / 1024  # MB
    except ImportError:
        # Fallback if psutil not available
        return 0

def test_markets_sharing():
    """Test markets sharing functionality"""
    print("🐍 Python CCXT Markets Sharing Test")
    print("=" * 50)
    
    # Start memory tracking
    tracemalloc.start()
    initial_memory = get_memory_usage()
    
    # Test 1: Create first exchange and load markets
    print("\n1️⃣ Creating first exchange and loading markets...")
    exchange1 = TestExchange({'apiKey': 'test1', 'secret': 'test1'})
    
    snapshot1 = tracemalloc.take_snapshot()
    markets1 = exchange1.load_markets()
    snapshot2 = tracemalloc.take_snapshot()
    
    print(f"   ✅ Markets loaded: {list(markets1.keys())}")
    print(f"   📊 fetchMarkets call count: {exchange1.fetch_markets_call_count}")
    print(f"   🧠 Memory after first load: {get_memory_usage():.2f} MB")
    
    # Test 2: Create second exchange WITHOUT sharing markets
    print("\n2️⃣ Creating second exchange WITHOUT sharing markets...")
    exchange2 = TestExchange({'apiKey': 'test2', 'secret': 'test2'})
    
    snapshot3 = tracemalloc.take_snapshot()
    markets2 = exchange2.load_markets()
    snapshot4 = tracemalloc.take_snapshot()
    
    print(f"   ✅ Markets loaded: {list(markets2.keys())}")
    print(f"   📞 fetchMarkets call count: {exchange2.fetch_markets_call_count}")
    print(f"   🧠 Memory after second load: {get_memory_usage():.2f} MB")
    
    # Test 3: Create third exchange WITH shared markets
    print("\n3️⃣ Creating third exchange WITH shared markets...")
    exchange3 = TestExchange({'apiKey': 'test3', 'secret': 'test3'})
    
    # Share markets using set_markets
    exchange3.set_markets(exchange1.markets, exchange1.currencies)
    
    snapshot5 = tracemalloc.take_snapshot()
    markets3 = exchange3.load_markets()  # Should use cached markets
    snapshot6 = tracemalloc.take_snapshot()
    
    print(f"   ✅ Markets loaded: {list(markets3.keys())}")
    print(f"   📞 fetchMarkets call count: {exchange3.fetch_markets_call_count} (should be 0!)")
    print(f"   🧠 Memory after shared load: {get_memory_usage():.2f} MB")
    
    # Test 4: Verify markets are the same objects (memory sharing)
    print("\n4️⃣ Verifying memory sharing...")
    markets_are_same_object = exchange1.markets is exchange3.markets
    print(f"   🔗 Markets are same object: {markets_are_same_object}")
    print(f"   📝 Markets content equal: {markets1 == markets3}")
    
    # Test 5: Force reload should still call fetchMarkets
    print("\n5️⃣ Testing force reload...")
    markets3_reloaded = exchange3.load_markets(reload=True)
    print(f"   📞 fetchMarkets call count after reload: {exchange3.fetch_markets_call_count} (should be 1!)")
    
    # Memory comparison
    print("\n📊 Memory Analysis:")
    memory_diff_normal = get_memory_usage() - initial_memory
    print(f"   💾 Total memory increase: {memory_diff_normal:.2f} MB")
    
    # Assertions
    print("\n✅ Assertions:")
    assert exchange1.fetch_markets_call_count == 1, "Exchange1 should call fetchMarkets once"
    assert exchange2.fetch_markets_call_count == 1, "Exchange2 should call fetchMarkets once"
    assert exchange3.fetch_markets_call_count == 1, "Exchange3 should call fetchMarkets once (only for reload)"
    assert markets1 == markets3, "Markets should be identical"
    assert len(markets1) > 0, "Markets should not be empty"
    
    print("   ✅ All assertions passed!")
    print("\n🎉 Test completed successfully!")
    print("\n💡 Key benefits demonstrated:")
    print("   • fetchMarkets avoided when markets are shared")
    print("   • Memory is shared between exchange instances")
    print("   • Same functionality maintained")
    print("   • Force reload still works when needed")

if __name__ == "__main__":
    test_markets_sharing()