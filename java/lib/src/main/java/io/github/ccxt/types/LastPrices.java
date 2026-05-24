package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link LastPrice} keyed by unified symbol.
 * Mirrors TypeScript {@code LastPrices extends Dictionary<LastPrice>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class LastPrices extends AbstractMap<String, LastPrice> {

    private final LinkedHashMap<String, LastPrice> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public LastPrices(Object raw) {
        LinkedHashMap<String, LastPrice> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new LastPrice(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static LastPrices of(Map<String, ?> raw) { return new LastPrices((Object) raw); }

    @Override public Set<Map.Entry<String, LastPrice>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public LastPrice get(Object key) { return entries.get(key); }
    public LastPrice get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public LastPrice getOrThrow(String symbol) {
        LastPrice p = entries.get(symbol);
        if (p == null) throw new NoSuchElementException("last price not found: " + symbol);
        return p;
    }
}
