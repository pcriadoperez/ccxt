import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import fastifyPlugin from 'fastify-plugin';
import type { Logger } from 'pino';
import { config } from '../config.js';
import { auditLogger as moduleAuditLogger } from '../logger.js';
import type { OrderBookCache } from '../cache/orderBookCache.js';
import type { FeeRegistry } from '../cache/feeRegistry.js';
import { computeRoute } from '../routing/route.js';
import { candidatePairs } from '../routing/market.js';
import { parseRouteQuery, type RouteQuery } from './routeQuery.js';
import { randomUUID } from 'node:crypto';
import { extractApiKey, isPublicPath, makeAuthHook, resolveKey } from './auth.js';
import { ApiKeyStore } from './keyStore.js';
import { buildHttpHistogram, buildMetricsRegistry } from '../metrics.js';
import { LoopRegistry } from '../cache/loopRegistry.js';

// Above this many bytes still queued for the peer, a stream frame is dropped rather than added to
// the backlog. A router quote is only useful while it is current, so the newest frame the client
// can actually receive beats a faithful replay of every stale one.
const WS_MAX_BUFFERED_BYTES = 1_000_000;

export interface ServerOptions {
    // Overrides for the module-level config defaults. Injected rather than read from the global
    // config so tests can exercise the real middleware chain at a low limit without mutating
    // process env (config.ts snapshots env at import time, so env mutation can't reach it).
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
    wsMaxConnectionsPerKey?: number;
    wsIdleTimeoutMs?: number;
    wsMinPushIntervalMs?: number;
    trustProxy?: boolean;
    // Injected so tests can drive a real multi-key store without touching the filesystem. In
    // production src/index.ts builds it, loads it, and starts its reload poll.
    keyStore?: ApiKeyStore;
    // Where the audit records go. Defaults to the dedicated audit stream in production, and to the
    // injected logger when no audit file is configured — so a caller that supplies a logger still
    // receives the audit trail rather than silently losing it to a module-level destination.
    auditLogger?: Logger;
}

export async function buildServer (
    cache: OrderBookCache,
    feeRegistry: FeeRegistry,
    logger: Logger,
    options: ServerOptions = {},
    loopRegistry: LoopRegistry = new LoopRegistry(),
) {
    // trustProxy makes request.ip read X-Forwarded-For instead of the socket address. Required for
    // the limiter's IP bucketing to mean anything behind nginx; dangerous if enabled without a
    // proxy that overwrites the header (see config.ts). Off by default.
    // The store is the single source of truth for who may call. Built here only as a fallback so
    // the existing test and dev entry points keep working unchanged.
    // The level override matters wherever the audit trail shares a logger with diagnostics: the
    // production box runs LOG_LEVEL=warn because a misbehaving exchange once wrote 930MB of retry
    // chatter, and quieting that must not also silence the record of who called what.
    const audit = options.auditLogger
        ?? (config.auditLogFile === undefined
            ? logger.child({}, { level: config.auditLogLevel })
            : moduleAuditLogger);
    const store = options.keyStore ?? new ApiKeyStore(
        config.keysFile, logger, process.env['NODE_ENV'] !== 'production');
    if (options.keyStore === undefined) store.load();

    const app = Fastify({
        loggerInstance: logger,
        // trustProxy makes request.ip read X-Forwarded-For instead of the socket address. Required
        // for the limiter's IP bucketing to mean anything behind nginx; dangerous if enabled
        // without a proxy that overwrites the header (see config.ts). Off by default.
        trustProxy: options.trustProxy ?? config.trustProxy,

        // Honour a caller-supplied x-request-id so their trace id and ours match. Charset- and
        // length-capped: pino JSON-escapes so this is not log injection, but an unbounded
        // caller-controlled string on every log line is not something to hand out. Minting here
        // rather than inside /route means EVERY request has one, and pino puts it on every line.
        genReqId: (req) => {
            const supplied = req.headers['x-request-id'];
            return (typeof supplied === 'string' && /^[\w.\-]{1,200}$/.test(supplied))
                ? supplied
                : randomUUID();
        },

        // Binding key identity here rather than in a hook means every line for the request carries
        // it — including Fastify's own "incoming request" and "request completed" — with no extra
        // lifecycle surface. keyId: null on an unauthenticated request is deliberate: it makes
        // failed-auth traffic greppable as a first-class thing rather than as an absent field.
        childLoggerFactory (rootLogger, bindings, opts, rawReq) {
            // Resolved here and stashed on the RAW request, which resolveKey() also reads — so the
            // key is digested once per request rather than once per consumer, and lastUsedAt is
            // stamped once.
            const presented = extractApiKey(rawReq.headers as Record<string, unknown>);
            const record = presented === undefined ? undefined : store.lookup(presented);
            (rawReq as { apiKeyRecord?: unknown }).apiKeyRecord = record ?? null;
            return rootLogger.child({
                ...bindings,
                keyId: record?.id ?? null,
                keyName: record?.name ?? null,
                // Explicitly levelled so the audit trail survives LOG_LEVEL. A child may be more
                // verbose than its parent in pino, which is exactly what is wanted here: turning
                // down connector noise must not turn off the record of who called what.
            }, { ...opts, level: config.auditLogLevel });
        },
    });

    const rateLimitMax = options.rateLimitMax ?? config.rateLimitMax;
    const rateLimitWindowMs = options.rateLimitWindowMs ?? config.rateLimitWindowMs;
    const wsMaxConnectionsPerKey = options.wsMaxConnectionsPerKey ?? config.wsMaxConnectionsPerKey;
    const wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? config.wsIdleTimeoutMs;
    const wsMinPushIntervalMs = options.wsMinPushIntervalMs ?? config.wsMinPushIntervalMs;
    // Live count of open stream sockets per key id, enforcing the per-key cap.
    const wsConnectionsByKey = new Map<string, number>();
    // The sockets themselves, so revoking a key can close its live feeds rather than letting them
    // run until the client disconnects or the heartbeat reaps them.
    const wsSocketsByKey = new Map<string, Set<{ close: (code: number, reason: string) => void }>>();
    // Rate limiting runs ahead of auth (see the preValidation note below for why that ordering is
    // not automatic), so unauthenticated brute-force attempts consume budget rather than probing
    // the key comparison without limit.
    await app.register(rateLimit, {
        // Per-key override where the record sets one, the global default otherwise.
        max: (request) => resolveKey(store, request)?.rateLimitMax ?? rateLimitMax,
        timeWindow: rateLimitWindowMs,
        // Bucket by API key ONLY when the key is actually valid, so one legitimate client can't
        // consume another's budget and NAT'd clients aren't collectively throttled. Everything
        // else — wrong key, absent key — buckets by IP.
        //
        // Bucketing unconditionally on the caller-supplied header is the trap: an attacker just
        // rotates the header per request, mints a fresh bucket every time, and brute-forces keys
        // without ever being throttled. It is also an unbounded-memory vector, since each distinct
        // attacker-chosen value would allocate its own counter.
        // Buckets by the stable key ID, never by the secret: the secret then never becomes a key
        // in the limiter's LRU (heap dumps, core dumps), and a client's bucket survives a future
        // key rotation. The prefixes stop an `x-api-key: 1.2.3.4` from ever colliding with an IP
        // bucket.
        keyGenerator: (request) => {
            const record = resolveKey(store, request);
            return record !== undefined ? `key:${record.id}` : `ip:${request.ip}`;
        },
        // Liveness probes must never be throttled — a throttled /health reads as an outage to an
        // orchestrator and would trigger pod restarts under exactly the load where that's worst.
        allowList: (request) => isPublicPath(request.url),
        addHeaders: {
            'x-ratelimit-limit': true,
            'x-ratelimit-remaining': true,
            'x-ratelimit-reset': true,
            'retry-after': true,
        },
    });

    // Auth runs at preValidation, NOT onRequest. @fastify/rate-limit attaches its check as a
    // per-route hook, and route-level onRequest hooks run *after* all instance-level onRequest
    // hooks — so an instance-level auth hook lands ahead of the limiter no matter what order the
    // two are registered in. That silently inverts the intended order: every 401 short-circuits
    // before the limiter counts it, leaving API key brute-force entirely unthrottled while
    // authenticated traffic still appears correctly limited. preValidation runs after the whole
    // onRequest chain, so the limiter fires first and failed auth consumes budget.
    // Verified empirically, and regression-tested in server.test.ts.
    const authHook = makeAuthHook(store);
    await app.register(fastifyPlugin(async (instance) => {
        instance.addHook('preValidation', authHook);
    }, { name: 'order-router-auth' }));

    // preValidation only runs for *matched* routes, so without this an unknown path would 404
    // before auth ever ran — handing an unauthenticated caller a 404-vs-401 oracle for
    // enumerating which routes exist. Re-checking auth here keeps unknown paths indistinguishable
    // from protected ones for anyone without a key, while still giving authenticated callers a
    // truthful 404 for a genuine typo.
    // The rate limiter MUST be attached explicitly here. @fastify/rate-limit works through an
    // onRoute hook, and an unmatched URL has no route — so without this the 401 below runs with no
    // budget consumed anywhere, reopening the exact regression the preValidation ordering exists to
    // prevent, through a second door. Measured before this line existed: 500 wrong-key requests to
    // an invented path returned 500x401 in 191ms with zero 429s and no x-ratelimit headers, then a
    // subsequent request to a real route still had a full budget. Because the handler answers 401
    // for an invalid key and 404 for a valid one, that was also an unmetered "is this key valid?"
    // oracle at ~2,600 guesses/sec.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the plugin's hook is typed
    // against Fastify's default logger, not this instance's pino type; the cast is only about that.
    app.setNotFoundHandler({ preHandler: app.rateLimit() as any }, async (request, reply) => {
        if (!isPublicPath(request.url) && resolveKey(store, request) === undefined) {
            return reply.code(401).send({ error: 'unauthorized' });
        }
        return reply.code(404).send({ error: 'not found' });
    });

    await app.register(websocketPlugin);

    // Revocation has to reach sockets that already authenticated. A stream authenticates ONCE, at
    // upgrade, so without this a revoked key keeps its live quote feed until the client hangs up or
    // the heartbeat reaps it — which is not what an operator killing a key means. On every reload,
    // any socket whose key is no longer active is closed with 1008.
    store.onReload(() => {
        for (const [keyId, sockets] of wsSocketsByKey) {
            if (store.hasActiveId(keyId)) continue;
            for (const socket of sockets) {
                try {
                    socket.close(1008, 'key revoked');
                } catch {
                    // Already closing; the socket's own close handler does the bookkeeping.
                }
            }
            logger.warn({ keyId, sockets: sockets.size }, 'closed live streams for a revoked key');
        }
    });

    // Total open /stream/best sockets across all keys, for the gauge.
    const countWsConnections = () => {
        let total = 0;
        for (const n of wsConnectionsByKey.values()) total += n;
        return total;
    };
    const metricsRegistry = buildMetricsRegistry({
        cache,
        staleBookMs: config.staleBookMs,
        getWsConnectionCount: countWsConnections,
        loopRegistry,
    });
    const httpDuration = buildHttpHistogram(metricsRegistry);

    app.addHook('onResponse', async (request, reply) => {
        // Label with the ROUTE TEMPLATE, never the raw URL: /orderbook/:exchange/:symbol has tens
        // of thousands of concrete values across the routable universe, and one series per symbol
        // would blow up Prometheus cardinality. Unmatched requests collapse to a single bucket.
        const route = request.routeOptions?.url ?? 'unmatched';
        httpDuration.observe(
            { method: request.method, route, status_code: String(reply.statusCode) },
            reply.elapsedTime / 1000,
        );
        // The access line — one per request, folded into this existing hook so it adds no new
        // lifecycle surface. This is what actually answers "show me every request key X made":
        // the /route audit record only covers routing recommendations, while this covers
        // /orderbook, /symbols, /metrics, 401s and 404s too. keyId/keyName arrive via the child
        // logger, so they are on this line without being restated.
        const record = resolveKey(store, request);
        // Written to the audit stream with every field restated rather than inherited from the
        // child logger. This is the row an invoice or a "why was I charged for that?" is settled
        // from; it has to be readable on its own, by an ingester that has no idea what a Fastify
        // child logger is.
        audit.info({
            event: 'request',
            reqId: String(request.id),
            keyId: record?.id ?? null,
            keyName: record?.name ?? null,
            keyUuid: record?.keyUuid ?? null,
            userId: record?.userId ?? null,
            method: request.method,
            route,
            statusCode: reply.statusCode,
            durationMs: reply.elapsedTime,
            ip: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
            origin: request.headers['origin'] ?? null,
        }, 'request completed');
    });

    app.get('/health', async () => ({ status: 'ok', uptimeSec: process.uptime() }));

    // Authenticated like every other non-health route: it exposes the venue list, traffic volume
    // and internal health, which is exactly the reconnaissance an attacker wants. Scrapers must
    // send the API key. Not added to PUBLIC_PATHS for that reason.
    app.get('/metrics', async (_request, reply) => {
        reply.header('content-type', metricsRegistry.contentType);
        return metricsRegistry.metrics();
    });

    app.get('/exchanges/status', async () => ({ exchanges: cache.getHealth() }));

    app.get('/symbols', async () => ({ symbols: cache.listSymbols() }));

    app.get<{ Params: { exchange: string; symbol: string } }>(
        '/orderbook/:exchange/:symbol',
        async (request, reply) => {
            const { exchange, symbol } = request.params;
            const decodedSymbol = decodeURIComponent(symbol);
            const book = cache.getBook(exchange, decodedSymbol);
            if (!book) {
                reply.code(404);
                return { error: `no cached order book for ${exchange}:${decodedSymbol}` };
            }
            return book;
        },
    );

    // Asset-to-asset addressing. The caller says what they hold and what they want; the router
    // picks the market, the side, and — when no direct market exists — the bridge. Callers never
    // have to know that USDT->BTC is a *buy* of BTC/USDT while BTC->USDT is a *sell* of the same
    // pair, which is the single most error-prone part of the old symbol+side contract.
    app.get<{ Querystring: RouteQuery }>(
        '/route',
        async (request, reply) => {
            // Honour a caller-supplied x-request-id so their trace id and ours match in both
            // logs; otherwise mint one. Echoed as a header too, so a client can correlate even
            // on responses it fails to parse.
            // Minted by genReqId, so it exists on every request and on every log line as reqId.
            // The echo header and the caller-supplied honouring are preserved.
            const requestId = String(request.id);
            reply.header('x-request-id', requestId);

            const parsed = parseRouteQuery(request.query, requestId);
            if (!parsed.ok) {
                reply.code(400);
                return { error: parsed.error };
            }

            const result = computeRoute(cache, feeRegistry, parsed.req, parsed.opts);

            // Audit record: one line per recommendation, keyed by requestId. This is the trail
            // that makes a future billing dispute or "why did you route it there?" answerable
            // after the fact, so it logs the decision and its inputs, not just the outcome.
            audit.info({
                // A stable event name so queries grep on a field rather than a message string.
                event: 'route_recommendation',
                // reqId, under exactly the name the access line uses. The two events describe one
                // request and the ingester pairs them on this field; naming it differently here
                // silently produced request rows with no routing detail at all.
                reqId: requestId,
                keyUuid: resolveKey(store, request)?.keyUuid ?? null,
                userId: resolveKey(store, request)?.userId ?? null,
                // Restated explicitly rather than relying on the child bindings: this is the record
                // a billing or "why did you route it there?" dispute is settled from, and it should
                // be self-contained.
                keyId: resolveKey(store, request)?.id ?? null,
                keyName: resolveKey(store, request)?.name ?? null,
                requestId,
                calculatedAt: result.calculatedAt,
                from: result.from, to: result.to, exactSide: result.exactSide,
                requestedAmount: result.requestedAmount,
                strategy: result.strategy, includeFees: result.includeFees,
                maxVenues: parsed.opts.maxVenues, minLegNotional: parsed.opts.minLegNotional,
                exchangesFilter: result.exchangesFilter, certifiedOnly: result.certifiedOnly,
                bridges: parsed.req.bridges,
                hops: result.hops.map((h) => ({
                    pair: h.pair, side: h.side, in: h.amountIn, out: h.amountOut,
                    legs: h.legs.map((l) => ({ ex: l.exchangeId, amt: l.amount, eff: l.effectivePrice })),
                    fee: h.feeCost, feeCcy: h.feeCurrency, fresh: h.freshVenueCount, impactBps: h.impactBps,
                })),
                // The losing candidates, so "why this market?" is answerable after the fact — the
                // same reason quotes[] makes "why this venue?" answerable.
                pathsConsidered: result.pathsConsidered.map((p) => ({
                    pairs: p.pairs, out: p.amountOut, score: p.score, chosen: p.chosen,
                })),
                amountIn: result.amountIn, amountOut: result.amountOut,
                effectiveRate: result.effectiveRate, referenceRate: result.referenceRate,
                impactBps: result.impactBps,
                fullyFillable: result.fullyFillable, fillRatio: result.fillRatio,
                savingVsBestSingleBps: result.savingVsBestSingleBps,
                unroutableReason: result.unroutableReason,
                unroutableHopIndex: result.unroutableHopIndex,
                requireFullFill: parsed.opts.requireFullFill,
                stalenessPenaltyBps: result.stalenessPenaltyBps,
                hopPenaltyBps: result.hopPenaltyBps,
                staleBookMs: result.staleBookMs,
            }, 'route recommendation');

            if (result.unroutableReason === 'no_market') {
                // No pair and no bridge path exists at all — that is a request-level problem the
                // caller must fix (wrong ticker, unsupported asset), not an empty market result.
                reply.code(404);
            } else if (result.unroutableReason === 'exact_out_multi_hop_unsupported') {
                // The request is well-formed and the path exists; the router just cannot solve
                // this shape yet. 501 rather than 400 (nothing to correct in the syntax) and
                // rather than 404 (the assets ARE reachable) — the caller's move is to re-ask
                // with amountIn, which the body's unroutableReason names.
                reply.code(501);
            }
            return result;
        },
    );

    // The same route, recomputed and pushed whenever any market it depends on moves. Takes the
    // identical query parameters as GET /route and answers with the identical body — a caller
    // switching from polling to streaming changes the URL and nothing else.
    app.get<{ Querystring: RouteQuery }>(
        '/stream/route',
        { websocket: true },
        (socket, request) => {
            const parsed = parseRouteQuery(request.query, randomUUID(), { includeQuotes: false });
            if (!parsed.ok) {
                socket.send(JSON.stringify({ error: parsed.error }));
                socket.close(1008, 'invalid request');
                return;
            }
            const { req, opts } = parsed;

            const pairsNow = () => candidatePairs(cache, req.from, req.to, req.bridges);
            if (pairsNow().length === 0) {
                // Nothing to subscribe to means no update could ever arrive; holding the socket
                // open would be a silent hang rather than an answer.
                socket.send(JSON.stringify({
                    error: `no market or bridge path exists between ${req.from} and ${req.to}`,
                    unroutableReason: 'no_market',
                }));
                socket.close(1008, 'no_market');
                return;
            }

            // Refused for the same reason GET /route answers 501: exact-out across hops needs a
            // backwards solve that does not exist yet. Accepting here would mean the streaming
            // endpoint takes a request its REST twin rejects, which is exactly the drift the
            // shared parser exists to prevent.
            const first = computeRoute(cache, feeRegistry, req, opts);
            if (first.unroutableReason === 'exact_out_multi_hop_unsupported') {
                socket.send(JSON.stringify({
                    error: 'exact-out is not supported over a bridged route; re-ask with amountIn',
                    unroutableReason: first.unroutableReason,
                }));
                socket.close(1008, 'exact_out_multi_hop_unsupported');
                return;
            }

            // Cap concurrent streams per key. Rate limiting bounds how fast connections open, not
            // how many stay open, and each one costs a cache listener per watched market plus
            // recomputation on every update to any of them. Counted per key so one client cannot
            // starve another.
            // Auth already passed at preValidation, so a record is guaranteed here. Keying the
            // bookkeeping by record.id rather than by the presented secret means the map is no
            // longer indexed by a live credential, and a client's slot survives key rotation.
            const record = resolveKey(store, request);
            const connectionKey = record?.id ?? 'unknown';
            const cap = record?.wsMaxConnections ?? wsMaxConnectionsPerKey;
            const openForKey = wsConnectionsByKey.get(connectionKey) ?? 0;
            if (openForKey >= cap) {
                socket.send(JSON.stringify({
                    error: `too many concurrent stream connections (limit ${cap})`,
                }));
                socket.close(1013, 'connection limit reached');
                return;
            }
            wsConnectionsByKey.set(connectionKey, openForKey + 1);
            // A long-lived socket otherwise produces exactly zero access-log lines despite being
            // the most expensive thing a key can do.
            const openedAt = Date.now();
            request.log.info({
                event: 'stream_open', keyId: record?.id ?? null, keyName: record?.name ?? null,
                from: req.from, to: req.to, amountIn: req.amountIn ?? null, amountOut: req.amountOut ?? null,
            }, 'stream opened');
            // Revoking a key must not leave its live data feed running — "delete a key" is half of
            // what key management is for, and a revocation that leaves a stream open is a gap in
            // that feature rather than a missing extra. Registered before any early return below.
            const socketsForKey = wsSocketsByKey.get(connectionKey) ?? new Set();
            socketsForKey.add(socket);
            wsSocketsByKey.set(connectionKey, socketsForKey);

            const watched = new Set<string>();
            let flushPending = false;
            let lastPushAt = 0;
            let pushTimer: NodeJS.Timeout | undefined;
            // Coalescing per event-loop tick is NOT a rate bound — BTC/USDT alone updates from
            // dozens of venues, so nearly every tick carries one, and this endpoint measured 658
            // frames/sec on a single socket before the floor existed. Leading-edge so the first
            // move after a quiet period is immediate, trailing-edge so the newest state always
            // lands rather than being dropped for being too soon.
            const onUpdate = () => {
                if (flushPending || pushTimer !== undefined) return;
                const wait = lastPushAt + wsMinPushIntervalMs - Date.now();
                if (wait <= 0) {
                    flushPending = true;
                    setImmediate(flush);
                    return;
                }
                pushTimer = setTimeout(() => { pushTimer = undefined; flush(); }, wait);
            };

            // The set of markets that could change this answer is NOT fixed for the life of the
            // socket. computeRoute re-enumerates candidate paths against the live cache on every
            // push, so a market listed after connect can become the winning route — and a watch set
            // frozen at connect would then be quoting a market it is not subscribed to, going silent
            // until some unrelated leg happened to tick and then jumping. Same hazard during normal
            // startup, when connectors populate the cache over several seconds. So the subscription
            // is re-derived rather than captured.
            const syncWatched = () => {
                const want = new Set(pairsNow());
                for (const pair of want) {
                    if (watched.has(pair)) continue;
                    cache.on(`update:${pair}`, onUpdate);
                    watched.add(pair);
                }
                for (const pair of [...watched]) {
                    if (want.has(pair)) continue;
                    cache.off(`update:${pair}`, onUpdate);
                    watched.delete(pair);
                }
            };

            // Push-on-change rather than polling: with N clients x a fixed poll interval, CPU cost
            // scales with N regardless of whether anything changed, which doesn't hold up at
            // scale. A single pending-flush flag coalesces bursts (a fast-moving symbol can emit
            // hundreds of book updates/sec, and a bridged route watches several such symbols) into
            // at most one computed result per event-loop tick.
            function flush () {
                flushPending = false;
                if (socket.readyState !== socket.OPEN) return;
                lastPushAt = Date.now();
                // Drop this frame if the peer is not keeping up. Coalescing bounds how often we
                // COMPUTE, not how fast the client drains, so without this a slow consumer grows
                // the send buffer without limit — the socket-level backpressure this used to claim
                // to rely on does not exist for ws, which buffers instead of blocking.
                if (socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) return;
                // A fresh id per push: each frame is its own recommendation, and an audit trail
                // that reused one id across a long-lived stream could not distinguish them.
                socket.send(JSON.stringify(
                    computeRoute(cache, feeRegistry, req, { ...opts, requestId: randomUUID() })));
                syncWatched();
            }

            // Heartbeat reaper. A socket that dies without a close frame (half-open TCP, suspended
            // client) would otherwise hold its listeners and its slot against the cap forever, so
            // liveness is asserted actively rather than waiting for a close that may never arrive.
            // It doubles as the resubscribe tick: a market appearing in a pair nobody is watching
            // yet cannot wake us on its own, so the watch set is re-derived here too.
            let alive = true;
            socket.on('pong', () => { alive = true; });
            const heartbeat = setInterval(() => {
                if (!alive) {
                    // terminate(), not close(): an unresponsive peer will not complete a closing
                    // handshake, so a graceful close could hang indefinitely.
                    socket.terminate();
                    return;
                }
                alive = false;
                socket.ping();
                const before = watched.size;
                syncWatched();
                if (watched.size !== before) onUpdate();
            }, wsIdleTimeoutMs);

            syncWatched();
            flush();

            // Idempotent: 'close' can fire after terminate(), and releasing twice would corrupt
            // the per-key count and eventually lock a legitimate client out of its own budget.
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                clearInterval(heartbeat);
                if (pushTimer !== undefined) clearTimeout(pushTimer);
                const live = wsSocketsByKey.get(connectionKey);
                if (live !== undefined) {
                    live.delete(socket);
                    if (live.size === 0) wsSocketsByKey.delete(connectionKey);
                }
                request.log.info({
                    event: 'stream_close', keyId: record?.id ?? null, keyName: record?.name ?? null,
                    durationMs: Date.now() - openedAt,
                }, 'stream closed');
                for (const pair of watched) cache.off(`update:${pair}`, onUpdate);
                watched.clear();
                const remaining = (wsConnectionsByKey.get(connectionKey) ?? 1) - 1;
                if (remaining > 0) {
                    wsConnectionsByKey.set(connectionKey, remaining);
                } else {
                    // Delete rather than store 0 — connectionKey is client-supplied, so keeping
                    // empty entries would let key rotation grow this map without bound.
                    wsConnectionsByKey.delete(connectionKey);
                }
            };
            socket.on('close', release);
            socket.on('error', release);
        },
    );

    return app;
}
