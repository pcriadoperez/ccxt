import { config } from './config.js';
import { logger } from './logger.js';
import { OrderBookCache } from './cache/orderBookCache.js';
import { ExchangeConnector } from './connectors/exchangeConnector.js';
import { buildServer } from './api/server.js';

async function main () {
    const cache = new OrderBookCache();
    const connectors = new Map<string, ExchangeConnector>();

    for (const exchangeId of config.exchanges) {
        const connector = new ExchangeConnector(exchangeId, cache, logger);
        connectors.set(exchangeId, connector);
    }

    await Promise.all(
        Array.from(connectors.values()).map(async (connector) => {
            try {
                await connector.start(config.symbols);
                logger.info({ exchange: connector.exchangeId }, 'connector started');
            } catch (err) {
                logger.error({ exchange: connector.exchangeId, err }, 'connector failed to start');
            }
        }),
    );

    const app = await buildServer(cache, connectors, logger);
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port }, 'order-router listening');

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'shutting down');
        await app.close();
        await Promise.all(Array.from(connectors.values()).map((c) => c.stop()));
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
    logger.error({ err }, 'fatal startup error');
    process.exit(1);
});
