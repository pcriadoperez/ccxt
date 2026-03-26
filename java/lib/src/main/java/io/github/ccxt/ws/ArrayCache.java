package io.github.ccxt.ws;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Fixed-size FIFO cache with deduplication and new-update tracking.
 * Matches C# ArrayCache.cs and JS Cache.ts.
 *
 * Used for streaming data: trades, tickers, OHLCV, etc.
 * When newUpdates=true, watch methods return only items added since last read.
 */
public class ArrayCache extends ArrayList<Object> {

    protected final int maxSize;
    protected final HashMap<String, Object> hashmap = new HashMap<>();
    protected final HashMap<String, Integer> newUpdatesBySymbol = new HashMap<>();
    protected int newUpdates = 0;

    public ArrayCache(int maxSize) {
        super();
        this.maxSize = maxSize > 0 ? maxSize : 1000;
    }

    public ArrayCache() {
        this(1000);
    }

    /**
     * Append an item to the cache. Evicts oldest if full.
     * Tracks new updates per symbol for the newUpdates mechanism.
     */
    @SuppressWarnings("unchecked")
    public void append(Object item) {
        if (this.size() >= this.maxSize) {
            this.remove(0);
        }
        this.add(item);
        this.newUpdates++;

        // Track per-symbol if item has a symbol field
        if (item instanceof Map) {
            Object symbol = ((Map<String, Object>) item).get("symbol");
            if (symbol instanceof String s) {
                this.newUpdatesBySymbol.merge(s, 1, Integer::sum);
            }
        }
    }

    /**
     * Get the number of new updates (since last call) for a symbol.
     * Resets the counter after reading.
     */
    public int getLimit(String symbol, Integer limit) {
        this.newUpdates = 0;
        if (symbol != null) {
            Integer count = this.newUpdatesBySymbol.remove(symbol);
            return count != null ? count : 0;
        }
        int total = 0;
        for (int v : this.newUpdatesBySymbol.values()) {
            total += v;
        }
        this.newUpdatesBySymbol.clear();
        return total;
    }

    // ─── Variants ───

    /**
     * Cache indexed by timestamp (for OHLCV data).
     * Updates existing entries by timestamp rather than appending duplicates.
     */
    public static class ArrayCacheByTimestamp extends ArrayCache {

        public ArrayCacheByTimestamp(int maxSize) { super(maxSize); }
        public ArrayCacheByTimestamp() { super(); }

        @Override
        @SuppressWarnings("unchecked")
        public void append(Object item) {
            if (item instanceof Map) {
                Map<String, Object> map = (Map<String, Object>) item;
                Object ts = map.get("timestamp");
                if (ts != null) {
                    String key = ts.toString();
                    Object existing = this.hashmap.get(key);
                    if (existing != null) {
                        // Update in place
                        int idx = this.indexOf(existing);
                        if (idx >= 0) {
                            this.set(idx, item);
                            this.hashmap.put(key, item);
                            this.newUpdates++;
                            return;
                        }
                    }
                    this.hashmap.put(key, item);
                }
            }
            super.append(item);
        }
    }

    /**
     * Cache indexed by symbol then by ID (for orders, positions).
     */
    public static class ArrayCacheBySymbolById extends ArrayCache {

        private final HashMap<String, HashMap<String, Object>> symbolMap = new HashMap<>();

        public ArrayCacheBySymbolById(int maxSize) { super(maxSize); }
        public ArrayCacheBySymbolById() { super(); }

        @Override
        @SuppressWarnings("unchecked")
        public void append(Object item) {
            if (item instanceof Map) {
                Map<String, Object> map = (Map<String, Object>) item;
                String symbol = map.get("symbol") != null ? map.get("symbol").toString() : "";
                String id = map.get("id") != null ? map.get("id").toString() : null;

                if (id != null) {
                    HashMap<String, Object> byId = symbolMap.computeIfAbsent(symbol, k -> new HashMap<>());
                    Object existing = byId.get(id);
                    if (existing != null) {
                        int idx = this.indexOf(existing);
                        if (idx >= 0) {
                            this.set(idx, item);
                            byId.put(id, item);
                            this.newUpdates++;
                            if (!symbol.isEmpty()) {
                                this.newUpdatesBySymbol.merge(symbol, 1, Integer::sum);
                            }
                            return;
                        }
                    }
                    byId.put(id, item);
                }
            }
            super.append(item);
        }
    }

    /**
     * Cache indexed by symbol then by side (for bids/asks).
     */
    public static class ArrayCacheBySymbolBySide extends ArrayCache {

        public ArrayCacheBySymbolBySide(int maxSize) { super(maxSize); }
        public ArrayCacheBySymbolBySide() { super(); }
    }
}
