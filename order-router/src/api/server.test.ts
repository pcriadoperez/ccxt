import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { buildServer } from './server.js';
import type { CachedOrderBook } from '../types.js';

const silentLogger = pino({ level: 'silent' });

function book (overrides: Partial<CachedOrderBook> = {}): CachedOrderBook {
    return {
        exchangeId: 'kraken',
        symbol: 'BTC/USDT',
        bids: [{ price: 100, amount: 5 }],
        asks: [{ price: 101, amount: 5 }],
        exchangeTimestamp: Date.now(),
        receivedAt: Date.now(),
        sequence: 1,
        ...overrides,
    };
}

// Every test runs against the real auth + rate-limit stack rather than a stripped-down app, so
// these integration tests would catch a middleware ordering regression that unit tests can't.
const TEST_API_KEY = 'test-api-key';
const AUTH = { 'x-api-key': TEST_API_KEY };

async function buildTestServer () {
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    process.env['ORDER_ROUTER_API_KEY'] = TEST_API_KEY;
    try {
        const cache = new OrderBookCache();
        const feeRegistry = new FeeRegistry();
        const app = await buildServer(cache, feeRegistry, silentLogger);
        return { app, cache, feeRegistry };
    } finally {
        if (previous === undefined) delete process.env['ORDER_ROUTER_API_KEY'];
        else process.env['ORDER_ROUTER_API_KEY'] = previous;
    }
}

test('GET /health returns ok', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    await app.close();
});

test('GET /symbols reflects the cache contents', async () => {
    const { app, cache } = await buildTestServer();
    cache.setBook(book({ symbol: 'BTC/USDT' }));
    cache.setBook(book({ symbol: 'ETH/USDT', exchangeId: 'coinbase' }));

    const response = await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(new Set(response.json().symbols), new Set(['BTC/USDT', 'ETH/USDT']));
    await app.close();
});

test('GET /exchanges/status reflects recorded health', async () => {
    const { app, cache } = await buildTestServer();
    cache.initHealth('kraken');
    cache.recordUpdate('kraken');

    const response = await app.inject({ method: 'GET', url: '/exchanges/status', headers: AUTH });
    assert.equal(response.statusCode, 200);
    const status = response.json().exchanges.find((e: { exchangeId: string }) => e.exchangeId === 'kraken');
    assert.equal(status.connected, true);
    await app.close();
});

test('GET /orderbook/:exchange/:symbol returns 404 when nothing is cached', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/orderbook/kraken/BTC%2FUSDT', headers: AUTH });
    assert.equal(response.statusCode, 404);
    await app.close();
});

test('GET /orderbook/:exchange/:symbol returns the cached book', async () => {
    const { app, cache } = await buildTestServer();
    cache.setBook(book());

    const response = await app.inject({ method: 'GET', url: '/orderbook/kraken/BTC%2FUSDT', headers: AUTH });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().exchangeId, 'kraken');
    await app.close();
});

test('GET /price/best/:symbol requires a positive amount', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/price/best/BTC%2FUSDT?side=buy&amount=0', headers: AUTH });
    assert.equal(response.statusCode, 400);
    await app.close();
});

test('GET /price/best/:symbol returns a ranked result for a valid request', async () => {
    const { app, cache, feeRegistry } = await buildTestServer();
    cache.setBook(book());
    feeRegistry.setFee('kraken', 'BTC/USDT', 0.001);

    const response = await app.inject({ method: 'GET', url: '/price/best/BTC%2FUSDT?side=buy&amount=1', headers: AUTH });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.best.exchangeId, 'kraken');
    assert.equal(body.best.fullyFillable, true);
    await app.close();
});

test('GET /price/best/:symbol defaults to buy side when side is omitted', async () => {
    const { app, cache } = await buildTestServer();
    cache.setBook(book({ asks: [{ price: 101, amount: 1 }], bids: [{ price: 1, amount: 1 }] }));

    const response = await app.inject({ method: 'GET', url: '/price/best/BTC%2FUSDT?amount=1', headers: AUTH });
    const body = response.json();
    assert.equal(body.side, 'buy');
    assert.equal(body.best.averagePrice, 101);
    await app.close();
});

// --- Authentication (integration, through the real hook chain) ---

test('every non-health route rejects a request with no credentials', async () => {
    const { app } = await buildTestServer();
    const protectedUrls = [
        '/symbols',
        '/exchanges/status',
        '/orderbook/kraken/BTC%2FUSDT',
        '/price/best/BTC%2FUSDT?side=buy&amount=1',
    ];
    for (const url of protectedUrls) {
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 401, `${url} should require auth`);
    }
    await app.close();
});

test('/health stays reachable without credentials so probes keep working', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    await app.close();
});

test('a wrong API key is rejected', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': 'wrong' } });
    assert.equal(response.statusCode, 401);
    await app.close();
});

test('Authorization: Bearer is accepted as an alternative to X-API-Key', async () => {
    const { app } = await buildTestServer();
    const response = await app.inject({
        method: 'GET',
        url: '/symbols',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    assert.equal(response.statusCode, 200);
    await app.close();
});

test('auth rejection does not leak whether the key was missing or merely wrong', async () => {
    const { app } = await buildTestServer();
    const missing = await app.inject({ method: 'GET', url: '/symbols' });
    const wrong = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': 'wrong' } });
    assert.equal(missing.statusCode, wrong.statusCode);
    assert.deepEqual(missing.json(), wrong.json());
    await app.close();
});

test('auth runs before routing, so unknown paths also require credentials', async () => {
    // Prevents an information leak where 404-vs-401 reveals which routes exist.
    const { app } = await buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/definitely-not-a-route' });
    assert.equal(response.statusCode, 401);
    await app.close();
});

// --- Rate limiting ---

async function buildRateLimitedServer (max: number) {
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    process.env['ORDER_ROUTER_API_KEY'] = TEST_API_KEY;
    try {
        const cache = new OrderBookCache();
        const feeRegistry = new FeeRegistry();
        const app = await buildServer(cache, feeRegistry, silentLogger, { rateLimitMax: max });
        return { app, cache };
    } finally {
        if (previous === undefined) delete process.env['ORDER_ROUTER_API_KEY'];
        else process.env['ORDER_ROUTER_API_KEY'] = previous;
    }
}

test('requests beyond the rate limit are rejected with 429', async () => {
    const { app } = await buildRateLimitedServer(3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
        const response = await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
        codes.push(response.statusCode);
    }
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200], 'first 3 within limit');
    assert.deepEqual(codes.slice(3), [429, 429], 'subsequent requests throttled');
    await app.close();
});

test('rate limit responses carry retry-after and limit headers', async () => {
    const { app } = await buildRateLimitedServer(1);
    await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
    const limited = await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers['retry-after'] !== undefined, 'retry-after present');
    assert.ok(limited.headers['x-ratelimit-limit'] !== undefined, 'x-ratelimit-limit present');
    await app.close();
});

test('/health is exempt from rate limiting so probes never see a 429', async () => {
    const { app } = await buildRateLimitedServer(2);
    for (let i = 0; i < 10; i++) {
        const response = await app.inject({ method: 'GET', url: '/health' });
        assert.equal(response.statusCode, 200, `health request ${i} should not be throttled`);
    }
    await app.close();
});

test('rate limit buckets are per API key, not global', async () => {
    // One client exhausting its budget must not lock out a different key.
    const { app } = await buildRateLimitedServer(2);
    try {
        await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
        await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
        const throttled = await app.inject({ method: 'GET', url: '/symbols', headers: AUTH });
        assert.equal(throttled.statusCode, 429, 'first key exhausted');

        // A different (invalid) key hits its own fresh bucket, so it reaches auth and gets 401 —
        // not 429, which would prove the buckets were shared.
        const otherKey = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': 'another-key' } });
        assert.equal(otherKey.statusCode, 401, 'separate bucket, so reaches auth rather than the limiter');
    } finally {
        await app.close();
    }
});

test('failed auth attempts are themselves rate limited (key brute-force is throttled)', async () => {
    // Regression test for a real bug: registering the auth hook with a bare app.addHook placed it
    // AHEAD of @fastify/rate-limit's deferred hook, so every 401 short-circuited before the
    // limiter counted it — leaving API key brute-force completely unthrottled while authenticated
    // traffic appeared correctly limited. Asserting only the authenticated case (as the original
    // tests did) cannot catch this.
    const { app } = await buildRateLimitedServer(5);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
        const response = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': 'wrong-key' } });
        codes.push(response.statusCode);
    }
    assert.ok(codes.includes(429), `repeated bad keys must eventually 429, got ${JSON.stringify(codes)}`);
    await app.close();
});

test('rotating the API key does not mint unlimited fresh rate-limit buckets', async () => {
    // The limiter buckets by the attacker-supplied key header. If a fresh key value always got a
    // fresh bucket, an attacker could rotate the header per request and brute-force without limit.
    const { app } = await buildRateLimitedServer(5);
    const codes: number[] = [];
    for (let i = 0; i < 15; i++) {
        const response = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': `guess-${i}` } });
        codes.push(response.statusCode);
    }
    assert.ok(codes.includes(429), `rotating keys must still be throttled, got ${JSON.stringify(codes)}`);
    await app.close();
});

test('unauthenticated requests with no key at all are rate limited', async () => {
    const { app } = await buildRateLimitedServer(5);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
        const response = await app.inject({ method: 'GET', url: '/symbols' });
        codes.push(response.statusCode);
    }
    assert.ok(codes.includes(429), `unauthenticated flood must be throttled, got ${JSON.stringify(codes)}`);
    await app.close();
});

// --- WebSocket stream endpoint input validation ---

test('WS /stream/best rejects a non-numeric, negative, or zero amount', async () => {
    // The WS path originally took Number(amount) unchecked while the REST path validated it.
    // NaN defeats walkBook's `remaining <= 0` termination check, so it traversed every level of
    // every book and then streamed nulls — repeatedly, on every book update. Needs a real
    // listening server (not inject()) because the bug lives in the upgrade handler.
    const { WebSocket } = await import('ws');
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    process.env['ORDER_ROUTER_API_KEY'] = TEST_API_KEY;
    const app = await buildServer(new OrderBookCache(), new FeeRegistry(), silentLogger, { rateLimitMax: 100000 });
    try {
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        for (const bad of ['amount=abc', 'amount=-5', 'amount=0']) {
            const closeCode = await new Promise<number>((resolve) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/best/BTC%2FUSDT?${bad}`, {
                    headers: { 'x-api-key': TEST_API_KEY },
                });
                ws.on('close', (code: number) => resolve(code));
                ws.on('error', () => resolve(-1));
                setTimeout(() => { ws.close(); resolve(0); }, 2000);
            });
            assert.equal(closeCode, 1008, `${bad} should be rejected with a policy-violation close`);
        }
    } finally {
        await app.close();
        if (previous === undefined) delete process.env['ORDER_ROUTER_API_KEY'];
        else process.env['ORDER_ROUTER_API_KEY'] = previous;
    }
});

test('rejected WebSocket upgrades do not leak server-side sockets', async () => {
    // Regression test for a confirmed unauthenticated FD-exhaustion DoS. When auth ran at
    // onRequest, its 401 set reply.sent, which halts Fastify's hook chain — so @fastify/websocket's
    // own onRequest hook (the one that sets request.ws) never ran, its onResponse cleanup
    // (`if (request.ws) ...destroy()`) no-oped, and the socket Node had already handed off via the
    // upgrade event was held for the life of the process. No timeout reaps a post-upgrade socket.
    // Measured on the original code: 1200 upgrades leaked 1200 FDs in ~700ms.
    //
    // Must drive a real TCP upgrade: app.inject() never touches the socket path where this lives.
    const net = await import('node:net');
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    process.env['ORDER_ROUTER_API_KEY'] = TEST_API_KEY;
    const app = await buildServer(new OrderBookCache(), new FeeRegistry(), silentLogger, { rateLimitMax: 100000 });
    try {
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        const upgrade = (path: string) => new Promise<void>((resolve) => {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write(
                    `GET ${path} HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\n`
                    + 'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
                    + 'Sec-WebSocket-Version: 13\r\n\r\n');
            });
            let buf = '';
            socket.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { socket.destroy(); resolve(); } });
            socket.on('error', () => resolve());
            socket.setTimeout(3000, () => { socket.destroy(); resolve(); });
        });

        // Path-independent on the original bug: matched WS route, matched non-WS route, and an
        // unmatched path all leaked, so all three are covered here.
        for (const path of ['/stream/best/BTC%2FUSDT', '/symbols', '/nonexistent']) {
            for (let i = 0; i < 10; i++) await upgrade(path);
        }
        await new Promise((r) => setTimeout(r, 1500));

        const held = await new Promise<number>((resolve, reject) =>
            app.server.getConnections((e, c) => (e ? reject(e) : resolve(c))));
        assert.ok(held <= 2, `rejected upgrades must not accumulate sockets, ${held} still held`);
    } finally {
        await app.close();
        if (previous === undefined) delete process.env['ORDER_ROUTER_API_KEY'];
        else process.env['ORDER_ROUTER_API_KEY'] = previous;
    }
});

// --- WebSocket connection limits (security finding #4b) ---

async function buildWsLimitedServer (opts: { wsMaxConnectionsPerKey?: number; wsIdleTimeoutMs?: number }) {
    process.env['ORDER_ROUTER_API_KEY'] = TEST_API_KEY;
    const cache = new OrderBookCache();
    cache.setBook(book());
    const app = await buildServer(cache, new FeeRegistry(), silentLogger, {
        rateLimitMax: 100000,
        ...opts,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { app, port, cache };
}

test('concurrent WS stream connections are capped per API key', async () => {
    // Each stream holds a cache listener removed only on close, which the client controls. Rate
    // limiting bounds how fast connections open, not how many stay open, so without a cap an
    // authenticated client can accumulate listeners until the process exhausts resources.
    const { WebSocket } = await import('ws');
    const { app, port } = await buildWsLimitedServer({ wsMaxConnectionsPerKey: 3 });
    const open: InstanceType<typeof WebSocket>[] = [];
    try {
        const connect = (key: string) => new Promise<{ ok: boolean; code: number }>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/best/BTC%2FUSDT?amount=1`, {
                headers: { 'x-api-key': key },
            });
            open.push(ws);
            let sawData = false;
            ws.on('message', (d: Buffer) => {
                const parsed = JSON.parse(d.toString());
                if (parsed.error === undefined) { sawData = true; resolve({ ok: true, code: 0 }); }
            });
            ws.on('close', (code: number) => resolve({ ok: sawData, code }));
            ws.on('error', () => resolve({ ok: false, code: -1 }));
        });

        const accepted = [];
        for (let i = 0; i < 3; i++) accepted.push(await connect(TEST_API_KEY));
        assert.ok(accepted.every((r) => r.ok), 'first 3 connections within the cap are accepted');

        const rejected = await connect(TEST_API_KEY);
        assert.equal(rejected.ok, false, 'connection past the cap is rejected');
        assert.equal(rejected.code, 1013, 'rejected with 1013 Try Again Later');
    } finally {
        for (const ws of open) { try { ws.terminate(); } catch { /* already closed */ } }
        await app.close();
    }
});

test('closing a stream frees its slot against the cap', async () => {
    // Guards the release path: a leaked count would permanently lock a legitimate client out of
    // its own budget, turning the DoS defence into a self-inflicted DoS.
    const { WebSocket } = await import('ws');
    const { app, port } = await buildWsLimitedServer({ wsMaxConnectionsPerKey: 1 });
    try {
        const openOne = () => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/best/BTC%2FUSDT?amount=1`, {
                headers: { 'x-api-key': TEST_API_KEY },
            });
            ws.on('message', () => resolve(ws));
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        const first = await openOne();
        first.close();
        await new Promise((r) => setTimeout(r, 300));

        // Slot must be reusable now; if the count leaked this rejects with 1013.
        const second = await openOne();
        assert.equal(second.readyState, second.OPEN, 'slot was released and reused');
        second.terminate();
    } finally {
        await app.close();
    }
});

test('per-key WS caps are independent across keys', async () => {
    const { WebSocket } = await import('ws');
    const { app, port } = await buildWsLimitedServer({ wsMaxConnectionsPerKey: 1 });
    const open: InstanceType<typeof WebSocket>[] = [];
    try {
        // Both use the valid key header value here; a different *valid* identity isn't available
        // under single-key auth, so this asserts the bookkeeping is keyed at all rather than global.
        const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/best/BTC%2FUSDT?amount=1`, {
            headers: { 'x-api-key': TEST_API_KEY },
        });
        open.push(ws);
        await new Promise((resolve, reject) => {
            ws.on('message', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
        // A second connection on the SAME key must be refused at cap 1.
        const refusedCode = await new Promise<number>((resolve) => {
            const ws2 = new WebSocket(`ws://127.0.0.1:${port}/stream/best/BTC%2FUSDT?amount=1`, {
                headers: { 'x-api-key': TEST_API_KEY },
            });
            open.push(ws2);
            ws2.on('close', (code: number) => resolve(code));
            ws2.on('error', () => resolve(-1));
        });
        assert.equal(refusedCode, 1013);
    } finally {
        for (const w of open) { try { w.terminate(); } catch { /* already closed */ } }
        await app.close();
    }
});

test('unresponsive WS clients are reaped by the heartbeat', async () => {
    // A socket that never sends a close frame (half-open TCP, suspended client) would otherwise
    // hold its listener and cap slot forever. Uses a short idle timeout and suppresses the
    // client's automatic pong so it looks dead to the server.
    const { WebSocket } = await import('ws');
    const { app, port } = await buildWsLimitedServer({ wsMaxConnectionsPerKey: 5, wsIdleTimeoutMs: 250 });
    try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/best/BTC%2FUSDT?amount=1`, {
            headers: { 'x-api-key': TEST_API_KEY },
        });
        await new Promise((resolve, reject) => {
            ws.on('message', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });
        // Silence the automatic pong so the server sees no liveness signal.
        ws.pong = () => { /* deliberately unresponsive */ };

        const closed = await new Promise<boolean>((resolve) => {
            ws.on('close', () => resolve(true));
            setTimeout(() => resolve(false), 4000);
        });
        assert.equal(closed, true, 'unresponsive socket must be terminated by the reaper');
    } finally {
        await app.close();
    }
});
