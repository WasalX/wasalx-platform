import {parseMetaPolicySelection,type MetaPolicySelection,type MetaTariffOffer} from '../packages/core/src/meta-billing-policy-contract.ts';
import type {MetaCustomerPolicyView} from './control-plane-data';
type Choice=NonNullable<MetaCustomerPolicyView['managedChoices']>[number];
export type BillingIntent={version:1;tenantId:string;actorId:string;connectionId:string;key:string;body:MetaPolicySelection;offer:MetaTariffOffer|null;choice:Choice|null};
export const billingIntentKey=(tenant:string,actor:string,connection:string)=>`wasalx.meta.payment-intent:${JSON.stringify([tenant,actor,connection])}`;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v);
const oneOf=(v:unknown,values:string[])=>values.some(item=>item===v);
const instant=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v)&&Number.isFinite(Date.parse(v));
/** Bounded non-secret disclosure only. Stored data never grants current authority.
 * Invalid storage is held rather than discarded and replaced by a fresh key. */
export function parseBillingIntent(raw:string|null,tenantId:string,actorId:string,connectionId:string):BillingIntent|null{
 if(raw===null)return null;
 if(raw.length>262144)throw new Error('PAYMENT_INTENT_STORAGE');
 const value:unknown=JSON.parse(raw);
 if(!object(value)||value.version!==1||value.tenantId!==tenantId||value.actorId!==actorId||value.connectionId!==connectionId||!uuid(value.key))throw new Error('PAYMENT_INTENT_STORAGE');
 const body=parseMetaPolicySelection(value.body),offer=value.offer,choice=value.choice;
 if(body.mode==='MANAGED'){
  if(!object(choice)||choice.choiceId!==body.choiceId||choice.documentSha256!==body.documentSha256||!text(choice.documentText,32768)
   ||!oneOf(choice.kind,['OWN_SOLUTION_PARTNER_LINE','MULTI_PARTNER_SOLUTION'])||!oneOf(choice.evidenceMode,['LIVE','SIMULATED'])||!text(choice.expiresAt,40)||!Number.isFinite(Date.parse(choice.expiresAt)))throw new Error('PAYMENT_INTENT_STORAGE');
 }else if(choice!==null)throw new Error('PAYMENT_INTENT_STORAGE');
 if('tariffVersionId' in body){
  if(!object(offer)||offer.id!==body.tariffVersionId||offer.definitionSha256!==body.tariffDefinitionSha256||offer.documentSha256!==body.documentSha256||!text(offer.documentText,32768)
   ||!oneOf(offer.evidenceMode,['LIVE','SIMULATED'])||typeof offer.currency!=='string'||!/^[A-Z]{3}$/u.test(offer.currency)
   ||typeof offer.minorUnits!=='number'||!Number.isInteger(offer.minorUnits)||offer.minorUnits<0||offer.minorUnits>3||!text(offer.timezone,256)
   ||!instant(offer.effectiveFrom)||!instant(offer.effectiveTo)||!oneOf(offer.rounding,['LINE','PERIOD'])
   ||offer.product!=='CLOUD_API'||offer.unit!=='DELIVERED_MESSAGE'||offer.pricingModel!=='PMP'||offer.policyFamily!=='ORDINARY_BUSINESS_MESSAGING'
   ||!Array.isArray(offer.rates)||offer.rates.length<1||offer.rates.length>128||!offer.rates.every(rate=>object(rate)
    &&oneOf(rate.category,['marketing','utility','authentication','service'])&&oneOf(rate.pricingType,['regular','free_customer_service','free_entry_point'])
    &&typeof rate.billable==='boolean'&&oneOf(rate.schedule,['ORDINARY','AUTHENTICATION_INTERNATIONAL'])&&text(rate.market,64)&&text(rate.tier,64)
    &&typeof rate.unitPrice==='string'&&/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$/u.test(rate.unitPrice)))throw new Error('PAYMENT_INTENT_STORAGE');
 }else if(offer!==null)throw new Error('PAYMENT_INTENT_STORAGE');
 return {...value,body} as BillingIntent;
}
