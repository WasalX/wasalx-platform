"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {META_COST_SOURCE_MAX_BYTES,parseMetaCostStatement,parseMetaCostFinanceRetention,type MetaCostStatementInput} from "../../packages/core/src/meta-cost";
import {platformRequest,platformBinaryRequest} from "../../lib/platform-client";
import {formatDateTime,formatNumber} from "../../lib/i18n/format";
import {useI18n} from "../I18nProvider";
import styles from "../MetaCostUsage.module.css";
type Row={id:string;version:number;state:string;purpose:string;evidenceMode:string;currency:string;periodFrom:string;periodTo:string;sourceState:string};
type ReviewTarget={targetId:string;state:string;bindingSha256:string;policyVersion:number;outcome:string|null;jobState:string;scopeType:string};
type Detail=Row&{description:MetaCostStatementInput;inputSha256:string;originalSha256:string|null;originalByteSize:number|null;originalMime:string|null;
 writeAttemptId:string|null;writeDisposition:string|null;scanSha256:string|null;currentHeadId:string|null;priorAdjustments:Array<{statementVersionId:string;amount:string}>;
 verificationSha256:string|null;previewSha256:string|null;preview:Record<string,unknown>|null;publication:Record<string,unknown>|null;privacyReviews:ReviewTarget[]};
type Scope={tenantId:string;csrfToken:string};
type Mutation=(path:string,body:unknown)=>Promise<boolean>;

export function MetaCostStatementManagement({scope,accountId,window,revision,mutate,busy,uncertain}:{scope:Scope;accountId:string;window:{from:string;to:string};revision:number;mutate:Mutation;busy:boolean;uncertain:boolean}){
 const{t,locale}=useI18n(),[loaded,setLoaded]=useState<{scope:string;rows:Row[]}|null>(null),[selected,setSelected]=useState("");
 const[detail,setDetail]=useState<{scope:string;value:Detail}|null>(null),[description,setDescription]=useState<MetaCostStatementInput|null>(null),[loading,setLoading]=useState(false),[transfer,setTransfer]=useState(false),[feedback,setFeedback]=useState<string|null>(null);
 const[review,setReview]=useState<Record<string,unknown>|null>(null),[recovery,setRecovery]=useState<Record<string,unknown>|null>(null),[retention,setRetention]=useState<ReturnType<typeof parseMetaCostFinanceRetention>|null>(null),[confirmed,setConfirmed]=useState(false),[importScope,setImportScope]=useState("");
 const alive=useRef(true),sequence=useRef(0),detailSequence=useRef(0),fileSequence=useRef(0),[refresh,setRefresh]=useState(0);
 const root=`meta-costs/tenants/${scope.tenantId}/statements`,query=new URLSearchParams({accountId,from:window.from,to:window.to}).toString(),listScope=`${root}?${query}`;
 const rows=loaded?.scope===listScope?loaded.rows:[],chosen=rows.find(row=>row.id===selected),detailScope=`${listScope}/${chosen?.id??""}`;
 const current=detail?.scope===detailScope?detail.value:null,disabled=busy||uncertain||transfer;
 useEffect(()=>{const listCounter=sequence,detailCounter=detailSequence,fileCounter=fileSequence;alive.current=true;return()=>{alive.current=false;listCounter.current++;detailCounter.current++;fileCounter.current++;};},[]);
 const load=useCallback(async(signal?:AbortSignal)=>{const order=++sequence.current;setLoading(true);
  try{const result=await platformRequest<{statements:Row[]}>(scope,listScope,{signal});if(result.statements.length>1000)throw Error("limit");if(alive.current&&order===sequence.current){setLoaded({scope:listScope,rows:result.statements});setFeedback(previous=>previous==="cost.statement.failed"?null:previous);}}
  catch(error){if(!(error instanceof DOMException&&error.name==="AbortError")&&alive.current&&order===sequence.current)setFeedback("cost.statement.failed");}
  finally{if(alive.current&&order===sequence.current)setLoading(false);}
 },[scope,listScope]);
 useEffect(()=>{const controller=new AbortController(),listCounter=sequence,fileCounter=fileSequence;queueMicrotask(()=>{if(!controller.signal.aborted)void load(controller.signal);});return()=>{listCounter.current++;fileCounter.current++;controller.abort();};},[load,revision,refresh]);
 useEffect(()=>{if(!chosen)return;const controller=new AbortController(),counter=detailSequence,order=++counter.current;
  void platformRequest<Detail>(scope,`${root}/${chosen.id}`,{signal:controller.signal}).then(value=>{if(alive.current&&order===detailSequence.current)setDetail({scope:detailScope,value});})
   .catch(error=>{if(!(error instanceof DOMException&&error.name==="AbortError")&&alive.current&&order===detailSequence.current)setFeedback("cost.statement.failed");});
  return()=>{counter.current++;controller.abort();};
 },[scope,root,chosen,detailScope,revision,refresh]);
 const readFile=async(file:File|undefined,kind:"description"|"review"|"recovery"|"retention")=>{
  if(disabled)return;const order=++fileSequence.current,detailOrder=detailSequence.current;setImportScope(detailScope);
  // One pending imported action; a replacement cannot revive another scope's payload.
  setDescription(null);setReview(null);setRecovery(null);setRetention(null);
  setConfirmed(false);if(!file)return;
  try{if(file.size>524_288)throw Error("limit");const value=JSON.parse(await file.text());if(!alive.current||order!==fileSequence.current||detailOrder!==detailSequence.current)return;
   if(kind==="description"){const parsed=parseMetaCostStatement(value);if(parsed.accountId!==accountId||parsed.periodFrom!==window.from||parsed.periodTo!==window.to)throw Error("scope");setDescription(parsed);}
   else if(kind==="retention")setRetention(parseMetaCostFinanceRetention(value));
   else{if(!value||typeof value!=="object"||Array.isArray(value))throw Error("shape");if(kind==="review")setReview(value);else setRecovery(value);}
   setConfirmed(false);setFeedback(null);
  }catch{if(alive.current&&order===fileSequence.current)setFeedback("cost.statement.invalidFile");}
 };
 const submit=async(path:string,body:unknown)=>{if(disabled)return;if(await mutate(path,body)&&alive.current){setReview(null);setRecovery(null);setDescription(null);setRetention(null);setConfirmed(false);setRefresh(value=>value+1);}};
 const transferOriginal=async(file?:File)=>{
  if(!current||disabled||!current.originalSha256)return;const owned=current,id=owned.id,order=detailSequence.current;setTransfer(true);setFeedback(null);
  try{
   if(file){if(file.size!==owned.originalByteSize||file.size>META_COST_SOURCE_MAX_BYTES||file.type!==owned.originalMime)throw Error("source");
    const bytes=await file.arrayBuffer(),digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),value=>value.toString(16).padStart(2,"0")).join("");
    if(digest!==owned.originalSha256)throw Error("source");
    const response=await platformBinaryRequest(scope,`${root}/${id}/source`,{method:"PUT",body:bytes,mimeType:owned.originalMime!,signal:AbortSignal.timeout(125_000)});
    const result=await response.json() as {id:string;state:string};if(result.id!==id||result.state!=="READY")throw Error("source");
   }else{const response=await platformBinaryRequest(scope,`${root}/${id}/source`,{signal:AbortSignal.timeout(90_000)}),blob=await response.blob();
    if(blob.size!==owned.originalByteSize||blob.size>META_COST_SOURCE_MAX_BYTES)throw Error("source");
    if(!alive.current||order!==detailSequence.current)return;const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`cost-source.${owned.originalMime==="application/pdf"?"pdf":owned.originalMime==="text/csv"?"csv":"json"}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
   }
   if(alive.current&&order===detailSequence.current){setRefresh(value=>value+1);setFeedback("cost.statement.transferDone");}
  }catch{if(alive.current&&order===detailSequence.current){setFeedback("cost.statement.transferUnknown");setRefresh(value=>value+1);}}
  finally{if(alive.current)setTransfer(false);}
 };
 const sameDescription=importScope===detailScope&&description?.accountId===accountId&&description.periodFrom===window.from&&description.periodTo===window.to?description:null;
 const reviewMatches=Boolean(importScope===detailScope&&current&&review&&review.expectedVersion===current.version&&review.expectedInputSha256===current.inputSha256&&review.expectedCurrentHeadId===current.currentHeadId);
 const recoveryMatches=Boolean(importScope===detailScope&&current&&recovery&&recovery.expectedVersion===current.version);
 return <section className={styles.management} aria-label={t("cost.statement.manage")}><h3>{t("cost.statement.manage")}</h3><p className={styles.help}>{t("cost.statement.manageHelp")}</p>
  {feedback?<p role={feedback==="cost.statement.transferDone"?"status":"alert"}>{t(feedback)}</p>:null}{loading?<p role="status">{t("cost.loading")}</p>:null}
  <button type="button" disabled={loading||disabled} onClick={()=>setRefresh(value=>value+1)}>{t("cost.statement.reload")}</button>
  <fieldset disabled={disabled} className={styles.fieldset}><legend>{t("cost.statement.reserve")}</legend>
   <label>{t("cost.statement.descriptionFile")}<input type="file" accept=".json,application/json" onChange={event=>void readFile(event.target.files?.[0],"description")}/></label>
   {sameDescription?<><p>{t(`cost.statement.purpose.${sameDescription.basisKind==="UPSTREAM_SOURCE"?"UPSTREAM_CHARGE":"CUSTOMER_CHARGE"}`)} · <bdi>{sameDescription.currency}</bdi></p>
    <p>{formatDateTime(sameDescription.periodFrom,locale,{dateStyle:"medium"})} – {formatDateTime(sameDescription.periodTo,locale,{dateStyle:"medium"})}</p>
    {sameDescription.basisKind==="UPSTREAM_SOURCE"?<p>{t("cost.statement.sourceSummary",{amount:`${sameDescription.currency} ${sameDescription.source.sourceTotal}`,count:formatNumber(sameDescription.lines.length,locale)})}</p>:<p>{t("cost.statement.derivedHelp")}</p>}
    <button type="button" onClick={()=>void submit(root,sameDescription)}>{t("cost.statement.reserve")}</button></>:null}
  </fieldset>
  <details><summary>{t("cost.statement.retention")}</summary><fieldset disabled={disabled} className={styles.fieldset}>
   <p>{t("cost.statement.retentionHelp")}</p><label>{t("cost.statement.retentionFile")}<input type="file" accept=".json,application/json" onChange={event=>void readFile(event.target.files?.[0],"retention")}/></label>
   {retention&&importScope===detailScope?<><p>{t("cost.statement.retentionDays",{source:formatNumber(retention.sourceDays,locale),record:formatNumber(retention.recordDays,locale)})}</p><button type="button" onClick={()=>void submit(`meta-costs/tenants/${scope.tenantId}/finance-retention`,retention)}>{t("cost.statement.approveRetention")}</button></>:null}
  </fieldset></details>
  <label className={styles.filters}>{t("cost.statement.version")}<select value={chosen?.id??""} onChange={event=>{setSelected(event.target.value);setReview(null);setRecovery(null);setConfirmed(false);}}><option value="">{t("cost.statement.choose")}</option>{rows.map((row,index)=><option value={row.id} key={row.id}>{t("cost.manage.version",{count:formatNumber(index+1,locale)})} · {t(`cost.statement.state.${row.state}`)} · {t(`cost.mode.${row.evidenceMode}`)}</option>)}</select></label>
  {current?<fieldset disabled={disabled} className={styles.fieldset}><legend>{t("cost.statement.review")}</legend><p>{t(`cost.statement.state.${current.state}`)} · {t(`cost.statement.sourceState.${current.sourceState}`)}</p>
   {current.originalSha256?<><p className={styles.digest}><bdi dir="ltr">{current.originalSha256}</bdi></p>
    {current.sourceState==="RESERVED"?<label>{t("cost.statement.original")}<input type="file" accept=".pdf,.csv,.json,application/pdf,text/csv,application/json" onChange={event=>{const file=event.target.files?.[0];if(file)void transferOriginal(file);}}/></label>:null}
    {current.sourceState==="READY"?<button type="button" onClick={()=>void transferOriginal()}>{t("cost.statement.downloadOriginal")}</button>:null}</>:null}
   {current.state==="SOURCE_READY"||current.state==="REVIEWED"?<><button type="button" onClick={()=>downloadWorksheet({expectedVersion:current.version,expectedInputSha256:current.inputSha256,expectedCurrentHeadId:current.currentHeadId,originalSha256:current.originalSha256,
     reviewSha256:null,subjectCoverage:current.description.basisKind==="UPSTREAM_SOURCE"?"UNKNOWN":"VERIFIED_NO_SUBJECT_DATA",subjectRefs:[],priorAdjustments:current.description.basisKind==="UPSTREAM_SOURCE"&&current.description.source.sourceKind==="FULL_REPLACEMENT"?current.priorAdjustments.map(item=>({statementVersionId:item.statementVersionId,treatment:"UNKNOWN"})):[]})}>{t("cost.statement.reviewWorksheet")}</button><label>{t("cost.statement.reviewFile")}<input type="file" accept=".json,application/json" onChange={event=>void readFile(event.target.files?.[0],"review")}/></label>
    {review?<p>{t(reviewMatches?"cost.statement.reviewBound":"cost.statement.reviewStale")}</p>:null}
    <label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>{t("cost.statement.confirmReview")}</label>
    <button type="button" disabled={!reviewMatches||!confirmed} onClick={()=>void submit(`${root}/${current.id}/review`,review)}>{t("cost.statement.recordReview")}</button>
    {current.verificationSha256?<button type="button" onClick={()=>void submit(`${root}/${current.id}/preview`,{expectedVersion:current.version,expectedVerificationSha256:current.verificationSha256})}>{t("cost.statement.preview")}</button>:null}
   </>:null}
   {current.preview?<><h4>{t("cost.statement.preview")}</h4><p><bdi dir="ltr">{String(current.preview.currency)} {String(current.preview.amount)}</bdi> · {t(`cost.statement.coverage.${String(current.preview.coverage)}`)}</p>
    <p>{t("cost.statement.difference")}: <bdi dir="ltr">{current.preview.difference===null?t("cost.pending"):String(current.preview.difference)}</bdi></p>
    <p>{t("cost.statement.unresolved",{count:formatNumber(Number(current.preview.unresolvedAssessments)+Number(current.preview.unknownModeAssessments),locale)})}</p>
    <button type="button" disabled={current.state!=="REVIEWED"||!current.previewSha256} onClick={()=>void submit(`${root}/${current.id}/publish`,{expectedVersion:current.version,expectedInputSha256:current.inputSha256,expectedVerificationSha256:current.verificationSha256,expectedPreviewSha256:current.previewSha256,expectedCurrentHeadId:current.preview!.currentHeadId})}>{t("cost.statement.publish")}</button></>:null}
   {current.writeDisposition==="UNKNOWN"||current.writeDisposition==="ADMITTED"||current.privacyReviews.some(target=>target.state==="PENDING")?<details><summary>{t("cost.statement.recovery")}</summary><p>{t("cost.statement.recoveryHelp")}</p>
    <label>{t("cost.statement.recoveryFile")}<input type="file" accept=".json,application/json" onChange={event=>void readFile(event.target.files?.[0],"recovery")}/></label>
    {current.writeDisposition==="UNKNOWN"||current.writeDisposition==="ADMITTED"?<><button type="button" onClick={()=>downloadWorksheet({expectedVersion:current.version,originalSha256:current.originalSha256,writeAttemptId:current.writeAttemptId,scanSha256:current.scanSha256,outcome:"UNKNOWN",terminalDispositionEvidenceSha256:null})}>{t("cost.statement.recoveryWorksheet")}</button><button type="button" disabled={!recoveryMatches} onClick={()=>void submit(`${root}/${current.id}/reconcile-source`,recovery)}>{t("cost.statement.recordDisposition")}</button></>:null}
    {current.privacyReviews.filter(target=>target.state==="PENDING").map((target,index)=><div key={target.targetId}><p>{t("cost.statement.privacyReview",{count:formatNumber(index+1,locale)})}</p><button type="button" onClick={()=>downloadWorksheet({expectedVersion:current.version,targetId:target.targetId,expectedBindingSha256:target.bindingSha256,expectedPolicyVersion:target.policyVersion,outcome:"UNKNOWN",reviewSha256:null})}>{t("cost.statement.recoveryWorksheet")}</button><button type="button" disabled={!recoveryMatches||recovery?.targetId!==target.targetId||recovery?.expectedBindingSha256!==target.bindingSha256||recovery?.expectedPolicyVersion!==target.policyVersion} onClick={()=>void submit(`${root}/${current.id}/privacy-review`,recovery)}>{t("cost.statement.recordPrivacyReview")}</button></div>)}
   </details>:null}
  </fieldset>:null}
 </section>;
}

function downloadWorksheet(value:unknown){
 const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"})),link=document.createElement("a");
 link.href=url;link.download="cost-statement-review.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
}
