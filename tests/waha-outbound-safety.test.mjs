import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import { BadRequestException } from "../services/control-api/node_modules/@nestjs/common/index.js";
import { DeliveryProcessor } from "../services/connector-worker/dist/services/connector-worker/src/processor.js";
import { wahaDeferralExpired } from "../services/connector-worker/dist/services/connector-worker/src/repository.js";
import { parseControl,parsePolicy } from "../services/control-api/dist/waha-outbound-safety.controller.js";
import { WahaOutboundSafetyService } from "../services/control-api/dist/waha-outbound-safety.service.js";

const migrationUrl=new URL("../services/control-api/migrations/0035_waha_outbound_safety.sql",import.meta.url);
const destinationLockMigrationUrl=new URL("../services/control-api/migrations/0071_waha_outbound_destination_lock.sql",import.meta.url);
const groupWorkspaceMigrationUrl=new URL("../services/control-api/migrations/0120_ticketless_group_notifications.sql",import.meta.url);
const initiationPolicyMigrationUrl=new URL("../services/control-api/migrations/0124_group_workspace_initiation_policy.sql",import.meta.url);
const policyPrivilegeMigrationUrl=new URL("../services/control-api/migrations/0126_waha_outbound_policy_privilege_and_receipts.sql",import.meta.url);

test("WAHA send authorization is PostgreSQL-fenced, response-only, paced, and fail closed",async()=>{
  const [sql,destinationLockSql,groupWorkspaceSql,initiationPolicySql,policyPrivilegeSql,repository]=await Promise.all([readFile(migrationUrl,"utf8"),readFile(destinationLockMigrationUrl,"utf8"),readFile(groupWorkspaceMigrationUrl,"utf8"),readFile(initiationPolicyMigrationUrl,"utf8"),readFile(policyPrivilegeMigrationUrl,"utf8"),readFile(new URL("../services/connector-worker/src/repository.ts",import.meta.url),"utf8")]);
  for(const table of ["waha_outbound_tenant_controls","waha_outbound_connection_policies","waha_outbound_buckets","waha_outbound_authorizations","waha_platform_outbound_control"])assert.match(sql,new RegExp(`CREATE TABLE (?:public\\.|app\\.)?${table}`));
  assert.match(sql,/CREATE OR REPLACE FUNCTION app\.authorize_waha_outbound_send/);
  assert.match(sql,/SECURITY DEFINER[\s\S]*SET row_security = off/);
  assert.match(sql,/FOR UPDATE OF d,c,b,g/);
  assert.match(destinationLockSql,/FOR UPDATE OF d,c;/);
  assert.match(destinationLockSql,/FOR UPDATE OF b,g;/);
  assert.match(destinationLockSql,/FOR UPDATE OF bot;/);
  assert.doesNotMatch(destinationLockSql,/FOR UPDATE OF d,c,b,g,bot/);
  assert.match(groupWorkspaceSql,/d\.group_workspace_group_id/);
  assert.match(groupWorkspaceSql,/g\.id=delivery_row\.group_workspace_group_id/);
  assert.match(groupWorkspaceSql,/FOR UPDATE OF g,workspace/);
  assert.match(groupWorkspaceSql,/inbound_response_only[\s\S]*delivery_row\.group_workspace_group_id IS NULL[\s\S]*NOT EXISTS/);
  assert.match(initiationPolicySql,/allow_human_group_workspace_initiation boolean NOT NULL DEFAULT false/);
  assert.match(initiationPolicySql,/group_workspace_group_id IS NULL[\s\S]*allow_human_group_workspace_initiation IS DISTINCT FROM true/);
  assert.match(initiationPolicySql,/pg_get_functiondef\('app\.authorize_waha_outbound_send\(uuid\)'::regprocedure\)/);
  assert.match(policyPrivilegeSql,/GRANT UPDATE \(allow_human_group_workspace_initiation\)[\s\S]*TO wasalx_app/);
  assert.match(policyPrivilegeSql,/WAHA_OUTBOUND_TENANT_CONTROL/);
  assert.match(policyPrivilegeSql,/WAHA_OUTBOUND_CONNECTION_POLICY/);
  assert.match(groupWorkspaceSql,/PLATFORM_KILL_SWITCH[\s\S]*TENANT_KILL_SWITCH[\s\S]*CONNECTION_POLICY_DISABLED/);
  assert.match(groupWorkspaceSql,/RATE_LIMITED/);
  assert.match(sql,/pg_advisory_xact_lock[\s\S]*:CONNECTION:[\s\S]*pg_advisory_xact_lock[\s\S]*:NUMBER:/);
  assert.match(sql,/message\.provider_timestamp>=now_value-[\s\S]*response_window_seconds/);
  assert.match(sql,/link\.direction='INBOUND'/);
  assert.match(sql,/link\.zammad_ticket_id=delivery_row\.zammad_ticket_id/);
  assert.match(sql,/inbound_response_only boolean NOT NULL DEFAULT true CHECK \(inbound_response_only\)/);
  assert.match(sql,/NUMBER_IDENTITY_MISSING/);
  assert.match(sql,/platform_enabled IS DISTINCT FROM true/);
  assert.match(sql,/tenant_enabled IS DISTINCT FROM true/);
  assert.match(sql,/policy_row\.connection_id IS NULL OR policy_row\.enabled IS DISTINCT FROM true/);
  assert.match(sql,/UNIQUE \(tenant_id,delivery_id,attempt_number\)/);
  assert.match(sql,/available_tokens=available_tokens-1/);
  assert.match(sql,/RETURN QUERY SELECT false,retry_at,'RATE_LIMITED'/);
  assert.match(sql,/platform_operations_audit_events/);
  assert.match(sql,/waha\.outbound\.platform_control_changed/);
  assert.match(sql,/REVOKE ALL ON app\.waha_platform_outbound_control FROM PUBLIC,wasalx_app/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION app\.authorize_waha_outbound_send\(uuid\) TO wasalx_app/);
  assert.match(sql,/FROM PUBLIC,wasalx_app,wasalx_provisioner/);
  assert.match(repository,/app\.authorize_waha_outbound_send/);
  assert.match(repository,/state='QUEUED',attempts=GREATEST\(0,attempts-1\),available_at=\$1/);
  assert.match(repository,/lease_id=NULL,lease_expires_at=NULL/);
  assert.match(repository,/DELETE FROM delivery_attempts[\s\S]*state='CLAIMED'/);
  assert.match(repository,/NO_RECENT_INBOUND_RESPONSE_WINDOW[\s\S]*FAILED_TERMINAL/);
  assert.doesNotMatch(sql,/anti-ban guarantee|guarantee[^\n]*anti-ban/i);
});

test("WAHA replies expire at the configured response-window boundary",()=>{
  const createdAt="2026-08-17T12:00:00.000Z";
  const job={createdAt,wahaResponseWindowSeconds:86_400};
  assert.equal(wahaDeferralExpired(job,Date.parse("2026-08-18T11:59:59.999Z")),false);
  assert.equal(wahaDeferralExpired(job,Date.parse("2026-08-18T12:00:00.000Z")),true);
  assert.equal(wahaDeferralExpired({createdAt},Date.parse("2026-08-20T12:00:00.000Z")),false);
});

test("a WAHA authorization database failure becomes a durable retry instead of a stuck claim",async()=>{
  const failures=[];
  const delivery={id:"16000000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001",groupBindingId:"15000000-0000-4000-8000-000000000001",groupId:"fixture-0019@example.test",ticketId:"42",articleId:"9",text:"Reply",contentType:"text/plain",idempotencyKey:"delivery-a",attempts:1,provider:"waha",sessionId:"session-a",connectionSecretReference:"secret://connection",providerBaseUrl:"https://waha.example",wahaWorkerId:"worker-a",wahaAssignmentFencingToken:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30};
  const repository={claimBotActions:async()=>[],whatsAppMarketingOptedOut:async()=>false,claimDeliveries:async()=>[delivery],beginSend:async()=>{throw new Error("WAHA authorization database failure")},complete:async()=>{},fail:async(_job,_lease,retryable,error,availableAt,manualRetryAllowed)=>failures.push({retryable,error,availableAt,manualRetryAllowed}),outcomeUnknown:async()=>{},claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("network must not be called")};
  try{await new DeliveryProcessor(repository,{resolve:async()=>({apiKey:"key"})},{metaGraphVersion:"v24.0"}).drainTenant(delivery.tenantId)}finally{globalThis.fetch=originalFetch}
  assert.equal(failures.length,1);assert.equal(failures[0].retryable,true);assert.match(failures[0].error,/authorization database failure/);assert.ok(failures[0].availableAt);assert.equal(failures[0].manualRetryAllowed,true);
});

test("a durable WAHA safety deferral never reaches the provider network boundary",async()=>{
  const calls=[];
  const delivery={id:"16000000-0000-4000-8000-000000000001",tenantId:"10000000-0000-4000-8000-000000000001",connectionId:"12000000-0000-4000-8000-000000000001",groupBindingId:"15000000-0000-4000-8000-000000000001",groupId:"fixture-0019@example.test",ticketId:"42",articleId:"9",text:"Reply",contentType:"text/plain",idempotencyKey:"delivery-a",attempts:1,provider:"waha",sessionId:"session-a",connectionSecretReference:"secret://connection",providerBaseUrl:"https://waha.example",wahaWorkerId:"worker-a",wahaAssignmentFencingToken:1,zammadBaseUrl:"https://zammad.example",zammadSecretReference:"secret://zammad",mediaEnabled:true,retentionDays:30};
  const repository={claimBotActions:async()=>[],whatsAppMarketingOptedOut:async()=>false,claimDeliveries:async()=>[delivery],beginSend:async()=>{calls.push("safety-deferred");return false},complete:async()=>calls.push("complete"),fail:async()=>calls.push("fail"),outcomeUnknown:async()=>calls.push("unknown"),claimStatuses:async()=>[],completeStatus:async()=>{},retryStatus:async()=>{},failStatus:async()=>{}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{calls.push("network");throw new Error("network must not be called")};
  try{const processor=new DeliveryProcessor(repository,{resolve:async()=>({apiKey:"key"})},{metaGraphVersion:"v24.0"});assert.deepEqual(await processor.drainTenant(delivery.tenantId),{actions:0,deliveries:1,statuses:0})}finally{globalThis.fetch=originalFetch}
  assert.deepEqual(calls,["safety-deferred"]);
});

test("tenant and platform control inputs are bounded and deterministic",()=>{
  assert.deepEqual(parseControl({expectedVersion:2,enabled:false,reason:"Incident containment"}),{expectedVersion:2,enabled:false,reason:"Incident containment"});
  const policy=parsePolicy({expectedVersion:3,enabled:true,reason:"Approved operations policy",inboundResponseOnly:true,allowHumanGroupWorkspaceInitiation:false,responseWindowSeconds:86400,connectionCapacity:3,connectionRefillTokens:1,connectionRefillSeconds:30,numberCapacity:5,numberRefillTokens:1,numberRefillSeconds:30,minimumSpacingSeconds:5});
  assert.equal(policy.responseWindowSeconds,86400);assert.equal(policy.minimumSpacingSeconds,5);
  assert.equal(policy.allowHumanGroupWorkspaceInitiation,false);
  for(const invalid of [{expectedVersion:0,enabled:true,reason:"valid reason"},{expectedVersion:1,enabled:"true",reason:"valid reason"},{expectedVersion:1,enabled:true,reason:"no"}])assert.throws(()=>parseControl(invalid),BadRequestException);
  assert.throws(()=>parsePolicy({...policy,responseWindowSeconds:299}),BadRequestException);
  assert.throws(()=>parsePolicy({...policy,minimumSpacingSeconds:0}),BadRequestException);
  assert.throws(()=>parsePolicy({...policy,inboundResponseOnly:false}),BadRequestException);
  assert.throws(()=>parsePolicy({...policy,allowHumanGroupWorkspaceInitiation:"true"}),BadRequestException);
});

test("WAHA connection policy mutations replay their durable receipt and re-wake accepted work",async()=>{
  const tenantId="10000000-0000-4000-8000-000000000001";
  const connectionId="40000000-0000-4000-8000-000000000001";
  const principal={subject:"operator",userId:"20000000-0000-4000-8000-000000000001",tenantId,email:"operator@example.test",displayName:"Operator",role:"tenant_admin"};
  const input={expectedVersion:1,enabled:true,inboundResponseOnly:true,allowHumanGroupWorkspaceInitiation:true,responseWindowSeconds:86_400,connectionCapacity:10,connectionRefillTokens:10,connectionRefillSeconds:60,numberCapacity:4,numberRefillTokens:4,numberRefillSeconds:60,minimumSpacingSeconds:2,reason:"Enable group workspace initiation"};
  const receipts=new Map();let updates=0;const wakes=[];
  const client={query:async(sql,values=[])=>{
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:1};
    if(sql.startsWith("SELECT action,request_sha256,result")){const row=receipts.get(`${values[0]}:${values[1]}`);return{rows:row?[row]:[],rowCount:row?1:0}}
    if(sql.startsWith("SELECT * FROM waha_outbound_connection_policies"))return{rows:[{tenant_id:tenantId,connection_id:connectionId,version:1,enabled:false,updated_by:principal.userId}],rowCount:1};
    if(sql.startsWith("UPDATE waha_outbound_connection_policies")){updates+=1;return{rows:[{connection_id:connectionId,version:2,enabled:true,allow_human_group_workspace_initiation:true}],rowCount:1}}
    if(sql.includes("INSERT INTO audit_events"))return{rows:[],rowCount:1};
    if(sql.startsWith("INSERT INTO bot_flow_operations")){receipts.set(`${values[0]}:${values[2]}`,{action:values[1],request_sha256:values[3],result:values[4]});return{rows:[],rowCount:1}}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  const service=new WahaOutboundSafetyService({withTenant:async(actualTenant,operation)=>{assert.equal(actualTenant,tenantId);return operation(client)}},{wake:async actualTenant=>wakes.push(actualTenant)});
  assert.deepEqual(await service.changeConnectionPolicy(principal,connectionId,input,"policy-1","request-1"),{connection_id:connectionId,version:2,enabled:true,allow_human_group_workspace_initiation:true,duplicate:false});
  assert.deepEqual(await service.changeConnectionPolicy(principal,connectionId,input,"policy-1","request-2"),{connection_id:connectionId,version:2,enabled:true,allow_human_group_workspace_initiation:true,duplicate:true});
  await assert.rejects(()=>service.changeConnectionPolicy(principal,connectionId,{...input,reason:"Different request"},"policy-1","request-3"),error=>error?.status===409);
  assert.equal(updates,1);
  assert.deepEqual(wakes,[tenantId,tenantId]);
});

test("tenant operators can change only the existing audited group-initiation policy through the portal",async()=>{
  const [route,portal,screen,service,controller,permissions]=await Promise.all([
    readFile(new URL("../app/api/waha-outbound-safety/route.ts",import.meta.url),"utf8"),
    readFile(new URL("../lib/control-plane-data.ts",import.meta.url),"utf8"),
    readTenantPortalSource(),
    readFile(new URL("../services/control-api/src/waha-outbound-safety.service.ts",import.meta.url),"utf8"),
    readFile(new URL("../services/control-api/src/waha-outbound-safety.controller.ts",import.meta.url),"utf8"),
    readFile(new URL("../packages/core/src/tenant-permissions.ts",import.meta.url),"utf8"),
  ]);
  assert.match(route,/authenticatePortalRequest\(request,"settings:read"\)/);
  assert.match(route,/authenticatePortalRequest\(request,"settings:write"\)/);
  assert.match(portal,/\/v1\/settings\/waha-outbound-safety\/connections\/\$\{encodeURIComponent\(connectionId\)\}/);
  assert.match(route,/request\.headers\.get\("idempotency-key"\)/);
  assert.match(portal,/headers:\{"idempotency-key":idempotencyKey\}/);
  assert.match(controller,/requireOperationKey\(key\)/);
  assert.match(service,/withOperationReceipt[\s\S]*WAHA_OUTBOUND_TENANT_CONTROL/);
  assert.match(service,/withOperationReceipt[\s\S]*WAHA_OUTBOUND_CONNECTION_POLICY/);
  assert.match(screen,/function WahaGroupInitiationPolicy/);
  assert.match(screen,/canReadSettings={!isPrivateDemo && canReadSettings}/);
  assert.match(screen,/canWriteSettings={canWriteSettings}/);
  assert.match(screen,/detail\.provider === "WAHA" && canReadSettings/);
  assert.match(screen,/canWrite={canWriteSettings}/);
  assert.match(screen,/headers:\{\.\.\.mutationHeaders,"idempotency-key":saveAttempt\.current\.key\}/);
  assert.match(screen,/saveAttempt\.current\?\.fingerprint!==fingerprint/);
  assert.match(screen,/aria-expanded=\{dirty\}/);
  assert.match(screen,/aria-controls="waha-send-policy-change"/);
  assert.doesNotMatch(screen,/autoFocus/);
  assert.match(permissions,/tenant_admin:[\s\S]*"settings:read"/);
  assert.doesNotMatch(permissions,/tenant_admin:\[[^\]]*"settings:write"/);
  assert.doesNotMatch(permissions,/agent:\[[^\]]*"settings:read"/);
  assert.match(screen,/allowHumanGroupWorkspaceInitiation:enabled/);
  for(const field of ["inboundResponseOnly","responseWindowSeconds","connectionCapacity","connectionRefillTokens","connectionRefillSeconds","numberCapacity","numberRefillTokens","numberRefillSeconds","minimumSpacingSeconds"]){
    assert.match(screen,new RegExp(`${field}:policy\\.`));
  }
  assert.match(screen,/reason\.trim\(\)\.length<3/);
  assert.match(screen,/data-unsaved=\{dirty\|\|undefined\}/);
});
