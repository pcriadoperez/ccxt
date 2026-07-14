function listFromEnv (name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export const config = {
    port: Number(process.env['PORT'] ?? 8080),
    host: process.env['HOST'] ?? '0.0.0.0',
    // Default venue list reflects the WS reachability + book-depth benchmark in benchmark/ws-latency.mjs
    // run from this dev environment. Binance/Bybit/OKX are typically the deepest/fastest venues in
    // production and should be added here once benchmarked from unrestricted, NTP-synced infra.
    exchanges: listFromEnv('ORDER_ROUTER_EXCHANGES', ['kraken', 'coinbase', 'kucoin', 'bitget', 'gate']),
    symbols: listFromEnv('ORDER_ROUTER_SYMBOLS', ['BTC/USDT', 'ETH/USDT']),
    staleBookMs: Number(process.env['ORDER_ROUTER_STALE_BOOK_MS'] ?? 5000),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
};
