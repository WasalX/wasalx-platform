import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {seedSyntheticGroup,createSyntheticRequest} from './seed-simulation-group.mjs';
import {runNativeNeutralScenario} from './simulation-native-neutral.mjs';
import {createNativeBusinessEmitter} from './simulation-native-business-batch.mjs';
import {observeNicknameSurfaces} from './simulation-native-nickname-surfaces.mjs';
import {ensureNativeAgent} from './simulation-native-agent.mjs';
export const crossConnectionNicknameId='group-workspace/live-inbound-outbound-edits-revokes-reactions-and-attribution::participant-nickname-consistency::reload-other-connection';
export async function crossConnectionNickname({session:s,connectionId,control,dc,namespace,inputs}){
 const prior=inputs.nativeBusiness.results.find(x=>x.testId.endsWith('participant-nickname-consistency::refresh'));
 assert.equal(prior?.result,'passed','Current primary nickname proof required');const first=prior.proof.refreshed;
 assert.equal(inputs.nativeBusiness.namespace,namespace);assert.equal(inputs.nativeBusiness.tenantId,s.tenantId);assert.notEqual(connectionId,inputs.group.connectionId);
 const env=s.model.services['waha-lifecycle'].environment,externalGroupId=env.WAHA_SIM_GROUP_ID;
 assert(externalGroupId&&externalGroupId!==inputs.group.groupRef);assert(/^[1-9][0-9]+@c\.us$/.test(first.participant));
 const request=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace+'-other',checkpoint:s.checkpoint});
 const detail=await request('/api/connections/'+connectionId);assert.equal(detail.provider_state,'WORKING');assert.equal(detail.latest_operation_state,'SUCCEEDED');
 const binding=await request('/api/groups/'+inputs.group.groupId+'/binding');const rules=await request('/api/rule-sets');const rule=rules.find(x=>x.id===binding.rule_set_id);assert.equal(rule?.state,'ACTIVE');
 const catalogs=await request('/api/zammad/routing-catalogs');const target=catalogs.groups.find(x=>String(x.id)===String(binding.zammad_group_id));assert(target?.active&&target.serviceIdentityCanCreate);
 const configured=await seedSyntheticGroup({page:s.ownerPage,origin:s.portalOrigin,runId:namespace+'-other',externalGroupId,nativeGroupName:target.name,evidenceMode:'simulated',checkpoint:s.checkpoint,resumeConnection:{id:connectionId,name:detail.name},resumeRule:{id:rule.id,name:rule.name},assertIsolatedRuntime:async()=>{assert(s.model.name.startsWith('wasalx-simulation-'));assert.equal(typeof control,'function');}});
 const agent=await ensureNativeAgent(s);await agent.verify();
 return runNativeNeutralScenario({...s,origin:s.portalOrigin,runId:namespace+'-other',connectionId,groupId:configured.groupId,externalGroupId,nativePage:agent.page,providerControl:control,nativeQuality:async current=>{
  const marker='Synthetic other connection ID '+String(1000000000+parseInt(createHash('sha256').update(namespace+'-other').digest('hex').slice(0,7),16));
  const message=await createNativeBusinessEmitter(current)('same-person',first.participant,marker,first.expected);let link,delivery;const until=Date.now()+120000;
  for(;;){link=(await s.scoped('SELECT zammad_ticket_id,zammad_article_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,message.externalMessageId]))[0];delivery=(await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND reply_to_message_id=$2',[connectionId,message.externalMessageId]))[0];if(link&&delivery?.state==='SENT')break;assert(!delivery||!['OUTCOME_UNKNOWN','FAILED_TERMINAL'].includes(delivery.state));assert(Date.now()<until,'Other connection effect unresolved; preserve guard');await new Promise(r=>setTimeout(r,300));}
  const provider=JSON.parse(await s.run('docker',[...dc,'exec','-T','waha-lifecycle','node','-e',"fetch('http://127.0.0.1:3000/__simulation/receipts',{headers:{'x-api-key':process.env.WAHA_API_KEY}}).then(r=>{if(!r.ok)throw Error('Receipt unavailable');return r.json()}).then(x=>process.stdout.write(JSON.stringify(x)))"]));assert.equal(provider.receipts.filter(x=>x.id===delivery.external_message_id).length,1);assert.equal(Number(delivery.attempts),1);
  const proof=await observeNicknameSurfaces({page:agent.page,groupId:configured.groupId,messageId:message.id,expected:first.expected,marker,link,checkpoint:s.checkpoint});assert(proof.identityPass&&proof.nativeNameMatches);assert(proof.contexts.every(c=>c.nameVisible&&c.reloadNameVisible!==false&&c.identityStable!==false));
  const [scopedMessage]=await s.scoped('SELECT tenant_id,connection_id,external_participant_id FROM normalized_messages WHERE id=$1',[message.id]);assert.equal(scopedMessage.tenant_id,s.tenantId);assert.equal(scopedMessage.connection_id,connectionId);assert.equal(scopedMessage.external_participant_id,first.participant);
  const result={testId:crossConnectionNicknameId,result:'passed',finishedAt:new Date().toISOString(),proof:{primary:{messageId:first.messageId,participant:first.participant,expected:first.expected,contexts:first.contexts,originalFinishedAt:prior.finishedAt},other:{connectionId,groupId:configured.groupId,messageId:message.id,...proof},sameTenantScoped:true,customerMergeNotRequired:true}};await s.checkpoint({phase:'cross-connection-nickname-result',...result});return result;
 }});
}
