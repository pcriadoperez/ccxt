// Bounded-concurrency startup for connectors, shared by the shard worker and by the
// single-process path in index.ts.
//
// Starting every exchange at once means N simultaneous loadMarkets() calls plus N first
// order-book snapshots, and that peak is what V8 grows the heap to hold and then never gives
// back — one shard measured 20.54GB RSS, flat, against siblings at 0.44-1.07GB. Serialising
// entirely would make startup unnecessarily slow, so this admits a few at a time: the peak
// scales with the limit rather than with the exchange count.
//
// It lives here, rather than inline in the shard, because single-process mode (shardCount: 1,
// the default) runs the same connectors in a process that has NO heap ceiling to catch it —
// the path with the least protection was the one starting unbounded.
//
// `start` is expected to handle its own failures: one exchange that cannot start must not take
// the rest of the shard with it, and only the caller knows how to report it.
export async function startWithConcurrency<T> (
    items: T[],
    limit: number,
    start: (item: T, remaining: number) => Promise<void>,
): Promise<void> {
    const queue = [...items];
    const workers = Math.min(Math.max(1, limit), queue.length);
    await Promise.all(Array.from({ length: workers }, async () => {
        for (;;) {
            const next = queue.shift();
            if (next === undefined) return;
            await start(next, queue.length);
        }
    }));
}
