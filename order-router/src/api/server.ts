import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { computeBestPrice } from '../routing/bestPrice.js';
import { extractApiKey, isPublicPath, makeAuthHook, resolveApiKey } from './auth.js';

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

    // Rate limit before auth so that unauthenticated brute-force attempts are themselves capped:
    // registering it first puts its onRequest hook ahead of the auth hook in the lifecycle, so a
    // flood of bad keys burns rate-limit budget rather than reaching the comparison unbounded.
    await app.register(rateLimit, {
        max: rateLimitMax,
        timeWindow: rateLimitWindowMs,
        // Bucket by API key so one misbehaving client can't consume another's budget, and so
        // clients behind a shared NAT/egress IP aren't collectively throttled. Falls back to IP
        // when no key is present (only reachable on /health, which is allowlisted below anyway).
        keyGenerator: (request) => extractApiKey(request.headers as Record<string, unknown>) ?? request.ip,
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

    app.addHook('onRequest', makeAuthHook(apiKey));

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
            const amount = Number(request.query.amount ?? '0.01');

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
