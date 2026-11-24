import assert from "node:assert/strict";
import dnsPromises from "node:dns/promises";
import https from "node:https";
import {syncBuiltinESMExports} from "node:module";
import {MetaDirectEffectNotAttempted} from "../services/connector-worker/dist/packages/core/src/meta-direct-identity.js";
import {executeBotAction,safeHttpsRequest} from "../services/connector-worker/dist/services/connector-worker/src/bot-action.js";
import { createHash } from "node:crypto";
import test from "node:test";
import {routingFixtureEnvironment} from "./meta-routing-fixture.mjs";
import {nativeCommandOnce} from "../services/connector-worker/dist/services/connector-worker/src/native-command-once.js";
import {claimQuotedCommand,prepareQuotedCommand,readStoredQuotedCommand,resolveQuotedCommand} from "../services/connector-worker/dist/services/connector-worker/src/quoted-command.js";
import {ticketCommandAdmission,ticketCommandDisposition} from '../services/connector-worker/dist/packages/core/src/ticket-command-guards.js';
import {ticketEventSourceHash} from "../services/connector-worker/dist/packages/core/src/ticket-event-runtime.js";
import {TicketCommandAuthorizationError} from "../services/connector-worker/dist/packages/core/src/ticket-event-flow.js";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { ProviderError } from "../services/connector-worker/dist/packages/connectors/src/types.js";
import { signServiceJwt, ServiceAuthenticationError } from "../services/connector-worker/dist/packages/core/src/service-auth.js";
import { DeliveryProcessor as ProductionDeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";
import { InboundProcessor as ProductionInboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { OutboxRepository } from "../services/connector-worker/dist/services/connector-worker/src/repository.js";
import { isBotActionSecretReference, SecretResolutionError, SidecarSecretResolver } from "../services/connector-worker/dist/services/connector-worker/src/secrets.js";
import { verifyDrainJob } from "../services/connector-worker/dist/services/connector-worker/src/tenant-job.js";

const secret="worker-test-secret-at-least-32-bytes";
// Existing synthetic unenrolled delivery fixtures have no account authority.
// New account-policy tests use the actual repository and explicit guard failures.
class DeliveryProcessor extends ProductionDeliveryProcessor {
  constructor(repository,...dependencies){super({assertMetaBillingSendCurrent:async()=>{},admitMetaMessageRequest:async()=>{},...repository},...dependencies)}
}
class InboundProcessor extends ProductionInboundProcessor {
  constructor(repository,...dependencies){super({quotedCommandCandidate:async()=>null,messageIsWithinAdmissionWindow:async()=>true,hasRunnableGroupBinding:async()=>false,renewWahaWorkerAssignment:async(_event,context)=>context,...repository},...dependencies)}
}
test("inbound Meta workers use the admitted app ID and retain the fallback for older events", async () => {
  const apps = [];
  const events = [
    { eventType: "meta.account.lifecycle.block", metaWebhookAppId: "10002" },
    { eventType: "meta.routing.passive", metaWebhookAppId: "10003" },
    { eventType: "meta.coexistence.echo" },
  ];
  const recordApp = async (_event, _lease, appId) => apps.push(appId);
  const processor = new ProductionInboundProcessor({
    claim: async () => events,
    applyMetaLifecycle: recordApp,
    applyMetaRouting: recordApp,
    projectCoexistence: recordApp,
  }, {}, undefined, undefined, undefined, "10001");
  await processor.drainTenant("synthetic");
  assert.deepEqual(apps, ["10002", "10003", "10001"]);
});

test("second-app Meta direct messages and media use the admitted app ID", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T00:00:00Z") });
  const defaultAppId = "10001";
  const appId = "10002";
  const previousAppId = process.env.META_APP_ID;
  process.env.META_APP_ID = defaultAppId;
  t.after(() => {
    if (previousAppId === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = previousAppId;
  });
  const token = "synthetic-meta-token-for-proof";
  const proof = metadataProof(token, { appId });
  const context = {
    metaCredentialContext: metaContext(proof), connectionSecretReference: proof.secretReference,
    mediaEnabled: true, retentionDays: 30,
    zammadBaseUrl: "https://zammad.example", zammadSecretReference: "secret://zammad",
  };
  const events = [
    { id: "wamid.text", type: "text", text: { body: "Hello" } },
    { id: "wamid.image", type: "image", image: { id: "20001", mime_type: "image/png" } },
  ].map(message => ({
    id: message.id, providerEventId: message.id, eventType: "messages", attempts: 1,
    tenantId: proof.tenantId, connectionId: proof.connectionId, provider: "meta", metaWebhookAppId: appId,
    payload: { entry: [{ id: proof.wabaId, changes: [{ field: "messages", value: {
      metadata: { phone_number_id: proof.phoneNumberId },
      messages: [{ ...message, from: "12025550102", timestamp: String(Date.now() / 1000) }],
    } }] }] },
  }));
  const completed = [], linked = [];
  let mediaProofChecks = 0;
  const repository = Object.assign(Object.create(InboundRepository.prototype), {
    claim: async () => events,
    messageIsWithinAdmissionWindow: async () => true,
    resolveMetaDirectMessage: async (_event, _lease, message, resolvedAppId) => {
      assert.equal(resolvedAppId, appId);
      return message;
    },
    assertMetaDirectIdentityCurrent: async (_event, _lease, _chat, checkedAppId) => assert.equal(checkedAppId, appId),
    directContext: async () => context,
    tenant: async (_tenant, work) => work({ query: async (sql, params) => {
      assert.match(sql, /app\.meta_lifecycle_guard/u);
      assert.equal(params[7], appId);
      mediaProofChecks++;
      return { rows: [{ meta_account_proof: proof }] };
    } }),
    processDirectMessage: async () => ({ duplicate: false, queued: false }),
    linkMediaObject: async event => linked.push(event.id),
    complete: async (event, _lease, outcome) => completed.push([event.id, outcome]),
    fail: async (_event, _lease, _retryable, error) => assert.fail(error),
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.pathname === "/api/v1/users/search") return Response.json([]);
    assert.equal(url.pathname, "/api/v1/users");
    return Response.json({ id: 7, login: JSON.parse(init.body).login });
  });
  const media = { prepare: async ({ beforeMetaRequest, media }) => {
    assert.equal(media.url, "meta-media://20001");
    await beforeMetaRequest(token);
    return { mediaObjectId: "synthetic-media", attachment: { filename: "image.png", "mime-type": "image/png" } };
  } };
  await new ProductionInboundProcessor(repository, { resolve: async () => ({ token: "synthetic-zammad-token" }) },
    media, undefined, undefined, defaultAppId).drainTenant(proof.tenantId);
  assert.deepEqual(completed.sort(), [["wamid.image", "PROCESSED"], ["wamid.text", "PROCESSED"]]);
  assert.deepEqual(linked, ["wamid.image"]);
  assert.equal(mediaProofChecks, 1);
});

const wahaAssignment={providerBaseUrl:"http://waha-gows.internal:3000/",wahaWorkerId:"30000000-0000-4000-8000-000000000001",wahaAssignmentFencingToken:7,wahaAssignmentLeaseExpiresAt:"2026-08-09T23:59:59.000Z"};
test("tenant drain jobs require a signed, scoped, matching tenant context",async()=>{const now=Math.floor(Date.now()/1000);const token=await signServiceJwt({iss:"wasalx-control",aud:"wasalx-connector-worker",sub:"scheduler",tenant_id:"tenant-a",instance_id:"scheduler-1",scope:"delivery:drain",iat:now,exp:now+120,jti:crypto.randomUUID()},secret);assert.equal((await verifyDrainJob({tenantId:"tenant-a",token},secret)).tenantId,"tenant-a");await assert.rejects(()=>verifyDrainJob({tenantId:"tenant-b",token},secret),ServiceAuthenticationError);const inboxToken=await signServiceJwt({iss:"wasalx-control",aud:"wasalx-connector-worker",sub:"scheduler",tenant_id:"tenant-a",instance_id:"scheduler-1",scope:"inbox:drain",iat:now,exp:now+120,jti:crypto.randomUUID()},secret);assert.equal((await verifyDrainJob({tenantId:"tenant-a",token:inboxToken},secret,"inbox:drain")).tenantId,"tenant-a");await assert.rejects(()=>verifyDrainJob({tenantId:"tenant-a",token:inboxToken},secret),ServiceAuthenticationError)});

test("delivery completion and Zammad status are independent durable stages",async()=>{const delivery={id:"d1",tenantId:"tenant-a",connectionId:"c1",groupBindingId:"b1",groupId:"g1",ticketId:"42",articleId:"9",text:"Resolved",contentType:"text/plain",idempotencyKey:"idem-1",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};const status={id:"s1",deliveryId:"d1",tenantId:"tenant-a",ticketId:"42",state:"SENT",externalMessageId:"wamid.1",attempts:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};const calls=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>{calls.push("delivery-begin")},complete:async()=>{calls.push("delivery-complete")},fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[status],completeStatus:async()=>{calls.push("status-complete")},retryStatus:async()=>{},failStatus:async()=>{}};const originalFetch=globalThis.fetch;globalThis.fetch=async(input)=>{const url=String(input);if(url.includes("sendText"))return new Response(JSON.stringify({id:"wamid.1"}),{status:200});if(url.includes("/api/v1/tickets/42"))return new Response(JSON.stringify({id:42}),{status:200});throw new Error(`unexpected ${url}`)};try{const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"key"}:{token:"token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"});assert.deepEqual(await processor.drainTenant("tenant-a"),{actions:0,deliveries:1,statuses:1});assert.deepEqual(calls,["delivery-begin","delivery-complete","status-complete"])}finally{globalThis.fetch=originalFetch}});

test("reaction deliveries retain the target message and bypass agent text attribution",async()=>{
  const delivery={id:"reaction-delivery",tenantId:"tenant-a",connectionId:"c1",groupId:"447700900001@g.us",text:"✅",contentType:"application/vnd.wasalx.whatsapp-reaction",replyToMessageId:"message-1",idempotencyKey:"reaction-1",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",agentDisplayName:"Agent One",agentPrefix:"Agent:",agentIdentityPlacement:"HEADER"};
  const removal={...delivery,id:"reaction-removal",text:"",idempotencyKey:"reaction-2"};
  const completed=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery,removal],beginSend:async()=>true,complete:async(_job,_lease,_state,id)=>completed.push(id),fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[]};
  const originalFetch=globalThis.fetch;const bodies=[];
  globalThis.fetch=async(input,init)=>{assert.ok(String(input).endsWith("/api/reaction"));bodies.push(JSON.parse(String(init?.body)));return Response.json({})};
  try{await new DeliveryProcessor(repository,{resolve:async()=>({apiKey:"key"})},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"}).drainTenant("tenant-a")}finally{globalThis.fetch=originalFetch}
  const identity=createHash("sha256").update("reaction-1\u001fmessage-1\u001f✅").digest("hex");
  const removalIdentity=createHash("sha256").update("reaction-2\u001fmessage-1\u001f").digest("hex");
  assert.deepEqual(bodies,[{session:"s1",messageId:"message-1",reaction:"✅"},{session:"s1",messageId:"message-1",reaction:""}]);assert.deepEqual(completed,[`reaction:${identity}`,`reaction:${removalIdentity}`]);
});

test("direct conversation ownership is projected to Zammad only while the durable fence is current",async()=>{
  const state={id:"projection-1",tenantId:"tenant-a",conversationId:"conversation-1",ticketId:"42",state:"HUMAN",conversationFencingToken:7,keepOpenEnabled:true,attempts:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
  const calls=[];let current=true;
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[],claimConversationStates:async()=>[state],beginConversationState:async()=>current,completeConversationState:async()=>calls.push("complete"),retryConversationState:async()=>{},failConversationState:async()=>{},claimStatuses:async()=>[]};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>{calls.push(JSON.parse(String(init?.body)));return Response.json({id:42})};
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async()=>({token:"token"})},{metaGraphVersion:"v24.0"});
    await processor.drainTenant("tenant-a");
    assert.deepEqual(calls,[{wasalx_bot_conversation:"true",wasalx_bot_state:"HUMAN",wasalx_bot_keep_open:"true"},"complete"]);
    calls.length=0;state.keepOpenEnabled=false;state.state="BOT";
    await processor.drainTenant("tenant-a");
    assert.deepEqual(calls,[{wasalx_bot_conversation:"true",wasalx_bot_state:"BOT",wasalx_bot_keep_open:"false"},"complete"]);
    calls.length=0;current=false;
    await processor.drainTenant("tenant-a");
    assert.deepEqual(calls,[]);
  }finally{globalThis.fetch=originalFetch}
});

test("conversation projection refreshes only a newer same-conversation same-state fence before sending",async()=>{
  const projection={conversation_id:"conversation-1",zammad_ticket_id:"42",conversation_state:"BOT",conversation_fencing_token:"7"};
  const job={id:"projection-1",tenantId:"tenant-a",conversationId:"conversation-1",ticketId:"42",state:"BOT",conversationFencingToken:7};
  for(const [current,expected] of [
    [{id:"conversation-1",state:"BOT",fencing_token:"7"},"admit"],
    [{id:"conversation-1",state:"BOT",fencing_token:"9"},"refresh"],
    [{id:"conversation-1",state:"BOT",fencing_token:"6"},"retire"],
    [{id:"conversation-1",state:"HUMAN",fencing_token:"9"},"retire"],
    [{id:"conversation-2",state:"BOT",fencing_token:"9"},"retire"],
    [undefined,"retire"],
  ]){
    const writes=[];const repository=Object.create(OutboxRepository.prototype);
    repository.tenant=async(scope,work)=>{assert.equal(scope,job.tenantId);return work({query:async(sql,values)=>{
      if(sql.startsWith("SELECT conversation_id")){assert.deepEqual(values,[job.tenantId,job.id,"lease-1",7,"BOT"]);return{rows:[projection]};}
      if(sql.startsWith("SELECT id,state,fencing_token")){assert.deepEqual(values,[job.tenantId,"42"]);return{rows:current?[current]:[]};}
      assert.ok(sql.startsWith("UPDATE zammad_conversation_state_outbox"));writes.push({sql,values});return{rowCount:1,rows:[]};
    }});};
    assert.equal(await repository.beginConversationState(job,"lease-1"),expected==="admit");
    assert.equal(writes.length,expected==="admit"?0:1);
    if(expected==="refresh"){
      assert.match(writes[0].sql,/conversation_fencing_token=\$4/);
      assert.match(writes[0].sql,/completed_at=NULL/);
      assert.match(writes[0].sql,/lease_id=NULL/);
      assert.match(writes[0].sql,/conversation_fencing_token=\$5 AND conversation_state=\$6/);
      assert.deepEqual(writes[0].values,[job.tenantId,job.id,"lease-1",9,7,"BOT"]);
    }else if(expected==="retire")assert.match(writes[0].sql,/completed_at=now\(\)/);
  }
  const repository=Object.create(OutboxRepository.prototype);
  repository.tenant=async(_scope,work)=>work({query:async(sql)=>{
    if(sql.startsWith("SELECT conversation_id"))return{rows:[projection]};
    if(sql.startsWith("SELECT id,state,fencing_token"))return{rows:[{id:"conversation-1",state:"BOT",fencing_token:"9"}]};
    return{rowCount:0,rows:[]};
  }});
  await assert.rejects(()=>repository.beginConversationState(job,"lost-lease"),/projection lease was lost/);
});

test("late native completion restores changed ownership without reprojecting token-only activity",async()=>{
  const job={id:"projection-1",tenantId:"tenant-a",conversationId:"conversation-1",ticketId:"42",state:"HUMAN",conversationFencingToken:7};
  for(const [current,completed,requeued,expected] of [
    [{id:"conversation-1",state:"BOT",fencing_token:"10"},0,1,"refresh"],
    [{id:"conversation-2",state:"HUMAN",fencing_token:"10"},1,1,"refresh"],
    [{id:"conversation-1",state:"HUMAN",fencing_token:"10"},1,0,"complete"],
    [{id:"conversation-1",state:"BOT",fencing_token:"10"},0,0,"lost"],
    [{id:"conversation-1",state:"HUMAN",fencing_token:"7"},0,0,"lost"],
  ]){
    const writes=[];const repository=Object.create(OutboxRepository.prototype);
    repository.tenant=async(scope,work)=>{assert.equal(scope,job.tenantId);return work({query:async(sql,values)=>{
      if(sql.startsWith("SELECT id,state,fencing_token"))return{rows:[current]};
      writes.push({sql,values});return{rowCount:writes.length===1?completed:requeued,rows:[]};
    }});};
    if(expected==="lost")await assert.rejects(()=>repository.completeConversationState(job,"lease-1"),/projection lease was lost/);
    else await repository.completeConversationState(job,"lease-1");
    const changed=current.id!==job.conversationId||current.state!==job.state;
    assert.equal(writes.length,changed?2:1);
    if(changed){
      assert.match(writes[1].sql,/SET conversation_fencing_token=\$5/);
      assert.match(writes[1].sql,/conversation_fencing_token<=\$5/);
      assert.match(writes[1].sql,/completed_at=NULL/);
      assert.deepEqual(writes[1].values,[job.tenantId,current.id,job.ticketId,current.state,10]);
    }
  }
});

test("delivery processing preserves destination order without starving another group",async()=>{
  const base={tenantId:"tenant-a",connectionId:"c1",contentType:"text/plain",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30};
  const deliveries=[
    {...base,id:"a1",groupId:"447700900009@g.us",text:"A1",idempotencyKey:"a1",createdAt:"2026-08-23T10:00:00.000Z"},
    {...base,id:"a2",groupId:"447700900009@g.us",text:"A2",idempotencyKey:"a2",createdAt:"2026-08-23T10:00:01.000Z"},
    {...base,id:"b1",groupId:"447700900011@g.us",text:"B1",idempotencyKey:"b1",createdAt:"2026-08-23T10:00:00.500Z"},
    {...base,id:"ffffffff-0000-4000-8000-000000000001",groupId:"447700900012@g.us",text:"C1",idempotencyKey:"c1",createdAt:"2026-08-23T10:00:00.250Z",batchId:"batch-c",batchSequence:0},
    {...base,id:"00000000-0000-4000-8000-000000000001",groupId:"447700900012@g.us",text:"C2",idempotencyKey:"c2",createdAt:"2026-08-23T10:00:00.250Z",batchId:"batch-c",batchSequence:1},
    {...base,id:"88888888-0000-4000-8000-000000000001",groupId:"447700900012@g.us",text:"D1",idempotencyKey:"d1",createdAt:"2026-08-23T10:00:00.250Z",batchId:"batch-d",batchSequence:0},
    {...base,id:"11111111-0000-4000-8000-000000000001",groupId:"447700900012@g.us",text:"D2",idempotencyKey:"d2",createdAt:"2026-08-23T10:00:00.250Z",batchId:"batch-d",batchSequence:1},
  ];
  const events=[];let releaseA;const waitForB=new Promise(resolve=>{releaseA=resolve});
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>deliveries,beginSend:async()=>true,complete:async job=>events.push(`complete:${job.text}`),fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>{const {text}=JSON.parse(String(init?.body));events.push(`start:${text}`);if(text==="A1")await waitForB;if(text==="B1")releaseA();return Response.json({id:`message-${text}`})};
  try{const processor=new DeliveryProcessor(repository,{resolve:async()=>({apiKey:"key"})},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"});await processor.drainTenant("tenant-a")}finally{globalThis.fetch=originalFetch}
  assert.ok(events.indexOf("start:B1")<events.indexOf("start:A2"));
  assert.ok(events.indexOf("complete:A1")<events.indexOf("start:A2"));
  assert.ok(events.indexOf("complete:C1")<events.indexOf("start:C2"));
  assert.ok(events.indexOf("complete:C2")<events.indexOf("start:D1"));
  assert.ok(events.indexOf("complete:D1")<events.indexOf("start:D2"));
  assert.deepEqual(events.filter(event=>event.startsWith("complete:")).sort(),["complete:A1","complete:A2","complete:B1","complete:C1","complete:C2","complete:D1","complete:D2"]);
});

test("provider network failures are retryable only before send; send outcomes remain unknown",async()=>{const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"key",sessionFor:()=>"session"});const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new TypeError("network unavailable")};try{await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"g1",text:"hello",idempotencyKey:"i1"}),error=>error instanceof ProviderError&&error.retryable&&error.code==="WAHA_NETWORK"&&!error.outcomeKnown)}finally{globalThis.fetch=originalFetch}});

test("WAHA source metadata distinguishes manual phone messages from API feedback",async()=>{const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"key",sessionFor:()=>"session"});const payload={event:"message.any",payload:{id:"message-1",from:"447700900001@g.us",participant:"447700900007@c.us",body:"1234567890",fromMe:true,source:"app",timestamp:1_700_000_000}};const manual=await adapter.normalizeWebhook("c1",payload,new Headers());assert.equal(manual?.eventId,"message-1");assert.equal(manual?.fromMe,true);assert.equal(manual?.fromApi,false);const feedback=await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,source:"api"}},new Headers());assert.equal(feedback?.fromApi,true);const missingId=await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,id:undefined}},new Headers());assert.equal(missingId,null)});

test("WAHA group webhooks bound identities and content while cleaning the visible sender name",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"key",sessionFor:()=>"session"});
  const payload={event:"message.any",payload:{id:"message-1",from:"447700900001@g.us",participant:"447700900010@c.us",notifyName:" Nou\u202e\r\nra e\u0301 ",body:"Shipment ready",replyTo:{id:"quoted-1"},timestamp:1_700_000_000}};
  const message=await adapter.normalizeWebhook("c1",payload,new Headers({"x-webhook-request-id":"event-1"}));
  const pushed=await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,notifyName:undefined,_data:{Info:{PushName:"Group nickname"}}}},new Headers());
  assert.equal(pushed?.participantName,"Group nickname");
  assert.equal(pushed?.participantId,"447700900010@c.us");
  assert.equal(message?.participantName,"Nou ra é");assert.equal(message?.quotedMessageId,"quoted-1");assert.equal(message?.eventId,"event-1");
  const stanza='ABCDEF1234567890123456';
  const gows=await adapter.normalizeWebhook('c1',{...payload,payload:{...payload.payload,replyTo:{id:stanza,participant:"447700900007@c.us"}}},new Headers());
  assert.equal(gows?.quotedMessageId,stanza,'GOWS2026.7.2 extractReplyTo stanza is retained without guessing a serialized ID');
  const ordinary=await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,id:"message-ordinary",replyTo:null}},new Headers());
  assert.equal(ordinary?.messageId,"message-ordinary");assert.equal(ordinary?.quotedMessageId,undefined);
  assert.equal(await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,participant:undefined}},new Headers()),null);
  assert.equal(await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,id:"x".repeat(1_025)}},new Headers()),null);
  assert.equal(await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,participant:"member\u200f@c.us"}},new Headers()),null);
  assert.equal(await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,replyTo:{id:"x".repeat(1_025)}}},new Headers()),null);
  assert.equal(await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,body:"x".repeat(65_537)}},new Headers()),null);
  assert.equal(await adapter.normalizeWebhook("c1",{...payload,payload:{...payload.payload,body:"unsafe\u0000text"}},new Headers()),null);
});

test("WAHA group webhooks preserve Unicode emoji and normalize reactions",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"key",sessionFor:()=>"session"});
  const emoji="طلب e\u0301 👨‍👩‍👧‍👦 ✅";
  const message=await adapter.normalizeWebhook("c1",{event:"message",payload:{id:"message-emoji",from:"447700900001@g.us",participant:"member@lid",body:emoji,timestamp:1_700_000_000}},new Headers());
  assert.equal(message?.text,"طلب é 👨‍👩‍👧‍👦 ✅");
  const reaction=await adapter.normalizeWebhook("c1",{event:"message.reaction",payload:{id:"reaction-1",from:"447700900001@g.us",participant:"member@lid",reaction:{messageId:"message-emoji",text:"❤️"},timestamp:1_700_000_001}},new Headers());
  assert.equal(reaction?.eventKind,"REACTION");assert.equal(reaction?.quotedMessageId,"message-emoji");assert.equal(reaction?.text,"Reacted with ❤️");
  const gowsReaction=await adapter.normalizeWebhook("c1",{event:"message.any",payload:{id:"reaction-2",type:"reaction",from:"447700900001@g.us",participant:"member@lid",replyTo:null,reaction:{messageId:"message-emoji",text:"👍"},timestamp:1_700_000_002}},new Headers());
  assert.equal(gowsReaction?.eventKind,"REACTION");assert.equal(gowsReaction?.quotedMessageId,"message-emoji");assert.equal(gowsReaction?.text,"Reacted with 👍");
});

test("GOWS group webhooks retain locations and contacts in provider-neutral text",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"key",sessionFor:()=>"session"});
  const fixture=(id,content)=>({event:"message",payload:{id,from:"447700900001@g.us",participant:"447700900002@c.us",timestamp:1_700_000_000,...content}});
  const location=await adapter.normalizeWebhook("c1",fixture("location-1",{body:"",location:{latitude:"24.7000",longitude:"46.7000",name:"Office",address:"Riyadh"}}),new Headers());
  assert.equal(location?.text,"Shared location\nName: Office\nAddress: Riyadh\nCoordinates: 24.7, 46.7");
  const contact=await adapter.normalizeWebhook("c1",fixture("contact-1",{body:"",vCards:["BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Test Contact\r\nTEL;TYPE=CELL:12025550102\r\nEND:VCARD"]}),new Headers());
  assert.equal(contact?.text,"Shared contact\nName: Test Contact\nPhone: 12025550102");
  const malformed=await adapter.normalizeWebhook("c1",fixture("location-bad",{body:"Fallback",location:{latitude:"24.7 north",longitude:"46.7"},vCards:[]}),new Headers());
  assert.equal(malformed?.text,"Fallback");
  const empty=await adapter.normalizeWebhook("c1",fixture("empty-1",{body:"",location:{},vCards:[]}),new Headers());
  assert.equal(empty?.text,"");
});

test("ignored inbound events retain only stable body-free diagnostic reason codes",async()=>{
  const cases=[
    {
      event:{id:"event-empty-gows-receipt",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEngine:"GOWS",providerEventId:"evt-empty-gows-receipt",eventType:"message.ack.group",attempts:1,receivedAt:"2026-08-13T14:45:28.501Z",payload:{event:"message.ack.group",engine:"GOWS",payload:{id:"",participant:"participant@lid",ack:2,ackName:"DEVICE"}}},
      context:async()=>{throw new Error("empty GOWS receipt must not resolve routing")},
      expected:"UNSUPPORTED_WAHA_RECEIPT_RECEIPT_ID",
    },
    {
      event:{id:"event-receipt",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-receipt",eventType:"message.ack.group",attempts:1,receivedAt:"2026-08-13T14:45:28.501Z",payload:{event:"message.ack.group",payload:{id:"unexpected",participant:"participant@lid",ack:2,ackName:"DEVICE"}}},
      context:async()=>{throw new Error("unsupported receipt must not resolve routing")},
      expected:"UNSUPPORTED_WAHA_RECEIPT_ID_SUFFIX",
    },
    {
      event:{id:"event-unsupported",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-unsupported",eventType:"message",attempts:1,payload:{event:"message",payload:{chatId:"447700900001@g.us"}}},
      context:async()=>{throw new Error("unsupported payload must not resolve routing")},
      expected:"UNSUPPORTED_EVENT_PAYLOAD",
    },
    {
      event:{id:"event-api",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-api",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"api-message",chatId:"447700900001@g.us",participant:"447700900007@c.us",body:"secret body",source:"api",timestamp:1_700_000_000}}},
      context:async()=>{throw new Error("provider API feedback must not resolve routing")},
      expected:"PROVIDER_API_MESSAGE",
    },
    {
      event:{id:"event-no-route",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-no-route",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"unbound-message",chatId:"447700900004@g.us",participant:"447700900002@c.us",body:"secret body 1234567890",source:"app",timestamp:1_700_000_000}}},
      context:async()=>null,
      expected:"ROUTING_CONTEXT_UNAVAILABLE",
    },
  ];
  for(const fixture of cases){
    const completions=[];
    const repository={claim:async()=>[fixture.event],normalize:async()=>"skipped",context:fixture.context,complete:async(_event,_lease,status,redact,reason)=>completions.push({status,redact,reason}),fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)}};
    const processor=new InboundProcessor(repository,{resolve:async()=>{throw new Error("ignored events must not resolve secrets")}});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.deepEqual(completions,[{status:"IGNORED",redact:true,reason:fixture.expected}]);
    assert.doesNotMatch(JSON.stringify(completions),/secret body|1234567890/u);
  }
});

test("temporary secret-sidecar failures retain the delivery for retry",async()=>{const delivery={id:"d2",tenantId:"tenant-a",connectionId:"c1",groupBindingId:"b1",groupId:"g1",ticketId:"42",articleId:"10",text:"Resolved",contentType:"text/plain",idempotencyKey:"idem-2",attempts:1,provider:"waha",sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};const failures=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],complete:async()=>{},fail:async(_job,_lease,retryable,_error,availableAt)=>{failures.push({retryable,availableAt})},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};const processor=new DeliveryProcessor(repository,{resolve:async()=>{throw new SecretResolutionError("temporary",true)}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"});await processor.drainTenant("tenant-a");assert.equal(failures[0]?.retryable,true);assert.ok(failures[0]?.availableAt)});

test("expired Meta credentials reach the durable failure boundary",async()=>{
  const delivery={id:"meta-delivery",tenantId:"tenant-a",connectionId:"meta-connection",groupId:"12025550102",recipientType:"DIRECT",text:"hello",contentType:"text/plain",idempotencyKey:"meta-idem",attempts:1,provider:"meta",metaCredentialContext:metaContext(),metaDirectRecipientSnapshot:legacyMetaSnapshot(),sessionId:"123456789",connectionSecretReference:"secret://meta",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
  const failures=[];
  const repository={metaInheritedTemplateContext:async(job,lease)=>{assert.equal(job,delivery);assert.equal(typeof lease,"string");return null;},claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>true,assertMetaDeliveryContextCurrent:async()=>{},complete:async()=>{},fail:async(...args)=>failures.push(args),outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:190,message:"expired"}}),{status:401});
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async()=>({accessToken:"expired-token-for-test"})},{metaGraphVersion:"v24.0"});
    await processor.drainTenant("tenant-a");
    assert.equal(failures.length,1);
    assert.equal(failures[0][2],false);
    assert.equal(failures[0][6],"META_AUTHENTICATION_FAILED");
  }finally{globalThis.fetch=originalFetch}
});

test("terminal Meta authentication failures require operator action",async(t)=>{
  t.after(routingFixtureEnvironment("123450987"));
  const queries=[];
  const client={query:async(sql,params)=>{queries.push({sql,params});const routing=routingDeliveryFixture(sql,params,delivery);if(routing)return routing;if(sql.includes("/* meta_delivery_context_current */"))return{rowCount:1,rows:[{current:true}]};
    if(sql.includes("AND meta_direct_recipient=$5::jsonb"))return{rows:[{}],rowCount:1};
      if(sql.includes("app.meta_direct_identity_guard"))return{rows:[{clear:true}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:true,blocked:false,unresolved_hold:false}],rowCount:1};return{rowCount:sql.startsWith("UPDATE delivery_outbox")?1:0,rows:[]}},release:()=>{}};
  const repository=new OutboxRepository({connect:async()=>client});
  const delivery={id:"meta-delivery",tenantId:"tenant-a",connectionId:"meta-connection",groupId:"12025550102",recipientType:"DIRECT",text:"hello",contentType:"text/plain",idempotencyKey:"meta-idem",attempts:1,provider:"meta",metaCredentialContext:metaContext(),metaDirectRecipientSnapshot:legacyMetaSnapshot(),sessionId:"123456789",connectionSecretReference:"secret://meta",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
  await repository.fail(delivery,"lease",false,"Meta credentials are invalid or expired.",undefined,false,"META_AUTHENTICATION_FAILED");
  const connectionUpdate=queries.find(({sql})=>sql.startsWith("UPDATE connections SET state='ACTION_REQUIRED'"));
  assert.deepEqual(connectionUpdate?.params,["Meta credentials are invalid or expired.","tenant-a","meta-connection"]);
  assert.match(connectionUpdate?.sql??"",/state NOT IN \('PAUSED','REVOKED'\)/u);
});

test("bot action workers reject cross-tenant secret references before network resolution",async()=>{
  const job={id:"action-1",tenantId:"tenant-a",conversationId:"conversation-1",sourceEventId:"event-1",actionNodeId:"lookup",requestInput:{},onSuccessNodeId:"done",onFailureNodeId:"done",attempts:1,fencingToken:1,actionKey:"secure.lookup",kind:"HTTP_JSON",endpointUrl:"https://example.com/action",httpMethod:"POST",authScheme:"BEARER",secretReference:"secret://tenants/tenant-b/bot-actions/api",headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,flowDefinition:{schemaVersion:1,name:"Secure action",start:"lookup",maxSteps:5,nodes:[{id:"lookup",type:"action",actionId:"secure.lookup",input:{},onSuccess:"done",onFailure:"done"},{id:"done",type:"end"}]},conversationVariables:{},zammadTicketId:"42",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",handoffZammadGroupId:"2"};
  const completions=[];let resolutions=0;let networkRequests=0;
  const repository={claimBotActions:async()=>[job],recordBotActionResult:async()=>{},completeBotAction:async(_job,_lease,state,_variables,_advanced,error)=>completions.push({state,error}),claimDeliveries:async()=>[],claimStatuses:async()=>[]};
  const resolver=new SidecarSecretResolver("https://secrets.example/","test-token",false);
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{networkRequests+=1;throw new Error("cross-tenant secret reached the network")};
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async(reference,owner)=>{resolutions+=1;assert.deepEqual(owner,{kind:"bot-action",tenantId:"tenant-a",actionKey:"secure.lookup",actionKind:"HTTP_JSON"});return resolver.resolve(reference,owner)}},{metaGraphVersion:"v24.0"});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{actions:1,deliveries:0,statuses:0});
  }finally{globalThis.fetch=originalFetch}
  assert.equal(resolutions,1);
  assert.equal(networkRequests,0);
  assert.deepEqual(completions,[{state:"FAILED_TERMINAL",error:"Secret reference is outside its owner namespace"}]);
});

test("retryable Meta rejections after send stay outcome-unknown and are never auto-retried",async()=>{
  const originalFetch=globalThis.fetch;
  try{
    for(const [status,graphCode] of [[429,4],[500,2]]){
      const delivery={id:`meta-retryable-${status}`,tenantId:"tenant-a",connectionId:"meta-connection",groupId:"12025550102",recipientType:"DIRECT",text:"hello",contentType:"text/plain",idempotencyKey:`meta-idem-${status}`,attempts:1,provider:"meta",metaCredentialContext:metaContext(),metaDirectRecipientSnapshot:legacyMetaSnapshot(),sessionId:"123456789",connectionSecretReference:"secret://meta",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
      const calls=[];
      const repository={metaInheritedTemplateContext:async(job,lease)=>{assert.equal(job,delivery);assert.equal(typeof lease,"string");return null;},claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>true,assertMetaDeliveryContextCurrent:async()=>{},complete:async()=>calls.push("complete"),fail:async()=>calls.push("retry"),outcomeUnknown:async()=>calls.push("unknown"),claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
      globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:graphCode,type:"OAuthException",message:"Retryable provider rejection"}}),{status,headers:{"content-type":"application/json"}});
      await new DeliveryProcessor(repository,{resolve:async()=>({accessToken:"retryable-token-for-test"})},{metaGraphVersion:"v24.0"}).drainTenant("tenant-a");
      assert.deepEqual(calls,["unknown"]);
    }
  }finally{globalThis.fetch=originalFetch}
});

test("bot action workers fence a revoked shared connection before secret resolution",async()=>{
  const job={id:"action-revoked",tenantId:"tenant-a",conversationId:"conversation-1",sourceEventId:"event-1",actionNodeId:"create",requestInput:{},onSuccessNodeId:"done",onFailureNodeId:"done",attempts:1,fencingToken:1,credentialAvailable:false,actionKey:"notion.create",kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:"secret://tenants/tenant-a/routing/integrations/53000000-0000-4000-8000-000000000001",headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,flowDefinition:{schemaVersion:1,name:"Shared action",start:"create",maxSteps:5,nodes:[{id:"create",type:"action",actionId:"notion.create",input:{},onSuccess:"done",onFailure:"done"},{id:"done",type:"end"}]},conversationVariables:{},zammadTicketId:"42",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",handoffZammadGroupId:"2"};
  const completions=[];let resolutions=0;
  const repository={claimBotActions:async()=>[job],recordBotActionResult:async()=>{},completeBotAction:async(_job,_lease,state,_variables,_advanced,error)=>completions.push({state,error}),claimDeliveries:async()=>[],claimStatuses:async()=>[]};
  const processor=new DeliveryProcessor(repository,{resolve:async()=>{resolutions+=1;return{accessToken:"must-not-be-read"}}},{metaGraphVersion:"v24.0"});
  await processor.drainTenant("tenant-a");
  assert.equal(resolutions,0);
  assert.deepEqual(completions,[{state:"FAILED_TERMINAL",error:"Bot action credential connection is unavailable"}]);
});

test("bot action claims derive shared credential availability from the tenant connection",async()=>{
  let claimSql="";
  const client={query:async sql=>{
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return{rows:[],rowCount:0};
    if(sql.includes("app.claim_bot_action_jobs")){claimSql=sql;return{rows:[],rowCount:0};}
    throw new Error(`Unexpected query: ${sql}`);
  },release:()=>{}};
  const repository=new OutboxRepository({connect:async()=>client});
  assert.deepEqual(await repository.claimBotActions("tenant-a","lease-a"),[]);
  assert.match(claimSql,/client_routing_integrations integration[\s\S]*integration\.tenant_id=job\.tenant_id[\s\S]*integration\.state='CONNECTED'/u);
});

test("a recorded bot action result resumes without calling the external action again",async()=>{
  const job={id:"action-recorded",tenantId:"tenant-a",conversationId:"conversation-1",sourceEventId:"event-1",actionNodeId:"lookup",requestInput:{},onSuccessNodeId:"done",onFailureNodeId:"failed",attempts:2,fencingToken:2,recordedResult:{state:"SUCCEEDED",variables:{"action.status":"shipped"}},actionKey:"secure.lookup",kind:"HTTP_JSON",endpointUrl:"https://example.com/action",httpMethod:"POST",authScheme:"BEARER",secretReference:"secret://tenants/tenant-a/bot-actions/secure.lookup",headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,flowDefinition:{schemaVersion:1,name:"Recorded action",start:"lookup",maxSteps:5,nodes:[{id:"lookup",type:"action",actionId:"secure.lookup",input:{},onSuccess:"done",onFailure:"failed"},{id:"done",type:"end"},{id:"failed",type:"end"}]},conversationVariables:{},zammadTicketId:"42",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",handoffZammadGroupId:"2"};
  const completions=[];let resolutions=0;
  const repository={claimBotActions:async()=>[job],recordBotActionResult:async()=>assert.fail("recorded results must not be replaced"),completeBotAction:async(_job,_lease,state,variables)=>completions.push({state,variables}),claimDeliveries:async()=>[],claimStatuses:async()=>[]};
  const processor=new DeliveryProcessor(repository,{resolve:async()=>{resolutions+=1;return{accessToken:"must-not-be-read"}}},{metaGraphVersion:"v24.0"});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{actions:1,deliveries:0,statuses:0});
  assert.equal(resolutions,0);
  assert.deepEqual(completions,[{state:"SUCCEEDED",variables:{"action.status":"shipped"}}]);
});

test("Notion actions can reuse one tenant-scoped connected account without broadening other actions",()=>{
  const integration="secret://tenants/tenant-a/routing/integrations/53000000-0000-4000-8000-000000000001";
  const versioned=`secret://tenants/tenant-a/bot-actions/orders.lookup/credentials/${"a".repeat(64)}`;
  assert.equal(isBotActionSecretReference("tenant-a","HTTP_JSON","secret://tenants/tenant-a/bot-actions/orders.lookup","orders.lookup"),true);
  assert.equal(isBotActionSecretReference("tenant-a","HTTP_JSON",versioned,"orders.lookup"),true);
  assert.equal(isBotActionSecretReference("tenant-a","HTTP_JSON",`${versioned}extra`,"orders.lookup"),false);
  assert.equal(isBotActionSecretReference("tenant-a","HTTP_JSON","secret://tenants/tenant-a/bot-actions/private.credential","orders.lookup"),false);
  assert.equal(isBotActionSecretReference("tenant-a","NOTION_CREATE_PAGE","secret://tenants/tenant-a/bot-actions/notion.create_case","notion.create_case"),true);
  assert.equal(isBotActionSecretReference("tenant-a","NOTION_CREATE_PAGE","secret://tenants/tenant-a/bot-actions/private.credential","notion.create_case"),false);
  assert.equal(isBotActionSecretReference("tenant-a","NOTION_CREATE_PAGE",integration,"notion.create_case"),true);
  assert.equal(isBotActionSecretReference("tenant-a","HTTP_JSON",integration,"orders.lookup"),false);
  assert.equal(isBotActionSecretReference("tenant-b","NOTION_CREATE_PAGE",integration,"notion.create_case"),false);
  assert.equal(isBotActionSecretReference("tenant-a","NOTION_CREATE_PAGE","secret://tenants/tenant-a/routing/integrations/not-a-uuid","notion.create_case"),false);
});

test("qualification actions complete durably without projecting bot replies into Zammad",async()=>{
  const job={origin:"QUALIFICATION",id:"qualification-1",tenantId:"tenant-a",actionNodeId:"qualification",requestInput:{order_id:"42"},onSuccessNodeId:"qualification",onFailureNodeId:"qualification",attempts:1,fencingToken:1,credentialAvailable:true,recordedResult:{state:"SUCCEEDED",variables:{"action.status":"ready"}},actionKey:"orders.lookup",kind:"HTTP_JSON",endpointUrl:"https://api.example.test/status",httpMethod:"GET",authScheme:"NONE",headers:{},responseMapping:{"action.status":"/status"},timeoutMs:5000,maxResponseBytes:2048};
  const completions=[];let secretReads=0;
  const repository={claimBotActions:async()=>[job],recordBotActionResult:async()=>assert.fail("recorded result must not be replaced"),completeBotActionQualification:async(_job,_lease,state,variables,error)=>completions.push({state,variables,error}),completeBotAction:async()=>assert.fail("qualification must not advance a conversation"),claimDeliveries:async()=>[],claimStatuses:async()=>[]};
  const processor=new DeliveryProcessor(repository,{resolve:async()=>{secretReads+=1;return{token:"must-not-be-read"}}},{metaGraphVersion:"v24.0"});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{actions:1,deliveries:0,statuses:0});
  assert.equal(secretReads,0);
  assert.deepEqual(completions,[{state:"SUCCEEDED",variables:{"action.status":"ready"},error:undefined}]);
});

test("human handoff retries after a local completion failure without duplicating its Zammad note",async()=>{
  const baseJob={id:"handoff-1",tenantId:"tenant-a",conversationId:"conversation-1",handoffNodeId:"agent",zammadGroupId:"2",zammadOwnerId:"17",priority:"3 high",fencingToken:1,zammadTicketId:"42",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
  let claim=0,completed=0,retried=0,routeUpdates=0,noteCreates=0,noteExists=false;
  const repository={
    claimBotHandoffs:async()=>[{...baseJob,attempts:++claim}],claimBotActions:async()=>[],claimDeliveries:async()=>[],claimStatuses:async()=>[],
    assertBotHandoffIdentityCurrent:async(job,lease)=>{assert.equal(job.id,baseJob.id);assert.equal(job.tenantId,baseJob.tenantId);assert(lease);},
    completeBotHandoff:async()=>{if(!completed++)throw new Error("database temporarily unavailable")},
    retryBotHandoff:async()=>{retried+=1},failBotHandoff:async()=>{throw new Error("handoff must remain retryable")},
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==="/api/v1/tickets/42"&&init?.method==="PUT"){routeUpdates+=1;assert.deepEqual(JSON.parse(String(init.body)),{group_id:2,owner_id:17,priority:"3 high",state:"open"});return Response.json({id:42})}
    if(url.pathname==="/api/v1/tickets/42"&&!init?.method)return Response.json({id:42,state:"open",title:"Synthetic handoff",group_id:2,owner_id:17});
    if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json(noteExists?[{id:91,preferences:{wasalx_handoff_key:"bot-handoff:handoff-1"}}]:[]);
    if(url.pathname==="/api/v1/ticket_articles"&&init?.method==="POST"){noteCreates+=1;noteExists=true;return Response.json({id:91})}
    throw new Error(`unexpected ${url}`);
  };
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async()=>({token:"zammad-token"})},{metaGraphVersion:"v24.0"});
    await processor.drainTenant("tenant-a");
    await processor.drainTenant("tenant-a");
    assert.equal(retried,1);
    assert.equal(completed,2);
    assert.equal(routeUpdates,2);
    assert.equal(noteCreates,1);
  }finally{globalThis.fetch=originalFetch}
});

test("drains bot deliveries before claiming human handoff work",async()=>{
  const calls=[];
  const repository={
    claimBotActions:async()=>[],
    claimDeliveries:async()=>{calls.push("deliveries");return[]},
    claimBotHandoffs:async()=>{calls.push("handoffs");return[]},
    claimStatuses:async()=>[],
  };
  const processor=new DeliveryProcessor(repository,{resolve:async()=>({})},{metaGraphVersion:"v24.0"});
  await processor.drainTenant("tenant-a");
  assert.deepEqual(calls,["deliveries","handoffs"]);
});

test("handoff success requires actual native group and explicit owner; legacy omitted owner preserves native defaults",async()=>{
  const original=globalThis.fetch;
  try{for(const scenario of [{owner:"17",observedGroup:2,observedOwner:17,pass:true},{owner:"17",observedGroup:3,observedOwner:17,pass:false},{owner:"17",observedGroup:2,observedOwner:18,pass:false},{owner:undefined,observedGroup:2,observedOwner:18,pass:true}]){
    const calls=[],job={id:"handoff-readback",tenantId:"tenant-a",conversationId:"conversation",handoffNodeId:"handoff",zammadGroupId:"2",zammadOwnerId:scenario.owner,priority:"2 normal",attempts:1,fencingToken:1,zammadTicketId:"42",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
    const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[],claimStatuses:async()=>[],claimBotHandoffs:async()=>[job],assertBotHandoffIdentityCurrent:async()=>{},completeBotHandoff:async()=>calls.push("complete"),retryBotHandoff:async()=>assert.fail("Mismatch is terminal, not an automatic overwrite retry"),failBotHandoff:async(_job,_lease,error)=>{assert.equal(error,"Native handoff assignment could not be verified");calls.push("failed");}};
    globalThis.fetch=async(input,init)=>{
      const path=new URL(String(input)).pathname;
      if(path==="/api/v1/tickets/42"&&init.method==="PUT"){const body=JSON.parse(init.body);assert.equal(body.owner_id,scenario.owner?Number(scenario.owner):undefined);return Response.json({id:42});}
      if(path==="/api/v1/tickets/42")return Response.json({id:42,state:"open",title:"Synthetic",group_id:scenario.observedGroup,owner_id:scenario.observedOwner});
      if(path==="/api/v1/ticket_articles/by_ticket/42")return Response.json([{id:1,preferences:{wasalx_handoff_key:"bot-handoff:handoff-readback"}}]);
      assert.fail("Unexpected native write");
    };
    await new DeliveryProcessor(repository,{resolve:async()=>({token:"synthetic"})},{metaGraphVersion:"v24.0"}).drainTenant("tenant-a");
    assert.deepEqual(calls,[scenario.pass?"complete":"failed"]);
  }}finally{globalThis.fetch=original;}
});

for (const [participant,reprocess] of [["12025550132@c.us",false],["987654321@lid",false],["987654321@lid",true]]) test(`durable inbound customer and article identity: ${participant}, reprocess=${reprocess}`,async()=>{
  const event={id:"event-row",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-1",eventType:"message",attempts:1,payload:{id:"evt-1",event:"message",payload:{id:"message-1",chatId:"447700900001@g.us",participant,notifyName:"Customer One",body:"Shipment ١٢٣٤٥٦٧٨٩٠",source:"app",fromMe:false,timestamp:1_700_000_000}}};
  if(reprocess){event.eventType="quarantine.reprocess";event.payload={quarantineId:"review-id",externalGroupId:"447700900001@g.us",normalizedReference:"1234567890",ruleId:"rule-1",requestedAt:"2026-09-10T00:00:00Z"};}
  const externalMessageId=reprocess?"review:review-id:event-row":"message-1";
  const context={...(participant.endsWith("@lid")?{participantPhone:"+12025550132"}:{}),bindingId:"binding-1",groupId:"447700900001@g.us",groupName:"Example Workshop",zammadGroup:"Operations",acknowledgementTemplate:"Cases {{tickets}} ({{count}})",groupDisclosureEnabled:true,groupDisclosureMessage:"Matched messages may be copied to our case system.",maxIdentifiers:20,agentPrefix:"Agent",ruleVersion:3,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://tenants/tenant-a/zammad/service",rules:[{id:"rule-1",name:"Shipment ID",matcherType:"exact_length",pattern:"(?<!\\d)\\d{10}(?!\\d)",prefix:null,digitLength:10,priority:1,enabled:true,version:3}]};
  const calls=[];
  const repository={originalReprocessParticipant:async()=>({replyToMessageId:"message-1",participantId:participant,participantName:"Customer One",fromApi:false,fromMe:false}),completeQuarantineReprocess:async(_event,tickets)=>assert.deepEqual(tickets,["42"]),claim:async()=>[event],context:async()=>context,ticketsForQuotedMessage:async()=>[],normalize:async()=>"new",linkZammadCustomer:async(_event,_message,customer)=>calls.push(`customer-link:${customer.id}:${customer.login}`),correlate:async(_event,_context,_message,reference,actions,expectedTicketId,matchesReference)=>{assert.equal(expectedTicketId,undefined);assert.equal(matchesReference,true);calls.push(`reference:${reference}`);return actions.create("tenant-a:binding-1:1234567890")},enqueueAcknowledgement:async(_event,_context,_message,text,ticketIds,disclosure,replyToMessageId,commandResponse)=>{assert.equal(replyToMessageId,reprocess?"message-1":undefined);assert.equal(commandResponse,false);calls.push(`ack:${text}${disclosure?`\n\n${disclosure}`:""}:${ticketIds.join(",")}`);return"delivery-1"},complete:async(_event,_lease,status,redact)=>calls.push(`complete:${status}:${redact}`),fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)},updateConnectionState:async()=>{},linkQuotedMessage:async()=>{}};
  const originalFetch=globalThis.fetch;
  let customerLogin;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url==="https://secrets.example/v1/resolve"){
      assert.deepEqual(JSON.parse(init.body),{reference:context.zammadSecretReference});
      return Response.json({token:"zammad-token",bootstrap_password:"provisioner-only",jwt_secret:"signing-key",instance_id:"instance-1"});
    }
    if(url.includes("/users/search"))return new Response(JSON.stringify([]),{status:200});
    if(url.endsWith("/api/v1/users")&&init?.method==="POST"){
      const body=JSON.parse(String(init.body));
      customerLogin=body.login;
      assert.match(body.login,/^wasalx-[0-9a-f]{64}$/);
      assert.equal(body.firstname,"Customer One");
      assert.equal(body.mobile,"+12025550132");
      assert.equal("email" in body,false);
      assert.doesNotMatch(body.login,/@|customer|tenant-a/);
      return new Response(JSON.stringify({id:7,login:body.login,firstname:body.firstname,lastname:"",email:""}),{status:201});
    }
    if(url.includes("/tickets/search"))return new Response(JSON.stringify([]),{status:200});
    if(url.endsWith("/api/v1/tickets")&&init?.method==="POST"){
      const body=JSON.parse(String(init.body));
      assert.equal(body.customer_id,7);
      assert.equal("customer" in body,false);
      assert.equal(body.title,"Example Workshop — Shipment ID: 1234567890");
      assert.deepEqual(body.article.preferences,{wasalx_origin:"provider",wasalx_external_message_id:externalMessageId,wasalx_sender_name:"Customer One",wasalx_sender_phone:"+12025550132"});
      calls.push(`create:${body.wasalx_reference}:${body.wasalx_rule_version}`);
      return new Response(JSON.stringify({id:42,number:"10382",state:"open",group:"Operations",title:"Case"}),{status:201});
    }
    if(url.endsWith("/api/v1/ticket_articles/by_ticket/42"))return Response.json([{id:90,preferences:{wasalx_external_message_id:externalMessageId}}]);
    throw new Error(`unexpected ${url}`);
  };
  try{
    const processor=new InboundProcessor(repository,new SidecarSecretResolver("https://secrets.example","read-token",true));
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:1});
    assert.deepEqual(calls,[`customer-link:7:${customerLogin}`,"reference:1234567890","create:1234567890:3","ack:Cases 10382 (1)\n\nMatched messages may be copied to our case system.:42","complete:PROCESSED:false"]);
  }finally{globalThis.fetch=originalFetch}
});

test("manual provider messages appended to existing cases carry the canonical feedback-loop marker",async()=>{
  const event={id:"event-manual",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-manual",eventType:"message",attempts:1,payload:{event:"message.any",payload:{id:"manual-message-1",from:"447700900001@g.us",participant:"447700900007@c.us",body:"Update 1234567890",fromMe:true,source:"app",timestamp:1_700_000_000}}};
  const context={bindingId:"binding-1",groupId:"447700900001@g.us",connectionName:"Operations line",connectionPhone:"+12025550133",zammadGroup:"Operations",acknowledgementTemplate:"{{tickets}}",maxIdentifiers:20,agentPrefix:"Agent",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",rules:[{id:"rule-1",name:"Ten digits",matcherType:"exact_length",pattern:"",prefix:null,digitLength:10,priority:1,enabled:true,version:1}]};
  const repository={claim:async()=>[event],context:async()=>context,ticketsForQuotedMessage:async()=>[],normalize:async()=>"new",linkZammadCustomer:async()=>{},correlate:async(_event,_context,_message,_reference,actions)=>{await actions.append("42");return{id:"42",number:"10382"}},enqueueAcknowledgement:async()=>{throw new Error("manual messages must not enqueue acknowledgements")},complete:async()=>{},fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)}};
  const originalFetch=globalThis.fetch;let customerLogin;
  let article;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith("/api/v1/users/8")&&(!init?.method||init.method==="GET"))return Response.json({id:8,login:customerLogin,firstname:"WhatsApp participant",lastname:""});
    if(url.includes("/users/search")){const query=new URL(url).searchParams.get("query");const login=query?.slice("login:".length);customerLogin=login;return new Response(JSON.stringify([{id:8,login,firstname:"WhatsApp participant",lastname:""}]),{status:200})}
    if(url.endsWith("/api/v1/users/8")&&init?.method==="PUT")return Response.json({id:8,...JSON.parse(String(init.body))});
    if(url.endsWith("/api/v1/ticket_articles")&&init?.method==="POST"){article=JSON.parse(String(init.body));return new Response(JSON.stringify({id:91}),{status:201})}
    if(url.endsWith("/api/v1/ticket_articles/by_ticket/42"))return Response.json([]);
    throw new Error(`unexpected ${url}`);
  };
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.equal(article.sender,"Agent");
    assert.equal(article.subject,"WhatsApp · Operations line · +12025550133");
    assert.deepEqual(article.preferences,{wasalx_origin:"provider",wasalx_external_message_id:"manual-message-1",wasalx_sender_name:"Operations line",wasalx_sender_phone:context.connectionPhone});
  }finally{globalThis.fetch=originalFetch}
});

test("production inbound correlates every distinct permitted reference and queues one acknowledgement", async (t) => {
  for (const scenario of [
    { name: "customer with excluded-team rules", sender: "customer", policies: ["exclude", "exclude"], expected: ["1234567890", "ABC7654321"] },
    { name: "team with mixed policies", sender: "team", policies: ["exclude", "include"], expected: ["ABC7654321"] },
    { name: "unknown sender with mixed policies", sender: "unknown", policies: ["exclude", "include"], expected: ["ABC7654321"] },
  ]) await t.test(scenario.name, async () => {
    const result = await correlationRuntime({ ...scenario, body: "Shipment ١٢٣٤٥٦٧٨٩٠ and ABC7654321 and ABC7654321" });
    assert.deepEqual(result.references, scenario.expected);
    assert.equal(result.acknowledgements.length, 1);
    assert.deepEqual(result.acknowledgements[0], {
      text: `Cases ${scenario.expected.map((_, index) => `10${index + 1}`).join(", ")} (${scenario.expected.length})`,
      ticketIds: scenario.expected.map((_, index) => String(index + 1)),
    });
    assert.deepEqual(result.completed, [{ status: "PROCESSED", redact: false, reason: undefined }]);
  });
});

test("production inbound blocks excluded sender quote fallbacks before credentials or ticket lookup", async (t) => {
  for (const sender of ["team", "unknown"]) {
    for (const policies of [["exclude", "exclude"], ["exclude", "include"]]) {
      for (const body of ["Please update", "1234567890"]) await t.test(`${sender} ${policies.join("/")} ${body}`, async () => {
        const result = await correlationRuntime({ sender, policies, body, quotedMessageId: "previous-message", blocked: true });
        assert.deepEqual(result.references, []);
        assert.deepEqual(result.acknowledgements, []);
        assert.deepEqual(result.completed, [{ status: "UNMATCHED", redact: true, reason: "TEAM_SENDER_EXCLUDED" }]);
      });
    }
  }
});

test("production inbound quarantines identifier floods and truncated matches before ticket effects", async (t) => {
  for (const [name, body] of [
    ["distinct identifier flood", Array.from({ length: 21 }, (_, index) => String(1000000000 + index)).join(" ")],
    ["repeated identifier limit with later distinct identifier", `${Array(1_001).fill("1234567890").join(" ")} ABC7654321`],
  ]) await t.test(name, async () => {
    const result = await correlationRuntime({ body, blocked: true });
    assert.deepEqual(result.references, []);
    assert.deepEqual(result.acknowledgements, []);
    assert.deepEqual(result.quarantines.map(({ reasonCode }) => reasonCode), ["IDENTIFIER_LIMIT_EXCEEDED"]);
    assert.deepEqual(result.completed, [{ status: "QUARANTINED", redact: true, reason: "IDENTIFIER_LIMIT_EXCEEDED" }]);
  });
});

test("production inbound ignores provider API feedback before routing or credentials", async () => {
  const result = await correlationRuntime({ body: "1234567890", fromApi: true, blocked: true });
  assert.deepEqual(result.references, []);
  assert.deepEqual(result.acknowledgements, []);
  assert.deepEqual(result.completed, [{ status: "IGNORED", redact: true, reason: "PROVIDER_API_MESSAGE" }]);
});

async function correlationRuntime({ body, sender = "unknown", policies = ["include", "include"], quotedMessageId, fromApi = false, blocked = false }) {
  const event = { id: "event-correlation-runtime", tenantId: "tenant-a", connectionId: "c1", provider: "waha", providerEventId: "correlation-runtime", eventType: "message", attempts: 1,
    payload: { event: "message", payload: { id: "correlation-message", chatId: "447700900001@g.us", participant: "447700900002@c.us", body, source: fromApi ? "api" : "app", timestamp: 1_700_000_000, ...(quotedMessageId ? { replyTo: quotedMessageId } : {}) } } };
  const rules = [
    { id: "digits", name: "Ten digits", matcherType: "exact_length", prefix: null, digitLength: 10, pattern: "", priority: 1, teamSenderPolicy: policies[0], enabled: true, version: 1 },
    { id: "abc", name: "ABC", matcherType: "prefix_length", prefix: "ABC", digitLength: 7, pattern: "", priority: 2, teamSenderPolicy: policies[1], enabled: true, version: 1 },
  ];
  const context = { bindingId: "binding-1", groupId: "447700900001@g.us", zammadGroup: "Operations", acknowledgementTemplate: "Cases {{tickets}} ({{count}})", maxIdentifiers: 20, agentPrefix: "Agent", ruleVersion: 1, zammadBaseUrl: "https://zammad.example", zammadSecretReference: "secret://zammad", rules };
  const references = [], acknowledgements = [], completed = [], quarantines = [];
  const repository = {
    claim: async () => [event], context: async () => { assert.equal(fromApi, false); return context; }, groupRuleSender: async () => sender,
    normalize: async () => "new", linkZammadCustomer: async () => {},
    ticketsForQuotedMessage: async () => assert.fail("excluded sender must not resolve a quote"),
    correlate: async (_event, _context, _message, reference) => { assert.equal(blocked, false); references.push(reference); return { id: String(references.length), number: `10${references.length}` }; },
    enqueueAcknowledgement: async (_event, _context, _message, text, ticketIds) => { acknowledgements.push({ text, ticketIds }); return "acknowledgement"; },
    quarantineInbound: async (_event, record) => quarantines.push(record),
    complete: async (_event, _lease, status, redact, reason) => completed.push({ status, redact, reason }),
    fail: async (_event, _lease, _retryable, error) => assert.fail(`unexpected inbound failure: ${error}`),
  };
  const originalFetch = globalThis.fetch;
  let customerLogin;
  globalThis.fetch = async (input) => {
    assert.equal(blocked, false, "blocked messages must not make native requests");
    const url = new URL(input);
    if (url.pathname === "/api/v1/users/search") {
      customerLogin = url.searchParams.get("query").slice("login:".length);
      return Response.json([{ id: 7, login: customerLogin, firstname: "Customer", lastname: "" }]);
    }
    assert.equal(url.pathname, "/api/v1/users/7");
    return Response.json({ id: 7, login: customerLogin, firstname: "Customer", lastname: "" });
  };
  try {
    await new InboundProcessor(repository, { resolve: async () => { assert.equal(blocked, false, "blocked messages must not resolve credentials"); return { token: "zammad-token" }; } }).drainTenant("tenant-a");
  } finally { globalThis.fetch = originalFetch; }
  return { references, acknowledgements, completed, quarantines };
}

test("unmatched inbound bodies are redacted without creating normalized-message rows",async()=>{const event={id:"event-unmatched",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-2",eventType:"message",attempts:1,payload:{id:"evt-2",event:"message",payload:{id:"message-2",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"hello team",source:"app",timestamp:1_700_000_000}}};const calls=[];const repository={claim:async()=>[event],context:async()=>({bindingId:"binding-1",groupId:"447700900001@g.us",zammadGroup:"Operations",acknowledgementTemplate:"Cases {{tickets}}",maxIdentifiers:20,agentPrefix:"Agent",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",rules:[{id:"rule-1",name:"Ten digits",matcherType:"exact_length",pattern:"",prefix:null,digitLength:10,priority:1,enabled:true,version:1}]}),ticketsForQuotedMessage:async()=>[],normalize:async(_event,_message,captureOnly)=>{assert.equal(captureOnly,true);return"skipped"},complete:async(_event,_lease,status,redact)=>calls.push({status,redact}),fail:async()=>{},updateConnectionState:async()=>{}};const processor=new InboundProcessor(repository,{resolve:async()=>{throw new Error("must not resolve")}});assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});assert.deepEqual(calls,[{status:"UNMATCHED",redact:true}])});

test("opted-in group history captures unmatched messages without an automation binding",async()=>{const event={id:"event-history",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-history",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"message-history",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"hello team",source:"app",timestamp:1_700_000_000}}};const calls=[];const repository={claim:async()=>[event],normalize:async(_event,_message,captureOnly)=>{assert.equal(captureOnly,true);calls.push("captured");return"new"},context:async()=>null,complete:async(_event,_lease,status,redact)=>calls.push(`${status}:${redact}`),fail:async()=>{}};const processor=new InboundProcessor(repository,{resolve:async()=>{throw new Error("must not resolve")}});assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});assert.deepEqual(calls,["captured","UNMATCHED:true"])});

test("group reactions are captured as history without running rules or creating tickets",async()=>{const event={id:"event-reaction",tenantId:"tenant-a",connectionId:"c1",provider:"meta",providerEventId:"evt-reaction",eventType:"messages",attempts:1,payload:{entry:[{changes:[{value:{messages:[{id:"reaction-1",group_id:"group-1",from:"12025550102",timestamp:"1700000000",type:"reaction",reaction:{message_id:"message-1",emoji:"✅"}}]}}]}]}};const calls=[];const repository={claim:async()=>[event],normalize:async(_event,message,captureOnly)=>{assert.equal(message.eventKind,"REACTION");assert.equal(captureOnly,true);calls.push("captured");return"new"},context:async()=>assert.fail("Reactions must not run routing"),complete:async(_event,_lease,status,redact,reason)=>calls.push(`${status}:${redact}:${reason}`),fail:async()=>assert.fail("Reaction capture must not fail")};const processor=new InboundProcessor(repository,{resolve:async()=>assert.fail("Reactions must not resolve ticket credentials")});assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});assert.deepEqual(calls,["captured","PROCESSED:true:REACTION_RECORDED"])});

for (const quoted of [false,true,"unmatched"]) test(`case follow-up distinguishes explicit case number and quoted trigger context: ${quoted}`,async()=>{
  const event={id:"event-case-follow-up",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-case-follow-up",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"message-case-follow-up",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"Please update Case ١٠٣٨٢",source:"app",timestamp:1_700_000_000}}};
  if(quoted){event.payload.payload.body=quoted===true?"Shipment 1234567890":"Please update";event.payload.payload.replyTo="prior-message";}
  const context={bindingId:"binding-1",groupId:"447700900001@g.us",zammadGroup:"Operations",acknowledgementTemplate:"Cases {{tickets}}",maxIdentifiers:20,agentPrefix:"Agent",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",rules:[{id:"rule-1",name:"Ten digits",matcherType:"exact_length",pattern:"",prefix:null,digitLength:10,priority:1,enabled:true,version:1}]};
  const calls=[];
  const repository={
    claim:async()=>[event],context:async()=>context,ticketsForQuotedMessage:async()=>quoted?["42"]:[],
    ticketsForCaseNumbers:async(_event,actualContext,numbers)=>{assert.equal(actualContext.bindingId,"binding-1");assert.deepEqual(numbers,["10382"]);return["42"]},
    normalize:async()=>"new",linkZammadCustomer:async()=>calls.push("customer-linked"),
    linkQuotedMessage:async(_event,_message,ticketId,_context,_actions,matchedReferences)=>{assert.deepEqual(matchedReferences,quoted===true?["1234567890"]:[]);calls.push(`case-linked:${ticketId}`)},
    complete:async(_event,_lease,status,redact)=>calls.push(`complete:${status}:${redact}`),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)},
  };
  const originalFetch=globalThis.fetch;let customerLogin;
  globalThis.fetch=async(input)=>{
    const url=String(input);
    if(url.endsWith("/api/v1/users/7"))return Response.json({id:7,login:customerLogin,firstname:"Customer",lastname:""});
    if(url.includes("/users/search")){
      const query=new URL(url).searchParams.get("query");
      const login=query?.slice("login:".length);customerLogin=login;
      return new Response(JSON.stringify([{id:7,login,firstname:"Customer",lastname:""}]),{status:200});
    }
    throw new Error(`unexpected ${url}`);
  };
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.deepEqual(calls,["customer-linked","case-linked:42","complete:PROCESSED:false"]);
  }finally{globalThis.fetch=originalFetch}
});

test("WAHA session status carries an opaque generation and signed provider timestamp into the database fence",async()=>{const event={id:"event-status",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-status-1",eventType:"session.status",attempts:1,payload:{id:"evt-status-1",event:"session.status",session:"wx_generation_2",timestamp:1_786_291_200_000,payload:{status:"STOPPED"}}};const calls=[];const repository={claim:async()=>[event],applyProviderStatus:async(_event,observation)=>{calls.push(observation);return"APPLIED"},complete:async(_event,_lease,status,redact)=>calls.push({status,redact}),fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)}};const processor=new InboundProcessor(repository,{resolve:async()=>{throw new Error("status must not resolve secrets")}});assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});assert.deepEqual(calls,[{opaqueSessionId:"wx_generation_2",observedAt:"2026-08-09T16:00:00.000Z",providerState:"STOPPED",connectionState:"ACTION_REQUIRED",reason:"Provider session reported STOPPED"},{status:"PROCESSED",redact:true}])});

test("WAHA WORKING status verifies identity on the pinned worker before database activation",async()=>{
  const event={id:"event-working",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-working-1",eventType:"session.status",attempts:1,payload:{id:"evt-working-1",event:"session.status",session:"wx_generation_3",timestamp:1_786_291_200_000,payload:{status:"WORKING"}}};
  const calls=[];
  const repository={
    claim:async()=>[event],
    wahaIdentityContext:async()=>({providerSessionId:"session-row",opaqueSessionId:"wx_generation_3",wahaWorkerId:"54000000-0000-4000-8000-000000000001",baseUrl:"http://waha-test.internal:3000/",secretReference:"secret://waha-admin"}),
    applyProviderStatus:async(_event,observation,identity)=>{calls.push({observation,identity});return"DUPLICATE_IDENTITY"},
    complete:async(_event,_lease,status,redact)=>calls.push({status,redact}),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)},
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({id:"12025550131@s.whatsapp.net"});
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({apiKey:"waha-admin-key"})});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  }finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,[{
    observation:{opaqueSessionId:"wx_generation_3",observedAt:"2026-08-09T16:00:00.000Z",providerState:"WORKING",connectionState:"WORKING",reason:undefined},
    identity:{phoneE164:"+12025550131",pinnedWahaWorkerId:"54000000-0000-4000-8000-000000000001"},
  },{status:"PROCESSED",redact:true}]);
});

test("group commands execute one pinned POST action and retain the reply in the case transcript",async()=>{
  const event={id:"event-command",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-command",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"message-command",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"/status ORD-42",source:"app",timestamp:1_700_000_000}}};
  const command={actionId:"orders.status",input:{reference:"{{message.argument}}",provider:"{{channel.provider}}",group:"{{group.name}}",customer:"{{customer.login}}"},successReply:"Order {{action.state}} · case {{ticket.number}}",failureReply:"Lookup failed: {{action.error}}"};
  const context={bindingId:"binding-1",groupId:"447700900001@g.us",groupName:"Example Workshop",zammadGroup:"Operations",acknowledgementTemplate:"unused",groupDisclosureEnabled:false,groupDisclosureMessage:null,maxIdentifiers:20,agentPrefix:"Agent",ruleSetId:"set-1",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",rules:[{id:"rule-command",name:"Order status",matcherType:"starts_with",pattern:"/status",prefix:null,digitLength:null,priority:1,enabled:true,version:1,groupCommand:command}]};
  const calls=[];
  const action={actionId:"orders.status",actionDefinitionId:"action-definition-1",revision:3,kind:"HTTP_JSON",endpointUrl:"https://orders.example/status",httpMethod:"POST",authScheme:"NONE",headers:{},responseMapping:{"action.state":"/state"},timeoutMs:5000,maxResponseBytes:2048};
  const repository={claim:async()=>[event],context:async()=>context,ticketsForQuotedMessage:async()=>[],normalize:async()=>"new",linkZammadCustomer:async()=>{},correlate:async(_event,_context,_message,reference,actions,_expectedTicketId,matchesReference)=>{assert.equal(matchesReference,false);assert.equal(reference,"/STATUS");return actions.create("command-correlation")},beginGroupCommandAction:async(_event,ruleId,actionId,requestInput)=>{assert.equal(ruleId,"rule-command");assert.equal(actionId,"orders.status");assert.deepEqual(requestInput,{reference:"ORD-42",provider:"waha",group:"Example Workshop",customer:"customer"});return{id:"execution-1",state:"PREPARED",attempts:0,action,requestInput,responseVariables:{}}},claimGroupCommandAction:async()=>({id:"execution-1",state:"RUNNING",attempts:1,action,requestInput:{reference:"ORD-42",provider:"waha",group:"Example Workshop",customer:"customer"},responseVariables:{}}),completeGroupCommandAction:async(_event,_id,_ruleId,result)=>({id:"execution-1",state:result.state,attempts:1,action,requestInput:{},responseVariables:result.state==="SUCCEEDED"?result.variables:{},...(result.state==="SUCCEEDED"?{}:{safeError:result.safeError})}),enqueueAcknowledgement:async(_event,_context,_message,text)=>{calls.push(`delivery:${text}`);return"delivery-1"},complete:async(_event,_lease,status)=>calls.push(`complete:${status}`),fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure ${error}`)}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes("/users/search"))return Response.json([]);if(url.endsWith("/api/v1/users")&&init?.method==="POST")return Response.json({id:7,login:"customer",firstname:"Customer",lastname:""},{status:201});if(url.includes("/tickets/search"))return Response.json([]);if(url.endsWith("/api/v1/tickets")&&init?.method==="POST")return Response.json({id:42,number:"10382",state:"open",group:"Operations",title:"Case"},{status:201});if(url.endsWith("/api/v1/ticket_articles/by_ticket/42"))return Response.json([]);if(url.endsWith("/api/v1/ticket_articles")&&init?.method==="POST"){const body=JSON.parse(String(init.body));assert.equal(body.body,"Order ready · case 10382");assert.equal(body.preferences.wasalx_group_command_key,"group-command:event-command:rule-command");calls.push("transcript");return Response.json({id:91},{status:201})}throw new Error(`unexpected ${url}`)};
  const transport=async(_url,method,headers,body)=>{assert.equal(method,"POST");assert.deepEqual(JSON.parse(body),{reference:"ORD-42",provider:"waha",group:"Example Workshop",customer:"customer"});assert.equal(headers["idempotency-key"],"bot-action:execution-1");return{status:200,headers:{},body:JSON.stringify({state:"ready"})}};
  try{assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})},undefined,8,transport).drainTenant("tenant-a"),{events:1,acknowledgements:1})}finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,["transcript","delivery:Order ready · case 10382","complete:PROCESSED"]);
});

test("group command executions snapshot the rule-set-pinned action revision without a transport-specific query",async()=>{
  let definitionSql="";let inserted=[];
  const pinnedRevisionId="45100000-0000-4000-8000-000000000031";
  const client={query:async(sql,values=[])=>{
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return{rows:[],rowCount:0};
    if(sql.includes("FROM group_action_executions"))return{rows:[],rowCount:0};
    if(sql.includes("JOIN bot_action_definitions")){
      definitionSql=sql;
      return{rows:[{id:"action-notion",action_revision_id:pinnedRevisionId,action_key:"notion.create_case",revision:4,kind:"NOTION_CREATE_PAGE",endpoint_url:"https://api.notion.com/v1/pages",http_method:"POST",auth_scheme:"BEARER",secret_reference:"secret://tenants/tenant-a/bot-actions/notion.create_case",headers:{},response_mapping:{"action.page_url":"/url"},timeout_ms:5000,max_response_bytes:262144}],rowCount:1};
    }
    if(sql.includes("INSERT INTO group_action_executions")){
      inserted=values;
      return{rows:[{id:"execution-notion",state:"PREPARED",attempts:0,action_snapshot:values[7],request_input:values[8],response_variables:null,safe_error:null,request_sha256:values[9]}],rowCount:1};
    }
    throw new Error(`Unexpected query: ${sql}`);
  },release:()=>{}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"event-notion",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"provider-event-notion",eventType:"message",attempts:1,payload:{}};
  const requestInput={parent_type:"page_id",parent_id:"123456781234123412341234567890ab",title:"Case ORD-42"};
  const execution=await repository.beginGroupCommandAction(event,"rule-notion","notion.create_case",requestInput,3);
  assert.equal(execution?.action.kind,"NOTION_CREATE_PAGE");
  assert.equal(execution?.action.httpMethod,"POST");
  assert.equal(execution?.action.revision,4);
  assert.equal(execution?.action.secretReference,"secret://tenants/tenant-a/bot-actions/notion.create_case");
  assert.deepEqual(execution?.requestInput,requestInput);
  assert.equal(inserted[4],pinnedRevisionId);
  assert.equal(inserted[6],4);
  assert.match(definitionSql,/JOIN automation_action_revision_pins pin[\s\S]*pin\.rule_set_id=rule\.rule_set_id/u);
  assert.match(definitionSql,/revision\.id=pin\.action_revision_id/u);
  assert.doesNotMatch(definitionSql,/kind='HTTP_JSON'|http_method='GET'/u);
});

test("a prepared group action retires when its shared connection is revoked",async()=>{
  const reference="secret://tenants/tenant-a/routing/integrations/53000000-0000-4000-8000-000000000001";
  const requestSha256=createHash("sha256").update("[]").digest("hex");
  const snapshot={actionId:"notion.create_case",actionDefinitionId:"action-notion",revision:4,kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:reference,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:262144};
  const client={query:async(sql,values=[])=>{
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return{rows:[],rowCount:0};
    if(sql.includes("FROM group_action_executions")&&sql.includes("FOR UPDATE"))return{rows:[{id:"execution-revoked",state:"PREPARED",attempts:0,action_snapshot:snapshot,request_input:{},response_variables:null,safe_error:null,request_sha256:requestSha256}],rowCount:1};
    if(sql.includes("FROM client_routing_integrations")){assert.deepEqual(values,["tenant-a",reference]);return{rows:[],rowCount:0};}
    if(sql.includes("UPDATE group_action_executions"))return{rows:[{id:"execution-revoked",state:"FAILED_TERMINAL",attempts:0,action_snapshot:snapshot,request_input:{},response_variables:null,safe_error:"Group action credential connection is unavailable",request_sha256:requestSha256}],rowCount:1};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  },release:()=>{}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"event-revoked",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"provider-event-revoked",eventType:"message",attempts:2,payload:{}};
  const execution=await repository.beginGroupCommandAction(event,"rule-notion","notion.create_case",{},3);
  assert.equal(execution?.state,"FAILED_TERMINAL");
  assert.equal(execution?.safeError,"Group action credential connection is unavailable");
});

test("group commands never reissue an action whose durable outcome is unknown",async()=>{
  const event={id:"event-command-unknown",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-command-unknown",eventType:"message",attempts:2,payload:{event:"message",payload:{id:"message-command-unknown",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"/status ORD-43",source:"app",timestamp:1_700_000_000}}};
  const action={actionId:"orders.status",actionDefinitionId:"action-definition-1",revision:3,kind:"HTTP_JSON",endpointUrl:"https://orders.example/status",httpMethod:"GET",authScheme:"NONE",headers:{},responseMapping:{"action.state":"/state"},timeoutMs:5000,maxResponseBytes:2048};
  const context={bindingId:"binding-1",groupId:"447700900001@g.us",groupName:"Example Workshop",zammadGroup:"Operations",acknowledgementTemplate:"unused",groupDisclosureEnabled:false,groupDisclosureMessage:null,maxIdentifiers:20,agentPrefix:"Agent",ruleSetId:"set-1",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",rules:[{id:"rule-command",name:"Order status",matcherType:"starts_with",pattern:"/status",prefix:null,digitLength:null,priority:1,enabled:true,version:1,groupCommand:{actionId:"orders.status",input:{reference:"{{message.argument}}"},successReply:"{{action.state}}",failureReply:"{{action.error}}"}}]};
  const calls=[];
  const repository={
    claim:async()=>[event],context:async()=>context,ticketsForQuotedMessage:async()=>[],normalize:async()=>"new",linkZammadCustomer:async()=>{},
    correlate:async(_event,_context,_message,_reference,actions)=>actions.create("command-correlation-unknown"),
    beginGroupCommandAction:async()=>({id:"execution-unknown",state:"OUTCOME_UNKNOWN",attempts:1,action,requestInput:{reference:"ORD-43"},responseVariables:{},safeError:"Group action result is unknown and requires operator review"}),
    claimGroupCommandAction:async()=>{throw new Error("unknown action must not be claimed")},
    completeGroupCommandAction:async()=>{throw new Error("unknown action must not be completed twice")},
    enqueueAcknowledgement:async()=>{throw new Error("unknown action must not be acknowledged")},
    complete:async()=>{throw new Error("unknown action event must fail closed")},
    fail:async(_event,_lease,retryable,error)=>calls.push({retryable,error}),
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=String(input);if(url.includes("/users/search"))return Response.json([]);if(url.endsWith("/api/v1/users")&&init?.method==="POST")return Response.json({id:7,login:"customer",firstname:"Customer",lastname:""},{status:201});if(url.includes("/tickets/search"))return Response.json([]);if(url.endsWith("/api/v1/tickets")&&init?.method==="POST")return Response.json({id:43,number:"10383",state:"open",group:"Operations",title:"Case"},{status:201});if(url.endsWith("/api/v1/ticket_articles/by_ticket/43"))return Response.json([{id:92,preferences:{wasalx_external_message_id:"message-command-unknown"}}]);throw new Error(`unexpected ${url}`)};
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})},undefined,8,async()=>{throw new Error("unknown action must not be sent again")});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  }finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,[{retryable:false,error:"Group action result is unknown and requires operator review"}]);
});

test("group command names require an exact token boundary",async()=>{
  const event={id:"event-command-prefix",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-command-prefix",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"message-command-prefix",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"/statusx",source:"app",timestamp:1_700_000_000}}};
  const calls=[];
  const repository={claim:async()=>[event],context:async()=>({bindingId:"binding-1",groupId:"447700900001@g.us",zammadGroup:"Operations",acknowledgementTemplate:"unused",maxIdentifiers:20,agentPrefix:"Agent",ruleVersion:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",rules:[{id:"rule-command",name:"Status",matcherType:"starts_with",pattern:"/status",prefix:null,digitLength:null,priority:1,enabled:true,version:1,groupCommand:{actionId:"orders.status",input:{},successReply:"ok",failureReply:"failed"}}]}),storedQuotedCommand:async input=>{assert.equal(input.text,"/statusx");assert.equal(input.messageId,"message-command-prefix");return null},quotedCommandCandidate:async input=>{assert.equal(input.text,"/statusx");assert.equal(input.quotedMessageId,undefined);return null},ticketsForQuotedMessage:async()=>[],normalize:async(_event,_message,captureOnly)=>{assert.equal(captureOnly,true);return"skipped"},complete:async(_event,_lease,status,redact)=>calls.push({status,redact}),fail:async(_event,_lease,_retryable,error)=>assert.fail(error)};
  assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>{throw new Error("invalid command must not resolve")}}).drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.deepEqual(calls,[{status:"UNMATCHED",redact:true}]);
});


test("an unresolved quote cannot fall through to a different reference or case number",async()=>{
  const event={id:"quoted-missing",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-quoted-missing",eventType:"message",attempts:8,
    payload:{event:"message",payload:{id:"message-quoted-missing",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"REF123456789012",replyTo:"missing-source",source:"app",timestamp:1_700_000_000}}};
  const completed=[];
  const context={bindingId:"binding-1",groupId:"447700900001@g.us",maxIdentifiers:20,rules:[{id:"r",name:"Reference",matcherType:"prefix_length",pattern:"",prefix:"REF",digitLength:12,priority:1,enabled:true,version:1}]};
  const repository={claim:async()=>[event],messageIsWithinAdmissionWindow:async()=>true,normalize:async()=>"new",context:async()=>context,
    ticketsForQuotedMessage:async(_event,id,actualContext,references)=>{assert.equal(id,"missing-source");assert.equal(actualContext,context);assert.deepEqual(references,["REF123456789012"]);return[]},
    ticketsForCaseNumbers:async()=>assert.fail("must not use case fallback"),correlate:async()=>assert.fail("must not create another case"),
    complete:async(_event,_lease,status,redact,reason)=>completed.push({status,redact,reason}),
    fail:async(_event,_lease,_retryable,error)=>assert.fail(error)};
  const processor=new InboundProcessor(repository,{resolve:async()=>assert.fail("must not resolve credentials")});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.deepEqual(completed,[{status:"UNMATCHED",redact:true,reason:"PROVIDER_TARGET_UNAVAILABLE"}]);
});


test("quoted command permission denial is quarantined once without retry or effects",async()=>{
  const event={id:"event-command-denied",tenantId:"tenant-a",connectionId:"c1",provider:"waha",providerEventId:"evt-command-denied",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"message-command-denied",chatId:"447700900001@g.us",participant:"447700900002@c.us",body:"/close",replyTo:"selected-message",source:"app",timestamp:1_700_000_000}}};
  const context={bindingId:"binding-1",groupId:"447700900001@g.us",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",maxIdentifiers:20,rules:[]};
  const calls=[];
  const repository={claim:async()=>[event],messageIsWithinAdmissionWindow:async()=>true,normalize:async()=>"new",context:async()=>context,
    storedQuotedCommand:async()=>null,quotedCommandCandidate:async()=>({ticketId:"42"}),quotedCommandActor:async()=>({member_email:"agent@example.invalid"}),
    prepareQuotedCommand:async()=>{throw new TicketCommandAuthorizationError()},
    quarantineInbound:async(_event,row)=>calls.push(["quarantine",row]),complete:async(_event,_lease,...args)=>calls.push(["complete",...args]),
    fail:async()=>assert.fail("a deterministic permission denial must not enter the retry classifier")};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{assert.match(String(input),/quoted-command-context$/);return Response.json({updated_at:"2026-10-06T00:00:00.000Z",state_id:"2",last_article_id:"9",native_group_id:"3",connection_id:"c1",external_group_id:"447700900001@g.us",active_agent:false})};
  try{assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("tenant-a"),{events:1,acknowledgements:0})}finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,[
    ["quarantine",{bindingId:"binding-1",reasonCode:"NON_RETRYABLE_REVIEW",safeSummary:"Quoted command actor is not authorized by the active workflow.",safeMetadata:{error_code:"QUOTED_COMMAND_NOT_AUTHORIZED"}}],
    ["complete","QUARANTINED",true,"QUOTED_COMMAND_NOT_AUTHORIZED"],
  ]);
});

test('invalid resumable quoted-command binding is terminal before credentials or native I/O',async()=>{
  const event={id:'event-command-invalid-receipt',tenantId:'tenant-a',connectionId:'c1',provider:'waha',providerEventId:'evt-command-invalid-receipt',eventType:'message',attempts:1,payload:{event:'message',payload:{id:'message-command-invalid-receipt',chatId:"447700900001@g.us",participant:"447700900002@c.us",body:'/close',replyTo:'selected-message',source:'app',timestamp:1_700_000_000}}};
  const context={bindingId:'binding-1',groupId:"447700900001@g.us",zammadBaseUrl:'https://zammad.example',zammadSecretReference:'secret://zammad',maxIdentifiers:20,rules:[]};
  const valid={connection_id:'c1',message_id:'message-command-invalid-receipt',source_sha256:ticketEventSourceHash('INBOUND','c1','message-command-invalid-receipt'),ticket_id:'42',quoted_message_id:'selected-message'};
  for(const snapshot of [{connection_id:'wrong'},{...valid,quoted_message_id:null},{...valid,resolved_quoted_message_id:''}]){
  const calls=[];
  const repository={claim:async()=>[event],messageIsWithinAdmissionWindow:async()=>true,normalize:async()=>"new",context:async()=>context,
    storedQuotedCommand:async()=>({receipt:{state:'PENDING'},nativeActionState:'ATTEMPTED',snapshot,result:null}),
    quotedCommandCandidate:async()=>assert.fail('resume must not resolve a new candidate'),
    quarantineInbound:async(_event,row)=>calls.push(['quarantine',row]),complete:async(_event,_lease,...args)=>calls.push(['complete',...args]),
    fail:async()=>assert.fail('corrupt durable binding must not retry')};
  const processor=new InboundProcessor(repository,{resolve:async()=>assert.fail('binding validation must precede credential resolution')});
  assert.deepEqual(await processor.drainTenant('tenant-a'),{events:1,acknowledgements:0});
  assert.deepEqual(calls,[
    ['quarantine',{bindingId:'binding-1',reasonCode:'NON_RETRYABLE_REVIEW',safeSummary:'Pinned quoted command receipt requires integrity review.',safeMetadata:{error_code:'QUOTED_COMMAND_RECEIPT_INVALID'}}],
    ['complete','QUARANTINED',true,'QUOTED_COMMAND_RECEIPT_INVALID'],
  ]);
  }
});

// Native mutation transport is once-only; these checks use the production driver.
function fixture(overrides={}) {
  const calls=[];
  return {calls,io:{
    readReceipt:async()=>{calls.push('GET');return {state:'SUCCEEDED',id:'receipt'};},
    validReceipt:r=>r.id==='receipt',recordSuccess:async()=>{calls.push('success');},
    claimAttempt:async()=>{calls.push('claim-and-commit');return true;},
    closeOnce:async()=>{calls.push('POST');return {state:'SUCCEEDED',id:'receipt'};},
    recordUnknown:async()=>{calls.push('unknown');},...overrides,
  }};
}
test('prepared command commits attempt before one POST',async()=>{
  const f=fixture();assert.equal((await nativeCommandOnce({state:'PREPARED'},f.io)).state,'SUCCEEDED');
  assert.deepEqual(f.calls,['claim-and-commit','POST','success']);
});
test('admission hold never POSTs',async()=>{
  const f=fixture({claimAttempt:async()=>false});
  assert.equal((await nativeCommandOnce({state:'PREPARED'},f.io)).state,'HELD');assert.deepEqual(f.calls,[]);
});
for(const state of ['ATTEMPTED','OUTCOME_UNKNOWN']) test(state+' uses GET only',async()=>{
  const f=fixture();assert.equal((await nativeCommandOnce({state},f.io)).state,'SUCCEEDED');
  assert.deepEqual(f.calls,['GET','success']);
});
test('missing unknown receipt does not authorize replay',async()=>{
  const f=fixture({readReceipt:async()=>({state:'NO_RECEIPT'})});
  assert.equal((await nativeCommandOnce({state:'OUTCOME_UNKNOWN'},f.io)).state,'OUTCOME_UNKNOWN');assert.deepEqual(f.calls,[]);
});
test('lost native response records unknown without retryable transport throw',async()=>{
  const f=fixture({closeOnce:async()=>{f.calls.push('POST');throw Error('lost response');}});
  assert.equal((await nativeCommandOnce({state:'PREPARED'},f.io)).state,'OUTCOME_UNKNOWN');
  assert.deepEqual(f.calls,['claim-and-commit','POST','unknown']);
});
test('success recording failure retains unknown',async()=>{
  const f=fixture({recordSuccess:async()=>{throw Error('db lost');}});
  assert.equal((await nativeCommandOnce({state:'PREPARED'},f.io)).state,'OUTCOME_UNKNOWN');
  assert.deepEqual(f.calls,['claim-and-commit','POST','unknown']);
});
test('conflicting replay receipt rejects without writes',async()=>{
  const f=fixture({readReceipt:async()=>({state:'SUCCEEDED',id:'wrong'})});
  await assert.rejects(nativeCommandOnce({state:'ATTEMPTED'},f.io),/receipt conflict/);assert.deepEqual(f.calls,[]);
});

function quotedResolutionFixture({eligible=true,ambiguous=false,identity='selected-message'}={}) {
  const input={tenantId:'tenant-a',connectionId:'connection-a',inboxId:'inbox-a',bindingId:'binding-a',groupId:"447700900008@g.us",participantId:'12025550102@c.us',messageId:'provider-command-a',quotedMessageId:'selected-message',text:'/close',fromApi:false,hasMedia:false,provider:'WAHA'};
  const definition={schemaVersion:1,kind:'TICKET_EVENT',name:'Close',event:'quoted_command',command:'/close',permission:{mode:'ANYONE'},start:'close',maxSteps:2,nodes:[{id:'close',type:'close_ticket',next:'done'},{id:'done',type:'end'}]};
  const calls=[];const client={query:async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes('WITH quote_identities'))return{rows:[{external_message_id:identity,ambiguous:identity===null}],rowCount:1};
    if(sql.includes('source_sha256=$2'))return {rows:[],rowCount:0};
    if(sql.includes('SELECT g.id,COALESCE'))return {rows:[{id:'group-a',name:'Operations'}],rowCount:1};
    if(sql.includes('FROM ticket_event_bindings'))return {rows:[{mode:'CUSTOM',flow_version_id:'flow-a'}],rowCount:1};
    if(sql.includes('SELECT definition FROM bot_flow_versions'))return {rows:[{definition}],rowCount:1};
    if(sql.includes('SELECT DISTINCT correlation.id')){const row={id:'case-a',zammad_ticket_id:'42',generation:1,version:'2',state:'OPEN',zammad_state_observed_at:null,normalized_reference:'ABC123',zammad_ticket_number:'10042',instance_id:'instance-a'};return{rows:ambiguous?[row,{...row,id:'case-b'}]:[row],rowCount:ambiguous?2:1};}
    if(sql.startsWith('SELECT link.external_message_id'))return{rows:eligible?[{external_message_id:identity}]:[],rowCount:eligible?1:0};
    throw Error('Unexpected command query');
  }};return{input,client,calls};
}
test('quoted command ordinary text is rejected cheaply without database queries',async()=>{
  const f=quotedResolutionFixture();assert.equal(await resolveQuotedCommand(f.client,{...f.input,text:'hello /close'}),null);assert.deepEqual(f.calls,[]);
});
test('quoted command deduplication binds provider message across replacement inboxes',async()=>{
  const f=quotedResolutionFixture();await resolveQuotedCommand(f.client,f.input);await resolveQuotedCommand(f.client,{...f.input,inboxId:'replacement-inbox'});
  const reads=f.calls.filter(call=>call.sql.includes('source_sha256=$2'));
  assert.equal(reads.length,2);assert.equal(reads[0].values[1],reads[1].values[1]);
  assert.equal(reads[0].values[1],ticketEventSourceHash('INBOUND',f.input.connectionId,f.input.messageId));
});
test('quoted command uses shared quote eligibility including outbound revoke and privacy exclusions',async()=>{
  const f=quotedResolutionFixture({eligible:false});await assert.rejects(resolveQuotedCommand(f.client,f.input),/TARGET_UNAVAILABLE/);
  const lookup=f.calls.find(call=>call.sql.startsWith('SELECT link.external_message_id'));
  assert.deepEqual(lookup.values,['tenant-a','connection-a','42',"447700900008@g.us",'selected-message',null,false]);
  assert.match(lookup.sql,/link.direction='OUTBOUND'[\s\S]*kind":"REVOKED"/);
  assert.match(lookup.sql,/delivery_has_active_privacy_target/);
});
test('quoted command rejects ambiguous case before selecting a quote',async()=>{
  const f=quotedResolutionFixture({ambiguous:true});await assert.rejects(resolveQuotedCommand(f.client,f.input),/TARGET_UNAVAILABLE/);
  assert.equal(f.calls.some(call=>call.sql.startsWith('SELECT link.external_message_id')),false);
});

test('quoted command resolves aliases before case selection and pins canonical feedback without changing raw evidence',async()=>{
  const f=quotedResolutionFixture({identity:'canonical-message'}),base=f.client.query;let snapshot;
  f.client.query=async(sql,values)=>{
    if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
    if(sql.startsWith('SELECT generation,version,state'))return{rows:[{generation:1,version:'2',state:'OPEN',replaced_by_correlation_id:null}]};
    if(sql.includes('app.ticket_command_actor'))return{rows:[{source_authorized:true,member_id:null,member_role:null,member_email:null}]};
    if(sql.startsWith('SELECT id,tenant_id,correlation_id'))return{rows:[]};
    if(sql.includes('INSERT INTO ticket_event_executions'))return{rows:[{id:'execution-a',tenant_id:'tenant-a',correlation_id:'case-a',event:'quoted_command',mode:'CUSTOM',flow_version_id:'flow-a',state:'PENDING'}]};
    if(sql.startsWith('SELECT native_action_state,native_action_snapshot'))return{rows:[{native_action_state:null,native_action_snapshot:null,native_result:null}]};
    if(sql.startsWith('UPDATE ticket_event_executions')){snapshot=values[0];return{rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO message_links'))return{rows:[],rowCount:1};
    return base(sql,values);
  };
  const candidate=await resolveQuotedCommand(f.client,f.input);
  assert.equal(candidate.quoteMessageId,'canonical-message');
  assert.equal(f.calls.find(c=>c.sql.includes('SELECT DISTINCT correlation.id')).values[2],'canonical-message');
  candidate.definition={...candidate.definition,maxSteps:3,nodes:[{id:'close',type:'close_ticket',next:'feedback'},{id:'feedback',type:'send_text',text:'Closed',quote:'ORIGINAL',next:'done'},{id:'done',type:'end'}]};
  await prepareQuotedCommand(f.client,f.input,candidate,{updatedAt:'2026-10-06T00:00:00Z',stateId:'2',lastArticleId:'5',nativeGroupId:'2',connectionId:f.input.connectionId,externalGroupId:f.input.groupId,activeAgent:false});
  assert.equal(snapshot.quoted_message_id,'selected-message');assert.equal(snapshot.resolved_quoted_message_id,'canonical-message');
  assert.equal(snapshot.plan.effects.find(e=>e.type==='send_text').replyToMessageId,'canonical-message');
});

test('quoted command rejects ambiguous identity before case selection and rejects pinned identity drift before claim',async()=>{
  const ambiguous=quotedResolutionFixture({identity:null});await assert.rejects(resolveQuotedCommand(ambiguous.client,ambiguous.input),/TARGET_UNAVAILABLE/);
  assert.equal(ambiguous.calls.some(c=>c.sql.includes('SELECT DISTINCT correlation.id')),false);
  const f=quotedResolutionFixture({identity:'replacement-message'}),base=f.client.query;let mutated=false;
  f.client.query=async(sql,values)=>{
    if(sql.startsWith('SELECT native_action_snapshot,native_action_state'))return{rows:[{native_action_state:'PREPARED',native_action_snapshot:{ticket_id:'42',correlation_id:'case-a',generation:1,correlation_version:2,quoted_message_id:'selected-message',resolved_quoted_message_id:'canonical-message'}}]};
    if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
    if(sql.includes('SELECT execution.id'))return{rows:[]};
    if(sql.startsWith('UPDATE')){mutated=true;throw Error('Must not claim');}
    return base(sql,values);
  };
  await assert.rejects(claimQuotedCommand(f.client,f.input,'execution-a'),/Command case changed/);assert.equal(mutated,false);
});

test('quoted command feedback rejects canonical drift with or without a native snapshot',async()=>{
  for(const native of [true,false]){
    const f=quotedResolutionFixture({identity:'replacement-message'}),base=f.client.query;let mutated=false;
    const receipt={id:'execution-a',tenantId:'tenant-a',correlationId:'case-a',event:'quoted_command',mode:'CUSTOM',flowVersionId:'flow-a',state:'PENDING'};
    const plan={effects:[{type:'send_text',text:'Closed',replyToMessageId:'canonical-message'}]};
    f.client.release=()=>{};f.client.query=async(sql,values)=>{
      if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config'))return{rows:[],rowCount:0};
      if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
      if(sql.startsWith('SELECT state,native_action_state'))return{rows:[{state:'PENDING',native_action_state:native?'SUCCEEDED':null,
        native_action_snapshot:native?{generation:1,quoted_message_id:'selected-message',resolved_quoted_message_id:'canonical-message',plan}:null}]};
      if(sql.startsWith('UPDATE')||sql.includes('INSERT INTO')){mutated=true;throw Error('Must not enqueue');}
      return base(sql,values);
    };
    const repository=new InboundRepository({connect:async()=>f.client});
    await assert.rejects(repository.finishQuotedCommand(f.input,{receipt,plan,quoteMessageId:'canonical-message'}),/Command quote changed/);
    assert.equal(mutated,false);
  }
});

test('quoted command terminal receipt lookup needs no current target or membership',async()=>{
  const input=quotedResolutionFixture().input;const calls=[];
  const client={query:async(sql,values)=>{calls.push({sql,values});return{rows:[{id:'execution-a',correlation_id:'removed-case',mode:'CUSTOM',flow_version_id:'retired-flow',state:'APPLIED',native_action_state:'SUCCEEDED',native_action_snapshot:null,native_result:null}],rowCount:1};}};
  const prior=await readStoredQuotedCommand(client,input);assert.equal(prior.receipt.state,'APPLIED');assert.equal(calls.length,1);
  assert.doesNotMatch(calls[0].sql,/JOIN|ticket_command_actor|message_links|bot_flow_versions/);
  assert.equal(calls[0].values[1],ticketEventSourceHash('INBOUND',input.connectionId,input.messageId));
});

test('denied quoted command pins an empty transcript plan and requires native capability before pinning',async()=>{
  for(const permission of ['AGENTS','SPECIFIC','ANYONE'])for(const capability of [undefined,'v2','v1']){
    const f=quotedResolutionFixture(),base=f.client.query;let snapshot,pins=0;
    f.client.query=async(sql,values)=>{
      if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
      if(sql.startsWith('SELECT generation,version,state'))return{rows:[{generation:1,version:2,state:'OPEN',replaced_by_correlation_id:null}]};
      if(sql.includes('app.ticket_command_actor'))return{rows:[{source_authorized:false,member_id:null,member_role:null,member_email:null}]};
      if(sql.startsWith('SELECT id,tenant_id,correlation_id'))return{rows:[]};
      if(sql.includes('INSERT INTO ticket_event_executions')){pins++;return{rows:[{id:'execution-a',tenant_id:'tenant-a',correlation_id:'case-a',event:'quoted_command',mode:'CUSTOM',flow_version_id:'flow-a',state:'PENDING'}]};}
      if(sql.startsWith('SELECT native_action_state,native_action_snapshot'))return{rows:[{native_action_state:null,native_action_snapshot:null,native_result:null}]};
      if(sql.startsWith('SELECT message.id FROM normalized_messages'))return{rows:[{id:'message-a'}]};
      if(sql.startsWith('UPDATE ticket_event_executions')){snapshot=values[0];return{rows:[],rowCount:1};}
      if(sql.startsWith('INSERT INTO message_links'))return{rows:[],rowCount:1};
      return base(sql,values);
    };
    const candidate=await resolveQuotedCommand(f.client,f.input);
    candidate.definition.permission=permission==='SPECIFIC'?{mode:permission,memberIds:['00000000-0000-4000-8000-000000000001']}:{mode:permission};
    const native={updatedAt:'2026-10-06T00:00:00Z',stateId:'2',lastArticleId:'5',nativeGroupId:'2',connectionId:f.input.connectionId,externalGroupId:f.input.groupId,activeAgent:false,deniedTranscript:capability};
    const prepare=()=>prepareQuotedCommand(f.client,f.input,candidate,native);
    if(capability!=='v1'){await assert.rejects(prepare,/capability/);assert.equal(pins,0);continue;}
    assert.equal((await prepare()).state,'PREPARED');assert.equal(pins,1);
    assert.equal(ticketCommandDisposition(snapshot),'TRANSCRIPT_ONLY_DENIED');assert.equal(snapshot.command_authorized,false);
    assert.equal(snapshot.command_actor.sourceAuthorized,false);assert.deepEqual(snapshot.plan.effects,[]);
    assert.equal(snapshot.command_text,'/close');assert.equal(snapshot.participant_id,f.input.participantId);
    // Membership or configuration changes cannot upgrade the already pinned denial.
    const prior=f.client.query;
    f.client.query=async(sql,values)=>sql.startsWith('SELECT id,correlation_id,mode,flow_version_id,state,')?
      {rows:[{id:'execution-a',correlation_id:'case-a',mode:'CUSTOM',flow_version_id:'flow-a',state:'PENDING',native_action_state:'PREPARED',native_action_snapshot:snapshot,native_result:null}]}:
      sql.includes('app.ticket_command_actor')?Promise.reject(Error('Must not reauthorize a pinned command')):prior(sql,values);
    assert.equal((await prepare()).snapshot,snapshot);assert.equal(pins,1);
  }
});

test('native snapshot capability fence covers denied execution and receipt recovery for every permission',async()=>{
  for(const permission of ['AGENTS','SPECIFIC','ANYONE'])for(const state of ['ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED']){
    const snapshot={tenant_id:'tenant-a',instance_id:'instance-a',execution_id:'execution-a',ticket_id:'42',correlation_id:'case-a',generation:1,correlation_version:2,
      disposition:'TRANSCRIPT_ONLY_DENIED',denied_transcript:'v1',command_authorized:false,permission,plan:{effects:[]},resolved_quoted_message_id:'quoted-a'};
    let actorReads=0;
    const client={query:async sql=>{
      if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:1};
      if(sql.includes('SELECT execution.native_action_state'))return{rows:[{native_action_state:state,native_action_snapshot:snapshot,zammad_ticket_id:'42',generation:1,version:2,state:'OPEN',replaced_by_correlation_id:null}]};
      if(sql.startsWith("SELECT 'delivery'"))return{rows:[]};
      if(sql.startsWith('SELECT message.id FROM normalized_messages'))return{rows:[{id:'source'}]};
      if(sql.includes('WITH quote_identities'))return{rows:[{external_message_id:'quoted-a',ambiguous:false}]};
      if(sql.startsWith('SELECT link.external_message_id'))return{rows:[{external_message_id:'quoted-a'}]};
      if(sql.includes('SELECT DISTINCT correlation.id'))return{rows:[{id:'case-a',zammad_ticket_id:'42'}]};
      if(sql.includes('ticket_command_actor')){actorReads++;throw Error('Denied transcript must not become action authorization');}
      throw Error('Unexpected query');
    }};
    const input={tenantId:'tenant-a',instanceId:'instance-a',executionId:'execution-a'};
    for(const deniedTranscript of [undefined,'v2'])await assert.rejects(ticketCommandAdmission(client,{...input,deniedTranscript}),/capability/);
    assert.equal((await ticketCommandAdmission(client,{...input,deniedTranscript:'v1'})).disposition,'TRANSCRIPT_ONLY_DENIED');assert.equal(actorReads,0);
    assert.throws(()=>ticketCommandDisposition({...snapshot,plan:{effects:[{type:'close_ticket'}]}}),/disposition/);
    assert.throws(()=>ticketCommandDisposition({...snapshot,disposition:'UNKNOWN'}),/disposition/);
  }
});
test('quoted command stored lookup is cheap for ordinary text and preserves attempted state',async()=>{
  const input=quotedResolutionFixture().input;const calls=[];
  const client={query:async(sql)=>{calls.push(sql);return{rows:[{id:'execution-a',correlation_id:'case-a',mode:'CUSTOM',flow_version_id:'flow-a',state:'PENDING',native_action_state:'OUTCOME_UNKNOWN',native_action_snapshot:{ticket_id:'42'},native_result:null}],rowCount:1};}};
  assert.equal(await readStoredQuotedCommand(client,{...input,text:'hello'}),null);assert.deepEqual(calls,[]);
  const prior=await readStoredQuotedCommand(client,input);assert.equal(prior.nativeActionState,'OUTCOME_UNKNOWN');assert.equal(prior.snapshot.ticket_id,'42');
});

function legacyMetaSnapshot(){const {providerSessionId,phoneNumberId,wabaId}=metaContext();const asset={providerSessionId,phoneNumberId,wabaId};return{schemaVersion:1,claim:"LEGACY_PHONE_CONTEXT",recipient:{kind:"PHONE",value:"12025550102"},asset};}
function routingDeliveryFixture(sql,params,delivery,allowed=true){
  if(!sql.includes("CROSS JOIN LATERAL app.meta_direct_routing_guard"))return undefined;
  const context=delivery.metaCredentialContext;
  assert.deepEqual(params,[delivery.connectionId,context.providerSessionId,context.phoneNumberId,context.wabaId,null,"123450987",
    JSON.stringify({mode:"SIMULATED",graphOrigin:"https://routing-provider.invalid",graphVersion:"v24.0",simulationBindingSha256:"7".repeat(64)}),delivery.tenantId,delivery.id]);
  assert.match(sql,/delivery\.meta_routing_epoch IS NOT NULL/u);
  assert.match(sql,/ARRAY\[delivery\.meta_routing_source_event_id\]/u);
  assert.match(sql,/delivery\.created_at>=ownership\.epoch_started_at/u);
  return{rows:allowed===null?[]:[{allowed}],rowCount:allowed===null?0:1};
}
function metaContext(proof=null){return{providerSessionId:"70000000-0000-4000-8000-000000000001",phoneNumberId:"123456789",wabaId:"987654321",proof};}
function metadataProof(token,overrides={}){
  const proof={schemaVersion:1,claim:"PHONE_ACCOUNT_RELATION_VERIFIED",tenantId:"tenant-a",connectionId:"meta-connection",
    secretReference:"secret://meta",providerSessionId:"70000000-0000-4000-8000-000000000001",phoneNumberId:"123456789",wabaId:"987654321",
    graphVersion:"v24.0",verifiedAt:"2026-10-07T00:00:00.000Z",responseSha256:"a".repeat(64),operationId:"op",fencingToken:1,
    credentialFingerprint:createHash("sha256").update(token).digest("hex"),credentialMetadata:{schemaVersion:1,claim:"CREDENTIAL_METADATA_VERIFIED",
      appId:"123450987",scopes:["whatsapp_business_management","whatsapp_business_messaging"],expiresAt:0,
      verifiedAt:"2026-10-07T00:00:00.000Z",responseSha256:"b".repeat(64),...overrides}};
  const metadata=proof.credentialMetadata;
  metadata.responseSha256=createHash("sha256").update(JSON.stringify({is_valid:true,app_id:metadata.appId,scopes:metadata.scopes,expires_at:metadata.expiresAt,
    ...(metadata.dataAccessExpiresAt===undefined?{}:{data_access_expires_at:metadata.dataAccessExpiresAt})})).digest("hex");
  return proof;
}
function metaDelivery(proof=null){return{id:"meta-guard-delivery",tenantId:"tenant-a",connectionId:"meta-connection",groupId:"12025550102",
  recipientType:"DIRECT",text:"hello",contentType:"text/plain",idempotencyKey:"meta-guard",attempts:1,provider:"meta",sessionId:"123456789",
  connectionSecretReference:"secret://meta",metaCredentialContext:metaContext(proof),metaDirectRecipientSnapshot:legacyMetaSnapshot(),zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};}

test("Meta metadata rejects expired or malformed proof before staging and dispatch",async()=>{
  const token="synthetic-meta-token-for-proof";
  for(const proof of [metadataProof(token,{expiresAt:1}),{...metadataProof(token),credentialMetadata:null},metadataProof("different-synthetic-token")]){
    const delivery=metaDelivery(proof);const failures=[];
    const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>assert.fail("no staging"),
      complete:async()=>assert.fail("no completion"),fail:async(...args)=>failures.push(args),outcomeUnknown:async()=>assert.fail("known no dispatch"),claimStatuses:async()=>[]};
    const prior=globalThis.fetch;globalThis.fetch=async()=>assert.fail("no provider dispatch");
    try{await new DeliveryProcessor(repository,{resolve:async()=>({accessToken:token})},{metaGraphVersion:"v24.0",metaAppId:"123450987"}).drainTenant("tenant-a");}
    finally{globalThis.fetch=prior;}
    assert.equal(failures.length,1);assert.equal(failures[0][2],false);assert.match(failures[0][3],/proof is invalid or expired/u);
  }
});

test("Meta final request rechecks expiry and records known no-send",async()=>{
  const token="synthetic-meta-token-for-proof";const proof=metadataProof(token);const delivery=metaDelivery(proof);const failures=[];let checks=0;
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>true,
    assertMetaDeliveryContextCurrent:async()=>{checks++;proof.credentialMetadata.expiresAt=1;},complete:async()=>assert.fail("no completion"),
    fail:async(...args)=>failures.push(args),outcomeUnknown:async()=>assert.fail("preflight is known no-send"),claimStatuses:async()=>[]};
  const prior=globalThis.fetch;globalThis.fetch=async()=>assert.fail("expired before fetch");
  try{await new DeliveryProcessor(repository,{resolve:async()=>({accessToken:token})},{metaGraphVersion:"v24.0",metaAppId:"123450987"}).drainTenant("tenant-a");}
  finally{globalThis.fetch=prior;}
  assert.equal(checks,1);assert.equal(failures.length,1);assert.equal(failures[0][6],"META_CREDENTIAL_PROOF_INVALID");
});

test("Meta auth failure retains delivery failure without downgrading newer credentials",async()=>{
  const queries=[];const client={query:async(sql,params)=>{queries.push({sql,params});if(sql.includes("/* meta_delivery_context_current */"))return{rows:[{current:false}],rowCount:1};
    return{rows:[],rowCount:sql.startsWith("UPDATE delivery_outbox")?1:0};},release:()=>{}};
  await new OutboxRepository({connect:async()=>client}).fail(metaDelivery(),"lease",false,"Meta credentials are invalid or expired.",undefined,false,"META_AUTHENTICATION_FAILED");
  assert.ok(queries.some(q=>q.sql.startsWith("UPDATE delivery_outbox")));
  assert.equal(queries.some(q=>q.sql.startsWith("UPDATE connections SET state='ACTION_REQUIRED'")),false);
  const check=queries.find(q=>q.sql.includes("/* meta_delivery_context_current */"));
  assert.deepEqual(check.params,["tenant-a","meta-connection","secret://meta",metaContext().providerSessionId,"123456789","987654321","null",false]);
  assert.match(check.sql,/COALESCE\(ps\.provider_state_data->'metaAccountProof','null'::jsonb\)=\$7::jsonb/u);
});

test("Meta request fence checks current session and delivery lease in connection lock order",async(t)=>{
  t.after(routingFixtureEnvironment("123450987"));
  for(const [current,leased] of [[false,true],[true,false],[true,true]]){
    const delivery=metaDelivery();
    const calls=[];const client={query:async(sql,params)=>{calls.push({sql,params});const routing=routingDeliveryFixture(sql,params,delivery);if(routing)return routing;
      if(sql.includes("/* meta_delivery_context_current */"))return{rows:[{current}],rowCount:1};
      if(sql.includes("AND meta_direct_recipient=$5::jsonb"))return{rows:[{}],rowCount:1};
      if(sql.includes("app.meta_direct_identity_guard"))return{rows:[{clear:true}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:true,blocked:false,unresolved_hold:false}],rowCount:1};
      if(sql.includes("SELECT id FROM delivery_outbox"))return{rows:leased?[{id:"meta-guard-delivery"}]:[],rowCount:leased?1:0};
      return{rows:[],rowCount:0};},release:()=>{}};
    const action=new OutboxRepository({connect:async()=>client}).assertMetaDeliveryContextCurrent(delivery,"lease");
    if(current&&leased)await action;else await assert.rejects(action,/changed before dispatch/u);
    const conn=calls.findIndex(q=>q.sql.includes("SELECT id FROM connections"));const session=calls.findIndex(q=>q.sql.includes("/* meta_delivery_context_current */"));
    assert.ok(conn>=0&&session>conn);assert.match(calls[session].sql,/ps\.id=\$4::uuid/u);
  }
});


test("current enabled Meta proof dispatches once through the request fence",async()=>{
  const token="synthetic-meta-token-for-proof";const delivery=metaDelivery(metadataProof(token));const calls=[];
  const repository={metaInheritedTemplateContext:async(job,lease)=>{assert.equal(job,delivery);assert.equal(typeof lease,"string");return null;},claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>{calls.push("begin");return true;},
    assertMetaDeliveryContextCurrent:async()=>calls.push("guard"),complete:async()=>calls.push("complete"),
    fail:async()=>assert.fail("valid proof"),outcomeUnknown:async()=>assert.fail("known success"),claimStatuses:async()=>[]};
  const prior=globalThis.fetch;globalThis.fetch=async()=>{calls.push("fetch");return Response.json({messages:[{id:"wamid.verified"}]});};
  try{await new DeliveryProcessor(repository,{resolve:async()=>({accessToken:token})},{metaGraphVersion:"v24.0",metaAppId:"123450987"}).drainTenant("tenant-a");}
  finally{globalThis.fetch=prior;}
  assert.deepEqual(calls,["begin","guard","fetch","complete"]);
});

function lifecycleState({revision=1,blocked=true,recovery=false}={}){
  recovery=recovery||!blocked;
  const negative={event:"ACCOUNT_OFFBOARDED",observedAt:"2026-10-07T00:00:00.000Z",payloadSha256:"a".repeat(64)};
  const recovered={event:"ACCOUNT_RECONNECTED",observedAt:"2026-10-07T01:00:00.000Z",payloadSha256:"b".repeat(64)};
  const stamp=recovery?recovered:negative;
  return{schemaVersion:1,revision,lastObservedAt:stamp.observedAt,lastEvent:stamp.event,lastPayloadSha256:stamp.payloadSha256,
    reasonStates:[{reason:"ACCOUNT_OFFBOARDED",negative,...(recovery?{recovery:recovered}:{}),...(!blocked?{clearedThrough:recovered}:{}),blocked}]};
}

test("Meta delivery request fences pending, changed, blocked and malformed lifecycle without dispatch",async(t)=>{
  t.after(routingFixtureEnvironment("123450987"));
  for(const kind of ["clear","pending","revision","blocked","null"]){
    const delivery=metaDelivery();delivery.metaCredentialContext.lifecycle=kind==="null"?null:lifecycleState({blocked:kind==="blocked"});
    const calls=[];const client={release(){},query:async(sql,params)=>{
      calls.push({sql,params});const routing=routingDeliveryFixture(sql,params,delivery);if(routing)return routing;
      if(sql.includes("meta_delivery_context_current"))return{rows:[{current:true}],rowCount:1};
      if(sql.includes("AND meta_direct_recipient=$5::jsonb"))return{rows:[{}],rowCount:1};
      if(sql.includes("app.meta_direct_identity_guard"))return{rows:[{clear:true}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:kind!=="revision",blocked:kind==="blocked",unresolved_hold:kind==="pending"}],rowCount:1};
      if(sql.includes("SELECT id FROM delivery_outbox"))return{rows:[{id:delivery.id}],rowCount:1};
      return{rows:[],rowCount:0};
    }};
    const promise=new OutboxRepository({connect:async()=>client}).assertMetaDeliveryContextCurrent(delivery,"lease");
    if(kind==="clear")await promise;else await assert.rejects(promise,/changed before dispatch/u);
    const guard=calls.find(q=>q.sql.includes("app.meta_lifecycle_guard"));
    if(kind==="null")assert.equal(guard,undefined);
    else assert.deepEqual(guard.params,[delivery.connectionId,delivery.metaCredentialContext.providerSessionId,"123456789","987654321",process.env.META_APP_ID??"",1]);
  }
});
test("Meta lifecycle change retains actual delivery receipt and prevents stale auth health overwrite",async()=>{
  const delivery=metaDelivery();delivery.metaCredentialContext.lifecycle=lifecycleState({blocked:false});const calls=[];
  const client={release(){},query:async(sql,params)=>{calls.push({sql,params});
    if(sql.includes("meta_delivery_context_current"))return{rows:[{current:true}],rowCount:1};
    if(sql.includes("AND meta_direct_recipient=$5::jsonb"))return{rows:[{}],rowCount:1};
      if(sql.includes("app.meta_direct_identity_guard"))return{rows:[{clear:true}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:false,blocked:true,unresolved_hold:true}],rowCount:1};
    return{rows:[],rowCount:1};
  }};
  const repo=new OutboxRepository({connect:async()=>client});
  await repo.complete(delivery,"lease","SENT","actual-provider-id");
  assert.ok(calls.some(q=>q.sql.startsWith("UPDATE delivery_outbox SET state=$1")&&q.params[1]==="actual-provider-id"));
  assert.equal(calls.some(q=>q.sql.includes("app.meta_lifecycle_guard")),false);
  calls.length=0;
  await repo.fail(delivery,"lease",false,"Meta credentials are invalid or expired.",undefined,false,"META_AUTHENTICATION_FAILED");
  assert.ok(calls.some(q=>q.sql.startsWith("UPDATE delivery_outbox")));
  assert.equal(calls.some(q=>q.sql.startsWith("UPDATE connections SET state='ACTION_REQUIRED'")),false);
});


test("signed Meta lifecycle processing completes atomically before message normalization or provider access",async()=>{
  const event={id:"lifecycle-1",tenantId:"tenant-a",connectionId:"connection-a",provider:"meta",eventType:"meta.account.lifecycle.block",attempts:1,payload:{}};
  const calls=[];
  const processor=new ProductionInboundProcessor({claim:async()=>[event],applyMetaLifecycle:async(actual,lease,appId)=>{
    assert.equal(actual,event);assert.match(lease,/^[0-9a-f-]{36}$/u);assert.equal(appId,"123456");calls.push("applied-and-completed");
  },complete:async()=>assert.fail("Lifecycle acknowledgement belongs in the same state transaction"),fail:async()=>assert.fail("Valid lifecycle must not fail")},
  {resolve:async()=>assert.fail("Lifecycle callbacks do not use a provider credential")},undefined,8,undefined,"123456");
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});assert.deepEqual(calls,["applied-and-completed"]);
});

test("invalid Meta lifecycle admission remains a terminal inbox hold without generic acknowledgement",async()=>{
  const {MetaLifecycleError}=await import("../services/connector-worker/dist/packages/core/src/meta-account-relation.js");
  const event={id:"lifecycle-invalid",tenantId:"tenant-a",connectionId:"connection-a",provider:"meta",eventType:"meta.account.lifecycle.block",attempts:1,payload:{}};
  const failures=[];
  const processor=new ProductionInboundProcessor({claim:async()=>[event],applyMetaLifecycle:async()=>{throw new MetaLifecycleError()},
    complete:async()=>assert.fail("Invalid signed negative must not release its hold"),fail:async(actual,_lease,retryable,error)=>failures.push({actual,retryable,error})},
    {resolve:async()=>assert.fail("No external action is allowed")},undefined,8,undefined,"123456");
  await processor.drainTenant("tenant-a");assert.equal(failures.length,1);assert.equal(failures[0].actual,event);assert.equal(failures[0].retryable,false);
  assert.match(failures[0].error,/lifecycle reconciliation/u);
});

test("Meta delivery projects the immutable BSUID snapshot and never falls back to the logical phone",async()=>{
 const token="synthetic-meta-token-for-proof",delivery=metaDelivery(metadataProof(token)),calls=[];
 delivery.metaDirectRecipientSnapshot={...legacyMetaSnapshot(),claim:"ALIAS_VERIFIED",
  recipient:{kind:"BSUID",value:"SA.aB0123"},participantId:"71000000-0000-4000-8000-000000000001",
  aliasId:"71000000-0000-4000-8000-000000000002",aliasRevision:1};
 const repository={metaInheritedTemplateContext:async(job,lease)=>{assert.equal(job,delivery);assert.equal(typeof lease,"string");return null;},claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>{calls.push("begin");return true},
  assertMetaDeliveryContextCurrent:async(job)=>{assert.equal(job.metaDirectRecipientSnapshot.recipient.value,"SA.aB0123");calls.push("guard")},
  complete:async()=>calls.push("complete"),fail:async()=>assert.fail("verified identity"),outcomeUnknown:async()=>assert.fail("known success"),claimStatuses:async()=>[]};
 const prior=globalThis.fetch;let body;
 globalThis.fetch=async(_url,init)=>{calls.push("fetch");body=JSON.parse(init.body);return Response.json({messages:[{id:"wamid.bsuid"}]})};
 try{await new DeliveryProcessor(repository,{resolve:async()=>({accessToken:token})},{metaGraphVersion:"v24.0",metaAppId:"123450987"}).drainTenant("tenant-a")}
 finally{globalThis.fetch=prior}
 assert.deepEqual(calls,["begin","guard","fetch","complete"]);assert.equal(body.recipient,"SA.aB0123");
 assert.equal("to" in body,false);assert.equal(body.recipient_type,"individual");
});

test("Meta direct delivery rejects missing, redacted or parent-only recipient evidence before effects",async()=>{
 for(const snapshot of [undefined,null,{redacted:true,sha256:"a".repeat(64)},
  {...legacyMetaSnapshot(),recipient:{kind:"BSUID",value:"SA.ENT.aB0123"}},
  {...legacyMetaSnapshot(),recipient:{kind:"BSUID",value:"SA.aB0123"}}]){
  const delivery={...metaDelivery(),metaDirectRecipientSnapshot:snapshot},failures=[];
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],
   beginSend:async()=>assert.fail("invalid evidence cannot enter SENDING"),complete:async()=>assert.fail("no completion"),
   fail:async(...args)=>failures.push(args),outcomeUnknown:async()=>assert.fail("known no-send"),claimStatuses:async()=>[]};
  const prior=globalThis.fetch;globalThis.fetch=async()=>assert.fail("no external action");
  try{await new DeliveryProcessor(repository,{resolve:async()=>assert.fail("no secret needed")},{metaGraphVersion:"v24.0"}).drainTenant("tenant-a")}
  finally{globalThis.fetch=prior}
  assert.equal(failures.length,1);assert.equal(failures[0][2],false);
 }
});

test("Meta identity change between native lookup and bot article prevents article creation and send",async()=>{
 const token="synthetic-meta-token-for-proof",delivery={...metaDelivery(metadataProof(token)),directOrigin:"BOT",botConversationId:"conversation-1",ticketId:"42"};
 const failures=[],requests=[];let checks=0;
 const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>true,renewDeliveryLease:async()=>true,
  assertMetaDeliveryContextCurrent:async()=>{if(++checks===2)throw new ProviderError("Meta identity changed",false,"META_DIRECT_IDENTITY_INVALID",undefined,true)},
  linkBotArticle:async()=>assert.fail("no article to link"),complete:async()=>assert.fail("no provider send"),
  fail:async(...args)=>failures.push(args),outcomeUnknown:async()=>assert.fail("known no-send"),claimStatuses:async()=>[]};
 const prior=globalThis.fetch;globalThis.fetch=async(url,init)=>{requests.push({url:String(url),method:init?.method??"GET"});return Response.json([])};
 try{await new DeliveryProcessor(repository,{resolve:async(reference)=>reference==="secret://meta"?{accessToken:token}:{token:"native-synthetic-token"}},
  {metaGraphVersion:"v24.0",metaAppId:"123450987"}).drainTenant("tenant-a")}finally{globalThis.fetch=prior}
 assert.equal(checks,2);assert.equal(requests.length,1);assert.match(requests[0].url,/ticket_articles/);assert.equal(requests[0].method,"GET");
 assert.equal(failures.length,1);assert.equal(failures[0][2],false);
});


test('direct bot action admission failure is pretransport, not a POST unknown result',async()=>{
 let calls=0;const job={id:'guard-action',endpointUrl:'https://public.example/action',httpMethod:'POST',kind:'HTTP_JSON',authScheme:'NONE',headers:{},requestInput:{message:'private'},timeoutMs:1000,maxResponseBytes:100,responseMapping:{}};
 await assert.rejects(executeBotAction(job,undefined,async()=>{calls++;return{status:200,headers:{},body:'{}'};},async()=>{throw new MetaDirectEffectNotAttempted();}),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});
 assert.equal(calls,0);
});

test('production bot action currentness runs after DNS validation and immediately before transport',async()=>{
 const calls=[];let allowed=false;
 const dependencies={lookup:async()=>{calls.push('dns');return[{address:'93.184.216.34',family:4}];},beforeRequest:async()=>{calls.push('guard');if(!allowed)throw new MetaDirectEffectNotAttempted();},call:async()=>{calls.push('http');return{status:200,headers:{},body:'{}'};}};
 await assert.rejects(safeHttpsRequest(new URL('https://public.example/action'),'POST',{},'{}',1000,100,dependencies),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true});assert.deepEqual(calls,['dns','guard']);
 calls.length=0;allowed=true;assert.equal((await safeHttpsRequest(new URL('https://public.example/action'),'POST',{},'{}',1000,100,dependencies)).status,200);assert.deepEqual(calls,['dns','guard','http']);
});

test('bot action deadline exhausted during currentness check never constructs HTTP',async()=>{
 let calls=0;const dependencies={lookup:async()=>[{address:'93.184.216.34',family:4}],beforeRequest:async()=>{await new Promise(resolve=>setTimeout(resolve,20));},call:async()=>{calls++;return{status:200,headers:{},body:'{}'};}};
 await assert.rejects(safeHttpsRequest(new URL('https://public.example/action'),'POST',{},'{}',1,100,dependencies),{code:'META_DIRECT_EFFECT_NOT_ATTEMPTED',outcomeKnown:true,reason:'BUSY'});assert.equal(calls,0);
});

test('held queued direct action has no transport, recorded result or failure-branch flow advance',async(t)=>{
 let dnsCalls=0,httpCalls=0;
 t.mock.method(dnsPromises,'lookup',async(host,options)=>{assert.equal(host,'public.example');assert.deepEqual(options,{all:true,verbatim:true});dnsCalls++;return[{address:'93.184.216.34',family:4}];});
 t.mock.method(https,'request',()=>{httpCalls++;assert.fail('Held identity must not construct HTTP');});
 syncBuiltinESMExports();
 try{
 const held=[];let checks=0;const job={id:'held-action',origin:'DIRECT_FLOW',tenantId:'tenant-a',conversationId:'conversation',sourceEventId:'source',actionNodeId:'action',zammadTicketId:'42',credentialAvailable:true,attempts:1,fencingToken:7,endpointUrl:'https://public.example/action',httpMethod:'POST',kind:'HTTP_JSON',authScheme:'NONE',headers:{},requestInput:{},timeoutMs:1000,maxResponseBytes:100,responseMapping:{}};
 const repository={claimBotActions:async()=>[job],assertBotActionIdentityCurrent:async(j,lease,app)=>{assert.equal(j,job);assert(lease);assert.equal(app,'123456789');checks++;throw new MetaDirectEffectNotAttempted();},holdUnattemptedBotActionIdentity:async(j,lease)=>{assert.equal(j,job);assert(lease);held.push(j.id);},recordBotActionResult:async()=>assert.fail('No external action result exists'),completeBotAction:async()=>assert.fail('No onFailure/flow advancement'),outcomeUnknownBotAction:async()=>assert.fail('No attempted POST'),claimDeliveries:async()=>[],claimStatuses:async()=>[]};
 await new DeliveryProcessor(repository,{resolve:async()=>assert.fail('No action credential needed')},{metaGraphVersion:'v24.0',metaAppId:'123456789'}).drainTenant('tenant-a');assert.equal(checks,1);assert.deepEqual(held,['held-action']);assert.equal(dnsCalls,1);assert.equal(httpCalls,0);
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('handoff checks identity before each native request and cannot append after a newly admitted hold',async()=>{
 const oldFetch=globalThis.fetch,calls=[];let checks=0;
 const job={id:'guard-handoff',tenantId:'tenant-a',conversationId:'conversation',handoffNodeId:'handoff',zammadGroupId:'2',zammadOwnerId:'17',priority:'2 normal',attempts:1,fencingToken:1,zammadTicketId:'42',zammadBaseUrl:'https://zammad.example',zammadSecretReference:'secret://zammad'};
 const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[],claimStatuses:async()=>[],claimBotHandoffs:async()=>[job],assertBotHandoffIdentityCurrent:async(j,lease,app)=>{assert.equal(j,job);assert(lease);assert.equal(app,'123456789');calls.push('guard');if(++checks===3)throw new MetaDirectEffectNotAttempted();},completeBotHandoff:async()=>assert.fail('Handoff incomplete after hold'),retryBotHandoff:async()=>assert.fail('Deterministic hold does not retry'),failBotHandoff:async()=>calls.push('retained-terminal')};
 globalThis.fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(path==='/api/v1/tickets/42'&&init.method==='PUT'){calls.push('update');return Response.json({id:42});}if(path==='/api/v1/tickets/42'&&!init.method){calls.push('readback');return Response.json({id:42,state:'open',title:'Synthetic handoff',group_id:2,owner_id:17});}if(path==='/api/v1/ticket_articles/by_ticket/42'){calls.push('history');return Response.json([]);}throw Error('Unexpected native dispatch '+path);};
 try{await new DeliveryProcessor(repository,{resolve:async()=>({token:'synthetic-native-token'})},{metaGraphVersion:'v24.0',metaAppId:'123456789'}).drainTenant('tenant-a');assert.deepEqual(calls,['guard','update','guard','readback','guard','retained-terminal']);}finally{globalThis.fetch=oldFetch;}
});

test('customer close guard stops queued native context/POST, while UNKNOWN only reads its sealed receipt',async()=>{
 const oldFetch=globalThis.fetch;
 try{for(const state of ['QUEUED','OUTCOME_UNKNOWN']){
  const calls=[],job={id:'guard-close',tenantId:'tenant-a',instanceId:'instance',ticketId:'42',state,fencingToken:2,zammadBaseUrl:'https://zammad.example',zammadSecretReference:'secret://zammad'};
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[],claimStatuses:async()=>[],claimDirectCustomerCloses:async()=>[job],assertDirectCustomerCloseIdentityCurrent:async(j,lease,app)=>{assert.equal(j,job);assert(lease);assert.equal(app,'123456789');calls.push('guard');throw new MetaDirectEffectNotAttempted();},prepareDirectCustomerClose:async()=>assert.fail('No ATTEMPTED admission'),completeDirectCustomerClose:async(j,receipt)=>{assert.equal(j,job);assert.equal(receipt.state,'SUCCEEDED');calls.push('historical-settlement');},holdUnattemptedDirectCustomerCloseIdentity:async()=>calls.push('not-attempted-terminal'),holdDirectCustomerClose:async()=>assert.fail('No deterministic reclaim loop')};
  globalThis.fetch=async(input,init)=>{assert.equal(state,'OUTCOME_UNKNOWN');assert.equal(new URL(String(input)).pathname,'/api/v1/wasalx/tickets/42/customer-closes/guard-close');assert.equal(init.method,undefined);calls.push('receipt-read');return Response.json({state:'SUCCEEDED'});};
  await new DeliveryProcessor(repository,{resolve:async()=>({token:'synthetic-native-token'})},{metaGraphVersion:'v24.0',metaAppId:'123456789'}).drainTenant('tenant-a');
  assert.deepEqual(calls,state==='QUEUED'?['guard','not-attempted-terminal']:['receipt-read','historical-settlement']);
 }}finally{globalThis.fetch=oldFetch;}
});

test("Meta routing held or absent admission prevents a current delivery dispatch",async(t)=>{
  t.after(routingFixtureEnvironment("123450987"));
  for(const allowed of [false,null]){
    const delivery=metaDelivery(),calls=[];const client={release(){},query:async(sql,params)=>{
      calls.push({sql,params});const routing=routingDeliveryFixture(sql,params,delivery,allowed);if(routing)return routing;
      if(sql.includes("meta_delivery_context_current"))return{rows:[{current:true}],rowCount:1};
      if(sql.includes("AND meta_direct_recipient=$5::jsonb"))return{rows:[{}],rowCount:1};
      if(sql.includes("app.meta_direct_identity_guard"))return{rows:[{clear:true}],rowCount:1};
      if(sql.includes("app.meta_lifecycle_guard"))return{rows:[{revision_matches:true,blocked:false,unresolved_hold:false}],rowCount:1};
      if(sql.includes("SELECT id FROM delivery_outbox"))return{rows:[{id:delivery.id}],rowCount:1};
      return{rows:[],rowCount:0};
    }};
    await assert.rejects(new OutboxRepository({connect:async()=>client}).assertMetaDeliveryContextCurrent(delivery,"lease"),/changed before dispatch/u);
    assert.equal(calls.filter(c=>c.sql.includes("CROSS JOIN LATERAL app.meta_direct_routing_guard")).length,1);
    assert.equal(calls.some(c=>/^(INSERT|UPDATE)/u.test(c.sql)),false);
  }
});
