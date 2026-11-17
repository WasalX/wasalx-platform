export const providerActions = ["identity", "database", "search", "storage", "verify", "suspend", "resume"] as const;
export type ProviderAction = (typeof providerActions)[number];
export const providerResourceTypes = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health", "suspend"] as const;
const providerDesiredSteps = [...providerResourceTypes, "resume_prepare", "resume_publish"] as const;

export type ProviderRequest = {
  version: 1;
  tenant_id: string;
  operation_id: string;
  action: ProviderAction;
  generation: number;
  fencing_token: number;
  idempotency_key: string;
  desired: {
    tenant_id: string;
    slug: string;
    region: string;
    owner: Record<string, unknown>;
    database: Record<string, unknown>;
    search: Record<string, unknown>;
    storage: Record<string, unknown>;
    service_secret_reference: string;
    privacy_secret_reference: string;
    zammad: Record<string, unknown>;
    oidc: Record<string, unknown>;
    retention_days: number;
    desired_state: string;
    desired_step: string;
  };
};

export type ProviderResponse = {
  status: "READY";
  tenant_id: string;
  action: ProviderAction;
  fencing_token: number;
  idempotency_key: string;
  evidence: Record<string, string | number | boolean>;
};

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly safeMessage: string,
    readonly retryable = false,
  ) {
    super(safeMessage);
    this.name = "ProviderError";
  }
}

export function parseProviderRequest(value: unknown, routeTenant: string, routeAction: string): ProviderRequest {
  const body = record(value, "REQUEST_INVALID");
  exactKeys(body, ["version", "tenant_id", "operation_id", "action", "generation", "fencing_token", "idempotency_key", "desired"]);
  if (body.version !== 1 || !providerActions.includes(body.action as ProviderAction)) invalid();
  const tenantId = uuid(body.tenant_id);
  if (tenantId !== routeTenant || body.action !== routeAction) invalid();
  const operationId = uuid(body.operation_id);
  const generation = positiveInteger(body.generation);
  const fencingToken = positiveInteger(body.fencing_token);
  const idempotencyKey = token(body.idempotency_key, 1, 255);
  const desired = record(body.desired, "REQUEST_INVALID");
  exactKeys(desired, ["tenant_id", "slug", "region", "owner", "database", "search", "storage", "service_secret_reference", "privacy_secret_reference", "zammad", "oidc", "retention_days", "desired_state", "desired_step"]);
  if (desired.tenant_id !== tenantId) invalid();
  token(desired.slug, 1, 63);
  token(desired.region, 1, 63);
  const owner = record(desired.owner, "REQUEST_INVALID");
  const database = record(desired.database, "REQUEST_INVALID");
  const search = record(desired.search, "REQUEST_INVALID");
  const storage = record(desired.storage, "REQUEST_INVALID");
  const zammad = record(desired.zammad, "REQUEST_INVALID");
  const oidc = record(desired.oidc, "REQUEST_INVALID");
  exactKeys(owner, ["oidcSubject", "email", "displayName"]);
  exactKeys(database, ["isolation", "databaseName", "roleName", "secretReference"]);
  exactKeys(search, ["isolation", "namespace", "secretReference"]);
  exactKeys(storage, ["isolation", "prefix", "secretReference"]);
  exactKeys(zammad, ["instanceId", "version", "hostname", "packageVersion", "packageSha256"]);
  exactKeys(oidc, ["issuer", "clientId", "secretReference", "disablePasswordLogin"]);
  const instanceId = uuid(zammad.instanceId);
  if (!/^secret:\/\/tenants\/[0-9a-f-]{36}\/zammad\/(?:service|privacy)$/u.test(String(desired.service_secret_reference)) ||
      !/^secret:\/\/tenants\/[0-9a-f-]{36}\/zammad\/(?:service|privacy)$/u.test(String(desired.privacy_secret_reference))) invalid();
  if (desired.service_secret_reference !== `secret://tenants/${tenantId}/zammad/service` ||
      desired.privacy_secret_reference !== `secret://tenants/${tenantId}/zammad/privacy`) invalid();
  if (typeof desired.retention_days !== "number" || !Number.isSafeInteger(desired.retention_days) || desired.retention_days < 1 || desired.retention_days > 3650) invalid();
  token(desired.desired_step, 1, 32);
  if (!providerDesiredSteps.includes(desired.desired_step as typeof providerDesiredSteps[number])) invalid();
  token(desired.desired_state, 1, 32);
  if (body.action !== "verify" && body.action !== "suspend" && body.action !== "resume" && desired.desired_step !== body.action) invalid();
  if (body.action === "suspend" && desired.desired_state !== "Suspended") invalid();
  if (body.action === "resume" && (desired.desired_state !== "Active" || desired.desired_step !== "resume_prepare")) invalid();
  token(owner.oidcSubject, 1, 255); token(owner.email, 3, 320); token(owner.displayName, 1, 120);
  if (database.isolation !== "DedicatedDatabaseAndRole") invalid();
  token(database.databaseName, 1, 63); token(database.roleName, 1, 63); secretReference(database.secretReference, tenantId, "database");
  if (search.isolation !== "DedicatedNamespaceAndCredential") invalid();
  token(search.namespace, 1, 255); secretReference(search.secretReference, tenantId, "search");
  if (storage.isolation !== "DedicatedPrefixAndCredential") invalid();
  token(storage.prefix, 1, 512); secretReference(storage.secretReference, tenantId, "storage");
  token(zammad.version, 1, 64); token(zammad.hostname, 3, 253); token(zammad.packageVersion, 1, 64);
  if (typeof zammad.packageSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(zammad.packageSha256)) invalid();
  token(oidc.issuer, 8, 2_048); token(oidc.clientId, 1, 255); secretReference(oidc.secretReference, tenantId, "oidc");
  if (oidc.disablePasswordLogin !== true) invalid();
  return {
    version: 1,
    tenant_id: tenantId,
    operation_id: operationId,
    action: body.action as ProviderAction,
    generation,
    fencing_token: fencingToken,
    idempotency_key: idempotencyKey,
    desired: {
      tenant_id: tenantId,
      slug: String(desired.slug),
      region: String(desired.region),
      owner,
      database,
      search,
      storage,
      service_secret_reference: String(desired.service_secret_reference),
      privacy_secret_reference: String(desired.privacy_secret_reference),
      zammad: { ...zammad, instanceId },
      oidc,
      retention_days: Number(desired.retention_days),
      desired_state: String(desired.desired_state),
      desired_step: String(desired.desired_step),
    },
  };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError(400, code, "The provider request is invalid.");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
}

function token(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || /[\p{Cc}\p{Cf}]/u.test(value)) invalid();
  return value;
}

function uuid(value: unknown) {
  const result = token(value, 36, 36).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) invalid();
  return result;
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}

function secretReference(value: unknown, tenantId: string, kind: string) {
  if (value !== `secret://tenants/${tenantId}/zammad/${kind}`) invalid();
}

function invalid(): never {
  throw new ProviderError(400, "REQUEST_INVALID", "The provider request is invalid.");
}
