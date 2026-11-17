"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {useI18n} from './I18nProvider';
import {localizedUiError,type UiErrorCode} from '../lib/ui-error';
import {readBoundedJson} from '../lib/bounded-json';
import {META_ADD_ACCESS_ACTIVATION_REASONS,type MetaAddAccessActivationView} from '../packages/core/src/meta-add-access-activation-contract';
type Props={connectionId:string;canConfigure:boolean;connectionRevoked:boolean;mutationHeaders:Record<string,string>;refreshKey:number;changed:()=>void|Promise<void>};
export function MetaSavedAccessActivation(props:Props){
  return <Activation key={JSON.stringify([props.connectionId,props.canConfigure,props.connectionRevoked,props.refreshKey,props.mutationHeaders])} {...props}/>;
}
function Activation({connectionId,canConfigure,connectionRevoked,mutationHeaders,changed}:Props){
  const {t,locale}=useI18n(),[view,setView]=useState<MetaAddAccessActivationView|null>(null),[loading,setLoading]=useState(true),[pending,setPending]=useState(false);
  const [error,setError]=useState<{code:UiErrorCode;message:string}|null>(null),generation=useRef(0),active=useRef<AbortController|null>(null),busy=useRef(false);
  const path=`/api/connections/${encodeURIComponent(connectionId)}/meta/activation`;
  const fetchView=useCallback(async(signal:AbortSignal)=>{
    const response=await fetch(path,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
    if(!response.ok)throw await failure(response);
    const value=await readBoundedJson(response,32_768) as MetaAddAccessActivationView;
    if(!value||value.connectionId!==connectionId||typeof value.applicable!=='boolean'||typeof value.readyToCheck!=='boolean'
      ||!META_ADD_ACCESS_ACTIVATION_REASONS.includes(value.reason)||value.conversationPermission!=='SEPARATE_REQUIRED'
      ||(value.readyToCheck&&(value.reason!=='READY_TO_CHECK'||typeof value.contextVersion!=='string'||!/^[a-f0-9]{64}$/u.test(value.contextVersion))))throw new Error('Saved status is unavailable');
    return value;
  },[path,connectionId]);
  const load=useCallback(async()=>{
    if(busy.current)return;
    const current=++generation.current;active.current?.abort();const controller=new AbortController();active.current=controller;
    try{const value=await fetchView(controller.signal);if(current===generation.current){setView(value);setError(null);}}
    catch(reason){if(current===generation.current){setView(null);setError(localizedUiError(locale,reason));}}
    finally{if(current===generation.current)setLoading(false);}
  },[fetchView,locale]);
  useEffect(()=>{const counter=generation,request=active,timer=setTimeout(()=>void load(),0);return()=>{clearTimeout(timer);counter.current++;request.current?.abort();};},[load]);
  const running=['QUEUED','RUNNING','FAILED_RETRYABLE'].includes(view?.operation?.state??'');
  useEffect(()=>{if(!running||pending)return;const timer=setTimeout(()=>void load(),2000);return()=>clearTimeout(timer);},[running,pending,view,load]);
  async function activate(){
    if(busy.current||!canConfigure||connectionRevoked||!view?.readyToCheck||!view.contextVersion)return;
    busy.current=true;setPending(true);setError(null);const current=++generation.current;
    active.current?.abort();const controller=new AbortController();active.current=controller;
    try{
      const response=await fetch(path,{method:'POST',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)]),
        headers:{...mutationHeaders,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({expectedContextVersion:view.contextVersion})});
      if(!response.ok)throw await failure(response);
      if(current!==generation.current)return;
      const value=await fetchView(controller.signal);if(current!==generation.current)return;setView(value);await changed();
    }catch(reason){
      if(current!==generation.current)return;
      setError(localizedUiError(locale,reason));
      // An uncertain response only reads saved status. It never repeats activation.
      try{const value=await fetchView(controller.signal);if(current===generation.current){setView(value);if(value.operation&&value.operation.id!==view.operation?.id)setError(null);}}catch{ /* Keep explicit saved-status recovery. */ }
    }finally{if(current===generation.current){busy.current=false;setPending(false);}}
  }
  if(!loading&&view?.applicable===false)return null;
  return <section className="connection-detail-section" aria-labelledby={`saved-access-${connectionId}`}>
    <div className="connection-detail-section-head"><div><h3 id={`saved-access-${connectionId}`}>{t('tenant.metaActivation.title')}</h3><p>{t(connectionRevoked?'tenant.connection.guidance.revoked.body':'tenant.metaActivation.body')}</p></div></div>
    {loading||running||!connectionRevoked?<p role="status" aria-live="polite" className="connection-detail-note">{loading?t('tenant.metaActivation.loading'):running?t('tenant.metaActivation.checking'):view?t(`tenant.metaActivation.reason.${view.reason}`):error?null:t('tenant.metaActivation.reason.SETUP_INCOMPLETE')}</p>:null}
    <p className="connection-detail-note">{t('tenant.metaActivation.scope')}</p>
    {view?.operation?.locallyActivated?<p className="connection-detail-note">{t('tenant.metaActivation.completed')}</p>:null}
    {canConfigure&&!connectionRevoked?<button type="button" className="button primary" disabled={loading||pending||running||!view?.readyToCheck} onClick={()=>void activate()}>{t('tenant.metaActivation.activate')}</button>:null}
    <button type="button" className="button secondary" disabled={loading||pending} onClick={()=>void load()}>{t('tenant.metaActivation.refresh')}</button>
    {error?<div role="alert" className="connection-detail-alert connection-detail-alert-danger"><p>{error.message}</p>
      {error.code==='REAUTHENTICATION_REQUIRED'?<a className="button small secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent(`/app?view=connections&connection=${connectionId}`)}`}>{t('tenant.connection.reauthenticate')}</a>:null}</div>:null}
  </section>;
}
async function failure(response:Response){const value=await readBoundedJson(response,4096).catch(()=>null) as {code?:unknown}|null;return Object.assign(new Error('Request unavailable'),{status:response.status,code:typeof value?.code==='string'?value.code:undefined});}
