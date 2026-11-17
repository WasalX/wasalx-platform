import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {restrictedExecutionTarget} from '../scripts/release/simulation-security-boundaries.mjs';

const source=readFileSync(new URL('../scripts/release/simulation-security-boundaries.mjs',import.meta.url),'utf8');
test('restricted execution target requires the validated direct fixture and exactly one retained execution',async()=>{
 const calls=[],s={tenantId:'tenant',scoped:async(sql,params)=>{calls.push(params);return s.rows;}},direct={sourceRunId:undefined,evidenceMode:'simulated'};
 await assert.rejects(restrictedExecutionTarget({...s,rows:[{id:'e'}]},direct,'now'));assert.equal(calls.length,0,'Invalid direct fixture must stop before the execution read');
});
test('restricted executions bind each role through verified tenant evidence, the shared role wave and no-replay ABI',()=>{
 for(const fragment of ["verifyTenantEvidence(s,page,agent.userId,role,s.tenantId,subject)","observeRetainedExecution({page,origin:s.portalOrigin,...target,verifyActor:()=>actor(page,role)})","rebindRole:(page,role)=>rebindSimulationRole(s,capability,page,role)","restrictedExecutionResults(observations);return observations;","assert(wave.proofs.every(proof=>proof.passed&&proof.actorVerified)","role:'tenant_owner',actorRef:digest(s.ownerId),tenantRef:digest(s.tenantId),actorVerified:true"])assert(source.includes(fragment),fragment);
 assert(!source.includes('actorRef:agent.userId'));assert(!/simulation-direct-quality-contexts|simulation-native-/u.test(source),'No retired native modules');
 assert(source.includes("args.inputs.directFlow===undefined?undefined:await observeRestrictedExecutions("),'Restricted rows exist only when the declared direct input is present');
});
const detail=suffix=>({testId:'security/tenant-isolation::'+suffix,result:'passed',startedAt:'2026-10-29T10:00:00.000Z',finishedAt:'2026-10-29T10:00:01.000Z',proof:{containerId:'c',scope:'compiled'}});
const page=size=>({size,viewportSize(){return this.size},async setViewportSize(value){this.size=value},evaluate:async()=>'en'});
function ownerSession(){const ownerPage=page({width:1440,height:1000});return{tenantId:'tenant',ownerId:'owner',ownerPage,verifyOwner:async()=>({userMatched:true,workspaceMatched:true})};}
