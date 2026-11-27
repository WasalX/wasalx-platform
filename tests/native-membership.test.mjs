import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { SignJWT } from "jose";
import { NativeMembershipService } from "../services/control-api/dist/native-membership.service.js";
import { NativeMembershipController, NativeMembershipInternalController } from "../services/control-api/dist/native-membership.controller.js";
import { ServiceAuthService } from "../services/control-api/dist/service-auth.service.js";
import { authoritativeMfaPolicy, hasAuthoritativeMfa } from "../services/control-api/dist/privileged-auth.js";

const tenantId="10000000-0000-4000-8000-000000000001", instanceId="11000000-0000-4000-8000-000000000001", userId="30000000-0000-4000-8000-000000000003";
const secret="native-membership-synthetic-signing-secret";
const snapshot=()=>({tenant_id:tenantId,user_id:userId,oidc_subject:"immutable-staff",email:"staff@example.test",display_name:"Staff Member",role:"agent",member_state:"ACTIVE",revision:4,native_user_id:null,requested_native_user_id:null,applied_revision:0,sync_state:"PENDING",zammad_instance_id:null});
const request=()=>({id:"membership-review",principal:{tenantId,userId,role:"tenant_owner",authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:["mfa"]}});

function worker(row,reply,{instance=instanceId,failResultCommit=false,tenantActive=true}={}){
  let calls=0;const queries=[];
  const client={query:async(sql,values)=>{
    queries.push({sql,values});
    if(sql.includes("lock_current_active_tenant_for_event_admission"))return{rows:[{active:tenantActive}]};
    if(sql.includes("FOR UPDATE SKIP LOCKED"))return{rows:row.sync_state==="PENDING"?[{...row}]:[]};
    if(sql.includes("FOR UPDATE"))return{rows:[{...row}]};
    if(sql.includes("FROM zammad_instances"))return{rows:instance?[{id:instance,base_url:"https://native.example.test",service_secret_reference:"synthetic"}]:[]};
    if(sql.includes("zammad_instance_id=$3"))row.zammad_instance_id=values[2];
    if(sql.includes("sync_state='UNAVAILABLE'"))row.sync_state="UNAVAILABLE";
    if(sql.includes("applied_revision=revision")){row.native_user_id=values[2]??null;row.applied_revision=row.revision;row.sync_state="READY";}
    if(sql.includes("SET sync_state=$3"))row.sync_state=values[2];
    return{rows:[],rowCount:1};
  }};
  let transactions=0;
  const database={withTenant:async(id,fn)=>{
    assert.equal(id,row.tenant_id);transactions++;const committed={...row};
    try{const result=await fn(client);if(failResultCommit&&transactions===2)throw new Error("result commit failed");return result;}
    catch(error){Object.assign(row,committed);throw error;}
  },rows:async(id,sql,values)=>(await client.query(sql,values)).rows};
  const service=new NativeMembershipService(database,{resolveCredentials:async()=>({jwtSecret:secret,apiToken:"synthetic-token"})});
  const fetch=async(url,options)=>{
    calls++;assert.equal(String(url),"https://native.example.test/api/v1/wasalx/membership");
    assert.equal(options.headers["x-wasalx-signature"],createHmac("sha256",secret).update(`${options.headers["x-wasalx-timestamp"]}\n${options.body}`).digest("hex"));
    const sent=JSON.parse(options.body);assert.equal(sent.subject,row.oidc_subject);assert.equal(sent.tenant_id,row.tenant_id);assert.equal(sent.revision,row.revision);
    if(reply instanceof Error)throw reply;
    return new Response(JSON.stringify(reply),{status:200,headers:{"content-type":"application/json"}});
  };
  return{service,database,fetch,queries,calls:()=>calls};
}

test("membership discovery, scheduled tenant and immediate wake failures are redacted and recoverable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-16T10:00:00Z") });
  const first = snapshot();
  const second = { ...snapshot(), tenant_id: "10000000-0000-4000-8000-000000000002" };
  const reply = { state: "READY", native_user_id: "12", revision: 4 };
  const a = worker(first, reply);
  const b = worker(second, reply);
  const failure = new Error(`Synthetic failure for ${first.tenant_id}`);
  const visited = [];
  const logs = [];
  let discover = false;
  let rejectClaim = true;
  a.database.pendingNativeMembershipTenants = async () => {
    if (!discover) throw failure;
    return [first.tenant_id, second.tenant_id];
  };
  const withFirst = a.database.withTenant;
  t.mock.method(a.database, "withTenant", (id, operation) => {
    visited.push(id);
    if (id === second.tenant_id) return b.database.withTenant(id, operation);
    if (rejectClaim) return Promise.reject(failure);
    return withFirst(id, operation);
  });
  t.mock.method(globalThis, "fetch", (url, options) =>
    (JSON.parse(options.body).tenant_id === first.tenant_id ? a : b).fetch(url, options));
  t.mock.method(process.stderr, "write", (line) => { logs.push(JSON.parse(String(line))); return true; });

  await a.service.drain();
  assert.deepEqual(visited, []);
  discover = true;
  await a.service.drain();
  assert.deepEqual([...new Set(visited)], [first.tenant_id, second.tenant_id]);
  assert.equal(first.sync_state, "PENDING");
  assert.equal(second.sync_state, "READY");
  assert.equal(a.calls(), 0);
  assert.equal(b.calls(), 1);
  assert.equal(a.service.wake(first.tenant_id), undefined);
  await new Promise(setImmediate);
  rejectClaim = false;
  await a.service.drain();
  assert.equal(first.sync_state, "READY");
  assert.equal(a.calls(), 1);
  assert.equal(b.calls(), 1);
  assert.deepEqual(logs, ["discovery", "tenant", "wake"].map((phase) => ({
    timestamp: new Date().toISOString(), level: "error", event: "native_projection.failed", projection: "membership", phase,
  })));
});

test("native projection authenticates exact source and commits only the matching revision",async(t)=>{
  const row=snapshot(),w=worker(row,{state:"READY",native_user_id:"12",revision:4});t.mock.method(globalThis,"fetch",w.fetch);
  await w.service.syncTenant(tenantId);assert.equal(row.sync_state,"READY");assert.equal(row.native_user_id,"12");assert.equal(row.applied_revision,4);assert.equal(w.calls(),1);
  const tenantLock=w.queries.findIndex(q=>q.sql.includes("lock_current_active_tenant_for_event_admission"));
  const instanceRead=w.queries.findIndex(q=>q.sql.includes("FROM zammad_instances"));
  assert(tenantLock>=0&&instanceRead>tenantLock);assert.doesNotMatch(w.queries[instanceRead].sql,/FOR SHARE|JOIN tenants/);
});
test("inactive tenant admission makes no native request and preserves the durable unavailable fence",async(t)=>{
  const row=snapshot(),w=worker(row,{state:"READY",native_user_id:"12",revision:4},{tenantActive:false});t.mock.method(globalThis,"fetch",w.fetch);
  await w.service.syncTenant(tenantId);await w.service.syncTenant(tenantId);
  assert.equal(row.sync_state,"UNAVAILABLE");assert.equal(row.native_user_id,null);assert.equal(w.calls(),0);
  assert.equal(w.queries.some(q=>q.sql.includes("FROM zammad_instances")),false);
});
test("unknown native outcome is durable and never automatically replayed unchanged",async(t)=>{
  const row=snapshot(),w=worker(row,new Error("connection lost after send"));t.mock.method(globalThis,"fetch",w.fetch);
  await w.service.syncTenant(tenantId);await w.service.syncTenant(tenantId);assert.equal(row.sync_state,"UNAVAILABLE");assert.equal(row.native_user_id,null);assert.equal(w.calls(),1);
});
test("crash or local result commit failure after native success never leaves replayable work",async(t)=>{
  const row=snapshot(),w=worker(row,{state:"READY",native_user_id:"12",revision:4},{failResultCommit:true});t.mock.method(globalThis,"fetch",w.fetch);
  await assert.rejects(()=>w.service.syncTenant(tenantId),/result commit failed/);
  assert.equal(row.sync_state,"UNAVAILABLE");assert.equal(row.zammad_instance_id,instanceId);assert.equal(row.native_user_id,null);
  await w.service.syncTenant(tenantId);assert.equal(w.calls(),1);
});
test("a changed native ID persists conflict and stops deterministic automatic replay",async(t)=>{
  const row={...snapshot(),native_user_id:"12",applied_revision:3},w=worker(row,{state:"READY",native_user_id:"13",revision:4});t.mock.method(globalThis,"fetch",w.fetch);
  await w.service.syncTenant(tenantId);await w.service.syncTenant(tenantId);
  assert.equal(row.sync_state,"CONFLICT");assert.equal(row.native_user_id,"12");assert.equal(row.applied_revision,3);assert.equal(w.calls(),1);
});
test("native partial/conflicting responses and instance drift cannot qualify access",async(t)=>{
  for(const reply of [{state:"READY",native_user_id:"12",revision:3},{state:"READY",native_user_id:"0",revision:4},{state:"READY",revision:4},{state:"ADOPTION_REQUIRED"},{state:"PROTECTED"}]){
    const row=snapshot(),w=worker(row,reply);const mock=t.mock.method(globalThis,"fetch",w.fetch);await w.service.syncTenant(tenantId);mock.mock.restore();assert.notEqual(row.sync_state,"READY");assert.equal(row.applied_revision,0);
  }
  const row={...snapshot(),zammad_instance_id:"other-instance"},w=worker(row,{state:"READY",native_user_id:"12",revision:4});t.mock.method(globalThis,"fetch",w.fetch);await w.service.syncTenant(tenantId);assert.equal(row.sync_state,"UNAVAILABLE");assert.equal(w.calls(),0);
});
test("removal before native creation records an absent-account tombstone without creating a user",async(t)=>{
  const row={...snapshot(),member_state:"REMOVED"},w=worker(row,{state:"READY",native_user_id:null,revision:4});t.mock.method(globalThis,"fetch",w.fetch);await w.service.syncTenant(tenantId);assert.equal(row.sync_state,"READY");assert.equal(row.native_user_id,null);
});
test("active auditor without native access is synchronized and later agent transition can bind one account",async(t)=>{
  const row={...snapshot(),role:"auditor"},w=worker(row,{state:"READY",native_user_id:null,revision:4});const mock=t.mock.method(globalThis,"fetch",w.fetch);await w.service.syncTenant(tenantId);mock.mock.restore();assert.equal(row.sync_state,"READY");assert.equal(row.native_user_id,null);
  row.role="agent";row.revision=5;row.sync_state="PENDING";const next=worker(row,{state:"READY",native_user_id:"12",revision:5});t.mock.method(globalThis,"fetch",next.fetch);await next.service.syncTenant(tenantId);assert.equal(row.native_user_id,"12");assert.equal(row.applied_revision,5);
});
test("account adoption requires owner, recent MFA, exact source version and explicit candidate review",async()=>{
  const row={...snapshot(),sync_state:"ADOPTION_REQUIRED"};const updates=[];
  const db={withTenant:async(id,fn)=>fn({query:async(sql,values)=>{
    if(sql.includes("privileged_reauth_minutes"))return{rows:[{privileged_reauth_minutes:15}]};
    if(sql.includes("FOR UPDATE"))return{rows:[row]};updates.push({sql,values});return{rows:[],rowCount:1};
  }}),rows:async()=>[]};let wakes=0;
  const controller=new NativeMembershipController(db,{wake:()=>wakes++});
  await assert.rejects(()=>controller.reconcile({...request(),principal:{...request().principal,role:"supervisor"}},userId,{expectedRevision:4,adoptUserId:"12"}),/owner/);
  await assert.rejects(()=>controller.reconcile({...request(),principal:{...request().principal,authenticationMethods:[]}},userId,{expectedRevision:4,adoptUserId:"12"}),/authentication/);
  await assert.rejects(()=>controller.reconcile(request(),userId,{expectedRevision:3,adoptUserId:"12"}),/changed/);
  await controller.reconcile(request(),userId,{expectedRevision:4,adoptUserId:"12"});assert.equal(wakes,1);assert.ok(updates.some(q=>q.values?.[2]==="12"));
  row.native_user_id="13";await assert.rejects(()=>controller.reconcile(request(),userId,{expectedRevision:4,adoptUserId:"12"}),/cannot adopt/);
});
test("retry requires a documented changed prerequisite; protected and pending work cannot be replayed",async()=>{
  const row={...snapshot(),sync_state:"UNAVAILABLE"};
  const db={withTenant:async(id,fn)=>fn({query:async(sql)=>({rows:sql.includes("privileged_reauth_minutes")?[{privileged_reauth_minutes:15}]:sql.includes("FOR UPDATE")?[row]:[]})}),rows:async()=>[]};
  const controller=new NativeMembershipController(db,{wake:()=>{}});
  await assert.rejects(()=>controller.reconcile(request(),userId,{expectedRevision:4}),/prerequisite/);
  for(const state of ["PROTECTED","PENDING"]){row.sync_state=state;await assert.rejects(()=>controller.reconcile(request(),userId,{expectedRevision:4,prerequisiteChange:"Native service restored"}),/separately|pending/);}
});
test("signed stale group/admin claims are denied before any action for a managed identity",async()=>{
  let projection={allowed:true,revision:4,role:"tenant_admin"};
  const db={rows:async(id,sql,values)=>{
    assert.equal(id,tenantId);
    if(sql.includes("FROM native_membership_projections")){assert.deepEqual(values,[tenantId,instanceId,"12"]);assert.match(sql,/m.role=p.role AND t.state='ACTIVE'/);return projection?[projection]:[];}
    return[{id:instanceId,tenant_id:tenantId,service_secret_reference:"synthetic"}];
  }};
  const auth=new ServiceAuthService(db,{resolveSigningSecret:async()=>secret});
  const sign=async(revision)=>new SignJWT({tenant_id:tenantId,instance_id:instanceId,scope:"zammad:group-workspace",zammad_user_id:"12",zammad_group_ids:["7"],zammad_group_admin:true,...(revision===undefined?{}:{zammad_membership_revision:revision})}).setProtectedHeader({alg:"HS256",typ:"JWT"}).setIssuer("wasalx-zammad").setAudience("wasalx-control").setSubject(instanceId).setIssuedAt().setExpirationTime("2m").setJti(crypto.randomUUID()).sign(new TextEncoder().encode(secret));
  for(const revision of [undefined,3,"4"]){await assert.rejects(()=>sign(revision).then(token=>auth.verify(`Bearer ${token}`,"zammad:group-workspace")),/Invalid service token/);}
  const verified=await auth.verify(`Bearer ${await sign(4)}`,"zammad:group-workspace");
  assert.equal(verified.userId,"12");assert.equal(verified.membershipRevision,4);assert(Number.isSafeInteger(verified.expiresAt));
  projection.role="agent";await assert.rejects(()=>sign(4).then(token=>auth.verify(`Bearer ${token}`,"zammad:group-workspace")),/Invalid service token/);
  projection.role="tenant_admin";
  projection.allowed=false;await assert.rejects(()=>sign(4).then(token=>auth.verify(`Bearer ${token}`,"zammad:group-workspace")),/Invalid service token/);
  projection=null;await assert.rejects(()=>sign(4).then(token=>auth.verify(`Bearer ${token}`,"zammad:group-workspace")),/Invalid service token/);
  assert.equal((await auth.verify(`Bearer ${await sign(undefined)}`,"zammad:group-workspace")).userId,"12");
});
test("native admission checks fail closed for missing projection, inactive tenant and stale membership",async()=>{
  let rows=[];const controller=new NativeMembershipInternalController({rows:async()=>rows},{verify:async()=>({tenantId,instanceId})});
  assert.deepEqual(await controller.check("signed",{user_id:userId,native_user_id:"12",revision:4}),{allowed:false});
  rows=[{allowed:true}];assert.deepEqual(await controller.check("signed",{user_id:userId,native_user_id:"12",revision:4}),{allowed:false});
  rows=[{state:"SUSPENDED",native_membership_sync_enabled:true}];assert.deepEqual(await controller.identity("signed",{subject:"immutable-staff"}),{enabled:true,native_user_id:null});
});

function policyEnvironment(t,amr,acr){
  const names=["OIDC_PRIVILEGED_MFA_AMR_VALUES","OIDC_PRIVILEGED_ACR_VALUES"],previous=names.map(name=>process.env[name]);
  for(const [index,value]of [amr,acr].entries()){if(value===undefined)delete process.env[names[index]];else process.env[names[index]]=value;}
  t.after(()=>names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];}));
}
const policyRow=()=>({native_user_id:"12",oidc_subject:"immutable-staff",role:"tenant_owner",active_mfa_required_roles:["tenant_owner"],active_session_timeout_minutes:480,policy_version:"2"});
function policyController(row,{enabled=true,tenantState="ACTIVE",claims={tenantId,instanceId},projectionRows=row?[row]:[],identityRows=projectionRows}={}){
  const queries=[];
  const database={rows:async(tenant,sql,values)=>{
    queries.push({tenant,sql,values});assert.equal(tenant,claims.tenantId);
    if(sql.startsWith("SELECT s.native_membership_sync_enabled"))return[{native_membership_sync_enabled:enabled,state:tenantState}];
    assert.match(sql,/p\.tenant_id=\$1 AND p\.zammad_instance_id=\$2/);
    assert.match(sql,/p\.member_state='ACTIVE'/);assert.match(sql,/p\.role<>'auditor'/);
    assert.match(sql,/p\.sync_state='READY'\s+AND p\.revision=p\.applied_revision/);
    assert.match(sql,/m\.state='ACTIVE' AND m\.role=p\.role/);assert.match(sql,/u\.oidc_subject=p\.oidc_subject/);
    assert.match(sql,/t\.state='ACTIVE'/);assert.match(sql,/s\.native_membership_sync_enabled/);
    assert.match(sql,/s\.active_mfa_required_roles,s\.active_session_timeout_minutes,(?:s\.privileged_reauth_minutes,)?s\.version AS policy_version/);
    assert.doesNotMatch(sql,/\bs\.(?:mfa_required_roles|session_timeout_minutes)\b/);
    assert.deepEqual(values.slice(0,2),[claims.tenantId,claims.instanceId]);
    if(sql.includes(" AS allowed")){assert.match(sql,/p\.revision=\$5/);assert.match(sql,/p\.user_id=\$3 AND p\.native_user_id=\$4/);assert.match(sql,/p\.email=u\.email/);}
    else{assert.match(sql,/p\.oidc_subject=\$3/);assert.equal(values[2],"immutable-staff");}
    return (sql.includes(" AS allowed")?projectionRows:identityRows).map(value=>({...value,allowed:value.allowed??(enabled&&tenantState==="ACTIVE")}));
  }};
  const auth={verify:async(authorization,scope,request)=>{assert.equal(authorization,"signed");assert.equal(scope,"zammad:membership");assert.equal(request?.url,"/signed-membership");return claims;}};
  return{controller:new NativeMembershipInternalController(database,auth),queries};
}
const internalRequest={method:"POST",url:"/signed-membership",rawBody:new Uint8Array()};
const admissionBody={user_id:userId,native_user_id:"12",revision:4};

test("privileged native admission returns only a valid current reauthentication window",async(t)=>{
  policyEnvironment(t);
  for(const minutes of [5,15,120,"15"]){
    const {controller}=policyController({...policyRow(),privileged_reauth_minutes:minutes});
    const result=await controller.check("signed",{...admissionBody,privileged:true},internalRequest);
    assert.equal(result.allowed,true);assert.equal(result.privileged_reauth_minutes,Number(minutes));
    assert.equal(Object.hasOwn(await controller.check("signed",admissionBody,internalRequest),"privileged_reauth_minutes"),false);
  }
  for(const minutes of [undefined,null,4,121,15.5,"1.5e1",true,[15]]){
    const {controller}=policyController({...policyRow(),privileged_reauth_minutes:minutes});
    assert.deepEqual(await controller.check("signed",{...admissionBody,privileged:true},internalRequest),{allowed:false});
  }
  const {controller}=policyController(policyRow());
  await assert.rejects(()=>controller.check("signed",{...admissionBody,privileged:"true"},internalRequest),/Membership check is invalid/);
});

test("native identity and checks expose only active role policy and exact current subject",async(t)=>{
  policyEnvironment(t);
  for(const role of ["tenant_owner","agent"]){
    const row={...policyRow(),role,mfa_required_roles:["agent"],session_timeout_minutes:15,security_policy_state:"REQUESTED"};
    const fixture=policyController(row),policy={mfa_required:role==="tenant_owner",session_timeout_minutes:480,policy_version:2,subject:"immutable-staff",mfa_amr_values:["mfa"],mfa_acr_values:[]};
    assert.deepEqual(await fixture.controller.identity("signed",{subject:"immutable-staff"},internalRequest),{enabled:true,native_user_id:"12",authentication_policy:policy});
    assert.deepEqual(await fixture.controller.check("signed",admissionBody,internalRequest),{allowed:true,authentication_policy:policy});
    assert.deepEqual(fixture.queries.at(-1).values,[tenantId,instanceId,userId,"12",4]);
  }
});

test("native missing or malformed active policy never becomes a default MFA exemption",async(t)=>{
  policyEnvironment(t);
  for(const change of [{active_mfa_required_roles:undefined},{active_mfa_required_roles:[]},{active_mfa_required_roles:["unknown"]},
    {active_mfa_required_roles:"tenant_owner"},{active_session_timeout_minutes:undefined},{active_session_timeout_minutes:14},
    {active_session_timeout_minutes:1441},{active_session_timeout_minutes:"4.8e2"},{policy_version:undefined},{policy_version:0},
    {policy_version:Number.MAX_SAFE_INTEGER+1},{policy_version:true},{oidc_subject:"changed\u0000subject"},{oidc_subject:""},
    {native_user_id:null}]){
    const {controller}=policyController({...policyRow(),...change});
    assert.deepEqual(await controller.identity("signed",{subject:"immutable-staff"},internalRequest),{enabled:true,native_user_id:null});
    assert.deepEqual(await controller.check("signed",admissionBody,internalRequest),{allowed:false});
  }
  for(const session of [15,1440]){
    const {controller}=policyController({...policyRow(),active_session_timeout_minutes:session});
    assert.equal((await controller.check("signed",admissionBody,internalRequest)).authentication_policy.session_timeout_minutes,session);
  }
});

test("native denied, disabled legacy, stale and foreign membership responses omit authentication policy",async(t)=>{
  policyEnvironment(t);
  const disabled=policyController(policyRow(),{enabled:false}).controller;
  assert.deepEqual(await disabled.identity("signed",{subject:"immutable-staff"},internalRequest),{enabled:false});
  assert.deepEqual(await disabled.check("signed",admissionBody,internalRequest),{allowed:false});
  for(const options of [{tenantState:"SUSPENDED"},{projectionRows:[]},
    {claims:{tenantId,instanceId:"11000000-0000-4000-8000-000000000002"},projectionRows:[]},
    {claims:{tenantId:"10000000-0000-4000-8000-000000000002",instanceId},projectionRows:[]}]){
    const {controller}=policyController(policyRow(),options);
    assert.deepEqual(await controller.identity("signed",{subject:"immutable-staff"},internalRequest),{enabled:true,native_user_id:null});
    assert.deepEqual(await controller.check("signed",admissionBody,internalRequest),{allowed:false});
  }
  const stale=policyController({...policyRow(),allowed:false});
  assert.deepEqual(await stale.controller.check("signed",{...admissionBody,revision:3},internalRequest),{allowed:false});
  assert.equal(stale.queries.at(-1).values[4],3);
  for(const role of ["agent","tenant_admin"]){
    const {controller}=policyController({...policyRow(),role,allowed:false},{identityRows:[]});
    assert.deepEqual(await controller.identity("signed",{subject:"immutable-staff"},internalRequest),{enabled:true,native_user_id:null});
    assert.deepEqual(await controller.check("signed",admissionBody,internalRequest),{allowed:false});
  }
});

test("native policy and Source MFA share exact configured acceptance without empty-config fallback",async(t)=>{
  policyEnvironment(t," otp , mfa,otp "," urn:custom:loa:2, urn:custom:loa:2 ");
  const acceptance={mfa_amr_values:["otp","mfa"],mfa_acr_values:["urn:custom:loa:2"]};
  assert.deepEqual(authoritativeMfaPolicy(),acceptance);
  const {controller}=policyController(policyRow());
  const response=await controller.check("signed",admissionBody,internalRequest);
  for(const [key,value]of Object.entries(acceptance))assert.deepEqual(response.authentication_policy[key],value);
  assert.equal(hasAuthoritativeMfa({authenticationMethods:[" OTP "]}),true);
  assert.equal(hasAuthoritativeMfa({authenticationContext:" urn:custom:loa:2 "}),true);
  assert.equal(hasAuthoritativeMfa({authenticationContext:"urn:wasalx:loa:2"}),false);
  process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES="MFA";process.env.OIDC_PRIVILEGED_ACR_VALUES="URN:Custom";
  assert.deepEqual(authoritativeMfaPolicy(),{mfa_amr_values:["MFA"],mfa_acr_values:["URN:Custom"]});
  assert.equal(hasAuthoritativeMfa({authenticationMethods:["MFA"]}),false);
  assert.equal(hasAuthoritativeMfa({authenticationContext:"URN:Custom"}),true);
  process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES="";process.env.OIDC_PRIVILEGED_ACR_VALUES="";
  assert.deepEqual(authoritativeMfaPolicy(),{mfa_amr_values:[],mfa_acr_values:[]});
  assert.equal(hasAuthoritativeMfa({authenticationMethods:["mfa"],authenticationContext:"urn:wasalx:loa:2"}),false);
  assert.deepEqual((await controller.check("signed",admissionBody,internalRequest)).authentication_policy.mfa_amr_values,[]);
  for(const value of ["x".repeat(129),"mfa\u200b",Array.from({length:33},(_,index)=>`mfa${index}`).join(",")]){
    process.env.OIDC_PRIVILEGED_MFA_AMR_VALUES=value;
    assert.equal(authoritativeMfaPolicy(),undefined);
    assert.equal(hasAuthoritativeMfa({authenticationMethods:["mfa"]}),false);
    assert.deepEqual(await controller.check("signed",admissionBody,internalRequest),{allowed:false});
    assert.deepEqual(await controller.identity("signed",{subject:"immutable-staff"},internalRequest),{enabled:true,native_user_id:null});
  }
});


test("portal delegation receives its configured issuer and audience without reusing the native client", async t => {
  const previous = { issuer: process.env.OIDC_ISSUER, audience: process.env.OIDC_AUDIENCE };
  process.env.OIDC_ISSUER = "https://portal-identity.example.test";
  process.env.OIDC_AUDIENCE = "portal-api";
  t.after(() => {
    if (previous.issuer === undefined) delete process.env.OIDC_ISSUER; else process.env.OIDC_ISSUER = previous.issuer;
    if (previous.audience === undefined) delete process.env.OIDC_AUDIENCE; else process.env.OIDC_AUDIENCE = previous.audience;
  });
  policyEnvironment(t);
  const { controller } = policyController(policyRow());
  const response = await controller.check("signed", admissionBody, internalRequest);
  assert.deepEqual(response.portal_source, { issuer: process.env.OIDC_ISSUER, audience: "portal-api" });
});
