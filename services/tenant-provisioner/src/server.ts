import type { IncomingMessage, ServerResponse } from "node:http";
import {
  observeDuration,
  recordAuthorizationAnomaly,
  recordMetric,
  recordStructuredLog,
  safeRequestId,
} from "@wasalx/observability";
import { authenticateProvisioningRequest } from "./auth.js";
import type { ProvisionerConfig } from "./config.js";
import type { WorkspaceResourceClient } from "./kubernetes.js";
import { TenantWorkspaceReconciler } from "./reconciler.js";
import { ProvisionerError } from "./types.js";

const MAX_REQUEST_BYTES = 131_072;

export function createProvisionerHandler(
  config: ProvisionerConfig,
  client: WorkspaceResourceClient,
) {
  const reconciler = new TenantWorkspaceReconciler(config, client);
  return async (request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const requestId = safeRequestId(headerValue(request.headers["x-request-id"]));
    let operation = "unknown";
    let provisioningStartedAt: number | undefined;
    setSecurityHeaders(response, requestId);
    try {
      const url = new URL(request.url ?? "/", "http://tenant-provisioner.invalid");
      if (request.method === "GET" && url.pathname === "/livez") {
        operation = "livez";
        json(response, 200, { status: "live" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        operation = "readyz";
        const ready = await client.ready();
        recordMetric("wasalx_dependency_ready", ready ? 1 : 0, {
          component: "tenant_provisioner",
          dependency: "kubernetes_api",
        });
        json(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
        return;
      }
      if (
        request.method !== "POST" ||
        url.pathname !== "/internal/v1/tenant-provisioning/execute"
      ) {
        operation = "not_found";
        json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
        return;
      }
      operation = "execute";
      if (
        request.headers["x-wasalx-tenant-id"] !== undefined ||
        request.headers["x-wasalx-user-id"] !== undefined
      ) {
        throw new ProvisionerError(
          400,
          "TENANT_SESSION_FORBIDDEN",
          "Tenant-session headers are not accepted by the platform provisioner.",
        );
      }
      const rawBody = await readBody(request);
      const headers = nodeHeaders(request);
      const input = await authenticateProvisioningRequest(
        headers,
        rawBody,
        config.signingSecret,
      );
      operation = input.action === "PROVISION"
        ? (input.step?.toLowerCase() ?? "provision")
        : input.action.toLowerCase();
      provisioningStartedAt = Date.now();
      const result = await reconciler.execute(input);
      json(response, 200, result);
      recordProvisioning(operation, "succeeded", provisioningStartedAt);
      recordStructuredLog("info", "tenant_provisioning.step_succeeded", {
        request_id: requestId,
        action: input.action,
        step: input.step,
      });
    } catch (error) {
      const failure = error instanceof ProvisionerError
        ? error
        : new ProvisionerError(
            503,
            "PROVISIONER_UNAVAILABLE",
            "The tenant provisioning service is temporarily unavailable.",
            true,
          );
      if (failure.retryable) response.setHeader("retry-after", "15");
      json(response, failure.status, {
        error: {
          code: failure.code,
          message: failure.safeMessage,
          retryable: failure.retryable,
        },
      });
      if (provisioningStartedAt !== undefined || operation === "execute") {
        recordProvisioning(
          operation,
          failure.retryable ? "retryable_failure" : "terminal_failure",
          provisioningStartedAt ?? startedAt,
          failure.code,
        );
      }
      if (failure.status === 401 || failure.status === 403 || failure.code === "TENANT_SESSION_FORBIDDEN") {
        recordAuthorizationAnomaly("provisioner", failure.code);
      }
      recordStructuredLog(failure.status >= 500 ? "error" : "warn", "tenant_provisioning.request_failed", {
        request_id: requestId,
        error_code: failure.code,
        status: failure.status,
        retryable: failure.retryable,
      });
    } finally {
      const attributes = {
        component: "tenant_provisioner",
        operation,
        status: response.statusCode,
      };
      recordMetric("wasalx_http_server_requests_total", 1, attributes);
      observeDuration("wasalx_http_server_duration_seconds", startedAt, attributes);
    }
  };
}

function recordProvisioning(operation: string, result: string, startedAt: number, reason = "none") {
  const attributes = { operation, component: "tenant_provisioner", result, reason };
  recordMetric("wasalx_provisioning_operations_total", 1, attributes);
  observeDuration("wasalx_provisioning_duration_seconds", startedAt, attributes);
}

async function readBody(request: IncomingMessage) {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ProvisionerError(413, "REQUEST_TOO_LARGE", "The provisioning request is too large.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new ProvisionerError(413, "REQUEST_TOO_LARGE", "The provisioning request is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ProvisionerError(400, "REQUEST_INVALID", "The provisioning request is invalid.");
  }
}

function nodeHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function setSecurityHeaders(response: ServerResponse, requestId: string) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-request-id", requestId);
}

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
