import type { ProvisionerConfig } from "./config.js";
import { isDeepStrictEqual } from "node:util";
import type { WorkspaceResourceClient } from "./kubernetes.js";
import {
  ProvisionerError,
  type ProvisioningStep,
  type TenantProvisioningRequest,
  type TenantProvisioningResult,
  type TenantWorkspace,
  type WorkspaceCondition,
  type WorkspaceSpec,
} from "./types.js";

const CONDITION_BY_STEP: Record<ProvisioningStep | "suspend" | "resume_prepare" | "resume", string> = {
  identity: "IdentityReady",
  database: "DatabaseReady",
  search: "SearchReady",
  storage: "StorageReady",
  secrets: "SecretsReady",
  zammad: "ZammadReady",
  package: "PackageReady",
  oidc: "OidcReady",
  defaults: "DefaultsReady",
  health: "Healthy",
  suspend: "Suspended",
  resume_prepare: "ResumePrepared",
  resume: "Resumed",
};

type ReconcilerRuntime = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class TenantWorkspaceReconciler {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly config: ProvisionerConfig,
    private readonly client: WorkspaceResourceClient,
    runtime: ReconcilerRuntime = {},
  ) {
    this.now = runtime.now ?? Date.now;
    this.sleep = runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async execute(request: TenantProvisioningRequest): Promise<TenantProvisioningResult> {
    const name = workspaceName(request.tenantId);
    const current = await this.client.get(name);
    const resource = desiredResource(this.config, request, current?.metadata.resourceVersion);
    validateExisting(current, request, resource.spec);
    const applied = await this.client.apply(resource);
    const desiredGeneration = positiveGeneration(applied.metadata.generation);
    const outputs = await this.waitForResult(name, request, desiredGeneration, applied);
    return {
      status: "SUCCEEDED",
      operationId: request.operationId,
      zammadInstanceId: request.zammadInstanceId,
      tenantId: request.tenantId,
      action: request.action,
      ...(request.step ? { step: request.step } : {}),
      ...(request.resumePhase ? { resumePhase: request.resumePhase } : {}),
      fencingToken: request.fencingToken,
      idempotencyKey: request.idempotencyKey,
      outputs,
    };
  }

  private async waitForResult(
    name: string,
    request: TenantProvisioningRequest,
    desiredGeneration: number,
    applied: TenantWorkspace,
  ) {
    const deadline = this.now() + this.config.reconcileTimeoutMs;
    let workspace: TenantWorkspace | null = applied;
    for (;;) {
      const result = readyOutputs(this.config, request, desiredGeneration, workspace, this.now());
      if (result) return result;
      const failure = terminalCondition(request, desiredGeneration, workspace);
      if (failure) {
        throw new ProvisionerError(422, "RECONCILIATION_REJECTED", failure);
      }
      if (this.now() >= deadline) {
        throw new ProvisionerError(
          503,
          "RECONCILIATION_PENDING",
          "The tenant workspace is still reconciling.",
          true,
        );
      }
      await this.sleep(this.config.pollIntervalMs);
      workspace = await this.client.get(name);
      if (!workspace) {
        throw new ProvisionerError(
          503,
          "WORKSPACE_DISAPPEARED",
          "The tenant workspace disappeared while reconciling.",
          true,
        );
      }
    }
  }
}

export function desiredResource(
  config: ProvisionerConfig,
  request: TenantProvisioningRequest,
  resourceVersion?: string,
): TenantWorkspace {
  const compact = request.tenantId.replaceAll("-", "");
  const desiredStep = request.action === "PROVISION"
    ? request.step
    : request.action === "SUSPEND"
      ? "suspend"
      : request.resumePhase === "PREPARE"
        ? "resume_prepare"
        : "resume_publish";
  if (!desiredStep) throw new ProvisionerError(400, "STEP_REQUIRED", "A provisioning step is required.");
  const hostname = `${request.spec.tenant.slug}.${config.workspaceBaseDomain}`;
  if (hostname.length > 253) {
    throw new ProvisionerError(422, "HOSTNAME_INVALID", "The tenant workspace hostname is too long.");
  }
  const release = request.spec.deployment.release;
  const spec: WorkspaceSpec = {
    tenantId: request.tenantId,
    displayName: request.spec.tenant.name,
    slug: request.spec.tenant.slug,
    region: request.spec.deployment.region,
    resourceProfile: request.spec.deployment.resourceProfile,
    retentionDays: request.spec.tenant.retentionDays,
    owner: { ...request.spec.owner },
    request: {
      operationId: request.operationId,
      action: request.action,
      desiredStep,
      ...(request.resumePhase ? { resumePhase: request.resumePhase } : {}),
      fencingToken: request.fencingToken,
      idempotencyKey: request.idempotencyKey,
      completedSteps: [...request.completedSteps],
    },
    database: {
      isolation: "DedicatedDatabaseAndRole",
      databaseName: `zammad_${compact}`,
      roleName: `zammad_${compact}`,
      secretReference: tenantSecret(request.tenantId, "database"),
    },
    search: {
      isolation: "DedicatedNamespaceAndCredential",
      namespace: `wasalx_${compact}`,
      secretReference: tenantSecret(request.tenantId, "search"),
    },
    storage: {
      isolation: "DedicatedPrefixAndCredential",
      prefix: `tenants/${request.tenantId}/`,
      secretReference: tenantSecret(request.tenantId, "storage"),
    },
    secrets: {
      serviceSecretReference: tenantSecret(request.tenantId, "service"),
      privacySecretReference: tenantSecret(request.tenantId, "privacy"),
    },
    zammad: {
      instanceId: request.zammadInstanceId,
      version: request.spec.deployment.zammadVersion,
      image: release.images.zammad,
      configuratorImage: release.images.configurator,
      nginxImage: release.images.nginx,
      redisImage: release.images.redis,
      memcachedImage: release.images.memcached,
      hostname,
      packageVersion: release.packageVersion,
      packageSha256: release.packageSha256,
    },
    oidc: {
      issuer: config.oidcIssuer,
      clientId: `wasalx-${compact}`,
      secretReference: tenantSecret(request.tenantId, "oidc"),
      disablePasswordLogin: true,
    },
    defaults: {
      initialGroup: "Operations",
      backupPolicy: "daily-encrypted",
      retentionDays: request.spec.tenant.retentionDays,
    },
    desiredState: request.action === "SUSPEND" ? "Suspended" : "Active",
  };
  return {
    apiVersion: "platform.wasalx.io/v1alpha1",
    kind: "TenantWorkspace",
    metadata: {
      name: workspaceName(request.tenantId),
      namespace: config.workspaceNamespace,
      ...(resourceVersion ? { resourceVersion } : {}),
      labels: {
        "app.kubernetes.io/managed-by": "wasalx-tenant-provisioner",
        "app.kubernetes.io/part-of": "wasalx",
        "wasalx.io/tenant": request.tenantId,
        "wasalx.io/plane": "tenant",
      },
      annotations: {
        "wasalx.io/operation-id": request.operationId,
        "wasalx.io/idempotency-key": request.idempotencyKey,
      },
    },
    spec,
  };
}

function validateExisting(
  workspace: TenantWorkspace | null,
  request: TenantProvisioningRequest,
  desired: WorkspaceSpec,
) {
  if (!workspace) return;
  if (workspace.spec.tenantId !== request.tenantId) {
    throw new ProvisionerError(409, "WORKSPACE_TENANT_MISMATCH", "The tenant workspace belongs to another tenant.");
  }
  const existing = workspace.spec.request;
  if (!Number.isSafeInteger(existing?.fencingToken)) {
    throw new ProvisionerError(409, "WORKSPACE_FENCE_INVALID", "The tenant workspace fence is invalid.");
  }
  if (existing.fencingToken > request.fencingToken) {
    throw new ProvisionerError(409, "STALE_FENCING_TOKEN", "A newer tenant provisioning worker already owns this workspace.");
  }
  if (
    existing.fencingToken === request.fencingToken &&
    (existing.operationId !== request.operationId ||
      existing.action !== request.action ||
      existing.desiredStep !== (request.action === "PROVISION"
        ? request.step
        : request.action === "SUSPEND"
          ? "suspend"
          : request.resumePhase === "PREPARE"
            ? "resume_prepare"
            : "resume_publish") ||
      existing.resumePhase !== request.resumePhase ||
      existing.idempotencyKey !== request.idempotencyKey)
  ) {
    throw new ProvisionerError(409, "FENCING_CONTEXT_MISMATCH", "The tenant provisioning fence is already bound to another request.");
  }
  const existingImmutable: Partial<WorkspaceSpec> = { ...workspace.spec };
  const desiredImmutable: Partial<WorkspaceSpec> = { ...desired };
  delete existingImmutable.request;
  delete existingImmutable.desiredState;
  delete desiredImmutable.request;
  delete desiredImmutable.desiredState;
  if (!isDeepStrictEqual(existingImmutable, desiredImmutable)) {
    throw new ProvisionerError(409, "WORKSPACE_SPEC_IMMUTABLE", "Immutable tenant workspace settings do not match.");
  }
}

function readyOutputs(
  config: ProvisionerConfig,
  request: TenantProvisioningRequest,
  generation: number,
  workspace: TenantWorkspace | null,
  now: number,
) {
  const key = requestKey(request);
  if (!workspace || !key || !observed(config, request, generation, workspace)) return null;
  const condition = conditionFor(workspace, CONDITION_BY_STEP[key]);
  if (
    condition?.status !== "True" ||
    (condition.observedGeneration ?? generation) < generation
  ) {
    return null;
  }
  const outputs = workspace.status?.outputs?.[key];
  return validateOutputs(config, request, key, outputs, now);
}

function terminalCondition(
  request: TenantProvisioningRequest,
  generation: number,
  workspace: TenantWorkspace | null,
) {
  const key = requestKey(request);
  if (!workspace || !key) return null;
  const condition = conditionFor(workspace, CONDITION_BY_STEP[key]);
  if (
    condition?.status === "False" &&
    (condition.observedGeneration ?? generation) >= generation &&
    ["InvalidSpec", "PolicyDenied", "UnsupportedVersion", "TerminalFailure"].includes(condition.reason ?? "")
  ) {
    return "The tenant workspace reconciler rejected this provisioning step.";
  }
  return null;
}

function observed(
  config: ProvisionerConfig,
  request: TenantProvisioningRequest,
  generation: number,
  workspace: TenantWorkspace,
) {
  return (
    workspace.status?.reconciler === config.reconcilerIdentity &&
    workspace.status.observedGeneration !== undefined &&
    workspace.status.observedGeneration >= generation &&
    workspace.status.observedFencingToken === request.fencingToken &&
    workspace.status.lastAppliedIdempotencyKey === request.idempotencyKey
  );
}

function conditionFor(workspace: TenantWorkspace, type: string) {
  return workspace.status?.conditions?.find((condition: WorkspaceCondition) => condition.type === type);
}

function validateOutputs(
  config: ProvisionerConfig,
  request: TenantProvisioningRequest,
  step: ProvisioningStep | "suspend" | "resume_prepare" | "resume",
  value: unknown,
  now: number,
) {
  const output = exactOutput(value, OUTPUT_KEYS[step]);
  const compact = request.tenantId.replaceAll("-", "");
  const hostname = `${request.spec.tenant.slug}.${config.workspaceBaseDomain}`;
  const baseUrl = `https://${hostname}`;
  switch (step) {
    case "identity":
      bounded(output.identity_id);
      exact(output.oidc_client_id, `wasalx-${compact}`);
      tenantSecretValue(output.oidc_secret_reference, request.tenantId, "oidc");
      break;
    case "database":
      credentialFreePostgres(output.database_reference, `zammad_${compact}`);
      exact(output.database_role, `zammad_${compact}`);
      tenantSecretValue(output.database_secret_reference, request.tenantId, "database");
      break;
    case "search":
      exact(output.search_namespace, `wasalx_${compact}`);
      tenantSecretValue(output.search_secret_reference, request.tenantId, "search");
      break;
    case "storage":
      exact(output.storage_prefix, `tenants/${request.tenantId}/`);
      tenantSecretValue(output.storage_secret_reference, request.tenantId, "storage");
      break;
    case "secrets":
      tenantSecretValue(output.service_secret_reference, request.tenantId, "service");
      tenantSecretValue(output.privacy_secret_reference, request.tenantId, "privacy");
      break;
    case "zammad":
      exact(output.zammad_base_url, baseUrl);
      exact(output.deployment_name, `zammad-${compact}`);
      exact(output.runtime_image, request.spec.deployment.release.images.zammad);
      exact(output.package_version, request.spec.deployment.release.packageVersion);
      exact(output.package_sha256, request.spec.deployment.release.packageSha256);
      break;
    case "package":
      exact(output.package_version, request.spec.deployment.release.packageVersion);
      exact(output.package_sha256, request.spec.deployment.release.packageSha256);
      break;
    case "oidc":
      exact(output.oidc_issuer, config.oidcIssuer);
      exact(output.oidc_client_id, `wasalx-${compact}`);
      exact(output.password_login_disabled, true);
      break;
    case "defaults":
      bounded(output.zammad_group_id);
      exact(output.retention_days, request.spec.tenant.retentionDays);
      exact(output.backup_policy, "daily-encrypted");
      break;
    case "health":
      exact(output.healthy, true);
      exact(output.isolation_verified, true);
      exact(output.zammad_base_url, baseUrl);
      isoDate(output.checked_at);
      recentDate(output.checked_at, now);
      break;
    case "suspend":
      exact(output.suspended, true);
      exact(output.credentials_disabled, true);
      exact(output.workloads_scaled_to_zero, true);
      exact(output.ingress_disabled, true);
      isoDate(output.suspended_at);
      recentDate(output.suspended_at, now);
      break;
    case "resume_prepare":
      exact(output.prepared, true);
      exact(output.credentials_enabled, true);
      exact(output.workloads_ready, true);
      exact(output.healthy, true);
      exact(output.isolation_verified, true);
      exact(output.zammad_base_url, baseUrl);
      isoDate(output.provider_resumed_at);
      recentDate(output.provider_resumed_at, now);
      isoDate(output.checked_at);
      recentDate(output.checked_at, now);
      break;
    case "resume":
      exact(output.resumed, true);
      exact(output.ingress_enabled, true);
      exact(output.healthy, true);
      exact(output.isolation_verified, true);
      exact(output.zammad_base_url, baseUrl);
      isoDate(output.resumed_at);
      recentDate(output.resumed_at, now);
      isoDate(output.checked_at);
      recentDate(output.checked_at, now);
      break;
  }
  return output;
}

function recentDate(value: unknown, now: number) {
  const timestamp = Date.parse(bounded(value));
  if (timestamp < now - 300_000 || timestamp > now + 60_000) invalidOutput();
}

const OUTPUT_KEYS: Record<ProvisioningStep | "suspend" | "resume_prepare" | "resume", readonly string[]> = {
  identity: ["identity_id", "oidc_client_id", "oidc_secret_reference"],
  database: ["database_reference", "database_role", "database_secret_reference"],
  search: ["search_namespace", "search_secret_reference"],
  storage: ["storage_prefix", "storage_secret_reference"],
  secrets: ["service_secret_reference", "privacy_secret_reference"],
  zammad: ["zammad_base_url", "deployment_name", "runtime_image", "package_version", "package_sha256"],
  package: ["package_version", "package_sha256"],
  oidc: ["oidc_issuer", "oidc_client_id", "password_login_disabled"],
  defaults: ["zammad_group_id", "retention_days", "backup_policy"],
  health: ["healthy", "isolation_verified", "zammad_base_url", "checked_at"],
  suspend: ["suspended", "credentials_disabled", "workloads_scaled_to_zero", "ingress_disabled", "suspended_at"],
  resume_prepare: ["prepared", "credentials_enabled", "workloads_ready", "healthy", "isolation_verified", "zammad_base_url", "provider_resumed_at", "checked_at"],
  resume: ["resumed", "ingress_enabled", "healthy", "isolation_verified", "zammad_base_url", "resumed_at", "checked_at"],
};

function requestKey(request: TenantProvisioningRequest) {
  if (request.action === "SUSPEND") return "suspend" as const;
  if (request.action === "RESUME") {
    return request.resumePhase === "PREPARE" ? "resume_prepare" as const : "resume" as const;
  }
  return request.step;
}

function exactOutput(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidOutput();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) invalidOutput();
  if (Object.keys(record).some((key) => !keys.includes(key))) invalidOutput();
  return { ...record };
}

function credentialFreePostgres(value: unknown, databaseName: string) {
  const string = bounded(value);
  let url: URL;
  try {
    url = new URL(string);
  } catch {
    invalidOutput();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/${databaseName}`
  ) {
    invalidOutput();
  }
}

function tenantSecretValue(value: unknown, tenantId: string, leaf: string) {
  exact(value, tenantSecret(tenantId, leaf));
}

function tenantSecret(tenantId: string, leaf: string) {
  return `secret://tenants/${tenantId}/zammad/${leaf}`;
}

function exact(value: unknown, expected: unknown) {
  if (value !== expected) invalidOutput();
}

function bounded(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 || hasControl(value)) invalidOutput();
  return value;
}

function isoDate(value: unknown) {
  const string = bounded(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(string) || !Number.isFinite(Date.parse(string))) {
    invalidOutput();
  }
}

function positiveGeneration(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ProvisionerError(503, "WORKSPACE_GENERATION_INVALID", "The Kubernetes workspace generation is invalid.", true);
  }
  return Number(value);
}

function workspaceName(tenantId: string) {
  return `tenant-${tenantId}`;
}

function hasControl(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function invalidOutput(): never {
  throw new ProvisionerError(
    503,
    "RECONCILER_OUTPUT_INVALID",
    "The tenant workspace reconciler returned incomplete or unsafe evidence.",
    true,
  );
}
