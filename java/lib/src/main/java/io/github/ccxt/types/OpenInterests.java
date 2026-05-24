package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link OpenInterest} keyed by unified symbol.
 * Mirrors TypeScript {@code OpenInterests extends Dictionary<OpenInterest>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class OpenInterests extends AbstractMap<String, OpenInterest> {

    private final LinkedHashMap<String, OpenInterest> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public OpenInterests(Object raw) {
        LinkedHashMap<String, OpenInterest> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new OpenInterest(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static OpenInterests of(Map<String, ?> raw) { return new OpenInterests((Object) raw); }

    @Override public Set<Map.Entry<String, OpenInterest>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public OpenInterest get(Object key) { return entries.get(key); }
    public OpenInterest get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public OpenInterest getOrThrow(String symbol) {
        OpenInterest o = entries.get(symbol);
        if (o == null) throw new NoSuchElementException("open interest not found: " + symbol);
        return o;
    }
}
