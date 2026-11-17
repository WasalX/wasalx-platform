import { metaBillingDiagnosticBinding, metaBillingDiagnosticProofCurrent } from './meta-billing-diagnostic.js';
import { assertMetaCredentialProof, assertMetaLifecycleAccess, metaLifecyclePayloadSha256 } from './meta-account-relation.js';
import { parseBotFlow } from './bot-flow.js';
import type { MetaTransitionRequestedMode } from './meta-account-transition-contract.js';

export type MetaTransitionContext = {
  tenantId:string; connectionId:string; actorId:string; appId:string; accountId:string; providerAccountId:string;
  accountRevision:number; bindingId:string; bindingRevision:number;
  declaredMode:MetaTransitionRequestedMode|'UNSELECTED'; secretReference:string;
  session:{id:string;opaqueSessionId:string;providerStateData:Record<string,unknown>};
  bindingProofSha256:string; credentialFingerprint:string;
  scope:ReadonlyArray<Record<string,unknown>>; flows:ReadonlyArray<Record<string,unknown>>;
  scopeSha256:string; phoneIds:ReadonlyArray<string>; connectionIds:ReadonlyArray<string>;
  templateDependencies:ReadonlyArray<{flowVersionId:string;name:string;language:string;parameterCount:number}>;
  metaFlowDependencies:ReadonlyArray<{flowVersionId:string;providerFlowId:string}>;
};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(v);
function row(v:unknown):Record<string,unknown>|undefined{return v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;}
function revision(v:unknown):number{const n=typeof v==='string'?Number(v):v;if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1)throw new Error('META_TRANSITION_CONTEXT_UNAVAILABLE');return n;}

/** The input comes only from the tenant-scoped SQL context, never a request body. */
export function metaTransitionContext(value:unknown, expected:{tenantId:string;connectionId:string;actorId:string;appId:string;accessToken?:string}):MetaTransitionContext {
  const v=row(value),session=row(v?.session),data=row(session?.providerStateData);
  if(!v||!session||!data||v.tenantId!==expected.tenantId||v.connectionId!==expected.connectionId||v.actorId!==expected.actorId
    ||![v.accountId,v.bindingId,session.id].every(uuid)||typeof v.secretReference!=='string'||!v.secretReference.startsWith('secret://')
    ||typeof v.providerAccountId!=='string'||!/^\d{1,32}$/u.test(v.providerAccountId)
    ||typeof session.opaqueSessionId!=='string'||!/^\d{1,32}$/u.test(session.opaqueSessionId)
    ||!Array.isArray(v.scope)||v.scope.length===0||v.scope.length>2000||!Array.isArray(v.flows)||v.flows.length>2000)
    throw new Error('META_TRANSITION_CONTEXT_UNAVAILABLE');
  const currentSession={id:session.id as string,opaqueSessionId:session.opaqueSessionId,providerStateData:data};
  const diagnostic=metaBillingDiagnosticBinding(v.secretReference,currentSession,expected.appId);
  if(diagnostic.lifecycleRevision===null)throw new Error('META_TRANSITION_CONTEXT_UNAVAILABLE');
  assertMetaLifecycleAccess(Object.hasOwn(data,'metaLifecycle')?data.metaLifecycle:undefined);
  const proof=row(data.metaAccountProof);
  if(diagnostic.wabaId!==v.providerAccountId||diagnostic.proofSha256!==v.canonicalProofSha256
    ||typeof v.bindingProofSha256!=='string'||!/^[a-f0-9]{64}$/u.test(v.bindingProofSha256)||v.bindingProofSha256!==v.sessionProofSha256
    ||!metaBillingDiagnosticProofCurrent(diagnostic,proof,expected)
    ||proof?.credentialFingerprint!==v.credentialFingerprint
    ||!assertMetaCredentialProof(proof,{appId:expected.appId,...(expected.accessToken?{accessToken:expected.accessToken}:{})}))
    throw new Error('META_TRANSITION_CONTEXT_UNAVAILABLE');
  const scope:MetaTransitionContext['scope']=v.scope.map(item=>{const r=row(item);if(!r||!uuid(r.connectionId)||!uuid(r.bindingId)||typeof r.phoneNumberId!=='string'
    ||!/^\d{1,32}$/u.test(r.phoneNumberId))throw new Error('META_TRANSITION_SCOPE_UNAVAILABLE');
    let proofCurrent=false;const state=row(r.providerStateData);
    if(state&&uuid(r.providerSessionId)&&typeof r.secretReference==='string')try{
      const bound=metaBillingDiagnosticBinding(r.secretReference,{id:r.providerSessionId,opaqueSessionId:r.phoneNumberId,providerStateData:state},expected.appId);
      proofCurrent=r.appId===expected.appId&&bound.wabaId===v.providerAccountId&&bound.proofSha256===r.canonicalProofSha256
        &&typeof r.proofSha256==='string'&&/^[a-f0-9]{64}$/u.test(r.proofSha256)&&r.proofSha256===r.sessionProofSha256
        &&row(state.metaAccountProof)?.credentialFingerprint===r.credentialFingerprint
        &&metaBillingDiagnosticProofCurrent(bound,state.metaAccountProof,{tenantId:expected.tenantId,connectionId:r.connectionId});
      assertMetaLifecycleAccess(Object.hasOwn(state,'metaLifecycle')?state.metaLifecycle:undefined);
    }catch{proofCurrent=false;}
    return{...r,proofCurrent};});
  const dependencies:MetaTransitionContext['templateDependencies'][number][]=[];
  const metaFlows:MetaTransitionContext['metaFlowDependencies'][number][]=[];
  const flows=v.flows.map(item=>{const f=row(item);if(!f||!uuid(f.id)||typeof f.snapshotSha256!=='string'||!/^[a-f0-9]{64}$/u.test(f.snapshotSha256))
    throw new Error('META_TRANSITION_SCOPE_UNAVAILABLE');const parsed=parseBotFlow(f.definition);
    for(const node of parsed.nodes){
      if(node.type==='send_template')dependencies.push({flowVersionId:f.id,name:node.templateName,language:node.languageCode,parameterCount:node.bodyParameters.length});
      if(node.type==='whatsapp_flow')metaFlows.push({flowVersionId:f.id,providerFlowId:node.flowId});
    }
    return f;});
  const accountRevision=revision(v.accountRevision),bindingRevision=revision(v.bindingRevision);
  return {tenantId:expected.tenantId,connectionId:expected.connectionId,actorId:expected.actorId,appId:expected.appId,accountId:v.accountId as string,
    providerAccountId:v.providerAccountId,accountRevision,bindingId:v.bindingId as string,bindingRevision,
    declaredMode:v.declaredMode==='CUSTOMER'?'CUSTOMER':v.declaredMode==='MANAGED'?'WASALX_MANAGED':'UNSELECTED',
    secretReference:v.secretReference,session:currentSession,bindingProofSha256:diagnostic.proofSha256,
    credentialFingerprint:v.credentialFingerprint as string,scope,flows,scopeSha256:metaLifecyclePayloadSha256({accountRevision,bindingRevision,scope,
      flows:flows.map(f=>({id:f.id,snapshotSha256:f.snapshotSha256}))}),
    phoneIds:[...new Set(scope.map(r=>r.phoneNumberId as string))].sort(),connectionIds:[...new Set(scope.map(r=>r.connectionId as string))].sort(),
    templateDependencies:dependencies,metaFlowDependencies:metaFlows};
}
