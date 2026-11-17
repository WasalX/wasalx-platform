"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import type {MetaCostStatementSummary} from "../packages/core/src/meta-cost";
import {formatDateTime,formatNumber} from "../lib/i18n/format";
import {useI18n} from "./I18nProvider";
import styles from "./MetaCostUsage.module.css";

export function MetaCostStatements({query,canExport}:{query:string;canExport:boolean}){
 const{t,locale}=useI18n(),[loaded,setLoaded]=useState<{scope:string;rows:MetaCostStatementSummary[]}|null>(null),[failed,setFailed]=useState(false),[loading,setLoading]=useState(false);
 const[chosen,setChosen]=useState(""),[detail,setDetail]=useState<{id:string;value:Record<string,unknown>}|null>(null),[downloading,setDownloading]=useState(false),[page,setPage]=useState(0),[detailFailed,setDetailFailed]=useState("");
 const sequence=useRef(0),detailSequence=useRef(0),alive=useRef(true),scope=`/api/meta-costs/statements?${query}`;
 const rows=loaded?.scope===scope?loaded.rows:[],selected=rows.find(row=>row.id===chosen),currentDetail=detail&&selected&&detail.id===selected.id?detail.value:null;
 useEffect(()=>{const listCounter=sequence,detailCounter=detailSequence;alive.current=true;return()=>{alive.current=false;listCounter.current++;detailCounter.current++;};},[]);
 const load=useCallback(async(signal?:AbortSignal)=>{
  const current=++sequence.current;setLoading(true);setFailed(false);
  try{const response=await fetch(scope,{cache:"no-store",signal});if(!response.ok)throw Error("unavailable");const value=await response.json() as MetaCostStatementSummary[];
   if(!Array.isArray(value)||value.length>1000)throw Error("limit");if(alive.current&&current===sequence.current)setLoaded({scope,rows:value});
  }catch(error){if(!(error instanceof DOMException&&error.name==="AbortError")&&alive.current&&current===sequence.current)setFailed(true);}
  finally{if(alive.current&&current===sequence.current)setLoading(false);}
 },[scope]);
 useEffect(()=>{const controller=new AbortController(),counter=sequence;queueMicrotask(()=>{if(!controller.signal.aborted)void load(controller.signal);});return()=>{counter.current++;controller.abort();};},[load]);
 useEffect(()=>{
  if(!selected)return;const controller=new AbortController(),counter=detailSequence,id=selected.id,current=++counter.current;
  void fetch(`/api/meta-costs/statements/${id}`,{cache:"no-store",signal:controller.signal}).then(async response=>{
   if(!response.ok)throw Error("unavailable");const result=await response.json() as {statement:Record<string,unknown>};
   if(alive.current&&current===detailSequence.current)setDetail({id,value:result.statement});
  }).catch(error=>{if(!(error instanceof DOMException&&error.name==="AbortError")&&alive.current&&current===detailSequence.current)setDetailFailed(id);});
  return()=>{counter.current++;controller.abort();};
 },[selected]);
 const download=async()=>{
  if(downloading||loading||loaded?.scope!==scope)return;const current=sequence.current;setDownloading(true);
  try{const response=await fetch(`/api/meta-costs/statement-export?${query}`,{cache:"no-store"});
   if(!response.ok||!(response.headers.get("content-type")??"").startsWith("text/csv"))throw Error("unavailable");const blob=await response.blob();if(blob.size>10_485_760)throw Error("limit");
   if(!alive.current||current!==sequence.current)return;const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download="wasalx-cost-statements.csv";link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  }catch{if(alive.current&&current===sequence.current)setFailed(true);}finally{if(alive.current)setDownloading(false);}
 };
 const currentPage=Math.min(page,Math.max(0,Math.ceil(rows.length/25)-1));
 const adjustments=Array.isArray(currentDetail?.adjustments)?currentDetail.adjustments as Array<{amount:string;treatment:string}>:[];
 return <section className={styles.management} aria-label={t("cost.statement.title")}><h3>{t("cost.statement.title")}</h3><p className={styles.help}>{t("cost.statement.description")}</p>
  {failed?<p role="alert">{t("cost.failed")} <button type="button" onClick={()=>void load()}>{t("cost.retry")}</button></p>:null}
  {loading?<p role="status">{t("cost.loading")}</p>:null}
  {canExport?<button type="button" disabled={loading||downloading||loaded?.scope!==scope} onClick={()=>void download()}>{t(downloading?"cost.exporting":"cost.statement.export")}</button>:null}
  {!loading&&!failed&&loaded?.scope===scope&&!rows.length?<p>{t("cost.statement.empty")}</p>:null}
  {rows.length?<div className={styles.tableWrap} role="region" aria-label={t("cost.statement.history")}
    // Keyboard users need to focus an otherwise non-interactive overflow area.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    tabIndex={0}><table><caption>{t("cost.statement.history")}</caption><thead><tr><th scope="col">{t("cost.statement.period")}</th><th scope="col">{t("cost.basis")}</th><th scope="col">{t("cost.statement.amount")}</th><th scope="col">{t("cost.state")}</th></tr></thead><tbody>
   {rows.slice(currentPage*25,(currentPage+1)*25).map(row=><tr key={row.id}><td>{formatDateTime(row.periodFrom,locale,{dateStyle:"medium"})} – {formatDateTime(row.periodTo,locale,{dateStyle:"medium"})}</td>
    <td>{t(`cost.statement.purpose.${row.purpose}`)}<small>{t(`cost.mode.${row.evidenceMode}`)}</small></td><td><bdi dir="ltr">{row.currency} {row.amount}</bdi></td>
    <td>{t(row.superseded?"cost.statement.superseded":"cost.statement.current")}<small>{t(`cost.statement.coverage.${row.coverage}`)}</small><button type="button" onClick={()=>setChosen(row.id)}>{t("cost.statement.details")}</button></td></tr>)}
  </tbody></table></div>:null}
  {rows.length>25?<nav className={styles.pagination} aria-label={t("cost.pages")}><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>{t("cost.previous")}</button><span>{t("cost.page",{page:formatNumber(currentPage+1,locale),count:formatNumber(Math.ceil(rows.length/25),locale)})}</span><button type="button" disabled={(currentPage+1)*25>=rows.length} onClick={()=>setPage(currentPage+1)}>{t("cost.next")}</button></nav>:null}
  {selected?<section className={styles.version} aria-label={t("cost.statement.details")}><h4>{t("cost.statement.details")}</h4><p>{t(`cost.statement.source.${selected.sourceAvailability}`)}</p>
   {currentDetail?<><p>{t("cost.statement.quantity",{count:currentDetail.quantity===null?t("cost.statement.quantityUnknown"):formatNumber(Number(currentDetail.quantity),locale)})}</p>
    <p>{t("cost.statement.estimate")}: <bdi dir="ltr">{currentDetail.estimatedAmount==null?t("cost.pending"):`${selected.currency} ${String(currentDetail.estimatedAmount)}`}</bdi></p>
    <p>{t("cost.statement.difference")}: <bdi dir="ltr">{currentDetail.difference===null?t("cost.pending"):`${selected.currency} ${String(currentDetail.difference)}`}</bdi></p>
    <p>{t(`cost.statement.coverage.${selected.coverage}`)}</p>
    {adjustments.length?<div className={styles.tableWrap} role="region" aria-label={t("cost.statement.adjustments")}
    // Keyboard users need to focus an otherwise non-interactive overflow area.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    tabIndex={0}><table><caption>{t("cost.statement.adjustments")}</caption><thead><tr><th scope="col">{t("cost.statement.adjustmentAmount")}</th><th scope="col">{t("cost.statement.adjustmentTreatment")}</th></tr></thead><tbody>{adjustments.map((item,index)=><tr key={index}><td><bdi dir="ltr">{selected.currency} {item.amount}</bdi></td><td>{t(`cost.statement.treatment.${item.treatment}`)}</td></tr>)}</tbody></table></div>:<p>{t("cost.statement.noAdjustments")}</p>}
    {Array.isArray(currentDetail.upstreamPublications)&&currentDetail.upstreamPublications.length?<p>{t("cost.statement.upstreamEvidence",{count:formatNumber(currentDetail.upstreamPublications.length,locale)})}</p>:null}
    <p>{t("cost.statement.published",{date:formatDateTime(selected.publishedAt,locale,{dateStyle:"medium",timeStyle:"short"})})}</p></>:detailFailed===selected.id?<p role="alert">{t("cost.failed")}</p>:<p role="status">{t("cost.loading")}</p>}
   <button type="button" onClick={()=>{setChosen("");setDetailFailed("");}}>{t("cost.statement.closeDetails")}</button></section>:null}
 </section>;
}
