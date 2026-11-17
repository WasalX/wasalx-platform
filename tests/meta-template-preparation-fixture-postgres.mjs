import {withFixtureTenant} from './meta-routing-fixture.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {ConnectionsController} from '../services/control-api/dist/connections.controller.js';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';
import {metaAccountFundingProof} from '../packages/core/dist/meta-account-policy.js';
import {prepareMetaTemplates} from '../services/connector-worker/dist/services/connector-worker/src/meta-template-preparation.js';
import {createMetaManagedFundingFixture} from './meta-managed-funding-postgres.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
const number=()=>String(BigInt('0x'+randomUUID().replaceAll('-',''))%1000000000000000000000000000n+1n);
export const template=(id,name='preparation_notice')=>({id,name,language:'en_US',status:'APPROVED',category:'UTILITY',parameter_format:'POSITIONAL',
 quality_score:{score:'GREEN'},components:[{type:'BODY',text:'Your request is ready.'}]});

/** Actual app/worker/platform roles and production policy/operation functions.
 * Only ordinary initial connection/session rows and synthetic Graph responses
 * are fixture data. No plan, copy slot, template safety observation or result is
 * inserted by admin. This is local SIMULATED proof, never installed or live. */
export async function createMetaTemplatePreparationFixture(options){
 const base=await createMetaManagedFundingFixture(options),admin=new Client({connectionString:options.adminUrl});
 try{
  await admin.connect();await base.acceptCustomerTariff(null);
  const {tenantId,actorId,connectionId,accountId,providerAccountId,app,worker,platform,tx,operations}=base;
  const appId=process.env.META_APP_ID,request={id:'template-fixture',principal:{tenantId,userId:actorId,role:'tenant_owner',
   authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
  const controller=new ConnectionsController({withTenant:(tenant,fn)=>tx(app,tenant,fn)},{},{wakeConnection:async()=>{}});
  const source=(await tx(app,tenantId,c=>c.query(`SELECT b.*,a.observed_owner_business_id FROM meta_connection_account_bindings b
    JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.state='ACTIVE'`,[tenantId,connectionId]))).rows[0];
  const businessId=source.observed_owner_business_id,targetConnectionId=randomUUID(),targetSessionId=randomUUID(),targetPhoneId=number(),targetProviderId=number();
  const targetToken='synthetic-template-target-token',targetSecret=`secret://${tenantId}/connections/${targetConnectionId}/meta`;
  const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId,connectionId:targetConnectionId,providerSessionId:targetSessionId,
   phoneNumberId:targetPhoneId,wabaId:targetProviderId,secretReference:targetSecret,credentialFingerprint:sha(targetToken),operationId:randomUUID(),
   fencingToken:1,graphVersion:'v24.0',verifiedAt:new Date().toISOString(),responseSha256:sha('synthetic-template-target-membership'),
   credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0,data_access_expires_at:0}},{appId})};
  await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Template target','META','CLOUD_API','PAUSED',$3)",[targetConnectionId,tenantId,targetSecret]);
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'PAUSED',$5,'ACTIVE',$6)",
   [targetSessionId,tenantId,targetConnectionId,targetPhoneId,`meta-cloud://${targetProviderId}/${targetPhoneId}`,{wabaId:targetProviderId,metaAccountProof:proof}]));
  await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','PAUSED')",[tenantId,targetConnectionId,targetPhoneId]));
  const claim=async()=>{const lease=randomUUID(),jobs=await operations.claim(tenantId,lease,1);assert.equal(jobs.length,1);return{job:jobs[0],lease};};
  await controller.requestMetaBillingPolicy(request,targetConnectionId,randomUUID(),{mode:'CUSTOMER',expectedRevision:0});
  let work=await claim();const funding=metaAccountFundingProof(targetProviderId,{id:targetProviderId,owner_business:{id:businessId}},{id:targetProviderId,primary_funding_id:'synthetic-template-target-payment'});
  await operations.completeMetaBillingDiagnostic(work.job,work.lease,appId,funding.diagnostic,funding.funding);
  const targetAccountId=(await tx(app,tenantId,c=>c.query("SELECT account_id FROM meta_connection_account_bindings WHERE tenant_id=$1 AND connection_id=$2 AND state='ACTIVE'",[tenantId,targetConnectionId]))).rows[0].account_id;
  const platformValue=(sql,args)=>tx(platform,tenantId,async c=>(await c.query(sql,args)).rows[0].value);
  const termsText='Synthetic template target payment terms. No live payment agreement.';
  const terms=await platformValue('SELECT app.operator_register_meta_simulated_terms($1,$2,$3) value',[
   {schemaVersion:1,tenantId,accountId:targetAccountId,evidenceMode:'SIMULATED',documentText:termsText,documentSha256:sha(termsText),termsVersion:'SYNTHETIC_TEMPLATE_TARGET_V1'},'synthetic-mfa-operator','template-target-terms']);
  const revision=(await tx(app,tenantId,c=>c.query('SELECT authority_revision FROM meta_messaging_accounts WHERE tenant_id=$1 AND id=$2',[tenantId,targetAccountId]))).rows[0].authority_revision;
  await tx(app,tenantId,c=>c.query('SELECT app.accept_meta_customer_terms($1,$2,$3,$4,$5,$6)',[targetConnectionId,terms.commercialTermsVersionId,null,Number(revision),actorId,'template-target-accept']));
  await controller.requestMetaBillingDiagnostic(request,targetConnectionId,randomUUID(),{});work=await claim();
  await operations.completeMetaBillingDiagnostic(work.job,work.lease,appId,funding.diagnostic,funding.funding);
  const registration=await platformValue('SELECT app.operator_register_meta_simulated_runtime($1,$2,$3) value',[
   {...options.runtimeEvidence,schemaVersion:1,mode:'SIMULATED',tenantId,accountId:targetAccountId,graphVersion:'v24.0',expiresAt:new Date(Date.now()+3600000).toISOString()},'synthetic-mfa-operator','template-runtime']);
  const runtimeCandidate={receiptId:registration.receiptId,descriptor:JSON.parse(registration.descriptorText),descriptorSha256:registration.descriptorSha256};
  const sourceTemplateId=String(BigInt('0x'+randomUUID().replaceAll('-',''))%1000000000000n+1000000000000n),targetTemplateId=String(BigInt('0x'+randomUUID().replaceAll('-',''))%1000000000000n+3000000000000n),sourceTemplates=[template(sourceTemplateId)],targetTemplates=[];
  const traffic=[],store=operations.templatePreparationStore();
  const secrets={resolve:async ref=>{assert.ok([source.secret_reference,targetSecret].includes(ref));return{accessToken:ref===targetSecret?targetToken:'synthetic-managed-account-token'};}};
  const run=async(work,{loseCopyResponse=false,beforeFetch,malformedCopy=false,failedSourceIds=[],incompleteSource=false,afterAcceptedCopy,storeOverride=store}={})=>{
   const prior=globalThis.fetch;
   globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw)),path=url.pathname.replace(/^\/v[0-9]+\.[0-9]+/u,'');assert.equal(url.origin,'https://graph.facebook.com');
    traffic.push({method:init.method,path});if(beforeFetch)await beforeFetch({method:init.method,path,work});
    assert.ok(['Bearer synthetic-managed-account-token',`Bearer ${targetToken}`].includes(init.headers.authorization));
    if(path===`/${providerAccountId}`||path===`/${targetProviderId}`){assert.equal(init.method,'GET');return Response.json({id:path.slice(1),owner_business:{id:businessId}});}
    if(path===`/${businessId}/owned_whatsapp_business_accounts`){assert.equal(init.method,'GET');return Response.json({data:[{id:providerAccountId},{id:targetProviderId}]});}
    if(path===`/${providerAccountId}/message_templates`){assert.equal(init.method,'GET');return Response.json(incompleteSource?{data:sourceTemplates,paging:{cursors:{after:'unchanged'},next:'https://invalid.example/next'}}:{data:sourceTemplates});}
    if(path===`/${targetProviderId}/message_templates`){assert.equal(init.method,'GET');return Response.json({data:targetTemplates});}
    if(path===`/${targetProviderId}/migrate_message_templates`){assert.equal(init.method,'POST');assert.equal(init.headers.authorization,`Bearer ${targetToken}`);
     const selected=work.job.payload.metaTemplatePreparation.selectedSourceIds;
     assert.deepEqual(JSON.parse(init.body),{source_waba_id:providerAccountId,template_ids:selected});
     assert.ok(failedSourceIds.every(id=>selected.includes(id)));
     const slot=(await tx(worker,tenantId,c=>c.query("SELECT outcome FROM meta_provider_effect_checkpoints WHERE tenant_id=$1 AND original_operation_id=$2 AND stage='TEMPLATE_COPY'",[tenantId,work.job.id]))).rows[0];
     assert.equal(slot?.outcome,'ATTEMPTED','Original slot is committed before actual adapter fetch');
     const migrated=[];
     for(const [index,id] of selected.entries())if(!failedSourceIds.includes(id)){
      const sourceItem=sourceTemplates.find(v=>v.id===id);assert.ok(sourceItem);
      const targetId=String(BigInt(targetTemplateId)+BigInt(index));targetTemplates.push({...structuredClone(sourceItem),id:targetId});migrated.push(targetId);
     }
     if(afterAcceptedCopy)await afterAcceptedCopy({work,migrated});
     if(loseCopyResponse)throw new TypeError('Synthetic accepted copy response loss');
     return Response.json(malformedCopy?{migrated_templates:migrated,failed_templates:[]}:
      {migrated_templates:migrated,failed_templates:Object.fromEntries(failedSourceIds.map(id=>[id,'Synthetic copied batch failure']))});
    }
    throw new Error('Unexpected synthetic template request');
   };
   try{await prepareMetaTemplates(work.job,work.lease,appId,storeOverride,secrets,{readTransport:async()=>({transportBindingSha256:options.runtimeEvidence.transportBindingSha256}),readRuntime:async()=>runtimeCandidate});}
   catch(error){await store.failTemplateOperation(work.job,work.lease).catch(()=>{});throw error;}finally{globalThis.fetch=prior;}
  };
  const createBody=async()=>{const page=await controller.templatePreparationPage(request,connectionId);assert.ok(page.prepare);
   assert.ok(page.prepare.targets.some(v=>v.id===targetConnectionId));return{targetConnectionId,expectedAccountRevision:page.prepare.accountRevision,expectedBindingRevision:page.prepare.bindingRevision};};
  const create=async()=>{const result=await controller.createTemplatePreparation(request,connectionId,randomUUID(),await createBody());assert.equal(result.state,'ADMITTED');const work=await claim();assert.equal(work.job.id,result.operationId);await run(work);return result.id;};
  const view=id=>controller.templatePreparationView(request,connectionId,id);
  const action=async(id,kind,choiceIds)=>{const v=await view(id);const body={expectedRevision:v.revision,expectedObservationSha256:v.observationSha256,
    ...(kind==='copy'?{choices:choiceIds??v.choices.filter(c=>c.selectable).map(c=>c.id)}:{})};
   const result=await controller.templateAction(request,connectionId,id,kind,randomUUID(),body),work=await claim();assert.equal(work.job.id,result.operationId);return work;};
  // Ordinary domain fixtures use the incumbent app functions. No observation,
  // checkpoint or readiness result is seeded by this dependency setup.
  const flowDefinition=(name)=>({schemaVersion:1,name:'Template dependency '+randomUUID(),start:'send',maxSteps:4,
   nodes:[{id:'send',type:'send_template',templateName:name,languageCode:'en_US',bodyParameters:[],transcriptText:'Template sent',next:'done'},{id:'done',type:'end'}]});
  const createFlow=async(name)=>tx(app,tenantId,async c=>{
   const definition=flowDefinition(name),family=(await c.query('SELECT app.create_bot_flow_family($1,$2) AS id',[definition.name,actorId])).rows[0].id;
   const version=(await c.query('SELECT * FROM app.create_bot_flow_version($1,$2,NULL,$3)',[family,definition,actorId])).rows[0];
   await c.query('SELECT * FROM app.activate_bot_flow_version($1,$2,NULL,$3)',[version.id,version.revision,actorId]);return{family,...version};
  });
  const nextFlow=async(previous,name)=>tx(app,tenantId,async c=>{
   const version=(await c.query('SELECT * FROM app.create_bot_flow_version($1,$2,$3,$4)',[previous.family,flowDefinition(name),previous.id,actorId])).rows[0];
   await c.query('SELECT * FROM app.activate_bot_flow_version($1,$2,$3,$4)',[version.id,version.revision,previous.id,actorId]);return{family:previous.family,...version};
  });
  const assignFlow=async(version)=>tx(app,tenantId,async c=>(await c.query('SELECT * FROM app.assign_bot_flow($1,$2,$3,$4,$5)',
   [connectionId,version.family,'2',version.id,actorId])).rows[0]);
  const pinConversation=async(assignment,version)=>tx(app,tenantId,async c=>(await c.query(
   "INSERT INTO bot_conversations(tenant_id,assignment_id,connection_id,flow_version_id,external_chat_id,normalized_reference,state,current_node_id,last_activity_at) VALUES($1,$2,$3,$4,$5,$6,'HUMAN','send',clock_timestamp()) RETURNING id",
   [tenantId,assignment.assignment_id,connectionId,version.id,'template-'+randomUUID(),'BOT-'+randomUUID().replaceAll('-','').slice(0,12).toUpperCase()])).rows[0].id);
  const addSourcePhone=async()=>{
   const id=randomUUID(),sessionId=randomUUID(),phone=number(),secretReference=`secret://${tenantId}/connections/${id}/meta`;
   const original=(await tx(app,tenantId,c=>c.query('SELECT provider_state_data FROM provider_sessions WHERE tenant_id=$1 AND id=$2',[tenantId,source.provider_session_id]))).rows[0].provider_state_data;
   const additionalProof={...structuredClone(original.metaAccountProof),connectionId:id,providerSessionId:sessionId,phoneNumberId:phone,secretReference,operationId:randomUUID(),verifiedAt:new Date().toISOString()};
   await admin.query("INSERT INTO connections(id,tenant_id,name,provider,engine,state,secret_reference) VALUES($1,$2,'Additional template scope phone','META','CLOUD_API','PAUSED',$3)",[id,tenantId,secretReference]);
   await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state_data) VALUES($1,$2,$3,$4,'PAUSED',$5,'ACTIVE',$6)",
    [sessionId,tenantId,id,phone,`meta-cloud://${providerAccountId}/${phone}`,{wabaId:providerAccountId,metaAccountProof:additionalProof}]));
   await withFixtureTenant(admin,tenantId,()=>admin.query("INSERT INTO webhook_routes(tenant_id,connection_id,provider,external_key,hmac_secret_reference,state) VALUES($1,$2,'META',$3,'secret://platform/meta-webhook','PAUSED')",[tenantId,id,phone]));
   const accountRevision=Number((await tx(app,tenantId,c=>c.query('SELECT authority_revision FROM meta_messaging_accounts WHERE tenant_id=$1 AND id=$2',[tenantId,accountId]))).rows[0].authority_revision);
   await controller.requestMetaBillingPolicy(request,id,randomUUID(),{mode:'CUSTOMER',expectedRevision:accountRevision});
   const work=await claim(),funding=metaAccountFundingProof(providerAccountId,{id:providerAccountId,owner_business:{id:businessId}},{id:providerAccountId,primary_funding_id:'synthetic-source-payment'});
   await operations.completeMetaBillingDiagnostic(work.job,work.lease,appId,funding.diagnostic,funding.funding);return id;
  };
  return{...base,admin,controller,request,appId,businessId,targetConnectionId,targetSessionId,targetPhoneId,targetProviderId,targetAccountId,
   sourceSessionId:source.provider_session_id,sourceTemplateId,targetTemplateId,sourceTemplates,targetTemplates,traffic,store,runtimeCandidate,claim,run,create,createBody,view,action,createFlow,nextFlow,assignFlow,pinConversation,addSourcePhone,
   close:async()=>{await Promise.allSettled([admin.end(),base.close()]);}};
 }catch(error){await Promise.allSettled([admin.end(),base.close()]);throw error;}
}
