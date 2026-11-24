"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import { useI18n } from "./I18nProvider";
import { formatNumber } from "../lib/i18n/format.ts";
import { operatorFailureMessage, operatorLocalFailure, createLatestRequestFence, visibleReviewMetadata, deliveryFailureGuidance } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { isAbortError } from "../lib/bot-conversations";
import { type RecordRow, RelativeTime, type TenantTranslator, apiError, requiresPrivilegedReauthentication, privilegedStepUpHref, Status, Empty, WideTable, ScrollRegion, REVIEW_REASON_KEYS, reviewOriginalReason, reviewReason, reviewState, deliveryRetriesAutomatically, deliveryHoldReason, DeliveryTable } from "./tenant-ui";

const REVIEW_SOURCE_KEYS = new Set(["inbound", "outbound"]);

function reviewSummary(row: RecordRow, t: TenantTranslator) {
  const state = reviewState(row.state);
  if (state === "resolved" || state === "discarded") {
    return t("tenant.deliveries.review.closed.summary", { reason: reviewOriginalReason(row, t) });
  }
  const reason = String(row.reason_code ?? "").toLowerCase();
  return REVIEW_REASON_KEYS.has(reason)
    ? t(`tenant.deliveries.review.summary.${reason}`)
    : t("tenant.deliveries.review.summary.unknown");
}

function reviewSource(value: unknown, t: TenantTranslator) {
  const source = String(value ?? "").toLowerCase();
  return REVIEW_SOURCE_KEYS.has(source)
    ? t(`tenant.deliveries.review.source.${source}`)
    : t("tenant.deliveries.review.source.unknown");
}

function reviewMetadataValue(
  value: unknown,
  locale: "en" | "ar",
  t: TenantTranslator,
  showDiagnostics: boolean,
) {
  if (typeof value === "number") return formatNumber(value, locale);
  if (typeof value === "boolean") {
    return t(value ? "tenant.deliveries.review.metadata.yes" : "tenant.deliveries.review.metadata.no");
  }
  if (typeof value === "string") return value;
  if (showDiagnostics) {
    try {
      return JSON.stringify(value);
    } catch {
      return t("tenant.deliveries.review.metadata.unavailable");
    }
  }
  return t("tenant.deliveries.review.metadata.unavailable");
}

export function Deliveries({
  rows,
  retry,
  retryPending,
  canRetry,
  canReadReview,
  canReview,
  canInspect,
  canReadContent,
  showDiagnostics,
  reviewsLoaded,
  mutationHeaders,
  selectedDeliveryId,
  selectDelivery,
  mode,
  selectedReviewId,
  selectMode,
  selectReview,
  openCase,
}: {
  rows: RecordRow[];
  retry: (id: string, confirmOutcomeUnknown?: boolean, revision?: string) => void;
  retryPending: (id: string) => boolean;
  canRetry: boolean;
  canReadReview:boolean;
  canReview:boolean;
  canInspect:boolean;
  canReadContent:boolean;
  showDiagnostics:boolean;
  reviewsLoaded:(rows:RecordRow[])=>void;
  mutationHeaders:Record<string,string>;
  selectedDeliveryId: string | null;
  selectDelivery: (id: string | null) => void;
  mode:"deliveries"|"review";
  selectedReviewId:string|null;
  selectMode:(mode:"deliveries"|"review")=>void;
  selectReview:(id:string|null)=>void;
  openCase?: (ticket: string) => void;
}) {
  const { locale, t } = useI18n();
  const [filter, setFilter] = useState("all");
  const [reviews,setReviews]=useState<RecordRow[]|null>(null);
  const [reviewLoading,setReviewLoading]=useState(false);
  const [reviewError,setReviewError]=useState<string|null>(null);
  const reviewLoadFence=useRef(createLatestRequestFence());
  const loadReviews=useCallback(async(signal?:AbortSignal)=>{const request=reviewLoadFence.current.begin();const isCurrent=()=>!signal?.aborted&&reviewLoadFence.current.isCurrent(request);if(isCurrent()){setReviewLoading(true);setReviewError(null)}try{const response=await fetch("/api/reviews",{cache:"no-store",signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const rows=await response.json() as RecordRow[];if(!isCurrent())return;setReviews(rows);reviewsLoaded(rows)}catch(error){if(isCurrent()&&!isAbortError(error))setReviewError(operatorFailureMessage(error, t("tenant.deliveries.errors.reviewQueue")))}finally{if(isCurrent())setReviewLoading(false)}},[reviewsLoaded,t]);
  useEffect(()=>{if(mode!=="review"||!canReadReview||reviews!==null)return;const fence=reviewLoadFence.current;const controller=new AbortController();const timer=window.setTimeout(()=>void loadReviews(controller.signal),0);return()=>{controller.abort();window.clearTimeout(timer);fence.invalidate()}},[mode,canReadReview,reviews,loadReviews]);
  useVisibleRefresh((signal) => loadReviews(signal), mode === "review" && canReadReview && selectedReviewId === null);
  const filtered =
    filter === "all"
      ? rows
      : filter === "failed"
        ? rows.filter((row) => String(row.state).includes("FAILED") || String(row.state) === "OUTCOME_UNKNOWN")
        : rows.filter((r) => (filter === "delivered" ? ["DELIVERED", "READ"] : ["QUEUED", "HELD", "SENDING", "PENDING"]).includes(String(r.state)));
  return (<>
    <section className="panel table-panel">
      <div className="delivery-workspace-switch" role="group" aria-label={t("tenant.deliveries.workspaceLabel")}>
        <button type="button" aria-pressed={mode==="deliveries"} className={mode==="deliveries"?"active":""} onClick={()=>selectMode("deliveries")}><span aria-hidden="true">⇢</span>{t("tenant.deliveries.messageDelivery")}</button>
        {canReadReview?<button type="button" aria-pressed={mode==="review"} className={mode==="review"?"active":""} onClick={()=>selectMode("review")}><span aria-hidden="true">◇</span>{t("tenant.deliveries.operatorReview")}{reviews?<em>{formatNumber(reviews.filter(item=>item.state==="OPEN").length, locale)}</em>:null}</button>:null}
      </div>
      {mode==="deliveries"?<div>
      <div className="tabs" role="group" aria-label={t("tenant.deliveries.filterLabel")}>
        <button
          type="button"
          aria-pressed={filter === "all"}
          className={filter === "all" ? "active" : ""}
          onClick={() => setFilter("all")}
        >
          {t("tenant.deliveries.filters.all")} <span>{formatNumber(rows.length, locale)}</span>
        </button>
        <button
          type="button"
          aria-pressed={filter === "failed"}
          className={filter === "failed" ? "active" : ""}
          onClick={() => setFilter("failed")}
        >
          {t("tenant.deliveries.filters.needsAttention")}{" "}
          <span>
            {formatNumber(rows.filter((r) => String(r.state).includes("FAILED") || String(r.state) === "OUTCOME_UNKNOWN").length, locale)}
          </span>
        </button>
        <button
          type="button"
          aria-pressed={filter === "delivered"}
          className={filter === "delivered" ? "active" : ""}
          onClick={() => setFilter("delivered")}
        >
          {t("tenant.deliveries.filters.delivered")}
        </button>
        <button
          type="button"
          aria-pressed={filter === "queued"}
          className={filter === "queued" ? "active" : ""}
          onClick={() => setFilter("queued")}
        >
          {t("tenant.deliveries.filters.queued")}
        </button>
      </div>
      {filtered.length ? <DeliveryTable
        rows={filtered}
        inspect={canInspect ? selectDelivery : undefined}
        openCase={openCase}
        canReadContent={canReadContent}
        mutationHeaders={mutationHeaders}
        reviewUnknown={canReadReview ? (id)=>selectReview(id) : undefined}
        retryPending={retryPending}
        retry={canRetry
          ? (id, _unknown, revision) => retry(id, false, revision)
          : undefined}
      /> : <Empty
        title={t(rows.length ? "tenant.deliveries.empty.filteredTitle" : "tenant.deliveries.empty.title")}
        body={t(rows.length ? "tenant.deliveries.empty.filteredBody" : "tenant.deliveries.empty.body")}
      />}
      {!canInspect ? <div className="demo-table-note" role="note"><span aria-hidden="true">i</span><p><b>{t("tenant.deliveries.preview.title")}</b><small>{t("tenant.deliveries.preview.body")}</small></p></div> : null}
      </div>:<div><ReviewQueue rows={reviews} loading={reviewLoading} error={reviewError} reload={loadReviews} open={selectReview}/></div>}
    </section>
    {selectedDeliveryId?<DeliveryDetailDrawer key={selectedDeliveryId} id={selectedDeliveryId} close={()=>selectDelivery(null)} canRetry={canRetry} mutationHeaders={mutationHeaders}/>:null}
    {selectedReviewId?<ReviewDetailDrawer key={selectedReviewId} id={selectedReviewId} close={()=>selectReview(null)} canReview={canReview} showDiagnostics={showDiagnostics} mutationHeaders={mutationHeaders} changed={loadReviews}/>:null}
  </>);
}

function ReviewQueue({rows,loading,error,reload,open}:{rows:RecordRow[]|null;loading:boolean;error:string|null;reload:()=>Promise<void>;open:(id:string)=>void}){
  const { t } = useI18n();
  if(loading&&rows===null)return <div className="review-loading" role="status" aria-live="polite"><span/><span/><span/><b>{t("tenant.deliveries.review.loading")}</b></div>;
  if(error&&rows===null)return <div className="connection-detail-error review-load-error" role="alert"><span>!</span><div><b>{t("tenant.deliveries.review.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void reload()}>{t("tenant.deliveries.actions.retry")}</button></div></div>;
  const items=rows??[];
  return <>
    <div className="review-queue-head"><div><b>{t("tenant.deliveries.review.title")}</b><small>{t("tenant.deliveries.review.body")}</small></div></div>
    {error?<div className="review-inline-error" role="alert"><span>{t("tenant.data.refreshFailed")}</span><button className="text-button" onClick={()=>void reload()}>{t("tenant.deliveries.actions.retry")}</button></div>:null}
    {items.length?<WideTable><table className="review-table"><thead><tr><th>{t("tenant.deliveries.review.reason")}</th><th>{t("tenant.deliveries.review.context")}</th><th>{t("tenant.deliveries.review.source")}</th><th>{t("tenant.deliveries.table.status")}</th><th>{t("tenant.deliveries.review.created")}</th><th><span className="sr-only">{t("tenant.deliveries.review.action")}</span></th></tr></thead><tbody>{items.map(item=><tr key={String(item.id)}><td><b>{reviewReason(item,t)}</b><small>{reviewSummary(item,t)}</small></td><td><b><bdi>{String(item.group_name??item.connection_name??t("tenant.deliveries.review.workspace"))}</bdi></b><small>{item.provider?t(String(item.provider).toLowerCase()==="meta"?"tenant.connections.officialWhatsApp":"tenant.connections.linkedDevice"):t("tenant.deliveries.review.methodUnavailable")}</small></td><td><span className="tag">{reviewSource(item.source_kind,t)}</span></td><td><Status value={reviewState(item.state)}/></td><td><RelativeTime value={item.created_at}/></td><td><button className="button small secondary" onClick={()=>open(String(item.id))}>{t("tenant.deliveries.review.review")}</button></td></tr>)}</tbody></table></WideTable>:error?null:<Empty title={t("tenant.deliveries.review.emptyTitle")} body={t("tenant.deliveries.review.emptyBody")}/>}
  </>;
}

function DeliveryStopRetry({detail,mutationHeaders,changed,busy}:{detail:RecordRow;mutationHeaders:Record<string,string>;changed:()=>Promise<void>;busy:(value:boolean)=>void}){
  const {t}=useI18n();
  const [confirmation,setConfirmation]=useState<{key:string;revision:string}|null>(null);
  const [pending,setPending]=useState(false);const[error,setError]=useState<string|null>(null);
  const inFlight=useRef(false);
  const stop=async()=>{
    if(!confirmation||inFlight.current)return;
    inFlight.current=true;setPending(true);busy(true);setError(null);
    try{
      const response=await fetch(`/api/deliveries/${encodeURIComponent(String(detail.id))}/stop-retrying`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":confirmation.key},body:JSON.stringify({expectedRevision:confirmation.revision,confirmation:"STOP"})});
      if(!response.ok)throw operatorLocalFailure(await apiError(response));
      setConfirmation(null);await changed();
    }catch(problem){setError(operatorFailureMessage(problem, t("tenant.deliveries.errors.reviewAction")))}
    finally{inFlight.current=false;setPending(false);busy(false)}
  };
  if(detail.retry_stopped)return <p className="tag">{t("tenant.deliveries.stopRetry.stopped")}</p>;
  if(detail.state!=="FAILED_TERMINAL"||!detail.manual_retry_allowed||detail.outcome_review_id||typeof detail.revision!=="string")return null;
  return <section className="connection-detail-section">
    {error?<p role="alert">{error}</p>:null}
    {confirmation?<InlineConfirmation busy={pending} className="review-discard-confirm" aria-label={t("tenant.deliveries.stopRetry.title")} cancel={()=>setConfirmation(null)}>
      <p>{t("tenant.deliveries.stopRetry.warning")}</p><div>
        <button className="button secondary" data-inline-confirm-initial-focus disabled={pending} onClick={()=>setConfirmation(null)}>{t("tenant.deliveries.actions.cancel")}</button>
        <button className="button connection-detail-danger-button" disabled={pending} onClick={()=>void stop()}>{t(pending?"tenant.deliveries.stopRetry.pending":"tenant.deliveries.stopRetry.title")}</button>
      </div>
    </InlineConfirmation>:<button className="button secondary" onClick={()=>{setError(null);setConfirmation({key:crypto.randomUUID(),revision:String(detail.revision)})}}>{t("tenant.deliveries.stopRetry.title")}</button>}
  </section>;
}

function DeliveryDetailDrawer({id,close,canRetry=false,mutationHeaders={}}:{id:string;close:()=>void;canRetry?:boolean;mutationHeaders?:Record<string,string>}){
  const {locale,t}=useI18n();
  const [detail,setDetail]=useState<(RecordRow&{receipts?:RecordRow[];delivery_attempts?:RecordRow[]})|null>(null);
  const [loading,setLoading]=useState(true);const[error,setError]=useState<string|null>(null);
  const [mutationPending,setMutationPending]=useState(false);
  const loadFence=useRef(createLatestRequestFence());
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{const request=loadFence.current.begin();const isCurrent=()=>!signal?.aborted&&loadFence.current.isCurrent(request);if(!background)setLoading(true);try{const response=await fetch(`/api/deliveries/${encodeURIComponent(id)}`,{cache:"no-store",signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const value=await response.json() as RecordRow&{receipts?:RecordRow[];delivery_attempts?:RecordRow[]};if(!isCurrent())return;setDetail(value);setError(null)}catch(problem){if(isCurrent()&&!isAbortError(problem)&&!background)setError(operatorFailureMessage(problem, t("tenant.deliveries.errors.details")))}finally{if(!background&&isCurrent())setLoading(false)}},[id,t]);
  useEffect(()=>{const fence=loadFence.current;const controller=new AbortController();const timer=window.setTimeout(()=>void load(false,controller.signal),0);return()=>{controller.abort();window.clearTimeout(timer);fence.invalidate()}},[load]);
  useVisibleRefresh(signal=>load(true,signal));
return <ModalDialog close={mutationPending?()=>{}:close} className="modal-backdrop group-drawer-backdrop" aria-labelledby="delivery-detail-title" onMouseDown={event=>{if(!mutationPending&&event.target===event.currentTarget)close()}}><div className="modal group-drawer operational-drawer"><div className="modal-head group-drawer-head"><div><span className="eyebrow">{t("tenant.deliveries.detail.eyebrow")}</span><h2 id="delivery-detail-title">{t("tenant.deliveries.detail.title")}</h2><p>{t("tenant.deliveries.detail.body")}</p></div><button disabled={mutationPending} aria-label={t("tenant.deliveries.detail.close")} onClick={close}>×</button></div>
    {loading?<div className="review-loading" role="status"><span/><span/><b>{t("tenant.deliveries.detail.loading")}</b></div>:error?<div className="connection-detail-error" role="alert"><span>!</span><div><b>{t("tenant.deliveries.detail.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("tenant.deliveries.actions.retry")}</button></div></div>:detail?<ScrollRegion className="operational-drawer-body" aria-labelledby="delivery-detail-title">
<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.detail.currentState")}</h3><p>{t("tenant.deliveries.detail.currentStateBody")}</p></div><Status value={detail.state}/></div><dl className="connection-detail-facts"><div><dt>{t("tenant.deliveries.detail.channel")}</dt><dd>WhatsApp</dd></div><div><dt>{t("tenant.deliveries.table.group")}</dt><dd><bdi>{String(detail.group_name)}</bdi></dd></div><div><dt>{t("tenant.deliveries.detail.attempts")}</dt><dd>{formatNumber(Number(detail.attempts),locale)}</dd></div>{detail.hold_reason?<><div><dt>{t("tenant.deliveries.hold.reasonLabel")}</dt><dd>{deliveryHoldReason(detail,t)}</dd></div>{detail.available_at&&detail.hold_reason!=="WAITING_FOR_EARLIER_DELIVERY"?<div><dt>{t("tenant.deliveries.hold.nextAttempt")}</dt><dd><RelativeTime value={detail.available_at}/></dd></div>:null}{detail.hold_expires_at&&detail.hold_reason!=="WAITING_FOR_EARLIER_DELIVERY"?<div><dt>{t("tenant.deliveries.hold.expires")}</dt><dd><RelativeTime value={detail.hold_expires_at}/></dd></div>:null}</>:null}</dl>{detail.safe_error?<p className={`connection-detail-operation-error ${deliveryRetriesAutomatically(detail.state)?"delivery-pending-text":""}`}>{t(deliveryFailureGuidance(detail)??(deliveryRetriesAutomatically(detail.state)?"tenant.deliveries.automaticRetry":"tenant.errors.deliveryReview"))}</p>:null}</section>
      {detail.ordering_predecessor_id?<a className="button secondary" href={`/app?view=deliveries&delivery=${encodeURIComponent(String(detail.ordering_predecessor_id))}`}>{t("tenant.deliveries.hold.inspectEarlier")}</a>:null}
      {canRetry?<DeliveryStopRetry detail={detail} mutationHeaders={mutationHeaders} changed={async()=>{setDetail(current=>current?{...current,manual_retry_allowed:false,retry_stopped:true}:current);await load(true)}} busy={setMutationPending}/>:detail.retry_stopped?<p className="tag">{t("tenant.deliveries.stopRetry.stopped")}</p>:null}
<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.detail.receiptTimeline")}</h3><p>{t("tenant.deliveries.detail.receiptTimelineBody")}</p></div><span className="tag">{formatNumber(detail.receipts?.length??0,locale)} {t((detail.receipts?.length??0)===1?"tenant.deliveries.detail.receipts.one":"tenant.deliveries.detail.receipts")}</span></div>{detail.receipts?.length?<div className="receipt-timeline">{detail.receipts.map(receipt=>{const observed=receipt.receipt_scope==="PARTICIPANT_OBSERVED";return <div className="receipt-event" key={String(receipt.id)}><span className={`receipt-node ${receipt.applied_state==="IGNORED"||observed?"muted":""}`}/><div><div><Status value={receipt.receipt_status}/>{observed?<span className="tag">{t("tenant.deliveries.detail.participantObserved")}</span>:null}</div><p>{t(observed?"tenant.deliveries.detail.observedBody":receipt.applied_state==="IGNORED"?"tenant.deliveries.detail.ignoredBody":"tenant.deliveries.detail.appliedAs",{state:t(`tenant.deliveries.detail.applied.${String(receipt.applied_state).toLowerCase()}`)})}</p><small><RelativeTime value={receipt.provider_timestamp} pastOnly/></small></div></div>})}</div>:<Empty title={t("tenant.deliveries.detail.noReceipts")} body={t("tenant.deliveries.detail.noReceiptsBody")}/>}</section>
      <section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.detail.sendAttempts")}</h3><p>{t("tenant.deliveries.detail.sendAttemptsBody")}</p></div></div><div className="attempt-list">{detail.delivery_attempts?.map(attempt=><div key={String(attempt.id)}><span><b>{t("tenant.deliveries.detail.attempt")} {formatNumber(Number(attempt.attempt_number),locale)}</b><small><RelativeTime value={attempt.started_at} pastOnly/></small></span><Status value={attempt.state}/></div>)}</div></section>
    </ScrollRegion>:null}
  </div></ModalDialog>;
}

function ReviewDetailDrawer({id,close,canReview,showDiagnostics,mutationHeaders,changed}:{id:string;close:()=>void;canReview:boolean;showDiagnostics:boolean;mutationHeaders:Record<string,string>;changed:()=>Promise<void>}){
  const { locale, t } = useI18n();
  const [detail,setDetail]=useState<RecordRow|null>(null);const[loading,setLoading]=useState(true);const[error,setError]=useState<string|null>(null);const[actionError,setActionError]=useState<string|null>(null);const[pending,setPending]=useState(false);const[resolutionCode,setResolutionCode]=useState("REVIEWED_NO_ACTION");const[ruleId,setRuleId]=useState("");const[reference,setReference]=useState("");const[confirmDiscard,setConfirmDiscard]=useState(false);const[confirmActionRetry,setConfirmActionRetry]=useState(false);const[actionRetryConfirmation,setActionRetryConfirmation]=useState("");const actionRetryInput=useRef<HTMLInputElement>(null);const actionRetryTrigger=useRef<HTMLButtonElement>(null);
  const [confirmCompleted,setConfirmCompleted]=useState(false);
  const actionInFlight=useRef(false);
  const actionAttempt=useRef<{fingerprint:string;key:string}|null>(null);
  const loadFence=useRef(createLatestRequestFence());
  const load=useCallback(async(signal?:AbortSignal)=>{const request=loadFence.current.begin();const isCurrent=()=>!signal?.aborted&&loadFence.current.isCurrent(request);setLoading(true);setError(null);try{const response=await fetch(`/api/reviews/${encodeURIComponent(id)}`,{cache:"no-store",signal});if([400,403,404].includes(response.status))throw operatorLocalFailure(t("tenant.deliveries.review.itemUnavailable"));if(!response.ok)throw operatorLocalFailure(await apiError(response));const value=await response.json() as RecordRow;if(!isCurrent())return;setDetail(value);const options=Array.isArray(value.rule_options)?value.rule_options as RecordRow[]:[];setRuleId(String(options[0]?.id??""))}catch(problem){if(isCurrent()&&!isAbortError(problem))setError(operatorFailureMessage(problem, t("tenant.deliveries.errors.reviewDetails")))}finally{if(isCurrent())setLoading(false)}},[id,t]);
  useEffect(()=>{const fence=loadFence.current;const controller=new AbortController();const timer=window.setTimeout(()=>void load(controller.signal),0);return()=>{controller.abort();window.clearTimeout(timer);fence.invalidate()}},[load]);
  const act=async(action:"resolve"|"discard"|"reprocess",options:{resolutionCode?:string;confirmation?:string}={})=>{if(!detail||actionInFlight.current)return;actionInFlight.current=true;setPending(true);setActionError(null);try{const body:Record<string,unknown>={expectedVersion:Number(detail.version)};if(action==="resolve"){body.resolutionCode=options.resolutionCode??resolutionCode;if(options.confirmation)body.confirmation=options.confirmation}if(action==="reprocess"){body.ruleId=ruleId;body.normalizedReference=reference.trim()}const fingerprint=JSON.stringify([id,action,body]);if(actionAttempt.current?.fingerprint!==fingerprint)actionAttempt.current={fingerprint,key:crypto.randomUUID()};const response=await fetch(`/api/reviews/${encodeURIComponent(id)}/${action}`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":actionAttempt.current.key},body:JSON.stringify(body)});if(!response.ok)throw operatorLocalFailure(await apiError(response));await changed();close()}catch(problem){setActionError(operatorFailureMessage(problem, t("common.errors.network")))}finally{actionInFlight.current=false;setPending(false)}};
  const metadata=visibleReviewMetadata(detail?.safe_metadata,showDiagnostics,detail?.state);const ruleOptions=Array.isArray(detail?.rule_options)?detail.rule_options as RecordRow[]:[];
  const groupActionUnknown=detail?.reason_code==="GROUP_ACTION_OUTCOME_UNKNOWN"&&Boolean(detail.group_action_execution_id);
  const [confirmNoFurther,setConfirmNoFurther]=useState(false);
  const deliveryOutcomeUnknown=detail?.reason_code==="PROVIDER_OUTCOME_UNKNOWN"&&Boolean(detail.delivery_id);
  return <ModalDialog close={pending ? () => {} : close} className="modal-backdrop group-drawer-backdrop" aria-labelledby="review-detail-title" onMouseDown={event=>{if(!pending&&event.target===event.currentTarget)close()}}><div className="modal group-drawer operational-drawer"><div className="modal-head group-drawer-head"><div><span className="eyebrow">{t("tenant.deliveries.review.detailEyebrow")}</span><h2 id="review-detail-title">{detail?reviewReason(detail,t):t("tenant.deliveries.review.item")}</h2><p>{t("tenant.deliveries.review.detailBody")}</p></div><button disabled={pending} aria-label={t("tenant.deliveries.review.closeItem")} onClick={close}>×</button></div>
    {loading?<div className="review-loading" role="status"><span/><span/><b>{t("tenant.deliveries.review.loadingEvidence")}</b></div>:error?<div className="connection-detail-error" role="alert"><span>!</span><div><b>{t("tenant.deliveries.review.itemUnavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("tenant.deliveries.actions.retry")}</button></div></div>:detail?<ScrollRegion className="operational-drawer-body" aria-labelledby="review-detail-title">
      {!canReview?<div className="group-config-readonly"><span>i</span><p><b>{t("tenant.deliveries.review.readOnly")}</b>{t("tenant.deliveries.review.readOnlyBody")}</p></div>:null}
      {actionError?<div className="connection-detail-alert connection-detail-alert-danger" role="alert"><span>!</span><div><b>{t("tenant.deliveries.review.actionUnconfirmed")}</b><p>{actionError}</p>{requiresPrivilegedReauthentication(actionError)?<a className="button small secondary" href={privilegedStepUpHref(`/app?view=deliveries&workspace=review&review=${encodeURIComponent(id)}`)}>{t("tenant.deliveries.actions.reauthenticate")}</a>:null}</div></div>:null}
      <section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.review.safeEvidence")}</h3><p>{reviewSummary(detail,t)}</p></div><Status value={reviewState(detail.state)}/></div><dl className="review-evidence"><div><dt>{t("tenant.deliveries.review.source")}</dt><dd>{reviewSource(detail.source_kind,t)}</dd></div><div><dt>{t("tenant.deliveries.review.context")}</dt><dd><bdi>{String(detail.group_name??detail.connection_name??t("tenant.deliveries.review.workspace"))}</bdi></dd></div><div><dt>{t("tenant.deliveries.review.created")}</dt><dd><RelativeTime value={detail.created_at} pastOnly/></dd></div>{metadata.map(([key,value])=><div key={key}><dt>{showDiagnostics?<bdi>{key}</bdi>:t(`tenant.deliveries.review.metadata.${key}`)}</dt><dd><bdi>{reviewMetadataValue(value,locale,t,showDiagnostics)}</bdi></dd></div>)}</dl>{typeof detail.delivery_id==="string"?<a className="button secondary" href={`/app?view=deliveries&delivery=${encodeURIComponent(detail.delivery_id)}`}>{t("tenant.deliveries.review.originalDelivery")}</a>:null}</section>
      {detail.source_kind==="INBOUND"&&detail.state==="OPEN"&&!groupActionUnknown?<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.review.reprocessTitle")}</h3><p>{t("tenant.deliveries.review.reprocessBody")}</p></div></div><div className="review-reprocess-form"><label>{t("tenant.deliveries.review.activeRule")}<select value={ruleId} disabled={!canReview||pending} onChange={event=>setRuleId(event.target.value)}><option value="">{t("tenant.deliveries.review.selectRule")}</option>{ruleOptions.map(rule=><option key={String(rule.id)} value={String(rule.id)}>{String(rule.name)}</option>)}</select></label><label>{t("tenant.deliveries.review.correctedReference")}<input className="mono" value={reference} maxLength={256} disabled={!canReview||pending} onChange={event=>setReference(event.target.value)} placeholder={t("tenant.deliveries.review.referencePlaceholder")}/></label><button className="button primary" disabled={!canReview||pending||!ruleId||!reference.trim()} onClick={()=>void act("reprocess")}>{t(pending?"tenant.deliveries.review.queuing":"tenant.deliveries.review.validateReprocess")}</button></div></section>:null}
      {detail.state==="OPEN"&&groupActionUnknown?<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.review.groupAction.title")}</h3><p>{t("tenant.deliveries.review.groupAction.body")}</p></div></div><div className="review-resolution review-action-recovery"><button className="button primary" disabled={!canReview||pending} onClick={()=>{setConfirmActionRetry(false);setConfirmCompleted(true)}}>{t(pending?"tenant.deliveries.review.groupAction.recording":"tenant.deliveries.review.groupAction.alreadyCompleted")}</button><button ref={actionRetryTrigger} className="button secondary" disabled={!canReview||pending} onClick={()=>{setConfirmCompleted(false);setActionRetryConfirmation("");setConfirmActionRetry(true);window.requestAnimationFrame(()=>actionRetryInput.current?.focus())}}>{t("tenant.deliveries.review.groupAction.retryEllipsis")}</button></div>{confirmActionRetry?<form className="review-discard-confirm review-action-retry-confirm" aria-label={t("tenant.deliveries.review.groupAction.retryLabel")} onSubmit={event=>{event.preventDefault();if(actionRetryConfirmation==="RETRY")void act("resolve",{resolutionCode:"ACTION_RETRY_REQUESTED",confirmation:actionRetryConfirmation})}}><label className="privacy-confirm-input" htmlFor="group-action-retry-confirmation"><span id="group-action-retry-help">{t("tenant.deliveries.review.groupAction.retryWarning")} {t("tenant.deliveries.review.groupAction.type")} <code dir="ltr">RETRY</code>.</span><input ref={actionRetryInput} id="group-action-retry-confirmation" dir="ltr" required pattern="RETRY" maxLength={5} autoComplete="off" spellCheck={false} aria-describedby="group-action-retry-help" value={actionRetryConfirmation} onChange={event=>setActionRetryConfirmation(event.target.value)}/></label><div><button type="button" className="button secondary" onClick={()=>{setConfirmActionRetry(false);window.requestAnimationFrame(()=>actionRetryTrigger.current?.focus())}}>{t("tenant.deliveries.actions.cancel")}</button><button className="button connection-detail-danger-button" disabled={pending||actionRetryConfirmation!=="RETRY"}>{t("tenant.deliveries.review.groupAction.confirmRetry")}</button></div></form>:null}</section>:null}
      {detail.state==="OPEN"&&deliveryOutcomeUnknown?<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.review.deliveryOutcome.title")}</h3><p>{t("tenant.deliveries.review.deliveryOutcome.body")}</p></div></div><div className="review-resolution review-action-recovery"><button className="button primary" disabled={!canReview||pending} onClick={()=>{setConfirmNoFurther(false);setConfirmActionRetry(false);setConfirmCompleted(true)}}>{t(pending?"tenant.deliveries.review.deliveryOutcome.recording":"tenant.deliveries.review.deliveryOutcome.sent")}</button><button ref={actionRetryTrigger} className="button secondary" disabled={!canReview||pending} onClick={()=>{setConfirmNoFurther(false);setConfirmCompleted(false);setActionRetryConfirmation("");setConfirmActionRetry(true);window.requestAnimationFrame(()=>actionRetryInput.current?.focus())}}>{t("tenant.deliveries.review.deliveryOutcome.retryEllipsis")}</button></div>{confirmActionRetry?<form className="review-discard-confirm review-action-retry-confirm" aria-label={t("tenant.deliveries.review.deliveryOutcome.retryLabel")} onSubmit={event=>{event.preventDefault();if(actionRetryConfirmation==="RETRY")void act("resolve",{resolutionCode:"DELIVERY_RETRY_REQUESTED",confirmation:actionRetryConfirmation})}}><label className="privacy-confirm-input" htmlFor="delivery-outcome-retry-confirmation"><span id="delivery-outcome-retry-help">{t("tenant.deliveries.review.deliveryOutcome.retryWarning")} {t("tenant.deliveries.review.groupAction.type")} <code dir="ltr">RETRY</code>.</span><input ref={actionRetryInput} id="delivery-outcome-retry-confirmation" dir="ltr" required pattern="RETRY" maxLength={5} autoComplete="off" spellCheck={false} aria-describedby="delivery-outcome-retry-help" value={actionRetryConfirmation} onChange={event=>setActionRetryConfirmation(event.target.value)}/></label><div><button type="button" className="button secondary" onClick={()=>{setConfirmActionRetry(false);window.requestAnimationFrame(()=>actionRetryTrigger.current?.focus())}}>{t("tenant.deliveries.actions.cancel")}</button><button className="button connection-detail-danger-button" disabled={pending||actionRetryConfirmation!=="RETRY"}>{t("tenant.deliveries.review.deliveryOutcome.confirmRetry")}</button></div></form>:null}</section>:null}
      {detail.state==="OPEN"&&deliveryOutcomeUnknown?<section className="connection-detail-section">
        {confirmNoFurther?<InlineConfirmation busy={pending} aria-labelledby="no-further-title" cancel={()=>setConfirmNoFurther(false)}>
          <h3 id="no-further-title">{t("tenant.deliveries.review.noFurther.title")}</h3><p>{t("tenant.deliveries.review.noFurther.body")}</p>
          <button className="button secondary" data-inline-confirm-initial-focus disabled={pending} onClick={()=>setConfirmNoFurther(false)}>{t("tenant.deliveries.actions.cancel")}</button>
          <button className="button connection-detail-danger-button" disabled={!canReview||pending} onClick={()=>void act("resolve",{resolutionCode:"DELIVERY_NO_FURTHER_ATTEMPTS",confirmation:"STOP"})}>{t("tenant.deliveries.review.noFurther.confirm")}</button>
        </InlineConfirmation>:<button className="button secondary" disabled={!canReview||pending} onClick={()=>{setConfirmCompleted(false);setConfirmActionRetry(false);setConfirmNoFurther(true)}}>{t("tenant.deliveries.review.noFurther.title")}</button>}
      </section>:null}
      {confirmCompleted&&detail.state==="OPEN"&&(groupActionUnknown||deliveryOutcomeUnknown)?<InlineConfirmation busy={pending} className="review-discard-confirm" aria-labelledby="review-completion-title" cancel={()=>setConfirmCompleted(false)}>
        <div><h3 id="review-completion-title">{t(deliveryOutcomeUnknown?"tenant.deliveries.review.deliveryOutcome.confirmTitle":"tenant.deliveries.review.groupAction.confirmTitle")}</h3><p>{t(deliveryOutcomeUnknown?"tenant.deliveries.review.deliveryOutcome.confirmBody":"tenant.deliveries.review.groupAction.confirmBody")}</p></div>
        <div><button className="button secondary" data-inline-confirm-initial-focus disabled={pending} onClick={()=>setConfirmCompleted(false)}>{t("tenant.deliveries.actions.cancel")}</button><button className="button primary" disabled={pending} onClick={()=>void act("resolve",deliveryOutcomeUnknown?{resolutionCode:"DELIVERY_CONFIRMED_SENT",confirmation:"SENT"}:{resolutionCode:"ACTION_ALREADY_COMPLETED"})}>{t(pending?"tenant.deliveries.review.groupAction.recording":deliveryOutcomeUnknown?"tenant.deliveries.review.deliveryOutcome.sent":"tenant.deliveries.review.groupAction.alreadyCompleted")}</button></div>
      </InlineConfirmation>:null}
      {detail.state==="OPEN"&&!groupActionUnknown&&!deliveryOutcomeUnknown?<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.review.closeTitle")}</h3><p>{t("tenant.deliveries.review.closeBody")}</p></div></div><div className="review-resolution"><label>{t("tenant.deliveries.review.resolution")}<select value={resolutionCode} disabled={!canReview||pending} onChange={event=>setResolutionCode(event.target.value)}><option value="REVIEWED_NO_ACTION">{t("tenant.deliveries.review.resolutionNoAction")}</option><option value="CONFIGURATION_CORRECTED">{t("tenant.deliveries.review.resolutionCorrected")}</option><option value="HANDLED_EXTERNALLY">{t("tenant.deliveries.review.resolutionExternal")}</option></select></label><button className="button" disabled={!canReview||pending} onClick={()=>void act("resolve")}>{t("tenant.deliveries.review.resolve")}</button><button className="button connection-detail-danger-button" disabled={!canReview||pending} onClick={()=>setConfirmDiscard(true)}>{t("tenant.deliveries.review.discardEllipsis")}</button></div>{confirmDiscard?<InlineConfirmation busy={pending} className="review-discard-confirm" aria-label={t("tenant.deliveries.review.confirmDiscardLabel")} cancel={() => setConfirmDiscard(false)}><p>{t("tenant.deliveries.review.confirmDiscardBody")}</p><div><button className="button secondary" data-inline-confirm-initial-focus disabled={pending} onClick={()=>setConfirmDiscard(false)}>{t("tenant.deliveries.actions.cancel")}</button><button className="button connection-detail-danger-button" disabled={pending} onClick={()=>void act("discard")}>{t("tenant.deliveries.review.confirmDiscard")}</button></div></InlineConfirmation>:null}</section>:null}
    </ScrollRegion>:null}
  </div></ModalDialog>;
}
