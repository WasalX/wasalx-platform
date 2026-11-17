import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  NotFoundException,
  ServiceUnavailableException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import {
  HttpMetaGroupsClient,
  MetaGraphClientError,
} from "../services/control-api/dist/meta-groups.client.js";
import { MetaGroupsController } from "../services/control-api/dist/meta-groups.controller.js";
import { MetaGroupsService } from "../services/control-api/dist/meta-groups.service.js";

test("control-api maps provider 131030 to a safe terminal TEST-recipient error",async t=>{
  const old=globalThis.fetch;let calls=0;t.after(()=>{globalThis.fetch=old});
  globalThis.fetch=async()=>{calls++;return Response.json({error:{code:131030,type:"OAuthException",message:"private provider diagnostic"}},{status:400})};
  const client=new HttpMetaGroupsClient(new URL("https://graph.test"),"v24.0","synthetic-token-1234567890","123456789");
  await assert.rejects(client.verifyPhoneNumber(),error=>{
    assert.equal(error.code,"META_TEST_RECIPIENT_NOT_ALLOWED");assert.equal(error.retryable,false);assert.equal(error.outcomeKnown,true);
    assert.match(error.safeError,/test number.*131030/);assert.doesNotMatch(error.safeError,/private provider diagnostic/);return true;
  });
  assert.equal(calls,1);
});

const tenantId = "10000000-0000-4000-8000-000000000001";
const connectionId = "40000000-0000-4000-8000-000000000001";
const groupId = "60000000-0000-4000-8000-000000000001";
const request = {
  id: "request-meta-groups-1",
  principal: {
    subject: "operator-1",
    userId: "20000000-0000-4000-8000-000000000001",
    tenantId,
    email: "operator@example.test",
    displayName: "Operator",
    role: "tenant_admin",
  },
};

function action(overrides = {}) {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    connection_id: connectionId,
    whatsapp_group_id: null,
    external_group_id: null,
    action_type: "CREATE_GROUP",
    request_sha256: "a".repeat(64),
    state: "RUNNING",
    provider_request_id: null,
    safe_error: null,
    expires_at: "2026-08-09T01:00:00.000Z",
    ...overrides,
  };
}

function databaseHarness(options = {}) {
  const writes = [];
  let actionReads = 0;
  const client = {
    async query(sql, values = []) {
      writes.push({ sql, values });
      if (sql.includes("FROM meta_group_actions") && sql.includes("FOR UPDATE")) {
        actionReads++;
        return { rows: options.replay && actionReads === 1 ? [options.replay] : [] };
      }
      if (sql.includes("/* meta_api_credential_context_current */")) {
        return { rows: [{ current: options.currentContext !== false }], rowCount: 1 };
      }
      if(sql.includes("app.meta_lifecycle_guard")){
        const revision=options.lifecycle?.revision??0;
        assert.deepEqual(values,[connectionId,"71000000-0000-4000-8000-000000000001","123456789","987654321",process.env.META_APP_ID??"",revision]);
        return{rows:options.missingLifecycleGuard?[]:[{revision_matches:options.lifecycleCurrent!==false,blocked:options.lifecycleBlocked===true,unresolved_hold:options.pendingLifecycle===true}],rowCount:options.missingLifecycleGuard?0:1};
      }
      if (sql.includes("FROM connections c")) {
        return {
          rows: [{
            id: connectionId,
            provider: "META",
            state: "WORKING",
            secret_reference: `secret://${tenantId}/connections/${connectionId}/meta`,
            disclosure_version: options.noConsent ? null : "meta-groups-2026-08-09",
            opaque_session_id: "123456789",
            provider_session_state: "WORKING",
            ownership_state: "ACTIVE",
            provider_session_id: "71000000-0000-4000-8000-000000000001",
            waba_id: "987654321",
            meta_account_proof: options.proof ?? null,
            meta_lifecycle_present:Object.hasOwn(options,"lifecycle"),meta_lifecycle:options.lifecycle,
          }],
        };
      }
      if (sql.includes("FROM whatsapp_groups")) {
        return {
          rows: options.groupMissing
            ? []
            : [{ id: groupId, external_group_id: "official_group_1", connection_id: connectionId }],
        };
      }
      if (sql.includes("INSERT INTO meta_group_actions")) {
        return {
          rows: [action({
            whatsapp_group_id: values[2],
            external_group_id: values[3],
            action_type: values[4],
            request_sha256: values[6],
          })],
        };
      }
      if (sql.includes("UPDATE meta_group_actions") && sql.includes("state='SUCCEEDED'")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE meta_group_actions") && sql.includes("SET state=$1")) {
        options.failures?.push({ state: values[0], code: values[1], safeError: values[2] });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    writes,
    database: {
      async withTenant(actualTenant, callback) {
        assert.equal(actualTenant, tenantId);
        return callback(client);
      },
    },
  };
}

test("Groups consent is connection scoped and denies provider access, including bearer invite links", async () => {
  const harness = databaseHarness({ noConsent: true });
  const groups = new MetaGroupsService(harness.database,
    { resolveAccessToken: async () => assert.fail("no credential resolution without Groups consent") },
    { create: () => assert.fail("no provider access without Groups consent") });
  const capability = await groups.capability(request, connectionId);
  assert.equal(capability.eligible, false);
  assert.equal(capability.state, "CONSENT_REQUIRED");
  assert.equal(capability.evidence, "local_policy");
  for (const action of [
    () => groups.createGroup(request, connectionId, "denied-create", { subject: "New" }),
    () => groups.getInviteLink(request, connectionId, groupId),
    () => groups.resetInviteLink(request, connectionId, groupId, "denied-reset"),
    () => groups.updateGroup(request, connectionId, groupId, "denied-update", { subject: "Changed" }),
  ]) await assert.rejects(action, /Accept the official Groups constraints/);
  assert.equal(harness.writes.some(w => w.sql.includes("INSERT INTO meta_group_actions")), false);
});

function eligibleClient(overrides = {}) {
  return {
    capability: async () => ({ eligible: true, state: "AVAILABLE", evidence: "provider_probe" }),
    createGroup: async () => ({ requestId: "meta-request-1" }),
    getInviteLink: async () => ({ inviteLink: "https://chat.whatsapp.com/AbCdEf123456" }),
    resetInviteLink: async () => ({ inviteLink: "https://chat.whatsapp.com/XyZ987654321" }),
    updateGroup: async () => ({ updated: true }),
    ...overrides,
  };
}

function service(harness, providerClient) {
  return new MetaGroupsService(
    harness.database,
    { resolveAccessToken: async (reference, owner) => {
      assert.equal(reference, `secret://${tenantId}/connections/${connectionId}/meta`);
      assert.deepEqual(owner,{tenantId,connectionId});
      return "meta-system-user-token-with-enough-entropy";
    } },
    { create: (token, phoneNumberId, beforeRequest) => {
      assert.equal(token, "meta-system-user-token-with-enough-entropy");
      assert.equal(phoneNumberId, "123456789");
      return Object.fromEntries(Object.entries(providerClient).map(([name, value]) => [name,
        typeof value === "function" ? async (...args) => { await beforeRequest(); return value.apply(providerClient, args); } : value,
      ]));
    } },
  );
}

test("official Meta group creation reserves an idempotent tenant action before calling Graph", async () => {
  const harness = databaseHarness();
  const result = await service(harness, eligibleClient()).createGroup(
    request,
    connectionId,
    "meta-create-1",
    { subject: "Operations pod", description: "Client operations", joinApprovalMode: "approval_required" },
  );
  assert.equal(result.requestId, "meta-request-1");
  assert.equal(result.duplicate, false);
  assert.equal(result.actionId, "70000000-0000-4000-8000-000000000001");
  assert.ok(harness.writes.some(({ sql }) => sql.includes("INSERT INTO meta_group_actions")));
  assert.ok(harness.writes.some(({ sql }) => sql.includes("state='SUCCEEDED'")));
  assert.ok(harness.writes.some(({ sql }) => sql.includes("INSERT INTO audit_events")));
  assert.doesNotMatch(JSON.stringify(harness.writes), /meta-system-user-token-with-enough-entropy/);
  assert.doesNotMatch(JSON.stringify(harness.writes), /chat\.whatsapp\.com/);
});

test("successful create replay returns the provider request ID without a second Graph mutation", async () => {
  let providerCalls = 0;
  const input = { subject: "Operations pod" };
  // Compute the same digest by allowing a first reservation to expose it.
  const first = databaseHarness();
  await service(first, eligibleClient({ createGroup: async () => { providerCalls++; return { requestId: "meta-request-1" }; } })).createGroup(
    request,
    connectionId,
    "meta-create-replay",
    input,
  );
  const inserted = first.writes.find(({ sql }) => sql.includes("INSERT INTO meta_group_actions"));
  const replay = action({
    request_sha256: inserted.values[6],
    state: "SUCCEEDED",
    provider_request_id: "meta-request-1",
  });
  const second = databaseHarness({ replay });
  const result = await service(second, eligibleClient({ createGroup: async () => { providerCalls++; return { requestId: "duplicate" }; } })).createGroup(
    request,
    connectionId,
    "meta-create-replay",
    input,
  );
  assert.equal(result.duplicate, true);
  assert.equal(result.requestId, "meta-request-1");
  assert.equal(providerCalls, 1);
});

test("ambiguous invite-link reset is fenced as OUTCOME_UNKNOWN and never leaks provider detail", async () => {
  const failures = [];
  const harness = databaseHarness({ failures });
  await assert.rejects(
    () => service(harness, eligibleClient({
      resetInviteLink: async () => {
        throw new MetaGraphClientError(
          "META_NETWORK",
          "provider body with secret detail",
          true,
          undefined,
          false,
        );
      },
    })).resetInviteLink(request, connectionId, groupId, "meta-reset-1"),
    ServiceUnavailableException,
  );
  assert.equal(failures[0].state, "OUTCOME_UNKNOWN");
  assert.equal(failures[0].code, "META_NETWORK");
  assert.doesNotMatch(failures[0].safeError, /secret detail/);
});

test("Meta group actions reject a group outside the connection tenant scope", async () => {
  const harness = databaseHarness({ groupMissing: true });
  await assert.rejects(
    () => service(harness, eligibleClient()).updateGroup(
      request,
      connectionId,
      groupId,
      "meta-update-cross-tenant",
      { subject: "Escalations" },
    ),
    NotFoundException,
  );
});

test("Meta group API route permissions and durable schema are fail closed", async () => {
  assert.equal(
    Reflect.getMetadata("wasalx:permission", MetaGroupsController.prototype.capability),
    "connection:read",
  );
  assert.equal(
    Reflect.getMetadata("wasalx:permission", MetaGroupsController.prototype.create),
    "group:write",
  );
  assert.equal(Reflect.getMetadata("__httpCode__", MetaGroupsController.prototype.create), 202);

  const sql = await readFile(
    new URL("../services/control-api/migrations/0016_meta_group_actions.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE meta_group_actions/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /OUTCOME_UNKNOWN/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, whatsapp_group_id\)/);
  assert.doesNotMatch(sql, /access_token|invite_link text|request_body/i);
  assert.match(sql, /CONNECTION_CREDENTIAL/);
});

test("capability claims remain fail closed when provider proof is absent", async () => {
  const harness = databaseHarness();
  const result = await service(harness, eligibleClient({
    capability: async () => ({
      eligible: false,
      state: "NOT_ELIGIBLE",
      reasonCode: "META_GROUPS_UNAVAILABLE",
      evidence: "provider_probe",
    }),
  })).capability(request, connectionId);
  assert.equal(result.eligible, false);
  assert.equal(result.evidence, "provider_probe");
});

test("invalid Meta capability moves the connection and active session to action required", async () => {
  const harness = databaseHarness();
  const result = await service(harness, eligibleClient({
    capability: async () => ({
      eligible: false,
      state: "CREDENTIAL_INVALID",
      reasonCode: "META_AUTHENTICATION_FAILED",
      evidence: "provider_probe",
    }),
  })).capability(request, connectionId);
  assert.equal(result.state, "CREDENTIAL_INVALID");
  assert.ok(harness.writes.some(({ sql }) => sql.includes("UPDATE connections") && sql.includes("ACTION_REQUIRED")));
  assert.ok(harness.writes.some(({ sql }) => sql.includes("UPDATE provider_sessions") && sql.includes("CREDENTIAL_INVALID")));
  assert.doesNotMatch(JSON.stringify(harness.writes), /meta-system-user-token-with-enough-entropy/);
});

test("control-plane Meta client keeps known rejections distinct from ambiguous mutations", async (t) => {
  const originalFetch = globalThis.fetch;
  const client = () => new HttpMetaGroupsClient(
    new URL("https://graph.test"),
    "v24.0",
    "meta-system-user-token-with-enough-entropy",
    "123456789",
  );
  try {
    await t.test("credential verification binds the token to the configured phone number", async () => {
      globalThis.fetch = async (url) => {
        assert.match(String(url), /\/v24\.0\/123456789\?fields=id$/u);
        return new Response(JSON.stringify({ id: "123456789" }), { status: 200 });
      };
      await client().verifyPhoneNumber();
      globalThis.fetch = async () => new Response(JSON.stringify({ id: "987654321" }), { status: 200 });
      await assert.rejects(
        () => client().verifyPhoneNumber(),
        (error) =>
          error instanceof MetaGraphClientError &&
          error.outcomeKnown &&
          error.code === "META_INVALID_RESPONSE",
      );
    });
    await t.test("non-retryable 4xx is a known rejection", async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: { code: 100, message: "sensitive diagnostic" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      await assert.rejects(
        () => client().createGroup({ subject: "Operations" }),
        (error) =>
          error instanceof MetaGraphClientError &&
          error.outcomeKnown &&
          !error.retryable &&
          error.code === "META_GROUPS_UNAVAILABLE" &&
          !error.safeError.includes("sensitive diagnostic"),
      );
    });
    await t.test("retryable 5xx is ambiguous", async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: { code: 2 } }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
      await assert.rejects(
        () => client().createGroup({ subject: "Operations" }),
        (error) =>
          error instanceof MetaGraphClientError &&
          !error.outcomeKnown &&
          error.retryable &&
          error.code === "META_SERVER_ERROR",
      );
    });
    await t.test("Graph rate limit on HTTP 400 is retryable and ambiguous", async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ error: { code: 613 } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
      await assert.rejects(
        () => client().createGroup({ subject: "Operations" }),
        (error) =>
          error instanceof MetaGraphClientError &&
          !error.outcomeKnown &&
          error.retryable &&
          error.code === "META_RATE_LIMITED",
      );
    });
    await t.test("malformed successful mutation response is ambiguous", async () => {
      globalThis.fetch = async () => new Response("not-json", { status: 200 });
      await assert.rejects(
        () => client().resetInviteLink("Y2FwaV9ncm91cDoxMjM0NTY="),
        (error) =>
          error instanceof MetaGraphClientError &&
          !error.outcomeKnown &&
          error.code === "META_INVALID_RESPONSE",
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function apiMetadataProof(overrides={}){
  const proof={schemaVersion:1,claim:"PHONE_ACCOUNT_RELATION_VERIFIED",tenantId,connectionId,
    secretReference:`secret://${tenantId}/connections/${connectionId}/meta`,providerSessionId:"71000000-0000-4000-8000-000000000001",
    phoneNumberId:"123456789",wabaId:"987654321",graphVersion:"v24.0",verifiedAt:"2026-10-07T00:00:00.000Z",responseSha256:"a".repeat(64),
    operationId:"op",fencingToken:1,credentialFingerprint:createHash("sha256").update("meta-system-user-token-with-enough-entropy").digest("hex"),
    credentialMetadata:{schemaVersion:1,claim:"CREDENTIAL_METADATA_VERIFIED",appId:"123450987",
      scopes:["whatsapp_business_management","whatsapp_business_messaging"],expiresAt:0,verifiedAt:"2026-10-07T00:00:00.000Z",responseSha256:"b".repeat(64),...overrides}};
  const metadata=proof.credentialMetadata;
  metadata.responseSha256=createHash("sha256").update(JSON.stringify({is_valid:true,app_id:metadata.appId,scopes:metadata.scopes,expires_at:metadata.expiresAt,
    ...(metadata.dataAccessExpiresAt===undefined?{}:{data_access_expires_at:metadata.dataAccessExpiresAt})})).digest("hex");
  return proof;
}

test("expired enabled metadata denies Groups reads and mutations before dispatch",async()=>{
  const original=process.env.META_APP_ID;process.env.META_APP_ID="123450987";
  try{
    const harness=databaseHarness({proof:apiMetadataProof({expiresAt:1})});
    const groups=service(harness,eligibleClient({capability:async()=>assert.fail("no probe"),getInviteLink:async()=>assert.fail("no bearer read"),createGroup:async()=>assert.fail("no mutation")}));
    await assert.rejects(()=>groups.capability(request,connectionId),/invalid or expired/u);
    await assert.rejects(()=>groups.getInviteLink(request,connectionId,groupId),/invalid or expired/u);
    await assert.rejects(()=>groups.createGroup(request,connectionId,"expired-create",{subject:"New"}));
    assert.equal(harness.writes.some(q=>q.sql.includes("state='SUCCEEDED'")),false);
  }finally{if(original===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=original;}
});

test("late old-token capability rejection cannot downgrade rotated active session",async()=>{
  const options={};const harness=databaseHarness(options);
  const groups=service(harness,eligibleClient({capability:async()=>{options.currentContext=false;return{eligible:false,state:"CREDENTIAL_INVALID",evidence:"provider_probe"};}}));
  const result=await groups.capability(request,connectionId);assert.equal(result.state,"CREDENTIAL_INVALID");
  assert.equal(harness.writes.some(q=>q.sql.includes("UPDATE connections")||q.sql.includes("UPDATE provider_sessions")),false);
  assert.ok(harness.writes.some(q=>q.sql.includes("INSERT INTO audit_events")));
});

test("current capability failure updates only original active session",async()=>{
  const harness=databaseHarness();
  await service(harness,eligibleClient({capability:async()=>({eligible:false,state:"CREDENTIAL_INVALID",evidence:"provider_probe"})})).capability(request,connectionId);
  const update=harness.writes.find(q=>q.sql.includes("UPDATE provider_sessions"));
  assert.match(update.sql,/id=\$3/u);assert.deepEqual(update.values,[tenantId,connectionId,"71000000-0000-4000-8000-000000000001"]);
});

test("Groups context fence rejects changed session before provider mutation",async()=>{
  const harness=databaseHarness({currentContext:false});const calls=[];
  const groups=service(harness,eligibleClient({createGroup:async()=>{calls.push("provider");return{requestId:"unexpected"};}}));
  await assert.rejects(()=>groups.createGroup(request,connectionId,"changed-create",{subject:"New"}));assert.deepEqual(calls,[]);
  const check=harness.writes.find(q=>q.sql.includes("/* meta_api_credential_context_current */"));
  assert.deepEqual(check.values,[tenantId,connectionId,`secret://${tenantId}/connections/${connectionId}/meta`,"71000000-0000-4000-8000-000000000001","123456789","987654321","null","meta-groups-2026-08-09",true]);
  assert.match(check.sql,/COALESCE\(ps\.provider_state_data->'metaAccountProof','null'::jsonb\)=\$7::jsonb/u);
  assert.equal(harness.writes.some(q=>q.sql.includes("state='SUCCEEDED'")),false);
});


test("current enabled Groups proof permits its guarded provider read",async()=>{
  const original=process.env.META_APP_ID;process.env.META_APP_ID="123450987";
  try{
    const harness=databaseHarness({proof:apiMetadataProof()});let reads=0;
    const result=await service(harness,eligibleClient({capability:async()=>{reads++;return{eligible:true,state:"AVAILABLE",evidence:"provider_probe"};}})).capability(request,connectionId);
    assert.equal(result.eligible,true);assert.equal(reads,1);
    assert.ok(harness.writes.some(q=>q.sql.includes("/* meta_api_credential_context_current */")));
    assert.doesNotMatch(JSON.stringify(harness.writes),/meta-system-user-token-with-enough-entropy/u);
  }finally{if(original===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=original;}
});

function lifecycleState({revision=1,blocked=true,recovery=false}={}){
  recovery=recovery||!blocked;
  const negative={event:"ACCOUNT_OFFBOARDED",observedAt:"2026-10-07T00:00:00.000Z",payloadSha256:"a".repeat(64)};
  const recovered={event:"ACCOUNT_RECONNECTED",observedAt:"2026-10-07T01:00:00.000Z",payloadSha256:"b".repeat(64)};
  const stamp=recovery?recovered:negative;
  return{schemaVersion:1,revision,lastObservedAt:stamp.observedAt,lastEvent:stamp.event,lastPayloadSha256:stamp.payloadSha256,
    reasonStates:[{reason:"ACCOUNT_OFFBOARDED",negative,...(recovery?{recovery:recovered}:{}),...(!blocked?{clearedThrough:recovered}:{}),blocked}]};
}

test("Meta Groups requests and auth-health updates hold on pending, changed and malformed lifecycle",async()=>{
  for(const options of [{pendingLifecycle:true},{lifecycleCurrent:false},{lifecycleBlocked:true},{lifecycle:lifecycleState()},{lifecycle:null},{missingLifecycleGuard:true}]){
    let providerCalls=0;const failures=[];const harness=databaseHarness({...options,failures});
    await assert.rejects(service(harness,eligibleClient({createGroup:async()=>{providerCalls++;return{requestId:"unexpected"};}})).createGroup(request,connectionId,"lifecycle-held",{subject:"Held"}));
    assert.equal(providerCalls,0);assert.equal(failures.some(f=>f.state==="OUTCOME_UNKNOWN"),false,"no dispatch is a known failure");
    assert.equal(harness.writes.some(q=>q.sql.includes("state='SUCCEEDED'")),false);
  }
});
test("Meta Groups known success remains recorded when signed negative arrives after provider dispatch",async()=>{
  const options={};const harness=databaseHarness(options);
  const result=await service(harness,eligibleClient({createGroup:async()=>{options.pendingLifecycle=true;return{requestId:"actual-known-receipt"};}}))
    .createGroup(request,connectionId,"lifecycle-after-dispatch",{subject:"Actual"});
  assert.equal(result.requestId,"actual-known-receipt");assert.ok(harness.writes.some(q=>q.sql.includes("state='SUCCEEDED'")));
  assert.equal(harness.writes.some(q=>q.sql.startsWith("UPDATE connections")),false);
});
