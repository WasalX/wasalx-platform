"use client";
import { useEffect, useRef, useState } from "react";
import { InlineConfirmation } from "./ModalDialog";
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
    <div className="review-loading workspace-loading" role="status" aria-live="polite" aria-busy="true">
      <span aria-hidden="true" />
      <b>{t("tenant.loading.workspace")}</b>
    </div>
  );
}

export function WideTable({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div
      className="table-scroll"
      role="region"
      // Keyboard users need to focus an otherwise non-interactive overflow area.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      aria-label={t("tenant.accessibility.scrollTable")}
    >
      <span className="table-scroll-cue" aria-hidden="true">
        {t("tenant.accessibility.scrollTableCue")}
      </span>
      {children}
    </div>
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
        <kbd aria-hidden="true">⌘ K</kbd>
      </label>
      {children}
    </div>
  );
}
