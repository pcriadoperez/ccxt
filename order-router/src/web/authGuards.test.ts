import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { buildWebServer } from './server.js';
import { csrfToken, hashPassword, CSRF_COOKIE } from './auth.js';

// Two things the anonymous half of the console got wrong, both of which hand an attacker something
// the signed-in half is careful not to hand them.
//
//  * The token in the /signup and /login forms was derived from the literal string 'anon', so it
//    was one fixed public value for every visitor — computable by anyone who has read this file.
//    That left the Origin header as the only CSRF control on the two routes that create accounts
//    and sessions, and a request with no Origin at all was treated as allowed.
//  * Signup answered "an account with that email already exists", which is exactly the
//    account-enumeration oracle /login refuses to be.

const silent = pino({ level: 'silent' });
const CSRF_SECRET = 'test-csrf-secret';

const dirs: string[] = [];
function tmpKeysFile (): string {
    const dir = mkdtempSync(join(tmpdir(), 'orguard-'));
    dirs.push(dir);
    return join(dir, 'keys.json');
}
process.on('exit', () => {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

interface Call { sql: string; params: unknown[] }

// A pool for the signup route. `existing` is the account already in the users table, if any: the
// INSERT then fails the way Postgres fails it, with SQLSTATE 23505 on the unique index over email.
function signupPool (existing?: { email: string; password: string }): { pool: unknown; calls: Call[] } {
    const calls: Call[] = [];
    const stored = existing === undefined ? undefined : hashPassword(existing.password);
    const pool = {
        query: async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            if (sql.indexOf('INSERT INTO users') !== -1) {
                if (existing !== undefined && params[1] === existing.email) {
                    throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
                }
                return { rows: [], rowCount: 1 };
            }
            if (sql.indexOf('SELECT id, password_hash FROM users') !== -1) {
                if (existing !== undefined && params[0] === existing.email) {
                    return { rows: [{ id: '11111111-1111-4111-8111-111111111111', password_hash: stored }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
            }
            return { rows: [], rowCount: 0 };
        },
    };
    return { pool, calls };
}

async function console_ (pool: unknown, allowedOrigins: string[] = []) {
    return buildWebServer({
        pool: pool as never,
        logger: silent,
        base: '',
        keysFile: tmpKeysFile(),
        csrfSecret: CSRF_SECRET,
        secureCookies: false,
        allowedOrigins,
    });
}

function setCookies (headers: Record<string, unknown>): string[] {
    const raw = headers['set-cookie'];
    if (raw === undefined) return [];
    return Array.isArray(raw) ? raw.map(String) : [ String(raw) ];
}

function csrfFromCookies (headers: Record<string, unknown>): string | undefined {
    for (const c of setCookies(headers)) {
        const m = new RegExp(`^${CSRF_COOKIE}=([^;]*)`).exec(c);
        if (m) return m[1];
    }
    return undefined;
}

function formToken (body: string): string {
    const m = /name="csrf" value="([^"]+)"/.exec(body);
    assert.ok(m, 'the form must carry a csrf token');
    return m![1]!;
}

// ---------------------------------------------------------------------------
// 47: the anonymous CSRF token
// ---------------------------------------------------------------------------

for (const url of [ '/signup', '/login' ]) {
    test(`GET ${url} mints a per-visitor anonymous CSRF cookie`, async () => {
        const { pool } = signupPool();
        const app = await console_(pool);
        const first = await app.inject({ method: 'GET', url });
        const second = await app.inject({ method: 'GET', url });
        const a = csrfFromCookies(first.headers as never);
        const b = csrfFromCookies(second.headers as never);
        assert.ok(a && a.length >= 20, `${url} set no anonymous csrf cookie`);
        assert.ok(b);
        assert.notEqual(a, b, 'two visitors must not share one token');
        assert.notEqual(formToken(first.body), formToken(second.body),
            'the token in the form is what an attacker would have to guess');
        await app.close();
    });

    test(`POST ${url} rejects the old fixed 'anon' token`, async () => {
        // The whole finding in one assertion: the constant is public, so if it still authenticates
        // the form there is no CSRF token on these routes at all.
        const { pool, calls } = signupPool();
        const app = await console_(pool);
        const response = await app.inject({
            method: 'POST', url,
            payload: { email: 'new@b.test', password: 'correct horse battery', csrf: csrfToken('anon', CSRF_SECRET) },
        });
        assert.equal(response.statusCode, 200, 'must not have gone through to a redirect');
        assert.match(response.body, /session expired/i);
        assert.equal(calls.some((c) => c.sql.indexOf('INSERT INTO users') !== -1), false,
            'a forged anonymous token must not be able to create an account');
        await app.close();
    });

    test(`POST ${url} accepts the token only alongside the cookie it was derived from`, async () => {
        const { pool } = signupPool();
        const app = await console_(pool);
        const page = await app.inject({ method: 'GET', url });
        const cookie = csrfFromCookies(page.headers as never)!;
        const token = formToken(page.body);

        // Right token, somebody else's cookie: rejected.
        const mismatched = await app.inject({
            method: 'POST', url, headers: { cookie: `${CSRF_COOKIE}=other-visitor-value` },
            payload: { email: 'new@b.test', password: 'correct horse battery', csrf: token },
        });
        assert.match(mismatched.body, /session expired/i);

        // Its own cookie: accepted, and the route runs to completion.
        const matched = await app.inject({
            method: 'POST', url, headers: { cookie: `${CSRF_COOKIE}=${cookie}` },
            payload: { email: 'new@b.test', password: 'correct horse battery', csrf: token },
        });
        assert.equal(matched.statusCode, url === '/signup' ? 302 : 200);
        assert.equal(/session expired/i.test(matched.body), false);
        await app.close();
    });
}

test('a POST with no Origin but Sec-Fetch-Site saying cross-site is refused', async () => {
    // "No Origin means same-origin navigation" was the rule, so anything that could suppress the
    // header walked straight past the only control these routes had. Sec-Fetch-Site is the
    // browser's own second opinion and it is not suppressible from script.
    const { pool, calls } = signupPool();
    const app = await console_(pool);
    const page = await app.inject({ method: 'GET', url: '/signup' });
    const cookie = csrfFromCookies(page.headers as never)!;
    const token = formToken(page.body);
    for (const site of [ 'cross-site', 'same-site' ]) {
        const response = await app.inject({
            method: 'POST', url: '/signup',
            headers: { cookie: `${CSRF_COOKIE}=${cookie}`, 'sec-fetch-site': site },
            payload: { email: 'new@b.test', password: 'correct horse battery', csrf: token },
        });
        assert.match(response.body, /origin not allowed/i, `sec-fetch-site: ${site} was accepted`);
    }
    assert.equal(calls.some((c) => c.sql.indexOf('INSERT INTO users') !== -1), false);

    // A same-origin form post is still a form post.
    const ok = await app.inject({
        method: 'POST', url: '/signup',
        headers: { cookie: `${CSRF_COOKIE}=${cookie}`, 'sec-fetch-site': 'same-origin' },
        payload: { email: 'new@b.test', password: 'correct horse battery', csrf: token },
    });
    assert.equal(ok.statusCode, 302);
    await app.close();
});

// ---------------------------------------------------------------------------
// 50: signup as an enumeration oracle
// ---------------------------------------------------------------------------

async function signupAs (app: Awaited<ReturnType<typeof buildWebServer>>, email: string, password: string) {
    const page = await app.inject({ method: 'GET', url: '/signup' });
    const cookie = csrfFromCookies(page.headers as never)!;
    return app.inject({
        method: 'POST', url: '/signup', headers: { cookie: `${CSRF_COOKIE}=${cookie}` },
        payload: { email, password, csrf: formToken(page.body) },
    });
}

test('signing up with a taken address does not say the address is taken', async () => {
    const { pool } = signupPool({ email: 'taken@b.test', password: 'the real password' });
    const app = await console_(pool);
    const taken = await signupAs(app, 'taken@b.test', 'a wrong password');
    assert.equal(/already exists/i.test(taken.body), false,
        'one POST per address, no password needed, is precisely the oracle /login refuses to be');
    // The same words /login uses for every failure, so the two forms cannot be played against
    // each other either.
    assert.match(taken.body, /Email or password is incorrect\./);
    await app.close();
});

test('a taken address with the right password signs the user in rather than dead-ending', async () => {
    // The neutral answer has to still be usable: someone who forgot they had an account gets what
    // they came for instead of an error they cannot act on.
    const { pool, calls } = signupPool({ email: 'taken@b.test', password: 'the real password' });
    const app = await console_(pool);
    const response = await signupAs(app, 'taken@b.test', 'the real password');
    assert.equal(response.statusCode, 302);
    assert.match(String(response.headers['location']), /\/dashboard/);
    assert.ok(setCookies(response.headers as never).some((c) => c.indexOf('router_session=') === 0),
        'the response must carry a session');
    assert.ok(calls.some((c) => c.sql.indexOf('INSERT INTO sessions') !== -1));
    await app.close();
});

test('a wrong password against a taken address creates nothing', async () => {
    const { pool, calls } = signupPool({ email: 'taken@b.test', password: 'the real password' });
    const app = await console_(pool);
    await signupAs(app, 'taken@b.test', 'a wrong password');
    assert.equal(calls.some((c) => c.sql.indexOf('INSERT INTO sessions') !== -1), false);
    assert.equal(calls.some((c) => c.sql.indexOf('INSERT INTO api_keys') !== -1), false);
    await app.close();
});
