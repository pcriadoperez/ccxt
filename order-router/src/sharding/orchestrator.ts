import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { LoopRegistry } from '../cache/loopRegistry.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { ShardAssignment, ShardToParentMessage } from './messages.js';

const SHARD_WORKER_PATH = fileURLToPath(new URL('./shardWorker.js', import.meta.url));

// Greedy load-balance by symbol count (a rough proxy for message-rate load, since we don't have
// per-symbol throughput data at startup) — sort exchanges by symbol count descending, always hand
// the next one to whichever shard currently has the smallest total. Not optimal, but avoids the
// worst case of round-robin dumping every high-symbol-count exchange on the same shard index.
export function partitionAssignments (
    assignments: ShardAssignment[],
    shardCount: number,
    // Cost per exchange. Defaults to symbol count, which is only a stand-in until real message
    // rates are observed: a venue streaming 3,000-level books costs far more per symbol than one
    // streaming 20, so symbol count systematically under-weights the expensive venues.
    weightOf: (a: ShardAssignment) => number = (a) => a.symbols.length,
): ShardAssignment[][] {
    const groups: ShardAssignment[][] = Array.from({ length: shardCount }, () => []);
    const groupLoad = new Array(shardCount).fill(0);
    // Longest-processing-time-first: place the heaviest item on the emptiest shard. Simple, and
    // within 4/3 of optimal for this class of problem.
    const sorted = [...assignments].sort((a, b) => weightOf(b) - weightOf(a));
    for (const assignment of sorted) {
        let minIdx = 0;
        for (let i = 1; i < shardCount; i++) {
            if (groupLoad[i]! < groupLoad[minIdx]!) minIdx = i;
        }
        groups[minIdx]!.push(assignment);
        groupLoad[minIdx]! += weightOf(assignment);
    }
    return groups;
}

// Ratio between the busiest and quietest shard. 1.0 is perfectly balanced; the measured 0.90 vs
// 0.10 utilisation split was roughly 9.
export function imbalanceRatio (loads: number[]): number {
    const active = loads.filter((l) => l > 0);
    if (active.length < 2) return 1;
    return Math.max(...active) / Math.min(...active);
}

// Forks one child process per shard group, each running its own set of ExchangeConnectors, and
// relays their book/health/fee messages into the parent's cache/feeRegistry. The parent's API
// server reads from that same cache — still a synchronous in-process Map read on every request;
// only the write path (a shard's connector -> parent cache) crosses a process boundary, and only
// asynchronously.
export interface ShardHandle {
    children: ChildProcess[];
    // Intentional shutdown MUST suppress the auto-respawn, or a deliberate stop (a rebalance, or
    // process exit) resurrects shards with stale assignments alongside their replacements.
    stop: () => void;
}

export function startShards (
    groups: ShardAssignment[][],
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    logger: Logger,
    loopRegistry: LoopRegistry,
): ShardHandle {
    const children: ChildProcess[] = [];
    let shuttingDown = false;
    groups.forEach((assignments, shardIndex) => {
        if (assignments.length === 0) return;

        const shardLogger = logger.child({ shard: shardIndex });

        const onMessage = (message: ShardToParentMessage) => {
            switch (message.type) {
                case 'book':
                    cache.setBook(message.book);
                    break;
                case 'health':
                    cache.setHealth(message.health);
                    break;
                case 'fee':
                    feeRegistry.setFee(message.exchangeId, message.symbol, message.takerFeeRate);
                    break;
                case 'loop':
                    loopRegistry.set(`shard-${shardIndex}`, {
                        utilization: message.utilization,
                        lagP50Ms: message.lagP50Ms,
                        lagP99Ms: message.lagP99Ms,
                        lagMaxMs: message.lagMaxMs,
                    });
                    break;
            }
        };

        // A dead shard silently takes every exchange assigned to it offline until the whole
        // service restarts — observed in production as 3 of 4 shards running with no alert.
        // Respawn it, with capped backoff so a shard that crashes on startup cannot become its
        // own busy loop.
        let restarts = 0;

        const spawn = (): ChildProcess => {
            const proc = fork(SHARD_WORKER_PATH);
            proc.on('message', onMessage);
            proc.on('error', (err) => shardLogger.error({ err, pid: proc.pid }, 'shard process error'));
            proc.on('exit', (code) => {
                if (shuttingDown) {
                    shardLogger.info({ pid: proc.pid }, 'shard stopped intentionally');
                    return;
                }
                const delay = Math.min(30_000, 1000 * 2 ** restarts);
                restarts += 1;
                shardLogger.error({ code, pid: proc.pid, restarts, delayMs: delay },
                    'shard process exited unexpectedly, respawning');
                setTimeout(() => {
                    if (shuttingDown) return;
                    const replacement = spawn();
                    replacement.send({ type: 'init', assignments });
                }, delay);
            });
            return proc;
        };

        const child = spawn();
        children.push(child);
        child.send({ type: 'init', assignments });
        shardLogger.info(
            { pid: child.pid, exchanges: assignments.map((a) => a.exchangeId), exchangeCount: assignments.length },
            'shard started',
        );
    });
    return {
        children,
        stop () {
            shuttingDown = true;
            for (const child of children) child.kill();
        },
    };
}
