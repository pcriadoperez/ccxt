#!/usr/bin/env node
// Runs the audit ingester and the key projection. This is the process that legitimately holds the
// database credential — the router deliberately does not, so that authentication can never be made
// to wait on a query.
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createPool, ensurePartitions } from './pool.js';
import { startIngest } from './ingest.js';
import { startKeyProjection } from './keyProjection.js';

const pool = createPool(logger);
const auditPath = config.auditLogFile;
if (auditPath === undefined) {
    logger.error('ORDER_ROUTER_AUDIT_LOG_FILE is not set; nothing to ingest');
    process.exit(1);
}

// Daily, so next month's partitions exist well before the first insert that needs them.
await ensurePartitions(pool, new Date(), logger);
setInterval(() => void ensurePartitions(pool, new Date(), logger).catch(
    (err: unknown) => logger.error({ err }, 'partition maintenance failed')), 24 * 60 * 60 * 1000).unref();

const stopIngest = startIngest(pool, auditPath, 'router-audit', config.ingestIntervalMs, logger);
const stopProjection = startKeyProjection(pool, config.keysFile, config.keyProjectionIntervalMs, logger);
logger.info({ auditPath, keysFile: config.keysFile }, 'ingest runner started');

const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'ingest runner shutting down');
    stopIngest();
    stopProjection();
    await pool.end();
    process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
