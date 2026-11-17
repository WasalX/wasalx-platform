import test from 'node:test';
import assert from 'node:assert/strict';
import {admitRetainedSecurityBusiness} from "../scripts/release/simulation-retained-security-business.mjs";

const tenantId='10000000-0000-4000-8000-000000000001',iso={evidenceMode:'simulated',role:'tenant_owner',onlyIsolationMembership:true,userId:'20000000-0000-4000-8000-000000000002',tenantId:'30000000-0000-4000-8000-000000000003'};
const row=(contextId,result='passed')=>({testId:'tenant-isolation/x::01',contextId,result,startedAt:'2026-10-29T10:00:00.000Z',finishedAt:'2026-10-29T10:00:01.000Z',proof:{}});
const fixture=(extra={})=>({evidenceMode:'simulated',tenantId,isolationActor:iso,results:[row('tenant_owner-en-desktop'),row('tenant_owner-en-tablet','failed')],...extra});
const restricted=role=>({role,actorVerified:true,actorRef:'sha256:'+'a'.repeat(64),tenantRef:'sha256:'+'b'.repeat(64),tenantId,executionId:'e',conversationId:'c',eventIds:['e','f'],noProviderReplay:true,actualViewport:{width:1440,height:1000},startedAt:'2026-10-29T10:00:00.000Z',finishedAt:'2026-10-29T10:00:01.000Z'});

test('retained security fixture keeps original outcomes and the exact isolation owner',()=>{assert.equal(admitRetainedSecurityBusiness(fixture(),{tenantId}),iso);});
test('retained security fixture rejects foreign tenant, same-tenant isolation, missing windows and duplicate rows',()=>{
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({tenantId:iso.tenantId}),{tenantId}),/another tenant/);
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({isolationActor:{...iso,tenantId}}),{tenantId}));
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({results:[{...row('tenant_owner-en-desktop'),startedAt:undefined}]}),{tenantId}),/original window/);
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({results:[row('tenant_owner-en-desktop'),row('tenant_owner-en-desktop')]}),{tenantId}),/Duplicate/);
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({results:[{...row('tenant_owner-en-desktop'),result:'observed'}]}),{tenantId}));
});
test('retained restricted executions must satisfy the exact one-execution, no-replay role ABI',()=>{
 const roles=['agent','auditor','supervisor','tenant_admin'];
 assert.equal(admitRetainedSecurityBusiness(fixture({restrictedExecutionObservations:roles.map(restricted)}),{tenantId}),iso);
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({restrictedExecutionObservations:roles.slice(1).map(restricted)}),{tenantId}));
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({restrictedExecutionObservations:roles.map(role=>({...restricted(role),noProviderReplay:false}))}),{tenantId}));
 assert.throws(()=>admitRetainedSecurityBusiness(fixture({restrictedExecutionObservations:roles.map(role=>({...restricted(role),eventIds:['e','e']}))}),{tenantId}));
});
