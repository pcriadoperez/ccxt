import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { computeBestPrice } from '../routing/bestPrice.js';

interface BestPriceQuery {
    side?: string;
    amount?: string;
}

export async function buildServer (cache: OrderBookCache, feeRegistry: FeeRegistry, logger: Logger) {
    const app = Fastify({ loggerInstance: logger });
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
