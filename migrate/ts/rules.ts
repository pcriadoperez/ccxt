// Mapping tables from pmxt (pmxtjs / pmxt) to CCXT.
//
// This module is the single source of truth for the codemod, for the
// `ccxt-migrate rules` markdown dump, and for the tables in
// wiki/Migrate-From-PMXT.md. Verified against pmxt 2.54.0 and ccxt 4.5.x.

export type VenueRule = {
    /** CCXT exchange id, or null when CCXT has no integration for this venue. */
    ccxtId: string | null;
    /**
     * CCXT namespace the exchange lives in. 'prediction' means
     * `ccxt.prediction.<id>` in JS and `ccxt.prediction.<id>` (async-only) in
     * Python; undefined means the top-level crypto namespace.
     */
    namespace?: 'prediction';
    note: string;
};

export type MethodKind = 'rest' | 'pro' | 'helper';

export type MethodRule = {
    /** CCXT method name, or null when CCXT has no equivalent. */
    ccxt: string | null;
    kind: MethodKind;
    /** Human-readable signature change, empty when the call is drop-in. */
    signature?: string;
    note: string;
};

// ---------------------------------------------------------------------------
// Venues
//
// Since ccxt 4.5.77 there is a dedicated `ccxt.prediction` namespace covering
// Polymarket, Kalshi, Limitless, Myriad, Opinion and Hyperliquid's prediction
// markets, with the same events -> markets -> outcomes model pmxt uses and the
// same 0..1 pricing. Those venues are a near drop-in move. The remaining pmxt
// venues have no CCXT integration at all: the codemod reports them instead of
// emitting code that cannot work.
// ---------------------------------------------------------------------------

export const VENUES: Record<string, VenueRule> = {
    'Polymarket':    { 'ccxtId': 'polymarket', 'namespace': 'prediction', 'note': 'Direct match: ccxt.prediction.polymarket, same events/markets/outcomes model.' },
    'PolymarketUS':  { 'ccxtId': 'polymarket', 'namespace': 'prediction', 'note': 'Maps to ccxt.prediction.polymarket. CCXT ships one Polymarket integration — confirm it reaches the US-regulated entity your account trades on before going live.' },
    'Polymarket_us': { 'ccxtId': 'polymarket', 'namespace': 'prediction', 'note': 'Maps to ccxt.prediction.polymarket. CCXT ships one Polymarket integration — confirm it reaches the US-regulated entity your account trades on before going live.' },
    'Kalshi':        { 'ccxtId': 'kalshi', 'namespace': 'prediction', 'note': 'Direct match: ccxt.prediction.kalshi.' },
    'KalshiDemo':    { 'ccxtId': 'kalshi', 'namespace': 'prediction', 'note': 'Maps to ccxt.prediction.kalshi — call exchange.setSandboxMode(true) for the demo environment instead of using a separate class.' },
    'Limitless':     { 'ccxtId': 'limitless', 'namespace': 'prediction', 'note': 'Direct match: ccxt.prediction.limitless.' },
    'Myriad':        { 'ccxtId': 'myriad', 'namespace': 'prediction', 'note': 'Direct match: ccxt.prediction.myriad.' },
    'Opinion':       { 'ccxtId': 'opinion', 'namespace': 'prediction', 'note': 'Direct match: ccxt.prediction.opinion.' },
    'Hyperliquid':   { 'ccxtId': 'hyperliquid', 'namespace': 'prediction', 'note': 'pmxt addresses Hyperliquid prediction markets, so ccxt.prediction.hyperliquid is the like-for-like target. Use the top-level ccxt.hyperliquid only if you actually want its spot/perp markets.' },
    'GeminiTitan':   { 'ccxtId': 'gemini', 'note': 'CCXT covers Gemini spot, not Gemini Titan prediction markets — this is a product-surface change, not a drop-in swap.' },
    'Probable':      { 'ccxtId': null, 'note': 'Prediction market. No CCXT integration.' },
    'Baozi':         { 'ccxtId': null, 'note': 'Prediction market. No CCXT integration.' },
    'Metaculus':     { 'ccxtId': null, 'note': 'Forecasting platform. No CCXT integration.' },
    'Smarkets':      { 'ccxtId': null, 'note': 'Betting exchange. No CCXT integration.' },
    'SuiBets':       { 'ccxtId': null, 'note': 'Prediction market. No CCXT integration.' },
    'Suibets':       { 'ccxtId': null, 'note': 'Prediction market. No CCXT integration.' },
    'Rain':          { 'ccxtId': null, 'note': 'Prediction market. No CCXT integration.' },
    'Hunch':         { 'ccxtId': null, 'note': 'Prediction market. No CCXT integration.' },
    'Mock':          { 'ccxtId': null, 'note': 'pmxt test double. Use a CCXT sandbox (exchange.setSandboxMode(true)) instead.' },
    'Router':        { 'ccxtId': null, 'note': 'pmxt smart order router. CCXT has no cross-venue router — instantiate each exchange and route in your own code.' },
};

// ---------------------------------------------------------------------------
// Methods (keys are pmxt's camelCase names; the Python snake_case forms are
// derived automatically by `snakeCase()` below)
// ---------------------------------------------------------------------------

export const METHODS: Record<string, MethodRule> = {
    // --- markets ---------------------------------------------------------
    'loadMarkets':          { 'ccxt': 'loadMarkets', 'kind': 'rest', 'note': 'Drop-in. Both return a map keyed by market identifier; CCXT keys it by unified symbol (e.g. "BTC/USDT").' },
    'fetchMarkets':         { 'ccxt': 'loadMarkets', 'kind': 'rest', 'signature': 'fetchMarkets(params) -> loadMarkets()', 'note': 'pmxt returns a filtered array; CCXT returns a dict keyed by symbol and takes no query/sort/limit filters. Filter the loaded `exchange.markets` map yourself.' },
    'fetchMarketsPaginated':{ 'ccxt': 'loadMarkets', 'kind': 'rest', 'note': 'CCXT loads the full market list in one call — there is nothing to paginate.' },
    'fetchMarket':          { 'ccxt': 'market', 'kind': 'rest', 'signature': 'await fetchMarket(id) -> market(symbol)', 'note': 'CCXT market() is synchronous and reads the cache filled by loadMarkets().' },
    'filterMarkets':        { 'ccxt': null, 'kind': 'helper', 'note': 'No CCXT equivalent. Filter Object.values(exchange.markets) yourself.' },
    'fetchEvents':          { 'ccxt': 'fetchEvents', 'kind': 'rest', 'signature': 'fetchEvents(params) -> fetchEvents(params)', 'note': 'CCXT requires the call to be scoped by at least one of query / queries / tags / eventId / slug, otherwise it throws ArgumentsRequired. For an unscoped browse use fetchMarkets().' },
    'fetchEventsPaginated': { 'ccxt': 'fetchEvents', 'kind': 'rest', 'note': 'CCXT returns one page; pass `limit` and narrow the scope instead of paginating.' },
    'fetchEvent':           { 'ccxt': 'fetchEvent', 'kind': 'rest', 'signature': 'fetchEvent(id) -> fetchEvent(id, params)', 'note': 'Accepts an id, slug or ticker.' },
    'fetchEventMetadata':   { 'ccxt': 'fetchEvent', 'kind': 'rest', 'note': 'No separate metadata call — the event structure returned by fetchEvent carries the fields.' },
    'fetchSeries':          { 'ccxt': 'fetchEvents', 'kind': 'rest', 'note': 'No first-class series object. Scope fetchEvents by `tags` — they resolve to Kalshi series, Polymarket tag listings, Limitless categories and Myriad keyword searches.' },
    'filterEvents':         { 'ccxt': null, 'kind': 'helper', 'note': 'No client-side filter helper. Scope fetchEvents server-side, or filter the returned array yourself.' },
    'getEventById':         { 'ccxt': 'fetchEvent', 'kind': 'helper', 'note': 'CCXT fetches by id rather than reading a local cache; discovered events are also cached on exchange.events.' },
    'getEventBySlug':       { 'ccxt': 'fetchEvent', 'kind': 'helper', 'note': 'fetchEvent accepts a slug as well as an id.' },

    // --- public market data ----------------------------------------------
    'fetchOrderBook':       { 'ccxt': 'fetchOrderBook', 'kind': 'rest', 'signature': 'fetchOrderBook(outcomeId, limit, params) -> fetchOrderBook(symbol, limit, params)', 'note': 'First argument becomes the CCXT outcome handle (an outcome id is also accepted). CCXT levels are [price, amount] arrays, not {price, size} objects.' },
    'fetchOrderBooks':      { 'ccxt': null, 'kind': 'rest', 'note': 'No CCXT batch REST equivalent. Loop over fetchOrderBook, or use watchOrderBookForSymbols in ccxt.pro.' },
    'fetchOHLCV':           { 'ccxt': 'fetchOHLCV', 'kind': 'rest', 'signature': 'fetchOHLCV(outcomeId, resolution, limit, start, end) -> fetchOHLCV(outcome, timeframe, since, limit, params)', 'note': 'Argument order changes (since comes before limit) and CCXT returns [timestamp, open, high, low, close, volume] arrays, not PriceCandle objects.' },
    'fetchTrades':          { 'ccxt': 'fetchTrades', 'kind': 'rest', 'signature': 'fetchTrades(outcomeId, {limit}) -> fetchTrades(outcome, since, limit, params)', 'note': 'limit moves from an options object to the third positional argument.' },
    'fetchTicker':          { 'ccxt': 'fetchTicker', 'kind': 'rest', 'note': 'pmxt exposes this on FeedClient only. CCXT puts it on the exchange itself.' },
    'fetchTickers':         { 'ccxt': 'fetchTickers', 'kind': 'rest', 'note': 'pmxt exposes this on FeedClient only. CCXT puts it on the exchange itself.' },
    'preWarmMarket':        { 'ccxt': null, 'kind': 'helper', 'note': 'pmxt sidecar cache warm-up. CCXT has no sidecar — remove the call.' },

    // --- account ----------------------------------------------------------
    'fetchBalance':         { 'ccxt': 'fetchBalance', 'kind': 'rest', 'signature': 'fetchBalance(address) -> fetchBalance(params)', 'note': 'CCXT returns a dict keyed by currency code with free/used/total, not a list of Balance objects. There is no address argument — credentials identify the account.' },
    'fetchPositions':       { 'ccxt': 'fetchPositions', 'kind': 'rest', 'signature': 'fetchPositions(address) -> fetchPositions(symbols, params)', 'note': 'CCXT takes an optional symbol filter, not an address.' },

    // --- orders -----------------------------------------------------------
    'createOrder':          { 'ccxt': 'createOrder', 'kind': 'rest', 'signature': 'createOrder({marketId, outcomeId, side, type, amount, price}) -> createOrder(outcome, type, side, amount, price, params)', 'note': 'Object argument becomes positional arguments and type/side swap order. On prediction venues `amount` is a number of shares and `price` stays a 0..1 probability, so the numbers carry over unchanged.' },
    'buildOrder':           { 'ccxt': 'createOrder', 'kind': 'rest', 'note': 'CCXT signs and submits in a single createOrder call — there is no separate build step.' },
    'submitOrder':          { 'ccxt': 'createOrder', 'kind': 'rest', 'note': 'CCXT signs and submits in a single createOrder call — there is no separate submit step.' },
    'cancelOrder':          { 'ccxt': 'cancelOrder', 'kind': 'rest', 'signature': 'cancelOrder(orderId) -> cancelOrder(id, symbol, params)', 'note': 'Most CCXT exchanges require the symbol as the second argument.' },
    'fetchOrder':           { 'ccxt': 'fetchOrder', 'kind': 'rest', 'signature': 'fetchOrder(orderId) -> fetchOrder(id, symbol, params)', 'note': 'Most CCXT exchanges require the symbol as the second argument.' },
    'fetchOpenOrders':      { 'ccxt': 'fetchOpenOrders', 'kind': 'rest', 'signature': 'fetchOpenOrders(marketId) -> fetchOpenOrders(symbol, since, limit, params)', 'note': 'First argument becomes a unified symbol.' },
    'fetchClosedOrders':    { 'ccxt': 'fetchClosedOrders', 'kind': 'rest', 'signature': 'fetchClosedOrders(params) -> fetchClosedOrders(symbol, since, limit, params)', 'note': 'Options object becomes positional arguments.' },
    'fetchAllOrders':       { 'ccxt': 'fetchOrders', 'kind': 'rest', 'signature': 'fetchAllOrders(params) -> fetchOrders(symbol, since, limit, params)', 'note': 'Renamed, and the options object becomes positional arguments.' },
    'fetchMyTrades':        { 'ccxt': 'fetchMyTrades', 'kind': 'rest', 'signature': 'fetchMyTrades(params) -> fetchMyTrades(symbol, since, limit, params)', 'note': 'Options object becomes positional arguments.' },

    // --- websocket (ccxt.pro) ---------------------------------------------
    'watchOrderBook':       { 'ccxt': 'watchOrderBook', 'kind': 'pro', 'signature': 'watchOrderBook(outcomeId, limit, params) -> watchOrderBook(symbol, limit, params)', 'note': 'Same await-in-a-loop pattern. Requires a CCXT Pro instance: `new ccxt.pro.<id>()` in JS/TS, `import ccxt.pro as ccxt` in Python.' },
    'watchOrderBooks':      { 'ccxt': 'watchOrderBookForSymbols', 'kind': 'pro', 'note': 'Renamed; CCXT takes an array of unified symbols.' },
    'watchAllOrderBooks':   { 'ccxt': null, 'kind': 'pro', 'note': 'CCXT has no subscribe-to-everything stream. Pass the symbols you want to watchOrderBookForSymbols.' },
    'watchTrades':          { 'ccxt': 'watchTrades', 'kind': 'pro', 'signature': 'watchTrades(outcomeId, ...) -> watchTrades(symbol, since, limit, params)', 'note': 'Same await-in-a-loop pattern. pmxt also accepts a callback; CCXT never does.' },
    'unwatchOrderBook':     { 'ccxt': 'unWatchOrderBook', 'kind': 'pro', 'signature': 'unwatchOrderBook(outcomeId) -> unWatchOrderBook(symbol, params)', 'note': 'Note the capital W in the CCXT spelling.' },
    'watchPrices':          { 'ccxt': 'watchTicker', 'kind': 'pro', 'note': 'Closest CCXT equivalent is watchTicker/watchTickers.' },
    'watchUserPositions':   { 'ccxt': 'watchPositions', 'kind': 'pro', 'note': 'CCXT returns updates from an await, never through a callback.' },
    'watchUserTransactions':{ 'ccxt': 'watchMyTrades', 'kind': 'pro', 'note': 'Closest CCXT equivalent; shapes differ.' },
    'watchAddress':         { 'ccxt': null, 'kind': 'pro', 'note': 'CCXT subscribes with credentials, not by wallet address.' },
    'unwatchAddress':       { 'ccxt': null, 'kind': 'pro', 'note': 'CCXT subscribes with credentials, not by wallet address.' },
    'firehose':             { 'ccxt': null, 'kind': 'pro', 'note': 'No CCXT equivalent. Subscribe per symbol.' },
    'close':                { 'ccxt': 'close', 'kind': 'pro', 'note': 'Drop-in. Required for ccxt.pro and for ccxt.async_support in Python.' },

    // --- auth / session ----------------------------------------------------
    'getAuthNonce':         { 'ccxt': null, 'kind': 'helper', 'note': 'pmxt hosted-session handshake. CCXT signs every request from your credentials — delete the session dance.' },
    'loginWithSignature':   { 'ccxt': null, 'kind': 'helper', 'note': 'pmxt hosted-session handshake. CCXT signs every request from your credentials — delete the session dance.' },
    'logout':               { 'ccxt': null, 'kind': 'helper', 'note': 'pmxt hosted-session handshake. CCXT is stateless — delete the call.' },
    'isSessionActive':      { 'ccxt': null, 'kind': 'helper', 'note': 'pmxt hosted-session handshake. CCXT is stateless — delete the call.' },

    // --- pmxt-only surface -------------------------------------------------
    'callApi':                  { 'ccxt': null, 'kind': 'helper', 'note': 'Closest CCXT equivalent is an implicit API method (exchange.publicGetX / exchange.privatePostY) — see the "Implicit API" page for your exchange.' },
    'getExecutionPrice':        { 'ccxt': 'fetchTradeQuote', 'kind': 'rest', 'note': 'CCXT exposes fetchTradeQuote on AMM prediction venues. On CLOB venues there is no quote endpoint — walk the order book yourself ([price, amount] arrays).' },
    'getExecutionPriceDetailed':{ 'ccxt': 'fetchTradeQuote', 'kind': 'rest', 'note': 'CCXT exposes fetchTradeQuote on AMM prediction venues. On CLOB venues there is no quote endpoint — walk the order book yourself ([price, amount] arrays).' },
    'fetchMarketMatches':       { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchMatches':             { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchEventMatches':        { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchMatchedMarkets':      { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchMatchedPrices':       { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchRelatedMarkets':      { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent.' },
    'compareMarketPrices':      { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt cross-venue matching. No CCXT equivalent — compare tickers from two CCXT exchanges yourself.' },
    'fetchHedges':              { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt router feature. No CCXT equivalent.' },
    'fetchArbitrage':           { 'ccxt': null, 'kind': 'rest', 'note': 'pmxt router feature. No CCXT equivalent — see the arbitrage examples in the CCXT manual.' },
};

// ---------------------------------------------------------------------------
// Errors — pmxt's hierarchy is modelled on CCXT's, so most map by name
// ---------------------------------------------------------------------------

export const ERRORS: Record<string, string> = {
    'PmxtError':           'ExchangeError',
    'BadRequest':          'BadRequest',
    'AuthenticationError': 'AuthenticationError',
    'PermissionDenied':    'PermissionDenied',
    'NotFoundError':       'ExchangeError',
    'OrderNotFound':       'OrderNotFound',
    'MarketNotFound':      'BadSymbol',
    'EventNotFound':       'BadSymbol',
    'RateLimitExceeded':   'RateLimitExceeded',
    'InvalidOrder':        'InvalidOrder',
    'InsufficientFunds':   'InsufficientFunds',
    'ValidationError':     'BadRequest',
    'NetworkError':        'NetworkError',
    'ExchangeNotAvailable':'ExchangeNotAvailable',
    'NotSupported':        'NotSupported',
};

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export type OptionRule = { ccxt: string | null; note: string };

export const OPTIONS: Record<string, OptionRule> = {
    'pmxtApiKey':    { 'ccxt': null, 'note': 'CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.' },
    'apiKey':        { 'ccxt': 'apiKey', 'note': 'Drop-in.' },
    'privateKey':    { 'ccxt': 'privateKey', 'note': 'Drop-in on the CCXT exchanges that use wallet signing.' },
    'walletAddress': { 'ccxt': 'walletAddress', 'note': 'Drop-in on the CCXT exchanges that use wallet signing.' },
    'funderAddress': { 'ccxt': null, 'note': 'Polymarket-specific. No CCXT counterpart.' },
    'signatureType': { 'ccxt': null, 'note': 'Polymarket-specific. No CCXT counterpart.' },
    'baseUrl':       { 'ccxt': 'urls', 'note': 'Override per-endpoint via exchange.urls, or call exchange.setSandboxMode(true) for a testnet.' },
    'timeout':       { 'ccxt': 'timeout', 'note': 'Drop-in (milliseconds in both).' },
};

// ---------------------------------------------------------------------------
// Return-shape differences the codemod cannot rewrite safely
// ---------------------------------------------------------------------------

export const SHAPES: { subject: string; pmxt: string; ccxt: string }[] = [
    { 'subject': 'Market list', 'pmxt': 'UnifiedMarket[] with .marketId / .title / .outcomes', 'ccxt': 'dict keyed by unified symbol, each with ["symbol"], ["base"], ["quote"], ["precision"], ["limits"]' },
    { 'subject': 'Instrument id', 'pmxt': 'outcomeId (CLOB token id / market ticker)', 'ccxt': 'prediction venues: an outcome handle like "TRUMP_OUT_PRESIDENT_2027:YES" (an outcome id is also accepted). Crypto venues: a unified symbol, e.g. "BTC/USDT"' },
    { 'subject': 'Prices', 'pmxt': '0.0-1.0 probability', 'ccxt': 'prediction venues: also 0.0-1.0 per share, so the numbers carry over. Crypto venues: quote-currency price with no 0-1 bound' },
    { 'subject': 'Order book', 'pmxt': '{bids: [{price, size}], asks: [...]}', 'ccxt': '{"bids": [[price, amount]], "asks": [[price, amount]], "timestamp", "datetime", "nonce"}' },
    { 'subject': 'OHLCV', 'pmxt': 'PriceCandle[] with .timestamp/.open/.high/.low/.close', 'ccxt': '[[timestamp, open, high, low, close, volume]] arrays' },
    { 'subject': 'Balance', 'pmxt': 'Balance[] with .currency/.total/.available/.locked', 'ccxt': 'dict: balance["USDT"]["free"] / ["used"] / ["total"]' },
    { 'subject': 'Order', 'pmxt': '.marketId + .outcomeId, status "canceled"|"rejected"', 'ccxt': '["id"], ["status"] one of "open"|"closed"|"canceled", addressed by outcome handle on prediction venues' },
    { 'subject': 'Position', 'pmxt': '.size / .entryPrice / .unrealizedPnL', 'ccxt': '["contracts"], ["entryPrice"], ["unrealizedPnl"], ["side"]' },
    { 'subject': 'Timestamps', 'pmxt': 'Unix ms (and datetime objects on some params)', 'ccxt': 'Unix ms integers, plus an ISO-8601 ["datetime"] string' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** camelCase -> snake_case, matching pmxt's Python naming (fetchOHLCV -> fetch_ohlcv). */
export function snakeCase (name: string): string {
    return name
        .replace (/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace (/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase ();
}

/** Look up a method rule by either its camelCase or snake_case spelling. */
export function methodRule (name: string): [string, MethodRule] | undefined {
    if (name in METHODS) {
        return [ name, METHODS[name] ];
    }
    for (const key of Object.keys (METHODS)) {
        if (snakeCase (key) === name) {
            return [ key, METHODS[key] ];
        }
    }
    return undefined;
}
