#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 128_000;

export function createFakeWorkspaceProviderHandler(expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 16) {
    throw new Error("A test-only bearer token of at least 16 characters is required");
  }
  return async function handler(request, response) {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/health/ready") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    const match = /^\/internal\/v1\/tenant-workspaces\/([0-9a-f-]+)\/actions\/(identity|database|search|storage|verify|suspend|resume)$/iu.exec(request.url ?? "");
    if (request.method !== "POST" || !match) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    if (!secureEqual(request.headers.authorization, `Bearer ${expectedToken}`)) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "UNAUTHORIZED" }));
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBounded(request));
    } catch {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "INVALID_REQUEST" }));
      return;
    }
    const tenantId = match[1].toLowerCase();
    const action = match[2].toLowerCase();
    if (
      body?.version !== 1 ||
      body.tenant_id !== tenantId ||
      body.action !== action ||
      request.headers["idempotency-key"] !== body.idempotency_key
    ) {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: "CONTEXT_MISMATCH" }));
      return;
    }
    const evidence = fakeEvidence(action, body.desired, tenantId);
    response.statusCode = 200;
    response.end(JSON.stringify({
      status: "READY",
      tenant_id: tenantId,
      action,
      fencing_token: body.fencing_token,
      idempotency_key: body.idempotency_key,
      evidence,
    }));
  };
}

function fakeEvidence(action, desired, tenantId) {
  const compact = tenantId.replaceAll("-", "");
  if (action === "identity") return {
    identity_id: `fake-oidc-${compact}`,
    oidc_client_id: desired.oidc.clientId,
    oidc_secret_reference: desired.oidc.secretReference,
  };
  if (action === "database") return {
    database_reference: `postgresql://postgres.fake.svc/${desired.database.databaseName}`,
    database_role: desired.database.roleName,
    database_secret_reference: desired.database.secretReference,
  };
  if (action === "search") return { search_namespace: desired.search.namespace, search_secret_reference: desired.search.secretReference };
  if (action === "storage") return { storage_prefix: desired.storage.prefix, storage_secret_reference: desired.storage.secretReference };
  if (action === "suspend") return {
    suspended: true,
    credentials_disabled: true,
    workloads_scaled_to_zero: true,
    ingress_disabled: true,
    suspended_at: new Date().toISOString(),
  };
  if (action === "resume") return {
    resumed: true,
    credentials_enabled: true,
    provider_resumed_at: new Date().toISOString(),
  };
  const baseUrl = `https://${desired.zammad.hostname}`;
  switch (desired.desired_step) {
    case "secrets": return {
      service_secret_reference: desired.service_secret_reference,
      privacy_secret_reference: desired.privacy_secret_reference,
    };
    case "zammad": return { zammad_base_url: baseUrl, deployment_name: `zammad-${compact}` };
    case "package": return { package_version: desired.zammad.packageVersion, package_sha256: desired.zammad.packageSha256 };
    case "oidc": return { oidc_issuer: desired.oidc.issuer, oidc_client_id: desired.oidc.clientId, password_login_disabled: true };
    case "defaults": return { zammad_group_id: `fake-operations-${compact}`, retention_days: desired.retention_days, backup_policy: "daily-encrypted" };
    case "health": return { healthy: true, isolation_verified: true, zammad_base_url: baseUrl, checked_at: new Date().toISOString() };
    default: throw new Error("unsupported fake verification step");
  }
}

async function readBounded(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function secureEqual(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_FAKE_WORKSPACE_PROVIDER !== "true") {
    throw new Error("The fake workspace provider is test-only and cannot run in production");
  }
  const token = process.env.FAKE_WORKSPACE_PROVIDER_TOKEN;
  const port = Number(process.env.PORT ?? 18092);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT is invalid");
  const server = createServer(createFakeWorkspaceProviderHandler(token));
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`${JSON.stringify({ event: "fake_workspace_provider_listening", port })}\n`);
  });
}
