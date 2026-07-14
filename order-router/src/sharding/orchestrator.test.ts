import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionAssignments } from './orchestrator.js';
import type { ShardAssignment } from './messages.js';

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
