import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  SecretCleanupProcessor,
  classifyCleanupFailure,
} from "../services/control-api/dist/secret-cleanup.service.js";
import {
  SecretProvisioningService,
  SecretSidecarWriteError,
} from "../services/control-api/dist/secret-provisioning.service.js";

const migrationUrl = new URL(
  "../services/control-api/migrations/0010_secret_cleanup_outbox.sql",
  import.meta.url,
);
const routingRetirementMigrationUrl = new URL(
  "../services/control-api/migrations/0106_routing_integration_secret_retirement.sql",
  import.meta.url,
);
const provisioningStagesMigrationUrl = new URL(
  "../services/control-api/migrations/0111_secret_provisioning_stages.sql",
  import.meta.url,
);
const referenceOwnershipMigrationUrl = new URL(
  "../services/control-api/migrations/0112_secret_cleanup_reference_ownership.sql",
  import.meta.url,
);

function task(overrides = {}) {
  const tenantId = "10000000-0000-4000-8000-000000000001";
  return {
    id: "71000000-0000-4000-8000-000000000001",
    tenantId,
    secretReference: `secret://${tenantId}/connections/40000000-0000-4000-8000-000000000001/webhook`,
    attempts: 1,
    maxAttempts: 12,
    fencingToken: 3,
    ...overrides,
  };
}

function repositoryFor(tasks, overrides = {}) {
  const calls = { claim: [], complete: [], fail: [] };
  return {
    calls,
    async claim(leaseId, limit) {
      calls.claim.push({ leaseId, limit });
      return tasks;
    },
    async complete(cleanup, leaseId) {
      calls.complete.push({ cleanup, leaseId });
      return overrides.complete ?? true;
    },
    async fail(cleanup, leaseId, failure) {
      calls.fail.push({ cleanup, leaseId, failure });
      return overrides.fail ?? true;
    },
  };
}

test("cleanup outbox is tenant isolated, replay safe, fenced, and survives tenant deletion ordering", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE secret_cleanup_outbox/);
  assert.match(sql, /REFERENCES tenants\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /UNIQUE \(tenant_id, secret_reference, cleanup_kind\)/);
  assert.match(sql, /ALTER TABLE secret_cleanup_outbox ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE secret_cleanup_outbox FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /tenant_id = app\.current_tenant_id\(\)/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /lease_expires_at < now\(\)/);
  assert.match(sql, /fencing_token = cleanup\.fencing_token \+ 1/);
  assert.match(sql, /fencing_token = expected_fencing_token/);
  assert.match(sql, /MAX_ATTEMPTS_EXHAUSTED/);
});

test("only the dedicated cleanup client can execute cross-tenant security-definer claims", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /wasalx_secret_cleanup_executor NOLOGIN BYPASSRLS/);
  assert.match(sql, /wasalx_secret_cleanup_client NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public, app/);
  assert.match(sql, /SET row_security = off/);
  assert.match(sql, /REVOKE ALL ON public\.secret_cleanup_outbox FROM wasalx_app/);
  assert.match(sql, /GRANT INSERT ON public\.secret_cleanup_outbox TO wasalx_app/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.claim_secret_cleanup_tasks\(uuid, integer\) FROM wasalx_app/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app\.claim_secret_cleanup_tasks\(uuid, integer\) TO wasalx_secret_cleanup_client/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app\.claim_secret_cleanup_tasks[^;]+TO wasalx_app/);
});

test("revoked routing credentials are durably queued but claimed only after live references retire",async()=>{
  const sql=await readFile(routingRetirementMigrationUrl,"utf8");
  assert.match(sql,/ROUTING_INTEGRATION_SECRET/u);
  assert.match(sql,/AFTER UPDATE OF state ON client_routing_integrations/u);
  assert.match(sql,/ON CONFLICT DO NOTHING/u);
  assert.match(sql,/client_routing_source_state[\s\S]*source\.state<>'RETIRED'/u);
  assert.match(sql,/bot_action_definitions[\s\S]*action\.state='ACTIVE'/u);
  assert.match(sql,/bot_action_jobs[\s\S]*job\.state='RUNNING'/u);
  assert.match(sql,/group_action_executions[\s\S]*execution\.state='RUNNING'/u);
  assert.match(sql,/client_routing_sync_jobs[\s\S]*job\.state='RUNNING'/u);
  assert.match(sql,/GRANT SELECT \(tenant_id,id,secret_reference,state\)[\s\S]*TO wasalx_secret_cleanup_executor/u);
  assert.doesNotMatch(sql,/GRANT SELECT ON (?:client_routing_source_state|bot_action_definitions|bot_action_jobs|group_action_executions|client_routing_sync_jobs)/u);
  assert.match(sql,/FOR UPDATE SKIP LOCKED/u);
});

test("latest secret staging retains every cleanup kind and gates live tenant references",async()=>{
  const sql=await readFile(provisioningStagesMigrationUrl,"utf8");
  for(const kind of ["WEBHOOK_SECRET","CONNECTION_CREDENTIAL","ROUTING_INTEGRATION_SECRET","BOT_ACTION_CREDENTIAL_STAGE"]){
    assert.match(sql,new RegExp(`cleanup_kind IN \\([\\s\\S]*${kind}`));
  }
  assert.match(sql,/state IN \([\s\S]*'STAGED'[\s\S]*'FAILED_TERMINAL'/u);
  assert.match(sql,/operation_type IN \([\s\S]*'ROTATE_META_CREDENTIAL'/u);
  assert.match(sql,/PERFORM app\.expire_secret_provisioning_stages\(\)/u);
  assert.match(sql,/operation\.state<>'STAGED'/u);
  assert.match(sql,/route\.hmac_secret_reference=candidate\.secret_reference[\s\S]*route\.state<>'REVOKED'/u);
  assert.match(sql,/connection\.secret_reference=candidate\.secret_reference[\s\S]*connection\.state<>'REVOKED'/u);
  assert.match(sql,/integration\.state='REVOKED'/u);
  assert.match(sql,/AFTER INSERT ON client_routing_integrations/u);
  assert.match(sql,/UNIQUE \(tenant_id,connection_operation_id,cleanup_kind,secret_reference\)/u);
});

test("additive ownership migration rejects forged cleanup references and historical poisoned claims",async()=>{
  const sql=await readFile(referenceOwnershipMigrationUrl,"utf8");
  assert.match(sql,/CREATE TRIGGER secret_cleanup_reference_guard/u);
  assert.match(sql,/app\.secret_cleanup_reference_is_owned\([\s\S]*candidate\.secret_reference/u);
  assert.match(sql,/owner_operation\.payload->>'credentialReference'=secret_reference_value/u);
  assert.match(sql,/owner_operation\.payload->>'oldSecretReference'/u);
  assert.match(sql,/owner_operation\.payload->>'newSecretReference'/u);
  assert.match(sql,/integration\.secret_reference=secret_reference_value/u);
  assert.match(sql,/stage\.secret_reference=secret_reference_value/u);
});

test("disconnect finalization enqueues cleanup before committing the lifecycle operation", async () => {
  const source = await readFile(
    new URL("../services/connector-worker/src/connection-operation-repository.ts", import.meta.url),
    "utf8",
  );
  const cleanupInsert = source.indexOf("INSERT INTO secret_cleanup_outbox");
  const operationCompletion = source.lastIndexOf("app.complete_connection_operation");
  assert.ok(cleanupInsert > 0);
  assert.ok(operationCompletion > cleanupInsert);
  assert.match(source, /job\.operationType === "DISCONNECT"/);
  assert.match(source, /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(source, /deleteSecret|SECRET_SIDECAR_WRITE_TOKEN/);
});

test("processor deletes idempotently and completes with the claimed fence", async () => {
  const cleanup = task();
  const repository = repositoryFor([cleanup]);
  const references = [];
  const result = await new SecretCleanupProcessor(repository, {
    async deleteSecret(reference) {
      references.push(reference);
    },
  }).drain();
  assert.deepEqual(result, {
    claimed: 1,
    succeeded: 1,
    failedRetryable: 0,
    failedTerminal: 0,
    leaseLost: 0,
  });
  assert.deepEqual(references, [cleanup.secretReference]);
  assert.equal(repository.calls.complete.length, 1);
  assert.equal(repository.calls.complete[0].cleanup.fencingToken, 3);
  assert.equal(JSON.stringify(result).includes(cleanup.secretReference), false);
});

test("processor rejects a foreign or platform reference before sidecar deletion", async () => {
  for (const secretReference of [
    "secret://platform/waha/admin",
    "secret://20000000-0000-4000-8000-000000000002/connections/40000000-0000-4000-8000-000000000001/webhook",
  ]) {
    const repository = repositoryFor([task({ secretReference })]);
    let deletes = 0;
    const result = await new SecretCleanupProcessor(repository, {
      async deleteSecret() { deletes += 1; },
    }).drain();
    assert.equal(deletes, 0);
    assert.equal(result.failedTerminal, 1);
    assert.deepEqual(repository.calls.fail[0].failure, {
      retryable: false,
      code: "SECRET_REFERENCE_INVALID",
      safeError: "Secret cleanup ownership validation failed.",
    });
  }
});

test("temporary sidecar failures persist an exponential retry without leaking details", async () => {
  const cleanup = task();
  const repository = repositoryFor([cleanup]);
  const before = Date.now();
  const result = await new SecretCleanupProcessor(repository, {
    async deleteSecret() {
      throw new SecretSidecarWriteError(
        "SECRET_SIDECAR_TEMPORARY_FAILURE",
        "The secret manager is temporarily unavailable.",
        true,
      );
    },
  }).drain();
  assert.equal(result.failedRetryable, 1);
  assert.equal(repository.calls.fail.length, 1);
  const failure = repository.calls.fail[0].failure;
  assert.equal(failure.retryable, true);
  assert.equal(failure.code, "SECRET_SIDECAR_TEMPORARY_FAILURE");
  assert.ok(Date.parse(failure.retryAt) > before);
  assert.equal(JSON.stringify(failure).includes(cleanup.secretReference), false);
});

test("rejected and exhausted cleanup failures become visible terminal states", async () => {
  for (const [cleanup, error, expectedCode] of [
    [
      task(),
      new SecretSidecarWriteError(
        "SECRET_SIDECAR_REQUEST_REJECTED",
        "The secret manager rejected the cleanup request.",
        false,
      ),
      "SECRET_SIDECAR_REQUEST_REJECTED",
    ],
    [
      task({ attempts: 12, maxAttempts: 12 }),
      new SecretSidecarWriteError(
        "SECRET_SIDECAR_TEMPORARY_FAILURE",
        "The secret manager is temporarily unavailable.",
        true,
      ),
      "SECRET_SIDECAR_TEMPORARY_FAILURE_EXHAUSTED",
    ],
  ]) {
    const repository = repositoryFor([cleanup]);
    const result = await new SecretCleanupProcessor(repository, {
      async deleteSecret() {
        throw error;
      },
    }).drain();
    assert.equal(result.failedTerminal, 1);
    assert.equal(repository.calls.fail[0].failure.retryable, false);
    assert.equal(repository.calls.fail[0].failure.code, expectedCode);
  }
});

test("stale completion fences are reported without retrying the already deleted secret in-process", async () => {
  const repository = repositoryFor([task()], { complete: false });
  const result = await new SecretCleanupProcessor(repository, {
    async deleteSecret() {},
  }).drain();
  assert.equal(result.leaseLost, 1);
  assert.equal(repository.calls.fail.length, 0);
});

test("production requires a distinct write-scoped sidecar credential", () => {
  const previous = snapshot([
    "NODE_ENV",
    "SECRET_SIDECAR_URL",
    "SECRET_SIDECAR_TOKEN",
    "SECRET_SIDECAR_WRITE_TOKEN",
  ]);
  process.env.NODE_ENV = "production";
  process.env.SECRET_SIDECAR_URL = "https://secrets.example.invalid";
  process.env.SECRET_SIDECAR_TOKEN = "read-only-token";
  delete process.env.SECRET_SIDECAR_WRITE_TOKEN;
  try {
    assert.throws(() => new SecretProvisioningService(), /SECRET_SIDECAR_WRITE_TOKEN is required/);
    process.env.SECRET_SIDECAR_WRITE_TOKEN = "read-only-token";
    assert.throws(() => new SecretProvisioningService(), /must be distinct/);
    process.env.SECRET_SIDECAR_WRITE_TOKEN = "write-only-token";
    const service = new SecretProvisioningService();
    service.onModuleDestroy();
  } finally {
    restore(previous);
  }
});

test("unknown cleanup errors are retryable and redact the original error", () => {
  const classified = classifyCleanupFailure(new Error("secret://must-not-appear apiKey=private"));
  assert.deepEqual(classified, {
    retryable: true,
    code: "SECRET_CLEANUP_UNEXPECTED_FAILURE",
    safeError: "Secret cleanup failed temporarily.",
  });
});

function snapshot(names) {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function restore(values) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
