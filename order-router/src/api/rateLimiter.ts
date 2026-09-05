// Minimal fixed-window rate limiter for the bare node:http MCP server, which cannot use
// @fastify/rate-limit. Deliberately mirrors the Fastify limiter's semantics (see
// src/api/server.ts): bucket by API key only once the key is valid, otherwise by client address,
// so an attacker rotating the key header cannot mint unlimited fresh buckets.
//
// This exists because the MCP endpoint proxies the same privileged data behind the same
// credential; leaving it unthrottled would have left a second, equivalent brute-force door open
// after the first was closed.

export interface RateLimitDecision {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetSeconds: number;
}

export class FixedWindowRateLimiter {
    private readonly max: number;
    private readonly windowMs: number;
    private buckets = new Map<string, { count: number; expiresAt: number }>();

    constructor (max: number, windowMs: number) {
        this.max = max;
        this.windowMs = windowMs;
    }

    // Drops expired buckets. Bucket keys are partly client-controlled (the IP side), so without
    // pruning the map would grow without bound under a distributed flood.
    private prune (now: number): void {
        for (const [key, bucket] of this.buckets) {
            if (bucket.expiresAt <= now) {
                this.buckets.delete(key);
            }
        }
    }

    consume (bucketKey: string, now = Date.now()): RateLimitDecision {
        // Amortized cleanup: only sweep when the map has grown enough to be worth it, so the
        // common path stays O(1) rather than O(n) per request.
        if (this.buckets.size > 1000) {
            this.prune(now);
        }

        let bucket = this.buckets.get(bucketKey);
        if (!bucket || bucket.expiresAt <= now) {
            bucket = { count: 0, expiresAt: now + this.windowMs };
            this.buckets.set(bucketKey, bucket);
        }
        bucket.count += 1;

        const resetSeconds = Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000));
        return {
            allowed: bucket.count <= this.max,
            limit: this.max,
            remaining: Math.max(0, this.max - bucket.count),
            resetSeconds,
        };
    }

    // Exposed for tests asserting the pruning behaviour.
    get bucketCount (): number {
        return this.buckets.size;
    }
}
