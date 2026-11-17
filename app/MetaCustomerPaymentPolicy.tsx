"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {useI18n} from './I18nProvider';
import {MetaAccountTransitionPreview} from './MetaAccountTransitionPreview';
import {createLatestRequestFence} from '../lib/operator-ui';
import {localizedUiError,type UiErrorCode} from '../lib/ui-error';
import {metaTariffQueryString,parseMetaPolicySelection,isMetaPolicyAcceptanceResult,type MetaTariffQuery} from '../packages/core/src/meta-billing-policy-contract';
import {billingIntentKey,parseBillingIntent,type BillingIntent} from '../lib/meta-billing-policy-intent';
import type {MetaCustomerPolicyView} from '../lib/control-plane-data';
type Props={tenantId:string;actorId:string;connectionId:string;canConfigure:boolean;mutationHeaders:Record<string,string>;refreshKey:number};
export function MetaCustomerPaymentPolicy(props:Props){const {locale}=useI18n();return <CustomerPaymentPolicySession key={`${props.tenantId}:${props.actorId}:${props.connectionId}:${props.refreshKey}:${locale}`} {...props}/>;}
function CustomerPaymentPolicySession({tenantId,actorId,connectionId,canConfigure,mutationHeaders,refreshKey}:Props){
 const {t,locale}=useI18n(),scope=`${connectionId}:${refreshKey}:${locale}`;
 const [read,setRead]=useState<{scope:string;view:MetaCustomerPolicyView|null;error:{code:UiErrorCode;message:string}|null}>({scope:'',view:null,error:null});
 const [selected,setSelected]=useState(false),[choiceId,setChoiceId]=useState(''),[tariffId,setTariffId]=useState(''),[acceptedTerms,setAcceptedTerms]=useState(false);
 const [sending,setSending]=useState(false),[reading,setReading]=useState(false);
 const fence=useRef(createLatestRequestFence()),active=useRef<AbortController|null>(null),query=useRef<MetaTariffQuery|null>(null);
 const intent=useRef<BillingIntent|null>(null),writing=useRef(false);
 const [pendingIntent,setPendingIntent]=useState<BillingIntent|null>(null),[storageReady,setStorageReady]=useState(false),[storageFailed,setStorageFailed]=useState(false),[pageAfter,setPageAfter]=useState<string|null>(null);
 const storageKey=billingIntentKey(tenantId,actorId,connectionId);
 const saveIntent=useCallback((next:BillingIntent|null)=>{
  try{if(next){const raw=JSON.stringify(next);parseBillingIntent(raw,tenantId,actorId,connectionId);sessionStorage.setItem(storageKey,raw);if(sessionStorage.getItem(storageKey)!==raw)throw new Error('STORAGE');}
   else{sessionStorage.removeItem(storageKey);if(sessionStorage.getItem(storageKey)!==null)throw new Error('STORAGE');}
   intent.current=next;setPendingIntent(next);return true;
  }catch{setStorageReady(false);setStorageFailed(true);return false;}
 },[storageKey,tenantId,actorId,connectionId]);
 const path=`/api/connections/${encodeURIComponent(connectionId)}/meta/billing-policy`,loading=read.scope!==scope,view=loading?null:read.view;
 const choice=pendingIntent?.choice??view?.managedChoices?.find(item=>item.choiceId===choiceId),tariff=pendingIntent?.offer??view?.tariffOffers?.items.find(item=>item.id===tariffId);
 const offers=view?.tariffOffers?.items??[],shownOffers=pendingIntent?.offer&&!offers.some(item=>item.id===pendingIntent.offer!.id)?[pendingIntent.offer,...offers]:offers;
 const pending=['QUEUED','RUNNING','FAILED_RETRYABLE'].includes(view?.state??''),busy=sending||pending,locked=busy||Boolean(pendingIntent)||!storageReady;
 const load=useCallback(async()=>{const token=fence.current.begin();active.current?.abort();const controller=new AbortController();active.current=controller;
  try{const response=await fetch(path+metaTariffQueryString(query.current),{cache:'no-store',signal:controller.signal,headers:{'x-wasalx-billing-actor':encodeURIComponent(actorId),'x-wasalx-billing-workspace':encodeURIComponent(tenantId)}});if(!response.ok)throw await failure(response);
   const next=await response.json() as MetaCustomerPolicyView;if(fence.current.isCurrent(token))setRead({scope,view:next,error:null});
  }catch(error){if(fence.current.isCurrent(token))setRead({scope,view:null,error:localizedUiError(locale,error)});}
  finally{if(fence.current.isCurrent(token))setReading(false);}},[path,scope,locale,actorId,tenantId]);
 useEffect(()=>{const current=fence.current,controller=new AbortController();
  void Promise.resolve().then(()=>{if(controller.signal.aborted)return;
   try{const restored=parseBillingIntent(sessionStorage.getItem(storageKey),tenantId,actorId,connectionId);intent.current=restored;setPendingIntent(restored);setStorageReady(true);
    if(restored){setSelected(restored.body.mode==='CUSTOMER');setChoiceId(restored.body.mode==='MANAGED'?restored.body.choiceId:'');setTariffId(restored.offer?.id??'');setAcceptedTerms('acceptedTerms' in restored.body);
     query.current=restored.body.mode==='MANAGED'?{tariffMode:'MANAGED',choiceId:restored.body.choiceId}:{tariffMode:'CUSTOMER'};}
   }catch{setStorageReady(false);setStorageFailed(true);}
   void load();
  });return()=>{controller.abort();current.invalidate();active.current?.abort();};
 },[load,storageKey,tenantId,actorId,connectionId]);
 useEffect(()=>{if(!pending||sending)return;const timer=setTimeout(()=>void load(),2000);return()=>clearTimeout(timer);},[pending,sending,load,view]);
 function refresh(){setReading(true);if(!intent.current){setTariffId('');setAcceptedTerms(false);}void load();}
 function choose(customer:boolean,managed:string){if(locked)return;setSelected(customer);setChoiceId(managed);setTariffId('');setAcceptedTerms(false);
  query.current=managed?{tariffMode:'MANAGED',choiceId:managed}:customer?{tariffMode:'CUSTOMER'}:null;setPageAfter(null);refresh();}
 async function select(){
  if(writing.current||!storageReady||!canConfigure)return;
  if(!intent.current){if(!view||reading||(!selected&&!(choice&&acceptedTerms))||(tariffId&&(!tariff||!acceptedTerms)))return;
   const body=parseMetaPolicySelection({...((choice)?{mode:'MANAGED',expectedRevision:view.revision,choiceId:choice.choiceId,documentSha256:choice.documentSha256,acceptedTerms:true}:{mode:'CUSTOMER',expectedRevision:view.revision}),
    ...(tariff?{tariffVersionId:tariff.id,tariffDefinitionSha256:tariff.definitionSha256,documentSha256:tariff.documentSha256,acceptedTerms:true}:{})});
   if(!saveIntent({version:1,tenantId,actorId,connectionId,key:crypto.randomUUID(),body,offer:tariff??null,choice:choice??null}))return;
  }
  const original=intent.current!;writing.current=true;const token=fence.current.begin();active.current?.abort();const controller=new AbortController();active.current=controller;setSending(true);
  try{const response=await fetch(path,{method:'POST',signal:controller.signal,headers:{...mutationHeaders,'x-wasalx-billing-actor':encodeURIComponent(actorId),'x-wasalx-billing-workspace':encodeURIComponent(tenantId),'content-type':'application/json','idempotency-key':original.key},body:JSON.stringify(original.body)});
   if(!response.ok){if(response.status===409&&fence.current.isCurrent(token)){if(saveIntent(null)){setAcceptedTerms(false);setTariffId('');}}throw await failure(response);}
   const result:unknown=await response.json();if(!isMetaPolicyAcceptanceResult(original.body,result))throw Object.assign(new Error('Uncertain payment acknowledgement'),{status:502});
   if(!fence.current.isCurrent(token)||!saveIntent(null))return;setSending(false);setSelected(false);setChoiceId('');setTariffId('');setAcceptedTerms(false);query.current=null;setPageAfter(null);await load();
  }catch(error){if(fence.current.isCurrent(token))setRead(previous=>({...previous,error:localizedUiError(locale,error)}));}
  finally{writing.current=false;if(fence.current.isCurrent(token))setSending(false);}
 }
 const authorityLost=read.error?.code==='FORBIDDEN'||read.error?.code==='UNAUTHENTICATED';
 const canSubmit=!authorityLost&&storageReady&&(Boolean(pendingIntent)||Boolean(view&&!reading&&(selected||choice&&acceptedTerms)&&(!tariffId||tariff&&acceptedTerms)));
 return <><section className="connection-detail-section" aria-labelledby={`payment-policy-${connectionId}`}>
  <div className="connection-detail-section-head"><div><h3 id={`payment-policy-${connectionId}`}>{t('tenant.connection.paymentPolicy.title')}</h3><p>{t('tenant.connection.paymentPolicy.body')}</p></div></div>
  <p role="status" aria-live="polite" className="connection-detail-note">{loading?t('tenant.connection.payment.loading'):sending?t('tenant.team.actions.saving'):pending?t('tenant.connection.payment.checking'):view?t(view.sendReady?'tenant.connection.paymentPolicy.ready':view.enrolled?'tenant.connection.paymentPolicy.held':'tenant.connection.paymentPolicy.legacy'):null}</p>
  {canConfigure?<><label className="connection-detail-note"><input type="checkbox" checked={selected} disabled={loading||reading||locked} onChange={event=>choose(event.target.checked,'')}/>{' '}{t('tenant.connection.paymentPolicy.customer')}</label>
   {choice||view?.managedAvailable&&view.managedChoices?.length?<div className="field"><label htmlFor={`managed-choice-${connectionId}`}>{t('tenant.connection.paymentPolicy.managedChoice')}</label>
    <select id={`managed-choice-${connectionId}`} value={choiceId} disabled={loading||reading||locked} onChange={event=>choose(false,event.target.value)}>
     <option value="">{t('tenant.connection.paymentPolicy.chooseManaged')}</option>
     {(choice&&!view?.managedChoices?.some(item=>item.choiceId===choice.choiceId)?[choice,...(view?.managedChoices??[])]:view?.managedChoices??[]).map(item=><option key={item.choiceId} value={item.choiceId}>{t(item.kind==='MULTI_PARTNER_SOLUTION'?'tenant.connection.paymentPolicy.partnerChoice':'tenant.connection.paymentPolicy.ownChoice')} · {new Intl.DateTimeFormat(locale,{dateStyle:'medium'}).format(new Date(item.expiresAt))}</option>)}
    </select></div>:null}
   {selected||choice?<div className="field"><label htmlFor={`tariff-choice-${connectionId}`}>{t('tenant.connection.paymentPolicy.rates')}</label>
    <select id={`tariff-choice-${connectionId}`} value={tariffId} disabled={reading||locked} onChange={event=>{setTariffId(event.target.value);setAcceptedTerms(false);}}>
     <option value="">{t('tenant.connection.paymentPolicy.noRates')}</option>
     {shownOffers.map((item,index)=><option key={item.id} value={item.id}>{item.currency} · {formatTariffDate(item.effectiveFrom,item.timezone,locale)} · {index+1}</option>)}
    </select>
    {reading?<p role="status">{t('tenant.connection.payment.loading')}</p>:null}
    {view?.tariffOffers?.nextAfter?<button type="button" className="button small secondary" disabled={reading||locked} onClick={()=>{query.current={...query.current!,tariffAfter:view.tariffOffers!.nextAfter!};setPageAfter(view.tariffOffers!.nextAfter!);refresh();}}>{t('tenant.connection.paymentPolicy.moreRates')}</button>:null}
    {pageAfter?<button type="button" className="button small secondary" disabled={reading||locked} onClick={()=>{const q=query.current!;query.current=q.tariffMode==='MANAGED'?{tariffMode:q.tariffMode,choiceId:q.choiceId}:{tariffMode:q.tariffMode};setPageAfter(null);refresh();}}>{t('tenant.connection.paymentPolicy.firstRates')}</button>:null}
   </div>:null}
   {tariff?<div className="connection-detail-note">
    <p><strong>{t('tenant.connection.paymentPolicy.ratePeriod')}</strong> {formatTariffDate(tariff.effectiveFrom,tariff.timezone,locale)} – {formatTariffDate(tariff.effectiveTo,tariff.timezone,locale)} ({tariff.timezone})</p>
    <p style={{overflowWrap:'anywhere'}}><time dateTime={tariff.effectiveFrom}><bdi>{tariff.effectiveFrom}</bdi></time> – <time dateTime={tariff.effectiveTo}><bdi>{tariff.effectiveTo}</bdi></time> (UTC)</p>
    <p>{tariff.currency} · {t('tenant.connection.paymentPolicy.precision')}: {tariff.minorUnits} · {t(tariff.rounding==='PERIOD'?'tenant.connection.paymentPolicy.periodRounding':'tenant.connection.paymentPolicy.lineRounding')}</p>
    <p>{t('tenant.connection.paymentPolicy.deliveredUnit')}</p>
    {tariff.evidenceMode==='SIMULATED'?<p>{t('tenant.connection.paymentPolicy.developmentRates')}</p>:null}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named rates scroll region needs keyboard focus to read all columns. */}
    <div style={{maxWidth:'100%',overflowX:'auto'}} tabIndex={0} role="region" aria-label={t('tenant.connection.paymentPolicy.rateTable')}>
     <table><caption>{t('tenant.connection.paymentPolicy.rateTable')}</caption><thead><tr>{['category','pricingType','billable','schedule','market','tier','unitPrice'].map(key=><th scope="col" key={key}>{t(`tenant.connection.paymentPolicy.rate.${key}`)}</th>)}</tr></thead>
      <tbody>{tariff.rates.map((rate,index)=><tr key={index}><td>{t(`tenant.connection.paymentPolicy.value.${rate.category}`)}</td><td>{t(`tenant.connection.paymentPolicy.value.${rate.pricingType}`)}</td><td>{t(rate.billable?'tenant.connection.paymentPolicy.yes':'tenant.connection.paymentPolicy.no')}</td><td>{t(`tenant.connection.paymentPolicy.value.${rate.schedule}`)}</td><td>{rate.market}</td><td>{rate.tier}</td><td><bdi>{rate.unitPrice} {tariff.currency}</bdi></td></tr>)}</tbody>
     </table></div>
   </div>:null}
   {choice||tariff?<><details><summary>{t('tenant.connection.paymentPolicy.reviewTerms')}</summary><p className="connection-detail-note" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{tariff?.documentText??choice?.documentText}</p></details>
    <label className="connection-detail-note"><input type="checkbox" checked={acceptedTerms} disabled={reading||locked} onChange={event=>setAcceptedTerms(event.target.checked)}/>{' '}{t(tariff?'tenant.connection.paymentPolicy.acceptRates':'tenant.connection.paymentPolicy.acceptTerms')}</label>
    <p className="connection-detail-note">{t('tenant.connection.paymentPolicy.managedHeld')}</p></>:null}
   <button type="button" className="button secondary" disabled={!canSubmit||busy||reading} onClick={()=>void select()}>{t('tenant.connection.paymentPolicy.select')}</button></>:null}
  {view&&!view.managedAvailable?<p className="connection-detail-note">{t('tenant.connection.paymentPolicy.managed')}</p>:null}
  {storageFailed?<p role="alert">{t('tenant.connection.paymentPolicy.storage')}</p>:null}
  {!loading&&read.error?<div role="alert" className="connection-detail-alert connection-detail-alert-danger"><div><p>{read.error.message}</p>{read.error.code==='REAUTHENTICATION_REQUIRED'?<a className="button small secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent(`/app?view=connections&connection=${connectionId}`)}`}>{t('tenant.connection.reauthenticate')}</a>:null}</div><button type="button" className="button small" disabled={busy} onClick={refresh}>{t('common.actions.retry')}</button></div>:null}
 </section><MetaAccountTransitionPreview connectionId={connectionId} canConfigure={canConfigure} mutationHeaders={mutationHeaders} refreshKey={refreshKey}/></>;
}
async function failure(response:Response){const value=await response.json().catch(()=>null) as {code?:unknown}|null;return Object.assign(new Error('Request unavailable'),{status:response.status,code:typeof value?.code==='string'?value.code:undefined});}

function formatTariffDate(value:string,timezone:string,locale:string){
 try{return new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZone:timezone}).format(new Date(value));}
 catch{return value;} // The exact ISO instant is still readable for a PG-only timezone alias.
}
