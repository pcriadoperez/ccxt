import type { LoopHealth } from '../loopHealth.js';

// Per-shard loop health, keyed by shard pid. Populated over IPC in sharded mode and by the
// process itself when running unsharded, so /metrics reports the loops that actually do the work
// rather than only the API process.
export class LoopRegistry {
    private byShard = new Map<string, LoopHealth & { updatedAt: number }>();

    set (shard: string, health: LoopHealth): void {
        this.byShard.set(shard, { ...health, updatedAt: Date.now() });
    }

    entries (): [string, LoopHealth & { updatedAt: number }][] {
        return [...this.byShard.entries()];
    }
}
