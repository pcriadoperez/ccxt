# -*- coding: utf-8 -*-

"""OpenTelemetry integration for CCXT"""

import os
import json
import re
import inspect
import functools
import atexit
from typing import Any, Dict, List, Optional, Callable

# OpenTelemetry imports
try:
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.sdk.resources import Resource, SERVICE_NAME
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.trace import Status, StatusCode, Tracer
    TELEMETRY_AVAILABLE = True
except ImportError:
    TELEMETRY_AVAILABLE = False
    TracerProvider = None
    Tracer = None
    OTLPSpanExporter = None
    BatchSpanProcessor = None
    Resource = None
    SERVICE_NAME = None
    Status = None
    StatusCode = None
    trace = None


# Global variables
_default_tracer: Optional[Tracer] = None
_tracer_provider: Optional[TracerProvider] = None

# Configuration
IS_TELEMETRY_ENABLED = os.environ.get('CCXT_TELEMETRY_ENABLED', 'true').lower() != 'false'
SERVICE_NAME_VALUE = 'ccxt'
CCXT_TELEMETRY_URL = 'https://ingest.eu.signoz.cloud:443/v1/traces'


def create_exporter(config: Dict[str, Any]) -> Optional[OTLPSpanExporter]:
    """Create an OTLP exporter with the given configuration."""
    if not TELEMETRY_AVAILABLE:
        return None

    return OTLPSpanExporter(
        endpoint=config['url'],
        headers=config.get('headers', {})
    )


def get_exporter_configs() -> List[Dict[str, Any]]:
    """Get list of exporter configurations (default + user-defined)."""
    configs = []

    # Default exporter to SigNoz
    configs.append({
        'url': CCXT_TELEMETRY_URL,
        'headers': {
            'signoz-access-token': '52913854-ebf0-4b8f-96bc-6ed6d029b698',
        }
    })

    # User-defined exporter
    otel_endpoint = os.environ.get('OTEL_EXPORTER_OTLP_ENDPOINT')
    if otel_endpoint:
        user_config = {
            'url': otel_endpoint,
            'headers': {}
        }

        # Parse headers from environment variable
        otel_headers = os.environ.get('OTEL_EXPORTER_OTLP_HEADERS')
        if otel_headers:
            header_pairs = otel_headers.split(',')
            for pair in header_pairs:
                if '=' in pair:
                    key, value = pair.split('=', 1)
                    user_config['headers'][key.strip()] = value.strip()

        configs.append(user_config)

    return configs


def initialize_telemetry():
    """Initialize the OpenTelemetry SDK."""
    global _default_tracer, _tracer_provider

    if _tracer_provider is not None or not IS_TELEMETRY_ENABLED or not TELEMETRY_AVAILABLE:
        return  # Already initialized or telemetry disabled or not available

    # Get version from exchange module
    try:
        from ccxt.base.exchange import __version__
        ccxt_version = __version__
    except ImportError:
        ccxt_version = 'unknown'

    # Create resource
    resource = Resource(attributes={
        SERVICE_NAME: SERVICE_NAME_VALUE,
        'ccxt.version': ccxt_version,
    })

    # Create tracer provider
    _tracer_provider = TracerProvider(resource=resource)

    # Add span processors for each exporter
    exporter_configs = get_exporter_configs()
    for config in exporter_configs:
        exporter = create_exporter(config)
        if exporter:
            span_processor = BatchSpanProcessor(exporter)
            _tracer_provider.add_span_processor(span_processor)

    # Set global tracer provider
    trace.set_tracer_provider(_tracer_provider)

    # Get default tracer
    _default_tracer = trace.get_tracer('ccxt')

    # Register shutdown handler
    atexit.register(shutdown_telemetry)


def get_tracer() -> Optional[Tracer]:
    """Get the global tracer instance."""
    if not IS_TELEMETRY_ENABLED or not TELEMETRY_AVAILABLE:
        return None

    if _tracer_provider is None:
        initialize_telemetry()

    return _default_tracer


def filter_sensitive_data(data: Any) -> Any:
    """
    Filter sensitive data from spans.
    Recursively removes or masks sensitive fields like keys, secrets, passwords.
    """
    sensitive_key_patterns = [
        re.compile(r'key', re.IGNORECASE),
        re.compile(r'secret', re.IGNORECASE),
        re.compile(r'password', re.IGNORECASE),
        re.compile(r'passphrase', re.IGNORECASE),
        re.compile(r'signature', re.IGNORECASE),
    ]

    def is_sensitive(key: str) -> bool:
        """Check if a key name indicates sensitive data."""
        return any(pattern.search(key) for pattern in sensitive_key_patterns)

    def filter_query_string(s: str) -> str:
        """Filter sensitive data from query strings."""
        if '=' in s and '&' in s:
            parts = []
            for part in s.split('&'):
                if '=' in part:
                    key, *rest = part.split('=', 1)
                    if is_sensitive(key):
                        parts.append(f'{key}=***FILTERED***')
                    else:
                        parts.append(part)
                else:
                    parts.append(part)
            return '&'.join(parts)
        return s

    def filter_recursive(obj: Any) -> Any:
        """Recursively filter sensitive data."""
        if isinstance(obj, dict):
            filtered = {}
            for key, value in obj.items():
                if is_sensitive(key):
                    filtered[key] = '***FILTERED***'
                elif isinstance(value, (dict, list)):
                    filtered[key] = filter_recursive(value)
                elif isinstance(value, str):
                    filtered[key] = filter_query_string(value)
                else:
                    filtered[key] = value
            return filtered
        elif isinstance(obj, list):
            return [filter_recursive(item) for item in obj]
        elif isinstance(obj, str):
            return filter_query_string(obj)
        else:
            return obj

    return filter_recursive(data)


def wrap_exchange_methods(exchange_instance: Any):
    """
    Wrap exchange methods with OpenTelemetry tracing.
    Similar to the TypeScript implementation.
    """
    if not IS_TELEMETRY_ENABLED or not TELEMETRY_AVAILABLE:
        return

    def wrap_method(obj: Any, method_name: str):
        """Wrap a single method with tracing."""
        try:
            # Get the method
            method = getattr(obj, method_name, None)
            if method is None or not callable(method):
                return

            # Skip non-async methods and special methods
            if not inspect.iscoroutinefunction(method):
                return

            # Get tracer
            tracer = get_tracer()
            if tracer is None:
                return

            @functools.wraps(method)
            async def traced_method(*args, **kwargs):
                """Wrapped method with tracing."""
                # Filter sensitive data from arguments
                filtered_args = filter_sensitive_data(list(args))
                filtered_kwargs = filter_sensitive_data(kwargs)

                # Start span
                with tracer.start_as_current_span(method_name) as span:
                    # Add attributes
                    try:
                        from ccxt.base.exchange import __version__
                        ccxt_version = __version__
                    except ImportError:
                        ccxt_version = 'unknown'

                    span.set_attributes({
                        'ccxt.version': ccxt_version,
                        'method.exchange': getattr(obj, 'id', 'unknown'),
                        'method.name': method_name,
                        'method.args': json.dumps(filtered_args),
                        'method.kwargs': json.dumps(filtered_kwargs),
                    })

                    try:
                        # Call the original method
                        result = await method(*args, **kwargs)
                        span.set_status(Status(StatusCode.OK))
                        return result
                    except Exception as error:
                        # Record exception
                        span.set_status(Status(StatusCode.ERROR, str(error)))
                        span.record_exception(error)
                        raise

            # Replace the method
            setattr(obj, method_name, traced_method)

        except Exception as e:
            # Silently ignore errors in wrapping to not break the exchange
            pass

    # Get all methods from the instance and its class
    all_methods = set()

    # Get instance methods
    all_methods.update(dir(exchange_instance))

    # Get class methods
    if hasattr(exchange_instance, '__class__'):
        all_methods.update(dir(exchange_instance.__class__))

    # Wrap each method
    for method_name in all_methods:
        if not method_name.startswith('_') and method_name != 'constructor':
            wrap_method(exchange_instance, method_name)


def shutdown_telemetry():
    """Shutdown the OpenTelemetry SDK gracefully."""
    global _tracer_provider, _default_tracer

    if _tracer_provider is not None:
        try:
            _tracer_provider.shutdown()
        except Exception as e:
            # Silently ignore shutdown errors
            pass
        finally:
            _tracer_provider = None
            _default_tracer = None
