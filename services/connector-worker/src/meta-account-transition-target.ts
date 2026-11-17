import {createHash} from 'node:crypto';
import {MetaGroupsAdapter} from '../../../packages/connectors/src/meta.js';
import {assertMetaCredentialProof,type MetaAccountProof} from '../../../packages/core/src/meta-account-relation.js';
import type {MetaAccountFundingProof} from '../../../packages/core/src/meta-account-policy.js';
import type {MetaMigrationObservation} from '../../../packages/connectors/src/meta-account-transition-execute.js';
import type {MetaTransitionExecutionContext} from './meta-account-transition-execution.js';
import type {ConnectionOperationJob} from './connection-operation-repository.js';
import type {SecretResolver} from './secrets.js';

export type MetaTransitionTargetAsset={sourceBindingId:string;sourceBindingRevision:number;connectionId:string;providerSessionId:string;
 phoneNumberId:string;appId:string;secretReference:string;credentialFingerprint:string;observerOperationId:string|null;accountProof:MetaAccountProof};
export type MetaTransitionTargetObservation=MetaMigrationObservation & {observedAt:string;targetAssets:MetaTransitionTargetAsset[];
 cloneAccess:null|{claim:'CLONE_ACCOUNT_ACCESS_VERIFIED';accountId:string;appId:string;currency:string;verifiedAt:string;responseSha256:string;credentialFingerprint:string;observerOperationId:string|null};
 targetReadiness:{assets:'VERIFIED'|'CLONE_ACCESS_VERIFIED'|'UNAVAILABLE';payment:'VERIFIED'|'UNAVAILABLE';templates:'VERIFIED'|'UNAVAILABLE';continuity:'SAME_GRAPH_PHONE_IDS'|'ORIGINAL_PHONE_SCOPE_RESERVED'|'UNAVAILABLE'};
 fundingProof:MetaAccountFundingProof|null;allocationProof:{allocationConfigId:string;receivingBusinessId:string;receivingCredential:string;creditLineId:string}|null};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');

/** The same credential that proves each exact source binding proves the target.
 * Every call is a GET. No subscription, registration, attach or automatic repair.
 * A partial target read is retained as unavailable, not converted to readiness. */
export async function readMetaTransitionTarget(job:ConnectionOperationJob,context:MetaTransitionExecutionContext,
 observation:MetaMigrationObservation,secrets:SecretResolver,guard:()=>Promise<unknown>):Promise<MetaTransitionTargetObservation>{
 const result:MetaTransitionTargetObservation={...observation,observedAt:new Date().toISOString(),targetAssets:[],cloneAccess:null,fundingProof:null,allocationProof:null,
  targetReadiness:{assets:'UNAVAILABLE',payment:'UNAVAILABLE',templates:'UNAVAILABLE',continuity:'UNAVAILABLE'}};
 if(!observation.destination)return result;
 const scope=context.scope.bindings;
 if(scope.length<1||scope.length>2000)throw new Error('Transition scope is unavailable.');
 try {
 for(const source of [...scope].sort((a,b)=>a.connectionId===job.connectionId?-1:b.connectionId===job.connectionId?1:0)){
  await guard();
  if(!Object.hasOwn(context.observers,source.id))throw new Error('Pinned observer provenance is unavailable.');
  const observer=context.observers[source.id];
  if(observer&&(observer.appId!==source.appId||observer.phoneNumberId!==source.phoneId))throw new Error('Pinned observer asset changed.');
  const reference=observer?.secretReference??source.secretReference,fingerprint=observer?.credentialFingerprint??source.fingerprint;
  const credentialProof=observer?.accountProof??source.providerState.metaAccountProof;
  const secret=await secrets.resolve(reference,{kind:'meta-connection',tenantId:job.tenantId,connectionId:source.connectionId});
  const token=secret.accessToken??secret.token??secret.value;
  if(!token||hash(token)!==fingerprint)throw new Error('Transition credential changed.');
  const metadata=assertMetaCredentialProof(credentialProof,{appId:source.appId,accessToken:token});
  if(!metadata)throw new Error('Transition credential metadata is unavailable.');
  const adapter=new MetaGroupsAdapter({accessToken:token,graphVersion:context.graphVersion,phoneNumberIdFor:()=>source.phoneId,
   wabaIdFor:()=>observation.destination!.id,beforeRequest:async()=>{await guard();
    if(!assertMetaCredentialProof(credentialProof,{appId:source.appId,accessToken:token}))throw new Error('Transition credential metadata expired.');}});
  if(observation.status!=='COMPLETED'){
   // The original immutable local hierarchy scope and captured provider clone
   // are separate from final phone membership. No unfinished-clone health gate.
   result.cloneAccess={...await adapter.transitionCloneAccess(observation.destination.id,source.appId,context.targetCurrency),
    credentialFingerprint:fingerprint,observerOperationId:observer?.operationId??null};
   result.fundingProof=(await adapter.billingAccountProof(observation.destination.id)).funding;
   result.targetReadiness.assets='CLONE_ACCESS_VERIFIED';result.targetReadiness.continuity='ORIGINAL_PHONE_SCOPE_RESERVED';
   break;
  }
  const relation=await adapter.verifyPhoneAccountRelationship(source.connectionId);
  const ready=await adapter.signupReadiness(source.connectionId,source.appId);
  if(!ready.subscribed||!['AVAILABLE','LIMITED'].includes(ready.messaging))throw new Error('Target app access is unavailable.');
  const proof:MetaAccountProof={...relation,credentialMetadata:metadata,tenantId:job.tenantId,connectionId:source.connectionId,
   providerSessionId:source.sessionId,phoneNumberId:source.phoneId,wabaId:observation.destination.id,
   secretReference:reference,credentialFingerprint:fingerprint,operationId:job.id,fencingToken:job.fencingToken};
  result.targetAssets.push({sourceBindingId:source.id,sourceBindingRevision:source.revision,connectionId:source.connectionId,
   providerSessionId:source.sessionId,phoneNumberId:source.phoneId,appId:source.appId,secretReference:reference,
   credentialFingerprint:fingerprint,observerOperationId:observer?.operationId??null,accountProof:proof});
  if(result.fundingProof===null){
   const inventory=await adapter.transitionPreviewInventory(observation.destination.id);
   const expected=new Set(scope.map(item=>item.phoneId));
   if(!inventory.phonesComplete||inventory.currency!==context.targetCurrency||inventory.phoneIds.length!==expected.size
    ||inventory.phoneIds.some(id=>!expected.has(id)))throw new Error('Target phone inventory is incomplete or changed.');
   result.fundingProof=(await adapter.billingAccountProof(observation.destination.id)).funding;
  }
 }
 if(observation.status==='COMPLETED'){
  if(new Set(result.targetAssets.map(asset=>asset.phoneNumberId)).size!==scope.length)throw new Error('Target phone scope is ambiguous.');
  result.targetReadiness.assets='VERIFIED';result.targetReadiness.continuity='SAME_GRAPH_PHONE_IDS';
 }
 // The exact source/target dependency review is retained separately and is
 // rechecked in SQL. A matching name or source template count is insufficient.
 if(context.targetDependenciesCurrent)result.targetReadiness.templates='VERIFIED';
 if(result.fundingProof?.status==='PRESENT'&&context.requestedMode==='CUSTOMER')result.targetReadiness.payment='VERIFIED';
 if(result.fundingProof?.status==='PRESENT'&&context.requestedMode==='WASALX_MANAGED'&&context.financial){
  const f=context.financial;
  const secret=await secrets.resolve(f.secretReference,{kind:'exact',expectedReference:f.secretReference});
  const token=secret.accessToken??secret.token??secret.value;
  if(!token||hash(token)!==f.credentialFingerprint)throw new Error('Approved financial credential changed.');
  const financialGuard=async()=>{await guard();
   const metadata=assertMetaCredentialProof({credentialFingerprint:f.credentialFingerprint,credentialMetadata:f.credentialMetadata},
    {appId:context.appId,accessToken:token,purpose:'FINANCIAL'});
   if(!metadata?.scopes.includes('business_management'))throw new Error('Approved financial access is unavailable.');};
  const adapter=new MetaGroupsAdapter({accessToken:token,graphVersion:context.graphVersion,phoneNumberIdFor:()=>context.phoneNumberId,
   wabaIdFor:()=>observation.destination!.id,beforeRequest:financialGuard});
  const lines=await adapter.readExtendedCreditLines(f.holderBusinessId);
  if(!lines.includes(f.creditLineId))throw new Error('Approved financial holder changed.');
  if(f.solutionId)await adapter.readPartnerSolutionAuthority(f.solutionId,context.appId);
  result.allocationProof=await adapter.readDerivedCreditAllocation(f.creditLineId,f.receivingBusinessId,result.fundingProof.primaryFundingId!);
  result.targetReadiness.payment='VERIFIED';
 }
 } catch {
  // The migration GET remains a known observation even when an independent
  // target capability cannot yet be read. Never publish a partial asset proof.
  result.targetAssets=[];result.cloneAccess=null;result.fundingProof=null;result.allocationProof=null;
  result.targetReadiness={assets:'UNAVAILABLE',payment:'UNAVAILABLE',templates:'UNAVAILABLE',continuity:'UNAVAILABLE'};
 }
 // A lost lease/currentness failure is not an accepted partial observation.
 await guard();return result;
}
