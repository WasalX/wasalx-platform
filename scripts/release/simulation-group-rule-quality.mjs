import {verifyOwnerEvidence,bindOwnerEvidenceRows} from './simulation-owner-evidence.mjs';
import {readDirectProviderReceipts} from './simulation-direct-capabilities.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeOwnedGetHandler} from './simulation-owned-get-boundary.mjs';
import {qualityRequestObservers} from './simulation-quality-request-observers.mjs';
import {reachByTab,assertDialogOrder} from './simulation-direct-quality.mjs';
import {findExactGroupPermissionTrigger} from './simulation-group-rule-role-contexts.mjs';
export const prefixes={groups:'group-management/discover-authorize-and-configure-groups',rules:'group-rules/create-test-activate-rollback',commands:'group-rules/commands-triggers-and-friendly-ticket-naming'};
export const suffixes=['loading','safe-error-recovery','reload','keyboard-focus','console','network','empty','degraded'];
export const testIds=Object.values(prefixes).flatMap(p=>suffixes.filter(s=>p!==prefixes.groups||s!=='reload').map(s=>p+'::ui-quality::'+s));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const viewports={desktop:{width:1440,height:1000},tablet:{width:820,height:1180}},digest=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
export function bindGroupRuleQualityRows(rows,{actorId,tenantId,contextId,actualViewport,verifiedContext}){const viewport=contextId==='tenant_owner-en-desktop'?'desktop':contextId==='tenant_owner-en-tablet'?'tablet':null;assert(viewport);assert.deepEqual(actualViewport,viewports[viewport]);const binding={contextId,context:{role:'tenant_owner',locale:'en',viewport,surface:'portal'},actualViewport,actorRef:digest(actorId),tenantRef:digest(tenantId)};const bound=rows.map(row=>{assert.equal(row.contextId,undefined);return{...row,...binding}});return verifiedContext?bindOwnerEvidenceRows(bound,verifiedContext):bound;}
export async function groupRuleFailureProof(error,diagnostic){
 const proof={errorClass:error.name,messageSha256:hash(error.message)};
 if(!diagnostic)return proof;
 const {page,trigger,dialogTitleId,step,stepStartedAt,ownedGetSeen=0}=diagnostic;
 try{
  const triggerCount=Math.min(2,await trigger().count());
  const state=await page.evaluate(id=>{
   const dialog=document.getElementById(id)?.closest('dialog');
   const focused=document.activeElement;
   return{modalPresent:Boolean(dialog),modalOpen:Boolean(dialog?.open),focusCategory:focused===document.body?'body':dialog?.contains(focused)?'dialog':'page'};
  },dialogTitleId);
  return{...proof,diagnostic:{step,stepDurationMs:Date.now()-stepStartedAt,triggerCount,...state,ownedGetSeen:Math.min(2,ownedGetSeen)}};
 }catch{return{...proof,diagnostic:{step,stepDurationMs:Date.now()-stepStartedAt,unavailable:true}};}
}
export function admitFixture(s,{namespace,inputs},providerRead=s.directCallbacks?.providerRead){assert(s.actorBinding?.userMatched&&s.actorBinding?.workspaceMatched);const g=inputs.group;assert.equal(g?.evidenceMode,'simulated');assert.equal(g.namespace,namespace);assert.equal(g.tenantId,s.tenantId);assert(g.groupId);assert(s.ownerPage&&s.portalOrigin);for(const n of ['scoped','checkpoint'])assert.equal(typeof s[n],'function');assert.equal(typeof providerRead,'function');return g;}
export async function checkGroupMemberPickerPointer(page,dialog){
 await dialog.locator('#group-history-subject-type').selectOption('USER');
 assert.equal(await dialog.locator('#group-history-subject-type').inputValue(),'USER');
 const picker=dialog.locator('#group-history-subject');
 assert.equal(await dialog.getByRole('combobox',{name:'Team member',exact:true}).count(),1);
 await picker.waitFor({state:'visible'});assert.equal(await picker.isDisabled(),false,'Restricted-history member picker must be ready');
 await picker.scrollIntoViewIfNeeded();
 const hit=await picker.evaluate(element=>{const r=element.getBoundingClientRect(),target=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return Boolean(target&&(target===element||element.contains(target)));});
 assert(hit,'Group drawer footer intercepts member picker center');
 await picker.click();assert.equal(await picker.getAttribute('aria-expanded'),'true');
 await dialog.locator('#group-history-subject-options').waitFor({state:'visible'});
 await page.keyboard.press('Escape');
 return{memberPickerCenterHit:true,memberPickerOpened:true,footerDidNotIntercept:true};
}
export async function groupRuleQualityStage(s,args){
 const g=admitFixture(s,args);const actor=await s.verifyOwner(s.ownerPage,s.ownerId,'tenant_owner',s.tenantId);assert(actor.userMatched&&actor.workspaceMatched);
 const f=args.inputs.securityBusiness?.isolationActor,c=s.capabilities.isolationActor;
 assert.equal(f?.evidenceMode,'simulated');assert.equal(f.namespace,args.namespace);assert.equal(f.role,'tenant_owner');assert.notEqual(f.tenantId,s.tenantId);assert.equal(c?.userId,f.userId);assert(c.page);
 const results=[];try{for(const[viewport,actualViewport]of Object.entries(viewports)){const contextId='tenant_owner-en-'+viewport,result=await runGroupRuleQuality({page:s.ownerPage,origin:s.portalOrigin,groupId:g.groupId,namespace:args.namespace,checkpoint:s.checkpoint,providerRead:s.directCallbacks.providerRead,scoped:s.scoped,viewport:actualViewport}),primary=await s.verifyOwner(s.ownerPage,s.ownerId,'tenant_owner',s.tenantId);assert(primary.userMatched&&primary.workspaceMatched);results.push(...bindGroupRuleQualityRows(result.results,{actorId:s.ownerId,tenantId:s.tenantId,contextId,actualViewport:s.ownerPage.viewportSize(),verifiedContext:await verifyOwnerEvidence(s)}));const isolationRaw=await runIsolationRuleEmpty(s,f,c,actualViewport);results.push(...bindGroupRuleQualityRows(isolationRaw,{actorId:c.userId,tenantId:f.tenantId,contextId,actualViewport:c.page.viewportSize(),verifiedContext:await verifyOwnerEvidence(s,c.page,c.userId,f.tenantId)}))}}finally{await s.ownerPage.setViewportSize(viewports.desktop);await c.page.setViewportSize(viewports.desktop)}assert.equal(results.length,46);assert.equal(new Set(results.map(row=>row.testId+'\0'+row.contextId)).size,46);for(const row of results)await s.checkpoint({phase:'group-rule-quality-context',...row});return{evidenceMode:'simulated',namespace:args.namespace,results,testIds,limitations:['Shared rule governance surface reused across two journeys; no business activation or provider outage claim.']};
}
export async function runIsolationRuleEmpty(s,f,c,viewport=viewports.desktop){
 const p=c.page,at=new Date().toISOString(),mutations=[],rows=[];await p.setViewportSize(viewport);
 const binding=await s.verifyOwner(p,c.userId,'tenant_owner',f.tenantId);assert(binding.userMatched&&binding.workspaceMatched);
 const read=()=>p.evaluate(async()=>{const r=await fetch('/api/rule-sets?limit=200',{cache:'no-store'});if(r.status!==200)throw Error('Isolation rule catalog unavailable');return r.json();});
 const guard=async route=>{const r=route.request();if(new URL(r.url()).origin===s.portalOrigin&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push(r.method());return route.abort();}return route.fallback();};await p.route('**/api/**',guard);
 const beforeReceipts=hash(await s.directCallbacks.providerRead());
 try{assert.deepEqual(await read(),[],'A genuine empty authorized catalog is required');let result='passed',proof;try{await p.goto(s.portalOrigin+'/app?view=rules');await p.getByRole('button',{name:'Compare versions',exact:true}).click();const d=p.getByRole('dialog',{name:'Compare, activate, or roll back',exact:true});await d.getByText('No governed rule versions',{exact:true}).waitFor();assert.equal(await d.locator('.rule-version-actions').count(),0);await d.getByRole('button',{name:'Close rule governance',exact:true}).click();await p.reload();proof={actualActorId:c.userId,actualTenantId:f.tenantId,viewport:p.viewportSize(),genuineAuthorizedCatalogEmpty:true,noFaultInjection:true,emptyCopy:'No governed rule versions',unchangedAfterReload:true};}catch(e){result='failed';proof={classification:'requires-review',errorClass:e.name,messageSha256:hash(e.message)};}for(const prefix of [prefixes.rules,prefixes.commands]){const row={testId:prefix+'::ui-quality::empty',result,startedAt:at,finishedAt:new Date().toISOString(),proof};rows.push(row);await s.checkpoint({phase:'group-rule-quality',...row});}
 }finally{await p.unroute('**/api/**',guard);await s.verifyOwner(p,c.userId,'tenant_owner',f.tenantId);assert.deepEqual(await read(),[],'A genuine empty authorized catalog is required');assert.equal(mutations.length,0);assert.equal(hash(await s.directCallbacks.providerRead()),beforeReceipts);}
 return rows;
}
export async function runGroupRuleQuality({page,origin,groupId,namespace,checkpoint,providerRead,scoped,viewport=viewports.desktop,selectedTestIds}){
 const keyboardId=prefixes.groups+'::ui-quality::keyboard-focus';
 const selected=selectedTestIds===undefined?null:new Set(selectedTestIds);
 if(selected)assert.deepEqual([...selected],[keyboardId],'Only the reviewed group keyboard observer may be narrowed');
 const results=[],mutations=[];await page.setViewportSize(viewport);page.setDefaultTimeout(10000);
 const read=p=>page.evaluate(async p=>{const r=await fetch(p,{cache:'no-store'});if(!r.ok)throw Error('Owned read unavailable');return r.json();},p);
 const durable=async()=>({rules:await scoped('SELECT id,state,revision,snapshot_sha256 FROM rule_sets ORDER BY id'),bindings:await scoped('SELECT id,rule_set_id,revision FROM group_bindings ORDER BY id')});
 const before=await durable(),receipts=hash(await providerRead());
 const guard=async route=>{const r=route.request();if(new URL(r.url()).origin===origin&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push({method:r.method(),path:new URL(r.url()).pathname});return route.abort();}return route.fallback();};await page.route('**/api/**',guard);
 const record=async(ps,suffix,result,proof,startedAt)=>{for(const p of ps){if(p===prefixes.groups&&suffix==='reload')continue;if(selected&&!selected.has(p+'::ui-quality::'+suffix))continue;const row={testId:p+'::ui-quality::'+suffix,result,startedAt,finishedAt:new Date().toISOString(),proof:{...proof,viewport:page.viewportSize(),surface:'portal',boundaryMode:'owned-internal-GET',providerSimulation:false}};results.push(row);await checkpoint({phase:'group-rule-quality',...row});}};
 const check=async(ps,suffix,fn,diagnostic)=>{const at=new Date().toISOString();try{const proof=await fn();await record(ps,suffix,'passed',proof,at);return {result:'passed',proof,at};}catch(e){const proof=await groupRuleFailureProof(e,diagnostic?.());await record(ps,suffix,'failed',proof,at);return{result:'failed',proof,at};}};
 try{
  for(const kind of selected?['groups']:['groups','rules']){
   const ps=kind==='groups'?[prefixes.groups]:[prefixes.rules,prefixes.commands],url=origin+'/app?view='+kind,path=kind==='groups'?'/api/groups/'+encodeURIComponent(groupId)+'/binding':'/api/rule-sets?limit=200';
   const d=()=>page.getByRole('dialog').filter({has:page.locator(kind==='groups'?'#group-config-title':'#rule-history-title')});
   const trigger=()=>kind==='groups'?page.getByRole('button',{name:'Configure '+groupName,exact:true}):page.getByRole('button',{name:'Compare versions',exact:true});
   let groupName,groupConnectionId;await page.goto(url);const initial=await read(path);if(kind==='groups'){assert.equal(initial.group_id??initial.id,groupId);groupName=initial.display_name;groupConnectionId=initial.connection_id;assert(groupName&&groupConnectionId);}else assert(Array.isArray(initial)&&initial.length,'Current rule versions required');
   const diagnostic=(step,stepStartedAt,ownedGetSeen=0)=>({page,trigger,dialogTitleId:kind==='groups'?'group-config-title':'rule-history-title',step,stepStartedAt,ownedGetSeen});
    const close=async()=>{if(await d().count())await d().getByRole('button',{name:kind==='groups'?'Close group configuration':'Close rule governance',exact:true}).click();};
    const prepareTrigger=async()=>{if(kind==='groups')return findExactGroupPermissionTrigger(page,{name:groupName,canWrite:true,connectionId:groupConnectionId});const exact=trigger();await exact.waitFor({state:'visible'});return exact;};
    const open=async()=>{await (await prepareTrigger()).click();await d().waitFor();};
    const ready=()=>d().locator(kind==='groups'?'.group-config-form':'.rule-version-list article').first().waitFor();
    const normal=async(onStep=()=>{})=>{onStep('normal-navigation');await page.goto(url);onStep('exact-group-or-rule-trigger');await prepareTrigger();};
   try{
    if(!selected){
    const network=[],consoleFailures=[],observer=qualityRequestObservers(page,origin,network,consoleFailures),listeners={request:observer.onRequest,requestfinished:observer.finished,requestfailed:observer.failed,console:m=>{if(m.type()==='error')consoleFailures.push({kind:'console-error'});},pageerror:()=>consoleFailures.push({kind:'page-error'})};const at=new Date().toISOString();for(const[k,v]of Object.entries(listeners))page.on(k,v);
    try{await check(ps,'reload',async()=>{await open();await ready();const current=await read(path);await close();await observer.reload();await open();await ready();assert.deepEqual(await read(path),current);return{currentFixtureStable:true};});await close();await observer.flush();}finally{for(const[k,v]of Object.entries(listeners))page.off(k,v);}
     await record(ps,'console',consoleFailures.length?'failed':'passed',{consoleFailures},at);await record(ps,'network',network.some(x=>x.status>=400||(x.status===0&&x.classification!=='owned navigation cancellation'))?'failed':'passed',{network},at);
    }
     let keyboardStep='reach-trigger-by-tab',keyboardStepAt=Date.now();const keyboardMark=step=>{keyboardStep=step;keyboardStepAt=Date.now();};
     await check(ps,'keyboard-focus',async()=>{
      await normal(keyboardMark);keyboardMark('reach-trigger-by-tab');
      await reachByTab(page,trigger());keyboardMark('activate-trigger-with-enter');
     await page.keyboard.press('Enter');keyboardMark('wait-dialog-content');await ready();
     keyboardMark('assert-dialog-order');await assertDialogOrder(page,d());
     keyboardMark('assert-visible-focus');await page.keyboard.press('Tab');
     const focused=await d().evaluate(n=>{const e=document.activeElement,s=getComputedStyle(e);return n.contains(e)&&e.matches(':focus-visible')&&((s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0)||s.boxShadow!=='none');});assert(focused);
     keyboardMark('escape-dialog');await page.keyboard.press('Escape');
     keyboardMark('wait-dialog-hidden');await d().waitFor({state:'hidden'});
     keyboardMark('verify-trigger-focus-return');assert(await trigger().evaluate(e=>e===document.activeElement));
     let pointer={};
     if(kind==='groups'&&viewport.width===820){keyboardMark('tablet-member-picker-pointer');await open();await ready();pointer=await checkGroupMemberPickerPointer(page,d());await close();}
     return{keyboardReach:true,forwardReverseOrder:true,visibleFocus:true,escapeReturn:true,...pointer};
     },()=>diagnostic(keyboardStep,keyboardStepAt));await close();
     if(!selected){for(const mode of ['delay','error']){
      await normal();let release,seen=0;const held=new Promise(r=>release=r),handler=makeOwnedGetHandler({origin,path,mode,held,onSeen:()=>seen++});await page.route('**/api/**',handler);
     let faultStep='open-dialog',faultStepAt=Date.now();const faultMark=step=>{faultStep=step;faultStepAt=Date.now();};
     try{const checked=await check(ps,mode==='delay'?'loading':'safe-error-recovery',async()=>{
      await open();faultMark(mode==='delay'?'wait-loading-status':'wait-safe-error-alert');
      if(mode==='delay')await d().locator('[role=status]').filter({hasText:/Loading/}).first().waitFor();
      else{const alert=d().getByRole('alert');await alert.waitFor();faultMark('validate-safe-error-copy');const text=await alert.innerText();assert(text.includes('This service is temporarily unavailable.')&&!text.includes('PRIVATE_TEST_SENTINEL'));}
      faultMark('assert-intercepted-get');assert(seen>0);
      faultMark('assert-actions-hidden');assert.equal(await d().locator(kind==='groups'?'.group-config-form':'.rule-version-actions').count(),0);
      faultMark('release-and-unroute');release();await page.unroute('**/api/**',handler);
      if(mode==='error'){faultMark('reopen-after-error');await close();await open();}
      faultMark('wait-recovered-dialog');await ready();
      faultMark('compare-authoritative-read');assert.deepEqual(await read(path),initial);
      return{exactPath:path,dependentActionsAbsent:true,localizedSafeFeedback:mode==='error',recovered:true};
     },()=>diagnostic(faultStep,faultStepAt,seen));if(mode==='error')await record(ps,'degraded',checked.result,{...checked.proof,capability:'internal catalog/detail unavailable; no provider outage claim'},checked.at);}finally{release();await page.unroute('**/api/**',handler);await close();}
    }
    if(kind==='groups')await check(ps,'empty',async()=>{const search=page.getByPlaceholder('Search groups',{exact:true});await search.fill('no-match-'+namespace);await page.getByText('No matching groups',{exact:true}).waitFor();await search.fill('');await prepareTrigger();return{actualFilterEmpty:true,recovered:true};});}
   }finally{await close();}
  }
 }finally{await page.unroute('**/api/**',guard);assert.equal(mutations.length,0);assert.deepEqual(await durable(),before);assert.equal(hash(await providerRead()),receipts);await checkpoint({phase:'group-rule-quality-safety',noMutations:true,durableUnchanged:true,providerReceiptsUnchanged:true});}
 assert.equal(results.length,selected?1:21);return{evidenceMode:'simulated',namespace,results,testIds:selected?[keyboardId]:testIds,limitations:['Shared rule governance surface reused across two journeys; no business activation or provider outage claim.']};
}


// A retained full3 group fixture supplies the current group; only the exact
// keyboard observer runs in both required contexts. No isolation actor is used.
export async function retainedGroupKeyboardStage(s,args){
 const providerRead=()=>readDirectProviderReceipts(s),g=admitFixture(s,args,providerRead);
 const keyboardId=prefixes.groups+'::ui-quality::keyboard-focus',originalViewport=s.ownerPage.viewportSize();
 const actor=await s.verifyOwner(s.ownerPage,s.ownerId,'tenant_owner',s.tenantId);
 assert(actor.userMatched&&actor.workspaceMatched);
 const results=[];try{for(const[viewport,size]of Object.entries(viewports)){
  const observed=await runGroupRuleQuality({page:s.ownerPage,origin:s.portalOrigin,groupId:g.groupId,namespace:args.namespace,checkpoint:s.checkpoint,providerRead,scoped:s.scoped,viewport:size,selectedTestIds:[keyboardId]});
  assert.equal(observed.results.length,1);assert.equal(observed.results[0].testId,keyboardId);
  const current=await s.verifyOwner(s.ownerPage,s.ownerId,'tenant_owner',s.tenantId);assert(current.userMatched&&current.workspaceMatched);
  const row=bindGroupRuleQualityRows(observed.results,{actorId:s.ownerId,tenantId:s.tenantId,contextId:'tenant_owner-en-'+viewport,actualViewport:s.ownerPage.viewportSize(),verifiedContext:await verifyOwnerEvidence(s)})[0];
  if(viewport==='tablet'&&row.result==='passed'){assert.equal(row.proof.memberPickerCenterHit,true);assert.equal(row.proof.memberPickerOpened,true);}
  results.push(row);await s.checkpoint({phase:'group-rule-quality-context',...row});
 }}
 finally{if(originalViewport)await s.ownerPage.setViewportSize(originalViewport);}
 assert.equal(results.length,2);
 return{evidenceMode:'simulated',namespace:args.namespace,results,testIds:[keyboardId],limitations:['Keyboard and tablet pointer observers on retained group; no provider outage or business activation claim.']};
}
