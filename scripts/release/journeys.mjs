// Inert extension of p04-dev-driver-v2. Root supplies its admitted Page and callbacks.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
export const extensionModes=['lifecycle-ordering','lifecycle-admission','lifecycle-ambiguous','add-access','add-access-exchange-unknown','reconnect','reconnect-exchange-unknown','activation-ready','activation-held'];
export const lifecycleSteps=['negative','duplicate','stale-recovery','newer-recovery'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu,hex=/^[a-f0-9]{64}$/u;
export const isExtension=m=>extensionModes.includes(m.mode);
export function requiredExtensionPaths(m){return['scripts/contracts/meta-simulation-server.mjs','packages/core/src/meta-signup-contract.ts','services/control-api/src/meta-signup.service.ts','services/control-api/src/connections.controller.ts','services/connector-worker/src/connection-operation-processor.ts','services/connector-worker/src/connection-operation-repository.ts',
 ...(m.mode.startsWith('lifecycle')?['packages/core/src/meta-account-relation.ts','services/control-api/src/webhook-ingress.controller.ts','services/control-api/src/webhook-security.ts','services/control-api/src/main.ts','services/control-api/src/database.service.ts','services/connector-worker/src/inbound-repository.ts','services/connector-worker/src/inbound-processor.ts']:[]),
 ...(m.mode.startsWith('activation')?['packages/core/src/meta-add-access-activation-contract.ts','services/control-api/src/meta-add-access-activation.ts','app/MetaSavedAccessActivation.tsx','app/api/connections/[id]/meta/activation/route.ts','packages/core/src/meta-routing.ts']:[])];}
export function validateExtension(m){
 if(!isExtension(m))return;
 assert(hex.test(m.extensionSha256),'Frozen extension required');
 assert(hex.test(m.catalogMappingSha256),'Root-reviewed finite catalog mapping required');
 for(const path of requiredExtensionPaths(m))assert(m.sourceFiles?.some(f=>f.path===path&&hex.test(f.sha256)),'Required extension source input missing');
 if(m.ui){assert(['add-access','reconnect'].includes(m.mode));assert(['tenant_owner-en-desktop','tenant_owner-ar-desktop','tenant_owner-en-mobile','tenant_owner-ar-mobile'].includes(m.ui.contextId));assert(hex.test(m.uiHelperSha256));}
 if(m.mode.startsWith('lifecycle'))assert(m.testId==='P02-03');
 if(m.mode.startsWith('reconnect'))assert(m.testId==='P05-01');
 const fresh=m.mode.startsWith('add-access');
 assert(fresh?m.target===undefined:uuid.test(m.target?.connectionId)&&uuid.test(m.target?.providerSessionId),'Exact existing target required');
 if(m.mode.startsWith('lifecycle'))assert(Number.isSafeInteger(m.lifecycleTime)&&m.lifecycleTime>0,'Pinned event timestamp required');
 if(m.mode.startsWith('activation')){
  assert(hex.test(m.activation?.prerequisiteReceiptSha256),'Authenticated P07/P08 prerequisite receipt required');
  if(m.mode==='activation-ready')assert(m.activation.routing?.sessionId===m.target.providerSessionId&&Number.isSafeInteger(m.activation.routing.configurationVersion)&&m.activation.routing.configurationVersion>0&&Number.isSafeInteger(m.activation.routing.reviewVersion)&&m.activation.routing.reviewVersion>0,'Exact current routing CAS required');
  else assert(['PRIVACY_HOLD','LIFECYCLE_HOLD','ROUTING_REVIEW_REQUIRED','CONTROL_UNRESOLVED','FUNDING_REQUIRED','CREDENTIAL_REQUIRED'].includes(m.activation.expectedReason),'One pre-existing hold required');
 }
}
export function assertFreshAccess(provider){
 assert.equal(provider.evidenceClass,'simulated-provider-signup');assert.equal(provider.phoneStatus,'CONNECTED');
 assert.equal(provider.code,null);assert.deepEqual(provider.exchangeReceipts,[]);assert.equal(provider.registration,null);
 assert.equal(provider.registrationAttempts,0);assert.equal(provider.armedFault,null);assert.deepEqual(provider.faultEvents,[]);
}
function lifecycleUnit(m,step){
 assert.equal(m.mode,'lifecycle-ordering');assert(lifecycleSteps.includes(step));
 const offset=step==='stale-recovery'?-1:step==='newer-recovery'?1:0;
 // These fixed ASCII keys are in canonical sorted order, matching metaLifecyclePayloadSha256.
 return{entry:[{changes:[{field:'account_update',value:{ban_info:{waba_ban_state:step==='negative'||step==='duplicate'?'DISABLE':'REINSTATE'},event:'DISABLED_UPDATE',phone_number:m.fixture.signup.displayPhoneNumber}}],id:m.fixture.signup.wabaId,time:m.lifecycleTime+offset}],object:'whatsapp_business_account'};
}
export function lifecyclePayload(m,step){const value=lifecycleUnit(m,step);return step==='negative'||step==='duplicate'?{...value,entry:[value.entry[0],value.entry[0]]}:value;}
export const lifecycleProviderId=(m,step)=>'lifecycle:'+createHash('sha256').update(JSON.stringify(lifecycleUnit(m,step))).digest('hex');
export function lifecycleStepsFor(m){return m.mode==='lifecycle-ordering'?lifecycleSteps:m.mode==='lifecycle-admission'?['bad-signature','oversized','malformed','future','wrong-account-shape','wrong-account','partner-batch']:m.mode==='lifecycle-ambiguous'?['unresolved-negative','unresolved-recovery','tie-negative','tie-recovery']:[];}
export function lifecycleDelivery(m,step){
 assert(lifecycleStepsFor(m).includes(step));
 if(m.mode==='lifecycle-ordering')return{bytes:Buffer.from(JSON.stringify(lifecyclePayload(m,step))),status:200,providerIds:[lifecycleProviderId(m,step)],counts:{accepted:true,count:step==='duplicate'?0:1,duplicates:step==='duplicate'?2:step==='negative'?1:0,unrouted:0}};
 const s=m.fixture.signup,t=m.lifecycleTime,unit=(value,time=t,id=s.wabaId)=>({entry:[{changes:[{field:'account_update',value}],id,time}],object:'whatsapp_business_account'});
 let units=[unit({ban_info:{waba_ban_state:'DISABLE'},event:'DISABLED_UPDATE',phone_number:s.displayPhoneNumber})],status=200;
 if(step==='bad-signature')status=401;
 if(step==='oversized')status=413;
 if(step==='malformed'){units=[unit(null)];status=400;}
 if(step==='future'){units[0].entry[0].time=t+86400;status=400;}
 if(step==='wrong-account-shape'){units=[unit({event:'PARTNER_REMOVED',waba_info:{waba_id:null}},t,s.businessId)];status=400;}
 if(step==='wrong-account')units[0].entry[0].id=s.businessId;
 if(step==='partner-batch')units=[unit({event:'PARTNER_REMOVED',phone_number:s.displayPhoneNumber,waba_info:{waba_id:s.wabaId}},t,s.businessId),unit({event:'PARTNER_ADDED',phone_number:s.displayPhoneNumber,waba_info:{waba_id:s.wabaId}},t+1,s.businessId)];
 if(step.startsWith('unresolved')){const unknown=s.displayPhoneNumber.slice(0,-1)+(s.displayPhoneNumber.endsWith('9')?'8':'9');units=[unit({ban_info:{waba_ban_state:step==='unresolved-negative'?'DISABLE':'REINSTATE'},event:'DISABLED_UPDATE',phone_number:unknown},t+(step==='unresolved-recovery'?1:0))];}
 if(step.startsWith('tie'))units=[unit({ban_info:{waba_ban_state:step==='tie-negative'?'DISABLE':'REINSTATE'},event:'DISABLED_UPDATE',phone_number:s.displayPhoneNumber},t+3)];
 const body={entry:units.flatMap(u=>u.entry),object:'whatsapp_business_account'};let bytes=Buffer.from(JSON.stringify(body));
 if(step==='oversized')bytes=Buffer.concat([bytes,Buffer.alloc(3_000_001-bytes.length,32)]);
 const providerIds=units.map(u=>'lifecycle:'+createHash('sha256').update(JSON.stringify(u)).digest('hex'));
 return{bytes,status,invalidSignature:step==='bad-signature',providerIds,counts:status!==200?null:{accepted:true,count:step==='wrong-account'?0:units.length,duplicates:0,unrouted:step==='wrong-account'?1:0}};
}
export function assertTarget(m,row){
 assert(row?.connection&&row.connection.id===m.target.connectionId&&row.connection.session_id===m.target.providerSessionId,'Current target changed');
 assert.equal(row.connection.phone_id,m.fixture.signup.phoneId);assert.equal(row.connection.waba_id,m.fixture.signup.wabaId);
 assert.equal(row.connection.ownership_state,'ACTIVE');assert.equal(row.sessionCount,1);
}
export const latestAttemptPath=m=>'/api/connections/meta/signup/attempts?'+(m.mode.startsWith('reconnect')?'targetConnectionId='+encodeURIComponent(m.target.connectionId):'purpose=ADD_ACCESS');
export function assertOperationUnion(all,prior,selectedId){
 assert.equal(new Set(all.map(o=>o.id)).size,all.length);assert.equal(all.length,prior.length+1);
 for(const old of prior)assert.deepEqual(all.find(o=>o.id===old.id),old,'Previous operation changed');
 const added=all.filter(o=>!prior.some(old=>old.id===o.id));assert.equal(added.length,1);assert.equal(added[0].id,selectedId);assert.equal(added[0].lease_id,null);return added[0];
}
export function assertAccessOutcome(m,view,provider,db,before){
 const reconnect=m.mode.startsWith('reconnect'),unknown=m.mode.endsWith('exchange-unknown'),purpose=reconnect?'RECONNECT':'ADD_ACCESS';
 assert.equal(view.purpose,purpose);assert.equal(db.attempt.id,view.attemptId);assert.equal(db.attempt.purpose,purpose);assert.equal(db.attempt.status,view.status);
 assert.equal(db.attempt.exchange_claimed,true);assert.equal(db.attempt.registration_claimed,false);
 assert.equal(provider.phoneStatus,'CONNECTED');assert.equal(provider.registration,null);assert.equal(provider.registrationAttempts,0);
 assert.equal(provider.exchangeReceipts.length,1);assert(provider.code?.consumedAt>0);assert.equal(provider.armedFault,null);
 assert.equal(provider.faultEvents.length,unknown?1:0);
 if(unknown){
  assert.equal(view.status,'OUTCOME_UNKNOWN');assert.equal(view.reasonCode,'META_SIGNUP_EXCHANGE_UNKNOWN');
  assert.equal(db.attempt.credential_stored,false);assert.equal(db.attempt.connection_id,null);assert.equal(db.attempt.operation_id,null);assert.deepEqual(db.operations,[]);
  assert.equal(provider.faultEvents[0].phase,'exchange');assert.equal(provider.faultEvents[0].outcome,'ACCEPTED_DISCONNECTED');
  if(reconnect)assert.deepEqual(db.target,before.target,'Unknown exchange altered existing access');
  else assert.equal(db.available,true,'Unknown exchange allocated the new phone');
 }else{
  assert.equal(view.status,'COMPLETED');assert.equal(view.outcome,reconnect?'ACCESS_RENEWED_PAUSED':'ACCESS_ADDED_PAUSED');
  assert.equal(view.readiness.payment.paymentMethodVerified,false);assert.equal(view.readiness.subscription,'UNKNOWN');
  assert.equal(db.attempt.connection_id,view.connectionId);assert.equal(db.attempt.operation_id,view.operationId);assert.equal(db.attempt.credential_stored,true);
  const operation=assertOperationUnion(db.operations,reconnect?before.target.operations:[],view.operationId);assert.equal(operation.state,'SUCCEEDED');assert.equal(operation.pause_preserved,true);
  assert.equal(operation.operation_type,reconnect?'ROTATE_META_CREDENTIAL':'PROVISION');assert.equal(reconnect?operation.rotated:operation.access_added,true);
  assert.equal(db.connection.state,'PAUSED');assert.equal(db.connection.session_state,'PAUSED');assert.equal(db.connection.route_state,'PAUSED');
  assert.equal(db.connection.ownership_state,'ACTIVE');assert.equal(db.connection.phone_id,m.fixture.signup.phoneId);assert.equal(db.connection.waba_id,m.fixture.signup.wabaId);assert.equal(db.sessionCount,1);
  if(reconnect){assert.equal(view.connectionId,m.target.connectionId);assert.equal(db.connection.session_id,m.target.providerSessionId);assert.notEqual(db.connection.credential_fingerprint,before.target.connection.credential_fingerprint);assert.deepEqual(db.connection.lifecycle,before.target.connection.lifecycle);assert.deepEqual(db.connection.routing,before.target.connection.routing);assert.deepEqual(db.target.preservation,before.target.preservation);}
 }
 return{attemptId:view.attemptId,status:view.status,outcome:view.outcome??null,connectionId:view.connectionId??null,operationId:view.operationId??null,registrationAccepted:false,exchangeAcceptedOnce:true,remainsPaused:!unknown,paymentMethodVerified:false};
}
async function runAccess({m,request,control,observe,poll,checkpoint}){
 const before=await observe(),provider=await control('GET','/signup');assertFreshAccess(provider);
 const reconnect=m.mode.startsWith('reconnect'),unknown=m.mode.endsWith('exchange-unknown');
 if(reconnect){assertTarget(m,before.target);assert.equal(before.target.connection.state,'PAUSED');assert.equal(before.target.connection.session_state,'PAUSED');assert.equal(before.target.connection.route_state,'PAUSED');
  assert(before.target.preservation.message_links.count>0&&(before.target.preservation.case_correlations.count>0||before.target.preservation.bot_handoff_jobs.count>0),'Reconnect continuity needs actual pre-existing synthetic history');}
 else assert.equal(before.available,true);
 const base='/api/connections/meta/signup/attempts';
 let view=await request(base,'POST',{name:'Synthetic existing access '+m.runId,payerMode:'CUSTOMER',idempotencyKey:randomUUID(),...(reconnect?{targetConnectionId:m.target.connectionId}:{purpose:'ADD_ACCESS'})},'access-start');
 assert.equal(view.status,'AWAITING_AUTHORIZATION');assert(uuid.test(view.attemptId));assert(/^[A-Za-z0-9_-]{43}$/u.test(view.challenge));
 const id=view.attemptId,path=base+'/'+id,challenge=view.challenge;
 await checkpoint({phase:'intent',step:'access-code',attemptId:id});const issued=await control('POST','/signup/code',{});assert(issued.expiresAt>Date.now()&&/^[A-Za-z0-9_-]{43}$/u.test(issued.code));
 if(unknown)await control('POST','/signup/fault',{id:m.runId+'-exchange',phase:'exchange'});
 view=await request(path+'/exchange','POST',{challenge,code:issued.code,expectedRevision:view.revision},'access-exchange');
 if(!unknown){
  assert.equal(view.status,'SELECTION_REQUIRED');assert.equal(view.choices.length,1);const choice=view.choices[0];
  assert.equal(choice.mode,'STANDARD');assert.equal(choice.numberState,'REGISTERED');assert.equal(choice.selectable,true);assert.equal(choice.displayPhoneNumber,m.fixture.signup.displayPhoneNumber);
  // Existing registered numbers never receive a registration PIN or a caller-supplied provider ID.
  view=await request(path+'/select','POST',{expectedRevision:view.revision,selectionRevision:view.selectionRevision,choiceId:choice.choiceId},'access-select');
  view=await poll(()=>request(path),row=>!['EXCHANGING','PROVISIONING'].includes(row.status));
 }
 const proof=assertAccessOutcome(m,view,await control('GET','/signup'),await observe(id),before);
 const reread=await request(path);assert.equal(reread.attemptId,id);
 assert.deepEqual(assertAccessOutcome(m,reread,await control('GET','/signup'),await observe(id),before),proof);
 const latest=await request(latestAttemptPath(m));assert.equal(latest.attempt?.attemptId,id);
 return proof;
}
async function runLifecycle({m,dispatch,observe,poll}){
 const before=await observe();assertTarget(m,before.target);assert.equal(before.target.connection.state,'WORKING');assert.equal(before.target.connection.session_state,'WORKING');
 assert.deepEqual(before.target.connection.lifecycle?.reasonStates?.filter(r=>r.blocked)??[],[]);assert.equal(before.target.pendingLifecycle,0);
 const receipts=[];let previous;
 for(const step of lifecycleSteps){
  const result=await dispatch(step);assert.equal(result.status,200);assert.deepEqual(result.receipt,{accepted:true,count:step==='duplicate'?0:1,duplicates:step==='duplicate'?2:step==='negative'?1:0,unrouted:0});
  const row=await poll(()=>observe(undefined,step),r=>r.events.length===1&&r.events[0].status==='PROCESSED'&&r.events[0].lease_id===null);
  assertTarget(m,row.target);assert.equal(row.target.connection.state,'ACTION_REQUIRED');assert.equal(row.target.connection.session_state,'ACTION_REQUIRED');assert.equal(row.target.pendingLifecycle,0);
  assert.equal(row.target.connection.credential_fingerprint,before.target.connection.credential_fingerprint);assert.deepEqual(row.target.preservation,before.target.preservation);assert.deepEqual(row.target.operations,before.target.operations);
  const reasons=row.target.connection.lifecycle.reasonStates.filter(r=>r.blocked).map(r=>r.reason);
  // Even newer recovery is an observation. Only explicit current activation may clear a hold.
  assert.deepEqual(reasons,['ACCOUNT_DISABLED']);
  if(step.endsWith('recovery'))assert.equal(row.target.connection.lifecycle.reasonStates.find(r=>r.reason==='ACCOUNT_DISABLED').recovery.observedAt,new Date((m.lifecycleTime+(step==='stale-recovery'?-1:1))*1000).toISOString());
  if(step==='duplicate'){assert.equal(row.events[0].id,previous.events[0].id);assert.deepEqual(row.target.connection.lifecycle,previous.target.connection.lifecycle);}
  receipts.push({step,eventId:row.events[0].id,status:row.events[0].status,blockedReasons:reasons,connectionState:row.target.connection.state});previous=row;
 }
 return{receipts,automaticResume:false,scope:'one exact signed display-phone account lifecycle; other lifecycle variants remain separate'};
}
async function runLifecycleBoundary({m,dispatch,observe,poll}){
 const before=await observe();assertTarget(m,before.target);assert.equal(before.target.connection.state,'WORKING');assert.equal(before.target.pendingLifecycle,0);assert.deepEqual(before.target.connection.lifecycle?.reasonStates?.filter(r=>r.blocked)??[],[]);
 const proof=[];
 for(const step of lifecycleStepsFor(m)){
  const plan=lifecycleDelivery(m,step),response=await dispatch(step);assert.equal(response.status,plan.status);assert.deepEqual(response.receipt,plan.counts);
  const noAdmission=plan.status!==200||step==='wrong-account';
  const row=noAdmission?await observe(undefined,step):await poll(()=>observe(undefined,step),r=>r.events.length===plan.providerIds.length&&r.events.every(e=>e.status==='PROCESSED'&&e.lease_id===null));
  assertTarget(m,row.target);assert.deepEqual(row.target.preservation,before.target.preservation);assert.deepEqual(row.target.operations,before.target.operations);assert.equal(row.target.connection.credential_fingerprint,before.target.connection.credential_fingerprint);
  if(noAdmission){assert.deepEqual(row.events,[]);assert.deepEqual(row.target,before.target,'Rejected/unrouted callback changed durable state');}
  else{
   assert.equal(row.target.connection.state,'ACTION_REQUIRED');assert.equal(row.target.connection.session_state,'ACTION_REQUIRED');assert.equal(row.target.pendingLifecycle,0);
   const state=row.target.connection.lifecycle,reasons=state.reasonStates.filter(r=>r.blocked).map(r=>r.reason).sort();
   assert.deepEqual(reasons,m.mode==='lifecycle-admission'?['PARTNER_REMOVED']:step.startsWith('tie')?['ACCOUNT_DISABLED','UNRESOLVED_PHONE']:['UNRESOLVED_PHONE']);
   if(step==='partner-batch')assert.equal(state.reasonStates.find(r=>r.reason==='PARTNER_REMOVED').recovery.observedAt,new Date((m.lifecycleTime+1)*1000).toISOString());
   if(step==='tie-recovery')assert.equal(state.reasonStates.find(r=>r.reason==='ACCOUNT_DISABLED').conflict,true);
  }
  proof.push({step,status:response.status,inboxIds:row.events.map(e=>e.id),automaticResume:false});
 }
 return{boundaries:proof,scope:'P02 lifecycle family E; ordinary messages/status operator flows remain P03'};
}
export function assertActivationView(m,v){
 assert.equal(v.connectionId,m.target.connectionId);assert.equal(v.applicable,true);assert.equal(v.providerConfigurationReadback,false);assert.equal(v.conversationPermission,'SEPARATE_REQUIRED');
}
async function runActivation({m,page,request,observe,poll,checkpoint,lease}){
 const path='/api/connections/'+m.target.connectionId+'/meta/activation',before=await observe();assertTarget(m,before.target);assert.equal(before.target.connection.state,'PAUSED');
 const view=await request(path);assertActivationView(m,view);assert.equal(view.operation,null,'Fresh activation case already contains an operation');
 await page.goto(m.origin+'/app?view=connections&connection='+encodeURIComponent(m.target.connectionId),{waitUntil:'domcontentloaded'});
 const section=page.locator('section[aria-labelledby="saved-access-'+m.target.connectionId+'"]');await section.waitFor({state:'visible',timeout:20000});
 const activate=section.locator('button.primary');assert.equal(await activate.count(),1);
 if(m.mode==='activation-held'){
  assert.equal(view.readyToCheck,false);assert.equal(view.contextVersion,null);assert.equal(view.reason,m.activation.expectedReason);assert.equal(await activate.isDisabled(),true);
  assert.deepEqual(await observe(),before);return{reason:view.reason,activationSubmitted:false,connectionState:'PAUSED'};
 }
 assert.equal(view.readyToCheck,true);assert.equal(view.reason,'READY_TO_CHECK');assert(hex.test(view.contextVersion));
 const routing=await request('/api/connections/'+m.target.connectionId+'/meta/routing');
 for(const key of ['sessionId','configurationVersion','reviewVersion'])assert.equal(routing[key],m.activation.routing[key]);
 assert.equal(routing.readiness,'OBSERVED_AWAITING_THREAD');assert.equal(routing.observed?.current,true);assert.equal(routing.observed?.disposition,'REVIEWED');assert.equal(routing.observed?.mode,'SIMULATED');
 assert.equal(routing.providerConfigurationReadback,false);assert.equal(routing.accountFundingProof,'SEPARATE_REQUIRED');
 assert.equal(await activate.isEnabled(),true);await checkpoint({phase:'intent',step:'activation-ui-submit'});
 // Real UI fetch, without interception, response replacement, or response-loss injection.
 await lease();const [accepted]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname===path&&r.request().method()==='POST',{timeout:25000}),activate.click()]);assert.equal(accepted.ok(),true);
 const sent=accepted.request().postDataJSON();assert.deepEqual(sent,{expectedContextVersion:view.contextVersion});assert(accepted.request().headers()['idempotency-key']);
 const after=await poll(()=>request(path),v=>v.operation?.state==='SUCCEEDED');assertActivationView(m,after);assert.equal(after.operation.locallyActivated,true);
 const db=await observe();assertTarget(m,db.target);assert.equal(db.target.connection.state,'WORKING');assert.equal(db.target.connection.session_state,'WORKING');assert.equal(db.target.connection.route_state,'ACTIVE');
 const added=db.target.operations.filter(o=>!before.target.operations.some(p=>p.id===o.id));assert.equal(added.length,1);assert.equal(added[0].id,after.operation.id);assert.equal(added[0].operation_type,'START');assert.equal(added[0].activated,true);assert.equal(added[0].attempts,1);assert.equal(added[0].lease_id,null);
 assert.deepEqual(db.target.preservation,before.target.preservation);assert.equal(db.target.connection.credential_fingerprint,before.target.connection.credential_fingerprint);
 await page.reload({waitUntil:'domcontentloaded'});await section.waitFor({state:'visible',timeout:20000});const final=await request(path);assert.equal(final.operation.id,after.operation.id);assert.equal(final.operation.locallyActivated,true);
 return{operationId:after.operation.id,operationState:'SUCCEEDED',connectionState:'WORKING',uiSubmitted:true,providerConfigurationReadback:false,conversationPermission:'SEPARATE_REQUIRED'};
}
export async function runExtendedJourney(context){
 const {m,effects}=context;validateExtension(m);assert(isExtension(m));assert.equal(typeof context.lease,'function');await context.lease();const before=await effects();
 const proof=await(m.mode==='lifecycle-ordering'?runLifecycle(context):m.mode.startsWith('lifecycle')?runLifecycleBoundary(context):m.mode.startsWith('activation')?runActivation(context):context.uiAccess?context.uiAccess(context):runAccess(context));
 const after=await effects();assert.deepEqual(after,before,'Unexpected accepted send/upload or subscription state change');
 return{...proof,acceptedProviderEffectStateUnchanged:true,providerAttemptLogAvailable:false};
}
// Fixed read-only application-role SQL, serialized into the already admitted API container.
// No caller SQL, admin URL, role elevation, locks, writes, or provider authority injection.
async function fixedDatabaseRead(){
 const {Client}=await import('pg'),{createHash}=await import('node:crypto'),x=JSON.parse(Buffer.from(process.argv[1],'base64'));
 const db=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:7000,options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000'});
 const fingerprint=value=>createHash('sha256').update(String(value)).digest('hex');
 try{
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const role=(await db.query("SELECT rolbypassrls OR rolsuper AS elevated,pg_has_role(current_user,'wasalx_app','MEMBER') AS app FROM pg_roles WHERE rolname=current_user")).rows[0];if(role?.elevated!==false||role.app!==true)throw Error();
  await db.query("SELECT set_config('app.tenant_id',$1,true)",[x.tenantId]);
  const rows=async(sql,args)=>(await db.query(sql,args)).rows;
  const operations=async cid=>(await rows("SELECT to_jsonb(connection_operations) AS full_row,id,operation_type,state,attempts,lease_id,payload ? 'metaAddAccessActivation' AS activation,result->>'pausePreserved'='true' AS pause_preserved,result->>'rotated'='true' AS rotated,result->>'accessAdded'='true' AS access_added,result->>'metaAddAccessActivated'='true' AS activated FROM connection_operations WHERE tenant_id=$1 AND connection_id=$2 ORDER BY created_at,id",[x.tenantId,cid])).map(({full_row,...row})=>({...row,row_sha256:fingerprint(JSON.stringify(full_row))}));
  const target=async cid=>{
   const found=await rows("SELECT c.id,c.name,c.state,c.secret_reference,p.id AS session_id,p.state AS session_state,p.ownership_state,p.opaque_session_id AS phone_id,p.provider_state_data->>'wabaId' AS waba_id,p.provider_state_data->'metaLifecycle' AS lifecycle,p.provider_state_data->'metaRouting' AS routing,r.state AS route_state FROM connections c JOIN provider_sessions p ON p.tenant_id=c.tenant_id AND p.connection_id=c.id AND p.ownership_state='ACTIVE' LEFT JOIN webhook_routes r ON r.tenant_id=c.tenant_id AND r.connection_id=c.id AND r.provider='META' AND r.external_key=p.opaque_session_id WHERE c.tenant_id=$1 AND c.id=$2 AND c.provider='META'",[x.tenantId,cid]);if(found.length!==1)throw Error();
   const connection=found[0];connection.credential_fingerprint=fingerprint(connection.secret_reference);delete connection.secret_reference;
   const preservation={};
   for(const table of ['message_links','case_correlations','delivery_outbox','bot_handoff_jobs']){
    const query=table==='case_correlations'
     ? 'SELECT to_jsonb(t) AS value FROM case_correlations t JOIN group_bindings g ON g.tenant_id=t.tenant_id AND g.id=t.group_binding_id WHERE t.tenant_id=$1 AND g.connection_id=$2 ORDER BY to_jsonb(t)::text LIMIT 1001'
     : table==='bot_handoff_jobs'
      ? "SELECT to_jsonb(t) AS value FROM bot_handoff_jobs t JOIN bot_conversations c ON c.tenant_id=t.tenant_id AND c.id=t.conversation_id WHERE t.tenant_id=$1 AND c.connection_id=$2 AND t.state='SUCCEEDED' ORDER BY to_jsonb(t)::text LIMIT 1001"
      : 'SELECT to_jsonb(t) AS value FROM '+table+' t WHERE tenant_id=$1 AND connection_id=$2 ORDER BY to_jsonb(t)::text LIMIT 1001';
    const values=await rows(query,[x.tenantId,cid]);
    if(values.length>1000)throw Error();preservation[table]={count:values.length,sha256:fingerprint(JSON.stringify(values))};
   }
   const pendingLifecycle=(await rows("SELECT count(*)::int AS n FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND event_type LIKE 'meta.account.lifecycle.%' AND status NOT IN ('PROCESSED','IGNORED')",[x.tenantId,cid]))[0].n;
   const sessionCount=(await rows("SELECT count(*)::int AS n FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE'",[x.tenantId,cid]))[0].n;
   const inbox=await rows("SELECT id,status,lease_id,payload_sha256 FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND event_type LIKE 'meta.account.lifecycle.%' ORDER BY id LIMIT 1001",[x.tenantId,cid]);if(inbox.length>1000)throw Error();
   return{connection,operations:await operations(cid),preservation,pendingLifecycle,sessionCount,inboxSha256:fingerprint(JSON.stringify(inbox))};
  };
  const result={available:(await rows('SELECT app.meta_signup_phone_available($1) AS available',[x.phoneId]))[0].available};
  if(x.targetConnectionId)result.target=await target(x.targetConnectionId);
  if(x.attemptId){
   const found=await rows('SELECT id,purpose,status,reason_code,connection_id,operation_id,exchange_claimed_at IS NOT NULL AS exchange_claimed,credential_stored_at IS NOT NULL AS credential_stored,registration_claimed_at IS NOT NULL AS registration_claimed FROM meta_signup_attempts WHERE tenant_id=$1 AND id=$2 AND requested_by=$3 AND name=$4 AND purpose=$5 AND target_connection_id IS NOT DISTINCT FROM $6::uuid',[x.tenantId,x.attemptId,x.ownerId,x.attemptName,x.purpose,x.targetConnectionId??null]);if(found.length!==1)throw Error();
   result.attempt=found[0];result.operations=[];result.connection=null;
   if(result.attempt.connection_id){const value=await target(result.attempt.connection_id);result.connection=value.connection;result.sessionCount=value.sessionCount;result.operations=value.operations;}
  }
  result.events=x.lifecycleProviderIds?await rows("SELECT id,status,lease_id FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND provider_event_id_sha256 IN (SELECT app.webhook_event_id_sha256($1,$2,'META',value) FROM unnest($3::text[]) value) ORDER BY id",[x.tenantId,x.targetConnectionId,x.lifecycleProviderIds]):[];
  await db.query('ROLLBACK');process.stdout.write(JSON.stringify(result));
 }catch{process.stderr.write('Fixed extension read unavailable');process.exitCode=1;}finally{await db.end();}
}
export const readbackProgram='('+fixedDatabaseRead.toString()+')()';
