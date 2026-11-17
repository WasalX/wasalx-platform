import test from 'node:test';
import assert from 'node:assert/strict';
import {groupSyncOperationId,observeSpareBindingConflict} from '../scripts/release/simulation-group-spare.mjs';

test('group discovery binds the supported lifecycle operation receipt',()=>{
 const id='10000000-0000-4000-8000-000000000001',connectionId='20000000-0000-4000-8000-000000000002',receipt={id:connectionId,state:'WORKING',operation:{id,type:'SYNC_GROUPS',state:'QUEUED'},duplicate:false};
 assert.equal(groupSyncOperationId(receipt,connectionId),id);
 assert.equal(groupSyncOperationId({...receipt,extra:true},connectionId),id);
 for(const value of [{operationId:id},{...receipt,duplicate:true},{...receipt,operation:{...receipt.operation,type:'PROVISION'}},{...receipt,operation:{...receipt.operation,state:'RUNNING'}},{...receipt,operation:{...receipt.operation,id:'------------------------------------'}},{...receipt,operation:{type:'SYNC_GROUPS'}},{...receipt,id:'30000000-0000-4000-8000-000000000003'}])assert.throws(()=>groupSyncOperationId(value,connectionId));
});

test('spare binding conflict observes and closes only the active configuration dialog',async()=>{const calls=[],conflict='Another bot is designated for this group. Pause its binding before activating this connection.',dialog={waitFor:async options=>calls.push(['dialog',options]),getByText:(text,options)=>{assert.equal(text,conflict);assert.deepEqual(options,{exact:true});return{waitFor:async state=>calls.push(['conflict',state])}},getByRole:(role,options)=>{assert.equal(role,'button');assert.deepEqual(options,{name:'Close group configuration',exact:true});return{click:async()=>calls.push(['close'])}}},page={locator:selector=>({selector}),getByRole:role=>{assert.equal(role,'dialog');return{filter:({has})=>{assert.equal(has.selector,'#group-config-title');return dialog}}},getByText:()=>{throw Error('unscoped locator would match duplicate outside text')}};await observeSpareBindingConflict(page);assert.deepEqual(calls,[['dialog',{state:'visible'}],['conflict',{state:'visible'}],['close']]);});
