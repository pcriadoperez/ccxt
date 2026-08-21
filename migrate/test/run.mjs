// Snapshot tests for the ccxt-migrate codemod.
//
// Every test/fixtures/<name>.input.<ext> is transformed and compared against
// <name>.expected.<ext>. Refresh the snapshots with:
//     UPDATE_SNAPSHOTS=1 npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformTypeScript } from '../js/transform-ts.js';
import { transformPython } from '../js/transform-py.js';

const here = path.dirname (fileURLToPath (import.meta.url));
const fixtures = path.join (here, 'fixtures');

for (const file of fs.readdirSync (fixtures).sort ()) {
    const m = file.match (/^(.+)\.input(\.\w+)$/);
    if (!m) {
        continue;
    }
    const [ , name, ext ] = m;
    test (name + ext, () => {
        const source = fs.readFileSync (path.join (fixtures, file), 'utf8');
        const result = (ext === '.py') ? transformPython (source) : transformTypeScript (source);
        const snapshot = path.join (fixtures, name + '.expected' + ext);
        if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync (snapshot)) {
            fs.writeFileSync (snapshot, result.code, 'utf8');
            return;
        }
        assert.equal (result.code, fs.readFileSync (snapshot, 'utf8'));
    });
}

test ('leaves non-pmxt sources untouched', () => {
    const source = 'import ccxt from "ccxt";\nconst e = new ccxt.binance();\n';
    assert.equal (transformTypeScript (source).patch.changed, false);
    assert.equal (transformPython ('import ccxt\ne = ccxt.binance()\n').patch.changed, false);
});

test ('is idempotent — a second pass changes nothing', () => {
    const source = fs.readFileSync (path.join (fixtures, 'bot.input.ts'), 'utf8');
    const once = transformTypeScript (source).code;
    assert.equal (transformTypeScript (once).code, once);
});
