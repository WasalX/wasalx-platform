export function validateUploadFault(spec){assert(spec&&Object.keys(spec).sort().join(',')==='id,sha256');assert(/^[A-Za-z0-9_-]{1,80}$/.test(spec.id)&&/^[a-f0-9]{64}$/.test(spec.sha256));}
import assert from 'node:assert/strict';import {createServer} from 'node:https';import {readFileSync,lstatSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,chmodSync} from 'node:fs';import {dirname} from 'node:path';import {createServer as createControl} from 'node:http';import {timingSafeEqual,createHash,randomBytes} from 'node:crypto';import {pathToFileURL} from 'node:url';
export function validateSyntheticMedia(bytes,mime){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=1024*1024,'Synthetic media size rejected');
 assert(['image/png','application/pdf'].includes(mime),'Synthetic media MIME rejected');
 if(mime==='image/png')assert(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Synthetic PNG signature rejected');
 else assert(bytes.length>=5&&bytes.subarray(0,5).toString('ascii')==='%PDF-','Synthetic PDF signature rejected');
 return bytes;
}
export function validateStoredSyntheticMedia(media,index){
 assert(media&&media.id==='SIMMEDIA'+String(index+1),'Synthetic media identity rejected');
 assert(typeof media.base64==='string'&&typeof media.filename==='string'&&media.filename.length>0);
 const bytes=validateSyntheticMedia(Buffer.from(media.base64,'base64'),media.mime);
 assert.equal(bytes.toString('base64'),media.base64);assert.equal(bytes.length,media.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),media.sha256);return media;
}
export const templateInventoryFields='id,name,language,status,category,parameter_format,components,quality_score,message_send_ttl_seconds,is_primary_device_delivery_only,is_sms_fallback_enabled,display_format,sub_category,cta_url_link_tracking_opted_out,degrees_of_freedom_spec';
export const templateResponseModes=['FULL','MIXED','FAILED','DISCONNECT','MALFORMED','REJECT'];
export function createTemplateSimulation(f,base){
 const need=x=>assert(Boolean(x),'Synthetic template fixture rejected');
 const hash=x=>createHash('sha256').update(x).digest('hex');
 const id=x=>typeof x==='string'&&/^[0-9]{1,32}$/u.test(x);
 const keys=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...k].sort().join(',');
 if(f===undefined)return null;
 need(base.stateFile&&base.signupFixture&&!base.transitionFixture&&!base.signupFixture.coexistence&&!base.signupFixture.reauthorizationToken);
 need(keys(f,['purpose','sourceAccountId','targetAccountId','targetPhoneId','targetPhone','targetToken','businessId','source','target','mapping','responseMode']));
 need(f.purpose==='TEMPLATE_PREPARATION'&&f.sourceAccountId===base.wabaId&&f.businessId===base.signupFixture.businessId);
 need([f.sourceAccountId,f.targetAccountId,f.targetPhoneId,f.businessId].every(id)&&new Set([base.phoneId,base.appId,f.sourceAccountId,f.targetAccountId,f.targetPhoneId,f.businessId]).size===6);
 need(typeof f.targetPhone==='string'&&/^[1-9][0-9]{5,14}$/u.test(f.targetPhone)&&f.targetPhone!==base.phone);
 need(typeof f.targetToken==='string'&&f.targetToken.length>=16&&f.targetToken.length<=4096&&!/\s/u.test(f.targetToken)&&![base.token,base.appSecret].includes(f.targetToken));
 need(templateResponseModes.includes(f.responseMode));
 for(const rows of [f.source,f.target])need(Array.isArray(rows)&&rows.length<=2000&&Buffer.byteLength(JSON.stringify(rows))<=4*1024*1024&&rows.every(r=>id(r.id)&&typeof r.name==='string'&&r.name.length<=512&&typeof r.language==='string')&&new Set(rows.map(r=>r.id)).size===rows.length);
 need(f.source.length>=2&&Array.isArray(f.mapping)&&f.mapping.length===f.source.length&&f.mapping.every(r=>keys(r,['sourceId','targetId'])&&f.source.some(s=>s.id===r.sourceId)&&id(r.targetId))&&new Set(f.mapping.map(r=>r.sourceId)).size===f.mapping.length&&new Set(f.mapping.map(r=>r.targetId)).size===f.mapping.length);
 need(!f.mapping.some(r=>f.target.some(t=>t.id===r.targetId)));
 const bindingSha256=hash(JSON.stringify(f));
 let state={bindingSha256,attempts:[],reads:[],completedTarget:false,targetSubscriptions:[]};
 const sameToken=header=>{const a=Buffer.from(header??''),b=Buffer.from('Bearer '+f.targetToken);return a.length===b.length&&timingSafeEqual(a,b);};
 function validateState(x){
  need(keys(x,['bindingSha256','attempts','reads','completedTarget','targetSubscriptions'])&&x.bindingSha256===bindingSha256&&typeof x.completedTarget==='boolean');
  need(Array.isArray(x.targetSubscriptions)&&x.targetSubscriptions.length<=100&&x.targetSubscriptions.every((r,i)=>keys(r,['sequence','at','bodySha256'])&&r.sequence===i+1&&Number.isSafeInteger(r.at)&&r.at>0&&r.bodySha256===hash('{}')));
  need(Array.isArray(x.attempts)&&x.attempts.length<=100&&Array.isArray(x.reads)&&x.reads.length<=4000);
  for(const[a,i]of x.attempts.map((a,i)=>[a,i]))need(keys(a,['sequence','at','bodySha256','sourceIds','accepted','mode'])&&a.sequence===i+1&&Number.isSafeInteger(a.at)&&a.at>0&&/^[a-f0-9]{64}$/u.test(a.bodySha256)&&Array.isArray(a.sourceIds)&&a.sourceIds.length>0&&a.sourceIds.every(v=>f.source.some(s=>s.id===v))&&new Set(a.sourceIds).size===a.sourceIds.length&&typeof a.accepted==='boolean'&&a.mode===(i===0?f.responseMode:'REPLAY_REJECTED'));
  need(x.attempts.filter(a=>a.accepted).length<=1&&x.attempts.every((a,i)=>a.accepted===(i===0&&f.responseMode!=='REJECT')));
  for(const r of x.reads)need(keys(r,['account','offset','at'])&&[f.sourceAccountId,f.targetAccountId].includes(r.account)&&Number.isSafeInteger(r.offset)&&r.offset>=0&&r.offset<=2000&&Number.isSafeInteger(r.at)&&r.at>0);
  need(!x.completedTarget||x.attempts.length>0&&['MIXED','FAILED','DISCONNECT','MALFORMED'].includes(f.responseMode));
 }
 function selected(){return state.attempts[0]?.sourceIds??[];}
 function copied(){const a=state.attempts[0];if(!a?.accepted)return[];if(state.completedTarget||['FULL','DISCONNECT','MALFORMED'].includes(f.responseMode))return selected();if(f.responseMode==='MIXED')return selected().slice(0,1);return[];}
 function target(){return [...f.target,...copied().map(sourceId=>({...f.source.find(r=>r.id===sourceId),id:f.mapping.find(r=>r.sourceId===sourceId).targetId}))];}
 const publicState=()=>({evidenceClass:'simulated-provider-template-preparation',bindingSha256,attempts:structuredClone(state.attempts),reads:structuredClone(state.reads),completedTarget:state.completedTarget,targetSubscriptions:structuredClone(state.targetSubscriptions),sourceSha256:hash(JSON.stringify(f.source)),targetSha256:hash(JSON.stringify(target()))});
 return {
  targetToken:f.targetToken,
  targetTokenMatches:sameToken,
  restore(x){validateState(x);state=structuredClone(x);},snapshot:()=>structuredClone(state),publicState,
  completeTarget(persist){need(!state.completedTarget&&state.attempts.length===1&&['MIXED','FAILED','DISCONNECT','MALFORMED'].includes(f.responseMode));state.completedTarget=true;persist();return publicState();},
  async route(req,res,url,{json,smallJson,persist,now}){
   const prefix='/'+base.version+'/',part=url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length):null;
   const targetCredential=sameToken(req.headers.authorization);
   const reject=()=>{json(400,{error:{code:100,type:'OAuthException',message:'Synthetic template request rejected'}});return true;};
   // Existing manual verification/provisioning only; no invented registration status.
   if(req.method==='GET'&&part===f.targetPhoneId){
    const fields=url.searchParams.get('fields');need(['id','display_phone_number,verified_name','id,display_phone_number,verified_name'].includes(fields)&&[...url.searchParams.keys()].join(',')==='fields');
    const facts={id:f.targetPhoneId,display_phone_number:f.targetPhone,verified_name:'Synthetic template target'};json(200,Object.fromEntries(fields.split(',').map(field=>[field,facts[field]])));return true;
   }
   if(req.method==='GET'&&part===f.targetAccountId+'/phone_numbers'){
    const fields=url.searchParams.get('fields');need(['id','id,display_phone_number'].includes(fields)&&url.searchParams.get('limit')==='100'&&[...url.searchParams.keys()].sort().join(',')==='fields,limit');
    json(200,{data:[{id:f.targetPhoneId,...(fields.includes('display_phone_number')?{display_phone_number:f.targetPhone}:{})}]});return true;
   }
   if(part===f.targetAccountId+'/subscribed_apps'){
    if(req.method==='GET'){need(url.searchParams.get('fields')==='id,whatsapp_business_api_data'&&url.searchParams.get('limit')==='100'&&[...url.searchParams.keys()].sort().join(',')==='fields,limit');json(200,{data:state.targetSubscriptions.length?[{whatsapp_business_api_data:{id:base.appId,name:'Synthetic application'}}]:[]});return true;}
    if(req.method==='POST'){if(!targetCredential)return reject();need(!url.search);const body=await smallJson(req,1024);need(keys(body,[])&&state.targetSubscriptions.length<100);state.targetSubscriptions.push({sequence:state.targetSubscriptions.length+1,at:now(),bodySha256:hash(JSON.stringify(body))});persist();json(200,{success:true});return true;}
    return reject();
   }
   if(req.method==='GET'&&[f.sourceAccountId,f.targetAccountId].includes(part)){
    const fields=url.searchParams.get('fields');need(['id,owner_business{id}','id,name,owner_business{id,name}','id,currency'].includes(fields)&&[...url.searchParams.keys()].join(',')==='fields');
    json(200,fields==='id,currency'?{id:part,currency:'USD'}:{id:part,name:'Synthetic template account',owner_business:{id:f.businessId,name:'Synthetic portfolio'}});return true;
   }
   if(req.method==='GET'&&part===f.businessId+'/owned_whatsapp_business_accounts'){
    need([...url.searchParams.keys()].sort().join(',')==='fields,limit'&&['id','id,name'].includes(url.searchParams.get('fields'))&&url.searchParams.get('limit')==='100');json(200,{data:[{id:f.sourceAccountId,name:'Synthetic source'},{id:f.targetAccountId,name:'Synthetic target'}]});return true;
   }
   if(req.method==='GET'&&[f.sourceAccountId+'/message_templates',f.targetAccountId+'/message_templates'].includes(part)){
    need(url.searchParams.get('fields')===templateInventoryFields&&url.searchParams.get('limit')==='100'&&[...url.searchParams.keys()].every(k=>['fields','limit','after'].includes(k)));
    const after=url.searchParams.get('after');need(after===null||/^(0|[1-9][0-9]{0,3})$/u.test(after));const offset=Number(after??0),account=part.split('/')[0],rows=account===f.sourceAccountId?f.source:target();need(offset<=rows.length&&state.reads.length<4000);
    state.reads.push({account,offset,at:now()});persist();const more=offset+100<rows.length,next=new URL(url);next.searchParams.set('after',String(offset+100));
    json(200,{data:structuredClone(rows.slice(offset,offset+100)),...(more?{paging:{cursors:{after:String(offset+100)},next:next.href}}:{})});return true;
   }
   if(req.method==='POST'&&part===f.targetAccountId+'/migrate_message_templates'){
    if(!targetCredential)return reject();need(!url.search);const body=await smallJson(req,65536);
    need(keys(body,['source_waba_id','template_ids'])&&body.source_waba_id===f.sourceAccountId&&Array.isArray(body.template_ids)&&body.template_ids.length>=1&&body.template_ids.length<=500&&body.template_ids.every(v=>f.source.some(r=>r.id===v))&&new Set(body.template_ids).size===body.template_ids.length&&state.attempts.length<100);
    const original=state.attempts.length===0,accepted=original&&f.responseMode!=='REJECT';
    state.attempts.push({sequence:state.attempts.length+1,at:now(),bodySha256:hash(JSON.stringify(body)),sourceIds:[...body.template_ids],accepted,mode:original?f.responseMode:'REPLAY_REJECTED'});persist();
    if(!accepted)return reject();if(f.responseMode==='DISCONNECT'){res.destroy();return true;}if(f.responseMode==='MALFORMED'){json(200,{migrated_templates:[{unexpected:true}]});return true;}
    const successes=copied();json(200,{migrated_templates:successes.map(id=>f.mapping.find(r=>r.sourceId===id).targetId),failed_templates:Object.fromEntries(selected().filter(id=>!successes.includes(id)).map(id=>[id,'Synthetic rejection']))});return true;
   }
   // The extra credential grants only this fixture's account/inventory/copy paths.
   if(targetCredential)return reject();return false;
  }
 };
}

/** Default-off transport fixture. It grants no application eligibility: the
 * protected installed-runtime registrar must bind the actual enrolled assets. */
export function createLegacyMigrationSimulation(f,base){
 if(f===undefined)return null;
 const need=x=>assert(Boolean(x),'Synthetic legacy migration fixture rejected');
 const keys=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...k].sort().join(',');
 const hash=x=>createHash('sha256').update(x).digest('hex');
 need(keys(f,['schemaVersion','claim','sourceProviderAccountId','targetProviderAccountId','phoneId','appId','graphVersion']));
 need(f.schemaVersion===1&&f.claim==='SYNTHETIC_LEGACY_SAME_PHONE'&&base.stateFile&&base.signupFixture&&base.templates);
 need(!base.signupFixture.coexistence&&!base.signupFixture.reauthorizationToken);
 need(f.graphVersion==='v24.0'&&f.graphVersion===base.version&&f.phoneId===base.phoneId&&f.appId===base.appId);
 need(f.sourceProviderAccountId===base.wabaId&&f.sourceProviderAccountId===base.templateFixture.sourceAccountId&&f.targetProviderAccountId===base.templateFixture.targetAccountId);
 need([f.sourceProviderAccountId,f.targetProviderAccountId,f.phoneId,f.appId].every(v=>typeof v==='string'&&/^[1-9][0-9]{0,31}$/u.test(v))&&new Set([f.sourceProviderAccountId,f.targetProviderAccountId,f.phoneId,f.appId]).size===4);
 const bindingSha256=hash(JSON.stringify(f));
 const modes=['ACCEPT','DISCONNECT','MALFORMED','REJECT'];
 let state={bindingSha256,attempts:[],armedMode:null};
 const migrated=()=>state.attempts[0]?.accepted===true;
 const ready=()=>Boolean(base.sourceState()?.registration&&base.sourceSubscribed()&&base.templates.snapshot().targetSubscriptions.length);
 const publicState=()=>({evidenceClass:'simulated-provider-legacy-migration',claim:f.claim,sourceAccountId:f.sourceProviderAccountId,targetAccountId:f.targetProviderAccountId,phoneId:f.phoneId,migrated:migrated(),attempts:structuredClone(state.attempts),armedMode:state.armedMode});
 const phoneFacts=(id,display,registered)=>({id,display_phone_number:display,verified_name:'Synthetic migration account',status:registered?'CONNECTED':'PENDING',code_verification_status:'VERIFIED',account_mode:'LIVE',host_platform:'CLOUD_API'});
 const project=(value,fields)=>Object.fromEntries(fields.split(',').map(field=>[field,value[field]]));
 return{
  migrated,ready,publicState,snapshot:()=>structuredClone(state),
  restore(x){need(keys(x,['bindingSha256','attempts','armedMode'])&&x.bindingSha256===bindingSha256&&Array.isArray(x.attempts)&&x.attempts.length<=100&&(x.armedMode===null||modes.includes(x.armedMode)));
   need(x.attempts.every((a,i)=>keys(a,['sequence','at','bodySha256','accepted','mode'])&&a.sequence===i+1&&Number.isSafeInteger(a.at)&&a.at>0&&/^[a-f0-9]{64}$/u.test(a.bodySha256)&&typeof a.accepted==='boolean'&&(i===0?modes.includes(a.mode):a.mode==='REPLAY_REJECTED')&&a.accepted===(i===0&&a.mode!=='REJECT')));
   need(x.attempts.length===0||x.armedMode===null);state=structuredClone(x);},
  arm(mode,persist){need(modes.includes(mode)&&state.armedMode===null&&state.attempts.length===0);state.armedMode=mode;persist();return{armed:true,mode};},
  permitsSharedPath(req,url){const part=url.pathname.slice(('/'+base.version+'/').length);return migrated()&&base.templates.targetTokenMatches(req.headers.authorization)&&[base.phoneId+'/messages',base.phoneId+'/thread_control',base.phoneId+'/media'].includes(part);},
  async route(req,res,url,{json,smallJson,persist,now}){
   const prefix='/'+base.version+'/',part=url.pathname.startsWith(prefix)?url.pathname.slice(prefix.length):null,target=base.templates.targetTokenMatches(req.headers.authorization);
   const reject=()=>{json(400,{error:{code:100,type:'OAuthException',message:'Synthetic migration request rejected'}});return true;};
   const exact=(fields,list=false)=>{need(url.searchParams.get('fields')===fields&&[...url.searchParams.keys()].sort().join(',')===(list?'fields,limit':'fields')&&(!list||url.searchParams.get('limit')==='100'));};
   if(req.method==='GET'&&part===base.signupFixture.userId+'/assigned_whatsapp_business_accounts'&&target){exact('id,name',true);json(200,{data:[{id:f.targetProviderAccountId,name:'Synthetic migration target'}]});return true;}
   if(req.method==='GET'&&[f.sourceProviderAccountId,f.targetProviderAccountId].includes(part)&&url.searchParams.get('fields')==='primary_funding_id'){
    exact('primary_funding_id');json(200,{id:part,primary_funding_id:'SIM_CUSTOMER_'+part});return true;
   }
   if(req.method==='GET'&&[f.sourceProviderAccountId+'/phone_numbers',f.targetProviderAccountId+'/phone_numbers'].includes(part)){
    const fields=url.searchParams.get('fields');need(['id','id,display_phone_number','id,status','id,status,code_verification_status,account_mode,host_platform','id,display_phone_number,verified_name,status,code_verification_status,account_mode,host_platform'].includes(fields));exact(fields,true);
    const destination=part===f.targetProviderAccountId+'/phone_numbers';
    const rows=destination?[phoneFacts(base.templateFixture.targetPhoneId,base.templateFixture.targetPhone,true),...(ready()?[phoneFacts(f.phoneId,base.phone,migrated())]:[])]:migrated()?[]:[phoneFacts(f.phoneId,base.phone,Boolean(base.sourceState()?.registration))];
    json(200,{data:rows.map(row=>project(row,fields))});return true;
   }
   if(req.method==='GET'&&target&&[f.phoneId,base.templateFixture.targetPhoneId].includes(part)){
    const fields=url.searchParams.get('fields');exact(fields);const setup=part===base.templateFixture.targetPhoneId;
    if(!setup&&!ready())return reject();
    const available=setup||migrated();
    if(fields==='id,is_on_biz_app,platform_type'){json(200,{id:part,is_on_biz_app:false,platform_type:'CLOUD_API'});return true;}
    if(fields==='health_status'){const status=available?'AVAILABLE':'BLOCKED';json(200,{id:part,health_status:{can_send_message:status,entities:[{entity_type:'PHONE_NUMBER',id:part,can_send_message:status},{entity_type:'WABA',id:f.targetProviderAccountId,can_send_message:'AVAILABLE'},{entity_type:'APP',id:f.appId,can_send_message:'AVAILABLE'}]}});return true;}
    need(['id','display_phone_number,verified_name','id,display_phone_number,verified_name'].includes(fields));json(200,project(phoneFacts(part,setup?base.templateFixture.targetPhone:base.phone,available),fields));return true;
   }
   if(req.method==='POST'&&part===f.phoneId+'/register'&&target){
    if(!ready())return reject();need(!url.search);const body=await smallJson(req);
    need(keys(body,['messaging_product','pin'])&&body.messaging_product==='whatsapp'&&typeof body.pin==='string'&&/^\d{6}$/u.test(body.pin)&&state.attempts.length<100);
    const original=state.attempts.length===0,mode=original?(state.armedMode??'ACCEPT'):'REPLAY_REJECTED';
    state.attempts.push({sequence:state.attempts.length+1,at:now(),bodySha256:hash(JSON.stringify(body)),accepted:original&&mode!=='REJECT',mode});state.armedMode=null;persist();
    if(!original||mode==='REJECT')return reject();if(mode==='DISCONNECT'){res.destroy();return true;}json(200,mode==='MALFORMED'?{unrecognized:true}:{success:true});return true;
   }
   if(migrated()&&!target&&req.method!=='GET'&&part?.startsWith(f.phoneId+'/'))return reject();
   return false;
  }
 };
}

// Synthetic Graph boundary: no outbound network, no implicit status/webhook delivery.
// Signup opt-in models current Embedded Signup/registration requests plus the pinned v24
// account/phone fields. Direct mode fields come from the newer coexistence guide: this
// fixture advertises them explicitly; it is not proof of their availability on live v24.
// https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider/
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration/
export function createMetaSimulation({token,phoneId,phone,version,recipients,key,cert,stateFile,groupsFixture="unsupported",wabaId,appId,appSecret,financialFixture,signupFixture,routingFixture,transitionFixture,templatePreparationFixture,legacyMigrationFixture,signupClock=Date.now}){
 assert(token?.length>=16&&/^\d+$/.test(phoneId)&&/^\d+$/.test(phone)&&/^v\d+\.\d+$/.test(version));assert(recipients.length>0&&recipients.every(x=>/^\d+$/.test(x)||/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(x)));assert(["unsupported","eligible-empty","permission-denied","rate-limited"].includes(groupsFixture));assert(wabaId===undefined||/^\d+$/.test(wabaId));const receipts=[],mediaObjects=[];const financialEvents=[];let financialState=financialFixture?{attached:false,revoked:false}:undefined;
 if(financialFixture){assert(wabaId);assert(Object.keys(financialFixture).sort().join(',')==='allocationConfigId,creditLineId,currency,holderBusinessId,receivingBusinessId,receivingCredential');assert([financialFixture.holderBusinessId,financialFixture.creditLineId,financialFixture.receivingBusinessId,financialFixture.allocationConfigId].every(id=>/^\d{1,32}$/.test(id)));assert(['AUD','EUR','GBP','IDR','INR','USD'].includes(financialFixture.currency));assert(/^[A-Za-z0-9._:-]{1,128}$/.test(financialFixture.receivingCredential));assert(new Set([phoneId,wabaId,financialFixture.holderBusinessId,financialFixture.creditLineId,financialFixture.receivingBusinessId,financialFixture.allocationConfigId]).size===6);}let subscribed=false;let armedFault=null;let armedUploadFault=null;const uploadFaultEvents=[];const faultEvents=[];let failed=false;
 // P09 is a default-off, source-pinned currency-clone fixture. It does not
 // create application authority, replay slots or infer legal payer ownership.
 const transitionId=id=>typeof id==='string'&&/^[0-9]{1,32}$/.test(id);
 const transitionKeys=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
 if(transitionFixture!==undefined){
  assert(signupFixture&&stateFile&&!signupFixture.coexistence&&!signupFixture.reauthorizationToken&&!templatePreparationFixture&&!legacyMigrationFixture);
  const f=transitionFixture;
  assert(transitionKeys(f,['migrationId','targetAccountId','sourceCurrency','targetCurrency','sourceFundingId','targetFundingId','renewalToken',...(Object.hasOwn(f,'managed')?['managed']:[]),...(Object.hasOwn(f,'templateInventories')?['templateInventories']:[])]));
  assert(typeof f.migrationId==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(f.migrationId)&&!/^\d+$/.test(f.migrationId));
  assert(transitionId(f.targetAccountId)&&new Set([phoneId,wabaId,appId,signupFixture.businessId,signupFixture.userId,f.targetAccountId]).size===6);
  assert([f.sourceCurrency,f.targetCurrency].every(c=>['AUD','EUR','GBP','IDR','INR','USD'].includes(c))&&f.sourceCurrency!==f.targetCurrency);
  assert([f.sourceFundingId,f.targetFundingId].every(id=>typeof id==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(id)));
  assert(typeof f.renewalToken==='string'&&f.renewalToken.length>=16&&f.renewalToken.length<=4096&&!/\s/.test(f.renewalToken)&&f.renewalToken!==token&&f.renewalToken!==appSecret);
  if(f.templateInventories){assert(transitionKeys(f.templateInventories,['source','target']));for(const rows of Object.values(f.templateInventories))assert(Array.isArray(rows)&&rows.length<=2000&&Buffer.byteLength(JSON.stringify(rows))<=4194304);}
  if(f.managed){const a=f.managed;
   assert(transitionKeys(a,['financialToken','holderBusinessId','creditLineId','receivingBusinessId','allocationId']));
   assert(financialFixture&&a.holderBusinessId===financialFixture.holderBusinessId&&a.creditLineId===financialFixture.creditLineId&&a.receivingBusinessId===financialFixture.receivingBusinessId&&a.allocationId!==financialFixture.allocationConfigId&&f.sourceFundingId===financialFixture.receivingCredential&&f.sourceCurrency===financialFixture.currency);
   assert([a.holderBusinessId,a.creditLineId,a.receivingBusinessId,a.allocationId].every(transitionId));
   assert(a.receivingBusinessId===signupFixture.businessId&&new Set([phoneId,wabaId,f.targetAccountId,a.holderBusinessId,a.creditLineId,a.receivingBusinessId,a.allocationId]).size===7);
   assert(typeof a.financialToken==='string'&&a.financialToken.length>=16&&a.financialToken.length<=4096&&!/\s/.test(a.financialToken)&&![token,f.renewalToken,appSecret].includes(a.financialToken));
  }
 }
 const templates=createTemplateSimulation(templatePreparationFixture,{token,phoneId,phone,version,wabaId,appId,appSecret,stateFile,signupFixture});
 const legacy=createLegacyMigrationSimulation(legacyMigrationFixture,{phoneId,phone,version,wabaId,appId,stateFile,signupFixture,templates,templateFixture:templatePreparationFixture,sourceState:()=>signup,sourceSubscribed:()=>subscribed});
 const routingRoles=['ai_agent','ctwa','customer_service','escalation','marketing','utility'];
 const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
 if(routingFixture!==undefined){
  assert(exact(routingFixture,['roles','targets'])&&stateFile,'Routing requires a private durable fixture');
  for(const field of ['roles','targets'])assert(Array.isArray(routingFixture[field])&&routingFixture[field].length<=6&&new Set(routingFixture[field]).size===routingFixture[field].length&&routingFixture[field].every(v=>routingRoles.includes(v)));
  assert(routingFixture.roles.length>0);
 }
 const routingBody=body=>{
  assert(body&&typeof body==='object'&&!Array.isArray(body));
  const keys=['messaging_product','action',...(Object.hasOwn(body,'to')?['to']:[]),...(Object.hasOwn(body,'recipient')?['recipient']:[]),...(Object.hasOwn(body,'metadata')?['metadata']:[]),...(Object.hasOwn(body,'control_pass')?['control_pass']:[])];
  assert(exact(body,keys)&&body.messaging_product==='whatsapp'&&['take','pass','release'].includes(body.action));
  assert(Object.hasOwn(body,'to')!==Object.hasOwn(body,'recipient'));
  const peer=body.to??body.recipient;assert(typeof peer==='string'&&recipients.includes(peer));
  assert(Object.hasOwn(body,'to')?/^[1-9][0-9]{2,14}$/.test(peer):/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(peer));
  assert(body.metadata===undefined||(typeof body.metadata==='string'&&body.metadata.length<=2000));
  if(body.control_pass!==undefined)assert(body.action==='pass'&&exact(body.control_pass,['target_role'])&&routingRoles.includes(body.control_pass.target_role));
  return peer;
 };
 const routingFault=spec=>{assert(exact(spec,['id','action','recipient','mode'])&&typeof spec.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(spec.id)&&['take','pass','release'].includes(spec.action)&&recipients.includes(spec.recipient)&&['reject','malformed-rejection','disconnect-after-acceptance'].includes(spec.mode));};
 const routingHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 let routing=routingFixture?{fixture:structuredClone(routingFixture),attempts:[],receipts:[],armedFault:null,faultEvents:[],owners:Object.fromEntries(recipients.map(peer=>[peer,'OWN']))}:undefined;
 const validateRouting=value=>{
  assert(routingFixture&&exact(value,['fixture','attempts','receipts','armedFault','faultEvents','owners']));
  assert.deepEqual(value.fixture,routingFixture);assert.deepEqual(Object.keys(value.owners).sort(),[...recipients].sort());
  assert(Object.values(value.owners).every(v=>['OWN','STANDBY','IDLE'].includes(v)));
  assert(Array.isArray(value.attempts)&&Array.isArray(value.receipts)&&Array.isArray(value.faultEvents));
  assert(value.attempts.length<=1000&&value.receipts.length<=1000&&value.faultEvents.length<=1000);
  for(const [i,a] of value.attempts.entries()){
   assert(exact(a,['sequence','body','bodySha256','outcome','requestId'])&&a.sequence===i+1);
   routingBody(a.body);assert(a.bodySha256===routingHash(a.body)&&['ACCEPTED','REJECTED','MALFORMED_REJECTION'].includes(a.outcome));
   assert(a.outcome==='ACCEPTED'?typeof a.requestId==='string':a.requestId===null);
  }
  for(const [i,r] of value.receipts.entries()){
   assert(exact(r,['requestId','sequence','body','bodySha256','state'])&&r.sequence===i+1&&r.requestId==='SIMTHREAD-'+String(i+1).padStart(8,'0'));
   routingBody(r.body);assert(r.bodySha256===routingHash(r.body)&&r.state===({take:'OWN',pass:'STANDBY',release:'IDLE'})[r.body.action]);
   assert.equal(value.attempts.filter(a=>a.requestId===r.requestId&&a.outcome==='ACCEPTED'&&a.bodySha256===r.bodySha256).length,1);
  }
  assert.equal(value.attempts.filter(a=>a.outcome==='ACCEPTED').length,value.receipts.length);
  for(const f of value.faultEvents){routingFault(f.spec);assert(exact(f,['spec','attempt'])&&Number.isSafeInteger(f.attempt)&&f.attempt>0&&f.attempt<=value.attempts.length);
   const a=value.attempts[f.attempt-1];assert(a.body.action===f.spec.action&&(a.body.to??a.body.recipient)===f.spec.recipient&&a.outcome===({reject:'REJECTED','malformed-rejection':'MALFORMED_REJECTION','disconnect-after-acceptance':'ACCEPTED'})[f.spec.mode]);}
  assert.equal(new Set(value.faultEvents.map(f=>f.spec.id)).size,value.faultEvents.length);
  if(value.armedFault!==null){routingFault(value.armedFault);assert(!value.faultEvents.some(f=>f.spec.id===value.armedFault.id));}
  for(const peer of recipients){const last=value.receipts.filter(r=>(r.body.to??r.body.recipient)===peer).at(-1);assert.equal(value.owners[peer],last?.state??'OWN');}
 };

 const hash=value=>createHash('sha256').update(value).digest('hex');
 const timestamp=()=>{const value=signupClock();assert(Number.isSafeInteger(value)&&value>=0);return value;};
 const validTime=value=>Number.isSafeInteger(value)&&value>=0;
 const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 let signup;const pendingSync=new Map();
  const coex=signupFixture?.coexistence;
  if(Object.hasOwn(signupFixture??{},'coexistence'))assert(coex&&typeof coex==='object'&&!Array.isArray(coex));
 if(coex){assert(Object.keys(coex).sort().join(',')==='contacts,history,onboardedAt');assert(Number.isSafeInteger(coex.onboardedAt)&&coex.onboardedAt>0);
  assert(['ACCEPT','REJECT','DISCONNECT','HOLD'].includes(coex.contacts)&&['ACCEPT','REJECT','DISCONNECT','HOLD'].includes(coex.history));}
 const reauthorizationToken=signupFixture?.reauthorizationToken;
 if(signupFixture!==undefined){
  assert(signupFixture&&Object.keys(signupFixture).every(key=>['businessId','userId','reauthorizationToken','coexistence'].includes(key)));
  if(Object.hasOwn(signupFixture,'reauthorizationToken'))assert(typeof reauthorizationToken==='string'&&reauthorizationToken.length>=16&&reauthorizationToken.length<=4096&&reauthorizationToken!==token&&!/\s/.test(reauthorizationToken));
  assert([signupFixture.businessId,signupFixture.userId,wabaId,appId,phoneId].every(id=>typeof id==='string'&&/^\d{5,32}$/.test(id)));
  assert(new Set([signupFixture.businessId,signupFixture.userId,wabaId,appId,phoneId]).size===5);
  assert(typeof token==='string'&&typeof appSecret==='string'&&appSecret.length>=16&&typeof stateFile==='string'&&stateFile.length>0&&typeof signupClock==='function');
  signup={binding:{businessId:signupFixture.businessId,userId:signupFixture.userId,wabaId,appId,phoneId,phone,version,...(reauthorizationToken?{reauthorization:true}:{}),...(coex?{coexistence:coex}:{}),credentialSha256:hash(JSON.stringify(reauthorizationToken?[token,appSecret,reauthorizationToken]:[token,appSecret]))},
   code:null,exchangeReceipts:[],registration:null,registrationAttempts:0,armedFault:null,faultEvents:[],...(coex?{sync:{attempts:[],requests:{contacts:null,history:null}}}:{})};
 }
 const validateSignupState=value=>{
  assert(signup&&value&&Object.keys(value).sort().join(',')==='armedFault,binding,code,exchangeReceipts,faultEvents,registration,registrationAttempts'+(coex?',sync':''));
  assert.deepEqual(value.binding,signup.binding);
  assert(Array.isArray(value.exchangeReceipts)&&Array.isArray(value.faultEvents));
  assert(value.exchangeReceipts.every((item,index)=>Object.keys(item).sort().join(',')==='acceptedAt,codeSha256,sequence'&&item.sequence===index+1&&validHash(item.codeSha256)&&validTime(item.acceptedAt)));
  assert(new Set(value.exchangeReceipts.map(item=>item.codeSha256)).size===value.exchangeReceipts.length);
  assert(value.code!==null||value.exchangeReceipts.length===0);
  if(value.code!==null){
   const code=value.code;assert(Object.keys(code).sort().join(',')===(coex||transitionFixture?'consumedAt,expiresAt,issuedAt,renewal,sha256':legacy?'consumedAt,expiresAt,issuedAt,legacyMigration,sha256':'consumedAt,expiresAt,issuedAt,sha256')&&validHash(code.sha256)&&validTime(code.issuedAt)&&validTime(code.expiresAt)&&code.expiresAt===code.issuedAt+30_000);
   assert(code.consumedAt===null||(validTime(code.consumedAt)&&code.consumedAt>=code.issuedAt&&code.consumedAt<code.expiresAt));
   if(coex||transitionFixture)assert(typeof code.renewal==='boolean'&&(!code.renewal||reauthorizationToken||transitionFixture));if(legacy)assert(typeof code.legacyMigration==='boolean');
    const receipt=value.exchangeReceipts.find(item=>item.codeSha256===code.sha256);
   assert(code.consumedAt===null?!receipt:receipt?.acceptedAt===code.consumedAt);
  }
  assert(Number.isSafeInteger(value.registrationAttempts)&&value.registrationAttempts>=0);
  assert(value.registration===null||(Object.keys(value.registration).sort().join(',')==='acceptedAt,pinSha256'&&validHash(value.registration.pinSha256)&&validTime(value.registration.acceptedAt)&&value.registrationAttempts>0));
  assert(value.registration!==null||value.registrationAttempts===0||coex);
  if(coex){assert.equal(value.registration,null);const sync=value.sync;
   assert(sync&&Object.keys(sync).sort().join(',')==='attempts,requests'&&Array.isArray(sync.attempts));
   assert.deepEqual(Object.keys(sync.requests).sort(),['contacts','history']);
   assert(sync.attempts.length<=100&&sync.attempts.every((a,i)=>a&&Object.keys(a).sort().join(',')==='at,bodySha256,kind,sequence'&&a.sequence===i+1&&['contacts','history'].includes(a.kind)&&validTime(a.at)&&validHash(a.bodySha256)));
   for(const kind of ['contacts','history']){const r=sync.requests[kind];if(r===null)continue;
    assert(r&&Object.keys(r).sort().join(',')==='acceptedAt,attemptSequence,bodySha256,outcome,requestId');
    assert.equal(r.requestId,'SIMSYNC-'+kind);assert(validTime(r.acceptedAt)&&validHash(r.bodySha256)&&['ACCEPT','DISCONNECT','HOLD','RELEASED'].includes(r.outcome));
    const a=sync.attempts[r.attemptSequence-1];assert(a?.kind===kind&&a.at===r.acceptedAt&&a.bodySha256===r.bodySha256);
   }
  }
  const faultValid=fault=>fault&&/^[A-Za-z0-9_-]{1,80}$/.test(fault.id)&&['exchange','register'].includes(fault.phase)
   &&(fault.phase==='exchange'?validHash(fault.codeSha256):fault.codeSha256===undefined);
  const faultKeys=fault=>fault.phase==='exchange'?'codeSha256,id,phase':'id,phase';
  assert(value.armedFault===null||(faultValid(value.armedFault)&&Object.keys(value.armedFault).sort().join(',')===faultKeys(value.armedFault)));
  assert(value.faultEvents.every(item=>faultValid(item)&&Object.keys(item).sort().join(',')===(item.phase==='exchange'?'acceptedAt,codeSha256,id,outcome,phase':'acceptedAt,id,outcome,phase')&&item.outcome==='ACCEPTED_DISCONNECTED'&&validTime(item.acceptedAt)
   &&(item.phase==='exchange'?value.exchangeReceipts.some(receipt=>receipt.codeSha256===item.codeSha256&&receipt.acceptedAt===item.acceptedAt):value.registration?.acceptedAt===item.acceptedAt)));
  assert(new Set(value.faultEvents.map(item=>item.id)).size===value.faultEvents.length);
  assert(value.faultEvents.filter(item=>item.phase==='register').length<=1);
  assert(!value.armedFault||!value.faultEvents.some(item=>item.id===value.armedFault.id));
  if(value.armedFault?.phase==='exchange')assert(value.code?.sha256===value.armedFault.codeSha256&&value.code.consumedAt===null);
  if(value.armedFault?.phase==='register')assert(value.registration===null);
 };
 const transitionHash=value=>hash(JSON.stringify(value));
 const transitionBinding=transitionFixture?{
  sourceAccountId:wabaId,targetAccountId:transitionFixture.targetAccountId,migrationId:transitionFixture.migrationId,
  phoneId,phone,appId,businessId:signupFixture.businessId,userId:signupFixture.userId,version,
  sourceCurrency:transitionFixture.sourceCurrency,targetCurrency:transitionFixture.targetCurrency,
  sourceFundingId:transitionFixture.sourceFundingId,targetFundingId:transitionFixture.targetFundingId,
  templateInventorySha256:transitionFixture.templateInventories?transitionHash(transitionFixture.templateInventories):null,
  credentialSha256:transitionHash([token,appSecret,transitionFixture.renewalToken,transitionFixture.managed?.financialToken??null]),
  ...(transitionFixture.managed?{managed:Object.fromEntries(Object.entries(transitionFixture.managed).filter(([k])=>k!=='financialToken'))}:{})
 }:undefined;
 let transition=transitionFixture?{binding:transitionBinding,attempts:[],reads:[],initiate:null,complete:null,originalRevokedAt:null,armedFault:null,faultEvents:[]}:undefined;
 const transitionFault=spec=>{
  assert(transitionKeys(spec,['id','stage','mode'])&&/^[A-Za-z0-9_-]{1,80}$/.test(spec.id));
  assert(['INITIATE','COMPLETE'].includes(spec.stage)&&['MALFORMED_WITH_ID','DISCONNECT_NO_LOCATOR','REJECT'].includes(spec.mode));
 };
 const validateTransition=value=>{
  assert(transitionFixture&&transitionKeys(value,['binding','attempts','reads','initiate','complete','originalRevokedAt','armedFault','faultEvents']));
  assert.deepEqual(value.binding,transitionBinding);
  assert(Array.isArray(value.attempts)&&value.attempts.length<=100&&Array.isArray(value.reads)&&value.reads.length<=1000&&Array.isArray(value.faultEvents));
  assert(value.originalRevokedAt===null||validTime(value.originalRevokedAt));
  for(const [i,a] of value.attempts.entries()){
   assert(transitionKeys(a,['sequence','stage','path','bodySha256','acceptedAt','accepted','responseMode'])&&a.sequence===i+1&&['INITIATE','COMPLETE'].includes(a.stage)&&validHash(a.bodySha256)&&validTime(a.acceptedAt));
   assert(a.path==='/' +version+'/' +(a.stage==='INITIATE'?wabaId+'/set_payment_method_migration_intent':transitionFixture.migrationId+'/resume_migration'));
   assert(typeof a.accepted==='boolean'&&['SUCCESS','MALFORMED_WITH_ID','DISCONNECT_NO_LOCATOR','REJECT'].includes(a.responseMode));
   assert(a.accepted?a.responseMode!=='REJECT':a.responseMode==='REJECT');
  }
  for(const stage of ['INITIATE','COMPLETE']){
   const accepted=value.attempts.filter(a=>a.stage===stage&&a.accepted),slot=value[stage.toLowerCase()];assert(accepted.length<=1);
   assert(slot===null?accepted.length===0:transitionKeys(slot,['attemptSequence'])&&accepted.length===1&&slot.attemptSequence===accepted[0].sequence);
  }
  assert(!value.complete||value.initiate&&value.complete.attemptSequence>value.initiate.attemptSequence);
  for(const [i,r] of value.reads.entries())assert(transitionKeys(r,['sequence','path','fields','at'])&&r.sequence===i+1&&typeof r.path==='string'&&r.path.startsWith('/'+version+'/')&&r.path.length<=512&&(r.fields===null||typeof r.fields==='string'&&r.fields.length<=256)&&validTime(r.at));
  for(const f of value.faultEvents){assert(transitionKeys(f,['spec','attemptSequence']));transitionFault(f.spec);const a=value.attempts[f.attemptSequence-1];assert(a&&a.stage===f.spec.stage&&a.responseMode===f.spec.mode);}
  assert(new Set(value.faultEvents.map(f=>f.spec.id)).size===value.faultEvents.length);
  if(value.armedFault!==null){transitionFault(value.armedFault);assert(!value.faultEvents.some(f=>f.spec.id===value.armedFault.id)&&!value[value.armedFault.stage.toLowerCase()]);}
 };
 const transitionAccount=()=>transition?.complete?transitionFixture.targetAccountId:wabaId;
 const transitionRead=(url)=>{assert(transition.reads.length<1000);transition.reads.push({sequence:transition.reads.length+1,path:url.pathname,fields:url.searchParams.get('fields'),at:timestamp()});persist();};
 const privateDir=path=>{const d=lstatSync(dirname(path));assert(d.isDirectory()&&!d.isSymbolicLink()&&(d.mode&0o077)===0&&d.uid===process.getuid());};
 if(stateFile){privateDir(stateFile);try{const f=lstatSync(stateFile);assert(f.isFile()&&!f.isSymbolicLink()&&(f.mode&0o077)===0&&f.uid===process.getuid()&&f.size<=16*1024*1024);const x=JSON.parse(readFileSync(stateFile));if(templates)templates.restore(x.templatePreparation);else assert(x.templatePreparation===undefined);if(legacy)legacy.restore(x.legacyMigration);else assert(x.legacyMigration===undefined);if(transitionFixture){validateTransition(x.accountTransition);transition=x.accountTransition;}else assert(x.accountTransition===undefined);if(routingFixture){validateRouting(x.threadControl);routing=x.threadControl;}else assert(x.threadControl===undefined);assert(x.schema===1&&x.phoneId===phoneId&&x.version===version&&Array.isArray(x.receipts));assert(x.receipts.every((r,i)=>r.sequence===i+1&&r.id==='wamid.SIM'+String(i+1).padStart(12,'0')&&recipients.includes(r.to??r.recipient)&&Object.hasOwn(r,'to')!==Object.hasOwn(r,'recipient')&&r.body&&(Object.hasOwn(r.body,'to')!==Object.hasOwn(r.body,'recipient'))&&(r.to===undefined?r.body.recipient===r.recipient:r.body.to===r.to)));assert(x.wabaId===undefined||x.wabaId===wabaId);assert(x.subscribed===undefined||typeof x.subscribed==='boolean');subscribed=x.subscribed===true;if(financialFixture){assert(JSON.stringify(x.financialFixture)===JSON.stringify(financialFixture));assert(typeof x.financialState?.attached==='boolean'&&typeof x.financialState?.revoked==='boolean'&&Array.isArray(x.financialEvents));financialState=x.financialState;financialEvents.push(...x.financialEvents);}else assert(x.financialFixture===undefined&&x.financialState===undefined&&x.financialEvents===undefined);if(signup){validateSignupState(x.signup);signup=x.signup;}else assert(x.signup===undefined);if(transition?.initiate)assert(signup.registration&&subscribed);armedFault=x.armedFault??null;armedUploadFault=x.armedUploadFault??null;if(armedUploadFault)validateUploadFault(armedUploadFault);assert(x.uploadFaultEvents===undefined||Array.isArray(x.uploadFaultEvents));for(const e of x.uploadFaultEvents??[]){validateUploadFault({id:e.id,sha256:e.sha256});assert(e.outcome==='FAILED_BEFORE_ALLOCATION'&&e.status===503);uploadFaultEvents.push(e);}faultEvents.push(...(x.faultEvents??[]));receipts.push(...x.receipts);assert(x.mediaObjects===undefined||Array.isArray(x.mediaObjects));for(const media of x.mediaObjects??[]){validateStoredSyntheticMedia(media,mediaObjects.length);mediaObjects.push(media);}}catch(e){if(e.code!=='ENOENT')throw e;}}
 const persist=()=>{if(!stateFile)return;try{privateDir(stateFile);const bytes=JSON.stringify({schema:1,phoneId,version,wabaId,subscribed,receipts,armedFault,faultEvents,mediaObjects,armedUploadFault,uploadFaultEvents,...(financialFixture?{financialFixture,financialState,financialEvents}:{}),...(signup?{signup}:{}),...(routing?{threadControl:routing}:{}),...(transition?{accountTransition:transition}:{}),...(templates?{templatePreparation:templates.snapshot()}:{}),...(legacy?{legacyMigration:legacy.snapshot()}:{})});assert(Buffer.byteLength(bytes)<=16*1024*1024);const tmp=stateFile+'.tmp-'+process.pid;const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,stateFile);}catch(e){failed=true;throw e;}};

 const smallJson=async(req,bound=1024)=>{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;assert(size<=bound);chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks));};
 const acceptSignupFault=(phase,at)=>{
  if(signup.armedFault?.phase!==phase)return false;
  signup.faultEvents.push({...signup.armedFault,outcome:'ACCEPTED_DISCONNECTED',acceptedAt:at});signup.armedFault=null;return true;
 };
 const server=createServer({key,cert},async(req,res)=>{if(failed){res.destroy();return;}const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};try{const url=new URL(req.url,'https://graph.facebook.com');const debugRequest=url.pathname==='/'+version+'/debug_token';const exchangeRequest=!!signup&&url.pathname==='/'+version+'/oauth/access_token';const supplied=Buffer.from(req.headers.authorization??''),allowed=(debugRequest||exchangeRequest)&&appId&&appSecret?[appId+'|'+appSecret]:[...(templates?[templates.targetToken]:[]),...(transition?.originalRevokedAt===null||!transition?[token]:[]),...(reauthorizationToken?[reauthorizationToken]:[]),...(transitionFixture?[transitionFixture.renewalToken,...(transitionFixture.managed?[transitionFixture.managed.financialToken]:[])]:[])];if(!allowed.some(value=>{const expected=Buffer.from('Bearer '+value);return supplied.length===expected.length&&timingSafeEqual(supplied,expected);} ))return json(401,{error:{code:190,type:'OAuthException',message:'Synthetic credential rejected'}});
 if(debugRequest){assert(appId&&/^\d{5,32}$/.test(appId)&&appSecret?.length>=16&&req.method==='GET');assert([...url.searchParams.keys()].join(',')==='input_token');const subject=url.searchParams.get('input_token'),financial=transitionFixture?.managed?.financialToken===subject;
   return json(200,{data:{is_valid:[...(templates?[templates.targetToken]:[]),...(transition?.originalRevokedAt===null||!transition?[token]:[]),...(reauthorizationToken?[reauthorizationToken]:[]),...(transitionFixture?[transitionFixture.renewalToken,...(transitionFixture.managed?[transitionFixture.managed.financialToken]:[])]:[])].includes(subject),app_id:appId,scopes:financial?['business_management']:['whatsapp_business_management','whatsapp_business_messaging'],expires_at:0,...(signup&&!financial?{user_id:signup.binding.userId,granular_scopes:['whatsapp_business_management','whatsapp_business_messaging'].map(scope=>({scope,target_ids:templates?[wabaId,templatePreparationFixture.targetAccountId]:[transition?transitionAccount():wabaId]}))}:{})}});}
 if(reauthorizationToken&&!coex&&req.method!=='GET'&&!(routing&&req.method==='POST'&&url.pathname==='/'+version+'/'+phoneId+'/thread_control'))return json(400,{error:{code:100,type:'OAuthException',message:'Paused reauthorization fixture allows reads only'}});
 const root='/'+version+'/'+phoneId;
 const exactQuery=(fields,list=false)=>{assert(url.searchParams.get('fields')===fields);assert.deepEqual([...url.searchParams.keys()].sort(),list?['fields','limit']:['fields']);if(list)assert(url.searchParams.get('limit')==='100');};
  if(legacy&&await legacy.route(req,res,url,{json,smallJson,persist,now:timestamp}))return;
 if(templates&&!legacy?.permitsSharedPath(req,url)&&await templates.route(req,res,url,{json,smallJson,persist,now:timestamp}))return;
 if(transition&&!debugRequest&&!exchangeRequest){
   const f=transitionFixture,financial=!!f.managed&&req.headers.authorization==='Bearer '+f.managed.financialToken;
   const graphError=()=>json(400,{error:{code:100,type:'OAuthException',message:'Synthetic transition request rejected'}});
   const currentAccount=transitionAccount();
   if(req.method==='POST'&&[wabaId+'/set_payment_method_migration_intent',f.migrationId+'/resume_migration'].some(p=>url.pathname==='/'+version+'/'+p)){
    assert(!financial&&!url.search);const stage=url.pathname.endsWith('/resume_migration')?'COMPLETE':'INITIATE';
    const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;assert(n<=1024);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),body=bytes.length?JSON.parse(bytes):null;
    if(stage==='INITIATE')assert(transitionKeys(body,['currency',...(f.managed?['extended_credit_id']:[])])&&body.currency===f.targetCurrency&&(!f.managed||body.extended_credit_id===f.managed.creditLineId));
    else assert(bytes.length===0);
    assert(transition.attempts.length<100);let fault=null;
    if(!transition[stage.toLowerCase()]&&signup.registration!==null&&subscribed&&(!f.managed||financialState.attached&&!financialState.revoked)&&(stage==='INITIATE'||transition.initiate!==null)&&transition.armedFault?.stage===stage){fault=transition.armedFault;transition.armedFault=null;}
    const accepted=!transition[stage.toLowerCase()]&&signup.registration!==null&&subscribed&&(!f.managed||financialState.attached&&!financialState.revoked)&&(stage==='INITIATE'||transition.initiate!==null)&&fault?.mode!=='REJECT';
    const responseMode=accepted?(fault?.mode??'SUCCESS'):'REJECT',sequence=transition.attempts.length+1;
    transition.attempts.push({sequence,stage,path:url.pathname,bodySha256:hash(bytes),acceptedAt:timestamp(),accepted,responseMode});
    if(fault)transition.faultEvents.push({spec:fault,attemptSequence:sequence});
    if(accepted)transition[stage.toLowerCase()]={attemptSequence:sequence};persist();
    if(!accepted)return graphError();
    if(responseMode==='DISCONNECT_NO_LOCATOR'){res.destroy();return;}
    if(responseMode==='MALFORMED_WITH_ID')return json(200,stage==='INITIATE'?{migration_id:f.migrationId}:{id:f.migrationId});
    return json(200,stage==='INITIATE'?{migration_id:f.migrationId,migration_status:'INITIATED'}:{id:f.migrationId,status:'COMPLETED',destination_waba:{id:f.targetAccountId,currency:f.targetCurrency}});
   }
   if(req.method==='GET'&&url.pathname==='/'+version+'/'+f.migrationId){
    assert(!financial&&!url.search);if(!transition.initiate)return graphError();transitionRead(url);
    return json(200,{id:f.migrationId,status:transition.complete?'COMPLETED':'READY_TO_COMPLETE',destination_waba:{id:f.targetAccountId,currency:f.targetCurrency}});
   }
   if(f.managed&&financial){const a=f.managed;
    // Original source finance requests keep their incumbent P08 ledger.
    const sourceFinance=financialFixture&&[
     financialFixture.holderBusinessId+'/extendedcredits',financialFixture.creditLineId+'/whatsapp_credit_sharing_and_attach',
     financialFixture.creditLineId+'/owning_credit_allocation_configs',financialFixture.allocationConfigId
    ].some(path=>url.pathname==='/'+version+'/'+path);
    if(transition.initiate&&req.method==='GET'&&url.pathname==='/'+version+'/'+a.creditLineId+'/owning_credit_allocation_configs'){
     assert([...url.searchParams.keys()].sort().join(',')==='fields,receiving_business_id'&&url.searchParams.get('fields')==='id,receiving_business'&&url.searchParams.get('receiving_business_id')===a.receivingBusinessId);
     transitionRead(url);return json(200,{id:a.allocationId,receiving_business:{id:a.receivingBusinessId}});
    }
    if(req.method==='GET'&&url.pathname==='/'+version+'/'+a.allocationId){exactQuery('receiving_credential');if(!transition.initiate)return graphError();transitionRead(url);return json(200,{id:a.allocationId,receiving_credential:{id:f.targetFundingId}});}
    if(!sourceFinance)return graphError();
   }
   if(!financial&&req.method==='GET'&&[wabaId,f.targetAccountId].some(id=>url.pathname==='/'+version+'/'+id)){
    const id=url.pathname.slice(('/'+version+'/').length),target=id===f.targetAccountId;
    if(target&&!transition.initiate)return graphError();const fields=url.searchParams.get('fields');
    assert(['id,currency','id,owner_business{id}','primary_funding_id','id,name,owner_business{id,name}'].includes(fields));exactQuery(fields);transitionRead(url);
    if(fields==='id,currency')return json(200,{id,currency:target?f.targetCurrency:f.sourceCurrency});
    if(fields==='primary_funding_id')return json(200,{id,...(target||!f.managed||financialState.attached&&!financialState.revoked?{primary_funding_id:target?f.targetFundingId:f.sourceFundingId}:{})});
    return json(200,{id,...(fields.includes('name')?{name:'Synthetic account'}:{}),owner_business:{id:signupFixture.businessId,...(fields.includes('name')?{name:'Synthetic portfolio'}:{})}});
   }
   if(!financial&&req.method==='GET'&&[wabaId,f.targetAccountId].some(id=>url.pathname==='/'+version+'/'+id+'/message_templates')){
    const target=url.pathname.split('/').at(-2)===f.targetAccountId;if(target&&!transition.initiate)return graphError();
    const fields='id,name,language,status,category,parameter_format,components,quality_score,message_send_ttl_seconds,is_primary_device_delivery_only,is_sms_fallback_enabled,display_format,sub_category,cta_url_link_tracking_opted_out,degrees_of_freedom_spec';
    assert([...url.searchParams.keys()].sort().join(',')===(url.searchParams.has('after')?'after,fields,limit':'fields,limit')&&url.searchParams.get('fields')===fields&&url.searchParams.get('limit')==='100');
    const cursor=url.searchParams.get('after');assert(cursor===null||/^[1-9][0-9]{0,4}$/.test(cursor));const start=cursor===null?0:Number(cursor);
    const rows=f.templateInventories?.[target?'target':'source']??[];assert(start===0||start<rows.length&&start%100===0);transitionRead(url);
    const data=rows.slice(start,start+100),next=start+100;
    return json(200,{data,...(next<rows.length?{paging:{cursors:{after:String(next)},next:'https://graph.facebook.com/'+version+'/'+(target?f.targetAccountId:wabaId)+'/message_templates?after='+next}}:{})});
   }
   if(!financial&&req.method==='GET'&&url.pathname==='/'+version+'/'+f.targetAccountId+'/subscribed_apps'){
    if(!transition.initiate)return graphError();exactQuery('id,whatsapp_business_api_data',true);transitionRead(url);
    return json(200,{data:[{whatsapp_business_api_data:{id:appId,name:'Synthetic application'}}]});
   }
   if(!financial&&req.method==='GET'&&[wabaId,f.targetAccountId].some(id=>url.pathname==='/'+version+'/'+id+'/phone_numbers')){
    const id=url.pathname.split('/').at(-2),fields=url.searchParams.get('fields');
    const inventoryFields=['id','id,display_phone_number','id,display_phone_number,verified_name,status,code_verification_status,account_mode,host_platform','id,status,code_verification_status,account_mode,host_platform'];
    assert(inventoryFields.includes(fields));exactQuery(fields,true);transitionRead(url);
    const facts={id:phoneId,display_phone_number:phone,verified_name:'Synthetic account',status:signup.registration?'CONNECTED':'PENDING',code_verification_status:'VERIFIED',account_mode:'LIVE',host_platform:'CLOUD_API'};
    return json(200,{data:id===currentAccount?[Object.fromEntries(fields.split(',').map(field=>[field,facts[field]]))]:[]});
   }
   if(!financial&&req.method==='GET'&&url.pathname==='/'+version+'/'+phoneId&&url.searchParams.get('fields')==='health_status'){
    exactQuery('health_status');transitionRead(url);const ready=signup.registration?'AVAILABLE':'BLOCKED';return json(200,{id:phoneId,health_status:{can_send_message:ready,entities:[
     {entity_type:'PHONE_NUMBER',id:phoneId,can_send_message:ready},{entity_type:'WABA',id:currentAccount,can_send_message:'AVAILABLE'},
     {entity_type:'APP',id:appId,can_send_message:'AVAILABLE'}]}});
   }
   if(!financial&&req.method==='GET'&&url.pathname==='/'+version+'/'+signupFixture.businessId+'/owned_whatsapp_business_accounts'){
    exactQuery('id',true);transitionRead(url);return json(200,{data:[{id:currentAccount}]});
   }
   if(!financial&&req.method==='GET'&&url.pathname==='/'+version+'/'+signupFixture.userId+'/assigned_whatsapp_business_accounts'){
    exactQuery('id,name',true);transitionRead(url);return json(200,{data:[{id:currentAccount,name:'Synthetic account'}]});
   }
   if(req.method!=='GET'&&(url.pathname==='/'+version+'/'+f.targetAccountId+'/subscribed_apps'||transition.initiate&&[root+'/register','/'+version+'/'+wabaId+'/subscribed_apps'].includes(url.pathname)))return graphError();
  }
  if(signup){
   if(exchangeRequest){
   assert(req.method==='GET');assert.deepEqual([...url.searchParams.keys()].sort(),['client_id','client_secret','code']);
   assert(url.searchParams.get('client_id')===appId&&url.searchParams.get('client_secret')===appSecret);
   const code=signup.code,at=timestamp(),input=url.searchParams.get('code');
   assert(typeof input==='string'&&input.length<=128&&code&&code.consumedAt===null&&at>=code.issuedAt&&at<code.expiresAt&&hash(input)===code.sha256);
   code.consumedAt=at;signup.exchangeReceipts.push({sequence:signup.exchangeReceipts.length+1,codeSha256:code.sha256,acceptedAt:at});
   const disconnect=acceptSignupFault('exchange',at);persist();
   if(disconnect){res.destroy();return;}res.setHeader('cache-control','no-store');return json(200,{access_token:code.legacyMigration?templates.targetToken:transitionFixture?(code.renewal?transitionFixture.renewalToken:token):coex?(code.renewal?reauthorizationToken:token):(reauthorizationToken??token),token_type:'bearer'});
  }
  if(req.method==='GET'&&url.pathname==='/'+version+'/'+signup.binding.userId+'/assigned_whatsapp_business_accounts'){
   exactQuery('id,name',true);return json(200,{data:[{id:wabaId,name:'Synthetic account'}]});
  }
  if(req.method==='GET'&&url.pathname==='/'+version+'/'+signup.binding.businessId+'/owned_whatsapp_business_accounts'){
   exactQuery('id',true);return json(200,{data:[{id:wabaId}]});
  }
  if(req.method==='GET'&&url.pathname==='/'+version+'/'+wabaId){
   const fields=url.searchParams.get('fields');assert(['id,name,owner_business{id,name}','id,owner_business{id}',...(financialFixture?['primary_funding_id']:[])].includes(fields));exactQuery(fields);if(fields==='primary_funding_id')return json(200,{id:wabaId,...(financialState.attached&&!financialState.revoked?{primary_funding_id:financialFixture.receivingCredential}:{})});
   return json(200,{id:wabaId,...(fields.includes('name')?{name:'Synthetic account'}:{}),owner_business:{id:signup.binding.businessId,...(fields.includes('name')?{name:'Synthetic portfolio'}:{})}});
  }
  if(req.method==='GET'&&url.pathname===root){
   const fields=url.searchParams.get('fields');exactQuery(fields);
   if(fields==='id')return json(200,{id:phoneId});
   if(fields==='id,is_on_biz_app,platform_type')return json(200,{id:phoneId,is_on_biz_app:!!coex,platform_type:'CLOUD_API'});
   if(coex&&fields==='id,last_onboarded_time')return json(200,{id:phoneId,last_onboarded_time:coex.onboardedAt});
   if(fields==='health_status'){
    const phoneStatus=(signup.registration||reauthorizationToken||coex)?'AVAILABLE':'BLOCKED';
    return json(200,{id:phoneId,health_status:{can_send_message:phoneStatus,entities:[
     {entity_type:'PHONE_NUMBER',id:phoneId,can_send_message:phoneStatus},
     {entity_type:'WABA',id:wabaId,can_send_message:'AVAILABLE'},
     {entity_type:'APP',id:appId,can_send_message:'AVAILABLE'}]}});
   }
   assert(['display_phone_number,verified_name','id,display_phone_number,verified_name'].includes(fields));
   return json(200,{id:phoneId,display_phone_number:phone,verified_name:'Synthetic account'});
  }
  if(req.method==='POST'&&url.pathname===root+'/register'){
   assert(!url.search);const body=await smallJson(req);
   assert(body&&Object.keys(body).sort().join(',')==='messaging_product,pin'&&body.messaging_product==='whatsapp'&&typeof body.pin==='string'&&/^\d{6}$/.test(body.pin));
   signup.registrationAttempts+=1;const pinSha256=hash(body.pin);
   if(coex){persist();return json(400,{error:{code:100,type:'OAuthException',message:'Synthetic business app number is already registered'}});}
   if(signup.registration){persist();assert(signup.registration.pinSha256===pinSha256);return json(200,{success:true});}
   const at=timestamp();signup.registration={pinSha256,acceptedAt:at};const disconnect=acceptSignupFault('register',at);persist();
   if(disconnect){res.destroy();return;}return json(200,{success:true});
  }
  if(coex&&req.method==='POST'&&url.pathname===root+'/smb_app_data'){
   assert(!url.search);const body=await smallJson(req);
   assert(body&&Object.keys(body).sort().join(',')==='messaging_product,sync_type'&&body.messaging_product==='whatsapp');
   assert(['smb_app_state_sync','history'].includes(body.sync_type));
   const kind=body.sync_type==='history'?'history':'contacts',at=timestamp(),bodySha256=hash(JSON.stringify(body));
   assert(signup.sync.attempts.length<100);const attempt={sequence:signup.sync.attempts.length+1,kind,at,bodySha256};signup.sync.attempts.push(attempt);
   if(signup.sync.requests[kind]||at<coex.onboardedAt*1000||at>=coex.onboardedAt*1000+86_400_000||coex[kind]==='REJECT'){
    persist();return json(400,{error:{code:100,type:'OAuthException',message:'Synthetic sync already consumed, declined or outside its window'}});
   }
   const receipt={requestId:'SIMSYNC-'+kind,acceptedAt:at,attemptSequence:attempt.sequence,bodySha256,outcome:coex[kind]};
   signup.sync.requests[kind]=receipt;persist();
   if(receipt.outcome==='DISCONNECT'){res.destroy();return;}
   if(receipt.outcome==='HOLD'){
    const pending={res,timer:setTimeout(()=>{pendingSync.delete(kind);res.destroy();},8000)};
    pendingSync.set(kind,pending);res.once('close',()=>{clearTimeout(pending.timer);if(pendingSync.get(kind)===pending)pendingSync.delete(kind);});return;
   }
   return json(200,{request_id:receipt.requestId});
  }
  if(req.method==='GET'&&url.pathname==='/'+version+'/'+wabaId+'/subscribed_apps'){
   if(url.search)exactQuery('id,whatsapp_business_api_data',true);
   return json(200,{data:subscribed?[{whatsapp_business_api_data:{id:appId,name:'Synthetic application'}}]:[]});
  }
  if(req.method==='GET'&&url.pathname==='/'+version+'/app'){exactQuery('id');return json(200,{id:appId});}
 }
 if(req.method==='GET'&&url.pathname===root)return json(200,{id:phoneId,display_phone_number:phone,verified_name:'Synthetic account'});
 if(req.method==='GET'&&url.pathname===root+'/groups'&&groupsFixture!=='unsupported'){
  assert(url.searchParams.get('fields')==='id,subject,total_participant_count');
  assert(['1','100'].includes(url.searchParams.get('limit'))&&!url.searchParams.has('after'));
  assert([...url.searchParams.keys()].every(k=>['fields','limit'].includes(k)));
  if(groupsFixture==='permission-denied')return json(403,{error:{code:200,type:'OAuthException',message:'Synthetic permission denied'}});
  if(groupsFixture==='rate-limited'){res.setHeader('Retry-After','1');return json(429,{error:{code:4,type:'OAuthException',message:'Synthetic rate limit'}});}
  return json(200,{data:[]});
 }
 if(wabaId&&req.method==='GET'&&url.pathname==='/'+version+'/'+wabaId+'/phone_numbers'){
  const fields=url.searchParams.get('fields');
  const signupFields=['id,display_phone_number,verified_name,status,code_verification_status,account_mode,host_platform','id,status,code_verification_status,account_mode,host_platform'];
  if(signup&&signupFields.includes(fields)){
   exactQuery(fields,true);const facts={id:phoneId,display_phone_number:phone,verified_name:'Synthetic account',status:(signup.registration||reauthorizationToken||coex)?'CONNECTED':'PENDING',code_verification_status:'VERIFIED',account_mode:'LIVE',host_platform:'CLOUD_API'};
   return json(200,{data:[Object.fromEntries(fields.split(',').map(field=>[field,facts[field]]))]});
  }
  assert(['id','id,display_phone_number'].includes(fields)&&url.searchParams.get('limit')==='100');
  assert([...url.searchParams.keys()].every(k=>['fields','limit'].includes(k)));
  return json(200,{data:[{id:phoneId,...(fields==='id,display_phone_number'?{display_phone_number:phone}:{})}]});
 }
 // Financial fixture is synthetic only; its optional configuration never
 // enrolls a real credit line or identifies a legal payer.
 if(financialFixture){
  if(transitionFixture?.managed&&[financialFixture.holderBusinessId+'/extendedcredits',financialFixture.creditLineId+'/whatsapp_credit_sharing_and_attach',financialFixture.creditLineId+'/owning_credit_allocation_configs',financialFixture.allocationConfigId].some(path=>url.pathname==='/'+version+'/'+path)&&req.headers.authorization!=='Bearer '+transitionFixture.managed.financialToken)return json(403,{error:{code:200,type:'OAuthException',message:'Synthetic financial scope rejected'}});
  const f=financialFixture;
  if(req.method==='GET'&&url.pathname==='/'+version+'/'+f.holderBusinessId+'/extendedcredits'){
   assert(url.searchParams.get('fields')==='id'&&url.searchParams.get('limit')==='100'&&[...url.searchParams.keys()].length===2);
   return json(200,{data:[{id:f.creditLineId}]});
  }
  if(req.method==='POST'&&url.pathname==='/'+version+'/'+f.creditLineId+'/whatsapp_credit_sharing_and_attach'){
   assert([...url.searchParams.keys()].sort().join(',')==='waba_currency,waba_id'&&url.searchParams.get('waba_id')===wabaId&&url.searchParams.get('waba_currency')===f.currency);
   if(financialState.attached)return json(400,{error:{code:100,type:'GraphMethodException',message:'Synthetic line already attached'}});
   financialState={attached:true,revoked:false};financialEvents.push({stage:'ATTACH',allocationConfigId:f.allocationConfigId});persist();
   return json(200,{allocation_config_id:f.allocationConfigId,waba_id:wabaId});
  }
  if(req.method==='GET'&&url.pathname==='/'+version+'/'+f.creditLineId+'/owning_credit_allocation_configs'){
   assert(url.searchParams.get('fields')==='id,receiving_business'&&url.searchParams.get('receiving_business_id')===f.receivingBusinessId&&[...url.searchParams.keys()].length===2);
   if(!financialState.attached)return json(404,{error:{code:100,type:'GraphMethodException',message:'Synthetic allocation absent'}});
   return json(200,{id:f.allocationConfigId,receiving_business:{id:f.receivingBusinessId}});
  }
  if(url.pathname==='/'+version+'/'+f.allocationConfigId){
   if(!financialState.attached)return json(404,{error:{code:100,type:'GraphMethodException',message:'Synthetic allocation absent'}});
   if(req.method==='DELETE'){assert(!url.search);financialState.revoked=true;financialEvents.push({stage:'REVOKE',allocationConfigId:f.allocationConfigId});persist();return json(200,{success:true});}
   assert(req.method==='GET'&&[...url.searchParams.keys()].join(',')==='fields');
   if(url.searchParams.get('fields')==='receiving_credential')return json(200,{id:f.allocationConfigId,receiving_credential:{id:f.receivingCredential}});
   assert(url.searchParams.get('fields')==='receiving_business,request_status');return json(200,{receiving_business:{id:f.receivingBusinessId},request_status:financialState.revoked?'DELETED':'ACTIVE'});
  }
 }
 // Synthetic read-only facts do not establish customer/card/payer ownership.
 if(wabaId&&req.method==='GET'&&url.pathname==='/'+version+'/'+wabaId){
  assert([...url.searchParams.keys()].join(',')==='fields');
  assert(['id,owner_business{id}','primary_funding_id'].includes(url.searchParams.get('fields')));
  return json(200,{id:wabaId,...(financialFixture&&financialState.attached&&!financialState.revoked&&url.searchParams.get('fields')==='primary_funding_id'?{primary_funding_id:financialFixture.receivingCredential}:{})});
 }
 if(wabaId&&req.method==='POST'&&url.pathname==='/'+version+'/'+wabaId+'/subscribed_apps'){
  assert(!url.search);let size=0;const chunks=[];for await(const c of req){size+=c.length;assert(size<=1024);chunks.push(c);}const body=JSON.parse(Buffer.concat(chunks));assert(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===0);subscribed=true;persist();return json(200,{success:true});
 }
 // Existing uploaded synthetic media is the only inbound-media source; authenticated and current-phone scoped.
 if(req.method==='GET'&&url.pathname.startsWith('/'+version+'/SIMMEDIA')){
  const id=url.pathname.slice(('/'+version+'/').length),m=mediaObjects.find(x=>x.id===id);
  assert(m&&url.searchParams.get('phone_number_id')===phoneId&&[...url.searchParams.keys()].join(',')==='phone_number_id');
  return json(200,{id:m.id,messaging_product:'whatsapp',url:'https://graph.facebook.com/__simulation/media/'+encodeURIComponent(m.id),mime_type:m.mime,sha256:m.sha256,file_size:m.bytes});
 }
 if(req.method==='GET'&&url.pathname.startsWith('/__simulation/media/')){
  assert(!url.search);const m=mediaObjects.find(x=>x.id===decodeURIComponent(url.pathname.slice('/__simulation/media/'.length)));assert(m);
  res.writeHead(200,{'content-type':m.mime,'content-length':m.bytes});return res.end(Buffer.from(m.base64,'base64'));
 }
 if(req.method==='POST'&&url.pathname===root+'/media'){assert(!url.search);let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;assert(size<=2*1024*1024);chunks.push(chunk);}const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();assert.deepEqual([...form.keys()].sort(),['file','messaging_product']);assert.equal(form.get('messaging_product'),'whatsapp');const file=form.get('file');assert(file instanceof Blob&&file.size>0&&file.size<=1024*1024&&['image/png','application/pdf'].includes(file.type));const bytes=validateSyntheticMedia(Buffer.from(await file.arrayBuffer()),file.type);if(armedUploadFault&&armedUploadFault.sha256===createHash('sha256').update(bytes).digest('hex')){uploadFaultEvents.push({...armedUploadFault,outcome:'FAILED_BEFORE_ALLOCATION',status:503});armedUploadFault=null;persist();return json(503,{error:{code:2,type:'OAuthException',message:'Synthetic media upload unavailable'}});}const id='SIMMEDIA'+String(mediaObjects.length+1);mediaObjects.push({id,mime:file.type,filename:file.name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')});persist();return json(200,{id});}
 if(routing&&req.method==='POST'&&url.pathname===root+'/thread_control'){
  assert(!url.search);const body=await smallJson(req,16384),peer=routingBody(body);assert(routing.attempts.length<1000);
  const denied=body.action==='take'&&!routingFixture.roles.includes('escalation')
   ||body.action!=='take'&&routing.owners[peer]!=='OWN'
   ||body.action==='pass'&&(body.control_pass?!routingFixture.targets.includes(body.control_pass.target_role):routingFixture.roles.includes('escalation'));
  let fault=null;if(!denied&&routing.armedFault?.action===body.action&&routing.armedFault.recipient===peer){fault=routing.armedFault;routing.armedFault=null;}
  const outcome=denied||fault?.mode==='reject'?'REJECTED':fault?.mode==='malformed-rejection'?'MALFORMED_REJECTION':'ACCEPTED';
  const requestId=outcome==='ACCEPTED'?'SIMTHREAD-'+String(routing.receipts.length+1).padStart(8,'0'):null;
  const bodySha256=routingHash(body);routing.attempts.push({sequence:routing.attempts.length+1,body,bodySha256,outcome,requestId});
  if(fault)routing.faultEvents.push({spec:fault,attempt:routing.attempts.length});
  if(outcome==='ACCEPTED'){const state=({take:'OWN',pass:'STANDBY',release:'IDLE'})[body.action];routing.owners[peer]=state;routing.receipts.push({requestId,sequence:routing.receipts.length+1,body,bodySha256,state});}
  persist();
  if(outcome==='REJECTED')return json(400,{error:{code:body.action==='take'&&!routingFixture.roles.includes('escalation')?2494191:100,type:'OAuthException',message:'Synthetic thread control rejected'}});
  if(outcome==='MALFORMED_REJECTION')return json(400,{});
  if(fault?.mode==='disconnect-after-acceptance'){res.destroy();return;}
  return json(200,{messaging_product:'whatsapp',request_id:requestId});
 }
 if(req.method!=='POST'||url.pathname!==root+'/messages')return json(404,{error:{code:100,type:'GraphMethodException',message:'Unsupported simulated route'}});
 let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;assert(size<=65536);chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks));
 if(body.status==='read'){
  const keys=['message_id','messaging_product','status'];
  if(Object.hasOwn(body,'typing_indicator')){keys.push('typing_indicator');assert.deepEqual(body.typing_indicator,{type:'text'});}
  assert.deepEqual(Object.keys(body).sort(),keys);
  assert.equal(body.messaging_product,'whatsapp');assert(/^wamid\.[A-Za-z0-9._:=+-]{1,506}$/u.test(body.message_id));
  return json(200,{success:true});
 }
 assert(body.messaging_product==='whatsapp'&&body.recipient_type==='individual');if(transition)assert(body.messaging_account_id===transitionAccount(),'Wrong current Messaging account');else if(Object.hasOwn(body,'messaging_account_id'))assert(wabaId&&body.messaging_account_id===wabaId);assert(!Object.hasOwn(body,'paid_messaging_account_id'));const phoneRecipient=Object.hasOwn(body,'to'),bsuidRecipient=Object.hasOwn(body,'recipient');assert(phoneRecipient!==bsuidRecipient);const destination=phoneRecipient?body.to:body.recipient;assert(typeof destination==='string'&&recipients.includes(destination));assert(phoneRecipient?/^\d+$/.test(destination):/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/.test(destination));assert(['text','interactive','location','template','image','document'].includes(body.type));
 if(body.type==='text')assert(typeof body.text?.body==='string'&&body.text.body.length>0&&[...body.text.body].length<=4096);
 if(body.type==='location')assert(Number.isFinite(body.location?.latitude)&&Math.abs(body.location.latitude)<=90&&Number.isFinite(body.location.longitude)&&Math.abs(body.location.longitude)<=180);
 if(body.type==='interactive'){assert(body.interactive?.type==='button');const buttons=body.interactive.action?.buttons;assert(Array.isArray(buttons)&&buttons.length>0&&buttons.length<=3&&buttons.every(x=>x.type==='reply'&&typeof x.reply?.id==='string'&&typeof x.reply?.title==='string'));}
 if(body.type==='template'){assert(typeof body.template?.name==='string'&&/^[a-z0-9_]{1,512}$/.test(body.template.name));assert(typeof body.template.language?.code==='string'&&/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(body.template.language.code));assert((body.template.components??[]).every(c=>c.type==='body'&&Array.isArray(c.parameters)&&c.parameters.every(p=>p.type==='text'&&typeof p.text==='string')));}
 let acceptedMedia;if(['image','document'].includes(body.type)){const value=body[body.type];assert(value&&typeof value.id==='string'&&Object.keys(value).every(k=>(body.type==='image'?['id','caption']:['id','caption','filename']).includes(k)));if(value.filename!==undefined)assert(body.type==='document'&&typeof value.filename==='string');acceptedMedia=mediaObjects.find(m=>m.id===value.id);assert(acceptedMedia&&acceptedMedia.mime===(body.type==='image'?'image/png':'application/pdf'));if(value.caption!==undefined)assert(typeof value.caption==='string');}
 const requestHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');let fault=null;
 if(armedFault&&armedFault.to===body.to&&armedFault.bodySha256===requestHash){fault=armedFault;armedFault=null;faultEvents.push({...fault,requestReceived:true,accepted:fault.mode==='disconnect-after-acceptance'});if(fault.mode!=='disconnect-after-acceptance')persist();}
 if(fault?.mode==='window-closed')return json(400,{error:{code:131047,type:'OAuthException',message:'Synthetic customer window closed'}});
 if(fault?.mode==='rate-limited'){res.setHeader('Retry-After','1');return json(429,{error:{code:613,type:'OAuthException',message:'Synthetic rate limit'}});}
 const id='wamid.SIM'+String(receipts.length+1).padStart(12,'0');receipts.push({id,sequence:receipts.length+1,...(phoneRecipient?{to:destination}:{recipient:destination}),type:body.type,body,...(acceptedMedia?{mediaId:acceptedMedia.id,mediaSha256:acceptedMedia.sha256,mediaBytes:acceptedMedia.bytes,mediaMimeType:acceptedMedia.mime}:{}),acceptance:'ACCEPTED',bodySha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});persist();if(fault?.mode==='disconnect-after-acceptance'){res.destroy();return;}return json(200,{messaging_product:'whatsapp',contacts:[phoneRecipient?{input:destination,wa_id:destination}:{input:destination,user_id:destination}],messages:[{id}]});
 }catch{if(failed){res.destroy();return;}return json(400,{error:{code:100,type:'OAuthException',message:'Invalid simulated request'}});}});
 server.transitionState=()=>transition?structuredClone({evidenceClass:'simulated-provider-currency-clone',
  sourceSubscription:{wabaId,subscribed},migrationId:transition.initiate?transitionFixture.migrationId:null,sourceAccountId:wabaId,targetAccountId:transitionFixture.targetAccountId,
  status:transition.complete?'COMPLETED':transition.initiate?'READY_TO_COMPLETE':null,originalRevoked:transition.originalRevokedAt!==null,
  attempts:transition.attempts,reads:transition.reads,armedFault:transition.armedFault,faultEvents:transition.faultEvents}):null;
 server.armTransitionFault=spec=>{assert(!failed&&transition&&!transition.armedFault);transitionFault(spec);
  assert(!transition[spec.stage.toLowerCase()]&&!transition.faultEvents.some(f=>f.spec.id===spec.id));transition.armedFault={...spec};persist();return{armed:true,...spec};};
 server.revokeTransitionOriginal=()=>{assert(!failed&&transition&&transition.initiate&&transition.originalRevokedAt===null);transition.originalRevokedAt=timestamp();persist();return{revoked:true};};
 server.routingState=()=>routing?structuredClone({evidenceClass:'simulated-thread-control',...routing}):null;
 server.legacyMigrationState=()=>legacy?.publicState()??null;
 server.armLegacyMigration=mode=>{assert(!failed&&legacy);return legacy.arm(mode,persist);};
 server.armRoutingFault=spec=>{assert(!failed&&routing&&!routing.armedFault);routingFault(spec);assert(!routing.faultEvents.some(f=>f.spec.id===spec.id));routing.armedFault={...spec};persist();return{armed:true,...spec};};
 server.signupState=()=>signup?structuredClone({evidenceClass:'simulated-provider-signup',binding:signup.binding,
  phoneStatus:(signup.registration||reauthorizationToken||coex)?'CONNECTED':'PENDING',code:signup.code,exchangeReceipts:signup.exchangeReceipts,
  registration:signup.registration,registrationAttempts:signup.registrationAttempts,armedFault:signup.armedFault,faultEvents:signup.faultEvents,...(coex?{sync:signup.sync}:{})}):null;
 server.issueSignupCode=(renewal=false,legacyMigration=false)=>{
  assert(!failed&&signup&&!signup.armedFault);const at=timestamp();
  assert(typeof renewal==='boolean'&&(!renewal||(coex&&reauthorizationToken)||transitionFixture&&transition.initiate));assert(typeof legacyMigration==='boolean'&&(!legacyMigration||(legacy&&legacy.ready()&&!renewal)));
  assert(!signup.code||signup.code.consumedAt!==null||at>=signup.code.expiresAt);
  const code=randomBytes(32).toString('base64url');signup.code={sha256:hash(code),issuedAt:at,expiresAt:at+30_000,consumedAt:null,...(coex||transitionFixture?{renewal}:{}),...(legacy?{legacyMigration}:{})};persist();
  return{code,expiresAt:signup.code.expiresAt};
 };
 server.releaseSignupSync=spec=>{
  assert(!failed&&coex&&spec&&Object.keys(spec).sort().join(',')==='kind,requestId'&&['contacts','history'].includes(spec.kind));
  const receipt=signup.sync.requests[spec.kind],pending=pendingSync.get(spec.kind);
  assert(receipt?.requestId===spec.requestId&&receipt.outcome==='HOLD'&&pending&&!pending.res.destroyed);
  receipt.outcome='RELEASED';persist();clearTimeout(pending.timer);pendingSync.delete(spec.kind);
  pending.res.writeHead(200,{'content-type':'application/json'});pending.res.end(JSON.stringify({request_id:receipt.requestId}));return{released:true,kind:spec.kind,requestId:receipt.requestId};
 };
 server.armSignupFault=spec=>{
  assert(!failed&&signup&&!signup.armedFault&&spec&&Object.keys(spec).sort().join(',')==='id,phase');
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(spec.id)&&['exchange','register'].includes(spec.phase)&&!signup.faultEvents.some(item=>item.id===spec.id));
  if(spec.phase==='exchange')assert(signup.code&&signup.code.consumedAt===null&&timestamp()<signup.code.expiresAt);
  else assert(!signup.registration&&!reauthorizationToken&&!coex);
  signup.armedFault={...spec,...(spec.phase==='exchange'?{codeSha256:signup.code.sha256}:{})};persist();return{armed:true,...spec};
 };
 server.armUploadFault=spec=>{validateUploadFault(spec);assert(!armedUploadFault&&!uploadFaultEvents.some(e=>e.id===spec.id));armedUploadFault={...spec};persist();return{armed:true,...spec};};server.uploadFaultState=()=>structuredClone({armedUploadFault,uploadFaultEvents});server.armFault=spec=>{assert(!armedFault,'Existing fault must be reconciled');assert(spec&&Object.keys(spec).sort().join(',')==='bodySha256,mode,to');assert(['window-closed','rate-limited','disconnect-after-acceptance'].includes(spec.mode));assert(recipients.includes(spec.to)&&/^[a-f0-9]{64}$/.test(spec.bodySha256));armedFault={...spec};persist();return{armed:true,...spec};};server.faultState=()=>structuredClone({armedFault,faultEvents});server.financialState=()=>structuredClone({evidenceClass:'simulated-provider-financial-contract',financialFixture:financialFixture??null,financialState:financialState??null,financialEvents});server.subscription=()=>({wabaId:wabaId??null,subscribed});server.receipts=()=>structuredClone(receipts);server.mediaObjects=()=>structuredClone(mediaObjects);server.startControl=async path=>{privateDir(path);assert(Buffer.byteLength(path,'utf8')<=107,'Simulation control socket path too long');try{lstatSync(path);throw Error('Control path exists');}catch(e){if(e.code!=='ENOENT')throw e;}const c=createControl(async(req,res)=>{
 if(transition&&['/transition','/transition/fault','/transition/revoke-original'].includes(req.url)){
  if(failed){res.destroy();return;}try{let value;
   if(req.method==='GET'&&req.url==='/transition')value=server.transitionState();
   else if(req.method==='POST'&&req.url==='/transition/fault')value=server.armTransitionFault(await smallJson(req));
   else if(req.method==='POST'&&req.url==='/transition/revoke-original'){assert(transitionKeys(await smallJson(req),[]));value=server.revokeTransitionOriginal();}
   else{res.writeHead(404);res.end();return;}
   res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch{if(failed){res.destroy();return;}res.writeHead(400);res.end();}return;
 }
 if(legacy&&['/legacy-migration','/legacy-migration/fault'].includes(req.url)){
  if(failed){res.destroy();return;}
  try{let value;
   if(req.method==='GET'&&req.url==='/legacy-migration')value=server.legacyMigrationState();
   else if(req.method==='POST'&&req.url==='/legacy-migration/fault'){const body=await smallJson(req);assert(exact(body,['mode']));value=server.armLegacyMigration(body.mode);}
   else{res.writeHead(404);res.end();return;}
   res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch{if(failed){res.destroy();return;}res.writeHead(400);res.end();}return;
 }
 if(templates&&['/templates','/templates/complete-target'].includes(req.url)){
  if(failed){res.destroy();return;}
  try{let value;
   if(req.method==='GET'&&req.url==='/templates')value=templates.publicState();
   else if(req.method==='POST'&&req.url==='/templates/complete-target'){const body=await smallJson(req);assert(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===0);value=templates.completeTarget(persist);}
   else{res.writeHead(404);res.end();return;}
   res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch{if(failed){res.destroy();return;}res.writeHead(400);res.end();}return;
 }
 if(routing&&['/routing','/routing/fault'].includes(req.url)){
  if(failed){res.destroy();return;}
  try{let value;if(req.method==='GET'&&req.url==='/routing')value=server.routingState();
   else if(req.method==='POST'&&req.url==='/routing/fault')value=server.armRoutingFault(await smallJson(req));
   else{res.writeHead(404);res.end();return;}
   res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch{if(failed){res.destroy();return;}res.writeHead(400);res.end();}return;
 }
 if(signup&&['/signup','/signup/code','/signup/fault','/signup/sync-release'].includes(req.url)){
  if(failed){res.destroy();return;}
  try{
   let value;
   if(req.method==='GET'&&req.url==='/signup')value=server.signupState();
   else if(req.method==='POST'&&req.url==='/signup/code'){const body=await smallJson(req);assert(body&&!Array.isArray(body)&&(Object.keys(body).length===0||((coex||transitionFixture)&&Object.keys(body).join(',')==='renewal'&&body.renewal===true)||(legacy&&Object.keys(body).join(',')==='legacyMigration'&&body.legacyMigration===true)));value=server.issueSignupCode(body.renewal??false,body.legacyMigration??false);}
   else if(req.method==='POST'&&req.url==='/signup/fault')value=server.armSignupFault(await smallJson(req));
   else if(req.method==='POST'&&req.url==='/signup/sync-release')value=server.releaseSignupSync(await smallJson(req));
   else{res.writeHead(404);res.end();return;}
   res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify(value));
  }catch{if(failed){res.destroy();return;}res.writeHead(400);res.end();}
  return;
 }
 if(req.method==='GET'&&req.url==='/financial'){res.setHeader('content-type','application/json');res.end(JSON.stringify(server.financialState()));return;}if(req.method==='GET'&&req.url==='/upload-fault'){res.setHeader('content-type','application/json');res.end(JSON.stringify(server.uploadFaultState()));return;}if(req.method==='POST'&&req.url==='/upload-fault'){try{let n=0;const chunks=[];for await(const c of req){n+=c.length;assert(n<=1024);chunks.push(c);}const result=server.armUploadFault(JSON.parse(Buffer.concat(chunks)));res.setHeader('content-type','application/json');res.end(JSON.stringify(result));}catch{if(failed){res.destroy();return;}res.writeHead(400);res.end();}return;}if(req.method==='POST'&&req.url==='/fault'){try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}const receipt=server.armFault(JSON.parse(Buffer.concat(chunks)));res.setHeader('content-type','application/json');res.end(JSON.stringify(receipt));}catch{res.writeHead(400);res.end();}return;}if(req.method==='GET'&&req.url==='/fault'){res.setHeader('content-type','application/json');res.end(JSON.stringify(server.faultState()));return;}if(req.method!=='GET'||req.url!=='/receipts'){res.writeHead(404);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({evidenceClass:'simulated-provider-acceptance',receipts:server.receipts()}));});await new Promise((resolve,reject)=>{c.once('error',reject);c.listen(path,resolve);});try{chmodSync(path,0o600);return c;}catch(error){await new Promise(resolve=>c.close(resolve));throw error;}};return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const e=process.env;const server=createMetaSimulation({token:e.META_SIM_TOKEN,phoneId:e.META_SIM_PHONE_ID,phone:e.META_SIM_PHONE,version:e.META_SIM_VERSION,recipients:JSON.parse(e.META_SIM_RECIPIENTS),key:readFileSync(e.META_SIM_TLS_KEY),cert:readFileSync(e.META_SIM_TLS_CERT),stateFile:e.META_SIM_STATE_FILE,groupsFixture:e.META_SIM_GROUPS_FIXTURE,wabaId:e.META_SIM_WABA_ID,appId:e.META_SIM_APP_ID,appSecret:e.META_SIM_APP_SECRET,signupFixture:e.META_SIM_SIGNUP_FIXTURE===undefined?undefined:JSON.parse(e.META_SIM_SIGNUP_FIXTURE),financialFixture:e.META_SIM_FINANCIAL_FIXTURE?JSON.parse(e.META_SIM_FINANCIAL_FIXTURE):undefined,routingFixture:e.META_SIM_ROUTING_FIXTURE===undefined?undefined:JSON.parse(e.META_SIM_ROUTING_FIXTURE),templatePreparationFixture:e.META_SIM_TEMPLATE_PREPARATION_FIXTURE===undefined?undefined:JSON.parse(e.META_SIM_TEMPLATE_PREPARATION_FIXTURE),transitionFixture:e.META_SIM_TRANSITION_FIXTURE===undefined?undefined:JSON.parse(e.META_SIM_TRANSITION_FIXTURE),legacyMigrationFixture:e.META_SIM_LEGACY_MIGRATION_FIXTURE===undefined?undefined:JSON.parse(e.META_SIM_LEGACY_MIGRATION_FIXTURE)});assert(e.META_SIM_STATE_FILE&&e.META_SIM_CONTROL_SOCKET);await server.startControl(e.META_SIM_CONTROL_SOCKET);server.listen(443,'0.0.0.0');}
