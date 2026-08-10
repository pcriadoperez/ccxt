import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

// Hardcoded development default. This is deliberately a well-known, obviously-fake value so that
// running unconfigured is safe-by-obviousness rather than safe-by-accident: it grants no security
// at all, and the server logs a loud warning when it's in use. Production MUST set
// ORDER_ROUTER_API_KEY. See README "Security" — this is a stopgap for a not-yet-public service,
// not an auth system (no rotation, no per-client keys, no revocation, no scopes).
export const DEV_API_KEY = 'dev-local-key-change-me';

// Paths served without authentication. Only liveness: orchestrators (k8s, ECS, compose
// healthchecks) probe this before any credential is injectable, and it exposes nothing but
// process uptime. Everything else — including /exchanges/status, which leaks the venue list —
// requires a key.
const PUBLIC_PATHS = new Set(['/health']);

export function isPublicPath (url: string): boolean {
    // Strip query string before matching so `/health?x=1` can't be used to smuggle a path, and
    // so a protected path can't be disguised as a public one via a query fragment.
    const path = url.split('?')[0] ?? '';
    return PUBLIC_PATHS.has(path);
}

// Compares via fixed-length SHA-256 digests. timingSafeEqual throws on length mismatch, and
// comparing raw strings would leak key length (and, with ===, the common prefix) through timing.
// Digesting first makes both sides always 32 bytes, so the comparison is constant-time with
// respect to both the length and content of the supplied value.
export function safeCompare (a: string, b: string): boolean {
    const digestA = createHash('sha256').update(a, 'utf8').digest();
    const digestB = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(digestA, digestB);
}

// Accepts either `X-API-Key: <key>` or `Authorization: Bearer <key>`. Two forms because MCP and
// HTTP clients differ in which they can set conveniently; both are equivalent.
export function extractApiKey (headers: Record<string, unknown>): string | undefined {
    const headerKey = headers['x-api-key'];
    if (typeof headerKey === 'string' && headerKey.length > 0) {
        return headerKey;
    }
    const authorization = headers['authorization'];
    if (typeof authorization === 'string') {
        const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
        if (match?.[1]) {
            return match[1];
        }
    }
    return undefined;
}

export function resolveApiKey (): { apiKey: string; isDefault: boolean } {
    const configured = process.env['ORDER_ROUTER_API_KEY'];
    if (configured && configured.length > 0) {
        return { apiKey: configured, isDefault: false };
    }
    return { apiKey: DEV_API_KEY, isDefault: true };
}

// Fastify onRequest hook. Runs before routing/body parsing so an unauthenticated caller can't
// reach any handler or spend parse cycles.
export function makeAuthHook (expectedApiKey: string) {
    return async function authHook (request: FastifyRequest, reply: FastifyReply): Promise<void> {
        if (isPublicPath(request.url)) {
            return;
        }
        const provided = extractApiKey(request.headers as Record<string, unknown>);
        if (provided === undefined || !safeCompare(provided, expectedApiKey)) {
            // Deliberately does not distinguish "missing" from "wrong" — no oracle for probing.
            await reply.code(401).send({ error: 'unauthorized' });
        }
    };
}
