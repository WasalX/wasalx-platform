import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryTerminalStates,operationTerminalStates,restoreObservedConfiguration,restorationSql} from '../scripts/release/owned-work-restoration.mjs';
test('shared terminal states include provider acknowledgements and cancelled operations',()=>{assert(deliveryTerminalStates.includes('READ'));assert(operationTerminalStates.includes('CANCELLED'));});
const row=()=>({inbox:[{id:'one',status:'PROCESSED',processedAt:'2026-09-11T21:29:42Z',leaseId:null,leaseExpiresAt:null}],deliveries:[],unknowns:[],pending_inbox:0,pending_actions:0,pending_status:0,pending_operations:0,pending_direct:0,unknown_direct:0,unknown_actions:0});
function options(value,restore,registry={closed:true,entries:()=>[{kind:'inbound',eventId:'event'}]}){return {tenantId:'tenant',connectionId:'connection',registry,originalUnknowns:[],scoped:async(sql,args)=>{assert.equal(sql,restorationSql);assert.deepEqual(args,['tenant','connection',['event'],[],'WAHA']);return [value]},checkpoint:async()=>{},restore};}
for(const [label,mutate] of [
 ['future retry',x=>{x.inbox[0].status='FAILED_RETRYABLE';x.inbox[0].processedAt=null}],
 ['missing ingress',x=>{x.inbox=[]}],
 ['lease',x=>{x.inbox[0].leaseId='active'}],
 ['lease expiry',x=>{x.inbox[0].leaseExpiresAt='future'}],
 ['pending sibling',x=>{x.pending_inbox=1}],
 ['action',x=>{x.pending_actions=1}],
 ['status notification',x=>{x.pending_status=1}],
 ['operation',x=>{x.pending_operations=1}],
 ['new unknown',x=>{x.unknowns=[{id:'new'}]}],
 ['queued delivery',x=>{x.deliveries=[{state:'QUEUED',leaseId:null,leaseExpiresAt:null}]}]
])test(label+' holds configuration',async()=>{const value=row();mutate(value);let writes=0;await assert.rejects(restoreObservedConfiguration(options(value,async()=>writes++)));assert.equal(writes,0)});
for(const status of ['PROCESSED','IGNORED','UNMATCHED','QUARANTINED','DUPLICATE','FAILED_TERMINAL'])test(status+' accepts completed cleared lease',async()=>{const value=row();value.inbox[0].status=status;let writes=0;await restoreObservedConfiguration(options(value,async()=>writes++));assert.equal(writes,1)});
test('unknown baseline is preserved and scoped',async()=>{const value=row();value.unknowns=[{id:'old',attempts:1}];let writes=0;const args=options(value,async()=>writes++);args.originalUnknowns=[{id:'old',attempts:1}];await restoreObservedConfiguration(args);assert.equal(writes,1)});
test('unclosed or unsupported registry never queries or restores',async()=>{for(const registry of [{closed:false,entries:()=>[]},{closed:true,entries:()=>[{kind:'native-action'}]}]){let calls=0;const args=options(row(),async()=>calls++,registry);args.scoped=async()=>{calls++;return[row()]};await assert.rejects(restoreObservedConfiguration(args));assert.equal(calls,0)}});
test('observer failure preserves primary cause and holds',async()=>{const primary=new Error('UI timeout');const args=options(row(),async()=>assert.fail('restore'));args.primaryFailure=primary;args.scoped=async()=>{throw new Error('database unavailable')};await assert.rejects(restoreObservedConfiguration(args),e=>e instanceof AggregateError&&e.errors[0]===primary)});

test('terminal delivery receipts permit restoration only after leases clear',async()=>{for(const state of ['DELIVERED','READ','PRIVACY_CANCELLED']){const value=row();value.deliveries=[{state,leaseId:null,leaseExpiresAt:null}];let writes=0;await restoreObservedConfiguration(options(value,async()=>writes++));assert.equal(writes,1);value.deliveries[0].leaseId='retained';await assert.rejects(restoreObservedConfiguration(options(value,async()=>writes++)));assert.equal(writes,1)}});
