
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeOwnedGetHandler} from './simulation-owned-get-boundary.mjs';
import {qualityRequestObservers} from './simulation-quality-request-observers.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const prefixes=['choices-location-and-plugin-actions','flow-lifecycle-and-exactly-once-processing','human-handoff-pause-resume-and-bot-return','version-pinned-outbound-media-and-zammad-history'].map(x=>'direct-automation/'+x);
export function qualityIds(){return prefixes.flatMap(p=>['loading','safe-error-recovery','reload','keyboard-focus','console','network','empty','degraded'].filter(s=>!(p.endsWith('flow-lifecycle-and-exactly-once-processing')&&s==='reload')).map(s=>p+'::ui-quality::'+s));}
export const emptyEventPage=()=>({items:[],next_cursor:null,overlay_events:[]});
export async function runDirectConversationQuality({page,origin,checkpoint,verifyOwner,readEffects,output,conversationId,onlyEmpty=false,viewports=[{width:1440,height:1000},{width:820,height:1180}],testIds=qualityIds(),role='tenant_owner',assertPermission=async()=>{}}){
 assert.match(conversationId,/^[a-f0-9-]{36}$/);
 assert(Array.isArray(testIds)&&testIds.length&&new Set(testIds).size===testIds.length);const admitted=new Set(qualityIds());for(const id of testIds)assert(admitted.has(id),'Unsupported direct-quality test ID');
 const incomingViewport=page.viewportSize();
 const results=[],mutations=[],before=await readEffects();
 const path='/api/bot-flows/conversations/'+conversationId+'/events?limit=50';
 const read=p=>page.evaluate(async p=>{const r=await fetch(p,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Read-only admission failed');return r.json();},p);
 const guard=async route=>{const r=route.request(),u=new URL(r.url());if(u.origin===origin&&u.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(r.method())){mutations.push({path:u.pathname,method:r.method()});return route.abort('blockedbyclient');}return route.fallback();};
 await page.route('**/api/**',guard);page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(20000);
 const failures=[];try{for(const viewport of viewports){await page.setViewportSize(viewport);const binding=await verifyOwner(page);assert(binding===true||binding?.role===role);const startedAt=new Date().toISOString();
  const emit=async(suffix,result,proof)=>{if(binding!==true)assert.deepEqual(page.viewportSize(),binding.viewport);for(const testId of testIds.filter(id=>id.endsWith('::'+suffix))){const row={testId,result,startedAt,finishedAt:new Date().toISOString(),viewport:page.viewportSize(),role,locale:'en',sharedSurface:'Direct conversations / retained execution history',...(binding!==true?{actorRef:binding.actorRef,tenantRef:binding.tenantRef,actualViewport:page.viewportSize(),verifiedContext:binding}:{}),proof:{...proof,...(binding!==true?{actorVerified:true}:{})}};results.push(row);await checkpoint({phase:'direct-quality',...row});}};
  let diagnosticStep='not-started';
  const safely=async(suffix,fn)=>{diagnosticStep='not-started';try{await emit(suffix,'passed',await fn());}catch(e){const actionability=await directActionabilitySnapshot(page,trigger()).catch(()=>({unavailable:true}));await emit(suffix,'failed',{errorClass:e.name,reason:'Assertion failed at '+suffix,diagnosticStep,errorMessageSha256:hash(String(e?.message??'')),actionability});}};
  let consoleErrors=0,pageErrors=0;const network=[],observerFailures=[],o=qualityRequestObservers(page,origin,network,observerFailures);
  const normal=async()=>{diagnosticStep='normal-navigation';await o.navigate(origin+'/app?view=automation',{waitUntil:'domcontentloaded'});diagnosticStep='normal-conversations-tab';await page.getByRole('tab',{name:'Conversations',exact:true}).click();diagnosticStep='normal-conversation-list';await page.locator('.bot-conversations').waitFor();};
  await normal();const catalog=await read('/api/bot-flows/conversations?limit=50');const target=catalog.items.find(x=>x.id===conversationId);
  const card=()=>page.locator('.bot-conversation-list article').filter({hasText:String(target.flow_name)}).filter({hasText:new RegExp('#'+String(target.zammad_ticket_number)+'(?:\\D|$)')});
  const trigger=()=>card().getByRole('button',{name:'View execution history',exact:true});
  const open=async()=>{diagnosticStep='card-count';assert.equal(await card().count(),1,'Exact retained conversation UI ambiguous');diagnosticStep='trigger-click';await trigger().click();diagnosticStep='dialog-wait';await page.getByRole('dialog').waitFor();};
  const close=()=>closeDirectHistoryDialog(page.getByRole('dialog'));
  let original;try{assert(target,'Retained conversation absent from first page; do not select unrelated record');await assertPermission({page,role,card:card()});original=await read(path);assert(original.items.length>0);await open();await page.locator('.bot-node-list li').first().waitFor();await page.screenshot({path:output+'/direct-history-'+role+'-'+viewport.width+'.png'});await close();}catch(e){for(const suffix of new Set(testIds.map(id=>id.split('::').at(-1))))await emit(suffix,'failed',{errorClass:e.name,reason:'Retained conversation UI unavailable'});continue;}
  const handlers={console:m=>{if(m.type()==='error')consoleErrors++;},pageerror:()=>pageErrors++,request:o.onRequest,requestfinished:o.finished,requestfailed:o.failed};
  if(!onlyEmpty){for(const [n,h]of Object.entries(handlers))page.on(n,h);
  try{await safely('reload',async()=>{diagnosticStep='reload-clean-navigation';await normal();await open();await page.locator('.bot-node-list li').first().waitFor();const shown=await page.locator('.bot-node-list').innerText();await close();await o.reload();await page.getByRole('tab',{name:'Conversations',exact:true}).click();await open();await page.locator('.bot-node-list li').first().waitFor();assert.equal(await page.locator('.bot-node-list').innerText(),shown);assert.deepEqual(await read(path),original);await close();return{executionId:conversationId,visibleTimelineStable:true,apiHash:hash(original)};});}finally{try{await o.flush();}catch{observerFailures.push({kind:'observer-drain-timeout'});}finally{for(const[n,h]of Object.entries(handlers))page.off(n,h);}}
  const reloadProven=results.some(r=>r.viewport.width===viewport.width&&r.testId.endsWith('::reload')&&r.result==='passed');
  await emit('console',!reloadProven?'blocked':consoleErrors||pageErrors||observerFailures.length?'failed':'passed',{consoleErrors,pageErrors,observerFailures});await emit('network',!reloadProven?'blocked':observerFailures.length||network.some(r=>r.status>=400||r.classification==='unclassified request failure')?'failed':'passed',{network});
  await safely('keyboard-focus',async()=>{diagnosticStep='keyboard-clean-navigation';await normal();diagnosticStep='keyboard-tab-reach';await reachByTab(page,trigger());diagnosticStep='keyboard-open-dialog';await page.keyboard.press('Enter');const d=page.getByRole('dialog');await d.waitFor();diagnosticStep='keyboard-dialog-order';await assertDialogOrder(page,d);const focused=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0||s.boxShadow!=='none';});assert(focused,'Visible focus indicator missing');await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});assert(await trigger().evaluate(e=>e===document.activeElement));return{enterOpened:true,tabInside:true,reverseTabInside:true,visibleFocus:true,escapeClosed:true,focusRestored:true};});await close();
  }for(const mode of (onlyEmpty?['empty']:['delay','error','empty'])){let release,seenResolve;const held=new Promise(r=>release=r),seen=new Promise(r=>seenResolve=r);const handler=makeOwnedGetHandler({origin,path,mode,body:emptyEventPage(),held,onSeen:seenResolve});await page.route('**/api/**',handler);
   try{await safely(mode==='delay'?'loading':mode==='error'?'safe-error-recovery':'empty',async()=>{diagnosticStep='fault-clean-navigation-'+mode;await normal();diagnosticStep='fault-open-'+mode;await open();diagnosticStep='fault-events-get-'+mode;await Promise.race([seen,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Exact events GET absent')),5000);t.unref?.();})]);diagnosticStep='fault-ui-'+mode;const d=page.getByRole('dialog');if(mode==='delay'){await d.getByRole('status',{name:'Loading execution history',exact:true}).waitFor();await assertReadonlyHistory(d);assert.equal(await d.locator('.bot-node-list').count(),0);release();await page.unroute('**/api/**',handler);await d.locator('.bot-node-list li').first().waitFor();await close();return{heldExactEvents:true,noPrematureTimeline:true,readonlyControlsOnly:true,settled:true};}if(mode==='error'){const alert=d.getByRole('alert');await alert.waitFor();await assertReadonlyHistory(d);assert((await alert.innerText()).includes('Execution history could not be loaded'));assert(!(await alert.innerText()).includes('PRIVATE_TEST_SENTINEL'));await page.unroute('**/api/**',handler);await alert.getByRole('button').click();await d.locator('.bot-node-list li').first().waitFor();assert.deepEqual(await read(path),original);await close();return{safeLocalizedFeedback:true,readonlyControlsOnly:true,recoveredByReload:true};}await d.getByText('No timeline events are available.',{exact:true}).waitFor();await page.unroute('**/api/**',handler);await close();await open();await d.locator('.bot-node-list li').first().waitFor();await close();return{emptyTimeline:true,recovered:true};});}finally{release();await page.unroute('**/api/**',handler);await close();}}
  // This is exact events-service degradation, not a claim of provider outage UI.
  if(!onlyEmpty){const recovered=results.filter(r=>r.viewport.width===viewport.width&&r.testId.endsWith('::safe-error-recovery')).every(r=>r.result==='passed');await emit('degraded',recovered?'passed':'failed',{boundary:'Execution-history HTTP 503',explicitUnavailableFeedback:recovered,recoveryVerified:recovered,noProviderAvailabilityClaim:true});}
 }}catch(error){failures.push(error);}
 try{await page.unroute('**/api/**',guard);}catch(error){failures.push(error);}
 try{const after=await readEffects();await checkpoint({phase:'direct-quality-provider-receipts-unchanged',mutations,beforeHash:hash(before),afterHash:hash(after)});assert.equal(mutations.length,0);assert.deepEqual(after,before,'Provider receipt snapshot changed during read-only batch');}catch(error){failures.push(error);}
 try{await page.setViewportSize(incomingViewport);assert.deepEqual(page.viewportSize(),incomingViewport,'Direct-quality viewport was not restored');}catch(error){failures.push(error);}
 if(failures.length===1)throw failures[0];if(failures.length>1)throw new AggregateError(failures,'Direct-quality observation or cleanup failed');
 return{evidenceMode:'simulated',results,expectedTestIds:testIds.filter(id=>!onlyEmpty||id.endsWith('::empty')),effects:0,limitations:['Observed retained conversation surface only; each role and viewport requires its own verified actor session.','No real-provider client or media attachment behavior inferred from timeline quality.']};
}

export async function closeDirectHistoryDialog(dialog){
 if(!await dialog.isVisible().catch(()=>false))return false;
 assert.equal(await dialog.count(),1,'Ambiguous visible execution-history dialog');
 await dialog.getByRole('button',{name:'Close execution history',exact:true}).click();
 await dialog.waitFor({state:'hidden'});return true;
}

export async function directActionabilitySnapshot(page,target){
 const count=await target.count(),element=count===1?await target.evaluate(node=>({connected:node.isConnected,disabled:Boolean(node.disabled),active:document.activeElement===node,tabIndex:node.tabIndex,rectNonzero:Boolean(node.getClientRects().length)})):null;
 const documentState=await page.evaluate(()=>{const visible=node=>Boolean(node.getClientRects().length),all=[...document.querySelectorAll('[role="dialog"],dialog')];return{activeTag:document.activeElement?.tagName??null,roleDialogsVisible:all.filter(node=>node.getAttribute('role')==='dialog'&&visible(node)).length,nativeDialogsVisible:all.filter(node=>node.tagName==='DIALOG'&&visible(node)).length,nativeDialogsOpen:all.filter(node=>node.tagName==='DIALOG'&&node.open).length};});
 return{targetCount:count,element,document:documentState};
}

export async function reachByTab(page,target){
 for(let i=0;i<200;i++){await page.keyboard.press('Tab');if(await target.evaluate(e=>e===document.activeElement))return;}
 assert.fail('History trigger not reachable by Tab within bounded page traversal');
}
export async function assertDialogOrder(page,dialog){
 const state=()=>dialog.evaluate(d=>{const controls=[...d.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')].filter(e=>!e.disabled&&e.tabIndex>=0&&e.getClientRects().length);return {count:controls.length,index:controls.indexOf(document.activeElement)};});
 const before=await state();assert(before.count>0&&before.index>=0,'Dialog initial focus absent');
 await page.keyboard.press('Tab');const forward=await state();assert.equal(forward.index,(before.index+1)%before.count,'Forward order differs from visible DOM order');
 await page.keyboard.press('Shift+Tab');assert.equal((await state()).index,before.index,'Reverse traversal does not restore prior control');
}
export async function assertReadonlyHistory(dialog){
 const controls=await dialog.locator('button,input,select,textarea,a[href]').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,type:e.getAttribute('type'),name:e.getAttribute('aria-label')||e.textContent.trim()})));
 assert(controls.length>=2);for(const c of controls){assert.equal(c.tag,'BUTTON');assert.equal(c.type,'button');assert(['Close execution history','Close','Reload','Load older events','Loading older events…'].includes(c.name),'Unexpected dependent history action');}
 return controls;
}
