import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSyntheticRequest} from './seed-simulation-group.mjs';

const id=/^[1-9][0-9]{0,15}$/u,uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
const digest=value=>'sha256:'+createHash('sha256').update(String(value)).digest('hex');
const receiptReads=new Set(['RECEIPT','CREATE_RECEIPT','GROUP_RECEIPT','GROUP_TICKET_RECEIPT']);
const adminReceipts=new Set(['TEAM_RECEIPT','MAILBOX_RECEIPT']);
const reads=new Set(['CHECK','SOURCE_CONTEXT','LIST','SHOW','ARTICLES','ARTICLE_CONTENT','CREATE_OPTIONS','GROUP_CHECK','GROUP_LIST','GROUP_SHOW','GROUP_MESSAGES','GROUP_CONTEXT','GROUP_TICKETS','GROUP_TEAMS','GROUP_PARTICIPANTS','TEAM_LIST','TEAM_SHOW','TEAM_MEMBERS','MAILBOX_LIST','MAILBOX_SHOW']);
export function portalOperatorContexts(role='agent',locale='en'){
 assert(['tenant_owner','agent'].includes(role)&&['en','ar'].includes(locale));
 return [['desktop',1440,1000],['tablet',820,1180],['mobile',390,844]].map(([name,width,height])=>({contextId:`${role}-${locale}-${name}`,viewport:{width,height},surface:'portal'}));
}
export function assertPortalProjection(rows,{tenantId,userId,subject,role}){
 assert(Array.isArray(rows)&&rows.length===1,'One current managed projection required');const row=rows[0];
 assert.equal(row.tenant_id,tenantId);assert.equal(row.user_id,userId);assert.equal(row.oidc_subject,subject);assert.equal(row.role,role);
 assert(row.source_current===true&&row.sync_state==='READY'&&row.member_state==='ACTIVE','Current managed workspace access is unavailable');
 assert(Number.isSafeInteger(Number(row.revision))&&Number(row.revision)>0&&Number(row.applied_revision)===Number(row.revision),'Managed projection is stale');
 assert.match(String(row.native_user_id),id);assert.match(row.current_instance_id??'',uuid);assert.equal(row.zammad_instance_id,row.current_instance_id);
 return {nativeUserId:String(row.native_user_id),revision:Number(row.revision),instanceId:row.current_instance_id};
}
async function projectedOperator(s,{userId,subject,role}){
 const rows=await s.scoped(`SELECT p.*,z.id AS current_instance_id,
  (t.state='ACTIVE' AND z.state='WORKING' AND p.zammad_instance_id=z.id AND u.oidc_subject=p.oidc_subject AND u.email=p.email
   AND m.role=p.role AND m.state=p.member_state AND ts.native_membership_sync_enabled) AS source_current
  FROM native_membership_projections p JOIN tenants t ON t.id=p.tenant_id JOIN tenant_settings ts ON ts.tenant_id=p.tenant_id
  JOIN users u ON u.id=p.user_id JOIN tenant_memberships m ON m.tenant_id=p.tenant_id AND m.user_id=p.user_id
  JOIN zammad_instances z ON z.tenant_id=p.tenant_id
  WHERE p.tenant_id=$1 AND p.user_id=$2`,[s.tenantId,userId]);
 return assertPortalProjection(rows,{tenantId:s.tenantId,userId,subject,role});
}
export async function ensurePortalOperator(s,{role='agent',viewport,locale='en'}={}){
 assert.equal(s.operatorSurface,'portal','Current producers require the portal surface');assert(['tenant_owner','agent'].includes(role)&&['en','ar'].includes(locale));
 const actor=role==='tenant_owner'?{page:s.ownerPage,userId:s.ownerId,subject:s.ownerSubject}:s.capabilities?.secondActor;
 assert(actor?.page&&typeof actor.userId==='string'&&typeof actor.subject==='string','The existing authenticated portal actor is required');
 const operator={session:s,page:actor.page,userId:actor.userId,subject:actor.subject,role,locale,nativeUserId:null};
 operator.verify=async()=>{
  assert.equal(new URL(operator.page.url()).origin,s.portalOrigin,'Portal actor origin changed');
  const actual=await s.verifyOwner(operator.page,operator.userId,role,s.tenantId);assert(actual?.userMatched&&actual.workspaceMatched);
  const documentLocale=await operator.page.evaluate(()=>document.documentElement.lang);assert.equal(documentLocale,locale,'Actual document locale differs');
  const projection=await projectedOperator(s,operator);if(operator.nativeUserId!==null)assert.equal(operator.nativeUserId,projection.nativeUserId,'Managed native identity changed');
  operator.nativeUserId=projection.nativeUserId;
  const admission=await readPortalOperation(operator,'CHECK',{});assert.equal(admission.allowed,true,'The actual portal workspace did not admit this actor');
  const measured=operator.page.viewportSize();assert(Number.isSafeInteger(measured?.width)&&measured.width>0&&Number.isSafeInteger(measured?.height)&&measured.height>0);
  return {contractVersion:2,surface:'portal',role,locale,actorRef:digest(operator.userId),tenantRef:digest(s.tenantId),viewport:{...measured},verifiedAt:new Date().toISOString(),nativeUserId:projection.nativeUserId,projectionRevision:projection.revision};
 };
 operator.read=(operation,input={})=>readPortalOperation(operator,operation,input);
 if(viewport)await operator.page.setViewportSize(viewport);await operator.verify();return operator;
}
// CHECK uses the real signed bridge; never enables linking, grants a queue, or repairs access.
export async function readPortalOperation(operator,operation,input={}){
 assert(reads.has(operation)||receiptReads.has(operation)&&input.action==='LOOKUP'&&!Object.hasOwn(input,'cancel_if_missing')||adminReceipts.has(operation)&&!Object.hasOwn(input,'action')&&(input.cancel_if_missing===undefined||input.cancel_if_missing===false),'Only read-only portal operations are allowed');assert(operator?.page&&operator.session?.portalOrigin);
 const request=createSyntheticRequest({page:operator.page,origin:operator.session.portalOrigin,runId:operator.session.runId,checkpoint:operator.session.checkpoint});
 try{return await request('/api/inbox','POST',{operation,input});}
 catch(error){const status=String(error.message).match(/HTTP ([45]\d{2});/u);if(status)error.status=Number(status[1]);throw error;}
}
export async function capturePortalOperatorEvidence(operator){return operator.verify();}
export function bindPortalOperatorResult(row,binding,{testIds}={}){
 assert.equal(binding?.contractVersion,2);assert.equal(binding.surface,'portal');if(testIds!==undefined)assert(Array.isArray(testIds)&&testIds.length>0&&new Set(testIds).size===testIds.length&&testIds.every(value=>typeof value==='string'));assert(typeof row.testId==='string'&&(testIds?testIds.includes(row.testId):row.testId.endsWith('::portal')),'Only exact current assertion IDs may use the current binding');if(row.verifiedContext)assert.deepEqual(row.verifiedContext,binding,'Never replace a prior evidence binding');assert(['tenant_owner','agent'].includes(binding.role)&&['en','ar'].includes(binding.locale));
 const context=portalOperatorContexts(binding.role,binding.locale).find(value=>value.contextId===row.contextId);assert(context,'Result context does not name the actual portal actor');
 assert.deepEqual(context.viewport,binding.viewport,'Result context viewport differs from the browser');assert(Number.isFinite(Date.parse(binding.verifiedAt)));
 for(const ref of ['actorRef','tenantRef']){assert.match(binding[ref],/^sha256:[a-f0-9]{64}$/u);if(row[ref]!==undefined)assert.equal(row[ref],binding[ref]);}
 assert(['passed','failed','blocked','unknown'].includes(row.result));assert(Number.isFinite(Date.parse(row.startedAt))&&Number.isFinite(Date.parse(row.finishedAt))&&Date.parse(row.startedAt)<=Date.parse(row.finishedAt));
 if(row.actualViewport)assert.deepEqual(row.actualViewport,binding.viewport);assert(row.proof&&typeof row.proof==='object');
 return {...row,actorRef:binding.actorRef,tenantRef:binding.tenantRef,actualViewport:{...binding.viewport},verifiedContext:{...binding},proof:{...row.proof,actorVerified:true,actorVerifiedAt:binding.verifiedAt,surface:'portal'}};
}
export async function openPortalTicket(operator,{ticketNumber,articleId,marker,reload=true}){
 assert.match(String(ticketNumber),id);if(articleId!==undefined)assert.match(String(articleId),id);if(marker!==undefined)assert(typeof marker==='string'&&marker.length>0&&marker.length<=50000);
 const {page,session:s}=operator;await operator.verify();
 // The responsive conversation hides its list at the existing <=760px breakpoint.
 const listState=page.viewportSize().width<=760?'attached':'visible';
 await page.goto(`${s.portalOrigin}/app?view=inbox&ticket=${encodeURIComponent(ticketNumber)}`);await page.locator('#inbox-search').waitFor({state:listState});
 const current=page.locator('button[aria-current="true"]').filter({hasText:'#'+ticketNumber});await current.waitFor({state:listState});assert.equal(await current.count(),1);
 const list=await readPortalOperation(operator,'LIST',{ticket_number:String(ticketNumber),limit:1});assert.equal(list.items?.length,1);assert.equal(list.items[0].number,String(ticketNumber));
 const ticket=list.items[0];await page.getByRole('heading',{level:2,name:ticket.title,exact:true}).waitFor({state:'visible'});
 const observe=async()=>{if(articleId!==undefined){const article=page.locator(`[data-article-id="${articleId}"]`);for(let index=0;await article.count()===0&&index<50;index++){
   const older=page.locator('[role="region"] > button');if(await older.count()!==1)break;const before=await page.locator('[data-article-id]').count();const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/inbox'&&r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='ARTICLES');await older.click();assert((await response).ok());await page.waitForFunction(count=>document.querySelectorAll('[data-article-id]').length>count,before);
  }await article.waitFor({state:'visible'});if(marker!==undefined)assert((await article.innerText()).includes(marker),'Exact portal article content differs');}
  else if(marker!==undefined)await page.locator('[data-article-id]').filter({hasText:marker}).first().waitFor({state:'visible'});};
 await observe();if(reload){await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('heading',{level:2,name:ticket.title,exact:true}).waitFor({state:'visible'});await observe();}
 const binding=await operator.verify();return{renderedTicketId:String(ticket.id),renderedTicketNumber:String(ticketNumber),...(articleId===undefined?{}:{articleId:String(articleId)}),reload,actualViewport:binding.viewport,surface:'portal'};
}
export async function openPortalGroup(operator,{groupId,messageId}){
 assert.match(groupId,uuid);if(messageId!==undefined)assert.match(messageId,uuid);const {page,session:s}=operator;await operator.verify();
 await page.goto(`${s.portalOrigin}/app?view=inbox&workspace=groups&group=${encodeURIComponent(groupId)}${messageId?'&message='+encodeURIComponent(messageId):''}`);await page.locator('.wx-group-header h2').waitFor({state:'visible'});
 const group=await readPortalOperation(operator,'GROUP_SHOW',{group_id:groupId});assert.equal(group.id,groupId);assert.equal(await page.locator('.wx-group-header h2').innerText(),group.name);
 if(messageId){const target=page.locator(`[data-message-id="${messageId}"]`);for(let index=0;await target.count()===0&&index<50;index++){
   const older=page.locator('.wx-group-history > button');if(await older.count()!==1)break;
   const before=await page.locator('[data-message-id]').count(),response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/inbox'&&r.request().method()==='POST'&&r.request().postDataJSON()?.operation==='GROUP_MESSAGES');
   await older.click();assert((await response).ok());await page.waitForFunction(count=>document.querySelectorAll('[data-message-id]').length>count,before);
  }await target.waitFor({state:'visible'});await target.scrollIntoViewIfNeeded();}
 await operator.verify();return{groupId,...(messageId?{messageId}:{}),surface:'portal',actualViewport:page.viewportSize()};
}

export {privateNativeRead} from './simulation-private-native-read.mjs';

// The assertion window belongs to the measured operator; mixed actors keep their own bindings.
export async function withPortalOperatorEvidence(operator,run,{testIds}={}){
 const before=await operator.verify(),result=await run(),after=await operator.verify();
 const stable=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='verifiedAt'));
 assert.deepEqual(stable(before),stable(after),'Portal actor or viewport changed during the bounded operation');
 const output={...result},binding={...after,verificationWindow:{startedAt:before.verifiedAt,finishedAt:after.verifiedAt}};
 for(const field of ['results','proofs'])if(Array.isArray(result[field]))output[field]=result[field].map(row=>{
  if(!row.testId||!row.contextId)return row;assert(!row.contextId.startsWith('zammad_'),'Current portal operations cannot qualify native browser contexts');
  if(!row.contextId.startsWith(binding.role+'-'+binding.locale+'-'))return row;
  assert(!row.verifiedContext,'Never replace previously bound evidence');
  assert(Date.parse(row.startedAt)>=Date.parse(before.verifiedAt)&&Date.parse(row.finishedAt)<=Date.parse(after.verifiedAt),'Assertion outside the verified portal operation window');
  return bindPortalOperatorResult(row,binding,{testIds});
 });
 return output;
}
