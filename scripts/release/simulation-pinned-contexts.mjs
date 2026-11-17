import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ensurePortalOperator,openPortalTicket,privateNativeRead,capturePortalOperatorEvidence} from './simulation-portal-operator.mjs';
export function pinnedContextPlan(){return [{kind:'owner',context:{role:'tenant_owner',locale:'en',viewport:'desktop',surface:'portal'}},...['desktop','tablet','mobile'].map(viewport=>({kind:'agent',context:{role:'agent',locale:'en',viewport,surface:'portal'}}))];}
export function assertPinnedNative(actual,p){assert.equal(String(actual.ticketId),String(p.delivery.zammad_ticket_id));assert.equal(String(actual.articleId),String(p.delivery.zammad_article_id));assert.equal(actual.sha256,p.asset.sha256);assert.equal(actual.byteSize,p.asset.bytes);assert.equal(actual.filename,p.asset.filename);const input=actual.order.find(r=>String(r.id)===String(p.native.inboundArticleId)),output=actual.order.find(r=>String(r.id)===String(p.delivery.zammad_article_id));assert(input&&output);assert(Date.parse(input.at)<=Date.parse(output.at));for(const id of[p.native.inboundArticleId,p.delivery.zammad_article_id]){const original=p.native.articleOrder.find(r=>String(r.id)===String(id));assert(original);assert(actual.order.some(x=>String(x.id)===String(id)&&x.at===original.at));}}

export async function readPinnedNative(session,p){
 const rows=await privateNativeRead(session,'articles',{ticketId:String(p.delivery.zammad_ticket_id)});
 const article=rows.find(row=>String(row.id)===String(p.delivery.zammad_article_id));assert(article&&article.attachments.length===1);
 const file=article.attachments[0],binary=await privateNativeRead(session,'attachment',{ticketId:String(article.ticket_id),articleId:String(article.id),attachmentId:String(file.id)});
 return{ticketId:article.ticket_id,articleId:article.id,...binary,body:article.body,order:rows.map(row=>({id:row.id,at:row.created_at})),articleOrder:rows.map(row=>({id:row.id,at:row.created_at,sender:row.sender}))};
}
export async function readPortalPinnedAttachment(operator,p){
 await operator.verify();await openPortalTicket(operator,{ticketNumber:String(p.ticketNumber),articleId:String(p.delivery.zammad_article_id)});
 const article=operator.page.locator('[data-article-id="'+p.delivery.zammad_article_id+'"]');assert.equal(await article.count(),1);
 const pending=operator.page.waitForEvent('download',{timeout:30_000});await article.getByRole('button',{name:'Download '+p.asset.filename,exact:true}).click();
 const download=await pending;assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),p.asset.filename);
 const stream=await download.createReadStream();assert(stream);let byteSize=0;const digest=createHash('sha256');
 for await(const chunk of stream){byteSize+=chunk.length;assert(byteSize<=p.asset.bytes,'Portal attachment exceeded expected native bytes');digest.update(chunk);}
 const result={filename:download.suggestedFilename(),byteSize,sha256:digest.digest('hex')};assert.equal(result.byteSize,p.asset.bytes);assert.equal(result.sha256,p.asset.sha256);await operator.verify();return result;
}
export async function observePinnedContexts(s,operator,result){
 assert.equal(result.proofs.length,2);const before=await s.metaCallbacks.providerRead(),observations=[],owner=s.ownerPage;
 const ownerOperator=await ensurePortalOperator(s,{role:'tenant_owner',viewport:{width:1440,height:1000}});await s.verifyOwner(owner);const owned={...pinnedContextPlan()[0],result:'passed',versions:[]};
 try{
  await owner.goto(s.portalOrigin+'/app?view=automation');await owner.getByRole('tab',{name:'Conversations',exact:true}).click();await owner.locator('.bot-conversations').waitFor();
  const catalog=await owner.evaluate(async()=>{const response=await fetch('/api/bot-flows/conversations?limit=50',{cache:'no-store'});if(!response.ok)throw Error('Conversation list denied');return response.json();});
  for(const p of result.proofs){const target=catalog.items.find(row=>row.id===p.delivery.conversation_id);assert(target);assert.equal(target.flow_version_id,p.delivery.flow_version_id);
   const row=owner.locator('.bot-conversation-list article').filter({hasText:String(target.flow_name)}).filter({hasText:new RegExp('#'+target.zammad_ticket_number+'(?:\\D|$)')}).filter({has:owner.locator('header small').filter({hasText:new RegExp('v'+target.version+'$')})});
   assert.equal(await row.count(),1);assert(await row.isVisible());owned.versions.push({conversationId:target.id,flowVersionId:target.flow_version_id,visibleVersion:target.version,assetId:p.asset.id,recipientMediaSha256:p.asset.sha256});}
 }catch(error){owned.result='failed';owned.error={errorClass:error.name,reason:'Pinned conversation UI assertion failed'};}
 await s.verifyOwner(owner);owned.portalBinding=await capturePortalOperatorEvidence(ownerOperator);observations.push(owned);
 for(const[viewport,width,height]of[['desktop',1440,1000],['tablet',820,1180],['mobile',390,844]]){
  await operator.verify();await operator.page.setViewportSize({width,height});const observation={kind:'agent',result:'passed',context:{role:'agent',locale:'en',viewport,surface:'portal'},media:[],actualViewport:{width,height}};
  try{for(const p of result.proofs){const actual=await readPinnedNative(s,p);assertPinnedNative(actual,p);const portal=await readPortalPinnedAttachment(operator,p);observation.media.push({privateNative:actual,portal});}}
  catch(error){observation.result='failed';observation.error={errorClass:error.name,reason:'Pinned Inbox media UI assertion failed'};}
  observation.portalBinding=await capturePortalOperatorEvidence(operator);observations.push(observation);
 }
 assert.deepEqual(await s.metaCallbacks.providerRead(),before,'Context reads must not send again');return observations;
}
