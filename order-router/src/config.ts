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

    // Cap the routable universe to the N most-traded symbols. Listing breadth is a poor proxy for
    // liquidity — an obscure token can appear on 20 venues and trade nothing — so this ranks by
    // quoteVolume from reference exchanges. 0 disables the cap.
    topSymbols: Number(process.env['ORDER_ROUTER_TOP_SYMBOLS'] ?? 50),
    liquidityReferenceExchanges: listFromEnv('ORDER_ROUTER_LIQUIDITY_REFERENCE', ['binance', 'okx']),

    // Shards are first partitioned by symbol count, which is a bad proxy for CPU cost: a venue
    // sending 3,000-level books costs far more per symbol than one sending 20. After this delay
    // the parent re-partitions using each exchange's OBSERVED message rate and restarts the
    // shards. 0 disables. Measured motivation: shard-0 at 0.90 event-loop utilisation while two
    // shards idled at 0.10.
    rebalanceAfterMs: Number(process.env['ORDER_ROUTER_REBALANCE_AFTER_MS'] ?? 120_000),
    rebalanceMinImbalance: Number(process.env['ORDER_ROUTER_REBALANCE_MIN_IMBALANCE'] ?? 1.5),

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
    // Marks a venue's price down by `bps * sqrt(book age in seconds)`, so an older quote has to be
    // genuinely better to win rather than merely look better. ON by default: judging whether a book
    // is too old to trust is the router's job, and shipping the capability switched off meant every
    // caller got the naive behaviour unless they knew to ask for something they could not calibrate.
    //
    // The coefficient is DERIVED, not picked. The penalty should approximate how far the price has
    // moved since the book was captured, which for an asset of annualised volatility s over t
    // seconds is s*sqrt(t/year). At 50% annualised vol that is 0.89 bps per sqrt(second), so 1 is
    // very close to one standard deviation of movement. It yields ~1.0 bps at one second and
    // ~2.2 bps at the 5s cutoff — enough to break a tie toward fresher data, not enough to override
    // a real price difference, given the measured split gain is 0.19-2.2 bps.
    // Higher-volatility assets are under-penalised by this constant; a per-asset figure would be
    // better and is not something the caller should have to supply either.
    stalenessPenaltyBps: Number(process.env['ORDER_ROUTER_STALENESS_PENALTY_BPS'] ?? 1),
    // How much better a bridged route must be, per extra hop, before it beats a direct market.
    // Non-zero by default: an extra hop is a second order, and a second chance for the price to
    // move between fills. That risk is not in the order book, so a bridge that wins by a hair is
    // not actually the better trade. Callers can set 0 to compare purely on rate.
    hopPenaltyBps: Number(process.env['ORDER_ROUTER_HOP_PENALTY_BPS'] ?? 5),
    // Floor on the gap between two pushes on one stream socket. Coalescing per event-loop tick is
    // not a rate bound: BTC/USDT alone updates from dozens of venues, so nearly every tick carries
    // one. Measured on the live service before this existed, a single socket pushed 658 frames/sec
    // at 9.3KB — 6.3 MB/s, and the per-key connection cap is 50. Ten frames a second is faster
    // than any consumer of a routing quote can act, and 65x cheaper.
    wsMinPushIntervalMs: Number(process.env['ORDER_ROUTER_WS_MIN_PUSH_INTERVAL_MS'] ?? 100),
    // Where API keys live. Relative default for local development; the systemd unit sets an
    // absolute path under /opt. Contains only digests, never a usable credential.
    keysFile: process.env['ORDER_ROUTER_KEYS_FILE'] ?? './data/keys.json',
    // How often to stat the key file for changes. Cheap enough to be uninteresting (~10 syscalls a
    // minute) and it removes the dangerous failure: a revocation that silently never takes effect.
    keysReloadPollMs: Number(process.env['ORDER_ROUTER_KEYS_RELOAD_POLL_MS'] ?? 10_000),
    // The level for per-request audit records, set INDEPENDENTLY of LOG_LEVEL. LOG_LEVEL exists to
    // quiet connector diagnostics — the box runs at warn because a misbehaving exchange once wrote
    // 930MB of retry chatter — and silencing operational noise must not also silence the record of
    // who called what. These lines are evidence, not diagnostics.
    auditLogLevel: process.env['ORDER_ROUTER_AUDIT_LOG_LEVEL'] ?? 'info',
    // Where the per-request audit records go. Unset means "the ordinary log", which keeps local
    // development and the existing tests working unchanged.
    auditLogFile: process.env['ORDER_ROUTER_AUDIT_LOG_FILE'],
    // Heap ceiling for each shard worker, in MB. Without one, V8 grows to whatever the startup peak
    // demands and never gives it back: a shard measured 20.54GB RSS — flat, so not a leak, just a
    // high-water mark — while its siblings sat at 0.44-1.07GB and the whole service cached 543 order
    // books. A ceiling makes V8 collect instead of grow. It is far above the live working set; if a
    // shard genuinely needs more it will OOM loudly rather than silently swap the box.
    shardMaxOldSpaceMb: Number(process.env['ORDER_ROUTER_SHARD_MAX_OLD_SPACE_MB'] ?? 1024),
    // How many exchanges within one shard may start concurrently. Every start does loadMarkets()
    // plus a first order-book snapshot; doing all of them at once is what builds the peak the
    // ceiling above then has to hold.
    shardStartConcurrency: Number(process.env['ORDER_ROUTER_SHARD_START_CONCURRENCY'] ?? 2),
    // Postgres. Deliberately absent from the router process's environment — see
    // docs/product-plan.md §3: the router must never be able to make authentication wait on a
    // database, and withholding the credential is what makes that structural rather than a promise.
    databaseUrl: process.env['DATABASE_URL'],
    databasePoolMax: Number(process.env['ORDER_ROUTER_DB_POOL_MAX'] ?? 10),
    // How often the audit stream is drained into Postgres. Short enough that the dashboard feels
    // live; the cursor makes any interval safe.
    ingestIntervalMs: Number(process.env['ORDER_ROUTER_INGEST_INTERVAL_MS'] ?? 5000),
    // First half of revocation latency (the router's own file poll is the second). Both are short
    // because revocation latency is a security property: it is the window in which a
    // known-compromised key still routes.
    keyProjectionIntervalMs: Number(process.env['ORDER_ROUTER_KEY_PROJECTION_INTERVAL_MS'] ?? 5000),
    // The web app. Mounted under a path prefix because the beta lives at docs.ccxt.com/router/;
    // every generated link goes through it, so moving to a dedicated domain is one value.
    webPort: Number(process.env['ORDER_ROUTER_WEB_PORT'] ?? 8090),
    webHost: process.env['ORDER_ROUTER_WEB_HOST'] ?? '127.0.0.1',
    webBasePath: process.env['ORDER_ROUTER_WEB_BASE'] ?? '/router',
    // Off only for local http development: a Secure cookie is never set over plain http, so
    // forcing it on would silently break login rather than fail loudly.
    webSecureCookies: process.env['ORDER_ROUTER_WEB_SECURE_COOKIES'] !== 'false',
    webAllowedOrigins: (process.env['ORDER_ROUTER_WEB_ORIGINS'] ?? 'https://docs.ccxt.com')
        .split(',').map((o) => o.trim()).filter((o) => o.length > 0),
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
