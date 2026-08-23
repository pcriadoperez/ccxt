import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runKeysCli } from './keys.js';
import { readKeyFile, KEY_PATTERN } from '../api/keyStore.js';

const dirs: string[] = [];
function tmpFile (): string {
    const dir = mkdtempSync(join(tmpdir(), 'orcli-'));
    dirs.push(dir);
    return join(dir, 'keys.json');
}
process.on('exit', () => {
    for (const d of dirs) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

// The CLI writes to stdout/stderr directly, so capture them to assert on what an operator sees —
// in particular that a key is shown exactly once and never again.
function capture (fn: () => number): { code: number; out: string; err: string } {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    let out = '';
    let err = '';
    (process.stdout as { write: unknown }).write = (chunk: string) => { out += chunk; return true; };
    (process.stderr as { write: unknown }).write = (chunk: string) => { err += chunk; return true; };
    try {
        return { code: fn(), out, err };
    } finally {
        (process.stdout as { write: unknown }).write = origOut;
        (process.stderr as { write: unknown }).write = origErr;
    }
}

test('create prints the key exactly once and list never prints it again', () => {
    const path = tmpFile();
    const created = capture(() => runKeysCli(['create', '--name', 'acme-desk', '--note', 'docs demo'], path));
    assert.equal(created.code, 0);
    const key = /or_live_[A-Za-z0-9_-]{43}/.exec(created.out)?.[0];
    assert.ok(key, 'create must show the plaintext once');
    assert.match(key, KEY_PATTERN);

    const listed = capture(() => runKeysCli(['list'], path));
    assert.equal(listed.code, 0);
    assert.ok(listed.out.includes('acme-desk'));
    assert.equal(listed.out.indexOf('or_live_'), -1, 'list must never print a key');
    assert.equal(listed.out.indexOf(key), -1);
    // The last4 is enough to match a user's screenshot to a row without ever handling the secret.
    assert.ok(listed.out.includes('...' + key.slice(-4)));
});

test('create records the operator and the note, and emits an audit line', () => {
    const path = tmpFile();
    const result = capture(() => runKeysCli(['create', '--name', 'audited', '--note', 'why'], path));
    const row = readKeyFile(path).keys[0]!;
    assert.equal(row.name, 'audited');
    assert.equal(row.note, 'why');
    assert.ok(row.createdBy.length > 0);
    assert.equal(row.revokedAt, null);
    const audit = JSON.parse(result.err.trim()) as Record<string, unknown>;
    assert.equal(audit['event'], 'key_admin');
    assert.equal(audit['action'], 'create');
    assert.equal(audit['id'], row.id);
    assert.equal(JSON.stringify(audit).indexOf('or_live_'), -1, 'the audit line must not carry the key');
});

test('a duplicate name is rejected, because name is the ergonomic revoke selector', () => {
    const path = tmpFile();
    assert.equal(capture(() => runKeysCli(['create', '--name', 'dup'], path)).code, 0);
    const second = capture(() => runKeysCli(['create', '--name', 'dup'], path));
    assert.equal(second.code, 1);
    assert.match(second.err, /already exists/);
    assert.equal(readKeyFile(path).keys.length, 1);
});

test('create without a name is a usage error, not an anonymous key', () => {
    const path = tmpFile();
    assert.equal(capture(() => runKeysCli(['create'], path)).code, 2);
    assert.equal(readKeyFile(path).keys.length, 0);
});

test('revoke works by id and by name, and the row survives', () => {
    const path = tmpFile();
    capture(() => runKeysCli(['create', '--name', 'by-name'], path));
    capture(() => runKeysCli(['create', '--name', 'by-id'], path));
    const byId = readKeyFile(path).keys.find((k) => k.name === 'by-id')!;

    assert.equal(capture(() => runKeysCli(['revoke', 'by-name'], path)).code, 0);
    assert.equal(capture(() => runKeysCli(['revoke', byId.id], path)).code, 0);

    const rows = readKeyFile(path).keys;
    assert.equal(rows.length, 2, 'revocation keeps the row so old log lines stay resolvable');
    assert.ok(rows.every((k) => k.revokedAt !== null));

    // A revoked key is hidden from the default listing but recoverable with the flag.
    assert.equal(capture(() => runKeysCli(['list'], path)).out.includes('by-name'), false);
    assert.ok(capture(() => runKeysCli(['list', '--include-revoked'], path)).out.includes('by-name'));
});

test('revoking an unknown selector fails rather than silently succeeding', () => {
    const path = tmpFile();
    const result = capture(() => runKeysCli(['revoke', 'never-existed'], path));
    assert.equal(result.code, 1);
    assert.match(result.err, /no key matching/);
});

test('delete refuses without --yes and steers the operator toward revoke', () => {
    const path = tmpFile();
    capture(() => runKeysCli(['create', '--name', 'doomed'], path));
    const refused = capture(() => runKeysCli(['delete', 'doomed'], path));
    assert.equal(refused.code, 1);
    assert.match(refused.err, /Prefer `revoke`/);
    assert.equal(readKeyFile(path).keys.length, 1, 'nothing may be removed without confirmation');

    const done = capture(() => runKeysCli(['delete', 'doomed', '--yes'], path));
    assert.equal(done.code, 0);
    assert.match(done.out, /unresolvable/, 'deleting must warn that existing logs lose their reference');
    assert.equal(readKeyFile(path).keys.length, 0);
});

test('per-key overrides survive a round trip through the file', () => {
    const path = tmpFile();
    capture(() => runKeysCli(['create', '--name', 'limited', '--rate-limit', '7', '--ws-max', '2'], path));
    const row = readKeyFile(path).keys[0]!;
    assert.equal(row.rateLimitMax, 7);
    assert.equal(row.wsMaxConnections, 2);
});

test('list --json is machine-readable and still carries no secret', () => {
    const path = tmpFile();
    capture(() => runKeysCli(['create', '--name', 'jsonable'], path));
    const out = capture(() => runKeysCli(['list', '--json'], path)).out;
    const rows = JSON.parse(out) as { name: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'jsonable');
    assert.equal(out.indexOf('or_live_'), -1);
});

test('the key file is written 0600, since it is the whole credential store', () => {
    const path = tmpFile();
    capture(() => runKeysCli(['create', '--name', 'perms'], path));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(readFileSync(path, 'utf8').length > 0);
});
