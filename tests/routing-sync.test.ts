import assert from "node:assert/strict";
import test from "node:test";
import { RoutingSyncProcessor } from "../services/connector-worker/dist/services/connector-worker/src/routing-sync-processor.js";
import type { RoutingSyncContext, RoutingSyncJob, RoutingSyncRepository } from "../services/connector-worker/src/routing-sync-repository.ts";

const tenantId="10000000-0000-4000-8000-000000000001";
const manual={id:"manual",name:"Manual",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}} as const;

function job(kind:RoutingSyncJob["kind"],endpointUrl:string):RoutingSyncJob{return{id:"job-1",tenantId,sourceStateId:"source-1",sourceId:"crm",kind,syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl,scheduleMinutes:60,fieldMapping:{},configSha256:"a".repeat(64),snapshot:[],snapshotRevision:0,attempts:1,fencingToken:1}}
function harness(source:Record<string,unknown>,request:ConstructorParameters<typeof RoutingSyncProcessor>[2],secret:{accessToken?:string;token?:string;apiKey?:string;hmacKey?:string;value?:string}={accessToken:"opaque-token"},targets={groups:[{id:"2",active:true,serviceIdentityCanCreate:true}],owners:[] as Array<{id:string;active:boolean;groupIds:string[]}>}){
  const definition={schemaVersion:1,name:"Routing",supportGroupIds:["2"],fallback:{zammadGroupId:"2"},sources:[manual,source],clients:[]};const context={definition,states:[{sourceId:"crm",snapshot:{sourceId:"crm",revision:0,rows:[]}}],zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad"} as RoutingSyncContext;
  let completed:unknown;let failed:unknown;let resolved=false;let renewals=0;let qualificationCompleted=false;let revoked=false;const recoveryOrder:string[]=[];
  const repository={claim:async()=>[job(source.kind as RoutingSyncJob["kind"],String(source.endpointUrl))],bindingActive:async()=>true,context:async()=>context,renew:async()=>{renewals++;return true},complete:async(_job:unknown,_lease:unknown,_context:unknown,snapshot:unknown,_cursor:unknown,candidate:unknown)=>{completed={snapshot,candidate}},completeQualification:async()=>{qualificationCompleted=true;return true},revokeBinding:async()=>{revoked=true;recoveryOrder.push("revoke");return"integration-1"},fail:async(_job:unknown,_lease:unknown,retryable:unknown,safeError:unknown)=>{recoveryOrder.push("fail");failed={retryable,safeError}}} as unknown as RoutingSyncRepository;
  const processor=new RoutingSyncProcessor(repository,{resolve:async()=>{resolved=true;return secret}},request,async()=>targets,true);
  return{processor,result:()=>({completed,failed,resolved,renewals,qualificationCompleted,revoked,recoveryOrder})};
}

test("external routing worker is default-off before claims, secrets, or network",async()=>{
  const repository={claim:async()=>assert.fail("jobs must not be claimed while disabled")} as unknown as RoutingSyncRepository;
  const processor=new RoutingSyncProcessor(repository,{resolve:async()=>assert.fail("secrets must not be resolved while disabled")},async()=>assert.fail("network must not be reached"),undefined,false);
  assert.deepEqual(await processor.drainTenant(tenantId),{claimed:0,succeeded:0,failed:0});
});

test("generic HTTPS routing commits one complete provider-neutral snapshot",async()=>{
  let authorization="";let signature:string|undefined;const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes",scheduleMinutes:60,fieldMapping:{}};
  const gate=harness(source,async(_url,_method,headers)=>{authorization=headers.authorization??"";signature=headers["x-wasalx-signature"];return{status:200,headers:{"content-type":"application/json"},body:JSON.stringify({complete:true,rows:[{client_id:"acme",client_name:"Acme",zammad_group_id:"2",matcher_kind:"DOMAIN",matcher_value:"acme.example"}]})}},{accessToken:"opaque-token",hmacKey:"independent-webhook-signing-secret"});
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:1,failed:0});const result=gate.result() as {completed:{snapshot:{revision:number};candidate:{clients:Array<{id:string;routeSourceId:string}>}};failed:unknown;resolved:boolean};
  assert.equal(authorization,"Bearer opaque-token");assert.equal(signature,undefined);assert.equal(result.completed.snapshot.revision,1);assert.deepEqual(result.completed.candidate.clients.map(client=>[client.id,client.routeSourceId]),[["acme","crm"]]);assert.equal(result.failed,undefined);assert.equal(result.resolved,true);
  assert.equal(gate.result().renewals,3);
});

test("generic HTTPS routing supports a write-only HMAC connection without a bearer token",async()=>{
  const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes?tenant=northstar",scheduleMinutes:60,fieldMapping:{}};let headers:Record<string,string>={};
  const gate=harness(source,async(_url,_method,value)=>{headers=value;return{status:200,headers:{"content-type":"application/json"},body:JSON.stringify({complete:true,rows:[]})}},{hmacKey:"routing-signing-secret-value"});
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:1,failed:0});assert.equal(headers.authorization,undefined);assert.match(headers["x-wasalx-signature"]??"",/^sha256=[0-9a-f]{64}$/u);assert.match(headers["x-wasalx-timestamp"]??"",/^\d+$/u);
});

test("automatic sync rejects stale Zammad destinations before activation",async()=>{
  const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes",scheduleMinutes:60,fieldMapping:{}};
  const gate=harness(source,async()=>({status:200,headers:{"content-type":"application/json"},body:JSON.stringify({complete:true,rows:[]})}),{accessToken:"opaque-token"},{groups:[{id:"2",active:false,serviceIdentityCanCreate:true}],owners:[]});
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:0,failed:1});assert.equal(gate.result().completed,undefined);
  const safeError=String((gate.result().failed as {safeError:string}).safeError);assert.equal(safeError,"Some routing destinations are unavailable. Review the routing setup before activating this update.");assert.doesNotMatch(safeError,/\b2\b|Zammad|client/iu);
});

test("automatic sync cannot activate an older definition without explicit support scope",async()=>{
  const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes",scheduleMinutes:60,fieldMapping:{}};
  const gate=harness(source,async()=>({status:200,headers:{"content-type":"application/json"},body:JSON.stringify({complete:true,rows:[]})}));
  const repository=(gate.processor as unknown as {repository:{context:()=>Promise<RoutingSyncContext>}}).repository;
  const original=repository.context;
  repository.context=async()=>{const context=await original();delete context.definition.supportGroupIds;return context;};
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:0,failed:1});
  assert.equal(gate.result().completed,undefined);
  assert.equal((gate.result().failed as {retryable:boolean}).retryable,false);
});

test("Notion adapter follows opaque cursors and ignores unmapped complex properties",async()=>{
  const source={id:"crm",name:"Notion",kind:"NOTION",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",scheduleMinutes:60,fieldMapping:{client_id:"Client ID",client_name:"Name",zammad_group_id:"Group",matcher_kind:"Matcher type",matcher_value:"Matcher value"}};
  const bodies:string[]=[];const page=(id:string)=>({properties:{"Client ID":{type:"rich_text",rich_text:[{plain_text:id}]},Name:{type:"title",title:[{plain_text:id.toUpperCase()}]},Group:{type:"formula",formula:{type:"number",number:2}},"Matcher type":{type:"select",select:{name:"DOMAIN"}},"Matcher value":{type:"email",email:`${id}.example`},"Account owner":{type:"people",people:[{id:"ignored"}]},Relations:{type:"relation",relation:[{id:"ignored"}]}}});
  const gate=harness(source,async(_url,_method,headers,body)=>{assert.equal(headers["notion-version"],"2026-03-11");bodies.push(String(body));return bodies.length===1?{status:200,headers:{"content-type":"application/json"},body:JSON.stringify({results:[page("acme")],has_more:true,next_cursor:"opaque cursor"})}:{status:200,headers:{"content-type":"application/json"},body:JSON.stringify({results:[page("beta")],has_more:false,next_cursor:null})}});
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:1,failed:0});assert.equal(JSON.parse(bodies[1]!).start_cursor,"opaque cursor");
  const clients=(gate.result().completed as {candidate:{clients:Array<{id:string}>}}).candidate.clients;assert.deepEqual(clients.map(client=>client.id),["acme","beta"]);
});

test("Notion adapter omits blank mapped fields so a tombstone can remove a client",async()=>{
  const source={id:"crm",name:"Notion",kind:"NOTION",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",scheduleMinutes:60,fieldMapping:{client_id:"Client ID",client_name:"Name",zammad_group_id:"Group",matcher_kind:"Matcher type",matcher_value:"Matcher value",deleted:"Deleted"}};
  const blank={type:"rich_text",rich_text:[]};const page={properties:{"Client ID":{type:"rich_text",rich_text:[{plain_text:"retired-client"}]},Name:blank,Group:blank,"Matcher type":blank,"Matcher value":blank,Deleted:{type:"checkbox",checkbox:true}}};
  const gate=harness(source,async()=>({status:200,headers:{"content-type":"application/json"},body:JSON.stringify({results:[page],has_more:false,next_cursor:null})}));
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:1,failed:0});
  assert.deepEqual((gate.result().completed as {snapshot:{rows:unknown[]}}).snapshot.rows,[]);
});

test("routing failures store stable operator messages without upstream types, client names, or raw destination IDs",async()=>{
  const source={id:"crm",name:"Notion",kind:"NOTION",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",scheduleMinutes:60,fieldMapping:{client_name:"Customer name"}};
  const gate=harness(source,async()=>({status:200,headers:{"content-type":"application/json"},body:JSON.stringify({results:[{properties:{"Customer name":{type:"people",people:[{name:"Sensitive Customer",id:"998877"}]}}}],has_more:false})}));
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:0,failed:1});
  const safeError=String((gate.result().failed as {safeError:string}).safeError);
  assert.equal(safeError,"A mapped field uses an unsupported value type.");
  assert.doesNotMatch(safeError,/people|Sensitive Customer|998877|Notion/iu);
});

test("Zoho adapter uses official token auth and page-token pagination",async()=>{
  const source={id:"crm",name:"Zoho",kind:"ZOHO",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://www.zohoapis.eu/crm/v8/Accounts",scheduleMinutes:60,fieldMapping:{}};const urls:string[]=[];
  const row=(id:string)=>({client_id:id,client_name:id,zammad_group_id:"2",matcher_kind:"DOMAIN",matcher_value:`${id}.example`});
  const gate=harness(source,async(url,_method,headers)=>{urls.push(url.toString());assert.equal(headers.authorization,"Zoho-oauthtoken opaque-token");return urls.length===1?{status:200,headers:{"content-type":"application/json"},body:JSON.stringify({data:[row("acme")],info:{more_records:true,next_page_token:"next-token"}})}:{status:200,headers:{"content-type":"application/json"},body:JSON.stringify({data:[row("beta")],info:{more_records:false}})}});
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:1,failed:0});assert.equal(new URL(urls[1]!).searchParams.get("page_token"),"next-token");
});

test("worker rejects a cross-tenant connector secret before resolution",async()=>{
  const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes",scheduleMinutes:60,fieldMapping:{}};const gate=harness(source,async()=>assert.fail("network must not be reached"));
  const repository=(gate.processor as unknown as {repository:{claim:()=>Promise<RoutingSyncJob[]>}}).repository;const original=repository.claim;repository.claim=async()=>{const [claimed]=await original();return[{...claimed!,secretReference:"secret://tenants/other/routing/crm"}]};
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:0,failed:1});assert.deepEqual(gate.result().failed,{retryable:false,safeError:"This connection is not available for this workspace."});assert.equal(gate.result().resolved,false);
});

test("worker rejects a revoked or provider-mismatched routing connection before secret resolution",async()=>{
  const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes",scheduleMinutes:60,fieldMapping:{}};const gate=harness(source,async()=>assert.fail("network must not be reached"));
  const repository=(gate.processor as unknown as {repository:{bindingActive:()=>Promise<boolean>}}).repository;repository.bindingActive=async()=>false;
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:0,failed:1});assert.deepEqual(gate.result().failed,{retryable:false,safeError:"Reconnect this data source before syncing again."});assert.equal(gate.result().resolved,false);
});

test("draft qualification uses the connector adapter without activating routing",async()=>{
  const source={id:"crm",name:"CRM",kind:"HTTP_JSON",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://crm.example.com/routes",scheduleMinutes:60,fieldMapping:{}};const gate=harness(source,async()=>({status:200,headers:{"content-type":"application/json"},body:JSON.stringify({complete:true,rows:[]})}));
  const repository=(gate.processor as unknown as {repository:{claim:()=>Promise<RoutingSyncJob[]>,context:()=>Promise<unknown>}}).repository;const original=repository.claim;repository.claim=async()=>{const[claimed]=await original();return[{...claimed!,syncMode:"QUALIFICATION"}]};repository.context=async()=>assert.fail("qualification must not load or activate routing context");
  assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:1,failed:0});assert.equal(gate.result().qualificationCompleted,true);assert.equal(gate.result().completed,undefined);
});

test("401 and 403 revoke the exact routing binding before recording a terminal failure",async()=>{
  for(const status of [401,403]){const source={id:"crm",name:"Notion",kind:"NOTION",syncMode:"SCHEDULED",secretReference:`secret://tenants/${tenantId}/routing/crm`,endpointUrl:"https://api.notion.com/v1/data_sources/d9824bdc-8445-4327-be8b-5b47500af6ce/query",scheduleMinutes:60,fieldMapping:{}};const gate=harness(source,async()=>({status,headers:{"content-type":"application/json"},body:"{}"}));
    assert.deepEqual(await gate.processor.drainTenant(tenantId),{claimed:1,succeeded:0,failed:1});assert.equal(gate.result().revoked,true);assert.deepEqual(gate.result().recoveryOrder,["revoke","fail"]);assert.deepEqual(gate.result().failed,{retryable:false,safeError:"Reconnect this data source before syncing again."});}
});
