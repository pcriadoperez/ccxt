import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import type { ShardAssignment, ShardToParentMessage } from './messages.js';

const SHARD_WORKER_PATH = fileURLToPath(new URL('./shardWorker.js', import.meta.url));

// Greedy load-balance by symbol count (a rough proxy for message-rate load, since we don't have
// per-symbol throughput data at startup) — sort exchanges by symbol count descending, always hand
// the next one to whichever shard currently has the smallest total. Not optimal, but avoids the
// worst case of round-robin dumping every high-symbol-count exchange on the same shard index.
export function partitionAssignments (assignments: ShardAssignment[], shardCount: number): ShardAssignment[][] {
    const groups: ShardAssignment[][] = Array.from({ length: shardCount }, () => []);
    const groupLoad = new Array(shardCount).fill(0);
    const sorted = [...assignments].sort((a, b) => b.symbols.length - a.symbols.length);
    for (const assignment of sorted) {
        let minIdx = 0;
        for (let i = 1; i < shardCount; i++) {
            if (groupLoad[i]! < groupLoad[minIdx]!) minIdx = i;
        }
        groups[minIdx]!.push(assignment);
        groupLoad[minIdx]! += assignment.symbols.length;
    }
    return groups;
}

// Forks one child process per shard group, each running its own set of ExchangeConnectors, and
// relays their book/health/fee messages into the parent's cache/feeRegistry. The parent's API
// server reads from that same cache — still a synchronous in-process Map read on every request;
// only the write path (a shard's connector -> parent cache) crosses a process boundary, and only
// asynchronously.
export function startShards (
    groups: ShardAssignment[][],
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    logger: Logger,
): ChildProcess[] {
    const children: ChildProcess[] = [];
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
                const delay = Math.min(30_000, 1000 * 2 ** restarts);
                restarts += 1;
                shardLogger.error({ code, pid: proc.pid, restarts, delayMs: delay },
                    'shard process exited unexpectedly, respawning');
                setTimeout(() => {
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
    return children;
}
