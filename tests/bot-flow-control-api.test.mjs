import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import {
  BotConversationEventPageError,
  BotConversationPageError,
  appendBotConversationEventPage,
  appendBotConversationPage,
  botConversationTicketNumber,
  botSupportTeamName,
  fetchBotConversationEventPage,
  fetchBotConversationPage,
  refreshBotConversationEventPage,
  refreshBotConversationPage,
} from "../lib/bot-conversations.ts";
import { assignBotFlow as assignFixtureFlow, commandBotConversation as commandFixtureConversation, getBotAssignments as getFixtureAssignments, getBotConversationEvents as getFixtureConversationEvents, getBotConversations as getFixtureConversations, getBotFlows as getFixtureFlows, setBotAssignmentAttribution as setFixtureAttribution } from "../lib/fixture-data.ts";
import { advanceBotFlow } from "../packages/core/src/bot-flow.ts";
import { BotFlowsService } from "../services/control-api/dist/bot-flows.service.js";
import { can } from "../services/control-api/dist/rbac.js";
import { RuleGovernanceService } from "../services/control-api/dist/rule-governance.service.js";
import { RuleTestService } from "../services/control-api/dist/rule-test.service.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "10100000-0000-4000-8000-000000000001";
const familyId = "41000000-0000-4000-8000-000000000001";
const versionId = "42000000-0000-4000-8000-000000000001";
const principal = { subject: "owner", userId, tenantId, email: "owner@example.invalid", displayName: "Owner", role: "tenant_owner", authenticatedAt: Math.floor(Date.now()/1000), authenticationMethods: ["mfa"] };
const definition = {
  schemaVersion: 1,
  name: "Support",
  start: "hello",
  maxSteps: 20,
  nodes: [
    { id: "hello", type: "send_text", text: "Hello", next: "handoff" },
    { id: "handoff", type: "handoff", target: "CLIENT_PRIMARY", priority: "2 normal" },
  ],
};
const gatedDefinitions = ["send_template", "whatsapp_flow"].map((type) => ({
  schemaVersion: 1,
  name: `Blocked ${type}`,
  start: "blocked",
  maxSteps: 5,
  nodes: type === "send_template"
    ? [{ id: "blocked", type, templateName: "welcome", languageCode: "en", bodyParameters: [], transcriptText: "Welcome sent.", next: "done" }, { id: "done", type: "end" }]
    : [{ id: "blocked", type, flowId: "12345", prompt: "Confirm", buttonLabel: "Open", data: {}, next: "done" }, { id: "done", type: "end" }],
}));

test("bot pagination rejects repeated cursor values before accessing storage",async()=>{
  const service=new BotFlowsService({});
  const cursor=["duplicate"];
  await assert.rejects(service.flowCatalog(principal,{cursor}),{status:400,message:"Catalog cursor is invalid"});
  await assert.rejects(service.listConversations(principal,{cursor,limit:"50"}),{status:400,message:"Conversation cursor is invalid"});
  await assert.rejects(service.listConversationEvents(principal,versionId,{cursor}),{status:400,message:"Conversation event cursor is invalid"});
});

test("flow and action catalogs are bounded summaries with tenant-bound keyset cursors and separate details",async()=>{
  const flowRows=[1,2,3].map(version=>({family_id:familyId,name:"Support",flow_version_id:`42000000-0000-4000-8000-00000000000${version}`,
    version:4-version,state:"DRAFT",revision:1,snapshot_sha256:"a".repeat(64),pagination_sort:"Support"}));
  const actionRows=[1,2].map(index=>({id:`45000000-0000-4000-8000-00000000000${index}`,action_key:`orders.action${index}`,name:`Action ${index}`,kind:"HTTP_JSON",http_method:"GET",state:"ACTIVE",revision:1}));
  const calls=[];const database={rows:async(_tenant,sql,values)=>{calls.push({sql,values});if(sql.includes("FROM bot_flow_families"))return sql.includes("version.id=$2")?[{...flowRows[0],definition}]:flowRows;if(sql.includes("FROM bot_action_definitions"))return sql.includes("endpoint_url")?[{...actionRows[0],endpoint_url:"https://example.test/action",auth_scheme:"NONE",secret_reference:null,headers:{}}]:actionRows;return[]}};
  const service=new BotFlowsService(database);
  const first=await service.flowCatalog(principal,{limit:"2"});assert.equal(first.items.length,2);assert.ok(first.next_cursor);assert.equal("definition" in first.items[0],false);
  assert.match(calls[0].sql,/COALESCE\(NULLIF\(version\.definition->>'name',''\),family\.name\) AS name/u);
  assert.match(calls[0].sql,/assignment\.flow_version_id=version\.id/u);
  await service.flowCatalog(principal,{limit:"2",cursor:first.next_cursor});assert.equal(calls.at(-1).values[0],tenantId);assert.equal(calls.at(-1).values[4],3);
  assert.deepEqual((await service.flowDetail(principal,flowRows[0].flow_version_id)).definition,definition);
  const actions=await service.actionCatalog(principal,{limit:"1"});assert.equal(actions.items.length,1);assert.ok(actions.next_cursor);assert.equal("endpoint_url" in actions.items[0],false);
  assert.equal((await service.actionDetail(principal,"orders.action1")).endpoint_url,"https://example.test/action");
  await assert.rejects(()=>service.flowCatalog({...principal,tenantId:"20000000-0000-4000-8000-000000000002"},{limit:"2",cursor:first.next_cursor}),/Catalog cursor is invalid/);
  await assert.rejects(()=>service.flowCatalog(principal,{limit:"101"}),/Catalog page limit is invalid/);
  await assert.rejects(()=>service.actionCatalog(principal,{cursor:"not-a-canonical-cursor"}),/Catalog cursor is invalid/);
});

test("portal exposes read-authorized no-store proxies for catalog summaries and exact details",async()=>{
  const paths=["app/api/bot-flows/catalog/route.ts","app/api/bot-flows/[id]/route.ts","app/api/bot-flows/actions/catalog/route.ts","app/api/bot-flows/actions/[actionKey]/route.ts","app/api/client-routing/catalog/route.ts","app/api/client-routing/[id]/route.ts"];
  for(const path of paths){const source=await readFile(new URL(`../${path}`,import.meta.url),"utf8");assert.match(source,/authenticatePortalRequest\(request,"bot:read"\)/);assert.match(source,/private, no-store/);}
});

function emptyActionOperation(sql) {
  if (sql.includes("pg_advisory_xact_lock") || sql.includes("INSERT INTO bot_flow_operations")) return { rows: [], rowCount: 1 };
  if (sql.includes("FROM bot_flow_operations")) return { rows: [], rowCount: 0 };
  return undefined;
}

test("creates a sealed flow once and replays the same idempotency result", async () => {
  let operation;
  let auditCount = 0;
  const client = { query: async (sql, values = []) => {
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("FROM bot_flow_operations")) return { rows: operation ? [operation] : [] };
    if (sql.includes("app.create_bot_flow_family")) return { rows: [{ id: familyId }] };
    if (sql.includes("app.create_bot_flow_version")) return { rows: [{ id: versionId, version: 1, state: "DRAFT", revision: 1, snapshot_sha256: "a".repeat(64) }] };
    if (sql.includes("INSERT INTO audit_events")) { auditCount += 1; return { rows: [] }; }
    if (sql.includes("INSERT INTO bot_flow_operations")) {
      operation = { action: values[1], request_sha256: values[3], result: values[4] };
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const service = new BotFlowsService({ withTenant: async (id, callback) => {
    assert.equal(id, tenantId);
    return callback(client);
  } });
  const created = await service.create(principal, "create-support-v1", "request-1", definition);
  const replayed = await service.create(principal, "create-support-v1", "request-2", definition);
  assert.equal(created.id, versionId);
  assert.equal(created.duplicate, false);
  assert.equal(replayed.id, versionId);
  assert.equal(replayed.duplicate, true);
  assert.equal(auditCount, 1);
});

test("validates flow input and current Meta capability before opening a database transaction", () => {
  const service = new BotFlowsService({ withTenant: async () => assert.fail("database should not be reached") });
  assert.throws(() => service.create(principal, "bad", "request", { ...definition, start: "missing" }), /start node does not exist/);
  for (const [index, blocked] of gatedDefinitions.filter(flow=>flow.nodes.some(node=>node.type==="whatsapp_flow")).entries()) {
    assert.throws(() => service.create(principal, `blocked-create-${index}`, "request", blocked), /require current provider approval/);
    assert.throws(() => service.clone(principal, versionId, `blocked-clone-${index}`, "request", blocked), /require current provider approval/);
  }
});

test("body template drafts reach the existing immutable create and clone boundary",async()=>{
  let transactions=0;
  const service=new BotFlowsService({withTenant:async()=>{transactions++;return{admitted:true}}});
  const template=gatedDefinitions.find(flow=>flow.nodes.some(node=>node.type==="send_template"));
  assert.deepEqual(await service.create(principal,"template-create","request",template),{admitted:true});
  assert.deepEqual(await service.clone(principal,versionId,"template-clone","request",template),{admitted:true});
  assert.equal(transactions,2);
});

test("assignment and fixture summaries preserve version truth and connection health",async()=>{
  let query="";
  const service=new BotFlowsService({rows:async(_tenant,sql)=>{query=sql;return[]}});
  await service.listAssignments(principal);
  assert.match(query,/connection\.state AS connection_state/u);
  assert.match(query,/COALESCE\(NULLIF\(version\.definition->>'name',''\),family\.name\) AS flow_name/u);
  const [flows,assignments]=await Promise.all([getFixtureFlows(),getFixtureAssignments()]);
  const flow=flows[0];const assignment=assignments[0];
  assert.equal(flow.name,flow.definition.name);
  assert.equal(flow.assignment_count,assignments.filter(row=>row.state==="ACTIVE"&&row.flow_version_id===flow.flow_version_id).length);
  assert.equal(assignment.flow_name,flow.definition.name);
  assert.equal(assignment.connection_state,"WORKING");
});

test("terminal media upload replay keeps only an opaque UUID operation key",async()=>{
  const assetId="64700000-0000-4000-8000-000000000001";
  const client={query:async(sql)=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_media_assets"))return{rows:[{id:assetId,request_sha256:null,state:"FAILED"}]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},{issueMediaUploadToken:async()=>assert.fail("terminal replay must not issue a token")});
  const replay=await service.createMediaAsset(principal,assetId,"terminal-replay",{filename:"different.png",mimeType:"image/png",byteSize:8,contentSha256:"a".repeat(64)});
  assert.equal(replay.state,"FAILED");
  await assert.rejects(
    ()=>service.createMediaAsset(principal,"media-upload-key","invalid-key",{filename:"proof.png",mimeType:"image/png",byteSize:8,contentSha256:"a".repeat(64)}),
    /idempotency key must be a UUID/i,
  );
});

test("serializes and enforces tenant media count and byte reservations before insert",async()=>{
  const cases=[
    {key:"64700000-0000-4000-8000-000000000011",limits:{bot_media_asset_count_limit:1,bot_media_asset_bytes_limit:"1000"},usage:{active_count:"1",active_bytes:"8"}},
    {key:"64700000-0000-4000-8000-000000000012",limits:{bot_media_asset_count_limit:100,bot_media_asset_bytes_limit:"10"},usage:{active_count:"0",active_bytes:"5"}},
  ];
  for(const current of cases){
    const locks=[];let inserted=false;
    const client={query:async(sql,values=[])=>{
      if(sql.includes("pg_advisory_xact_lock")){locks.push(values[0]);return{rows:[]}}
      if(sql.includes("SELECT id,request_sha256,state FROM bot_media_assets"))return{rows:[]};
      if(sql.includes("FROM tenant_settings")){
        assert.doesNotMatch(sql,/FOR\s+(?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)/i,"quota reads must work with the app's SELECT-only settings grant");
        return{rows:[current.limits]};
      }
      if(sql.includes("count(*)::text AS active_count"))return{rows:[current.usage]};
      if(sql.includes("INSERT INTO bot_media_assets")){inserted=true;return{rows:[]}}
      throw new Error(`Unexpected query: ${sql}`);
    }};
    const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},{issueMediaUploadToken:async()=>assert.fail("quota rejection must not issue an upload token")});
    await assert.rejects(()=>service.createMediaAsset(principal,current.key,"quota-request",{filename:"proof.png",mimeType:"image/png",byteSize:8,contentSha256:"a".repeat(64)}),/media storage limit reached/i);
    assert.deepEqual(locks,[`bot-media-quota:${tenantId}`,`bot-media-upload:${tenantId}:${current.key}`]);assert.equal(inserted,false);
  }
});

test("rejects official templates and WhatsApp forms on linked-device assignments", async () => {
  const officialDefinition={schemaVersion:1,name:"Official",start:"template",maxSteps:5,nodes:[
    {id:"template",type:"send_template",templateName:"welcome",languageCode:"en",bodyParameters:[],transcriptText:"Welcome sent.",next:"done"},
    {id:"done",type:"end"},
  ]};
  const client={query:async(sql)=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("FROM bot_flow_versions WHERE"))return{rows:[{definition:officialDefinition,family_id:familyId,supersedes_flow_version_id:null,snapshot_sha256:"a".repeat(64)}]};
    if(sql.includes("FROM bot_assignments assignment"))return{rows:[{provider:"WAHA"}]};
    if(sql.includes("FROM connections connection"))return{rows:[{provider:"WAHA",state:"WORKING",definition:officialDefinition}]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  await assert.rejects(()=>service.assign(principal,"assign-official","request",{connectionId:"43000000-0000-4000-8000-000000000001",familyId,zammadGroupId:"2"}),/require an official API connection/);
  await assert.rejects(()=>service.activate(principal,versionId,"activate-official","request",{expectedRevision:1,expectedActiveFlowVersionId:null}),/require official API assignments/);
});

test("bot permissions are owner/admin write and all-role read", () => {
  assert.equal(can("tenant_owner", "bot:write"), true);
  assert.equal(can("tenant_admin", "bot:write"), true);
  for (const role of ["tenant_owner", "tenant_admin", "supervisor", "agent"]) assert.equal(can(role, "bot:operate"), true);
  assert.equal(can("auditor", "bot:operate"), false);
  for (const role of ["supervisor", "agent", "auditor"]) {
    assert.equal(can(role, "bot:read"), true);
    assert.equal(can(role, "bot:write"), false);
  }
});

function emptyDirectCommandBarrier(sql,values,conversationId){
  if(sql.includes("SELECT 'reply' AS kind,id FROM direct_native_reply_intents")){
    assert.deepEqual(values,[tenantId,conversationId,null,null]);
    assert.match(sql,/UNION ALL SELECT 'close',id FROM direct_customer_close_commands/u);
    assert.match(sql,/state='SUCCEEDED'[\s\S]*conversation\.fencing_token=direct_customer_close_commands\.conversation_fencing_token/u);
    return{rows:[],rowCount:0};
  }
  if(sql.includes("SELECT 'delivery' AS kind,id FROM delivery_outbox")){
    assert.deepEqual(values,[tenantId,conversationId]);
    assert.match(sql,/UNION ALL SELECT 'action',id FROM bot_action_jobs[\s\S]*UNION ALL SELECT 'handoff',id FROM bot_handoff_jobs/u);
    return{rows:[],rowCount:0};
  }
  return null;
}

test("operator resume is fenced, idempotent, and resets only the pinned conversation",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001";let operation;let updated=false;let auditCount=0;
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:operation?[operation]:[]};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"HUMAN",fencing_token:4,current_node_id:"handoff",start_node:"welcome",handoff_id:"48000000-0000-4000-8000-000000000001",handoff_state:"SUCCEEDED",assignment_state:"ACTIVE",connection_state:"WORKING"}]};
    if(sql.includes("UPDATE bot_conversations SET state=")){updated=true;assert.deepEqual(values,["BOT","welcome",tenantId,conversationId]);return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO bot_conversation_events"))return{rows:[],rowCount:1};
    if(sql.includes("SELECT state,current_node_id,fencing_token FROM bot_conversations"))return{rows:[{state:"BOT",current_node_id:"welcome",fencing_token:5}]};
    if(sql.includes("INSERT INTO audit_events")){auditCount+=1;return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO bot_flow_operations")){operation={action:values[1],request_sha256:values[3],result:values[4]};return{rows:[],rowCount:1};}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const first=await service.commandConversation(principal,conversationId,"resume-1","request-1",{action:"RESUME_BOT",expectedFencingToken:4});
  const replay=await service.commandConversation(principal,conversationId,"resume-1","request-2",{action:"RESUME_BOT",expectedFencingToken:4});
  assert.equal(updated,true);assert.equal(first.state,"BOT");assert.equal(first.currentNodeId,"welcome");assert.equal(first.fencingToken,5);assert.equal(first.duplicate,false);assert.equal(replay.duplicate,true);assert.equal(auditCount,1);
  const nextInbound=advanceBotFlow({...definition,start:"welcome",nodes:[{id:"welcome",type:"send_text",text:"Welcome back",next:"handoff"},...definition.nodes.slice(1)]},first.currentNodeId,{type:"text",text:"Hello again"});
  assert.equal(nextInbound.state,"HANDOFF");assert.equal(nextInbound.currentNodeId,"handoff");
});

test("browser fixture resume mirrors the production start-node reset",async()=>{
  const before=(await getFixtureConversations()).items.find(row=>row.zammad_ticket_number==="10421");
  assert.ok(before);assert.equal(before.current_node_id,"handoff");
  const resumed=await commandFixtureConversation(String(before.id),{action:"RESUME_BOT",expectedFencingToken:before.fencing_token});
  assert.equal(resumed.state,"BOT");assert.equal(resumed.currentNodeId,"welcome");
  const after=(await getFixtureConversations()).items.find(row=>row.id===before.id);
  assert.equal(after?.current_node_id,"welcome");assert.equal(after?.step_count,0);
});

test("operator resume fails closed while the bot assignment is paused",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001";
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"HUMAN",fencing_token:4,current_node_id:"handoff",start_node:"welcome",handoff_id:null,handoff_state:null,assignment_state:"PAUSED",connection_state:"WORKING"}]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  await assert.rejects(()=>service.commandConversation(principal,conversationId,"resume-paused","request-paused",{action:"RESUME_BOT",expectedFencingToken:4}),/Activate the bot assignment/);
});

for (const configured of [undefined, "3"]) test(`operator retry respects the ${configured ? "configured" : "default"} handoff limit without resetting attempts or changing ownership`,async t=>{
  const original = process.env.BOT_HANDOFF_MAX_ATTEMPTS;
  t.after(() => {
    if (original === undefined) delete process.env.BOT_HANDOFF_MAX_ATTEMPTS;
    else process.env.BOT_HANDOFF_MAX_ATTEMPTS = original;
  });
  if (configured === undefined) delete process.env.BOT_HANDOFF_MAX_ATTEMPTS;
  else process.env.BOT_HANDOFF_MAX_ATTEMPTS = configured;
  const maxAttempts = configured === undefined ? 8 : Number(configured);
  const conversationId="47000000-0000-4000-8000-000000000001",handoffId="48000000-0000-4000-8000-000000000001";
  const job={state:"FAILED_RETRYABLE",attempts:maxAttempts-1};let operation,fence=4,updates=0,events=0,wakes=0;
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:operation?[operation]:[]};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"HANDOFF_PENDING",fencing_token:fence,current_node_id:"handoff",handoff_id:handoffId,handoff_state:job.state}]};
    if(sql.includes("UPDATE bot_handoff_jobs")){
      assert.match(sql,/state='QUEUED',available_at=now\(\)/u);
      assert.match(sql,/tenant_id=\$1 AND id=\$2 AND state='FAILED_RETRYABLE' AND attempts<\$3[\s\S]*lease_id IS NULL AND lease_expires_at IS NULL/u);
      assert.doesNotMatch(sql,/SET[\s\S]*attempts\s*=/u);assert.deepEqual(values,[tenantId,handoffId,maxAttempts]);
      job.state="QUEUED";updates++;return{rows:[],rowCount:1};
    }
    if(sql.includes("UPDATE bot_conversations")){assert.doesNotMatch(sql,/SET state|human_ownership_epoch|human_pause_started_at/u);fence++;return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO bot_conversation_events")){events++;assert.deepEqual(values,[tenantId,conversationId,"handoff",JSON.stringify({operator_retry:true})]);return{rows:[],rowCount:1};}
    if(sql.includes("SELECT state,current_node_id,fencing_token FROM bot_conversations"))return{rows:[{state:"HANDOFF_PENDING",current_node_id:"handoff",fencing_token:fence}]};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[]};
    if(sql.includes("INSERT INTO bot_flow_operations")){operation={action:values[1],request_sha256:values[3],result:values[4]};return{rows:[]};}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},{wake:async()=>{wakes++}});
  const input={action:"RETRY_HANDOFF",expectedFencingToken:4};
  const result=await service.commandConversation(principal,conversationId,"retry-handoff","request",input);
  assert.deepEqual(result,{conversationId,state:"HANDOFF_PENDING",currentNodeId:"handoff",fencingToken:5,command:"RETRY_HANDOFF",duplicate:false});
  assert.deepEqual(await service.commandConversation(principal,conversationId,"retry-handoff","replay",input),{...result,duplicate:true});
  assert.equal(job.attempts,maxAttempts-1);assert.equal(updates,1);assert.equal(events,1);assert.equal(wakes,2);
});

test("handoff retry fails closed on a stale fence, changed job, or exhausted attempts",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001",handoffId="48000000-0000-4000-8000-000000000001";
  for(const scenario of [
    {state:"HANDOFF_PENDING",handoffState:"FAILED_RETRYABLE",fence:5,changed:false,error:/Bot conversation changed/},
    {state:"HANDOFF_PENDING",handoffState:"RUNNING",fence:4,changed:false,error:/No failed human handoff/},
    {state:"HANDOFF_PENDING",handoffState:"OUTCOME_UNKNOWN",fence:4,changed:false,error:/No failed human handoff/},
    {state:"HUMAN",handoffState:"FAILED_RETRYABLE",fence:4,changed:false,error:/No failed human handoff/},
    {state:"HANDOFF_PENDING",handoffState:"FAILED_RETRYABLE",fence:4,changed:true,error:/handoff changed/},
  ]){
    const client={query:async(sql,values=[])=>{
      const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
      const operation=emptyActionOperation(sql);if(operation)return operation;
      if(sql.includes("version.definition->>'start'"))return{rows:[{state:scenario.state,fencing_token:scenario.fence,current_node_id:"handoff",handoff_id:handoffId,handoff_state:scenario.handoffState}]};
      if(sql.includes("UPDATE bot_handoff_jobs")){assert.equal(scenario.changed,true);assert.match(sql,/attempts<\$3/u);return{rows:[],rowCount:0};}
      throw new Error(`Unexpected mutation after a rejected handoff retry: ${sql}`);
    }};
    const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},{wake:async()=>assert.fail("Rejected retry must not wake workers")});
    await assert.rejects(()=>service.commandConversation(principal,conversationId,"retry-race","request",{action:"RETRY_HANDOFF",expectedFencingToken:4}),scenario.error);
  }
});

test("a retryable handoff does not permit operator resume or close",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001";
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"HANDOFF_PENDING",fencing_token:4,handoff_id:"48000000-0000-4000-8000-000000000001",handoff_state:"FAILED_RETRYABLE"}]};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  for(const action of ["RESUME_BOT","CLOSE"])await assert.rejects(()=>service.commandConversation(principal,conversationId,action,"request",{action,expectedFencingToken:4}),/Only a human-owned/);
});

test("operator explicitly retries an ambiguous bot action without taking its failure branch",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001";let operation;let woke=0;
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:operation?[operation]:[]};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"ACTION_PENDING",fencing_token:4,current_node_id:"lookup",start_node:"welcome",handoff_id:null,handoff_state:null,action_id:"45000000-0000-4000-8000-000000000001",action_state:"OUTCOME_UNKNOWN",assignment_state:"ACTIVE",connection_state:"WORKING"}]};
    if(sql.includes("UPDATE bot_action_jobs SET state='FAILED_RETRYABLE'")){assert.equal(values[1],"45000000-0000-4000-8000-000000000001");return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE bot_conversations SET fencing_token"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO bot_conversation_events"))return{rows:[],rowCount:1};
    if(sql.includes("SELECT state,current_node_id,fencing_token FROM bot_conversations"))return{rows:[{state:"ACTION_PENDING",current_node_id:"lookup",fencing_token:5}]};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO bot_flow_operations")){operation={action:values[1],request_sha256:values[3],result:values[4]};return{rows:[],rowCount:1}}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)}, {wake:async()=>{woke+=1}});
  const result=await service.commandConversation(principal,conversationId,"retry-action","request",{action:"RETRY_ACTION",expectedFencingToken:4});
  assert.equal(result.state,"ACTION_PENDING");assert.equal(woke,1);
});

test("operator hands an ambiguous action to a person without reissuing it",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001";let operation;let handoffs=0;let actionWrites=0;let auditCount=0;
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:operation?[operation]:[]};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"ACTION_PENDING",fencing_token:4,current_node_id:"lookup",start_node:"welcome",handoff_id:null,handoff_state:null,action_id:"45000000-0000-4000-8000-000000000001",action_state:"OUTCOME_UNKNOWN",assignment_state:"ACTIVE",connection_state:"WORKING"}]};
    if(sql.includes("FROM delivery_outbox"))return{rows:[],rowCount:0};
    if(sql.includes("UPDATE bot_conversations SET state='HUMAN'")){handoffs+=1;assert.deepEqual(values,[tenantId,conversationId,4]);return{rows:[],rowCount:1}}
    if(sql.includes("INSERT INTO bot_conversation_events")){const metadata=JSON.parse(values[3]);assert.deepEqual(metadata,{operator_command:true,action_outcome:"UNKNOWN",external_action_reissued:false});return{rows:[],rowCount:1}}
    if(sql.includes("UPDATE bot_action_jobs")){actionWrites+=1;return{rows:[],rowCount:1}}
    if(sql.includes("SELECT state,current_node_id,fencing_token FROM bot_conversations"))return{rows:[{state:"HUMAN",current_node_id:"lookup",fencing_token:5}]};
    if(sql.includes("INSERT INTO audit_events")){auditCount+=1;return{rows:[],rowCount:1}};
    if(sql.includes("INSERT INTO bot_flow_operations")){operation={action:values[1],request_sha256:values[3],result:values[4]};return{rows:[],rowCount:1}}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},{wake:async()=>assert.fail("handoff must not wake the action worker")});
  const first=await service.commandConversation(principal,conversationId,"handoff-unknown","request-1",{action:"HANDOFF_TO_HUMAN",expectedFencingToken:4});
  const replay=await service.commandConversation(principal,conversationId,"handoff-unknown","request-2",{action:"HANDOFF_TO_HUMAN",expectedFencingToken:4});
  assert.equal(first.state,"HUMAN");assert.equal(first.fencingToken,5);assert.equal(replay.duplicate,true);
  assert.equal(handoffs,1);assert.equal(actionWrites,0);assert.equal(auditCount,1);
});

test("operator handoff fails closed while a bot delivery outcome is ambiguous",async()=>{
  const conversationId="47000000-0000-4000-8000-000000000001";
  const client={query:async(sql,values=[])=>{
    const barrier=emptyDirectCommandBarrier(sql,values,conversationId);if(barrier)return barrier;
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:"ACTION_PENDING",fencing_token:4,current_node_id:"lookup",start_node:"welcome",handoff_id:null,handoff_state:null,action_id:"45000000-0000-4000-8000-000000000001",action_state:"OUTCOME_UNKNOWN",assignment_state:"ACTIVE",connection_state:"WORKING"}]};
    if(sql.includes("FROM delivery_outbox"))return{rows:[{exists:1}],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  await assert.rejects(()=>service.commandConversation(principal,conversationId,"handoff-ambiguous-delivery","request",{action:"HANDOFF_TO_HUMAN",expectedFencingToken:4}),/Resolve the pending WhatsApp bot delivery/);
});

test("saves a bounded secret-reference-only Notion action",async()=>{
  const writes=[];
  const client={query:async(sql,values=[])=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO bot_action_definitions")){writes.push(values);return{rows:[{id:"45000000-0000-4000-8000-000000000001",revision:1}],rowCount:1};}
    if(sql.includes("INSERT INTO bot_action_revisions")){writes.push(values);return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const result=await service.saveAction(principal,"request-action",{actionKey:"notion.create_case",name:"Create Notion case",kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:`secret://tenants/${tenantId}/bot-actions/notion.create_case`,headers:{},responseMapping:{"action.page_url":"/url"},timeoutMs:5000,maxResponseBytes:262144,state:"ACTIVE",expectedRevision:null});
  assert.equal(result.actionKey,"notion.create_case");
  assert.equal(JSON.stringify(writes).includes("secret-value"),false);
  assert.throws(()=>service.saveAction(principal,"bad",{actionKey:"notion.bad",name:"Bad",kind:"NOTION_CREATE_PAGE",endpointUrl:"https://example.com/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:"secret://x",headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE"}),/official create-page endpoint/);
  assert.throws(()=>service.saveAction(principal,"bad-header",{actionKey:"http.bad",name:"Bad",kind:"HTTP_JSON",endpointUrl:"https://example.com/action",httpMethod:"POST",authScheme:"NONE",secretReference:null,headers:{"X-Api-Key":"inline"},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE"}),/header X-Api-Key is reserved/);
  assert.throws(()=>service.saveAction(principal,"bad-query",{actionKey:"http.bad",name:"Bad",kind:"HTTP_JSON",endpointUrl:"https://example.com/action?access_token=inline",httpMethod:"POST",authScheme:"NONE",secretReference:null,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE"}),/credential query parameters/);
  assert.throws(()=>service.saveAction(principal,"cross-tenant",{actionKey:"http.cross",name:"Cross tenant",kind:"HTTP_JSON",endpointUrl:"https://example.com/action",httpMethod:"POST",authScheme:"BEARER",secretReference:"secret://tenants/another/bot-actions/api",headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE"}),/must belong to this tenant/);
  assert.throws(()=>service.saveAction(principal,"cross-action",{actionKey:"http.cross",name:"Cross action",kind:"HTTP_JSON",endpointUrl:"https://example.com/action",httpMethod:"POST",authScheme:"BEARER",secretReference:`secret://tenants/${tenantId}/bot-actions/private.credential`,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE"}),/credential staged for this plugin action/);
  assert.throws(()=>service.saveAction(principal,"cross-notion-action",{actionKey:"notion.cross",name:"Cross Notion action",kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:`secret://tenants/${tenantId}/bot-actions/private.credential`,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE"}),/credential staged for this plugin action/);
});

test("reuses only a connected tenant Notion account for workflow actions",async()=>{
  const reference=`secret://tenants/${tenantId}/routing/integrations/53000000-0000-4000-8000-000000000001`;
  const client={query:async(sql,values=[])=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("FROM client_routing_integrations"))return{rows:values[1]===reference?[{exists:1}]:[],rowCount:values[1]===reference?1:0};
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO bot_action_definitions"))return{rows:[{id:"45000000-0000-4000-8000-000000000002",revision:1}],rowCount:1};
    if(sql.includes("INSERT INTO bot_action_revisions"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const input={actionKey:"notion.shared",name:"Create Notion page",kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:reference,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:262144,state:"ACTIVE",expectedRevision:null};
  assert.equal((await service.saveAction(principal,"shared-notion",input)).actionKey,"notion.shared");
  assert.throws(()=>service.saveAction(principal,"malformed-notion",{...input,secretReference:`secret://tenants/${tenantId}/routing/integrations/not-a-uuid`}),/must belong to this tenant/);
  await assert.rejects(()=>service.saveAction(principal,"missing-notion",{...input,secretReference:`secret://tenants/${tenantId}/routing/integrations/53000000-0000-4000-8000-000000000099`}),/Choose a connected Notion workspace/);
});

test("a revoked shared connection can be retired from the action catalog",async()=>{
  const reference=`secret://tenants/${tenantId}/routing/integrations/53000000-0000-4000-8000-000000000001`;
  let integrationChecks=0;
  const client={query:async sql=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("FROM client_routing_integrations")){integrationChecks+=1;return{rows:[],rowCount:0};}
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[{id:"45000000-0000-4000-8000-000000000002",revision:1,active_revision_id:"45100000-0000-4000-8000-000000000001",secret_reference:reference}],rowCount:1};
    if(sql.includes("FROM bot_action_jobs")||sql.includes("FROM bot_flow_versions")||sql.includes("FROM trigger_rules"))return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO bot_action_revisions"))return{rows:[],rowCount:1};
    if(sql.includes("UPDATE bot_action_definitions"))return{rows:[{id:"45000000-0000-4000-8000-000000000002",revision:2}],rowCount:1};
    if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const result=await service.saveAction(principal,"retire-shared",{actionKey:"notion.shared",name:"Create Notion page",kind:"NOTION_CREATE_PAGE",endpointUrl:"https://api.notion.com/v1/pages",httpMethod:"POST",authScheme:"BEARER",secretReference:reference,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:262144,state:"PAUSED",expectedRevision:1});
  assert.equal(result.state,"PAUSED");
  assert.equal(integrationChecks,0);
});

test("stores plugin credentials in the tenant namespace without returning or auditing the value",async()=>{
  const stored=[];const audits=[];let stage;
  const client={query:async(sql,values=[])=>{if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};if(sql.includes("FROM bot_action_credential_stages"))return{rows:stage?[stage]:[],rowCount:stage?1:0};if(sql.includes("INSERT INTO bot_action_credential_stages")){stage={id:values[0],action_key:values[2],secret_reference:values[4],credential_sha256:values[5],state:"STAGED",available:true};return{rows:[],rowCount:1}}if(sql.includes("UPDATE bot_action_credential_stages")&&sql.includes("SET expires_at"))return{rows:[],rowCount:1};if(sql.includes("INSERT INTO audit_events")){audits.push(values);return{rows:[],rowCount:1}}throw new Error(`Unexpected query: ${sql}`)}};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},undefined,undefined,undefined,undefined,{storeBotActionCredential:async(reference,value)=>stored.push({reference,value})});
  const credential="notion-sandbox-token-123456";
  const privilegedPrincipal={...principal,authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["pwd","mfa"]};
  const result=await service.storeActionCredential(privilegedPrincipal,"credential-request",{actionKey:"notion.create_case",credential});
  assert.equal(result.state,"STAGED");assert.equal(result.duplicate,false);
  assert.match(result.secretReference,new RegExp(`^secret://tenants/${tenantId}/bot-actions/notion\\.create_case/credentials/[0-9a-f]{64}$`));
  assert.deepEqual(stored,[{reference:result.secretReference,value:credential}]);
  assert.equal((await service.storeActionCredential(privilegedPrincipal,"credential-request",{actionKey:"notion.create_case",credential})).duplicate,true);
  assert.equal(stored.length,2);
  stage.state="BOUND";
  assert.equal((await service.storeActionCredential(privilegedPrincipal,"credential-request",{actionKey:"notion.create_case",credential})).state,"BOUND");
  assert.equal(stored.length,2);
  await assert.rejects(()=>service.storeActionCredential(privilegedPrincipal,"credential-request",{actionKey:"notion.create_case",credential:`${credential}-different`}),/Idempotency key was already used/);
  assert.equal(JSON.stringify(audits).includes(credential),false);
  await assert.rejects(()=>service.storeActionCredential(privilegedPrincipal,"short",{actionKey:"notion.create_case",credential:"too-short"}),/credential is invalid/);
  await assert.rejects(()=>service.storeActionCredential({...privilegedPrincipal,authenticatedAt:privilegedPrincipal.authenticatedAt-901},"stale",{actionKey:"notion.create_case",credential}),error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED");
  await assert.rejects(()=>service.storeActionCredential({...privilegedPrincipal,authenticationMethods:["pwd"]},"missing-mfa",{actionKey:"notion.create_case",credential}),error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED");
  assert.equal(stored.length,2);
});

test("credential staging commits before the external write and safely repairs an ambiguous store",async()=>{
  let stage;let audits=0;let stores=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_action_credential_stages"))return{rows:stage?[stage]:[],rowCount:stage?1:0};
    if(sql.includes("INSERT INTO bot_action_credential_stages")){stage={id:values[0],action_key:values[2],secret_reference:values[4],credential_sha256:values[5],state:"STAGED",available:true};return{rows:[],rowCount:1};}
    if(sql.includes("UPDATE bot_action_credential_stages")&&sql.includes("SET expires_at"))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO audit_events")){audits+=1;return{rows:[],rowCount:1};}
    throw new Error(`Unexpected durable-stage query: ${sql}`);
  }};
  const credential="ambiguous-secret-value-123";
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)},undefined,undefined,undefined,undefined,{storeBotActionCredential:async()=>{stores+=1;if(stores===1)throw new Error("response lost after write")}});
  await assert.rejects(()=>service.storeActionCredential(principal,"ambiguous-stage","request-first",{actionKey:"orders.lookup",credential}),/temporarily unavailable/);
  assert.ok(stage);assert.equal(audits,1);assert.equal(stores,1);
  const repaired=await service.storeActionCredential(principal,"ambiguous-stage","request-retry",{actionKey:"orders.lookup",credential});
  assert.equal(repaired.duplicate,true);assert.equal(repaired.state,"STAGED");assert.equal(audits,1);assert.equal(stores,2);
});

test("a failed stage transaction never calls the external secret store",async()=>{
  let stores=0;
  const client={query:async sql=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("INSERT INTO bot_action_credential_stages")||sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    if(sql.includes("FROM bot_action_credential_stages"))return{rows:[],rowCount:0};
    throw new Error(`Unexpected failed-stage query: ${sql}`);
  }};
  const database={withTenant:async(_tenant,callback)=>{await callback(client);throw new Error("database commit failed")}};
  const service=new BotFlowsService(database,undefined,undefined,undefined,undefined,{storeBotActionCredential:async()=>{stores+=1}});
  await assert.rejects(()=>service.storeActionCredential(principal,"commit-failure","request-commit",{actionKey:"orders.lookup",credential:"commit-failure-secret-123"}),/database commit failed/);
  assert.equal(stores,0);
});

test("a new immutable action revision can retain its already-bound versioned credential",async()=>{
  const actionId="45000000-0000-4000-8000-000000000012";
  const reference=`secret://tenants/${tenantId}/bot-actions/orders.lookup/credentials/${"b".repeat(64)}`;
  let credentialStageReads=0;
  const client={query:async sql=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[{id:actionId,revision:2,active_revision_id:"45100000-0000-4000-8000-000000000012",secret_reference:reference}],rowCount:1};
    if(sql.includes("FROM bot_action_jobs")||sql.includes("FROM bot_flow_versions")||sql.includes("FROM trigger_rules"))return{rows:[],rowCount:0};
    if(sql.includes("FROM bot_action_credential_stages")){credentialStageReads+=1;return{rows:[],rowCount:0};}
    if(sql.includes("INSERT INTO bot_action_revisions")||sql.includes("UPDATE bot_action_definitions")||sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    throw new Error(`Unexpected retained-credential query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const result=await service.saveAction(principal,"retain-bound","request-retain",{actionKey:"orders.lookup",name:"Lookup order",kind:"HTTP_JSON",endpointUrl:"https://api.example.test/status",httpMethod:"GET",authScheme:"BEARER",secretReference:reference,headers:{},responseMapping:{"action.status":"/status"},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE",expectedRevision:2});
  assert.equal(result.revision,3);assert.equal(credentialStageReads,0);
});

test("active flows pin action behavior and read-only roles receive no secret metadata",async()=>{
  const existingId="45000000-0000-4000-8000-000000000001";
  const client={query:async(sql)=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[{id:existingId,revision:2,active_revision_id:"45100000-0000-4000-8000-000000000002",secret_reference:null}],rowCount:1};
    if(sql.includes("FROM bot_action_jobs"))return{rows:[],rowCount:0};
    if(sql.includes("FROM bot_flow_versions"))return{rows:[{exists:1}],rowCount:1};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client),rows:async()=>[{id:existingId,kind:"NOTION_CREATE_PAGE",endpoint_url:"https://api.notion.com/v1/pages?workspace=northstar",http_method:"POST",auth_scheme:"BEARER",secret_reference:"secret://tenant/action",headers:{"x-safe":"value"}}]});
  await assert.rejects(()=>service.saveAction(principal,"request",{actionKey:"orders.lookup",name:"Lookup",kind:"HTTP_JSON",endpointUrl:"https://example.com/action",httpMethod:"POST",authScheme:"NONE",secretReference:null,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE",expectedRevision:2}),/pinned by an active flow/);
  const visible=await service.listActions({...principal,role:"auditor"});
  assert.deepEqual(visible[0]?.headers,{});
  assert.equal(visible[0]?.secret_reference,null);
  assert.equal(visible[0]?.endpoint_url,"https://api.notion.com/v1/pages");
  assert.equal((await service.listActions(principal))[0]?.endpoint_url,"https://api.notion.com/v1/pages?workspace=northstar");
  assert.deepEqual(visible[0]?.capabilities,{invocation_surfaces:["DIRECT_FLOW","GROUP_COMMAND"],retry_semantics:"OUTCOME_UNKNOWN_ON_AMBIGUOUS_FAILURE"});
});

test("one active catalog action is accepted by direct and group automation and pinned by either surface",async()=>{
  const actionKey="orders.shared";
  const actionId="45000000-0000-4000-8000-000000000009";
  const directDefinition={schemaVersion:1,name:"Shared action",start:"lookup",maxSteps:5,nodes:[
    {id:"lookup",type:"action",actionId:actionKey,input:{reference:"{{message.text}}"},onSuccess:"done",onFailure:"done"},
    {id:"done",type:"end"},
  ]};
  const directClient={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("INSERT INTO audit_events")||sql.includes("INSERT INTO bot_flow_operations"))return{rows:[],rowCount:1};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("SELECT definition,family_id,supersedes_flow_version_id,snapshot_sha256 FROM bot_flow_versions")){assert.doesNotMatch(sql,/FOR SHARE/);return{rows:[{definition:directDefinition,family_id:familyId,supersedes_flow_version_id:null,snapshot_sha256:"d".repeat(64)}]};}
    if(sql.includes("FROM automation_action_revision_pins pin"))return{rows:[]};
    if(sql.includes("FROM bot_action_definitions")&&sql.includes("action_key=ANY")){assert.deepEqual(values,[tenantId,[actionKey]]);return{rows:[{id:actionId,action_key:actionKey,active_revision_id:"45100000-0000-4000-8000-000000000009",response_mapping:{"action.state":"/state"},kind:"HTTP_JSON",endpoint_url:"https://orders.example/status",http_method:"POST",auth_scheme:"NONE",secret_reference:null}]};}
    if(sql.includes("INSERT INTO automation_action_revision_pins"))return{rows:[],rowCount:1};
    if(sql.includes("app.activate_bot_flow_version"))return{rows:[{active_flow_version_id:versionId,retired_flow_version_id:null,revision:2,assignments_migrated:0}]};
    throw new Error(`Unexpected direct action query: ${sql}`);
  }};
  const direct=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(directClient)});
  const activated=await direct.activate(principal,versionId,"activate-shared-action","request-direct",{expectedRevision:1,expectedActiveFlowVersionId:null});
  assert.equal(activated.flowVersionId,versionId);

  const ruleSetId="14000000-0000-4000-8000-000000000009";
  const ruleFamilyId="14100000-0000-4000-8000-000000000009";
  let groupActionPinned=false;
  const ruleClient={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("INSERT INTO audit_events")||sql.includes("INSERT INTO rule_set_operations"))return{rows:[],rowCount:1};
    if(sql.includes("FROM rule_set_operations"))return{rows:[]};
    if(sql.includes("FROM rule_sets s")&&sql.includes("JOIN rule_families"))return{rows:[{id:ruleSetId,tenant_id:tenantId,family_id:ruleFamilyId,name:"Shared commands",version:1,state:"DRAFT",revision:1,snapshot_sha256:"c".repeat(64),supersedes_rule_set_id:null,rollback_source_rule_set_id:null,created_at:"2026-08-18T00:00:00.000Z",activated_at:null,retired_at:null}]};
    if(sql.includes("FROM trigger_rules")&&!sql.includes("JOIN rule_sets"))return{rows:[{id:"14200000-0000-4000-8000-000000000009",name:"Shared status",matcher_type:"starts_with",pattern:"/status",matcher_options:{groupCommand:{actionId:actionKey,input:{reference:"{{message.argument}}"},successReply:"{{action.state}}",failureReply:"{{action.error}}"}},priority:1,enabled:true,saved_examples:[]}]};
    if(sql.includes("FROM automation_action_revision_pins pin"))return{rows:groupActionPinned?[{id:actionId,action_key:actionKey,active_revision_id:"45100000-0000-4000-8000-000000000009",response_mapping:{"action.state":"/state"},kind:"HTTP_JSON",endpoint_url:"https://orders.example/status",http_method:"POST",auth_scheme:"NONE",secret_reference:null}]:[]};
    if(sql.includes("FROM bot_action_definitions")){assert.deepEqual(values,[tenantId,[actionKey]]);return{rows:[{id:actionId,action_key:actionKey,active_revision_id:"45100000-0000-4000-8000-000000000009",response_mapping:{"action.state":"/state"},kind:"HTTP_JSON",endpoint_url:"https://orders.example/status",http_method:"POST",auth_scheme:"NONE",secret_reference:null}]};}
    if(sql.includes("INSERT INTO automation_action_revision_pins")){groupActionPinned=true;return{rows:[],rowCount:1};}
    if(sql.includes("FROM rule_sets")&&sql.includes("state='ACTIVE'"))return{rows:[]};
    if(sql.includes("UPDATE group_bindings"))return{rows:[],rowCount:0};
    if(sql.includes("UPDATE rule_sets")&&sql.includes("SET state='ACTIVE'"))return{rows:[{id:ruleSetId,family_id:ruleFamilyId,version:1,state:"ACTIVE",revision:2,snapshot_sha256:"c".repeat(64)}],rowCount:1};
    throw new Error(`Unexpected group action query: ${sql}`);
  }};
  const governance=new RuleGovernanceService({withTenant:async(_tenant,callback)=>callback(ruleClient)},new RuleTestService());
  const groupActivated=await governance.activate(principal,ruleSetId,"activate-shared-command","request-group",{expectedRevision:1,expectedActiveRuleSetId:null,expectedActiveRevision:null});
  assert.equal(groupActivated.id,ruleSetId);

  const pinClient={query:async(sql)=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[{id:actionId,revision:7,active_revision_id:"45100000-0000-4000-8000-000000000009",secret_reference:null}]};
    if(sql.includes("FROM bot_action_jobs")||sql.includes("FROM bot_flow_versions version"))return{rows:[],rowCount:0};
    if(sql.includes("FROM trigger_rules rule"))return{rows:[{exists:1}],rowCount:1};
    throw new Error(`Unexpected shared action pin query: ${sql}`);
  }};
  const catalog=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(pinClient)});
  await assert.rejects(()=>catalog.saveAction(principal,"request-change-shared",{actionKey,name:"Shared",kind:"HTTP_JSON",endpointUrl:"https://orders.example/status",httpMethod:"GET",authScheme:"NONE",secretReference:null,headers:{},responseMapping:{"action.state":"/state"},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE",expectedRevision:7}),/pinned by an active group command/);
});

test("unchanged direct-flow reactivation copies the retired source revision without duplicate pin conflict",async()=>{
  const actionKey="orders.rollback";
  const actionId="45000000-0000-4000-8000-000000000019";
  const sourceVersionId="42000000-0000-4000-8000-000000000019";
  const rollbackVersionId="42000000-0000-4000-8000-000000000020";
  const revisionOneId="45100000-0000-4000-8000-000000000019";
  const definition={schemaVersion:1,name:"Rollback flow",start:"lookup",maxSteps:5,nodes:[
    {id:"lookup",type:"action",actionId:actionKey,input:{},onSuccess:"done",onFailure:"done"},
    {id:"done",type:"end"},
  ]};
  let copied=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock")||sql.includes("INSERT INTO audit_events")||sql.includes("INSERT INTO bot_flow_operations"))return{rows:[],rowCount:1};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[]};
    if(sql.includes("SELECT definition,family_id,supersedes_flow_version_id,snapshot_sha256"))return{rows:[{definition,family_id:familyId,supersedes_flow_version_id:sourceVersionId,snapshot_sha256:"7".repeat(64)}]};
    if(sql.includes("INSERT INTO automation_action_revision_pins")&&sql.includes("SELECT source.tenant_id")){
      copied+=1;assert.deepEqual(values,[rollbackVersionId,tenantId,sourceVersionId,"7".repeat(64)]);assert.match(sql,/ON CONFLICT DO NOTHING/);return{rows:[],rowCount:1};
    }
    if(sql.includes("FROM automation_action_revision_pins pin"))return{rows:[{id:actionId,action_key:actionKey,active_revision_id:revisionOneId,response_mapping:{"action.status":"/status"},kind:"HTTP_JSON",endpoint_url:"https://revision-one.example/status",http_method:"GET",auth_scheme:"NONE",secret_reference:null}]};
    if(sql.includes("FROM bot_action_definitions")&&sql.includes("state='ACTIVE'"))throw new Error("rollback must not resolve the current revision");
    if(sql.includes("app.activate_bot_flow_version"))return{rows:[{active_flow_version_id:rollbackVersionId,retired_flow_version_id:"42000000-0000-4000-8000-000000000021",revision:2,assignments_migrated:1}]};
    throw new Error(`Unexpected rollback activation query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const result=await service.activate(principal,rollbackVersionId,"rollback-direct-v1","request-rollback-direct",{expectedRevision:1,expectedActiveFlowVersionId:"42000000-0000-4000-8000-000000000021"});
  assert.equal(result.flowVersionId,rollbackVersionId);
  assert.equal(copied,1);
});

test("saving an external action endpoint requires recent MFA before any mutation",async()=>{
  let mutations=0;
  const client={query:async sql=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("FROM bot_flow_operations"))return{rows:[],rowCount:0};
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    mutations+=1;throw new Error(`Unexpected mutation: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  const input={actionKey:"orders.lookup",name:"Lookup",kind:"HTTP_JSON",endpointUrl:"https://orders.example/status",httpMethod:"GET",authScheme:"NONE",secretReference:null,headers:{},responseMapping:{},timeoutMs:5000,maxResponseBytes:2048,state:"ACTIVE",expectedRevision:null};
  await assert.rejects(()=>service.saveAction({...principal,authenticatedAt:principal.authenticatedAt-16*60},"stale-action",input),error=>error?.getResponse?.().code==="REAUTHENTICATION_REQUIRED");
  assert.equal(mutations,0);
});

test("restoring a plugin revision creates one new fenced immutable revision and records its source",async()=>{
  const actionId="45000000-0000-4000-8000-000000000031";const audit=[];const client={query:async(sql,values=[])=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("SELECT id,revision,active_revision_id,secret_reference FROM bot_action_definitions"))return{rows:[{id:actionId,revision:3,active_revision_id:"45100000-0000-4000-8000-000000000033",secret_reference:null}],rowCount:1};
    if(sql.includes("FROM bot_action_jobs")||sql.includes("FROM bot_flow_versions version")||sql.includes("FROM trigger_rules rule"))return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO bot_action_revisions")){assert.equal(values[3],4);assert.equal(values[4],"Historical lookup");return{rows:[],rowCount:1};}
    if(sql.includes("UPDATE bot_action_definitions")){assert.equal(values[11],4);return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO audit_events")){audit.push(values);return{rows:[],rowCount:1};}
    throw new Error(`Unexpected restore query: ${sql}`);
  }};
  const database={rows:async()=>[{name:"Historical lookup",kind:"HTTP_JSON",endpoint_url:"https://orders.example/status",http_method:"GET",auth_scheme:"NONE",secret_reference:null,headers:{},response_mapping:{"action.status":"/status"},timeout_ms:5000,max_response_bytes:2048,state:"ACTIVE"}],withTenant:async(_tenant,callback)=>callback(client)};
  const service=new BotFlowsService(database);const result=await service.restoreActionRevision(principal,"orders.lookup","1","restore-orders","request-restore",{expectedRevision:3});
  assert.equal(result.revision,4);assert.equal(result.actionKey,"orders.lookup");assert.match(JSON.stringify(audit),/bot_action\.restored/);assert.match(JSON.stringify(audit),/restored_from_revision/);
  await assert.rejects(()=>service.restoreActionRevision(principal,"orders.lookup","1","restore-stale","request-stale",{expectedRevision:2}),/Bot action changed/);
});

test("plugin qualification is replay-safe, revision-pinned, idempotent, and reports structured timeout",async()=>{
  const actionId="45000000-0000-4000-8000-000000000010";
  const actionRevisionId="45100000-0000-4000-8000-000000000010";
  const qualificationId="45200000-0000-4000-8000-000000000010";
  let queued;let wakes=0;let auditCount=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("qualification_idempotency_key=$2"))return{rows:queued?[queued]:[],rowCount:queued?1:0};
    if(sql.includes("FROM bot_action_definitions")&&sql.includes("state='ACTIVE' FOR SHARE"))return{rows:[{id:actionId,revision:4,active_revision_id:actionRevisionId,kind:"HTTP_JSON",endpoint_url:"https://api.example.test/status",http_method:"GET",auth_scheme:"NONE",secret_reference:null}],rowCount:1};
    if(sql.includes("INSERT INTO bot_action_jobs")){queued={id:qualificationId,state:"QUEUED",qualification_request_sha256:values[6],action_revision_id:values[2],action_key:"orders.lookup",action_revision:4};return{rows:[{id:qualificationId}],rowCount:1};}
    if(sql.includes("INSERT INTO audit_events")){auditCount+=1;return{rows:[],rowCount:1};}
    throw new Error(`Unexpected qualification query: ${sql}`);
  }};
  const database={withTenant:async(_tenant,callback)=>callback(client),rows:async()=>[{id:qualificationId,state:"FAILED_TERMINAL",safe_error:"Bot action timed out",created_at:"2026-08-24T10:00:00.000Z",updated_at:"2026-08-24T10:00:03.000Z",completed_at:"2026-08-24T10:00:03.000Z",action_revision:4}]};
  const service=new BotFlowsService(database,{wake:async()=>{wakes+=1}});
  const first=await service.qualifyAction(principal,"orders.lookup","qualify-orders","request-qualification",{expectedRevision:4,input:{order_id:"42"}});
  const replay=await service.qualifyAction(principal,"orders.lookup","qualify-orders","request-replay",{expectedRevision:4,input:{order_id:"42"}});
  assert.deepEqual(first,{qualificationId,actionKey:"orders.lookup",actionRevision:4,state:"QUEUED",duplicate:false});
  assert.equal(replay.duplicate,true);assert.equal(wakes,1);assert.equal(auditCount,1);
  await assert.rejects(()=>service.qualifyAction(principal,"orders.lookup","qualify-orders","request-conflict",{expectedRevision:5,input:{order_id:"42"}}),/Idempotency key was already used/);
  const status=await service.getActionQualification(principal,"orders.lookup",qualificationId);
  assert.equal(status.state,"FAILED");assert.equal(status.outcome,"TIMEOUT");
});

test("plugin qualification refuses write-capable actions and advertises only active replay-safe actions",async()=>{
  const postClient={query:async sql=>{
    if(sql.includes("SELECT privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}],rowCount:1};
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
    if(sql.includes("qualification_idempotency_key=$2"))return{rows:[],rowCount:0};
    if(sql.includes("FROM bot_action_definitions"))return{rows:[{id:"45000000-0000-4000-8000-000000000011",revision:1,active_revision_id:"45100000-0000-4000-8000-000000000011",kind:"HTTP_JSON",endpoint_url:"https://api.example.test/update",http_method:"POST",auth_scheme:"NONE",secret_reference:null}],rowCount:1};
    throw new Error(`Unexpected write qualification query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(postClient),rows:async()=>[
    {action_key:"safe.get",kind:"HTTP_JSON",endpoint_url:"https://api.example.test/status",http_method:"GET",auth_scheme:"NONE",secret_reference:null,state:"ACTIVE"},
    {action_key:"unsafe.post",kind:"HTTP_JSON",endpoint_url:"https://api.example.test/update",http_method:"POST",auth_scheme:"NONE",secret_reference:null,state:"ACTIVE"},
    {action_key:"paused.get",kind:"HTTP_JSON",endpoint_url:"https://api.example.test/status",http_method:"GET",auth_scheme:"NONE",secret_reference:null,state:"PAUSED"},
  ]});
  await assert.rejects(()=>service.qualifyAction(principal,"unsafe.post","qualify-post","request-post",{expectedRevision:1,input:{}}),/Only replay-safe GET actions/);
  assert.deepEqual((await service.listActions(principal)).map(row=>row.qualification_supported),[true,false,false]);
});

test("action revision integrity migration pins behavior and fails closed at tenant and secret boundaries",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0108_bot_action_revision_integrity.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE TABLE bot_action_revisions[\s\S]*UNIQUE \(tenant_id,action_definition_id,revision\)/u);
  assert.match(sql,/bot_action_revisions_immutable[\s\S]*BEFORE UPDATE/u);
  assert.match(sql,/bot_action_revisions_secret_boundary[\s\S]*BEFORE INSERT/u);
  assert.match(sql,/bot_action_projection_matches_revision[\s\S]*DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(sql,/enforce_bot_action_actor_membership[\s\S]*tenant_memberships membership[\s\S]*membership\.tenant_id=NEW\.tenant_id[\s\S]*membership\.state='ACTIVE'/u);
  assert.match(sql,/bot_action_revision_actor_membership[\s\S]*bot_action_credential_stage_actor_membership[\s\S]*bot_action_job_actor_membership/u);
  assert.match(sql,/CREATE TABLE automation_action_revision_pins[\s\S]*bot_flow_version_id uuid[\s\S]*rule_set_id uuid[\s\S]*FOREIGN KEY \(tenant_id,action_definition_id,action_revision_id\)/u);
  assert.match(sql,/automation_action_revision_pins_flow_action_idx[\s\S]*automation_action_revision_pins_rule_action_idx/u);
  assert.match(sql,/group_action_executions_action_revision_fk[\s\S]*group_action_execution_revision_required[\s\S]*BEFORE INSERT/u);
  assert.match(sql,/enforce_group_action_execution_identity[\s\S]*action_revision_id IS DISTINCT FROM OLD\.action_revision_id[\s\S]*group action execution identity is immutable/u);
  assert.match(sql,/origin='QUALIFICATION'[\s\S]*conversation_id IS NULL[\s\S]*qualification_request_sha256/u);
  assert.doesNotMatch(sql,/FOREIGN KEY \(tenant_id,(?:created_by|qualification_requested_by)\)[\s\S]*tenant_memberships/u);
  assert.match(sql,/expires_at timestamptz NOT NULL DEFAULT \(now\(\)\+interval '1 hour'\)/u);
  assert.match(sql,/secret_cleanup_outbox_action_credential_stage_fk[\s\S]*ON DELETE RESTRICT/u);
  assert.match(sql,/BOT_ACTION_CREDENTIAL_STAGE[\s\S]*track_bot_action_credential_stage[\s\S]*schedule_bound_bot_action_credential_cleanup/u);
  assert.match(sql,/track_bot_action_credential_stage[\s\S]*NEW\.expires_at>clock_timestamp\(\)\+interval '1 hour'/u);
  assert.match(sql,/enforce_bot_action_credential_stage_transition[\s\S]*clock_timestamp\(\)>=OLD\.expires_at[\s\S]*cleanup\.state='QUEUED'/u);
  assert.match(sql,/OLD\.state='STAGED' AND NEW\.state='STAGED'[\s\S]*NEW\.expires_at>clock_timestamp\(\)\+interval '1 hour'[\s\S]*cleanup\.state='QUEUED'/u);
  assert.match(sql,/stage\.state='STAGED' AND stage\.expires_at<=clock_timestamp\(\)[\s\S]*stage\.state='BOUND'[\s\S]*tenant\.state='DELETING'[\s\S]*FOR UPDATE OF stage SKIP LOCKED/u);
  assert.match(sql,/revision\.secret_reference=stage\.secret_reference[\s\S]*job\.state IN \('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN'\)/u);
  assert.match(sql,/bot_action_revisions_secret_cleanup_idx[\s\S]*secret_reference IS NOT NULL/u);
  assert.match(sql,/UPDATE bot_action_definitions action[\s\S]*SET auth_scheme='NONE',secret_reference=NULL[\s\S]*action\.state='PAUSED'/u);
  for(const table of ["bot_action_revisions","bot_action_credential_stages","automation_action_revision_pins"])assert.match(sql,new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  assert.match(sql,/REVOKE INSERT,UPDATE,DELETE ON bot_action_revisions FROM wasalx_app/u);
  assert.match(sql,/GRANT UPDATE \(state,bound_action_revision_id,bound_at,expires_at\)[\s\S]*TO wasalx_app/u);
  assert.match(sql,/GRANT UPDATE \(id\) ON bot_action_credential_stages TO wasalx_secret_cleanup_executor/u);
});

test("pauses an assignment with optimistic concurrency and audit evidence",async()=>{
  const assignmentId="46000000-0000-4000-8000-000000000001";let auditCount=0;
  const client={query:async(sql,values=[])=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("UPDATE bot_assignments")){assert.deepEqual(values,["PAUSED",userId,tenantId,assignmentId,3]);return{rows:[{id:assignmentId,state:"PAUSED",revision:4}]};}
    if(sql.includes("INSERT INTO audit_events")){auditCount+=1;return{rows:[]};}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  assert.deepEqual(await service.setAssignmentState(principal,assignmentId,"pause-assignment", "request-pause",{state:"PAUSED",expectedRevision:3}),{assignmentId,state:"PAUSED",revision:4,duplicate:false});
  assert.equal(auditCount,1);
  assert.throws(()=>service.setAssignmentState(principal,assignmentId,"bad-assignment","request-bad",{state:"BROKEN",expectedRevision:4}),/state is invalid/);
});

test("updates direct agent attribution through the revision-fenced assignment boundary",async()=>{
  const assignmentId="46000000-0000-4000-8000-000000000002";let auditCount=0;
  const client={query:async(sql,values=[])=>{
    const operation=emptyActionOperation(sql);if(operation)return operation;
    if(sql.includes("SET agent_prefix=$1")){assert.deepEqual(values,["Handled by","FOOTER",userId,tenantId,assignmentId,8]);return{rows:[{id:assignmentId,agent_prefix:"Handled by",agent_identity_placement:"FOOTER",revision:9}]};}
    if(sql.includes("INSERT INTO audit_events")){auditCount+=1;return{rows:[]};}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
  assert.deepEqual(await service.setAssignmentAttribution(principal,assignmentId,"assignment-attribution","request-attribution",{agentPrefix:"Handled by",agentIdentityPlacement:"FOOTER",expectedRevision:8}),{assignmentId,agentPrefix:"Handled by",agentIdentityPlacement:"FOOTER",revision:9,duplicate:false});
  assert.equal(auditCount,1);
  assert.throws(()=>service.setAssignmentAttribution(principal,assignmentId,"bad-attribution","request-bad",{agentPrefix:"Agent:",agentIdentityPlacement:"SIDE",expectedRevision:9}),/placement is invalid/);
});

test("reassigning a direct flow preserves omitted attribution and returns the saved preference",async()=>{
  const assignmentId="46000000-0000-4000-8000-000000000002",connectionId="43000000-0000-4000-8000-000000000001";
  for(const scenario of [
    {saved:{agent_prefix:"Handled by",agent_identity_placement:"FOOTER"},input:{}},
    {saved:{agent_prefix:"Handled by",agent_identity_placement:"OFF"},input:{}},
    {saved:{agent_prefix:"Agent:",agent_identity_placement:"HEADER"},input:{}},
    {saved:{agent_prefix:"Handled by",agent_identity_placement:"FOOTER"},input:{agentPrefix:"Support:"}},
    {saved:{agent_prefix:"Handled by",agent_identity_placement:"FOOTER"},input:{agentIdentityPlacement:"HEADER"}},
    {saved:{agent_prefix:"Handled by",agent_identity_placement:"FOOTER"},input:{agentPrefix:"Agent:",agentIdentityPlacement:"HEADER"}},
  ]){
    const saved={...scenario.saved};let operation,audited;
    const client={query:async(sql,values=[])=>{
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
      if(sql.includes("FROM bot_flow_operations"))return{rows:operation?[operation]:[]};
      if(sql.startsWith("SELECT id FROM bot_flow_versions"))return{rows:[{id:versionId}]};
      if(sql.startsWith("SELECT definition,family_id"))return{rows:[{definition}]};
      if(sql.includes("FROM connections connection"))return{rows:[{provider:"WAHA",state:"WORKING",definition,flow_version_id:versionId}]};
      if(sql.includes("app.assign_bot_flow")){assert.deepEqual(values,[connectionId,familyId,"2",versionId,userId]);return{rows:[{assignment_id:assignmentId,flow_version_id:versionId,revision:8}]};}
      if(sql.includes("UPDATE bot_assignments")){
        assert.match(sql,/agent_prefix=COALESCE\(\$1,agent_prefix\),agent_identity_placement=COALESCE\(\$2,agent_identity_placement\)/u);
        assert.deepEqual(values,[scenario.input.agentPrefix??null,scenario.input.agentIdentityPlacement??null,tenantId,assignmentId]);
        saved.agent_prefix=values[0]??saved.agent_prefix;saved.agent_identity_placement=values[1]??saved.agent_identity_placement;
        return{rows:[saved]};
      }
      if(sql.includes("INSERT INTO audit_events")){audited=values;return{rows:[]};}
      if(sql.includes("INSERT INTO bot_flow_operations")){operation={action:values[1],request_sha256:values[3],result:values[4]};return{rows:[]};}
      throw new Error(`Unexpected query: ${sql}`);
    }};
    const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
    const input={connectionId,familyId,zammadGroupId:"2",...scenario.input};
    const result=await service.assign(principal,"reassign-preserve-attribution","request-reassign",input);
    assert.deepEqual(result,{assignmentId,flowVersionId:versionId,...input,agentPrefix:saved.agent_prefix,agentIdentityPlacement:saved.agent_identity_placement,revision:8,duplicate:false});
    assert.ok(audited);
    assert.deepEqual(await service.assign(principal,"reassign-preserve-attribution","request-replay",input),{...result,duplicate:true});
    const differentAttribution=Object.keys(scenario.input).length?{connectionId,familyId,zammadGroupId:"2"}:{...input,agentPrefix:"Agent:",agentIdentityPlacement:"HEADER"};
    await assert.rejects(()=>service.assign(principal,"reassign-preserve-attribution","different-input",differentAttribution),/Idempotency key was already used/);
    assert.throws(()=>service.assign(principal,"invalid-placement","invalid",{...input,agentIdentityPlacement:"SIDE"}),/placement is invalid/);
    assert.throws(()=>service.assign(principal,"invalid-prefix","invalid",{...input,agentPrefix:""}),/Agent prefix/);
  }
});

test("pre-upgrade assignment receipts replay their original result without mutating attribution",async()=>{
  for(const attribution of [{},{agentPrefix:"Handled by"},{agentIdentityPlacement:"FOOTER"}]){
    const input={connectionId:"43000000-0000-4000-8000-000000000001",familyId,zammadGroupId:"2",...attribution};
    const legacyInput={connectionId:input.connectionId,familyId:input.familyId,zammadGroupId:input.zammadGroupId,agentPrefix:input.agentPrefix??"Agent:",agentIdentityPlacement:input.agentIdentityPlacement??"HEADER"};
    const result={assignmentId:"46000000-0000-4000-8000-000000000002",flowVersionId:versionId,...legacyInput,revision:8};
    const requestSha256=createHash("sha256").update(JSON.stringify({action:"ASSIGN",input:legacyInput})).digest("hex");
    const client={query:async(sql)=>{
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};
      if(sql.includes("FROM bot_flow_operations"))return{rows:[{action:"ASSIGN",request_sha256:requestSha256,result}]};
      throw new Error(`Legacy replay must not mutate or read current assignment state: ${sql}`);
    }};
    const service=new BotFlowsService({withTenant:async(_tenant,callback)=>callback(client)});
    assert.deepEqual(await service.assign(principal,"legacy-assignment","request",input),{...result,duplicate:true});
    await assert.rejects(()=>service.assign(principal,"legacy-assignment","different-body",{...input,zammadGroupId:"3"}),/Idempotency key was already used/);
  }
});

test("fixture flow reassignment also retains the saved agent footer",async()=>{
  const assignment=(await getFixtureAssignments())[0];
  const saved=await setFixtureAttribution(String(assignment.id),{agentPrefix:"Handled by",agentIdentityPlacement:"FOOTER",expectedRevision:assignment.revision});
  const result=await assignFixtureFlow({connectionId:assignment.connection_id,familyId:assignment.flow_family_id,zammadGroupId:assignment.zammad_group_id});
  const current=(await getFixtureAssignments()).find(row=>row.id===assignment.id);
  assert.equal(result.agentPrefix,"Handled by");assert.equal(result.agentIdentityPlacement,"FOOTER");
  assert.equal(current.agent_prefix,"Handled by");assert.equal(current.agent_identity_placement,"FOOTER");
  assert.equal(result.revision,saved.revision+1);
});

test("direct conversation ownership projection is tenant-scoped, durable, and scheduled",async()=>{
  const migration=await readFile(new URL("../services/control-api/migrations/0123_zammad_direct_conversation_projection.sql",import.meta.url),"utf8");
  const worker=await readFile(new URL("../services/connector-worker/src/repository.ts",import.meta.url),"utf8");
  const outbound=await readFile(new URL("../services/control-api/src/zammad-internal.controller.ts",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE zammad_conversation_state_outbox[\s\S]*UNIQUE \(tenant_id,conversation_id\)/u);
  assert.match(migration,/FORCE ROW LEVEL SECURITY[\s\S]*tenant_id=app\.current_tenant_id\(\)/u);
  assert.match(migration,/AFTER INSERT OR UPDATE OF state,zammad_ticket_id ON bot_conversations/u);
  assert.match(migration,/conversation_fencing_token=EXCLUDED\.conversation_fencing_token[\s\S]*lease_id=NULL/u);
  assert.match(migration,/claim_zammad_conversation_state_jobs[\s\S]*FOR UPDATE SKIP LOCKED/u);
  assert.match(migration,/zammad_conversation_state_outbox state_job[\s\S]*state_job\.completed_at IS NULL/u);
  assert.match(worker,/beginConversationState[\s\S]*zammad_ticket_id=\$2[\s\S]*ORDER BY \(state<>'RESOLVED'\) DESC[\s\S]*current\.state===projection\.conversation_state/u);
  assert.match(outbound,/assignment\.agent_prefix,assignment\.agent_identity_placement/u);
  assert.match(outbound,/JOIN bot_assignments assignment ON assignment\.tenant_id=conversation\.tenant_id/u);
});

test("assignment guards are race-proof and resume requires a working connection",async()=>{
  const migration=await readFile(new URL("../services/control-api/migrations/0118_bot_assignment_active_flow_fence.sql",import.meta.url),"utf8");
  const serviceSource=await readFile(new URL("../services/control-api/src/bot-flows.service.ts",import.meta.url),"utf8");
  assert.match(migration,/connection\.state='WORKING'/);
  assert.match(migration,/tenant_memberships[\s\S]*state='ACTIVE'/u);
  assert.match(migration,/bot_flow_families[\s\S]*FOR SHARE[\s\S]*bot_flow_versions/u);
  assert.match(migration,/expected_active_flow_version_id[\s\S]*FOR SHARE[\s\S]*40001/u);
  assert.match(migration,/ON CONFLICT \(tenant_id,connection_id\) DO UPDATE[\s\S]*WHERE bot_assignments\.state='PAUSED'/);
  assert.doesNotMatch(migration,/WHERE bot_assignments\.flow_family_id IS DISTINCT FROM/);
  assert.match(migration,/bot assignment already active[\s\S]*23505/);
  assert.match(migration,/REVOKE ALL ON FUNCTION app\.assign_bot_flow\(uuid,uuid,text,uuid\) FROM wasalx_app/u);
  assert.match(serviceSource,/FOR SHARE OF connection`/u);
  assert.doesNotMatch(serviceSource,/FOR SHARE OF connection,version/u);
  assert.match(serviceSource,/app\.assign_bot_flow\(\$1,\$2,\$3,\$4,\$5\)[\s\S]*target\.flow_version_id/u);
  assert.match(serviceSource,/assignment\.state<>\$1[\s\S]*connection\.state='WORKING'/);
});

test("human handoff waits for every nonterminal bot delivery",async()=>{
  const source=await readFile(new URL("../services/control-api/src/bot-flows.service.ts",import.meta.url),"utf8");
  assert.match(source,/HANDOFF_TO_HUMAN[\s\S]*direct_origin='BOT'[\s\S]*state IN \('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE'\)/);
  assert.match(source,/state IN \('OUTCOME_UNKNOWN','BLOCKED'\) AND NOT app\.delivery_no_further_attempts\(tenant_id,id\)/);
  assert.match(source,/state='FAILED_TERMINAL' AND manual_retry_allowed/);
});

test("direct media is tenant pinned, projected to Zammad, and claimed as provider media",async()=>{
  const migration=await readFile(new URL("../services/control-api/migrations/0116_direct_flow_media_assets.sql",import.meta.url),"utf8");
  const inbound=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
  const repository=await readFile(new URL("../services/connector-worker/src/repository.ts",import.meta.url),"utf8");
  const processor=await readFile(new URL("../services/connector-worker/src/processor.ts",import.meta.url),"utf8");
  const workerMain=await readFile(new URL("../services/connector-worker/src/main.ts",import.meta.url),"utf8");
  const privacy=await readFile(new URL("../services/connector-worker/src/privacy-repository.ts",import.meta.url),"utf8");

  assert.match(migration,/FORCE ROW LEVEL SECURITY[\s\S]*bot_flow_media_asset_pins/);
  assert.match(migration,/CREATE TRIGGER bot_media_assets_immutable/);
  assert.match(migration,/bot_media_asset_actor_membership/);
  assert.match(migration,/bot_media_asset_count_limit[\s\S]*bot_media_asset_bytes_limit/);
  assert.match(migration,/media\.mime_type=NEW\.mime_type AND media\.byte_size=NEW\.byte_size/);
  assert.match(migration,/bot_content IS NOT NULL AND bot_content->>'type'='media'/);
  assert.match(migration,/PURGE_PENDING/);
  assert.match(migration,/state='PURGED' AND filename='\[removed\]' AND request_sha256 IS NULL AND declared_sha256 IS NULL AND media_object_id IS NULL AND content_sha256 IS NULL/);
  assert.match(migration,/state='FAILED' AND filename='\[removed\]' AND request_sha256 IS NULL AND declared_sha256 IS NULL AND media_object_id IS NULL AND content_sha256 IS NULL/);
  assert.match(migration,/bot_media_asset_id[\s\S]*delivery_media_source_check/);
  assert.match(inbound,/delivery\.mediaAssetId[\s\S]*INSERT INTO delivery_media[\s\S]*bot_flow_media_asset_pins/);
  assert.match(repository,/dm\.bot_media_asset_id[\s\S]*row\.bot_media_asset_id/);
  assert.match(repository,/renewDeliveryLease[\s\S]*lease_expires_at=now\(\)\+interval '5 minutes'[\s\S]*state='SENDING'[\s\S]*content_redacted_at IS NULL/u);
  assert.match(processor,/renewDeliveryLease[\s\S]*bot-media:\$\{job\.id\}[\s\S]*attachments:[\s\S]*linkBotArticle[\s\S]*job\.articleId=/);
  assert.match(workerMain,/new MediaUploadAdmission\(2,1\)[\s\S]*tryAcquire\(tenantId\)[\s\S]*readRequestBytes\(request,50_000_000,30_000\)[\s\S]*MediaUploadReadTimeoutError[\s\S]*connection":"close"[\s\S]*request\.destroy\(\)/);
  assert.ok(privacy.indexOf("UPDATE bot_media_assets asset")<privacy.indexOf("DELETE FROM media_objects media"));
  assert.match(privacy,/bot_media_assets asset[\s\S]*NOT \$3::boolean/);
  assert.match(privacy,/bot_flow_media_asset_pins pin[\s\S]*flow\.state='ACTIVE'[\s\S]*conversation\.state<>'RESOLVED'/);
  assert.match(privacy,/fenceBotMediaTargets[\s\S]*state='PURGE_PENDING'/);
  assert.match(privacy,/state='FAILED',filename='\[removed\]',request_sha256=NULL,declared_sha256=NULL[\s\S]*bot_media_asset\.upload_expired[\s\S]*UPLOAD_EXPIRED/);
  assert.match(inbound,/bot_media_asset\.upload_completed[\s\S]*SCAN_CLEAN/);
  assert.match(inbound,/bot_media_asset\.upload_failed[\s\S]*UPLOAD_REJECTED/);
  
  const service=await readFile(new URL("../services/control-api/src/bot-flows.service.ts",import.meta.url),"utf8");
  assert.match(service,/requestedIds\.length>100[\s\S]*WITH requested AS[\s\S]*id=ANY\(\$2::uuid\[\]\)[\s\S]*recent AS[\s\S]*LIMIT 200[\s\S]*UNION ALL[\s\S]*DISTINCT ON \(id\)/);
  assert.match(service,/validateMediaAssets\(client,principal\.tenantId,target\.flow_version_id[\s\S]*target\.provider,false\)/);
  assert.match(service,/\$3::boolean=false OR media\.expires_at>now\(\)/);
  assert.match(service,/pg_advisory_xact_lock[\s\S]*bot-media-upload:/);
  assert.match(service,/bot-media-quota:[\s\S]*FROM tenant_settings[\s\S]*count\(\*\)::text AS active_count[\s\S]*state IN \('UPLOADING','READY','RETIRED','PURGE_PENDING'\)/);
  assert.match(service,/uuid\(idempotencyKey,"Media upload idempotency key"\)/);
  assert.doesNotMatch(service,/bot_media_asset\.upload_started[\s\S]{0,240}filename/);
  assert.doesNotMatch(inbound,/bot_media_asset\.upload_(?:completed|failed)[\s\S]{0,300}jsonb_build_object\([^)]*filename/);
  assert.doesNotMatch(inbound,/bot_media_asset\.upload_(?:completed|failed)[\s\S]{0,300}jsonb_build_object\([^)]*(?:sha256|media_object_id)/);
  const portal=await readFile(new URL("../app/BotAutomation.tsx",import.meta.url),"utf8");
  assert.match(portal,/mediaUploadSha256\(file\)[\s\S]*mutationIntents\.current\.get\(intent\)[\s\S]*x-content-sha256":contentSha256/);
  const uploadRoute=await readFile(new URL("../app/api/bot-flows/media-assets/route.ts",import.meta.url),"utf8");
  assert.match(uploadRoute,/new MediaUploadAdmission\(2,1\)[\s\S]*readUploadBody[\s\S]*uploadReadTimeoutMs[\s\S]*tryAcquire\(principal\.tenantId\)/);
  assert.match(portal,/response\.status!==408&&response\.status!==429/);
  assert.match(portal,/editorMediaQuery\?editorMediaQuery\.split\(","\):\[\],result\.id,replacedAssetId/);
  assert.match(portal,/className="bot-node-card" disabled=\{uploading\} aria-busy=\{uploading\}/);
  assert.match(portal,/if\(type==="send_media"\)return\{id,type,assetId:"",next\}/);
  assert.ok([
    "application/zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ].every((mime) => portal.includes(mime)));
  assert.doesNotMatch(portal,/botData[\s\S]{0,1600}media-assets/);
});

test("pending actions keep inbound messages transcript-only and assignment lifecycle requires confirmation",async()=>{
  const inbound=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
  const portal=await readFile(new URL("../app/BotAutomation.tsx",import.meta.url),"utf8");
  const modal=await readFile(new URL("../app/ModalDialog.tsx",import.meta.url),"utf8");
  const pendingBoundary=inbound.indexOf('conversation.state==="ACTION_PENDING"');
  const flowAdvance=inbound.indexOf("const advanced=advanceBotFlow",pendingBoundary);
  assert.ok(pendingBoundary>0&&flowAdvance>pendingBoundary);
  assert.match(inbound.slice(pendingBoundary,flowAdvance),/return\{duplicate:false,queued:false,state:conversation\.state,ignored:false\}/);
  assert.match(portal,/confirmState=\{\(row: Row\) => \{ setError\(null\); setAssignmentTarget\(row\); \}\}/);
  assert.match(portal,/bot-assignment-state-title[\s\S]*data-modal-initial-focus[\s\S]*confirmAssignmentState/);
  assert.match(modal,/const restoreFocus = \(\) => \{[\s\S]*previousFocus\?\.isConnected[\s\S]*target\.focus\(\{ preventScroll: true \}\)/);
});

test("migration forces tenant isolation, immutable versions, append-only events, and sealed functions", async () => {
  const sql = await readFile(new URL("../services/control-api/migrations/0043_direct_bot_foundation.sql", import.meta.url), "utf8");
  for (const table of ["bot_flow_families", "bot_flow_versions", "bot_assignments", "bot_conversations", "bot_conversation_events", "bot_flow_operations"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(sql, /ALTER TABLE %I ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE %I FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE TRIGGER bot_flow_versions_immutable/);
  assert.match(sql, /CREATE TRIGGER bot_conversation_events_append_only/);
  assert.match(sql, /REVOKE INSERT,UPDATE,DELETE ON bot_flow_families,bot_flow_versions FROM wasalx_app/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.activate_bot_flow_version[^;]+ FROM PUBLIC/);
  assert.match(sql, /UNIQUE \(tenant_id,assignment_id,external_chat_id\)/);
  assert.match(sql, /UNIQUE \(tenant_id,event_inbox_id\)/);
  assert.doesNotMatch(sql, /GRANT UPDATE[^;]*bot_conversation_events/);
});

test("WhatsApp form responses are a durable conversation event",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0073_whatsapp_flow_events.sql",import.meta.url),"utf8");
  assert.match(sql,/FLOW_RESPONSE/);
  assert.match(sql,/DROP CONSTRAINT bot_conversation_events_event_kind_check/);
});

test("action migration is durable, fenced, tenant-isolated, and scheduler-visible",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0045_direct_bot_actions.sql",import.meta.url),"utf8");
  const sharedConnection=await readFile(new URL("../services/control-api/migrations/0082_shared_notion_action_connection.sql",import.meta.url),"utf8");
  for(const table of ["bot_action_definitions","bot_action_jobs"])assert.match(sql,new RegExp(`CREATE TABLE ${table}`));
  assert.match(sql,/FOR UPDATE OF job SKIP LOCKED/);
  assert.match(sql,/fencing_token=job\.fencing_token\+1/);
  for(const table of ["bot_action_definitions","bot_action_jobs"])assert.match(sql,new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
  assert.match(sql,/REVOKE ALL ON FUNCTION app\.claim_bot_action_jobs\(uuid,integer\) FROM PUBLIC/);
  assert.match(sql,/conversation\.id=delivery\.bot_conversation_id/);
  assert.match(sql,/bot_action_jobs action/);
  assert.match(sharedConnection,/kind = 'NOTION_CREATE_PAGE'/u);
  assert.ok(sharedConnection.includes("routing/integrations/[0-9a-f-]{36}"));
});

test("group commands reuse the tenant action catalog with durable unknown-outcome recovery",async()=>{
  const migration=await readFile(new URL("../services/control-api/migrations/0078_group_action_execution.sql",import.meta.url),"utf8");
  const repository=await readFile(new URL("../services/connector-worker/src/inbound-repository.ts",import.meta.url),"utf8");
  const processor=await readFile(new URL("../services/connector-worker/src/inbound-processor.ts",import.meta.url),"utf8");
  const governance=await readFile(new URL("../services/control-api/src/rule-governance.service.ts",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE group_action_executions/);
  assert.match(migration,/UNIQUE \(tenant_id,event_inbox_id,trigger_rule_id\)/);
  assert.match(migration,/action_snapshot jsonb NOT NULL/);
  assert.match(migration,/state IN \('PREPARED','RUNNING','FAILED_RETRYABLE','SUCCEEDED','FAILED_TERMINAL','OUTCOME_UNKNOWN'\)/);
  assert.match(migration,/ALTER TABLE group_action_executions FORCE ROW LEVEL SECURITY/);
  assert.match(repository,/FROM bot_action_definitions[\s\S]*state='ACTIVE'/);
  assert.doesNotMatch(repository,/state='ACTIVE' AND kind='HTTP_JSON' AND http_method='GET'/);
  assert.match(repository,/supportsBotActionInvocation[\s\S]*GROUP_COMMAND/);
  assert.match(repository,/state='OUTCOME_UNKNOWN'[\s\S]*requires operator review/);
  assert.match(repository,/INSERT INTO audit_events[\s\S]*group_action_execution/);
  assert.match(processor,/beginGroupCommandAction[\s\S]*claimGroupCommandAction[\s\S]*executeBotAction[\s\S]*completeGroupCommandAction/);
  assert.match(processor,/GroupCommandOutcomeUnknownError/);
  for(const variable of ["channel.provider","message.id","group.name","customer.login"]){
    assert.match(governance,new RegExp(variable.replace(".","\\.")));
    assert.match(processor,new RegExp(variable.replace(".","\\.")));
  }
});

test("direct bot lifetime steps remain observable without imposing a 100-message failure",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0049_direct_bot_runtime_bounds.sql",import.meta.url),"utf8");
  assert.match(sql,/DROP CONSTRAINT bot_conversations_step_count_check/);
  assert.match(sql,/CHECK \(step_count>=0\)/);
});

test("operator recovery permits one active handoff retry and extends the idempotent operation ledger",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0051_direct_bot_operator_recovery.sql",import.meta.url),"utf8");
  assert.match(sql,/CONVERSATION_COMMAND/);
  assert.match(sql,/CREATE UNIQUE INDEX bot_handoff_jobs_one_active/);
  assert.match(sql,/WHERE state NOT IN \('SUCCEEDED','FAILED_TERMINAL'\)/);
});

test("handoff jobs pin the routed Zammad owner",async()=>{
  const sql=await readFile(new URL("../services/control-api/migrations/0058_bot_handoff_owner.sql",import.meta.url),"utf8");
  assert.match(sql,/ADD COLUMN zammad_owner_id text/);
  assert.match(sql,/zammad_owner_id ~ '\^\[1-9\]\[0-9\]\{0,15\}\$'/);
});

test("bot delivery origin fences retry and handoff completion",async()=>{
  const migration=await readFile(new URL("../services/control-api/migrations/0063_direct_bot_delivery_origin.sql",import.meta.url),"utf8");
  const resolution=await readFile(new URL("../services/control-api/migrations/0064_direct_bot_resolution_kind.sql",import.meta.url),"utf8");
  const repository=await readFile(new URL("../services/connector-worker/src/repository.ts",import.meta.url),"utf8");
  const ambiguityFence=await readFile(new URL("../services/control-api/migrations/0072_bot_handoff_ambiguity_fence.sql",import.meta.url),"utf8");
  const controller=await readFile(new URL("../services/control-api/src/zammad-internal.controller.ts",import.meta.url),"utf8");
  assert.match(migration,/direct_origin IN \('BOT','HUMAN'\)/);
  assert.match(resolution,/resolution_kind IN \('FLOW','OPERATOR'\)/);
  assert.match(repository,/conversation\.state='HUMAN'[\s\S]*conversation\.resolution_kind IN \('OPERATOR','CUSTOMER_CONFIRMED'\)/);
  assert.match(repository,/Bot replies are still pending before human handoff/);
  assert.match(repository,/state IN \('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE'\)/);
  assert.match(repository,/state IN \('OUTCOME_UNKNOWN','BLOCKED'\) AND NOT app\.delivery_no_further_attempts\(tenant_id,id\)/);
  assert.match(repository,/state='FAILED_TERMINAL' AND manual_retry_allowed/);
  assert.match(ambiguityFence,/FAILED_RETRYABLE','OUTCOME_UNKNOWN','BLOCKED/g);
  assert.match(controller,/Bot replies cannot be retried while a person owns or has closed the conversation/);
});

test("direct replies use destination ordering and Zammad user privacy includes local history",async()=>{
  const ordering=await readFile(new URL("../services/control-api/migrations/0069_direct_delivery_destination_privacy.sql",import.meta.url),"utf8");
  const privacy=await readFile(new URL("../services/control-api/migrations/0066_zammad_user_local_privacy.sql",import.meta.url),"utf8");
  const repository=await readFile(new URL("../services/connector-worker/src/privacy-repository.ts",import.meta.url),"utf8");
  const outbox=await readFile(new URL("../services/connector-worker/src/repository.ts",import.meta.url),"utf8");
  const processor=await readFile(new URL("../services/connector-worker/src/processor.ts",import.meta.url),"utf8");
  const recoveryEvents=await readFile(new URL("../services/control-api/migrations/0067_bot_action_recovery_events.sql",import.meta.url),"utf8");
  assert.match(ordering,/predecessor\.connection_id=delivery\.connection_id[\s\S]*predecessor\.external_chat_id=delivery\.external_chat_id/);
  assert.match(ordering,/predecessor\.direct_origin IN \('BOT','HUMAN'\)/);
  assert.match(ordering,/predecessor\.state NOT IN \('SENT','DELIVERED','READ','PRIVACY_CANCELLED'\)[\s\S]*predecessor\.state<>'FAILED_TERMINAL' OR predecessor\.manual_retry_allowed/);
  assert.doesNotMatch(ordering,/predecessor\.bot_conversation_id=delivery\.bot_conversation_id/);
  assert.match(ordering,/request_type='EXPORT' AND disposition='EXPORT_ONLY'/);
  assert.match(outbox,/job\.botConversationId[\s\S]*bot_conversations[\s\S]*FOR UPDATE[\s\S]*UPDATE delivery_outbox delivery/);
  assert.match(privacy,/provider_metadata->>'zammad_customer_id'=requested_scope_value/);
  assert.match(repository,/job\.scopeType === "ZAMMAD_USER"[\s\S]*provider_metadata->>'zammad_customer_id'=\$2/);
  assert.match(processor,/result\.state==="OUTCOME_UNKNOWN"[\s\S]*outcomeUnknownBotAction[\s\S]*return/);
  assert.match(recoveryEvents,/ACTION_OUTCOME_UNKNOWN','ACTION_RETRY_REQUESTED/);
});

test("ambiguous action operator UI offers a no-reissue human handoff",async()=>{
  const source=await readFile(new URL("../app/BotAutomation.tsx",import.meta.url),"utf8");
  const messages=await readFile(new URL("../lib/i18n/messages/en/automation.ts",import.meta.url),"utf8");
  const fixture=await readFile(new URL("../lib/fixture-data.ts",import.meta.url),"utf8");
  assert.match(source,/HANDOFF_TO_HUMAN/);
  assert.match(source,/bot\.command\.handoffHelp/);
  assert.match(source,/bot\.notice\.handoff/);
  assert.match(messages,/without sending the uncertain external action again/);
  assert.match(messages,/external action was not sent again/);
  assert.match(fixture,/input\.action==="HANDOFF_TO_HUMAN"\)row\.state="HUMAN"/);
});

test("portal conversation controls are permissioned, idempotent, and no-store",async()=>{
  const route=await readFile(new URL("../app/api/bot-flows/conversations/[id]/command/route.ts",import.meta.url),"utf8");
  const list=await readFile(new URL("../app/api/bot-flows/conversations/route.ts",import.meta.url),"utf8");
  const events=await readFile(new URL("../app/api/bot-flows/conversations/[id]/events/route.ts",import.meta.url),"utf8");
  assert.match(route,/bot:operate/);assert.match(route,/idempotency-key/);assert.match(route,/private, no-store/);
  assert.match(list,/bot:read/);assert.match(list,/private, no-store/);
  assert.match(events,/bot:read/);assert.match(events,/private, no-store/);assert.doesNotMatch(events,/safe_metadata|metadata/);
});

test("conversation pages use a tenant-bound stable keyset without duplicates",async()=>{
  const activity="2026-08-23T12:34:56.123456Z";
  const ids=[
    "85000000-0000-4000-8000-000000000003",
    "85000000-0000-4000-8000-000000000002",
    "85000000-0000-4000-8000-000000000001",
  ];
  const listQueries=[];
  const database={rows:async(tenant,sql,values=[])=>{
    assert.equal(tenant,tenantId);
    listQueries.push({sql,values});
    const page=listQueries.length===1?ids:[ids[2]];
    return page.map(id=>({
      id,
      state:"BOT",
      last_activity_at:new Date("2026-08-23T12:34:56.123Z"),
      pagination_activity_at:activity,
    }));
  }};
  const service=new BotFlowsService(database);
  const first=await service.listConversations(principal,{limit:"2"});
  assert.deepEqual(first.items.map(row=>row.id),ids.slice(0,2));
  assert.equal("pagination_activity_at" in first.items[0],false);
  assert.equal(typeof first.next_cursor,"string");
  const second=await service.listConversations(principal,{limit:"2",cursor:first.next_cursor});
  assert.deepEqual(second.items.map(row=>row.id),[ids[2]]);
  assert.equal(second.next_cursor,null);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.id)).size,3);
  assert.match(listQueries[0].sql,/conversation\.tenant_id=\$1/);
  assert.match(listQueries[0].sql,/conversation\.flow_version_id/);
  assert.match(listQueries[0].sql,/action\.action_node_id/);
  assert.match(listQueries[0].sql,/\(conversation\.last_activity_at,conversation\.id\)<\(\$2::timestamptz,\$3::uuid\)/);
  assert.match(listQueries[0].sql,/ORDER BY conversation\.last_activity_at DESC,conversation\.id DESC LIMIT \$4/);
  assert.deepEqual(listQueries[0].values,[tenantId,null,null,3]);
  assert.deepEqual(listQueries[1].values,[tenantId,activity,ids[1],3]);
});

test("conversation cursors survive boundary mutation or deletion but reject invalid positions",async()=>{
  let databaseCalls=0;
  let databaseValues;
  const database={rows:async(tenant,sql,values=[])=>{
    databaseCalls+=1;
    databaseValues=values;
    assert.equal(tenant,tenantId);
    assert.match(sql,/conversation\.tenant_id=\$1/);
    assert.equal(values[0],tenantId);
    return[];
  }};
  const service=new BotFlowsService(database);
  for(const cursor of [
    "not-a-valid-cursor!",
    Buffer.from(JSON.stringify({v:1,tenant:"20000000-0000-4000-8000-000000000002",at:"2026-08-23T12:34:56.123456Z",id:"85000000-0000-4000-8000-000000000002"})).toString("base64url"),
    Buffer.from(JSON.stringify({v:1,tenant:tenantId,at:"2026-02-30T12:34:56.123456Z",id:"85000000-0000-4000-8000-000000000002"})).toString("base64url"),
  ])await assert.rejects(()=>service.listConversations(principal,{cursor,limit:"50"}),/Conversation cursor is invalid/);
  assert.equal(databaseCalls,0);
  const deletedBoundary=Buffer.from(JSON.stringify({v:1,tenant:tenantId,at:"2024-02-29T12:34:56.123456Z",id:"85000000-0000-4000-8000-000000000099"})).toString("base64url");
  const page=await service.listConversations(principal,{cursor:deletedBoundary,limit:"50"});
  assert.deepEqual(page,{items:[],next_cursor:null});
  assert.equal(databaseCalls,1);
  assert.deepEqual(databaseValues,[tenantId,"2024-02-29T12:34:56.123456Z","85000000-0000-4000-8000-000000000099",51]);
  await assert.rejects(()=>service.listConversations(principal,{cursor:deletedBoundary}),/page limit is required/);
  for(const limit of ["0","101","1.5","abc"])
    await assert.rejects(()=>service.listConversations(principal,{limit}),/Conversation page limit is invalid/);
  assert.equal(databaseCalls,1);
});

test("execution history is tenant-bound, safely projected, paginated, and preserves 404 parity",async()=>{
  const conversationId="85000000-0000-4000-8000-000000000001";
  const eventIds=["85100000-0000-4000-8000-000000000003","85100000-0000-4000-8000-000000000002"];
  const boundary="2026-08-23T12:34:56.123456Z";
  let exists=true;
  let transactionCount=0;
  const queries=[];
  const client={query:async(sql,values=[])=>{
    queries.push({sql,values});
    if(sql.includes("SELECT 1 FROM bot_conversations"))return{rows:exists?[{one:1}]:[],rowCount:exists?1:0};
    if(sql.includes("GROUP BY event.event_kind"))return{rows:[{kind:"ACTION_FAILED",from:"lookup",to:"handoff",at:new Date("2026-08-23T12:35:00.000Z")}],rowCount:1};
    if(sql.includes("FROM bot_conversation_events event"))return{rows:eventIds.map((id,index)=>({
      id,kind:index?"STARTED":"ACTION_FAILED",from:index?null:"lookup",to:index?"welcome":"handoff",at:new Date("2026-08-23T12:34:56.123Z"),pagination_created_at:boundary,
    })),rowCount:2};
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(tenant,callback)=>{
    transactionCount+=1;
    assert.equal(tenant,tenantId);
    return callback(client);
  }});
  const first=await service.listConversationEvents(principal,conversationId,{limit:"1"});
  assert.deepEqual(Object.keys(first.items[0]).sort(),["at","from","id","kind","to"]);
  assert.equal(first.items.length,1);
  assert.equal(typeof first.next_cursor,"string");
  assert.deepEqual(Object.keys(first.overlay_events[0]).sort(),["at","from","kind","to"]);
  assert.match(queries[1].sql,/event\.tenant_id=\$1 AND event\.conversation_id=\$2/);
  assert.match(queries[1].sql,/\(event\.created_at,event\.id\)<\(\$3::timestamptz,\$4::uuid\)/);
  assert.deepEqual(queries[1].values,[tenantId,conversationId,null,null,2]);

  const otherConversation="85000000-0000-4000-8000-000000000002";
  await assert.rejects(()=>service.listConversationEvents(principal,otherConversation,{cursor:first.next_cursor}),/cursor is invalid/iu);
  assert.equal(transactionCount,1);
  exists=false;
  await assert.rejects(()=>service.listConversationEvents(principal,conversationId),/not found/iu);
  assert.equal(transactionCount,2);
});

test("legacy conversation requests retain the no-query array response",async()=>{
  let values;
  const database={rows:async(_tenant,_sql,input=[])=>{
    values=input;
    return[{id:"85000000-0000-4000-8000-000000000001",last_activity_at:new Date("2026-08-23T12:34:56.123Z"),pagination_activity_at:"2026-08-23T12:34:56.123456Z"}];
  }};
  const result=await new BotFlowsService(database).listConversations(principal);
  assert.equal(Array.isArray(result),true);
  assert.equal("pagination_activity_at" in result[0],false);
  assert.deepEqual(values,[tenantId,null,null,200]);
});

test("conversation head refresh updates retained rows, keeps the deep cursor, and sorts deterministically",()=>{
  const current={items:[
    {id:"85000000-0000-4000-8000-000000000001",last_activity_at:"2026-08-23T10:00:00.000Z",state:"BOT"},
    {id:"85000000-0000-4000-8000-000000000002",last_activity_at:"2026-08-23T09:00:00.000Z",state:"BOT"},
  ],next_cursor:"deep-cursor"};
  const head={items:[
    {id:"85000000-0000-4000-8000-000000000002",last_activity_at:"2026-08-23T11:00:00.000Z",state:"HUMAN"},
    {id:"85000000-0000-4000-8000-000000000004",last_activity_at:"2026-08-23T11:00:00.000Z",state:"BOT"},
  ],next_cursor:"head-cursor"};
  const refreshed=refreshBotConversationPage(current,head,true);
  assert.equal(refreshed.next_cursor,"deep-cursor");
  assert.deepEqual(refreshed.items.map(row=>row.id),[
    "85000000-0000-4000-8000-000000000004",
    "85000000-0000-4000-8000-000000000002",
    "85000000-0000-4000-8000-000000000001",
  ]);
  assert.equal(refreshed.items.find(row=>row.id.endsWith("2")).state,"HUMAN");
  const appended=appendBotConversationPage(refreshed,{items:[head.items[0]],next_cursor:"next-deep-cursor"});
  assert.equal(appended.next_cursor,"next-deep-cursor");
  assert.equal(new Set(appended.items.map(row=>row.id)).size,3);
});

test("conversation execution pages merge safely, preserve deep cursors, and hide server text",async()=>{
  const current={items:[
    {id:"event-2",kind:"ACTION_SUCCEEDED",from:"lookup",to:"done",at:"2026-08-23T11:00:00.000Z"},
    {id:"event-1",kind:"STARTED",from:null,to:"welcome",at:"2026-08-23T09:00:00.000Z"},
  ],next_cursor:"deep-cursor",overlay_events:[{kind:"ACTION_SUCCEEDED",from:"lookup",to:"done",at:"2026-08-23T11:00:00.000Z"}]};
  const head={items:[
    {id:"event-3",kind:"HANDOFF_REQUESTED",from:"done",to:"handoff",at:"2026-08-23T12:00:00.000Z"},
    {id:"event-2",kind:"ACTION_FAILED",from:"lookup",to:"handoff",at:"2026-08-23T11:00:00.000Z"},
  ],next_cursor:"head-cursor",overlay_events:[{kind:"HANDOFF_REQUESTED",from:"done",to:"handoff",at:"2026-08-23T12:00:00.000Z"}]};
  const refreshed=refreshBotConversationEventPage(current,head,true);
  assert.equal(refreshed.next_cursor,"deep-cursor");
  assert.deepEqual(refreshed.items.map(row=>row.id),["event-3","event-2","event-1"]);
  assert.equal(refreshed.items.find(row=>row.id==="event-2").kind,"ACTION_FAILED");
  assert.deepEqual(refreshed.overlay_events,head.overlay_events);
  const appended=appendBotConversationEventPage(refreshed,{items:[head.items[0]],next_cursor:null,overlay_events:head.overlay_events});
  assert.equal(new Set(appended.items.map(row=>row.id)).size,3);

  let safeError;
  try{
    await fetchBotConversationEventPage({conversationId:"85000000-0000-4000-8000-000000000001"},async()=>new Response(JSON.stringify({error:"sensitive event metadata"}),{status:500,headers:{"content-type":"application/json"}}));
  }catch(error){safeError=error}
  assert.equal(safeError instanceof BotConversationEventPageError,true);
  assert.doesNotMatch(safeError.message,/sensitive|metadata/iu);
});

test("fixture execution pages bind cursors to one conversation",async()=>{
  const conversationId="85000000-0000-4000-8000-000000000001";
  const first=await getFixtureConversationEvents(conversationId,{limit:1});
  assert.equal(first.items.length,1);
  assert.equal(typeof first.next_cursor,"string");
  assert.equal("metadata" in first.items[0],false);
  const second=await getFixtureConversationEvents(conversationId,{limit:1,cursor:first.next_cursor});
  assert.equal(second.items.length,1);
  assert.notEqual(second.items[0].id,first.items[0].id);
  await assert.rejects(()=>getFixtureConversationEvents("85000000-0000-4000-8000-000000000002",{cursor:first.next_cursor}),/cursor is invalid/iu);
});

test("overlapping conversation requests abort the older refresh and never expose server text",async()=>{
  const older=new AbortController();
  const newer=new AbortController();
  let calls=0;
  const fetcher=(_url,{signal})=>new Promise((resolve,reject)=>{
    calls+=1;
    signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});
    if(calls===2)resolve(new Response(JSON.stringify({items:[],next_cursor:null}),{status:200,headers:{"content-type":"application/json"}}));
  });
  const olderResult=assert.rejects(fetchBotConversationPage({signal:older.signal},fetcher),error=>error.name==="AbortError");
  const newerResult=fetchBotConversationPage({signal:newer.signal},fetcher);
  older.abort();
  await olderResult;
  assert.deepEqual(await newerResult,{items:[],next_cursor:null});
  let safeError;
  try{
    await fetchBotConversationPage({},async()=>new Response(JSON.stringify({error:"sensitive database detail"}),{status:500,headers:{"content-type":"application/json"}}));
  }catch(error){safeError=error}
  assert.equal(safeError instanceof BotConversationPageError,true);
  assert.doesNotMatch(safeError.message,/sensitive|database/iu);
});

test("conversation pagination is propagated and exposes an accessible bilingual load-more contract",async()=>{
  const controller=await readFile(new URL("../services/control-api/src/bot-flows.controller.ts",import.meta.url),"utf8");
  const route=await readFile(new URL("../app/api/bot-flows/conversations/route.ts",import.meta.url),"utf8");
  const client=await readFile(new URL("../lib/control-plane-data.ts",import.meta.url),"utf8");
  const pagination=await readFile(new URL("../lib/bot-conversations.ts",import.meta.url),"utf8");
  const source=await readFile(new URL("../app/BotAutomation.tsx",import.meta.url),"utf8");
  const shell=await readTenantPortalSource();
  const english=await readFile(new URL("../lib/i18n/messages/en/automation.ts",import.meta.url),"utf8");
  const arabic=await readFile(new URL("../lib/i18n/messages/ar/automation.ts",import.meta.url),"utf8");
  const migration=await readFile(new URL("../services/control-api/migrations/0098_bot_conversation_pagination.sql",import.meta.url),"utf8");
  assert.match(controller,/@Query\("cursor"\)[\s\S]*@Query\("limit"\)[\s\S]*listConversations\(request\.principal, \{ cursor, limit \}\)/);
  assert.match(route,/authenticatePortalRequest\(request,"bot:read"\)[\s\S]*getAll\("cursor"\)[\s\S]*getBotConversations\(\{cursor,limit\}\)[\s\S]*private, no-store/);
  assert.match(route,/rawLimit===null\?BOT_CONVERSATION_PAGE_SIZE:Number\(rawLimit\)/);
  assert.match(client,/URLSearchParams[\s\S]*query\.set\("cursor"[\s\S]*query\.set\("limit",String\(input\.limit\?\?BOT_CONVERSATION_PAGE_SIZE\)\)[\s\S]*call<BotConversationPage>/);
  assert.match(source,/conversationPagesExtended[\s\S]*refreshBotConversationPage[\s\S]*appendBotConversationPage/);
  assert.match(source,/useVisibleRefresh\(\(signal\) => load\(true, signal\)/);
  assert.match(source,/fetchBotConversationPage\(\{ signal \}\)/);
  assert.match(shell,/<BotAutomation[\s\S]*key=\{String\(liveData\.tenant\.id\)\}/);
  assert.doesNotMatch(source,/conversationPages\(/);
  assert.doesNotMatch(pagination,/body\.(?:error|message)|responseError/);
  assert.match(source,/<button[\s\S]*type="button"[\s\S]*bot\.conversations\.loadMore[\s\S]*role="status"[\s\S]*aria-live="polite"/);
  for(const messages of [english,arabic]){
    assert.match(messages,/"bot\.conversations\.loadFailed"/);
    assert.match(messages,/"bot\.conversations\.loadMore"/);
    assert.match(messages,/"bot\.conversations\.loadingMore"/);
    assert.match(messages,/"bot\.conversations\.loadedMore"/);
    assert.match(messages,/"bot\.conversations\.loadMoreFailed"/);
  }
  assert.match(migration,/bot_conversation_events_timeline_idx[\s\S]*\(tenant_id,conversation_id,created_at DESC\)/);
  assert.match(migration,/bot_handoff_jobs_history_idx[\s\S]*\(tenant_id,conversation_id,created_at DESC\)/);
  assert.match(migration,/bot_conversations_tenant_activity_page_idx[\s\S]*\(tenant_id,last_activity_at DESC,id DESC\)/);
  assert.equal((migration.match(/CREATE INDEX/g)??[]).length,3);
});

test("bot operator forms expose bounded actions and catalog-backed handoff teams",async()=>{
  const source=await readFile(new URL("../app/BotAutomation.tsx",import.meta.url),"utf8");
  assert.match(source,/bot\.actionForm\.timeout[\s\S]*min=\{1000\}[\s\S]*max=\{10000\}/);
  assert.match(source,/bot\.actionForm\.responseLimit[\s\S]*min=\{1024\}[\s\S]*max=\{1048576\}/);
  assert.match(source,/maxLength=\{1024\}[\s\S]*bot\.node\.options/);
  assert.match(source,/maxLength=\{2000\}/);
  assert.match(source,/fetch\("\/api\/zammad\/routing-catalogs"/);
  assert.match(source,/supportTeams\.map\(\(team\) => <option/);
  assert.doesNotMatch(source,/useState\("2"\)/);
});

for(const action of ['RESUME_BOT','CLOSE'])for(const kind of ['reply','close'])test(`operator ${action} retains unresolved native ${kind} evidence`,async()=>{
  const conversationId='47000000-0000-4000-8000-000000000001';let mutations=0;
  const client={query:async(sql,values=[])=>{
    if(sql.includes('pg_advisory_xact_lock')||sql.includes('FROM bot_flow_operations'))return{rows:[],rowCount:0};
    if(sql.includes("version.definition->>'start'"))return{rows:[{state:'HUMAN',fencing_token:4,current_node_id:'handoff',start_node:'welcome',assignment_state:'ACTIVE',connection_state:'WORKING'}],rowCount:1};
    if(sql.includes("SELECT 'reply' AS kind,id FROM direct_native_reply_intents")){
      assert.deepEqual(values,[tenantId,conversationId,null,null]);return{rows:[{kind,id:'pending-native'}],rowCount:1};
    }
    if(/^(?:INSERT|UPDATE|DELETE)\b/u.test(sql.trim()))mutations++;
    throw new Error(`Unexpected held-command SQL: ${sql}`);
  }};
  const service=new BotFlowsService({withTenant:async(_tenant,work)=>work(client)});
  await assert.rejects(()=>service.commandConversation(principal,conversationId,`native-held-${action}-${kind}`,'request',{action,expectedFencingToken:4}),/DIRECT_NATIVE_EFFECT_HOLD/u);
  assert.equal(mutations,0);
});

test("automation resolves native team names and links only exact friendly ticket numbers", () => {
  const teams = [{ id: "2", name: "Customer care" }, { id: "7", name: "الدعم الفني" }];
  assert.equal(botSupportTeamName("2", teams, "Unavailable team"), "Customer care");
  assert.equal(botSupportTeamName("7", teams, "فريق غير متاح"), "الدعم الفني");
  assert.equal(botSupportTeamName("999", teams, "Unavailable team"), "Unavailable team");
  assert.equal(botSupportTeamName("999", [], "فريق غير متاح"), "فريق غير متاح");
  assert.equal(botConversationTicketNumber("10421"), "10421");
  assert.equal(botConversationTicketNumber(" #10421 "), "10421");
  for (const value of [null, undefined, 10421, "", "0", "10421&view=settings", "1/../../", "12345678901234567"]) {
    assert.equal(botConversationTicketNumber(value), null);
  }
});

test("automation ticket navigation preserves the canonical role permission and native-ID boundary", async () => {
  const [bot, shell] = await Promise.all([
    readFile(new URL("../app/BotAutomation.tsx", import.meta.url), "utf8"),
    readTenantPortalSource(),
  ]);
  assert.match(shell, /openTicket=\{!isPrivateDemo && can\(role, "ticket:read"\) \? ticket => navigate\("inbox", \{ ticket \}\) : undefined\}/u);
  assert.match(bot, /openTicket \? botConversationTicketNumber\(row\.zammad_ticket_number\) : null/u);
  assert.match(bot, /href=\{`\/app\?view=inbox&ticket=\$\{encodeURIComponent\(ticketNumber\)\}`\}/u);
  assert.doesNotMatch(bot, /botConversationTicketNumber\(row\.zammad_ticket_id\)/u);
  assert.equal(can("auditor", "ticket:read"), false);
  assert.equal(can("agent", "ticket:read"), true);
});
