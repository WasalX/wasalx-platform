import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {collectIndependentQualityObservers} from '../scripts/release/simulation-team-stages.mjs';

test('role wave denies access changes without exercising allowed number updates',async()=>{
  const source=await readFile(new URL('../scripts/release/simulation-team-stages.mjs',import.meta.url),'utf8');
  assert.match(source,/'own-access-denial'/);
  assert.match(source,/\{role,state:before\.state,expectedVersion:Number\(before\.version\)\}/);
  assert.doesNotMatch(source,/'own-number-denial'/);
});

test('shared quality collection does not stop later observers on a behavioral failure',async()=>{
  const source=await readFile(new URL('../scripts/release/simulation-team-stages.mjs',import.meta.url),'utf8'),wave=await readFile(new URL('../scripts/release/simulation-team-role-wave.mjs',import.meta.url),'utf8');
  const observer=source.slice(source.indexOf('observeRole:async'),source.indexOf('additional:async'));
  const calls=[],connection=[{result:'failed'}],navigation=[{result:'passed'}],collected=await collectIndependentQualityObservers({connection:async()=>{calls.push('connection');return connection},navigation:async()=>{calls.push('navigation');return navigation},navigationZoom:async()=>{calls.push('navigation-zoom');return[{result:'passed'}]},onFailure:async()=>assert.fail('Behavior rows are not observer exceptions')});calls.push('security');
  assert.deepEqual(calls,['connection','navigation','navigation-zoom','security']);assert.equal(collected.connection,connection);assert.equal(collected.navigation,navigation);assert.deepEqual(collected['navigation-zoom'],[{result:'passed'}]);
  assert.match(observer,/collectIndependentQualityObservers/);
  assert.doesNotMatch(observer,/connectionRows\.every|navigationRows\.every/);
  assert.doesNotMatch(source,/Shared quality behavior failed|Incomplete connection context collection|Incomplete navigation context collection/);
  assert(source.includes("const observerViews=selection?remoteViewports:remoteViewports.filter(view=>view.name!=='mobile');"));assert(source.includes('observerViews.filter(view=>'));assert(source.includes('selection=retained||checks?.length||dependencyChecks.length?teamRoleObserverPlan('));
  assert(wave.indexOf('proof.observation=await observeRole')<wave.indexOf('stage="team-read"'));assert.doesNotMatch(wave,/assert\([^\n]*proof\.observation/);
});

test('observer exception is isolated from the independent observer',async()=>{const calls=[],failures=[],collected=await collectIndependentQualityObservers({connection:async()=>{calls.push('connection');throw Error('connection')},navigation:async()=>{calls.push('navigation');return[{result:'passed'}]},onFailure:async(name,error)=>failures.push([name,error.message])});assert.deepEqual(calls,['connection','navigation']);assert.deepEqual(failures,[['connection','connection']]);assert.equal(collected.connection,null);assert.deepEqual(collected.navigation,[{result:'passed'}]);});

import {runRolePermissionWave} from '../scripts/release/simulation-team-role-wave.mjs';
import {privateErrorSummary} from '../scripts/release/simulation-manifest.mjs';
import {createHash} from 'node:crypto';
test('role observer failure retains safe original summary and phase while restoring actor',async()=>{
const checkpoints=[],owner={id:'owner-member',user_id:'owner',role:'tenant_owner',state:'ACTIVE',version:1,whatsapp_numbers:[]},original={id:'member',user_id:'actor',role:'agent',state:'ACTIVE',version:1,whatsapp_numbers:[]};let member={...original};
const ownerContext={},memberContext={},ownerPage={context:()=>ownerContext,evaluate:async(fn,args)=>{if(args.path==='/api/team')return{members:[{...owner,is_current_user:true}]};assert.equal(args.path,'/api/team/members/member');assert.equal(args.body.expectedVersion,member.version);member={...member,role:args.body.role,state:args.body.state,version:member.version+1};return{...member};}},memberPage={context:()=>memberContext,reload:async()=>{},viewportSize:()=>({width:1440,height:1000})};
const thrown=Error('PRIVATE_OBSERVER_CONTENT');thrown.qualificationOperation='workflow-lifecycle-select-original';
const actual=await runRolePermissionWave({ownerPage,memberPage,origin:'http://portal',runId:'unit-only',tenantId:'tenant',memberId:'member',roles:['tenant_admin'],checkpoint:async row=>checkpoints.push(row),assertIsolatedRuntime:async()=>{},assertActor:async(page,{role})=>({userId:page===ownerPage?'owner':'actor',role,actorRef:page===ownerPage?'owner-ref':'actor-ref',tenantRef:'tenant-ref',actorVerified:true,locale:'en'}),readMember:async id=>id==='owner-member'?owner:({...member}),rebindRole:async()=>{},observeRole:async({role})=>{if(role==='tenant_admin')throw thrown;return{restoredAgent:true}},additional:async()=>({}),readAudit:async()=>({matched:true})});
assert.equal(actual.proofs.length,1);assert.equal(actual.proofs[0].passed,false);assert.equal(actual.proofs[0].stage,'role-observer');assert.equal(actual.proofs[0].failure.errorClass,'Error');assert.equal(actual.proofs[0].failure.messageSha256,createHash('sha256').update(thrown.message).digest('hex'));assert.equal(actual.proofs[0].failure.operation,'workflow-lifecycle-select-original');assert.equal(member.role,'agent');assert(actual.restored);assert(!JSON.stringify(checkpoints).includes('PRIVATE_OBSERVER_CONTENT'));assert.equal(checkpoints.filter(row=>row.phase==='proof')[0].failure.messageSha256,actual.proofs[0].failure.messageSha256);
thrown.qualificationOperation='workflow-lifecycle-select-PRIVATE';assert.equal(privateErrorSummary(thrown,new Map()).operation,undefined);
});
