import {withOwnerEvidence} from './simulation-owner-evidence.mjs';
import {assertMetaRuntimeBinding} from './simulation-meta-producer.mjs';
import assert from 'node:assert/strict';
import {runDirectBatch} from './simulation-direct-flow.mjs';
import {runMetaDeliveryStatuses,validateStatusFixture} from './simulation-meta-status.mjs';
import {createSyntheticRequest} from './seed-simulation-group.mjs';
import {ensurePortalOperator,withPortalOperatorEvidence} from './simulation-portal-operator.mjs';
import {nativeLinkTestId} from './simulation-native-account-linking.mjs';
const requireFunctions=(object,names)=>{for(const name of names)assert.equal(typeof object?.[name],'function','Missing admitted callback '+name);};
function admitted(session,namespace){
 assert(/^[a-zA-Z0-9_-]{1,40}$/.test(namespace));
 assert(session.actorBinding?.userMatched&&session.actorBinding?.workspaceMatched);
 assert(session.model?.name?.startsWith('wasalx-simulation-'));
 assert(session.tenantId&&session.ownerPage&&session.portalOrigin);
 requireFunctions(session,['scoped','checkpoint']);
}
export async function directFlowStage(session,{namespace,inputs,config}){
 admitted(session,namespace);
 const f=inputs?.directConnection;
 assert(f?.evidenceMode==='simulated'&&f.provider==='WAHA');assert.equal(f.tenantId,session.tenantId);
 assert(typeof f.connectionId==='string'&&f.connectionId);assert(f.zammadGroupId);
 assert(Array.isArray(config?.chatIds)&&config.chatIds.length===2&&new Set(config.chatIds).size===2);
 for(const chat of config.chatIds)assert(/^\d{6,20}@c\.us$/.test(chat));
 assert(['ACTIVE','PAUSED'].includes(config.finalAssignmentState));assert(session.socketPath);
 const h=session.directCallbacks;requireFunctions(h,['nativeRead','observeReturningTicket','providerRead','drainEffects','assertIsolatedRuntime','control']);
 // Produced IDs must match the callbacks' independently admitted runtime, not just the tenant.
 const binding=h.binding;assert(binding&&f.runtimeBinding,'Missing admitted WAHA binding');
 for(const key of ['project','connectionId','providerSessionId','containerId','imageId','socketPath']){
  assert.equal(typeof binding[key],'string','Missing WAHA binding '+key);assert(binding[key].length);
  assert.equal(f.runtimeBinding[key],binding[key],'WAHA fixture/callback mismatch '+key);
 }
 assert.equal(binding.project,session.model.name);assert.equal(binding.connectionId,f.connectionId);
 assert.equal(binding.socketPath,session.socketPath);
 assert.equal(binding.containerId,session.containers?.['waha-gows']?.Id);
 assert.equal(binding.imageId,session.containers?.['waha-gows']?.Image);
 const isolationArgs={evidenceMode:'simulated',tenantId:session.tenantId,connectionId:f.connectionId,chatIds:config.chatIds,serializeGroupMutations:true};
 await h.assertIsolatedRuntime(isolationArgs);
 const execute=async()=>{
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:namespace,checkpoint:session.checkpoint});
 return runDirectBatch({request,scoped:session.scoped,control:h.control,checkpoint:session.checkpoint,
  assertIsolatedRuntime:h.assertIsolatedRuntime,
  nativeRead:h.nativeRead,observeReturningTicket:h.observeReturningTicket,providerRead:h.providerRead,drainEffects:h.drainEffects,tenantId:session.tenantId,connectionId:f.connectionId,zammadGroupId:f.zammadGroupId,
  chatIds:config.chatIds,runId:namespace,priorAssignmentDisposition:f.priorAssignmentDisposition??[],finalAssignmentState:config.finalAssignmentState,operatorSurface:session.operatorSurface});
 };
 if(session.operatorSurface==='portal'){
  const owner=await ensurePortalOperator(session,{role:'tenant_owner',viewport:{width:1440,height:1000}});
  return withPortalOperatorEvidence(owner,execute,{testIds:portalDirectFlowIds});
 }
 return withOwnerEvidence(session,execute);
}
export async function metaStatusStage(...args){return withOwnerEvidence(args[0],()=>metaStatusStageOperation(...args));}
async function metaStatusStageOperation(session,{namespace,inputs}){
 admitted(session,namespace);
 const f=validateStatusFixture(inputs?.metaDeliveries,namespace);assert.equal(f.tenantId,session.tenantId);
 const h=session.metaCallbacks;requireFunctions(h,['providerRead','postRaw','poll']);assert(h.cfg?.binding&&h.cfg.appSecret);assertMetaRuntimeBinding(f,h,session);
 assert(session.privateDir&&session.output);
 const request=createSyntheticRequest({page:session.ownerPage,origin:session.portalOrigin,runId:namespace,checkpoint:session.checkpoint});
 return runMetaDeliveryStatuses({ownerPage:session.ownerPage,portalOrigin:session.portalOrigin,privateDir:session.privateDir,output:session.output,runId:namespace,
  cfg:h.cfg,request,scoped:session.scoped,checkpoint:session.checkpoint,providerRead:h.providerRead,postRaw:h.postRaw,poll:h.poll,fixture:f});
}

export const portalDirectFlowIds=['human-ownership-suppresses-bot-replies','explicit-resume-restores-bot-ownership','returning-customer-reopens-same-ticket'].map(name=>'direct-automation/human-handoff-pause-resume-and-bot-return::'+name+'::01::portal');
export async function portalDirectFlowStage(session,args){
 assert.equal(session.operatorSurface,'portal');for(const key of ['directConnection','nativeAccountAccess','portalTeamAccess']){assert.equal(args.inputs?.[key]?.tenantId,session.tenantId,'Current '+key+' tenant required');assert.equal(args.inputs[key].namespace,args.namespace,'Current '+key+' namespace required');}
 assert(args.inputs.nativeAccountAccess.results?.some(row=>row.testId===nativeLinkTestId&&row.result==='passed'),'Explicit owner-approved account admission is required');
 const operator=await ensurePortalOperator(session,{role:'agent',viewport:{width:1440,height:1000}}),options=await operator.read('CREATE_OPTIONS',{group_id:String(args.inputs.directConnection.zammadGroupId)});
 assert(options.can_create&&options.groups?.some(group=>group.id===String(args.inputs.directConnection.zammadGroupId)),'The portal agent has no current create grant in the target team');
 return directFlowStage(session,args);
}
