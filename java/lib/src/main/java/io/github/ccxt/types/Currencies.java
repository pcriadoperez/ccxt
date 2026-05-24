package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link CurrencyInterface} keyed by currency code.
 * Mirrors TypeScript {@code Currencies extends Dictionary<CurrencyInterface>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class Currencies extends AbstractMap<String, CurrencyInterface> {

    private final LinkedHashMap<String, CurrencyInterface> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public Currencies(Object raw) {
        LinkedHashMap<String, CurrencyInterface> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new CurrencyInterface(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static Currencies of(Map<String, ?> raw) { return new Currencies((Object) raw); }

    @Override public Set<Map.Entry<String, CurrencyInterface>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public CurrencyInterface get(Object key) { return entries.get(key); }
    public CurrencyInterface get(String code) { return entries.get(code); }
    public boolean containsKey(String code) { return entries.containsKey(code); }
    public CurrencyInterface getOrThrow(String code) {
        CurrencyInterface c = entries.get(code);
        if (c == null) throw new NoSuchElementException("currency not found: " + code);
        return c;
    }
}
