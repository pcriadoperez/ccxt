import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import type { OrderBookCache } from './cache/orderBookCache.js';
import type { LoopRegistry } from './cache/loopRegistry.js';

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
    loopRegistry: LoopRegistry;
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

    // Non-zero means a venue served a book whose best bid was above its best ask, which a real
    // matching engine cannot produce — so this is an alarm on corrupt local state, not a market
    // statistic. It should sit at zero; a venue climbing here is one whose ccxt.pro handler is
    // losing deletes.
    new Gauge({
        name: 'order_router_exchange_crossed_books_total',
        help: 'Cumulative crossed (corrupt) order books rejected per exchange since process start.',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            for (const h of deps.cache.getHealth()) {
                this.set({ exchange: h.exchangeId }, h.crossedCount);
            }
        },
    });

    new Gauge({
        name: 'order_router_exchange_last_resync_seconds',
        help: 'Seconds since this exchange last rebuilt its books from a fresh snapshot (-1 if never).',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            const now = Date.now();
            for (const h of deps.cache.getHealth()) {
                const age = h.lastResyncAt === undefined ? -1 : (now - h.lastResyncAt) / 1000;
                this.set({ exchange: h.exchangeId }, age);
            }
        },
    });

    // Abandonment is the one failure mode with no self-correction: the watch loop returned, so
    // nothing will ever retry it. Everything else here recovers on its own and the metric is a
    // rate; this one is a latch, and any non-zero value is a venue that has silently lost part of
    // its coverage until the process restarts. Alert on > 0, not on a rate of change.
    new Gauge({
        name: 'order_router_exchange_abandoned_symbols',
        help: 'Symbols whose watch loop hit a permanent failure and will never be retried in this process.',
        labelNames: ['exchange'],
        registers: [registry],
        collect () {
            for (const h of deps.cache.getHealth()) {
                this.set({ exchange: h.exchangeId }, h.abandonedSymbols.length);
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

    // Event loop utilisation per shard: the fraction of wall-clock each loop spent ACTIVE rather
    // than idle. This is the saturation signal that CPU%, load average and stale_books all fail to
    // give cleanly — starvation here is otherwise SILENT, since a starved shard keeps its sockets
    // open, logs nothing, and simply stops delivering updates.
    new Gauge({
        name: 'order_router_shard_event_loop_utilization',
        help: 'Event loop utilisation per shard, 0..1. Sustained >0.9 means no headroom and books will go stale.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) this.set({ shard }, h.utilization);
        },
    });

    // Shard memory was completely invisible: the only symptom of a shard holding 20.54GB was the
    // whole box swapping, which reads as an infrastructure problem rather than as this service. A
    // per-shard gauge makes the imbalance (20.54GB against siblings at 0.44-1.07GB) obvious.
    new Gauge({
        name: 'order_router_shard_rss_bytes',
        help: 'Resident set size per shard process. A large spread across shards means one is holding memory the others are not.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) {
                if (h.rssBytes !== undefined) this.set({ shard }, h.rssBytes);
            }
        },
    });

    new Gauge({
        name: 'order_router_shard_heap_used_bytes',
        help: 'V8 heap in use per shard process. Compare against rss to tell live data from a high-water mark V8 has not returned.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) {
                if (h.heapUsedBytes !== undefined) this.set({ shard }, h.heapUsedBytes);
            }
        },
    });

    // External memory is where a backpressured IPC queue accumulates. Reporting only rss and
    // heapUsed is precisely why 19.8GB of it went unattributed: the heap looked healthy at 62MB
    // throughout, so every heap-based diagnosis came back clean.
    new Gauge({
        name: 'order_router_shard_external_bytes',
        help: 'Native memory outside the V8 heap per shard. A large gap between this and heap_used means queued IPC, not leaked objects.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) {
                if (h.externalBytes !== undefined) this.set({ shard }, h.externalBytes);
            }
        },
    });

    // The leading indicator. A climbing drop count means the shard is producing book updates faster
    // than the parent can drain them — which is a capacity signal, and far better than the previous
    // behaviour of queueing them until the box swapped.
    new Gauge({
        name: 'order_router_shard_books_dropped_total',
        help: 'Book updates dropped because the IPC pipe was full. Rising means the shard out-produces the parent.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) {
                if (h.droppedBooks !== undefined) this.set({ shard }, h.droppedBooks);
            }
        },
    });

    // Health snapshots drop for a different reason than books do: a flapping venue emits one per
    // error, so this rising while books are steady points at an exchange, not at capacity.
    new Gauge({
        name: 'order_router_shard_health_dropped_total',
        help: 'Health snapshots dropped because the IPC pipe was full. Rising means a venue is flapping.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) {
                if (h.droppedHealth !== undefined) this.set({ shard }, h.droppedHealth);
            }
        },
    });

    new Gauge({
        name: 'order_router_shard_event_loop_lag_p99_ms',
        help: 'p99 event loop delay per shard, milliseconds.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            for (const [shard, h] of deps.loopRegistry.entries()) this.set({ shard }, h.lagP99Ms);
        },
    });

    new Gauge({
        name: 'order_router_shard_loop_report_age_seconds',
        help: 'Seconds since a shard last reported loop health. Rising without bound means the shard is gone or wedged.',
        labelNames: ['shard'],
        registers: [registry],
        collect () {
            const now = Date.now();
            for (const [shard, h] of deps.loopRegistry.entries()) this.set({ shard }, (now - h.updatedAt) / 1000);
        },
    });

    return registry;
}

// The one outcome that is invisible in every other signal. An unroutable answer is a 200 with a
// well-formed body, so it does not touch the error rate, the status-code labels, or the latency
// histogram — a shard whose books have all gone stale keeps serving 200s at normal latency while
// answering "cannot route this" to every caller. The status quo of only LOGGING the reason means
// noticing that requires someone to be reading logs.
//
// Deliberately a real Counter and not a collect()-derived Gauge like everything above it: there is
// no cache field holding this, it is a property of responses rather than of state, so there is no
// second source of truth to drift from.
export function buildUnroutableCounter (registry: Registry): Counter<'reason'> {
    return new Counter({
        name: 'order_router_unroutable_total',
        help: 'Route requests answered with no executable route, by reason. Alert on the ratio to http _count, not the raw rate.',
        labelNames: ['reason'],
        registers: [registry],
    });
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
