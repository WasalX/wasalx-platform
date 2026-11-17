import test from 'node:test';
import assert from 'node:assert/strict';
import {disableFreshSpare,assertBootstrapIdle} from '../scripts/release/simulation-lifecycle-bootstrap.mjs';
const idle={connections:0,sessions:0,operations:0,effects:0,leases:0};
const worker={workerKey:'simulation-lifecycle-gows',engine:'GOWS',assignedSessions:0,lifecycleState:'ACTIVE',rolloutMode:'STABLE',healthState:'HEALTHY',version:1};
test('fresh spare initializes once through versioned supported request with exact audit',async()=>{
 let changed=false;const calls=[];
 const result=await disableFreshSpare({request:async(path,method,body)=>{calls.push({path,method,body});if(method==='PATCH'){assert.equal(body.version,1);changed=true;return{};}return[{...worker,...(changed?{version:2,lifecycleState:'DISABLED'}:{})}];},census:async()=>idle,audit:async()=>({configurationDigest:'a'.repeat(64),assignments:[],modeEvents:changed?[{id:'event',actorId:'operator',reason:'Fresh isolated lifecycle spare initialization',lifecycleState:'DISABLED'}]:[]}),operatorSubject:'operator',checkpoint:async()=>{}});
 assert.equal(result.lifecycleState,'DISABLED');assert.equal(calls.filter(x=>x.method==='PATCH').length,1);
});
test('pending work, assignments and foreign modes cannot initialize',()=>{
 for(const key of Object.keys(idle))assert.throws(()=>assertBootstrapIdle({...idle,[key]:1},worker));
 for(const patch of [{assignedSessions:1},{lifecycleState:'DRAINING'},{healthState:'UNKNOWN'},{workerKey:'another'}])assert.throws(()=>assertBootstrapIdle(idle,{...worker,...patch}));
});
test('uncertain PATCH stops with no automatic retry',async()=>{
 let writes=0;await assert.rejects(disableFreshSpare({request:async(_path,method)=>{if(method==='PATCH'){writes++;throw Error('timeout');}return[worker];},census:async()=>idle,audit:async()=>({configurationDigest:'a'.repeat(64),assignments:[],modeEvents:[]}),operatorSubject:'operator',checkpoint:async()=>{}}));assert.equal(writes,1);
});
