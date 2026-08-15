import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyPlugin from 'fastify-plugin';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { computeBestPrice } from '../routing/bestPrice.js';
import { extractApiKey, isPublicPath, makeAuthHook, resolveApiKey, safeCompare } from './auth.js';
import { buildHttpHistogram, buildMetricsRegistry } from '../metrics.js';

interface BestPriceQuery {
    side?: string;
    amount?: string;
}

export interface ServerOptions {
    // Overrides for the module-level config defaults. Injected rather than read from the global
    // config so tests can exercise the real middleware chain at a low limit without mutating
    // process env (config.ts snapshots env at import time, so env mutation can't reach it).
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
    wsMaxConnectionsPerKey?: number;
    wsIdleTimeoutMs?: number;
    trustProxy?: boolean;
}

export async function buildServer (
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    logger: Logger,
    options: ServerOptions = {},
) {
    // trustProxy makes request.ip read X-Forwarded-For instead of the socket address. Required for
    // the limiter's IP bucketing to mean anything behind nginx; dangerous if enabled without a
    // proxy that overwrites the header (see config.ts). Off by default.
    const app = Fastify({ loggerInstance: logger, trustProxy: options.trustProxy ?? config.trustProxy });

    const rateLimitMax = options.rateLimitMax ?? config.rateLimitMax;
    const rateLimitWindowMs = options.rateLimitWindowMs ?? config.rateLimitWindowMs;
    const wsMaxConnectionsPerKey = options.wsMaxConnectionsPerKey ?? config.wsMaxConnectionsPerKey;
    const wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? config.wsIdleTimeoutMs;
    // Live count of open /stream/best sockets per API key, enforcing wsMaxConnectionsPerKey.
    const wsConnectionsByKey = new Map<string, number>();
    const { apiKey, isDefault } = resolveApiKey();
    if (isDefault) {
        logger.warn(
            'ORDER_ROUTER_API_KEY is not set — falling back to the well-known development key. '
            + 'This grants no security. Set ORDER_ROUTER_API_KEY before exposing this service.',
        );
    }

    // Rate limiting runs ahead of auth (see the preValidation note below for why that ordering is
    // not automatic), so unauthenticated brute-force attempts consume budget rather than probing
    // the key comparison without limit.
    await app.register(rateLimit, {
        max: rateLimitMax,
        timeWindow: rateLimitWindowMs,
        // Bucket by API key ONLY when the key is actually valid, so one legitimate client can't
        // consume another's budget and NAT'd clients aren't collectively throttled. Everything
        // else — wrong key, absent key — buckets by IP.
        //
        // Bucketing unconditionally on the caller-supplied header is the trap: an attacker just
        // rotates the header per request, mints a fresh bucket every time, and brute-forces keys
        // without ever being throttled. It is also an unbounded-memory vector, since each distinct
        // attacker-chosen value would allocate its own counter.
        keyGenerator: (request) => {
            const provided = extractApiKey(request.headers as Record<string, unknown>);
            if (provided !== undefined && safeCompare(provided, apiKey)) {
                return provided;
            }
            return request.ip;
        },
        // Liveness probes must never be throttled — a throttled /health reads as an outage to an
        // orchestrator and would trigger pod restarts under exactly the load where that's worst.
        allowList: (request) => isPublicPath(request.url),
        addHeaders: {
            'x-ratelimit-limit': true,
            'x-ratelimit-remaining': true,
            'x-ratelimit-reset': true,
            'retry-after': true,
        },
    });

    // Auth runs at preValidation, NOT onRequest. @fastify/rate-limit attaches its check as a
    // per-route hook, and route-level onRequest hooks run *after* all instance-level onRequest
    // hooks — so an instance-level auth hook lands ahead of the limiter no matter what order the
    // two are registered in. That silently inverts the intended order: every 401 short-circuits
    // before the limiter counts it, leaving API key brute-force entirely unthrottled while
    // authenticated traffic still appears correctly limited. preValidation runs after the whole
    // onRequest chain, so the limiter fires first and failed auth consumes budget.
    // Verified empirically, and regression-tested in server.test.ts.
    const authHook = makeAuthHook(apiKey);
    await app.register(fastifyPlugin(async (instance) => {
        instance.addHook('preValidation', authHook);
    }, { name: 'order-router-auth' }));

    // preValidation only runs for *matched* routes, so without this an unknown path would 404
    // before auth ever ran — handing an unauthenticated caller a 404-vs-401 oracle for
    // enumerating which routes exist. Re-checking auth here keeps unknown paths indistinguishable
    // from protected ones for anyone without a key, while still giving authenticated callers a
    // truthful 404 for a genuine typo.
    app.setNotFoundHandler(async (request, reply) => {
        const provided = extractApiKey(request.headers as Record<string, unknown>);
        if (!isPublicPath(request.url) && (provided === undefined || !safeCompare(provided, apiKey))) {
            return reply.code(401).send({ error: 'unauthorized' });
        }
        return reply.code(404).send({ error: 'not found' });
    });

    await app.register(websocketPlugin);

    // Total open /stream/best sockets across all keys, for the gauge.
    const countWsConnections = () => {
        let total = 0;
        for (const n of wsConnectionsByKey.values()) total += n;
        return total;
    };
    const metricsRegistry = buildMetricsRegistry({
        cache,
        staleBookMs: config.staleBookMs,
        getWsConnectionCount: countWsConnections,
    });
    const httpDuration = buildHttpHistogram(metricsRegistry);

    app.addHook('onResponse', async (request, reply) => {
        // Label with the ROUTE TEMPLATE, never the raw URL: /orderbook/:exchange/:symbol has tens
        // of thousands of concrete values across the routable universe, and one series per symbol
        // would blow up Prometheus cardinality. Unmatched requests collapse to a single bucket.
        const route = request.routeOptions?.url ?? 'unmatched';
        httpDuration.observe(
            { method: request.method, route, status_code: String(reply.statusCode) },
            reply.elapsedTime / 1000,
        );
    });

    app.get('/health', async () => ({ status: 'ok', uptimeSec: process.uptime() }));

    // Authenticated like every other non-health route: it exposes the venue list, traffic volume
    // and internal health, which is exactly the reconnaissance an attacker wants. Scrapers must
    // send the API key. Not added to PUBLIC_PATHS for that reason.
    app.get('/metrics', async (_request, reply) => {
        reply.header('content-type', metricsRegistry.contentType);
        return metricsRegistry.metrics();
    });

    app.get('/exchanges/status', async () => ({ exchanges: cache.getHealth() }));

    app.get('/symbols', async () => ({ symbols: cache.listSymbols() }));

    app.get<{ Params: { exchange: string; symbol: string } }>(
        '/orderbook/:exchange/:symbol',
        async (request, reply) => {
            const { exchange, symbol } = request.params;
            const decodedSymbol = decodeURIComponent(symbol);
            const book = cache.getBook(exchange, decodedSymbol);
            if (!book) {
                reply.code(404);
                return { error: `no cached order book for ${exchange}:${decodedSymbol}` };
            }
            return book;
        },
    );

    app.get<{ Params: { symbol: string }; Querystring: BestPriceQuery }>(
        '/price/best/:symbol',
        async (request, reply) => {
            const symbol = decodeURIComponent(request.params.symbol);
            const side = request.query.side === 'sell' ? 'sell' : 'buy';
            const amount = Number(request.query.amount ?? '0');
            if (!(amount > 0)) {
                reply.code(400);
                return { error: 'amount query param must be a positive number' };
            }
            return computeBestPrice(cache, feeRegistry, symbol, side, amount, config.staleBookMs);
        },
    );

    app.get<{ Params: { symbol: string }; Querystring: BestPriceQuery }>(
        '/stream/best/:symbol',
        { websocket: true },
        (socket, request) => {
            const symbol = decodeURIComponent(request.params.symbol);
            const side = request.query.side === 'sell' ? 'sell' : 'buy';

            // Validate amount exactly as the REST handler does. Previously this path took
            // Number(...) unchecked, so `amount=abc` produced NaN — which defeats the
            // `remaining <= 0` termination check in walkBook, making it traverse every level of
            // every book and then stream {amount: null, filledAmount: null, averagePrice: null}
            // forever. `amount=-5` and absurd magnitudes were likewise accepted. A streaming
            // endpoint repeating that work on every book update is strictly worse than the
            // one-shot REST equivalent, so it needs at least the same validation.
            const amount = Number(request.query.amount ?? '0.01');
            if (!Number.isFinite(amount) || amount <= 0) {
                socket.send(JSON.stringify({ error: 'amount query param must be a positive finite number' }));
                socket.close(1008, 'invalid amount');
                return;
            }

            // Cap concurrent streams per key. Rate limiting bounds how fast connections open, not
            // how many stay open, and each one costs a cache listener plus recomputation on every
            // book update for its symbol. Counted per key so one client cannot starve another.
            const connectionKey = extractApiKey(request.headers as Record<string, unknown>) ?? 'unknown';
            const openForKey = wsConnectionsByKey.get(connectionKey) ?? 0;
            if (openForKey >= wsMaxConnectionsPerKey) {
                socket.send(JSON.stringify({
                    error: `too many concurrent stream connections (limit ${wsMaxConnectionsPerKey})`,
                }));
                socket.close(1013, 'connection limit reached');
                return;
            }
            wsConnectionsByKey.set(connectionKey, openForKey + 1);

            // Push-on-change rather than polling: with N clients x a fixed
            // poll interval, CPU cost scales with N regardless of whether
            // anything changed, which doesn't hold up at scale. A single
            // pending-flush flag coalesces bursts (a fast-moving symbol can
            // emit hundreds of book updates/sec) into at most one computed
            // result per event-loop tick, still bounded by the connected
            // socket's own backpressure.
            let flushPending = false;
            const flush = () => {
                flushPending = false;
                if (socket.readyState !== socket.OPEN) return;
                const result = computeBestPrice(cache, feeRegistry, symbol, side, amount, config.staleBookMs);
                socket.send(JSON.stringify(result));
            };
            const onUpdate = () => {
                if (flushPending) return;
                flushPending = true;
                setImmediate(flush);
            };

            // Heartbeat reaper. A socket that dies without a close frame (half-open TCP, suspended
            // client) would otherwise hold its listener and its slot against the cap forever, so
            // liveness is asserted actively rather than waiting for a close that may never arrive.
            let alive = true;
            socket.on('pong', () => { alive = true; });
            const heartbeat = setInterval(() => {
                if (!alive) {
                    // terminate(), not close(): an unresponsive peer will not complete a closing
                    // handshake, so a graceful close could hang indefinitely.
                    socket.terminate();
                    return;
                }
                alive = false;
                socket.ping();
            }, wsIdleTimeoutMs);

            cache.on(`update:${symbol}`, onUpdate);
            flush();

            // Idempotent: 'close' can fire after terminate(), and releasing twice would corrupt
            // the per-key count and eventually lock a legitimate client out of its own budget.
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                clearInterval(heartbeat);
                cache.off(`update:${symbol}`, onUpdate);
                const remaining = (wsConnectionsByKey.get(connectionKey) ?? 1) - 1;
                if (remaining > 0) {
                    wsConnectionsByKey.set(connectionKey, remaining);
                } else {
                    // Delete rather than store 0 — connectionKey is client-supplied, so keeping
                    // empty entries would let key rotation grow this map without bound.
                    wsConnectionsByKey.delete(connectionKey);
                }
            };
            socket.on('close', release);
            socket.on('error', release);
        },
    );

    return app;
}
