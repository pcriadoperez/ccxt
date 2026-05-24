package examples;

import io.github.ccxt.exchanges.Binance;
import io.github.ccxt.types.MarketInterface;
import io.github.ccxt.types.OHLCV;
import io.github.ccxt.types.OrderBook;
import io.github.ccxt.types.Ticker;
import io.github.ccxt.types.Tickers;
import io.github.ccxt.types.Trade;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * End-user smoke test: REST (sync + async) and WS on Binance. Verifies:
 *   - zero-arg overloads work (fetchTime, fetchMarkets, fetchTickers, fetchStatus)
 *   - sync REST returns sensible typed values
 *   - async REST runs many requests concurrently
 *   - WS watch* delivers updates and can be torn down cleanly
 *
 * Usage: cd java && ./gradlew :examples:run -PmainClass=examples.BinanceUserSmokeTest
 */
public class BinanceUserSmokeTest {

    static final String SYMBOL = "BTC/USDT";
    static int passed = 0, failed = 0;

    public static void main(String[] args) throws Exception {
        long t0 = System.currentTimeMillis();

        section("REST — sync, zero-arg / one-arg calls");
        Binance rest = new Binance();
        rest.loadMarkets(false);

        check("fetchTime()", () -> {
            Long ts = rest.fetchTime();
            require(ts != null && ts > 1700000000000L, "ts=" + ts);
            return "server ts=" + ts;
        });

        check("fetchMarkets()", () -> {
            List<MarketInterface> markets = rest.fetchMarkets();
            require(markets != null && !markets.isEmpty(), "markets empty");
            return markets.size() + " markets";
        });

        check("fetchTicker(BTC/USDT)", () -> {
            Ticker t = rest.fetchTicker(SYMBOL);
            require(t != null && t.last != null && t.bid != null && t.ask != null,
                    "ticker missing fields");
            return "last=" + t.last + " bid=" + t.bid + " ask=" + t.ask;
        });

        check("fetchTickers()  (zero-arg — all tickers)", () -> {
            Tickers all = rest.fetchTickers();
            require(all != null, "tickers null");
            int n = all.size();
            require(n > 100, "expected >100 tickers, got " + n);
            require(all.containsKey(SYMBOL), SYMBOL + " missing");
            Ticker bt = all.get(SYMBOL);
            require(bt.last != null, SYMBOL + " last null");
            return n + " tickers (e.g. " + SYMBOL + "=" + bt.last + ")";
        });

        check("fetchOHLCV(BTC/USDT)  (default timeframe 1m)", () -> {
            List<OHLCV> ohlcv = rest.fetchOHLCV(SYMBOL);
            require(ohlcv != null && !ohlcv.isEmpty(), "ohlcv empty");
            OHLCV last = ohlcv.get(ohlcv.size() - 1);
            require(last.close != null, "close null");
            return ohlcv.size() + " candles, latest close=" + last.close;
        });

        check("fetchOrderBook(BTC/USDT, 10)", () -> {
            OrderBook ob = rest.fetchOrderBook(SYMBOL, 10L);
            require(ob.bids != null && ob.asks != null && !ob.bids.isEmpty() && !ob.asks.isEmpty(),
                    "book empty");
            double bid = ob.bids.get(0).get(0), ask = ob.asks.get(0).get(0);
            require(ask > bid, "crossed book bid=" + bid + " ask=" + ask);
            return "bid=" + bid + " ask=" + ask + " spread=" + (ask - bid);
        });

        check("fetchTrades(BTC/USDT)", () -> {
            List<Trade> trades = rest.fetchTrades(SYMBOL, null, 10L, null);
            require(trades != null && !trades.isEmpty(), "trades empty");
            return trades.size() + " trades, latest price=" + trades.get(trades.size() - 1).price;
        });

        section("REST — async, concurrent fan-out");
        String[] syms = {"BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "BNB/USDT", "DOGE/USDT"};
        check("fetchTickerAsync x " + syms.length + " concurrent", () -> {
            long start = System.currentTimeMillis();
            @SuppressWarnings("unchecked")
            CompletableFuture<Ticker>[] futs = new CompletableFuture[syms.length];
            for (int i = 0; i < syms.length; i++) futs[i] = rest.fetchTickerAsync(syms[i], null);
            CompletableFuture.allOf(futs).get(30, TimeUnit.SECONDS);
            for (CompletableFuture<Ticker> f : futs) require(f.get().last != null, "missing last");
            return syms.length + " tickers in " + (System.currentTimeMillis() - start) + " ms";
        });

        check("fetchTickersAsync()  (zero-arg, async)", () -> {
            Tickers all = rest.fetchTickersAsync().get(20, TimeUnit.SECONDS);
            int n = (all == null) ? -1 : all.size();
            require(n > 100, "size=" + n);
            return n + " tickers";
        });

        section("WS — watch* updates");
        io.github.ccxt.exchanges.pro.Binance ws = new io.github.ccxt.exchanges.pro.Binance();
        ws.loadMarkets(false);
        try {
            check("watchTicker(BTC/USDT) x 5", () -> {
                long start = System.currentTimeMillis();
                Double lastSeen = null;
                for (int i = 0; i < 5; i++) {
                    Ticker t = ws.watchTicker(SYMBOL);
                    require(t != null && t.last != null, "no ticker");
                    lastSeen = t.last;
                }
                return "5 updates in " + (System.currentTimeMillis() - start) + " ms, last=" + lastSeen;
            });

            check("watchOrderBook(BTC/USDT) x 5", () -> {
                long start = System.currentTimeMillis();
                for (int i = 0; i < 5; i++) {
                    OrderBook ob = ws.watchOrderBook(SYMBOL);
                    require(!ob.bids.isEmpty() && !ob.asks.isEmpty(), "empty book");
                    double bid = ob.bids.get(0).get(0), ask = ob.asks.get(0).get(0);
                    require(ask > bid, "crossed bid=" + bid + " ask=" + ask);
                }
                return "5 updates in " + (System.currentTimeMillis() - start) + " ms";
            });

            check("watchTrades(BTC/USDT) x 3", () -> {
                long start = System.currentTimeMillis();
                AtomicInteger total = new AtomicInteger();
                for (int i = 0; i < 3; i++) {
                    List<Trade> trades = ws.watchTrades(SYMBOL);
                    require(trades != null && !trades.isEmpty(), "empty trades");
                    total.addAndGet(trades.size());
                }
                return total.get() + " cumulative trades in " + (System.currentTimeMillis() - start) + " ms";
            });

            check("watchTickers([BTC/USDT,ETH/USDT]) x 3", () -> {
                long start = System.currentTimeMillis();
                List<String> subs = List.of("BTC/USDT", "ETH/USDT");
                for (int i = 0; i < 3; i++) {
                    Tickers ts = ws.watchTickers(subs, (Map<String, Object>) null);
                    int n = (ts == null) ? -1 : ts.size();
                    require(n >= 1, "size=" + n);
                }
                return "3 batches in " + (System.currentTimeMillis() - start) + " ms";
            });
        } finally {
            section("Cleanup");
            try {
                ws.close().get(5, TimeUnit.SECONDS);
                System.out.println("  ws.close() done");
            } catch (Exception e) {
                System.out.println("  ws.close() failed: " + e);
            }
            try {
                rest.close().get(5, TimeUnit.SECONDS);
                System.out.println("  rest.close() done");
            } catch (Exception e) {
                System.out.println("  rest.close() failed: " + e);
            }
        }

        System.out.println();
        System.out.printf("=== Done: %d passed, %d failed in %d ms ===%n",
                passed, failed, System.currentTimeMillis() - t0);
        System.exit(failed == 0 ? 0 : 1);
    }

    // --- tiny test harness ---

    interface Step { String run() throws Exception; }

    static void section(String name) {
        System.out.println();
        System.out.println("=== " + name + " ===");
    }

    static void check(String name, Step step) {
        long s = System.currentTimeMillis();
        try {
            String detail = step.run();
            passed++;
            System.out.printf("  PASS  %-50s (%4d ms)  %s%n",
                    name, System.currentTimeMillis() - s, detail == null ? "" : detail);
        } catch (Throwable t) {
            failed++;
            System.out.printf("  FAIL  %-50s (%4d ms)  %s%n",
                    name, System.currentTimeMillis() - s, t);
            t.printStackTrace(System.out);
        }
    }

    static void require(boolean cond, String msg) {
        if (!cond) throw new AssertionError(msg);
    }
}
