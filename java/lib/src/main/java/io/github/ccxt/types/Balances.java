package io.github.ccxt.types;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Objects;
import java.util.Set;

/**
 * Unified account balance snapshot. Per-currency rows in {@link #entries} keyed
 * by currency code; aggregate summary maps {@link #free}/{@link #used}/{@link #total}
 * and metadata fields {@link #info}/{@link #timestamp}/{@link #datetime} mirror the
 * TypeScript {@code Balances} interface.
 *
 * <p>Unlike the symbol-keyed dictionary types (e.g. {@link Tickers}), this is a
 * struct that <em>holds</em> a map rather than being one — necessary because
 * {@code Balances} carries non-dictionary fields and a {@code Map} subtype would
 * lose them under Jackson's {@code MapSerializer}.
 *
 * <p>Immutable: all maps are unmodifiable views over private state.
 */
public final class Balances {

    public final Map<String, Balance> entries;
    public final Map<String, Double>  free;
    public final Map<String, Double>  used;
    public final Map<String, Double>  total;
    public final Long                 timestamp;
    public final String               datetime;
    public final Map<String, Object>  info;

    /** @apiNote Internal — invoked by generated CCXT wrappers. Prefer {@link #of(Map)}. */
    @SuppressWarnings("unchecked")
    public Balances(Object raw) {
        Map<String, Object> data = TypeHelper.toMap(raw);
        this.info      = TypeHelper.getInfo(data);
        this.timestamp = TypeHelper.safeInteger(data, "timestamp");
        this.datetime  = TypeHelper.safeString(data, "datetime");
        this.free      = Collections.unmodifiableMap(parseCurrencyDoubleMap(data, "free"));
        this.used      = Collections.unmodifiableMap(parseCurrencyDoubleMap(data, "used"));
        this.total     = Collections.unmodifiableMap(parseCurrencyDoubleMap(data, "total"));

        LinkedHashMap<String, Balance> rows = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : data.entrySet()) {
            String key = entry.getKey();
            if (isReservedKey(key)) continue;
            if (entry.getValue() instanceof Map) {
                rows.put(key, new Balance(entry.getValue()));
            }
        }
        this.entries = Collections.unmodifiableMap(rows);
    }

    public static Balances of(Map<String, ?> raw) { return new Balances((Object) raw); }

    /** Per-currency Balance row, or {@code null} if the currency isn't in this snapshot. */
    public Balance get(String currency) { return entries.get(currency); }

    /** Fail-fast variant of {@link #get(String)}. */
    public Balance getOrThrow(String currency) {
        Balance b = entries.get(currency);
        if (b == null) throw new NoSuchElementException("balance not found: " + currency);
        return b;
    }

    public boolean containsCurrency(String currency) { return entries.containsKey(currency); }
    public Set<String> currencies() { return entries.keySet(); }
    public int size() { return entries.size(); }
    public boolean isEmpty() { return entries.isEmpty(); }

    @Override public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Balances other)) return false;
        return Objects.equals(entries,   other.entries)
            && Objects.equals(free,      other.free)
            && Objects.equals(used,      other.used)
            && Objects.equals(total,     other.total)
            && Objects.equals(timestamp, other.timestamp)
            && Objects.equals(datetime,  other.datetime)
            && Objects.equals(info,      other.info);
    }
    @Override public int hashCode() {
        return Objects.hash(entries, free, used, total, timestamp, datetime, info);
    }
    @Override public String toString() {
        return "Balances{currencies=" + entries.keySet()
            + ", timestamp=" + timestamp + ", datetime=" + datetime + "}";
    }

    // -- helpers --

    private static boolean isReservedKey(String key) {
        return "info".equals(key) || "free".equals(key) || "used".equals(key)
            || "total".equals(key) || "timestamp".equals(key) || "datetime".equals(key);
    }

    @SuppressWarnings("unchecked")
    private static LinkedHashMap<String, Double> parseCurrencyDoubleMap(Map<String, Object> data, String key) {
        LinkedHashMap<String, Double> out = new LinkedHashMap<>();
        Object raw = TypeHelper.safeValue(data, key);
        if (raw instanceof Map<?, ?> m) {
            for (Map.Entry<String, Object> e : ((Map<String, Object>) m).entrySet()) {
                Double v = (e.getValue() instanceof Number n) ? n.doubleValue() : null;
                out.put(e.getKey(), v);
            }
        }
        return out;
    }
}
