package examples;

import io.github.ccxt.exchanges.Binance;
import io.github.ccxt.errors.*;
import io.github.ccxt.types.Ticker;

import java.util.Map;

/**
 * Demonstrates error handling patterns with CCXT Java.
 *
 * Usage:
 *   cd java && ./gradlew :examples:run -PmainClass=examples.ErrorHandling
 */
public class ErrorHandling {

    public static void main(String[] args) {
        Binance exchange = new Binance();

        exchange.loadMarkets(false);

        // 1. Handle bad symbol — typed wrappers throw CCXT errors directly (joinUnwrapped).
        System.out.println("--- Test 1: Invalid symbol ---");
        try {
            exchange.fetchTicker("INVALID/NOTEXIST");
        } catch (BadSymbol e) {
            System.out.println("Caught BadSymbol: " + shorten(e.getMessage()));
        } catch (ExchangeError e) {
            System.out.println("Caught ExchangeError: " + shorten(e.getMessage()));
        }

        // 2. Handle authentication error
        System.out.println("\n--- Test 2: Auth required without credentials ---");
        try {
            exchange.fetchBalance((Map<String, Object>) null);
        } catch (AuthenticationError e) {
            System.out.println("Caught AuthenticationError: " + shorten(e.getMessage()));
        } catch (ExchangeError e) {
            System.out.println("Caught ExchangeError: " + shorten(e.getMessage()));
        }

        // 3. Successful request
        System.out.println("\n--- Test 3: Successful ticker fetch ---");
        try {
            Ticker ticker = exchange.fetchTicker("BTC/USDT");
            System.out.println("Success: BTC/USDT last=" + ticker.last);
        } catch (BaseError e) {
            System.out.println("Unexpected error: " + e.getMessage());
        }

        System.out.println("\nAll error handling tests completed.");
    }

    static String shorten(String s) {
        if (s == null) return "null";
        return s.length() > 100 ? s.substring(0, 100) + "..." : s;
    }
}
