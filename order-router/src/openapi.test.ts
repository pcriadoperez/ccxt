import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GET /route and POST /route are ONE handler — the spec says so itself ("Identical parameters,
// identical answer, same handler"). So every status one verb can answer with, the other can, and
// the spec listed 404 and 501 under GET only. POST is the verb the spec tells callers to use when
// their holdings would otherwise end up in a URL, so the incomplete half was the recommended one.
//
// Parsed as text rather than YAML: this package has no YAML dependency, and adding one to assert a
// property that is visible in the indentation would be the wrong trade.

const SPEC = readFileSync(fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url)), 'utf8');

function verbBlock (path: string, verb: string): string {
    const pathStart = SPEC.indexOf(`\n  ${path}:\n`);
    assert.notEqual(pathStart, -1, `no ${path} in the spec`);
    const rest = SPEC.slice(pathStart + 1);
    const nextPath = rest.slice(1).search(/^ {2}\/[^\n]*:$/m);
    const block = (nextPath === -1) ? rest : rest.slice(0, nextPath + 1);
    const verbStart = block.indexOf(`\n    ${verb}:\n`);
    assert.notEqual(verbStart, -1, `no ${verb} on ${path}`);
    const afterVerb = block.slice(verbStart + 1);
    const nextVerb = afterVerb.slice(1).search(/^ {4}[a-z]+:$/m);
    return (nextVerb === -1) ? afterVerb : afterVerb.slice(0, nextVerb + 1);
}

function statuses (path: string, verb: string): string[] {
    return [...verbBlock(path, verb).matchAll(/^ {8}'(\d{3})':/gm)].map((m) => m[1]!).sort();
}

test('POST /route documents every status GET /route does', () => {
    const get = statuses('/route', 'get');
    assert.ok(get.indexOf('404') !== -1 && get.indexOf('501') !== -1,
        `the GET side should carry the interesting statuses, got ${get.join(', ')}`);
    assert.deepEqual(statuses('/route', 'post'), get,
        'one handler serves both verbs, so their documented statuses cannot differ');
});

test('the spec does not claim /health is the only unauthenticated route', () => {
    // /ready is the next path in the same file and is equally unauthenticated. A caller who
    // believes the claim wires their orchestrator to the probe that answers 200 while the cache is
    // still filling, because they think it is the only one they can reach.
    const health = verbBlock('/health', 'get');
    assert.equal(/only unauthenticated route/.test(health), false, health.slice(0, 200));
    assert.match(verbBlock('/ready', 'get'), /security: \[\]/,
        '/ready is in fact unauthenticated, which is what makes the claim wrong');
});
