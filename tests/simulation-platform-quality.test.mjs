import test from 'node:test';import assert from 'node:assert/strict';import * as m from '../scripts/release/simulation-platform-isolation-quality.mjs';
test('eight platform isolation obligations only',()=>{assert.equal(new Set(m.platformIsolationQualityIds).size,8);assert(m.platformIsolationQualityIds.every(id=>id.startsWith('tenant-provisioning/secrets-database-search-storage-and-workspace-isolation::ui-quality::')))});
test('unsafe namespace rejects before auth/browser use',async()=>{let calls=0;await assert.rejects(m.collectPlatformIsolationQuality({namespace:'../old',verify:async()=>{calls++}}));assert.equal(calls,0)});

test('platform locale failure checkpoints the masked leaf failure without qualifying its context',async()=>{
 const {readFileSync}=await import('node:fs');const {runInNewContext}=await import('node:vm');const {createHash}=await import('node:crypto');
 const source=readFileSync(new URL('../scripts/release/simulation-platform-isolation-quality.mjs',import.meta.url),'utf8');
 const start=source.indexOf(' const record='),stop=source.indexOf('\n try{',start);assert(start>=0&&stop>start);
 const checkpointRows=[],results=[],secret='PRIVATE_LOCALE_CANARY',hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const page={url:()=> 'http://portal.test/platform?secret='+secret,viewportSize:()=>({width:820,height:1180}),evaluate:async()=> ''};
 const vmAssert=Object.assign(condition=>assert(condition),{equal:assert.equal,deepEqual:(left,right)=>assert.deepEqual(JSON.parse(JSON.stringify(left)),JSON.parse(JSON.stringify(right)))});
 const record=runInNewContext(source.slice(start,stop)+';record',{assert:vmAssert,hash,page,URL,verify:async()=>({role:'platform_operator',actorRef:'actor',tenantRef:null}),origin:'http://portal.test',viewport:{name:'tablet',width:820,height:1180},actorRef:'actor',contextId:'platform_operator-en-tablet',authority:{},checkpoint:async row=>checkpointRows.push(row),results,testIds:['id::keyboard-focus']});
 await assert.rejects(record('keyboard-focus',async()=>{throw Error(secret)}),error=>error.name==='AssertionError');
 assert.equal(results.length,0);assert.equal(checkpointRows.length,1);assert.equal(checkpointRows[0].phase,'platform-isolation-context-failure');assert.equal(checkpointRows[0].diagnostic.contextPhase,'document-locale');assert.equal(checkpointRows[0].diagnostic.localeClass,'missing');assert.equal(checkpointRows[0].diagnostic.routeClass,'platform');assert.equal(checkpointRows[0].diagnostic.leafFailure.messageSha256,hash(secret));assert(!JSON.stringify(checkpointRows).includes(secret));
});
