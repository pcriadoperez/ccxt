package io.github.ccxt.types;

import io.github.ccxt.wrappers.Okx;
import io.github.ccxt.wrappers.Poloniex;
import io.github.ccxt.wrappers.Binance;
import io.github.ccxt.ExchangeTyped;

import java.util.List;

/**
 * Example: Fetch BTC/USDT order book from multiple exchanges
 * using per-exchange typed wrappers.
 *
 * Run:  cd java && ./gradlew :lib:example
 */
public class FetchOrderBooksExample {

    static void printOrderBook(String exchangeName, ExchangeTyped exchange, String symbol) {
        System.out.println("\n=== " + exchangeName + " ===");
        try {
            exchange.loadMarkets();

            OrderBook ob = exchange.fetchOrderBook(symbol);

            System.out.println(symbol + " Order Book:");
            System.out.println("  Bids: " + ob.bids.size() + " levels");
            System.out.println("  Asks: " + ob.asks.size() + " levels");

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

    public static void main(String[] args) {

        String symbol = "BTC/USDT";

        // Per-exchange typed wrappers — only expose methods each exchange supports
        var okx = new Okx();
        var poloniex = new Poloniex();
        var binance = new Binance();

        printOrderBook("OKX", okx, symbol);
        printOrderBook("POLONIEX", poloniex, symbol);
        printOrderBook("BINANCE", binance, symbol);
    }
}
