import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { chunkSymbols, normalizeLevels, isPermanentError, reapOrphanedSockets, isCrossedBook, nextResyncBackoffMs } from './exchangeConnector.js';

const silentLogger = pino({ level: 'silent' });

test('chunkSymbols splits into groups no larger than the given size', () => {
    const symbols = Array.from({ length: 125 }, (_, i) => `SYM${i}`);
    const chunks = chunkSymbols(symbols, 50);

    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]?.length, 50);
    assert.equal(chunks[1]?.length, 50);
    assert.equal(chunks[2]?.length, 25);
    assert.deepEqual(chunks.flat(), symbols);
});

test('chunkSymbols on an empty array returns no chunks', () => {
    assert.deepEqual(chunkSymbols([], 50), []);
});

test('chunkSymbols with size >= symbol count returns one chunk', () => {
    const symbols = ['a', 'b', 'c'];
    assert.deepEqual(chunkSymbols(symbols, 50), [symbols]);
});

test('normalizeLevels drops levels missing price or amount', () => {
    const levels: [number | undefined, number | undefined][] = [
        [100, 1],
        [undefined, 1],
        [100, undefined],
        [101, 2],
    ];

    assert.deepEqual(normalizeLevels(levels), [
        { price: 100, amount: 1 },
        { price: 101, amount: 2 },
    ]);
});

test('normalizeLevels rejects levels that are present but unusable', () => {
    // Not a "missing field" case: these arrive complete and wrong. A non-positive price sorts to
    // the front of the merged book, wins the allocation, and is then divided by — one venue
    // appearing to offer unlimited size for nothing. NaN fails every comparison, so it is neither
    // filtered nor ordered and poisons the arithmetic instead.
    const levels: [number | undefined, number | undefined][] = [
        [100, 1],
        [0, 5],
        [-1, 5],
        [Number.NaN, 5],
        [Number.POSITIVE_INFINITY, 5],
        [101, 0],
        [101, -2],
        [101, Number.NaN],
        [102, 3],
    ];

    assert.deepEqual(normalizeLevels(levels), [
        { price: 100, amount: 1 },
        { price: 102, amount: 3 },
    ]);
});

test('normalizeLevels on an all-valid input passes through unchanged', () => {
    const levels: [number | undefined, number | undefined][] = [[100, 1], [99, 2]];
    assert.deepEqual(normalizeLevels(levels), [{ price: 100, amount: 1 }, { price: 99, amount: 2 }]);
});

test('permanent failures are recognised so they are abandoned, not retried forever', () => {
    // A venue needing credentials fails instantly and identically on every retry. Treating that
    // as transient produced a busy loop that wrote ~930MB / 22M log lines and starved the CPU
    // that working venues needed.
    assert.equal(isPermanentError('cex requires "apiKey" credential'), true);
    assert.equal(isPermanentError('luno requires "apiKey" credential'), true);
    assert.equal(isPermanentError('someex watchOrderBook() is not supported yet'), true);
    assert.equal(isPermanentError('authentication failed'), true);
});

test('transient failures stay retryable', () => {
    // These recover on their own; abandoning them would permanently drop a healthy venue.
    assert.equal(isPermanentError('connection closed by remote'), false);
    assert.equal(isPermanentError('request timed out (10000 ms)'), false);
    assert.equal(isPermanentError('socket hang up'), false);
    assert.equal(isPermanentError('subscribe over limit, max:1000'), false);
});

test('books are truncated before they can cross the IPC boundary', () => {
    // The measurement that forced this: coinbase streams 44,298 levels per update at ~165/sec.
    // Serialised that is ~31 MB/s per exchange into a pipe the parent cannot drain — process.send
    // returned false on 96.3% of calls and libuv queued the rest, putting one shard at 19.8GB RSS
    // with a flat 62MB heap. An isolation test attributed it precisely: bare stream 131MB,
    // +normalize 180MB, +stringify 193MB, +process.send 5,444MB.
    const huge: [number, number][] = Array.from({ length: 44_298 }, (_, i) => [100 + i, 1]);
    assert.equal(normalizeLevels(huge).length, 44_298, 'unbounded by default, as ccxt hands it over');
    assert.equal(normalizeLevels(huge, 500).length, 500);
    // Truncation must keep the TOP of the book — those are the levels an order actually fills from.
    assert.equal(normalizeLevels(huge, 3)[0]!.price, 100);
    assert.equal(normalizeLevels(huge, 3)[2]!.price, 102);
});

test('truncation still leaves an order of magnitude more depth than routing uses', () => {
    // A 5,000,000 USDT order was measured filling in under 50 levels per venue. The default has to
    // stay comfortably above that, or the fix for a memory problem becomes a routing problem.
    const levels: [number, number][] = Array.from({ length: 2000 }, (_, i) => [100 + i * 0.01, 1]);
    const kept = normalizeLevels(levels, 500);
    assert.ok(kept.length >= 500, 'the default must not starve a large order');
    // 500 levels of 1 unit each is 500 units of depth on a book whose top level is 100 — far beyond
    // any order this router has been measured filling.
    assert.equal(kept.reduce((s, l) => s + l.amount, 0), 500);
});

test('a partial or malformed level is still dropped, not counted against the depth budget', () => {
    const mixed: [number | undefined, number | undefined][] = [
        [100, 1], [undefined, 1], [101, undefined], [102, 2], [103, 3],
    ];
    const kept = normalizeLevels(mixed, 3);
    assert.deepEqual(kept.map((l) => l.price), [100, 102, 103],
        'incomplete levels must not consume depth that a real level could have used');
});

test('orphaned websocket clients are closed; live ones are not', () => {
    // ccxt.pro drops a client from exchange.clients when its connection errors but does not close
    // the socket, so it stays OPEN and keeps dispatching into the same handler with nothing holding
    // a reference that could stop it. Verified against bitstamp: three forced errors left three
    // clients removed from exchange.clients, all three with readyState 1. Live, that showed as 78
    // sockets to one okx host and 45 to coinbase.
    const mk = (state: number) => {
        const c = { connection: { readyState: state }, closed: false, close () { c.closed = true; } };
        return c;
    };
    const live = mk(1);
    const orphanOpen = mk(1);
    const orphanConnecting = mk(0);
    const orphanAlreadyClosed = mk(3);
    const exchange = { clients: { 'wss://live': live } };
    const seen = new Set<unknown>([live, orphanOpen, orphanConnecting, orphanAlreadyClosed]);

    const closed = reapOrphanedSockets(exchange, seen, silentLogger);

    assert.equal(closed, 2, 'both the OPEN and the CONNECTING orphan hold a socket and must be closed');
    assert.equal(orphanOpen.closed, true);
    assert.equal(orphanConnecting.closed, true);
    assert.equal(orphanAlreadyClosed.closed, false, 'an already-closed orphan needs no action');
    // The one the exchange still owns must be left strictly alone — closing it would kill a live feed.
    assert.equal(live.closed, false, 'a client the exchange still owns must never be reaped');
    assert.equal(seen.size, 0, 'the tracking set must be cleared, or it grows without bound');
});

test('reaping tolerates a client shape it does not recognise', () => {
    // ccxt internals are not ours; a shape change must degrade to doing nothing, not to a throw
    // inside an error handler that is already handling a failure.
    const seen = new Set<unknown>([{}, null, { connection: {} }, { connection: { readyState: 1 } }]);
    assert.doesNotThrow(() => reapOrphanedSockets({ clients: {} }, seen, silentLogger));
});

// Regression tests for the crossed-book guard. The failure these protect against was live: a
// corrupt deepcoin book quoted BTC 52 bps below the true market and won the whole order precisely
// because it was wrong.
test('isCrossedBook accepts a normal book', () => {
    const bids = [{ price: 79426.00, amount: 1 }, { price: 79425.90, amount: 2 }];
    const asks = [{ price: 79426.01, amount: 1 }, { price: 79426.10, amount: 2 }];
    assert.equal(isCrossedBook(bids, asks), false);
});

test('isCrossedBook flags the live deepcoin corruption', () => {
    const bids = [{ price: 79802.10, amount: 0.0020134 }];
    const asks = [{ price: 79009.70, amount: 1.777042 }];
    assert.equal(isCrossedBook(bids, asks), true);
});

test('isCrossedBook flags the live whitebit corruption', () => {
    assert.equal(
        isCrossedBook([{ price: 79771.53, amount: 1 }], [{ price: 79111.05, amount: 1 }]),
        true,
    );
});

// A locked book is not corrupt: it happens briefly on real venues and walks correctly. Treating it
// as corruption would resync healthy exchanges for no reason.
test('isCrossedBook treats a locked book as valid', () => {
    assert.equal(
        isCrossedBook([{ price: 79426, amount: 1 }], [{ price: 79426, amount: 1 }]),
        false,
    );
});

test('isCrossedBook tolerates an empty side rather than reporting corruption', () => {
    assert.equal(isCrossedBook([], [{ price: 79426, amount: 1 }]), false);
    assert.equal(isCrossedBook([{ price: 79426, amount: 1 }], []), false);
    assert.equal(isCrossedBook([], []), false);
});

// Resync escalation. Live evidence for why this exists: deepcoin was repaired by its first resync
// (71 crossings total) while bitget re-crossed within seconds of every fresh snapshot and held
// ~30 crossed books/sec through repeated resyncs.
test('a resync that fails to repair the venue doubles the interval', () => {
    assert.equal(nextResyncBackoffMs(60_000, 60_000, true), 120_000);
    assert.equal(nextResyncBackoffMs(120_000, 120_000, true), 240_000);
});

test('escalation is capped so an unrepairable venue is still retried occasionally', () => {
    assert.equal(nextResyncBackoffMs(30 * 60_000, 30 * 60_000, true), 30 * 60_000);
    assert.equal(nextResyncBackoffMs(20 * 60_000, 20 * 60_000, true), 30 * 60_000);
});

test('a venue that stayed clean for a long stretch resets to the base interval', () => {
    assert.equal(nextResyncBackoffMs(240_000, 600_000, true), 60_000);
});

test('the first resync for a venue never starts escalated', () => {
    assert.equal(nextResyncBackoffMs(60_000, 0, false), 60_000);
});
