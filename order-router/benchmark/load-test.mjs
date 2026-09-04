// Load test for the public REST surface. Measures request latency percentiles and throughput
// against a *running* order-router, so the numbers include real auth, rate limiting, book
// walking, and JSON serialization — not a synthetic handler.
//
// Usage:
//   node benchmark/load-test.mjs [--url http://localhost:8080] [--key <apiKey>]
//                                [--duration 10] [--connections 50] [--symbol BTC/USDT]
//
// Rate limiting will dominate the results unless the limit is raised for the run; start the
// server with a high ORDER_ROUTER_RATE_LIMIT_MAX to measure the service rather than the limiter.
import autocannon from 'autocannon';

function arg (name, fallback) {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const BASE_URL = arg('url', 'http://localhost:8080');
const API_KEY = arg('key', process.env['ORDER_ROUTER_API_KEY'] ?? 'dev-local-key-change-me');
const DURATION = Number(arg('duration', '10'));
const CONNECTIONS = Number(arg('connections', '50'));
const SYMBOL = arg('symbol', 'BTC/USDT');
const encodedSymbol = encodeURIComponent(SYMBOL);

const SCENARIOS = [
    {
        name: 'health (baseline, unauthenticated, no cache read)',
        path: '/health',
        headers: {},
    },
    {
        name: 'symbols (authenticated, iterates whole cache)',
        path: '/symbols',
        headers: { 'x-api-key': API_KEY },
    },
    {
        name: 'orderbook (authenticated, single map lookup + serialize full book)',
        path: `/orderbook/kraken/${encodedSymbol}`,
        headers: { 'x-api-key': API_KEY },
    },
    {
        name: 'price/best small order (authenticated, walks every exchange book)',
        path: `/price/best/${encodedSymbol}?side=buy&amount=0.01`,
        headers: { 'x-api-key': API_KEY },
    },
    {
        name: 'price/best large order (authenticated, walks deeper into books)',
        path: `/price/best/${encodedSymbol}?side=buy&amount=50`,
        headers: { 'x-api-key': API_KEY },
    },
    {
        name: 'unauthenticated (should be 401 — measures rejection cost)',
        path: `/price/best/${encodedSymbol}?side=buy&amount=0.01`,
        headers: {},
        expectNon2xx: true,
    },
];

function runScenario (scenario) {
    return new Promise((resolve, reject) => {
        autocannon({
            url: `${BASE_URL}${scenario.path}`,
            connections: CONNECTIONS,
            duration: DURATION,
            headers: scenario.headers,
            // Non-2xx is expected for the auth-rejection scenario; autocannon counts them
            // separately either way, and we report them explicitly below.
        }, (err, result) => (err ? reject(err) : resolve(result)));
    });
}

console.error(`[load-test] target=${BASE_URL} connections=${CONNECTIONS} duration=${DURATION}s`);
const report = [];

for (const scenario of SCENARIOS) {
    console.error(`[load-test] running: ${scenario.name}`);
    const result = await runScenario(scenario);
    report.push({
        scenario: scenario.name,
        path: scenario.path,
        requestsPerSecond: Math.round(result.requests.average),
        latencyMs: {
            p50: result.latency.p50,
            p90: result.latency.p90,
            p99: result.latency.p99,
            max: result.latency.max,
        },
        // 2xx vs non-2xx matters: a fast p99 means nothing if the responses were all 401s or 429s.
        non2xx: result.non2xx,
        total: result.requests.total,
        errors: result.errors,
        timeouts: result.timeouts,
        expectNon2xx: Boolean(scenario.expectNon2xx),
    });
}

console.log(JSON.stringify(report, null, 2));

console.error('\n[load-test] summary');
for (const r of report) {
    const status = r.expectNon2xx
        ? `${r.non2xx} rejected (expected)`
        : `${r.non2xx} non-2xx${r.non2xx > 0 ? '  <-- INVESTIGATE (rate limited or erroring)' : ''}`;
    console.error(
        `  ${r.scenario}\n`
        + `    ${r.requestsPerSecond} req/s | p50=${r.latencyMs.p50}ms p90=${r.latencyMs.p90}ms `
        + `p99=${r.latencyMs.p99}ms max=${r.latencyMs.max}ms | ${status}`,
    );
}
