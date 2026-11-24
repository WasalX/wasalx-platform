import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { NativeMembershipObserver } from "../services/control-api/dist/native-membership-observer.js";
import { NativeMembershipService } from "../services/control-api/dist/native-membership.service.js";
import { NativeMembershipController } from "../services/control-api/dist/native-membership.controller.js";
import { TenantAdministrationController } from "../services/control-api/dist/tenant-administration.controller.js";
const tenant="10000000-0000-4000-8000-000000000001",instance="11000000-0000-4000-8000-000000000001",user="30000000-0000-4000-8000-000000000003";
const snapshot=(index=0)=>({tenant_id:tenant,user_id:index?`30000000-0000-4000-8000-${String(index).padStart(12,"0")}`:user,oidc_subject:`staff-${index}`,email:`staff-${index}@example.invalid`,display_name:"Synthetic staff",source_display_name:"Synthetic staff",role:"agent",member_state:"ACTIVE",revision:"4",native_user_id:String(index+12),requested_native_user_id:null,applied_revision:"4",sync_state:"READY",zammad_instance_id:instance,current_instance_id:instance,base_url:"https://native.example.test",service_secret_reference:`secret://tenants/${tenant}/zammad/service`,source_identity_current:true});
const ready=row=>({state:"READY",revision:Number(row.revision),native_user_id:row.native_user_id});
const readRows=rows=>async(id,ids)=>{assert.equal(id,tenant);return structuredClone(rows.filter(row=>!ids||ids.includes(row.user_id)));};

test("exact native DISCOVER observation is shared by Team and Workspace Access without source/native writes",async(t)=>{
  const row=snapshot(),original=structuredClone(row),queries=[];let inside=false,calls=0;
  const database={rows:async(id,sql,values)=>{
    assert.equal(id,tenant);inside=true;queries.push(sql);
    assert.match(sql,/^(?:SELECT|WITH \w+ AS \(\s*SELECT)\b/u);
    assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/u);
    try{
      if(sql.includes("FROM tenant_settings"))return[{native_membership_sync_enabled:true}];
      if(sql.includes("FROM tenant_memberships m"))return[{id:"membership",user_id:user,email:row.email,display_name:row.display_name,role:"agent",state:"ACTIVE",version:17}];
      if(sql.includes("FROM tenant_invitations"))return[];
      if(sql.includes("FROM native_membership_projections p")){assert.match(sql,/m\.role=p\.role AND m\.state=p\.member_state/u);assert.match(sql,/u\.oidc_subject=p\.oidc_subject AND u\.email=p\.email/u);assert.deepEqual(values[0],tenant);return[structuredClone(row)];}
      if(sql.includes("FROM native_membership_projections"))return[{user_id:user,native_user_id:"12",revision:"4",applied_revision:"4",sync_state:"READY",member_state:"ACTIVE"}];
      assert.fail("Unexpected read");
    }finally{inside=false;}
  }};
  const service=new NativeMembershipService(database,{resolveCredentials:async(reference,owner)=>{assert.equal(inside,false);assert.equal(reference,row.service_secret_reference);assert.deepEqual(owner,{tenantId:tenant,instanceId:instance});return{jwtSecret:"synthetic-observation-secret",apiToken:"synthetic-token"};}});
  t.mock.method(globalThis,"fetch",async(url,init)=>{
    assert.equal(inside,false);calls++;assert.equal(String(url),"https://native.example.test/api/v1/wasalx/membership");
    const body=JSON.parse(init.body);assert.equal(body.action,"DISCOVER");assert.equal(body.native_user_id,"12");assert.equal(body.revision,4);assert.equal(body.tenant_id,tenant);assert.equal(body.instance_id,instance);
    assert.equal(init.headers["x-wasalx-signature"],createHmac("sha256","synthetic-observation-secret").update(`${init.headers["x-wasalx-timestamp"]}\n${init.body}`).digest("hex"));
    return Response.json(ready(row));
  });
  const request={principal:{tenantId:tenant,userId:user,role:"tenant_owner"}};
  const workspace=await new NativeMembershipController(database,service).status(request);
  const team=await new TenantAdministrationController(database,{}, {},service).team(request);
  assert.equal(workspace.members[0].nativeObservation.state,"VERIFIED");assert.deepEqual(team.members[0].nativeObservation,workspace.members[0].nativeObservation);
  assert.equal(team.members[0].version,17);assert.equal(team.members[0].nativeObservation.revision,4);assert.equal(calls,1);assert.deepEqual(row,original);assert.ok(queries.every(sql=>!/^UPDATE|INSERT|DELETE/u.test(sql)));
});

test("native role/access CONFLICT is generic drift while source READY is retained",async()=>{
  const rows=[snapshot()];const original=structuredClone(rows);const observer=new NativeMembershipObserver(readRows(rows),async()=>({state:"CONFLICT"}));
  const value=(await observer.observe(tenant)).get(user);assert.equal(value.state,"DRIFT");assert.ok(value.checkedAt);assert.deepEqual(rows,original);assert.equal("active" in value,false);
});

test("Team observations cannot qualify the older member identity returned before a concurrent lifecycle change",async(t)=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({state:"READY",revision:5,native_user_id:"12"});});
  for(const patch of [{member_state:"SUSPENDED",revision:"5",applied_revision:"5"},{role:"tenant_admin",revision:"5",applied_revision:"5"},{email:"new@example.invalid",revision:"5",applied_revision:"5"},{source_display_name:"Renamed staff"}]){
    const row=snapshot(),before=structuredClone(row);
    const database={rows:async(_tenant,sql)=>{
      if(sql.includes("FROM tenant_memberships m")){Object.assign(row,patch);return[{id:"membership",user_id:user,email:before.email,display_name:before.display_name,role:"agent",state:"ACTIVE",version:17}];}
      if(sql.includes("FROM tenant_invitations"))return[];
      if(sql.includes("FROM native_membership_projections p"))return[structuredClone(row)];
      assert.fail("Unexpected read");
    }};
    const service=new NativeMembershipService(database,{resolveCredentials:async()=>({jwtSecret:"synthetic",apiToken:"synthetic"})});
    const result=await new TenantAdministrationController(database,{}, {},service).team({principal:{tenantId:tenant,userId:user,role:"tenant_owner"}});
    assert.equal(result.members[0].state,"ACTIVE");assert.equal(result.members[0].role,"agent");assert.equal(result.members[0].nativeObservation.state,"UNVERIFIED");assert.deepEqual(row,{...before,...patch});
  }
  assert.equal(calls,0,"A mismatched captured Team identity cannot borrow a newer verified observation");
});

test("Workspace observations stay bound to the returned projection revision, native ID and state",async(t)=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({state:"READY",revision:5,native_user_id:"13"});});
  for(const patch of [{revision:"5",applied_revision:"5"},{native_user_id:"13"},{sync_state:"PENDING"},{member_state:"SUSPENDED"},{applied_revision:"3"}]){
    const row=snapshot(),before=structuredClone(row);
    const database={rows:async(_tenant,sql)=>{
      if(sql.includes("FROM tenant_settings"))return[{native_membership_sync_enabled:true}];
      if(sql.includes("FROM native_membership_projections p"))return[structuredClone(row)];
      if(sql.includes("FROM native_membership_projections")){Object.assign(row,patch);return[{user_id:user,native_user_id:before.native_user_id,revision:before.revision,applied_revision:before.applied_revision,sync_state:before.sync_state,member_state:before.member_state}];}
      assert.fail("Unexpected read");
    }};
    const service=new NativeMembershipService(database,{resolveCredentials:async()=>({jwtSecret:"synthetic",apiToken:"synthetic"})});
    const result=await new NativeMembershipController(database,service).status({principal:{tenantId:tenant}});
    assert.equal(result.members[0].revision,"4");assert.equal(result.members[0].native_user_id,"12");assert.equal(result.members[0].nativeObservation.state,"UNVERIFIED");assert.deepEqual(row,{...before,...patch});
  }
  assert.equal(calls,0,"A newer projection must not qualify the older response row");
});

test("partial, foreign, unbound, protected and unavailable observations never become green",async()=>{
  for(const response of [{state:"READY"},{state:"READY",revision:4,native_user_id:"99"},{state:"READY",revision:"4",native_user_id:"12"},{state:"READY",revision:3,native_user_id:"12"},{state:"PROTECTED"},{state:"ADOPTION_REQUIRED"},{state:"CONFLICT",revision:3,native_user_id:"12"}]){
    const rows=[snapshot()],observer=new NativeMembershipObserver(readRows(rows),async()=>response);
    assert.equal((await observer.observe(tenant)).get(user).state,"UNVERIFIED");assert.equal(rows[0].sync_state,"READY");
  }
  const rows=[snapshot()],outage=new NativeMembershipObserver(readRows(rows),async()=>{throw Error("native unavailable");});assert.equal((await outage.observe(tenant)).get(user).state,"UNAVAILABLE");assert.equal(rows[0].sync_state,"READY");
  for(const patch of [{sync_state:"PENDING"},{sync_state:"PROTECTED"},{applied_revision:"3"},{native_user_id:null},{zammad_instance_id:null},{current_instance_id:"foreign"},{source_identity_current:false}]){
    const unbound=[{...snapshot(),...patch}],observer=new NativeMembershipObserver(readRows(unbound),async()=>assert.fail("Unbound/stale source must not dispatch"));assert.equal((await observer.observe(tenant)).get(user).state,"UNVERIFIED");
  }
});

test("fresh Source identity/revision/instance changes during native DISCOVER invalidate a positive result",async()=>{
  for(const patch of [{revision:"5",applied_revision:"5"},{native_user_id:"13"},{zammad_instance_id:"foreign"},{oidc_subject:"foreign"},{email:"different@example.invalid"},{role:"tenant_admin"},{member_state:"SUSPENDED"},{source_identity_current:false}]){
    const rows=[snapshot()],original=snapshot();const observer=new NativeMembershipObserver(readRows(rows),async()=>{Object.assign(rows[0],patch);return ready(original);});
    assert.equal((await observer.observe(tenant)).get(user).state,"UNVERIFIED");
  }
});

test("simultaneous surfaces coalesce exact identities, cache briefly, and never reuse another revision",async()=>{
  const rows=[snapshot()];let resolve,calls=0;const observer=new NativeMembershipObserver(readRows(rows),async row=>{calls++;if(calls===1)await new Promise(done=>{resolve=done;});return ready(row);});
  const first=observer.observe(tenant),second=observer.observe(tenant);await new Promise(done=>setImmediate(done));assert.equal(calls,1);resolve();
  assert.equal((await first).get(user).state,"VERIFIED");assert.equal((await second).get(user).state,"VERIFIED");await observer.observe(tenant);assert.equal(calls,1);
  rows[0].revision="5";rows[0].applied_revision="5";await observer.observe(tenant);assert.equal(calls,2);
  observer.cache.forEach(entry=>{entry.expires=Date.now()-1;});await observer.observe(tenant);assert.equal(calls,3);
});

test("global four-call limit, total deadline and rotating starts keep later members observable",async()=>{
  const rows=[...Array.from({length:20},(_,index)=>({...snapshot(index+100),sync_state:"PENDING"})),...Array.from({length:8},(_,index)=>snapshot(index+1))];let active=0,maximum=0;const visited=[];
  const observer=new NativeMembershipObserver(readRows(rows),async(row,signal)=>{
    active++;maximum=Math.max(maximum,active);visited.push(row.user_id);
    try{await new Promise((resolve,reject)=>{signal.addEventListener("abort",()=>reject(Error("deadline")),{once:true});});return ready(row);}finally{active--;}
  },60);
  const start=Date.now();const [first]=await Promise.all([observer.observe(tenant),observer.observe(tenant)]);assert.ok(Date.now()-start<400);assert.ok([...first.values()].every(value=>value.state==="UNVERIFIED"));assert.equal(maximum,4);
  await new Promise(done=>setTimeout(done,5));await Promise.all([observer.observe(tenant),observer.observe(tenant)]);
  assert.equal(new Set(visited).size,8,"Later members receive a slot on the next visible refresh");assert.equal(maximum,4);
});

test("observation cache is bounded and source/read outages return warnings instead of page errors",async()=>{
  const rows=Array.from({length:270},(_,index)=>snapshot(index+1)),observer=new NativeMembershipObserver(readRows(rows),async row=>ready(row));
  await observer.observe(tenant);assert.ok(observer.cache.size<=256);
  const unavailable=new NativeMembershipObserver(async()=>{throw Error("database unavailable");},async()=>assert.fail("No source identity"));assert.equal((await unavailable.observe(tenant)).size,0);
});

test("unexpected foreign or unrequested rows cannot expand observation authority",async()=>{
  const rows=[{...snapshot(),tenant_id:"foreign"},snapshot(1)],observer=new NativeMembershipObserver(async()=>structuredClone(rows),async()=>assert.fail("No foreign or unrequested dispatch"));
  assert.equal((await observer.observe(tenant,[user])).size,0);
});

test("a slow page cannot return an observation that expired while other members were checked",async(t)=>{
  const rows=[snapshot(),snapshot(1)];let clock=Date.now();t.mock.method(Date,"now",()=>clock);
  const observer=new NativeMembershipObserver(readRows(rows),async row=>{
    if(row.user_id!==user){await new Promise(done=>setImmediate(done));clock+=3_100;}return ready(row);
  });
  assert.equal((await observer.observe(tenant)).get(user).state,"UNVERIFIED");
});
