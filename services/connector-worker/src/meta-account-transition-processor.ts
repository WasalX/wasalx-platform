import {MetaGroupsAdapter} from '../../../packages/connectors/src/meta.js';
import {assertMetaCredentialProof} from '../../../packages/core/src/meta-account-relation.js';
import {metaTransitionObservation} from '../../../packages/core/src/meta-account-transition-observation.js';
import {ConnectionOperationLeaseLostError,type ConnectionOperationJob,type ConnectionOperationStore,type MetaTransitionReadFrame} from './connection-operation-repository.js';

/** Dedicated read operation: never enters lifecycle applyOutcome or funding completion. */
export async function processMetaAccountTransitionPreview(job:ConnectionOperationJob,leaseId:string,store:ConnectionOperationStore,
  resolveToken:()=>Promise<string>,appId:string,graphVersion:string|undefined):Promise<'succeeded'|'lease-lost'>{
  let frame:MetaTransitionReadFrame|undefined;
  try{
    frame=await store.guardMetaTransitionPreview(job,leaseId,appId);
    if(!frame.context){await store.completeMetaTransitionPreview(job,leaseId,appId,metaTransitionObservation(frame.request,null,null));return'succeeded';}
    const initial=frame.context,token=await resolveToken(),proof=initial.session.providerStateData.metaAccountProof as {graphVersion?:unknown};
    if(typeof proof?.graphVersion!=='string'||!/^v\d{1,3}\.\d{1,3}$/u.test(proof.graphVersion)
      ||typeof graphVersion!=='string'||proof.graphVersion!==graphVersion)throw new Error('META_TRANSITION_VERSION_UNAVAILABLE');
    const adapter=new MetaGroupsAdapter({accessToken:token,graphVersion:proof.graphVersion,
      phoneNumberIdFor:()=>initial.session.opaqueSessionId,wabaIdFor:()=>initial.providerAccountId,
      beforeRequest:async()=>{const next=await store.guardMetaTransitionPreview(job,leaseId,appId);
        if(!next.context||next.context.scopeSha256!==initial.scopeSha256
          ||!assertMetaCredentialProof(next.context.session.providerStateData.metaAccountProof,{appId,accessToken:token}))
          throw new Error('META_TRANSITION_CONTEXT_CHANGED');
        frame=next;}});
    const inventory=await adapter.transitionPreviewInventory(initial.providerAccountId);
    await store.completeMetaTransitionPreview(job,leaseId,appId,metaTransitionObservation(frame.request,frame.context,inventory));
    return'succeeded';
  }catch(error){
    if(error instanceof ConnectionOperationLeaseLostError)return'lease-lost';
    if(!frame)throw error;
    // No provider mutation occurred; record one unavailable observation. A new
    // explicit refresh is required after changed prerequisites, never an auto retry.
    try{await store.completeMetaTransitionPreview(job,leaseId,appId,metaTransitionObservation(frame.request,frame.context,null));return'succeeded';}
    catch(finalError){if(finalError instanceof ConnectionOperationLeaseLostError)return'lease-lost';throw finalError;}
  }
}
