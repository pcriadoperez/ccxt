package ccxt

//  ---------------------------------------------------------------------------
//  OrderRouter — offline tests.
//
//  Run:  go -C go/v4 test -run OrderRouter
//
//  Two halves, and both matter:
//
//  1. The FIXTURE half drives the four pure methods from
//     ts/src/test/base/fixtures/orderRouter.json — the SAME file the TypeScript,
//     Python, PHP and C# suites read. Nothing here restates an expected value by
//     hand, so a port that drifts fails in its own language and nowhere else,
//     which is what makes drift impossible to hide. The comparison follows the
//     algorithm the fixture documents in its `comparison` field: key sets are
//     compared in BOTH directions, numbers at a relative tolerance of 1e-9 and
//     never as text.
//
//  2. The INVARIANT half asserts the safety properties directly. The fixture's
//     expectations were produced by the reference implementation, so on their own
//     they would only prove the five languages agree — not that they agree on the
//     right answer.
//
//  Nothing here touches the network and nothing here places a real order.
//  ---------------------------------------------------------------------------

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

//  ---------------------------------------------------------------------------
//  comparison helpers — the algorithm every port's test must use
//  ---------------------------------------------------------------------------

const orderRouterTestTolerance = 1e-9

func routerNumbersMatch(a float64, b float64) bool {
	if a == b {
		return true
	}
	if math.IsInf(a, 0) || math.IsInf(b, 0) || math.IsNaN(a) || math.IsNaN(b) {
		// an infinity only ever matches itself. Without this the relative
		// comparison below reads +Inf <= +Inf as a match and an infinite value
		// passes against ANY expectation — which is exactly how a number grammar
		// that overflows would slip past the numberCases table
		return false
	}
	scale := 1.0
	if math.Abs(a) > scale {
		scale = math.Abs(a)
	}
	if math.Abs(b) > scale {
		scale = math.Abs(b)
	}
	return math.Abs(a-b) <= orderRouterTestTolerance*scale
}

// routerNormalise widens the several concrete shapes this package produces into
// the shape encoding/json decodes the fixture into, so the two trees compare
// node for node.
func routerNormalise(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		normalised := make(map[string]any, len(typed))
		for key, nested := range typed {
			normalised[key] = routerNormalise(nested)
		}
		return normalised
	case []map[string]any:
		normalised := make([]any, len(typed))
		for i := 0; i < len(typed); i++ {
			normalised[i] = routerNormalise(typed[i])
		}
		return normalised
	case []any:
		normalised := make([]any, len(typed))
		for i := 0; i < len(typed); i++ {
			normalised[i] = routerNormalise(typed[i])
		}
		return normalised
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case float32:
		return float64(typed)
	}
	return value
}

func routerSortedKeys(dict map[string]any) []string {
	keys := make([]string, 0, len(dict))
	for key := range dict {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func routerAssertMatches(t *testing.T, actual any, expected any, where string) {
	t.Helper()
	switch typed := expected.(type) {
	case []any:
		list, ok := actual.([]any)
		if !ok {
			t.Fatalf("%s: expected an array, got %T", where, actual)
		}
		if len(list) != len(typed) {
			t.Fatalf("%s: array length %d, expected %d", where, len(list), len(typed))
		}
		for i := 0; i < len(typed); i++ {
			routerAssertMatches(t, list[i], typed[i], fmt.Sprintf("%s[%d]", where, i))
		}
	case map[string]any:
		dict, ok := actual.(map[string]any)
		if !ok {
			t.Fatalf("%s: expected an object, got %T", where, actual)
		}
		// both directions: a missing field and an invented field are both drift
		expectedKeys := routerSortedKeys(typed)
		actualKeys := routerSortedKeys(dict)
		if strings.Join(actualKeys, ",") != strings.Join(expectedKeys, ",") {
			t.Fatalf("%s: key set %v, expected %v", where, actualKeys, expectedKeys)
		}
		for i := 0; i < len(expectedKeys); i++ {
			key := expectedKeys[i]
			routerAssertMatches(t, dict[key], typed[key], where+"."+key)
		}
	case float64:
		number, ok := actual.(float64)
		if !ok {
			t.Fatalf("%s: expected the number %v, got %T %v", where, typed, actual, actual)
		}
		if !routerNumbersMatch(number, typed) {
			t.Fatalf("%s: expected %v, got %v", where, typed, number)
		}
	default:
		if actual != expected {
			t.Fatalf("%s: expected %v, got %v", where, expected, actual)
		}
	}
}

//  ---------------------------------------------------------------------------
//  the shared fixture
//  ---------------------------------------------------------------------------

func routerFixture(t *testing.T) map[string]any {
	t.Helper()
	path := filepath.Join("..", "..", "ts", "src", "test", "base", "fixtures", "orderRouter.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the shared fixture is unreadable at %s: %v", path, err)
	}
	var fixture map[string]any
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("the shared fixture is not valid JSON: %v", err)
	}
	return fixture
}

func routerFixtureCases(t *testing.T, fixture map[string]any, section string) []map[string]any {
	t.Helper()
	raw := routerListAt(fixture, section)
	if len(raw) == 0 {
		t.Fatalf("the fixture has no %s", section)
	}
	cases := make([]map[string]any, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		cases = append(cases, raw[i].(map[string]any))
	}
	return cases
}

func routerTestRouter(t *testing.T) *OrderRouter {
	t.Helper()
	router, err := NewOrderRouter(map[string]any{"apiKey": "test-key"})
	if err != nil {
		t.Fatalf("NewOrderRouter: %v", err)
	}
	return router
}

func TestOrderRouterFixtureBuildExecutionPlan(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "planCases") {
		route := routerDictAt(routerDictAt(fixture, "routes"), routerStringAt(testCase, "route", ""))
		plan := routerMustPlan(router.BuildExecutionPlan(route, routerDictAt(testCase, "options")))
		routerAssertMatches(t, routerNormalise(plan), routerNormalise(testCase["expected"]), "planCase "+routerStringAt(testCase, "id", ""))
	}
}

func TestOrderRouterFixtureBuildExecutionPlanIsDeterministic(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "planCases") {
		route := routerDictAt(routerDictAt(fixture, "routes"), routerStringAt(testCase, "route", ""))
		options := routerDictAt(testCase, "options")
		before, _ := json.Marshal(route)
		first := routerMustPlan(router.BuildExecutionPlan(route, options))
		second := routerMustPlan(router.BuildExecutionPlan(route, options))
		routerAssertMatches(t, routerNormalise(second), routerNormalise(first), "planCase "+routerStringAt(testCase, "id", "")+" repeated")
		after, _ := json.Marshal(route)
		if string(before) != string(after) {
			t.Fatalf("planCase %s: the route was mutated", routerStringAt(testCase, "id", ""))
		}
	}
}

func TestOrderRouterFixtureCheckExecutionPlanSafety(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "safetyCases") {
		route := routerDictAt(routerDictAt(fixture, "routes"), routerStringAt(testCase, "route", ""))
		markets := routerDictAt(routerDictAt(fixture, "marketSets"), routerStringAt(testCase, "markets", ""))
		plan := routerMustPlan(router.BuildExecutionPlan(route, routerDictAt(testCase, "planOptions")))
		violations := router.CheckExecutionPlanSafety(plan, markets, routerDictAt(testCase, "options"))
		routerAssertMatches(t, routerNormalise(violations), routerNormalise(testCase["expected"]), "safetyCase "+routerStringAt(testCase, "id", ""))
	}
}

func TestOrderRouterFixtureReconcileExecutionStep(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "reconcileCases") {
		// a case names either a route to plan from, or a plan written out in full
		// — the latter is how a plan with field types no builder produces (an int
		// hopIndex on one step and a float on the next) gets covered
		var plan map[string]any
		if named := routerStringAt(testCase, "plan", ""); named != "" {
			plan = routerDictAt(routerDictAt(fixture, "plans"), named)
		} else {
			route := routerDictAt(routerDictAt(fixture, "routes"), routerStringAt(testCase, "route", ""))
			plan = routerMustPlan(router.BuildExecutionPlan(route, routerDictAt(testCase, "planOptions")))
		}
		stepIndex := int(routerNumberAt(testCase, "stepIndex", 0))
		verdict, err := router.ReconcileExecutionStep(plan, stepIndex, routerNumberAt(testCase, "realisedOut", 0))
		if err != nil {
			t.Fatalf("reconcileCase %s: %v", routerStringAt(testCase, "id", ""), err)
		}
		routerAssertMatches(t, routerNormalise(verdict), routerNormalise(testCase["expected"]), "reconcileCase "+routerStringAt(testCase, "id", ""))
	}
}

// TestOrderRouterFixtureNumberAt asserts the ONE number grammar. Every port
// hand-implements JavaScript's parseFloat prefix rather than calling its own
// parser, because every language's own parser disagrees with the other four
// somewhere: Go's strconv.ParseFloat refuses "12abc" outright and reports an
// overflowing "1e400" as an error the other four read as an infinity. A cap read
// as 1234.5 in one language and 1 in another is a cap that silently disappears,
// and this table is what stops that shipping green.
func TestOrderRouterFixtureNumberAt(t *testing.T) {
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "numberCases") {
		id := routerStringAt(testCase, "id", "")
		container := routerDictAt(testCase, "container")
		key := routerStringAt(testCase, "key", "")
		defaultValue := routerNumberAt(testCase, "default", 0)
		expected := routerNumberAt(testCase, "expected", 0)
		actual := routerNumberAt(container, key, defaultValue)
		if !routerNumbersMatch(actual, expected) {
			t.Fatalf("numberCase %s: expected %v, got %v", id, expected, actual)
		}
	}
}

func TestOrderRouterFixtureBuildUnwindPlan(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "unwindCases") {
		report := routerDictAt(routerDictAt(fixture, "reports"), routerStringAt(testCase, "report", ""))
		unwind := router.BuildUnwindPlan(report)
		routerAssertMatches(t, routerNormalise(unwind), routerNormalise(testCase["expected"]), "unwindCase "+routerStringAt(testCase, "id", ""))
	}
}

//  ---------------------------------------------------------------------------
//  invariants, asserted directly rather than through the fixture
//  ---------------------------------------------------------------------------

func routerOneLegRoute(side string, base string, quote string, amount float64, price float64) map[string]any {
	from := base
	to := quote
	amountIn := amount
	amountOut := amount * price
	if side == "buy" {
		from = quote
		to = base
		amountIn = amount * price
		amountOut = amount
	}
	return map[string]any{
		"from":             from,
		"to":               to,
		"strategy":         "best_single",
		"exactSide":        "in",
		"amountIn":         amountIn,
		"amountOut":        amountOut,
		"fullyFillable":    true,
		"fillRatio":        1.0,
		"unroutableReason": nil,
		"hops": []any{
			map[string]any{
				"pair":          base + "/" + quote,
				"side":          side,
				"base":          base,
				"quote":         quote,
				"amountIn":      amountIn,
				"amountOut":     amountOut,
				"legs":          []any{map[string]any{"exchangeId": "stub", "amount": amount, "averagePrice": price, "takerFeeRate": 0.0, "feeCost": 0.0, "effectivePrice": price}},
				"fullyFillable": true,
			},
		},
	}
}

func routerTwoHopRoute() map[string]any {
	return map[string]any{
		"from":             "USDT",
		"to":               "SOL",
		"strategy":         "best_single",
		"exactSide":        "in",
		"amountIn":         20.0,
		"amountOut":        0.2,
		"fullyFillable":    true,
		"fillRatio":        1.0,
		"unroutableReason": nil,
		"hops": []any{
			map[string]any{"pair": "BTC/USDT", "side": "buy", "base": "BTC", "quote": "USDT", "amountIn": 20.0, "amountOut": 0.2, "legs": []any{map[string]any{"exchangeId": "stub", "amount": 0.2, "averagePrice": 100.0, "effectivePrice": 100.0}}},
			map[string]any{"pair": "BTC/USDT", "side": "sell", "base": "BTC", "quote": "USDT", "amountIn": 0.2, "amountOut": 20.0, "legs": []any{map[string]any{"exchangeId": "stub", "amount": 0.2, "averagePrice": 100.0, "effectivePrice": 100.0}}},
		},
	}
}

func routerStubMarket() map[string]any {
	return map[string]any{
		"symbol":    "BTC/USDT",
		"base":      "BTC",
		"quote":     "USDT",
		"precision": map[string]any{"amount": 0.0, "price": 0.0},
		"limits":    map[string]any{"amount": map[string]any{"min": 0.0, "max": 0.0}, "price": map[string]any{"min": 0.0, "max": 0.0}, "cost": map[string]any{"min": 0.0, "max": 0.0}},
	}
}

func routerPermissiveStubMarkets() map[string]any {
	return map[string]any{"stub": map[string]any{"BTC/USDT": routerStubMarket()}}
}

func routerCodes(violations []map[string]any) []string {
	codes := make([]string, 0, len(violations))
	for i := 0; i < len(violations); i++ {
		codes = append(codes, routerStringAt(violations[i], "code", ""))
	}
	return codes
}

func TestOrderRouterConstructorCapMayBeLoweredNeverRaised(t *testing.T) {
	if _, err := NewOrderRouter(map[string]any{}); routerErrorCode(err) != "ArgumentsRequired" {
		t.Fatalf("an apiKey is required, got %v", err)
	}
	if _, err := NewOrderRouter(map[string]any{"apiKey": "k", "maxNotionalUsd": 25.01}); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("the 25 USD cap must not be raisable, got %v", err)
	}
	if _, err := NewOrderRouter(map[string]any{"apiKey": "k", "maxNotionalUsd": 0}); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("a non-positive cap must be refused, got %v", err)
	}
	lowered, err := NewOrderRouter(map[string]any{"apiKey": "k", "maxNotionalUsd": 5})
	if err != nil || lowered.MaxNotionalUsd != 5 {
		t.Fatalf("the cap may be lowered, got %v %v", lowered, err)
	}
	standard, err := NewOrderRouter(map[string]any{"apiKey": "k"})
	if err != nil || standard.MaxNotionalUsd != 25 {
		t.Fatalf("the default cap is 25, got %v %v", standard, err)
	}
	if OrderRouterMaxNotionalUsd != 25 {
		t.Fatalf("the hard ceiling is 25, got %v", OrderRouterMaxNotionalUsd)
	}
}

func TestOrderRouterLimitPriceSitsOnTheSideThatCostsYou(t *testing.T) {
	router := routerTestRouter(t)
	buy := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 1, 100), map[string]any{"slippageBps": 100.0}))
	if got := routerNumberAt(buy["steps"].([]map[string]any)[0], "limitPrice", 0); got != 101 {
		t.Fatalf("a buy pays up to 1%% more, got %v", got)
	}
	sell := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("sell", "BTC", "USDT", 1, 100), map[string]any{"slippageBps": 100.0}))
	if got := routerNumberAt(sell["steps"].([]map[string]any)[0], "limitPrice", 0); got != 99 {
		t.Fatalf("a sell accepts down to 1%% less, got %v", got)
	}
	none := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 1, 100), map[string]any{"slippageBps": 0.0}))
	if got := routerNumberAt(none["steps"].([]map[string]any)[0], "limitPrice", 0); got != 100 {
		t.Fatalf("zero slippage means the expected price, got %v", got)
	}
}

func TestOrderRouterNotionalCapBlocksAt25(t *testing.T) {
	router := routerTestRouter(t)
	markets := routerPermissiveStubMarkets()
	rates := map[string]any{"usdRates": map[string]any{"USDT": 1.0}}
	// amount * limitPrice is what is measured, so a 1% slippage on a 24.90 USD
	// step is what carries it over the line
	under := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.24, 100), map[string]any{"slippageBps": 0.0}))
	if got := router.CheckExecutionPlanSafety(under, markets, rates); len(got) != 0 {
		t.Fatalf("24 USD passes, got %v", routerCodes(got))
	}
	at := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.25, 100), map[string]any{"slippageBps": 0.0}))
	if got := router.CheckExecutionPlanSafety(at, markets, rates); len(got) != 0 {
		t.Fatalf("exactly 25 USD passes, got %v", routerCodes(got))
	}
	over := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2501, 100), map[string]any{"slippageBps": 0.0}))
	overViolations := router.CheckExecutionPlanSafety(over, markets, rates)
	if len(overViolations) != 1 || routerStringAt(overViolations[0], "code", "") != "notional_exceeds_cap" || !routerBoolAt(overViolations[0], "blocking", false) {
		t.Fatalf("25.01 USD blocks, got %v", routerCodes(overViolations))
	}
	// and the slippage is inside the measurement, not outside it
	slipped := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.249, 100), map[string]any{"slippageBps": 100.0}))
	slippedViolations := router.CheckExecutionPlanSafety(slipped, markets, rates)
	if len(slippedViolations) != 1 || routerStringAt(slippedViolations[0], "code", "") != "notional_exceeds_cap" {
		t.Fatalf("24.90 USD at 1%% slippage is 25.15 USD of risk, got %v", routerCodes(slippedViolations))
	}
}

func TestOrderRouterUnvaluableStepBlocksAndIsNeverSkipped(t *testing.T) {
	router := routerTestRouter(t)
	markets := routerPermissiveStubMarkets()
	// 0.01 USDT of notional: trivially under any cap, and still refused, because
	// the point is that the cap could not be EVALUATED
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.0001, 100), map[string]any{"slippageBps": 0.0}))
	violations := router.CheckExecutionPlanSafety(plan, markets, map[string]any{"usdRates": map[string]any{}})
	if len(violations) != 1 || routerStringAt(violations[0], "code", "") != "notional_unvaluable" {
		t.Fatalf("an unvaluable step must be reported, got %v", routerCodes(violations))
	}
	if !routerBoolAt(violations[0], "blocking", false) {
		t.Fatal("an unvaluable step must block, or the cap is decorative")
	}
	// unrelated rates do not help
	stillBlocked := router.CheckExecutionPlanSafety(plan, markets, map[string]any{"usdRates": map[string]any{"ETH": 3000.0, "DOGE": 0.09}})
	if routerStringAt(stillBlocked[0], "code", "") != "notional_unvaluable" {
		t.Fatalf("unrelated rates do not rescue it, got %v", routerCodes(stillBlocked))
	}
	// either side of the market resolves it
	if got := router.CheckExecutionPlanSafety(plan, markets, map[string]any{"usdRates": map[string]any{"USDT": 1.0}}); len(got) != 0 {
		t.Fatalf("a quote rate values it, got %v", routerCodes(got))
	}
	if got := router.CheckExecutionPlanSafety(plan, markets, map[string]any{"usdRates": map[string]any{"BTC": 100.0}}); len(got) != 0 {
		t.Fatalf("a base rate values it, got %v", routerCodes(got))
	}
}

func TestOrderRouterUsdtIsNotAssumedToBeOneDollar(t *testing.T) {
	router := routerTestRouter(t)
	markets := routerPermissiveStubMarkets()
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.1, 100), map[string]any{"slippageBps": 0.0}))
	violations := router.CheckExecutionPlanSafety(plan, markets, map[string]any{"usdRates": map[string]any{"USD": 1.0}})
	if len(violations) != 1 || routerStringAt(violations[0], "code", "") != "notional_unvaluable" {
		t.Fatalf("a stablecoin peg is an observation, not a definition, got %v", routerCodes(violations))
	}
	// a depegged rate is respected: 10 USDT at 0.40 is 4 USD
	if got := router.CheckExecutionPlanSafety(plan, markets, map[string]any{"usdRates": map[string]any{"USDT": 0.4}}); len(got) != 0 {
		t.Fatalf("a depegged rate is respected, got %v", routerCodes(got))
	}
}

func TestOrderRouterEmptyPlanIsNotASafePlan(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerDictAt(routerDictAt(fixture, "routes"), "unroutable"), nil))
	if steps := plan["steps"].([]map[string]any); len(steps) != 0 {
		t.Fatalf("an unroutable route has no steps, got %d", len(steps))
	}
	violations := router.CheckExecutionPlanSafety(plan, routerPermissiveStubMarkets(), map[string]any{"usdRates": map[string]any{"USDT": 1.0}})
	if len(violations) != 1 || routerStringAt(violations[0], "code", "") != "empty_plan" || !routerBoolAt(violations[0], "blocking", false) {
		t.Fatalf("zero violations on zero steps would read as approval, got %v", routerCodes(violations))
	}
}

func TestOrderRouterReconcileNeverScalesADownstreamOrderUp(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerDictAt(routerDictAt(fixture, "routes"), "multiHop"), nil))
	overfilled, err := router.ReconcileExecutionStep(plan, 0, 1000000)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if routerNumberAt(overfilled, "scale", 0) != 1 {
		t.Fatal("an overfill must not grow an order the safety check never saw")
	}
	if routerStringAt(overfilled, "verdict", "") != "proceed" {
		t.Fatalf("an overfill proceeds, got %v", overfilled["verdict"])
	}
	downstream := overfilled["resizedSteps"].([]map[string]any)[0]
	if routerNumberAt(downstream, "amount", 0) != routerNumberAt(downstream, "previousAmount", -1) {
		t.Fatal("a downstream order keeps its size on an overfill")
	}
}

func TestOrderRouterReconcileHaltsOnATotalMissAndAnOverToleranceShortfall(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerDictAt(routerDictAt(fixture, "routes"), "multiHop"), nil))
	nothing, _ := router.ReconcileExecutionStep(plan, 0, 0)
	if routerStringAt(nothing, "verdict", "") != "halt" || routerStringAt(nothing, "reason", "") != "nothing_filled" {
		t.Fatalf("nothing filled halts, got %v %v", nothing["verdict"], nothing["reason"])
	}
	// expectedOut of step 0 is 500 * 0.089 = 44.5; 2% of that is 0.89
	inside, _ := router.ReconcileExecutionStep(plan, 0, 44.5-0.88)
	if routerStringAt(inside, "verdict", "") != "proceed" {
		t.Fatalf("a shortfall inside tolerance proceeds, got %v", inside["verdict"])
	}
	outside, _ := router.ReconcileExecutionStep(plan, 0, 44.5-0.9)
	if routerStringAt(outside, "verdict", "") != "halt" || routerStringAt(outside, "reason", "") != "shortfall_exceeds_tolerance" {
		t.Fatalf("a shortfall past tolerance halts, got %v %v", outside["verdict"], outside["reason"])
	}
	if _, err := router.ReconcileExecutionStep(plan, 7, 1); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("an out-of-range stepIndex is refused, got %v", err)
	}
}

func TestOrderRouterUnwindIsNeverAutomaticAndNeverNetsAcrossVenues(t *testing.T) {
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	unwind := router.BuildUnwindPlan(routerDictAt(routerDictAt(fixture, "reports"), "haltedCrossVenue"))
	if unwind["requiresConfirmation"] != true || unwind["automatic"] != false {
		t.Fatal("an unwind plan is never automatic")
	}
	if routerNumberAt(unwind, "residualCount", 0) != 2 {
		t.Fatal("the mexc USDT and the binance SOL are separate positions")
	}
	steps := unwind["steps"].([]map[string]any)
	// the USDT sold on mexc and the USDT spent on binance are NOT the same money,
	// because this class never moves funds between venues
	if routerStringAt(steps[0], "exchangeId", "") != "binance" || routerStringAt(steps[1], "exchangeId", "") != "mexc" {
		t.Fatal("residuals are unwound in reverse execution order")
	}
	if routerStringAt(steps[1], "side", "") != "buy" || routerNumberAt(steps[1], "amount", 0) != 500 {
		t.Fatal("leftover quote is spent buying the asset back: 44.5 USDT at 0.089 is 500 DOGE")
	}
	if routerBoolAt(steps[1], "reachesFrom", false) != true {
		t.Fatal("buying DOGE back reaches the from-asset")
	}
	if routerStringAt(steps[0], "side", "") != "sell" || routerBoolAt(steps[0], "reachesFrom", true) != false {
		t.Fatal("selling SOL for USDT is not yet DOGE")
	}
}

//  ---------------------------------------------------------------------------
//  Execute — stub venues only, and not one real order anywhere
//  ---------------------------------------------------------------------------

// orderRouterStubVenue is an IExchange whose unimplemented methods are promoted
// from a nil embedded interface: calling one that this test has not overridden
// panics, which is exactly the proof that the router never reaches for it.
type orderRouterStubVenue struct {
	IExchange
	mutex      sync.Mutex
	calls      []string
	fillRatio  float64
	failCreate bool
	features   map[string]any
	markets    *sync.Map
	balanceFn  func() (Balances, error)
	// a queue of orders FetchOrder hands back, one per poll; empty means the
	// created order comes back closed on the first read
	fetchOrderResults []Order
	fetchOrderThrows  bool
	cancelThrows      bool
	createdStatus     string
}

func newOrderRouterStubVenue(fillRatio float64, failCreate bool) *orderRouterStubVenue {
	markets := &sync.Map{}
	markets.Store("BTC/USDT", routerStubMarket())
	return &orderRouterStubVenue{
		calls:      []string{},
		fillRatio:  fillRatio,
		failCreate: failCreate,
		features:   map[string]any{"spot": map[string]any{"createOrder": map[string]any{"timeInForce": []any{"GTC", "IOC"}}}},
		markets:    markets,
	}
}

func (this *orderRouterStubVenue) FetchOrder(id string, options ...FetchOrderOptions) (Order, error) {
	this.record("fetchOrder:" + id)
	if this.fetchOrderThrows {
		return Order{}, ExchangeError("stub cannot read the order back")
	}
	this.mutex.Lock()
	defer this.mutex.Unlock()
	if len(this.fetchOrderResults) > 0 {
		next := this.fetchOrderResults[0]
		this.fetchOrderResults = this.fetchOrderResults[1:]
		return next, nil
	}
	status := "closed"
	zero := 0.0
	return Order{Id: &id, Status: &status, Filled: &zero, Average: &zero, Cost: &zero}, nil
}

func (this *orderRouterStubVenue) CancelOrder(id string, options ...CancelOrderOptions) (Order, error) {
	this.record("cancelOrder:" + id)
	if this.cancelThrows {
		return Order{}, ExchangeError("stub refuses to cancel")
	}
	status := "canceled"
	return Order{Id: &id, Status: &status}, nil
}

func routerStubOrder(id string, status string, filled float64, average float64, cost float64) Order {
	return Order{Id: &id, Status: &status, Filled: &filled, Average: &average, Cost: &cost}
}

func (this *orderRouterStubVenue) record(call string) {
	this.mutex.Lock()
	defer this.mutex.Unlock()
	this.calls = append(this.calls, call)
}

func (this *orderRouterStubVenue) callLog() []string {
	this.mutex.Lock()
	defer this.mutex.Unlock()
	log := make([]string, len(this.calls))
	copy(log, this.calls)
	return log
}

func (this *orderRouterStubVenue) LoadMarkets(params ...any) (map[string]MarketInterface, error) {
	this.record("loadMarkets")
	return map[string]MarketInterface{}, nil
}

func (this *orderRouterStubVenue) GetMarkets() *sync.Map {
	return this.markets
}

func (this *orderRouterStubVenue) GetFeatures() map[string]any {
	return this.features
}

func (this *orderRouterStubVenue) AmountToPrecision(symbol any, amount any) any {
	return strconv.FormatFloat(routerToNumber(amount, 0), 'f', -1, 64)
}

func (this *orderRouterStubVenue) PriceToPrecision(symbol any, price any) any {
	return strconv.FormatFloat(routerToNumber(price, 0), 'f', -1, 64)
}

func (this *orderRouterStubVenue) FetchBalance(params ...any) (Balances, error) {
	this.record("fetchBalance")
	if this.balanceFn != nil {
		return this.balanceFn()
	}
	usdt := 1000.0
	btc := 1.0
	zero := 0.0
	return Balances{
		Free:  map[string]*float64{"USDT": &usdt, "BTC": &btc, "ZERO": &zero},
		Total: map[string]*float64{"USDT": &usdt, "BTC": &btc},
	}, nil
}

func (this *orderRouterStubVenue) CreateOrder(symbol string, typeVar string, side string, amount float64, options ...CreateOrderOptions) (Order, error) {
	opts := CreateOrderOptionsStruct{}
	for _, option := range options {
		option(&opts)
	}
	this.record("createOrder:" + typeVar + ":" + side + ":" + strconv.FormatFloat(amount, 'f', -1, 64))
	if this.failCreate {
		return Order{}, ExchangeError("stub refuses")
	}
	id := "stub-order"
	status := "closed"
	if this.createdStatus != "" {
		status = this.createdStatus
	}
	filled := amount * this.fillRatio
	average := 100.0
	if opts.Price != nil {
		average = *opts.Price
	}
	cost := filled * average
	return Order{Id: &id, Status: &status, Filled: &filled, Average: &average, Cost: &cost}, nil
}

func routerStubVenues(venues map[string]*orderRouterStubVenue) map[string]IExchange {
	widened := map[string]IExchange{}
	for id, venue := range venues {
		widened[id] = venue
	}
	return widened
}

func TestOrderRouterDryRunIsTheDefault(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), nil))
	venue := newOrderRouterStubVenue(1, false)
	// everything a real call would carry, EXCEPT live
	report, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{
		"strategy":          "sequential",
		"usdRates":          map[string]any{"USDT": 1.0},
		"allowMarketOrders": true,
	})
	if err != nil {
		t.Fatalf("a dry run never fails: %v", err)
	}
	if report["dryRun"] != true || report["strategy"] != "dry_run" {
		t.Fatalf("dry_run is the default, got %v %v", report["dryRun"], report["strategy"])
	}
	if report["requestedStrategy"] != "sequential" {
		t.Fatal("the report says what was asked for as well as what happened")
	}
	if routerNumberAt(report, "ordersPlaced", -1) != 0 || routerNumberAt(report, "wouldPlaceOrders", -1) != 1 {
		t.Fatalf("a dry run places nothing, got %v %v", report["ordersPlaced"], report["wouldPlaceOrders"])
	}
	if routerStringAt(report["steps"].([]map[string]any)[0], "status", "") != "planned" {
		t.Fatal("every step stays planned in a dry run")
	}
	if len(venue.callLog()) != 0 {
		t.Fatalf("not one call reached the venue — not even a read, got %v", venue.callLog())
	}
	// live must be exactly the boolean true; "true" and 1 are not-true
	for _, notLive := range []any{false, nil, "true", 1} {
		other := newOrderRouterStubVenue(1, false)
		again, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": other}), map[string]any{"strategy": "sequential", "live": notLive, "usdRates": map[string]any{"USDT": 1.0}})
		if err != nil {
			t.Fatalf("live=%v: %v", notLive, err)
		}
		if again["dryRun"] != true {
			t.Fatalf("live=%v must not be live", notLive)
		}
		if len(other.callLog()) != 0 {
			t.Fatalf("live=%v reached the venue: %v", notLive, other.callLog())
		}
	}
}

func TestOrderRouterRefusesToGoLiveWithoutAWayToValueTheTrade(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), nil))
	venue := newOrderRouterStubVenue(1, false)
	_, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "sequential", "live": true})
	if routerErrorCode(err) != "ExchangeError" {
		t.Fatalf("an unvaluable plan is refused, got %v", err)
	}
	for _, call := range venue.callLog() {
		if strings.Contains(call, "createOrder") {
			t.Fatalf("no order was placed, got %v", venue.callLog())
		}
	}
}

func TestOrderRouterRefusesToGoLiveAboveTheCap(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 5, 100), nil))
	venue := newOrderRouterStubVenue(1, false)
	_, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if routerErrorCode(err) != "ExchangeError" {
		t.Fatalf("a 500 USD plan is refused, got %v", err)
	}
	for _, call := range venue.callLog() {
		if strings.Contains(call, "createOrder") {
			t.Fatalf("no order was placed, got %v", venue.callLog())
		}
	}
}

func TestOrderRouterSequentialPlacesIocLimitOrdersInPlanOrder(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), map[string]any{"slippageBps": 100.0}))
	venue := newOrderRouterStubVenue(1, false)
	report, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if report["dryRun"] != false || routerNumberAt(report, "ordersPlaced", 0) != 1 {
		t.Fatalf("one order was placed, got %v %v", report["dryRun"], report["ordersPlaced"])
	}
	step := report["steps"].([]map[string]any)[0]
	if routerStringAt(step, "status", "") != "filled" || routerStringAt(step, "outAsset", "") != "BTC" || routerNumberAt(step, "outAmount", 0) != 0.2 || routerStringAt(step, "inAsset", "") != "USDT" {
		t.Fatalf("a filled buy produces base and consumes quote, got %v", step)
	}
	if got := venue.callLog(); len(got) != 1 || got[0] != "createOrder:limit:buy:0.2" {
		t.Fatalf("one IOC limit order, got %v", got)
	}
	if report["halted"] != false {
		t.Fatal("a fully filled single hop does not halt")
	}
}

func TestOrderRouterSequentialObeysTheHaltVerdict(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerTwoHopRoute(), nil))
	// hop 0 fills half: a 50% shortfall against a 2% tolerance
	venue := newOrderRouterStubVenue(0.5, false)
	report, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if report["halted"] != true || routerStringAt(report, "haltReason", "") != "shortfall_exceeds_tolerance" || routerNumberAt(report, "haltStepIndex", -99) != 0 {
		t.Fatalf("a 50%% shortfall halts at step 0, got %v %v %v", report["halted"], report["haltReason"], report["haltStepIndex"])
	}
	if routerNumberAt(report, "ordersPlaced", 0) != 1 {
		t.Fatal("the second hop was never attempted")
	}
	if routerStringAt(report["steps"].([]map[string]any)[1], "status", "") != "skipped" {
		t.Fatal("the downstream step is marked skipped")
	}
	if len(venue.callLog()) != 1 {
		t.Fatalf("exactly one order reached the venue, got %v", venue.callLog())
	}
	// and the halted report is exactly what BuildUnwindPlan is for
	unwind := router.BuildUnwindPlan(report)
	if routerNumberAt(unwind, "residualCount", 0) != 1 {
		t.Fatalf("one residual, got %v", unwind["residualCount"])
	}
	step := unwind["steps"].([]map[string]any)[0]
	if routerStringAt(step, "side", "") != "sell" || routerBoolAt(step, "reachesFrom", false) != true {
		t.Fatal("the BTC bought on hop 0 goes back to USDT")
	}
}

func TestOrderRouterMarketOrderNeedsBothAMissingIocAndAnExplicitOptIn(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), nil))
	gtcOnly := map[string]any{"spot": map[string]any{"createOrder": map[string]any{"timeInForce": []any{"GTC"}}}}
	// a venue that advertises GTC only
	noIoc := newOrderRouterStubVenue(1, false)
	noIoc.features = gtcOnly
	refused, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": noIoc}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	step := refused["steps"].([]map[string]any)[0]
	if routerStringAt(step, "status", "") != "failed" || routerStringAt(step, "errorCode", "") != "NotSupported" {
		t.Fatalf("a venue without IOC fails the step, got %v", step)
	}
	if len(noIoc.callLog()) != 0 {
		t.Fatalf("defaulting to a market order is the decision the caller did not delegate, got %v", noIoc.callLog())
	}
	allowed := newOrderRouterStubVenue(1, false)
	allowed.features = gtcOnly
	placed, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": allowed}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "allowMarketOrders": true})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if routerStringAt(placed["steps"].([]map[string]any)[0], "status", "") != "filled" {
		t.Fatal("an explicit opt-in permits the market order")
	}
	if got := allowed.callLog(); len(got) != 1 || got[0] != "createOrder:market:buy:0.2" {
		t.Fatalf("a market order was placed, got %v", got)
	}
	// a venue that says nothing about timeInForce is assumed to do IOC: a
	// rejected IOC is loud and cheap, an unintended market order is not
	unknown := newOrderRouterStubVenue(1, false)
	unknown.features = map[string]any{}
	assumed, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": unknown}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if routerStringAt(assumed["steps"].([]map[string]any)[0], "status", "") != "filled" {
		t.Fatal("an unknown timeInForce is assumed to do IOC")
	}
	if got := unknown.callLog(); len(got) != 1 || got[0] != "createOrder:limit:buy:0.2" {
		t.Fatalf("a limit order was placed, got %v", got)
	}
}

func TestOrderRouterParallelWithinHopContainsAFailingLeg(t *testing.T) {
	router := routerTestRouter(t)
	route := routerOneLegRoute("buy", "BTC", "USDT", 0.1, 100)
	hop := route["hops"].([]any)[0].(map[string]any)
	hop["legs"] = []any{
		map[string]any{"exchangeId": "good", "amount": 0.1, "averagePrice": 100.0, "effectivePrice": 100.0},
		map[string]any{"exchangeId": "bad", "amount": 0.1, "averagePrice": 100.0, "effectivePrice": 100.0},
		map[string]any{"exchangeId": "good2", "amount": 0.1, "averagePrice": 100.0, "effectivePrice": 100.0},
	}
	plan := routerMustPlan(router.BuildExecutionPlan(route, nil))
	good := newOrderRouterStubVenue(1, false)
	bad := newOrderRouterStubVenue(1, true)
	good2 := newOrderRouterStubVenue(1, false)
	report, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"good": good, "bad": bad, "good2": good2}), map[string]any{"strategy": "parallel_within_hop", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	steps := report["steps"].([]map[string]any)
	if routerStringAt(steps[0], "status", "") != "filled" || routerStringAt(steps[1], "status", "") != "failed" || routerStringAt(steps[2], "status", "") != "filled" {
		t.Fatalf("the sibling behind the failure still ran, got %v %v %v", steps[0]["status"], steps[1]["status"], steps[2]["status"])
	}
	reportErrors := report["errors"].([]map[string]any)
	if len(reportErrors) != 1 || routerStringAt(reportErrors[0], "exchangeId", "") != "bad" {
		t.Fatalf("exactly one leg failed, got %v", reportErrors)
	}
	if report["halted"] != true || routerStringAt(report, "haltReason", "") != "order_failed" {
		t.Fatal("a failed leg still halts the route after the hop settles")
	}
}

func TestOrderRouterBestEffortRefusesMultiHopAndDemandsItsAcknowledgements(t *testing.T) {
	router := routerTestRouter(t)
	venue := newOrderRouterStubVenue(1, false)
	venues := routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue})
	multiHop := routerMustPlan(router.BuildExecutionPlan(routerTwoHopRoute(), nil))
	_, err := router.Execute(multiHop, venues, map[string]any{"strategy": "best_effort", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "acknowledgeDispersion": true, "maxOrders": 5.0})
	if routerErrorCode(err) != "NotSupported" {
		t.Fatalf("best_effort refuses multi-hop, got %v", err)
	}
	singleHop := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), nil))
	_, err = router.Execute(singleHop, venues, map[string]any{"strategy": "best_effort", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "maxOrders": 5.0})
	if routerErrorCode(err) != "BadRequest" {
		t.Fatalf("best_effort requires acknowledgeDispersion, got %v", err)
	}
	_, err = router.Execute(singleHop, venues, map[string]any{"strategy": "best_effort", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "acknowledgeDispersion": true})
	if routerErrorCode(err) != "BadRequest" {
		t.Fatalf("best_effort requires a positive maxOrders, got %v", err)
	}
	if len(venue.callLog()) != 0 {
		t.Fatalf("none of the three refusals reached the venue, got %v", venue.callLog())
	}
}

func TestOrderRouterBestEffortStopsAtMaxOrdersAndNeverHalts(t *testing.T) {
	router := routerTestRouter(t)
	route := routerOneLegRoute("buy", "BTC", "USDT", 0.1, 100)
	hop := route["hops"].([]any)[0].(map[string]any)
	hop["legs"] = []any{
		map[string]any{"exchangeId": "a", "amount": 0.1, "averagePrice": 100.0, "effectivePrice": 100.0},
		map[string]any{"exchangeId": "b", "amount": 0.1, "averagePrice": 100.0, "effectivePrice": 100.0},
		map[string]any{"exchangeId": "c", "amount": 0.1, "averagePrice": 100.0, "effectivePrice": 100.0},
	}
	plan := routerMustPlan(router.BuildExecutionPlan(route, nil))
	c := newOrderRouterStubVenue(1, false)
	venues := routerStubVenues(map[string]*orderRouterStubVenue{"a": newOrderRouterStubVenue(1, false), "b": newOrderRouterStubVenue(0.01, false), "c": c})
	report, err := router.Execute(plan, venues, map[string]any{"strategy": "best_effort", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "acknowledgeDispersion": true, "maxOrders": 2.0})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if routerNumberAt(report, "ordersPlaced", 0) != 2 {
		t.Fatalf("maxOrders caps the order count, got %v", report["ordersPlaced"])
	}
	third := report["steps"].([]map[string]any)[2]
	if routerStringAt(third, "status", "") != "skipped" || routerStringAt(third, "errorCode", "") != "max_orders_reached" {
		t.Fatalf("the third leg is skipped, got %v", third)
	}
	if report["halted"] != false {
		t.Fatal("a 1% fill on leg b does not stop best_effort — that is the whole strategy")
	}
	if len(c.callLog()) != 0 {
		t.Fatalf("the capped leg never reached its venue, got %v", c.callLog())
	}
}

// The hard 25 USD cap must survive a writable MaxNotionalUsd. The constructor
// refuses to be built above 25, but MaxNotionalUsd is an exported struct field
// and plain assignment is idiomatic Go — a ceiling that one assignment removes
// is not a ceiling, so both clamp sites re-impose the constant.
func TestOrderRouterCapSurvivesAWritableField(t *testing.T) {
	tampered := routerTestRouter(t)
	tampered.MaxNotionalUsd = 1000
	// 0.005 BTC at 100000 USDT is 500 USD
	plan := routerMustPlan(tampered.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.005, 100000), map[string]any{"slippageBps": 0.0}))
	violations := tampered.CheckExecutionPlanSafety(plan, routerPermissiveStubMarkets(), map[string]any{"usdRates": map[string]any{"USDT": 1.0}, "maxNotionalUsd": 1000.0})
	if len(violations) != 1 || routerStringAt(violations[0], "code", "") != "notional_exceeds_cap" {
		t.Fatalf("a 500 USD step must still be refused, got %v", violations)
	}
	if routerNumberAt(violations[0], "limit", 0) != 25 {
		t.Fatalf("the limit reported is the constant, not the tampered field, got %v", violations[0]["limit"])
	}
	step := routerListAt(plan, "steps")[0]
	if err := tampered.assertUnderCap(routerContainer(step), 0.005, 100000, map[string]any{"USDT": 1.0}, map[string]any{"maxNotionalUsd": 1000.0}); err == nil {
		t.Fatal("the last check before an order goes out refuses too")
	}
}

// best_effort must derive the hop count from the steps it is about to execute: a
// plan that travelled through JSON, was rebuilt from persisted steps, or is the
// tail of a halted route can be missing hopCount entirely.
func TestOrderRouterBestEffortDerivesTheHopCountFromTheSteps(t *testing.T) {
	router := routerTestRouter(t)
	complete := routerMustPlan(router.BuildExecutionPlan(routerTwoHopRoute(), nil))
	withoutHopCount := map[string]any{}
	for key, value := range complete {
		if key != "hopCount" {
			withoutHopCount[key] = value
		}
	}
	if _, present := withoutHopCount["hopCount"]; present {
		t.Fatal("the plan really has no hopCount")
	}
	if len(routerListAt(withoutHopCount, "steps")) != 2 {
		t.Fatal("and it really has two hops worth of steps")
	}
	venue := newOrderRouterStubVenue(0.1, false)
	_, err := router.Execute(withoutHopCount, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "best_effort", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "acknowledgeDispersion": true, "maxOrders": 5.0})
	if err == nil {
		t.Fatal("best_effort across a bridge is refused however the plan reached us")
	}
	if len(venue.callLog()) != 0 {
		t.Fatalf("not one order was placed, got %v", venue.callLog())
	}
}

// venueSupportsIoc must read the dictionary of booleans every real ccxt exchange
// declares. features.spot.createOrder.timeInForce is a dictionary, never a list:
// bit2c, bitbank, bithumb and coinone all say IOC: false, and reading it as a
// list answered "yes" for every one of them.
func TestOrderRouterVenueSupportsIocReadsADictionary(t *testing.T) {
	router := routerTestRouter(t)
	noIocFeatures := map[string]any{"spot": map[string]any{"createOrder": map[string]any{"timeInForce": map[string]any{"IOC": false, "FOK": false, "PO": false, "GTD": false, "GTC": true}}}}
	noIoc := newOrderRouterStubVenue(1, false)
	noIoc.features = noIocFeatures
	if router.venueSupportsIoc(noIoc) {
		t.Fatal("IOC: false means no")
	}
	withIoc := newOrderRouterStubVenue(1, false)
	withIoc.features = map[string]any{"spot": map[string]any{"createOrder": map[string]any{"timeInForce": map[string]any{"IOC": true, "FOK": true, "PO": true, "GTD": false, "GTC": true}}}}
	if !router.venueSupportsIoc(withIoc) {
		t.Fatal("IOC: true means yes")
	}
	// a dictionary that enumerates its values and omits IOC has said no
	silentAboutIoc := newOrderRouterStubVenue(1, false)
	silentAboutIoc.features = map[string]any{"spot": map[string]any{"createOrder": map[string]any{"timeInForce": map[string]any{"GTC": true}}}}
	if router.venueSupportsIoc(silentAboutIoc) {
		t.Fatal("a list of values without IOC means no")
	}
	// and a venue that says nothing at all is still assumed to do IOC
	silent := newOrderRouterStubVenue(1, false)
	silent.features = map[string]any{}
	if !router.venueSupportsIoc(silent) {
		t.Fatal("silence is still assumed to be yes")
	}
	// end to end: the documented market-order fallback is reachable again
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), nil))
	refused, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": noIoc}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if routerStringAt(refused["steps"].([]map[string]any)[0], "errorCode", "") != "NotSupported" {
		t.Fatalf("the step refuses rather than sending an IOC, got %v", refused["steps"])
	}
	if len(noIoc.callLog()) != 0 {
		t.Fatalf("an IOC was never sent to a venue that cannot do one, got %v", noIoc.callLog())
	}
	allowed := newOrderRouterStubVenue(1, false)
	allowed.features = noIocFeatures
	placed, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": allowed}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "allowMarketOrders": true})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if routerStringAt(placed["steps"].([]map[string]any)[0], "status", "") != "filled" {
		t.Fatal("the opt-in reaches the market order")
	}
	if got := allowed.callLog(); len(got) != 1 || got[0] != "createOrder:market:buy:0.2" {
		t.Fatalf("a market order was placed, got %v", got)
	}
}

// A venue that cancels an order itself on the last poll — expiry, self-trade
// prevention, a post-only rejection of the remainder — has ENDED it, and the
// partial fill it carries is real.
func TestOrderRouterLimitProtectedKeepsAVenueSideCancelFill(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.0002, 100000), map[string]any{"slippageBps": 0.0}))
	venue := newOrderRouterStubVenue(1, false)
	venue.createdStatus = "open"
	venue.fetchOrderResults = []Order{
		routerStubOrder("stub-order", "open", 0, 0, 0),
		routerStubOrder("stub-order", "canceled", 0.0001, 100000, 10),
	}
	venue.cancelThrows = true
	report, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "limit_protected", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "orderTimeoutMs": 2.0, "pollIntervalMs": 1.0})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	for _, call := range venue.callLog() {
		if call == "cancelOrder:stub-order" {
			t.Fatal("an order the venue already closed is not cancelled again")
		}
	}
	step := report["steps"].([]map[string]any)[0]
	if routerStringAt(step, "status", "") != "partial" {
		t.Fatalf("the fill is kept, got %v", step)
	}
	if !routerNumbersMatch(routerNumberAt(step, "filledAmount", 0), 0.0001) || !routerNumbersMatch(routerNumberAt(step, "outAmount", 0), 0.0001) {
		t.Fatalf("and it is the right size, got %v", step)
	}
	if routerStringAt(step, "orderId", "") != "stub-order" {
		t.Fatal("and the id is reported")
	}
	if len(report["openOrders"].([]map[string]any)) != 0 {
		t.Fatalf("nothing is open: the venue closed it, got %v", report["openOrders"])
	}
	// and the 0.0001 BTC that was actually bought reaches the unwind plan
	unwind := router.BuildUnwindPlan(report)
	if routerNumberAt(unwind, "residualCount", 0) != 1 {
		t.Fatalf("a real position must never be invisible to the unwind path, got %v", unwind["residualCount"])
	}
	if !routerNumbersMatch(routerNumberAt(routerListAt(unwind, "steps")[0], "amount", 0), 0.0001) {
		t.Fatal("the unwind sells exactly what was bought")
	}
}

// Every path between a successful CreateOrder and the final read leaves a real
// order on a real venue. The id must be captured the instant CreateOrder returns,
// and a failure after that must file an open order the caller can act on.
func TestOrderRouterOrderIdSurvivesAFailureAfterCreate(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.0002, 100000), map[string]any{"slippageBps": 0.0}))
	venue := newOrderRouterStubVenue(1, false)
	venue.createdStatus = "open"
	venue.fetchOrderThrows = true
	report, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": venue}), map[string]any{"strategy": "limit_protected", "live": true, "usdRates": map[string]any{"USDT": 1.0}, "orderTimeoutMs": 4.0, "pollIntervalMs": 1.0})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	step := report["steps"].([]map[string]any)[0]
	if routerStringAt(step, "status", "") != "failed" {
		t.Fatalf("the step failed, got %v", step)
	}
	if routerStringAt(step, "orderId", "") != "stub-order" {
		t.Fatal("the id is captured the instant CreateOrder returns, not after the read")
	}
	openOrders := report["openOrders"].([]map[string]any)
	if len(openOrders) != 1 {
		t.Fatalf("a live order the caller cannot see is the worst outcome there is, got %v", openOrders)
	}
	if routerStringAt(openOrders[0], "orderId", "") != "stub-order" || routerStringAt(openOrders[0], "exchangeId", "") != "stub" || routerStringAt(openOrders[0], "reason", "") != "outcome_unknown" {
		t.Fatalf("and it names the order, the venue and why it may still be live, got %v", openOrders[0])
	}
	// the same holds for an immediate order, which has no poll loop at all
	other := newOrderRouterStubVenue(1, false)
	other.createdStatus = "open"
	okReport, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": other}), map[string]any{"strategy": "sequential", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if routerStringAt(okReport["steps"].([]map[string]any)[0], "orderId", "") != "stub-order" {
		t.Fatal("an immediate order reports its id too")
	}
	// and an "immediate" order the venue reports as STILL OPEN is a resting
	// order, which is what a venue that silently drops timeInForce leaves you
	stillOpen := okReport["openOrders"].([]map[string]any)
	if len(stillOpen) != 1 || routerStringAt(stillOpen[0], "orderId", "") != "stub-order" || routerStringAt(stillOpen[0], "reason", "") != "still_open" {
		t.Fatalf("a still-open immediate order is reported, got %v", stillOpen)
	}
}

func TestOrderRouterUnknownStrategyIsRefusedEvenInDryRun(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerOneLegRoute("buy", "BTC", "USDT", 0.2, 100), nil))
	if _, err := router.Execute(plan, map[string]IExchange{}, map[string]any{"strategy": "yolo"}); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("an unknown strategy is refused, got %v", err)
	}
}

func TestOrderRouterAtomicIshDemandsTheWholeRoutePrefunded(t *testing.T) {
	router := routerTestRouter(t)
	plan := routerMustPlan(router.BuildExecutionPlan(routerTwoHopRoute(), nil))
	// hop 0 needs 20 USDT and hop 1 needs 0.2 BTC, both already sitting there
	funded := newOrderRouterStubVenue(1, false)
	rich, err := router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": funded}), map[string]any{"strategy": "atomic_ish", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if err != nil {
		t.Fatalf("a pre-funded route runs end to end: %v", err)
	}
	if routerNumberAt(rich, "ordersPlaced", 0) != 2 {
		t.Fatalf("both hops ran, got %v", rich["ordersPlaced"])
	}
	broke := newOrderRouterStubVenue(1, false)
	broke.balanceFn = func() (Balances, error) {
		usdt := 1.0
		btc := 0.0
		return Balances{Free: map[string]*float64{"USDT": &usdt, "BTC": &btc}}, nil
	}
	_, err = router.Execute(plan, routerStubVenues(map[string]*orderRouterStubVenue{"stub": broke}), map[string]any{"strategy": "atomic_ish", "live": true, "usdRates": map[string]any{"USDT": 1.0}})
	if routerErrorCode(err) != "InsufficientFunds" {
		t.Fatalf("an underfunded route is refused, got %v", err)
	}
}

//  ---------------------------------------------------------------------------
//  FetchRoute request shaping and FetchRouteWithBalances, with the transport
//  stubbed out — no network
//  ---------------------------------------------------------------------------

func routerRecordingRouter(t *testing.T, config map[string]any, body map[string]any) (*OrderRouter, *string) {
	t.Helper()
	router, err := NewOrderRouter(config)
	if err != nil {
		t.Fatalf("NewOrderRouter: %v", err)
	}
	lastUrl := new(string)
	router.Transport = func(url string) (map[string]any, error) {
		*lastUrl = url
		return body, nil
	}
	return router, lastUrl
}

func TestOrderRouterFetchRouteRefusesNeitherOrBothAmounts(t *testing.T) {
	router, lastUrl := routerRecordingRouter(t, map[string]any{"apiKey": "k"}, map[string]any{})
	if _, err := router.FetchRoute("USDT", "BTC", map[string]any{}); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("neither amount is refused, got %v", err)
	}
	if _, err := router.FetchRoute("USDT", "BTC", map[string]any{"amountIn": 1.0, "amountOut": 1.0}); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("both amounts are refused, got %v", err)
	}
	if *lastUrl != "" {
		t.Fatalf("neither reached the wire, got %v", *lastUrl)
	}
}

func TestOrderRouterFetchRouteBuildsADeterministicQuery(t *testing.T) {
	router, lastUrl := routerRecordingRouter(t, map[string]any{"apiKey": "k", "baseUrl": "https://example.test/api/"}, map[string]any{"hops": []any{}})
	if _, err := router.FetchRoute("usdt", "btc", map[string]any{"amountIn": 0.001, "strategy": "split_capped", "maxVenues": 3.0, "exchanges": []any{"binance", "kraken"}, "certified": true}); err != nil {
		t.Fatalf("fetchRoute: %v", err)
	}
	expected := "https://example.test/api/route?from=USDT&to=BTC&amountIn=0.001&strategy=split_capped&maxVenues=3&exchanges=binance%2Ckraken&certified=true"
	if *lastUrl != expected {
		t.Fatalf("query mismatch\n got %v\nwant %v", *lastUrl, expected)
	}
}

func TestOrderRouterFetchRouteWithBalancesSkipsZerosAndSortsLargestFirst(t *testing.T) {
	router, lastUrl := routerRecordingRouter(t, map[string]any{"apiKey": "k"}, map[string]any{"hops": []any{}, "balancesApplied": "stub.BTC:1,stub.USDT:1000"})
	venues := routerStubVenues(map[string]*orderRouterStubVenue{"stub": newOrderRouterStubVenue(1, false)})
	route, err := router.FetchRouteWithBalances("USDT", "BTC", venues, map[string]any{"amountIn": 10.0})
	if err != nil {
		t.Fatalf("fetchRouteWithBalances: %v", err)
	}
	if route["balancesUsed"] != "stub.USDT:1000,stub.BTC:1" {
		t.Fatalf("largest first, and the ZERO holding is gone, got %v", route["balancesUsed"])
	}
	if len(route["balancesDropped"].([]map[string]any)) != 0 {
		t.Fatalf("nothing was dropped, got %v", route["balancesDropped"])
	}
	if !strings.Contains(*lastUrl, "balances=stub.USDT%3A1000%2Cstub.BTC%3A1") {
		t.Fatalf("the balances reached the query, got %v", *lastUrl)
	}
}

func TestOrderRouterFetchRouteWithBalancesRefusesARouteTheRouterIgnored(t *testing.T) {
	silent, _ := routerRecordingRouter(t, map[string]any{"apiKey": "k"}, map[string]any{"hops": []any{}})
	venues := routerStubVenues(map[string]*orderRouterStubVenue{"stub": newOrderRouterStubVenue(1, false)})
	if _, err := silent.FetchRouteWithBalances("USDT", "BTC", venues, map[string]any{"amountIn": 10.0}); routerErrorCode(err) != "ExchangeError" {
		t.Fatalf("a router that never echoed balancesApplied is refused, got %v", err)
	}
	// and the caller can opt out with their eyes open
	opted, _ := routerRecordingRouter(t, map[string]any{"apiKey": "k"}, map[string]any{"hops": []any{}})
	route, err := opted.FetchRouteWithBalances("USDT", "BTC", venues, map[string]any{"amountIn": 10.0, "requireBalancesApplied": false})
	if err != nil {
		t.Fatalf("the opt-out works: %v", err)
	}
	if route["balancesUsed"] != "stub.USDT:1000,stub.BTC:1" {
		t.Fatalf("the balances were still built, got %v", route["balancesUsed"])
	}
}

func TestOrderRouterFetchRouteWithBalancesTrimsToTheEntryCap(t *testing.T) {
	router, _ := routerRecordingRouter(t, map[string]any{"apiKey": "k"}, map[string]any{"hops": []any{}, "balancesApplied": "x"})
	many := newOrderRouterStubVenue(1, false)
	many.balanceFn = func() (Balances, error) {
		free := map[string]*float64{}
		for i := 0; i < 70; i++ {
			amount := float64(i + 1)
			free["C"+strconv.Itoa(i)] = &amount
		}
		return Balances{Free: free}, nil
	}
	route, err := router.FetchRouteWithBalances("USDT", "BTC", routerStubVenues(map[string]*orderRouterStubVenue{"stub": many}), map[string]any{"amountIn": 10.0})
	if err != nil {
		t.Fatalf("fetchRouteWithBalances: %v", err)
	}
	dropped := route["balancesDropped"].([]map[string]any)
	if len(dropped) != 6 {
		t.Fatalf("70 holdings trim to 64, got %d dropped", len(dropped))
	}
	if parts := strings.Split(route["balancesUsed"].(string), ","); len(parts) != OrderRouterMaxBalanceEntries {
		t.Fatalf("64 entries survive, got %d", len(parts))
	}
	for i := 0; i < len(dropped); i++ {
		if routerStringAt(dropped[i], "reason", "") != "entry_cap" {
			t.Fatalf("dropped for the entry cap, got %v", dropped[i])
		}
		if routerNumberAt(dropped[i], "amount", 0) > 6 {
			t.Fatalf("the six smallest holdings are the ones that went, got %v", dropped[i])
		}
	}
}

func TestOrderRouterFormatNumberNeverEmitsExponentNotation(t *testing.T) {
	router := routerTestRouter(t)
	cases := []struct {
		value    float64
		expected string
	}{
		{0.0000001, "0.0000001"},
		{0, "0"},
		{1000000, "1000000"},
		{0.5, "0.5"},
		{1e-15, "0"},
	}
	for _, testCase := range cases {
		got, err := router.FormatNumber(testCase.value)
		if err != nil {
			t.Fatalf("formatNumber(%v): %v", testCase.value, err)
		}
		if got != testCase.expected {
			t.Fatalf("formatNumber(%v) = %v, want %v", testCase.value, got, testCase.expected)
		}
	}
	if _, err := router.FormatNumber(1e21); routerErrorCode(err) != "BadRequest" {
		t.Fatalf("refused rather than rendered as 1e+21 in one language and not the others, got %v", err)
	}
}

// TestOrderRouterRealVenuesCarryThePrecisionSurface is the one test that pins
// the Go-specific hazard. AmountToPrecision and PriceToPrecision are NOT declared
// on IExchange — they are promoted from the embedded Exchange — so the router
// reaches them through a type assertion. If a future regeneration broke that
// promotion, every live step would fail with NotSupported and only this test
// would say why. It constructs real exchanges and touches no network.
func TestOrderRouterRealVenuesCarryThePrecisionSurface(t *testing.T) {
	router := routerTestRouter(t)
	for _, exchangeId := range []string{"binance", "kraken", "okx", "mexc"} {
		venue := CreateExchange(exchangeId, map[string]any{})
		if venue == nil {
			t.Fatalf("%s: CreateExchange returned nil", exchangeId)
		}
		if _, ok := venue.(orderRouterPrecision); !ok {
			t.Fatalf("%s: does not satisfy orderRouterPrecision, so Execute could never snap an order", exchangeId)
		}
		// and the IOC probe reads a real features block rather than an empty one
		if !router.venueSupportsIoc(venue) {
			t.Fatalf("%s: reads as unable to do IOC, which would push Execute toward a market order", exchangeId)
		}
	}
}

// TestOrderRouterNeverWithdraws is a source-level guard, not a behavioural one:
// the class must never reach a funds-transfer endpoint, and the cheapest way to
// keep that true forever is to fail the build the moment the token appears.
func TestOrderRouterNeverWithdraws(t *testing.T) {
	source, err := os.ReadFile("exchange_order_router.go")
	if err != nil {
		t.Fatalf("the router source is unreadable: %v", err)
	}
	if strings.Contains(strings.ToLower(string(source)), "withdraw") {
		t.Fatal("OrderRouter must never call a funds-transfer endpoint, and the token must not appear at all")
	}
}

// routerMustPlan unwraps BuildExecutionPlan's (plan, error) pair for the tests that expect the
// route to be coherent. The tests that expect a refusal read the error directly instead.
// Go only allows f(g()) when g supplies every argument, so this cannot take *testing.T and must
// panic instead of calling t.Fatalf; the panic still fails the test, with the offending call in
// the stack.
func routerMustPlan(plan map[string]any, err error) map[string]any {
	if err != nil {
		panic("BuildExecutionPlan: " + err.Error())
	}
	return plan
}

// ---------------------------------------------------------------------------
// the plan is checked against the client's OWN record of the question
// ---------------------------------------------------------------------------

func TestOrderRouterRefusesRouteThatDoesNotProduceTheRequestedAsset(t *testing.T) {
	// BuildExecutionPlan used to copy from, to, pair and side straight out of the server's JSON,
	// and the safety checks only tested internal consistency against whatever market that named.
	// So a compromised — or simply buggy — router response could steer real orders into any real
	// market and every check would pass it, under the 25 USD cap.
	router := routerTestRouter(t)
	route := routerOneLegRoute("buy", "BTC", "USDT", 0.1, 100)
	route["clientRequestedFrom"] = "USDT"
	route["clientRequestedTo"] = "ETH" // the caller wanted ETH; the route delivers BTC
	_, err := router.BuildExecutionPlan(route, nil)
	if err == nil || !strings.Contains(err.Error(), "produces BTC, not the requested ETH") {
		t.Fatalf("expected a produces-mismatch refusal, got %v", err)
	}
}

func TestOrderRouterRefusesRouteThatSpendsAnAssetTheCallerNeverOffered(t *testing.T) {
	router := routerTestRouter(t)
	route := routerOneLegRoute("buy", "BTC", "USDT", 0.1, 100)
	route["clientRequestedFrom"] = "EUR"
	route["clientRequestedTo"] = "BTC"
	_, err := router.BuildExecutionPlan(route, nil)
	if err == nil || !strings.Contains(err.Error(), "spends USDT, not the requested EUR") {
		t.Fatalf("expected a spends-mismatch refusal, got %v", err)
	}
}

func TestOrderRouterRefusesBridgedRouteWhoseHopsDoNotConnect(t *testing.T) {
	// Internal coherence, checked with or without a client stamp: hop 2 must spend exactly what
	// hop 1 produced, or the plan strands the proceeds of one order and funds the next from a
	// wallet nobody checked.
	router := routerTestRouter(t)
	route := routerTwoHopRoute()
	second := routerListAt(route, "hops")[1].(map[string]any)
	second["base"] = "DOGE"
	second["quote"] = "EUR"
	_, err := router.BuildExecutionPlan(route, nil)
	if err == nil || !strings.Contains(err.Error(), "spends DOGE but the previous hop produced BTC") {
		t.Fatalf("expected a chain-break refusal, got %v", err)
	}
}

func TestOrderRouterWellFormedRouteStillPlans(t *testing.T) {
	router := routerTestRouter(t)
	route := routerOneLegRoute("buy", "BTC", "USDT", 0.1, 100)
	route["clientRequestedFrom"] = "USDT"
	route["clientRequestedTo"] = "BTC"
	plan := routerMustPlan(router.BuildExecutionPlan(route, nil))
	if steps := routerListAt(plan, "steps"); len(steps) != 1 {
		t.Fatalf("expected 1 step, got %d", len(steps))
	}
}

func TestOrderRouterFixtureReconcileSequence(t *testing.T) {
	// ReconcileExecutionStep is pure and cannot remember across calls, so a hop's cumulative
	// shortfall lives on the steps themselves — written by applyResize. That interaction is only
	// visible across a SEQUENCE of calls, which reconcileCases (one call each) cannot express,
	// and it is exactly where the five ports could silently disagree.
	router := routerTestRouter(t)
	fixture := routerFixture(t)
	for _, testCase := range routerFixtureCases(t, fixture, "reconcileSequenceCases") {
		id := routerStringAt(testCase, "id", "")
		raw := routerListAt(testCase, "steps")
		steps := make([]map[string]any, 0, len(raw))
		for i := 0; i < len(raw); i++ {
			copied := map[string]any{}
			for key, value := range routerContainer(raw[i]) {
				copied[key] = value
			}
			steps = append(steps, copied)
		}
		calls := routerListAt(testCase, "calls")
		expectedScales := routerListAt(testCase, "expectedScales")
		for c := 0; c < len(calls); c++ {
			// the plan is rebuilt from the working steps on every call, exactly as Execute does
			// — PHP copies arrays on assignment, so a plan built once outside this loop would
			// mean five ports running five different tests
			plan := map[string]any{"steps": steps, "reconcileToleranceRatio": routerNumberAt(testCase, "reconcileToleranceRatio", 0)}
			reconciliation, err := router.ReconcileExecutionStep(plan, int(routerNumberAt(calls[c], "stepIndex", 0)), routerNumberAt(calls[c], "realisedOut", 0))
			if err != nil {
				t.Fatalf("reconcileSequenceCase %s call %d: %v", id, c, err)
			}
			if !routerNumbersMatch(routerNumberAt(reconciliation, "scale", 0), routerToNumber(expectedScales[c], math.NaN())) {
				t.Fatalf("reconcileSequenceCase %s call %d: scale %v", id, c, reconciliation["scale"])
			}
			router.applyResize(steps, reconciliation)
		}
		expectedAmounts := routerListAt(testCase, "expectedAmounts")
		for s := 0; s < len(steps); s++ {
			if !routerNumbersMatch(routerNumberAt(steps[s], "amount", 0), routerToNumber(expectedAmounts[s], math.NaN())) {
				t.Fatalf("reconcileSequenceCase %s step %d: amount %v", id, s, steps[s]["amount"])
			}
		}
	}
}
