import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { METHOD_METADATA, MODULE_METADATA } from "../services/control-api/node_modules/@nestjs/common/constants.js";
import { MetadataScanner, Reflector } from "../services/control-api/node_modules/@nestjs/core/index.js";
import { signServiceJwt } from "../services/connector-worker/dist/packages/core/src/service-auth.js";
import { AppModule } from "../services/control-api/dist/app.module.js";
import { PUBLIC_ROUTE } from "../services/control-api/dist/auth.guard.js";
import { HealthController } from "../services/control-api/dist/health.controller.js";
import { PermissionGuard, Requires } from "../services/control-api/dist/permission.guard.js";
import { tenantPermissions } from "../services/control-api/dist/rbac.js";
import { ServiceAuthService } from "../services/control-api/dist/service-auth.service.js";
import { SessionController } from "../services/control-api/dist/session.controller.js";
import { WahaAuthorizationController } from "../services/control-api/dist/waha-authorization.controller.js";
import { WebhookIngressController } from "../services/control-api/dist/webhook-ingress.controller.js";
import { WebhookSecretResolutionError, WebhookSecretService } from "../services/control-api/dist/webhook-secret.service.js";
import { verifyProviderHmac } from "../services/control-api/dist/webhook-security.js";
import { ZammadInternalController } from "../services/control-api/dist/zammad-internal.controller.js";

function permissionContext(controller, handler, principal) {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  };
}

test("the permission guard denies a route without authorization metadata", () => {
  const guard = new PermissionGuard(new Reflector());
  const context = permissionContext(class UnmarkedController {}, () => {}, { role: "tenant_owner" });
  assert.throws(() => guard.canActivate(context), error =>
    error instanceof ForbiddenException && error.getStatus() === 403);
});

test("the permission guard allows explicit public metadata on a handler or controller", () => {
  const guard = new PermissionGuard(new Reflector());
  assert.equal(guard.canActivate(permissionContext(HealthController, HealthController.prototype.live)), true);
  assert.equal(guard.canActivate(permissionContext(SessionController, SessionController.prototype.session)), true);
});

test("the permission guard enforces a controller's required permission", () => {
  const guard = new PermissionGuard(new Reflector());
  const { qr } = WahaAuthorizationController.prototype;
  assert.equal(guard.canActivate(permissionContext(WahaAuthorizationController, qr, { role: "tenant_owner" })), true);
  assert.throws(() => guard.canActivate(permissionContext(WahaAuthorizationController, qr, { role: "agent" })), ForbiddenException);
  assert.throws(() => guard.canActivate(permissionContext(WahaAuthorizationController, qr)), ForbiddenException);
});

test("every registered control API route declares a tenant permission or explicitly skips tenant auth", () => {
  const reflector = new Reflector();
  const scanner = new MetadataScanner();
  const controllers = reflector.get(MODULE_METADATA.CONTROLLERS, AppModule);
  const permissionKey = Requires("connection:read").KEY;
  assert.ok(controllers?.length, "AppModule must register controllers");
  const invalid = [];
  let routeCount = 0;

  for (const controller of controllers) {
    for (const method of scanner.getAllMethodNames(controller.prototype)) {
      const handler = controller.prototype[method];
      if (reflector.get(METHOD_METADATA, handler) === undefined) continue;
      routeCount++;
      const targets = [handler, controller];
      const permission = reflector.getAllAndOverride(permissionKey, targets);
      const skipTenantAuth = reflector.getAllAndOverride(PUBLIC_ROUTE, targets) === true;
      const valid = skipTenantAuth ? permission === undefined : tenantPermissions.includes(permission);
      if (!valid) invalid.push(`${controller.name}.${method}`);
    }
  }

  assert.ok(routeCount, "Expected to discover HTTP handlers");
  assert.deepEqual(invalid, [], "Expected one valid authorization policy per route");
});

const secret="zammad-service-test-secret-at-least-32-bytes";
const tenantId="10000000-0000-4000-8000-000000000001";
const instanceId="11000000-0000-4000-8000-000000000001";
const secretReference=`secret://tenants/${tenantId}/zammad/service`;
async function token(scope){const now=Math.floor(Date.now()/1000);return signServiceJwt({iss:"wasalx-zammad",aud:"wasalx-control",sub:instanceId,tenant_id:tenantId,instance_id:instanceId,scope,iat:now,exp:now+120,jti:crypto.randomUUID(),zammad_user_id:"2",zammad_group_ids:["4"],zammad_group_admin:false},secret)}
function serviceAuth(){return new ServiceAuthService({rows:async(id,sql,values)=>{assert.equal(id,tenantId);if(sql.includes("FROM native_membership_projections")){assert.deepEqual(values,[tenantId,instanceId,"2"]);return[]}assert.match(sql,/service_secret_reference/);return values[1]===instanceId?[{id:instanceId,tenant_id:tenantId,service_secret_reference:secretReference}]:[]}},{resolveSigningSecret:async(reference,owner)=>{assert.equal(reference,secretReference);assert.deepEqual(owner,{tenantId,instanceId});return secret}})}

// These three native reply fixtures have no accepted delivery or case workflow.
function replyPrerequisite(sql,values,{ticketId,idempotencyKey,groupId,trace}){
  if(sql.includes("pg_advisory_xact_lock")&&sql.includes("FROM zammad_instances")){
    assert.deepEqual(values,[tenantId,ticketId,null]);trace.push("native-lock");return{rows:[],rowCount:1};
  }
  if(sql.includes("FROM delivery_outbox delivery LEFT JOIN delivery_media")){
    assert.deepEqual(values,[tenantId,idempotencyKey]);trace.push("accepted-delivery");return{rows:[],rowCount:0};
  }
  if(sql.includes("SELECT execution.id FROM ticket_event_executions execution")){
    assert.deepEqual(values,[tenantId,ticketId,null]);trace.push("command-clear");return{rows:[],rowCount:0};
  }
  if(sql==="SELECT pg_advisory_xact_lock(hashtextextended($1,0))"){
    assert.deepEqual(values,[`ticket-outbound:${tenantId}:${ticketId}`]);trace.push("reply-lock");return{rows:[],rowCount:1};
  }
  if(sql.startsWith("SELECT reply_to_message_id FROM delivery_outbox")){
    assert.deepEqual(values,[tenantId,idempotencyKey]);trace.push("accepted-quote");return{rows:[],rowCount:0};
  }
  if(sql.includes("SELECT link.external_message_id")){
    assert.deepEqual(values,[tenantId,"12000000-0000-4000-8000-000000000001",ticketId,groupId,null,null,false]);trace.push("quote-target");return{rows:[],rowCount:0};
  }
  return null;
}

test("production Zammad API authenticates the registered instance, inserts an outbox row, and wakes its tenant",async()=>{
  const calls=[];
  const prerequisiteTrace=[];
  const client={query:async(sql,values=[])=>{
    const prerequisite=replyPrerequisite(sql,values,{ticketId:"42",idempotencyKey:"zammad:42:9",groupId:"fixture-0009@example.test",trace:prerequisiteTrace});if(prerequisite)return prerequisite;
    if(sql.includes("FROM case_correlations correlation")){assert.deepEqual(values,[tenantId,"13000000-0000-4000-8000-000000000001","42","12000000-0000-4000-8000-000000000001","fixture-0009@example.test"]);prerequisiteTrace.push("active-case");return{rows:[],rowCount:0};}
    if(sql.startsWith("SELECT id FROM case_correlations")){assert.deepEqual(values,[tenantId,"13000000-0000-4000-8000-000000000001","42"]);prerequisiteTrace.push("historical-case");return{rows:[],rowCount:0};}
    if(sql.includes("SELECT c.id AS connection_id"))return{rows:[{connection_id:"12000000-0000-4000-8000-000000000001",binding_id:"13000000-0000-4000-8000-000000000001",group_workspace_group_id:null,bot_conversation_id:null,external_chat_id:null,provider:"WAHA",agent_prefix:"Agent:",agent_identity_placement:"HEADER",media_enabled:true}]};
    if(sql.includes("INSERT INTO delivery_outbox")){calls.push("insert");return{rows:[{id:"delivery-1",state:"QUEUED"}]}}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql)=>{if(sql.includes("FROM zammad_instances"))return[{id:"11000000-0000-4000-8000-000000000001"}];throw new Error(`Unexpected SQL ${sql}`)},withTenant:async(_tenant,operation)=>operation(client)};
  const drain={wake:async tenant=>calls.push(`wake:${tenant}`)};
  const controller=new ZammadInternalController(database,serviceAuth(),drain);
  const result=await controller.outbound(`Bearer ${await token("zammad:outbound")}`,{tenant_id:"10000000-0000-4000-8000-000000000001",connection_id:"12000000-0000-4000-8000-000000000001",group_id:"fixture-0009@example.test",ticket_id:42,article_id:9,body:"Resolved",content_type:"text/plain",idempotency_key:"zammad:42:9",internal:false,agent:{id:2,display_name:"Support"}});
  assert.deepEqual(result,{id:"delivery-1",state:"QUEUED"});
  assert.deepEqual(calls,["insert","wake:10000000-0000-4000-8000-000000000001"]);
  assert.deepEqual(prerequisiteTrace,["native-lock","accepted-delivery","native-lock","command-clear","reply-lock","accepted-quote","quote-target","active-case","historical-case"]);
});

test("Zammad agents reply to a human-owned private WhatsApp conversation",async()=>{
  const conversationId="44000000-0000-4000-8000-000000000001";
  const chatId="12025550116@c.us";
  const calls=[];
  const prerequisiteTrace=[];
  const client={query:async(sql,values=[])=>{
    const prerequisite=replyPrerequisite(sql,values,{ticketId:"77",idempotencyKey:"zammad:77:10",groupId:"12025550116@c.us",trace:prerequisiteTrace});if(prerequisite)return prerequisite;
    if(sql.includes("JOIN whatsapp_groups"))return{rows:[]};
    if(sql.includes("FROM bot_conversations conversation"))return{rows:[{connection_id:"12000000-0000-4000-8000-000000000001",binding_id:null,group_workspace_group_id:null,bot_conversation_id:conversationId,external_chat_id:chatId,provider:"WAHA",agent_prefix:"Agent:",agent_identity_placement:"HEADER",media_enabled:true}]};
    if(sql.includes("INSERT INTO delivery_outbox")){
      assert.equal(values[2],null);
      assert.equal(values[3],null);
      assert.equal(values[4],conversationId);
      assert.equal(values[5],chatId);
      calls.push("insert");
      return{rows:[{id:"delivery-direct",state:"QUEUED"}]};
    }
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql)=>sql.includes("FROM zammad_instances")?[{id:instanceId}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async tenant=>calls.push(`wake:${tenant}`)});
  const result=await controller.outbound(`Bearer ${await token("zammad:outbound")}`,{tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",group_id:chatId,ticket_id:77,article_id:10,body:"A human reply",content_type:"text/plain",idempotency_key:"zammad:77:10",internal:false,agent:{id:2,display_name:"Support"}});
  assert.deepEqual(result,{id:"delivery-direct",state:"QUEUED"});
  assert.deepEqual(calls,["insert",`wake:${tenantId}`]);
  assert.deepEqual(prerequisiteTrace,["native-lock","accepted-delivery","native-lock","command-clear"]);
});

test("Zammad ticket replies can use an authorized captured group without an automation binding",async()=>{
  const groupId="13000000-0000-4000-8000-000000000001";const calls=[];let workspaceSql;
  const prerequisiteTrace=[];
  const client={query:async(sql,values=[])=>{
    const prerequisite=replyPrerequisite(sql,values,{ticketId:"42",idempotencyKey:"zammad:42:9",groupId:"fixture-0020@example.test",trace:prerequisiteTrace});if(prerequisite)return prerequisite;
    if(sql.includes("JOIN group_bindings"))return{rows:[]};
    if(sql.includes("JOIN group_workspace_settings workspace")){workspaceSql=sql;return{rows:[{connection_id:"12000000-0000-4000-8000-000000000001",binding_id:null,group_workspace_group_id:groupId,bot_conversation_id:null,external_chat_id:null,provider:"WAHA",agent_prefix:"Agent:",agent_identity_placement:"HEADER",media_enabled:true}]};}
    if(sql.includes("INSERT INTO delivery_outbox")){assert.equal(values[2],null);assert.equal(values[3],groupId);assert.equal(values[6],"42");assert.equal(values[7],"9");calls.push("insert");return{rows:[{id:"delivery-workspace",state:"QUEUED"}]};}
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  const database={rows:async(_tenant,sql)=>sql.includes("FROM zammad_instances")?[{id:instanceId}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async tenant=>calls.push(`wake:${tenant}`)});
  const result=await controller.outbound(`Bearer ${await token("zammad:outbound")}`,{tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",group_id:"fixture-0020@example.test",ticket_id:42,article_id:9,body:"Update",content_type:"text/plain",idempotency_key:"zammad:42:9",internal:false,agent:{id:2,display_name:"Support"}});
  assert.deepEqual(result,{id:"delivery-workspace",state:"QUEUED"});assert.deepEqual(calls,["insert",`wake:${tenantId}`]);
  assert.match(workspaceSql,/FOR SHARE OF c,g,workspace/);assert.doesNotMatch(workspaceSql,/FOR SHARE OF [^`]*tenant/);
  assert.deepEqual(prerequisiteTrace,["native-lock","accepted-delivery","native-lock","command-clear","reply-lock","accepted-quote","quote-target"]);
});

test("production Zammad API refuses internal notes before queueing",async()=>{const database={rows:async()=>[{id:instanceId}]};const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{throw new Error("must not wake")}});const authorization=`Bearer ${await token("zammad:outbound")}`;await assert.rejects(()=>controller.outbound(authorization,{tenant_id:tenantId,connection_id:"c",group_id:"g",ticket_id:42,article_id:9,body:"Private",idempotency_key:"zammad:42:9",internal:true}),BadRequestException)});

test("WAHA ingress verifies the official SHA-512 raw-body signature and durably wakes one tenant",async()=>{const body={id:"evt_1",timestamp:Date.now(),event:"message",session:"session-1",engine:"GOWS",metadata:{connectionId:"12000000-0000-4000-8000-000000000001"},payload:{id:"m1",from:"fixture-0019@example.test",body:"1234567890"}};const raw=JSON.stringify(body);const hmacSecret="webhook-test-secret-at-least-16";const timestamp=String(body.timestamp);const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(hmacSecret),{name:"HMAC",hash:"SHA-512"},false,["sign"]);const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");const route={tenant_id:"10000000-0000-4000-8000-000000000001",connection_id:"12000000-0000-4000-8000-000000000001",provider:"WAHA",hmac_secret_reference:"secret://webhook"};const calls=[];const database={resolveWahaWebhookRoute:async()=>route,acceptWebhookEvent:async()=>{calls.push("accepted");return{id:"event-row",duplicate:false}}};const controller=new WebhookIngressController(database,{resolveHmac:async()=>hmacSecret},{wakeInbound:async tenant=>calls.push(`wake:${tenant}`)});const result=await controller.waha("a".repeat(48),{rawBody:new TextEncoder().encode(raw),headers:{"x-webhook-hmac":signature,"x-webhook-hmac-algorithm":"sha512","x-webhook-timestamp":timestamp,"x-webhook-request-id":"request-1"}},body);assert.deepEqual(result,{accepted:true,duplicate:false,event_id:"event-row"});assert.deepEqual(calls,["accepted","wake:10000000-0000-4000-8000-000000000001"])});

test("pinned WAHA GOWS webhook omission falls back only to database-verified GOWS",async()=>{
  const body={id:"evt_gows_omission",timestamp:Date.now(),event:"message",session:"session-1",metadata:{connectionId:"12000000-0000-4000-8000-000000000001"},payload:{id:"m1"}};
  const raw=JSON.stringify(body);const secret="webhook-test-secret-at-least-16";const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-512"},false,["sign"]);const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");
  let acceptedInput;const route={tenant_id:tenantId,connection_id:body.metadata.connectionId,provider:"WAHA",hmac_secret_reference:"secret://webhook"};
  const controller=new WebhookIngressController({resolveWahaWebhookRoute:async()=>route,acceptWebhookEvent:async(_route,input)=>{acceptedInput=input;return{id:"event-row",duplicate:false}}},{resolveHmac:async()=>secret},{wakeInbound:async()=>{}});
  await controller.waha("a".repeat(48),{rawBody:new TextEncoder().encode(raw),headers:{"x-webhook-hmac":signature,"x-webhook-hmac-algorithm":"sha512","x-webhook-timestamp":String(body.timestamp)}},body);
  assert.equal(acceptedInput.providerEngine,"GOWS");
});

test("signed WAHA ingress rejects missing or mismatched session ownership without persistence or wake",async()=>{
  const hmacSecret="webhook-test-secret-at-least-16";
  const route={tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",provider:"WAHA",hmac_secret_reference:"secret://webhook"};
  let persisted=0;let wakes=0;
  const database={
    resolveWahaWebhookRoute:async()=>route,
    acceptWebhookEvent:async(_route,input)=>{
      if(input.providerSessionKey!=="session-1"||input.providerEngine!=="GOWS")throw new BadRequestException("Webhook event ownership is invalid");
      persisted+=1;return{id:"event-row",duplicate:false};
    },
  };
  const controller=new WebhookIngressController(database,{resolveHmac:async()=>hmacSecret},{wakeInbound:async()=>{wakes+=1}});
  const valid={id:"evt_owner",timestamp:Date.now(),event:"message",session:"session-1",engine:"GOWS",metadata:{connectionId:route.connection_id},payload:{id:"m1"}};
  for(const body of [
    {...valid,session:undefined},
    {...valid,session:"wrong-session"},
    {...valid,engine:null},
    {...valid,engine:{}},
    {...valid,engine:""},
    {...valid,engine:"NOWEB"},
    {...valid,metadata:undefined},
    {...valid,metadata:{connectionId:"12000000-0000-4000-8000-000000000099"}},
    {...valid,event:"presence.update"},
  ]){
    const raw=JSON.stringify(body);
    const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(hmacSecret),{name:"HMAC",hash:"SHA-512"},false,["sign"]);
    const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");
    await assert.rejects(()=>controller.waha("a".repeat(48),{rawBody:new TextEncoder().encode(raw),headers:{
      "x-webhook-hmac":signature,"x-webhook-hmac-algorithm":"sha512","x-webhook-timestamp":String(body.timestamp),
    }},body),BadRequestException);
  }
  assert.equal(persisted,0);assert.equal(wakes,0);
});

test("WAHA ingress deduplicates the signed event when unsigned transport headers change",async()=>{
  const body={id:"evt_replay",timestamp:Date.now(),event:"message",session:"session-1",engine:"GOWS",metadata:{connectionId:"12000000-0000-4000-8000-000000000001"},payload:{id:"message-replay"}};
  const raw=JSON.stringify(body);
  const hmacSecret="webhook-test-secret-at-least-16";
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(hmacSecret),{name:"HMAC",hash:"SHA-512"},false,["sign"]);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");
  const route={tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",provider:"WAHA",hmac_secret_reference:"secret://webhook"};
  const eventIds=[];
  const wakes=[];
  const database={resolveWahaWebhookRoute:async()=>route,acceptWebhookEvent:async(_route,input)=>{eventIds.push(input.providerEventId);return{id:"event-row",duplicate:eventIds.length>1}}};
  const controller=new WebhookIngressController(database,{resolveHmac:async()=>hmacSecret},{wakeInbound:async tenant=>wakes.push(tenant)});
  const request=(requestId,timestamp)=>({rawBody:new TextEncoder().encode(raw),headers:{"x-webhook-hmac":signature,"x-webhook-hmac-algorithm":"sha512","x-webhook-timestamp":timestamp,"x-webhook-request-id":requestId}});
  assert.equal((await controller.waha("a".repeat(48),request("transport-one",String(body.timestamp)),body)).duplicate,false);
  assert.equal((await controller.waha("a".repeat(48),request("transport-two",String(body.timestamp)),body)).duplicate,true);
  assert.deepEqual(eventIds,["evt_replay","evt_replay"]);
  assert.deepEqual(wakes,[tenantId]);
});

test("webhook HMAC rejects stale millisecond timestamps and wrong algorithms",async()=>{const result=await verifyProviderHmac({rawBody:"{}",secret:"test-secret",provided:"0".repeat(128),algorithm:"sha512",timestamp:"1",now:1_000_000,requireTimestamp:true,maxAgeSeconds:1});assert.deepEqual(result,{valid:false,reason:"stale"});const controller=new WebhookIngressController({resolveWahaWebhookRoute:async()=>({tenant_id:"t",connection_id:"c",provider:"WAHA",hmac_secret_reference:"secret://x"})},{resolveHmac:async()=>"webhook-test-secret-at-least-16"},{wakeInbound:async()=>{}});await assert.rejects(()=>controller.waha("a".repeat(48),{rawBody:new TextEncoder().encode("{}"),headers:{"x-webhook-hmac-algorithm":"sha256"}},{}),UnauthorizedException)});

test("WAHA ingress binds freshness to the signed body timestamp before persistence or wake",async()=>{
  const hmacSecret="webhook-test-secret-at-least-16";
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(hmacSecret),{name:"HMAC",hash:"SHA-512"},false,["sign"]);
  const route={tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",provider:"WAHA",hmac_secret_reference:"secret://webhook"};
  let persisted=0;let wakes=0;
  const database={resolveWahaWebhookRoute:async()=>route,acceptWebhookEvent:async()=>{persisted++;return{id:"event-row",duplicate:false}}};
  const controller=new WebhookIngressController(database,{resolveHmac:async()=>hmacSecret},{wakeInbound:async()=>{wakes++}});
  const attempt=async(bodyTimestamp,headerTimestamp)=>{
    const body={id:"evt_freshness",timestamp:bodyTimestamp,event:"message",payload:{id:"message-freshness"}};
    const raw=JSON.stringify(body);
    const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");
    const request={rawBody:new TextEncoder().encode(raw),headers:{"x-webhook-hmac":signature,"x-webhook-hmac-algorithm":"sha512",...(headerTimestamp===undefined?{}:{"x-webhook-timestamp":headerTimestamp})}};
    await assert.rejects(()=>controller.waha("a".repeat(48),request,body),UnauthorizedException);
  };
  const now=Date.now();
  for(const [bodyTimestamp,headerTimestamp] of [
    [now,undefined],
    [now-301_000,String(now-301_000)],
    [now+301_000,String(now+301_000)],
    [now-301_000,String(now)],
  ]){
    await attempt(bodyTimestamp,headerTimestamp);
  }
  assert.equal(persisted,0);
  assert.equal(wakes,0);
});

test("webhook secret resolution is bounded, redirect-safe, and exposes retryability without leaking values",async()=>{
  const saved={url:process.env.SECRET_SIDECAR_URL,token:process.env.SECRET_SIDECAR_TOKEN,node:process.env.NODE_ENV};const previousFetch=globalThis.fetch;
  process.env.NODE_ENV="test";process.env.SECRET_SIDECAR_URL="http://secrets.internal";process.env.SECRET_SIDECAR_TOKEN="read-only-sidecar-token";
  const resolver=new WebhookSecretService();let request;const reference=`secret://tenants/${tenantId}/routing/test`;const owner={kind:"routing",tenantId};
  try{
    globalThis.fetch=async(_input,init)=>{request=init;return new Response(JSON.stringify({accessToken:"notion-access-token-value",refreshToken:"notion-refresh-token-value",hmacKey:"routing-hmac-secret-value"}),{headers:{"content-type":"application/json"}})};
    assert.equal(await resolver.resolveHmac(reference,owner),"routing-hmac-secret-value");assert.equal(request.redirect,"error");
    let fetched=false;globalThis.fetch=async()=>{fetched=true;return new Response()};await assert.rejects(()=>resolver.resolveHmac(reference,{kind:"routing",tenantId:"20000000-0000-4000-8000-000000000002"}),error=>error instanceof WebhookSecretResolutionError&&!error.retryable);assert.equal(fetched,false);
    for(const status of [408,425,429,500]){globalThis.fetch=async()=>new Response(null,{status});await assert.rejects(()=>resolver.resolveHmac(reference,owner),error=>error instanceof WebhookSecretResolutionError&&error.retryable)}
    globalThis.fetch=async()=>new Response(null,{status:400});await assert.rejects(()=>resolver.resolveHmac(reference,owner),error=>error instanceof WebhookSecretResolutionError&&!error.retryable);
    for(const body of [JSON.stringify(["not-a-record"]),JSON.stringify({hmacKey:{nested:"invalid"}}),JSON.stringify({hmacKey:"a".repeat(16),value:"b".repeat(16)}),"x".repeat(16_385)]){
      globalThis.fetch=async()=>new Response(body,{headers:{"content-type":"application/json"}});await assert.rejects(()=>resolver.resolveHmac(reference,owner),error=>error instanceof WebhookSecretResolutionError&&!error.retryable);
    }
  }finally{
    resolver.onModuleDestroy();globalThis.fetch=previousFetch;
    if(saved.url===undefined)delete process.env.SECRET_SIDECAR_URL;else process.env.SECRET_SIDECAR_URL=saved.url;
    if(saved.token===undefined)delete process.env.SECRET_SIDECAR_TOKEN;else process.env.SECRET_SIDECAR_TOKEN=saved.token;
    if(saved.node===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=saved.node;
  }
});

test("routing webhook verifies signed raw JSON and only wakes a replay-fenced full pull",async()=>{const hmacSecret="routing-webhook-test-secret";const body={id:"evt-routing-1",timestamp:new Date().toISOString()};const raw=JSON.stringify(body);const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(hmacSecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");const calls=[];const route={tenant_id:tenantId,source_state_id:"53000000-0000-4000-8000-000000000001",source_id:"notion",kind:"NOTION",secret_reference:`secret://tenants/${tenantId}/routing/notion`};const controller=new WebhookIngressController({resolveClientRoutingWebhookRoute:async()=>route,enqueueClientRoutingWebhook:async()=>{calls.push("enqueue");return{job_id:"job-1",duplicate:false}}},{resolveHmac:async()=>hmacSecret},{wakeRouting:async tenant=>calls.push(`wake:${tenant}`)},{externalConnectorsEnabled:true});const result=await controller.routing("a".repeat(43),{rawBody:new TextEncoder().encode(raw),headers:{"content-type":"application/json","x-notion-signature":`sha256=${signature}`}},body);assert.deepEqual(result,{accepted:true,duplicate:false,event_id:"job-1"});assert.deepEqual(calls,["enqueue",`wake:${tenantId}`])});

test("Notion webhook verification stores the provider token beside the existing OAuth credential",async()=>{
  const route={tenant_id:tenantId,source_state_id:"53000000-0000-4000-8000-000000000001",source_id:"notion",kind:"NOTION",secret_reference:`secret://tenants/${tenantId}/routing/notion`};
  const stored=[];
  const controller=new WebhookIngressController(
    {resolveClientRoutingWebhookRoute:async()=>route,enqueueClientRoutingWebhook:async()=>assert.fail("verification must not enqueue")},
    {resolveHmac:async()=>"placeholder-hmac-secret",resolveRoutingCredential:async()=>({hmacKey:"placeholder-hmac-secret",accessToken:"oauth-access",refreshToken:"oauth-refresh"})},
    {wakeRouting:async()=>assert.fail("verification must not wake")},
    {externalConnectorsEnabled:true},
    {storeRoutingCredential:async(reference,value)=>stored.push([reference,value])},
  );
  const body={verification_token:"notion-verification-token"};
  assert.deepEqual(await controller.routing("a".repeat(43),{rawBody:new TextEncoder().encode(JSON.stringify(body)),headers:{"content-type":"application/json"}},body),{accepted:true,verification:true});
  assert.deepEqual(stored,[[route.secret_reference,{hmacKey:"notion-verification-token",accessToken:"oauth-access",refreshToken:"oauth-refresh"}]]);
});

test("custom routing ingress deduplicates the signed body when unsigned headers change",async()=>{
  const body={changed:["customer-routing"]};
  const raw=JSON.stringify(body);
  const hmacSecret="routing-webhook-test-secret";
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(hmacSecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw))),byte=>byte.toString(16).padStart(2,"0")).join("");
  const route={tenant_id:tenantId,source_state_id:"53000000-0000-4000-8000-000000000001",source_id:"custom",kind:"CUSTOM",secret_reference:`secret://tenants/${tenantId}/routing/custom`};
  const dedupeKeys=[];
  const wakes=[];
  const controller=new WebhookIngressController({resolveClientRoutingWebhookRoute:async()=>route,enqueueClientRoutingWebhook:async(_route,keyValue)=>{dedupeKeys.push(keyValue);return{job_id:"job-1",duplicate:dedupeKeys.length>1}}},{resolveHmac:async()=>hmacSecret},{wakeRouting:async tenant=>wakes.push(tenant)},{externalConnectorsEnabled:true});
  const request=(eventId,timestamp)=>({rawBody:new TextEncoder().encode(raw),headers:{"content-type":"application/json","x-wasalx-signature":`sha256=${signature}`,"x-wasalx-event-id":eventId,"x-wasalx-timestamp":timestamp}});
  assert.equal((await controller.routing("a".repeat(43),request("transport-one","1"),body)).duplicate,false);
  assert.equal((await controller.routing("a".repeat(43),request("transport-two",String(Date.now())),body)).duplicate,true);
  assert.equal(dedupeKeys[0],dedupeKeys[1]);
  assert.deepEqual(wakes,[tenantId]);
});

test("routing webhook rejects stale Zoho callbacks before enqueueing",async()=>{const route={tenant_id:tenantId,source_state_id:"53000000-0000-4000-8000-000000000001",source_id:"zoho",kind:"ZOHO",secret_reference:`secret://tenants/${tenantId}/routing/zoho`};const controller=new WebhookIngressController({resolveClientRoutingWebhookRoute:async()=>route,enqueueClientRoutingWebhook:async()=>assert.fail("must not enqueue")},{resolveHmac:async()=>"zoho-verification-token"},{wakeRouting:async()=>assert.fail("must not wake")},{externalConnectorsEnabled:true});const body={server_time:1,token:"zoho-verification-token"};await assert.rejects(()=>controller.routing("a".repeat(43),{rawBody:new TextEncoder().encode(JSON.stringify(body)),headers:{"content-type":"application/json"}},body),UnauthorizedException)});

test("routing webhook is hidden before lookup when external connectors are disabled",async()=>{const controller=new WebhookIngressController({resolveClientRoutingWebhookRoute:async()=>assert.fail("route lookup must not run")},{resolveHmac:async()=>assert.fail("secrets must not be resolved")},{wakeRouting:async()=>assert.fail("must not wake")});await assert.rejects(()=>controller.routing("a".repeat(43),{headers:{"content-type":"application/json"}},{}),NotFoundException)});
