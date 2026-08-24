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
}

export type ShardToParentMessage =
    | ShardBookMessage | ShardHealthMessage | ShardFeeMessage | ShardLoopMessage;
