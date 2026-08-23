#!/usr/bin/env node
// API key administration. A CLI rather than an admin HTTP endpoint, deliberately: an endpoint has
// no non-circular answer to its own credential. Guard it with an admin-flagged key and that key
// still has to be bootstrapped out of band, so you need this anyway; guard it with a separate
// static secret and you have rebuilt exactly the shared-secret design this replaces, now protecting
// key CREATION rather than key use — strictly worse blast radius. Either way it is a permanent
// privilege-escalation surface reachable from :443. The operator already has SSH.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import {
    generateKey, hashKey, readKeyFile, writeKeyFile,
    KEY_FILE_VERSION, LEGACY_KEY_ID, type ApiKeyRecord,
} from '../api/keyStore.js';

function actor (): string {
    return process.env['SUDO_USER'] ?? process.env['USER'] ?? 'unknown';
}

// One JSON line per mutation on stderr, so key management is auditable too if the operator
// redirects it. Folding it into the service's own log stream is a separate process's problem.
function audit (action: string, record: Pick<ApiKeyRecord, 'id' | 'name'>): void {
    process.stderr.write(`${JSON.stringify({
        event: 'key_admin', action, id: record.id, name: record.name,
        actor: actor(), at: new Date().toISOString(),
    })}\n`);
}

function find (keys: ApiKeyRecord[], selector: string): ApiKeyRecord | undefined {
    return keys.find((k) => k.id === selector) ?? keys.find((k) => k.name === selector);
}

// A silently-ignored numeric flag is worse than a rejected one: the operator believes they capped a
// key and did not, and nothing anywhere says otherwise.
class UsageError extends Error {}
function numericOption (raw: string | undefined, flag: string): number | null {
    if (raw === undefined) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        throw new UsageError(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
    }
    return n;
}

export function runKeysCli (argv: string[], path: string): number {
    try {
        return dispatch(argv, path);
    } catch (err) {
        if (err instanceof UsageError) {
            process.stderr.write(`${err.message}\n`);
            return 2;
        }
        throw err;
    }
}

function dispatch (argv: string[], path: string): number {
    const [command, ...rest] = argv;
    if (command !== undefined) {
        process.stderr.write(`  using key file: ${resolve(path)}\n`);
        if (process.env['ORDER_ROUTER_KEYS_FILE'] === undefined) {
            process.stderr.write(
                '  (ORDER_ROUTER_KEYS_FILE is unset, so this is the default path. If the service sets\n'
                + '   it in an env file your shell does not source, you are editing a store it never reads.)\n');
        }
    }

    if (command === 'create') {
        const { values } = parseArgs({
            args: rest, allowPositionals: false,
            options: {
                name: { type: 'string' }, note: { type: 'string' },
                'rate-limit': { type: 'string' }, 'ws-max': { type: 'string' },
            },
        });
        const name = values.name;
        if (name === undefined || name.length === 0) {
            process.stderr.write('usage: keys create --name <name> [--note <text>] [--rate-limit N] [--ws-max N]\n');
            return 2;
        }
        const file = readKeyFile(path);
        // Names are the ergonomic selector for revoke, so they must be unique or `keys revoke
        // acme-desk` silently acts on whichever row happened to come first.
        if (file.keys.some((k) => k.name === name)) {
            process.stderr.write(`a key named ${name} already exists\n`);
            return 1;
        }
        const plaintext = generateKey();
        const record: ApiKeyRecord = {
            id: `k_${randomBytes(4).toString('hex')}`,
            name,
            hash: hashKey(plaintext),
            last4: plaintext.slice(-4),
            createdAt: new Date().toISOString(),
            createdBy: actor(),
            revokedAt: null,
            lastUsedAt: null,
            note: values.note ?? '',
            rateLimitMax: numericOption(values['rate-limit'], '--rate-limit'),
            wsMaxConnections: numericOption(values['ws-max'], '--ws-max'),
        };
        file.version = KEY_FILE_VERSION;
        file.keys.push(record);
        writeKeyFile(path, file);
        audit('create', record);
        process.stdout.write(
            `  id         ${record.id}\n`
            + `  name       ${record.name}\n`
            + `  key        ${plaintext}\n`
            + `  created    ${record.createdAt}\n`
            + '  ! This is the only time the key is shown. It is stored hashed and cannot be recovered.\n'
            + '  ! Live within 10s, or immediately with: systemctl reload order-router\n',
        );
        return 0;
    }

    if (command === 'list') {
        const { values } = parseArgs({
            args: rest, allowPositionals: false,
            options: { json: { type: 'boolean' }, 'include-revoked': { type: 'boolean' } },
        });
        const file = readKeyFile(path);
        const rows = values['include-revoked'] ? file.keys : file.keys.filter((k) => k.revokedAt === null);
        if (values.json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
            return 0;
        }
        process.stdout.write('  ID          NAME                CREATED     LAST USED   RL      STATUS    LAST4\n');
        for (const k of rows) {
            process.stdout.write(
                `  ${k.id.padEnd(11)} ${k.name.padEnd(19)} ${k.createdAt.slice(0, 10).padEnd(11)} `
                + `${(k.lastUsedAt?.slice(0, 10) ?? '-').padEnd(11)} `
                + `${String(k.rateLimitMax ?? '-').padEnd(7)} `
                + `${(k.revokedAt === null ? 'active' : 'revoked').padEnd(9)} ...${k.last4}\n`,
            );
        }
        // Never prints a key, only its identity — there is no plaintext left to print.
        return 0;
    }

    if (command === 'revoke') {
        const selector = rest[0];
        if (selector === undefined) {
            process.stderr.write('usage: keys revoke <id|name>\n');
            return 2;
        }
        const file = readKeyFile(path);
        let record = find(file.keys, selector);
        // The legacy shared key has no row of its own — it is synthesised from the environment. It
        // is retired by writing a tombstone, which is the whole reason the shared key can be killed
        // without the restart that would rebuild the book cache. Without this branch the documented
        // retirement step had no command behind it.
        if (record === undefined && (selector === LEGACY_KEY_ID || selector === 'legacy-shared-key')) {
            record = {
                id: LEGACY_KEY_ID, name: 'legacy-shared-key', hash: '', last4: '',
                createdAt: new Date().toISOString(), createdBy: actor(),
                revokedAt: null, lastUsedAt: null,
                note: 'tombstone suppressing the ORDER_ROUTER_API_KEY bridge',
                rateLimitMax: null, wsMaxConnections: null,
            };
            file.keys.push(record);
        }
        if (record === undefined) {
            process.stderr.write(`no key matching ${selector}\n`);
            return 1;
        }
        if (record.revokedAt !== null) {
            process.stderr.write(`${record.id} is already revoked\n`);
            return 0;
        }
        record.revokedAt = new Date().toISOString();
        writeKeyFile(path, file);
        audit('revoke', record);
        process.stdout.write(`  revoked ${record.id} (${record.name}) at ${record.revokedAt}\n`);
        return 0;
    }

    if (command === 'delete') {
        const { values, positionals } = parseArgs({
            args: rest, allowPositionals: true, options: { yes: { type: 'boolean' } },
        });
        const selector = positionals[0];
        if (selector === undefined) {
            process.stderr.write('usage: keys delete <id|name> --yes\n');
            return 2;
        }
        const file = readKeyFile(path);
        const record = find(file.keys, selector);
        if (record === undefined) {
            process.stderr.write(`no key matching ${selector}\n`);
            return 1;
        }
        // Revoke is almost always the right kill action: the surviving row is what keeps a
        // year-old log line's keyId resolvable to a name. Delete is for a key created by mistake
        // that never made a request.
        if (values.yes !== true) {
            process.stderr.write(
                `refusing to delete ${record.id} (${record.name}) without --yes.\n`
                + 'Prefer `revoke`: it stops the key immediately AND keeps existing log lines resolvable.\n',
            );
            return 1;
        }
        file.keys = file.keys.filter((k) => k.id !== record.id);
        writeKeyFile(path, file);
        audit('delete', record);
        process.stdout.write(
            `  deleted ${record.id}. WARNING: "keyId":"${record.id}" in existing logs is now unresolvable.\n`);
        return 0;
    }

    process.stderr.write('usage: keys <create|list|revoke|delete> [...]\n');
    return 2;
}

// Only when invoked directly, so tests can import runKeysCli and drive it against a temp dir.
if (process.argv[1] !== undefined && /keys\.(js|ts)$/.test(process.argv[1])) {
    process.exitCode = runKeysCli(process.argv.slice(2), config.keysFile);
}
