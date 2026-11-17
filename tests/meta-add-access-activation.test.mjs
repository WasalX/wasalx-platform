import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {META_ADD_ACCESS_ACTIVATION_REASONS,parseMetaAddAccessActivationRequest} from '../packages/core/dist/meta-add-access-activation-contract.js';
import {englishTenantMessages} from '../lib/i18n/messages/en/tenant.ts';
import {arabicTenantMessages} from '../lib/i18n/messages/ar/tenant.ts';
import {verifyMetaCredentialMetadata} from '../packages/core/dist/meta-account-relation.js';
import {readMetaAddAccessActivation} from '../services/connector-worker/dist/services/connector-worker/src/meta-add-access-activation.js';
import {queueMetaActivation,metaActivationView} from '../services/control-api/dist/meta-add-access-activation.js';

const tenant='71000000-0000-4000-8000-000000000001',connection='72000000-0000-4000-8000-000000000001',session='73000000-0000-4000-8000-000000000001',actor='74000000-0000-4000-8000-000000000001';
const phone='850000000001',account='850000000002',portfolio='850000000003',appId='12025550130',token='synthetic-activation-token',fingerprint=createHash('sha256').update(token).digest('hex');
const secret=`secret://${tenant}/connections/${connection}/meta`,version='a'.repeat(64);
function job(){const proof={schemaVersion:1,claim:'PHONE_ACCOUNT_RELATION_VERIFIED',tenantId:tenant,connectionId:connection,providerSessionId:session,phoneNumberId:phone,wabaId:account,
 secretReference:secret,credentialFingerprint:fingerprint,graphVersion:'v24.0',credentialMetadata:verifyMetaCredentialMetadata({data:{is_valid:true,app_id:appId,scopes:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0}},{appId})};
 return{id:'75000000-0000-4000-8000-000000000001',tenantId:tenant,connectionId:connection,operationType:'START',connectionSecretReference:secret,
  payload:{metaAddAccessActivation:{schemaVersion:1,providerSessionId:session,phoneNumberId:phone,wabaId:account,appId}},
  providerSession:{id:session,opaqueSessionId:phone,providerStateData:{wabaId:account,metaAccountProof:proof,metaSignup:{purpose:'ADD_ACCESS',attemptId:'76000000-0000-4000-8000-000000000001',businessId:portfolio,phoneId:phone,wabaId:account,graphVersion:'v24.0'},metaRouting:{version:3}}}};
}
function adapter(overrides={}){const calls=[];return{calls,async verifyPhoneAccountRelationship(id){calls.push(['relation',id]);},async verifySignupOwner(id,owner){calls.push(['owner',id,owner]);},async signupPhone(){calls.push(['phone']);return{mode:'STANDARD',numberState:'REGISTERED'};},async signupReadiness(){calls.push(['readiness']);return{subscribed:true,messaging:'AVAILABLE'};},...overrides};}

test('activation body is only the current opaque context version',()=>{
 assert.deepEqual(parseMetaAddAccessActivationRequest({expectedContextVersion:version}),{expectedContextVersion:version});
 for(const body of [null,[],{}, {expectedContextVersion:1},{expectedContextVersion:'A'.repeat(64)},{expectedContextVersion:version,payer:'MANAGED'}, {expectedContextVersion:version,phoneNumberId:phone}])assert.throws(()=>parseMetaAddAccessActivationRequest(body));
});
test('every shared activation hold is explained in both portal languages',()=>{
 for(const reason of META_ADD_ACCESS_ACTIVATION_REASONS){const key=`tenant.metaActivation.reason.${reason}`;assert.ok(englishTenantMessages[key],key);assert.ok(arabicTenantMessages[key],key);assert.notEqual(englishTenantMessages[key],arabicTenantMessages[key],key);}
});
test('saved-access receiving uses only reads and preserves exact proof, routing and enrollment bytes',async()=>{
 const input=job(),client=adapter(),before=structuredClone(input);const result=await readMetaAddAccessActivation(input,client,appId,'v24.0',fingerprint);
 assert.deepEqual(client.calls,[['relation',connection],['owner',connection,portfolio],['phone'],['readiness']]);
 assert.equal(result.connectionState,'WORKING');assert.equal(result.webhookState,'ACTIVE');assert.equal(result.providerStateData,input.providerSession.providerStateData);
 assert.deepEqual(input,before);assert.equal(result.result.conversationPermission,'SEPARATE_REQUIRED');assert.equal(result.phoneE164,undefined);assert.equal(result.groups,undefined);
});
test('foreign, changed, unproved and wrong-purpose context is rejected before provider reads',async()=>{
 const changes=[v=>v.operationType='RESTART',v=>v.providerSession.providerStateData.metaSignup.purpose='NEW_NUMBER',v=>v.payload.metaAddAccessActivation.phoneNumberId='999999999',
  v=>v.providerSession.providerStateData.metaAccountProof.credentialFingerprint='b'.repeat(64),v=>delete v.providerSession.providerStateData.metaAccountProof.credentialMetadata,
  v=>v.providerSession.providerStateData.metaAccountProof.tenantId='77000000-0000-4000-8000-000000000001',v=>v.providerSession.providerStateData.metaSignup.graphVersion='v23.0'];
 for(const change of changes){const input=job(),client=adapter();change(input);await assert.rejects(()=>readMetaAddAccessActivation(input,client,appId,'v24.0',fingerprint));assert.equal(client.calls.length,0);}
});
test('unregistered, coexistence, unsubscribed or unknown messaging remains paused without a repair POST',async()=>{
 for(const response of [{mode:'STANDARD',numberState:'REGISTRATION_REQUIRED'},{mode:'COEXISTENCE',numberState:'REGISTERED'},{mode:'UNKNOWN',numberState:'UNKNOWN'}]){
  const client=adapter({async signupPhone(){return response;}});await assert.rejects(()=>readMetaAddAccessActivation(job(),client,appId,'v24.0',fingerprint),e=>e.code==='META_ADD_ACCESS_PHONE_CHANGED');assert.ok(!client.calls.some(c=>c[0]==='readiness'));
 }
 for(const readiness of [{subscribed:false,messaging:'AVAILABLE'},{subscribed:true,messaging:'UNKNOWN'},{subscribed:true,messaging:'BLOCKED'}]){
  const client=adapter({async signupReadiness(){return readiness;}});await assert.rejects(()=>readMetaAddAccessActivation(job(),client,appId,'v24.0',fingerprint),e=>e.code==='META_ADD_ACCESS_PROVIDER_SETUP_REQUIRED');
 }
});
test('an interrupted read does not become a local activation or provider retry',async()=>{
 let calls=0;const client=adapter({async verifySignupOwner(){calls++;throw new Error('synthetic lost GET response');}});
 await assert.rejects(()=>readMetaAddAccessActivation(job(),client,appId,'v24.0',fingerprint),/lost GET/);assert.equal(calls,1);
});

test('public activation view exposes no account, credential or internal admission fields',async()=>{
 const env={META_APP_ID:process.env.META_APP_ID,META_GRAPH_VERSION:process.env.META_GRAPH_VERSION};process.env.META_APP_ID=appId;process.env.META_GRAPH_VERSION='v24.0';
 try{const client={async query(sql){if(sql.includes('meta_add_access_activation_context'))return{rows:[{value:{applicable:true,reason:'FUNDING_REQUIRED',admission:{secretReference:secret,wabaId:account},credentialProof:job().providerSession.providerStateData.metaAccountProof}}]};
  if(sql.includes('FROM connection_operations'))return{rows:[{id:'75000000-0000-4000-8000-000000000001',state:'FAILED_TERMINAL',locally_activated:false}]};throw new Error('Unexpected SQL');}};
 const result=await metaActivationView(client,connection);assert.equal(result.contextVersion,null);assert.equal(result.readyToCheck,false);assert.equal(result.providerConfigurationReadback,false);
 assert.doesNotMatch(JSON.stringify(result),/secret:|wabaId|credential|admission/);
 }finally{for(const[k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
test('current local membership is checked before operation replay, and origin/body before any SQL',async()=>{
 const prior=process.env.PORTAL_PUBLIC_ORIGIN;process.env.PORTAL_PUBLIC_ORIGIN='https://portal.example.invalid';const calls=[];
 const client={async query(sql){calls.push(sql);if(sql.includes('privileged_reauth_minutes'))return{rows:[{privileged_reauth_minutes:15}]};if(sql.includes('meta_add_access_activation_actor'))return{rows:[{current:false}]};throw new Error('Unexpected SQL: '+sql);}};
 const request={id:'synthetic-activation',headers:{origin:process.env.PORTAL_PUBLIC_ORIGIN},principal:{tenantId:tenant,userId:actor,role:'tenant_owner',authenticatedAt:Math.floor(Date.now()/1000),authenticationMethods:['mfa']}};
 try{
  await assert.rejects(()=>queueMetaActivation(client,{...request,headers:{origin:'https://foreign.invalid'}},connection,'key',{expectedContextVersion:version}),/origin/);assert.equal(calls.length,0);
  await assert.rejects(()=>queueMetaActivation(client,request,connection,'key',{expectedContextVersion:version,actorId:actor}),/invalid/);assert.equal(calls.length,0);
  await assert.rejects(()=>queueMetaActivation(client,request,connection,'key',{expectedContextVersion:version}),/current membership/);assert.ok(calls.some(sql=>sql.includes('meta_add_access_activation_actor')));assert.ok(!calls.some(sql=>sql.includes('FROM connection_operations')));
 }finally{if(prior===undefined)delete process.env.PORTAL_PUBLIC_ORIGIN;else process.env.PORTAL_PUBLIC_ORIGIN=prior;}
});
