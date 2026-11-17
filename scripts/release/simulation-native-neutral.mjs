import assert from 'node:assert/strict';
import {createOwnedIntentRegistry} from './owned-intent-registry.mjs';
import {observeOwnedRestoration} from './owned-work-restoration.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {simulationEventId,assertIngressReceipts} from './synthetic-first-group-driver.mjs';
import {callSimulationControl} from '../contracts/waha-simulation-control.mjs';
export async function runNativeNeutralScenario(s){
 const {ownerPage,origin,runId,tenantId,connectionId,groupId,externalGroupId,scoped,checkpoint,socketPath,nativeQuality,nativePage,visibility='ALL_AGENTS',mediaFixture}=s;
 assert(['ALL_AGENTS','RESTRICTED'].includes(visibility));
 const request=createSyntheticRequest({page:ownerPage,origin,runId,checkpoint});
 const settingsPath='/api/group-workspace/settings',capturePath='/api/group-workspace/groups/'+groupId;
 const oldSettings=await request(settingsPath),oldCapture=await request(capturePath);assert.equal(typeof oldCapture.capture_enabled,'boolean');
 const registry=createOwnedIntentRegistry(checkpoint),originalUnknowns=await scoped("SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND state='OUTCOME_UNKNOWN' ORDER BY id",[connectionId]);
 await observeOwnedRestoration({scoped,tenantId,connectionId,registry:{closed:true,entries:()=>[]},originalUnknowns});
 const rules=await scoped("SELECT r.matcher_type,r.pattern FROM group_bindings b JOIN trigger_rules r ON r.tenant_id=b.tenant_id AND r.rule_set_id=b.rule_set_id WHERE b.whatsapp_group_id=$1 AND b.state='ACTIVE' AND r.enabled",[groupId]);
 assert(rules.length&&rules.every(r=>r.matcher_type==='exact_length'&&r.pattern==='[0-9]{10}'),'Neutral fixture requires reviewed numeric-only active rules');
 const input={eventId:simulationEventId(runId+'-neutral'),messageId:'false_'+externalGroupId+'_'+runId+'-neutral',chatId:externalGroupId,participant:'12025550106@c.us',text:'Alpha neutral history fixture',...(mediaFixture?{mediaFixtureId:mediaFixture.id}:{})};
 assert.equal((await scoped("SELECT id FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId])).length,0);
 const settingsBody=(s,enabled)=>({enabled,retentionDays:s.group_history_default_retention_days,visibility:s.group_history_default_visibility,expectedVersion:Number(s.version)});
 const captureBody=(s,enabled)=>({captureEnabled:enabled,retentionDays:s.retention_days,visibility:s.visibility,agentPrefix:s.agent_prefix,agentIdentityPlacement:s.agent_identity_placement,expectedVersion:Number(s.version)});
 await checkpoint({phase:'native-window-before',settings:oldSettings,capture:oldCapture});
 let result,primary;
 try{
  await request(settingsPath,'PUT',settingsBody(oldSettings,true),'native-workspace');
  await request(capturePath,'PUT',captureBody({...oldCapture,visibility},true),'native-capture');
  const capture=await request(capturePath);assert(capture.capture_enabled&&capture.enabled_at);
  const catalog=s.catalogRead?await s.catalogRead(groupId):await nativePage.evaluate(async id=>{const r=await fetch('/api/v1/wasalx/group_workspace/groups?scope=ALL&limit=50&selected='+id);return{status:r.status,value:r.ok?await r.json():null};},groupId);
  assert.equal(catalog.status,200);if(visibility==='ALL_AGENTS')assert(catalog.value.items.some(x=>x.id===groupId),'Native catalog prerequisite before ingress');else assert(!catalog.value.items.some(x=>x.id===groupId),'Ungrantable fixture unexpectedly visible');
  while(Math.floor(Date.now()/1000)<Math.ceil(Date.parse(capture.enabled_at)/1000))await new Promise(r=>setTimeout(r,50));
  await registry.register({kind:'inbound',eventId:input.eventId});await checkpoint({phase:'native-neutral-intent',input});
  const receipt=await (s.providerControl??(command=>callSimulationControl(socketPath,command)))({action:'inbound',input});await checkpoint({phase:'native-neutral-receipt',receipt});
  let inbox;const deadline=Date.now()+90000;
  for(;;){inbox=(await scoped("SELECT id,status,processed_at,lease_id FROM event_inbox WHERE connection_id=$1 AND provider_event_id_sha256=app.webhook_event_id_sha256($2,$1,'WAHA',$3)",[connectionId,tenantId,input.eventId]))[0];if(inbox?.processed_at&&!inbox.lease_id)break;if(Date.now()>deadline)throw Error('Neutral fixture unsettled; retain configuration');await new Promise(r=>setTimeout(r,300));}
  assertIngressReceipts(receipt,false,inbox.id);
  const [message]=await scoped("SELECT id,history_captured_at,provider_timestamp,provider_metadata->>'media_object_id' AS media_object_id FROM normalized_messages WHERE event_inbox_id=$1",[inbox.id]);assert(message?.history_captured_at);assert(Date.parse(message.provider_timestamp)>=Date.parse(capture.enabled_at));
  const links=await scoped('SELECT id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,input.messageId]);assert.equal(links.length,0,'Neutral fixture must remain ticketless');
  await checkpoint({phase:'native-neutral-ready',inbox,message,capture});
  if(mediaFixture)assert(message.media_object_id,'Captured fixture media missing');
  result=await nativeQuality({...s,messageId:message.id,externalMessageId:input.messageId,participant:input.participant,registry});
  if(mediaFixture)result={...result,media:{evidenceMode:'simulated',namespace:s.namespace??runId,tenantId,connectionId,messageId:message.id,mediaId:message.media_object_id}};
 }catch(error){primary=error;throw error;}finally{
  registry.close();await checkpoint({phase:'owned-intent-registry-closed',entries:registry.entries()});
  // Settlement failure must prevent configuration changes; AggregateError retains the original failure.
  // eslint-disable-next-line no-unsafe-finally
  try{await observeOwnedRestoration({scoped,tenantId,connectionId,registry,originalUnknowns});await s.beforeRestore?.();}catch(error){await checkpoint({phase:'configuration-held',reason:'owned-work-unsettled'});throw new AggregateError([...(primary?[primary]:[]),error],'Configuration retained');}
  const errors=[];
  for(const [name,fn]of [['capture',async()=>request(capturePath,'PUT',captureBody({...oldCapture,version:(await request(capturePath)).version},oldCapture.capture_enabled),'restore-native-capture')],['settings',async()=>request(settingsPath,'PUT',settingsBody({...oldSettings,version:(await request(settingsPath)).version},oldSettings.group_workspace_enabled),'restore-native-settings')]])try{await fn();}catch{errors.push(name);}
  await checkpoint({phase:'native-window-restored',errors,settings:await request(settingsPath),capture:await request(capturePath)});assert.equal(errors.length,0,'Native window restoration incomplete');
 }
 return result;
}
