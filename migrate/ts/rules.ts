// Mapping tables from pmxt (pmxtjs / pmxt) to CCXT.
//
// This module is the single source of truth for the codemod, for the
// `ccxt-migrate rules` markdown dump, and for the tables in
// wiki/Migrate-From-PMXT.md. Verified against pmxt 2.54.0 and ccxt 4.5.x.

export type VenueRule = {
    /** CCXT exchange id, or null when CCXT has no integration for this venue. */
    ccxtId: string | null;
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
// pmxt is a prediction-market aggregator; CCXT is a spot/derivatives exchange
// library. Only two pmxt venues are also CCXT exchanges, and even there pmxt
// addresses the venue's prediction-market product while CCXT addresses its
// spot/perp product. Every other venue is a genuine coverage gap: the codemod
// reports it instead of emitting code that cannot work.
// ---------------------------------------------------------------------------

export const VENUES: Record<string, VenueRule> = {
    'Hyperliquid':   { ccxtId: 'hyperliquid', note: 'CCXT covers Hyperliquid spot + perpetuals. pmxt covers its prediction markets — re-point symbols at the perp/spot market you actually want.' },
    'GeminiTitan':   { ccxtId: 'gemini',      note: 'CCXT covers Gemini spot. pmxt covers Gemini Titan (prediction markets) — not the same product surface.' },
    'Polymarket':    { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'PolymarketUS':  { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Polymarket_us': { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Kalshi':        { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'KalshiDemo':    { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Limitless':     { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Probable':      { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Baozi':         { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Myriad':        { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Opinion':       { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Metaculus':     { ccxtId: null,          note: 'Forecasting platform. No CCXT integration.' },
    'Smarkets':      { ccxtId: null,          note: 'Betting exchange. No CCXT integration.' },
    'SuiBets':       { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Suibets':       { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Rain':          { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Hunch':         { ccxtId: null,          note: 'Prediction market. No CCXT integration.' },
    'Mock':          { ccxtId: null,          note: 'pmxt test double. Use a CCXT sandbox (exchange.setSandboxMode(true)) instead.' },
    'Router':        { ccxtId: null,          note: 'pmxt smart order router. CCXT has no cross-venue router — instantiate each exchange and route in your own code.' },
};

// ---------------------------------------------------------------------------
// Methods (keys are pmxt's camelCase names; the Python snake_case forms are
// derived automatically by `snakeCase()` below)
// ---------------------------------------------------------------------------

export const METHODS: Record<string, MethodRule> = {
    // --- markets ---------------------------------------------------------
    'loadMarkets':          { ccxt: 'loadMarkets',     kind: 'rest', note: 'Drop-in. Both return a map keyed by market identifier; CCXT keys it by unified symbol (e.g. "BTC/USDT").' },
    'fetchMarkets':         { ccxt: 'loadMarkets',     kind: 'rest', signature: 'fetchMarkets(params) -> loadMarkets()', note: 'pmxt returns a filtered array; CCXT returns a dict keyed by symbol and takes no query/sort/limit filters. Filter the loaded `exchange.markets` map yourself.' },
    'fetchMarketsPaginated':{ ccxt: 'loadMarkets',     kind: 'rest', note: 'CCXT loads the full market list in one call — there is nothing to paginate.' },
    'fetchMarket':          { ccxt: 'market',          kind: 'rest', signature: 'await fetchMarket(id) -> market(symbol)', note: 'CCXT market() is synchronous and reads the cache filled by loadMarkets().' },
    'filterMarkets':        { ccxt: null,              kind: 'helper', note: 'No CCXT equivalent. Filter Object.values(exchange.markets) yourself.' },
    'fetchEvents':          { ccxt: null,              kind: 'rest', note: 'CCXT has no event grouping — prediction-market concept.' },
    'fetchEventsPaginated': { ccxt: null,              kind: 'rest', note: 'CCXT has no event grouping — prediction-market concept.' },
    'fetchEvent':           { ccxt: null,              kind: 'rest', note: 'CCXT has no event grouping — prediction-market concept.' },
    'fetchEventMetadata':   { ccxt: null,              kind: 'rest', note: 'CCXT has no event grouping — prediction-market concept.' },
    'fetchSeries':          { ccxt: null,              kind: 'rest', note: 'CCXT has no series grouping — prediction-market concept.' },
    'filterEvents':         { ccxt: null,              kind: 'helper', note: 'CCXT has no event grouping — prediction-market concept.' },
    'getEventById':         { ccxt: null,              kind: 'helper', note: 'CCXT has no event grouping — prediction-market concept.' },
    'getEventBySlug':       { ccxt: null,              kind: 'helper', note: 'CCXT has no event grouping — prediction-market concept.' },

    // --- public market data ----------------------------------------------
    'fetchOrderBook':       { ccxt: 'fetchOrderBook',  kind: 'rest', signature: 'fetchOrderBook(outcomeId, limit, params) -> fetchOrderBook(symbol, limit, params)', note: 'First argument becomes a unified symbol. CCXT levels are [price, amount] arrays, not {price, size} objects.' },
    'fetchOrderBooks':      { ccxt: null,              kind: 'rest', note: 'No CCXT batch REST equivalent. Loop over fetchOrderBook, or use watchOrderBookForSymbols in ccxt.pro.' },
    'fetchOHLCV':           { ccxt: 'fetchOHLCV',      kind: 'rest', signature: 'fetchOHLCV(outcomeId, resolution, limit, start, end) -> fetchOHLCV(symbol, timeframe, since, limit, params)', note: 'Argument order changes (since comes before limit) and CCXT returns [timestamp, open, high, low, close, volume] arrays, not PriceCandle objects.' },
    'fetchTrades':          { ccxt: 'fetchTrades',     kind: 'rest', signature: 'fetchTrades(outcomeId, {limit}) -> fetchTrades(symbol, since, limit, params)', note: 'limit moves from an options object to the third positional argument.' },
    'fetchTicker':          { ccxt: 'fetchTicker',     kind: 'rest', note: 'pmxt exposes this on FeedClient only. CCXT puts it on the exchange itself.' },
    'fetchTickers':         { ccxt: 'fetchTickers',    kind: 'rest', note: 'pmxt exposes this on FeedClient only. CCXT puts it on the exchange itself.' },
    'preWarmMarket':        { ccxt: null,              kind: 'helper', note: 'pmxt sidecar cache warm-up. CCXT has no sidecar — remove the call.' },

    // --- account ----------------------------------------------------------
    'fetchBalance':         { ccxt: 'fetchBalance',    kind: 'rest', signature: 'fetchBalance(address) -> fetchBalance(params)', note: 'CCXT returns a dict keyed by currency code with free/used/total, not a list of Balance objects. There is no address argument — credentials identify the account.' },
    'fetchPositions':       { ccxt: 'fetchPositions',  kind: 'rest', signature: 'fetchPositions(address) -> fetchPositions(symbols, params)', note: 'CCXT takes an optional symbol filter, not an address.' },

    // --- orders -----------------------------------------------------------
    'createOrder':          { ccxt: 'createOrder',     kind: 'rest', signature: 'createOrder({marketId, outcomeId, side, type, amount, price}) -> createOrder(symbol, type, side, amount, price, params)', note: 'Object argument becomes positional arguments, and the order of type/side is swapped relative to how pmxt reads.' },
    'buildOrder':           { ccxt: 'createOrder',     kind: 'rest', note: 'CCXT signs and submits in a single createOrder call — there is no separate build step.' },
    'submitOrder':          { ccxt: 'createOrder',     kind: 'rest', note: 'CCXT signs and submits in a single createOrder call — there is no separate submit step.' },
    'cancelOrder':          { ccxt: 'cancelOrder',     kind: 'rest', signature: 'cancelOrder(orderId) -> cancelOrder(id, symbol, params)', note: 'Most CCXT exchanges require the symbol as the second argument.' },
    'fetchOrder':           { ccxt: 'fetchOrder',      kind: 'rest', signature: 'fetchOrder(orderId) -> fetchOrder(id, symbol, params)', note: 'Most CCXT exchanges require the symbol as the second argument.' },
    'fetchOpenOrders':      { ccxt: 'fetchOpenOrders', kind: 'rest', signature: 'fetchOpenOrders(marketId) -> fetchOpenOrders(symbol, since, limit, params)', note: 'First argument becomes a unified symbol.' },
    'fetchClosedOrders':    { ccxt: 'fetchClosedOrders', kind: 'rest', signature: 'fetchClosedOrders(params) -> fetchClosedOrders(symbol, since, limit, params)', note: 'Options object becomes positional arguments.' },
    'fetchAllOrders':       { ccxt: 'fetchOrders',     kind: 'rest', signature: 'fetchAllOrders(params) -> fetchOrders(symbol, since, limit, params)', note: 'Renamed, and the options object becomes positional arguments.' },
    'fetchMyTrades':        { ccxt: 'fetchMyTrades',   kind: 'rest', signature: 'fetchMyTrades(params) -> fetchMyTrades(symbol, since, limit, params)', note: 'Options object becomes positional arguments.' },

    // --- websocket (ccxt.pro) ---------------------------------------------
    'watchOrderBook':       { ccxt: 'watchOrderBook',  kind: 'pro', signature: 'watchOrderBook(outcomeId, limit, params) -> watchOrderBook(symbol, limit, params)', note: 'Same await-in-a-loop pattern. Requires a CCXT Pro instance: `new ccxt.pro.<id>()` in JS/TS, `import ccxt.pro as ccxt` in Python.' },
    'watchOrderBooks':      { ccxt: 'watchOrderBookForSymbols', kind: 'pro', note: 'Renamed; CCXT takes an array of unified symbols.' },
    'watchAllOrderBooks':   { ccxt: null,              kind: 'pro', note: 'CCXT has no subscribe-to-everything stream. Pass the symbols you want to watchOrderBookForSymbols.' },
    'watchTrades':          { ccxt: 'watchTrades',     kind: 'pro', signature: 'watchTrades(outcomeId, ...) -> watchTrades(symbol, since, limit, params)', note: 'Same await-in-a-loop pattern. pmxt also accepts a callback; CCXT never does.' },
    'unwatchOrderBook':     { ccxt: 'unWatchOrderBook', kind: 'pro', signature: 'unwatchOrderBook(outcomeId) -> unWatchOrderBook(symbol, params)', note: 'Note the capital W in the CCXT spelling.' },
    'watchPrices':          { ccxt: 'watchTicker',     kind: 'pro', note: 'Closest CCXT equivalent is watchTicker/watchTickers.' },
    'watchUserPositions':   { ccxt: 'watchPositions',  kind: 'pro', note: 'CCXT returns updates from an await, never through a callback.' },
    'watchUserTransactions':{ ccxt: 'watchMyTrades',   kind: 'pro', note: 'Closest CCXT equivalent; shapes differ.' },
    'watchAddress':         { ccxt: null,              kind: 'pro', note: 'CCXT subscribes with credentials, not by wallet address.' },
    'unwatchAddress':       { ccxt: null,              kind: 'pro', note: 'CCXT subscribes with credentials, not by wallet address.' },
    'firehose':             { ccxt: null,              kind: 'pro', note: 'No CCXT equivalent. Subscribe per symbol.' },
    'close':                { ccxt: 'close',           kind: 'pro', note: 'Drop-in. Required for ccxt.pro and for ccxt.async_support in Python.' },

    // --- auth / session ----------------------------------------------------
    'getAuthNonce':         { ccxt: null,              kind: 'helper', note: 'pmxt hosted-session handshake. CCXT signs every request from your credentials — delete the session dance.' },
    'loginWithSignature':   { ccxt: null,              kind: 'helper', note: 'pmxt hosted-session handshake. CCXT signs every request from your credentials — delete the session dance.' },
    'logout':               { ccxt: null,              kind: 'helper', note: 'pmxt hosted-session handshake. CCXT is stateless — delete the call.' },
    'isSessionActive':      { ccxt: null,              kind: 'helper', note: 'pmxt hosted-session handshake. CCXT is stateless — delete the call.' },

    // --- pmxt-only surface -------------------------------------------------
    'callApi':                  { ccxt: null, kind: 'helper', note: 'Closest CCXT equivalent is an implicit API method (exchange.publicGetX / exchange.privatePostY) — see the "Implicit API" page for your exchange.' },
    'getExecutionPrice':        { ccxt: null, kind: 'helper', note: 'No CCXT equivalent. Walk the order book yourself — CCXT levels are [price, amount] arrays.' },
    'getExecutionPriceDetailed':{ ccxt: null, kind: 'helper', note: 'No CCXT equivalent. Walk the order book yourself — CCXT levels are [price, amount] arrays.' },
    'fetchMarketMatches':       { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchMatches':             { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchEventMatches':        { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchMatchedMarkets':      { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchMatchedPrices':       { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent.' },
    'fetchRelatedMarkets':      { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent.' },
    'compareMarketPrices':      { ccxt: null, kind: 'rest', note: 'pmxt cross-venue matching. No CCXT equivalent — compare tickers from two CCXT exchanges yourself.' },
    'fetchHedges':              { ccxt: null, kind: 'rest', note: 'pmxt router feature. No CCXT equivalent.' },
    'fetchArbitrage':           { ccxt: null, kind: 'rest', note: 'pmxt router feature. No CCXT equivalent — see the arbitrage examples in the CCXT manual.' },
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
    'pmxtApiKey':    { ccxt: null,            note: 'CCXT talks to the venue directly — there is no CCXT-hosted API to authenticate against, so this key has no counterpart.' },
    'apiKey':        { ccxt: 'apiKey',        note: 'Drop-in.' },
    'privateKey':    { ccxt: 'privateKey',    note: 'Drop-in on the CCXT exchanges that use wallet signing.' },
    'walletAddress': { ccxt: 'walletAddress', note: 'Drop-in on the CCXT exchanges that use wallet signing.' },
    'funderAddress': { ccxt: null,            note: 'Polymarket-specific. No CCXT counterpart.' },
    'signatureType': { ccxt: null,            note: 'Polymarket-specific. No CCXT counterpart.' },
    'baseUrl':       { ccxt: 'urls',          note: 'Override per-endpoint via exchange.urls, or call exchange.setSandboxMode(true) for a testnet.' },
    'timeout':       { ccxt: 'timeout',       note: 'Drop-in (milliseconds in both).' },
};

// ---------------------------------------------------------------------------
// Return-shape differences the codemod cannot rewrite safely
// ---------------------------------------------------------------------------

export const SHAPES: { subject: string; pmxt: string; ccxt: string }[] = [
    { subject: 'Market list',   pmxt: 'UnifiedMarket[] with .marketId / .title / .outcomes', ccxt: 'dict keyed by unified symbol, each with ["symbol"], ["base"], ["quote"], ["precision"], ["limits"]' },
    { subject: 'Instrument id', pmxt: 'outcomeId (CLOB token id / market ticker)',            ccxt: 'unified symbol string, e.g. "BTC/USDT" or "BTC/USDC:USDC"' },
    { subject: 'Prices',        pmxt: '0.0-1.0 probability',                                  ccxt: 'quote-currency price — no 0-1 bound' },
    { subject: 'Order book',    pmxt: '{bids: [{price, size}], asks: [...]}',                  ccxt: '{"bids": [[price, amount]], "asks": [[price, amount]], "timestamp", "datetime", "nonce"}' },
    { subject: 'OHLCV',         pmxt: 'PriceCandle[] with .timestamp/.open/.high/.low/.close', ccxt: '[[timestamp, open, high, low, close, volume]] arrays' },
    { subject: 'Balance',       pmxt: 'Balance[] with .currency/.total/.available/.locked',    ccxt: 'dict: balance["USDT"]["free"] / ["used"] / ["total"]' },
    { subject: 'Order',         pmxt: '.marketId + .outcomeId, status "canceled"|"rejected"',  ccxt: '["symbol"], ["id"], ["status"] one of "open"|"closed"|"canceled"' },
    { subject: 'Position',      pmxt: '.size / .entryPrice / .unrealizedPnL',                  ccxt: '["contracts"], ["entryPrice"], ["unrealizedPnl"], ["side"]' },
    { subject: 'Timestamps',    pmxt: 'Unix ms (and datetime objects on some params)',          ccxt: 'Unix ms integers, plus an ISO-8601 ["datetime"] string' },
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
