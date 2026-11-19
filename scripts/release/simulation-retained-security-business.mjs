import assert from 'node:assert/strict';
import {restrictedExecutionResults} from './simulation-direct-derived.mjs';

const allowed=new Set(['passed','failed','blocked','unknown']);
// Admits only an exact retained current-portal securityBusiness fixture; rows keep their original outcomes and windows.
export function admitRetainedSecurityBusiness(retained,{tenantId}){
 assert.equal(retained?.evidenceMode,'simulated');assert.equal(retained.tenantId,tenantId,'Retained security fixture belongs to another tenant');
 const iso=retained.isolationActor;assert.equal(iso?.evidenceMode,'simulated');assert.equal(iso.role,'tenant_owner');assert.equal(iso.onlyIsolationMembership,true);assert.match(iso.userId??'',/^[0-9a-f-]{36}$/u);assert.match(iso.tenantId??'',/^[0-9a-f-]{36}$/u);assert.notEqual(iso.tenantId,tenantId);
 assert(Array.isArray(retained.results));const keys=new Set;
 for(const row of retained.results){assert(row.testId&&row.contextId&&allowed.has(row.result),'Retained security row requires its exact test, context and outcome');assert(Number.isFinite(Date.parse(row.startedAt))&&Number.isFinite(Date.parse(row.finishedAt))&&Date.parse(row.startedAt)<=Date.parse(row.finishedAt),'Retained security row requires its original window');const key=row.testId+'\u0000'+row.contextId;assert(!keys.has(key),'Duplicate retained security row');keys.add(key);}
 if(retained.restrictedExecutionObservations!==undefined)restrictedExecutionResults(retained.restrictedExecutionObservations);
 return iso;
}
