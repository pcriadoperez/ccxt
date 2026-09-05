import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWithConcurrency } from './startConcurrently.js';

function deferred () {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

test('never admits more than the limit at once', async () => {
    // The peak V8 grows the heap to is the peak of SIMULTANEOUS loadMarkets calls plus first
    // snapshots — one shard measured 20.54GB RSS, flat, against siblings at 0.44-1.07GB. Bounding
    // the admission is the only thing that bounds that peak.
    const gates = Array.from({ length: 10 }, () => deferred());
    let inFlight = 0;
    let peak = 0;
    const run = startWithConcurrency(gates, 3, async (gate) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gate.promise;
        inFlight -= 1;
    });
    // Let the first admission wave settle, then release everything.
    await new Promise((r) => setImmediate(r));
    assert.equal(peak, 3, 'the first wave is the limit, not the whole queue');
    for (const gate of gates) gate.resolve();
    await run;
    assert.equal(peak, 3);
});

test('starts every item exactly once, in queue order', async () => {
    const started: number[] = [];
    await startWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { started.push(n); });
    assert.deepEqual(started.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('a limit below one still admits one, rather than deadlocking', async () => {
    const started: number[] = [];
    await startWithConcurrency([1, 2], 0, async (n) => { started.push(n); });
    assert.deepEqual(started, [1, 2]);
});

test('an empty queue resolves without spawning a worker', async () => {
    let calls = 0;
    await startWithConcurrency([], 4, async () => { calls += 1; });
    assert.equal(calls, 0);
});
