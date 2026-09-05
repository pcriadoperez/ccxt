import type { CachedOrderBook, ExchangeHealth } from '../types.js';

export interface ShardAssignment {
    exchangeId: string;
    symbols: string[];
}

// Parent -> shard worker: which exchanges/symbols this shard owns.
export interface ShardInitMessage {
    type: 'init';
    assignments: ShardAssignment[];
}

// Shard worker -> parent: forwarded on every book update, health change, and taker-fee discovery.
// These are the only messages that cross the process boundary — the API layer's read path never
// does; only the (already-async, off-the-request-path) cache-write path pays the IPC cost.
export interface ShardBookMessage {
    type: 'book';
    book: CachedOrderBook;
}

export interface ShardHealthMessage {
    type: 'health';
    health: ExchangeHealth;
}

export interface ShardFeeMessage {
    type: 'fee';
    exchangeId: string;
    symbol: string;
    takerFeeRate: number;
}

export interface ShardLoopMessage {
    type: 'loop';
    shardPid: number;
    utilization: number;
    lagP50Ms: number;
    lagP99Ms: number;
    lagMaxMs: number;
    // Resident set size of the shard process. Reported because shard memory was invisible: the
    // only symptom of a 20GB shard was the box swapping.
    rssBytes: number;
    heapUsedBytes: number;
    // Native memory outside the V8 heap. This is where a backpressured IPC queue accumulates, and
    // reporting only rss and heapUsed is why 19.8GB of it went unattributed for so long.
    externalBytes: number;
    sentBooks: number;
    // Books dropped because the IPC pipe was full. A steadily climbing figure means the shard is
    // producing faster than the parent can drain — which is a capacity signal, not an error.
    droppedBooks: number;
    // Health snapshots dropped for the same reason. Split from droppedBooks because they mean
    // different things: books drop when the shard out-produces the parent, health drops when a
    // venue is flapping, and confusing one for the other misreads the incident.
    droppedHealth: number;
}

// Sent once, as soon as the worker has accepted its assignments. Its only job is to tell the
// parent that this shard got far enough to run: a shard whose module is missing (a stale or
// half-unpacked deploy) exits before it can ever send one, which is what separates "cannot start
// at all" from "crashed and will recover".
export interface ShardReadyMessage {
    type: 'ready';
}

export type ShardToParentMessage =
    | ShardBookMessage | ShardHealthMessage | ShardFeeMessage | ShardLoopMessage | ShardReadyMessage;
