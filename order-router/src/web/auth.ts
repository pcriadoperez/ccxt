import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db/pool.js';

// Password hashing for HUMAN logins. This is the opposite call from API keys, deliberately, and the
// reasoning belongs next to the code so nobody "fixes" one into the other:
//
//   API key         256 CSPRNG bits, no dictionary, looked up by digest over N keys
//                   -> unsalted SHA-256, because a salt would force an O(N) scan that leaks which
//                      key matched, and there is no offline-guessing threat to defend against.
//   Admin password  ~40 bits, human-chosen, reused across sites, looked up by username (N=1)
//                   -> salted scrypt, because offline guessing is the entire threat and the O(N)
//                      objection has no occupant.
//
// N=16384, NOT 2**15: on Node 22 the default maxmem is 32 MiB and 128*N*r at N=2**15 is exactly
// 33,554,432 — one byte over — so scryptSync throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Verified on
// v22.22.1, where N=16384 costs ~22ms.
export const SCRYPT_N = 16384;

export function hashPassword (password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
    return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword (password: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    if (!Number.isInteger(n) || n < 1024 || n > SCRYPT_N) return false;
    const salt = Buffer.from(parts[2]!, 'base64url');
    const expected = Buffer.from(parts[3]!, 'base64url');
    const derived = scryptSync(password, salt, expected.length, { N: n, r: 8, p: 1 });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// Session tokens are 256 CSPRNG bits, so the stored form is a bare digest for the same reason API
// keys are: the lookup must stay a single hash and a single index hit.
export const SESSION_COOKIE = '__Host-router_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
    id: string;
    email: string;
    isAdmin: boolean;
}

export function newSessionToken (): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken (token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createSession (
    pool: Pool, userId: string, ip: string | undefined, userAgent: string | undefined,
): Promise<string> {
    const token = newSessionToken();
    await pool.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
         VALUES ($1, $2, now() + interval '12 hours', $3, $4)`,
        [hashToken(token), userId, ip ?? null, userAgent ?? null],
    );
    return token;
}

export async function loadSession (pool: Pool, token: string | undefined): Promise<SessionUser | undefined> {
    if (token === undefined || token.length === 0) return undefined;
    const { rows } = await pool.query<{ id: string; email: string; is_admin: boolean }>(
        `SELECT u.id, u.email, u.is_admin
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token)],
    );
    const row = rows[0];
    // is_admin is read from `users` on every request rather than cached in the cookie, so revoking
    // admin takes effect immediately instead of at the next login.
    return row === undefined ? undefined : { id: row.id, email: row.email, isAdmin: row.is_admin };
}

export async function destroySession (pool: Pool, token: string | undefined): Promise<void> {
    if (token === undefined) return;
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export function setSessionCookie (reply: FastifyReply, token: string, secure: boolean): void {
    // __Host- requires Secure and Path=/ and forbids Domain, which is what makes the cookie
    // unforgeable by a sibling subdomain. Behind plain http (local development) the prefix cannot
    // be used at all, so the name degrades with it rather than silently failing to be set.
    const name = secure ? SESSION_COOKIE : 'router_session';
    const attrs = [
        `${name}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    void reply.header('set-cookie', attrs.join('; '));
}

export function clearSessionCookie (reply: FastifyReply, secure: boolean): void {
    const name = secure ? SESSION_COOKIE : 'router_session';
    void reply.header('set-cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export function readCookie (request: FastifyRequest, name: string): string | undefined {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return undefined;
}

// CSRF. SameSite=Lax is a layer, not the control — it does not cover every browser or every
// navigation shape, and it silently provides nothing between ports on the same host. Every
// mutating request carries a token derived from the session, compared in constant time.
export function csrfToken (sessionToken: string, secret: string): string {
    return createHash('sha256').update(`${sessionToken}:${secret}`, 'utf8').digest('base64url');
}

export function csrfOk (supplied: unknown, sessionToken: string | undefined, secret: string): boolean {
    if (typeof supplied !== 'string' || sessionToken === undefined) return false;
    const expected = csrfToken(sessionToken, secret);
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

// Origin check, as the second CSRF leg. A cross-site form POST carries an Origin the browser sets
// and script cannot forge.
export function originOk (request: FastifyRequest, allowed: string[]): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== 'string') return true;   // same-origin navigations may omit it
    return allowed.some((a) => origin === a);
}
