import type {MetaTransitionExecutionAction,MetaTransitionExecutionView} from '../packages/core/src/meta-account-transition-contract';

const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const sha=/^[0-9a-f]{64}$/u;
const actions=['INITIATE','COMPLETE','OBSERVE','RECONCILE'];
const states=['UNPREPARED','RESERVED','INITIATED','READY_TO_COMPLETE','PROVIDER_COMPLETED','RECONCILED_PAUSED','HELD'];
const operationStates=['QUEUED','RUNNING','SUCCEEDED','FAILED_TERMINAL','CANCELLED'];
const providerStates=['INITIATED','ACCEPTED','IN_PROGRESS','READY_TO_COMPLETE','COMPLETED','FAILED','FAILED_TO_COMPLETE','REJECTED'];
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const revision=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const timestamp=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
const currency=(v:unknown)=>typeof v==='string'&&/^[A-Z]{3}$/u.test(v);
const terms=(v:unknown)=>v===null||record(v)&&typeof v.documentText==='string'&&new TextEncoder().encode(v.documentText).length>=1
  &&new TextEncoder().encode(v.documentText).length<=32_768&&typeof v.documentSha256==='string'&&sha.test(v.documentSha256)
  &&typeof v.version==='string'&&/^[A-Za-z0-9._-]{1,128}$/u.test(v.version);
function pendingAction(v:unknown):v is NonNullable<MetaTransitionExecutionView['pendingAction']>{
  return record(v)&&typeof v.operationId==='string'&&uuid.test(v.operationId)
    &&typeof v.requestKey==='string'&&uuid.test(v.requestKey)
    &&actions.includes(v.action as string)&&operationStates.includes(v.state as string)&&revision(v.requestRevision);
}

/** Validate the mutation-bearing projection before enabling an action. Unknown reasons are display-only. */
export function isMetaTransitionExecutionView(v:unknown):v is MetaTransitionExecutionView {
  if(!record(v)||!revision(v.revision)||!states.includes(v.state as string)
    ||!(v.previewSha256===null||typeof v.previewSha256==='string'&&sha.test(v.previewSha256))
    ||!['CUSTOMER','WASALX_MANAGED'].includes(v.requestedMode as string)||!currency(v.targetCurrency)||!terms(v.terms)
    ||!(v.sourceCurrency===null||currency(v.sourceCurrency))
    ||typeof v.completionApprovalRequired!=='boolean'||!Array.isArray(v.renewals)
    ||!v.renewals.every(item=>record(item)&&typeof item.connectionId==='string'&&uuid.test(item.connectionId)
      &&typeof item.name==='string'&&typeof item.canPrepare==='boolean'&&['ORIGINAL','RENEWED'].includes(item.access as string))
    ||new Set(v.renewals.map(item=>(item as Record<string,unknown>).connectionId)).size!==v.renewals.length
    ||typeof v.impactConnectionCount!=='number'||!Number.isSafeInteger(v.impactConnectionCount)||v.impactConnectionCount<0
    ||!record(v.actions)||!['initiate','complete','observe','reconcile','cancel'].every(key=>typeof (v.actions as Record<string,unknown>)[key]==='boolean')
    ||!Array.isArray(v.reasons)||v.reasons.length>32||!v.reasons.every(reason=>typeof reason==='string'&&reason.length<=80)
    ||!(v.providerStatus===null||providerStates.includes(v.providerStatus as string))
    ||!(v.observedAt===null||timestamp(v.observedAt))||!Array.isArray(v.history)||v.history.length>100
    ||!v.history.every(item=>record(item)&&['INITIATE','COMPLETE'].includes(item.stage as string)
      &&['ATTEMPTED','SUCCEEDED','REJECTED','UNKNOWN'].includes(item.outcome as string)&&timestamp(item.attemptedAt)))return false;
  return v.pendingAction===null||pendingAction(v.pendingAction);
}

/** Non-secret, tab-local uncertainty marker. It never authorizes a replay. */
export type MetaTransitionIntent={schemaVersion:1;action:MetaTransitionExecutionAction;requestRevision:number;previewSha256:string;key:string;operationId:string|null};
export function metaTransitionIntentKey(connectionId:string,planId:string){return `wasalx:meta-transition:v1:${connectionId}:${planId}`;}
export function parseMetaTransitionIntent(raw:string|null):MetaTransitionIntent|null {
  if(raw===null)return null;
  if(raw.length>1024)throw new Error('META_TRANSITION_INTENT_UNAVAILABLE');
  let v:unknown;try{v=JSON.parse(raw);}catch{throw new Error('META_TRANSITION_INTENT_UNAVAILABLE');}
  if(!record(v)||Object.keys(v).length!==6||v.schemaVersion!==1||!actions.includes(v.action as string)
    ||!revision(v.requestRevision)||typeof v.previewSha256!=='string'||!sha.test(v.previewSha256)
    ||typeof v.key!=='string'||!uuid.test(v.key)||!(v.operationId===null||typeof v.operationId==='string'&&uuid.test(v.operationId)))
    throw new Error('META_TRANSITION_INTENT_UNAVAILABLE');
  return v as MetaTransitionIntent;
}
export function metaTransitionIntentSettled(intent:MetaTransitionIntent,view:unknown):boolean {
  if(!isMetaTransitionExecutionView(view))return false;
  const action=view.pendingAction;
  return metaTransitionPendingActionMatches(intent,action)
    &&['SUCCEEDED','FAILED_TERMINAL','CANCELLED'].includes(action.state);
}
export function metaTransitionPendingActionMatches(intent:MetaTransitionIntent,value:unknown):value is NonNullable<MetaTransitionExecutionView['pendingAction']>{
  return pendingAction(value)&&value.action===intent.action&&value.requestRevision===intent.requestRevision
    &&value.requestKey===intent.key
    &&(intent.operationId===null||value.operationId===intent.operationId);
}
