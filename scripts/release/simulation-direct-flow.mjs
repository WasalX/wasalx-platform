import assert from 'node:assert/strict';
import {bindNativeAgentResult} from './simulation-native-agent.mjs';
import {createHash} from 'node:crypto';
import {simulationEventId,assertIngressReceipts} from './synthetic-first-group-driver.mjs';
import {validateReturningNativeObservation,validateReturningPortalObservation} from './simulation-direct-returning-native.mjs';
import {bindPortalOperatorResult} from './simulation-portal-operator.mjs';
// Existing isolated launcher supplies these same authenticated/read-only/control helpers.
export async function runDirectBatch({request,scoped,control,checkpoint,assertIsolatedRuntime,nativeRead,observeReturningTicket,providerRead,tenantId,connectionId,zammadGroupId,chatIds,runId,drainEffects,priorAssignmentDisposition=[],finalAssignmentState,operatorSurface}){
 assert(/^[a-zA-Z0-9_-]{1,40}$/.test(runId));assert.equal(chatIds.length,2);assert.notEqual(...chatIds);for(const chat of chatIds)assert(/^\d{6,20}@c\.us$/.test(chat));
 assert(typeof drainEffects==='function');assert.equal(typeof observeReturningTicket,'function');assert(['ACTIVE','PAUSED'].includes(finalAssignmentState),'Explicit final assignment disposition required');
 await assertIsolatedRuntime({evidenceMode:'simulated',tenantId,connectionId,chatIds,serializeGroupMutations:true});
 const startedAt=new Date().toISOString(),proofs=[];
 const post=async(path,body,step)=>{const key=`synthetic-${runId}-${step}`;await checkpoint({phase:'intent',step,path,key});const result=await request(path,'POST',body,key);await checkpoint({phase:'accepted',step,id:result.id??result.assignmentId});return result;};
 const wait=async(read,accept)=>{const end=Date.now()+120000;while(Date.now()<end){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,500));}throw Error('Direct batch unsettled: reconcile last intent, do not rerun batch');};
 const conversations=chat=>scoped('SELECT id,state,fencing_token,flow_version_id,zammad_ticket_id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3 ORDER BY created_at,id',[tenantId,connectionId,chat]);
 const latest=async chat=>(await conversations(chat)).at(-1);
 const groupLinks=()=>scoped("SELECT link.id FROM message_links link JOIN normalized_messages message ON message.tenant_id=link.tenant_id AND message.connection_id=link.connection_id AND message.external_message_id=link.external_message_id WHERE link.tenant_id=$1 AND link.connection_id=$2 AND right(message.external_group_id,5)='@g.us' ORDER BY link.id",[tenantId,connectionId]);
 const drained=async()=>{const receipt=await drainEffects({tenantId,connectionId});assert.equal(receipt.settled,true);assert.equal(receipt.unknown,0);assert.equal(receipt.pending,0);await checkpoint({phase:'drained',receipt});return receipt;};
 const initialGroups=await groupLinks();
 const prior=await scoped('SELECT id,state,revision FROM bot_assignments WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[tenantId,connectionId]);
 assert.deepEqual(prior.map(x=>x.id).sort(),priorAssignmentDisposition.map(x=>x.id).sort(),'Every existing assignment needs an explicit owned disposition');
 for(const row of prior){
  const decision=priorAssignmentDisposition.find(x=>x.id===row.id);assert.equal(decision.owned,true);assert.equal(Number(decision.expectedRevision),Number(row.revision));
  if(row.state==='PAUSED'){assert.equal(decision.action,'keep-paused');continue;}
  assert.equal(row.state,'ACTIVE');assert.equal(decision.action,'pause-owned','An active predecessor must be explicitly retired from this batch before replacement');
  await drained();await post(`/api/bot-flows/assignments/${row.id}/state`,{state:'PAUSED',expectedRevision:Number(row.revision)},'pause-prior-'+row.id);
  const after=await scoped('SELECT state FROM bot_assignments WHERE tenant_id=$1 AND id=$2',[tenantId,row.id]);assert.equal(after[0]?.state,'PAUSED');
 }

 for(const chat of chatIds)assert.equal((await conversations(chat)).length,0);
 const definition=version=>({schemaVersion:1,name:`Synthetic direct ${runId}`,start:'hello',maxSteps:5,nodes:[{id:'hello',type:'send_text',text:`Synthetic ${runId} ${version}`,next:'handoff'},{id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]});
 const first=await post('/api/bot-flows',definition('V1'),'create');
 await post(`/api/bot-flows/${first.id}/activate`,{expectedRevision:Number(first.revision),expectedActiveFlowVersionId:null},'activate-v1');
 const assignment=await post('/api/bot-flows/assignments',{connectionId,familyId:first.familyId,zammadGroupId:String(zammadGroupId),agentPrefix:'Agent',agentIdentityPlacement:'HEADER'},'assign');
 const inbound=async(label,chat)=>{
  const eventId=simulationEventId(runId+'-'+label),messageId=`false_${chat}_SYNTH${runId}-${label}`,marker=`Synthetic ${runId} ${label}`;
  const inbox=()=>scoped("SELECT id,status,attempts,lease_id,processed_at,payload_sha256 FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'WAHA',$3)",[tenantId,connectionId,eventId]);
  assert.equal((await inbox()).length,0);await checkpoint({phase:'intent',step:label,eventId,messageId});
  const input={eventId,messageId,chatId:chat,participant:chat,text:marker},receipt=await control({action:'inbound',input});
  const rows=await wait(inbox,r=>r.length===1&&r[0].status==='PROCESSED'&&r[0].lease_id===null&&r[0].processed_at);assertIngressReceipts(receipt,false,rows[0].id);
  const result={label,input,receipt,inbox:rows,conversation:await latest(chat)};proofs.push(result);await checkpoint({phase:'inbound-readback',step:label,proof:result});return{...result,inboxRead:inbox,marker};
 };
 const outputProofs=[];
 const verifyOutput=async(label,inboundResult,chat,version,providerPrior)=>{
  const provider=await providerRead({requireSettled:true});
  const outbox=await scoped("SELECT id,state,external_chat_id,external_message_id,encode(digest(message_body,'sha256'),'hex') AS text_sha256 FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND idempotency_key=$3",[tenantId,connectionId,`bot:${inboundResult.conversation.id}:${inboundResult.inbox[0].id}:0`]);
  assert.equal(outbox.length,1);assert.equal(outbox[0].state,'SENT');assert.equal(outbox[0].external_chat_id,chat);
  const expectedHash=createHash('sha256').update(`Synthetic ${runId} ${version}`).digest('hex');assert.equal(outbox[0].text_sha256,expectedHash);
  const priorIds=new Set(providerPrior.receipts.map(x=>x.id));const added=provider.receipts.filter(x=>!priorIds.has(x.id));assert.equal(added.length,1);assert.equal(provider.receivedSends-providerPrior.receivedSends,1);
  assert.equal(added[0].id,outbox[0].external_message_id);assert(added[0].id.startsWith('true_'+chat+'_'));assert.equal(added[0].textSha256,expectedHash);
  const proof={label,outbox,added,expectedHash};outputProofs.push(proof);await checkpoint({phase:'output-readback',step:label,proof,providerSnapshot:provider});return provider;
 };
 const providerInitial=await providerRead({requireSettled:true});
 const initial=await inbound('initial',chatIds[0]);let current=await wait(()=>latest(chatIds[0]),r=>r?.state==='HUMAN');assert.equal(current.flow_version_id,first.id);
 const article=await nativeRead(current.zammad_ticket_id,initial.marker);assert.equal(article.markerArticleIds.length,1);
 // Settle outbound/handoff before measuring absence; providerRead must reconcile pending outbox.
 const providerBefore=await verifyOutput('initial',initial,chatIds[0],'V1',providerInitial);
 await checkpoint({phase:'intent',step:'duplicate',eventId:initial.input.eventId});const duplicate=await control({action:'inbound',input:initial.input});assertIngressReceipts(duplicate,true,initial.inbox[0].id);assert.equal(duplicate.bodySha256,initial.receipt.bodySha256);assert.deepEqual(await initial.inboxRead(),initial.inbox);assert.deepEqual((await nativeRead(current.zammad_ticket_id,initial.marker)).markerArticleIds,article.markerArticleIds);assert.deepEqual(await providerRead({requireSettled:true}),providerBefore);await checkpoint({phase:'no-effect-readback',step:'duplicate-or-human',providerBefore,providerAfter:await providerRead({requireSettled:true})});
 const human=await inbound('human',chatIds[0]);assert.equal(human.conversation.state,'HUMAN');assert.equal(human.conversation.id,current.id);assert.equal((await nativeRead(current.zammad_ticket_id,human.marker)).markerArticleIds.length,1);assert.deepEqual(await providerRead({requireSettled:true}),providerBefore);await checkpoint({phase:'no-effect-readback',step:'duplicate-or-human',providerBefore,providerAfter:await providerRead({requireSettled:true})});
 const second=await post(`/api/bot-flows/${first.id}/clone`,definition('V2'),'clone-v2');await post(`/api/bot-flows/${second.id}/activate`,{expectedRevision:Number(second.revision),expectedActiveFlowVersionId:first.id},'activate-v2');
 current=await latest(chatIds[0]);assert.equal(current.flow_version_id,first.id);
 await post(`/api/bot-flows/conversations/${current.id}/command`,{action:'RESUME_BOT',expectedFencingToken:Number(current.fencing_token)},'resume');assert.equal((await latest(chatIds[0])).state,'BOT');await checkpoint({phase:'ownership-readback',step:'resume',conversation:await latest(chatIds[0])});
 const resumed=await inbound('resumed',chatIds[0]);current=await wait(()=>latest(chatIds[0]),r=>r?.state==='HUMAN');assert.equal(current.flow_version_id,first.id);assert.equal(current.zammad_ticket_id,initial.conversation.zammad_ticket_id);
 const providerResumed=await verifyOutput('resumed',resumed,chatIds[0],'V1',providerBefore);
 await checkpoint({phase:'expected-contract',step:'returning',expectedTicketId:initial.conversation.zammad_ticket_id,expectedVersion:second.id});
 await post(`/api/bot-flows/conversations/${current.id}/command`,{action:'CLOSE',expectedFencingToken:Number(current.fencing_token)},'close');assert.equal((await latest(chatIds[0])).state,'RESOLVED');
 const returned=await inbound('returning',chatIds[0]);const returning=await wait(()=>latest(chatIds[0]),r=>r?.state==='HUMAN');assert.equal(returning.flow_version_id,second.id);await checkpoint({phase:'returning-ticket-readback',expectedTicketId:initial.conversation.zammad_ticket_id,actual: returning});assert.equal(returning.zammad_ticket_id,initial.conversation.zammad_ticket_id,'Returning customer must reopen original ticket');
 const providerReturned=await verifyOutput('returning',returned,chatIds[0],'V2',providerResumed);
 const newcomer=await inbound('new-customer',chatIds[1]);const fresh=await wait(()=>latest(chatIds[1]),r=>r?.state==='HUMAN');assert.equal(fresh.flow_version_id,second.id);assert.notEqual(fresh.zammad_ticket_id,returning.zammad_ticket_id);await verifyOutput('new-customer',newcomer,chatIds[1],'V2',providerReturned);
 assert.deepEqual(await groupLinks(),initialGroups);
 // Success-only disposition: an error/unknown effect never triggers an automatic finally pause.
 const drainReceipt=await drained();
 await checkpoint({phase:'direct-native-observation',step:'started'});
 const observation=await observeReturningTicket({ticketId:returning.zammad_ticket_id,marker:returned.marker});if(operatorSurface==='portal')assert.equal(observation.surface,'portal','Current producer requires actual WasalX rendering');const nativeReturning=(operatorSurface==='portal'?validateReturningPortalObservation:validateReturningNativeObservation)(observation,{ticketId:returning.zammad_ticket_id,marker:returned.marker});assert.equal(nativeReturning.observedTicketId,String(initial.conversation.zammad_ticket_id));
 await checkpoint({phase:'direct-native-observation',step:'finished'});
 const owned=await scoped('SELECT id,state,revision FROM bot_assignments WHERE tenant_id=$1 AND id=$2 AND connection_id=$3',[tenantId,assignment.assignmentId,connectionId]);assert.equal(owned.length,1);assert.equal(owned[0].state,'ACTIVE');
 if(finalAssignmentState==='PAUSED')await post(`/api/bot-flows/assignments/${assignment.assignmentId}/state`,{state:'PAUSED',expectedRevision:Number(owned[0].revision)},'pause-completed-assignment');
 const disposition=(await scoped('SELECT id,state,revision FROM bot_assignments WHERE tenant_id=$1 AND id=$2',[tenantId,assignment.assignmentId]))[0];assert.equal(disposition.state,finalAssignmentState);await checkpoint({phase:'assignment-disposition',disposition,drainReceipt});
 const finishedAt=new Date().toISOString(),prefix='direct-automation/human-handoff-pause-resume-and-bot-return::',returningTestId=prefix+'returning-customer-reopens-same-ticket::01',results=[['human-ownership-suppresses-bot-replies::01',{conversationId:human.conversation.id,state:human.conversation.state,providerUnchanged:true,duplicateNoEffect:true}],['explicit-resume-restores-bot-ownership::01',{conversationId:resumed.conversation.id,flowVersionId:current.flow_version_id,ticketId:current.zammad_ticket_id,outbound:outputProofs.find(x=>x.label==='resumed')}],['returning-customer-reopens-same-ticket::01',{returningTicketId:returning.zammad_ticket_id,initialTicketId:initial.conversation.zammad_ticket_id,newCustomerTicketId:fresh.zammad_ticket_id,currentVersionId:second.id}]].map(([suffix,proof])=>({testId:prefix+suffix+(operatorSurface==='portal'?'::portal':''),result:'passed',startedAt,finishedAt,contextId:'tenant_owner-en-desktop',proof}));results.push(nativeReturning.surface==='portal'?bindPortalOperatorResult({testId:returningTestId+'::portal',result:'passed',startedAt:nativeReturning.startedAt,finishedAt:nativeReturning.finishedAt,contextId:'agent-en-desktop',proof:nativeReturning},nativeReturning.portalBinding):bindNativeAgentResult({testId:returningTestId,result:'passed',startedAt:nativeReturning.startedAt,finishedAt:nativeReturning.finishedAt,contextId:'zammad_agent-en-desktop',proof:nativeReturning},nativeReturning.nativeBinding));return{evidenceMode:'simulated',fixtures:{tenantId,connectionId,assignmentId:assignment.assignmentId,chatIds:[...chatIds],firstVersionId:first.id,secondVersionId:second.id,returningConversationId:returning.id,newConversationId:fresh.id,deliveries:outputProofs.flatMap(p=>p.outbox.map(d=>({deliveryId:d.id,externalMessageId:d.external_message_id,recipient:d.external_chat_id})))},assignmentDisposition:disposition,drainReceipt,startedAt,finishedAt,proofs,results,outputProofs,duplicate,firstVersion:first.id,secondVersion:second.id,returning,fresh,limitations:['No real-provider acceptance','Text version pinning is not pinned media/history acceptance','Caller must preserve source overlay, candidate, receipts and pending state on error']};
}
