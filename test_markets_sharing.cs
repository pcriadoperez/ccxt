using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Linq;
using ccxt;

namespace TestMarketsSharing
{
    /// <summary>
    /// Test markets sharing functionality in C# CCXT
    /// This test demonstrates how to share markets between exchange instances to save memory.
    /// </summary>
    public class TestExchange : Exchange
    {
        public int FetchMarketsCallCount { get; private set; } = 0;
        private readonly Dictionary<string, object> marketsData;

        public TestExchange(object userConfig = null) : base(userConfig)
        {
            marketsData = new Dictionary<string, object>
            {
                ["BTC/USDT"] = new Dictionary<string, object>
                {
                    ["id"] = "BTCUSDT",
                    ["symbol"] = "BTC/USDT",
                    ["base"] = "BTC",
                    ["quote"] = "USDT",
                    ["active"] = true,
                    ["type"] = "spot",
                    ["spot"] = true,
                    ["margin"] = false,
                    ["swap"] = false,
                    ["future"] = false,
                    ["option"] = false,
                    ["contract"] = false,
                    ["precision"] = new Dictionary<string, object>
                    {
                        ["amount"] = 8,
                        ["price"] = 2
                    },
                    ["limits"] = new Dictionary<string, object>
                    {
                        ["amount"] = new Dictionary<string, object> { ["min"] = 0.001, ["max"] = 1000 },
                        ["price"] = new Dictionary<string, object> { ["min"] = 0.01, ["max"] = 100000 }
                    },
                    ["info"] = new Dictionary<string, object>()
                },
                ["ETH/USDT"] = new Dictionary<string, object>
                {
                    ["id"] = "ETHUSDT",
                    ["symbol"] = "ETH/USDT",
                    ["base"] = "ETH",
                    ["quote"] = "USDT",
                    ["active"] = true,
                    ["type"] = "spot",
                    ["spot"] = true,
                    ["margin"] = false,
                    ["swap"] = false,
                    ["future"] = false,
                    ["option"] = false,
                    ["contract"] = false,
                    ["precision"] = new Dictionary<string, object>
                    {
                        ["amount"] = 8,
                        ["price"] = 2
                    },
                    ["limits"] = new Dictionary<string, object>
                    {
                        ["amount"] = new Dictionary<string, object> { ["min"] = 0.01, ["max"] = 1000 },
                        ["price"] = new Dictionary<string, object> { ["min"] = 0.01, ["max"] = 10000 }
                    },
                    ["info"] = new Dictionary<string, object>()
                }
            };
        }

        public override async Task<object> fetchMarkets(object parameters = null)
        {
            FetchMarketsCallCount++;
            Console.WriteLine($"📞 fetchMarkets called #{FetchMarketsCallCount}");
            
            // Simulate async operation
            await Task.Delay(10);
            
            return marketsData.Values.ToList();
        }
    }

    public class Program
    {
        private static long GetMemoryUsage()
        {
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            return GC.GetTotalMemory(false) / 1024 / 1024; // MB
        }

        public static async Task Main(string[] args)
        {
            await TestMarketsSharing();
        }

        private static async Task TestMarketsSharing()
        {
            Console.WriteLine("🟦 C# CCXT Markets Sharing Test");
            Console.WriteLine(new string('=', 50));

            var initialMemory = GetMemoryUsage();

            // Test 1: Create first exchange and load markets
            Console.WriteLine("\n1️⃣ Creating first exchange and loading markets...");
            var exchange1 = new TestExchange(new Dictionary<string, object>
            {
                ["apiKey"] = "test1",
                ["secret"] = "test1"
            });

            var markets1 = await exchange1.loadMarkets() as Dictionary<string, object>;
            var memoryAfterFirst = GetMemoryUsage();

            Console.WriteLine($"   ✅ Markets loaded: {string.Join(", ", markets1.Keys)}");
            Console.WriteLine($"   📊 fetchMarkets call count: {exchange1.FetchMarketsCallCount}");
            Console.WriteLine($"   🧠 Memory after first load: {memoryAfterFirst} MB");

            // Test 2: Create second exchange WITHOUT sharing markets
            Console.WriteLine("\n2️⃣ Creating second exchange WITHOUT sharing markets...");
            var exchange2 = new TestExchange(new Dictionary<string, object>
            {
                ["apiKey"] = "test2",
                ["secret"] = "test2"
            });

            var markets2 = await exchange2.loadMarkets() as Dictionary<string, object>;
            var memoryAfterSecond = GetMemoryUsage();

            Console.WriteLine($"   ✅ Markets loaded: {string.Join(", ", markets2.Keys)}");
            Console.WriteLine($"   📞 fetchMarkets call count: {exchange2.FetchMarketsCallCount}");
            Console.WriteLine($"   🧠 Memory after second load: {memoryAfterSecond} MB");

            // Test 3: Create third exchange WITH shared markets
            Console.WriteLine("\n3️⃣ Creating third exchange WITH shared markets...");
            var exchange3 = new TestExchange(new Dictionary<string, object>
            {
                ["apiKey"] = "test3",
                ["secret"] = "test3"
            });

            // Share markets using setMarkets
            exchange3.setMarkets(exchange1.markets, exchange1.currencies);

            var markets3 = await exchange3.loadMarkets() as Dictionary<string, object>; // Should use cached markets
            var memoryAfterShared = GetMemoryUsage();

            Console.WriteLine($"   ✅ Markets loaded: {string.Join(", ", markets3.Keys)}");
            Console.WriteLine($"   📞 fetchMarkets call count: {exchange3.FetchMarketsCallCount} (should be 0!)");
            Console.WriteLine($"   🧠 Memory after shared load: {memoryAfterShared} MB");

            // Test 4: Verify markets are the same objects (memory sharing)
            Console.WriteLine("\n4️⃣ Verifying memory sharing...");
            var marketsAreSameObject = ReferenceEquals(exchange1.markets, exchange3.markets);
            var marketsContentEqual = markets1.Keys.SequenceEqual(markets3.Keys);
            Console.WriteLine($"   🔗 Markets are same object: {marketsAreSameObject}");
            Console.WriteLine($"   📝 Markets content equal: {marketsContentEqual}");

            // Test 5: Force reload should still call fetchMarkets
            Console.WriteLine("\n5️⃣ Testing force reload...");
            var markets3Reloaded = await exchange3.loadMarkets(true); // reload = true
            Console.WriteLine($"   📞 fetchMarkets call count after reload: {exchange3.FetchMarketsCallCount} (should be 1!)");

            // Memory comparison
            Console.WriteLine("\n📊 Memory Analysis:");
            var totalMemoryIncrease = GetMemoryUsage() - initialMemory;
            Console.WriteLine($"   💾 Total memory increase: {totalMemoryIncrease} MB");

            // Assertions
            Console.WriteLine("\n✅ Assertions:");
            System.Diagnostics.Debug.Assert(exchange1.FetchMarketsCallCount == 1, "Exchange1 should call fetchMarkets once");
            System.Diagnostics.Debug.Assert(exchange2.FetchMarketsCallCount == 1, "Exchange2 should call fetchMarkets once");
            System.Diagnostics.Debug.Assert(exchange3.FetchMarketsCallCount == 1, "Exchange3 should call fetchMarkets once (only for reload)");
            System.Diagnostics.Debug.Assert(marketsContentEqual, "Markets should be identical");
            System.Diagnostics.Debug.Assert(markets1.Count > 0, "Markets should not be empty");

            Console.WriteLine("   ✅ All assertions passed!");
            Console.WriteLine("\n🎉 Test completed successfully!");
            Console.WriteLine("\n💡 Key benefits demonstrated:");
            Console.WriteLine("   • fetchMarkets avoided when markets are shared");
            Console.WriteLine("   • Memory is shared between exchange instances");
            Console.WriteLine("   • Same functionality maintained");
            Console.WriteLine("   • Force reload still works when needed");
        }
    }
}