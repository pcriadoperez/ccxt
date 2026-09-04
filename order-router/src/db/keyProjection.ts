import type { Logger } from 'pino';
import type { Pool } from './pool.js';
import { writeKeyFile, type ApiKeyRecord, type KeyFile } from '../api/keyStore.js';

// Projects api_keys from Postgres into the snapshot file the router reads.
//
// This exists so the router can hold NO database credential. Auth is one SHA-256 and one Map.get
// against an in-memory snapshot, and it has to stay that way: if authentication could wait on a
// network round-trip, a database blip would become a routing outage. Withholding the connection
// string from the router's environment makes that structural rather than a promise somebody has to
// remember. The projection is written by whichever process already legitimately talks to Postgres —
// the admin/web app — not by a router that would then have a reason to query it.
//
// Failure is deliberately silent-and-stale: if Postgres is unreachable, nothing is written, the
// previous file remains, and every existing key keeps authenticating indefinitely. New keys do not
// go live until Postgres returns. That asymmetry is the point.

export interface ProjectionResult {
    keys: number;
    changed: boolean;
}

interface KeyRow {
    id: string;
    display_id: string;
    user_id: string;
    name: string;
    hash: string;
    last4: string;
    note: string;
    rate_limit_max: number | null;
    ws_max_connections: number | null;
    created_at: Date;
    created_by: string;
}

export async function projectKeys (pool: Pool, path: string, logger: Logger): Promise<ProjectionResult> {
    // Only keys that still authenticate. Revoked rows are filtered here rather than written and
    // skipped later, so revocation is a load-time property in the router exactly as it was before.
    const { rows } = await pool.query<KeyRow>(
        `SELECT k.id, k.display_id, k.user_id, k.name, k.hash, k.last4, k.note,
                k.rate_limit_max, k.ws_max_connections, k.created_at, k.created_by
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
          WHERE k.revoked_at IS NULL
          ORDER BY k.created_at`,
    );

    const file: KeyFile = {
        version: 1,
        keys: rows.map((r): ApiKeyRecord => ({
            id: r.display_id,
            keyUuid: r.id,
            userId: r.user_id,
            name: r.name,
            hash: r.hash,
            last4: r.last4,
            note: r.note,
            rateLimitMax: r.rate_limit_max,
            wsMaxConnections: r.ws_max_connections,
            createdAt: r.created_at.toISOString(),
            createdBy: r.created_by,
            revokedAt: null,
            lastUsedAt: null,
        })),
    };

    const changed = writeKeyFile(path, file);
    if (changed) {
        logger.info({ keys: file.keys.length, path }, 'projected API keys to the router snapshot');
    }
    return { keys: file.keys.length, changed };
}

// Runs the projection on an interval. Returns a stop function.
//
// The interval is the FIRST half of revocation latency; the router's own file poll is the second.
// Both are deliberately short because revocation latency is a security property, not a
// convenience: the gap between "the operator clicked revoke" and "the key stops working" is a
// window in which a known-compromised credential still routes.
export function startKeyProjection (
    pool: Pool, path: string, intervalMs: number, logger: Logger,
): () => void {
    let stopped = false;
    const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
            await projectKeys(pool, path, logger);
        } catch (err) {
            // Deliberately not fatal and deliberately not clearing the file. A Postgres outage
            // must not de-authenticate every existing customer.
            logger.error({ err }, 'key projection failed; the router keeps its previous snapshot');
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); };
}
