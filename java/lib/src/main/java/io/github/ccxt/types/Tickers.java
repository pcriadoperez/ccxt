package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link Ticker} keyed by unified symbol. Mirrors the
 * TypeScript {@code Tickers extends Dictionary<Ticker>} interface — a pure
 * map, no sibling fields. Iteration order follows the exchange response
 * (insertion order).
 *
 * <p>Immutable: mutation methods ({@code put}, {@code remove}, {@code clear})
 * throw {@link UnsupportedOperationException}. Use {@link #get(String)} for
 * idiomatic {@code null}-on-miss; use {@link #getOrThrow(String)} for fail-fast.
 */
public final class Tickers extends AbstractMap<String, Ticker> {

    private final LinkedHashMap<String, Ticker> entries;

    /**
     * @apiNote Internal — invoked by generated CCXT wrappers via
     * {@code new Tickers(res)} or {@code Tickers::new}. Direct callers should
     * prefer {@link #of(Map)}.
     */
    @SuppressWarnings("unchecked")
    public Tickers(Object raw) {
        LinkedHashMap<String, Ticker> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new Ticker(e.getValue()));
            }
        }
        this.entries = m;
    }

    /** Type-safe public factory. */
    public static Tickers of(Map<String, ?> raw) { return new Tickers((Object) raw); }

    @Override public Set<Map.Entry<String, Ticker>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }

    @Override public Ticker get(Object key) { return entries.get(key); }

    /** Typed convenience overload — IDE autocomplete prefers this over {@link #get(Object)}. */
    public Ticker get(String symbol) { return entries.get(symbol); }

    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }

    /** Fail-fast variant of {@link #get(String)}. */
    public Ticker getOrThrow(String symbol) {
        Ticker t = entries.get(symbol);
        if (t == null) throw new NoSuchElementException("ticker not found: " + symbol);
        return t;
    }
}
