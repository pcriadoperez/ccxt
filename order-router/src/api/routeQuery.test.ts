import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteQuery, STREAM_BALANCES_UNSUPPORTED, type RouteQuery } from './routeQuery.js';

// The parser REST /route and WS /stream/route both run. Exercised directly here rather than only
// through the two endpoints, so the exact error strings are pinned once: a 400 body and a 1008
// close frame carry the same text, and the only thing keeping them byte-identical is that neither
// endpoint formats its own.
function parse (query: RouteQuery, defaults: { includeQuotes?: boolean; rejectBalances?: boolean } = {}) {
    return parseRouteQuery(query, 'test-req', defaults);
}

const BASE: RouteQuery = { from: 'USDT', to: 'BTC', amountIn: '1000' };

function errorFor (query: RouteQuery, defaults: { rejectBalances?: boolean } = {}): string {
    const parsed = parse(query, defaults);
    assert.ok(!parsed.ok, `expected ${JSON.stringify(query)} to be rejected`);
    return parsed.error;
}

function optsFor (query: RouteQuery) {
    const parsed = parse(query);
    assert.ok(parsed.ok, `expected ${JSON.stringify(query)} to parse, got ${parsed.ok ? '' : parsed.error}`);
    return parsed.opts;
}

test('balances parses both grammar forms and defaults balanceMode to cap', () => {
    const opts = optsFor({ ...BASE, balances: 'binance.USDT:40000,kraken.BTC:0.5,USDT:1000' });
    assert.ok(opts.balances);
    assert.equal(opts.balances!.entryCount, 3);
    assert.equal(opts.balances!.byVenue.get('binance')!.get('USDT'), 40000);
    assert.equal(opts.balances!.anyVenue.get('USDT'), 1000);
    assert.equal(opts.balanceMode, 'cap');
});

test('an absent balances is unconstrained, and an empty one means "I hold nothing"', () => {
    // The distinction the whole feature rests on. `exchanges=` and `bridges=` already read an
    // explicitly empty value as a real answer rather than as absence; this is the same polarity.
    assert.equal(optsFor(BASE).balances, null);
    const empty = optsFor({ ...BASE, balances: '' }).balances;
    assert.notEqual(empty, null);
    assert.equal(empty!.entryCount, 0);
});

test('balanceMode is an enum, and anything else is a 400', () => {
    assert.equal(optsFor({ ...BASE, balanceMode: 'require' }).balanceMode, 'require');
    assert.equal(optsFor({ ...BASE, balanceMode: 'cap' }).balanceMode, 'cap');
    for (const mode of ['true', 'false', 'CAP', 'clamp', '']) {
        assert.equal(errorFor({ ...BASE, balanceMode: mode }), 'balanceMode must be cap or require');
    }
});

test('the balances grammar rejects with the entry quoted back', () => {
    assert.equal(errorFor({ ...BASE, balances: 'USDT' }),
        'balances entry "USDT" must be [exchange.]ASSET:amount');
    assert.equal(errorFor({ ...BASE, balances: 'binance.USDT:abc' }),
        'balances entry "binance.USDT:abc" must be [exchange.]ASSET:amount');
    assert.equal(errorFor({ ...BASE, balances: 'USDT:-1' }),
        'balances entry "USDT:-1" must be [exchange.]ASSET:amount');
    assert.equal(errorFor({ ...BASE, balances: 'USDT:NaN' }),
        'balances entry "USDT:NaN" must be [exchange.]ASSET:amount');
});

test('both balances caps reject rather than truncate', () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => `ex${i}.USDT:1`).join(',');
    assert.ok(parse({ ...BASE, balances: entries(64) }).ok);
    assert.equal(errorFor({ ...BASE, balances: entries(65) }), 'balances must not exceed 64 entries');
    assert.equal(errorFor({ ...BASE, balances: `USDT:1.${'0'.repeat(4090)}` }),
        'balances must not exceed 4096 characters');
});

test('a duplicated balances key is a 400, not last-wins', () => {
    assert.equal(errorFor({ ...BASE, balances: 'binance.USDT:1,binance.USDT:2' }),
        'balances contains duplicate key binance.USDT');
});

test('a repeated balances parameter is rejected by the blanket array check', () => {
    // rejectRepeated loops over every key Fastify parsed, including ones it has never heard of, so
    // ?balances=a&balances=b was covered the moment the parameter existed.
    assert.equal(errorFor({ ...BASE, balances: ['USDT:1', 'BTC:1'] as unknown as string }),
        'balances must not be repeated');
    assert.equal(errorFor({ ...BASE, balanceMode: ['cap', 'require'] as unknown as string }),
        'balanceMode must not be repeated');
});

test('the streaming endpoint refuses balances outright', () => {
    assert.equal(errorFor({ ...BASE, balances: 'USDT:1000' }, { rejectBalances: true }),
        STREAM_BALANCES_UNSUPPORTED);
    // Refused before the grammar runs: "not supported here" is the answer, not a syntax lesson.
    assert.equal(errorFor({ ...BASE, balances: 'nonsense' }, { rejectBalances: true }),
        STREAM_BALANCES_UNSUPPORTED);
    // balanceMode alone says what to do about holdings this endpoint will not accept, so it is
    // refused with them rather than validated and then dropped on the floor — accepting it
    // silently told the caller their instruction had landed.
    assert.equal(errorFor({ ...BASE, balanceMode: 'require' }, { rejectBalances: true }),
        STREAM_BALANCES_UNSUPPORTED);
    assert.equal(errorFor({ ...BASE, balanceMode: 'cap' }, { rejectBalances: true }),
        STREAM_BALANCES_UNSUPPORTED);
    // Everything else about the stream request is unchanged.
    assert.ok(parse(BASE, { rejectBalances: true, includeQuotes: false }).ok);
    // And REST is untouched: it takes the mode with or without balances.
    assert.equal(optsFor({ ...BASE, balanceMode: 'require' }).balanceMode, 'require');
});

test('amount validation still runs before balances', () => {
    // A request broken on both is reported on the amount: it is the cheaper thing to fix, and it
    // makes the portfolio moot.
    assert.equal(errorFor({ from: 'USDT', to: 'BTC', amountIn: 'abc', balances: 'nonsense' }),
        'amountIn must be a positive finite number');
    assert.equal(errorFor({ from: 'USDT', to: 'BTC', balances: 'nonsense' }),
        'exactly one of amountIn or amountOut must be supplied');
});

test('balances rides alongside the existing options rather than replacing any', () => {
    const opts = optsFor({
        ...BASE, balances: 'kraken.USDT:500', balanceMode: 'require',
        strategy: 'split_capped', maxVenues: '2', requireFullFill: 'true', exchanges: 'kraken',
    });
    assert.equal(opts.strategy, 'split_capped');
    assert.equal(opts.maxVenues, 2);
    assert.equal(opts.requireFullFill, true);
    assert.deepEqual(opts.exchanges, new Set(['kraken']));
    assert.equal(opts.balanceMode, 'require');
    assert.equal(opts.balances!.entryCount, 1);
});

test('exchanges and bridges are bounded, rejecting rather than truncating', () => {
    // Both are caller-controlled, both are echoed verbatim into the audit record, and `bridges` is
    // re-walked on every push of a stream that can live for minutes. Neither was capped, so one
    // request could pin a megabyte of caller-chosen text into every audit line it produced.
    const list = (n: number, prefix: string) =>
        Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(',');

    assert.ok(parse({ ...BASE, exchanges: list(128, 'ex') }).ok, '128 entries is within the cap');
    assert.equal(errorFor({ ...BASE, exchanges: list(129, 'ex') }),
        'exchanges must not exceed 128 entries');
    assert.equal(errorFor({ ...BASE, bridges: list(129, 'B') }),
        'bridges must not exceed 128 entries');

    // The character cap catches the other shape: few entries, each enormous.
    assert.equal(errorFor({ ...BASE, exchanges: 'x'.repeat(1025) }),
        'exchanges must not exceed 1024 characters');
    assert.equal(errorFor({ ...BASE, bridges: 'B'.repeat(1025) }),
        'bridges must not exceed 1024 characters');
});

test('the ordinary lists still parse, and the empty forms keep their meanings', () => {
    // The caps must not disturb what these parameters mean: an empty allowlist is "no venues", and
    // an empty bridge list is "direct markets only".
    assert.deepEqual([ ...optsFor({ ...BASE, exchanges: 'binance,kraken' }).exchanges! ],
        [ 'binance', 'kraken' ]);
    assert.equal(optsFor({ ...BASE, exchanges: '' }).exchanges!.size, 0);
    const parsed = parse({ ...BASE, bridges: '' });
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.req.bridges, []);
});
