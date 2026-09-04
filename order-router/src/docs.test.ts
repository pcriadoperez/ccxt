import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The README documented an entire key-management CLI — `npm run keys:create/list/revoke/delete` —
// that had never existed under those names, including the revoke command an operator would reach
// for on a leaked key. Nothing catches that class of drift by reading: the commands look plausible,
// and the person who needs them is having a bad day already.
//
// So the commands the README tells an operator to run are checked against the ones that exist.

const root = new URL('../', import.meta.url);
const README = readFileSync(fileURLToPath(new URL('README.md', root)), 'utf8');
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8')) as {
    scripts: Record<string, string>;
};
const ADMIN_CLI = readFileSync(fileURLToPath(new URL('src/cli/admin.ts', root)), 'utf8');

test('every `npm run` command in the README exists in package.json', () => {
    const referenced = new Set(
        [...README.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)].map((m) => m[1]!),
    );
    const missing = [...referenced].filter((name) => pkg.scripts[name] === undefined).sort();
    assert.deepEqual(missing, [],
        'the README tells an operator to run scripts that do not exist:\n  ' + missing.join('\n  '));
});

test('every documented `npm run admin --` subcommand is one the CLI handles', () => {
    // The script exists, so the check above passes for anything of the form `npm run admin -- x`;
    // the subcommand is what actually has to be there.
    const documented = new Set(
        [...README.matchAll(/npm run admin -- ([a-z][a-z-]*)/g)].map((m) => m[1]!),
    );
    assert.ok(documented.size > 0, 'the README should document how to bootstrap an admin');
    const handled = new Set(
        [...ADMIN_CLI.matchAll(/command === '([a-z-]+)'/g)].map((m) => m[1]!),
    );
    for (const sub of documented) {
        assert.ok(handled.has(sub), `README documents \`admin ${sub}\`, which the CLI does not handle`);
    }
});

test('the CLI usage line lists every command it handles', () => {
    // `create-key` was missing from it, so the one command an operator needs at 3am to mint a
    // break-glass key was invisible to anyone who ran the CLI wrong to find out what it did.
    const usage = /usage: admin <([a-z|-]+)>/.exec(ADMIN_CLI)?.[1] ?? '';
    const listed = new Set(usage.split('|'));
    const handled = [...ADMIN_CLI.matchAll(/command === '([a-z-]+)'/g)].map((m) => m[1]!);
    for (const command of handled) {
        assert.ok(listed.has(command), `\`${command}\` is handled but missing from the usage line`);
    }
});
