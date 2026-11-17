import assert from "node:assert/strict";
import {
  boundedJsonRequest,
  explicitBoolean,
  isMain,
  liveBaseUrl,
  opaqueDigest,
  readBoundedJsonFile,
  required,
  writeEvidence,
} from "./live-common.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUIRED_STEPS = ["identity", "database", "search", "storage", "secrets", "zammad", "package", "oidc", "defaults", "health"];

export async function runProvisioningContract({ env = process.env, fetchImpl = fetch, spec } = {}) {
  const baseUrl = liveBaseUrl(
    required(env, "WASALX_CONTROL_API_URL"),
    "WASALX_CONTROL_API_URL",
    explicitBoolean(env, "WASALX_LIVE_ALLOW_INSECURE"),
  );
  const bearer = required(env, "WASALX_PLATFORM_OPERATOR_BEARER");
  assert.ok(bearer.length >= 32 && bearer.length <= 16_384, "Platform operator bearer has an invalid length");
  const provisioningSpec = spec ?? await readBoundedJsonFile(required(env, "WASALX_PROVISIONING_SPEC_FILE"));
  validateSpecEnvelope(provisioningSpec);
  const idempotencyKey = env.WASALX_PROVISIONING_IDEMPOTENCY_KEY ?? `live-provision:${crypto.randomUUID()}`;
  assert.ok(idempotencyKey.length <= 255 && !hasControlCharacters(idempotencyKey), "Provisioning idempotency key is invalid");
  const timeoutSeconds = boundedInteger(env.WASALX_PROVISIONING_TIMEOUT_SECONDS, 1_800, 30, 7_200);
  const request = (path, init = {}) =>
    boundedJsonRequest(fetchImpl, new URL(path, baseUrl), {
      ...init,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    }, { label: "WasalX control plane", timeoutMs: 30_000 });

  const create = () => request("/platform/v1/tenants", {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body: JSON.stringify(toCreateBody(provisioningSpec)),
  });
  const first = record(await create());
  const tenantId = uuid(first.tenant_id, "tenant_id");
  const operationId = uuid(first.operation_id, "operation_id");
  assert.equal(first.duplicate, false, "The initial provisioning request was unexpectedly a replay");
  const replay = record(await create());
  assert.equal(uuid(replay.tenant_id, "replay tenant_id"), tenantId, "Provisioning replay returned another tenant");
  assert.equal(uuid(replay.operation_id, "replay operation_id"), operationId, "Provisioning replay returned another operation");
  assert.equal(replay.duplicate, true, "Provisioning replay did not report duplicate=true");

  const deadline = Date.now() + timeoutSeconds * 1_000;
  let status;
  while (Date.now() < deadline) {
    status = record(await request(`/platform/v1/tenants/${encodeURIComponent(tenantId)}/provisioning`));
    assert.equal(uuid(status.operation_id, "status operation_id"), operationId, "Provisioning status changed operation identity");
    if (status.status === "COMPLETE") break;
    if (status.status === "FAILED") throw new Error(`Tenant provisioning failed with ${safeCode(status.error_code)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert.ok(status, "Tenant provisioning did not return status");
  assert.equal(status.status, "COMPLETE", `Tenant provisioning did not complete within ${timeoutSeconds} seconds`);
  assert.equal(status.tenant_state, "ACTIVE", "Completed provisioning did not activate the tenant");
  assert.deepEqual(status.completed_steps, REQUIRED_STEPS, "Provisioning did not complete every ordered step exactly once");
  assert.equal(status.current_step, null, "Completed provisioning retained a current step");
  assert.ok(Number(status.attempts) >= 1, "Provisioning attempts were not recorded");

  return {
    provider: "WASALX_CONTROL_PLANE",
    gate: "TENANT_PROVISION_TWICE",
    tenant_id: tenantId,
    operation_id: operationId,
    idempotency_key_sha256: opaqueDigest(idempotencyKey),
    initial_create: "passed",
    idempotent_replay: "passed",
    status: "COMPLETE",
    tenant_state: "ACTIVE",
    completed_steps: [...REQUIRED_STEPS],
    attempts: Number(status.attempts),
    completed_at: isoOrNull(status.completed_at),
    observed_at: new Date().toISOString(),
  };
}

function toCreateBody(value) {
  const source = record(value);
  if (source.tenant || source.owner || source.deployment) {
    const tenant = record(source.tenant);
    return {
      name: tenant.name,
      slug: tenant.slug,
      retentionDays: tenant.retentionDays,
      owner: source.owner,
      deployment: source.deployment,
    };
  }
  return source;
}

function validateSpecEnvelope(value) {
  const body = toCreateBody(value);
  assert.equal(typeof body.name, "string", "Provisioning spec requires a tenant name");
  assert.equal(typeof body.slug, "string", "Provisioning spec requires a tenant slug");
  assert.ok(body.owner && typeof body.owner === "object", "Provisioning spec requires an owner");
  assert.ok(body.deployment && typeof body.deployment === "object", "Provisioning spec requires deployment settings");
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum, `Value must be between ${minimum} and ${maximum}`);
  return parsed;
}

function uuid(value, label) {
  assert.ok(typeof value === "string" && UUID.test(value), `${label} is not a UUID`);
  return value;
}

function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  assert.ok(typeof value === "string" && Number.isFinite(Date.parse(value)), "Provisioning completion timestamp is invalid");
  return new Date(value).toISOString();
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z0-9_]{1,80}$/u.test(value) ? value : "PROVISIONING_FAILED";
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

if (isMain(import.meta.url)) {
  writeEvidence(await runProvisioningContract());
}
