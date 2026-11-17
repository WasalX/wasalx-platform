import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openPortalTicket,privateNativeRead} from './simulation-portal-operator.mjs';
export {submitPortalReply} from './simulation-portal-reply-browser.mjs';
export async function downloadPortalMailAttachment(operator,{ticketNumber,articleId,filename,maximumBytes=50_000_000}){
 assert.match(String(articleId),/^[1-9][0-9]*$/u);assert.equal(typeof filename,'string');assert(filename&&filename.length<=255);
 assert(Number.isSafeInteger(maximumBytes)&&maximumBytes>0&&maximumBytes<=50_000_000);
 await operator.verify();const selected=await openPortalTicket(operator,{ticketNumber,articleId,reload:false});
 const article=operator.page.locator('[data-article-id="'+articleId+'"]'),button=article.getByRole('button',{name:'Download '+filename,exact:true});
 assert.equal(await button.count(),1);const pending=operator.page.waitForEvent('download',{timeout:15000}),responsePending=operator.page.waitForResponse(response=>{try{const request=response.request(),input=request.postDataJSON();return new URL(response.url()).origin===operator.session.portalOrigin&&new URL(response.url()).pathname==='/api/inbox/attachment'&&request.method()==='POST'&&String(input.ticket_id)===selected.renderedTicketId&&String(input.article_id)===String(articleId);}catch{return false;}},{timeout:15000});await button.click();const [download,response]=await Promise.all([pending,responsePending]);assert.equal(response.status(),200);
 assert.equal(download.suggestedFilename(),filename);const stream=await download.createReadStream();assert(stream);const parts=[];let bytes=0;
 for await(const part of stream){bytes+=part.length;assert(bytes<=maximumBytes);parts.push(part);}
 assert.equal(await download.failure(),null);await operator.verify();return{authenticated:true,status:response.status(),filename,bytes:Buffer.concat(parts),sha256:createHash('sha256').update(Buffer.concat(parts)).digest('hex')};
}
export async function observePortalMailFailure(operator,{ticketId,articleId,recipient,kind='transport'}){
 const ticket=await privateNativeRead(operator.session,'ticket',{ticketId});assert.equal(String(ticket.id),String(ticketId));
 const article=await privateNativeRead(operator.session,'article',{articleId});assert.equal(String(article.ticket_id),String(ticketId));
 await openPortalTicket(operator,{ticketNumber:ticket.number,articleId,reload:true});
 if(kind==='bounce'){
  const banner=operator.page.locator('[data-recipient-delivery="RECENT_FAILURE"]');await banner.waitFor({state:'visible'});assert((await banner.innerText()).trim().length>0);
  const customer=await privateNativeRead(operator.session,'user',{userId:ticket.customer_id});assert.equal(customer.email,recipient);
 }else{
  assert.equal(article.preferences.delivery_status,'fail');assert.equal(article.preferences.delivery_retry,4);
  const status=operator.page.locator('[data-article-id="'+articleId+'"] [data-email-delivery="UNCONFIRMED"]');await status.waitFor({state:'visible'});assert((await status.innerText()).trim().length>0);
  assert.equal(await status.getByRole('button',{name:/retry|resend/iu}).count(),0);await operator.page.locator('#inbox-message').waitFor({state:'visible'});assert(await operator.page.locator('#inbox-message').isEnabled());assert.equal(await operator.page.getByRole('button',{name:'Preview reply',exact:true}).count(),1);
 }
 const text=await operator.page.getByRole('region',{name:'Conversation history',exact:true}).innerText();assert(!text.includes('SIMULATED_PRIVATE_SENTINEL'));
 await operator.verify();return{ticketId:String(ticketId),articleId:String(articleId),visible:true,surface:'portal',scope:kind==='bounce'?'Current recipient warning; no article-specific delivery claim':'Native attempts exhausted with unconfirmed transport outcome; no resend action'};
}

export async function createPortalMailFailureTicket(operator,{groupId,recipient,namespace,checkpoint}){
 assert.equal(recipient,'failure-'+namespace.toLowerCase()+'@alpha.invalid');await operator.verify();
 await operator.page.goto(operator.session.portalOrigin+'/app?view=inbox');await operator.page.getByRole('button',{name:'New ticket',exact:true}).click();
 const dialog=operator.page.getByRole('dialog',{name:'New ticket',exact:true});await dialog.waitFor({state:'visible'});
 await dialog.locator('#wx-ticket-create-team').selectOption(String(groupId));await dialog.locator('#wx-ticket-customer-mode').selectOption('new');
 await dialog.locator('#wx-ticket-new-email').fill(recipient);await dialog.locator('#wx-ticket-new-name').fill('Synthetic failure recipient');
 await dialog.locator('#wx-ticket-title').fill('WasalX isolated failure '+namespace);await dialog.locator('#wx-ticket-create-body').fill('WasalX failure fixture '+namespace);
 await dialog.locator('#wx-ticket-mode').selectOption('note');await operator.verify();
 const safe=[],capture=request=>{try{const body=request.postDataJSON();if(new URL(request.url()).origin===operator.session.portalOrigin&&body.operation==='CREATE_TICKET')safe.push({operationId:body.input.operation_id,groupId:body.input.group_id,internal:body.input.internal,recipient:body.input.customer?.email});}catch{return;}};
 operator.page.on('request',capture);const observed=operator.page.waitForResponse(response=>{try{return new URL(response.url()).origin===operator.session.portalOrigin&&response.request().postDataJSON().operation==='CREATE_TICKET';}catch{return false;}},{timeout:15000}).then(response=>({response}),()=>({unknown:true}));
 await checkpoint({phase:'intent',step:'portal-failure-fixture-ticket',namespace,recipient,groupId:String(groupId),at:new Date().toISOString()});let received;
 try{await dialog.getByRole('button',{name:'Create ticket with note',exact:true}).click();received=await observed;}catch{received=await observed;}finally{operator.page.off('request',capture);}
 await checkpoint({phase:'submitted',step:'portal-failure-fixture-ticket',namespace,operations:safe,at:new Date().toISOString()});await operator.verify();
 assert.equal(safe.length,1);assert.equal(safe[0].groupId,String(groupId));assert.equal(safe[0].internal,true);assert.equal(safe[0].recipient,recipient);
 assert(received?.response?.ok(),'Fixture ticket outcome unconfirmed; never recreate');const result=await received.response.json();assert.equal(result.state,'APPLIED');assert.equal(result.operation_id,safe[0].operationId);assert(result.ticket_id&&result.ticket_number&&result.article_id);return result;
}
