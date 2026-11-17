"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { createLatestRequestFence } from "../lib/operator-ui";
import type { MetaBillingDiagnosticView } from "../lib/control-plane-data";
import { localizedUiError, type UiErrorCode } from "../lib/ui-error";
import { formatDateTime } from "../lib/i18n/format";

export function MetaBillingDiagnostics({connectionId,canConfigure,mutationHeaders,refreshKey}: {
  connectionId:string;canConfigure:boolean;mutationHeaders:Record<string,string>;refreshKey:number;
}) {
  const {t,locale}=useI18n();
  const scope=`${connectionId}:${refreshKey}:${locale}`;
  const [read,setRead]=useState<{scope:string;view:MetaBillingDiagnosticView|null;error:{code:UiErrorCode;message:string}|null}>({scope:"",view:null,error:null});
  const [sendingScope,setSendingScope]=useState<string|null>(null);
  const loading=read.scope!==scope,view=loading?null:read.view,error=loading?null:read.error,sending=sendingScope===scope;
  const fence=useRef(createLatestRequestFence()),intent=useRef<{connectionId:string;key:string}|null>(null);
  const active=useRef<AbortController|null>(null);
  const path=`/api/connections/${encodeURIComponent(connectionId)}/meta/billing-diagnostic`;
  const load=useCallback(async()=>{
    const request=fence.current.begin();
    active.current?.abort();const controller=new AbortController();active.current=controller;
    try {
      const response=await fetch(path,{cache:"no-store",signal:controller.signal});
      if(!response.ok)throw await requestFailure(response);
      const next=await response.json() as MetaBillingDiagnosticView;
      if(!fence.current.isCurrent(request))return;
      setRead({scope,view:next,error:null});
    } catch (failure) {if(fence.current.isCurrent(request))setRead({scope,view:null,error:localizedUiError(locale,failure)});}
    finally {if(fence.current.isCurrent(request))setSendingScope(null);}
  },[path,locale,scope]);
  useEffect(()=>{const ownedFence=fence.current;void load();return()=>{ownedFence.invalidate();active.current?.abort();};},[load]);
  const pending=sending||["QUEUED","RUNNING","FAILED_RETRYABLE"].includes(view?.state??"");
  useEffect(()=>{if(!pending||sending)return;const timer=setTimeout(()=>void load(),2000);return()=>clearTimeout(timer);},[pending,sending,load,view]);
  async function check() {
    if(intent.current?.connectionId!==connectionId)intent.current={connectionId,key:crypto.randomUUID()};setSendingScope(scope);setRead(previous=>({...previous,error:null}));
    const request=fence.current.begin();
    active.current?.abort();const controller=new AbortController();active.current=controller;
    try {
      const response=await fetch(path,{method:"POST",signal:controller.signal,headers:{...mutationHeaders,"content-type":"application/json","idempotency-key":intent.current.key},body:"{}"});
      if(!response.ok)throw await requestFailure(response);
      if(!fence.current.isCurrent(request))return;
      intent.current=null;
      setSendingScope(null);
      await load();
    } catch (failure) {if(fence.current.isCurrent(request))setRead(previous=>({...previous,error:localizedUiError(locale,failure)}));}
    finally {if(fence.current.isCurrent(request))setSendingScope(null);}
  }
  const diagnostic=view?.diagnostic;
  const failed=["FAILED_TERMINAL","CANCELLED"].includes(view?.state??"");
  return <section className="connection-detail-section" aria-labelledby="meta-payment-title">
    <div className="connection-detail-section-head"><div><h3 id="meta-payment-title">{t("tenant.connection.payment.title")}</h3><p>{t("tenant.connection.payment.body")}</p></div>
      {canConfigure?<button type="button" className="button secondary" disabled={pending||loading} onClick={()=>void check()}>{t(pending?"tenant.connection.payment.checking":"tenant.connection.payment.check")}</button>:null}</div>
    <div role="status" aria-live="polite">
      {loading?<p className="connection-detail-note">{t("tenant.connection.payment.loading")}</p>:pending?<p className="connection-detail-note">{t("tenant.connection.payment.checking")}</p>:diagnostic?<p className="connection-detail-note">{t(diagnostic.reason==="READ_UNAVAILABLE"?"tenant.connection.payment.unavailable":diagnostic.reason!=="OBSERVED"?"tenant.connection.payment.held":diagnostic.paymentMethod==="PRESENT"?"tenant.connection.payment.present":diagnostic.paymentMethod==="NONE"?"tenant.connection.payment.none":"tenant.connection.payment.unavailable")}</p>:view?<p className="connection-detail-note">{t(failed?"tenant.connection.payment.unavailable":"tenant.connection.payment.empty")}</p>:null}
      {diagnostic?.accountOwner==="REPORTED"&&diagnostic.reason==="OBSERVED"?<p className="connection-detail-note">{t("tenant.connection.payment.ownerReported")}</p>:null}
      {diagnostic?<p className="connection-detail-note">{t("tenant.connection.payment.checkedAt")} <time dateTime={diagnostic.checkedAt}>{formatDateTime(diagnostic.checkedAt,locale)}</time></p>:null}
    </div>
    <p className="connection-detail-note">{t("tenant.connection.payment.limits")}</p>
    {error?<div role="alert" className="connection-detail-alert connection-detail-alert-danger"><div><p>{error.message}</p>{error.code==="REAUTHENTICATION_REQUIRED"?<a className="button small secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent(`/app?view=connections&connection=${connectionId}`)}`}>{t("tenant.connection.reauthenticate")}</a>:null}</div><button type="button" className="button small" disabled={sending} onClick={()=>void load()}>{t("common.actions.retry")}</button></div>:null}
  </section>;
}

async function requestFailure(response:Response) {
  const body=await response.json().catch(()=>null) as {code?:unknown}|null;
  return Object.assign(new Error("Request unavailable"),{status:response.status,code:typeof body?.code==="string"?body.code:undefined});
}
