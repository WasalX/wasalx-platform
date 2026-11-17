import assert from 'node:assert/strict';
import { remoteViewports } from "./journey-context-contract.mjs";
import { definitions } from './simulation-session-remaining-definitions.mjs';

const sessionIds=new Set(definitions.map(definition=>definition.id));
const sourceSuffix=suffix=>suffix==='safe-error-recovery'?'degraded':suffix;
const suffixOf=testId=>testId.split('::').at(-1);
export const tenantSessionRoles=['tenant_owner','tenant_admin','supervisor','auditor','agent'];
export function contextViewport(contextId){const name=contextId.split('-').at(-1),viewport=remoteViewports.find(value=>value.name===name);assert(viewport,'Unknown session context viewport '+contextId);return{width:viewport.width,height:viewport.height};}
export function contextRole(contextId){const match=/^(.+)-en-(desktop|tablet|mobile)$/u.exec(contextId);assert(match,'Unsupported session context '+contextId);return match[1];}
// Exact selected checks own the obligation; an absent observation stays not executed, never mapped or counted.
export function selectSessionChecks(checks,roleFilter){
 assert(Array.isArray(checks),'Exact selected session checks required');const keys=new Set;
 return checks.filter(check=>{assert(sessionIds.has(check?.testId),'Unexpected session check '+check?.testId);const key=check.testId+'\u0000'+check.contextId;assert(!keys.has(key),'Duplicate selected session check');keys.add(key);contextViewport(check.contextId);return roleFilter(contextRole(check.contextId));});
}

export function mapSessionQuality(input,{namespace,tenantId,checks}){
 assert.equal(input?.evidenceMode,'simulated');assert.equal(input.namespace,namespace);assert.equal(input.tenantId,tenantId);
 const source=input.sessionObservations;assert(Array.isArray(source));const results=[],notExecuted=[];
 for(const check of selectSessionChecks(checks,role=>tenantSessionRoles.includes(role))){
  const {testId,contextId}=check,role=contextRole(contextId),expectedViewport=contextViewport(contextId),matches=source.filter(row=>row.contextId===contextId&&row.suffix===sourceSuffix(suffixOf(testId)));
  if(!matches.length){notExecuted.push({testId,contextId,reason:'No actual observation for the selected context'});continue;}
  const row=matches[0];assert(matches.every(match=>match.result===row.result&&JSON.stringify(match.proof)===JSON.stringify(row.proof)),'Same-context shell evidence differs');
  assert(row.startedAt&&row.finishedAt);assert.deepEqual(row.actualViewport,expectedViewport);if(role==='tenant_owner'){assert.equal(row.tenantId,tenantId);assert(row.actorBinding?.userMatched&&row.actorBinding?.workspaceMatched)}else{assert.match(row.actorRef,/^sha256:[a-f0-9]{64}$/u);assert.match(row.tenantRef,/^sha256:[a-f0-9]{64}$/u)}
  results.push({...row,testId,contextId,actualViewport:expectedViewport,supportingSourceTestIds:matches.map(match=>match.testId).filter(Boolean),scope:'Exact authenticated role, tenant and viewport shell observation; failed or blocked source outcomes are retained without cross-context inference.'});
 }
 return{results,notExecuted};
}

export function mapAnonymousSessionQuality(input,{namespace,tenantId,checks}){
 assert.equal(input?.evidenceMode,'simulated');assert.equal(input.namespace,namespace);assert.equal(input.tenantId,tenantId);assert.equal(input.noNewEmail,true);assert(Array.isArray(input.results));const results=[],notExecuted=[];
 for(const {testId,contextId} of selectSessionChecks(checks,role=>role==='anonymous')){
  const expectedViewport=contextViewport(contextId),matches=input.results.filter(row=>row.contextId===contextId&&row.testId.startsWith('identity-access/invitation-acceptance-and-expiry::ui-quality::')&&row.testId.endsWith('::ui-quality::'+suffixOf(testId)));
  if(!matches.length){notExecuted.push({testId,contextId,reason:'No actual anonymous observation for the selected context'});continue;}
  assert.equal(matches.length,1,'Ambiguous anonymous observation for '+contextId);const row=matches[0];
  assert(['passed','failed','blocked'].includes(row.result));assert(row.startedAt&&row.finishedAt);assert.deepEqual(row.actualViewport,expectedViewport);assert.equal(row.actorRef??null,null);assert.equal(row.tenantRef??null,null);
  results.push({...row,testId,contextId,actorRef:null,tenantRef:null,supportingSourceTestIds:[row.testId],proof:{...row.proof,scope:row.proof?.scope??'Exact cookie-free public invitation/authentication observation reused for the same identity boundary; result and per-suffix proof preserved without composite projection.'}});
 }
 return{results,notExecuted};
}
