import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {open,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {callSimulationControl} from '../contracts/waha-simulation-control.mjs';
import {waitOwnedRestoration,observeOwnedRestoration} from './owned-work-restoration.mjs';
import {readDirectProviderReceipts} from './simulation-direct-capabilities.mjs';
import {unknownReviewReadOnlyStage,testIds as completedReviewTestIds} from './simulation-unknown-review-readonly.mjs';
import {ensurePortalOperator,privateNativeRead} from './simulation-portal-operator.mjs';
import {submitPortalReply} from './simulation-portal-reply-browser.mjs';
export async function guardedReviewProviderRead(verify,readAll){await verify();const receipts=await readAll();await verify();return receipts;}
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>assert.match(value,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
export const reviewFixtureSql={
 binding:'SELECT b.agent_prefix,b.agent_identity_placement FROM group_bindings b JOIN whatsapp_groups g ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id WHERE b.tenant_id=$1 AND b.id=$2 AND g.connection_id=$3',
 session:"SELECT opaque_session_id FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'",
 delivery:'SELECT id,state,attempts,lease_id,lease_expires_at,external_message_id,group_binding_id,external_chat_id,message_body,content_type,agent_display_name,agent_prefix_snapshot,agent_identity_placement_snapshot,app.delivery_no_further_attempts(tenant_id,id) AS delivery_no_further_attempts FROM delivery_outbox WHERE tenant_id=$1 AND connection_id=$2 AND zammad_ticket_id=$3 AND zammad_article_id=$4 ORDER BY id',
 attempts:'SELECT id,attempt_number,state,provider_code,started_at,finished_at FROM delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY attempt_number,id',
 review:"SELECT id,tenant_id,connection_id,delivery_id,state,reason_code,resolution_code,version FROM quarantine_records WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY id",
 stopAudit:"SELECT tenant_id,target_type,target_id,action,new_value FROM audit_events WHERE tenant_id=$1 AND target_type='quarantine_record' AND target_id=$2 AND action='review.delivery_no_further_attempts' ORDER BY created_at,id"
};
export function reviewWireText(body,{prefix,placement,displayName}){
 assert(['HEADER','FOOTER','OFF'].includes(placement));assert(/^[A-Za-z0-9 ._-]{1,100}$/.test(displayName));
 if(placement==='OFF')return body;const identity=`${prefix?.trim()??'Agent:'} ${displayName}`.trim();return placement==='FOOTER'?`${body}\n${identity}`:`${identity}\n${body}`;
}
export function validateReviewReceipt({delivery,attempts,reviews,receipts,wireSha256,tenantId,connectionId,bindingId,chatId,requireNoFurtherAttempts=false,stopAudits=[]}){
 assert.equal(typeof requireNoFurtherAttempts,'boolean');assert(Array.isArray(stopAudits));assert.match(wireSha256,/^[a-f0-9]{64}$/u);
 uuid(delivery.id);assert.equal(delivery.state,'OUTCOME_UNKNOWN');assert.equal(Number(delivery.attempts),1);assert.equal(delivery.lease_id,null);assert.equal(delivery.lease_expires_at,null);assert.equal(delivery.external_message_id,null);
 // Group-binding deliveries carry no direct chat id (delivery_outbox_direct_target).
 assert.equal(delivery.group_binding_id,bindingId);assert.equal(delivery.external_chat_id,null);
 assert.equal(attempts.length,1);assert.equal(Number(attempts[0].attempt_number),1);assert.equal(attempts[0].state,'OUTCOME_UNKNOWN');assert(attempts[0].started_at&&attempts[0].finished_at);assert(Object.hasOwn(attempts[0],'provider_code'),'Original attempt provider code observation required');if(attempts[0].provider_code!==null)assert.match(attempts[0].provider_code,/^[A-Za-z0-9_.:-]{1,128}$/);
 assert.equal(receipts.length,1);assert(typeof chatId==='string'&&/^[0-9-]+@g\.us$/.test(chatId));assert(receipts[0].id?.startsWith('true_'+chatId+'_'),'Provider accepted wrong destination');assert.equal(receipts[0].textSha256,wireSha256);
 assert.equal(reviews.length,1);const review=reviews[0];uuid(review.id);assert.equal(review.tenant_id,tenantId);assert.equal(review.connection_id,connectionId);assert.equal(review.delivery_id,delivery.id);assert.equal(review.reason_code,'PROVIDER_OUTCOME_UNKNOWN');assert(Number.isSafeInteger(Number(review.version))&&Number(review.version)>=1);
 if(!requireNoFurtherAttempts){assert.equal(review.state,'OPEN');assert.equal(stopAudits.length,0);return review;}
 assert.equal(delivery.delivery_no_further_attempts,true);assert.equal(review.state,'RESOLVED');assert.equal(review.resolution_code,'DELIVERY_NO_FURTHER_ATTEMPTS');assert.equal(stopAudits.length,1);
 const audit=stopAudits[0];assert.equal(audit.tenant_id,tenantId);assert.equal(audit.target_type,'quarantine_record');assert.equal(audit.target_id,review.id);assert.equal(audit.action,'review.delivery_no_further_attempts');
 assert.deepEqual(audit.new_value,{state:'RESOLVED',version:Number(review.version),resolution_code:'DELIVERY_NO_FURTHER_ATTEMPTS',provider_outcome:'OUTCOME_UNKNOWN',no_further_attempts:true,provider_reissued:false});return review;
}
// Exactly one native write. An ambiguous response leaves the private claim/arm intact.
export async function dispatchReviewOnce({persist,arm,post,checkpoint}){await persist();await arm();await checkpoint({phase:'review-native-submit-intent'});const article=await post();assert(Number(article.id)>0);await checkpoint({phase:'review-native-accepted',articleId:article.id});return article;}
export async function unknownReviewFixtureStage(s,args){return runUnknownReviewFixtureStage(s,args);}
export async function portalUnknownReviewFixtureStage(s,args){
 assert.equal(s.operatorSurface,'portal');const {namespace,inputs}=args,access=inputs.portalTeamAccess;
 assert(inputs.nativeAccountAccess,'Current account-linking/READY receipt is required');assert.equal(access?.surface,'portal');assert.equal(access.namespace,namespace);assert.equal(access.tenantId,s.tenantId);
 const machine=access.machineGrant;assert.equal(machine?.surface,'portal');assert.equal(String(machine.teamId),String(access.nativeGroupId));assert.equal(machine.enabled,true);assert(typeof machine.statusVersion==='string'&&machine.statusVersion.length>0);
 if(machine.unchanged!==true){assert.equal(machine.kind,'IDENTITY_GRANT');assert.equal(machine.state,'APPLIED');assert.equal(machine.terminal,true);uuid(machine.requestId);}
 const operator=await ensurePortalOperator(s,{role:'agent',viewport:{width:1440,height:1000},locale:'en'});
 return runUnknownReviewFixtureStage(s,args,operator);
}
async function runUnknownReviewFixtureStage(s,{namespace,inputs,config},operator){
 assert.match(namespace,/^[A-Za-z0-9_-]{1,40}$/);assert.equal(config?.fixtureDisposition,'retain-readonly-unknown');
 const f=inputs?.caseLifecycle?.group??inputs?.group,h=s.directCallbacks;assert.equal(inputs?.directConnection?.connectionId,f?.connectionId);assert.equal(inputs?.directConnection?.tenantId,s.tenantId);assert.equal(f?.evidenceMode,'simulated');assert.equal(f.namespace,namespace);assert.equal(f.tenantId,s.tenantId);for(const id of [f.connectionId,f.bindingId,f.groupId,s.tenantId])uuid(id);assert(Number(f.ticketId)>0);assert(f.groupRef.endsWith('@g.us'));
 assert(s.actorBinding?.userMatched&&s.actorBinding?.workspaceMatched);assert(s.model.name.startsWith('wasalx-simulation-'));assert(h?.binding&&h.assertIsolatedRuntime&&h.drainEffects);assert.equal(h.binding.connectionId,f.connectionId);assert.equal(h.binding.socketPath,s.socketPath);assert.equal(h.binding.project,s.model.name);
 for(const k of ['project','connectionId','providerSessionId','containerId','imageId','socketPath']){assert.equal(typeof h.binding[k],'string');assert(h.binding[k]);assert.equal(inputs.directConnection.runtimeBinding[k],h.binding[k]);}assert.equal(h.binding.containerId,s.containers['waha-gows'].Id);assert.equal(h.binding.imageId,s.containers['waha-gows'].Image);
 assert(!s.capabilities?.reviewFaultDispatchStarted,'One terminal review fixture per session; reconcile prior claim');
 await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:f.connectionId});await h.drainEffects();
 s.capabilities??={};s.capabilities.reviewFaultDispatchStarted=true;
 const poll=async(read,accept)=>{const deadline=Date.now()+120000;for(;;){const value=await read();if(accept(value))return value;assert(Date.now()<deadline,'Review fixture unsettled; reconcile exact claim, never repost');await new Promise(r=>setTimeout(r,500));}};
 const nativeRead=path=>s.nativePage.evaluate(async path=>{const r=await fetch(path,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Native fixture read failed');return r.json();},path);
 const ticket=operator?await privateNativeRead(s,'ticket',{ticketId:String(f.ticketId)}):await nativeRead('/api/v1/tickets/'+f.ticketId);assert.equal(String(ticket.id),String(f.ticketId));assert.equal(ticket.wasalx_connection_id,f.connectionId);assert.equal(ticket.wasalx_group_id,f.groupRef);
 if(operator)assert.equal(String(ticket.group_id),String(inputs.portalTeamAccess.nativeGroupId),'Review ticket queue differs from the explicit Team grant');
 const bindings=await s.scoped(reviewFixtureSql.binding,[s.tenantId,f.bindingId,f.connectionId]);assert.equal(bindings.length,1);const sessions=await s.scoped(reviewFixtureSql.session,[s.tenantId,f.connectionId]);assert.equal(sessions.length,1);assert(sessions[0].opaque_session_id);
 const actor=operator?await privateNativeRead(s,'user',{userId:operator.nativeUserId}):await nativeRead('/api/v1/users/me');if(operator){assert.equal(String(actor.id),operator.nativeUserId);assert.equal(actor.active,true);}const displayName=[actor.firstname,actor.lastname].filter(Boolean).join(' ').replace(/\s+/g,' ').trim()||'Agent';
 const body='Synthetic review '+namespace,wire=reviewWireText(body,{prefix:bindings[0].agent_prefix,placement:bindings[0].agent_identity_placement,displayName}),wireSha256=hash(wire);
 const prior=operator?await privateNativeRead(s,'articles',{ticketId:String(f.ticketId)}):await nativeRead('/api/v1/ticket_articles/by_ticket/'+f.ticketId);assert(Array.isArray(prior));assert(!prior.some(a=>String(a.body).includes(body)),'Existing native marker must be reconciled');
 const control=command=>callSimulationControl(s.socketPath,command),armId=namespace+'-review-unknown';
 const providerReadAll=async()=>{const value=JSON.parse(await s.run('docker',['exec',h.binding.containerId,'node','-e',"fetch('http://127.0.0.1:3000/__simulation/receipts',{headers:{'x-api-key':process.env.WAHA_API_KEY}}).then(r=>{if(!r.ok)throw Error('Provider receipt read failed');return r.json()}).then(x=>console.log(JSON.stringify(x)))"]));assert.equal(value.evidenceClass,'simulated-provider');assert(Array.isArray(value.receipts));return value.receipts;};
 const providerRead=async()=>(await providerReadAll()).filter(r=>r.textSha256===wireSha256);
 assert.equal((await providerRead()).length,0);const arms=await control({action:'read-arms'});assert(!arms.some(a=>a.id===armId||a.state==='ARMED'),'Prior arm requires reconciliation');
 let portalReply;
 const postPortal=async()=>{
  portalReply=await submitPortalReply(operator,{ticketId:String(ticket.id),ticketNumber:String(ticket.number),body,internal:false,expectedPreviewText:wire,checkpoint:s.checkpoint,beforeDispatch:async input=>{
   const claim=await open(join(s.privateDir,'review-fixture-'+namespace+'.reply-intent.json'),'wx',0o600);try{await claim.writeFile(JSON.stringify({evidenceMode:'simulated',surface:'portal',namespace,tenantId:s.tenantId,connectionId:f.connectionId,actorId:operator.userId,nativeUserId:operator.nativeUserId,input,wireSha256,armId,disposition:'reconcile-original-operation-before-resume'}));await claim.sync();}finally{await claim.close();}
   await s.checkpoint({phase:'review-portal-original-intent',operationId:input.operation_id,ticketId:input.ticket_id,wireSha256});
  }});
  assert.equal(portalReply.state,'APPLIED','Portal review reply is unknown; retain claim/arm and original operation, never repost');assert.equal(portalReply.ticketId,String(ticket.id));
  const article=await privateNativeRead(s,'article',{articleId:portalReply.articleId});assert.equal(String(article.id),portalReply.articleId);assert.equal(String(article.ticket_id),String(ticket.id));assert.equal(String(article.created_by_id),operator.nativeUserId);assert.equal(article.internal,false);assert.equal(article.content_type,'text/plain');assert.equal(article.type,'wasalx group message');assert.equal(article.sender,'Agent');assert.equal(article.body,body);
  const articles=await privateNativeRead(s,'articles',{ticketId:String(ticket.id)});assert.equal(articles.filter(row=>String(row.body).includes(body)).length,1);assert(articles.some(row=>String(row.id)===portalReply.articleId));await operator.verify();return article;
 };
 const article=await dispatchReviewOnce({checkpoint:s.checkpoint,persist:async()=>{const file=await open(join(s.privateDir,'review-fixture-'+namespace+'.claim.json'),'wx',0o600);try{await file.writeFile(JSON.stringify({evidenceMode:'simulated',namespace,tenantId:s.tenantId,connectionId:f.connectionId,ticketId:f.ticketId,bodySha256:hash(body),wireSha256,armId,at:new Date().toISOString(),disposition:'reconcile-before-resume'}));await file.sync();}finally{await file.close();}},arm:async()=>{await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:f.connectionId});await s.checkpoint({phase:'review-arm-intent',armId,wireSha256});const armed=await control({action:'arm-next-send',input:{id:armId,session:sessions[0].opaque_session_id,chatId:f.groupRef,textSha256:wireSha256,outcome:'disconnect-after-acceptance'}});assert.equal(armed.id,armId);assert.equal(armed.state,'ARMED');await s.checkpoint({phase:'review-armed',armed});},post:operator?postPortal:()=>s.nativePage.evaluate(async({ticketId,body})=>{const csrf=document.querySelector('meta[name="csrf-token"]')?.content;if(!csrf)throw Error('Native CSRF unavailable');const r=await fetch('/api/v1/ticket_articles',{method:'POST',headers:{'content-type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({ticket_id:Number(ticketId),body,content_type:'text/plain',type:'wasalx group message',sender:'Agent',internal:false}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Native reply rejected; reconcile before repost');return r.json();},{ticketId:f.ticketId,body})});
 assert.equal(String(article.ticket_id),String(f.ticketId));
 const deliveries=await poll(()=>s.scoped(reviewFixtureSql.delivery,[s.tenantId,f.connectionId,String(f.ticketId),String(article.id)]),rows=>{assert(rows.length<=1);if(!rows.length)return false;assert(['QUEUED','CLAIMED','SENDING','OUTCOME_UNKNOWN'].includes(rows[0].state),'Unexpected delivery result; no repeat');return rows[0].state==='OUTCOME_UNKNOWN'&&rows[0].lease_id===null;});
 const delivery=deliveries[0];assert.equal(delivery.content_type,'text/plain');assert.equal(hash(reviewWireText(delivery.message_body,{prefix:delivery.agent_prefix_snapshot,placement:delivery.agent_identity_placement_snapshot,displayName:delivery.agent_display_name})),wireSha256);
 const reviews=await poll(()=>s.scoped(reviewFixtureSql.review,[s.tenantId,delivery.id]),rows=>rows.length>0),attempts=await s.scoped(reviewFixtureSql.attempts,[s.tenantId,delivery.id]),receipts=await providerRead();
 const review=validateReviewReceipt({delivery,attempts,reviews,receipts,wireSha256,tenantId:s.tenantId,connectionId:f.connectionId,bindingId:f.bindingId,chatId:f.groupRef});
 const consumed=(await control({action:'read-arms'})).find(a=>a.id===armId);assert.equal(consumed?.state,'CONSUMED');
 const unknown={id:delivery.id,state:'OUTCOME_UNKNOWN',attempts:Number(delivery.attempts),external_message_id:null};
 // Exact generated exception only: unrelated UNKNOWN remains rejected by shared observer.
 const observe=()=>waitOwnedRestoration({scoped:s.scoped,tenantId:s.tenantId,connectionId:f.connectionId,registry:{closed:true,entries:()=>[]},originalUnknowns:[unknown]});await observe();
 const listed=await s.ownerPage.evaluate(async()=>{const r=await fetch('/api/reviews');if(!r.ok)throw Error('Reviews unavailable');return r.json();});assert(Array.isArray(listed));const visible=listed.filter(r=>r.id===review.id);assert.equal(visible.length,1);assert.equal(visible[0].state,'OPEN');assert.equal(visible[0].delivery_id,delivery.id);
 const fixture={evidenceMode:'simulated',namespace,tenantId:s.tenantId,connectionId:f.connectionId,reviewId:review.id,deliveryId:delivery.id,ticketId:String(f.ticketId),articleId:String(article.id),runtimeBinding:{...h.binding},retainedUnknown:unknown,providerReceipt:{id:receipts[0].id,textSha256:wireSha256},attemptIds:attempts.map(a=>a.id),providerCode:attempts[0].provider_code,providerCodeObservation:'current-original-attempt-at-creation',disposition:'retain-readonly-unknown',...(operator?{surface:'portal',producerBinding:await operator.verify(),portalReply}: {})};
 s.capabilities.reviewFixture={fixture,verifyReadOnly:async()=>{await h.assertIsolatedRuntime({evidenceMode:'simulated',tenantId:s.tenantId,connectionId:f.connectionId});await observe();const current=await s.scoped(reviewFixtureSql.attempts,[s.tenantId,delivery.id]);assert.deepEqual(current,attempts);assert.deepEqual(await providerRead(),receipts);const rows=await s.scoped(reviewFixtureSql.review,[s.tenantId,delivery.id]);assert.deepEqual(rows,reviews);return{unchanged:true};}};
 s.capabilities.reviewFixture.readProviderReceipts=()=>guardedReviewProviderRead(s.capabilities.reviewFixture.verifyReadOnly,providerReadAll);
 await s.capabilities.reviewFixture.verifyReadOnly();await s.checkpoint({phase:'current-run-review-fixture',fixture});return fixture;
}

async function completedReviewSource(s,ref){assert(ref&&typeof ref.path==='string'&&!isAbsolute(ref.path));assert.match(ref.sha256??'',/^[a-f0-9]{64}$/u);const root=await realpath(s.privateDir),path=await realpath(resolve(root,ref.path)),rel=relative(root,path);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'Completed review source escaped its private root');const bytes=await readFile(path);assert.equal(hash(bytes),ref.sha256,'Completed review source hash drift');return bytes;}
// Adopts a prior run's retained UNKNOWN review read-only: no arm, no native or portal post, no retry.
// The builder admits the source refs; this stage reads them back and the current database/provider state.
export async function adoptCompletedReviewFixtureStage(s,{namespace,inputs,config}){
 const c=config?.completedReview,g=inputs.group;assert(c&&c.sourceNamespace!==namespace&&c.sourceProject===s.model.name);
 assert.equal(g?.evidenceMode,'simulated');assert.equal(g.namespace,namespace);assert.equal(g.tenantId,s.tenantId);assert(g.connectionId&&g.bindingId&&g.groupRef);
 const prior=c.sourceNamespace;assert.match(prior,/^[A-Za-z0-9-]{1,40}$/u);assert.equal(typeof c.requireNoFurtherAttempts,'boolean');
 const paths={fixture:`scenario-${prior}/fixture-remaining-quality.json`,claim:`review-fixture-${prior}.claim.json`,intents:`scenario-${prior}/intents.jsonl`,manifest:c.sources?.manifest?.path,terminal:`qualification-app-${prior}.result.json`,stageOutcomes:`scenario-${prior}/stage-outcomes.json`};
 assert(new RegExp(`^manifest\\.${prior}\\.(?:full|(?:[A-Za-z0-9-]+\\.)?selected)\\.json$`,'u').test(paths.manifest??''),'Review source manifest must name its namespace');
 for(const[name,path]of Object.entries(paths))assert.equal(c.sources?.[name]?.path,path);
 const [fixtureBytes,claimBytes,intentsBytes,manifestBytes,terminalBytes,outcomesBytes]=await Promise.all(Object.keys(paths).map(name=>completedReviewSource(s,c.sources[name])));
 const source=JSON.parse(fixtureBytes),claim=JSON.parse(claimBytes),manifest=JSON.parse(manifestBytes),terminal=JSON.parse(terminalBytes),outcomes=JSON.parse(outcomesBytes),f=source.result?.reviewFixture;
 assert.equal(source.scenario,'remaining-quality');assert.equal(source.fixture,'remainingQuality');assert.equal(source.namespace,prior);assert.equal(source.evidenceMode,'simulated');
 assert.equal(manifest.namespace,prior);assert.equal(terminal.namespace,prior);assert.equal(terminal.manifestSha256,c.sources.manifest.sha256);assert.equal(terminal.status,'terminal');
 const sourceExitCode=c.sourceExitCode??0;assert.equal(terminal.exitCode,sourceExitCode);assert.equal(terminal.applicationSha,c.sourceCandidate.sha);assert.equal(terminal.applicationTree,c.sourceCandidate.tree);
 assert.equal(outcomes.namespace,prior);const reviewStage=outcomes.outcomes.filter(x=>x.scenario==='remaining-quality');assert.equal(reviewStage.length,1);
 // A failed aggregate is admissible only when the review fixture itself and every review-specific row passed.
 if(reviewStage[0].status==='failed'){
  assert.equal(sourceExitCode,1);assert.equal(source.result?.status,'quality-collection-completed');
  const prefix='cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery::',rows=source.result?.results?.filter(x=>x.testId?.startsWith(prefix+'unknown-outcome-never-auto-resends::'));
  assert(Array.isArray(rows)&&rows.length>0&&rows.every(x=>x.result==='passed'),'Historical review-specific source row failed');
 }else assert.deepEqual(reviewStage.map(x=>x.status),['passed']);
 assert.equal(claim.namespace,prior);assert.equal(claim.tenantId,s.tenantId);assert.equal(claim.connectionId,g.connectionId);assert.equal(claim.disposition,'reconcile-before-resume');
 assert.equal(f?.evidenceMode,'simulated');assert.equal(f.namespace,prior);assert.equal(f.tenantId,s.tenantId);assert.equal(f.connectionId,g.connectionId);assert.equal(f.disposition,'retain-readonly-unknown');
 assert.equal(String(f.ticketId),String(claim.ticketId));assert.equal(f.providerReceipt?.textSha256,claim.wireSha256);
 assert.equal(f.runtimeBinding?.project,s.model.name);assert.equal(f.runtimeBinding?.connectionId,g.connectionId);assert.equal(f.runtimeBinding?.containerId,s.containers['waha-gows'].Id);assert.equal(f.runtimeBinding?.imageId,s.containers['waha-gows'].Image);assert.equal(f.runtimeBinding?.socketPath,s.socketPath);
 const sessions=await s.scoped("SELECT id,opaque_session_id FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' AND state='WORKING'",[s.tenantId,g.connectionId]);assert.equal(sessions.length,1);assert.equal(sessions[0].id,f.runtimeBinding.providerSessionId);
 const bindings=await s.scoped('SELECT b.routing_group_id,b.whatsapp_group_id,g.external_group_id FROM group_bindings b JOIN whatsapp_groups g ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id WHERE b.tenant_id=$1 AND b.id=$2 AND g.connection_id=$3',[s.tenantId,g.bindingId,g.connectionId]);assert.equal(bindings.length,1);assert.equal(bindings[0].external_group_id,g.groupRef);assert.equal(bindings[0].whatsapp_group_id,g.groupId);
 const intents=intentsBytes.toString('utf8').trim().split(/\r?\n/u).map(JSON.parse),armed=intents.filter(x=>x.phase==='review-armed'&&x.armed?.id===claim.armId),accepted=intents.filter(x=>x.phase==='review-native-accepted');
 assert.equal(armed.length,1);assert.equal(armed[0].armed.state,'ARMED');assert.equal(accepted.length,1);assert.equal(String(accepted[0].articleId),String(f.articleId));
 const deliveries=await s.scoped(reviewFixtureSql.delivery,[s.tenantId,g.connectionId,String(f.ticketId),String(f.articleId)]);assert.equal(deliveries.length,1);
 const delivery=deliveries[0],attempts=await s.scoped(reviewFixtureSql.attempts,[s.tenantId,delivery.id]),reviews=await s.scoped(reviewFixtureSql.review,[s.tenantId,delivery.id]),stopAudits=await s.scoped(reviewFixtureSql.stopAudit,[s.tenantId,f.reviewId]);
 const providerRead=async()=>{const value=await readDirectProviderReceipts(s);assert.equal(value.evidenceClass,'simulated-provider');assert(Array.isArray(value.receipts));return value.receipts;},receipts=(await providerRead()).filter(row=>row.textSha256===claim.wireSha256);
 const review=validateReviewReceipt({delivery,attempts,reviews,receipts,wireSha256:claim.wireSha256,tenantId:s.tenantId,connectionId:g.connectionId,bindingId:g.bindingId,chatId:g.groupRef,requireNoFurtherAttempts:c.requireNoFurtherAttempts,stopAudits});
 assert.equal(delivery.id,f.deliveryId);assert.equal(review.id,f.reviewId);assert.deepEqual(attempts.map(x=>x.id),f.attemptIds);assert.equal(receipts[0].id,f.providerReceipt.id);
 assert.equal(f.retainedUnknown?.id,delivery.id);assert.equal(f.retainedUnknown.state,'OUTCOME_UNKNOWN');assert.equal(Number(f.retainedUnknown.attempts),1);assert.equal(f.retainedUnknown.external_message_id,null);
 if(Object.hasOwn(f,'providerCode'))assert.equal(attempts[0].provider_code,f.providerCode,'Original attempt provider code drifted from its source');
 const readArms=()=>s.readReviewArms?s.readReviewArms({action:'read-arms'}):callSimulationControl(s.socketPath,{action:'read-arms'});
 const arms=await readArms();assert.equal(arms.filter(x=>x.id===claim.armId).length,1);assert.equal(arms.find(x=>x.id===claim.armId)?.state,'CONSUMED');assert(!arms.some(x=>x.state==='ARMED'));
 const verifyReadOnly=async()=>{assert.deepEqual(await readArms(),arms,'Authoritative simulator arm state changed');await observeOwnedRestoration({scoped:s.scoped,tenantId:s.tenantId,connectionId:g.connectionId,registry:{closed:true,entries:()=>[]},originalUnknowns:[f.retainedUnknown]});
  assert.deepEqual(await s.scoped(reviewFixtureSql.delivery,[s.tenantId,g.connectionId,String(f.ticketId),String(f.articleId)]),deliveries);assert.deepEqual(await s.scoped(reviewFixtureSql.attempts,[s.tenantId,delivery.id]),attempts);
  assert.deepEqual(await s.scoped(reviewFixtureSql.review,[s.tenantId,delivery.id]),reviews);assert.deepEqual(await s.scoped(reviewFixtureSql.stopAudit,[s.tenantId,f.reviewId]),stopAudits);
  assert.deepEqual((await providerRead()).filter(row=>row.textSha256===claim.wireSha256),receipts);return{unchanged:true};};
 const adopted={...f,namespace,sourceNamespace:prior,noReplay:true,providerCode:attempts[0].provider_code,providerCodeObservation:'current-original-attempt-at-admission',requireNoFurtherAttempts:c.requireNoFurtherAttempts};
 s.capabilities??={};assert(!s.capabilities.reviewFixture,'Review fixture already claimed');
 s.capabilities.reviewFixture={fixture:adopted,verifyReadOnly,readProviderReceipts:()=>guardedReviewProviderRead(verifyReadOnly,providerRead)};
 await verifyReadOnly();await s.checkpoint({phase:'completed-review-fixture-admitted',sourceNamespace:prior,sourceHashes:Object.fromEntries(Object.entries(c.sources).map(([name,ref])=>[name,ref.sha256])),noReplay:true});
 return adopted;
}
// Observer mode: the two read-only review rows run against the adopted fixture only.
export async function completedUnknownReadOnlyStage(s,args){
 const f=args.inputs.reviewFixture;assert.equal(f?.namespace,args.namespace);assert.equal(f.noReplay,true);assert.equal(s.capabilities?.reviewFixture?.fixture,f,'Exact adopted review capability required');
 const result=await unknownReviewReadOnlyStage(s,{...args,inputs:{reviewFixture:f},config:{selectedTestIds:completedReviewTestIds}});
 assert.deepEqual(result.proofs.map(row=>row.testId),completedReviewTestIds);return{...result,results:result.proofs,proofs:[]};
}
