<?php

// NO_AUTO_TRANSPILE
//  ---------------------------------------------------------------------------
//  OrderRouter — offline tests, PHP port.
//
//  Run:  php php/test/base/test_order_router.php
//
//  Two halves, and both matter:
//
//  1. The FIXTURE half drives the four pure methods from
//     ts/src/test/base/fixtures/orderRouter.json — the SAME file the TypeScript,
//     Python, C# and Go suites read. Nothing here restates an expected value by
//     hand, so a PHP implementation that drifts from the reference fails here
//     and nowhere else, which is what makes drift impossible to hide. The
//     comparison algorithm is the one documented in the fixture's `comparison`
//     field: key sets compared BOTH directions, numbers at 1e-9 relative.
//
//  2. The INVARIANT half asserts the safety properties directly, in literal
//     numbers written by hand. The fixture's expectations were produced by the
//     reference implementation, so on their own they would only prove the five
//     languages agree — not that they agree on the right answer.
//
//  Nothing here touches the network and nothing here places an order.
//  ---------------------------------------------------------------------------

namespace ccxt;

namespace ccxt\async;

// Declared here rather than in a fixture file so the suite stays one file, as its four siblings do.
class OrderRouterFakeAsyncVenue {
    public $id = 'stub';
    public function amountToPrecision($symbol, $amount) { return (string) $amount; }
    public function priceToPrecision($symbol, $price) { return (string) $price; }
    public function loadMarkets($reload = false, $params = array()) { return array(); }
    public function createOrder($symbol, $type, $side, $amount, $price = null, $params = array()) {
        throw new \Exception('the guard must fire before any order is dispatched');
    }
}

namespace ccxt;


if (!defined('PATH_TO_CCXT')) {
    define('PATH_TO_CCXT', __DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR);
}

require_once PATH_TO_CCXT . 'ArgumentsRequired.php';
require_once PATH_TO_CCXT . 'BadRequest.php';
require_once PATH_TO_CCXT . 'NotSupported.php';
require_once PATH_TO_CCXT . 'InsufficientFunds.php';
require_once PATH_TO_CCXT . 'AuthenticationError.php';
require_once PATH_TO_CCXT . 'RateLimitExceeded.php';
require_once PATH_TO_CCXT . 'RequestTimeout.php';
require_once PATH_TO_CCXT . 'ExchangeNotAvailable.php';
require_once PATH_TO_CCXT . 'OrderRouter.php';

//  ---------------------------------------------------------------------------
//  a very small harness — no phpunit, so this file runs anywhere php does
//  ---------------------------------------------------------------------------

class OrderRouterTestFailure extends \Exception {
}

function order_router_assert($condition, $message) {
    if (!$condition) {
        throw new OrderRouterTestFailure($message);
    }
}

function order_router_assert_throws($callable, $className, $message) {
    try {
        $callable();
    } catch (\Throwable $e) {
        order_router_assert($e instanceof $className, $message . ': expected ' . $className . ', got ' . get_class($e) . ' (' . $e->getMessage() . ')');
        return;
    }
    order_router_assert(false, $message . ': expected ' . $className . ', nothing was thrown');
}

function order_router_text($value) {
    if (is_bool($value)) {
        return $value ? 'true' : 'false';
    }
    if ($value === null) {
        return 'null';
    }
    if (is_array($value)) {
        return json_encode($value);
    }
    return strval($value);
}

//  ---------------------------------------------------------------------------
//  comparison helpers — the algorithm every port's test must use
//  ---------------------------------------------------------------------------

const ORDER_ROUTER_TEST_TOLERANCE = 1e-9;

function order_router_numbers_match($a, $b) {
    if ($a === $b) {
        return true;
    }
    if (!is_finite($a) || !is_finite($b)) {
        //  an infinity only ever matches itself. Without this the relative
        //  comparison below reads INF <= INF as a match and an infinite value
        //  passes against ANY expectation — which is exactly how a number
        //  grammar that overflows would slip past the numberCases table
        return false;
    }
    $scale = 1;
    if (abs($a) > $scale) {
        $scale = abs($a);
    }
    if (abs($b) > $scale) {
        $scale = abs($b);
    }
    return abs($a - $b) <= ORDER_ROUTER_TEST_TOLERANCE * $scale;
}

function order_router_assert_matches($actual, $expected, $where) {
    //  a JSON array decodes to a PHP list, a JSON object to an associative array
    if (is_array($expected) && array_is_list($expected)) {
        order_router_assert(is_array($actual) && array_is_list($actual), $where . ': expected a list, got ' . order_router_text($actual));
        order_router_assert(count($actual) === count($expected), $where . ': array length, expected ' . count($expected) . ', got ' . count($actual));
        for ($i = 0; $i < count($expected); $i++) {
            order_router_assert_matches($actual[$i], $expected[$i], $where . '[' . $i . ']');
        }
        return;
    }
    if (is_array($expected)) {
        order_router_assert(is_array($actual), $where . ': expected a dictionary, got ' . order_router_text($actual));
        $expectedKeys = array_keys($expected);
        sort($expectedKeys, SORT_STRING);
        $actualKeys = array_keys($actual);
        sort($actualKeys, SORT_STRING);
        //  both directions: a missing field and an invented field are both drift
        order_router_assert($expectedKeys === $actualKeys, $where . ': key set, expected [' . implode(',', $expectedKeys) . '], got [' . implode(',', $actualKeys) . ']');
        for ($i = 0; $i < count($expectedKeys); $i++) {
            $key = $expectedKeys[$i];
            order_router_assert_matches($actual[$key], $expected[$key], $where . '.' . $key);
        }
        return;
    }
    if (is_bool($expected)) {
        order_router_assert($actual === $expected, $where . ': expected ' . order_router_text($expected) . ', got ' . order_router_text($actual));
        return;
    }
    if (is_int($expected) || is_float($expected)) {
        order_router_assert(is_int($actual) || is_float($actual), $where . ': expected a number, got ' . order_router_text($actual));
        order_router_assert(order_router_numbers_match(floatval($actual), floatval($expected)), $where . ': expected ' . order_router_text($expected) . ', got ' . order_router_text($actual));
        return;
    }
    order_router_assert($actual === $expected, $where . ': expected ' . order_router_text($expected) . ', got ' . order_router_text($actual));
}

//  ---------------------------------------------------------------------------
//  fixtures and stubs
//  ---------------------------------------------------------------------------

function order_router_fixture() {
    static $fixture = null;
    if ($fixture === null) {
        $path = __DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'ts' . DIRECTORY_SEPARATOR . 'src' . DIRECTORY_SEPARATOR . 'test' . DIRECTORY_SEPARATOR . 'base' . DIRECTORY_SEPARATOR . 'fixtures' . DIRECTORY_SEPARATOR . 'orderRouter.json';
        $fixture = json_decode(file_get_contents($path), true);
        order_router_assert(is_array($fixture), 'the shared fixture could not be read from ' . $path);
    }
    return $fixture;
}

function order_router_permissive_markets() {
    return array(
        'stub' => array(
            'BTC/USDT' => array(
                'symbol' => 'BTC/USDT',
                'base' => 'BTC',
                'quote' => 'USDT',
                'precision' => array('amount' => 0, 'price' => 0),
                'limits' => array(
                    'amount' => array('min' => 0, 'max' => 0),
                    'price' => array('min' => 0, 'max' => 0),
                    'cost' => array('min' => 0, 'max' => 0),
                ),
            ),
        ),
    );
}

function order_router_one_leg_route($side, $base, $quote, $amount, $price) {
    return array(
        'from' => ($side === 'buy') ? $quote : $base,
        'to' => ($side === 'buy') ? $base : $quote,
        'strategy' => 'best_single',
        'exactSide' => 'in',
        'amountIn' => ($side === 'buy') ? $amount * $price : $amount,
        'amountOut' => ($side === 'buy') ? $amount : $amount * $price,
        'fullyFillable' => true,
        'fillRatio' => 1,
        'unroutableReason' => null,
        'hops' => array(
            array(
                'pair' => $base . '/' . $quote,
                'side' => $side,
                'base' => $base,
                'quote' => $quote,
                'amountIn' => ($side === 'buy') ? $amount * $price : $amount,
                'amountOut' => ($side === 'buy') ? $amount : $amount * $price,
                'legs' => array(array('exchangeId' => 'stub', 'amount' => $amount, 'averagePrice' => $price, 'takerFeeRate' => 0, 'feeCost' => 0, 'effectivePrice' => $price)),
                'fullyFillable' => true,
            ),
        ),
    );
}

function order_router_two_hop_route() {
    return array(
        'from' => 'USDT',
        'to' => 'SOL',
        'strategy' => 'best_single',
        'exactSide' => 'in',
        'amountIn' => 20,
        'amountOut' => 0.2,
        'fullyFillable' => true,
        'fillRatio' => 1,
        'unroutableReason' => null,
        'hops' => array(
            array('pair' => 'BTC/USDT', 'side' => 'buy', 'base' => 'BTC', 'quote' => 'USDT', 'amountIn' => 20, 'amountOut' => 0.2, 'legs' => array(array('exchangeId' => 'stub', 'amount' => 0.2, 'averagePrice' => 100, 'effectivePrice' => 100))),
            array('pair' => 'BTC/USDT', 'side' => 'sell', 'base' => 'BTC', 'quote' => 'USDT', 'amountIn' => 0.2, 'amountOut' => 20, 'legs' => array(array('exchangeId' => 'stub', 'amount' => 0.2, 'averagePrice' => 100, 'effectivePrice' => 100))),
        ),
    );
}

/**
 * renders a double the way JavaScript's Number.prototype.toString does — the
 * shortest text that round-trips — so the stub venue's precision helpers and
 * its call log read the same in both languages
 */
function order_router_number_text($value) {
    return json_encode($value);
}

class OrderRouterStubVenue {

    public $id;
    public $markets;
    public $features;
    public $calls;
    public $fillRatio;
    public $failCreate;
    public $balance;
    //  a queue of orders fetchOrder hands back, one per poll; empty means the
    //  created order comes back closed on the first read
    public $fetchOrderResults;
    public $fetchOrderThrows;
    public $cancelThrows;
    public $createdStatus;

    public function __construct($id, $fillRatio = 1, $failCreate = false) {
        $this->id = $id;
        $this->fillRatio = $fillRatio;
        $this->failCreate = $failCreate;
        $this->calls = array();
        $permissive = order_router_permissive_markets();
        $this->markets = $permissive['stub'];
        $this->features = array('spot' => array('createOrder' => array('timeInForce' => array('GTC', 'IOC'))));
        $this->balance = array(
            'free' => array('USDT' => 1000, 'BTC' => 1, 'ZERO' => 0),
            'total' => array('USDT' => 1000, 'BTC' => 1),
        );
        $this->fetchOrderResults = array();
        $this->fetchOrderThrows = false;
        $this->cancelThrows = false;
        $this->createdStatus = '';
    }

    public function fetchOrder($id, $symbol) {
        $this->calls[] = 'fetchOrder:' . $id;
        if ($this->fetchOrderThrows) {
            throw new ExchangeError('stub cannot read the order back');
        }
        if (count($this->fetchOrderResults) > 0) {
            return array_shift($this->fetchOrderResults);
        }
        return array('id' => $id, 'status' => 'closed', 'filled' => 0, 'average' => 0, 'cost' => 0);
    }

    public function cancelOrder($id, $symbol) {
        $this->calls[] = 'cancelOrder:' . $id;
        if ($this->cancelThrows) {
            throw new ExchangeError('stub refuses to cancel');
        }
        return array('id' => $id, 'status' => 'canceled');
    }

    public function loadMarkets() {
        $this->calls[] = 'loadMarkets';
        return $this->markets;
    }

    public function amountToPrecision($symbol, $amount) {
        return order_router_number_text($amount);
    }

    public function priceToPrecision($symbol, $price) {
        return order_router_number_text($price);
    }

    public function fetchBalance() {
        $this->calls[] = 'fetchBalance';
        return $this->balance;
    }

    public function createOrder($symbol, $type, $side, $amount, $price = null, $params = array()) {
        $this->calls[] = 'createOrder:' . $type . ':' . $side . ':' . order_router_number_text($amount);
        if ($this->failCreate) {
            throw new ExchangeError('stub refuses');
        }
        $filled = $amount * $this->fillRatio;
        $average = ($price === null) ? 100 : $price;
        $status = ($this->createdStatus === '') ? 'closed' : $this->createdStatus;
        return array('id' => 'stub-order', 'status' => $status, 'filled' => $filled, 'average' => $average, 'cost' => $filled * $average);
    }
}

class OrderRouterRecorder extends OrderRouter {

    public $lastUrl;
    public $body;

    public function __construct($config, $body) {
        parent::__construct($config);
        $this->body = $body;
        $this->lastUrl = '';
    }

    public function request($url) {
        $this->lastUrl = $url;
        return $this->body;
    }
}

//  ---------------------------------------------------------------------------
//  1. the shared fixture — the cross-language contract
//  ---------------------------------------------------------------------------

function order_router_test_fixture_build_execution_plan($router) {
    $fixture = order_router_fixture();
    $cases = $fixture['planCases'];
    order_router_assert(count($cases) > 0, 'the fixture has plan cases');
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        $route = $fixture['routes'][$testCase['route']];
        $plan = $router->buildExecutionPlan($route, $testCase['options']);
        order_router_assert_matches($plan, $testCase['expected'], 'planCase ' . $testCase['id']);
    }
}

function order_router_test_fixture_plan_is_deterministic($router) {
    $fixture = order_router_fixture();
    $cases = $fixture['planCases'];
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        $route = $fixture['routes'][$testCase['route']];
        $before = json_encode($route);
        $first = $router->buildExecutionPlan($route, $testCase['options']);
        $second = $router->buildExecutionPlan($route, $testCase['options']);
        order_router_assert_matches($second, $first, 'planCase ' . $testCase['id'] . ' repeated');
        order_router_assert(json_encode($route) === $before, 'planCase ' . $testCase['id'] . ': the route was mutated');
    }
}

function order_router_test_fixture_check_execution_plan_safety($router) {
    $fixture = order_router_fixture();
    $cases = $fixture['safetyCases'];
    order_router_assert(count($cases) > 0, 'the fixture has safety cases');
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        $route = $fixture['routes'][$testCase['route']];
        $markets = $fixture['marketSets'][$testCase['markets']];
        $plan = $router->buildExecutionPlan($route, $testCase['planOptions']);
        $violations = $router->checkExecutionPlanSafety($plan, $markets, $testCase['options']);
        order_router_assert_matches($violations, $testCase['expected'], 'safetyCase ' . $testCase['id']);
    }
}

function order_router_test_fixture_reconcile_execution_step($router) {
    $fixture = order_router_fixture();
    $cases = $fixture['reconcileCases'];
    order_router_assert(count($cases) > 0, 'the fixture has reconcile cases');
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        //  a case names either a route to plan from, or a plan written out in
        //  full — the latter is how a plan with field types no builder produces
        //  (an int hopIndex on one step and a float on the next) gets covered.
        //  PHP is where that distinction bites: === compares type as well.
        if (isset($testCase['plan'])) {
            $plan = $fixture['plans'][$testCase['plan']];
        } else {
            $plan = $router->buildExecutionPlan($fixture['routes'][$testCase['route']], $testCase['planOptions']);
        }
        $verdict = $router->reconcileExecutionStep($plan, $testCase['stepIndex'], $testCase['realisedOut']);
        order_router_assert_matches($verdict, $testCase['expected'], 'reconcileCase ' . $testCase['id']);
    }
}

function order_router_refuses_plan($router, $route, $fragment, $message) {
    try {
        $router->buildExecutionPlan($route, array());
    } catch (\Throwable $e) {
        order_router_assert(strpos($e->getMessage(), $fragment) !== false, $message . ': threw "' . $e->getMessage() . '", expected "' . $fragment . '"');
        return;
    }
    order_router_assert(false, $message . ': nothing was thrown');
}

function order_router_test_route_produces_mismatch($router) {
    //  buildExecutionPlan used to copy from, to, pair and side straight out of the server's JSON,
    //  and the safety checks only tested internal consistency against whatever market that named.
    //  So a compromised — or simply buggy — router response could steer real orders into any real
    //  market and every check would pass it, under the 25 USD cap. The client now checks the
    //  answer against its OWN record of the question.
    $route = order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100);
    $route['clientRequestedFrom'] = 'USDT';
    $route['clientRequestedTo'] = 'ETH';   //  the caller wanted ETH; the route delivers BTC
    order_router_refuses_plan($router, $route, 'produces BTC, not the requested ETH', 'a produces mismatch');
}

function order_router_test_route_spends_mismatch($router) {
    $route = order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100);
    $route['clientRequestedFrom'] = 'EUR';
    $route['clientRequestedTo'] = 'BTC';
    order_router_refuses_plan($router, $route, 'spends USDT, not the requested EUR', 'a spends mismatch');
}

function order_router_test_route_chain_break($router) {
    //  Internal coherence, checked with or without a client stamp: hop 2 must spend exactly what
    //  hop 1 produced, or the plan strands the proceeds of one order and funds the next from a
    //  wallet nobody checked.
    $route = order_router_two_hop_route();
    $route['hops'][1]['base'] = 'DOGE';
    $route['hops'][1]['quote'] = 'EUR';
    order_router_refuses_plan($router, $route, 'spends DOGE but the previous hop produced BTC', 'a broken chain');
}

function order_router_test_route_well_formed_still_plans($router) {
    $route = order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100);
    $route['clientRequestedFrom'] = 'USDT';
    $route['clientRequestedTo'] = 'BTC';
    $plan = $router->buildExecutionPlan($route, array());
    order_router_assert(count($plan['steps']) === 1, 'a coherent route still plans');
}

function order_router_test_fixture_reconcile_sequence($router) {
    //  reconcileExecutionStep is pure and cannot remember across calls, so a hop's cumulative
    //  shortfall lives on the steps themselves — written by applyResize. That interaction is only
    //  visible across a SEQUENCE of calls, which reconcileCases (one call each) cannot express,
    //  and it is exactly where the five ports could silently disagree.
    $fixture = order_router_fixture();
    $cases = $fixture['reconcileSequenceCases'];
    order_router_assert(count($cases) > 0, 'the fixture has reconcile sequence cases');
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        $steps = json_decode(json_encode($testCase['steps']), true);
        $calls = $testCase['calls'];
        for ($c = 0; $c < count($calls); $c++) {
            //  the plan is rebuilt from the working steps on every call, exactly as execute()
            //  does — PHP copies arrays on assignment, so a plan built once outside this loop
            //  would never see what applyResize wrote
            $plan = array('steps' => $steps, 'reconcileToleranceRatio' => $testCase['reconcileToleranceRatio']);
            $reconciliation = $router->reconcileExecutionStep($plan, $calls[$c]['stepIndex'], $calls[$c]['realisedOut']);
            order_router_assert(order_router_numbers_match($reconciliation['scale'], $testCase['expectedScales'][$c]), 'reconcileSequenceCase ' . $testCase['id'] . ' call ' . strval($c) . ': scale ' . strval($reconciliation['scale']));
            $router->applyResize($steps, $reconciliation);
        }
        for ($sIndex = 0; $sIndex < count($steps); $sIndex++) {
            order_router_assert(order_router_numbers_match($steps[$sIndex]['amount'], $testCase['expectedAmounts'][$sIndex]), 'reconcileSequenceCase ' . $testCase['id'] . ' step ' . strval($sIndex) . ': amount ' . strval($steps[$sIndex]['amount']));
        }
    }
}

function order_router_test_fixture_number_at($router) {
    //  Every port hand-implements JavaScript's parseFloat prefix grammar rather
    //  than calling its own parser, because every language's own parser disagrees
    //  with the other four somewhere. These cases are the contract: a cap read as
    //  1234.5 in one language and 1 in another is a cap that silently disappears,
    //  and this table is what stops that shipping green.
    $fixture = order_router_fixture();
    $cases = $fixture['numberCases'];
    order_router_assert(count($cases) > 0, 'the fixture has number cases');
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        $actual = $router->numberAt($testCase['container'], $testCase['key'], $testCase['default']);
        order_router_assert(is_int($actual) || is_float($actual), 'numberCase ' . $testCase['id'] . ': not a number');
        order_router_assert(order_router_numbers_match(floatval($actual), floatval($testCase['expected'])), 'numberCase ' . $testCase['id'] . ': expected ' . order_router_text($testCase['expected']) . ', got ' . order_router_text($actual));
    }
}

function order_router_test_fixture_build_unwind_plan($router) {
    $fixture = order_router_fixture();
    $cases = $fixture['unwindCases'];
    order_router_assert(count($cases) > 0, 'the fixture has unwind cases');
    for ($i = 0; $i < count($cases); $i++) {
        $testCase = $cases[$i];
        $report = $fixture['reports'][$testCase['report']];
        $unwind = $router->buildUnwindPlan($report);
        order_router_assert_matches($unwind, $testCase['expected'], 'unwindCase ' . $testCase['id']);
    }
}

//  ---------------------------------------------------------------------------
//  2. invariants, asserted directly rather than through the fixture
//  ---------------------------------------------------------------------------

function order_router_test_constructor_cap($router) {
    order_router_assert_throws(function () {
        new OrderRouter(array());
    }, ArgumentsRequired::class, 'an apiKey is required');
    order_router_assert_throws(function () {
        new OrderRouter(array('apiKey' => 'k', 'maxNotionalUsd' => 25.01));
    }, BadRequest::class, 'the cap may not be raised');
    order_router_assert_throws(function () {
        new OrderRouter(array('apiKey' => 'k', 'maxNotionalUsd' => 0));
    }, BadRequest::class, 'the cap must be positive');
    $lowered = new OrderRouter(array('apiKey' => 'k', 'maxNotionalUsd' => 5));
    order_router_assert($lowered->maxNotionalUsd === 5, 'the cap may be lowered');
    $standard = new OrderRouter(array('apiKey' => 'k'));
    order_router_assert($standard->maxNotionalUsd === 25, 'the default cap is 25');
    order_router_assert(OrderRouter::MAX_NOTIONAL_USD === 25, 'the hard ceiling is 25');
}

function order_router_test_limit_price_side($router) {
    $buy = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 1, 100), array('slippageBps' => 100));
    order_router_assert($buy['steps'][0]['limitPrice'] === 101.0, 'a buy pays up to 1% more');
    $sell = $router->buildExecutionPlan(order_router_one_leg_route('sell', 'BTC', 'USDT', 1, 100), array('slippageBps' => 100));
    order_router_assert($sell['steps'][0]['limitPrice'] === 99.0, 'a sell accepts down to 1% less');
    $none = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 1, 100), array('slippageBps' => 0));
    order_router_assert(order_router_numbers_match($none['steps'][0]['limitPrice'], 100), 'zero slippage means the expected price');
}

function order_router_test_notional_cap($router) {
    $markets = order_router_permissive_markets();
    //  amount * limitPrice is what is measured, so a 1% slippage on a 24.90 USD
    //  step is what carries it over the line
    $under = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.24, 100), array('slippageBps' => 0));
    order_router_assert(count($router->checkExecutionPlanSafety($under, $markets, array('usdRates' => array('USDT' => 1)))) === 0, '24 USD passes');
    $at = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.25, 100), array('slippageBps' => 0));
    order_router_assert(count($router->checkExecutionPlanSafety($at, $markets, array('usdRates' => array('USDT' => 1)))) === 0, 'exactly 25 USD passes');
    $over = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2501, 100), array('slippageBps' => 0));
    $overViolations = $router->checkExecutionPlanSafety($over, $markets, array('usdRates' => array('USDT' => 1)));
    order_router_assert(count($overViolations) === 1, 'one violation above the cap');
    order_router_assert($overViolations[0]['code'] === 'notional_exceeds_cap', 'the code names the cap');
    order_router_assert($overViolations[0]['blocking'] === true, 'the cap blocks');
    //  and the slippage is inside the measurement, not outside it
    $slipped = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.249, 100), array('slippageBps' => 100));
    $slippedViolations = $router->checkExecutionPlanSafety($slipped, $markets, array('usdRates' => array('USDT' => 1)));
    order_router_assert(count($slippedViolations) === 1, '24.90 USD at 1% slippage is 25.15 USD of risk');
    order_router_assert($slippedViolations[0]['code'] === 'notional_exceeds_cap', 'the slipped step exceeds the cap');
}

function order_router_test_unvaluable_blocks($router) {
    $markets = order_router_permissive_markets();
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.0001, 100), array('slippageBps' => 0));
    //  0.01 USDT of notional: trivially under any cap, and still refused,
    //  because the point is that the cap could not be EVALUATED
    $violations = $router->checkExecutionPlanSafety($plan, $markets, array('usdRates' => array()));
    order_router_assert(count($violations) === 1, 'one violation');
    order_router_assert($violations[0]['code'] === 'notional_unvaluable', 'the step cannot be valued');
    order_router_assert($violations[0]['blocking'] === true, 'an unvaluable step must block, or the cap is decorative');
    //  unrelated rates do not help
    $stillBlocked = $router->checkExecutionPlanSafety($plan, $markets, array('usdRates' => array('ETH' => 3000, 'DOGE' => 0.09)));
    order_router_assert($stillBlocked[0]['code'] === 'notional_unvaluable', 'unrelated rates do not rescue it');
    //  either side of the market resolves it
    order_router_assert(count($router->checkExecutionPlanSafety($plan, $markets, array('usdRates' => array('USDT' => 1)))) === 0, 'the quote rate values it');
    order_router_assert(count($router->checkExecutionPlanSafety($plan, $markets, array('usdRates' => array('BTC' => 100)))) === 0, 'the base rate values it');
}

function order_router_test_usdt_is_not_a_dollar($router) {
    $markets = order_router_permissive_markets();
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100), array('slippageBps' => 0));
    $violations = $router->checkExecutionPlanSafety($plan, $markets, array('usdRates' => array('USD' => 1)));
    order_router_assert(count($violations) === 1, 'USDT is not USD');
    order_router_assert($violations[0]['code'] === 'notional_unvaluable', 'a stablecoin peg is an observation, not a definition');
    //  a depegged rate is respected: 10 USDT at 0.40 is 4 USD
    $depegged = $router->checkExecutionPlanSafety($plan, $markets, array('usdRates' => array('USDT' => 0.4)));
    order_router_assert(count($depegged) === 0, 'a depegged rate is respected');
}

function order_router_test_empty_plan_is_not_safe($router) {
    $fixture = order_router_fixture();
    $plan = $router->buildExecutionPlan($fixture['routes']['unroutable'], array());
    order_router_assert(count($plan['steps']) === 0, 'an unroutable route has no steps');
    $violations = $router->checkExecutionPlanSafety($plan, order_router_permissive_markets(), array('usdRates' => array('USDT' => 1)));
    order_router_assert(count($violations) === 1, 'one violation');
    order_router_assert($violations[0]['code'] === 'empty_plan', 'the plan is empty');
    order_router_assert($violations[0]['blocking'] === true, 'zero violations on zero steps would read as approval');
}

function order_router_test_reconcile_never_scales_up($router) {
    $fixture = order_router_fixture();
    $plan = $router->buildExecutionPlan($fixture['routes']['multiHop'], array());
    $overfilled = $router->reconcileExecutionStep($plan, 0, 1000000);
    //  1 exactly, compared numerically: PHP distinguishes int 1 from float 1.0
    //  and the fixture's comparison rule is numeric, never textual
    order_router_assert(order_router_numbers_match(floatval($overfilled['scale']), 1), 'an overfill must not grow an order the safety check never saw');
    order_router_assert($overfilled['verdict'] === 'proceed', 'an overfill proceeds');
    $downstream = $overfilled['resizedSteps'][0];
    order_router_assert(order_router_numbers_match(floatval($downstream['amount']), floatval($downstream['previousAmount'])), 'the downstream order is untouched');
}

function order_router_test_reconcile_halts($router) {
    $fixture = order_router_fixture();
    $plan = $router->buildExecutionPlan($fixture['routes']['multiHop'], array());
    $nothing = $router->reconcileExecutionStep($plan, 0, 0);
    order_router_assert($nothing['verdict'] === 'halt', 'a total miss halts');
    order_router_assert($nothing['reason'] === 'nothing_filled', 'and says why');
    //  expectedOut of step 0 is 500 * 0.089 = 44.5; 2% of that is 0.89
    order_router_assert($router->reconcileExecutionStep($plan, 0, 44.5 - 0.88)['verdict'] === 'proceed', 'a shortfall inside the tolerance proceeds');
    $over = $router->reconcileExecutionStep($plan, 0, 44.5 - 0.9);
    order_router_assert($over['verdict'] === 'halt', 'a shortfall past the tolerance halts');
    order_router_assert($over['reason'] === 'shortfall_exceeds_tolerance', 'and says why');
    order_router_assert_throws(function () use ($router, $plan) {
        $router->reconcileExecutionStep($plan, 7, 1);
    }, BadRequest::class, 'an out-of-range stepIndex is refused');
}

function order_router_test_unwind_is_never_automatic($router) {
    $fixture = order_router_fixture();
    $unwind = $router->buildUnwindPlan($fixture['reports']['haltedCrossVenue']);
    order_router_assert($unwind['requiresConfirmation'] === true, 'an unwind needs confirmation');
    order_router_assert($unwind['automatic'] === false, 'an unwind is never automatic');
    order_router_assert($unwind['residualCount'] === 2, 'the mexc USDT and the binance SOL are separate positions');
    //  the USDT sold on mexc and the USDT spent on binance are NOT the same
    //  money, because this class never moves funds between venues
    order_router_assert($unwind['steps'][0]['exchangeId'] === 'binance', 'unwound in reverse execution order');
    order_router_assert($unwind['steps'][1]['exchangeId'] === 'mexc', 'unwound in reverse execution order');
    order_router_assert($unwind['steps'][1]['side'] === 'buy', 'leftover quote is spent buying the asset back');
    order_router_assert(order_router_numbers_match($unwind['steps'][1]['amount'], 500), '44.5 USDT at 0.089 is 500 DOGE');
    order_router_assert($unwind['steps'][1]['reachesFrom'] === true, 'buying DOGE back gets you home');
    order_router_assert($unwind['steps'][0]['side'] === 'sell', 'leftover base is sold back');
    order_router_assert($unwind['steps'][0]['reachesFrom'] === false, 'selling SOL for USDT is not yet DOGE');
}

//  ---------------------------------------------------------------------------
//  3. execute — stub venues only, and not one real order anywhere
//  ---------------------------------------------------------------------------

function order_router_test_dry_run_is_the_default($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array());
    $venue = new OrderRouterStubVenue('stub');
    //  everything a real call would carry, EXCEPT live
    $report = $router->execute($plan, array('stub' => $venue), array(
        'strategy' => 'sequential',
        'usdRates' => array('USDT' => 1),
        'allowMarketOrders' => true,
    ));
    order_router_assert($report['dryRun'] === true, 'dry run by default');
    order_router_assert($report['strategy'] === 'dry_run', 'the strategy in force is dry_run');
    order_router_assert($report['requestedStrategy'] === 'sequential', 'the report says what was asked for as well as what happened');
    order_router_assert($report['ordersPlaced'] === 0, 'nothing was placed');
    order_router_assert($report['wouldPlaceOrders'] === 1, 'one order would have been placed');
    order_router_assert($report['steps'][0]['status'] === 'planned', 'the step is still only planned');
    order_router_assert(count($venue->calls) === 0, 'not one call reached the venue — not even a read');
    //  live: false, absent, 'true' and 1 are all not-true
    $notLiveValues = array(false, null, 'true', 1);
    for ($i = 0; $i < count($notLiveValues); $i++) {
        $other = new OrderRouterStubVenue('stub');
        $again = $router->execute($plan, array('stub' => $other), array('strategy' => 'sequential', 'live' => $notLiveValues[$i], 'usdRates' => array('USDT' => 1)));
        order_router_assert($again['dryRun'] === true, 'live must be exactly true');
        order_router_assert(count($other->calls) === 0, 'no call reached the venue');
    }
}

function order_router_test_execute_refuses_unvaluable($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array());
    $venue = new OrderRouterStubVenue('stub');
    order_router_assert_throws(function () use ($router, $plan, $venue) {
        $router->execute($plan, array('stub' => $venue), array('strategy' => 'sequential', 'live' => true));
    }, ExchangeError::class, 'a live run without usdRates is refused');
    for ($i = 0; $i < count($venue->calls); $i++) {
        order_router_assert(strpos($venue->calls[$i], 'createOrder') === false, 'no order was placed');
    }
}

function order_router_test_execute_refuses_above_cap($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 5, 100), array());
    $venue = new OrderRouterStubVenue('stub');
    order_router_assert_throws(function () use ($router, $plan, $venue) {
        $router->execute($plan, array('stub' => $venue), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    }, ExchangeError::class, 'a 500 USD step is refused');
    for ($i = 0; $i < count($venue->calls); $i++) {
        order_router_assert(strpos($venue->calls[$i], 'createOrder') === false, 'no order was placed');
    }
}

function order_router_test_sequential_places_ioc($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array('slippageBps' => 100));
    $venue = new OrderRouterStubVenue('stub');
    $report = $router->execute($plan, array('stub' => $venue), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($report['dryRun'] === false, 'a live run is not a dry run');
    order_router_assert($report['ordersPlaced'] === 1, 'one order placed');
    order_router_assert($report['steps'][0]['status'] === 'filled', 'the step filled');
    order_router_assert($report['steps'][0]['outAsset'] === 'BTC', 'a buy produces the base');
    order_router_assert(order_router_numbers_match($report['steps'][0]['outAmount'], 0.2), 'it produced the whole amount');
    order_router_assert($report['steps'][0]['inAsset'] === 'USDT', 'a buy spends the quote');
    order_router_assert($venue->calls === array('createOrder:limit:buy:0.2'), 'one IOC limit order, in plan order');
    order_router_assert($report['halted'] === false, 'nothing halted');
}

function order_router_test_sequential_obeys_halt($router) {
    $plan = $router->buildExecutionPlan(order_router_two_hop_route(), array());
    //  hop 0 fills half: a 50% shortfall against a 2% tolerance
    $venue = new OrderRouterStubVenue('stub', 0.5);
    $report = $router->execute($plan, array('stub' => $venue), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($report['halted'] === true, 'the route halted');
    order_router_assert($report['haltReason'] === 'shortfall_exceeds_tolerance', 'and says why');
    order_router_assert($report['haltStepIndex'] === 0, 'at the first step');
    order_router_assert($report['ordersPlaced'] === 1, 'the second hop was never attempted');
    order_router_assert($report['steps'][1]['status'] === 'skipped', 'the second step was skipped');
    order_router_assert(count($venue->calls) === 1, 'exactly one venue call');
    //  and the halted report is exactly what buildUnwindPlan is for
    $unwind = $router->buildUnwindPlan($report);
    order_router_assert($unwind['residualCount'] === 1, 'one residual');
    order_router_assert($unwind['steps'][0]['side'] === 'sell', 'the BTC bought on hop 0 goes back to USDT');
    order_router_assert($unwind['steps'][0]['reachesFrom'] === true, 'selling it reaches the from-asset');
}

function order_router_test_market_orders_need_both($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array());
    //  a venue that advertises GTC only
    $noIoc = new OrderRouterStubVenue('stub');
    $noIoc->features = array('spot' => array('createOrder' => array('timeInForce' => array('GTC'))));
    $refused = $router->execute($plan, array('stub' => $noIoc), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($refused['steps'][0]['status'] === 'failed', 'the step failed rather than falling back');
    order_router_assert($refused['steps'][0]['errorCode'] === 'NotSupported', 'and names the refusal');
    order_router_assert(count($noIoc->calls) === 0, 'defaulting to a market order is the decision the caller did not delegate');
    $allowed = new OrderRouterStubVenue('stub');
    $allowed->features = array('spot' => array('createOrder' => array('timeInForce' => array('GTC'))));
    $placed = $router->execute($plan, array('stub' => $allowed), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1), 'allowMarketOrders' => true));
    order_router_assert($placed['steps'][0]['status'] === 'filled', 'with the opt-in the market order goes out');
    order_router_assert($allowed->calls === array('createOrder:market:buy:0.2'), 'and it is a market order');
    //  a venue that says nothing about timeInForce is assumed to do IOC: a
    //  rejected IOC is loud and cheap, an unintended market order is not
    $unknown = new OrderRouterStubVenue('stub');
    $unknown->features = array();
    $assumed = $router->execute($plan, array('stub' => $unknown), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($assumed['steps'][0]['status'] === 'filled', 'an unknown venue is assumed to do IOC');
    order_router_assert($unknown->calls === array('createOrder:limit:buy:0.2'), 'and gets a limit order');
}

function order_router_test_parallel_contains_a_failing_leg($router) {
    $route = order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100);
    $route['hops'][0]['legs'] = array(
        array('exchangeId' => 'good', 'amount' => 0.1, 'averagePrice' => 100, 'effectivePrice' => 100),
        array('exchangeId' => 'bad', 'amount' => 0.1, 'averagePrice' => 100, 'effectivePrice' => 100),
        array('exchangeId' => 'good2', 'amount' => 0.1, 'averagePrice' => 100, 'effectivePrice' => 100),
    );
    $plan = $router->buildExecutionPlan($route, array());
    $good = new OrderRouterStubVenue('good');
    $bad = new OrderRouterStubVenue('bad', 1, true);
    $good2 = new OrderRouterStubVenue('good2');
    $report = $router->execute($plan, array('good' => $good, 'bad' => $bad, 'good2' => $good2), array('strategy' => 'parallel_within_hop', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($report['steps'][0]['status'] === 'filled', 'the first leg filled');
    order_router_assert($report['steps'][1]['status'] === 'failed', 'the second leg failed');
    order_router_assert($report['steps'][2]['status'] === 'filled', 'the sibling behind the failure still ran');
    order_router_assert(count($report['errors']) === 1, 'one error recorded');
    order_router_assert($report['errors'][0]['exchangeId'] === 'bad', 'and it names the venue');
    order_router_assert($report['halted'] === true, 'a failed leg still halts the route after the hop settles');
    order_router_assert($report['haltReason'] === 'order_failed', 'and says why');
}

function order_router_test_best_effort_refuses_multi_hop($router) {
    $multiHop = $router->buildExecutionPlan(order_router_two_hop_route(), array());
    $venue = new OrderRouterStubVenue('stub');
    order_router_assert_throws(function () use ($router, $multiHop, $venue) {
        $router->execute($multiHop, array('stub' => $venue), array('strategy' => 'best_effort', 'live' => true, 'usdRates' => array('USDT' => 1), 'acknowledgeDispersion' => true, 'maxOrders' => 5));
    }, NotSupported::class, 'best_effort refuses multi-hop');
    $singleHop = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array());
    order_router_assert_throws(function () use ($router, $singleHop, $venue) {
        $router->execute($singleHop, array('stub' => $venue), array('strategy' => 'best_effort', 'live' => true, 'usdRates' => array('USDT' => 1), 'maxOrders' => 5));
    }, BadRequest::class, 'best_effort demands acknowledgeDispersion');
    order_router_assert_throws(function () use ($router, $singleHop, $venue) {
        $router->execute($singleHop, array('stub' => $venue), array('strategy' => 'best_effort', 'live' => true, 'usdRates' => array('USDT' => 1), 'acknowledgeDispersion' => true));
    }, BadRequest::class, 'best_effort demands maxOrders');
    order_router_assert(count($venue->calls) === 0, 'nothing reached the venue');
}

function order_router_test_best_effort_stops_at_max_orders($router) {
    $route = order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100);
    $route['hops'][0]['legs'] = array(
        array('exchangeId' => 'a', 'amount' => 0.1, 'averagePrice' => 100, 'effectivePrice' => 100),
        array('exchangeId' => 'b', 'amount' => 0.1, 'averagePrice' => 100, 'effectivePrice' => 100),
        array('exchangeId' => 'c', 'amount' => 0.1, 'averagePrice' => 100, 'effectivePrice' => 100),
    );
    $plan = $router->buildExecutionPlan($route, array());
    $venues = array('a' => new OrderRouterStubVenue('a'), 'b' => new OrderRouterStubVenue('b', 0.01), 'c' => new OrderRouterStubVenue('c'));
    $report = $router->execute($plan, $venues, array('strategy' => 'best_effort', 'live' => true, 'usdRates' => array('USDT' => 1), 'acknowledgeDispersion' => true, 'maxOrders' => 2));
    order_router_assert($report['ordersPlaced'] === 2, 'two orders placed');
    order_router_assert($report['steps'][2]['status'] === 'skipped', 'the third was skipped');
    order_router_assert($report['steps'][2]['errorCode'] === 'max_orders_reached', 'and says why');
    order_router_assert($report['halted'] === false, 'a 1% fill on leg b does not stop best_effort — that is the whole strategy');
    order_router_assert(count($venues['c']->calls) === 0, 'the third venue was never called');
}

function order_router_test_unknown_strategy_is_refused($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array());
    order_router_assert_throws(function () use ($router, $plan) {
        $router->execute($plan, array(), array('strategy' => 'yolo'));
    }, BadRequest::class, 'an unknown strategy is refused even in dry run');
}

function order_router_test_atomic_ish_demands_prefunding($router) {
    $plan = $router->buildExecutionPlan(order_router_two_hop_route(), array());
    //  hop 0 needs 20 USDT and hop 1 needs 0.2 BTC, both already sitting there
    $rich = new OrderRouterStubVenue('stub');
    $report = $router->execute($plan, array('stub' => $rich), array('strategy' => 'atomic_ish', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($report['ordersPlaced'] === 2, 'a pre-funded route runs end to end');
    $broke = new OrderRouterStubVenue('stub');
    $broke->balance = array('free' => array('USDT' => 1, 'BTC' => 0));
    order_router_assert_throws(function () use ($router, $plan, $broke) {
        $router->execute($plan, array('stub' => $broke), array('strategy' => 'atomic_ish', 'live' => true, 'usdRates' => array('USDT' => 1)));
    }, ExchangeError::class, 'an underfunded route is refused');
}

//  ---------------------------------------------------------------------------
//  4. fetchRoute request shaping and fetchRouteWithBalances, with the HTTP
//     layer stubbed out — no network
//  ---------------------------------------------------------------------------

function order_router_test_fetch_route_refuses_ambiguous_amounts($router) {
    $recorder = new OrderRouterRecorder(array('apiKey' => 'k'), array());
    order_router_assert_throws(function () use ($recorder) {
        $recorder->fetchRoute('USDT', 'BTC', array());
    }, BadRequest::class, 'neither amount is refused');
    order_router_assert_throws(function () use ($recorder) {
        $recorder->fetchRoute('USDT', 'BTC', array('amountIn' => 1, 'amountOut' => 1));
    }, BadRequest::class, 'both amounts are refused');
    order_router_assert($recorder->lastUrl === '', 'neither reached the wire');
}

function order_router_test_fetch_route_query($router) {
    $recorder = new OrderRouterRecorder(array('apiKey' => 'k', 'baseUrl' => 'https://example.test/api/'), array('hops' => array()));
    $recorder->fetchRoute('usdt', 'btc', array('amountIn' => 0.001, 'strategy' => 'split_capped', 'maxVenues' => 3, 'exchanges' => array('binance', 'kraken'), 'certified' => true));
    order_router_assert($recorder->lastUrl === 'https://example.test/api/route?from=USDT&to=BTC&amountIn=0.001&strategy=split_capped&maxVenues=3&exchanges=binance%2Ckraken&certified=true', 'the query is deterministic, got ' . $recorder->lastUrl);
}

function order_router_test_fetch_route_with_balances($router) {
    $recorder = new OrderRouterRecorder(array('apiKey' => 'k'), array('hops' => array(), 'balancesApplied' => 'stub.BTC:1,stub.USDT:1000'));
    $route = $recorder->fetchRouteWithBalances('USDT', 'BTC', array('stub' => new OrderRouterStubVenue('stub')), array('amountIn' => 10));
    order_router_assert($route['balancesUsed'] === 'stub.USDT:1000,stub.BTC:1', 'largest first, and the ZERO holding is gone, got ' . $route['balancesUsed']);
    order_router_assert(count($route['balancesDropped']) === 0, 'nothing was dropped');
    order_router_assert(strpos($recorder->lastUrl, 'balances=stub.USDT%3A1000%2Cstub.BTC%3A1') !== false, 'the balances reached the query');
}

function order_router_test_fetch_route_with_balances_requires_echo($router) {
    $silent = new OrderRouterRecorder(array('apiKey' => 'k'), array('hops' => array()));
    order_router_assert_throws(function () use ($silent) {
        $silent->fetchRouteWithBalances('USDT', 'BTC', array('stub' => new OrderRouterStubVenue('stub')), array('amountIn' => 10));
    }, ExchangeError::class, 'a route computed against ignored balances is refused');
    //  and the caller can opt out with their eyes open
    $opted = new OrderRouterRecorder(array('apiKey' => 'k'), array('hops' => array()));
    $route = $opted->fetchRouteWithBalances('USDT', 'BTC', array('stub' => new OrderRouterStubVenue('stub')), array('amountIn' => 10, 'requireBalancesApplied' => false));
    order_router_assert($route['balancesUsed'] === 'stub.USDT:1000,stub.BTC:1', 'the opt-out still reports what it sent');
}

function order_router_test_fetch_route_with_balances_entry_cap($router) {
    $recorder = new OrderRouterRecorder(array('apiKey' => 'k'), array('hops' => array(), 'balancesApplied' => 'x'));
    $many = new OrderRouterStubVenue('stub');
    $free = array();
    for ($i = 0; $i < 70; $i++) {
        $free['C' . $i] = $i + 1;
    }
    $many->balance = array('free' => $free);
    $route = $recorder->fetchRouteWithBalances('USDT', 'BTC', array('stub' => $many), array('amountIn' => 10));
    order_router_assert(count($route['balancesDropped']) === 6, 'six entries were dropped');
    order_router_assert(count(explode(',', $route['balancesUsed'])) === 64, 'sixty-four survived');
    for ($i = 0; $i < count($route['balancesDropped']); $i++) {
        order_router_assert($route['balancesDropped'][$i]['reason'] === 'entry_cap', 'dropped for the entry cap');
        order_router_assert($route['balancesDropped'][$i]['amount'] <= 6, 'the six smallest holdings are the ones that went');
    }
}

function order_router_test_format_number($router) {
    order_router_assert($router->formatNumber(0.0000001) === '0.0000001', 'no exponent for a small number');
    order_router_assert_throws(function () use ($router) {
        $router->formatNumber(1e21);
    }, BadRequest::class, 'refused rather than rendered as 1e+21 in one language and not the others');
    order_router_assert($router->formatNumber(0) === '0', 'zero');
    order_router_assert($router->formatNumber(1000000) === '1000000', 'a round million');
    order_router_assert($router->formatNumber(0.5) === '0.5', 'a half');
    order_router_assert($router->formatNumber(1e-15) === '0', 'below the twelfth decimal is zero');
}

//  ---------------------------------------------------------------------------
//  the runner
//  ---------------------------------------------------------------------------

function order_router_test_cap_survives_tampering($router) {
    //  the constructor refuses to be built above 25, but $maxNotionalUsd is a
    //  public property. A ceiling that one assignment removes is not a ceiling,
    //  so both clamp sites re-impose the constant.
    $tampered = new OrderRouter(array('apiKey' => 'k'));
    $tampered->maxNotionalUsd = 1000;
    //  0.005 BTC at 100000 USDT is 500 USD
    $plan = $tampered->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.005, 100000), array('slippageBps' => 0));
    $violations = $tampered->checkExecutionPlanSafety($plan, order_router_permissive_markets(), array('usdRates' => array('USDT' => 1), 'maxNotionalUsd' => 1000));
    order_router_assert(count($violations) === 1, 'a 500 USD step must still be refused');
    order_router_assert($violations[0]['code'] === 'notional_exceeds_cap', 'and refused for the right reason');
    order_router_assert(order_router_numbers_match(floatval($violations[0]['limit']), 25), 'the limit reported is the constant, not the tampered property');
    order_router_assert_throws(function () use ($tampered, $plan) {
        $tampered->assertUnderCap($plan['steps'][0], 0.005, 100000, array('USDT' => 1), array('maxNotionalUsd' => 1000));
    }, ExchangeError::class, 'the last check before an order goes out refuses too');
}

function order_router_test_best_effort_derives_hop_count($router) {
    //  a plan that travelled through JSON, was rebuilt from persisted steps, or
    //  is the tail of a halted route can be missing hopCount entirely
    $complete = $router->buildExecutionPlan(order_router_two_hop_route(), array());
    $withoutHopCount = array();
    foreach ($complete as $key => $value) {
        if ($key !== 'hopCount') {
            $withoutHopCount[$key] = $value;
        }
    }
    order_router_assert(!isset($withoutHopCount['hopCount']), 'the plan really has no hopCount');
    order_router_assert(count($withoutHopCount['steps']) === 2, 'and it really has two hops worth of steps');
    $venue = new OrderRouterStubVenue('stub', 0.1);
    order_router_assert_throws(function () use ($router, $withoutHopCount, $venue) {
        $router->execute($withoutHopCount, array('stub' => $venue), array('strategy' => 'best_effort', 'live' => true, 'usdRates' => array('USDT' => 1), 'acknowledgeDispersion' => true, 'maxOrders' => 5));
    }, NotSupported::class, 'best_effort across a bridge is refused however the plan reached us');
    order_router_assert(count($venue->calls) === 0, 'not one order was placed');
}

function order_router_test_venue_supports_ioc_dictionary($router) {
    $noIoc = new OrderRouterStubVenue('stub');
    //  the shape ccxt actually uses: features.spot.createOrder.timeInForce is a
    //  dictionary, never a list. bit2c, bitbank, bithumb and coinone all say
    //  IOC => false, and reading this as a list answered "yes" for every one.
    $noIoc->features = array('spot' => array('createOrder' => array('timeInForce' => array('IOC' => false, 'FOK' => false, 'PO' => false, 'GTD' => false, 'GTC' => true))));
    order_router_assert($router->venueSupportsIoc($noIoc) === false, 'IOC => false means no');
    $withIoc = new OrderRouterStubVenue('stub');
    $withIoc->features = array('spot' => array('createOrder' => array('timeInForce' => array('IOC' => true, 'FOK' => true, 'PO' => true, 'GTD' => false, 'GTC' => true))));
    order_router_assert($router->venueSupportsIoc($withIoc) === true, 'IOC => true means yes');
    //  a dictionary that enumerates its values and omits IOC has said no
    $silentAboutIoc = new OrderRouterStubVenue('stub');
    $silentAboutIoc->features = array('spot' => array('createOrder' => array('timeInForce' => array('GTC' => true))));
    order_router_assert($router->venueSupportsIoc($silentAboutIoc) === false, 'a list of values without IOC means no');
    //  and a venue that says nothing at all is still assumed to do IOC
    $silent = new OrderRouterStubVenue('stub');
    $silent->features = array();
    order_router_assert($router->venueSupportsIoc($silent) === true, 'silence is still assumed to be yes');
    //  end to end: the documented market-order fallback is reachable again
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.2, 100), array());
    $refused = $router->execute($plan, array('stub' => $noIoc), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($refused['steps'][0]['errorCode'] === 'NotSupported', 'the step refuses rather than sending an IOC');
    order_router_assert(count($noIoc->calls) === 0, 'an IOC was never sent to a venue that cannot do one');
    $allowed = new OrderRouterStubVenue('stub');
    $allowed->features = $noIoc->features;
    $placed = $router->execute($plan, array('stub' => $allowed), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1), 'allowMarketOrders' => true));
    order_router_assert($placed['steps'][0]['status'] === 'filled', 'the opt-in reaches the market order');
    order_router_assert($allowed->calls === array('createOrder:market:buy:0.2'), 'and it is a market order');
}

function order_router_test_limit_protected_keeps_a_venue_side_cancel_fill($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.0002, 100000), array('slippageBps' => 0));
    $venue = new OrderRouterStubVenue('stub');
    $venue->createdStatus = 'open';
    //  the venue ends the order itself between the last two polls — an expiry, a
    //  self-trade prevention, a post-only rejection of the remainder — and it
    //  carries a real partial fill
    $venue->fetchOrderResults = array(
        array('id' => 'stub-order', 'status' => 'open', 'filled' => 0, 'average' => 0, 'cost' => 0),
        array('id' => 'stub-order', 'status' => 'canceled', 'filled' => 0.0001, 'average' => 100000, 'cost' => 10),
    );
    $venue->cancelThrows = true;
    $report = $router->execute($plan, array('stub' => $venue), array('strategy' => 'limit_protected', 'live' => true, 'usdRates' => array('USDT' => 1), 'orderTimeoutMs' => 2, 'pollIntervalMs' => 1));
    order_router_assert(!in_array('cancelOrder:stub-order', $venue->calls, true), 'an order the venue already closed is not cancelled again');
    order_router_assert($report['steps'][0]['status'] === 'partial', 'the fill is kept');
    order_router_assert(order_router_numbers_match(floatval($report['steps'][0]['filledAmount']), 0.0001), 'and it is the right size');
    order_router_assert(order_router_numbers_match(floatval($report['steps'][0]['outAmount']), 0.0001), 'and it reaches outAmount');
    order_router_assert($report['steps'][0]['orderId'] === 'stub-order', 'and the id is reported');
    order_router_assert(count($report['openOrders']) === 0, 'nothing is open: the venue closed it');
    //  and the 0.0001 BTC that was actually bought reaches the unwind plan
    $unwind = $router->buildUnwindPlan($report);
    order_router_assert($unwind['residualCount'] === 1, 'a real position must never be invisible to the unwind path');
    order_router_assert(order_router_numbers_match(floatval($unwind['steps'][0]['amount']), 0.0001), 'the unwind sells exactly what was bought');
}

function order_router_test_order_id_survives_a_failure_after_create($router) {
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.0002, 100000), array('slippageBps' => 0));
    $venue = new OrderRouterStubVenue('stub');
    $venue->createdStatus = 'open';
    //  createOrder succeeded; the first poll never comes back
    $venue->fetchOrderThrows = true;
    $report = $router->execute($plan, array('stub' => $venue), array('strategy' => 'limit_protected', 'live' => true, 'usdRates' => array('USDT' => 1), 'orderTimeoutMs' => 4, 'pollIntervalMs' => 1));
    order_router_assert($report['steps'][0]['status'] === 'failed', 'the step failed');
    order_router_assert($report['steps'][0]['orderId'] === 'stub-order', 'the id is captured the instant createOrder returns, not after the read');
    order_router_assert(count($report['openOrders']) === 1, 'a live order the caller cannot see is the worst outcome there is');
    order_router_assert($report['openOrders'][0]['orderId'] === 'stub-order', 'and it names the order');
    order_router_assert($report['openOrders'][0]['exchangeId'] === 'stub', 'and the venue it is on');
    order_router_assert($report['openOrders'][0]['reason'] === 'outcome_unknown', 'and why it may still be live');
    //  the same holds for an immediate order, which has no poll loop at all
    $other = new OrderRouterStubVenue('stub');
    $other->createdStatus = 'open';
    $okReport = $router->execute($plan, array('stub' => $other), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    order_router_assert($okReport['steps'][0]['orderId'] === 'stub-order', 'an immediate order reports its id too');
    //  and an "immediate" order the venue reports as STILL OPEN is a resting
    //  order, which is what a venue that silently drops timeInForce leaves you
    order_router_assert(count($okReport['openOrders']) === 1, 'a still-open immediate order is reported');
    order_router_assert($okReport['openOrders'][0]['orderId'] === 'stub-order', 'and it names the order');
    order_router_assert($okReport['openOrders'][0]['reason'] === 'still_open', 'and says it is still open');
}


// A venue whose class sits in the async namespace, which is the discriminator the guard uses.
// ccxt\async\Exchange extends BaseExchange rather than ccxt\Exchange, so it is a SIBLING of the
// sync class and no positive instanceof against it is possible.
function order_router_test_refuses_async_venues($router) {
    $venue = new \ccxt\async\OrderRouterFakeAsyncVenue();
    $plan = $router->buildExecutionPlan(order_router_one_leg_route('buy', 'BTC', 'USDT', 0.1, 100), array());
    $threw = false;
    try {
        $router->execute($plan, array('stub' => $venue), array('strategy' => 'sequential', 'live' => true, 'usdRates' => array('USDT' => 1)));
    } catch (\ccxt\NotSupported $e) {
        $threw = true;
    }
    if (!$threw) {
        // Handed an async instance this used to return a clean report with every step unfilled and
        // NO errors, while the fiber had already dispatched the real orders.
        throw new \Exception('an async venue must be refused, not silently mis-read');
    }
}

function test_order_router() {
    $router = new OrderRouter(array('apiKey' => 'test-key'));
    $tests = array(
        'fixture: buildExecutionPlan' => 'ccxt\order_router_test_fixture_build_execution_plan',
        'fixture: buildExecutionPlan is deterministic and does not mutate its input' => 'ccxt\order_router_test_fixture_plan_is_deterministic',
        'fixture: checkExecutionPlanSafety' => 'ccxt\order_router_test_fixture_check_execution_plan_safety',
        'fixture: reconcileExecutionStep' => 'ccxt\order_router_test_fixture_reconcile_execution_step',
        'fixture: a sequence of reconciliations on one hop' => 'ccxt\order_router_test_fixture_reconcile_sequence',
        'a route that does not run from the requested asset to the requested asset is refused' => 'ccxt\order_router_test_route_produces_mismatch',
        'a route that spends an asset the caller never offered is refused' => 'ccxt\order_router_test_route_spends_mismatch',
        'a bridged route whose hops do not connect is refused' => 'ccxt\order_router_test_route_chain_break',
        'a well-formed route still plans normally' => 'ccxt\order_router_test_route_well_formed_still_plans',
        'fixture: buildUnwindPlan' => 'ccxt\order_router_test_fixture_build_unwind_plan',
        'fixture: numberAt reads one number grammar in all five languages' => 'ccxt\order_router_test_fixture_number_at',
        'constructor: apiKey is required and the 25 USD cap may be lowered but never raised' => 'ccxt\order_router_test_constructor_cap',
        'the limit price sits on the side that costs you, and only there' => 'ccxt\order_router_test_limit_price_side',
        'the notional cap blocks at 25 USD and passes below it' => 'ccxt\order_router_test_notional_cap',
        'a step that cannot be valued in USD BLOCKS — it is never skipped' => 'ccxt\order_router_test_unvaluable_blocks',
        'USDT is not assumed to be one dollar; USD is' => 'ccxt\order_router_test_usdt_is_not_a_dollar',
        'an empty plan is not a safe plan' => 'ccxt\order_router_test_empty_plan_is_not_safe',
        'reconcileExecutionStep never scales a downstream order UP' => 'ccxt\order_router_test_reconcile_never_scales_up',
        'reconcileExecutionStep halts on a total miss and on an over-tolerance shortfall' => 'ccxt\order_router_test_reconcile_halts',
        'buildUnwindPlan is never automatic and never nets across venues' => 'ccxt\order_router_test_unwind_is_never_automatic',
        'dry_run is the default: a live-looking call with live unset places nothing' => 'ccxt\order_router_test_dry_run_is_the_default',
        'execute refuses to go live without a way to value the trade in USD' => 'ccxt\order_router_test_execute_refuses_unvaluable',
        'execute refuses to go live above the cap' => 'ccxt\order_router_test_execute_refuses_above_cap',
        'sequential places IOC limit orders in plan order' => 'ccxt\order_router_test_sequential_places_ioc',
        'sequential obeys the halt verdict and never starts the next hop' => 'ccxt\order_router_test_sequential_obeys_halt',
        'a market order needs BOTH a venue that cannot do IOC and an explicit opt-in' => 'ccxt\order_router_test_market_orders_need_both',
        'parallel_within_hop contains a failing leg instead of abandoning its siblings' => 'ccxt\order_router_test_parallel_contains_a_failing_leg',
        'best_effort refuses multi-hop and demands both of its acknowledgements' => 'ccxt\order_router_test_best_effort_refuses_multi_hop',
        'best_effort stops at maxOrders and never halts' => 'ccxt\order_router_test_best_effort_stops_at_max_orders',
        'the hard 25 USD cap survives a writable maxNotionalUsd' => 'ccxt\order_router_test_cap_survives_tampering',
        'best_effort derives the hop count from the steps, not from a key the plan may not carry' => 'ccxt\order_router_test_best_effort_derives_hop_count',
        'venueSupportsIoc reads the dictionary of booleans every real exchange declares' => 'ccxt\order_router_test_venue_supports_ioc_dictionary',
        'limit_protected keeps the fill from an order the venue canceled on the last poll' => 'ccxt\order_router_test_limit_protected_keeps_a_venue_side_cancel_fill',
        'a failure after createOrder still reports the order id and an open order' => 'ccxt\order_router_test_order_id_survives_a_failure_after_create',
        'an unknown strategy is refused even in dry run' => 'ccxt\order_router_test_unknown_strategy_is_refused',
        'atomic_ish demands the whole route pre-funded' => 'ccxt\order_router_test_atomic_ish_demands_prefunding',
        'fetchRoute refuses neither-or-both amounts before touching the network' => 'ccxt\order_router_test_fetch_route_refuses_ambiguous_amounts',
        'fetchRoute builds a deterministic query' => 'ccxt\order_router_test_fetch_route_query',
        'fetchRouteWithBalances skips zeros, sorts largest first and reports what it dropped' => 'ccxt\order_router_test_fetch_route_with_balances',
        'fetchRouteWithBalances refuses a route computed against balances the router ignored' => 'ccxt\order_router_test_fetch_route_with_balances_requires_echo',
        'fetchRouteWithBalances trims to the router 64-entry cap, dropping the smallest' => 'ccxt\order_router_test_fetch_route_with_balances_entry_cap',
        'formatNumber never emits exponent notation' => 'ccxt\order_router_test_format_number',
        'an async venue is refused instead of silently mis-read' => 'ccxt\order_router_test_refuses_async_venues',
    );
    $passed = 0;
    $failures = array();
    foreach ($tests as $name => $callable) {
        try {
            $callable($router);
            $passed = $passed + 1;
            echo 'ok   ' . $name . "\n";
        } catch (\Throwable $e) {
            $failures[] = $name . ' — ' . $e->getMessage();
            echo 'FAIL ' . $name . ' — ' . $e->getMessage() . "\n";
        }
    }
    echo "\n" . $passed . ' passed, ' . count($failures) . ' failed, ' . count($tests) . " total\n";
    if (count($failures) > 0) {
        throw new OrderRouterTestFailure(implode("\n", $failures));
    }
    //  the last invariant, and the cheapest one to check: this class must never
    //  contain a call to a funds-transfer endpoint
    $source = file_get_contents(PATH_TO_CCXT . 'OrderRouter.php');
    if (strpos($source, 'withdraw') !== false) {
        throw new OrderRouterTestFailure('OrderRouter.php mentions withdraw');
    }
    echo "withdraw appears nowhere in php/OrderRouter.php\n";
}

if (isset($_SERVER['SCRIPT_FILENAME']) && (realpath($_SERVER['SCRIPT_FILENAME']) === realpath(__FILE__))) {
    try {
        test_order_router();
    } catch (\Throwable $e) {
        exit(1);
    }
    exit(0);
}
