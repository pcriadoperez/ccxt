#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Example demonstrating OpenTelemetry integration with CCXT

This example shows how to use CCXT with OpenTelemetry tracing enabled.
Traces can be visualized using SigNoz or any OpenTelemetry-compatible backend.

Prerequisites:
    pip install ccxt[telemetry]

To send traces to local SigNoz:
    1. Start SigNoz: docker-compose -f docker-compose.signoz.yml up -d
    2. Set environment variable: export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
    3. Run this script: python examples/py/telemetry-example.py
    4. View traces at: http://localhost:3301
"""

import asyncio
import os
import sys

# Add parent directory to path for imports
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(root + '/python')

import ccxt.async_support as ccxt


async def main():
    # Configure OpenTelemetry endpoint (optional)
    # If not set, will use default SigNoz cloud endpoint
    # Uncomment to use local SigNoz:
    # os.environ['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318/v1/traces'

    # To disable telemetry completely:
    # os.environ['CCXT_TELEMETRY_ENABLED'] = 'false'

    print('=' * 60)
    print('CCXT OpenTelemetry Example')
    print('=' * 60)
    print()

    # Create exchange instance
    # Telemetry is automatically initialized
    exchange = ccxt.binance({
        'enableRateLimit': True,
    })

    print(f'Exchange: {exchange.id}')
    print(f'Telemetry enabled: {os.environ.get("CCXT_TELEMETRY_ENABLED", "true")}')
    print(f'OTLP endpoint: {os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "default (SigNoz cloud)")}')
    print()

    try:
        # Fetch ticker - this will be traced
        print('Fetching BTC/USDT ticker...')
        ticker = await exchange.fetch_ticker('BTC/USDT')
        print(f'Price: {ticker["last"]}')
        print()

        # Fetch order book - this will also be traced
        print('Fetching BTC/USDT order book...')
        orderbook = await exchange.fetch_order_book('BTC/USDT', limit=5)
        print(f'Best bid: {orderbook["bids"][0][0]}')
        print(f'Best ask: {orderbook["asks"][0][0]}')
        print()

        # Fetch trades - traced as well
        print('Fetching recent BTC/USDT trades...')
        trades = await exchange.fetch_trades('BTC/USDT', limit=5)
        print(f'Latest trade: {trades[-1]["price"]} @ {trades[-1]["datetime"]}')
        print()

        print('=' * 60)
        print('Success! All operations traced.')
        print('=' * 60)
        print()
        print('To view traces:')
        print('1. Ensure SigNoz is running (docker-compose -f docker-compose.signoz.yml up -d)')
        print('2. Open http://localhost:3301 in your browser')
        print('3. Navigate to Traces section')
        print('4. Look for service name "ccxt"')
        print()

    except Exception as e:
        print(f'Error: {e}')
        # Errors are also traced with exception details
        import traceback
        traceback.print_exc()

    finally:
        # Close the exchange connection
        await exchange.close()

        # Give time for traces to be exported
        print('Waiting for traces to be exported...')
        await asyncio.sleep(2)
        print('Done!')


if __name__ == '__main__':
    asyncio.run(main())
