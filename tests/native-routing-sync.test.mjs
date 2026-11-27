import assert from "node:assert/strict";
import { createHash,createHmac } from "node:crypto";
import test from "node:test";
import { NativeRoutingSyncService,nativeRoutingStatus,validateNativeRoutingResponse } from "../services/control-api/dist/native-routing-sync.service.js";
import { buildNativeRoutingManifest } from "../services/control-api/dist/native-routing-manifest.js";
import { serializeNativeRoutingManifest } from "../packages/core/src/native-routing-contract.ts";
import { BotFlowsService } from "../services/control-api/dist/bot-flows.service.js";
import { NativeRoutingSyncController } from "../services/control-api/dist/native-routing-sync.controller.js";
const tenant="10000000-0000-4000-8000-000000000001",instance="11000000-0000-4000-8000-000000000001",policy="20000000-0000-4000-8000-000000000002";
const empty=()=>({group_references:[],assignments:[],department_defaults:[],client_routing:null});
const digest=value=>createHash("sha256").update(serializeNativeRoutingManifest(value)).digest("hex");
test("public native routing status expires old readbacks without mutation or permitting APPLY",()=>{
  const now=Date.parse("2026-10-16T10:00:00Z");
  const row={sync_state:"SYNCED",desired_revision:7,applied_revision:7,desired_sha256:"a".repeat(64),observed_sha256:"a".repeat(64),last_checked_at:new Date(now-6*60_000),error_code:null,safe_retry:true,department_defaults:[]};
  const before=structuredClone(row);
  assert.equal(nativeRoutingStatus(row,now).state,"SYNCED");
  for(const checkedAt of [new Date(now-6*60_000-1),null,"invalid",new Date(now+30_001)]){
    const stale={...row,last_checked_at:checkedAt},snapshot=structuredClone(stale);
    const status=nativeRoutingStatus(stale,now);
    assert.equal(status.state,"PENDING");assert.equal(status.safeRetry,false);
    assert.equal(status.desiredRevision,7);assert.equal(status.appliedRevision,7);
    assert.equal(status.observedSha256,row.observed_sha256);
    assert.deepEqual(stale,snapshot);
  }
  assert.equal(nativeRoutingStatus({...row,last_checked_at:new Date(now+30_000)},now).state,"SYNCED");
  for(const state of ["OUTCOME_UNKNOWN","DRIFT","APPLYING","FAILED","PENDING"]){
    assert.equal(nativeRoutingStatus({...row,sync_state:state,last_checked_at:null},now).state,state);
  }
  assert.deepEqual(row,before);
});
function fixture({checkedAt=new Date().toISOString(),tenantId=tenant}={}){
  // APPLY lifecycle cases start after a valid NOT_APPLIED readback.
  const row={tenant_id:tenantId,zammad_instance_id:instance,desired_revision:1,applied_revision:0,desired_manifest:null,desired_sha256:null,observed_sha256:null,
    department_defaults:[],sync_state:"PENDING",next_action:"APPLY",attempted_request:null,error_code:null,safe_retry:true,claim_id:null,claim_expires_at:null,last_checked_at:checkedAt};
  let transactions=0;const queries=[],requests=[];let tenantActive=true,linkedInstance=instance;
  const queue=()=>{row.desired_revision++;row.desired_manifest=null;row.desired_sha256=null;
    const unknown=["APPLYING","OUTCOME_UNKNOWN"].includes(row.sync_state);row.sync_state=unknown?"OUTCOME_UNKNOWN":row.sync_state==="DRIFT"?"DRIFT":"PENDING";row.safe_retry=!unknown&&row.sync_state!=="DRIFT";row.next_action=unknown?"CHECK":row.sync_state==="DRIFT"?null:"APPLY";};
  const client={query:async(sql,values=[])=>{
    queries.push({sql,values:structuredClone(values)});
    if(sql.includes("FROM native_routing_projections"))return{rows:[structuredClone(row)]};
    if(sql.includes("lock_current_active_tenant"))return{rows:[{active:tenantActive}]};
    if(sql.includes("FROM zammad_instances"))return{rows:[{id:linkedInstance,base_url:"https://native.example.test",service_secret_reference:"synthetic",state:"WORKING"}]};
    if(sql.includes("queue_native_routing")){queue();return{rows:[]};}
    if(sql.startsWith("UPDATE native_routing_projections")){
      if(sql.includes("SET department_defaults=$2"))assert.equal(typeof values[1],"string","JSONB policies must not become a PostgreSQL array");
      for(const column of Object.keys(row)){
        const parameter=sql.match(new RegExp(`\\b${column}=\\$(\\d+)`));if(parameter)row[column]=structuredClone(values[Number(parameter[1])-1]);
        const literal=sql.match(new RegExp(`\\b${column}='([^']*)'`));if(literal)row[column]=literal[1];
        if(new RegExp(`\\b${column}=NULL`).test(sql))row[column]=null;
        if(new RegExp(`\\b${column}=false`).test(sql))row[column]=false;
        if(new RegExp(`\\b${column}=true`).test(sql))row[column]=true;
      }
      if(sql.includes("SET department_defaults=$2"))row.department_defaults=JSON.parse(row.department_defaults);
      if(sql.includes("claim_expires_at=now()+"))row.claim_expires_at=new Date(Date.now()+30_000).toISOString();
      if(sql.includes("last_checked_at=now()"))row.last_checked_at=new Date().toISOString();
      return{rows:[],rowCount:1};
    }
    return{rows:[],rowCount:0};
  }};
  const database={withTenant:async(id,operation)=>{assert.equal(id,tenantId);transactions++;try{return await operation(client);}finally{transactions--;}},pendingNativeRoutingTenants:async()=>[tenantId]};
  let credentialsHook=()=>{};
  const service=new NativeRoutingSyncService(database,{resolveCredentials:async()=>{assert.equal(transactions,0,"credential HTTP must be outside the source transaction");await credentialsHook();return{apiToken:"synthetic-token",jwtSecret:"synthetic-secret"};}});
  const install=handler=>async(url,options)=>{
    assert.equal(transactions,0,"native RPC must be outside every source transaction");assert.equal(String(url),"https://native.example.test/api/v1/wasalx/routing/configuration");
    assert.equal(options.headers["x-wasalx-signature"],createHmac("sha256","synthetic-secret").update(`${options.headers["x-wasalx-timestamp"]}\n${options.body}`).digest("hex"));
    const request=JSON.parse(options.body);requests.push(request);
    if(request.action==="APPLY"){assert.equal(row.sync_state,"APPLYING");assert.deepEqual(row.attempted_request,request);assert.equal(row.safe_retry,false);}
    return Response.json(await handler(request));
  };
  const success=request=>({schema_version:1,tenant_id:tenantId,instance_id:instance,revision:request.revision,desired_sha256:request.desired_sha256,applied_revision:request.revision,observed_sha256:request.desired_sha256,state:"SYNCED",items:[]});
  return{row,service,database,client,requests,queries,queue,install,success,setCredentialsHook:hook=>{credentialsHook=hook;},setTenantActive:value=>{tenantActive=value;},setInstance:value=>{linkedInstance=value;}};
}
async function usingFetch(implementation,operation){const original=globalThis.fetch;globalThis.fetch=implementation;try{return await operation();}finally{globalThis.fetch=original;}}

test("routing discovery, scheduled tenant and immediate wake failures are redacted and recoverable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T10:00:00Z") });
  const secondTenant = "10000000-0000-4000-8000-000000000002";
  const a = fixture();
  const b = fixture({ tenantId: secondTenant });
  const failure = new Error(`Synthetic failure for ${tenant}`);
  const visited = [];
  const logs = [];
  let discover = false;
  let rejectClaim = true;
  t.mock.method(a.database, "pendingNativeRoutingTenants", async () => {
    if (!discover) throw failure;
    return [tenant, secondTenant];
  });
  const withFirst = a.database.withTenant;
  t.mock.method(a.database, "withTenant", (id, operation) => {
    visited.push(id);
    if (id === secondTenant) return b.database.withTenant(id, operation);
    if (rejectClaim) return Promise.reject(failure);
    return withFirst(id, operation);
  });
  const fetchFirst = a.install(a.success);
  const fetchSecond = b.install(b.success);
  t.mock.method(globalThis, "fetch", (url, options) =>
    (JSON.parse(options.body).tenant_id === tenant ? fetchFirst : fetchSecond)(url, options));
  t.mock.method(process.stderr, "write", (line) => { logs.push(JSON.parse(String(line))); return true; });

  await a.service.drain();
  assert.deepEqual(visited, []);
  discover = true;
  await a.service.drain();
  assert.deepEqual([...new Set(visited)], [tenant, secondTenant]);
  assert.equal(a.row.sync_state, "PENDING");
  assert.equal(a.row.claim_id, null);
  assert.equal(b.row.sync_state, "SYNCED");
  assert.equal(a.requests.length, 0);
  assert.equal(b.requests.length, 1);
  assert.equal(a.service.wake(tenant), undefined);
  await new Promise(setImmediate);
  rejectClaim = false;
  await a.service.drain();
  assert.equal(a.row.sync_state, "SYNCED");
  assert.equal(a.requests.length, 1);
  assert.equal(b.requests.length, 1);
  assert.deepEqual(logs, ["discovery", "tenant", "wake"].map((phase) => ({
    timestamp: new Date().toISOString(), level: "error", event: "native_projection.failed", projection: "routing", phase,
  })));
});

test("department policy lists cross the PostgreSQL boundary as JSON arrays",async()=>{
  for(const departmentDefaults of [[],[{id:policy,zammadGroupId:"5",zammadOwnerId:"7",enabled:true}]]){
    const f=fixture();await f.service.command(f.client,tenant,{action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults});
    assert.equal(f.queries.find(query=>query.sql.includes("SET department_defaults=$2")).values[1],JSON.stringify(departmentDefaults));
    assert.deepEqual(f.row.department_defaults,departmentDefaults);
  }
});

test("new or seeded routing first CHECKs native support even after an initial save or reconcile",async()=>{
  for(const checkedAt of [null,"invalid"]){
    for(const command of [null,"SAVE_DEFAULTS","RECONCILE"]){
      const f=fixture({checkedAt});f.row.next_action="CHECK";
      if(command)await f.service.command(f.client,tenant,command==="SAVE_DEFAULTS"?{action:command,expectedRevision:1,departmentDefaults:[]}:{action:command,expectedRevision:1});
      await usingFetch(f.install(request=>{
        assert.equal(request.action,"CHECK");assert.equal(f.row.attempted_request,null);
        return{...f.success(request),state:"CONFLICT",applied_revision:0,observed_sha256:null,items:[{key:"configuration",kind:"CONFIGURATION",native_id:null,state:"UNAPPLIED",error_code:"NOT_APPLIED"}]};
      }),()=>f.service.syncTenant(tenant));
      assert.equal(f.row.sync_state,"PENDING");assert.equal(f.row.next_action,"APPLY");assert.ok(Number.isFinite(new Date(f.row.last_checked_at).getTime()));
      await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));
      assert.deepEqual(f.requests.map(request=>request.action),["CHECK","APPLY"]);assert.equal(f.row.sync_state,"SYNCED");
    }
  }
});

test("unsupported or unavailable initial CHECK is held without an APPLY attempt and later saves still CHECK",async()=>{
  for(const outcome of [404,403,"timeout","malformed"]){
    const f=fixture({checkedAt:null});
    const unavailable=f.install(request=>{
      assert.equal(request.action,"CHECK");assert.equal(f.row.attempted_request,null);
      if(outcome==="timeout")throw new DOMException("Timed out","TimeoutError");
      return outcome==="malformed"?{unsupported:true}:f.success(request);
    });
    const implementation=typeof outcome==="number"?async(url,options)=>{await unavailable(url,options);return new Response(null,{status:outcome});}:unavailable;
    await usingFetch(implementation,()=>f.service.syncTenant(tenant));
    assert.equal(f.row.sync_state,"FAILED");assert.equal(f.row.next_action,null);assert.equal(f.row.attempted_request,null);assert.equal(f.row.safe_retry,false);assert.equal(f.row.last_checked_at,null);
    await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));assert.equal(f.requests.length,1,"Failed initial checks never auto-retry");
    await f.service.command(f.client,tenant,{action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults:[]});
    await usingFetch(implementation,()=>f.service.syncTenant(tenant));
    assert.deepEqual(f.requests.map(request=>request.action),["CHECK","CHECK"]);assert.equal(f.row.sync_state,"FAILED");assert.equal(f.row.attempted_request,null);
  }
});

test("native routing persists the exact before-effect fence and requires actual current receipt",async()=>{
  const f=fixture();await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));
  assert.equal(f.row.sync_state,"SYNCED");assert.equal(f.row.desired_sha256,digest(empty()));assert.equal(f.row.observed_sha256,f.row.desired_sha256);assert.equal(f.row.applied_revision,1);assert.ok(f.row.last_checked_at);assert.equal(f.row.attempted_request,null);assert.equal(f.requests.length,1);
  await f.service.status(tenant);assert.equal(f.requests.length,1,"GET does not poll native");
});

test("a queued CHECK replaces a stale failure until the verified readback settles",async t=>{
  const now=Date.parse("2026-10-16T10:00:00Z");
  t.mock.timers.enable({apis:["Date"],now});
  const f=fixture({checkedAt:null});
  await usingFetch(f.install(()=>{throw new Error("native unavailable");}),()=>f.service.syncTenant(tenant));
  const failed=await f.service.status(tenant);
  assert.equal(failed.state,"FAILED");
  assert.equal(failed.errorCode,"NATIVE_ROUTING_CONFIGURATION_UNAVAILABLE");

  const queued=await f.service.command(f.client,tenant,{action:"CHECK",expectedRevision:1});
  assert.equal(queued.state,"PENDING");
  assert.equal(queued.errorCode,null);
  assert.equal(queued.safeRetry,false);
  assert.deepEqual(await f.service.status(tenant),queued);

  await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));
  const verified=await f.service.status(tenant);
  assert.deepEqual(f.requests.map(request=>request.action),["CHECK","CHECK"]);
  assert.equal(verified.state,"SYNCED");
  assert.equal(verified.errorCode,null);
  assert.equal(verified.lastCheckedAt,new Date(now).toISOString());
});

test("lost APPLY response followed by newer desired state CHECKs the original immutable attempt first",async()=>{
  const f=fixture();await usingFetch(f.install(()=>{throw new Error("response lost");}),()=>f.service.syncTenant(tenant));
  const attempted=structuredClone(f.row.attempted_request);assert.equal(f.row.sync_state,"OUTCOME_UNKNOWN");
  f.row.last_checked_at=null;
  f.queue();assert.equal(f.row.desired_revision,2);assert.deepEqual(f.row.attempted_request,attempted);
  await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));
  assert.deepEqual(f.requests[1],{...attempted,action:"CHECK"});assert.equal(f.row.sync_state,"PENDING");assert.equal(f.row.applied_revision,1);assert.equal(f.row.attempted_request,null);
  await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));
  assert.equal(f.requests[2].action,"APPLY");assert.equal(f.requests[2].revision,2);assert.equal(f.requests[2].expected_native_revision,1);assert.equal(f.row.sync_state,"SYNCED");
});

test("an unresolvable CHECK remains held and never replays the unknown APPLY",async()=>{
  const f=fixture();await usingFetch(f.install(()=>{throw new Error("lost");}),()=>f.service.syncTenant(tenant));
  await usingFetch(f.install(()=>{throw new Error("still unavailable");}),()=>f.service.syncTenant(tenant));
  assert.deepEqual(f.requests.map(row=>row.action),["APPLY","CHECK"]);assert.equal(f.row.next_action,null);assert.equal(f.row.safe_retry,false);
  await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));assert.equal(f.requests.length,2);
  await assert.rejects(()=>f.service.command(f.client,tenant,{action:"RECONCILE",expectedRevision:1}),/Check the native outcome/u);
});

test("unknown SAVE_DEFAULTS preserves attempted manifest and instance while changing latest intent",async()=>{
  const f=fixture();await usingFetch(f.install(()=>{throw new Error("lost");}),()=>f.service.syncTenant(tenant));const attempt=structuredClone(f.row.attempted_request);
  await f.service.command(f.client,tenant,{action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults:[{id:policy,zammadGroupId:"5",zammadOwnerId:"7",enabled:true}]});
  assert.equal(f.row.sync_state,"OUTCOME_UNKNOWN");assert.deepEqual(f.row.attempted_request,attempt);assert.equal(f.row.desired_revision,2);assert.equal(f.row.next_action,"CHECK");
});

test("foreign/stale/fake readback cannot mark current routing synced",async()=>{
  for(const change of [{instance_id:"foreign"},{tenant_id:"foreign"},{revision:2},{applied_revision:0},{observed_sha256:"a".repeat(64)},{items:[{key:"x",kind:"CONFIGURATION",native_id:null,state:"DRIFT"}]}]){
    const f=fixture();await usingFetch(f.install(request=>({...f.success(request),...change})),()=>f.service.syncTenant(tenant));assert.equal(f.row.sync_state,"OUTCOME_UNKNOWN");assert.equal(f.row.applied_revision,0);
  }
});

test("native drift is held and generic reconcile cannot overwrite it",async()=>{
  const f=fixture();await usingFetch(f.install(request=>({...f.success(request),state:"DRIFT",applied_revision:0,observed_sha256:"a".repeat(64),items:[{key:"configuration",kind:"CONFIGURATION",native_id:null,state:"DRIFT",error_code:"TRIGGER_MODIFIED"}]})),()=>f.service.syncTenant(tenant));
  assert.equal(f.row.sync_state,"DRIFT");assert.equal(f.row.next_action,null);assert.equal(f.row.safe_retry,false);
  await assert.rejects(()=>f.service.command(f.client,tenant,{action:"RECONCILE",expectedRevision:1}),/Check the native outcome/u);
  await f.service.command(f.client,tenant,{action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults:[]});assert.equal(f.row.sync_state,"DRIFT");assert.equal(f.row.next_action,"CHECK");
});

test("known-unapplied CHECK permits one CAS apply, while native drift never does",async()=>{
  const f=fixture();f.row.next_action="CHECK";
  await usingFetch(f.install(request=>({...f.success(request),state:"CONFLICT",applied_revision:0,observed_sha256:null,items:[{key:"configuration",kind:"CONFIGURATION",native_id:null,state:"UNAPPLIED",error_code:"NOT_APPLIED"}]})),()=>f.service.syncTenant(tenant));
  assert.equal(f.row.sync_state,"PENDING");assert.equal(f.row.safe_retry,true);assert.equal(f.row.applied_revision,0);
  await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));assert.deepEqual(f.requests.map(row=>row.action),["CHECK","APPLY"]);
});

test("supersession before APPLY fence sends nothing; foreign or inactive native ownership sends nothing",async()=>{
  const f=fixture();f.setCredentialsHook(f.queue);await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));assert.equal(f.requests.length,0);assert.equal(f.row.desired_revision,2);assert.equal(f.row.next_action,"APPLY");
  for(const change of [f=>f.setInstance("foreign"),f=>f.setTenantActive(false)]){const current=fixture();change(current);await usingFetch(current.install(current.success),()=>current.service.syncTenant(tenant));assert.equal(current.requests.length,0);assert.equal(current.row.safe_retry,false);}
});

test("expired pre-dispatch claims retain durable APPLY intent and settled rows check native drift on a bounded interval",async()=>{
  const f=fixture();await f.service.prepare(tenant);assert.equal(f.row.next_action,"APPLY");assert.equal(f.row.attempted_request,null);
  f.row.claim_expires_at=new Date(Date.now()-1).toISOString();await usingFetch(f.install(f.success),()=>f.service.syncTenant(tenant));assert.equal(f.row.sync_state,"SYNCED");
  f.row.last_checked_at=new Date(Date.now()-301_000).toISOString();
  await usingFetch(f.install(request=>({...f.success(request),state:"DRIFT",observed_sha256:"e".repeat(64),items:[{key:"configuration",kind:"CONFIGURATION",native_id:null,state:"DRIFT",error_code:"TRIGGER_MODIFIED"}]})),()=>f.service.syncTenant(tenant));
  assert.deepEqual(f.requests.map(request=>request.action),["APPLY","CHECK"]);assert.equal(f.row.sync_state,"DRIFT");assert.equal(f.row.safe_retry,false);
});

test("manifest contains only stable routing IDs and hashes, never private client matchers",async()=>{
  const binding="30000000-0000-4000-8000-000000000003",version="40000000-0000-4000-8000-000000000004";
  const queries=[];const client={query:async(sql,values)=>{assert.equal(values[0],tenant);queries.push(sql);
    if(sql.includes("FROM group_bindings"))return{rows:[{id:binding,revision:2,zammad_group_id:"5",assignment_mode:"fixed_owner",fixed_owner_id:"7"}]};
    if(sql.includes("FROM bot_assignments"))return{rows:[]};
    return{rows:[{id:version,snapshot_sha256:"b".repeat(64),definition:{schemaVersion:1,name:"private name",supportGroupIds:["5"],fallback:{zammadGroupId:"5",ownerId:"7"},sources:[{id:"manual",name:"Private",kind:"MANUAL",syncMode:"MANUAL",fieldMapping:{}}],clients:[{id:"client-a",name:"Private client",routeSourceId:"manual",zammadGroupId:"5",matchers:[{kind:"EMAIL",value:"private@example.test",sourceId:"manual"}]}]}}]};}};
  const manifest=await buildNativeRoutingManifest(client,tenant,[{id:policy,zammadGroupId:"99",zammadOwnerId:"88",enabled:false}]);
  assert.deepEqual(manifest.group_references,[{group_id:"5",owner_ids:["7"]}]);assert.deepEqual(manifest.client_routing,{version_id:version,snapshot_sha256:"b".repeat(64),support_group_ids:["5"]});assert.doesNotMatch(JSON.stringify(manifest),/private|Private|example\.test/u);
  assert.ok(queries.every(sql=>sql.includes("tenant_id=$1")));
});

test("native response schema rejects unsafe revisions and raw arbitrary error text",()=>{
  const request={schema_version:1,action:"CHECK",tenant_id:tenant,instance_id:instance,revision:1,desired_sha256:digest(empty()),expected_native_revision:0,manifest:empty()};
  const f=fixture();assert.throws(()=>validateNativeRoutingResponse({...f.success(request),applied_revision:Number.MAX_SAFE_INTEGER+1},request));
  assert.throws(()=>validateNativeRoutingResponse({...f.success(request),items:[{key:"config",kind:"CONFIGURATION",native_id:null,state:"SYNCED",error_code:"database secret internals"}]},request));
});

test("new explicit FIXED owners are freshly validated before activation and assignment outside save transactions",async()=>{
  const version="30000000-0000-4000-8000-000000000003",family="40000000-0000-4000-8000-000000000004",connection="50000000-0000-4000-8000-000000000005";
  const principal={tenantId:tenant,userId:policy,role:"tenant_owner"};
  for(const valid of [true,false]){
    let inside=false,activations=0,assignments=0,catalogCalls=0;
    const definition={schemaVersion:1,name:"Finance",start:"agent",maxSteps:2,nodes:[{id:"agent",type:"handoff",target:"FIXED",zammadGroupId:"5",zammadOwnerId:"7",priority:"2 normal"}]};
    const client={query:async(sql)=>{
      if(sql.startsWith("SELECT id FROM bot_flow_versions"))return{rows:[{id:version}]};
      if(sql.includes("SELECT definition,family_id"))return{rows:[{definition,family_id:family,snapshot_sha256:"a".repeat(64),supersedes_flow_version_id:null}]};
      if(sql.includes("FROM connections connection"))return{rows:[{provider:"WAHA",state:"WORKING",definition,flow_version_id:version}]};
      if(sql.includes("app.activate_bot_flow_version")){activations++;return{rows:[{active_flow_version_id:version,retired_flow_version_id:null,revision:2,assignments_migrated:0}]};}
      if(sql.includes("app.assign_bot_flow")){assignments++;return{rows:[{assignment_id:policy,flow_version_id:version,revision:1}]};}
      if(sql.startsWith("UPDATE bot_assignments"))return{rows:[{agent_prefix:"Agent:",agent_identity_placement:"HEADER"}]};
      return{rows:[],rowCount:1};
    }};
    const database={withTenant:async(_tenant,action)=>{inside=true;try{return await action(client);}finally{inside=false;}}};
    const catalogs={get:async(id,refresh)=>{assert.equal(id,tenant);assert.equal(refresh,true);assert.equal(inside,false);catalogCalls++;return{groups:[{id:"5",active:true,serviceIdentityCanCreate:true}],owners:[{id:"7",active:valid,groupIds:["5"]}]};}};
    const service=new BotFlowsService(database,undefined,catalogs);
    const activate=()=>service.activate(principal,version,"activate","request",{expectedRevision:1,expectedActiveFlowVersionId:null});
    const assign=()=>service.assign(principal,"assign","request",{connectionId:connection,familyId:family,zammadGroupId:"5"});
    if(valid){await activate();await assign();assert.equal(activations,1);assert.equal(assignments,1);}else{await assert.rejects(activate,error=>error.getResponse().code==="NATIVE_ROUTING_VALIDATION_ERROR");await assert.rejects(assign,error=>error.getResponse().code==="NATIVE_ROUTING_VALIDATION_ERROR");assert.equal(activations+assignments,0);}
    assert.equal(catalogCalls,2);
  }
});

test("default policy saves require recent MFA, while disabling unavailable targets makes no catalog RPC",async()=>{
  const f=fixture();let catalogCalls=0;
  const request={id:"native-policy",principal:{tenantId:tenant,userId:policy,role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}};
  const client={query:async(sql,values)=>{if(sql.includes("privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};return f.client.query(sql,values);}};
  const database={withTenant:async(_tenant,action)=>action(client)};
  const sync={...f.service,command:f.service.command.bind(f.service),wake:()=>{}};
  const controller=new NativeRoutingSyncController(database,sync,{get:async()=>{catalogCalls++;throw new Error("Disabled policy must not fetch native");}});
  const body={action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults:[{id:policy,zammadGroupId:"99",zammadOwnerId:"88",enabled:false}]};
  const result=await controller.command(request,"disable-policy",body);assert.equal(result.desiredRevision,2);assert.equal(catalogCalls,0);
  await assert.rejects(()=>controller.command({...request,principal:{...request.principal,authenticationMethods:[]}},"second-policy",{...body,expectedRevision:2}),error=>error.status===403);assert.equal(f.row.desired_revision,2);
});

test("committed activation, assignment and resume replays return receipts before current state or unavailable catalogs",async()=>{
  const version="30000000-0000-4000-8000-000000000003",family="40000000-0000-4000-8000-000000000004",connection="50000000-0000-4000-8000-000000000005";
  const principal={tenantId:tenant,userId:policy,role:"tenant_owner"};
  const activation={expectedRevision:1,expectedActiveFlowVersionId:null};
  const assignment={connectionId:connection,familyId:family,zammadGroupId:"5"};
  const resume={state:"ACTIVE",expectedRevision:4};
  const sha=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for(const scenario of [
    {action:"ACTIVATE",hash:sha({action:"ACTIVATE",flowVersionId:version,input:activation}),run:service=>service.activate(principal,version,"saved","request",activation)},
    {action:"ASSIGN",hash:sha({action:"ASSIGN",attributionPolicy:"PRESERVE_OMITTED",input:assignment}),run:service=>service.assign(principal,"saved","request",assignment)},
    {action:"ASSIGN",hash:sha({action:"ASSIGN",input:{...assignment,agentPrefix:"Agent:",agentIdentityPlacement:"HEADER"}}),run:service=>service.assign(principal,"saved","request",assignment)},
    {action:"ASSIGNMENT_STATE",hash:sha({assignmentId:policy,...resume}),run:service=>service.setAssignmentState(principal,policy,"saved","request",resume)},
  ]){
    const calls=[];const saved={assignmentId:policy,revision:7,flowVersionId:version};
    const database={withTenant:async(id,operation)=>{assert.equal(id,tenant);return operation({query:async(sql,values)=>{
      calls.push(sql);if(sql.includes("pg_advisory_xact_lock")){assert.deepEqual(values,[`bot-flow:${tenant}:saved`]);return{rows:[]};}
      assert.match(sql,/FROM bot_flow_operations/u);assert.deepEqual(values,[tenant,"saved"]);
      return{rows:[{action:scenario.action,request_sha256:scenario.hash,result:saved}]};
    }});}};
    const service=new BotFlowsService(database,undefined,{get:async()=>assert.fail("A replay must not fetch the unavailable native catalog")});
    assert.deepEqual(await scenario.run(service),{...saved,duplicate:true});assert.equal(calls.length,2,"A replay has no flow, owner, assignment or configuration reads/mutations");
  }
});

test("SAVE_DEFAULTS replay bypasses unavailable catalog, current revision and recent-auth preflight",async()=>{
  const command={action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults:[{id:policy,zammadGroupId:"5",zammadOwnerId:"7",enabled:true}]};
  const hash=createHash("sha256").update(JSON.stringify({nativeRouting:command})).digest("hex");
  const saved={state:"PENDING",desiredRevision:2,appliedRevision:1,departmentDefaults:command.departmentDefaults};
  const request={id:"replay",principal:{tenantId:tenant,userId:policy,role:"tenant_owner",authenticatedAt:0,authenticationMethods:[]}};
  const calls=[];const database={withTenant:async(id,action)=>{assert.equal(id,tenant);return action({query:async(sql,values)=>{
    calls.push(sql);if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};assert.match(sql,/FROM bot_flow_operations/u);assert.deepEqual(values,[tenant,"saved"]);
    return{rows:[{action:"ROUTING_SYNC",request_sha256:hash,result:saved}]};
  }});}};
  const controller=new NativeRoutingSyncController(database,{command:async()=>assert.fail("No repeated save"),wake:()=>assert.fail("No new native attempt")},{get:async()=>assert.fail("No unavailable catalog preflight on replay")});
  assert.deepEqual(await controller.command(request,"saved",command),{...saved,duplicate:true});assert.equal(calls.length,2);
});

test("receipt prechecks reject wrong action and changed payload without current-state reads",async()=>{
  const version="30000000-0000-4000-8000-000000000003",principal={tenantId:tenant,userId:policy,role:"tenant_owner"};
  for(const receipt of [{action:"ASSIGN",request_sha256:"a".repeat(64)},{action:"ACTIVATE",request_sha256:"b".repeat(64)}]){
    const database={withTenant:async(id,action)=>{assert.equal(id,tenant);return action({query:async(sql,values)=>{
      if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};assert.match(sql,/FROM bot_flow_operations/u);assert.deepEqual(values,[tenant,"conflicting"]);return{rows:[{...receipt,result:{}}]};
    }});}};
    const service=new BotFlowsService(database,undefined,{get:async()=>assert.fail("Conflicting receipt must not reach native")});
    await assert.rejects(()=>service.activate(principal,version,"conflicting","request",{expectedRevision:1,expectedActiveFlowVersionId:null}),error=>error.status===409);
  }
});

test("a receipt committed during fresh catalog preflight is rechecked before the configuration save",async()=>{
  const command={action:"SAVE_DEFAULTS",expectedRevision:1,departmentDefaults:[{id:policy,zammadGroupId:"5",zammadOwnerId:"7",enabled:true}]};
  const requestSha=createHash("sha256").update(JSON.stringify({nativeRouting:command})).digest("hex"),saved={state:"PENDING",desiredRevision:2};
  let exists=false,reads=0,inside=false;
  const database={withTenant:async(id,operation)=>{assert.equal(id,tenant);inside=true;try{return await operation({query:async(sql)=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[]};assert.match(sql,/FROM bot_flow_operations/u);reads++;return{rows:exists?[{action:"ROUTING_SYNC",request_sha256:requestSha,result:saved}]:[]};
  }});}finally{inside=false;}}};
  const controller=new NativeRoutingSyncController(database,{command:async()=>assert.fail("Concurrent replay must not save again"),wake:()=>{}},{get:async()=>{
    assert.equal(inside,false);exists=true;return{groups:[{id:"5",active:true,serviceIdentityCanCreate:true}],owners:[{id:"7",active:true,groupIds:["5"]}]};
  }});
  assert.deepEqual(await controller.command({id:"race",principal:{tenantId:tenant,userId:policy,role:"tenant_owner"}},"saved-concurrently",command),{...saved,duplicate:true});assert.equal(reads,2);
});
