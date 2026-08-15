function listFromEnv (name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function boolFromEnv (name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
}

// Parses "exchangeId:number,exchangeId:number" into a lookup map. Used for per-exchange
// overrides where a single global default can't be right — see maxSymbolsPerExchangeOverrides.
function numberMapFromEnv (name: string): Map<string, number> {
    const raw = process.env[name];
    const map = new Map<string, number>();
    if (!raw) return map;
    for (const pair of raw.split(',')) {
        const [id, value] = pair.split(':').map((s) => s.trim());
        if (id && value && !Number.isNaN(Number(value))) {
            map.set(id, Number(value));
        }
    }
    return map;
}

export const config = {
    port: Number(process.env['PORT'] ?? 8080),
    host: process.env['HOST'] ?? '0.0.0.0',

    // When true, discover every ccxt.pro exchange that supports watchOrderBook, load its markets,
    // and build the routable symbol universe dynamically (see src/discovery/). When false, use the
    // explicit `exchanges`/`symbols` lists below — the conservative default for local dev, since
    // discovery mode fans out to ~76 exchanges and can take minutes + hit rate limits on first run.
    discoverAllExchanges: boolFromEnv('ORDER_ROUTER_DISCOVER_ALL', false),

    // Exchanges to skip during discovery: known geo-blocked/unreachable from a given deployment host,
    // or exchanges whose loadMarkets/WS is known-broken. Also applied as a filter on the explicit list.
    excludeExchanges: listFromEnv('ORDER_ROUTER_EXCLUDE_EXCHANGES', []),

    // A symbol is only worth subscribing to if it's tradable on 2+ exchanges — a symbol listed on
    // exactly one exchange has nothing to route between, so it costs a subscription/memory/CPU for
    // zero routing value. Raise this to restrict to more-liquid, more-cross-listed symbols.
    minExchangesPerSymbol: Number(process.env['ORDER_ROUTER_MIN_EXCHANGES_PER_SYMBOL'] ?? 2),

    // Bounded concurrency for the discovery-phase loadMarkets() fan-out, to avoid hammering many
    // exchanges' REST endpoints simultaneously at startup.
    loadMarketsConcurrency: Number(process.env['ORDER_ROUTER_LOAD_MARKETS_CONCURRENCY'] ?? 8),

    // Exchanges that support watchOrderBookForSymbols still enforce a server-side cap on how many
    // symbols/streams one subscription (or one session) can cover — observed directly: Coinbase
    // ("too many L2 streams requested in a single session"), Bitget ("subscribe over limit,
    // max:1000"), KuCoin (rejects an overlong comma-joined topic string). A single unchunked
    // watchOrderBookForSymbols(allSymbols) call trips these once the routable symbol count gets
    // large. Chunking keeps each subscription well under any of the observed limits; each chunk
    // runs its own independent watch loop.
    maxSymbolsPerSubscription: Number(process.env['ORDER_ROUTER_MAX_SYMBOLS_PER_SUBSCRIPTION'] ?? 50),

    // Some exchanges cap total concurrent streams *per session*, not per subscribe message — e.g.
    // Coinbase rejected our default chunk size outright with "too many L2 streams requested in a
    // single session" even though each individual chunk was well under the message-size cap,
    // because running many chunks concurrently still opens that many channels on one connection.
    // Chunking alone can't fix a session-wide cap; the total symbol count assigned to that
    // exchange has to come down. No single default is safe here — this is genuinely per-exchange,
    // discovered empirically (the same way skip-tests.json accumulates known exchange quirks in
    // the main ccxt repo) rather than documented anywhere reliable. Format: "coinbase:30,foo:100".
    // Undocumented/unset exchanges get no cap (limited only by maxSymbolsPerSubscription chunking).
    maxSymbolsPerExchangeOverrides: numberMapFromEnv('ORDER_ROUTER_MAX_SYMBOLS_PER_EXCHANGE'),

    // Number of child-process shards to spread exchange connectors across. Each shard owns a subset
    // of exchanges and streams book updates to the parent (API) process over Node's built-in IPC
    // pipe (same-host, no external DB, far cheaper than a Redis round trip). 1 = no sharding, all
    // connectors run in the main process (fine for a handful of exchanges; not fine for ~76).
    shardCount: Number(process.env['ORDER_ROUTER_SHARD_COUNT'] ?? 1),

    // Default venue/symbol list used only when discoverAllExchanges is false. Reflects the WS
    // reachability benchmark in benchmark/ws-latency.mjs run from this dev environment.
    exchanges: listFromEnv('ORDER_ROUTER_EXCHANGES', ['kraken', 'coinbase', 'kucoin', 'bitget', 'gate']),
    symbols: listFromEnv('ORDER_ROUTER_SYMBOLS', ['BTC/USDT', 'ETH/USDT']),

    staleBookMs: Number(process.env['ORDER_ROUTER_STALE_BOOK_MS'] ?? 5000),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',

    // Rate limiting. Applied per API key (falling back to client IP when the key is absent, which
    // only happens on the unauthenticated /health path). Defaults are deliberately generous — this
    // is abuse/runaway-client protection, not a quota system; the read path is an in-memory map
    // lookup, so the server can sustain far more than this.
    rateLimitMax: Number(process.env['ORDER_ROUTER_RATE_LIMIT_MAX'] ?? 600),
    rateLimitWindowMs: Number(process.env['ORDER_ROUTER_RATE_LIMIT_WINDOW_MS'] ?? 60_000),

    // WebSocket stream limits. Each /stream/best connection holds an EventEmitter listener on the
    // cache that is only removed on socket close — which the client controls. Without a cap, an
    // authenticated client can accumulate connections (and listeners, and per-connection compute on
    // every book update) until the process exhausts sockets or CPU. Rate limiting does not help:
    // it bounds the rate of new connections, not the number held open.
    wsMaxConnectionsPerKey: Number(process.env['ORDER_ROUTER_WS_MAX_CONNECTIONS_PER_KEY'] ?? 50),
    // Belt to the cap's braces: reaps sockets that stop responding to pings without cleanly
    // closing (half-open TCP, suspended laptop, hostile client that never sends a close frame).
    // Without it those connections hold their listener slot against the cap indefinitely.
    // 30s, deliberately BELOW nginx's 60s default proxy_read_timeout. A reverse proxy closes an
    // idle upstream connection on its own timer, so a heartbeat slower than that timer never fires
    // — the proxy kills the stream first. Only shows up on quiet symbols: an active book keeps the
    // connection busy with real data, so the bug hides until you subscribe to an illiquid pair.
    // If you raise proxy_read_timeout, this can rise with it; it must stay under it either way.
    wsIdleTimeoutMs: Number(process.env['ORDER_ROUTER_WS_IDLE_TIMEOUT_MS'] ?? 30_000),

    // Whether to derive the client IP from X-Forwarded-For. MUST stay false unless a trusted proxy
    // actually fronts this service and overwrites that header.
    //
    // The failure is symmetric, which is why it is opt-in rather than auto-detected:
    //   - false behind nginx  -> every request appears to come from the proxy, so all unauthenticated
    //     traffic shares ONE rate-limit bucket and per-client fairness is lost.
    //   - true when NOT behind a proxy -> any client can set X-Forwarded-For itself, mint a fresh
    //     bucket per request, and bypass rate limiting entirely. That is strictly worse: it hands
    //     back the exact brute-force hole the limiter exists to close.
    trustProxy: process.env['ORDER_ROUTER_TRUST_PROXY'] === 'true',
};
