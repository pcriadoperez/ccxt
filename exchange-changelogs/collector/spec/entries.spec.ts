// Entry ids (entries.ts assignKeys / buildEntries): stable across inserts and body edits; hash
// sources are never dated from the lines they list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangelogEntry, SourceConfig } from '../src/types.ts';
import { assignKeys, buildEntries, displayTitle } from '../src/entries.ts';
import { mergeEntries } from '../src/merge.ts';
import { NOW, parse, venueOf } from './helpers.ts';

const MD: SourceConfig = { id: 'x-log', type: 'md', url: 'https://example.com/log.md' };

async function build (source: SourceConfig, body: string, previousSnapshot: string | null = null): Promise<ChangelogEntry[]> {
    const out = await parse (source, body, previousSnapshot);
    return buildEntries (out.entries, { venue: venueOf ('x', [ 'example.com' ], [ source ]), source, affects: [ 'x' ], now: NOW, firstRun: false });
}

test ('assignKeys: the bottom-most duplicate keeps the plain key, others are told apart by body', () => {
    const keys = assignKeys ([ { base: 'k', body: 'c' }, { base: 'k', body: 'a' }, { base: 'k', body: 'a' }, { base: 'j', body: 'z' }, { base: 'k', body: 'b' } ]);
    assert.equal (keys[4], 'k');
    assert.equal (keys[3], 'j');
    assert.match (keys[0], /^k\|b:[0-9a-f]{16}$/);
    assert.match (keys[2], /^k\|b:[0-9a-f]{16}$/);
    assert.equal (keys[1], keys[2] + '|#2', 'identical bodies fall back to a position counted from the bottom');
    assert.equal (new Set (keys).size, keys.length);
});

test ('a new item on top with a repeated title does not take over older ids', async () => {
    const v1 = '## API update\nAdded GET /a\n\n## API update\nAdded GET /b\n';
    const v2 = '## API update\nAdded GET /c\n\n' + v1;
    const store = new Map<string, ChangelogEntry> ();
    mergeEntries (store, await build (MD, v1), { sourceId: MD.id, firstRun: true, trackRemovals: true, missingRuns: {}, now: 't1' });
    const r = mergeEntries (store, await build (MD, v2), { sourceId: MD.id, firstRun: false, trackRemovals: true, missingRuns: {}, now: 't2' });
    assert.deepEqual (r.added.map ((e) => e.body), [ 'Added GET /c' ]);
    assert.deepEqual (r.revised, []);
    assert.equal (r.added[0].backfill, false);
});

test ('a date found only in the body is not part of the id', async () => {
    const before = await build (MD, '## New order endpoint\nWe added POST /order/v2 on 2026-11-01.\n');
    const after = await build (MD, '## New order endpoint\nTestnet: 2026-10-25\nWe added POST /order/v2 on 2026-11-01.\n');
    assert.equal (before[0].publishedAt, '2026-11-01', 'the body date still dates the entry');
    assert.equal (after[0].id, before[0].id);
    assert.notEqual (after[0].hash, before[0].hash, 'the edit is a revision');
    const titled = await build (MD, '## 2026-11-02 New order endpoint\nWe added POST /order/v2 on 2026-11-01.\n');
    assert.notEqual (titled[0].id, before[0].id, 'title dates still key the entry');
});

test ('hash sources: dates inside the added lines are not the change date', async () => {
    const source: SourceConfig = { id: 'x-api', type: 'hash', url: 'https://example.com/api' };
    const [ e ] = await build (source, '<p>GET /a</p><p>New: GET /Order/OrderHistory (available since 2019-06-01)</p><p>Effective date: 2027-01-05</p>', '<p>GET /a</p>');
    assert.equal (e.publishedAt, null);
    assert.equal (e.effectiveDate, undefined);
    assert.equal (e.dateKind, 'firstSeen');
});

test ('displayTitle: a date title ending in a colon does not double it', () => {
    assert.equal (displayTitle ('2026-10-21:', 'Added UNAVAILABLE as a trading status.'), '2026-10-21: Added UNAVAILABLE as a trading status.');
    assert.equal (displayTitle ('2026-10-21', 'Added a field.'), '2026-10-21: Added a field.');
});
