import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A freshly-minted key is shown exactly once, and the hop from minting to rendering is the only
// moment its plaintext exists outside the caller's clipboard. The first version of this code put it
// in a redirect query string, which put a live key into /var/log/nginx/access.log — and would have
// sent it to github.com in a Referer header, since the footer links there.
//
// These are source-level assertions rather than behavioural ones on purpose: the property worth
// protecting is "the plaintext is never placed anywhere a URL is recorded", and the way that broke
// was a single template literal. A test that drives the app would pass just as happily with the key
// back in the query string, because functionally that version worked fine.

const SERVER = readFileSync(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8');

test('no plaintext key is ever placed in a redirect URL', () => {
    // The exact shape of the original defect.
    assert.equal(SERVER.includes('?new=${encodeURIComponent(plaintext)}'), false);
    for (const match of SERVER.matchAll(/reply\.redirect\(`([^`]*)`/g)) {
        const target = match[1]!;
        // Passing the plaintext INTO a function that returns an opaque id is fine — putting the
        // plaintext itself, or anything that renders it, into the URL is not. So inspect each
        // interpolated expression rather than the whole string.
        for (const expr of target.matchAll(/\$\{([^}]*)\}/g)) {
            const code = expr[1]!.trim();
            assert.equal(/^(encodeURIComponent\()?plaintext\)?$/.test(code), false,
                `a redirect puts the plaintext key in the URL: \${${code}}`);
        }
    }
});

test('the plaintext is never written to the database', () => {
    // The whole design stores keys only as digests. Writing the plaintext into a sessions row to
    // carry it across a redirect would make a leak of that table yield usable credentials.
    for (const match of SERVER.matchAll(/pool\.query\(\s*`([^`]*)`/g)) {
        const sql = match[1]!;
        if (!/INSERT|UPDATE/i.test(sql)) continue;
        assert.equal(/pending_key|plaintext_key|reveal_key/i.test(sql), false,
            `a statement looks like it persists a plaintext key: ${sql.slice(0, 90)}`);
    }
    // hash() is what reaches api_keys, never the plaintext itself.
    assert.ok(SERVER.includes('hashKey(plaintext)'), 'the key must be stored as a digest');
});

test('a reveal is single-use, session-bound and expiring', () => {
    // Each property removes a distinct failure: single-use so a replayed URL yields nothing; bound
    // to the session so a leaked id is useless to anyone else; expiring so an unread reveal does
    // not sit in memory for the life of the process.
    assert.ok(/reveals\.delete\(id\)/.test(SERVER), 'a reveal must be consumed on read');
    assert.ok(/entry\.sessionToken === sessionToken/.test(SERVER), 'a reveal must be session-bound');
    assert.ok(/entry\.expires < Date\.now\(\)/.test(SERVER), 'a reveal must expire');
    assert.ok(/randomBytes\(16\)/.test(SERVER), 'the reveal id must be unguessable');
    assert.ok(/for \(const \[id, entry\] of reveals\) if \(entry\.expires < now\)/.test(SERVER),
        'expired reveals must be swept, or the map grows for the life of the process');
});

test('the audit access line records the route template, never the raw URL', () => {
    // The router logs `route`, which is the Fastify route template. Logging request.url would put
    // any query string — including a reveal id, and historically a key — into the audit trail.
    const api = readFileSync(fileURLToPath(new URL('../api/server.ts', import.meta.url)), 'utf8');
    const accessLine = /event: 'request',[\s\S]*?'request completed'/.exec(api);
    assert.ok(accessLine, 'the access log line must exist');
    assert.equal(/request\.url/.test(accessLine[0]), false,
        'the access line must not log the raw URL, which carries the query string');
    assert.ok(/\n\s*route,/.test(accessLine[0]), 'it logs the route template instead');
});

test('the admin boundary distinguishes "not signed in" from "not an admin"', () => {
    // Both must be refused, but not identically. An anonymous caller learns nothing (404); a caller
    // holding a valid session is told which account they are on. Answering 404 to someone signed in
    // reads as "the feature is broken" rather than "you are on the wrong account" — which is
    // exactly how this was first reported.
    const guard = /const requireAdmin[\s\S]*?\n    \};/.exec(SERVER);
    assert.ok(guard, 'the admin guard must exist');
    assert.ok(/user === undefined[\s\S]*?code\(404\)/.test(guard[0]),
        'an anonymous caller must get 404, disclosing nothing');
    assert.ok(/!user\.isAdmin[\s\S]*?code\(403\)/.test(guard[0]),
        'a signed-in non-admin must get an explanatory 403, not a 404');
    // The check reads is_admin from the session record, which loadSession takes from the users
    // table on every request — never from anything the caller supplies.
    assert.ok(/const \{ user \} = await sessionOf\(request as never\)/.test(guard[0]),
        'admin status must come from the session, never from the request');
});

test('every admin route goes through the guard', () => {
    // A new admin route that forgets the guard is the way this boundary actually breaks.
    // A greedy window on purpose: a non-greedy one stops at the first newline, which is the line
    // the handler opens on, so it would never see the guard and would pass or fail for the wrong
    // reason.
    const routes = [...SERVER.matchAll(/`\$\{base\}(\/admin[^`]*)`/g)].map((m) => m[1]!);
    assert.ok(routes.length >= 2, `expected admin routes to exist, found ${routes.length}`);
    for (const route of routes) {
        const at = SERVER.indexOf(`\`\${base}${route}\``);
        const window = SERVER.slice(at, at + 400);
        assert.ok(/requireAdmin\(request, reply\)/.test(window),
            `admin route ${route} does not call requireAdmin`);
    }
});
