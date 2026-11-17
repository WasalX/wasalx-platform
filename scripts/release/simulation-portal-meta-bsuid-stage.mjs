import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {open,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {assertMetaRuntimeBinding,assertMetaFixtureProvenance} from './simulation-meta-producer.mjs';
import {assertPortalFixtureMachineTarget} from './simulation-portal-groups.mjs';
import {privateConfigPath} from './simulation-meta-runtime.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {uploadPinnedAsset} from './simulation-pinned-assets.mjs';
import {ensurePortalOperator,withPortalOperatorEvidence,openPortalTicket,privateNativeRead} from './simulation-portal-operator.mjs';
import {submitPortalReply} from './simulation-portal-reply-browser.mjs';
import {downloadPortalMailAttachment} from './simulation-portal-mail-browser.mjs';
import {metaInput} from './simulation-meta-input.mjs';
import {metaReaders} from './simulation-meta-choice-readers.mjs';
import {runMetaDeliveryStatuses} from './simulation-meta-status.mjs';

const portalUuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
export const portalMetaBsuidContexts=['tenant_owner-en-desktop','agent-en-desktop'];
export function portalBsuidState(ticket,states){assert(Array.isArray(states));const rows=states.filter(row=>String(row.id)===String(ticket.state_id));assert.equal(rows.length,1);assert.equal(rows[0].active,true);assert.equal(typeof rows[0].name,'string');return rows[0].name;}
export function assertPortalBsuidReply({receipt,article,ticketId,body,nativeUserId}){
 assert.equal(receipt.state,'APPLIED','Unconfirmed original reply must remain held');assert.match(receipt.operationId??'',portalUuid);assert.equal(String(receipt.ticketId),String(ticketId));assert.equal(String(article.ticket_id),String(ticketId));assert.equal(String(article.id),String(receipt.articleId));assert.equal(String(article.created_by_id),String(nativeUserId));assert.equal(article.body,body);assert.equal(article.content_type,'text/plain');assert.equal(article.internal,false);assert.equal(article.sender,'Agent');assert.equal(article.type,'wasalx group message');
}
export function assertPortalBsuidMedia({attachment,nativeFile,download,asset}){
 const preferences=attachment.preferences??{},mime=String(preferences['Content-Type']??preferences['Mime-Type']??'').split(';')[0].trim().toLowerCase();assert.equal(mime,'image/png');assert.equal(nativeFile.filename,attachment.filename);assert.equal(nativeFile.byteSize,asset.bytes);assert.equal(nativeFile.sha256,asset.sha256);assert.equal(download.authenticated,true);assert.equal(download.status,200);assert.equal(download.filename,attachment.filename);assert(Buffer.isBuffer(download.bytes));assert.equal(download.bytes.length,asset.bytes);assert.equal(createHash('sha256').update(download.bytes).digest('hex'),asset.sha256);assert.equal(download.sha256,asset.sha256);
 return {mime,bytes:asset.bytes,sha256:asset.sha256,filename:attachment.filename,nativeBytesBound:true,portalDownload:true,status:200};
}
export async function persistPortalBsuidReplyIntent(s,{namespace,ticketId,body,nativeUserId,input}){
 assert(/^[A-Za-z0-9_-]{1,30}$/u.test(namespace));assert.deepEqual(Object.keys(input).sort(),['body','expected_updated_at','internal','operation_id','ticket_id']);assert.match(input.operation_id??'',portalUuid);assert.equal(String(input.ticket_id),String(ticketId));assert.equal(input.body,body);assert.equal(input.internal,false);assert.equal(typeof input.expected_updated_at,'string');assert(input.expected_updated_at.length>0&&input.expected_updated_at.length<=100);assert.match(String(nativeUserId),/^[1-9][0-9]*$/u);
 const file=await open(join(s.privateDir,'meta-bsuid-'+namespace+'-human-reply.intent.json'),'wx',0o600);try{await file.writeFile(JSON.stringify({evidenceMode:'simulated',operatorSurface:'portal',namespace,tenantId:s.tenantId,ticketId:String(ticketId),nativeUserId:String(nativeUserId),operationId:input.operation_id,input,disposition:'original-operation-held-no-replay'}));await file.sync();}finally{await file.close();}
 await s.checkpoint({phase:'bsuid-human-reply-dispatch-admitted',operationId:input.operation_id,ticketId:String(ticketId),nativeUserId:String(nativeUserId),bodySha256:createHash('sha256').update(body).digest('hex')});
}
export async function submitPortalBsuidReply(s,{agent,namespace,ticketId,ticketNumber,body,nativeArticle}){
 let admitted=false;const receipt=await submitPortalReply(agent,{ticketId,ticketNumber,body,internal:false,expectedPreviewText:body,checkpoint:s.checkpoint,beforeDispatch:async input=>{await persistPortalBsuidReplyIntent(s,{namespace,ticketId,body,nativeUserId:agent.nativeUserId,input});admitted=true;}});
 await s.checkpoint({phase:'bsuid-human-portal-receipt',receipt});assert.equal(receipt.state,'APPLIED','Unconfirmed original reply remains held; never replay');assert(admitted,'Shared reply boundary must persist the intent before dispatch');const article=await nativeArticle(receipt.articleId);assertPortalBsuidReply({receipt,article,ticketId,body,nativeUserId:agent.nativeUserId});return {receipt,article};
}
export async function portalMetaBsuidStage(s,options){
 assert.equal(s.operatorSurface,'portal');assert.equal(typeof options.config.historicalTestId,'string');assert(options.config.historicalTestId.length>0);assert.equal(options.config.testId,options.config.historicalTestId+'::portal');
 const owner=await ensurePortalOperator(s,{role:'tenant_owner',viewport:{width:1440,height:1000}}),agent=await ensurePortalOperator(s,{role:'agent',viewport:{width:1440,height:1000}});
 const result=await withPortalOperatorEvidence(owner,()=>withPortalOperatorEvidence(agent,()=>runPortalMetaBsuidStage(s,options,owner,agent)));for(const row of result.proofs)await s.checkpoint({phase:'meta-bsuid-proof',...row});return result;
}

// One goal-owned selected stage. No fixture proof seeding, replacement alias or raw BSUID routing.
async function runPortalMetaBsuidStage(s,{namespace,inputs,config},owner,agent){
 const startedAt=new Date().toISOString(),f=inputs.metaDeliveries,h=s.metaCallbacks;
 assert(/^[A-Za-z0-9_-]{1,30}$/.test(namespace));assertMetaRuntimeBinding(f,h,s);assertMetaFixtureProvenance(f,namespace);
 assert(typeof config.testId==='string'&&config.testId.length);assert(/^\d{7,15}$/.test(config.customer));
 assert(/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(config.bsuid));assert.notEqual(config.customer,h.cfg.binding.customer);
 assert(/^\d{5,32}$/.test(config.appId));assert(/^\d+$/.test(config.expectedHandoff.groupId)&&/^\d+$/.test(config.expectedHandoff.ownerId));
 assertPortalFixtureMachineTarget(s,{namespace,access:inputs.portalTeamAccess,nativeGroupId:config.expectedHandoff.groupId});
 const recipients=JSON.parse(s.model.services[h.cfg.graphService].environment.META_SIM_RECIPIENTS);
 assert(recipients.includes(config.customer)&&recipients.includes(config.bsuid));await s.verifyOwner(s.ownerPage);await s.ownerPage.setViewportSize({width:1440,height:1000});
 const connectionId=f.connectionId,tenantId=s.tenantId;
 const detail=await createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace+'-bsuid-admit',checkpoint:s.checkpoint})('/api/connections/'+connectionId);assert.equal(detail.state,'WORKING');assert.equal(detail.latest_operation_state,'SUCCEEDED');
 const sessions=await s.scoped(`SELECT p.id,p.state,p.opaque_session_id,p.provider_state_data,c.secret_reference,c.state AS connection_state
  FROM connections c JOIN provider_sessions p ON p.tenant_id=c.tenant_id AND p.connection_id=c.id
  WHERE c.tenant_id=$1 AND c.id=$2 AND c.provider='META' AND p.ownership_state='ACTIVE'`,[tenantId,connectionId]);
 assert.equal(sessions.length,1);const session=sessions[0];assert(session.state==='WORKING'&&session.connection_state==='WORKING');assert.equal(session.opaque_session_id,h.cfg.binding.phoneId);
 const account=session.provider_state_data.metaAccountProof;
 assert.equal(account.claim,'PHONE_ACCOUNT_RELATION_VERIFIED');assert.equal(account.phoneNumberId,h.cfg.binding.phoneId);assert.equal(account.wabaId,h.cfg.binding.wabaId);
 assert.equal(account.providerSessionId,session.id);assert.equal(account.secretReference,session.secret_reference);
 assert.equal(account.tenantId,tenantId);assert.equal(account.connectionId,connectionId);
 assert.equal(account.credentialMetadata.claim,'CREDENTIAL_METADATA_VERIFIED');assert.equal(account.credentialMetadata.appId,config.appId);
 assert.equal(account.credentialFingerprint,createHash('sha256').update(h.cfg.token).digest('hex'));
 assert.equal((await s.scoped('SELECT id FROM participant_identities WHERE tenant_id=$1 AND connection_id=$2 AND external_participant_id=$3',[tenantId,connectionId,config.customer])).length,0);
 assert.equal((await s.scoped('SELECT id FROM meta_direct_identity_aliases WHERE tenant_id=$1 AND connection_id=$2 AND value=ANY($3::text[])',[tenantId,connectionId,[config.customer,config.bsuid]])).length,0);
 assert.equal((await s.scoped('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3',[tenantId,connectionId,config.customer])).length,0);
 const before=await s.scoped('SELECT id,state,attempts,external_message_id,updated_at FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[tenantId,connectionId]);
 assert(before.every(d=>['SENT','DELIVERED','READ','FAILED_TERMINAL','CANCELLED'].includes(d.state)),'Fresh stage cannot admit preexisting pending or UNKNOWN effects; retain them without clearing/replay');
 const providerBefore=await h.providerRead();assert(!providerBefore.some(r=>r.to===config.customer||r.recipient===config.bsuid));
 const path=privateConfigPath(s.privateDir,config.asset.path),stat=await lstat(path);assert(stat.isFile()&&!stat.isSymbolicLink());
 const png=await readFile(path);assert.equal(createHash('sha256').update(png).digest('hex'),config.asset.sha256);
 const claim=await open(join(s.privateDir,'meta-bsuid-'+namespace+'.claim.json'),'wx',0o600);
 try{await claim.writeFile(JSON.stringify({namespace,tenantId,connectionId,customerSha256:createHash('sha256').update(config.customer).digest('hex'),bsuidSha256:createHash('sha256').update(config.bsuid).digest('hex'),startedAt,disposition:'retain-and-reconcile-no-replay'}));await claim.sync();}finally{await claim.close();}
 const asset=await uploadPinnedAsset({page:s.ownerPage,origin:s.portalOrigin,bytes:png,filename:'bsuid-owned.png',checkpoint:s.checkpoint});
 const request=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace+'-bsuid',checkpoint:s.checkpoint});
 const assignments=await s.scoped('SELECT id,state FROM bot_assignments WHERE tenant_id=$1 AND connection_id=$2',[tenantId,connectionId]);assert.equal(assignments.length,1);assert.equal(assignments[0].state,'PAUSED');
 const definition={schemaVersion:1,name:'Synthetic scoped BSUID '+namespace,start:'media',maxSteps:6,nodes:[
  {id:'media',type:'send_media',assetId:asset.id,caption:'صورة الطلب',next:'choice'},
  {id:'choice',type:'choice',prompt:'اختر متابعة الطلب',options:[{id:'human',label:'الموظف',next:'reply'}]},
  {id:'reply',type:'send_text',text:'تم تحويل الطلب إلى الموظف',next:'handoff'},
  {id:'handoff',type:'handoff',target:'CLIENT_PRIMARY',priority:'2 normal'}]};
 const flow=await request('/api/bot-flows','POST',definition,'bsuid-flow');
 await request('/api/bot-flows/'+flow.id+'/activate','POST',{expectedRevision:Number(flow.revision),expectedActiveFlowVersionId:null},'bsuid-activate');
 const assignment=await request('/api/bot-flows/assignments','POST',{connectionId,familyId:flow.familyId,zammadGroupId:String(h.cfg.zammadGroupId),agentPrefix:'Agent',agentIdentityPlacement:'OFF'},'bsuid-assign');assert.equal(assignment.assignmentId,assignments[0].id);
 const states=await privateNativeRead(s,'states');
 const nativeArticle=async id=>privateNativeRead(s,'article',{articleId:String(id)});
 const nativeTicket=async id=>{const ticket=await privateNativeRead(s,'ticket',{ticketId:String(id)});return {ticket,state:portalBsuidState(ticket,states)};};
 const readers=metaReaders({scoped:s.scoped,tenantId,connectionId,nativeArticleRead:async(ticket,id)=>{const a=await nativeArticle(id);assert.equal(String(a.ticket_id),String(ticket));return a;}});
 const deliveriesFor=async inbox=>h.poll(()=>s.scoped(`SELECT id,state,attempts,lease_id,external_message_id,external_chat_id,bot_conversation_id,zammad_ticket_id,zammad_article_id,direct_origin,bot_content,message_body,meta_direct_recipient
  FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND idempotency_key LIKE $3 ORDER BY batch_sequence,id`,[tenantId,connectionId,'bot:%:'+inbox+':%']),rows=>rows.length>0&&rows.every(r=>r.state==='SENT'&&r.zammad_article_id&&!r.lease_id));
 let canonical,ticketId,customerId,conversationId,aliases;
 const assertCanonical=async id=>{
  const rows=await s.scoped(`SELECT n.external_group_id,n.external_participant_id,n.provider_metadata,l.zammad_ticket_id,l.zammad_article_id,c.id AS conversation_id,c.zammad_customer_id,c.state
   FROM normalized_messages n JOIN message_links l ON l.tenant_id=n.tenant_id AND l.connection_id=n.connection_id AND l.external_message_id=n.external_message_id
   JOIN bot_conversations c ON c.tenant_id=n.tenant_id AND c.connection_id=n.connection_id AND c.external_chat_id=n.external_group_id
   WHERE n.tenant_id=$1 AND n.connection_id=$2 AND n.event_inbox_id=$3`,[tenantId,connectionId,id]);assert.equal(rows.length,1);const row=rows[0];
  const current=await s.scoped(`SELECT p.id,p.external_participant_id,a.id AS alias_id,a.kind,a.value,a.revision,a.provider_session_id,a.phone_number_id,a.waba_id,a.state
   FROM participant_identities p JOIN meta_direct_identity_aliases a ON a.tenant_id=p.tenant_id AND a.connection_id=p.connection_id AND a.participant_identity_id=p.id
   WHERE p.tenant_id=$1 AND p.connection_id=$2 AND p.external_participant_id=$3 ORDER BY a.kind`,[tenantId,connectionId,config.customer]);
  assert.equal(current.length,2);assert.equal(new Set(current.map(a=>a.id)).size,1);assert.deepEqual(current.map(a=>[a.kind,a.value]),[['BSUID',config.bsuid],['PHONE',config.customer]]);
  for(const a of current){assert.equal(a.provider_session_id,session.id);assert.equal(a.phone_number_id,h.cfg.binding.phoneId);assert.equal(a.waba_id,h.cfg.binding.wabaId);assert.equal(a.state,'ACTIVE');assert.equal(Number(a.revision),1);}
  if(!canonical){canonical=row.external_group_id;ticketId=String(row.zammad_ticket_id);customerId=Number(row.zammad_customer_id);conversationId=row.conversation_id;aliases=current;}
  assert.equal(row.external_group_id,canonical);assert.equal(row.external_participant_id,canonical);assert.equal(canonical,config.customer);assert.equal(String(row.zammad_ticket_id),ticketId);assert.equal(Number(row.zammad_customer_id),customerId);assert.equal(row.conversation_id,conversationId);assert.deepEqual(current,aliases);
  assert.equal(Number(row.provider_metadata.zammad_customer_id),customerId);const ticket=await nativeTicket(ticketId);assert.equal(Number(ticket.ticket.customer_id),customerId);assert.equal(ticket.state.toLowerCase(),'open');
  const article=await nativeArticle(row.zammad_article_id);assert.equal(String(article.ticket_id),ticketId);return{row,article};
 };
 const acceptedIds=new Set();
 const assertReceipt=async delivery=>{
  assert.equal(Number(delivery.attempts),1);assert.equal(delivery.external_chat_id,canonical);assert.equal(String(delivery.zammad_ticket_id),ticketId);assert.equal(delivery.bot_conversation_id,conversationId);
  const snapshot=delivery.meta_direct_recipient;assert.equal(snapshot.claim,'ALIAS_VERIFIED');assert.deepEqual(snapshot.recipient,{kind:'BSUID',value:config.bsuid});assert.equal(snapshot.participantId,aliases[0].id);assert.equal(snapshot.aliasId,aliases.find(a=>a.kind==='BSUID').alias_id);assert.equal(snapshot.aliasRevision,1);assert.deepEqual(snapshot.asset,{providerSessionId:session.id,phoneNumberId:h.cfg.binding.phoneId,wabaId:h.cfg.binding.wabaId});
  const receipts=(await h.providerRead()).filter(r=>r.id===delivery.external_message_id);assert.equal(receipts.length,1);assert.equal(receipts[0].recipient,config.bsuid);assert.equal(receipts[0].body.recipient,config.bsuid);assert(!Object.hasOwn(receipts[0],'to')&&!Object.hasOwn(receipts[0].body,'to'));acceptedIds.add(receipts[0].id);return receipts[0];
 };
 const assertBot=async(delivery,type)=>{
  assert.equal(delivery.direct_origin,'BOT');const receipt=await assertReceipt(delivery);
  if(type==='media'){assert.equal(delivery.bot_content.type,'media');assert.equal(delivery.bot_content.assetId,asset.id);assert.equal(delivery.message_body,definition.nodes[0].caption);assert.equal(receipt.type,'image');assert.equal(receipt.body.image.caption,definition.nodes[0].caption);assert.equal(receipt.mediaMimeType,'image/png');}
  else if(type==='prompt'){assert.equal(delivery.bot_content.type,'choices');assert.equal(delivery.bot_content.nodeId,'choice');assert.deepEqual(delivery.bot_content.options,[{id:'human',label:'الموظف'}]);assert.equal(delivery.message_body,definition.nodes[1].prompt);assert.equal(receipt.type,'interactive');assert.deepEqual(receipt.body.interactive,{type:'button',body:{text:definition.nodes[1].prompt},action:{buttons:[{type:'reply',reply:{id:'human',title:'الموظف'}}]}});}
  else{assert.equal(type,'reply');assert.equal(delivery.message_body,definition.nodes[2].text);assert.equal(receipt.type,'text');assert.deepEqual(receipt.body.text,{body:definition.nodes[2].text});}
  return receipt;
 };
 const observations=[];
 const emit=async(label,input,sender)=>{
  const id='wamid.synthetic.'+namespace+'-bsuid-'+label+'.initial',payload=metaInput({...h.cfg.binding,customer:config.customer,id,timestamp:Math.floor(Date.now()/1000),...input,sender}),bytes=Buffer.from(JSON.stringify(payload));
  await h.persistInbound({messageId:id,bytes});await s.checkpoint({phase:'bsuid-inbound-intent',label,id,bodySha256:createHash('sha256').update(bytes).digest('hex')});
  const headers={'content-type':'application/json','x-hub-signature-256':'sha256='+createHmac('sha256',h.cfg.appSecret).update(bytes).digest('hex')};
  const accepted=await h.postInbound('/webhooks/meta',bytes,headers);assert.equal(accepted.status,200);assert.deepEqual(accepted.receipt,{accepted:true,count:1,duplicates:0,unrouted:0});
  const processed=await readers.readProcessed(id),proof=await assertCanonical(processed.inboxId),article=proof.article;
  const expectedBody=input.kind==='text'?input.text:input.kind==='interactive'?input.choiceTitle:'[image attachment]';
  assert.equal(article.body,expectedBody);assert.equal(article.content_type,'text/plain');assert.equal(article.internal,false);assert.equal(article.sender,'Customer');assert.equal(Number(article.origin_by_id),customerId);assert.equal(article.type,'wasalx group message');
  assert.equal(article.preferences.wasalx_origin,'provider');assert.equal(article.preferences.wasalx_external_message_id,id);
  const normalized=await s.scoped('SELECT message_text,quoted_external_message_id,provider_metadata FROM normalized_messages WHERE tenant_id=$1 AND connection_id=$2 AND event_inbox_id=$3',[tenantId,connectionId,processed.inboxId]);assert.equal(normalized.length,1);
  if(input.kind==='interactive'){assert.equal(normalized[0].quoted_external_message_id,input.promptId);assert.equal(normalized[0].provider_metadata.choice_id,input.choiceId);assert.equal(normalized[0].provider_metadata.choice_source,'META_NATIVE');}
  else if(input.kind==='text')assert.equal(normalized[0].message_text,input.text);
  const visible=await openPortalTicket(agent,{ticketNumber:(await nativeTicket(ticketId)).ticket.number,articleId:String(article.id),marker:expectedBody,reload:true});observations.push({label,id,processed,ticketId,articleId:String(article.id),customerId,conversationId,nativeBody:article.body,nativeSender:article.sender,externalMessagePreference:article.preferences.wasalx_external_message_id,portalObservation:visible});await s.checkpoint({phase:'bsuid-inbound-settled',...observations.at(-1)});return{id,bytes,headers,processed,...proof};
 };
 const initial=await emit('joint',{kind:'text',text:'مرحبا '+namespace},{phone:config.customer,bsuid:config.bsuid,jointContact:true});
 const first=await deliveriesFor(initial.processed.inboxId);assert.equal(first.length,2);const mediaDelivery=first.find(d=>d.bot_content.type==='media'),firstPrompt=first.find(d=>d.bot_content.type==='choices');assert(mediaDelivery&&firstPrompt);const mediaReceipt=await assertBot(mediaDelivery,'media');await assertBot(firstPrompt,'prompt');
 assert.equal(mediaReceipt.mediaSha256,asset.sha256);assert.equal(mediaReceipt.mediaBytes,asset.bytes);
 const text=await emit('text',{kind:'text',text:'متابعة '+namespace},{bsuid:config.bsuid});assert.equal(text.row.state,'BOT');
 const textDeliveries=await deliveriesFor(text.processed.inboxId);assert.equal(textDeliveries.length,1);await assertBot(textDeliveries[0],'prompt');
 const media=await emit('image',{kind:'image',media:{id:mediaReceipt.mediaId,mime_type:'image/png',sha256:asset.sha256}},{bsuid:config.bsuid});assert.equal(media.row.state,'BOT');assert.equal(media.article.attachments.length,1);
 const attachment=media.article.attachments[0],nativeFile=await privateNativeRead(s,'attachment',{ticketId,articleId:String(media.article.id),attachmentId:String(attachment.id)}),download=await downloadPortalMailAttachment(agent,{ticketNumber:(await nativeTicket(ticketId)).ticket.number,articleId:String(media.article.id),filename:attachment.filename}),actual=assertPortalBsuidMedia({attachment,nativeFile,download,asset});
 const storedRows=await s.scoped(`SELECT m.scan_state,m.mime_type,m.sha256,m.byte_size FROM normalized_messages n JOIN media_objects m ON m.tenant_id=n.tenant_id AND m.id=(n.provider_metadata->>'media_object_id')::uuid WHERE n.tenant_id=$1 AND n.connection_id=$2 AND n.event_inbox_id=$3`,[tenantId,connectionId,media.processed.inboxId]);assert.equal(storedRows.length,1);const stored=storedRows[0];assert.equal(stored.scan_state,'CLEAN');assert.equal(stored.mime_type,'image/png');assert.equal(stored.sha256,asset.sha256);assert.equal(Number(stored.byte_size),asset.bytes);
 const mediaReplies=await deliveriesFor(media.processed.inboxId);assert.equal(mediaReplies.length,1);await assertBot(mediaReplies[0],'prompt');const prompt=await readers.readPrompt(media.id);
 const selected=await emit('choice',{kind:'interactive',promptId:prompt.externalMessageId,choiceId:prompt.choiceId,choiceTitle:prompt.title},{bsuid:config.bsuid});
 const replies=await deliveriesFor(selected.processed.inboxId);assert.equal(replies.length,1);await assertBot(replies[0],'reply');assert.equal(selected.processed.currentNodeId,'handoff');
 const [human]=await h.poll(()=>s.scoped('SELECT id,state,zammad_ticket_id,zammad_customer_id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND id=$3',[tenantId,connectionId,conversationId]),rows=>rows.length===1&&rows[0].state==='HUMAN');assert.equal(String(human.zammad_ticket_id),ticketId);assert.equal(Number(human.zammad_customer_id),customerId);
 const nativeHuman=await h.poll(()=>nativeTicket(ticketId),x=>x.ticket.wasalx_bot_state==='HUMAN');assert.equal(String(nativeHuman.ticket.group_id),config.expectedHandoff.groupId);assert.equal(String(nativeHuman.ticket.owner_id),config.expectedHandoff.ownerId);
 const body='رد الموظف '+namespace;await agent.verify();await s.checkpoint({phase:'bsuid-human-reply-intent',ticketId,actorId:agent.nativeUserId,bodySha256:createHash('sha256').update(body).digest('hex')});
 const {receipt,article}=await submitPortalBsuidReply(s,{agent,namespace,ticketId,ticketNumber:(await nativeTicket(ticketId)).ticket.number,body,nativeArticle});await openPortalTicket(agent,{ticketNumber:(await nativeTicket(ticketId)).ticket.number,articleId:String(article.id),marker:body,reload:true});await s.checkpoint({phase:'bsuid-human-created',operationId:receipt.operationId,articleId:article.id});
 const [sent]=await h.poll(()=>s.scoped(`SELECT id,state,attempts,lease_id,external_message_id,external_chat_id,bot_conversation_id,zammad_ticket_id,zammad_article_id,direct_origin,message_body,meta_direct_recipient FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND zammad_ticket_id=$3 AND zammad_article_id=$4`,[tenantId,connectionId,ticketId,String(article.id)]),rows=>rows.length===1&&rows[0].state==='SENT'&&!rows[0].lease_id);assert.equal(sent.direct_origin,'HUMAN');assert.equal(sent.message_body,body);const humanReceipt=await assertReceipt(sent);assert.equal(humanReceipt.type,'text');assert.deepEqual(humanReceipt.body.text,{body});
 const statusFixture={evidenceMode:'simulated',provider:'META',tenantId,connectionId,deliveries:[{deliveryId:sent.id,externalMessageId:sent.external_message_id,recipient:canonical,metaDirectRecipient:{kind:'BSUID',value:config.bsuid}}]};
 const status=await runMetaDeliveryStatuses({ownerPage:s.ownerPage,portalOrigin:s.portalOrigin,privateDir:s.privateDir,output:s.output,runId:namespace+'-bsuid',cfg:h.cfg,request,scoped:s.scoped,checkpoint:s.checkpoint,providerRead:h.providerRead,postRaw:h.postRaw,poll:h.poll,fixture:statusFixture});
 const historyIds=async()=>{const articles=await privateNativeRead(s,'articles',{ticketId});assert(articles.every(row=>String(row.ticket_id)===ticketId));return articles.map(row=>row.id);};
 const stableHistory=await historyIds(),stableRows=await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[tenantId,connectionId]),stableReceipts=await h.providerRead();
 await s.checkpoint({phase:'bsuid-duplicate-intent',id:text.id});const duplicate=await h.postInbound('/webhooks/meta',text.bytes,text.headers);assert.equal(duplicate.status,200);assert.deepEqual(duplicate.receipt,{accepted:true,count:0,duplicates:1,unrouted:0});
 await assertCanonical(text.processed.inboxId);assert.deepEqual(await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[tenantId,connectionId]),stableRows);assert.deepEqual(await h.providerRead(),stableReceipts);assert.deepEqual(await historyIds(),stableHistory);
 const rows=await s.scoped('SELECT external_message_id,zammad_article_id FROM message_links WHERE tenant_id=$1 AND connection_id=$2 AND external_message_id=ANY($3::text[])',[tenantId,connectionId,observations.map(o=>o.id)]);assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>String(r.zammad_article_id))).size,4);
 assert.equal((await s.scoped('SELECT id FROM bot_conversations WHERE tenant_id=$1 AND connection_id=$2 AND external_chat_id=$3',[tenantId,connectionId,canonical])).length,1);
 const current=await s.scoped('SELECT id,state,attempts,external_message_id,updated_at FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 ORDER BY id',[tenantId,connectionId]);const oldIds=new Set(before.map(d=>d.id));assert.deepEqual(current.filter(d=>oldIds.has(d.id)),before);const newRows=current.filter(d=>!oldIds.has(d.id));assert.equal(newRows.length,6);assert.equal(acceptedIds.size,6);assert.deepEqual(newRows.map(d=>d.external_message_id).sort(),[...acceptedIds].sort());
 const allReceipts=await h.providerRead(),priorIds=new Set(providerBefore.map(r=>r.id));assert.deepEqual(allReceipts.filter(r=>priorIds.has(r.id)),providerBefore);const delta=allReceipts.filter(r=>!priorIds.has(r.id));assert.equal(delta.length,6);assert.deepEqual(delta.map(r=>r.id).sort(),[...acceptedIds].sort());
 await h.drain({connectionId,assignmentId:assignment.assignmentId});await agent.verify();const finalTicket=await nativeTicket(ticketId);assert.equal(finalTicket.state.toLowerCase(),'open');assert.equal(finalTicket.ticket.wasalx_bot_state,'HUMAN');
 assert.deepEqual(await privateNativeRead(s,'states'),states,'Native state catalog changed during the finite workflow');await owner.verify();const finishedAt=new Date().toISOString(),proof={evidenceMode:'simulated',observations,canonicalParticipantId:aliases[0].id,aliasIds:aliases.map(a=>a.alias_id),customerId,conversationId,ticketId,flowVersionId:flow.id,sessionId:session.id,asset,attachment:actual,humanArticleId:article.id,humanDeliveryId:sent.id,status,duplicateNoEffect:true,oldDeliveriesUnchanged:true,assignmentPaused:true,operatorSurface:'portal',humanOperationId:receipt.operationId,humanNativeUserId:agent.nativeUserId,humanReplyReceipt:{state:receipt.state,operationId:receipt.operationId,ticketId:receipt.ticketId,articleId:receipt.articleId,nativeUserId:agent.nativeUserId,role:'agent',surface:'portal'},agentAction:'Actual WasalX Inbox preview, one original public reply and real attachment download; fixed native readback corroborates',limitations:['Synthetic signed Meta input/acceptance/status; not live WhatsApp','No P03b transitions, parent recipient or authority grant; privacy enforced by canonical resolver/outbox guard']};
 const proofs=[{testId:config.testId,historicalTestId:config.historicalTestId,result:'passed',startedAt,finishedAt,contextId:'tenant_owner-en-desktop',evidenceMode:'simulated',proof:{...proof,operatorAction:'Actual owner delivery timeline observations; fixture setup and native checks are separate corroboration'}},{testId:config.testId,historicalTestId:config.historicalTestId,result:'passed',startedAt,finishedAt,contextId:'agent-en-desktop',evidenceMode:'simulated',proof:{...proof,operatorAction:'Actual Inbox inbound history, attachment download, preview and single public reply'}}];
 return{evidenceMode:'simulated',operatorSurface:'portal',namespace,tenantId,proofs};
}
