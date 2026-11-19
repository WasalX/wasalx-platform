import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { connect } from "node:net";
import { ConflictException, Controller, Get, Module, RequestMethod, ValidationPipe } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { NestFactory } from "../services/control-api/node_modules/@nestjs/core/index.js";
import { FastifyAdapter } from "../services/control-api/node_modules/@nestjs/platform-fastify/index.js";
import { WebhookIngressController } from "../services/control-api/dist/webhook-ingress.controller.js";
import { DatabaseService } from "../services/control-api/dist/database.service.js";
import { WebhookSecretService } from "../services/control-api/dist/webhook-secret.service.js";
import { TenantDrainService } from "../services/control-api/dist/tenant-drain.service.js";
import { RoutingConnectorsConfig } from "../services/control-api/dist/routing-connectors.config.js";
import { SecretProvisioningService } from "../services/control-api/dist/secret-provisioning.service.js";
import { META_WEBHOOK_MAX_BYTES } from "../services/control-api/dist/webhook-security.js";
import { metaDirectIdentityChangeEvidence, metaDirectTransitionEvidence } from "../packages/core/dist/meta-direct-identity.js";

test("Meta verification rejects repeated query values and only echoes a decimal challenge as plain text", async (t) => {
  const previous = process.env.META_VERIFY_TOKEN;
  const token = "synthetic-verification-token";
  process.env.META_VERIFY_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.META_VERIFY_TOKEN;
    else process.env.META_VERIFY_TOKEN = previous;
  });
  class TestModule {}
  Module({
    controllers: [WebhookIngressController],
    providers: [DatabaseService, WebhookSecretService, TenantDrainService, RoutingConnectorsConfig, SecretProvisioningService]
      .map(provide => ({ provide, useValue: {} })),
  })(TestModule);
  const app = await NestFactory.create(TestModule, new FastifyAdapter(), { logger: false });
  t.after(() => app.close());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const fields = { "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "00123" };
  const verify = query => app.inject({ method: "GET", url: "/webhooks/meta?" + query });
  const response = await verify(new URLSearchParams(fields));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, fields["hub.challenge"]);
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  for (const [key, value] of Object.entries(fields)) {
    const query = new URLSearchParams(fields);
    query.append(key, value);
    assert.equal((await verify(query)).statusCode, 400, key);
  }
  assert.equal((await verify(new URLSearchParams({ ...fields, "hub.verify_token": "wrong-token" }))).statusCode, 401);
  assert.equal((await verify(new URLSearchParams({ ...fields, "hub.challenge": "<b>verification</b>" }))).statusCode, 400);
});

test("signed Meta status corrections use canonical isolated payloads without changing routing or conflict fences",async(t)=>{
  const previous={secret:process.env.META_APP_SECRET_REFERENCE,app:process.env.META_APP_ID};
  process.env.META_APP_SECRET_REFERENCE="secret://test/meta/app";process.env.META_APP_ID="123456789";
  t.after(()=>{for(const [key,value] of [["META_APP_SECRET_REFERENCE",previous.secret],["META_APP_ID",previous.app]]){if(value===undefined)delete process.env[key];else process.env[key]=value}});
  const secret="synthetic-price-secret",durable=new Map(),lookups=[],events=[];
  const route={tenant_id:"tenant-a",connection_id:"connection-a",provider:"META"};
  class TestModule{}
  Module({controllers:[WebhookIngressController],providers:[
    {provide:DatabaseService,useValue:{resolveMetaWebhookRoute:async phone=>{lookups.push(phone);return phone==="12345"?route:null},acceptWebhookEvent:async(actual,input)=>{
      assert.equal(actual,route);const old=durable.get(input.providerEventId);
      if(old&&input.payloadSha256!==old.payloadSha256)throw new ConflictException("Webhook event ID conflicts with an earlier payload");
      if(!old)durable.set(input.providerEventId,input);events.push(input);return{id:"synthetic",duplicate:Boolean(old)};
    }}},
    {provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
    {provide:TenantDrainService,useValue:{wakeInbound:async()=>{}}},
    {provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}},
  ]})(TestModule);
  const app=await NestFactory.create(TestModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  t.after(()=>app.close());await app.init();await app.getHttpAdapter().getInstance().ready();
  const timestamp=String(Math.floor(Date.now()/1000));
  const status={id:"wamid.pricing",status:"delivered",timestamp,recipient_user_id:"SA.synthetic",pricing:{billable:false,pricing_model:"PMP",category:"service",type:"free_customer_service"}};
  const body=item=>({object:"whatsapp_business_account",entry:[{id:"987654",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:"12345"},statuses:[item]}}]}]});
  const inject=async(value,bad=false)=>{const payload=JSON.stringify(value);return app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":"sha256="+(bad?"0".repeat(64):createHmac("sha256",secret).update(payload).digest("hex"))},payload})};
  assert.equal((await inject(body(status))).json().count,1);
  assert.equal((await inject(body(status))).json().duplicates,1);
  const reordered=Object.fromEntries(Object.entries(status).reverse());reordered.pricing=Object.fromEntries(Object.entries(status.pricing).reverse());
  assert.equal((await inject(body(reordered))).json().duplicates,1);
  const correction={...status,pricing:{...status.pricing,billable:true,type:"regular"}};
  assert.equal((await inject(body(correction))).json().count,1);assert.equal(durable.size,2);
  for(const changed of [{recipient_user_id:"SA.other"},{errors:[{code:131000}]}])assert.equal((await inject(body({...correction,...changed}))).statusCode,409,'Nonpricing changes retain the existing payload-conflict fence');
  assert.equal(durable.size,2);
  const foreignEnvelope=body(correction);foreignEnvelope.entry[0].id="999999";
  assert.equal((await inject(foreignEnvelope)).json().count,1,"Envelope account is an observation, not a route or payer assertion");
  assert.equal(events.at(-1).payload.entry[0].id,"999999");assert(lookups.every(phone=>phone==="12345"));
  const foreignPhone=body(correction);foreignPhone.entry[0].changes[0].value.metadata.phone_number_id="77777";
  const foreignResponse=(await inject(foreignPhone)).json();assert.equal(foreignResponse.count,0);assert.equal(foreignResponse.unrouted,1);
  for(const pricing of [null,[],{...status.pricing,billable:"true"},{...status.pricing,category:"unknown"}])assert.equal((await inject(body({...status,pricing}))).json().count,1);
  const absent={...status};delete absent.pricing;assert.equal((await inject(body(absent))).json().count,1);
  const count=durable.size;assert.equal((await inject(body(correction),true)).statusCode,401);
  assert.equal((await inject(body({...status,timestamp:String(Number(timestamp)-8*86400)}))).statusCode,401);assert.equal(durable.size,count);
});

test("path-scoped Nest middleware protects origin and absolute-form HTTP targets",async(t)=>{
  class PrivateController { get(){return "middleware bypassed"} }
  Controller("private")(PrivateController);
  Get()(PrivateController.prototype,"get",Object.getOwnPropertyDescriptor(PrivateController.prototype,"get"));
  class TestModule { configure(consumer){consumer.apply((_req,res)=>{res.statusCode=403;res.end("blocked")}).forRoutes({path:"private",method:RequestMethod.GET})} }
  Module({controllers:[PrivateController]})(TestModule);
  const app=await NestFactory.create(TestModule,new FastifyAdapter(),{logger:false});
  t.after(()=>app.close());await app.listen(0,"127.0.0.1");
  const port=app.getHttpServer().address().port;
  for(const target of ["/private",`http://127.0.0.1:${port}/private`]){
    const response=await new Promise((resolve,reject)=>{
      const socket=connect(port,"127.0.0.1",()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let bytes="";socket.setEncoding("utf8");socket.setTimeout(5000,()=>socket.destroy(new Error("HTTP regression timed out")));
      socket.on("data",chunk=>{bytes+=chunk});socket.on("error",reject);socket.on("end",()=>resolve(bytes));
    });
    assert.match(response,/^HTTP\/1\.1 403 /u);assert.match(response,/blocked$/u);assert.doesNotMatch(response,/middleware bypassed/u);
  }
});

test("signed Business app chunks use only inert admission; malformed mixed envelopes are atomic", async t => {
  const before = { secret: process.env.META_APP_SECRET_REFERENCE, app: process.env.META_APP_ID };
  Object.assign(process.env, { META_APP_SECRET_REFERENCE: "secret://test/meta", META_APP_ID: "123456789" });
  t.after(() => { for (const [key, value] of [["META_APP_SECRET_REFERENCE", before.secret], ["META_APP_ID", before.app]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const accepted = [], secret = "synthetic-coexistence-secret", route = { tenant_id: "test", connection_id: "test", provider: "META" };
  class TestModule {}
  Module({ controllers: [WebhookIngressController], providers: [
    { provide: DatabaseService, useValue: { resolveMetaWebhookRoute: async () => route,
      acceptMetaCoexistenceEvent: async (_route, value) => { accepted.push(value); return { id: "event", duplicate: false }; },
      acceptWebhookEvent: async () => assert.fail("history must never enter live admission") } },
    { provide: WebhookSecretService, useValue: { resolveHmac: async () => secret } },
    { provide: TenantDrainService, useValue: { wakeInbound: async () => {} } },
    { provide: RoutingConnectorsConfig, useValue: {} }, { provide: SecretProvisioningService, useValue: {} },
  ] })(TestModule);
  const app = await NestFactory.create(TestModule, new FastifyAdapter({ bodyLimit: META_WEBHOOK_MAX_BYTES }), { logger: false, rawBody: true });
  t.after(() => app.close()); await app.init(); await app.getHttpAdapter().getInstance().ready();
  const value = { messaging_product: "whatsapp", metadata: { phone_number_id: "88888888", display_phone_number: "+12025550138" },
    history: [{ metadata: { phase: 0, chunk_order: 1, progress: 100 }, threads: [{ id: "12025550163", messages: [
      { id: "wamid.inert", from: "12025550163", timestamp: String(Math.floor(Date.now()/1000)-86400), type: "text", text: { body: "history" } },
    ] }] }] };
  const envelope = { object: "whatsapp_business_account", entry: [{ id: "77777777", changes: [{ field: "history", value }] }] };
  const inject = (body, signed = true) => { const payload = JSON.stringify(body); return app.inject({ method: "POST", url: "/webhooks/meta", payload,
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signed ? createHmac("sha256", secret).update(payload).digest("hex") : "0".repeat(64)}` } }); };
  assert.equal((await inject(envelope)).statusCode, 200); assert.equal(accepted.length, 1); assert.equal(accepted[0].unit.kind, "HISTORY");
  assert.equal((await inject(envelope, false)).statusCode, 401); assert.equal(accepted.length, 1);
  const mixed = structuredClone(envelope); mixed.entry[0].changes.push({ field: "history", value: { ...value, state_sync: [] } });
  assert.equal((await inject(mixed)).statusCode, 400); assert.equal(accepted.length, 1);
  const wrongField = structuredClone(envelope); wrongField.entry[0].changes[0].field = "messages";
  assert.equal((await inject(wrongField)).statusCode, 400); assert.equal(accepted.length, 1);
  const firstHash = accepted[0].sourceSha256;
  const rebatched = structuredClone(envelope), companion = structuredClone(value.history[0]); companion.metadata.chunk_order = 2;
  rebatched.entry[0].changes[0].value.history.push(companion);
  assert.equal((await inject(rebatched)).statusCode, 200); assert.equal(accepted[1].sourceSha256, firstHash);
  const changed = structuredClone(envelope); changed.entry[0].changes[0].value.history[0].threads[0].messages[0].text.body = "Changed same chunk";
  assert.equal((await inject(changed)).statusCode, 200); assert.notEqual(accepted.at(-1).sourceSha256, firstHash);
  for (const [field, shape, item] of [["smb_message_echoes", "message_echoes", { id: "wamid.echo", from: "12025550138", to: "12025550163", timestamp: String(Math.floor(Date.now()/1000)), type: "text", text: { body: "echo" } }],
    ["history", "messages", { id: "wamid.media", from: "12025550163", timestamp: String(Math.floor(Date.now()/1000)), type: "image", image: { id: "99999999" } }]]) {
    const batch = { object: envelope.object, entry: [{ id: "77777777", changes: [{ field, value: { messaging_product: "whatsapp", metadata: value.metadata, [shape]: [item] } }] }] };
    assert.equal((await inject(batch)).statusCode, 200); const original = accepted.at(-1).sourceSha256;
    batch.entry[0].changes[0].value[shape].push({ ...item, id: `${item.id}.companion` });
    const beforeBatch = accepted.length; assert.equal((await inject(batch)).statusCode, 200); assert.equal(accepted[beforeBatch].sourceSha256, original);
  }
});

test("Meta HTTP ingress accepts signed 3 MB notifications with 200 and keeps rejection fences",async(t)=>{
  const previous=process.env.META_APP_SECRET_REFERENCE;
  const previousAppId=process.env.META_APP_ID;
  process.env.META_APP_SECRET_REFERENCE="secret://test/meta/app";
  process.env.META_APP_ID="123456789";
  t.after(()=>{if(previous===undefined)delete process.env.META_APP_SECRET_REFERENCE;else process.env.META_APP_SECRET_REFERENCE=previous;if(previousAppId===undefined)delete process.env.META_APP_ID;else process.env.META_APP_ID=previousAppId});
  const bootstrap=await readFile(new URL("../services/control-api/src/main.ts",import.meta.url),"utf8");
  assert.match(bootstrap,/bodyLimit:\s*META_WEBHOOK_MAX_BYTES/u);
  const secret="contract-test-app-secret";const accepted=new Set();const events=[];let wakes=0;let failAdmission=false;
  const route={tenant_id:"test-tenant",connection_id:"test-connection",provider:"META"};const lifecycleEvents=[];
  const lifecycleRoute={...route,hmac_secret_reference:"secret://test/meta/app",route_state:"ACTIVE",provider_session_id:"10000000-0000-4000-8000-000000000001",session_ownership_state:"ACTIVE",phone_number_id:"55500123456",waba_id:"77700123456",display_phone_number:"+12025550176",app_id:"123456789"};
  class TestModule {}
  Module({controllers:[WebhookIngressController],providers:[
    {provide:DatabaseService,useValue:{resolveWahaWebhookRoute:async()=>({...route,provider:"WAHA"}),resolveMetaWebhookRoute:async()=>route,resolveMetaLifecycleRoutes:async()=>[lifecycleRoute],acceptWebhookEvent:async(_route,event)=>{if(failAdmission)throw new Error("Synthetic durable admission failure");const duplicate=accepted.has(event.providerEventId);accepted.add(event.providerEventId);events.push(event);return{id:"event",duplicate}},acceptMetaLifecycleEvent:async(_route,event)=>{if(failAdmission)throw new Error("Synthetic durable admission failure");const duplicate=accepted.has(event.providerEventId);accepted.add(event.providerEventId);lifecycleEvents.push(event);return{id:"lifecycle-event",duplicate}}}},
    {provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
    {provide:TenantDrainService,useValue:{wakeInbound:async()=>{wakes++}}},
    {provide:RoutingConnectorsConfig,useValue:{}},
    {provide:SecretProvisioningService,useValue:{}},
  ]})(TestModule);
  const app=await NestFactory.create(TestModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  t.after(()=>app.close());await app.init();await app.getHttpAdapter().getInstance().ready();
  const envelope={object:"whatsapp_business_account",entry:[{id:"77700123456",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{display_phone_number:"+12025550136",phone_number_id:"55500123456"},messages:[{id:"test-message",from:"12025550138",timestamp:String(Math.floor(Date.now()/1000)),type:"text",text:{body:"contract probe"}}]}}]}],padding:""};
  const base=JSON.stringify(envelope);const payload=JSON.stringify({...envelope,padding:"x".repeat(META_WEBHOOK_MAX_BYTES-Buffer.byteLength(base))});
  assert.equal(Buffer.byteLength(payload),3_000_000);
  const inject=(body,signature=createHmac("sha256",secret).update(body).digest("hex"))=>app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":`sha256=${signature}`},payload:body});
  for(const malformed of [null,[],"text",42]){
    const malformedPayload=JSON.stringify(malformed);
    assert.equal((await inject(malformedPayload)).statusCode,400,"Non-object Meta envelopes are client errors");
    assert.equal((await app.inject({method:"POST",url:`/webhooks/waha/${"a".repeat(32)}`,headers:{"content-type":"application/json","x-webhook-hmac-algorithm":"sha512"},payload:malformedPayload})).statusCode,400,"Non-object WAHA envelopes are client errors");
  }
  assert.equal(events.length,0);assert.equal(lifecycleEvents.length,0);assert.equal(wakes,0);
  delete process.env.META_APP_ID;
  assert.equal((await inject(payload)).statusCode,503);process.env.META_APP_ID="123456789";
  const first=await inject(payload);assert.equal(first.statusCode,200);assert.equal(first.json().count,1);
  const duplicate=await inject(payload);assert.equal(duplicate.statusCode,200);assert.equal(duplicate.json().duplicates,1);assert.equal(wakes,1);
  const errorBody=JSON.stringify({object:"whatsapp_business_account",entry:[{id:"private-waba-id",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{display_phone_number:"+12025550136",phone_number_id:"55500123456"},errors:[{code:131000,error_subcode:2494010,type:"OAuthException",title:"private title",error_data:{details:"private message"}}]}}]}]});
  const providerError=await inject(errorBody);assert.equal(providerError.statusCode,200);assert.equal(providerError.json().count,1);assert.equal(wakes,2);
  const admittedError=events.find((event)=>event.eventType==="meta.error");assert.ok(admittedError);assert.equal(admittedError.payload.entry[0].changes[0].value.errors[0].code,131000);assert.equal(admittedError.payload.entry[0].changes[0].value.errors[0].error_subcode,2494010);assert.equal(JSON.stringify(admittedError).includes("private title"),false);assert.equal(JSON.stringify(admittedError).includes("private message"),false);assert.equal(JSON.stringify(admittedError).includes("private-waba-id"),false);
  process.env.META_APP_ID="123456789";
  const lifecycleBody=JSON.stringify({object:"whatsapp_business_account",entry:[{id:"77700123456",time:Math.floor(Date.now()/1000),changes:[{field:"account_update",value:{event:"DISABLED_UPDATE",ban_info:{waba_ban_state:"DISABLE"},phone_number:"12025550176"}}]}]});
  const lifecycle=await inject(lifecycleBody);assert.equal(lifecycle.statusCode,200);assert.equal(lifecycle.json().count,1);assert.equal(lifecycleEvents.length,1);
  assert.equal(lifecycleEvents[0].eventType,"meta.account.lifecycle.block");assert.equal(lifecycleEvents[0].payload.admission.kind,"BLOCK");assert.deepEqual(lifecycleEvents[0].payload.admission.reasons,["ACCOUNT_DISABLED"]);assert.equal(lifecycleEvents[0].payload.admission.phoneScope,"EXACT_DISPLAY");assert.equal(lifecycleEvents[0].payload.admission.asset.appId,"123456789");
  const malformed=JSON.stringify({object:"whatsapp_business_account",entry:[{id:"77700123456",time:Math.floor(Date.now()/1000),changes:[{field:"account_update",value:{event:"ACCOUNT_OFFBOARDED"}},{field:"account_update",value:{event:"DISABLED_UPDATE",ban_info:{waba_ban_state:"UNKNOWN"}}}]}]});
  const beforeMalformed=lifecycleEvents.length;assert.equal((await inject(malformed)).statusCode,400);assert.equal(lifecycleEvents.length,beforeMalformed);  assert.equal((await inject(payload,"0".repeat(64))).statusCode,401);
  assert.equal((await inject(JSON.stringify({...envelope,padding:envelope.padding+"x".repeat(META_WEBHOOK_MAX_BYTES)}))).statusCode,413);
  assert.equal((await inject(JSON.stringify({entry:[]}))).statusCode,400);
  failAdmission=true;
  const failed=await inject(base);assert.equal(failed.statusCode,500);assert.notEqual(failed.json().accepted,true);
  assert.equal(wakes,3);
  assert.equal(accepted.size,3);
});

test("Meta signed lifecycle HTTP batches preserve routing, rejection and retry boundaries",async(t)=>{
  const saved={secret:process.env.META_APP_SECRET_REFERENCE,app:process.env.META_APP_ID};
  process.env.META_APP_SECRET_REFERENCE="secret://test/meta/app";process.env.META_APP_ID="123456789";
  t.after(()=>{for(const [key,value] of [["META_APP_SECRET_REFERENCE",saved.secret],["META_APP_ID",saved.app]]){if(value===undefined)delete process.env[key];else process.env[key]=value}});
  const secret="synthetic-lifecycle-secret",appId="123456789",wabaId="77700123456",now=Math.floor(Date.now()/1000);
  const first={tenant_id:"tenant-a",connection_id:"connection-a",provider:"META",hmac_secret_reference:"secret://test/meta/app",route_state:"ACTIVE",provider_session_id:"10000000-0000-4000-8000-000000000001",session_ownership_state:"ACTIVE",phone_number_id:"55500123456",waba_id:wabaId,display_phone_number:"+12025550176",app_id:appId};
  const second={...first,tenant_id:"tenant-b",connection_id:"connection-b",provider_session_id:"10000000-0000-4000-8000-000000000002",phone_number_id:"55500123457",display_phone_number:"+12025550177"};
  let routes=[first,second],failConnection;const calls=[],lookups=[],wakes=[],durable=new Map();
  const accept=async(route,event)=>{if(route.connection_id===failConnection)throw new Error("Synthetic durable admission failure");const key=`${route.connection_id}:${event.providerEventId}`;const duplicate=durable.has(key);if(!duplicate)durable.set(key,event);calls.push({route,event,duplicate});return{id:key,duplicate}};
  class TestModule {}
  Module({controllers:[WebhookIngressController],providers:[
    {provide:DatabaseService,useValue:{resolveMetaWebhookRoute:async()=>first,resolveMetaLifecycleRoutes:async(waba,app)=>{lookups.push({waba,app});return waba===wabaId?routes:[]},acceptWebhookEvent:accept,acceptMetaLifecycleEvent:accept}},
    {provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
    {provide:TenantDrainService,useValue:{wakeInbound:async tenant=>{wakes.push(tenant)}}},
    {provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}},
  ]})(TestModule);
  const app=await NestFactory.create(TestModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  t.after(()=>app.close());await app.init();await app.getHttpAdapter().getInstance().ready();
  const entry=(value,time=now,id=wabaId)=>({id,time,changes:[{field:"account_update",value}]});
  const body=(...entries)=>({object:"whatsapp_business_account",entry:entries});
  const inject=(envelope,badSignature=false)=>{const payload=JSON.stringify(envelope);return app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":`sha256=${badSignature?"0".repeat(64):createHmac("sha256",secret).update(payload).digest("hex")}`},payload})};
  const reset=()=>{calls.length=0;lookups.length=0;wakes.length=0;durable.clear();routes=[first,second];failConnection=undefined};
  await t.test("signature, configuration and whole-batch validation precede durable effects",async()=>{
    const valid=entry({event:"ACCOUNT_OFFBOARDED"});
    assert.equal((await inject(body(valid),true)).statusCode,401);assert.equal(lookups.length,0);
    delete process.env.META_APP_ID;assert.equal((await inject(body(valid))).statusCode,503);process.env.META_APP_ID=appId;
    assert.equal((await inject({...body(valid),object:"other"})).statusCode,400);
    for(const invalid of [entry({event:"DISABLED_UPDATE",ban_info:{waba_ban_state:"UNKNOWN"}}),entry({event:"ACCOUNT_DELETED",phone_number:"bad"},now,"88800123456"),entry({event:"PARTNER_APP_UNINSTALLED",waba_info:{waba_id:wabaId}}),entry({event:"PARTNER_ADDED"}),entry({event:"ACCOUNT_OFFBOARDED"},now+3600)]){
      assert.equal((await inject(body(valid,invalid))).statusCode,400);assert.equal(calls.length,0,"No first-unit write before all units validate");
    }
    assert.equal(wakes.length,0);reset();
  });
  await t.test("account-wide fanout and route-specific dedupe wake each tenant only once",async()=>{
    const envelope=body(entry({event:"ACCOUNT_OFFBOARDED"},now-10*86400));
    const result=await inject(envelope);assert.equal(result.statusCode,200);assert.equal(result.json().count,2);assert.deepEqual(wakes,["tenant-a","tenant-b"]);
    assert.deepEqual(calls.map(x=>x.event.payload.admission.asset.providerSessionId),[first.provider_session_id,second.provider_session_id]);
    assert.ok(calls.every(x=>x.event.eventType==="meta.account.lifecycle.block"&&x.event.payload.admission.phoneScope==="ACCOUNT"));
    const duplicate=await inject(envelope);assert.equal(duplicate.json().duplicates,2);assert.equal(wakes.length,2);reset();
  });
  await t.test("display phone selects verified display, never the Graph identifier",async()=>{
    assert.equal((await inject(body(entry({event:"ACCOUNT_DELETED",phone_number:"12025550176"})))).json().count,1);
    assert.equal(calls[0].route.connection_id,first.connection_id);assert.equal(calls[0].event.payload.admission.phoneScope,"EXACT_DISPLAY");reset();
    assert.equal((await inject(body(entry({event:"ACCOUNT_DELETED",phone_number:first.phone_number_id})))).json().count,2);
    assert.ok(calls.every(x=>x.event.payload.admission.phoneScope==="UNRESOLVED_DISPLAY"&&x.event.eventType==="meta.account.lifecycle.block"));reset();
    routes=[first,{...second,display_phone_number:first.display_phone_number}];
    assert.equal((await inject(body(entry({event:"ACCOUNT_RECONNECTED",phone_number:first.display_phone_number})))).json().count,2);
    assert.ok(calls.every(x=>x.event.payload.admission.kind==="RECOVERY"&&x.event.eventType==="meta.account.lifecycle.observation"));reset();
  });
  await t.test("portfolio-addressed partner events use customer WABA and uninstall applies only to configured app",async()=>{
    for(const [event,partnerApp,eventType] of [["PARTNER_REMOVED",undefined,"block"],["PARTNER_ADDED",undefined,"recovery"],["PARTNER_APP_UNINSTALLED",appId,"block"],["PARTNER_APP_UNINSTALLED","987654321","observation"]]){
      const value={event,waba_info:{waba_id:wabaId,...(partnerApp?{partner_app_id:partnerApp}:{})}};
      assert.equal((await inject(body(entry(value,now,"99900123456")))).json().count,2);
      assert.deepEqual(lookups,[{waba:wabaId,app:appId}]);assert.ok(calls.every(x=>x.event.eventType===`meta.account.lifecycle.${eventType}`));reset();
    }
  });
  await t.test("coexistence removal routes its account and exact display phone with optional disconnect details",async()=>{
    for(const details of [{},{disconnection_info:{reason:"PRIMARY_INACTIVITY",initiated_by:"SYSTEM"}}]){
      const value={event:"PARTNER_REMOVED",phone_number:"12025550176",...details};
      const envelope=body(entry(value));const result=await inject(envelope);
      assert.equal(result.statusCode,200);assert.equal(result.json().count,1);
      assert.deepEqual(lookups,[{waba:wabaId,app:appId}]);assert.equal(calls[0].route.connection_id,first.connection_id);
      assert.equal(calls[0].event.eventType,"meta.account.lifecycle.block");
      assert.equal(calls[0].event.payload.admission.phoneScope,"EXACT_DISPLAY");
      assert.deepEqual(calls[0].event.payload.admission.reasons,["PARTNER_REMOVED"]);
      assert.equal((await inject(envelope)).json().duplicates,1);assert.deepEqual(wakes,[first.tenant_id]);reset();
      assert.equal((await inject(body(entry({...value,waba_info:{waba_id:wabaId}},now,"99900123456")))).json().count,1);
      assert.deepEqual(lookups,[{waba:wabaId,app:appId}]);assert.equal(calls[0].route.connection_id,first.connection_id);reset();
    }
  });
  await t.test("coexistence unresolved phones retain account holds and unknown accounts remain unrouted",async()=>{
    for(const phone of [first.phone_number_id,first.display_phone_number]){
      if(phone===first.display_phone_number)routes=[first,{...second,display_phone_number:phone}];
      assert.equal((await inject(body(entry({event:"PARTNER_REMOVED",phone_number:phone})))).json().count,2);
      assert.ok(calls.every(call=>call.event.eventType==="meta.account.lifecycle.block"&&call.event.payload.admission.phoneScope==="UNRESOLVED_DISPLAY"));reset();
    }
    const result=await inject(body(entry({event:"PARTNER_REMOVED",phone_number:first.display_phone_number},now,"88800123456")));
    assert.equal(result.statusCode,200);assert.equal(result.json().unrouted,1);assert.equal(calls.length,0);reset();
  });
  await t.test("malformed removal variants reject the whole signed batch before admission",async()=>{
    const coexistence={event:"PARTNER_REMOVED",phone_number:first.display_phone_number};
    const invalidValues=[
      ...[null,{},[],"invalid",{waba_id:"bad"}].map(waba_info=>({...coexistence,waba_info})),
      {event:"PARTNER_REMOVED"},{...coexistence,phone_number:"bad"},
      ...["PARTNER_ADDED","PARTNER_APP_INSTALLED","PARTNER_APP_UNINSTALLED","PARTNER_UNKNOWN"].map(event=>({...coexistence,event})),
    ];
    for(const value of invalidValues){
      assert.equal((await inject(body(entry(coexistence),entry(value)))).statusCode,400);
      assert.equal(calls.length,0);assert.equal(wakes.length,0);reset();
    }
  });
  await t.test("ambiguous generations reject without admission and valid unknown account remains unrouted",async()=>{
    routes=[first,{...first,provider_session_id:second.provider_session_id}];
    assert.equal((await inject(body(entry({event:"ACCOUNT_OFFBOARDED"})))).statusCode,400);assert.equal(calls.length,0);reset();
    const result=await inject(body(entry({event:"ACCOUNT_OFFBOARDED"},now,"88800123456")));assert.equal(result.statusCode,200);assert.equal(result.json().unrouted,1);assert.equal(calls.length,0);reset();
  });
  await t.test("mixed messages retain existing units and a partial database failure retries idempotently",async()=>{
    const message={id:wabaId,changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:first.phone_number_id},messages:[{id:"synthetic-message",timestamp:String(now),from:"15550009999",type:"text",text:{body:"Synthetic message"}}]}}]};
    const mixed=body(message,entry({event:"ACCOUNT_OFFBOARDED"}));
    const result=await inject(mixed);assert.equal(result.statusCode,200);assert.equal(result.json().count,3);assert.equal(calls[0].event.eventType,"messages");assert.deepEqual(wakes,["tenant-a","tenant-b"]);reset();
    const envelope=body(entry({event:"ACCOUNT_OFFBOARDED"}));failConnection=second.connection_id;
    const failed=await inject(envelope);assert.equal(failed.statusCode,500);assert.notEqual(failed.json().accepted,true);assert.equal(durable.size,1);
    failConnection=undefined;const retry=await inject(envelope);assert.equal(retry.json().duplicates,1);assert.equal(retry.json().count,1);assert.equal(durable.size,2);
  });
});

test("signed messages HTTP projection preserves account context without rewriting old events",async(t)=>{
  const saved={secret:process.env.META_APP_SECRET_REFERENCE,app:process.env.META_APP_ID};
  process.env.META_APP_SECRET_REFERENCE="secret://test/meta/app";process.env.META_APP_ID="123456789";
  t.after(()=>{for(const [key,value] of [["META_APP_SECRET_REFERENCE",saved.secret],["META_APP_ID",saved.app]]){if(value===undefined)delete process.env[key];else process.env[key]=value}});
  const secret="synthetic-identity-secret",phoneNumberId="55500123456",wabaId="77700123456",now=String(Math.floor(Date.now()/1000));
  const asset={providerSessionId:"10000000-0000-4000-8000-000000000001",phoneNumberId,wabaId};
  const route={tenant_id:"20000000-0000-4000-8000-000000000001",connection_id:"30000000-0000-4000-8000-000000000001",provider:"META",hmac_secret_reference:"secret://test/meta/app"};
  const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex"),stored=new Map(),inserts=[];let wakes=0,pausedRoute=false,pausedProof=true,pausedLookups=0;
  // Real DatabaseService duplicate checks and source-evidence producer. Only
  // SQL transport is simulated here; canonical signed HTTP -> real DatabaseService
  // -> PostgreSQL separately proves ordinary and identity account admission/denial.
  const database=Object.create(DatabaseService.prototype);
  // This SQL-transport fixture owns no PostgreSQL pool.
  database.onModuleDestroy=async()=>{};
  database.resolveMetaWebhookRoute=async key=>!pausedRoute&&key===phoneNumberId?route:undefined;
  database.resolveMetaIdentityWebhookRoute=async key=>{pausedLookups++;return pausedRoute&&key===phoneNumberId?route:undefined;};
  database.withTenant=async(tenant,work)=>{assert.equal(tenant,route.tenant_id);return work({query:async(sql,values=[])=>{
    if(sql.includes("lock_current_active_tenant_for_event_admission"))return{rows:[{active:true}],rowCount:1};
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.startsWith("SELECT id,event_type,payload_sha256 FROM event_inbox")){const found=stored.get(values[3]);return{rows:found?[found]:[],rowCount:found?1:0};}
    if(sql.startsWith("SELECT provider,engine,state FROM connections"))return{rows:[{provider:"META",engine:"CLOUD_API",state:"WORKING"}],rowCount:1};
    if(sql.startsWith("SELECT state FROM webhook_routes")){if(pausedRoute)assert.equal(values[5],true,"Paused route lock requires an identity marker");return{rows:[{state:pausedRoute?"PAUSED":"ACTIVE"}],rowCount:1};}
    if(sql.startsWith("SELECT id,state,opaque_session_id"))return{rows:[{id:asset.providerSessionId,state:"WORKING",opaque_session_id:phoneNumberId,waba_id:wabaId}],rowCount:1};
    if(sql.startsWith("SELECT app.resolve_meta_identity_source_asset")){
      assert.deepEqual([values[0],values[1],values[3]],[route.connection_id,phoneNumberId,process.env.META_APP_ID]);
      if(pausedRoute){assert.equal(values[2],wabaId);return{rows:[{resolution:pausedProof&&values[3]==="123456789"?{asset,attributed:true}:null}],rowCount:1};}
      assert(["88800123456",null].includes(values[2]));return{rows:[{resolution:null}],rowCount:1};
    }
    if(sql.startsWith("INSERT INTO event_inbox")){
      const event={id:`event-${inserts.length}`,providerEventId:values[3],eventType:values[4],payload:values[5],payloadSha256:values[6],asset:values[7],change:values[8],transition:values[9],routing:values[10]};
      inserts.push(event);stored.set(event.providerEventId,{id:event.id,event_type:event.eventType,payload_sha256:event.payloadSha256});return{rows:[{id:event.id}],rowCount:1};
    }
    if(sql.startsWith("UPDATE connections SET last_provider_event_at"))return{rows:[],rowCount:1};
    throw new Error("Unexpected identity HTTP SQL fixture statement: "+sql);
  }})};
  class TestModule {}
  Module({controllers:[WebhookIngressController],providers:[
    {provide:DatabaseService,useValue:database},{provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},
    {provide:TenantDrainService,useValue:{wakeInbound:async()=>{wakes++}}},{provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}}
  ]})(TestModule);
  const app=await NestFactory.create(TestModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  t.after(()=>app.close());await app.init();await app.getHttpAdapter().getInstance().ready();
  const value=message=>({messaging_product:"whatsapp",metadata:{phone_number_id:phoneNumberId},messages:[message]});
  const envelope=(message,id=wabaId)=>({object:"whatsapp_business_account",entry:[{id,changes:[{field:"messages",value:value(message)}]}]});
  const inject=(body,valid=true)=>{const payload=JSON.stringify(body);return app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":`sha256=${valid?createHmac("sha256",secret).update(payload).digest("hex"):"0".repeat(64)}`},payload})};
  const system=(id,type="user_changed_user_id")=>({id,type:"system",timestamp:now,...(type==="user_changed_number"?{from:"12025550138"}:{}),
    system:type==="user_changed_number"?{type,wa_id:"12025550163",user_id:"SA.current"}:{type,previous_user_id:"SA.previous",user_id:"SA.current"}});
  for(const type of ["user_changed_user_id","user_changed_number"]){
    const message=system(`identity-${type}`,type),body=envelope(message),before=inserts.length;
    assert.equal((await inject(body)).statusCode,200);assert.equal(inserts.length,before+1);
    const event=inserts.at(-1);assert.equal(event.payload.entry[0].id,wabaId);assert.deepEqual(event.asset,asset);
    assert.equal(event.payloadSha256,digest(event.payload));assert(event.transition);assert(event.change);
    assert.deepEqual(event.transition,metaDirectTransitionEvidence(event.payload,event.payloadSha256,asset));
    assert.deepEqual(event.change,metaDirectIdentityChangeEvidence(event.payload,event.payloadSha256));
    assert.equal((await inject(body)).json().duplicates,1);assert.equal(inserts.length,before+1,"Same signed event does not create new evidence");
    const companion={id:`companion-${type}`,from:"12025550138",timestamp:now,type:"text",text:{body:"companion"}};
    const rebatch={...body,padding:"ignored batch metadata",entry:[{...body.entry[0],time:Number(now),changes:[{field:"messages",value:{...value(message),messages:[message,companion]}}]}]};
    const rebatchResponse=await inject(rebatch);assert.equal(rebatchResponse.statusCode,200);assert.equal(rebatchResponse.json().duplicates,1);assert.equal(rebatchResponse.json().count,1);
    assert.equal(inserts.length,before+2,"A different companion only adds its own unit; identity evidence remains the original duplicate");
  }
  for(const [label,id] of [["foreign","88800123456"],["missing",null],["malformed",{bad:true}]]){
    const body=envelope(system(`identity-${label}`),id);if(label==="missing")delete body.entry[0].id;
    assert.equal((await inject(body)).statusCode,200);
    const event=inserts.at(-1);assert.equal(event.transition,null,label+" signed account context cannot mint a transition");assert(event.change,"Producer computes a marker; actual PG independently rejects the unavailable account pin");
  }
  const ordinary={id:"ordinary-projection",from:"12025550138",timestamp:now,type:"text",text:{body:"ordinary"}};
  assert.equal((await inject(envelope(ordinary))).statusCode,200);
  const ordinaryPayload={entry:[{id:wabaId,changes:[{field:"messages",value:value(ordinary)}]}]};
  assert.deepEqual(inserts.at(-1).payload,ordinaryPayload);assert.equal(inserts.at(-1).payloadSha256,digest(ordinaryPayload));
  assert.equal(inserts.at(-1).routing.category,"PRIMARY_MESSAGE");assert.equal(inserts.at(-1).routing.payloadSha256,digest(ordinaryPayload));
  assert.equal(inserts.at(-1).routing.providerSessionId,asset.providerSessionId);
  assert.equal((await inject(envelope(ordinary,"88800123456"))).statusCode,409,"Changed signed account context conflicts with the original ordinary source hash");
  const beforeBad=inserts.length,wakesBeforeBad=wakes;
  assert.equal((await inject(envelope(system("identity-bad-signature")),false)).statusCode,401);assert.equal(inserts.length,beforeBad);assert.equal(wakes,wakesBeforeBad);
  const historic=system("identity-old-projection"),legacyPayload={entry:[{changes:[{field:"messages",value:value(historic)}]}]};
  const legacyRow={id:"retained-old-event",event_type:"messages",payload_sha256:digest(legacyPayload)};stored.set(historic.id,legacyRow);
  assert.equal((await inject(envelope(historic))).statusCode,409,"New account-bearing projection cannot reinterpret the old same-key event");
  assert.deepEqual(stored.get(historic.id),legacyRow);assert.equal(inserts.length,beforeBad);assert.equal(wakes,wakesBeforeBad);
  pausedRoute=true;
  const ignored=inserts.length,ignoredWakes=wakes;
  for(const item of [{...ordinary,id:"paused-ordinary"},{...ordinary,id:"paused-stale-ordinary",timestamp:"0"},{id:"paused-malformed-ordinary",type:"unsupported",timestamp:"invalid"}]){
    const response=await inject(envelope(item));assert.equal(response.statusCode,200);assert.equal(response.json().count,0);
  }
  assert.equal(pausedLookups,0,"Ordinary traffic cannot consult paused safety routing");
  assert.equal(inserts.length,ignored);assert.equal(wakes,ignoredWakes);
  const marker=system("paused-identity");assert.equal((await inject(envelope(marker))).json().count,1);
  assert.equal(inserts.length,ignored+1);assert.equal(inserts.at(-1).routing,null);assert.deepEqual(inserts.at(-1).asset,asset);
  assert.equal(pausedLookups,1,"Only the signed safety unit uses paused routing");
  const settled=inserts.length,settledWakes=wakes;
  assert.equal((await inject(envelope(system("paused-bad-signature")),false)).statusCode,401);
  assert.equal((await inject(envelope({...system("paused-stale-marker"),timestamp:String(Number(now)-8*86400)}))).statusCode,401);
  const wrongPhone=envelope(system("paused-wrong-phone"));wrongPhone.entry[0].changes[0].value.metadata.phone_number_id="999999999";
  assert.equal((await inject(wrongPhone)).json().count,0);
  pausedProof=false;assert.equal((await inject(envelope(system("paused-untrusted-source")))).statusCode,404);pausedProof=true;
  process.env.META_APP_ID="999999999";
  try{assert.equal((await inject(envelope(system("paused-wrong-app")))).statusCode,404);}finally{process.env.META_APP_ID="123456789";}
  assert.equal(inserts.length,settled);assert.equal(wakes,settledWakes,"Denied paused probes dispatch no inbound work");

});


test("signed routing HTTP admission isolates passive traffic and durably fences malformed neighbors in either order",async(t)=>{
  const saved={app:process.env.META_APP_ID,secret:process.env.META_APP_SECRET_REFERENCE};
  process.env.META_APP_ID="123456789";process.env.META_APP_SECRET_REFERENCE="secret://test/meta/app";
  t.after(()=>{for(const [key,value] of [["META_APP_ID",saved.app],["META_APP_SECRET_REFERENCE",saved.secret]]){if(value===undefined)delete process.env[key];else process.env[key]=value}});
  const secret="synthetic-routing-secret",account="77700123456",phone="55500123456",now=String(Math.floor(Date.now()/1000));
  const first={tenant_id:"tenant-a",connection_id:"connection-a",provider:"META",hmac_secret_reference:process.env.META_APP_SECRET_REFERENCE,provider_session_id:"10000000-0000-4000-8000-000000000001",phone_number_id:phone,account_id:account};
  const second={...first,tenant_id:"tenant-b",connection_id:"connection-b",provider_session_id:"10000000-0000-4000-8000-000000000002",phone_number_id:"55500123457"};
  const calls=[],lookups=[],wakes=[],durable=new Map(),templateCalls=[];let routes=[first,second],failTemplate=false;
  const accept=async(route,event)=>{const key=route.connection_id+":"+event.providerEventId;const duplicate=durable.has(key);if(!duplicate)durable.set(key,event);calls.push({route,event,duplicate});return{id:key,duplicate}};
  class TestModule{}
  Module({controllers:[WebhookIngressController],providers:[
    {provide:DatabaseService,useValue:{resolveMetaRoutingRoutes:async(a,p,app,ref)=>{lookups.push({a,p,app,ref});return a===account?routes.filter(r=>!p||r.phone_number_id===p):[]},resolveMetaWebhookRoute:async()=>first,acceptMetaRoutingEvent:accept,acceptWebhookEvent:accept,
      resolveMetaLifecycleRoutes:async a=>a===account?[first]:[],
      withTenant:async(tenant,work)=>{assert.equal(tenant,first.tenant_id);return work({query:async(sql,args)=>{
        assert.match(sql,/^SELECT app\.invalidate_meta_template_account\(/u);templateCalls.push(args);
        if(failTemplate)throw new Error("Synthetic template admission unavailable");
        return{rows:[{value:{accepted:true,duplicate:false}}]};
      }})}}},
    {provide:WebhookSecretService,useValue:{resolveHmac:async()=>secret}},{provide:TenantDrainService,useValue:{wakeInbound:async id=>wakes.push(id)}},
    {provide:RoutingConnectorsConfig,useValue:{}},{provide:SecretProvisioningService,useValue:{}}
  ]})(TestModule);
  const app=await NestFactory.create(TestModule,new FastifyAdapter({bodyLimit:META_WEBHOOK_MAX_BYTES}),{logger:false,rawBody:true});
  t.after(()=>app.close());await app.init();await app.getHttpAdapter().getInstance().ready();
  const message={id:"synthetic-message",from:"15550009999",timestamp:now,type:"text",text:{body:"Synthetic message"}};
  const passive={field:"standby",value:{messaging_product:"whatsapp",metadata:{phone_number_id:phone},standby:{messages:[message]}}};
  const ordinary={field:"messages",value:{messaging_product:"whatsapp",metadata:{phone_number_id:phone},messages:[message]}};
  const body=(...changes)=>({object:"whatsapp_business_account",entry:[{id:account,changes}]});
  const inject=(envelope,bad=false)=>{const payload=JSON.stringify(envelope);return app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":`sha256=${bad?"0".repeat(64):createHmac("sha256",secret).update(payload).digest("hex")}`},payload})};
  const reset=()=>{calls.length=0;lookups.length=0;wakes.length=0;durable.clear();templateCalls.length=0;failTemplate=false;routes=[first,second]};
  assert.equal((await inject(body(passive),true)).statusCode,401);assert.equal(calls.length,0);assert.equal(lookups.length,0);
  const mixed=await inject(body(ordinary,passive));assert.equal(mixed.statusCode,200);assert.equal(mixed.json().count,2);
  assert.deepEqual(calls.map(c=>c.event.eventType),["meta.routing.passive","messages"]);
  assert.equal(calls[0].event.payload.entry[0].changes[0].value.messages,undefined);
  assert.equal(calls[0].event.evidence.category,"STANDBY_MESSAGE");assert.equal(calls[1].event.metaRoutingEvidence.category,"PRIMARY_MESSAGE");
  assert.equal((await inject(body(ordinary,passive))).json().duplicates,2);reset();
  for(const changes of [[{field:"messages",value:null},passive],[passive,{field:"messages",value:null}]]){
    assert.equal((await inject(body(...changes))).statusCode,400);assert.equal(calls.length,1);assert.equal(calls[0].event.eventType,"meta.routing.passive");reset();
  }
  // Independent safety families survive a signed template failure in either
  // entry order; ordinary work is still rejected. This exercises the real
  // template parser/admission helper through the existing HTTP controller.
  const templateChange={field:"message_template_status_update",value:{event:"PAUSED",message_template_id:123456789}};
  const templateEntry={id:account,changes:[templateChange]};
  const invalidTemplateEntry={...templateEntry,id:"invalid-account"};
  const routingEntry={id:account,changes:[passive,ordinary]};
  for(const entries of [[invalidTemplateEntry,routingEntry],[routingEntry,invalidTemplateEntry]]){
    assert.equal((await inject({object:"whatsapp_business_account",entry:entries})).statusCode,400);
    assert.deepEqual(calls.map(c=>c.event.eventType),["meta.routing.passive"]);
    assert.equal(calls[0].event.evidence.category,"STANDBY_MESSAGE");assert.deepEqual(wakes,[first.tenant_id]);
    assert.equal(templateCalls.length,0);reset();
  }
  for(const entries of [[templateEntry,routingEntry],[routingEntry,templateEntry]]){
    failTemplate=true;
    assert.equal((await inject({object:"whatsapp_business_account",entry:entries})).statusCode,500);
    assert.equal(templateCalls.length,1);assert.deepEqual(calls.map(c=>c.event.eventType),["meta.routing.passive"]);
    assert.deepEqual(wakes,[first.tenant_id]);reset();
  }
  const signedMixed={object:"whatsapp_business_account",entry:[templateEntry,routingEntry]};
  assert.equal((await inject(signedMixed,true)).statusCode,401);
  assert.equal(templateCalls.length,0);assert.equal(lookups.length,0);assert.equal(calls.length,0);assert.equal(wakes.length,0);
  const validMixed=await inject(signedMixed);assert.equal(validMixed.statusCode,200);assert.equal(validMixed.json().count,3);
  assert.equal(templateCalls.length,1);assert.deepEqual(calls.map(c=>c.event.eventType),["meta.routing.passive","messages"]);
  reset();
  for(const malformed of [{...passive,value:{...passive.value,standby:null}},{field:"standby",value:null}]){
    const response=await inject(body(malformed));assert.equal(response.statusCode,200);assert.equal(calls.length,malformed.value?1:2);
    assert.ok(calls.every(c=>c.event.eventType==="meta.routing.unresolved"&&c.event.evidence.peer===undefined&&c.event.payload.redacted===true));reset();
  }
  for(const type of ["control_taken","control_passed"]){
    const handover={field:"messaging_handovers",value:{messaging_product:"whatsapp",recipient:{phone_number_id:phone},sender:{user_id:"SA.unsupported"},type,timestamp:now}};
    assert.equal((await inject(body(handover))).statusCode,200);assert.equal(calls.length,1);assert.equal(calls[0].event.evidence.category,"UNRESOLVED_ROUTING");assert.equal(calls[0].event.evidence.peer,undefined);reset();
  }
  const wrongObject=await inject({...body(passive),object:"other"});assert.equal(wrongObject.statusCode,200);assert.equal(calls[0].event.evidence.category,"UNRESOLVED_ROUTING");reset();
  const foreign=body(passive);foreign.entry[0].id="77700123457";assert.equal((await inject(foreign)).json().unrouted,1);assert.equal(calls.length,0);reset();
  routes=[first,{...first,provider_session_id:second.provider_session_id}];assert.equal((await inject(body(passive))).statusCode,400);assert.equal(calls.length,0);
});
