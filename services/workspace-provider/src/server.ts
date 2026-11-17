import type { IncomingMessage, ServerResponse } from "node:http";
import type { FileBearerAuthenticator } from "./auth.js";
import type { WorkspaceProviderService } from "./service.js";
import { parseProviderRequest, ProviderError } from "./types.js";

export function createWorkspaceProviderHandler(service: WorkspaceProviderService, authenticator: FileBearerAuthenticator) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    setHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://workspace-provider.invalid");
      if (request.method === "GET" && url.pathname === "/health/live") {
        json(response, 200, { status: "live" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        const readiness = await service.ready();
        json(response, readiness.ready ? 200 : 503, { status: readiness.ready ? "ready" : "not_ready", database: readiness.database, provider_control_plane: readiness.providerControlPlane });
        return;
      }
      await authenticator.authenticate(header(request.headers.authorization));
      const route = /^\/internal\/v1\/tenant-workspaces\/([0-9a-f-]{36})\/actions\/([a-z]+)$/u.exec(url.pathname);
      if (request.method !== "POST" || !route) throw new ProviderError(404, "NOT_FOUND", "Not found.");
      if (request.headers["x-wasalx-tenant-id"] !== undefined || request.headers["x-wasalx-user-id"] !== undefined) {
        throw new ProviderError(400, "TENANT_SESSION_FORBIDDEN", "Tenant-session headers are not accepted.");
      }
      if (header(request.headers["content-type"])?.split(";", 1)[0] !== "application/json") {
        throw new ProviderError(415, "CONTENT_TYPE_INVALID", "A JSON request body is required.");
      }
      const body = await readJson(request, 128_000);
      const input = parseProviderRequest(body, route[1]!, route[2]!);
      if (header(request.headers["idempotency-key"]) !== input.idempotency_key) {
        throw new ProviderError(400, "IDEMPOTENCY_HEADER_MISMATCH", "The idempotency header does not match the request.");
      }
      json(response, 200, await service.execute(input));
    } catch (error) {
      const failure = error instanceof ProviderError
        ? error
        : new ProviderError(503, "PROVIDER_UNAVAILABLE", "The workspace provider is temporarily unavailable.", true);
      json(response, failure.status, { error: { code: failure.code, message: failure.safeMessage, retryable: failure.retryable } });
    }
  };
}

async function readJson(request: IncomingMessage, maximum: number) {
  const declared = Number(header(request.headers["content-length"]));
  if (Number.isFinite(declared) && declared > maximum) throw new ProviderError(413, "REQUEST_TOO_LARGE", "The provider request is too large.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maximum) throw new ProviderError(413, "REQUEST_TOO_LARGE", "The provider request is too large.");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProviderError(400, "REQUEST_JSON_INVALID", "The provider request is invalid JSON."); }
}

function setHeaders(response: ServerResponse) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
}
function json(response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
function header(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
