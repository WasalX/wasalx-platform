import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {MetaSignupService} from '../services/control-api/dist/meta-signup.service.js';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {executeMetaLegacyMigration} from '../services/connector-worker/dist/services/connector-worker/src/meta-legacy-migration.js';
import {metaLegacyMigrationRepository} from '../services/connector-worker/dist/services/connector-worker/src/meta-legacy-migration-repository.js';
import {metaLifecyclePayloadSha256} from '../packages/core/dist/meta-account-relation.js';
import {metaAccountFundingProof} from '../packages/core/dist/meta-account-policy.js';
import {createMetaTemplatePreparationFixture} from './meta-template-preparation-fixture-postgres.mjs';
import {identityHttp as createIdentityHttp,seedOrdinaryAnchor} from './meta-account-identity-successor-postgres.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');

/** Actual app/worker/platform functions produce every template review, one-use
 * authorization, registration slot and successor. Only the existing initial
 * ordinary account fixture and Graph/secret boundaries are synthetic. */
export async function createMetaLegacyMigrationFixture(options,{runtimeLifetimeMs=3600000,withIdentity=false}={}){
 const f=await createMetaTemplatePreparationFixture(options);let identityHttp,identityAnchor;
 try{
  const rows=(pool,sql,args=[])=>f.tx(pool,f.tenantId,async c=>(await c.query(sql,args)).rows);
  const source=(await rows(f.app,'SELECT * FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2 AND state=\'ACTIVE\'',[f.tenantId,f.connectionId]))[0];
  // Establish the real signed ordinary identity/native anchor before the B1
  // observation freezes assigned and conversation-pinned flow dependencies.
  if(withIdentity){
   identityHttp=await createIdentityHttp(f,options.appUrl);identityAnchor=await seedOrdinaryAnchor(f,identityHttp);
   // Ordinary fixture setup: retain its pinned native conversation, then let
   // the incumbent assignment function install the template flow below.
   await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("UPDATE bot_assignments SET state='PAUSED',updated_at=now() WHERE tenant_id=$1 AND id=$2",[f.tenantId,identityAnchor.assignment]));
  }
  const flow=await f.createFlow(f.sourceTemplates[0].name),assignment=await f.assignFlow(flow);
  const pinnedFlow=await f.nextFlow(flow,f.sourceTemplates[0].name),conversationId=await f.pinConversation(assignment,flow);
  await withFixtureTenant(f.admin,f.tenantId,async()=>{
   assert.equal((await f.admin.query("UPDATE bot_assignments SET state='PAUSED',updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='ACTIVE'",[f.tenantId,assignment.assignment_id])).rowCount,1);
  });
  await f.assignFlow(pinnedFlow);
  const templatePlanId=await f.create();await f.run(await f.action(templatePlanId,'copy'));
  const templateView=await f.view(templatePlanId);assert.equal(templateView.state,'READY');
  const originalTemplate=(await rows(f.app,'SELECT template_observation FROM meta_account_transitions WHERE id=$1',[templatePlanId]))[0].template_observation;
  const candidate={...options.runtimeEvidence,schemaVersion:1,mode:'SIMULATED',tenantId:f.tenantId,accountId:f.targetAccountId,
   graphVersion:'v24.0',expiresAt:new Date(Date.now()+runtimeLifetimeMs).toISOString(),legacyMigration:{schemaVersion:1,claim:'SYNTHETIC_LEGACY_SAME_PHONE',
    tenantId:f.tenantId,targetAccountId:f.targetAccountId,sourceProviderAccountId:f.providerAccountId,targetProviderAccountId:f.targetProviderId,
    phoneId:f.phoneNumberId,appId:f.appId,graphVersion:'v24.0',fixtureSha256:sha('synthetic-exact-legacy-fixture')}};
  const proofSamples=[{z:1,a:{z:' whitespace : , " \u0627\u0644\u0639\u0631\u0628\u064a\u0629',a:[true,null,0]}},{a:[],z:{}},
   {'10':1,'2':2,fencingToken:1,credentialMetadata:{expiresAt:0,dataAccessExpiresAt:0}}];
  for(const value of proofSamples)
   assert.equal((await rows(f.app,'SELECT app.meta_account_proof_sha256($1::jsonb) AS value',[value]))[0].value,metaLifecyclePayloadSha256(value));
  for(const value of [{unsafe:9007199254740992},{fraction:0.5},{'\u0627':1}])
   assert.equal((await rows(f.app,'SELECT app.meta_account_proof_sha256($1::jsonb) AS value',[value]))[0].value,null);
  const registerRuntime=input=>f.tx(f.platform,f.tenantId,async c=>(await c.query('SELECT app.operator_register_meta_simulated_runtime($1,$2,$3) AS value',[input,'synthetic-mfa-operator','legacy-runtime'])).rows[0].value);
  const descriptorChecks={
   schema:candidate.schemaVersion===1,mode:candidate.mode==='SIMULATED',tenant:candidate.tenantId===f.tenantId,account:candidate.accountId===f.targetAccountId,
   graph:candidate.graphVersion==='v24.0',legacyKeys:Object.keys(candidate.legacyMigration).length===10,
   legacySchema:candidate.legacyMigration.schemaVersion===1,claim:candidate.legacyMigration.claim==='SYNTHETIC_LEGACY_SAME_PHONE',
   legacyTenant:candidate.legacyMigration.tenantId===f.tenantId,legacyTarget:candidate.legacyMigration.targetAccountId===f.targetAccountId,
   legacyGraph:candidate.legacyMigration.graphVersion==='v24.0',fixtureHash:/^[a-f0-9]{64}$/u.test(candidate.legacyMigration.fixtureSha256),
   distinctProvider:candidate.legacyMigration.sourceProviderAccountId!==candidate.legacyMigration.targetProviderAccountId,
   expiryFuture:Date.parse(candidate.expiresAt)>Date.now(),expiryBound:Date.parse(candidate.expiresAt)<=Date.now()+24*60*60*1000};
  for(const field of ['sourceProviderAccountId','targetProviderAccountId','phoneId','appId'])descriptorChecks[field]=typeof candidate.legacyMigration[field]==='string'&&/^[1-9][0-9]{0,31}$/u.test(candidate.legacyMigration[field]);
  const bindingChecks=await withFixtureTenant(f.admin,f.tenantId,async()=>{
   const result=await f.admin.query(`SELECT CASE WHEN a.id=$2 THEN 'source' ELSE 'target' END side,
    jsonb_build_object(
     'bindingActive',b.state='ACTIVE','accountLive',a.state<>'RETIRED','connectionMeta',c.provider='META',
     'connectionState',c.state IN('WORKING','PAUSED'),'connectionSecret',c.secret_reference=b.secret_reference,
     'sessionOwned',s.ownership_state='ACTIVE','sessionState',s.state IN('WORKING','PAUSED'),
     'sessionPhone',s.opaque_session_id=b.phone_number_id,'sessionWaba',s.provider_state_data->>'wabaId'=a.provider_account_id,
     'proofSchema',s.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1',
     'proofClaim',s.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED',
     'proofTenant',s.provider_state_data#>>'{metaAccountProof,tenantId}'=b.tenant_id::text,
     'proofConnection',s.provider_state_data#>>'{metaAccountProof,connectionId}'=b.connection_id::text,
     'proofSession',s.provider_state_data#>>'{metaAccountProof,providerSessionId}'=b.provider_session_id::text,
     'proofPhone',s.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=b.phone_number_id,
     'proofWaba',s.provider_state_data#>>'{metaAccountProof,wabaId}'=a.provider_account_id,
     'proofSecret',s.provider_state_data#>>'{metaAccountProof,secretReference}'=b.secret_reference,
     'proofFingerprint',s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=b.credential_fingerprint,
     'proofHash',encode(public.digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex')=b.proof_sha256,
     'credentialApp',s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=b.app_id,
     'credentialExpiry',CASE WHEN COALESCE(s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}','') ~ '^[0-9]+$' THEN
      (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0 OR (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END,
     'dataExpiry',CASE WHEN COALESCE(s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}','') ~ '^[0-9]+$' THEN
      (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END,
     'candidateProvider',a.provider_account_id=CASE WHEN a.id=$2 THEN $4 ELSE $5 END,
     'candidateApp',b.app_id=$7,'candidatePhone',CASE WHEN a.id=$2 THEN b.phone_number_id=$6 ELSE true END
    ) checks FROM public.meta_connection_account_bindings b
    JOIN public.meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
    LEFT JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
    LEFT JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id AND s.connection_id=c.id
    WHERE b.tenant_id=$1 AND a.id IN($2,$3) ORDER BY side,b.id`,[f.tenantId,f.accountId,f.targetAccountId,f.providerAccountId,f.targetProviderId,f.phoneNumberId,f.appId]);
   return result.rows;
  });
  const diagnostic={descriptorChecks,bindingChecks,sourceCount:bindingChecks.filter(row=>row.side==='source'&&Object.values(row.checks).every(value=>value===true)).length,
   targetCurrent:bindingChecks.some(row=>row.side==='target'&&Object.values(row.checks).every(value=>value===true))};
  assert.equal(Object.values(descriptorChecks).every(value=>value===true)&&diagnostic.sourceCount===1&&diagnostic.targetCurrent,true,
   'Exact simulated legacy binding prerequisites: '+JSON.stringify(diagnostic));
  const runtime=await registerRuntime(candidate),runtimeCandidate={receiptId:runtime.receiptId,descriptor:JSON.parse(runtime.descriptorText),descriptorSha256:runtime.descriptorSha256};
  const createBody={templateObservationOperationId:originalTemplate.observationOperationId,expectedSourceBindingRevision:Number(source.revision),
   expectedTargetBindingRevision:Number((await rows(f.app,"SELECT revision FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2 AND state='ACTIVE'",[f.tenantId,f.targetConnectionId]))[0].revision)};
  const view=id=>f.controller.legacyMigrationView(f.request,f.connectionId,id);
  const create=async(key=randomUUID(),body=createBody)=>f.controller.createLegacyMigration(f.request,f.connectionId,key,body);
  const database={withTenant:(tenant,fn)=>f.tx(f.app,tenant,fn),rows:(tenant,sql,args)=>f.tx(f.app,tenant,async c=>(await c.query(sql,args)).rows)};
  const secretValues=new Map([[source.secret_reference,{accessToken:'synthetic-managed-account-token'}]]),writes=[],calls=[];
  let lostWrite=false,registered=false,providerPosts=0,authorizationValid=true;
  const authorizationToken='synthetic-legacy-authorized-'+randomUUID(),env={META_SIGNUP_ENABLED:'true',META_SIGNUP_CUSTOMER_CONFIG_ID:'12025550160',
   META_APP_ID:f.appId,META_GRAPH_VERSION:'v24.0',META_APP_SECRET_REFERENCE:'secret://platform/meta-webhook',PORTAL_PUBLIC_ORIGIN:'https://portal.example.invalid'};
  const sidecar={ready:async()=>true,storeMetaCredential:async(reference,value)=>{writes.push(reference);secretValues.set(reference,{...value});if(lostWrite&&reference.includes('/connections/'))throw new Error('Synthetic lost authorization PUT');}};
  const credentials={resolveSignupToken:async reference=>{assert.ok(secretValues.has(reference));return secretValues.get(reference).accessToken;},
   inspectSignupConnection:async reference=>secretValues.get(reference)??null};
  const webhookSecrets={resolveHmac:async()=> 'synthetic-legacy-app-secret'};
  const signup=new MetaSignupService(database,sidecar,credentials,webhookSecrets);
  const signupController=new ConnectionsController(database,sidecar,{wakeConnection:async()=>{}},undefined,webhookSecrets,credentials,signup);
  const request={...f.request,headers:{origin:env.PORTAL_PUBLIC_ORIGIN}},store=metaLegacyMigrationRepository((tenant,fn)=>f.tx(f.worker,tenant,fn));
  const invoke=async(callback,{fault,beforeFetch,fundingFault}={})=>{
   const prior=globalThis.fetch,previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
   globalThis.fetch=async(input,init={})=>{
    const url=new URL(String(input)),path=url.pathname.replace(/^\/v[0-9]+\.[0-9]+/u,'');assert.equal(url.origin,'https://graph.facebook.com');
    calls.push({method:init.method,path});if(beforeFetch)await beforeFetch({method:init.method,path});
    if(path==='/oauth/access_token'){assert.equal(init.method,'GET');return Response.json({access_token:authorizationToken});}
    if(path==='/debug_token'){assert.equal(init.method,'GET');return Response.json({data:{app_id:f.appId,is_valid:authorizationValid,expires_at:0,user_id:'444444449',
     scopes:['whatsapp_business_management','whatsapp_business_messaging'],data_access_expires_at:0,granular_scopes:[{scope:'whatsapp_business_management',target_ids:[f.targetProviderId]}]}});}
    assert.ok([`Bearer ${authorizationToken}`,'Bearer synthetic-managed-account-token'].includes(init.headers.authorization));
    if(path===`/${f.phoneNumberId}/register`){
     assert.equal(init.method,'POST');assert.equal(init.headers.authorization,`Bearer ${authorizationToken}`);
     const slots=await rows(f.worker,"SELECT * FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND stage='LEGACY_REGISTER'",[f.tenantId]);
     assert.equal(slots.length,1);assert.equal(slots[0].outcome,'ATTEMPTED','Claim committed before actual fetch');assert.equal(providerPosts,0);
     const body=JSON.parse(init.body);assert.equal(body.messaging_product,'whatsapp');assert.match(body.pin,/^\d{6}$/u);
     assert.ok([...secretValues.values()].some(v=>v.registrationPin===body.pin));providerPosts++;
     if(fault==='reject')return Response.json({error:{code:100,type:'OAuthException',message:'Synthetic rejection'}},{status:400});
     registered=true;if(fault==='disconnect')throw new TypeError('Synthetic accepted disconnect');
     return Response.json(fault==='malformed'?{unexpected:true}:{success:true});
    }
    assert.equal(init.method,'GET');
    if(path===`/${f.targetProviderId}`&&url.searchParams.get('fields')==='primary_funding_id'){
     if(fundingFault==='unavailable')return Response.json({error:{code:10,message:'Synthetic denied read'}},{status:403});
     return Response.json({id:fundingFault==='foreign'?f.providerAccountId:f.targetProviderId,
      primary_funding_id:fundingFault==='changed'?'synthetic-changed-payment':'synthetic-template-target-payment'});
    }
    if([`/${f.providerAccountId}`,`/${f.targetProviderId}`].includes(path))return Response.json({id:path.slice(1),name:'Synthetic legacy account',owner_business:{id:f.businessId,name:'Synthetic portfolio'}});
    if(path===`/${f.businessId}/owned_whatsapp_business_accounts`)return Response.json({data:[{id:f.providerAccountId},{id:f.targetProviderId}]});
    if(path===`/${f.providerAccountId}/message_templates`)return Response.json({data:f.sourceTemplates});
    if(path===`/${f.targetProviderId}/message_templates`)return Response.json({data:f.targetTemplates});
    if(path===`/${f.targetProviderId}/phone_numbers`)return Response.json({data:[{id:f.phoneNumberId,display_phone_number:'12025550161',status:registered?'CONNECTED':'PENDING',account_mode:'LIVE',host_platform:'CLOUD_API',code_verification_status:'VERIFIED'}]});
    if(path===`/${f.targetProviderId}/subscribed_apps`)return Response.json({data:[{whatsapp_business_api_data:{id:f.appId}}]});
    if(path===`/${f.phoneNumberId}`&&url.searchParams.get('fields')==='health_status')return Response.json({id:f.phoneNumberId,health_status:{can_send_message:registered?'AVAILABLE':'BLOCKED',entities:[
     {entity_type:'PHONE_NUMBER',id:f.phoneNumberId,can_send_message:registered?'AVAILABLE':'BLOCKED'},
     {entity_type:'WABA',id:f.targetProviderId,can_send_message:'AVAILABLE'},{entity_type:'APP',id:f.appId,can_send_message:'AVAILABLE'}]}});
    if(path===`/${f.phoneNumberId}`)return Response.json({id:f.phoneNumberId,is_on_biz_app:false,platform_type:'CLOUD_API'});
    assert.fail('Unexpected synthetic legacy route '+path);
   };
   try{return await callback();}finally{globalThis.fetch=prior;for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  };
  const authorize=async(planId,{loseResponse=false}={})=>invoke(async()=>{
   const begun=await signup.start(request,{name:'Authorize reviewed migration',payerMode:'CUSTOMER',idempotencyKey:randomUUID(),targetConnectionId:f.connectionId,targetLegacyMigrationId:planId});
   const choices=await signup.exchange(request,begun.attemptId,{challenge:begun.challenge,code:randomUUID(),expectedRevision:begun.revision});
   assert.equal(choices.purpose,'LEGACY_MIGRATION');assert.equal(choices.choices.length,1);assert.equal(choices.choices[0].selectable,true);
   const body={choiceId:choices.choices[0].choiceId,expectedRevision:choices.revision,selectionRevision:choices.selectionRevision};
   const writesBefore=writes.filter(ref=>ref.includes('/connections/')).length;
   lostWrite=loseResponse;
   if(loseResponse){const lost=await signupController.signupSelect(request,choices.attemptId,body);lostWrite=false;
    assert.equal(lost.status,'SELECTION_REQUIRED');assert(lost.operationId,'Lost PUT preserves the original durable authorization stage');
    assert.equal(writes.filter(ref=>ref.includes('/connections/')).length,writesBefore+1);
    const current=await signup.get(request,choices.attemptId);assert.equal(current.operationId,lost.operationId);
    if(current.status!=='COMPLETED')await signupController.signupSelect(request,current.attemptId,{choiceId:current.choices[0].choiceId,expectedRevision:current.revision,selectionRevision:current.selectionRevision});
   }else await signupController.signupSelect(request,choices.attemptId,body);
   const complete=await signup.get(request,choices.attemptId);assert.equal(complete.status,'COMPLETED');assert.equal(complete.outcome,'MIGRATION_ACCESS_VERIFIED');
   assert.equal(writes.filter(ref=>ref.includes('/connections/')).length,writesBefore+1,'One stable credential/PIN write per one-use authorization');return complete;
  });
  const action=async(id,kind,key=randomUUID())=>{const current=await view(id),body={expectedRevision:current.revision,expectedReviewSha256:current.reviewSha256,...(kind==='register'?{confirmCutover:true}:{})};
   const result=await f.controller.legacyMigrationAction(f.request,f.connectionId,id,kind,key,body),work=await f.claim();assert.equal(work.job.id,result.operationId);return{...work,key,body,result};};
  const run=async(work,opts={})=>{try{return await invoke(()=>executeMetaLegacyMigration(work.job,work.lease,f.appId,opts.storeOverride??store,
   {resolve:async reference=>{assert.ok(secretValues.has(reference));return secretValues.get(reference);}},{readTransport:async()=>({transportBindingSha256:options.runtimeEvidence.transportBindingSha256}),readRuntime:async()=>runtimeCandidate}),opts);
  }catch(error){await store.failOperation(work.job,work.lease).catch(()=>{});throw error;}};
  const shortTargetFunding=async(lifetimeMs=10000)=>{
   // A real admitted diagnostic produces an already-aged same-facts receipt.
   // Only time passes later; neither immutable receipt nor reserved account is edited.
   await f.controller.requestMetaBillingDiagnostic(f.request,f.targetConnectionId,randomUUID(),{});
   const work=await f.claim(),funding=metaAccountFundingProof(f.targetProviderId,
    {id:f.targetProviderId,owner_business:{id:f.businessId}},
    {id:f.targetProviderId,primary_funding_id:'synthetic-template-target-payment'},new Date(Date.now()-15*60_000+lifetimeMs));
   await f.operations.completeMetaBillingDiagnostic(work.job,work.lease,f.appId,funding.diagnostic,funding.funding);
   return funding.funding.expiresAt;
  };
  const duplicateSourceBinding=async()=>{
   // Ordinary unrouted connection fixture only; enrollment and authority still
   // pass through the production app request and actual leased diagnostic.
   const id=randomUUID(),session=randomUUID(),reference=`secret://${f.tenantId}/connections/${id}/meta`;
   const data=(await rows(f.app,'SELECT provider_state_data FROM provider_sessions WHERE id=$1',[source.provider_session_id]))[0].provider_state_data;
   const proof={...data.metaAccountProof,connectionId:id,providerSessionId:session,secretReference:reference,operationId:randomUUID(),verifiedAt:new Date().toISOString()};
   await f.admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Unrouted duplicate fixture','META','CLOUD_API','PAUSED',$3)",[id,f.tenantId,reference]);
   await withFixtureTenant(f.admin,f.tenantId,()=>f.admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'PAUSED',$5,'ACTIVE',$6)",
    [session,f.tenantId,id,f.phoneNumberId,`meta-cloud://${f.providerAccountId}/${f.phoneNumberId}`,{wabaId:f.providerAccountId,metaAccountProof:proof}]));
   const account=(await rows(f.app,'SELECT authority_revision FROM meta_messaging_accounts WHERE id=$1',[f.accountId]))[0];
   await f.controller.requestMetaBillingPolicy(f.request,id,randomUUID(),{mode:'CUSTOMER',expectedRevision:Number(account.authority_revision)});
   const work=await f.claim(),funding=metaAccountFundingProof(f.providerAccountId,{id:f.providerAccountId,owner_business:{id:f.businessId}},{id:f.providerAccountId,primary_funding_id:'synthetic-source-payment'});
   await f.operations.completeMetaBillingDiagnostic(work.job,work.lease,f.appId,funding.diagnostic,funding.funding);return id;
  };
  return{...f,source,flow,pinnedFlow,conversationId,templatePlanId,originalTemplate,rows,candidate,registerRuntime,runtimeCandidate,createBody,
   createLegacy:create,legacyView:view,legacyAction:action,runLegacy:run,legacyStore:store,authorize,signup,signupController,signupRequest:request,invoke,
   secretValues,writes,legacyCalls:calls,duplicateSourceBinding,shortTargetFunding,identityHttp,identityAnchor,
   close:async()=>{try{if(identityHttp)await identityHttp.close();}finally{await f.close();}},
   providerPosts:()=>providerPosts,revokeAuthorization:()=>{authorizationValid=false;}};
 }catch(error){try{if(identityHttp)await identityHttp.close();}finally{await f.close();}throw error;}
}
