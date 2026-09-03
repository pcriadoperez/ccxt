import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { readLines, ingestOnce } from './ingest.js';
import type { Pool } from './pool.js';

const silent = pino({ level: 'silent' });

function writeLog (lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const path = join(dir, 'audit.log');
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
}

test('readLines returns each line with the byte offset it starts at', () => {
    // The offsets are what lets the caller hold the cursor at ONE line rather than at the start
    // of a whole batch, which is the difference between re-reading an unpaired record and losing
    // it.
    const path = writeLog(['aa', 'bbbb', 'c']);
    const result = readLines(path, 0);
    assert.deepEqual(result.lines.map((l) => l.text), ['aa', 'bbbb', 'c']);
    assert.deepEqual(result.lines.map((l) => l.offset), [0, 3, 8]);
    assert.equal(result.nextOffset, 10);
    assert.equal(result.skippedOversizedLine, false);
});

test('a line longer than one read chunk does not stall ingestion forever', () => {
    // The defect this pins, reproduced before the fix: readLines asked for 1 MiB, found no
    // newline in it, and returned zero lines with the offset unchanged. The caller's loop broke,
    // the cursor never moved, and every record after the long line — a hundred perfectly ordinary
    // ones in the reproduction — was never ingested, on every pass, for the life of the process.
    // Nothing surfaced it: no throw, and requestsInserted at 0 suppressed even the info log.
    // user-agent and origin are caller-controlled and go into the audit line verbatim, so the
    // length is not purely hypothetical.
    const long = JSON.stringify({ event: 'request', reqId: 'big', statusCode: 200, userAgent: 'x'.repeat(1 << 20) });
    const after = Array.from({ length: 100 }, (_, i) => JSON.stringify({ event: 'request', reqId: `r${i}`, statusCode: 200 }));
    const path = writeLog([ long, ...after ]);

    const result = readLines(path, 0);
    assert.equal(result.lines.length, 101, 'the long line and everything behind it are read');
    assert.equal(result.lines[0]?.text, long);
    assert.ok(result.nextOffset > 0, 'the cursor advances');
});

test('a partial trailing line is left for the writer to finish', () => {
    // Unchanged behaviour, and the reason the fix cannot simply read to EOF: consuming a
    // half-written line would corrupt a row and then advance past it forever.
    const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const path = join(dir, 'audit.log');
    writeFileSync(path, 'complete\npartial-no-newline');
    const result = readLines(path, 0);
    assert.deepEqual(result.lines.map((l) => l.text), ['complete']);
    assert.equal(result.nextOffset, 9);
});

test('a file that is only a partial line yields nothing and does not advance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    const path = join(dir, 'audit.log');
    writeFileSync(path, 'no-newline-yet');
    const result = readLines(path, 0);
    assert.equal(result.lines.length, 0);
    assert.equal(result.nextOffset, 0);
    assert.equal(result.skippedOversizedLine, false);
});

test('nothing to read past the end of the file', () => {
    const path = writeLog(['only']);
    const result = readLines(path, 5);
    assert.equal(result.lines.length, 0);
    assert.equal(result.nextOffset, 5);
});

// ---------------------------------------------------------------------------
// pairing across a batch boundary
// ---------------------------------------------------------------------------

interface Recorded { sql: string; params: unknown[] }

// Enough of pg.Pool for ingestOnce: it SELECTs the cursor, connects, runs a transaction, and
// releases. Nothing here talks to Postgres — the property under test is which lines get paired
// and where the cursor lands, and both are decided before any SQL leaves the process.
function fakePool (cursorOffset: number, inode: number | null): { pool: Pool; queries: Recorded[] } {
    const queries: Recorded[] = [];
    const run = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
        queries.push({ sql, params });
        if (sql.indexOf('SELECT byte_offset') !== -1) {
            return { rows: [ { byte_offset: cursorOffset, inode: inode === null ? null : String(inode) } ] };
        }
        return { rows: [] };
    };
    const pool = {
        query: run,
        connect: async () => ({ query: run, release: () => { /* nothing to return */ } }),
    };
    return { pool: pool as unknown as Pool, queries };
}

function committedOffset (queries: Recorded[]): number | undefined {
    const cursorWrites = queries.filter((q) => q.sql.indexOf('INSERT INTO ingest_cursor') !== -1);
    return cursorWrites.length === 0 ? undefined : cursorWrites[cursorWrites.length - 1]?.params[1] as number;
}

function insertedRequests (queries: Recorded[]): Recorded[] {
    return queries.filter((q) => q.sql.indexOf('INSERT INTO requests') !== -1);
}

test('a routing record at the tail waits for its access line instead of being dropped', async () => {
    // The routing record is written BEFORE the access line, so a read that ends between them sees
    // only the first half. The old code skipped it with the comment "it will pair next pass" —
    // and then committed the cursor past the very line it meant to revisit. The record was never
    // re-read: Postgres got a requests row with route and status set and every routing column
    // NULL, in the table that exists to answer "why did you route it there?".
    const { statSync: stat } = await import('node:fs');
    const { appendFileSync } = await import('node:fs');
    const recommendation = JSON.stringify({
        event: 'route_recommendation', reqId: 'req-1', from: 'USDT', to: 'BTC', amountIn: 10,
        time: Date.now(),
    });
    const path = writeLog([ recommendation ]);
    const halfway = stat(path).size;

    const first = fakePool(0, stat(path).ino);
    const stats = await ingestOnce(first.pool, path, 'audit', silent);
    assert.equal(stats.requestsInserted, 0, 'nothing is written from half a pair');
    assert.equal(insertedRequests(first.queries).length, 0);
    assert.equal(committedOffset(first.queries), undefined,
        'and the cursor does NOT advance past the record it still needs');

    // The access line lands a moment later, in what would be the next read.
    appendFileSync(path, JSON.stringify({
        event: 'request', reqId: 'req-1', method: 'GET', route: '/route', statusCode: 200, durationMs: 3,
    }) + '\n');

    const second = fakePool(0, stat(path).ino);
    const stats2 = await ingestOnce(second.pool, path, 'audit', silent);
    assert.equal(stats2.requestsInserted, 1);
    const row = insertedRequests(second.queries)[0];
    assert.equal(row?.params[4], '/route', 'the access half is present');
    assert.equal(row?.params[8], 'USDT', 'and so is the routing half');
    assert.equal(row?.params[9], 'BTC');
    assert.ok((committedOffset(second.queries) as number) > halfway, 'now the cursor moves past both');
});

test('an access line whose partner never arrived is written rather than wedging the cursor', async () => {
    // The counterpart risk of holding the cursor back: a request whose response never logged (a
    // SIGKILL mid-flight) would otherwise block ingestion of everything behind it forever — the
    // same failure the oversized line caused. Away from the tail, the partner is genuinely gone,
    // so the row is written with the detail it has.
    const { statSync: stat } = await import('node:fs');
    // Timestamped well outside the grace window: this partner is not late, it is never coming.
    const orphan = JSON.stringify({
        event: 'route_recommendation', reqId: 'orphan', from: 'USDT', to: 'BTC',
        time: Date.now() - 10 * 60_000,
    });
    const later = JSON.stringify({
        event: 'request', reqId: 'later', method: 'GET', route: '/symbols', statusCode: 200,
        time: Date.now(),
    });
    const path = writeLog([ orphan, later ]);

    const { pool, queries } = fakePool(0, stat(path).ino);
    const stats = await ingestOnce(pool, path, 'audit', silent);
    assert.equal(stats.requestsInserted, 1, 'the complete record is written');
    assert.equal(insertedRequests(queries)[0]?.params[4], '/symbols');
    assert.equal(committedOffset(queries), stat(path).size, 'and the cursor clears the orphan');
});
