package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link TradingFeeInterface} keyed by unified symbol.
 * Mirrors TypeScript {@code TradingFees extends Dictionary<TradingFeeInterface>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class TradingFees extends AbstractMap<String, TradingFeeInterface> {

    private final LinkedHashMap<String, TradingFeeInterface> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public TradingFees(Object raw) {
        LinkedHashMap<String, TradingFeeInterface> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new TradingFeeInterface(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static TradingFees of(Map<String, ?> raw) { return new TradingFees((Object) raw); }

    @Override public Set<Map.Entry<String, TradingFeeInterface>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public TradingFeeInterface get(Object key) { return entries.get(key); }
    public TradingFeeInterface get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public TradingFeeInterface getOrThrow(String symbol) {
        TradingFeeInterface f = entries.get(symbol);
        if (f == null) throw new NoSuchElementException("trading fee not found: " + symbol);
        return f;
    }
}
