#!/usr/bin/env node
// Applies the schema and ensures partitions. Idempotent, so it is safe to run on every deploy.
import { logger } from '../logger.js';
import { createPool, applySchema } from './pool.js';

const pool = createPool(logger);
try {
    await applySchema(pool, logger);
    logger.info('migration complete');
} catch (err) {
    logger.error({ err }, 'migration failed');
    process.exitCode = 1;
} finally {
    await pool.end();
}
