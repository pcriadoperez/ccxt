// Native Rust — hand-written client for the CCXT order-router service.
//
// This is the SIXTH port of a class that is hand-written, not transpiled: the
// TypeScript reference lives in `ts/src/base/OrderRouter.ts`, and Python, PHP,
// C# and Go carry line-for-line siblings. They are held together by one shared
// fixture, `ts/src/test/base/fixtures/orderRouter.json`, which every port runs.
// A change to any of them that this port does not match fails that fixture, in
// this language, which is the entire point of writing it out again rather than
// generating it.
//
// Two things about Rust make the port read differently from its siblings while
// meaning the same thing, and both are load-bearing:
//
//   * The other five pass dictionaries of `any`. Here that is `Value`, which is
//     the same shape (`Value::Dict(Arc<IndexMap<String, Value>>)`) — so the
//     accessors below are genuine equivalents of `numberAt`/`stringAt`/… and
//     not a re-design.
//   * The other five throw. Here the fallible methods return
//     `Result<_, ExchangeError>`. `ExchangeError::kind` carries the same class
//     names the other ports throw, so `is("NetworkError")` answers the same
//     question `isOutcomeUnknownError` asks there.

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::error::ExchangeError;
use crate::value::{HashMap, Value};

/// Result of a fallible router operation. The error's `kind` matches the
/// exception class the other five ports raise for the same condition.
pub type RouterResult<T> = std::result::Result<T, ExchangeError>;

fn arguments_required(message: &str) -> ExchangeError {
    ExchangeError::new("ArgumentsRequired", message)
}

fn bad_request(message: &str) -> ExchangeError {
    ExchangeError::new("BadRequest", message)
}

fn exchange_error(message: &str) -> ExchangeError {
    ExchangeError::new("ExchangeError", message)
}

/// The per-trade USD notional ceiling. A hard rule, not a preference: it may be
/// lowered in the constructor and never raised. See CLAUDE.md §5.5.
pub const MAX_NOTIONAL_USD: f64 = 25.0;
/// Default distance from the expected price at which the limit is placed.
pub const DEFAULT_SLIPPAGE_BPS: f64 = 25.0;
/// Default shortfall ratio at which `reconcile_execution_step` halts.
pub const DEFAULT_RECONCILE_TOLERANCE: f64 = 0.02;
/// Fill comparisons treat anything within this of the requested amount as full.
pub const TOLERANCE: f64 = 0.0001;
const DEFAULT_BASE_URL: &str = "https://docs.ccxt.com/router/api";
const DEFAULT_TIMEOUT_MS: f64 = 30000.0;

/// A client for the CCXT order-router service.
pub struct OrderRouter {
    api_key: String,
    base_url: String,
    timeout_ms: f64,
    max_notional_usd: f64,
}

// ---------------------------------------------------------------------------
// container accessors
//
// Every port has these; they exist so the six implementations read line for
// line, and so a missing key is never a language-specific crash.
// ---------------------------------------------------------------------------

/// Plain container read: the field if the container is a dict and the field is
/// present and not null, `None` otherwise. Deliberately NOT `get_value_k`, which
/// also routes shared-order-book meta keys and live-client lookups — this class
/// reads inert JSON structures, and picking up those side effects would make the
/// accessors mean something the other five ports' accessors do not.
fn field<'a>(container: &'a Value, key: &str) -> Option<&'a Value> {
    match container.as_map().and_then(|map| map.get(key)) {
        Some(Value::Null) | None => None,
        found => found,
    }
}

impl OrderRouter {
    /// Reads a numeric field, with a default for missing, null and unparseable
    /// values.
    pub fn number_at(&self, container: &Value, key: &str, default_value: f64) -> f64 {
        Self::number_of(field(container, key), default_value)
    }

    fn number_of(value: Option<&Value>, default_value: f64) -> f64 {
        match value {
            None | Some(Value::Null) => default_value,
            // NaN and the infinities are not numbers this class will act on. An
            // infinite tolerance silently disables the halt verdict and an
            // infinite rate silently disables the cap, and "the default" is the
            // only answer six languages can agree on for either.
            Some(Value::Int(n)) => {
                let as_float = *n as f64;
                if Self::is_finite_number(as_float) { as_float } else { default_value }
            }
            Some(Value::Float(n)) => {
                if Self::is_finite_number(*n) { *n } else { default_value }
            }
            Some(Value::Str(text)) => Self::parse_number_text(text, default_value),
            _ => default_value,
        }
    }

    /// Reports whether a double is a real number, i.e. neither NaN nor an
    /// infinity.
    pub fn is_finite_number(value: f64) -> bool {
        // The one NaN test that needs no library in any of the six.
        if value != value {
            return false;
        }
        if value > 1.7976931348623157e308 || value < -1.7976931348623157e308 {
            return false;
        }
        true
    }

    /// Reads the leading numeric prefix of a string exactly as JavaScript's
    /// `parseFloat` does, returning the default when there is not one or when
    /// the result is not finite.
    pub fn parse_number(&self, text: &str, default_value: f64) -> f64 {
        Self::parse_number_text(text, default_value)
    }

    fn parse_number_text(text: &str, default_value: f64) -> f64 {
        // Hand-rolled rather than delegated to the language's own parser,
        // because every language's own parser disagrees with the others
        // somewhere: Python reads '1_000' as 1000 and '1,234.5' not at all, PHP
        // and Go read '0x10' as 0 only by accident of their regex, C# trims
        // Unicode whitespace JavaScript does not, and Rust's own `f64::from_str`
        // accepts "inf"/"NaN" and rejects any trailing text at all. The grammar
        // below is JavaScript's StrDecimalLiteral prefix over the ASCII
        // whitespace set, and it is the SAME twenty lines in all six ports.
        //
        // Indexed over BYTES, not chars: every character the grammar accepts is
        // ASCII, and a multi-byte character can only ever end the scan.
        let bytes = text.as_bytes();
        let mut cursor = 0usize;
        while cursor < bytes.len() && Self::is_router_space(bytes[cursor]) {
            cursor += 1;
        }
        let start = cursor;
        if cursor < bytes.len() && (bytes[cursor] == b'+' || bytes[cursor] == b'-') {
            cursor += 1;
        }
        let mut digits = 0usize;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
            digits += 1;
        }
        if cursor < bytes.len() && bytes[cursor] == b'.' {
            cursor += 1;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
                digits += 1;
            }
        }
        if digits == 0 {
            // 'Infinity', 'inf', 'NaN', '' and '٠١' all land here, in all six.
            return default_value;
        }
        let mut end = cursor;
        if cursor < bytes.len() && (bytes[cursor] == b'e' || bytes[cursor] == b'E') {
            let mut exponent = cursor + 1;
            if exponent < bytes.len() && (bytes[exponent] == b'+' || bytes[exponent] == b'-') {
                exponent += 1;
            }
            let mut exponent_digits = 0usize;
            while exponent < bytes.len() && bytes[exponent].is_ascii_digit() {
                exponent += 1;
                exponent_digits += 1;
            }
            if exponent_digits > 0 {
                // A trailing 'e' with no digits is not part of the number: JS
                // reads '1e' as 1, and so does every port here.
                end = exponent;
            }
        }
        let slice = &text[start..end];
        match slice.parse::<f64>() {
            // '1e400' overflows to an infinity, which is not a number the cap or
            // the tolerance may be built out of.
            Ok(parsed) if Self::is_finite_number(parsed) => parsed,
            _ => default_value,
        }
    }

    /// Reports whether a byte is one of the six ASCII spaces the number grammar
    /// skips.
    fn is_router_space(character: u8) -> bool {
        // Deliberately NOT the language's own is_whitespace: Python, PHP, C#,
        // Go and Rust each draw the Unicode line in a different place, and a
        // non-breaking space that parses in one language and not the others is
        // drift.
        character == b' '
            || character == b'\t'
            || character == b'\n'
            || character == b'\r'
            || character == 0x0c
            || character == 0x0b
    }

    /// Reads a string field, with a default for missing and null values.
    pub fn string_at(&self, container: &Value, key: &str, default_value: &str) -> String {
        match field(container, key) {
            Some(Value::Str(text)) => text.clone(),
            _ => default_value.to_string(),
        }
    }

    /// Reads a boolean field, with a default for missing and null values.
    pub fn bool_at(&self, container: &Value, key: &str, default_value: bool) -> bool {
        match field(container, key) {
            Some(Value::Bool(flag)) => *flag,
            _ => default_value,
        }
    }

    /// Reads an array field, returning an empty vector when absent. Never None,
    /// for the same reason `listAt` never returns undefined.
    pub fn list_at(&self, container: &Value, key: &str) -> Vec<Value> {
        match field(container, key) {
            Some(Value::Arr(items)) => items.as_ref().clone(),
            _ => Vec::new(),
        }
    }

    /// Reads a nested dictionary, returning an empty one when absent.
    pub fn dict_at(&self, container: &Value, key: &str) -> Value {
        match field(container, key) {
            Some(Value::Dict(map)) => Value::Dict(Arc::clone(map)),
            _ => Value::Map(HashMap::new()),
        }
    }

    /// Formats a double as decimal text with no exponent, so that six languages
    /// produce the same string.
    pub fn format_number(&self, value: f64) -> RouterResult<String> {
        // JavaScript prints 1e-7 where Python prints 1e-07 and Go prints 1e-07;
        // a fixed 12-decimal rendering with the trailing zeros trimmed is the
        // one spelling all six languages agree on for the magnitudes a balance
        // or an amount can take.
        if !Self::is_finite_number(value) {
            return Ok("0".to_string());
        }
        if value.abs() >= 1e18 {
            // JavaScript's toFixed switches to exponent notation at 1e21 while
            // the other languages never do. Rather than let one language send a
            // different string than the others, refuse — loudly, and at a
            // magnitude no real amount reaches.
            return Err(bad_request(
                "OrderRouter: a number this large cannot be rendered identically in all six languages",
            ));
        }
        let mut text = format!("{:.12}", value);
        if text.contains('.') {
            while text.ends_with('0') {
                text.pop();
            }
            if text.ends_with('.') {
                text.pop();
            }
        }
        if text.is_empty() || text == "-" || text == "-0" {
            return Ok("0".to_string());
        }
        Ok(text)
    }
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

impl OrderRouter {
    /// Creates a client for the CCXT order-router service.
    ///
    /// `config` keys: `apiKey` (required), `baseUrl`, `timeoutMs`,
    /// `maxNotionalUsd` (may be LOWERED below the hard 25 USD cap, never
    /// raised).
    pub fn new(config: &Value) -> RouterResult<Self> {
        // Constructed through a temporary so the accessors — which are methods,
        // exactly as in the other five ports — are available while reading the
        // config that builds the real one.
        let reader = OrderRouter {
            api_key: String::new(),
            base_url: String::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_notional_usd: MAX_NOTIONAL_USD,
        };
        let api_key = reader.string_at(config, "apiKey", "");
        if api_key.is_empty() {
            return Err(arguments_required("OrderRouter requires an apiKey"));
        }
        let mut base_url = reader.string_at(config, "baseUrl", DEFAULT_BASE_URL);
        while base_url.ends_with('/') {
            base_url.pop();
        }
        let timeout_ms = reader.number_at(config, "timeoutMs", DEFAULT_TIMEOUT_MS);
        let max_notional_usd = reader.number_at(config, "maxNotionalUsd", MAX_NOTIONAL_USD);
        if max_notional_usd > MAX_NOTIONAL_USD {
            // The cap is a hard rule, not a preference; raising it is refused.
            return Err(bad_request(
                "OrderRouter maxNotionalUsd may not exceed the hard 25 USD per-trade cap",
            ));
        }
        if max_notional_usd <= 0.0 {
            return Err(bad_request("OrderRouter maxNotionalUsd must be positive"));
        }
        Ok(OrderRouter { api_key, base_url, timeout_ms, max_notional_usd })
    }

    /// The per-trade USD notional ceiling this client will enforce.
    pub fn max_notional_usd(&self) -> f64 {
        self.max_notional_usd
    }

    /// The router base url, with any trailing slashes removed.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The configured request timeout, in milliseconds.
    pub fn timeout_ms(&self) -> f64 {
        self.timeout_ms
    }
}

// ---------------------------------------------------------------------------
// PURE: build_execution_plan
// ---------------------------------------------------------------------------

impl OrderRouter {
    /// Refuses a route whose hops do not connect, or that does not run from the
    /// asset the caller offered to the asset the caller wanted.
    ///
    /// `build_execution_plan` used to copy `from`, `to`, `pair` and `side`
    /// straight out of the server's JSON, and the safety checks only tested
    /// internal consistency against whatever market that named — so a
    /// compromised, or simply buggy, router response could steer real orders
    /// into any real market and every check would pass it, under the 25 USD cap.
    pub fn assert_route_chain_is_coherent(&self, route: &Value, hops: &[Value]) -> RouterResult<()> {
        if hops.is_empty() {
            return Ok(());
        }
        let mut carried = String::new();
        for (index, hop) in hops.iter().enumerate() {
            let side = self.string_at(hop, "side", "").to_lowercase();
            let base_code = self.string_at(hop, "base", "").to_uppercase();
            let quote = self.string_at(hop, "quote", "").to_uppercase();
            if base_code.is_empty() || quote.is_empty() || (side != "buy" && side != "sell") {
                return Err(exchange_error(&format!(
                    "OrderRouter: hop {index} does not name a market and a side"
                )));
            }
            // A buy spends the quote to acquire the base; a sell is the reverse.
            let spends = if side == "buy" { quote.clone() } else { base_code.clone() };
            let produces = if side == "buy" { base_code } else { quote };
            if index > 0 && spends != carried {
                // Hop N+1 must spend exactly what hop N produced, or the plan
                // strands the proceeds of one order and funds the next from a
                // wallet nobody checked.
                return Err(exchange_error(&format!(
                    "OrderRouter: hop {index} spends {spends} but the previous hop produced {carried}"
                )));
            }
            if index == 0 {
                let requested_from = self.string_at(route, "clientRequestedFrom", "");
                if !requested_from.is_empty() && spends != requested_from {
                    return Err(exchange_error(&format!(
                        "OrderRouter: the route spends {spends}, not the requested {requested_from}"
                    )));
                }
            }
            carried = produces;
        }
        let requested_to = self.string_at(route, "clientRequestedTo", "");
        if !requested_to.is_empty() && carried != requested_to {
            return Err(exchange_error(&format!(
                "OrderRouter: the route produces {carried}, not the requested {requested_to}"
            )));
        }
        Ok(())
    }

    /// Turns a RouteResult into an ordered list of concrete orders. PURE — no
    /// I/O, and the same input produces the same output in all six languages.
    ///
    /// `options` keys: `slippageBps` (default 25) and `reconcileToleranceRatio`
    /// (default 0.02).
    pub fn build_execution_plan(&self, route: &Value, options: &Value) -> RouterResult<Value> {
        let slippage_bps = self.number_at(options, "slippageBps", DEFAULT_SLIPPAGE_BPS);
        let tolerance = self.number_at(options, "reconcileToleranceRatio", DEFAULT_RECONCILE_TOLERANCE);
        let hops = self.list_at(route, "hops");
        self.assert_route_chain_is_coherent(route, &hops)?;
        let mut steps: Vec<Value> = Vec::new();
        let mut step_index = 0i64;
        for (hop_index, hop) in hops.iter().enumerate() {
            let symbol = self.string_at(hop, "pair", "");
            let side = self.string_at(hop, "side", "");
            let base_code = self.string_at(hop, "base", "");
            let quote = self.string_at(hop, "quote", "");
            let legs = self.list_at(hop, "legs");
            for (leg_index, leg) in legs.iter().enumerate() {
                // Leg amounts are always in BASE units, on both sides of the
                // market — see the router's RoutingQuote.filledAmount contract.
                let amount = self.number_at(leg, "amount", 0.0);
                let expected_price = self.number_at(leg, "averagePrice", 0.0);
                let effective_price = self.number_at(leg, "effectivePrice", expected_price);
                // The limit sits on the side that costs you: above for a buy,
                // below for a sell.
                let limit_price = if side == "buy" {
                    expected_price * (1.0 + slippage_bps / 10000.0)
                } else {
                    expected_price * (1.0 - slippage_bps / 10000.0)
                };
                let mut step = HashMap::new();
                step.insert("stepIndex".into(), Value::Float(step_index as f64));
                step.insert("hopIndex".into(), Value::Float(hop_index as f64));
                step.insert("legIndex".into(), Value::Float(leg_index as f64));
                step.insert("exchangeId".into(), Value::Str(self.string_at(leg, "exchangeId", "")));
                step.insert("symbol".into(), Value::Str(symbol.clone()));
                step.insert("side".into(), Value::Str(side.clone()));
                step.insert("base".into(), Value::Str(base_code.clone()));
                step.insert("quote".into(), Value::Str(quote.clone()));
                step.insert("amount".into(), Value::Float(amount));
                step.insert("expectedPrice".into(), Value::Float(expected_price));
                step.insert("effectivePrice".into(), Value::Float(effective_price));
                step.insert("limitPrice".into(), Value::Float(limit_price));
                step.insert("notionalQuote".into(), Value::Float(amount * expected_price));
                steps.push(Value::Map(step));
                step_index += 1;
            }
        }
        let mut plan = HashMap::new();
        plan.insert("requestId".into(), Value::Str(self.string_at(route, "requestId", "")));
        plan.insert("calculatedAt".into(), Value::Float(self.number_at(route, "calculatedAt", 0.0)));
        plan.insert("from".into(), Value::Str(self.string_at(route, "from", "")));
        plan.insert("to".into(), Value::Str(self.string_at(route, "to", "")));
        plan.insert("routingStrategy".into(), Value::Str(self.string_at(route, "strategy", "")));
        plan.insert("exactSide".into(), Value::Str(self.string_at(route, "exactSide", "")));
        plan.insert("amountIn".into(), Value::Float(self.number_at(route, "amountIn", 0.0)));
        plan.insert("amountOut".into(), Value::Float(self.number_at(route, "amountOut", 0.0)));
        plan.insert("fullyFillable".into(), Value::Bool(self.bool_at(route, "fullyFillable", false)));
        plan.insert("fillRatio".into(), Value::Float(self.number_at(route, "fillRatio", 0.0)));
        plan.insert("unroutableReason".into(), Value::Str(self.string_at(route, "unroutableReason", "")));
        plan.insert("hopCount".into(), Value::Float(hops.len() as f64));
        plan.insert("stepCount".into(), Value::Float(steps.len() as f64));
        plan.insert("slippageBps".into(), Value::Float(slippage_bps));
        plan.insert("reconcileToleranceRatio".into(), Value::Float(tolerance));
        plan.insert("steps".into(), Value::List(steps));
        Ok(Value::Map(plan))
    }
}

// ---------------------------------------------------------------------------
// the venue abstraction
// ---------------------------------------------------------------------------

/// What `execute` needs from an exchange, and nothing more.
///
/// The other five ports hand `execute` their language's exchange object
/// directly. Rust cannot: `ExchangeBase`'s methods return `impl Future`, which
/// is not object-safe, so a `HashMap<String, Box<dyn ExchangeBase>>` — the
/// shape every other port uses for `venues` — cannot exist. This trait is that
/// shape, narrowed to the operations the money path actually performs, and it
/// is what makes the venues map possible here at all.
///
/// It also buys something the other ports get for free from dynamic typing: a
/// test can implement this in twenty lines, so the execute-path invariants are
/// testable without a live exchange.
#[async_trait::async_trait]
pub trait RouterVenue: Send + Sync {
    /// The venue's ccxt id, e.g. `binance`. Matched against a step's
    /// `exchangeId`.
    fn id(&self) -> String;

    /// Snaps an amount to the market's precision, as text — the same contract
    /// as ccxt's `amountToPrecision`.
    fn amount_to_precision(&self, symbol: &str, amount: f64) -> String;

    /// Snaps a price to the market's precision, as text.
    fn price_to_precision(&self, symbol: &str, price: f64) -> String;

    /// Whether this venue accepts an immediate-or-cancel time-in-force on a
    /// limit order. A venue that does not gets a market order only when the
    /// caller has explicitly opted in — see `execute`.
    fn supports_ioc(&self) -> bool;

    /// Places an order. `params` carries the time-in-force and any caller
    /// extras.
    async fn create_order(
        &self,
        symbol: &str,
        order_type: &str,
        side: &str,
        amount: f64,
        price: f64,
        params: &Value,
    ) -> RouterResult<Value>;

    /// Reads an order back. Used to re-read a venue that answered without a
    /// `filled`, rather than assuming one.
    async fn fetch_order(&self, id: &str, symbol: &str) -> RouterResult<Value>;

    /// Cancels an order. Used by the protected-limit path when the poll expires.
    async fn cancel_order(&self, id: &str, symbol: &str) -> RouterResult<Value>;
}

// ---------------------------------------------------------------------------
// PURE: check_execution_plan_safety
// ---------------------------------------------------------------------------

impl OrderRouter {
    /// Builds one safety violation record.
    fn violation(
        &self,
        step_index: f64,
        exchange_id: &str,
        symbol: &str,
        code: &str,
        blocking: bool,
        actual: f64,
        limit: f64,
    ) -> Value {
        let mut entry = HashMap::new();
        entry.insert("stepIndex".into(), Value::Float(step_index));
        entry.insert("exchangeId".into(), Value::Str(exchange_id.to_string()));
        entry.insert("symbol".into(), Value::Str(symbol.to_string()));
        entry.insert("code".into(), Value::Str(code.to_string()));
        entry.insert("blocking".into(), Value::Bool(blocking));
        entry.insert("actual".into(), Value::Float(actual));
        entry.insert("limit".into(), Value::Float(limit));
        Value::Map(entry)
    }

    /// Resolves the USD price of a currency, treating USD itself as 1 and
    /// assuming nothing about anything else.
    fn usd_rate_for(&self, code: &str, usd_rates: &Value) -> f64 {
        if code.is_empty() {
            return 0.0;
        }
        if code == "USD" {
            return 1.0;
        }
        // USDT and USDC are NOT assumed to be one dollar. A stablecoin peg is an
        // empirical fact, not a definition, and the caller supplying rates is
        // the one who knows today's.
        let rate = self.number_at(usd_rates, code, 0.0);
        if rate > 0.0 {
            return rate;
        }
        0.0
    }

    /// The USD value of a step's notional, quote side first and base side as
    /// the fallback — `amount * usd(base)` values the same trade.
    fn notional_usd(&self, step: &Value, notional_quote: f64, usd_rates: &Value) -> f64 {
        let quote = self.string_at(step, "quote", "");
        let quote_rate = self.usd_rate_for(&quote, usd_rates);
        if quote_rate > 0.0 {
            return notional_quote * quote_rate;
        }
        let base_code = self.string_at(step, "base", "");
        let base_rate = self.usd_rate_for(&base_code, usd_rates);
        if base_rate > 0.0 {
            return self.number_at(step, "amount", 0.0) * base_rate;
        }
        0.0
    }

    /// Reports whether a value fails to sit on a market's precision grid.
    fn precision_violated(&self, value: f64, precision: f64, mode: &str) -> bool {
        if precision <= 0.0 {
            // Unknown or unconstrained precision is not a finding.
            return false;
        }
        let rounded = if mode == "decimal_places" {
            let factor = 10f64.powf(precision);
            (value * factor).round() / factor
        } else {
            // The rounding mode is irrelevant here: a value exactly halfway
            // between two ticks is off-grid whichever neighbour it snaps to, so
            // the six languages' differing round() semantics cannot change this
            // predicate's answer.
            (value / precision).round() * precision
        };
        let allowed = value.abs() * TOLERANCE + 1e-15;
        (rounded - value).abs() > allowed
    }

    /// Checks a plan against per-venue market rules and the hard per-trade USD
    /// notional cap. PURE — no I/O. A step that cannot be valued in USD BLOCKS;
    /// it is never skipped, because a cap that silently disappears when a rate
    /// is missing is not a cap.
    ///
    /// `markets` is `markets[exchangeId][symbol]`.
    pub fn check_execution_plan_safety(
        &self,
        plan: &Value,
        markets: &Value,
        options: &Value,
    ) -> Vec<Value> {
        let mut violations: Vec<Value> = Vec::new();
        let mut max_notional_usd = self.number_at(options, "maxNotionalUsd", self.max_notional_usd);
        if max_notional_usd > self.max_notional_usd {
            max_notional_usd = self.max_notional_usd;
        }
        if max_notional_usd > MAX_NOTIONAL_USD {
            // The instance field stays writable in four of the six languages, so
            // the constructor's refusal is not the last word on it. The hard
            // 25 USD ceiling is re-imposed HERE, where the number is used.
            max_notional_usd = MAX_NOTIONAL_USD;
        }
        let usd_rates = self.dict_at(options, "usdRates");
        let precision_mode = self.string_at(options, "precisionMode", "tick_size");
        let steps = self.list_at(plan, "steps");
        if steps.is_empty() {
            // An empty plan passing an empty violation list would read as "safe".
            violations.push(self.violation(-1.0, "", "", "empty_plan", true, 0.0, 0.0));
            return violations;
        }
        let unroutable_reason = self.string_at(plan, "unroutableReason", "");
        if !unroutable_reason.is_empty() {
            violations.push(self.violation(-1.0, "", "", "route_unroutable", true, 0.0, 0.0));
        }
        if !self.bool_at(plan, "fullyFillable", false) {
            violations.push(self.violation(
                -1.0, "", "", "partial_fill", false, self.number_at(plan, "fillRatio", 0.0), 1.0,
            ));
        }
        for (i, step) in steps.iter().enumerate() {
            let step_index = self.number_at(step, "stepIndex", i as f64);
            let exchange_id = self.string_at(step, "exchangeId", "");
            let symbol = self.string_at(step, "symbol", "");
            let amount = self.number_at(step, "amount", 0.0);
            let expected_price = self.number_at(step, "expectedPrice", 0.0);
            let limit_price = self.number_at(step, "limitPrice", 0.0);
            let notional_quote = self.number_at(step, "notionalQuote", 0.0);
            let side = self.string_at(step, "side", "");
            if amount <= 0.0 || expected_price <= 0.0 || (side != "buy" && side != "sell") {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "invalid_step", true, amount, 0.0,
                ));
                continue;
            }
            let venue_markets = self.dict_at(markets, &exchange_id);
            let market = self.dict_at(&venue_markets, &symbol);
            if market.as_map().map(|m| m.is_empty()).unwrap_or(true) {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "unknown_symbol", true, 0.0, 0.0,
                ));
                continue;
            }
            // The same symbol string on a different venue is not necessarily the
            // same pair, and the USD valuation below trusts the step's quote
            // currency — so disagreement is fatal, not cosmetic.
            let market_base = self.string_at(&market, "base", "");
            let market_quote = self.string_at(&market, "quote", "");
            let step_base = self.string_at(step, "base", "");
            let step_quote = self.string_at(step, "quote", "");
            let base_disagrees =
                !market_base.is_empty() && !step_base.is_empty() && market_base != step_base;
            let quote_disagrees =
                !market_quote.is_empty() && !step_quote.is_empty() && market_quote != step_quote;
            if base_disagrees || quote_disagrees {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "market_mismatch", true, 0.0, 0.0,
                ));
                continue;
            }
            let limits = self.dict_at(&market, "limits");
            let amount_limits = self.dict_at(&limits, "amount");
            let price_limits = self.dict_at(&limits, "price");
            let cost_limits = self.dict_at(&limits, "cost");
            let min_amount = self.number_at(&amount_limits, "min", 0.0);
            let max_amount = self.number_at(&amount_limits, "max", 0.0);
            let min_price = self.number_at(&price_limits, "min", 0.0);
            let max_price = self.number_at(&price_limits, "max", 0.0);
            let min_cost = self.number_at(&cost_limits, "min", 0.0);
            if min_amount > 0.0 && amount < min_amount {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "amount_below_minimum", true, amount, min_amount,
                ));
            }
            if max_amount > 0.0 && amount > max_amount {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "amount_above_maximum", true, amount, max_amount,
                ));
            }
            if min_cost > 0.0 && notional_quote < min_cost {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "cost_below_minimum", true, notional_quote, min_cost,
                ));
            }
            if (min_price > 0.0 && limit_price < min_price)
                || (max_price > 0.0 && limit_price > max_price)
            {
                let bound = if limit_price < min_price { min_price } else { max_price };
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "price_out_of_range", true, limit_price, bound,
                ));
            }
            let precision = self.dict_at(&market, "precision");
            let amount_precision = self.number_at(&precision, "amount", 0.0);
            let price_precision = self.number_at(&precision, "price", 0.0);
            // Precision findings are advisory: execute() snaps through the
            // venue's own amountToPrecision/priceToPrecision before sending.
            if self.precision_violated(amount, amount_precision, &precision_mode) {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "amount_precision", false, amount, amount_precision,
                ));
            }
            if self.precision_violated(limit_price, price_precision, &precision_mode) {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "price_precision", false, limit_price, price_precision,
                ));
            }
            // The notional cap. The worst case is the higher of the expected and
            // the limit price, which is the buy side; a sell's limit sits below,
            // so its expected price is the one that governs.
            let mut worst_price = expected_price;
            if limit_price > worst_price {
                worst_price = limit_price;
            }
            let worst_notional = amount * worst_price;
            let usd_value = self.notional_usd(step, worst_notional, &usd_rates);
            if usd_value <= 0.0 {
                // BLOCKING, and deliberately so. Skipping the cap for a step
                // whose USD value is unknown defeats the entire safety layer.
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "notional_unvaluable", true, worst_notional,
                    max_notional_usd,
                ));
            } else if usd_value > max_notional_usd * (1.0 + TOLERANCE) {
                violations.push(self.violation(
                    step_index, &exchange_id, &symbol, "notional_exceeds_cap", true, usd_value,
                    max_notional_usd,
                ));
            }
        }
        violations
    }
}

// ---------------------------------------------------------------------------
// PURE: reconcile_execution_step
// ---------------------------------------------------------------------------

impl OrderRouter {
    /// How much of its output asset a step is expected to produce, gross of
    /// fees: base units for a buy, quote units for a sell.
    pub fn step_expected_out(&self, step: &Value) -> f64 {
        let amount = self.number_at(step, "amount", 0.0);
        if self.string_at(step, "side", "") == "buy" {
            return amount;
        }
        amount * self.number_at(step, "expectedPrice", 0.0)
    }

    /// Reports whether a field holds a usable number, as opposed to holding
    /// zero or nothing at all.
    ///
    /// "The venue said zero" and "the venue said nothing" are different facts
    /// and used to produce the same number. Reuses `number_of` rather than
    /// re-deriving the coercion: "the value is usable" and "the value is
    /// present" must never disagree, and two copies of that rule is how they
    /// would.
    pub fn has_number_at(&self, container: &Value, key: &str) -> bool {
        let probe = Self::number_of(field(container, key), f64::NAN);
        Self::is_finite_number(probe)
    }

    /// Compares what a step actually produced against what the route predicted,
    /// resizes every downstream hop, and returns the proceed-or-halt verdict.
    /// PURE — no I/O.
    ///
    /// The halt decision lives here rather than in the execution loop because it
    /// is a money decision, and six separate loops is six chances to omit it.
    pub fn reconcile_execution_step(
        &self,
        plan: &Value,
        step_index: i64,
        realised_out: f64,
    ) -> RouterResult<Value> {
        let steps = self.list_at(plan, "steps");
        if step_index < 0 || step_index as usize >= steps.len() {
            return Err(bad_request("reconcileExecutionStep: stepIndex is out of range"));
        }
        let step = &steps[step_index as usize];
        let hop_index = self.number_at(step, "hopIndex", 0.0);
        let tolerance =
            self.number_at(plan, "reconcileToleranceRatio", DEFAULT_RECONCILE_TOLERANCE);
        let expected_out = self.step_expected_out(step);
        let mut resized: Vec<Value> = Vec::new();
        if expected_out <= 0.0 {
            let mut verdict = HashMap::new();
            verdict.insert("stepIndex".into(), Value::Float(step_index as f64));
            verdict.insert("hopIndex".into(), Value::Float(hop_index));
            verdict.insert("expectedOut".into(), Value::Float(0.0));
            verdict.insert("realisedOut".into(), Value::Float(realised_out));
            verdict.insert("shortfall".into(), Value::Float(0.0));
            verdict.insert("shortfallRatio".into(), Value::Float(0.0));
            verdict.insert("scale".into(), Value::Float(0.0));
            verdict.insert("verdict".into(), Value::Str("halt".into()));
            verdict.insert("reason".into(), Value::Str("zero_expected_output".into()));
            verdict.insert("resizedSteps".into(), Value::List(resized));
            return Ok(Value::Map(verdict));
        }
        let mut shortfall = expected_out - realised_out;
        if shortfall < 0.0 {
            shortfall = 0.0;
        }
        let shortfall_ratio = shortfall / expected_out;
        // The downstream hops lost `shortfall` out of this hop's whole output,
        // not out of this leg's, so the scale is measured against the hop.
        let mut hop_expected_out = 0.0f64;
        // Shortfall already reported by this hop's OTHER legs. Each leg used to
        // compute a scale from the hop total and multiply the downstream amounts
        // by it, so a second leg scaled an already-scaled number: 80% and 60%
        // fills produced 0.9 x 0.8 = 0.72 of the next hop instead of the true
        // 0.70, sizing it for more than the wallet actually received and
        // inviting a spurious insufficient-funds halt on exactly the bridged
        // routes this class exists for. Reproduced at 144 against a true 140
        // before this changed.
        let mut prior_shortfall = 0.0f64;
        for other in steps.iter() {
            if self.number_at(other, "hopIndex", 0.0) == hop_index {
                hop_expected_out += self.step_expected_out(other);
                if self.number_at(other, "stepIndex", -1.0) != step_index as f64
                    && self.has_number_at(other, "realisedOut")
                {
                    let mut leg_shortfall =
                        self.step_expected_out(other) - self.number_at(other, "realisedOut", 0.0);
                    if leg_shortfall < 0.0 {
                        leg_shortfall = 0.0;
                    }
                    prior_shortfall += leg_shortfall;
                }
            }
        }
        // scale_before is what the downstream amounts have ALREADY been
        // multiplied by, so the factor applied here is the increment that takes
        // them from that to the hop's true cumulative scale. With one leg per
        // hop prior_shortfall is 0, scale_before is 1, and this is
        // arithmetically identical to what it replaced.
        let mut scale_before = 1.0f64;
        let mut scale_after = 1.0f64;
        if hop_expected_out > 0.0 {
            scale_before = (hop_expected_out - prior_shortfall) / hop_expected_out;
            scale_after = (hop_expected_out - prior_shortfall - shortfall) / hop_expected_out;
        }
        if scale_before <= 0.0 {
            // The hop already produced nothing; there is nothing left to scale
            // down.
            scale_before = 1.0;
            scale_after = 0.0;
        }
        let mut scale = scale_after / scale_before;
        if scale > 1.0 {
            // Never scale UP. An overfill is good news, but growing a downstream
            // order past the size that passed the safety check would place an
            // order nobody ever approved.
            scale = 1.0;
        }
        if scale < 0.0 {
            scale = 0.0;
        }
        for (i, other) in steps.iter().enumerate() {
            if self.number_at(other, "hopIndex", 0.0) <= hop_index {
                continue;
            }
            let previous_amount = self.number_at(other, "amount", 0.0);
            let amount = previous_amount * scale;
            let mut entry = HashMap::new();
            entry.insert(
                "stepIndex".into(),
                Value::Float(self.number_at(other, "stepIndex", i as f64)),
            );
            entry.insert("previousAmount".into(), Value::Float(previous_amount));
            entry.insert("amount".into(), Value::Float(amount));
            entry.insert(
                "notionalQuote".into(),
                Value::Float(amount * self.number_at(other, "expectedPrice", 0.0)),
            );
            resized.push(Value::Map(entry));
        }
        let mut verdict_text = "proceed";
        let mut reason = "within_tolerance";
        if realised_out <= 0.0 {
            verdict_text = "halt";
            reason = "nothing_filled";
        } else if shortfall_ratio > tolerance * (1.0 + TOLERANCE) {
            verdict_text = "halt";
            reason = "shortfall_exceeds_tolerance";
        }
        let mut verdict = HashMap::new();
        verdict.insert("stepIndex".into(), Value::Float(step_index as f64));
        verdict.insert("hopIndex".into(), Value::Float(hop_index));
        verdict.insert("expectedOut".into(), Value::Float(expected_out));
        verdict.insert("realisedOut".into(), Value::Float(realised_out));
        verdict.insert("shortfall".into(), Value::Float(shortfall));
        verdict.insert("shortfallRatio".into(), Value::Float(shortfall_ratio));
        verdict.insert("scale".into(), Value::Float(scale));
        verdict.insert("verdict".into(), Value::Str(verdict_text.into()));
        verdict.insert("reason".into(), Value::Str(reason.into()));
        verdict.insert("resizedSteps".into(), Value::List(resized));
        Ok(Value::Map(verdict))
    }

    /// Writes a reconciliation's downstream resize back into the working steps.
    ///
    /// Records what this leg actually produced BEFORE resizing anything.
    /// `reconcile_execution_step` is pure and cannot remember across calls, so
    /// the hop's cumulative shortfall has to live on the steps themselves —
    /// this is what stops the next leg of the same hop compounding its scale
    /// onto an already-scaled amount.
    pub fn apply_resize(&self, steps: &mut [Value], reconciliation: &Value) {
        let reconciled_step = self.number_at(reconciliation, "stepIndex", -1.0);
        let realised_out = self.number_at(reconciliation, "realisedOut", 0.0);
        for step in steps.iter_mut() {
            if self.number_at(step, "stepIndex", -1.0) == reconciled_step {
                Self::put(step, "realisedOut", Value::Float(realised_out));
                break;
            }
        }
        let resized = self.list_at(reconciliation, "resizedSteps");
        for entry in &resized {
            let target = self.number_at(entry, "stepIndex", -1.0);
            let amount = self.number_at(entry, "amount", 0.0);
            let notional = self.number_at(entry, "notionalQuote", 0.0);
            for step in steps.iter_mut() {
                if self.number_at(step, "stepIndex", -1.0) == target {
                    Self::put(step, "amount", Value::Float(amount));
                    Self::put(step, "notionalQuote", Value::Float(notional));
                    break;
                }
            }
        }
    }

    /// Sets a key on a `Value::Dict` in place, through `Arc::make_mut` so the
    /// copy-on-write only deep-copies when the map is actually shared.
    ///
    /// Public because callers building a route by hand need it too — stamping
    /// `clientRequestedFrom`/`clientRequestedTo` onto a route obtained by some
    /// route other than `fetch_route`, for one. The other five ports get this
    /// for free from assignment into a dictionary.
    pub fn set_key(container: &mut Value, key: &str, value: Value) {
        Self::put(container, key, value)
    }

    fn put(container: &mut Value, key: &str, value: Value) {
        if let Value::Dict(map) = container {
            Arc::make_mut(map).insert(key.to_string(), value);
        }
    }
}

// ---------------------------------------------------------------------------
// PURE: build_unwind_plan
// ---------------------------------------------------------------------------

impl OrderRouter {
    /// Accumulates a signed amount into the (exchangeId, asset) position list,
    /// appending in first-seen order.
    ///
    /// `produced` is true when this step PRODUCED the asset, which is the only
    /// kind of step an unwind can reverse.
    fn add_position(
        &self,
        positions: &mut Vec<Value>,
        exchange_id: &str,
        asset: &str,
        amount: f64,
        source: &Value,
        produced: bool,
    ) {
        for position in positions.iter_mut() {
            let same_venue = self.string_at(position, "exchangeId", "") == exchange_id;
            let same_asset = self.string_at(position, "asset", "") == asset;
            if same_venue && same_asset {
                let running = self.number_at(position, "amount", 0.0) + amount;
                Self::put(position, "amount", Value::Float(running));
                let existing = self.dict_at(position, "source");
                let empty = existing.as_map().map(|m| m.is_empty()).unwrap_or(true);
                if produced && empty {
                    Self::put(position, "source", source.clone());
                }
                return;
            }
        }
        // The source must be the step that PRODUCED the asset, never one that
        // consumed it: reversing a step that spent your USDT would sell the
        // wrong side of the wrong market. Walking the results backwards, the
        // first producing step seen is the last one that ran, which is exactly
        // the order an unwind undoes first.
        let initial_source =
            if produced { source.clone() } else { Value::Map(HashMap::new()) };
        let mut entry = HashMap::new();
        entry.insert("exchangeId".into(), Value::Str(exchange_id.to_string()));
        entry.insert("asset".into(), Value::Str(asset.to_string()));
        entry.insert("amount".into(), Value::Float(amount));
        entry.insert("source".into(), initial_source);
        positions.push(Value::Map(entry));
    }

    /// Given a halted execution report, computes the reverse orders that sell
    /// each stranded residual back toward the original from-asset, on the venue
    /// that actually holds it. PURE — no I/O.
    ///
    /// NEVER automatic: the result carries `requiresConfirmation` and nothing in
    /// this class executes it.
    pub fn build_unwind_plan(&self, report: &Value) -> Value {
        let from_asset = self.string_at(report, "from", "");
        let to_asset = self.string_at(report, "to", "");
        let slippage_bps = self.number_at(report, "slippageBps", DEFAULT_SLIPPAGE_BPS);
        let results = self.list_at(report, "steps");
        // Net position per (exchangeId, asset). Held in a VECTOR rather than a
        // map because the output order must be identical in six languages and
        // map iteration order is not.
        let mut positions: Vec<Value> = Vec::new();
        for result in results.iter().rev() {
            let exchange_id = self.string_at(result, "exchangeId", "");
            let out_asset = self.string_at(result, "outAsset", "");
            let out_amount = self.number_at(result, "outAmount", 0.0);
            if !out_asset.is_empty() && out_amount > 0.0 {
                self.add_position(&mut positions, &exchange_id, &out_asset, out_amount, result, true);
            }
            let in_asset = self.string_at(result, "inAsset", "");
            let in_amount = self.number_at(result, "inAmount", 0.0);
            if !in_asset.is_empty() && in_amount > 0.0 {
                // What a later hop consumed on this venue is not a residual.
                // Netting is per venue: assets sitting on a venue the route
                // never spent them on stay stranded, because this class never
                // moves funds between venues.
                self.add_position(&mut positions, &exchange_id, &in_asset, -in_amount, result, false);
            }
        }
        let mut steps: Vec<Value> = Vec::new();
        let mut unresolved: Vec<Value> = Vec::new();
        let mut residual_count = 0i64;
        for position in &positions {
            let asset = self.string_at(position, "asset", "");
            let amount = self.number_at(position, "amount", 0.0);
            let exchange_id = self.string_at(position, "exchangeId", "");
            if amount <= 0.0 {
                continue;
            }
            if asset == from_asset {
                // Already home.
                continue;
            }
            residual_count += 1;
            let source = self.dict_at(position, "source");
            let symbol = self.string_at(&source, "symbol", "");
            let source_side = self.string_at(&source, "side", "");
            let mut price = self.number_at(&source, "averagePrice", 0.0);
            if price <= 0.0 {
                price = self.number_at(&source, "expectedPrice", 0.0);
            }
            if symbol.is_empty() || (source_side != "buy" && source_side != "sell") {
                unresolved.push(Self::unresolved_entry(&exchange_id, &asset, amount, "no_source_market"));
                continue;
            }
            if price <= 0.0 {
                unresolved.push(Self::unresolved_entry(&exchange_id, &asset, amount, "no_price"));
                continue;
            }
            // Reverse the order that created the residual: a buy left you
            // holding base, so sell it back; a sell left you holding quote, so
            // buy the base back with it.
            //
            // The counter asset is whatever the reversed order gives back, which
            // is exactly what the original order spent.
            let counter_asset = self.string_at(&source, "inAsset", "");
            let side;
            let unwind_amount;
            let market_base;
            let market_quote;
            if source_side == "buy" {
                side = "sell";
                unwind_amount = amount;
                market_base = self.string_at(&source, "outAsset", "");
                market_quote = self.string_at(&source, "inAsset", "");
            } else {
                side = "buy";
                unwind_amount = amount / price;
                market_base = self.string_at(&source, "inAsset", "");
                market_quote = self.string_at(&source, "outAsset", "");
            }
            let limit_price = if side == "buy" {
                price * (1.0 + slippage_bps / 10000.0)
            } else {
                price * (1.0 - slippage_bps / 10000.0)
            };
            let mut step = HashMap::new();
            step.insert("stepIndex".into(), Value::Float(steps.len() as f64));
            step.insert("exchangeId".into(), Value::Str(exchange_id.clone()));
            step.insert("symbol".into(), Value::Str(symbol));
            step.insert("side".into(), Value::Str(side.to_string()));
            // base and quote are carried so that an unwind plan can be fed
            // straight back into check_execution_plan_safety: unwinding is
            // trading, and it is subject to the same 25 USD cap.
            step.insert("base".into(), Value::Str(market_base));
            step.insert("quote".into(), Value::Str(market_quote));
            step.insert("asset".into(), Value::Str(asset.clone()));
            step.insert("counterAsset".into(), Value::Str(counter_asset.clone()));
            step.insert("amount".into(), Value::Float(unwind_amount));
            step.insert("expectedPrice".into(), Value::Float(price));
            step.insert("limitPrice".into(), Value::Float(limit_price));
            step.insert("notionalQuote".into(), Value::Float(unwind_amount * price));
            step.insert("reachesFrom".into(), Value::Bool(counter_asset == from_asset));
            step.insert("isDestination".into(), Value::Bool(asset == to_asset));
            steps.push(Value::Map(step));
        }
        let mut plan = HashMap::new();
        plan.insert("from".into(), Value::Str(from_asset));
        plan.insert("to".into(), Value::Str(to_asset));
        plan.insert("halted".into(), Value::Bool(self.bool_at(report, "halted", false)));
        plan.insert("haltReason".into(), Value::Str(self.string_at(report, "haltReason", "")));
        plan.insert("residualCount".into(), Value::Float(residual_count as f64));
        plan.insert("requiresConfirmation".into(), Value::Bool(true));
        plan.insert("automatic".into(), Value::Bool(false));
        plan.insert("steps".into(), Value::List(steps));
        plan.insert("unresolved".into(), Value::List(unresolved));
        Value::Map(plan)
    }

    fn unresolved_entry(exchange_id: &str, asset: &str, amount: f64, reason: &str) -> Value {
        let mut entry = HashMap::new();
        entry.insert("exchangeId".into(), Value::Str(exchange_id.to_string()));
        entry.insert("asset".into(), Value::Str(asset.to_string()));
        entry.insert("amount".into(), Value::Float(amount));
        entry.insert("reason".into(), Value::Str(reason.to_string()));
        Value::Map(entry)
    }
}
