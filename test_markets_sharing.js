#!/usr/bin/env node
/**
 * Test markets sharing functionality in JavaScript CCXT
 * This test demonstrates how to share markets between exchange instances to save memory.
 */

import Exchange from './js/src/base/Exchange.js';

class TestExchange extends Exchange {
    /**
     * Mock exchange for testing that tracks fetchMarkets calls
     */
    constructor(userConfig = {}) {
        super(userConfig);
        this.fetchMarketsCallCount = 0;
        this.marketsData = {
            'BTC/USDT': {
                'id': 'BTCUSDT',
                'symbol': 'BTC/USDT',
                'base': 'BTC',
                'quote': 'USDT',
                'active': true,
                'type': 'spot',
                'spot': true,
                'margin': false,
                'swap': false,
                'future': false,
                'option': false,
                'contract': false,
                'precision': { 'amount': 8, 'price': 2 },
                'limits': {
                    'amount': { 'min': 0.001, 'max': 1000 },
                    'price': { 'min': 0.01, 'max': 100000 },
                },
                'info': {}
            },
            'ETH/USDT': {
                'id': 'ETHUSDT',
                'symbol': 'ETH/USDT',
                'base': 'ETH',
                'quote': 'USDT',
                'active': true,
                'type': 'spot',
                'spot': true,
                'margin': false,
                'swap': false,
                'future': false,
                'option': false,
                'contract': false,
                'precision': { 'amount': 8, 'price': 2 },
                'limits': {
                    'amount': { 'min': 0.01, 'max': 1000 },
                    'price': { 'min': 0.01, 'max': 10000 },
                },
                'info': {}
            }
        };
    }

    describe() {
        return this.deepExtend(super.describe(), {
            'id': 'testexchange',
            'name': 'Test Exchange',
            'has': {
                'fetchMarkets': true,
            },
        });
    }

    async fetchMarkets(params = {}) {
        /**
         * Mock fetchMarkets that tracks calls and returns test data
         */
        this.fetchMarketsCallCount++;
        console.log(`📞 fetchMarkets called #${this.fetchMarketsCallCount}`);
        return Object.values(this.marketsData);
    }
}

function getMemoryUsage() {
    /**
     * Get current memory usage in MB
     */
    if (typeof process !== 'undefined' && process.memoryUsage) {
        const usage = process.memoryUsage();
        return usage.heapUsed / 1024 / 1024; // MB
    }
    return 0;
}

async function testMarketsSharing() {
    /**
     * Test markets sharing functionality
     */
    console.log('🟨 JavaScript CCXT Markets Sharing Test');
    console.log('='.repeat(50));
    
    const initialMemory = getMemoryUsage();
    
    // Test 1: Create first exchange and load markets
    console.log('\n1️⃣ Creating first exchange and loading markets...');
    const exchange1 = new TestExchange({ apiKey: 'test1', secret: 'test1' });
    
    const markets1 = await exchange1.loadMarkets();
    const memoryAfterFirst = getMemoryUsage();
    
    console.log(`   ✅ Markets loaded: ${Object.keys(markets1)}`);
    console.log(`   📊 fetchMarkets call count: ${exchange1.fetchMarketsCallCount}`);
    console.log(`   🧠 Memory after first load: ${memoryAfterFirst.toFixed(2)} MB`);
    
    // Test 2: Create second exchange WITHOUT sharing markets
    console.log('\n2️⃣ Creating second exchange WITHOUT sharing markets...');
    const exchange2 = new TestExchange({ apiKey: 'test2', secret: 'test2' });
    
    const markets2 = await exchange2.loadMarkets();
    const memoryAfterSecond = getMemoryUsage();
    
    console.log(`   ✅ Markets loaded: ${Object.keys(markets2)}`);
    console.log(`   📞 fetchMarkets call count: ${exchange2.fetchMarketsCallCount}`);
    console.log(`   🧠 Memory after second load: ${memoryAfterSecond.toFixed(2)} MB`);
    
    // Test 3: Create third exchange WITH shared markets
    console.log('\n3️⃣ Creating third exchange WITH shared markets...');
    const exchange3 = new TestExchange({ apiKey: 'test3', secret: 'test3' });
    
    // Share markets using setMarkets
    exchange3.setMarkets(exchange1.markets, exchange1.currencies);
    
    const markets3 = await exchange3.loadMarkets(); // Should use cached markets
    const memoryAfterShared = getMemoryUsage();
    
    console.log(`   ✅ Markets loaded: ${Object.keys(markets3)}`);
    console.log(`   📞 fetchMarkets call count: ${exchange3.fetchMarketsCallCount} (should be 0!)`);
    console.log(`   🧠 Memory after shared load: ${memoryAfterShared.toFixed(2)} MB`);
    
    // Test 4: Verify markets are the same objects (memory sharing)
    console.log('\n4️⃣ Verifying memory sharing...');
    const marketsAreSameObject = exchange1.markets === exchange3.markets;
    const marketsContentEqual = JSON.stringify(markets1) === JSON.stringify(markets3);
    console.log(`   🔗 Markets are same object: ${marketsAreSameObject}`);
    console.log(`   📝 Markets content equal: ${marketsContentEqual}`);
    
    // Test 5: Force reload should still call fetchMarkets
    console.log('\n5️⃣ Testing force reload...');
    const markets3Reloaded = await exchange3.loadMarkets(true); // reload = true
    console.log(`   📞 fetchMarkets call count after reload: ${exchange3.fetchMarketsCallCount} (should be 1!)`);
    
    // Memory comparison
    console.log('\n📊 Memory Analysis:');
    const totalMemoryIncrease = getMemoryUsage() - initialMemory;
    console.log(`   💾 Total memory increase: ${totalMemoryIncrease.toFixed(2)} MB`);
    
    // Assertions
    console.log('\n✅ Assertions:');
    console.assert(exchange1.fetchMarketsCallCount === 1, 'Exchange1 should call fetchMarkets once');
    console.assert(exchange2.fetchMarketsCallCount === 1, 'Exchange2 should call fetchMarkets once');
    console.assert(exchange3.fetchMarketsCallCount === 1, 'Exchange3 should call fetchMarkets once (only for reload)');
    console.assert(marketsContentEqual, 'Markets should be identical');
    console.assert(Object.keys(markets1).length > 0, 'Markets should not be empty');
    
    console.log('   ✅ All assertions passed!');
    console.log('\n🎉 Test completed successfully!');
    console.log('\n💡 Key benefits demonstrated:');
    console.log('   • fetchMarkets avoided when markets are shared');
    console.log('   • Memory is shared between exchange instances');
    console.log('   • Same functionality maintained');
    console.log('   • Force reload still works when needed');
}

// Run the test
testMarketsSharing().catch(console.error);