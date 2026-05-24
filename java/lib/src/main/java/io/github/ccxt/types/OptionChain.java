package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link Option} keyed by option symbol.
 * Mirrors TypeScript {@code OptionChain extends Dictionary<Option>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class OptionChain extends AbstractMap<String, Option> {

    private final LinkedHashMap<String, Option> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public OptionChain(Object raw) {
        LinkedHashMap<String, Option> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new Option(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static OptionChain of(Map<String, ?> raw) { return new OptionChain((Object) raw); }

    @Override public Set<Map.Entry<String, Option>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public Option get(Object key) { return entries.get(key); }
    public Option get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public Option getOrThrow(String symbol) {
        Option o = entries.get(symbol);
        if (o == null) throw new NoSuchElementException("option not found: " + symbol);
        return o;
    }
}
