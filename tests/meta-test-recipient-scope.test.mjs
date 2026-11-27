import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { parseWahaTestRecipientAllowlist } from "../packages/core/dist/waha-test-recipient-scope.js";
import { metaTestSendAllowed, metaTestWebhookUnits, metaTestCoexistenceUnit, metaTestLifecycleValue, metaTestRoutingEvidence } from "../packages/core/dist/meta-test-recipient-scope.js";
import { metaDirectIdentityChangeEvidence, metaDirectTransitionEvidence } from "../packages/core/dist/meta-direct-identity.js";
import { classifyMetaLifecycleValue, metaLifecyclePayloadSha256 } from "../packages/core/dist/meta-account-relation.js";
import { metaStatusPayloadSha256 } from "../packages/core/dist/meta-pricing-observation.js";
import { MetaGroupsAdapter } from "../services/connector-worker/dist/packages/connectors/src/meta.js";
import { WebhookIngressController } from "../services/control-api/dist/webhook-ingress.controller.js";
import { DeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";
import { synchronizeGroups } from "../services/connector-worker/dist/services/connector-worker/src/connection-operation-repository.js";
import { HttpMetaGroupsClient } from "../services/control-api/dist/meta-groups.client.js";

const phone="12025550106", foreign="12025550162", phoneId="123456789", wabaId="987654321", appId="111111111";
const scope=parseWahaTestRecipientAllowlist(JSON.stringify([phone,"123456789@g.us"]));
const now=()=>String(Math.floor(Date.now()/1000));
const message=(from=phone,overrides={})=>({id:"wamid.synthetic",from,timestamp:now(),type:"text",text:{body:"Synthetic owner message"},...overrides});
const value=(messages)=>({messaging_product:"whatsapp",metadata:{phone_number_id:phoneId,display_phone_number:"12025550175"},messages});
const status=(recipient_id=phone)=>({id:"wamid.receipt",recipient_id,status:"delivered",timestamp:now()});
const adapter=(config={})=>new MetaGroupsAdapter({accessToken:"synthetic-private-token",graphVersion:"v24.0",baseUrl:"https://graph.test",phoneNumberIdFor:()=>phoneId,...config});

test("Meta recipient scope denies by default and only an explicit opt-out disables it",()=>{
  for(const raw of [undefined,""," ","[]"]){
    const denied=parseWahaTestRecipientAllowlist(raw);
    assert.equal(metaTestSendAllowed(denied,{recipient_type:"individual",to:phone}),false);
    assert.equal(metaTestSendAllowed(denied,{recipient_type:"individual",to:foreign}),false);
    const original={...value([message(),message(foreign)]),statuses:[status(),status(foreign)]};
    assert.equal(metaTestWebhookUnits(denied,original).values.length,0);
    assert.equal(metaTestWebhookUnits(denied,value([{type:"system"}])).values.length,0);
    assert.equal(metaTestWebhookUnits(denied,original,Date.now(),()=>true).values.length,0);
  }
  for(const raw of ["*"]){
    const absent=parseWahaTestRecipientAllowlist(raw);
    assert.equal(metaTestSendAllowed(absent,{recipient_type:"group",to:foreign}),true);
    const original=value([message(foreign)]),before=JSON.stringify(original);
    assert.strictEqual(metaTestWebhookUnits(absent,original).values[0],original);
    assert.equal(JSON.stringify(original),before);
    assert.equal(metaStatusPayloadSha256(metaTestWebhookUnits(absent,original).values[0]),metaStatusPayloadSha256(original));
    assert.strictEqual(metaTestLifecycleValue(absent,original),original);
  }
  assert.equal(metaTestSendAllowed(scope,{recipient_type:"individual",to:phone}),true);
  for(const body of [{recipient_type:"group",to:phone},{recipient_type:"group",to:"123456789@g.us"},{recipient_type:"individual",to:foreign},{recipient_type:"individual",recipient:"US.owner"},{recipient_type:"individual",to:phone,recipient:"US.owner"},{recipient_type:"individual",to:phone,group_id:phone},{to:phone}])assert.equal(metaTestSendAllowed(scope,body),false);
  assert.equal(metaTestSendAllowed(parseWahaTestRecipientAllowlist("[]"),{recipient_type:"individual",to:phone}),false);
});

test("Meta unit projection drops excluded/malformed chats and adjacent contacts before persistence",()=>{
  const source={...value([message(),message(foreign,{id:"bad id"}),message(phone,{id:"contacts",type:"contacts",contacts:[{name:{formatted_name:"Foreign"},phones:[{phone:foreign}]}]}),message(phone,{id:"group",group_id:phone}),message(phone,{id:"context",context:{from:foreign,id:"wamid.quote"}}),message(phone,{id:"opaque",from:undefined,from_user_id:"US.owner"})]),contacts:[{wa_id:phone,profile:{name:"Synthetic owner",foreign}},{wa_id:foreign,profile:{name:"Foreign customer"}}],unrelated_customer:{phone:foreign}};
  // JSON is the signed provider shape: absent fields are not explicit undefined.
  const original=JSON.parse(JSON.stringify(source)),saved=structuredClone(original);
  const projected=metaTestWebhookUnits(scope,original);
  assert.equal(projected.values.length,1);assert.equal(projected.dropped,5);
  const unit=projected.values[0];assert.deepEqual(unit.contacts,[{wa_id:phone,profile:{name:"Synthetic owner"}}]);
  assert.equal(JSON.stringify(unit).includes(foreign),false);assert.equal(JSON.stringify(unit).includes("Foreign customer"),false);
  assert.equal(JSON.stringify(unit).includes("unrelated_customer"),false);assert.deepEqual(original,saved);
  const originalUnit={...original,messages:[original.messages[0]]};
  assert.equal(unit.test_recipient_source_sha256,metaStatusPayloadSha256(originalUnit));
  assert.notEqual(metaStatusPayloadSha256(unit),unit.test_recipient_source_sha256);
  assert.equal(metaTestWebhookUnits(parseWahaTestRecipientAllowlist("[]"),value([message()])).values.length,0);
  for(const mutate of [m=>{m.timestamp="bad"},m=>{m.timestamp="1"},m=>{m.id="bad id"},m=>{m.history_context={}},m=>{m.group_id=null},m=>{m.recipient_type="group"}]){
    const unit=value([message()]);mutate(unit.messages[0]);assert.equal(metaTestWebhookUnits(scope,unit).values.length,0);
  }
  for(const envelope of [{...value([message()]),group_id:phone},{...value([message()]),metadata:{phone_number_id:phoneId,group_id:phone}}])assert.equal(metaTestWebhookUnits(scope,envelope).values.length,0);
  const malformedDisplay={...value([message()]),metadata:{phone_number_id:phoneId,display_phone_number:{foreign_roster:[foreign]}}};
  const safe=metaTestWebhookUnits(scope,malformedDisplay).values[0];assert.equal(safe.metadata.display_phone_number,undefined);assert.equal(JSON.stringify(safe).includes(foreign),false);
});

test("Meta status destinations require explicit allowlisted PHONE and never retain neighboring contacts",()=>{
  const source={...value([]),contacts:[{wa_id:foreign,profile:{name:"Foreign"}}],statuses:[{...status(),conversation:{foreign},pricing:{billable:true,pricing_model:"PMP",category:"utility",type:"regular",private_customer:foreign},errors:[{code:131000,error_data:{foreign}}]},status(foreign),{...status(),recipient_user_id:"US.owner"},{...status(),recipient_id:undefined},{...status(),group_id:phone},{...status(),timestamp:"bad"}]};
  const projected=metaTestWebhookUnits(scope,JSON.parse(JSON.stringify(source)));
  assert.equal(projected.values.length,1);assert.equal(projected.dropped,5);
  assert.equal(projected.values[0].statuses[0].recipient_id,phone);
  assert.deepEqual(projected.values[0].statuses[0].pricing,{test_recipient_source_sha256:metaStatusPayloadSha256(source.statuses[0].pricing)});assert.deepEqual(projected.values[0].statuses[0].errors,[{code:131000}]);
  assert.equal(JSON.stringify(projected.values).includes(foreign),false);
  for(const extra of [{recipient_type:"group"},{recipient:phone}])assert.equal(metaTestWebhookUnits(scope,{...value([]),statuses:[{...status(),...extra}]}).values.length,0);
});

test("guarded Meta system markers cannot grant identity transition authority, even without ID/time",()=>{
  const original=value([{type:"system",from:foreign,system:{type:"user_changed_number",wa_id:phone,body:"Foreign private content"}}]);
  const unit=metaTestWebhookUnits(scope,original).values[0],payload={entry:[{id:wabaId,changes:[{field:"messages",value:unit}]}]};
  const sha=createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  assert.deepEqual(metaDirectIdentityChangeEvidence(payload,sha),{schemaVersion:1,scope:"ASSET",previous:[],payloadSha256:sha});
  assert.equal(metaDirectTransitionEvidence(payload,sha,{providerSessionId:"10000000-0000-4000-8000-000000000001",phoneNumberId:phoneId,wabaId}),null);
  assert.equal(unit.messages[0].timestamp,undefined);assert.equal(unit.messages[0].system,undefined);
  assert.match(unit.messages[0].id,/^guarded-identity:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(unit).includes(foreign),false);assert.equal(JSON.stringify(unit).includes("Foreign private"),false);
  for(const group_id of [phone,null]){
    const guarded=metaTestWebhookUnits(scope,value([{...original.messages[0],group_id}])).values[0];
    const projection={entry:[{id:wabaId,changes:[{field:"messages",value:guarded}]}]};
    assert.equal(metaDirectIdentityChangeEvidence(projection,metaStatusPayloadSha256(projection)).scope,"ASSET");assert.equal(guarded.messages[0].group_id,undefined);
  }
});

test("Meta coexistence filters subjects without relabeling original source identity or completing empty history",()=>{
  const original={schemaVersion:1,kind:"HISTORY",wabaId,phoneId,businessPhone:"12025550175",key:"0:1",sourceSha256:"a".repeat(64),phase:0,chunkOrder:1,progress:100,messages:[{subject:phone,type:"text",id:"owner"},{subject:foreign,type:"text",id:"foreign"}],contacts:[{subject:foreign,name:"Foreign"},{subject:phone,name:"Synthetic"}]};
  const projected=metaTestCoexistenceUnit(scope,original);
  assert.equal(projected.sourceSha256,original.sourceSha256);assert.equal(projected.key,original.key);
  assert.deepEqual(projected.messages,[original.messages[0]]);assert.deepEqual(projected.contacts,[original.contacts[1]]);
  assert.strictEqual(metaTestCoexistenceUnit(undefined,original),original);
  assert.equal(metaTestCoexistenceUnit(parseWahaTestRecipientAllowlist("[]"),original),null);
  assert.equal(metaTestCoexistenceUnit(scope,{...original,messages:[original.messages[1]],contacts:[]}),null);
  assert.equal(metaTestCoexistenceUnit(scope,{...original,kind:"DECLINED",messages:[],contacts:[]}).kind,"DECLINED");
});

test("Meta routing guard retains only safe extracted negative facts and cannot manufacture control",()=>{
  const evidence={schemaVersion:1,category:"CONTROL_TAKEN",accountId:wabaId,phoneNumberId:phoneId,observedAt:new Date().toISOString(),payloadSha256:"a".repeat(64),peer:{kind:"PHONE",value:foreign}};
  const held=metaTestRoutingEvidence(scope,evidence);
  assert.equal(held.category,"UNRESOLVED_ROUTING");assert.equal(held.peer,undefined);assert.equal(held.payloadSha256,evidence.payloadSha256);
  for(const category of ["CONTROL_PASSED","STANDBY_ECHO","STANDBY_STATUS","OWN_MESSAGE_STATUS"])assert.equal(metaTestRoutingEvidence(scope,{...evidence,category}),null);
  assert.strictEqual(metaTestRoutingEvidence(scope,{...evidence,peer:{kind:"PHONE",value:phone}}).peer.value,phone);
  assert.strictEqual(metaTestRoutingEvidence(undefined,evidence),evidence);
});

test("Meta account redaction preserves classification and never promotes observation to recovery",()=>{
  for(const original of [{event:"ACCOUNT_OFFBOARDED",private_customer:{phone:foreign},ban_info:{waba_ban_state:{foreign}},waba_info:{waba_id:{foreign}},restriction_info:[{restriction_type:{foreign}}]},{event:"DISABLED_UPDATE",ban_info:{waba_ban_state:"DISABLE",private_customer:foreign}},{event:"ACCOUNT_RESTRICTION",restriction_info:[{restriction_type:"RESTRICTED_CUSTOMER_INITIATED_MESSAGING",body:foreign}]},{event:"PARTNER_APP_UNINSTALLED",waba_info:{waba_id:wabaId,partner_app_id:appId,private_customer:foreign}},{event:"PARTNER_APP_INSTALLED",waba_info:{waba_id:wabaId,partner_app_id:"999999999",private_customer:foreign}}]){
    const projected=metaTestLifecycleValue(scope,original);
    assert.deepEqual(classifyMetaLifecycleValue(projected,appId),classifyMetaLifecycleValue(original,appId));
    assert.equal(JSON.stringify(projected).includes(foreign),false);
    assert.equal(projected.test_recipient_source_sha256,metaStatusPayloadSha256(original));
  }
});

test("Meta final send/upload boundary guards every content kind before checkpoints/network with redacted logs",async(t)=>{
  const saved={scope:process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,fetch:globalThis.fetch};
  t.after(()=>{if(saved.scope===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=saved.scope;globalThis.fetch=saved.fetch});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone,"123456789@g.us"]);
  const requests=[],warnings=[],checkpoints=[];
  t.mock.method(process.stderr, "write", (line) => { warnings.push(String(line)); return true; });
  globalThis.fetch=async(url,init)=>{requests.push({url:String(url),body:init.body});return Response.json(String(url).endsWith("/media")?{id:"synthetic-media"}:{messages:[{id:"wamid.sent"}]})};
  const guarded=adapter({beforeRequest:async()=>{checkpoints.push("request")},beforeMessageSend:async()=>{checkpoints.push("message")}});
  const input={connectionId:"synthetic",groupId:phone,recipientType:"DIRECT",text:"Synthetic owner text",idempotencyKey:"synthetic"};
  const variants=[{}, {media:{bytes:new Uint8Array([1,2]),mimeType:"image/png",filename:"synthetic.png",providerMediaId:"synthetic-media"}}, {template:{name:"synthetic_template",languageCode:"en_US",bodyParameters:["Synthetic"]}}, {flow:{id:"12345678",token:"synthetic-flow-token",buttonLabel:"Open",data:{}}}, {choices:{options:[{id:"synthetic",label:"Synthetic"}]}}, {location:{latitude:1,longitude:2}}];
  for(const variant of variants)await guarded.send({...input,...variant});
  const count=requests.length,checks=checkpoints.length;
  for(const variant of variants)await assert.rejects(guarded.send({...input,...variant,groupId:foreign}),error=>error.code==="META_TEST_RECIPIENT_NOT_ALLOWED"&&error.outcomeKnown===true&&!error.retryable);
  for(const target of [{groupId:phone,recipientType:"GROUP"},{groupId:"123456789",recipientType:"GROUP"},{metaDirectRecipient:{kind:"BSUID",value:"US.owner"}}])await assert.rejects(guarded.send({...input,...target}),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  await assert.rejects(guarded.prepareMedia({...input,groupId:foreign,media:variants[1].media}),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  await assert.rejects(guarded.request(`/${phoneId}/messages`,{method:"POST",body:{recipient_type:"group",to:phone}},"mutation",true),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  assert.equal(requests.length,count);assert.equal(checkpoints.length,checks);
  assert(warnings.length >= 11);
  for (const line of warnings) {
    const { timestamp, request_id, ...entry } = JSON.parse(line);
    assert.deepEqual(entry, {
      level: "warn", event: "meta.test_recipient_scope_refused",
      component: "meta-connector", error_code: "META_TEST_RECIPIENT_NOT_ALLOWED",
    });
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(request_id, /^[a-f0-9-]{36}$/u);
  }
  // A mutation during an awaited preflight is fenced again at the final send edge.
  const body={recipient_type:"individual",to:phone};
  const racing=adapter({beforeMessageSend:async()=>{body.to=foreign}});
  await assert.rejects(racing.request(`/${phoneId}/messages`,{method:"POST",body},"mutation",true),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});assert.equal(requests.length,count);
  let checkpointCalls=0;const changedBeforeCheckpoint={recipient_type:"individual",to:phone};
  const changed=adapter({beforeRequest:async()=>{changedBeforeCheckpoint.to=foreign},beforeMessageSend:async()=>{checkpointCalls++}});
  await assert.rejects(changed.request(`/${phoneId}/messages`,{method:"POST",body:changedBeforeCheckpoint},"mutation",true),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});assert.equal(checkpointCalls,0);assert.equal(requests.length,count);
  for(const raw of [undefined,""," ","[]","not-json"]){
    if(raw===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
    if(raw==="not-json")assert.throws(()=>adapter());
    else await assert.rejects(adapter().send(input),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
    assert.equal(requests.length,count);
  }
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="*";
  await adapter().send({...input,groupId:foreign});assert.equal(JSON.parse(requests.at(-1).body).to,foreign);
});

test("excluded Meta deliveries stop before begin-send, secrets, native writes and media staging",async(t)=>{
  const previous=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;
  t.after(()=>{if(previous===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=previous});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
  const effects=[],failures=[];
  const processor=new DeliveryProcessor({whatsAppMarketingOptedOut:async()=>false,beginSend:async()=>effects.push("begin"),fail:async(_j,_l,retryable,error)=>failures.push({retryable,error})},{resolve:async()=>{effects.push("secret");throw new Error("Unexpected secret read")}},{metaGraphVersion:"v24.0"},8,{prepare:async()=>{effects.push("media");throw new Error("Unexpected media preparation")}});
  const job={id:"synthetic",provider:"meta",tenantId:"synthetic",connectionId:"synthetic",recipientType:"GROUP",groupId:phone,ticketId:"42",text:"Synthetic",contentType:"text/plain",attempts:1,idempotencyKey:"synthetic"};
  assert.equal(await processor.deliver(job,"synthetic-lease"),false);assert.equal(await processor.deliver({...job,media:{mimeType:"image/png"}},"synthetic-lease"),false);
  assert.deepEqual(effects,[]);assert.equal(failures.length,2);assert(failures.every(item=>!item.retryable&&item.error.includes("outside the configured test scope")));
});

test("guarded Meta directory makes no provider request or repository write and preserves excluded rows",async(t)=>{
  const saved=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,fetchBefore=globalThis.fetch;
  t.after(()=>{if(saved===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=saved;globalThis.fetch=fetchBefore});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
  let requests=0,queries=0;globalThis.fetch=async()=>{requests++;throw new Error("Unexpected directory request")};
  assert.deepEqual(await adapter().listGroups("synthetic"),{groups:[],nextCursor:undefined});assert.equal(requests,0);
  const warnings = [];
  t.mock.method(process.stderr, "write", (line) => { warnings.push(String(line)); return true; });
  const guarded=adapter(),clientApi=new HttpMetaGroupsClient(new URL("https://graph.test"),"v24.0","synthetic-private-token",phoneId,async()=>{throw new Error("Unexpected API request checkpoint")});
  for(const operation of [()=>guarded.checkGroupsCapability("synthetic"),()=>guarded.getGroup("synthetic",phone),()=>guarded.createGroup("synthetic",{subject:"Synthetic"}),()=>guarded.getGroupInviteLink("synthetic",phone),()=>guarded.resetGroupInviteLink("synthetic",phone),()=>guarded.updateGroup("synthetic",phone,{subject:"Synthetic"}),()=>guarded.listGroupsPage("synthetic",undefined,1),()=>guarded.syncBusinessAppData("synthetic","contacts",async()=>{throw new Error("Unexpected bulk checkpoint")}),()=>guarded.syncBusinessAppData("synthetic","history",async()=>{throw new Error("Unexpected bulk checkpoint")}),()=>clientApi.capability(),()=>clientApi.createGroup({subject:"Synthetic"}),()=>clientApi.getInviteLink(phone),()=>clientApi.resetInviteLink(phone),()=>clientApi.updateGroup(phone,{subject:"Synthetic"}),()=>clientApi.threadControl("take",undefined,{kind:"PHONE",value:foreign},"10000000-0000-4000-8000-000000000001")])await assert.rejects(operation(),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  assert.equal(requests,0);
  const groupClientEntries = warnings.map((line) => JSON.parse(line)).filter((entry) => entry.component === "meta-groups-client");
  assert.equal(groupClientEntries.length, 6);
  for (const { timestamp, request_id, ...entry } of groupClientEntries) {
    assert.deepEqual(entry, {
      level: "warn", event: "meta.test_recipient_scope_refused",
      component: "meta-groups-client", error_code: "META_TEST_RECIPIENT_NOT_ALLOWED",
    });
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(request_id, /^[a-f0-9-]{36}$/u);
  }
  const client={query:async()=>{queries++;throw new Error("Unexpected group persistence")}},job={provider:"META",tenantId:"synthetic",connectionId:"synthetic"};
  await synchronizeGroups(client,job,[]);
  await assert.rejects(synchronizeGroups(client,job,[{id:phone,name:"Foreign group",participants:0}]),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});assert.equal(queries,0);
});

test("signed Meta ingress drops foreign units while retaining all attributable safety negatives in either order",async(t)=>{
  const saved={scope:process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,app:process.env.META_APP_ID,secret:process.env.META_APP_SECRET_REFERENCE};
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);process.env.META_APP_ID=appId;process.env.META_APP_SECRET_REFERENCE="secret://synthetic/meta";
  t.after(()=>{for(const[key,v]of[["WASALX_TEST_RECIPIENT_ALLOWLIST",saved.scope],["META_APP_ID",saved.app],["META_APP_SECRET_REFERENCE",saved.secret]]){if(v===undefined)delete process.env[key];else process.env[key]=v}});
  const secret="synthetic-hmac-secret",events=[],routing=[],lifecycle=[],imports=[],templates=[];
  const route={tenant_id:"synthetic",connection_id:"synthetic",provider:"META",phone_number_id:phoneId,provider_session_id:"10000000-0000-4000-8000-000000000001",waba_id:wabaId,app_id:appId,display_phone_number:"12025550175"};
  const accepted=(list,event)=>{list.push(event);return{id:"synthetic",duplicate:false}};
  const database={resolveMetaWebhookRoute:async()=>route,resolveMetaIdentityWebhookRoute:async()=>route,resolveMetaRoutingRoutes:async()=>[route],resolveMetaLifecycleRoutes:async()=>[route],acceptWebhookEvent:async(_r,e)=>accepted(events,e),acceptMetaRoutingEvent:async(_r,e)=>accepted(routing,e),acceptMetaLifecycleEvent:async(_r,e)=>accepted(lifecycle,e),acceptMetaCoexistenceEvent:async(_r,e)=>accepted(imports,e),withTenant:async(_t,fn)=>fn({query:async(_sql,params)=>{templates.push(params);return{rows:[{value:{accepted:true,duplicate:false}}]}}})};
  const controller=new WebhookIngressController(database,{resolveHmac:async()=>secret},{wakeInbound:async()=>{}},{},{});
  const envelope=(changes)=>({object:"whatsapp_business_account",entry:[{id:wabaId,time:Number(now()),changes}]});
  const inject=(body,bad=false)=>{const rawBody=Buffer.from(JSON.stringify(body));return controller.meta({rawBody,headers:{"x-hub-signature-256":"sha256="+(bad?"0".repeat(64):createHmac("sha256",secret).update(rawBody).digest("hex"))}},body)};
  const ordinary={field:"messages",value:{...value([message(),message(foreign,{id:"bad id",timestamp:"bad"})]),contacts:[{wa_id:phone,profile:{name:"Synthetic"}},{wa_id:foreign,profile:{name:"Foreign"}}],statuses:[status(foreign),status()]}};
  await inject(envelope([ordinary]));assert.equal(events.length,2);assert.equal(JSON.stringify(events).includes(foreign),false);
  assert(events.every(e=>e.payloadSha256===(e.eventType==="message.status"?metaStatusPayloadSha256(e.payload):createHash("sha256").update(JSON.stringify(e.payload)).digest("hex"))));events.length=0;
  const metadata={phone_number_id:phoneId,display_phone_number:"12025550175"};
  const inert=(field,extra)=>({field,value:{messaging_product:"whatsapp",metadata,...extra}});
  const history=inert("history",{history:[{metadata:{phase:2,chunk_order:8,progress:100},threads:[{id:phone,messages:[message()]},{id:foreign,messages:[message(foreign)]}]}]});
  const contacts=inert("smb_app_state_sync",{state_sync:[phone,foreign].map(subject=>({type:"contact",action:"add",contact:{phone_number:subject,full_name:subject===phone?"Synthetic":"Foreign"},metadata:{timestamp:now()}}))});
  const echoes=inert("smb_message_echoes",{message_echoes:[phone,foreign].map(to=>message("12025550175",{to}))});
  await inject(envelope([history,contacts,echoes]));assert.equal(imports.length,3);
  for(const input of imports){assert.equal(input.sourceSha256,input.unit.sourceSha256);assert.equal(JSON.stringify(input.unit).includes(foreign),false);assert.equal(JSON.stringify(input.unit).includes("Foreign"),false);assert(input.unit.messages.length||input.unit.contacts.length)}
  imports.length=0;
  // Environment is snapshotted at construction; absent and empty scopes deny too.
  for(const raw of [undefined,"","[]","not-json"]){
    if(raw===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
    const create=()=>new WebhookIngressController(database,{resolveHmac:async()=>secret},{wakeInbound:async()=>{}},{},{});
    if(raw==="not-json"){assert.throws(create);continue}
    const denied=create(),body=envelope([ordinary,history,contacts,echoes,{field:"account_update",value:{event:"ACCOUNT_OFFBOARDED"}}]),bytes=Buffer.from(JSON.stringify(body));
    const result=await denied.meta({rawBody:bytes,headers:{"x-hub-signature-256":"sha256="+createHmac("sha256",secret).update(bytes).digest("hex")}},body);
    assert.equal(result.count,0);assert.equal(events.length+imports.length+lifecycle.length+templates.length,0);
  }
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="[]";
  const emptyController=new WebhookIngressController(database,{resolveHmac:async()=>secret},{wakeInbound:async()=>{}},{},{});
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
  const allForeign=envelope([inert("smb_message_echoes",{message_echoes:[message("12025550175",{to:foreign})]})]);
  const raw=Buffer.from(JSON.stringify(allForeign));
  const emptyResult=await emptyController.meta({rawBody:raw,headers:{"x-hub-signature-256":"sha256="+createHmac("sha256",secret).update(raw).digest("hex")}},allForeign);
  assert.equal(emptyResult.count,0);assert.equal(imports.length,0);
  const firstStatus={...status(),pricing:{private_customer:"first"}},secondStatus={...firstStatus,pricing:{private_customer:"second"}};
  await inject(envelope([{field:"messages",value:{...value([]),statuses:[firstStatus]}}]));
  await inject(envelope([{field:"messages",value:{...value([]),statuses:[secondStatus]}}]));
  assert.equal(events.length,2);assert.notEqual(events[0].providerEventId,events[1].providerEventId);assert.notEqual(events[0].payloadSha256,events[1].payloadSha256);
  assert.equal(JSON.stringify(events).includes("first"),false);assert.equal(JSON.stringify(events).includes("second"),false);events.length=0;
  const block={field:"account_update",value:{event:"ACCOUNT_OFFBOARDED",private_customer:foreign}};
  const system={field:"messages",value:value([{type:"system",from:foreign,system:{type:"user_changed_number",wa_id:phone}}])};
  const malformedSystem={...system,value:{...system.value,messaging_product:{foreign_roster:[foreign]}}};
  await inject(envelope([malformedSystem]));assert.equal(events.length,1);assert.equal(JSON.stringify(events).includes(foreign),false);
  assert.equal(events[0].payload.entry[0].changes[0].value.messaging_product,undefined);assert.equal(metaDirectIdentityChangeEvidence(events[0].payload,events[0].payloadSha256).scope,"ASSET");events.length=0;
  const passive={field:"standby",value:{...value(undefined),standby:{messages:[message(foreign)]}}};delete passive.value.messages;
  const bad={field:"messages",value:{...value([message(foreign,{id:"bad id",timestamp:"bad"})]),history:[]}};
  const malformed={field:"history",value:{}};
  const template={field:"message_template_status_update",value:{message_template_id:12345,event:"DISABLED",private_customer:foreign}};
  for(const changes of [[malformed,bad,block,system,passive,template],[template,passive,system,block,bad,malformed]]){
    await assert.rejects(inject(envelope(changes)));
    assert.equal(lifecycle.length,1);assert.equal(lifecycle[0].eventType,"meta.account.lifecycle.block");assert.equal(lifecycle[0].payload.admission.kind,"BLOCK");
    assert.equal(lifecycle[0].payloadSha256,metaLifecyclePayloadSha256({object:"whatsapp_business_account",entry:lifecycle[0].payload.entry}));
    assert.equal(events.length,1);assert.equal(metaDirectIdentityChangeEvidence(events[0].payload,events[0].payloadSha256).scope,"ASSET");
    assert.equal(metaDirectTransitionEvidence(events[0].payload,events[0].payloadSha256,{providerSessionId:route.provider_session_id,phoneNumberId:phoneId,wabaId}),null);
    assert.equal(routing.length,1);assert.equal(routing[0].evidence.category,"UNRESOLVED_ROUTING");assert.equal(routing[0].evidence.peer,undefined);assert.deepEqual(routing[0].payload,{redacted:true});
    assert.equal(JSON.stringify({events,routing,lifecycle}).includes(foreign),false);
    assert.equal(templates.length,1);assert.equal(templates[0].at(-1),"12345");assert.equal(JSON.stringify(templates).includes(foreign),false);templates.length=0;
    events.length=0;routing.length=0;lifecycle.length=0;
  }
  const positive={field:"messaging_handovers",value:{messaging_product:"whatsapp",recipient:{phone_number_id:phoneId},sender:{phone_number:phone},type:"control_passed",timestamp:now()}};
  await assert.rejects(inject(envelope([positive,malformed,block])));assert.equal(routing.length,0);assert.equal(lifecycle.length,1);lifecycle.length=0;
  const acceptRouting=database.acceptMetaRoutingEvent,admissionFailure=new Error("Synthetic first negative admission failure");let routingAttempts=0;
  database.acceptMetaRoutingEvent=async()=>{routingAttempts++;throw admissionFailure};
  for(const changes of [[positive,passive,block,system],[positive,passive,malformed,block,system]]){
    await assert.rejects(inject(envelope(changes)),error=>error instanceof AggregateError&&error.errors.includes(admissionFailure));
    assert.equal(events.length,1);assert.equal(lifecycle.length,1);assert.equal(routing.length,0);assert.equal(routingAttempts,1);
    events.length=0;lifecycle.length=0;routingAttempts=0;
  }
  database.acceptMetaRoutingEvent=acceptRouting;
  const oversized={field:"messages",value:value([...Array.from({length:1001},(_,index)=>message(phone,{id:`owner-${index}`})),{type:"system",from:foreign,group_id:phone,system:{type:"user_changed_number",wa_id:phone}}])};
  await assert.rejects(inject(envelope([oversized,block])),{status:400});assert.equal(events.length,1);assert.equal(lifecycle.length,1);assert.equal(metaDirectIdentityChangeEvidence(events[0].payload,events[0].payloadSha256).scope,"ASSET");
  events.length=0;lifecycle.length=0;
  await assert.rejects(inject(envelope([block,system,passive]),true),{status:401});assert.equal(events.length+routing.length+lifecycle.length,0);
});
