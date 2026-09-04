import { config } from '../config.js';
import { createLoopMonitor } from '../loopHealth.js';
import { logger } from '../logger.js';
import { installCrashHandlers } from '../crashHandlers.js';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { ExchangeConnector } from '../connectors/exchangeConnector.js';
import type { ShardInitMessage, ShardToParentMessage } from './messages.js';

installCrashHandlers(logger, 'shard');

const HEALTH_FLUSH_MS = 2000;

// process.send() returns false when the IPC pipe is full. That return value used to be discarded,
// which is how a shard reached 19.8GB: measured, 96.3% of sends were backpressured against an idle
// parent, and libuv queued every one of them in native write buffers. Heap stayed flat at 62MB the
// whole time, which is why a heap ceiling did nothing and why a three-minute measurement after a
// restart looked healthy — the queue had not formed yet.
//
// Book messages are IDEMPOTENT SNAPSHOTS, so the right response to a full pipe is to drop them.
// A dropped book costs nothing: another arrives milliseconds later and supersedes it. A queued one
// costs memory until the process dies. Health, fee and loop messages are rare and are still sent
// unconditionally.
let droppedBooks = 0;
let sentBooks = 0;
let pipeFull = false;

function send (message: ShardToParentMessage): void {
    if (process.send === undefined) return;
    if (message.type === 'book' && pipeFull) {
        droppedBooks += 1;
        return;
    }
    // The callback fires once the message is flushed; until then treat the pipe as full so the
    // next book is dropped rather than enqueued behind this one.
    const accepted = process.send(message, undefined, undefined, () => { pipeFull = false; });
    if (message.type === 'book') {
        sentBooks += 1;
        if (!accepted) pipeFull = true;
    }
}

export function ipcStats (): { sentBooks: number; droppedBooks: number } {
    return { sentBooks, droppedBooks };
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
        const mem = process.memoryUsage();
        send({
            type: 'loop', shardPid: process.pid, ...h,
            rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
            // external is where the IPC queue actually lives; without it the symptom was invisible
            // and the whole problem read as "the box is swapping".
            externalBytes: mem.external,
            sentBooks, droppedBooks,
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
