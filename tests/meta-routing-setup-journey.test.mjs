import test from 'node:test';
import assert from 'node:assert/strict';
import {proveSignedMetaPrimaryRouting,captureRoutingObservation,prepareRoutingHandoff} from '../scripts/release/meta-routing-setup-journey.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const setup={evidenceMode:'simulated',claim:'OBSERVED_AWAITING_THREAD',ownershipGranted:false,tenantId:id(1),connectionId:id(2),sessionId:id(3),configurationVersion:1,reviewVersion:1};
const hashes={rawSha256:'a'.repeat(64),payloadSha256:'b'.repeat(64)};
const observed={ordinarySourceProcessed:true,tenantId:id(1),messageId:'wamid.synthetic.routing.initial',...hashes,nativeCompleted:true,connectionId:id(2),sessionId:id(3),configurationVersion:1,reviewVersion:1,category:'PRIMARY_MESSAGE',claim:'OWN',allowed:true,
 epoch:1,participantId:id(4),sourceEventId:id(5),aliasSourceEventId:id(5),ownershipSourceEventId:id(5),ordinaryNormalizedCount:1,nativeSourceLinkCount:1,
 importAuthorityUsed:false,internalControlMutatedByRouting:false};
// Orchestration negatives only. These doubles are never application-stack proof.
test('routing journey requires exact signed ordinary persisted lineage after one dispatch',async()=>{
 let sends=0;const phases=[];
 const invoke=change=>proveSignedMetaPrimaryRouting({setup,...hashes,messageId:'wamid.synthetic.routing.initial',assertAdmission:async()=>{},checkpoint:async row=>phases.push(row.phase),
  dispatchPrimary:async()=>{sends++;return{status:200,receipt:{accepted:true,count:1,duplicates:0,unrouted:0}}},
  readPrimary:async()=>({...observed,...change}),poll:async(read,accept)=>{const row=await read();assert(accept(row));return row}});
 const proof=await invoke({});assert.equal(sends,1);assert.equal(proof.liveProviderEvidence,false);assert.equal(proof.authoritySource,'SIGNED_ORDINARY_MESSAGE');
 for(const change of [{tenantId:id(9)},{messageId:'wamid.synthetic.stale.initial'},{rawSha256:'f'.repeat(64)},{payloadSha256:'f'.repeat(64)},{nativeCompleted:false},
  {category:'STANDBY_MESSAGE'},{claim:'UNKNOWN'},{sessionId:id(9)},{reviewVersion:2},{aliasSourceEventId:id(9)},
  {ownershipSourceEventId:id(9)},{ordinaryNormalizedCount:2},{nativeSourceLinkCount:0},{importAuthorityUsed:true},{internalControlMutatedByRouting:true}]){
  const before=sends;await assert.rejects(invoke(change));assert.equal(sends,before+1,'failure must never dispatch a second time');
 }
 assert(phases.includes('routing-primary-readback'));
});
test('admission loss and ambiguous dispatch cannot be repaired by replay',async()=>{
 let sends=0,reads=0;
 const options={setup,...hashes,messageId:'wamid.synthetic.routing.initial',checkpoint:async()=>{},
  dispatchPrimary:async()=>{sends++;throw Error('unknown response')},readPrimary:async()=>{reads++;return observed},poll:async read=>read()};
 await assert.rejects(proveSignedMetaPrimaryRouting({...options,assertAdmission:async()=>{throw Error('lease expired')}}));assert.equal(sends,0);assert.equal(reads,0);
 await assert.rejects(proveSignedMetaPrimaryRouting({...options,assertAdmission:async()=>{}}));assert.equal(sends,1);assert.equal(reads,0);
 await assert.rejects(proveSignedMetaPrimaryRouting({...options,setup:{...setup,evidenceMode:'live'},assertAdmission:async()=>{}}));assert.equal(sends,1);
});
test('observation acquisition follows a fractional declaration without future/backdated evidence',async()=>{
 let now=Date.parse('2026-10-08T08:10:00.123Z'),admissions=0,observations=0;const waits=[];
 const declaredAt=new Date(now).toISOString();
 const value=await captureRoutingObservation({declaredAt,now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;},
  assertAdmission:async()=>{admissions++;},observe:async()=>{observations++;return{disposition:'REVIEWED'}}});
 assert.equal(value.observedAt,'2026-10-08T08:11:00.000Z');assert.deepEqual(waits,[59877]);assert.equal(admissions,1);assert.equal(observations,1);
 await assert.rejects(captureRoutingObservation({declaredAt:new Date(now+1).toISOString(),now:()=>now,observe:async()=>{observations++;},assertAdmission:async()=>{}}));
 await assert.rejects(captureRoutingObservation({declaredAt,now:()=>now,observe:async()=>{observations++;},assertAdmission:async()=>{throw Error('lease expired')}}));
 assert.equal(observations,1,'No observation/platform post may follow time or admission failure');
});
test('handoff setup uses one fixed no-send flow and cannot overwrite an assignment or continue after uncertain creation',async()=>{
 const calls=[];let assigned=false;
 const request=async(path,method='GET',body)=>{
  calls.push({path,method,body});if(method==='GET')return assigned?[{id:id(7),connection_id:id(2),flow_version_id:id(6),state:'ACTIVE',zammad_group_id:'3'}]:[];
  if(path==='/api/bot-flows')return{id:id(6),familyId:id(8),revision:1};
  if(path.endsWith('/activate'))return{};assigned=true;return{assignmentId:id(7)};
 };
 const input={request,assertAdmission:async()=>{},connectionId:id(2),nativeGroupId:'3',namespace:'routing-case'};
 await prepareRoutingHandoff(input);assert.equal(calls.filter(c=>c.method==='POST').length,3);
 assert.deepEqual(calls.find(c=>c.path==='/api/bot-flows').body.nodes,[{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]);
 const count=calls.length;await assert.rejects(prepareRoutingHandoff(input));assert.equal(calls.length,count+1);
 let effects=0;await assert.rejects(prepareRoutingHandoff({...input,request:async(_path,method='GET')=>{
  if(method==='GET')return[];effects++;throw Error('original outcome unavailable');
 }}));assert.equal(effects,1);
 await assert.rejects(prepareRoutingHandoff({...input,assertAdmission:async()=>{throw Error('expired')}}));assert.equal(effects,1);
});
