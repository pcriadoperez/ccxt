import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { LoopRegistry } from '../cache/loopRegistry.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { config } from '../config.js';
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

// Above this many exchanges, a single process is carrying a workload the sharded path only
// survives because every worker is forked with `--max-old-space-size`. That ceiling cannot be
// applied to a process that never forks, so single-process mode at discovery scale (76 exchanges)
// has nothing between it and the 20.54GB high-water mark a shard reached WITH a ceiling. The
// threshold is deliberately generous: the explicit-exchange-list default this mode exists for is
// a handful of venues.
const SINGLE_PROCESS_EXCHANGE_LIMIT = 8;

// Kept pure so the boot-time warning is testable without starting a router.
export function unshardedMemoryRisk (shardCount: number, exchangeCount: number): boolean {
    return shardCount <= 1 && exchangeCount > SINGLE_PROCESS_EXCHANGE_LIMIT;
}

// How many times a shard may exit WITHOUT ever acknowledging its assignments before the parent
// treats it as unstartable rather than unlucky. Five, because the backoff is 1s doubling to a 30s
// cap: five exits is ~31s of evidence, long enough that a slow-but-working start is not caught and
// short enough that a bad deploy is not left crash-looping behind a 200 /health.
export const CRASH_LOOP_RESTART_LIMIT = 5;

// Cumulative unexpected exits per shard, exported for /metrics. Module-level rather than passed
// through, because the metrics registry is built by the HTTP server, which knows nothing about
// sharding — and a shard that crash-loops is otherwise invisible: its replacement keeps reporting,
// so every other series looks healthy while assignments are repeatedly dropped and re-subscribed.
// Keyed the same way loopRegistry is (`shard-<index>`) so the two join in a query.
export const shardRestartCounts = new Map<string, number>();

// A shard that has never acknowledged an init cannot be fixed by retrying: the usual cause is that
// shardWorker.js is not on disk (stale or half-unpacked deploy), and every respawn re-runs the same
// missing file. Left alone, the parent retries forever while /health answers 200 and every exchange
// assigned to that shard is silently offline. A shard that HAS acknowledged is a different animal:
// it demonstrably works, so a crash there is a fault to recover from, not a deploy to roll back.
export function shouldAbortOnCrashLoop (restarts: number, sawReady: boolean): boolean {
    return !sawReady && restarts >= CRASH_LOOP_RESTART_LIMIT;
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
    // Test seam. The real worker opens live exchange websockets on `init`, so the respawn and
    // shutdown bookkeeping below — which is process lifecycle, not routing — can only be exercised
    // against a stub. Production never passes this.
    workerPath: string = SHARD_WORKER_PATH,
    // What to do when a shard proves unstartable. Exiting is right in production — the supervisor
    // restarts us, or the deploy rolls back — but a test must be able to observe the decision
    // without taking the test runner down with it.
    onFatal: (reason: string) => void = () => process.exit(1),
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
                case 'ready':
                    // Reset here too: a shard that came back up has proved the deploy is intact,
                    // so the next crash starts its backoff from the bottom rather than the cap.
                    sawReady = true;
                    restarts = 0;
                    break;
                case 'loop':
                    loopRegistry.set(`shard-${shardIndex}`, {
                        utilization: message.utilization,
                        lagP50Ms: message.lagP50Ms,
                        lagP99Ms: message.lagP99Ms,
                        lagMaxMs: message.lagMaxMs,
                        rssBytes: message.rssBytes,
                        heapUsedBytes: message.heapUsedBytes,
                        externalBytes: message.externalBytes,
                        sentBooks: message.sentBooks,
                        droppedBooks: message.droppedBooks,
                        droppedHealth: message.droppedHealth,
                    });
                    break;
            }
        };

        // A dead shard silently takes every exchange assigned to it offline until the whole
        // service restarts — observed in production as 3 of 4 shards running with no alert.
        // Respawn it, with capped backoff so a shard that crashes on startup cannot become its
        // own busy loop.
        let restarts = 0;
        // Set by the worker's 'ready' message; see shouldAbortOnCrashLoop for why it is the
        // dividing line between a retry and a rollback.
        let sawReady = false;

        const spawn = (): ChildProcess => {
            // A heap ceiling, because V8 without one grows to the startup peak and keeps it. The
            // ceiling is well above the live working set; a shard that genuinely needs more will
            // OOM loudly, which is a far better failure than silently swapping the whole box.
            const proc = fork(workerPath, [], {
                execArgv: [`--max-old-space-size=${config.shardMaxOldSpaceMb}`],
            });
            proc.on('message', onMessage);
            proc.on('error', (err) => shardLogger.error({ err, pid: proc.pid }, 'shard process error'));
            // Registered here rather than at the call site so that EVERY process this function
            // ever creates is in `children`, not just the first one. Previously only the original
            // fork was pushed: after a single crash-and-respawn, `stop()` iterated a list holding
            // a dead pid and never touched the live replacement, so shutdown left orphaned shard
            // processes still holding their exchange websockets open — and the next start found
            // them competing for the same subscriptions.
            children.push(proc);
            proc.on('exit', (code) => {
                // Drop it immediately: a dead pid in the list is a kill() that does nothing while
                // reading as success.
                const index = children.indexOf(proc);
                if (index !== -1) children.splice(index, 1);
                if (shuttingDown) {
                    shardLogger.info({ pid: proc.pid }, 'shard stopped intentionally');
                    return;
                }
                const delay = Math.min(30_000, 1000 * 2 ** restarts);
                restarts += 1;
                const shardKey = `shard-${shardIndex}`;
                shardRestartCounts.set(shardKey, (shardRestartCounts.get(shardKey) ?? 0) + 1);
                if (shouldAbortOnCrashLoop(restarts, sawReady)) {
                    const reason = `shard ${shardIndex} exited ${restarts} times without ever `
                        + 'acknowledging init — its worker module is missing or unloadable; '
                        + 'respawning it again cannot help';
                    shardLogger.fatal({ code, pid: proc.pid, restarts, workerPath }, reason);
                    shuttingDown = true;
                    for (const other of children) other.kill();
                    onFatal(reason);
                    return;
                }
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
