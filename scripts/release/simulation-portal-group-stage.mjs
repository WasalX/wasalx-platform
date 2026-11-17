import assert from 'node:assert/strict';
import {definitions} from './simulation-native-group-definitions.mjs';
import {admitNativeGroup} from './simulation-native-group-stage.mjs';
import {runNativeNeutralScenario} from './simulation-native-neutral.mjs';
import {admitNativeQualityDefinitions} from './simulation-native-quality-admission.mjs';
import {qualityRequestObservers} from './simulation-quality-request-observers.mjs';
import {ensurePortalOperator,portalOperatorContexts,capturePortalOperatorEvidence,bindPortalOperatorResult,openPortalGroup,readPortalOperation} from './simulation-portal-operator.mjs';
import {portalSuccessorId,portalGroupRow,portalGroupUrl,portalGroupCatalogBoundary,groupOperation,groupInput,sha} from './simulation-portal-groups.mjs';

export {portalGroupDefinitions} from './simulation-portal-group-definitions.mjs';
export const portalGroupContexts=()=>portalOperatorContexts('agent','en');
export async function portalGroupQualityStage(session,args){
 assert.equal(args.inputs.portalTeamAccess?.namespace,args.namespace);assert.equal(args.inputs.portalTeamAccess.tenantId,session.tenantId);assert.equal(String(args.inputs.portalTeamAccess.nativeGroupId),String(args.inputs.group.zammadGroupId));
 const g=admitNativeGroup(session,args),operator=await ensurePortalOperator(session,{role:'agent'});
 return runNativeNeutralScenario({...session,origin:session.portalOrigin,runId:args.namespace,connectionId:g.connectionId,groupId:g.groupId,externalGroupId:g.groupRef,
 catalogRead:async groupId=>({status:200,value:await readPortalOperation(operator,'GROUP_LIST',{scope:'ALL',selected:groupId})}),
 nativeQuality:async({messageId})=>{const results=[];for(const context of portalGroupContexts()){
  const packet=await runPortalGroupQuality({operator,groupId:g.groupId,messageId,checkpoint:session.checkpoint,providerRead:session.directCallbacks.providerRead,testDefinitions:definitions,...context});results.push(...packet.results);
 }return{evidenceMode:'simulated',surface:'portal',namespace:args.namespace,tenantId:session.tenantId,groupId:g.groupId,messageId,results,limitations:['One owned neutral inbound reused across the three explicit portal agent contexts.','Historical native executions are not inherited.']};}});
}

export async function runPortalGroupQuality({operator,groupId,messageId,checkpoint,providerRead,testDefinitions,viewport,contextId}){
 const {page}=operator,origin=operator.session.portalOrigin,results=[],mutationRequests=[],readMarkers=[];
 await page.setViewportSize(viewport);await operator.verify();const prefixes=admitNativeQualityDefinitions(testDefinitions);
 const beforeProvider=await providerRead(),url=portalGroupUrl(origin,groupId),row=()=>portalGroupRow(operator,messageId);
 const record=async(suffix,status,proof,startedAt)=>{const binding=await capturePortalOperatorEvidence(operator);
  for(const prefix of prefixes){const oldId=`${prefix}::ui-quality::${suffix}`,value=bindPortalOperatorResult({testId:portalSuccessorId(oldId),supersedesTestId:oldId,result:status,startedAt,finishedAt:new Date().toISOString(),contextId,evidenceMode:'simulated',actualViewport:page.viewportSize(),proof:{...proof,sharedSurface:'portal-groups',viewport:page.viewportSize()}},binding);results.push(value);await checkpoint({phase:'portal-group-quality',...value});}
 };
 const check=async(suffix,fn)=>{const startedAt=new Date().toISOString();try{await record(suffix,'passed',await fn(),startedAt);}catch(error){await record(suffix,'failed',{errorClass:error.name,errorSha256:sha(String(error.message))},startedAt);}};
 const reads=new Set(['GROUP_CHECK','GROUP_LIST','GROUP_SHOW','GROUP_MESSAGES','GROUP_CONTEXT','GROUP_TICKETS','GROUP_TEAMS','GROUP_PARTICIPANTS']);
 const guard=async route=>{const request=route.request(),path=new URL(request.url()).pathname,op=groupOperation(request);
  if(new URL(request.url()).origin!==origin)return route.fallback();
  if(op==='GROUP_READ'){readMarkers.push(groupInput(request));return route.continue();}
  if(op?.startsWith('GROUP_')&&!reads.has(op)||path==='/api/inbox/group-upload'){mutationRequests.push({operation:op,path});return route.abort();}
  return route.fallback();
 };
 await page.route('**/api/**',guard);
 try{
  const network=[],errors=[],o=qualityRequestObservers(page,origin,network,errors),handlers={request:o.onRequest,requestfinished:o.finished,requestfailed:o.failed,console:m=>{if(m.type()==='error')errors.push({kind:'console'});},pageerror:()=>errors.push({kind:'pageerror'})};
  const monitorAt=new Date().toISOString();for(const[k,v]of Object.entries(handlers))page.on(k,v);
  await check('reload',async()=>{await openPortalGroup(operator,{groupId,messageId});const input={group_id:groupId,message_id:messageId},messages=await readPortalOperation(operator,'GROUP_CONTEXT',input),tickets=await readPortalOperation(operator,'GROUP_TICKETS',{group_id:groupId,state:'ALL'});assert(messages.items.some(m=>m.id===messageId));await o.reload();await row().waitFor();assert.deepEqual(await readPortalOperation(operator,'GROUP_CONTEXT',input),messages);assert.deepEqual(await readPortalOperation(operator,'GROUP_TICKETS',{group_id:groupId,state:'ALL'}),tickets);return{groupId,messageId,durableReadsStable:true};});
  try{await o.flush();}catch{errors.push({kind:'drain-timeout'});}finally{for(const[k,v]of Object.entries(handlers))page.off(k,v);}
  const reloaded=results.some(r=>r.supersedesTestId.endsWith('::reload')&&r.result==='passed');
  await record('console',!reloaded?'blocked':errors.length?'failed':'passed',{errors},monitorAt);
  await record('network',!reloaded?'blocked':errors.length||network.some(r=>r.status>=400||r.classification==='unclassified request failure')?'failed':'passed',{network},monitorAt);
  for(const mode of ['delay','empty','error']){
   let release,seenResolve;const held=new Promise(r=>release=r),seen=new Promise(r=>seenResolve=r);let intercepted=0;
   const handler=portalGroupCatalogBoundary({origin,mode,held,onSeen:()=>{intercepted++;seenResolve();}});await page.route('**/api/inbox',handler);
   const at=new Date().toISOString();let status='passed',proof;
   try{await page.goto(url);let timer;try{await Promise.race([seen,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Actual portal GROUP_LIST missing')),10000))]);}finally{clearTimeout(timer);}
    const surface=page.locator('.wx-group');
    if(mode==='delay'){await surface.getByText('Loading…',{exact:true}).waitFor();assert.equal(await surface.getByText(/^No groups in this view/).count(),0);assert.equal(await surface.locator('.wx-group-composer').count(),0);release();await page.unroute('**/api/inbox',handler);await openPortalGroup(operator,{groupId,messageId});proof={intercepted,visibleLoading:true,unresolvedControlsAbsent:true,recovered:true};}
    if(mode==='empty'){await surface.getByText(/^No groups in this view/).waitFor();assert.equal(await surface.locator('[data-message-id]').count(),0);assert.equal(await surface.locator('[role=alert]').count(),0);await page.unroute('**/api/inbox',handler);await openPortalGroup(operator,{groupId,messageId});proof={intercepted,emptyVisible:true,noFalseError:true,navigationRecovery:true};}
    if(mode==='error'){const alert=surface.locator('[role=alert]').first();await alert.waitFor();const text=await alert.innerText();assert(!text.includes('PRIVATE_TEST_SENTINEL'));assert.equal(await surface.locator('.wx-group-composer').count(),0);await page.unroute('**/api/inbox',handler);await surface.getByRole('button',{name:'Reload groups',exact:true}).click();await row().waitFor();proof={intercepted,visibleFeedback:text,dependentControlsAbsent:true,recovered:true,noOperationRetried:true};}
   }catch(error){status='failed';proof={errorClass:error.name,errorSha256:sha(String(error.message))};}
   finally{release();await page.unroute('**/api/inbox',handler);}
   await record(mode==='delay'?'loading':mode==='empty'?'empty':'safe-error-recovery',status,proof,at);if(mode==='error')await record('degraded',status,proof,at);
  }
  await check('keyboard-focus',async()=>{
   await openPortalGroup(operator,{groupId,messageId});const trigger=row().getByRole('button',{name:'Link message to ticket',exact:true});await trigger.waitFor();
   const limit=await page.locator('button,a[href],input,select,textarea,[tabindex]').count()+20;let reached=false;
   for(let n=0;n<limit;n++){await page.keyboard.press('Tab');if(await trigger.evaluate(e=>e===document.activeElement)){reached=true;break;}}
   assert(reached,'Invoking control must be reachable with Tab');await page.keyboard.press('Enter');const dialog=page.getByRole('dialog');await dialog.waitFor();const cancel=dialog.getByRole('button',{name:'Cancel',exact:true});
   for(let n=0;n<12&&!(await cancel.evaluate(e=>e===document.activeElement));n++)await page.keyboard.press('Tab');
   const focus=await cancel.evaluate(e=>{const s=getComputedStyle(e);return{active:e===document.activeElement,visible:e.matches(':focus-visible'),outline:s.outlineStyle,width:s.outlineWidth};});assert(focus.active&&focus.visible&&focus.outline!=='none'&&parseFloat(focus.width)>0);
   await page.keyboard.press('Shift+Tab');assert(!(await cancel.evaluate(e=>e===document.activeElement)));await page.keyboard.press('Tab');assert(await cancel.evaluate(e=>e===document.activeElement));await page.keyboard.press('Enter');await dialog.waitFor({state:'hidden'});assert(await trigger.evaluate(e=>e===document.activeElement));return{focus,keyboardDismissal:true,focusRestored:true,noSubmit:true};
  });
 }finally{await page.unroute('**/api/**',guard);const providerUnchanged=JSON.stringify(await providerRead())===JSON.stringify(beforeProvider);await checkpoint({phase:'portal-group-quality-safety',mutationRequests,readMarkers,providerUnchanged});assert.equal(mutationRequests.length,0);assert(providerUnchanged);}
 assert.equal(results.length,testDefinitions.length);return{status:'portal-group-quality-collected',results,noProviderEffects:true};
}
