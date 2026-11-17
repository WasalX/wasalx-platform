"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "../../I18nProvider";
import { LocaleSwitcher } from "../../LocaleSwitcher";
import styles from "./MetaDeletionStatus.module.css";

const states = ["SCOPE_REVIEW_REQUIRED", "NEEDS_INFORMATION", "HELD", "REFUSED", "UNAVAILABLE"] as const;
export function MetaDeletionStatus({helpUrl}:{helpUrl?:string}) {
  const { t, direction, locale } = useI18n();
  const [code,setCode] = useState("");
  const [state,setState] = useState<typeof states[number]>();
  const [policyUrl,setPolicyUrl]=useState<string>();
  const [busy,setBusy] = useState(false);
  const [failed,setFailed] = useState(false);
  const fragment = useRef<string | null>(null), active = useRef<AbortController | null>(null);
  const lookup = useCallback(async (value:string) => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    if(!/^[0-9a-f]{64}$/u.test(value)){setBusy(false);setPolicyUrl(undefined);setFailed(false);setState("UNAVAILABLE");return;} // A malformed code is unknown, not an outage.
    setBusy(true);setFailed(false);setState(undefined);setPolicyUrl(undefined);
    try {
      const response=await fetch("/api/meta-deletion/status",{method:"POST",credentials:"omit",headers:{"content-type":"application/json"},body:JSON.stringify({code:value}),cache:"no-store",referrerPolicy:"no-referrer",redirect:"error",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
      if(!response.ok)throw new Error("Status unavailable");
      const result=await response.json() as {state:unknown;refusalPolicyUrl?:unknown};
      if(controller.signal.aborted)return;
      if(result.state==="REFUSED"){if(typeof result.refusalPolicyUrl!=="string"||result.refusalPolicyUrl.length>2048)throw new Error("Status unavailable");const policy=new URL(result.refusalPolicyUrl);if(policy.protocol!=="https:"||policy.username||policy.password||policy.search||policy.hash)throw new Error("Status unavailable");setPolicyUrl(policy.href);}
      setState(states.includes(result.state as typeof states[number])?result.state as typeof states[number]:"UNAVAILABLE");
    } catch {if(!controller.signal.aborted)setFailed(true);} finally {if(!controller.signal.aborted)setBusy(false);}
  },[]);
  useEffect(()=>{
    const controller = new AbortController(), request = active;
    // Retain only in this mounted component so Strict Mode cleanup/re-setup
    // cannot discard the fragment before its scheduled first lookup.
    if(fragment.current === null) fragment.current = window.location.hash.slice(1);
    const value = fragment.current;
    // Fragment never travels in HTTP or persistent storage. Remove it first.
    if(value){
      window.history.replaceState(null,"",window.location.pathname);
      queueMicrotask(()=>{if(!controller.signal.aborted){setCode(value);void lookup(value);}});
    }
    return()=>{controller.abort();request.current?.abort();};
  },[lookup]);
  function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();void lookup(code);}
  return <main className={`${styles.page} theme-light`} dir={direction}>
    <div className={styles.card}><header><p>WasalX</p><LocaleSwitcher locale={locale} label={t("common.locale.label")} errorMessage={t("common.errors.generic")} /></header>
      <h1>{t("platform.deletion.title")}</h1><p>{t("platform.deletion.description")}</p>
      <form onSubmit={submit}><label>{t("platform.deletion.code")}<input autoComplete="off" autoCapitalize="none" spellCheck={false} dir="ltr" value={code} onChange={event=>setCode(event.target.value.trim().toLowerCase())} maxLength={64} required pattern="[0-9a-f]{64}" /></label>
        <button disabled={busy} type="submit">{t(busy?"platform.deletion.loading":"platform.deletion.check")}</button></form>
      {failed?<p role="alert">{t("platform.deletion.error")}</p>:null}
      {state?<section aria-live="polite"><h2>{t(`platform.deletion.state.${state}`)}</h2><p>{t(`platform.deletion.detail.${state}`)}</p>{state==="REFUSED"&&policyUrl?<a href={policyUrl} rel="noreferrer">{t("platform.deletion.policy")}</a>:null}</section>:null}
      <p>{t("platform.deletion.support")}</p>
      {helpUrl?<a href={helpUrl} rel="noreferrer">{t("platform.deletion.contact")}</a>:null}
    </div>
  </main>;
}
