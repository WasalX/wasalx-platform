import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {currentMetaTransportBinding} from '../services/connector-worker/dist/services/connector-worker/src/meta-transport-binding.js';
import {simulationRuntimeRegistration,runtimeWithdrawalTarget} from '../scripts/release/meta-runtime-descriptor.mjs';
import {parseMetaActualRequestExecution,parseMetaMessageAdmissionV2,parseHistoricalEffectAssessment,assertMetaDirectTransportStartup} from '../packages/core/dist/meta-account-policy.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const id='12345678-1234-4234-8234-123456789012',tree='a'.repeat(40),revision='b'.repeat(40),digest='sha256:'+'c'.repeat(64),imageId='sha256:'+'d'.repeat(64);
test('runtime withdrawal targets only its retained receipt and fixed protected API',()=>{
 const input={platformOrigin:'https://control.example.invalid',receiptId:id};
 assert.equal(runtimeWithdrawalTarget(input,{receiptId:id}).pathname,`/platform/v1/operations/meta/runtime-evidence/${id}/withdraw`);
 for(const candidate of [{...input,receiptId:'00000000-0000-4000-8000-000000000001'},
  {...input,platformOrigin:'http://control.example.invalid'},{...input,output:'/another/file'},{...input,mode:'LIVE'}])
  assert.throws(()=>runtimeWithdrawalTarget(candidate,{receiptId:id}));
});
function actual(){
 const hosts="192.0.2.1 localhost\n192.0.2.1 graph.facebook.com\n";
 return{releaseBytes:JSON.stringify({schemaVersion:3,release:{sourceRevision:revision,sourceTree:tree},images:[{id:'connector-worker',digest}]}),
  stackBytes:JSON.stringify({kind:'exact-stack',clean:true,candidateSha:revision,candidateTree:tree,services:[{service:'connector-worker',imageId}],images:[{imageId:'sha256:'+'9'.repeat(64),repoDigests:['registry/simulator@sha256:'+'8'.repeat(64)]}]}),
  worker:{Path:'node',Args:['dist/services/connector-worker/src/bootstrap.js'],Config:{Env:[]},Image:imageId,State:{Running:true},Mounts:[{Destination:'/run/wasalx',Source:'/var/lib/wasalx/qualification/meta-runtime',RW:false}]},image:{Id:imageId,Config:{Labels:{'io.wasalx.source.tree':tree,'org.opencontainers.image.revision':revision}},RepoDigests:['registry/worker@'+digest]},
  simulator:{Image:'sha256:'+'9'.repeat(64),State:{Running:true},Config:{Cmd:['node','scripts/contracts/meta-simulation-server.mjs']},NetworkSettings:{Networks:{private:{IPAddress:"192.0.2.1"}}}},
  simulatorSourceSha256:'e'.repeat(64),expectedSimulatorSourceSha256:'e'.repeat(64),
  transport:{projection:{graphVersion:'v24.0',directStartupVerified:true,proxySha256:sha(JSON.stringify([null,null,null,null,null,null,null,null,null])),endpoint:'https://graph.facebook.com',hostsSha256:sha(hosts),extraCaSha256:'f'.repeat(64)},transportBindingSha256:'1'.repeat(64)},
  hosts,tenantId:id,accountId:id,graphVersion:'v24.0',expiresAt:'2026-10-08T01:00:00.000Z',now:new Date('2026-10-08T00:00:00.000Z')};
}
test('incumbent simulator on real Graph hostname produces only SIMULATED approval input',()=>{
 const result=simulationRuntimeRegistration(actual());assert.equal(result.mode,'SIMULATED');assert.equal(result.workerImageDigest,digest);assert.equal(result.transportBindingSha256,'1'.repeat(64));
 assert.equal(Object.hasOwn(result,'hostname'),false);assert.equal(Object.hasOwn(result,'NODE_ENV'),false);
});
test('source/image/route/TLS/version/expiry drift cannot create runtime approval',()=>{
 const mutations=[v=>{v.image.Config.Labels['io.wasalx.source.tree']='0'.repeat(40);},v=>{v.worker.Image='sha256:'+'0'.repeat(64);},
  v=>{v.worker.Mounts[0].RW=true;},v=>{v.image.RepoDigests=[];},v=>{v.simulatorSourceSha256='0'.repeat(64);},v=>{v.simulator.Config.Cmd=['node','another-server.mjs'];},
  v=>{v.simulator.State.Running=false;},v=>{v.hosts='127.0.0.1 graph.facebook.com\n';},v=>{v.transport.projection.extraCaSha256=null;},
  v=>{v.transport.projection.graphVersion='v99.0';},v=>{v.expiresAt='2026-10-10T00:00:00.000Z';}];
 for(const mutate of mutations){const input=actual();mutate(input);assert.throws(()=>simulationRuntimeRegistration(input));}
});
test('unknown runtime cannot acquire caller-selected receipt or transport evidence',()=>{
 assert.deepEqual(parseMetaActualRequestExecution({mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null}),
  {mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null});
 assert.throws(()=>parseMetaActualRequestExecution({mode:'UNKNOWN',runtimeEvidenceReceiptId:id,runtimeEvidenceSha256:'1'.repeat(64),transportBindingSha256:'2'.repeat(64)}));
});
test('genuine SQL NULL birth has NULL digest and UNKNOWN execution; no fabricated JSONB digest',()=>{
 const admission={schemaVersion:2,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:id,attemptNumber:1,deliveryId:id,admittedAt:'2026-10-08T00:00:00.000Z',
  requestSha256:'1'.repeat(64),birthDigest:null,snapshot:null,execution:{mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null},
  funding:{responseSha256:null,observedAt:null,expiresAt:null}};
 assert.deepEqual(parseMetaMessageAdmissionV2(admission),admission);
 assert.throws(()=>parseMetaMessageAdmissionV2({...admission,birthDigest:{format:'pg-jsonb-text-v1',sha256:'2'.repeat(64)}}));
 assert.throws(()=>parseMetaMessageAdmissionV2({...admission,execution:{mode:'SIMULATED',runtimeEvidenceReceiptId:id,runtimeEvidenceSha256:'2'.repeat(64),transportBindingSha256:'3'.repeat(64)}}));
 assert.deepEqual(parseHistoricalEffectAssessment({state:'UNKNOWN_ATTRIBUTION',reason:'NO_UNIQUE_SUCCESS'}),{state:'UNKNOWN_ATTRIBUTION',reason:'NO_UNIQUE_SUCCESS'});
});


test('known-success provider IDs reject C0 and DEL while retaining other Unicode',()=>{
 const admission={schemaVersion:2,claim:'MESSAGES_REQUEST_ADMITTED',attemptId:id,attemptNumber:1,deliveryId:id,admittedAt:'2026-10-08T00:00:00.000Z',
  requestSha256:'1'.repeat(64),birthDigest:null,snapshot:null,execution:{mode:'UNKNOWN',runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null},
  funding:{responseSha256:null,observedAt:null,expiresAt:null}};
 const effect={tenantId:id,deliveryId:id,attemptId:id,attemptNumber:1,externalMessageId:'wamid.safe',
  admissionDigest:{format:'pg-jsonb-text-v1',sha256:'2'.repeat(64)},correlation:'UNIQUE_KNOWN_SUCCESS'};
 for(const character of ['\u0000','\u001f','\u007f'])
  assert.throws(()=>parseHistoricalEffectAssessment({state:'ATTRIBUTED',effect:{...effect,externalMessageId:`wamid.${character}.end`},admission}));
 for(const externalMessageId of ['wamid.safe','wamid.\u0020.end','wamid.\u007e.end','wamid.\u0080.end','wamid.\u009f.end','wamid.\u{1F642}.end']){
  const historical={state:'ATTRIBUTED',effect:{...effect,externalMessageId},admission};
  assert.deepEqual(parseHistoricalEffectAssessment(historical),historical);
 }
});

test('direct simulator rejects environment or CLI proxy/dispatcher routes without disclosing values',()=>{
 assert.doesNotThrow(()=>assertMetaDirectTransportStartup({},[]));
 for(const env of [{NODE_USE_ENV_PROXY:'1'},{HTTPS_PROXY:'http://private-proxy.invalid'}, {https_proxy:'http://private-proxy.invalid'},
  {ALL_PROXY:'socks://private-proxy.invalid'},{NO_PROXY:'localhost'},{NODE_OPTIONS:'--use-env-proxy'}]){
  assert.throws(()=>assertMetaDirectTransportStartup(env,[]),error=>!error.message.includes('private-proxy'));
  const input=actual();input.worker.Config.Env=Object.entries(env).map(([key,value])=>`${key}=${value}`);
  assert.throws(()=>simulationRuntimeRegistration(input));
 }
 for(const arg of ['--use-env-proxy','--use-env-proxy=true','--import=custom-dispatcher.mjs','--require','-r']){
  assert.throws(()=>assertMetaDirectTransportStartup({},[arg]));
  const input=actual();input.worker.Args.unshift(arg);assert.throws(()=>simulationRuntimeRegistration(input));
 }
 const input=actual();input.transport.projection.proxySha256='0'.repeat(64);assert.throws(()=>simulationRuntimeRegistration(input));
});

test('worker transport rejects enabled proxy inputs before reading host evidence',async()=>{
 const previous=process.env.HTTPS_PROXY,originalArgs=[...process.execArgv];
 try{
  process.env.HTTPS_PROXY='http://private-proxy.invalid';
  await assert.rejects(()=>currentMetaTransportBinding('v24.0'),e=>!e.message.includes('private-proxy'));
  if(previous===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=previous;
  process.execArgv.push('--use-env-proxy');
  await assert.rejects(()=>currentMetaTransportBinding('v24.0'));
 }finally{
  if(previous===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=previous;
  process.execArgv.splice(0,process.execArgv.length,...originalArgs);
 }
});
