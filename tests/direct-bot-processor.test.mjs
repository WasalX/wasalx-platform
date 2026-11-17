import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {routingFixtureEnvironment} from "./meta-routing-fixture.mjs";
import {metaRoutingUnits} from "../services/connector-worker/dist/packages/core/src/meta-routing.js";
import { readFileSync } from "node:fs";
import { MetaGroupsAdapter } from "../services/connector-worker/dist/packages/connectors/src/meta.js";
import { MetaDirectIdentityError, parseMetaIdentityChange, metaDirectTransitionEvidence } from "../services/connector-worker/dist/packages/core/src/meta-direct-identity.js";
import { metaLifecyclePayloadSha256, verifyMetaCredentialMetadata } from "../services/connector-worker/dist/packages/core/src/meta-account-relation.js";
import { resolveMetaDirectMessage, assertMetaDirectIdentityCurrent, holdMetaIdentityChange, applyMetaIdentityTransition } from "../services/connector-worker/dist/services/connector-worker/src/meta-direct-identity.js";
import { InboundProcessor as ProductionInboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import { directDelivery, InboundRepository, providerSecondIsCurrent } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";

class InboundProcessor extends ProductionInboundProcessor {
  constructor(repository,...dependencies){super({messageIsWithinAdmissionWindow:async()=>true,hasRunnableGroupBinding:async()=>false,renewWahaWorkerAssignment:async(_event,context)=>context,...repository},...dependencies)}
}

const directEvent=(id="direct-event")=>({id,tenantId:"t1",connectionId:"c1",provider:"waha",providerEventId:id,eventType:"message.any",attempts:1,payload:{event:"message.any",payload:{id:`message-${id}`,from:"12025550102@c.us",body:"Hello",timestamp:1_700_000_000}}});

test("distinguishes an unassigned direct chat from temporarily unavailable dependencies",async()=>{
  const repository=(assigned)=>new InboundRepository({connect:async()=>({
    query:async(sql)=>{
      if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return{rows:[],rowCount:0};
      if(sql.includes("SELECT 1 FROM bot_assignments assignment"))return{rows:assigned?[{}]:[],rowCount:assigned?1:0};
      if(sql.includes("SELECT assignment.id AS assignment_id"))return{rows:[],rowCount:0};
      throw new Error(`Unexpected direct context query: ${sql}`);
    },
    release(){},
  })});
  assert.equal(await repository(false).directContext(directEvent(),"12025550102@c.us","12025550102@c.us"),null);
  await assert.rejects(()=>repository(true).directContext(directEvent(),"12025550102@c.us","12025550102@c.us"),/dependencies are temporarily unavailable/);
});

for(const support of [false,true])test(`direct Meta hydration preserves identity and ${support?"support routing":"department assignment"}`,async()=>{
  const routing={schemaVersion:1,name:"Support routing",supportGroupIds:["7"],fallback:{zammadGroupId:"9",ownerId:"42"},sources:[{id:"manual",name:"Manual",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}}],clients:[
    {id:"raw-identifier",name:"Raw identifier",routeSourceId:"manual",zammadGroupId:"99",matchers:[{kind:"CLIENT_IDENTIFIER",sourceId:"manual",namespace:"whatsapp",value:"12025550134@lid"}]},
    {id:"verified-phone",name:"Verified phone",routeSourceId:"manual",zammadGroupId:"8",ownerId:"41",matchers:[{kind:"CLIENT_IDENTIFIER",sourceId:"manual",namespace:"whatsapp",value:"12025550135"}]},
  ]};
  const entryGroupId=support?"7":"2";
  const {applyMetaLifecycleObservation}=await import("../services/connector-worker/dist/packages/core/src/meta-account-relation.js");
  const lifecycle=applyMetaLifecycleObservation(undefined,{event:"ACCOUNT_OFFBOARDED",kind:"BLOCK",reasons:["ACCOUNT_OFFBOARDED"],observedAt:"2026-10-07T10:00:00.000Z",payloadSha256:"c".repeat(64)}).state;
  const proof={credentialFingerprint:"a".repeat(64),credentialMetadata:{claim:"CREDENTIAL_METADATA_VERIFIED",appId:"123456789",scopes:["whatsapp_business_management","whatsapp_business_messaging"],expiresAt:0,dataAccessExpiresAt:0,verifiedAt:"2026-10-07T12:00:00.000Z",responseSha256:"b".repeat(64)}};
  const repository=new InboundRepository({connect:async()=>({
    query:async(sql,values)=>{
      if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config"))return{rows:[],rowCount:0};
      if(sql.includes("SELECT 1 FROM bot_assignments assignment"))return{rows:[{}],rowCount:1};
      if(sql.includes("SELECT assignment.id AS assignment_id")){
        assert.equal(values[4],"12025550134@lid");
        assert.match(sql,/participant\.external_participant_id=\$5/u);
        return{rows:[{assignment_id:"a1",zammad_group_id:entryGroupId,connection_name:"ExampleBot",connection_phone:"12025550136",participant_name:"Maha",participant_phone:"12025550135",zammad_base_url:"https://zammad.example",zammad_secret_reference:"secret",connection_secret_reference:"provider-secret",provider_base_url:null,provider_session_id:"90000000-0000-4000-8000-000000000001",opaque_session_id:"15550001111",meta_waba_id:"waba-1",meta_account_proof:proof,meta_lifecycle:lifecycle,meta_lifecycle_present:true,waha_worker_id:null,assignment_fencing_token:null,assignment_lease_expires_at:null,media_days:30,client_routing_version_id:"routing-v1",client_routing_definition:routing}],rowCount:1};
      }
      throw new Error(`Unexpected direct context query: ${sql}`);
    },
    release(){},
  })});
  const event={...directEvent("lid-identity"),provider:"meta"};
  const context=await repository.directContext(event,"12025550134@lid","12025550134@lid");
  assert.equal(context?.zammadGroup,support?"9":"2");
  assert.equal(context?.ownerId,support?"42":undefined);
  assert.equal(context?.clientRoute?.status,support?"FALLBACK":undefined);
  assert.equal(context?.participantName,"Maha");
  assert.equal(context?.participantPhone,"12025550135");
  assert.deepEqual(context?.metaCredentialContext,{providerSessionId:"90000000-0000-4000-8000-000000000001",phoneNumberId:"15550001111",wabaId:"waba-1",proof,lifecycle});
  const verified=await repository.directContext(event,"12025550134@lid","12025550134@lid","12025550135");
  assert.equal(verified?.zammadGroup,support?"8":"2","Verified phone routing still requires a support entry group");
  assert.equal(verified?.clientRoute?.clientId,support?"verified-phone":undefined);
  assert.equal(verified?.ownerId,support?"41":undefined);
  await assert.rejects(()=>repository.currentMetaCredentialProof(event,"secret://meta",context.metaCredentialContext),/lifecycle reconciliation/u);
});

test("retries an accepted direct message while its assigned dependencies are unavailable",async()=>{
  const failures=[];
  const repository={
    claim:async()=>[directEvent("dependency-outage")],
    directContext:async()=>{throw new Error("Direct bot dependencies are temporarily unavailable")},
    complete:async()=>assert.fail("A dependency outage must not discard the accepted message"),
    fail:async(_event,_lease,retryable,error,availableAt)=>failures.push({retryable,error,availableAt}),
  };
  assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>assert.fail("Secrets must wait for direct context")}).drainTenant("t1"),{events:1,acknowledgements:0});
  assert.equal(failures.length,1);
  assert.equal(failures[0].retryable,true);
  assert.equal(failures[0].error,"Direct bot dependencies are temporarily unavailable");
  assert.ok(Number.isFinite(new Date(failures[0].availableAt).getTime()));
});

test("a direct reaction is stored without starting a conversation or ticket",async()=>{
  const queries=[];
  const repository=new InboundRepository({connect:async()=>({
    query:async(sql)=>{queries.push(sql);if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config")||sql.includes("pg_advisory_xact_lock")||sql.includes("participant_identities")||sql.includes("UPDATE normalized_messages"))return{rows:[],rowCount:0};if(sql.includes("SELECT 1 FROM normalized_messages"))return{rows:[],rowCount:0};if(sql.includes("FROM bot_conversations conversation"))return{rows:[],rowCount:0};if(sql.includes("SELECT assignment.flow_version_id"))return{rows:[{flow_version_id:"flow-1",start_node:"start",state:"ACTIVE"}],rowCount:1};if(sql.includes("INSERT INTO normalized_messages"))return{rows:[{id:"message-row-1"}],rowCount:1};throw new Error(`Unexpected reaction query: ${sql}`)},
    release(){},
  })});
  const event=directEvent("reaction");
  const message={provider:"meta",messageId:"wamid.reaction",chatId:"12025550102",senderId:"12025550102",text:"Reacted with 👍",input:{type:"reaction",emoji:"👍",removed:false},quotedMessageId:"wamid.original",fromMe:false,timestamp:new Date("2026-01-01T00:00:00Z")};
  const result=await repository.processDirectMessage(event,{assignmentId:"assignment-1",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"},message,{id:7,login:"customer"},{create:async()=>assert.fail("Reaction must not create a ticket"),append:async()=>assert.fail("Reaction must not append a ticket article"),reply:async()=>assert.fail("Reaction must not send a bot reply")});
  assert.deepEqual(result,{duplicate:false,queued:false,state:undefined,ignored:false});
  assert.equal(queries.some(sql=>sql.includes("INSERT INTO bot_conversations")),false);
});

for(const held of [false,true])test(`unsupported direct input ${held?"holds unresolved native evidence":"is appended for audit without advancing the active flow"}`,async()=>{
  const queries=[];let appended=0;let eventMetadata;
  const repository=new InboundRepository({connect:async()=>(
    {query:async(sql,values=[])=>{queries.push(sql);
      if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config")||sql.includes("pg_advisory_xact_lock")||sql.includes("participant_identities")||sql.includes("UPDATE normalized_messages")||sql.includes("INSERT INTO message_links")||sql.includes("UPDATE bot_conversations"))return{rows:[],rowCount:0};
      if(sql.includes("SELECT 1 FROM normalized_messages"))return{rows:[],rowCount:0};
      if(sql.includes("SELECT 'reply' AS kind,id FROM direct_native_reply_intents")){
        assert.deepEqual(values,['t1','conversation-1',null,null]);return{rows:held?[{kind:'close',id:'pending-close'}]:[],rowCount:held?1:0};
      }
      if(sql.includes("FROM bot_conversations conversation"))return{rows:[{id:"conversation-1",flow_version_id:"flow-1",state:"BOT",current_node_id:"menu",step_count:2,variables:{},zammad_ticket_id:"42",zammad_ticket_number:"90042",last_activity_at:"2026-01-01T00:00:00.000Z",client_routing_version_id:null,client_route_status:null,client_id:null,client_route_matched_by:null,routing_definition:null}],rowCount:1};
      if(sql.includes("SELECT assignment.flow_version_id"))return{rows:[{flow_version_id:"flow-1",start_node:"menu",state:"ACTIVE"}],rowCount:1};
      if(sql.includes("INSERT INTO normalized_messages"))return{rows:[{id:"message-row-unsupported"}],rowCount:1};
      if(sql.includes("INSERT INTO bot_conversation_events")){eventMetadata=JSON.parse(values[5]);return{rows:[],rowCount:1}}
      if(sql.includes("SELECT definition FROM bot_flow_versions"))assert.fail("Unsupported input must not load or advance the flow");
      throw new Error(`Unexpected unsupported-message query: ${sql}`);
    },release(){}}
  )});
  const message={provider:"meta",messageId:"wamid.unsupported",chatId:"12025550102",senderId:"12025550102",text:"This WhatsApp message type is not supported yet.",input:{type:"unsupported",text:"This WhatsApp message type is not supported yet."},fromMe:false,timestamp:new Date("2026-01-02T00:00:00Z")};
  const result=await repository.processDirectMessage(directEvent("unsupported"),{assignmentId:"assignment-1",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"},message,{id:7,login:"customer"},{create:async()=>assert.fail("Existing conversation must not create another ticket"),append:async()=>{appended+=1;return"article-1"},reply:async()=>assert.fail("Unsupported input must not send a bot reply")});
  assert.deepEqual(result,held?{duplicate:false,queued:false,state:'BOT',ignored:false,pendingTarget:true}:{duplicate:false,queued:false,state:"BOT",ignored:false});
  assert.equal(appended,held?0:1);assert.equal(eventMetadata?.input_type,held?undefined:"unsupported");
  assert.equal(queries.some(sql=>sql.includes('INSERT INTO normalized_messages')),!held);assert.equal(queries.some(sql=>sql.includes("SELECT definition FROM bot_flow_versions")),false);
});

test("records a manual linked-device direct message as agent history and ignores its API echo",async()=>{
  const manual=directEvent("manual-device");manual.payload.payload.from="12025550130@lid";manual.payload.payload.fromMe=true;manual.payload.payload.notifyName="Linked device owner";manual.payload.payload._data={Info:{SenderAlt:"12025550133@s.whatsapp.net",VerifiedName:{Details:{verifiedName:"Business owner"}}}};
  const echo=directEvent("api-echo");echo.payload.payload.fromMe=true;echo.payload.payload.source="api";
  const completed=[];const articles=[];let contexts=0;let processed=0;
  const repository={
    claim:async()=>[manual,echo],
    directContext:async()=>{contexts+=1;return{assignmentId:"a1",participantName:"Maha",participantPhone:"+12025550135",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"}},
    processDirectMessage:async(_event,_context,message,_customer,actions)=>{
      processed+=1;assert.equal(message.fromMe,true);await actions.create("manual-correlation","MANUAL");
      return{duplicate:false,queued:false,state:"BOT",ignored:false};
    },
    complete:async(event,_lease,status,_redact,error)=>completed.push({id:event.id,status,error}),
    fail:async()=>assert.fail("Manual-device history must not fail"),
  };
  const original=globalThis.fetch;let ticketPayload;const calls=[];
  let nativeCustomer;globalThis.fetch=async(input,init)=>{const url=new URL(String(input));const body=init?.body?JSON.parse(String(init.body)):undefined;
    calls.push({path:url.pathname,method:init?.method??"GET",body});
    if(url.pathname==="/api/v1/users/search"){nativeCustomer={id:7,login:url.searchParams.get("query")?.replace(/^login:/u,""),firstname:"WhatsApp participant",lastname:""};return Response.json([nativeCustomer])}
    if(url.pathname==="/api/v1/users/7"&&(!init?.method||init.method==="GET"))return Response.json(nativeCustomer);
    if(url.pathname==="/api/v1/users/7")return Response.json({id:7,login:"customer",firstname:body.firstname,lastname:"",mobile:body.mobile});
    if(url.pathname==="/api/v1/tickets/search")return Response.json([]);
    if(url.pathname==="/api/v1/tickets"){ticketPayload=body;articles.push({id:1,...body.article});return Response.json({id:42,number:"90042",state:"open",group:"Support",title:body.title})}
    if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json(articles);
    if(url.pathname==="/api/v1/ticket_articles"){const article={id:articles.length+1,...body};articles.push(article);return Response.json(article)}
    return new Response(null,{status:404});
  };
  try{assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("t1"),{events:2,acknowledgements:0})}finally{globalThis.fetch=original}
  assert.equal(contexts,1);assert.equal(processed,1);assert.equal(articles.length,1);
  assert.equal(ticketPayload.title,"Maha — WhatsApp conversation");assert.equal(ticketPayload.article.sender,"Agent");assert.equal("origin_by_id" in ticketPayload.article,false);
  const customerUpdate=calls.find(call=>call.path==="/api/v1/users/7"&&call.method==="PUT")?.body;assert.deepEqual(customerUpdate,{mobile:"+12025550135",firstname:"Maha",lastname:"",preferences:{wasalx_identity:{login:nativeCustomer.login,lastAppliedName:"Maha"}}});
  assert.deepEqual(completed.sort((left,right)=>left.id.localeCompare(right.id)),[
    {id:"api-echo",status:"IGNORED",error:"PROVIDER_API_DIRECT_MESSAGE"},
    {id:"manual-device",status:"PROCESSED",error:undefined},
  ]);
});

test("keeps inbound and outbound location details usable in the Zammad transcript",async()=>{
  const event={id:"location-event",tenantId:"t1",connectionId:"c1",provider:"waha",providerEventId:"location-event",eventType:"message",attempts:1,payload:{event:"message",payload:{id:"location-message",from:"12025550102@c.us",location:{latitude:24.7,longitude:46.7,name:"Office",address:"Riyadh\nSaudi Arabia"},timestamp:1_700_000_000}}};
  let ticketBody="";let customerPayload;let ticketArticle;
  const repository={
    claim:async()=>[event],
    directContext:async()=>({assignmentId:"a1",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"}),
    processDirectMessage:async(_event,_context,_message,_customer,actions)=>{await actions.create("location-correlation","BOT-LOCATION");return{duplicate:false,queued:false,state:"BOT"}},
    complete:async()=>{},fail:async(_event,_lease,_retryable,error)=>assert.fail(error),
  };
  const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));const body=init?.body?JSON.parse(String(init.body)):undefined;
    if(url.pathname==="/api/v1/users/search")return Response.json([]);
    if(url.pathname==="/api/v1/users"){customerPayload=body;return Response.json({id:7,login:body.login,firstname:body.firstname,lastname:"",mobile:body.mobile})}
    if(url.pathname==="/api/v1/tickets/search")return Response.json([]);
    if(url.pathname==="/api/v1/tickets"){ticketBody=body.article.body;ticketArticle=body.article;return Response.json({id:42,number:"90042",state:"open",group:"Support",title:"Location"})}
    if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json([{id:91,preferences:{wasalx_external_message_id:"location-message"}}]);
    return new Response(null,{status:404});
  };
  try{await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("t1")}finally{globalThis.fetch=original}
  assert.match(ticketBody,/Office\nAddress: Riyadh Saudi Arabia\nCoordinates: 24\.7, 46\.7\nMap: https:\/\/www\.openstreetmap\.org\//u);
  assert.equal(customerPayload.mobile,"+12025550102");assert.equal(ticketArticle.origin_by_id,7);
  const outbound=directDelivery({type:"send_location",nodeId:"office",latitude:24.7,longitude:46.7,name:"Office",address:"Riyadh"});
  assert.deepEqual(outbound?.content,{type:"location",latitude:24.7,longitude:46.7,name:"Office",address:"Riyadh"});
  assert.match(outbound?.text??"",/Coordinates: 24\.7, 46\.7/u);
});

test("preserves the configured official-channel list button label",()=>{
  assert.deepEqual(directDelivery({type:"send_choices",nodeId:"menu",prompt:"Choose",buttonLabel:"Select",options:[{id:"a",label:"A"}]}),{text:"Choose",content:{type:"choices",nodeId:"menu",buttonLabel:"Select",options:[{id:"a",label:"A"}]}});
});

test("accepts a legitimate Meta callback created in the same provider second",()=>{
  assert.equal(providerSecondIsCurrent("2023-11-14T22:13:22.000Z","2023-11-14T22:13:22.999Z"),true);
  assert.equal(providerSecondIsCurrent("2023-11-14T22:13:21.999Z","2023-11-14T22:13:22.000Z"),false);
  assert.equal(providerSecondIsCurrent("invalid","2023-11-14T22:13:22.000Z"),false);
});

for(const abandoned of [false,true]) test(`rejects ${abandoned?"abandoned":"stale"} Meta native choice before recording or advancing the conversation`,async()=>{
  let inserted=false;
  const client={query:async(sql,values=[])=>{
    if(sql==="BEGIN"||sql==="COMMIT"||sql==="ROLLBACK"||sql.includes("set_config")||sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT 1 FROM normalized_messages"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT 'reply' AS kind,id FROM direct_native_reply_intents")){
      assert.deepEqual(values,['t1','conversation-1',null,null]);return{rows:[],rowCount:0};
    }
    if(sql.includes("FROM bot_conversations conversation"))return{rows:[{id:"conversation-1",flow_version_id:"flow-1",state:"BOT",current_node_id:"menu",step_count:1,variables:{},zammad_ticket_id:"42",zammad_ticket_number:"90042",last_activity_at:"2023-11-14T22:13:20.000Z",client_routing_version_id:null,client_route_status:null,client_id:null,client_route_matched_by:null,routing_definition:null}],rowCount:1};
    if(sql.includes("SELECT assignment.flow_version_id"))return{rows:[{flow_version_id:"flow-1",start_node:"menu",state:"ACTIVE"}],rowCount:1};
    if(sql.includes("FROM delivery_outbox")){assert.equal(values[4],"menu");return{rows:[{no_further_attempts:abandoned,state:abandoned?"OUTCOME_UNKNOWN":"SENT",external_message_id:"wamid.latest",created_at:"2023-11-14T22:13:21.000Z",bot_content:{type:"choices",nodeId:"menu",options:[{id:"status",label:"Status"}]}}],rowCount:1}}
    if(sql.includes("INSERT INTO normalized_messages")){inserted=true;throw new Error("stale choice reached message storage")}
    throw new Error(`Unexpected query: ${sql}`);
  },release(){}};
  const repository=new InboundRepository({connect:async()=>client});
  const message={provider:"meta",connectionId:"c1",eventId:"wamid.choice",messageId:"wamid.choice",chatId:"12025550102",senderId:"12025550102",input:{type:"choice",choiceId:"status",label:"Status",source:"META_NATIVE"},fromApi:false,fromMe:false,timestamp:"2023-11-14T22:13:22.000Z",quotedMessageId:abandoned?"wamid.latest":"wamid.stale"};
  const result=await repository.processDirectMessage({id:"event-1",tenantId:"t1",connectionId:"c1",provider:"meta",providerEventId:"wamid.choice",eventType:"messages",attempts:1,payload:{}},{assignmentId:"assignment-1",zammadGroup:"2",assignmentZammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"},message,{id:7,login:"customer"},{create:async()=>assert.fail(),append:async()=>assert.fail(),reply:async()=>assert.fail()});
  assert.equal(inserted,false);assert.deepEqual(result,{duplicate:false,queued:false,state:"BOT",ignored:true,ignoreReason:"DIRECT_CHOICE_PROMPT_MISMATCH"});
});

test("keeps approved templates and WhatsApp forms in the support transcript and delivery outbox",()=>{
  assert.deepEqual(directDelivery({type:"send_template",nodeId:"template",templateName:"order_update",languageCode:"en_US",bodyParameters:["ORD-42"],transcriptText:"Order ORD-42 update sent."}),{text:"Order ORD-42 update sent.",content:{type:"template",name:"order_update",languageCode:"en_US",bodyParameters:["ORD-42"]}});
  assert.deepEqual(directDelivery({type:"send_whatsapp_flow",nodeId:"form",flowId:"12345",flowToken:"flow-token-1",prompt:"Confirm order",buttonLabel:"Confirm",screen:"ORDER",data:{order_id:"ORD-42"}}),{text:"Confirm order",content:{type:"flow",id:"12345",token:"flow-token-1",buttonLabel:"Confirm",screen:"ORDER",data:{order_id:"ORD-42"}}});
});

test("uses an official Meta sender number for customer display without changing the service audit author",async()=>{
  const event={id:"meta-event",tenantId:"t1",connectionId:"c1",provider:"meta",providerEventId:"wamid.meta",eventType:"messages",attempts:1,payload:{entry:[{changes:[{value:{contacts:[{profile:{name:"Maha"},wa_id:"12025550137"}],messages:[{id:"wamid.meta",from:"12025550137",timestamp:"1700000000",type:"text",text:{body:"Hello"}}]}}]}]}};
  const repository={claim:async()=>[event],
    resolveMetaDirectMessage:async(_event,_lease,message)=>({...message,senderPhone:`+${message.metaIdentity.phone}`}),
    assertMetaDirectIdentityCurrent:async()=>{},directContext:async()=>({assignmentId:"a1",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"}),
    processDirectMessage:async(_event,_context,_message,_customer,actions)=>{await actions.create("meta-correlation","BOT-META");return{duplicate:false,queued:false,state:"BOT"}},
    complete:async()=>{},fail:async(_event,_lease,_retryable,error)=>assert.fail(error)};
  const calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{const url=new URL(String(input));const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path:url.pathname,body});
    if(url.pathname==="/api/v1/users/search")return Response.json([]);
    if(url.pathname==="/api/v1/users")return Response.json({id:8,login:body.login,firstname:body.firstname,lastname:"",mobile:body.mobile});
    if(url.pathname==="/api/v1/tickets/search")return Response.json([]);
    if(url.pathname==="/api/v1/tickets")return Response.json({id:43,number:"90043",state:"open",group:"Support",title:"Meta"});
    if(url.pathname==="/api/v1/ticket_articles/by_ticket/43")return Response.json([{id:92,preferences:{wasalx_external_message_id:"wamid.meta"}}]);
    return new Response(null,{status:404})};
  try{await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("t1")}finally{globalThis.fetch=original}
  assert.equal(calls.find(call=>call.path==="/api/v1/users")?.body.mobile,"+12025550137");
  assert.equal(calls.find(call=>call.path==="/api/v1/tickets")?.body.article.origin_by_id,8);
});

test("Meta native choice and location envelopes append to the existing expanded ticket",async()=>{
  for(const [type,content,inputType] of [
    ["interactive",{interactive:{type:"button_reply",button_reply:{id:"location",title:"Share my location"}},context:{id:"wamid.prompt"}},"choice"],
    ["location",{location:{latitude:24.7136,longitude:46.6753,name:"Synthetic test location"}},"location"],
  ]){
    const message={id:`wamid.${type}`,from:"12025550138",timestamp:"1700000000",type,...content};
    const event={id:`meta-${type}`,tenantId:"t1",connectionId:"c1",provider:"meta",providerEventId:message.id,eventType:"messages",attempts:1,payload:{object:"whatsapp_business_account",entry:[{id:"test-waba",changes:[{field:"messages",value:{messaging_product:"whatsapp",metadata:{display_phone_number:"+12025550136",phone_number_id:"test-phone"},contacts:[{wa_id:message.from,profile:{name:"Synthetic customer"}}],messages:[message]}}]}]}};
    let completed=0;const articles=[];const updates=[];
    const repository={claim:async()=>[event],
    resolveMetaDirectMessage:async(_event,_lease,message)=>({...message,senderPhone:`+${message.metaIdentity.phone}`}),
    assertMetaDirectIdentityCurrent:async()=>{},directContext:async()=>({assignmentId:"a1",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"}),
      processDirectMessage:async(_event,_context,normalized,_customer,actions)=>{assert.equal(normalized.input.type,inputType);assert.equal(await actions.append("42"),"91");return{duplicate:false,queued:false,state:"BOT"}},
      complete:async()=>{completed++},fail:async(_event,_lease,_retryable,error)=>assert.fail(error)};
    const original=globalThis.fetch;let nativeCustomer;
    globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input));const method=init?.method??"GET";const body=init?.body?JSON.parse(String(init.body)):undefined;
      if(url.pathname==="/api/v1/users/search"){nativeCustomer={id:7,login:url.searchParams.get("query")?.replace(/^login:/u,""),firstname:"Synthetic customer",lastname:"",mobile:"+12025550138"};return Response.json([nativeCustomer])}
    if(url.pathname==="/api/v1/users/7"&&(!init?.method||init.method==="GET"))return Response.json(nativeCustomer);
      if(url.pathname==="/api/v1/tickets/42"&&method==="GET")return Response.json({id:42,title:"Keep customer title",state_id:2,...(url.searchParams.get("expand")==="true"?{state:"open"}:{})});
      if(url.pathname==="/api/v1/tickets/42"&&method==="PUT"){updates.push(body);return Response.json({id:42,state_id:2})}
      if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json([]);
      if(url.pathname==="/api/v1/ticket_articles"&&method==="POST"){articles.push(body);return Response.json({id:91})}
      return new Response(null,{status:404});
    };
    try{await new InboundProcessor(repository,{resolve:async()=>({token:"test-token"})}).drainTenant("t1")}finally{globalThis.fetch=original}
    assert.equal(completed,1);assert.equal(articles.length,1);assert.equal(articles[0].ticket_id,42);
    assert.equal(articles[0].preferences.wasalx_external_message_id,message.id);
    assert.deepEqual(updates,[{wasalx_latest_external_message_id:message.id}]);
  }
});

test("records quoted direct WhatsApp media while deferring bot replies to delivery", async () => {
  const completed = [];
  const calls = [];
  const event = { id: "e1", tenantId: "t1", connectionId: "c1", provider: "waha", providerEventId: "p1", eventType: "message.any", attempts: 1, payload: { event: "message.any", payload: { id: "m1", from: "12025550102@c.us", notifyName: "Ahmed", body: "agent", replyTo: { id: "quoted-1" }, media: { url: "http://localhost:3000/api/s3/proof", mimetype: "image/png", filename: "proof.png" }, timestamp: 1_700_000_000 } } };
  const repository = {
    claim: async () => [event],
    directContext: async () => ({ assignmentId: "a1", zammadGroup: "4", ownerId:"12",clientRoute:{versionId:"86000000-0000-4000-8000-000000000001",status:"MATCHED",clientId:"acme",matchedBy:"CLIENT_IDENTIFIER",escalationGroupId:"7"}, zammadBaseUrl: "https://zammad.example", zammadSecretReference: "secret", connectionSecretReference: "waha-secret", providerBaseUrl: "http://waha.internal:3000", providerSessionId: "session-1", wahaWorkerId: "worker-1", wahaAssignmentFencingToken: 7, mediaEnabled: true, retentionDays: 30 }),
    renewWahaWorkerAssignment: async (_event, context) => context,
    linkMediaObject: async (_event, message, id) => { assert.equal(message.quotedMessageId, "quoted-1"); calls.push({ mediaObjectId: id }) },
    processDirectMessage: async (_event, _context, message, customer, actions) => {
      assert.equal(message.chatId, "12025550102@c.us");
      assert.equal(message.quotedMessageId, "quoted-1");
      assert.equal(message.media?.mimeType, "image/png");
      assert.equal(customer.login.length, 71);
      const ticket = await actions.create("correlation", "BOT-ABC");
      assert.equal(ticket.id,"42");
      assert.equal(actions.reply,undefined);
      return { duplicate: false, queued: true, state: "HUMAN" };
    },
    complete: async (_event, _lease, status) => { completed.push(status) },
    fail: async () => { throw new Error("unexpected failure") },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: `${url.pathname}${url.search}`, method, body });
    if (url.pathname === "/api/v1/users/search") return Response.json([]);
    if (url.pathname === "/api/v1/users") return Response.json({ id: 7, login: body.login, firstname: body.firstname, lastname: "" });
    if (url.pathname === "/api/v1/tickets/search") return Response.json([]);
    if (url.pathname === "/api/v1/tickets" && method === "POST") return Response.json({ id: 42, number: "90042", state: "open", group: "Support", title: "Bot" });
    if (url.pathname === "/api/v1/tickets/42") return Response.json({ id: 42, number: "90042", state_id: 2, ...(url.searchParams.get("expand")==="true"?{state:"open"}:{}), group: "Support", title: "Bot" });
    if (url.pathname === "/api/v1/ticket_articles/by_ticket/42") return Response.json([]);
    if (url.pathname === "/api/v1/ticket_articles") return Response.json({ id: 3 });
    return new Response(null, { status: 404 });
  };
  try {
    const processor = new InboundProcessor(repository, { resolve: async () => ({ token: "zammad-token" }) }, { prepare: async input => {
      assert.equal(input.media.url, "http://localhost:3000/api/s3/proof");
      return { mediaObjectId: "media-1", attachment: { filename: "proof.png", data: "cG5n", "mime-type": "image/png" } };
    } });
    assert.deepEqual(await processor.drainTenant("t1"), { events: 1, acknowledgements: 1 });
    assert.deepEqual(completed, ["PROCESSED"]);
    assert.equal(calls.some(call => call.path === "/api/v1/tickets" && call.body?.wasalx_bot_conversation === "true"), true);
    const ticketCall=calls.find(call=>call.path==="/api/v1/tickets");
    assert.equal(ticketCall.body.title,"Ahmed — WhatsApp conversation");
    assert.doesNotMatch(ticketCall.body.title,/BOT-|ABC/u);
    assert.equal(ticketCall.body.group_id,4);assert.equal(ticketCall.body.owner_id,12);
    assert.equal(calls.find(call=>call.path==="/api/v1/users")?.body.mobile,"+12025550102");
    assert.equal(ticketCall.body.article.origin_by_id,7);
    assert.equal(ticketCall.body.wasalx_client_id,"acme");assert.equal(ticketCall.body.wasalx_escalation_group_id,"7");
    assert.deepEqual(calls.find(call => call.path === "/api/v1/tickets")?.body.article.attachments, [{ filename: "proof.png", data: "cG5n", "mime-type": "image/png" }]);
    assert.equal(calls.some(call => call.mediaObjectId === "media-1"), true);
    assert.equal(calls.some(call => call.path === "/api/v1/ticket_articles" && call.body?.internal === false && call.body?.preferences?.wasalx_bot_delivery_key === "bot:conversation:event:0"), false);
    assert.equal(calls.some(call => call.path === "/api/v1/tickets/42"), false);
  } finally { globalThis.fetch = original; }
});

test("keeps direct customer turns without duplicates and does not project bot replies during intake", async () => {
  const makeEvent = (id, messageId, body) => ({ id, tenantId: "t1", connectionId: "c1", provider: "waha", providerEventId: id, eventType: "message.any", attempts: 1, payload: { event: "message.any", payload: { id: messageId, from: "12025550102@c.us", body, timestamp: 1_700_000_000 } } });
  const events = [makeEvent("e1", "m1", "first"), makeEvent("e2", "m2", "second"), makeEvent("e3", "m2", "second")];
  const seen = new Set();
  const completed = [];
  const articles = [];
  let routeQueue = Promise.resolve();
  let ticketCreates = 0;
  const repository = {
    claim: async () => events,
    directContext: async () => ({ assignmentId: "a1", zammadGroup: "2", zammadBaseUrl: "https://zammad.example", zammadSecretReference: "secret", connectionSecretReference: "waha-secret", providerBaseUrl: "http://waha.internal:3000", providerSessionId: "session-1", wahaWorkerId: "worker-1", wahaAssignmentFencingToken: 7, mediaEnabled: true, retentionDays: 30 }),
    renewWahaWorkerAssignment: async (_event, context) => context,
    processDirectMessage: (_event, _context, message, _customer, actions) => routeQueue = routeQueue.then(async () => {
      if (seen.has(message.messageId)) return { duplicate: true, queued: false, state: "BOT" };
      seen.add(message.messageId);
      if (message.messageId === "m1") await actions.create("correlation", "BOT-ABC");
      else await actions.append("42");
      assert.equal(actions.reply,undefined);
      return { duplicate: false, queued: true, state: "BOT" };
    }),
    complete: async (_event, _lease, status) => { completed.push(status) },
    fail: async () => { throw new Error("unexpected failure") },
  };
  const original = globalThis.fetch;
  let nativeCustomer;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/v1/users/search") {
      const login = url.searchParams.get("query")?.replace(/^login:/u, "");
      nativeCustomer={ id: 7, login, firstname: "WhatsApp participant", lastname: "" };return Response.json([nativeCustomer]);
    }
    if (url.pathname === "/api/v1/users/7" && method === "GET") return Response.json(nativeCustomer);
    if (url.pathname === "/api/v1/users/7" && method === "PUT") return Response.json({ id: 7, ...body });
    if (url.pathname === "/api/v1/tickets/search") return Response.json([]);
    if (url.pathname === "/api/v1/tickets" && method === "POST") {
      ticketCreates += 1;
      articles.push({ id: 1, ...body.article });
      return Response.json({ id: 42, number: "90042", state: "open", group: "Support", title: "Bot" });
    }
    if (url.pathname === "/api/v1/tickets/42" && method === "GET") return Response.json({ id: 42, number: "90042", state_id: 2, ...(url.searchParams.get("expand")==="true"?{state:"open"}:{}), group: "Support", title: "Bot" });
    if (url.pathname === "/api/v1/tickets/42" && method === "PUT") return Response.json({ id: 42, number: "90042", state: "open", group: "Support", title: "Bot", ...body });
    if (url.pathname === "/api/v1/ticket_articles/by_ticket/42") return Response.json(articles);
    if (url.pathname === "/api/v1/ticket_articles" && method === "POST") {
      const article = { id: articles.length + 1, ...body };
      articles.push(article);
      return Response.json(article);
    }
    return new Response(null, { status: 404 });
  };
  try {
    const processor = new InboundProcessor(repository, { resolve: async () => ({ token: "zammad-token" }) });
    assert.deepEqual(await processor.drainTenant("t1"), { events: 3, acknowledgements: 2 });
    assert.deepEqual(completed.sort(), ["DUPLICATE", "PROCESSED", "PROCESSED"]);
    assert.equal(ticketCreates, 1);
    const turns=articles.map(article => [article.sender, article.body]);
    assert.deepEqual([...turns].sort((left,right)=>String(left[1]).localeCompare(String(right[1]))),[
      ["Customer","first"],["Customer","second"],
    ]);
    assert.equal(articles.some(article=>article.sender==="Agent"),false);
    for(const article of articles.filter(article=>article.sender==="Customer"))assert.equal(article.origin_by_id,7);
    for(const article of articles.filter(article=>article.sender==="Agent"))assert.equal(article.origin_by_id,undefined);
  } finally { globalThis.fetch = original; }
});

test("reopens the existing ticket and appends the first message after a resolved chat",async()=>{
  const event={id:"e4",tenantId:"t1",connectionId:"c1",provider:"waha",providerEventId:"e4",eventType:"message.any",attempts:1,payload:{event:"message.any",payload:{id:"m4",from:"12025550134@lid",body:"back again",timestamp:1_700_000_100}}};
  const calls=[];
  const repository={
    claim:async()=>[event],
    directContext:async()=>({assignmentId:"a1",participantName:"Maha",participantPhone:"+12025550135",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"}),
    processDirectMessage:async(_event,_context,_message,_customer,actions)=>{await actions.create("correlation","BOT-ABC");return{duplicate:false,queued:false,state:"BOT",ignored:false}},
    complete:async(_event,_lease,status)=>calls.push(["complete",status]),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  const original=globalThis.fetch;
  let nativeCustomer;globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));const method=init?.method??"GET";const body=init?.body?JSON.parse(String(init.body)):undefined;
    if(url.pathname==="/api/v1/users/search"){nativeCustomer={id:7,login:url.searchParams.get("query")?.replace(/^login:/u,""),firstname:"Customer",lastname:""};return Response.json([nativeCustomer])}
    if(url.pathname==="/api/v1/users/7"&&(!init?.method||init.method==="GET"))return Response.json(nativeCustomer);
    if(url.pathname==="/api/v1/users/7"&&method==="PUT")return Response.json({id:7,...body});
    if(url.pathname==="/api/v1/tickets/search"){assert.equal(url.searchParams.get("expand"),"true");return Response.json([{id:42,number:"90042",state:"closed",group:"Support",title:"WhatsApp participant — WhatsApp conversation",wasalx_correlation_key:"correlation"}])}
    if(url.pathname==="/api/v1/tickets/42"&&method==="PUT"){calls.push(["refresh",body]);return Response.json({id:42,number:"90042",state:"open",group:"Support",title:body.title})}
    if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json([]);
    if(url.pathname==="/api/v1/ticket_articles"&&method==="POST"){calls.push(["article",body]);return Response.json({id:2})}
    return new Response(null,{status:404});
  };
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})});
    assert.deepEqual(await processor.drainTenant("t1"),{events:1,acknowledgements:0});
    assert.deepEqual(calls.map(call=>call[0]),["refresh","article","complete"]);
    assert.deepEqual(calls[0][1],{state:"open",title:"Maha — WhatsApp conversation",wasalx_latest_external_message_id:"m4"});
    assert.equal(calls[1][1].body,"back again");
    assert.equal(calls[1][1].internal,false);
    assert.equal(calls[1][1].origin_by_id,7);
    assert.equal(calls[1][1].preferences.wasalx_external_message_id,"m4");
  }finally{globalThis.fetch=original}
});

test("reopens closed human tickets and repairs only replaceable titles before appending",async()=>{
  for(const [currentState,currentTitle,expectedRefresh] of [
    ["open","WhatsApp participant — WhatsApp conversation",{title:"Maha — WhatsApp conversation"}],
    ["open","Customer requested a callback",{}],
    ["closed","Customer requested a callback",{state:"open"}],
  ]){
    const event={id:`active-${currentTitle.length}`,tenantId:"t1",connectionId:"c1",provider:"waha",providerEventId:`active-${currentTitle.length}`,eventType:"message.any",attempts:1,payload:{event:"message.any",payload:{id:`message-${currentTitle.length}`,from:"12025550134@lid",body:"still here",timestamp:1_700_000_200}}};
    const calls=[];
    const repository={
      claim:async()=>[event],
      directContext:async()=>({assignmentId:"a1",participantName:"Maha",participantPhone:"+12025550135",zammadGroup:"2",zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret"}),
      processDirectMessage:async(_event,_context,_message,_customer,actions)=>{await actions.append("42");return{duplicate:false,queued:false,state:"HUMAN",ignored:false}},
      complete:async()=>{},fail:async()=>assert.fail("Active direct append must not fail"),
    };
    const original=globalThis.fetch;
    let nativeCustomer;globalThis.fetch=async(input,init)=>{
      const url=new URL(String(input));const method=init?.method??"GET";const body=init?.body?JSON.parse(String(init.body)):undefined;
      if(url.pathname==="/api/v1/users/search"){nativeCustomer={id:7,login:url.searchParams.get("query")?.replace(/^login:/u,""),firstname:"Maha",lastname:"",mobile:"+12025550135"};return Response.json([nativeCustomer])}
    if(url.pathname==="/api/v1/users/7"&&(!init?.method||init.method==="GET"))return Response.json(nativeCustomer);
      if(url.pathname==="/api/v1/tickets/42"&&method==="GET")return Response.json({id:42,number:"90042",state_id:2,...(url.searchParams.get("expand")==="true"?{state:currentState}:{}),group:"Support",title:currentTitle});
      if(url.pathname==="/api/v1/tickets/42"&&method==="PUT"){calls.push(body);return Response.json({id:42,number:"90042",state:"open",group:"Support",title:body.title})}
      if(url.pathname==="/api/v1/ticket_articles/by_ticket/42")return Response.json([]);
      if(url.pathname==="/api/v1/ticket_articles"&&method==="POST")return Response.json({id:2});
      return new Response(null,{status:404});
    };
    try{await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("t1")}finally{globalThis.fetch=original}
    assert.deepEqual(calls,[{wasalx_latest_external_message_id:`message-${currentTitle.length}`,...expectedRefresh}]);
  }
});

// Appended to the existing direct-bot suite; SQL/native HTTP are simulated, not PostgreSQL/provider evidence.
const p03Fixture = JSON.parse(readFileSync(new URL("./fixtures/meta-bsuid-contract.json", import.meta.url), "utf8"));
const p03Asset = { providerSessionId: "90000000-0000-4000-8000-000000000031", phoneNumberId: "12345", wabaId: "67890" };
const p03AppId = "54321";
const p03ParticipantId = "90000000-0000-4000-8000-000000000032";
const p03Lease = "90000000-0000-4000-8000-000000000033";
const p03Canonical = "meta:90000000-0000-4000-8000-000000000034";
const p03Wire = event => event.payload.entry[0].changes[0].value.messages[0];
function p03Event(shape = "joint") {
  const payload = structuredClone(p03Fixture[shape]);
  payload.entry[0].id = p03Asset.wabaId;
  payload.entry[0].changes[0].value.metadata.phone_number_id = p03Asset.phoneNumberId;
  payload.entry[0].changes[0].value.messages[0].timestamp = String(Math.floor(Date.now()/1000)-5);
  return { id: `p03-${shape}`, tenantId: "t1", connectionId: "c1", provider: "meta", providerEventId: `p03-${shape}`, eventType: "messages", attempts: 1, payload };
}
function p03Proof() {
  return { schemaVersion: 1, claim: "PHONE_ACCOUNT_RELATION_VERIFIED", ...p03Asset,
    tenantId: "t1", connectionId: "c1", secretReference: "provider-secret", credentialFingerprint: "a".repeat(64),
    credentialMetadata: verifyMetaCredentialMetadata({ data: { is_valid: true, app_id: p03AppId,
      scopes: ["whatsapp_business_management", "whatsapp_business_messaging"], expires_at: 0 } }, { appId: p03AppId }) };
}
async function p03Message(event) {
  return new MetaGroupsAdapter({ accessToken: "unused-fixture-token", graphVersion: "v24.0", phoneNumberIdFor: () => p03Asset.phoneNumberId })
    .normalizeDirectWebhook(event.connectionId, event.payload);
}
function p03Client(initialEvent, options = {}) {
  let event = initialEvent;
  const state = { aliases: structuredClone(options.aliases ?? []), participant: options.participant,
    writes: [], guards: 0, queries: [], quarantined: false, routing: null, routingSources: new Map(), routingChecks: 0,
    deliveries: [{ id: "historical-unknown", state: "OUTCOME_UNKNOWN", attempts: 1 }] };
  const result = rows => ({ rows, rowCount: rows.length });
  const routingSource = () => {
    if(!state.routingSources.has(event.id)){
      const value=event.payload.entry[0].changes[0].value;
      const evidence=options.legacy?null:{...metaRoutingUnits(p03Asset.wabaId,"messages",value)[0].evidence,...p03Asset,appId:p03AppId};
      const hash=metaLifecyclePayloadSha256(event.payload);
      if(evidence)assert.equal(evidence.payloadSha256,hash);
      state.routingSources.set(event.id,{id:event.id,meta_routing_evidence:evidence,meta_routing_epoch:null,meta_routing_participant_id:null,payload_sha256:hash});
    }
    return state.routingSources.get(event.id);
  };
  const client = { release() {}, async query(sql, values = []) {
    state.queries.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return result([]);
    if (sql.startsWith("SELECT app.meta_direct_transition_receipt_valid(id) AS valid")) {
      assert.deepEqual(values,[event.tenantId,event.connectionId,event.id]);return result([{valid:false}]);
    }
    if (sql.startsWith("SELECT meta_direct_identity_transition,meta_direct_identity_resolution,")) {
      assert.deepEqual(values,[event.tenantId,event.connectionId,event.id]);return result([{valid:false,
        meta_direct_identity_transition:options.transition?metaDirectTransitionEvidence(event.payload,metaLifecyclePayloadSha256(event.payload),{...p03Asset,...options.pinOverrides}):null,meta_direct_identity_resolution:null}]);
    }
    if (sql === "SELECT app.drain_meta_direct_transitions($1,$2,$3) AS result") {
      assert.equal(values[0],event.id);assert.equal(typeof values[1],"string");
      if(options.positiveAdmission){assert.equal(values[2],false);return result([{result:{state:"HELD",reason:"PENDING_EFFECT"}}]);}
      assert.equal(values[2],true);
      const change=parseMetaIdentityChange(p03Wire(event));assert(change);
      const owners=new Set(state.aliases.filter(alias=>(alias.kind==="PHONE"&&alias.value===change.previous.phone)
        ||(alias.kind==="BSUID"&&alias.value===change.previous.bsuid)).map(alias=>alias.participant_identity_id));
      for(const alias of state.aliases)if(owners.has(alias.participant_identity_id)&&alias.state==="ACTIVE")alias.state="HELD";
      state.writes.push({kind:"hold",owners:[...owners]},{kind:"quarantine"});state.quarantined=true;
      return result([{result:{state:"HELD",reason:"REQUIRES_REVIEW"}}]);
    }
    if (sql.includes("FROM privacy_jobs")) return result([{ clear: options.privacyClear !== false }]);
    if (sql.startsWith("SELECT state,secret_reference FROM connections")) return result(options.missingConnection ? [] : [{ state: "WORKING", secret_reference: "provider-secret" }]);
    if (sql.startsWith("SELECT id,state,opaque_session_id,provider_state_data FROM provider_sessions")) {
      const proof = options.legacy ? undefined : { ...p03Proof(), ...options.proofOverrides };
      return result(options.missingSession ? [] : [{ id: p03Asset.providerSessionId, state: "WORKING", opaque_session_id: p03Asset.phoneNumberId,
        provider_state_data: { wabaId: p03Asset.wabaId, ...(proof ? { metaAccountProof: proof } : {}) } }]);
    }
    if (sql.includes("SELECT payload,payload_sha256,meta_direct_asset")) {
      assert.equal(values[2], event.id);
      return result(options.missingInbox ? [] : [{ payload: options.inboxPayload ?? event.payload,
        payload_sha256: metaLifecyclePayloadSha256(event.payload), meta_direct_asset: options.unpinned ? null : { ...p03Asset, ...options.pinOverrides } }]);
    }
    if(sql.startsWith("SELECT connection.secret_reference,session.provider_state_data FROM connections connection JOIN provider_sessions session")) {
      assert.deepEqual(values,[event.tenantId,event.connectionId,p03Asset.providerSessionId]);
      return result([{secret_reference:"provider-secret",provider_state_data:{wabaId:p03Asset.wabaId,metaAccountProof:p03Proof()}}]);
    }
    if (sql.includes("app.meta_lifecycle_guard")) {
      if(options.lifecycleError)throw options.lifecycleError;
      return result([{ revision_matches: true, blocked: false, unresolved_hold: false }]);
    }
    if (sql.includes("app.meta_direct_identity_guard")) {
      state.guards += 1;
      return result([{ clear: typeof options.identityClear === "function" ? options.identityClear(state, values) : options.identityClear !== false }]);
    }
    if (sql.startsWith("SELECT 1 FROM meta_direct_identity_aliases alias JOIN")) return result(options.legacyAlreadyBound ? [{}] : []);
    if (sql.startsWith("SELECT alias.id,alias.participant_identity_id")) return result(state.aliases.filter(alias =>
      (alias.kind === "PHONE" && alias.value === values[5]) || (alias.kind === "BSUID" && alias.value === values[6])));
    if (sql.startsWith("SELECT participant.id,participant.external_participant_id,")) return result(options.existingPhone ? [options.existingPhone] : []);
    if (sql.startsWith("SELECT id FROM participant_identities")) return result(state.participant ? [{id:state.participant.id}] : []);
    if (sql.startsWith("SELECT participant.id,EXISTS")) return result(options.currentParticipant === null ? [] :
      options.currentParticipant ? [options.currentParticipant] : state.participant ? [{ id: state.participant.id,
        has_alias: state.aliases.length > 0, current_alias: state.aliases.some(alias => alias.state === "ACTIVE") }] : []);
    if (sql.startsWith("INSERT INTO participant_identities") && !sql.includes("display_name")) {
      state.participant = { id: p03ParticipantId, external_participant_id: values[2] };
      state.writes.push({ kind: "participant", canonical: values[2], phone: values[3] });
      return result([state.participant]);
    }
    if (sql.startsWith("INSERT INTO meta_direct_identity_aliases")) {
      const alias = { id: `alias-${state.aliases.length}`, participant_identity_id: values[2], kind: values[6], value: values[7],
        state: "ACTIVE", external_participant_id: state.participant.external_participant_id };
      state.aliases.push(alias); state.writes.push({ kind: "alias", alias: structuredClone(alias) }); return result([]);
    }
    if (sql.startsWith("SELECT value FROM meta_direct_identity_aliases")) return result(state.aliases.filter(alias => alias.kind === "PHONE" && alias.state === "ACTIVE").map(alias => ({ value: alias.value })));
    if (sql.startsWith("SELECT kind,value FROM meta_direct_identity_aliases")) return result(state.aliases.map(({ kind, value }) => ({ kind, value })));
    // Finite database responses only: production bindMetaPrimaryRouting runs its real reducer.
    // SQL authority itself is separately qualified by the canonical PostgreSQL fixtures.
    if(sql.startsWith("SELECT id FROM participant_identities")){
      assert.deepEqual(values,[event.tenantId,event.connectionId,p03Fixture.phone]);return result(state.participant?[state.participant]:[]);
    }
    if(sql.startsWith("SELECT id,meta_routing_evidence,meta_routing_epoch")){
      assert.deepEqual(values,[event.tenantId,event.connectionId,event.id]);return result([routingSource()]);
    }
    if(sql.startsWith("SELECT source.id,source.meta_routing_evidence")){
      assert.deepEqual(values,[event.tenantId,event.connectionId,p03Asset.providerSessionId,p03ParticipantId]);return result([]);
    }
    if(sql.startsWith("SELECT * FROM app.meta_direct_routing_guard")){
      const source=routingSource();state.routingChecks++;
      assert.deepEqual(values.slice(0,7),[event.connectionId,p03Asset.providerSessionId,p03Asset.phoneNumberId,p03Asset.wabaId,
        state.participant?.id??null,p03AppId,JSON.stringify({mode:"SIMULATED",graphOrigin:"https://routing-provider.invalid",graphVersion:"v24.0",simulationBindingSha256:"7".repeat(64)})]);
      assert.deepEqual(values[7],values[8]?[event.id]:null);
      const reviewed=options.routingReviewed!==false;
      const allowed=options.legacy?source.meta_routing_epoch===0:reviewed&&(!values[8]||(state.routing?.state==="OWN"
        &&source.meta_routing_epoch===state.routing.epoch&&source.meta_routing_participant_id===state.participant?.id));
      return result([{allowed,epoch:options.legacy?"0":state.routing?.epoch??null,claim:options.legacy?"LEGACY_COMPATIBILITY":state.routing?.state??"HELD",configuration_version:options.legacy?0:1,review_version:options.legacy?0:1}]);
    }
    if(sql.startsWith("SELECT state,epoch,observed_at,epoch_started_at")){
      assert.deepEqual(values,[event.tenantId,event.connectionId,p03Asset.providerSessionId,p03ParticipantId]);return result(state.routing?[state.routing]:[]);
    }
    if(sql.startsWith("INSERT INTO meta_thread_ownership")||sql.startsWith("UPDATE meta_thread_ownership")){
      const updating=sql.startsWith("UPDATE"),previous=state.routing;
      assert.equal(updating,previous!==null,"Existing ownership uses UPDATE; new ownership uses INSERT");
      const source=routingSource();assert.deepEqual(values.slice(0,6),[event.tenantId,event.connectionId,p03Asset.providerSessionId,p03ParticipantId,p03Asset.phoneNumberId,p03Asset.wabaId]);
      assert.deepEqual(values.slice(8,10),[1,1]);assert.deepEqual(values.slice(13),[source.payload_sha256,event.id]);
      assert.equal(values[6],options.routingReviewed===false?"UNKNOWN":"OWN");
      state.routing={state:values[6],epoch:values[7],configuration_version:values[8],review_version:values[9],
        observed_at:new Date(values[10]),epoch_started_at:updating&&Number(previous.epoch)===Number(values[7])?previous.epoch_started_at:new Date(values[11]),
        last_customer_message_at:values[12]===null?null:new Date(values[12]),source_hash:values[13]};return{rows:[],rowCount:1};
    }
    if(sql.startsWith("UPDATE event_inbox SET meta_routing_epoch=0")){
      assert.equal(options.legacy,true);assert.deepEqual(values,[event.tenantId,event.id]);routingSource().meta_routing_epoch=0;return result([]);
    }
    if(sql.startsWith("UPDATE event_inbox SET meta_routing_participant_id=$1,meta_routing_epoch=$2")){
      assert.deepEqual(values,[p03ParticipantId,state.routing.epoch,event.tenantId,event.id]);Object.assign(routingSource(),{meta_routing_participant_id:values[0],meta_routing_epoch:values[1]});return result([]);
    }
    const extra = options.additional?.(sql, values, state);
    if (extra !== undefined) return extra;
    throw new Error(`Unexpected P03 fixture query: ${sql}`);
  } };
  return { client, state, setEvent(next) { event = next; } };
}

test("P03 legacy supplied phone plus BSUID remains phone-only without granting aliases", async (t) => {
  t.after(routingFixtureEnvironment(p03AppId));
  const event = p03Event(), message = await p03Message(event);
  for (const unpinned of [false, true]) {
    const fixture = p03Client(event, { legacy: true, unpinned });
    const resolved = await resolveMetaDirectMessage(fixture.client, event, p03Lease, message, p03AppId);
    assert.equal(resolved.chatId, p03Fixture.phone); assert.equal(resolved.senderId, p03Fixture.phone);
    assert.equal(resolved.senderPhone, `+${p03Fixture.phone}`); assert.deepEqual(fixture.state.writes, []);
    await assertMetaDirectIdentityCurrent(fixture.client, event, p03Lease, resolved.chatId, p03AppId);
    assert.equal(fixture.state.routing,null,"Legacy compatibility is never OWN");assert.equal(fixture.state.routingSources.get(event.id).meta_routing_epoch,0);assert.ok(fixture.state.routingChecks>=2);
  }
  const hidden = p03Event("bsuidOnly"), legacy = p03Client(hidden, { legacy: true }), hiddenMessage = await p03Message(hidden);
  await assert.rejects(() => resolveMetaDirectMessage(legacy.client, hidden, p03Lease, hiddenMessage, p03AppId), MetaDirectIdentityError);
  assert.deepEqual(legacy.state.writes, []);
  const bound = p03Client(event, { legacy: true, legacyAlreadyBound: true });
  await assert.rejects(() => resolveMetaDirectMessage(bound.client, event, p03Lease, message, p03AppId), MetaDirectIdentityError);
  assert.deepEqual(bound.state.writes, []);
});

test("P03 joint and phone-less turns share canonical customer, routed ticket, queued reply and handoff", async (t) => {
  t.after(routingFixtureEnvironment(p03AppId));
  const joint = p03Event(), hidden = p03Event("bsuidOnly");
  p03Wire(hidden).timestamp=String(Number(p03Wire(joint).timestamp)+1);
  const deliveries = [], handoffs = [], normalized = [], completed = [], failures = [], calls = [], results = [];
  const flow = { schemaVersion: 1, name: "Scoped handoff", start: "reply", maxSteps: 4, nodes: [
    { id: "reply", type: "send_text", text: "وصل طلبك: {{message.text}}", next: "handoff" },
    { id: "handoff", type: "handoff", target: "CLIENT_PRIMARY", priority: "2 normal" },
  ] };
  const fixture = p03Client(joint, { additional(sql, values) {
    const empty = { rows: [], rowCount: 0 }, one = rows => ({ rows, rowCount: rows.length });
    if (sql.includes("pg_advisory_xact_lock(") || sql.includes("SELECT 1 FROM normalized_messages") || sql.includes("FROM bot_conversations conversation") || sql.includes("SELECT zammad_ticket_id,zammad_ticket_number")) return empty;
    if (sql.includes("SELECT assignment.flow_version_id")) return one([{ flow_version_id: "flow-1", start_node: "reply", state: "ACTIVE" }]);
    if (sql.startsWith("INSERT INTO normalized_messages")) { normalized.push(values); return one([{ id: "normalized-hidden" }]); }
    if (sql === "SELECT app.seal_meta_direct_native_anchor($1)") { assert.deepEqual(values, [hidden.id]); assert.equal(normalized.length, 1); return one([{ seal_meta_direct_native_anchor: null }]); }
    if (sql.startsWith("INSERT INTO participant_identities") && sql.includes("display_name")) { assert.equal(values[2], p03Fixture.phone); return empty; }
    if (sql.startsWith("INSERT INTO bot_conversations")) return one([{ id: "conversation-1", flow_version_id: "flow-1", state: "BOT", current_node_id: "reply", variables: {}, step_count: 0,
      zammad_ticket_id: "42", zammad_ticket_number: "90042", human_ownership_epoch: 0, fencing_token: 0, last_activity_at: p03Wire(hidden).timestamp }]);
    if (sql.startsWith("SELECT definition FROM bot_flow_versions")) return one([{ definition: flow }]);
    if (sql.startsWith("INSERT INTO delivery_outbox")) { deliveries.push(values); return one([{ id: "queued-reply" }]); }
    if (sql.startsWith("INSERT INTO bot_handoff_jobs")) { handoffs.push(values); return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("UPDATE normalized_messages") || sql.startsWith("INSERT INTO message_links") || sql.startsWith("INSERT INTO delivery_ticket_links") || sql.startsWith("INSERT INTO bot_conversation_events") || sql.startsWith("UPDATE bot_conversations")) return { rows: [], rowCount: 1 };
    return undefined;
  } });
  const first = await resolveMetaDirectMessage(fixture.client, joint, p03Lease, await p03Message(joint), p03AppId);
  assert.equal(first.chatId, p03Fixture.phone); assert.equal(fixture.state.aliases.length, 2);
  const initialRouting=structuredClone(fixture.state.routing);
  fixture.setEvent(hidden);
  const actual = new InboundRepository({ connect: async () => fixture.client });
  const repository = {
    claim: async () => [hidden],
    resolveMetaDirectMessage: (event, lease, message, app) => resolveMetaDirectMessage(fixture.client, event, lease, message, app),
    assertMetaDirectIdentityCurrent: (event, lease, canonical, app) => assertMetaDirectIdentityCurrent(fixture.client, event, lease, canonical, app),
    directContext: async (_event, chat, sender, phone) => {
      assert.deepEqual([chat, sender, phone], [first.chatId, first.senderId, first.senderPhone]);
      return { assignmentId: "assignment-1", assignmentZammadGroup: "2", zammadGroup: "4", ownerId: "12",
        clientRoute: { versionId: "90000000-0000-4000-8000-000000000035", status: "MATCHED", clientId: "acme", matchedBy: "CLIENT_IDENTIFIER" },
        zammadBaseUrl: "https://zammad.example", zammadSecretReference: "native-secret" };
    },
    processDirectMessage: async (...args) => { const result = await actual.processDirectMessage(...args); results.push(result); return result; },
    complete: async (_event, _lease, status) => completed.push(status),
    fail: async (_event, _lease, retryable, error) => failures.push({ retryable, error }),
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    assert.equal(url.origin, "https://zammad.example", "Intake must not call a provider send endpoint");
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/v1/users/search" || url.pathname === "/api/v1/tickets/search") return Response.json([]);
    if (url.pathname === "/api/v1/users") return Response.json({ id: 7, login: body.login, firstname: body.firstname, lastname: "", mobile: body.mobile });
    if (url.pathname === "/api/v1/tickets") return Response.json({ id: 42, number: "90042", state: "open", group: "Sales", title: body.title });
    if (url.pathname === "/api/v1/ticket_articles/by_ticket/42") return Response.json([{ id: 91, preferences: { wasalx_external_message_id: p03Wire(hidden).id } }]);
    throw new Error(`Unexpected P03 native request: ${url.pathname}`);
  };
  try {
    assert.deepEqual(await new InboundProcessor(repository, { resolve: async () => ({ token: "native-fixture-token" }) }, undefined, 8, undefined, p03AppId).drainTenant("t1"), { events: 1, acknowledgements: 1 });
  } finally { globalThis.fetch = original; }
  assert.deepEqual(failures, []); assert.deepEqual(completed, ["PROCESSED"]);
  assert.deepEqual(results, [{ duplicate: false, queued: true, state: "HANDOFF_PENDING", ignored: false }]);
  const customer = calls.find(call => call.path === "/api/v1/users").body, ticket = calls.find(call => call.path === "/api/v1/tickets").body;
  assert.equal(customer.login, `wasalx-${createHash("sha256").update(`t1c1${first.senderId}`).digest("hex")}`);
  assert.equal(customer.mobile, `+${p03Fixture.phone}`); assert.equal(ticket.wasalx_group_id, first.chatId);
  assert.equal(ticket.group_id, 4); assert.equal(ticket.owner_id, 12); assert.equal(ticket.article.origin_by_id, 7);
  assert.equal(ticket.article.body, "مرحبا"); assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0].slice(4, 6), [first.chatId, first.senderId]);
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0][3], first.chatId); assert.equal(deliveries[0][6], "وصل طلبك: مرحبا");
  assert.equal(handoffs.length, 1); assert.deepEqual(handoffs[0].slice(4, 7), ["4", "12", "2 normal"]);
  assert.equal(fixture.state.aliases.length, 2, "Phone-less intake must reuse the jointly admitted aliases");
  assert.equal(fixture.state.routing.state,"OWN");assert.equal(fixture.state.routing.review_version,1);assert.ok(fixture.state.routingChecks>=4);
  assert.equal(fixture.state.routingSources.get(hidden.id).meta_routing_epoch,fixture.state.routing.epoch);
  assert.equal(fixture.state.queries.filter(({sql})=>sql.startsWith("INSERT INTO meta_thread_ownership")).length,1);
  assert.equal(fixture.state.queries.filter(({sql})=>sql.startsWith("UPDATE meta_thread_ownership")).length,1);
  assert.equal(fixture.state.routing.epoch,initialRouting.epoch);
  assert.equal(fixture.state.routing.epoch_started_at.getTime(),initialRouting.epoch_started_at.getTime());
  assert.equal(fixture.state.routing.observed_at.getTime(),initialRouting.observed_at.getTime()+1000);
});

test("P03 rejects substituted adapter identity, message ID and identity-change evidence before writes", async () => {
  const event = p03Event(), message = await p03Message(event);
  for (const changed of [{ ...message, messageId: "wamid.other" }, { ...message, metaIdentity: { ...message.metaIdentity, bsuid: p03Fixture.nextBsuid } }]) {
    const fixture = p03Client(event);
    await assert.rejects(() => resolveMetaDirectMessage(fixture.client, event, p03Lease, changed, p03AppId), MetaDirectIdentityError);
    assert.deepEqual(fixture.state.writes, []);
  }
  const changeEvent = p03Event("change"), change = parseMetaIdentityChange(p03Wire(changeEvent)), fixture = p03Client(changeEvent);
  await assert.rejects(() => holdMetaIdentityChange(fixture.client, changeEvent, p03Lease,
    { ...change, previous: { bsuid: p03Fixture.nextBsuid } }, p03AppId), MetaDirectIdentityError);
  assert.deepEqual(fixture.state.writes, []); assert.equal(fixture.state.quarantined, false);
});

test("P03 missing source, changed asset and missing or foreign canonical identity block native currentness", async () => {
  const event = p03Event(), message = await p03Message(event);
  for (const options of [{ missingConnection: true }, { missingSession: true }, { missingInbox: true },
    { pinOverrides: { providerSessionId: "90000000-0000-4000-8000-000000000099" } },
    { proofOverrides: { wabaId: "99999" } }, { inboxPayload: p03Event("bsuidOnly").payload }]) {
    const fixture = p03Client(event, options);
    await assert.rejects(() => resolveMetaDirectMessage(fixture.client, event, p03Lease, message, p03AppId), MetaDirectIdentityError);
    assert.deepEqual(fixture.state.writes, []);
  }
  for (const currentParticipant of [null, { id: p03ParticipantId, has_alias: true, current_alias: false }]) {
    const fixture = p03Client(event, { currentParticipant });
    await assert.rejects(() => assertMetaDirectIdentityCurrent(fixture.client, event, p03Lease, p03Canonical, p03AppId), MetaDirectIdentityError);
    assert.deepEqual(fixture.state.writes, []);
  }
  const legacy = p03Client(event, { legacy: true });
  await assert.rejects(() => assertMetaDirectIdentityCurrent(legacy.client, event, p03Lease, p03Canonical, p03AppId), MetaDirectIdentityError);
  // Resolve succeeds, but a missing canonical participant at the HTTP boundary must prevent native effects.
  const missing = p03Client(event, { currentParticipant: null }), failures = []; let nativeRequests = 0;
  const repository = { claim: async () => [event],
    resolveMetaDirectMessage: async () => ({ ...message, chatId: p03Canonical, senderId: p03Canonical }),
    assertMetaDirectIdentityCurrent: (input, lease, canonical, app) => assertMetaDirectIdentityCurrent(missing.client, input, lease, canonical, app),
    directContext: async () => ({ assignmentId: "a1", zammadGroup: "2", zammadBaseUrl: "https://zammad.example", zammadSecretReference: "native-secret" }),
    processDirectMessage: async () => assert.fail("Missing canonical identity must not advance the flow"),
    complete: async () => assert.fail("Missing canonical identity must not be admitted"),
    fail: async (_event, _lease, retryable, error) => failures.push({ retryable, error }) };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { nativeRequests += 1; throw new Error("Must not dispatch native HTTP"); };
  try { await new InboundProcessor(repository, { resolve: async () => ({ token: "native-fixture-token" }) }, undefined, 8, undefined, p03AppId).drainTenant("t1"); }
  finally { globalThis.fetch = original; }
  assert.equal(nativeRequests, 0); assert.equal(failures.length, 1); assert.equal(failures[0].retryable, false);
});

test("P03 privacy and held identity block effects, including a hold revealed by newly inserted aliases", async () => {
  const event = p03Event(), message = await p03Message(event);
  const heldAlias = { id: "held-bsuid", participant_identity_id: p03ParticipantId, external_participant_id: p03Canonical,
    kind: "BSUID", value: p03Fixture.bsuid, state: "HELD" };
  const conflictingSlots = [
    { ...heldAlias, id: "active-phone", kind: "PHONE", value: p03Fixture.phone, state: "ACTIVE" },
    { ...heldAlias, id: "older-bsuid", value: p03Fixture.nextBsuid, state: "ACTIVE" },
  ];
  for (const options of [{ privacyClear: false }, { identityClear: false }, { aliases: [heldAlias] }, { aliases: conflictingSlots }]) {
    const fixture = p03Client(event, options), unknown = structuredClone(fixture.state.deliveries);
    await assert.rejects(() => resolveMetaDirectMessage(fixture.client, event, p03Lease, message, p03AppId), MetaDirectIdentityError);
    assert.deepEqual(fixture.state.writes, []); assert.deepEqual(fixture.state.deliveries, unknown);
  }
  const fixture = p03Client(event, { identityClear: state => state.aliases.length === 0 });
  const failures = []; let effects = 0;
  const repository = { claim: async () => [event],
    resolveMetaDirectMessage: (input, lease, direct, app) => resolveMetaDirectMessage(fixture.client, input, lease, direct, app),
    directContext: async () => { effects += 1; throw new Error("Must not route rejected identity"); },
    complete: async () => assert.fail("Held identity must not complete as ordinary input"),
    fail: async (_event, _lease, retryable, error) => failures.push({ retryable, error }) };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { effects += 1; throw new Error("Must not contact native/provider"); };
  try { await new InboundProcessor(repository, { resolve: async () => { effects += 1; return {}; } },
    { prepare: async () => { effects += 1; } }, 8, undefined, p03AppId).drainTenant("t1"); }
  finally { globalThis.fetch = original; }
  assert.equal(fixture.state.aliases.length, 2, "The fake exposes the post-insert hold; real PG separately proves rollback");
  assert.equal(effects, 0); assert.equal(failures.length, 1); assert.equal(failures[0].retryable, false);
});

test("P03 valid and malformed system changes never become customer, media, ticket or bot input", async () => {
  const valid = p03Event("change"), malformed = p03Event("change"); malformed.id = "p03-malformed-change";
  p03Wire(malformed).system.user_id = null;
  const aliases = ["PHONE", "BSUID"].map(kind => ({ id: `old-${kind}`, participant_identity_id: p03ParticipantId,
    external_participant_id: p03Canonical, kind, value: kind === "PHONE" ? p03Fixture.phone : p03Fixture.bsuid, state: "ACTIVE" }));
  const fixture = p03Client(valid, { aliases }), originalUnknown = structuredClone(fixture.state.deliveries);
  const failures = []; let effects = 0, held = 0;
  const noEffect = async () => { effects += 1; throw new Error("System change must remain inert"); };
  const repository = { claim: async () => [valid, malformed],
    applyMetaIdentityTransition: async (event, lease, change, app) => { held += 1; await holdMetaIdentityChange(fixture.client, event, lease, change, app); },
    resolveMetaDirectMessage: noEffect, assertMetaDirectIdentityCurrent: noEffect, directContext: noEffect,
    processDirectMessage: noEffect, context: noEffect, complete: noEffect,
    fail: async (event, _lease, retryable, error) => failures.push({ id: event.id, retryable, error }) };
  const original = globalThis.fetch; globalThis.fetch = noEffect;
  try { assert.deepEqual(await new InboundProcessor(repository, { resolve: noEffect }, { prepare: noEffect }, 8, undefined, p03AppId).drainTenant("t1"), { events: 2, acknowledgements: 0 }); }
  finally { globalThis.fetch = original; }
  assert.equal(effects, 0); assert.equal(held, 1); assert.equal(fixture.state.quarantined, true);
  assert.deepEqual(fixture.state.aliases.map(alias => alias.state), ["HELD", "HELD"]);
  assert.deepEqual(fixture.state.deliveries, originalUnknown);
  assert.deepEqual(failures.map(({ id, retryable }) => ({ id, retryable })), [{ id: malformed.id, retryable: false }]);
  assert.equal(fixture.state.writes.filter(write => write.kind === "participant" || write.kind === "alias").length, 0);
});

test("P03 denied initial source privacy or lease never reaches generic processor failure or effects",async()=>{
  for(const options of [{privacyClear:false},{missingInbox:true}]){
    const event=p03Event("change"),fixture=p03Client(event,options),failures=[];let effects=0;
    const noEffect=async()=>{effects++;throw new Error("Denied identity source must remain unchanged");};
    const repository={claim:async()=>[event],
      applyMetaIdentityTransition:(input,lease,change,app)=>applyMetaIdentityTransition(fixture.client,input,lease,change,app),
      resolveMetaDirectMessage:noEffect,assertMetaDirectIdentityCurrent:noEffect,directContext:noEffect,
      processDirectMessage:noEffect,context:noEffect,complete:noEffect,
      fail:async(...args)=>{failures.push(args);}};
    assert.deepEqual(await new InboundProcessor(repository,{resolve:noEffect},{prepare:noEffect},8,undefined,p03AppId).drainTenant("t1"),{events:1,acknowledgements:0});
    assert.equal(effects,0);assert.deepEqual(failures,[]);assert.deepEqual(fixture.state.writes,[]);
    assert.equal(fixture.state.queries.some(({sql})=>sql.includes("app.drain_meta_direct_transitions")),false);
  }
});
test("P03 fresh lifecycle database failure stays observable and cannot terminally hold an identity source",async()=>{
  const event=p03Event("change"),error=Object.assign(new Error("Synthetic lifecycle SQL denial"),{code:"42501"}),fixture=p03Client(event,{transition:true,lifecycleError:error});
  assert(metaDirectTransitionEvidence(event.payload,metaLifecyclePayloadSha256(event.payload),p03Asset));
  await assert.rejects(applyMetaIdentityTransition(fixture.client,event,p03Lease,parseMetaIdentityChange(p03Wire(event)),p03AppId),observed=>observed===error);
  assert.deepEqual(fixture.state.writes,[]);assert.equal(fixture.state.queries.some(({sql})=>sql.includes("app.drain_meta_direct_transitions")),false);
});

test("P03 current identity with unreviewed routing cannot reach customer, bot or native effects",async(t)=>{
  t.after(routingFixtureEnvironment(p03AppId));
  const event=p03Event(),fixture=p03Client(event,{routingReviewed:false}),failures=[];let effects=0;
  const noEffect=async()=>{effects++;throw new Error("Routing hold must prevent effects")};
  const repository={claim:async()=>[event],resolveMetaDirectMessage:(input,lease,message,app)=>resolveMetaDirectMessage(fixture.client,input,lease,message,app),
    directContext:noEffect,processDirectMessage:noEffect,complete:noEffect,fail:async(_event,_lease,_retryable,error)=>failures.push(error)};
  const original=globalThis.fetch;globalThis.fetch=noEffect;
  try{await new InboundProcessor(repository,{resolve:noEffect},{prepare:noEffect},8,undefined,p03AppId).drainTenant("t1");}
  finally{globalThis.fetch=original;}
  assert.equal(fixture.state.routing.state,"UNKNOWN");assert.equal(effects,0);assert.equal(failures.length,1);
  assert.ok(fixture.state.routingChecks>=2);assert.deepEqual(fixture.state.deliveries,[{id:"historical-unknown",state:"OUTCOME_UNKNOWN",attempts:1}]);
});

test('P09 worker retains signed predecessor evidence but validates the current target before sealed metadata admission',async()=>{
 const originalAsset={...p03Asset,providerSessionId:'72000000-0000-4000-8000-000000000002',wabaId:'777'};
 const event=p03Event('change');event.payload.entry[0].id=originalAsset.wabaId;
 for(const valid of [true,false]){
  let ancestryReads=0;
  const fixture=p03Client(event,{transition:true,pinOverrides:originalAsset,positiveAdmission:true,additional:(sql,values)=>{
   if(sql.startsWith('SELECT app.meta_account_identity_asset_ancestor')){
    ancestryReads++;assert.deepEqual(values,[event.connectionId,JSON.stringify(originalAsset),JSON.stringify(p03Asset)]);
    return{rows:[{valid}],rowCount:1};
   }
  }});
  assert.equal((await applyMetaIdentityTransition(fixture.client,event,p03Lease,parseMetaIdentityChange(p03Wire(event)),p03AppId)).state,'HELD');
  assert.equal(ancestryReads,1);assert.deepEqual(fixture.state.writes,[]);
  const admission=fixture.state.queries.filter(({sql})=>sql.includes('app.drain_meta_direct_transitions'));
  assert.equal(admission.length,valid?1:0);if(valid)assert.equal(admission[0].values[2],false);
 }
 const ordinary=p03Event('joint'),fixture=p03Client(ordinary,{pinOverrides:originalAsset,additional:()=>{throw new Error('Ordinary source must not request an ancestry exception');}});
 await assert.rejects(resolveMetaDirectMessage(fixture.client,ordinary,p03Lease,await p03Message(ordinary),p03AppId),MetaDirectIdentityError);
 assert.deepEqual(fixture.state.writes,[]);
});

// Explicit entry-command runtime contracts: synthetic actors and a local SQL boundary.
function commandRuntimeFixture(options = {}) {
  const commandFlow = { schemaVersion: 1, name: "Synthetic entry", start: "menu", maxSteps: 10, entryCommands: [
    { id: "special_entry", aliases: ["Special package"], target: "special", enabled: true },
  ], nodes: [
    { id: "menu", type: "choice", prompt: "Choose", options: [{ id: "continue", label: "Continue", next: "done" }] },
    { id: "special", type: "send_text", text: "{{message.text}}", next: "done" },
    { id: "done", type: "end" },
  ] };
  if(options.menuCollision)commandFlow.nodes[0].options=[{id:"special",label:"Special package",next:"special"}];
  const legacyFlow = { schemaVersion: 1, name: "Pinned legacy", start: "menu", maxSteps: 10, nodes: [commandFlow.nodes[0], commandFlow.nodes[2]] };
  const definition = options.pinnedLegacy ? legacyFlow : commandFlow;
  const event = { id: "entry-event", tenantId: "entry-tenant", connectionId: "entry-connection", provider: "waha", providerEventId: "entry-wire", eventType: "message", attempts: 1, payload: {} };
  const context = { assignmentId: "entry-assignment", assignmentZammadGroup: "2", zammadGroup: "2", zammadBaseUrl: "https://native.invalid", zammadSecretReference: "secret://synthetic/native" };
  const message = { provider: "waha", messageId: "entry-message", chatId: "12025550106@c.us", senderId: "12025550106@c.us",
    input: { type: "text", text: "Special package" }, fromMe: Boolean(options.fromMe), timestamp: new Date(options.invalidTime ? "invalid" : options.stale ? "2026-10-18T11:59:59Z" : "2026-10-18T12:01:00Z") };
  const conversation = { id: "entry-conversation", flow_version_id: "pinned-flow", state: options.state ?? "BOT", current_node_id: "menu", variables: { "action.stale": "unrelated", "message.old": "old" }, step_count: 1,
    zammad_customer_id: 7, zammad_ticket_id: "42", zammad_ticket_number: "90042", human_ownership_epoch: 0, human_pause_started_at: null, customer_control: null, fencing_token: 1, last_activity_at: new Date("2026-10-18T12:00:00Z") };
  const state = { queries: [], normalized: 0, append: 0, create: 0, deliveries: [], events: [], updates: [], messageSeen: false };
  const result = rows => ({ rows, rowCount: rows.length });
  const client = { release() {}, query: async (sql, values = []) => {
    state.queries.push(sql);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return result([]);
    if (sql.includes("SELECT 1 FROM normalized_messages")) return result(state.messageSeen ? [{}] : []);
    if (sql.includes("FROM bot_conversations conversation") && sql.includes("FOR UPDATE OF conversation")) return result(options.fresh ? [] : [conversation]);
    if (sql.includes("SELECT assignment.flow_version_id")) return result([{ flow_version_id: "assigned-flow", start_node: "menu", state: options.paused ? "PAUSED" : "ACTIVE", definition: commandFlow }]);
    if (sql.includes("SELECT 'reply' AS kind")) return result(options.nativeUnknown ? [{ id: "held-native" }] : []);
    if (sql.includes("SELECT 'delivery' AS kind")) return result(options.effectsUnknown ? [{ id: "held-effect" }] : []);
    if (sql.startsWith("SELECT definition FROM bot_flow_versions")) return result([{ definition }]);
    if (sql.startsWith("INSERT INTO normalized_messages")) { state.normalized++; state.messageSeen = true; return result([{ id: "entry-normalized" }]); }
    if (sql.includes("FROM bot_conversations WHERE") && sql.includes("state='RESOLVED'")) return result([]);
    if (sql.startsWith("INSERT INTO bot_conversations")) return result([conversation]);
    if (sql.startsWith("INSERT INTO delivery_outbox")) { state.deliveries.push(values); return result([{ id: "entry-delivery" }]); }
    if (sql.startsWith("INSERT INTO bot_conversation_events")) { state.events.push(values); return result([]); }
    if (sql.startsWith("UPDATE bot_conversations")) { state.updates.push(values); return result([]); }
    if (sql.includes("participant_identities") || sql.startsWith("UPDATE normalized_messages") || sql.startsWith("INSERT INTO message_links") || sql.startsWith("INSERT INTO delivery_ticket_links")) return result([]);
    throw new Error(`Unexpected entry boundary query: ${sql}`);
  } };
  const repository = new InboundRepository({ connect: async () => client });
  const run = () => repository.processDirectMessage(event, context, message, { id: options.foreignCustomer ? 8 : 7, login: "synthetic" }, {
    create: async () => { state.create++; return { id: "42", number: "90042", articleId: "7" }; },
    append: async () => { state.append++; return "7"; },
  });
  return { state, run };
}

test("entry commands: settled own BOT dispatch consumes one input and clears stale branch variables", async () => {
  const fixture = commandRuntimeFixture();
  const result = await fixture.run();
  assert.equal(result.state, "RESOLVED");
  assert.equal(fixture.state.deliveries.length, 1);
  assert.equal(fixture.state.deliveries[0][6], "Special package");
  assert.deepEqual(fixture.state.updates.at(-1)[3], { "message.text": "Special package" });
  assert.equal(JSON.parse(fixture.state.events.at(-1)[6]).entry_command_id, "special_entry");
  assert.ok(fixture.state.queries.findIndex(sql => sql.includes("SELECT 'delivery' AS kind")) < fixture.state.queries.findIndex(sql => sql.startsWith("INSERT INTO normalized_messages")));
  assert.equal((await fixture.run()).duplicate, true);
  assert.equal(fixture.state.deliveries.length, 1);
  assert.equal(fixture.state.append, 1);
});

for (const held of ["nativeUnknown", "effectsUnknown"]) test(`entry commands: ${held} holds input before persistence and native append`, async () => {
  const fixture = commandRuntimeFixture({ [held]: true });
  assert.equal((await fixture.run()).pendingTarget, true);
  assert.equal(fixture.state.normalized, 0); assert.equal(fixture.state.append, 0); assert.equal(fixture.state.deliveries.length, 0);
});

for (const invalid of ["stale", "foreignCustomer"]) test(`entry commands: ${invalid} cannot jump or persist an input`, async () => {
  const fixture = commandRuntimeFixture({ [invalid]: true });
  assert.equal((await fixture.run()).ignored, true);
  assert.equal(fixture.state.normalized, 0); assert.equal(fixture.state.append, 0); assert.equal(fixture.state.deliveries.length, 0);
});

for (const options of [{ state: "HUMAN" }, { state: "ACTION_PENDING" }, { state: "HANDOFF_PENDING" }, { paused: true }, { fromMe: true }]) test(`entry commands: ownership fence ${JSON.stringify(options)} remains inert`, async () => {
  const fixture = commandRuntimeFixture(options);
  assert.equal((await fixture.run()).queued, false);
  assert.equal(fixture.state.deliveries.length, 0);
  assert.equal(fixture.state.events.some(values => JSON.parse(values.at(-1)).entry_command_id), false);
});

test("entry commands: a fresh conversation uses explicit entry before an undisplayed start menu", async () => {
  const fixture = commandRuntimeFixture({ fresh: true });
  assert.equal((await fixture.run()).state, "RESOLVED");
  assert.equal(fixture.state.create, 1); assert.equal(fixture.state.append, 0);
  assert.equal(fixture.state.deliveries[0][6], "Special package");
});

test("entry commands: an existing legacy conversation ignores new assignment commands", async () => {
  const fixture = commandRuntimeFixture({ pinnedLegacy: true });
  assert.equal((await fixture.run()).state, "BOT");
  assert.equal(fixture.state.deliveries[0][6], "Choose");
  assert.equal(JSON.parse(fixture.state.events.at(-1)[6]).entry_command_id, undefined);
});

test("entry commands: invalid time on a fresh conversation is refused before ticket creation", async () => {
  const fixture = commandRuntimeFixture({ fresh: true, invalidTime: true });
  assert.equal((await fixture.run()).ignored, true);
  assert.equal(fixture.state.normalized, 0); assert.equal(fixture.state.create, 0); assert.equal(fixture.state.deliveries.length, 0);
});

test("entry commands: existing current menu wins a same-target alias without resetting its branch", async () => {
  const fixture = commandRuntimeFixture({ menuCollision: true });
  assert.equal((await fixture.run()).state, "RESOLVED");
  assert.equal(JSON.parse(fixture.state.events.at(-1)[6]).entry_command_id, undefined);
  assert.equal(fixture.state.updates.at(-1)[3]["action.stale"], "unrelated");
});
