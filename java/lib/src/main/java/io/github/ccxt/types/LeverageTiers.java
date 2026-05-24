package io.github.ccxt.types;

import java.util.AbstractMap;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Unified dictionary mapping a symbol to its list of {@link LeverageTier}s.
 * Mirrors TypeScript {@code LeverageTiers extends Dictionary<LeverageTier[]>}.
 * Insertion-ordered, immutable (the inner lists are also unmodifiable).
 * See {@link Tickers} for the family contract.
 */
public final class LeverageTiers extends AbstractMap<String, List<LeverageTier>> {

    private final LinkedHashMap<String, List<LeverageTier>> entries;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public LeverageTiers(Object raw) {
        LinkedHashMap<String, List<LeverageTier>> m = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : TypeHelper.toMap(raw).entrySet()) {
            if ("info".equals(e.getKey())) continue;
            if (e.getValue() instanceof List<?> list) {
                m.put(e.getKey(), ((List<Object>) list).stream()
                        .map(LeverageTier::new)
                        .collect(Collectors.toUnmodifiableList()));
            }
        }
        this.entries = m;
    }

    public static LeverageTiers of(Map<String, ?> raw) { return new LeverageTiers((Object) raw); }

    @Override public Set<Map.Entry<String, List<LeverageTier>>> entrySet() {
        return Collections.unmodifiableSet(entries.entrySet());
    }
    @Override public List<LeverageTier> get(Object key) { return entries.get(key); }
    public List<LeverageTier> get(String symbol) { return entries.get(symbol); }
    public boolean containsKey(String symbol) { return entries.containsKey(symbol); }
    public List<LeverageTier> getOrThrow(String symbol) {
        List<LeverageTier> t = entries.get(symbol);
        if (t == null) throw new NoSuchElementException("leverage tiers not found: " + symbol);
        return t;
    }
}
