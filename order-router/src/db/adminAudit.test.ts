import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { recordAdminAction } from './adminAudit.js';

const silent = pino({ level: 'silent' });

function capturingPool (): { pool: unknown; calls: { sql: string; params: unknown[] }[] } {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        pool: { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; } },
        calls,
    };
}

test('an action is written to admin_audit with actor, subject and detail', async () => {
    const { pool, calls } = capturingPool();
    await recordAdminAction(pool as never, silent, {
        actorUserId: '22222222-2222-4222-8222-222222222222',
        action: 'key_created',
        subject: 'k_abc123',
        detail: { name: 'acme' },
        ip: '203.0.113.7',
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.sql.indexOf('INSERT INTO admin_audit') !== -1, calls[0]!.sql);
    assert.deepEqual(calls[0]!.params, [
        '22222222-2222-4222-8222-222222222222', 'key_created', 'k_abc123', '{"name":"acme"}', '203.0.113.7',
    ]);
});

test('an unparseable client address is stored as NULL, never handed to inet', async () => {
    // A rejected inet value aborts the transaction it is in. Attacker-controlled X-Forwarded-For
    // reached this column type once already and wedged ingestion permanently.
    const { pool, calls } = capturingPool();
    for (const bad of [ 'not-an-ip', '', undefined, '1.2.3.4; DROP TABLE users' ]) {
        await recordAdminAction(pool as never, silent, {
            actorUserId: null, action: 'key_revoked', subject: 'k_x', ip: bad,
        });
    }
    for (const call of calls) assert.equal(call.params[4], null);
    // A zone id and an ordinary v6 address are still addresses.
    await recordAdminAction(pool as never, silent, {
        actorUserId: null, action: 'key_revoked', subject: 'k_x', ip: 'fe80::1%eth0',
    });
    assert.equal(calls[calls.length - 1]!.params[4], 'fe80::1');
});

test('a failed audit write never fails the action it describes', async () => {
    // A revocation that 500s because the audit insert failed leaves a compromised key live, which
    // is strictly worse than a gap in the trail.
    const pool = { query: async () => { throw new Error('connection refused'); } };
    await recordAdminAction(pool as never, silent, {
        actorUserId: null, action: 'key_revoked', subject: 'k_x',
    });
});
