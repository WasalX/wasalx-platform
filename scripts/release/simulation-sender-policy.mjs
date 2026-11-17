import assert from 'node:assert/strict';
import {operationResultId} from './simulation-rule-versions.mjs';
import {findRuleSet} from './seed-simulation-group.mjs';
import {createHash} from 'node:crypto';
import {simulationEventId,assertIngressReceipts} from './synthetic-first-group-driver.mjs';

import {admitNativeMailUi} from './simulation-native-mail-browser.mjs';
const BASE='group-rules/commands-triggers-and-friendly-ticket-naming::configured-team-sender-policy-controls-group-trigger-effects::';
export async function runSenderPolicyGaps(s){
 const {request,nativePage,connectionId,tenantId,groupId,externalGroupId,runId,control,drainEffects,participants,scoped,effects,providerRead,checkpoint,nativeQuality,captureNativeEvidence,bindingPath,bindingBody}=s;
 const ruleSet=id=>findRuleSet(request,id);
 const proofs=[];const mark=async(id,proof)=>{const nativeBinding=id==='exclude-retains-history'?await captureNativeEvidence():{};const row={testId:BASE+id,at:new Date().toISOString(),result:'passed',proof,...nativeBinding};proofs.push(row);await checkpoint({phase:'proof',...row});};
 const poll=async fn=>{const until=Date.now()+120000;for(;;){const v=await fn();if(v)return v;if(Date.now()>until)throw Error('Sender batch deadline; reconcile retained intent without replay');await new Promise(r=>setTimeout(r,300));}};
 const snapshots=new Map();let included;for(const policy of ['exclude','include','rollback']){
  let activeId=s.ruleSetId;
  if(policy==='include'){
   const source=await ruleSet(s.ruleSetId);assert(source&&source.state==='ACTIVE');snapshots.set(source.id,source.snapshot_sha256);
   const rules=source.rules.map(value=>{const rule={...value};delete rule.id;return {...rule,matcherOptions:{...rule.matcherOptions,teamSenderPolicy:'include'}}});
   const created=await request('/api/rule-sets/'+source.id+'/clone','POST',{rules},'sender-include-clone');
   const draft=await ruleSet(operationResultId(created));assert(draft&&draft.state==='DRAFT');
   await request('/api/rule-sets/'+draft.id+'/activate','POST',{expectedRevision:Number(draft.revision),expectedActiveRuleSetId:source.id,expectedActiveRevision:Number(source.revision)},'sender-include-activate');
   const active=await ruleSet(draft.id);assert(active&&active.state==='ACTIVE');assert.equal(active.rules[0].matcherOptions?.teamSenderPolicy,'include');activeId=active.id;included=active;snapshots.set(active.id,active.snapshot_sha256);
   await request(bindingPath,'PUT',bindingBody(await request(bindingPath),activeId),'include-bind');
   await mark('activate',{ruleSetId:activeId,state:active.state,snapshot:active.snapshot_sha256,policy:'include'});
  }
  if(policy==='rollback'){
   const source=await ruleSet(s.ruleSetId),active=await ruleSet(included.id);assert(source&&source.state==='RETIRED');assert(active&&active.state==='ACTIVE');
   const receipt=await request('/api/rule-sets/'+source.id+'/rollback','POST',{expectedSourceRevision:Number(source.revision),expectedActiveRuleSetId:active.id,expectedActiveRevision:Number(active.revision)},'sender-policy-rollback');
   const restored=await ruleSet(operationResultId(receipt));assert(restored&&restored.state==='ACTIVE');assert.equal(restored.snapshot_sha256,snapshots.get(source.id));assert.notEqual(restored.id,source.id);activeId=restored.id;
   await request(bindingPath,'PUT',bindingBody(await request(bindingPath),activeId),'rollback-bind');
  }
  const observations=[];
  for(const index of [0,1]){
   const participant=participants[index],reference='78493012'+(policy==='include'?'2':'1')+index;
   const input={eventId:simulationEventId(runId+'-'+policy+'-'+index),messageId:'false_'+externalGroupId+'_'+runId+'-'+policy+'-'+index,chatId:externalGroupId,participant,text:'ID '+reference};
   const find=()=>scoped("SELECT id,status,processed_at,lease_id,safe_error FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId]);assert.equal((await find()).length,0);
   assert.equal((await scoped('SELECT app.group_rule_sender($1,$2,$3,$4) sender',[tenantId,connectionId,externalGroupId,participant]))[0].sender,'team');
   const before=await effects(),providerBefore=await providerRead();await checkpoint({phase:'sender-intent',policy,index,input});const receipt=await control({action:'inbound',input});await checkpoint({phase:'sender-accepted',policy,index,receipt});
   const inbox=await poll(async()=>{const r=(await find())[0];return r?.processed_at&&r.lease_id===null?r:null;});await drainEffects();assertIngressReceipts(receipt,false,inbox.id);
   let native;
   if(policy!=='include'){
    assert.equal(inbox.status,'UNMATCHED');assert.equal(inbox.safe_error,'TEAM_SENDER_EXCLUDED');assert.deepEqual(await effects(),before);assert.deepEqual(await providerRead(),providerBefore);
    const normalized=(await scoped('SELECT id FROM normalized_messages WHERE connection_id=$1 AND external_message_id=$2',[connectionId,input.messageId]))[0];assert(normalized);
    const history=s.observeHistory?await s.observeHistory({groupId,messageId:normalized.id}):await nativePage.evaluate(async({groupId,messageId})=>{const r=await fetch('/api/v1/wasalx/group_workspace/groups/'+groupId+'/messages?limit=100');if(!r.ok)throw Error('Native history denied');const rows=await r.json();return rows.find(x=>x.id===messageId);},{groupId,messageId:normalized.id});assert(history,'Excluded team message not retained in native history');
    await mark('exclude-retains-history',{messageId:input.messageId,...(s.observeHistory?{portalHistoryId:history.id,authorizedPortalRead:true}:{nativeHistoryId:history.id,authorizedNativeRead:true}),policy,participantSha256:createHash('sha256').update(participant).digest('hex')});
    if(policy==='exclude'&&index===0&&nativeQuality)await nativeQuality({...s,messageId:normalized.id,externalMessageId:input.messageId,groupId});
   }else{
    assert.equal(inbox.status,'PROCESSED');const outbox=await poll(async()=>{const n=(await effects()).outbox.filter(x=>!before.outbox.some(y=>y.id===x.id));return n.length===1&&n[0].state==='SENT'?n:null;});assert.equal(Number(outbox[0].attempts),1);
    const delivery=(await scoped('SELECT id,external_message_id,message_body FROM delivery_outbox WHERE id=$1',[outbox[0].id]))[0];assert(delivery);const providerReceipt=assertIncludedReceipt(providerBefore,await providerRead(),delivery,externalGroupId);await checkpoint({phase:'included-provider-proof',outboxId:delivery.id,receipt:providerReceipt,textSha256:providerReceipt.textSha256});
    const links=await scoped('SELECT id,zammad_ticket_id,zammad_article_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,input.messageId]);assert.equal(links.length,1);
    native=s.readNativeTicket?await s.readNativeTicket(String(links[0].zammad_ticket_id)):await nativePage.evaluate(async id=>{const r=await fetch('/api/v1/tickets/'+id);if(!r.ok)throw Error('Native ticket denied');const t=await r.json();return{id:t.id,title:t.title};},links[0].zammad_ticket_id);assert(native.title.includes(reference));if(s.observeTicket)await s.observeTicket(native,{articleId:links[0].zammad_article_id,marker:input.text});else {await nativePage.goto(new URL(nativePage.url()).origin+'/desktop/tickets/'+native.id);await admitNativeMailUi(nativePage);await nativePage.getByText(native.title,{exact:true}).first().waitFor({state:'visible',timeout:20000});}
   }
   observations.push({input,inbox,native});
  }
  for(const [id,hash] of snapshots)assert.equal((await ruleSet(id)).snapshot_sha256,hash);await mark(policy==='rollback'?'rollback':policy+'-team',{observations,twoDistinctTeamNumbers:true,historicalSnapshotsUnchanged:true,activeId});
 }
 return{proofs,scope:'Two team numbers under each policy; actual native history and included ticket title; no customer duplicate repetition'};
}

export function assertIncludedReceipt(before,after,delivery,group){
 assert(Array.isArray(before.receipts)&&Array.isArray(after.receipts));const delta=after.receipts.filter(x=>!before.receipts.some(y=>y.id===x.id));assert.equal(delta.length,1,'Expected exactly one new included operation receipt');const receipt=delta[0];assert.equal(receipt.id,delivery.external_message_id);assert(receipt.id.startsWith('true_'+group+'_'));assert.equal(receipt.textSha256,createHash('sha256').update(delivery.message_body).digest('hex'));return receipt;
}
