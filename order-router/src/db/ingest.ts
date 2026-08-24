import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Pool } from './pool.js';

// Ships the router's audit stream into Postgres.
//
// There is deliberately no second database. The durable buffer is the audit log FILE, which is
// already durable — an earlier draft put a SQLite spool here, which only ever made sense when
// Postgres was remote. With Postgres on the same machine, a Postgres outage is a box event and the
// spool bought nothing while costing a whole second system.
//
// The cursor is committed in the SAME TRANSACTION as the rows it accounts for. That single property
// is what makes this crash-safe: after any failure the process either advanced and counted, or did
// neither, so replaying from the last committed offset is idempotent without a dedup table.

export interface IngestStats {
    linesRead: number;
    requestsInserted: number;
    batches: number;
}

interface AuditLine {
    event?: string;
    reqId?: string;
    keyUuid?: string | null;
    userId?: string | null;
    method?: string;
    route?: string;
    statusCode?: number;
    durationMs?: number;
    ip?: string | null;
    userAgent?: string | null;
    origin?: string | null;
    time?: number;
    // route_recommendation extras
    from?: string;
    to?: string;
    exactSide?: string;
    requestedAmount?: number;
    strategy?: string;
    amountIn?: number;
    amountOut?: number;
    effectiveRate?: number | null;
    referenceRate?: number | null;
    impactBps?: number | null;
    fillRatio?: number;
    fullyFillable?: boolean;
    unroutableReason?: string | null;
    hops?: {
        pair: string; side: string; in: number; out: number; fee: number; feeCcy: string;
        fresh: number; impactBps: number | null;
        legs: { ex: string; amt: number; eff: number }[];
    }[];
}

// Unauthenticated requests have no key. usage_hour's primary key cannot hold a NULL, so they roll
// up under a sentinel rather than being dropped — a 401 is exactly the traffic you want visible.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const READ_CHUNK = 1 << 20;

// Reads whole lines from `offset`, leaving any trailing partial line unread — a tailer that
// consumed a half-written line would corrupt a row and then advance past it forever.
function readLines (path: string, offset: number): { lines: string[]; nextOffset: number; size: number } {
    const size = statSync(path).size;
    if (size <= offset) return { lines: [], nextOffset: offset, size };
    const fd = openSync(path, 'r');
    try {
        const want = Math.min(READ_CHUNK, size - offset);
        const buf = Buffer.allocUnsafe(want);
        const read = readSync(fd, buf, 0, want, offset);
        const text = buf.subarray(0, read).toString('utf8');
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) return { lines: [], nextOffset: offset, size };
        const complete = text.slice(0, lastNewline);
        return {
            lines: complete.split('\n').filter((l) => l.length > 0),
            nextOffset: offset + Buffer.byteLength(complete, 'utf8') + 1,
            size,
        };
    } finally {
        closeSync(fd);
    }
}

export async function ingestOnce (
    pool: Pool, path: string, stream: string, logger: Logger,
): Promise<IngestStats> {
    const stats: IngestStats = { linesRead: 0, requestsInserted: 0, batches: 0 };

    let inode: number;
    try {
        inode = statSync(path).ino;
    } catch {
        return stats;   // the router has not written anything yet
    }

    const cursorRes = await pool.query<{ byte_offset: number; inode: string | null }>(
        'SELECT byte_offset, inode FROM ingest_cursor WHERE stream = $1', [stream],
    );
    let offset = cursorRes.rows[0]?.byte_offset ?? 0;
    const knownInode = cursorRes.rows[0]?.inode;

    // Rotation with `create` gives the new file a different inode; start it from the beginning
    // rather than from an offset that belonged to a file we no longer have.
    if (knownInode !== null && knownInode !== undefined && Number(knownInode) !== inode) {
        logger.info({ stream, from: knownInode, to: inode }, 'audit log rotated, restarting at offset 0');
        offset = 0;
    }
    // Truncation without rotation (copytruncate) shows up as a file shorter than our offset. Data
    // between the offset and the truncation is gone; say so rather than silently undercounting.
    const currentSize = statSync(path).size;
    if (currentSize < offset) {
        logger.warn({ stream, offset, size: currentSize },
            'audit log truncated in place — records between the cursor and the truncation are lost. '
            + 'Rotate this file with `create`, not `copytruncate`.');
        offset = 0;
    }

    for (;;) {
        const { lines, nextOffset } = readLines(path, offset);
        if (lines.length === 0) break;
        stats.linesRead += lines.length;

        // Two events describe one request: the access line (always) and the routing record (only
        // for /route). Pair them by reqId within the batch so the row is written once, complete.
        const byReq = new Map<string, AuditLine>();
        for (const line of lines) {
            let parsed: AuditLine;
            try {
                parsed = JSON.parse(line) as AuditLine;
            } catch {
                continue;   // a non-JSON line is not ours; skipping is correct, not a failure
            }
            if (parsed.event !== 'request' && parsed.event !== 'route_recommendation') continue;
            const id = parsed.reqId;
            if (id === undefined) continue;
            byReq.set(id, { ...(byReq.get(id) ?? {}), ...parsed });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const [reqId, r] of byReq) {
                if (r.statusCode === undefined) continue;   // no access line yet; it will pair next pass
                const id = randomUUID();
                const ts = new Date(r.time ?? Date.now());
                await client.query(
                    `INSERT INTO requests (
                        id, ts, key_id, user_id, route, method, status, duration_ms,
                        from_asset, to_asset, exact_side, requested_amount, strategy,
                        amount_in, amount_out, effective_rate, reference_rate, impact_bps,
                        fill_ratio, fully_fillable, unroutable_reason, hop_count,
                        ip, user_agent, origin, request_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                             $19,$20,$21,$22,$23,$24,$25,$26)
                     ON CONFLICT DO NOTHING`,
                    [
                        id, ts, r.keyUuid ?? null, r.userId ?? null, r.route ?? 'unmatched',
                        r.method ?? 'GET', r.statusCode, r.durationMs ?? 0,
                        r.from ?? null, r.to ?? null, r.exactSide ?? null, r.requestedAmount ?? null,
                        r.strategy ?? null, r.amountIn ?? null, r.amountOut ?? null,
                        r.effectiveRate ?? null, r.referenceRate ?? null, r.impactBps ?? null,
                        r.fillRatio ?? null, r.fullyFillable ?? null, r.unroutableReason ?? null,
                        r.hops?.length ?? null,
                        r.ip ?? null, r.userAgent ?? null, r.origin ?? null, reqId,
                    ],
                );
                for (const [hopIndex, hop] of (r.hops ?? []).entries()) {
                    await client.query(
                        `INSERT INTO request_hops (request_id, ts, hop_index, pair, side,
                            amount_in, amount_out, fee_cost, fee_currency, impact_bps, fresh_venue_count)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
                        [id, ts, hopIndex, hop.pair, hop.side, hop.in, hop.out, hop.fee,
                            hop.feeCcy, hop.impactBps ?? null, hop.fresh ?? null],
                    );
                    for (const leg of hop.legs ?? []) {
                        await client.query(
                            `INSERT INTO request_legs (request_id, ts, hop_index, exchange_id,
                                amount, average_price)
                             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
                            [id, ts, hopIndex, leg.ex, leg.amt, leg.eff],
                        );
                    }
                }
                // The rollup is maintained here, in the same transaction, so the dashboard's query
                // is identical at 100 req/day and at 1,000 req/s.
                await client.query(
                    `INSERT INTO usage_hour (hour_start, key_id, user_id, route, status_class,
                                             requests, duration_sum)
                     VALUES (date_trunc('hour', $1::timestamptz), $2, $3, $4, $5, 1, $6)
                     ON CONFLICT (hour_start, key_id, route, status_class) DO UPDATE
                       SET requests = usage_hour.requests + 1,
                           duration_sum = usage_hour.duration_sum + EXCLUDED.duration_sum`,
                    [ts, r.keyUuid ?? NIL_UUID, r.userId ?? NIL_UUID, r.route ?? 'unmatched',
                        Math.floor((r.statusCode ?? 0) / 100), r.durationMs ?? 0],
                );
                stats.requestsInserted += 1;
            }

            // Committed WITH the rows above. This is the whole durability story.
            await client.query(
                `INSERT INTO ingest_cursor (stream, byte_offset, inode, updated_at)
                 VALUES ($1, $2, $3, now())
                 ON CONFLICT (stream) DO UPDATE
                   SET byte_offset = EXCLUDED.byte_offset, inode = EXCLUDED.inode, updated_at = now()`,
                [stream, nextOffset, inode],
            );
            await client.query('COMMIT');
            stats.batches += 1;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => { /* the connection may already be gone */ });
            throw err;
        } finally {
            client.release();
        }
        offset = nextOffset;
    }

    return stats;
}

export function startIngest (
    pool: Pool, path: string, stream: string, intervalMs: number, logger: Logger,
): () => void {
    let running = false;
    let stopped = false;
    const tick = async (): Promise<void> => {
        if (running || stopped) return;   // never overlap: two passes would double-read the file
        running = true;
        try {
            const stats = await ingestOnce(pool, path, stream, logger);
            if (stats.requestsInserted > 0) {
                logger.info({ ...stats }, 'ingested audit records');
            }
        } catch (err) {
            logger.error({ err }, 'audit ingest failed; the cursor did not advance');
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); };
}
