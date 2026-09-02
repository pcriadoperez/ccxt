//  ---------------------------------------------------------------------------
//  OrderRouter — a client for the CCXT order-router service, plus the pure
//  planning / safety / reconciliation layer that sits between a routing
//  recommendation and real orders.
//
//  This file is HAND-WRITTEN and is NOT produced by any transpiler. Four sibling
//  implementations mirror it method for method:
//
//      ts/src/base/OrderRouter.ts          (the reference)
//      python/ccxt/base/order_router.py
//      php/OrderRouter.php
//      go/v4/exchange_order_router.go
//
//  Every construct below is deliberately one that TypeScript, Python, PHP and Go
//  can express the same way. The rules that keep the five ports honest:
//
//    - plain dictionaries and arrays only, never a language-specific container.
//      Dictionary<string, object> and List<object> everywhere, no generics of
//      our own, no tuples, no records
//    - NO NULLS in any returned structure. 0 means "unknown number", "" means
//      "unknown string", and a boolean companion field carries "was it known?"
//      wherever that distinction is load-bearing. C# value types and Go structs
//      have no natural null, and a null that only exists in three of five
//      languages is a divergence waiting to happen
//    - never iterate a hash map to produce ORDERED output. Build lists and
//      search them linearly: map iteration order differs per language
//    - all numbers are IEEE-754 doubles and every arithmetic sequence is written
//      in a fixed order, so the five ports agree bit for bit
//    - ONE number grammar, hand-rolled in all five (see ParseNumber). No port
//      calls its own parser: string.Trim() eats Unicode whitespace JavaScript's
//      parseFloat does not, and double.TryParse has no notion of a numeric
//      PREFIX. A cap read as 1234.5 in one language and 1 in another is a cap
//      that silently disappears
//    - NaN and +/-Infinity are NOT numbers here. An infinite tolerance disables
//      the halt verdict and an infinite rate disables the cap, so both fall back
//      to the caller's default — in all five, identically
//    - violation and verdict strings are CONSTANTS, never interpolated with
//      numbers: "25" and "25.0" are the same value and different text
//    - no closures escape a method, no LINQ over the money paths, no exceptions
//      as control flow
//
//  Three places where C# genuinely differs from JavaScript are handled
//  explicitly rather than papered over, and each is commented where it happens:
//  JS Math.round is round-half-up while Math.Round is banker's rounding
//  (RoundHalfUp below); Uri.EscapeDataString escapes characters that
//  encodeURIComponent leaves alone (EncodeUriComponent below); and JavaScript's
//  single thread makes concurrent report mutation free, where parallel legs here
//  really do run on several threads (reportLock below).
//
//  This class never moves funds between venues. There is no call to any
//  funds-transfer endpoint anywhere in it, deliberately and permanently.
//  ---------------------------------------------------------------------------

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ccxt;

using dict = Dictionary<string, object>;
using list = List<object>;

/// <summary>
/// A client for the CCXT order-router service and the pure planning, safety,
/// reconciliation and unwind layer that sits between a routing recommendation
/// and real orders.
/// </summary>
public class OrderRouter
{
    //  -----------------------------------------------------------------------
    //  Static text for every violation and verdict code. Kept out of the methods
    //  so that a port can copy the table verbatim and a reviewer can diff two
    //  languages by eye. No number is ever interpolated into these.
    //  -----------------------------------------------------------------------

    private static readonly dict VIOLATION_MESSAGES = new dict()
    {
        { "empty_plan", "the plan contains no steps" },
        { "route_unroutable", "the route carries an unroutableReason and must not be executed" },
        { "partial_fill", "the route does not fill completely at the requested size" },
        { "unknown_symbol", "the symbol is not listed on that venue" },
        { "market_mismatch", "the venue market trades a different pair than the route hop says it does" },
        { "invalid_step", "the step has a non-positive amount or price, or a side that is neither buy nor sell" },
        { "amount_below_minimum", "the amount is below the market minimum" },
        { "amount_above_maximum", "the amount is above the market maximum" },
        { "cost_below_minimum", "the notional is below the market minimum cost" },
        { "price_out_of_range", "the limit price falls outside the market price limits" },
        { "notional_unvaluable", "the step cannot be valued in USD, so the notional cap cannot be enforced" },
        { "notional_exceeds_cap", "the notional exceeds the per-trade USD cap" },
        { "amount_precision", "the amount does not sit on the market amount precision" },
        { "price_precision", "the limit price does not sit on the market price precision" },
    };

    private static readonly List<string> KNOWN_STRATEGIES = new List<string>() { "dry_run", "sequential", "parallel_within_hop", "limit_protected", "best_effort", "atomic_ish" };

    //  the query keys forwarded to GET /route, in a fixed order so that two
    //  ports build a byte-identical URL
    private static readonly List<string> ROUTE_QUERY_KEYS = new List<string>() { "amountIn", "amountOut", "strategy", "maxVenues", "bridges", "exchanges", "balances", "balanceMode", "includeQuotes", "includeFees", "certified", "requireFullFill", "hopPenaltyBps", "minLegNotional" };

    //  defaults, mirrored as constants in every port
    public const string DefaultBaseUrl = "https://docs.ccxt.com/router/api";

    public const double DefaultTimeoutMs = 30000;

    public const double DefaultSlippageBps = 25;

    public const double DefaultReconcileTolerance = 0.02;

    //  CLAUDE.md: never risk more than 25 USD equivalent per trade. This is a
    //  ceiling, not a default — the constructor refuses to raise it.
    public const double MaxNotionalUsd = 25;

    //  router-side caps on the `balances` query parameter; both REJECT rather
    //  than truncate server-side, so the client trims before sending
    public const int MaxBalanceEntries = 64;

    public const int MaxBalanceChars = 4096;

    //  relative tolerance for float comparisons; also the tolerance the five
    //  test suites compare fixture numbers with
    public const double Tolerance = 1e-9;

    //  instance state, named the way the neighbouring hand-written Exchange
    //  properties are named
    public string apiKey { get; private set; }

    public string baseUrl { get; private set; }

    public double timeoutMs { get; private set; }

    public double maxNotionalUsd { get; private set; }

    private readonly HttpClient httpClient = new HttpClient();

    //  JavaScript is single threaded, so the reference mutates its report from
    //  concurrently pending legs for free. Parallel legs here really do resume
    //  on several thread-pool threads, so every write to the shared report goes
    //  through this lock.
    private readonly object reportLock = new object();

    /// <summary>
    /// Creates a client for the CCXT order-router service.
    /// </summary>
    /// <param name="config">
    /// apiKey (required, sent as the x-api-key header), baseUrl (defaults to
    /// https://docs.ccxt.com/router/api), timeoutMs (defaults to 30000) and
    /// maxNotionalUsd (defaults to 25, and may only be LOWERED).
    /// </param>
    public OrderRouter(dict config = null)
    {
        var key = this.StringAt(config, "apiKey", "");
        if (key == "")
        {
            throw new ArgumentsRequired("OrderRouter requires an apiKey");
        }
        this.apiKey = key;
        var url = this.StringAt(config, "baseUrl", DefaultBaseUrl);
        while (url.Length > 0 && url[url.Length - 1] == '/')
        {
            url = url.Substring(0, url.Length - 1);
        }
        this.baseUrl = url;
        this.timeoutMs = this.NumberAt(config, "timeoutMs", DefaultTimeoutMs);
        var configuredCap = this.NumberAt(config, "maxNotionalUsd", MaxNotionalUsd);
        if (configuredCap > MaxNotionalUsd)
        {
            //  the cap is a hard rule, not a preference; raising it is refused
            throw new BadRequest("OrderRouter maxNotionalUsd may not exceed the hard 25 USD per-trade cap");
        }
        if (configuredCap <= 0)
        {
            throw new BadRequest("OrderRouter maxNotionalUsd must be positive");
        }
        this.maxNotionalUsd = configuredCap;
    }

    //  -----------------------------------------------------------------------
    //  small container accessors. Every port has these; they exist so the five
    //  implementations read line for line and so a missing key is never a
    //  language-specific crash.
    //  -----------------------------------------------------------------------

    /// <summary>Reads a raw field out of a container, or null when it is absent.</summary>
    public object ValueAt(object container, string key)
    {
        var mapping = this.AsDict(container);
        if (mapping == null)
        {
            return null;
        }
        object value = null;
        if (!mapping.TryGetValue(key, out value))
        {
            return null;
        }
        return value;
    }

    /// <summary>
    /// Reads a numeric field out of a container, with a default for missing,
    /// null and unparseable values.
    /// </summary>
    public double NumberAt(object container, string key, double defaultValue)
    {
        var value = this.ValueAt(container, key);
        if (value == null)
        {
            return defaultValue;
        }
        //  a boolean is NOT a number here, exactly as in the reference
        if (value is bool)
        {
            return defaultValue;
        }
        if (value is string)
        {
            return this.ParseNumber((string)value, defaultValue);
        }
        if (value is double || value is float || value is decimal || value is int || value is long || value is short || value is uint || value is ulong || value is ushort || value is byte || value is sbyte)
        {
            var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            //  NaN and +/-Infinity are not numbers this class will act on. An
            //  infinite tolerance silently disables the halt verdict and an
            //  infinite rate silently disables the cap, and "the default" is the
            //  only answer five languages can agree on for either.
            if (!this.IsFiniteNumber(number))
            {
                return defaultValue;
            }
            return number;
        }
        return defaultValue;
    }

    /// <summary>
    /// Reports whether a double is a real number, i.e. neither NaN nor an
    /// infinity.
    /// </summary>
    public bool IsFiniteNumber(double value)
    {
        if (double.IsNaN(value))
        {
            //  the same test the other four ports spell `value != value`; C#
            //  warns on that form (CS1718), so it is spelled out here
            return false;
        }
        if (value > 1.7976931348623157e308 || value < -1.7976931348623157e308)
        {
            return false;
        }
        return true;
    }

    /// <summary>
    /// Reads a string field out of a container, with a default for missing and
    /// null values.
    /// </summary>
    public string StringAt(object container, string key, string defaultValue)
    {
        var value = this.ValueAt(container, key);
        if (value == null)
        {
            return defaultValue;
        }
        if (value is string)
        {
            return (string)value;
        }
        return defaultValue;
    }

    /// <summary>
    /// Reads a boolean field out of a container, with a default for missing and
    /// null values.
    /// </summary>
    public bool BoolAt(object container, string key, bool defaultValue)
    {
        var value = this.ValueAt(container, key);
        if (value == null)
        {
            return defaultValue;
        }
        if (value is bool)
        {
            return (bool)value;
        }
        return defaultValue;
    }

    /// <summary>
    /// Reads whether a field holds the boolean true and nothing else. The string
    /// "true" and the number 1 are NOT true — that distinction is what keeps a
    /// dry run a dry run.
    /// </summary>
    public bool IsExactlyTrue(object container, string key)
    {
        var value = this.ValueAt(container, key);
        return (value is bool) && ((bool)value);
    }

    /// <summary>
    /// Reads a list field out of a container, returning an empty list when
    /// absent. A list already stored as List&lt;object&gt; comes back BY
    /// REFERENCE, so writing through the result writes through to the container.
    /// </summary>
    public list ListAt(object container, string key)
    {
        return this.AsList(this.ValueAt(container, key));
    }

    /// <summary>
    /// Reads a nested dictionary out of a container, returning an empty
    /// dictionary when absent. A dictionary already stored as
    /// Dictionary&lt;string, object&gt; comes back BY REFERENCE.
    /// </summary>
    public dict DictAt(object container, string key)
    {
        var nested = this.AsDict(this.ValueAt(container, key));
        if (nested == null)
        {
            return new dict();
        }
        return nested;
    }

    /// <summary>
    /// Views a value as a dictionary, or null when it is not one. Returns the
    /// same instance whenever it already is a Dictionary&lt;string, object&gt;.
    /// </summary>
    public dict AsDict(object value)
    {
        if (value == null)
        {
            return null;
        }
        if (value is dict)
        {
            return (dict)value;
        }
        if (value is IDictionary<string, object>)
        {
            var copy = new dict();
            foreach (var entry in (IDictionary<string, object>)value)
            {
                copy[entry.Key] = entry.Value;
            }
            return copy;
        }
        return null;
    }

    /// <summary>
    /// Views a value as a list, or an empty list when it is not one. Returns the
    /// same instance whenever it already is a List&lt;object&gt;.
    /// </summary>
    public list AsList(object value)
    {
        if (value == null)
        {
            return new list();
        }
        if (value is list)
        {
            return (list)value;
        }
        if ((value is IEnumerable) && !(value is string) && !(value is IDictionary<string, object>))
        {
            var copy = new list();
            foreach (var item in (IEnumerable)value)
            {
                copy.Add(item);
            }
            return copy;
        }
        return new list();
    }

    /// <summary>
    /// Parses a number the way JavaScript's parseFloat does: the longest numeric
    /// prefix of the trimmed text, and the default when there is not one.
    /// </summary>
    public double ParseNumber(string text, double defaultValue)
    {
        //  Hand-rolled rather than delegated to double.TryParse alone, because
        //  every language's own parser disagrees with the other four somewhere:
        //  Python reads '1_000' as 1000 and '1,234.5' not at all, PHP's and Go's
        //  \s is not JavaScript's whitespace set, string.Trim() removes Unicode
        //  whitespace JavaScript's parseFloat does not. The grammar below is
        //  JavaScript's StrDecimalLiteral prefix over the ASCII whitespace set,
        //  and it is the SAME twenty lines in all five ports.
        if (text == null)
        {
            return defaultValue;
        }
        var cursor = 0;
        while (cursor < text.Length && this.IsRouterSpace(text[cursor]))
        {
            cursor = cursor + 1;
        }
        var start = cursor;
        if (cursor < text.Length && (text[cursor] == '+' || text[cursor] == '-'))
        {
            cursor = cursor + 1;
        }
        var digits = 0;
        while (cursor < text.Length && text[cursor] >= '0' && text[cursor] <= '9')
        {
            cursor = cursor + 1;
            digits = digits + 1;
        }
        if (cursor < text.Length && text[cursor] == '.')
        {
            cursor = cursor + 1;
            while (cursor < text.Length && text[cursor] >= '0' && text[cursor] <= '9')
            {
                cursor = cursor + 1;
                digits = digits + 1;
            }
        }
        if (digits == 0)
        {
            //  "Infinity", "inf", "NaN", "" and a string of Arabic-Indic digits
            //  all land here, in all five
            return defaultValue;
        }
        var end = cursor;
        if (cursor < text.Length && (text[cursor] == 'e' || text[cursor] == 'E'))
        {
            var exponent = cursor + 1;
            if (exponent < text.Length && (text[exponent] == '+' || text[exponent] == '-'))
            {
                exponent = exponent + 1;
            }
            var exponentDigits = 0;
            while (exponent < text.Length && text[exponent] >= '0' && text[exponent] <= '9')
            {
                exponent = exponent + 1;
                exponentDigits = exponentDigits + 1;
            }
            if (exponentDigits > 0)
            {
                //  a trailing 'e' with no digits is not part of the number: JS
                //  reads "1e" as 1, and so does every port here
                end = exponent;
            }
        }
        double parsed = 0;
        if (!double.TryParse(text.Substring(start, end - start), NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
        {
            return defaultValue;
        }
        if (!this.IsFiniteNumber(parsed))
        {
            //  "1e400" overflows to an infinity, which is not a number the cap or
            //  the tolerance may be built out of
            return defaultValue;
        }
        return parsed;
    }

    /// <summary>
    /// Reports whether a character is one of the six ASCII spaces the number
    /// grammar skips. Deliberately NOT char.IsWhiteSpace: Python, PHP, C# and Go
    /// each draw the Unicode line in a different place, and a non-breaking space
    /// that parses in one language and not the others is drift.
    /// </summary>
    public bool IsRouterSpace(char character)
    {
        return (character == ' ') || (character == '\t') || (character == '\n') || (character == '\r') || (character == '\f') || (character == '\v');
    }

    /// <summary>
    /// Formats a double as decimal text with no exponent, so that five languages
    /// produce the same string.
    /// </summary>
    public string FormatNumber(double value)
    {
        //  JavaScript prints 1e-7 where Python prints 1e-07 and Go prints 1e-07;
        //  a fixed 12-decimal rendering with the trailing zeros trimmed is the
        //  one spelling all five languages agree on for the magnitudes a balance
        //  or an amount can take.
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            return "0";
        }
        if (Math.Abs(value) >= 1e18)
        {
            //  JavaScript's toFixed switches to exponent notation at 1e21 while
            //  the other four languages never do. Rather than let one language
            //  send a different string than the others, refuse — loudly, and at
            //  a magnitude no real amount reaches.
            throw new BadRequest("OrderRouter: a number this large cannot be rendered identically in all five languages");
        }
        var text = value.ToString("F12", CultureInfo.InvariantCulture);
        if (text.IndexOf('.') >= 0)
        {
            while (text.Length > 0 && text[text.Length - 1] == '0')
            {
                text = text.Substring(0, text.Length - 1);
            }
            if (text.Length > 0 && text[text.Length - 1] == '.')
            {
                text = text.Substring(0, text.Length - 1);
            }
        }
        if (text == "" || text == "-" || text == "-0")
        {
            return "0";
        }
        return text;
    }

    /// <summary>
    /// Percent-encodes exactly the characters JavaScript's encodeURIComponent
    /// encodes. Uri.EscapeDataString also escapes ! ' ( ) *, which would make
    /// this port send a different URL than the other four.
    /// </summary>
    public static string EncodeUriComponent(string value)
    {
        if (value == null)
        {
            return "";
        }
        var builder = new StringBuilder();
        var bytes = Encoding.UTF8.GetBytes(value);
        for (var i = 0; i < bytes.Length; i++)
        {
            var b = bytes[i];
            var c = (char)b;
            var unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')';
            if (unreserved)
            {
                builder.Append(c);
            }
            else
            {
                builder.Append('%');
                builder.Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }
        return builder.ToString();
    }

    /// <summary>
    /// Renders one query value: booleans as true/false, numbers through
    /// FormatNumber, lists comma-joined, everything else as its own text.
    /// </summary>
    public string QueryText(object value)
    {
        if (value == null)
        {
            return "";
        }
        if (value is bool)
        {
            return ((bool)value) ? "true" : "false";
        }
        if (value is string)
        {
            return (string)value;
        }
        if ((value is IEnumerable) && !(value is IDictionary<string, object>))
        {
            var items = this.AsList(value);
            var text = "";
            for (var i = 0; i < items.Count; i++)
            {
                if (i > 0)
                {
                    text = text + ",";
                }
                text = text + this.QueryText(items[i]);
            }
            return text;
        }
        if (value is double || value is float || value is decimal || value is int || value is long || value is short || value is uint || value is ulong || value is ushort || value is byte || value is sbyte)
        {
            return this.FormatNumber(Convert.ToDouble(value, CultureInfo.InvariantCulture));
        }
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    //  -----------------------------------------------------------------------
    //  I/O: the router HTTP client
    //  -----------------------------------------------------------------------

    /// <summary>
    /// Asks the router how to convert one asset into another, over the venues
    /// and bridges it has live books for.
    /// </summary>
    /// <param name="fromAsset">the asset being spent, e.g. USDT</param>
    /// <param name="toAsset">the asset being acquired, e.g. BTC</param>
    /// <param name="parameters">
    /// exactly one of amountIn or amountOut, plus any of strategy, maxVenues,
    /// exchanges, bridges, balances, balanceMode, includeQuotes, includeFees,
    /// certified, requireFullFill, hopPenaltyBps and minLegNotional.
    /// </param>
    /// <returns>
    /// a RouteResult — an unroutable pair comes back as a RouteResult with an
    /// unroutableReason, not as an exception.
    /// </returns>
    public async Task<dict> FetchRoute(string fromAsset, string toAsset, dict parameters = null)
    {
        if (fromAsset == null || toAsset == null || fromAsset == "" || toAsset == "")
        {
            throw new ArgumentsRequired("fetchRoute requires fromAsset and toAsset");
        }
        var hasAmountIn = this.ValueAt(parameters, "amountIn") != null;
        var hasAmountOut = this.ValueAt(parameters, "amountOut") != null;
        if (hasAmountIn == hasAmountOut)
        {
            //  refused client-side for the same reason the router refuses it: a
            //  typo must not become a confidently wrong route
            throw new BadRequest("fetchRoute requires exactly one of amountIn or amountOut");
        }
        var query = "from=" + EncodeUriComponent(fromAsset.ToUpperInvariant()) + "&to=" + EncodeUriComponent(toAsset.ToUpperInvariant());
        for (var i = 0; i < ROUTE_QUERY_KEYS.Count; i++)
        {
            var key = ROUTE_QUERY_KEYS[i];
            var value = this.ValueAt(parameters, key);
            if (value == null)
            {
                continue;
            }
            query = query + "&" + key + "=" + EncodeUriComponent(this.QueryText(value));
        }
        var url = this.baseUrl + "/route?" + query;
        return await this.Request(url);
    }

    /// <summary>
    /// Performs the authenticated GET and maps router status codes onto CCXT
    /// exceptions. Virtual so a test can drive the parsing without a network.
    /// </summary>
    /// <param name="url">the fully-formed url including the query string</param>
    /// <returns>the decoded JSON body</returns>
    public virtual async Task<dict> Request(string url)
    {
        var status = 0;
        var text = "";
        try
        {
            using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(this.timeoutMs)))
            {
                using (var message = new HttpRequestMessage(HttpMethod.Get, url))
                {
                    message.Headers.TryAddWithoutValidation("x-api-key", this.apiKey);
                    message.Headers.TryAddWithoutValidation("Accept", "application/json");
                    var response = await this.httpClient.SendAsync(message, cancellation.Token);
                    status = (int)response.StatusCode;
                    text = await response.Content.ReadAsStringAsync();
                }
            }
        }
        catch (OperationCanceledException)
        {
            //  a cancelled HttpClient send surfaces as TaskCanceledException,
            //  which derives from OperationCanceledException in every runtime
            throw new RequestTimeout("OrderRouter request timed out after " + this.FormatNumber(this.timeoutMs) + "ms");
        }
        catch (Exception e)
        {
            throw new ExchangeNotAvailable("OrderRouter request failed: " + e.Message);
        }
        dict body = null;
        try
        {
            body = this.AsDict(JsonHelper.Deserialize(text));
        }
        catch (Exception)
        {
            body = null;
        }
        if (body == null)
        {
            throw new ExchangeError("OrderRouter returned a non-JSON body");
        }
        if (status >= 200 && status < 300)
        {
            return body;
        }
        //  404 and 501 carry a complete RouteResult explaining the refusal —
        //  `no_market` and `exact_out_multi_hop_unsupported` are routing
        //  outcomes, and turning them into exceptions would make the caller
        //  parse an error string to recover a structure it already has
        if ((status == 404 || status == 501) && (this.StringAt(body, "unroutableReason", "") != ""))
        {
            return body;
        }
        var message2 = this.StringAt(body, "error", "http status " + status.ToString(CultureInfo.InvariantCulture));
        if (status == 400)
        {
            throw new BadRequest("OrderRouter: " + message2);
        }
        if (status == 401 || status == 403)
        {
            throw new AuthenticationError("OrderRouter: " + message2);
        }
        if (status == 429)
        {
            throw new RateLimitExceeded("OrderRouter: " + message2);
        }
        if (status == 408 || status == 504)
        {
            throw new RequestTimeout("OrderRouter: " + message2);
        }
        throw new ExchangeError("OrderRouter: " + message2);
    }

    /// <summary>
    /// Reads the live balances of the supplied venues, sends them to the router,
    /// and returns a route you can actually fund.
    /// </summary>
    /// <param name="fromAsset">the asset being spent</param>
    /// <param name="toAsset">the asset being acquired</param>
    /// <param name="venues">exchangeId to a ccxt exchange instance</param>
    /// <param name="parameters">
    /// the same parameters FetchRoute accepts, minus balances which this method
    /// builds. requireBalancesApplied (default true) throws when the router did
    /// not echo balancesApplied.
    /// </param>
    /// <returns>
    /// the RouteResult, with the client-side keys balancesUsed and
    /// balancesDropped added.
    /// </returns>
    public async Task<dict> FetchRouteWithBalances(string fromAsset, string toAsset, Dictionary<string, Exchange> venues, dict parameters = null)
    {
        var requireApplied = this.BoolAt(parameters, "requireBalancesApplied", true);
        var exchangeIds = this.SortedKeys(venues);
        var entries = new list();
        var dropped = new list();
        for (var i = 0; i < exchangeIds.Count; i++)
        {
            var exchangeId = exchangeIds[i];
            var venue = venues[exchangeId];
            var balance = this.AsDict(await venue.fetchBalance());
            var holdings = this.DictAt(balance, "free");
            if (holdings.Count == 0)
            {
                holdings = this.DictAt(balance, "total");
            }
            var codes = this.SortedKeys(holdings);
            for (var j = 0; j < codes.Count; j++)
            {
                var code = codes[j];
                var amount = this.NumberAt(holdings, code, 0);
                if (amount <= 0)
                {
                    //  a zero holding is not information, and it costs one of
                    //  the router's 64 entries
                    continue;
                }
                if (amount >= 1e18)
                {
                    //  beyond fixed-point rendering; reported rather than sent,
                    //  because a silently reshaped amount is worse than a
                    //  missing one
                    dropped.Add(new dict() { { "exchangeId", exchangeId }, { "asset", code }, { "amount", amount }, { "reason", "amount_out_of_range" } });
                    continue;
                }
                entries.Add(new dict() { { "exchangeId", exchangeId }, { "asset", code }, { "amount", amount } });
            }
        }
        //  largest first, so trimming to the router's caps drops the smallest
        //  holdings. Ties break on exchangeId then asset so five languages
        //  produce the same list from the same wallet.
        entries.Sort(this.CompareBalanceEntries);
        while (entries.Count > MaxBalanceEntries)
        {
            var removed = this.AsDict(entries[entries.Count - 1]);
            entries.RemoveAt(entries.Count - 1);
            removed["reason"] = "entry_cap";
            dropped.Add(removed);
        }
        var balances = this.JoinBalances(entries);
        while (balances.Length > MaxBalanceChars && entries.Count > 0)
        {
            var removed = this.AsDict(entries[entries.Count - 1]);
            entries.RemoveAt(entries.Count - 1);
            removed["reason"] = "char_cap";
            dropped.Add(removed);
            balances = this.JoinBalances(entries);
        }
        var routeParams = new dict();
        if (parameters != null)
        {
            foreach (var entry in parameters)
            {
                routeParams[entry.Key] = entry.Value;
            }
        }
        routeParams["balances"] = balances;
        var route = await this.FetchRoute(fromAsset, toAsset, routeParams);
        if (requireApplied && (balances != ""))
        {
            //  /route declares its query without a JSON schema, so a router that
            //  predates the balances feature answers byte-identically to one
            //  that never received it. Executing a plan computed against a
            //  portfolio the server never saw is the case worth failing on.
            if (this.StringAt(route, "balancesApplied", "") == "")
            {
                throw new ExchangeError("OrderRouter did not echo balancesApplied: the balances were ignored, so this route is not funded-aware");
            }
        }
        route["balancesUsed"] = balances;
        route["balancesDropped"] = dropped;
        return route;
    }

    /// <summary>
    /// Orders balance entries largest first, then by exchangeId, then by asset,
    /// comparing strings by code unit so five languages agree on the order.
    /// </summary>
    public int CompareBalanceEntries(object first, object second)
    {
        var a = this.AsDict(first);
        var b = this.AsDict(second);
        var amountA = this.NumberAt(a, "amount", 0);
        var amountB = this.NumberAt(b, "amount", 0);
        if (amountA != amountB)
        {
            return (amountA > amountB) ? -1 : 1;
        }
        var byExchange = string.CompareOrdinal(this.StringAt(a, "exchangeId", ""), this.StringAt(b, "exchangeId", ""));
        if (byExchange != 0)
        {
            return byExchange;
        }
        return string.CompareOrdinal(this.StringAt(a, "asset", ""), this.StringAt(b, "asset", ""));
    }

    /// <summary>
    /// Renders balance entries as the router's [exchangeId.]ASSET:amount
    /// comma-separated form.
    /// </summary>
    public string JoinBalances(list entries)
    {
        var text = "";
        for (var i = 0; i < entries.Count; i++)
        {
            var entry = this.AsDict(entries[i]);
            if (i > 0)
            {
                text = text + ",";
            }
            text = text + this.StringAt(entry, "exchangeId", "") + "." + this.StringAt(entry, "asset", "") + ":" + this.FormatNumber(this.NumberAt(entry, "amount", 0));
        }
        return text;
    }

    //  -----------------------------------------------------------------------
    //  PURE: BuildExecutionPlan
    //  -----------------------------------------------------------------------

    /// <summary>
    /// Flattens a RouteResult's hops and legs into a flat, ordered list of
    /// orders to place. PURE — no I/O, and the same input produces the same
    /// output in all five languages.
    /// </summary>
    /// <param name="route">a RouteResult as returned by FetchRoute</param>
    /// <param name="options">
    /// slippageBps (default 25) sets how far the limit price is placed past the
    /// expected price; reconcileToleranceRatio (default 0.02) is the shortfall
    /// ratio ReconcileExecutionStep halts on.
    /// </param>
    /// <returns>
    /// an execution plan whose steps carry stepIndex, hopIndex, legIndex,
    /// exchangeId, symbol, side, amount, expectedPrice, limitPrice and
    /// notionalQuote.
    /// </returns>
    public dict BuildExecutionPlan(dict route, dict options = null)
    {
        var slippageBps = this.NumberAt(options, "slippageBps", DefaultSlippageBps);
        var tolerance = this.NumberAt(options, "reconcileToleranceRatio", DefaultReconcileTolerance);
        var hops = this.ListAt(route, "hops");
        var steps = new list();
        var stepIndex = 0;
        for (var hopIndex = 0; hopIndex < hops.Count; hopIndex++)
        {
            var hop = this.AsDict(hops[hopIndex]);
            var symbol = this.StringAt(hop, "pair", "");
            var side = this.StringAt(hop, "side", "");
            var baseCode = this.StringAt(hop, "base", "");
            var quote = this.StringAt(hop, "quote", "");
            var legs = this.ListAt(hop, "legs");
            for (var legIndex = 0; legIndex < legs.Count; legIndex++)
            {
                var leg = this.AsDict(legs[legIndex]);
                //  leg amounts are always in BASE units, on both sides of the
                //  market — see the router's RoutingQuote.filledAmount contract
                var amount = this.NumberAt(leg, "amount", 0);
                var expectedPrice = this.NumberAt(leg, "averagePrice", 0);
                var effectivePrice = this.NumberAt(leg, "effectivePrice", expectedPrice);
                //  the limit sits on the side that costs you: above for a buy,
                //  below for a sell
                double limitPrice = 0;
                if (side == "buy")
                {
                    limitPrice = expectedPrice * (1 + slippageBps / 10000);
                }
                else
                {
                    limitPrice = expectedPrice * (1 - slippageBps / 10000);
                }
                steps.Add(new dict()
                {
                    { "stepIndex", stepIndex },
                    { "hopIndex", hopIndex },
                    { "legIndex", legIndex },
                    { "exchangeId", this.StringAt(leg, "exchangeId", "") },
                    { "symbol", symbol },
                    { "side", side },
                    { "base", baseCode },
                    { "quote", quote },
                    { "amount", amount },
                    { "expectedPrice", expectedPrice },
                    { "effectivePrice", effectivePrice },
                    { "limitPrice", limitPrice },
                    { "notionalQuote", amount * expectedPrice },
                });
                stepIndex = stepIndex + 1;
            }
        }
        return new dict()
        {
            { "requestId", this.StringAt(route, "requestId", "") },
            { "calculatedAt", this.NumberAt(route, "calculatedAt", 0) },
            { "from", this.StringAt(route, "from", "") },
            { "to", this.StringAt(route, "to", "") },
            { "routingStrategy", this.StringAt(route, "strategy", "") },
            { "exactSide", this.StringAt(route, "exactSide", "") },
            { "amountIn", this.NumberAt(route, "amountIn", 0) },
            { "amountOut", this.NumberAt(route, "amountOut", 0) },
            { "fullyFillable", this.BoolAt(route, "fullyFillable", false) },
            { "fillRatio", this.NumberAt(route, "fillRatio", 0) },
            { "unroutableReason", this.StringAt(route, "unroutableReason", "") },
            { "hopCount", hops.Count },
            { "stepCount", steps.Count },
            { "slippageBps", slippageBps },
            { "reconcileToleranceRatio", tolerance },
            { "steps", steps },
        };
    }

    //  -----------------------------------------------------------------------
    //  PURE: CheckExecutionPlanSafety
    //  -----------------------------------------------------------------------

    /// <summary>
    /// Checks a plan against per-venue market rules and the hard per-trade USD
    /// notional cap. PURE — no I/O. A step that cannot be valued in USD BLOCKS;
    /// it is never skipped, because a cap that silently disappears when a rate
    /// is missing is not a cap.
    /// </summary>
    /// <param name="plan">a plan from BuildExecutionPlan</param>
    /// <param name="markets">exchangeId to that exchange's markets, i.e. markets[exchangeId][symbol]</param>
    /// <param name="options">
    /// usdRates maps a currency code to its USD price (USD itself is 1
    /// implicitly and nothing else is assumed); maxNotionalUsd is clamped to the
    /// client's own cap, which is clamped to 25; precisionMode is tick_size
    /// (default) or decimal_places.
    /// </param>
    /// <returns>
    /// the violations, each with stepIndex, code, blocking, actual, limit and a
    /// constant message. An empty list means the plan passed.
    /// </returns>
    public List<dict> CheckExecutionPlanSafety(dict plan, dict markets, dict options = null)
    {
        var violations = new List<dict>();
        var cap = this.NumberAt(options, "maxNotionalUsd", this.maxNotionalUsd);
        if (cap > this.maxNotionalUsd)
        {
            cap = this.maxNotionalUsd;
        }
        if (cap > MaxNotionalUsd)
        {
            //  the instance field is private-set here but public in the other four
            //  ports, so the hard 25 USD ceiling is re-imposed WHERE THE NUMBER
            //  IS USED, and all five refuse the same plan.
            cap = MaxNotionalUsd;
        }
        var usdRates = this.DictAt(options, "usdRates");
        var precisionMode = this.StringAt(options, "precisionMode", "tick_size");
        var steps = this.ListAt(plan, "steps");
        if (steps.Count == 0)
        {
            //  an empty plan passing an empty violation list would read as "safe"
            violations.Add(this.Violation(-1, "", "", "empty_plan", true, 0, 0));
            return violations;
        }
        var unroutableReason = this.StringAt(plan, "unroutableReason", "");
        if (unroutableReason != "")
        {
            violations.Add(this.Violation(-1, "", "", "route_unroutable", true, 0, 0));
        }
        if (!this.BoolAt(plan, "fullyFillable", false))
        {
            violations.Add(this.Violation(-1, "", "", "partial_fill", false, this.NumberAt(plan, "fillRatio", 0), 1));
        }
        for (var i = 0; i < steps.Count; i++)
        {
            var step = this.AsDict(steps[i]);
            var stepIndex = this.NumberAt(step, "stepIndex", i);
            var exchangeId = this.StringAt(step, "exchangeId", "");
            var symbol = this.StringAt(step, "symbol", "");
            var amount = this.NumberAt(step, "amount", 0);
            var expectedPrice = this.NumberAt(step, "expectedPrice", 0);
            var limitPrice = this.NumberAt(step, "limitPrice", 0);
            var notionalQuote = this.NumberAt(step, "notionalQuote", 0);
            var side = this.StringAt(step, "side", "");
            if (amount <= 0 || expectedPrice <= 0 || (side != "buy" && side != "sell"))
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "invalid_step", true, amount, 0));
                continue;
            }
            var venueMarkets = this.DictAt(markets, exchangeId);
            var market = this.DictAt(venueMarkets, symbol);
            if (market.Count == 0)
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "unknown_symbol", true, 0, 0));
                continue;
            }
            //  the same symbol string on a different venue is not necessarily
            //  the same pair, and the USD valuation below trusts the step's
            //  quote currency — so disagreement is fatal, not cosmetic
            var marketBase = this.StringAt(market, "base", "");
            var marketQuote = this.StringAt(market, "quote", "");
            var stepBase = this.StringAt(step, "base", "");
            var stepQuote = this.StringAt(step, "quote", "");
            if ((marketBase != "" && stepBase != "" && marketBase != stepBase) || (marketQuote != "" && stepQuote != "" && marketQuote != stepQuote))
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "market_mismatch", true, 0, 0));
                continue;
            }
            var limits = this.DictAt(market, "limits");
            var amountLimits = this.DictAt(limits, "amount");
            var priceLimits = this.DictAt(limits, "price");
            var costLimits = this.DictAt(limits, "cost");
            var minAmount = this.NumberAt(amountLimits, "min", 0);
            var maxAmount = this.NumberAt(amountLimits, "max", 0);
            var minPrice = this.NumberAt(priceLimits, "min", 0);
            var maxPrice = this.NumberAt(priceLimits, "max", 0);
            var minCost = this.NumberAt(costLimits, "min", 0);
            if (minAmount > 0 && amount < minAmount)
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "amount_below_minimum", true, amount, minAmount));
            }
            if (maxAmount > 0 && amount > maxAmount)
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "amount_above_maximum", true, amount, maxAmount));
            }
            if (minCost > 0 && notionalQuote < minCost)
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "cost_below_minimum", true, notionalQuote, minCost));
            }
            if ((minPrice > 0 && limitPrice < minPrice) || (maxPrice > 0 && limitPrice > maxPrice))
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "price_out_of_range", true, limitPrice, (limitPrice < minPrice) ? minPrice : maxPrice));
            }
            var precision = this.DictAt(market, "precision");
            var amountPrecision = this.NumberAt(precision, "amount", 0);
            var pricePrecision = this.NumberAt(precision, "price", 0);
            //  precision findings are advisory: Execute snaps through the
            //  venue's own amountToPrecision/priceToPrecision before sending
            if (this.PrecisionViolated(amount, amountPrecision, precisionMode))
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "amount_precision", false, amount, amountPrecision));
            }
            if (this.PrecisionViolated(limitPrice, pricePrecision, precisionMode))
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "price_precision", false, limitPrice, pricePrecision));
            }
            //  the notional cap. The worst case is the higher of the expected
            //  and the limit price, which is the buy side; a sell's limit sits
            //  below, so its expected price is the one that governs.
            var worstPrice = expectedPrice;
            if (limitPrice > worstPrice)
            {
                worstPrice = limitPrice;
            }
            var worstNotional = amount * worstPrice;
            var usdValue = this.NotionalUsd(step, worstNotional, usdRates);
            if (usdValue <= 0)
            {
                //  BLOCKING, and deliberately so. Skipping the cap for a step
                //  whose USD value is unknown defeats the entire safety layer.
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "notional_unvaluable", true, worstNotional, cap));
            }
            else if (usdValue > cap * (1 + Tolerance))
            {
                violations.Add(this.Violation(stepIndex, exchangeId, symbol, "notional_exceeds_cap", true, usdValue, cap));
            }
        }
        return violations;
    }

    /// <summary>Builds one safety violation record.</summary>
    /// <param name="stepIndex">the offending step, or -1 for a plan-level finding</param>
    /// <param name="exchangeId">the venue</param>
    /// <param name="symbol">the market</param>
    /// <param name="code">the violation code</param>
    /// <param name="blocking">whether the violation forbids execution</param>
    /// <param name="actual">the observed value</param>
    /// <param name="limit">the value it was measured against</param>
    public dict Violation(double stepIndex, string exchangeId, string symbol, string code, bool blocking, double actual, double limit)
    {
        return new dict()
        {
            { "stepIndex", stepIndex },
            { "exchangeId", exchangeId },
            { "symbol", symbol },
            { "code", code },
            { "blocking", blocking },
            { "actual", actual },
            { "limit", limit },
            { "message", this.StringAt(VIOLATION_MESSAGES, code, code) },
        };
    }

    /// <summary>
    /// Values a step's quote-currency notional in USD, returning 0 when it
    /// cannot be valued.
    /// </summary>
    public double NotionalUsd(dict step, double notionalQuote, dict usdRates)
    {
        var quote = this.StringAt(step, "quote", "");
        var quoteRate = this.UsdRateFor(quote, usdRates);
        if (quoteRate > 0)
        {
            return notionalQuote * quoteRate;
        }
        //  fall back to the base side: amount * usd(base) values the same trade
        var baseCode = this.StringAt(step, "base", "");
        var baseRate = this.UsdRateFor(baseCode, usdRates);
        if (baseRate > 0)
        {
            return this.NumberAt(step, "amount", 0) * baseRate;
        }
        return 0;
    }

    /// <summary>
    /// Resolves the USD price of a currency, treating USD itself as 1 and
    /// assuming nothing about anything else.
    /// </summary>
    public double UsdRateFor(string code, dict usdRates)
    {
        if (code == "")
        {
            return 0;
        }
        if (code == "USD")
        {
            return 1;
        }
        //  USDT and USDC are NOT assumed to be one dollar. A stablecoin peg is
        //  an empirical fact, not a definition, and the caller supplying rates
        //  is the one who knows today's.
        var rate = this.NumberAt(usdRates, code, 0);
        if (rate > 0)
        {
            return rate;
        }
        return 0;
    }

    /// <summary>
    /// Reports whether a value fails to sit on a market's precision grid.
    /// </summary>
    /// <param name="value">the amount or price</param>
    /// <param name="precision">the market precision, a tick size or a decimal-place count</param>
    /// <param name="mode">tick_size or decimal_places</param>
    public bool PrecisionViolated(double value, double precision, string mode)
    {
        if (precision <= 0)
        {
            //  unknown or unconstrained precision is not a finding
            return false;
        }
        double rounded = 0;
        if (mode == "decimal_places")
        {
            var factor = Math.Pow(10, precision);
            rounded = RoundHalfUp(value * factor) / factor;
        }
        else
        {
            //  the rounding mode is irrelevant here: a value exactly halfway
            //  between two ticks is off-grid whichever neighbour it snaps to,
            //  so the five languages' differing round() semantics cannot change
            //  this predicate's answer
            rounded = RoundHalfUp(value / precision) * precision;
        }
        var allowed = Math.Abs(value) * Tolerance + 1e-15;
        return Math.Abs(rounded - value) > allowed;
    }

    /// <summary>
    /// Rounds the way JavaScript's Math.round does — halves go up, towards
    /// positive infinity. Math.Round would use banker's rounding and disagree
    /// with the other four ports on every exact half.
    /// </summary>
    public static double RoundHalfUp(double value)
    {
        return Math.Floor(value + 0.5);
    }

    //  -----------------------------------------------------------------------
    //  PURE: ReconcileExecutionStep
    //  -----------------------------------------------------------------------

    /// <summary>
    /// Compares what a step actually produced against what the route predicted,
    /// resizes every downstream hop, and returns the proceed-or-halt verdict.
    /// PURE — no I/O. The halt decision lives here rather than in the execution
    /// loop because it is a money decision, and five separate loops is five
    /// chances to omit it.
    /// </summary>
    /// <param name="plan">the plan, with any earlier resizes already applied to its steps</param>
    /// <param name="stepIndex">the step that just completed</param>
    /// <param name="realisedOut">
    /// what it actually produced, in that step's output asset — base for a buy,
    /// quote for a sell.
    /// </param>
    /// <returns>
    /// the verdict, with expectedOut, realisedOut, shortfall, shortfallRatio,
    /// scale, verdict, reason and resizedSteps.
    /// </returns>
    public dict ReconcileExecutionStep(dict plan, int stepIndex, double realisedOut)
    {
        var steps = this.ListAt(plan, "steps");
        if (stepIndex < 0 || stepIndex >= steps.Count)
        {
            throw new BadRequest("reconcileExecutionStep: stepIndex is out of range");
        }
        var step = this.AsDict(steps[stepIndex]);
        var hopIndex = this.NumberAt(step, "hopIndex", 0);
        var tolerance = this.NumberAt(plan, "reconcileToleranceRatio", DefaultReconcileTolerance);
        var expectedOut = this.StepExpectedOut(step);
        var resized = new list();
        if (expectedOut <= 0)
        {
            return new dict()
            {
                { "stepIndex", stepIndex },
                { "hopIndex", hopIndex },
                { "expectedOut", 0.0 },
                { "realisedOut", realisedOut },
                { "shortfall", 0.0 },
                { "shortfallRatio", 0.0 },
                { "scale", 0.0 },
                { "verdict", "halt" },
                { "reason", "zero_expected_output" },
                { "resizedSteps", resized },
            };
        }
        var shortfall = expectedOut - realisedOut;
        if (shortfall < 0)
        {
            shortfall = 0;
        }
        var shortfallRatio = shortfall / expectedOut;
        //  the downstream hops lost `shortfall` out of this hop's whole output,
        //  not out of this leg's, so the scale is measured against the hop
        double hopExpectedOut = 0;
        for (var i = 0; i < steps.Count; i++)
        {
            if (this.NumberAt(steps[i], "hopIndex", 0) == hopIndex)
            {
                hopExpectedOut = hopExpectedOut + this.StepExpectedOut(this.AsDict(steps[i]));
            }
        }
        double scale = 1;
        if (hopExpectedOut > 0)
        {
            scale = (hopExpectedOut - shortfall) / hopExpectedOut;
        }
        if (scale > 1)
        {
            //  never scale UP. An overfill is good news, but growing a
            //  downstream order past the size that passed the safety check
            //  would place an order nobody ever approved.
            scale = 1;
        }
        if (scale < 0)
        {
            scale = 0;
        }
        for (var i = 0; i < steps.Count; i++)
        {
            var other = this.AsDict(steps[i]);
            if (this.NumberAt(other, "hopIndex", 0) <= hopIndex)
            {
                continue;
            }
            var previousAmount = this.NumberAt(other, "amount", 0);
            var amount = previousAmount * scale;
            resized.Add(new dict()
            {
                { "stepIndex", this.NumberAt(other, "stepIndex", i) },
                { "previousAmount", previousAmount },
                { "amount", amount },
                { "notionalQuote", amount * this.NumberAt(other, "expectedPrice", 0) },
            });
        }
        var verdict = "proceed";
        var reason = "within_tolerance";
        if (realisedOut <= 0)
        {
            verdict = "halt";
            reason = "nothing_filled";
        }
        else if (shortfallRatio > tolerance * (1 + Tolerance))
        {
            verdict = "halt";
            reason = "shortfall_exceeds_tolerance";
        }
        return new dict()
        {
            { "stepIndex", stepIndex },
            { "hopIndex", hopIndex },
            { "expectedOut", expectedOut },
            { "realisedOut", realisedOut },
            { "shortfall", shortfall },
            { "shortfallRatio", shortfallRatio },
            { "scale", scale },
            { "verdict", verdict },
            { "reason", reason },
            { "resizedSteps", resized },
        };
    }

    /// <summary>
    /// How much of its output asset a step is expected to produce, gross of
    /// fees: base units for a buy, quote units for a sell.
    /// </summary>
    public double StepExpectedOut(dict step)
    {
        var amount = this.NumberAt(step, "amount", 0);
        if (this.StringAt(step, "side", "") == "buy")
        {
            return amount;
        }
        return amount * this.NumberAt(step, "expectedPrice", 0);
    }

    //  -----------------------------------------------------------------------
    //  PURE: BuildUnwindPlan
    //  -----------------------------------------------------------------------

    /// <summary>
    /// Given a halted execution report, computes the reverse orders that sell
    /// each stranded residual back toward the original from-asset, on the venue
    /// that actually holds it. PURE — no I/O. NEVER automatic: the result
    /// carries requiresConfirmation and nothing in this class executes it.
    /// </summary>
    /// <param name="report">an execution report from Execute</param>
    /// <returns>
    /// the unwind plan, with steps in reverse execution order and unresolved for
    /// residuals that cannot be reversed.
    /// </returns>
    public dict BuildUnwindPlan(dict report)
    {
        var fromAsset = this.StringAt(report, "from", "");
        var toAsset = this.StringAt(report, "to", "");
        var slippageBps = this.NumberAt(report, "slippageBps", DefaultSlippageBps);
        var results = this.ListAt(report, "steps");
        //  net position per (exchangeId, asset). Held in a LIST rather than a
        //  map because the output order must be identical in five languages and
        //  map iteration order is not.
        var positions = new list();
        for (var i = results.Count - 1; i >= 0; i--)
        {
            var result = this.AsDict(results[i]);
            var exchangeId = this.StringAt(result, "exchangeId", "");
            var outAsset = this.StringAt(result, "outAsset", "");
            var outAmount = this.NumberAt(result, "outAmount", 0);
            if (outAsset != "" && outAmount > 0)
            {
                this.AddPosition(positions, exchangeId, outAsset, outAmount, result, true);
            }
            var inAsset = this.StringAt(result, "inAsset", "");
            var inAmount = this.NumberAt(result, "inAmount", 0);
            if (inAsset != "" && inAmount > 0)
            {
                //  what a later hop consumed on this venue is not a residual.
                //  Netting is per venue: assets sitting on a venue the route
                //  never spent them on stay stranded, because this class never
                //  moves funds between venues.
                this.AddPosition(positions, exchangeId, inAsset, -inAmount, result, false);
            }
        }
        var steps = new list();
        var unresolved = new list();
        var residualCount = 0;
        for (var i = 0; i < positions.Count; i++)
        {
            var position = this.AsDict(positions[i]);
            var asset = this.StringAt(position, "asset", "");
            var amount = this.NumberAt(position, "amount", 0);
            var exchangeId = this.StringAt(position, "exchangeId", "");
            if (amount <= 0)
            {
                continue;
            }
            if (asset == fromAsset)
            {
                //  already home
                continue;
            }
            residualCount = residualCount + 1;
            var source = this.DictAt(position, "source");
            var symbol = this.StringAt(source, "symbol", "");
            var sourceSide = this.StringAt(source, "side", "");
            var price = this.NumberAt(source, "averagePrice", 0);
            if (price <= 0)
            {
                price = this.NumberAt(source, "expectedPrice", 0);
            }
            if (symbol == "" || (sourceSide != "buy" && sourceSide != "sell"))
            {
                unresolved.Add(new dict() { { "exchangeId", exchangeId }, { "asset", asset }, { "amount", amount }, { "reason", "no_source_market" } });
                continue;
            }
            if (price <= 0)
            {
                unresolved.Add(new dict() { { "exchangeId", exchangeId }, { "asset", asset }, { "amount", amount }, { "reason", "no_price" } });
                continue;
            }
            //  reverse the order that created the residual: a buy left you
            //  holding base, so sell it back; a sell left you holding quote, so
            //  buy the base back with it
            var side = "";
            double unwindAmount = 0;
            var marketBase = "";
            var marketQuote = "";
            //  the counter asset is whatever the reversed order gives back,
            //  which is exactly what the original order spent
            var counterAsset = this.StringAt(source, "inAsset", "");
            if (sourceSide == "buy")
            {
                side = "sell";
                unwindAmount = amount;
                marketBase = this.StringAt(source, "outAsset", "");
                marketQuote = this.StringAt(source, "inAsset", "");
            }
            else
            {
                side = "buy";
                unwindAmount = amount / price;
                marketBase = this.StringAt(source, "inAsset", "");
                marketQuote = this.StringAt(source, "outAsset", "");
            }
            double limitPrice = 0;
            if (side == "buy")
            {
                limitPrice = price * (1 + slippageBps / 10000);
            }
            else
            {
                limitPrice = price * (1 - slippageBps / 10000);
            }
            steps.Add(new dict()
            {
                { "stepIndex", steps.Count },
                { "exchangeId", exchangeId },
                { "symbol", symbol },
                { "side", side },
                //  base and quote are carried so that an unwind plan can be fed
                //  straight back into CheckExecutionPlanSafety: unwinding is
                //  trading, and it is subject to the same 25 USD cap
                { "base", marketBase },
                { "quote", marketQuote },
                { "asset", asset },
                { "counterAsset", counterAsset },
                { "amount", unwindAmount },
                { "expectedPrice", price },
                { "limitPrice", limitPrice },
                { "notionalQuote", unwindAmount * price },
                { "reachesFrom", counterAsset == fromAsset },
                { "isDestination", asset == toAsset },
            });
        }
        return new dict()
        {
            { "from", fromAsset },
            { "to", toAsset },
            { "halted", this.BoolAt(report, "halted", false) },
            { "haltReason", this.StringAt(report, "haltReason", "") },
            { "residualCount", residualCount },
            { "requiresConfirmation", true },
            { "automatic", false },
            { "steps", steps },
            { "unresolved", unresolved },
        };
    }

    /// <summary>
    /// Accumulates a signed amount into the (exchangeId, asset) position list,
    /// appending in first-seen order.
    /// </summary>
    /// <param name="produced">
    /// true when this step PRODUCED the asset, which is the only kind of step an
    /// unwind can reverse.
    /// </param>
    public void AddPosition(list positions, string exchangeId, string asset, double amount, dict source, bool produced)
    {
        for (var i = 0; i < positions.Count; i++)
        {
            var position = this.AsDict(positions[i]);
            if (this.StringAt(position, "exchangeId", "") == exchangeId && this.StringAt(position, "asset", "") == asset)
            {
                position["amount"] = this.NumberAt(position, "amount", 0) + amount;
                if (produced && this.DictAt(position, "source").Count == 0)
                {
                    position["source"] = source;
                }
                return;
            }
        }
        //  the source must be the step that PRODUCED the asset, never one that
        //  consumed it: reversing a step that spent your USDT would sell the
        //  wrong side of the wrong market. Walking the results backwards, the
        //  first producing step seen is the last one that ran, which is exactly
        //  the order an unwind undoes first.
        object initialSource = produced ? (object)source : (object)(new dict());
        positions.Add(new dict() { { "exchangeId", exchangeId }, { "asset", asset }, { "amount", amount }, { "source", initialSource } });
    }

    //  -----------------------------------------------------------------------
    //  IMPURE: Execute
    //  -----------------------------------------------------------------------

    /// <summary>
    /// Executes a plan against live exchange instances. THE ONLY IMPURE METHOD.
    /// dry_run is the default and anything other than options["live"] == true
    /// forces dry_run regardless of the strategy requested, so a call that looks
    /// live but forgot the flag places nothing.
    /// </summary>
    /// <param name="plan">a plan from BuildExecutionPlan</param>
    /// <param name="venues">exchangeId to a ccxt exchange instance</param>
    /// <param name="options">
    /// strategy (dry_run, sequential, parallel_within_hop, limit_protected,
    /// best_effort or atomic_ish), live (must be exactly true for any order to
    /// be placed), usdRates (required when live, because the notional cap cannot
    /// be enforced without it), allowMarketOrders, maxOrders,
    /// acknowledgeDispersion, orderTimeoutMs, pollIntervalMs and orderParams.
    /// </param>
    /// <returns>
    /// an execution report with per-step results, openOrders, errors and the
    /// halt verdict.
    /// </returns>
    public async Task<dict> Execute(dict plan, Dictionary<string, Exchange> venues, dict options = null)
    {
        var requestedStrategy = this.StringAt(options, "strategy", "dry_run");
        if (!KNOWN_STRATEGIES.Contains(requestedStrategy))
        {
            throw new BadRequest("OrderRouter: unknown execution strategy " + requestedStrategy);
        }
        var live = this.IsExactlyTrue(options, "live");
        //  THE default. Anything short of an explicit true is a rehearsal.
        var strategy = live ? requestedStrategy : "dry_run";
        var steps = this.CloneSteps(plan);
        var report = this.EmptyReport(plan, strategy, requestedStrategy, live, steps);
        if (strategy == "dry_run")
        {
            //  not one call is made against a venue on this path, not even a read
            report["wouldPlaceOrders"] = steps.Count;
            return report;
        }
        if (venues == null || venues.Count == 0)
        {
            throw new ArgumentsRequired("OrderRouter.execute requires a venues dictionary when live");
        }
        //  derived from the steps about to be executed, NEVER read off the plan:
        //  a plan that travelled through JSON, a persisted step list or a
        //  hand-rebuilt tail of a halted route can be missing hopCount, and a
        //  refusal that a missing key switches off is not a refusal
        var hopCount = this.HopCountOf(steps);
        if (strategy == "best_effort")
        {
            if (hopCount > 1)
            {
                //  best-effort multi-hop is the most reliable way to strand
                //  money in a bridge asset
                throw new NotSupported("OrderRouter: best_effort refuses multi-hop routes");
            }
            if (!this.IsExactlyTrue(options, "acknowledgeDispersion"))
            {
                throw new BadRequest("OrderRouter: best_effort requires acknowledgeDispersion");
            }
            if (this.NumberAt(options, "maxOrders", 0) <= 0)
            {
                throw new BadRequest("OrderRouter: best_effort requires a positive maxOrders");
            }
        }
        //  markets are needed for the safety check and for precision snapping
        var markets = new dict();
        var exchangeIds = this.SortedKeys(venues);
        for (var i = 0; i < exchangeIds.Count; i++)
        {
            var exchangeId = exchangeIds[i];
            var venue = venues[exchangeId];
            var venueMarkets = this.AsDict(venue.markets);
            if (venueMarkets == null || venueMarkets.Count == 0)
            {
                await venue.loadMarkets();
            }
            markets[exchangeId] = this.AsDict(venue.markets);
        }
        var usdRates = this.DictAt(options, "usdRates");
        var safetyOptions = new dict()
        {
            { "usdRates", usdRates },
            { "maxNotionalUsd", this.NumberAt(options, "maxNotionalUsd", this.maxNotionalUsd) },
            { "precisionMode", this.StringAt(options, "precisionMode", "tick_size") },
        };
        var violations = this.CheckExecutionPlanSafety(plan, markets, safetyOptions);
        var blockers = "";
        for (var i = 0; i < violations.Count; i++)
        {
            if (this.BoolAt(violations[i], "blocking", false))
            {
                if (blockers != "")
                {
                    blockers = blockers + ", ";
                }
                blockers = blockers + this.StringAt(violations[i], "code", "");
            }
        }
        if (blockers != "")
        {
            //  thrown, not reported. A refusal a caller can forget to read is
            //  not a refusal.
            throw new ExchangeError("OrderRouter: refusing to execute, blocking safety violations: " + blockers);
        }
        if (strategy == "atomic_ish")
        {
            await this.AssertPrefunded(steps, venues);
        }
        if (strategy == "parallel_within_hop")
        {
            await this.ExecuteParallelWithinHop(report, steps, venues, options, usdRates);
        }
        else if (strategy == "best_effort")
        {
            await this.ExecuteBestEffort(report, steps, venues, options, usdRates);
        }
        else
        {
            //  sequential, limit_protected and atomic_ish all walk the plan one
            //  order at a time; they differ in how a single order is placed and
            //  in whether they lean on the previous hop's proceeds
            await this.ExecuteSequential(report, steps, venues, options, usdRates, strategy);
        }
        this.SummariseReport(report, steps);
        return report;
    }

    /// <summary>
    /// Counts the distinct hops a step list spans, which is the only authority on
    /// whether a plan is multi-hop.
    /// </summary>
    public double HopCountOf(list steps)
    {
        //  a list rather than a set, so the count is the same in five languages
        //  and does not depend on hash iteration order
        var seen = new List<double>();
        for (var i = 0; i < steps.Count; i++)
        {
            var hopIndex = this.NumberAt(steps[i], "hopIndex", 0);
            var found = false;
            for (var j = 0; j < seen.Count; j++)
            {
                if (seen[j] == hopIndex)
                {
                    found = true;
                    break;
                }
            }
            if (!found)
            {
                seen.Add(hopIndex);
            }
        }
        return seen.Count;
    }

    /// <summary>
    /// Copies a plan's steps so that execution-time resizing never mutates the
    /// caller's plan.
    /// </summary>
    public list CloneSteps(dict plan)
    {
        var steps = this.ListAt(plan, "steps");
        var copies = new list();
        for (var i = 0; i < steps.Count; i++)
        {
            var step = this.AsDict(steps[i]);
            copies.Add(new dict()
            {
                { "stepIndex", this.NumberAt(step, "stepIndex", i) },
                { "hopIndex", this.NumberAt(step, "hopIndex", 0) },
                { "legIndex", this.NumberAt(step, "legIndex", 0) },
                { "exchangeId", this.StringAt(step, "exchangeId", "") },
                { "symbol", this.StringAt(step, "symbol", "") },
                { "side", this.StringAt(step, "side", "") },
                { "base", this.StringAt(step, "base", "") },
                { "quote", this.StringAt(step, "quote", "") },
                { "amount", this.NumberAt(step, "amount", 0) },
                { "expectedPrice", this.NumberAt(step, "expectedPrice", 0) },
                { "effectivePrice", this.NumberAt(step, "effectivePrice", 0) },
                { "limitPrice", this.NumberAt(step, "limitPrice", 0) },
                { "notionalQuote", this.NumberAt(step, "notionalQuote", 0) },
            });
        }
        return copies;
    }

    /// <summary>
    /// Builds the report skeleton, with every step marked planned.
    /// </summary>
    public dict EmptyReport(dict plan, string strategy, string requestedStrategy, bool live, list steps)
    {
        var results = new list();
        for (var i = 0; i < steps.Count; i++)
        {
            var step = this.AsDict(steps[i]);
            results.Add(new dict()
            {
                { "stepIndex", this.NumberAt(step, "stepIndex", i) },
                { "hopIndex", this.NumberAt(step, "hopIndex", 0) },
                { "legIndex", this.NumberAt(step, "legIndex", 0) },
                { "exchangeId", this.StringAt(step, "exchangeId", "") },
                { "symbol", this.StringAt(step, "symbol", "") },
                { "side", this.StringAt(step, "side", "") },
                { "status", "planned" },
                { "requestedAmount", this.NumberAt(step, "amount", 0) },
                { "filledAmount", 0.0 },
                { "averagePrice", 0.0 },
                { "expectedPrice", this.NumberAt(step, "expectedPrice", 0) },
                { "cost", 0.0 },
                { "inAsset", "" },
                { "inAmount", 0.0 },
                { "outAsset", "" },
                { "outAmount", 0.0 },
                { "orderId", "" },
                { "errorCode", "" },
            });
        }
        return new dict()
        {
            { "strategy", strategy },
            { "requestedStrategy", requestedStrategy },
            { "dryRun", strategy == "dry_run" },
            { "live", live },
            { "from", this.StringAt(plan, "from", "") },
            { "to", this.StringAt(plan, "to", "") },
            { "slippageBps", this.NumberAt(plan, "slippageBps", DefaultSlippageBps) },
            { "reconcileToleranceRatio", this.NumberAt(plan, "reconcileToleranceRatio", DefaultReconcileTolerance) },
            { "stepCount", steps.Count },
            { "wouldPlaceOrders", 0 },
            { "ordersPlaced", 0 },
            { "halted", false },
            { "haltReason", "" },
            { "haltStepIndex", -1 },
            { "filledIn", 0.0 },
            { "filledOut", 0.0 },
            { "steps", results },
            { "openOrders", new list() },
            { "errors", new list() },
            { "reconciliations", new list() },
        };
    }

    /// <summary>
    /// Places one order at a time in plan order, reconciling after each and
    /// obeying the halt verdict.
    /// </summary>
    public async Task ExecuteSequential(dict report, list steps, Dictionary<string, Exchange> venues, dict options, dict usdRates, string strategy)
    {
        var results = this.ListAt(report, "steps");
        for (var i = 0; i < steps.Count; i++)
        {
            var step = this.AsDict(steps[i]);
            var result = await this.PlaceStep(step, venues, options, usdRates, strategy, report);
            results[i] = result;
            if (this.StringAt(result, "status", "") == "failed")
            {
                report["halted"] = true;
                report["haltReason"] = "order_failed";
                report["haltStepIndex"] = i;
                this.MarkRemainingSkipped(results, i + 1);
                return;
            }
            var reconcilePlan = new dict() { { "steps", steps }, { "reconcileToleranceRatio", this.NumberAt(report, "reconcileToleranceRatio", DefaultReconcileTolerance) } };
            var reconciliation = this.ReconcileExecutionStep(reconcilePlan, i, this.NumberAt(result, "outAmount", 0));
            this.ListAt(report, "reconciliations").Add(reconciliation);
            if (strategy != "atomic_ish")
            {
                //  atomic_ish is pre-funded end to end, so a hop's shortfall
                //  does not shrink the next hop's order — the money for it was
                //  already there before the first order went out
                this.ApplyResize(steps, reconciliation);
            }
            if (this.StringAt(reconciliation, "verdict", "") == "halt")
            {
                report["halted"] = true;
                report["haltReason"] = this.StringAt(reconciliation, "reason", "");
                report["haltStepIndex"] = i;
                this.MarkRemainingSkipped(results, i + 1);
                return;
            }
        }
    }

    /// <summary>
    /// Runs the legs of one hop concurrently and the hops strictly in order.
    /// </summary>
    public async Task ExecuteParallelWithinHop(dict report, list steps, Dictionary<string, Exchange> venues, dict options, dict usdRates)
    {
        var results = this.ListAt(report, "steps");
        var cursor = 0;
        while (cursor < steps.Count)
        {
            var hopIndex = this.NumberAt(steps[cursor], "hopIndex", 0);
            var end = cursor;
            while (end < steps.Count && this.NumberAt(steps[end], "hopIndex", 0) == hopIndex)
            {
                end = end + 1;
            }
            var pending = new List<Task<dict>>();
            for (var i = cursor; i < end; i++)
            {
                //  PlaceStep contains its own failures and never throws, so
                //  "wait for all" means the same thing in all five languages.
                //  Without that containment JavaScript rejects fast while
                //  sibling orders are still live, and Go's promiseAll waits for
                //  every one — the same source abandoning in-flight orders
                //  differently per language.
                pending.Add(this.PlaceStep(this.AsDict(steps[i]), venues, options, usdRates, "parallel_within_hop", report));
            }
            for (var i = 0; i < pending.Count; i++)
            {
                results[cursor + i] = await pending[i];
            }
            for (var i = cursor; i < end; i++)
            {
                var result = this.AsDict(results[i]);
                if (this.StringAt(result, "status", "") == "failed")
                {
                    report["halted"] = true;
                    report["haltReason"] = "order_failed";
                    report["haltStepIndex"] = i;
                    this.MarkRemainingSkipped(results, end);
                    return;
                }
                var reconcilePlan = new dict() { { "steps", steps }, { "reconcileToleranceRatio", this.NumberAt(report, "reconcileToleranceRatio", DefaultReconcileTolerance) } };
                var reconciliation = this.ReconcileExecutionStep(reconcilePlan, i, this.NumberAt(result, "outAmount", 0));
                this.ListAt(report, "reconciliations").Add(reconciliation);
                this.ApplyResize(steps, reconciliation);
                if (this.StringAt(reconciliation, "verdict", "") == "halt")
                {
                    report["halted"] = true;
                    report["haltReason"] = this.StringAt(reconciliation, "reason", "");
                    report["haltStepIndex"] = i;
                    this.MarkRemainingSkipped(results, end);
                    return;
                }
            }
            cursor = end;
        }
    }

    /// <summary>
    /// Places what it can and never halts, on a single hop only, up to
    /// maxOrders.
    /// </summary>
    public async Task ExecuteBestEffort(dict report, list steps, Dictionary<string, Exchange> venues, dict options, dict usdRates)
    {
        var results = this.ListAt(report, "steps");
        var maxOrders = this.NumberAt(options, "maxOrders", 0);
        double placed = 0;
        for (var i = 0; i < steps.Count; i++)
        {
            if (placed >= maxOrders)
            {
                var skipped = this.AsDict(results[i]);
                skipped["status"] = "skipped";
                skipped["errorCode"] = "max_orders_reached";
                continue;
            }
            results[i] = await this.PlaceStep(this.AsDict(steps[i]), venues, options, usdRates, "best_effort", report);
            placed = placed + 1;
            //  no reconciliation and no halt: that is the whole point of the
            //  strategy, and why it is refused on anything but a single hop
        }
    }

    /// <summary>
    /// Places one order for one step and NEVER throws, so that a sibling leg's
    /// failure cannot abandon an in-flight order.
    /// </summary>
    public async Task<dict> PlaceStep(dict step, Dictionary<string, Exchange> venues, dict options, dict usdRates, string strategy, dict report)
    {
        var stepIndex = this.NumberAt(step, "stepIndex", 0);
        var exchangeId = this.StringAt(step, "exchangeId", "");
        var symbol = this.StringAt(step, "symbol", "");
        var side = this.StringAt(step, "side", "");
        var result = new dict()
        {
            { "stepIndex", stepIndex },
            { "hopIndex", this.NumberAt(step, "hopIndex", 0) },
            { "legIndex", this.NumberAt(step, "legIndex", 0) },
            { "exchangeId", exchangeId },
            { "symbol", symbol },
            { "side", side },
            { "status", "failed" },
            { "requestedAmount", this.NumberAt(step, "amount", 0) },
            { "filledAmount", 0.0 },
            { "averagePrice", 0.0 },
            { "expectedPrice", this.NumberAt(step, "expectedPrice", 0) },
            { "cost", 0.0 },
            { "inAsset", "" },
            { "inAmount", 0.0 },
            { "outAsset", "" },
            { "outAmount", 0.0 },
            { "orderId", "" },
            { "errorCode", "" },
        };
        try
        {
            Exchange venue = null;
            if (!venues.TryGetValue(exchangeId, out venue) || venue == null)
            {
                result["errorCode"] = "venue_missing";
                this.RecordError(report, stepIndex, exchangeId, symbol, "venue_missing");
                return result;
            }
            var amount = this.ParseNumber(Convert.ToString(venue.amountToPrecision(symbol, this.NumberAt(step, "amount", 0)), CultureInfo.InvariantCulture), 0);
            var price = this.ParseNumber(Convert.ToString(venue.priceToPrecision(symbol, this.NumberAt(step, "limitPrice", 0)), CultureInfo.InvariantCulture), 0);
            if (!(amount > 0) || !(price > 0))
            {
                result["errorCode"] = "rounded_to_zero";
                this.RecordError(report, stepIndex, exchangeId, symbol, "rounded_to_zero");
                return result;
            }
            //  CLAUDE.md: compute the notional before EVERY createOrder. The
            //  plan-level check already ran, but the plan can have been resized
            //  by a reconciliation since, and the snapped price is not the one
            //  that was checked.
            this.AssertUnderCap(step, amount, price, usdRates, options);
            var orderParams = new dict();
            var extra = this.DictAt(options, "orderParams");
            foreach (var entry in extra)
            {
                orderParams[entry.Key] = entry.Value;
            }
            dict order = null;
            if (strategy == "limit_protected")
            {
                order = await this.PlaceProtectedLimit(venue, step, symbol, side, amount, price, orderParams, options, report, result);
            }
            else
            {
                order = await this.PlaceImmediateOrder(venue, symbol, side, amount, price, orderParams, options, result);
            }
            result["orderId"] = this.StringAt(order, "id", "");
            var filled = this.NumberAt(order, "filled", 0);
            var average = this.NumberAt(order, "average", 0);
            if (average <= 0)
            {
                average = this.NumberAt(order, "price", 0);
            }
            if (average <= 0)
            {
                average = price;
            }
            var cost = this.NumberAt(order, "cost", 0);
            if (cost <= 0)
            {
                cost = filled * average;
            }
            result["filledAmount"] = filled;
            result["averagePrice"] = average;
            result["cost"] = cost;
            if (side == "buy")
            {
                result["inAsset"] = this.StringAt(step, "quote", "");
                result["inAmount"] = cost;
                result["outAsset"] = this.StringAt(step, "base", "");
                result["outAmount"] = filled;
            }
            else
            {
                result["inAsset"] = this.StringAt(step, "base", "");
                result["inAmount"] = filled;
                result["outAsset"] = this.StringAt(step, "quote", "");
                result["outAmount"] = cost;
            }
            if (filled <= 0)
            {
                result["status"] = "unfilled";
            }
            else if (filled >= amount * (1 - Tolerance))
            {
                result["status"] = "filled";
            }
            else
            {
                result["status"] = "partial";
            }
            if (this.StringAt(order, "status", "") == "open")
            {
                //  an order the venue explicitly calls open is RESTING. It should
                //  not be, on either path: PlaceProtectedLimit only returns a
                //  closed or canceled order, and PlaceImmediateOrder asked for
                //  immediate-or-cancel. A venue that silently dropped the
                //  timeInForce param leaves a plain limit order sitting there,
                //  and "unfilled" on its own reads like nothing happened.
                this.RecordOpenOrder(report, exchangeId, symbol, this.StringAt(result, "orderId", ""), "still_open");
            }
            lock (this.reportLock)
            {
                report["ordersPlaced"] = this.NumberAt(report, "ordersPlaced", 0) + 1;
            }
            return result;
        }
        catch (Exception e)
        {
            //  containment. A leg that throws must not take its siblings with it.
            result["status"] = "failed";
            result["errorCode"] = this.ErrorCodeOf(e);
            this.RecordError(report, stepIndex, exchangeId, symbol, this.StringAt(result, "errorCode", ""));
            //  createOrder may already have succeeded: every path between it and
            //  the final read — a poll that times out, a network drop, a cap
            //  re-check — leaves a real order on a real venue. Reporting the id is
            //  the difference between an operator who can go cancel it and one who
            //  never learns it exists.
            this.RecordOpenOrder(report, exchangeId, symbol, this.StringAt(result, "orderId", ""), "outcome_unknown");
            return result;
        }
    }

    /// <summary>
    /// Appends one possibly-live order to the report, ignoring a blank id and
    /// never recording the same id twice.
    /// </summary>
    public void RecordOpenOrder(dict report, string exchangeId, string symbol, string orderId, string reason)
    {
        if (orderId == "")
        {
            //  nothing to point an operator at
            return;
        }
        lock (this.reportLock)
        {
            var openOrders = this.ListAt(report, "openOrders");
            for (var i = 0; i < openOrders.Count; i++)
            {
                if (this.StringAt(openOrders[i], "orderId", "") == orderId && this.StringAt(openOrders[i], "exchangeId", "") == exchangeId)
                {
                    return;
                }
            }
            openOrders.Add(new dict() { { "exchangeId", exchangeId }, { "symbol", symbol }, { "orderId", orderId }, { "reason", reason } });
        }
    }

    /// <summary>
    /// Names a caught exception by its class, which is the one label all five
    /// languages agree on.
    /// </summary>
    public string ErrorCodeOf(Exception e)
    {
        if (e == null)
        {
            return "unknown_error";
        }
        return e.GetType().Name;
    }

    /// <summary>
    /// Places an immediate-or-cancel limit order, falling back to a market order
    /// only when the venue cannot do IOC and the caller explicitly allowed it.
    /// </summary>
    /// <summary>
    /// Views a typed ccxt.Order as the plain dict the rest of this class reads.
    /// C# is the only one of the five implementations whose Exchange returns a
    /// typed order rather than the unified dict; mapping it here keeps every
    /// call site below identical to its TypeScript, Python, PHP and Go siblings,
    /// which is what the shared fixture checks. Only the fields the router
    /// actually reads are carried across — adding more would invent parity that
    /// is not tested.
    /// </summary>
    public dict OrderToDict(ccxt.Order order)
    {
        var mapped = new dict();
        mapped["id"] = order.id;
        mapped["status"] = order.status;
        mapped["filled"] = order.filled;
        mapped["average"] = order.average;
        mapped["cost"] = order.cost;
        mapped["price"] = order.price;
        return mapped;
    }

    public async Task<dict> PlaceImmediateOrder(Exchange venue, string symbol, string side, double amount, double price, dict orderParams, dict options, dict result)
    {
        if (this.VenueSupportsIoc(venue))
        {
            orderParams["timeInForce"] = "IOC";
            var iocOrder = this.OrderToDict(await venue.CreateOrder(symbol, "limit", side, amount, price, orderParams));
            result["orderId"] = this.StringAt(iocOrder, "id", "");
            return iocOrder;
        }
        if (!this.IsExactlyTrue(options, "allowMarketOrders"))
        {
            //  a market order is an unbounded price, and switching to one on a
            //  caller's behalf is exactly the decision they did not delegate
            throw new NotSupported("OrderRouter: venue cannot do IOC and allowMarketOrders was not set");
        }
        var marketOrder = this.OrderToDict(await venue.CreateOrder(symbol, "market", side, amount, null, orderParams));
        result["orderId"] = this.StringAt(marketOrder, "id", "");
        return marketOrder;
    }

    /// <summary>
    /// Rests a limit order, then cancels it on timeout and ALWAYS re-reads it,
    /// because a cancel and a fill can cross.
    /// </summary>
    /// <returns>the order as last observed, which is the authoritative fill</returns>
    public async Task<dict> PlaceProtectedLimit(Exchange venue, dict step, string symbol, string side, double amount, double price, dict orderParams, dict options, dict report, dict result)
    {
        var timeoutMs = this.NumberAt(options, "orderTimeoutMs", 20000);
        var pollIntervalMs = this.NumberAt(options, "pollIntervalMs", 1000);
        var order = this.OrderToDict(await venue.CreateOrder(symbol, "limit", side, amount, price, orderParams));
        var orderId = this.StringAt(order, "id", "");
        //  before the first poll, the first sleep and the first thing that can go
        //  wrong: from here on the caller can always name what is resting
        result["orderId"] = orderId;
        double waited = 0;
        while (waited < timeoutMs)
        {
            if (this.StringAt(order, "status", "") == "closed" || this.StringAt(order, "status", "") == "canceled")
            {
                return order;
            }
            await this.Sleep(pollIntervalMs);
            waited = waited + pollIntervalMs;
            order = this.OrderToDict(await venue.FetchOrder(orderId, symbol));
        }
        var finalStatus = this.StringAt(order, "status", "");
        if (finalStatus == "closed" || finalStatus == "canceled")
        {
            //  the venue ended it on the last poll — an expiry, a self-trade
            //  prevention, a post-only rejection of the remainder. Cancelling an
            //  order the venue already closed throws, and the partial fill this
            //  order carries is real: dropping it would hide a live position from
            //  the report AND from the unwind plan built out of it.
            return order;
        }
        try
        {
            await venue.CancelOrder(orderId, symbol);
        }
        catch (Exception)
        {
            //  the order may still be live. Reporting a fill we did not observe
            //  would be a lie, and continuing to the next hop on top of an
            //  unknown position is worse.
            this.RecordOpenOrder(report, this.StringAt(step, "exchangeId", ""), symbol, orderId, "cancel_failed");
            throw new ExchangeError("OrderRouter: cancelOrder failed and an order is left OPEN, refusing to proceed");
        }
        //  ALWAYS re-read after a cancel: the cancel and the fill can cross, and
        //  the observed order is the only authority on what actually happened
        return this.OrderToDict(await venue.FetchOrder(orderId, symbol));
    }

    /// <summary>
    /// Reports whether a venue is known NOT to support immediate-or-cancel.
    /// Defaults to TRUE on purpose: an unknown answer here must not fall through
    /// to a market order, because a rejected IOC is a loud, cheap failure and an
    /// unintended market order is a silent, expensive one.
    /// </summary>
    public bool VenueSupportsIoc(Exchange venue)
    {
        var features = this.AsDict(venue.features);
        var spot = this.DictAt(features, "spot");
        var createOrder = this.DictAt(spot, "createOrder");
        //  EVERY real ccxt exchange declares this as a dictionary of booleans —
        //  { "IOC": true, "FOK": true, "GTC": true, ... } — and not one declares
        //  it as a list. Reading it as a list only ever answered "empty", which is
        //  the same answer as "the venue said nothing", so the check always said
        //  yes and the market-order path below was unreachable.
        var timeInForceFlags = this.DictAt(createOrder, "timeInForce");
        if (timeInForceFlags.Count > 0)
        {
            //  a venue that enumerates its time-in-force values and leaves IOC out
            //  has said no, exactly as one that says IOC: false has
            return this.BoolAt(timeInForceFlags, "IOC", false);
        }
        //  a list is still honoured, for a caller-built stub venue
        var timeInForce = this.ListAt(createOrder, "timeInForce");
        if (timeInForce.Count == 0)
        {
            return true;
        }
        for (var i = 0; i < timeInForce.Count; i++)
        {
            if ((timeInForce[i] is string) && ((string)timeInForce[i]) == "IOC")
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Throws unless a single order's USD notional is known and within the
    /// per-trade cap.
    /// </summary>
    public void AssertUnderCap(dict step, double amount, double price, dict usdRates, dict options)
    {
        var cap = this.NumberAt(options, "maxNotionalUsd", this.maxNotionalUsd);
        if (cap > this.maxNotionalUsd)
        {
            cap = this.maxNotionalUsd;
        }
        if (cap > MaxNotionalUsd)
        {
            //  same ceiling as CheckExecutionPlanSafety, re-imposed at the last
            //  moment before an order goes out
            cap = MaxNotionalUsd;
        }
        var probe = new dict()
        {
            { "base", this.StringAt(step, "base", "") },
            { "quote", this.StringAt(step, "quote", "") },
            { "amount", amount },
        };
        var usdValue = this.NotionalUsd(probe, amount * price, usdRates);
        if (usdValue <= 0)
        {
            throw new ExchangeError("OrderRouter: refusing to place an order that cannot be valued in USD");
        }
        if (usdValue > cap * (1 + Tolerance))
        {
            throw new ExchangeError("OrderRouter: refusing to place an order above the per-trade USD notional cap");
        }
    }

    /// <summary>
    /// Verifies every step's input is already sitting on its venue, which is
    /// what atomic_ish actually requires.
    /// </summary>
    public async Task AssertPrefunded(list steps, Dictionary<string, Exchange> venues)
    {
        //  built as a list, not a map, so the first shortfall reported is the
        //  same one in all five languages
        var required = new list();
        for (var i = 0; i < steps.Count; i++)
        {
            var step = this.AsDict(steps[i]);
            var exchangeId = this.StringAt(step, "exchangeId", "");
            var amount = this.NumberAt(step, "amount", 0);
            var asset = "";
            double needed = 0;
            if (this.StringAt(step, "side", "") == "buy")
            {
                asset = this.StringAt(step, "quote", "");
                needed = amount * this.NumberAt(step, "limitPrice", 0);
            }
            else
            {
                asset = this.StringAt(step, "base", "");
                needed = amount;
            }
            var found = false;
            for (var j = 0; j < required.Count; j++)
            {
                var entry = this.AsDict(required[j]);
                if (this.StringAt(entry, "exchangeId", "") == exchangeId && this.StringAt(entry, "asset", "") == asset)
                {
                    entry["amount"] = this.NumberAt(entry, "amount", 0) + needed;
                    found = true;
                    break;
                }
            }
            if (!found)
            {
                required.Add(new dict() { { "exchangeId", exchangeId }, { "asset", asset }, { "amount", needed } });
            }
        }
        var balances = new dict();
        for (var i = 0; i < required.Count; i++)
        {
            var entry = this.AsDict(required[i]);
            var exchangeId = this.StringAt(entry, "exchangeId", "");
            if (this.ValueAt(balances, exchangeId) == null)
            {
                balances[exchangeId] = this.AsDict(await venues[exchangeId].fetchBalance());
            }
            var free = this.DictAt(this.DictAt(balances, exchangeId), "free");
            var asset = this.StringAt(entry, "asset", "");
            var available = this.NumberAt(free, asset, 0);
            if (available < this.NumberAt(entry, "amount", 0))
            {
                //  most routes fail this, and that is the correct outcome:
                //  atomic_ish names its own hedge, because there is no
                //  cross-venue atomicity and there cannot be
                throw new InsufficientFunds("OrderRouter: atomic_ish requires the whole route pre-funded, and " + exchangeId + " is short of " + asset);
            }
        }
    }

    /// <summary>
    /// Writes a reconciliation's downstream resize back into the working steps.
    /// </summary>
    public void ApplyResize(list steps, dict reconciliation)
    {
        var resized = this.ListAt(reconciliation, "resizedSteps");
        for (var i = 0; i < resized.Count; i++)
        {
            var entry = this.AsDict(resized[i]);
            var stepIndex = this.NumberAt(entry, "stepIndex", -1);
            for (var j = 0; j < steps.Count; j++)
            {
                var step = this.AsDict(steps[j]);
                if (this.NumberAt(step, "stepIndex", -1) == stepIndex)
                {
                    step["amount"] = this.NumberAt(entry, "amount", 0);
                    step["notionalQuote"] = this.NumberAt(entry, "notionalQuote", 0);
                    break;
                }
            }
        }
    }

    /// <summary>
    /// Marks every step from an index onwards as skipped after a halt.
    /// </summary>
    public void MarkRemainingSkipped(list results, int start)
    {
        for (var i = start; i < results.Count; i++)
        {
            var result = this.AsDict(results[i]);
            if (this.StringAt(result, "status", "") == "planned")
            {
                result["status"] = "skipped";
            }
        }
    }

    /// <summary>Appends one error to the report.</summary>
    public void RecordError(dict report, double stepIndex, string exchangeId, string symbol, string code)
    {
        lock (this.reportLock)
        {
            this.ListAt(report, "errors").Add(new dict() { { "stepIndex", stepIndex }, { "exchangeId", exchangeId }, { "symbol", symbol }, { "code", code } });
        }
    }

    /// <summary>
    /// Totals what the first hop spent and what the last hop produced.
    /// </summary>
    public void SummariseReport(dict report, list steps)
    {
        var results = this.ListAt(report, "steps");
        double lastHop = 0;
        for (var i = 0; i < steps.Count; i++)
        {
            var hopIndex = this.NumberAt(steps[i], "hopIndex", 0);
            if (hopIndex > lastHop)
            {
                lastHop = hopIndex;
            }
        }
        double filledIn = 0;
        double filledOut = 0;
        for (var i = 0; i < results.Count; i++)
        {
            var hopIndex = this.NumberAt(results[i], "hopIndex", 0);
            if (hopIndex == 0)
            {
                filledIn = filledIn + this.NumberAt(results[i], "inAmount", 0);
            }
            if (hopIndex == lastHop)
            {
                filledOut = filledOut + this.NumberAt(results[i], "outAmount", 0);
            }
        }
        report["filledIn"] = filledIn;
        report["filledOut"] = filledOut;
    }

    /// <summary>Waits for a number of milliseconds.</summary>
    public async Task Sleep(double milliseconds)
    {
        await Task.Delay((int)milliseconds);
    }

    /// <summary>
    /// The keys of a dictionary in ascending code-unit order, which is the order
    /// JavaScript's Array.prototype.sort produces for strings.
    /// </summary>
    public List<string> SortedKeys<T>(Dictionary<string, T> container)
    {
        var keys = new List<string>();
        if (container == null)
        {
            return keys;
        }
        foreach (var entry in container)
        {
            keys.Add(entry.Key);
        }
        keys.Sort(string.CompareOrdinal);
        return keys;
    }
}
