/** Browser-safe closed payment intent. Authority is always resolved by the API/SQL. */
export type MetaTariffAcceptance={tariffVersionId:string;tariffDefinitionSha256:string;documentSha256:string;acceptedTerms:true};
type CustomerSelection={mode:'CUSTOMER';expectedRevision:number};
type ManagedSelection={mode:'MANAGED';expectedRevision:number;choiceId:string;documentSha256:string;acceptedTerms:true};
export type MetaPolicySelection=CustomerSelection|(CustomerSelection&MetaTariffAcceptance)|ManagedSelection|(ManagedSelection&MetaTariffAcceptance);
export type MetaTariffQuery={tariffMode:'CUSTOMER'|'MANAGED';choiceId?:string;tariffAfter?:string};
export type MetaTariffOffer={id:string;definitionSha256:string;documentSha256:string;documentText:string;
 evidenceMode:'LIVE'|'SIMULATED';currency:string;minorUnits:number;timezone:string;effectiveFrom:string;effectiveTo:string;
 rounding:'LINE'|'PERIOD';product:'CLOUD_API';unit:'DELIVERED_MESSAGE';pricingModel:'PMP';policyFamily:'ORDINARY_BUSINESS_MESSAGING';
 rates:Array<{category:string;pricingType:string;billable:boolean;schedule:string;market:string;tier:string;unitPrice:string}>};
export type MetaTariffPage={items:MetaTariffOffer[];nextAfter:string|null};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function parseMetaPolicySelection(value:unknown):MetaPolicySelection {
 if(!object(value))throw new Error('Invalid payment intent');
 const v=value;
 if(typeof v.expectedRevision!=='number'||!Number.isSafeInteger(v.expectedRevision)||v.expectedRevision<0)throw new Error('Invalid payment intent');
 const tariff=Object.hasOwn(v,'tariffVersionId')||Object.hasOwn(v,'tariffDefinitionSha256');
 const keys=['mode','expectedRevision',...(v.mode==='MANAGED'?['choiceId','documentSha256','acceptedTerms']:tariff?['documentSha256','acceptedTerms']:[]),...(tariff?['tariffVersionId','tariffDefinitionSha256']:[])];
 if((v.mode!=='CUSTOMER'&&v.mode!=='MANAGED')||!exact(v,keys)
  ||(v.mode==='MANAGED'&&!uuid(v.choiceId))
  ||((v.mode==='MANAGED'||tariff)&&(!sha(v.documentSha256)||v.acceptedTerms!==true))
  ||(tariff&&(!uuid(v.tariffVersionId)||!sha(v.tariffDefinitionSha256)||v.expectedRevision<1)))throw new Error('Invalid payment intent');
 return v as MetaPolicySelection;
}
export function parseMetaTariffQuery(value:unknown):MetaTariffQuery|null {
 if(!object(value))throw new Error('Invalid payment query');
 if(!Object.keys(value).length)return null;
 if((value.tariffMode!=='CUSTOMER'&&value.tariffMode!=='MANAGED')
  ||!exact(value,['tariffMode',...(value.tariffMode==='MANAGED'?['choiceId']:[]),...(Object.hasOwn(value,'tariffAfter')?['tariffAfter']:[])])
  ||(value.tariffMode==='MANAGED'&&!uuid(value.choiceId))||(Object.hasOwn(value,'tariffAfter')&&!uuid(value.tariffAfter)))throw new Error('Invalid payment query');
 return value as MetaTariffQuery;
}
export function metaTariffQueryString(value:MetaTariffQuery|null):string {
 if(!value)return '';
 return '?'+new URLSearchParams({tariffMode:value.tariffMode,...(value.choiceId?{choiceId:value.choiceId}:{}),...(value.tariffAfter?{tariffAfter:value.tariffAfter}:{})}).toString();
}

/** An unreadable post-forward response is an uncertain outcome, never success. */
export function isMetaPolicyAcceptanceResult(body:MetaPolicySelection,value:unknown):boolean {
 if(!object(value))return false;
 if(body.mode==='CUSTOMER'&&!('tariffVersionId' in body))return object(value.operation)&&uuid(value.operation.id)
  &&value.operation.type==='VERIFY_META_BILLING'&&typeof value.operation.state==='string'&&typeof value.duplicate==='boolean';
 return value.requestedMode===body.mode&&value.state==='HELD'&&value.sendReady===false&&typeof value.replay==='boolean';
}
