import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BadRequestException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { DeliveriesController } from "../services/control-api/dist/deliveries.controller.js";
import { QuarantineController } from "../services/control-api/dist/quarantine.controller.js";
import { RuleTestService } from "../services/control-api/dist/rule-test.service.js";
import { DeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";
import { OutboxRepository } from "../services/connector-worker/dist/services/connector-worker/src/repository.js";

test("unknown attempts retain only bounded provider codes and neutral destination guidance", async () => {
  const repository = Object.create(OutboxRepository.prototype);
  let attempt;
  repository.tenant = async (_tenant, run) => run({ query: async (sql, values) => {
    if (sql.startsWith("UPDATE delivery_attempts")) attempt = { sql, values };
    return { rowCount: 1, rows: [] };
  } });
  repository.queueStatus = async () => {};
  for (const [code, expected] of [["META_NETWORK_ERROR", "META_NETWORK_ERROR"], ["secret\nvalue", null]]) {
    await repository.outcomeUnknown(delivery, "lease", "Request interrupted", code);
    assert.match(attempt.sql, /provider_code=\$5/);
    assert.equal(attempt.values[4], expected);
    assert.match(attempt.values[0], /verify the destination/);
    assert.doesNotMatch(attempt.values[0], /WhatsApp group/);
  }
});

const migrationUrl = new URL(
  "../services/control-api/migrations/0014_delivery_outcome_fencing.sql",
  import.meta.url,
);

const delivery = {
  id: "15000000-0000-4000-8000-000000000001",
  tenantId: "10000000-0000-4000-8000-000000000001",
  connectionId: "12000000-0000-4000-8000-000000000001",
  groupBindingId: "13000000-0000-4000-8000-000000000001",
  groupId: "fixture-0019@example.test",
  ticketId: "42",
  articleId: "9",
  text: "Resolved",
  contentType: "text/plain",
  idempotencyKey: "delivery-1",
  attempts: 1,
  provider: "waha",
  providerBaseUrl: "http://waha-gows.internal:3000/",
  wahaWorkerId: "30000000-0000-4000-8000-000000000001",
  wahaAssignmentFencingToken: 7,
  wahaAssignmentLeaseExpiresAt: "2026-08-09T23:59:59.000Z",
  sessionId: "session-1",
  connectionSecretReference: "secret://connection",
  zammadBaseUrl: "https://zammad.example",
  zammadSecretReference: "secret://zammad",
};
const retryOperation = (sql) => {
  if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
  if (sql.includes("FROM bot_flow_operations")) return { rows: [] };
  if (sql.includes("INSERT INTO bot_flow_operations")) return { rows: [] };
  return null;
};

test("stop retrying preserves failed history, uses revision CAS, and replays after a wake failure",async()=>{
  const revision="2026-09-06 00:00:00.123456+00";
  const request={id:"stop-test",principal:{tenantId:delivery.tenantId,userId:"14000000-0000-4000-8000-000000000001"}};
  let receipt=null;let audits=0;let updates=0;let wakeFails=true;
  const client={query:async(sql,params)=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:receipt?[receipt]:[]};
    if(sql.includes("SELECT state,manual_retry_allowed")){
      assert.match(sql,/content_redacted_at IS NULL/);assert.match(sql,/lease_id IS NULL AND lease_expires_at IS NULL/);
      assert.match(sql,/delivery_has_active_privacy_target/);assert.match(sql,/PROVIDER_OUTCOME_UNKNOWN/);assert.match(sql,/FOR UPDATE/);
      assert.deepEqual(params,[delivery.tenantId,delivery.id]);
      return{rows:[{state:"FAILED_TERMINAL",manual_retry_allowed:true,revision}]};
    }
    if(sql.startsWith("UPDATE delivery_outbox")){
      assert.equal(sql,"UPDATE delivery_outbox SET manual_retry_allowed=false,updated_at=now() WHERE tenant_id=$1 AND id=$2");
      updates++;return{rows:[],rowCount:1};
    }
    if(sql.startsWith("INSERT INTO audit_events")){audits++;assert.equal(params[2],"delivery.retry_stopped");return{rows:[]}}
    if(sql.startsWith("INSERT INTO bot_flow_operations")){receipt={action:params[1],request_sha256:params[3],result:params[4]};return{rows:[]}}
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const controller=new DeliveriesController({withTenant:async(_tenant,operation)=>operation(client)},{wake:async()=>{if(wakeFails)throw new Error("wake unavailable")}});
  await assert.rejects(()=>controller.stopRetrying(request,delivery.id,"stop-key",{confirmation:"STOP",expectedRevision:"stale"}),/Delivery changed/);
  assert.equal(updates,0);
  const body={confirmation:"STOP",expectedRevision:revision};
  await assert.rejects(()=>controller.stopRetrying(request,delivery.id,"stop-key",body),/wake unavailable/);
  wakeFails=false;
  assert.deepEqual(await controller.stopRetrying(request,delivery.id,"stop-key",body),{id:delivery.id,state:"FAILED_TERMINAL",manual_retry_allowed:false,duplicate:true});
  assert.equal(updates,1);assert.equal(audits,1);
  await assert.rejects(()=>controller.stopRetrying(request,delivery.id,"stop-key",{...body,expectedRevision:"other"}),/Idempotency key/);
  for(const invalid of [null,{}, {...body,confirmation:"GO"}])await assert.rejects(()=>controller.stopRetrying(request,delivery.id,"stop-key",invalid),/confirmation is invalid/);
});

test("delivery claims are reclaimable only before the provider network boundary", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /state = 'CLAIMED'/);
  assert.match(sql, /state = 'SENDING'[\s\S]*state = 'OUTCOME_UNKNOWN'/);
  assert.match(sql, /delivery\.state = 'CLAIMED' AND delivery\.lease_expires_at < now\(\)/);
  assert.doesNotMatch(sql, /state IN \('QUEUED','FAILED_RETRYABLE','SENDING'\)/);
  assert.match(sql, /ownership_state = 'ACTIVE'/);
  assert.match(sql, /INSERT INTO zammad_status_outbox[\s\S]*'OUTCOME_UNKNOWN'/);
});

test("a WAHA network interruption after begin-send becomes outcome unknown and is never auto-rescheduled", async () => {
  const calls = [];
  const repository = {
    claimBotActions:async()=>[],claimDeliveries: async () => [delivery],
    beginSend: async () => calls.push("begin-send"),
    complete: async () => calls.push("complete"),
    fail: async () => calls.push("fail"),
    outcomeUnknown: async (_job, _lease, error) => calls.push(`unknown:${error}`),
    claimStatuses: async () => [],
    completeStatus: async () => {},
    retryStatus: async () => {},
    failStatus: async () => {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("connection reset"); };
  try {
    const processor = new DeliveryProcessor(
      repository,
      { resolve: async () => ({ apiKey: "key" }) },
      { wahaBaseUrl: "https://waha.example", metaGraphVersion: "v24.0" },
    );
    await processor.drainTenant(delivery.tenantId);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls[0], "begin-send");
  assert.match(calls[1], /^unknown:WAHA request timed out/);
  assert.doesNotMatch(calls.join(" "), /fail|complete/);
});

test("a projection failure after provider acceptance never rewrites known success as outcome unknown", async () => {
  const calls = [];
  const repository = {
    claimBotActions:async()=>[],claimDeliveries: async () => [delivery],
    beginSend: async () => calls.push("begin-send"),
    complete: async () => { calls.push("complete-attempt"); throw new Error("database unavailable"); },
    fail: async () => calls.push("fail"),
    outcomeUnknown: async (_job, _lease, error) => calls.push(`unknown:${error}`),
    claimStatuses: async () => [],
    completeStatus: async () => {},
    retryStatus: async () => {},
    failStatus: async () => {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: "wamid.accepted" }), { status: 200 });
  try {
    const processor = new DeliveryProcessor(
      repository,
      { resolve: async () => ({ apiKey: "key" }) },
      { wahaBaseUrl: "https://waha.example", metaGraphVersion: "v24.0" },
    );
    await processor.drainTenant(delivery.tenantId);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, ["begin-send", "complete-attempt"]);
});

test("an unknown outcome is resolved only through typed, audited review actions", async () => {
  const request = { id: "request-1", principal: { subject: "subject-1", userId: "14000000-0000-4000-8000-000000000001", tenantId: delivery.tenantId, email: "supervisor@example.test", displayName: "Supervisor", role: "supervisor" } };
  for (const [resolutionCode, confirmation, nextState, auditAction, wakes] of [
    ["DELIVERY_CONFIRMED_SENT", "SENT", "SENT", "review.delivery_confirmed_sent", []],
    ["DELIVERY_RETRY_REQUESTED", "RETRY", "QUEUED", "review.delivery_retry_requested", [delivery.tenantId]],
    ["DELIVERY_NO_FURTHER_ATTEMPTS", "STOP", null, "review.delivery_no_further_attempts", [delivery.tenantId]],
  ]) {
    const audits = [];
    let leased=false;let outcomeWrites=0;let receipt;
    const client = { async query(sql, values = []) {
      if (sql.includes("SELECT pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM quarantine_action_requests")) return { rows: receipt?[receipt]:[], rowCount: receipt?1:0 };
      if (sql.includes("FROM quarantine_records WHERE") && sql.includes("FOR UPDATE")) return { rows: [{ id: "11111111-1111-4111-8111-111111111111", source_kind: "OUTBOUND", reason_code: "PROVIDER_OUTCOME_UNKNOWN", state: "OPEN", connection_id: delivery.connectionId, group_binding_id: null, group_action_execution_id: null, source_event_inbox_id: null, delivery_id: delivery.id, version: 1, safe_summary: "Outcome unknown" }], rowCount: 1 };
      if (sql.includes("FROM delivery_outbox delivery") && sql.includes("FOR UPDATE OF delivery")) return { rows: [{ id: delivery.id, state: "OUTCOME_UNKNOWN", external_message_id: null, content_redacted_at: null, retryable_content: true, privacy_blocked: false, bot_conversation_id: null, direct_origin: null, lease_id: leased ? "lease" : null, lease_expires_at: null }], rowCount: 1 };
      if (sql.includes("FROM group_disclosure_deliveries") && sql.includes("FOR UPDATE")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE delivery_outbox SET state=$1")) { outcomeWrites++; assert.notEqual(nextState,null); assert.equal(values[0], nextState); return { rows: [], rowCount: 1 }; }
      if (sql.includes("UPDATE group_disclosure_deliveries") || sql.includes("SELECT app.project_delivery_status")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE quarantine_records SET state=$1")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO quarantine_action_requests")) { receipt={quarantine_id:values[1],actor_id:values[2],request_sha256:values[4],action:values[5],result_state:values[6],result_version:values[7]}; return { rows: [], rowCount: 1 }; }
      if (sql.includes("INSERT INTO audit_events")) { audits.push(values); return { rows: [], rowCount: 1 }; }
      throw new Error(`Unexpected outcome-review SQL: ${sql}`);
    } };
    const outboundWakes = [];
    const controller = new QuarantineController({ withTenant: async (_tenant, operation) => operation(client) }, new RuleTestService(), { wakeInbound: async () => {}, wake: async (tenant) => outboundWakes.push(tenant), wakePrivacy: async () => {} });
    await assert.rejects(() => controller.resolve(request, "11111111-1111-4111-8111-111111111111", `${resolutionCode}-missing-confirmation`, { expectedVersion: 1, resolutionCode }), /Confirm SENT|Type RETRY|Type STOP/);
    if(resolutionCode==="DELIVERY_NO_FURTHER_ATTEMPTS"){
      leased=true;
      await assert.rejects(()=>controller.resolve(request,"11111111-1111-4111-8111-111111111111",`${resolutionCode}-leased`,{expectedVersion:1,resolutionCode,confirmation}),/lease/);
      leased=false;
    }
    assert.deepEqual(await controller.resolve(request, "11111111-1111-4111-8111-111111111111", `${resolutionCode}-confirmed`, { expectedVersion: 1, resolutionCode, confirmation }), { id: "11111111-1111-4111-8111-111111111111", state: "RESOLVED", version: 2, duplicate: false });
    assert.equal(audits[0][2], auditAction);
    assert.equal(outcomeWrites,nextState===null?0:1);
    assert.deepEqual(outboundWakes, wakes);
    if(resolutionCode==="DELIVERY_NO_FURTHER_ATTEMPTS"){
      const replay=await controller.resolve(request,"11111111-1111-4111-8111-111111111111",`${resolutionCode}-confirmed`,{expectedVersion:1,resolutionCode,confirmation});
      assert.equal(replay.duplicate,true);
      assert.equal(audits.length,1);
      assert.equal(outcomeWrites,0);
      assert.deepEqual(outboundWakes,[delivery.tenantId,delivery.tenantId]);
    }

  }
});

test("terminal delivery retry requires a durable remediation permission", async () => {
  let manualRetryAllowed = false;
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      const receipt = retryOperation(sql); if (receipt) return receipt;
      if (sql.includes("SELECT state, attempts")) {
        return manualRetryAllowed
          ? { rows: [{ state: "FAILED_TERMINAL", attempts: 8, safe_error: "Temporary storage outage", manual_retry_allowed: true }] }
          : { rows: [] };
      }
      if (sql.includes("group_disclosure_deliveries")) return { rows: [], rowCount: 0 };
      if (sql.includes("UPDATE delivery_outbox")) return { rows: [{ id: delivery.id, state: "QUEUED" }] };
      if (sql.includes("INSERT INTO audit_events")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const controller = new DeliveriesController(
    { withTenant: async (_tenant, operation) => operation(client) },
    { wake: async () => {} },
  );
  const request = {
    id: "request-terminal-retry",
    principal: {
      subject: "subject-1",
      userId: "14000000-0000-4000-8000-000000000001",
      tenantId: delivery.tenantId,
      email: "supervisor@example.test",
      displayName: "Supervisor",
      role: "supervisor",
    },
  };

  await assert.rejects(
    () => controller.retry(request, delivery.id, "retry-terminal-blocked", {}),
    (error) => error instanceof BadRequestException && /not retryable/i.test(error.message),
  );
  manualRetryAllowed = true;
  assert.deepEqual(await controller.retry(request, delivery.id, "retry-terminal-approved", {}), {
    id: delivery.id,
    state: "QUEUED",
    duplicate: false,
  });
  assert.ok(queries.some((sql) => /FAILED_TERMINAL' AND manual_retry_allowed/.test(sql)));
  assert.ok(queries.some((sql) => /manual_retry_allowed = false/.test(sql)));
});

test("the internal Zammad retry endpoint enforces the same durable retry policy", async () => {
  const source = await readFile(
    new URL("../services/control-api/src/zammad-internal.controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /function retryAllowed\(state:string\|null,manualRetryAllowed:boolean\|null\)\{return state==="FAILED_RETRYABLE"\|\|\(state==="FAILED_TERMINAL"&&manualRetryAllowed===true\)\}/,
  );
  assert.match(source, /!retryAllowed\(previous\.state,previous\.manual_retry_allowed\)/);
  assert.doesNotMatch(source, /state IN \('FAILED_RETRYABLE','FAILED_TERMINAL'\)/);
});

test("portal requires a visible typed review path for unknown sends", async () => {
  const [portal, messages] = await Promise.all([
    readFile(new URL("../app/WasalXApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/messages/en/tenant.ts", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /tenant\.deliveries\.actions\.reviewOutcome/);
  assert.match(portal, /resolutionCode:"DELIVERY_CONFIRMED_SENT",confirmation:"SENT"/);
  assert.match(portal, /resolutionCode:"DELIVERY_RETRY_REQUESTED",confirmation:actionRetryConfirmation/);
  assert.match(portal, /pattern="RETRY"/);
  assert.match(messages, /"tenant\.deliveries\.actions\.reviewOutcome": "Review outcome"/);
  assert.match(portal, /FAILED_TERMINAL" && row\.manual_retry_allowed === true/);
  assert.match(portal, /tenant\.deliveries\.correctedReply/);
  assert.match(messages, /"tenant\.deliveries\.correctedReply": "Create a corrected support reply"/);
  assert.match(portal, /String\(row\.state\) === "BLOCKED"/);
});
