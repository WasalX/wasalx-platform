import test from 'node:test';import assert from 'node:assert/strict';import{dispatchSimulationControl,startSimulationControl,callSimulationControl}from'../scripts/contracts/waha-simulation-control.mjs';
test('private control dispatches only explicit existing simulation actions',async()=>{
 const calls=[],provider={simulateState:x=>calls.push(x),emitInbound:x=>({eventId:x.eventId}),emitAck:x=>({eventId:x.eventId})};
 assert.deepEqual(await dispatchSimulationControl(provider,{action:'state',state:'WORKING'}),{applied:true});assert.deepEqual(calls,['WORKING']);
 assert.deepEqual(await dispatchSimulationControl(provider,{action:'inbound',input:{eventId:'retained'}}),{eventId:'retained'});
 assert.deepEqual(await dispatchSimulationControl(provider,{action:'ack',input:{eventId:'ack'}}),{eventId:'ack'});
 await assert.rejects(dispatchSimulationControl(provider,{action:'fetch',url:'https://example.com'}));
});

import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('private socket rejects an overlong pathname before opening a listener', {skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wasalx-control-'));await chmod(dir,0o700);
 try{await assert.rejects(startSimulationControl({},join(dir,'x'.repeat(108))),/path too long/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('private socket round trip rejects unsupported commands', {skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wasalx-control-'));await chmod(dir,0o700);
 let server;try{
  server=await startSimulationControl({simulateState:()=>{}},join(dir,'control.sock'));
  assert.deepEqual(await callSimulationControl(join(dir,'control.sock'),{action:'state',state:'WORKING'}),{applied:true});
  await assert.rejects(callSimulationControl(join(dir,'control.sock'),{action:'fetch'}));
  await assert.rejects(startSimulationControl({},join(dir,'control.sock')));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
