import assert from 'node:assert/strict';import test from 'node:test';import {createHash} from 'node:crypto';
import {MetaCostSourceService,MetaCostSourceError} from '../services/connector-worker/dist/services/connector-worker/src/meta-cost-source.js';
import {MediaRuntimeError,S3MediaStorage} from '../services/connector-worker/dist/services/connector-worker/src/media-runtime.js';
const tenant='31000000-0000-4000-8000-000000000001',id='31000000-0000-4000-8000-000000000002',bytes=new TextEncoder().encode('{"synthetic":"statement"}');
const hash=data=>createHash('sha256').update(data).digest('hex');
function fixture(){
 const calls=[],reserved={id,tenantId:tenant,objectKey:`tenants/${tenant}/meta-cost-sources/${id}/${hash(bytes)}.bin`,sha256:hash(bytes),byteSize:bytes.length,mimeType:'application/json',version:1,sourceState:'RESERVED',writeAttemptId:null};
 const repository={reservation:async()=>({...reserved}),readable:async()=>({...reserved,sourceState:'READY'}),
  admit:async(t,s,v,attempt,scan)=>{calls.push({step:'admit',attempt,scan});assert.equal(v,reserved.version);Object.assign(reserved,{version:2,writeAttemptId:attempt,sourceState:'UPLOADING'});return{...reserved};},
  settle:async(t,s,attempt,outcome,scan)=>{calls.push({step:'settle',attempt,outcome,scan});reserved.sourceState=outcome==='WRITTEN'?'READY':'UNKNOWN';return{state:reserved.sourceState};},
  reject:async()=>{calls.push({step:'reject'});return{state:'REJECTED'};}};
 const scanner={scan:async()=>{calls.push({step:'scan'});return{state:'CLEAN',engine:'synthetic-scanner'};}};
 const storage={put:async()=>{calls.push({step:'put'});},get:async()=>bytes};
 return{calls,reserved,repository,scanner,storage,service:()=>new MetaCostSourceService(repository,scanner,storage)};
}
test('exact bytes and clean scan precede one durable admitted PUT; repeated ready request does not write again',async()=>{
 const f=fixture();assert.deepEqual(await f.service().upload(tenant,id,bytes,'application/json'),{id,state:'READY'});
 assert.deepEqual(f.calls.map(x=>x.step),['scan','admit','put','settle']);assert.equal(f.calls[1].scan,f.calls[3].scan);assert.match(f.calls[1].scan,/^[a-f0-9]{64}$/);
 await f.service().upload(tenant,id,bytes,'application/json');assert.equal(f.calls.filter(x=>x.step==='put').length,1);
});
test('wrong scope/integrity or rejected scan cannot reach a storage write',async()=>{
 for(const change of ['hash','tenant','key','scan']){const f=fixture();if(change==='hash')f.reserved.sha256='0'.repeat(64);if(change==='tenant')f.reserved.tenantId=id;if(change==='key')f.reserved.objectKey='another/key';if(change==='scan')f.scanner.scan=async()=>({state:'INFECTED',engine:'synthetic-scanner'});
  await assert.rejects(()=>f.service().upload(tenant,id,bytes,'application/json'),MetaCostSourceError);assert.equal(f.calls.some(x=>x.step==='admit'||x.step==='put'),false);
 }
});
test('timeout remains UNKNOWN, lost DB settlement retains admitted ownership, and a second upload cannot retry PUT',async()=>{
 const f=fixture();f.storage.put=async()=>{f.calls.push({step:'put'});throw new MediaRuntimeError('timeout','MEDIA_STORAGE_NETWORK',true);};
 await assert.rejects(()=>f.service().upload(tenant,id,bytes,'application/json'),e=>e.code==='SOURCE_WRITE_OUTCOME_UNKNOWN');assert.equal(f.calls.at(-1).outcome,'UNKNOWN');
 await assert.rejects(()=>f.service().upload(tenant,id,bytes,'application/json'),e=>e.code==='SOURCE_WRITE_UNRESOLVED');assert.equal(f.calls.filter(x=>x.step==='put').length,1);
 const lost=fixture();lost.repository.settle=async()=>{throw Error('synthetic DB loss after write');};
 await assert.rejects(()=>lost.service().upload(tenant,id,bytes,'application/json'));assert.equal(lost.reserved.sourceState,'UPLOADING');
 await assert.rejects(()=>lost.service().upload(tenant,id,bytes,'application/json'));assert.equal(lost.calls.filter(x=>x.step==='put').length,1);
});
test('only a definitive nonretryable storage rejection is NOT_WRITTEN',async()=>{
 const f=fixture();f.storage.put=async()=>{throw new MediaRuntimeError('denied','MEDIA_STORAGE_HTTP',false);};
 await assert.rejects(()=>f.service().upload(tenant,id,bytes,'application/json'),e=>e.code==='SOURCE_STORAGE_REJECTED');assert.equal(f.calls.at(-1).outcome,'NOT_WRITTEN');
});
test('original retrieval checks full bytes and rechecks the persisted version before returning',async()=>{
 const good=fixture();assert.deepEqual((await good.service().original(tenant,id)).bytes,bytes);
 const wrong=fixture();wrong.storage.get=async()=>new Uint8Array(bytes.length);await assert.rejects(()=>wrong.service().original(tenant,id),e=>e.code==='SOURCE_INTEGRITY_MISMATCH');
 const changed=fixture();changed.storage.get=async()=>{changed.reserved.version++;return bytes;};await assert.rejects(()=>changed.service().original(tenant,id),e=>e.code==='SOURCE_CHANGED');
});
test('S3 retrieval deadline covers a body that stalls after successful headers',async()=>{
 const originalFetch=globalThis.fetch;let aborted=false;
 globalThis.fetch=async(_url,init)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>{aborted=true;controller.error(new Error('aborted body'));},{once:true});}}),{headers:{'content-type':'application/json','content-length':String(bytes.length)}});
 try{
  const storage=new S3MediaStorage({endpoint:'http://127.0.0.1:9900',region:'us-east-1',bucket:'synthetic-costs',accessKeyId:'synthetic-key',secretAccessKey:'synthetic-secret',environment:'development',timeoutMs:25});
  await assert.rejects(()=>storage.get('synthetic/original',bytes.length,'application/json'),e=>e instanceof MediaRuntimeError&&e.code==='MEDIA_STORAGE_NETWORK');assert.equal(aborted,true);
 }finally{globalThis.fetch=originalFetch;}
});
