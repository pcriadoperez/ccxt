import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { projectKeys } from './keyProjection.js';
import { ApiKeyStore, generateKey, hashKey, readKeyFile } from '../api/keyStore.js';

const silent = pino({ level: 'silent' });

// A stand-in for pg.Pool that only has to satisfy projectKeys' single query. The properties worth
// testing here — that a Postgres failure leaves the previous snapshot intact, that revoked keys
// never reach the file, that the router can still authenticate from a stale file — are all about
// what the projection does with what it gets back, not about SQL. Those are better asserted
// deterministically than against a live database that may or may not be running in CI.
function fakePool (behaviour: () => { rows: unknown[] }): { query: () => Promise<{ rows: unknown[] }> } {
    return { query: async () => behaviour() };
}

function row (over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        display_id: 'k_abc123',
        user_id: '22222222-2222-4222-8222-222222222222',
        name: 'acme',
        hash: hashKey('or_live_test'),
        last4: 'test',
        note: '',
        rate_limit_max: null,
        ws_max_connections: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        created_by: 'self-serve',
        ...over,
    };
}

const dirs: string[] = [];
function tmpFile (): string {
    const dir = mkdtempSync(join(tmpdir(), 'orproj-'));
    dirs.push(dir);
    return join(dir, 'keys.json');
}
process.on('exit', () => {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

test('a projected key authenticates through the ordinary store, unchanged', async () => {
    // The whole point of projecting to a file is that the router's auth path does not change. This
    // asserts the projection produces something the SHIPPED store loads and looks up.
    const key = generateKey();
    const path = tmpFile();
    const pool = fakePool(() => ({ rows: [row({ hash: hashKey(key) })] }));

    const result = await projectKeys(pool as never, path, silent);
    assert.equal(result.keys, 1);
    assert.equal(result.changed, true);

    const store = new ApiKeyStore(path, silent);
    store.load();
    const found = store.lookup(key);
    assert.ok(found, 'the router must authenticate a key that came from the database');
    assert.equal(found.id, 'k_abc123', 'the display id is what the router reports and logs');
    assert.equal(found.userId, '22222222-2222-4222-8222-222222222222');
    assert.equal(found.keyUuid, '11111111-1111-4111-8111-111111111111');
});

test('the snapshot never contains a usable credential', async () => {
    const key = generateKey();
    const path = tmpFile();
    await projectKeys(fakePool(() => ({ rows: [row({ hash: hashKey(key) })] })) as never, path, silent);
    const onDisk = readFileSync(path, 'utf8');
    assert.equal(onDisk.indexOf(key), -1, 'the plaintext key must never be written');
    assert.equal(onDisk.indexOf('or_live_'), -1);
    assert.match(readKeyFile(path).keys[0]!.hash, /^[0-9a-f]{64}$/);
});

test('a Postgres failure leaves the previous snapshot intact', async () => {
    // The asymmetry that makes the router independent of the database: a failed projection must
    // never de-authenticate every existing customer. Silent and stale beats correct and down.
    const key = generateKey();
    const path = tmpFile();
    await projectKeys(fakePool(() => ({ rows: [row({ hash: hashKey(key) })] })) as never, path, silent);

    const broken = { query: async () => { throw new Error('connection refused'); } };
    await assert.rejects(() => projectKeys(broken as never, path, silent));

    const store = new ApiKeyStore(path, silent);
    store.load();
    assert.ok(store.lookup(key), 'an existing key must keep working while Postgres is unreachable');
});

test('an empty result set writes an empty snapshot rather than being treated as a failure', async () => {
    // The opposite hazard to the one above, and it has to be distinguished: "no keys exist" is a
    // legitimate answer that must be honoured, or revoking the last key would leave it working.
    const key = generateKey();
    const path = tmpFile();
    await projectKeys(fakePool(() => ({ rows: [row({ hash: hashKey(key) })] })) as never, path, silent);

    await projectKeys(fakePool(() => ({ rows: [] })) as never, path, silent);
    const store = new ApiKeyStore(path, silent);
    store.load();
    assert.equal(store.lookup(key), undefined, 'a key removed from the database must stop working');
    assert.equal(store.activeCount(), 0);
});

test('an unchanged key set does not rewrite the file', async () => {
    // The projection runs every few seconds and almost never has news. Rewriting regardless would
    // churn the file, trip the router's mtime poll on every tick, and bury real changes in log noise.
    const path = tmpFile();
    const rows = [row()];
    const pool = fakePool(() => ({ rows }));
    assert.equal((await projectKeys(pool as never, path, silent)).changed, true);
    assert.equal((await projectKeys(pool as never, path, silent)).changed, false);
    assert.equal((await projectKeys(pool as never, path, silent)).changed, false);
});

test('the projection creates the snapshot directory if it does not exist', async () => {
    // First run on a fresh box: nothing has created the directory yet, and an uncaught ENOENT here
    // would break the very first deploy.
    const dir = mkdtempSync(join(tmpdir(), 'orproj-'));
    dirs.push(dir);
    const path = join(dir, 'nested', 'deeper', 'keys.json');
    await projectKeys(fakePool(() => ({ rows: [row()] })) as never, path, silent);
    assert.ok(existsSync(path));
});

test('per-key limits survive the round trip', async () => {
    const key = generateKey();
    const path = tmpFile();
    await projectKeys(
        fakePool(() => ({ rows: [row({ hash: hashKey(key), rate_limit_max: 25, ws_max_connections: 3 })] })) as never,
        path, silent);
    const store = new ApiKeyStore(path, silent);
    store.load();
    const found = store.lookup(key)!;
    assert.equal(found.rateLimitMax, 25);
    assert.equal(found.wsMaxConnections, 3);
});
