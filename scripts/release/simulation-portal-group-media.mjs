import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {actionResponse,observeUploadFile} from './simulation-native-media-ui.mjs';
import {assertMediaEnvelope} from './simulation-native-media-envelope.mjs';
import {compareRetainedMedia} from './simulation-native-media-assertions.mjs';
import {openPortalGroup,readPortalOperation} from './simulation-portal-operator.mjs';
import {portalGroupRow,observePortalAction,loadPortalGroupMedia,portalGroupResult,sha} from './simulation-portal-groups.mjs';
import {groupMediaPrefix,mediaLabels} from './simulation-portal-group-definitions.mjs';

export async function stagePortalMedia({operator,fixture,checkpoint}){
 const {page}=operator,observer=fixture.kind==='voice'?await observeUploadFile(page,'files'):null;let bytes=observer?null:await readFile(fixture.path);
 try{
  if(observer){
   await page.getByRole('button',{name:'Record voice message',exact:true}).click();await page.getByRole('button',{name:'Stop and attach recording',exact:true}).waitFor();
   await new Promise(resolve=>setTimeout(resolve,1100));const response=await actionResponse(page,r=>new URL(r.url()).pathname==='/api/inbox/group-upload'&&r.request().method()==='POST',()=>page.getByRole('button',{name:'Stop and attach recording',exact:true}).click());assert(response.ok());
   const value=await response.json();assert.equal(value.items.length,1);assert(Number(value.items[0].size)>0);assert.match(value.items[0].mime_type,/^audio\/webm/u);bytes=await observer.read();assert.equal(bytes.length,Number(value.items[0].size));await page.getByText(value.items[0].filename,{exact:true}).waitFor();
  }else{
   const response=await actionResponse(page,r=>new URL(r.url()).pathname==='/api/inbox/group-upload'&&r.request().method()==='POST',()=>page.locator('#wx-group-files').setInputFiles(fixture.path));assert(response.ok());const value=await response.json();assert.equal(value.items.length,1);assert.equal(Number(value.items[0].size),bytes.length);await page.getByText(value.items[0].filename,{exact:true}).waitFor();
  }
  assert(bytes?.length);await checkpoint({phase:'portal-staged-media',kind:fixture.kind,bytes:bytes.length,sha256:sha(bytes),source:observer?'actual-browser-File':'frozen-fixture'});return bytes;
 }finally{await observer?.close();}
}

export async function observeSentPortalMedia({operator,groupId,delivery,expectedHash,mime,checkpoint}){
 const {page}=operator,contexts=[];
 try{for(const viewport of [{width:1440,height:1000},{width:820,height:1180}]){
  await page.setViewportSize(viewport);const readback=await loadPortalGroupMedia(operator,{groupId,messageId:delivery.id});assert.equal(readback.sha256,expectedHash);const row=portalGroupRow(operator,delivery.id);let playable=null;
  if(/^(audio|video)\//u.test(mime)){
   playable=await row.locator(mime.startsWith('video/')?'video':'audio').evaluate(async media=>{media.muted=true;await Promise.race([new Promise((resolve,reject)=>{media.onloadedmetadata=resolve;media.onerror=()=>reject(Error('Media decode failed'));media.load();}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Media decode timeout')),5000))]);await media.play();await new Promise(resolve=>setTimeout(resolve,200));const result={duration:media.duration,currentTime:media.currentTime,played:media.currentTime>0};media.pause();return result;});assert(playable.played&&Number.isFinite(playable.duration));
  }
  if(mime.startsWith('image/'))assert(await row.locator('img').evaluate(async image=>{await image.decode();return image.complete&&image.naturalWidth>0;}));
  contexts.push({surface:'portal-group',viewport:page.viewportSize(),readback,playable});await checkpoint({phase:'portal-media-view',deliveryId:delivery.id,context:contexts.at(-1)});
 }}finally{await page.setViewportSize({width:1440,height:1000});}return contexts;
}

export async function runPortalGroupMedia(s,{files,mentionParticipant}){
 const {operator,groupId,connectionId,scoped,checkpoint,providerRead,providerMessage,messageId,externalMessageId}=s,page=operator.page;
 assert.equal(typeof providerMessage,'function');assert.equal(s.mediaSimulation,true,'Actual voice UI requires admitted fake browser device');assert(/^[1-9][0-9]+@c\.us$/u.test(mentionParticipant));await page.context().grantPermissions(['microphone'],{origin:s.portalOrigin});
 const fixtures=[];
 for(const kind of ['audio','document','image','video']){const fixture=files.find(row=>row.kind===kind);assert(fixture?.path&&/^[a-f0-9]{64}$/u.test(fixture.sha256));const path=resolve(s.root,fixture.path),part=relative(s.root,path);assert(part&&!part.startsWith('..')&&!isAbsolute(part));const bytes=await readFile(path);assert.equal(sha(bytes),fixture.sha256);assert.equal(bytes.length,fixture.bytes);fixtures.push({...fixture,path});}
 fixtures.push({kind:'voice',mime:'audio/webm'},{kind:'quote'},{kind:'mention'},{kind:'text'});
 const [settings]=await scoped('SELECT agent_identity_placement FROM group_workspace_settings WHERE whatsapp_group_id=$1',[groupId]),[binding]=await scoped("SELECT agent_identity_placement FROM group_bindings WHERE whatsapp_group_id=$1 AND state='ACTIVE'",[groupId]),placement=binding?.agent_identity_placement??settings.agent_identity_placement;assert(['OFF','HEADER','FOOTER'].includes(placement));
 const results=[];
 for(const fixture of fixtures){const startedAt=new Date().toISOString();let uncertain=false;
  try{
   await page.setViewportSize({width:1440,height:1000});await openPortalGroup(operator,{groupId,messageId});await page.getByLabel('Group message',{exact:true}).waitFor();
   const before=await providerRead(),links=await scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[connectionId]);let original,mention;
   if(fixture.mime){original=await stagePortalMedia({operator,fixture,checkpoint});if(fixture.kind==='voice'){const row=await portalGroupResult(operator,{testId:groupMediaPrefix+'voice-send-renders-durable-delivery-state::detail-1',result:'passed',startedAt,proof:{actualRecordStopUpload:true,bytes:original.length,sha256:sha(original)}});results.push(row);await checkpoint({phase:'portal-media-result',...row});}}
   else if(fixture.kind==='quote'){await portalGroupRow(operator,messageId).getByRole('button',{name:'Reply to this message',exact:true}).click();await page.getByLabel('Group message',{exact:true}).fill('Synthetic quote '+s.runId);}
   else if(fixture.kind==='mention'){
    const phone='+'+mentionParticipant.split('@')[0],participants=await readPortalOperation(operator,'GROUP_PARTICIPANTS',{group_id:groupId,query:phone});const matches=participants.filter(row=>row.phone===phone);assert.equal(matches.length,1);mention=matches[0];
    await page.getByRole('button',{name:'Mention a participant',exact:true}).click();await page.getByLabel('Find a participant',{exact:true}).fill(phone);
    const list=page.getByRole('group',{name:'Participants to mention',exact:true});await list.getByRole('button').filter({hasText:phone}).click();await page.getByLabel('Group message',{exact:true}).press('End');await page.getByLabel('Group message',{exact:true}).pressSequentially(' Synthetic mention '+s.runId);
   }else await page.getByLabel('Group message',{exact:true}).fill('Synthetic ticketless '+s.runId);
   const sent=await observePortalAction({operator,operation:'GROUP_SEND',action:()=>page.getByRole('button',{name:'Send to group',exact:true}).click(),checkpoint,beforeDispatch:()=>{uncertain=true;s.markUncertain();}});assert(sent.value.accepted);
   const key=`group-workspace:${operator.nativeUserId}:${sent.intent.request_token.toLowerCase()}`,roots=await scoped('SELECT id FROM delivery_outbox WHERE connection_id=$1 AND idempotency_key=$2',[connectionId,key]);assert.equal(roots.length,1);const root=roots[0];
   let rows;const until=Date.now()+120000;
   for(;;){rows=await scoped('SELECT id,state,attempts,external_message_id,zammad_ticket_id,zammad_article_id,batch_id,batch_sequence,batch_part_count,message_body,agent_display_name,agent_prefix_snapshot,agent_identity_placement_snapshot FROM delivery_outbox WHERE id=$1 OR(batch_id IS NOT NULL AND batch_id=(SELECT batch_id FROM delivery_outbox WHERE id=$1)) ORDER BY batch_sequence',[root.id]);if(rows.length&&rows.every(row=>row.state==='SENT'))break;assert(!rows.some(row=>['OUTCOME_UNKNOWN','FAILED_TERMINAL'].includes(row.state)),'Keep the exact failed or uncertain operation');assert(Date.now()<until,'Delivery unresolved; never resend');await new Promise(resolve=>setTimeout(resolve,300));}
   const after=await providerRead();assertMediaEnvelope({rows,receipts:after.receipts,media:Boolean(fixture.mime),placement,expectedMediaId:root.id,before,after});const delivery=rows.find(row=>row.id===root.id),receipt=after.receipts.find(row=>row.id===delivery.external_message_id);assert.deepEqual(await scoped('SELECT id FROM message_links WHERE connection_id=$1 ORDER BY id',[connectionId]),links);s.markSettled();uncertain=false;
   const proof={deliveryId:delivery.id,partIds:rows.map(row=>row.id),externalMessageId:delivery.external_message_id,kind:fixture.kind,noTicketLinks:true};
   if(original){proof.bytes=compareRetainedMedia({original,receipt,delivery});const received=await providerMessage(receipt.id);assert.equal(received.id,receipt.id);const bytes=Buffer.from(received.media.data,'base64');assert.equal(sha(bytes),sha(original));assert.equal(bytes.length,original.length);proof.views=await observeSentPortalMedia({operator,groupId,delivery,expectedHash:sha(original),mime:fixture.mime,checkpoint});}
   if(fixture.kind==='quote'){assert.equal(receipt.replyToSha256,sha(externalMessageId));assert.equal(sent.intent.reply_to_message_id,messageId);proof.exactQuote=true;}
   if(fixture.kind==='mention'){assert.deepEqual(receipt.mentions,[mentionParticipant]);assert.deepEqual(sent.intent.mentions,[mention.id]);proof.exactMention=true;}
   const row=await portalGroupResult(operator,{testId:groupMediaPrefix+mediaLabels[fixture.kind]+'-renders-durable-delivery-state::01',result:'passed',startedAt,proof});results.push(row);await checkpoint({phase:'portal-media-result',...row});
  }catch(error){
   await page.setViewportSize({width:1440,height:1000});const row=await portalGroupResult(operator,{testId:groupMediaPrefix+mediaLabels[fixture.kind]+'-renders-durable-delivery-state::01',result:'failed',startedAt,proof:{errorClass:error.name,errorSha256:sha(String(error.message)),uncertain}});results.push(row);await checkpoint({phase:'portal-media-result',...row});
   if(fixture.kind==='voice'&&!results.some(row=>row.supersedesTestId===groupMediaPrefix+'voice-send-renders-durable-delivery-state::detail-1'))results.push({...row,testId:groupMediaPrefix+'voice-send-renders-durable-delivery-state::detail-1::portal',supersedesTestId:groupMediaPrefix+'voice-send-renders-durable-delivery-state::detail-1'});
   if(uncertain)throw error;
  }
 }return results;
}
