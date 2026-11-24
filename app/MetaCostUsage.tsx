"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { MetaCostUsageSnapshot } from "../packages/core/src/meta-cost";
import { formatDateTime, formatNumber } from "../lib/i18n/format";
import { useI18n } from "./I18nProvider";
import { ScrollRegion } from "./tenant-ui";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./MetaCostUsage.module.css";
import {MetaCostStatements} from "./MetaCostStatements";

export type CostAccount={id:string;names:string[]};
export type CostUsage=MetaCostUsageSnapshot&{accounts?:CostAccount[];tariffs?:Array<Record<string,unknown>>};
type PlatformScope={tenantId:string;csrfToken:string};

export function MetaCostUsage({canExport,platform,management,refreshKey=0}:{canExport:boolean;platform?:PlatformScope;refreshKey?:number;
  management?:(snapshot:CostUsage,accountId:string,window:{from:string;to:string})=>ReactNode}){
  const{locale,t}=useI18n();
  const[open,setOpen]=useState(Boolean(platform)),[accounts,setAccounts]=useState<CostAccount[]>([]),[account,setAccount]=useState("unattributed");
  const[window,setWindow]=useState(()=>{const now=new Date();return{from:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString().slice(0,16),to:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString().slice(0,16)}});
  const[loaded,setLoaded]=useState<{scope:string;value:CostUsage}|null>(null),[loading,setLoading]=useState(false),[failed,setFailed]=useState(false),[downloading,setDownloading]=useState(false),[page,setPage]=useState(0);
  const sequence=useRef(0),alive=useRef(true);
  const invalidate=useCallback(()=>{sequence.current++;},[]);
  const query=new URLSearchParams({accountId:account,from:`${window.from}:00.000Z`,to:`${window.to}:00.000Z`}).toString();
  const endpoint=platform?`/api/platform-console/meta-costs/tenants/${platform.tenantId}`:"/api/meta-costs/usage";
  const scope=`${endpoint}?${query}`;
  const snapshot=loaded?.scope===scope?loaded.value:null;
  const invalid=!window.from||!window.to||window.from>=window.to||Date.parse(`${window.to}Z`)-Date.parse(`${window.from}Z`)>366*86400000;
  const load=useCallback(async(signal?:AbortSignal)=>{
    if(!open||invalid)return;
    const current=++sequence.current;setLoading(true);setFailed(false);
    try{
      const[response,accountResponse]=await Promise.all([fetch(`${endpoint}?${query}`,{cache:"no-store",signal}),platform?null:fetch("/api/meta-costs/accounts",{cache:"no-store",signal})]);
      if(!response.ok||(accountResponse&&!accountResponse.ok))throw new Error("unavailable");
      const value=await response.json() as CostUsage;
      const choices=accountResponse?await accountResponse.json() as CostAccount[]:value.accounts??[];
      if(!value.complete)throw new Error("incomplete");
      if(alive.current&&current===sequence.current){setLoaded({scope,value});setAccounts(choices);}
    }catch(error){if(!(error instanceof DOMException&&error.name==="AbortError")&&alive.current&&current===sequence.current){setFailed(true);setLoaded(null);}}
    finally{if(alive.current&&current===sequence.current)setLoading(false);}
  },[open,invalid,endpoint,query,scope,platform]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;invalidate();}},[invalidate]);
  useEffect(()=>{const controller=new AbortController();queueMicrotask(()=>{if(!controller.signal.aborted)void load(controller.signal);});return()=>{invalidate();controller.abort();};},[load,refreshKey,invalidate]);
  useVisibleRefresh(load,open&&!invalid,60_000);
  const download=async()=>{
    if(downloading||!snapshot||loading||invalid)return;
    const current=sequence.current;setDownloading(true);setFailed(false);
    try{
      const path=platform?`${endpoint}/export`:"/api/meta-costs/export";
      const response=await fetch(`${path}?${query}`,{cache:"no-store"});
      if(!response.ok||!(response.headers.get("content-type")??"").startsWith("text/csv"))throw new Error("export");
      const blob=await response.blob();if(blob.size>10*1024*1024)throw new Error("export limit");
      if(!alive.current||current!==sequence.current)return;
      const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="wasalx-meta-costs.csv";link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
    }catch{if(alive.current&&current===sequence.current)setFailed(true);}
    finally{if(alive.current)setDownloading(false);}
  };
  const currentPage=Math.min(page,Math.max(0,Math.ceil((snapshot?.rows.length??0)/100)-1));
  const rows=snapshot?.rows.slice(currentPage*100,(currentPage+1)*100)??[];
  return <details className={styles.section} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{t("cost.title")}</summary>
    {open?<div className={styles.content}>
      <p className={styles.help}>{t("cost.description")}</p>
      <div className={styles.filters}>
        <label>{t("cost.account")}<select value={account} onChange={event=>{setAccount(event.target.value);setPage(0);}}><option value="unattributed">{t("cost.unattributed")}</option>{accounts.map((item,index)=><option key={item.id} value={item.id}>{item.names.join(" / ")||t("cost.accountFallback",{count:formatNumber(index+1,locale)})}</option>)}</select></label>
        <label>{t("cost.from")}<input type="datetime-local" value={window.from} onChange={event=>{setWindow({...window,from:event.target.value});setPage(0);}}/></label>
        <label>{t("cost.to")}<input type="datetime-local" value={window.to} onChange={event=>{setWindow({...window,to:event.target.value});setPage(0);}}/></label>
        {canExport?<button type="button" disabled={loading||downloading||!snapshot||invalid} onClick={()=>void download()}>{t(downloading?"cost.exporting":"cost.export")}</button>:null}
      </div>
      {invalid?<p role="alert">{t("cost.invalidPeriod")}</p>:null}
      {failed?<p role="alert">{t("cost.failed")} <button type="button" onClick={()=>void load()}>{t("cost.retry")}</button></p>:null}
      {loading?<p role="status">{t("cost.loading")}</p>:null}
      {snapshot?<>
        <div className={styles.coverage}>{snapshot.coverage.map(item=><p key={`${item.purpose}-${item.evidence_mode}`}><b>{t(`cost.purpose.${item.purpose}`)} · {t(`cost.mode.${item.evidence_mode}`)}</b><span>{t("cost.coverage",{delivered:formatNumber(item.delivered,locale),estimated:formatNumber(item.estimated,locale),unresolved:formatNumber(item.unresolved,locale),free:formatNumber(item.reported_free,locale)})}</span></p>)}</div>
        {snapshot.totals.length?<ul className={styles.totals}>{snapshot.totals.map(item=><li key={`${item.purpose}-${item.evidenceMode}-${item.currency}-${item.tariffVersionId}`}><span>{t(`cost.purpose.${item.purpose}`)} · {t(`cost.mode.${item.evidenceMode}`)} · {t(`cost.rounding.${item.rounding}`)}</span><strong><bdi dir="ltr">{item.amount===null?t("cost.partialPeriod"):`${item.currency} ${item.amount}`}</bdi></strong>{item.partialPeriod?<button type="button" onClick={()=>{setWindow({from:new Date(item.periodFrom).toISOString().slice(0,16),to:new Date(item.periodTo).toISOString().slice(0,16)});setPage(0);}}>{t("cost.wholePeriod")}</button>:null}</li>)}</ul>:null}
        {snapshot.rows.length?<ScrollRegion className={styles.tableWrap} aria-label={t("cost.tableCaption")}><table><caption>{t("cost.tableCaption")}</caption><thead><tr><th scope="col">{t("cost.when")}</th><th scope="col">{t("cost.basis")}</th><th scope="col">{t("cost.state")}</th><th scope="col">{t("cost.amount")}</th></tr></thead><tbody>{rows.map(row=><tr key={`${row.deliveryId}-${row.purpose}`}><td>{formatDateTime(row.deliveredAt??row.observedAt,locale,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"})}</td><td>{t(`cost.purpose.${row.purpose}`)}<small>{t(`cost.mode.${row.evidenceMode}`)} · {t(`cost.payer.${row.payerState}`)}</small></td><td>{t(`cost.state.${row.state}`)}<small>{t(`cost.reason.${row.reason}`)}</small></td><td><bdi dir="ltr">{row.amount===null?t("cost.pending"):`${row.currency} ${row.amount}`}</bdi></td></tr>)}</tbody></table></ScrollRegion>:<p>{t("cost.empty")}</p>}
        {snapshot.rows.length>100?<nav className={styles.pagination} aria-label={t("cost.pages")}><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>{t("cost.previous")}</button><span>{t("cost.page",{page:formatNumber(currentPage+1,locale),count:formatNumber(Math.ceil(snapshot.rows.length/100),locale)})}</span><button type="button" disabled={(currentPage+1)*100>=snapshot.rows.length} onClick={()=>setPage(currentPage+1)}>{t("cost.next")}</button></nav>:null}
        {!platform&&account!=="unattributed"?<MetaCostStatements key={account} query={query} canExport={canExport}/>:null}
        {management?.(snapshot,account,{from:`${window.from}:00.000Z`,to:`${window.to}:00.000Z`})}
      </>:null}
    </div>:null}
  </details>;
}
