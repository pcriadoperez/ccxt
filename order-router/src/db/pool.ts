import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Logger } from 'pino';
import { config } from '../config.js';

// Postgres returns numeric/int8 as strings by default, because they can exceed IEEE-754 range.
// For this schema they cannot — request counts and amounts are far inside it — and silently
// handing the dashboard "1234" where it expects 1234 is a bug generator. Parse them.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export type Pool = pg.Pool;

// One pool per process. Deliberately NOT created in the router: the router must never hold a
// connection string, so that "auth waits on the database" cannot be introduced by accident. See
// docs/product-plan.md §3.
export function createPool (logger: Logger): pg.Pool {
    if (config.databaseUrl === undefined) {
        throw new Error('DATABASE_URL is not set');
    }
    const pool = new pg.Pool({
        connectionString: config.databaseUrl,
        max: config.databasePoolMax,
        // A hung connection must not hold a request forever; failing fast is what lets the caller
        // fall back to a cached snapshot rather than hanging.
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
    });
    // An idle client erroring (a Postgres restart, a network blip) emits on the pool. Unhandled,
    // that is an uncaught exception that kills the process.
    pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));
    return pool;
}

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

// Applies the schema. Every statement is CREATE ... IF NOT EXISTS, so this is idempotent and safe
// to run on every boot — which is the whole migration story for the beta. When the schema starts
// changing under real data, this becomes a numbered-migration table; the trigger for that is the
// first ALTER that cannot be expressed as a fresh CREATE.
export async function applySchema (pool: pg.Pool, logger: Logger): Promise<void> {
    const sql = readFileSync(SCHEMA_PATH, 'utf8');
    await pool.query(sql);
    await ensurePartitions(pool, new Date(), logger);
    logger.info('database schema applied');
}

const PARTITIONED = ['requests', 'request_hops', 'request_legs'];

function monthBounds (d: Date): { name: string; from: string; to: string } {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const name = `${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
    return { name, from: start.toISOString(), to: end.toISOString() };
}

// Creates this month's and next month's partitions. Called at boot and daily. Without next month's,
// the first insert after midnight on the 1st fails — which is the classic partitioning outage, and
// it happens at the worst possible time to be debugging.
export async function ensurePartitions (pool: pg.Pool, now: Date, logger: Logger): Promise<void> {
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    for (const when of [now, next]) {
        const { name, from, to } = monthBounds(when);
        for (const table of PARTITIONED) {
            // Postgres does not accept bind parameters in DDL, so the bounds are interpolated.
            // They are derived from a Date, never from user input, and are ISO-8601 by
            // construction — but assert that rather than trusting it, because an interpolated
            // string in DDL is exactly where a mistake becomes injection.
            if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(from) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(to)) {
                throw new Error(`refusing to build DDL from an unexpected bound: ${from} .. ${to}`);
            }
            await pool.query(
                `CREATE TABLE IF NOT EXISTS ${table}_${name} PARTITION OF ${table} `
                + `FOR VALUES FROM ('${from}') TO ('${to}')`,
            );
        }
    }
    logger.debug('partitions ensured');
}
