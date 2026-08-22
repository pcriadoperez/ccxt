// Measures /route compute cost against a cache the size of full discovery, isolated from HTTP,
// WebSockets and the network. This is the number that matters for "every ms counts": everything
// else in the request path is fixed overhead, while this scales with how many books are cached.
//
//   node --experimental-strip-types benchmark/route-scale.mjs   (or: npx tsx benchmark/route-scale.mjs)
import { OrderBookCache } from '../dist/cache/orderBookCache.js';
import { FeeRegistry } from '../dist/cache/feeRegistry.js';
import { computeRoute } from '../dist/routing/route.js';

const EXCHANGES = Number(process.env.BENCH_EXCHANGES ?? 60);
const SYMBOLS = Number(process.env.BENCH_SYMBOLS ?? 700);
const LEVELS = Number(process.env.BENCH_LEVELS ?? 50);

const cache = new OrderBookCache();
const fees = new FeeRegistry();
const symbols = ['BTC/USDT', 'SOL/USDT', ...Array.from({ length: SYMBOLS }, (_, i) => `T${i}/USDT`)];
for (let e = 0; e < EXCHANGES; e++) {
    const exchangeId = `ex${e}`;
    for (const symbol of symbols) {
        cache.setBook({
            exchangeId, symbol,
            asks: Array.from({ length: LEVELS }, (_, l) => ({ price: 100 + l * 0.1 + e * 0.01, amount: 1 })),
            bids: Array.from({ length: LEVELS }, (_, l) => ({ price: 99 - l * 0.1 - e * 0.01, amount: 1 })),
            exchangeTimestamp: Date.now(), receivedAt: Date.now(), sequence: 1,
        });
        fees.setFee(exchangeId, symbol, 0.001);
    }
}

const opts = {
    strategy: 'split_optimal', includeFees: true, maxVenues: 3, minLegNotional: 0,
    staleBookMs: 60_000, requestId: 'bench', certifiedOnly: false, requireFullFill: false,
    stalenessPenaltyBps: 0,
};

function measure (label, req) {
    for (let i = 0; i < 50; i++) computeRoute(cache, fees, req, opts);
    const samples = [];
    for (let i = 0; i < 500; i++) {
        const t = performance.now();
        computeRoute(cache, fees, req, opts);
        samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    const at = (p) => samples[Math.floor(samples.length * p)].toFixed(3);
    console.log(`${label.padEnd(34)} p50 ${at(0.5)}ms  p95 ${at(0.95)}ms  p99 ${at(0.99)}ms`);
}

console.log(`cache: ${cache.getBookCount()} books (${EXCHANGES} exchanges x ${symbols.length} symbols x ${LEVELS} levels)\n`);
measure('single hop, small (exact-out)', { from: 'USDT', to: 'BTC', amountOut: 1, bridges: [] });
measure('single hop, deep (exact-out)', { from: 'USDT', to: 'BTC', amountOut: 500, bridges: [] });
measure('single hop, notional (exact-in)', { from: 'USDT', to: 'BTC', amountIn: 500_000, bridges: [] });
measure('bridged SOL->USDT->BTC (exact-in)', { from: 'SOL', to: 'BTC', amountIn: 100, bridges: ['USDT'] });
