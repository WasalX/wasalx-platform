import assert from 'node:assert/strict';
import {remoteViewports} from "./journey-context-contract.mjs";
import {definitions as connections} from './simulation-connection-quality-definitions.mjs';
import {definitions as navigation} from './simulation-navigation-quality-definitions.mjs';
import {definitions as sessions} from './simulation-session-remaining-definitions.mjs';
import {navigationWidthId} from './simulation-navigation-width.mjs';
import {groupRulePermissionIds} from './simulation-group-rule-role-contexts.mjs';
const roleId='team-access/roles-invitations-revocation-and-last-owner-protection::role-lifecycle-and-last-owner-protection-render::01';
const zoomId='tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::chrome-200-zoom';
const familyById=new Map([
 ...connections.filter(row=>row.id.startsWith('connections/disconnect-reconnect-and-secret-retirement::')).map(row=>[row.id,'connection']),
 ...navigation.map(row=>[row.id,'navigation']),...sessions.map(row=>[row.id,'navigation']),
 ...groupRulePermissionIds.map(id=>[id,'groupRulePermissions']),[navigationWidthId,'width'],[zoomId,'zoom'],[roleId,'roleProof']
]);
const key=row=>JSON.stringify([row.testId,row.contextId]);
// Viewports with a real role observer per family; other selected contexts stay downstream not executed.
export const teamObserverViews={connection:['desktop','tablet','mobile'],navigation:['desktop','tablet','mobile'],groupRulePermissions:['desktop','tablet','mobile'],width:['desktop','tablet'],zoom:['desktop'],roleProof:['desktop']};
export function teamRoleObserverPlan(checks){
 assert(Array.isArray(checks),'Exact selected downstream checks required');const contexts=new Map,required=[],unsupported=[];
 for(const check of checks){const family=familyById.get(check.testId);if(!family)continue;const match=check.contextId?.match(/^(tenant_owner|tenant_admin|supervisor|auditor|agent)-en-(desktop|tablet|mobile)$/u);if(!match)continue;const [,role,view]=match;if(role==='tenant_owner'&&['connection','navigation','zoom'].includes(family))continue;
  if(!teamObserverViews[family].includes(view)){if(!unsupported.some(row=>key(row)===key(check)))unsupported.push(check);continue;}
  const context=contexts.get(check.contextId)??{role,view,families:new Set};context.families.add(family);contexts.set(check.contextId,context);if(!required.some(row=>key(row)===key(check)))required.push(check);
 }
 const fullRoleProof=required.some(row=>row.testId===roleId),roles=fullRoleProof?['tenant_admin','supervisor','auditor']:['tenant_admin','supervisor','auditor'].filter(role=>[...contexts.values()].some(context=>context.role===role));
 return{contexts,roles,fullRoleProof,required,unsupported,views:role=>['desktop','tablet','mobile'].filter(view=>contexts.has(role+'-en-'+view)),wants:(role,view,family)=>contexts.get(role+'-en-'+view)?.families.has(family)===true};
}
export function mergeTeamObserverRows(prior,fresh,{suffix=false}={}){
 assert(Array.isArray(prior)&&Array.isArray(fresh));const rowKey=row=>JSON.stringify([suffix?row.suffix:row.testId,row.contextId]),original=new Map;
 for(const row of prior){const id=rowKey(row);assert(!original.has(id),'Duplicate retained observation');original.set(id,row);}
 const freshKeys=new Set;for(const row of fresh){const id=rowKey(row);assert(!freshKeys.has(id),'Duplicate fresh observation');freshKeys.add(id);assert(original.has(id),'Fresh observation outside retained coverage');original.set(id,row);}
 return[...original.values()];
}
export function assertFreshTeamObserverChecks(plan,{results,connectionQualityContextResults,navigationQualityContextResults,navigationZoomContextResults,groupRulePermissionContextResults,sessionQualityContextObservations}){
 const observed=[...results,...connectionQualityContextResults,...navigationQualityContextResults,...navigationZoomContextResults,...groupRulePermissionContextResults,...sessionQualityContextObservations.flatMap(row=>sessions.filter(definition=>{const suffix=definition.id.split('::').at(-1);return row.suffix===(suffix==='safe-error-recovery'?'degraded':suffix)}).map(definition=>({...row,testId:definition.id})))],actual=new Set(observed.map(key));
 for(const check of plan.required)assert(actual.has(key(check)),'Missing fresh selected team observer '+key(check));
}
const viewportOf=contextId=>{const name=contextId.split('-').at(-1),viewport=remoteViewports.find(value=>value.name===name);assert(viewport,'Unknown context viewport '+contextId);return{width:viewport.width,height:viewport.height};};
// Exact selected checks own each obligation; without contextual checks the stage keeps its original single context.
export function selectedStageChecks(checks,testIds,fallbackContextId){
 const ids=new Set(testIds);if(!checks?.length)return testIds.map(testId=>({testId,contextId:fallbackContextId}));
 const keys=new Set;return checks.filter(check=>{if(!ids.has(check.testId))return false;const id=key(check);assert(!keys.has(id),'Duplicate selected check');keys.add(id);viewportOf(check.contextId);return true;});
}
export function selectedViewports(checks,role){return[...new Set(checks.filter(check=>check.contextId.startsWith(role+'-en-')).map(check=>check.contextId))].map(contextId=>({contextId,name:contextId.split('-').at(-1),...viewportOf(contextId)}));}
// Observed rows outside the selection make no claim; selected checks without an actual row stay not executed.
export function projectSelectedContextRows(rows,checks){
 assert(Array.isArray(rows)&&Array.isArray(checks));const observed=new Map;
 for(const row of rows){const id=key(row);assert(!observed.has(id),'Duplicate context observation '+id);observed.set(id,row);}
 const results=[],notExecuted=[];
 for(const check of checks){const row=observed.get(key(check));if(!row){notExecuted.push({testId:check.testId,contextId:check.contextId,reason:'No actual observation for the selected context'});continue;}
  assert(['passed','failed','blocked','unknown'].includes(row.result));assert.deepEqual(row.actualViewport,viewportOf(check.contextId),'Observed viewport differs from selected context');
  if(row.result==='passed'){assert.match(row.actorRef,/^sha256:[a-f0-9]{64}$/u);if(!check.contextId.startsWith('platform_operator-'))assert.match(row.tenantRef,/^sha256:[a-f0-9]{64}$/u);}
  results.push(row);}
 return{results,notExecuted};
}
