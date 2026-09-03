// The OrderRouter suite, living in ccxt-base rather than in the ti-rust test crate.
//
// It is here for one practical reason: ti-rust links the whole generated surface
// (104 typed REST wrappers, 76 WS ones), and building that needs more memory
// than some development machines have — it OOM-kills at link time on a 16 GB
// box, the same way the Go test binary does. The suite exercises nothing but
// `Value` and `OrderRouter`, both of which live in THIS crate, so putting it
// here makes it runnable with `cargo test -p ccxt-base` in about a minute
// without the generated venues.
//
// `run()` is public so `ti-rust --orderRouterTests` drives exactly the same
// checks in CI, alongside the other five ports. One harness, two entry points —
// a second copy is how the two would drift.

// OrderRouter — the sixth port's half of the cross-language contract.
//
// The class is hand-written in six languages; `ts/src/test/base/fixtures/
// orderRouter.json` is what stops them drifting. This file runs that fixture in
// Rust. A case that passes in TypeScript, Python, PHP, C# and Go and fails here
// means THIS port is wrong — that is the whole reason for running the same table
// six times rather than trusting six readings of the same spec.

use crate::order_router::{OrderRouter, TOLERANCE};
use crate::value::{HashMap, Value};

fn fixture() -> Result<Value, String> {
    // From this crate's manifest dir: rust/ccxt-base -> repo root.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../ts/src/test/base/fixtures/orderRouter.json"
    );
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("reading the shared fixture at {path}: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parsing the shared fixture: {e}"))?;
    Ok(Value::from_json(&parsed))
}

fn router() -> Result<OrderRouter, String> {
    let mut config = HashMap::new();
    config.insert("apiKey".to_string(), Value::Str("test-key".to_string()));
    OrderRouter::new(&Value::Map(config)).map_err(|e| e.to_string())
}

fn section(fixture: &Value, name: &str) -> Result<Value, String> {
    match fixture.as_map().and_then(|m| m.get(name)) {
        Some(found) => Ok(found.clone()),
        None => Err(format!("the shared fixture has no `{name}` section")),
    }
}

fn cases(fixture: &Value, name: &str) -> Result<Vec<Value>, String> {
    match section(fixture, name)? {
        Value::Arr(items) if !items.is_empty() => Ok(items.as_ref().clone()),
        Value::Arr(_) => Err(format!("the fixture's `{name}` section is empty")),
        _ => Err(format!("the fixture's `{name}` section is not an array")),
    }
}

fn named(fixture: &Value, section_name: &str, key: &str) -> Result<Value, String> {
    let holder = section(fixture, section_name)?;
    match holder.as_map().and_then(|m| m.get(key)) {
        Some(found) => Ok(found.clone()),
        None => Err(format!("`{section_name}` has no entry named `{key}`")),
    }
}

fn text(container: &Value, key: &str) -> String {
    match container.as_map().and_then(|m| m.get(key)) {
        Some(Value::Str(s)) => s.clone(),
        _ => String::new(),
    }
}

fn at<'a>(container: &'a Value, key: &str) -> Option<&'a Value> {
    container.as_map().and_then(|m| m.get(key))
}

/// The same relative comparison the other five ports use: floating point cannot
/// be compared exactly across six languages' arithmetic, and an absolute epsilon
/// is wrong at both ends of the magnitude range a price can take.
fn numbers_match(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    if !a.is_finite() || !b.is_finite() {
        // An infinity only ever matches itself. Without this the relative
        // comparison below reads Infinity <= Infinity as a match, and an
        // infinite value passes against ANY expectation — which is exactly how
        // a number grammar that overflows would slip past the numberCases table.
        return false;
    }
    let mut scale = 1.0f64;
    if a.abs() > scale {
        scale = a.abs();
    }
    if b.abs() > scale {
        scale = b.abs();
    }
    (a - b).abs() <= TOLERANCE * scale
}

fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Int(n) => Some(*n as f64),
        Value::Float(n) => Some(*n),
        _ => None,
    }
}

/// Compares an actual structure against the fixture's expectation, in BOTH
/// directions: a missing field and an invented field are both drift.
fn assert_matches(actual: &Value, expected: &Value, whereat: &str) -> Result<(), String> {
    match expected {
        Value::Arr(expected_items) => {
            let actual_items = match actual {
                Value::Arr(items) => items,
                other => return Err(format!("{whereat}: expected an array, got {other:?}")),
            };
            if actual_items.len() != expected_items.len() {
                return Err(format!(
                    "{whereat}: array length — expected {}, got {}",
                    expected_items.len(),
                    actual_items.len()
                ));
            }
            for (i, expected_item) in expected_items.iter().enumerate() {
                assert_matches(&actual_items[i], expected_item, &format!("{whereat}[{i}]"))?;
            }
            Ok(())
        }
        Value::Dict(expected_map) => {
            let actual_map = match actual {
                Value::Dict(map) => map,
                other => return Err(format!("{whereat}: expected an object, got {other:?}")),
            };
            let mut expected_keys: Vec<&String> = expected_map.keys().collect();
            let mut actual_keys: Vec<&String> = actual_map.keys().collect();
            expected_keys.sort();
            actual_keys.sort();
            if expected_keys != actual_keys {
                return Err(format!(
                    "{whereat}: key set — expected {expected_keys:?}, got {actual_keys:?}"
                ));
            }
            for key in expected_keys {
                assert_matches(
                    actual_map.get(key).unwrap_or(&Value::Null),
                    expected_map.get(key).unwrap_or(&Value::Null),
                    &format!("{whereat}.{key}"),
                )?;
            }
            Ok(())
        }
        _ => {
            if let Some(expected_number) = as_number(expected) {
                let actual_number = as_number(actual).ok_or_else(|| {
                    format!("{whereat}: expected the number {expected_number}, got {actual:?}")
                })?;
                if !numbers_match(actual_number, expected_number) {
                    return Err(format!(
                        "{whereat}: expected {expected_number}, got {actual_number}"
                    ));
                }
                return Ok(());
            }
            if actual != expected {
                return Err(format!("{whereat}: expected {expected:?}, got {actual:?}"));
            }
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// the shared fixture — the cross-language contract
// ---------------------------------------------------------------------------

fn fixture_build_execution_plan(r: &OrderRouter, f: &Value) -> Result<(), String> {
    for test_case in cases(f, "planCases")? {
        let route = named(f, "routes", &text(&test_case, "route"))?;
        let options = at(&test_case, "options").cloned().unwrap_or(Value::Null);
        let plan = r.build_execution_plan(&route, &options).map_err(|e| e.to_string())?;
        let expected = at(&test_case, "expected").cloned().unwrap_or(Value::Null);
        assert_matches(&plan, &expected, &format!("planCase {}", text(&test_case, "id")))?;
    }
    Ok(())
}

fn fixture_plan_is_deterministic(r: &OrderRouter, f: &Value) -> Result<(), String> {
    for test_case in cases(f, "planCases")? {
        let route = named(f, "routes", &text(&test_case, "route"))?;
        let options = at(&test_case, "options").cloned().unwrap_or(Value::Null);
        let before = serde_json::to_string(&route.to_json()).map_err(|e| e.to_string())?;
        let first = r.build_execution_plan(&route, &options).map_err(|e| e.to_string())?;
        let second = r.build_execution_plan(&route, &options).map_err(|e| e.to_string())?;
        let id = text(&test_case, "id");
        assert_matches(&second, &first, &format!("planCase {id} repeated"))?;
        let after = serde_json::to_string(&route.to_json()).map_err(|e| e.to_string())?;
        if before != after {
            return Err(format!("planCase {id}: the route was mutated"));
        }
    }
    Ok(())
}

fn fixture_check_execution_plan_safety(r: &OrderRouter, f: &Value) -> Result<(), String> {
    for test_case in cases(f, "safetyCases")? {
        let route = named(f, "routes", &text(&test_case, "route"))?;
        let markets = named(f, "marketSets", &text(&test_case, "markets"))?;
        let plan_options = at(&test_case, "planOptions").cloned().unwrap_or(Value::Null);
        let options = at(&test_case, "options").cloned().unwrap_or(Value::Null);
        let plan = r.build_execution_plan(&route, &plan_options).map_err(|e| e.to_string())?;
        let violations = r.check_execution_plan_safety(&plan, &markets, &options);
        let expected = at(&test_case, "expected").cloned().unwrap_or(Value::Null);
        assert_matches(
            &Value::List(violations),
            &expected,
            &format!("safetyCase {}", text(&test_case, "id")),
        )?;
    }
    Ok(())
}

fn fixture_reconcile_execution_step(r: &OrderRouter, f: &Value) -> Result<(), String> {
    for test_case in cases(f, "reconcileCases")? {
        // A case names either a route to plan from, or a plan written out in
        // full — the latter is how a plan with field types no builder produces
        // (an int hopIndex on one step and a float on the next) gets covered.
        let plan = if at(&test_case, "plan").is_some() {
            named(f, "plans", &text(&test_case, "plan"))?
        } else {
            let route = named(f, "routes", &text(&test_case, "route"))?;
            let plan_options = at(&test_case, "planOptions").cloned().unwrap_or(Value::Null);
            r.build_execution_plan(&route, &plan_options).map_err(|e| e.to_string())?
        };
        let step_index = r.number_at(&test_case, "stepIndex", 0.0) as i64;
        let realised_out = r.number_at(&test_case, "realisedOut", 0.0);
        let verdict = r
            .reconcile_execution_step(&plan, step_index, realised_out)
            .map_err(|e| e.to_string())?;
        let expected = at(&test_case, "expected").cloned().unwrap_or(Value::Null);
        assert_matches(&verdict, &expected, &format!("reconcileCase {}", text(&test_case, "id")))?;
    }
    Ok(())
}

fn fixture_reconcile_sequence(r: &OrderRouter, f: &Value) -> Result<(), String> {
    // reconcile_execution_step is pure and cannot remember across calls, so a
    // hop's cumulative shortfall lives on the steps themselves — written by
    // apply_resize. That interaction is only visible across a SEQUENCE of calls,
    // which reconcileCases (one call each) cannot express, and it is exactly
    // where the six ports could silently disagree.
    for test_case in cases(f, "reconcileSequenceCases")? {
        let id = text(&test_case, "id");
        let mut steps: Vec<Value> = match at(&test_case, "steps") {
            Some(Value::Arr(items)) => items.as_ref().clone(),
            _ => return Err(format!("reconcileSequenceCase {id}: no steps")),
        };
        let tolerance = r.number_at(&test_case, "reconcileToleranceRatio", 0.0);
        let calls = match at(&test_case, "calls") {
            Some(Value::Arr(items)) => items.as_ref().clone(),
            _ => Vec::new(),
        };
        let expected_scales = match at(&test_case, "expectedScales") {
            Some(Value::Arr(items)) => items.as_ref().clone(),
            _ => Vec::new(),
        };
        for (index, call) in calls.iter().enumerate() {
            // The plan is rebuilt from the working steps on every call, exactly
            // as execute does — PHP copies arrays on assignment, so a plan built
            // once outside this loop would mean six ports running six different
            // tests.
            let mut plan = HashMap::new();
            plan.insert("steps".to_string(), Value::List(steps.clone()));
            plan.insert("reconcileToleranceRatio".to_string(), Value::Float(tolerance));
            let plan = Value::Map(plan);
            let step_index = r.number_at(call, "stepIndex", 0.0) as i64;
            let realised_out = r.number_at(call, "realisedOut", 0.0);
            let reconciliation = r
                .reconcile_execution_step(&plan, step_index, realised_out)
                .map_err(|e| e.to_string())?;
            let scale = r.number_at(&reconciliation, "scale", f64::NAN);
            let expected = as_number(&expected_scales[index]).unwrap_or(f64::NAN);
            if !numbers_match(scale, expected) {
                return Err(format!(
                    "reconcileSequenceCase {id} call {index}: scale — expected {expected}, got {scale}"
                ));
            }
            r.apply_resize(&mut steps, &reconciliation);
        }
        let expected_amounts = match at(&test_case, "expectedAmounts") {
            Some(Value::Arr(items)) => items.as_ref().clone(),
            _ => Vec::new(),
        };
        for (index, step) in steps.iter().enumerate() {
            let amount = r.number_at(step, "amount", f64::NAN);
            let expected = as_number(&expected_amounts[index]).unwrap_or(f64::NAN);
            if !numbers_match(amount, expected) {
                return Err(format!(
                    "reconcileSequenceCase {id} step {index}: amount — expected {expected}, got {amount}"
                ));
            }
        }
    }
    Ok(())
}

fn fixture_build_unwind_plan(r: &OrderRouter, f: &Value) -> Result<(), String> {
    for test_case in cases(f, "unwindCases")? {
        let report = named(f, "reports", &text(&test_case, "report"))?;
        let unwind = r.build_unwind_plan(&report);
        let expected = at(&test_case, "expected").cloned().unwrap_or(Value::Null);
        assert_matches(&unwind, &expected, &format!("unwindCase {}", text(&test_case, "id")))?;
    }
    Ok(())
}

fn fixture_number_at(r: &OrderRouter, f: &Value) -> Result<(), String> {
    // Every port hand-implements JavaScript's parseFloat prefix grammar rather
    // than calling its own parser, because every language's own parser disagrees
    // with the others somewhere. These cases are the contract: a cap read as
    // 1234.5 in one language and 1 in another is a cap that silently disappears,
    // and this table is what stops that shipping green.
    for test_case in cases(f, "numberCases")? {
        let container = at(&test_case, "container").cloned().unwrap_or(Value::Null);
        let key = text(&test_case, "key");
        let default_value = r.number_at(&test_case, "default", 0.0);
        let actual = r.number_at(&container, &key, default_value);
        let expected = at(&test_case, "expected")
            .and_then(as_number)
            .ok_or_else(|| format!("numberCase {}: no expected number", text(&test_case, "id")))?;
        if !numbers_match(actual, expected) {
            return Err(format!(
                "numberCase {}: expected {expected}, got {actual}",
                text(&test_case, "id")
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// invariants, asserted directly rather than through the fixture
// ---------------------------------------------------------------------------

fn config_with(entries: &[(&str, Value)]) -> Value {
    let mut config = HashMap::new();
    for (key, value) in entries {
        config.insert((*key).to_string(), value.clone());
    }
    Value::Map(config)
}

fn constructor_guards() -> Result<(), String> {
    // The cap is a hard rule, not a preference.
    if OrderRouter::new(&config_with(&[])).is_ok() {
        return Err("an apiKey is required".to_string());
    }
    let raised = config_with(&[
        ("apiKey", Value::Str("k".into())),
        ("maxNotionalUsd", Value::Float(25.01)),
    ]);
    if OrderRouter::new(&raised).is_ok() {
        return Err("the cap may not be raised".to_string());
    }
    let zero = config_with(&[
        ("apiKey", Value::Str("k".into())),
        ("maxNotionalUsd", Value::Float(0.0)),
    ]);
    if OrderRouter::new(&zero).is_ok() {
        return Err("the cap must be positive".to_string());
    }
    let lowered = config_with(&[
        ("apiKey", Value::Str("k".into())),
        ("maxNotionalUsd", Value::Float(5.0)),
    ]);
    let client = OrderRouter::new(&lowered).map_err(|e| e.to_string())?;
    if client.max_notional_usd() != 5.0 {
        return Err("the cap may be lowered".to_string());
    }
    // Trailing slashes are stripped so the url is built the same way in six
    // languages.
    let slashed = config_with(&[
        ("apiKey", Value::Str("k".into())),
        ("baseUrl", Value::Str("https://example.test/router///".into())),
    ]);
    let client = OrderRouter::new(&slashed).map_err(|e| e.to_string())?;
    if client.base_url() != "https://example.test/router" {
        return Err(format!("trailing slashes are stripped, got {}", client.base_url()));
    }
    Ok(())
}

fn one_leg_route(side: &str, base_code: &str, quote: &str, amount: f64, price: f64) -> Value {
    let mut leg = HashMap::new();
    leg.insert("exchangeId".to_string(), Value::Str("stub".into()));
    leg.insert("amount".to_string(), Value::Float(amount));
    leg.insert("averagePrice".to_string(), Value::Float(price));
    leg.insert("effectivePrice".to_string(), Value::Float(price));
    let mut hop = HashMap::new();
    hop.insert("pair".to_string(), Value::Str(format!("{base_code}/{quote}")));
    hop.insert("side".to_string(), Value::Str(side.into()));
    hop.insert("base".to_string(), Value::Str(base_code.into()));
    hop.insert("quote".to_string(), Value::Str(quote.into()));
    hop.insert("legs".to_string(), Value::List(vec![Value::Map(leg)]));
    let mut route = HashMap::new();
    route.insert("from".to_string(), Value::Str(quote.into()));
    route.insert("to".to_string(), Value::Str(base_code.into()));
    route.insert("strategy".to_string(), Value::Str("best_single".into()));
    route.insert("exactSide".to_string(), Value::Str("in".into()));
    route.insert("fullyFillable".to_string(), Value::Bool(true));
    route.insert("fillRatio".to_string(), Value::Float(1.0));
    route.insert("hops".to_string(), Value::List(vec![Value::Map(hop)]));
    Value::Map(route)
}

fn limit_price_side(r: &OrderRouter) -> Result<(), String> {
    // The limit sits on the side that costs you, and only there.
    let options = config_with(&[("slippageBps", Value::Float(100.0))]);
    let buy = r
        .build_execution_plan(&one_leg_route("buy", "BTC", "USDT", 1.0, 100.0), &options)
        .map_err(|e| e.to_string())?;
    let buy_steps = r.list_at(&buy, "steps");
    let buy_limit = r.number_at(&buy_steps[0], "limitPrice", 0.0);
    if !numbers_match(buy_limit, 101.0) {
        return Err(format!("a buy limit sits ABOVE the expected price, got {buy_limit}"));
    }
    let sell = r
        .build_execution_plan(&one_leg_route("sell", "BTC", "USDT", 1.0, 100.0), &options)
        .map_err(|e| e.to_string())?;
    let sell_steps = r.list_at(&sell, "steps");
    let sell_limit = r.number_at(&sell_steps[0], "limitPrice", 0.0);
    if !numbers_match(sell_limit, 99.0) {
        return Err(format!("a sell limit sits BELOW the expected price, got {sell_limit}"));
    }
    Ok(())
}

fn empty_plan_is_not_safe(r: &OrderRouter) -> Result<(), String> {
    // "Nothing to check" and "checked, all good" are different answers and used
    // to look identical.
    let mut plan = HashMap::new();
    plan.insert("steps".to_string(), Value::List(vec![]));
    let violations = r.check_execution_plan_safety(
        &Value::Map(plan),
        &Value::Map(HashMap::new()),
        &Value::Map(HashMap::new()),
    );
    if violations.len() != 1 {
        return Err(format!("an empty plan yields one finding, got {}", violations.len()));
    }
    if text(&violations[0], "code") != "empty_plan" {
        return Err("an empty plan is flagged empty_plan".to_string());
    }
    Ok(())
}

fn usdt_is_not_a_dollar(r: &OrderRouter) -> Result<(), String> {
    // A stablecoin peg is an empirical fact, not a definition. With no rate
    // supplied, a USDT-quoted step cannot be valued and must BLOCK.
    let plan = r
        .build_execution_plan(&one_leg_route("buy", "BTC", "USDT", 0.001, 100.0), &Value::Null)
        .map_err(|e| e.to_string())?;
    let mut market = HashMap::new();
    market.insert("symbol".to_string(), Value::Str("BTC/USDT".into()));
    market.insert("base".to_string(), Value::Str("BTC".into()));
    market.insert("quote".to_string(), Value::Str("USDT".into()));
    let mut venue = HashMap::new();
    venue.insert("BTC/USDT".to_string(), Value::Map(market));
    let mut markets = HashMap::new();
    markets.insert("stub".to_string(), Value::Map(venue));
    let violations =
        r.check_execution_plan_safety(&plan, &Value::Map(markets), &Value::Map(HashMap::new()));
    let blocked = violations
        .iter()
        .any(|v| text(v, "code") == "notional_unvaluable" && r.bool_at(v, "blocking", false));
    if !blocked {
        return Err("an unvaluable step BLOCKS rather than being skipped".to_string());
    }
    Ok(())
}

fn refuses_incoherent_routes(r: &OrderRouter) -> Result<(), String> {
    // build_execution_plan used to copy from, to, pair and side straight out of
    // the server's JSON, so a compromised — or simply buggy — router response
    // could steer real orders into any real market and every check would pass
    // it. The client now checks the answer against its OWN record of the
    // question.
    let mut route = one_leg_route("buy", "BTC", "USDT", 0.1, 100.0);
    OrderRouter::set_key(&mut route, "clientRequestedFrom", Value::Str("USDT".into()));
    OrderRouter::set_key(&mut route, "clientRequestedTo", Value::Str("ETH".into()));
    match r.build_execution_plan(&route, &Value::Null) {
        Ok(_) => return Err("a route that produces the wrong asset is refused".to_string()),
        Err(e) => {
            if !e.message.contains("produces BTC, not the requested ETH") {
                return Err(format!("wrong refusal for a produces mismatch: {e}"));
            }
        }
    }
    let mut route = one_leg_route("buy", "BTC", "USDT", 0.1, 100.0);
    OrderRouter::set_key(&mut route, "clientRequestedFrom", Value::Str("EUR".into()));
    OrderRouter::set_key(&mut route, "clientRequestedTo", Value::Str("BTC".into()));
    match r.build_execution_plan(&route, &Value::Null) {
        Ok(_) => return Err("a route that spends an unoffered asset is refused".to_string()),
        Err(e) => {
            if !e.message.contains("spends USDT, not the requested EUR") {
                return Err(format!("wrong refusal for a spends mismatch: {e}"));
            }
        }
    }
    // A well-formed route still plans.
    let mut route = one_leg_route("buy", "BTC", "USDT", 0.1, 100.0);
    OrderRouter::set_key(&mut route, "clientRequestedFrom", Value::Str("USDT".into()));
    OrderRouter::set_key(&mut route, "clientRequestedTo", Value::Str("BTC".into()));
    let plan = r.build_execution_plan(&route, &Value::Null).map_err(|e| e.to_string())?;
    if r.list_at(&plan, "steps").len() != 1 {
        return Err("a coherent route still plans".to_string());
    }
    Ok(())
}

fn format_number_never_uses_exponents(r: &OrderRouter) -> Result<(), String> {
    for probe in [0.0000001f64, 1234.5, 0.1, 1e17] {
        let rendered = r.format_number(probe).map_err(|e| e.to_string())?;
        if rendered.contains('e') || rendered.contains('E') {
            return Err(format!("format_number emitted an exponent for {probe}: {rendered}"));
        }
    }
    if r.format_number(0.0).map_err(|e| e.to_string())? != "0" {
        return Err("zero renders as 0".to_string());
    }
    // A magnitude no real amount reaches, where the six languages stop agreeing.
    if r.format_number(1e18).is_ok() {
        return Err("a number too large to render identically is refused".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/// Runs the OrderRouter suite. Returns the number of checks that passed.
pub fn run() -> Result<usize, String> {
    let f = fixture()?;
    let r = router()?;
    let mut passed = 0usize;
    let checks: Vec<(&str, Box<dyn Fn() -> Result<(), String>>)> = vec![
        ("fixture: buildExecutionPlan", Box::new(|| fixture_build_execution_plan(&router()?, &fixture()?))),
        ("fixture: buildExecutionPlan is deterministic and does not mutate its input", Box::new(|| fixture_plan_is_deterministic(&router()?, &fixture()?))),
        ("fixture: checkExecutionPlanSafety", Box::new(|| fixture_check_execution_plan_safety(&router()?, &fixture()?))),
        ("fixture: reconcileExecutionStep", Box::new(|| fixture_reconcile_execution_step(&router()?, &fixture()?))),
        ("fixture: a sequence of reconciliations on one hop", Box::new(|| fixture_reconcile_sequence(&router()?, &fixture()?))),
        ("fixture: buildUnwindPlan", Box::new(|| fixture_build_unwind_plan(&router()?, &fixture()?))),
        ("fixture: numberAt reads one number grammar in all six languages", Box::new(|| fixture_number_at(&router()?, &fixture()?))),
        ("constructor: apiKey is required and the 25 USD cap may be lowered but never raised", Box::new(constructor_guards)),
        ("the limit price sits on the side that costs you, and only there", Box::new(|| limit_price_side(&router()?))),
        ("an empty plan is not a safe plan", Box::new(|| empty_plan_is_not_safe(&router()?))),
        ("USDT is not assumed to be one dollar", Box::new(|| usdt_is_not_a_dollar(&router()?))),
        ("a route that does not match the question asked is refused", Box::new(|| refuses_incoherent_routes(&router()?))),
        ("formatNumber never emits exponent notation", Box::new(|| format_number_never_uses_exponents(&router()?))),
    ];
    let _ = (&f, &r);
    for (name, check) in checks {
        match check() {
            Ok(()) => {
                println!("ok   {name}");
                passed += 1;
            }
            Err(message) => return Err(format!("{name} — {message}")),
        }
    }
    Ok(passed)
}


#[cfg(test)]
mod tests {
    /// The whole cross-language contract, runnable without the generated
    /// exchange surface. `cargo test -p ccxt-base`.
    #[test]
    fn order_router_matches_the_shared_fixture() {
        match super::run() {
            Ok(passed) => assert!(passed > 0, "the suite ran no checks"),
            Err(message) => panic!("{message}"),
        }
    }
}
