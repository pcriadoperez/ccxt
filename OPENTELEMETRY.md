# OpenTelemetry Tracing in CCXT

CCXT now supports OpenTelemetry for distributed tracing, similar to SpiceDB's implementation. This allows you to trace the lifetime of requests across your cryptocurrency trading applications.

## Configuration

You can configure OpenTelemetry tracing in CCXT via configuration options when creating an exchange instance. All configuration options are prefixed with `otel`.

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Whether OpenTelemetry tracing is enabled |
| `endpoint` | string | `''` | OTLP endpoint for trace export (empty = no export) |
| `insecure` | boolean | `false` | Whether to use insecure connection (HTTP instead of HTTPS) |
| `provider` | string | `'none'` | Trace provider type: `'otlp-http'`, `'otlp-grpc'`, or `'none'` |
| `sampleRatio` | number | `0.01` | Sample ratio for traces (0.0 to 1.0) - default is 1% sampling |
| `service` | string | `'ccxt'` | Service name for traces |
| `version` | string | `'4.5.18'` | Service version for traces |

## Usage Examples

### JavaScript / TypeScript

```javascript
import ccxt from 'ccxt';

// Create an exchange instance with OpenTelemetry enabled
const exchange = new ccxt.binance({
    apiKey: 'YOUR_API_KEY',
    secret: 'YOUR_SECRET',
    otel: {
        enabled: true,
        endpoint: 'http://localhost:4318/v1/traces',  // OTLP HTTP endpoint
        insecure: true,
        provider: 'otlp-http',
        sampleRatio: 0.1,  // Trace 10% of requests
        service: 'my-trading-bot',
        version: '1.0.0'
    }
});

// Now all HTTP requests will be traced
const ticker = await exchange.fetchTicker('BTC/USDT');

// Don't forget to shutdown tracing when done
await exchange.shutdownOpenTelemetry();
```

### Using with Jaeger

[Jaeger](https://www.jaegertracing.io/) is a popular open-source distributed tracing system. Here's how to set up CCXT with Jaeger:

1. **Start Jaeger with Docker:**

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

2. **Configure CCXT to send traces to Jaeger:**

```javascript
const exchange = new ccxt.binance({
    otel: {
        enabled: true,
        endpoint: 'http://localhost:4318/v1/traces',
        insecure: true,
        provider: 'otlp-http',
        sampleRatio: 1.0,  // Trace 100% for development
        service: 'ccxt-trading-bot'
    }
});

// Make some API calls
await exchange.fetchMarkets();
await exchange.fetchTicker('BTC/USDT');
await exchange.fetchBalance();

// View traces at http://localhost:16686
```

3. **View traces in Jaeger UI at:** `http://localhost:16686`

### Using with Grafana Tempo

[Grafana Tempo](https://grafana.com/oss/tempo/) is a distributed tracing backend:

```javascript
const exchange = new ccxt.binance({
    otel: {
        enabled: true,
        endpoint: 'http://tempo:4318/v1/traces',
        provider: 'otlp-http',
        sampleRatio: 0.05,
        service: 'ccxt-bot'
    }
});
```

### Using with OpenTelemetry Collector

For production environments, use the [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/):

```javascript
const exchange = new ccxt.binance({
    otel: {
        enabled: true,
        endpoint: 'http://otel-collector:4317',  // gRPC endpoint
        provider: 'otlp-grpc',
        sampleRatio: 0.01,
        service: 'production-trading-bot',
        version: process.env.APP_VERSION
    }
});
```

### Python

```python
import ccxt

# Create exchange with OpenTelemetry configuration
exchange = ccxt.binance({
    'apiKey': 'YOUR_API_KEY',
    'secret': 'YOUR_SECRET',
    'otel': {
        'enabled': True,
        'endpoint': 'http://localhost:4318/v1/traces',
        'insecure': True,
        'provider': 'otlp-http',
        'sampleRatio': 0.1,
        'service': 'my-trading-bot',
        'version': '1.0.0'
    }
})

# Make API calls - they will be traced
ticker = exchange.fetch_ticker('BTC/USDT')
```

### PHP

```php
<?php
use ccxt\binance;

$exchange = new binance([
    'apiKey' => 'YOUR_API_KEY',
    'secret' => 'YOUR_SECRET',
    'otel' => [
        'enabled' => true,
        'endpoint' => 'http://localhost:4318/v1/traces',
        'insecure' => true,
        'provider' => 'otlp-http',
        'sampleRatio' => 0.1,
        'service' => 'my-trading-bot',
        'version' => '1.0.0'
    ]
]);

// Make API calls
$ticker = $exchange->fetch_ticker('BTC/USDT');
?>
```

## What Gets Traced

CCXT traces the following operations:

- **HTTP Requests**: All HTTP API calls to exchanges
  - Request method, URL, and headers
  - Response status code and timing
  - Error information if requests fail

Each trace span includes:
- `http.method`: The HTTP method (GET, POST, etc.)
- `http.url`: The complete request URL
- `http.status_code`: Response status code
- `exchange.id`: The exchange identifier (e.g., 'binance', 'coinbase')

## Sample Ratios

The `sampleRatio` option controls what percentage of requests get traced:

- `1.0` = Trace 100% of requests (useful for development)
- `0.1` = Trace 10% of requests
- `0.01` = Trace 1% of requests (recommended for high-volume production)
- `0.001` = Trace 0.1% of requests (for very high-volume systems)

## Disabling Tracing

To disable tracing:

```javascript
const exchange = new ccxt.binance({
    otel: {
        enabled: false
    }
});
```

Or simply omit the `otel` configuration entirely (it's disabled by default).

## Troubleshooting

### No traces appearing

1. Verify your OTLP endpoint is correct and accessible
2. Check that `enabled: true` is set
3. Ensure your provider type matches your backend (http vs grpc)
4. Check sample ratio - with 0.01, only 1% of requests are traced

### Connection errors

- Use `insecure: true` for local development with http://
- For production with HTTPS, ensure SSL certificates are valid
- Check firewall rules and network connectivity

### Performance impact

- OpenTelemetry has minimal overhead when disabled
- Use appropriate sample ratios for production (0.01 or lower)
- Traces are exported asynchronously in batches

## Architecture

CCXT's OpenTelemetry implementation follows the same patterns as SpiceDB:

1. **Initialization**: Tracing is configured when the exchange instance is created
2. **Instrumentation**: HTTP requests are automatically wrapped with trace spans
3. **Export**: Traces are sent to the configured OTLP endpoint
4. **Shutdown**: Clean shutdown is available via `shutdownOpenTelemetry()`

## Dependencies

The following OpenTelemetry packages are included:

- `@opentelemetry/api`
- `@opentelemetry/sdk-trace-node`
- `@opentelemetry/sdk-trace-base`
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/exporter-trace-otlp-grpc`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/instrumentation`

## Related Resources

- [OpenTelemetry Documentation](https://opentelemetry.io/docs/)
- [Jaeger Tracing](https://www.jaegertracing.io/)
- [Grafana Tempo](https://grafana.com/oss/tempo/)
- [SpiceDB OpenTelemetry Documentation](https://authzed.com/docs/spicedb/observability/opentelemetry)
- [OTLP Specification](https://opentelemetry.io/docs/specs/otlp/)

## Contributing

If you find issues with OpenTelemetry tracing or have suggestions for improvements, please open an issue on the [CCXT GitHub repository](https://github.com/ccxt/ccxt/issues).
