#!/usr/bin/env node
// Bootstrap and break-glass administration. Replaces the old `keys` CLI, whose create/revoke/delete
// commands now belong to the dashboard — a CLI that writes keys made sense when a JSON file was the
// source of truth; with Postgres holding them, two writers to the same rows is a lost-update
// problem nobody needs.
//
// What remains here is what a web UI genuinely cannot do:
//   create-admin  — the first account, before any login exists to create it with
//   create-key    — the first key, before the dashboard exists to mint it with
//   project       — force a key projection, for debugging the router's snapshot
import { parseArgs } from 'node:util';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createPool } from '../db/pool.js';
import { projectKeys } from '../db/keyProjection.js';
import { generateKey, hashKey } from '../api/keyStore.js';

// scrypt N=16384, not 2**15: on Node 22, 128*N*r at N=2**15 is exactly one byte over the 32 MiB
// maxmem default and throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Verified on v22.22.1.
export const SCRYPT_N = 16384;

export function hashPassword (password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
    return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function main (): Promise<number> {
    const [command, ...rest] = process.argv.slice(2);
    const pool = createPool(logger);
    try {
        if (command === 'create-admin') {
            const { values } = parseArgs({
                args: rest, options: { email: { type: 'string' }, password: { type: 'string' } },
            });
            if (!values.email || !values.password) {
                process.stderr.write('usage: admin create-admin --email <e> --password <p>\n');
                return 2;
            }
            if (values.password.length < 12) {
                // The admin account is the only thing between the internet and key minting.
                process.stderr.write('password must be at least 12 characters\n');
                return 2;
            }
            const id = randomUUID();
            await pool.query(
                `INSERT INTO users (id, email, password_hash, is_admin, plan, email_verified_at)
                 VALUES ($1, $2, $3, true, 'admin', now())
                 ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
                                                   is_admin = true`,
                [id, values.email, hashPassword(values.password)],
            );
            process.stdout.write(`  admin ready: ${values.email}\n`);
            return 0;
        }

        if (command === 'create-key') {
            const { values } = parseArgs({
                args: rest,
                options: { email: { type: 'string' }, name: { type: 'string' }, note: { type: 'string' } },
            });
            if (!values.email || !values.name) {
                process.stderr.write('usage: admin create-key --email <user-email> --name <key-name>\n');
                return 2;
            }
            const user = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [values.email]);
            const userId = user.rows[0]?.id;
            if (userId === undefined) {
                process.stderr.write(`no user with email ${values.email}\n`);
                return 1;
            }
            const plaintext = generateKey();
            const id = randomUUID();
            // display_id is derived from the uuid rather than generated separately, so it inherits
            // the uuid's uniqueness instead of being another 32-bit value with no collision check.
            const displayId = `k_${id.replace(/-/g, '').slice(0, 12)}`;
            await pool.query(
                `INSERT INTO api_keys (id, display_id, user_id, name, hash, last4, note, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'cli')`,
                [id, displayId, userId, values.name, hashKey(plaintext), plaintext.slice(-4), values.note ?? ''],
            );
            await projectKeys(pool, config.keysFile, logger);
            process.stdout.write(
                `  id    ${displayId}\n  key   ${plaintext}\n`
                + '  ! Shown once. Stored only as a digest.\n');
            return 0;
        }

        if (command === 'project') {
            const result = await projectKeys(pool, config.keysFile, logger);
            process.stdout.write(`  projected ${result.keys} keys to ${config.keysFile}`
                + `${result.changed ? '' : ' (unchanged)'}\n`);
            return 0;
        }

        process.stderr.write('usage: admin <create-admin|create-key|project> [...]\n');
        return 2;
    } finally {
        await pool.end();
    }
}

if (process.argv[1] !== undefined && /admin\.(js|ts)$/.test(process.argv[1])) {
    process.exitCode = await main();
}
