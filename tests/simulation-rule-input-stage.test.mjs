import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {admitRuleInputs,bindRuleInputProofs,ruleInputTestIds} from '../scripts/release/simulation-rule-input-stage.mjs';
import {bindRuleEchoProof} from '../scripts/release/simulation-rule-stages.mjs';
const binding={project:'wasalx-simulation-check',connectionId:'c',providerSessionId:'p',containerId:'container',imageId:'image',socketPath:'/socket'};
const callbacks={binding,...Object.fromEntries(['control','drainEffects','providerRead','assertIsolatedRuntime'].map(k=>[k,()=>{throw Error('effect forbidden');}]))};
const session={tenantId:'t',actorBinding:{userMatched:true,workspaceMatched:true},model:{name:binding.project},ownerPage:{},nativePage:{},portalOrigin:'http://127.0.0.1',checkpoint(){},scoped(){},directCallbacks:callbacks};
const args={namespace:'fresh1',inputs:{group:{namespace:'fresh1',evidenceMode:'simulated',tenantId:'t',connectionId:'c',groupId:'g',ruleSetId:'r',groupRef:'123-456@g.us'},directConnection:{provider:'WAHA',evidenceMode:'simulated',tenantId:'t',connectionId:'c',runtimeBinding:binding}}};
test('rule input stage admits only produced group/provider binding',()=>{
 assert.equal(admitRuleInputs(session,args).groupId,'g');assert.equal(ruleInputTestIds.length,4);
 assert.throws(()=>admitRuleInputs(session,{...args,namespace:'old'}));
 assert.throws(()=>admitRuleInputs({...session,directCallbacks:{...callbacks,binding:{...binding,imageId:'other'}}},args));
 assert.throws(()=>admitRuleInputs({...session,nativePage:null},args));
});

test('rule producers preserve exact action windows in final rows',()=>{const actualViewport={width:1440,height:1000},time={startedAt:'2026-09-20T08:00:00.000Z',finishedAt:'2026-09-20T08:00:01.000Z'},result={proofs:['customer-match','customer-nonmatch','unknown'].map(name=>({name,...time})),duplicateEvidence:{...time}};const rows=bindRuleInputProofs(result,actualViewport);assert.equal(rows.length,4);assert(rows.every(row=>row.startedAt===time.startedAt&&row.finishedAt===time.finishedAt));assert.throws(()=>bindRuleInputProofs({...result,proofs:[{name:'customer-match'}]},actualViewport),/producer action\/check window/);const echo=bindRuleEchoProof({testId:'echo',result:'passed',proof:{},...time},actualViewport);assert.equal(echo.startedAt,time.startedAt);assert.equal(echo.finishedAt,time.finishedAt);assert.throws(()=>bindRuleEchoProof({testId:'echo',result:'passed',proof:{}},actualViewport),/producer action\/check window/);});

test('native rule title is semantically verified but only a digest token enters importable rows',()=>{
 const title='Friendly 6789012345 private marker',time={startedAt:'2026-09-20T08:00:00.000Z',finishedAt:'2026-09-20T08:00:01.000Z'};
 const result={proofs:[{name:'customer-match',...time,native:{id:8,number:'123',title,matchingArticleIds:[19]}},{name:'customer-nonmatch',...time},{name:'unknown',...time}],duplicateEvidence:{...time}};
 const rows=bindRuleInputProofs(result,{width:1440,height:1000}),match=rows[0];
 assert.equal(match.proof.native.title,`[redacted sha256:${createHash('sha256').update(title).digest('hex')} length:${title.length}]`);
 assert.equal(match.proof.native.titleVisible,true);assert.equal(match.proof.native.id,8);assert.equal(match.proof.native.number,'123');assert.deepEqual(match.proof.native.matchingArticleIds,[19]);
 assert.equal(match.startedAt,time.startedAt);assert.equal(match.finishedAt,time.finishedAt);assert.equal(match.contextId,'tenant_owner-en-desktop');
 assert(!JSON.stringify(rows).includes(title));assert.equal(result.proofs[0].native.title,title);
 assert(rows.slice(1).every(row=>row.proof.native===undefined));
 assert.throws(()=>bindRuleInputProofs({...result,proofs:[{...result.proofs[0],native:{...result.proofs[0].native,title:''}},...result.proofs.slice(1)]},{width:1440,height:1000}),/Native title proof required/);
});
