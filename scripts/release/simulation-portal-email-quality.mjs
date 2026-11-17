import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {capturePortalOperatorEvidence,bindPortalOperatorResult,openPortalTicket,privateNativeRead} from './simulation-portal-operator.mjs';
import {qualityRequestObservers} from './simulation-quality-request-observers.mjs';
import {reachByTab} from './simulation-direct-quality.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const portalMailReadOperations=new Set(['CHECK','LIST','SHOW','ARTICLES','ARTICLE_CONTENT','CREATE_OPTIONS','PREVIEW']);
export function portalMailReadRequest(request,origin){
 const url=new URL(request.url());if(url.origin!==origin)return true;
 if(['GET','HEAD','OPTIONS'].includes(request.method()))return true;
 if(url.pathname==='/api/inbox/attachment'&&request.method()==='POST'&&!url.search){
  try{const input=request.postDataJSON(),keys=['ticket_id','article_id','attachment_id'];return input&&Object.getPrototypeOf(input)===Object.prototype&&Object.keys(input).sort().join(',')===[...keys].sort().join(',')&&keys.every(key=>(typeof input[key]==='string'||Number.isSafeInteger(input[key]))&&/^[1-9][0-9]{0,15}$/u.test(String(input[key])));}catch{return false;}
 }
 if(url.pathname!=='/api/inbox'||request.method()!=='POST')return false;
 try{return portalMailReadOperations.has(request.postDataJSON()?.operation);}catch{return false;}
}
export function portalTicketRead(request,origin,ticketId){
 try{const url=new URL(request.url()),body=request.postDataJSON();return url.origin===origin&&url.pathname==='/api/inbox'&&request.method()==='POST'&&body.operation==='SHOW'&&String(body.input?.ticket_id)===String(ticketId);}catch{return false;}
}
async function protectedComposer(page){const control=page.locator('#inbox-message');assert(await control.count()===0||!(await control.isVisible())||!(await control.isEnabled()),'Unresolved ticket exposed an enabled composer');}
export async function runPortalEmailQuality(args){assert.equal(args.testDefinitions.length,16);return {...await runPortalTicketQuality({...args,definitionsPerKind:2,checkpointPhase:'portal-email-quality'}),noNewMail:true};}
export function ticketQualityKinds(definitions,perKind=1){
 const supported=['loading','safe-error-recovery','reload','keyboard-focus','console','network','empty','degraded'];
 assert(Array.isArray(definitions)&&definitions.length>0);assert.equal(new Set(definitions.map(row=>row.id)).size,definitions.length);
 const kinds=new Set();for(const row of definitions){const kind=row.historicalTestId?.split('::').at(-1);assert(supported.includes(kind),'Unsupported exact ticket quality assertion');kinds.add(kind);}
 for(const kind of kinds)assert.equal(definitions.filter(row=>row.historicalTestId.endsWith('::'+kind)).length,perKind,'Wrong exact assertion multiplicity');return kinds;
}
export async function runPortalTicketQuality({operator,ticketId,ticketNumber,articleId,expectedArticleIds,namespace,checkpoint,providerRead,testDefinitions,context,definitionsPerKind=1,checkpointPhase='portal-ticket-quality',verifyRetainedRender=async()=>{}}){
 const {page,session}=operator,origin=session.portalOrigin;
 assert.equal(context.surface,'portal');assert.equal(operator.role,'agent');const selectedKinds=ticketQualityKinds(testDefinitions,definitionsPerKind);
 await page.setViewportSize(context.viewport);await operator.verify();
 const read=async()=>({ticket:await privateNativeRead(session,'ticket',{ticketId}),articles:await privateNativeRead(session,'articles',{ticketId})});
 const before=await read(),providerBefore=hash(await providerRead()),results=[],mutations=[];
 assert(expectedArticleIds.every(id=>before.articles.some(article=>String(article.id)===String(id))));
 const ready=async()=>{await page.locator('[data-article-id="'+articleId+'"]').waitFor({state:'visible'});await page.locator('#inbox-message').waitFor({state:'visible'});};
 let retainedRenderProof;const open=async()=>{await openPortalTicket(operator,{ticketNumber,articleId,reload:false});await ready();retainedRenderProof=await verifyRetainedRender({phase:'open'});};
 const guard=async route=>{if(portalMailReadRequest(route.request(),origin))return route.fallback();mutations.push({method:route.request().method(),path:new URL(route.request().url()).pathname});return route.abort('blockedbyclient');};
 const record=async(kind,result,proof,startedAt)=>{
  const binding=await capturePortalOperatorEvidence(operator);assert.deepEqual(binding.viewport,context.viewport);
  const definitions=testDefinitions.filter(row=>row.historicalTestId.endsWith('::'+kind));assert.equal(definitions.length,definitionsPerKind);
  for(const definition of definitions){const row=bindPortalOperatorResult({testId:definition.id,historicalTestId:definition.historicalTestId,result,startedAt,finishedAt:new Date().toISOString(),contextId:context.contextId,evidenceMode:'simulated',proof:{...proof,...(retainedRenderProof===undefined?{}:{retainedRender:retainedRenderProof}),ticketId,articleId,surface:'portal'}},binding);results.push(row);await checkpoint({phase:checkpointPhase,...row});}
 };
 const check=async(kind,action)=>{if(!selectedKinds.has(kind))return;const startedAt=new Date().toISOString();let result='passed',proof;try{proof=await action();}catch(error){result='failed';proof={errorClass:error.name,errorSha256:hash(error.message)};}await record(kind,result,proof,startedAt);};
 await page.route('**/*',guard);
 try{
  await open();
  const network=[],errors=[],observer=qualityRequestObservers(page,origin,network,errors),listeners={request:observer.onRequest,requestfinished:observer.finished,requestfailed:observer.failed,
   console:message=>{if(message.type()==='error')errors.push({kind:'console',sha256:hash(message.text())});},pageerror:error=>errors.push({kind:'pageerror',sha256:hash(error.message)})};
  const observedAt=new Date().toISOString();for(const[event,listener]of Object.entries(listeners))page.on(event,listener);
  try{await check('reload',async()=>{await observer.reload({waitUntil:'domcontentloaded'});await ready();retainedRenderProof=await verifyRetainedRender({phase:'reload'});await operator.verify();assert.deepEqual(await read(),before);return{nativeUnchanged:true,duplicateEffect:false};});await observer.flush();}
  finally{for(const[event,listener]of Object.entries(listeners))page.off(event,listener);}
  if(selectedKinds.has('console'))await record('console',errors.length?'failed':'passed',{errors},observedAt);
  if(selectedKinds.has('network'))await record('network',network.some(row=>row.status>=400||row.status===0&&row.classification!=='owned navigation cancellation')?'failed':'passed',{network},observedAt);
  for(const kind of ['loading','safe-error-recovery','degraded'].filter(kind=>selectedKinds.has(kind)))await check(kind,async()=>{
   await open();let release,seenResolve,count=0;const held=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>seenResolve=resolve);
   const fault=async route=>{if(!portalTicketRead(route.request(),origin,ticketId))return route.fallback();count++;seenResolve();if(kind==='loading'){await held;return route.fallback();}return kind==='degraded'?route.abort('failed'):route.fulfill({status:503,json:{error:'SIMULATED_PRIVATE_SENTINEL'}});};
   await page.route('**/api/inbox',fault);let timer;
   try{
    await Promise.all([page.goto(origin+'/app?view=inbox&ticket='+encodeURIComponent(ticketNumber),{waitUntil:'domcontentloaded'}),Promise.race([seen,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Exact portal ticket read absent')),15000);})])]);
    if(kind==='loading')await page.locator('[aria-busy="true"]').filter({hasText:'Loading conversations'}).first().waitFor({state:'visible'});
    else{await page.getByRole('alert').filter({hasText:'The conversation workspace could not be loaded'}).waitFor({state:'visible'});assert(!(await page.locator('body').innerText()).includes('SIMULATED_PRIVATE_SENTINEL'));}
    await protectedComposer(page);release();await page.unroute('**/api/inbox',fault);
    if(kind==='loading')await ready();else{await page.getByRole('button',{name:'Reload conversations',exact:true}).click();await ready();}
    await operator.verify();return{exactReadCount:count,dependentComposerProtected:true,recovered:true,scope:'Controlled portal ticket read only; no provider-outage claim'};
   }finally{clearTimeout(timer);release();await page.unroute('**/api/inbox',fault);}
  });
  await check('keyboard-focus',async()=>{
   await open();const trigger=page.getByRole('button',{name:'New ticket',exact:true});await reachByTab(page,trigger);await page.keyboard.press('Enter');
   const dialog=page.getByRole('dialog',{name:'New ticket',exact:true});await dialog.waitFor({state:'visible'});
   assert(await dialog.evaluate(element=>{const target=document.activeElement,style=getComputedStyle(target);return element.contains(target)&&target.matches(':focus-visible')&&style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>0;}));
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert(await trigger.evaluate(element=>element===document.activeElement));return{tabReached:true,visibleFocus:true,escapeRestoresFocus:true};
  });
  await check('empty',async()=>{
   await page.goto(origin+'/app?view=inbox',{waitUntil:'domcontentloaded'});const query='no-mail-'+namespace;
   const response=page.waitForResponse(response=>{try{const body=response.request().postDataJSON();return new URL(response.url()).origin===origin&&body.operation==='LIST'&&body.input.query===query;}catch{return false;}});
   await page.locator('#inbox-search').fill(query);const result=await response;assert(result.ok());assert.deepEqual((await result.json()).items,[]);
   await page.getByRole('heading',{name:'No conversations here',exact:true}).waitFor({state:'visible'});await page.locator('#inbox-search').fill('');return{actualReadZero:true,clearFilterAvailable:true};
  });
 }finally{await page.unroute('**/*',guard);await operator.verify();assert.deepEqual(await read(),before);assert.equal(hash(await providerRead()),providerBefore);await checkpoint({phase:checkpointPhase+'-safety',mutations,nativeUnchanged:true,providerUnchanged:true});assert.equal(mutations.length,0);}
 assert.deepEqual(results.map(row=>row.testId).sort(),testDefinitions.map(row=>row.id).sort());return{evidenceMode:'simulated',namespace,results,noNewProviderEffects:true};
}
