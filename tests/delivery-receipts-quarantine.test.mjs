import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { MetaGroupsAdapter } from "../services/connector-worker/dist/packages/connectors/src/meta.js";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { InboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { QuarantineController } from "../services/control-api/dist/quarantine.controller.js";
import { RuleTestService } from "../services/control-api/dist/rule-test.service.js";
import { WebhookIngressController } from "../services/control-api/dist/webhook-ingress.controller.js";

const migration=await readFile(new URL("../services/control-api/migrations/0020_delivery_receipts_quarantine.sql",import.meta.url),"utf8");
const groupActionRecoveryMigration=await readFile(new URL("../services/control-api/migrations/0105_group_action_operator_recovery.sql",import.meta.url),"utf8");
const statusProjectionGrantMigration=await readFile(new URL("../services/control-api/migrations/0134_connector_worker_zammad_status_insert.sql",import.meta.url),"utf8");
const lifecycle=await readFile(new URL("../services/connector-worker/src/connection-operation-processor.ts",import.meta.url),"utf8");
const repository=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
const ingress=await readFile(new URL("../services/control-api/src/webhook-ingress.controller.ts",import.meta.url),"utf8");
const controller=await readFile(new URL("../services/control-api/src/quarantine.controller.ts",import.meta.url),"utf8");
const portal=await readTenantPortalSource();

test("WAHA subscribes only to the dedicated group receipt contract",async()=>{
  assert.match(lifecycle,/"message\.ack\.group"/);
  assert.doesNotMatch(lifecycle,/\["message",\s*"message\.any",\s*"message\.ack",/);
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"key",sessionFor:()=>"session"});
  const payload={event:"message.ack.group",timestamp:1_786_291_200_000,engine:"GOWS",payload:{id:"true_group@g.us_message_sender@lid",ack:3,ackName:"READ",participant:"reader@lid"}};
  const [receipt]=await adapter.normalizeReceipts("connection-a",payload);
  let malformedReason;
  assert.deepEqual(await adapter.normalizeReceipts("connection-a",{...payload,payload:{...payload.payload,id:"true_group@g.us__sender@lid"}},undefined,"GOWS",reason=>{malformedReason=reason}),[]);
  assert.equal(malformedReason,"RECEIPT_ID");
  assert.deepEqual({...receipt,receiptKey:"<sha256>"},{
    provider:"waha",connectionId:"connection-a",externalMessageId:"true_group@g.us_message_sender@lid",receiptKey:"<sha256>",scope:"PARTICIPANT_OBSERVED",status:"READ",providerStatus:"READ",timestamp:"2026-08-09T16:00:00.000Z",errorCodes:[],metadata:{ack:3,engine:"GOWS",groupReceipt:true},
  });
  assert.match(receipt.receiptKey,/^[0-9a-f]{64}$/);
  assert.deepEqual(await adapter.normalizeReceipts("connection-a",{...payload,event:"message.ack"}),[]);
  let rejection;
  assert.deepEqual(await adapter.normalizeReceipts("connection-a",{...payload,engine:"NOWEB",payload:{...payload.payload,id:"true_group@g.us_message_wrong@lid"}},undefined,"NOWEB",reason=>{rejection=reason}),[]);
  assert.equal(rejection,"ID_SUFFIX");
  const [documented]=await adapter.normalizeReceipts("connection-a",{...payload,engine:"NOWEB",payload:{...payload.payload,id:"true_group@g.us_message_reader@lid"}});
  assert.equal(documented.externalMessageId,"true_group@g.us_message");
  const withoutEngine={...payload};delete withoutEngine.engine;
  const [trustedGows]=await adapter.normalizeReceipts("connection-a",withoutEngine,undefined,"GOWS");
  assert.equal(trustedGows.externalMessageId,payload.payload.id);
  const documentedMinimum={...payload};delete documentedMinimum.timestamp;
  const [fallbackTimestamp]=await adapter.normalizeReceipts("connection-a",documentedMinimum,"2026-08-09T16:00:01.000Z");
  assert.equal(fallbackTimestamp.timestamp,"2026-08-09T16:00:01.000Z");
  assert.deepEqual(await adapter.normalizeReceipts("connection-a",documentedMinimum),[]);
  assert.equal(JSON.stringify(await adapter.normalizeReceipts("connection-a",payload)).includes("reader@lid"),false);
});

test("Meta normalizes sent, delivered, read, and failed status callbacks without recipient data",async()=>{
  const adapter=new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v24.0",phoneNumberIdFor:()=>"12345"});
  const value={entry:[{changes:[{value:{statuses:[
    {id:"wamid.sent",status:"sent",timestamp:"1786291200",recipient_id:"15551234567"},
    {id:"wamid.delivered",status:"delivered",timestamp:"1786291201"},
    {id:"wamid.read",status:"read",timestamp:"1786291202"},
    {id:"wamid.failed",status:"failed",timestamp:"1786291203",errors:[{code:131026,title:"unsafe free text"}]},
    {id:"wamid.deleted",status:"deleted",timestamp:"1786291204"},
  ]}}]}]};
  const receipts=await adapter.normalizeReceipts("connection-meta",value);
  assert.deepEqual(receipts.map(item=>item.status),["SENT","DELIVERED","READ","FAILED"]);
  assert.deepEqual(receipts.map(item=>item.scope),["MESSAGE","MESSAGE","MESSAGE","MESSAGE"]);
  assert.equal(receipts.every(item=>/^[0-9a-f]{64}$/.test(item.receiptKey)),true);
  assert.deepEqual(receipts[3].errorCodes,["131026"]);
  assert.equal(JSON.stringify(receipts).includes("15551234567"),false);
  assert.equal(JSON.stringify(receipts).includes("unsafe free text"),false);
  const duplicateShape=await adapter.normalizeReceipts("connection-meta",{entry:[{changes:[{value:{statuses:[
    {id:"wamid.same",status:"delivered",timestamp:"1786291201",recipient_id:"10001"},
    {id:"wamid.same",status:"delivered",timestamp:"1786291201",recipient_id:"10002"},
  ]}}]}]});
  assert.equal(new Set(duplicateShape.map(item=>item.receiptKey)).size,2);
  assert.equal(JSON.stringify(duplicateShape).includes("10001"),false);
});

test("Meta ingress persists independently replay-fenced statuses from one change",async()=>{
  const now=Math.floor(Date.now()/1_000);
  const body={object:"whatsapp_business_account",entry:[{id:"987654321",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:"123456789"},statuses:[
    {id:"wamid.same",status:"delivered",timestamp:String(now-1),recipient_id:"10001"},
    {id:"wamid.same",status:"read",timestamp:String(now),recipient_id:"10001"},
  ]}}]}]};
  const raw=JSON.stringify(body);const secret="meta-app-secret-for-test";const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");
  const accepted=[];const wakes=[];const priorReference=process.env.META_APP_SECRET_REFERENCE,priorApp=process.env.META_APP_ID;process.env.META_APP_SECRET_REFERENCE="secret://meta/app";process.env.META_APP_ID="123450987";
  try{
    const controllerUnderTest=new WebhookIngressController({resolveMetaWebhookRoute:async keyValue=>{assert.equal(keyValue,"123456789");return{tenant_id:"tenant-a",connection_id:"connection-a",provider:"META",hmac_secret_reference:"secret://route"}},acceptWebhookEvent:async(_route,input)=>{accepted.push(input);return{id:"event-a",duplicate:false}}},{resolveHmac:async (reference,owner)=>{assert.equal(reference,"secret://meta/app");assert.deepEqual(owner,{kind:"exact",expectedReference:"secret://meta/app"});return secret}},{wakeInbound:async tenant=>wakes.push(tenant)});
    assert.deepEqual(await controllerUnderTest.meta({rawBody:new TextEncoder().encode(raw),headers:{"x-hub-signature-256":`sha256=${signature}`}},body),{accepted:true,count:2,duplicates:0,unrouted:0});
  }finally{if(priorReference===undefined)delete process.env.META_APP_SECRET_REFERENCE;else process.env.META_APP_SECRET_REFERENCE=priorReference;if(priorApp===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=priorApp}
  assert.equal(accepted.length,2);assert.equal(accepted[0].eventType,"message.status");assert.equal(accepted[0].payload.entry[0].changes[0].value.statuses.length,1);assert.notEqual(accepted[0].providerEventId,accepted[1].providerEventId);assert.deepEqual(wakes,["tenant-a"]);
  for(const item of accepted){assert.equal(item.metaRoutingEvidence.category,"OWN_MESSAGE_STATUS");assert.equal(item.metaRoutingEvidence.peer,undefined);assert.equal(item.metaRoutingEvidence.payloadSha256,item.payloadSha256);}
});

test("signed Meta marketing preferences are replay-stable and strip profile and parent identifiers",async(t)=>{
  const now=Date.UTC(2026,10,24,10), timestamp=now/1000;
  t.mock.method(Date,"now",()=>now);
  const secret="synthetic-marketing-webhook-secret";
  const envKeys=["META_APP_SECRET_REFERENCE","META_APP_ID","WASALX_TEST_RECIPIENT_ALLOWLIST"];
  const previous=envKeys.map(name=>process.env[name]);
  t.after(()=>envKeys.forEach((name,index)=>{
    if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];
  }));
  [process.env.META_APP_SECRET_REFERENCE,process.env.META_APP_ID,process.env.WASALX_TEST_RECIPIENT_ALLOWLIST]=["secret://meta/app","123450987","*"];
  const route={tenant_id:"tenant-a",connection_id:"connection-a",provider:"META",hmac_secret_reference:"secret://route"};
  const accepted=[];
  const controller=new WebhookIngressController({
    resolveMetaWebhookRoute:async phone=>{assert.equal(phone,"123456789");return route;},
    acceptWebhookEvent:async(actualRoute,input)=>{
      assert.equal(actualRoute,route);
      const duplicate=accepted.some(item=>item.providerEventId===input.providerEventId);
      accepted.push(input);
      return{id:"event-a",duplicate};
    },
  },{resolveHmac:async()=>secret},{wakeInbound:async()=>{}});
  const send=(preference,signatureOverride)=>{
    const body={object:"whatsapp_business_account",entry:[{id:"987654321",changes:[{field:"user_preferences",value:{
      messaging_product:"whatsapp",metadata:{phone_number_id:"123456789"},
      contacts:[{profile:{name:"Synthetic customer"}}],user_preferences:[preference],
    }}]}]};
    const raw=JSON.stringify(body), signature=signatureOverride??createHmac("sha256",secret).update(raw).digest("hex");
    return controller.meta({rawBody:new TextEncoder().encode(raw),headers:{"x-hub-signature-256":"sha256="+signature}},body);
  };
  const stop={category:"marketing_messages",value:"stop",timestamp,wa_id:"12025550123",user_id:"US.synthetic",parent_user_id:"US.ENT.synthetic"};
  assert.equal((await send(stop)).count,1);
  assert.equal((await send({...stop,detail:"Synthetic profile evidence"})).duplicates,1);
  assert.deepEqual(accepted[0].marketingPreference,{phone:"12025550123",bsuid:"US.synthetic",accountId:"987654321",
    optedOut:true,observedAt:new Date(now).toISOString()});
  assert.deepEqual(accepted[0].payload,{redacted:true,payload_sha256:accepted[0].payloadSha256});
  assert.equal((await send({...stop,value:"resume",wa_id:undefined})).count,1);
  assert.equal(accepted[2].marketingPreference.optedOut,false);
  await assert.rejects(()=>send({...stop,wa_id:undefined,user_id:undefined}),/marketing preference is invalid/);
  await assert.rejects(()=>send(stop,"0".repeat(64)),/Invalid webhook signature/);
  assert.equal(accepted.length,3);
});

test("Meta pricing observations preserve strict classifications, canonical revisions and bounded source context",async()=>{
  const adapter=new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v24.0",phoneNumberIdFor:()=>"12345"});
  const base={id:"wamid.price",status:"delivered",timestamp:"1786291201",recipient_user_id:"SA.synthetic"};
  const envelope=status=>({entry:[{id:"987654",changes:[{value:{metadata:{phone_number_id:"12345"},statuses:[status]}}]}]});
  const normalized=async status=>(await adapter.normalizeReceipts("connection-meta",envelope(status)))[0];
  const absent=await normalized(base);assert.equal(absent.metaPricingObservation.state,"ABSENT");
  const free={billable:false,pricing_model:"PMP",category:"service",type:"free_customer_service"};
  const regular={...free,billable:true,type:"regular"};
  const first=await normalized({...base,pricing:free}),second=await normalized({...base,pricing:regular});
  assert.equal(first.metaPricingObservation.state,"VALID");assert.equal(first.metaPricingObservation.billable,false);
  assert.equal(second.metaPricingObservation.billable,true);assert.notEqual(first.receiptKey,second.receiptKey);
  assert.equal(first.metaPricingObservation.observedEnvelopeAccountId,"987654");assert.equal(first.metaPricingObservation.observedPhoneNumberId,"12345");
  assert.equal((await normalized({...base,pricing:Object.fromEntries(Object.entries(free).reverse())})).receiptKey,first.receiptKey);
  assert.equal((await normalized({...base,pricing:{...regular,category:"general_purpose_ai"}})).metaPricingObservation.state,"VALID");
  for(const pricing of [null,[],"private secret",{...free,billable:"false"},{...free,type:"private secret"},{...free,category:"unknown"},{...free,pricing_model:"unknown"},{billable:true},{...free,unknown:"private secret"},{...free,type:"private secret".repeat(500)}]){
    const receipt=await normalized({...base,pricing});assert.equal(receipt.status,"DELIVERED");assert.equal(receipt.metaPricingObservation.state,"UNAVAILABLE");
    assert.equal(receipt.metaPricingObservation.billable,null);assert.doesNotMatch(JSON.stringify(receipt),/private secret|SA\.synthetic/);
  }
  assert.notEqual((await normalized({...base,pricing:{...free,type:"unknown-a"}})).receiptKey,(await normalized({...base,pricing:{...free,type:"unknown-b"}})).receiptKey);
  assert.equal((await normalized({...base,pricing:{...free,extra:{b:2,a:1}}})).receiptKey,(await normalized({...base,pricing:{extra:{a:1,b:2},...free}})).receiptKey,'Unsupported nested observations also have canonical revision identity');
  let nested={secret:"private secret"};for(let i=0;i<200;i++)nested={nested};
  assert.equal((await normalized({...base,pricing:nested})).metaPricingObservation.state,"UNAVAILABLE");
  const invalidSource=envelope({...base,pricing:free});invalidSource.entry[0].id="private account";
  assert.equal((await adapter.normalizeReceipts("connection-meta",invalidSource))[0].metaPricingObservation.observedEnvelopeAccountId,null);
});

test("Meta correction receipts append without delivery regression, extra projections or identity restoration",async()=>{
  const adapter=new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v24.0",phoneNumberIdFor:()=>"12345"});
  const event={id:"event-a",tenantId:"tenant-a",connectionId:"connection-a",provider:"meta"};
  for(const initial of ["SENT","READ"]){
    let state=initial,redacted=false;const stored=new Map(),updates=[];
    const client={query:async(sql,values=[])=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.startsWith("SELECT set_config"))return{rows:[]};
      if(sql.includes("SELECT id,state,zammad_ticket_id,content_redacted_at"))return{rows:[{id:"delivery-a",state,content_redacted_at:redacted?new Date():null}]};
      if(sql.includes("FROM delivery_outbox")&&sql.includes("FOR UPDATE"))return{rows:[{id:"delivery-a",state}]};
      if(sql.includes("INSERT INTO delivery_receipts")){if(stored.has(values[6]))return{rows:[]};stored.set(values[6],values);return{rows:[{id:"receipt"}]};}
      if(sql.includes("UPDATE delivery_outbox")||sql.includes("project_delivery_status")){updates.push(sql);assert.fail("Nonadvancing corrections must not mutate delivery or projection");}
      throw new Error(sql);
    },release(){}};
    const repository=new InboundRepository({connect:async()=>client});
    const statuses=[{id:"wamid.a",status:initial==="SENT"?"sent":"delivered",timestamp:"1786291201",pricing:{billable:false,pricing_model:"PMP",category:"service",type:"free_customer_service"}}];
    const normalize=()=>adapter.normalizeReceipts("connection-a",{entry:[{id:"99999",changes:[{value:{metadata:{phone_number_id:"12345"},statuses}}]}]});
    assert.deepEqual(await repository.applyDeliveryReceipts(event,await normalize()),["RECORDED"]);
    statuses[0].pricing={...statuses[0].pricing,billable:true,type:"regular"};
    const corrections=await normalize();assert.deepEqual(await repository.applyDeliveryReceipts(event,corrections),["RECORDED"]);
    assert.deepEqual(await repository.applyDeliveryReceipts(event,corrections),["DUPLICATE"]);
    if(initial==="READ"){statuses[0].status="failed";assert.deepEqual(await repository.applyDeliveryReceipts(event,await normalize()),["RECORDED"]);}
    assert.equal(state,initial);assert.equal(updates.length,0);
    const row=[...stored.values()][1];assert.equal(row[15],"VALID");assert.equal(row[20],true);assert.equal(row[22],"99999");assert.equal(row[13],"IGNORED");
    const count=stored.size;redacted=true;statuses[0].pricing.category="general_purpose_ai";
    assert.deepEqual(await repository.applyDeliveryReceipts(event,await normalize()),["DUPLICATE"]);assert.equal(stored.size,count);
  }
});

test("participant-scoped receipt inbox processing records evidence without waking reconciliation",async()=>{
  const event={id:"event-receipt",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"provider-event",eventType:"message.ack.group",attempts:1,payload:{event:"message.ack.group",timestamp:1_786_291_200_000,payload:{id:"message-a_participant@lid",participant:"participant@lid",ack:2,ackName:"DEVICE"}}};
  const calls=[];
  const store={claim:async()=>[event],applyDeliveryReceipts:async(_event,receipts)=>{calls.push(["receipts",receipts.length,receipts[0].scope]);return["RECORDED"]},complete:async(_event,_lease,status,redact)=>calls.push(["complete",status,redact]),fail:async()=>{throw new Error("unexpected failure")}};
  const processor=new InboundProcessor(store,{resolve:async()=>{throw new Error("receipt processing must not resolve secrets")}});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.deepEqual(calls,[["receipts",1,"PARTICIPANT_OBSERVED"],["complete","PROCESSED",true]]);
});

test("one Meta webhook hands every receipt to one atomic repository call and wakes on an advance",async()=>{
  const event={id:"event-meta",tenantId:"tenant-a",connectionId:"connection-a",provider:"meta",providerEventId:"provider-event",eventType:"message.status",attempts:1,payload:{entry:[{changes:[{value:{statuses:[{id:"wamid.a",status:"read",timestamp:"1786291202"},{id:"wamid.a",status:"delivered",timestamp:"1786291201"}]}}]}]}};
  const calls=[];
  const store={claim:async()=>[event],applyDeliveryReceipts:async(_event,receipts)=>{calls.push(["atomic",receipts.length]);return["APPLIED","RECORDED"]},complete:async(_event,_lease,status,redact)=>calls.push(["complete",status,redact]),fail:async()=>{throw new Error("unexpected failure")}};
  const processor=new InboundProcessor(store,{resolve:async()=>{throw new Error("receipt processing must not resolve secrets")}});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:1});
  assert.deepEqual(calls,[["atomic",2],["complete","PROCESSED",true]]);
});

test("a signed Meta provider error is durably quarantined without resolving credentials",async()=>{
  const event={id:"event-meta-error",tenantId:"tenant-a",connectionId:"connection-a",provider:"meta",providerEventId:"provider-error",eventType:"meta.error",attempts:1,payload:{entry:[{changes:[{field:"messages",value:{errors:[{code:131000}]}}]}]}};
  const calls=[];
  const store={claim:async()=>[event],complete:async(_event,_lease,status,redact,error)=>calls.push([status,redact,error]),fail:async()=>assert.fail("A provider error signal must not retry")};
  const processor=new InboundProcessor(store,{resolve:async()=>assert.fail("A provider error signal must not resolve credentials")});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.deepEqual(calls,[["QUARANTINED",true,"META_PROVIDER_ERROR"]]);
});

test("repository commits every out-of-order receipt atomically and makes the retry item-idempotent",async()=>{
  for(const readOnly of [false,true]){
  let state="SENT";let released=0;const stored=new Set();const statements=[];const projections=[];
  const client={query:async(sql,values=[])=>{statements.push(sql);
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.startsWith("SELECT set_config"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT id,state,zammad_ticket_id,content_redacted_at"))return{rows:[{id:"delivery-a",state,zammad_ticket_id:"42",content_redacted_at:null}],rowCount:1};
    if(sql.includes("FROM delivery_outbox")&&sql.includes("FOR UPDATE"))return{rows:[{id:"delivery-a",state,zammad_ticket_id:"42"}],rowCount:1};
    if(sql.includes("INSERT INTO delivery_receipts")){const key=values[6];if(stored.has(key))return{rows:[],rowCount:0};stored.add(key);return{rows:[{id:`receipt-${stored.size}`}],rowCount:1}}
    if(sql.includes("UPDATE delivery_outbox")){assert.equal(values[4],state);state=values[0];return{rows:[],rowCount:1}}
    if(sql==="SELECT app.project_delivery_status($1,$2,$3,$4)"){projections.push(values);return{rows:[{project_delivery_status:1}],rowCount:1}}
    throw new Error(`Unexpected receipt SQL: ${sql}`);
  },release:()=>{released+=1}};
  const repositoryUnderTest=new InboundRepository({connect:async()=>client,end:async()=>{}});
  const event={id:"event-a",tenantId:"tenant-a",connectionId:"connection-a",provider:"meta",providerEventId:"provider-a",eventType:"message.status",payload:{},attempts:1};
  const delivered={provider:"meta",connectionId:"connection-a",externalMessageId:"wamid.a",receiptKey:"1".repeat(64),scope:"MESSAGE",status:"DELIVERED",providerStatus:"DELIVERED",timestamp:"2026-08-09T16:00:01.000Z",errorCodes:[],metadata:{errorCount:0}};
  const read={...delivered,receiptKey:"2".repeat(64),status:"READ",providerStatus:"READ",timestamp:"2026-08-09T16:00:02.000Z"};
  const adapter=new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v24.0",phoneNumberIdFor:()=>"12345"});
  const receipts=readOnly?await adapter.normalizeReceipts("connection-a",{entry:[{changes:[{value:{statuses:[{id:"wamid.a",status:"read",timestamp:"1786291202"}]}}]}]}):[read,delivered];
  assert.deepEqual(await repositoryUnderTest.applyDeliveryReceipts(event,receipts),receipts.map(()=>"APPLIED"));
  assert.equal(state,"READ");assert.equal(statements.filter(sql=>sql==="BEGIN").length,1);assert.equal(statements.filter(sql=>sql==="COMMIT").length,1);
  assert.deepEqual(projections,readOnly?[["delivery-a","READ","wamid.a",null]]:[["delivery-a","DELIVERED","wamid.a",null],["delivery-a","READ","wamid.a",null]]);
  assert.deepEqual(await repositoryUnderTest.applyDeliveryReceipts(event,receipts),receipts.map(()=>"DUPLICATE"));
  assert.equal(state,"READ");assert.equal(stored.size,receipts.length);assert.equal(released,2);
  }
});

test("deterministic review reprocess is version-fenced, audited, idempotent, and wakes once",async()=>{
  const reviewId="11111111-1111-4111-8111-111111111111";const ruleId="22222222-2222-4222-8222-222222222222";const actionRows=new Map();const events=[];const audits=[];let review={id:reviewId,source_kind:"INBOUND",reason_code:"IDENTIFIER_LIMIT_EXCEEDED",state:"OPEN",connection_id:"33333333-3333-4333-8333-333333333333",group_binding_id:"44444444-4444-4444-8444-444444444444",source_event_inbox_id:"55555555-5555-4555-8555-555555555550",version:1,safe_summary:"Message exceeded limit",governing_client_routing_version_id:null};
  let originalIdentity={from_api:false};
  const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("FROM quarantine_action_requests")){const row=actionRows.get(values[1]);return{rows:row?[row]:[],rowCount:row?1:0}}
    if(sql.includes("FROM quarantine_records q")&&sql.includes("FOR UPDATE OF q"))return{rows:[{...review}],rowCount:1};
    if(sql.includes("FROM privacy_jobs job"))return{rows:[],rowCount:0};
    if(sql.includes("JOIN trigger_rules r")&&sql.includes("r.id=$3"))return{rows:[{id:ruleId,name:"Ten digits",matcher_type:"exact_length",pattern:"[0-9]{10}",matcher_options:{digitLength:10},priority:1,external_group_id:"fixture-0009@example.test",provider:"META"}],rowCount:1};
    if(sql.includes("SELECT message.from_api FROM normalized_messages"))return{rows:originalIdentity?[originalIdentity]:[],rowCount:originalIdentity?1:0};
    if(sql.includes("INSERT INTO event_inbox")){events.push(values);return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE quarantine_records SET state='REPROCESS_QUEUED'")){if(review.state!=="OPEN"||review.version!==values[4])return{rows:[],rowCount:0};review={...review,state:"REPROCESS_QUEUED",version:values[1]};return{rows:[],rowCount:1}}
    if(sql.includes("INSERT INTO quarantine_action_requests")){actionRows.set(values[3],{quarantine_id:values[1],actor_id:values[2],request_sha256:values[4],action:values[5],result_state:values[6],result_version:values[7]});return{rows:[],rowCount:1}}
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[],rowCount:1}}
    throw new Error(`Unexpected review SQL: ${sql}`);
  }};
  const wakes=[];const controllerUnderTest=new QuarantineController({withTenant:async(_tenant,operation)=>operation(client)},new RuleTestService(),{wakeInbound:async tenant=>wakes.push(tenant)});
  const request={id:"request-a",principal:{subject:"owner-a",userId:"55555555-5555-4555-8555-555555555555",tenantId:"66666666-6666-4666-8666-666666666666",email:"owner@example.test",displayName:"Owner",role:"tenant_owner"}};
  const body={expectedVersion:1,ruleId,normalizedReference:"١٢٣٤٥٦٧٨٩٠"};const key="review-idempotency-key-a";
  for(const unavailable of [null,{from_api:true}]){
    originalIdentity=unavailable;
    await assert.rejects(()=>controllerUnderTest.reprocess(request,reviewId,key,body),/Original message identity/);
    assert.equal(events.length,0);assert.equal(audits.length,0);assert.equal(wakes.length,0);
  }
  originalIdentity={from_api:false};
  assert.deepEqual(await controllerUnderTest.reprocess(request,reviewId,key,body),{id:reviewId,state:"REPROCESS_QUEUED",version:2,duplicate:false});
  assert.equal(JSON.parse(events[0][5]).normalizedReference,"1234567890");assert.equal(audits.length,1);assert.deepEqual(wakes,[request.principal.tenantId]);
  assert.deepEqual(await controllerUnderTest.reprocess(request,reviewId,key,body),{id:reviewId,state:"REPROCESS_QUEUED",version:2,duplicate:true});
  assert.equal(events.length,1);assert.equal(audits.length,1);assert.deepEqual(wakes,[request.principal.tenantId]);
  await assert.rejects(()=>controllerUnderTest.reprocess(request,reviewId,key,{...body,normalizedReference:"0987654321"}),/different review action/);
  await assert.rejects(()=>controllerUnderTest.reprocess(request,"77777777-7777-4777-8777-777777777777",key,body),/different review action/);
});

test("review reprocess fails closed before mutation while deletion or targeted retention is active",async()=>{
  const reviewId="11111111-1111-4111-8111-111111111112";const ruleId="22222222-2222-4222-8222-222222222223";
  for(const privacyJob of ["DELETE","RETENTION_SWEEP"]){
    const mutations=[];const locks=[];
    const client={query:async(sql)=>{
      if(sql.includes("pg_advisory_xact_lock")){locks.push(sql);return{rows:[],rowCount:1}}
      if(sql.includes("FROM quarantine_action_requests"))return{rows:[],rowCount:0};
      if(sql.includes("FROM quarantine_records q")&&sql.includes("FOR UPDATE OF q"))return{rows:[{id:reviewId,source_kind:"INBOUND",reason_code:"IDENTIFIER_LIMIT_EXCEEDED",state:"OPEN",connection_id:"33333333-3333-4333-8333-333333333334",group_binding_id:"44444444-4444-4444-8444-444444444445",source_event_inbox_id:"55555555-5555-4555-8555-555555555556",version:1,safe_summary:"Message exceeded limit",governing_client_routing_version_id:null}],rowCount:1};
      if(sql.includes("FROM privacy_jobs job"))return{rows:[{job_type:privacyJob}],rowCount:1};
      mutations.push(sql);return{rows:[],rowCount:1};
    }};
    const wakes=[];const controllerUnderTest=new QuarantineController({withTenant:async(_tenant,operation)=>operation(client)},new RuleTestService(),{wakeInbound:async tenant=>wakes.push(tenant)});
    const request={id:`request-${privacyJob}`,principal:{subject:"owner-a",userId:"66666666-6666-4666-8666-666666666667",tenantId:"77777777-7777-4777-8777-777777777777",email:"owner@example.test",displayName:"Owner",role:"tenant_owner"}};
    await assert.rejects(()=>controllerUnderTest.reprocess(request,reviewId,`privacy-reprocess-${privacyJob}`,{expectedVersion:1,ruleId,normalizedReference:"1234567890"}),/privacy processing is active/);
    assert.equal(locks.length,2);assert.deepEqual(mutations,[]);assert.deepEqual(wakes,[]);
  }
});

test("group action review defaults to completion without resend and resumes the fenced inbound event",async()=>{
  const reviewId="11111111-1111-4111-8111-111111111119";const actionId="22222222-2222-4222-8222-222222222229";const eventId="33333333-3333-4333-8333-333333333339";const actionRows=new Map();const audits=[];const transitions=[];
  const review={id:reviewId,source_kind:"INBOUND",reason_code:"GROUP_ACTION_OUTCOME_UNKNOWN",state:"OPEN",connection_id:"44444444-4444-4444-8444-444444444449",group_binding_id:"55555555-5555-4555-8555-555555555559",group_action_execution_id:actionId,source_event_inbox_id:eventId,version:1,safe_summary:"External action acceptance could not be confirmed"};
  const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("FROM quarantine_action_requests")){const row=actionRows.get(values[1]);return{rows:row?[row]:[],rowCount:row?1:0}}
    if(sql.includes("FROM quarantine_records WHERE")&&sql.includes("FOR UPDATE"))return{rows:[review],rowCount:1};
    if(sql.includes("FROM group_action_executions execution"))return{rows:[{id:actionId,state:"OUTCOME_UNKNOWN",attempts:1,action_key:"shipment.update",event_status:"FAILED_TERMINAL"}],rowCount:1};
    if(sql.includes("UPDATE group_action_executions")){transitions.push(["action",values[0]]);return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE event_inbox SET status='PROCESSED'")){transitions.push(["event","PROCESSED"]);return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE normalized_messages SET processing_status='COMPLETE'")){transitions.push(["message","COMPLETE"]);return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE quarantine_records SET state=$1")){transitions.push(["review",values[0],values[1]]);return{rows:[],rowCount:1}}
    if(sql.includes("INSERT INTO quarantine_action_requests")){actionRows.set(values[3],{quarantine_id:values[1],actor_id:values[2],request_sha256:values[4],action:values[5],result_state:values[6],result_version:values[7]});return{rows:[],rowCount:1}}
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[],rowCount:1}}
    throw new Error(`Unexpected group action review SQL: ${sql}`);
  }};
  const wakes=[];const controllerUnderTest=new QuarantineController({withTenant:async(_tenant,operation)=>operation(client)},new RuleTestService(),{wakeInbound:async tenant=>wakes.push(tenant)});
  const request={id:"request-action-complete",principal:{subject:"owner-a",userId:"66666666-6666-4666-8666-666666666669",tenantId:"77777777-7777-4777-8777-777777777779",email:"owner@example.test",displayName:"Owner",role:"tenant_owner"}};
  assert.deepEqual(await controllerUnderTest.resolve(request,reviewId,"group-action-complete-key",{expectedVersion:1,resolutionCode:"ACTION_ALREADY_COMPLETED"}),{id:reviewId,state:"RESOLVED",version:2,duplicate:false});
  assert.deepEqual(transitions,[["action","SUCCEEDED"],["event","PROCESSED"],["message","COMPLETE"],["review","RESOLVED","ACTION_ALREADY_COMPLETED"]]);
  assert.equal(audits.length,1);assert.equal(audits[0][2],"review.group_action_completed_without_retry");assert.deepEqual(audits[0][6],{state:"RESOLVED",version:2,resolution_code:"ACTION_ALREADY_COMPLETED",external_action_reissued:false,automatic_reply_queued:false});assert.deepEqual(wakes,[]);
});

test("group action retry is server-confirmed, audited, and never reuses the completed execution state",async()=>{
  const reviewId="11111111-1111-4111-8111-111111111118";const actionId="22222222-2222-4222-8222-222222222228";const eventId="33333333-3333-4333-8333-333333333338";let databaseCalls=0;let requestedState="";const audits=[];
  const review={id:reviewId,source_kind:"INBOUND",reason_code:"GROUP_ACTION_OUTCOME_UNKNOWN",state:"OPEN",connection_id:null,group_binding_id:null,group_action_execution_id:actionId,source_event_inbox_id:eventId,version:3,safe_summary:"External action acceptance could not be confirmed"};
  const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("FROM privacy_jobs job"))return{rows:[],rowCount:0};
    if(sql.includes("FROM quarantine_action_requests"))return{rows:[],rowCount:0};
    if(sql.includes("FROM quarantine_records WHERE")&&sql.includes("FOR UPDATE"))return{rows:[review],rowCount:1};
    if(sql.includes("FROM group_action_executions execution"))return{rows:[{id:actionId,state:"OUTCOME_UNKNOWN",attempts:2,action_key:"shipment.create",event_status:"FAILED_TERMINAL"}],rowCount:1};
    if(sql.includes("UPDATE group_action_executions")){requestedState=values[0];return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE event_inbox SET status='FAILED_RETRYABLE'"))return{rows:[],rowCount:1};
    if(sql.includes("UPDATE quarantine_records SET state=$1"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO quarantine_action_requests"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[],rowCount:1}}
    throw new Error(`Unexpected group action retry SQL: ${sql}`);
  }};
  const database={withTenant:async(_tenant,operation)=>{databaseCalls+=1;return operation(client)}};const wakes=[];const controllerUnderTest=new QuarantineController(database,new RuleTestService(),{wakeInbound:async tenant=>wakes.push(tenant)});
  const request={id:"request-action-retry",principal:{subject:"owner-a",userId:"66666666-6666-4666-8666-666666666668",tenantId:"77777777-7777-4777-8777-777777777778",email:"owner@example.test",displayName:"Owner",role:"tenant_owner"}};
  await assert.rejects(()=>controllerUnderTest.resolve(request,reviewId,"group-action-retry-key",{expectedVersion:3,resolutionCode:"ACTION_RETRY_REQUESTED"}),/Type RETRY/);
  assert.equal(databaseCalls,0);
  assert.deepEqual(await controllerUnderTest.resolve(request,reviewId,"group-action-retry-key",{expectedVersion:3,resolutionCode:"ACTION_RETRY_REQUESTED",confirmation:"RETRY"}),{id:reviewId,state:"RESOLVED",version:4,duplicate:false});
  assert.equal(requestedState,"PREPARED");assert.equal(audits[0][2],"review.group_action_retry_requested");assert.deepEqual(audits[0][6],{state:"RESOLVED",version:4,resolution_code:"ACTION_RETRY_REQUESTED",external_action_retry_requested:true});assert.deepEqual(wakes,[request.principal.tenantId]);
});

test("a reprocess whose routing context disappeared reopens review instead of getting stuck",async()=>{
  const event={id:"event-review",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"review-a",eventType:"quarantine.reprocess",attempts:1,payload:{quarantineId:"11111111-1111-4111-8111-111111111111",externalGroupId:"fixture-0009@example.test",normalizedReference:"1234567890",ruleId:"22222222-2222-4222-8222-222222222222",requestedAt:"2026-08-09T16:00:00.000Z"}};
  const calls=[];const store={claim:async()=>[event],originalReprocessParticipant:async()=>({replyToMessageId:"false_group-a@g.us_SOURCE",participantId:"12025550132@c.us",fromApi:false,fromMe:false}),context:async()=>null,fail:async(_event,_lease,retryable,error)=>calls.push(["failed",retryable,error]),reopenQuarantineReprocess:async(_event,code)=>calls.push(["reopened",code]),complete:async()=>{throw new Error("missing review context must not be ignored")}};
  const processor=new InboundProcessor(store,{resolve:async()=>{throw new Error("must not resolve secrets")}});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.deepEqual(calls,[["failed",false,"Review routing context is no longer active"],["reopened","REFERENCE_NO_LONGER_VALID"]]);
});

test("review execution restores original identity and refuses missing or API-origin senders",async()=>{
  const event={id:"event-review",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"review-a",eventType:"quarantine.reprocess",attempts:1,payload:{quarantineId:"11111111-1111-4111-8111-111111111111",externalGroupId:"fixture-0009@example.test",normalizedReference:"1234567890",ruleId:"22222222-2222-4222-8222-222222222222",requestedAt:"2026-08-09T16:00:00.000Z"}};
  for(const identity of [null,{replyToMessageId:"false_group-a@g.us_SOURCE",participantId:"987654321@lid",participantName:"Original nickname",fromApi:true,fromMe:false},{replyToMessageId:"false_group-a@g.us_SOURCE",participantId:"987654321@lid",participantName:"Original nickname",fromApi:false,fromMe:true}]){
    let contextCalls=0,reopened=0;
    const store={claim:async()=>[event],originalReprocessParticipant:async()=>identity,
      context:async(_event,group,participant)=>{contextCalls++;assert.equal(group,"fixture-0009@example.test");assert.equal(participant,"987654321@lid");return null;},
      fail:async(_event,_lease,retryable)=>assert.equal(retryable,false),reopenQuarantineReprocess:async()=>{reopened++;},
      complete:async()=>assert.fail("must not silently complete an unprocessable review")};
    const processor=new InboundProcessor(store,{resolve:async()=>assert.fail("no external effects")});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.equal(contextCalls,identity&&!identity.fromApi?1:0);assert.equal(reopened,1);
  }
});

test("review execution rejects an invalid original reply target before normalization or downstream effects",async()=>{
  const event={id:"event-review",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"review-a",eventType:"quarantine.reprocess",attempts:1,payload:{quarantineId:"11111111-1111-4111-8111-111111111111",externalGroupId:"fixture-0009@example.test",normalizedReference:"1234567890",ruleId:"22222222-2222-4222-8222-222222222222",requestedAt:"2026-08-09T16:00:00.000Z"}};
  for(const replyToMessageId of [undefined,"","bad\u0001target","x".repeat(1025)]){
    const calls=[],forbidden=async()=>assert.fail("invalid reply target must fail before normalization, routing, secrets, or external effects"),store={claim:async()=>[event],originalReprocessParticipant:async()=>({replyToMessageId,participantId:"987654321@lid",participantName:"Original nickname",fromApi:false,fromMe:false}),normalize:forbidden,context:forbidden,correlate:forbidden,enqueueAcknowledgement:forbidden,fail:async(_event,_lease,retryable,error)=>calls.push(["failed",retryable,error]),reopenQuarantineReprocess:async(_event,code)=>calls.push(["reopened",code]),complete:forbidden};
    const processor=new InboundProcessor(store,{resolve:forbidden});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.deepEqual(calls,[["failed",false,"Original provider reply target is unavailable"],["reopened","REFERENCE_NO_LONGER_VALID"]]);
  }
});

test("receipt schema is append-only, tenant scoped, exact-match, and monotonic",()=>{
  assert.match(migration,/CREATE TABLE delivery_receipts/);
  assert.match(migration,/UNIQUE \(tenant_id,connection_id,receipt_key_sha256\)/);
  assert.match(migration,/receipt_scope IN \('MESSAGE','PARTICIPANT_OBSERVED'\)/);
  assert.match(migration,/applied_state IN \('SENT','DELIVERED','READ','FAILED_TERMINAL','OBSERVED','IGNORED'\)/);
  assert.match(migration,/delivery_outbox_external_message_once_idx/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/delivery_receipts_append_only/);
  assert.match(repository,/tenant_id=\$1 AND connection_id=\$2 AND external_message_id=\$3/);
  assert.match(repository,/applyDeliveryReceipts/);
  assert.match(repository,/ON CONFLICT \(tenant_id,connection_id,receipt_key_sha256\) DO NOTHING/);
  assert.match(repository,/receipt\.scope==="PARTICIPANT_OBSERVED"\?"OBSERVED"/);
  assert.match(repository,/for\(const receipt of ordered\)results\.push/);
  assert.doesNotMatch(ingress,/value:\{\.\.\.base,statuses\}/);
  assert.match(ingress,/value:\{\.\.\.base,statuses:\[status\]\}/);
  assert.match(repository,/receipt==="DELIVERED"&&current==="SENT"/);
  assert.match(repository,/receipt==="READ"&&\(current==="SENT"\|\|current==="DELIVERED"\)/);
  assert.match(repository,/receipt==="FAILED"&&current==="SENT"/);
  assert.doesNotMatch(repository,/receipt==="FAILED"&&current==="READ"/);
  assert.match(repository,/SELECT app\.project_delivery_status\(\$1,\$2,\$3,\$4\)/);
  assert.match(statusProjectionGrantMigration,/GRANT INSERT ON zammad_status_outbox TO wasalx_connector_worker;/);
});

test("quarantine persists safe metadata only and actions are fenced, audited, and idempotent",()=>{
  assert.match(migration,/CREATE TABLE quarantine_records/);
  assert.match(migration,/safe_metadata::text !~\*/);
  assert.match(migration,/quarantine may reference clean media only/);
  assert.match(migration,/CREATE TABLE quarantine_action_requests/);
  assert.match(migration,/UNIQUE \(tenant_id,idempotency_key\)/);
  assert.match(controller,/state='OPEN' AND version=\$5/);
  assert.match(controller,/The corrected reference must be exactly one deterministic match/);
  assert.match(controller,/b\.state='ACTIVE' AND c\.state='WORKING'/);
  assert.match(controller,/review\.reprocess_queued/);
  assert.match(controller,/review\.resolved/);
  assert.match(controller,/review\.discarded/);
  for (const key of [
    "tenant.deliveries.review.reprocessBody",
    "tenant.deliveries.review.emptyTitle",
    "tenant.deliveries.review.unavailable",
    "tenant.deliveries.review.confirmDiscard",
  ]) assert.match(portal, new RegExp(key.replaceAll(".", "\\.")));
  assert.match(englishTenantMessages["tenant.deliveries.review.reprocessBody"], /Original rejected content is unavailable/u);
  assert.equal(englishTenantMessages["tenant.deliveries.review.emptyTitle"], "Review queue is clear");
  assert.equal(englishTenantMessages["tenant.deliveries.review.unavailable"], "Review queue unavailable");
  assert.equal(englishTenantMessages["tenant.deliveries.review.confirmDiscard"], "Confirm discard");
});

test("ambiguous group actions reuse the bounded review queue without copying action inputs",()=>{
  assert.match(groupActionRecoveryMigration,/ADD COLUMN group_action_execution_id uuid/);
  assert.match(groupActionRecoveryMigration,/REFERENCES group_action_executions\(tenant_id,id\) ON DELETE CASCADE/);
  assert.match(groupActionRecoveryMigration,/group_action_execution_id IS NOT NULL[\s\S]*source_kind='INBOUND'[\s\S]*reason_code='GROUP_ACTION_OUTCOME_UNKNOWN'/);
  assert.match(groupActionRecoveryMigration,/GROUP_ACTION_OUTCOME_UNKNOWN/);
  assert.match(groupActionRecoveryMigration,/AFTER UPDATE OF state ON group_action_executions/);
  assert.match(groupActionRecoveryMigration,/NEW\.state='OUTCOME_UNKNOWN'/);
  assert.match(groupActionRecoveryMigration,/action_key/);
  assert.match(groupActionRecoveryMigration,/attempt_count/);
  assert.doesNotMatch(groupActionRecoveryMigration,/request_input/);
  assert.match(controller,/ACTION_ALREADY_COMPLETED/);
  assert.match(controller,/ACTION_RETRY_REQUESTED/);
  assert.match(controller,/body\.confirmation!=="RETRY"/);
  assert.match(controller,/retry\?"PREPARED":"SUCCEEDED"/);
  assert.match(controller,/status='PROCESSED'/);
  assert.match(controller,/processing_status='COMPLETE'/);
  assert.match(controller,/wakeRequired:resolutionCode==="ACTION_RETRY_REQUESTED"/);
  assert.match(controller,/automatic_reply_queued:false/);
  assert.match(controller,/external_action_retry_requested:true/);
  assert.match(portal,/pattern="RETRY"/);
  assert.match(portal,/ACTION_ALREADY_COMPLETED/);
});
