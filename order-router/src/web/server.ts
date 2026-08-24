import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Pool } from '../db/pool.js';
import { generateKey, hashKey } from '../api/keyStore.js';
import { projectKeys } from '../db/keyProjection.js';
import {
    hashPassword, verifyPassword, createSession, loadSession, destroySession,
    setSessionCookie, clearSessionCookie, readCookie, csrfToken, csrfOk, originOk,
    SESSION_COOKIE, type SessionUser,
} from './auth.js';
import { page, esc } from './views/layout.js';
import { homePage } from './views/home.js';
import { signupPage, loginPage } from './views/auth.js';
import { dashboardPage, adminPage, type KeyRow, type UsageBucket } from './views/dashboard.js';

const STATIC_DIR = fileURLToPath(new URL('./public', import.meta.url));
const CONTENT_DIR = fileURLToPath(new URL('./content', import.meta.url));
const SPEC_PATH = fileURLToPath(new URL('./public/openapi.yaml', import.meta.url));

export interface WebOptions {
    pool: Pool;
    logger: Logger;
    // Path prefix this app is mounted under, e.g. '/router'. Every generated link and form action
    // goes through it, so moving the site to its own domain is a one-value change rather than a
    // find-and-replace through every template.
    base: string;
    keysFile: string;
    csrfSecret: string;
    secureCookies: boolean;
    allowedOrigins: string[];
    signupsPerHour?: number;
}

function readContent (name: string): string {
    try {
        return readFileSync(`${CONTENT_DIR}/${name}`, 'utf8');
    } catch {
        return '<section class="doc-section"><p>This page is being written.</p></section>';
    }
}

// A freshly-minted key is shown exactly once, and getting it to that render is the one moment the
// plaintext exists outside the caller's clipboard. It must not travel in a URL: a query string is
// written to the nginx access log, kept in browser history, and sent to any third party the page
// links to via the Referer header — this page links to github.com, so that is not hypothetical.
// (Measured: the first version of this leaked a live key into /var/log/nginx/access.log.)
//
// It must not go in the database either. The entire design stores keys only as digests; writing the
// plaintext to a sessions row, even briefly, would be the one place a leak of that table yielded a
// usable credential.
//
// So: the plaintext is held in memory in this process, behind a single-use 128-bit id bound to the
// session, for two minutes. The id may appear in a log; it is worthless after one read.
interface Reveal { key: string; sessionToken: string; expires: number }

export async function buildWebServer (opts: WebOptions) {
    const { pool, logger, base, keysFile, csrfSecret, secureCookies } = opts;
    const reveals = new Map<string, Reveal>();
    const REVEAL_TTL_MS = 120_000;

    const stashReveal = (key: string, sessionToken: string): string => {
        const id = randomBytes(16).toString('base64url');
        reveals.set(id, { key, sessionToken, expires: Date.now() + REVEAL_TTL_MS });
        return id;
    };
    const takeReveal = (id: string | undefined, sessionToken: string | undefined): string | undefined => {
        if (id === undefined || sessionToken === undefined) return undefined;
        const entry = reveals.get(id);
        reveals.delete(id);                       // single use, whatever the outcome
        if (entry === undefined || entry.expires < Date.now()) return undefined;
        // Bound to the session that created it, so a leaked id is useless to anyone else.
        return entry.sessionToken === sessionToken ? entry.key : undefined;
    };
    // Unread reveals would otherwise accumulate for the life of the process.
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [id, entry] of reveals) if (entry.expires < now) reveals.delete(id);
    }, 60_000);
    sweeper.unref();
    const app = Fastify({ loggerInstance: logger, trustProxy: true });

    await app.register(formbody);
    await app.register(rateLimit, {
        max: 300,
        timeWindow: 60_000,
        keyGenerator: (r) => r.ip,
    });
    await app.register(fastifyStatic, { root: STATIC_DIR, prefix: `${base}/static/` });

    // Resolve the session once per request. `isAdmin` comes from the users table on every request
    // rather than from the cookie, so removing admin takes effect immediately.
    const sessionOf = async (request: { headers: Record<string, unknown> }): Promise<{
        token: string | undefined; user: SessionUser | undefined;
    }> => {
        const token = readCookie(request as never, SESSION_COOKIE)
            ?? readCookie(request as never, 'router_session');
        return { token, user: await loadSession(pool, token) };
    };

    const guard = (supplied: unknown, token: string | undefined, request: never): string | undefined => {
        if (!originOk(request, opts.allowedOrigins)) return 'Request origin not allowed.';
        if (!csrfOk(supplied, token, csrfSecret)) return 'Your session expired. Please try again.';
        return undefined;
    };

    // ---- public pages ---------------------------------------------------------

    app.get(`${base}/`, async (request, reply) => {
        const { user } = await sessionOf(request as never);
        void reply.type('text/html');
        return homePage(base, user);
    });

    for (const [path, file, title, active] of [
        [`${base}/docs`, 'docs-traders.html', 'Docs — CCXT Router', 'docs'],
        [`${base}/docs/api`, 'docs-developers.html', 'API reference — CCXT Router', 'api'],
    ] as const) {
        app.get(path, async (request, reply) => {
            const { user } = await sessionOf(request as never);
            void reply.type('text/html');
            return page({ title, base, user, active }, `
<div class="wrap docs">
  <aside>
    <div class="grp">
      <div class="grp-title">Guides</div>
      <a href="${esc(base)}/docs"${active === 'docs' ? ' aria-current="page"' : ''}>For traders</a>
      <a href="${esc(base)}/docs/api"${active === 'api' ? ' aria-current="page"' : ''}>API reference</a>
    </div>
    <div class="grp">
      <div class="grp-title">Start</div>
      <a href="${esc(base)}/signup">Get an API key</a>
    </div>
  </aside>
  <div class="doc-body">${readContent(file)}</div>
</div>`);
        });
    }

    // ---- signup / login -------------------------------------------------------

    app.get(`${base}/signup`, async (request, reply) => {
        const { token } = await sessionOf(request as never);
        void reply.type('text/html');
        return signupPage(base, csrfToken(token ?? 'anon', csrfSecret));
    });

    app.get(`${base}/login`, async (request, reply) => {
        const { token } = await sessionOf(request as never);
        void reply.type('text/html');
        return loginPage(base, csrfToken(token ?? 'anon', csrfSecret));
    });

    app.post<{ Body: { email?: string; password?: string; csrf?: string } }>(
        `${base}/signup`,
        { config: { rateLimit: { max: opts.signupsPerHour ?? 10, timeWindow: 3_600_000 } } },
        async (request, reply) => {
            const { token } = await sessionOf(request as never);
            void reply.type('text/html');
            const fail = (msg: string) => signupPage(base, csrfToken(token ?? 'anon', csrfSecret), msg);

            const bad = guard(request.body.csrf, token ?? 'anon', request as never);
            if (bad !== undefined) return fail(bad);

            const email = (request.body.email ?? '').trim().toLowerCase();
            const password = request.body.password ?? '';
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('That does not look like an email address.');
            if (password.length < 12) return fail('Password must be at least 12 characters.');

            const userId = randomUUID();
            try {
                await pool.query(
                    `INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, $3, 'beta')`,
                    [userId, email, hashPassword(password)],
                );
            } catch (err) {
                if ((err as { code?: string }).code === '23505') {
                    return fail('An account with that email already exists.');
                }
                throw err;
            }

            // Issue the first key immediately. The whole point of the funnel is landing page to a
            // working curl without a second step.
            const plaintext = await mintKey(pool, keysFile, userId, 'default', logger);
            const sessionToken = await createSession(pool, userId, request.ip, request.headers['user-agent']);
            setSessionCookie(reply, sessionToken, secureCookies);
            logger.info({ email, userId }, 'signup');
            void reply.redirect(`${base}/dashboard?reveal=${stashReveal(plaintext, sessionToken)}`);
            return reply;
        },
    );

    app.post<{ Body: { email?: string; password?: string; csrf?: string } }>(
        `${base}/login`,
        { config: { rateLimit: { max: 20, timeWindow: 900_000 } } },
        async (request, reply) => {
            const { token } = await sessionOf(request as never);
            void reply.type('text/html');
            const fail = () => loginPage(base, csrfToken(token ?? 'anon', csrfSecret),
                // One message for every failure: distinguishing "no such account" from "wrong
                // password" hands an attacker a free account-enumeration oracle.
                'Email or password is incorrect.');

            const bad = guard(request.body.csrf, token ?? 'anon', request as never);
            if (bad !== undefined) return loginPage(base, csrfToken(token ?? 'anon', csrfSecret), bad);

            const email = (request.body.email ?? '').trim().toLowerCase();
            const { rows } = await pool.query<{ id: string; password_hash: string }>(
                'SELECT id, password_hash FROM users WHERE email = $1', [email],
            );
            const row = rows[0];
            if (row === undefined || !verifyPassword(request.body.password ?? '', row.password_hash)) {
                return fail();
            }
            // A fresh session id at authentication, never the pre-login one — otherwise an
            // attacker who can set a cookie plants an id and inherits the authenticated session.
            const sessionToken = await createSession(pool, row.id, request.ip, request.headers['user-agent']);
            await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
            setSessionCookie(reply, sessionToken, secureCookies);
            void reply.redirect(`${base}/dashboard`);
            return reply;
        },
    );

    app.post(`${base}/logout`, async (request, reply) => {
        const { token } = await sessionOf(request as never);
        await destroySession(pool, token);
        clearSessionCookie(reply, secureCookies);
        void reply.redirect(`${base}/`);
        return reply;
    });

    // ---- dashboard ------------------------------------------------------------

    app.get<{ Querystring: { reveal?: string } }>(`${base}/dashboard`, async (request, reply) => {
        const { token, user } = await sessionOf(request as never);
        if (user === undefined) { void reply.redirect(`${base}/login`); return reply; }
        void reply.type('text/html');
        return dashboardPage({
            base, user, csrf: csrfToken(token!, csrfSecret),
            keys: await keysFor(pool, user.id),
            buckets: await bucketsFor(pool, user.id),
            recent: await recentRoutes(pool, user.id),
            newKey: takeReveal(request.query.reveal, token),
        });
    });

    app.post<{ Body: { name?: string; csrf?: string } }>(`${base}/dashboard/keys`, async (request, reply) => {
        const { token, user } = await sessionOf(request as never);
        if (user === undefined) { void reply.redirect(`${base}/login`); return reply; }
        const bad = guard(request.body.csrf, token, request as never);
        if (bad !== undefined) { void reply.redirect(`${base}/dashboard`); return reply; }
        const name = (request.body.name ?? '').trim().slice(0, 40) || 'default';
        const plaintext = await mintKey(pool, keysFile, user.id, name, logger);
        void reply.redirect(`${base}/dashboard?reveal=${stashReveal(plaintext, token!)}`);
        return reply;
    });

    app.post<{ Body: { displayId?: string; csrf?: string } }>(`${base}/dashboard/revoke`, async (request, reply) => {
        const { token, user } = await sessionOf(request as never);
        if (user === undefined) { void reply.redirect(`${base}/login`); return reply; }
        const bad = guard(request.body.csrf, token, request as never);
        if (bad === undefined) {
            // Scoped by user_id from the SESSION, never from the request — this is the whole
            // authz boundary, and taking the owner from the form would be a textbook IDOR.
            await pool.query(
                'UPDATE api_keys SET revoked_at = now() WHERE display_id = $1 AND user_id = $2 AND revoked_at IS NULL',
                [request.body.displayId ?? '', user.id],
            );
            await projectKeys(pool, keysFile, logger);
        }
        void reply.redirect(`${base}/dashboard`);
        return reply;
    });

    // ---- admin ----------------------------------------------------------------

    const requireAdmin = async (request: never, reply: never): Promise<SessionUser | undefined> => {
        const { user } = await sessionOf(request);
        if (user?.isAdmin !== true) {
            // 404, not 403: a non-admin learns nothing about whether the route exists.
            void (reply as { code: (n: number) => { send: (b: unknown) => void } }).code(404)
                .send({ error: 'not found' });
            return undefined;
        }
        return user;
    };

    app.get(`${base}/admin`, async (request, reply) => {
        const user = await requireAdmin(request as never, reply as never);
        if (user === undefined) return reply;
        const { token } = await sessionOf(request as never);
        void reply.type('text/html');
        return adminPage({
            base, user, csrf: csrfToken(token!, csrfSecret),
            users: (await pool.query<{
                email: string; plan: string; is_admin: boolean; created_at: Date;
                keys: number; requests: number;
            }>(`
                SELECT u.email, u.plan, u.is_admin, u.created_at,
                       (SELECT count(*) FROM api_keys k WHERE k.user_id = u.id) AS keys,
                       coalesce((SELECT sum(h.requests) FROM usage_hour h
                                  WHERE h.user_id = u.id AND h.hour_start > now() - interval '7 days'), 0) AS requests
                  FROM users u ORDER BY u.created_at DESC`)).rows.map((r) => ({
                email: r.email,
                plan: r.plan,
                isAdmin: r.is_admin,
                createdAt: r.created_at.toISOString(),
                keys: Number(r.keys),
                requests: Number(r.requests),
            })),
            keys: (await pool.query<DbKeyRow>(`
                SELECT k.display_id, k.name, k.last4, k.created_at, k.revoked_at, k.rate_limit_max,
                       u.email AS owner,
                       coalesce((SELECT sum(h.requests) FROM usage_hour h
                                  WHERE h.key_id = k.id AND h.hour_start > now() - interval '7 days'), 0) AS requests,
                       (SELECT max(r.ts) FROM requests r WHERE r.key_id = k.id) AS last_used
                  FROM api_keys k JOIN users u ON u.id = k.user_id
                 ORDER BY k.created_at DESC`)).rows.map(mapKeyRow),
            buckets: await bucketsFor(pool, undefined),
            topRoutes: (await pool.query<{ route: string; requests: number; avg_ms: number }>(`
                SELECT route, sum(requests) AS requests, sum(duration_sum)/greatest(sum(requests),1) AS avg_ms
                  FROM usage_hour WHERE hour_start > now() - interval '7 days'
                 GROUP BY route ORDER BY requests DESC LIMIT 8`)).rows.map((r) => ({
                route: r.route,
                requests: Number(r.requests),
                avgMs: Number(r.avg_ms),
            })),
            topVenues: (await pool.query<{ exchange_id: string; legs: number }>(`
                SELECT exchange_id, count(*) AS legs FROM request_legs
                 WHERE ts > now() - interval '7 days'
                 GROUP BY exchange_id ORDER BY legs DESC LIMIT 8`)).rows.map((r) => ({
                exchange: r.exchange_id,
                legs: Number(r.legs),
            })),
        });
    });

    app.post<{ Body: { displayId?: string; csrf?: string } }>(`${base}/admin/revoke`, async (request, reply) => {
        const user = await requireAdmin(request as never, reply as never);
        if (user === undefined) return reply;
        const { token } = await sessionOf(request as never);
        const bad = guard(request.body.csrf, token, request as never);
        if (bad === undefined) {
            await pool.query(
                'UPDATE api_keys SET revoked_at = now() WHERE display_id = $1 AND revoked_at IS NULL',
                [request.body.displayId ?? ''],
            );
            await projectKeys(pool, keysFile, logger);
            logger.warn({ actor: user.email, key: request.body.displayId }, 'admin revoked a key');
        }
        void reply.redirect(`${base}/admin`);
        return reply;
    });

    // The spec, served for download and for import into Postman/Insomnia/codegen. Read from disk
    // per request rather than cached, so a redeploy publishes the new contract without a restart.
    app.get(`${base}/openapi.yaml`, async (_request, reply) => {
        void reply
            .type('application/yaml; charset=utf-8')
            .header('content-disposition', 'attachment; filename="ccxt-router-openapi.yaml"');
        return readFileSync(SPEC_PATH, 'utf8');
    });

    app.get(`${base}/health`, async () => ({ status: 'ok' }));
    app.addHook('onClose', async () => { clearInterval(sweeper); });
    return app;
}

// ---- data access --------------------------------------------------------------

interface DbKeyRow {
    display_id: string; name: string; last4: string; created_at: Date;
    revoked_at: Date | null; rate_limit_max: number | null; requests: number;
    last_used: Date | null; owner?: string;
}

function mapKeyRow (row: DbKeyRow): KeyRow & { owner: string } {
    return {
        displayId: row.display_id,
        name: row.name,
        last4: row.last4,
        createdAt: row.created_at.toISOString(),
        revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
        rateLimitMax: row.rate_limit_max,
        requests: Number(row.requests),
        lastUsed: row.last_used === null ? null : row.last_used.toISOString(),
        owner: row.owner ?? '',
    };
}

async function keysFor (pool: Pool, userId: string): Promise<KeyRow[]> {
    const { rows } = await pool.query<DbKeyRow>(`
        SELECT k.display_id, k.name, k.last4, k.created_at, k.revoked_at, k.rate_limit_max,
               coalesce((SELECT sum(h.requests) FROM usage_hour h
                          WHERE h.key_id = k.id AND h.hour_start > now() - interval '7 days'), 0) AS requests,
               (SELECT max(r.ts) FROM requests r WHERE r.key_id = k.id) AS last_used
          FROM api_keys k WHERE k.user_id = $1 ORDER BY k.created_at DESC`, [userId]);
    return rows.map(mapKeyRow);
}

async function bucketsFor (pool: Pool, userId: string | undefined): Promise<UsageBucket[]> {
    // A fixed 7-day window of hourly buckets, gap-filled, so the sparkline shows quiet periods as
    // quiet rather than compressing them out of existence.
    const { rows } = await pool.query<{ hour: Date; requests: number }>(`
        SELECT g.hour, coalesce(sum(h.requests), 0) AS requests
          FROM generate_series(date_trunc('hour', now()) - interval '167 hours',
                               date_trunc('hour', now()), interval '1 hour') AS g(hour)
          LEFT JOIN usage_hour h ON h.hour_start = g.hour
               AND ($1::uuid IS NULL OR h.user_id = $1::uuid)
         GROUP BY g.hour ORDER BY g.hour`, [userId ?? null]);
    return rows.map((r) => ({ hour: r.hour.toISOString(), requests: Number(r.requests) }));
}

async function recentRoutes (pool: Pool, userId: string) {
    const { rows } = await pool.query<{
        ts: Date; from_asset: string; to_asset: string; hop_count: number;
        impact_bps: number | null; status: number; fully_fillable: boolean | null;
    }>(`
        SELECT ts, from_asset, to_asset, hop_count, impact_bps, status, fully_fillable
          FROM requests WHERE user_id = $1 AND from_asset IS NOT NULL
         ORDER BY ts DESC LIMIT 15`, [userId]);
    return rows.map((row) => {
        return {
            ts: row.ts.toISOString(),
            pair: `${row.from_asset} → ${row.to_asset}`,
            hops: row.hop_count,
            impactBps: row.impact_bps === null ? null : Number(row.impact_bps),
            status: row.status,
            fullyFillable: row.fully_fillable,
        };
    });
}

async function mintKey (
    pool: Pool, keysFile: string, userId: string, name: string, logger: Logger,
): Promise<string> {
    const plaintext = generateKey();
    const id = randomUUID();
    // Derived from the row's uuid rather than generated separately, so it inherits that uniqueness
    // instead of being another short value with no collision check.
    const displayId = `k_${id.replace(/-/g, '').slice(0, 12)}`;
    let finalName = name;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            await pool.query(
                `INSERT INTO api_keys (id, display_id, user_id, name, hash, last4, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,'dashboard')`,
                [id, displayId, userId, finalName, hashKey(plaintext), plaintext.slice(-4)],
            );
            break;
        } catch (err) {
            // (user_id, name) is unique, and a duplicate name is a user typo rather than an error
            // worth a page of its own.
            if ((err as { code?: string }).code === '23505' && attempt < 19) {
                finalName = `${name}-${attempt + 2}`;
                continue;
            }
            throw err;
        }
    }
    // Project immediately so the key works by the time the user has copied it, rather than waiting
    // for the next scheduled projection.
    await projectKeys(pool, keysFile, logger);
    return plaintext;
}
