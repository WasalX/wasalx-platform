import assert from 'node:assert/strict';
import {sha256} from './simulation-mail-fixtures.mjs';
// Readbacks must come from real Postmaster/DB/browser and isolated SMTP capture.
// These assertions do not qualify a callback that fabricates internal state.
export function assertInbound(proof, expected) {
  assert.deepEqual(proof.ticketIds,[expected.ticketId]);
  assert.equal(proof.messageArticleCount,1);
  assert.equal(proof.groupId,expected.groupId); assert.equal(proof.ownerId,expected.ownerId);
  assert.equal(proof.routingApplicationStatus,'APPLIED');
  assert.equal(proof.renderedTicketId,expected.ticketId);
}
export function assertThread(proof, originalTicketId) {
  assert.deepEqual(proof.ticketIds,[originalTicketId]); assert.equal(proof.messageArticleCount,1);
  assert.equal(proof.renderedTicketId,originalTicketId);
}
export function assertAttachment(download, fixture) {
  assert.equal(download.authenticated,true); assert.equal(download.status,200);
  assert.equal(Buffer.from(download.bytes).length,fixture.length);
  assert.equal(sha256(download.bytes),sha256(fixture));
}
export function assertReply(proof, expected) {
  assert.equal(proof.acceptedMessages.length,1);
  const received=proof.acceptedMessages[0];
  assert.equal(received.messageId,expected.messageId); assert.equal(received.inReplyTo,expected.inReplyTo);
  assert.deepEqual(received.recipients,[expected.recipient]);
  assert.equal(proof.nativeArticleCount,1); assert.equal(proof.nativeSendState,'success');
}
export function assertFailure(proof) {
  assert.equal(proof.acceptedCount,0); assert.equal(proof.visibleFailure,true);
  assert.equal(proof.supportedNextAction,true); assert.equal(proof.claimsDelivered,false);
}
export function assertBounce(proof, ticketId, messageId) {
  assert.equal(proof.ticketId,ticketId); assert.equal(proof.originalMessageId,messageId);
  assert.equal(proof.visibleBounce,true); assert.equal(proof.claimsSuccessfulReceipt,false);
}


const normalizeMailId=value=>String(value??'').replace(/[<>]/gu,'');
const addressSha=value=>sha256(String(value));
// Source-shaped finite fixture predicate; no cache calls or product configuration writes.
// Only create/update, no OOO chain or mentions are admitted by this mail batch.
export function eligibleMailFixtureUsers(snapshot,expected,budget) {
  assert(['create','update','none'].includes(expected.notificationType));
  assert(['inbound','agent','system'].includes(expected.notificationActorKind));
  assert([null,'application_server','nil-or-scheduler-equivalent'].includes(expected.notificationInterfaceHandle));if(expected.notificationInterfaceHandle==='nil-or-scheduler-equivalent'){assert.equal(expected.notificationActorKind,'system');assert(snapshot.notificationUsers.filter(u=>u.groupFull).every(u=>u.id!==1),'System self-eligibility requires exact non-System group agents');assert.equal(expected.notificationInterfaceEvidence,'source-inferred-not-runtime-observed');assert(budget.sourceHashes['lib/transaction_dispatcher.rb']);assert(budget.sourceHashes['app/jobs/ticket_article_communicate_email_job.rb']);}
  const ticket=expected.ticketAfter;assert.equal(ticket.groupId,budget.groupId);assert.deepEqual(ticket.mentions,[]);
  const full=snapshot.notificationUsers.filter(u=>u.groupFull);assert(full.some(u=>u.id===ticket.ownerId)||ticket.ownerId===1,'Unadmitted owner notification path');
  if(expected.notificationType==='none')return[];
  const actor=expected.notificationActorKind==='agent'?budget.agentId:expected.notificationActorKind==='system'?1:null;
  return full.filter(u=>{
    assert(!u.outOfOffice&&u.replacementId==null,'OOO path outside this finite fixture budget');
    if(!u.active||u.mailDeliveryBlockedDays>0)return false;
    if(expected.notificationInterfaceHandle==='application_server'&&actor===u.id)return false;
    const config=u.notificationConfig;if(!config?.matrix)return false;
    const owned=ticket.ownerId===u.id,unowned=ticket.ownerId===1,selected=config.group_ids;
    if(!owned&&Array.isArray(selected)&&selected.length&&!(selected.length===1&&selected[0]==='-')&&!selected.some(id=>String(id)===String(ticket.groupId)))return false;
    const row=config.matrix[expected.notificationType];if(!row?.criteria||!row?.channel?.email)return false;
    return Boolean((owned&&row.criteria.owned_by_me)||(unowned&&row.criteria.owned_by_nobody)||row.criteria.no);
  }).map(u=>u.id).sort((a,b)=>a-b);
}
export function assertNativeMailQuiet(snapshot) {
  assert.equal(snapshot.evidenceMode,'simulated');
  for(const key of ['total','futureDue','failed','locked','unparsed'])assert.equal(snapshot.queue[key],0,'Native mail collection requires complete queue settlement');
  for(const a of snapshot.articles.filter(a=>a.sender==='Customer')){
    if(a.routingPayloadPresent){assert.equal(a.routingState,'APPLIED');assert.equal(a.routingAckState,'SUCCEEDED');}else{assert([null,''].includes(a.routingState));assert([null,''].includes(a.routingAckState));}
  }
}
export async function waitNativeMailQuiet(read,sourceHashes,{now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
 const deadline=now()+120000;
 for(;;){
  const value=await read();assert.deepEqual(value.sourceHashes,sourceHashes);
  assert.equal(value.queue.failed,0,'Native failed work requires reconciliation');
  assert.equal(value.queue.unparsed,0,'Unknown native work requires reconciliation');
  if(value.queue.total===0){assertNativeMailQuiet(value);return value;}
  assert(now()<deadline,'Native mail effects remain unsettled; reconcile without replay');
  await pause(500);
 }
}
// Admit only observed new-device mail from the two fixture sign-ins; retain the complete journal.
export function assertNativeAuthenticationPrefix({bytes,rows,native,baseline,namespace,tenantId,sinkId}) {
  assertNativeMailQuiet(native);assert.equal(native.channelId,null);assert.equal(native.tickets.length,0);assert.equal(native.articles.length,0);assert.equal(native.notificationHistory.length,0);
  assert.equal(native.notificationPlainOwnedSink,true);
  if(rows.length===0){assert.equal(bytes.length,0);assert.equal(baseline,undefined);return;}
  assert.equal(baseline?.kind,'native-authentication-prefix');assert.equal(baseline.evidenceMode,'simulated');
  for(const [key,value] of Object.entries({namespace,tenantId,sinkId}))assert.equal(baseline[key],value);
  assert.equal(baseline.preAuthJournalSha256,sha256(Buffer.alloc(0)));assert.equal(baseline.rawJournalSha256,sha256(bytes));
  assert.equal(baseline.journalSha256,sha256(JSON.stringify(rows)));assert.equal(baseline.nativeSha256,sha256(JSON.stringify(native)));assert.equal(baseline.configSha256,native.configSha256);
  assert.deepEqual(baseline.sourceHashes,native.sourceHashes);
  assert(Object.keys(native.sourceHashes).length>=12,'Complete email and device source binding required');
  for(const path of ['app/controllers/application_controller/handles_devices.rb','app/jobs/user_device_log_job.rb','app/models/user_device.rb'])assert.match(native.sourceHashes[path]??'',/^[a-f0-9]{64}$/u);
  assert.equal(baseline.productName,native.productName);assert.equal(typeof native.productName,'string');assert(native.productName.length>0);
  const users=native.notificationUsers.filter(u=>u.active&&u.agent&&u.groupFull);assert.equal(users.length,2);assert.equal(rows.length,2);assert.equal(baseline.actors.length,2);
  assert.deepEqual(baseline.actors.map(a=>a.userId).sort((a,b)=>a-b),users.map(u=>u.id).sort((a,b)=>a-b));
  assert.equal(new Set(rows.map(r=>r.messageId)).size,2);assert.equal(new Set(baseline.actors.map(a=>a.deviceId)).size,2);
  const observed=Date.parse(baseline.observedAt);assert(Number.isFinite(observed));
  for(const actor of baseline.actors){
    const user=users.find(u=>u.id===actor.userId);assert.deepEqual(actor.roles,user.roles);assert(actor.roles.includes(2));
    assert.match(actor.signInReceiptSha256??'',/^[a-f0-9]{64}$/u);
    const device=native.authDevices.find(d=>d.id===actor.deviceId&&d.userId===actor.userId);assert(device);
    const start=Date.parse(actor.startedAt),end=Date.parse(actor.completedAt),created=Date.parse(device.createdAt);
    assert([start,end,created].every(Number.isFinite)&&start<=created&&created<=end&&end<=observed,'Device must be newly created within its actual sign-in receipt');
    const matches=rows.filter(r=>r.recipients.length===1&&addressSha(r.recipients[0])===user.emailSha256);assert.equal(matches.length,1);
    const row=matches[0],sent=Date.parse(row.at);assert(Number.isFinite(sent)&&created<=sent&&sent<=observed);
    assert.equal(row.type,'accepted');assert.equal(row.subject,native.productName+' login from a new device');assert.equal(addressSha(row.from),native.notificationFromSha256);
    assert.equal(row.inReplyTo,'');assert.equal(row.references,'');assert(row.messageId&&!row.messageId.startsWith('notification.'));
  }
  return {journalSha256:baseline.journalSha256,rawJournalSha256:baseline.rawJournalSha256,rows:2};
}
export function assertFrozenMailBudget(snapshot,budget,step) {
  assert.equal(snapshot.namespace,budget.namespace);assert.equal(snapshot.groupId,budget.groupId);
  assert.equal(snapshot.channelId,budget.channelId);assert.equal(snapshot.configSha256,budget.configSha256,'Mail configuration/eligibility drift');
  assert.deepEqual(snapshot.sourceHashes,budget.sourceHashes,'Installed email source binding changed');
  assert.equal(snapshot.fqdn,budget.fqdn);assert.equal(snapshot.systemBccBlank,true);
  assert.equal(snapshot.accountPlainOwnedSink,true);assert.equal(snapshot.notificationPlainOwnedSink,true);
  const expected=budget.steps?.[step];assert(expected,'Missing reviewed before-ingress effect budget');
  assert(['inbound','agent','system'].includes(expected.actorKind));assert([null,'application_server'].includes(expected.interfaceHandle));
  assert(Array.isArray(expected.deliveries)&&Array.isArray(expected.notifications));
  const ids=expected.notifications.map(n=>n.userId);assert.equal(new Set(ids).size,ids.length,'One notification per eligible user in this finite action');
  assert.deepEqual([...ids].sort((a,b)=>a-b),eligibleMailFixtureUsers(snapshot,expected,budget),'Expected notification recipients do not match installed finite fixture eligibility');
  for(const n of expected.notifications){
    const u=snapshot.notificationUsers.find(u=>u.id===n.userId);assert(u?.active&&u.agent&&u.groupFull&&!u.outOfOffice&&u.replacementId==null&&u.mailDeliveryBlockedDays===0);
    assert.equal(u.emailSha256,addressSha(n.recipient));assert.equal(u.preferencesSha256,n.preferencesSha256);
    assert(['create','update'].includes(n.type));
  }
  return expected;
}
// Parsed SMTP rows are independent durable fixture evidence. No provider send or native job execution.
export function assertNativeMailEffects({before,after,baseline,rows,budget,step,ticketId,articleId,failedArticleId,operation}) {
  const expected=assertFrozenMailBudget(before,budget,step);assertFrozenMailBudget(after,budget,step);assertNativeMailQuiet(before);assertNativeMailQuiet(after);
  assert.deepEqual(rows.slice(0,baseline.length),baseline,'SMTP journal prefix changed');
  const added=rows.slice(baseline.length);assert(added.every(r=>['accepted','rejected','fault-consumed'].includes(r.type)),'Unknown SMTP journal effect');
  const beforeArticleIds=new Set(before.articles.map(a=>a.articleId));
  const articles=after.articles.filter(a=>!beforeArticleIds.has(a.articleId));
  assert(articles.every(a=>a.ticketId===ticketId),'Unexpected ticket in finite email action');
  assert.equal(operation.interfaceHandle,expected.interfaceHandle,'Actual native action interface differs from pre-action budget');
  const subject=after.articles.find(a=>a.articleId===(failedArticleId??articleId));assert(subject);
  // AutoResponseCheck persists header classification before BounceFollowUpCheck
  // sets its transient parser flag; recognizing a DSN does not rewrite that preference.
  if(['initial','followup','bounce'].includes(step)){assert.equal(subject.sender,'Customer');assert.equal(subject.type,'email');assert.equal(subject.internal,false);assert.equal(operation.ingressEntryPoint,'Channel::EmailParser.process');assert.equal(subject.autoResponse,false,'These ingress fixtures have no auto-response classification headers');if(step==='initial'){assert.equal(subject.routingPayloadPresent,true);assert.equal(subject.routingState,'APPLIED');assert.equal(subject.routingAckState,'SUCCEEDED');}else{assert.equal(before.tickets.find(t=>t.id===ticketId)?.clientRouteStatus,'MATCHED');assert.equal(subject.routingPayloadPresent,false);assert([null,''].includes(subject.routingState));assert([null,''].includes(subject.routingAckState));}}
  if(expected.actorKind==='system')assert.equal(operation.actorId,1);
  else assert.equal(operation.actorId,subject.createdById,'Actual action/native article actor mismatch');
  if(expected.actorKind==='agent')assert.equal(operation.actorId,budget.agentId);
  const currentTicket=after.tickets.find(t=>t.id===ticketId);assert(currentTicket);
  assert.deepEqual({ownerId:currentTicket.ownerId,groupId:currentTicket.groupId,mentions:currentTicket.mentions},expected.ticketAfter);
  const previousTicket=before.tickets.find(t=>t.id===ticketId);
  assert.deepEqual(previousTicket?{ownerId:previousTicket.ownerId,groupId:previousTicket.groupId,mentions:previousTicket.mentions}:null,expected.ticketBefore);
  const actualMail=articles.filter(a=>a.type==='email'&&a.sender!=='Customer');
  const deliveries=[];
  for(const d of expected.deliveries){
    const matches=actualMail.filter(a=>a.sender===d.sender&&a.internal===false&&a.performOrigin===d.performOrigin&&(d.subjectArticle===true?a.articleId===articleId:true));
    assert.equal(matches.length,1,'Exactly one admitted native System/Agent email article required');
    const a=matches[0];assert.equal(a.deliveryStatus,'success');assert.equal(a.deliveryRetry,1);assert.equal(a.deliveryChannelId,budget.channelId);
    const found=added.filter(r=>r.type==='accepted'&&r.messageId===normalizeMailId(a.messageId));assert.equal(found.length,1,'Exact native Message-ID delivered once');
    assert.deepEqual(found[0].recipients,[d.recipient]);assert.equal(addressSha(found[0].from),after.accountFromSha256);assert.equal(a.ccBlank,true);deliveries.push(found[0]);
  }
  const failed=expected.failed;
  if(failed){
    assert(Number.isSafeInteger(failedArticleId));const a=actualMail.find(a=>a.articleId===failedArticleId);assert(a);
    assert.equal(a.sender,'Agent');assert.equal(a.internal,false);assert.equal(a.deliveryStatus,'fail');assert.equal(a.deliveryRetry,4);assert.equal(a.deliveryChannelId,budget.channelId);assert.equal(a.ccBlank,true);
    assert.equal(added.filter(r=>r.type==='accepted'&&r.messageId===normalizeMailId(a.messageId)).length,0);
    assert.equal(failed.faultIds.length,4);assert.equal(new Set(failed.faultIds).size,4);
    const rejected=added.filter(r=>r.type==='rejected');assert.equal(rejected.length,4);
    for(const row of rejected){assert.equal(row.messageId,normalizeMailId(a.messageId));assert.deepEqual(row.recipients,[failed.recipient]);assert.equal(addressSha(row.from),after.accountFromSha256);const consumed=added[added.indexOf(row)-1];assert.equal(consumed?.type,'fault-consumed');assert.equal(consumed.kind,'reject');assert(failed.faultIds.includes(consumed.faultId));}
    const consumed=added.filter(r=>r.type==='fault-consumed');assert.deepEqual(consumed.map(r=>r.faultId).sort(),[...failed.faultIds].sort());assert(consumed.every(r=>r.kind==='reject'));
    const related=articles.filter(n=>n.relatedDeliveryArticleId===a.articleId);assert.equal(related.length,1);assert.equal(related[0].sender,'System');assert.equal(related[0].type,'note');assert.equal(related[0].internal,true);
  }else assert(!added.some(r=>r.type!=='accepted'),'Unexpected SMTP rejection/fault');
  assert.equal(actualMail.length,expected.deliveries.length+(failed?1:0),'Unbudgeted native outgoing article');
  const previousHistory=new Set(before.notificationHistory.map(h=>h.id));
  const histories=after.notificationHistory.filter(h=>!previousHistory.has(h.id)&&h.channels.includes('email'));
  assert.equal(histories.length,expected.notifications.length,'Missing or extra native email notification History');
  const notifications=[];
  for(const n of expected.notifications){
    const history=histories.filter(h=>h.ticketId===ticketId&&h.userId===n.userId&&h.type===n.type&&h.recipientSha256===addressSha(n.recipient));assert.equal(history.length,1);
    assert.equal(history[0].createdById,n.actorKind==='system'?1:operation.actorId);
    const found=added.filter(r=>{
      if(r.type!=='accepted')return false;
      const m=r.messageId.match(/^notification\.\d{14}\.(\d+)\.(\d+)\.[a-f0-9-]{36}@(.+)$/u);
      return m&&Number(m[1])===ticketId&&Number(m[2])===n.userId&&m[3]===budget.fqdn;
    });assert.equal(found.length,1,'Exact source-shaped notification delivered once');assert.deepEqual(found[0].recipients,[n.recipient]);assert.equal(addressSha(found[0].from),after.notificationFromSha256);notifications.push(found[0]);
  }
  assert.equal(added.filter(r=>r.type==='accepted').length,deliveries.length+notifications.length,'Unknown accepted SMTP effect');
  return{settled:true,unknown:0,deliveries,notifications,rejectedCount:failed?4:0,nativeQueueTotal:0};
}
export async function parseSmtpEffectRows(bytes,parseMail,{allowVerification=false,verificationMailbox}={}) {
  assert(Buffer.isBuffer(bytes)&&bytes.length<=16*1024*1024);const rows=bytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert(rows.length<=1000);if(allowVerification)assert.match(verificationMailbox??'',/^support-[a-z0-9-]+@alpha\.invalid$/u);
  const parsed=await Promise.all(rows.map(async row=>{
    if(row.type==='fault-consumed')return row;
    if(row.type==='mailbox-verification-expunged'){
      assert(allowVerification,'Historical journal cannot gain verification effects');assert.deepEqual(Object.keys(row).sort(),['at','marker','sha256','type','uid']);
      assert(Number.isSafeInteger(row.uid)&&row.uid>0);assert.match(row.marker??'',/^wasalx-mail-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu);assert.match(row.sha256??'',/^[a-f0-9]{64}$/u);assert(Number.isFinite(Date.parse(row.at)));return row;
    }
    assert(['accepted','rejected'].includes(row.type));assert(Array.isArray(row.recipients)&&row.recipients.length>0);
    const raw=Buffer.from(row.bytesBase64,'base64');assert(raw.length<=1048576);assert.equal(sha256(raw),row.sha256);
    const headers=await parseMail(raw);assert(headers.messageId);return{...row,...headers,messageId:normalizeMailId(headers.messageId)};
  }));
  if(allowVerification){const accepted=[],deleted=new Set();for(const row of parsed){
    if(row.type==='accepted'){
      const raw=Buffer.from(row.bytesBase64,'base64'),end=raw.indexOf('\r\n\r\n');assert(end>=0);
      const matches=[...raw.subarray(0,end).toString('utf8').matchAll(/^X-Zammad-Test-Message:[ \t]*(wasalx-mail-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})[ \t]*$/gimu)];
      if(matches.length){assert.equal(matches.length,1);const marker=matches[0][1];assert.equal(row.subject,'WasalX verification '+marker);assert.equal(row.from,verificationMailbox);assert.deepEqual(row.recipients,[verificationMailbox]);accepted.push({marker,sha256:row.sha256});}
    }else if(row.type==='mailbox-verification-expunged'){
      assert(!deleted.has(row.uid),'Verification UID expunged twice');assert.deepEqual(accepted[row.uid-1],{marker:row.marker,sha256:row.sha256},'Verification expunge must name its exact earlier accepted UID');deleted.add(row.uid);
    }
  }}return parsed;
}

// Resume only the already-reconciled initial email; current effects are checked before UI/ingress.
export function assertRetainedInitialEmail(retained,setup,namespace,tenantId,freshReadback) {
 assert.equal(retained.kind,'reconciled-native-email-initial');assert.equal(retained.evidenceMode,'simulated');assert.equal(retained.namespace,namespace);assert.equal(retained.tenantId,tenantId);
 assert.equal(retained.channelId,setup.channel.channelId);assert.equal(retained.sinkId,setup.ownership.sinkId);assert.equal(retained.routingVersionId,setup.routing.routingVersionId);assert.equal(retained.setupEffectReceiptSha256,sha256(JSON.stringify(setup.effectReceipt)));
 assert.equal(retained.initialIntentSha256,sha256(JSON.stringify(retained.initialIntent)));assert.equal(retained.initialIntent.runId,namespace);assert.equal(retained.initialIntent.evidenceMode,'simulated');assert.equal(retained.initialIntent.isolated,true);assert.equal(retained.initialIntent.channelId,retained.channelId);assert.equal(retained.initialIntent.messageId,'<'+namespace+'.initial@alpha.invalid>');
 assert.equal(retained.initialIntent.sha256,sha256(Buffer.from(retained.initialIntent.bytesBase64,'base64')));
 assert.equal(retained.initialReadback.articles.length,1);const article=retained.initialReadback.articles[0];assert.equal(article.messageId,retained.initialIntent.messageId);assert.equal(article.ticketId,retained.initial.ticketId);assert.equal(article.articleId,retained.initial.articleId);assert.equal(String(article.groupId),String(setup.channel.groupId));assert.equal(article.routingState,'APPLIED');assert.equal(article.routingAckState,'SUCCEEDED');
 assert.equal(retained.effectReceipt.lastStep,'initial');assert.equal(retained.effectReceipt.configSha256,setup.effectReceipt.configSha256);for(const key of ['nativeSha256','journalSha256','configSha256'])assert.match(retained.effectReceipt[key],/^[a-f0-9]{64}$/u);
 if(freshReadback){assert(Number.isFinite(Date.parse(freshReadback.at)));assert.deepEqual(freshReadback.articles,retained.initialReadback.articles,'Retained initial article drift');}
 return retained;
}
