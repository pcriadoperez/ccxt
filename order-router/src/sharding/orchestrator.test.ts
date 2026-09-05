import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionAssignments, unshardedMemoryRisk, shouldAbortOnCrashLoop, CRASH_LOOP_RESTART_LIMIT, shardRestartCounts } from './orchestrator.js';
import type { ShardAssignment } from './messages.js';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function assignment (exchangeId: string, symbolCount: number): ShardAssignment {
    return { exchangeId, symbols: Array.from({ length: symbolCount }, (_, i) => `SYM${i}/USDT`) };
}

test('every assignment appears in exactly one group, none dropped or duplicated', () => {
    const assignments = [assignment('a', 100), assignment('b', 50), assignment('c', 10), assignment('d', 200)];
    const groups = partitionAssignments(assignments, 2);

    const allExchangeIds = groups.flat().map((a) => a.exchangeId).sort();
    assert.deepEqual(allExchangeIds, ['a', 'b', 'c', 'd']);
});

test('returns exactly shardCount groups, even if some end up empty', () => {
    const assignments = [assignment('a', 10)];
    const groups = partitionAssignments(assignments, 3);
    assert.equal(groups.length, 3);
});

test('greedily balances total symbol count across shards', () => {
    // 100 + 50 + 10 should not all land on one shard when there are 2 shards available;
    // the largest (100) and next-largest pair should end up balanced rather than lopsided.
    const assignments = [assignment('big', 100), assignment('medium', 50), assignment('small', 10)];
    const groups = partitionAssignments(assignments, 2);

    const totals = groups.map((g) => g.reduce((sum, a) => sum + a.symbols.length, 0));
    // Greedy load balance: big(100) -> shard0, medium(50) -> shard1, small(10) -> shard1 (60) since
    // shard1 (0) < shard0 (100) at that point, then small goes to whichever is smaller.
    assert.equal(totals.reduce((a, b) => a + b, 0), 160);
    // The imbalance should be much smaller than dumping everything on one shard (160 vs 0).
    assert.ok(Math.max(...totals) - Math.min(...totals) <= 100);
});

test('single shard puts everything in one group', () => {
    const assignments = [assignment('a', 10), assignment('b', 20)];
    const groups = partitionAssignments(assignments, 1);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.length, 2);
});

test('shard workers are forked with a heap ceiling', async () => {
    // Without one, V8 grows to the startup peak and never returns it: a shard measured 20.54GB RSS
    // — flat, so a high-water mark rather than a leak — against siblings at 0.44-1.07GB, while the
    // whole service cached 543 order books. The ceiling is what makes V8 collect instead of grow.
    const { config } = await import('../config.js');
    assert.ok(config.shardMaxOldSpaceMb > 0, 'a heap ceiling must be configured');
    assert.ok(config.shardStartConcurrency >= 1, 'startup concurrency must admit at least one');
    // The peak scales with startup concurrency, so the default must actually bound it.
    assert.ok(config.shardStartConcurrency < 8,
        'starting many exchanges at once rebuilds the peak the ceiling has to hold');
});

test('a respawned shard is tracked, so stop() can actually kill it', async () => {
    // The original fork was pushed into `children`; the replacement created by the exit handler
    // was not. After one crash-and-respawn, stop() iterated a list holding only a dead pid: it
    // reported success while the live replacement kept running, still holding its exchange
    // websockets open, to compete with the next start for the same subscriptions.
    const { startShards } = await import('./orchestrator.js');
    const stubPath = fileURLToPath(new URL('./__fixtures__/exitingWorker.mjs', import.meta.url));
    const marker = join(mkdtempSync(join(tmpdir(), 'shard-stub-')), 'crashed');
    process.env['ORCHESTRATOR_STUB_MARKER'] = marker;

    const cache = { setBook () {}, setHealth () {} } as never;
    const fees = { setFee () {} } as never;
    const loops = { set () {} } as never;
    const quiet = { child: () => quiet, info () {}, error () {}, warn () {}, debug () {} } as never;

    const handle = startShards([[assignment('a', 1)]], cache, fees, quiet, loops, stubPath);
    try {
        const first = handle.children[0];
        assert.ok(first, 'the original fork is registered');
        const firstPid = first.pid;

        // The stub crashes once; the first respawn backoff is 1s, and the replacement then stays up.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        assert.equal(handle.children.length, 1, 'exactly one live child is tracked after a respawn');
        const replacement = handle.children[0];
        assert.ok(replacement, 'the replacement is registered, not just the dead original');
        assert.notEqual(replacement.pid, firstPid, 'and it is a different process');
        // The respawn itself is silent by design; the counter is the only thing that makes a
        // crash-looping shard visible, since its replacement keeps reporting healthily.
        assert.ok((shardRestartCounts.get('shard-0') ?? 0) >= 1,
            'an unexpected exit must be counted for /metrics');

        // The point of tracking it: stop() must reach it.
        handle.stop();
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(replacement.killed, true, 'stop() signalled the replacement, not just the corpse');
    } finally {
        handle.stop();
        delete process.env['ORCHESTRATOR_STUB_MARKER'];
    }
});

test('single-process mode is flagged once it is asked to carry a sharded-scale workload', () => {
    // shardCount: 1 is the default, and it is the ONE path with no heap ceiling: the ceiling is an
    // execArgv on the fork, so a process that never forks cannot have one. That is fine for the
    // handful of exchanges local dev runs, and not fine at the 76-exchange discovery scale where a
    // shard already measured 20.54GB RSS with a ceiling in place.
    assert.equal(unshardedMemoryRisk(1, 4), false, 'a small explicit exchange list is what this mode is for');
    assert.equal(unshardedMemoryRisk(1, 76), true, 'discovery scale in one unbounded process must be loud');
    assert.equal(unshardedMemoryRisk(4, 76), false, 'sharded: every worker is forked with a ceiling');
});

test('a shard that never acknowledges init is a crash loop, not a retry', () => {
    // A stale or half-unpacked deploy leaves shardWorker.js missing: the fork exits immediately,
    // every time, and the respawn backoff caps at 30s — so the parent retries forever while
    // /health keeps answering 200 and every exchange on that shard is offline. The distinguishing
    // evidence is that the shard has NEVER got far enough to acknowledge its assignments.
    assert.equal(shouldAbortOnCrashLoop(1, false), false, 'one crash is a crash, not a loop');
    assert.equal(shouldAbortOnCrashLoop(CRASH_LOOP_RESTART_LIMIT, false), true,
        'repeated exits with no acknowledgement mean the shard cannot start at all');
    // A shard that HAS run is a different failure: it can crash and legitimately recover, and
    // killing the whole router over a flapping venue would be worse than the flap.
    assert.equal(shouldAbortOnCrashLoop(CRASH_LOOP_RESTART_LIMIT * 10, true), false,
        'a shard that once worked keeps its unlimited respawn');
});
