// A stub shard worker for orchestrator.test.ts. The real worker opens live exchange websockets on
// `init`, so the parent's respawn/shutdown bookkeeping can only be exercised against a stand-in.
//
// Crashes exactly once: the first process to run creates the marker file and exits non-zero, which
// is what makes the parent's respawn path run; every later process finds the marker and stays
// alive, so the test has a stable replacement to assert on.
import { existsSync, writeFileSync } from 'node:fs';

const marker = process.env['ORCHESTRATOR_STUB_MARKER'];
process.on('message', () => {
    process.send?.({ type: 'stub-started', pid: process.pid });
    if (marker && existsSync(marker)) {
        setInterval(() => {}, 1000);
        return;
    }
    if (marker) writeFileSync(marker, 'crashed once');
    setTimeout(() => process.exit(3), 10);
});
