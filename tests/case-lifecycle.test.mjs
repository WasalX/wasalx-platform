import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SignJWT } from "jose";
import { CasesController } from "../services/control-api/dist/cases.controller.js";
import { can } from "../services/control-api/dist/rbac.js";
import { ServiceAuthService } from "../services/control-api/dist/service-auth.service.js";
import { ZammadTicketStateController } from "../services/control-api/dist/zammad-ticket-state.controller.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";
import { formatZammadTicketTitle, ZammadClient, ZammadError } from "../services/connector-worker/dist/packages/zammad/src/client.js";

const tenantId="10000000-0000-4000-8000-000000000001";
const instanceId="11000000-0000-4000-8000-000000000001";
const userId="12000000-0000-4000-8000-000000000001";
const correlationId="13000000-0000-4000-8000-000000000001";
const secret="case-lifecycle-service-secret-at-least-32-bytes";
const secretReference=`secret://tenants/${tenantId}/zammad/service`;

test("ticket reads expand and validate the direct conversation contract",async(t)=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
  const client=new ZammadClient({baseUrl:"https://zammad.example",token:"test-token"});
  const valid={id:42,number:"90042",state_id:2,state:"closed",title:"Customer title",group:"Support"};
  globalThis.fetch=async(input)=>{
    const url=new URL(input);assert.equal(url.pathname,"/api/v1/tickets/42");
    return Response.json(url.searchParams.get("expand")==="true"?valid:{id:42,state_id:2,title:valid.title});
  };
  assert.deepEqual(await client.getTicket(42),valid);
  for(const invalid of [null,[],{...valid,state:undefined},{...valid,state:null},{...valid,state:" "},{...valid,id:43},{...valid,id:"bad"},{...valid,title:null}]){
    globalThis.fetch=async()=>Response.json(invalid);
    await assert.rejects(()=>client.getTicket(42),error=>error instanceof ZammadError&&!error.retryable&&error.message==="Zammad ticket response is invalid");
  }
  for(const [status,retryable] of [[404,false],[429,true],[503,true]]){
    globalThis.fetch=async()=>new Response(null,{status});
    await assert.rejects(()=>client.getTicket(42),error=>error instanceof ZammadError&&error.status===status&&error.retryable===retryable);
  }
});

async function serviceToken(scope="zammad:ticket-state"){
  const now=Math.floor(Date.now()/1000);
  return new SignJWT({tenant_id:tenantId,instance_id:instanceId,scope})
    .setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer("wasalx-zammad").setAudience("wasalx-control")
    .setSubject(instanceId).setIssuedAt(now).setExpirationTime(now+120).setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(secret));
}
function serviceAuth(){return new ServiceAuthService({rows:async(id,sql,values)=>{assert.equal(id,tenantId);assert.match(sql,/service_secret_reference/);return values[1]===instanceId?[{id:instanceId,tenant_id:tenantId,service_secret_reference:secretReference}]:[]}},{resolveSigningSecret:async(reference,owner)=>{assert.equal(reference,secretReference);assert.deepEqual(owner,{tenantId,instanceId});return secret}})}

function transitionBody(overrides={}){
  const transitionedAt=new Date(Date.now()-1_000).toISOString();
  return{tenant_id:tenantId,ticket_id:42,ticket_number:"10382",state_id:4,state_name:"closed",state_type_name:"closed",transitioned_at:transitionedAt,idempotency_key:`ticket-state:42:4:${transitionedAt}`,...overrides};
}

test("Zammad ticket-state callback is tenant-authenticated, durable, idempotent, and stale-fenced",async()=>{
  const queries=[];
  const database={
    rows:async()=>[{id:instanceId}],
    withTenant:async(id,operation)=>{assert.equal(id,tenantId);return operation({query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
      queries.push({sql,values});
      if(sql.includes("FROM zammad_instances"))return{rows:[{id:instanceId}],rowCount:1};
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
      if(sql.includes("AS stale"))return{rows:[{stale:false}],rowCount:1};
      if(sql.includes("FROM bot_conversations"))return{rows:[],rowCount:0};
      if(sql.includes("INSERT INTO zammad_ticket_state_events"))return{rows:[{id:"event-1",request_sha256:values[3],processing_state:"ACCEPTED",correlations_updated:0}],rowCount:1};
      if(sql.includes("UPDATE case_correlations"))return{rows:[{id:correlationId}],rowCount:1};
      if(sql.includes("UPDATE zammad_ticket_state_events"))return{rows:[{id:"event-1",request_sha256:"hash",processing_state:"APPLIED",correlations_updated:1}],rowCount:1};
      if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
      throw new Error(`Unexpected query: ${sql}`);
    }})},
  };
  const controller=new ZammadTicketStateController(database,serviceAuth());
  const body=transitionBody();
  const result=await controller.ticketState(`Bearer ${await serviceToken()}`,body.idempotency_key,"request-state-1",body);
  assert.deepEqual(result,{id:"event-1",state:"APPLIED",correlations_updated:1,duplicate:false});
  const update=queries.find(item=>item.sql.includes("UPDATE case_correlations"));
  assert.equal(update.values[0],"RESOLVED");
  assert.match(update.sql,/state<>'DETACHED'/);
  assert.match(update.sql,/zammad_state_observed_at<\$3/);
  assert.ok(queries.some(item=>item.sql.includes("INSERT INTO audit_events")));

  const fingerprint=queries.find(item=>item.sql.includes("INSERT INTO zammad_ticket_state_events")).values[3];
  const replayDatabase={rows:async()=>[{id:instanceId}],withTenant:async(_id,operation)=>operation({query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    if(sql.includes("FROM zammad_instances"))return{rows:[{id:instanceId}],rowCount:1};
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO zammad_ticket_state_events"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT id,request_sha256"))return{rows:[{id:"event-1",request_sha256:fingerprint,processing_state:"APPLIED",correlations_updated:1}],rowCount:1};
    throw new Error(`Replay must not mutate correlations: ${sql}`);
  }})};
  const replayController=new ZammadTicketStateController(replayDatabase,serviceAuth());
  assert.deepEqual(await replayController.ticketState(`Bearer ${await serviceToken()}`,body.idempotency_key,"request-state-replay",body),{id:"event-1",state:"APPLIED",correlations_updated:1,duplicate:true});
});

test("ticket-state callback rejects tenant mismatch, conflicting replay, and malformed idempotency",async()=>{
  const activeDatabase={rows:async()=>[{id:instanceId}],withTenant:async(_id,operation)=>operation({query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    if(sql.includes("FROM zammad_instances"))return{rows:[{id:instanceId}],rowCount:1};
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO zammad_ticket_state_events"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT id,request_sha256"))return{rows:[{id:"event-1",request_sha256:"different",processing_state:"APPLIED",correlations_updated:1}],rowCount:1};
    throw new Error(sql);
  }})};
  const controller=new ZammadTicketStateController(activeDatabase,serviceAuth());
  const body=transitionBody();
  const authorization=`Bearer ${await serviceToken()}`;
  await assert.rejects(()=>controller.ticketState(authorization,body.idempotency_key,"request",{...body,tenant_id:"20000000-0000-4000-8000-000000000002"}));
  await assert.rejects(()=>controller.ticketState(authorization,body.idempotency_key,"request",body),namedError("ConflictException"));
  await assert.rejects(()=>controller.ticketState(authorization,"different-key","request",body),namedError("BadRequestException"));
});

test("supervisor/admin detach is reauthenticated, optimistic, audited, and replay-safe",async()=>{
  const queries=[];
  const resultAt=new Date().toISOString();
  const database={withTenant:async(id,operation)=>{assert.equal(id,tenantId);return operation({query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    queries.push({sql,values});
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("FROM tenant_settings"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("FROM case_detach_operations"))return{rows:[],rowCount:0};
    if(sql.includes("FROM case_correlations")&&sql.includes("FOR UPDATE"))return{rows:[{id:correlationId,normalized_reference:"ABC1234567",zammad_ticket_id:"42",zammad_ticket_number:"10382",state:"RESOLVED",generation:1,version:"7",group_binding_id:"binding-1",replaced_by_correlation_id:null}],rowCount:1};
    if(sql.includes("UPDATE case_correlations"))return{rows:[{id:correlationId,state:"DETACHED",version:"8",detached_at:resultAt}],rowCount:1};
    if(sql.includes("INSERT INTO case_detach_operations")||sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  }})}};
  const controller=new CasesController(database);
  const request={id:"request-detach",principal:{subject:"oidc-user",userId,tenantId,email:"admin@example.test",displayName:"Admin",role:"supervisor",authenticatedAt:Math.floor(Date.now()/1000)-60,authenticationMethods:["pwd","mfa"]}};
  const result=await controller.detach(request,correlationId,"detach-key-1",{expectedVersion:7,confirmation:"START_NEW_CASE"});
  assert.equal(result.state,"DETACHED");assert.equal(result.version,8);assert.equal(result.next_generation,2);assert.equal(result.duplicate,false);
  assert.match(queries[0].sql,/pg_advisory_xact_lock/);
  assert.ok(queries.findIndex(item=>item.sql.includes("pg_advisory_xact_lock"))<queries.findIndex(item=>item.sql.includes("FROM case_detach_operations")));
  const update=queries.find(item=>item.sql.includes("UPDATE case_correlations"));
  assert.match(update.sql,/version=\$4/);assert.equal(update.values[0],userId);
  assert.ok(queries.some(item=>item.sql.includes("INSERT INTO case_detach_operations")));
  assert.ok(queries.some(item=>item.sql.includes("INSERT INTO audit_events")));

  const staleRequest={...request,principal:{...request.principal,authenticatedAt:Math.floor(Date.now()/1000)-3_600}};
  await assert.rejects(()=>controller.detach(staleRequest,correlationId,"detach-key-2",{expectedVersion:8,confirmation:"START_NEW_CASE"}),namedError("ForbiddenException"));
});

test("a serialized detach replay returns the durable result without requiring a fresh privileged session",async()=>{
  const durableResult={id:correlationId,state:"DETACHED",version:8,generation:1,next_generation:2};
  const requestBody={expectedVersion:7,confirmation:"START_NEW_CASE"};
  const requestSha256=(await import("node:crypto")).createHash("sha256")
    .update(JSON.stringify({correlationId,expectedVersion:7,confirmation:"START_NEW_CASE"}))
    .digest("hex");
  const queries=[];
  const database={withTenant:async(_id,operation)=>operation({query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    queries.push(sql);
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.includes("FROM case_detach_operations"))return{rows:[{request_sha256:requestSha256,result:durableResult}],rowCount:1};
    throw new Error(`A replay must not reauthenticate or mutate: ${sql}`);
  }})};
  const controller=new CasesController(database);
  const staleRequest={id:"request-replay",principal:{subject:"oidc-user",userId,tenantId,email:"admin@example.test",displayName:"Admin",role:"supervisor",authenticatedAt:Math.floor(Date.now()/1000)-86_400}};
  assert.deepEqual(await controller.detach(staleRequest,correlationId,"detach-key-replay",requestBody),{...durableResult,duplicate:true});
  assert.equal(queries.length,2);
});

test("case permissions match the supervisor/admin product contract",()=>{
  assert.equal(can("tenant_owner","case:detach"),true);
  assert.equal(can("tenant_admin","case:detach"),true);
  assert.equal(can("supervisor","case:detach"),true);
  assert.equal(can("auditor","case:read"),true);
  assert.equal(can("auditor","case:detach"),false);
  assert.equal(can("agent","case:read"),false);
});

test("case lookup reaches an exact older ticket and agent navigation stays tenant-bound",async()=>{
  const calls=[];
  const database={rows:async(id,sql,values)=>{
    assert.equal(id,tenantId);calls.push({sql,values});
    if(sql.includes("SELECT correlation.zammad_ticket_number"))return[{zammad_ticket_number:"10001"}];
    return[{id:correlationId,zammad_ticket_number:"10001",zammad_agent_available:true}];
  }};
  const controller=new CasesController(database);
  const request={principal:{tenantId,role:"tenant_owner"}};
  await controller.list(request,undefined,"200","10001");
  assert.equal(calls[0].values[3],"10001");
  assert.match(calls[0].sql,/correlation\.zammad_ticket_number=\$4/u);
  assert.deepEqual(await controller.agentDestination(request,correlationId),{ticket_number:"10001"});
  assert.equal(calls[1].values[0],tenantId);
  assert.throws(()=>controller.list(request,undefined,"200","../42"),namedError("BadRequestException"));
  const unsafe=new CasesController({rows:async()=>[{zammad_ticket_id:"42"}]});
  await assert.rejects(()=>unsafe.agentDestination(request,correlationId),namedError("NotFoundException"));
  await assert.rejects(()=>controller.agentDestination({principal:{tenantId,role:"auditor"}},correlationId),namedError("ForbiddenException"));
  assert.match(calls[1].sql,/correlation\.tenant_id=\$1[\s\S]*correlation\.id=\$2/u);
  assert.doesNotMatch(calls[1].sql,/agent_base_url/u);
});

test("correlation repository reopens resolved cases and creates linked generations after detach",async()=>{
  const calls=[];
  let phase="resolved";
  const client={query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    if(sql.includes("pg_advisory_xact_lock")&&sql.includes("FROM zammad_instances"))return{rows:[{}],rowCount:1};
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("set_config")||sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:0};
    if(sql.includes("state<>'DETACHED'")&&sql.includes("FROM case_correlations"))return phase!=="detached"?{rows:[{id:correlationId,zammad_ticket_id:"42",zammad_ticket_number:"10382",state:phase==="resolved"?"RESOLVED":"OPEN",generation:1}],rowCount:1}:{rows:[],rowCount:0};
    if(sql.startsWith("SELECT 1 FROM message_links"))return{rows:[],rowCount:0};
    if(sql.includes("UPDATE case_correlations")&&sql.includes("latest_external_message_id")){calls.push("updated-open");return{rows:[],rowCount:1};}
    if(sql.includes("ORDER BY generation DESC")&&sql.includes("FOR UPDATE"))return{rows:[{id:correlationId,generation:1}],rowCount:1};
    if(sql.includes("INSERT INTO case_correlations"))return{rows:[{id:"23000000-0000-4000-8000-000000000002",zammad_ticket_id:"43",zammad_ticket_number:"10383",state:"OPEN",generation:2}],rowCount:1};
    if(sql.includes("replaced_by_correlation_id")){calls.push("linked-generation");return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO message_links"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"event-1",tenantId,connectionId:"connection-1",provider:"waha",providerEventId:"provider-1",eventType:"message",payload:{},attempts:1};
  const context={bindingId:"binding-1"};
  const message={provider:"waha",connectionId:"connection-1",eventId:"provider-1",messageId:"message-1",groupId:"fixture-0019@example.test",participantId:"p",text:"ABC1234567",fromApi:false,fromMe:false,timestamp:new Date().toISOString()};
  const reopened=await repository.correlate(event,context,message,"ABC1234567",{create:async()=>{throw new Error("must not create")},reopen:async()=>{calls.push("reopened");return"2026-08-09T12:01:00.123456Z"},append:async()=>{calls.push("appended")}});
  assert.deepEqual(reopened,{id:"42",number:"10382"});assert.deepEqual(calls.slice(0,3),["reopened","appended","updated-open"]);
  phase="open";calls.length=0;
  const repeated=await repository.correlate(event,context,{...message,messageId:"message-2"},"ABC1234567",{create:async()=>assert.fail("a repeated reference must reuse the same case"),reopen:async()=>assert.fail("an open case must not reopen"),append:async()=>calls.push("appended")});
  assert.deepEqual(repeated,{id:"42",number:"10382"});assert.deepEqual(calls,["appended","updated-open"]);
  phase="detached";let key="";
  const generated=await repository.correlate(event,context,{...message,messageId:"message-3"},"ABC1234567",{create:async value=>{key=value;return{id:"43",number:"10383"}},reopen:async()=>{},append:async()=>{}});
  assert.match(key,/:generation:2$/);assert.deepEqual(generated,{id:"43",number:"10383"});assert.ok(calls.includes("linked-generation"));
});

test("a successor generation rolls back if its detached predecessor cannot be linked",async()=>{
  const calls=[];
  const client={query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    calls.push(sql);
    if(sql.includes("pg_advisory_xact_lock")&&sql.includes("FROM zammad_instances"))return{rows:[{}],rowCount:1};
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("set_config")||sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:0};
    if(sql.includes("state<>'DETACHED'")&&sql.includes("FROM case_correlations"))return{rows:[],rowCount:0};
    if(sql.includes("ORDER BY generation DESC")&&sql.includes("FOR UPDATE"))return{rows:[{id:correlationId,generation:1}],rowCount:1};
    if(sql.includes("INSERT INTO case_correlations"))return{rows:[{id:"23000000-0000-4000-8000-000000000002",zammad_ticket_id:"43",zammad_ticket_number:"10383",state:"OPEN",generation:2}],rowCount:1};
    if(sql.includes("replaced_by_correlation_id"))return{rows:[],rowCount:0};
    throw new Error(`Unexpected query: ${sql}`);
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"event-1",tenantId,connectionId:"connection-1",provider:"waha",providerEventId:"provider-1",eventType:"message",payload:{},attempts:1};
  const context={bindingId:"binding-1"};
  const message={provider:"waha",connectionId:"connection-1",eventId:"provider-1",messageId:"message-2",groupId:"fixture-0019@example.test",participantId:"p",text:"ABC1234567",fromApi:false,fromMe:false,timestamp:new Date().toISOString()};
  await assert.rejects(
    ()=>repository.correlate(event,context,message,"ABC1234567",{create:async()=>({id:"43",number:"10383"}),reopen:async()=>{},append:async()=>{}}),
    /predecessor could not be linked/,
  );
  assert.ok(calls.includes("ROLLBACK"));
  assert.equal(calls.includes("COMMIT"),false);
  assert.equal(calls.some(sql=>sql.includes("INSERT INTO message_links")),false);
});

test("Zammad create payload applies priority, ownership, SLA-compatible fields, business hours, and provider origin",async()=>{
  const originalFetch=globalThis.fetch;let payload;let redirect;
  globalThis.fetch=async(_url,init)=>{payload=JSON.parse(String(init?.body));redirect=init?.redirect;return new Response(JSON.stringify({id:42,number:"10382",state:"open",group:"Ops",title:"Case"}),{status:201});};
  try{
    const client=new ZammadClient({baseUrl:"https://zammad.example",token:"test"});
    await client.createTicket({title:"ABC1234567 · group",group:"2",customerId:77,body:"Message",reference:"ABC1234567",priority:"3 high",ownerId:19,articlePreferences:{wasalx_origin:"provider",wasalx_external_message_id:"message-1"},metadata:{wasalx_assignment_mode:"fixed_owner",wasalx_default_priority:"high",wasalx_sla_policy_id:"4",wasalx_business_hours_mode:"ZAMMAD_CALENDAR",wasalx_business_hours_calendar_id:"5"}});
  }finally{globalThis.fetch=originalFetch}
  assert.equal(redirect,"error");assert.equal(payload.group_id,2);assert.equal(payload.group,undefined);assert.equal(payload.priority,"3 high");assert.equal(payload.owner_id,19);assert.equal(payload.wasalx_sla_policy_id,"4");assert.equal(payload.wasalx_business_hours_calendar_id,"5");assert.equal(payload.article.origin_by_id,77);assert.deepEqual(payload.article.preferences,{wasalx_origin:"provider",wasalx_external_message_id:"message-1"});
});

test("Zammad agent-originated ticket articles retain the acting service author",async()=>{
  const originalFetch=globalThis.fetch;let payload;
  globalThis.fetch=async(_url,init)=>{payload=JSON.parse(String(init?.body));return Response.json({id:42,number:"10382",state:"open",group:"Ops",title:"Case"},{status:201})};
  try{
    const client=new ZammadClient({baseUrl:"https://zammad.example",token:"test"});
    await client.createTicket({title:"Agent message",group:"2",customerId:77,body:"Update",reference:"ABC1234567",priority:"2 normal",articleSender:"Agent",articlePreferences:{wasalx_origin:"provider",wasalx_external_message_id:"message-2"},metadata:{}});
  }finally{globalThis.fetch=originalFetch}
  assert.equal(payload.article.sender,"Agent");assert.equal(payload.article.origin_by_id,undefined);
});

test("Zammad customer mobile is validated, fills only an empty identity, and never overwrites an existing number",async()=>{
  const originalFetch=globalThis.fetch;const calls=[];let existingMobile;let existingName="WhatsApp participant";
  globalThis.fetch=async(url,init)=>{const parsed=new URL(String(url));const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path:parsed.pathname,method:init?.method??"GET",body});
    if(parsed.pathname==="/api/v1/users/search")return Response.json([{id:77,login:"wasalx-customer",firstname:existingName,lastname:"",mobile:existingMobile}]);
    if(parsed.pathname==="/api/v1/users/77"&&(!init?.method||init.method==="GET"))return Response.json({id:77,login:"wasalx-customer",firstname:existingName,lastname:"",mobile:existingMobile});
    if(parsed.pathname==="/api/v1/users/77"&&init?.method==="PUT"){existingMobile=body.mobile??existingMobile;existingName=body.firstname??existingName;return Response.json({id:77,login:"wasalx-customer",firstname:existingName,lastname:"",mobile:existingMobile})}
    throw new Error(`Unexpected request ${parsed.pathname}`)};
  try{
    const client=new ZammadClient({baseUrl:"https://zammad.example",token:"test"});
    const updated=await client.ensureCustomer({login:"wasalx-customer",firstname:"Verified Customer",mobile:"+12025550102"});
    assert.equal(updated.mobile,"+12025550102");assert.equal(updated.firstname,"Verified Customer");assert.deepEqual(calls.find(call=>call.method==="PUT")?.body,{mobile:"+12025550102",firstname:"Verified Customer",lastname:"",preferences:{wasalx_identity:{login:"wasalx-customer",lastAppliedName:"Verified Customer"}}});
    existingMobile="+12025550129";existingName="Existing Customer";calls.length=0;
    const preserved=await client.ensureCustomer({login:"wasalx-customer",firstname:"Different Customer",mobile:"+12025550102"});
    assert.equal(preserved.mobile,"+12025550129");assert.equal(calls.some(call=>call.method==="PUT"),false);
    await assert.rejects(()=>client.ensureCustomer({login:"wasalx-customer",firstname:"Customer",mobile:"+not-a-number"}),/Invalid customer mobile/u);
  }finally{globalThis.fetch=originalFetch}
});

test("native close resolves direct HUMAN ownership independently and preserves blocked or newer work",async()=>{
  for(const scenario of ["close","blocked","native-pending","newer","stale"]){
    const queries=[];
    const client={query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
      queries.push({sql,values});
      if(sql.includes("FROM zammad_instances"))return{rows:[{id:instanceId}],rowCount:1};
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
      if(sql.includes("INSERT INTO zammad_ticket_state_events"))return{rows:[{id:"event-direct",request_sha256:values[3]}],rowCount:1};
      if(sql.includes("AS stale"))return{rows:[{stale:scenario==="stale"}],rowCount:1};
      if(sql.includes("UPDATE case_correlations"))return{rows:[],rowCount:0};
      if(sql.includes("SELECT 'reply' AS kind,id FROM direct_native_reply_intents")){
        assert.deepEqual(values,[tenantId,'conversation-direct',null,null]);
        return{rows:scenario==='native-pending'?[{kind:'reply',id:'pending-native'}]:[],rowCount:scenario==='native-pending'?1:0};
      }
      if(sql.includes("FROM bot_conversations"))return{rows:[{id:"conversation-direct",current_node_id:"handoff",eligible:scenario!=="newer"}],rowCount:1};
      if(sql.includes("SELECT 'delivery'"))return{rows:scenario==="blocked"?[{kind:"delivery",id:"unknown-delivery"}]:[],rowCount:scenario==="blocked"?1:0};
      if(sql.includes("AS exists"))return{rows:[{exists:false}],rowCount:1};
      if(sql.includes("UPDATE zammad_ticket_state_events"))return{rows:[{id:"event-direct",processing_state:values[0],correlations_updated:values[1]}],rowCount:1};
      if(sql.includes("UPDATE bot_conversations")||sql.includes("INSERT INTO bot_conversation_events")||sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
      throw new Error(sql);
    }};
    const controller=new ZammadTicketStateController({rows:async()=>[{id:instanceId}],withTenant:async(_id,callback)=>callback(client)},serviceAuth());
    const body=transitionBody();
    const result=await controller.ticketState(`Bearer ${await serviceToken()}`,body.idempotency_key,"native-close",body);
    assert.equal(result.state,scenario==="close"?"APPLIED":["blocked","native-pending"].includes(scenario)?"BLOCKED_EFFECTS":"IGNORED_STALE");
    assert.equal(result.correlations_updated,0);
    assert.equal(queries.some(q=>q.sql.includes("UPDATE bot_conversations")),scenario==="close");
    assert.equal(queries.some(q=>/UPDATE (delivery_outbox|bot_action_jobs|bot_handoff_jobs)/.test(q.sql)),false);
    const audit=queries.find(q=>q.sql.includes("INSERT INTO audit_events"));
    assert.equal(audit.values[4].blocked_effects.length,["blocked","native-pending"].includes(scenario)?1:0);
  }
});

test("identical blocked native closes recheck settlement once while preserving stale and idempotency fences",async()=>{
  for(const scenario of ["settled","unknown","newer-activity","reopened"]){
    let stored, effectPending=true, correlated=false, resolved=false, retry=false;
    let resolutionEvents=0, ticketLocks=0;
    const client={query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
      if(sql.includes("pg_advisory_xact_lock")){ticketLocks++;return{rows:[],rowCount:1}}
      if(sql.includes("FROM zammad_instances"))return{rows:[{id:instanceId}],rowCount:1};
      if(sql.includes("INSERT INTO zammad_ticket_state_events")){
        if(stored)return{rows:[],rowCount:0};
        stored={id:"pending-close",request_sha256:values[3],processing_state:"ACCEPTED",correlations_updated:0};
        return{rows:[{...stored}],rowCount:1};
      }
      if(sql.includes("SELECT id,request_sha256"))return{rows:[{...stored}],rowCount:1};
      if(sql.includes("AS stale"))return{rows:[{stale:retry&&scenario==="reopened"}],rowCount:1};
      if(sql.includes("UPDATE case_correlations")){
        const count=correlated?0:1;correlated=true;return{rows:count?[{id:correlationId}]:[],rowCount:count};
      }
      if(sql.includes("SELECT 'reply' AS kind,id FROM direct_native_reply_intents")){
        assert.deepEqual(values,[tenantId,'direct',null,null]);return{rows:[],rowCount:0};
      }
      if(sql.includes("FROM bot_conversations"))return{rows:resolved?[]:[{id:"direct",current_node_id:"handoff",eligible:!(retry&&scenario==="newer-activity")}],rowCount:resolved?0:1};
      if(sql.includes("SELECT 'delivery'"))return{rows:effectPending?[{kind:"delivery",id:"saved-agent-reply"}]:[],rowCount:effectPending?1:0};
      if(sql.includes("UPDATE bot_conversations")){resolved=true;return{rows:[],rowCount:1}}
      if(sql.includes("INSERT INTO bot_conversation_events")){resolutionEvents++;return{rows:[],rowCount:1}}
      if(sql.includes("AS exists"))return{rows:[{exists:true}],rowCount:1};
      if(sql.includes("UPDATE zammad_ticket_state_events")){
        stored={...stored,processing_state:values[0],correlations_updated:values[1]};return{rows:[{...stored}],rowCount:1};
      }
      if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
      throw new Error(`Unexpected query: ${sql}`);
    }};
    const controller=new ZammadTicketStateController({rows:async()=>[{id:instanceId}],withTenant:async(_id,callback)=>callback(client)},serviceAuth());
    const body=transitionBody();
    const invoke=(input=body)=>controller.ticketState(undefined,input.idempotency_key,"native-close-retry",input);
    controller.auth={verify:async()=>({tenantId,instanceId})};
    const first=await invoke();
    assert.equal(first.state,"BLOCKED_EFFECTS");assert.equal(first.correlations_updated,1);
    await assert.rejects(()=>invoke({...body,state_name:"resolved"}),namedError("ConflictException"));
    retry=true;effectPending=scenario==="unknown";
    const second=await invoke();
    assert.equal(second.state,scenario==="settled"?"APPLIED":scenario==="unknown"?"BLOCKED_EFFECTS":"IGNORED_STALE");
    assert.equal(second.id,first.id);assert.equal(second.duplicate,true);assert.equal(second.correlations_updated,1);
    const third=await invoke();
    assert.deepEqual(third,second);
    assert.equal(resolutionEvents,scenario==="settled"?1:0);
    assert.equal(ticketLocks,4);
  }
});

test("Zammad correlation recovery accepts exactly one exact ticket and fails closed on ambiguity",async()=>{
  const originalFetch=globalThis.fetch;let payload=[];
  globalThis.fetch=async()=>Response.json(payload);
  try{
    const client=new ZammadClient({baseUrl:"https://zammad.example",token:"test"});
    assert.equal(await client.findByCorrelationKey("key-1"),null);
    payload=[{id:41,number:"1041",state:"open",group:"Ops",title:"Fuzzy",wasalx_correlation_key:"key-x"},{id:42,number:"1042",state:"open",group:"Ops",title:"Exact",wasalx_correlation_key:"key-1"}];
    assert.equal((await client.findByCorrelationKey("key-1"))?.id,42);
    payload=[payload[1],{...payload[1]}];
    assert.equal((await client.findByCorrelationKey("key-1"))?.id,42);
    payload=[payload[0],{id:43,number:"1043",state:"open",group:"Ops",title:"Second",wasalx_correlation_key:"key-1"}];
    await assert.rejects(()=>client.findByCorrelationKey("key-1"),error=>error instanceof ZammadError&&!error.retryable&&error.message==="Zammad ticket correlation is ambiguous");
    payload=[{id:44,number:"1044",state:"open",group:"Ops",title:"Fuzzy",wasalx_correlation_key:"key-other"}];
    await assert.rejects(()=>client.findByCorrelationKey("key-1"),/correlation is ambiguous/u);
  }finally{globalThis.fetch=originalFetch}
});

test("Zammad duplicate-customer recovery tolerates a temporarily stale search index",async()=>{
  const originalFetch=globalThis.fetch;const calls=[];let searches=0;
  globalThis.fetch=async(url,init)=>{const parsed=new URL(String(url));calls.push(`${init?.method??"GET"} ${parsed.pathname}${parsed.search}`);
    if(parsed.pathname==="/api/v1/users/search"){searches+=1;return Response.json([])}
    if(parsed.pathname==="/api/v1/users"&&init?.method==="POST")return Response.json({error:"duplicate"},{status:422});
    if(parsed.pathname==="/api/v1/users"&&parsed.searchParams.get("page")==="1")return Response.json([{id:77,login:"WasalX-Customer",firstname:"Customer",lastname:"",mobile:"+12025550102"}]);
    if(parsed.pathname==="/api/v1/users/77")return Response.json({id:77,login:"WasalX-Customer",firstname:"Customer",lastname:"",mobile:"+12025550102"});
    throw new Error(`Unexpected request ${parsed.pathname}${parsed.search}`)};
  try{
    const recovered=await new ZammadClient({baseUrl:"https://zammad.example",token:"test"}).ensureCustomer({login:"wasalx-customer",firstname:"Customer",mobile:"+12025550102"});
    assert.equal(recovered.id,77);assert.equal(searches,2);assert.ok(calls.includes("GET /api/v1/users?page=1&per_page=100"));
  }finally{globalThis.fetch=originalFetch}
});

test("Zammad ticket titles are friendly, Unicode-safe, bounded, and preserve the reference",()=>{
  assert.equal(formatZammadTicketTitle({kind:"group",groupName:"فريق الرياض",ruleName:"رقم الشحنة",reference:"١٢٣٤٥٦٧٨٩٠"}),"فريق الرياض — رقم الشحنة: ١٢٣٤٥٦٧٨٩٠");
  assert.equal(formatZammadTicketTitle({kind:"direct",customerName:"\u202e Ahmed\nAl-Salem "}),"Ahmed Al-Salem — WhatsApp conversation");
  assert.equal(formatZammadTicketTitle({kind:"group"}),"WhatsApp group — Reference: Unknown reference");
  const long=formatZammadTicketTitle({kind:"group",groupName:"👩‍💻".repeat(100),ruleName:"شحنة".repeat(100),reference:"REF-1234567890"});
  assert.ok([...long].length<=200);assert.ok(long.endsWith(": REF-1234567890"));assert.doesNotMatch(long,/\ud83d(?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});

test("Zammad routing targets expose only writable groups and their eligible agents",async()=>{
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{const path=new URL(String(url)).pathname;const payload=path==="/api/v1/users/me"?{id:7,group_ids:{"2":["full"],"3":["read"]}}:path==="/api/v1/groups"?[{id:2,active:true,user_ids:[19,20]},{id:3,active:true,user_ids:[21]}]:[{id:7,active:true},{id:19,active:true,group_ids:{"2":["full"]}},{id:20,active:false,group_ids:{"2":["read","change","create"]}},{id:21,active:true,group_ids:{"3":["full"]}}];return new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}})};
  try{
    const targets=await new ZammadClient({baseUrl:"https://zammad.example",token:"test"}).routingTargets();
    assert.deepEqual(targets.groups,[{id:"2",active:true,serviceIdentityCanCreate:true},{id:"3",active:true,serviceIdentityCanCreate:false}]);
    assert.deepEqual(targets.owners,[{id:"19",active:true,groupIds:["2"]}]);
  }finally{globalThis.fetch=originalFetch}
});

test("0022 schema enforces one active generation and forced tenant RLS",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0022_case_lifecycle_routing.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE UNIQUE INDEX case_correlations_one_active_generation[\s\S]*WHERE state<>'DETACHED'/);
  assert.match(sql,/CREATE UNIQUE INDEX case_correlations_generation_unique/);
  assert.match(sql,/CREATE TABLE zammad_ticket_state_events/);
  assert.match(sql,/CREATE TABLE case_detach_operations/);
  for(const table of ["zammad_ticket_state_events","case_detach_operations"]){
    assert.match(sql,new RegExp(`'${table}'`));
  }
  assert.match(sql,/ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/business_hours_mode/);
});

test("portal BFF and premium case UI expose complete loading, error, empty, and recovery states",async()=>{
  const [component,style,listRoute,detachRoute,openRoute,data,fixture,modal,messages,migration]=await Promise.all([
    readFile(new URL("../app/CaseLifecycle.tsx",import.meta.url),"utf8"),
    readFile(new URL("../app/CaseLifecycle.module.css",import.meta.url),"utf8"),
    readFile(new URL("../app/api/cases/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/cases/[id]/detach/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/api/cases/[id]/open/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/control-plane-data.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/fixture-data.ts",import.meta.url),"utf8"),
    readFile(new URL("../app/ModalDialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../lib/i18n/messages/en/cases.ts",import.meta.url),"utf8"),
    readFile(new URL("../services/control-api/migrations/0117_zammad_agent_origin.sql",import.meta.url),"utf8"),
  ]);
  assert.match(listRoute,/case:read/);assert.match(detachRoute,/case:detach/);assert.match(detachRoute,/Idempotency-Key is required/);assert.match(data,/\/v1\/cases/);
  assert.match(listRoute,/ticket/);assert.match(openRoute,/case:read/);assert.match(openRoute,/requirePermission\(principal, "ticket:read"\)/);assert.match(openRoute,/agentTicketDestination\(request.url, ticket_number\)/);assert.doesNotMatch(component,/agent_base_url|https?:\/\//u);
  assert.match(component,/openTicket\(row.zammad_ticket_number\)/);assert.doesNotMatch(component,/target="_blank"/);assert.match(component,/cases\.action\.open/);
  assert.match(component,/previousTargetTicket\.current === normalizedTargetTicket/);assert.match(component,/setQuery\(normalizedTargetTicket\)/);
  assert.match(migration,/ADD COLUMN agent_base_url/);assert.match(migration,/127\[\.\]0\[\.\]0\[\.\]1/);
  assert.match(migration,/verified_zammad_agent_base_url[\s\S]*operation\.status='COMPLETE'[\s\S]*\{zammad,zammad_base_url\}' = service_base_url_value[\s\S]*\{health,zammad_base_url\}' = service_base_url_value[\s\S]*\{health,isolation_verified\}' = 'true'/u);
  assert.match(migration,/WHERE instance\.agent_base_url IS NULL[\s\S]*verified\.agent_base_url IS NOT NULL/u);
  assert.match(migration,/TG_OP='INSERT' AND NEW\.agent_base_url IS NOT NULL[\s\S]*RETURN NEW/u);
  assert.match(migration,/NEW\.agent_base_url IS DISTINCT FROM OLD\.agent_base_url[\s\S]*OLD\.agent_base_url IS DISTINCT FROM OLD\.base_url/u);
  assert.match(migration,/NEW\.agent_base_url := verified_base_url/u);
  assert.match(migration,/BEFORE INSERT OR UPDATE OF base_url ON zammad_instances/u);
  assert.doesNotMatch(migration,/SET agent_base_url\s*=\s*(?:instance\.)?base_url|NEW\.agent_base_url\s*:=\s*NEW\.base_url/u);
  for(const key of ["cases.loading","cases.unavailable","cases.empty.title","cases.dialog.title","cases.dialog.reauthenticate","cases.tryAgain"])assert.match(component,new RegExp(key.replaceAll(".","\\.")));
  for(const contract of ["Loading case links","Case links unavailable","No support cases are linked yet","Prepare the next case","Reauthenticate","Try again"])assert.match(messages,new RegExp(contract));
  assert.match(component,/ModalDialog/);assert.match(component,/data-modal-initial-focus/);
  assert.match(component,/role="status"[\s\S]{0,120}cases\.loading/u);
  assert.match(component,/visible\.length \? <WideTable>[\s\S]*<\/table><\/WideTable>/u);
  assert.match(style,/\.table \{[\s\S]{0,80}min-width: 980px/u);
  assert.match(component,/mutationError\.code === "REAUTHENTICATION_REQUIRED"/u);
  assert.match(component,/return_to=%2Fapp%3Fview%3Dcases/u);
  assert.doesNotMatch(component,/reauthenticate\|authentication\|sign in again|إعادة المصادقة\|المصادقة/u);
  for(const keyboardContract of ["aria-modal=\"true\"","showModal","closedby","restoreFocus"] )assert.match(modal,new RegExp(keyboardContract.replace(/[?.]/g,"\\$&")));
  for(const fixtureContract of ["caseDetachOperations","idempotencyKey","duplicate:true","predecessor_correlation_id","replaced_by_correlation_id"])assert.match(fixture,new RegExp(fixtureContract));
  assert.match(style,/var\(--border\)/);assert.doesNotMatch(style,/#(?:[0-9a-f]{3}){1,2}\b/i);
});

test("PostgreSQL provisioning proves verified agent origin initialization and override preservation",async()=>{
  const integration=await readFile(new URL("../scripts/test-postgres-integration.mjs",import.meta.url),"utf8");
  assert.match(integration,/operator_create_tenant[\s\S]*complete_tenant_provisioning_step[\s\S]*agent_base_url:provisionedAgentBaseUrl/u);
  assert.match(integration,/SET agent_base_url=\$2[\s\S]*completed_steps=completed_steps-'health'[\s\S]*agent_base_url:explicitAgentBaseUrl/u);
});

function namedError(name){
  return error=>Boolean(error&&typeof error==="object"&&error.constructor?.name===name);
}


test("quoted targets are group scoped and conflicting references fail before effects",async()=>{
  let rows=[{zammad_ticket_id:"42",normalized_reference:"REF123456789012"}],selected,known=false,ambiguous=false,eligible=true;
  const canonical='stored-message-1';
  const client={query:async(sql,values=[])=>{
    if(sql.includes('WITH quote_identities'))return{rows:[{external_message_id:ambiguous?null:canonical,ambiguous}],rowCount:1};
    if(sql.startsWith('SELECT link.external_message_id'))return{rows:eligible?[{external_message_id:canonical}]:[],rowCount:eligible?1:0};
    const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    if(sql.includes("FROM message_links link")){selected={sql,values};return{rows,rowCount:rows.length};}
    if(sql.includes("AS known"))return{rows:[{known}],rowCount:1};
    return{rows:[],rowCount:0};
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={tenantId,connectionId:"connection-1"},context={bindingId:"binding-1",groupId:"fixture-0019@example.test"};
  assert.deepEqual(await repository.ticketsForQuotedMessage(event,"message-1",context,["REF123456789012"]),["42"]);
  assert.deepEqual(selected.values,[tenantId,"connection-1",canonical,"binding-1","fixture-0019@example.test"]);
  assert.match(selected.sql,/group_record\.connection_id=\$2 AND group_record\.external_group_id=\$5/);
  assert.match(selected.sql,/correlation\.state IN \('OPEN','RESOLVED'\)/);
  await assert.rejects(()=>repository.ticketsForQuotedMessage(event,"message-1",context,["REF999999999999"]),{code:"QUOTE_REFERENCE_CONFLICT"});
  ambiguous=true;await assert.rejects(()=>repository.ticketsForQuotedMessage(event,"message-1",context),{code:"QUOTE_TARGET_AMBIGUOUS"});ambiguous=false;
  eligible=false;await assert.rejects(()=>repository.ticketsForQuotedMessage(event,"message-1",context),{code:"QUOTE_TARGET_UNAVAILABLE"});eligible=true;
  rows.push({zammad_ticket_id:"43",normalized_reference:"REF123456789012"});
  await assert.rejects(()=>repository.ticketsForQuotedMessage(event,"message-1",context),{code:"QUOTE_TARGET_AMBIGUOUS"});
  rows=[];
  assert.deepEqual(await repository.ticketsForQuotedMessage(event,"message-1",context),[]);
  known=true;
  await assert.rejects(()=>repository.ticketsForQuotedMessage(event,"message-1",context),{code:"QUOTE_TARGET_UNAVAILABLE"});
});

test("quoted follow-ups reuse reopen and duplicate fencing in native callback lock order",async()=>{
  const calls=[];let linked=false,detached=false;
  const correlation={id:correlationId,zammad_ticket_id:"42",zammad_ticket_number:"10382",state:"RESOLVED",generation:1};
  const client={query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    if(sql.startsWith("SELECT normalized_reference FROM case_correlations"))
      return{rows:detached?[]:[{normalized_reference:"REF123456789012"}],rowCount:detached?0:1};
    if(sql.includes("pg_advisory_xact_lock")&&sql.includes("FROM zammad_instances")){
      calls.push("command-lock");assert.deepEqual(values,[tenantId,"42",null]);
      return{rows:[{}],rowCount:1};
    }
    if(sql.includes("pg_advisory_xact_lock")){calls.push("reference-lock");return{rows:[],rowCount:0};}
    if(sql.includes("FROM case_correlations")&&sql.includes("state<>'DETACHED'")){
      if(sql.includes("FOR UPDATE"))calls.push("row-lock");
      return{rows:detached?[]:[correlation],rowCount:detached?0:1};
    }
    if(sql.startsWith("SELECT 1 FROM message_links"))return{rows:linked?[{}]:[],rowCount:linked?1:0};
    if(sql.includes("UPDATE case_correlations")){
      calls.push("updated-open");assert.equal(values[0],"follow-up");return{rows:[],rowCount:1};
    }
    if(sql.includes("INSERT INTO message_links")){linked=true;return{rows:[],rowCount:1};}
    if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("set_config"))return{rows:[],rowCount:0};
    throw new Error("Unexpected query: "+sql);
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"inbox-follow-up",tenantId,connectionId:"connection-1",provider:"waha",providerEventId:"evt-follow-up",eventType:"message",attempts:1,payload:{}};
  const context={bindingId:"binding-1",groupId:"fixture-0019@example.test"};
  const message={provider:"waha",connectionId:"connection-1",messageId:"follow-up",groupId:"fixture-0019@example.test",participantId:"p",text:"update",fromApi:false,timestamp:"2026-10-05T00:00:00Z"};
  const actions={reopen:async()=>{calls.push("reopened");return"2026-10-05T00:00:01Z"},append:async()=>{calls.push("appended");return"501"}};
  assert.deepEqual(await repository.linkQuotedMessage(event,message,"42",context,actions),{id:"42",number:"10382"});
  assert.deepEqual(calls,["reference-lock","command-lock","row-lock","reopened","appended","updated-open"]);
  calls.length=0;
  await repository.linkQuotedMessage(event,message,"42",context,actions);
  assert.deepEqual(calls,["reference-lock","command-lock","row-lock"]);
  detached=true;
  await assert.rejects(()=>repository.linkQuotedMessage(event,{...message,messageId:"later"},"42",context,actions),{code:"QUOTE_TARGET_UNAVAILABLE"});
});

test("a detach or successor race cannot redirect the selected quoted ticket",async()=>{
  const client={query:async(sql,values=[])=>{const eventFixture=legacyTicketEventFixture(sql,values);if(eventFixture)return eventFixture;
    if(sql.includes("pg_advisory_xact_lock")&&sql.includes("FROM zammad_instances"))return{rows:[{}],rowCount:1};
    if(sql.includes("FROM case_correlations")&&sql.includes("state<>'DETACHED'"))
      return{rows:[{id:correlationId,zammad_ticket_id:"43",zammad_ticket_number:"10383",state:"OPEN",generation:2}],rowCount:1};
    return{rows:[],rowCount:0};
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  await assert.rejects(()=>repository.correlate(
    {tenantId,connectionId:"connection-1"},{bindingId:"binding-1"},{messageId:"follow-up"},"REF123456789012",
    {create:async()=>assert.fail("must not create"),append:async()=>assert.fail("must not append"),reopen:async()=>assert.fail("must not reopen")},"42",
  ),{code:"QUOTE_TARGET_UNAVAILABLE"});
});


// Existing lifecycle fixtures use the unconfigured (legacy) event policy.
function legacyTicketEventFixture(sql,values=[]){
  if(sql.includes("SELECT execution.id FROM ticket_event_executions execution")){assert.equal(values.length,3);assert.equal(values[0],tenantId);assert.match(values[1],/^[1-9][0-9]*$/u);assert.equal(values[2],null);return{rows:[],rowCount:0};}
  if(sql.includes('SELECT binding.whatsapp_group_id'))return{rows:[{whatsapp_group_id:'group-1',original_external_message_id:'original'}],rowCount:1};
  if(sql.startsWith('SELECT mode,flow_version_id')||sql.startsWith('SELECT id,tenant_id,correlation_id'))return{rows:[],rowCount:0};
  if(sql.includes('INSERT INTO ticket_event_executions'))return{rows:[{id:'legacy-execution',tenant_id:values[0],correlation_id:values[1],event:values[2],mode:'LEGACY',flow_version_id:null,state:'PENDING'}],rowCount:1};
  if(sql.startsWith('UPDATE ticket_event_executions'))return{rows:[],rowCount:1};
  if(sql.includes('SELECT correlation.id,correlation.group_binding_id')||sql.includes('execution.id AS execution_id'))return{rows:[],rowCount:0};
  return null;
}
