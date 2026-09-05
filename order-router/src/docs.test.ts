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

// The README documents the systemd unit an operator pastes onto the box. Two of its lines are not
// decoration: without `Restart=`, the crash handlers — which log, flush and exit non-zero on the
// stated assumption that a supervisor restarts the process — end the service on the first
// unhandled rejection; without `ExecReload=`, the `systemctl reload order-router` the same README
// offers as the instant key-revocation path is an error, leaving a restart (and a full book-cache
// rebuild) as the only way to pick up a revocation early.
function systemdUnit (): string {
    const start = README.indexOf('# /etc/systemd/system/order-router.service');
    assert.notEqual(start, -1, 'the README should document the unit');
    const end = README.indexOf('```', start);
    return README.slice(start, end);
}

test('the documented systemd unit restarts the service it says a supervisor restarts', () => {
    assert.match(systemdUnit(), /^Restart=/m,
        'the crash strategy depends on a supervisor restart; the unit must ask for one');
});

test('the documented unit can actually reload, and the process answers the signal it is sent', () => {
    const unit = systemdUnit();
    const reload = /^ExecReload=.*$/m.exec(unit)?.[0] ?? '';
    assert.notEqual(reload, '', 'the README offers `systemctl reload` as the key-reload path');
    // The signal the unit sends must be the one the process handles, or reload succeeds and does
    // nothing — the worst of the three outcomes.
    const signal = /-([A-Z]+)\s+\$MAINPID/.exec(reload)?.[1] ?? '';
    const index = readFileSync(fileURLToPath(new URL('src/index.ts', root)), 'utf8');
    assert.ok(index.indexOf(`process.on('SIG${signal}'`) !== -1,
        `the unit sends SIG${signal}, which src/index.ts does not handle`);
});

test('every job in the order-router workflow bounds its own runtime', () => {
    // Without timeout-minutes a hung step holds a runner for the six-hour default. build-and-test
    // was the one job in the file without it.
    const workflow = readFileSync(
        fileURLToPath(new URL('.github/workflows/order-router.yml', new URL('../', root))), 'utf8');
    // Scoped to the `jobs:` block — `on:` has two-space keys of its own (push, pull_request).
    const jobsBlock = workflow.slice(workflow.indexOf('\njobs:\n'));
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
    assert.ok(jobs.length >= 4, `expected the workflow's jobs, found ${jobs.join(', ')}`);
    for (const job of jobs) {
        // From just past this job's own header line to the start of the next job's.
        const header = `\n  ${job}:\n`;
        const body = jobsBlock.slice(jobsBlock.indexOf(header) + header.length);
        const next = body.search(/^ {2}[a-z][a-z0-9-]*:$/m);
        const block = (next === -1) ? body : body.slice(0, next);
        assert.match(block, /^ {4}timeout-minutes:/m, `job ${job} has no timeout-minutes`);
    }
});
