// Benchmark: WS message latency + order book depth for candidate exchanges.
// Not part of the ccxt library — a one-off measurement script for the order-router design.
import ccxt from 'ccxt';

const SYMBOL = 'BTC/USDT';
const DURATION_MS = 30_000;
const EXCHANGES = ['kraken', 'coinbase', 'kucoin', 'bitget', 'gate'];

function percentile (sorted, p) {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

async function benchOrderBook (exchangeId) {
    const exchange = new ccxt.pro[exchangeId] ({ enableRateLimit: true });
    const latencies = [];
    const depths = [];
    const start = Date.now();
    let updates = 0;
    let error = null;
    try {
        while (Date.now() - start < DURATION_MS) {
            const ob = await exchange.watchOrderBook (SYMBOL);
            const now = Date.now();
            if (ob.timestamp) {
                latencies.push(now - ob.timestamp);
            }
            depths.push(Math.min(ob.bids.length, ob.asks.length));
            updates++;
        }
    } catch (e) {
        error = e.message;
    } finally {
        await exchange.close ();
    }
    latencies.sort((a, b) => a - b);
    depths.sort((a, b) => a - b);
    return {
        exchangeId,
        updates,
        error,
        latencyMs: {
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            p99: percentile(latencies, 0.99),
            max: latencies[latencies.length - 1] ?? null,
        },
        depth: {
            min: depths[0] ?? null,
            p50: percentile(depths, 0.5),
            max: depths[depths.length - 1] ?? null,
        },
    };
}

const results = [];
for (const id of EXCHANGES) {
    console.error(`[bench] running ${id} for ${DURATION_MS}ms...`);
    const r = await benchOrderBook (id);
    console.error(`[bench] ${id} done:`, JSON.stringify(r));
    results.push(r);
}

console.log(JSON.stringify(results, null, 2));
