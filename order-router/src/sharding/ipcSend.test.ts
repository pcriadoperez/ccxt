import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcSender, type RawSend } from './ipcSend.js';
import type { ShardToParentMessage } from './messages.js';

const book = (): ShardToParentMessage => ({ type: 'book', book: {} as never });
const health = (): ShardToParentMessage => ({ type: 'health', health: {} as never });
const fee = (): ShardToParentMessage =>
    ({ type: 'fee', exchangeId: 'binance', symbol: 'BTC/USDT', takerFeeRate: 0.001 });

// A send channel that reports the pipe full and never flushes, so nothing clears the backpressure.
function blockedChannel (): { raw: RawSend; sent: ShardToParentMessage[] } {
    const sent: ShardToParentMessage[] = [];
    return { raw: (message) => { sent.push(message); return false; }, sent };
}

test('a full pipe drops health snapshots, not just book snapshots', () => {
    // Health bypassed the gate entirely, and its rate is proportional to the FAILURE rate: an
    // exchange flapping emits a health record per error while the parent is least able to drain
    // them. Every one was queued in native write buffers, which is the memory the gate exists to
    // bound.
    const { raw, sent } = blockedChannel();
    const ipc = createIpcSender(raw);
    ipc.send(book());                       // accepted, marks the pipe full
    for (let i = 0; i < 50; i++) ipc.send(health());
    for (let i = 0; i < 50; i++) ipc.send(book());
    assert.equal(sent.length, 1, 'nothing should reach a pipe already known to be full');
    assert.equal(ipc.stats().droppedHealth, 50);
    assert.equal(ipc.stats().droppedBooks, 50);
});

test('rare, non-idempotent messages are never dropped', () => {
    // A fee discovery happens once per symbol and a loop sample once per interval. Neither is
    // resent, so dropping one loses information permanently — and neither can fill a pipe.
    const { raw, sent } = blockedChannel();
    const ipc = createIpcSender(raw);
    ipc.send(book());
    for (let i = 0; i < 5; i++) ipc.send(fee());
    assert.equal(sent.length, 6);
});

test('a flush clears backpressure and snapshots flow again', () => {
    let flush: (() => void) | undefined;
    let full = true;
    const sent: ShardToParentMessage[] = [];
    const raw: RawSend = (message, _h, _o, callback) => {
        sent.push(message); flush = callback; return !full;
    };
    const ipc = createIpcSender(raw);
    ipc.send(health());
    ipc.send(health());
    assert.equal(ipc.stats().droppedHealth, 1);
    full = false;
    flush!();                               // parent drained the pipe
    ipc.send(health());
    assert.equal(sent.length, 2, 'the next snapshot after a flush is sent');
    assert.equal(ipc.stats().droppedHealth, 1);
});

test('a shard with no parent channel counts nothing and throws nothing', () => {
    const ipc = createIpcSender(undefined);
    ipc.send(book());
    assert.deepEqual(ipc.stats(), { sentBooks: 0, droppedBooks: 0, droppedHealth: 0 });
});
