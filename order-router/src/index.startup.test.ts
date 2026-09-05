import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Source-level, for the same reason as shardWorker.lifecycle.test.ts: exercising this behaviourally
// means booting a router that opens live exchange websockets. What matters is which arguments the
// single-process path hands its connectors, and that is legible here.
//
// Single-process mode (shardCount: 1) is the DEFAULT, and it had none of the memory protections the
// shard path was given: it started every exchange at once, and it left maxBookDepth at its
// whole-book default — in the one process that cannot be forked with a heap ceiling.

const SRC = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

test('the single-process path starts connectors under the same bound the shard path uses', () => {
    assert.ok(SRC.indexOf('startWithConcurrency') !== -1,
        'connector startup must be admission-bounded, not Promise.all over every assignment');
    assert.equal(SRC.indexOf('await Promise.all(\n        assignments.map'), -1,
        'unbounded startup rebuilds exactly the heap peak the shard ceiling exists to hold');
});

test('the configured book depth reaches the single-process connectors', () => {
    assert.ok(SRC.indexOf('config.maxBookDepth') !== -1,
        'maxBookDepth was passed only by the shard worker, so it was silently ignored by default');
});

test('single-process mode warns when it is asked to carry discovery-scale load', () => {
    assert.ok(SRC.indexOf('unshardedMemoryRisk') !== -1,
        'a heap ceiling cannot be applied to a process that never forks; say so at boot');
});

test('a symbol universe that could not be ranked refuses to boot', () => {
    // Discovery runs once, at boot. Continuing past a failed ranking is not a transient
    // degradation — it is a junk symbol universe for the process lifetime.
    assert.ok(SRC.indexOf('isUsableRanking') !== -1, 'the ranking must be checked before it is trusted');
    assert.equal(SRC.indexOf("logger.error('no exchanges have any routable symbols"), -1,
        'no routable symbols must exit non-zero, not log and listen anyway');
});
