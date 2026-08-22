import { config } from '../config.js';
import { createLoopMonitor } from '../loopHealth.js';
import { logger } from '../logger.js';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { ExchangeConnector } from '../connectors/exchangeConnector.js';
import type { ShardInitMessage, ShardToParentMessage } from './messages.js';

const HEALTH_FLUSH_MS = 2000;

function send (message: ShardToParentMessage): void {
    process.send?.(message);
}

async function runShard (assignments: ShardInitMessage['assignments']): Promise<void> {
    const shardLogger = logger.child({ shard: process.pid });
    const cache = new OrderBookCache();
    const feeRegistry = new FeeRegistry();

    // Relay every book write and every fee discovery to the parent immediately — this is the
    // cache's async write path, off the API's synchronous request path, so the IPC hop here
    // doesn't cost the router a request-time round trip the way a Redis read would.
    cache.on('book', (book) => send({ type: 'book', book }));
    cache.on('health', (health) => send({ type: 'health', health }));
    feeRegistry.on('fee', (msg) => send({ type: 'fee', ...msg }));

    // Health counters (updateCount, lastUpdateAt) change on every message too, but flushing those
    // on the same per-message cadence would double IPC traffic for information that's only ever
    // read from a monitoring endpoint — a slow timer is enough for that.
    setInterval(() => {
        for (const health of cache.getHealth()) {
            send({ type: 'health', health });
        }
    }, HEALTH_FLUSH_MS);

    // The shards do all the WebSocket work, so the parent's own loop health says nothing about
    // whether the system is keeping up. Without this, saturation is invisible: a starved shard
    // holds its sockets open and logs nothing while its books quietly rot.
    const loopMonitor = createLoopMonitor();
    setInterval(() => {
        const h = loopMonitor.sample();
        send({ type: 'loop', shardPid: process.pid, ...h });
    }, HEALTH_FLUSH_MS);

    const connectors = assignments.map(
        ({ exchangeId }) => new ExchangeConnector(
            exchangeId,
            cache,
            feeRegistry,
            shardLogger,
            undefined,
            config.maxSymbolsPerSubscription,
            config.maxSymbolsPerExchangeOverrides.get(exchangeId),
        ),
    );

    await Promise.all(
        assignments.map(async ({ exchangeId, symbols }, i) => {
            try {
                await connectors[i]!.start(symbols);
                shardLogger.info({ exchange: exchangeId, symbolCount: symbols.length }, 'shard connector started');
            } catch (err) {
                shardLogger.error({ exchange: exchangeId, err }, 'shard connector failed to start');
            }
        }),
    );

    process.on('disconnect', () => process.exit(0));
}

process.on('message', (message: ShardInitMessage) => {
    if (message.type === 'init') {
        void runShard(message.assignments);
    }
});
