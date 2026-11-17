import { jwtVerify, type JWTPayload } from "jose";
import { createHash } from "node:crypto";
import {
  ProvisionerError,
  provisioningSteps,
  type ProvisioningStep,
  type TenantProvisioningRequest,
  type TenantProvisioningSpec,
} from "./types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_REFERENCE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]*$/u;

export async function authenticateProvisioningRequest(
  headers: Headers,
  rawBody: string,
  signingSecret: Uint8Array,
  now = Math.floor(Date.now() / 1_000),
) {
  const contentType = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ProvisionerError(415, "CONTENT_TYPE_REQUIRED", "Content-Type must be application/json.");
  }
  if (Buffer.byteLength(rawBody, "utf8") > 131_072) {
    throw new ProvisionerError(413, "REQUEST_TOO_LARGE", "The provisioning request is too large.");
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new ProvisionerError(400, "REQUEST_INVALID", "The provisioning request is invalid.");
  }
  const request = parseRequest(body);
  const idempotencyHeader = headers.get("idempotency-key");
  if (idempotencyHeader !== request.idempotencyKey) {
    throw new ProvisionerError(409, "IDEMPOTENCY_MISMATCH", "The provisioning idempotency key does not match.");
  }

  const authorization = headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length > 8_192) {
    throw new ProvisionerError(401, "AUTHENTICATION_REQUIRED", "Provisioning service authentication is required.");
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), signingSecret, {
      algorithms: ["HS256"],
      issuer: "wasalx-control-plane",
      audience: "wasalx-provisioning-driver",
      currentDate: new Date(now * 1_000),
      clockTolerance: 5,
      maxTokenAge: "3 minutes",
      requiredClaims: ["sub", "jti", "iat", "exp", "request_sha256"],
    }));
  } catch {
    throw new ProvisionerError(401, "AUTHENTICATION_INVALID", "Provisioning service authentication is invalid.");
  }

  if (
    payload.sub !== "tenant-provisioning-worker" ||
    payload.scope !== "tenant:provision" ||
    payload.tenant_id !== request.tenantId ||
    payload.operation_id !== request.operationId ||
    payload.zammad_instance_id !== request.zammadInstanceId ||
    payload.action !== request.action ||
    payload.step !== request.step ||
    payload.resume_phase !== request.resumePhase ||
    payload.fencing_token !== request.fencingToken ||
    payload.idempotency_key !== request.idempotencyKey ||
    payload.request_sha256 !== createHash("sha256").update(rawBody).digest("hex") ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp - payload.iat > 120 ||
    !UUID_V4.test(String(payload.jti))
  ) {
    throw new ProvisionerError(401, "AUTHENTICATION_CONTEXT_MISMATCH", "Provisioning authentication context does not match the request.");
  }

  return request;
}

export function parseRequest(value: unknown): TenantProvisioningRequest {
  const record = exactRecord(value, [
    "version",
    "operationId",
    "zammadInstanceId",
    "tenantId",
    "action",
    "step",
    "resumePhase",
    "fencingToken",
    "idempotencyKey",
    "spec",
    "completedSteps",
    "priorResults",
  ]);
  if (record.version !== 1) invalid();
  const operationId = uuid(record.operationId);
  const zammadInstanceId = uuid(record.zammadInstanceId);
  const tenantId = uuid(record.tenantId);
  if (
    record.action !== "PROVISION" &&
    record.action !== "SUSPEND" &&
    record.action !== "RESUME"
  ) invalid();
  const action = record.action;
  const fencingToken = positiveInteger(record.fencingToken);
  const completedSteps = parseCompletedSteps(record.completedSteps);
  const spec = parseSpec(record.spec);
  const priorResults = safePriorResults(record.priorResults, completedSteps, action);
  const expectedStep = provisioningSteps[completedSteps.length];
  let step: ProvisioningStep | undefined;
  let resumePhase: "PREPARE" | "PUBLISH" | undefined;
  if (action === "PROVISION") {
    if (!isStep(record.step) || record.step !== expectedStep) {
      throw new ProvisionerError(409, "STEP_ORDER_INVALID", "The requested provisioning step is out of order.");
    }
    step = record.step;
  } else if (record.step !== undefined || completedSteps.length !== provisioningSteps.length) {
    throw new ProvisionerError(
      409,
      action === "SUSPEND" ? "SUSPENSION_STATE_INVALID" : "RESUMPTION_STATE_INVALID",
      action === "SUSPEND"
        ? "Only a completely provisioned workspace can be suspended."
        : "Only a completely provisioned workspace can be resumed.",
    );
  }
  if (action === "RESUME") {
    if (record.resumePhase !== "PREPARE" && record.resumePhase !== "PUBLISH") invalid();
    resumePhase = record.resumePhase;
  } else if (record.resumePhase !== undefined) invalid();
  const expectedIdempotency =
    action === "PROVISION"
      ? `provision:${tenantId}:${operationId}:${step}`
      : action === "RESUME"
        ? `resume:${tenantId}:${operationId}:${resumePhase!.toLowerCase()}`
        : `suspend:${tenantId}:${operationId}`;
  if (record.idempotencyKey !== expectedIdempotency) {
    throw new ProvisionerError(409, "IDEMPOTENCY_INVALID", "The provisioning idempotency key is invalid.");
  }
  return {
    version: 1,
    operationId,
    zammadInstanceId,
    tenantId,
    action,
    ...(step ? { step } : {}),
    ...(resumePhase ? { resumePhase } : {}),
    fencingToken,
    idempotencyKey: expectedIdempotency,
    spec,
    completedSteps,
    priorResults,
  };
}

function parseSpec(value: unknown): TenantProvisioningSpec {
  const record = exactRecord(value, ["tenant", "owner", "deployment"]);
  const tenant = exactRecord(record.tenant, ["name", "slug", "retentionDays"]);
  const owner = exactRecord(record.owner, ["oidcSubject", "email", "displayName"]);
  const deployment = exactRecord(record.deployment, ["region", "resourceProfile", "zammadVersion", "release"]);
  const release = exactRecord(deployment.release, ["packageVersion", "packageSha256", "images"]);
  const images = exactRecord(release.images, ["zammad", "configurator", "nginx", "redis", "memcached"]);
  const name = boundedText(tenant.name, 2, 120);
  const slug = stringValue(tenant.slug);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(slug)) invalid();
  const retentionDays = positiveInteger(tenant.retentionDays);
  if (retentionDays > 3_650) invalid();
  const oidcSubject = boundedText(owner.oidcSubject, 1, 255);
  const email = stringValue(owner.email).toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) invalid();
  const displayName = boundedText(owner.displayName, 1, 120);
  const region = stringValue(deployment.region);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(region)) invalid();
  if (!new Set(["small", "medium", "large"]).has(String(deployment.resourceProfile))) invalid();
  const zammadVersion = stringValue(deployment.zammadVersion);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(zammadVersion)) invalid();
  const packageVersion = stringValue(release.packageVersion);
  const packageSha256 = stringValue(release.packageSha256);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion) || !/^[0-9a-f]{64}$/u.test(packageSha256)) invalid();
  const releaseImages = Object.fromEntries((["zammad", "configurator", "nginx", "redis", "memcached"] as const).map((name) => {
    const value = stringValue(images[name]);
    if (!/^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/u.test(value)) invalid();
    return [name, value];
  })) as TenantProvisioningSpec["deployment"]["release"]["images"];
  return {
    tenant: { name, slug, retentionDays },
    owner: { oidcSubject, email, displayName },
    deployment: {
      region,
      resourceProfile: deployment.resourceProfile as "small" | "medium" | "large",
      zammadVersion,
      release: { packageVersion, packageSha256, images: releaseImages },
    },
  };
}

function parseCompletedSteps(value: unknown) {
  if (!Array.isArray(value) || value.length > provisioningSteps.length) invalid();
  return value.map((entry, index) => {
    if (!isStep(entry) || entry !== provisioningSteps[index]) {
      throw new ProvisionerError(409, "STEP_HISTORY_INVALID", "The provisioning completion history is invalid.");
    }
    return entry;
  });
}

function safePriorResults(
  value: unknown,
  completedSteps: ProvisioningStep[],
  action: TenantProvisioningRequest["action"],
) {
  const allowed = action === "PROVISION"
    ? completedSteps
    : [...completedSteps, "suspend", "resume_prepare", "resume"];
  const record = exactRecord(value, allowed);
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 32_768) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    result[key] = safeValue(entry, 0);
  }
  return result;
}

function safeValue(value: unknown, depth: number): unknown {
  if (depth > 6) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (value.length > 2_048 || hasControl(value)) invalid();
    if (value.includes("://") && !SAFE_REFERENCE.test(value)) invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) invalid();
    return value.map((entry) => safeValue(entry, depth + 1));
  }
  if (!value || typeof value !== "object") invalid();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/u.test(key)) invalid();
    const lower = key.toLowerCase();
    const lifecycleCredentialEvidence =
      lower === "credentials_disabled" || lower === "credentials_enabled";
    if (lifecycleCredentialEvidence && entry !== true) invalid();
    if (
      (/(password|token|api_?key|private_?key|credential|authorization|cookie|message_?body)/u.test(lower) &&
        !lifecycleCredentialEvidence) ||
      (lower.includes("secret") && !lower.endsWith("secret_reference"))
    ) {
      invalid();
    }
    result[key] = safeValue(entry, depth + 1);
  }
  return result;
}

function exactRecord(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) invalid();
  return record;
}

function isStep(value: unknown): value is ProvisioningStep {
  return typeof value === "string" && (provisioningSteps as readonly string[]).includes(value);
}

function uuid(value: unknown) {
  const string = stringValue(value).toLowerCase();
  if (!UUID_V4.test(string)) invalid();
  return string;
}

function positiveInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

function stringValue(value: unknown) {
  if (typeof value !== "string" || hasControl(value)) invalid();
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number) {
  const string = stringValue(value).trim();
  if (string.length < minimum || string.length > maximum) invalid();
  return string;
}

function hasControl(value: string) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function invalid(): never {
  throw new ProvisionerError(400, "REQUEST_INVALID", "The provisioning request is invalid.");
}
