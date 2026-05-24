package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link MarginMode} keyed by unified symbol.
 * Mirrors TypeScript {@code MarginModes extends Dictionary<MarginMode>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class MarginModes extends AbstractMap<String, MarginMode> {

    private final LinkedHashMap<String, MarginMode> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public MarginModes(Object raw) {
        LinkedHashMap<String, MarginMode> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new MarginMode(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static MarginModes of(Map<String, ?> raw) { return new MarginModes((Object) raw); }

    @Override public Set<Map.Entry<String, MarginMode>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public MarginMode get(Object key) { return entries.get(key); }
    public MarginMode get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public MarginMode getOrThrow(String symbol) {
        MarginMode mode = entries.get(symbol);
        if (mode == null) throw new NoSuchElementException("margin mode not found: " + symbol);
        return mode;
    }
}
