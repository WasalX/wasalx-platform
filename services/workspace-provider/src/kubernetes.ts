import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { WorkspaceProviderConfig } from "./config.js";
import { ProviderError, type ProviderRequest } from "./types.js";

export type ProviderResource = {
  apiVersion: "providers.wasalx.io/v1alpha1";
  kind: "WorkspaceProviderResource";
  metadata: { name: string; namespace: string; generation?: number };
  spec: Record<string, unknown>;
  status?: Record<string, unknown>;
};

export interface ProviderGateway {
  reconcile(input: ProviderRequest): Promise<Record<string, string | number | boolean>>;
  rollback(input: ProviderRequest): Promise<void>;
  ready(): Promise<boolean>;
}

export class KubernetesProviderGateway implements ProviderGateway {
  constructor(
    private readonly config: WorkspaceProviderConfig,
    private readonly request: typeof httpsRequest = httpsRequest,
  ) {}

  async reconcile(input: ProviderRequest) {
    const resource = buildProviderResource(input, this.config.namespace);
    const applied = await this.call(
      "PATCH",
      resourcePath(this.config.namespace, resource.metadata.name) + `?fieldManager=${encodeURIComponent(this.config.fieldManager)}&force=false`,
      resource,
      "application/apply-patch+yaml",
    ) as ProviderResource;
    return validateReadyEvidence(input, applied);
  }

  async rollback(input: ProviderRequest) {
    const resource = buildProviderResource(input, this.config.namespace);
    resource.spec.lifecycle = "Absent";
    await this.call(
      "PATCH",
      resourcePath(this.config.namespace, resource.metadata.name) + `?fieldManager=${encodeURIComponent(this.config.fieldManager)}&force=false`,
      resource,
      "application/apply-patch+yaml",
    );
  }

  async ready() {
    try {
      await this.call("GET", `/apis/providers.wasalx.io/v1alpha1/namespaces/${encodeURIComponent(this.config.namespace)}/workspaceproviderresources?limit=1`);
      for (const name of Object.values(this.config.operatorDeployments)) {
        const deployment = await this.call("GET", `/apis/apps/v1/namespaces/${encodeURIComponent(this.config.namespace)}/deployments/${encodeURIComponent(name)}`) as Record<string, unknown>;
        const metadata = object(deployment.metadata);
        const status = object(deployment.status);
        if (!metadata || !status || Number(status.availableReplicas ?? 0) < 1 || Number(status.observedGeneration ?? 0) < Number(metadata.generation ?? 1)) return false;
      }
      return true;
    } catch { return false; }
  }

  private async call(method: string, path: string, body?: unknown, contentType?: string) {
    let token: string;
    let ca: Buffer;
    try {
      [token, ca] = await Promise.all([
        readFile(this.config.kubernetesTokenFile, "utf8").then((value) => value.trim()),
        readFile(this.config.kubernetesCaFile),
      ]);
    } catch { throw unavailable("KUBERNETES_IDENTITY_UNAVAILABLE"); }
    if (token.length < 16 || /[\p{Cc}\p{Cf}]/u.test(token)) throw unavailable("KUBERNETES_IDENTITY_INVALID");
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<unknown>((resolve, reject) => {
      const request = this.request(new URL(path, this.config.kubernetesApiUrl), {
        method,
        ca,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(payload ? { "content-type": contentType ?? "application/json", "content-length": payload.byteLength } : {}),
        },
        timeout: this.config.requestTimeoutMs,
        rejectUnauthorized: true,
      }, (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("error", (error) => reject(error instanceof ProviderError ? error : unavailable("KUBERNETES_UNAVAILABLE")));
        response.on("data", (chunk: Buffer) => {
          length += chunk.byteLength;
          if (length > 256_000) response.destroy(unavailable("KUBERNETES_RESPONSE_TOO_LARGE"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(new ProviderError(status === 409 || status === 422 ? 409 : 503, `KUBERNETES_HTTP_${status}`, status === 409 || status === 422 ? "The provider resource was rejected." : "The Kubernetes provider control plane is unavailable.", status !== 409 && status !== 422));
            return;
          }
          try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
          catch { reject(unavailable("KUBERNETES_RESPONSE_INVALID")); }
        });
      });
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", (error) => reject(error instanceof ProviderError ? error : unavailable("KUBERNETES_UNAVAILABLE")));
      if (payload) request.write(payload);
      request.end();
    });
  }
}

export function buildProviderResource(input: ProviderRequest, namespace: string): ProviderResource {
  const desiredStep = String(input.desired.desired_step);
  // Suspend and resume deliberately share one durable lifecycle resource.
  // RESUME patches that exact suspended CR back to Present, so credentials
  // cannot remain persistently revoked behind a separate "resume" object.
  const resourceType = input.action === "resume"
    ? "suspend"
    : input.action === "verify" ? verificationResourceType(desiredStep) : input.action;
  const compact = input.tenant_id.replaceAll("-", "");
  const serviceSecretReference = input.desired.service_secret_reference;
  const privacySecretReference = input.desired.privacy_secret_reference;
  const instanceId = String(input.desired.zammad.instanceId);
  const requestContextSha256 = providerRequestContextSha256(input);
  const refreshSequence = providerRefreshSequence(input, requestContextSha256);
  return {
    apiVersion: "providers.wasalx.io/v1alpha1",
    kind: "WorkspaceProviderResource",
    metadata: { name: `tenant-${compact}-${resourceType}`.slice(0, 63), namespace },
    spec: {
      tenantId: input.tenant_id,
      operationId: input.operation_id,
      action: input.action,
      resourceType,
      generation: input.generation,
      fencingToken: input.fencing_token,
      idempotencyKey: input.idempotency_key,
      refreshSequence,
      requestContextSha256,
      lifecycle: input.action === "suspend" ? "Suspended" : "Present",
      desired: input.desired,
      secretBindings: {
        service: {
          reference: serviceSecretReference,
          immutableProperties: {
            instance_id: instanceId,
            redis_host: `zammad-${compact}-redis.${namespace}.svc`,
            redis_username: "zammad",
          },
        },
        privacy: { reference: privacySecretReference },
      },
    },
  };
}

function providerRefreshSequence(input: ProviderRequest, requestContextSha256: string) {
  const prefix = `controller:${input.tenant_id}:${input.action}:${requestContextSha256}:r`;
  const sequence = input.idempotency_key.startsWith(prefix) ? input.idempotency_key.slice(prefix.length) : "";
  const value = Number(sequence);
  const refreshAction = input.action === "verify" || input.action === "suspend" || input.action === "resume";
  if (!/^(?:0|[1-9]\d*)$/u.test(sequence) || !Number.isSafeInteger(value) || (refreshAction ? value < 1 : value !== 0)) {
    throw new ProviderError(400, "IDEMPOTENCY_KEY_INVALID", "The provider idempotency key is invalid.");
  }
  return value;
}

function providerRequestContextSha256(input: ProviderRequest) {
  const context = {
    version: input.version,
    tenant_id: input.tenant_id,
    operation_id: input.operation_id,
    action: input.action,
    generation: input.generation,
    fencing_token: input.fencing_token,
    desired: input.desired,
  };
  return createHash("sha256").update(canonicalJson(context)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function validateReadyEvidence(input: ProviderRequest, resource: ProviderResource) {
  const status = object(resource.status);
  if (!status) throw unavailable("PROVIDER_STATUS_PENDING");
  if (status.phase !== "READY") {
    if (status.phase === "FAILED") throw new ProviderError(409, "PROVIDER_RESOURCE_REJECTED", "The provider resource was rejected.");
    throw unavailable("PROVIDER_STATUS_PENDING");
  }
  if (status.observedGeneration !== resource.metadata.generation || status.fencingToken !== input.fencing_token || status.idempotencyKey !== input.idempotency_key) {
    throw unavailable("PROVIDER_STATUS_STALE");
  }
  if (String(input.desired.desired_step) === "secrets") {
    const desiredBindings = object(resource.spec.secretBindings);
    const desiredService = object(desiredBindings?.service);
    const desiredProperties = object(desiredService?.immutableProperties);
    const bindings = object(status.secretBindings);
    const service = object(bindings?.service);
    const properties = object(service?.properties);
    if (
      service?.reference !== input.desired.service_secret_reference ||
      properties?.instance_id !== input.desired.zammad.instanceId ||
      properties?.redis_host !== desiredProperties?.redis_host ||
      properties?.redis_username !== desiredProperties?.redis_username
    ) {
      throw new ProviderError(409, "SERVICE_SECRET_INSTANCE_MISMATCH", "The service-secret binding does not match this Zammad instance.");
    }
  }
  const evidence = object(status.evidence);
  if (!evidence) throw unavailable("PROVIDER_EVIDENCE_PENDING");
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (!/^[a-z][a-z0-9_]{0,99}$/u.test(key) ||
        (!(["credentials_disabled", "credentials_enabled"].includes(key)) && /(password|token|credential|api_?key|private_?key|instance_id)/u.test(key))) {
      throw new ProviderError(409, "PROVIDER_EVIDENCE_SENSITIVE", "The provider returned unsafe evidence.");
    }
    if (typeof value === "string" && value.length > 0 && value.length <= 2_048 && !/[\p{Cc}\p{Cf}]/u.test(value) && !/:\/\/[^/@]+:[^/@]+@/u.test(value)) result[key] = value;
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
    else throw unavailable("PROVIDER_EVIDENCE_INVALID");
  }
  if (Object.keys(result).length === 0 || Object.keys(result).length > 20) throw unavailable("PROVIDER_EVIDENCE_INVALID");
  validateEvidenceContract(input, result);
  return result;
}

const EVIDENCE_KEYS: Record<string, readonly string[]> = {
  identity: ["identity_id", "oidc_client_id", "oidc_secret_reference"],
  database: ["database_reference", "database_role", "database_secret_reference"],
  search: ["search_namespace", "search_secret_reference"],
  storage: ["storage_prefix", "storage_secret_reference"],
  secrets: ["service_secret_reference", "privacy_secret_reference"],
  zammad: ["zammad_base_url", "deployment_name"],
  package: ["package_version", "package_sha256"],
  oidc: ["oidc_issuer", "oidc_client_id", "password_login_disabled"],
  defaults: ["zammad_group_id", "retention_days", "backup_policy"],
  health: ["healthy", "isolation_verified", "zammad_base_url", "checked_at"],
  suspend: ["suspended", "credentials_disabled", "workloads_scaled_to_zero", "ingress_disabled", "suspended_at"],
  resume: ["resumed", "credentials_enabled", "provider_resumed_at"],
};

function validateEvidenceContract(input: ProviderRequest, evidence: Record<string, string | number | boolean>) {
  const kind = input.action === "suspend" ? "suspend" : input.action === "resume" ? "resume" : input.action === "verify" ? verificationResourceType(String(input.desired.desired_step)) : input.action;
  const keys = EVIDENCE_KEYS[kind];
  if (!keys || Object.keys(evidence).length !== keys.length || Object.keys(evidence).some((key) => !keys.includes(key))) invalidEvidence();
  const desired = input.desired;
  const database = object(desired.database)!;
  const search = object(desired.search)!;
  const storage = object(desired.storage)!;
  const oidc = object(desired.oidc)!;
  const zammad = object(desired.zammad)!;
  const compact = input.tenant_id.replaceAll("-", "");
  const baseUrl = `https://${String(zammad.hostname)}`;
  switch (kind) {
    case "identity":
      nonempty(evidence.identity_id);
      exact(evidence.oidc_client_id, oidc.clientId); exact(evidence.oidc_secret_reference, oidc.secretReference);
      break;
    case "database":
      credentialFreeDatabase(evidence.database_reference, String(database.databaseName));
      exact(evidence.database_role, database.roleName); exact(evidence.database_secret_reference, database.secretReference);
      break;
    case "search": exact(evidence.search_namespace, search.namespace); exact(evidence.search_secret_reference, search.secretReference); break;
    case "storage": exact(evidence.storage_prefix, storage.prefix); exact(evidence.storage_secret_reference, storage.secretReference); break;
    case "secrets": exact(evidence.service_secret_reference, desired.service_secret_reference); exact(evidence.privacy_secret_reference, desired.privacy_secret_reference); break;
    case "zammad": exact(evidence.zammad_base_url, baseUrl); exact(evidence.deployment_name, `zammad-${compact}`); break;
    case "package": exact(evidence.package_version, zammad.packageVersion); exact(evidence.package_sha256, zammad.packageSha256); break;
    case "oidc": exact(evidence.oidc_issuer, oidc.issuer); exact(evidence.oidc_client_id, oidc.clientId); exact(evidence.password_login_disabled, true); break;
    case "defaults": nonempty(evidence.zammad_group_id); exact(evidence.retention_days, desired.retention_days); exact(evidence.backup_policy, "daily-encrypted"); break;
    case "health": exact(evidence.healthy, true); exact(evidence.isolation_verified, true); exact(evidence.zammad_base_url, baseUrl); isoDate(evidence.checked_at); break;
    case "suspend": exact(evidence.suspended, true); exact(evidence.credentials_disabled, true); exact(evidence.workloads_scaled_to_zero, true); exact(evidence.ingress_disabled, true); isoDate(evidence.suspended_at); break;
    case "resume": exact(evidence.resumed, true); exact(evidence.credentials_enabled, true); isoDate(evidence.provider_resumed_at); break;
    default: invalidEvidence();
  }
}

function verificationResourceType(desiredStep: string) {
  return desiredStep === "resume_prepare" || desiredStep === "resume_publish"
    ? "health"
    : desiredStep;
}

function credentialFreeDatabase(value: unknown, databaseName: string) {
  if (typeof value !== "string") invalidEvidence();
  let url: URL;
  try { url = new URL(value); } catch { invalidEvidence(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== `/${databaseName}`) invalidEvidence();
}
function exact(value: unknown, expected: unknown) { if (value !== expected) invalidEvidence(); }
function nonempty(value: unknown) { if (typeof value !== "string" || value.length < 1 || value.length > 2_048) invalidEvidence(); }
function isoDate(value: unknown) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) invalidEvidence(); }
function invalidEvidence(): never { throw new ProviderError(409, "PROVIDER_EVIDENCE_INVALID", "The provider returned invalid evidence."); }

function resourcePath(namespace: string, name: string) {
  return `/apis/providers.wasalx.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}/workspaceproviderresources/${encodeURIComponent(name)}`;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function unavailable(code: string) {
  return new ProviderError(503, code, "The provider resource is still reconciling.", true);
}
