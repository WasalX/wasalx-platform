import test from 'node:test';import assert from'node:assert/strict';import {assertRuntimeImageSources,withRollbackFixture,nativeBootstrapContext} from "../scripts/release/simulation-stack-session.mjs";import { normalizeGroupFixture } from '../scripts/release/simulation-fresh-group.mjs';
import {readFile} from 'node:fs/promises';



const actor={evidenceMode:'simulated',username:'example.owner',tenantId:'00000000-0000-4000-8000-000000000011',ownerId:'00000000-0000-4000-8000-000000000012'};
test('session preserves the admitted Playwright browser path',async()=>{const source=await readFile(new URL('../scripts/release/simulation-stack-session.mjs',import.meta.url),'utf8');assert(!source.includes("process.env.PLAYWRIGHT_BROWSERS_PATH="));});

test('group fixture uses actual created IDs and exact current active native binding',()=>{const packet={configured:{evidenceMode:'simulated',connectionId:'c',groupId:'g',ruleSetId:'r',bindingId:'b'},eventId:'e',messageId:'m',nativeAfter:{ticketId:12}},binding={binding_id:'b',binding_state:'ACTIVE',rule_set_id:'r',zammad_group_id:'2',binding_revision:3},args={namespace:'suite',tenantId:actor.tenantId,groupRef:'120001@g.us',packet,binding};const f=normalizeGroupFixture(args);assert.equal(f.connectionId,'c');assert.equal(f.groupRef,'120001@g.us');assert.equal(f.zammadGroupId,'2');assert.equal(f.ticketId,12);assert.equal(f.tenantId,actor.tenantId);for(const changed of [{binding_state:'PAUSED'},{binding_id:'wrong'},{rule_set_id:'wrong'},{zammad_group_id:null}])assert.throws(()=>normalizeGroupFixture({...args,binding:{...binding,...changed}}));});
test('rollback fixture always rolls back and closes its dedicated connection',async()=>{for(const fails of[false,true]){const calls=[],db={connect:async()=>calls.push('connect'),query:async sql=>calls.push(sql),end:async()=>calls.push('end')},run=withRollbackFixture(()=>db,async()=>{calls.push('work');if(fails)throw Error('failed')});if(fails)await assert.rejects(run,/failed/);else await run;assert.deepEqual(calls,['connect','BEGIN',"SET LOCAL statement_timeout='10s'",'work','ROLLBACK','end']);}});


test('native bootstrap binding records admin and cannot qualify an agent',()=>{const viewport={width:390,height:844},binding=nativeBootstrapContext({id:4,roles:[1,2]},actor.tenantId,viewport);assert.equal(binding.role,'zammad_admin');assert.match(binding.actorRef,/^sha256:[a-f0-9]{64}$/u);assert.deepEqual(binding.viewport,viewport);for(const native of [{id:4,roles:[2]},{id:0,roles:[1]}])assert.throws(()=>nativeBootstrapContext(native,actor.tenantId,viewport));});

test('runtime source admission keeps uniform default and verifies each reviewed service tuple',()=>{
 const candidate={sha:'a'.repeat(40),tree:'b'.repeat(40)},services=['portal','control-api','connector-worker'];
 const containers=Object.fromEntries(services.map((service,index)=>[service,{Id:String(index+1).repeat(64),Image:'sha256:'+String(index+1).repeat(64),Config:{Labels:{'org.opencontainers.image.revision':candidate.sha,'io.wasalx.source.tree':candidate.tree}}}]));
 assert.doesNotThrow(()=>assertRuntimeImageSources(containers,candidate));
 for(const service of ['control-api','connector-worker'])Object.assign(containers[service].Config.Labels,{'org.opencontainers.image.revision':'8'.repeat(40),'io.wasalx.source.tree':'9'.repeat(40)});
 assert.throws(()=>assertRuntimeImageSources(containers,candidate));
 const bindings=services.map(service=>({service,containerId:containers[service].Id,expectedDigest:containers[service].Image,runningDigest:containers[service].Image,sourceSha:containers[service].Config.Labels['org.opencontainers.image.revision'],sourceTree:containers[service].Config.Labels['io.wasalx.source.tree']}));
 assert.doesNotThrow(()=>assertRuntimeImageSources(containers,candidate,bindings));
 for(const change of [rows=>rows.pop(),rows=>rows[1].service='portal',rows=>rows[1].containerId='f'.repeat(64),rows=>rows[1].runningDigest='sha256:'+'f'.repeat(64),rows=>rows[1].sourceSha='f'.repeat(40),rows=>rows[1].sourceTree='f'.repeat(40)]){const altered=structuredClone(bindings);change(altered);assert.throws(()=>assertRuntimeImageSources(containers,candidate,altered));}
});
