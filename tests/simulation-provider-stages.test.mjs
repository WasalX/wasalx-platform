import test from 'node:test';
import assert from 'node:assert/strict';
import {directFlowStage,metaStatusStage,portalDirectFlowStage,portalDirectFlowIds} from '../scripts/release/simulation-provider-stages.mjs';
import {metaStatusEnvelope,runMetaPricingCorrection} from '../scripts/release/simulation-meta-status.mjs';
import {createHmac} from 'node:crypto';

test('existing Meta status stage emits one signed same-time correction and verifies durable evidence without a new send',async()=>{
 const secret='synthetic-status-secret',payload=metaStatusEnvelope({wabaId:'98765',phoneId:'12345',id:'wamid.synthetic',recipient:'12025550106',status:'delivered',timestamp:1786291200,pricing:{billable:false,pricing_model:'PMP',category:'service',type:'free_customer_service'}});
 for(const state of ['READ','DELIVERED']){
  const posts=[];
  const input={tenantId:'t',connectionId:'c',deliveryId:'d',payload,cfg:{appSecret:secret},
   postRaw:async(path,bytes,headers)=>{assert.equal(path,'/webhooks/meta');assert.equal(headers['x-hub-signature-256'],'sha256='+createHmac('sha256',secret).update(bytes).digest('hex'));const actual=JSON.parse(bytes),status=actual.entry[0].changes[0].value.statuses[0];assert.equal(status.id,'wamid.synthetic');assert.equal(status.timestamp,'1786291200');assert.deepEqual(status.pricing,{billable:true,pricing_model:'PMP',category:'service',type:'regular'});posts.push(actual);return{status:200,receipt:posts.length===1?{count:1}:{duplicates:1}};},
   scoped:async(sql,args)=>{assert.deepEqual(args,['t','c','d']);return sql.includes('delivery_receipts')?[false,true].map((billable,index)=>({meta_pricing_state:'VALID',meta_pricing_billable:billable,meta_pricing_revision_sha256:String(index).repeat(64),applied_state:billable?'IGNORED':'DELIVERED',inbox_state:'PROCESSED'})):[{state,attempts:1,external_message_id:'wamid.synthetic'}];},
   poll:async(read,ready)=>{const value=await read();assert(ready(value));return value;}};
  if(state==='READ'){const result=await runMetaPricingCorrection(input);assert.equal(result.claim,'PRICING_OBSERVATIONS_ONLY');assert.equal(posts.length,2);}
  else await assert.rejects(()=>runMetaPricingCorrection(input));
 }
 assert.equal(payload.entry[0].changes[0].value.statuses[0].pricing.billable,false,'Source receipt remains unchanged');
});
const session=()=>({actorBinding:{userMatched:true,workspaceMatched:true},model:{name:'wasalx-simulation-test'},tenantId:'tenant-a',ownerPage:new Proxy({},{get(){assert.fail('Browser/auth must not be touched');}}),portalOrigin:'http://127.0.0.1:3000',socketPath:'/private/socket',scoped:()=>assert.fail('DB must not be touched'),checkpoint:()=>assert.fail('Effects must not be touched')});
test('missing producer fixtures fail before browser/database/effects',async()=>{for(const fn of [directFlowStage,metaStatusStage,portalDirectFlowStage])await assert.rejects(fn(session(),{namespace:'next',inputs:{},config:{}}));});
test('cross-tenant fixture cannot override trusted session identity',async()=>{await assert.rejects(metaStatusStage(session(),{namespace:'next',inputs:{metaDeliveries:{evidenceMode:'simulated',provider:'META',tenantId:'other',connectionId:'c',deliveries:[{deliveryId:'d',externalMessageId:'wamid.x',recipient:'12025550106'}]}}}));});
test('direct requires admitted native/settlement callbacks before request construction',async()=>{await assert.rejects(directFlowStage(session(),{namespace:'next',inputs:{directConnection:{evidenceMode:'simulated',provider:'WAHA',tenantId:'tenant-a',connectionId:'c',zammadGroupId:'2'}},config:{chatIds:['12025550106@c.us','12025550104@c.us'],finalAssignmentState:'PAUSED'}}),/Missing admitted callback nativeRead/);});
test('direct requires the returning native UI observer before request construction',async()=>{const s=session();s.directCallbacks=Object.fromEntries(['nativeRead','providerRead','drainEffects','assertIsolatedRuntime','control'].map(name=>[name,()=>assert.fail(name+' must not run')]));await assert.rejects(directFlowStage(s,{namespace:'next',inputs:{directConnection:{evidenceMode:'simulated',provider:'WAHA',tenantId:'tenant-a',connectionId:'c',zammadGroupId:'2'}},config:{chatIds:['12025550106@c.us','12025550104@c.us'],finalAssignmentState:'PAUSED'}}),/Missing admitted callback observeReturningTicket/);});
test('mismatched provider socket or session is rejected before isolation callback and effects',async()=>{
 const binding={project:'wasalx-simulation-test',connectionId:'c',providerSessionId:'session-a',containerId:'container-a',imageId:'sha256:image-a',socketPath:'/private/socket'};
 for(const field of ['socketPath','providerSessionId','containerId','connectionId']){
  const s=session();s.containers={'waha-gows':{Id:binding.containerId,Image:binding.imageId}};
  s.directCallbacks={binding,control(){assert.fail();},nativeRead(){assert.fail();},observeReturningTicket(){assert.fail();},providerRead(){assert.fail();},drainEffects(){assert.fail();},assertIsolatedRuntime(){assert.fail('Mismatch must fail before runtime callback');}};
  await assert.rejects(directFlowStage(s,{namespace:'next',inputs:{directConnection:{evidenceMode:'simulated',provider:'WAHA',tenantId:s.tenantId,connectionId:'c',zammadGroupId:'2',runtimeBinding:{...binding,[field]:'wrong'}}},config:{chatIds:['12025550106@c.us','12025550104@c.us'],finalAssignmentState:'PAUSED'}}),/WAHA fixture\/callback mismatch/);
 }
});

test('current direct portal stage requires exact one-way admission and target grant before business dispatch',async()=>{const s=session();s.operatorSurface='portal';const inputs={directConnection:{tenantId:s.tenantId,namespace:'next',zammadGroupId:'2'},nativeAccountAccess:{tenantId:s.tenantId,namespace:'next',results:[]},portalTeamAccess:{tenantId:s.tenantId,namespace:'next'}};await assert.rejects(()=>portalDirectFlowStage(s,{namespace:'next',inputs,config:{}}),/owner-approved/);for(const key of Object.keys(inputs)){const altered=structuredClone(inputs);altered[key].namespace='old';await assert.rejects(()=>portalDirectFlowStage(s,{namespace:'next',inputs:altered,config:{}}),/namespace required/);}assert.equal(portalDirectFlowIds.length,3);assert.equal(new Set(portalDirectFlowIds).size,3);assert(portalDirectFlowIds.every(id=>id.endsWith('::portal')));});
