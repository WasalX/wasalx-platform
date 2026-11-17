import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { traceCarrierHeaders } from "@wasalx/observability";
import type { ControllerConfig } from "./config.js";
import type { ProvisioningStep, TenantWorkspace } from "../types.js";

export type ProviderAction = Extract<ProvisioningStep, "identity" | "database" | "search" | "storage"> | "verify" | "suspend" | "resume";

export class ProviderDependencyError extends Error {
  constructor(readonly retryable: boolean, readonly code: string) {
    super(retryable ? "A workspace provider dependency is temporarily unavailable." : "A workspace provider rejected the tenant resource specification.");
    this.name = "ProviderDependencyError";
  }
}

export interface WorkspaceProvider {
  execute(action: ProviderAction, workspace: TenantWorkspace): Promise<Record<string, unknown>>;
  ready(): Promise<boolean>;
}

export class HttpWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly config: ControllerConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async execute(action: ProviderAction, workspace: TenantWorkspace) {
    const tenantId = workspace.spec.tenantId;
    const refreshSequence = action === "verify" || action === "suspend" || action === "resume"
      ? Math.floor(this.now() / 60_000)
      : 0;
    const context = {
      version: 1,
      tenant_id: tenantId,
      operation_id: workspace.spec.request.operationId,
      action,
      generation: workspace.metadata.generation,
      fencing_token: workspace.spec.request.fencingToken,
      desired: providerDesired(workspace),
    };
    const requestIdentity = createHash("sha256").update(canonicalJson(context)).digest("hex");
    const idempotencyKey = `controller:${tenantId}:${action}:${requestIdentity}:r${refreshSequence}`;
    const body = { ...context, idempotency_key: idempotencyKey };
    const result = await this.request(
      `internal/v1/tenant-workspaces/${encodeURIComponent(tenantId)}/actions/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      },
    );
    const record = object(result);
    if (
      record?.status !== "READY" ||
      record.tenant_id !== tenantId ||
      record.action !== action ||
      record.fencing_token !== workspace.spec.request.fencingToken ||
      record.idempotency_key !== idempotencyKey
    ) {
      throw new ProviderDependencyError(true, "PROVIDER_EVIDENCE_INVALID");
    }
    return safeEvidence(record.evidence);
  }

  async ready() {
    try {
      const result = await this.request("health/ready", { method: "GET" });
      return object(result)?.status === "ready";
    } catch {
      return false;
    }
  }

  private async request(path: string, init: RequestInit) {
    let token: string;
    try {
      token = (await readFile(this.config.providerTokenFile, "utf8")).trim();
    } catch {
      throw new ProviderDependencyError(true, "PROVIDER_TOKEN_UNAVAILABLE");
    }
    if (token.length < 16 || token.length > 16_384 || /[\p{Cc}\p{Cf}]/u.test(token)) {
      throw new ProviderDependencyError(true, "PROVIDER_TOKEN_INVALID");
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.config.providerUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...traceCarrierHeaders(),
          ...init.headers,
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.config.providerTimeoutMs),
      });
    } catch {
      throw new ProviderDependencyError(true, "PROVIDER_UNREACHABLE");
    }
    const body = await boundedJson(response, 128_000);
    if (!response.ok) {
      const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
      throw new ProviderDependencyError(retryable, `PROVIDER_HTTP_${response.status}`);
    }
    return body;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function providerDesired(workspace: TenantWorkspace) {
  const spec = workspace.spec;
  return {
    tenant_id: spec.tenantId,
    slug: spec.slug,
    region: spec.region,
    owner: spec.owner,
    database: spec.database,
    search: spec.search,
    storage: spec.storage,
    service_secret_reference: spec.secrets.serviceSecretReference,
    privacy_secret_reference: spec.secrets.privacySecretReference,
    zammad: {
      instanceId: spec.zammad.instanceId,
      version: spec.zammad.version,
      hostname: spec.zammad.hostname,
      packageVersion: spec.zammad.packageVersion,
      packageSha256: spec.zammad.packageSha256,
    },
    oidc: spec.oidc,
    retention_days: spec.retentionDays,
    desired_state: spec.desiredState,
    desired_step: spec.request.desiredStep,
  };
}

async function boundedJson(response: Response, maximum: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new ProviderDependencyError(true, "PROVIDER_RESPONSE_TOO_LARGE");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new ProviderDependencyError(true, "PROVIDER_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength === 0) return {};
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ProviderDependencyError(true, "PROVIDER_RESPONSE_INVALID"); }
}

function safeEvidence(value: unknown) {
  const record = object(value);
  if (!record || Object.keys(record).length > 20) throw new ProviderDependencyError(true, "PROVIDER_EVIDENCE_INVALID");
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      !/^[a-z][a-z0-9_]{0,99}$/u.test(key) ||
      (!["credentials_disabled", "credentials_enabled"].includes(key) && /(password|token|api_?key|private_?key|credential)/u.test(key))
    ) {
      throw new ProviderDependencyError(false, "PROVIDER_EVIDENCE_SENSITIVE");
    }
    if (typeof entry === "string") {
      if (entry.length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(entry) || /:\/\/[^/@]+:[^/@]+@/u.test(entry)) {
        throw new ProviderDependencyError(false, "PROVIDER_EVIDENCE_SENSITIVE");
      }
      result[key] = entry;
    } else if (typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
      if (["credentials_disabled", "credentials_enabled"].includes(key) && entry !== true) {
        throw new ProviderDependencyError(false, "PROVIDER_EVIDENCE_SENSITIVE");
      }
      result[key] = entry;
    } else {
      throw new ProviderDependencyError(true, "PROVIDER_EVIDENCE_INVALID");
    }
  }
  return result;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
