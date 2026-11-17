import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  observeDuration,
  recordMetric,
  recordStructuredLog,
  recordWebhook,
  safeErrorCode,
  safeRequestId,
} from "@wasalx/observability";

const startedAt = new WeakMap<object, number>();

export function registerHttpObservability(app: NestFastifyApplication) {
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook("onRequest", async (request, reply) => {
    startedAt.set(request, Date.now());
    const requestId = safeRequestId(header(request.headers["x-request-id"]));
    request.id = requestId;
    reply.header("x-request-id", requestId);
  });
  instance.addHook("onResponse", async (request, reply) => {
    const start = startedAt.get(request) ?? Date.now();
    const method = boundedMethod(request.method);
    const status = statusClass(reply.statusCode);
    recordMetric("wasalx_http_server_requests_total", 1, {
      component: "control_api",
      operation: method,
      status,
    });
    observeDuration("wasalx_http_server_duration_seconds", start, {
      component: "control_api",
      operation: method,
      status,
    });
    if (reply.statusCode >= 400 && request.url.startsWith("/webhooks/")) {
      recordWebhook(webhookProvider(request.url), "rejected", status);
    }
  });
  instance.addHook("onError", async (request, reply, error) => {
    recordStructuredLog(reply.statusCode >= 500 ? "error" : "warn", "http.request.failed", {
      request_id: request.id,
      component: "control_api",
      operation: boundedMethod(request.method),
      route: boundedRoute(request.routeOptions?.url),
      status: reply.statusCode,
      error_code: safeErrorCode(error),
    });
  });
}

function header(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function boundedMethod(value: string) {
  const normalized = value.toUpperCase();
  return new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]).has(normalized)
    ? normalized
    : "OTHER";
}

function statusClass(value: number) {
  return value >= 100 && value <= 599 ? `${Math.floor(value / 100)}xx` : "unknown";
}

function webhookProvider(url: string) {
  if (url.startsWith("/webhooks/waha/")) return "waha";
  if (url === "/webhooks/meta" || url.startsWith("/webhooks/meta?")) return "meta";
  return "unknown";
}

function boundedRoute(value: string | undefined) {
  if (!value) return "unknown";
  return value.replace(/[^A-Za-z0-9_/:.-]/gu, "_").slice(0, 160);
}
