import { config } from '../config.js';
import { createLoopMonitor } from '../loopHealth.js';
import { logger } from '../logger.js';
import { installCrashHandlers } from '../crashHandlers.js';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { ExchangeConnector } from '../connectors/exchangeConnector.js';
import type { ShardInitMessage } from './messages.js';
import { createIpcSender, type IpcStats } from './ipcSend.js';

installCrashHandlers(logger, 'shard');

const HEALTH_FLUSH_MS = 2000;

// Backpressure and the drop rules for idempotent snapshots live in ipcSend.ts, where they can be
// tested without forking a process. See that file for why a full pipe is answered with a drop.
const ipc = createIpcSender(
    process.send === undefined ? undefined : process.send.bind(process) as never,
);

export function ipcStats (): IpcStats {
    return ipc.stats();
}

const send = ipc.send;

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
        const mem = process.memoryUsage();
        send({
            type: 'loop', shardPid: process.pid, ...h,
            rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
            // external is where the IPC queue actually lives; without it the symptom was invisible
            // and the whole problem read as "the box is swapping".
            externalBytes: mem.external,
            ...ipc.stats(),
        });
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
            config.maxBookDepth,
        ),
    );

    // Bounded concurrency, NOT Promise.all. Starting every exchange at once means N simultaneous
    // loadMarkets() calls plus N first order-book snapshots, and that peak is what V8 grows the heap
    // to hold and then never gives back — one shard measured 20.54GB RSS, flat, against siblings at
    // 0.44-1.07GB. Serialising entirely would make startup unnecessarily slow, so this admits a few
    // at a time: the peak scales with the limit rather than with the shard's exchange count.
    const queue = assignments.map((a, i) => ({ ...a, connector: connectors[i]! }));
    const limit = Math.max(1, config.shardStartConcurrency);
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (;;) {
            const next = queue.shift();
            if (next === undefined) return;
            try {
                await next.connector.start(next.symbols);
                shardLogger.info(
                    { exchange: next.exchangeId, symbolCount: next.symbols.length, remaining: queue.length },
                    'shard connector started',
                );
            } catch (err) {
                shardLogger.error({ exchange: next.exchangeId, err }, 'shard connector failed to start');
            }
        }
    }));

    process.on('disconnect', () => process.exit(0));
}

process.on('message', (message: ShardInitMessage) => {
    if (message.type === 'init') {
        void runShard(message.assignments);
    }
});
