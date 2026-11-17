// Existing MetaSignup operator controls and SDK callback seam; actual application HTTP is never intercepted.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {assertFreshAccess,assertTarget,assertAccessOutcome,latestAttemptPath} from './journeys.mjs';
export const uiContexts={
 'tenant_owner-en-desktop':{locale:'en',width:1440,height:1000},'tenant_owner-ar-desktop':{locale:'ar',width:1440,height:1000},
 'tenant_owner-en-mobile':{locale:'en',width:390,height:844},'tenant_owner-ar-mobile':{locale:'ar',width:390,height:844},
};
// Exact reuse of the eight existing positive P05 owner case/context assignments.
export const accessUiSelection=Object.entries(uiContexts).flatMap(([contextId])=>[{mode:'reconnect',contextId},{mode:'add-access',contextId}]);
export function validateUiManifest(m){
 if(!m.ui)return;assert(['reconnect','add-access'].includes(m.mode));assert(uiContexts[m.ui.contextId]);assert(/^[a-f0-9]{64}$/u.test(m.uiHelperSha256));
 if(m.mode==='reconnect')assert(typeof m.target.name==='string'&&m.target.name.length>0&&m.target.name.length<=100);
 for(const path of ['app/MetaSignup.tsx','app/WasalXApp.tsx','lib/meta-signup-sdk.ts','app/api/connections/meta/signup/[...path]/route.ts',...['en','ar'].map(l=>'lib/i18n/messages/'+l+'/tenant.ts')])assert(m.sourceFiles.some(f=>f.path===path&&/^[a-f0-9]{64}$/u.test(f.sha256)));
}
async function labels(root,locale){
 const source=await readFile(resolve(root,'lib/i18n/messages/'+locale+'/tenant.ts'),'utf8');
 return key=>{const line=source.split('\n').find(v=>v.trimStart().startsWith(JSON.stringify(key)+': '));assert(line,'Bound translation missing');const raw=line.trim().slice(JSON.stringify(key).length+2).replace(/,\s*$/u,'');return JSON.parse(raw);};
}
export async function runAccessUi({m,page,localRoot,request,control,observe,poll,lease,checkpoint,capture}){
 validateUiManifest(m);assert.equal(typeof capture,'function');const context=uiContexts[m.ui.contextId],t=await labels(localRoot,context.locale),reconnect=m.mode==='reconnect';
 assert.deepEqual(page.viewportSize(),{width:context.width,height:context.height});
 const before=await observe();assertFreshAccess(await control('GET','/signup'));
 if(reconnect){assertTarget(m,before.target);assert.equal(before.target.connection.name,m.target.name);assert.equal(before.target.connection.state,'PAUSED');assert(before.target.preservation.message_links.count>0&&before.target.preservation.case_correlations.count>0);}else assert.equal(before.available,true);
 const sdkUrl='https://connect.facebook.net/en_US/sdk.js',names=[],writes=[];let sdkLoads=0;
 const sdk=async route=>{sdkLoads++;assert(sdkLoads<=2,'Unexpected SDK document');await route.fulfill({contentType:'text/javascript',body:'window.__wasalxDevCallbacks=[];window.FB={init(c){window.__wasalxDevInit=c},login(callback,options){window.__wasalxDevOptions=options;window.__wasalxDevCallbacks.push(callback)}};'});};
 const watch=req=>{if(req.method()==='POST'&&new URL(req.url()).pathname.startsWith('/api/connections/meta/signup/'))writes.push(new URL(req.url()).pathname);};
 await page.route(sdkUrl,sdk);page.on('request',watch);
 let issuedCode;
 try{
  await page.goto(m.origin+'/app?view=connections'+(reconnect?'&connection='+m.target.connectionId:''),{waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('html').getAttribute('lang'),context.locale);assert.equal(await page.locator('html').getAttribute('dir'),context.locale==='ar'?'rtl':'ltr');
  await page.locator('[data-application-ready="true"]').waitFor({state:'visible',timeout:20000});
  if(reconnect){const open=page.getByRole('button',{name:t('tenant.metaSignup.reconnect.open'),exact:true});await open.focus();await page.keyboard.press('Enter');}
  else{
   await page.getByRole('button',{name:t('tenant.connections.connect'),exact:true}).click();const dialog=page.getByRole('dialog',{name:t('tenant.setup.ariaLabel')});
   await dialog.getByLabel(t('tenant.setup.name.label')).fill('Synthetic existing access '+m.runId);await dialog.getByText(t('tenant.setup.providers.metaTitle'),{exact:true}).click();
   await dialog.getByRole('button',{name:t('tenant.setup.actions.continue'),exact:true}).click();await dialog.getByRole('radio',{name:t('tenant.metaSignup.addAccess.purpose.ADD_ACCESS'),exact:true}).check();
  }
  const section=page.locator('section[aria-labelledby="meta-signup-heading"]');await section.waitFor({state:'visible',timeout:20000});
  const heading=section.getByRole('heading',{name:t(reconnect?'tenant.metaSignup.reconnect.title':'tenant.metaSignup.addAccess.title'),exact:true});await heading.waitFor({state:'visible'});
  if(reconnect)assert.equal(await heading.evaluate(el=>el===document.activeElement),true);
  const key=reconnect?'tenant.metaSignup.reconnect.prepare':'tenant.metaSignup.addAccess.prepare',prepare=section.getByRole('button',{name:t(key),exact:true});
  await poll(async()=>prepare.isEnabled(),Boolean);await lease();await checkpoint({phase:'intent',step:'access-ui-start'});
  const startResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/connections/meta/signup/attempts'&&r.request().method()==='POST',{timeout:25000});
  const [started]=await Promise.all([startResponse,prepare.focus().then(()=>page.keyboard.press('Enter'))]);assert(started.ok());let view=await started.json();
  const startBody=started.request().postDataJSON();assert.equal(startBody.name,reconnect?m.target.name:'Synthetic existing access '+m.runId);assert.equal(startBody.payerMode,'CUSTOMER');
  if(reconnect)assert.equal(startBody.targetConnectionId,m.target.connectionId);else assert.equal(startBody.purpose,'ADD_ACCESS');
  assert.equal(view.status,'AWAITING_AUTHORIZATION');const id=view.attemptId,path='/api/connections/meta/signup/attempts/'+id;
  await lease();await section.getByRole('button',{name:t('tenant.metaSignup.connect'),exact:true}).click();
  const facts=await page.evaluate(()=>({init:window.__wasalxDevInit,options:window.__wasalxDevOptions,count:window.__wasalxDevCallbacks.length}));
  assert.deepEqual(facts.init,{appId:m.fixture.signup.appId,version:'v24.0',cookie:false,xfbml:false,autoLogAppEvents:false});assert.equal(facts.count,1);
  assert.deepEqual(facts.options,{config_id:m.fixture.signup.configId,response_type:'code',override_default_response_type:true,extras:{setup:{}}});
  const issued=await control('POST','/signup/code',{});issuedCode=issued.code;assert(issued.expiresAt>Date.now());
  const [exchanged]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===path+'/exchange'&&r.request().method()==='POST',{timeout:25000}),page.evaluate(code=>{const cb=window.__wasalxDevCallbacks.shift();if(!cb||window.__wasalxDevCallbacks.length)throw Error('Unexpected SDK callback');cb({authResponse:{code}});},issuedCode)]);assert(exchanged.ok());view=await exchanged.json();assert.equal(view.status,'SELECTION_REQUIRED');
  assert.equal(view.choices.length,1);assert.equal(view.choices[0].numberState,'REGISTERED');assert.equal(view.choices[0].selectable,true);assert.equal(await section.locator('input[type="password"]').count(),0);
  const radio=section.getByRole('radio');assert.equal(await radio.count(),1);await radio.focus();await page.keyboard.press('Space');assert.equal(await radio.isChecked(),true);
  const selectKey=reconnect?'tenant.metaSignup.reconnect.select':'tenant.metaSignup.addAccess.select',select=section.getByRole('button',{name:t(selectKey),exact:true});
  const snap=async(name,action=select)=>{await heading.scrollIntoViewIfNeeded();const record=async(n,bytes)=>{assert(bytes.length<10*1024*1024);await capture(n,bytes);names.push({name:n,sha256:createHash('sha256').update(bytes).digest('hex')});};
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal page overflow');
   const box=await action.boundingBox();assert(box&&box.width>=24&&box.height>=24,'Action target smaller than 24 CSS px');
   if(!reconnect&&name==='add-access-paused-completion')await record(name,await page.screenshot());
   else if(context.width<=400||!reconnect){await record(name+'-top',await page.screenshot());await action.scrollIntoViewIfNeeded();await record(name+'-actions',await page.screenshot());}
   else await record(name,await section.screenshot());
  };
  await snap(reconnect?'reconnect-exact-preview':'add-access-selection');await lease();await checkpoint({phase:'intent',step:'access-ui-select',attemptId:id});
  const [selected]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===path+'/select'&&r.request().method()==='POST',{timeout:25000}),select.focus().then(()=>page.keyboard.press('Enter'))]);assert(selected.ok());
  assert.deepEqual(selected.request().postDataJSON(),{expectedRevision:view.revision,selectionRevision:view.selectionRevision,choiceId:view.choices[0].choiceId});
  view=await poll(()=>request(path),v=>!['EXCHANGING','PROVISIONING'].includes(v.status));
  const proof=assertAccessOutcome(m,view,await control('GET','/signup'),await observe(id),before);
  await section.getByText(t(reconnect?'tenant.metaSignup.reconnect.status.COMPLETED':'tenant.metaSignup.addAccess.status.COMPLETED'),{exact:true}).waitFor({state:'visible'});
  await snap(reconnect?'reconnect-paused-completion':'add-access-paused-completion',section.getByRole('button',{name:t('tenant.metaSignup.view'),exact:true}));
  assert.deepEqual(writes,['/api/connections/meta/signup/attempts',path+'/exchange',path+'/select']);
  assert.equal(await page.evaluate(code=>JSON.stringify([localStorage,sessionStorage]).includes(code),issuedCode),false);
  await page.reload({waitUntil:'domcontentloaded'});
  const latest=await request(latestAttemptPath(m));assert.equal(latest.attempt?.attemptId,id);assert.deepEqual(assertAccessOutcome(m,latest.attempt,await control('GET','/signup'),await observe(id),before),proof);
  assert.deepEqual(writes,['/api/connections/meta/signup/attempts',path+'/exchange',path+'/select']);return{...proof,actualUi:true,contextId:m.ui.contextId,screenshots:names,visualReview:'REQUIRED',sdkProvider:'SIMULATED_CALLBACK_ONLY'};
 }finally{page.off('request',watch);await page.unroute(sdkUrl,sdk);issuedCode=undefined;}
}
