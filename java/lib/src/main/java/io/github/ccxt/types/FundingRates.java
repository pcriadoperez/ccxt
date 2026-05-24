package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Unified dictionary of {@link FundingRate} keyed by unified symbol.
 * Mirrors TypeScript {@code FundingRates extends Dictionary<FundingRate>}.
 * Insertion-ordered, immutable. See {@link Tickers} for the family contract.
 */
public final class FundingRates extends AbstractMap<String, FundingRate> {

    private final LinkedHashMap<String, FundingRate> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public FundingRates(Object raw) {
        LinkedHashMap<String, FundingRate> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if (!"info".equals(e.getKey())) {
                m.put(e.getKey(), new FundingRate(e.getValue()));
            }
        }
        this.entries = m;
    }

    public static FundingRates of(Map<String, ?> raw) { return new FundingRates((Object) raw); }

    @Override public Set<Map.Entry<String, FundingRate>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public FundingRate get(Object key) { return entries.get(key); }
    public FundingRate get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public FundingRate getOrThrow(String symbol) {
        FundingRate r = entries.get(symbol);
        if (r == null) throw new NoSuchElementException("funding rate not found: " + symbol);
        return r;
    }
}
