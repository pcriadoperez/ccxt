package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link OrderBook} keyed by unified symbol.
 * Mirrors TypeScript {@code OrderBooks extends Dictionary<OrderBook>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class OrderBooks extends AbstractMap<String, OrderBook> {

    private final LinkedHashMap<String, OrderBook> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public OrderBooks(Object raw) {
        LinkedHashMap<String, OrderBook> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new OrderBook(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static OrderBooks of(Map<String, ?> raw) { return new OrderBooks((Object) raw); }

    @Override public Set<Map.Entry<String, OrderBook>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public OrderBook get(Object key) { return entries.get(key); }
    public OrderBook get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public OrderBook getOrThrow(String symbol) {
        OrderBook ob = entries.get(symbol);
        if (ob == null) throw new NoSuchElementException("order book not found: " + symbol);
        return ob;
    }
}
