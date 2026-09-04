import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A shard orphaned during startup never exited. The `disconnect` handler — the shard's only
// instruction to die when the parent goes away — was registered at the END of runShard, after every
// connector had finished starting. Startup is the longest window in the process's life (bounded
// concurrency over N exchanges, each doing loadMarkets and a first snapshot), and it was the one
// window with no handler: a parent that died or rebalanced mid-startup left a shard holding its
// sockets and its heap, answering to nobody, until the box was restarted.
//
// Source-level, because the behavioural version needs a real fork and a parent that dies at exactly
// the right moment. What matters is the ORDER of two statements, and that is legible here.

const SRC = readFileSync(fileURLToPath(new URL('./shardWorker.ts', import.meta.url)), 'utf8');

test('the disconnect handler is registered before any connector starts', () => {
    const disconnect = SRC.indexOf("process.on('disconnect'");
    assert.notEqual(disconnect, -1, 'the shard must exit when the parent goes away');
    const runShard = SRC.indexOf('async function runShard');
    assert.ok(disconnect < runShard,
        'the disconnect handler must be registered at module load, not inside runShard');
});

test('the init handler is what starts the shard, and it comes after the disconnect handler', () => {
    // The ordering only holds if nothing re-registers or overrides it later.
    assert.equal(SRC.split("process.on('disconnect'").length - 1, 1, 'exactly one disconnect handler');
    assert.ok(SRC.indexOf("process.on('disconnect'") < SRC.indexOf("process.on('message'"));
});
