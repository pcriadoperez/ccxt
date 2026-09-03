// NO_AUTO_TRANSPILE
//  ---------------------------------------------------------------------------
//  OrderRouter — offline tests.
//
//  Run:  npx tsx --test ts/src/test/base/test.orderRouter.ts
//
//  Two halves, and both matter:
//
//  1. The FIXTURE half drives the four pure methods from
//     ts/src/test/base/fixtures/orderRouter.json. Python, PHP, C# and Go read
//     the same file and assert the same expectations, so a port that drifts
//     fails in its own language and nowhere else — which is what makes drift
//     impossible to hide.
//
//  2. The INVARIANT half asserts the safety properties directly, in literal
//     numbers written by hand. The fixture's expectations were produced by this
//     implementation, so on their own they would only prove the five languages
//     agree — not that they agree on the right answer. These are the tests that
//     would fail if the implementation itself were wrong.
//
//  Nothing here touches the network and nothing here places an order.
//  ---------------------------------------------------------------------------

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { test } from 'node:test';
import OrderRouter from '../../base/OrderRouter.js';
import { BadRequest, ExchangeError, NotSupported, ArgumentsRequired, RequestTimeout } from '../../base/errors.js';

const here = path.dirname (fileURLToPath (import.meta.url));
//  The fixture lives in the TypeScript tree and is read from there by all five
//  suites, so it is resolved from the repository root rather than from this
//  module: `here` is ts/src/test/base under tsx and js/src/test/base when this
//  file runs as compiled output, and only one of those has a fixtures/ beside it.
const repoRoot = path.resolve (here, '..', '..', '..', '..');
const fixturePath = path.join (repoRoot, 'ts', 'src', 'test', 'base', 'fixtures', 'orderRouter.json');
const fixture = JSON.parse (fs.readFileSync (fixturePath, 'utf8'));

const router = new OrderRouter ({ 'apiKey': 'test-key' });

//  ---------------------------------------------------------------------------
//  comparison helpers — the algorithm every port's test must use
//  ---------------------------------------------------------------------------

const TOLERANCE = 1e-9;

function numbersMatch (a: number, b: number): boolean {
    if (a === b) {
        return true;
    }
    if (!isFinite (a) || !isFinite (b)) {
        //  an infinity only ever matches itself. Without this the relative
        //  comparison below reads Infinity <= Infinity as a match and an
        //  infinite value passes against ANY expectation — which is exactly how
        //  a number grammar that overflows would slip past the numberCases table
        return false;
    }
    let scale = 1;
    if (Math.abs (a) > scale) {
        scale = Math.abs (a);
    }
    if (Math.abs (b) > scale) {
        scale = Math.abs (b);
    }
    return Math.abs (a - b) <= TOLERANCE * scale;
}

function assertMatches (actual: any, expected: any, where: string) {
    if (Array.isArray (expected)) {
        assert.ok (Array.isArray (actual), where + ': expected an array, got ' + typeof actual);
        assert.strictEqual (actual.length, expected.length, where + ': array length');
        for (let i = 0; i < expected.length; i++) {
            assertMatches (actual[i], expected[i], where + '[' + i.toString () + ']');
        }
        return;
    }
    if (expected !== null && typeof expected === 'object') {
        assert.ok (actual !== null && typeof actual === 'object' && !Array.isArray (actual), where + ': expected an object');
        const expectedKeys = Object.keys (expected).sort ();
        const actualKeys = Object.keys (actual).sort ();
        //  both directions: a missing field and an invented field are both drift
        assert.deepStrictEqual (actualKeys, expectedKeys, where + ': key set');
        for (let i = 0; i < expectedKeys.length; i++) {
            const key = expectedKeys[i];
            assertMatches (actual[key], expected[key], where + '.' + key);
        }
        return;
    }
    if (typeof expected === 'number') {
        assert.ok (typeof actual === 'number' && numbersMatch (actual, expected), where + ': expected ' + expected.toString () + ', got ' + String (actual));
        return;
    }
    assert.strictEqual (actual, expected, where);
}

//  ---------------------------------------------------------------------------
//  1. the shared fixture — the cross-language contract
//  ---------------------------------------------------------------------------

test ('fixture: buildExecutionPlan', () => {
    const cases = fixture['planCases'];
    assert.ok (cases.length > 0, 'the fixture has plan cases');
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        const route = fixture['routes'][testCase['route']];
        const plan = router.buildExecutionPlan (route, testCase['options']);
        assertMatches (plan, testCase['expected'], 'planCase ' + testCase['id']);
    }
});

test ('fixture: buildExecutionPlan is deterministic and does not mutate its input', () => {
    const cases = fixture['planCases'];
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        const route = fixture['routes'][testCase['route']];
        const before = JSON.stringify (route);
        const first = router.buildExecutionPlan (route, testCase['options']);
        const second = router.buildExecutionPlan (route, testCase['options']);
        assertMatches (second, first, 'planCase ' + testCase['id'] + ' repeated');
        assert.strictEqual (JSON.stringify (route), before, 'planCase ' + testCase['id'] + ': the route was mutated');
    }
});

test ('fixture: checkExecutionPlanSafety', () => {
    const cases = fixture['safetyCases'];
    assert.ok (cases.length > 0, 'the fixture has safety cases');
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        const route = fixture['routes'][testCase['route']];
        const markets = fixture['marketSets'][testCase['markets']];
        const plan = router.buildExecutionPlan (route, testCase['planOptions']);
        const violations = router.checkExecutionPlanSafety (plan, markets, testCase['options']);
        assertMatches (violations, testCase['expected'], 'safetyCase ' + testCase['id']);
    }
});

test ('fixture: reconcileExecutionStep', () => {
    const cases = fixture['reconcileCases'];
    assert.ok (cases.length > 0, 'the fixture has reconcile cases');
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        //  a case names either a route to plan from, or a plan written out in
        //  full — the latter is how a plan with field types no builder produces
        //  (an int hopIndex on one step and a float on the next) gets covered
        const plan = (testCase['plan'] !== undefined) ? fixture['plans'][testCase['plan']] : router.buildExecutionPlan (fixture['routes'][testCase['route']], testCase['planOptions']);
        const verdict = router.reconcileExecutionStep (plan, testCase['stepIndex'], testCase['realisedOut']);
        assertMatches (verdict, testCase['expected'], 'reconcileCase ' + testCase['id']);
    }
});

test ('fixture: numberAt reads one number grammar in all five languages', () => {
    //  Every port hand-implements JavaScript's parseFloat prefix grammar rather
    //  than calling its own parser, because every language's own parser
    //  disagrees with the other four somewhere. These cases are the contract:
    //  a cap read as 1234.5 in one language and 1 in another is a cap that
    //  silently disappears, and this table is what stops that shipping green.
    const cases = fixture['numberCases'];
    assert.ok (cases.length > 0, 'the fixture has number cases');
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        const actual = router.numberAt (testCase['container'], testCase['key'], testCase['default']);
        assert.ok (typeof actual === 'number', 'numberCase ' + testCase['id'] + ': not a number');
        assert.ok (numbersMatch (actual, testCase['expected']), 'numberCase ' + testCase['id'] + ': expected ' + String (testCase['expected']) + ', got ' + String (actual));
    }
});

test ('fixture: buildUnwindPlan', () => {
    const cases = fixture['unwindCases'];
    assert.ok (cases.length > 0, 'the fixture has unwind cases');
    for (let i = 0; i < cases.length; i++) {
        const testCase = cases[i];
        const report = fixture['reports'][testCase['report']];
        const unwind = router.buildUnwindPlan (report);
        assertMatches (unwind, testCase['expected'], 'unwindCase ' + testCase['id']);
    }
});

//  ---------------------------------------------------------------------------
//  2. invariants, asserted directly rather than through the fixture
//  ---------------------------------------------------------------------------

function oneLegRoute (side: string, base: string, quote: string, amount: number, price: number): any {
    return {
        'from': (side === 'buy') ? quote : base,
        'to': (side === 'buy') ? base : quote,
        'strategy': 'best_single',
        'exactSide': 'in',
        'amountIn': (side === 'buy') ? amount * price : amount,
        'amountOut': (side === 'buy') ? amount : amount * price,
        'fullyFillable': true,
        'fillRatio': 1,
        'unroutableReason': null,
        'hops': [
            {
                'pair': base + '/' + quote,
                'side': side,
                'base': base,
                'quote': quote,
                'amountIn': (side === 'buy') ? amount * price : amount,
                'amountOut': (side === 'buy') ? amount : amount * price,
                'legs': [ { 'exchangeId': 'stub', 'amount': amount, 'averagePrice': price, 'takerFeeRate': 0, 'feeCost': 0, 'effectivePrice': price } ],
                'fullyFillable': true,
            },
        ],
    };
}

const permissiveStubMarkets: any = {
    'stub': {
        'BTC/USDT': {
            'symbol': 'BTC/USDT',
            'base': 'BTC',
            'quote': 'USDT',
            'precision': { 'amount': 0, 'price': 0 },
            'limits': { 'amount': { 'min': 0, 'max': 0 }, 'price': { 'min': 0, 'max': 0 }, 'cost': { 'min': 0, 'max': 0 } },
        },
    },
};

test ('constructor: apiKey is required and the 25 USD cap may be lowered but never raised', () => {
    assert.throws (() => new OrderRouter ({}), ArgumentsRequired);
    assert.throws (() => new OrderRouter ({ 'apiKey': 'k', 'maxNotionalUsd': 25.01 }), BadRequest);
    assert.throws (() => new OrderRouter ({ 'apiKey': 'k', 'maxNotionalUsd': 0 }), BadRequest);
    const lowered = new OrderRouter ({ 'apiKey': 'k', 'maxNotionalUsd': 5 });
    assert.strictEqual (lowered.maxNotionalUsd, 5);
    const standard = new OrderRouter ({ 'apiKey': 'k' });
    assert.strictEqual (standard.maxNotionalUsd, 25);
    assert.strictEqual (OrderRouter.MAX_NOTIONAL_USD, 25);
});

test ('the limit price sits on the side that costs you, and only there', () => {
    const buy = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 1, 100), { 'slippageBps': 100 });
    assert.strictEqual (buy['steps'][0]['limitPrice'], 101, 'a buy pays up to 1% more');
    const sell = router.buildExecutionPlan (oneLegRoute ('sell', 'BTC', 'USDT', 1, 100), { 'slippageBps': 100 });
    assert.strictEqual (sell['steps'][0]['limitPrice'], 99, 'a sell accepts down to 1% less');
    const none = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 1, 100), { 'slippageBps': 0 });
    assert.strictEqual (none['steps'][0]['limitPrice'], 100, 'zero slippage means the expected price');
});

test ('the notional cap blocks at 25 USD and passes below it', () => {
    //  amount * limitPrice is what is measured, so a 1% slippage on a 24.90 USD
    //  step is what carries it over the line
    const under = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.24, 100), { 'slippageBps': 0 });
    const underViolations = router.checkExecutionPlanSafety (under, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 } });
    assert.deepStrictEqual (underViolations, [], '24 USD passes');
    const at = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.25, 100), { 'slippageBps': 0 });
    assert.deepStrictEqual (router.checkExecutionPlanSafety (at, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 } }), [], 'exactly 25 USD passes');
    const over = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2501, 100), { 'slippageBps': 0 });
    const overViolations = router.checkExecutionPlanSafety (over, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (overViolations.length, 1);
    assert.strictEqual (overViolations[0]['code'], 'notional_exceeds_cap');
    assert.strictEqual (overViolations[0]['blocking'], true);
    //  and the slippage is inside the measurement, not outside it
    const slipped = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.249, 100), { 'slippageBps': 100 });
    const slippedViolations = router.checkExecutionPlanSafety (slipped, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (slippedViolations.length, 1, '24.90 USD at 1% slippage is 25.15 USD of risk');
    assert.strictEqual (slippedViolations[0]['code'], 'notional_exceeds_cap');
});

test ('a step that cannot be valued in USD BLOCKS — it is never skipped', () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.0001, 100), { 'slippageBps': 0 });
    //  0.01 USDT of notional: trivially under any cap, and still refused,
    //  because the point is that the cap could not be EVALUATED
    const violations = router.checkExecutionPlanSafety (plan, permissiveStubMarkets, { 'usdRates': {} });
    assert.strictEqual (violations.length, 1);
    assert.strictEqual (violations[0]['code'], 'notional_unvaluable');
    assert.strictEqual (violations[0]['blocking'], true, 'an unvaluable step must block, or the cap is decorative');
    //  unrelated rates do not help
    const stillBlocked = router.checkExecutionPlanSafety (plan, permissiveStubMarkets, { 'usdRates': { 'ETH': 3000, 'DOGE': 0.09 } });
    assert.strictEqual (stillBlocked[0]['code'], 'notional_unvaluable');
    //  either side of the market resolves it
    assert.deepStrictEqual (router.checkExecutionPlanSafety (plan, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 } }), []);
    assert.deepStrictEqual (router.checkExecutionPlanSafety (plan, permissiveStubMarkets, { 'usdRates': { 'BTC': 100 } }), []);
});

test ('USDT is not assumed to be one dollar; USD is', () => {
    const usdtPlan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), { 'slippageBps': 0 });
    const usdtViolations = router.checkExecutionPlanSafety (usdtPlan, permissiveStubMarkets, { 'usdRates': { 'USD': 1 } });
    assert.strictEqual (usdtViolations.length, 1);
    assert.strictEqual (usdtViolations[0]['code'], 'notional_unvaluable', 'a stablecoin peg is an observation, not a definition');
    //  a depegged rate is respected: 10 USDT at 0.40 is 4 USD
    const depegged = router.checkExecutionPlanSafety (usdtPlan, permissiveStubMarkets, { 'usdRates': { 'USDT': 0.4 } });
    assert.deepStrictEqual (depegged, []);
});

test ('an empty plan is not a safe plan', () => {
    const plan = router.buildExecutionPlan (fixture['routes']['unroutable'], {});
    assert.strictEqual (plan['steps'].length, 0);
    const violations = router.checkExecutionPlanSafety (plan, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (violations.length, 1);
    assert.strictEqual (violations[0]['code'], 'empty_plan');
    assert.strictEqual (violations[0]['blocking'], true, 'zero violations on zero steps would read as approval');
});

test ('reconcileExecutionStep never scales a downstream order UP', () => {
    const route = fixture['routes']['multiHop'];
    const plan = router.buildExecutionPlan (route, {});
    const overfilled = router.reconcileExecutionStep (plan, 0, 1000000);
    assert.strictEqual (overfilled['scale'], 1, 'an overfill must not grow an order the safety check never saw');
    assert.strictEqual (overfilled['verdict'], 'proceed');
    const downstream = overfilled['resizedSteps'][0];
    assert.strictEqual (downstream['amount'], downstream['previousAmount']);
});

test ('reconcileExecutionStep halts on a total miss and on an over-tolerance shortfall', () => {
    const plan = router.buildExecutionPlan (fixture['routes']['multiHop'], {});
    assert.strictEqual (router.reconcileExecutionStep (plan, 0, 0)['verdict'], 'halt');
    assert.strictEqual (router.reconcileExecutionStep (plan, 0, 0)['reason'], 'nothing_filled');
    //  expectedOut of step 0 is 500 * 0.089 = 44.5; 2% of that is 0.89
    assert.strictEqual (router.reconcileExecutionStep (plan, 0, 44.5 - 0.88)['verdict'], 'proceed');
    assert.strictEqual (router.reconcileExecutionStep (plan, 0, 44.5 - 0.9)['verdict'], 'halt');
    assert.strictEqual (router.reconcileExecutionStep (plan, 0, 44.5 - 0.9)['reason'], 'shortfall_exceeds_tolerance');
    assert.throws (() => router.reconcileExecutionStep (plan, 7, 1), BadRequest);
});

test ('buildUnwindPlan is never automatic and never nets across venues', () => {
    const unwind = router.buildUnwindPlan (fixture['reports']['haltedCrossVenue']);
    assert.strictEqual (unwind['requiresConfirmation'], true);
    assert.strictEqual (unwind['automatic'], false);
    assert.strictEqual (unwind['residualCount'], 2, 'the mexc USDT and the binance SOL are separate positions');
    //  the USDT sold on mexc and the USDT spent on binance are NOT the same
    //  money, because this class never moves funds between venues
    const venues = [ unwind['steps'][0]['exchangeId'], unwind['steps'][1]['exchangeId'] ];
    assert.deepStrictEqual (venues, [ 'binance', 'mexc' ], 'unwound in reverse execution order');
    assert.strictEqual (unwind['steps'][1]['side'], 'buy', 'leftover quote is spent buying the asset back');
    assert.strictEqual (unwind['steps'][1]['amount'], 500, '44.5 USDT at 0.089 is 500 DOGE');
    assert.strictEqual (unwind['steps'][1]['reachesFrom'], true);
    assert.strictEqual (unwind['steps'][0]['side'], 'sell', 'leftover base is sold back');
    assert.strictEqual (unwind['steps'][0]['reachesFrom'], false, 'selling SOL for USDT is not yet DOGE');
});

//  ---------------------------------------------------------------------------
//  3. execute — stub venues only, and not one real order anywhere
//  ---------------------------------------------------------------------------

class StubVenue {
    id: string;
    markets: any;
    features: any;
    calls: string[];
    fillRatio: number;
    failCreate: boolean;
    //  a queue of orders fetchOrder hands back, one per poll; empty means the
    //  created order comes back closed on the first read
    fetchOrderResults: any[];
    fetchOrderThrows: boolean;
    cancelThrows: boolean;
    createdStatus: string;
    //  createOrder throws a NETWORK error: the order may or may not have reached the venue
    timeoutCreate: boolean;
    //  answers createOrder WITHOUT filled/average/cost, as several real venues do
    omitFillFields: boolean;
    //  {cost, currency} attached to the created order, as real venues do
    feeToCharge: any;
    //  concurrency witness: how many createOrder calls were in flight at their peak
    inFlight: number;
    peakInFlight: number;

    constructor (id: string, fillRatio: number = 1, failCreate: boolean = false) {
        this.id = id;
        this.fillRatio = fillRatio;
        this.failCreate = failCreate;
        this.calls = [];
        this.markets = permissiveStubMarkets['stub'];
        this.features = { 'spot': { 'createOrder': { 'timeInForce': [ 'GTC', 'IOC' ] } } };
        this.fetchOrderResults = [];
        this.fetchOrderThrows = false;
        this.cancelThrows = false;
        this.createdStatus = '';
        this.timeoutCreate = false;
        this.omitFillFields = false;
        this.feeToCharge = undefined;
        this.inFlight = 0;
        this.peakInFlight = 0;
    }

    async fetchOrder (id: string, symbol: string) {
        this.calls.push ('fetchOrder:' + id);
        if (this.fetchOrderThrows) {
            throw new ExchangeError ('stub cannot read the order back');
        }
        if (this.fetchOrderResults.length > 0) {
            return this.fetchOrderResults.shift ();
        }
        return { 'id': id, 'status': 'closed', 'filled': 0, 'average': 0, 'cost': 0 };
    }

    async cancelOrder (id: string, symbol: string) {
        this.calls.push ('cancelOrder:' + id);
        if (this.cancelThrows) {
            throw new ExchangeError ('stub refuses to cancel');
        }
        return { 'id': id, 'status': 'canceled' };
    }

    async loadMarkets () {
        this.calls.push ('loadMarkets');
        return this.markets;
    }

    amountToPrecision (symbol: string, amount: number): string {
        return amount.toString ();
    }

    priceToPrecision (symbol: string, price: number): string {
        return price.toString ();
    }

    async fetchBalance () {
        this.calls.push ('fetchBalance');
        return { 'free': { 'USDT': 1000, 'BTC': 1, 'ZERO': 0 }, 'total': { 'USDT': 1000, 'BTC': 1 } };
    }

    async createOrder (symbol: string, type: string, side: string, amount: number, price: any = undefined, params: any = {}) {
        this.calls.push ('createOrder:' + type + ':' + side + ':' + amount.toString ());
        this.inFlight = this.inFlight + 1;
        if (this.inFlight > this.peakInFlight) {
            this.peakInFlight = this.inFlight;
        }
        //  yield, so a caller that really does run legs concurrently overlaps here
        await new Promise ((resolve) => setTimeout (resolve, 1));
        this.inFlight = this.inFlight - 1;
        if (this.timeoutCreate) {
            throw new RequestTimeout ('stub timed out');
        }
        if (this.failCreate) {
            throw new ExchangeError ('stub refuses');
        }
        const filled = amount * this.fillRatio;
        const average = (price === undefined) ? 100 : price;
        const status = (this.createdStatus === '') ? 'closed' : this.createdStatus;
        if (this.omitFillFields) {
            return { 'id': 'stub-order', 'status': status };
        }
        const body: any = { 'id': 'stub-order', 'status': status, 'filled': filled, 'average': average, 'cost': filled * average };
        if (this.feeToCharge !== undefined) {
            body['fee'] = this.feeToCharge;
        }
        return body;
    }
}

function twoHopRoute (): any {
    return {
        'from': 'USDT',
        'to': 'SOL',
        'strategy': 'best_single',
        'exactSide': 'in',
        'amountIn': 20,
        'amountOut': 0.2,
        'fullyFillable': true,
        'fillRatio': 1,
        'unroutableReason': null,
        'hops': [
            { 'pair': 'BTC/USDT', 'side': 'buy', 'base': 'BTC', 'quote': 'USDT', 'amountIn': 20, 'amountOut': 0.2, 'legs': [ { 'exchangeId': 'stub', 'amount': 0.2, 'averagePrice': 100, 'effectivePrice': 100 } ] },
            { 'pair': 'BTC/USDT', 'side': 'sell', 'base': 'BTC', 'quote': 'USDT', 'amountIn': 0.2, 'amountOut': 20, 'legs': [ { 'exchangeId': 'stub', 'amount': 0.2, 'averagePrice': 100, 'effectivePrice': 100 } ] },
        ],
    };
}

test ('dry_run is the default: a live-looking call with live unset places nothing', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), {});
    const venue = new StubVenue ('stub');
    //  everything a real call would carry, EXCEPT live
    const report = await router.execute (plan, { 'stub': venue }, {
        'strategy': 'sequential',
        'usdRates': { 'USDT': 1 },
        'allowMarketOrders': true,
    });
    assert.strictEqual (report['dryRun'], true);
    assert.strictEqual (report['strategy'], 'dry_run');
    assert.strictEqual (report['requestedStrategy'], 'sequential', 'the report says what was asked for as well as what happened');
    assert.strictEqual (report['ordersPlaced'], 0);
    assert.strictEqual (report['wouldPlaceOrders'], 1);
    assert.strictEqual (report['steps'][0]['status'], 'planned');
    assert.deepStrictEqual (venue.calls, [], 'not one call reached the venue — not even a read');
    //  live: false and live: 'true' are both not-true
    for (const notLive of [ false, undefined, 'true', 1 ]) {
        const other = new StubVenue ('stub');
        const again = await router.execute (plan, { 'stub': other }, { 'strategy': 'sequential', 'live': notLive as any, 'usdRates': { 'USDT': 1 } });
        assert.strictEqual (again['dryRun'], true, 'live must be exactly true');
        assert.deepStrictEqual (other.calls, []);
    }
});

test ('execute refuses to go live without a way to value the trade in USD', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), {});
    const venue = new StubVenue ('stub');
    await assert.rejects (async () => {
        await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true });
    }, ExchangeError);
    assert.ok (venue.calls.indexOf ('createOrder:limit:buy:0.2') < 0, 'no order was placed');
});

test ('execute refuses to go live above the cap', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 5, 100), {});
    const venue = new StubVenue ('stub');
    await assert.rejects (async () => {
        await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    }, ExchangeError);
    for (let i = 0; i < venue.calls.length; i++) {
        assert.ok (venue.calls[i].indexOf ('createOrder') < 0, 'no order was placed');
    }
});

test ('sequential places IOC limit orders in plan order', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), { 'slippageBps': 100 });
    const venue = new StubVenue ('stub');
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['dryRun'], false);
    assert.strictEqual (report['ordersPlaced'], 1);
    assert.strictEqual (report['steps'][0]['status'], 'filled');
    assert.strictEqual (report['steps'][0]['outAsset'], 'BTC');
    assert.strictEqual (report['steps'][0]['outAmount'], 0.2);
    assert.strictEqual (report['steps'][0]['inAsset'], 'USDT');
    assert.deepStrictEqual (venue.calls, [ 'createOrder:limit:buy:0.2' ]);
    assert.strictEqual (report['halted'], false);
});

test ('sequential obeys the halt verdict and never starts the next hop', async () => {
    const plan = router.buildExecutionPlan (twoHopRoute (), {});
    //  hop 0 fills half: a 50% shortfall against a 2% tolerance
    const venue = new StubVenue ('stub', 0.5);
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['halted'], true);
    assert.strictEqual (report['haltReason'], 'shortfall_exceeds_tolerance');
    assert.strictEqual (report['haltStepIndex'], 0);
    assert.strictEqual (report['ordersPlaced'], 1, 'the second hop was never attempted');
    assert.strictEqual (report['steps'][1]['status'], 'skipped');
    assert.strictEqual (venue.calls.length, 1);
    //  and the halted report is exactly what buildUnwindPlan is for
    const unwind = router.buildUnwindPlan (report);
    assert.strictEqual (unwind['residualCount'], 1);
    assert.strictEqual (unwind['steps'][0]['side'], 'sell', 'the BTC bought on hop 0 goes back to USDT');
    assert.strictEqual (unwind['steps'][0]['reachesFrom'], true);
});

test ('a market order needs BOTH a venue that cannot do IOC and an explicit opt-in', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), {});
    //  a venue that advertises GTC only
    const noIoc = new StubVenue ('stub');
    noIoc.features = { 'spot': { 'createOrder': { 'timeInForce': [ 'GTC' ] } } };
    const refused = await router.execute (plan, { 'stub': noIoc }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (refused['steps'][0]['status'], 'failed');
    assert.strictEqual (refused['steps'][0]['errorCode'], 'NotSupported');
    assert.deepStrictEqual (noIoc.calls, [], 'defaulting to a market order is the decision the caller did not delegate');
    const allowed = new StubVenue ('stub');
    allowed.features = { 'spot': { 'createOrder': { 'timeInForce': [ 'GTC' ] } } };
    const placed = await router.execute (plan, { 'stub': allowed }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 }, 'allowMarketOrders': true });
    assert.strictEqual (placed['steps'][0]['status'], 'filled');
    assert.deepStrictEqual (allowed.calls, [ 'createOrder:market:buy:0.2' ]);
    //  a venue that says nothing about timeInForce is assumed to do IOC: a
    //  rejected IOC is loud and cheap, an unintended market order is not
    const unknown = new StubVenue ('stub');
    unknown.features = {};
    const assumed = await router.execute (plan, { 'stub': unknown }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (assumed['steps'][0]['status'], 'filled');
    assert.deepStrictEqual (unknown.calls, [ 'createOrder:limit:buy:0.2' ]);
});

test ('parallel_within_hop contains a failing leg instead of abandoning its siblings', async () => {
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['hops'][0]['legs'] = [
        { 'exchangeId': 'good', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'bad', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'good2', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
    ];
    const plan = router.buildExecutionPlan (route, {});
    const good = new StubVenue ('good');
    const bad = new StubVenue ('bad', 1, true);
    const good2 = new StubVenue ('good2');
    const report = await router.execute (plan, { 'good': good, 'bad': bad, 'good2': good2 }, { 'strategy': 'parallel_within_hop', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['status'], 'filled');
    assert.strictEqual (report['steps'][1]['status'], 'failed');
    assert.strictEqual (report['steps'][2]['status'], 'filled', 'the sibling behind the failure still ran');
    assert.strictEqual (report['errors'].length, 1);
    assert.strictEqual (report['errors'][0]['exchangeId'], 'bad');
    assert.strictEqual (report['halted'], true, 'a failed leg still halts the route after the hop settles');
    assert.strictEqual (report['haltReason'], 'order_failed');
});

test ('best_effort refuses multi-hop and demands both of its acknowledgements', async () => {
    const multiHop = router.buildExecutionPlan (twoHopRoute (), {});
    const venue = new StubVenue ('stub');
    await assert.rejects (async () => {
        await router.execute (multiHop, { 'stub': venue }, { 'strategy': 'best_effort', 'live': true, 'usdRates': { 'USDT': 1 }, 'acknowledgeDispersion': true, 'maxOrders': 5 });
    }, NotSupported);
    const singleHop = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), {});
    await assert.rejects (async () => {
        await router.execute (singleHop, { 'stub': venue }, { 'strategy': 'best_effort', 'live': true, 'usdRates': { 'USDT': 1 }, 'maxOrders': 5 });
    }, BadRequest);
    await assert.rejects (async () => {
        await router.execute (singleHop, { 'stub': venue }, { 'strategy': 'best_effort', 'live': true, 'usdRates': { 'USDT': 1 }, 'acknowledgeDispersion': true });
    }, BadRequest);
    assert.deepStrictEqual (venue.calls, []);
});

test ('best_effort stops at maxOrders and never halts', async () => {
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['hops'][0]['legs'] = [
        { 'exchangeId': 'a', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'b', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'c', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
    ];
    const plan = router.buildExecutionPlan (route, {});
    const venues = { 'a': new StubVenue ('a'), 'b': new StubVenue ('b', 0.01), 'c': new StubVenue ('c') };
    const report = await router.execute (plan, venues, { 'strategy': 'best_effort', 'live': true, 'usdRates': { 'USDT': 1 }, 'acknowledgeDispersion': true, 'maxOrders': 2 });
    assert.strictEqual (report['ordersPlaced'], 2);
    assert.strictEqual (report['steps'][2]['status'], 'skipped');
    assert.strictEqual (report['steps'][2]['errorCode'], 'max_orders_reached');
    assert.strictEqual (report['halted'], false, 'a 1% fill on leg b does not stop best_effort — that is the whole strategy');
    assert.deepStrictEqual (venues['c'].calls, []);
});

test ('the hard 25 USD cap survives a writable maxNotionalUsd', () => {
    //  the constructor refuses to be built above 25, but the field stays
    //  writable in TypeScript, Python, PHP and Go. A ceiling that one assignment
    //  removes is not a ceiling, so both clamp sites re-impose the constant.
    const tampered: any = new OrderRouter ({ 'apiKey': 'k' });
    tampered.maxNotionalUsd = 1000;
    //  0.005 BTC at 100000 USDT is 500 USD
    const plan = tampered.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.005, 100000), { 'slippageBps': 0 });
    const violations = tampered.checkExecutionPlanSafety (plan, permissiveStubMarkets, { 'usdRates': { 'USDT': 1 }, 'maxNotionalUsd': 1000 });
    assert.strictEqual (violations.length, 1, 'a 500 USD step must still be refused');
    assert.strictEqual (violations[0]['code'], 'notional_exceeds_cap');
    assert.strictEqual (violations[0]['limit'], 25, 'the limit reported is the constant, not the tampered field');
    assert.throws (() => tampered.assertUnderCap (plan['steps'][0], 0.005, 100000, { 'USDT': 1 }, { 'maxNotionalUsd': 1000 }), ExchangeError, 'and the last check before an order goes out refuses too');
});

test ('best_effort derives the hop count from the steps, not from a key the plan may not carry', async () => {
    //  a plan that travelled through JSON, was rebuilt from persisted steps, or
    //  is the tail of a halted route can be missing hopCount entirely
    const complete = router.buildExecutionPlan (twoHopRoute (), {});
    const withoutHopCount: any = {};
    const keys = Object.keys (complete);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== 'hopCount') {
            withoutHopCount[keys[i]] = complete[keys[i]];
        }
    }
    assert.strictEqual (withoutHopCount['hopCount'], undefined, 'the plan really has no hopCount');
    assert.strictEqual (withoutHopCount['steps'].length, 2);
    const venue = new StubVenue ('stub', 0.1);
    await assert.rejects (async () => {
        await router.execute (withoutHopCount, { 'stub': venue }, { 'strategy': 'best_effort', 'live': true, 'usdRates': { 'USDT': 1 }, 'acknowledgeDispersion': true, 'maxOrders': 5 });
    }, NotSupported, 'best_effort across a bridge is refused however the plan reached us');
    assert.deepStrictEqual (venue.calls, [], 'not one order was placed');
});

test ('venueSupportsIoc reads the dictionary of booleans every real exchange declares', async () => {
    const noIoc = new StubVenue ('stub');
    //  the shape ccxt actually uses: features.spot.createOrder.timeInForce is a
    //  dictionary, never a list. bit2c, bitbank, bithumb and coinone all say
    //  IOC: false, and reading this as a list answered "yes" for every one.
    noIoc.features = { 'spot': { 'createOrder': { 'timeInForce': { 'IOC': false, 'FOK': false, 'PO': false, 'GTD': false, 'GTC': true } } } };
    assert.strictEqual (router.venueSupportsIoc (noIoc), false);
    const withIoc = new StubVenue ('stub');
    withIoc.features = { 'spot': { 'createOrder': { 'timeInForce': { 'IOC': true, 'FOK': true, 'PO': true, 'GTD': false, 'GTC': true } } } };
    assert.strictEqual (router.venueSupportsIoc (withIoc), true);
    //  a dictionary that enumerates its values and omits IOC has said no
    const silentAboutIoc = new StubVenue ('stub');
    silentAboutIoc.features = { 'spot': { 'createOrder': { 'timeInForce': { 'GTC': true } } } };
    assert.strictEqual (router.venueSupportsIoc (silentAboutIoc), false);
    //  and a venue that says nothing at all is still assumed to do IOC
    const silent = new StubVenue ('stub');
    silent.features = {};
    assert.strictEqual (router.venueSupportsIoc (silent), true);
    //  end to end: the documented market-order fallback is reachable again
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), {});
    const refused = await router.execute (plan, { 'stub': noIoc }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (refused['steps'][0]['errorCode'], 'NotSupported');
    assert.deepStrictEqual (noIoc.calls, [], 'an IOC was never sent to a venue that cannot do one');
    const allowed = new StubVenue ('stub');
    allowed.features = noIoc.features;
    const placed = await router.execute (plan, { 'stub': allowed }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 }, 'allowMarketOrders': true });
    assert.strictEqual (placed['steps'][0]['status'], 'filled');
    assert.deepStrictEqual (allowed.calls, [ 'createOrder:market:buy:0.2' ]);
});

test ('limit_protected keeps the fill from an order the venue canceled on the last poll', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.0002, 100000), { 'slippageBps': 0 });
    const venue = new StubVenue ('stub');
    venue.createdStatus = 'open';
    //  the venue ends the order itself between the last two polls — an expiry, a
    //  self-trade prevention, a post-only rejection of the remainder — and it
    //  carries a real partial fill
    venue.fetchOrderResults = [
        { 'id': 'stub-order', 'status': 'open', 'filled': 0, 'average': 0, 'cost': 0 },
        { 'id': 'stub-order', 'status': 'canceled', 'filled': 0.0001, 'average': 100000, 'cost': 10 },
    ];
    venue.cancelThrows = true;
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'limit_protected', 'live': true, 'usdRates': { 'USDT': 1 }, 'orderTimeoutMs': 2, 'pollIntervalMs': 1 });
    assert.ok (venue.calls.indexOf ('cancelOrder:stub-order') < 0, 'an order the venue already closed is not cancelled again');
    assert.strictEqual (report['steps'][0]['status'], 'partial');
    assert.strictEqual (report['steps'][0]['filledAmount'], 0.0001);
    assert.strictEqual (report['steps'][0]['outAmount'], 0.0001);
    assert.strictEqual (report['steps'][0]['orderId'], 'stub-order');
    assert.deepStrictEqual (report['openOrders'], [], 'nothing is open: the venue closed it');
    //  and the 0.0001 BTC that was actually bought reaches the unwind plan
    const unwind = router.buildUnwindPlan (report);
    assert.strictEqual (unwind['residualCount'], 1, 'a real position must never be invisible to the unwind path');
    assert.strictEqual (unwind['steps'][0]['amount'], 0.0001);
});

test ('a failure after createOrder still reports the order id and an open order', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.0002, 100000), { 'slippageBps': 0 });
    const venue = new StubVenue ('stub');
    venue.createdStatus = 'open';
    //  createOrder succeeded; the first poll never comes back
    venue.fetchOrderThrows = true;
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'limit_protected', 'live': true, 'usdRates': { 'USDT': 1 }, 'orderTimeoutMs': 4, 'pollIntervalMs': 1 });
    assert.strictEqual (report['steps'][0]['status'], 'failed');
    assert.strictEqual (report['steps'][0]['orderId'], 'stub-order', 'the id is captured the instant createOrder returns, not after the read');
    assert.strictEqual (report['openOrders'].length, 1, 'a live order the caller cannot see is the worst outcome there is');
    assert.strictEqual (report['openOrders'][0]['orderId'], 'stub-order');
    assert.strictEqual (report['openOrders'][0]['exchangeId'], 'stub');
    assert.strictEqual (report['openOrders'][0]['reason'], 'outcome_unknown');
    //  the same holds for an immediate order, which has no poll loop at all
    const other = new StubVenue ('stub');
    other.createdStatus = 'open';
    const overCap = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.0002, 100000), { 'slippageBps': 0 });
    const okReport = await router.execute (overCap, { 'stub': other }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (okReport['steps'][0]['orderId'], 'stub-order');
    //  and an "immediate" order the venue reports as STILL OPEN is a resting
    //  order, which is what a venue that silently drops timeInForce leaves you
    assert.strictEqual (okReport['openOrders'].length, 1);
    assert.strictEqual (okReport['openOrders'][0]['orderId'], 'stub-order');
    assert.strictEqual (okReport['openOrders'][0]['reason'], 'still_open');
});

test ('an unknown strategy is refused even in dry run', async () => {
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.2, 100), {});
    await assert.rejects (async () => {
        await router.execute (plan, {}, { 'strategy': 'yolo' });
    }, BadRequest);
});

test ('atomic_ish demands the whole route pre-funded', async () => {
    const plan = router.buildExecutionPlan (twoHopRoute (), {});
    const poor = new StubVenue ('stub');
    //  hop 0 needs 20 USDT and hop 1 needs 0.2 BTC, both already sitting there
    const rich = await router.execute (plan, { 'stub': poor }, { 'strategy': 'atomic_ish', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (rich['ordersPlaced'], 2, 'a pre-funded route runs end to end');
    const broke = new StubVenue ('stub');
    broke.fetchBalance = (async () => ({ 'free': { 'USDT': 1, 'BTC': 0 } })) as any;
    await assert.rejects (async () => {
        await router.execute (plan, { 'stub': broke }, { 'strategy': 'atomic_ish', 'live': true, 'usdRates': { 'USDT': 1 } });
    }, ExchangeError);
});

//  ---------------------------------------------------------------------------
//  4. fetchRoute request shaping and fetchRouteWithBalances, with the HTTP
//     layer stubbed out — no network
//  ---------------------------------------------------------------------------

class RecordingRouter extends OrderRouter {
    lastUrl: string;
    body: any;

    constructor (config: any, body: any) {
        super (config);
        this.body = body;
        this.lastUrl = '';
    }

    override async request (url: string): Promise<any> {
        this.lastUrl = url;
        return this.body;
    }
}

test ('fetchRoute refuses neither-or-both amounts before touching the network', async () => {
    const recorder = new RecordingRouter ({ 'apiKey': 'k' }, {});
    await assert.rejects (async () => {
        await recorder.fetchRoute ('USDT', 'BTC', {});
    }, BadRequest);
    await assert.rejects (async () => {
        await recorder.fetchRoute ('USDT', 'BTC', { 'amountIn': 1, 'amountOut': 1 });
    }, BadRequest);
    assert.strictEqual (recorder.lastUrl, '', 'neither reached the wire');
});

test ('fetchRoute builds a deterministic query', async () => {
    const recorder = new RecordingRouter ({ 'apiKey': 'k', 'baseUrl': 'https://example.test/api/' }, { 'hops': [] });
    await recorder.fetchRoute ('usdt', 'btc', { 'amountIn': 0.001, 'strategy': 'split_capped', 'maxVenues': 3, 'exchanges': [ 'binance', 'kraken' ], 'certified': true });
    assert.strictEqual (recorder.lastUrl, 'https://example.test/api/route?from=USDT&to=BTC&amountIn=0.001&strategy=split_capped&maxVenues=3&exchanges=binance%2Ckraken&certified=true');
});

test ('fetchRouteWithBalances skips zeros, sorts largest first and reports what it dropped', async () => {
    const recorder = new RecordingRouter ({ 'apiKey': 'k' }, { 'hops': [], 'balancesApplied': 'stub.BTC:1,stub.USDT:1000' });
    const route = await recorder.fetchRouteWithBalances ('USDT', 'BTC', { 'stub': new StubVenue ('stub') }, { 'amountIn': 10 });
    assert.strictEqual (route['balancesUsed'], 'stub.USDT:1000,stub.BTC:1', 'largest first, and the ZERO holding is gone');
    assert.deepStrictEqual (route['balancesDropped'], []);
    assert.ok (recorder.lastUrl.indexOf ('balances=stub.USDT%3A1000%2Cstub.BTC%3A1') >= 0);
});

test ('fetchRouteWithBalances refuses a route computed against balances the router ignored', async () => {
    const silent = new RecordingRouter ({ 'apiKey': 'k' }, { 'hops': [] });
    await assert.rejects (async () => {
        await silent.fetchRouteWithBalances ('USDT', 'BTC', { 'stub': new StubVenue ('stub') }, { 'amountIn': 10 });
    }, ExchangeError);
    //  and the caller can opt out with their eyes open
    const opted = new RecordingRouter ({ 'apiKey': 'k' }, { 'hops': [] });
    const route = await opted.fetchRouteWithBalances ('USDT', 'BTC', { 'stub': new StubVenue ('stub') }, { 'amountIn': 10, 'requireBalancesApplied': false });
    assert.strictEqual (route['balancesUsed'], 'stub.USDT:1000,stub.BTC:1');
});

test ('fetchRouteWithBalances trims to the router 64-entry cap, dropping the smallest', async () => {
    const recorder = new RecordingRouter ({ 'apiKey': 'k' }, { 'hops': [], 'balancesApplied': 'x' });
    const many = new StubVenue ('stub');
    const free: any = {};
    for (let i = 0; i < 70; i++) {
        free['C' + i.toString ()] = i + 1;
    }
    many.fetchBalance = (async () => ({ 'free': free })) as any;
    const route = await recorder.fetchRouteWithBalances ('USDT', 'BTC', { 'stub': many }, { 'amountIn': 10 });
    assert.strictEqual (route['balancesDropped'].length, 6);
    assert.strictEqual (route['balancesUsed'].split (',').length, 64);
    for (let i = 0; i < route['balancesDropped'].length; i++) {
        assert.strictEqual (route['balancesDropped'][i]['reason'], 'entry_cap');
        assert.ok (route['balancesDropped'][i]['amount'] <= 6, 'the six smallest holdings are the ones that went');
    }
});

test ('formatNumber never emits exponent notation', () => {
    assert.strictEqual (router.formatNumber (0.0000001), '0.0000001');
    assert.throws (() => router.formatNumber (1e21), BadRequest, 'refused rather than rendered as 1e+21 in one language and not the others');
    assert.strictEqual (router.formatNumber (0), '0');
    assert.strictEqual (router.formatNumber (1000000), '1000000');
    assert.strictEqual (router.formatNumber (0.5), '0.5');
    assert.strictEqual (router.formatNumber (1e-15), '0');
});

test ('a createOrder that times out is outcome-unknown, not a plain failure', async () => {
    //  The venue's answer never arrived, so the order may be live. Reporting 'failed' asserts
    //  nothing happened — the one reading that is certainly wrong — and the id is blank precisely
    //  because the call that would have returned it is the call that died, so an id-keyed
    //  openOrders entry cannot carry the warning either.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub');
    venue.timeoutCreate = true;
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['status'], 'outcome_unknown');
    assert.strictEqual (report['steps'][0]['errorCode'], 'RequestTimeout');
    assert.strictEqual (report['openOrders'].length, 1, 'an operator must be told an order may be live');
    assert.strictEqual (report['openOrders'][0]['reason'], 'placement_unconfirmed');
    assert.strictEqual (report['openOrders'][0]['orderId'], '');
    assert.strictEqual (report['openOrders'][0]['exchangeId'], 'stub');
    assert.strictEqual (report['halted'], true);
});

test ('a definite rejection stays a plain failure and reports no open order', async () => {
    //  The counterpart: the venue ANSWERED, so no order exists. Flagging every rejection as
    //  possibly-live would bury the ones that genuinely are.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub', 1, true);
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['status'], 'failed');
    assert.strictEqual (report['openOrders'].length, 0);
});

test ('a failure BEFORE dispatch records no open order', async () => {
    //  A size that rounds to zero never reaches the venue, so there is nothing to reconcile and a
    //  warning here would be a false alarm.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub');
    venue.amountToPrecision = () => '0';
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['errorCode'], 'rounded_to_zero');
    assert.strictEqual (report['openOrders'].length, 0);
    assert.deepStrictEqual (venue.calls, [], 'nothing was dispatched');
});

test ('a venue that omits filled is re-read, not guessed at', async () => {
    //  "the venue said zero" and "the venue said nothing" used to produce the same 0, which
    //  reconciliation read as nothing_filled — halting the route while a real position existed.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub');
    venue.omitFillFields = true;
    //  the re-read DOES know the fill
    venue.fetchOrderResults = [ { 'id': 'stub-order', 'status': 'closed', 'filled': 0.1, 'average': 100, 'cost': 10 } ];
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.ok (venue.calls.indexOf ('fetchOrder:stub-order') !== -1, 'the immediate path must confirm the fill');
    assert.strictEqual (report['steps'][0]['status'], 'filled');
    assert.strictEqual (report['steps'][0]['filledAmount'], 0.1);
    assert.strictEqual (report['steps'][0]['filledKnown'], true);
});

test ('a fill that stays unknown after the re-read halts instead of reconciling on a guess', async () => {
    //  Halting on an unknown quantity is recoverable: an operator reads the order back and
    //  resumes. Sizing the next hop from an invented number is not.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub');
    venue.omitFillFields = true;
    venue.fetchOrderResults = [ { 'id': 'stub-order', 'status': 'closed' } ];
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['status'], 'outcome_unknown');
    assert.strictEqual (report['steps'][0]['filledKnown'], false);
    assert.strictEqual (report['halted'], true);
    assert.strictEqual (report['haltReason'], 'outcome_unknown', 'never nothing_filled: that is the one thing we do not know');
    assert.strictEqual (report['openOrders'][0]['reason'], 'fill_unconfirmed');
});

test ('a venue that reports a genuine zero fill is still nothing_filled', async () => {
    //  The counterpart: zero IS an answer, and must not be relabelled as unknown.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub', 0);
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['filledKnown'], true);
    assert.strictEqual (report['steps'][0]['status'], 'unfilled');
    assert.strictEqual (report['haltReason'], 'nothing_filled');
});

test ('two legs of one hop combine their shortfalls instead of compounding them', async () => {
    //  Each leg used to compute a scale from the hop total and multiply the downstream amounts by
    //  it, so the second leg scaled an already-scaled number. Measured before the fix: 80% and 60%
    //  fills sized the next hop at 144 when only 140 had arrived — 0.9 x 0.8 = 0.72 of the hop
    //  rather than the true 0.70. Over-sizing the next hop is not a rounding nuisance: it is a
    //  guaranteed insufficient-funds halt on exactly the bridged routes this class exists for.
    const steps = [
        { 'stepIndex': 0, 'hopIndex': 0, 'legIndex': 0, 'amount': 1, 'expectedPrice': 100, 'side': 'sell', 'base': 'BTC', 'quote': 'USDT' },
        { 'stepIndex': 1, 'hopIndex': 0, 'legIndex': 1, 'amount': 1, 'expectedPrice': 100, 'side': 'sell', 'base': 'BTC', 'quote': 'USDT' },
        { 'stepIndex': 2, 'hopIndex': 1, 'legIndex': 0, 'amount': 200, 'expectedPrice': 1, 'side': 'buy', 'base': 'ETH', 'quote': 'USDT' },
    ];
    //  tolerance 1 so the shortfalls resize rather than halt
    const plan = { 'steps': steps, 'reconcileToleranceRatio': 1 };
    const expectedPerLeg = router.stepExpectedOut (steps[0]);
    const first = router.reconcileExecutionStep (plan, 0, expectedPerLeg * 0.8);
    router.applyResize (steps, first);
    const second = router.reconcileExecutionStep (plan, 1, expectedPerLeg * 0.6);
    router.applyResize (steps, second);
    const realised = expectedPerLeg * 0.8 + expectedPerLeg * 0.6;
    const truth = 200 * (realised / (expectedPerLeg * 2));
    assert.ok (Math.abs (steps[2]['amount'] - truth) < 1e-9, 'next hop sized to ' + steps[2]['amount'].toString () + ', should be ' + truth.toString ());
});

test ('a single-leg hop reconciles exactly as it did before', async () => {
    //  The combined-scale change must be arithmetically inert when there is nothing to combine,
    //  which is every case the shared fixture covers.
    const steps = [
        { 'stepIndex': 0, 'hopIndex': 0, 'legIndex': 0, 'amount': 1, 'expectedPrice': 100, 'side': 'sell', 'base': 'BTC', 'quote': 'USDT' },
        { 'stepIndex': 1, 'hopIndex': 1, 'legIndex': 0, 'amount': 100, 'expectedPrice': 1, 'side': 'buy', 'base': 'ETH', 'quote': 'USDT' },
    ];
    const plan = { 'steps': steps, 'reconcileToleranceRatio': 1 };
    const reconciliation = router.reconcileExecutionStep (plan, 0, router.stepExpectedOut (steps[0]) * 0.5);
    assert.strictEqual (reconciliation['scale'], 0.5);
    router.applyResize (steps, reconciliation);
    assert.strictEqual (steps[1]['amount'], 50);
});

test ('a route that does not run from the requested asset to the requested asset is refused', async () => {
    //  buildExecutionPlan used to copy from, to, pair and side straight out of the server's JSON,
    //  and the safety checks only tested internal consistency against whatever market that named.
    //  So a compromised — or simply buggy — router response could steer real orders into any real
    //  market and every check would pass it, under the 25 USD cap. The client now checks the
    //  answer against its OWN record of the question.
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['clientRequestedFrom'] = 'USDT';
    route['clientRequestedTo'] = 'ETH';   //  the caller wanted ETH; the route delivers BTC
    assert.throws (() => router.buildExecutionPlan (route, {}), /produces BTC, not the requested ETH/);
});

test ('a route that spends an asset the caller never offered is refused', async () => {
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['clientRequestedFrom'] = 'EUR';
    route['clientRequestedTo'] = 'BTC';
    assert.throws (() => router.buildExecutionPlan (route, {}), /spends USDT, not the requested EUR/);
});

test ('a bridged route whose hops do not connect is refused', async () => {
    //  Internal coherence, checked with or without a client stamp: hop 2 must spend exactly what
    //  hop 1 produced, or the plan strands the proceeds of one order and funds the next from a
    //  wallet nobody checked.
    const route = twoHopRoute ();
    route['hops'][1]['base'] = 'DOGE';
    route['hops'][1]['quote'] = 'EUR';
    assert.throws (() => router.buildExecutionPlan (route, {}), /spends DOGE but the previous hop produced BTC/);
});

test ('a well-formed route still plans normally', async () => {
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['clientRequestedFrom'] = 'USDT';
    route['clientRequestedTo'] = 'BTC';
    const plan = router.buildExecutionPlan (route, {});
    assert.strictEqual (plan['steps'].length, 1);
});

test ('a fee charged in the acquired asset is netted out of what the next hop is sized on', async () => {
    //  filled and cost are GROSS of fees — the manual says so — so a venue taking its cut in the
    //  asset this hop produced credits less than `filled`. Carrying the gross figure forward sizes
    //  the next hop for money that never arrived.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub');
    venue.feeToCharge = { 'cost': 0.001, 'currency': 'BTC' };   //  fee in the ACQUIRED asset
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    const step = report['steps'][0];
    assert.strictEqual (step['filledAmount'], 0.1, 'the fill itself is still reported gross');
    assert.strictEqual (step['grossOutAmount'], 0.1);
    assert.ok (Math.abs (step['outAmount'] - 0.099) < 1e-12, 'carried forward net of the fee');
    assert.strictEqual (step['feeCost'], 0.001);
});

test ('a fee charged in the asset spent does not reduce what is carried forward', async () => {
    //  The counterpart: a USDT fee on a USDT->BTC buy comes out of the money already spent, not
    //  out of the BTC received. Netting it here would under-size the next hop.
    const plan = router.buildExecutionPlan (oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100), {});
    const venue = new StubVenue ('stub');
    venue.feeToCharge = { 'cost': 0.01, 'currency': 'USDT' };
    const report = await router.execute (plan, { 'stub': venue }, { 'strategy': 'sequential', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (report['steps'][0]['outAmount'], 0.1);
    assert.strictEqual (report['steps'][0]['feeCost'], 0);
});

test ('parallel_within_hop never has two orders in flight on one venue', async () => {
    //  The contract is an ORDERING guarantee — concurrent across venues, serialised within a
    //  venue — not a performance promise, which is what lets five very different runtimes honour
    //  the same words. Python previously fanned out one thread per LEG against caller-supplied
    //  sync exchange instances, so two legs on one venue mutated its throttle and nonce state
    //  with no lock; this asserts the property that made that a bug.
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['hops'][0]['legs'] = [
        { 'exchangeId': 'same', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'same', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'other', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
    ];
    const plan = router.buildExecutionPlan (route, {});
    const same = new StubVenue ('same');
    const other = new StubVenue ('other');
    await router.execute (plan, { 'same': same, 'other': other }, { 'strategy': 'parallel_within_hop', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (same.peakInFlight, 1, 'two legs on ONE venue must never overlap');
    const ordersOnSame = same.calls.filter ((c: string) => c.indexOf ('createOrder') === 0).length;
    const ordersOnOther = other.calls.filter ((c: string) => c.indexOf ('createOrder') === 0).length;
    assert.strictEqual (ordersOnSame, 2, 'both legs on that venue still ran, one after the other');
    assert.strictEqual (ordersOnOther, 1);
});

test ('parallel_within_hop still runs different venues at the same time', async () => {
    //  The other half: serialising within a venue must not collapse into serialising everything,
    //  or the strategy is just `sequential` under a different name.
    const route = oneLegRoute ('buy', 'BTC', 'USDT', 0.1, 100);
    route['hops'][0]['legs'] = [
        { 'exchangeId': 'a', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
        { 'exchangeId': 'b', 'amount': 0.1, 'averagePrice': 100, 'effectivePrice': 100 },
    ];
    const plan = router.buildExecutionPlan (route, {});
    const a = new StubVenue ('a');
    const b = new StubVenue ('b');
    //  one shared counter across both venues shows the two overlapped
    let live = 0;
    let peak = 0;
    for (const venue of [ a, b ]) {
        const inner = venue.createOrder.bind (venue);
        venue.createOrder = async (...args: any[]) => {
            live = live + 1;
            if (live > peak) {
                peak = live;
            }
            const out = await (inner as any) (...args);
            live = live - 1;
            return out;
        };
    }
    await router.execute (plan, { 'a': a, 'b': b }, { 'strategy': 'parallel_within_hop', 'live': true, 'usdRates': { 'USDT': 1 } });
    assert.strictEqual (peak, 2, 'different venues must still overlap');
});
