import assert from 'node:assert/strict';
import {seedSyntheticGroup,createSyntheticRequest} from './seed-simulation-group.mjs';
import {runNativeNeutralScenario} from './simulation-native-neutral.mjs';
import {createNativeBusinessEmitter} from './simulation-native-business-batch.mjs';
import {lifecycleStage} from './simulation-lifecycle-stage.mjs';
import {ensurePortalOperator,readPortalOperation,portalOperatorContexts} from './simulation-portal-operator.mjs';
import {observePortalNicknameSurfaces} from './simulation-portal-group-observers.mjs';
import {portalGroupResult,sha} from './simulation-portal-groups.mjs';
import {originalCrossConnectionId,portalCrossConnectionNicknameId} from './simulation-portal-group-definitions.mjs';

export async function portalLifecycleStage(session,args){
 assert.equal(session.operatorSurface,'portal');assert.equal(args.config.retainedQ094,undefined,'Historical lifecycle adoption cannot become new portal proof');
 return lifecycleStage({...session,currentGroupCallbacks:{crossConnectionNickname:portalCrossConnectionNickname,crossConnectionTestId:portalCrossConnectionNicknameId,contextIds:portalOperatorContexts('agent','en').map(row=>row.contextId)}},args);
}

export async function portalCrossConnectionNickname({session:s,connectionId,control,dc,namespace,inputs}){
 const prior=inputs.nativeBusiness.results.find(row=>row.supersedesTestId?.endsWith('participant-nickname-consistency::refresh'));assert.equal(prior?.result,'passed');const first=prior.proof.refreshed;
 assert.equal(inputs.nativeBusiness.namespace,namespace);assert.equal(inputs.nativeBusiness.tenantId,s.tenantId);assert.notEqual(connectionId,inputs.group.connectionId);
 const externalGroupId=s.model.services['waha-lifecycle'].environment.WAHA_SIM_GROUP_ID;assert(externalGroupId&&externalGroupId!==inputs.group.groupRef);assert(/^[1-9][0-9]+@c\.us$/u.test(first.participant));
 const request=createSyntheticRequest({page:s.ownerPage,origin:s.portalOrigin,runId:namespace+'-other',checkpoint:s.checkpoint}),detail=await request('/api/connections/'+connectionId);assert.equal(detail.provider_state,'WORKING');assert.equal(detail.latest_operation_state,'SUCCEEDED');
 const binding=await request('/api/groups/'+inputs.group.groupId+'/binding'),rules=await request('/api/rule-sets'),rule=rules.find(row=>row.id===binding.rule_set_id);assert.equal(rule?.state,'ACTIVE');
 const catalogs=await request('/api/zammad/routing-catalogs'),target=catalogs.groups.find(row=>String(row.id)===String(binding.zammad_group_id));assert(target?.active&&target.serviceIdentityCanCreate);
 const configured=await seedSyntheticGroup({page:s.ownerPage,origin:s.portalOrigin,runId:namespace+'-other',externalGroupId,nativeGroupName:target.name,evidenceMode:'simulated',checkpoint:s.checkpoint,resumeConnection:{id:connectionId,name:detail.name},resumeRule:{id:rule.id,name:rule.name},assertIsolatedRuntime:async()=>{assert(s.model.name.startsWith('wasalx-simulation-'));assert.equal(typeof control,'function');}});
 const operator=await ensurePortalOperator(s,{role:'agent',viewport:{width:1440,height:1000}});
 return runNativeNeutralScenario({...s,operator,origin:s.portalOrigin,runId:namespace+'-other',connectionId,groupId:configured.groupId,externalGroupId,providerControl:control,
 catalogRead:async groupId=>({status:200,value:await readPortalOperation(operator,'GROUP_LIST',{scope:'ALL',selected:groupId})}),
 nativeQuality:async current=>{
  const startedAt=new Date().toISOString(),marker='Synthetic other connection ID '+String(1000000000+parseInt(sha(namespace+'-other').slice(0,7),16)),message=await createNativeBusinessEmitter(current)('same-person',first.participant,marker,first.expected);let link,delivery;const until=Date.now()+120000;
  for(;;){link=(await s.scoped('SELECT zammad_ticket_id,zammad_article_id FROM message_links WHERE connection_id=$1 AND external_message_id=$2',[connectionId,message.externalMessageId]))[0];delivery=(await s.scoped('SELECT id,state,attempts,external_message_id FROM delivery_outbox WHERE connection_id=$1 AND reply_to_message_id=$2',[connectionId,message.externalMessageId]))[0];if(link&&delivery?.state==='SENT')break;assert(!delivery||!['OUTCOME_UNKNOWN','FAILED_TERMINAL'].includes(delivery.state));assert(Date.now()<until,'Other connection effect unresolved; preserve guard');await new Promise(resolve=>setTimeout(resolve,300));}
  const provider=JSON.parse(await s.run('docker',[...dc,'exec','-T','waha-lifecycle','node','-e',"fetch('http://127.0.0.1:3000/__simulation/receipts',{headers:{'x-api-key':process.env.WAHA_API_KEY}}).then(r=>{if(!r.ok)throw Error('Receipt unavailable');return r.json()}).then(x=>process.stdout.write(JSON.stringify(x)))"]));assert.equal(provider.receipts.filter(row=>row.id===delivery.external_message_id).length,1);assert.equal(Number(delivery.attempts),1);
  const [source]=await s.scoped('SELECT tenant_id,connection_id,external_participant_id FROM normalized_messages WHERE id=$1',[message.id]);assert.equal(source.tenant_id,s.tenantId);assert.equal(source.connection_id,connectionId);assert.equal(source.external_participant_id,first.participant);
  const results=[];for(const context of portalOperatorContexts('agent','en')){
   await operator.page.setViewportSize(context.viewport);const observedAt=new Date().toISOString();let proof,result='passed';
   try{proof=await observePortalNicknameSurfaces({operator,groupId:configured.groupId,messageId:message.id,expected:first.expected,marker,link,checkpoint:s.checkpoint,viewports:[context.viewport]});assert(proof.identityPass&&proof.nativeNameMatches);assert(proof.contexts.every(row=>row.nameVisible&&row.reloadNameVisible!==false&&row.identityStable!==false));}
   catch(error){result='failed';proof={errorClass:error.name,errorSha256:sha(String(error.message))};}
   const row=await portalGroupResult(operator,{testId:originalCrossConnectionId,result,startedAt:observedAt,proof:{primary:{messageId:first.messageId,participant:first.participant,expected:first.expected,contexts:first.contexts,originalFinishedAt:prior.finishedAt},other:{connectionId,groupId:configured.groupId,messageId:message.id,...proof},sameTenantScoped:true,customerMergeNotRequired:true}});results.push(row);await s.checkpoint({phase:'portal-cross-connection-nickname',...row});
  }return{evidenceMode:'simulated',surface:'portal',startedAt,results};
 }});
}
