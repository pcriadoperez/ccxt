#!/usr/bin/env node
// Post-deploy integration tests against a RUNNING order-router. Read-only by construction: every
// request below is a GET against /health, /version, /symbols, /route or /metrics. It never places,
// edits or cancels an order — there is no code path here that could.
//
// Runnable by hand against any deployment, which is the point. CI is not a special caller:
//
//   ROUTER_BASE_URL=https://docs.ccxt.com/router/api \
//   ROUTER_API_KEY=or_live_... \
//   node scripts/live-integration.mjs
//
// Optional:
//   ROUTER_EXPECT_COMMIT   40-char SHA the deployment must report. Set in CI to github.sha; when
//                          unset the commit is only required to be present and not "unknown".
//   ROUTER_MAX_UPTIME_SEC  how long the process may have been up and still count as "this deploy"
//                          (default 900). Only enforced when ROUTER_EXPECT_COMMIT is set, because
//                          only then is the run verifying a deployment rather than inspecting one.
//   ROUTER_FROM/ROUTER_TO/ROUTER_AMOUNT_OUT   the probe route (default USDT -> BTC, 0.01).
//   ROUTER_WARMUP_MS       how long to wait for the book cache to warm (default 180000). A restart
//                          rebuilds every book, so /route legitimately answers "no route" for
//                          minutes after a deploy; /health and auth are asserted immediately.
//   ROUTER_TIMEOUT_MS      per-request timeout (default 30000).
//
// Exit codes: 0 all assertions passed, 1 at least one failed, 2 misconfigured (no URL/key).

const BASE = (process.env['ROUTER_BASE_URL'] ?? '').replace(/\/+$/, '');
const KEY = process.env['ROUTER_API_KEY'] ?? '';
const EXPECT_COMMIT = (process.env['ROUTER_EXPECT_COMMIT'] ?? '').trim();
const MAX_UPTIME_SEC = Number(process.env['ROUTER_MAX_UPTIME_SEC'] ?? '900');
const FROM = process.env['ROUTER_FROM'] ?? 'USDT';
const TO = process.env['ROUTER_TO'] ?? 'BTC';
const AMOUNT_OUT = Number(process.env['ROUTER_AMOUNT_OUT'] ?? '0.01');
const WARMUP_MS = Number(process.env['ROUTER_WARMUP_MS'] ?? '180000');
const TIMEOUT_MS = Number(process.env['ROUTER_TIMEOUT_MS'] ?? '30000');

if (BASE === '' || KEY === '') {
    process.stderr.write(
        'usage: ROUTER_BASE_URL=<https://host/router/api> ROUTER_API_KEY=<or_live_...> '
        + 'node scripts/live-integration.mjs\n',
    );
    process.exit(2);
}

// ---------------------------------------------------------------------------
// Harness. Every assertion is named, its observed value is printed whether it passes or fails, and
// a failure is recorded rather than thrown — one broken endpoint should still report on the other
// eight. The process exits non-zero if anything failed; a live test that goes green against a
// broken service is worse than no live test at all, so there is no "warn" tier and nothing is
// skipped silently: a check that cannot run is a failure.
// ---------------------------------------------------------------------------
const results = [];
let currentDetail = '';

function detail (text) {
    currentDetail = text;
}

async function check (name, fn) {
    currentDetail = '';
    const started = Date.now();
    try {
        await fn();
        results.push({ name, ok: true, detail: currentDetail, ms: Date.now() - started });
        process.stdout.write(`PASS  ${name}${currentDetail ? `  — ${currentDetail}` : ''}\n`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name, ok: false, detail: message, ms: Date.now() - started });
        process.stdout.write(`FAIL  ${name}\n        ${message.replace(/\n/g, '\n        ')}\n`);
    }
}

function assert (condition, message) {
    if (!condition) throw new Error(message);
}

async function request (path, { key = KEY, accept = 'json' } = {}) {
    const headers = {};
    if (key !== null) headers['x-api-key'] = key;
    let response;
    try {
        response = await fetch(`${BASE}${path}`, {
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: 'manual',
        });
    } catch (err) {
        throw new Error(`GET ${path} failed at the transport layer: ${err instanceof Error ? err.message : err}`);
    }
    const text = await response.text();
    if (accept === 'text') return { status: response.status, text };
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        // Left null: callers that need a body assert on it and report the raw text, which is what
        // an nginx error page or a proxy timeout actually looks like from here.
    }
    return { status: response.status, text, json };
}

function num (value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function short (text, max = 300) {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

const routePath = (params) => {
    const query = new URLSearchParams({ from: FROM, to: TO, ...params });
    return `/route?${query.toString()}`;
};

// ---------------------------------------------------------------------------
// 1. Liveness. Cheap, unauthenticated, and first because everything after it is noise if the
//    service is not answering at all.
// ---------------------------------------------------------------------------
await check('GET /health returns ok', async () => {
    const { status, json, text } = await request('/health', { key: null });
    assert(status === 200, `expected 200, got ${status}: ${short(text)}`);
    assert(json?.status === 'ok', `expected {"status":"ok"}, got ${short(text)}`);
    assert(num(json?.uptimeSec), `expected a numeric uptimeSec, got ${short(text)}`);
    detail(`uptime ${Math.round(json.uptimeSec)}s`);
});

// ---------------------------------------------------------------------------
// 2. THE assertion. Everything else here can pass against the PREVIOUS build: /health, auth, /route
//    and /metrics all answer exactly the same from a process the deploy failed to replace. This is
//    the only check that fails when a deploy silently no-ops, which is why it is not optional and
//    why the expected value is not defaulted to anything permissive.
// ---------------------------------------------------------------------------
await check('GET /version reports the deployed commit', async () => {
    const { status, json, text } = await request('/version');
    assert(status === 200, `expected 200, got ${status}: ${short(text)}`
        + (status === 404
            ? '  — the deployed build predates the /version endpoint, so it CANNOT be verified'
            : ''));
    const commit = json?.commit;
    assert(typeof commit === 'string' && commit.length > 0, `no commit in ${short(text)}`);
    assert(commit !== 'unknown',
        'the deployment reports commit "unknown": it was built outside a git checkout and with no '
        + 'ORDER_ROUTER_BUILD_SHA/GITHUB_SHA, so what is running cannot be identified');
    // The commit alone cannot see a redeploy of an UNCHANGED SHA whose systemctl restart failed:
    // the survivor process reports the expected commit and every other assertion here passes
    // against it. Node resolves module realpaths, so a process that started before the symlink
    // moved keeps reading its own release's build-info.json — the commit will match. Only the
    // uptime distinguishes "the new build is answering" from "the old one never went away", which
    // is exactly the case the README says this check covers and the case a workflow_dispatch or a
    // hand-run after manual intervention on the box actually produces.
    const uptimeSec = json?.uptimeSec;
    assert(num(uptimeSec),
        `no numeric uptimeSec in ${short(text)} — the deployed build predates it, so a failed `
        + 'restart cannot be told apart from a successful one');
    if (EXPECT_COMMIT !== '') {
        assert(commit === EXPECT_COMMIT,
            `deployed commit ${commit} != expected ${EXPECT_COMMIT} — the running process is NOT `
            + 'the build that was just pushed (tarball not unpacked, symlink not swapped, or the '
            + 'unit never restarted)');
        assert(uptimeSec < MAX_UPTIME_SEC,
            `the process reports commit ${commit} but has been up ${Math.round(uptimeSec)}s `
            + `(limit ${MAX_UPTIME_SEC}s): it predates this deploy, so the commit it reports is `
            + 'the one it was ALREADY running. Redeploying an unchanged SHA with a failed '
            + 'systemctl restart looks exactly like this. Raise ROUTER_MAX_UPTIME_SEC only if the '
            + 'deploy legitimately took longer than that.');
    }
    detail(`commit ${json.commitShort ?? commit} built ${json.builtAt ?? '?'} by ${json.builtBy ?? '?'}`
        + `, up ${Math.round(uptimeSec)}s since ${json.startedAt ?? '?'}`
        + `${EXPECT_COMMIT === '' ? '  (no ROUTER_EXPECT_COMMIT set — identity not pinned)' : ''}`);
});

// ---------------------------------------------------------------------------
// 3. Auth. Asserted before the routing checks because they run with a key, and "200 with a key" is
//    only meaningful once "401 without one" is established.
// ---------------------------------------------------------------------------
await check('an unauthenticated request is rejected with 401', async () => {
    const { status, text } = await request('/symbols', { key: null });
    assert(status === 401, `expected 401, got ${status}: ${short(text)}`);
});

await check('a wrong key is rejected with 401', async () => {
    const { status, text } = await request('/symbols', { key: 'or_live_definitely-not-a-real-key' });
    assert(status === 401, `expected 401, got ${status}: ${short(text)}`);
});

await check('the supplied key is accepted with 200', async () => {
    const { status, json, text } = await request('/symbols');
    assert(status === 200, `expected 200, got ${status}: ${short(text)}`);
    assert(Array.isArray(json?.symbols), `expected {symbols:[...]}, got ${short(text)}`);
    assert(json.symbols.length > 0, 'the routable symbol universe is empty');
    detail(`${json.symbols.length} symbols cached`);
});

// ---------------------------------------------------------------------------
// 4. Routing. A just-restarted router has an empty book cache and legitimately answers "no route"
//    for minutes, so this one step polls; every later routing assertion runs once, against the
//    response this step proved is available.
// ---------------------------------------------------------------------------
let route = null;
await check(`GET /route ${FROM}->${TO} returns a route`, async () => {
    const deadline = Date.now() + WARMUP_MS;
    let last = '';
    for (;;) {
        const { status, json, text } = await request(routePath({ amountOut: String(AMOUNT_OUT) }));
        last = `status ${status}: ${short(text)}`;
        if (status === 200 && Array.isArray(json?.hops) && json.hops.length > 0
            && num(json?.amountIn) && json.amountIn > 0) {
            route = json;
            break;
        }
        if (Date.now() >= deadline) {
            throw new Error(`no routable answer within ${Math.round(WARMUP_MS / 1000)}s — ${last}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    detail(`${route.hops.length} hop(s), ${route.hops.map((h) => h.pair).join(' -> ')}, `
        + `amountIn ${route.amountIn} ${FROM}`);
});

await check('the route has non-empty hops with venue legs', async () => {
    assert(route !== null, 'no route was obtained above');
    for (const [i, hop] of route.hops.entries()) {
        assert(Array.isArray(hop.legs) && hop.legs.length > 0, `hop ${i} (${hop.pair}) has no legs`);
        for (const leg of hop.legs) {
            assert(typeof leg.exchangeId === 'string' && leg.exchangeId.length > 0,
                `hop ${i} has a leg with no exchangeId`);
            assert(num(leg.amount) && leg.amount > 0, `hop ${i} has a leg with amount ${leg.amount}`);
        }
    }
    detail(route.hops.map((h) => `${h.pair}[${h.legs.map((l) => l.exchangeId).join('+')}]`).join(' -> '));
});

await check('fillRatio is > 0', async () => {
    assert(route !== null, 'no route was obtained above');
    assert(num(route.fillRatio), `fillRatio is not a number: ${route.fillRatio}`);
    assert(route.fillRatio > 0, `fillRatio is ${route.fillRatio} — nothing would fill`);
    assert(route.fillRatio <= 1.0000001, `fillRatio is ${route.fillRatio} — more than a full fill`);
    detail(`fillRatio ${route.fillRatio}`);
});

// Bounded against the route's OWN reference rate, never against a hardcoded price: BTC moves, and a
// test that has to be edited when it does is a test that gets deleted. referenceRate is the same
// books chained frictionlessly, so the only defensible bounds are "not better than frictionless"
// (impossible) and "not absurdly worse" (a broken book walk or an inverted rate).
await check('effectiveRate is sane against referenceRate', async () => {
    assert(route !== null, 'no route was obtained above');
    assert(num(route.effectiveRate) && route.effectiveRate > 0,
        `effectiveRate is ${route.effectiveRate}`);
    assert(num(route.referenceRate) && route.referenceRate > 0,
        `referenceRate is ${route.referenceRate}`);
    const ratio = route.effectiveRate / route.referenceRate;
    assert(ratio <= 1.000001,
        `effectiveRate ${route.effectiveRate} beats the frictionless referenceRate `
        + `${route.referenceRate} (ratio ${ratio}) — fees or impact are being applied backwards`);
    assert(ratio >= 0.9,
        `effectiveRate ${route.effectiveRate} is ${((1 - ratio) * 10000).toFixed(0)}bps worse than `
        + `referenceRate ${route.referenceRate} — implausible for ${AMOUNT_OUT} ${TO}`);
    // Independent cross-check: the headline rate must agree with the two amounts it summarises.
    // Catches a rate computed from the wrong side of the pair, which the bounds above would not.
    const implied = route.amountOut / route.amountIn;
    const drift = Math.abs(implied - route.effectiveRate) / implied;
    assert(drift < 1e-6,
        `effectiveRate ${route.effectiveRate} disagrees with amountOut/amountIn ${implied}`);
    assert(num(route.impactBps) && route.impactBps >= -1e-6 && route.impactBps < 1000,
        `impactBps ${route.impactBps} outside [0, 1000)`);
    detail(`effective ${route.effectiveRate.toExponential(6)} vs reference `
        + `${route.referenceRate.toExponential(6)} (${route.impactBps.toFixed(3)} bps impact)`);
});

// ---------------------------------------------------------------------------
// 5. balances, end to end. The feature is unverifiable from the outside without balancesApplied:
//    /route takes an untyped querystring, so a server that predates balances IGNORES the parameter
//    and answers byte-identically to one that honoured it. Asserting the echo is the whole point.
// ---------------------------------------------------------------------------
await check('balances= clamps the route and is echoed back', async () => {
    assert(route !== null, 'no route was obtained above');
    // Half of what the unconstrained route needed, rounded so the canonical echo is byte-comparable
    // (the server re-serialises the parsed Number, so 394.75 comes back as "USDT:394.75").
    const cap = Math.round((route.amountIn / 2) * 100) / 100;
    assert(cap > 0, `computed a non-positive cap from amountIn ${route.amountIn}`);
    const spec = `${FROM}:${cap}`;
    const { status, json, text } = await request(
        routePath({ amountOut: String(AMOUNT_OUT), balances: spec }),
    );
    assert(status === 200, `expected 200, got ${status}: ${short(text)}`);
    assert(json?.balancesApplied !== undefined,
        'the response has no balancesApplied field — this deployment predates the balances feature '
        + 'and silently ignored the constraint');
    assert(json.balancesApplied === spec,
        `balancesApplied is ${JSON.stringify(json.balancesApplied)}, expected ${JSON.stringify(spec)}`);
    assert(json.balanceEntryCount === 1, `balanceEntryCount is ${json.balanceEntryCount}, expected 1`);
    assert(json.balanceMode === 'cap', `balanceMode is ${json.balanceMode}, expected "cap"`);
    assert(num(json.balanceCapAmountIn),
        `balanceCapAmountIn is ${json.balanceCapAmountIn}, expected a number`);
    assert(Math.abs(json.balanceCapAmountIn - cap) < 1e-9,
        `balanceCapAmountIn ${json.balanceCapAmountIn} != the ${cap} that was sent`);
    // The clamp has to bind: spending more than the wallet holds is the failure this exists to stop.
    assert(num(json.amountIn) && json.amountIn <= cap * 1.000001,
        `amountIn ${json.amountIn} exceeds the ${cap} ${FROM} cap`);
    assert(num(json.fillRatio) && json.fillRatio > 0 && json.fillRatio < 1,
        `fillRatio is ${json.fillRatio} — half the funds should produce a partial fill`);
    assert(Array.isArray(json.hops) && json.hops.length > 0,
        'the clamped route came back with no hops');
    detail(`cap ${cap} ${FROM} -> amountIn ${json.amountIn}, fillRatio ${json.fillRatio.toFixed(4)}`);
});

// ---------------------------------------------------------------------------
// 6. Request-shape contract. Needs no market data, so it asserts deterministically.
// ---------------------------------------------------------------------------
await check('a request with both amountIn and amountOut is rejected with 400', async () => {
    const { status, text } = await request(routePath({ amountIn: '1', amountOut: '1' }));
    assert(status === 400, `expected 400, got ${status}: ${short(text)}`);
});

// ---------------------------------------------------------------------------
// 7. Crossed-book protection. Presence, not value: the counter is legitimately 0 on a healthy day,
//    so a "> 0" assertion would be a coin flip. What presence proves is that the guarded build —
//    the one that rejects a crossed book instead of ranking on it — is the one deployed.
// ---------------------------------------------------------------------------
await check('order_router_exchange_crossed_books_total is present in /metrics', async () => {
    const { status, text } = await request('/metrics', { accept: 'text' });
    assert(status === 200, `expected 200, got ${status}: ${short(text)}`);
    const series = text.split('\n').filter((line) => line.startsWith('order_router_exchange_crossed_books_total'));
    assert(series.length > 0,
        'no order_router_exchange_crossed_books_total series — the crossed-book guard is not in the '
        + 'deployed build');
    const samples = series.filter((line) => !line.startsWith('#'));
    assert(samples.length > 0,
        'order_router_exchange_crossed_books_total is declared but has no samples');
    detail(`${samples.length} exchange series`);
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed against ${BASE}\n`,
);
if (failed.length > 0) {
    process.stdout.write(`\nFAILED CHECKS:\n${failed.map((r) => `  - ${r.name}: ${r.detail}`).join('\n')}\n`);
    process.exit(1);
}
