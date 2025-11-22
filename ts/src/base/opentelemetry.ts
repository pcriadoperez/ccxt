// ----------------------------------------------------------------------------
// OpenTelemetry Tracing Module
// Implements distributed tracing similar to SpiceDB
// ----------------------------------------------------------------------------

import { trace, SpanStatusCode, Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from '@opentelemetry/exporter-trace-otlp-grpc';

/**
 * OpenTelemetry Configuration
 * Similar to SpiceDB's OpenTelemetry configuration
 */
export interface OpenTelemetryConfig {
    /** Whether tracing is enabled */
    enabled?: boolean;
    /** OTLP endpoint for trace export (empty string = no export) */
    endpoint?: string;
    /** Whether to use insecure connection (HTTP instead of HTTPS) */
    insecure?: boolean;
    /** Trace provider type: 'otlp-http', 'otlp-grpc', or 'none' */
    provider?: 'otlp-http' | 'otlp-grpc' | 'none';
    /** Sample ratio for traces (0.0 to 1.0) */
    sampleRatio?: number;
    /** Service name for traces */
    service?: string;
    /** Service version for traces */
    version?: string;
}

/**
 * Default OpenTelemetry configuration
 */
const DEFAULT_CONFIG: OpenTelemetryConfig = {
    enabled: false,
    endpoint: '',
    insecure: false,
    provider: 'none',
    sampleRatio: 0.01,
    service: 'ccxt',
    version: '4.5.18',
};

let tracerProvider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;
let config: OpenTelemetryConfig = { ...DEFAULT_CONFIG };

/**
 * Initialize OpenTelemetry tracing
 * @param userConfig OpenTelemetry configuration
 */
export function initializeTracing(userConfig: Partial<OpenTelemetryConfig> = {}): void {
    // Merge with defaults
    config = { ...DEFAULT_CONFIG, ...userConfig };

    // If tracing is disabled or no endpoint, skip initialization
    if (!config.enabled || !config.endpoint || config.provider === 'none') {
        console.log('OpenTelemetry tracing disabled or not configured');
        return;
    }

    try {
        // Create resource with service information
        const resource = Resource.default().merge(
            new Resource({
                [ATTR_SERVICE_NAME]: config.service,
                [ATTR_SERVICE_VERSION]: config.version,
            })
        );

        // Create tracer provider
        tracerProvider = new NodeTracerProvider({
            resource: resource,
            sampler: createSampler(config.sampleRatio),
        });

        // Create and configure exporter
        const exporter = createExporter(config);
        if (exporter) {
            tracerProvider.addSpanProcessor(new BatchSpanProcessor(exporter));
        }

        // Register the provider
        tracerProvider.register();

        // Get tracer instance
        tracer = trace.getTracer(config.service, config.version);

        console.log(
            `OpenTelemetry tracing initialized: ` +
            `endpoint=${config.endpoint}, ` +
            `insecure=${config.insecure}, ` +
            `provider=${config.provider}, ` +
            `sampleRatio=${config.sampleRatio}, ` +
            `service=${config.service}`
        );
    } catch (error) {
        console.error('Failed to initialize OpenTelemetry tracing:', error);
    }
}

/**
 * Create trace exporter based on configuration
 */
function createExporter(config: OpenTelemetryConfig): OTLPTraceExporterHTTP | OTLPTraceExporterGRPC | null {
    const url = config.insecure
        ? config.endpoint.replace('https://', 'http://')
        : config.endpoint;

    try {
        if (config.provider === 'otlp-http') {
            return new OTLPTraceExporterHTTP({
                url: url,
            });
        } else if (config.provider === 'otlp-grpc') {
            return new OTLPTraceExporterGRPC({
                url: url,
            });
        }
    } catch (error) {
        console.error('Failed to create trace exporter:', error);
    }

    return null;
}

/**
 * Create sampler based on sample ratio
 */
function createSampler(sampleRatio: number): any {
    const { TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-base');
    return new TraceIdRatioBasedSampler(sampleRatio);
}

/**
 * Shutdown OpenTelemetry tracing
 */
export async function shutdownTracing(): Promise<void> {
    if (tracerProvider) {
        try {
            await tracerProvider.shutdown();
            console.log('OpenTelemetry tracing shut down successfully');
        } catch (error) {
            console.error('Error shutting down OpenTelemetry:', error);
        }
        tracerProvider = null;
        tracer = null;
    }
}

/**
 * Get the current tracer instance
 */
export function getTracer(): Tracer | null {
    return tracer;
}

/**
 * Get current OpenTelemetry configuration
 */
export function getConfig(): OpenTelemetryConfig {
    return { ...config };
}

/**
 * Check if tracing is enabled
 */
export function isTracingEnabled(): boolean {
    return config.enabled && tracer !== null;
}

/**
 * Helper to start a span for an operation
 * @param operationName Name of the operation
 * @param attributes Optional attributes to add to the span
 * @param callback Async function to execute within the span
 */
export async function withSpan<T>(
    operationName: string,
    callback: (span: any) => Promise<T>,
    attributes?: Record<string, any>
): Promise<T> {
    if (!tracer || !isTracingEnabled()) {
        return callback(null);
    }

    return tracer.startActiveSpan(operationName, async (span) => {
        try {
            if (attributes) {
                span.setAttributes(attributes);
            }
            const result = await callback(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error.message,
            });
            span.recordException(error);
            throw error;
        } finally {
            span.end();
        }
    });
}

/**
 * Helper to add attributes to the current active span
 */
export function addSpanAttributes(attributes: Record<string, any>): void {
    if (!tracer || !isTracingEnabled()) {
        return;
    }

    const span = trace.getActiveSpan();
    if (span) {
        span.setAttributes(attributes);
    }
}

/**
 * Helper to add an event to the current active span
 */
export function addSpanEvent(name: string, attributes?: Record<string, any>): void {
    if (!tracer || !isTracingEnabled()) {
        return;
    }

    const span = trace.getActiveSpan();
    if (span) {
        span.addEvent(name, attributes);
    }
}

export default {
    initializeTracing,
    shutdownTracing,
    getTracer,
    getConfig,
    isTracingEnabled,
    withSpan,
    addSpanAttributes,
    addSpanEvent,
};
