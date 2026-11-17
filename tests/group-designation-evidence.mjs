import assert from 'node:assert/strict';
export const designationTestIds=['concurrent','scoped-transition'].map(s=>'group-rules/commands-triggers-and-friendly-ticket-naming::single-active-group-binding::'+s);
export function designationResults(proof,{startedAt,finishedAt}){
 assert.equal(proof.mode,'simulated');assert.equal(proof.scope,'postgresql-invariant-only');assert.equal(proof.lockOverlap,true);assert.equal(proof.conflict.code,'23505');assert.equal(proof.conflict.constraint,'group_designated_binding_unique');assert.equal(proof.originalPreserved,true);assert.deepEqual(proof.independentScopes,['tenant','provider','group']);assert.deepEqual(proof.transition,['ACTIVE/PAUSED','PAUSED/PAUSED','PAUSED/ACTIVE']);assert(Date.parse(startedAt)<=Date.parse(finishedAt));
 return designationTestIds.map(testId=>({testId,result:'passed',evidenceMode:'simulated',startedAt,finishedAt,proof,scope:'PostgreSQL invariant; no UI or live-provider claim'}));
}
