import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {nativeFixtureRunner} from './simulation-email-stages.mjs';
import {parseSmtpEffectRows} from './simulation-mail-assertions.mjs';
import {parsePrivateMail} from './simulation-private-mail.mjs';
import {ownedSmtpFiles} from './simulation-smtp-files.mjs';
import {inspectComposeService} from './simulation-stack-session.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const messageId=value=>String(value??'').replace(/[<>]/gu,'');
export async function portalMailRunner(session,namespace,sourceHashes){
 const ruby=await nativeFixtureRunner(session,namespace,sourceHashes),container=session.containers['zammad-railsserver'].Id,dir='/run/wasalx-simulation/email-stage-'+namespace;
 const uid=(await session.run('docker',['exec',container,'id','-u'])).trim();assert.match(uid,/^\d+$/u);
 for(const name of ['portal-readback.rb','portal-mail-notifications.rb','postmaster-ingress.rb']){await session.run('docker',['cp',join(session.driverRoot,'scripts/release/simulation-email',name),container+':'+dir+'/'+name]);await session.run('docker',['exec','-u','0',container,'chown',uid,dir+'/'+name]);await session.run('docker',['exec','-u','0',container,'chmod','600',dir+'/'+name]);}
 return ruby;
}
export function assertPortalMailEffectDelta({before,after,baseline,rows,spec,namespace,step,ticketId,articleId,failedArticleId,operation,nativeUserId}){
 assert.deepEqual(rows.slice(0,baseline.length),baseline,'Provider journal prefix changed');assert.equal(after.nativeQueueTotal,0);assert.equal(after.pendingEmailJobs,0);
 assert.equal(after.configSha256,before.configSha256,'Mail configuration changed during a finite action');assert.deepEqual(after.sourceHashes,before.sourceHashes);
 const target=Number(ticketId),priorArticles=new Map(before.articles.map(row=>[row.articleId,row]));
 for(const previous of before.articles)assert.deepEqual(after.articles.find(row=>row.articleId===previous.articleId),previous,'An existing article changed during the finite action');
 for(const previous of before.tickets){const retained=after.tickets.find(row=>row.id===previous.id);assert(retained,'An existing ticket disappeared');if(previous.id!==target)assert.deepEqual(retained,previous,'An unrelated ticket changed');}
 const priorTicketIds=new Set(before.tickets.map(row=>row.id));assert(after.tickets.filter(row=>!priorTicketIds.has(row.id)).every(row=>row.id===target),'An unrelated empty ticket was created');assert(after.tickets.some(row=>row.id===target),'Target ticket missing');
 for(const previous of before.notificationHistory)assert.deepEqual(after.notificationHistory.find(row=>row.id===previous.id),previous,'An existing native notification history row changed or disappeared');
 const articles=after.articles.filter(row=>!priorArticles.has(row.articleId));assert(articles.every(row=>row.ticketId===target),'Unbudgeted ticket article');
 const subject=after.articles.find(row=>row.articleId===Number(failedArticleId??articleId));assert(subject&&subject.ticketId===target);
 if(operation?.actorId!==undefined&&['reply','failure','fixture'].includes(step))assert.equal(Number(operation.actorId),Number(nativeUserId));
 if(['reply','failure','fixture'].includes(step))assert.equal(subject.createdById,Number(nativeUserId),'Native actor differs from the actual portal human');
 if(['initial','followup','bounce'].includes(step)){assert.equal(subject.sender,'Customer');assert.equal(subject.type,'email');assert.equal(subject.internal,false);assert.equal(operation.ingressEntryPoint,'Channel::EmailParser.process');}
 if(step==='fixture'){assert.equal(subject.type,'note');assert.equal(subject.internal,true);assert.equal(subject.sender,'Agent');}
 if(step==='initial'){assert.equal(subject.routingState,'APPLIED');assert.equal(subject.routingAckState,'SUCCEEDED');}
 const added=rows.slice(baseline.length);assert(added.every(row=>['accepted','rejected','fault-consumed'].includes(row.type)),'Unexpected verification or provider event after setup');
 const seen=new Set(),deliveries=[],notifications=[],outgoing=articles.filter(row=>row.type==='email'&&!row.internal&&row.sender!=='Customer');
 for(const article of outgoing){
  assert.equal(article.deliveryChannelId,Number(spec.channelId));assert.equal(article.ccBlank,true);
  const indexes=added.flatMap((row,index)=>row.type==='accepted'&&row.messageId===messageId(article.messageId)?[index]:[]);
  if(article.articleId===Number(failedArticleId)){
   assert.equal(article.deliveryStatus,'fail');assert.equal(article.deliveryRetry,4);assert.equal(indexes.length,0);
   const rejected=added.filter(row=>row.type==='rejected');assert.equal(rejected.length,4);assert(rejected.every(row=>row.messageId===messageId(article.messageId)&&row.from===spec.mailbox&&row.recipients.length===1&&row.recipients[0]==='failure-'+namespace.toLowerCase()+'@alpha.invalid'));
   const expected=Array.from({length:4},(_,index)=>namespace+'-reject-'+index),consumed=added.filter(row=>row.type==='fault-consumed');assert.deepEqual(consumed.map(row=>row.faultId).sort(),expected.sort());assert(consumed.every(row=>row.kind==='reject'));
   assert.equal(articles.filter(row=>row.relatedArticleId===article.articleId&&row.sender==='System'&&row.type==='note'&&row.internal).length,1);
  }else{
   assert.equal(article.deliveryStatus,'success');assert.equal(indexes.length,1,'Exactly one native Message-ID acceptance required');const index=indexes[0],row=added[index];
   assert.equal(row.from,spec.mailbox);assert.deepEqual(row.recipients,[article.to]);assert(spec.allowedRecipients.includes(article.to));assert(!seen.has(index));seen.add(index);deliveries.push(row);
  }
 }
 if(step==='reply')assert.equal(outgoing.filter(row=>row.articleId===Number(articleId)&&row.sender==='Agent').length,1);
 if(step==='failure')assert.equal(outgoing.length,1);
 if(step==='initial')assert.equal(outgoing.filter(row=>row.sender==='System').length,1);
 if(['followup','bounce','fixture'].includes(step))assert.equal(outgoing.length,0);
 const previousHistory=new Set(before.notificationHistory.map(row=>row.id)),histories=after.notificationHistory.filter(row=>!previousHistory.has(row.id)&&row.channels.includes('email'));
 assert(histories.length<=4,'Unexpected notification amplification');
 for(const history of histories){
  assert.equal(history.ticketId,target);assert(after.nativeUserIds.includes(history.userId));assert([1,Number(nativeUserId),subject.createdById].includes(history.createdById));
  assert(Number.isFinite(Date.parse(history.createdAt)),'Native notification history time required');
  const indexes=added.flatMap((row,index)=>{if(row.type!=='accepted'||seen.has(index))return[];const match=row.messageId.match(/^notification\.\d{14}\.(\d+)\.(\d+)\.[a-f0-9-]{36}@/u),elapsed=Date.parse(history.createdAt)-Date.parse(row.at);return match&&Number(match[1])===target&&Number(match[2])===history.userId&&Number.isFinite(elapsed)&&elapsed>=-1000&&elapsed<=30000?[index]:[];});
  assert(indexes.length>0,'Notification needs an unused native ticket/user history and bounded synchronous SMTP receipt');const index=indexes[0],row=added[index];seen.add(index);
  assert.equal(row.recipients.length,1);assert.equal(hash(row.recipients[0]),history.recipientSha256);assert(spec.allowedRecipients.includes(row.recipients[0]));assert(spec.allowedSenders.includes(row.from));notifications.push({...row,nativeHistoryId:history.id,correlation:'ticket-user-chronological-history'});
 }
 assert.equal(added.filter(row=>row.type==='accepted').length,seen.size,'Unexplained SMTP acceptance');
 if(step!=='failure')assert(added.every(row=>row.type==='accepted'),'Unplanned provider rejection/fault');
 return{settled:true,unknown:0,nativeQueueTotal:0,deliveries,notifications,rejectedCount:step==='failure'?4:0};
}
export async function createPortalMailEffects(session,namespace,email){
 const spec={...email.syntheticMailbox,channelId:email.channel.channelId},ruby=await portalMailRunner(session,namespace,email.sourceHashes);
 const sink=await inspectComposeService(session.run,session.model.name,'alpha-smtp');assert.equal(sink.Id,email.ownership.sinkId);const smtp=await ownedSmtpFiles(session,sink);
 const read=()=>ruby('portal-readback.rb',{operatorSurface:'portal',namespace,groupId:Number(email.channel.groupId),channelId:Number(email.channel.channelId),nativeUserIds:email.nativeUserIds,mailboxCreateOperationId:email.ownership.nativeMailboxCreateOperationId,ownerNativeUserId:Number(email.ownership.ownerNativeUserId),ownerPortalUserId:email.ownership.ownerPortalUserId,syntheticMailbox:email.syntheticMailbox,sourceHashes:email.sourceHashes});
 const journal=async()=>parseSmtpEffectRows(await smtp.read('journal.jsonl'),raw=>parsePrivateMail(raw,{headersOnly:true}),{allowVerification:true,verificationMailbox:spec.mailbox});
 const quiet=async()=>{const deadline=Date.now()+240000;while(true){const native=await read();if(native.nativeQueueTotal===0&&native.pendingEmailJobs===0)return native;assert(Date.now()<deadline,'Native mail effects remain unsettled; never resend');await new Promise(resolve=>setTimeout(resolve,1000));}};
 let receipt=email.effectReceipt;
 const admit=native=>{assert.equal(native.accountOwnedTls,true);assert.equal(native.notificationOwnedTls,true);assert.equal(native.otherActiveAccounts,0);assert.equal(native.systemBccBlank,true);assert.deepEqual(native.nativeUserIds,[...email.nativeUserIds].map(Number).sort((a,b)=>a-b));assert.deepEqual(native.sourceHashes,email.sourceHashes);};
 return{get receipt(){return receipt;},read,journal,smtp,ruby,async before(step){const native=await quiet();admit(native);const rows=await journal();if(receipt){assert.equal(hash(native),receipt.nativeSha256);assert.equal(hash(rows),receipt.journalSha256);}await session.checkpoint({phase:'portal-email-effect-before',step,nativeSha256:hash(native),journalSha256:hash(rows),journalCount:rows.length});return{native,rows};},
 async settle(step,before,bindings){const after=await quiet();admit(after);const rows=await journal();const proof=assertPortalMailEffectDelta({before:before.native,after,baseline:before.rows,rows,spec,namespace,step,...bindings,nativeUserId:email.nativeUserId});receipt={nativeSha256:hash(after),journalSha256:hash(rows),configSha256:after.configSha256,lastStep:step};await session.checkpoint({phase:'portal-email-effect-settled',step,...receipt,accepted:proof.deliveries.length,notifications:proof.notifications.length,rejected:proof.rejectedCount,unknown:0});return proof;}};
}
