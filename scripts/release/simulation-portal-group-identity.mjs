import assert from 'node:assert/strict';
import {createNativeBusinessEmitter} from './simulation-native-business-batch.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {syncNativeRoster} from './simulation-native-pn-lid.mjs';
import {openPortalGroup,readPortalOperation} from './simulation-portal-operator.mjs';
import {observePortalNicknameSurfaces} from './simulation-portal-group-observers.mjs';
import {portalGroupRow,portalGroupResult,sha} from './simulation-portal-groups.mjs';
import {groupMutationPrefix,originalPnLidId} from './simulation-portal-group-definitions.mjs';

export async function runPortalGroupNicknames(s,{participants}){
 assert(Array.isArray(participants)&&participants.length===2&&new Set(participants).size===2&&participants.every(value=>/^[1-9][0-9]+@c\.us$/u.test(value)));
 const startedAt=new Date().toISOString(),emit=createNativeBusinessEmitter(s),rows=[],results=[],seed=parseInt(sha(s.runId).slice(0,7),16);
 const specs=[['known',participants[0],'Synthetic Alpha','Synthetic Alpha'],['refresh',participants[0],'Synthetic Renamed','Synthetic Renamed'],['empty',participants[0],'','Synthetic Renamed'],['identifier',participants[0],participants[0],'Synthetic Renamed'],['same-name',participants[1],'Synthetic Renamed','Synthetic Renamed']];
 for(const[index,[key,participant,name,expected]]of specs.entries()){
  const marker='Synthetic identity '+key+' ID '+String(1000000000+seed*5+index),message=await emit('nickname-'+key,participant,marker,name);let link,delivery;const until=Date.now()+120000;
  for(;;){link=(await s.scoped('SELECT zammad_ticket_id,zammad_article_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[s.connectionId,message.externalMessageId]))[0];delivery=(await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND reply_to_message_id=$2',[s.connectionId,message.externalMessageId]))[0];if(link&&delivery?.state==='SENT')break;assert(!delivery||!['OUTCOME_UNKNOWN','FAILED_TERMINAL'].includes(delivery.state));assert(Date.now()<until,'Nickname effects unresolved; preserve the exact intent');await new Promise(resolve=>setTimeout(resolve,300));}
  assert.equal(Number(delivery.attempts),1);assert.equal((await s.providerRead()).receipts.filter(row=>row.id===delivery.external_message_id).length,1);
  const surfaces=await observePortalNicknameSurfaces({operator:s.operator,groupId:s.groupId,messageId:message.id,expected,marker,link,checkpoint:s.checkpoint});const proof={key,messageId:message.id,externalMessageId:message.externalMessageId,participant,expected,link,delivery,...surfaces};rows.push(proof);await s.checkpoint({phase:'portal-nickname-current-proof',proof});
 }
 const visible=row=>{assert(row.identityPass&&row.nativeNameMatches);assert(row.contexts.every(context=>context.nameVisible&&context.reloadNameVisible!==false&&context.identityStable!==false));return row;};
 const check=async(suffix,operation)=>{let result='passed',proof;try{proof=operation();}catch(error){result='failed';proof={errorClass:error.name,errorSha256:sha(String(error.message)),messageIds:rows.map(row=>row.messageId)};}
  const row=await portalGroupResult(s.operator,{testId:groupMutationPrefix+'participant-nickname-consistency::'+suffix,result,startedAt,proof});results.push(row);await s.checkpoint({phase:'portal-nickname-result',...row});
 };
 await check('native-history-name',()=>visible(rows[0]));
 await check('refresh',()=>{visible(rows[1]);assert.equal(rows[0].native.customerId,rows[1].native.customerId);assert.notEqual(rows[0].messageId,rows[1].messageId);return{original:rows[0],refreshed:rows[1]};});
 await check('name-quality',()=>{visible(rows[2]);visible(rows[3]);assert.equal(rows[1].native.customerId,rows[2].native.customerId);assert.equal(rows[1].native.customerId,rows[3].native.customerId);return{empty:rows[2],identifier:rows[3]};});
 await check('same-name',()=>{visible(rows[4]);assert.notEqual(rows[1].participant,rows[4].participant);assert.notEqual(rows[1].native.customerId,rows[4].native.customerId);return{first:rows[1],second:rows[4]};});return results;
}

export async function runPortalPnLid(s,{pn,lid,unrelated,name}){
 assert(/^[1-9][0-9]+@c\.us$/u.test(pn)&&/^[1-9][0-9]+@lid$/u.test(lid)&&/^[1-9][0-9]+@lid$/u.test(unrelated));assert.notEqual(lid,unrelated);
 const startedAt=new Date().toISOString(),phone='+'+pn.split('@')[0],roster=JSON.parse(s.model.services['waha-gows'].environment.WAHA_SIM_PARTICIPANT_ROSTER??'[]');
 for(const id of[pn,lid])assert(roster.some(row=>(row.JID??row.LID)===id&&row.PhoneNumber===pn.split('@')[0]));assert(roster.some(row=>(row.JID??row.LID)===unrelated&&!row.PhoneNumber));
 const request=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:s.runId,checkpoint:s.checkpoint});await syncNativeRoster({request,connectionId:s.connectionId});
 const rows=await s.scoped('SELECT external_participant_id,normalized_phone FROM group_workspace_participants WHERE whatsapp_group_id=$1 AND external_participant_id=ANY($2::text[])',[s.groupId,[pn,lid,unrelated]]);assert.equal(rows.length,3);assert.equal(rows.find(row=>row.external_participant_id===pn).normalized_phone,phone);assert.equal(rows.find(row=>row.external_participant_id===lid).normalized_phone,phone);assert.equal(rows.find(row=>row.external_participant_id===unrelated).normalized_phone,null);
 const emit=createNativeBusinessEmitter(s),messages=[];for(const[key,id]of[['pn',pn],['lid',lid],['unrelated',unrelated]])messages.push(await emit('mapped-'+key,id,'Synthetic mapped history '+key,name));
 await s.operator.page.setViewportSize({width:1440,height:1000});await openPortalGroup(s.operator,{groupId:s.groupId});const actual=(await readPortalOperation(s.operator,'GROUP_MESSAGES',{group_id:s.groupId})).items;
 for(const[index,message]of messages.entries()){
  const record=actual.find(row=>row.id===message.id);assert(record);assert.equal(record.sender_phone,index===2?null:phone);assert.equal(record.participant_name,name);const row=portalGroupRow(s.operator,message.id);await row.waitFor();assert.equal(await row.locator('header b').first().innerText(),name);assert(!(await row.innerText()).includes(lid));
 }
 assert.equal(new Set(messages.map(row=>row.id)).size,3);const result=await portalGroupResult(s.operator,{testId:originalPnLidId,result:'passed',startedAt,proof:{roster:rows,messageIds:messages.map(row=>row.id),mappedPhone:phone,unrelatedNotMerged:true,customerMergeNotInferred:true}});await s.checkpoint({phase:'portal-pn-lid-result',...result});return result;
}
