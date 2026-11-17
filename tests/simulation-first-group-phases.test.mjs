import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {seedSyntheticGroup,bindPreparedSyntheticGroup} from '../scripts/release/seed-simulation-group.mjs';
import {findPortalSupportTeam,assertPortalFixtureMachineTarget} from '../scripts/release/simulation-portal-groups.mjs';
import {assertTeamFixture} from '../scripts/release/simulation-team-stages.mjs';
import {assertMetaRuntimeBinding} from '../scripts/release/simulation-meta-producer.mjs';

const connectionId='00000000-0000-4000-8000-000000000001',ruleSetId='00000000-0000-4000-8000-000000000002',groupId='00000000-0000-4000-8000-000000000003';
const origin='http://127.0.0.1:32123',namespace='current',tenantId='tenant';
const prepared={evidenceMode:'simulated',preparationOnly:true,connectionId,connectionName:'Synthetic '+namespace,groupId,groupRef:'123@g.us',nativeGroupName:'Operations',ruleSetId,ruleName:'Synthetic '+namespace,ruleRevision:2,ruleSnapshotSha256:'a'.repeat(64),receipts:[{step:'connection',key:'synthetic-current-connection',id:connectionId}]};
function seedFixture(){
 const calls=[],rows=[];let active=false;
 const request=async(path,method='GET',body)=>{
  calls.push({path,method,body});
  if(path==='/api/connections')return{id:connectionId,operation:{id:'provision'}};
  if(path==='/api/connections/'+connectionId)return{name:prepared.connectionName,provider:'WAHA',provider_state:'WORKING',latest_operation_state:'SUCCEEDED',latest_operation_id:'sync'};
  if(path.endsWith('/groups/sync'))return{operation:{id:'sync'}};
  if(path.startsWith('/api/groups?'))return[{id:groupId,connection_id:connectionId,external_group_id:prepared.groupRef}];
  if(path==='/api/rules')return{id:ruleSetId};
  if(path==='/api/rule-sets?limit=200')return[{id:ruleSetId,name:prepared.ruleName,state:active?'ACTIVE':'DRAFT',revision:active?'2':'1',snapshot_sha256:prepared.ruleSnapshotSha256}];
  if(path.endsWith('/activate')){assert.equal(body.expectedRevision,1);active=true;return{};}
  throw Error('Preparation attempted native binding or another unexpected operation');
 };
 return{calls,rows,options:{origin,runId:namespace,externalGroupId:prepared.groupRef,nativeGroupName:'Operations',evidenceMode:'simulated',prepareOnly:true,request,assertRequestActor:async()=>{},assertIsolatedRuntime:async()=>{},checkpoint:async row=>rows.push(row)}};
}
function bindingFixture({stale=false,authorized=true,existing=false,unknown=false}={}){
 const calls=[],rows=[];let bound=existing;
 const page={url:()=>origin+'/app',evaluate:async(fn,a)=>{
  calls.push(a);
  if(a.path==='/api/connections/'+connectionId)return{name:prepared.connectionName,provider:'WAHA',provider_state:'WORKING',latest_operation_state:'SUCCEEDED'};
  if(a.path.startsWith('/api/groups?'))return[{id:groupId,connection_id:connectionId,external_group_id:prepared.groupRef}];
  if(a.path==='/api/rule-sets?limit=200')return[{id:ruleSetId,name:prepared.ruleName,state:'ACTIVE',revision:stale?'3':'2',snapshot_sha256:prepared.ruleSnapshotSha256}];
  if(a.path==='/api/zammad/routing-catalogs')return{groups:[{id:'7',name:'Operations',active:true,serviceIdentityCanCreate:authorized}]};
  if(a.path.endsWith('/binding')){
   if(a.method==='PUT'){assert.equal(a.body.zammadGroupId,'7');if(unknown)throw Error('Original binding response lost');bound=true;return{};}
   return bound?{binding_id:'binding',binding_state:'ACTIVE',rule_set_id:ruleSetId,zammad_group_id:7,binding_revision:'1'}:{binding_id:null};
  }
  throw Error('Unexpected binding request');
 }};
 return{calls,rows,options:{page,origin,runId:namespace,prepared,nativeGroupId:'7',assertIsolatedRuntime:async()=>{},checkpoint:async row=>rows.push(row)}};
}
async function ownedTemp(run){const dir=await mkdtemp(join(tmpdir(),'wasalx-first-group-'));try{return await run(dir);}finally{assert.equal(await realpath(dir),dir);await rm(dir,{recursive:true});}}
function access(){return{surface:'portal',namespace,tenantId,nativeGroupId:'7',machineGrant:{surface:'portal',enabled:true,teamId:'7',kind:'IDENTITY_GRANT',requestId:'00000000-0000-4000-8000-000000000004',state:'APPLIED',terminal:true}};}
function stageFixture(dir){
 const prefix={evidenceMode:'simulated',preparationOnly:true,namespace,tenantId,connectionId,groupId,groupRef:prepared.groupRef,nativeGroupName:'Operations',prepared:structuredClone(prepared),fixtureDisposition:'retain-run-owned'};
 const inputs={groupPreparation:prefix,portalTeamAccess:access(),nativeAccountAccess:{namespace,tenantId},teamAccess:{namespace,tenantId}};
 const checkpoints=[],s={operatorSurface:'portal',model:{name:'wasalx-simulation-unit'},tenantId,ownerId:'owner',privateDir:dir,output:dir,ownerPage:{url:()=>origin+'/app',evaluate:async()=>({binding_id:'binding',binding_state:'ACTIVE',rule_set_id:ruleSetId,zammad_group_id:7,binding_revision:'1'})},portalOrigin:origin,containers:{'waha-gows':{}},verifyOwner:async()=>({userMatched:true,workspaceMatched:true}),ensurePrivilegedOwner:async()=>{},scoped:async()=>[],checkpoint:async row=>checkpoints.push(row)};
 return{s,inputs,prefix,checkpoints};
}

test('preparation settles connection discovery and active rule without native catalog binding or inbound effects',async()=>{
 const f=seedFixture(),result=await seedSyntheticGroup(f.options);assert.equal(result.preparationOnly,true);assert.equal(result.ruleRevision,2);assert.equal(result.nativeGroupName,'Operations');assert.equal(result.groupRef,prepared.groupRef);
 assert(!Object.hasOwn(result,'bindingId'));assert(!Object.hasOwn(result,'ticketId'));assert(!f.calls.some(row=>row.path.includes('routing-catalogs')||row.path.endsWith('/binding')));assert.deepEqual(f.calls.filter(row=>row.method!=='GET').map(row=>row.path),['/api/connections','/api/connections/'+connectionId+'/groups/sync','/api/rules','/api/rule-sets/'+ruleSetId+'/activate']);
 assert.deepEqual(f.rows.filter(row=>row.phase==='intent').map(row=>row.step),['connection','sync','rule','activate']);
});

test('post-grant binding rechecks exact immutable preparation and authorized selected target before one write',async()=>{
 const f=bindingFixture(),before=structuredClone(prepared),result=await bindPreparedSyntheticGroup(f.options);assert.deepEqual(prepared,before);assert.equal(result.bindingId,'binding');assert.equal(result.evidenceMode,'simulated');assert.equal(f.calls.filter(row=>row.method==='PUT').length,1);assert.equal(result.receipts.at(-1).step,'bind');assert.equal(result.receipts[0].step,'connection');assert.notEqual(result.receipts,prepared.receipts);assert.deepEqual(f.rows.map(row=>row.phase),['intent','accepted']);
});
for(const [reason,options]of[['stale source',{stale:true}],['ungranted target',{authorized:false}],['existing binding',{existing:true}]])test(`prepared binding rejects ${reason} before a write`,async()=>{const f=bindingFixture(options);await assert.rejects(()=>bindPreparedSyntheticGroup(f.options));assert.equal(f.calls.filter(row=>row.method==='PUT').length,0);});
test('uncertain original binding is attempted once and its intent remains recorded',async()=>{const f=bindingFixture({unknown:true});await assert.rejects(()=>bindPreparedSyntheticGroup(f.options),/Original binding response lost/);assert.equal(f.calls.filter(row=>row.method==='PUT').length,1);assert.deepEqual(f.rows.map(row=>row.phase),['intent','synthetic-request-failed']);});

test('declared Operations team is exact and uniquely active across the complete portal catalog',async()=>{
 const calls=[],result=await findPortalSupportTeam(async(operation,input)=>{calls.push({operation,input});return input.before?{items:[{id:'7',name:'Operations',active:true}],next_cursor:null}:{items:[{id:'8',name:'Elsewhere',active:true}],next_cursor:'second'};},{name:'Operations'});assert.equal(result.id,'7');assert.deepEqual(calls.map(row=>row.input),[{limit:100},{limit:100,before:'second'}]);
 await assert.rejects(()=>findPortalSupportTeam(async()=>({items:[],next_cursor:null}),{name:'Operations'}),/uniquely active/);
 await assert.rejects(()=>findPortalSupportTeam(async()=>({items:[{id:'7',name:'Operations',active:true},{id:'9',name:'Operations',active:true}],next_cursor:null}),{name:'Operations'}),/uniquely active/);
 await assert.rejects(()=>findPortalSupportTeam(async()=>({items:[],next_cursor:'repeat'}),{name:'Operations'}),/cursor repeated/);
});

test('current Team3 require preparation, while retained callers preserve their canonical group input',()=>{
 const prefix={namespace,tenantId,connectionId,groupId,groupRef:prepared.groupRef},s={operatorSurface:'portal',model:{name:'wasalx-simulation-unit'},tenantId,actorBinding:{userMatched:true,workspaceMatched:true}};
 assert.equal(assertTeamFixture(s,namespace,{groupPreparation:prefix}),prefix);assert.throws(()=>assertTeamFixture(s,namespace,{group:prefix}));assert.equal(assertTeamFixture({...s,operatorSurface:undefined},namespace,{group:prefix}),prefix);
});

function driverFixture(dir,{unknown=false,duplicateDrift=false,configureFailure=false}={}){
 let sent=0,disposed=0,configured=0;const inputs=[],inboxId='00000000-0000-4000-8000-000000000005',hash='a'.repeat(64);
 const db={query:async sql=>{let rows=[];if(sent&&sql.includes('FROM normalized_messages'))rows=[{id:'message',processing_status:'COMPLETE'}];if(sent&&sql.includes('FROM message_links'))rows=[{id:'link',zammad_ticket_id:'71'}];if(sent&&sql.includes('FROM event_inbox'))rows=[{id:inboxId,status:'PROCESSED',attempts:duplicateDrift&&sent>1?2:1,lease_id:null,processed_at:'2026-10-18T00:00:00Z',payload_sha256:hash}];return{rows};}};
 const options={ownerPage:{},db,tenantId,socketPath:'/owned/sim.sock',candidate:{sha:'a'.repeat(40),tree:'b'.repeat(40)},seed:{runId:namespace,externalGroupId:prepared.groupRef,participant:'12025550106@c.us'},checkpoint:async()=>{},evidencePath:join(dir,'driver.json'),assertIsolatedRuntime:async()=>{},auth:{restoreFactor:async()=>({status:'verified',dispose(){disposed++;}})},configure:async()=>{configured++;if(configureFailure)throw Error('Binding outcome unknown');return{evidenceMode:'simulated',connectionId,groupId,ruleSetId,bindingId:'binding'};},control:async command=>{sent++;inputs.push(command);if(unknown)throw Error('Inbound response lost');return{bodySha256:hash,results:[{status:200,receipt:{accepted:true,duplicate:sent>1,event_id:inboxId}}]};},nativeRead:async()=>({ticketId:71,number:'4401',markerArticleIds:[72]}),renderNativeProof:async()=>null};
 return{options,counts:()=>({sent,disposed,configured}),inputs};
}

test('Meta current target admission rejects ungranted or different destinations before ingress; legacy runtime binding is preserved',()=>{
 const b={project:'wasalx-simulation-unit',tenantId,connectionId,phoneId:'10001',wabaId:'10002',graphContainerId:'container',graphImageDigest:'sha256:'+'a'.repeat(64),graphSourceSha256:'b'.repeat(64),controlSocket:'/private/meta.sock'},f={runtimeBinding:b,connectionId},h={binding:b,cfg:{zammadGroupId:'7',binding:{phoneId:b.phoneId,wabaId:b.wabaId}},nativeTeamAccess:access()},s={model:{name:b.project},tenantId,operatorSurface:'portal'};
 assertMetaRuntimeBinding(f,h,s);assert.throws(()=>assertMetaRuntimeBinding(f,{...h,cfg:{...h.cfg,zammadGroupId:'8'}},s),/differs/);assert.throws(()=>assertMetaRuntimeBinding(f,{...h,nativeTeamAccess:undefined},s));assertMetaRuntimeBinding(f,{...h,nativeTeamAccess:undefined},{...s,operatorSurface:undefined});
 assert.throws(()=>assertPortalFixtureMachineTarget(s,{namespace,access:access(),nativeGroupId:'8'}),/differs/);assert.throws(()=>assertPortalFixtureMachineTarget(s,{namespace:'foreign',access:access(),nativeGroupId:'7'}));
});
test('current Meta and selected BSUID targets are admitted before durable claims and provider writes',async()=>{
 const meta=await readFile(new URL('../scripts/release/simulation-meta-producer.mjs',import.meta.url),'utf8'),bsuid=await readFile(new URL('../scripts/release/simulation-portal-meta-bsuid-stage.mjs',import.meta.url),'utf8');
 const target=meta.indexOf('h.nativeTeamAccess=assertPortalFixtureMachineTarget');assert(target>0&&target<meta.indexOf('const claim=await open'));assert(target<meta.indexOf('await runMetaTextVertical('));
 const selected=bsuid.indexOf('assertPortalFixtureMachineTarget(s,{namespace,access:inputs.portalTeamAccess,nativeGroupId:config.expectedHandoff.groupId})');assert(selected>0&&selected<bsuid.indexOf("const claim=await open(join(s.privateDir,'meta-bsuid-'+namespace+'.claim.json')"));assert(selected<bsuid.indexOf('const asset=await uploadPinnedAsset'));
});
