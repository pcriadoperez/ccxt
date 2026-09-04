import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetFor, budgetsForHop, capFor, cloneBudgets, parseBalancesParam, type BalanceBook } from './balances.js';
import type { ResolvedHop } from './market.js';

function parse (raw: string): BalanceBook {
    const parsed = parseBalancesParam(raw);
    assert.ok(parsed.ok, `expected "${raw}" to parse, got ${parsed.ok ? '' : parsed.error}`);
    return parsed.book;
}

function rejects (raw: string): string {
    const parsed = parseBalancesParam(raw);
    assert.ok(!parsed.ok, `expected "${raw.slice(0, 60)}" to be rejected`);
    return parsed.error;
}

const BUY: ResolvedHop = { pair: 'BTC/USDT', base: 'BTC', quote: 'USDT', side: 'buy' };
const SELL: ResolvedHop = { pair: 'BTC/USDT', base: 'BTC', quote: 'USDT', side: 'sell' };

test('both grammar forms parse: venue-qualified and bare', () => {
    const book = parse('binance.USDT:40000,kraken.BTC:0.5,USDT:1000');
    assert.equal(book.byVenue.get('binance')!.get('USDT'), 40000);
    assert.equal(book.byVenue.get('kraken')!.get('BTC'), 0.5);
    // A bare asset is spendable anywhere, so it must NOT land under a venue.
    assert.equal(book.anyVenue.get('USDT'), 1000);
    assert.equal(book.entryCount, 3);
});

test('assets are upper-cased and entries trimmed, exactly like from and to', () => {
    const book = parse(' binance.usdt:100 , btc:2 ');
    assert.equal(book.byVenue.get('binance')!.get('USDT'), 100);
    assert.equal(book.anyVenue.get('BTC'), 2);
});

test('capFor sums the pinned and unpinned holdings of one asset', () => {
    const book = parse('binance.USDT:40000,kraken.USDT:1000,USDT:500,binance.BTC:1');
    assert.equal(capFor(book, 'USDT'), 41500);
    assert.equal(capFor(book, 'BTC'), 1);
    assert.equal(capFor(book, 'SOL'), 0);
    // No book means no constraint, so the source clamp reads the same with and without a wallet.
    assert.equal(capFor(null, 'USDT'), Infinity);
});

test('the entry and character caps reject rather than truncate', () => {
    // A silently dropped entry is a route the caller cannot fund — the exact failure this feature
    // exists to prevent — so both bounds are refusals, not trims.
    const sixtyFour = Array.from({ length: 64 }, (_, i) => `ex${i}.USDT:1`).join(',');
    assert.equal(parseBalancesParam(sixtyFour).ok, true);
    const sixtyFive = Array.from({ length: 65 }, (_, i) => `ex${i}.USDT:1`).join(',');
    assert.equal(rejects(sixtyFive), 'balances must not exceed 64 entries');

    const long = `USDT:1.${'0'.repeat(4088)}`;
    assert.equal(long.length, 4095);
    assert.equal(parseBalancesParam(long).ok, true);
    assert.equal(rejects(`${long}11`), 'balances must not exceed 4096 characters');
});

test('a duplicate key is a rejection, not last-wins', () => {
    // Last-wins is silent: the caller sees their first figure ignored with nothing in the response
    // to say so.
    assert.equal(rejects('binance.USDT:1,binance.USDT:2'), 'balances contains duplicate key binance.USDT');
    assert.equal(rejects('USDT:1,USDT:2'), 'balances contains duplicate key USDT');
    // A pinned and an unpinned holding of the same asset are different keys and compose.
    assert.equal(capFor(parse('binance.USDT:1,USDT:2'), 'USDT'), 3);
});

test('malformed, negative and non-finite amounts are rejected', () => {
    for (const raw of ['USDT', 'USDT:', ':100', 'USDT:abc', 'USDT:NaN', 'USDT:-1', 'a.b.USDT:1', 'USDT:1:2']) {
        assert.match(rejects(raw), /must be \[exchange\.\]ASSET:amount/, raw);
    }
    // Zero is a real answer — "I hold none of this here" — not a malformed one.
    assert.equal(parse('binance.USDT:0').byVenue.get('binance')!.get('USDT'), 0);
});

test('an explicitly empty balances parses to an empty book, not to undefined', () => {
    // `balances=` means "I hold nothing", the same polarity `exchanges=` and `bridges=` use. It
    // must survive as a book, because an absent book means unconstrained.
    const book = parse('');
    assert.equal(book.entryCount, 0);
    assert.equal(book.byVenue.size, 0);
    assert.equal(book.anyVenue.size, 0);
    assert.equal(capFor(book, 'USDT'), 0);
});

test('the normalized echo is key-sorted, so entry order cannot change the audit hash', () => {
    assert.equal(parse('USDT:1000,binance.usdt:40000').normalized, parse('binance.USDT:40000,usdt:1000').normalized);
    assert.equal(parse('binance.USDT:40000,USDT:1000').normalized, 'USDT:1000,binance.USDT:40000');
});

test('budgetsForHop denominates in the SPEND asset: quote on a buy, base on a sell', () => {
    // The single easiest place to get the units backwards, and it fails silently — a budget in the
    // wrong asset never binds and never errors.
    const book = parse('binance.USDT:40000,binance.BTC:2,kraken.BTC:0.5');

    const buy = budgetsForHop(book, BUY)!;
    assert.equal(buy.spendIsBase, false);
    assert.equal(buy.perVenue.get('binance'), 40000, 'a buy spends quote');
    assert.equal(buy.perVenue.has('kraken'), false, 'kraken holds no USDT, so it funds no buy');

    const sell = budgetsForHop(book, SELL)!;
    assert.equal(sell.spendIsBase, true);
    assert.equal(sell.perVenue.get('binance'), 2, 'a sell spends base');
    assert.equal(sell.perVenue.get('kraken'), 0.5);
});

test('the unpinned pool is shared across venues rather than copied to each', () => {
    const budgets = budgetsForHop(parse('binance.USDT:100,USDT:900'), BUY)!;
    assert.equal(budgets.shared, 900);
    assert.equal(budgetFor(budgets, 'binance'), 1000);
    // A venue with no pinned holding can still spend the pool — that is what "I have not told you
    // where it sits" means.
    assert.equal(budgetFor(budgets, 'kraken'), 900);
});

test('cloneBudgets is a deep copy, so one allocate pass cannot starve the next', () => {
    const original = budgetsForHop(parse('binance.USDT:100,USDT:900'), BUY)!;
    const clone = cloneBudgets(original)!;
    clone.perVenue.set('binance', 0);
    clone.shared = 0;
    assert.equal(original.perVenue.get('binance'), 100);
    assert.equal(original.shared, 900);
    assert.equal(cloneBudgets(null), null);
});
