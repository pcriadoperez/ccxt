package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link Leverage} keyed by unified symbol.
 * Mirrors TypeScript {@code Leverages extends Dictionary<Leverage>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class Leverages extends AbstractMap<String, Leverage> {

    private final LinkedHashMap<String, Leverage> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public Leverages(Object raw) {
        LinkedHashMap<String, Leverage> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new Leverage(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static Leverages of(Map<String, ?> raw) { return new Leverages((Object) raw); }

    @Override public Set<Map.Entry<String, Leverage>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public Leverage get(Object key) { return entries.get(key); }
    public Leverage get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public Leverage getOrThrow(String symbol) {
        Leverage l = entries.get(symbol);
        if (l == null) throw new NoSuchElementException("leverage not found: " + symbol);
        return l;
    }
}
