import type {MetaGroupsAdapter} from '../../../packages/connectors/src/meta.js';
import {ProviderError} from '../../../packages/connectors/src/types.js';
import {assertMetaCredentialProof, sameMetaConnectionBinding, type MetaAccountProof} from '../../../packages/core/src/meta-account-relation.js';
import type {ConnectionOperationJob, OperationCompletion} from './connection-operation-repository.js';

/** This branch is intentionally GET-only: access is neither registration nor subscription authority. */
export async function readMetaAddAccessActivation(job:ConnectionOperationJob, adapter:MetaGroupsAdapter,
  appId:string, graphVersion:string, credentialFingerprint:string):Promise<OperationCompletion> {
  const session=job.providerSession, data=session?.providerStateData ?? {};
  const signup=data.metaSignup as {purpose?:string;attemptId?:string;businessId?:string;phoneId?:string;wabaId?:string;graphVersion?:string}|undefined;
  const successor=data.metaAccountTransition as {purpose?:string;id?:string}|undefined;
  const successorMode=successor?.purpose==='ACCOUNT_SUCCESSOR';
  const admission=job.payload.metaAddAccessActivation as Record<string,unknown>|undefined;
  const proof=data.metaAccountProof as MetaAccountProof|undefined;
  if (job.operationType!=='START' || !session
    || (!successorMode && (signup?.purpose!=='ADD_ACCESS' || !signup.attemptId || !signup.businessId
      || signup.phoneId!==session.opaqueSessionId || signup.wabaId!==data.wabaId || signup.graphVersion!==graphVersion))
    || (successorMode && (!successor.id || admission?.setupPurpose!=='ACCOUNT_SUCCESSOR'
      || admission.accountTransitionId!==successor.id || typeof admission.identityReceiptSha256!=='string'
      || !/^[a-f0-9]{64}$/.test(admission.identityReceiptSha256)))
    || !admission || admission.schemaVersion!==1 || admission.providerSessionId!==session.id
    || admission.phoneNumberId!==session.opaqueSessionId || admission.wabaId!==data.wabaId || admission.appId!==appId
    || !proof || proof.tenantId!==job.tenantId || proof.connectionId!==job.connectionId || proof.graphVersion!==graphVersion
    || proof.claim!=='PHONE_ACCOUNT_RELATION_VERIFIED' || proof.schemaVersion!==1
    || !sameMetaConnectionBinding(proof,{secretReference:job.connectionSecretReference,providerSessionId:session.id,phoneNumberId:session.opaqueSessionId,wabaId:String(data.wabaId)})
    || !assertMetaCredentialProof(proof,{appId,credentialFingerprint})) throw held('META_ADD_ACCESS_ACTIVATION_CHANGED');
  // The adapter's existing beforeRequest verifies live operation/session leases,
  // current funding/configuration and the exact token proof before EACH GET.
  await adapter.verifyPhoneAccountRelationship(job.connectionId);
  if(!successorMode)await adapter.verifySignupOwner(job.connectionId,signup!.businessId!);
  const phone=await adapter.signupPhone(job.connectionId);
  if(phone.mode!=='STANDARD'||phone.numberState!=='REGISTERED')throw held('META_ADD_ACCESS_PHONE_CHANGED');
  const readiness=await adapter.signupReadiness(job.connectionId,appId);
  if(!readiness.subscribed||!['AVAILABLE','LIMITED'].includes(readiness.messaging))throw held('META_ADD_ACCESS_PROVIDER_SETUP_REQUIRED');
  return {connectionState:'WORKING',providerState:'AVAILABLE',engine:'CLOUD_API',actionReason:null,webhookState:'ACTIVE',
    // Keep P08's exact proof bytes and immutable ADD_ACCESS provenance. No OWN,
    // identity alias, payer fact or new provider subscription is manufactured.
    providerStateData:data,
    result:{metaAddAccessActivated:true,providerReadback:{registered:true,subscribed:true,messaging:readiness.messaging},
      conversationPermission:'SEPARATE_REQUIRED'}};
}
function held(code:string){return new ProviderError('Saved account access changed or needs provider setup. The connection remains paused.',false,code);}
