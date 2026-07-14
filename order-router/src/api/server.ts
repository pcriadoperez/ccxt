import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { Logger } from 'pino';
import { config } from '../config.js';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { ExchangeConnector } from '../connectors/exchangeConnector.js';
import { computeBestPrice } from '../routing/bestPrice.js';

interface BestPriceQuery {
    side?: string;
    amount?: string;
}

export async function buildServer (cache: OrderBookCache, connectors: Map<string, ExchangeConnector>, logger: Logger) {
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
            return computeBestPrice(cache, connectors, symbol, side, amount, config.staleBookMs);
        },
    );

    app.get<{ Params: { symbol: string }; Querystring: BestPriceQuery }>(
        '/stream/best/:symbol',
        { websocket: true },
        (socket, request) => {
            const symbol = decodeURIComponent(request.params.symbol);
            const side = request.query.side === 'sell' ? 'sell' : 'buy';
            const amount = Number(request.query.amount ?? '0.01');
            const interval = setInterval(() => {
                const result = computeBestPrice(cache, connectors, symbol, side, amount, config.staleBookMs);
                socket.send(JSON.stringify(result));
            }, 250);
            socket.on('close', () => clearInterval(interval));
        },
    );

    return app;
}
