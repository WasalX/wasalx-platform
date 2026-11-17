import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { WahaAdapter } from "../services/connector-worker/dist/packages/connectors/src/waha.js";
import { InboundProcessor as ProductionInboundProcessor } from "../services/connector-worker/dist/services/connector-worker/src/inbound-processor.js";
import { InboundRepository } from "../services/connector-worker/dist/services/connector-worker/src/inbound-repository.js";

const adapter=new WahaAdapter({baseUrl:"https://waha.invalid",apiKey:"unused",sessionFor:()=>"unused"});
class InboundProcessor extends ProductionInboundProcessor {
  constructor(repository,...dependencies){super({messageIsWithinAdmissionWindow:async()=>true,hasRunnableGroupBinding:async()=>false,renewWahaWorkerAssignment:async(_event,context)=>context,...repository},...dependencies)}
}
const basePayload={
  event:"message.edited",
  timestamp:1_786_291_200_000,
  payload:{
    id:["false","447700900005@g.us","ACTIONTOKEN","447700900010@c.us"].join("_"),
    chatId:"447700900005@g.us",
    participant:"447700900010@c.us",
    notifyName:"Operations member",
    editedMessageId:"TARGETTOKEN",
    body:"Updated shipment 1234567890",
    fromMe:false,
    source:"app",
    timestamp:1_786_291_200_000,
  },
};

test("WAHA group edit and revoke events normalize to exact bounded target candidates",async()=>{
  const edited=await adapter.normalizeMutationWebhook("connection-a",basePayload,new Headers({"x-webhook-request-id":"event-edit"}));
  assert.deepEqual(edited,{
    provider:"waha",connectionId:"connection-a",eventId:"event-edit",
    actionMessageId:["false","447700900005@g.us","ACTIONTOKEN","447700900010@c.us"].join("_"),kind:"EDITED",
    targetMessageIdCandidates:[["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),"false_447700900005@g.us_TARGETTOKEN"],
    groupId:"447700900005@g.us",participantId:"447700900010@c.us",participantName:"Operations member",
    replacementText:"Updated shipment 1234567890",fromApi:false,fromMe:false,
    timestamp:"2026-08-09T16:00:00.000Z",
  });
  const revoked=await adapter.normalizeMutationWebhook("connection-a",{
    ...basePayload,event:"message.revoked",
    payload:{...basePayload.payload,id:undefined,editedMessageId:undefined,revokedMessageId:"TARGETTOKEN",body:undefined,after:{...basePayload.payload,id:["false","447700900005@g.us","REVOKEACTION","447700900010@c.us"].join("_"),body:undefined}},
  },new Headers());
  assert.equal(revoked?.kind,"REVOKED");
  assert.equal(revoked?.replacementText,undefined);
  const beforeNull={event:"message.revoked",timestamp:basePayload.timestamp,payload:{before:null,revokedMessageId:"TARGETTOKEN",after:{id:["false","447700900005@g.us","REVOKEACTION","447700900010@c.us"].join("_"),from:"447700900005@g.us",fromMe:false}}};
  const withoutBefore=await adapter.normalizeMutationWebhook("connection-a",beforeNull,new Headers());
  assert.equal(withoutBefore?.kind,"REVOKED");
  assert.deepEqual(withoutBefore?.targetMessageIdCandidates,[["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),"false_447700900005@g.us_TARGETTOKEN"]);
  assert.equal(withoutBefore?.replacementText,undefined);
  assert.equal(await adapter.normalizeMutationWebhook("connection-a",{...beforeNull,payload:{...beforeNull.payload,after:null}},new Headers()),null);
  assert.equal(await adapter.normalizeMutationWebhook("connection-a",{...basePayload,payload:{...basePayload.payload,chatId:"447700900006@c.us"}},new Headers()),null);
  assert.equal(await adapter.normalizeMutationWebhook("connection-a",{...basePayload,payload:{...basePayload.payload,editedMessageId:"unsafe_target"}},new Headers()),null);
  assert.equal((await adapter.normalizeMutationWebhook("connection-a",{...basePayload,payload:{...basePayload.payload,source:"api"}},new Headers()))?.fromApi,true);
  const direct=await adapter.normalizeMutationWebhook("connection-a",{...basePayload,payload:{...basePayload.payload,id:"false_12025550102@c.us_ACTIONTOKEN",chatId:"12025550102@c.us",participant:undefined}},new Headers());
  assert.deepEqual(direct?.targetMessageIdCandidates,[["false","12025550102@c.us","TARGETTOKEN","12025550102@c.us"].join("_"),"false_12025550102@c.us_TARGETTOKEN"]);
  assert.equal(direct?.participantId,"12025550102@c.us");
});

test("WAHA session provisioning subscribes to mutation events",async()=>{
  const source=await readFile(new URL("../services/connector-worker/src/connection-operation-processor.ts",import.meta.url),"utf8");
  assert.match(source,/"message\.edited"/);
  assert.match(source,/"message\.revoked"/);
});

test("mutation history is tenant-scoped, exact-match, bounded, and linked only to mapped tickets",async()=>{
  const queries=[];
  const client={
    async query(sql,params=[]){
      queries.push({sql:String(sql),params});
      if(String(sql).includes("FROM normalized_messages"))return{rows:[{id:"normalized-a",external_message_id:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),provider_metadata:{mutations:Array.from({length:20},(_,index)=>({event_id:`old-${index}`}))}}]};
      if(String(sql).includes("UPDATE normalized_messages"))return{rows:[],rowCount:1};
      if(String(sql).includes("FROM message_links"))return{rows:[{zammad_ticket_id:"42"},{zammad_ticket_id:"43"}]};
      return{rows:[],rowCount:0};
    },
    release(){},
  };
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"inbox-a",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-edit",eventType:"message.edited",payload:basePayload,attempts:1};
  const mutation=await adapter.normalizeMutationWebhook(event.connectionId,basePayload,new Headers({"x-webhook-request-id":event.providerEventId}));
  assert.ok(mutation);
  assert.deepEqual(await repository.recordMessageMutation(event,mutation),{
    targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42","43"],alreadyRecorded:false,
  });
  const select=queries.find(item=>item.sql.includes("external_message_id=ANY"));
  assert.deepEqual(select?.params,["tenant-a","connection-a","447700900005@g.us",mutation.targetMessageIdCandidates,false]);
  assert.match(select.sql,/NOT \$5[\s\S]*message\.history_captured_at IS NOT NULL[\s\S]*tenant\.group_workspace_enabled AND workspace\.capture_enabled[\s\S]*message\.provider_timestamp>=workspace\.enabled_at/u);
  const update=queries.find(item=>item.sql.includes("jsonb_set"));
  const stored=JSON.parse(update.params[0]);
  assert.equal(stored.length,20);
  assert.equal(stored[0].event_id,"old-1");
  assert.deepEqual(stored.at(-1),{
    event_id:"event-edit",kind:"EDITED",action_message_id:["false","447700900005@g.us","ACTIONTOKEN","447700900010@c.us"].join("_"),
    target_message_id:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),participant_id:"447700900010@c.us",
    observed_at:"2026-08-09T16:00:00.000Z",replacement_text:"Updated shipment 1234567890",
  });
});

test("a delayed edit after revocation keeps deletion terminal and never republishes replacement text",async()=>{
  const queries=[];
  const client={
    async query(sql,params=[]){
      queries.push({sql:String(sql),params});
      if(String(sql).includes("FROM normalized_messages"))return{rows:[{id:"normalized-a",external_message_id:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),provider_metadata:{mutations:[{event_id:"event-revoke",kind:"REVOKED"}]}}]};
      if(String(sql).includes("UPDATE normalized_messages"))return{rows:[],rowCount:1};
      if(String(sql).includes("FROM message_links"))return{rows:[{zammad_ticket_id:"42"}]};
      return{rows:[],rowCount:0};
    },
    release(){},
  };
  const repository=new InboundRepository({connect:async()=>client});
  const event={id:"inbox-edit-after-revoke",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-edit-after-revoke",eventType:"message.edited",payload:basePayload,attempts:1};
  const mutation=await adapter.normalizeMutationWebhook(event.connectionId,basePayload,new Headers({"x-webhook-request-id":event.providerEventId}));
  assert.ok(mutation);
  assert.deepEqual(await repository.recordMessageMutation(event,mutation,true),{
    targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:false,supersededByRevocation:true,
  });
  assert.equal(queries.find(item=>item.sql.includes("external_message_id=ANY")).params[4],true);
  assert.equal(queries.some(item=>item.sql.includes("jsonb_set")),false);

  const completed=[];let resolved=false;
  const processorRepository={
    claim:async()=>[event],context:async()=>({zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret://zammad"}),
    recordMessageMutation:async()=>({targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:false,supersededByRevocation:true}),
    complete:async(_event,_lease,status,redact,reason)=>completed.push({status,redact,reason}),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  const processor=new InboundProcessor(processorRepository,{resolve:async()=>{resolved=true;return{token:"must-not-be-used"}}});
  assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.equal(resolved,false);
  assert.deepEqual(completed,[{status:"PROCESSED",redact:true,reason:"EDIT_AFTER_REVOKE_SUPPRESSED"}]);
});

test("an opted-in unbound group records mutations and updates linked tickets without an automation binding",async()=>{
  const event={id:"inbox-workspace-edit",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-workspace-edit",eventType:"message.edited",payload:basePayload,attempts:1};
  const calls=[];let posted;
  const repository={
    claim:async()=>[event],context:async()=>null,
    workspaceMutationContext:async()=>({zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret://zammad"}),
    recordMessageMutation:async(_event,_mutation,workspaceOnly)=>{calls.push(`workspace:${workspaceOnly}`);return{targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:false}},
    complete:async(_event,_lease,status,redact)=>calls.push(`${status}:${redact}`),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    if(String(input).includes("/ticket_articles/by_ticket/42"))return Response.json([]);
    if(String(input).endsWith("/api/v1/ticket_articles")){posted=JSON.parse(String(init?.body));return Response.json({id:93},{status:201})}
    throw new Error(`unexpected request ${input}`);
  };
  try{
    assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("tenant-a"),{events:1,acknowledgements:0});
  }finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,["workspace:true","PROCESSED:true"]);
  assert.equal(posted.preferences.wasalx_mutation_kind,"EDITED");
});

test("an unlinked group-history mutation completes without unnecessary retries or Zammad access",async()=>{
  const event={id:"inbox-unlinked-edit",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-unlinked-edit",eventType:"message.edited",payload:basePayload,attempts:1};
  const completed=[];let resolved=false;
  const repository={
    claim:async()=>[event],context:async()=>null,
    workspaceMutationContext:async()=>({}),
    recordMessageMutation:async()=>({targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:[],alreadyRecorded:false}),
    complete:async(_event,_lease,status,redact,reason)=>completed.push({status,redact,reason}),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>{resolved=true;return{token:"unused"}}}).drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.equal(resolved,false);
  assert.deepEqual(completed,[{status:"PROCESSED",redact:true,reason:"UNLINKED_MESSAGE_MUTATION"}]);
});

test("an opted-in group records a linked mutation before retrying unavailable Zammad projection",async()=>{
  const event={id:"inbox-linked-edit-zammad-down",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-linked-edit-zammad-down",eventType:"message.edited",payload:basePayload,attempts:1};
  const calls=[];let resolved=false;
  const repository={
    claim:async()=>[event],context:async()=>null,
    workspaceMutationContext:async()=>({}),
    recordMessageMutation:async(_event,_mutation,workspaceOnly)=>{calls.push(`record:${workspaceOnly}`);return{targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:false}},
    complete:async()=>{throw new Error("mutation must wait for linked-ticket projection")},
    fail:async(_event,_lease,retryable,error)=>calls.push(`fail:${retryable}:${error}`),
  };
  assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>{resolved=true;return{token:"unused"}}}).drainTenant("tenant-a"),{events:1,acknowledgements:0});
  assert.equal(resolved,false);
  assert.deepEqual(calls,["record:true","fail:true:Zammad mutation projection is temporarily unavailable"]);
});

test("workspace mutation authorization is independent of Zammad health",async()=>{
  const source=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
  assert.match(source,/LEFT JOIN zammad_instances zammad ON zammad\.tenant_id=group_record\.tenant_id AND zammad\.state='WORKING'/u);
  assert.match(source,/Promise<Partial<Pick<InboundContext,"zammadBaseUrl"\|"zammadSecretReference">>\|null>/u);
});

test("a correlated edit creates one replay-safe internal Zammad note",async()=>{
  const event={id:"inbox-a",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-edit",eventType:"message.edited",payload:basePayload,attempts:1};
  const completed=[];
  const repository={
    claim:async()=>[event],
    context:async()=>({zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret://zammad"}),
    recordMessageMutation:async()=>({targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:false}),
    complete:async(_event,_lease,status,redact)=>completed.push({status,redact}),
    fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  const originalFetch=globalThis.fetch;
  const requests=[];
  globalThis.fetch=async(input,init)=>{
    requests.push({url:String(input),init});
    if(String(input).includes("/ticket_articles/by_ticket/42"))return new Response(JSON.stringify([]),{status:200});
    if(String(input).endsWith("/api/v1/ticket_articles"))return new Response(JSON.stringify({id:91}),{status:201});
    throw new Error(`unexpected request ${input}`);
  };
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    const posted=JSON.parse(String(requests.find(item=>item.init?.method==="POST")?.init?.body));
    assert.equal(posted.ticket_id,42);
    assert.equal(posted.internal,true);
    assert.equal(posted.type,"note");
    assert.equal(posted.sender,"Agent");
    assert.match(posted.body,/Updated shipment 1234567890/);
    assert.deepEqual(posted.preferences,{
      wasalx_origin:"provider",wasalx_external_message_id:["false","447700900005@g.us","ACTIONTOKEN","447700900010@c.us"].join("_"),
      wasalx_mutation_event_id:"event-edit",wasalx_mutation_kind:"EDITED",
      wasalx_mutation_target_message_id:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),
    });
    assert.deepEqual(completed,[{status:"PROCESSED",redact:true}]);
  }finally{globalThis.fetch=originalFetch}
});

test("a direct-chat edit reuses the same append-only Zammad mutation path",async()=>{
  const payload={...basePayload,payload:{...basePayload.payload,id:"false_12025550102@c.us_ACTIONTOKEN",chatId:"12025550102@c.us",participant:undefined}};
  const event={id:"inbox-direct",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-direct-edit",eventType:"message.edited",payload,attempts:1};
  let usedGroupContext=false;let posted;
  const repository={
    claim:async()=>[event],context:async()=>{usedGroupContext=true;return null},
    directContext:async()=>({zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret://zammad"}),
    recordMessageMutation:async()=>({targetExternalMessageId:["false","12025550102@c.us","TARGETTOKEN","12025550102@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:false}),
    complete:async()=>{},fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    if(String(input).includes("/ticket_articles/by_ticket/42"))return Response.json([]);
    if(String(input).endsWith("/api/v1/ticket_articles")){posted=JSON.parse(String(init?.body));return Response.json({id:92},{status:201})}
    throw new Error(`unexpected request ${input}`);
  };
  try{
    assert.deepEqual(await new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})}).drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.equal(usedGroupContext,false);
    assert.equal(posted.internal,true);
    assert.equal(posted.preferences.wasalx_mutation_kind,"EDITED");
  }finally{globalThis.fetch=originalFetch}
});

test("a replay observes the existing mutation note and does not post twice",async()=>{
  const event={id:"inbox-a",tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:"event-edit",eventType:"message.edited",payload:basePayload,attempts:2};
  let posts=0;
  const repository={
    claim:async()=>[event],context:async()=>({zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret://zammad"}),
    recordMessageMutation:async()=>({targetExternalMessageId:["false","447700900005@g.us","TARGETTOKEN","447700900010@c.us"].join("_"),ticketIds:["42"],alreadyRecorded:true}),
    complete:async()=>{},fail:async(_event,_lease,_retryable,error)=>{throw new Error(`unexpected failure: ${error}`)},
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    if(init?.method==="POST")posts++;
    if(String(input).includes("/ticket_articles/by_ticket/42"))return new Response(JSON.stringify([{id:91,preferences:{wasalx_mutation_event_id:"event-edit"}}]),{status:200});
    throw new Error(`unexpected request ${input}`);
  };
  try{
    const processor=new InboundProcessor(repository,{resolve:async()=>({token:"zammad-token"})});
    assert.deepEqual(await processor.drainTenant("tenant-a"),{events:1,acknowledgements:0});
    assert.equal(posts,0);
  }finally{globalThis.fetch=originalFetch}
});

test("an out-of-order mutation retries briefly, then redacts as unmatched without guessing",async()=>{
  const outcomes=[];
  const run=async(attempts)=>{
    const event={id:`inbox-${attempts}`,tenantId:"tenant-a",connectionId:"connection-a",provider:"waha",providerEventId:`event-${attempts}`,eventType:"message.edited",payload:basePayload,attempts};
    const repository={
      claim:async()=>[event],context:async()=>({zammadBaseUrl:"https://zammad.invalid",zammadSecretReference:"secret://zammad"}),
      recordMessageMutation:async()=>null,
      complete:async(_event,_lease,status,redact)=>outcomes.push({attempts,status,redact}),
      fail:async(_event,_lease,retryable,error,availableAt)=>outcomes.push({attempts,retryable,error,availableAt:Boolean(availableAt)}),
    };
    return new InboundProcessor(repository,{resolve:async()=>{throw new Error("unmatched mutations must not resolve secrets")}},undefined,3).drainTenant("tenant-a");
  };
  assert.deepEqual(await run(1),{events:1,acknowledgements:0});
  assert.deepEqual(await run(3),{events:1,acknowledgements:0});
  assert.equal(outcomes[0].retryable,true);
  assert.equal(outcomes[0].availableAt,true);
  assert.match(outcomes[0].error,/not available yet/);
  assert.deepEqual(outcomes[1],{attempts:3,status:"UNMATCHED",redact:true});
});
