import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The README's config table was 20 variables behind the code — every database, web-console,
// ingest, shard-memory and routing-penalty knob was undocumented, and so were the two added while
// writing this. Patching the table once fixes it until the next variable, so the drift is what is
// tested rather than the table's current contents: an operator reading the README should not have
// to guess whether it is complete, and the answer should not depend on who last remembered.

const CONFIG = readFileSync(fileURLToPath(new URL('./config.ts', import.meta.url)), 'utf8');
const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

// Variables read by config.ts that belong in someone else's documentation.
const DOCUMENTED_ELSEWHERE = new Set([
    // Standard, and covered by the deployment sections rather than the knob table.
    'NODE_ENV',
]);

function envReadsInConfig (): string[] {
    const names = new Set<string>();
    for (const m of CONFIG.matchAll(/process\.env\['([A-Z0-9_]+)'\]/g)) names.add(m[1]!);
    for (const m of CONFIG.matchAll(/(?:numberFromEnv|boolFromEnv)\('([A-Z0-9_]+)'/g)) names.add(m[1]!);
    return [...names].filter((n) => !DOCUMENTED_ELSEWHERE.has(n)).sort();
}

test('every environment variable config.ts reads is documented in the README', () => {
    const missing = envReadsInConfig().filter((name) => README.indexOf(name) === -1);
    assert.deepEqual(missing, [],
        'undocumented environment variables — add a row to the README config table:\n  ' + missing.join('\n  '));
});

test('the README documents no environment variable config.ts stopped reading', () => {
    // The other direction. A removed knob that still has a row sends an operator to set something
    // with no effect, which is worse than no row at all.
    // Scoped to the config table: the deploy sections list GitHub SECRETS in the same row shape,
    // and those are read by the workflow, not by this process.
    const table = README.slice(README.indexOf('## Config (env vars)'));
    const rows = [...table.slice(0, table.indexOf('\n## ', 4)).matchAll(/^\| `([A-Z0-9_]+)`/gm)].map((m) => m[1]!);
    // Read by other modules rather than config.ts, so absence here is expected.
    const readElsewhere = new Set([ 'ORDER_ROUTER_API_KEY', 'ORDER_ROUTER_CSRF_SECRET', 'PORT', 'LOG_LEVEL' ]);
    const stale = rows.filter((name) => !readElsewhere.has(name) && CONFIG.indexOf(`'${name}'`) === -1);
    assert.deepEqual([...new Set(stale)], [], 'documented but no longer read by config.ts');
});

test('the endpoints table lists every route the API server registers', () => {
    // The table is the first thing a caller reads. /ready, /metrics and POST /route were all
    // registered and none of them were in it.
    const server = readFileSync(fileURLToPath(new URL('./api/server.ts', import.meta.url)), 'utf8');
    const routes = new Set<string>();
    for (const m of server.matchAll(/app\.(get|post)(?:<[^>]*>)?\(\s*(?:`|')([^`']+)(?:`|')/g)) {
        routes.add(`${m[1]!.toUpperCase()} ${m[2]!}`);
    }
    const missing = [...routes].filter((r) => {
        const path = r.split(' ')[1]!;
        // Parameterised paths appear in the table with their parameter names spelled out.
        // A parameterised path is documented as `/orderbook/:exchange/:symbol`, so match on the
        // fixed prefix rather than on the whole pattern.
        const needle = path.split('/:')[0]!.split('?')[0]!;
        return README.indexOf(needle) === -1;
    }).sort();
    assert.deepEqual(missing, [], 'routes missing from the README endpoints table');
});
