package io.github.ccxt.types;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

/**
 * Locks the design choice that {@link Balances} is a struct, not a {@link Map} subtype:
 * verifies Jackson's default serializer emits all sibling fields ({@code info},
 * {@code timestamp}, {@code datetime}, {@code free}/{@code used}/{@code total},
 * {@code entries}) — which is exactly what {@code MapSerializer} would silently drop
 * if {@code Balances} extended {@link java.util.AbstractMap}.
 */
class BalancesJacksonTest {

    @Test
    void serializeRetainsAllSiblingFields() throws Exception {
        Map<String, Object> raw = new java.util.LinkedHashMap<>();
        raw.put("info", Map.of("rawExchangeKey", "rawExchangeValue"));
        raw.put("timestamp", 1700000000000L);
        raw.put("datetime", "2023-11-14T22:13:20Z");
        raw.put("free",  Map.of("BTC", 1.5, "USDT", 5000.0));
        raw.put("used",  Map.of("BTC", 0.5, "USDT", 1000.0));
        raw.put("total", Map.of("BTC", 2.0, "USDT", 6000.0));
        raw.put("BTC",  Map.of("free", 1.5, "used", 0.5, "total", 2.0));
        raw.put("USDT", Map.of("free", 5000.0, "used", 1000.0, "total", 6000.0));

        Balances b = new Balances(raw);

        String json = new ObjectMapper().writeValueAsString(b);

        // All sibling fields present in output — the bug we're guarding against is
        // MapSerializer silently dropping these when the class implements Map.
        assertTrue(json.contains("\"info\""),       () -> "missing info in " + json);
        assertTrue(json.contains("\"timestamp\""),  () -> "missing timestamp in " + json);
        assertTrue(json.contains("\"datetime\""),   () -> "missing datetime in " + json);
        assertTrue(json.contains("\"free\""),       () -> "missing free in " + json);
        assertTrue(json.contains("\"used\""),       () -> "missing used in " + json);
        assertTrue(json.contains("\"total\""),      () -> "missing total in " + json);
        assertTrue(json.contains("\"entries\""),    () -> "missing entries in " + json);
        assertTrue(json.contains("rawExchangeKey"), () -> "info contents dropped in " + json);
        assertTrue(json.contains("1700000000000"),  () -> "timestamp value dropped in " + json);
    }
}
