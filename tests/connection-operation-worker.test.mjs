import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyMetaCredentialMetadata } from "../services/connector-worker/dist/packages/core/src/meta-account-relation.js";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ConnectionOperationProcessor,
  classifyConnectionOperationError,
  mapWahaSessionState,
} from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-processor.js";
import { SecretResolutionError, SidecarSecretResolver } from "../services/connector-worker/dist/services/connector-worker/src/secrets.js";
import { ConnectionOperationRepository, synchronizeGroups } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";
import { ProviderError } from "../services/connector-worker/dist/packages/connectors/src/types.js";

const routeToken = "route_token_abcdefghijklmnopqrstuvwxyz_123456";
const tenantId = "10000000-0000-4000-8000-000000000001";
const connectionId = "12000000-0000-4000-8000-000000000001";
const webhookSecretReference = `secret://${tenantId}/connections/${connectionId}/webhook`;
const metaSecretReference = `secret://${tenantId}/connections/${connectionId}/meta`;

function operation(operationType, overrides = {}) {
  return {
    id: "51000000-0000-4000-8000-000000000001",
    tenantId,
    connectionId,
    operationType,
    payload: { providerSessionId: "52000000-0000-4000-8000-000000000001" },
    attempts: 1,
    maxAttempts: 8,
    fencingToken: 4,
    provider: "WAHA",
    connectionState: "PROVISIONING",
    connectionSecretReference: "secret://waha-admin",
    engine: "GOWS",
    providerSession: {
      id: "52000000-0000-4000-8000-000000000001",
      opaqueSessionId: "opaque/session one",
      state: "PROVISIONING",
      fencingToken: 2,
    },
    webhookRoute: {
      id: "53000000-0000-4000-8000-000000000001",
      state: "ACTIVE",
      hmacSecretReference: webhookSecretReference,
    },
    ...overrides,
  };
}

function repositoryFor(jobs) {
  const calls = { assign: [], acquire: [], renew: [], complete: [], fail: [] };
  let claimed = false;
  return {
    calls,
    async claim(tenantId, leaseId, limit) {
      calls.claim = { tenantId, leaseId, limit };
      if (claimed) return [];
      claimed = true;
      return jobs;
    },
    async acquireWahaWorkerAssignment(job, leaseForSeconds) {
      const assignment = {
        workerId: "54000000-0000-4000-8000-000000000001",
        workerKey: "test-gows-1",
        engine: "GOWS",
        baseUrl: "https://waha.private.example/",
        secretReference: "secret://waha-admin",
        fencingToken: 7,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
      calls.assign.push({ job, leaseForSeconds, assignment });
      job.providerSession.wahaAssignment = assignment;
      return assignment;
    },
    async acquireProviderSessionLease(job, leaseId, workerIdentity, leaseForSeconds) {
      calls.acquire.push({ job, leaseId, workerIdentity, leaseForSeconds });
      return {
        id: job.providerSession.id,
        workerIdentity,
        fencingToken: 9,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        wahaAssignment: job.providerSession.wahaAssignment,
      };
    },
    async renewLeases(job, leaseId, sessionLease, leaseForSeconds) {
      calls.renew.push({ job, leaseId, sessionLease, leaseForSeconds });
      return { ...sessionLease, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    async complete(job, leaseId, sessionLease, completion) {
      calls.complete.push({ job, leaseId, sessionLease, completion });
    },
    async fail(job, leaseId, sessionLease, failure) {
      calls.fail.push({ job, leaseId, sessionLease, failure });
    },
    async ready() { return true; },
    async close() {},
  };
}

function resolver(overrides = {}) {
  const references = [];
  return {
    references,
    async resolve(reference) {
      references.push(reference);
      if (reference === "secret://waha-admin") return { apiKey: "waha-administrative-key" };
      if (reference === webhookSecretReference) {
        return { hmacKey: "webhook-signing-key-at-least-16", routeToken, ...overrides };
      }
      throw new Error("unexpected secret reference");
    },
  };
}

function processor(repository, secrets, overrides = {}) {
  return new ConnectionOperationProcessor(repository, secrets, {
    wahaBaseUrl: "https://waha.private.example",
    publicWebhookBaseUrl: "https://app.wasalx.example",
    metaGraphVersion: "v24.0",
    metaAppId: "12025550130",
    workerIdentity: "test-worker",
    ...overrides,
  });
}

function exactWahaSession(job, status = "WORKING") {
  return {
    name: job.providerSession.opaqueSessionId,
    status,
    engine: { engine: "GOWS" },
    config: {
      metadata: { connectionId: job.connectionId },
      webhooks: [{
        url: `https://app.wasalx.example/webhooks/waha/${routeToken}`,
        events: ["message", "message.any", "message.edited", "message.revoked", "message.reaction", "poll.vote", "message.ack.group", "session.status"],
        hmac: { key: "webhook-signing-key-at-least-16" },
        retries: { policy: "exponential", delaySeconds: 2, attempts: 15 },
      }],
    },
  };
}

function metaProof() {
  return { schemaVersion: 1, claim: "PHONE_ACCOUNT_RELATION_VERIFIED", tenantId, connectionId,
    phoneNumberId: "123456789", wabaId: "987654321", providerSessionId: "52000000-0000-4000-8000-000000000001",
    secretReference: metaSecretReference, credentialFingerprint: createHash("sha256").update("meta-system-user-access-token-long-enough").digest("hex"),
    graphVersion: "v24.0", verifiedAt: new Date().toISOString(), responseSha256: "a".repeat(64), operationId: "51000000-0000-4000-8000-000000000001", fencingToken: 4,
    credentialMetadata: verifyMetaCredentialMetadata({ data: { is_valid: true, app_id: "12025550130", scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], expires_at: 0 } }, { appId: "12025550130" }) };
}
function metaOperation(operationType, overrides = {}) {
  return operation(operationType, {
    provider: "META",
    connectionSecretReference: metaSecretReference,
    disclosureVersion: "meta-groups-2026-08-09",
    engine: "CLOUD_API",
    providerSession: {
      id: "52000000-0000-4000-8000-000000000001",
      opaqueSessionId: "123456789",
      state: "PROVISIONING",
      fencingToken: 2,
      providerStateData: { wabaId: "987654321", eligibility: "UNVERIFIED", metaAccountProof: metaProof() },
    },
    webhookRoute: {
      id: "53000000-0000-4000-8000-000000000001",
      state: "PAUSED",
      hmacSecretReference: "secret://platform/meta-webhook",
    },
    payload: {
      providerSessionId: "52000000-0000-4000-8000-000000000001",
      request: { wabaId: "987654321" },
    },
    ...overrides,
  });
}

test("Meta activation preserves verified app metadata and blocks expiration before subscription", async () => {
  const job = metaOperation("START", {disclosureVersion:null});
  const repository = repositoryFor([job]); let calls = 0;
  const result = await withFetch(async () => {
    calls++;
    job.providerSession.providerStateData.metaAccountProof.credentialMetadata.expiresAt = 1;
    return Response.json({data:[{id:"123456789"}]});
  }, () => processor(repository, metaResolver()).drainTenant(tenantId));
  assert.equal(calls, 1, "expired credential must not subscribe after membership lookup");
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.fail[0].failure.code, "META_CREDENTIAL_METADATA_INVALID");
  assert.equal(repository.calls.complete.length, 0);
});

for (const type of ["PROVISION", "START", "RESTART"]) test(`Meta ${type} rejects legacy missing app proof before any request`, async () => {
  const job = metaOperation(type);
  delete job.providerSession.providerStateData.metaAccountProof.credentialMetadata;
  const repository = repositoryFor([job]);
  const result = await withFetch(async () => assert.fail("unverified activation must not dispatch"),
    () => processor(repository, metaResolver()).drainTenant(tenantId));
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.fail[0].failure.code, "META_CREDENTIAL_METADATA_INVALID");
});

function metaResolver() {
  const references = [];
  return {
    references,
    async resolve(reference) {
      references.push(reference);
      if (reference === metaSecretReference) {
        return { accessToken: "meta-system-user-access-token-long-enough" };
      }
      throw new Error(`unexpected Meta secret reference: ${reference}`);
    },
  };
}

for (const operationType of ["PROVISION", "START", "RESTART", "SYNC_GROUPS"]) test(`saved ADD_ACCESS rejects ${operationType} before any provider request`, async () => {
  const job = metaOperation(operationType);
  if (operationType === "SYNC_GROUPS") {
    // Exercise the purpose fence even if a forged snapshot claims active sync admission.
    job.connectionState = "WORKING"; job.providerSession.state = "WORKING"; job.webhookRoute.state = "ACTIVE";
  }
  job.providerSession.providerStateData.metaSignup = { purpose: "ADD_ACCESS", attemptId: "55000000-0000-4000-8000-000000000001" };
  const repository = repositoryFor([job]);
  const result = await withFetch(async () => assert.fail("saved access must not register, subscribe or call a provider"),
    () => processor(repository, metaResolver()).drainTenant(tenantId));
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.fail[0].failure.code, "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED");
});

for (const scenario of ["new-success", "unknown", "claimed-pending", "claimed-connected", "recovery-start", "owner-mismatch", "blocked-health"]) {
  test(`signup registration and activation fence: ${scenario}`, async () => {
    const job = metaOperation(scenario === "recovery-start" ? "START" : "PROVISION", { disclosureVersion: null });
    job.providerSession.providerStateData.metaSignup = { attemptId: "55000000-0000-4000-8000-000000000001", businessId: "333333333", phoneId: "123456789", wabaId: "987654321", graphVersion: "v24.0" };
    const repository = repositoryFor([job]); let claims = 0, registerCalls = 0, subscribed = 0;
    repository.assertMetaSignupCurrent = async () => {};
    repository.claimMetaSignupRegistration = async () => { claims++; return scenario !== "claimed-pending"; };
    let registered = ["claimed-connected", "recovery-start"].includes(scenario);
    const secrets = { resolve: async () => ({ accessToken: "meta-system-user-access-token-long-enough", registrationPin: "123456" }) };
    const result = await withFetch(async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: "123456789", status: registered ? "CONNECTED" : "PENDING", code_verification_status: "VERIFIED", host_platform: "CLOUD_API", account_mode: "LIVE" }] });
      if (url.pathname === "/v24.0/987654321") return Response.json({ id: "987654321", owner_business: { id: scenario === "owner-mismatch" ? "999999999" : "333333333" } });
      if (url.pathname.endsWith("/owned_whatsapp_business_accounts")) return Response.json({ data: [{ id: "987654321" }] });
      if (url.pathname.endsWith("/register")) {
        registerCalls++; assert.equal(claims, 1, "durable claim precedes the only registration effect");
        assert.deepEqual(JSON.parse(init.body), { messaging_product: "whatsapp", pin: "123456" });
        if (scenario === "unknown") throw new Error("ambiguous transport");
        registered = true; return Response.json({ success: true });
      }
      if (url.pathname.endsWith("/subscribed_apps")) {
        if (init.method === "POST") { subscribed++; return Response.json({ success: true }); }
        return Response.json({ data: [{ whatsapp_business_api_data: { id: "12025550130" } }] });
      }
      if (url.searchParams.get("fields") === "health_status") return Response.json({ health_status: { can_send_message: scenario === "blocked-health" ? "BLOCKED" : "AVAILABLE", entities: [
        { entity_type: "PHONE_NUMBER", id: "123456789", can_send_message: scenario === "blocked-health" ? "BLOCKED" : "AVAILABLE" }, { entity_type: "WABA", id: "987654321", can_send_message: "AVAILABLE" }, { entity_type: "APP", id: "12025550130", can_send_message: "AVAILABLE" },
      ] } });
      if (url.searchParams.get("fields") === "id,is_on_biz_app,platform_type") return Response.json({ id: "123456789", is_on_biz_app: false, platform_type: "CLOUD_API" });
      return Response.json({ display_phone_number: "+12025550131" });
    }, () => processor(repository, secrets).drainTenant(tenantId));
    if (["new-success", "claimed-connected", "recovery-start"].includes(scenario)) {
      assert.equal(result.succeeded, 1); assert.equal(repository.calls.complete[0].completion.result.metaSignupReady, true);
      assert.equal(registerCalls, ["claimed-connected", "recovery-start"].includes(scenario) ? 0 : 1);
    } else {
      assert.equal(result.failedTerminal, 1); assert.equal(repository.calls.complete.length, 0);
      assert.equal(repository.calls.fail[0].failure.retryable, false);
      if (["unknown", "claimed-pending"].includes(scenario)) assert.equal(repository.calls.fail[0].failure.code, "META_SIGNUP_REGISTRATION_UNKNOWN");
      if (scenario !== "blocked-health") assert.equal(subscribed, 0);
      assert.equal(registerCalls, ["unknown", "blocked-health"].includes(scenario) ? 1 : 0);
    }
  });
}

for (const action of ["PROVISION", "START", "RESTART"]) test(`Business app ${action} verifies mode and never registers`, async () => {
  const job = metaOperation(action, { disclosureVersion: null });
  job.providerSession.providerStateData.metaSignup = { attemptId: "55000000-0000-4000-8000-000000000001", businessId: "333333333",
    phoneId: "123456789", wabaId: "987654321", graphVersion: "v24.0", variant: "BUSINESS_APP" };
  const repository = repositoryFor([job]); repository.assertMetaSignupCurrent = async () => {};
  repository.claimMetaSignupRegistration = async () => assert.fail("coexistence must never claim registration");
  const outcome = await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/register")) assert.fail("coexistence must never register");
    if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: "123456789", status: "CONNECTED", host_platform: "CLOUD_API", account_mode: "LIVE" }] });
    if (url.pathname === "/v24.0/987654321") return Response.json({ id: "987654321", owner_business: { id: "333333333" } });
    if (url.pathname.endsWith("/owned_whatsapp_business_accounts")) return Response.json({ data: [{ id: "987654321" }] });
    if (url.pathname.endsWith("/subscribed_apps")) return init.method === "POST" ? Response.json({ success: true }) : Response.json({ data: [{ whatsapp_business_api_data: { id: "12025550130" } }] });
    if (url.searchParams.get("fields") === "health_status") return Response.json({ health_status: { can_send_message: "AVAILABLE", entities: [
      { entity_type: "PHONE_NUMBER", id: "123456789", can_send_message: "AVAILABLE" }, { entity_type: "WABA", id: "987654321", can_send_message: "AVAILABLE" }, { entity_type: "APP", id: "12025550130", can_send_message: "AVAILABLE" },
    ] } });
    if (url.searchParams.get("fields") === "id,is_on_biz_app,platform_type") return Response.json({ id: "123456789", is_on_biz_app: true, platform_type: "CLOUD_API" });
    return Response.json({ display_phone_number: "+12025550131" });
  }, () => processor(repository, metaResolver()).drainTenant(tenantId));
  assert.equal(outcome.succeeded, 1); assert.equal(repository.calls.complete.length, 1);
});

for (const response of ["accepted", "unknown", "malformed", "rejected", "rejection-object", "rejection-array", "rejection-code-only", "rejection-message", "revoked-before-dispatch"]) test(`one-shot app sync ${response} cannot use activation finalization`, async () => {
  const before = process.env.META_COEXISTENCE_ENABLED; process.env.META_COEXISTENCE_ENABLED = "true";
  try {
    const job = metaOperation("SYNC_META_APP", { disclosureVersion: null }), repository = repositoryFor([job]);
    job.providerSession.providerStateData.metaSignup = { variant: "BUSINESS_APP", graphVersion: "v24.0" };
    const claims = new Map(), requests = []; let finished = 0;
    repository.coexistenceRequest = async (_job, _lease, _session, kind, state, requestId) => {
      if (state === "DISPATCH") { assert.equal(claims.get(kind), "CLAIMED"); return response !== "revoked-before-dispatch"; }
      if (state === "CLAIMED") { if (claims.has(kind)) return false; claims.set(kind, state); }
      else { assert.equal(claims.get(kind), "CLAIMED"); claims.set(kind, state); if (state === "ACCEPTED") assert.equal(requestId, "synthetic-request"); }
      return true;
    };
    repository.finishCoexistence = async () => { finished++; };
    const outcome = await withFetch(async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: "123456789", status: "CONNECTED", host_platform: "CLOUD_API", account_mode: "LIVE" }] });
      if (url.pathname.endsWith("/smb_app_data")) {
        const body = JSON.parse(init.body); requests.push(body.sync_type);
        const kind = body.sync_type === "history" ? "history" : "contacts"; assert.equal(claims.get(kind), "CLAIMED");
        if (response === "unknown") throw new Error("synthetic lost response");
        if (response === "malformed") return Response.json({});
        if (response === "rejected") return Response.json({ error: { code: 100, message: "Synthetic documented provider rejection" } }, { status: 400 });
        if (response === "rejection-object") return Response.json({}, { status: 400 });
        if (response === "rejection-array") return Response.json([], { status: 400 });
        if (response === "rejection-code-only") return Response.json({ error: { code: 100 } }, { status: 400 });
        if (response === "rejection-message") return Response.json({ error: { code: 100, message: [] } }, { status: 400 });
        return Response.json({ request_id: "synthetic-request" });
      }
      return Response.json({ id: "123456789", is_on_biz_app: true, platform_type: "CLOUD_API" });
    }, () => processor(repository, metaResolver()).drainTenant(tenantId));
    assert.equal(outcome.succeeded, 1); assert.equal(finished, 1); assert.equal(repository.calls.complete.length, 0);
    assert.deepEqual(requests, response === "revoked-before-dispatch" ? [] : ["accepted", "rejected"].includes(response) ? ["smb_app_state_sync", "history"] : ["smb_app_state_sync"]);
    assert.equal(claims.get("contacts"), response === "accepted" ? "ACCEPTED" : response === "rejected" ? "REJECTED" : "UNKNOWN");
  } finally { if (before === undefined) delete process.env.META_COEXISTENCE_ENABLED; else process.env.META_COEXISTENCE_ENABLED = before; }
});

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("PROVISION resolves both secrets and configures a signed opaque webhook without persisting secret material", async () => {
  const job = operation("PROVISION");
  const repository = repositoryFor([job]);
  const secrets = resolver();
  const calls = [];
  const result = await withFetch(
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(new URL(String(input)).pathname === "/api/sessions" ? { name: "opaque/session one", status: "SCAN_QR_CODE", engine: { engine: "GOWS" } } : exactWahaSession(job, "SCAN_QR_CODE")), {
        status: 200,
      });
    },
    () => processor(repository, secrets).drainTenant(job.tenantId),
  );

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failedRetryable: 0, failedTerminal: 0, leaseLost: 0 });
  assert.deepEqual(secrets.references.sort(), ["secret://waha-admin", webhookSecretReference].sort());
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, "/api/sessions");
  const providerRequest = JSON.parse(calls[0].init.body);
  assert.deepEqual(providerRequest, {
    name: "opaque/session one",
    start: true,
    config: {
      metadata: { connectionId: job.connectionId },
      webhooks: [{
        url: `https://app.wasalx.example/webhooks/waha/${routeToken}`,
        events: ["message", "message.any", "message.edited", "message.revoked", "message.reaction", "poll.vote", "message.ack.group", "session.status"],
        hmac: { key: "webhook-signing-key-at-least-16" },
        retries: { policy: "exponential", delaySeconds: 2, attempts: 15 },
      }],
    },
  });
  const completion = repository.calls.complete[0].completion;
  assert.equal(completion.connectionState, "AWAITING_AUTH");
  assert.equal(completion.providerState, "SCAN_QR_CODE");
  assert.equal(completion.actionReason, "Scan the current QR code to connect WhatsApp.");
  assert.equal(completion.webhookState, "ACTIVE");
  assert.equal(repository.calls.claim.limit, 1);
  assert.equal(JSON.stringify(completion).includes("waha-administrative-key"), false);
  assert.equal(JSON.stringify(completion).includes("webhook-signing-key"), false);
  assert.equal(JSON.stringify(completion).includes(routeToken), false);
});

test("PROVISION reconciles an ambiguous provider create only after exact engine, ownership, and webhook verification",async()=>{
  const job=operation("PROVISION");const repository=repositoryFor([job]);const secrets=resolver();const calls=[];
  const result=await withFetch(async(input,init={})=>{calls.push({url:String(input),init});if(calls.length===1)throw new TypeError("request timed out after provider acceptance");if(new URL(String(input)).pathname.endsWith("/me"))return Response.json({id:"12025550131@s.whatsapp.net",pushName:"Operations"});return Response.json({name:"opaque/session one",status:"WORKING",engine:{engine:"GOWS"},config:{metadata:{connectionId:job.connectionId},webhooks:[{url:`https://app.wasalx.example/webhooks/waha/${routeToken}`,events:["session.status","message.ack.group","poll.vote","message.reaction","message.revoked","message.edited","message.any","message"],hmac:{key:"webhook-signing-key-at-least-16"},retries:{policy:"exponential",delaySeconds:2,attempts:15}}]}})},()=>processor(repository,secrets).drainTenant(job.tenantId));
  assert.deepEqual(result,{claimed:1,succeeded:1,failedRetryable:0,failedTerminal:0,leaseLost:0});
  assert.deepEqual(calls.map(call=>[new URL(call.url).pathname,call.init.method??"GET"]),[["/api/sessions","POST"],["/api/sessions/opaque%2Fsession%20one","GET"],["/api/sessions/opaque%2Fsession%20one","GET"],["/api/sessions/opaque%2Fsession%20one/me","GET"]]);
  const completion=repository.calls.complete[0].completion;
  assert.equal(completion.connectionState,"WORKING");
  assert.equal(completion.providerStateData.provisioningReconciled,true);
  assert.equal(JSON.stringify(completion).includes("webhook-signing-key"),false);
  assert.equal(JSON.stringify(completion).includes(routeToken),false);
});

test("RESTART reconciles an ambiguous mutation against the exact session and engine",async()=>{
  const job=operation("RESTART",{connectionState:"WORKING"});const repository=repositoryFor([job]);const calls=[];
  const result=await withFetch(async(input,init={})=>{calls.push({url:String(input),init});if(calls.length===2)throw new TypeError("restart response was lost");return Response.json(exactWahaSession(job,calls.length===1?"WORKING":"STARTING"))},()=>processor(repository,resolver()).drainTenant(job.tenantId));
  assert.deepEqual(result,{claimed:1,succeeded:1,failedRetryable:0,failedTerminal:0,leaseLost:0});
  assert.deepEqual(calls.map(call=>[new URL(call.url).pathname,call.init.method??"GET"]),[["/api/sessions/opaque%2Fsession%20one","GET"],["/api/sessions/opaque%2Fsession%20one/restart","POST"],["/api/sessions/opaque%2Fsession%20one","GET"],["/api/sessions/opaque%2Fsession%20one","GET"]]);
  const completion=repository.calls.complete[0].completion;
  assert.equal(completion.connectionState,"CONNECTING");
  assert.equal(completion.providerStateData.reconciledAfterConflict,true);
  assert.equal(completion.engine,"GOWS");
});

test("RESTART repairs config drift once and starts only a stopped session",async()=>{
  for(const initialStatus of ["WORKING","STOPPED"]){
    const job=operation("RESTART",{connectionState:initialStatus==="WORKING"?"WORKING":"PAUSED"});const repository=repositoryFor([job]);const calls=[];let lifecycleStatus=initialStatus;
    const result=await withFetch(async(input,init={})=>{
      const path=new URL(String(input)).pathname;const method=init.method??"GET";calls.push([path,method]);
      if(path.endsWith("/me"))return Response.json({id:"12025550131@s.whatsapp.net",pushName:"Operations"});
      if(method==="PUT"){assert.deepEqual(JSON.parse(init.body),{config:exactWahaSession(job,initialStatus).config});return Response.json({})}
      if(path.endsWith("/start")){lifecycleStatus="STARTING";return Response.json({name:job.providerSession.opaqueSessionId,status:lifecycleStatus,engine:{engine:"GOWS"}})}
      const snapshot=exactWahaSession(job,lifecycleStatus);
      if(calls.length===1)snapshot.config.webhooks[0].url="https://app.wasalx.example/webhooks/waha/drifted-route";
      return Response.json(snapshot);
    },()=>processor(repository,resolver()).drainTenant(job.tenantId));
    assert.deepEqual(result,{claimed:1,succeeded:1,failedRetryable:0,failedTerminal:0,leaseLost:0});
    assert.equal(calls.filter(([path,method])=>method==="PUT"&&path==="/api/sessions/opaque%2Fsession%20one").length,1);
    assert.equal(calls.filter(([path])=>path.endsWith("/restart")).length,0);
    assert.equal(calls.filter(([path])=>path.endsWith("/start")).length,initialStatus==="STOPPED"?1:0);
    assert.equal(repository.calls.complete[0].completion.connectionState,initialStatus==="STOPPED"?"CONNECTING":"WORKING");
  }
});

test("failed sessions recover once even when configuration was reconciled", async () => {
  for (const operationType of ["START", "RESTART"]) {
    for (const drift of [false, true]) {
      for (const recovered of [true, false]) {
        const job = operation(operationType, { connectionState: "FAILED" });
        const repository = repositoryFor([job]);
        const calls = [];
        let status = "FAILED";
        await withFetch(async (input, init = {}) => {
          const path = new URL(String(input)).pathname;
          const method = init.method ?? "GET";
          calls.push([path, method]);
          if (method === "PUT") return Response.json({});
          if (path.endsWith("/restart")) status = recovered ? "STARTING" : "FAILED";
          const snapshot = exactWahaSession(job, status);
          if (drift && calls.length === 1) snapshot.config.webhooks[0].url = "https://app.wasalx.example/webhooks/waha/drifted-route";
          return Response.json(snapshot);
        }, () => processor(repository, resolver()).drainTenant(job.tenantId));
        assert.equal(calls.filter(([path]) => path.endsWith("/restart")).length, 1);
        assert.equal(calls.filter(([path]) => path.endsWith("/start")).length, 0);
        assert.equal(calls.filter(([, method]) => method === "POST").length, 1);
        assert.equal(repository.calls.complete.length, recovered ? 1 : 0);
        if (recovered) assert.equal(repository.calls.complete[0].completion.connectionState, "CONNECTING");
        else {
          assert.equal(repository.calls.fail[0].failure.code, "WAHA_SESSION_RECOVERY_FAILED");
          assert.equal(repository.calls.fail[0].failure.retryable, false);
          assert.equal(repository.calls.fail[0].failure.connectionState, "FAILED");
        }
      }
    }
  }
});

test("insecure webhook URLs require an explicit local-development override", () => {
  const repository = repositoryFor([]);
  assert.throws(
    () => processor(repository, resolver(), { publicWebhookBaseUrl: "http://control-api:3001" }),
    /HTTPS URL/,
  );
  assert.doesNotThrow(() => processor(repository, resolver(), {
    publicWebhookBaseUrl: "http://control-api:3001",
    allowInsecureWebhookUrl: true,
  }));
});

test("START, RESTART, and PAUSE map explicit provider states and call the granular lifecycle endpoints", async () => {
  for (const [operationType, endpoint, providerStatus, expectedState] of [
    ["START", "start", "STARTING", "CONNECTING"],
    ["RESTART", "restart", "SCAN_QR_CODE", "AWAITING_AUTH"],
    ["PAUSE", "stop", "STOPPED", "PAUSED"],
  ]) {
    const job = operation(operationType, { connectionState: "WORKING" });
    const repository = repositoryFor([job]);
    const secrets = resolver();
    const calls = [];
    await withFetch(
      async (input, init = {}) => {
        calls.push({ url: String(input), method: init.method ?? "GET" });
        const path=new URL(String(input)).pathname;
        const initialStatus = operationType === "START" && calls.length === 1 ? "STOPPED" : operationType === "RESTART" && calls.length === 1 ? "WORKING" : providerStatus;
        return new Response(JSON.stringify(path.endsWith("/start")||path.endsWith("/restart")||path.endsWith("/stop")?{ name: "opaque/session one", status: providerStatus, engine: { engine: "GOWS" } }:exactWahaSession(job,initialStatus)), {
          status: 200,
        });
      },
      () => processor(repository, secrets).drainTenant(job.tenantId),
    );
    assert.equal(new URL(calls.find((call) => call.url.endsWith(`/${endpoint}`)).url).pathname, `/api/sessions/opaque%2Fsession%20one/${endpoint}`);
    assert.equal(repository.calls.complete[0].completion.connectionState, expectedState);
    assert.deepEqual(secrets.references, operationType==="PAUSE"?["secret://waha-admin"]:["secret://waha-admin",webhookSecretReference]);
    assert.equal(repository.calls.fail.length, 0);
  }
});

test("PROVISION, START, and RESTART fail closed when post-action session reconciliation mismatches",async()=>{
  for(const operationType of ["PROVISION","START","RESTART"]){
    const job=operation(operationType,{connectionState:operationType==="PROVISION"?"PROVISIONING":"WORKING"});
    const repository=repositoryFor([job]);
    const result=await withFetch(async(input,init={})=>{
      if(init.method==="POST")return Response.json({name:job.providerSession.opaqueSessionId,status:"STARTING",engine:{engine:"GOWS"}});
      const session=exactWahaSession(job,"STARTING");
      session.config.metadata.connectionId="12000000-0000-4000-8000-000000000099";
      return Response.json(session);
    },()=>processor(repository,resolver()).drainTenant(job.tenantId));
    assert.equal(result.failedTerminal,1,operationType);
    assert.equal(repository.calls.complete.length,0,operationType);
    assert.equal(repository.calls.fail[0].failure.code,"WAHA_SESSION_RECONCILIATION_MISMATCH",operationType);
    assert.equal(JSON.stringify(repository.calls.fail[0]).includes(routeToken),false,operationType);
  }
});

test("START recreates only an exactly missing session through the real secret resolver boundary", async () => {
  const job = operation("START", { connectionState: "ACTION_REQUIRED" });
  const repository = repositoryFor([job]);
  const secrets = new SidecarSecretResolver("http://secrets.internal", "sidecar-read-token", false, ["secret://waha-admin"]);
  const calls = [];
  const result = await withFetch(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "secrets.internal") {
      const { reference } = JSON.parse(init.body);
      calls.push(["secret", reference]);
      const value = reference === "secret://waha-admin"
        ? { apiKey: "waha-administrative-key" }
        : { hmacKey: "webhook-signing-key-at-least-16", routeToken };
      return Response.json(value);
    }
    calls.push(["provider", url.pathname, init.method ?? "GET"]);
    if (url.pathname === "/api/sessions/opaque%2Fsession%20one" && (init.method ?? "GET") === "GET" && !calls.some((call) => call[1] === "/api/sessions")) {
      return Response.json({ message: "Session not found" }, { status: 404 });
    }
    return Response.json(url.pathname === "/api/sessions" ? { name: "opaque/session one", status: "SCAN_QR_CODE", engine: { engine: "GOWS" } } : exactWahaSession(job, "SCAN_QR_CODE"));
  }, () => processor(repository, secrets).drainTenant(job.tenantId));

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failedRetryable: 0, failedTerminal: 0, leaseLost: 0 });
  assert.deepEqual(calls, [
    ["secret", "secret://waha-admin"],
    ["secret", webhookSecretReference],
    ["provider", "/api/sessions/opaque%2Fsession%20one", "GET"],
    ["provider", "/api/sessions", "POST"],
    ["provider", "/api/sessions/opaque%2Fsession%20one", "GET"],
  ]);
  assert.equal(repository.calls.complete[0].completion.connectionState, "AWAITING_AUTH");
  assert.equal(repository.calls.fail.length, 0);
  assert.equal(JSON.stringify(repository.calls.complete[0]).includes(routeToken), false);
});

test("START does not recreate a session after ambiguous or non-missing failures", async () => {
  for (const failure of ["ambiguous", "unauthorized"]) {
    const job = operation("START", { connectionState: "ACTION_REQUIRED" });
    const repository = repositoryFor([job]);
    const secrets = new SidecarSecretResolver("http://secrets.internal", "sidecar-read-token", false, ["secret://waha-admin"]);
    const providerCalls = [];
    const secretReferences = [];
    await withFetch(async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === "secrets.internal") {
        const { reference } = JSON.parse(init.body);
        secretReferences.push(reference);
        return Response.json({ apiKey: "waha-administrative-key" });
      }
      providerCalls.push([url.pathname, init.method ?? "GET"]);
      if (failure === "ambiguous" && providerCalls.length === 1) throw new TypeError("connection closed");
      return Response.json({ message: failure }, { status: failure === "ambiguous" ? 404 : 401 });
    }, () => processor(repository, secrets).drainTenant(job.tenantId));
    assert.equal(providerCalls.some(([path, method]) => path === "/api/sessions" && method === "POST"), false);
    assert.deepEqual(secretReferences, ["secret://waha-admin",webhookSecretReference]);
    assert.equal(repository.calls.complete.length, 0);
    assert.equal(repository.calls.fail.length, 1);
  }
});

test("WAHA lifecycle fails closed when an assignment or provider reports a different engine", async () => {
  const assignmentMismatch = operation("START", { engine: "NOWEB", connectionState: "PAUSED" });
  const assignmentRepository = repositoryFor([assignmentMismatch]);
  const assignmentResult = await withFetch(
    async () => assert.fail("an engine-mismatched assignment must block the provider call"),
    () => processor(assignmentRepository, resolver()).drainTenant(assignmentMismatch.tenantId),
  );
  assert.equal(assignmentResult.failedTerminal, 1);
  assert.equal(assignmentRepository.calls.fail[0].failure.code, "WAHA_ENGINE_ASSIGNMENT_MISMATCH");
  assert.equal(assignmentRepository.calls.fail[0].failure.connectionState, "ACTION_REQUIRED");

  const providerMismatch = operation("START", { connectionState: "PAUSED" });
  const providerRepository = repositoryFor([providerMismatch]);
  const providerResult = await withFetch(
    async () => new Response(JSON.stringify({
      name: "opaque/session one",
      status: "STARTING",
      engine: { engine: "NOWEB" },
    }), { status: 200 }),
    () => processor(providerRepository, resolver()).drainTenant(providerMismatch.tenantId),
  );
  assert.equal(providerResult.failedTerminal, 1);
  assert.equal(providerRepository.calls.complete.length, 0);
  assert.equal(providerRepository.calls.fail[0].failure.code, "WAHA_SESSION_RECONCILIATION_MISMATCH");
  assert.equal(providerRepository.calls.fail[0].failure.connectionState, "ACTION_REQUIRED");
});

test("DISCONNECT treats a provider-side missing session as replay success and retires local ownership", async () => {
  const job = operation("DISCONNECT", { connectionState: "WORKING" });
  const repository = repositoryFor([job]);
  const paths = [];
  const result = await withFetch(
    async (input) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ error: "missing" }), { status: 404 });
    },
    () => processor(repository, resolver()).drainTenant(job.tenantId),
  );

  assert.equal(result.succeeded, 1);
  assert.deepEqual(paths, [
    "/api/sessions/opaque%2Fsession%20one/stop",
    "/api/sessions/opaque%2Fsession%20one",
  ]);
  assert.deepEqual(repository.calls.complete[0].completion, {
    connectionState: "REVOKED",
    providerState: "DELETED",
    providerStateData: { status: "DELETED" },
    actionReason: "The WhatsApp linked device has been disconnected.",
    retireSession: true,
    revokeWebhook: true,
    webhookState: "REVOKED",
    result: { disconnected: true },
  });
});

test("duplicate identity cleanup renews fences before provider calls and preserves the rejection reason",async()=>{
  const job=operation("DISCONNECT",{connectionState:"ACTION_REQUIRED",payload:{reason:"DUPLICATE_IDENTITY",pinnedWahaWorkerId:"54000000-0000-4000-8000-000000000001"}});
  const repository=repositoryFor([job]);
  const providerCalls=[];
  const result=await withFetch(async(input,init={})=>{
    providerCalls.push([new URL(String(input)).pathname,init.method??"GET",repository.calls.renew.length]);
    if(init.method==="DELETE")return new Response(null,{status:204});
    return Response.json({name:"opaque/session one",status:"STOPPED",engine:{engine:"GOWS"}});
  },()=>processor(repository,resolver()).drainTenant(job.tenantId));
  assert.equal(result.succeeded,1);
  assert.deepEqual(providerCalls,[
    ["/api/sessions/opaque%2Fsession%20one/stop","POST",2],
    ["/api/sessions/opaque%2Fsession%20one","DELETE",3],
  ]);
  assert.equal(repository.calls.complete[0].completion.connectionState,"REVOKED");
  assert.match(repository.calls.complete[0].completion.actionReason,/already connected/u);
  assert.deepEqual(repository.calls.complete[0].completion.result,{disconnected:true,rejected:"DUPLICATE_IDENTITY"});
});

test("SYNC_GROUPS follows pagination, renews fences, deduplicates groups, and captures verified identity", async () => {
  const job = operation("SYNC_GROUPS", { connectionState: "WORKING" });
  job.providerSession.state = "WORKING";
  const repository = repositoryFor([job]);
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `${index}@g.us`,
    name: `Operations ${index}`,
    participants: [],
  }));
  const urls = [];
  const result = await withFetch(
    async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname === "/api/sessions/opaque%2Fsession%20one") {
        return new Response(JSON.stringify(exactWahaSession(job, "WORKING")), { status: 200 });
      }
      if (url.pathname === "/api/sessions/opaque%2Fsession%20one/me") {
        return new Response(JSON.stringify({ me: { id: "12025550131@c.us", pushName: "WasalX Operations" } }), { status: 200 });
      }
      if (url.searchParams.get("offset") === "0") return new Response(JSON.stringify(firstPage), { status: 200 });
      return new Response(JSON.stringify([
        { id: "99@g.us", name: "Operations 99 updated", participants: [] },
        { id: "100@g.us", name: "Operations 100", participants: [] },
      ]), { status: 200 });
    },
    () => processor(repository, resolver()).drainTenant(job.tenantId),
  );

  assert.equal(result.succeeded, 1);
  assert.deepEqual(
    urls.filter((url) => url.pathname.endsWith("/groups")).map((url) => url.searchParams.get("offset")),
    ["0", "100"],
  );
  const completion = repository.calls.complete[0].completion;
  assert.equal(completion.groups.length, 101);
  assert.equal(completion.groups.find((group) => group.id === "99@g.us").name, "Operations 99 updated");
  assert.equal(completion.phoneE164, "+12025550131");
  assert.equal(completion.connectionState, "WORKING");
  assert.equal(repository.calls.renew.length >= 4, true);
});

test("official Meta provisioning proves eligibility, subscribes the WABA, synchronizes groups, and activates ingress", async () => {
  const job = metaOperation("PROVISION");
  const repository = repositoryFor([job]);
  const secrets = metaResolver();
  const requests = [];
  const result = await withFetch(
    async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname.endsWith("/phone_numbers")) return Response.json({data:[{id:"123456789"}]});
      if (url.pathname.endsWith("/subscribed_apps")) {
        return new Response(JSON.stringify(init.method === "POST" ? { success: true } : { data: [{ id: "meta-app-1" }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/groups")) {
        return new Response(JSON.stringify({
          data: url.searchParams.get("limit") === "1"
            ? []
            : [{ id: "official_group_1", subject: "Operations pod", total_participant_count: 6 }],
          paging: { cursors: {} },
        }), { status: 200 });
      }
      if (url.pathname === "/v24.0/123456789") {
        return new Response(JSON.stringify({
          display_phone_number: "+12025550131",
          verified_name: "WasalX Operations",
        }), { status: 200 });
      }
      throw new Error(`unexpected Meta request: ${url}`);
    },
    () => processor(repository, secrets).drainTenant(job.tenantId),
  );

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failedRetryable: 0, failedTerminal: 0, leaseLost: 0 });
  assert.deepEqual(secrets.references, [metaSecretReference]);
  assert.equal(requests.some(({ url, init }) => url.pathname === "/v24.0/987654321/subscribed_apps" && init.method === "POST"), true);
  const completion = repository.calls.complete[0].completion;
  assert.equal(completion.connectionState, "WORKING");
  assert.equal(completion.providerState, "AVAILABLE");
  assert.equal(completion.providerStateData.eligibility, "VERIFIED");
  assert.equal(completion.webhookState, "ACTIVE");
  assert.equal(completion.phoneE164, "+12025550131");
  assert.deepEqual(completion.groups, [{ id: "official_group_1", name: "Operations pod", participants: 6 }]);
  assert.equal(JSON.stringify(completion).includes("meta-system-user-access-token"), false);
});

test("official Meta provisioning keeps 1:1 messaging available when Groups is not eligible", async () => {
  const job = metaOperation("PROVISION");
  const repository = repositoryFor([job]);
  const requests = [];
  const result = await withFetch(
    async (input, init = {}) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname.endsWith("/phone_numbers")) return Response.json({data:[{id:"123456789"}]});
      if (url.pathname.endsWith("/groups")) {
        return new Response(JSON.stringify({ error: { code: 10, message: "raw provider detail" } }), { status: 403 });
      }
      if (url.pathname.endsWith("/subscribed_apps")) {
        return new Response(JSON.stringify(init.method === "POST" ? { success: true } : { data: [{ id: "meta-app-1" }] }), { status: 200 });
      }
      if (url.pathname === "/v24.0/123456789") {
        return new Response(JSON.stringify({
          display_phone_number: "+12025550131",
          verified_name: "WasalX Operations",
        }), { status: 200 });
      }
      throw new Error(`unexpected Meta request: ${url}`);
    },
    () => processor(repository, metaResolver()).drainTenant(job.tenantId),
  );
  assert.equal(result.succeeded, 1);
  assert.equal(repository.calls.fail.length, 0);
  const completion = repository.calls.complete[0].completion;
  assert.equal(completion.connectionState, "WORKING");
  assert.equal(completion.providerStateData.eligibility, "NOT_ELIGIBLE");
  assert.equal(completion.providerStateData.capability.state, "PERMISSION_REQUIRED");
  assert.equal(completion.result.eligible, false);
  assert.equal(completion.groups, undefined, "an unperformed group listing must preserve saved groups");
  assert.equal(completion.result.synchronized, false);
  assert.equal(requests.some(({ url, init }) => url.pathname.endsWith("/subscribed_apps") && init.method === "POST"), true);
});

for (const operationType of ["PROVISION", "START", "RESTART"]) {
  test(`direct Meta ${operationType} verifies subscription and phone without Groups consent or calls`, async () => {
    const job = metaOperation(operationType, { disclosureVersion: null });
    const repository = repositoryFor([job]);
    const paths = [];
    const result = await withFetch(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith("/phone_numbers")) return Response.json({data:[{id:"123456789"}]});
      if (url.pathname.endsWith("/subscribed_apps")) return Response.json({ success: true });
      if (url.pathname === "/v24.0/123456789") return Response.json({ display_phone_number: "+12025550131" });
      assert.fail(`unexpected direct provider call: ${url.pathname}`);
    }, () => processor(repository, metaResolver()).drainTenant(tenantId));
    assert.equal(result.succeeded, 1);
    assert.deepEqual(paths, ["/v24.0/987654321/phone_numbers", "/v24.0/987654321/subscribed_apps", "/v24.0/123456789"]);
    const completion = repository.calls.complete[0].completion;
    assert.equal(completion.connectionState, "WORKING");
    assert.equal(completion.webhookState, "ACTIVE");
    assert.equal(completion.phoneE164, "+12025550131");
    assert.equal(completion.groups, undefined);
    assert.equal(completion.providerStateData.eligibility, "CONSENT_REQUIRED");
    assert.equal(completion.providerStateData.capability.evidence, "local_policy");
    assert.equal(completion.result.synchronized, false);
    assert.equal(completion.providerStateData.metaAccountProof.phoneNumberId, "123456789");
    assert.equal(completion.providerStateData.metaAccountProof.wabaId, "987654321");
    assert.equal(completion.providerStateData.metaAccountProof.operationId, job.id);
    assert.equal(completion.providerStateData.metaAccountProof.fencingToken, job.fencingToken);
    assert.match(completion.providerStateData.metaAccountProof.credentialFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(completion.providerStateData.metaAccountProof.credentialMetadata,
      job.providerSession.providerStateData.metaAccountProof.credentialMetadata);
    assert.ok(repository.calls.renew.length >= 2);
  });
}

for (const failure of ["subscription", "identity", "invalid-phone"]) {
  test(`direct Meta without Groups consent still fails closed on ${failure}`, async () => {
    const repository = repositoryFor([metaOperation("PROVISION", { disclosureVersion: null })]);
    const result = await withFetch(async (input) => {
      const path = new URL(String(input)).pathname;
      assert.equal(path.endsWith("/groups"), false);
      if (path.endsWith("/phone_numbers")) return Response.json({data:[{id:"123456789"}]});
      if (failure === "subscription" || (failure === "identity" && !path.endsWith("/subscribed_apps"))) {
        return Response.json({ error: { code: 190, message: "Expired credential" } }, { status: 401 });
      }
      if (path.endsWith("/subscribed_apps")) return Response.json({ success: true });
      return Response.json({ display_phone_number: "invalid" });
    }, () => processor(repository, metaResolver()).drainTenant(tenantId));
    assert.equal(result.failedTerminal, 1);
    assert.equal(repository.calls.complete.length, 0);
    assert.notEqual(repository.calls.fail[0].failure.connectionState, "WORKING");
  });
}

test("worker denies an unconsented Meta Groups sync before any provider call", async () => {
  const job = metaOperation("SYNC_GROUPS", { disclosureVersion: null, connectionState: "WORKING" });
  job.providerSession.state = "WORKING";
  job.webhookRoute.state = "ACTIVE";
  const repository = repositoryFor([job]);
  const result = await withFetch(async () => assert.fail("no provider call without consent"),
    () => processor(repository, metaResolver()).drainTenant(tenantId));
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.fail[0].failure.code, "META_GROUPS_CONSENT_REQUIRED");
});

test("Meta group sync exposes rejected credentials instead of preserving stale working state", async () => {
  const job=metaOperation("SYNC_GROUPS",{connectionState:"WORKING"});
  job.providerSession.state="WORKING";job.webhookRoute.state="ACTIVE";
  const repository=repositoryFor([job]);
  let requests=0;
  const result=await withFetch(
    async()=>{requests++;return new Response(JSON.stringify({error:{message:"Expired credential",type:"OAuthException",code:190,error_subcode:463}}),{status:401})},
    ()=>processor(repository,metaResolver()).drainTenant(job.tenantId),
  );
  assert.equal(result.failedTerminal,1);
  assert.ok(requests>0);
  assert.equal(repository.calls.fail[0].failure.code,"META_AUTHENTICATION_FAILED");
  assert.equal(repository.calls.fail[0].failure.connectionState,"ACTION_REQUIRED");
  assert.equal(repository.calls.fail[0].failure.retryable,false);
});

test("terminal Meta response validation during sync does not invalidate credentials",async()=>{
  const job=metaOperation("SYNC_GROUPS",{connectionState:"WORKING"});
  job.providerSession.state="WORKING";job.webhookRoute.state="ACTIVE";
  const repository=repositoryFor([job]);let requests=0;
  const result=await withFetch(async()=>{requests++;return new Response(JSON.stringify({}),{status:200})},
    ()=>processor(repository,metaResolver()).drainTenant(job.tenantId));
  assert.ok(requests>0);assert.equal(result.failedTerminal,1);
  assert.equal(repository.calls.fail[0].failure.connectionState,"WORKING");
  assert.doesNotMatch(repository.calls.fail[0].failure.code,/AUTH|TOKEN|CREDENTIAL/);
});

test("official Meta pause and disconnect are local safety actions that do not require provider credentials", async () => {
  for (const [operationType, expectedState, expectedWebhook] of [
    ["PAUSE", "PAUSED", "PAUSED"],
    ["DISCONNECT", "REVOKED", "REVOKED"],
  ]) {
    const job = metaOperation(operationType, { connectionState: "WORKING" });
    const repository = repositoryFor([job]);
    const secrets = { resolve: async () => assert.fail("local Meta safety actions must not resolve provider credentials") };
    await withFetch(
      async () => assert.fail("local Meta safety actions must not call Graph API"),
      () => processor(repository, secrets).drainTenant(job.tenantId),
    );
    assert.equal(repository.calls.complete[0].completion.connectionState, expectedState);
    assert.equal(repository.calls.complete[0].completion.webhookState, expectedWebhook);
  }
});

test("Meta activation rejects a readable phone in a different account before subscribing", async () => {
  const job = metaOperation("START", { disclosureVersion: null });
  const repository = repositoryFor([job]);
  const paths = [];
  const result = await withFetch(async (input) => {
    const path = new URL(input).pathname; paths.push(path);
    assert.equal(path, "/v24.0/987654321/phone_numbers");
    return Response.json({ data: [{ id: "111111111" }] });
  }, () => processor(repository, metaResolver()).drainTenant(tenantId));
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.complete.length, 0);
  assert.equal(repository.calls.fail[0].failure.code, "META_PHONE_ACCOUNT_RELATION_INVALID");
  assert.equal(paths.length, 1);
});

test("a queued rotation validation never adopts another credential on a later claim", async () => {
  const job = metaOperation("RESTART", { payload: { sourceOperationId: "old-rotation", metaBinding: {
    secretReference: `${metaSecretReference}/rotations/old`, providerSessionId: "52000000-0000-4000-8000-000000000001",
    phoneNumberId: "123456789", wabaId: "987654321",
  } } });
  const repository = repositoryFor([job]);
  const result = await withFetch(async () => assert.fail("superseded validation must make no provider call"),
    () => processor(repository, { resolve: async () => assert.fail("must not resolve newer credential") }).drainTenant(tenantId));
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.fail[0].failure.code, "META_BINDING_SUPERSEDED");
});

test("Meta rejects an out-of-band token change before any provider call", async () => {
  const job = metaOperation("START");
  job.providerSession.providerStateData.metaAccountProof = {
    schemaVersion:1,claim:"PHONE_ACCOUNT_RELATION_VERIFIED",tenantId,connectionId,
    secretReference:metaSecretReference,providerSessionId:job.providerSession.id,
    phoneNumberId:"123456789",wabaId:"987654321",credentialFingerprint:"0".repeat(64),
  };
  const repo = repositoryFor([job]);
  const result = await withFetch(async()=>assert.fail("mismatched proof must not use the token"),
    ()=>processor(repo,metaResolver()).drainTenant(tenantId));
  assert.equal(result.failedTerminal,1);
  assert.equal(repo.calls.fail[0].failure.code,"META_CREDENTIAL_PROOF_MISMATCH");
});

for (const localOperation of ["PAUSE", "DISCONNECT"]) test(`local Meta ${localOperation} preserves the newer proof and cleans only the current credential`, async () => {
  const job = metaOperation(localOperation);
  const latestProof={operationId:"new-rotation",credentialFingerprint:"a".repeat(64)};
  const calls=[];
  const client={release(){},async query(sql,values=[]){
    calls.push({sql,values});
    if(sql.startsWith("SELECT state,secret_reference"))return{rows:[{state:"WORKING",secret_reference:`${metaSecretReference}/rotations/new`}],rowCount:1};
    if(sql.includes("AS proof_matches"))return{rows:[{id:job.providerSession.id,opaque_session_id:"123456789",waba_id:"987654321",proof_matches:false,provider_state_data:{metaAccountProof:latestProof}}],rowCount:1};
    return{rows:[{id:job.id}],rowCount:1};
  }};
  const repo=new ConnectionOperationRepository({connect:async()=>client});
  await repo.complete(job,"lease",{id:job.providerSession.id,workerIdentity:"pause-worker",fencingToken:9},
    {connectionState:localOperation === "PAUSE" ? "PAUSED" : "REVOKED",providerState:"PAUSED_LOCAL",providerStateData:{wabaId:"987654321",localState:"PAUSED"},result:{paused:true},webhookState:localOperation === "PAUSE" ? "PAUSED" : "REVOKED",retireSession:localOperation === "DISCONNECT"});
  const update=calls.find(call=>call.sql.includes("provider_state_data = $3::jsonb"));
  assert.ok(update);
  assert.deepEqual(JSON.parse(update.values[2]).metaAccountProof,latestProof);
  assert.equal(calls.some(call=>call.sql.startsWith("UPDATE connections")),true);
  if(localOperation === "DISCONNECT")assert.equal(calls.find(call=>call.sql.includes("'CONNECTION_CREDENTIAL'")).values[3],`${metaSecretReference}/rotations/new`);
});

for (const changed of ["secret", "session", "phone", "account", "proof"]) {
  for (const outcome of ["complete", "fail"]) test(`Meta stale ${outcome} preserves a newer ${changed} binding`, async () => {
    const job = metaOperation("RESTART");
    const calls = [];
    const lease = { id: job.providerSession.id, workerIdentity:"old-worker", fencingToken:9 };
    const client = {
      release() {},
      async query(sql, values = []) {
        calls.push({sql,values});
        if (sql.startsWith("SELECT state,secret_reference")) return {rows:[{state:"PAUSED",secret_reference:changed === "secret" ? `${metaSecretReference}/rotations/new` : metaSecretReference}],rowCount:1};
        if (sql.includes("app.meta_add_access_activation_held")) { assert.deepEqual(values, [job.tenantId, job.connectionId]); return { rows: [{ held: false }], rowCount: 1 }; }
        if (sql.includes("AS proof_matches")) return {rows:[{id:changed === "session" ? "new-session" : job.providerSession.id,
          opaque_session_id:changed === "phone" ? "111111111" : job.providerSession.opaqueSessionId,
          waba_id:changed === "account" ? "222222222" : "987654321",proof_matches:changed !== "proof",provider_state_data:{}}],rowCount:1};
        return {rows:[{id:job.id}],rowCount:1};
      },
    };
    const repo = new ConnectionOperationRepository({connect:async()=>client});
    if (outcome === "complete") {
      const result = await repo.complete(job,"lease",lease,{connectionState:"WORKING",providerState:"AVAILABLE",providerStateData:{},result:{subscribed:true}});
      assert.equal(result.connectionState,"PAUSED"); assert.equal(result.result.superseded,true);
    } else await repo.fail(job,"lease",lease,{retryable:true,code:"META_NETWORK",safeError:"Temporarily unavailable",connectionState:"DEGRADED"});
    assert.equal(calls.some(call=>/^UPDATE connections|^UPDATE webhook_routes/u.test(call.sql)),false);
    assert.equal(calls.some(call=>/SET state.*provider_state|SET provider_state_data/su.test(call.sql)),false);
    const terminal = calls.find(call=>call.sql.includes(`app.${outcome}_connection_operation`));
    assert.ok(terminal);
    if (outcome === "fail") { assert.equal(terminal.values[3],false); assert.equal(terminal.values[4],"META_NETWORK"); }
  });
}

test("retry classification is explicit and an exhausted retry becomes terminal", async () => {
  const retryable = classifyConnectionOperationError(new ProviderError("WAHA request failed (503)", true, "WAHA_HTTP", 503), "WORKING");
  assert.deepEqual(retryable, {
    retryable: true,
    code: "WAHA_HTTP",
    safeError: "WAHA request failed (503)",
    connectionState: "DEGRADED",
  });
  assert.equal(classifyConnectionOperationError(new ProviderError("denied", false, "WAHA_HTTP", 401)).safeError, "WAHA administrative credentials were rejected.");
  assert.equal(classifyConnectionOperationError(new SecretResolutionError("secret=do-not-leak", true)).safeError.includes("do-not-leak"), false);

  const job = operation("START", { attempts: 8, maxAttempts: 8, connectionState: "WORKING" });
  const repository = repositoryFor([job]);
  const result = await withFetch(
    async () => new Response(JSON.stringify({ error: "temporary" }), { status: 503 }),
    () => processor(repository, resolver()).drainTenant(job.tenantId),
  );
  assert.equal(result.failedTerminal, 1);
  assert.equal(repository.calls.fail[0].failure.retryable, false);
  assert.equal(repository.calls.fail[0].failure.code, "WAHA_HTTP_EXHAUSTED");
  assert.equal(repository.calls.fail[0].failure.connectionState, "FAILED");

  const syncJob = operation("SYNC_GROUPS", { attempts: 8, maxAttempts: 8, connectionState: "WORKING" });
  const syncRepository = repositoryFor([syncJob]);
  const syncResult = await withFetch(
    async () => new Response(JSON.stringify({ error: "temporary" }), { status: 503 }),
    () => processor(syncRepository, resolver()).drainTenant(syncJob.tenantId),
  );
  assert.equal(syncResult.failedTerminal, 1);
  assert.equal(syncRepository.calls.fail[0].failure.connectionState, "WORKING");
});

test("repository group finalization marks disappeared groups STALE and never deletes configured rows", async () => {
  const source = await readFile(
    new URL("../services/connector-worker/src/connection-operation-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /SET sync_state = 'STALE'/);
  assert.match(source, /ON CONFLICT \(connection_id, external_group_id\) DO UPDATE/);
  assert.match(source, /sync_state = 'ACTIVE'/);
  assert.doesNotMatch(source, /DELETE\s+FROM\s+whatsapp_groups/i);
  assert.match(source,/JOIN group_workspace_settings[\s\S]*workspace\.capture_enabled/);
  assert.match(source,/group-workspace-consent:/);
  assert.match(source,/tenant\.group_workspace_enabled/);
  assert.match(source,/group_record\.sync_state='STALE' OR NOT \(group_record\.id=ANY\(\$3::uuid\[\]\)\)/);
  assert.match(source,/INSERT INTO group_workspace_participants/);
  assert.match(source,/DELETE FROM group_workspace_participants/);
  assert.match(source, /app\.complete_connection_operation/);
  assert.match(source, /app\.fail_connection_operation/);
  assert.match(source, /fencing_token = \$[0-9]+/);
  assert.match(source, /lease_expires_at >= now\(\)/);
  assert.match(source, /CONNECTION_CREDENTIAL/);
  assert.match(source, /job\.provider === "META"/);
  assert.match(source, /CASE WHEN \$5 THEN state ELSE \$1 END/);
  assert.match(source, /pin_waha_session_assignment_for_cleanup/);
  assert.match(source, /job\.payload\.reason !== "DUPLICATE_IDENTITY"/);
});

test("empty WAHA discovery preserves configured groups but is safe before first configuration",async()=>{
  const job=operation("SYNC_GROUPS",{connectionState:"WORKING"});
  const configuredClient={query:async(sql)=>{
    if(sql.includes("SELECT 1")&&sql.includes("FROM whatsapp_groups"))return{rows:[{configured:1}],rowCount:1};
    return{rows:[],rowCount:0};
  }};
  await assert.rejects(
    synchronizeGroups(configuredClient,job,[]),
    error=>error instanceof ProviderError&&error.code==="WAHA_GROUP_SNAPSHOT_EMPTY"&&error.retryable,
  );
  const writes=[];
  const newClient={query:async(sql)=>{
    if(sql.includes("SELECT 1")&&sql.includes("FROM whatsapp_groups"))return{rows:[],rowCount:0};
    if(/^\s*(?:UPDATE|INSERT|DELETE)/u.test(sql))writes.push(sql);
    return{rows:[],rowCount:0};
  }};
  await synchronizeGroups(newClient,job,[]);
  assert.equal(writes.some((sql)=>/INSERT INTO whatsapp_groups/u.test(sql)),false);
  assert.equal(writes.some((sql)=>/DELETE\s+FROM\s+whatsapp_groups/iu.test(sql)),false);
});

test("stale group sync completion releases its lease without mutating groups or lifecycle state",async()=>{
  const queries=[];
  const client={
    query:async(sql)=>{
      queries.push(sql);
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("set_config"))return{rows:[],rowCount:0};
      if(sql.includes("FROM connection_operations")&&sql.includes("FOR UPDATE"))return{rows:[{id:"operation"}],rowCount:1};
      if(sql.startsWith("SELECT state,secret_reference FROM connections"))return{rows:[{state:"PAUSED"}],rowCount:1};
      if(sql.includes("FROM provider_sessions")&&sql.includes("FOR UPDATE"))return{rows:[{id:"session"}],rowCount:1};
      if(sql.startsWith("SELECT state FROM webhook_routes"))return{rows:[{state:"ACTIVE"}],rowCount:1};
      if(sql.startsWith("SELECT state FROM provider_sessions"))return{rows:[{state:"WORKING"}],rowCount:1};
      if(sql.includes("UPDATE provider_sessions SET worker_id=NULL"))return{rows:[],rowCount:1};
      if(sql.includes("app.complete_connection_operation"))return{rows:[{id:"operation"}],rowCount:1};
      throw new Error(`Unexpected query: ${sql}`);
    },
    release(){},
  };
  const repository=new ConnectionOperationRepository({connect:async()=>client,end:async()=>{}});
  const job=operation("SYNC_GROUPS",{connectionState:"WORKING"});
  job.providerSession.state="WORKING";
  const completion=await repository.complete(job,"51000000-0000-4000-8000-000000000099",{
    id:job.providerSession.id,workerIdentity:"test-worker",fencingToken:9,
  },{connectionState:"WORKING",groups:[{id:"fixture-0019@example.test",name:"Group",participants:3}]});
  assert.deepEqual(completion.result,{superseded:true,reason:"CONNECTION_LIFECYCLE_CHANGED"});
  assert.equal(completion.connectionState,"PAUSED");
  assert.equal(queries.some((sql)=>/whatsapp_groups|group_workspace_settings|UPDATE connections/u.test(sql)),false);
});

test("every raw WAHA lifecycle status has a deliberate product-state mapping", () => {
  assert.equal(mapWahaSessionState("SCAN_QR_CODE").connectionState, "AWAITING_AUTH");
  assert.equal(mapWahaSessionState("PASSKEY_REQUIRED").connectionState, "AWAITING_AUTH");
  assert.equal(mapWahaSessionState("PASSKEY_CONFIRMATION_REQUIRED").connectionState, "AWAITING_AUTH");
  assert.equal(mapWahaSessionState("STARTING").connectionState, "CONNECTING");
  assert.equal(mapWahaSessionState("WORKING").connectionState, "WORKING");
  assert.equal(mapWahaSessionState("STOPPED").connectionState, "PAUSED");
  assert.equal(mapWahaSessionState("FAILED").connectionState, "FAILED");
  assert.equal(mapWahaSessionState("UNKNOWN").connectionState, "DEGRADED");
});

test("non-provision lifecycle commands never resolve webhook signing material", async () => {
  const job = operation("DISCONNECT", { connectionState: "WORKING" });
  const repository = repositoryFor([job]);
  const secrets = resolver();
  await withFetch(
    async () => new Response(JSON.stringify({ status: "STOPPED" }), { status: 200 }),
    () => processor(repository, secrets).drainTenant(job.tenantId),
  );
  assert.deepEqual(secrets.references, ["secret://waha-admin"]);
});

function lifecycleState({revision=1,blocked=true,recovery=false}={}){
  recovery=recovery||!blocked;
  const negative={event:"ACCOUNT_OFFBOARDED",observedAt:"2026-10-07T00:00:00.000Z",payloadSha256:"a".repeat(64)};
  const recovered={event:"ACCOUNT_RECONNECTED",observedAt:"2026-10-07T01:00:00.000Z",payloadSha256:"b".repeat(64)};
  const stamp=recovery?recovered:negative;
  return{schemaVersion:1,revision,lastObservedAt:stamp.observedAt,lastEvent:stamp.event,lastPayloadSha256:stamp.payloadSha256,
    reasonStates:[{reason:"ACCOUNT_OFFBOARDED",negative,...(recovery?{recovery:recovered}:{}),...(!blocked?{clearedThrough:recovered}:{}),blocked}]};
}

test("Meta operation lifecycle admission rejects stale revisions and requires every recoverable blocker",async()=>{
  for(const kind of ["legacy-clear","legacy-block","fresh-recover","rotation","partial","pending","revision","null","released"]){
    const job=metaOperation("RESTART");const lifecycle=kind==="legacy-clear"?undefined:kind==="null"?null:lifecycleState({recovery:true});
    job.payload={...job.payload,...(!kind.startsWith("legacy")?{metaLifecycleExpectedRevision:1}:{})};
    if(["fresh-recover","rotation","partial","pending","revision"].includes(kind))job.payload.metaLifecycleRecovery={expectedRevision:1,reasons:kind==="partial"?[]:["ACCOUNT_OFFBOARDED"]};
    if(kind==="rotation")job.payload.sourceOperationId="rotation";
    const calls=[];const client={query:async(sql,params)=>{calls.push({sql,params});
      if(sql.startsWith("SELECT state,secret_reference"))return{rows:[{state:"WORKING",secret_reference:job.connectionSecretReference}],rowCount:1};
      if(sql.startsWith("SELECT id FROM webhook_routes")){
        assert.deepEqual(params,[job.tenantId,job.connectionId]);assert.match(sql,/reservation_release_id IS NULL/);
        return {rows:kind==="released"?[]:[{id:"current-route"}],rowCount:kind==="released"?0:1};
      }
      if(sql.includes("app.meta_add_access_activation_held")){assert.deepEqual(params,[job.tenantId,job.connectionId]);return{rows:[{held:false}],rowCount:1};}
      if(sql.includes("AS proof_matches"))return{rows:[{id:job.providerSession.id,opaque_session_id:job.providerSession.opaqueSessionId,waba_id:"987654321",proof_matches:true,
        provider_state_data:{wabaId:"987654321",...(lifecycle===undefined?{}:{metaLifecycle:lifecycle})}}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:kind!=="revision",blocked:lifecycle!==undefined,unresolved_hold:kind==="pending"}],rowCount:1};
      assert.fail("unexpected lifecycle lock query");
    }};
    const current=await new ConnectionOperationRepository({}).lockConnection(client,job);
    assert.equal(current.metaBindingCurrent,["legacy-clear","fresh-recover"].includes(kind),kind);
    if(kind==="fresh-recover"){
      const guard=calls.find(q=>q.sql.includes("app.meta_lifecycle_guard"));
      assert.deepEqual(guard.params,[job.connectionId,job.providerSession.id,job.providerSession.opaqueSessionId,"987654321",process.env.META_APP_ID??"",1]);
      assert.equal(current.providerStateData.metaLifecycle.reasonStates[0].blocked,true,"candidate inspection must not clear authority");
    }
  }
});
test("actual worker finalization cannot activate saved access even when its job snapshot omits enrollment", async () => {
  const job = metaOperation("RESTART");
  const calls = [];
  const client = { release() {}, query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SELECT state,secret_reference")) return { rows: [{ state: "PAUSED", secret_reference: job.connectionSecretReference }], rowCount: 1 };
    if (sql.includes("app.meta_add_access_activation_held")) { assert.deepEqual(values, [job.tenantId, job.connectionId]); return { rows: [{ held: true }], rowCount: 1 }; }
    return { rows: [{ id: job.id }], rowCount: 1 };
  } };
  const repository = new ConnectionOperationRepository({ connect: async () => client });
  const result = await repository.complete(job, "lease", { id: job.providerSession.id, workerIdentity: "stale-worker", fencingToken: 9 },
    { connectionState: "WORKING", providerState: "AVAILABLE", providerStateData: {}, result: { subscribed: true }, webhookState: "ACTIVE" });
  assert.equal(result.connectionState, "PAUSED"); assert.equal(result.result.superseded, true);
  assert.equal(calls.some(call => /^UPDATE connections|^UPDATE webhook_routes|SET provider_state_data/u.test(call.sql)), false);
});
test("Meta completion clears only fresh explicit recovery and local operations preserve current lifecycle",async()=>{
  for(const operationType of ["RESTART","PAUSE","DISCONNECT"]){
    const job=metaOperation(operationType);const lifecycle=lifecycleState({revision:2,recovery:true});
    job.payload={...job.payload,metaLifecycleExpectedRevision:2,...(operationType==="RESTART"?{metaLifecycleRecovery:{expectedRevision:2,reasons:["ACCOUNT_OFFBOARDED"]}}:{})};
    const calls=[];const client={release(){},query:async(sql,params=[])=>{calls.push({sql,params});
      if(sql.startsWith("SELECT state,secret_reference"))return{rows:[{state:"WORKING",secret_reference:job.connectionSecretReference}],rowCount:1};
      if(sql.includes("app.meta_add_access_activation_held")){assert.deepEqual(params,[job.tenantId,job.connectionId]);return{rows:[{held:false}],rowCount:1};}
      if(sql.includes("AS proof_matches"))return{rows:[{id:job.providerSession.id,opaque_session_id:job.providerSession.opaqueSessionId,waba_id:"987654321",proof_matches:true,provider_state_data:{metaLifecycle:lifecycle,latestObservation:"retained"}}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:true,blocked:true,unresolved_hold:false}],rowCount:1};
      return{rows:[{id:job.id}],rowCount:1};
    }};
    const repo=new ConnectionOperationRepository({connect:async()=>client});
    await repo.complete(job,"lease",{id:job.providerSession.id,workerIdentity:"worker",fencingToken:9},
      {connectionState:operationType==="RESTART"?"WORKING":operationType==="PAUSE"?"PAUSED":"REVOKED",providerState:"AVAILABLE",providerStateData:{wabaId:"987654321"},result:{known:true}});
    const update=calls.find(q=>q.sql.includes("provider_state_data = $3::jsonb"));assert.ok(update);
    const written=JSON.parse(update.params[2]);assert.equal(written.latestObservation,"retained");
    assert.equal(written.metaLifecycle.reasonStates[0].blocked,operationType!=="RESTART");
    assert.equal(written.metaLifecycle.revision,operationType==="RESTART"?3:2);
    assert.equal(lifecycle.reasonStates[0].blocked,true,"authoritative input remains immutable");
    if(operationType!=="RESTART")assert.equal(calls.some(q=>q.sql.includes("app.meta_lifecycle_guard")),false);
  }
});

test("saved-access stale admission is checked before private token resolution",async()=>{
 const job=metaOperation("START",{connectionState:"PAUSED",disclosureVersion:null});
 job.payload.metaAddAccessActivation={schemaVersion:1};job.providerSession.providerStateData.metaSignup={purpose:"ADD_ACCESS",attemptId:"55000000-0000-4000-8000-000000000001"};
 const repository=repositoryFor([job]),secrets=metaResolver();repository.renewLeases=async()=>{throw new ProviderError("Synthetic stale admission",false,"META_BINDING_SUPERSEDED");};
 const result=await withFetch(async()=>assert.fail("No stale activation provider request"),()=>processor(repository,secrets).drainTenant(tenantId));
 assert.equal(result.failedTerminal,1);assert.equal(secrets.references.length,0);assert.equal(repository.calls.complete.length,0);assert.equal(repository.calls.fail[0].failure.connectionState,"PAUSED");
});
