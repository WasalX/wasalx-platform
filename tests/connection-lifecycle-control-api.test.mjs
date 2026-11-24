import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import { verifyMetaCredentialMetadata } from "../packages/core/dist/meta-account-relation.js";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import { ConnectionsController } from "../services/control-api/dist/connections.controller.js";
import { MetaGraphClientError } from "../services/control-api/dist/meta-groups.client.js";
import { SecretProvisioningService } from "../services/control-api/dist/secret-provisioning.service.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";
const request = {
  id: "request-lifecycle-1",
  principal: {
    subject: "operator-1",
    userId,
    tenantId,
    email: "operator@example.test",
    displayName: "Operator",
    role: "tenant_admin",
  },
};


test("connections continue past 200 with a tenant-scoped cursor and stable ties", async () => {
  const records = Array.from({ length: 202 }, (_, index) => ({
    id: `40000000-0000-4000-8000-${String(202 - index).padStart(12, "0")}`,
  }));
  let queries = 0;
  const controller = new ConnectionsController({ rows: async (tenant, sql, [, , cursor, fetchSize]) => {
    queries += 1;
    assert.equal(tenant, tenantId);
    assert.match(sql, /WHERE .*tenant_id=\$1/u);
    assert.match(sql, /ORDER BY c\.created_at DESC,c\.id DESC/u);
    assert.match(sql, /LIMIT \$4/u);
    const offset = cursor ? records.findIndex(row => row.id === cursor) + 1 : 0;
    return records.slice(offset, offset + fetchSize);
  } });
  assert.equal(Reflect.getMetadata("wasalx:permission", controller.list), "connection:read");
  const headers = new Map();
  const reply = { header: (name, value) => headers.set(name, value) };
  const first = await controller.list(request, {}, reply);
  assert.deepEqual(first, records.slice(0, 200));
  const cursor = headers.get("x-next-cursor");
  assert.equal(cursor, records[199].id);
  headers.clear();
  assert.deepEqual(await controller.list(request, { cursor }, reply), records.slice(200));
  assert.equal(headers.has("x-next-cursor"), false);
  for (const query of [{ cursor: "bad" }, { cursor: [cursor] }, { limit: "201" }, { limit: ["2"] }, { limit: "0" }]) {
    await assert.rejects(() => controller.list(request, query, reply), BadRequestException);
  }
  assert.equal(queries, 2);
  assert.deepEqual(await controller.list(request), records.slice(0, 200));
});

const metaAppId = "12025550130";
const metaAppSecret = "synthetic-configured-meta-app-secret";
const metaAppReference = "secret://platform/meta-webhook";
const metaEnvironment = Object.fromEntries(["META_APP_ID", "META_APP_SECRET_REFERENCE", "META_GRAPH_VERSION"]
  .map(key => [key, process.env[key]]));
before(() => {
  process.env.META_APP_ID = metaAppId;
  process.env.META_APP_SECRET_REFERENCE = metaAppReference;
  process.env.META_GRAPH_VERSION = "v24.0";
});
after(() => { for (const [key, value] of Object.entries(metaEnvironment)) restore(key, value); });

function sampleCredentialMetadata(appId = metaAppId, appSecret = metaAppSecret) {
  assert.equal(appId, metaAppId);
  assert.equal(appSecret, metaAppSecret);
  return verifyMetaCredentialMetadata({ data: { is_valid: true, app_id: appId,
    scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], expires_at: 0 } }, { appId });
}

// Existing fixture callsites retain their SQL/failure boundaries; only configured dependencies are supplied.
function controllerFixture(database, secrets, drains, metaGroups, webhookSecrets = {
  resolveHmac: async (reference, policy) => {
    assert.equal(reference, metaAppReference);
    assert.deepEqual(policy, { kind: "exact", expectedReference: metaAppReference });
    return metaAppSecret;
  },
}, metaCredentials = { resolveAccessToken: async () => assert.fail("this fixture must not resolve an activation token") }) {
  const guardedDatabase={...database,...(database.withTenant?{withTenant:async(tenant,callback)=>database.withTenant(tenant,client=>callback({
    ...client,query:async(sql,values=[])=>{
      if(sql.includes("app.meta_add_access_activation_held")){
        assert.equal(values[0],tenantId); assert.equal(typeof values[1],"string");
        return{rows:[{held:false}],rowCount:1};
      }
      if(sql.includes("app.meta_lifecycle_guard")){
        assert.equal(values[4],metaAppId);assert.equal(values[5],0,"existing fixture is genuinely lifecycle-absent");
        return{rows:[{revision_matches:true,blocked:false,unresolved_hold:false}],rowCount:1};
      }
      return client.query(sql,values);
    },
  }))}:{})};
  return new ConnectionsController(guardedDatabase, secrets, drains, metaGroups, webhookSecrets, metaCredentials);
}

function ordinaryRotationRows(connectionId, idempotencyKey, currentOperation) {
  return async (tenant, sql, values) => {
    assert.equal(tenant, tenantId);
    if (sql === "SELECT id FROM meta_coexistence_contexts WHERE tenant_id=$1 AND connection_id=$2") {
      assert.deepEqual(values, [tenantId, connectionId]);
      return [];
    }
    assert.match(sql, /SELECT o\.\*,c\.name AS connection_name[\s\S]*FROM connection_operations o/u);
    assert.deepEqual(values, [tenantId, idempotencyKey]);
    const current = currentOperation();
    return current ? [current] : [];
  };
}

const metaSessionId = "52000000-0000-4000-8000-000000000001";

test("saved ADD_ACCESS denies direct activation and group synchronization before credential or provider work", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000001";
  for (const action of ["start", "restart", "syncGroups"]) {
    const database = { withTenant: async (tenant, run) => {
      assert.equal(tenant, tenantId);
      return run({ query: async (sql, values) => {
        if (sql.includes("SELECT o.*")) return { rows: [] };
        if (sql.startsWith("SELECT provider,state") || sql.startsWith("SELECT id,name,provider,state")) return { rows: [{ id: connectionId, provider: "META", state: "PAUSED" }] };
        if (sql.includes("app.meta_add_access_activation_held")) { assert.deepEqual(values, [tenantId, connectionId]); return { rows: [{ held: true }], rowCount: 1 }; }
        assert.fail(`Unexpected query before saved-access denial: ${sql}`);
      } });
    } };
    const noEffect = new Proxy({}, { get: () => () => assert.fail("activation denial must precede every credential or provider effect") });
    const controller = new ConnectionsController(database, noEffect, noEffect, noEffect, noEffect, noEffect);
    await assert.rejects(() => controller[action](request, connectionId, `blocked-${action}`),
      error => error.getResponse().code === "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED");
  }
});

function sampleRelation() { return { schemaVersion:1, claim:"PHONE_ACCOUNT_RELATION_VERIFIED", phoneNumberId:"123456789", wabaId:"987654321", graphVersion:"v24.0", verifiedAt:"2026-10-07T10:00:00.000Z", responseSha256:"a".repeat(64) }; }
function sampleSession(id = metaSessionId) { return { id, opaque_session_id:"123456789", provider_state_data:{wabaId:"987654321"} }; }

function operation(overrides = {}) {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    tenant_id: tenantId,
    connection_id: "40000000-0000-4000-8000-000000000001",
    operation_type: "PROVISION",
    idempotency_key: "operation-key",
    state: "QUEUED",
    attempts: 0,
    payload: {
      request: { name: "Operations", provider: "WAHA", engine: "GOWS", disclosureVersion: "2026-08-09" },
    },
    created_at: "2026-08-09T00:00:00.000Z",
    connection_name: "Operations",
    provider: "WAHA",
    connection_state: "PROVISIONING",
    ...overrides,
  };
}

test("staged WAHA provisioning rejects a forged secret reference before sidecar storage", async () => {
  const staged = operation({
    state: "STAGED",
    idempotency_key: "forged-waha-reference",
    payload: {
      request: { name: "Operations", provider: "WAHA", engine: "GOWS", disclosureVersion: "2026-08-09" },
      webhookSecretReference: "secret://platform/waha/admin",
    },
  });
  let stores = 0;
  const controller = new ConnectionsController(
    {
      rows: async () => [staged],
      withTenant: async (_tenant, callback) => callback({
        query: async (sql) => {
          if (sql.includes("SELECT * FROM connection_operations")) return { rows: [staged], rowCount: 1 };
          assert.fail(`forged stage must not continue: ${sql}`);
        },
      }),
    },
    { storeWebhookSecret: async () => { stores += 1; } },
    { wakeConnection: async () => assert.fail("forged stage must not wake") },
  );
  await assert.rejects(
    () => controller.create(request, staged.idempotency_key, {
      name: "Operations",
      provider: "WAHA",
      disclosureAccepted: true,
      disclosureVersion: "2026-08-09",
    }),
    ConflictException,
  );
  assert.equal(stores, 0);
});

test("staged Meta provisioning rejects a forged secret reference before sidecar storage", async () => {
  const accessToken = "meta-system-user-token-with-enough-entropy";
  const staged = operation({
    state: "STAGED",
    provider: "META",
    connection_name: "Official operations",
    idempotency_key: "forged-meta-reference",
    payload: {
      request: {
        name: "Official operations",
        provider: "META",
        phoneNumberId: "123456789",
        wabaId: "987654321",
        eligibilityVersion: "meta-groups-2026-08-09",
        credentialFingerprint: createHash("sha256").update(accessToken).digest("hex"),
      },
      credentialReference: "secret://platform/meta/admin",
    },
  });
  let stores = 0;
  const controller = controllerFixture(
    {
      rows: async () => [staged],
      withTenant: async (_tenant, callback) => callback({
        query: async (sql) => {
          if (sql.includes("SELECT * FROM connection_operations")) return { rows: [staged], rowCount: 1 };
          assert.fail(`forged stage must not continue: ${sql}`);
        },
      }),
    },
    { storeMetaCredential: async () => { stores += 1; } },
    {},
    { create: () => ({ verifyCredentialMetadata: async (appId, appSecret) => sampleCredentialMetadata(appId, appSecret), verifyPhoneAccountRelationship: async () => sampleRelation() }) },
  );
  await assert.rejects(
    () => controller.create(request, staged.idempotency_key, {
      name: "Official operations",
      provider: "META",
      accessToken,
      phoneNumberId: "123456789",
      wabaId: "987654321",
      eligibilityAccepted: true,
      eligibilityVersion: "meta-groups-2026-08-09",
    }),
    ConflictException,
  );
  assert.equal(stores, 0);
});

test("staged Meta rotation rejects a forged replacement reference before sidecar storage", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000004";
  const accessToken = "replacement-system-user-token-with-enough-entropy";
  const oldReference = `secret://${tenantId}/connections/${connectionId}/meta`;
  const staged = operation({
    state: "STAGED",
    provider: "META",
    connection_id: connectionId,
    operation_type: "ROTATE_META_CREDENTIAL",
    idempotency_key: "forged-meta-rotation",
    payload: {
      request: { credentialFingerprint: createHash("sha256").update(accessToken).digest("hex") },
      metaBinding:{secretReference:oldReference,providerSessionId:metaSessionId,phoneNumberId:"123456789",wabaId:"987654321"},
      oldSecretReference: oldReference,
      newSecretReference: "secret://platform/meta/replacement",
    },
  });
  let stores = 0;
  const client = {
    query: async (sql, values = []) => {
      if (sql.includes("SELECT privileged_reauth_minutes")) return { rows: [{ privileged_reauth_minutes: 15 }] };
      if (sql.startsWith("SELECT c.secret_reference")) return {rows:[{secret_reference:oldReference,provider:"META",state:"WORKING"}]};
      if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession()]};
      if (sql.includes("SELECT * FROM connection_operations")) return { rows: [staged], rowCount: 1 };
      if (sql === "SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE") {
        assert.deepEqual(values, [tenantId, connectionId]);
        return { rows: [{ id: connectionId }], rowCount: 1 };
      }
      assert.fail(`forged stage must not continue: ${sql}`);
    },
  };
  const controller = controllerFixture(
    { rows: ordinaryRotationRows(connectionId, staged.idempotency_key, () => staged), withTenant: async (_tenant, callback) => callback(client) },
    { storeMetaCredential: async () => { stores += 1; } },
    {},
    { create: () => ({ verifyCredentialMetadata: async (appId, appSecret) => sampleCredentialMetadata(appId, appSecret), verifyPhoneAccountRelationship: async () => sampleRelation() }) },
  );
  await assert.rejects(
    () => controller.rotateMetaCredential({
      ...request,
      principal: {
        ...request.principal,
        authenticatedAt: Math.floor(Date.now() / 1_000),
        authenticationMethods: ["mfa"],
      },
    }, connectionId, staged.idempotency_key, { accessToken }),
    error => error instanceof ConflictException && error.message === "Connection credential stage is invalid",
  );
  assert.equal(stores, 0);
});

test("WAHA creation durably composes connection, active session, route, operation, consent, and audit", async () => {
  const previousAdmin = process.env.WAHA_ADMIN_SECRET_REFERENCE;
  const previousWebhook = process.env.PUBLIC_WEBHOOK_BASE_URL;
  process.env.WAHA_ADMIN_SECRET_REFERENCE = "secret://platform/waha/admin";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://hooks.wasalx.example/";
  const writes = [];
  let stored;
  let stagedOperation;
  const database = {
    rows: async () => [],
    withTenant: async (actualTenant, callback) => {
      assert.equal(actualTenant, tenantId);
      const client = {
        query: async (sql, values = []) => {
          writes.push({ sql, values });
          if (sql.includes("INSERT INTO connection_operations")) {
            stagedOperation=operation({ connection_id: values[1], idempotency_key:values[2], payload: values[3], state:"STAGED" });
            return { rows: [stagedOperation] };
          }
          if(sql.includes("SELECT * FROM connection_operations"))return{rows:[stagedOperation]};
          if(sql.includes("UPDATE webhook_routes SET route_token_sha256"))return{rows:[],rowCount:1};
          if(sql.includes("UPDATE connection_operations SET state='QUEUED'"))return{rows:[{...stagedOperation,state:"QUEUED"}],rowCount:1};
          return { rows: [],rowCount:1 };
        },
      };
      return callback(client);
    },
  };
  const secrets = {
    storeWebhookSecret: async (reference, value) => {
      stored = { reference, value };
    },
    deleteSecret: async () => assert.fail("committed secret must not be deleted"),
  };
  const wakes = [];
  const controller = new ConnectionsController(database, secrets, { wakeConnection: async (tenant) => wakes.push(tenant) });

  try {
    const result = await controller.create(request, "create-operations-1", {
      name: "  Operations  ",
      provider: "waha",
      engine: "gows",
      disclosureAccepted: true,
      disclosureVersion: "2026-08-09",
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.state, "PROVISIONING");
    assert.equal(result.operation.type, "PROVISION");
    assert.deepEqual(wakes, [tenantId]);

    assert.match(stored.reference, new RegExp(`^secret://${tenantId}/connections/[0-9a-f-]+/webhook$`));
    assert.match(stored.value.routeToken, /^[A-Za-z0-9_-]{48}$/);
    assert.match(stored.value.hmacKey, /^[A-Za-z0-9_-]{64}$/);

    const connectionWrite = writes.find(({ sql }) => sql.includes("INSERT INTO connections"));
    const sessionWrite = writes.find(({ sql }) => sql.includes("INSERT INTO provider_sessions"));
    const routeWrite = writes.find(({ sql }) => sql.includes("INSERT INTO webhook_routes"));
    const operationWrite = writes.find(({ sql }) => sql.includes("INSERT INTO connection_operations"));
    const consentWrite = writes.find(({ sql }) => sql.includes("INSERT INTO consent_records"));
    const auditWrite = writes.find(({ sql }) => sql.includes("INSERT INTO audit_events"));
    assert.ok(connectionWrite && sessionWrite && routeWrite && operationWrite && consentWrite && auditWrite);
    assert.equal(connectionWrite.values[3], "GOWS");
    assert.equal(connectionWrite.values[4], "secret://platform/waha/admin");
    assert.match(sessionWrite.values[3], /^wx_[A-Za-z0-9_-]{32}$/);
    assert.match(sessionWrite.values[4], /^waha-session:\/\/[0-9a-f-]+$/);
    assert.equal(routeWrite.values[2], createHash("sha256").update(stored.value.routeToken).digest("hex"));
    assert.equal(routeWrite.values[3], stored.reference);
    assert.equal(operationWrite.values[2], "create-operations-1");
    assert.equal(operationWrite.values[3].webhookSecretReference, stored.reference);
    assert.equal(operationWrite.values[3].publicWebhookBaseUrl, "https://hooks.wasalx.example");
    assert.equal(operationWrite.values[3].request.engine, "GOWS");
    assert.doesNotMatch(JSON.stringify(operationWrite.values[3]), new RegExp(stored.value.routeToken));
  } finally {
    restore("WAHA_ADMIN_SECRET_REFERENCE", previousAdmin);
    restore("PUBLIC_WEBHOOK_BASE_URL", previousWebhook);
  }
});

test("a committed create Idempotency-Key replay does not create another secret, session, or route", async () => {
  const existing = operation();
  const database = {
    rows: async () => [existing],
    withTenant: async () => assert.fail("replay must not enter a provisioning transaction"),
  };
  const controller = new ConnectionsController(
    database,
    { storeWebhookSecret: async () => assert.fail("replay must not write a secret") },
    { wakeConnection: async () => undefined },
  );
  const result = await controller.create(request, "create-operations-1", {
    name: "Operations",
    provider: "WAHA",
    disclosureAccepted: true,
    disclosureVersion: "2026-08-09",
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.id, existing.connection_id);
  assert.equal(result.operation.id, existing.id);
});

test("WAHA engine defaults to GOWS, fingerprints replays, and rejects invalid provider combinations", async () => {
  const existing = operation();
  const controller = new ConnectionsController(
    {
      rows: async () => [existing],
      withTenant: async () => assert.fail("a replay must not enter the provisioning transaction"),
    },
    { storeWebhookSecret: async () => assert.fail("a replay must not create a secret") },
    { wakeConnection: async () => undefined },
  );
  const base = {
    name: "Operations",
    provider: "WAHA",
    disclosureAccepted: true,
    disclosureVersion: "2026-08-09",
  };
  assert.equal((await controller.create(request, "engine-default-replay", base)).duplicate, true);
  await assert.rejects(
    () => controller.create(request, "engine-default-replay", { ...base, engine: "NOWEB" }),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.create(request, "invalid-engine", { ...base, engine: "WEBJS" }),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.create(request, "meta-engine", {
      name: "Official",
      provider: "META",
      engine: "NOWEB",
    }),
    BadRequestException,
  );
});

test("create never writes a webhook secret before its durable database stage commits", async () => {
  const previousAdmin = process.env.WAHA_ADMIN_SECRET_REFERENCE;
  const previousWebhook = process.env.PUBLIC_WEBHOOK_BASE_URL;
  process.env.WAHA_ADMIN_SECRET_REFERENCE = "secret://platform/waha/admin";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://hooks.wasalx.example";
  let storedReference;
  let deletedReference;
  const controller = new ConnectionsController(
    { rows: async () => [], withTenant: async () => { throw new Error("database unavailable"); } },
    {
      storeWebhookSecret: async (reference) => { storedReference = reference; },
      deleteSecret: async (reference) => { deletedReference = reference; },
    },
    { wakeConnection: async () => assert.fail("failed transaction must not wake a worker") },
  );
  try {
    await assert.rejects(
      () => controller.create(request, "create-failure-1", {
        name: "Failure test",
        provider: "WAHA",
        disclosureAccepted: true,
        disclosureVersion: "2026-08-09",
      }),
      /database unavailable/,
    );
    assert.equal(storedReference,undefined);
    assert.equal(deletedReference,undefined);
  } finally {
    restore("WAHA_ADMIN_SECRET_REFERENCE", previousAdmin);
    restore("PUBLIC_WEBHOOK_BASE_URL", previousWebhook);
  }
});

test("an ambiguous WAHA secret write is repaired at the same durable reference", async () => {
  const previousAdmin = process.env.WAHA_ADMIN_SECRET_REFERENCE;
  const previousWebhook = process.env.PUBLIC_WEBHOOK_BASE_URL;
  process.env.WAHA_ADMIN_SECRET_REFERENCE = "secret://platform/waha/admin";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://hooks.wasalx.example";
  let stagedOperation;
  const storedReferences = [];
  const wakes = [];
  const database = {
    rows: async () => stagedOperation ? [stagedOperation] : [],
    withTenant: async (_tenant, callback) => callback({
      query: async (sql, values = []) => {
        if (sql.includes("INSERT INTO connection_operations")) {
          stagedOperation = operation({
            connection_id: values[1],
            idempotency_key: values[2],
            payload: values[3],
            state: "STAGED",
          });
          return { rows: [stagedOperation], rowCount: 1 };
        }
        if (sql.includes("SELECT * FROM connection_operations")) return { rows: [stagedOperation], rowCount: 1 };
        if (sql.includes("UPDATE webhook_routes SET route_token_sha256")) return { rows: [], rowCount: 1 };
        if (sql.includes("UPDATE connection_operations SET state='QUEUED'")) {
          stagedOperation = { ...stagedOperation, state: "QUEUED" };
          return { rows: [stagedOperation], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
    }),
  };
  const controller = new ConnectionsController(
    database,
    { storeWebhookSecret: async (reference) => {
      storedReferences.push(reference);
      if (storedReferences.length === 1) throw new Error("response lost after durable write");
    } },
    { wakeConnection: async (tenant) => wakes.push(tenant) },
  );
  const input = {
    name: "Operations",
    provider: "WAHA",
    disclosureAccepted: true,
    disclosureVersion: "2026-08-09",
  };
  try {
    await assert.rejects(
      () => controller.create(request, "ambiguous-waha-write", input),
      /retry with the same Idempotency-Key/u,
    );
    assert.equal(stagedOperation.state, "STAGED");
    const replay = await controller.create(request, "ambiguous-waha-write", input);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.operation.state, "QUEUED");
    assert.deepEqual(storedReferences, [storedReferences[0], storedReferences[0]]);
    assert.deepEqual(wakes, [tenantId]);
  } finally {
    restore("WAHA_ADMIN_SECRET_REFERENCE", previousAdmin);
    restore("PUBLIC_WEBHOOK_BASE_URL", previousWebhook);
  }
});

test("lifecycle commands enforce transitions, serialize pending work, audit, and wake the signed drain", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000002";
  const writes = [];
  const queued = operation({
    id: "30000000-0000-4000-8000-000000000002",
    connection_id: connectionId,
    operation_type: "RESTART",
    payload: { requestedFromState: "WORKING" },
    connection_state: undefined,
  });
  const client = {
    query: async (sql, values = []) => {
      writes.push({ sql, values });
      if (sql.startsWith("SELECT provider,state FROM connections")) return { rows: [{ provider: "WAHA", state: "WORKING" }] };
      if (sql.includes("SELECT o.*")) return { rows: [] };
      if (sql.includes("SELECT id,name,provider,state")) {
        return { rows: [{ id: connectionId, name: "Line", provider: "WAHA", state: "WORKING", action_reason: null }] };
      }
      if (sql.includes("SELECT id,operation_type FROM connection_operations")) return { rows: [] };
      if (sql.includes("SELECT clock_timestamp()::text AS value")) return { rows: [{ value: "2026-09-04T12:00:00.000000Z" }] };
      if (sql.includes("INSERT INTO connection_operations")) return { rows: [queued] };
      if (sql.includes("UPDATE webhook_routes")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  };
  const wakes = [];
  const controller = new ConnectionsController(
    { withTenant: async (_tenant, callback) => callback(client) },
    {},
    { wakeConnection: async (tenant) => wakes.push(tenant) },
  );
  const result = await controller.restart(request, connectionId, "restart-line-1");
  assert.equal(result.operation.type, "RESTART");
  assert.equal(result.state, "WORKING");
  assert.equal(result.duplicate, false);
  assert.deepEqual(wakes, [tenantId]);
  assert.equal(writes.some(({ sql }) => sql.includes("UPDATE connections SET state=$1")), false);
  assert.ok(writes.some(({ sql, values }) => sql.includes("UPDATE webhook_routes") && values[2] === "2026-09-04T12:00:00.000000Z"));
  assert.ok(writes.some(({ sql }) => sql.includes("INSERT INTO audit_events")));
});

test("a lifecycle replay that commits while waiting for the connection lock returns the existing operation", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000005";
  const existing = operation({
    id: "30000000-0000-4000-8000-000000000005",
    connection_id: connectionId,
    operation_type: "RESTART",
    connection_state: "CONNECTING",
  });
  let replayReads = 0;
  const client = {
    query: async (sql) => {
      if (sql.startsWith("SELECT provider,state FROM connections")) return { rows: [{ provider: "WAHA", state: "CONNECTING" }] };
      if (sql.includes("SELECT o.*")) return { rows: replayReads++ < 2 ? [] : [existing] };
      if (sql.includes("SELECT id,name,provider,state")) {
        return { rows: [{ id: connectionId, name: "Line", provider: "WAHA", state: "CONNECTING", action_reason: null }] };
      }
      assert.fail(`replay must not mutate state: ${sql}`);
    },
  };
  const wakes = [];
  const controller = new ConnectionsController(
    { withTenant: async (_tenant, callback) => callback(client) },
    {},
    { wakeConnection: async (tenant) => wakes.push(tenant) },
  );
  const result = await controller.restart(request, connectionId, "restart-racing-replay");
  assert.equal(result.duplicate, true);
  assert.equal(result.operation.id, existing.id);
  assert.equal(replayReads, 3);
  assert.deepEqual(wakes, [tenantId]);
});

test("lifecycle rejects invalid transitions and requires explicit disconnect confirmation", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000003";
  const client = {
    query: async (sql) => {
      if (sql.startsWith("SELECT provider,state FROM connections")) return { rows: [{ provider: "WAHA", state: "PROVISIONING" }] };
      if (sql.includes("SELECT o.*")) return { rows: [] };
      if (sql.includes("SELECT id,name,provider,state")) {
        return { rows: [{ id: connectionId, name: "Line", provider: "WAHA", state: "PROVISIONING", action_reason: null }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const controller = new ConnectionsController(
    { withTenant: async (_tenant, callback) => callback(client) },
    {},
    { wakeConnection: async () => assert.fail("rejected operation must not wake") },
  );
  await assert.rejects(() => controller.start(request, connectionId, "start-too-soon"), ConflictException);
  assert.throws(() => controller.disconnect(request, connectionId, "disconnect-1", { confirmation: "yes" }), BadRequestException);
  await assert.rejects(() => controller.pause(request, connectionId, undefined), BadRequestException);
});

for (const consent of [{}, { eligibilityAccepted: false }, { eligibilityAccepted: true, eligibilityVersion: "meta-groups-2026-08-09" }]) {
test(`Meta provisioning stores only credentials and explicit consent: ${JSON.stringify(consent)}`, async () => {
  const previousAppSecret = process.env.META_APP_SECRET_REFERENCE;
  const previousGraphVersion = process.env.META_GRAPH_VERSION;
  process.env.META_APP_SECRET_REFERENCE = "secret://platform/meta-webhook";
  process.env.META_GRAPH_VERSION = "v24.0";
  const writes = [];
  let stored;
  let stagedOperation;
  const database = {
    rows: async () => [],
    withTenant: async (actualTenant, callback) => {
      assert.equal(actualTenant, tenantId);
      const client = {
        query: async (sql, values = []) => {
          writes.push({ sql, values });
          if(sql.includes("app.meta_lifecycle_guard")){assert.equal(values[5],0);return{rows:[{revision_matches:true,blocked:false,unresolved_hold:false}],rowCount:1};}
      if (sql.startsWith("SELECT c.secret_reference")) return {rows:[{secret_reference:stagedOperation.payload.credentialReference,provider:"META",state:"PROVISIONING"}]};
          if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession(stagedOperation.payload.providerSessionId)]};
          if (sql.includes("INSERT INTO connection_operations")) {
            stagedOperation=operation({
              connection_id: values[1],idempotency_key:values[2],payload:values[3],state:"STAGED",
              provider:"META",connection_name:"Official operations",
            });
            return {
              rows: [stagedOperation],
            };
          }
          if(sql.includes("SELECT * FROM connection_operations"))return{rows:[stagedOperation]};
          if(sql.includes("UPDATE connection_operations SET state='QUEUED'"))return{rows:[{...stagedOperation,state:"QUEUED"}],rowCount:1};
          return { rows: [],rowCount:1 };
        },
      };
      return callback(client);
    },
  };
  const wakes = [];
  const controller = controllerFixture(
    database,
    {
      storeMetaCredential: async (reference, value) => { stored = { reference, value }; },
      storeWebhookSecret: async () => assert.fail("Meta must not create a WAHA webhook secret"),
      deleteSecret: async () => assert.fail("committed Meta credential must not be deleted"),
    },
    { wakeConnection: async (tenant) => wakes.push(tenant) },
    { create: (token, phoneNumberId) => {
      assert.equal(token, "meta-system-user-token-with-enough-entropy");
      assert.equal(phoneNumberId, "123456789");
      return { verifyCredentialMetadata: async (appId, appSecret) => sampleCredentialMetadata(appId, appSecret), verifyPhoneAccountRelationship: async () => sampleRelation() };
    } },
  );
  try {
    const result = await controller.create(request, "create-meta-1", {
      name: "Official operations",
      provider: "META",
      accessToken: "meta-system-user-token-with-enough-entropy",
      phoneNumberId: "123456789",
      wabaId: "987654321",
      ...consent,
    });
    assert.equal(result.state, "PROVISIONING");
    assert.equal(result.operation.type, "PROVISION");
    assert.deepEqual(wakes, [tenantId]);
    assert.match(stored.reference, new RegExp(`^secret://${tenantId}/connections/[0-9a-f-]+/meta$`));
    assert.deepEqual(stored.value, { accessToken: "meta-system-user-token-with-enough-entropy" });

    const connectionWrite = writes.find(({ sql }) => sql.includes("INSERT INTO connections"));
    const sessionWrite = writes.find(({ sql }) => sql.includes("INSERT INTO provider_sessions"));
    const routeWrite = writes.find(({ sql }) => sql.includes("INSERT INTO webhook_routes"));
    const operationWrite = writes.find(({ sql }) => sql.includes("INSERT INTO connection_operations"));
    const consentWrite = writes.find(({ sql }) => sql.includes("INSERT INTO consent_records"));
    assert.ok(connectionWrite && sessionWrite && routeWrite && operationWrite);
    assert.equal(Boolean(consentWrite), consent.eligibilityAccepted === true);
    assert.equal(connectionWrite.values[4], consent.eligibilityVersion ?? null);
    assert.equal(operationWrite.values[3].request.eligibilityVersion, consent.eligibilityVersion ?? null);
    assert.equal(connectionWrite.values[3], stored.reference);
    assert.equal(sessionWrite.values[3], "123456789");
    assert.deepEqual(JSON.parse(sessionWrite.values[5]), { wabaId: "987654321", eligibility: "UNVERIFIED" });
    assert.equal(routeWrite.values[2], "123456789");
    assert.equal(routeWrite.values[3], "secret://platform/meta-webhook");
    assert.match(routeWrite.sql, /'PAUSED'/);
    assert.doesNotMatch(JSON.stringify(operationWrite.values), /meta-system-user-token-with-enough-entropy/);
    assert.match(operationWrite.values[3].request.credentialFingerprint, /^[0-9a-f]{64}$/);
    const proofWrite = writes.find(({ sql }) => sql.includes("jsonb_build_object('metaAccountProof'"));
    assert.ok(proofWrite);
    const proof = JSON.parse(proofWrite.values[3]);
    assert.equal(proof.credentialMetadata.appId, metaAppId);
    assert.equal(proof.credentialMetadata.claim, "CREDENTIAL_METADATA_VERIFIED");
    assert.equal(proof.credentialFingerprint, operationWrite.values[3].request.credentialFingerprint);
    assert.equal(proof.providerSessionId, stagedOperation.payload.providerSessionId);
    assert.equal(proof.secretReference, stored.reference);
    assert.doesNotMatch(JSON.stringify(proof), /synthetic-configured-meta-app-secret|meta-system-user-token-with-enough-entropy/u);

  } finally {
    restore("META_APP_SECRET_REFERENCE", previousAppSecret);
    restore("META_GRAPH_VERSION", previousGraphVersion);
  }

  await assert.rejects(
    () => controller.detail(request, "40000000-0000-4000-8000-000000000004"),
    NotFoundException,
  );
});
}

test("manual Meta setup reports only the global phone reservation as a safe conflict", async () => {
  const reserved = Object.assign(new Error("private database ownership detail"), {
    code: "23505", constraint: "webhook_routes_provider_external_key_key",
  });
  const unrelated = Object.assign(new Error("unrelated unique failure"), {
    code: "23505", constraint: "unrelated_constraint",
  });
  for (const failure of [reserved, unrelated, new Error("database unavailable")]) {
    const writes = [];
    const controller = controllerFixture({
      rows: async () => [],
      withTenant: async (_tenant, callback) => callback({ query: async sql => {
        writes.push(sql);
        if (sql.includes("INSERT INTO webhook_routes")) throw failure;
        return { rows: [], rowCount: 1 };
      } }),
    }, {
      storeMetaCredential: async () => assert.fail("rolled-back setup must not write credentials"),
    }, {
      wakeConnection: async () => assert.fail("rolled-back setup must not wake workers"),
    }, {
      create: () => ({
        verifyCredentialMetadata: async () => sampleCredentialMetadata(),
        verifyPhoneAccountRelationship: async () => sampleRelation(),
      }),
    });
    await assert.rejects(() => controller.create(request, "manual-reserved-phone", {
      name: "Official operations", provider: "META",
      accessToken: "meta-system-user-token-with-enough-entropy",
      phoneNumberId: "123456789", wabaId: "987654321",
    }), error => {
      if (failure !== reserved) return error === failure;
      assert.ok(error instanceof ConflictException);
      assert.equal(error.getStatus(), 409);
      assert.deepEqual(error.getResponse(), {
        code: "META_SIGNUP_ASSET_CONFLICT", message: "This number is already connected.",
      });
      assert.doesNotMatch(JSON.stringify(error.getResponse()), /private|constraint|tenant|23505/u);
      return true;
    });
    assert.ok(writes.some(sql => sql.includes("INSERT INTO webhook_routes")));
    assert.ok(!writes.some(sql => sql.includes("INSERT INTO connection_operations")));
  }
});

test("malformed Meta Groups consent fails before credential validation or database writes", async () => {
  const controller = new ConnectionsController(
    { rows: async () => assert.fail("no database access for malformed consent") }, {}, {},
    { create: () => assert.fail("no provider calls for malformed consent") },
  );
  for (const consent of [
    { eligibilityAccepted: "true", eligibilityVersion: "v1" },
    { eligibilityAccepted: true }, { eligibilityVersion: "v1" },
    { eligibilityAccepted: false, eligibilityVersion: "v1" },
    { eligibilityAccepted: true, eligibilityVersion: 123 },
    { eligibilityAccepted: true, eligibilityVersion: " " },
    { eligibilityAccepted: true, eligibilityVersion: "a\u0000b" },
    { eligibilityAccepted: true, eligibilityVersion: "x".repeat(101) },
  ]) {
    await assert.rejects(() => controller.create(request, "malformed-consent", {
      name: "Direct", provider: "META", accessToken: "meta-system-user-token-with-enough-entropy",
      phoneNumberId: "123456789", wabaId: "987654321", ...consent,
    }), BadRequestException);
  }
});

test("Meta creation replay preserves optional consent and rejects changing it on the same key", async () => {
  const token = "meta-system-user-token-with-enough-entropy";
  for (const version of [null, "v1"]) {
    const existing = operation({ provider: "META", connection_name: "Direct", state: "SUCCEEDED", payload: {
      request: { provider: "META", phoneNumberId: "123456789", wabaId: "987654321", eligibilityVersion: version,
        credentialFingerprint: createHash("sha256").update(token).digest("hex") },
    } });
    const controller = new ConnectionsController({ rows: async () => [existing] }, {}, {},
      { create: () => assert.fail("completed replay must not call Meta") });
    const body = { name: "Direct", provider: "META", accessToken: token, phoneNumberId: "123456789", wabaId: "987654321" };
    assert.equal((await controller.create(request, "replay-meta", { ...body, ...(version ? { eligibilityAccepted: true, eligibilityVersion: version } : {}) })).duplicate, true);
    await assert.rejects(() => controller.create(request, "replay-meta", { ...body, ...(version ? {} : { eligibilityAccepted: true, eligibilityVersion: "v1" }) }), ConflictException);
  }
});

function metaSyncHarness({ version = null, provider = "META", replay, afterLock = false, raced = false, pending = false, lifecycleHold = false } = {}) {
  const connectionId = operation().connection_id;
  const writes = [];
  let reads = 0;
  let saved = replay;
  const controller = new ConnectionsController({ withTenant: async (actualTenant, callback) => {
    assert.equal(actualTenant, tenantId);
    return callback({ query: async (sql, values = []) => {
      writes.push({ sql, values });
      if(sql.includes("app.meta_add_access_activation_held")){assert.deepEqual(values,[tenantId,connectionId]);return{rows:[{held:false}],rowCount:1};}
      if(sql.includes("app.meta_lifecycle_guard")){assert.equal(values[5],0);return{rows:[{revision_matches:true,blocked:false,unresolved_hold:lifecycleHold}],rowCount:1};}
      if (sql.startsWith("SELECT c.secret_reference")) return {rows:[{secret_reference:`secret://${tenantId}/connections/${connectionId}/meta`,provider:"META",state:"WORKING"}]};
      if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession()]};
      if (sql.includes("SELECT o.*")) return { rows: saved && (!afterLock || reads++ > 0) && (!raced || writes.some(w => w.sql.includes("INSERT INTO connection_operations"))) ? [saved] : [] };
      if (sql.includes("SELECT id,name,provider,state")) return { rows: [{ id: connectionId, name: "Direct", provider, state: "WORKING", disclosure_version: version }] };
      if (sql.includes("SELECT id,operation_type")) return { rows: pending ? [{ operation_type: "RESTART" }] : [] };
      if (sql.includes("INSERT INTO connection_operations")) {
        if (raced) return { rows: [] };
        saved = operation({ connection_id: connectionId, operation_type: "SYNC_GROUPS", provider, payload: values[4] });
        return { rows: [saved] };
      }
      if (sql.includes("UPDATE connections SET disclosure_version")) version = values[2];
      return { rows: [], rowCount: 1 };
    } });
  } }, {}, { wakeConnection: async () => {} });
  return { controller, connectionId, writes, version: () => version, operation: () => saved };
}

test("Meta Groups opt-in uses the existing locked sync transaction and is immutable on replay", async () => {
  const h = metaSyncHarness();
  const consent = { eligibilityAccepted: true, eligibilityVersion: "v1" };
  assert.equal((await h.controller.syncGroups(request, h.connectionId, "sync-opt-in", consent)).duplicate, false);
  assert.equal(h.version(), "v1");
  assert.equal(h.operation().payload.eligibilityVersion, "v1");
  const mutations = () => h.writes.filter(w => /^(INSERT|UPDATE)/.test(w.sql.trim()));
  assert.ok(mutations().some(w => w.sql.includes("INSERT INTO consent_records") && w.values[2] === "v1"));
  assert.ok(mutations().some(w => w.sql.includes("INSERT INTO audit_events") && w.values.includes("connection.meta_groups_consent_accepted")));
  const count = mutations().length;
  assert.equal((await h.controller.syncGroups(request, h.connectionId, "sync-opt-in", consent)).duplicate, true);
  assert.equal(mutations().length, count);
  await assert.rejects(() => h.controller.syncGroups(request, h.connectionId, "sync-opt-in", {}), ConflictException);
  await assert.rejects(() => h.controller.syncGroups(request, h.connectionId, "sync-opt-in", { ...consent, eligibilityVersion: "v2" }), ConflictException);
  assert.equal(mutations().length, count);
});

test("Meta Groups sync rejects missing consent, other providers, changed consent and pending work without writes", async () => {
  for (const [options, body, error] of [
    [{}, {}, ConflictException],
    [{ provider: "WAHA" }, { eligibilityAccepted: true, eligibilityVersion: "v1" }, BadRequestException],
    [{ version: "v1" }, { eligibilityAccepted: true, eligibilityVersion: "v2" }, ConflictException],
    [{ pending: true }, { eligibilityAccepted: true, eligibilityVersion: "v1" }, ConflictException],
  ]) {
    const h = metaSyncHarness(options);
    await assert.rejects(() => h.controller.syncGroups(request, h.connectionId, "denied-sync", body), error);
    assert.equal(h.writes.some(w => /^(INSERT|UPDATE)/.test(w.sql.trim())), false);
  }
  for (const provider of ["META", "WAHA"]) {
    const h = metaSyncHarness({ version: "v1", provider });
    await h.controller.syncGroups(request, h.connectionId, "legacy-sync");
    assert.equal(h.writes.some(w => w.sql.includes("INSERT INTO consent_records")), false);
  }
});

test("legacy Meta sync retains absent app configuration but still checks pending lifecycle holds",async()=>{
  const keys=["META_APP_ID","META_APP_SECRET_REFERENCE","META_GRAPH_VERSION"],saved=keys.map(key=>process.env[key]);
  try{
    for(const key of keys)delete process.env[key];
    const clear=metaSyncHarness({version:"v1"});await clear.controller.syncGroups(request,clear.connectionId,"legacy-unconfigured-sync");
    assert.equal(clear.writes.find(write=>write.sql.includes("app.meta_lifecycle_guard")).values[4],"");
    const held=metaSyncHarness({version:"v1",lifecycleHold:true});
    await assert.rejects(()=>held.controller.syncGroups(request,held.connectionId,"legacy-held-sync"),/lifecycle reconciliation/u);
    assert.equal(held.writes.some(write=>write.sql.includes("INSERT INTO connection_operations")),false);
  }finally{keys.forEach((key,index)=>restore(key,saved[index]));}
});

test("a raced legacy sync replay cannot add consent before or after the connection lock", async () => {
  const replay = operation({ provider: "META", operation_type: "SYNC_GROUPS", payload: {} });
  for (const options of [{}, { afterLock: true }, { raced: true }]) {
    const h = metaSyncHarness({ version: "v1", replay, ...options });
    await assert.rejects(() => h.controller.syncGroups(request, h.connectionId, "legacy-key", { eligibilityAccepted: true, eligibilityVersion: "v1" }), ConflictException);
    assert.equal(h.writes.some(w => w.sql.includes("SET disclosure_version") || w.sql.includes("INSERT INTO consent_records")), false);
  }
});

test("Meta credential rotation requires recent MFA and stores only the replacement secret", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000004";
  const reference = `secret://${tenantId}/connections/${connectionId}/meta`;
  const replacement = "replacement-system-user-token-with-enough-entropy";
  const writes = [];
  let stored;
  let currentReference=reference;
  let stagedOperation;
  let validationOperation;
  const wakes=[];
  const client = {
    query: async (sql, values = []) => {
      writes.push({ sql, values });
      if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession()]};
      if (sql.includes("SELECT c.secret_reference,c.provider,c.state")) {
        return { rows: [{ secret_reference: reference, provider: "META", state: "WORKING", phone_number_id: "123456789" }] };
      }
      if (sql.includes("SELECT privileged_reauth_minutes")) {
        return { rows: [{ privileged_reauth_minutes: 15 }] };
      }
      if(sql.includes("SELECT secret_reference")&&sql.includes("FROM connections"))return{rows:[{secret_reference:currentReference,state:"WORKING"}],rowCount:1};
      if(sql.includes("VALUES ($1,$2,'RESTART'")){
        validationOperation=operation({id:"rotation-validation",connection_id:connectionId,idempotency_key:values[2],
          operation_type:"RESTART",payload:values[3],state:"QUEUED",provider:"META",connection_state:"WORKING"});
        return{rows:[validationOperation],rowCount:1};
      }
      if(sql.includes("INSERT INTO connection_operations")){
        stagedOperation=operation({id:"rotation-operation",connection_id:connectionId,idempotency_key:values[2],
          operation_type:"ROTATE_META_CREDENTIAL",payload:values[3],state:"STAGED",provider:"META",connection_state:"WORKING"});
        return{rows:[stagedOperation],rowCount:1};
      }
      if(sql.includes("SELECT * FROM connection_operations"))return{rows:[stagedOperation],rowCount:1};
      if(sql.includes("UPDATE connections SET secret_reference")){currentReference=values[0];return{rows:[],rowCount:1};}
      if(sql.includes("UPDATE connection_operations SET state='SUCCEEDED'"))return{rows:[],rowCount:1};
      return { rows: [],rowCount:1 };
    },
  };
  const controller = controllerFixture(
    { rows:async()=>[],withTenant: async (actualTenant, callback) => {
      assert.equal(actualTenant, tenantId);
      return callback(client);
    } },
    { storeMetaCredential: async (actualReference, value) => {
      stored = { reference: actualReference, value };
    } },
    { wakeConnection:async tenant=>wakes.push(tenant) },
    { create: (token, phoneNumberId) => {
      assert.equal(token, replacement);
      assert.equal(phoneNumberId, "123456789");
      return { verifyCredentialMetadata: async (appId, appSecret) => sampleCredentialMetadata(appId, appSecret), verifyPhoneAccountRelationship: async () => sampleRelation() };
    } },
  );
  const result = await controller.rotateMetaCredential(
    {
      ...request,
      principal: {
        ...request.principal,
        authenticatedAt: Math.floor(Date.now() / 1_000),
        authenticationMethods: ["mfa"],
      },
    },
    connectionId,
    "rotate-meta-credential",
    { accessToken: replacement },
  );
  assert.deepEqual(result, { rotated: true,duplicate:false });
  assert.match(stored.reference,/\/meta\/rotations\/[0-9a-f]{64}$/u);
  assert.deepEqual(stored.value, { accessToken: replacement });
  assert.equal(currentReference,stored.reference);
  const proofWrite = writes.find(({ sql }) => sql.includes("jsonb_build_object('metaAccountProof'"));
  const proof = JSON.parse(proofWrite.values[3]);
  assert.equal(proof.credentialMetadata.appId, metaAppId);
  assert.equal(proof.credentialFingerprint, createHash("sha256").update(replacement).digest("hex"));
  assert.equal(proof.secretReference, stored.reference);
  assert.deepEqual(stagedOperation.payload.accountRelation.credentialMetadata, proof.credentialMetadata);

  assert.doesNotMatch(JSON.stringify(writes), new RegExp(replacement));
  const audit = writes.find(({ sql }) => sql.includes("INSERT INTO audit_events"));
  assert.ok(audit);
  assert.match(JSON.stringify(audit.values), /connection\.meta_credential_rotated/u);
  assert.match(JSON.stringify(audit.values), /credential_fingerprint_sha256/u);
  assert.equal(validationOperation.operation_type,"RESTART");
  assert.equal(validationOperation.payload.sourceOperationId,"rotation-operation");
  assert.equal(validationOperation.payload.metaBinding.secretReference,currentReference);
  assert.match(validationOperation.idempotency_key,/^meta-credential-validation:[0-9a-f]{64}$/u);
  assert.deepEqual(wakes,[tenantId]);
});

test("an ambiguous Meta rotation keeps the old reference live and repairs the same staged write", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000014";
  const oldReference = `secret://${tenantId}/connections/${connectionId}/meta`;
  const replacement = "replacement-system-user-token-for-ambiguous-retry";
  let currentReference = oldReference;
  let metadataChecks = 0;
  let stagedOperation;
  let validationOperation;
  let finalizationAttempts = 0;
  let committedAudits = 0;
  let committedOldCleanup = 0;
  const storedReferences = [];
  const client = {
    query: async (sql, values = []) => {
      if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession()]};
      if (sql.includes("SELECT c.secret_reference,c.provider,c.state")) {
        return { rows: [{ secret_reference: currentReference, provider: "META", state: "WORKING", phone_number_id: "123456789" }] };
      }
      if (sql.includes("SELECT privileged_reauth_minutes")) return { rows: [{ privileged_reauth_minutes: 15 }] };
      if (sql.includes("SELECT ps.opaque_session_id AS phone_number_id")) return { rows: [{ phone_number_id: "123456789" }] };
      if (sql.includes("SELECT secret_reference") && sql.includes("FROM connections")) return { rows: [{ secret_reference: currentReference, state: "WORKING" }], rowCount: 1 };
      if (sql.includes("VALUES ($1,$2,'RESTART'")) {
        validationOperation = operation({
          id: "rotation-validation-ambiguous",
          connection_id: connectionId,
          idempotency_key: values[2],
          operation_type: "RESTART",
          payload: values[3],
          state: "QUEUED",
          provider: "META",
          connection_state: "WORKING",
        });
        return { rows: [validationOperation], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO connection_operations")) {
        stagedOperation = operation({
          id: "rotation-operation-ambiguous",
          connection_id: connectionId,
          idempotency_key: values[2],
          operation_type: "ROTATE_META_CREDENTIAL",
          payload: values[3],
          state: "STAGED",
          provider: "META",
          connection_state: "WORKING",
        });
        return { rows: [stagedOperation], rowCount: 1 };
      }
      if (sql.includes("SELECT * FROM connection_operations")) return { rows: [stagedOperation], rowCount: 1 };
      if (sql.includes("UPDATE connections SET secret_reference")) {
        currentReference = values[0];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("'CONNECTION_CREDENTIAL'")) {
        if (values[3] === oldReference) committedOldCleanup += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        committedAudits += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE connection_operations SET state='SUCCEEDED'")) {
        stagedOperation = { ...stagedOperation, state: "SUCCEEDED" };
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const database = {
    rows: ordinaryRotationRows(connectionId, "ambiguous-meta-rotation", () => stagedOperation),
    withTenant: async (_tenant, callback) => {
      const snapshot = { currentReference, stagedOperation, validationOperation, committedAudits, committedOldCleanup };
      const result = await callback(client);
      if (stagedOperation?.state === "SUCCEEDED" && finalizationAttempts++ === 0) {
        ({ currentReference, stagedOperation, validationOperation, committedAudits, committedOldCleanup } = snapshot);
        throw new Error("commit outcome unknown");
      }
      return result;
    },
  };
  const wakes=[];
  const controller = controllerFixture(
    database,
    { storeMetaCredential: async (reference) => { storedReferences.push(reference); } },
    { wakeConnection:async tenant=>wakes.push(tenant) },
    { create: () => ({ verifyCredentialMetadata: async (appId, appSecret) => { metadataChecks++; return sampleCredentialMetadata(appId, appSecret); }, verifyPhoneAccountRelationship: async () => sampleRelation() }) },
  );
  const authenticated = {
    ...request,
    principal: {
      ...request.principal,
      authenticatedAt: Math.floor(Date.now() / 1_000),
      authenticationMethods: ["mfa"],
    },
  };
  await assert.rejects(
    () => controller.rotateMetaCredential(authenticated, connectionId, "ambiguous-meta-rotation", { accessToken: replacement }),
    /commit outcome unknown/u,
  );
  assert.equal(currentReference, oldReference);
  assert.equal(stagedOperation.state, "STAGED");

  const replay = await controller.rotateMetaCredential(
    authenticated,
    connectionId,
    "ambiguous-meta-rotation",
    { accessToken: replacement },
  );
  assert.deepEqual(replay, { rotated: true, duplicate: true });
  assert.notEqual(currentReference, oldReference);
  assert.deepEqual(storedReferences, [storedReferences[0], storedReferences[0]]);
  assert.equal(committedAudits, 1);
  assert.equal(committedOldCleanup, 1);
  assert.equal(validationOperation.payload.sourceOperationId,"rotation-operation-ambiguous");
  assert.equal(validationOperation.payload.metaBinding.secretReference,currentReference);
  assert.deepEqual(wakes,[tenantId]);
  assert.equal(metadataChecks, 2);
  assert.equal(stagedOperation.payload.accountRelation.credentialMetadata.appId, metaAppId);
  assert.deepEqual(await controller.rotateMetaCredential(authenticated, connectionId, "ambiguous-meta-rotation", { accessToken: replacement }), { rotated: true, duplicate: true });
  assert.equal(metadataChecks, 2, "committed replay must not reverify or upgrade proof");
  assert.equal(storedReferences.length, 2);
  assert.deepEqual(wakes, [tenantId]);
});

test("a concurrent Meta rotation replay resolves after the connection lock without rewriting the winner", async () => {
  const connectionId = "40000000-0000-4000-8000-000000000024";
  const oldReference = `secret://${tenantId}/connections/${connectionId}/meta`;
  const replacement = "replacement-system-user-token-for-concurrent-replay";
  const fingerprint = createHash("sha256").update(replacement).digest("hex");
  const winner = operation({
    id: "rotation-operation-winner",
    connection_id: connectionId,
    idempotency_key: "concurrent-meta-rotation",
    operation_type: "ROTATE_META_CREDENTIAL",
    payload: {
      request: { credentialFingerprint: fingerprint },
      oldSecretReference: oldReference,
      newSecretReference: `${oldReference}/rotations/winner`,
    },
    state: "SUCCEEDED",
    provider: "META",
    connection_state: "WORKING",
  });
  let transaction = 0;
  let validationOperation;
  const wakes=[];
  const controller = controllerFixture(
    {
      rows: async () => [],
      withTenant: async (_tenant, callback) => {
        transaction += 1;
        return callback({ query: async (sql,values=[]) => {
          if (sql.includes("SELECT privileged_reauth_minutes")) return { rows: [{ privileged_reauth_minutes: 15 }] };
          if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession()]};
      if (sql.includes("SELECT c.secret_reference,c.provider,c.state")) {
            return { rows: [{ secret_reference: transaction === 1 ? oldReference : winner.payload.newSecretReference, provider: "META", state: "WORKING", phone_number_id: "123456789" }] };
          }
          if (sql.includes("SELECT secret_reference") && sql.includes("FROM connections")) {
            return { rows: [{ secret_reference: winner.payload.newSecretReference, state: "WORKING" }], rowCount: 1 };
          }
          if (sql.includes("VALUES ($1,$2,'RESTART'")) {
            validationOperation=operation({id:"rotation-validation-winner",connection_id:connectionId,idempotency_key:values[2],operation_type:"RESTART",payload:values[3],state:"QUEUED",provider:"META",connection_state:"WORKING"});
            return { rows: [validationOperation], rowCount: 1 };
          }
          if (sql.includes("SELECT o.*,c.name AS connection_name")) return { rows: [winner], rowCount: 1 };
          if (sql.includes("SELECT * FROM connection_operations")) return { rows: [winner], rowCount: 1 };
          if (sql === "SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE") {
            assert.deepEqual(values, [tenantId, connectionId]);
            return { rows: [{ id: connectionId }], rowCount: 1 };
          }
          assert.fail(`unexpected SQL in transaction ${transaction}: ${sql}`);
        } });
      },
    },
    { storeMetaCredential: async () => assert.fail("a concurrent winner must not be rewritten") },
    { wakeConnection:async tenant=>wakes.push(tenant) },
    { create: () => ({ verifyCredentialMetadata: async (appId, appSecret) => sampleCredentialMetadata(appId, appSecret), verifyPhoneAccountRelationship: async () => sampleRelation() }) },
  );
  const result = await controller.rotateMetaCredential({
    ...request,
    principal: {
      ...request.principal,
      authenticatedAt: Math.floor(Date.now() / 1_000),
      authenticationMethods: ["mfa"],
    },
  }, connectionId, "concurrent-meta-rotation", { accessToken: replacement });
  assert.deepEqual(result, { rotated: true, duplicate: true });
  assert.equal(transaction, 3);
  assert.equal(validationOperation,undefined);
  assert.deepEqual(wakes,[]);
});

test("invalid Meta credentials are rejected before secret storage or audit", async () => {
  let stores = 0;
  const invalid = new MetaGraphClientError(
    "META_AUTHENTICATION_FAILED",
    "Meta credentials are invalid or expired.",
    false,
    401,
    true,
  );
  const controller = controllerFixture(
    { rows: async () => [] },
    { storeMetaCredential: async () => { stores++; } },
    {},
    { create: () => ({ verifyCredentialMetadata: async () => { throw invalid; }, verifyPhoneAccountRelationship: async () => assert.fail("invalid metadata must stop before relation lookup") }) },
  );
  await assert.rejects(
    () => controller.create(request, "create-meta-invalid", {
      name: "Official operations",
      provider: "META",
      accessToken: "expired-system-user-token-with-enough-entropy",
      phoneNumberId: "123456789",
      wabaId: "987654321",
      eligibilityAccepted: true,
      eligibilityVersion: "meta-groups-2026-08-09",
    }),
    (error) => error instanceof BadRequestException && error.message === invalid.safeError,
  );
  assert.equal(stores, 0);

  const writes = [];
  const connectionId = "40000000-0000-4000-8000-000000000004";
  const rotation = controllerFixture(
    { rows:async()=>[],withTenant: async (_tenant, callback) => callback({ query: async (sql, values = []) => {
      writes.push({ sql, values });
      if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return {rows:[sampleSession()]};
      if (sql.includes("SELECT c.secret_reference,c.provider,c.state")) {
        return { rows: [{
          secret_reference: `secret://${tenantId}/connections/${connectionId}/meta`,
          provider: "META",
          state: "WORKING",
          phone_number_id: "123456789",
        }] };
      }
      if (sql.includes("SELECT privileged_reauth_minutes")) {
        return { rows: [{ privileged_reauth_minutes: 15 }] };
      }
      return { rows: [] };
    } }) },
    { storeMetaCredential: async () => { stores++; } },
    {},
    { create: () => ({ verifyCredentialMetadata: async () => { throw invalid; }, verifyPhoneAccountRelationship: async () => assert.fail("invalid metadata must stop before relation lookup") }) },
  );
  const authenticated = {
    ...request,
    principal: {
      ...request.principal,
      authenticatedAt: Math.floor(Date.now() / 1_000),
      authenticationMethods: ["mfa"],
    },
  };
  await assert.rejects(
    () => rotation.rotateMetaCredential(authenticated, connectionId, undefined, {
      accessToken: "expired-system-user-token-with-enough-entropy",
    }),
    (error) => error instanceof BadRequestException && error.message === "A valid Idempotency-Key header is required",
  );
  await assert.rejects(
    () => rotation.rotateMetaCredential(authenticated, connectionId,"invalid-meta-rotation", {
      accessToken: "expired-system-user-token-with-enough-entropy",
    }),
    (error) => error instanceof BadRequestException && error.message === invalid.safeError,
  );
  assert.equal(stores, 0);
  assert.equal(writes.some(({ sql }) => sql.includes("INSERT INTO audit_events")), false);
});

test("staged Meta rotation rejects a missing or changed immutable account binding", async () => {
  const connectionId="40000000-0000-4000-8000-000000000004";
  const token="synthetic-staged-meta-rotation-token";
  const binding={secretReference:`secret://${tenantId}/connections/${connectionId}/meta`,providerSessionId:metaSessionId,phoneNumberId:"123456789",wabaId:"987654321"};
  for(const selected of [undefined,{...binding,wabaId:"111111111"},{...binding,providerSessionId:"foreign-session"},{...binding,secretReference:binding.secretReference+"/rotations/old"}]){
    const staged=operation({connection_id:connectionId,provider:"META",operation_type:"ROTATE_META_CREDENTIAL",state:"STAGED",payload:{request:{credentialFingerprint:createHash("sha256").update(token).digest("hex")},metaBinding:selected}});
    const controller=new ConnectionsController({rows:ordinaryRotationRows(connectionId,staged.idempotency_key,()=>staged),withTenant:async(_tenant,callback)=>callback({query:async sql=>{
      if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
      if(sql.startsWith("SELECT c.secret_reference"))return{rows:[{secret_reference:binding.secretReference,provider:"META",state:"WORKING"}]};
      if(sql.startsWith("SELECT id,opaque_session_id,provider_state_data"))return{rows:[sampleSession()]};
      assert.fail(`unexpected mutation: ${sql}`);
    }})},{storeMetaCredential:async()=>assert.fail("no secret write")},{},{create:()=>assert.fail("no provider call")});
    await assert.rejects(()=>controller.rotateMetaCredential({...request,principal:{...request.principal,authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}},connectionId,staged.idempotency_key,{accessToken:token}),error=>error instanceof ConflictException&&error.message==="The Meta connection changed; refresh before continuing");
  }
});

test("HTTP webhook bases require an explicit non-production development override", async () => {
  const previousAdmin = process.env.WAHA_ADMIN_SECRET_REFERENCE;
  const previousWebhook = process.env.PUBLIC_WEBHOOK_BASE_URL;
  const previousOverride = process.env.ALLOW_INSECURE_WEBHOOK_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.WAHA_ADMIN_SECRET_REFERENCE = "secret://platform/waha/admin";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "http://control-api:3001";
  process.env.NODE_ENV = "test";
  delete process.env.ALLOW_INSECURE_WEBHOOK_URL;
  let storeAttempts = 0;
  let stagedOperation;
  const controller = new ConnectionsController(
    { rows: async () => [],withTenant:async(_tenant,callback)=>callback({query:async(sql,values=[])=>{
      if(sql.includes("INSERT INTO connection_operations")){
        stagedOperation=operation({connection_id:values[1],idempotency_key:values[2],payload:values[3],state:"STAGED"});
        return{rows:[stagedOperation],rowCount:1};
      }
      if(sql.includes("SELECT * FROM connection_operations"))return{rows:[stagedOperation],rowCount:1};
      return{rows:[],rowCount:1};
    }}) },
    { storeWebhookSecret: async () => { storeAttempts++; throw new Error("stop after configuration validation"); } },
    { wakeConnection: async () => undefined },
  );
  const input = {
    name: "Development line",
    provider: "WAHA",
    disclosureAccepted: true,
    disclosureVersion: "2026-08-09",
  };
  try {
    await assert.rejects(
      () => controller.create(request, "insecure-default-rejected", input),
      (error) => error?.message === "The public webhook URL is invalid",
    );
    assert.equal(storeAttempts, 0);
    process.env.ALLOW_INSECURE_WEBHOOK_URL = "true";
    await assert.rejects(
      () => controller.create(request, "insecure-dev-allowed", input),
      (error) => error?.message.startsWith("The secret manager is temporarily unavailable"),
    );
    assert.equal(storeAttempts, 1);
    process.env.NODE_ENV = "production";
    await assert.rejects(
      () => controller.create(request, "insecure-production-rejected", input),
      (error) => error?.message === "The public webhook URL is invalid",
    );
    assert.equal(storeAttempts, 1);
  } finally {
    restore("WAHA_ADMIN_SECRET_REFERENCE", previousAdmin);
    restore("PUBLIC_WEBHOOK_BASE_URL", previousWebhook);
    restore("ALLOW_INSECURE_WEBHOOK_URL", previousOverride);
    restore("NODE_ENV", previousNodeEnv);
  }
});

test("lifecycle route metadata requires 202 and elevated disconnect permission", () => {
  for (const method of ["create", "start", "restart", "pause", "disconnect", "syncGroups"]) {
    assert.equal(Reflect.getMetadata("__httpCode__", ConnectionsController.prototype[method]), 202);
  }
  assert.equal(Reflect.getMetadata("__httpCode__", ConnectionsController.prototype.rotateMetaCredential), 200);
  assert.equal(Reflect.getMetadata("wasalx:permission", ConnectionsController.prototype.rotateMetaCredential), "connection:write");
  assert.equal(Reflect.getMetadata("wasalx:permission", ConnectionsController.prototype.disconnect), "connection:disconnect");
});

test("secret provisioning uses authenticated write and idempotent delete sidecar APIs", async () => {
  const requests = [];
  const server = createServer(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    requests.push({
      url: incoming.url,
      authorization: incoming.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(incoming.url === "/v1/delete" ? 404 : 204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previousUrl = process.env.SECRET_SIDECAR_URL;
  const previousToken = process.env.SECRET_SIDECAR_TOKEN;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.SECRET_SIDECAR_URL = `http://127.0.0.1:${address.port}`;
  process.env.SECRET_SIDECAR_TOKEN = "sidecar-test-token";
  process.env.NODE_ENV = "test";
  const service = new SecretProvisioningService();
  try {
    await service.storeWebhookSecret("secret://tenant/connections/id/webhook", {
      routeToken: "r".repeat(48),
      hmacKey: "h".repeat(64),
    });
    await service.storeMetaCredential("secret://tenant/connections/id/meta", {
      accessToken: "meta-system-user-token-with-enough-entropy",
    });
    await service.deleteSecret("secret://tenant/connections/id/webhook");
    assert.deepEqual(requests, [
      {
        url: "/v1/store",
        authorization: "Bearer sidecar-test-token",
        body: {
          reference: "secret://tenant/connections/id/webhook",
          value: { routeToken: "r".repeat(48), hmacKey: "h".repeat(64) },
        },
      },
      {
        url: "/v1/store",
        authorization: "Bearer sidecar-test-token",
        body: {
          reference: "secret://tenant/connections/id/meta",
          value: { accessToken: "meta-system-user-token-with-enough-entropy" },
        },
      },
      {
        url: "/v1/delete",
        authorization: "Bearer sidecar-test-token",
        body: { reference: "secret://tenant/connections/id/webhook" },
      },
    ]);
  } finally {
    service.onModuleDestroy();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    restore("SECRET_SIDECAR_URL", previousUrl);
    restore("SECRET_SIDECAR_TOKEN", previousToken);
    restore("NODE_ENV", previousNodeEnv);
  }
});

test("connection drain has its own queue and signed authorization scope", async () => {
  const source = await readFile(new URL("../services/control-api/src/tenant-drain.service.ts", import.meta.url), "utf8");
  assert.match(source, /new Queue\("wasalx-connection-drain"/);
  assert.match(source, /wakeConnection\(tenantId:string\).*"connection:drain"/);
  assert.match(source, /\.setIssuer\("wasalx-control"\)/);
  assert.match(source, /\.setAudience\("wasalx-connector-worker"\)/);
});

test("connection detail exposes only the assigned WAHA worker key", async () => {
  const source = await readFile(
    new URL("../services/control-api/src/connections.controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /ww\.worker_key AS worker_id/u);
  assert.match(source, /LEFT JOIN LATERAL app\.current_waha_session_runtime\(ps\.id\) ww ON true/u);
  assert.doesNotMatch(source, /JOIN waha_workers/u);
  assert.doesNotMatch(source, /ww\.base_url AS worker_id/u);
  assert.doesNotMatch(source, /ww\.secret_reference AS worker_id/u);
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}


// No provider call below runs under a database transaction; all SQL seams remain explicit.
for (const [method, mode] of [
  ["start", "fresh"], ["restart", "fresh"], ["start", "secret-drift"],
  ["restart", "session-drift"], ["start", "duplicate"], ["restart", "raced-replay"],
  ["start", "verification-rejected"],
]) test(`Meta ${method} admission verifies outside locks and preserves ${mode}`, async () => {
  const connectionId = "40000000-0000-4000-8000-000000000044";
  const reference = `secret://${tenantId}/connections/${connectionId}/meta`;
  const accessToken = "synthetic-current-activation-meta-token";
  const state = method === "start" ? "PAUSED" : "WORKING";
  const type = method.toUpperCase();
  const key = `meta-${method}-${mode}`;
  const existing = operation({ connection_id: connectionId, operation_type: type,
    idempotency_key: key, provider: "META", connection_state: state, payload: {} });
  const writes = [], order = [], wakes = [];
  let active = false, transactions = 0, operationReads = 0, created;
  const database = {
    withTenant: async (actualTenant, callback) => {
      assert.equal(actualTenant, tenantId); assert.equal(active, false);
      active = true; transactions++;
      try { return await callback({ query: async (sql, values = []) => {
        if (sql.includes("SELECT o.*")) {
          operationReads++;
          return { rows: mode === "duplicate" || (mode === "raced-replay" && operationReads === 3) ? [existing] : [] };
        }
        if (sql.startsWith("SELECT provider,state FROM connections")) return { rows: [{ provider: "META", state }] };
        if (sql.startsWith("SELECT id,name,provider,state")) return { rows: [{ id: connectionId, name: "Official", provider: "META", state, action_reason: null, disclosure_version: null }] };
        if (sql.startsWith("SELECT id FROM connection_operations") || sql.startsWith("SELECT id,operation_type FROM connection_operations")) return { rows: [] };
        if(sql.includes("app.meta_lifecycle_guard")){assert.equal(values[5],0);return{rows:[{revision_matches:true,blocked:false,unresolved_hold:false}],rowCount:1};}
      if (sql.startsWith("SELECT c.secret_reference")) return { rows: [{ secret_reference: mode === "secret-drift" && transactions === 2 ? reference + "/rotations/new" : reference, provider: "META", state }] };
        if (sql.startsWith("SELECT id,opaque_session_id,provider_state_data")) return { rows: [sampleSession(mode === "session-drift" && transactions === 2 ? "52000000-0000-4000-8000-000000000099" : metaSessionId)] };
        if (sql === "SELECT clock_timestamp()::text AS value") return { rows: [{ value: "2026-10-07T12:00:00.000000Z" }] };
        if (sql.includes("INSERT INTO connection_operations")) {
          assert.deepEqual(values.slice(0, 4), [tenantId, connectionId, type, key]);
          assert.equal(values[4].metaBinding.secretReference, reference);
          created = operation({ ...existing, payload: values[4] }); writes.push({ sql, values });
          return { rows: [created], rowCount: 1 };
        }
        if (sql.includes("UPDATE provider_sessions") && sql.includes("jsonb_build_object('metaAccountProof'")) {
          writes.push({ sql, values }); return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE connections SET state=$1") || sql.includes("UPDATE webhook_routes") || sql.includes("INSERT INTO audit_events")) {
          writes.push({ sql, values }); return { rows: [], rowCount: 1 };
        }
        assert.fail(`unexpected activation SQL: ${sql}`);
      } }); } finally { active = false; }
    },
  };
  const controller = controllerFixture(database, {}, { wakeConnection: async actualTenant => { assert.equal(active, false); wakes.push(actualTenant); } }, {
    create: (token, phone) => {
      assert.equal(active, false); assert.equal(token, accessToken); assert.equal(phone, "123456789");
      return {
        verifyCredentialMetadata: async (appId, appSecret) => {
          assert.equal(active, false); order.push("metadata");
          if (mode === "verification-rejected") throw new MetaGraphClientError("META_CREDENTIAL_METADATA_INVALID", "Meta credentials could not be verified for the configured application.", false, undefined, true);
          return sampleCredentialMetadata(appId, appSecret);
        },
        verifyPhoneAccountRelationship: async waba => { assert.equal(active, false); assert.equal(waba, "987654321"); order.push("relation"); return sampleRelation(); },
      };
    },
  }, {
    resolveHmac: async (selected, policy) => { assert.equal(active, false); assert.equal(selected, metaAppReference); assert.deepEqual(policy, { kind: "exact", expectedReference: metaAppReference }); order.push("app"); return metaAppSecret; },
  }, {
    resolveAccessToken: async (selected, policy) => { assert.equal(active, false); assert.equal(selected, reference); assert.deepEqual(policy, { tenantId, connectionId }); order.push("subject"); return accessToken; },
  });
  if (mode === "verification-rejected") {
    await assert.rejects(() => controller[method](request, connectionId, key), BadRequestException);
    assert.deepEqual(order, ["subject", "app", "metadata"]);
    assert.equal(transactions, 1); assert.equal(writes.length, 0); assert.equal(wakes.length, 0);
  } else if (mode.endsWith("drift")) {
    await assert.rejects(() => controller[method](request, connectionId, key), ConflictException);
    assert.deepEqual(order, ["subject", "app", "metadata", "relation"]);
    assert.equal(writes.length, 0); assert.equal(wakes.length, 0);
  } else {
    const result = await controller[method](request, connectionId, key);
    assert.equal(result.duplicate, mode !== "fresh");
    assert.deepEqual(wakes, [tenantId]);
    if (mode === "duplicate") { assert.equal(writes.length, 0); assert.deepEqual(order, []); }
    else if (mode === "raced-replay") { assert.equal(writes.length, 0); assert.deepEqual(order, ["subject", "app", "metadata", "relation"]); assert.equal(operationReads, 3); }
    else {
      assert.deepEqual(order, ["subject", "app", "metadata", "relation"]);
      const proof = JSON.parse(writes.find(({ sql }) => sql.includes("UPDATE provider_sessions")).values[3]);
      assert.equal(proof.credentialMetadata.appId, metaAppId);
      assert.equal(proof.credentialFingerprint, createHash("sha256").update(accessToken).digest("hex"));
      assert.equal(proof.operationId, created.id); assert.equal(proof.providerSessionId, metaSessionId);
      assert.equal(proof.secretReference, reference);
      assert.doesNotMatch(JSON.stringify(writes), /synthetic-current-activation-meta-token|synthetic-configured-meta-app-secret/u);
    }
  }
});

function lifecycleState({revision=1,blocked=true,recovery=false}={}){
  recovery=recovery||!blocked;
  const negative={event:"ACCOUNT_OFFBOARDED",observedAt:"2026-10-07T00:00:00.000Z",payloadSha256:"a".repeat(64)};
  const recovered={event:"ACCOUNT_RECONNECTED",observedAt:"2026-10-07T01:00:00.000Z",payloadSha256:"b".repeat(64)};
  const stamp=recovery?recovered:negative;
  return{schemaVersion:1,revision,lastObservedAt:stamp.observedAt,lastEvent:stamp.event,lastPayloadSha256:stamp.payloadSha256,
    reasonStates:[{reason:"ACCOUNT_OFFBOARDED",negative,...(recovery?{recovery:recovered}:{}),...(!blocked?{clearedThrough:recovered}:{}),blocked}]};
}

test("Meta explicit activation requires all authoritative recovery and current pending-free revision",async()=>{
  const connectionId=operation().connection_id;const ref=`secret://${tenantId}/connections/${connectionId}/meta`;
  for(const kind of ["clear","recovered","no-recovery","pending","changed","null"]){
    const lifecycle=kind==="clear"?undefined:kind==="null"?null:lifecycleState({recovery:kind!=="no-recovery"});
    let providerCalls=0;const queries=[];
    const database={withTenant:async(_tenant,callback)=>callback({query:async(sql,values=[])=>{
      queries.push({sql,values});
      if(sql.includes("app.meta_add_access_activation_held")){assert.deepEqual(values,[tenantId,connectionId]);return{rows:[{held:false}],rowCount:1};}
      if(sql.includes("SELECT o.*")||sql.startsWith("SELECT id FROM connection_operations"))return{rows:[]};
      if(sql.startsWith("SELECT provider,state"))return{rows:[{provider:"META",state:"ACTION_REQUIRED"}]};
      if(sql.startsWith("SELECT c.secret_reference"))return{rows:[{secret_reference:ref,provider:"META",state:"ACTION_REQUIRED"}]};
      if(sql.startsWith("SELECT id,opaque_session_id"))return{rows:[{...sampleSession(),provider_state_data:{wabaId:"987654321",...(lifecycle===undefined?{}:{metaLifecycle:lifecycle})}}]};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:kind!=="changed",blocked:lifecycle!==undefined,unresolved_hold:kind==="pending"}],rowCount:1};
      assert.fail("unexpected activation query");
    }})};
    const controller=new ConnectionsController(database,{}, {},{create:(_token,_phone,beforeRequest)=>({
      verifyCredentialMetadata:async()=>{await beforeRequest();providerCalls++;return sampleCredentialMetadata();},
      verifyPhoneAccountRelationship:async()=>{await beforeRequest();providerCalls++;return sampleRelation();},
    })},{resolveHmac:async()=>metaAppSecret},{resolveAccessToken:async()=>"synthetic-meta-token-with-enough-entropy"});
    const promise=controller.prepareMetaActivation(tenantId,connectionId,"explicit-recovery","START");
    if(["clear","recovered"].includes(kind)){
      const activation=await promise;assert.equal(providerCalls,2);assert.equal(activation.lifecycleRevision,kind==="clear"?0:1);
      assert.deepEqual(activation.recovery,kind==="clear"?undefined:{expectedRevision:1,reasons:["ACCOUNT_OFFBOARDED"]});
      if(lifecycle)assert.equal(lifecycle.reasonStates[0].blocked,true,"diagnostic verification does not clear restriction");
    }else{await assert.rejects(promise);assert.equal(providerCalls,0);}
    assert.equal(queries.some(q=>/^(UPDATE|INSERT)/u.test(q.sql)),false);
  }
});
