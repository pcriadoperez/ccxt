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
}

export async function buildServer (
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    logger: Logger,
    options: ServerOptions = {},
) {
    const app = Fastify({ loggerInstance: logger });

    const rateLimitMax = options.rateLimitMax ?? config.rateLimitMax;
    const rateLimitWindowMs = options.rateLimitWindowMs ?? config.rateLimitWindowMs;
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

    app.get('/health', async () => ({ status: 'ok', uptimeSec: process.uptime() }));

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

            cache.on(`update:${symbol}`, onUpdate);
            flush();
            socket.on('close', () => cache.off(`update:${symbol}`, onUpdate));
        },
    );

    return app;
}
