import { readFileSync } from 'node:fs';

// Provenance of the running process, baked in at build time by scripts/write-build-info.mjs and
// served by GET /version. The point is deploy verification: /health proves *a* process is up, and
// that is exactly the assertion a failed deploy also passes. Only the commit distinguishes "the
// new build is live" from "the old one never stopped".
export interface BuildInfo {
    version: string;
    commit: string;
    commitShort: string;
    builtAt: string | null;
    builtBy: string;
}

// Reported rather than thrown when the file is absent, because absence is the normal case in dev:
// `tsx src/index.ts` runs from src/, where no build ever wrote one. A dev server that refuses to
// start over a missing provenance file would be a self-inflicted outage; a dev server that reports
// `unknown` is honest, and the deploy assertion rejects `unknown` on its own side.
const UNKNOWN: BuildInfo = {
    version: '0.0.0',
    commit: 'unknown',
    commitShort: 'unknown',
    builtAt: null,
    builtBy: 'unknown',
};

let cached: BuildInfo | null = null;

function load (): BuildInfo {
    try {
        // Resolved relative to the compiled module (dist/buildInfo.js -> dist/build-info.json) so it
        // follows the release tree wherever it is unpacked. An absolute path or a CWD-relative one
        // would break the moment the unit runs from a different directory — which the release-dir
        // symlink layout guarantees it eventually will.
        const raw = readFileSync(new URL('./build-info.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw) as Partial<BuildInfo>;
        const commit = typeof parsed.commit === 'string' && parsed.commit.length > 0
            ? parsed.commit
            : UNKNOWN.commit;
        return {
            version: typeof parsed.version === 'string' ? parsed.version : UNKNOWN.version,
            commit,
            commitShort: typeof parsed.commitShort === 'string' ? parsed.commitShort : commit.slice(0, 12),
            builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null,
            builtBy: typeof parsed.builtBy === 'string' ? parsed.builtBy : UNKNOWN.builtBy,
        };
    } catch {
        return UNKNOWN;
    }
}

export function buildInfo (): BuildInfo {
    // Cached because the answer cannot change while the process lives — and because /version is the
    // endpoint a deploy pipeline polls in a loop, which is the wrong place to do disk I/O per hit.
    cached ??= load();
    return cached;
}
