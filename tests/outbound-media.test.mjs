import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { renderOutboundText } from "../packages/core/dist/outbound-text.js";
import { groupWorkspaceMediaCapabilities } from "../packages/core/dist/provider-media-capabilities.js";
import { signServiceJwt } from "../services/connector-worker/dist/packages/core/src/service-auth.js";
import { DefaultBotMediaUploadPipeline, DefaultOutboundMediaPipeline, MediaRuntimeError, S3MediaStorage } from "../services/connector-worker/dist/services/connector-worker/src/media-runtime.js";
import { OutboxRepository } from "../services/connector-worker/dist/services/connector-worker/src/repository.js";
import { DeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";
import { ServiceAuthService } from "../services/control-api/dist/service-auth.service.js";
import { ZammadInternalController, queueOutboundParts } from "../services/control-api/dist/zammad-internal.controller.js";

const tenantId="10000000-0000-4000-8000-000000000001";
const instanceId="11000000-0000-4000-8000-000000000001";
const serviceSecret="outbound-media-service-secret-at-least-32-bytes";
const serviceSecretReference=`secret://tenants/${tenantId}/zammad/service`;
const png=Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const wahaAssignment={providerBaseUrl:"http://waha-gows.internal:3000/",wahaWorkerId:"30000000-0000-4000-8000-000000000001",wahaAssignmentFencingToken:7,wahaAssignmentLeaseExpiresAt:"2026-08-09T23:59:59.000Z"};

test("outbound text handles breaks, malformed tags, and one layer of entities", () => {
  const render = text => renderOutboundText({ text, contentType: "text/html" });
  assert.equal(render("<p>Hello&nbsp;there<BR  /><em>friend</em></P >"), "Hello there\nfriend\n");
  assert.equal(render("&AMP;&lt;&gt;&quot;&#39; &amp;lt; &amp;quot;"), "&<>\"' &lt; &quot;");
  assert.equal(render("Price < 5 today"), "Price < 5 today");
  assert.equal(render("<p>Price < 5 &amp; rising"), "Price < 5 & rising");
  const unfinishedBreak = "Message<br" + "\t".repeat(30_000);
  assert.equal(render(unfinishedBreak), unfinishedBreak);
  const unmatched = "Message" + "<".repeat(30_000);
  assert.equal(render(unmatched), unmatched);
});

test("Zammad outbound preflight rejects repeated destination query values", async () => {
  const controller = new ZammadInternalController(
    { rows: async () => [{ id: instanceId }] },
    { verify: async () => ({ tenantId, instanceId, userId: "agent" }) },
  );
  const group = "447700900005@g.us";
  for (const [connectionId, groupId, ticketId, message] of [
    [[instanceId], group, "42", "WhatsApp destination is invalid"],
    [instanceId, [group], "42", "WhatsApp destination is invalid"],
    [instanceId, group, ["42"], "Ticket ID is invalid"],
  ]) {
    await assert.rejects(controller.outboundPreflight(undefined, connectionId, groupId, ticketId), { status: 400, message });
  }
});

test("nonmedia bot and ticket-event history respect lease fences and exclude human replies",async()=>{
  for(const scenario of ["send-denied","lease-lost","ticket-event-lease-lost","human","choices-send-denied","choices-lease-lost"]){
    const job={id:"text-fence",tenantId,connectionId:"c1",botConversationId:"conversation",directOrigin:scenario==="human"?"HUMAN":"BOT",recipientType:"DIRECT",groupId:"12025550102@c.us",ticketId:"42",text:"Reply",contentType:"text/plain",idempotencyKey:"fenced-text",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30};
    if(scenario.startsWith("choices-"))job.choices={options:[{id:"support",label:"الدعم"}]};
    if(scenario==="ticket-event-lease-lost")Object.assign(job,{botConversationId:undefined,directOrigin:undefined,recipientType:"GROUP",groupId:"120363000000001@g.us",ticketEventExecutionId:"closed-event"});
    let sends=0;
    const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[job],claimStatuses:async()=>[],beginSend:async()=>!scenario.endsWith("send-denied"),renewDeliveryLease:async()=>false,complete:async()=>{},fail:async()=>assert.fail("unexpected failure"),linkBotArticle:async()=>assert.fail("must not project")};
    const original=globalThis.fetch;
    globalThis.fetch=async input=>{assert.ok(String(input).includes("waha-gows.internal"),"must not call Zammad");sends++;return Response.json({id:"sent-human"})};
    try{
      await new DeliveryProcessor(repository,{resolve:async reference=>{assert.equal(reference,"secret://connection");return{apiKey:"waha-key"}}},{metaGraphVersion:"v24.0"}).drainTenant(tenantId);
      assert.equal(sends,scenario==="human"?1:0);
    }finally{globalThis.fetch=original}
  }
});

test("ordered bot projection recovers an orphan media article without duplicate sends",async()=>{
  const base={tenantId,connectionId:"c1",botConversationId:"conversation",directOrigin:"BOT",recipientType:"DIRECT",groupId:"12025550102",ticketId:"42",contentType:"text/plain",attempts:1,provider:"meta",metaDirectRecipientSnapshot:{schemaVersion:1,claim:"LEGACY_PHONE_CONTEXT",recipient:{kind:"PHONE",value:"12025550102"},asset:{providerSessionId:"70000000-0000-4000-8000-000000000001",phoneNumberId:"123456789",wabaId:"987654321"}},sessionId:"123456789",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30};
  const jobs=[
    {...base,id:"template",idempotencyKey:"bot:conversation:event:0",text:"Template history",template:{name:"hello_world",languageCode:"en_US",bodyParameters:[]}},
    {...base,id:"media",idempotencyKey:"bot:conversation:event:1",text:"Media history",media:{id:"dm",botMediaAssetId:"asset",mediaObjectId:"object",filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"READY"}},
    {...base,id:"choices",idempotencyKey:"bot:conversation:event:2",text:"Choose",choices:{options:[{id:"agent",label:"Talk to an agent"}]}},
  ];
  base.metaCredentialContext={providerSessionId:"52000000-0000-4000-8000-000000000001",phoneNumberId:base.sessionId,wabaId:"987654321",proof:null};
  jobs.forEach(job=>{job.metaCredentialContext=base.metaCredentialContext;});
  jobs.forEach((job,index)=>{job.createdAt=new Date(1700000000000+index).toISOString()});
  const articles=[],sends=[],admissions=[],done=new Set(),linked=new Map();let loseLink=true;
  const repository={claimBotActions:async()=>[],claimStatuses:async()=>[],claimDeliveries:async()=>jobs.filter(job=>!done.has(job.id)).map(job=>({...job,articleId:linked.get(job.id)})),beginSend:async()=>true,renewDeliveryLease:async()=>true,
    assertMetaDeliveryContextCurrent:async job=>{assert.deepEqual(job.metaCredentialContext,base.metaCredentialContext);},
    assertMetaBillingSendCurrent:async(job,lease)=>{assert(jobs.some(value=>value.id===job.id));assert.equal(typeof lease,"string");},
    metaInheritedTemplateContext:async(job,lease)=>{assert(jobs.some(value=>value.id===job.id));assert.equal(typeof lease,"string");return null;},
    whatsAppMarketingOptedOut:async job=>{assert.equal(job.id,"template");return false;},
    admitMetaMessageRequest:async(job,lease,requestSha,_runtime,phoneId,templateProof)=>{assert.equal(typeof lease,"string");assert.match(requestSha,/^[a-f0-9]{64}$/u);assert.equal(phoneId,base.sessionId);assert.equal(templateProof,null);admissions.push(job.id);},
    linkBotArticle:async(job,_lease,id)=>{if(job.id==="media"&&loseLink){loseLink=false;throw new Error("interrupted durable link")}linked.set(job.id,id)},
    linkProviderMedia:async()=>{},complete:async job=>done.add(job.id),fail:async(job,_lease,retryable,detail)=>{assert.equal(job.id,"media",detail);assert.equal(retryable,true);assert.match(detail,/Bot media article state could not be persisted/)},outcomeUnknown:async()=>assert.fail("no uncertain provider outcome")};
  const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=String(input),body=init?.body&&typeof init.body==="string"?JSON.parse(init.body):undefined;
    if(url.includes("/ticket_articles/by_ticket/"))return Response.json(articles);
    if(url.endsWith("/ticket_articles")){const article={...body,id:articles.length+1};articles.push(article);return Response.json(article)}
    if(url.endsWith("/media"))return Response.json({id:"provider-media"});
    if(url.endsWith("/messages")){sends.push(body.type);return Response.json({messages:[{id:`wamid.${sends.length}`} ]})}
    throw new Error(`Unexpected request ${url}`);
  };
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{accessToken:"synthetic-meta-token-for-test"}:{token:"zammad-token"}},{metaGraphVersion:"v24.0"},8,{prepare:async()=>({bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"object",newlyLinked:false})});
    await processor.drainTenant(tenantId);
    assert.deepEqual(sends,["template"]);
    await processor.drainTenant(tenantId);
    assert.deepEqual(sends,["template","image","interactive"]);
    assert.deepEqual(admissions,["template","media","choices"]);
    assert.deepEqual(articles.map(article=>article.body),["Template history","Media history","Choose\n1. Talk to an agent"]);
    assert.equal(new Set(articles.map(article=>article.preferences.wasalx_bot_delivery_key)).size,3);
    assert.equal(done.size,3);
  }finally{globalThis.fetch=original}
});
const mediaRepository=(overrides={})=>({findByHash:async()=>null,reserve:async record=>({...record,scanState:"STAGING"}),promote:async record=>record,...overrides});

async function serviceToken(){const now=Math.floor(Date.now()/1000);return signServiceJwt({iss:"wasalx-zammad",aud:"wasalx-control",sub:instanceId,tenant_id:tenantId,instance_id:instanceId,scope:"zammad:outbound",iat:now,exp:now+120,jti:crypto.randomUUID(),zammad_user_id:"7",zammad_group_ids:["4"],zammad_group_admin:false},serviceSecret)}
function serviceAuth(){return new ServiceAuthService({rows:async(id,sql,values)=>{assert.equal(id,tenantId);if(sql.includes("FROM native_membership_projections")){assert.deepEqual(values,[tenantId,instanceId,"7"]);return[]}assert.match(sql,/service_secret_reference/);return values[1]===instanceId?[{id:instanceId,tenant_id:tenantId,service_secret_reference:serviceSecretReference}]:[]}},{resolveSigningSecret:async(reference,owner)=>{assert.equal(reference,serviceSecretReference);assert.deepEqual(owner,{tenantId,instanceId});return serviceSecret}})}

test("migration 0015 keeps outbound bytes out of PostgreSQL and enforces tenant-owned media links",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0015_outbound_media.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE delivery_media/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, delivery_id\)/);
  assert.match(sql,/FOREIGN KEY \(tenant_id, media_object_id\)/);
  assert.match(sql,/ALTER TABLE delivery_media FORCE ROW LEVEL SECURITY/);
  assert.match(sql,/CREATE POLICY tenant_isolation ON delivery_media/);
  assert.match(sql,/batch_sequence/);
  assert.match(sql,/request_sha256/);
  assert.match(sql,/manual_retry_allowed/);
  assert.match(sql,/blocked_by_delivery_id/);
  assert.doesNotMatch(sql,/\bbytea\b|signed_url|public_url|access_token|secret_access/i);
});

test("migration 0089 gives group workspace media one immutable Zammad upload source",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0089_group_workspace_media.sql",import.meta.url),"utf8");
  assert.match(sql,/zammad_upload_id uuid/);
  assert.match(sql,/delivery_media_source_check/);
  assert.match(sql,/zammad_attachment_id IS NOT NULL[\s\S]*OR[\s\S]*zammad_upload_id IS NOT NULL/);
  assert.match(sql,/delivery_media_workspace_upload_unique/);
});

test("migration 0090 keeps group mentions bounded on the durable delivery",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0090_group_workspace_mentions.sql",import.meta.url),"utf8");
  assert.match(sql,/ADD COLUMN mentions text\[\] NOT NULL DEFAULT/);
  assert.match(sql,/cardinality\(input_values\) <= 20/);
  assert.match(sql,/count\(DISTINCT value\)/);
  assert.match(sql,/@\(c\\\.us\|s\\\.whatsapp\\\.net\)/);
});

test("migration 0093 snapshots configurable agent identity placement",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0093_agent_identity_placement.sql",import.meta.url),"utf8");
  assert.match(sql,/group_bindings[\s\S]*agent_identity_placement[\s\S]*HEADER[\s\S]*FOOTER[\s\S]*OFF/);
  assert.match(sql,/delivery_outbox[\s\S]*agent_identity_placement_snapshot/);
});

test("batch failures durably block and status every later mutation, then resume exactly one successor",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0015_outbound_media.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE TRIGGER delivery_outbox_batch_transition/);
  assert.match(sql,/NEW\.state IN \('FAILED_TERMINAL','OUTCOME_UNKNOWN'\)[\s\S]*SET state = 'BLOCKED'[\s\S]*successor\.batch_sequence > NEW\.batch_sequence/);
  assert.match(sql,/SELECT tenant_id, id, zammad_ticket_id, 'BLOCKED'/);
  assert.match(sql,/NEW\.state IN \('SENT','DELIVERED','READ'\)[\s\S]*SET state = 'QUEUED'[\s\S]*successor\.batch_sequence = NEW\.batch_sequence \+ 1/);
  assert.match(sql,/delivery_outbox_manual_retry_check[\s\S]*NOT manual_retry_allowed OR state = 'FAILED_TERMINAL'/);
});

test("claiming keeps disconnected deliveries queued and applies the strictest opted-in group media retention",async()=>{
  const [claimSql,schedulerSql,repository,inboundRepository]=await Promise.all([
    readFile(new URL("../services/control-api/migrations/0014_delivery_outcome_fencing.sql",import.meta.url),"utf8"),
    readFile(new URL("../services/control-api/migrations/0015_outbound_media.sql",import.meta.url),"utf8"),
    readFile(new URL("../services/connector-worker/src/repository.ts",import.meta.url),"utf8"),
    readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8"),
  ]);
  for(const sql of [claimSql,schedulerSql]){
    assert.match(sql,/connection\.state = 'WORKING'/);
    assert.match(sql,/binding\.state = 'ACTIVE'/);
    assert.match(sql,/session\.ownership_state = 'ACTIVE'[\s\S]*session\.state = 'WORKING'/);
    assert.match(sql,/zammad\.state = 'WORKING'/);
  }
  assert.match(schedulerSql,/delivery\.state = 'SENDING' AND delivery\.lease_expires_at < now\(\)[\s\S]*OR \([\s\S]*delivery\.state IN \('QUEUED','FAILED_RETRYABLE'\)/);
  assert.match(repository,/JOIN zammad_instances z ON z\.tenant_id=d\.tenant_id AND z\.state='WORKING'/);
  assert.match(repository,/SELECT media_days FROM retention_policies WHERE tenant_id=\$1[\s\S]*if\(!retention\)return\[\]/);
  assert.match(repository,/JOIN tenant_settings tenant ON tenant\.tenant_id=d\.tenant_id/);
  assert.match(repository,/LEFT JOIN group_workspace_settings workspace[\s\S]*workspace\.whatsapp_group_id=COALESCE\(workspace_group\.id,g\.id\)/);
  assert.match(repository,/LEAST\([\s\S]*COALESCE\(b\.retention_days,rp\.media_days\),[\s\S]*rp\.media_days,[\s\S]*tenant\.group_workspace_enabled AND workspace\.capture_enabled[\s\S]*workspace\.retention_days[\s\S]*\) AS retention_days/);
  assert.match(inboundRepository,/LEAST\([\s\S]*b\.retention_days,[\s\S]*retention\.media_days,[\s\S]*settings\.group_workspace_enabled AND workspace\.capture_enabled[\s\S]*workspace\.retention_days[\s\S]*\) AS retention_days/);
  assert.match(inboundRepository,/LEAST\(workspace\.retention_days,retention\.media_days\) AS media_days/);
  assert.match(inboundRepository,/JOIN retention_policies retention ON retention\.tenant_id=group_record\.tenant_id/);
});

test("media-only Zammad articles keep agent attribution while adding the public identity only once",async()=>{
  const deliveries=[];const media=[];let deliveryNumber=0;
  const client={query:async(sql,values=[])=>{
    // This owned native ticket has ordinary message links but no case graph.
    if(sql.includes("SELECT pg_advisory_xact_lock")){if(sql.includes("FROM zammad_instances"))assert.deepEqual(values,[tenantId,"42",null]);else assert.equal(values[0],`ticket-outbound:${tenantId}:42`);return{rows:[],rowCount:1};}
    if(sql.includes("SELECT execution.id FROM ticket_event_executions execution"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT reply_to_message_id FROM delivery_outbox"))return{rows:[]};
    if(sql.includes("SELECT link.external_message_id"))return{rows:[]};
    if(sql.includes("FROM case_correlations correlation")||sql.includes("SELECT id FROM case_correlations"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT c.id AS connection_id"))return{rows:[{connection_id:"12000000-0000-4000-8000-000000000001",binding_id:"13000000-0000-4000-8000-000000000001",group_workspace_group_id:null,bot_conversation_id:null,external_chat_id:null,provider:"WAHA",agent_prefix:"Support:",agent_identity_placement:"FOOTER",media_enabled:true}]};
    if(sql.includes("FROM delivery_outbox delivery LEFT JOIN delivery_media"))return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO delivery_outbox")){deliveryNumber+=1;deliveries.push({sql,values});return{rows:[{id:`20000000-0000-4000-8000-00000000000${deliveryNumber}`,state:"QUEUED"}]}}
    if(sql.includes("INSERT INTO delivery_media")){media.push(values);return{rows:[]}}
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const database={rows:async(_tenant,sql)=>sql.includes("FROM zammad_instances")?[{id:instanceId}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const wakes=[];const controller=new ZammadInternalController(database,serviceAuth(),{wake:async tenant=>wakes.push(tenant)});
  const response=await controller.outbound(`Bearer ${await serviceToken()}`,{
    tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",group_id:"447700900005@g.us",ticket_id:42,article_id:9,
    body:"",content_type:"text/plain",idempotency_key:`zammad:${tenantId}:${instanceId}:42:9`,internal:false,
    agent:{id:"7",display_name:"Layla Agent"},
    attachments:[
      {id:"19",filename:"proof.png",content_type:"image/png",size:String(png.length)},
      {id:"20",filename:"invoice.pdf",content_type:"application/pdf",size:"1200"},
    ],
  });
  assert.equal(response.id,"20000000-0000-4000-8000-000000000001");
  assert.equal(deliveries.length,3);assert.equal(media.length,2);
  assert.equal(deliveries[0].values[13],"Layla Agent");
  assert.equal(deliveries[0].values[14],"Support:");
  assert.equal(deliveries[0].values[21],"FOOTER");
  assert.equal(deliveries[1].values[13],"Layla Agent");assert.equal(deliveries[1].values[14],null);assert.equal(deliveries[1].values[21],"OFF");
  assert.equal(deliveries[2].values[13],"Layla Agent");assert.equal(deliveries[2].values[14],null);assert.equal(deliveries[2].values[21],"OFF");
  assert.equal(deliveries[0].values[16],0);assert.equal(deliveries[1].values[16],1);assert.equal(deliveries[2].values[16],2);
  assert.equal(deliveries[0].values[17],3);assert.equal(deliveries[1].values[17],3);assert.equal(deliveries[2].values[17],3);
  assert.equal(deliveries[0].values[11],`zammad:${tenantId}:${instanceId}:42:9`);
  assert.match(deliveries[1].values[11],/^wasalx-media:[0-9a-f]{64}$/);
  assert.match(deliveries[2].values[11],/^wasalx-media:[0-9a-f]{64}$/);
  assert.notEqual(deliveries[1].values[11],deliveries[2].values[11]);
  assert.deepEqual(wakes,[tenantId]);
});

test("outbound idempotency fingerprints attachment order and descriptors instead of accepting a changed replay",async()=>{
  let replay=false;let requestHash;let sequence=0;
  const client={query:async(sql,values=[])=>{
    // This owned native ticket has ordinary message links but no case graph.
    if(sql.includes("SELECT pg_advisory_xact_lock")){if(sql.includes("FROM zammad_instances"))assert.deepEqual(values,[tenantId,"42",null]);else assert.equal(values[0],`ticket-outbound:${tenantId}:42`);return{rows:[],rowCount:1};}
    if(sql.includes("SELECT execution.id FROM ticket_event_executions execution"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT reply_to_message_id FROM delivery_outbox"))return{rows:replay?[{reply_to_message_id:null}]:[]};
    if(sql.includes("SELECT link.external_message_id"))return{rows:[]};
    if(sql.includes("FROM case_correlations correlation")||sql.includes("SELECT id FROM case_correlations"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT c.id AS connection_id"))return{rows:[{connection_id:"12000000-0000-4000-8000-000000000001",binding_id:"13000000-0000-4000-8000-000000000001",group_workspace_group_id:null,bot_conversation_id:null,external_chat_id:null,provider:"WAHA",agent_prefix:"Support:",agent_identity_placement:"HEADER",media_enabled:true}]};
    if(sql.includes("INSERT INTO delivery_outbox")){if(replay)return{rows:[]};requestHash??=values[12];sequence+=1;return{rows:[{id:`21000000-0000-4000-8000-00000000000${sequence}`,state:"QUEUED"}]}}
    if(sql.includes("INSERT INTO delivery_media"))return{rows:[]};
    if(sql.includes("delivery.request_sha256"))return{rows:replay?[{id:"21000000-0000-4000-8000-000000000001",state:"QUEUED",request_sha256:requestHash}]:[]};
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const database={rows:async(_tenant,sql)=>sql.includes("FROM zammad_instances")?[{id:instanceId}]:[],withTenant:async(_tenant,operation)=>operation(client)};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{}});
  const payload={tenant_id:tenantId,connection_id:"12000000-0000-4000-8000-000000000001",group_id:"447700900005@g.us",ticket_id:42,article_id:10,body:"Attached",content_type:"text/plain",idempotency_key:`zammad:${tenantId}:${instanceId}:42:10`,internal:false,agent:{id:"7",display_name:"Layla Agent"},attachments:[{id:"19",filename:"proof.png",content_type:"image/png",size:String(png.length)}]};
  const authorization=`Bearer ${await serviceToken()}`;
  await controller.outbound(authorization,payload);
  replay=true;
  assert.deepEqual(await controller.outbound(authorization,payload),{id:"21000000-0000-4000-8000-000000000001",state:"QUEUED"});
  await assert.rejects(()=>controller.outbound(authorization,{...payload,attachments:[{...payload.attachments[0],size:String(png.length+1)}]}),/different outbound article/i);
});

test("worker enters the durable send boundary before staging media and sends WAHA base64 without a URL",async()=>{
  const delivery={id:"d-media",tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",ticketId:"42",articleId:"9",text:"",contentType:"image/png",idempotencyKey:"idem-media",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",agentPrefix:"Support:",agentDisplayName:"Layla",mediaEnabled:true,retentionDays:30,media:{id:"dm1",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const calls=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async(_job,_lease,id)=>calls.push(`link:${id}`),renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async()=>{},beginSend:async()=>{calls.push("begin");return true},complete:async()=>calls.push("complete"),fail:async()=>calls.push("fail"),outcomeUnknown:async()=>calls.push("unknown"),claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const pipeline={prepare:async(_job,token)=>{assert.equal(token,"zammad-token");calls.push("stage");return{bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"mo1",newlyLinked:true}}};
  const originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(input,init)=>{request={url:String(input),body:JSON.parse(String(init?.body))};return new Response(JSON.stringify({id:"waha-media-1"}),{status:200})};
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,pipeline);
    assert.deepEqual(await processor.drainTenant(tenantId),{actions:0,deliveries:1,statuses:0});
  }finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,["begin","stage","link:mo1","complete"]);
  assert.match(request.url,/\/api\/sendImage$/);
  assert.equal(request.body.caption,"Support: Layla");
  assert.equal(request.body.file.data,Buffer.from(png).toString("base64"));
  assert.equal(request.body.file.url,undefined);
});

test("a retried direct bot media delivery reuses exactly one Zammad attachment article",async()=>{
  const delivery={id:"d-bot-media",tenantId,connectionId:"c1",groupBindingId:"b1",botConversationId:"bot-conversation-1",directOrigin:"BOT",recipientType:"DIRECT",groupId:"12025550102@c.us",ticketId:"42",text:"Shipment proof",contentType:"image/png",idempotencyKey:"idem-bot-media",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm-bot",botMediaAssetId:"asset-1",mediaObjectId:"mo1",filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"READY"}};
  const linkedArticles=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[{...delivery,media:{...delivery.media}}],linkMediaObject:async()=>{},renewDeliveryLease:async()=>true,linkBotArticle:async(_job,_lease,articleId)=>linkedArticles.push(articleId),linkProviderMedia:async()=>{},failMedia:async()=>{},beginSend:async()=>true,complete:async()=>{},fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const pipeline={prepare:async()=>({bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"mo1",newlyLinked:false})};
  const originalFetch=globalThis.fetch;let article;let articleCreates=0;let providerSends=0;
  globalThis.fetch=async(input,init)=>{const url=String(input);
    if(url.endsWith("/api/v1/ticket_articles/by_ticket/42"))return new Response(JSON.stringify(article?[article]:[]),{status:200});
    if(url.endsWith("/api/v1/ticket_articles")&&init?.method==="POST"){articleCreates+=1;const body=JSON.parse(String(init.body));assert.equal(body.ticket_id,42);assert.equal(body.attachments[0].data,Buffer.from(png).toString("base64"));article={id:99,preferences:body.preferences};return new Response(JSON.stringify(article),{status:200})}
    if(url.endsWith("/api/sendImage")){providerSends+=1;return new Response(JSON.stringify({id:`waha-bot-media-${providerSends}`}),{status:200})}
    throw new Error(`Unexpected request: ${url}`);
  };
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{metaGraphVersion:"v24.0"},8,pipeline);
    await processor.drainTenant(tenantId);await processor.drainTenant(tenantId);
  }finally{globalThis.fetch=originalFetch}
  assert.equal(articleCreates,1);assert.equal(providerSends,2);assert.deepEqual(linkedArticles,["99","99"]);
});

test("an expired delivery lease prevents any Zammad or provider side effect",async()=>{
  const delivery={id:"d-expired-lease",tenantId,connectionId:"c1",botConversationId:"bot-conversation-1",directOrigin:"BOT",recipientType:"DIRECT",groupId:"12025550102@c.us",ticketId:"42",text:"Proof",contentType:"image/png",idempotencyKey:"expired-lease",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm-expired",botMediaAssetId:"asset-1",mediaObjectId:"mo1",filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"READY"}};
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async()=>{},renewDeliveryLease:async()=>false,linkBotArticle:async()=>{throw new Error("must not link")},beginSend:async()=>{throw new Error("must not send")},fail:async()=>{},claimStatuses:async()=>[]};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("lease loss must precede external calls")};
  try{assert.deepEqual(await new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{metaGraphVersion:"v24.0"},8,{prepare:async()=>({bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"mo1",newlyLinked:false})}).drainTenant(tenantId),{actions:0,deliveries:1,statuses:0})}finally{globalThis.fetch=originalFetch}
});

test("direct upload pipeline persists clean completion and terminal digest failure",async()=>{
  const digest=createHash("sha256").update(png).digest("hex");const completed=[];const failed=[];
  const repository={...mediaRepository(),mediaAssetUpload:async(requestTenantId,assetId)=>{assert.equal(requestTenantId,tenantId);assert.match(assetId,/^asset-(?:clean|bad)$/u);return{filename:"proof.png",mimeType:"image/png",byteSize:png.length,retentionDays:30,contentSha256:digest}},completeMediaAssetUpload:async(requestTenantId,assetId,objectId)=>{assert.equal(requestTenantId,tenantId);completed.push([assetId,objectId])},failMediaAssetUpload:async(requestTenantId,assetId,error)=>{assert.equal(requestTenantId,tenantId);failed.push([assetId,error])}};
  const pipeline=new DefaultBotMediaUploadPipeline({scan:async()=>({state:"CLEAN",engine:"clamav"})},{put:async()=>{},signedUrl:async()=>{throw new Error("upload must stay private")}},repository);
  assert.deepEqual(await pipeline.upload({tenantId,assetId:"asset-clean",bytes:png}),{assetId:"asset-clean",state:"READY"});assert.equal(completed.length,1);assert.equal(failed.length,0);
  const changed=Uint8Array.from(png);changed[changed.length-1]^=1;await assert.rejects(()=>pipeline.upload({tenantId,assetId:"asset-bad",bytes:changed}),error=>error?.code==="MEDIA_DIGEST_MISMATCH");assert.equal(failed.length,1);assert.equal(failed[0][0],"asset-bad");
});

test("worker places or hides the snapshotted agent identity without changing the message body",async()=>{
  const originalFetch=globalThis.fetch;
  try{
    for(const [placement,expected] of [["HEADER","Support: Layla\nShipment ready"],["FOOTER","Shipment ready\nSupport: Layla"],["OFF","Shipment ready"]]){
      const delivery={id:`d-${placement}`,tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",text:"Shipment ready",contentType:"text/plain",idempotencyKey:`idem-${placement}`,attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",agentPrefix:"Support:",agentDisplayName:"Layla",agentIdentityPlacement:placement,mediaEnabled:true,retentionDays:30};
      const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],beginSend:async()=>{},complete:async()=>{},fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[]};
      let body;
      globalThis.fetch=async(_input,init)=>{body=JSON.parse(String(init?.body));return new Response(JSON.stringify({id:`message-${placement}`}),{status:200})};
      const processor=new DeliveryProcessor(repository,{resolve:async()=>({apiKey:"waha-key"})},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"});
      await processor.drainTenant(tenantId);
      assert.equal(body.text,expected);
    }
  }finally{globalThis.fetch=originalFetch}
});

// Endpoint serialization only; these header bytes do not prove codec or provider acceptance.
test("GOWS serializes the private endpoint and payload for each advertised media MIME",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"private-key",sessionFor:()=>"session-1"});
  const capabilities=groupWorkspaceMediaCapabilities("WAHA");
  assert.equal(capabilities.voice_recording,true);
  assert.equal(capabilities.maximum_files,10);
  assert.equal(capabilities.maximum_total_bytes,250_000_000);
  const cases=capabilities.accepted.map(({mime_type},index)=>({
    mimeType:mime_type,filename:`attachment-${index}`,
    endpoint:mime_type.startsWith("image/")?"/api/sendImage":mime_type==="video/mp4"?"/api/sendVideo":mime_type.startsWith("audio/")?"/api/sendVoice":"/api/sendFile",
    convert:mime_type==="video/mp4"?false:mime_type.startsWith("audio/")?true:undefined,
  }));
  const originalFetch=globalThis.fetch;const requests=[];
  globalThis.fetch=async(input,init)=>{requests.push({url:String(input),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body))});return new Response(JSON.stringify({id:`message-${requests.length}`}),{status:200})};
  try{
    for(const [index,item] of cases.entries())await adapter.send({connectionId:"c1",groupId:"447700900005@g.us",text:"Case update",replyToMessageId:"quoted-1",idempotencyKey:`media-${index}`,media:{filename:item.filename,mimeType:item.mimeType,bytes:png}});
  }finally{globalThis.fetch=originalFetch}
  assert.equal(requests.length,cases.length);
  for(const [index,item] of cases.entries()){
    const request=requests[index];
    assert.ok(request.url.endsWith(item.endpoint));
    assert.equal(request.headers.get("x-api-key"),"private-key");
    assert.equal(request.body.file.data,Buffer.from(png).toString("base64"));
    assert.equal(request.body.file.url,undefined);
    assert.equal(request.body.reply_to,"quoted-1");
    assert.equal(request.body.convert,item.convert);
  }
});

test("WAHA sends only bounded group text mentions and normalizes provider contact IDs",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"private-key",sessionFor:()=>"session-1"});
  const originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(input,init)=>{request={url:String(input),body:JSON.parse(String(init?.body))};return new Response(JSON.stringify({id:"mention-1"}),{status:200})};
  try{
    await adapter.send({connectionId:"c1",groupId:"447700900005@g.us",recipientType:"GROUP",text:"Hello @12025550102",mentions:["12025550102@s.whatsapp.net"],idempotencyKey:"mention-1"});
    assert.ok(request.url.endsWith("/api/sendText"));
    assert.deepEqual(request.body.mentions,["12025550102@c.us"]);
    await adapter.send({connectionId:"c1",groupId:"447700900005@g.us",recipientType:"GROUP",text:"Hello @12025550120",mentions:["12025550120@lid"],idempotencyKey:"mention-lid"});
    assert.deepEqual(request.body.mentions,["12025550120@lid"]);
    await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"12025550102@c.us",recipientType:"DIRECT",text:"Hello @12025550102",mentions:["12025550102@c.us"],idempotencyKey:"mention-2"}),error=>error?.code==="WAHA_INVALID_REQUEST");
  }finally{globalThis.fetch=originalFetch}
});

test("WAHA sends a group reaction through the provider reaction endpoint",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"private-key",sessionFor:()=>"session-1"});
  const originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(input,init)=>{request={url:String(input),method:init?.method,body:JSON.parse(String(init?.body))};return new Response("{}",{status:200})};
  try{
    const result=await adapter.send({connectionId:"c1",groupId:"447700900005@g.us",recipientType:"GROUP",text:"",reaction:{messageId:"message-1",emoji:"✅",removed:false},idempotencyKey:"reaction-1"});
    const second=await adapter.send({connectionId:"c1",groupId:"447700900005@g.us",recipientType:"GROUP",text:"",reaction:{messageId:"message-1",emoji:"✅",removed:false},idempotencyKey:"reaction-2"});
    assert.match(result.externalMessageId,/^reaction:[a-f0-9]{64}$/u);
    assert.notEqual(second.externalMessageId,result.externalMessageId);
    assert.equal(result.state,"SENT");
    assert.ok(request.url.endsWith("/api/reaction"));assert.equal(request.method,"PUT");
    assert.deepEqual(request.body,{session:"session-1",messageId:"message-1",reaction:"✅"});
  }finally{globalThis.fetch=originalFetch}
});

test("WAHA removes a group reaction with the provider's explicit empty value",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"private-key",sessionFor:()=>"session-1"});
  const originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(input,init)=>{request={url:String(input),method:init?.method,body:JSON.parse(String(init?.body))};return Response.json({})};
  try{
    const result=await adapter.send({connectionId:"c1",groupId:"447700900005@g.us",recipientType:"GROUP",text:"",reaction:{messageId:"message-1",emoji:"",removed:true},idempotencyKey:"reaction-remove"});
    assert.match(result.externalMessageId,/^reaction:[a-f0-9]{64}$/u);assert.equal(result.state,"SENT");
    assert.ok(request.url.endsWith("/api/reaction"));assert.equal(request.method,"PUT");
    assert.deepEqual(request.body,{session:"session-1",messageId:"message-1",reaction:""});
    await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"not-a-group",recipientType:"GROUP",text:"",reaction:{messageId:"message-1",emoji:"",removed:true},idempotencyKey:"bad-remove"}),error=>error?.code==="WAHA_INVALID_REQUEST");
    await assert.rejects(()=>adapter.send({connectionId:"c1",groupId:"447700900005@g.us",recipientType:"GROUP",text:"",reaction:{messageId:"message-1",emoji:"✅",removed:true},idempotencyKey:"ambiguous-remove"}),error=>error?.code==="WAHA_INVALID_REQUEST");
  }finally{globalThis.fetch=originalFetch}
});

test("WAHA cancels a chunked oversized provider response before parsing or retrying it",async()=>{
  const adapter=new WahaAdapter({baseUrl:"https://waha.example",apiKey:"private-key",sessionFor:()=>"session-1"});
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2_000_000));controller.enqueue(new Uint8Array(2_000_000))},cancel(){cancelled=true}});
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(stream,{status:200});
  try{await assert.rejects(()=>adapter.getState("c1"),error=>error?.code==="WAHA_INVALID_RESPONSE"&&error.outcomeKnown===true)}finally{globalThis.fetch=originalFetch}
  assert.equal(cancelled,true);
});

test("new outbound attachments cross authenticated Zammad, malware scan, private S3, and integrity boundaries before send",async()=>{
  const calls=[];
  const storage={
    put:async(key,bytes,metadata)=>{calls.push(`put:${key}`);assert.deepEqual(bytes,png);assert.equal(metadata.tenant_id,tenantId)},
    get:async(key,maximum,mime)=>{calls.push(`get:${key}:${maximum}:${mime}`);return png},
    signedUrl:async()=>{throw new Error("outbound media must never issue a signed URL")},
  };
  const repository=mediaRepository({
    reserve:async(record)=>{calls.push("reserve");return{...record,scanState:"STAGING"}},
    promote:async(record)=>{calls.push("promote");return record},
  });
  const scanner={scan:async()=>{calls.push("scan");return{state:"CLEAN",engine:"clamav"}}};
  const pipeline=new DefaultOutboundMediaPipeline(scanner,storage,repository);
  const delivery={id:"d-stage",tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",ticketId:"42",articleId:"9",text:"",contentType:"image/png",idempotencyKey:"idem-stage",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm1",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(input,init)=>{request={url:String(input),headers:new Headers(init?.headers),redirect:init?.redirect};return new Response(png,{status:200,headers:{"content-type":"image/png","content-length":String(png.length)}})};
  let prepared;
  try{prepared=await pipeline.prepare(delivery,"zammad-service-token")}finally{globalThis.fetch=originalFetch}
  assert.match(request.url,/\/api\/v1\/ticket_attachment\/42\/9\/19$/);
  assert.equal(request.headers.get("authorization"),"Token token=zammad-service-token");
  assert.equal(request.redirect,"error");
  assert.deepEqual(prepared.bytes,png);
  assert.equal(prepared.newlyLinked,true);
  assert.deepEqual(calls.map(item=>item.split(":",1)[0]),["scan","reserve","put","promote","get"]);
});

test("an active-flow bot asset stays sendable after its upload-time object expiry",async()=>{
  const digest=createHash("sha256").update(png).digest("hex");let reads=0;const pipeline=new DefaultOutboundMediaPipeline({scan:async()=>{throw new Error("durable media must not be rescanned")}},{put:async()=>{},get:async()=>{reads+=1;return png},signedUrl:async()=>""},mediaRepository());
  const media={id:"dm-pinned",mediaObjectId:"mo-pinned",objectKey:"tenant/object",sha256:digest,storedMimeType:"image/png",storedByteSize:png.length,expiresAt:"2020-01-01T00:00:00.000Z",filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"READY"};
  const delivery={id:"d-pinned",tenantId,connectionId:"c1",botConversationId:"conversation-1",groupId:"12025550102@c.us",text:"Proof",contentType:"image/png",idempotencyKey:"pinned",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media};
  await assert.rejects(()=>pipeline.prepare(delivery,""),error=>error instanceof MediaRuntimeError&&error.code==="MEDIA_EXPIRED");
  const prepared=await pipeline.prepare({...delivery,media:{...media,botMediaAssetId:"asset-1"}},"");assert.deepEqual(prepared.bytes,png);assert.equal(reads,1);
});

test("group workspace uploads are deleted only after durable private-media staging",async()=>{
  const calls=[];
  const storage={put:async()=>calls.push("put"),get:async()=>png,signedUrl:async()=>{throw new Error("must stay private")}};
  const pipeline=new DefaultOutboundMediaPipeline({scan:async()=>({state:"CLEAN",engine:"clamav"})},storage,mediaRepository());
  const delivery={id:"d-workspace",tenantId,connectionId:"c1",groupWorkspaceGroupId:"g1",groupId:"447700900005@g.us",text:"",contentType:"image/png",idempotencyKey:"idem-workspace",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm-workspace",zammadUploadId:"22000000-0000-4000-8000-000000000001",zammadUploadStoreId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const originalFetch=globalThis.fetch;const requests=[];
  globalThis.fetch=async(input,init)=>{requests.push({url:String(input),method:init?.method??"GET",authorization:new Headers(init?.headers).get("authorization")});return init?.method==="DELETE"?new Response(null,{status:204}):new Response(png,{status:200,headers:{"content-type":"image/png","content-length":String(png.length)}})};
  try{
    const prepared=await pipeline.prepare(delivery,"zammad-service-token");
    assert.equal(requests.length,1);assert.equal(prepared.newlyLinked,true);assert.ok(prepared.cleanupSource);
    await prepared.cleanupSource();
  }finally{globalThis.fetch=originalFetch}
  assert.match(requests[0].url,/\/api\/v1\/wasalx\/group_workspace\/uploads\/22000000-0000-4000-8000-000000000001\/19$/);
  assert.deepEqual(requests.map(item=>item.method),["GET","DELETE"]);
  assert.deepEqual(requests.map(item=>item.authorization),["Token token=zammad-service-token","Token token=zammad-service-token"]);
  assert.deepEqual(calls,["put"]);
});

test("worker persists a workspace media link before deleting its Zammad source",async()=>{
  const delivery={id:"d-cleanup",tenantId,connectionId:"c1",groupWorkspaceGroupId:"g1",groupId:"447700900005@g.us",text:"",contentType:"image/png",idempotencyKey:"idem-cleanup",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm-cleanup",zammadUploadId:"22000000-0000-4000-8000-000000000001",zammadUploadStoreId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const calls=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async()=>calls.push("link"),renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async()=>{},beginSend:async()=>{calls.push("begin");return true},complete:async()=>calls.push("complete"),fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const pipeline={prepare:async()=>({bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"mo1",newlyLinked:true,cleanupSource:async()=>calls.push("cleanup")})};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({id:"message-cleanup"}),{status:200});
  try{await new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,pipeline).drainTenant(tenantId)}finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,["begin","link","cleanup","complete"]);
});

test("transient workspace-upload cleanup retries safely from durable media before one provider send",async()=>{
  for(const [failureStatus,replayStatus] of [[500,204],[429,404]]){
    const calls=[];const failures=[];let durableRecord;let currentDelivery={id:`d-cleanup-${failureStatus}`,tenantId,connectionId:"c1",groupWorkspaceGroupId:"g1",groupId:"447700900005@g.us",text:"",contentType:"image/png",idempotencyKey:`idem-cleanup-${failureStatus}`,attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:`dm-cleanup-${failureStatus}`,zammadUploadId:"22000000-0000-4000-8000-000000000001",zammadUploadStoreId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
    const storage={put:async()=>calls.push("storage:put"),get:async()=>{calls.push("storage:get");return png},signedUrl:async()=>{throw new Error("must stay private")}};
    const pipeline=new DefaultOutboundMediaPipeline(
      {scan:async()=>{calls.push("scan");return{state:"CLEAN",engine:"clamav"}}},
      storage,
      mediaRepository({reserve:async record=>{calls.push("media:reserve");durableRecord={...record,scanState:"STAGING"};return durableRecord},promote:async record=>{calls.push("media:promote");durableRecord=record;return record}}),
    );
    const repository={
      claimBotActions:async()=>[],claimDeliveries:async()=>currentDelivery?[currentDelivery]:[],
      linkMediaObject:async(_job,_leaseId,mediaObjectId)=>{calls.push("media:link");assert.equal(mediaObjectId,durableRecord.id);currentDelivery={...currentDelivery,media:{...currentDelivery.media,state:"READY",mediaObjectId,objectKey:durableRecord.objectKey,sha256:durableRecord.sha256,storedMimeType:durableRecord.mimeType,storedByteSize:durableRecord.byteSize,expiresAt:durableRecord.expiresAt}}},
      renewDeliveryLease:async()=>true,
      linkProviderMedia:async()=>{},failMedia:async()=>{throw new Error("transient cleanup must not quarantine media")},quarantineDelivery:async()=>{throw new Error("transient cleanup must not create quarantine evidence")},
      beginSend:async()=>{calls.push("begin");return true},complete:async()=>{calls.push("complete");currentDelivery=null},
      fail:async(_job,_lease,retryable,error,availableAt,manualRetryAllowed)=>{calls.push("retry");failures.push({retryable,error,availableAt,manualRetryAllowed});currentDelivery={...currentDelivery,attempts:currentDelivery.attempts+1}},
      outcomeUnknown:async()=>{throw new Error("provider boundary was not crossed")},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{},
    };
    const originalFetch=globalThis.fetch;let deletes=0;let downloads=0;let sends=0;
    globalThis.fetch=async(input,init)=>{
      const url=String(input);const method=init?.method??"GET";
      if(url.includes("/group_workspace/uploads/")){
        if(method==="DELETE"){deletes+=1;const status=deletes===1?failureStatus:replayStatus;calls.push(`cleanup:${status}`);return new Response(null,{status})}
        downloads+=1;calls.push("zammad:get");return new Response(png,{status:200,headers:{"content-type":"image/png","content-length":String(png.length)}});
      }
      sends+=1;calls.push("provider:send");return new Response(JSON.stringify({id:`message-cleanup-${failureStatus}`}),{status:200});
    };
    try{
      const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,pipeline);
      await processor.drainTenant(tenantId);
      assert.equal(sends,0);assert.equal(calls.filter(value=>value==="begin").length,1);
      assert.deepEqual(failures.map(({retryable,error,manualRetryAllowed})=>({retryable,error,manualRetryAllowed})),[{retryable:true,error:"Zammad workspace upload cleanup failed",manualRetryAllowed:true}]);
      assert.ok(failures[0].availableAt);
      await processor.drainTenant(tenantId);
    }finally{globalThis.fetch=originalFetch}
    assert.equal(downloads,1);assert.equal(deletes,2);assert.equal(sends,1);
    assert.equal(calls.filter(value=>value==="scan").length,1);assert.equal(calls.filter(value=>value==="storage:put").length,1);assert.equal(calls.filter(value=>value==="media:reserve").length,1);assert.equal(calls.filter(value=>value==="media:promote").length,1);assert.equal(calls.filter(value=>value==="media:link").length,1);
    assert.ok(calls.indexOf("begin")<calls.indexOf(`cleanup:${replayStatus}`));assert.ok(calls.indexOf(`cleanup:${replayStatus}`)<calls.indexOf("provider:send"));assert.equal(calls.at(-1),"complete");
  }
});

test("workspace-upload cleanup failure cannot mask malware quarantine evidence",async()=>{
  const delivery={id:"d-cleanup-malware",tenantId,connectionId:"c1",groupWorkspaceGroupId:"g1",groupId:"447700900005@g.us",text:"",contentType:"image/png",idempotencyKey:"idem-cleanup-malware",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm-cleanup-malware",zammadUploadId:"22000000-0000-4000-8000-000000000001",zammadUploadStoreId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const calls=[];const pipeline=new DefaultOutboundMediaPipeline(
    {scan:async()=>({state:"INFECTED",engine:"clamav",signature:"test-signature"})},
    {put:async()=>{throw new Error("malware must not reach storage")},get:async()=>{throw new Error("malware must not be read from storage")},signedUrl:async()=>{throw new Error("must stay private")}},
    mediaRepository({reserve:async()=>{throw new Error("malware must not be persisted")},promote:async()=>{throw new Error("malware must not be persisted")}}),
  );
  const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async()=>{throw new Error("malware must not be linked")},renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async(_job,error)=>calls.push(`media:${error}`),quarantineDelivery:async(_job,code)=>calls.push(`quarantine:${code}`),beginSend:async()=>{calls.push("begin");return true},complete:async()=>calls.push("complete"),fail:async(_job,_lease,retryable,error,_availableAt,manualRetryAllowed)=>calls.push(`fail:${retryable}:${manualRetryAllowed}:${error}`),outcomeUnknown:async()=>calls.push("unknown"),claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const originalFetch=globalThis.fetch;let sends=0;
  globalThis.fetch=async(input,init)=>{const url=String(input);if(!url.includes("/group_workspace/uploads/")){sends+=1;throw new Error("provider send must not occur")};if(init?.method==="DELETE"){calls.push("cleanup:500");return new Response(null,{status:500})}calls.push("zammad:get");return new Response(png,{status:200,headers:{"content-type":"image/png","content-length":String(png.length)}})};
  try{await new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,pipeline).drainTenant(tenantId)}finally{globalThis.fetch=originalFetch}
  assert.equal(sends,0);assert.deepEqual(calls,["begin","zammad:get","fail:false:false:Malware detected"]);
});

test("transient workspace-upload downloads stay retryable before staging or cleanup",async()=>{
  const delivery={id:"d-workspace-get",tenantId,connectionId:"c1",groupWorkspaceGroupId:"g1",groupId:"447700900005@g.us",text:"",contentType:"image/png",idempotencyKey:"idem-workspace-get",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm-workspace-get",zammadUploadId:"22000000-0000-4000-8000-000000000001",zammadUploadStoreId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const pipeline=new DefaultOutboundMediaPipeline({scan:async()=>{throw new Error("download must fail first")}}, {put:async()=>{},get:async()=>png,signedUrl:async()=>""}, mediaRepository());
  const originalFetch=globalThis.fetch;
  try{
    for(const response of [()=>new Response(null,{status:429}),()=>new Response(null,{status:500}),()=>{throw new TypeError("network unavailable")}]){
      let requests=0;globalThis.fetch=async()=>{requests+=1;return response()};
      await assert.rejects(()=>pipeline.prepare(delivery,"zammad-token"),error=>error instanceof MediaRuntimeError&&error.code==="ZAMMAD_MEDIA_DOWNLOAD"&&error.retryable&&!error.quarantine);
      assert.equal(requests,1);
    }
  }finally{globalThis.fetch=originalFetch}
});

test("S3 writes and deletes cancel response streams without waiting for cancellation",{timeout:1000},async()=>{
  const storage=new S3MediaStorage({endpoint:"https://s3.example.test",region:"us-east-1",bucket:"wasalx-media",accessKeyId:"private-reader",secretAccessKey:"private-secret"});
  const original=globalThis.fetch;
  try{
    for(const method of ["PUT","DELETE"]){
      for(const status of [200,404,503]){
        let cancelled=false;
        globalThis.fetch=async(_input,init)=>{assert.equal(init.method,method);return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]))},cancel(){cancelled=true;return new Promise(()=>{})}}),{status})};
        const operation=method==="PUT"?()=>storage.put("tenant/object",png,{mime_type:"image/png"}):()=>storage.delete("tenant/object");
        if(status===200||method==="DELETE"&&status===404)await operation();
        else await assert.rejects(operation,error=>error instanceof MediaRuntimeError&&error.retryable===(status===503));
        assert.equal(cancelled,true,`${method} ${status} must release the response stream`);
      }
    }
  }finally{globalThis.fetch=original}
});

test("S3 request timeouts reject unbounded and invalid configuration",()=>{
  const config={endpoint:"https://s3.example.test",region:"us-east-1",bucket:"wasalx-media",accessKeyId:"private-reader",secretAccessKey:"private-secret"};
  for(const timeoutMs of [NaN,Infinity,0,-1,120001,1.5])assert.throws(()=>new S3MediaStorage({...config,timeoutMs}),/S3 media timeout is invalid/);
  for(const timeoutMs of [1,10,999,1000,120000])assert.doesNotThrow(()=>new S3MediaStorage({...config,timeoutMs}));
});

test("outbound bytes are retrieved from private S3 with SigV4 headers rather than signed public URLs",async()=>{
  const storage=new S3MediaStorage({endpoint:"https://s3.example.test",region:"us-east-1",bucket:"wasalx-media",accessKeyId:"private-reader",secretAccessKey:"private-secret"});
  const originalFetch=globalThis.fetch;let request;
  globalThis.fetch=async(input,init)=>{request={url:String(input),headers:new Headers(init?.headers),redirect:init?.redirect};return new Response(png,{status:200,headers:{"content-type":"image/png","content-length":String(png.length)}})};
  try{assert.deepEqual(await storage.get(`${tenantId}/sha256/aa/digest`,png.length,"image/png"),png)}finally{globalThis.fetch=originalFetch}
  assert.match(request.headers.get("authorization"),/^AWS4-HMAC-SHA256 /);
  assert.equal(request.redirect,"error");
  assert.doesNotMatch(request.url,/private-secret|X-Amz-Signature/);
});

test("expired outbound media fails terminal before the provider boundary and cannot be manually retried",async()=>{
  const delivery={id:"d-expired",tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",ticketId:"42",articleId:"9",text:"",contentType:"image/png",idempotencyKey:"idem-expired",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm1",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"READY",mediaObjectId:"mo1"}};
  const calls=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async()=>{},renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async(_job,error)=>calls.push(`media:${error}`),quarantineDelivery:async()=>calls.push("quarantine"),beginSend:async()=>{calls.push("begin");return true},complete:async()=>calls.push("complete"),fail:async(_job,_lease,retryable,error,_availableAt,manualRetryAllowed)=>calls.push(`fail:${retryable}:${manualRetryAllowed}:${error}`),outcomeUnknown:async()=>calls.push("unknown"),claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,{prepare:async()=>{throw new MediaRuntimeError("Outbound media has expired","MEDIA_EXPIRED",false)}});
  await processor.drainTenant(tenantId);
  assert.deepEqual(calls,["begin","fail:false:false:Outbound media has expired"]);
});

test("an exhausted transient media failure is terminal but carries an explicit durable manual-retry permission",async()=>{
  const delivery={id:"d-exhausted",tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",ticketId:"42",articleId:"9",text:"",contentType:"image/png",idempotencyKey:"idem-exhausted",attempts:8,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm1",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const failures=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async()=>{},renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async()=>{throw new Error("transient media must not be quarantined")},beginSend:async()=>true,complete:async()=>{},fail:async(_job,_lease,retryable,error,availableAt,manualRetryAllowed)=>failures.push({retryable,error,availableAt,manualRetryAllowed}),outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,{prepare:async()=>{throw new MediaRuntimeError("Private media storage is temporarily unavailable","MEDIA_STORAGE_HTTP",true)}});
  await processor.drainTenant(tenantId);
  assert.deepEqual(failures,[{retryable:false,error:"Private media storage is temporarily unavailable",availableAt:undefined,manualRetryAllowed:true}]);
});

test("a transient database failure while linking staged media stays safely before SENDING",async()=>{
  const delivery={id:"d-link-failure",tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",ticketId:"42",articleId:"9",text:"",contentType:"image/png",idempotencyKey:"idem-link-failure",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm1",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
  const calls=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>[delivery],linkMediaObject:async()=>{throw new Error("database connection string must not leak")},renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async()=>{},beginSend:async()=>{calls.push("begin");return true},complete:async()=>{},fail:async(_job,_lease,retryable,error,availableAt,manualRetryAllowed)=>calls.push({retryable,error,availableAt,manualRetryAllowed}),outcomeUnknown:async()=>calls.push("unknown"),claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const pipeline={prepare:async()=>({bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"mo1",newlyLinked:true})};
  const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"waha-key"}:{token:"zammad-token"}},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,pipeline);
  await processor.drainTenant(tenantId);
  assert.equal(calls.length,2);
  assert.equal(calls[0],"begin");
  assert.equal(calls[1].retryable,true);
  assert.equal(calls[1].error,"Media staging state could not be persisted");
  assert.equal(calls[1].manualRetryAllowed,true);
  assert.ok(calls[1].availableAt);
});

test("outbound media concurrency is process-wide bounded before large base64 payloads are created",async()=>{
  const template={tenantId,connectionId:"c1",groupBindingId:"b1",groupId:"447700900005@g.us",ticketId:"42",articleId:"9",text:"",contentType:"image/png",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30,media:{id:"dm1",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"READY",mediaObjectId:"mo1"}};
  const deliveries=Array.from({length:3},(_,index)=>({...template,id:`media-${index}`,groupId:`ops-${index}@g.us`,idempotencyKey:`media-concurrency-${index}`,media:{...template.media,id:`dm-${index}`}}));
  let active=0;let maximum=0;let started=0;let releaseGate;const gate=new Promise(resolve=>{releaseGate=resolve});
  const pipeline={prepare:async()=>{active+=1;started+=1;maximum=Math.max(maximum,active);if(started===2)releaseGate();await gate;active-=1;return{bytes:png,filename:"proof.png",mimeType:"image/png",mediaObjectId:"mo1",newlyLinked:false}}};
  const completed=[];const repository={claimBotActions:async()=>[],claimDeliveries:async()=>deliveries,linkMediaObject:async()=>{},renewDeliveryLease:async()=>true,linkProviderMedia:async()=>{},failMedia:async()=>{},beginSend:async()=>true,complete:async job=>completed.push(job.id),fail:async()=>{},outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const originalFetch=globalThis.fetch;let sends=0;globalThis.fetch=async()=>new Response(JSON.stringify({id:`message-${++sends}`}),{status:200});
  try{const processor=new DeliveryProcessor(repository,{resolve:async()=>({apiKey:"waha-key"})},{wahaBaseUrl:"https://waha.example",metaGraphVersion:"v24.0"},8,pipeline,2);await processor.drainTenant(tenantId)}finally{globalThis.fetch=originalFetch}
  assert.equal(maximum,2);
  assert.equal(sends,3);
  assert.equal(completed.length,3);
});

import { prepareTicketReply } from "../services/control-api/dist/ticket-reply-target.js";
// Append to existing tests/outbound-media.test.mjs; reuse its auth/token fixtures.
// Import prepareTicketReply and queueOutboundParts as specified in the patch.
const eventReplyTenant=tenantId,eventReplyConnection='12000000-0000-4000-8000-000000000001';
function ticketReplyFixture(){
  const calls=[],deliveries=[],executions=[];
  const state={mode:'CUSTOM',version:'flow-original',originalAvailable:true,commandHeld:false,instanceCount:1,routeAvailable:true,sentDraftMatch:null};
  const flow=quote=>({schemaVersion:1,kind:'TICKET_EVENT',name:'Reply format',event:'before_agent_reply',start:'format',maxSteps:2,
    nodes:[{id:'format',type:'format_reply',text:'{{agent.name}} | {{case.number}} | {{reply.text}}',quote,next:'end'},{id:'end',type:'end'}]});
  const definitions={'flow-original':flow('ORIGINAL'),'flow-latest':flow('LATEST')};
  const query=async(sql,values=[])=>{
    calls.push({sql,values});
    if(sql.includes('WITH recent_ticket_links AS MATERIALIZED'))return{rows:state.sentDraftMatch?[state.sentDraftMatch]:[]};
    if(sql.includes('WITH quote_identities'))return{rows:[{external_message_id:values[3],ambiguous:false}]};
    if(sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:sql.includes('FROM zammad_instances')?state.instanceCount:1};
    if(sql.includes('SELECT execution.id FROM ticket_event_executions execution'))return{rows:state.commandHeld?[{id:'held-command'}]:[],rowCount:state.commandHeld?1:0};
    if(sql.includes('SELECT c.id AS connection_id'))return{rows:state.routeAvailable?[{connection_id:eventReplyConnection,binding_id:'binding',group_workspace_group_id:null,
      bot_conversation_id:null,external_chat_id:null,provider:'WAHA',agent_prefix:'Support:',agent_identity_placement:'HEADER',media_enabled:true}]:[]};
    if(sql.includes('SELECT link.external_message_id')){
      const requested=values[4],article=values[5];
      const found=requested==='original'?!state.originalAvailable?null:'original':requested==='selected'||article==='901'?'selected':requested?null:'latest';
      return{rows:found?[{external_message_id:found}]:[]};
    }
    if(sql.includes('FROM case_correlations correlation'))return{rows:[{id:'correlation',whatsapp_group_id:'group',provider:'WAHA',display_name:'Operations',
      normalized_reference:'SHIP-1',zammad_ticket_number:'50001',state:'OPEN',original_external_message_id:'original'}]};
    if(sql.includes('SELECT mode,flow_version_id FROM ticket_event_bindings'))return{rows:state.mode==='LEGACY'?[]:[{mode:state.mode,flow_version_id:state.mode==='CUSTOM'?state.version:null}]};
    if(sql.includes('SELECT definition FROM bot_flow_versions'))return{rows:definitions[values[1]]?[{definition:definitions[values[1]]}]:[]};
    if(sql.includes('SELECT id,tenant_id,correlation_id,event,mode,flow_version_id,state FROM ticket_event_executions'))return{rows:executions.filter(row=>row.source_sha256===values[3])};
    if(sql.includes('INSERT INTO ticket_event_executions')){
      const row={id:'execution-'+(executions.length+1),tenant_id:values[0],correlation_id:values[1],event:values[2],source_sha256:values[3],mode:values[4],flow_version_id:values[5],state:'PENDING'};
      executions.push(row);return{rows:[row]};
    }
    if(sql.includes('UPDATE ticket_event_executions')){
      const row=executions.find(row=>row.id===values[2]&&row.state==='PENDING');if(row)row.state=values[0];return{rows:[],rowCount:row?1:0};
    }
    if(sql.includes('SELECT reply_to_message_id FROM delivery_outbox'))return{rows:deliveries.filter(row=>row.idempotency_key===values[1]).map(row=>({reply_to_message_id:row.reply_to_message_id}))};
    if(sql.includes('INSERT INTO delivery_outbox')){
      if(deliveries.some(row=>row.idempotency_key===values[11]))return{rows:[]};
      const row={id:'delivery-'+(deliveries.length+1),state:'QUEUED',message_text:values[8],participant_name:values[13],provider_timestamp:'2026-10-05T00:00:00Z',
        reply_to_message_id:values[10],idempotency_key:values[11],request_sha256:values[12],prefix:values[14],placement:values[21]};
      deliveries.push(row);return{rows:[row]};
    }
    if(sql.includes('FROM delivery_outbox delivery LEFT JOIN delivery_media'))return{rows:deliveries.filter(row=>row.idempotency_key===values[1]).map(row=>({...row}))};
    throw new Error('Unexpected ticket-reply unit SQL');
  };
  return{client:{query},calls,deliveries,executions,state};
}
const eventReplyInput=()=>({tenantId:eventReplyTenant,connectionId:eventReplyConnection,groupId:"447700900005@g.us",ticketId:'42',requested:null,
  groupBindingId:'binding',body:'<p>مرحباً</p>',contentType:'text/html',hasAttachments:false,articleId:'90',
  agentDisplayName:'مريم',agentPrefixSnapshot:'Support:',agentIdentityPlacementSnapshot:'HEADER'});

test('ticket reply preview shares exact graph rendering and explicit article quote without writes or wake',async()=>{
  const fixture=ticketReplyFixture();let wakes=0;
  const database={rows:async(scope,sql)=>{assert.equal(scope,tenantId);assert(sql.includes('FROM zammad_instances'));return[{id:instanceId}]},
    withTenant:async(scope,work)=>{assert.equal(scope,tenantId);return work(fixture.client)}};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{wakes++}});
  const body={tenant_id:tenantId,connection_id:eventReplyConnection,group_id:"447700900005@g.us",ticket_id:'42',body:'<p>مرحباً</p>',content_type:'text/html',
    agent:{id:'7',display_name:'مريم'},has_attachments:false};
  const authorization=`Bearer ${await serviceToken()}`;
  assert.deepEqual(await controller.replyPreview(authorization,body),{text:'مريم | 50001 | مرحباً\n',replyToMessageId:'original'});
  assert.deepEqual(await controller.replyPreview(authorization,{...body,reply_to_article_id:'901'}),{text:'مريم | 50001 | مرحباً\n',replyToMessageId:'selected'});
  assert.equal(wakes,0);assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);
  assert(fixture.calls.every(call=>/^\s*(SELECT\b|WITH quote_identities AS)/u.test(call.sql)&&! /\b(INSERT|UPDATE|DELETE|MERGE)\b/u.test(call.sql)),'preview performs reads only');
});

test('initial restored preview checks a bounded sent candidate after canonical preparation and logs IDs only',async(t)=>{
  const fixture=ticketReplyFixture(),logs=[];
  t.mock.method(process.stderr,'write',chunk=>{logs.push(JSON.parse(String(chunk)));return true});
  const database={rows:async()=>[{id:instanceId}],withTenant:async(scope,work)=>{assert.equal(scope,tenantId);return work(fixture.client)}};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>assert.fail('preview cannot wake')});
  const body={tenant_id:tenantId,connection_id:eventReplyConnection,group_id:"447700900005@g.us",ticket_id:'42',body:'<p>Restored private text</p>',content_type:'text/html',
    agent:{id:'7',display_name:'Private agent name'},has_attachments:false};
  const authorization=`Bearer ${await serviceToken()}`;
  const ordinary=await controller.replyPreview(authorization,body);
  assert.deepEqual(await controller.replyPreview(authorization,{...body,restored_draft:false}),ordinary);
  assert.equal(fixture.calls.some(call=>call.sql.includes('recent_ticket_links')),false);
  fixture.state.sentDraftMatch={id:'22000000-0000-4000-8000-000000000001',zammad_article_id:'901'};
  assert.deepEqual(await controller.replyPreview(authorization,{...body,restored_draft:true}),ordinary);
  const check=fixture.calls.find(call=>call.sql.includes('recent_ticket_links'));
  assert.deepEqual(check.values,[tenantId,eventReplyConnection,'42',ordinary.text,'text/plain','original']);
  assert.match(check.sql,/WHERE tenant_id=\$1 AND zammad_ticket_id=\$3 ORDER BY created_at DESC,id DESC LIMIT 100/);
  assert.match(check.sql,/delivery\.external_message_id_sha256=app\.delivery_external_message_sha256\(\$1,\$2,link\.external_message_id\)/);
  // A newer different send does not hide an older matching restored body in the recent window.
  assert.match(check.sql,/delivery\.message_body=\$4[\s\S]*ORDER BY link\.created_at DESC,link\.id DESC LIMIT 1/);
  for(const fragment of ["delivery.tenant_id=$1 AND delivery.connection_id=$2","link.connection_id=$2","link.direction='OUTBOUND'",
    "delivery.zammad_ticket_id=$3","delivery.zammad_article_id=link.zammad_article_id","delivery.delivery_origin='TICKET'",
    "delivery.state IN ('SENT','DELIVERED','READ')","delivery.content_redacted_at IS NULL","delivery.message_body=$4","delivery.content_type=$5",
    "delivery.reply_to_message_id IS NOT DISTINCT FROM $6"])assert(check.sql.includes(fragment),fragment);
  assert.equal(logs.length,1);
  const {timestamp,level,event,...fields}=logs[0];assert(timestamp);assert.equal(level,'warn');assert.equal(event,'POSSIBLE_SENT_DRAFT_RESTORE_MATCH');
  assert.deepEqual(fields,{scope:'RECENT_100_TICKET_LINKS',tenant_id:tenantId,instance_id:instanceId,connection_id:eventReplyConnection,
    ticket_id:'42',article_id:'901',delivery_id:fixture.state.sentDraftMatch.id});
  assert.doesNotMatch(JSON.stringify(logs),/Restored private text|Private agent name|ops@g\.us|original|sha256|content_type|body/);
  assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);
  assert(fixture.calls.every(call=>! /\b(INSERT|UPDATE|DELETE|MERGE)\b/u.test(call.sql.replace(/FOR SHARE[\s\S]*$/u,''))));
});

test('restored preview without sent match or without existing authorization emits no candidate',async(t)=>{
  const fixture=ticketReplyFixture(),logs=[];
  t.mock.method(process.stderr,'write',chunk=>{logs.push(String(chunk));return true});
  const controller=new ZammadInternalController({rows:async()=>[{id:instanceId}],withTenant:async(_scope,work)=>work(fixture.client)},serviceAuth(),{wake:async()=>assert.fail('preview cannot wake')});
  const body={tenant_id:tenantId,connection_id:eventReplyConnection,group_id:"447700900005@g.us",ticket_id:'42',body:'New draft',content_type:'text/plain',agent:{id:'7',display_name:'Agent'},has_attachments:false,restored_draft:true};
  const authorization=`Bearer ${await serviceToken()}`;
  await controller.replyPreview(authorization,body);
  assert.equal(logs.length,0);
  const count=()=>fixture.calls.filter(call=>call.sql.includes('recent_ticket_links')).length;
  assert.equal(count(),1);
  for(const restored_draft of ['true',1,null,{}])await assert.rejects(()=>controller.replyPreview(authorization,{...body,restored_draft}),/Restored draft flag/);
  await assert.rejects(()=>controller.replyPreview(authorization,{...body,agent:{id:'8'}}),/matching Zammad agent/);
  await assert.rejects(()=>controller.replyPreview(authorization,{...body,tenant_id:'10000000-0000-4000-8000-000000000002'}),/Tenant mismatch/);
  await assert.rejects(()=>controller.replyPreview('Bearer invalid',body),error=>error.getStatus?.()===401);
  fixture.state.routeAvailable=false;
  await assert.rejects(()=>controller.replyPreview(authorization,body),/destination was not found/);
  assert.equal(count(),1);assert.equal(logs.length,0);
});

test('reply original policy never substitutes latest when original becomes unavailable, and absent variables fail closed',async()=>{
  const fixture=ticketReplyFixture();fixture.state.originalAvailable=false;
  await assert.rejects(()=>prepareTicketReply(fixture.client,eventReplyInput(),false),/workflow cannot be applied/);
  fixture.state.originalAvailable=true;
  await assert.rejects(()=>prepareTicketReply(fixture.client,{...eventReplyInput(),agentDisplayName:null},false),/workflow cannot be applied/);
  await assert.rejects(()=>prepareTicketReply(fixture.client,{...eventReplyInput(),requested:'other-ticket'},false),/no longer available/);
  assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);
  assert(fixture.calls.every(call=>/^\s*(SELECT\b|WITH quote_identities AS)/u.test(call.sql)&&! /\b(INSERT|UPDATE|DELETE|MERGE)\b/u.test(call.sql)));
});

test('accepted native reply replay retains original graph output and quote after config change, without duplicate attribution',async()=>{
  const fixture=ticketReplyFixture();
  const input={...eventReplyInput(),workspaceGroupId:null,botConversationId:null,externalChatId:null,quoteGroupId:"447700900005@g.us",
    replyToMessageId:null,idempotencyKey:'native-article-90',requestSha256:'a'.repeat(64),deliveryOrigin:'TICKET',directOrigin:null,mentions:[],attachments:[]};
  const first=await queueOutboundParts(fixture.client,input);
  assert.equal(first.duplicate,false);assert.equal(first.message_text,'مريم | 50001 | مرحباً\n');
  assert.equal(fixture.deliveries[0].reply_to_message_id,'original');assert.equal(fixture.deliveries[0].prefix,null);assert.equal(fixture.deliveries[0].placement,'OFF');
  assert.equal(fixture.executions.length,1);assert.equal(fixture.executions[0].flow_version_id,'flow-original');assert.equal(fixture.executions[0].state,'APPLIED');
  fixture.state.version='flow-latest';fixture.state.originalAvailable=false;fixture.state.commandHeld=true;
  const readCount=fixture.calls.filter(call=>call.sql.includes('FROM ticket_event_bindings')).length;
  const replay=await queueOutboundParts(fixture.client,input);
  assert.equal(replay.duplicate,true);assert.equal(replay.id,first.id);assert.equal(replay.message_text,first.message_text);
  assert.equal(fixture.deliveries.length,1);assert.equal(fixture.executions.length,1);
  assert.equal(fixture.calls.filter(call=>call.sql.includes('FROM ticket_event_bindings')).length,readCount,'accepted replay bypasses changed assignment');
  await assert.rejects(()=>queueOutboundParts(fixture.client,{...input,body:'Changed',requestSha256:'b'.repeat(64)}),/different outbound article/);
  assert.equal(fixture.deliveries.length,1);assert.equal(fixture.executions.length,1);
});

test('OFF reply workflow clears legacy attribution while LEGACY preserves original attribution',async()=>{
  const fixture=ticketReplyFixture();fixture.state.mode='OFF';
  const off=await prepareTicketReply(fixture.client,eventReplyInput(),false);
  assert.equal(off.body,'مرحباً\n');assert.equal(off.agentPrefixSnapshot,null);assert.equal(off.agentIdentityPlacementSnapshot,'OFF');
  fixture.state.mode='LEGACY';
  const legacy=await prepareTicketReply(fixture.client,eventReplyInput(),false);
  assert.equal(legacy.body,eventReplyInput().body);assert.equal(legacy.agentPrefixSnapshot,'Support:');assert.equal(legacy.agentIdentityPlacementSnapshot,'HEADER');
  assert.equal(fixture.executions.length,0);
});

test('direct reply preview keeps no automatic quote while explicit native article uses the authorized target',async()=>{
  const fixture=ticketReplyFixture();
  const direct={...eventReplyInput(),direct:true,groupBindingId:null,groupId:'12025550157@c.us'};
  const automatic=await prepareTicketReply(fixture.client,direct,false);
  assert.equal(automatic.replyToMessageId,null);assert.equal(automatic.body,direct.body);
  const selected=await prepareTicketReply(fixture.client,{...direct,requestedArticleId:'901'},false);
  assert.equal(selected.replyToMessageId,'selected');
  await assert.rejects(()=>prepareTicketReply(fixture.client,{...direct,requested:'wrong-chat'},false),/no longer available/);
  assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);
});

test("event feedback projects one Arabic ticket article and recovers interrupted linkage before sending",async()=>{
  const base={id:"event-feedback",tenantId,connectionId:"c1",groupBindingId:"binding",ticketEventExecutionId:"event-execution",recipientType:"GROUP",groupId:"447700900001@g.us",ticketId:"42",text:"تم استلام طلبكم\nسيتم الرد قريبًا ✅",contentType:"text/plain",replyToMessageId:"original-trigger",idempotencyKey:"ticket-event:event-execution:message",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:false,retentionDays:30,agentDisplayName:"Synthetic Agent",agentPrefix:"Handled by:",agentIdentityPlacement:"FOOTER"};
  const expected=base.text+"\nHandled by: Synthetic Agent";
  const articles=[],sends=[],completed=[];let storedArticle,loseLink=true;
  const repository={claimBotActions:async()=>[],claimStatuses:async()=>[],claimDeliveries:async()=>completed.length?[]:[{...base,...(storedArticle?{articleId:storedArticle}:{})}],beginSend:async()=>true,renewDeliveryLease:async()=>true,
    linkBotArticle:async(job,_lease,id)=>{assert.equal(job.directOrigin,undefined);assert.equal(job.botConversationId,undefined);assert.equal(job.ticketId,"42");if(loseLink){loseLink=false;throw new Error("interrupted local link")}storedArticle=id},
    complete:async job=>completed.push(job),fail:async(_job,_lease,retryable,detail)=>{assert.equal(retryable,true);assert.match(detail,/article state could not be persisted/)},outcomeUnknown:async()=>assert.fail("provider has not been called")};
  const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;
    if(url.endsWith("/ticket_articles/by_ticket/42"))return Response.json(articles);
    if(url.endsWith("/ticket_articles")){assert.equal(body.ticket_id,42);const article={...body,id:501};articles.push(article);return Response.json(article)}
    if(url.endsWith("/api/sendText")){assert.equal(storedArticle,"501");sends.push(body);return Response.json({id:"provider-feedback"})}
    throw new Error(`Unexpected request ${url}`);
  };
  try{const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?{apiKey:"test-key"}:{token:"test-token"}},{metaGraphVersion:"v24.0"});
    await processor.drainTenant(tenantId);assert.equal(articles.length,1);assert.equal(sends.length,0);
    await processor.drainTenant(tenantId);assert.equal(articles.length,1);assert.equal(sends.length,1);assert.equal(completed[0].articleId,"501");
    assert.equal(articles[0].body,expected);assert.equal(articles[0].type,"note");assert.equal(articles[0].internal,false);assert.equal(articles[0].sender,"Agent");
    assert.deepEqual(articles[0].preferences,{wasalx_origin:"bot",wasalx_bot_delivery_key:base.idempotencyKey,wasalx_ticket_event_execution_id:"event-execution"});
    assert.equal(sends[0].text,expected);assert.equal(sends[0].reply_to,"original-trigger");
  }finally{globalThis.fetch=original}
});

test("event reactions do not create text articles or claim direct bot ownership",async()=>{
  const job={id:"event-reaction",tenantId,connectionId:"c1",groupBindingId:"binding",ticketEventExecutionId:"event-execution",groupId:"447700900001@g.us",ticketId:"42",text:"✅",contentType:"application/vnd.wasalx.whatsapp-reaction",replyToMessageId:"original-trigger",idempotencyKey:"ticket-event:event-execution:reaction",attempts:1,provider:"waha",...wahaAssignment,sessionId:"s1",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
  let sends=0;
  const repository={claimBotActions:async()=>[],claimStatuses:async()=>[],claimDeliveries:async()=>[job],beginSend:async()=>true,renewDeliveryLease:async()=>assert.fail("reaction has no article projection"),linkBotArticle:async()=>assert.fail("reaction must not be an article"),complete:async completed=>assert.equal(completed.articleId,undefined),fail:async()=>assert.fail("unexpected failure"),outcomeUnknown:async()=>assert.fail("unexpected uncertainty")};
  const original=globalThis.fetch;globalThis.fetch=async input=>{assert.ok(String(input).endsWith("/api/reaction"));sends++;return Response.json({})};
  try{await new DeliveryProcessor(repository,{resolve:async reference=>{assert.equal(reference,"secret://connection");return{apiKey:"test-key"}}},{metaGraphVersion:"v24.0"}).drainTenant(tenantId);assert.equal(sends,1)}finally{globalThis.fetch=original}
});

test("automated article links require a live lease and the completed event's own case",async()=>{
  const repository=Object.create(OutboxRepository.prototype);const queries=[];let admitted=true;
  repository.tenant=async(_tenant,operation)=>operation({query:async(sql,values)=>{queries.push({sql,values});return{rows:[],rowCount:admitted?1:0}}});
  const job={id:"delivery",tenantId,ticketEventExecutionId:"execution"};
  await repository.linkBotArticle(job,"lease","501");
  const {sql,values}=queries[0];assert.deepEqual(values,["501",tenantId,"delivery","lease","execution"]);
  assert.match(sql,/lease_expires_at>=now\(\) AND state='SENDING'/);assert.match(sql,/content_redacted_at IS NULL/);
  assert.match(sql,/ticket_event_execution_id=\$5 AND content_type='text\/plain'/);
  assert.match(sql,/execution\.mode='CUSTOM' AND execution\.state='APPLIED'/);
  assert.match(sql,/correlation\.zammad_ticket_id=delivery_outbox\.zammad_ticket_id/);assert.match(sql,/correlation\.group_binding_id=delivery_outbox\.group_binding_id/);
  assert.match(sql,/zammad_article_id IS NULL OR zammad_article_id=\$1/);
  admitted=false;await assert.rejects(()=>repository.linkBotArticle(job,"lost-lease","502"),/could not be persisted/);
});

test("delivery claims expose event provenance without manufacturing a direct conversation",async()=>{
  const repository=Object.create(OutboxRepository.prototype);
  repository.tenant=async(_tenant,operation)=>operation({query:async(sql)=>{
    if(sql.startsWith("SELECT media_days"))return{rows:[{media_days:30}],rowCount:1};
    if(sql.startsWith("WITH claimed")){assert.match(sql,/d\.ticket_event_execution_id/);return{rows:[{id:"delivery",tenant_id:tenantId,ticket_event_execution_id:"execution",connection_id:"c1",group_binding_id:"binding",external_group_id:"447700900001@g.us",zammad_ticket_id:"42",message_body:"Received",content_type:"text/plain",mentions:[],idempotency_key:"event-effect",attempts:1,created_at:new Date(),provider:"WAHA",media_enabled:false,retention_days:30}],rowCount:1};}
    return{rows:[],rowCount:1};
  }});
  const [job]=await repository.claimDeliveries(tenantId,"lease");assert.equal(job.ticketEventExecutionId,"execution");assert.equal(job.recipientType,"GROUP");assert.equal(job.directOrigin,undefined);assert.equal(job.botConversationId,undefined);
});


test('manual workspace ticket in bound group keeps ordinary quoting while detached case fails closed',async()=>{
  const fixture=ticketReplyFixture();let detached=false;
  const client={query:async(sql,values)=>{
    if(sql.includes('FROM case_correlations correlation'))return{rows:[]};
    if(sql.includes('SELECT id FROM case_correlations'))return{rows:detached?[{id:'old-case'}]:[],rowCount:detached?1:0};
    return fixture.client.query(sql,values);
  }};
  const result=await prepareTicketReply(client,eventReplyInput(),true);
  assert.equal(result.replyToMessageId,'latest');assert.equal(result.body,eventReplyInput().body);
  assert.equal(result.agentPrefixSnapshot,'Support:');assert.equal(result.receipt,null);assert.equal(fixture.executions.length,0);
  detached=true;
  await assert.rejects(()=>prepareTicketReply(client,eventReplyInput(),true),/no longer linked/);
  assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);
});

test('direct native outbound validates legacy external quote and retains a valid explicit quote without event workflow',async()=>{
  const fixture=ticketReplyFixture();let wakes=0;
  const client={query:async(sql,values)=>{
    if(sql.includes("SELECT jsonb_typeof(version.definition->'keepOpenPolicy')='object' AS enabled")){
      assert.deepEqual(values,[tenantId,'conversation']);return{rows:[{enabled:false}],rowCount:1};
    }
    if(sql.includes('SELECT c.id AS connection_id'))return{rows:[{connection_id:eventReplyConnection,binding_id:null,group_workspace_group_id:null,
      bot_conversation_id:'conversation',external_chat_id:'12025550157@c.us',provider:'WAHA',agent_prefix:'Support:',agent_identity_placement:'HEADER',media_enabled:true}]};
    return fixture.client.query(sql,values);
  }};
  const database={rows:async(scope,sql)=>{assert.equal(scope,tenantId);assert(sql.includes('FROM zammad_instances'));return[{id:instanceId}]},
    withTenant:async(scope,work)=>{assert.equal(scope,tenantId);return work(client)}};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{wakes++}});
  const body={tenant_id:tenantId,connection_id:eventReplyConnection,group_id:'12025550157@c.us',ticket_id:'42',article_id:'90',body:'مرحبا',content_type:'text/plain',
    agent:{id:'7',display_name:'مريم'},idempotency_key:'native-direct-90',attachments:[],reply_to_message_id:'wrong-chat'};
  const authorization=`Bearer ${await serviceToken()}`;
  await assert.rejects(()=>controller.outbound(authorization,body),/no longer available/);
  assert.equal(fixture.deliveries.length,0);assert.equal(wakes,0);
  assert.equal(fixture.calls.filter(call=>/^(?:INSERT|UPDATE)\b/u.test(call.sql.trim())).length,0);
  await controller.outbound(authorization,{...body,reply_to_message_id:'selected'});
  assert.equal(fixture.deliveries.length,1);assert.equal(fixture.deliveries[0].reply_to_message_id,'selected');
  assert.equal(fixture.executions.length,0);assert.equal(wakes,1);
});

test('held quoted command prevents native reply preflight and new enqueue while unavailable native peer fails closed',async()=>{
  const fixture=ticketReplyFixture();fixture.state.commandHeld=true;
  let wakes=0;
  const database={rows:async()=>[{id:instanceId}],withTenant:async(scope,work)=>{assert.equal(scope,tenantId);return work(fixture.client)}};
  const controller=new ZammadInternalController(database,serviceAuth(),{wake:async()=>{wakes++}});
  const authorization=`Bearer ${await serviceToken()}`;
  await assert.rejects(()=>controller.outboundPreflight(authorization,eventReplyConnection,"447700900005@g.us",'42'),/QUOTED_COMMAND_EFFECT_HOLD/);
  const input={...eventReplyInput(),workspaceGroupId:null,botConversationId:null,externalChatId:null,quoteGroupId:"447700900005@g.us",
    replyToMessageId:null,idempotencyKey:'held-new-article',requestSha256:'c'.repeat(64),deliveryOrigin:'TICKET',directOrigin:null,mentions:[],attachments:[]};
  await assert.rejects(()=>queueOutboundParts(fixture.client,input),/QUOTED_COMMAND_EFFECT_HOLD/);
  assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);assert.equal(wakes,0);
  assert.equal(fixture.calls.some(call=>/^(?:INSERT|UPDATE|DELETE)\b/u.test(call.sql.trim())),false);
  fixture.state.commandHeld=false;fixture.state.instanceCount=0;
  await assert.rejects(()=>queueOutboundParts(fixture.client,input),/Native ticket instance is unavailable/);
  assert.equal(fixture.deliveries.length,0);assert.equal(fixture.executions.length,0);
});

test("outbound pipeline passes the identity guard to the actual native attachment request",async()=>{
 const denied=new Error("identity held"),calls=[];
 const pipeline=new DefaultOutboundMediaPipeline({scan:async()=>assert.fail("no scan")},
  {put:async()=>assert.fail("no storage write"),get:async()=>assert.fail("no storage read"),signedUrl:async()=>assert.fail("no URL")},mediaRepository());
 const delivery={id:"meta-native-guard",tenantId,connectionId:"c1",groupId:"meta:canonical",ticketId:"42",articleId:"9",
  zammadBaseUrl:"https://zammad.example",mediaEnabled:true,retentionDays:30,
  media:{id:"dm-guard",zammadAttachmentId:19,filename:"proof.png",mimeType:"image/png",byteSize:png.length,state:"PENDING"}};
 const prior=globalThis.fetch;globalThis.fetch=async()=>assert.fail("held attachment cannot reach native transport");
 try{await assert.rejects(()=>pipeline.prepare(delivery,"synthetic-token",async()=>{calls.push("guard");throw denied}),error=>error===denied)}
 finally{globalThis.fetch=prior}
 assert.deepEqual(calls,["guard"]);
});

for(const scenario of [
  {name:"WAHA plain/footer",provider:"waha",text:"Ready & waiting",agentDisplayName:"Synthetic Agent",agentPrefix:"Handled by:",agentIdentityPlacement:"FOOTER",expected:"Ready & waiting\nHandled by: Synthetic Agent"},
  {name:"WAHA retained article",provider:"waha",text:"Choose",options:[{id:"support",label:"Support"}],existing:true,expected:"Previously accepted article",wireExpected:"Choose\n1. Support"},
  {name:"WAHA English",provider:"waha",text:"Choose support\nWasalX DEV",options:[{id:"tracking",label:"Tracking & delivery"},{id:"sales",label:"Sales <contracts>"},{id:"other",label:"Other services"}],expected:"Choose support\nWasalX DEV\n1. Tracking & delivery\n2. Sales <contracts>\n3. Other services"},
  {name:"WAHA Arabic",provider:"waha",text:"مرحباً بالعميل التجريبي\nفريق الدعم",options:[{id:"activation",label:"تفعيل الحساب"},{id:"jobs",label:"التوظيف"},{id:"suggestions",label:"اقتراحات وشكاوى"}],expected:"مرحباً بالعميل التجريبي\nفريق الدعم\n1. تفعيل الحساب\n2. التوظيف\n3. اقتراحات وشكاوى"},
  {name:"Meta buttons",provider:"meta",wire:"button",text:"Choose\nFooter",options:[{id:"one",label:"Support"},{id:"two",label:"Finance"}],expected:"Choose\nFooter\n1. Support\n2. Finance"},
  {name:"Meta list",provider:"meta",wire:"list",text:"Choose",options:[{id:"one",label:"Tracking"},{id:"two",label:"Sales"},{id:"three",label:"Support"},{id:"four",label:"Finance"}],expected:"Choose\n1. Tracking\n2. Sales\n3. Support\n4. Finance"},
  {name:"Meta text fallback",provider:"meta",wire:"text",text:"Choose",options:[{id:"long",label:"A deliberately descriptive option label"}],expected:"Choose\n1. A deliberately descriptive option label"},
]) test(`bot transcript preserves ${scenario.name} context through interrupted article linkage`,async()=>{
  const job={id:"menu-context",tenantId,connectionId:"c1",botConversationId:"conversation",directOrigin:"BOT",recipientType:"DIRECT",groupId:scenario.provider==="waha"?"12025550102@c.us":"12025550102",ticketId:"42",text:scenario.text,...(scenario.options?{choices:{options:scenario.options}}:{}),...(scenario.agentDisplayName?{agentDisplayName:scenario.agentDisplayName,agentPrefix:scenario.agentPrefix,agentIdentityPlacement:scenario.agentIdentityPlacement}:{}),contentType:"text/plain",idempotencyKey:"bot:conversation:menu:0",attempts:1,provider:scenario.provider,...wahaAssignment,sessionId:scenario.provider==="waha"?"s1":"123456789",connectionSecretReference:"secret://connection",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"};
  if(scenario.provider==="meta")Object.assign(job,{
    metaDirectRecipientSnapshot:{schemaVersion:1,claim:"LEGACY_PHONE_CONTEXT",recipient:{kind:"PHONE",value:"12025550102"},asset:{providerSessionId:"70000000-0000-4000-8000-000000000001",phoneNumberId:"123456789",wabaId:"987654321"}},
    metaCredentialContext:{providerSessionId:"52000000-0000-4000-8000-000000000001",phoneNumberId:"123456789",wabaId:"987654321",proof:null},
  });
  const articles=scenario.existing?[{id:501,ticket_id:42,body:scenario.expected,content_type:"text/plain",internal:false,preferences:{wasalx_origin:"bot",wasalx_bot_delivery_key:job.idempotencyKey}}]:[];
  const sends=[];let linked,done=false,loseLink=true,failed=0;
  const repository={claimBotActions:async()=>[],claimStatuses:async()=>[],claimDeliveries:async()=>done?[]:[{...job,...(linked?{articleId:linked}:{})}],beginSend:async()=>true,renewDeliveryLease:async()=>true,
    assertMetaDeliveryContextCurrent:async()=>{},assertMetaBillingSendCurrent:async()=>{},metaInheritedTemplateContext:async()=>null,admitMetaMessageRequest:async()=>{},
    linkBotArticle:async(current,_lease,id)=>{assert.equal(current.tenantId,tenantId);assert.equal(current.ticketId,"42");if(loseLink){loseLink=false;throw new Error("interrupted menu article link")}linked=id},
    complete:async()=>{done=true},fail:async(_job,_lease,retryable,detail)=>{failed++;assert.equal(retryable,true);assert.match(detail,/Bot article state could not be persisted/)},outcomeUnknown:async()=>assert.fail("no uncertain provider outcome")};
  const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;
    if(url.endsWith("/ticket_articles/by_ticket/42"))return Response.json(articles);
    if(url.endsWith("/ticket_articles")){assert.equal(body.ticket_id,42);const article={...body,id:501};articles.push(article);return Response.json(article)}
    if(url.endsWith("/api/sendText")){assert.equal(linked,"501");sends.push(body);return Response.json({id:"menu-provider-message"})}
    if(url.endsWith("/messages")){assert.equal(linked,"501");sends.push(body);return Response.json({messages:[{id:"wamid.menu"}]})}
    throw new Error(`Unexpected menu request ${url}`);
  };
  try{
    const processor=new DeliveryProcessor(repository,{resolve:async reference=>reference.endsWith("connection")?(scenario.provider==="waha"?{apiKey:"synthetic-key"}:{accessToken:"synthetic-meta-token-for-test"}):{token:"synthetic-native-token"}},{metaGraphVersion:"v24.0"});
    await processor.drainTenant(tenantId);assert.equal(articles.length,1);assert.equal(sends.length,0);assert.equal(failed,1);
    await processor.drainTenant(tenantId);assert.equal(articles.length,1);assert.equal(sends.length,1);assert.equal(done,true);
    assert.equal(articles[0].body,scenario.expected);assert.equal(articles[0].content_type,"text/plain");assert.equal(articles[0].internal,false);
    assert.equal(articles[0].preferences.wasalx_bot_delivery_key,job.idempotencyKey);
    if(scenario.provider==="waha")assert.equal(sends[0].text,scenario.wireExpected??articles[0].body);
    else if(scenario.wire==="text")assert.equal(sends[0].text.body,articles[0].body);
    else{
      assert.equal(sends[0].interactive.type,scenario.wire);assert.equal(sends[0].interactive.body.text,scenario.text);
      const labels=scenario.wire==="button"?sends[0].interactive.action.buttons.map(button=>button.reply.title):sends[0].interactive.action.sections[0].rows.map(row=>row.title);
      assert.deepEqual(labels,scenario.options.map(option=>option.label));
    }
  }finally{globalThis.fetch=original}
});
