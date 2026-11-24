import {
  context,
  metrics,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

const INSTRUMENTATION_NAME = "io.wasalx.platform";
const INSTRUMENTATION_VERSION = "0.1.0";

const sensitiveKey = /(?:^|_)(?:body|text|payload|secret|token|authorization|cookie|password|qr|pass_?key|phone|reference|url|group_name|messages?|title|filename|api_key|access_key|credentials?|private_key|signature|t?otp|passphrase|hmac)(?:_|$)/iu;
// Provider message, chat, and recipient identifiers can contain phone numbers.
const personalFieldKey = /(?:^|_)(?:e_?mails?|recipients?|subjects?|contacts?|senders?|user_?names?|push_?names?|chat_ids?|wamids?|wa_?ids?|participants?|authors?|nicknames?|(?:first|last|full|display|recipient|customer|agent|profile|nick)_names?)(?:_|$)|^names?$/iu;
const addressKey = /(?:^|\.)(?:to|from|cc|bcc|reply[ _-]?to|mail[ _-]?from|address)$/iu;
const internalIdKey = /^(?:contact|sender|subject|e_?mail)_id$/iu;
const messageCounterKey = /^messages?_(?:count|sent)$/iu;
const providerMessageIdLike = /\b(?:wamid\.[A-Za-z0-9+/_=-]+|(?:true|false)_[\d-]+@(?:c\.us|g\.us|lid|s\.whatsapp\.net)_[A-Za-z0-9_-]+(?:@(?:c\.us|lid|s\.whatsapp\.net))?|[\d-]+@lid\b(?!-|\.[\p{L}\p{N}-]))/gu;
const emailLike = /[\p{L}\p{N}.!#$%&'*+/=?^`{|}~-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu;
const barePhoneLike = /^[1-9]\d{9,14}$/u;
const phoneLike = /(?:\+\d[\d\s()-]{7,}\d|\b\d{2,4}(?:[ ()]\d{2,4}){2,}\b)/gu;
const logTextLimit = 2_000;
// Scan past the output limit to catch addresses that cross it.
const logScanLimit = logTextLimit + 400;
const bearerLike = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const traceParentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Provider = "waha" | "meta" | "unknown";
export type MetricAttributes = Readonly<Record<string, string | number | boolean>>;
export type TraceCarrier = {
  traceparent?: string;
  tracestate?: string;
  requestId: string;
};

type MetricKind = "counter" | "histogram" | "gauge";
type MetricDefinition = {
  kind: MetricKind;
  description: string;
  unit?: string;
};

/**
 * Authoritative WasalX metric catalog. Metric attributes are intentionally
 * bounded in the record helpers below. Tenant IDs, connection IDs, group
 * titles, phone numbers, references, message IDs, and request IDs are never
 * metric labels.
 */
export const metricDefinitions = {
  wasalx_http_server_requests_total: { kind: "counter", description: "Completed HTTP requests" },
  wasalx_http_server_duration_seconds: { kind: "histogram", description: "HTTP server request duration", unit: "s" },
  wasalx_webhook_accepted_total: { kind: "counter", description: "Provider webhook events durably accepted" },
  wasalx_webhook_rejected_total: { kind: "counter", description: "Provider webhook requests rejected before acceptance" },
  wasalx_webhook_duplicates_total: { kind: "counter", description: "Duplicate provider events suppressed" },
  wasalx_inbox_queue_age_seconds: { kind: "gauge", description: "Age of the oldest pending inbox event", unit: "s" },
  wasalx_outbox_queue_age_seconds: { kind: "gauge", description: "Age of the oldest pending delivery", unit: "s" },
  wasalx_work_queue_age_seconds: { kind: "gauge", description: "Age of the oldest pending durable work item", unit: "s" },
  wasalx_queue_depth: { kind: "gauge", description: "Pending durable work rows" },
  wasalx_rule_evaluation_seconds: { kind: "histogram", description: "Deterministic rule evaluation duration", unit: "s" },
  wasalx_rule_matches_total: { kind: "counter", description: "Rule evaluation match outcomes" },
  wasalx_inbound_to_zammad_seconds: { kind: "histogram", description: "Durable webhook acceptance to Zammad case update duration", unit: "s" },
  wasalx_ticket_operation_total: { kind: "counter", description: "Zammad ticket and article operations" },
  wasalx_ticket_operation_seconds: { kind: "histogram", description: "Zammad operation duration", unit: "s" },
  wasalx_provider_send_seconds: { kind: "histogram", description: "Provider send attempt duration", unit: "s" },
  wasalx_outbound_to_provider_seconds: { kind: "histogram", description: "Zammad delivery request creation to provider send duration", unit: "s" },
  wasalx_delivery_state_total: { kind: "counter", description: "Durable delivery state transitions" },
  wasalx_delivery_retry_total: { kind: "counter", description: "Delivery retries scheduled" },
  wasalx_delivery_terminal_failure_total: { kind: "counter", description: "Terminal delivery failures" },
  wasalx_delivery_outcome_unknown_total: { kind: "counter", description: "Provider send outcomes that cannot be determined safely" },
  wasalx_delivery_receipts_total: { kind: "counter", description: "Provider delivery receipt processing outcomes" },
  wasalx_delivery_persistence_failure_total: { kind: "counter", description: "Provider sends whose durable completion could not be persisted" },
  wasalx_connection_state: { kind: "gauge", description: "Observed connection count by state" },
  wasalx_connection_transition_total: { kind: "counter", description: "Connection lifecycle transitions" },
  wasalx_connection_operation_seconds: { kind: "histogram", description: "Connection lifecycle operation duration", unit: "s" },
  wasalx_connection_reauthentication_total: { kind: "counter", description: "Connections requiring reauthentication" },
  wasalx_worker_heartbeat: { kind: "gauge", description: "Worker component readiness (1 ready, 0 unavailable)" },
  wasalx_worker_jobs_total: { kind: "counter", description: "Connector worker drain job outcomes" },
  wasalx_waha_worker_health: { kind: "gauge", description: "WAHA worker health by stable registry worker and engine" },
  wasalx_waha_worker_capacity: { kind: "gauge", description: "Configured WAHA session capacity by stable registry worker and engine" },
  wasalx_waha_worker_sessions: { kind: "gauge", description: "Active sessions durably assigned to a WAHA registry worker" },
  wasalx_waha_worker_mode_changes_total: { kind: "counter", description: "WAHA worker lifecycle and rollout mode changes" },
  wasalx_metered_quantity_total: { kind: "counter", description: "Durably accepted usage quantity by bounded meter and source" },
  wasalx_metered_estimated_cost_micros_total: { kind: "counter", description: "Estimated priced usage in currency micros" },
  wasalx_platform_quota_changes_total: { kind: "counter", description: "Audited platform quota configuration changes" },
  wasalx_platform_meter_rate_changes_total: { kind: "counter", description: "Audited platform meter rate additions" },
  wasalx_metering_capture_periods_total: { kind: "counter", description: "Authoritative hourly metering capture outcomes" },
  wasalx_metering_capture_duration_seconds: { kind: "histogram", description: "Authoritative hourly metering capture duration", unit: "s" },
  wasalx_tenant_authorization_denied_total: { kind: "counter", description: "Authorization anomalies and denied requests" },
  wasalx_privacy_job_total: { kind: "counter", description: "Privacy and retention job outcomes" },
  wasalx_privacy_job_duration_seconds: { kind: "histogram", description: "Privacy and retention job duration", unit: "s" },
  wasalx_privacy_deletion_total: { kind: "counter", description: "Privacy deletion outcomes" },
  wasalx_privacy_export_total: { kind: "counter", description: "Privacy export outcomes" },
  wasalx_privacy_legal_hold_block_total: { kind: "counter", description: "Privacy actions blocked by legal hold" },
  wasalx_unmatched_diagnostic_purged_total: { kind: "counter", description: "Expired unmatched diagnostics purged" },
  wasalx_provisioning_operations_total: { kind: "counter", description: "Tenant provisioning step outcomes" },
  wasalx_provisioning_duration_seconds: { kind: "histogram", description: "Tenant provisioning step duration", unit: "s" },
  wasalx_media_quarantine_total: { kind: "counter", description: "Media or message quarantine outcomes" },
  wasalx_database_pool_connections: { kind: "gauge", description: "Database pool connections by state" },
  wasalx_dependency_ready: { kind: "gauge", description: "Runtime dependency readiness (1 ready, 0 unavailable)" },
} as const satisfies Record<string, MetricDefinition>;

export const metricNames = Object.freeze(Object.keys(metricDefinitions)) as readonly MetricName[];
export type MetricName = keyof typeof metricDefinitions;

const instruments = new Map<MetricName, ReturnType<typeof createInstrument>>();

export function redactLogValue(value: unknown, key = ""): unknown {
  const separatedKey = key.replace(/[.\s-]+/gu, "_");
  const normalizedKey = separatedKey
    .replace(/IDs(?=$|[^a-z])/gu, "Ids")
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2");
  if (typeof value === "string" && internalIdKey.test(normalizedKey) && uuidPattern.test(value)) {
    return value;
  }
  const messageCounter = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
    messageCounterKey.test(normalizedKey);
  if (!messageCounter && (
    sensitiveKey.test(separatedKey) || sensitiveKey.test(normalizedKey) ||
    personalFieldKey.test(separatedKey) || personalFieldKey.test(normalizedKey) ||
    addressKey.test(key)
  )) {
    return "[REDACTED]";
  }
  if (typeof value === "number" && barePhoneLike.test(String(value))) return "[PHONE]";
  if (typeof value === "string") {
    const prefix = value.slice(0, logScanLimit);
    if (barePhoneLike.test(prefix)) return "[PHONE]";
    const scrubbed = prefix.replace(bearerLike, "[CREDENTIAL]").replace(providerMessageIdLike, "[REDACTED]");
    const cleaned = (scrubbed.includes("@") ? scrubbed.replace(emailLike, "[EMAIL]") : scrubbed)
      .replace(phoneLike, "[PHONE]");
    return value.length > prefix.length || cleaned.length > logTextLimit
      ? `${cleaned.slice(0, logTextLimit)}…`
      : cleaned;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([entryKey, entryValue]) => [entryKey, redactLogValue(entryValue, entryKey)]),
    );
  }
  return value;
}

export function parseTraceParent(value: string | null | undefined) {
  if (!value) return null;
  const match = traceParentPattern.exec(value);
  if (!match || /^0+$/u.test(match[1] ?? "") || /^0+$/u.test(match[2] ?? "")) return null;
  return {
    traceId: (match[1] ?? "").toLowerCase(),
    parentId: (match[2] ?? "").toLowerCase(),
    sampled: (Number.parseInt(match[3] ?? "0", 16) & 1) === 1,
  };
}

export function safeRequestId(value?: string | null) {
  return value && requestIdPattern.test(value) ? value : crypto.randomUUID();
}

export function safeTenantLogId(value: unknown) {
  return typeof value === "string" && uuidPattern.test(value) ? value.toLowerCase() : undefined;
}

export function currentTraceCarrier(requestId?: string | null): TraceCarrier {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!parseTraceParent(carrier.traceparent)) carrier.traceparent = generatedTraceParent();
  return {
    traceparent: carrier.traceparent,
    ...(carrier.tracestate ? { tracestate: carrier.tracestate.slice(0, 512) } : {}),
    requestId: safeRequestId(requestId),
  };
}

export function traceCarrierHeaders(requestId?: string | null) {
  const carrier = currentTraceCarrier(requestId);
  return {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
    "x-request-id": carrier.requestId,
  };
}

export function extractTraceCarrier(carrier: Partial<TraceCarrier> | Record<string, unknown>): Context {
  const normalized: Record<string, string> = {};
  if (typeof carrier.traceparent === "string" && parseTraceParent(carrier.traceparent)) {
    normalized.traceparent = carrier.traceparent;
  }
  if (typeof carrier.tracestate === "string" && carrier.tracestate.length <= 512) {
    normalized.tracestate = carrier.tracestate;
  }
  return propagation.extract(context.active(), normalized);
}

export async function withSpan<T>(
  name: string,
  options: {
    kind?: SpanKind;
    attributes?: Attributes;
    carrier?: Partial<TraceCarrier>;
  },
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.carrier ? extractTraceCarrier(options.carrier) : context.active();
  return context.with(parent, () => instrumentationTracer().startActiveSpan(
    boundedSpanName(name),
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: safeTraceAttributes(options.attributes) },
    async (span) => {
      try {
        const result = await operation(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorCode(error) });
        span.setAttribute("error.type", safeErrorType(error));
        throw error;
      } finally {
        span.end();
      }
    },
  ));
}

export function recordMetric(name: MetricName, value = 1, attributes: MetricAttributes = {}) {
  if (!Number.isFinite(value)) return;
  const instrument = instrumentFor(name);
  const safe = safeMetricAttributes(attributes);
  if (instrument.kind === "counter") instrument.value.add(Math.max(0, value), safe);
  else if (instrument.kind === "histogram") instrument.value.record(Math.max(0, value), safe);
  else instrument.value.record(value, safe);
}

export function observeDuration(
  name: Extract<MetricName, `${string}_seconds`>,
  startedAt: number,
  attributes: MetricAttributes = {},
) {
  recordMetric(name, Math.max(0, Date.now() - startedAt) / 1_000, attributes);
}

export function recordWebhook(provider: Provider, outcome: "accepted" | "rejected" | "duplicate", reason = "none") {
  const name = outcome === "accepted"
    ? "wasalx_webhook_accepted_total"
    : outcome === "duplicate"
      ? "wasalx_webhook_duplicates_total"
      : "wasalx_webhook_rejected_total";
  recordMetric(name, 1, { provider, reason: boundedReason(reason) });
}

export function recordAuthorizationAnomaly(surface: "portal" | "tenant_api" | "service_api" | "provider_webhook" | "provisioner", reason: string) {
  recordMetric("wasalx_tenant_authorization_denied_total", 1, { surface, reason: boundedReason(reason) });
}

export function recordDeliveryState(provider: Provider, state: string, reason = "none") {
  const bounded = deliveryState(state);
  recordMetric("wasalx_delivery_state_total", 1, { provider, state: bounded, reason: boundedReason(reason) });
  if (bounded === "FAILED_TERMINAL") recordMetric("wasalx_delivery_terminal_failure_total", 1, { provider, reason: boundedReason(reason) });
  if (bounded === "OUTCOME_UNKNOWN") recordMetric("wasalx_delivery_outcome_unknown_total", 1, { provider, reason: boundedReason(reason) });
}

export function recordStructuredLog(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const active = trace.getSpan(context.active())?.spanContext();
  const entry = redactLogValue({
    timestamp: new Date().toISOString(),
    level,
    event: boundedEventName(event),
    ...(active && trace.isSpanContextValid(active)
      ? { trace_id: active.traceId, span_id: active.spanId }
      : {}),
    ...fields,
  }) as Record<string, unknown>;
  const output = `${JSON.stringify(entry)}\n`;
  if (typeof process !== "undefined" && process.stdout && process.stderr) {
    if (level === "error" || level === "warn") process.stderr.write(output);
    else process.stdout.write(output);
  } else if (level === "error") console.error(output.trimEnd());
  else if (level === "warn") console.warn(output.trimEnd());
  else console.log(output.trimEnd());
  return entry;
}

export function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "UNKNOWN_ERROR";
  const candidate = (error as { code?: unknown }).code;
  if (typeof candidate === "string" && /^[A-Z0-9_.-]{1,64}$/u.test(candidate)) return candidate;
  return safeErrorType(error).replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase().slice(0, 64);
}

export function safeErrorType(error: unknown) {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
}

function instrumentFor(name: MetricName) {
  const existing = instruments.get(name);
  if (existing) return existing;
  const created = createInstrument(name);
  instruments.set(name, created);
  return created;
}

function createInstrument(name: MetricName) {
  const definition = metricDefinitions[name];
  const options = {
    description: definition.description,
    ...("unit" in definition && definition.unit ? { unit: definition.unit } : {}),
  };
  const meter = instrumentationMeter();
  if (definition.kind === "counter") return { kind: "counter" as const, value: meter.createCounter(name, options) };
  if (definition.kind === "histogram") return { kind: "histogram" as const, value: meter.createHistogram(name, options) };
  return { kind: "gauge" as const, value: meter.createGauge(name, options) };
}

// The observability package is imported by the SDK bootstrap itself. Resolve
// providers lazily so instruments and tracers are never bound to the API's
// pre-bootstrap no-op providers.
function instrumentationMeter() {
  return metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

function instrumentationTracer() {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

function safeMetricAttributes(attributes: MetricAttributes): Attributes {
  const allowedKeys = new Set([
    "action", "component", "currency", "dependency", "engine", "job_type", "lifecycle_state", "meter", "operation", "outcome", "period", "provider",
    "queue", "reason", "result", "rollout_mode", "scope", "source", "state", "status", "surface", "work_type", "worker",
  ]);
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value === "string") result[key] = boundedLabel(value);
    else if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

function safeTraceAttributes(attributes: Attributes | undefined): Attributes {
  if (!attributes) return {};
  const allowed = new Set([
    "messaging.system", "messaging.operation.name", "rpc.system", "server.address", "http.request.method",
    "http.response.status_code", "wasalx.component", "wasalx.operation", "wasalx.provider", "wasalx.result",
    "wasalx.request_id", "wasalx.work_type", "error.type",
  ]);
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => allowed.has(key)));
}

function boundedLabel(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, "_");
  return normalized.slice(0, 64) || "unknown";
}

function boundedReason(value: string) {
  return boundedLabel(value || "none");
}

function boundedEventName(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 128) || "unknown_event";
}

function boundedSpanName(value: string) {
  return value.replace(/[^A-Za-z0-9_. /-]/gu, "_").slice(0, 128) || "wasalx.operation";
}

function deliveryState(value: string) {
  const normalized = value.toUpperCase();
  return new Set([
    "QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED_RETRYABLE", "FAILED_TERMINAL",
    "OUTCOME_UNKNOWN", "BLOCKED", "QUARANTINED",
  ]).has(normalized) ? normalized : "UNKNOWN";
}

function generatedTraceParent() {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  return `00-${traceId}-${spanId}-01`;
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
}
