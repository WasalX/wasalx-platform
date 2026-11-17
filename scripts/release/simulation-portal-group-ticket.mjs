import assert from 'node:assert/strict';
import {openPortalGroup,openPortalTicket,readPortalOperation,privateNativeRead} from './simulation-portal-operator.mjs';
import {reconcileNativeTicketOutcome,nativeTicketFilterPlan,restoreOwnedNativeState} from './simulation-native-business-ticket.mjs';
import {portalGroupRow,observePortalAction,updatePortalTicketState,portalGroupResult} from './simulation-portal-groups.mjs';
import {groupTicketPrefix,originalLinkIds} from './simulation-portal-group-definitions.mjs';

export async function createPortalGroupTicket(s){
 const {operator,groupId,messageId,externalMessageId,connectionId,tenantId,checkpoint,scoped,providerRead}=s,page=operator.page;
 const marker=`Alpha portal business ${s.runId}`,startedAt=new Date().toISOString(),beforeProvider=await providerRead();
 assert.equal((await scoped('SELECT id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,externalMessageId])).length,0,'Existing source link requires reconciliation, never another create');
 await page.setViewportSize({width:1440,height:1000});await openPortalGroup(operator,{groupId,messageId});
 await portalGroupRow(operator,messageId).getByRole('button',{name:'Create ticket from message',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Ticket title',{exact:true}).fill(marker);
 const teams=await readPortalOperation(operator,'GROUP_TEAMS',{});assert(teams.some(team=>String(team.id)===s.targetTeamId),'Current explicitly granted team must be available');await dialog.getByLabel('Responsible team',{exact:true}).selectOption(s.targetTeamId);
 let accepted,failure;
 try{accepted=await observePortalAction({operator,operation:'GROUP_CREATE_TICKET',action:()=>dialog.getByRole('button',{name:'Save',exact:true}).click(),checkpoint,beforeDispatch:s.markUncertain});}
 catch(error){failure=error;if(!error.intent)throw error;}
 const result=await reconcileNativeTicketOutcome({run:s.run,railsId:s.containers['zammad-railsserver'].Id,tenantId,messageId,externalMessageId,connectionId,marker,scoped,httpStatus:accepted?.status??failure?.status??null});
 if(result.result==='failed'){assert(!accepted,'Accepted portal create lacks complete durable source proof; retain the exact operation');s.markSettled();return result;}
 const ticket=await privateNativeRead(operator.session,'ticket',{ticketId:result.ticket_id}),articles=await privateNativeRead(operator.session,'articles',{ticketId:result.ticket_id});
 assert.equal(ticket.title,marker);assert.equal(String(ticket.number),String(result.ticket_number));assert.equal(articles.filter(row=>row.preferences?.wasalx_external_message_id===externalMessageId).length,1);assert(articles.some(row=>String(row.id)===String(result.article_id)));
 await openPortalGroup(operator,{groupId,messageId});assert.equal(await portalGroupRow(operator,messageId).getByRole('button',{name:'Create ticket from message',exact:true}).count(),0);
 const related=page.locator('.wx-group-related');await related.locator('summary').click();await related.getByRole('button').filter({hasText:'#'+result.ticket_number}).waitFor();assert.deepEqual(await providerRead(),beforeProvider);
 const created=await portalGroupResult(operator,{testId:groupTicketPrefix+'02',result:'passed',startedAt,finishedAt:new Date().toISOString(),proof:{ticketId:result.ticket_id,ticketNumber:result.ticket_number,articleId:result.article_id,messageId,associationCount:1,articleCount:1,reload:true,noProviderEffects:true}});await checkpoint({phase:'portal-group-ticket',...created});
 const filtered=await filterPortalGroupTicket({...s,ticketId:result.ticket_id,ticketNumber:result.ticket_number,beforeProvider,startedAt});s.markSettled();return{created,filtered};
}

export async function filterPortalGroupTicket(s){
 const {operator,groupId,ticketId,ticketNumber,checkpoint,providerRead,beforeProvider,startedAt}=s,page=operator.page;
 const readCurrent=()=>privateNativeRead(operator.session,'ticket',{ticketId});
 const ticket=await readCurrent(),states=await privateNativeRead(operator.session,'states',{}),plan=nativeTicketFilterPlan(ticket,states),statesObserved=[];let closedAcknowledged=false,updateUncertain=false;
 const update=async stateId=>{await updatePortalTicketState(operator,{ticketId:String(ticketId),ticketNumber:String(ticketNumber),stateId,checkpoint,beforeDispatch:async input=>{updateUncertain=true;await s.markUncertain(input);}});assert.equal(Number((await readCurrent()).state_id),Number(stateId));updateUncertain=false;s.markSettled();};
 if(plan.normalizeToOpen)await update(plan.openStateId);
 try{for(const category of ['OPEN','CLOSED']){
  if(category==='CLOSED'){await update(plan.closedStateId);closedAcknowledged=true;}
  await openPortalGroup(operator,{groupId});const related=page.locator('.wx-group-related');await related.locator('summary').click();await related.getByLabel('Ticket status',{exact:true}).selectOption(category);
  const button=related.getByRole('button').filter({hasText:'#'+ticketNumber});await button.waitFor();
  const rows=await readPortalOperation(operator,'GROUP_TICKETS',{group_id:groupId,state:category});assert(rows.items.some(row=>String(row.ticket_number)===String(ticketNumber)&&row.state_category===category));
  await related.getByLabel('Ticket status',{exact:true}).selectOption(category==='OPEN'?'CLOSED':'OPEN');await button.waitFor({state:'hidden'});statesObserved.push({category,stateId:(await readCurrent()).state_id,exactShown:true,oppositeAbsent:true});
 }}finally{await restoreOwnedNativeState({acknowledged:closedAcknowledged&&!updateUncertain,ticketId:ticket.id,expectedState:plan.closedStateId,readCurrent,restore:()=>update(plan.openStateId)});}
 assert.deepEqual(await providerRead(),beforeProvider);await page.setViewportSize({width:1440,height:1000});
 const row=await portalGroupResult(operator,{testId:groupTicketPrefix+'01',result:'passed',startedAt,finishedAt:new Date().toISOString(),proof:{ticketId,statesObserved,initialStateId:plan.initialStateId,normalizedOpenStateId:plan.openStateId,closedStateId:plan.closedStateId,restoredState:plan.openStateId,exactCreatePreimageRestored:!plan.normalizeToOpen,noProviderEffects:true}});await checkpoint({phase:'portal-group-ticket',...row});return row;
}

export async function runPortalGroupLinkJump(s,{target,ticketId}){
 const {operator,checkpoint}=s,page=operator.page,ticket=await privateNativeRead(operator.session,'ticket',{ticketId});
 const before=await s.providerRead(),beforeTickets=await readPortalOperation(operator,'GROUP_TICKETS',{group_id:s.groupId,state:'ALL'});assert(!beforeTickets.next_cursor,'Complete bounded related inventory required');
 assert.equal((await s.scoped('SELECT id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[s.connectionId,target.externalMessageId])).length,0);
 await page.setViewportSize({width:1440,height:1000});await openPortalGroup(operator,{groupId:s.groupId,messageId:target.id});await portalGroupRow(operator,target.id).getByRole('button',{name:'Link message to ticket',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Ticket number',{exact:true}).fill(String(ticket.number));
 const accepted=await observePortalAction({operator,operation:'GROUP_LINK_TICKET',action:()=>dialog.getByRole('button',{name:'Save',exact:true}).click(),checkpoint,beforeDispatch:s.markUncertain});assert(accepted.value.accepted);
 const links=await s.scoped('SELECT zammad_ticket_id,zammad_article_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[s.connectionId,target.externalMessageId]);assert.equal(links.length,1);assert.equal(String(links[0].zammad_ticket_id),String(ticket.id));
 const article=await privateNativeRead(operator.session,'article',{articleId:links[0].zammad_article_id});assert.equal(String(article.ticket_id),String(ticket.id));assert.equal(article.preferences?.wasalx_external_message_id,target.externalMessageId);assert(String(article.body).includes(target.text));
 const articles=await privateNativeRead(operator.session,'articles',{ticketId:ticket.id});assert.equal(articles.filter(row=>row.preferences?.wasalx_external_message_id===target.externalMessageId).length,1);
 const afterTickets=await readPortalOperation(operator,'GROUP_TICKETS',{group_id:s.groupId,state:'ALL'});assert.deepEqual(afterTickets.items.map(row=>row.ticket_number).sort(),beforeTickets.items.map(row=>row.ticket_number).sort());assert.deepEqual(await s.providerRead(),before);s.markSettled();
 const linked=await portalGroupResult(operator,{testId:originalLinkIds[0],result:'passed',proof:{ticketId:ticket.id,articleId:article.id,messageId:target.id,oneAssociation:true,noNewGroupTicket:true,noProviderEffects:true},finishedAt:new Date().toISOString()});await checkpoint({phase:'portal-group-link',...linked});
 await openPortalTicket(operator,{ticketNumber:String(ticket.number),articleId:String(article.id),marker:target.text,reload:true});
 const source=page.locator(`[data-article-id="${article.id}"]`).getByRole('button',{name:'Show source message',exact:true});assert.equal(await source.count(),1);await source.click();
 await page.waitForURL(url=>url.searchParams.get('view')==='inbox'&&url.searchParams.get('workspace')==='groups'&&url.searchParams.get('group')===s.groupId&&url.searchParams.get('message')===target.id);
 const selected=portalGroupRow(operator,target.id);await selected.waitFor();assert.equal(await selected.getAttribute('data-source-target'),'true');assert(await selected.evaluate(element=>element===document.activeElement||element.contains(document.activeElement)),'Source control must focus the exact source message');
 const jumped=await portalGroupResult(operator,{testId:originalLinkIds[1],result:'passed',proof:{ticketId:ticket.id,groupId:s.groupId,messageId:target.id,exactFocused:true},finishedAt:new Date().toISOString()});await checkpoint({phase:'portal-group-jump',...jumped});return[linked,jumped];
}
