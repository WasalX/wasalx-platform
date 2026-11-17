import assert from 'node:assert/strict';
import {simulationEventId,assertIngressReceipts} from './synthetic-first-group-driver.mjs';
import {findRuleSet} from './seed-simulation-group.mjs';

import {admitNativeMailUi} from './simulation-native-mail-browser.mjs';
export const ruleInputCustomerParticipant='12025550105@c.us';
export async function runRuleInputs({request,ruleSetId,nativeRead,observeTicket,nativePage,tenantId,connectionId,externalGroupId,runId,control,drainEffects,scoped,effects,providerRead,checkpoint}){
 const snapshot=async()=>{const row=await findRuleSet(request,ruleSetId);return Object.fromEntries(['id','family_id','name','version','state','revision','snapshot_sha256','supersedes_rule_set_id','rollback_source_rule_set_id','rules'].map(k=>[k,row[k]]));};
 const definition=await snapshot();assert.equal(definition.state,'ACTIVE');await checkpoint({phase:'proof',step:'activated-rule-snapshot',ruleSetId,definition});
 const proofs=[];let duplicateEvidence;const cases=[{name:'customer-match',participant:ruleInputCustomerParticipant,text:'ID 6789012345',sender:'customer',status:'PROCESSED'},{name:'customer-nonmatch',participant:ruleInputCustomerParticipant,text:'No identifier here',sender:'customer',status:'UNMATCHED'},{name:'unknown',participant:'12025550111@lid',text:'ID 6789012346',sender:'unknown',status:'UNMATCHED'}];
 for(const c of cases){
  const startedAt=new Date().toISOString(),classified=await scoped('SELECT app.group_rule_sender($1,$2,$3,$4) AS sender',[tenantId,connectionId,externalGroupId,c.participant]);assert.equal(classified[0].sender,c.sender,'Fixture classification prerequisite mismatch');
  const input={eventId:simulationEventId(`${runId}-${c.name}`),messageId:`false_${externalGroupId}_${runId}-${c.name}`,chatId:externalGroupId,participant:c.participant,text:c.text};
  const find=()=>scoped("SELECT id,status,processed_at,lease_id,safe_error FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId]);assert.equal((await find()).length,0);
  assert.equal((await scoped('SELECT id FROM normalized_messages WHERE connection_id=$1 AND external_message_id=$2',[connectionId,input.messageId])).length,0);
  const before=await effects(),providerBefore=await providerRead();await checkpoint({phase:'intent',step:c.name,input});const receipt=await control({action:'inbound',input});await checkpoint({phase:'accepted',step:c.name,receipt});
  const until=Date.now()+120000;let inbox;do{inbox=(await find())[0];if(inbox?.processed_at&&inbox.lease_id===null)break;await new Promise(r=>setTimeout(r,300));}while(Date.now()<until);assert(inbox?.processed_at);assert.equal(inbox.lease_id,null);assert.equal(inbox.status,c.status);assertIngressReceipts(receipt,false,inbox.id);
  if(c.name==='unknown')assert.equal(inbox.safe_error,'TEAM_SENDER_EXCLUDED');
  await drainEffects();const after=await effects();let native;
  if(c.status==='UNMATCHED'){assert.deepEqual(after,before);assert.deepEqual(await providerRead(),providerBefore);}
  else{
   const links=await scoped('SELECT id,zammad_ticket_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,input.messageId]);assert.equal(links.length,1);
   const end=Date.now()+120000;let newly;do{newly=(await effects()).outbox.filter(x=>!before.outbox.some(b=>b.id===x.id));if(newly.length===1&&newly[0].state==='SENT')break;await new Promise(r=>setTimeout(r,300));}while(Date.now()<end);assert.equal(newly.length,1);assert.equal(newly[0].state,'SENT');assert.equal(Number(newly[0].attempts),1);
   native=nativeRead?await nativeRead({ticketId:String(links[0].zammad_ticket_id),messageId:input.messageId}):await nativePage.evaluate(async({ticketId,messageId})=>{const tr=await fetch(`/api/v1/tickets/${ticketId}`),ar=await fetch(`/api/v1/ticket_articles/by_ticket/${ticketId}`);if(!tr.ok||!ar.ok)throw Error('Native readback denied');const t=await tr.json(),articles=await ar.json();return{id:t.id,title:t.title,number:t.number,matchingArticleIds:articles.filter(a=>a.preferences?.wasalx_external_message_id===messageId).map(a=>a.id)};},{ticketId:links[0].zammad_ticket_id,messageId:input.messageId});assert.equal(native.matchingArticleIds.length,1);assert(native.title.includes('6789012345'));
   if(observeTicket)native.portalObservation=await observeTicket(native,c.text);else {await nativePage.setViewportSize({width:1440,height:1000});await nativePage.goto(`${new URL(nativePage.url()).origin}/desktop/tickets/${native.id}`);await admitNativeMailUi(nativePage);await nativePage.getByText(native.title,{exact:true}).first().waitFor({state:'visible',timeout:20000});}
   const stable=await effects(),providerStable=await providerRead(),duplicateStartedAt=new Date().toISOString();await checkpoint({phase:'intent',step:'duplicate-customer-event',eventId:input.eventId});const duplicate=await control({action:'inbound',input});await drainEffects();assertIngressReceipts(duplicate,true,inbox.id);assert.deepEqual(await effects(),stable);assert.deepEqual(await providerRead(),providerStable);duplicateEvidence={duplicate,stable,eventId:input.eventId,inboxId:inbox.id,startedAt:duplicateStartedAt,finishedAt:new Date().toISOString()};await checkpoint({phase:'proof',step:'duplicate-customer-event',...duplicateEvidence});
  }
  proofs.push({name:c.name,classification:classified[0].sender,input,inbox,before,after,native,startedAt,finishedAt:new Date().toISOString()});await checkpoint({phase:'proof',step:c.name,proof:proofs.at(-1)});
 }
 assert.deepEqual(await snapshot(),definition);return{proofs,duplicateEvidence,limitations:['Customer matching/unknown/nonmatch and same-event duplicate only','Friendly native title visibility is support; no separate command action invented','No LID roster conflict, tenantB, echo, rollback or reprocess fixture substituted']};
}
