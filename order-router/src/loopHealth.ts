import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

export interface LoopHealth {
    rssBytes?: number;
    heapUsedBytes?: number;
    externalBytes?: number;
    sentBooks?: number;
    droppedBooks?: number;
    droppedHealth?: number;
    // Fraction of wall-clock the loop spent ACTIVE rather than idle, over the last window (0..1).
    // This is the honest saturation signal: at 1.0 the loop never idles, so every incoming message
    // queues behind work already in progress. Lag alone is noisier — it measures timer tardiness,
    // which depends on what else is scheduled.
    utilization: number;
    lagP50Ms: number;
    lagP99Ms: number;
    lagMaxMs: number;
}

// Sampling is cheap: monitorEventLoopDelay is a native histogram, and ELU is two counters.
export function createLoopMonitor (resolutionMs = 20) {
    const delay = monitorEventLoopDelay({ resolution: resolutionMs });
    delay.enable();
    let previousElu: EventLoopUtilization = performance.eventLoopUtilization();

    return {
        // Reads and RESETS the window, so each call reports the interval since the last call
        // rather than a since-boot average that would mask a recent stall.
        sample (): LoopHealth {
            const elu = performance.eventLoopUtilization(previousElu);
            previousElu = performance.eventLoopUtilization();
            const health: LoopHealth = {
                utilization: elu.utilization,
                lagP50Ms: delay.percentile(50) / 1e6,
                lagP99Ms: delay.percentile(99) / 1e6,
                lagMaxMs: delay.max / 1e6,
            };
            delay.reset();
            return health;
        },
    };
}
