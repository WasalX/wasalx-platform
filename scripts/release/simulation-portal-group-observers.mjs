import assert from 'node:assert/strict';
import {openPortalGroup,openPortalTicket,readPortalOperation,privateNativeRead,capturePortalOperatorEvidence} from './simulation-portal-operator.mjs';
import {portalGroupRow,portalGroupResult,sha} from './simulation-portal-groups.mjs';
import {groupMutationPrefix} from './simulation-portal-group-definitions.mjs';

export async function observePortalGroupBusiness({operator,groupId,fixtures,checkpoint,scoped,connectionId}){
 await operator.page.setViewportSize({width:1440,height:1000});await openPortalGroup(operator,{groupId});
 const records=(await readPortalOperation(operator,'GROUP_MESSAGES',{group_id:groupId})).items,byId=new Map(records.map(row=>[row.id,row])),results=[];
 const check=async(suffix,fn)=>{const startedAt=new Date().toISOString();let result='passed',proof;
  try{proof=await fn();}catch(error){result='failed';proof={errorClass:error.name,errorSha256:sha(String(error.message))};}
  const row=await portalGroupResult(operator,{testId:groupMutationPrefix+suffix,result,proof,startedAt,finishedAt:new Date().toISOString()});results.push(row);await checkpoint({phase:'portal-group-business',...row});
 };
 await check('message-mutations-and-attribution-render-safely::01',async()=>{
  const incoming=byId.get(fixtures.incoming.id),outgoing=byId.get(fixtures.outgoing.id);assert(incoming&&!incoming.from_me);assert(outgoing&&outgoing.from_me);
  const source=await scoped('SELECT id,external_message_id FROM normalized_messages WHERE connection_id=$1 AND id=$2',[connectionId,incoming.id]);assert.equal(source[0].external_message_id,fixtures.incoming.externalMessageId);
  const delivery=await scoped('SELECT id,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND id=$2',[connectionId,outgoing.id]);assert.equal(delivery[0].external_message_id,fixtures.outgoing.externalMessageId);
  const inRow=portalGroupRow(operator,incoming.id),outRow=portalGroupRow(operator,outgoing.id);await inRow.waitFor();await outRow.waitFor();assert.equal(await inRow.getAttribute('data-team'),'false');assert.equal(await outRow.getAttribute('data-team'),'true');return{incomingId:incoming.id,outgoingId:outgoing.id,directionUi:true,exactPrivateSourceBindings:true};
 });
 await check('message-mutations-and-attribution-render-safely::04',async()=>{
  const ack=byId.get(fixtures.reaction.id);assert(ack);assert.equal(ack.quoted_message?.id,fixtures.incoming.id);
  const quote=portalGroupRow(operator,ack.id).locator('.wx-group-quote');await quote.waitFor();assert((await quote.innerText()).includes(fixtures.incoming.text));return{replyId:ack.id,sourceMessageId:ack.quoted_message.id,targetVisible:true};
 });
 await check('message-mutations-and-attribution-render-safely::05',async()=>{
  const message=byId.get(fixtures.unsafeName.id);assert(message);const row=portalGroupRow(operator,message.id);await row.waitFor();const displayed=await row.locator('header b').first().innerText();assert.equal(displayed,fixtures.unsafeName.name);assert.equal(await row.locator('header script,header img,header svg,header iframe').count(),0);assert.equal(message.sender_phone,fixtures.unsafeName.phone);return{messageId:message.id,displayedName:displayed,phone:message.sender_phone,unsafeElements:0};
 });
 await check('participant-nickname-consistency::fallback',async()=>{
  const pn=byId.get(fixtures.phoneFallback.id),lid=byId.get(fixtures.lidFallback.id);assert(pn&&lid);assert.equal(pn.sender_phone,fixtures.phoneFallback.phone);assert.equal(lid.sender_phone,null);
  for(const fixture of [fixtures.phoneFallback,fixtures.lidFallback]){const row=portalGroupRow(operator,fixture.id);await row.waitFor();assert(!(await row.innerText()).includes(fixture.rawJid));await row.locator('header b').getByText('Participant',{exact:true}).waitFor();if(fixture.phone)await row.getByText(fixture.phone,{exact:true}).waitFor();}
  await operator.page.reload();for(const fixture of [fixtures.phoneFallback,fixtures.lidFallback]){const row=portalGroupRow(operator,fixture.id);await row.waitFor();assert(!(await row.innerText()).includes(fixture.rawJid));}return{knownPhone:pn.sender_phone,unknownLidGeneric:true,rawJidsAbsent:true,reload:true};
 });
 return{results,viewport:operator.page.viewportSize()};
}

export async function observePortalNicknameSurfaces({operator,groupId,messageId,expected,marker,link,checkpoint,viewports}){
 const {page,session}=operator,contexts=[],originalViewport=page.viewportSize();
 if(viewports)assert(Array.isArray(viewports)&&viewports.length>0&&viewports.length<=3);
 try{
  const initial=(await readPortalOperation(operator,'GROUP_CONTEXT',{group_id:groupId,message_id:messageId})).items.find(row=>row.id===messageId);assert(initial);
  const actual=initial.participant_name||initial.sender_phone||'Participant';
  for(const viewport of viewports??[{width:1440,height:1000},{width:820,height:1180}]){
   await page.setViewportSize(viewport);await openPortalGroup(operator,{groupId,messageId});const row=portalGroupRow(operator,messageId);const nameVisible=await row.getByText(expected,{exact:true}).first().isVisible();
   await page.reload();await row.waitFor();const after=(await readPortalOperation(operator,'GROUP_CONTEXT',{group_id:groupId,message_id:messageId})).items.find(row=>row.id===messageId);
   const identityStable=after?.id===initial.id&&after?.participant_name===initial.participant_name&&after?.sender_phone===initial.sender_phone;
   const binding=await capturePortalOperatorEvidence(operator);contexts.push({...binding,verifiedContext:binding,surface:'portal-group',viewport:page.viewportSize(),nameVisible,reloadNameVisible:await row.getByText(expected,{exact:true}).first().isVisible(),identityStable});await checkpoint({phase:'portal-nickname-group',messageId,context:contexts.at(-1)});
  }
  let native;
  if(link){
   const ticket=await privateNativeRead(session,'ticket',{ticketId:link.zammad_ticket_id}),article=await privateNativeRead(session,'article',{articleId:link.zammad_article_id});
   assert.equal(String(article.ticket_id),String(ticket.id));assert(String(article.body).includes(marker));assert(Number(article.origin_by_id)>0);
   const user=await privateNativeRead(session,'user',{userId:article.origin_by_id});
   native={ticketId:ticket.id,ticketNumber:ticket.number,articleId:article.id,groupId:ticket.group_id,customerId:ticket.customer_id,senderId:article.origin_by_id,from:article.from,firstname:user.firstname,lastname:user.lastname,mobile:user.mobile,login:user.login,preferences:article.preferences};
   assert.equal(String(native.ticketId),String(link.zammad_ticket_id));assert.equal(String(native.articleId),String(link.zammad_article_id));
   for(const viewport of viewports??[{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);await openPortalTicket(operator,{ticketNumber:String(ticket.number),articleId:String(article.id),marker,reload:true});
    const row=page.locator(`[data-article-id="${article.id}"]`);const nameVisible=await row.getByText(expected,{exact:false}).filter({visible:true}).first().waitFor({state:'visible',timeout:20000}).then(()=>true,()=>false);
    const binding=await capturePortalOperatorEvidence(operator);contexts.push({...binding,verifiedContext:binding,surface:'portal-inbox',viewport:page.viewportSize(),articleMarkerVisible:true,nameVisible});await checkpoint({phase:'portal-nickname-inbox',messageId,context:contexts.at(-1)});
   }
  }
  return{actual,identityPass:actual===expected,contexts,native,nativeNameMatches:native?([native.firstname,native.lastname].filter(Boolean).join(' ').trim()===expected):null};
 }finally{await page.setViewportSize(originalViewport);}
}

export function portalMutationView(operator,groupId){
 return{
  surface:'portal',rows:async()=>(await readPortalOperation(operator,'GROUP_MESSAGES',{group_id:groupId})).items,
  render:async id=>{await operator.page.setViewportSize({width:1440,height:1000});await openPortalGroup(operator,{groupId,messageId:id});const row=portalGroupRow(operator,id);await row.waitFor();return row;},
  assertEdited:async(row,text)=>{await row.getByText(text,{exact:true}).waitFor();await row.getByText('Edited',{exact:true}).waitFor();assert.equal(await row.locator('p b').count(),0);},
  assertReaction:async id=>{await openPortalGroup(operator,{groupId,messageId:id});const row=portalGroupRow(operator,id);await row.waitFor();assert((await row.innerText()).includes('👍'));},
  assertRevoked:async(row,text)=>{await row.getByText('This message was removed.',{exact:true}).waitFor();assert.equal(await row.getByText(text,{exact:true}).count(),0);assert.equal(await row.getByRole('button',{name:'Reply to this message',exact:true}).count(),0);assert.equal(await row.locator('img,video,audio').count(),0);},
 };
}
