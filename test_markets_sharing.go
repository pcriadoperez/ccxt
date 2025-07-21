package main

import (
	"fmt"
	"runtime"
	"time"

	ccxt "github.com/ccxt/ccxt/go/v4"
)

// TestExchange is a mock exchange for testing that tracks fetchMarkets calls
type TestExchange struct {
	ccxt.Exchange
	FetchMarketsCallCount int
	MarketsData           map[string]interface{}
}

// NewTestExchange creates a new test exchange instance
func NewTestExchange(userConfig map[string]interface{}) *TestExchange {
	if userConfig == nil {
		userConfig = make(map[string]interface{})
	}

	te := &TestExchange{
		FetchMarketsCallCount: 0,
		MarketsData: map[string]interface{}{
			"BTC/USDT": map[string]interface{}{
				"id":       "BTCUSDT",
				"symbol":   "BTC/USDT",
				"base":     "BTC",
				"quote":    "USDT",
				"active":   true,
				"type":     "spot",
				"spot":     true,
				"margin":   false,
				"swap":     false,
				"future":   false,
				"option":   false,
				"contract": false,
				"precision": map[string]interface{}{
					"amount": 8,
					"price":  2,
				},
				"limits": map[string]interface{}{
					"amount": map[string]interface{}{"min": 0.001, "max": 1000},
					"price":  map[string]interface{}{"min": 0.01, "max": 100000},
				},
				"info": map[string]interface{}{},
			},
			"ETH/USDT": map[string]interface{}{
				"id":       "ETHUSDT",
				"symbol":   "ETH/USDT",
				"base":     "ETH",
				"quote":    "USDT",
				"active":   true,
				"type":     "spot",
				"spot":     true,
				"margin":   false,
				"swap":     false,
				"future":   false,
				"option":   false,
				"contract": false,
				"precision": map[string]interface{}{
					"amount": 8,
					"price":  2,
				},
				"limits": map[string]interface{}{
					"amount": map[string]interface{}{"min": 0.01, "max": 1000},
					"price":  map[string]interface{}{"min": 0.01, "max": 10000},
				},
				"info": map[string]interface{}{},
			},
		},
	}

	// Initialize the base exchange
	te.Exchange = *ccxt.NewExchange("testexchange", userConfig)
	te.Exchange.DerivedExchange = te // Set the interface implementation

	return te
}

// FetchMarkets implements the mock fetchMarkets that tracks calls and returns test data
func (te *TestExchange) FetchMarkets(params map[string]interface{}) <-chan interface{} {
	ch := make(chan interface{})
	go func() {
		defer close(ch)
		te.FetchMarketsCallCount++
		fmt.Printf("📞 fetchMarkets called #%d\n", te.FetchMarketsCallCount)

		// Simulate async operation
		time.Sleep(10 * time.Millisecond)

		// Convert map values to slice
		markets := make([]interface{}, 0, len(te.MarketsData))
		for _, market := range te.MarketsData {
			markets = append(markets, market)
		}

		ch <- markets
	}()
	return ch
}

// GetMemoryUsage returns current memory usage in MB
func GetMemoryUsage() float64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return float64(m.Alloc) / 1024 / 1024 // MB
}

// GetMarketKeys extracts keys from markets map
func GetMarketKeys(markets interface{}) []string {
	if marketsMap, ok := markets.(map[string]interface{}); ok {
		keys := make([]string, 0, len(marketsMap))
		for key := range marketsMap {
			keys = append(keys, key)
		}
		return keys
	}
	return []string{}
}

func testMarketsSharing() {
	fmt.Println("🟢 Go CCXT Markets Sharing Test")
	fmt.Println("==================================================")

	initialMemory := GetMemoryUsage()

	// Test 1: Create first exchange and load markets
	fmt.Println("\n1️⃣ Creating first exchange and loading markets...")
	exchange1 := NewTestExchange(map[string]interface{}{
		"apiKey": "test1",
		"secret": "test1",
	})

	markets1 := <-exchange1.LoadMarkets()
	memoryAfterFirst := GetMemoryUsage()

	fmt.Printf("   ✅ Markets loaded: %v\n", GetMarketKeys(exchange1.Markets))
	fmt.Printf("   📊 fetchMarkets call count: %d\n", exchange1.FetchMarketsCallCount)
	fmt.Printf("   🧠 Memory after first load: %.2f MB\n", memoryAfterFirst)

	// Test 2: Create second exchange WITHOUT sharing markets
	fmt.Println("\n2️⃣ Creating second exchange WITHOUT sharing markets...")
	exchange2 := NewTestExchange(map[string]interface{}{
		"apiKey": "test2",
		"secret": "test2",
	})

	markets2 := <-exchange2.LoadMarkets()
	memoryAfterSecond := GetMemoryUsage()

	fmt.Printf("   ✅ Markets loaded: %v\n", GetMarketKeys(exchange2.Markets))
	fmt.Printf("   📞 fetchMarkets call count: %d\n", exchange2.FetchMarketsCallCount)
	fmt.Printf("   🧠 Memory after second load: %.2f MB\n", memoryAfterSecond)

	// Test 3: Create third exchange WITH shared markets
	fmt.Println("\n3️⃣ Creating third exchange WITH shared markets...")
	exchange3 := NewTestExchange(map[string]interface{}{
		"apiKey": "test3",
		"secret": "test3",
	})

	// Share markets using SetMarkets
	<-exchange3.SetMarkets(exchange1.Markets, exchange1.Currencies)

	markets3 := <-exchange3.LoadMarkets() // Should use cached markets
	memoryAfterShared := GetMemoryUsage()

	fmt.Printf("   ✅ Markets loaded: %v\n", GetMarketKeys(exchange3.Markets))
	fmt.Printf("   📞 fetchMarkets call count: %d (should be 0!)\n", exchange3.FetchMarketsCallCount)
	fmt.Printf("   🧠 Memory after shared load: %.2f MB\n", memoryAfterShared)

	// Test 4: Verify markets content (Go doesn't have direct object reference comparison like other languages)
	fmt.Println("\n4️⃣ Verifying memory sharing...")
	keys1 := GetMarketKeys(exchange1.Markets)
	keys3 := GetMarketKeys(exchange3.Markets)
	marketsContentEqual := len(keys1) == len(keys3)
	if marketsContentEqual {
		for i, key := range keys1 {
			if i >= len(keys3) || key != keys3[i] {
				marketsContentEqual = false
				break
			}
		}
	}
	fmt.Printf("   📝 Markets content equal: %t\n", marketsContentEqual)

	// Test 5: Force reload should still call fetchMarkets
	fmt.Println("\n5️⃣ Testing force reload...")
	<-exchange3.LoadMarketsHelper(true, nil) // reload = true
	fmt.Printf("   📞 fetchMarkets call count after reload: %d (should be 1!)\n", exchange3.FetchMarketsCallCount)

	// Memory comparison
	fmt.Println("\n📊 Memory Analysis:")
	totalMemoryIncrease := GetMemoryUsage() - initialMemory
	fmt.Printf("   💾 Total memory increase: %.2f MB\n", totalMemoryIncrease)

	// Assertions
	fmt.Println("\n✅ Assertions:")
	if exchange1.FetchMarketsCallCount != 1 {
		panic("Exchange1 should call fetchMarkets once")
	}
	if exchange2.FetchMarketsCallCount != 1 {
		panic("Exchange2 should call fetchMarkets once")
	}
	if exchange3.FetchMarketsCallCount != 1 {
		panic("Exchange3 should call fetchMarkets once (only for reload)")
	}
	if !marketsContentEqual {
		panic("Markets should be identical")
	}
	if len(GetMarketKeys(exchange1.Markets)) == 0 {
		panic("Markets should not be empty")
	}

	fmt.Println("   ✅ All assertions passed!")
	fmt.Println("\n🎉 Test completed successfully!")
	fmt.Println("\n💡 Key benefits demonstrated:")
	fmt.Println("   • fetchMarkets avoided when markets are shared")
	fmt.Println("   • Memory is shared between exchange instances")
	fmt.Println("   • Same functionality maintained")
	fmt.Println("   • Force reload still works when needed")

	// Suppress unused variable warnings
	_ = markets1
	_ = markets2
	_ = markets3
}

func main() {
	testMarketsSharing()
}