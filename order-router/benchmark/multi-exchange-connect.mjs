// Benchmark/verification: how many exchanges can we hold simultaneous live WS order book
// connections to, and do they stay healthy? Answers the "does this actually work at scale"
// question that per-exchange unit tests can't.
//
// Usage: node benchmark/multi-exchange-connect.mjs [durationSeconds] [maxExchanges]
import ccxt from 'ccxt';

const DURATION_MS = Number(process.argv[2] ?? 60) * 1000;
const MAX_EXCHANGES = Number(process.argv[3] ?? 30);
const CONNECT_TIMEOUT_MS = 20_000;

// Candidate pool: exchanges that loaded markets successfully in the discovery run from this
// environment. Loading markets over REST does NOT imply the WS endpoint is reachable (OKX is the
// standing counter-example), which is exactly what this script measures.
const CANDIDATES = [
    'kraken', 'coinbase', 'kucoin', 'bitget', 'gate', 'mexc', 'htx', 'bitmart', 'bingx',
    'bitrue', 'phemex', 'lbank', 'coinex', 'hitbtc', 'whitebit', 'poloniex', 'xt', 'upbit',
    'bitfinex', 'cex', 'deribit', 'toobit', 'p2b', 'woo', 'bithumb', 'luno', 'okx',
    'hyperliquid', 'binanceus', 'independentreserve', 'bitstamp', 'bitvavo', 'exmo', 'gemini',
];

function sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// close() rejects every still-pending watch future with ExchangeClosedByUser. Racing a watch
// against a timeout leaves the losing watch promise unawaited, so that rejection would surface as
// an unhandled rejection and kill the process at teardown. Attaching a no-op catch keeps the
// promise "handled" while we ignore its late result.
function ignoreLateRejection (promise) {
    promise.catch(() => { /* superseded by timeout or shutdown */ });
    return promise;
}

async function tryExchange (exchangeId, deadline) {
    const state = {
        exchangeId,
        connected: false,
        messages: 0,
        errors: 0,
        firstMessageMs: null,
        lastError: null,
        symbol: null,
    };
    let exchange;
    try {
        const ExchangeClass = ccxt.pro[exchangeId];
        if (!ExchangeClass) {
            state.lastError = 'no ccxt.pro class';
            return state;
        }
        exchange = new ExchangeClass({ enableRateLimit: true });
        await exchange.loadMarkets();

        // Pick a liquid symbol this exchange actually lists, preferring majors.
        const preferred = ['BTC/USDT', 'BTC/USD', 'BTC/USDC', 'ETH/USDT', 'ETH/USD'];
        const symbol = preferred.find((s) => exchange.markets[s])
            ?? Object.keys(exchange.markets).find((s) => s.startsWith('BTC/'));
        if (!symbol) {
            state.lastError = 'no BTC market found';
            await exchange.close();
            return state;
        }
        state.symbol = symbol;

        const startedAt = Date.now();
        // Watch loop until the shared deadline; every iteration counts a live message.
        while (Date.now() < deadline) {
            try {
                const timeLeft = deadline - Date.now();
                const ob = await Promise.race([
                    ignoreLateRejection(exchange.watchOrderBook(symbol)),
                    sleep(Math.min(CONNECT_TIMEOUT_MS, timeLeft)).then(() => 'TIMEOUT'),
                ]);
                if (ob === 'TIMEOUT') {
                    if (!state.connected) {
                        state.lastError = `no data within ${CONNECT_TIMEOUT_MS}ms`;
                        break;
                    }
                    continue;
                }
                if (!state.connected) {
                    state.connected = true;
                    state.firstMessageMs = Date.now() - startedAt;
                }
                state.messages++;
            } catch (err) {
                state.errors++;
                state.lastError = String(err.message ?? err).slice(0, 120);
                if (state.errors > 20) break;
                await sleep(500 + Math.random() * 1000);
            }
        }
    } catch (err) {
        state.lastError = String(err.message ?? err).slice(0, 120);
    } finally {
        try {
            await exchange?.close();
        } catch { /* best effort */ }
    }
    return state;
}

// Belt-and-braces: a straggler rejection from any exchange's internal plumbing during teardown
// must not lose us the whole run's results after minutes of live connection time.
process.on('unhandledRejection', (reason) => {
    console.error(`[multi-connect] ignored late unhandled rejection: ${String(reason).slice(0, 120)}`);
});

const pool = CANDIDATES.slice(0, MAX_EXCHANGES);
console.error(`[multi-connect] attempting ${pool.length} exchanges simultaneously for ${DURATION_MS / 1000}s...`);

const deadline = Date.now() + DURATION_MS;
const results = await Promise.all(pool.map((id) => tryExchange(id, deadline)));

const connected = results.filter((r) => r.connected);
const failed = results.filter((r) => !r.connected);
const totalMessages = results.reduce((sum, r) => sum + r.messages, 0);

console.log(JSON.stringify({
    attempted: pool.length,
    connectedCount: connected.length,
    failedCount: failed.length,
    totalMessages,
    messagesPerSecond: Math.round(totalMessages / (DURATION_MS / 1000)),
    peakRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    connected: connected.map((r) => ({
        exchangeId: r.exchangeId,
        symbol: r.symbol,
        messages: r.messages,
        errors: r.errors,
        firstMessageMs: r.firstMessageMs,
    })).sort((a, b) => b.messages - a.messages),
    failed: failed.map((r) => ({ exchangeId: r.exchangeId, lastError: r.lastError })),
}, null, 2));

process.exit(0);
