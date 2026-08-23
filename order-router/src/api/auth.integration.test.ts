import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';
import { buildServer } from './server.js';
import { ApiKeyStore, generateKey, hashKey, type ApiKeyRecord } from './keyStore.js';
import { DEV_API_KEY } from './auth.js';
import type { CachedOrderBook } from '../types.js';

const dirs: string[] = [];
function tmpFile (): string {
    const dir = mkdtempSync(join(tmpdir(), 'orauth-'));
    dirs.push(dir);
    return join(dir, 'keys.json');
}
process.on('exit', () => {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

function row (over: Partial<ApiKeyRecord> & { hash: string }): ApiKeyRecord {
    return {
        id: 'k_x', name: 'x', last4: 'xxxx',
        createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'test',
        revokedAt: null, lastUsedAt: null, note: '', rateLimitMax: null, wsMaxConnections: null,
        ...over,
    };
}

function book (): CachedOrderBook {
    return {
        exchangeId: 'kraken', symbol: 'BTC/USDT',
        bids: [{ price: 100, amount: 5 }], asks: [{ price: 101, amount: 5 }],
        exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
    };
}

// Captures every log line so attribution can be asserted on structure rather than eyeballed, and
// so the "the raw key is never logged" check has something to grep.
function collectingLogger (): { logger: pino.Logger; lines: () => Record<string, unknown>[]; raw: () => string } {
    let buffer = '';
    const sink = new Writable({
        write (chunk, _enc, cb) { buffer += String(chunk); cb(); },
    });
    return {
        logger: pino({ level: 'info' }, sink),
        raw: () => buffer,
        lines: () => buffer.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Record<string, unknown>),
    };
}

interface Built {
    app: Awaited<ReturnType<typeof buildServer>>;
    cache: OrderBookCache;
    store: ApiKeyStore;
    path: string;
    lines: () => Record<string, unknown>[];
    raw: () => string;
}

async function build (rows: ApiKeyRecord[], opts: Record<string, unknown> = {}): Promise<Built> {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ version: 1, keys: rows }));
    // No env bridge in these tests unless a test opts into it, so the store is the only authority.
    const previous = process.env['ORDER_ROUTER_API_KEY'];
    delete process.env['ORDER_ROUTER_API_KEY'];
    const { logger, lines, raw } = collectingLogger();
    const store = new ApiKeyStore(path, logger);
    store.load();
    if (previous !== undefined) process.env['ORDER_ROUTER_API_KEY'] = previous;
    const cache = new OrderBookCache();
    const app = await buildServer(cache, new FeeRegistry(), logger,
        { rateLimitMax: 100000, keyStore: store, ...opts });
    return { app, cache, store, path, lines, raw };
}

test('two distinct valid keys both authenticate', async () => {
    // The thing single-key auth structurally cannot express.
    const a = generateKey();
    const b = generateKey();
    const { app } = await build([
        row({ id: 'k_a', name: 'alpha', hash: hashKey(a) }),
        row({ id: 'k_b', name: 'beta', hash: hashKey(b) }),
    ]);
    for (const key of [a, b]) {
        const r = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': key } });
        assert.equal(r.statusCode, 200);
    }
    await app.close();
});

test('missing, unknown and revoked keys are byte-identical 401s', async () => {
    // Any difference between them is an oracle for "was this key ever real?", which matters far
    // more once keys have a lifecycle than it did with one static secret.
    const live = generateKey();
    const dead = generateKey();
    const { app } = await build([
        row({ id: 'k_live', name: 'live', hash: hashKey(live) }),
        row({ id: 'k_dead', name: 'dead', hash: hashKey(dead), revokedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/symbols' }),
        app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': 'never-existed' } }),
        app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': dead } }),
    ]);
    for (const r of responses) {
        assert.equal(r.statusCode, 401);
        assert.equal(r.body, responses[0]!.body);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': live } })).statusCode, 200);
    await app.close();
});

test('an unknown path still 401s without a key and 404s with one', async () => {
    // Regression: preValidation only runs for MATCHED routes, so without setNotFoundHandler
    // consulting the store an unknown path 404s before auth and becomes a route-enumeration oracle.
    const live = generateKey();
    const dead = generateKey();
    const { app } = await build([
        row({ id: 'k_live', name: 'live', hash: hashKey(live) }),
        row({ id: 'k_dead', name: 'dead', hash: hashKey(dead), revokedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    assert.equal((await app.inject({ method: 'GET', url: '/nope' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/nope', headers: { 'x-api-key': dead } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/nope', headers: { 'x-api-key': live } })).statusCode, 404);
    await app.close();
});

test('a revoked key is still counted by the rate limiter before being rejected', async () => {
    // The original bug in a new shape. Revocation is a NEW rejection path, and if it were ever
    // moved ahead of the limiter it would reopen the unlimited brute-force door that cost a
    // measured 401x30-never-429 before.
    const dead = generateKey();
    const { app } = await build(
        [row({ id: 'k_dead', name: 'dead', hash: hashKey(dead), revokedAt: '2026-02-01T00:00:00.000Z' })],
        { rateLimitMax: 5, rateLimitWindowMs: 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
        codes.push((await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': dead } })).statusCode);
    }
    assert.ok(codes.includes(429), `a revoked key must consume rate-limit budget, got ${codes.join(',')}`);
    await app.close();
});

test('one key exhausting its budget does not throttle another', async () => {
    // Per-key fairness — impossible to even state under single-key auth, where the only other
    // identity available was "invalid".
    const a = generateKey();
    const b = generateKey();
    const { app } = await build([
        row({ id: 'k_a', name: 'alpha', hash: hashKey(a) }),
        row({ id: 'k_b', name: 'beta', hash: hashKey(b) }),
    ], { rateLimitMax: 3, rateLimitWindowMs: 60_000 });

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
        codes.push((await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': a } })).statusCode);
    }
    assert.ok(codes.includes(429), 'key A must exhaust its own bucket');
    const bResponse = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': b } });
    assert.equal(bResponse.statusCode, 200, 'key B must be untouched by key A burning its budget');
    await app.close();
});

test('a per-key rateLimitMax overrides the global default', async () => {
    const tight = generateKey();
    const normal = generateKey();
    const { app } = await build([
        row({ id: 'k_tight', name: 'tight', hash: hashKey(tight), rateLimitMax: 2 }),
        row({ id: 'k_normal', name: 'normal', hash: hashKey(normal) }),
    ], { rateLimitMax: 100, rateLimitWindowMs: 60_000 });

    const tightCodes: number[] = [];
    for (let i = 0; i < 5; i++) {
        tightCodes.push((await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': tight } })).statusCode);
    }
    assert.ok(tightCodes.includes(429), `the per-key cap of 2 must bite, got ${tightCodes.join(',')}`);
    for (let i = 0; i < 5; i++) {
        const r = await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': normal } });
        assert.equal(r.statusCode, 200, 'the default key must be unaffected by another key having a tighter cap');
    }
    await app.close();
});

test('revoking a key in the file stops it working after a reload, with no restart', async () => {
    // The whole point of the reload path: killing a key must not cost the restart that would
    // rebuild the order-book cache and degrade routing for minutes.
    const key = generateKey();
    const { app, store, path } = await build([row({ id: 'k_r', name: 'revocable', hash: hashKey(key) })]);
    assert.equal((await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': key } })).statusCode, 200);

    writeFileSync(path, JSON.stringify({ version: 1, keys: [
        row({ id: 'k_r', name: 'revocable', hash: hashKey(key), revokedAt: '2026-02-01T00:00:00.000Z' }),
    ] }));
    assert.equal(store.reload(), true);
    assert.equal((await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': key } })).statusCode, 401);
    await app.close();
});

test('every request emits exactly one access line carrying the key identity', async () => {
    const key = generateKey();
    const { app, lines } = await build([row({ id: 'k_acme', name: 'acme-desk', hash: hashKey(key) })]);
    await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': key } });
    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/symbols' });
    await app.inject({ method: 'GET', url: '/nope', headers: { 'x-api-key': key } });
    await app.close();

    const access = lines().filter((l) => l['event'] === 'request');
    assert.equal(access.length, 4, 'one line per request, including /health, a 401 and a 404');
    const bySymbols = access.filter((l) => l['route'] === '/symbols');
    assert.equal(bySymbols.length, 2);
    const ok = bySymbols.find((l) => l['statusCode'] === 200)!;
    assert.equal(ok['keyId'], 'k_acme');
    assert.equal(ok['keyName'], 'acme-desk');
    assert.ok(typeof ok['durationMs'] === 'number');
    // Failed auth is greppable as a first-class thing rather than an absent field.
    const denied = bySymbols.find((l) => l['statusCode'] === 401)!;
    assert.equal(denied['keyId'], null);
    assert.ok('keyId' in denied, 'keyId must be present-and-null, not missing');
});

test('the /route audit record is self-contained and joins the access line by reqId', async () => {
    const key = generateKey();
    const { app, cache, lines } = await build([row({ id: 'k_acme', name: 'acme-desk', hash: hashKey(key) })]);
    cache.setBook(book());
    const response = await app.inject({
        method: 'GET', url: '/route?from=USDT&to=BTC&amountOut=1',
        headers: { 'x-api-key': key, 'x-request-id': 'trace-abc' },
    });
    await app.close();

    assert.equal(response.json().requestId, 'trace-abc');
    assert.equal(response.headers['x-request-id'], 'trace-abc');
    const audit = lines().find((l) => l['event'] === 'route_recommendation')!;
    assert.ok(audit, 'a routing recommendation must be auditable by event name, not by message text');
    assert.equal(audit['keyId'], 'k_acme');
    assert.equal(audit['keyName'], 'acme-desk');
    assert.equal(audit['requestId'], 'trace-abc');
    // The access line and the audit line for one request must be joinable.
    const access = lines().find((l) => l['event'] === 'request' && l['route'] === '/route')!;
    assert.equal(access['reqId'], audit['reqId']);
});

test('a hostile x-request-id is replaced rather than echoed into every log line', async () => {
    const key = generateKey();
    const { app } = await build([row({ id: 'k_a', name: 'a', hash: hashKey(key) })]);
    for (const hostile of ['x'.repeat(300), 'line\nbreak', '{"json":"injection"}']) {
        const r = await app.inject({
            method: 'GET', url: '/symbols', headers: { 'x-api-key': key, 'x-request-id': hostile } });
        assert.notEqual(r.headers['x-request-id'], hostile);
    }
    await app.close();
});

test('the raw key never reaches the logs, in any form', async () => {
    // The single highest-value test here: it fails loudly the first time someone adds a debug line
    // that dumps headers. The hash is checked too — a digest in a log lets anyone with log access
    // offline-verify a guessed key without ever touching the server.
    const key = generateKey();
    const { app, cache, raw } = await build([row({ id: 'k_a', name: 'a', hash: hashKey(key) })]);
    cache.setBook(book());
    await app.inject({ method: 'GET', url: '/route?from=USDT&to=BTC&amountOut=1', headers: { 'x-api-key': key } });
    await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': key } });
    await app.inject({ method: 'GET', url: '/symbols', headers: { 'x-api-key': 'wrong-' + key } });
    await app.inject({ method: 'GET', url: '/nope', headers: { authorization: `Bearer ${key}` } });
    await app.close();

    const logged = raw();
    assert.ok(logged.length > 0, 'precondition: something must actually have been logged');
    assert.equal(logged.indexOf(key), -1, 'the plaintext key appeared in the log output');
    assert.equal(logged.indexOf(hashKey(key)), -1, 'the key hash appeared in the log output');
    assert.equal(logged.indexOf('or_live_'), -1, 'no key-shaped string may appear at all');
});

test('per-key WS caps are enforced independently, and a per-key override applies', async () => {
    // The existing cap test could only assert the bookkeeping was keyed at all, because a second
    // valid identity did not exist under single-key auth. Now it can assert the actual property.
    const { WebSocket } = await import('ws');
    const a = generateKey();
    const b = generateKey();
    const built = await build([
        row({ id: 'k_a', name: 'alpha', hash: hashKey(a), wsMaxConnections: 1 }),
        row({ id: 'k_b', name: 'beta', hash: hashKey(b) }),
    ], { wsMaxConnectionsPerKey: 5 });
    built.cache.setBook(book());
    const open: { terminate: () => void }[] = [];
    try {
        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const address = built.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const url = `ws://127.0.0.1:${port}/stream/route?from=USDT&to=BTC&amountOut=1`;

        const connect = (key: string) => new Promise<{ ok: boolean; code: number }>((resolve) => {
            const ws = new WebSocket(url, { headers: { 'x-api-key': key } });
            open.push(ws);
            let sawData = false;
            ws.on('message', (d: Buffer) => {
                if (JSON.parse(d.toString()).error === undefined) { sawData = true; resolve({ ok: true, code: 0 }); }
            });
            ws.on('close', (code: number) => resolve({ ok: sawData, code }));
            ws.on('error', () => resolve({ ok: false, code: -1 }));
        });

        assert.equal((await connect(a)).ok, true, 'key A gets its one allowed socket');
        assert.equal((await connect(a)).code, 1013, 'and is refused a second by its own override of 1');
        // Key B has no override, so it takes the service default of 5 and is unaffected by A.
        assert.equal((await connect(b)).ok, true);
        assert.equal((await connect(b)).ok, true, 'one key hitting its cap must not affect another');
    } finally {
        for (const w of open) { try { w.terminate(); } catch { /* already closed */ } }
        await built.app.close();
    }
});

test('revoking a key closes its live streams instead of letting them run on', async () => {
    // A stream authenticates ONCE, at upgrade. Without this, revoking a key leaves its live quote
    // feed running until the client hangs up — which is not what an operator killing a key means.
    const { WebSocket } = await import('ws');
    const key = generateKey();
    const built = await build([row({ id: 'k_doomed', name: 'doomed', hash: hashKey(key) })]);
    built.cache.setBook(book());
    try {
        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const address = built.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;

        const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/route?from=USDT&to=BTC&amountOut=1`, {
            headers: { 'x-api-key': key },
        });
        const closed = new Promise<number>((resolve, reject) => {
            ws.on('close', (code: number) => resolve(code));
            setTimeout(() => reject(new Error('a revoked key kept its live stream open')), 4000);
        });
        await new Promise<void>((resolve, reject) => {
            ws.on('message', () => resolve());
            ws.on('error', reject);
            setTimeout(() => reject(new Error('stream never delivered')), 3000);
        });

        writeFileSync(built.path, JSON.stringify({ version: 1, keys: [
            row({ id: 'k_doomed', name: 'doomed', hash: hashKey(key), revokedAt: '2026-02-01T00:00:00.000Z' }),
        ] }));
        built.store.reload();
        assert.equal(await closed, 1008, 'the socket must be closed with a policy-violation code');
    } finally {
        await built.app.close();
    }
});

test('a stream open and close are both attributable to the key', async () => {
    // A long-lived socket otherwise produces zero access-log lines despite being the most
    // expensive thing a key can do.
    const { WebSocket } = await import('ws');
    const key = generateKey();
    const built = await build([row({ id: 'k_s', name: 'streamer', hash: hashKey(key) })]);
    built.cache.setBook(book());
    try {
        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const address = built.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const ws = new WebSocket(`ws://127.0.0.1:${port}/stream/route?from=USDT&to=BTC&amountOut=1`, {
            headers: { 'x-api-key': key },
        });
        await new Promise<void>((resolve, reject) => {
            ws.on('message', () => resolve());
            ws.on('error', reject);
            setTimeout(() => reject(new Error('stream never delivered')), 3000);
        });
        await new Promise<void>((resolve) => { ws.on('close', () => resolve()); ws.close(); });
        await new Promise((r) => setTimeout(r, 100));
    } finally {
        await built.app.close();
    }
    const opened = built.lines().find((l) => l['event'] === 'stream_open');
    const shut = built.lines().find((l) => l['event'] === 'stream_close');
    assert.ok(opened, 'a stream open must be logged');
    assert.equal(opened!['keyId'], 'k_s');
    assert.equal(opened!['keyName'], 'streamer');
    assert.equal(opened!['from'], 'USDT');
    assert.ok(shut, 'a stream close must be logged');
    assert.equal(shut!['keyId'], 'k_s');
    assert.ok(typeof shut!['durationMs'] === 'number');
});

test('an unmatched path consumes rate-limit budget instead of being a free key oracle', async () => {
    // The 401-before-the-limiter regression, through a second door. The instance-level preValidation
    // auth hook runs before ANY route-level hook, so rejecting an unmatched path there short-
    // circuited the not-found route's own preHandler chain — and with it the rate limiter attached
    // to it. Measured before the fix: 500 wrong-key requests to invented paths returned 500x401 in
    // 191ms with zero 429s and no x-ratelimit headers, an unmetered "is this key valid?" oracle at
    // ~2,600 guesses/sec that also left the real routes' budget completely untouched.
    const key = generateKey();
    const { app } = await build([row({ id: 'k_a', name: 'a', hash: hashKey(key) })],
        { rateLimitMax: 3, rateLimitWindowMs: 600_000 });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
        codes.push((await app.inject({
            method: 'GET', url: '/invented-' + i, headers: { 'x-api-key': 'wrong-' + i },
        })).statusCode);
    }
    assert.ok(codes.includes(429),
        `probing invented paths must consume budget, got ${codes.join(',')}`);
    // And the oracle itself must still work for a legitimate typo by an authenticated caller.
    const authed = await build([row({ id: 'k_a', name: 'a', hash: hashKey(key) })]);
    assert.equal((await authed.app.inject({
        method: 'GET', url: '/typo', headers: { 'x-api-key': key } })).statusCode, 404);
    await authed.app.close();
    await app.close();
});

test('the well-known dev key never authenticates against a configured deployment', async () => {
    // End-to-end counterpart to the store-level test: through the real hook chain, revoking the
    // last key must lock everyone out rather than swapping a secret credential for a published one.
    const key = generateKey();
    const built = await build([row({ id: 'k_real', name: 'prod', hash: hashKey(key) })]);
    assert.equal((await built.app.inject({
        method: 'GET', url: '/symbols', headers: { 'x-api-key': key } })).statusCode, 200);
    assert.equal((await built.app.inject({
        method: 'GET', url: '/symbols', headers: { 'x-api-key': DEV_API_KEY } })).statusCode, 401);

    writeFileSync(built.path, JSON.stringify({ version: 1, keys: [
        row({ id: 'k_real', name: 'prod', hash: hashKey(key), revokedAt: '2026-02-01T00:00:00.000Z' }),
    ] }));
    built.store.reload();
    assert.equal((await built.app.inject({
        method: 'GET', url: '/symbols', headers: { 'x-api-key': key } })).statusCode, 401);
    assert.equal((await built.app.inject({
        method: 'GET', url: '/symbols', headers: { 'x-api-key': DEV_API_KEY } })).statusCode, 401,
    'revoking the last key must not open a door for a credential published in this repo');
    await built.app.close();
});

test('a reload leaves still-active keys streaming and closes only the revoked one', async () => {
    // The revocation sweep must be surgical. Closing every socket on any reload would make routine
    // key creation disconnect every live subscriber.
    const { WebSocket } = await import('ws');
    const keep = generateKey();
    const kill = generateKey();
    const built = await build([
        row({ id: 'k_keep', name: 'keep', hash: hashKey(keep) }),
        row({ id: 'k_kill', name: 'kill', hash: hashKey(kill) }),
    ]);
    built.cache.setBook(book());
    try {
        await built.app.listen({ port: 0, host: '127.0.0.1' });
        const address = built.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const url = `ws://127.0.0.1:${port}/stream/route?from=USDT&to=BTC&amountOut=1`;

        const connect = (key: string) => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
            const ws = new WebSocket(url, { headers: { 'x-api-key': key } });
            ws.on('message', () => resolve(ws));
            ws.on('error', reject);
            setTimeout(() => reject(new Error('never delivered')), 3000);
        });
        const keepSocket = await connect(keep);
        const killSocket = await connect(kill);
        let keepClosed = false;
        keepSocket.on('close', () => { keepClosed = true; });
        const killClosed = new Promise<number>((resolve, reject) => {
            killSocket.on('close', (c: number) => resolve(c));
            setTimeout(() => reject(new Error('the revoked key kept its stream')), 4000);
        });

        writeFileSync(built.path, JSON.stringify({ version: 1, keys: [
            row({ id: 'k_keep', name: 'keep', hash: hashKey(keep) }),
            row({ id: 'k_kill', name: 'kill', hash: hashKey(kill), revokedAt: '2026-02-01T00:00:00.000Z' }),
        ] }));
        built.store.reload();

        assert.equal(await killClosed, 1008);
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(keepClosed, false, 'an unaffected key must keep its stream through a reload');
        keepSocket.terminate();
    } finally {
        await built.app.close();
    }
});
