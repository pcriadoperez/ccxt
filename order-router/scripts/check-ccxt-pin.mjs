#!/usr/bin/env node
// Fails when the ccxt version this service pins has drifted further from the version of the ccxt
// repository it lives in.
//
// The service depends on the PUBLISHED ccxt package at an exact version, deliberately: a router
// that silently picks up a new exchange implementation on every `npm ci` is not reproducible, and
// the box installs nothing at deploy time. The cost of that pin is that nothing pulls library
// fixes in — the pin sat thirteen patch releases behind the repo around it and no job, test or
// review step could see it, so a fix landed in ts/src never reached the deployed router and nobody
// found out until someone compared the two files by hand.
//
// This does not decide WHEN to upgrade — bumping the pin is a behaviour change and gets its own
// review. It decides that the gap is never invisible: the lag currently accepted is written down
// in package.json (`ccxtPin.acknowledgedRepoVersion`), and the moment the repo moves past it this
// exits non-zero and someone has to either bump the pin or consciously re-acknowledge the lag.
//
// Exit codes: 0 in sync or within the acknowledged lag, 1 unacknowledged drift, 2 malformed input.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(serviceRoot);

function readJson (path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        process.stderr.write(`cannot read ${path}: ${err instanceof Error ? err.message : err}\n`);
        process.exit(2);
    }
}

const pkg = readJson(join(serviceRoot, 'package.json'));
const repoPkg = readJson(join(repoRoot, 'package.json'));

const pinned = pkg?.dependencies?.ccxt;
const repoVersion = repoPkg?.version;
const acknowledged = pkg?.ccxtPin?.acknowledgedRepoVersion;

if (typeof pinned !== 'string' || pinned === '') {
    process.stderr.write('order-router/package.json has no ccxt dependency to check\n');
    process.exit(2);
}
if (typeof repoVersion !== 'string' || repoVersion === '') {
    process.stderr.write('the repository package.json has no version to compare against\n');
    process.exit(2);
}
// A range (^, ~, *) is not a pin and cannot drift in the way this guards against, but it also
// breaks the reproducibility the pin exists for, so it is a failure rather than a skip.
if (/^[^0-9]/.test(pinned)) {
    process.stderr.write(
        `order-router pins ccxt as "${pinned}" — the service must depend on an exact version so `
        + 'that the tree tested is the tree shipped\n');
    process.exit(1);
}

if (pinned === repoVersion) {
    process.stdout.write(`ccxt pin ${pinned} matches the repository version\n`);
    process.exit(0);
}

if (acknowledged !== repoVersion) {
    process.stderr.write(
        `::error::order-router pins ccxt ${pinned}; this repository is at ${repoVersion}. The lag `
        + `on record is against ${acknowledged ?? '<nothing>'}, so this is drift nobody has looked `
        + 'at. Either bump "dependencies.ccxt" in order-router/package.json (its own change, with '
        + `its own review) or set "ccxtPin.acknowledgedRepoVersion" to ${repoVersion} with a `
        + 'reason.\n');
    process.exit(1);
}

process.stdout.write(
    `::warning::order-router pins ccxt ${pinned} while this repository is at ${repoVersion}: `
    + `library fixes landed since ${pinned} are NOT in the deployed router. Acknowledged reason: `
    + `${pkg.ccxtPin.why ?? '(none given)'}\n`);
process.exit(0);
