import type { MetaTemplateInventoryItem } from './meta-template-inventory.js';
import {evaluateMetaTransitionPreview} from './meta-account-transition-preview.js';
import {isMetaTransitionCurrency,type MetaTransitionPreviewRequest,type MetaTransitionPreviewReason} from './meta-account-transition-contract.js';
import type {MetaTransitionContext} from './meta-account-transition-context.js';

export type MetaTransitionObservation={schemaVersion:1;state:'PREVIEW'|'BLOCKED';current:{declaredMode:'CUSTOMER'|'WASALX_MANAGED'|'UNSELECTED';actualPayer:'UNVERIFIED';currency:string|null};
  impact:{phoneInventory:'COMPLETE'|'INCOMPLETE'|'UNAVAILABLE';externalPhoneCount:number|null;sourceTemplateCount:number|null;affectedFlowVersionCount:number|null;templateCompatibility:'NOT_ASSESSED'};
  reasons:MetaTransitionPreviewReason[];observedAt:string;expiresAt:string;canExecute:false};
type Inventory={sourceAccountId:string;currency:string|null;phoneIds:ReadonlyArray<string>;phonesComplete:boolean;templatesComplete:boolean;templates:ReadonlyArray<MetaTemplateInventoryItem>};
export function metaTransitionObservation(request:MetaTransitionPreviewRequest,ctx:MetaTransitionContext|null,inventory:Inventory|null,now=new Date()):MetaTransitionObservation{
  const exact=ctx!==null&&inventory?.sourceAccountId===ctx.providerAccountId;
  const complete=exact&&inventory.phonesComplete;
  const templatesComplete=exact&&inventory.templatesComplete===true&&Array.isArray(inventory.templates)&&inventory.templates.length<=2000;
  const phoneSet=new Set(exact?inventory.phoneIds:[]);
  const localSet=new Set(ctx?.phoneIds??[]);
  const localCurrent=complete&&[...localSet].every(id=>phoneSet.has(id))
    &&ctx!.scope.every(b=>b.bindingState==='ACTIVE'&&b.ownershipState==='ACTIVE'&&['WORKING','PAUSED'].includes(String(b.connectionState))
      &&['WORKING','PAUSED'].includes(String(b.sessionState))&&b.secretReference===b.currentSecretReference&&b.proofCurrent===true);
  const external=complete?[...phoneSet].filter(id=>!localSet.has(id)).length:null;
  const evaluated=evaluateMetaTransitionPreview(request,{currency:exact?inventory.currency:null,
    coexistence:'UNVERIFIED',authorizedAgent:'UNVERIFIED',adminAuthority:'UNVERIFIED',providerVersion:'UNQUALIFIED',
    phoneInventory:complete?'COMPLETE':inventory?'INCOMPLETE':'UNAVAILABLE',externalPhoneCount:external,
    localScopeCurrent:localCurrent,sourceTemplatesComplete:templatesComplete,managedArrangement:'UNAVAILABLE',readsAvailable:exact,bindingCurrent:ctx!==null});
  return{schemaVersion:1,...evaluated,current:{declaredMode:ctx?.declaredMode??'UNSELECTED',actualPayer:'UNVERIFIED',currency:exact?inventory.currency:null},
    impact:{phoneInventory:complete?'COMPLETE':inventory?'INCOMPLETE':'UNAVAILABLE',externalPhoneCount:external,sourceTemplateCount:templatesComplete?inventory.templates.length:null,
      affectedFlowVersionCount:ctx?new Set([...ctx.templateDependencies,...ctx.metaFlowDependencies].map(d=>d.flowVersionId)).size:null,templateCompatibility:'NOT_ASSESSED'},
    observedAt:now.toISOString(),expiresAt:new Date(now.getTime()+15*60_000).toISOString(),canExecute:false};
}
const reasonSet=new Set<MetaTransitionPreviewReason>(['CURRENCY_UNKNOWN','SAME_CURRENCY_TRANSITION_UNSUPPORTED','ACCOUNT_VARIANT_UNVERIFIED',
  'COEXISTENCE_UNSUPPORTED','AUTHORIZED_AGENT_UNSUPPORTED','ADMIN_AUTHORITY_UNVERIFIED','PROVIDER_VERSION_UNQUALIFIED','PHONE_SCOPE_INCOMPLETE',
  'EXTERNAL_PHONE_IMPACT','LOCAL_SCOPE_CHANGED','TEMPLATE_INVENTORY_INCOMPLETE','MANAGED_ARRANGEMENT_UNAVAILABLE','MANAGED_ARRANGEMENT_STALE',
  'PROVIDER_READ_UNAVAILABLE','CURRENT_BINDING_CHANGED']);
function row(v:unknown):Record<string,unknown>|undefined{return v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;}
const count=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
/** Explicit projection prevents private scope/credential fields reaching the portal. */
export function publicMetaTransitionObservation(value:unknown):MetaTransitionObservation|null{
  const v=row(value),current=row(v?.current),impact=row(v?.impact);
  if(!v||!current||!impact||v.schemaVersion!==1||!['PREVIEW','BLOCKED'].includes(String(v.state))||v.canExecute!==false
    ||!['CUSTOMER','WASALX_MANAGED','UNSELECTED'].includes(String(current.declaredMode))||current.actualPayer!=='UNVERIFIED'
    ||!(current.currency===null||isMetaTransitionCurrency(current.currency))||!Array.isArray(v.reasons)
    ||v.reasons.some(reason=>!reasonSet.has(reason as MetaTransitionPreviewReason))
    ||typeof v.observedAt!=='string'||!Number.isFinite(Date.parse(v.observedAt))||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||Date.parse(v.expiresAt)<=Date.parse(v.observedAt)
    ||!['COMPLETE','INCOMPLETE','UNAVAILABLE'].includes(String(impact.phoneInventory)))return null;
  return{schemaVersion:1,state:v.state as MetaTransitionObservation['state'],canExecute:false,
    current:{declaredMode:current.declaredMode as MetaTransitionObservation['current']['declaredMode'],actualPayer:'UNVERIFIED',currency:current.currency as string|null},
    impact:{phoneInventory:impact.phoneInventory as MetaTransitionObservation['impact']['phoneInventory'],externalPhoneCount:count(impact.externalPhoneCount),
      sourceTemplateCount:count(impact.sourceTemplateCount),affectedFlowVersionCount:count(impact.affectedFlowVersionCount),templateCompatibility:'NOT_ASSESSED'},
    reasons:[...v.reasons] as MetaTransitionPreviewReason[],observedAt:v.observedAt,expiresAt:v.expiresAt};
}
