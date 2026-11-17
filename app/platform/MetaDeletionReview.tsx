"use client";
import { useState, type FormEvent } from "react";
import { useI18n } from "../I18nProvider";
import { formatDateTime } from "../../lib/i18n/format.ts";
import styles from "./PlatformConsole.module.css";

type Receipt={id:string;state:string;reason?:string;receivedAt:string;expiresAt:string;version:number|string};
type Page={items:Receipt[];nextCursor?:string|null;refusalAvailable:boolean};
export function MetaDeletionReview({csrfToken}:{csrfToken:string}) {
  const {t,locale}=useI18n();const [page,setPage]=useState<Page>();const [busy,setBusy]=useState(false);const [feedback,setFeedback]=useState<string>();
  const [selected,setSelected]=useState<Receipt>();const [state,setState]=useState("NEEDS_INFORMATION");const [file,setFile]=useState<File>();
  const [intent,setIntent]=useState<{key:string;body:Record<string,unknown>;id:string}>();
  const [code,setCode]=useState("");
  async function request(path:string,options:{body?:Record<string,unknown>;key?:string}={}){
    const response=await fetch(`/api/platform-console/meta-deletion${path}`,{method:options.body?"POST":"GET",headers:{"content-type":"application/json","x-wasalx-platform-csrf":csrfToken,...(options.key?{"idempotency-key":options.key}:{})},body:options.body?JSON.stringify(options.body):undefined,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
    if(response.status===401)window.location.assign("/platform/auth/login?return_to=/platform%23meta-deletion");
    if(!response.ok)throw Object.assign(new Error("Review unavailable"),{status:response.status});return response.json();
  }
  async function load(more=false){setBusy(true);setFeedback(undefined);try{const value=readPage(await request(more&&page?.nextCursor?`?cursor=${page.nextCursor}`:""));setPage({items:more?[...(page?.items??[]),...value.items]:value.items,nextCursor:value.nextCursor,refusalAvailable:value.refusalAvailable});}catch{setFeedback(t("platform.deletion.error"));}finally{setBusy(false);}}
  async function lookup(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setFeedback(undefined);try{setPage(readPage(await request("/lookup",{body:{code}})));}catch{setFeedback(t("platform.deletion.error"));}finally{setBusy(false);}}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!selected)return;setBusy(true);setFeedback(undefined);
    try{
      let active=intent;
      if(!active){if(!file||file.size<1||file.size>1048576)throw new Error("Evidence unavailable");const bytes=await file.arrayBuffer();const hash=await crypto.subtle.digest("SHA-256",bytes);const evidenceSha256=[...new Uint8Array(hash)].map(value=>value.toString(16).padStart(2,"0")).join("");
        active={key:crypto.randomUUID(),id:selected.id,body:{expectedVersion:Number(selected.version),state,reason:state==="REFUSED"?"LAWFUL_RETENTION":state==="HELD"?"OUTCOME_UNRESOLVED":"SCOPE_EVIDENCE_REQUIRED",evidenceSha256}};setIntent(active);}
      const outcome=await request(`/${active.id}/review`,{body:active.body,key:active.key}) as Record<string,unknown>;
      if(!outcome||outcome.id!==active.id||outcome.state!==active.body.state||Number(outcome.version)!==Number(active.body.expectedVersion)+1)throw new Error("Review outcome unconfirmed");
      setIntent(undefined);setSelected(undefined);setFile(undefined);await load();
    }catch(error){const status=error&&typeof error==="object"&&"status" in error?Number(error.status):0;
      // Only a lost or server-side failure keeps the same request for reconciliation; a definite rejection admitted nothing.
      if(status>=400&&status<500&&status!==408)setIntent(undefined);
      if(status===409){setSelected(undefined);setFile(undefined);await load();}setFeedback(t("platform.deletion.reviewFailed"));}finally{setBusy(false);}
  }
  return <section className={styles.panel} id="meta-deletion"><div className={styles.panelHeader}><div><h2>{t("platform.deletion.reviewTitle")}</h2><p>{t("platform.deletion.reviewDescription")}</p></div><button className={styles.secondaryButton} type="button" disabled={busy} onClick={()=>void load()}>{t("platform.deletion.refresh")}</button></div>
    {feedback?<p role="alert">{feedback}</p>:null}
    <form className={styles.deletionForm} onSubmit={lookup}><label>{t("platform.deletion.code")}<input value={code} disabled={busy||Boolean(intent)} onChange={event=>setCode(event.target.value.trim().toLowerCase())} autoComplete="off" dir="ltr" maxLength={64} pattern="[0-9a-f]{64}" required /></label><button className={styles.primaryButton} type="submit" disabled={busy||Boolean(intent)}>{t("platform.deletion.find")}</button></form>
    {page?.items.map(row=><article className={styles.deletionRow} key={row.id}><p>{formatDateTime(row.receivedAt,locale,{dateStyle:"medium",timeStyle:"short"})} · {t(`platform.deletion.state.${row.state}`)}</p><button className={styles.secondaryButton} type="button" disabled={busy||Boolean(intent)||row.state==="REFUSED"} onClick={()=>{setSelected(row);setState("NEEDS_INFORMATION");setFile(undefined);}}>{t("platform.deletion.review")}</button></article>)}
    {page&&!page.items.length?<p>{t("platform.deletion.empty")}</p>:null}
    {page?.nextCursor?<button className={styles.secondaryButton} disabled={busy} type="button" onClick={()=>void load(true)}>{t("platform.deletion.more")}</button>:null}
    {selected?<form className={styles.deletionForm} onSubmit={submit}><p>{t("platform.deletion.reviewNotice")}</p><label>{t("platform.deletion.disposition")}<select disabled={busy||Boolean(intent)} value={state} onChange={event=>setState(event.target.value)}><option value="NEEDS_INFORMATION">{t("platform.deletion.state.NEEDS_INFORMATION")}</option><option value="HELD">{t("platform.deletion.state.HELD")}</option><option value="REFUSED" disabled={!page?.refusalAvailable}>{t("platform.deletion.state.REFUSED")}</option></select></label>
      <label>{t("platform.deletion.evidence")}<input type="file" aria-describedby="meta-deletion-evidence-help" required={!intent} disabled={busy||Boolean(intent)} accept=".pdf,.txt,.json" onChange={event=>setFile(event.target.files?.[0])} /></label><p id="meta-deletion-evidence-help">{t("platform.deletion.evidenceHelp")}</p>
      <button className={styles.primaryButton} type="submit" disabled={busy}>{t(intent?"platform.deletion.retry":"platform.deletion.saveReview")}</button><button className={styles.secondaryButton} type="button" disabled={busy||Boolean(intent)} onClick={()=>setSelected(undefined)}>{t("platform.deletion.cancel")}</button>
    </form>:null}
  </section>;
}
function readPage(value:unknown):Page{
  if(!value||typeof value!=="object"||!("refusalAvailable" in value)||typeof value.refusalAvailable!=="boolean"||!("items" in value)||!Array.isArray(value.items)||value.items.length>100)throw new Error("Review unavailable");
  const items=value.items as Receipt[];
  if(items.some(row=>!row||typeof row.id!=="string"||!/^[0-9a-f-]{36}$/iu.test(row.id)||!["SCOPE_REVIEW_REQUIRED","NEEDS_INFORMATION","HELD","REFUSED"].includes(row.state)||!Number.isSafeInteger(Number(row.version))||Number(row.version)<1||!Number.isFinite(Date.parse(row.receivedAt))||!Number.isFinite(Date.parse(row.expiresAt))))throw new Error("Review unavailable");
  const cursor="nextCursor" in value?value.nextCursor:undefined;if(cursor!==undefined&&cursor!==null&&(typeof cursor!=="string"||!/^[0-9a-f-]{36}$/iu.test(cursor)))throw new Error("Review unavailable");
  return{items,nextCursor:cursor as string|null|undefined,refusalAvailable:value.refusalAvailable};
}
