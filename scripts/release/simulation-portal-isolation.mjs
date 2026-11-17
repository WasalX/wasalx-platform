import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ensurePortalOperator,portalOperatorContexts,openPortalTicket,withPortalOperatorEvidence} from './simulation-portal-operator.mjs';
import {downloadPortalMailAttachment} from './simulation-portal-mail-browser.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {actionResponse} from './simulation-native-media-ui.mjs';
import {enableNativeWorkspaceAccessUi} from './simulation-native-account-linking.mjs';
import {waitForNativeProjectionSettlement} from './simulation-native-identity-contract.mjs';
import {ensurePortalTeamGrant} from './simulation-portal-groups.mjs';
import {isolationPrefix} from './simulation-security-admission.mjs';
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,positiveId=/^[1-9][0-9]{0,15}$/u,sha=/^[a-f0-9]{64}$/u;
const expectations={ '01':'Known own-tenant resource returns successful expected content.', '02':'Known other-tenant resource is denied without content disclosure.', 'detail-3':'Other-tenant records/snippets do not appear.', 'detail-4':'Asset bytes are unavailable across the tenant boundary.' };
export const portalIsolationDefinitions=Object.entries(expectations).map(([leaf,expected])=>({id:isolationPrefix+leaf+'::portal',supersedesTestId:isolationPrefix+leaf,surface:'portal',expectedResults:[expected],requiredContextIds:['tenant_owner','agent'].flatMap(role=>portalOperatorContexts(role).filter(c=>!leaf.startsWith('detail-')||c.contextId.endsWith('-desktop')).map(c=>c.contextId))}));
export const portalIsolationTestIds=portalIsolationDefinitions.map(d=>d.id);
export const portalIsolationChecks=portalIsolationDefinitions.flatMap(d=>d.requiredContextIds.map(contextId=>({testId:d.id,contextId})));
export const portalIsolationContextRequirements=Object.fromEntries(portalIsolationDefinitions.map(d=>[d.id,d.requiredContextIds]));

function resource(value){
 assert(value&&typeof value==='object');for(const key of ['tenantId','instanceId'])assert.match(value[key]??'',uuid);
 for(const key of ['ticketId','ticketNumber','articleId'])assert.match(value[key]??'',positiveId);
 assert.match(value.marker??'',/^wasalx-isolation-[a-z0-9-]{8,100}$/u);
 assert.match(value.attachment?.id??'',positiveId);assert.match(value.attachment?.sha256??'',sha);
 assert(typeof value.attachment.filename==='string'&&value.attachment.filename.length>0&&value.attachment.filename.length<=255);
 assert(Number.isSafeInteger(value.attachment.bytes)&&value.attachment.bytes>0&&value.attachment.bytes<=50_000_000);
 return value;
}
// This validates identity, never substitutes a missing fixture with an unavailable-service PASS.
export function admitPortalIsolation(s,{namespace,inputs}){
 const fixture=inputs.nativeIsolation,capability=s.capabilities?.nativeIsolation;
 assert.match(namespace,/^[a-zA-Z0-9-]{1,40}$/u);assert(s.model.name.startsWith('wasalx-simulation-'));
 assert.equal(fixture?.evidenceMode,'simulated');assert.equal(fixture.namespace,namespace);assert.equal(fixture.project,s.model.name);assert.match(fixture.modelSha256??'',sha);
 const primary=resource(fixture.primary),secondary=resource(fixture.secondary);
 assert.equal(primary.tenantId,s.tenantId);assert.notEqual(primary.tenantId,secondary.tenantId);assert.notEqual(primary.instanceId,secondary.instanceId);
 assert.notEqual(primary.ticketNumber,secondary.ticketNumber);assert.notEqual(primary.marker,secondary.marker);assert.notEqual(primary.attachment.sha256,secondary.attachment.sha256);
 assert(capability&&typeof capability.verify==='function');assert.equal(capability.secondarySession?.tenantId,secondary.tenantId);assert.equal(capability.secondarySession.model.name,s.model.name);
 assert.equal(capability.secondarySession.nativeReadService,'zammad-isolation-railsserver');assert.equal(capability.secondarySession.operatorSurface,'portal');
 assert.equal(capability.secondarySession.ownerId,s.ownerId,'Existing shared owner only; no new account or role alias');assert.notEqual(capability.secondarySession.ownerPage,s.ownerPage,'Secondary support owns a separate session; primary workspace must not be switched');
 assert(s.capabilities.secondActor?.page);assert.notEqual(s.capabilities.secondActor.userId,s.ownerId);
 return{fixture,capability,primary,secondary};
}
export function assertNativeIsolationReadback(expected,{ticket,article,attachment,absence}){
 assert.equal(String(ticket.id),expected.ticketId);assert.equal(String(ticket.number),expected.ticketNumber);assert(ticket.title.includes(expected.marker));
 assert.equal(String(article.id),expected.articleId);assert.equal(String(article.ticket_id),expected.ticketId);assert(article.body.includes(expected.marker));
 assert(article.attachments.some(file=>String(file.id)===expected.attachment.id&&file.filename===expected.attachment.filename));
 assert.equal(attachment.filename,expected.attachment.filename);assert.equal(attachment.byteSize,expected.attachment.bytes);assert.equal(attachment.sha256,expected.attachment.sha256);
 assert.deepEqual(absence,{ticketIdAbsent:true,ticketNumberAbsent:true,markerAbsent:true},'Foreign native identifiers collide with a local record');
}
export async function verifyPortalIsolationFixture(capability,fixture){
 const current=await capability.verify(fixture);assert.equal(current.modelSha256,fixture.modelSha256);
 for(const name of ['primary','secondary']){assert.equal(current[name].tenantId,fixture[name].tenantId);assert.equal(current[name].instanceId,fixture[name].instanceId);assert.equal(current[name].state,'WORKING');assertNativeIsolationReadback(fixture[name],current[name].evidence);}
 assert.deepEqual(current.separation,{database:true,search:true,storage:true,secrets:true});return current;
}
async function waitIsolationListRender(page){
 await page.locator('aside').filter({has:page.locator('#inbox-search')}).locator('p[aria-busy="true"]').waitFor({state:'hidden'});
}
export async function ensurePortalIsolationListVisible(page){
 const input=page.locator('#inbox-search');await input.waitFor({state:'attached'});
 if(!await input.isVisible())await page.getByRole('button',{name:'Back to conversations',exact:true}).click();
 await input.waitFor({state:'visible'});await waitIsolationListRender(page);return input;
}
export function assertIsolationSearchPositive(page,own){
 assert(Array.isArray(page?.items)&&page.items.length===1,'Actual query search must return exactly the known own case; universal empty search is not isolation proof');
 const [ticket]=page.items;assert.equal(String(ticket.id),own.ticketId);assert.equal(String(ticket.number),own.ticketNumber);assert(typeof ticket.title==='string'&&ticket.title.includes(own.marker));
}
export async function searchPortalIsolationPositive(operator,own){
 const input=await ensurePortalIsolationListVisible(operator.page);
 const response=await actionResponse(operator.page,r=>{try{const b=r.request().postDataJSON();return new URL(r.url()).pathname==='/api/inbox'&&b.operation==='LIST'&&b.input.query===own.marker&&!b.input.ticket_number;}catch{return false;}},()=>input.fill(own.marker));
 assert.equal(response.status(),200);assertIsolationSearchPositive(await response.json(),own);await waitIsolationListRender(operator.page);
 // This response belongs to the query input, not the selected-number fallback lookup.
 return{actualSearchInput:true,ownQueryMatched:true};
}
async function positive(operator,own){
 const ui=await openPortalTicket(operator,{ticketNumber:own.ticketNumber,articleId:own.articleId,marker:own.marker,reload:true});assert.equal(ui.renderedTicketId,own.ticketId);
 const download=await downloadPortalMailAttachment(operator,{ticketNumber:own.ticketNumber,articleId:own.articleId,filename:own.attachment.filename});
 assert.equal(download.bytes.length,own.attachment.bytes);assert.equal(download.sha256,own.attachment.sha256);
 const query=await searchPortalIsolationPositive(operator,own);
 return{...query,actualInboxRender:true,reloaded:true,actualDownloadControl:true,bytes:download.bytes.length,sha256:download.sha256};
}
export function assertIsolationDenial(status){assert.equal(status,404,'Collision-free absent target must return 404; auth, CSRF, permission changes, outage and transport failures do not qualify');}
async function denyTicket(operator,foreign){
 let status;try{await operator.read('SHOW',{ticket_id:foreign.ticketId});}catch(error){status=error.status;}
 assertIsolationDenial(status);
 // Exercise the real friendly-number deep link and wait for its exact server lookup.
 const response=await actionResponse(operator.page,r=>{try{const b=r.request().postDataJSON();return new URL(r.url()).pathname==='/api/inbox'&&b.operation==='LIST'&&b.input.ticket_number===foreign.ticketNumber;}catch{return false;}},async()=>{await operator.page.goto(operator.session.portalOrigin+'/app?view=inbox&ticket='+encodeURIComponent(foreign.ticketNumber));});
 assert.equal(response.status(),200);assert.deepEqual((await response.json()).items,[]);await ensurePortalIsolationListVisible(operator.page);
assert.equal(await operator.page.locator('[data-article-id]').count(),0);
 assert(!(await operator.page.locator('main').innerText()).includes(foreign.marker));
 assert.equal((await operator.read('CHECK')).allowed,true);return{specificTargetDenied:status,friendlyDeepLinkEmpty:true,noContentDisclosure:true};
}
async function absentSearch(operator,foreign){
 const input=await ensurePortalIsolationListVisible(operator.page);
 const response=await actionResponse(operator.page,r=>{try{const b=r.request().postDataJSON();return new URL(r.url()).pathname==='/api/inbox'&&b.operation==='LIST'&&b.input.query===foreign.marker;}catch{return false;}},()=>input.fill(foreign.marker));
 assert.equal(response.status(),200);assert.deepEqual((await response.json()).items,[]);await waitIsolationListRender(operator.page);
 assert(!(await operator.page.locator('main').innerText()).includes(foreign.marker));
 assert.equal(await operator.page.locator('[data-article-id]').count(),0);return{actualSearchInput:true,currentServerResults:0,noForeignSnippets:true};
}
async function denyMedia(operator,foreign){
 const request=createSyntheticRequest({page:operator.page,origin:operator.session.portalOrigin,runId:operator.session.runId,checkpoint:operator.session.checkpoint});
 const response=await actionResponse(operator.page,r=>{try{const b=r.request().postDataJSON();return new URL(r.url()).pathname==='/api/inbox/attachment'&&String(b.ticket_id)===foreign.ticketId&&String(b.article_id)===foreign.articleId&&String(b.attachment_id)===foreign.attachment.id;}catch{return false;}},async()=>{
  await assert.rejects(()=>request('/api/inbox/attachment','POST',{ticket_id:foreign.ticketId,article_id:foreign.articleId,attachment_id:foreign.attachment.id}),/HTTP 404;/u);
 });assertIsolationDenial(response.status());const bytes=await response.body();assert(bytes.length<=4096);assert.notEqual(createHash('sha256').update(bytes).digest('hex'),foreign.attachment.sha256);
 assert.equal((await operator.read('CHECK')).allowed,true);return{exactAttachmentEndpointDenied:response.status(),assetBytesUnavailable:true,observation:'authenticated portal request; unavailable foreign attachment has no rendered download control'};
}
export async function portalIsolationStage(s,args){
 const {fixture,capability,primary,secondary}=admitPortalIsolation(s,args);const saved={owner:s.ownerPage.viewportSize(),agent:s.capabilities.secondActor.page.viewportSize(),secondary:capability.secondarySession.ownerPage.viewportSize()};const results=[];
 try{
  await verifyPortalIsolationFixture(capability,fixture);
  const secondaryOwner=await ensurePortalOperator(capability.secondarySession,{role:'tenant_owner',viewport:{width:1440,height:1000}});
  const foreignPositive=await positive(secondaryOwner,secondary);await s.checkpoint({phase:'native-isolation-foreign-positive',surface:'portal',role:'tenant_owner',binding:await secondaryOwner.verify(),proof:foreignPositive,supportingOnly:true});
  for(const role of ['tenant_owner','agent'])for(const context of portalOperatorContexts(role)){
   await verifyPortalIsolationFixture(capability,fixture);const operator=await ensurePortalOperator(s,{role,viewport:context.viewport});
   const output=await withPortalOperatorEvidence(operator,async()=>{
    const rows=[],record=async(leaf,run)=>{const startedAt=new Date().toISOString(),proof=await run();rows.push({testId:isolationPrefix+leaf+'::portal',contextId:context.contextId,result:'passed',startedAt,finishedAt:new Date().toISOString(),evidenceMode:'simulated',proof});};
    await record('01',()=>positive(operator,primary));await record('02',()=>denyTicket(operator,secondary));
    if(context.contextId.endsWith('-desktop')){await record('detail-3',()=>absentSearch(operator,secondary));await record('detail-4',()=>denyMedia(operator,secondary));}
    // The exact same operations still succeed after denials; no global outage can qualify.
    await positive(operator,primary);await verifyPortalIsolationFixture(capability,fixture);return{results:rows};
   },{testIds:portalIsolationTestIds});results.push(...output.results);for(const row of output.results)await s.checkpoint({phase:'portal-isolation-proof',...row});
  }
  assert.equal(results.length,16);return{evidenceMode:'simulated',namespace:args.namespace,tenantId:s.tenantId,results,proofs:results,testIds:portalIsolationTestIds};
 }finally{
  await s.ownerPage.setViewportSize(saved.owner);await s.capabilities.secondActor.page.setViewportSize(saved.agent);await capability.secondarySession.ownerPage.setViewportSize(saved.secondary);
  await s.verifyOwner(s.ownerPage,s.ownerId,'tenant_owner',s.tenantId);await s.verifyOwner(s.capabilities.secondActor.page,s.capabilities.secondActor.userId,'agent',s.tenantId);
  await capability.secondarySession.verifyOwner(capability.secondarySession.ownerPage,s.ownerId,'tenant_owner',secondary.tenantId);
 }
}

// Setup only, never operator qualification: current shared owner, no new identity/membership.
export async function admitSecondaryPortalOwner(s,{namespace,secondary}){
 assert(s.model.name.startsWith('wasalx-simulation-'));assert.match(namespace,/^[a-zA-Z0-9-]{1,40}$/u);
 assert.match(secondary.tenantId??'',uuid);assert.notEqual(secondary.tenantId,s.tenantId);assert.match(secondary.instanceId??'',uuid);assert.match(secondary.nativeGroupId??'',positiveId);
 const workspaces=await s.ownerPage.evaluate(async()=>{const r=await fetch('/api/workspaces',{cache:'no-store'});if(!r.ok)throw Error('Workspace admission unavailable');return(await r.json()).data;});
 assert.equal(workspaces.filter(w=>w.id===secondary.tenantId&&w.role==='tenant_owner').length,1);
 const context=await s.browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});s.contexts.push(context);const page=await context.newPage();let complete=false;
 try{
  await page.goto(s.portalOrigin+'/auth/login?return_to=/app&tenant_id='+encodeURIComponent(secondary.tenantId),{waitUntil:'domcontentloaded'});if(new URL(page.url()).origin===s.keycloakOrigin)await s.authenticateOwnerPending(page);
  await s.verifyOwner(page,s.ownerId,'tenant_owner',secondary.tenantId);
  await page.goto(s.portalOrigin+'/auth/login?step_up=privileged&return_to=/app&tenant_id='+encodeURIComponent(secondary.tenantId),{waitUntil:'domcontentloaded'});if(new URL(page.url()).origin===s.keycloakOrigin)await s.authenticateOwnerPending(page);
  const binding=await s.verifyOwner(page,s.ownerId,'tenant_owner',secondary.tenantId);assert(binding.userMatched&&binding.workspaceMatched);
  const scoped=async(sql,params=[])=>{await s.db.query('BEGIN READ ONLY');try{await s.db.query("SELECT set_config('app.tenant_id',$1,true)",[secondary.tenantId]);return(await s.db.query(sql,params)).rows;}finally{await s.db.query('ROLLBACK');}};
  const view={...s,tenantId:secondary.tenantId,ownerPage:page,actorBinding:binding,scoped,nativeReadService:'zammad-isolation-railsserver',verifyOwner:(p,id=s.ownerId,role='tenant_owner',tenant=secondary.tenantId)=>{assert.equal(tenant,secondary.tenantId);return s.verifyOwner(p,id,role,tenant);}};
  // Never retain the primary closure, which would step up its own page/workspace.
  view.ensurePrivilegedOwner=async()=>{await page.goto(s.portalOrigin+'/auth/login?step_up=privileged&return_to=/app&tenant_id='+encodeURIComponent(secondary.tenantId),{waitUntil:'domcontentloaded'});if(new URL(page.url()).origin===s.keycloakOrigin)await s.authenticateOwnerPending(page);return view.verifyOwner(page);};
  const rows=await scoped('SELECT id,state FROM zammad_instances WHERE tenant_id=$1',[secondary.tenantId]);assert.deepEqual(rows.map(r=>({id:r.id,state:r.state})),[{id:secondary.instanceId,state:'WORKING'}]);
  const read=()=>page.evaluate(async()=>{const r=await fetch('/api/team/workspace-access',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('Secondary workspace access unavailable');return r.json();});
  const original=await read();assert.equal(original.enabled,false,'Fresh secondary opt-in only; existing or unknown outcome requires owned receipt reconciliation, never replay');
  await s.checkpoint({phase:'native-isolation-owner-optin-preimage',namespace,tenantId:secondary.tenantId,enabled:false});
  await enableNativeWorkspaceAccessUi(view,{namespace,minimumReview:1});
  await waitForNativeProjectionSettlement(read,[{userId:s.ownerId,memberState:'ACTIVE',revision:1}]);
  const operator=await ensurePortalOperator(view,{role:'tenant_owner'});await ensurePortalTeamGrant(view,{operator,nativeGroupId:secondary.nativeGroupId});await operator.verify();
  await s.checkpoint({phase:'native-isolation-secondary-owner-admitted',namespace,binding:await operator.verify(),supportingOnly:true});complete=true;return view;
 }finally{if(!complete)await context.close();}
}
