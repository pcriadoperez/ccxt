// ----------------------------------------------------------------------------
// Example: Using OpenTelemetry Tracing with CCXT
// ----------------------------------------------------------------------------
// This example demonstrates how to enable OpenTelemetry distributed tracing
// in CCXT to monitor and trace cryptocurrency exchange API requests.
//
// Prerequisites:
// 1. Start Jaeger with Docker:
//    docker run -d --name jaeger \
//      -e COLLECTOR_OTLP_ENABLED=true \
//      -p 16686:16686 \
//      -p 4318:4318 \
//      jaegertracing/all-in-one:latest
//
// 2. Run this example:
//    npm run cli.ts examples/ts/opentelemetry-tracing.ts
//
// 3. View traces in Jaeger UI:
//    http://localhost:16686
// ----------------------------------------------------------------------------

import ccxt from '../../js/ccxt.js';

async function main() {
    console.log('OpenTelemetry Tracing Example');
    console.log('=============================\n');

    // Create an exchange instance with OpenTelemetry enabled
    const exchange = new ccxt.binance({
        // OpenTelemetry configuration (similar to SpiceDB)
        otel: {
            // Enable tracing
            enabled: true,

            // OTLP HTTP endpoint (Jaeger)
            endpoint: 'http://localhost:4318/v1/traces',

            // Use insecure connection for local development
            insecure: true,

            // Provider type: 'otlp-http' or 'otlp-grpc'
            provider: 'otlp-http',

            // Sample ratio: 1.0 = trace 100% of requests
            // For production, use lower values like 0.01 (1%)
            sampleRatio: 1.0,

            // Service name that will appear in traces
            service: 'ccxt-example',

            // Service version
            version: '1.0.0'
        }
    });

    console.log('OpenTelemetry tracing configured:');
    console.log('- Endpoint: http://localhost:4318/v1/traces');
    console.log('- Provider: otlp-http');
    console.log('- Sample Ratio: 100%');
    console.log('- Service: ccxt-example\n');

    try {
        console.log('Making API requests (these will be traced)...\n');

        // Fetch markets - this will create a trace span
        console.log('1. Fetching markets...');
        const markets = await exchange.fetchMarkets();
        console.log(`   ✓ Fetched ${markets.length} markets\n`);

        // Fetch ticker - this will create another trace span
        console.log('2. Fetching BTC/USDT ticker...');
        const ticker = await exchange.fetchTicker('BTC/USDT');
        console.log(`   ✓ Current price: ${ticker.last}\n`);

        // Fetch order book - another traced operation
        console.log('3. Fetching BTC/USDT order book...');
        const orderbook = await exchange.fetchOrderBook('BTC/USDT', 5);
        console.log(`   ✓ Best bid: ${orderbook.bids[0][0]}`);
        console.log(`   ✓ Best ask: ${orderbook.asks[0][0]}\n`);

        // Fetch OHLCV data - traced operation
        console.log('4. Fetching BTC/USDT OHLCV (1h, 10 candles)...');
        const ohlcv = await exchange.fetchOHLCV('BTC/USDT', '1h', undefined, 10);
        console.log(`   ✓ Fetched ${ohlcv.length} candles\n`);

        console.log('All requests completed successfully!\n');
        console.log('View traces in Jaeger UI:');
        console.log('👉 http://localhost:16686');
        console.log('\nIn Jaeger:');
        console.log('1. Select "ccxt-example" from the Service dropdown');
        console.log('2. Click "Find Traces"');
        console.log('3. Click on a trace to see detailed timing information\n');

    } catch (error) {
        console.error('Error:', error.message);
        // Errors are also captured in traces with error information
    } finally {
        // Clean shutdown of OpenTelemetry tracing
        console.log('Shutting down OpenTelemetry tracing...');
        await exchange.shutdownOpenTelemetry();
        console.log('✓ Shutdown complete');
    }
}

main();
