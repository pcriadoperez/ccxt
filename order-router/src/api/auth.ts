import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ApiKeyRecord, ApiKeyStore } from './keyStore.js';

// Hardcoded development default. Deliberately a well-known, obviously-fake value so that running
// unconfigured is safe-by-obviousness rather than safe-by-accident: it grants no security at all,
// and the server logs a loud warning when it is in use. It is loaded as a synthetic k_dev record
// and suppressed the moment a real key file row or ORDER_ROUTER_API_KEY exists.
export const DEV_API_KEY = 'dev-local-key-change-me';

// Paths served without authentication. Only liveness and readiness: orchestrators (k8s, ECS,
// compose healthchecks) probe these before any credential is injectable, and they expose nothing
// but process uptime and a boolean. Everything else — including /exchanges/status, which leaks
// the venue list — requires a key.
//
// /ready deliberately reports COUNTS and no venue names. "142 books, 3 of them stale" tells an
// orchestrator everything it needs and an attacker nothing about which venues are carried.
const PUBLIC_PATHS = new Set(['/health', '/ready']);

export function isPublicPath (url: string): boolean {
    // Strip query string before matching so `/health?x=1` can't be used to smuggle a path, and
    // so a protected path can't be disguised as a public one via a query fragment.
    const path = url.split('?')[0] ?? '';
    return PUBLIC_PATHS.has(path);
}

// safeCompare() used to live here. It is deliberately GONE rather than left unused: its
// constant-time property is now provided structurally by the store's hash-then-Map.get lookup, and
// leaving an unreferenced crypto helper in the tree invites a future caller to reach for the
// per-record-compare pattern it enables — which is O(N) and leaks the matching key's position.

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

// Resolves the presented key to a record ONCE per request. Five consumers need it — the rate
// limiter's keyGenerator, its per-key max(), this hook, the not-found handler, and the WS handler —
// and each would otherwise pay its own digest.
export function resolveKey (store: ApiKeyStore, request: FastifyRequest): ApiKeyRecord | undefined {
    // childLoggerFactory runs first for every request and has already resolved the key onto the raw
    // request; reuse that rather than paying a second digest per consumer.
    const raw = request.raw as { apiKeyRecord?: ApiKeyRecord | null };
    if (raw.apiKeyRecord !== undefined) {
        return raw.apiKeyRecord ?? undefined;
    }
    const req = request as FastifyRequest & { apiKeyResolved?: boolean; apiKeyRecord?: ApiKeyRecord | null };
    if (req.apiKeyResolved !== true) {
        const presented = extractApiKey(request.headers as Record<string, unknown>);
        req.apiKeyRecord = presented === undefined ? null : (store.lookup(presented) ?? null);
        req.apiKeyResolved = true;
    }
    return req.apiKeyRecord ?? undefined;
}

// Fastify preValidation hook — NOT onRequest, and the position is load-bearing twice over.
// @fastify/rate-limit attaches its check as a ROUTE-level onRequest hook, and route-level onRequest
// hooks run after every instance-level one; auth at onRequest therefore short-circuited every 401
// before the limiter could count it, making brute force unlimited (measured: 30 wrong-key requests
// against a limit of 10 returned 401x30, never 429). Separately, a rejection at onRequest sets
// reply.sent and halts the chain before @fastify/websocket's own onRequest hook runs, so
// request.ws is never set and its cleanup no-ops on a socket Node has already handed off — which
// leaked ~1,700 FDs/sec. preValidation runs after the whole onRequest chain and avoids both.
export function makeAuthHook (store: ApiKeyStore) {
    return async function authHook (request: FastifyRequest, reply: FastifyReply): Promise<void> {
        if (isPublicPath(request.url)) {
            return;
        }
        // An UNMATCHED path is deliberately left to setNotFoundHandler. This hook is instance-level
        // preValidation, which runs before any route-level hook — so rejecting here short-circuited
        // the not-found route's own preHandler chain, and with it the rate limiter attached to it.
        // Measured: 500 wrong-key requests to invented paths returned 500x401 with zero 429s, i.e.
        // an unmetered "is this key valid?" oracle at ~2,600 guesses/sec, and the probes left the
        // real routes' budget untouched. The not-found handler performs the identical check behind
        // the limiter instead.
        if (request.routeOptions?.url === undefined) {
            return;
        }
        if (resolveKey(store, request) === undefined) {
            // Missing, unknown and REVOKED are all one response — no oracle for whether a key was
            // ever real, which matters more now that keys have a lifecycle.
            await reply.code(401).send({ error: 'unauthorized' });
        }
    };
}
