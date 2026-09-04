#!/usr/bin/env node
// Emits dist/build-info.json — the only thing that lets a running process answer "which commit am
// I?". Written at BUILD time rather than read at start time on purpose: the artifact that gets
// shipped has to carry its own provenance, or a deploy that silently no-ops (tarball never landed,
// symlink never swapped, unit never restarted) is indistinguishable from a successful one. The
// post-deploy live test asserts this value equals the commit CI just pushed, so a no-op deploy is
// a red build instead of a quiet lie.
//
// Resolution order is deliberate: an explicit override beats CI's own SHA, which beats whatever the
// working tree happens to be on. Nothing here throws — a build outside a git checkout (a tarball, a
// container layer) still produces a valid file, it just reports `unknown`, and an `unknown` commit
// is a legible failure at deploy time rather than a broken build.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function gitHead () {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

const commit = (process.env['ORDER_ROUTER_BUILD_SHA']
    || process.env['GITHUB_SHA']
    || gitHead()
    || 'unknown').trim();

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const info = {
    version: pkg.version ?? '0.0.0',
    commit,
    commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 12),
    builtAt: new Date().toISOString(),
    // Distinguishes "this came off the pipeline" from "someone built it on their laptop and scp'd
    // it up", which is exactly the question asked when a box is serving something unexpected.
    builtBy: process.env['GITHUB_ACTIONS'] === 'true' ? 'ci' : 'local',
};

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
process.stdout.write(`build-info: ${info.commitShort} (${info.builtBy}) at ${info.builtAt}\n`);
