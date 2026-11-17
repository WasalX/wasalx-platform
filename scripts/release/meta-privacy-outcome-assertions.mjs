// NEVER_RUN_HOSTED_CI: manual live-provider driver; supply account inputs and credentials at runtime.
import {pathToFileURL as manualDriverFileUrl} from "node:url";
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && process.argv[1] && import.meta.url === manualDriverFileUrl(process.argv[1]).href) throw new Error("Live provider drivers must never run in hosted CI");
// In-process assertions over scoped actual guest readbacks, never state synthesis.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const same=(a,b)=>assert(isDeepStrictEqual(a,b),'P11 scoped evidence mismatch');
export function assertSourceStorage(source,object,expected){
 assert(source&&object&&object.statementId===source.id&&object.sourceState===source.sourceState&&object.writeDisposition===source.writeDisposition);
 assert(['WRITTEN','NOT_WRITTEN'].includes(source.writeDisposition),'Unsettled write cannot qualify disposal');
 assert.equal(object.state,expected);
 if(expected==='PRESENT'){assert(source.writeDisposition==='WRITTEN'&&hash(source.originalSha256));assert.equal(object.sha256,source.originalSha256);assert.equal(String(object.byteSize),String(source.originalByteSize));}
 else{assert.equal(expected,'ABSENT');assert.equal(source.sourceState,'PURGED');assert(source.sourcePurgedAt);assert.equal(object.sha256,null);assert.equal(object.byteSize,null);}
}
export function assertP11Evidence(row,scope){
 assert(row&&row.tenantId===scope.tenantId&&row.scopeSha256===scope.sha256&&Array.isArray(row.native)&&Array.isArray(row.sidecar));
 for(const key of ['sharedAssetSha256','protectedNativeSha256','providerMutationSha256','originalSourceWriteSha256'])assert(hash(row[key]));
 assert(row.native.length>0&&row.native.every(x=>['USER','TICKET'].includes(x.kind)&&typeof x.id==='string'&&/^[0-9]+$/u.test(x.id)&&typeof x.instanceId==='string'&&hash(x.identitySha256)&&['PRESENT','ABSENT','UNKNOWN'].includes(x.state)));
 assert(row.sidecar.every(x=>hash(x.referenceSha256)&&typeof x.shared==='boolean'&&['PRESENT','ABSENT','UNKNOWN'].includes(x.state)));
 assert(Number.isInteger(row.activeLegalHolds)&&row.activeLegalHolds>=0);return row;
}
export function assertPreservedExternal(before,after){
 for(const key of ['sharedAssetSha256','protectedNativeSha256','providerMutationSha256','originalSourceWriteSha256'])same(before[key],after[key]);
}
export function assertHeldPrivacy(before,after){assertPreservedExternal(before,after);same(before.native,after.native);same(before.sidecar,after.sidecar);same(before.localSensitiveRows,after.localSensitiveRows);}
export function assertTenantDeletion(before,after,job){
 assert.equal(job.jobState,'SUCCEEDED');assert.equal(job.stage,'DONE');assertPreservedExternal(before,after);
 assert(before.native.some(x=>x.kind==='TICKET'&&x.state==='PRESENT'),'Real native ticket required');assert.equal(before.native.length,after.native.length);
 for(const old of before.native){const current=after.native.find(x=>x.instanceId===old.instanceId&&x.kind===old.kind&&x.id===old.id);assert(current);if(old.kind==='TICKET')assert.equal(current.state,'ABSENT');else same(current,old);}
 // TENANT deletes discovered tickets, not ZAMMAD_USER data-privacy tasks.
 assert(after.localSensitiveRows&&Object.keys(after.localSensitiveRows).length>0&&Object.values(after.localSensitiveRows).every(x=>x===0));
 same(before.sidecar,after.sidecar); // TENANT finalization does not retire connection secrets.
}
export function assertScopedOffboarding(before,after,cleanup){
 assertPreservedExternal(before,after);same(before.native,after.native);
 assert(Array.isArray(cleanup)&&cleanup.every(x=>x.state==='SUCCEEDED'));
 assert.equal(after.sidecar.length,before.sidecar.length);
 for(const old of before.sidecar){assert.equal(old.state,'PRESENT');const current=after.sidecar.find(x=>x.referenceSha256===old.referenceSha256);assert(current);assert.equal(current.shared,old.shared);assert.equal(current.state,old.shared?'PRESENT':'ABSENT');}
 assert(before.sidecar.length>0,'Actual owned references required; no vacuous cleanup proof');
}
export function assertFinancialReviewReceipts(sources,receipts){
 assert(Array.isArray(receipts)&&receipts.length===sources.length);
 for(const source of sources){const target=source.targets.find(x=>x.type==='FINANCE_SOURCE_REVIEW'&&x.state==='SKIPPED'&&x.outcome==='PURGE_REQUIRED');assert(target);const receipt=receipts.find(x=>x.statementId===source.id);assert(receipt&&receipt.targetId===target.id&&receipt.bindingSha256===target.bindingSha256&&receipt.outcome==='PURGE_REQUIRED'&&receipt.action==='META_SOURCE_PRIVACY_REVIEW'&&receipt.state==='SUCCEEDED'&&hash(receipt.receiptSha256)&&hash(receipt.bodySha256));}
}
export function assertFinanceArtifact({document,summary,expected}){
 for(const key of ['metaCostStatements','metaCostSourceReviewStatus']){assert(Array.isArray(expected[key])&&Array.isArray(document.local[key]));if(key==='metaCostStatements')same([...document.local[key]].sort((a,b)=>a.id.localeCompare(b.id)),[...expected[key]].sort((a,b)=>a.id.localeCompare(b.id)));else same(document.local[key],expected[key]);assert.equal(summary[key],expected[key].length);}
 for(const key of ['participantIdentities','metaDirectAliases','metaDirectIdentityEvents','metaDirectRecipients','metaBillingEvidence','metaAccountPolicies','metaAccountTransitions','metaManagedAuthority','metaFinancialEffects','metaSignupAttempts','groupWorkspaceParticipants']){assert(Array.isArray(document.local[key]));assert.equal(summary[key],document.local[key].length);}
 for(const [key,parent,child] of [['metaCoexistenceMessages','metaCoexistence','messages'],['metaCoexistenceContacts','metaCoexistence','contacts'],['metaRoutingEvents','metaRouting','events'],['metaRoutingActions','metaRouting','actions']]){assert(Array.isArray(document.local[parent][child]));assert.equal(summary[key],document.local[parent][child].length);}
}
