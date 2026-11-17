import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { recordStructuredLog } from "./index.js";

let sdk: NodeSDK | undefined;
let shutdownRegistered = false;

export type NodeObservabilityOptions = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
};

/**
 * Starts OTel before application modules are loaded. Call this from a tiny
 * dynamic-import bootstrap entry point, never after Nest/pg/ioredis imports.
 */
export function startNodeObservability(options: NodeObservabilityOptions) {
  if (sdk || process.env.OTEL_SDK_DISABLED === "true") return sdk;
  const endpoint = normalizedEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!endpoint) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is required in production");
    }
    recordStructuredLog("warn", "observability.export.disabled", { service: options.serviceName });
    return undefined;
  }

  const serviceName = boundedResourceValue(options.serviceName, "wasalx-node-service");
  const resource = resourceFromAttributes({
    "service.namespace": "wasalx",
    "service.instance.id": boundedResourceValue(
      process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.HOSTNAME ?? crypto.randomUUID(),
      crypto.randomUUID(),
    ),
    "service.version": boundedResourceValue(
      options.serviceVersion ?? process.env.WASALX_VERSION ?? "development",
      "development",
    ),
    "deployment.environment.name": boundedResourceValue(
      options.environment ?? process.env.WASALX_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      "development",
    ),
  });

  const exportIntervalMillis = boundedInteger(
    process.env.OTEL_METRIC_EXPORT_INTERVAL ?? process.env.OTEL_METRIC_EXPORT_INTERVAL_MS,
    5_000,
    60_000,
    15_000,
  );
  const timeoutMillis = boundedInteger(process.env.OTEL_EXPORTER_OTLP_TIMEOUT, 1_000, 30_000, 10_000);
  sdk = new NodeSDK({
    serviceName,
    resource,
    autoDetectResources: false,
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? `${endpoint}/v1/traces`,
      timeoutMillis,
    }),
    metricReaders: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? `${endpoint}/v1/metrics`,
        timeoutMillis,
        concurrencyLimit: 1,
      }),
      exportIntervalMillis,
      exportTimeoutMillis: Math.min(timeoutMillis, exportIntervalMillis - 500),
      cardinalityLimits: {
        counter: 128,
        gauge: 128,
        histogram: 128,
        default: 128,
      },
    })],
    // WasalX emits explicit, allowlisted HTTP, worker, database-health,
    // provider, and job telemetry. Broad auto-instrumentation can attach URLs,
    // SQL, Redis keys, command arguments, and third-party attributes that have
    // not passed the WasalX PII allowlist, so it is disabled by default.
    instrumentations: [],
  });
  sdk.start();
  recordStructuredLog("info", "observability.started", {
    service: serviceName,
    exporter: "otlp_http_protobuf",
    metrics_interval_ms: exportIntervalMillis,
  });
  registerShutdown();
  return sdk;
}

export async function shutdownNodeObservability() {
  const active = sdk;
  sdk = undefined;
  if (active) await active.shutdown();
}

function registerShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.once("beforeExit", () => shutdownNodeObservability().catch(() => undefined));
}

function normalizedEndpoint(value: string | undefined) {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must use HTTP or HTTPS");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function boundedResourceValue(value: string, fallback: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:/-]+/gu, "_").slice(0, 128);
  return normalized || fallback;
}
