import test from 'node:test';import assert from 'node:assert/strict';import{createWahaSimulation}from'../scripts/contracts/waha-simulation-server.mjs';
const apiKey='synthetic-health-check-key';
test('server health is separate from session lifecycle and start timestamp stays stable',async()=>{
 let clock=Date.now();const start=clock;const server=createWahaSimulation({apiKey,session:'s',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,now:()=>clock});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const req=path=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{'x-api-key':apiKey}});
 try{
 assert.deepEqual(await(await req('/health')).json(),{status:'ok',info:{},error:{},details:{}});
 assert.deepEqual(await(await req('/api/server/status')).json(),{startTimestamp:start,uptime:0,worker:{id:'simulation'}});
 clock+=1234;server.simulateState('FAILED');assert.deepEqual(await(await req('/api/server/status')).json(),{startTimestamp:start,uptime:1234,worker:{id:'simulation'}});
 assert.equal((await req('/api/sessions/s')).status,404);
 }finally{await new Promise(r=>server.close(r));}
});

test('actual worker probe admits simulated server and rejects unavailable health and wrong credential',async()=>{
 const {probeWahaWorker}=await import('../services/connector-worker/dist/services/connector-worker/src/waha-worker-registry.js');
 for(const healthStatus of ['ok','error']){
  const server=createWahaSimulation({apiKey,session:'s',groupId:'123@g.us',phone:'12025550102',version:'2026.7.2',initialExists:false,healthStatus});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const url=`http://127.0.0.1:${server.address().port}`;const result=await probeWahaWorker(url,apiKey);
   assert.equal(result.healthy,healthStatus==='ok');if(healthStatus==='error')assert.equal(result.errorCode,'WAHA_HEALTH_HTTP_503');else assert(Number.isFinite(Date.parse(result.startedAt)));
   assert.deepEqual(await probeWahaWorker(url,'incorrect-synthetic-key'),{healthy:false,errorCode:'WAHA_HEALTH_HTTP_401'});
  }finally{await new Promise(r=>server.close(r));}
 }
});
