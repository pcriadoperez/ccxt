#!/usr/bin/env node
// Runs the audit ingester and the key projection. This is the process that legitimately holds the
// database credential — the router deliberately does not, so that authentication can never be made
// to wait on a query.
import { config } from '../config.js';
import { logger } from '../logger.js';
import { installCrashHandlers } from '../crashHandlers.js';
import { createPool, ensurePartitions } from './pool.js';
import { startIngest } from './ingest.js';
import { startKeyProjection } from './keyProjection.js';

installCrashHandlers(logger, 'ingest');

const pool = createPool(logger);
const auditPath = config.auditLogFile;
if (auditPath === undefined) {
    logger.error('ORDER_ROUTER_AUDIT_LOG_FILE is not set; nothing to ingest');
    process.exit(1);
}

// Daily, so next month's partitions exist well before the first insert that needs them.
//
// Deliberately not fatal, and deliberately not a bare top-level await. Postgres being unreachable
// at boot is a transient this process is expected to ride out: dying here instead would restart on
// a tight loop, and systemd's StartLimitBurst then disables the unit PERMANENTLY — turning a
// two-minute database blip into an ingester that never comes back. So the first attempt retries on
// a short timer until it lands, and only then falls back to the daily cadence.
let partitionsReady = false;
const ensurePartitionsSafely = async (): Promise<void> => {
    try {
        await ensurePartitions(pool, new Date(), logger);
        if (!partitionsReady) {
            partitionsReady = true;
            clearInterval(partitionRetry);
        }
    } catch (err) {
        logger.error({ err }, 'partition maintenance failed');
    }
};
const partitionRetry = setInterval(() => void ensurePartitionsSafely(), 30_000);
partitionRetry.unref();
await ensurePartitionsSafely();
setInterval(() => void ensurePartitionsSafely(), 24 * 60 * 60 * 1000).unref();

const stopIngest = startIngest(pool, auditPath, 'router-audit', config.ingestIntervalMs, logger);
const stopProjection = startKeyProjection(pool, config.keysFile, config.keyProjectionIntervalMs, logger);

// The one ref'd handle in this process, and the reason it exists: every timer inside startIngest,
// startKeyProjection and the partition maintenance above is unref'd, so nothing those functions
// create keeps the event loop alive. What kept this process running in practice was the pg pool's
// idle client socket — which exists only while Postgres is REACHABLE. Lose the database and the
// last ref'd handle goes with it, the loop empties, and node exits **0**. A clean exit is not a
// failure, so `Restart=on-failure` does not fire, and the ingester stays dead until a human
// notices that the audit table stopped growing. Both loops already treat a Postgres outage as
// survivable and retry forever; this makes the process survive it too.
const heartbeat = setInterval(() => {
    logger.debug('ingest runner alive');
}, 60_000);

logger.info({ auditPath, keysFile: config.keysFile }, 'ingest runner started');

const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'ingest runner shutting down');
    clearInterval(heartbeat);
    stopIngest();
    stopProjection();
    await pool.end();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
