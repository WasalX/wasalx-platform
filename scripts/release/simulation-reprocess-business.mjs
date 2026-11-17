import assert from 'node:assert/strict';import{simulationEventId,assertIngressReceipts}from'./synthetic-first-group-driver.mjs';import{findRuleSet}from'./seed-simulation-group.mjs';
import{createHash}from'node:crypto';import{observeNicknameSurfaces}from'./simulation-native-nickname-surfaces.mjs';
import{createOwnedIntentRegistry}from'./owned-intent-registry.mjs';
import{waitOwnedRestoration}from'./owned-work-restoration.mjs';
import{assertIncludedReceipt}from'./simulation-sender-policy.mjs';
const prefix='group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::';
export function admitCustomerReprocess(proofs,teamParticipants){
 const rows=proofs?.filter(row=>row.testId===prefix+'customer-match');assert.equal(rows?.length,1,'One verified customer-match fixture required');
 const row=rows[0];assert.equal(row.result,'passed');assert.equal(row.proof?.classification,'customer');const participant=row.proof.input?.participant;
 assert.match(participant??'',/^[1-9][0-9]{5,14}@c\.us$/);assert(!teamParticipants.includes(participant),'Customer review must not use a configured team sender');return participant;
}
export function assertCustomerReprocessSettled(state){assert(state&&(!state.submitted||state.settled),'Customer reprocess submission unresolved; preserve configuration and original intent');}
export function assertReprocessEffectDelta(before,after,deliveryId,linkIds){const addedIds=(prior,current)=>current.filter(row=>!prior.some(value=>value.id===row.id)).map(row=>row.id);assert.deepEqual(addedIds(before.outbox,after.outbox),[deliveryId]);assert.equal(linkIds.length,2);assert.equal(new Set(linkIds).size,2);assert.deepEqual(addedIds(before.links,after.links).sort(),[...linkIds].sort());assert.deepEqual(addedIds(before.actions,after.actions),[]);return true}
export function assertSuccessfulReprocess({review,accepted,bound,terminal,resolved,originalMessage,message,links,ackLinks,delivery,providerReceipt,originalParticipant}){
 assert.equal(accepted.id,review.id);assert.equal(accepted.state,'REPROCESS_QUEUED');assert.equal(accepted.duplicate,false);assert.equal(Number(accepted.version),Number(review.version)+1);
 assert.equal(bound.id,review.id);assert.equal(bound.source_event_inbox_id,review.source_event_inbox_id);assert(bound.state==='REPROCESS_QUEUED'&&Number(bound.version)===Number(accepted.version)||bound.state==='RESOLVED'&&Number(bound.version)===Number(accepted.version)+1);assert.match(bound.reprocess_event_id,/^[0-9a-f-]{36}$/u);
 assert.equal(terminal.id,bound.reprocess_event_id);assert.equal(terminal.status,'PROCESSED');assert(terminal.processed_at);assert.equal(terminal.lease_id,null);assert.equal(terminal.lease_expires_at,null);assert.equal(terminal.safe_error,null);
 assert.equal(resolved.id,review.id);assert.equal(resolved.state,'RESOLVED');assert.equal(resolved.resolution_code,'REPROCESSED');assert.equal(resolved.reprocess_event_id,bound.reprocess_event_id);assert.equal(Number(resolved.version),Number(accepted.version)+1);
 assert.equal(originalMessage.event_inbox_id,review.source_event_inbox_id);assert.equal(originalMessage.external_participant_id,originalParticipant);assert.equal(originalMessage.from_api,false);assert.equal(originalMessage.processing_status,'COMPLETE');
 assert.equal(message.event_inbox_id,bound.reprocess_event_id);assert.equal(message.external_participant_id,originalParticipant);assert.equal(message.from_api,false);assert.equal(message.processing_status,'COMPLETE');assert.notEqual(message.external_message_id,originalMessage.external_message_id);assert.equal(links.length,1);assert.equal(links[0].direction,'INBOUND');assert.equal(links[0].external_message_id,message.external_message_id);assert(links[0].zammad_ticket_id);
 assert.equal(delivery.reply_to_message_id,originalMessage.external_message_id);assert.equal(providerReceipt.replyToSha256,createHash('sha256').update(originalMessage.external_message_id).digest('hex'));assert.notEqual(providerReceipt.replyToSha256,createHash('sha256').update(message.external_message_id).digest('hex'));assert(['SENT','DELIVERED','READ'].includes(delivery.state));assert.equal(delivery.lease_id,null);assert.equal(delivery.lease_expires_at,null);assert(delivery.external_message_id);assert.equal(delivery.zammad_ticket_id,links[0].zammad_ticket_id);assert.equal(ackLinks.length,1);assert.equal(ackLinks[0].direction,'OUTBOUND');assert.equal(ackLinks[0].external_message_id,delivery.external_message_id);assert.equal(ackLinks[0].zammad_ticket_id,delivery.zammad_ticket_id);assert.equal(ackLinks[0].zammad_article_id,null);
 return{reviewId:review.id,sourceInboxId:review.source_event_inbox_id,reprocessInboxId:bound.reprocess_event_id,originalParticipant,originalProviderMessageId:originalMessage.external_message_id,ticketId:links[0].zammad_ticket_id,deliveryId:delivery.id,providerMessageId:delivery.external_message_id};
}
export async function runSenderReprocessEcho(s){
 const{request,runId,tenantId,connectionId,externalGroupId,scoped,providerRead,checkpoint,bindingPath,bindingBody,nativeQuality}=s;
 assert.match(s.customerParticipant??'',/^[1-9][0-9]{5,14}@c\.us$/);assert.notEqual(s.customerParticipant,s.participant);assert(s.reprocessState);if(s.operatorSurface==='portal'){assert.equal(typeof s.observeAttribution,'function','Verified portal attribution observer required');}else{assert.equal(s.operatorSurface,undefined,'Unsupported reprocess operator surface');assert(s.nativePage&&s.expectedActorId);}assert.equal(typeof s.drainEffects,'function');
 const registry=createOwnedIntentRegistry(checkpoint);
 const originalUnknowns=await scoped("SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND state='OUTCOME_UNKNOWN' ORDER BY id",[tenantId,connectionId]);
 const effects=async()=>({outbox:await scoped('SELECT id,state,attempts FROM delivery_outbox ORDER BY id'),links:await scoped('SELECT id FROM message_links ORDER BY id'),actions:await scoped('SELECT id FROM group_action_executions ORDER BY id'),provider:await providerRead()});
 const install=async(policy,max,label=policy)=>{const created=await request('/api/rules','POST',{name:'Synthetic '+runId+' '+label,matcherType:'exact_length',pattern:'[0-9]{10}',digitLength:10,priority:1,enabled:true,teamSenderPolicy:policy,savedExamples:[{name:'Customer',message:'1234567890',sender:'customer',expectedMatches:['1234567890']}]},'review-rule-'+label),draft=await findRuleSet(request,created.id);await request('/api/rule-sets/'+created.id+'/activate','POST',{expectedRevision:Number(draft.revision),expectedActiveRuleSetId:null,expectedActiveRevision:null},'review-activate-'+label);await request(bindingPath,'PUT',{...bindingBody(await request(bindingPath),created.id),maxIdentifiers:max},'review-bind-'+label);return findRuleSet(request,created.id);};
 const settle=async eventId=>{const until=Date.now()+90000;for(;;){const r=(await scoped("SELECT id,status,safe_error,processed_at,lease_id FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,eventId]))[0];if(r?.processed_at&&r.lease_id===null)return r;if(Date.now()>until)throw Error('Review/echo settlement timeout; retain original intent');await new Promise(r=>setTimeout(r,300));}};
 const dispatch=async(label,extra)=>{const input={eventId:simulationEventId(runId+'-'+label),messageId:'false_'+externalGroupId+'_'+runId+'-'+label,chatId:externalGroupId,participant:s.participant,text:'1234567890 2234567890',...extra};assert.equal((await scoped("SELECT id FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId])).length,0);await checkpoint({phase:label+'-intent',input});s.reprocessState.submitted=true;await registry.register({kind:'inbound',eventId:input.eventId});const receipt=await s.control({action:'inbound',input});await checkpoint({phase:label+'-accepted',receipt});const inbox=await settle(input.eventId);assertIngressReceipts(receipt,false,inbox.id);return{input,inbox};};
 const before=await effects();await install('include',1);const original=await dispatch('review-original',{});assert.equal(original.inbox.status,'QUARANTINED');assert.equal(original.inbox.safe_error,'IDENTIFIER_LIMIT_EXCEEDED');assert.deepEqual(await effects(),before);const normalized=(await scoped('SELECT id FROM normalized_messages WHERE event_inbox_id=$1',[original.inbox.id]))[0];assert(normalized);
 if(nativeQuality)await nativeQuality({...s,messageId:normalized.id,externalMessageId:original.input.messageId});
 const exclude=await install('exclude',20);const review=(await scoped('SELECT id,version,state,reprocess_event_id FROM quarantine_records WHERE source_event_inbox_id=$1',[original.inbox.id]))[0];assert.equal(review.state,'OPEN');await checkpoint({phase:'reprocess-excluded-intent',reviewId:review.id,sourceInboxId:original.inbox.id});await assert.rejects(()=>request('/api/reviews/'+review.id+'/reprocess','POST',{expectedVersion:Number(review.version),ruleId:exclude.rules[0].id,normalizedReference:'1234567890'},'reprocess-excluded'),/HTTP 400; reconcile intent before retry/);const unchanged=(await scoped('SELECT id,version,state,reprocess_event_id FROM quarantine_records WHERE id=$1',[review.id]))[0];assert.deepEqual(unchanged,review);assert.deepEqual(await effects(),before);
 // A distinct owned customer review proves successful attribution; the excluded team item stays OPEN.
 const customer=s.customerParticipant,name='Synthetic review customer '+runId,reference='1234567890';
 assert.equal((await scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[tenantId,connectionId,externalGroupId,customer]))[0]?.sender,'customer');
 const customerRule=await install('exclude',1,'customer-exclude'),customerBefore=await effects();
 const source=await dispatch('review-customer',{participant:customer,notifyName:name});assert.equal(source.inbox.status,'QUARANTINED');assert.equal(source.inbox.safe_error,'IDENTIFIER_LIMIT_EXCEEDED');assert.deepEqual(await effects(),customerBefore);
 const [customerReview]=await scoped('SELECT id,source_event_inbox_id,version,state,resolution_code,reprocess_event_id FROM quarantine_records WHERE tenant_id=$1 AND connection_id=$2 AND source_event_inbox_id=$3',[tenantId,connectionId,source.inbox.id]);
 assert(customerReview&&customerReview.state==='OPEN'&&customerReview.reprocess_event_id===null);
 const originalMessages=await scoped('SELECT id,event_inbox_id,external_message_id,external_participant_id,from_api,processing_status FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND event_inbox_id=$3',[tenantId,connectionId,source.inbox.id]);assert.equal(originalMessages.length,1);const originalMessage=originalMessages[0];assert.equal(originalMessage.external_message_id,source.input.messageId);
 await request(bindingPath,'PUT',{...bindingBody(await request(bindingPath),customerRule.id),maxIdentifiers:20},'customer-review-correct-limit');
 await checkpoint({phase:'customer-reprocess-intent',reviewId:customerReview.id,sourceInboxId:source.inbox.id,expectedVersion:Number(customerReview.version),ruleId:customerRule.rules[0].id,reference,key:`synthetic-${runId}-customer-reprocess-once`});
 const queued=await request('/api/reviews/'+customerReview.id+'/reprocess','POST',{expectedVersion:Number(customerReview.version),ruleId:customerRule.rules[0].id,normalizedReference:reference},'customer-reprocess-once');
 assert.equal(queued.id,customerReview.id);assert.equal(queued.state,'REPROCESS_QUEUED');
 const [accepted]=await scoped('SELECT id,source_event_inbox_id,version,state,resolution_code,reprocess_event_id FROM quarantine_records WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',[tenantId,connectionId,customerReview.id]);assert.match(accepted?.reprocess_event_id??'',/^[a-f0-9-]{36}$/);
 await checkpoint({phase:'customer-reprocess-accepted',reviewId:customerReview.id,inboxId:accepted.reprocess_event_id});
 await registry.register({kind:'reprocess',inboxId:accepted.reprocess_event_id});registry.close();
 await waitOwnedRestoration({scoped,tenantId,connectionId,originalUnknowns,registry});
 const [terminal]=await scoped('SELECT id,source_event_inbox_id,version,state,resolution_code,reprocess_event_id FROM quarantine_records WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',[tenantId,connectionId,customerReview.id]);
 assert.equal(terminal?.state,'RESOLVED');assert.equal(terminal.resolution_code,'REPROCESSED');assert.equal(terminal.reprocess_event_id,accepted.reprocess_event_id);s.reprocessState.settled=true;
 await s.drainEffects();
 const [processed]=await scoped('SELECT id,status,safe_error,processed_at,lease_id,lease_expires_at FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',[tenantId,connectionId,accepted.reprocess_event_id]);
 const messages=await scoped('SELECT id,event_inbox_id,external_message_id,external_participant_id,from_api,processing_status FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND event_inbox_id=$3',[tenantId,connectionId,accepted.reprocess_event_id]);assert.equal(messages.length,1);const message=messages[0];
 assert.deepEqual(await scoped('SELECT id,event_inbox_id,external_message_id,external_participant_id,from_api,processing_status FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',[tenantId,connectionId,originalMessage.id]),originalMessages);
 const links=await scoped("SELECT id,external_message_id,zammad_ticket_id,zammad_article_id,direction FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3 AND direction='INBOUND' ORDER BY zammad_ticket_id",[tenantId,connectionId,message.external_message_id]);
 const deliveries=await scoped(`SELECT delivery.id,delivery.state,delivery.attempts,delivery.reply_to_message_id,delivery.external_message_id,delivery.message_body,delivery.lease_id,delivery.lease_expires_at,link.zammad_ticket_id FROM delivery_outbox delivery JOIN delivery_ticket_links link ON link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id WHERE delivery.tenant_id=$1 AND delivery.connection_id=$2 AND delivery.reply_to_message_id=$3 ORDER BY delivery.id,link.zammad_ticket_id`,[tenantId,connectionId,originalMessage.external_message_id]);assert.equal(deliveries.length,1);assert.equal(links.length,1);
 const ackLinks=await scoped("SELECT id,external_message_id,zammad_ticket_id,zammad_article_id,direction FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=$3 AND direction='OUTBOUND' ORDER BY zammad_ticket_id",[tenantId,connectionId,deliveries[0].external_message_id]);assert.equal(ackLinks.length,1);
 const after=await effects();assertReprocessEffectDelta(customerBefore,after,deliveries[0].id,[links[0].id,ackLinks[0].id]);const providerReceipt=assertIncludedReceipt(customerBefore.provider,after.provider,deliveries[0],externalGroupId);
 const replyTarget=assertSuccessfulReprocess({review:customerReview,accepted:queued,bound:accepted,terminal:processed,resolved:terminal,originalMessage,message,links,ackLinks,delivery:deliveries[0],providerReceipt,originalParticipant:customer});
 await checkpoint({phase:'customer-reprocess-original-reply-target',...replyTarget,providerReceiptId:providerReceipt.id,providerReplyToSha256:providerReceipt.replyToSha256});
 const successful=await observeOriginalReprocessAttribution({...s,nativePage:s.nativePage},{tenant_id:tenantId,connection_id:connectionId,review_id:customerReview.id,source_event_inbox_id:source.inbox.id,reprocess_event_id:accepted.reprocess_event_id,external_group_id:externalGroupId,groupId:s.groupId,participant:customer,name,phone:'+'+customer.split('@')[0],reference});
 assert.deepEqual((await scoped('SELECT id,version,state,reprocess_event_id FROM quarantine_records WHERE id=$1',[review.id]))[0],review,'Excluded original team review changed');
 const reprocess={testId:prefix+'reprocess',result:'passed',at:new Date().toISOString(),proof:{reviewId:review.id,sourceInboxId:original.inbox.id,originalParticipant:original.input.participant,status:400,reviewUnchanged:true,noSyntheticReviewIdentityBypass:true,successfulCustomerAttribution:successful,originalReplyTarget:replyTarget}};await checkpoint({phase:'proof',...reprocess});
 return{proofs:[reprocess],retainedReview:review.id};
}

export function assertOriginalReprocessAttribution(f,row){
 for(const key of ['tenant_id','connection_id','review_id','source_event_inbox_id','reprocess_event_id','external_group_id'])assert.equal(row[key],f[key]);
 assert.equal(row.state,'RESOLVED');assert.equal(row.resolution_code,'REPROCESSED');
 assert.equal(row.event_status,'PROCESSED');assert.equal(row.lease_id,null);
 assert.equal(row.original_participant,f.participant);assert.equal(row.external_participant_id,f.participant);
 assert.notEqual(row.external_participant_id,'wasalx-review');assert.equal(row.original_from_api,false);assert.equal(row.original_from_me,false);assert.equal(row.from_api,false);assert.equal(row.from_me,false);
 assert.equal(row.participant_name,f.name);assert.equal(row.message_text,f.reference);
 assert.equal(row.external_message_id,`review:${f.review_id}:${f.reprocess_event_id}`);
 assert(row.message_id&&row.zammad_ticket_id&&row.zammad_article_id);
 return{originalIdentityPreserved:true,correctedReferencePreserved:true,terminalReview:true};
}
export async function observeOriginalReprocessAttribution(s,f){
 assert.equal(f.tenant_id,s.tenantId);assert.equal(f.connection_id,s.connectionId);
 const read=()=>s.scoped(`SELECT q.tenant_id,q.connection_id,q.id AS review_id,q.source_event_inbox_id,q.reprocess_event_id,q.state,q.resolution_code,
   e.status AS event_status,e.lease_id,o.external_participant_id AS original_participant,o.from_api AS original_from_api,o.from_me AS original_from_me,
   n.id AS message_id,n.external_group_id,n.external_message_id,n.external_participant_id,n.participant_name,n.message_text,n.from_api,n.from_me,
   l.zammad_ticket_id,l.zammad_article_id
 FROM quarantine_records q JOIN event_inbox e ON e.tenant_id=q.tenant_id AND e.connection_id=q.connection_id AND e.id=q.reprocess_event_id
 JOIN normalized_messages o ON o.tenant_id=q.tenant_id AND o.connection_id=q.connection_id AND o.event_inbox_id=q.source_event_inbox_id
 JOIN normalized_messages n ON n.tenant_id=e.tenant_id AND n.connection_id=e.connection_id AND n.event_inbox_id=e.id AND n.external_group_id=o.external_group_id
 JOIN message_links l ON l.tenant_id=n.tenant_id AND l.connection_id=n.connection_id AND l.external_message_id=n.external_message_id
 WHERE q.tenant_id=$1 AND q.connection_id=$2 AND q.id=$3`,[f.tenant_id,f.connection_id,f.review_id]);
 const before=await read();assert.equal(before.length,1);const record=before[0],identity=assertOriginalReprocessAttribution(f,record),provider=await s.providerRead();
 const native=s.observeAttribution?await s.observeAttribution({fixture:f,record}):await observeNicknameSurfaces({page:s.nativePage,groupId:f.groupId,messageId:record.message_id,expected:f.name,marker:f.reference,
   link:record,checkpoint:s.checkpoint,expectedActorId:s.expectedActorId,tenantId:s.tenantId});
 assert(native.identityPass&&native.nativeNameMatches);assert(native.contexts.every(c=>c.verifiedContext&&c.nameVisible&&c.reloadNameVisible!==false&&c.identityStable!==false));
 assert.equal(native.native.login,'wasalx-'+createHash('sha256').update([f.tenant_id,f.connection_id,f.participant].join(String.fromCharCode(31))).digest('hex'));
 assert.equal(native.native.mobile,f.phone);assert.equal(native.native.preferences.wasalx_sender_name,f.name);assert.equal(native.native.preferences.wasalx_sender_phone,f.phone);
 assert.deepEqual(await read(),before);assert.deepEqual(await s.providerRead(),provider);
 return{...identity,nativeIdentityAndArticlePreserved:true,readOnly:true,noProviderReplay:true};
}
