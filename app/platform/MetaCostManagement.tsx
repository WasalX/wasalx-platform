"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseMetaCostSelectorEvidence, parseMetaCostTariff, type MetaCostTariffInput, type MetaCostSelectorEvidence } from "../../packages/core/src/meta-cost";
import { formatDateTime, formatNumber } from "../../lib/i18n/format";
import { platformRequest } from "../../lib/platform-client";
import { useI18n } from "../I18nProvider";
import { MetaCostUsage, type CostUsage } from "../MetaCostUsage";
import styles from "../MetaCostUsage.module.css";
import {MetaCostStatementManagement} from "./MetaCostStatementManagement";

type OperatorScope={tenantId:string;csrfToken:string};
type Tariff={id:string;state:"DRAFT"|"ACTIVE";definition:MetaCostTariffInput;definition_sha256:string;supersedes_id:string|null;created_at:string;accepted_policies:Array<{id:string;createdAt:string}>};
type Mutation=(path:string,body:unknown)=>Promise<boolean>;

export function PlatformMetaCosts({tenantId,csrfToken}:OperatorScope){
  // Scope is stable across local state refreshes; a workspace change remounts the drawer.
  const scope=useMemo(()=>({tenantId,csrfToken}),[tenantId,csrfToken]);
  const{t}=useI18n(),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[feedback,setFeedback]=useState<string|null>(null),[revision,setRevision]=useState(0);
  const intent=useRef<{path:string;body:unknown;key:string}|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  // Keep one unresolved intent in the drawer, independent of account/period reads.
  const mutate:Mutation=async(path,body)=>{
    if(busy)return false;
    if(intent.current&&(intent.current.path!==path||JSON.stringify(intent.current.body)!==JSON.stringify(body))){setFeedback("cost.manage.resolveFirst");return false;}
    const request=intent.current??{path,body,key:crypto.randomUUID()};intent.current=request;setBusy(true);setFeedback(null);
    try{
      await platformRequest(scope,request.path,{method:"POST",body:request.body,idempotencyKey:request.key,signal:AbortSignal.timeout(20_000)});intent.current=null;
      if(alive.current){setUncertain(false);setFeedback("cost.manage.saved");setRevision(value=>value+1);}return true;
    }catch(error){if(error&&typeof error==="object"&&"status" in error&&typeof error.status==="number"&&error.status<500)intent.current=null;
      if(alive.current){setUncertain(intent.current!==null);setFeedback(intent.current?"cost.manage.uncertain":"cost.manage.failed");}return false;
    }finally{if(alive.current)setBusy(false);}
  };
  return <>
    {feedback?<p role={feedback==="cost.manage.saved"?"status":"alert"}>{t(feedback)}</p>:null}
    {uncertain?<button type="button" disabled={busy} onClick={()=>{if(intent.current)void mutate(intent.current.path,intent.current.body);}}>{t("cost.manage.reconcile")}</button>:null}
    <MetaCostUsage canExport platform={scope} refreshKey={revision} management={(snapshot,account,window)=>account==="unattributed"?null:
      <div key={account}><Management scope={scope} snapshot={snapshot} accountId={account} mutate={mutate} busy={busy} uncertain={uncertain}/><MetaCostStatementManagement scope={scope} accountId={account} window={window} revision={revision} mutate={mutate} busy={busy} uncertain={uncertain}/></div>}/>
  </>;
}

function Management({scope,snapshot,accountId,mutate,busy,uncertain}:{scope:OperatorScope;snapshot:CostUsage;accountId:string;mutate:Mutation;busy:boolean;uncertain:boolean}){
  const{locale,t}=useI18n(),[definition,setDefinition]=useState<MetaCostTariffInput|null>(null),[supersedes,setSupersedes]=useState("");
  const[selector,setSelector]=useState<MetaCostSelectorEvidence|null>(null),[clearSelector,setClearSelector]=useState(false),[purpose,setPurpose]=useState<"UPSTREAM_REFERENCE"|"CUSTOMER_TARIFF">("UPSTREAM_REFERENCE");
  const[selection,setSelection]=useState<{scope:string;ids:string[]}>({scope:"",ids:[]}),[policy,setPolicy]=useState<Record<string,string>>({}),[feedback,setFeedback]=useState<string|null>(null);
  const[paging,setPaging]=useState({scope:"",index:0});
  const alive=useRef(true),fileGeneration=useRef({tariff:0,selector:0});
  const[selectorRead,setSelectorRead]=useState<"UNCHANGED"|"PENDING"|"INVALID"|"VALID">("UNCHANGED");
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const tariffs=(snapshot.tariffs??[]) as unknown as Tariff[];
  const active=tariffs.filter(item=>item.state==="ACTIVE"&&!tariffs.some(newer=>newer.state==="ACTIVE"&&newer.supersedes_id===item.id));
  const rows=snapshot.rows.filter(row=>row.purpose===purpose&&row.id!==null&&!row.evidenceRedacted&&row.evidenceMode!=="UNKNOWN");
  const rowScope=JSON.stringify([accountId,snapshot.from,snapshot.to,purpose]);
  const fileScope=JSON.stringify([scope.tenantId,scope.csrfToken,rowScope]);
  const currentFileScope=useRef(fileScope);
  useEffect(()=>{const counter=fileGeneration;currentFileScope.current=fileScope;return()=>{counter.current.tariff++;counter.current.selector++;};},[fileScope]);
  const pageCount=Math.max(1,Math.ceil(rows.length/100)),page=paging.scope===rowScope?Math.min(paging.index,pageCount-1):0;
  const pageRows=rows.slice(page*100,(page+1)*100),selected=selection.scope===rowScope?selection.ids:[];
  const setSelected=(ids:string[])=>setSelection({scope:rowScope,ids});
  const currentSelection=pageRows.filter(row=>row.id!==null&&selected.includes(row.id));
  const root=`meta-costs/tenants/${scope.tenantId}`;
  const submit=async(path:string,body:unknown)=>{
    if(await mutate(path,body)&&alive.current){setDefinition(null);setSelected([]);setFeedback(null);}
  };
  const readFile=async(file:File|undefined,kind:"tariff"|"selector")=>{
    const generation=++fileGeneration.current[kind],ownedScope=fileScope;
    // Invalidate before any asynchronous read, including empty/invalid selection.
    if(kind==="tariff"){setDefinition(null);setSupersedes("");}
    else{setSelector(null);setClearSelector(false);setSelectorRead("INVALID");}
    setFeedback(null);
    if(!file||busy||uncertain)return;
    const current=()=>alive.current&&generation===fileGeneration.current[kind]&&ownedScope===currentFileScope.current;
    try{
      if(file.size>65536)throw new Error("size");if(kind==="selector")setSelectorRead("PENDING");
      const value=JSON.parse(await file.text());if(!current())return;
      if(kind==="tariff"){const parsed=parseMetaCostTariff(value);if(parsed.tenantId!==scope.tenantId||parsed.accountId!==accountId)throw new Error("scope");setDefinition(parsed);}
      else{setSelector(parseMetaCostSelectorEvidence(value));setSelectorRead("VALID");}
      setFeedback(null);
    }catch{if(current()){if(kind==="selector")setSelectorRead("INVALID");setFeedback("cost.manage.invalidFile");}}
  };
  return <section className={styles.management} aria-label={t("cost.manage.title")}>
    <h3>{t("cost.manage.title")}</h3><p className={styles.help}>{t("cost.manage.description")}</p>
    {feedback?<p role={feedback==="cost.manage.saved"?"status":"alert"}>{t(feedback)}</p>:null}
    <fieldset disabled={busy||uncertain} className={styles.fieldset}><legend>{t("cost.manage.tariff")}</legend>
      <label>{t("cost.manage.rateFile")}<input type="file" accept=".json,application/json" onChange={event=>void readFile(event.target.files?.[0],"tariff")}/></label>
      {definition?<>
        <p>{t(`cost.purpose.${definition.purpose}`)} · {t(`cost.mode.${definition.evidenceMode}`)} · <bdi>{definition.currency}</bdi> · {t(`cost.rounding.${definition.rounding}`)}</p>
        <p>{formatDateTime(definition.effectiveFrom,locale,{dateStyle:"medium",timeStyle:"short"})} – {formatDateTime(definition.effectiveTo,locale,{dateStyle:"medium",timeStyle:"short"})} · <bdi>{definition.timezone}</bdi></p>
        <div className={styles.tableWrap} role="region" aria-label={t("cost.manage.preview")}
    // Keyboard users need to focus an otherwise non-interactive overflow area.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    tabIndex={0}><table><caption>{t("cost.manage.preview")}</caption><thead><tr><th>{t("cost.manage.category")}</th><th>{t("cost.manage.marketTier")}</th><th>{t("cost.manage.price")}</th></tr></thead><tbody>{definition.rates.map((rate,index)=><tr key={index}><td>{t(`cost.category.${rate.category}`)}<small>{t(`cost.schedule.${rate.schedule}`)} · {t(`cost.pricingType.${rate.pricingType}`)}</small></td><td><bdi>{rate.market} / {rate.tier}</bdi></td><td><bdi dir="ltr">{definition.currency} {rate.unitPrice}</bdi></td></tr>)}</tbody></table></div>
        <label>{t("cost.manage.replaces")}<select value={supersedes} onChange={event=>setSupersedes(event.target.value)}><option value="">{t("cost.manage.newPeriod")}</option>{active.filter(item=>item.definition.purpose===definition.purpose&&item.definition.evidenceMode===definition.evidenceMode).map((item,index)=><option key={item.id} value={item.id}>{t("cost.manage.version",{count:formatNumber(index+1,locale)})} · {formatDateTime(item.created_at,locale,{dateStyle:"medium"})}</option>)}</select></label>
        <details><summary>{t("cost.manage.source")}</summary><p className={styles.digest}><bdi dir="ltr">{definition.sourceSha256}</bdi></p></details>
        <button type="button" onClick={()=>void submit(`${root}/tariffs`,{definition,supersedesId:supersedes||null})}>{t("cost.manage.saveDraft")}</button>
      </>:null}
    </fieldset>
    {tariffs.length?<fieldset disabled={busy||uncertain} className={styles.fieldset}><legend>{t("cost.manage.versions")}</legend>{tariffs.map((item,index)=>{
      const chosen=policy[item.id]??(item.accepted_policies.length===1?item.accepted_policies[0]!.id:"");
      return <div className={styles.version} key={item.id}><h4>{t("cost.manage.version",{count:formatNumber(index+1,locale)})} · {t(`cost.tariffState.${item.state}`)}</h4>
        <p>{t(`cost.purpose.${item.definition.purpose}`)} · {t(`cost.mode.${item.definition.evidenceMode}`)} · <bdi>{item.definition.currency}</bdi></p>
        <p>{formatDateTime(item.definition.effectiveFrom,locale,{dateStyle:"medium"})} – {formatDateTime(item.definition.effectiveTo,locale,{dateStyle:"medium"})}</p>
        <details><summary>{t("cost.manage.reviewVersion")}</summary><p><bdi>{item.definition.timezone}</bdi> · {t(`cost.rounding.${item.definition.rounding}`)}</p><ul>{item.definition.rates.map((rate,ordinal)=><li key={ordinal}>{t(`cost.category.${rate.category}`)} · {t(`cost.schedule.${rate.schedule}`)} · {t(`cost.pricingType.${rate.pricingType}`)} · <bdi>{rate.market} / {rate.tier}</bdi> · <bdi dir="ltr">{item.definition.currency} {rate.unitPrice}</bdi></li>)}</ul><p className={styles.digest}><bdi dir="ltr">{item.definition.sourceSha256}</bdi></p></details>
        {item.state==="DRAFT"?<>
          {item.definition.purpose==="CUSTOMER_TARIFF"?<label>{t("cost.manage.acceptance")}<select value={chosen} onChange={event=>setPolicy({...policy,[item.id]:event.target.value})}><option value="">{t("cost.manage.acceptanceRequired")}</option>{item.accepted_policies.map((accepted,ordinal)=><option key={accepted.id} value={accepted.id}>{t("cost.manage.acceptanceVersion",{count:formatNumber(ordinal+1,locale)})} · {formatDateTime(accepted.createdAt,locale,{dateStyle:"medium"})}</option>)}</select></label>:null}
          <button type="button" disabled={item.definition.purpose==="CUSTOMER_TARIFF"&&!chosen} onClick={()=>void submit(`${root}/tariffs/${item.id}/activate`,{expectedDefinitionSha256:item.definition_sha256,policyVersionId:item.definition.purpose==="CUSTOMER_TARIFF"?chosen:null})}>{t("cost.manage.activate")}</button>
        </>:null}
      </div>})}</fieldset>:null}
    <fieldset disabled={busy||uncertain} className={styles.fieldset}><legend>{t("cost.manage.reassess")}</legend><p>{t("cost.manage.reassessHelp")}</p>
      <label>{t("cost.basis")}<select value={purpose} onChange={event=>{setPurpose(event.target.value as typeof purpose);setSelected([]);}}><option value="UPSTREAM_REFERENCE">{t("cost.purpose.UPSTREAM_REFERENCE")}</option><option value="CUSTOMER_TARIFF">{t("cost.purpose.CUSTOMER_TARIFF")}</option></select></label>
      <label>{t("cost.manage.selectorFile")}<input type="file" accept=".json,application/json" onChange={event=>void readFile(event.target.files?.[0],"selector")}/></label>
      <label><input type="checkbox" checked={clearSelector} onChange={event=>{fileGeneration.current.selector++;setClearSelector(event.target.checked);setSelector(null);setSelectorRead("UNCHANGED");setFeedback(null);}}/>{t("cost.manage.clearSelector")}</label>
      {selector?<p>{t(`cost.mode.${selector.evidenceMode}`)} · <bdi>{selector.market} / {selector.tier}</bdi> · {t(`cost.schedule.${selector.schedule}`)}</p>:null}
      <div className={styles.selection}>{pageRows.map((row,index)=><label key={row.deliveryId}><input type="checkbox" checked={selected.includes(row.id!)} onChange={event=>setSelected(event.target.checked?[...selected,row.id!]:selected.filter(id=>id!==row.id))}/><span>{t("cost.manage.message",{count:formatNumber(page*100+index+1,locale)})} · {formatDateTime(row.deliveredAt??row.observedAt,locale,{dateStyle:"medium",timeStyle:"short"})}<small>{t(`cost.mode.${row.evidenceMode}`)} · {t(`cost.state.${row.state}`)}</small></span></label>)}</div>
      {pageCount>1?<nav aria-label={t("cost.pages")}><button type="button" disabled={page===0} onClick={()=>{setPaging({scope:rowScope,index:page-1});setSelected([]);}}>{t("cost.previous")}</button><span aria-live="polite">{t("cost.page",{page:formatNumber(page+1,locale),count:formatNumber(pageCount,locale)})}</span><button type="button" disabled={page+1===pageCount} onClick={()=>{setPaging({scope:rowScope,index:page+1});setSelected([]);}}>{t("cost.next")}</button></nav>:null}
      <button type="button" disabled={selectorRead==="PENDING"||selectorRead==="INVALID"||!currentSelection.length||(selector!==null&&currentSelection.some(row=>row.evidenceMode!==selector.evidenceMode))} onClick={()=>void submit(`${root}/accounts/${accountId}/reassess`,{purpose,items:currentSelection.map(row=>({deliveryId:row.deliveryId,expectedHeadId:row.id,...(selector?{selectorEvidence:selector}:clearSelector?{selectorEvidence:null}:{} )}))})}>{t("cost.manage.reassessSelected",{count:formatNumber(currentSelection.length,locale)})}</button>
    </fieldset>
  </section>;
}
