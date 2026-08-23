import type { ChildProcess } from 'node:child_process';
import type { Exchange } from 'ccxt';
import { config } from './config.js';
import { logger } from './logger.js';
import { OrderBookCache } from './cache/orderBookCache.js';
import { FeeRegistry } from './cache/feeRegistry.js';
import { ExchangeConnector } from './connectors/exchangeConnector.js';
import { buildServer } from './api/server.js';
import { ApiKeyStore } from './api/keyStore.js';
import { listWatchOrderBookExchanges } from './discovery/exchangeDiscovery.js';
import { buildSymbolUniverse } from './discovery/symbolUniverse.js';
import { rankSymbolsByLiquidity } from './discovery/liquidity.js';
import { partitionAssignments, imbalanceRatio, startShards, type ShardHandle } from './sharding/orchestrator.js';
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

        // Trim to the most-traded symbols before any connector starts. Ingest cost is driven by
        // message volume, and the long tail contributes almost no routing value for its cost.
        if (config.topSymbols > 0) {
            const allSymbols = [...new Set(assignments.flatMap((a) => a.symbols))];
            const ranked = await rankSymbolsByLiquidity(allSymbols, config.liquidityReferenceExchanges, logger);
            const keep = new Set(ranked.slice(0, config.topSymbols));
            assignments = assignments
                .map((a) => ({ exchangeId: a.exchangeId, symbols: a.symbols.filter((sym) => keep.has(sym)) }))
                .filter((a) => a.symbols.length > 0);
            logger.info(
                { from: allSymbols.length, to: keep.size, exchanges: assignments.length, top: [...keep].slice(0, 10) },
                'symbol universe trimmed to most-liquid',
            );
        }

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
    let shardHandle: ShardHandle | undefined;

    if (config.shardCount > 1) {
        const groups = partitionAssignments(assignments, config.shardCount);
        shardHandle = startShards(groups, cache, feeRegistry, logger, loopRegistry);

        // One-shot rebalance once real traffic has been observed. Symbol count is only a guess at
        // cost; updateCount is the actual message volume each venue produced. Deliberately not a
        // continuous loop — every rebalance restarts shards and drops their books, so churn would
        // cost more than the imbalance it corrects.
        if (config.rebalanceAfterMs > 0) {
            const baseline = new Map(cache.getHealth().map((h) => [h.exchangeId, h.updateCount]));
            setTimeout(() => {
                const rates = new Map<string, number>();
                for (const h of cache.getHealth()) {
                    rates.set(h.exchangeId, Math.max(1, h.updateCount - (baseline.get(h.exchangeId) ?? 0)));
                }
                const weightOf = (a: ShardAssignment) => rates.get(a.exchangeId) ?? 1;
                const currentLoads = partitionAssignments(assignments, config.shardCount)
                    .map((g) => g.reduce((sum, a) => sum + weightOf(a), 0));
                const ratio = imbalanceRatio(currentLoads);
                if (ratio < config.rebalanceMinImbalance) {
                    logger.info({ ratio }, 'shard load already balanced, skipping rebalance');
                    return;
                }
                const rebalanced = partitionAssignments(assignments, config.shardCount, weightOf);
                logger.warn(
                    {
                        imbalanceRatio: ratio,
                        before: currentLoads,
                        after: rebalanced.map((g) => g.reduce((sum, a) => sum + weightOf(a), 0)),
                    },
                    'rebalancing shards by observed message rate',
                );
                shardHandle?.stop();
                shardHandle = startShards(rebalanced, cache, feeRegistry, logger, loopRegistry);
            }, config.rebalanceAfterMs).unref();
        }
    } else {
        connectors = await startConnectors(assignments, cache, feeRegistry, existingExchanges);
        // Unsharded: this process runs the connectors, so instrument its own loop under the same
        // label scheme the sharded path uses.
        const selfMonitor = createLoopMonitor();
        setInterval(() => loopRegistry.set('main', selfMonitor.sample()), 2000).unref();
    }

    // Built once here and shared with the HTTP server. Shards deliberately do NOT get it: a shard
    // never serves HTTP and never sees a request header, and having the rebalance path restart
    // processes that re-read and re-poll a secrets file is pure downside — more file handles, more
    // surface, and a second place a stale snapshot could hide.
    const keyStore = new ApiKeyStore(config.keysFile, logger, process.env['NODE_ENV'] !== 'production');
    // Deliberately NOT caught: a malformed key file at boot must refuse to start, because running
    // with an unknown key set is worse than not running. A MISSING file is fine and non-fatal —
    // see ApiKeyStore.load() — or deploying the code before creating the file would brick startup.
    keyStore.load();
    keyStore.startPolling(config.keysReloadPollMs);
    // For "right now", when 10 seconds is 10 seconds too long: systemctl reload order-router.
    process.on('SIGHUP', () => {
        if (keyStore.reload()) logger.info({ activeKeys: keyStore.activeCount() }, 'API key file reloaded on SIGHUP');
    });

    const app = await buildServer(cache, feeRegistry, logger, { keyStore }, loopRegistry);
    await app.listen({ port: config.port, host: config.host });
    logger.info({ port: config.port }, 'order-router listening');

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'shutting down');
        keyStore.stop();
        await app.close();
        await Promise.all(connectors.map((c) => c.stop()));
        shardHandle?.stop();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
    logger.error({ err }, 'fatal startup error');
    process.exit(1);
});
