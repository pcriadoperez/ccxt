import io.github.ccxt.Exchange;
import io.github.ccxt.ExchangeTyped;
import io.github.ccxt.types.*;

import java.util.List;

/**
 * Example: Fetch BTC/USDT order book from multiple exchanges using CCXT Java.
 *
 * Run from the repo root:
 *   cd java && ./gradlew :lib:compileJava
 *   # then run this file with the lib on classpath
 */
public class FetchOrderBooks {

    public static void main(String[] args) {

        String[] exchanges = {"okx", "poloniex", "binance"};
        String symbol = "BTC/USDT";

        for (String exchangeId : exchanges) {
            System.out.println("\n=== " + exchangeId.toUpperCase() + " ===");
            try {
                // Create exchange and typed wrapper
                var raw = Exchange.dynamicallyCreateInstance(exchangeId, null);
                var exchange = new ExchangeTyped(raw);

                // Load markets
                exchange.loadMarkets();

                // Fetch order book — fully typed, no casts needed
                OrderBook ob = exchange.fetchOrderBook(symbol);

                System.out.println(symbol + " Order Book:");
                System.out.println("  Bids: " + ob.bids.size() + " levels");
                System.out.println("  Asks: " + ob.asks.size() + " levels");

                // Print top 5 bids and asks
                System.out.println("  Top 5 Bids:");
                for (int i = 0; i < Math.min(5, ob.bids.size()); i++) {
                    List<Double> bid = ob.bids.get(i);
                    System.out.printf("    $%,.2f  x  %.6f%n", bid.get(0), bid.get(1));
                }

                System.out.println("  Top 5 Asks:");
                for (int i = 0; i < Math.min(5, ob.asks.size()); i++) {
                    List<Double> ask = ob.asks.get(i);
                    System.out.printf("    $%,.2f  x  %.6f%n", ask.get(0), ask.get(1));
                }

                // Spread
                if (!ob.bids.isEmpty() && !ob.asks.isEmpty()) {
                    double bestBid = ob.bids.get(0).get(0);
                    double bestAsk = ob.asks.get(0).get(0);
                    double spread = bestAsk - bestBid;
                    System.out.printf("  Spread: $%.2f (%.4f%%)%n", spread, (spread / bestAsk) * 100);
                }

            } catch (Exception e) {
                System.out.println("  Error: " + e.getMessage());
            }
        }
    }
}
