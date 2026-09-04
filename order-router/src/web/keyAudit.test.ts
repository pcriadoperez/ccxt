import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { buildWebServer } from './server.js';
import { csrfToken } from './auth.js';

// Minting a key and revoking one are the two console actions that create and destroy a credential,
// and neither left any durable trace: admin_audit shipped in the schema and nothing ever wrote to
// it, so "which key was live on the 4th, and who revoked it?" had no answer once the diagnostic log
// rotated. These drive the real routes through a scripted pool and assert the row is written.

const silent = pino({ level: 'silent' });
const SESSION = 'session-token-for-tests';
const CSRF_SECRET = 'test-csrf-secret';
const USER = { id: '22222222-2222-4222-8222-222222222222', email: 'a@b.test', is_admin: true };

const dirs: string[] = [];
function tmpKeysFile (): string {
    const dir = mkdtempSync(join(tmpdir(), 'orkeys-'));
    dirs.push(dir);
    return join(dir, 'keys.json');
}
process.on('exit', () => {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

interface Call { sql: string; params: unknown[] }

// Answers the handful of statements these two routes make, and records them all. Anything not
// recognised comes back empty, which is the right answer for the projection's SELECT.
function scriptedPool (over: { updateRowCount?: number } = {}): { pool: unknown; calls: Call[] } {
    const calls: Call[] = [];
    const pool = {
        query: async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            if (sql.indexOf('FROM sessions s JOIN users u') !== -1) return { rows: [USER], rowCount: 1 };
            if (sql.indexOf('UPDATE api_keys SET revoked_at') !== -1) {
                return { rows: [], rowCount: over.updateRowCount ?? 1 };
            }
            if (sql.indexOf('INSERT INTO api_keys') !== -1) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
    };
    return { pool, calls };
}

async function console_ (pool: unknown) {
    return buildWebServer({
        pool: pool as never,
        logger: silent,
        base: '',
        keysFile: tmpKeysFile(),
        csrfSecret: CSRF_SECRET,
        secureCookies: false,
        allowedOrigins: [],
    });
}

const cookie = `router_session=${SESSION}`;
const csrf = () => csrfToken(SESSION, CSRF_SECRET);

function auditRows (calls: Call[]): Call[] {
    return calls.filter((c) => c.sql.indexOf('INSERT INTO admin_audit') !== -1);
}

test('minting a key writes an admin_audit row naming the actor and the key', async () => {
    const { pool, calls } = scriptedPool();
    const app = await console_(pool);
    const response = await app.inject({
        method: 'POST', url: '/dashboard/keys', headers: { cookie },
        payload: { name: 'acme', csrf: csrf() },
    });
    assert.equal(response.statusCode, 302);
    const audits = auditRows(calls);
    assert.equal(audits.length, 1, 'exactly one audit row per mint');
    assert.equal(audits[0]!.params[0], USER.id, 'the actor is the session user');
    assert.equal(audits[0]!.params[1], 'key_created');
    // The subject is the key's display id — the handle everything else refers to, never the secret.
    assert.match(String(audits[0]!.params[2]), /^k_[0-9a-f]{12}$/);
    const detail = JSON.parse(String(audits[0]!.params[3]));
    assert.equal(detail.name, 'acme');
    assert.equal(detail.via, 'dashboard');
    await app.close();
});

test('revoking a key writes an admin_audit row', async () => {
    const { pool, calls } = scriptedPool();
    const app = await console_(pool);
    await app.inject({
        method: 'POST', url: '/dashboard/revoke', headers: { cookie },
        payload: { displayId: 'k_abc123abc123', csrf: csrf() },
    });
    const audits = auditRows(calls);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.params[1], 'key_revoked');
    assert.equal(audits[0]!.params[2], 'k_abc123abc123');
    await app.close();
});

test('a revocation that changes nothing writes no audit row', async () => {
    // A re-submitted form, or a guessed id belonging to someone else, must not manufacture an
    // entry: an audit trail that records actions that did not happen is worse than a sparse one.
    const { pool, calls } = scriptedPool({ updateRowCount: 0 });
    const app = await console_(pool);
    await app.inject({
        method: 'POST', url: '/dashboard/revoke', headers: { cookie },
        payload: { displayId: 'k_not_mine0000', csrf: csrf() },
    });
    assert.equal(auditRows(calls).length, 0);
    await app.close();
});

test('an admin revoking someone else’s key is recorded distinctly from a self-revocation', async () => {
    const { pool, calls } = scriptedPool();
    const app = await console_(pool);
    await app.inject({
        method: 'POST', url: '/admin/revoke', headers: { cookie },
        payload: { displayId: 'k_someoneelse', csrf: csrf() },
    });
    const audits = auditRows(calls);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.params[1], 'key_revoked_by_admin',
        'an admin acting on another account is not the same event as a user revoking their own key');
    assert.equal(JSON.parse(String(audits[0]!.params[3])).actorEmail, USER.email);
    await app.close();
});

test('a CSRF-rejected revocation writes neither the revocation nor an audit row', async () => {
    const { pool, calls } = scriptedPool();
    const app = await console_(pool);
    await app.inject({
        method: 'POST', url: '/dashboard/revoke', headers: { cookie },
        payload: { displayId: 'k_abc123abc123', csrf: 'wrong' },
    });
    assert.equal(calls.some((c) => c.sql.indexOf('UPDATE api_keys') !== -1), false);
    assert.equal(auditRows(calls).length, 0);
    await app.close();
});

// The session token the routes see is hashed before the lookup; this asserts the fixture above is
// actually exercising a signed-in path rather than passing because everything redirects to /login.
test('the fixture really is authenticated', async () => {
    const { pool, calls } = scriptedPool();
    const app = await console_(pool);
    await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } });
    const lookup = calls.find((c) => c.sql.indexOf('FROM sessions s JOIN users u') !== -1);
    assert.ok(lookup, 'the session lookup should have run');
    assert.equal(lookup!.params[0], createHash('sha256').update(SESSION, 'utf8').digest('hex'));
    await app.close();
});

test('a secure deployment honours only the __Host- cookie', async () => {
    // The non-prefixed name was accepted in both modes, which defeats the prefix: the browser
    // enforces Secure/Path=/no-Domain on `__Host-` cookies, so a sibling subdomain that can set a
    // plain `router_session` could hand this app a session name it honoured.
    const { pool, calls } = scriptedPool();
    const app = await buildWebServer({
        pool: pool as never, logger: silent, base: '', keysFile: tmpKeysFile(),
        csrfSecret: CSRF_SECRET, secureCookies: true, allowedOrigins: [],
    });
    await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `router_session=${SESSION}` } });
    assert.equal(calls.some((c) => c.sql.indexOf('FROM sessions s JOIN users u') !== -1), false,
        'the plain cookie must not even be looked up under secure cookies');

    await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `__Host-router_session=${SESSION}` } });
    assert.ok(calls.some((c) => c.sql.indexOf('FROM sessions s JOIN users u') !== -1),
        'the prefixed cookie is the session in a secure deployment');
    await app.close();
});

test('a plain-http deployment honours only the un-prefixed cookie', async () => {
    // The prefix cannot be used without TLS, so there the fallback name IS the name — and the
    // prefixed one, which no browser would have set here, is not a session.
    const { pool, calls } = scriptedPool();
    const app = await console_(pool);
    await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `__Host-router_session=${SESSION}` } });
    assert.equal(calls.some((c) => c.sql.indexOf('FROM sessions s JOIN users u') !== -1), false);
    await app.close();
});
