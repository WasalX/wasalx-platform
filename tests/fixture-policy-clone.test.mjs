import assert from 'node:assert/strict';
import test from 'node:test';
import * as fixture from '../lib/fixture-data.ts';
const getVersion=async(id)=>(await fixture.getRuleSetVersions()).find(row=>row.id===id);

test('actual fixture clone preserves source and fences payload-changing replay',async()=>{
 const id=await fixture.createRule({name:'Policy clone check',matcherType:'starts_with',pattern:'/case',priority:1,enabled:true,savedExamples:[]},'fixture test');
 const source=await getVersion(id);
 const rules=source.rules.map(value=>{const rule={...value};delete rule.id;return {...rule,matcherOptions:{...rule.matcherOptions,teamSenderPolicy:'exclude'}}});
 const body={rules};
 const first=await fixture.cloneRuleSetVersion(id,'fixture test','policy-clone-check',body);
 const cloned=await getVersion(first.resultId);
 assert.equal(cloned.rules[0].matcherOptions.teamSenderPolicy,'exclude');
 assert.deepEqual(await getVersion(id),source);
 assert.notEqual(cloned.rules[0].id,source.rules[0].id);
 assert.equal((await fixture.cloneRuleSetVersion(id,'fixture test','policy-clone-check',body)).duplicate,true);
 await assert.rejects(()=>fixture.cloneRuleSetVersion(id,'fixture test','policy-clone-check',{}),e=>e.status===409);
 await assert.rejects(()=>fixture.cloneRuleSetVersion(id,'fixture test','policy-clone-invalid',{rules:[{...rules[0],pattern:'/changed'}]}),e=>e.status===400);
 const unchanged=await fixture.cloneRuleSetVersion(id,'fixture test','policy-clone-empty',{});
 assert.deepEqual((await getVersion(unchanged.resultId)).rules,source.rules);
});
