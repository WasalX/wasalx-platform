import {createHash} from "node:crypto";
import {MetaGroupsAdapter} from "../../../packages/connectors/src/meta.js";
import {ProviderError} from "../../../packages/connectors/src/types.js";
import {assertMetaCredentialProof} from "../../../packages/core/src/meta-account-relation.js";
import type {MetaActualRequestExecution,MetaAccountFundingProof} from "../../../packages/core/src/meta-account-policy.js";
import type {MetaBillingDiagnostic} from "../../../packages/core/src/meta-billing-diagnostic.js";
import type {ConnectionOperationJob} from "./connection-operation-repository.js";
import type {SecretResolver} from "./secrets.js";
import {currentMetaTransportBinding} from "./meta-transport-binding.js";
import {currentMetaRuntimeCandidate,type MetaRuntimeEvidenceCandidate} from "./meta-request-provenance.js";

export type ManagedFundingContext={accountId:string;messagingAccountId:string;connectionSecretReference:string;phoneNumberId:string;accountProof:unknown;
 arrangementVersionId:string;kind:"OWN_SOLUTION_PARTNER_LINE"|"MULTI_PARTNER_SOLUTION";appId:string;holderBusinessId:string;creditLineId:string;
 solutionId:string|null;receivingBusinessId:string;financialSecretReference:string;financialCredentialFingerprint:string;financialCredentialMetadata:unknown;
 graphVersion:string;currency:string;evidenceMode:"LIVE"|"SIMULATED"};
export type FinancialCheckpoint={checkpointId:string;outcome:"ATTEMPTED"|"SUCCEEDED"|"REJECTED"|"UNKNOWN";
 result:{allocationConfigId:string;messagingAccountId:string}|{reason:string}|null};
export type FundingReservation={disposition:"NEW_ATTEMPT";checkpointId:string;reservationToken:string}
 |{disposition:"HISTORICAL_NO_POST";checkpointId:string;outcome:FinancialCheckpoint["outcome"]};
export interface ManagedFundingStore{
 managedFundingContext(job:ConnectionOperationJob,leaseId:string,appId:string):Promise<ManagedFundingContext>;
 managedFundingCheckpoint(job:ConnectionOperationJob):Promise<FinancialCheckpoint|undefined>;
 resolveFinancialExecution(job:ConnectionOperationJob,context:ManagedFundingContext,candidate:MetaRuntimeEvidenceCandidate|undefined,transportSha:string):Promise<MetaActualRequestExecution>;
 reserveManagedFunding(job:ConnectionOperationJob,leaseId:string,requestSha:string,execution:MetaActualRequestExecution):Promise<FundingReservation>;
 recordFinancialResponse(job:ConnectionOperationJob,reservation:Extract<FundingReservation,{disposition:"NEW_ATTEMPT"}>,outcome:"SUCCEEDED"|"REJECTED"|"UNKNOWN",result:unknown):Promise<void>;
 recordAllocationReadback(job:ConnectionOperationJob,leaseId:string,checkpointId:string,readback:unknown):Promise<boolean>;
}
export type ManagedFundingObservation={diagnostic:MetaBillingDiagnostic;funding:MetaAccountFundingProof};
// Internal dependency seam for deterministic simulated qualification. Public
// callers never choose a mode: restricted SQL still resolves the exact receipt.
export type ManagedFundingDependencies={
 readTransport:(graphVersion:string)=>Promise<{transportBindingSha256:string}>;
 readRuntime:(input:{graphVersion:string;transportBindingSha256:string})=>Promise<MetaRuntimeEvidenceCandidate|undefined>;
};
const held=()=>new ProviderError("Approved funding access is held.",false,"META_CREDIT_NOT_ATTEMPTED",undefined,true);

/** Only the existing leased, platform-admitted funding dispatcher calls this.
 * Its result is finalized by incumbent operation-only diagnostic completion.
 * It never changes connection/session state and never automatically revokes. */
export async function executeMetaManagedFunding(job:ConnectionOperationJob,leaseId:string,appId:string,store:ManagedFundingStore,secrets:SecretResolver,dependencies:ManagedFundingDependencies={readTransport:currentMetaTransportBinding,readRuntime:currentMetaRuntimeCandidate}):Promise<ManagedFundingObservation>{
 const context=await store.managedFundingContext(job,leaseId,appId);
 const connectionSecret=await secrets.resolve(context.connectionSecretReference,{kind:"meta-connection",tenantId:job.tenantId,connectionId:job.connectionId});
 const financialSecret=await secrets.resolve(context.financialSecretReference,{kind:"exact",expectedReference:context.financialSecretReference});
 const accountToken=connectionSecret.accessToken??connectionSecret.token??connectionSecret.value;
 const financialToken=financialSecret.accessToken??financialSecret.token??financialSecret.value;
 if(!accountToken||!financialToken||createHash("sha256").update(financialToken).digest("hex")!==context.financialCredentialFingerprint)throw held();
 const guard=async()=>{
  const current=await store.managedFundingContext(job,leaseId,appId);
  // The server's immutable operation and current row must still select these
  // exact secrets, app, semantic asset and approval version on every request.
  if(JSON.stringify(current)!==JSON.stringify(context))throw held();
  try{
   if(!assertMetaCredentialProof(current.accountProof,{appId,accessToken:accountToken}))throw held();
   const metadata=assertMetaCredentialProof({credentialFingerprint:context.financialCredentialFingerprint,credentialMetadata:context.financialCredentialMetadata},
   {appId,accessToken:financialToken,purpose:"FINANCIAL"});
   if(!metadata?.scopes.includes("business_management"))throw held();
  }catch{throw held();}
 };
 const accountAdapter=new MetaGroupsAdapter({accessToken:accountToken,graphVersion:context.graphVersion,
  phoneNumberIdFor:()=>context.phoneNumberId,wabaIdFor:()=>context.messagingAccountId,beforeRequest:guard});
 let reservation:Extract<FundingReservation,{disposition:"NEW_ATTEMPT"}>|undefined;
 const financialAdapter=new MetaGroupsAdapter({accessToken:financialToken,graphVersion:context.graphVersion,
  phoneNumberIdFor:()=>context.phoneNumberId,wabaIdFor:()=>context.messagingAccountId,beforeRequest:guard,
  beforeFinancialMutation:async requestSha=>{
   const transport=await dependencies.readTransport(context.graphVersion);
   const candidate=await dependencies.readRuntime({graphVersion:context.graphVersion,transportBindingSha256:transport.transportBindingSha256});
   const execution=await store.resolveFinancialExecution(job,context,candidate,transport.transportBindingSha256);
   if(execution.mode!==context.evidenceMode)throw held();
   // Runtime/transport preparation awaits external local inputs. Recheck the
   // exact tokens and expiring metadata after it, before the atomic SQL fence.
   await guard();
   const admitted=await store.reserveManagedFunding(job,leaseId,requestSha,execution);
   if(admitted.disposition!=="NEW_ATTEMPT")throw held();
   reservation=admitted;
  }});
 let checkpoint=await store.managedFundingCheckpoint(job);
 if(checkpoint&&checkpoint.outcome!=="SUCCEEDED")throw held();
 if(!checkpoint){
  // These are diagnostic reads. They still require original account access and
  // current financial credential; funding readiness never bypasses those gates.
  const lines=await financialAdapter.readExtendedCreditLines(context.holderBusinessId);
  if(!lines.includes(context.creditLineId))throw held();
  if(context.kind==="MULTI_PARTNER_SOLUTION"){
   if(!context.solutionId)throw held();
   await financialAdapter.readPartnerSolutionAuthority(context.solutionId,appId);
  }
  const before=await accountAdapter.billingAccountProof(context.messagingAccountId);
  if(before.funding.status!=="NONE"||before.funding.observedOwnerBusinessId!==context.receivingBusinessId)throw held();
  let attached:{allocationConfigId:string;messagingAccountId:string};
  try{
   attached=await financialAdapter.attachApprovedCreditLine(context.creditLineId,context.messagingAccountId,context.currency);
  }catch(error){
   if(reservation){
    const known=error instanceof ProviderError&&error.outcomeKnown===true;
    await store.recordFinancialResponse(job,reservation,known?"REJECTED":"UNKNOWN",
     {reason:known?"KNOWN_PROVIDER_REJECTION":"PROVIDER_OUTCOME_UNRESOLVED"});
   }
   throw error;
  }
  if(!reservation)throw held();
  // A database finalization error must not reclassify a known provider success.
  // The durable ATTEMPTED slot still forbids replay if this write is uncertain.
  await store.recordFinancialResponse(job,reservation,"SUCCEEDED",attached);
  checkpoint={checkpointId:reservation.checkpointId,outcome:"SUCCEEDED",result:attached};
 }
 // A completed original checkpoint can continue read-only reconciliation. It
 // cannot obtain another POST slot, even on replacement lease or request key.
 const result=checkpoint.result;
 if(!result||!("allocationConfigId" in result)||result.messagingAccountId!==context.messagingAccountId)throw held();
 const allocation=await financialAdapter.readCreditAllocation(result.allocationConfigId);
 const owning=await financialAdapter.readOwningCreditAllocation(context.creditLineId,context.receivingBusinessId,result.allocationConfigId);
 const observed=await accountAdapter.billingAccountProof(context.messagingAccountId);
 if(observed.funding.primaryFundingId!==allocation.receivingCredential||observed.funding.observedOwnerBusinessId!==context.receivingBusinessId)throw held();
 const retained=await store.recordAllocationReadback(job,leaseId,checkpoint.checkpointId,{allocationConfigId:result.allocationConfigId,
  receivingCredential:allocation.receivingCredential,receivingBusinessId:owning.receivingBusinessId,creditLineId:context.creditLineId,fundingProof:observed.funding});
 if(!retained)throw held();
 return observed;
}
