import { createHash } from "node:crypto";
import { metaBillingDiagnosticFromResponses, type MetaBillingDiagnostic } from "./meta-billing-diagnostic.js";

/** Private, same-token read evidence. No party/card/liability claim is made. */
export type MetaAccountFundingProof = {
  schemaVersion: 1; accountId: string; observedOwnerBusinessId: string | null;
  primaryFundingId: string | null; status: "PRESENT" | "NONE" | "UNAVAILABLE";
  actualPayer: "UNVERIFIED"; observedAt: string; expiresAt: string; responseSha256: string;
  currency?:MetaAccountCurrencyObservation;
};
export function metaAccountFundingProof(accountId: string, ownerValue: unknown, fundingValue: unknown,
  now = new Date(),currencyInput?:{value:unknown;graphVersion:string}): { diagnostic: MetaBillingDiagnostic; funding: MetaAccountFundingProof } {
  if (!/^[0-9]{1,32}$/u.test(accountId)) throw new Error("Meta account context is unavailable");
  const diagnostic = metaBillingDiagnosticFromResponses(accountId, ownerValue, fundingValue);
  const owner = record(ownerValue), business = record(owner?.owner_business), funding = record(fundingValue);
  const observedOwnerBusinessId = typeof business?.id === "string" && /^[0-9]{1,32}$/u.test(business.id)
    && (owner?.id === undefined || owner.id === accountId) ? business.id : null;
  const primaryFundingId = diagnostic.paymentMethod === "PRESENT" ? funding!.primary_funding_id as string : null;
  const facts = {accountId, observedOwnerBusinessId, primaryFundingId, status: diagnostic.paymentMethod};
  return {diagnostic, funding: {schemaVersion: 1, ...facts, actualPayer: "UNVERIFIED", observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
    responseSha256: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
    ...(currencyInput?{currency:metaAccountCurrencyObservation(accountId,currencyInput.value,currencyInput.graphVersion,now)}:{})}};
}

/** Private optional account-node read. Requested attachment currency is never
 * an input. The pinned SDK v24.0.1 targets Graph v24.0; other versions retain
 * UNAVAILABLE until their contract is separately qualified. */
export type MetaAccountCurrencyObservation={schemaVersion:1;source:"META_WABA_NODE";identifierKind:"WABA_ID";accountId:string;
 state:"OBSERVED"|"NONE"|"UNAVAILABLE";currency:string|null;graphVersion:string;observedAt:string;expiresAt:string;responseSha256:string};
export function metaAccountCurrencyObservation(accountId:string,value:unknown,graphVersion:string,now=new Date()):MetaAccountCurrencyObservation{
 const v=record(value),currency=v?.currency;let state:MetaAccountCurrencyObservation["state"]="UNAVAILABLE",selected:string|null=null;
 if(graphVersion==="v24.0"&&v?.id===accountId){
  if(currency===null)state="NONE";
  else if(typeof currency==="string"&&/^[A-Z]{3}$/u.test(currency)&&Intl.supportedValuesOf("currency").includes(currency)){state="OBSERVED";selected=currency;}
 }
 const facts={schemaVersion:1 as const,source:"META_WABA_NODE" as const,identifierKind:"WABA_ID" as const,accountId,state,currency:selected,graphVersion};
 return{...facts,observedAt:now.toISOString(),expiresAt:new Date(now.getTime()+15*60_000).toISOString(),
  responseSha256:createHash("sha256").update(JSON.stringify(facts)).digest("hex")};
}

export type MetaBillingSnapshot = MetaAccountPolicyBirthV2 | {schemaVersion:1;claim:"LEGACY_UNATTRIBUTED"} | {
  schemaVersion:1;claim:"ACCOUNT_POLICY_BOUND";tenantId:string;connectionId:string;accountId:string;
  providerAccountId:string;identifierKind:"MESSAGING_ACCOUNT_ID";bindingId:string;bindingRevision:number;
  accountAuthorityRevision:number;policyVersionId:string;mode:"CUSTOMER";actualPayer:"UNVERIFIED";
  fundingResponseSha256:string|null;fundingObservedAt:string|null;
};
export function parseMetaBillingSnapshot(value: unknown): MetaBillingSnapshot {
  const v = record(value);
  if(v?.schemaVersion===2)return parseMetaAccountPolicyBirthV2(value);
  if (v?.schemaVersion === 1 && v.claim === "LEGACY_UNATTRIBUTED" && Object.keys(v).length === 2)
    return {schemaVersion:1,claim:"LEGACY_UNATTRIBUTED"};
  if (!v || Object.keys(v).length!==15 || v.schemaVersion !== 1 || v.claim !== "ACCOUNT_POLICY_BOUND" || v.identifierKind !== "MESSAGING_ACCOUNT_ID"
    || v.mode !== "CUSTOMER" || v.actualPayer !== "UNVERIFIED"
    || ![v.tenantId,v.connectionId,v.accountId,v.bindingId,v.policyVersionId].every(uuid)
    || typeof v.providerAccountId !== "string" || !/^[0-9]{1,32}$/u.test(v.providerAccountId)
    || !positive(v.bindingRevision) || !positive(v.accountAuthorityRevision)
    || !(v.fundingResponseSha256 === null || typeof v.fundingResponseSha256 === "string" && /^[a-f0-9]{64}$/u.test(v.fundingResponseSha256))
    || !(v.fundingObservedAt === null || typeof v.fundingObservedAt === "string" && Number.isFinite(Date.parse(v.fundingObservedAt))))
    throw new Error("Meta billing attribution is unavailable");
  return v as MetaBillingSnapshot;
}
function record(v:unknown):Record<string,unknown>|undefined{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:undefined;}
function uuid(v:unknown):v is string{return typeof v==="string"&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(v);}
function positive(v:unknown):v is number{return typeof v==="number"&&Number.isSafeInteger(v)&&v>0;}


/** Digest domains are deliberately distinct from semantic and wire-body SHA. */
export const META_JSONB_EVIDENCE_FORMAT = "pg-jsonb-text-v1" as const;
export type MetaJsonbEvidenceDigest = {format:typeof META_JSONB_EVIDENCE_FORMAT;sha256:string};
export type MetaActualRequestExecution =
 | {mode:"UNKNOWN";runtimeEvidenceReceiptId:null;runtimeEvidenceSha256:null;transportBindingSha256:null}
 | {mode:"LIVE"|"SIMULATED";runtimeEvidenceReceiptId:string;runtimeEvidenceSha256:string;transportBindingSha256:string};
export type MetaManagedHistoricalAuthority = {
 arrangementVersionId:string;arrangementKind:"OWN_SOLUTION_PARTNER_LINE"|"MULTI_PARTNER_SOLUTION";
 payerAuthorityVersionId:string;effectiveScopeSha256:string;allocationLineVersionId:string;
 commercialTermsVersionId:string;evidenceMode:"LIVE"|"SIMULATED";
};
export type MetaAccountPolicyBirthV2 = {
 schemaVersion:2;claim:"ACCOUNT_POLICY_BOUND";tenantId:string;connectionId:string;accountId:string;providerAccountId:string;
 identifierKind:"MESSAGING_ACCOUNT_ID";accountModel:"PHASE1_WABA_ALIAS";bindingId:string;bindingRevision:number;
 accountAuthorityRevision:number;policyVersionId:string;
 payment:{mode:"CUSTOMER";actualPayer:"UNVERIFIED";managed:null}
  | {mode:"MANAGED";actualPayer:"APPROVED_SOLUTION_PARTNER";managed:MetaManagedHistoricalAuthority};
 funding:{responseSha256:string|null;observedAt:string|null};
};
export type MetaMessageAdmissionV2 = {
 schemaVersion:2;claim:"MESSAGES_REQUEST_ADMITTED";attemptId:string;attemptNumber:number;deliveryId:string;
 admittedAt:string;requestSha256:string;birthDigest:MetaJsonbEvidenceDigest|null;snapshot:MetaBillingSnapshot|null;
 execution:MetaActualRequestExecution;funding:{responseSha256:string|null;observedAt:string|null;expiresAt:string|null};
 /** Actual final Graph route fact, independent of billing authority. Absent only on older evidence. */
 requestPhoneNumberId?:string;
 providerContext?:MetaMessageProviderContext|null;
};
export type MetaMessageProviderContext={schemaVersion:1;mapping:"PHASE1_WABA_ALIAS_VERIFIED_BINDING";phoneNumberId:string;
 envelopeAccount:{identifierKind:"WABA_ID";id:string};messagingAccount:{identifierKind:"MESSAGING_ACCOUNT_ID";id:string};
 bindingId:string;bindingRevision:number;proofSha256:string;currencyEvidence:{operationId:string;observation:MetaAccountCurrencyObservation}|null};
export type HistoricalEffectAssessment =
 | {state:"ATTRIBUTED";effect:{tenantId:string;deliveryId:string;attemptId:string;attemptNumber:number;externalMessageId:string;
      admissionDigest:MetaJsonbEvidenceDigest;correlation:"UNIQUE_KNOWN_SUCCESS"};admission:MetaMessageAdmissionV2}
 | {state:"UNKNOWN_ATTRIBUTION";reason:"NO_UNIQUE_SUCCESS"|"MISSING_ADMISSION"|"REDACTED_EVIDENCE"|"CONFLICTING_EVIDENCE"};
// Frozen consumer-contract names; P10 imports this SSOT rather than redefining it.
export type JsonbEvidenceDigest=MetaJsonbEvidenceDigest;
export type ActualRequestExecution=MetaActualRequestExecution;
export type ManagedHistoricalAuthority=MetaManagedHistoricalAuthority;
export type AccountPolicyBirthV2=MetaAccountPolicyBirthV2;
export type AccountPolicyMessageAdmissionV2=MetaMessageAdmissionV2;

export function parseMetaActualRequestExecution(value:unknown):MetaActualRequestExecution {
 const v=record(value);billingKeys(v,["mode","runtimeEvidenceReceiptId","runtimeEvidenceSha256","transportBindingSha256"]);
 if(v!.mode==="UNKNOWN") {
  if(v!.runtimeEvidenceReceiptId!==null||v!.runtimeEvidenceSha256!==null||v!.transportBindingSha256!==null)billingInvalid();
 }else if((v!.mode!=="LIVE"&&v!.mode!=="SIMULATED")||!uuid(v!.runtimeEvidenceReceiptId)||!billingSha(v!.runtimeEvidenceSha256)||!billingSha(v!.transportBindingSha256))billingInvalid();
 return v as MetaActualRequestExecution;
}
export function parseMetaAccountPolicyBirthV2(value:unknown):MetaAccountPolicyBirthV2 {
 const v=record(value);billingKeys(v,["schemaVersion","claim","tenantId","connectionId","accountId","providerAccountId","identifierKind","accountModel","bindingId","bindingRevision","accountAuthorityRevision","policyVersionId","payment","funding"]);
 if(v!.schemaVersion!==2||v!.claim!=="ACCOUNT_POLICY_BOUND"||v!.identifierKind!=="MESSAGING_ACCOUNT_ID"||v!.accountModel!=="PHASE1_WABA_ALIAS"
   ||![v!.tenantId,v!.connectionId,v!.accountId,v!.bindingId,v!.policyVersionId].every(uuid)
   ||typeof v!.providerAccountId!=="string"||!/^[0-9]{1,32}$/u.test(v!.providerAccountId)
   ||!positive(v!.bindingRevision)||!positive(v!.accountAuthorityRevision))billingInvalid();
 const payment=record(v!.payment);billingKeys(payment,["mode","actualPayer","managed"]);
 if(payment!.mode==="CUSTOMER"){
  if(payment!.actualPayer!=="UNVERIFIED"||payment!.managed!==null)billingInvalid();
 }else if(payment!.mode==="MANAGED"&&payment!.actualPayer==="APPROVED_SOLUTION_PARTNER"){
  const managed=record(payment!.managed);billingKeys(managed,["arrangementVersionId","arrangementKind","payerAuthorityVersionId","effectiveScopeSha256","allocationLineVersionId","commercialTermsVersionId","evidenceMode"]);
  if(![managed!.arrangementVersionId,managed!.payerAuthorityVersionId,managed!.allocationLineVersionId,managed!.commercialTermsVersionId].every(uuid)
   ||!["OWN_SOLUTION_PARTNER_LINE","MULTI_PARTNER_SOLUTION"].includes(String(managed!.arrangementKind))
   ||!billingSha(managed!.effectiveScopeSha256)||!["LIVE","SIMULATED"].includes(String(managed!.evidenceMode)))billingInvalid();
 }else billingInvalid();
 const funding=record(v!.funding);billingKeys(funding,["responseSha256","observedAt"]);
 if(!billingNullableSha(funding!.responseSha256)||!billingNullableInstant(funding!.observedAt))billingInvalid();
 return v as MetaAccountPolicyBirthV2;
}
export function parseMetaMessageAdmissionV2(value:unknown):MetaMessageAdmissionV2 {
 const v=record(value);billingKeys(v,["schemaVersion","claim","attemptId","attemptNumber","deliveryId","admittedAt","requestSha256","birthDigest","snapshot","execution","funding",...(v&&Object.hasOwn(v,"providerContext")?["providerContext"]:[]),...(v&&Object.hasOwn(v,"requestPhoneNumberId")?["requestPhoneNumberId"]:[])]);
 if(v!.schemaVersion!==2||v!.claim!=="MESSAGES_REQUEST_ADMITTED"||!uuid(v!.attemptId)||!uuid(v!.deliveryId)||!positive(v!.attemptNumber)
   ||!billingInstant(v!.admittedAt)||!billingSha(v!.requestSha256))billingInvalid();
 if(Object.hasOwn(v!,"requestPhoneNumberId")&&(typeof v!.requestPhoneNumberId!=="string"||!/^[0-9]{1,32}$/u.test(v!.requestPhoneNumberId)))billingInvalid();
 const snapshot=v!.snapshot===null?null:parseMetaBillingSnapshot(v!.snapshot);
 if(snapshot===null){if(v!.birthDigest!==null)billingInvalid();}else parseMetaJsonbEvidenceDigest(v!.birthDigest);
 const execution=parseMetaActualRequestExecution(v!.execution);
 if((snapshot===null||snapshot.claim==="LEGACY_UNATTRIBUTED")&&execution.mode!=="UNKNOWN")billingInvalid();
 if(snapshot?.schemaVersion===2&&snapshot.payment.mode==="MANAGED"&&execution.mode!==snapshot.payment.managed.evidenceMode)billingInvalid();
 const funding=record(v!.funding);billingKeys(funding,["responseSha256","observedAt","expiresAt"]);
 if(!billingNullableSha(funding!.responseSha256)||!billingNullableInstant(funding!.observedAt)||!billingNullableInstant(funding!.expiresAt))billingInvalid();
 if(v!.providerContext!==undefined&&v!.providerContext!==null){
  const context=parseMetaMessageProviderContext(v!.providerContext);
  if(v!.requestPhoneNumberId!==undefined&&context.phoneNumberId!==v!.requestPhoneNumberId)billingInvalid();
  if(snapshot?.claim!=="ACCOUNT_POLICY_BOUND"||context.bindingId!==snapshot.bindingId||context.bindingRevision!==snapshot.bindingRevision
   ||context.messagingAccount.id!==snapshot.providerAccountId)billingInvalid();
 }
 return v as MetaMessageAdmissionV2;
}
export function parseMetaMessageProviderContext(value:unknown):MetaMessageProviderContext{
 const v=record(value);billingKeys(v,["schemaVersion","mapping","phoneNumberId","envelopeAccount","messagingAccount","bindingId","bindingRevision","proofSha256","currencyEvidence"]);
 const numeric=(x:unknown)=>typeof x==="string"&&/^[0-9]{1,32}$/u.test(x);
 if(v!.schemaVersion!==1||v!.mapping!=="PHASE1_WABA_ALIAS_VERIFIED_BINDING"||!numeric(v!.phoneNumberId)||!uuid(v!.bindingId)||!positive(v!.bindingRevision)||!billingSha(v!.proofSha256))billingInvalid();
 const envelope=record(v!.envelopeAccount),messaging=record(v!.messagingAccount);billingKeys(envelope,["identifierKind","id"]);billingKeys(messaging,["identifierKind","id"]);
 if(envelope!.identifierKind!=="WABA_ID"||messaging!.identifierKind!=="MESSAGING_ACCOUNT_ID"||!numeric(envelope!.id)||messaging!.id!==envelope!.id)billingInvalid();
 if(v!.currencyEvidence!==null){
  const receipt=record(v!.currencyEvidence);billingKeys(receipt,["operationId","observation"]);if(!uuid(receipt!.operationId))billingInvalid();
  const c=record(receipt!.observation);billingKeys(c,["schemaVersion","source","identifierKind","accountId","state","currency","graphVersion","observedAt","expiresAt","responseSha256"]);
  if(c!.schemaVersion!==1||c!.source!=="META_WABA_NODE"||c!.identifierKind!=="WABA_ID"||c!.accountId!==envelope!.id
    ||!billingInstant(c!.observedAt)||!billingInstant(c!.expiresAt)||!billingSha(c!.responseSha256)||typeof c!.graphVersion!=="string"
    ||!/^v[0-9]{1,3}\.[0-9]{1,2}$/u.test(c!.graphVersion)||!["OBSERVED","NONE","UNAVAILABLE"].includes(String(c!.state)))billingInvalid();
  if(c!.state==="OBSERVED"?(c!.graphVersion!=="v24.0"||typeof c!.currency!=="string"||!Intl.supportedValuesOf("currency").includes(c!.currency)):c!.currency!==null)billingInvalid();
  if(c!.state==="NONE"&&c!.graphVersion!=="v24.0")billingInvalid();
  if(Date.parse(c!.expiresAt as string)-Date.parse(c!.observedAt as string)!==15*60_000)billingInvalid();
 }
 return v as MetaMessageProviderContext;
}
export function parseMetaJsonbEvidenceDigest(value:unknown):MetaJsonbEvidenceDigest {
 const v=record(value);billingKeys(v,["format","sha256"]);
 if(v!.format!==META_JSONB_EVIDENCE_FORMAT||!billingSha(v!.sha256))billingInvalid();return v as MetaJsonbEvidenceDigest;
}
export function parseHistoricalEffectAssessment(value:unknown):HistoricalEffectAssessment {
 const v=record(value);
 if(v?.state==="UNKNOWN_ATTRIBUTION"){
  billingKeys(v,["state","reason"]);
  if(!["NO_UNIQUE_SUCCESS","MISSING_ADMISSION","REDACTED_EVIDENCE","CONFLICTING_EVIDENCE"].includes(String(v.reason)))billingInvalid();
 }else{
  billingKeys(v,["state","effect","admission"]);if(v!.state!=="ATTRIBUTED")billingInvalid();
  const admission=parseMetaMessageAdmissionV2(v!.admission),effect=record(v!.effect);
  billingKeys(effect,["tenantId","deliveryId","attemptId","attemptNumber","externalMessageId","admissionDigest","correlation"]);
  if(!uuid(effect!.tenantId)||effect!.deliveryId!==admission.deliveryId||effect!.attemptId!==admission.attemptId||effect!.attemptNumber!==admission.attemptNumber
    ||effect!.correlation!=="UNIQUE_KNOWN_SUCCESS"||typeof effect!.externalMessageId!=="string"||effect!.externalMessageId.length<1||effect!.externalMessageId.length>512||Array.from(effect!.externalMessageId).some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))billingInvalid();
  parseMetaJsonbEvidenceDigest(effect!.admissionDigest);
  if(admission.snapshot?.claim==="ACCOUNT_POLICY_BOUND"&&admission.snapshot.tenantId!==effect!.tenantId)billingInvalid();
 }
 return v as HistoricalEffectAssessment;
}
function billingKeys(v:Record<string,unknown>|undefined,keys:readonly string[]):void {
 if(!v||Object.keys(v).length!==keys.length||keys.some(key=>!Object.hasOwn(v,key)))billingInvalid();
}
function billingSha(v:unknown):v is string{return typeof v==="string"&&/^[a-f0-9]{64}$/u.test(v);}
function billingInstant(v:unknown):v is string {
 if(typeof v!=="string")return false;
 // Preserve producer bytes: PostgreSQL emits explicit offsets and up to six
 // fractional digits; JavaScript emits millisecond Z. This is validation only.
 const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(v);
 if(!parts||!Number.isFinite(Date.parse(v)))return false;
 const [year,month,day,hour,minute,second]=parts.slice(1,7).map(Number);
 if(month<1||month>12||day<1||hour>23||minute>59||second>59)return false;
 const calendar=new Date(0);calendar.setUTCFullYear(year,month-1,day);
 return calendar.getUTCFullYear()===year&&calendar.getUTCMonth()===month-1&&calendar.getUTCDate()===day;
}
function billingNullableSha(v:unknown){return v===null||billingSha(v);}
function billingNullableInstant(v:unknown){return v===null||billingInstant(v);}
function billingInvalid():never{throw new Error("Historical Meta payment evidence is unavailable");}

/** The supported installed simulator uses direct fetch only. A proxy URL digest
 * is not proof of the effective Graph destination. No values are exposed. */
export function assertMetaDirectTransportStartup(env:Readonly<Record<string,string|undefined>>,execArgs:readonly string[]):void {
 const routes=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"];
 if(routes.some(key=>!!env[key]) || !!env.NODE_USE_ENV_PROXY
  || !!env.NODE_OPTIONS || env.NODE_TLS_REJECT_UNAUTHORIZED==="0"
  || execArgs.some(arg=>/^(?:--use-env-proxy|--import|--require)(?:=|$)/u.test(arg)||arg==="-r"))
  throw new Error("Meta direct transport is unavailable");
}
