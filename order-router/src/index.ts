import type { ChildProcess } from 'node:child_process';
import type { Exchange } from 'ccxt';
import { config } from './config.js';
import { logger } from './logger.js';
import { OrderBookCache } from './cache/orderBookCache.js';
import { FeeRegistry } from './cache/feeRegistry.js';
import { ExchangeConnector } from './connectors/exchangeConnector.js';
import { buildServer } from './api/server.js';
import { listWatchOrderBookExchanges } from './discovery/exchangeDiscovery.js';
import { buildSymbolUniverse } from './discovery/symbolUniverse.js';
import { partitionAssignments, startShards } from './sharding/orchestrator.js';
import { LoopRegistry } from './cache/loopRegistry.js';
import { createLoopMonitor } from './loopHealth.js';
import type { ShardAssignment } from './sharding/messages.js';

async function startConnectors (
    assignments: ShardAssignment[],
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    existingExchanges: Map<string, Exchange>,
): Promise<ExchangeConnector[]> {
    const connectors = assignments.map(
        ({ exchangeId }) => new ExchangeConnector(
            exchangeId,
            cache,
            feeRegistry,
            logger,
            existingExchanges.get(exchangeId),
            config.maxSymbolsPerSubscription,
            config.maxSymbolsPerExchangeOverrides.get(exchangeId),
        ),
    );
    await Promise.all(
        assignments.map(async ({ exchangeId, symbols }, i) => {
            try {
                await connectors[i]!.start(symbols);
                logger.info({ exchange: exchangeId, symbolCount: symbols.length }, 'connector started');
            } catch (err) {
                logger.error({ exchange: exchangeId, err }, 'connector failed to start');
            }
        }),
    );
    return connectors;
}

async function main () {
    const cache = new OrderBookCache();
    const feeRegistry = new FeeRegistry();
    const loopRegistry = new LoopRegistry();
    const excludeSet = new Set(config.excludeExchanges);

    let assignments: ShardAssignment[];
    let existingExchanges = new Map<string, Exchange>();

    if (config.discoverAllExchanges) {
        const candidateIds = listWatchOrderBookExchanges(excludeSet);
        logger.info({ count: candidateIds.length }, 'discovered ccxt.pro exchanges with watchOrderBook support');

        const universe = await buildSymbolUniverse(
            candidateIds,
            config.minExchangesPerSymbol,
            config.loadMarketsConcurrency,
            logger,
        );

        for (const [exchangeId, message] of universe.exchangesFailed) {
            logger.warn({ exchange: exchangeId, err: message }, 'excluded from discovery: loadMarkets failed');
        }
        logger.info(
            {
                exchangesLoaded: universe.loadedExchanges.size,
                exchangesFailed: universe.exchangesFailed.size,
                totalUniqueSymbols: universe.totalUniqueSymbols,
                routableSymbolCount: universe.routableSymbolCount,
                minExchangesPerSymbol: config.minExchangesPerSymbol,
            },
            'symbol universe built',
        );

        assignments = Array.from(universe.routableSymbolsByExchange.entries()).map(([exchangeId, symbols]) => ({
            exchangeId,
            symbols,
        }));

        if (assignments.length === 0) {
            logger.error('no exchanges have any routable symbols (>= minExchangesPerSymbol) — nothing to do');
        }

        // Discovery instances only exist to compute the symbol universe. In single-process mode
        // we hand the already-loaded exchange off to its connector directly (saves a second
        // loadMarkets round trip); everything else (no routable symbols, or we're sharding and
        // workers build their own instances) gets closed so we don't leak an unused ccxt.pro
        // instance's sockets/handles.
        if (config.shardCount <= 1) {
            existingExchanges = universe.loadedExchanges;
        }
        const keepForReuse = new Set(config.shardCount <= 1 ? assignments.map((a) => a.exchangeId) : []);
        await Promise.all(
            Array.from(universe.loadedExchanges.entries())
                .filter(([exchangeId]) => !keepForReuse.has(exchangeId))
                .map(([, exchange]) => exchange.close()),
        );
    } else {
        // Explicit exchange/symbol list — the conservative default for local dev (see config.ts).
        assignments = config.exchanges
            .filter((id) => !excludeSet.has(id))
            .map((exchangeId) => ({ exchangeId, symbols: config.symbols }));
    }

    let connectors: ExchangeConnector[] = [];
    let shardChildren: ChildProcess[] = [];

    if (config.shardCount > 1) {
        const groups = partitionAssignments(assignments, config.shardCount);
        shardChildren = startShards(groups, cache, feeRegistry, logger, loopRegistry);
    } else {
        connectors = await startConnectors(assignments, cache, feeRegistry, existingExchanges);
        // Unsharded: this process runs the connectors, so instrument its own loop under the same
        // label scheme the sharded path uses.
        const selfMonitor = createLoopMonitor();
        setInterval(() => loopRegistry.set('main', selfMonitor.sample()), 2000).unref();
    }

    const app = await buildServer(cache, feeRegistry, logger, {}, loopRegistry);
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port }, 'order-router listening');

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'shutting down');
        await app.close();
        await Promise.all(connectors.map((c) => c.stop()));
        shardChildren.forEach((c) => c.disconnect());
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
    logger.error({ err }, 'fatal startup error');
    process.exit(1);
});
