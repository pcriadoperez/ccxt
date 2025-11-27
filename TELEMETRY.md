# CCXT OpenTelemetry Integration

This document describes how to use OpenTelemetry tracing with CCXT Python and visualize traces using SigNoz.

## Overview

CCXT now includes OpenTelemetry instrumentation that automatically traces all async exchange method calls. This allows you to:

- Monitor API call performance
- Track errors and exceptions
- Visualize request flows
- Analyze latency patterns

## Installation

### Install CCXT with Telemetry Support

```bash
pip install ccxt[telemetry]
```

Or if you're installing from source:

```bash
cd python
pip install -e .[telemetry]
```

## Configuration

### Environment Variables

The telemetry integration can be configured using environment variables:

- `CCXT_TELEMETRY_ENABLED`: Set to `false` to disable telemetry (default: `true`)
- `OTEL_EXPORTER_OTLP_ENDPOINT`: Custom OpenTelemetry collector endpoint (optional)
- `OTEL_EXPORTER_OTLP_HEADERS`: Custom headers for the OTLP exporter (optional, comma-separated key=value pairs)

### Default Behavior

By default, telemetry is enabled and traces are sent to:
1. SigNoz cloud endpoint (for CCXT developers)
2. Your custom endpoint if `OTEL_EXPORTER_OTLP_ENDPOINT` is set

### Disabling Telemetry

To completely disable telemetry:

```bash
export CCXT_TELEMETRY_ENABLED=false
```

Or in Python:

```python
import os
os.environ['CCXT_TELEMETRY_ENABLED'] = 'false'

import ccxt
# Telemetry will be disabled
```

## Local SigNoz Setup

To run SigNoz locally for visualizing traces:

### Prerequisites

- Docker
- Docker Compose

### Starting SigNoz

1. Start SigNoz services:

```bash
docker-compose -f docker-compose.signoz.yml up -d
```

2. Wait for all services to be healthy (this may take a minute):

```bash
docker-compose -f docker-compose.signoz.yml ps
```

3. Access the SigNoz UI:

Open your browser and navigate to: http://localhost:3301

### Configure CCXT to Send Traces to Local SigNoz

Set the environment variable to point to your local collector:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

Or in Python:

```python
import os
os.environ['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318/v1/traces'

import ccxt
```

### Stopping SigNoz

```bash
docker-compose -f docker-compose.signoz.yml down
```

To also remove data volumes:

```bash
docker-compose -f docker-compose.signoz.yml down -v
```

## Usage Example

```python
import asyncio
import ccxt.async_support as ccxt

async def main():
    # Create exchange instance (telemetry is automatically initialized)
    exchange = ccxt.binance({
        'apiKey': 'YOUR_API_KEY',
        'secret': 'YOUR_SECRET',
    })

    try:
        # All async methods are automatically traced
        ticker = await exchange.fetch_ticker('BTC/USDT')
        print(ticker)

        # Fetch order book - this will also be traced
        orderbook = await exchange.fetch_order_book('BTC/USDT')
        print(orderbook)

    finally:
        await exchange.close()

# Run the async function
asyncio.run(main())
```

## Viewing Traces in SigNoz

1. Run your CCXT code with telemetry enabled
2. Open SigNoz UI at http://localhost:3301
3. Navigate to the "Traces" section
4. You should see traces with the service name "ccxt"
5. Click on any trace to see detailed information:
   - Method name
   - Exchange ID
   - Arguments (sensitive data filtered)
   - Duration
   - Status (success/error)
   - Exception details (if any)

## Data Privacy

The telemetry integration automatically filters sensitive data before sending to collectors:

- API keys
- Secrets
- Passwords
- Passphrases
- Signatures

These values are replaced with `***FILTERED***` in the traces.

## Troubleshooting

### Traces Not Appearing

1. Check that telemetry is enabled:
   ```bash
   echo $CCXT_TELEMETRY_ENABLED  # Should not be 'false'
   ```

2. Verify OpenTelemetry packages are installed:
   ```bash
   pip list | grep opentelemetry
   ```

3. Check SigNoz services are running:
   ```bash
   docker-compose -f docker-compose.signoz.yml ps
   ```

4. Check collector logs:
   ```bash
   docker-compose -f docker-compose.signoz.yml logs otel-collector
   ```

### Permission Errors

If you get permission errors with Docker volumes, try:

```bash
sudo chown -R $USER:$USER signoz-data/
```

## Architecture

The telemetry integration consists of:

1. **telemetry.py**: Core OpenTelemetry instrumentation
   - Initializes SDK with OTLP exporters
   - Wraps exchange methods with tracing
   - Filters sensitive data

2. **Exchange Integration**: Automatic initialization
   - `wrap_exchange_methods()` called in `Exchange.__init__()`
   - Works with both sync and async exchanges

3. **SigNoz Stack** (optional, for local visualization):
   - **OTel Collector**: Receives traces on port 4318 (HTTP) or 4317 (gRPC)
   - **ClickHouse**: Stores trace data
   - **Query Service**: Backend API for querying traces
   - **Frontend**: Web UI for visualization on port 3301

## Advanced Configuration

### Using a Different Backend

You can send traces to any OpenTelemetry-compatible backend:

**Jaeger:**
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

**Grafana Tempo:**
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer YOUR_TOKEN
```

**AWS X-Ray, Google Cloud Trace, etc.:**
Configure according to your provider's documentation.

## Performance Considerations

- Telemetry uses BatchSpanProcessor for efficient async export
- Minimal overhead on method execution
- Graceful degradation if collector is unavailable
- Can be completely disabled with environment variable

## Support

For issues related to:
- **CCXT telemetry integration**: Open an issue on [CCXT GitHub](https://github.com/ccxt/ccxt)
- **SigNoz**: See [SigNoz documentation](https://signoz.io/docs/)
- **OpenTelemetry**: See [OpenTelemetry documentation](https://opentelemetry.io/docs/)
