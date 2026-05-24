package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link CrossBorrowRate} keyed by currency code.
 * Mirrors TypeScript {@code CrossBorrowRates extends Dictionary<CrossBorrowRate>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class CrossBorrowRates extends AbstractMap<String, CrossBorrowRate> {

    private final LinkedHashMap<String, CrossBorrowRate> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public CrossBorrowRates(Object raw) {
        LinkedHashMap<String, CrossBorrowRate> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new CrossBorrowRate(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static CrossBorrowRates of(Map<String, ?> raw) { return new CrossBorrowRates((Object) raw); }

    @Override public Set<Map.Entry<String, CrossBorrowRate>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public CrossBorrowRate get(Object key) { return entries.get(key); }
    public CrossBorrowRate get(String code) { return entries.get(code); }
    public boolean containsKey(String code) { return entries.containsKey(code); }
    public CrossBorrowRate getOrThrow(String code) {
        CrossBorrowRate r = entries.get(code);
        if (r == null) throw new NoSuchElementException("cross borrow rate not found: " + code);
        return r;
    }
}
