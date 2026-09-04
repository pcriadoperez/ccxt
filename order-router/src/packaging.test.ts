import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `docker compose up --build` is documented as a way to run this service, and it could not work:
// the build stage COPYed only package files, tsconfig and src, while `npm run build` also reads
// openapi/openapi.yaml (copy-assets) and scripts/write-build-info.mjs (build:info). The failure is
// a build-time crash, so nobody who did not actually run it would notice.
//
// These are source-level assertions because the behavioural one needs a Docker daemon, which CI
// for this directory does not have. They read the real build script and assert the Dockerfile
// carries whatever it reaches for, so a third asset directory fails here rather than in somebody's
// terminal.

const root = new URL('../', import.meta.url);
const dockerfile = readFileSync(fileURLToPath(new URL('Dockerfile', root)), 'utf8');
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('package.json', root)), 'utf8'));

function copiedPaths (): string[] {
    return [...dockerfile.matchAll(/^COPY\s+(?!--from)(.+)$/gm)]
        .flatMap((m) => m[1]!.trim().split(/\s+/).slice(0, -1));
}

test('the build stage copies every directory the build script reads', () => {
    // Only the scripts the image actually runs: `npm run build` and everything it chains into.
    // benchmark/ and the live-integration harness are developer tools that never enter an image.
    const scripts: string[] = [ 'build', 'copy-assets', 'build:info' ].map((n) => pkg.scripts[n]);
    const copied = copiedPaths();
    // Every top-level directory named by a build script: `openapi/openapi.yaml`, `scripts/x.mjs`.
    const needed = new Set<string>();
    for (const script of scripts) {
        for (const m of script.matchAll(/(?:^|['"\s(])([a-z][a-z-]*)\/[A-Za-z0-9_.-]+/g)) {
            const dir = m[1]!;
            if (dir === 'dist' || dir === 'node_modules') continue;
            if (existsSync(fileURLToPath(new URL(dir, root)))) needed.add(dir);
        }
    }
    assert.ok(needed.has('openapi') && needed.has('scripts'),
        `the scan should find the known asset dirs, found: ${[...needed].join(', ')}`);
    for (const dir of needed) {
        assert.ok(copied.some((c) => c === dir || c.indexOf(`${dir}/`) === 0),
            `the build script reads ${dir}/ but the Dockerfile never COPYs it`);
    }
});

test('the runtime stage does not run as root and declares a readiness probe', () => {
    assert.ok(/^USER node$/m.test(dockerfile), 'the runtime stage should drop root');
    // /health answers 200 while the cache is still filling, so an orchestrator that waits on it
    // sends traffic to a router with no books.
    const healthcheck = /^HEALTHCHECK[\s\S]*?(?=\nCMD )/m.exec(dockerfile)?.[0] ?? '';
    assert.ok(healthcheck.length > 0, 'no HEALTHCHECK');
    assert.ok(healthcheck.indexOf('/ready') !== -1, 'the probe should hit /ready, not /health');
});

test('a .dockerignore keeps the host build tree out of the image context', () => {
    // Without one the context upload includes node_modules and .git, and a stray host-built dist/
    // can shadow the one the image builds.
    const ignore = readFileSync(fileURLToPath(new URL('.dockerignore', root)), 'utf8');
    for (const entry of [ 'node_modules', 'dist', '.git' ]) {
        assert.ok(ignore.split('\n').some((l) => l.trim() === entry), `missing ${entry}`);
    }
});
