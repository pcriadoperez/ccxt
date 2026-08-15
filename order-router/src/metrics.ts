import { Registry, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import type { OrderBookCache } from './cache/orderBookCache.js';

// Metrics are DERIVED FROM CACHE STATE AT SCRAPE TIME rather than incremented alongside it.
// The cache already owns the authoritative counters (updateCount, reconnectCount, lastUpdateAt);
// mirroring them into separate Prometheus counters would mean two sources of truth that can drift,
// and a missed increment is invisible. Reading through a collect() callback makes disagreement
// with /exchanges/status structurally impossible.
//
// Consequence: cumulative series are Gauges whose values happen to be monotonic, not Counters.
// That is fine for Prometheus (rate()/increase() work on the value, and a process restart resets
// to 0 exactly as a Counter would) and is the better trade here.

export interface MetricsDeps {
    cache: OrderBookCache;
    staleBookMs: number;
    // Live count of open /stream/best sockets. Injected as a getter because the server owns the
    // connection map and metrics must not hold a reference that could keep sockets alive.
    getWsConnectionCount: () => number;
}

export function buildMetricsRegistry (deps: MetricsDeps): Registry {
    const registry = new Registry();

    // Node/process internals: heap, GC pauses, and — most relevant for this service — event loop
    // lag, which is the first thing to degrade when WS message volume outruns a single thread.
    collectDefaultMetrics({ register: registry, prefix: 'order_router_' });

    new Gauge({
        name: 'order_router_exchange_connected',
        help: 'One if the exchange connector has a live subscription, zero otherwise.',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            for (const h of deps.cache.getHealth()) {
                this.set({ exchange: h.exchangeId }, h.connected ? 1 : 0);
            }
        },
    });

    new Gauge({
        name: 'order_router_exchange_updates_total',
        help: 'Cumulative order book updates received per exchange since process start.',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            for (const h of deps.cache.getHealth()) {
                this.set({ exchange: h.exchangeId }, h.updateCount);
            }
        },
    });

    new Gauge({
        name: 'order_router_exchange_reconnects_total',
        help: 'Cumulative reconnects per exchange since process start.',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            for (const h of deps.cache.getHealth()) {
                this.set({ exchange: h.exchangeId }, h.reconnectCount);
            }
        },
    });

    // The single most important alerting signal. An exchange can hold an open socket while its
    // subscription is silently dead — `connected` stays 1 and nothing errors, but quotes go stale
    // and the router keeps ranking on data that no longer reflects the market. Age since last
    // update catches that; connection state alone does not.
    new Gauge({
        name: 'order_router_exchange_last_update_age_seconds',
        help: 'Seconds since the last book update per exchange. Rises without bound if a subscription dies silently.',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            const now = Date.now();
            for (const h of deps.cache.getHealth()) {
                // Never updated yet: report the process uptime instead of 0, so a connector that
                // never produced a single message is loud rather than indistinguishable from
                // one that just updated.
                const ageMs = h.lastUpdateAt === undefined ? process.uptime() * 1000 : now - h.lastUpdateAt;
                this.set({ exchange: h.exchangeId }, ageMs / 1000);
            }
        },
    });

    new Gauge({
        name: 'order_router_cached_books',
        help: 'Number of (exchange, symbol) order books currently cached.',
        registers: [registry],
        collect () {
            this.set(deps.cache.getBookCount());
        },
    });

    new Gauge({
        name: 'order_router_cached_symbols',
        help: 'Number of distinct symbols currently cached.',
        registers: [registry],
        collect () {
            this.set(deps.cache.listSymbols().length);
        },
    });

    // Books excluded from ranking for being older than staleBookMs. Distinct from the age gauge:
    // this counts how much of the cache is currently unusable for routing, which is what actually
    // degrades answer quality.
    new Gauge({
        name: 'order_router_stale_books',
        help: 'Cached books older than the staleness threshold, and therefore excluded from ranking.',
        registers: [registry],
        collect () {
            this.set(deps.cache.countStaleBooks(deps.staleBookMs));
        },
    });

    new Gauge({
        name: 'order_router_ws_stream_connections',
        help: 'Currently open /stream/best WebSocket connections.',
        registers: [registry],
        collect () {
            this.set(deps.getWsConnectionCount());
        },
    });

    return registry;
}

// Separate from the registry builder so the server can record into it from an onResponse hook.
export function buildHttpHistogram (registry: Registry): Histogram<'method' | 'route' | 'status_code'> {
    return new Histogram({
        name: 'order_router_http_request_duration_seconds',
        help: 'HTTP request duration. The _count series doubles as the request counter.',
        labelNames: ['method', 'route', 'status_code'],
        // Tuned to this service: reads are in-memory map lookups, so the interesting resolution is
        // sub-10ms. Measured p50-p99 across endpoints was 3-18ms under load.
        buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
        registers: [registry],
    });
}
