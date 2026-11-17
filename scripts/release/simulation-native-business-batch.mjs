import{captureNativeAgentEvidence}from'./simulation-native-agent.mjs';
import {createHash} from 'node:crypto';
import assert from'node:assert/strict';
import{simulationEventId,assertIngressReceipts}from'./synthetic-first-group-driver.mjs';
import{callSimulationControl}from'../contracts/waha-simulation-control.mjs';
import{observeGroupBusinessRecords}from'./simulation-native-business-observers.mjs';
import{createAndFilterNativeGroupTicket}from'./simulation-native-business-ticket.mjs';
export async function runNativeBusinessBatch(s){
 const {runId,scoped,connectionId,checkpoint}=s;
 const emit=createNativeBusinessEmitter(s);
 assert(Array.isArray(s.participants)&&s.participants.length===3&&s.participants.every(x=>typeof x==='string'&&x.length));
 const unsafeName=await emit('name',s.participants[0],'1234567890','<img src=x onerror=alert(1)>');
 const phoneFallback=await emit('phone',s.participants[1],'Alpha known phone fallback');
 const lidFallback=await emit('lid',s.participants[2],'Alpha unknown participant');
 let delivery;const deadline=Date.now()+90000;
 for(;;){delivery=(await scoped('SELECT id,state,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND reply_to_message_id=$2 ORDER BY created_at DESC',[connectionId,unsafeName.externalMessageId]))[0];if(delivery?.state==='SENT')break;if(Date.now()>deadline)throw Error('Expected acknowledgement not settled');await new Promise(r=>setTimeout(r,300));}
 const fixtures={incoming:unsafeName,unsafeName,phoneFallback,lidFallback,outgoing:{id:delivery.id,externalMessageId:delivery.external_message_id},reaction:{id:delivery.id}};
 await checkpoint({phase:'native-business-fixtures',fixtures,delivery});
 const observed=await observeGroupBusinessRecords({page:s.nativePage,origin:s.nativeOrigin,groupId:s.groupId,fixtures,checkpoint,expectedActorId:s.expectedActorId,tenantId:s.tenantId});
 const ticketStartedAt=new Date().toISOString();let ticket;
 try{ticket=await createAndFilterNativeGroupTicket({page:s.nativePage,origin:s.nativeOrigin,groupId:s.groupId,messageId:s.messageId,externalMessageId:s.externalMessageId,connectionId,tenantId:s.tenantId,marker:'Alpha native business '+runId,checkpoint:s.nativeCheckpoint,scoped,providerRead:s.providerRead,run:s.run,railsId:s.containers['zammad-railsserver'].Id,expectedActorId:s.expectedActorId});s.nativeSettled();}
 catch(error){await checkpoint({phase:'native-business-ticket-failure',errorClass:error.name,errorSha256:createHash('sha256').update(String(error.message)).digest('hex')});ticket={...await captureNativeAgentEvidence(s.nativePage,s.expectedActorId,s.tenantId).catch(()=>({})),contextId:'zammad_agent-en-desktop',result:'failed',errorSha256:createHash('sha256').update(String(error.message)).digest('hex'),startedAt:ticketStartedAt,finishedAt:new Date().toISOString()};}
 await checkpoint({phase:'native-business-alternate-connection-blocked',reason:'No second independently qualified simulated connection with authorized history fixture; single-bot safeguard must not be bypassed.'});
 return{observed,ticket,fixtures,limitations:['Alternate connection requires independently qualified fixture; no cross-connection PASS claimed.']};
}

export function createNativeBusinessEmitter(s){
 const {runId,scoped,connectionId,tenantId,externalGroupId,registry,checkpoint,socketPath}=s;
 const emit=async(label,participant,text,notifyName)=>{
  const input={eventId:simulationEventId(runId+'-'+label),messageId:'false_'+externalGroupId+'_'+runId+'-'+label,chatId:externalGroupId,participant,text,...(notifyName!==undefined?{notifyName}:{})};
  assert.equal((await scoped("SELECT id FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId])).length,0);
  await registry.register({kind:'inbound',eventId:input.eventId});await checkpoint({phase:'native-business-ingress-intent',input});const receipt=await (s.providerControl??(command=>callSimulationControl(socketPath,command)))({action:'inbound',input});await checkpoint({phase:'native-business-ingress-receipt',receipt});
  const deadline=Date.now()+90000;let inbox;
  for(;;){inbox=(await scoped("SELECT id,status,processed_at,lease_id FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId]))[0];if(inbox?.processed_at&&!inbox.lease_id)break;if(Date.now()>deadline)throw Error('Business fixture unsettled');await new Promise(r=>setTimeout(r,300));}
  assertIngressReceipts(receipt,false,inbox.id);const [message]=await scoped('SELECT id,history_captured_at FROM normalized_messages WHERE event_inbox_id=$1',[inbox.id]);assert(message?.history_captured_at);return{id:message.id,externalMessageId:input.messageId,text,phone:participant.endsWith('@c.us')?'+'+participant.split('@')[0]:null,rawJid:participant,name:notifyName};
 };
 return emit;
}
