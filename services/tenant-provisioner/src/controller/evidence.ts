import type { ProvisioningStep, TenantWorkspace } from "../types.js";

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

export class EvidenceContractError extends Error {
  constructor(readonly code = "EVIDENCE_INVALID") {
    super("The reconciler dependency returned incomplete or unsafe evidence.");
    this.name = "EvidenceContractError";
  }
}

export function validateEvidence(
  workspace: TenantWorkspace,
  step: ProvisioningStep | "suspend" | "resume_prepare" | "resume",
  value: unknown,
  requireFresh = false,
  now = Date.now(),
) {
  const output = exactRecord(value, OUTPUT_KEYS[step]);
  const compact = workspace.spec.tenantId.replaceAll("-", "");
  const baseUrl = `https://${workspace.spec.zammad.hostname}`;
  switch (step) {
    case "identity":
      boundedString(output.identity_id);
      exact(output.oidc_client_id, workspace.spec.oidc.clientId);
      exact(output.oidc_secret_reference, workspace.spec.oidc.secretReference);
      break;
    case "database":
      credentialFreePostgres(output.database_reference, workspace.spec.database.databaseName);
      exact(output.database_role, workspace.spec.database.roleName);
      exact(output.database_secret_reference, workspace.spec.database.secretReference);
      break;
    case "search":
      exact(output.search_namespace, workspace.spec.search.namespace);
      exact(output.search_secret_reference, workspace.spec.search.secretReference);
      break;
    case "storage":
      exact(output.storage_prefix, workspace.spec.storage.prefix);
      exact(output.storage_secret_reference, workspace.spec.storage.secretReference);
      break;
    case "secrets":
      exact(output.service_secret_reference, workspace.spec.secrets.serviceSecretReference);
      exact(output.privacy_secret_reference, workspace.spec.secrets.privacySecretReference);
      break;
    case "zammad":
      exact(output.zammad_base_url, baseUrl);
      exact(output.deployment_name, `zammad-${compact}`);
      exact(output.runtime_image, workspace.spec.zammad.image);
      exact(output.package_version, workspace.spec.zammad.packageVersion);
      exact(output.package_sha256, workspace.spec.zammad.packageSha256);
      break;
    case "package":
      exact(output.package_version, workspace.spec.zammad.packageVersion);
      exact(output.package_sha256, workspace.spec.zammad.packageSha256);
      break;
    case "oidc":
      exact(output.oidc_issuer, workspace.spec.oidc.issuer);
      exact(output.oidc_client_id, workspace.spec.oidc.clientId);
      exact(output.password_login_disabled, true);
      break;
    case "defaults":
      boundedString(output.zammad_group_id);
      exact(output.retention_days, workspace.spec.retentionDays);
      exact(output.backup_policy, workspace.spec.defaults.backupPolicy);
      break;
    case "health":
      exact(output.healthy, true);
      exact(output.isolation_verified, true);
      exact(output.zammad_base_url, baseUrl);
      isoDate(output.checked_at);
      if (requireFresh) recentDate(output.checked_at, now);
      break;
    case "suspend":
      exact(output.suspended, true);
      exact(output.credentials_disabled, true);
      exact(output.workloads_scaled_to_zero, true);
      exact(output.ingress_disabled, true);
      isoDate(output.suspended_at);
      if (requireFresh) recentDate(output.suspended_at, now);
      break;
    case "resume":
      exact(output.resumed, true);
      exact(output.ingress_enabled, true);
      exact(output.healthy, true);
      exact(output.isolation_verified, true);
      exact(output.zammad_base_url, baseUrl);
      isoDate(output.resumed_at);
      isoDate(output.checked_at);
      if (requireFresh) {
        recentDate(output.resumed_at, now);
        recentDate(output.checked_at, now);
      }
      break;
    case "resume_prepare":
      exact(output.prepared, true);
      exact(output.credentials_enabled, true);
      exact(output.workloads_ready, true);
      exact(output.healthy, true);
      exact(output.isolation_verified, true);
      exact(output.zammad_base_url, `https://${workspace.spec.zammad.hostname}`);
      isoDate(output.provider_resumed_at);
      isoDate(output.checked_at);
      if (requireFresh) {
        recentDate(output.provider_resumed_at, now);
        recentDate(output.checked_at, now);
      }
      break;
  }
  return output;
}

function recentDate(value: unknown, now: number) {
  const timestamp = Date.parse(boundedString(value));
  if (timestamp < now - 300_000 || timestamp > now + 60_000) fail();
}

function exactRecord(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail();
  return { ...record };
}

function credentialFreePostgres(value: unknown, databaseName: string) {
  const string = boundedString(value);
  let url: URL;
  try { url = new URL(string); } catch { fail(); }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/${databaseName}`
  ) fail();
}

function exact(value: unknown, expected: unknown) {
  if (value !== expected) fail();
}

function boundedString(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) fail();
  return value;
}

function isoDate(value: unknown) {
  const string = boundedString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(string) || !Number.isFinite(Date.parse(string))) fail();
}

function fail(): never {
  throw new EvidenceContractError();
}
