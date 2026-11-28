"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui.ts";
import { useI18n, useRelativeClock } from "./I18nProvider";
import { formatDateTime, formatDuration, formatPastRelativeTime, formatRelativeTime } from "../lib/i18n/format.ts";
import { localizedUiError } from "../lib/ui-error.ts";

export type RecordRow = Record<string, unknown>;
export type ConnectionDetailRow = RecordRow & {
  id: string;
  name: string;
  provider: string;
  state: string;
  phone?: string;
  phone_e164?: string;
  group_count?: number;
  last_heartbeat_at?: string | null;
  last_provider_event_at?: string | null;
  last_processed_provider_message_at?: string | null;
  meta_routing_configuration_ready?: boolean | null;
  meta_routing_reason?: string | null;
  action_reason?: string | null;
  disclosure_version?: string | null;
  provider_session_state?: string | null;
  provider_state?: string | null;
  onboarding_qr_ready_at?: string | null;
  onboarding_authorization_method?: "QR" | "PAIRING_CODE" | "PASSKEY" | null;
  onboarding_scan_acknowledged_at?: string | null;
  onboarding_scan_completed_at?: string | null;
  onboarding_working_at?: string | null;
  onboarding_timing_eligible?: boolean | null;
  onboarding_late_acknowledgement?: boolean | null;
  onboarding_human_seconds?: number | string | null;
  onboarding_provider_seconds?: number | string | null;
  worker_id?: string | null;
  worker_ready?: boolean | null;
  webhook_state?: string | null;
  webhook_admission_opened_at?: string | null;
  latest_operation_id?: string | null;
  latest_operation_type?: string | null;
  latest_operation_state?: string | null;
  latest_operation_attempts?: number | null;
  latest_operation_safe_error?: string | null;
  latest_operation_created_at?: string | null;
};

export const isDuplicateIdentityRejection = (reason: unknown) =>
  String(reason ?? "").startsWith("This WhatsApp account is already connected");

export function RelativeTime({ value, pastOnly = false }: { value: unknown; pastOnly?: boolean }) {
  const { locale, t } = useI18n();
  const renderedAt = useRelativeClock();
  if (!value) return <>{t("tenant.time.never")}</>;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return <>{t("tenant.time.invalid")}</>;
  return (
    <time dateTime={date.toISOString()} title={formatDateTime(date, locale)}>
      {pastOnly ? formatPastRelativeTime(date, locale, renderedAt) : formatRelativeTime(date, locale, renderedAt)}
    </time>
  );
}

export function duration(value: unknown, locale: "en" | "ar") {
  return formatDuration(Math.max(0, Number(value ?? 0)), locale);
}

export function exactTime(value: unknown, locale: "en" | "ar", fallback: string) {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : formatDateTime(date, locale);
}

export type TenantTranslator = ReturnType<typeof useI18n>["t"];

export function connectionMethod(value: unknown, t: TenantTranslator) {
  return String(value ?? "").toLowerCase() === "meta"
    ? t("tenant.connection.method.official")
    : t("tenant.connection.method.linkedDevice");
}

export async function apiError(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { code?: unknown };
  const locale = typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("ar") ? "ar" : "en";
  return localizedUiError(locale, { status: response.status, code: body.code }).message;
}

export function isOpaqueIdentifier(value: unknown) {
  const text = String(value ?? "").trim();
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(text) ||
    /@(?:g\.us|c\.us)$/iu.test(text) ||
    /^(?:aud|conn|del|grp|req|review|tenant|user)[_-]/iu.test(text)
  );
}

export function requiresPrivilegedReauthentication(message: string | null) {
  return Boolean(message && /reauthenticate|authentication|sign in again|recent sign-in|أعد التحقق/i.test(message));
}

export function privilegedStepUpHref(returnTo: string) {
  return `/auth/login?step_up=privileged&return_to=${encodeURIComponent(returnTo)}`;
}

export function statusPresentation(value: unknown) {
  const normalized = String(value).toLowerCase();
  const parts = new Set(normalized.split(/[^a-z]+/u).filter(Boolean));
  const presentation = [
    [["disconnected", "stopped", "logged_out"], "common.status.disconnected", "danger"],
    [["inactive", "disabled", "consent_required"], "common.status.inactive", "neutral"],
    [["working"], "tenant.status.working", "success"],
    [["delivered"], "tenant.status.delivered", "success"],
    [["read"], "tenant.status.read", "success"],
    [["succeeded", "completed"], "tenant.status.completed", "success"],
    [["approved"], "tenant.status.approved", "success"],
    [["connected"], "common.status.connected", "success"],
    [["active"], "common.status.active", "success"],
    [["resolved"], "tenant.status.resolved", "success"],
    [["accepted"], "tenant.status.accepted", "success"],
    [["added"], "tenant.status.added", "success"],
    [["awaiting_auth", "scan_qr_code", "pairing_code_required", "passkey_required", "passkey_confirmation_required", "action"], "tenant.status.actionRequired", "warning"],
    [["retry"], "tenant.status.retrying", "warning"],
    [["connecting", "starting"], "tenant.status.connecting", "warning"],
    [["degraded"], "tenant.status.degraded", "warning"],
    [["outcome_unknown"], "tenant.status.outcomeUnknown", "warning"],
    [["unknown"], "tenant.status.unknown", "warning"],
    [["sent"], "tenant.status.sent", "warning"],
    [["blocked"], "tenant.status.blocked", "warning"],
    [["expired"], "tenant.status.expired", "warning"],
    [["draft"], "tenant.status.draft", "warning"],
    [["changed"], "tenant.status.changed", "warning"],
    [["pending", "queued", "staged", "provisioning", "running", "processing", "claimed", "sending"], "tenant.status.inProgress", "warning"],
    [["failed"], "common.status.failed", "danger"],
    [["revoked"], "tenant.status.revoked", "danger"],
    [["denied"], "tenant.status.denied", "danger"],
    [["discarded"], "tenant.status.discarded", "neutral"],
    [["cancelled", "canceled"], "tenant.status.cancelled", "danger"],
    [["removed"], "tenant.status.removed", "danger"],
    [["paused"], "tenant.status.paused", "neutral"],
    [["suspended"], "tenant.status.suspended", "warning"],
    [["released"], "tenant.status.released", "neutral"],
    [["retired"], "tenant.status.retired", "neutral"],
    [["open"], "tenant.status.open", "neutral"],
    [["unchanged"], "tenant.status.unchanged", "neutral"],
  ].find(([tokens]) => (tokens as string[]).some((token) => normalized === token || parts.has(token))) as [string[], string, string] | undefined;
  const [, label = "tenant.status.unknown", tone = "neutral"] = presentation ?? [];
  return [label, tone] as const;
}

export function Status({ value }: { value: unknown }) {
  const { t } = useI18n();
  const [label, tone] = statusPresentation(value);
  return (
    <span className={`status status-${tone}`}>
      <i />
      {t(label)}
    </span>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

export function WorkspaceLoading() {
  const { t } = useI18n();
  return (
    <div className="review-loading workspace-loading" role="status">
      <span aria-hidden="true" />
      <b>{t("tenant.loading.workspace")}</b>
    </div>
  );
}

// Lazy slots inside panels, drawers and dialogs: compact and labelled for the section, not the workspace.
// quiet: a slot that always loads beside another slot shows the same text without a second announcement.
export function SectionLoading({ quiet = false }: { quiet?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="review-loading compact" role={quiet ? undefined : "status"}>
      <span aria-hidden="true" />
      <b>{t("tenant.loading.section")}</b>
    </div>
  );
}

type ScrollRegionName = { "aria-label": string; "aria-labelledby"?: never } | { "aria-labelledby": string; "aria-label"?: never };

/** A named overflow area that keyboard users can focus and scroll (WCAG 2.1.1). */
export function ScrollRegion(props: Omit<React.ComponentPropsWithRef<"div">, "role" | "tabIndex" | "aria-label" | "aria-labelledby"> & ScrollRegionName) {
  return <div {...props} role="region" tabIndex={0} />;
}

export function WideTable({ children, label }: { children: React.ReactNode; label?: string }) {
  const { t } = useI18n();
  return (
    <ScrollRegion className="table-scroll" aria-label={label ?? t("tenant.accessibility.scrollTable")}>
      <span className="table-scroll-cue" aria-hidden="true">
        {t("tenant.accessibility.scrollTableCue")}
      </span>
      {children}
    </ScrollRegion>
  );
}

export function useDialogCloseGuard(close: () => void, busy = false, controlledDirty?: boolean, controlledDirtyToken?: unknown) {
  const [localDirty, setLocalDirty] = useState(false);
  const dirty = controlledDirty ?? localDirty;
  const dirtyToken = controlledDirty === undefined ? "local" : controlledDirtyToken;
  const [confirmToken, setConfirmToken] = useState<unknown>(null);
  useEffect(() => {
    if (!dirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [dirty]);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmToken(dirtyToken);
    else close();
  };
  return {
    dirty,
    confirmClose: dirty && confirmToken === dirtyToken,
    markDirty: () => setLocalDirty(true),
    resetDirty: () => { setLocalDirty(false); setConfirmToken(null); },
    requestClose,
    keepEditing: () => setConfirmToken(null),
    discard: () => { if (!busy) close(); },
  };
}

export function DirtyCloseConfirmation({ guard }: { guard: ReturnType<typeof useDialogCloseGuard> }) {
  const { t } = useI18n();
  if (!guard.confirmClose) return null;
  return (
    <InlineConfirmation className="inline-warning dialog-discard-confirm" aria-labelledby="dialog-discard-title" cancel={guard.keepEditing}>
      <strong id="dialog-discard-title">{t("tenant.dialog.discard.title")}</strong>
      <p>{t("tenant.dialog.discard.body")}</p>
      <div className="modal-actions">
        <button type="button" className="button secondary" data-inline-confirm-initial-focus onClick={guard.keepEditing}>{t("tenant.dialog.discard.keepEditing")}</button>
        <button type="button" className="button connection-detail-danger-button" onClick={guard.discard}>{t("tenant.dialog.discard.confirm")}</button>
      </div>
    </InlineConfirmation>
  );
}

export function Toolbar({
  query,
  setQuery,
  placeholder,
  children,
}: {
  query: string;
  setQuery: (q: string) => void;
  placeholder: string;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("en") === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);
  return (
    <div className="toolbar">
      <label className="search">
        <span>⌕</span>
        <input
          ref={searchRef}
          aria-label={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
        />
        {/* The handler above accepts Ctrl+K on every platform, so one hint is true everywhere. */}
        <kbd aria-hidden="true">{t("common.shortcut.search")}</kbd>
      </label>
      {children}
    </div>
  );
}

export const REVIEW_REASON_KEYS = new Set([
  "identifier_limit_exceeded",
  "media_malware_detected",
  "media_too_large",
  "media_type_unsafe",
  "media_download_rejected",
  "outbound_media_rejected",
  "provider_delivery_failed",
  "provider_outcome_unknown",
  "non_retryable_review",
  "group_action_outcome_unknown",
]);
const REVIEW_STATE_KEYS = new Set(["open", "resolved", "discarded", "reprocess_queued"]);

export function reviewOriginalReason(row: RecordRow, t: TenantTranslator) {
  const reason = String(row.reason_code ?? "").toLowerCase();
  return REVIEW_REASON_KEYS.has(reason)
    ? t(`tenant.deliveries.review.reason.${reason}`)
    : t("tenant.deliveries.review.reason.unknown");
}

export function reviewReason(row: RecordRow, t: TenantTranslator) {
  const state = reviewState(row.state);
  return state === "resolved" || state === "discarded"
    ? t(`tenant.deliveries.review.closed.${state}`)
    : reviewOriginalReason(row, t);
}

export function reviewState(value: unknown) {
  const state = String(value ?? "").toLowerCase();
  return REVIEW_STATE_KEYS.has(state) ? state : "unknown";
}

export function deliveryRetriesAutomatically(value: unknown) {
  return ["QUEUED", "FAILED_RETRYABLE"].includes(String(value ?? "").toUpperCase());
}

const DELIVERY_HOLD_REASONS = new Set(["waiting_for_earlier_delivery","waiting_for_inbound","rate_limited","policy_paused","connection_not_ready","destination_unavailable","waiting"]);
export function deliveryHoldReason(row: RecordRow, t: TenantTranslator) {
  const reason=String(row.hold_reason??row.delivery_hold_reason??"").toLowerCase();
  return t(DELIVERY_HOLD_REASONS.has(reason)?`tenant.deliveries.hold.reason.${reason}`:"tenant.deliveries.hold.reason.waiting");
}

export function safeNavigationTarget(value: string | null, kind: "connection" | "delivery" | "review" | "ticket" | "group" | "message") {
  const normalized = value?.trim().replace(/^#/u, "") ?? "";
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (!normalized || normalized.length > 128 || hasControlCharacter) return null;
  if (kind === "ticket") return /^[1-9][0-9]{0,15}$/u.test(normalized) ? normalized : null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) return null;
  return normalized.toLowerCase();
}

export function DeliveryTable({
  rows,
  compact = false,
  retry,
  retryPending,
  reviewUnknown,
  inspect,
  openCase,
  canReadContent = false,
  mutationHeaders,
}: {
  rows: RecordRow[];
  compact?: boolean;
  retry?: (id: string, outcomeUnknown: boolean, revision: string) => void;
  retryPending?: (id: string) => boolean;
  reviewUnknown?: (id:string|null) => void;
  inspect?: (id:string) => void;
  openCase?: (ticket: string) => void;
  canReadContent?: boolean;
  mutationHeaders?: Record<string,string>;
}) {
  const { t } = useI18n();
  const [revealId, setRevealId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string,{body:string;expiresAt:number}>>({});
  const revealTimers = useRef(new Map<string,number>());
  const visibleRowIds = useRef(new Set(rows.map(row=>String(row.id))));
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const hideRevealed = useCallback((id:string) => {
    const timer=revealTimers.current.get(id);
    if(timer!==undefined)window.clearTimeout(timer);
    revealTimers.current.delete(id);
    setRevealed((current) => { if(!(id in current))return current;const next={...current};delete next[id];return next });
  },[]);
  useEffect(()=>()=>{for(const timer of revealTimers.current.values())window.clearTimeout(timer);revealTimers.current.clear()},[]);
  useEffect(()=>{
    const currentIds=new Set(rows.map(row=>String(row.id)));
    visibleRowIds.current=currentIds;
    for(const id of revealTimers.current.keys())if(!currentIds.has(id))hideRevealed(id);
  },[hideRevealed,rows]);
  const reveal = async () => {
    if (!canReadContent || !revealId || revealing || !mutationHeaders) return;
    const id=revealId;
    setRevealing(true);
    setRevealError(null);
    try {
      const response = await fetch(`/api/deliveries/${encodeURIComponent(id)}/content`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ purpose: "OPERATIONAL_REVIEW", confirmation: "REVEAL" }),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = await response.json() as { body?: string;expires_in_seconds?:number };
      const seconds=Number(result.expires_in_seconds);
      if(!Number.isFinite(seconds)||seconds<=0)throw operatorLocalFailure(t("tenant.deliveries.errors.reveal"));
      if(!visibleRowIds.current.has(id)){setRevealId(null);return}
      const ttl=Math.min(Math.floor(seconds),60)*1_000;
      hideRevealed(id);
      setRevealed((current) => ({ ...current, [id]: {body:String(result.body??""),expiresAt:Date.now()+ttl} }));
      revealTimers.current.set(id,window.setTimeout(()=>hideRevealed(id),ttl));
      setRevealId(null);
    } catch (problem) {
      setRevealError(operatorFailureMessage(problem, t("tenant.deliveries.errors.reveal")));
    } finally {
      setRevealing(false);
    }
  };
  return (
    <>
    <WideTable>
      <table className="stacked-table delivery-table">
        <thead>
          <tr>
            <th>{t("tenant.deliveries.table.case")}</th>
            <th>{t("tenant.deliveries.table.group")}</th>
            <th>{t("tenant.deliveries.table.message")}</th>
            <th>{t("tenant.deliveries.table.status")}</th>
            <th>{t("tenant.deliveries.table.updated")}</th>
            {!compact && <th><span className="sr-only">{t("cases.table.actions")}</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ticketNumber = typeof row.ticket_number === "string" && row.ticket_number ? row.ticket_number : null;
            const outcomeReviewId=safeNavigationTarget(typeof row.outcome_review_id==="string"?row.outcome_review_id:null,"review");
            return <tr key={String(row.id)}>
              <td>
                {ticketNumber ? openCase ? <button className="ticket" onClick={() => openCase(ticketNumber)} aria-label={t("tenant.deliveries.table.openCase", { reference: ticketNumber })}><bdi>{ticketNumber}</bdi></button> : <span className="ticket"><bdi>{ticketNumber}</bdi></span> : <span className="muted">{t("tenant.deliveries.table.noCase")}</span>}
              </td>
              <td>
                <b><bdi>{String(row.group_name)}</bdi></b>
              </td>
              <td>
                {canReadContent && revealed[String(row.id)] !== undefined ? <span className="revealed-message"><span className="excerpt"><bdi>{revealed[String(row.id)]!.body}</bdi></span><button className="text-button" onClick={() => hideRevealed(String(row.id))}>{t("tenant.deliveries.actions.hide")}</button></span> : <span className="redacted-message"><span className="excerpt">{t("tenant.deliveries.contentRedacted")}</span>{canReadContent && !compact && row.body_available === true && mutationHeaders ? <button className="text-button" onClick={() => { setRevealError(null); setRevealId(String(row.id)); }}>{t("tenant.deliveries.actions.revealEllipsis")}</button> : null}</span>}
                {row.error_message ? (
                  <small className={deliveryRetriesAutomatically(row.state)?"delivery-pending-text":"danger-text"}>
                    {t(deliveryRetriesAutomatically(row.state)?"tenant.deliveries.automaticRetry":"tenant.errors.deliveryReview")}
                  </small>
                ) : null}
                {row.hold_reason ? <DeliveryHoldSummary row={row}/> : null}
              </td>
              <td>
                <Status value={row.state} />
              </td>
              <td><RelativeTime value={row.updated_at} pastOnly/></td>
              {!compact && (
                <td>
                  <div className="delivery-row-actions">
                  {String(row.state) === "OUTCOME_UNKNOWN" && reviewUnknown ? (
                    <button className="button small" onClick={()=>reviewUnknown(outcomeReviewId)}>
                      {t("tenant.deliveries.actions.reviewOutcome")}
                    </button>
                  ) : retry && (String(row.state) === "FAILED_RETRYABLE" ||
                  (String(row.state) === "FAILED_TERMINAL" && row.manual_retry_allowed === true)) ? (
                    <button
                      className="button small"
                      disabled={retryPending?.(String(row.id))}
                      onClick={() => retry(String(row.id), false, String(row.revision ?? row.updated_at))}
                    >
                      {t(retryPending?.(String(row.id)) ? "tenant.deliveries.actions.retrying" : "tenant.deliveries.actions.retry")}
                    </button>
                  ) : String(row.state) === "FAILED_TERMINAL" ? (
                    <small title={t("tenant.deliveries.terminalFailureHelp")}>
                      {t("tenant.deliveries.correctedReply")}
                    </small>
                  ) : String(row.state) === "BLOCKED" ? (
                    <small>{t("tenant.deliveries.resolveEarlierPart")}</small>
                  ) : null}
                  {inspect ? <button className="button small secondary" onClick={() => inspect(String(row.id))}>{t("tenant.deliveries.actions.inspect")}</button> : null}
                  </div>
                </td>
              )}
            </tr>;
          })}
        </tbody>
      </table>
    </WideTable>
    {canReadContent && revealId ? <ModalDialog close={() => setRevealId(null)} className="modal-backdrop" aria-labelledby="reveal-message-title"><div className="modal reveal-message-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.deliveries.reveal.eyebrow")}</span><h2 id="reveal-message-title">{t("tenant.deliveries.reveal.title")}</h2><p>{t("tenant.deliveries.reveal.body")}</p></div><button aria-label={t("tenant.deliveries.reveal.cancelLabel")} onClick={() => setRevealId(null)}>×</button></div>{revealError ? <div className="settings-feedback error" role="alert"><span>!</span><p>{revealError}</p></div> : null}<div className="audit-export-note"><span>i</span><p><b>{t("tenant.deliveries.reveal.investigationOnly")}</b><small>{t("tenant.deliveries.reveal.hideSoon")}</small></p></div><div className="modal-actions"><button className="button secondary" disabled={revealing} onClick={() => setRevealId(null)}>{t("tenant.deliveries.actions.cancel")}</button><button className="button primary" disabled={revealing} onClick={() => void reveal()}>{t(revealing ? "tenant.deliveries.actions.revealing" : "tenant.deliveries.actions.revealAndAudit")}</button></div></div></ModalDialog> : null}
    </>
  );
}

function DeliveryHoldSummary({row}:{row:RecordRow}){
  const {t}=useI18n();
  const ordering=(row.hold_reason??row.delivery_hold_reason)==="WAITING_FOR_EARLIER_DELIVERY";
  const nextAttempt=ordering?null:row.available_at??row.delivery_next_attempt_at;const expires=ordering?null:row.hold_expires_at??row.delivery_hold_expires_at;
  return <span className="delivery-hold-summary" role="status"><b>{deliveryHoldReason(row,t)}</b>{nextAttempt?<small>{t("tenant.deliveries.hold.nextAttempt")} <RelativeTime value={nextAttempt}/></small>:null}{expires?<small>{t("tenant.deliveries.hold.expires")} <RelativeTime value={expires}/></small>:null}</span>;
}
