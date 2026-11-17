import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { metaTestRecipientAdmission, resolveMetaTestRecipientLink, resolveMetaTestStatusRecipientLink } from "../packages/core/dist/meta-test-recipient-link.js";
import { verifyMetaCredentialMetadata } from "../packages/core/dist/meta-account-relation.js";
import { parseWahaTestRecipientAllowlist } from "../packages/core/dist/waha-test-recipient-scope.js";
import { metaTestWebhookUnits } from "../packages/core/dist/meta-test-recipient-scope.js";
import { MetaGroupsAdapter } from "../services/connector-worker/dist/packages/connectors/src/meta.js";
import { DatabaseService } from "../services/control-api/dist/database.service.js";
import { DeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const phone="12025550106", foreign="12025550162", bsuid="US.syntheticOwner", phoneId="123456789", wabaId="987654321", appId="111111111";
const scope=parseWahaTestRecipientAllowlist(JSON.stringify([phone]));
const input={tenantId:uuid(1),connectionId:uuid(2),deliveryId:uuid(3),appId,scope};
function fixture(){
  const asset={providerSessionId:uuid(4),phoneNumberId:phoneId,wabaId};
  const secret_reference=`secret://${input.tenantId}/connections/${input.connectionId}/meta`;
  const proof={schemaVersion:1,claim:"PHONE_ACCOUNT_RELATION_VERIFIED",tenantId:input.tenantId,connectionId:input.connectionId,
    ...asset,secretReference:secret_reference,credentialFingerprint:"b".repeat(64),operationId:uuid(5),fencingToken:1,
    graphVersion:"v24.0",verifiedAt:new Date().toISOString(),responseSha256:"a".repeat(64),
    credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:["whatsapp_business_management","whatsapp_business_messaging"],expires_at:0}},{appId})};
  return {snapshot:{schemaVersion:1,claim:"ALIAS_VERIFIED",recipient:{kind:"BSUID",value:bsuid},asset,participantId:uuid(6),aliasId:uuid(7),aliasRevision:1},
    conversation_id:uuid(8),participant_id:uuid(6),phone,bsuid,bsuid_alias_id:uuid(7),bsuid_revision:"1",phone_alias_id:uuid(9),phone_revision:"1",
    source_id:uuid(10),source_hash:"c".repeat(64),source_status:"PROCESSED",session_id:uuid(4),phone_id:phoneId,waba_id:wabaId,proof,secret_reference,
    payload:{entry:[{id:wabaId,changes:[{field:"messages",value:{metadata:{phone_number_id:phoneId},
      messages:[{id:"wamid.synthetic",type:"text",from:phone,from_user_id:bsuid,text:{body:"Synthetic"}}],contacts:[{wa_id:phone,user_id:bsuid}]}}]}]}};
}
const client=row=>({query:async(sql,values)=>{
  assert.match(sql,/meta_test_conversation_recipient_link/);assert.deepEqual(values,[input.tenantId,input.connectionId,input.deliveryId]);
  assert.match(sql,/event\.conversation_id=conversation\.id/);
  assert.match(sql,/app\.meta_direct_alias_source_valid/);
  assert.match(sql,/meta_direct_recipient->'testPhoneSender'='true'::jsonb/);
  assert.match(sql,/FOR SHARE OF delivery,conversation,participant,alias,phone,session/);
  return {rows:row?[row]:[],rowCount:row?1:0};
}});

test("guarded BSUID requires current exact snapshot and a jointly signed same-conversation allowlisted phone",async()=>{
  const row=fixture(),link=await resolveMetaTestRecipientLink(client(row),input);
  assert.equal(link.bsuid,bsuid);assert.equal(link.phone,phone);assert.equal(link.conversationId,uuid(8));
  assert.equal(link.phoneAliasRevision,"1");assert.equal(link.sourcePayloadSha256,"c".repeat(64));
  assert.equal(await resolveMetaTestRecipientLink(client(undefined),input),undefined);
  for(const mutate of [
    r=>{r.phone=foreign},r=>{r.snapshot.aliasRevision=2},r=>{r.snapshot.participantId=uuid(99)},
    r=>{r.snapshot.asset.providerSessionId=uuid(99)},r=>{r.snapshot.asset.wabaId="999999"},
    r=>{r.proof.connectionId=uuid(99)},r=>{r.proof.credentialMetadata.appId="999999"},
    r=>{r.payload.entry[0].id="999999"},r=>{r.payload.entry[0].changes[0].value.metadata.phone_number_id="999999"},
    r=>{r.payload.entry[0].changes[0].value.contacts=[]},
    r=>{r.payload.entry[0].changes[0].value.contacts[0].wa_id=foreign},
    r=>{r.payload.entry[0].changes[0].value.contacts.push({wa_id:phone,user_id:bsuid})},
    r=>{r.payload.entry[0].changes[0].value.messages[0].type="system"},
    r=>{r.payload.entry[0].changes[0].value.messages[0].from_user_id="US.forged"},
  ]){
    const changed=fixture();mutate(changed);
    assert.equal(await resolveMetaTestRecipientLink(client(changed),input),undefined);
  }
  assert.equal(await resolveMetaTestRecipientLink(client(fixture()),{...input,scope:parseWahaTestRecipientAllowlist("[]")}),undefined);
});

test("BSUID receipts require an existing exact message and conversation proof, without granting new identity",async()=>{
  const status={id:"wamid.sent",recipient_id:phone,recipient_user_id:bsuid,status:"delivered",timestamp:String(Math.floor(Date.now()/1000))};
  let reads=0;
  const db={query:async(sql,values)=>{
    reads++;
    if(sql.startsWith("SELECT id FROM public.delivery_outbox")){
      assert.deepEqual(values,[input.tenantId,input.connectionId,status.id]);return {rows:[{id:input.deliveryId}],rowCount:1};
    }
    return client(fixture()).query(sql,values);
  }};
  const linked=await resolveMetaTestStatusRecipientLink(db,{...input,status});assert.equal(linked.phone,phone);
  const value={metadata:{phone_number_id:phoneId},statuses:[status]};
  assert.equal(metaTestWebhookUnits(scope,value).values.length,0);
  const projected=metaTestWebhookUnits(scope,value,Date.now(),s=>s===status&&linked!==undefined).values;
  assert.equal(projected.length,1);assert.equal(projected[0].statuses[0].recipient_user_id,bsuid);
  for(const changed of [{...status,recipient_id:foreign},{...status,recipient_user_id:"US.foreign"},
    {...status,recipient_parent_user_id:"US.ENT.parent"},{...status,recipient:bsuid}])
    assert.equal(await resolveMetaTestStatusRecipientLink(db,{...input,status:changed}),undefined);
  assert.equal(await resolveMetaTestStatusRecipientLink({query:async()=>({rows:[],rowCount:0})},{...input,status}),undefined);
  assert(reads>0);
});

test("a policy-selected PHONE snapshot retains the joint link for BSUID-bearing status receipts",async()=>{
  const row=fixture();row.snapshot={...row.snapshot,recipient:{kind:"PHONE",value:phone},aliasId:row.phone_alias_id,
    aliasRevision:Number(row.phone_revision),testPhoneSender:true};
  const link=await resolveMetaTestRecipientLink(client(row),input);assert.equal(link.phone,phone);assert.equal(link.bsuid,bsuid);
  const status={id:"wamid.phone-sent",recipient_id:phone,recipient_user_id:bsuid,status:"delivered"};
  const db={query:async(sql,values)=>sql.startsWith("SELECT id FROM public.delivery_outbox")
    ?{rows:[{id:input.deliveryId}],rowCount:1}:client(row).query(sql,values)};
  assert.equal((await resolveMetaTestStatusRecipientLink(db,{...input,status})).phone,phone);
  row.snapshot.aliasRevision++;
  assert.equal(await resolveMetaTestRecipientLink(client(row),input),undefined);
});

test("a plain PHONE snapshot cannot acquire a TEST joint link or BSUID receipt authority",async()=>{
  const row=fixture();row.snapshot={...row.snapshot,recipient:{kind:"PHONE",value:phone},aliasId:row.phone_alias_id,aliasRevision:1};
  assert.equal(await resolveMetaTestRecipientLink(client(row),input),undefined);
  assert.deepEqual(await metaTestRecipientAdmission(client(row),input),{state:"DENIED"});
  const db={query:async(sql,values)=>sql.startsWith("SELECT id FROM public.delivery_outbox")
    ?{rows:[{id:input.deliveryId}],rowCount:1}:client(row).query(sql,values)};
  assert.equal(await resolveMetaTestStatusRecipientLink(db,{...input,status:{id:"wamid.plain-phone",recipient_user_id:bsuid}}),undefined);
});

test("PHONE and BSUID recheck the joint pin and classify lookup failures before dispatch",async t=>{
  const old={scope:process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,fetch:globalThis.fetch};
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
  t.after(()=>{if(old.scope===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=old.scope;globalThis.fetch=old.fetch});
  const token="synthetic-phone-policy-access-token";
  for(const kind of ["PHONE","BSUID"]){
  for(const phase of ["stable","secret","admission","read-error","admission-read-error"]){
    for(const field of phase==="stable"||phase.endsWith("read-error")?["bsuidAliasRevision"]:["bsuidAliasRevision","bsuidAliasId","sourcePayloadSha256"]){
      const row=fixture();if(kind==="PHONE")row.snapshot={...row.snapshot,recipient:{kind:"PHONE",value:phone},aliasId:row.phone_alias_id,aliasRevision:1,testPhoneSender:true};
      row.proof.credentialFingerprint=createHash("sha256").update(token).digest("hex");
      const pin=await resolveMetaTestRecipientLink(client(row),input);let current={...pin},fetches=0,completed=0,failed,admitted=false;
      const mutate=()=>{current={...current,[field]:field==="bsuidAliasRevision"?"2":field==="bsuidAliasId"?uuid(99):"d".repeat(64)}};
      globalThis.fetch=async(_url,init)=>{fetches++;const wire=JSON.parse(init.body);assert.equal(kind==="PHONE"?wire.to:wire.recipient,kind==="PHONE"?phone:bsuid);assert.equal(Object.hasOwn(wire,kind==="PHONE"?"recipient":"to"),false);return Response.json({messages:[{id:"wamid.phone-current"}]})};
      const repository={metaTestRecipientAdmission:async()=>({state:"READY",link:pin}),metaTestRecipientLink:async()=>{if(phase==="read-error"||(phase==="admission-read-error"&&admitted))throw Error("private database diagnostic");return current},
        beginSend:async()=>true,assertMetaDeliveryContextCurrent:async()=>{},metaInheritedTemplateContext:async()=>null,
        admitMetaMessageRequest:async()=>{admitted=true;if(phase==="admission")mutate()},complete:async()=>{completed++},
        outcomeUnknown:async()=>assert.fail("No ambiguous request"),fail:async(_job,_lease,retryable,detail,_at,_manual,code)=>{failed={retryable,detail,code}}};
      const processor=new DeliveryProcessor(repository,{resolve:async()=>{if(phase==="secret")mutate();return{accessToken:token}}},{metaGraphVersion:"v24.0",metaAppId:appId});
      const job={id:input.deliveryId,tenantId:input.tenantId,connectionId:input.connectionId,provider:"meta",recipientType:"DIRECT",
        metaDirectRecipientSnapshot:row.snapshot,metaCredentialContext:{...row.snapshot.asset,proof:row.proof},connectionSecretReference:row.secret_reference,
        sessionId:phoneId,groupId:phone,articleId:"9",text:"Synthetic",contentType:"text/plain",attempts:1,idempotencyKey:"phone-pin"};
      assert.equal(await processor.deliver(job,"lease"),phase==="stable",`${phase}/${field}`);
      assert.equal(fetches,phase==="stable"?1:0,`${phase}/${field}: no provider fetch after a changed joint pin`);
      assert.equal(completed,phase==="stable"?1:0);
      if(phase.endsWith("read-error"))assert.deepEqual(failed,{retryable:true,detail:"The test recipient identity could not be checked.",code:"META_TEST_RECIPIENT_UNAVAILABLE"});
      else if(phase!=="stable")assert.deepEqual(failed,{retryable:false,detail:kind==="BSUID"&&phase==="secret"?"The recipient is outside the configured test scope.":"The test recipient identity is unavailable.",code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
    }
  }
  }
});

test("a policy-selected PHONE waits for the same completed producer before effects",async t=>{
  const row=fixture();row.source_status="PROCESSING";
  row.snapshot={...row.snapshot,recipient:{kind:"PHONE",value:phone},aliasId:row.phone_alias_id,aliasRevision:1,testPhoneSender:true};
  assert.deepEqual(await metaTestRecipientAdmission(client(row),input),{state:"PENDING"});
  const old=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
  t.after(()=>{if(old===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=old});
  const effects=[],deferred=[];
  const processor=new DeliveryProcessor({metaTestRecipientAdmission:async()=>({state:"PENDING"}),
    deferMetaTestRecipient:async job=>deferred.push(job.id),beginSend:async()=>effects.push("send"),fail:async()=>effects.push("fail")},
    {resolve:async()=>{effects.push("secret");throw Error("Unexpected read")}}, {metaGraphVersion:"v24.0"});
  const job={id:input.deliveryId,tenantId:input.tenantId,connectionId:input.connectionId,provider:"meta",recipientType:"DIRECT",
    metaDirectRecipientSnapshot:row.snapshot,groupId:phone,text:"Synthetic",attempts:1,idempotencyKey:"synthetic"};
  assert.equal(await processor.deliver(job,"lease"),false);assert.deepEqual(deferred,[job.id]);assert.deepEqual(effects,[]);
});

test("a fully verified but still-processing source defers before all effects and never authorizes",async t=>{
  const row=fixture();row.source_status="PROCESSING";
  assert.equal(await resolveMetaTestRecipientLink(client(row),input),undefined);
  assert.deepEqual(await metaTestRecipientAdmission(client(row),input),{state:"PENDING"});
  row.phone=foreign;
  assert.deepEqual(await metaTestRecipientAdmission(client(row),input),{state:"DENIED"});
  const old=process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);
  t.after(()=>{if(old===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=old});
  const effects=[],deferred=[];
  const processor=new DeliveryProcessor({metaTestRecipientAdmission:async()=>({state:"PENDING"}),
    deferMetaTestRecipient:async(job,lease)=>deferred.push([job.id,lease]),
    beginSend:async()=>effects.push("begin"),fail:async()=>effects.push("fail")},
    {resolve:async()=>{effects.push("secret");throw new Error("Unexpected secret read")}},
    {metaGraphVersion:"v24.0"},8,{prepare:async()=>effects.push("media")});
  const job={id:input.deliveryId,tenantId:input.tenantId,connectionId:input.connectionId,provider:"meta",recipientType:"DIRECT",
    metaDirectRecipientSnapshot:fixture().snapshot,groupId:phone,ticketId:"42",text:"Synthetic",contentType:"text/plain",attempts:1,idempotencyKey:"synthetic"};
  assert.equal(await processor.deliver(job,"synthetic-lease"),false);
  assert.deepEqual(deferred,[[job.id,"synthetic-lease"]]);assert.deepEqual(effects,[]);
});

test("adapter keeps BSUID wire identity and rechecks server-private authorization after async work",async t=>{
  const saved={scope:process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,fetch:globalThis.fetch,warn:console.warn};
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);console.warn=()=>{};
  t.after(()=>{if(saved.scope===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=saved.scope;globalThis.fetch=saved.fetch;console.warn=saved.warn});
  const sent=[];globalThis.fetch=async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({messages:[{id:"wamid.sent"}]})};
  let allowed=true;
  const config={accessToken:"synthetic-private-token",graphVersion:"v24.0",phoneNumberIdFor:()=>phoneId,baseUrl:"https://graph.test",
    authorizeTestRecipient:async value=>allowed&&value===bsuid?phone:undefined};
  const body={connectionId:uuid(2),groupId:phone,recipientType:"DIRECT",metaDirectRecipient:{kind:"BSUID",value:bsuid},text:"Synthetic",idempotencyKey:"synthetic"};
  const variants=[{}, {choices:{options:[{id:"synthetic",label:"Synthetic"}]}},
    {template:{name:"synthetic_template",languageCode:"en_US",bodyParameters:["Synthetic"]}},
    {flow:{id:"12345678",token:"synthetic-flow-token",buttonLabel:"Open",data:{}}},
    {media:{bytes:new Uint8Array([1]),mimeType:"image/png",filename:"synthetic.png",providerMediaId:"synthetic-media"}}];
  for(const variant of variants)await new MetaGroupsAdapter(config).send({...body,...variant});
  assert.equal(sent.length,variants.length);assert.equal(sent[0].recipient,bsuid);assert.equal(Object.hasOwn(sent[0],"to"),false);
  await assert.rejects(new MetaGroupsAdapter({...config,authorizeTestRecipient:undefined}).send(body),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  await assert.rejects(new MetaGroupsAdapter({...config,authorizeTestRecipient:async()=>foreign}).send(body),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  await assert.rejects(new MetaGroupsAdapter({...config,beforeMessageSend:async()=>{allowed=false}}).send(body),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  assert.equal(sent.length,variants.length);
  allowed=true;
  await assert.rejects(new MetaGroupsAdapter({...config,beforeRequest:async()=>{allowed=false}}).prepareMedia({
    ...body,media:{bytes:new Uint8Array([1]),mimeType:"image/png",filename:"synthetic.png"},
  }),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  assert.equal(sent.length,variants.length);
  for(const mutate of [b=>{b.recipient="US.foreign"},b=>{b.to=phone},b=>{b.recipient_type="group"}]){
    const wire={recipient_type:"individual",recipient:bsuid};
    const racing=new MetaGroupsAdapter({...config,authorizeTestRecipient:async()=>{mutate(wire);return phone}});
    await assert.rejects(racing.request(`/${phoneId}/messages`,{method:"POST",body:wire},"mutation",true),{code:"META_TEST_RECIPIENT_NOT_ALLOWED"});
  }
  assert.equal(sent.length,variants.length);
});

test("inbox transaction refuses a BSUID link changed after signed status projection",async t=>{
  const saved={scope:process.env.WASALX_TEST_RECIPIENT_ALLOWLIST,app:process.env.META_APP_ID};
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=JSON.stringify([phone]);process.env.META_APP_ID=appId;
  t.after(()=>{for(const [key,value]of[["WASALX_TEST_RECIPIENT_ALLOWLIST",saved.scope],["META_APP_ID",saved.app]]){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }});
  const before=await resolveMetaTestRecipientLink(client(fixture()),input);
  let inserts=0;
  const changed=fixture();changed.phone_revision="2";
  const rows=value=>({rows:value,rowCount:value.length});
  const transaction={query:async(sql,values)=>{
    if(sql.includes("lock_current_active_tenant_for_event_admission"))return rows([{active:true}]);
    if(sql.includes("pg_advisory_xact_lock"))return rows([]);
    if(sql.startsWith("SELECT id,event_type,payload_sha256 FROM event_inbox"))return rows([]);
    if(sql.startsWith("SELECT provider,engine,state FROM connections"))return rows([{provider:"META",engine:"CLOUD_API",state:"WORKING"}]);
    if(sql.startsWith("SELECT state FROM webhook_routes"))return rows([{state:"ACTIVE"}]);
    if(sql.startsWith("SELECT id,state,opaque_session_id"))return rows([{id:uuid(4),state:"WORKING",opaque_session_id:phoneId,waba_id:wabaId}]);
    if(sql.startsWith("SELECT id FROM public.delivery_outbox"))return rows([{id:input.deliveryId}]);
    if(sql.includes("meta_test_conversation_recipient_link"))return client(changed).query(sql,values);
    if(sql.startsWith("INSERT INTO event_inbox")){inserts++;return rows([{id:uuid(99)}]);}
    if(sql.startsWith("UPDATE connections SET"))return rows([]);
    throw new Error("Unexpected transaction query: "+sql.slice(0,70));
  }};
  const database=Object.create(DatabaseService.prototype);
  database.withTenant=async(tenant,work)=>{assert.equal(tenant,input.tenantId);return work(transaction)};
  const status={id:"wamid.sent",recipient_id:phone,recipient_user_id:bsuid,status:"delivered",timestamp:String(Math.floor(Date.now()/1000))};
  const event={providerEventId:"status:test:v1:synthetic",eventType:"message.status",payload:{entry:[{changes:[{value:{statuses:[status]}}]}]},
    payloadSha256:"d".repeat(64),routeKey:phoneId,providerSessionKey:phoneId,providerEngine:"CLOUD_API",metaTestRecipientLink:before};
  await assert.rejects(database.acceptWebhookEvent({tenant_id:input.tenantId,connection_id:input.connectionId,provider:"META",hmac_secret_reference:"secret://synthetic/webhook"},event),{status:404});
  assert.equal(inserts,0,"Changed proof is rejected before persistence, not after receipt processing");
  for(const raw of [undefined,"","[]"]){
    if(raw===undefined)delete process.env.WASALX_TEST_RECIPIENT_ALLOWLIST;else process.env.WASALX_TEST_RECIPIENT_ALLOWLIST=raw;
    await assert.rejects(database.acceptWebhookEvent({tenant_id:input.tenantId,connection_id:input.connectionId,provider:"META",hmac_secret_reference:"secret://synthetic/webhook"},event),{status:404});
    assert.equal(inserts,0);
  }
  process.env.WASALX_TEST_RECIPIENT_ALLOWLIST="*";
  assert.equal((await database.acceptWebhookEvent({tenant_id:input.tenantId,connection_id:input.connectionId,provider:"META",hmac_secret_reference:"secret://synthetic/webhook"},event)).duplicate,false);
  assert.equal(inserts,1);
});
