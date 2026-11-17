import type { IncomingMessage, ServerResponse } from "node:http";
import {
  observeDuration,
  recordAuthorizationAnomaly,
  recordMetric,
  recordStructuredLog,
  safeErrorCode,
  safeRequestId,
  safeTenantLogId,
  withSpan,
} from "@wasalx/observability";
import {
  AttestationError,
  equalSha256,
  identityPolicySha256,
  type IdentityPolicyAttestationVerifier,
} from "./attestation.js";
import type { IdentityPolicyStore } from "./repository.js";

export function createIdentityPolicyHandler(
  store: IdentityPolicyStore,
  verifier: IdentityPolicyAttestationVerifier,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const requestId = safeRequestId(header(request.headers["x-request-id"]));
    let operation = "unknown";
    setHeaders(response, requestId);
    try {
      const url = new URL(request.url ?? "/", "http://identity-policy-activator.invalid");
      if (request.method === "GET" && url.pathname === "/livez") {
        operation = "livez";
        json(response, 200, { status: "live" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        operation = "readyz";
        const [database, verifierJwks] = await Promise.all([store.ready(), verifier.ready()]);
        recordMetric("wasalx_dependency_ready", database ? 1 : 0, {
          component: "identity_policy_activator", dependency: "postgresql",
        });
        recordMetric("wasalx_dependency_ready", verifierJwks ? 1 : 0, {
          component: "identity_policy_activator", dependency: "attestation_jwks",
        });
        recordMetric("wasalx_worker_heartbeat", database && verifierJwks ? 1 : 0, {
          component: "identity_policy_activator",
        });
        json(response, database && verifierJwks ? 200 : 503, {
          status: database && verifierJwks ? "ready" : "not_ready",
          database,
          verifierJwks,
        });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/internal/v1/identity-policy/activate") {
        operation = "not_found";
        json(response, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
        return;
      }
      operation = "activate";
      if (request.headers["x-wasalx-tenant-id"] !== undefined || request.headers["x-wasalx-user-id"] !== undefined) {
        throw new AttestationError(400, "TENANT_SESSION_FORBIDDEN", "Tenant-session headers are not accepted.");
      }
      const contentLength = header(request.headers["content-length"]);
      if ((contentLength !== undefined && contentLength !== "0") || request.headers["transfer-encoding"] !== undefined) {
        throw new AttestationError(400, "REQUEST_BODY_FORBIDDEN", "The activation request body must be empty.");
      }
      const authorization = header(request.headers.authorization);
      if (!authorization?.startsWith("Bearer ")) {
        throw new AttestationError(401, "ATTESTATION_REQUIRED", "Signed verification evidence is required.");
      }
      const compactJws = authorization.slice(7);
      const attestation = await verifier.verify(compactJws);
      const activated = await withSpan("identity policy activation", {
        attributes: { "wasalx.component": "identity_policy_activator" },
      }, () => store.withRequestedPolicy(
        attestation.tenantId,
        attestation.settingsVersion,
        async (policy, activate) => {
          if (!equalSha256(identityPolicySha256(policy), attestation.policySha256)) {
            throw new AttestationError(409, "POLICY_SNAPSHOT_MISMATCH", "The requested policy changed after verification.");
          }
          if (!await activate(attestation.evidenceSha256)) {
            throw new AttestationError(409, "POLICY_ACTIVATION_CONFLICT", "The requested policy can no longer be activated.");
          }
          return true;
        },
      ));
      if (activated !== true) {
        throw new AttestationError(409, "POLICY_NOT_REQUESTED", "The requested policy is unavailable or already active.");
      }
      recordMetric("wasalx_provisioning_operations_total", 1, {
        component: "identity_policy_activator", operation: "policy_activation", result: "succeeded",
      });
      recordStructuredLog("info", "identity_policy.activation_succeeded", {
        tenant_id: safeTenantLogId(attestation.tenantId),
        settings_version: attestation.settingsVersion,
        verification_run_id: attestation.verificationRunId,
        request_id: requestId,
      });
      json(response, 200, {
        tenantId: attestation.tenantId,
        settingsVersion: attestation.settingsVersion,
        state: "ACTIVE",
      });
    } catch (error) {
      const failure = error instanceof AttestationError
        ? error
        : new AttestationError(503, "ACTIVATOR_UNAVAILABLE", "Identity-policy activation is temporarily unavailable.");
      if (failure.status === 401 || failure.status === 403 || failure.code === "TENANT_SESSION_FORBIDDEN") {
        recordAuthorizationAnomaly("provisioner", failure.code);
      }
      if (operation === "activate") {
        recordMetric("wasalx_provisioning_operations_total", 1, {
          component: "identity_policy_activator",
          operation: "policy_activation",
          result: failure.status >= 500 ? "retryable_failure" : "rejected",
          reason: failure.code,
        });
      }
      recordStructuredLog(failure.status >= 500 ? "error" : "warn", "identity_policy.activation_failed", {
        request_id: requestId,
        error_code: error instanceof AttestationError ? error.code : safeErrorCode(error),
        status: failure.status,
      });
      json(response, failure.status, { error: { code: failure.code, message: failure.safeMessage } });
    } finally {
      recordMetric("wasalx_http_server_requests_total", 1, {
        component: "identity_policy_activator", operation, status: response.statusCode,
      });
      observeDuration("wasalx_http_server_duration_seconds", startedAt, {
        component: "identity_policy_activator", operation, status: response.statusCode,
      });
    }
  };
}

function setHeaders(response: ServerResponse, requestId: string) {
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

function header(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
