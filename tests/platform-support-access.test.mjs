import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ConflictException,
  ServiceUnavailableException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import {
  PlatformSupportAccessController,
  TenantSupportAccessController,
} from "../services/control-api/dist/support-access.controller.js";
import { SupportAccessService } from "../services/control-api/dist/support-access.service.js";
import { can } from "../services/control-api/dist/rbac.js";

const migration = await readFile(
  new URL(
    "../services/control-api/migrations/0023_platform_support_access.sql",
    import.meta.url,
  ),
  "utf8",
);
const hardeningMigration = await readFile(
  new URL("../services/control-api/migrations/0129_authorization_privacy_boundaries.sql", import.meta.url),
  "utf8",
);
const tenantId = "10000000-0000-4000-8000-000000000001";
const supportId = "20000000-0000-4000-8000-000000000002";
const userId = "30000000-0000-4000-8000-000000000003";
const principal = {
  subject: "owner-subject",
  userId,
  tenantId,
  email: "owner@example.test",
  displayName: "Tenant Owner",
  role: "tenant_owner",
  authenticatedAt: Math.floor(Date.now() / 1000) - 30,
  authenticationMethods: ["pwd", "mfa"],
};
const operator = {
  subject: "operator-subject",
  email: "operator@example.test",
  displayName: "Platform Operator",
  authenticatedAt: 1_800_000_000,
};

test("support migration is tenant-authorized, short-lived, metadata-only, and role-separated", () => {
  assert.match(migration, /CREATE TABLE platform_support_access_requests \(/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /tenant_id=app\.current_tenant_id\(\)/);
  assert.match(migration, /requested_duration_seconds BETWEEN 300 AND 3600/);
  assert.match(migration, /request_expires_at<=requested_at\+interval '24 hours'/);
  assert.match(migration, /scope='OPERATIONAL_METADATA'/);
  assert.match(migration, /wasalx_support_executor NOLOGIN BYPASSRLS/);
  assert.match(migration, /wasalx_support_client NOLOGIN NOBYPASSRLS/);
  assert.match(migration, /wasalx_support_tenant_writer NOLOGIN NOBYPASSRLS/);
  assert.match(migration, /membership\.role='tenant_owner'/);
  assert.match(migration, /app\.tenant_decide_support_access/);
  assert.match(migration, /REVOKE INSERT,UPDATE,DELETE ON platform_support_access_requests FROM wasalx_app/);
  assert.match(migration, /GRANT SELECT ON platform_support_access_requests TO wasalx_app/);
  assert.doesNotMatch(migration, /GRANT SELECT,UPDATE ON platform_support_access_requests TO wasalx_app/);
  assert.match(migration, /REVOKE ALL ON FUNCTION app\.operator_support_overview[\s\S]*wasalx_app/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.operator_support_overview[\s\S]*TO wasalx_support_client/);
  assert.match(migration, /support_access\.metadata_inspected/);
  assert.match(migration, /recent_audit_metadata/);
  assert.doesNotMatch(
    migration,
    /SELECT[^;]*(?:message_body|message_text|payload|object_key|secret_reference)[^;]*FROM/is,
  );
  assert.doesNotMatch(migration, /delivery_outbox[\s\S]{0,300}message_body/i);
  assert.doesNotMatch(migration, /event_inbox[\s\S]{0,300}payload/i);
  assert.match(hardeningMigration, /FOR UPDATE/);
  assert.match(hardeningMigration, /support_access\.expired/);
  assert.match(hardeningMigration, /RETURN jsonb_build_object\('active',false\)/);
  assert.doesNotMatch(hardeningMigration, /error_detail|message_body|message_text|secret_reference/i);
});

test("support RBAC lets only owners approve and keeps agents outside support metadata", () => {
  assert.equal(can("tenant_owner", "support:approve"), true);
  assert.equal(can("tenant_owner", "support:read"), true);
  assert.equal(can("tenant_admin", "support:read"), true);
  assert.equal(can("tenant_admin", "support:approve"), false);
  assert.equal(can("auditor", "support:read"), true);
  assert.equal(can("supervisor", "support:read"), false);
  assert.equal(can("agent", "support:read"), false);
});

test("platform controller requires bounded reason, duration, UUID, and idempotency", async () => {
  const calls = [];
  const controller = new PlatformSupportAccessController({
    request: async (...arguments_) => {
      calls.push(arguments_);
      return { state: "PENDING" };
    },
  });
  const request = { id: "request-1", platformOperator: operator };
  const result = await controller.request(request, "support-request-1", {
    tenantId,
    reason: "Investigating repeated connection failures",
    durationSeconds: 900,
  });
  assert.equal(result.state, "PENDING");
  assert.deepEqual(calls[0].slice(0, 3), [
    tenantId,
    "Investigating repeated connection failures",
    900,
  ]);
  assert.throws(
    () => controller.request(request, "support-request-2", {
      tenantId,
      reason: "too short",
      durationSeconds: 900,
    }),
    /Support reason is invalid/,
  );
  assert.throws(
    () => controller.request(request, "support-request-3", {
      tenantId,
      reason: "Investigating repeated connection failures",
      durationSeconds: 3_601,
    }),
    /between 300 and 3600/,
  );
  assert.throws(
    () => controller.request(request, undefined, {
      tenantId,
      reason: "Investigating repeated connection failures",
      durationSeconds: 900,
    }),
    /Idempotency-Key/,
  );
});

test("operator service binds idempotency to operator, tenant, reason, and duration", async () => {
  const observed = [];
  const repository = {
    isConfigured: () => true,
    request: async (...arguments_) => {
      observed.push(arguments_);
      return { state: "PENDING" };
    },
  };
  const service = new SupportAccessService({}, repository);
  await service.request(
    tenantId,
    "Investigating repeated connection failures",
    900,
    { idempotencyKey: "request-key", operator, requestId: "request-1" },
  );
  const call = observed[0][3];
  assert.match(call.requestSha256, /^[0-9a-f]{64}$/);
  assert.equal(call.operator.subject, operator.subject);

  const secondRepository = {
    ...repository,
    request: async (...arguments_) => {
      observed.push(arguments_);
      return { state: "PENDING" };
    },
  };
  const second = new SupportAccessService({}, secondRepository);
  await second.request(
    tenantId,
    "Investigating repeated connection failures",
    600,
    { idempotencyKey: "request-key", operator, requestId: "request-2" },
  );
  assert.notEqual(observed[0][3].requestSha256, observed[1][3].requestSha256);
});

test("operator runtime fails closed when its separate database identity is absent", async () => {
  const service = new SupportAccessService({}, { isConfigured: () => false });
  await assert.rejects(
    () => service.request(tenantId, "Investigating connection health", 900, {
      idempotencyKey: "request-key",
      operator,
      requestId: "request-1",
    }),
    (error) =>
      error instanceof ServiceUnavailableException &&
      /least-privilege platform support database role/.test(error.message),
  );
});

test("tenant approval can only shorten access and writes immutable audit evidence", async () => {
  const queries = [];
  const database = {
    withTenant: async (selectedTenant, operation) => {
      assert.equal(selectedTenant, tenantId);
      return operation({
        async query(sql, values = []) {
          queries.push({ sql, values });
          if (sql.includes("FROM tenant_settings")) return { rows: [{ privileged_reauth_minutes: 15 }], rowCount: 1 };
          if (sql.includes("expire_tenant_support_access")) return { rows: [], rowCount: 0 };
          if (sql.includes("tenant_decide_support_access")) {
            if (Number(values[3]) > 900) {
              const error = new Error("duration exceeds request");
              error.code = "22023";
              throw error;
            }
            return {
              rows: [{
                id: supportId,
                state: "APPROVED",
                version: "5",
                requested_duration_seconds: "900",
                access_expires_at: new Date(Date.now() + 600_000).toISOString(),
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      });
    },
  };
  const service = new SupportAccessService(database, { isConfigured: () => false });
  const result = await service.approve(principal, supportId, 4, 600, "request-approve");
  assert.equal(result.state, "APPROVED");
  assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO audit_events")));
  const approval = queries.find(({ sql }) => sql.includes("tenant_decide_support_access"));
  assert.equal(approval.values[3], 600);

  await assert.rejects(
    () => service.approve(principal, supportId, 4, 901, "request-approve-2"),
    (error) => error instanceof ConflictException,
  );
});

test("tenant controller delegates decisions with optimistic versioning", async () => {
  const calls = [];
  const controller = new TenantSupportAccessController({
    approve: async (...arguments_) => {
      calls.push(["approve", ...arguments_]);
      return { state: "APPROVED" };
    },
    deny: async (...arguments_) => {
      calls.push(["deny", ...arguments_]);
      return { state: "DENIED" };
    },
    revoke: async (...arguments_) => {
      calls.push(["revoke", ...arguments_]);
      return { state: "REVOKED" };
    },
  });
  const request = { id: "tenant-request", principal };
  assert.equal((await controller.approve(request, supportId, {
    expectedVersion: 2,
    durationSeconds: 600,
  })).state, "APPROVED");
  assert.equal((await controller.deny(request, supportId, {
    expectedVersion: 2,
    reason: "Access is not required",
  })).state, "DENIED");
  assert.equal((await controller.revoke(request, supportId, {
    expectedVersion: 3,
    reason: "Investigation has concluded",
  })).state, "REVOKED");
  assert.deepEqual(calls.map(([action]) => action), ["approve", "deny", "revoke"]);
});
