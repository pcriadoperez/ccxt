package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link IsolatedBorrowRate} keyed by unified symbol.
 * Mirrors TypeScript {@code IsolatedBorrowRates extends Dictionary<IsolatedBorrowRate>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class IsolatedBorrowRates extends AbstractMap<String, IsolatedBorrowRate> {

    private final LinkedHashMap<String, IsolatedBorrowRate> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public IsolatedBorrowRates(Object raw) {
        LinkedHashMap<String, IsolatedBorrowRate> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new IsolatedBorrowRate(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static IsolatedBorrowRates of(Map<String, ?> raw) { return new IsolatedBorrowRates((Object) raw); }

    @Override public Set<Map.Entry<String, IsolatedBorrowRate>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public IsolatedBorrowRate get(Object key) { return entries.get(key); }
    public IsolatedBorrowRate get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public IsolatedBorrowRate getOrThrow(String symbol) {
        IsolatedBorrowRate r = entries.get(symbol);
        if (r == null) throw new NoSuchElementException("isolated borrow rate not found: " + symbol);
        return r;
    }
}
