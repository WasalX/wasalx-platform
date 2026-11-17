import test from 'node:test';import assert from 'node:assert/strict';
import {admittedDirectChatIds,attachDirectCapabilities,readDirectProviderReceipts} from '../scripts/release/simulation-direct-capabilities.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
const fixture={evidenceMode:'simulated',provider:'WAHA',tenantId:'t',connectionId:'c',zammadGroupId:'2'};
test('unknown baseline and wrong tenant fail before remote inspection',async()=>{
 const session={tenantId:'t',run(){assert.fail('No remote call');}};
 await assert.rejects(attachDirectCapabilities(session,fixture,{originalUnknowns:[{id:'unknown'}]}),/cannot inherit uncertain/);
 await assert.rejects(attachDirectCapabilities(session,{...fixture,tenantId:'other'},{closedRegistry(){},originalUnknowns:[]}));
});
test('wrong runtime image stops before provider or native effect',async()=>{
 const session={tenantId:'t',containers:{'waha-gows':{Id:'owned',Image:'expected'}},run:async()=>JSON.stringify([{Id:'owned',Image:'other'}])};
 await assert.rejects(attachDirectCapabilities(session,fixture,{closedRegistry(){},originalUnknowns:[]}));assert.equal(session.directCallbacks,undefined);
});
test('runtime admission uses the tenant-fenced worker function without global table grants',()=>{const source=readFileSync('scripts/release/simulation-direct-capabilities.mjs','utf8');assert.match(source,/JOIN LATERAL app\.current_waha_session_runtime\(s\.id\) w ON true/);assert.doesNotMatch(source,/JOIN waha_workers/);});
test('retained receipt read does not require initialized direct callbacks',async()=>{const session={containers:{'waha-gows':{Id:'owned',Image:'expected'}},run:async(command,args)=>{assert.equal(command,'docker');assert.equal(args[1],'owned');return JSON.stringify({receivedSends:10,receipts:[]});}};assert.deepEqual(await readDirectProviderReceipts(session),{receivedSends:10,receipts:[]});});
test('running simulator direct-chat admission is exact and sanitized',()=>{
 assert.deepEqual(admittedDirectChatIds(['UNRELATED=secret','WAHA_SIM_DIRECT_CHAT_IDS=["12025550104@c.us","12025550106@c.us"]']),["12025550104@c.us","12025550106@c.us"]);
 assert.throws(()=>admittedDirectChatIds(['WAHA_SIM_DIRECT_CHAT_IDS=["12025550106@c.us","12025550106@c.us"]']));
 assert.throws(()=>admittedDirectChatIds([]),/allowlist missing/);
});

test('direct capabilities publish the returning actual portal observer and keep backend corroboration separate',()=>{const source=readFileSync('scripts/release/simulation-direct-capabilities.mjs','utf8');assert(source.includes('nativeRead,observeReturningTicket,control:'));assert(source.includes("ensurePortalOperator(session,{role:'agent'"));assert(source.includes('openPortalTicket(operator'));assert(source.includes("privateNativeRead(session,'articles'"));assert(!source.includes('session.nativePage'));assert(source.includes("assert.deepEqual(await providerRead(),before"));});

test('fresh admitted direct capability actually publishes its missing observer without opening a native page',async()=>{const worker='worker',provider='provider',network='owned-network',project='wasalx-simulation-fixture',socket=join('/private/socket','control.sock'),address='192.0.2.7',calls=[];const runtime={Id:provider,Image:'sha256:provider',HostConfig:{PortBindings:{}},State:{Status:'running'},Config:{Labels:{'com.docker.compose.project':project},Env:['WAHA_SIM_DIRECT_CHAT_IDS=["12025550106@c.us","12025550104@c.us"]']},NetworkSettings:{Networks:{[network]:{IPAddress:address}}},Mounts:[{Destination:'/run/wasalx-simulation',Source:'/private/socket'}]};const s={tenantId:'t',socketPath:socket,model:{name:project},containers:{'waha-gows':runtime,'connector-worker':{Id:worker}},checkpoint:async()=>{},scoped:async(sql)=>{assert(sql.includes('current_waha_session_runtime'));return[{id:'session',opaque_session_id:'opaque',base_url:'http://provider.internal:3000'}]},run:async(command,args)=>{calls.push(args);assert.equal(command,'docker');if(args[0]==='inspect')return JSON.stringify([runtime]);if(args[0]==='network')return JSON.stringify([{Internal:true}]);assert.deepEqual(args.slice(0,2),['exec',worker]);return JSON.stringify([{address}]);}};const result=await attachDirectCapabilities(s,fixture,{originalUnknowns:[]});assert.equal(typeof s.directCallbacks.observeReturningTicket,'function');assert.equal(typeof s.directCallbacks.nativeRead,'function');assert.equal(result.runtimeBinding.project,project);assert.equal(s.nativePage,undefined);assert.equal(calls.length,3);});

test('owned provider receipt probe aborts and keeps an independent Node deadline without replay',async()=>{
 const failure=new Error('synthetic aborted read'),controller=new AbortController();let calls=0,deadline,unref=false,forced,exit;
 const session={containers:{'waha-gows':{Id:'owned',Image:'expected'}},run:async(command,args)=>{
  calls++;assert.equal(command,'docker');assert.deepEqual(args.slice(0,4),['exec','owned','node','-e']);
  return await runInNewContext(args[4],{
   process:{env:{WAHA_API_KEY:'synthetic'},stdout:{write:()=>assert.fail('Timed-out read produced evidence')},exit:code=>{exit=code;}},
   setTimeout:(callback,ms)=>{forced=callback;deadline=ms;return{unref:()=>{unref=true;}};},
   AbortSignal:{timeout:ms=>{assert.equal(ms,20_000);queueMicrotask(()=>controller.abort(failure));return controller.signal;}},
   fetch:(_url,{signal})=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),
  });
 }};
 await assert.rejects(readDirectProviderReceipts(session),error=>error===failure);assert.equal(calls,1);assert.equal(deadline,25_000);assert.equal(unref,true);forced();assert.equal(exit,124);
});


test('completed direct capability initializes real runtime callbacks with only its exact stopped review',async()=>{const worker='worker',provider='provider',network='owned-network',project='wasalx-simulation-fixture',socket=join('/private/socket','control.sock'),address='192.0.2.7',calls=[];const runtime={Id:provider,Image:'sha256:provider',HostConfig:{PortBindings:{}},State:{Status:'running'},Config:{Labels:{'com.docker.compose.project':project},Env:['WAHA_SIM_DIRECT_CHAT_IDS=["12025550106@c.us","12025550104@c.us"]']},NetworkSettings:{Networks:{[network]:{IPAddress:address}}},Mounts:[{Destination:'/run/wasalx-simulation',Source:'/private/socket'}]};const s={tenantId:'t',socketPath:socket,model:{name:project},containers:{'waha-gows':runtime,'connector-worker':{Id:worker}},checkpoint:async()=>{},scoped:async(sql)=>{assert(sql.includes('current_waha_session_runtime'));return[{id:'session',opaque_session_id:'opaque',base_url:'http://provider.internal:3000'}]},run:async(command,args)=>{calls.push(args);assert.equal(command,'docker');if(args[0]==='inspect')return JSON.stringify([runtime]);if(args[0]==='network')return JSON.stringify([{Internal:true}]);assert.deepEqual(args.slice(0,2),['exec',worker]);return JSON.stringify([{address}]);}};const group={...fixture,namespace:'new-run'},unknown={id:'retained',state:'OUTCOME_UNKNOWN',attempts:1,external_message_id:null};let verifications=0;s.capabilities={reviewFixture:{fixture:{namespace:'new-run',sourceNamespace:'prior-run',tenantId:'t',connectionId:'c',noReplay:true,requireNoFurtherAttempts:true,retainedUnknown:unknown},verifyReadOnly:async()=>{verifications++;}}};const result=await attachDirectCapabilities(s,group,{originalUnknowns:[unknown]});assert.equal(verifications,1);assert.equal(typeof s.directCallbacks.observeReturningTicket,'function');assert.equal(typeof s.directCallbacks.nativeRead,'function');assert.equal(result.runtimeBinding.project,project);assert.equal(s.nativePage,undefined);assert.equal(calls.length,3);});

test('completed direct initialization rejects changed UNKNOWN or unstopped/foreign capability before runtime inspection',async()=>{
 const unknown={id:'retained',state:'OUTCOME_UNKNOWN',attempts:1,external_message_id:null},group={...fixture,namespace:'new-run'};
 for(const alter of [f=>f.noReplay=false,f=>f.requireNoFurtherAttempts=false,f=>f.tenantId='foreign',f=>f.connectionId='foreign',f=>f.sourceNamespace='new-run',f=>f.retainedUnknown.attempts=2]){
  const retained={namespace:'new-run',sourceNamespace:'prior-run',tenantId:'t',connectionId:'c',noReplay:true,requireNoFurtherAttempts:true,retainedUnknown:structuredClone(unknown)};alter(retained);const s={tenantId:'t',capabilities:{reviewFixture:{fixture:retained,verifyReadOnly:async()=>assert.fail('Invalid retained capability reached verification')}},run:()=>assert.fail('Invalid retained capability inspected runtime')};await assert.rejects(attachDirectCapabilities(s,group,{originalUnknowns:[unknown]}));
 }
});
