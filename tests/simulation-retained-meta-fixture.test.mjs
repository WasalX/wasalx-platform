import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {retainedMetaFixtureStage,installRetainedMetaCallbacks} from '../scripts/release/simulation-retained-meta-fixture.mjs';

const binding={project:'wasalx-simulation-unit',tenantId:'tenant',connectionId:'meta-connection',phoneId:'10001',wabaId:'20001',graphContainerId:'c'.repeat(64),graphImageDigest:'sha256:'+'d'.repeat(64),graphSourceSha256:'e'.repeat(64),controlSocket:'meta.sock'};
async function retained(result){
 const dir=await mkdtemp(join(tmpdir(),'wasalx-retained-meta-')),sourceDir=join(dir,'scenario-prior-meta');await mkdir(sourceDir);
 const bytes=Buffer.from(JSON.stringify({namespace:'prior-meta',evidenceMode:'simulated',scenario:'meta-deliveries',fixture:'metaDeliveries',result}));await writeFile(join(sourceDir,'fixture-meta-deliveries.json'),bytes);
 const checkpoints=[],session={privateDir:dir,runId:'next-meta',tenantId:'tenant',model:{name:binding.project},checkpoint:async row=>checkpoints.push(row)};
 return{session,checkpoints,args:{namespace:'next-meta',config:{sourceNamespace:'prior-meta',sourceStage:'meta-deliveries',expectedFixture:'metaDeliveries',path:'scenario-prior-meta/fixture-meta-deliveries.json',sha256:createHash('sha256').update(bytes).digest('hex'),meta:{}}}};
}

test('dependent retained Meta fixture without its own connection reuses initialized callbacks and is never replayed',async()=>{
 const {session,checkpoints,args}=await retained({namespace:'prior-meta',connectionId:null,runtimeBinding:null,proofs:[]}),callbacks={binding:{...binding}};
 await assert.rejects(retainedMetaFixtureStage(session,args),/requires initialized callbacks/);
 session.metaCallbacks=callbacks;const fixture=await retainedMetaFixtureStage(session,args);
 assert.equal(fixture.namespace,'next-meta');assert.equal(fixture.retainedProvenance.sourceNamespace,'prior-meta');assert.equal(session.metaCallbacks,callbacks);assert(checkpoints.every(row=>row.noReplay===true));
});

test('retained Meta fixture with a partial runtime binding fails before creating callbacks',async()=>{
 for(const result of [{namespace:'prior-meta',connectionId:'meta-connection',runtimeBinding:null},{namespace:'prior-meta',connectionId:null,runtimeBinding:binding}]){const {session,args}=await retained(result);await assert.rejects(retainedMetaFixtureStage(session,args),/partial runtime binding/);assert.equal(session.metaCallbacks,undefined);}
});

test('installed retained Meta callbacks must match the retained runtime binding exactly',()=>{
 const session={model:{name:binding.project},tenantId:'tenant'},fixture={connectionId:'meta-connection',runtimeBinding:binding},callbacks=()=>({binding:{...binding,connectionId:'fresh-placeholder'},cfg:{binding:{phoneId:binding.phoneId,wabaId:binding.wabaId}}});
 const accepted=callbacks();installRetainedMetaCallbacks(session,fixture,accepted);assert.equal(session.metaCallbacks,accepted);assert.equal(accepted.binding.connectionId,'meta-connection');
 for(const key of ['graphContainerId','graphImageDigest','controlSocket']){const other={model:{name:binding.project},tenantId:'tenant'},drifted=callbacks();drifted.binding[key]='drift';assert.throws(()=>installRetainedMetaCallbacks(other,fixture,drifted),/Meta fixture runtime mismatch/);assert.equal(other.metaCallbacks,undefined);}
});
