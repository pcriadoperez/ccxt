import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import ccxt from 'ccxt';
import { chunkSymbols, normalizeLevels, isPermanentError, isLimitRejection, reapOrphanedSockets, isCrossedBook, nextResyncBackoffMs, ExchangeConnector } from './exchangeConnector.js';
import { OrderBookCache } from '../cache/orderBookCache.js';
import { FeeRegistry } from '../cache/feeRegistry.js';

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
    assert.equal(isPermanentError(new Error('cex requires "apiKey" credential')), true);
    assert.equal(isPermanentError(new Error('luno requires "apiKey" credential')), true);
    assert.equal(isPermanentError(new Error('someex watchOrderBook() is not supported yet')), true);
    // AuthenticationError is permanent only when the message says a credential is MISSING.
    assert.equal(isPermanentError(new ccxt.AuthenticationError('cex requires "apiKey" credential')), true);
    assert.equal(isPermanentError(new ccxt.NotSupported('watchOrderBook')), true);
    assert.equal(isPermanentError(new ccxt.BadSymbol('no such market')), true);
    assert.equal(isPermanentError(new ccxt.ArgumentsRequired('symbol is required')), true);
});

test('a recoverable failure is never mistaken for a permanent one', () => {
    // Every one of these matched the message patterns as they were, and every one recovers on its
    // own. Calling one permanent removes the venue from routing for the lifetime of the process:
    // the loop returns, nothing retries it, and the books just go stale — indistinguishable from a
    // quiet market. So these are asserted by ccxt's own class, not by their text.
    assert.equal(isPermanentError(new ccxt.InvalidNonce('binance {"code":-1021,"msg":"Timestamp for this request is invalid."}')), false);
    assert.equal(isPermanentError(new ccxt.InvalidNonce('kraken EAPI:Invalid nonce')), false);
    assert.equal(isPermanentError(new ccxt.RequestTimeout('okx watchOrderBook timed out')), false);
    assert.equal(isPermanentError(new ccxt.ExchangeNotAvailable('bybit authentication in progress, please retry')), false);
    assert.equal(isPermanentError(new ccxt.RateLimitExceeded('too many requests')), false);
    assert.equal(isPermanentError(new ccxt.OnMaintenance('scheduled maintenance')), false);
    // AuthenticationError is where the two remaining false positives landed. okx answers clock
    // drift with an invalid-signature error, and a handshake that lost a race reads the same way;
    // both recover on the next attempt. Classifying the class as permanent reinstated exactly the
    // mistake that dropping /authentication/ from the message patterns removed.
    assert.equal(isPermanentError(new ccxt.AuthenticationError('okx {"code":"50113","msg":"Invalid Sign"} signature is invalid')), false);
    assert.equal(isPermanentError(new ccxt.AuthenticationError('authentication failed')), false);
    // A plain ExchangeError proves nothing permanent, so it retries rather than abandoning.
    assert.equal(isPermanentError(new ccxt.ExchangeError('okx {"code":"50113","msg":"Invalid Sign"} signature is invalid')), false);
    assert.equal(isPermanentError(new ccxt.BadRequest('malformed subscribe frame')), false);
});

test('transient failures stay retryable', () => {
    // These recover on their own; abandoning them would permanently drop a healthy venue.
    assert.equal(isPermanentError(new Error('connection closed by remote')), false);
    assert.equal(isPermanentError(new Error('request timed out (10000 ms)')), false);
    assert.equal(isPermanentError(new Error('socket hang up')), false);
    assert.equal(isPermanentError(new Error('subscribe over limit, max:1000')), false);
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

test('a venue refusing the depth limit drops the limit instead of the venue', () => {
    // The connector now asks the venue for maxDepth levels rather than taking every level and
    // discarding 90% of them. Venues that do not offer a depth-limited channel answer with
    // NotSupported or a BadRequest naming the limit — and NotSupported is exactly what the
    // permanent-error rules abandon a venue over. A bandwidth preference must never be able to
    // remove a venue from routing, so these are separated before that check runs.
    const limit = 500;
    assert.equal(isLimitRejection(new ccxt.NotSupported('watchOrderBook() does not accept a limit'), limit), true);
    assert.equal(isLimitRejection(new ccxt.BadRequest('invalid limit 500, allowed: 5, 10, 20'), limit), true);
    assert.equal(isLimitRejection(new ccxt.BadRequest('unsupported depth channel'), limit), true);
    assert.equal(isLimitRejection(new ccxt.ArgumentsRequired('limit is required'), limit), true);
    // Not a limit problem: these must still reach the permanent/transient classification.
    assert.equal(isLimitRejection(new ccxt.AuthenticationError('bad key'), limit), false);
    assert.equal(isLimitRejection(new ccxt.BadRequest('malformed subscribe frame'), limit), false);
    assert.equal(isLimitRejection(new ccxt.RequestTimeout('timed out'), limit), false);
    // And once the limit has already been dropped, nothing is a limit rejection any more —
    // otherwise the loop would retry with no backoff forever.
    assert.equal(isLimitRejection(new ccxt.NotSupported('watchOrderBook() does not accept a limit'), undefined), false);
});

test('a crossed book logs once per episode, not once per update', async () => {
    // A venue that crosses usually crosses on EVERY update — hundreds a second on a fast symbol —
    // while the resync that would clear it backs off to as much as 30 minutes. One warn per update
    // at the production log level is unbounded volume from a condition already counted in
    // order_router_exchange_crossed_books_total, and this box has been buried by exactly that kind
    // of retry chatter before.
    const lines: { level: string; msg: string; obj: Record<string, unknown> }[] = [];
    const capture = {
        warn: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'warn', msg, obj }),
        info: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
        child: () => capture,
    };
    const cache = new OrderBookCache();
    const exchange = { id: 'stub', markets: {}, loadMarkets: async () => ({}) };
    const connector = new ExchangeConnector(
        'stub', cache, new FeeRegistry(), capture as never, exchange as never);
    // resync() would reach for the venue's orderbooks; the crossed path only needs it not to throw.
    (connector as never as { resync: () => Promise<void> }).resync = async () => {};
    const apply = (connector as never as {
        applyOrderBook: (s: string, ob: unknown, seq: number) => void;
    }).applyOrderBook.bind(connector);

    const crossedBook = { bids: [[ 101, 1 ]], asks: [[ 100, 1 ]], timestamp: Date.now() };
    for (let i = 0; i < 50; i++) apply('BTC/USDT', crossedBook, i);
    const crossedWarns = lines.filter((l) => l.msg.indexOf('crossed order book,') === 0);
    assert.equal(crossedWarns.length, 1, `50 crossed updates should log once, logged ${crossedWarns.length}`);

    // A different symbol is a different episode: one venue can cross on one market and be fine on
    // the rest, and suppressing the second would hide it entirely.
    for (let i = 0; i < 10; i++) apply('ETH/USDT', crossedBook, i);
    assert.equal(lines.filter((l) => l.msg.indexOf('crossed order book,') === 0).length, 2);

    // Clearing reports what the suppressed window cost, so nothing is silently lost.
    apply('BTC/USDT', { bids: [[ 100, 1 ]], asks: [[ 101, 1 ]], timestamp: Date.now() }, 99);
    const cleared = lines.find((l) => l.msg === 'crossed order book cleared');
    assert.ok(cleared, 'the end of an episode is reported');
    assert.equal(cleared!.obj['updatesRejected'], 50);
    assert.equal(cleared!.obj['symbol'], 'BTC/USDT');

    // And a fresh episode on the same symbol logs again — the suppression is per episode, not
    // permanent, or a venue that crosses twice would be reported once.
    for (let i = 0; i < 5; i++) apply('BTC/USDT', crossedBook, 100 + i);
    assert.equal(lines.filter((l) => l.msg.indexOf('crossed order book,') === 0).length, 3);
});
