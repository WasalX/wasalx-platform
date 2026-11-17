import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {designationResults,designationTestIds} from '../../tests/group-designation-evidence.mjs';
export {designationTestIds};
const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateDesignationReceipt(envelope,expected){
 const {gate,receipt:r}=envelope;
 assert.equal(gate.command,'pnpm test:postgres');assert.equal(gate.exitCode,0);assert.equal(gate.signal,null);assert.equal(gate.completed,true);
 assert.equal(r.kind,'postgres-designation-proof');assert.equal(r.evidenceMode,'simulated');assert.equal(r.trackedWorktreeChanges,false);
 assert.equal(r.candidateSha,expected.sha);assert.equal(r.treeSha,expected.tree);
 assert.deepEqual(r.sourceHashes,expected.sourceHashes);assert.deepEqual(r.migrations,expected.migrations);
 assert.deepEqual(Object.keys(expected.sourceHashes).sort(),['scripts/test-postgres-integration.mjs','tests/group-designation-evidence.mjs','tests/group-designation-postgres.mjs']);for(const value of Object.values(expected.sourceHashes))assert.match(value,/^[a-f0-9]{64}$/);assert(expected.migrations.length>0);for(const row of expected.migrations){assert(typeof row.name==='string');assert.match(row.checksum_sha256,/^[a-f0-9]{64}$/);}
 assert(typeof r.database==='string'&&r.database.length>0);
 assert.equal(r.results.length,2);assert.deepEqual(r.results.map(x=>x.testId),designationTestIds);
 for(const row of r.results){assert.equal(row.result,'passed');assert(designationResults(row.proof,row).some(x=>x.testId===row.testId));assert(Date.parse(gate.startedAt)<=Date.parse(row.startedAt));assert(Date.parse(row.finishedAt)<=Date.parse(gate.finishedAt));}
 return r.results.map(row=>({...row,context:{surface:'database'},proof:{...row.proof,executionBoundary:'postgresql-invariant-only; no browser actor or viewport',candidateSha:r.candidateSha,treeSha:r.treeSha,sourceHashes:r.sourceHashes,migrations:r.migrations,database:r.database,gate}}));
}
export function approvedDesignationDeferral(catalog){
 const known=new Set(catalog.journeys.flatMap(j=>j.useCases.flatMap(u=>u.tests)).map(t=>t.id));
 return designationTestIds.every(id=>{
  const rows=(catalog.scope?.testDeferrals??[]).filter(d=>d.testIds?.includes(id));
  return known.has(id)&&rows.length===1&&rows[0].releaseProfile==='first-client-alpha-live'&&rows[0].reason?.trim()&&rows[0].approval?.source?.trim()&&/Z$/.test(rows[0].approval?.recordedAt??'')&&Number.isFinite(Date.parse(rows[0].approval.recordedAt));
 });
}
export async function postgresDesignationStage(s,{config}){
 const p=resolve(s.privateDir,config.receiptPath),rel=relative(s.privateDir,p);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert.equal(await realpath(p),p);
 const bytes=await readFile(p);assert.equal(sha(bytes),config.receiptSha256);
 assert.equal(config.expected.sha,s.candidate.sha);assert.equal(config.expected.tree,s.candidate.tree);
 const proofs=validateDesignationReceipt(JSON.parse(bytes),config.expected);
 assert(config.qualificationDisposition===undefined||config.qualificationDisposition==='supporting-approved-deferral');
 if(config.qualificationDisposition==='supporting-approved-deferral'){
  const observations=proofs.map(row=>({sourceTestId:row.testId,evidenceMode:'simulated',databaseAssertionVerified:true,startedAt:row.startedAt,finishedAt:row.finishedAt,proof:row.proof,receiptSha256:config.receiptSha256}));
  for(const observation of observations)await s.checkpoint({phase:'postgres-designation-supporting',...observation});
  return{evidenceMode:'simulated',observations};
 }

 for(const proof of proofs)await s.checkpoint({phase:'postgres-designation-admitted',...proof,receiptSha256:config.receiptSha256});
 return {evidenceMode:'simulated',proofs};
}
