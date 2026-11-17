"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import {useI18n} from './I18nProvider';
import {ModalDialog} from './ModalDialog';
import {useVisibleRefresh} from './use-visible-refresh';
import {readBoundedJson} from '../lib/bounded-json';
import {numberReleaseIntentKey,numberReleaseReadbackMatches,parseNumberReleaseAcknowledgment,parseNumberReleaseIntent,parseNumberReleaseView,sameNumberReleaseBody,type NumberReleaseIntent,type NumberReleaseView} from '../lib/meta-number-release-intent';

type Props={tenantId:string;actorId:string;connectionId:string;connectionName:string;mutationHeaders:Record<string,string>;busyChanged:(busy:boolean)=>void};
type Failure='unavailable'|'unknown'|'reauthenticate'|'forbidden'|'invalid'|'notFound'|'notReady';
export function MetaNumberRelease(props:Props){
  const {locale}=useI18n();
  return <NumberRelease key={JSON.stringify([props.tenantId,props.actorId,props.connectionId,props.mutationHeaders,locale])} {...props}/>;
}
function NumberRelease({tenantId,actorId,connectionId,connectionName,mutationHeaders,busyChanged}:Props){
  const {t}=useI18n(),[view,setView]=useState<NumberReleaseView|null>(null),[loading,setLoading]=useState(true),[pending,setPending]=useState(false);
  const [confirming,setConfirming]=useState(false),[error,setError]=useState<Failure|null>(null),[storageReady,setStorageReady]=useState<boolean|null>(null),[intent,setIntent]=useState<NumberReleaseIntent|null>(null);
  const saved=useRef<NumberReleaseIntent|null>(null),busy=useRef(false),generation=useRef(0),active=useRef<AbortController|null>(null),refreshButton=useRef<HTMLButtonElement>(null);
  const restoreCompletedFocus=useRef(false);
  const storageKey=numberReleaseIntentKey(tenantId,actorId,connectionId),path=`/api/connections/${encodeURIComponent(connectionId)}/meta/number-release`;
  const persist=useCallback((value:NumberReleaseIntent|null)=>{
    try{
      if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);
      const stored=parseNumberReleaseIntent(sessionStorage.getItem(storageKey),tenantId,actorId,connectionId);
      if(JSON.stringify(stored)!==JSON.stringify(value))throw new Error('Storage unavailable');
      saved.current=stored;setIntent(stored);return true;
    }catch{setStorageReady(false);return false;}
  },[storageKey,tenantId,actorId,connectionId]);
  const fetchView=useCallback(async(signal:AbortSignal)=>{
    const response=await fetch(path,{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
    if(!response.ok)throw await failure(response);
    return parseNumberReleaseView(await readBoundedJson(response,4096));
  },[path]);
  const load=useCallback(async(signal?:AbortSignal)=>{
    if(busy.current)return;
    const current=++generation.current;active.current?.abort();const controller=new AbortController();active.current=controller;
    try{
      const value=await fetchView(signal?AbortSignal.any([signal,controller.signal]):controller.signal);
      if(current!==generation.current)return;
      const settled=Boolean(value.releaseId&&(!saved.current?.uncertain||numberReleaseReadbackMatches(saved.current,value)));
      setView(value);setError(saved.current?.uncertain&&!settled?'unknown':null);
      if(settled)persist(null);
    }catch(reason){if(current===generation.current){setView(null);setError(saved.current?.uncertain?'unknown':knownFailure(reason)??'unavailable');}}
    finally{if(current===generation.current)setLoading(false);}
  },[fetchView,persist]);
  useEffect(()=>{
    const timer=setTimeout(()=>{
      try{const value=parseNumberReleaseIntent(sessionStorage.getItem(storageKey),tenantId,actorId,connectionId);saved.current=value;setIntent(value);setStorageReady(true);}catch{setStorageReady(false);}
      void load();
    },0);
    const counter=generation,request=active;
    return()=>{clearTimeout(timer);counter.current++;request.current?.abort();};
  },[storageKey,tenantId,actorId,connectionId,load]);
  useEffect(()=>{busyChanged(confirming||pending);return()=>busyChanged(false);},[busyChanged,confirming,pending]);
  useEffect(()=>{
    if(confirming||pending||!restoreCompletedFocus.current)return;
    const frame=window.requestAnimationFrame(()=>{restoreCompletedFocus.current=false;refreshButton.current?.focus({preventScroll:true});});
    return()=>window.cancelAnimationFrame(frame);
  },[confirming,pending]);
  useVisibleRefresh(load,!confirming&&!pending);
  const body=view?.disconnectOperationId?{routeId:view.routeId,phoneNumberId:view.phoneNumberId,disconnectOperationId:view.disconnectOperationId}:null;
  const bindingChanged=Boolean(intent?.uncertain&&view&&((body&&!sameNumberReleaseBody(intent.body,body))||(view.releaseId&&!numberReleaseReadbackMatches(intent,view))));
  const released=Boolean(view?.releaseId&&(!intent?.uncertain||numberReleaseReadbackMatches(intent,view)));
  const canRelease=storageReady&&!loading&&!pending&&Boolean(body)&&!view?.releaseId&&!bindingChanged&&(!error||error==='unknown');
  function close(){if(!busy.current)setConfirming(false);}
  async function release(){
    if(busy.current||!canRelease||!body)return;
    const previous=saved.current;
    if(previous?.uncertain&&!sameNumberReleaseBody(previous.body,body))return;
    let request:NumberReleaseIntent=previous&&sameNumberReleaseBody(previous.body,body)?{...previous,uncertain:true}
      :{version:1,tenantId,actorId,connectionId,key:crypto.randomUUID(),body,uncertain:true,acknowledgmentId:null};
    // Save the exact request before sending: a lost response or MFA reload must not replace its key.
    if(!persist(request))return;
    busy.current=true;setPending(true);setError(null);const current=++generation.current;
    active.current?.abort();const controller=new AbortController();active.current=controller;
    let acknowledged=false;
    try{
      const response=await fetch(path,{method:'POST',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)]),
        headers:{...mutationHeaders,'content-type':'application/json','idempotency-key':request.key},body:JSON.stringify(request.body)});
      if(response.status!==200)throw await failure(response);
      const releaseId=parseNumberReleaseAcknowledgment(await readBoundedJson(response,4096));
      acknowledged=true;
      if(current!==generation.current)return;
      if(request.acknowledgmentId&&request.acknowledgmentId!==releaseId)throw new Error('Release receipt changed');
      request={...request,acknowledgmentId:releaseId};if(!persist(request))throw new Error('Release receipt storage unavailable');
      const readback=await fetchView(controller.signal);
      if(current!==generation.current)return;
      if(!numberReleaseReadbackMatches(request,readback))throw new Error('Release readback unavailable');
      setView(readback);persist(null);restoreCompletedFocus.current=true;setConfirming(false);
    }catch(reason){
      if(current!==generation.current)return;
      const known=acknowledged?null:knownFailure(reason);
      if(known){persist({...request,uncertain:previous?.uncertain??false,acknowledgmentId:previous?.acknowledgmentId??null});setError(known);}
      else{
        setError('unknown');
        // Read only. An unknown outcome never causes another POST.
        try{
          const value=await fetchView(controller.signal);if(current!==generation.current)return;
          setView(value);
          if(numberReleaseReadbackMatches(request,value)){persist(null);setError(null);restoreCompletedFocus.current=true;setConfirming(false);}
        }catch{setView(null);}
      }
    }finally{if(current===generation.current){busy.current=false;setPending(false);}}
  }
  const problem=<>
    {storageReady===false&&!released?<p role="alert" className="connection-detail-alert connection-detail-alert-danger">{t('tenant.metaNumberRelease.storage')}</p>:null}
    {bindingChanged?<p role="alert" className="connection-detail-alert connection-detail-alert-danger">{t('tenant.metaNumberRelease.bindingChanged')}</p>:null}
    {error?<div role="alert" className="connection-detail-alert connection-detail-alert-danger"><p>{t(`tenant.metaNumberRelease.error.${error}`)}</p>
      {error==='reauthenticate'?<a className="button secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent(`/app?view=connections&connection=${connectionId}`)}`}>{t('tenant.connection.reauthenticate')}</a>:null}</div>:null}
  </>;
  return <section className="connection-detail-section connection-detail-danger" aria-labelledby={`number-release-${connectionId}`}>
    <div className="connection-detail-section-head"><div><h3 id={`number-release-${connectionId}`}>{t('tenant.metaNumberRelease.title')}</h3><p>{t('tenant.metaNumberRelease.body')}</p></div></div>
    <p role="status" aria-live="polite" className="connection-detail-note">{loading?t('tenant.metaNumberRelease.loading'):released?t('tenant.metaNumberRelease.released'):view&&!body?t('tenant.metaNumberRelease.disconnectPending'):t('tenant.metaNumberRelease.review')}</p>
    <p className="connection-detail-note">{t('tenant.metaNumberRelease.audit')}</p>
    {!released?<button type="button" className="button connection-detail-danger-button" disabled={!canRelease} onClick={()=>setConfirming(true)}>{t('tenant.metaNumberRelease.action')}</button>:null}
    <button ref={refreshButton} type="button" className="button secondary" disabled={loading||pending} onClick={()=>void load()}>{t('tenant.metaNumberRelease.refresh')}</button>
    {!confirming?problem:null}
    {confirming?<ModalDialog className="modal-backdrop" close={close} aria-labelledby={`number-release-confirm-${connectionId}`} aria-describedby={`number-release-confirm-body-${connectionId}`}><div className="modal number-release-modal">
      <div className="modal-head"><h2 id={`number-release-confirm-${connectionId}`}>{t('tenant.metaNumberRelease.confirmTitle')}</h2></div>
      <div className="number-release-body"><p><strong><bdi dir="auto">{connectionName}</bdi></strong></p><p id={`number-release-confirm-body-${connectionId}`}>{t('tenant.metaNumberRelease.confirmBody')}</p><p>{t('tenant.metaNumberRelease.audit')}</p>
        {pending?<p role="status" aria-live="polite">{t('tenant.metaNumberRelease.releasing')}</p>:null}{problem}
      </div>
      <div className="modal-actions"><button type="button" className="button secondary" data-modal-cancel disabled={pending} onClick={close}>{t(intent?.uncertain?'tenant.metaNumberRelease.close':'tenant.metaNumberRelease.cancel')}</button>
        <button type="button" className="button secondary" disabled={loading||pending} onClick={()=>void load()}>{t('tenant.metaNumberRelease.refresh')}</button>
        <button type="button" className="button connection-detail-danger-button" disabled={!canRelease} onClick={()=>void release()}>{t(intent?.uncertain?'tenant.metaNumberRelease.retry':'tenant.metaNumberRelease.action')}</button></div>
    </div>
    </ModalDialog>:null}
  </section>;
}
function knownFailure(reason:unknown):Failure|null{
  const value=reason as {status?:unknown;code?:unknown}|null;
  if(value?.status===403&&value.code==='REAUTHENTICATION_REQUIRED')return 'reauthenticate';
  if(value?.status===403&&value.code==='META_NUMBER_RELEASE_FORBIDDEN')return 'forbidden';
  if(value?.status===400&&value.code==='META_NUMBER_RELEASE_INVALID')return 'invalid';
  if(value?.status===404)return 'notFound';
  if(value?.status===409&&value.code==='META_NUMBER_RELEASE_NOT_READY')return 'notReady';
  return null;
}
async function failure(response:Response){const value=await readBoundedJson(response,4096).catch(()=>null) as {code?:unknown}|null;return Object.assign(new Error('Number release unavailable'),{status:response.status,code:typeof value?.code==='string'?value.code:undefined});}
