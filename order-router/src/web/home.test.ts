import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { homePage } from './views/home.js';
import { buildWebServer } from './server.js';
import type { Pool } from '../db/pool.js';

// The hero animation makes an argument with numbers: that fee-adjusting BEFORE comparing changes
// which venue wins. If those numbers drift out of agreement the animation quietly teaches the
// opposite of what the router does — which is worse than having no animation at all.

const HTML = homePage('/router', undefined);
const CSS = readFileSync(fileURLToPath(new URL('./public/styles.css', import.meta.url)), 'utf8');

function figures (): { name: string; raw: number; feePct: number; eff: number }[] {
    const rows = [...HTML.matchAll(
        /<span class="rt-venue">([a-z]+)<\/span>[\s\S]*?<span class="rt-raw">([\d,]+)<\/span>\s*<span class="rt-fee">\+([\d.]+)%<\/span>\s*<span class="rt-eff">([\d,]+)<\/span>/g)];
    return rows.map((m) => ({
        name: m[1]!,
        raw: Number(m[2]!.replace(/,/g, '')),
        feePct: Number(m[3]!),
        eff: Number(m[4]!.replace(/,/g, '')),
    }));
}

test('every fee-adjusted price on the hero is arithmetically correct', () => {
    const rows = figures();
    assert.equal(rows.length, 4, 'expected four venues in the animation');
    for (const r of rows) {
        assert.equal(Math.round(r.raw * (1 + r.feePct / 100)), r.eff,
            `${r.name}: ${r.raw} + ${r.feePct}% should be ${Math.round(r.raw * (1 + r.feePct / 100))}, page says ${r.eff}`);
    }
});

test('the venue with the cheapest raw price is NOT the cheapest after fees', () => {
    // This is the entire point of the animation. If it ever stops being true the illustration is
    // making the opposite argument to the product.
    const rows = figures();
    const cheapestRaw = [...rows].sort((a, b) => a.raw - b.raw)[0]!;
    const cheapestReal = [...rows].sort((a, b) => a.eff - b.eff)[0]!;
    assert.notEqual(cheapestRaw.name, cheapestReal.name,
        'the animation only teaches anything if fees change the winner');
    // And the reversal should be dramatic enough to see: the raw winner ends up last.
    const rankByEff = [...rows].sort((a, b) => a.eff - b.eff).map((r) => r.name);
    assert.equal(rankByEff[rankByEff.length - 1], cheapestRaw.name,
        'the cheapest raw venue should end up the most expensive real one');
});

test('the quoted saving matches the split it shows', () => {
    const rows = figures();
    const byEff = [...rows].sort((a, b) => a.eff - b.eff);
    // The fill widths in the CSS are what the bars actually render: 0.62 and 0.38.
    const split = 0.62 * byEff[0]!.eff + 0.38 * byEff[1]!.eff;
    const quotedPay = Number(/<span class="lbl">pay<\/span> ([\d,]+) USDT/.exec(HTML)![1]!.replace(/,/g, ''));
    assert.ok(Math.abs(split - quotedPay) < 1,
        `the quoted price ${quotedPay} should equal the split it draws (${split.toFixed(1)})`);

    const quotedBps = Number(/([\d.]+) bps better/.exec(HTML)![1]!);
    // Must stay inside the range actually measured for this router, or it is a claim we cannot back.
    assert.ok(quotedBps >= 0.19 && quotedBps <= 2.2,
        `${quotedBps} bps is outside the measured 0.19-2.2 bps band`);
});

test('the animation collapses to a readable final frame without motion', () => {
    // Motion is decoration; the argument has to survive prefers-reduced-motion, and the rows must
    // land in their fee-adjusted order rather than their raw one.
    const block = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/.exec(CSS);
    assert.ok(block, 'a reduced-motion block must exist');
    assert.ok(/animation: none !important/.test(block[0]), 'animation must be disabled');
    assert.ok(/\.rt \.rt-eff[^}]*opacity: 1/.test(block[0]) || /rt-eff.*opacity: 1/.test(block[0]),
        'the fee-adjusted column must be visible when motion is off');
    assert.ok(/r-kucoin\s*\{\s*transform: translateY\(0\)/.test(block[0]),
        'the cheapest real venue must land first in the static frame');
});

test('the page drives to signup and states what the router is not', () => {
    assert.ok((HTML.match(/\/router\/signup/g) ?? []).length >= 3, 'the call to action should recur');
    assert.match(HTML, /never holds funds and never places trades/,
        'a trader asks this first; the homepage must answer it without being asked');
});

// ---------------------------------------------------------------------------
// H10: headers, and whose X-Forwarded-For this console believes
// ---------------------------------------------------------------------------

// The three pages asserted below are the anonymous ones, and loadSession returns early when there
// is no cookie — so none of them reaches Postgres. The pool therefore throws: if a future change
// makes a public page query the database, this fails loudly rather than quietly needing a
// container to run.
function noDatabase (): Pool {
    return {
        query: () => { throw new Error('a public console page must not touch the database'); },
        connect: () => { throw new Error('a public console page must not touch the database'); },
    } as unknown as Pool;
}

async function buildTestConsole (over: { trustProxy?: boolean } = {}): Promise<{
    app: Awaited<ReturnType<typeof buildWebServer>>; lastIp: () => string | undefined;
}> {
    let lastIp: string | undefined;
    const app = await buildWebServer({
        pool: noDatabase(),
        logger: pino({ level: 'silent' }),
        base: '',
        keysFile: '/nonexistent/keys.json',
        csrfSecret: 'test-csrf-secret',
        secureCookies: false,
        allowedOrigins: [],
        ...over,
    });
    app.addHook('onRequest', async (request) => { lastIp = request.ip; });
    return { app, lastIp: () => lastIp };
}

test('every console response carries the security headers', async () => {
    // This console renders API keys. A page that can be framed is a clickjacking target, and a
    // response a browser is free to MIME-sniff is an XSS one. None of these headers were set.
    const { app } = await buildTestConsole();
    const response = await app.inject({ method: 'GET', url: '/' });
    const csp = String(response.headers['content-security-policy']);
    assert.ok(csp.indexOf("frame-ancestors 'none'") !== -1, csp);
    assert.ok(csp.indexOf("object-src 'none'") !== -1, csp);
    assert.ok(csp.indexOf("script-src 'self'") !== -1, csp);
    // The point of keeping every script in an external file: no 'unsafe-inline' for scripts.
    assert.equal(csp.indexOf("script-src 'self' 'unsafe-inline'"), -1, csp);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'same-origin');
    await app.close();
});

test('no page ships an inline event handler the policy would block', async () => {
    // A CSP without 'unsafe-inline' silently breaks any onclick= that slips back in — the button
    // simply stops doing what it says. Two of them had already appeared before the policy existed,
    // so this asserts the rule rather than trusting a comment in app.js to enforce it.
    const { app } = await buildTestConsole();
    for (const url of [ '/', '/login', '/signup' ]) {
        const body = (await app.inject({ method: 'GET', url })).body;
        assert.equal(/\son[a-z]+\s*=\s*["']/.test(body), false, `inline handler in ${url}`);
    }
    await app.close();
});

test('X-Forwarded-For is only believed when the deployment says to believe it', async () => {
    // trustProxy was unconditionally true. The console's rate limiter buckets by request.ip, so a
    // header the client chooses defeated it outright: rotate X-Forwarded-For and get unlimited
    // password guesses against /login.
    const untrusting = await buildTestConsole({ trustProxy: false });
    const a = await untrusting.app.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.equal(a.statusCode, 200);
    assert.equal(untrusting.lastIp(), '127.0.0.1', 'the socket address, not the header');
    await untrusting.app.close();

    const trusting = await buildTestConsole({ trustProxy: true });
    await trusting.app.inject({ method: 'GET', url: '/', headers: { 'x-forwarded-for': '9.9.9.9' } });
    assert.equal(trusting.lastIp(), '9.9.9.9', 'behind a real proxy the header is the client');
    await trusting.app.close();
});

test('console responses are not cacheable, static assets still are', async () => {
    // A console page can carry a freshly-minted `or_live_…` key in its body, and every
    // authenticated page is personalised by the session cookie. With no Cache-Control at all, a
    // shared proxy — or the browser's own back/forward cache and disk cache — is free to store
    // that response and hand it to the next request. `Vary: Cookie` is the second half: without
    // it a cache may serve one user's console page to another.
    const { app } = await buildTestConsole();
    for (const url of [ '/', '/login', '/signup' ]) {
        const response = await app.inject({ method: 'GET', url });
        const cc = String(response.headers['cache-control']);
        assert.ok(cc.indexOf('no-store') !== -1, `${url} is cacheable: ${cc}`);
        assert.equal(response.headers['pragma'], 'no-cache', url);
        assert.ok(String(response.headers['vary']).toLowerCase().indexOf('cookie') !== -1,
            `${url} does not vary on the session cookie: ${String(response.headers['vary'])}`);
    }
    // Static assets are public, immutable-ish and hot: making them uncacheable would be a
    // self-inflicted performance regression, so the rule has to be scoped.
    const asset = await app.inject({ method: 'GET', url: '/static/styles.css' });
    assert.equal(asset.statusCode, 200);
    assert.equal(String(asset.headers['cache-control'] ?? '').indexOf('no-store'), -1,
        'static assets should stay cacheable');
    await app.close();
});
