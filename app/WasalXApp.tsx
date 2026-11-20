"use client";
import { createReplaceableRequestController } from "../lib/meta-capability-request";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatGPTUser } from "./chatgpt-auth";
import type { MetaGroupsCapability, NativeAccountObservation } from "../lib/control-plane-data";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { WorkspaceAccess } from "./WorkspaceAccess";
import { NativeAccountStatus } from "./NativeAccountStatus";
import { teamNativeAccountObservation } from "../lib/native-account-observation";
import { MetaBillingDiagnostics } from "./MetaBillingDiagnostics";
import { MetaCustomerPaymentPolicy } from "./MetaCustomerPaymentPolicy";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import type { RuleMatch, TriggerRule } from "../lib/domain";
import { describeRuleChange } from "../lib/rule-version-diff";
import { useI18n, useRelativeClock } from "./I18nProvider";
import { MetaSavedAccessActivation } from "./MetaSavedAccessActivation";
import { MetaNumberRelease } from "./MetaNumberRelease";
import { MetaSignup } from "./MetaSignup";
import { MetaRoutingConfiguration } from "./MetaRouting";
import { MetaCoexistence } from "./MetaCoexistence";
import { MetaCostUsage } from "./MetaCostUsage";
import { MetaTemplatePreparation } from "./MetaTemplatePreparation";
import { MetaLegacyMigration } from "./MetaLegacyMigration";
import { formatDateTime, formatDuration, formatNumber, formatPastRelativeTime, formatRelativeTime } from "../lib/i18n/format.ts";
import { localizedUiError } from "../lib/ui-error.ts";
import { fetchAccessCheck, installShellFetch, shouldCoverOnReturn, trackAccessCheck } from "../lib/shell-validation";
import { operatorFailureMessage, operatorLocalFailure, confirmUnsavedNavigation, createLatestRequestFence, shouldPauseAutomaticRefresh, unmatchedReviewItems, visibleReviewMetadata, deliveryFailureGuidance } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { NativeRoutingSync } from "./NativeRoutingSync";
import { isAbortError } from "../lib/bot-conversations";
import { can, isTenantRole, type TenantRole } from "../lib/tenant-permissions.ts";
import { connectionAuthorizationState, connectionDisplayState, connectionInboundIsReady, connectionIsReady, connectionTransportIsReady } from "../lib/connection-readiness.ts";
import { TENANT_VIEW_TITLES } from "../lib/tenant-view-titles.ts";
import { rememberBoundaryTheme, useBoundaryPreferences } from "./boundary-preferences.ts";

const InboxWorkspace = lazy(async () => ({ default: (await import("./InboxWorkspace")).InboxWorkspace }));
const SupportTeams = lazy(async () => ({ default: (await import("./SupportTeams")).SupportTeams }));
const MailboxAdministration = lazy(async () => ({ default: (await import("./MailboxAdministration")).MailboxAdministration }));

const BotAutomation = lazy(async () => ({
  default: (await import("./BotAutomation")).BotAutomation,
}));
const PluginCatalog = lazy(async () => ({
  default: (await import("./BotAutomation")).PluginCatalog,
}));
const ClientRouting = lazy(async () => ({
  default: (await import("./ClientRouting")).ClientRouting,
}));
const ConnectedDataServices = lazy(async () => ({
  default: (await import("./ClientRouting")).ConnectedDataServices,
}));
const CaseLifecycle = lazy(async () => ({
  default: (await import("./CaseLifecycle")).CaseLifecycle,
}));

type RecordRow = Record<string, unknown>;
const GROUP_DISPLAY_PAGE_SIZE=50;
const hasBotActionCapability = (row: RecordRow, surface: string) => {
  const capabilities = row.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const surfaces = (capabilities as RecordRow).invocation_surfaces;
  return Array.isArray(surfaces) && surfaces.includes(surface);
};
type NavigationTarget = {
  connection?: string;
  delivery?: string;
  ticket?: string;
  group?: string;
  message?: string;
  workspace?: "review" | "groups";
  review?: string;
};
type ToastNotice = {
  message: string;
  retry?: () => void;
  tone: "error" | "success";
};
type DashboardData = {
  tenant: RecordRow;
  connections: RecordRow[];
  groups: RecordRow[];
  rules: TriggerRule[];
  deliveries: RecordRow[];
  audit: RecordRow[];
  reviews?: RecordRow[];
  reviewQueueAvailable?: boolean;
  health?: RecordRow;
};
type WorkspaceOption = {
  id: string;
  name: string;
  slug: string;
  role: string;
  current: boolean;
};

type ConnectionDetailRow = RecordRow & {
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

type LifecycleAction = "start" | "restart" | "pause" | "disconnect" | "sync";

type PasskeyAssertionPayload = {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
};

type PasskeyChallengePayload = {
  challenge: string;
  timeout?: number;
  rpId: "web.whatsapp.com";
  allowCredentials?: Array<{
    id: string;
    type: "public-key";
    transports?: Array<"ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb">;
  }>;
  userVerification?: "discouraged" | "preferred" | "required";
};

type AuthorizationRetry =
  | { kind: "qr" }
  | { kind: "pairing"; key: string; phoneNumber: string }
  | { kind: "passkey"; key: string; assertion: PasskeyAssertionPayload }
  | { kind: "confirm"; key: string };

type QrAuthorization = {
  imageDataUrl: string | null;
  providerState: string;
  issuedAt: string | null;
  expiresAt: string | null;
  sequence: number;
  expired: boolean;
};

const CONNECTION_STATE_GUIDANCE: Record<string, { titleKey: string; bodyKey: string }> = {
  PROVISIONING: {
    titleKey: "tenant.connection.guidance.provisioning.title",
    bodyKey: "tenant.connection.guidance.provisioning.body",
  },
  AWAITING_AUTH: {
    titleKey: "tenant.connection.guidance.awaitingAuthorization.title",
    bodyKey: "tenant.connection.guidance.awaitingAuthorization.body",
  },
  CONNECTING: {
    titleKey: "tenant.connection.guidance.connecting.title",
    bodyKey: "tenant.connection.guidance.connecting.body",
  },
  VERIFYING: {
    titleKey: "tenant.connection.guidance.verifying.title",
    bodyKey: "tenant.connection.guidance.verifying.body",
  },
  AWAITING_INBOUND: {
    titleKey: "tenant.connection.guidance.awaitingInbound.title",
    bodyKey: "tenant.connection.guidance.awaitingInbound.body",
  },
  META_ROUTING_REQUIRED: {
    titleKey: "tenant.connection.guidance.metaRoutingRequired.title",
    bodyKey: "tenant.connection.guidance.metaRoutingRequired.body",
  },
  META_ROUTING_HELD: {
    titleKey: "tenant.connection.guidance.metaRoutingHeld.title",
    bodyKey: "tenant.connection.guidance.metaRoutingHeld.body",
  },
  WORKING: {
    titleKey: "tenant.connection.guidance.working.title",
    bodyKey: "tenant.connection.guidance.working.body",
  },
  DEGRADED: {
    titleKey: "tenant.connection.guidance.degraded.title",
    bodyKey: "tenant.connection.guidance.degraded.body",
  },
  ACTION_REQUIRED: {
    titleKey: "tenant.connection.guidance.actionRequired.title",
    bodyKey: "tenant.connection.guidance.actionRequired.body",
  },
  FAILED: {
    titleKey: "tenant.connection.guidance.failed.title",
    bodyKey: "tenant.connection.guidance.failed.body",
  },
  PAUSED: {
    titleKey: "tenant.connection.guidance.paused.title",
    bodyKey: "tenant.connection.guidance.paused.body",
  },
  REVOKED: {
    titleKey: "tenant.connection.guidance.revoked.title",
    bodyKey: "tenant.connection.guidance.revoked.body",
  },
};

const isDuplicateIdentityRejection = (reason: unknown) =>
  String(reason ?? "").startsWith("This WhatsApp account is already connected");

const connectionNeedsAttention = (row: RecordRow) =>
  ["CONNECTING", "ACTION_REQUIRED", "FAILED", "DEGRADED"].includes(connectionDisplayState(row))
  || (connectionDisplayState(row) === "WORKING" && !connectionIsReady(row));

const NAV = [
  ["overview", "tenant.navigation.overview", "⌂"],
  ["inbox", "inbox.title", "◇"],
  ["connections", "tenant.navigation.connections", "↗"],
  ["groups", "tenant.navigation.groups", "#"],
  ["rules", "tenant.navigation.rules", "⌘"],
  ["automation", "tenant.navigation.automation", "B"],
  ["plugins", "tenant.navigation.plugins", "◇"],
  ["routing", "tenant.navigation.routing", "↳"],
  ["cases", "tenant.navigation.cases", "◇"],
  ["deliveries", "tenant.navigation.deliveries", "⇢"],
  ["team", "tenant.navigation.team", "◎"],
  ["support", "tenant.navigation.support", "⌁"],
  ["audit", "tenant.navigation.audit", "◫"],
  ["settings", "tenant.navigation.settings", "⚙"],
] as const;

function RelativeTime({ value, pastOnly = false }: { value: unknown; pastOnly?: boolean }) {
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

function duration(value: unknown, locale: "en" | "ar") {
  return formatDuration(Math.max(0, Number(value ?? 0)), locale);
}

function exactTime(value: unknown, locale: "en" | "ar", fallback: string) {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : formatDateTime(date, locale);
}

function exactTimeWithSeconds(value: unknown, locale: "en" | "ar", fallback: string) {
  if (!value) return fallback;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? fallback
    : formatDateTime(date, locale, { dateStyle: "medium", timeStyle: "medium" });
}

type TenantTranslator = ReturnType<typeof useI18n>["t"];

function connectionMethod(value: unknown, t: TenantTranslator) {
  return String(value ?? "").toLowerCase() === "meta"
    ? t("tenant.connection.method.official")
    : t("tenant.connection.method.linkedDevice");
}

const CONNECTION_LIFECYCLE_STATES = new Set([
  "provisioning",
  "awaiting_auth",
  "connecting",
  "working",
  "degraded",
  "action_required",
  "failed",
  "paused",
  "revoked",
  "queued",
  "running",
  "failed_retryable",
]);

function connectionStateText(value: unknown, t: TenantTranslator) {
  const state = String(value ?? "").toLowerCase();
  return t(CONNECTION_LIFECYCLE_STATES.has(state)
    ? `tenant.connection.lifecycle.state.${state}`
    : "tenant.status.unknown");
}

function authorizationState(value: unknown, t: TenantTranslator) {
  const state = String(value ?? "").toUpperCase();
  if (state === "LAST_VERIFIED") return t("tenant.connection.health.lastVerificationPassed");
  if (state === "PAUSED") return t("tenant.status.paused");
  if (state === "ACTION_REQUIRED") return t("tenant.status.actionRequired");
  if (state === "WORKING") return t("common.status.connected");
  if (["STARTING", "CONNECTING"].includes(state)) return t("tenant.status.connecting");
  if (["SCAN_QR_CODE", "PAIRING_CODE_REQUIRED", "PASSKEY_REQUIRED", "PASSKEY_CONFIRMATION_REQUIRED"].includes(state)) return t("tenant.status.actionRequired");
  if (["FAILED", "STOPPED", "REVOKED"].includes(state)) return t("tenant.status.needsAttention");
  return t("tenant.connection.notReported");
}

async function apiError(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { code?: unknown };
  const locale = typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("ar") ? "ar" : "en";
  return localizedUiError(locale, { status: response.status, code: body.code }).message;
}

const SESSION_EXPIRED_EVENT = "wasalx:session-expired";
const SIDEBAR_PIN_KEY = "wasalx.sidebar.pinned";
const LOCALE_FOCUS_KEY = "wasalx.locale.restore-focus";

function isOpaqueIdentifier(value: unknown) {
  const text = String(value ?? "").trim();
  return (
    /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(text) ||
    /@(?:g\.us|c\.us)$/iu.test(text) ||
    /^(?:aud|conn|del|grp|req|review|tenant|user)[_-]/iu.test(text)
  );
}

const REVIEW_REASON_KEYS = new Set([
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
const REVIEW_SOURCE_KEYS = new Set(["inbound", "outbound"]);
const REVIEW_STATE_KEYS = new Set(["open", "resolved", "discarded", "reprocess_queued"]);

function reviewOriginalReason(row: RecordRow, t: TenantTranslator) {
  const reason = String(row.reason_code ?? "").toLowerCase();
  return REVIEW_REASON_KEYS.has(reason)
    ? t(`tenant.deliveries.review.reason.${reason}`)
    : t("tenant.deliveries.review.reason.unknown");
}

function reviewReason(row: RecordRow, t: TenantTranslator) {
  const state = reviewState(row.state);
  return state === "resolved" || state === "discarded"
    ? t(`tenant.deliveries.review.closed.${state}`)
    : reviewOriginalReason(row, t);
}

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

function reviewState(value: unknown) {
  const state = String(value ?? "").toLowerCase();
  return REVIEW_STATE_KEYS.has(state) ? state : "unknown";
}

function deliveryRetriesAutomatically(value: unknown) {
  return ["QUEUED", "FAILED_RETRYABLE"].includes(String(value ?? "").toUpperCase());
}

const DELIVERY_HOLD_REASONS = new Set(["waiting_for_earlier_delivery","waiting_for_inbound","rate_limited","policy_paused","connection_not_ready","destination_unavailable","waiting"]);
function deliveryHoldReason(row: RecordRow, t: TenantTranslator) {
  const reason=String(row.hold_reason??row.delivery_hold_reason??"").toLowerCase();
  return t(DELIVERY_HOLD_REASONS.has(reason)?`tenant.deliveries.hold.reason.${reason}`:"tenant.deliveries.hold.reason.waiting");
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

function issueDeliveries(data: DashboardData) {
  return data.deliveries.filter((delivery) =>
    String(delivery.state).includes("FAILED") || String(delivery.state) === "OUTCOME_UNKNOWN"
  );
}

function unmatchedReviews(data: DashboardData) {
  return unmatchedReviewItems(issueDeliveries(data), data.reviews ?? []);
}

function groupDestination(value: unknown, t: TenantTranslator) {
  const destination = String(value ?? "").trim();
  if (!destination || destination === "Not configured") return t("tenant.group.destinationNotConfigured");
  return isOpaqueIdentifier(destination) || /^\d+$/u.test(destination)
    ? t("tenant.group.destinationConfigured")
    : destination;
}

function qrCountdown(milliseconds: number, locale: "en" | "ar") {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${formatNumber(Math.floor(seconds / 60), locale, { useGrouping: false })}:${formatNumber(seconds % 60, locale, { minimumIntegerDigits: 2, useGrouping: false })}`;
}

function idempotentHeaders(headers:Record<string,string>){return{...headers,"idempotency-key":crypto.randomUUID()}}

const NAVIGATION_TARGET_KEYS = ["connection", "delivery", "ticket", "group", "message", "workspace", "review"] as const;

function requiresPrivilegedReauthentication(message: string | null) {
  return Boolean(message && /reauthenticate|authentication|sign in again|recent sign-in|أعد التحقق/i.test(message));
}

function privilegedStepUpHref(returnTo: string) {
  return `/auth/login?step_up=privileged&return_to=${encodeURIComponent(returnTo)}`;
}

function safeNavigationTarget(value: string | null, kind: "connection" | "delivery" | "review" | "ticket" | "group" | "message") {
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

function navigationUrl(currentHref: string, nextView: string, target: NavigationTarget = {}) {
  const url = new URL(currentHref);
  if (nextView === "overview") url.searchParams.delete("view");
  else url.searchParams.set("view", nextView);
  for (const key of NAVIGATION_TARGET_KEYS) url.searchParams.delete(key);
  if (nextView === "connections" && target.connection) url.searchParams.set("connection", target.connection);
  if (nextView === "deliveries" && target.delivery) url.searchParams.set("delivery", target.delivery);
  if (nextView === "deliveries" && target.workspace === "review") url.searchParams.set("workspace", "review");
  if (nextView === "deliveries" && target.review) url.searchParams.set("review", target.review);
  if ((nextView === "cases" || nextView === "inbox") && target.ticket) url.searchParams.set("ticket", target.ticket);
  if (nextView === "inbox" && (target.workspace === "groups" || target.group)) {
    url.searchParams.delete("ticket");
    url.searchParams.set("workspace", "groups");
    if (target.group) {
      url.searchParams.set("group", target.group);
      if (target.message) url.searchParams.set("message", target.message);
    }
  }
  return url;
}

const WAHA_PASSKEY_CHROME_EXTENSION_ID = "ghpdcgnjffaaekflfpcgkgpbafmjldcp";
const PASSKEY_CLIENT_ERROR = {
  unavailable: "PASSKEY_EXTENSION_UNAVAILABLE",
  noResponse: "PASSKEY_EXTENSION_NO_RESPONSE",
  rejected: "PASSKEY_EXTENSION_REJECTED",
  invalidAssertion: "PASSKEY_ASSERTION_INVALID",
} as const;

function passkeyClientErrorMessage(error: unknown, t: TenantTranslator) {
  const code = error instanceof Error ? error.message : "";
  if (code === PASSKEY_CLIENT_ERROR.unavailable) return t("tenant.connection.errors.passkeyExtensionUnavailable");
  if (code === PASSKEY_CLIENT_ERROR.noResponse) return t("tenant.connection.errors.passkeyExtensionNoResponse");
  if (code === PASSKEY_CLIENT_ERROR.invalidAssertion) return t("tenant.connection.errors.assertionInvalid");
  return t("tenant.connection.errors.passkeyStep");
}

async function signPasskeyWithOfficialExtension(
  challenge: PasskeyChallengePayload,
): Promise<PasskeyAssertionPayload> {
  if (/firefox/i.test(navigator.userAgent)) {
    return passkeyAssertionFromUnknown(await callFirefoxPasskeyExtension(challenge));
  }
  const runtime = (window as typeof window & {
    chrome?: {
      runtime?: {
        lastError?: { message?: string };
        sendMessage(
          extensionId: string,
          message: unknown,
          callback: (response: unknown) => void,
        ): void;
      };
    };
  }).chrome?.runtime;
  if (!runtime?.sendMessage) {
    throw new Error(PASSKEY_CLIENT_ERROR.unavailable);
  }
  const response = await new Promise<unknown>((resolve, reject) => {
    runtime.sendMessage(
      WAHA_PASSKEY_CHROME_EXTENSION_ID,
      { type: "waha-passkey-sign", challenge },
      (value) => {
        if (runtime.lastError) {
          reject(new Error(PASSKEY_CLIENT_ERROR.noResponse));
          return;
        }
        resolve(value);
      },
    );
  });
  const record = response && typeof response === "object" ? response as Record<string, unknown> : null;
  if (record?.ok !== true) {
    throw new Error(PASSKEY_CLIENT_ERROR.rejected);
  }
  return passkeyAssertionFromUnknown(record.assertion);
}

function callFirefoxPasskeyExtension(challenge: PasskeyChallengePayload) {
  return new Promise<unknown>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(PASSKEY_CLIENT_ERROR.noResponse));
    }, 120_000);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown> | null;
      if (
        !data ||
        data.source !== "waha-passkey-extension" ||
        data.requestId !== requestId
      ) return;
      cleanup();
      if (data.ok !== true) {
        reject(new Error(PASSKEY_CLIENT_ERROR.rejected));
        return;
      }
      resolve(data.assertion);
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    window.postMessage(
      {
        source: "waha-passkey-page",
        requestId,
        type: "waha-passkey-sign",
        challenge,
      },
      window.location.origin,
    );
  });
}

function passkeyAssertionFromUnknown(value: unknown): PasskeyAssertionPayload {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const response = record?.response && typeof record.response === "object" && !Array.isArray(record.response)
    ? record.response as Record<string, unknown>
    : null;
  const base64 = (candidate: unknown) =>
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= 65_536 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(candidate)
      ? candidate
      : null;
  const id = base64(record?.id);
  const rawId = base64(record?.rawId);
  const clientDataJSON = base64(response?.clientDataJSON);
  const authenticatorData = base64(response?.authenticatorData);
  const signature = base64(response?.signature);
  const userHandle = response?.userHandle === null ? null : base64(response?.userHandle);
  if (!id || !rawId || record?.type !== "public-key" || !clientDataJSON || !authenticatorData || !signature) {
    throw new Error(PASSKEY_CLIENT_ERROR.invalidAssertion);
  }
  return {
    id,
    rawId,
    type: "public-key",
    response: { clientDataJSON, authenticatorData, signature, userHandle },
  };
}

function statusPresentation(value: unknown) {
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

function Status({ value }: { value: unknown }) {
  const { t } = useI18n();
  const [label, tone] = statusPresentation(value);
  return (
    <span className={`status status-${tone}`}>
      <i />
      {t(label)}
    </span>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function WorkspaceLoading() {
  const { t } = useI18n();
  return (
    <div className="review-loading workspace-loading" role="status" aria-live="polite" aria-busy="true">
      <span aria-hidden="true" />
      <b>{t("tenant.loading.workspace")}</b>
    </div>
  );
}

function WideTable({ children }: { children: React.ReactNode }) {
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

function useDialogCloseGuard(close: () => void, busy = false, controlledDirty?: boolean, controlledDirtyToken?: unknown) {
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

function DirtyCloseConfirmation({ guard }: { guard: ReturnType<typeof useDialogCloseGuard> }) {
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

function SessionExpired({
  returnTo,
  theme,
}: {
  returnTo: string;
  theme: "light" | "dark";
}) {
  const { direction, locale, t } = useI18n();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className={`portal-session-expired theme-${theme}`} lang={locale} dir={direction}>
      <section aria-labelledby="session-expired-title">
        <span aria-hidden="true">!</span>
        <h1 id="session-expired-title" ref={heading} tabIndex={-1}>{t("tenant.session.expiredTitle")}</h1>
        <p>{t("tenant.session.expiredBody")}</p>
        <a className="button primary" href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`}>
          {t("tenant.session.signIn")}
        </a>
      </section>
    </main>
  );
}

function NotificationCenter({
  data,
  navigate,
}: {
  data: DashboardData;
  navigate: (view: string, target?: NavigationTarget) => void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  const items = [
    ...data.connections
      .filter((connection) =>
        ["ACTION_REQUIRED", "FAILED", "DEGRADED"].includes(String(connection.state)) &&
        !isDuplicateIdentityRejection(connection.action_reason)
      )
      .map((connection) => ({
        id: `connection-${String(connection.id)}`,
        title: t("tenant.notifications.connectionAttention", { name: String(connection.name) }),
        body: t("tenant.notifications.connectionAttentionBody"),
        view: "connections",
        target: { connection: String(connection.id) },
        tone: "warning",
      })),
    ...issueDeliveries(data)
      .map((delivery) => ({
        id: `delivery-${String(delivery.id)}`,
        title: t("tenant.notifications.deliveryReview", { reference: typeof delivery.ticket_number === "string" ? delivery.ticket_number : t("tenant.deliveries.table.noCase") }),
        body: t("tenant.notifications.deliveryReviewBody"),
        view: "deliveries",
        target: String(delivery.state)==="OUTCOME_UNKNOWN"&&safeNavigationTarget(typeof delivery.outcome_review_id==="string"?delivery.outcome_review_id:null,"review")
          ? { workspace:"review" as const,review:String(delivery.outcome_review_id) }
          : { delivery: String(delivery.id) },
        tone: "danger",
      })),
    ...unmatchedReviews(data).map((review) => ({
      id: `review-${String(review.id)}`,
      title: reviewReason(review, t),
      body: t("tenant.notifications.reviewQueueBody"),
      view: "deliveries",
      target: { workspace:"review" as const,review:String(review.id) },
      tone: "warning",
    })),
    ...(data.reviewQueueAvailable === false
      ? [{
          id: "review-queue-unavailable",
          title: t("tenant.notifications.reviewQueueUnavailable"),
          body: t("tenant.notifications.reviewQueueUnavailableBody"),
          view: "deliveries",
          target: { workspace:"review" as const },
          tone: "danger",
        }]
      : []),
    ...(String((data.health?.zammad as RecordRow | undefined)?.state ?? "").toUpperCase() &&
    String((data.health?.zammad as RecordRow | undefined)?.state ?? "").toUpperCase() !== "WORKING"
      ? [{
          id: "case-health",
          title: t("tenant.health.caseAttention"),
          body: t("tenant.notifications.caseAttentionBody"),
          view: "overview",
          target: {},
          tone: "danger",
        }]
      : []),
  ];
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [close, open]);
  return (
    <div className="notification-center" ref={container}>
      <button
        ref={trigger}
        className="icon-button notification"
        aria-label={t(items.length === 1 ? "tenant.notifications.countOne" : "tenant.notifications.count", { count: formatNumber(items.length, locale) })}
        aria-expanded={open}
        aria-controls="operational-notifications"
        onClick={() => setOpen((value) => !value)}
      >
        ○{items.length ? <i /> : null}
      </button>
      {open ? (
        <section id="operational-notifications" className="notification-panel" aria-labelledby="operational-notifications-title">
          <header><span><h2 id="operational-notifications-title">{t("tenant.notifications.title")}</h2><small>{items.length ? t(items.length === 1 ? "tenant.notifications.needReview.one" : "tenant.notifications.needReview", { count: formatNumber(items.length, locale) }) : t("tenant.notifications.none")}</small></span><button className="text-button" onClick={() => close(true)}>{t("common.actions.close")}</button></header>
          {items.length ? <div className="notification-list">{items.map((item) => <button key={item.id} onClick={() => { close(true); navigate(item.view, item.target); }}><span className={`notification-mark ${item.tone}`} /><span><b><bdi>{item.title}</bdi></b><small>{item.body}</small></span><span aria-hidden="true">→</span></button>)}</div> : <Empty title={t("tenant.notifications.allClear")} body={t("tenant.notifications.allClearBody")} />}
        </section>
      ) : null}
    </div>
  );
}

export function WasalXApp(props: {
  initialData: DashboardData;
  initialView?: string;
  user: ChatGPTUser;
}) {
  const { t, locale, direction } = useI18n();
  const tenantRole = isTenantRole(props.user.role) ? props.user.role : null;
  useEffect(() => {
    if (!tenantRole) document.title = `${t("tenant.boundary.error.heading")} · WasalX`;
  }, [t, tenantRole]);
  if (tenantRole) return <TenantWasalXApp key={`${String(props.initialData.tenant.id)}:${tenantRole}`} {...props} role={tenantRole} />;
  return (
    <main className="portal-session-expired theme-dark" lang={locale} dir={direction}>
      <section role="alert" aria-labelledby="tenant-role-unavailable-title">
        <span aria-hidden="true">!</span>
        <h1 id="tenant-role-unavailable-title">{t("tenant.boundary.error.heading")}</h1>
        <p>{t("tenant.boundary.error.description")}</p>
        <a className="button primary" href="/auth/login?prompt=login&return_to=/app">{t("tenant.session.signIn")}</a>
      </section>
    </main>
  );
}

function TenantWasalXApp({
  initialData,
  initialView = "overview",
  user,
  role,
}: {
  initialData: DashboardData;
  initialView?: string;
  user: ChatGPTUser;
  role: TenantRole;
}) {
  const { t, locale, direction } = useI18n();
  const runtime = String(initialData.tenant.runtime ?? "D1").toUpperCase();
  const isPrivateDemo = runtime === "D1";
  const canConfigure = !isPrivateDemo && can(role, "connection:write");
  const canOperateBot = !isPrivateDemo && can(role, "bot:operate");
  const canRetry = !isPrivateDemo && can(role, "delivery:retry");
  const canReadDeliveryContent = !isPrivateDemo && can(role, "delivery:content:read");
  const canReadCases = !isPrivateDemo && can(role, "case:read");
  const canDetachCases = can(role, "case:detach");
  const canAudit = can(role, "audit:read");
  const canExportAudit = can(role, "audit:export");
  const canReadReview = !isPrivateDemo && can(role, "review:read");
  const canReadSettings = can(role, "settings:read");
  const canWriteSettings = !isPrivateDemo && can(role, "settings:write");
  const canReadTeam = !isPrivateDemo && can(role, "team:read");
  const canManageTeam = can(role, "team:write");
  const canReadSupport = !isPrivateDemo && can(role, "support:read");
  const canApproveSupport = can(role, "support:approve");
  const visibleNavigation = NAV.filter(([id]) =>
    (id !== "audit" || canAudit) &&
    (id !== "settings" || canReadSettings) &&
    (id !== "team" || canReadTeam) &&
    (id !== "support" || canReadSupport) &&
    (id !== "cases" || canReadCases) &&
    (id !== "inbox" || !isPrivateDemo && can(role, "ticket:read"))
  );
  const [liveData, setLiveData] = useState(initialData);
  const [dashboardFreshness, setDashboardFreshness] = useState<"confirmed" | "stale">("confirmed");
  const [view, setView] = useState(() => visibleNavigation.some(([id]) => id === initialView) ? initialView : "overview");
  const tenantTheme = String(initialData.tenant.default_theme ?? "SYSTEM").toUpperCase();
  // Start from the theme last resolved for this browser (cookie seed) so light-mode users do not see a dark first paint.
  const seededTheme = useBoundaryPreferences("tenant").theme;
  const [theme, setTheme] = useState<"light" | "dark">(seededTheme);
  const applicationRootRef = useRef<HTMLDivElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const shellRetryRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const mutations = useRef(new Map<string, { fingerprint: string; key: string; pending: boolean; completed: boolean }>());
  const [pendingMutations, setPendingMutations] = useState<ReadonlySet<string>>(new Set());
  const toastTimer = useRef<number | null>(null);
  const [connectionModal, setConnectionModal] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(
    null,
  );
  const [connectionOverrides, setConnectionOverrides] = useState<Record<string, RecordRow>>({});
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null);
  const [deliveryWorkspace,setDeliveryWorkspace]=useState<"deliveries"|"review">("deliveries");
  const [selectedReviewId,setSelectedReviewId]=useState<string|null>(null);
  const [targetTicketNumber, setTargetTicketNumber] = useState<string | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null);
  const [targetGroupMessageId, setTargetGroupMessageId] = useState<string | null>(null);
  const [inboxMode, setInboxMode] = useState<"tickets" | "groups">("tickets");
  const inboxRecoveryScope = String(initialData.tenant.id) + ":" + user.userId;
  const inboxScope = useMemo(() => `${initialData.tenant.id}:${user.userId}:${role}:${user.csrfToken ? "private" : "preview"}:${crypto.randomUUID()}`,
    [initialData.tenant.id, user.userId, user.csrfToken, role]);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [workspaceLoadState,setWorkspaceLoadState]=useState<"loading"|"ready"|"failed">(runtime==="CONTROL_PLANE"?"loading":"ready");
  const [shellValidationState,setShellValidationState]=useState<"checking"|"ready"|"failed">(runtime==="CONTROL_PLANE"?"checking":"ready");
  const workspaceLoadFence=useRef(createLatestRequestFence());
  const openReviewsLoadFence=useRef(createLatestRequestFence());
  const dashboardLoadFence=useRef(createLatestRequestFence());
  const [expiredSessionReturnTo, setExpiredSessionReturnTo] = useState<string | null>(null);
  const [openReviews, setOpenReviews] = useState<RecordRow[]>([]);
  const [reviewQueueAvailable, setReviewQueueAvailable] = useState<boolean | undefined>();
  const [sidebarPinned, setSidebarPinned] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileNavigationToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const closeOnDesktop = () => { if (desktop.matches) setMobileNavigationOpen(false); };
    closeOnDesktop();
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!mobileNavigationOpen || window.matchMedia("(min-width: 761px)").matches) return;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const selector = "a[href],button:not([disabled]),summary,select:not([disabled]),input:not([disabled])";
    const focusable = () => [...sidebar.querySelectorAll<HTMLElement>(selector)].filter(element => {
      const closedDetails=element.closest("details:not([open])");
      return element.getClientRects().length > 0 && (!closedDetails || element.tagName === "SUMMARY" && element.parentElement === closedDetails);
    });
    (sidebar.querySelector<HTMLElement>("nav [aria-current='page']") ?? focusable()[0])?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.target instanceof Element && event.target.closest(".workspace-select[open]")) return;
        event.preventDefault(); setMobileNavigationOpen(false); requestAnimationFrame(() => mobileNavigationToggleRef.current?.focus()); return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    sidebar.addEventListener("keydown", onKeyDown);
    return () => sidebar.removeEventListener("keydown", onKeyDown);
  }, [mobileNavigationOpen]);
  // Declared here so the single fetch install below can gate mutations on them.
  const shellVerified=useRef(shellValidationState==="ready");
  const accessCheck=useRef<Promise<boolean>|null>(null);
  useLayoutEffect(() => {
    const expire = (event: Event) => {
      const returnTo = (event as CustomEvent<{ returnTo?: string }>).detail?.returnTo;
      setExpiredSessionReturnTo(returnTo?.startsWith("/") ? returnTo : "/app");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    const restoreFetch = installShellFetch(window, {
      tenantId: String(initialData.tenant.id),
      role,
      onUnauthorized: () => window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, {
        detail: { returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}` },
      })),
      // Mutations wait for an in-flight check and are refused unless access is still verified.
      gate: runtime === "CONTROL_PLANE" ? { pending: () => accessCheck.current, verified: () => shellVerified.current } : undefined,
    });
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
      restoreFetch();
    };
  }, [initialData.tenant.id,role,runtime]);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(LOCALE_FOCUS_KEY) !== "true") return;
      window.sessionStorage.removeItem(LOCALE_FOCUS_KEY);
      window.requestAnimationFrame(() => {
        applicationRootRef.current
          ?.querySelector<HTMLElement>(".top-locale-switcher button:not([aria-pressed='true'])")
          ?.focus({ preventScroll: true });
      });
    } catch { /* A blocked session preference leaves normal document focus unchanged. */ }
  }, []);
  useEffect(() => {
    queueMicrotask(() => {
      try { setSidebarPinned(window.localStorage.getItem(SIDEBAR_PIN_KEY) === "true"); }
      catch { setSidebarPinned(false); }
    });
  }, []);
  const loadWorkspaces = useCallback(async (signal?: AbortSignal) => {
    if (runtime !== "CONTROL_PLANE") return true;
    const request=workspaceLoadFence.current.begin();
    const isCurrent=()=>!signal?.aborted&&workspaceLoadFence.current.isCurrent(request);
    if(isCurrent()){
      setWorkspaceLoadState(current=>current==="ready"?current:"loading");
      setShellValidationState(current=>current==="ready"?current:"checking");
    }
    try {
      // A transient failure retries once by itself: headless or unattended tabs never fire the focus re-check.
      const response = await fetchAccessCheck(attempt => fetch("/api/workspaces", { cache: "no-store", signal: attempt }), signal);
      if (response.status === 401 || response.status === 403) throw new Error("workspace_access_changed");
      if (!response.ok) throw new Error("workspace_list_unavailable");
      const result = (await response.json()) as { data?: WorkspaceOption[] };
      const next = Array.isArray(result.data) ? result.data : [];
      const current = next.find((workspace) => workspace.current);
      if (!current) throw new Error("workspace_access_changed");
      if ((initialData.tenant.id && current.id !== String(initialData.tenant.id)) || current.role !== role) throw new Error("workspace_changed");
      if(!isCurrent())return false;
      setWorkspaces(next);setWorkspaceLoadState("ready");setShellValidationState("ready");return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        // A caller abort is not a verdict, but an aborted check that still owns the cover must leave Retry, not a dead end.
        if(workspaceLoadFence.current.isCurrent(request)){setWorkspaceLoadState(current=>current==="loading"?"failed":current);setShellValidationState(current=>current==="checking"?"failed":current)}
        return false;
      }
      if (error instanceof Error && error.message === "workspace_changed") {
        // The session now belongs to another workspace or role: cover the page and let the server render the current one.
        if(isCurrent()){
          applicationRootRef.current?.setAttribute("data-shell-validation","checking");
          setShellValidationState("checking");
          window.location.reload();
        }
        return false;
      }
      if (error instanceof Error && error.message === "workspace_access_changed") {
        if(isCurrent()){
          applicationRootRef.current?.setAttribute("data-shell-validation","checking");
          setShellValidationState("checking");
          window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, {
            detail: { returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}` },
          }));
        }
        return false;
      }
      if(isCurrent()){setWorkspaceLoadState("failed");setShellValidationState("failed")}
      return false;
    }
  }, [initialData.tenant.id, role, runtime]);
  const verifyWorkspaces=useCallback((signal?:AbortSignal)=>trackAccessCheck(loadWorkspaces(signal),accessCheck,shellVerified,signal),[loadWorkspaces]);
  // The initial check is published at layout time, before any view's mount effects, so their requests wait for it instead of being refused; the load itself starts a microtask later.
  useLayoutEffect(() => {
    const controller = new AbortController();
    const fence=workspaceLoadFence.current;
    const load=new Promise<boolean>(resolve=>queueMicrotask(()=>resolve(!controller.signal.aborted&&loadWorkspaces(controller.signal))));
    void trackAccessCheck(load,accessCheck,shellVerified,controller.signal);
    return () => {controller.abort();fence.invalidate()};
  }, [loadWorkspaces]);
  const maskShell=useCallback(()=>{
    if(runtime!=="CONTROL_PLANE")return;
    workspaceLoadFence.current.invalidate();
    accessCheck.current=null;shellVerified.current=false;
    applicationRootRef.current?.setAttribute("data-shell-validation","checking");
    setShellValidationState("checking");
  },[runtime]);
  // The failed cover hides the inert shell, so keyboard focus moves to its Retry; silent re-checks never reach this state.
  useEffect(()=>{if(shellValidationState==="failed")shellRetryRef.current?.focus({preventScroll:true})},[shellValidationState]);
  useEffect(()=>{
    if(runtime!=="CONTROL_PLANE")return;
    let awayStartedAt:number|null=null;
    const verify=(cover:boolean)=>{
      if(cover)maskShell();
      void verifyWorkspaces();
    };
    // Short absences re-check silently; the cover appears only after a long absence or when the check reports a change or fails.
    const leave=()=>{awayStartedAt??=Date.now()};
    const back=()=>{const cover=shouldCoverOnReturn(awayStartedAt,Date.now());awayStartedAt=null;if(cover||!accessCheck.current)verify(cover)};
    const visibility=()=>document.visibilityState==="visible"?back():leave();
    const restore=(event:PageTransitionEvent)=>{if(event.persisted)verify(true)};
    document.addEventListener("visibilitychange",visibility);
    window.addEventListener("blur",leave);
    window.addEventListener("focus",back);
    window.addEventListener("pagehide",maskShell);
    window.addEventListener("pageshow",restore);
    return()=>{
      document.removeEventListener("visibilitychange",visibility);
      window.removeEventListener("blur",leave);
      window.removeEventListener("focus",back);
      window.removeEventListener("pagehide",maskShell);
      window.removeEventListener("pageshow",restore);
    };
  },[verifyWorkspaces,maskShell,runtime]);
  const userInitials = user.displayName.split(/\s+/u).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "U";
  const initialsFor=(name:string)=>name.split(/\s+/u).filter(Boolean).map(part=>Array.from(part)[0]??"").join("").slice(0,2).toLocaleUpperCase(locale)||"W";
  const workspaceInitials=initialsFor(String(liveData.tenant.name));
  const loadOpenReviews = useCallback(async (signal?: AbortSignal) => {
    if (runtime === "D1" || !canReadReview) return;
    const request=openReviewsLoadFence.current.begin();
    const isCurrent=()=>!signal?.aborted&&openReviewsLoadFence.current.isCurrent(request);
    try {
      const response = await fetch("/api/reviews", { cache: "no-store", signal });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const rows = await response.json() as RecordRow[];
      if(isCurrent()){setOpenReviews(rows.filter((row) => String(row.state) === "OPEN"));setReviewQueueAvailable(true)}
    } catch (problem) {
      if (problem instanceof DOMException && problem.name === "AbortError") return;
      if(isCurrent()){setOpenReviews([]);setReviewQueueAvailable(false)}
    }
  }, [canReadReview, runtime]);
  const handleReviewsLoaded = useCallback((rows: RecordRow[]) => {
    setOpenReviews(rows.filter((row) => String(row.state) === "OPEN"));
    setReviewQueueAvailable(true);
  }, []);
  useEffect(() => {
    if (runtime === "D1" || !canReadReview) return;
    const controller = new AbortController();
    const fence=openReviewsLoadFence.current;
    let active = true;
    queueMicrotask(() => { if (active) void loadOpenReviews(controller.signal); });
    return () => { active = false; controller.abort();fence.invalidate() };
  }, [canReadReview, loadOpenReviews, runtime]);
  const loadDashboard = useCallback(async (signal?: AbortSignal) => {
    const request=dashboardLoadFence.current.begin();
    const isCurrent=()=>!signal?.aborted&&dashboardLoadFence.current.isCurrent(request);
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store", signal });
      if (!response.ok) {
        if (isCurrent()) setDashboardFreshness("stale");
        return false;
      }
      if (!isCurrent()) return false;
      const result = await response.json() as { data?: DashboardData };
      if(!isCurrent())return false;
      if(!result.data){setDashboardFreshness("stale");return false}
      if(String(result.data.tenant?.id??"")!==String(initialData.tenant.id)||String(result.data.tenant?.role??"")!==role){
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT,{detail:{returnTo:`${location.pathname}${location.search}${location.hash}`}}));
        return false;
      }
      setLiveData(result.data);
      setConnectionOverrides({});
      setDashboardFreshness("confirmed");
      return true;
    } catch (problem) {
      if (isCurrent() && !isAbortError(problem)) setDashboardFreshness("stale");
      return false;
    }
  }, [initialData.tenant.id,role]);
  useVisibleRefresh(async (signal) => {
    if (shouldPauseAutomaticRefresh()) return;
    if(!await verifyWorkspaces(signal))return;
    if(await loadDashboard(signal))await loadOpenReviews(signal);
  }, expiredSessionReturnTo === null && !connectionModal);
  const reportedHealth = String(liveData.health?.status ?? "").toLowerCase();
  const zammadState = String((liveData.health?.zammad as RecordRow | undefined)?.state ?? "").toUpperCase();
  const coreHealthy = (reportedHealth === "operational" || reportedHealth === "healthy" || reportedHealth === "ok") && zammadState === "WORKING";
  const healthTone = zammadState && zammadState !== "WORKING" ? "danger" : coreHealthy ? "success" : "warning";
  const environment = runtime === "FIXTURE"
    ? { label: t("tenant.environment.previewReadOnly"), tone: "neutral" }
    : runtime === "CONTROL_PLANE"
      ? dashboardFreshness === "stale"
        ? { label: t("tenant.environment.lastConfirmed"), tone: "warning" }
        : { label: coreHealthy ? t("tenant.environment.live") : t("tenant.environment.liveAttention"), tone: healthTone }
      : { label: t("tenant.environment.previewOffline"), tone: "neutral" };
  const visibleViewIds = visibleNavigation.map(([id]) => id).join(",");
  const applyNavigationTarget = useCallback((nextView: string, target: NavigationTarget = {}) => {
    setSelectedConnectionId(nextView === "connections" ? safeNavigationTarget(target.connection ?? null,"connection") : null);
    setSelectedDeliveryId(nextView === "deliveries" ? safeNavigationTarget(target.delivery ?? null,"delivery") : null);
    if (nextView !== "inbox" || target.workspace !== "groups" && !target.group)
      setTargetTicketNumber(nextView === "cases" || nextView === "inbox" ? safeNavigationTarget(target.ticket ?? null,"ticket") : null);
    if (nextView !== "inbox" || target.workspace === "groups" || target.group)
      setTargetGroupId(nextView === "inbox" ? safeNavigationTarget(target.group ?? null, "group") : null);
    if (nextView !== "inbox" || target.workspace === "groups" || target.group)
      setTargetGroupMessageId(nextView === "inbox" && target.group ? safeNavigationTarget(target.message ?? null, "message") : null);
    setInboxMode(nextView === "inbox" && (target.workspace === "groups" || target.group) ? "groups" : "tickets");
    const review=nextView==="deliveries"&&canReadReview?safeNavigationTarget(target.review??null,"review"):null;
    setDeliveryWorkspace(nextView==="deliveries"&&canReadReview&&(target.workspace==="review"||review)?"review":"deliveries");
    setSelectedReviewId(review);
  }, [canReadReview]);
  const focusPageHeading = useCallback(() => {
    window.requestAnimationFrame(() => pageHeadingRef.current?.focus({ preventScroll: true }));
  }, []);
  const navigate = (requestedView: string, target: NavigationTarget = {}, replace = false) => {
    const nextView = visibleViewIds.split(",").includes(requestedView) ? requestedView : "overview";
    const viewChanged = nextView !== view;
    const normalizedTarget: NavigationTarget = {
      connection: safeNavigationTarget(target.connection ?? null,"connection") ?? undefined,
      delivery: safeNavigationTarget(target.delivery ?? null,"delivery") ?? undefined,
      ticket: safeNavigationTarget(target.ticket ?? null,"ticket") ?? undefined,
      group: safeNavigationTarget(target.group ?? null, "group") ?? undefined,
      message: target.group ? safeNavigationTarget(target.message ?? null, "message") ?? undefined : undefined,
      workspace: target.workspace === "groups" ? "groups" : canReadReview&&target.workspace==="review"?"review":undefined,
      review: canReadReview?safeNavigationTarget(target.review??null,"review")??undefined:undefined,
    };
    if(normalizedTarget.review){normalizedTarget.workspace="review";normalizedTarget.delivery=undefined}
    if (viewChanged && !confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) return;
    setView(nextView);
    setMobileNavigationOpen(false);
    setQuery("");
    applyNavigationTarget(nextView, normalizedTarget);
    if (typeof window !== "undefined") {
      window.history[replace ? "replaceState" : "pushState"]({ wasalxView: nextView }, "", navigationUrl(window.location.href, nextView, normalizedTarget));
      if (viewChanged || mobileNavigationOpen) focusPageHeading();
    }
  };
  useLayoutEffect(() => {
    const restore = (event?: PopStateEvent) => {
      const requested = new URL(window.location.href).searchParams.get("view") ?? "overview";
      const next = visibleViewIds.split(",").includes(requested) ? requested : "overview";
      if (next !== view && !confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) {
        window.history.pushState({ wasalxView: view }, "", navigationUrl(window.location.href, view, {
          connection: selectedConnectionId ?? undefined,
          delivery: selectedDeliveryId ?? undefined,
          ticket: targetTicketNumber ?? undefined,
          group: targetGroupId ?? undefined,
          message: targetGroupMessageId ?? undefined,
          workspace: view === "inbox" && inboxMode === "groups" ? "groups" : deliveryWorkspace==="review"?"review":undefined,
          review: selectedReviewId??undefined,
        }));
        return;
      }
      setView(next);
      setQuery("");
      const url = new URL(window.location.href);
      const rawTarget={connection:url.searchParams.get("connection"),delivery:url.searchParams.get("delivery"),ticket:url.searchParams.get("ticket"),group:url.searchParams.get("group"),message:url.searchParams.get("message"),workspace:url.searchParams.get("workspace"),review:url.searchParams.get("review")};
      const normalizedTarget:NavigationTarget={connection:safeNavigationTarget(rawTarget.connection,"connection")??undefined,delivery:safeNavigationTarget(rawTarget.delivery,"delivery")??undefined,ticket:safeNavigationTarget(rawTarget.ticket,"ticket")??undefined,group:safeNavigationTarget(rawTarget.group,"group")??undefined,message:rawTarget.group?safeNavigationTarget(rawTarget.message,"message")??undefined:undefined,workspace:rawTarget.workspace==="groups"?"groups":canReadReview&&rawTarget.workspace==="review"?"review":undefined,review:canReadReview?safeNavigationTarget(rawTarget.review,"review")??undefined:undefined};
      if(normalizedTarget.review){normalizedTarget.workspace="review";normalizedTarget.delivery=undefined}
      applyNavigationTarget(next, normalizedTarget);
      const invalidTarget=Object.entries(rawTarget).some(([key,value])=>value!==null&&!normalizedTarget[key as keyof NavigationTarget]);
      if (requested !== next || invalidTarget) {
        window.history.replaceState({ wasalxView: next }, "", navigationUrl(window.location.href,next,normalizedTarget));
      }
      if (event && next !== view) focusPageHeading();
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [applyNavigationTarget, canReadReview, deliveryWorkspace, focusPageHeading, selectedConnectionId, selectedDeliveryId, selectedReviewId, t, targetTicketNumber, targetGroupId, targetGroupMessageId, inboxMode, view, visibleViewIds]);
  const mutationHeaders = useMemo(() => ({
    "content-type": "application/json",
    ...(user.csrfToken ? { "x-wasalx-csrf": user.csrfToken } : {}),
  }), [user.csrfToken]);
  const executeWorkspace = useCallback(async <T,>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const response = await fetch("/api/inbox", { method: "POST", headers: mutationHeaders, signal,
      body: JSON.stringify({ operation, input }) });
    const result = await response.json() as { error?: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(result.error || t("teamsAdmin.failed")), { status: response.status, code: result.code });
    return result as T;
  }, [mutationHeaders, t]);
  const [signingOut, setSigningOut] = useState(false);
  const leavingConfirmed = useRef(false);
  // Unsaved settings drafts mark themselves data-unsaved; warn before a reload, tab close or language switch discards them.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (!leavingConfirmed.current && document.querySelector('[data-unsaved="true"]')) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const signOut = async () => {
    if (signingOut || !confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) return;
    leavingConfirmed.current = true;
    setSigningOut(true);
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        headers: mutationHeaders,
        body: "{}",
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result=await response.json() as {redirectTo?:unknown};
      if(typeof result.redirectTo!=="string")throw operatorLocalFailure(t("common.errors.generic"));
      window.location.assign(result.redirectTo);
    } catch (problem) {
      leavingConfirmed.current = false;
      setSigningOut(false);
      showToast({
        message: operatorFailureMessage(problem, t("common.errors.generic")),
        tone: "error",
      });
    }
  };
  const initialConnectionIds = new Set(liveData.connections.map((connection) => String(connection.id)));
  const connections = [
    ...Object.values(connectionOverrides).filter((connection) => !initialConnectionIds.has(String(connection.id))),
    ...liveData.connections.map((connection) => ({
      ...connection,
      ...connectionOverrides[String(connection.id)],
    })),
  ];
  const connectionActionCount = connections.filter((c) => c.state === "ACTION_REQUIRED" && !isDuplicateIdentityRejection(c.action_reason)).length;
  const assignableConnections = connections.filter((connection) => String(connection.state).toUpperCase() !== "REVOKED");
  const dashboardData = { ...liveData, connections, reviews: openReviews, reviewQueueAvailable };
  const reconcileConnection = useCallback((detail: ConnectionDetailRow) => {
    dashboardLoadFence.current.invalidate();
    setConnectionOverrides((current) => ({
      ...current,
      [detail.id]: {
        id: detail.id,
        name: detail.name,
        provider: detail.provider,
        state: detail.state,
        ...(detail.engine ? { engine: detail.engine } : {}),
        ...((detail.phone_e164 ?? detail.phone) ? { phone: detail.phone_e164 ?? detail.phone } : {}),
        ...(detail.group_count === undefined ? {} : { group_count: detail.group_count }),
        ...(detail.last_provider_event_at ? { last_event_at: detail.last_provider_event_at } : {}),
        last_heartbeat_at: detail.last_heartbeat_at ?? null,
        last_provider_event_at: detail.last_provider_event_at ?? null,
        last_processed_provider_message_at: detail.last_processed_provider_message_at ?? null,
        meta_routing_configuration_ready: detail.meta_routing_configuration_ready ?? false,
        meta_routing_reason: detail.meta_routing_reason ?? null,
        webhook_admission_opened_at: detail.webhook_admission_opened_at ?? null,
        provider_session_state: detail.provider_session_state ?? null,
        provider_state: detail.provider_state ?? null,
        worker_ready: detail.worker_ready ?? false,
        onboarding_working_at: detail.onboarding_working_at ?? null,
        webhook_state: detail.webhook_state ?? null,
        action_reason: detail.action_reason ?? null,
      },
    }));
  }, []);
  const showToast = useCallback((notice: ToastNotice) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(notice);
    if (notice.tone === "success") {
      toastTimer.current = window.setTimeout(() => {
        setToast(null);
        toastTimer.current = null;
      }, 3500);
    }
  }, []);
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem("wasalx.theme"); } catch { stored = null; }
    const explicit = stored === "light" || stored === "dark" ? stored : null;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next=explicit ?? (tenantTheme === "LIGHT" ? "light" : tenantTheme === "DARK" ? "dark" : media.matches ? "dark" : "light");
      setTheme(next);
      rememberBoundaryTheme("tenant",next,false);
    };
    apply();
    if (!explicit && tenantTheme === "SYSTEM") media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [tenantTheme]);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    rememberBoundaryTheme("tenant",next);
  };
  const toggleSidebarPin = () => setSidebarPinned((current) => {
    const next = !current;
    try { window.localStorage.setItem(SIDEBAR_PIN_KEY, String(next)); } catch { /* A blocked layout preference remains session-local. */ }
    return next;
  });
  const switchWorkspace = (tenantId: string) => {
    if (!tenantId || workspaces.find((workspace) => workspace.id === tenantId)?.current) return;
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/auth/login?tenant_id=${encodeURIComponent(tenantId)}&return_to=${encodeURIComponent(returnTo)}`);
  };

  const mutate = (
    url: string,
    body: Record<string, unknown>,
    success: string,
    revision?: string,
  ) => {
    const fingerprint = JSON.stringify([body, revision]);
    const previous = mutations.current.get(url);
    if (previous?.pending || (previous?.fingerprint === fingerprint && previous.completed)) return;
    const operation = previous?.fingerprint === fingerprint ? previous : { fingerprint, key: crypto.randomUUID(), pending: false, completed: false };
    mutations.current.set(url, operation);
    const attempt = async () => {
      if (operation.pending || operation.completed || mutations.current.get(url) !== operation) return;
      operation.pending = true;
      setPendingMutations(current => new Set(current).add(url));
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": operation.key },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw operatorLocalFailure(await apiError(response));
        operation.completed = true;
        showToast({ message: success, tone: "success" });
        await loadDashboard();
      } catch (problem) {
        const detail = operatorFailureMessage(problem, t("common.errors.network"));
        showToast({ message: detail, tone: "error", retry: () => void attempt() });
      } finally {
        operation.pending = false;
        setPendingMutations(current => { const next = new Set(current); next.delete(url); return next; });
      }
    };
    void attempt();
  };

  const title = TENANT_VIEW_TITLES[view] ?? TENANT_VIEW_TITLES.overview!;
  const localizedTitle = [t(title[0]), t(title[1])] as const;
  const pageTitle = localizedTitle[0];
  const documentTitle = expiredSessionReturnTo ? t("tenant.session.expiredTitle") : pageTitle;
  useEffect(() => {
    document.title = `${documentTitle} · WasalX`;
  }, [documentTitle]);
  if (expiredSessionReturnTo) {
    return <SessionExpired returnTo={expiredSessionReturnTo} theme={theme} />;
  }
  return (
    <>
      <div
        ref={applicationRootRef}
        className={theme === "dark" ? "theme-dark" : "theme-light"}
        data-application-ready={shellValidationState==="ready"?"true":"false"}
        data-shell-validation={shellValidationState}
        data-locale={locale}
        lang={locale}
        dir={direction}
      >
      <a className="skip-link" href="#main-content">{t("tenant.accessibility.skipToContent")}</a>
      {runtime==="CONTROL_PLANE"&&shellValidationState!=="ready"?<div className="shell-validation-mask" role={shellValidationState==="failed"?"alert":"status"} aria-live="polite" aria-busy={shellValidationState==="checking"||undefined}>
        <div><span aria-hidden="true" className="brand-mark">W</span><b>{t(shellValidationState==="failed"?"tenant.workspace.verificationFailed":"tenant.workspace.verifyingAccess")}</b>{shellValidationState==="failed"?<><button ref={shellRetryRef} type="button" className="button primary" onClick={()=>void verifyWorkspaces()}>{t("common.actions.retry")}</button><a className="button secondary" href="/auth/login?prompt=login&return_to=/app">{t("tenant.session.signIn")}</a></>:null}</div>
      </div>:null}
      <div className="app-shell" inert={shellValidationState!=="ready"||undefined} aria-hidden={shellValidationState!=="ready"||undefined} data-sidebar-pinned={sidebarPinned} data-mobile-navigation-open={mobileNavigationOpen}>
        <aside ref={sidebarRef} className="sidebar" role={mobileNavigationOpen?"dialog":undefined} aria-modal={mobileNavigationOpen||undefined} aria-label={mobileNavigationOpen?t("tenant.navigation.primary"):undefined}>
          <div className="brand">
            <span className="brand-mark">W</span>
            <span className="brand-name">WasalX</span>
            <button
              type="button"
              className="sidebar-pin"
              aria-label={t(sidebarPinned ? "tenant.sidebar.unpin" : "tenant.sidebar.pin")}
              aria-pressed={sidebarPinned}
              title={t(sidebarPinned ? "tenant.sidebar.unpin" : "tenant.sidebar.pin")}
              onClick={toggleSidebarPin}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5M12 13v8" /></svg>
            </button>
          </div>
          <div className="workspace-switcher" role="group" aria-label={t("tenant.workspace.currentIsolated")} title={String(liveData.tenant.name)}>
            <span className="workspace-avatar" aria-hidden="true">{workspaceInitials}</span>
            <span className="workspace-identity">
              <b>{String(liveData.tenant.name)}</b>
              <small>{t("tenant.workspace.plan", { plan: liveData.tenant.plan === "Managed" ? t("tenant.workspace.planManaged") : liveData.tenant.plan === "Standard" ? t("tenant.workspace.planStandard") : String(liveData.tenant.plan) })}</small>
            </span>
            {workspaceLoadState==="failed"?(
              <span className="workspace-load-error" role="alert"><small>{t("tenant.workspace.loadFailed")}</small><button type="button" className="text-button" onClick={()=>void verifyWorkspaces()}>{t("common.actions.retry")}</button></span>
            ):workspaces.length > 1 ? (
              <details className="workspace-select">
                <summary aria-label={t("tenant.workspace.switch")} title={t("tenant.workspace.switch")} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();event.currentTarget.closest("details")?.removeAttribute("open");event.currentTarget.focus()}}}>
                  <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 8 4 4 4-4"/></svg>
                </summary>
                <div className="workspace-options">
                  {workspaces.map((workspace) => <button key={workspace.id} type="button" aria-label={workspace.name} aria-current={workspace.current?"true":undefined} disabled={workspace.current} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();const details=event.currentTarget.closest("details");details?.removeAttribute("open");details?.querySelector<HTMLElement>("summary")?.focus()}}} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");switchWorkspace(workspace.id)}}><span className="workspace-option-avatar" aria-hidden="true">{initialsFor(workspace.name)}</span><b><bdi dir="auto">{workspace.name}</bdi></b>{workspace.current?<span className="workspace-option-check" aria-hidden="true">✓</span>:null}</button>)}
                </div>
              </details>
            ) : workspaceLoadState==="ready"?<span className="tag">{t("tenant.workspace.isolated")}</span>:null}
          </div>
          <button
            ref={mobileNavigationToggleRef}
            className="mobile-navigation-toggle"
            type="button"
            aria-expanded={mobileNavigationOpen}
            aria-controls="primary-navigation"
            onClick={() => setMobileNavigationOpen((current) => !current)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            <span>{t(mobileNavigationOpen ? "tenant.sidebar.closeNavigation" : "tenant.sidebar.openNavigation")}</span>
          </button>
          <nav id="primary-navigation" aria-label={t("tenant.navigation.primary")}>
          {visibleNavigation.map(([id, key, icon]) => (
              <a
                key={id}
                href={id === "overview" ? "/app" : `/app?view=${encodeURIComponent(id)}`}
                onClick={(event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  navigate(id);
                }}
                className={view === id ? "active" : ""}
                aria-current={view === id ? "page" : undefined}
                aria-label={t(key)}
                title={t(key)}
              >
                <span className="nav-icon">{icon}</span>
                <span className="nav-label">{t(key)}</span>
                {id === "connections" && connectionActionCount ? (
                  <em>{formatNumber(connectionActionCount, locale)}</em>
                ) : null}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
          <div className="system-health">
            <span className={`pulse ${healthTone}`} />
            <span>
              <b>{coreHealthy ? t("tenant.health.coreOperational") : t("tenant.health.coreAttention")}</b>
              <small>{zammadState === "WORKING" ? t("tenant.health.oldestPending", { duration: duration((liveData.health?.deliveries as RecordRow|undefined)?.queue_age_seconds, locale) }) : t("tenant.health.caseAttention")}</small>
              </span>
            </div>
            <div className="profile" role="group" aria-label={t("tenant.profile.signedIn")}>
              <span className="avatar">{userInitials}</span>
              <span>
                <b><bdi dir="auto">{user.displayName}</bdi></b>
                <small>{t(`tenant.role.${role}`)}</small>
              </span>
              <button className="profile-logout text-button" type="button" aria-label={t("tenant.profile.signOut")} title={t("tenant.profile.signOut")} disabled={signingOut} onClick={() => void signOut()}><svg className="profile-logout-mark" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" /></svg><span className="profile-logout-label">{t("tenant.profile.signOut")}</span></button>
            </div>
          </div>
        </aside>

        <main id="main-content" tabIndex={-1} inert={mobileNavigationOpen||undefined}>
          <header className="topbar">
            <button className="breadcrumb" onClick={() => navigate("overview")}>
              <bdi>{String(liveData.tenant.name)}</bdi> <span>/</span> {localizedTitle[0]}
            </button>
            <div className="top-actions">
              <div onClickCapture={() => {
                try { window.sessionStorage.setItem(LOCALE_FOCUS_KEY, "true"); }
                catch { /* The language change still works when session storage is blocked. */ }
              }}>
                <LocaleSwitcher className="top-locale-switcher" locale={locale} label={t("common.locale.label")} errorMessage={t("common.errors.generic")} />
              </div>
              <button
                className="icon-button theme-control"
                aria-label={theme === "dark" ? t("tenant.theme.switchLight") : t("tenant.theme.switchDark")}
                onClick={toggleTheme}
              >
                {theme === "dark" ? "☼" : "◐"}
              </button>
              <NotificationCenter data={dashboardData} navigate={navigate} />
              {canConfigure ? (
                <button
                  className="button primary connect-number-action"
                  type="button"
                  aria-label={t("tenant.connections.connect")}
                  title={t("tenant.connections.connect")}
                  onClick={() => setConnectionModal(true)}
                >
                  <span className="connect-number-action-mark" aria-hidden="true">＋</span>
                  <span className="connect-number-action-label">{t("tenant.connections.connect")}</span>
                </button>
              ) : null}
            </div>
          </header>

          <section className="content">
            <div className="page-heading">
              <div>
                <h1 ref={pageHeadingRef} tabIndex={-1}>{localizedTitle[0]}</h1>
                <p>{localizedTitle[1]}</p>
              </div>
              <span className={`environment ${environment.tone}`}>
                <i /> {environment.label}
              </span>
            </div>
            {runtime === "CONTROL_PLANE" && dashboardFreshness === "stale" ? <div className="connection-detail-alert connection-detail-alert-warning dashboard-refresh-alert" role="status"><span aria-hidden="true">!</span><p>{t("tenant.data.refreshFailed")}</p><button type="button" className="button small" onClick={() => void loadDashboard()}>{t("common.actions.retry")}</button></div> : null}
            {isPrivateDemo ? (
              <div className="demo-boundary" role="status">
                <span aria-hidden="true">◇</span>
                <p>
                  <b>{t("tenant.preview.title")}</b>
                  <small>{t("tenant.preview.body")}</small>
                </p>
              </div>
            ) : null}
            {view === "overview" && (
              <Overview data={dashboardData} navigate={navigate} canReadCases={can(role, "ticket:read")} />
            )}
            {view === "connections" && (
              <><Connections
                rows={connections}
                query={query}
                setQuery={setQuery}
                open={(id) => navigate("connections", { connection: id })}
                canConfigure={canConfigure}
                mutationHeaders={mutationHeaders}
              />
              {!isPrivateDemo&&can(role,"billing:read")?<MetaCostUsage key={String(initialData.tenant.id)} canExport={can(role,"billing:export")}/>:null}</>
            )}
            {view === "groups" && (
              <Groups
                rows={liveData.groups}
                connections={connections}
                query={query}
                setQuery={setQuery}
                toggle={(id, enabled, expectedRevision) =>
                  mutate(
                    `/api/groups/${id}/toggle`,
                    { enabled,expectedRevision },
                    enabled
                      ? t("tenant.groups.activated")
                      : t("tenant.groups.paused"),
                  )
                }
                canToggle={canConfigure}
                canConfigure={canConfigure}
                mutationHeaders={mutationHeaders}
                onSaved={() => {
                  showToast({ message: t("tenant.groups.saved"), tone: "success" });
                  void loadDashboard();
                }}
                reload={() => void loadDashboard()}
              />
            )}
            {view === "rules" && (
              <Rules
                key={String(liveData.tenant.id)}
                rows={liveData.rules}
                groups={liveData.groups}
                mutationHeaders={mutationHeaders}
                canCreate={canConfigure}
                onSaved={() => {
                  showToast({ message: t("tenant.rules.updated"), tone: "success" });
                  void loadDashboard();
                }}
              />
            )}
            {view === "automation" && (
              <Suspense fallback={<WorkspaceLoading />}>
                <BotAutomation
                  key={String(liveData.tenant.id)}
                  canWrite={canConfigure}
                  canOperate={canOperateBot}
                  mutationHeaders={mutationHeaders}
                  connections={assignableConnections}
                  workspaceId={String(liveData.tenant.id)}
                  openTicket={!isPrivateDemo && can(role, "ticket:read") ? ticket => navigate("inbox", { ticket }) : undefined}
                />
              </Suspense>
            )}
            {view === "plugins" && (
              <Suspense fallback={<WorkspaceLoading />}>
                <PluginCatalog
                  canWrite={canConfigure}
                  mutationHeaders={mutationHeaders}
                />
              </Suspense>
            )}
            {view === "routing" && (
              <Suspense fallback={<WorkspaceLoading />}>
                <ClientRouting
                  canWrite={canConfigure}
                  mutationHeaders={mutationHeaders}
                  connections={assignableConnections}
                />
              </Suspense>
            )}
            {view === "inbox" && (
              <Suspense fallback={<WorkspaceLoading />}>
                <InboxWorkspace key={inboxScope} mutationHeaders={mutationHeaders} selectedTicket={targetTicketNumber}
                  mode={inboxMode} selectedGroup={targetGroupId} selectedMessage={targetGroupMessageId}
                  selectGroup={(group, message) => navigate("inbox", { workspace: "groups", ...(group ? { group, message } : {}) })}
                  selectMode={mode => navigate("inbox", mode === "groups" ? { workspace: "groups", ...(targetGroupId ? { group: targetGroupId, message: targetGroupMessageId ?? undefined } : {}) } : targetTicketNumber ? { ticket: targetTicketNumber } : {})}
                  selectTicket={ticket => navigate("inbox", ticket ? { ticket } : {})}
                  canWrite={can(role, "ticket:write")} scope={inboxScope} recoveryScope={inboxRecoveryScope} owner={role === "tenant_owner"} />
              </Suspense>
            )}
            {view === "cases" && (
              <Suspense fallback={<WorkspaceLoading />}>
                <CaseLifecycle
                  key={targetTicketNumber ?? "all-cases"}
                  openTicket={can(role, "ticket:read") ? ticket => navigate("inbox", { ticket }) : undefined}
                  canDetach={canDetachCases}
                  mutationHeaders={mutationHeaders}
                  targetTicketNumber={targetTicketNumber}
                />
              </Suspense>
            )}
            {view === "deliveries" && (
              <Deliveries
                rows={liveData.deliveries}
                canRetry={canRetry}
                canReadReview={canReadReview}
                canReview={canRetry}
                canInspect={!isPrivateDemo}
                canReadContent={canReadDeliveryContent}
                showDiagnostics={role === "auditor"}
                reviewsLoaded={handleReviewsLoaded}
                mutationHeaders={mutationHeaders}
                selectedDeliveryId={selectedDeliveryId}
                selectDelivery={(id) => navigate("deliveries", id ? { delivery: id } : {})}
                mode={deliveryWorkspace}
                selectedReviewId={selectedReviewId}
                selectMode={(mode)=>navigate("deliveries",mode==="review"?{workspace:"review"}:{})}
                selectReview={(id)=>navigate("deliveries",id?{workspace:"review",review:id}:{workspace:"review"})}
                openCase={can(role, "ticket:read") ? (ticket) => navigate("inbox", { ticket }) : undefined}
                retryPending={(id) => pendingMutations.has(`/api/deliveries/${id}/retry`)}
                retry={(id, confirmOutcomeUnknown = false, revision) =>
                  mutate(
                    `/api/deliveries/${id}/retry`,
                    { confirmOutcomeUnknown },
                    t("tenant.deliveries.retryScheduled"),
                    revision,
                  )
                }
              />
            )}
            {view === "team" && (
              <>
              <TeamAccess
                role={role}
                currentUserId={user.userId}
                canManage={canManageTeam}
                mutationHeaders={mutationHeaders}
              />
              {canManageTeam ? <Suspense fallback={<WorkspaceLoading />}>
                <SupportTeams key={inboxScope} execute={executeWorkspace} scope={inboxRecoveryScope} owner={role === "tenant_owner"} />
              </Suspense> : null}
              </>
            )}
            {view === "support" && (
              <SupportAccess
                canApprove={canApproveSupport}
                mutationHeaders={mutationHeaders}
              />
            )}
            {view === "audit" && <Audit rows={liveData.audit} showDiagnostics={role === "auditor"} canExport={canExportAudit} />}
            {view === "settings" && (
              <>
              <Settings key={inboxScope} recoveryScope={inboxRecoveryScope}
                editable={canWriteSettings}
                role={role}
                isPrivateDemo={isPrivateDemo}
                isFixturePreview={runtime === "FIXTURE"}
                mutationHeaders={mutationHeaders}
              />
              {canWriteSettings ? <Suspense fallback={<WorkspaceLoading />}>
                <MailboxAdministration key={inboxScope} execute={executeWorkspace} scope={inboxRecoveryScope} />
              </Suspense> : null}
              </>
            )}
          </section>
        </main>
        {toast && (
          <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"}>
            <span aria-hidden="true">{toast.tone === "error" ? "!" : "✓"}</span>
            <p>{toast.message}</p>
            {toast.retry ? <button className="toast-action" onClick={toast.retry}>{t("tenant.actions.retrySameRequest")}</button> : null}
            <button className="toast-dismiss" aria-label={t("tenant.notifications.dismiss")} onClick={() => setToast(null)}>×</button>
          </div>
        )}
        {connectionModal && (
          <ConnectionModal
            mutationHeaders={mutationHeaders}
            dashboardChanged={loadDashboard}
            close={() => setConnectionModal(false)}
            created={(id) => {
              setConnectionModal(false);
              navigate("connections", { connection: id });
            }}
          />
        )}
        {selectedConnectionId && (
          <ConnectionDetail
            key={selectedConnectionId}
            id={selectedConnectionId}
            tenantId={String(liveData.tenant.id)}
            actorId={user.userId}
            canConfigure={canConfigure}
            canReadSettings={!isPrivateDemo && canReadSettings}
            canWriteSettings={canWriteSettings}
            mutationHeaders={mutationHeaders}
            updated={reconcileConnection}
            close={() => navigate("connections")}
          />
        )}
      </div>
      </div>
    </>
  );
}

function Overview({
  data,
  navigate,
  canReadCases,
}: {
  data: DashboardData;
  navigate: (view: string, target?: NavigationTarget) => void;
  canReadCases: boolean;
}) {
  const { t, locale } = useI18n();
  const working = data.connections.filter((connection) => connectionIsReady(connection)).length;
  const noneWorking = data.connections.length > 0 && working === 0;
  const activeGroups = data.groups.filter((g) => Boolean(g.enabled)).length;
  const failed = data.deliveries.filter((d) =>
    String(d.state).includes("FAILED"),
  ).length;
  const deliveryIssues = issueDeliveries(data).length;
  const successful=data.deliveries.filter((d)=>["SENT","DELIVERED","READ"].includes(String(d.state))).length;
  const success=data.deliveries.length?Math.round(successful/data.deliveries.length*1000)/10:null;
  const health=data.health??{};const deliveryHealth=(health.deliveries as RecordRow|undefined)??{};const inboxHealth=(health.inbox as RecordRow|undefined)??{};const zammadHealth=(health.zammad as RecordRow|undefined)??{};
  const reviewIssues=unmatchedReviews(data).length;const connectionIssues=data.connections.filter(row=>connectionNeedsAttention(row)&&!isDuplicateIdentityRejection(row.action_reason)).length;const zammadState=String(zammadHealth.state??"").toUpperCase();const zammadIssue=Boolean(zammadState)&&zammadState!=="WORKING";const attention=deliveryIssues+reviewIssues+connectionIssues+(zammadIssue?1:0);
  const openAttention = () => {
    const delivery = data.deliveries.find((row) => String(row.state).includes("FAILED") || String(row.state) === "OUTCOME_UNKNOWN");
    const connection = data.connections.find((row) => connectionNeedsAttention(row) && !isDuplicateIdentityRejection(row.action_reason));
    if (delivery) {
      const review=safeNavigationTarget(typeof delivery.outcome_review_id==="string"?delivery.outcome_review_id:null,"review");
      navigate("deliveries",review?{workspace:"review",review}:{delivery:String(delivery.id)});
    }
    else if (reviewIssues) navigate("deliveries",{workspace:"review"});
    else if (connection) navigate("connections", { connection: String(connection.id) });
    else document.getElementById("system-health")?.scrollIntoView({ block: "center" });
  };
  return (
    <>
      <div className="metrics">
        <button onClick={() => navigate("connections")} className="metric">
          <span>
            {t("tenant.overview.workingConnections")} <i className="info" aria-hidden="true">i</i>
          </span>
          <strong>
            {formatNumber(working, locale)}
            <small> / {formatNumber(data.connections.length, locale)}</small>
          </strong>
          <footer>
            <b className={connectionIssues||noneWorking?"warning-text":"positive"}>{connectionIssues?t("tenant.overview.requireAction", { count: formatNumber(connectionIssues, locale) }):noneWorking?t("tenant.health.noWorkingConnections"):t("tenant.overview.healthy")}</b>
            <span>{t("tenant.actions.viewAll")} →</span>
          </footer>
        </button>
        <button onClick={() => navigate("groups")} className="metric">
          <span>
            {t("tenant.overview.activeGroups")} <i className="info" aria-hidden="true">i</i>
          </span>
          <strong>{formatNumber(activeGroups, locale)}</strong>
          <footer>
            <b>{t("tenant.overview.bindingsConfigured", { count: formatNumber(data.groups.filter(group=>group.zammad_group&&group.zammad_group!=="Not configured").length, locale) })}</b>
            <span>{t("tenant.actions.manage")} →</span>
          </footer>
        </button>
        <button onClick={() => navigate("deliveries")} className="metric">
          <span>
            {t("tenant.overview.deliverySuccess")} <i className="info" aria-hidden="true">i</i>
          </span>
          <strong>{success===null?"—":formatNumber(success / 100, locale, { style:"percent", maximumFractionDigits:1 })}</strong>
          <footer>
            <b className="positive">{t("tenant.overview.successfulCount", { count: formatNumber(successful, locale) })}</b>
            <span>{t("tenant.overview.retainedCount", { count: formatNumber(data.deliveries.length, locale) })}</span>
          </footer>
        </button>
        <button
          onClick={openAttention}
          className={`metric ${attention ? "attention" : ""}`}
        >
          <span>
            {t("tenant.overview.needsAttention")} <i className="info" aria-hidden="true">i</i>
          </span>
          <strong>{formatNumber(attention, locale)}</strong>
          <footer>
            <b className={attention?"warning-text":"positive"}>{t(attention?"tenant.status.actionRequired":"tenant.overview.healthy")}</b>
            <span>{t("tenant.actions.resolve")} <span aria-hidden="true">→</span></span>
          </footer>
        </button>
      </div>
      <div className="overview-grid">
        <section className="panel activity-panel">
          <div className="panel-heading">
            <div>
              <h2>{t("tenant.overview.deliveryWindow")}</h2>
              <p>{t("tenant.overview.deliveryWindowDescription")}</p>
            </div>
          </div>
          <div className="health-list"><Health name={t("tenant.status.successful")} value={formatNumber(Number(deliveryHealth.successful??successful),locale)} detail={t("tenant.status.sentDeliveredRead")}/><Health name={t("tenant.status.needsReview")} value={formatNumber(Math.max(Number(deliveryHealth.terminal??failed),deliveryIssues)+reviewIssues,locale)} detail={t("tenant.status.supervisorAction")} warn={Math.max(Number(deliveryHealth.terminal??failed),deliveryIssues)+reviewIssues>0}/><Health name={t("tenant.overview.oldestPendingDelivery")} value={duration(deliveryHealth.queue_age_seconds, locale)} detail={t("tenant.status.pendingSendingRetrying")}/><Health name={t("tenant.overview.totalRetained")} value={formatNumber(Number(deliveryHealth.total??data.deliveries.length),locale)} detail={t("tenant.overview.currentWindow")}/></div>
        </section>
        <section className="panel" id="system-health">
          <div className="panel-heading">
            <div>
              <h2>{t("tenant.health.title")}</h2>
              <p>{t("tenant.health.description")}</p>
            </div>
          </div>
          <div className="health-list">
            <Health name={t("tenant.health.incomingActivity")} value={duration(inboxHealth.queue_age_seconds, locale)} detail={t("tenant.health.oldestAcceptedMessage")} warn={Number(inboxHealth.queue_age_seconds??0)>60}/>
            <Health name={t("tenant.health.caseWorkspace")} value={zammadIssue?t("tenant.status.needsAttention"):t("tenant.status.working")} detail={zammadHealth.last_healthy_at?<><span>{t("tenant.health.lastHealthy")} </span><RelativeTime value={zammadHealth.last_healthy_at} pastOnly/></>:t("tenant.health.noRecentUpdate")} warn={zammadIssue}/>
            <Health name={t("tenant.health.pendingDeliveries")} value={duration(deliveryHealth.queue_age_seconds, locale)} detail={t("tenant.overview.oldestPendingDelivery")} warn={Number(deliveryHealth.queue_age_seconds??0)>60}/>
            <Health name={t("tenant.health.whatsAppConnections")} value={`${formatNumber(working, locale)} / ${formatNumber(data.connections.length, locale)}`} detail={connectionIssues?t("tenant.health.requireRecovery",{count:formatNumber(connectionIssues,locale)}):noneWorking?t("tenant.health.noWorkingConnections"):t("tenant.health.noConnectionIncidents")} warn={connectionIssues>0||noneWorking}/>
          </div>
        </section>
      </div>
      <section className="panel recent">
        <div className="panel-heading">
          <div>
            <h2>{t("tenant.overview.recentDeliveries")}</h2>
            <p>{t("tenant.overview.recentDeliveriesDescription")}</p>
          </div>
          <button
            className="text-button"
            onClick={() => navigate("deliveries")}
          >
            {t("tenant.overview.viewAllDeliveries")} →
          </button>
        </div>
        <DeliveryTable rows={data.deliveries.slice(0, 4)} compact openCase={canReadCases ? (ticket) => navigate("inbox", { ticket }) : undefined} />
      </section>
    </>
  );
}

function Health({
  name,
  value,
  detail,
  warn = false,
}: {
  name: string;
  value: string;
  detail: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="health-row">
      <span className={`health-icon ${warn ? "warn" : ""}`}>
        {warn ? "!" : "✓"}
      </span>
      <span>
        <b>{name}</b>
        <small>{detail}</small>
      </span>
      <strong>{value}</strong>
    </div>
  );
}

function Toolbar({
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

function Connections({
  rows,
  query,
  setQuery,
  open,
  canConfigure,
  mutationHeaders,
}: {
  rows: RecordRow[];
  query: string;
  setQuery: (q: string) => void;
  open: (id: string) => void;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
}) {
  const { t, locale } = useI18n();
  const [provider, setProvider] = useState("ALL");
  const [state, setState] = useState("ALL");
  const providers = [...new Set(rows.map((row) => String(row.provider)))].sort();
  const states = [...new Set(rows.map(connectionDisplayState))].sort();
  // A filter whose option disappeared after a state change falls back to "All" instead of hiding every row.
  const activeProvider = providers.includes(provider) ? provider : "ALL";
  const activeState = states.includes(state) ? state : "ALL";
  const filtered = rows.filter((row) => {
    if (activeProvider !== "ALL" && String(row.provider) !== activeProvider) return false;
    if (activeState !== "ALL" && connectionDisplayState(row) !== activeState) return false;
    return `${row.name} ${row.phone ?? ""} ${row.provider} ${connectionMethod(row.provider, t)}`.toLowerCase().includes(query.toLowerCase());
  });
  return (
    <div className="connections-workspace">
      <section className="panel table-panel" aria-labelledby="messaging-connections-title">
        <div className="panel-heading">
          <div>
            <h2 id="messaging-connections-title">{t("tenant.connections.messagingTitle")}</h2>
            <p>{t("tenant.connections.messagingHelp")}</p>
          </div>
        </div>
        <Toolbar
          query={query}
          setQuery={setQuery}
          placeholder={t("tenant.connections.search")}
        >
          <label className="filter-control"><span className="sr-only">{t("tenant.connections.filterMethod")}</span><select className="filter-button" value={activeProvider} onChange={(event) => setProvider(event.target.value)}><option value="ALL">{t("tenant.connections.allMethods")}</option>{providers.map((value) => <option key={value} value={value}>{String(value).toLowerCase()==="meta"?t("tenant.connections.officialWhatsApp"):t("tenant.connections.linkedDevice")}</option>)}</select></label>
          <label className="filter-control"><span className="sr-only">{t("tenant.connections.filterState")}</span><select className="filter-button" value={activeState} onChange={(event) => setState(event.target.value)}><option value="ALL">{t("tenant.connections.allStates")}</option>{states.map((value) => <option key={value} value={value}>{t(statusPresentation(value)[0])}</option>)}</select></label>
        </Toolbar>
        {filtered.length ? (
          <WideTable>
            <table>
              <thead>
                <tr>
                  <th>{t("tenant.connections.connection")}</th>
                  <th>{t("tenant.connections.method")}</th>
                  <th>{t("tenant.connections.state")}</th>
                  <th>{t("tenant.connections.groups")}</th>
                  <th>{t("tenant.connections.lastEvent")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={String(row.id)}>
                    <td>
                      <div className="cell-main">
                        <span className="provider-logo">
                          {connectionMethod(row.provider, t).slice(0, 1)}
                        </span>
                        <span>
                          <b><bdi>{String(row.name)}</bdi></b>
                          <small className="mono" dir="ltr"><bdi>{row.phone ? String(row.phone) : t("tenant.connection.numberPending")}</bdi></small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <b>{String(row.provider).toLowerCase() === "meta" ? t("tenant.connections.officialWhatsApp") : t("tenant.connections.linkedDevice")}</b>
                      <small>{String(row.provider).toLowerCase() === "meta" ? t("tenant.connections.officialConnection") : t("tenant.connections.linkedAccount")}</small>
                    </td>
                    <td>
                      <Status value={connectionDisplayState(row)} />
                      {connectionDisplayState(row) === "WORKING" && !connectionIsReady(row) ? (
                        <small className="danger-text">{t(String(row.provider).toUpperCase()==="META" && row.meta_routing_configuration_ready!==true
                          ? row.meta_routing_reason==="CONFIGURATION_REQUIRED" ? "tenant.connection.guidance.metaRoutingRequired.title" : "tenant.connection.guidance.metaRoutingHeld.title"
                          : "tenant.connections.inboundNotVerified")}</small>
                      ) : null}
                      {row.action_reason && (row.state !== "PAUSED" || isDuplicateIdentityRejection(row.action_reason)) ? (
                        <small className="danger-text">
                          {t(isDuplicateIdentityRejection(row.action_reason)
                            ? "tenant.connection.guidance.duplicateRemoved.body"
                            : "tenant.connections.actionRequiredBody")}
                        </small>
                      ) : null}
                    </td>
                    <td>{formatNumber(Number(row.group_count ?? 0), locale)}</td>
                    <td><RelativeTime value={row.last_event_at} pastOnly/></td>
                    <td>
                      <button
                        className="button small"
                        onClick={() => open(String(row.id))}
                        aria-label={t("tenant.connections.viewNamed", { name: String(row.name) })}
                      >
                        {t("tenant.actions.viewDetails")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </WideTable>
        ) : (
          <Empty
            title={t("tenant.connections.emptyTitle")}
            body={t("tenant.connections.emptyBody")}
          />
        )}
      </section>
      <Suspense fallback={<WorkspaceLoading />}>
        <ConnectedDataServices canWrite={canConfigure} mutationHeaders={mutationHeaders} />
      </Suspense>
    </div>
  );
}

function ConnectionDetail({
  id,
  tenantId,
  actorId,
  canConfigure,
  canReadSettings,
  canWriteSettings,
  mutationHeaders,
  updated,
  close,
}: {
  id: string;
  tenantId: string;
  actorId: string;
  canConfigure: boolean;
  canReadSettings: boolean;
  canWriteSettings: boolean;
  mutationHeaders: Record<string, string>;
  updated: (detail: ConnectionDetailRow) => void;
  close: () => void;
}) {
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<ConnectionDetailRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectTrigger = useRef<HTMLButtonElement>(null);
  const disconnectInput = useRef<HTMLInputElement>(null);
  const restoreDisconnectFocus = useRef(false);
  useEffect(() => {
    if (disconnecting) disconnectInput.current?.focus();
    else if (restoreDisconnectFocus.current) {
      restoreDisconnectFocus.current = false;
      disconnectTrigger.current?.focus();
    }
  }, [disconnecting]);
  const [confirmation, setConfirmation] = useState("");
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizationNotice, setAuthorizationNotice] = useState<string | { kind: "qr" } | null>(null);
  const [qr, setQr] = useState<QrAuthorization | null>(null);
  const [qrExpanded, setQrExpanded] = useState(false);
  const autoLoadedQrReadyAt = useRef<string | null>(null);
  const autoLoadingQrReadyAt = useRef<string | null>(null);
  const autoQrRetryTimer = useRef<number | null>(null);
  const autoQrActive = useRef(true);
  const refreshGeneration = useRef(0);
  const [qrClock, setQrClock] = useState(() => Date.now());
  const [qrPollAttempt, setQrPollAttempt] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingPhone, setPairingPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [passkeyConfirmationCode, setPasskeyConfirmationCode] = useState<string | null>(null);
  const [passkeyChallenge, setPasskeyChallenge] = useState<PasskeyChallengePayload | null>(null);
  const [manualAssertion, setManualAssertion] = useState("");
  const [advancedPasskeyOpen, setAdvancedPasskeyOpen] = useState(false);
  const [authorizationRetry, setAuthorizationRetry] = useState<AuthorizationRetry | null>(null);
  const [metaCredentialRevision, setMetaCredentialRevision] = useState(0);
  const [metaReconnectOpen, setMetaReconnectOpen] = useState(false);
  const metaReconnectTargetRevoked = useRef(false);
  const [metaReconnectPending, setMetaReconnectPending] = useState(false);
  const [metaNumberReleasePending, setMetaNumberReleasePending] = useState(false);
  const metaReconnectTrigger = useRef<HTMLButtonElement>(null);
  const restoreMetaReconnectFocus = useRef(false);
  useEffect(() => {
    if (!metaReconnectOpen && restoreMetaReconnectFocus.current) {
      restoreMetaReconnectFocus.current = false; metaReconnectTrigger.current?.focus();
    }
  }, [metaReconnectOpen]);
  const [metaGroupsAccepted, setMetaGroupsAccepted] = useState(false);
  const [dirtyDrafts, setDirtyDrafts] = useState<ReadonlySet<"authorization" | "credential" | "reconnect" | "group" | "safety" | "disconnect">>(() => new Set());
  const [retryIntent, setRetryIntent] = useState<{
    action: LifecycleAction;
    key: string;
    body: Record<string, unknown>;
  } | null>(null);
  const setDraftDirty = useCallback((source: "authorization" | "credential" | "reconnect" | "group" | "safety" | "disconnect", dirty: boolean) => {
    setDirtyDrafts((current) => {
      const next = new Set(current);
      if (dirty) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);
  const setSafetyDraftDirty = useCallback((dirty:boolean) => setDraftDirty("safety",dirty),[setDraftDirty]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++refreshGeneration.current;
    try {
      const response = await fetch(`/api/connections/${encodeURIComponent(id)}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        if (generation !== refreshGeneration.current) return;
        if (response.status === 401) {
          const message = await apiError(response);
          setSessionExpired(true);
          setQr(null);
          setQrExpanded(false);
          setAuthorizationError(message);
          setLoadError(message);
          return;
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const nextDetail = (await response.json()) as ConnectionDetailRow;
      if (generation !== refreshGeneration.current) return;
      metaReconnectTargetRevoked.current = nextDetail.provider === "META" && String(nextDetail.state).toUpperCase() === "REVOKED";
      if (metaReconnectTargetRevoked.current) {
        setMetaReconnectOpen(false);
        setDraftDirty("reconnect", false);
        restoreMetaReconnectFocus.current = false;
      }
      setDetail(nextDetail);
      updated(nextDetail);
      setLoadError(null);
      setSessionExpired(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (generation !== refreshGeneration.current) return;
      setLoadError(
        operatorFailureMessage(error, t("tenant.connection.errors.load")),
      );
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [id, t, updated, setDraftDirty]);

  const reload = useCallback(async () => {
    setLoading(true);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    autoQrActive.current = true;
    autoLoadedQrReadyAt.current = null;
    autoLoadingQrReadyAt.current = null;
    if (autoQrRetryTimer.current !== null) window.clearTimeout(autoQrRetryTimer.current);
    autoQrRetryTimer.current = null;
    return () => {
      autoQrActive.current = false;
      if (autoQrRetryTimer.current !== null) window.clearTimeout(autoQrRetryTimer.current);
    };
  }, [id]);

  useEffect(() => {
    const controller = new AbortController();
    const initial = window.setTimeout(() => void refresh(controller.signal), 0);
    return () => {
      controller.abort();
      window.clearTimeout(initial);
    };
  }, [refresh]);
  const runAction = async (
    action: LifecycleAction,
    existingIntent?: typeof retryIntent,
  ) => {
    const intent = existingIntent ?? {
      action,
      key: crypto.randomUUID(),
      body: action === "disconnect" ? { confirmation: "DISCONNECT" }
        : action === "sync" && detail?.provider === "META" && !detail.disclosure_version && metaGroupsAccepted
          ? { eligibilityAccepted: true, eligibilityVersion: "2026-08-09" } : {},
    };
    if (!intent) return;
    setRetryIntent(intent);
    setActionPending(true);
    setActionError(null);
    setNotice(null);
    const path = intent.action === "sync" ? "groups/sync" : intent.action;
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/${path}`,
        {
          method: "POST",
          headers: {
            ...mutationHeaders,
            "idempotency-key": intent.key,
          },
          body: JSON.stringify(intent.body),
        },
      );
      if (!response.ok) {
        const rejection: unknown = await response.clone().json().catch(() => null);
        if (rejection && typeof rejection === "object" && "code" in rejection && rejection.code === "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED") {
          setRetryIntent(null);
          throw operatorLocalFailure(t("tenant.metaSignup.reason.META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED"));
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const accepted = (await response.json()) as {
        operation?: { type?: string; state?: string };
        duplicate?: boolean;
      };
      setNotice(t(
        accepted.duplicate
          ? "tenant.connection.lifecycle.alreadyAccepted"
          : "tenant.connection.lifecycle.accepted",
        { action: t(`tenant.connection.lifecycle.action.${intent.action}`) },
      ));
      setRetryIntent(null);
      if (intent.body.eligibilityAccepted === true) {
        setMetaGroupsAccepted(false);
        setDraftDirty("group", false);
      }
      if (intent.action === "disconnect") {
        setDisconnecting(false);
        setConfirmation("");
        setDraftDirty("disconnect", false);
      }
      await refresh();
    } catch (error) {
      setActionError(
        operatorFailureMessage(error, t("tenant.connection.errors.lifecycle")),
      );
    } finally {
      setActionPending(false);
    }
  };

  const loadQr = useCallback(async (silent = false) => {
    if (!silent) setAuthorizationPending(true);
    // A background freshness poll must not erase a visible failure before it
    // has produced a newer successful provider observation.
    if (!silent) {
      setAuthorizationError(null);
      setAuthorizationNotice(null);
    }
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/qr`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        if (response.status === 401) {
          setSessionExpired(true);
          setQr(null);
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const result = (await response.json()) as QrAuthorization;
      setQr(result);
      setQrClock(Date.now());
      setSessionExpired(false);
      setAuthorizationError(null);
      setAuthorizationRetry(null);
      if (!silent) {
        setAuthorizationNotice({ kind: "qr" });
      }
      return true;
    } catch (error) {
      if (silent) {
        // Re-arm the expiry poll after a transient provider/network failure.
        // Without this tick, the one-shot timer would never run again because
        // the last provider QR object intentionally remains unchanged.
        setQrPollAttempt((attempt) => attempt + 1);
      } else {
        const message = operatorFailureMessage(error, t("tenant.connection.errors.qrLoad"));
        const expiresAt = qr?.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
        const validQrPreserved = Boolean(
          !sessionExpired && qr?.imageDataUrl && !qr.expired && expiresAt > Date.now(),
        );
        setAuthorizationRetry({ kind: "qr" });
        setAuthorizationError(
          validQrPreserved
            ? t("tenant.connection.authorization.qr.lastValidPreserved", { message, expiresAt: exactTimeWithSeconds(qr?.expiresAt, locale, t("tenant.time.invalid")) })
            : message,
        );
      }
      return false;
    } finally {
      if (!silent) setAuthorizationPending(false);
    }
  }, [id, locale, qr, sessionExpired, t]);

  const sendPairingCode = async (intent: Extract<AuthorizationRetry, { kind: "pairing" }>) => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    setAuthorizationRetry(intent);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/pairing-code`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.key },
          body: JSON.stringify({ phoneNumber: intent.phoneNumber }),
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = (await response.json()) as { code: string };
      setPairingCode(result.code);
      setAuthorizationRetry(null);
      setDraftDirty("authorization", false);
      setAuthorizationNotice(t("tenant.connection.authorization.pairing.issued"));
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.pairingRequest")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const recordScanComplete = async () => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/scan-complete`,
        { method: "POST", headers: mutationHeaders, body: "{}" },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = (await response.json()) as { providerWorkingAt?: string | null };
      setAuthorizationNotice(
        result.providerWorkingAt
          ? t("tenant.connection.authorization.scan.connected")
          : t("tenant.connection.authorization.scan.waiting"),
      );
      await refresh();
    } catch (error) {
      setAuthorizationError(operatorFailureMessage(error, t("tenant.connection.errors.scanAcknowledge")));
    } finally {
      setAuthorizationPending(false);
    }
  };

  const requestPairingCode = () => {
    const phoneNumber = pairingPhone.trim();
    if (!/^\+[1-9]\d{5,19}$/.test(phoneNumber.replace(/[\s()-]/g, ""))) {
      setAuthorizationError(t("tenant.connection.authorization.pairing.invalidNumber"));
      return;
    }
    void sendPairingCode({ kind: "pairing", key: crypto.randomUUID(), phoneNumber });
  };

  const sendPasskey = async (intent: Extract<AuthorizationRetry, { kind: "passkey" }>) => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    setAuthorizationRetry(intent);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.key },
          body: JSON.stringify({ assertion: intent.assertion }),
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setAuthorizationRetry(null);
      setDraftDirty("authorization", false);
      setAuthorizationNotice(t("tenant.connection.authorization.passkey.accepted"));
      await refresh();
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.passkeySubmit")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const continuePasskey = async () => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey/challenge`,
        { cache: "no-store" },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const challenge = (await response.json()) as PasskeyChallengePayload;
      if (challenge.rpId !== "web.whatsapp.com") {
        throw operatorLocalFailure(t("tenant.connection.errors.passkeyOrigin"));
      }
      setPasskeyChallenge(challenge);
      const assertion = await signPasskeyWithOfficialExtension(challenge);
      const intent: Extract<AuthorizationRetry, { kind: "passkey" }> = {
        kind: "passkey",
        key: crypto.randomUUID(),
        assertion,
      };
      setAuthorizationPending(false);
      await sendPasskey(intent);
    } catch (error) {
      setAuthorizationError(
        passkeyClientErrorMessage(error, t),
      );
      setAuthorizationPending(false);
    }
  };

  const copyPasskeyChallenge = async () => {
    if (!passkeyChallenge) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(passkeyChallenge, null, 2));
      setAuthorizationNotice(t("tenant.connection.authorization.passkey.challengeCopied"));
      setAuthorizationError(null);
    } catch {
      setAuthorizationError(t("tenant.connection.errors.challengeCopy"));
    }
  };

  const submitManualPasskeyAssertion = () => {
    try {
      const assertion = passkeyAssertionFromUnknown(JSON.parse(manualAssertion));
      void sendPasskey({ kind: "passkey", key: crypto.randomUUID(), assertion });
    } catch {
      setAuthorizationError(t("tenant.connection.errors.assertionInvalid"));
    }
  };

  const loadPasskeyConfirmation = async () => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey/confirmation`,
        { cache: "no-store" },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = (await response.json()) as { code: string };
      setPasskeyConfirmationCode(result.code);
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.confirmationLoad")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const sendPasskeyConfirmation = async (intent: Extract<AuthorizationRetry, { kind: "confirm" }>) => {
    setAuthorizationPending(true);
    setAuthorizationError(null);
    setAuthorizationNotice(null);
    setAuthorizationRetry(intent);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(id)}/auth/passkey/confirm`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.key },
          body: "{}",
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setAuthorizationRetry(null);
      setAuthorizationNotice(t("tenant.connection.authorization.passkey.confirmationAccepted"));
      await refresh();
    } catch (error) {
      setAuthorizationError(
        operatorFailureMessage(error, t("tenant.connection.errors.confirmationSubmit")),
      );
    } finally {
      setAuthorizationPending(false);
    }
  };

  const retryAuthorization = () => {
    if (authorizationRetry?.kind === "qr") void loadQr();
    else if (authorizationRetry?.kind === "pairing") void sendPairingCode(authorizationRetry);
    else if (authorizationRetry?.kind === "passkey") void sendPasskey(authorizationRetry);
    else if (authorizationRetry?.kind === "confirm") void sendPasskeyConfirmation(authorizationRetry);
  };

  const state = String(detail?.state ?? "PROVISIONING").toUpperCase();
  const duplicateIdentity = isDuplicateIdentityRejection(detail?.action_reason);
  const providerState = String(
    detail?.provider_state ?? detail?.provider_session_state ?? "",
  ).toUpperCase();
  const transportReady = detail ? connectionTransportIsReady(detail) : false;
  const inboundReady = detail ? connectionInboundIsReady(detail) : false;
  const routingHeld = String(detail?.provider).toUpperCase()==="META" && detail?.meta_routing_configuration_ready!==true;
  const guidanceState = state === "WORKING" ? !transportReady ? "VERIFYING" : routingHeld
    ? detail?.meta_routing_reason==="CONFIGURATION_REQUIRED" ? "META_ROUTING_REQUIRED" : "META_ROUTING_HELD"
    : !inboundReady ? "AWAITING_INBOUND" : state : state;
  const guidance = duplicateIdentity
    ? state === "REVOKED"
      ? {
          titleKey: "tenant.connection.guidance.duplicateRemoved.title",
          bodyKey: "tenant.connection.guidance.duplicateRemoved.body",
        }
      : {
          titleKey: "tenant.connection.guidance.duplicateDetected.title",
          bodyKey: "tenant.connection.guidance.duplicateDetected.body",
        }
    : guidanceState === "WORKING" && String(detail?.provider).toUpperCase() === "META"
      ? { titleKey: "tenant.connection.health.lastVerification", bodyKey: "tenant.connection.health.lastVerificationPassed" }
    : state === "ACTION_REQUIRED" && String(detail?.provider).toUpperCase() === "META"
      ? { titleKey: "tenant.connection.guidance.actionRequired.title", bodyKey: "tenant.connection.guidance.metaActionRequired.body" }
      : CONNECTION_STATE_GUIDANCE[guidanceState] ?? CONNECTION_STATE_GUIDANCE.PROVISIONING;
  const operationState = String(detail?.latest_operation_state ?? "").toUpperCase();
  const operationPending = ["STAGED", "QUEUED", "RUNNING", "FAILED_RETRYABLE"].includes(
    operationState,
  );
  const metaReconnectReview = state === "PAUSED" || (operationPending && detail?.latest_operation_type === "ROTATE_META_CREDENTIAL");
  const lifecycleTransitionPending =
    operationPending ||
    ["PROVISIONING", "CONNECTING"].includes(state) ||
    (state === "AWAITING_AUTH" && ["", "STARTING", "CONNECTING"].includes(providerState));
  const authorizationHealthState = connectionAuthorizationState(detail ?? {});
  useVisibleRefresh(
    (signal) => refresh(signal),
    !actionPending && !authorizationPending && !metaReconnectPending && !metaNumberReleasePending && !disconnecting
      && (dirtyDrafts.size === 0 || (dirtyDrafts.size === 1 && dirtyDrafts.has("reconnect"))),
    lifecycleTransitionPending ? 2_000 : 30_000,
  );
  const closeGuard = useDialogCloseGuard(
    close,
    actionPending || authorizationPending || metaReconnectPending || metaNumberReleasePending,
    dirtyDrafts.size > 0,
    dirtyDrafts,
  );
  const canStart = ["PAUSED", "FAILED", "ACTION_REQUIRED"].includes(state);
  const canRestart = [
    "AWAITING_AUTH",
    "CONNECTING",
    "WORKING",
    "DEGRADED",
    "ACTION_REQUIRED",
    "FAILED",
    "PAUSED",
  ].includes(state);
  const canPause = [
    "AWAITING_AUTH",
    "CONNECTING",
    "WORKING",
    "DEGRADED",
    "ACTION_REQUIRED",
    "FAILED",
  ].includes(state);
  const syncRecoveryNeeded = (
    String(detail?.latest_operation_type ?? "").toUpperCase() === "SYNC_GROUPS" &&
    operationState === "FAILED_TERMINAL"
  ) || (detail?.provider === "META" && !detail.disclosure_version);
  const canSync = syncRecoveryNeeded && ["WORKING", "DEGRADED"].includes(state);
  const canDisconnect = state !== "REVOKED";
  const scanAcknowledgementNeeded =
    detail?.provider === "WAHA" &&
    detail.onboarding_authorization_method === "QR" &&
    Boolean(detail.onboarding_qr_ready_at) &&
    !detail.onboarding_scan_acknowledged_at &&
    ((state === "AWAITING_AUTH" && providerState === "SCAN_QR_CODE") ||
      (state === "WORKING" &&
        providerState === "WORKING" &&
        Boolean(detail.onboarding_working_at)));
  const authorizationNeeded =
    !duplicateIdentity && detail?.provider === "WAHA" &&
    (Boolean(authorizationError || sessionExpired) || scanAcknowledgementNeeded || Boolean(detail?.onboarding_scan_acknowledged_at && authorizationNotice) ||
      ["AWAITING_AUTH", "ACTION_REQUIRED"].includes(state) ||
      [
        "SCAN_QR_CODE",
        "PASSKEY_REQUIRED",
        "PASSKEY_CONFIRMATION_REQUIRED",
      ].includes(providerState));
  const authorizationReady =
    canConfigure && state === "AWAITING_AUTH" && !operationPending;

  useEffect(() => {
    const clear = window.setTimeout(() => {
      if (providerState !== "SCAN_QR_CODE") {
        setQr(null);
        setQrExpanded(false);
        setPairingCode(null);
        setPairingOpen(false);
      }
      if (providerState !== "PASSKEY_CONFIRMATION_REQUIRED") {
        setPasskeyConfirmationCode(null);
      }
      if (providerState !== "PASSKEY_REQUIRED") {
        setPasskeyChallenge(null);
        setManualAssertion("");
        setAdvancedPasskeyOpen(false);
      }
    }, 0);
    return () => window.clearTimeout(clear);
  }, [providerState]);

  useEffect(() => {
    const qrReadyAt = String(detail?.onboarding_qr_ready_at ?? "");
    if (
      !qrReadyAt ||
      autoLoadedQrReadyAt.current === qrReadyAt ||
      autoLoadingQrReadyAt.current === qrReadyAt ||
      autoQrRetryTimer.current !== null ||
      !canConfigure ||
      state !== "AWAITING_AUTH" ||
      providerState !== "SCAN_QR_CODE" ||
      operationPending ||
      authorizationPending ||
      qr ||
      sessionExpired
    ) return;
    autoLoadingQrReadyAt.current = qrReadyAt;
    void loadQr().then((loaded) => {
      if (!autoQrActive.current) return;
      autoLoadingQrReadyAt.current = null;
      if (loaded) {
        autoLoadedQrReadyAt.current = qrReadyAt;
        return;
      }
      autoQrRetryTimer.current = window.setTimeout(() => {
        autoQrRetryTimer.current = null;
        setQrPollAttempt((attempt) => attempt + 1);
      }, 2_000);
    });
  }, [authorizationPending, canConfigure, detail?.onboarding_qr_ready_at, loadQr, operationPending, providerState, qr, qrPollAttempt, sessionExpired, state]);

  useEffect(() => {
    if (!qr) return;
    const timer = window.setInterval(() => setQrClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [qr]);

  useEffect(() => {
    if (!qr || providerState !== "SCAN_QR_CODE" || sessionExpired) return;
    const expiresAt = qr.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
    const delay = expiresAt > Date.now()
      ? Math.max(1_000, expiresAt - Date.now() + 750)
      : 5_000;
    const timer = window.setTimeout(() => void loadQr(true), delay);
    return () => window.clearTimeout(timer);
  }, [loadQr, providerState, qr, qrPollAttempt, sessionExpired]);

  const qrExpiresAt = qr?.expiresAt ? new Date(qr.expiresAt).getTime() : 0;
  const qrExpired = Boolean(qr && (qr.expired || !qrExpiresAt || qrClock >= qrExpiresAt));
  useEffect(() => {
    const clear = window.setTimeout(() => {
      if (!qr?.imageDataUrl || qrExpired) setQrExpanded(false);
    }, 0);
    return () => window.clearTimeout(clear);
  }, [qr?.imageDataUrl, qrExpired]);
  const lifecycleActionText = (value: unknown) => {
    const action = String(value ?? "").toLowerCase();
    if (action === "verify_meta_billing") return t("tenant.connection.payment.check");
    return t(["start", "restart", "pause", "sync", "disconnect"].includes(action)
      ? `tenant.connection.lifecycle.action.${action}`
      : "tenant.connection.lifecycle.action.operation");
  };
  const connectionReturnTo = `/app?view=connections&connection=${encodeURIComponent(id)}`;
  const signInHref = `/auth/login?return_to=${encodeURIComponent(connectionReturnTo)}`;
  return (
    <ModalDialog
      close={closeGuard.requestClose}
      className="modal-backdrop"
      aria-label={t("tenant.connection.detailsLabel")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeGuard.requestClose();
      }}
    >
      <div className="modal connection-detail-shell" data-unsaved={dirtyDrafts.size > 0 || undefined}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t("tenant.connection.control")}</span>
            <h2>{detail?.name ? <bdi dir="auto">{detail.name}</bdi> : t("tenant.connection.detailsLabel")}</h2>
            <p>
              {detail
                ? <>{connectionMethod(detail.provider, t)} · <bdi dir="ltr">{String(detail.phone_e164 ?? detail.phone ?? t("tenant.connection.numberPending"))}</bdi></>
                : t("tenant.connection.loadingLatestState")}
            </p>
          </div>
          <button type="button" onClick={closeGuard.requestClose} aria-label={t("tenant.connection.closeDetails")}>
            ×
          </button>
        </div>
        <DirtyCloseConfirmation guard={closeGuard} />

        {loading ? (
          <div className="connection-detail-loading" role="status" aria-live="polite">
            <span className="radar">
              <i />
            </span>
            <b>{t("tenant.connection.loadingState")}</b>
            <small>{t("tenant.connection.loadingStateBody")}</small>
          </div>
        ) : loadError && !detail ? (
          <div className="connection-detail-error" role="alert">
            <span className="warning-box">!</span>
            <div>
              <b>{t("tenant.connection.unavailable")}</b>
              <p>{loadError}</p>
              {sessionExpired ? (
                <a className="button small secondary" href={signInHref}>{t("tenant.connection.signInAgain")}</a>
              ) : (
                <button className="button small" onClick={() => void reload()}>
                  {t("common.actions.retry")}
                </button>
              )}
            </div>
          </div>
        ) : detail ? (
          <div className="connection-detail-body">
            {loadError ? (
              <div className="connection-detail-alert connection-detail-alert-warning" role={sessionExpired ? "alert" : "status"}>
                {sessionExpired
                  ? t("tenant.connection.sessionExpiredStatePreserved")
                  : t("tenant.connection.refreshFailedStatePreserved", { message: loadError })}
                {sessionExpired ? (
                  <a className="button small secondary" href={signInHref}>{t("tenant.connection.signInAgain")}</a>
                ) : (
                  <button onClick={() => void refresh()}>{t("tenant.connection.retryRefresh")}</button>
                )}
              </div>
            ) : null}

            <section className="connection-detail-state" aria-labelledby="connection-state-title">
              <div>
                <Status value={state === "WORKING" && !transportReady ? "CONNECTING" : state} />
                <h3 id="connection-state-title">{t(guidance.titleKey)}</h3>
                <p>{t(guidance.bodyKey)}</p>
              </div>
            </section>

            {detail.provider === "META" && state === "REVOKED" && canConfigure && !sessionExpired ? <MetaNumberRelease
              tenantId={tenantId} actorId={actorId} connectionId={id} connectionName={String(detail.name ?? "")} mutationHeaders={mutationHeaders} busyChanged={setMetaNumberReleasePending}
            /> : null}

            {detail.action_reason && (detail.state !== "PAUSED" || duplicateIdentity) ? (
              <div className="connection-detail-alert connection-detail-alert-danger" role="alert">
                <span>!</span>
                <div>
                  <b>{t(duplicateIdentity ? "tenant.connection.duplicateDetails" : "tenant.connection.actionReason")}</b>
                  <p>{t(duplicateIdentity
                    ? state === "REVOKED"
                      ? "tenant.connection.guidance.duplicateRemoved.body"
                      : "tenant.connection.guidance.duplicateDetected.body"
                    : "tenant.errors.connectionReview")}</p>
                </div>
              </div>
            ) : null}

            <section className="connection-detail-section" aria-labelledby="connection-health-title">
              <div className="connection-detail-section-head">
                <div>
                  <h3 id="connection-health-title">{t("tenant.connection.health.title")}</h3>
                  <p>{t("tenant.connection.health.body")}</p>
                </div>
              </div>
              <dl className="connection-detail-facts">
                <div>
                  <dt>{t(String(detail.provider).toUpperCase()==="META" ? "tenant.connection.health.lastVerification" : "tenant.connection.health.lastHealth")}</dt>
                  <dd title={exactTime(detail.last_heartbeat_at, locale, t("tenant.time.invalid"))}>
                    <RelativeTime value={detail.last_heartbeat_at} pastOnly/>
                  </dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.lastConnection")}</dt>
                  <dd title={exactTime(detail.last_provider_event_at, locale, t("tenant.time.invalid"))}>
                    <RelativeTime value={detail.last_provider_event_at} pastOnly/>
                  </dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.managedGroups")}</dt>
                  <dd>{formatNumber(Number(detail.group_count ?? 0), locale)}</dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.secureRoute")}</dt>
                  <dd>{String(detail.webhook_state ?? "").toUpperCase() === "ACTIVE" ? t("tenant.connection.protected") : t("tenant.connection.notReported")}</dd>
                </div>
                <div>
                  <dt>{t("tenant.connection.health.authorization")}</dt>
                  <dd>{authorizationState(authorizationHealthState, t)}</dd>
                </div>
                {detail.onboarding_provider_seconds !== null && detail.onboarding_provider_seconds !== undefined ? (
                  <div>
                    <dt>{t("tenant.connection.health.connectionTime")}</dt>
                    <dd>{t("tenant.connection.seconds", { count: formatNumber(Math.round(Number(detail.onboarding_provider_seconds)), locale) })}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("tenant.connection.health.mode")}</dt>
                  <dd>{t(String(detail.engine).toUpperCase() === "NOWEB" ? "tenant.connection.mode.compatibility" : "tenant.connection.mode.recommended")}</dd>
                </div>
              </dl>
            </section>

            {authorizationNeeded ? (
              <section className="connection-detail-section connection-detail-authorization" aria-labelledby="authorization-title">
                <div className="connection-detail-section-head">
                  <div>
                    <h3 id="authorization-title">{t("tenant.connection.authorization.title")}</h3>
                    <p>{t("tenant.connection.authorization.body")}</p>
                  </div>
                  <span>{authorizationState(authorizationHealthState,t)}</span>
                </div>
                {!canConfigure ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.ownerRequired")}
                  </p>
                ) : operationPending ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.waitForLifecycle")}
                  </p>
                ) : scanAcknowledgementNeeded && state === "WORKING" ? (
                  <div className="connection-detail-auth-step">
                    <div className="connection-detail-note" role="status">
                      <b>{t("tenant.connection.authorization.scan.connectedTitle")}</b>
                      <p>{t("tenant.connection.authorization.scan.connectedBody")}</p>
                      <button
                        className="button small secondary connection-detail-qr-restart"
                        disabled={authorizationPending}
                        onClick={() => void recordScanComplete()}
                      >
                        {t("tenant.connection.authorization.scan.finished")}
                      </button>
                    </div>
                  </div>
                ) : state === "WORKING" && detail.onboarding_scan_acknowledged_at && authorizationNotice ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.scan.recorded")}
                  </p>
                ) : state !== "AWAITING_AUTH" ? (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.unavailableForState", { state: connectionStateText(state, t) })}
                  </p>
                ) : providerState === "SCAN_QR_CODE" ? (
                  <div className="connection-detail-auth-step">
                    {qr && !qrExpired && qr.imageDataUrl ? (
                      <div className="connection-detail-qr" role="group" aria-label={t("tenant.connection.authorization.qr.currentLabel")}>
                        <button
                          type="button"
                          className={`connection-detail-qr-image${qrExpanded ? " is-expanded" : ""}`}
                          aria-expanded={qrExpanded}
                          aria-label={t(qrExpanded ? "tenant.connection.authorization.qr.reduce" : "tenant.connection.authorization.qr.expand")}
                          onClick={() => setQrExpanded((value) => !value)}
                        >
                          {/* A validated, no-store PNG data URL is the only image shape accepted by the API. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={qr.imageDataUrl} alt={t("tenant.connection.authorization.qr.alt")} />
                        </button>
                        <div>
                          <b>{t("tenant.connection.authorization.qr.scanTitle")}</b>
                          <p>{t("tenant.connection.authorization.qr.scanBody")}</p>
                          <div className="connection-detail-qr-expiry">
                            <span>{t("tenant.connection.authorization.qr.sequence", { current: formatNumber(qr.sequence, locale), total: formatNumber(6, locale) })}</span>
                            <time dateTime={qr.expiresAt ?? undefined} title={exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid"))}>
                              {t("tenant.connection.authorization.qr.validFor", { duration: qrCountdown(qrExpiresAt - qrClock, locale) })}
                            </time>
                            <small>{t("tenant.connection.authorization.qr.issued", { time: exactTimeWithSeconds(qr.issuedAt, locale, t("tenant.time.invalid")) })}</small>
                            <small>{t("tenant.connection.authorization.qr.until", { time: exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid")) })}</small>
                          </div>
                          <button
                            className="button small secondary connection-detail-qr-restart"
                            disabled={authorizationPending || Boolean(detail.onboarding_scan_acknowledged_at)}
                            onClick={() => void recordScanComplete()}
                          >
                            {t(detail.onboarding_scan_acknowledged_at ? "tenant.connection.authorization.scan.acknowledged" : "tenant.connection.authorization.scan.finished")}
                          </button>
                        </div>
                      </div>
                    ) : qr ? (
                      <div className="connection-detail-qr connection-detail-qr-expired" role="status" aria-live="polite">
                        <span aria-hidden="true">!</span>
                        <div>
                          <b>{t("tenant.connection.authorization.qr.expiredTitle")}</b>
                          <p>{qr.expiresAt ? t("tenant.connection.authorization.qr.expiredAt", { time: exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid")) }) : t("tenant.connection.authorization.qr.expiredUnknown")}</p>
                          {canConfigure ? (
                            <button
                              className="button small secondary connection-detail-qr-restart"
                              disabled={actionPending || operationPending || sessionExpired}
                              onClick={() => void runAction("restart")}
                            >
                              {t("tenant.connection.authorization.qr.restart")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    <div className="connection-detail-authorization-actions">
                      <button
                        className="button"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => void loadQr()}
                      >
                        {authorizationPending
                          ? t("tenant.connection.authorization.qr.refreshing")
                          : qrExpired
                            ? t("tenant.connection.authorization.qr.checkNew")
                            : qr
                              ? t("tenant.connection.authorization.qr.refresh")
                              : t("tenant.connection.authorization.qr.show")}
                      </button>
                      <button
                        className="button secondary"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => setPairingOpen((value) => !value)}
                      >
                        {t("tenant.connection.authorization.pairing.useInstead")}
                      </button>
                    </div>
                    {pairingOpen ? (
                      <div className="connection-detail-pairing">
                        <label>
                          {t("tenant.connection.authorization.pairing.number")}
                          <input
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            placeholder="+9665XXXXXXXX"
                            value={pairingPhone}
                            onChange={(event) => {
                              setPairingPhone(event.target.value);
                              setDraftDirty("authorization", event.target.value.length > 0);
                            }}
                            disabled={authorizationPending}
                          />
                        </label>
                        <button
                          className="button"
                          disabled={!pairingPhone.trim() || authorizationPending}
                          onClick={requestPairingCode}
                        >
                          {t("tenant.connection.authorization.pairing.request")}
                        </button>
                      </div>
                    ) : null}
                    {pairingCode ? (
                      <div className="connection-detail-auth-code" role="status" aria-live="polite">
                        <small>{t("tenant.connection.authorization.pairing.codeLabel")}</small>
                        <code><bdi dir="ltr">{pairingCode}</bdi></code>
                        <p>{t("tenant.connection.authorization.pairing.codeBody")}</p>
                      </div>
                    ) : null}
                  </div>
                ) : providerState === "PASSKEY_REQUIRED" ? (
                  <div className="connection-detail-auth-step">
                    <p className="connection-detail-note">
                      {t("tenant.connection.authorization.passkey.intro")}
                    </p>
                    <div className="connection-detail-authorization-actions">
                      <button
                        className="button"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => void continuePasskey()}
                      >
                        {t("tenant.connection.authorization.passkey.continueExtension")}
                      </button>
                      <a
                        className="button secondary"
                        href="https://chromewebstore.google.com/detail/ghpdcgnjffaaekflfpcgkgpbafmjldcp"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("tenant.connection.authorization.passkey.installChromium")}
                      </a>
                      <a
                        className="button secondary"
                        href="https://addons.mozilla.org/firefox/addon/whatsapp-browser-extension/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("tenant.connection.authorization.passkey.installFirefox")}
                      </a>
                    </div>
                    <p className="connection-detail-note">
                      {t("tenant.connection.authorization.passkey.extensionBoundary")}
                    </p>
                    <button
                      className="text-button connection-detail-advanced-toggle"
                      onClick={() => setAdvancedPasskeyOpen((value) => !value)}
                    >
                      {t(advancedPasskeyOpen ? "tenant.connection.authorization.passkey.hideAdvanced" : "tenant.connection.authorization.passkey.showAdvanced")}
                    </button>
                    {advancedPasskeyOpen ? (
                      <div className="connection-detail-passkey-advanced">
                        <div className="connection-detail-alert connection-detail-alert-warning">
                          <span>!</span>
                          <div>
                            <b>{t("tenant.connection.authorization.passkey.advancedTitle")}</b>
                            <p>{t("tenant.connection.authorization.passkey.advancedBody")}</p>
                          </div>
                        </div>
                        <ol>
                          <li>{t("tenant.connection.authorization.passkey.stepFetch")}</li>
                          <li>{t("tenant.connection.authorization.passkey.stepSign")}</li>
                          <li>{t("tenant.connection.authorization.passkey.stepPaste")}</li>
                        </ol>
                        <div className="connection-detail-authorization-actions">
                          <button
                            className="button secondary"
                            disabled={!passkeyChallenge || authorizationPending}
                            onClick={() => void copyPasskeyChallenge()}
                          >
                            {t("tenant.connection.authorization.passkey.copyChallenge")}
                          </button>
                          <a
                            className="button secondary"
                            href="https://waha.devlike.pro/blog/waha-passkey/"
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t("tenant.connection.authorization.passkey.openGuide")}
                          </a>
                        </div>
                        {passkeyChallenge ? (
                          <textarea
                            className="connection-detail-challenge"
                            value={JSON.stringify(passkeyChallenge, null, 2)}
                            readOnly
                            aria-label={t("tenant.connection.authorization.passkey.challengeLabel")}
                            spellCheck={false}
                          />
                        ) : null}
                        <label>
                          {t("tenant.connection.authorization.passkey.assertionLabel")}
                          <textarea
                            value={manualAssertion}
                            onChange={(event) => {
                              setManualAssertion(event.target.value);
                              setDraftDirty("authorization", event.target.value.length > 0);
                            }}
                            placeholder={t("tenant.connection.authorization.passkey.assertionPlaceholder")}
                            spellCheck={false}
                            autoComplete="off"
                          />
                        </label>
                        <button
                          className="button"
                          disabled={!manualAssertion.trim() || authorizationPending}
                          onClick={submitManualPasskeyAssertion}
                        >
                          {t("tenant.connection.authorization.passkey.submitAssertion")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : providerState === "PASSKEY_CONFIRMATION_REQUIRED" ? (
                  <div className="connection-detail-auth-step">
                    {passkeyConfirmationCode ? (
                      <div className="connection-detail-auth-code" role="status" aria-live="polite">
                        <small>{t("tenant.connection.authorization.passkey.confirmationCode")}</small>
                        <code><bdi dir="ltr">{passkeyConfirmationCode}</bdi></code>
                        <p>{t("tenant.connection.authorization.passkey.confirmationBody")}</p>
                      </div>
                    ) : null}
                    <div className="connection-detail-authorization-actions">
                      <button
                        className="button secondary"
                        disabled={!authorizationReady || authorizationPending}
                        onClick={() => void loadPasskeyConfirmation()}
                      >
                        {t(passkeyConfirmationCode ? "tenant.connection.authorization.passkey.refreshCode" : "tenant.connection.authorization.passkey.showCode")}
                      </button>
                      <button
                        className="button"
                        disabled={!authorizationReady || !passkeyConfirmationCode || authorizationPending}
                        onClick={() => void sendPasskeyConfirmation({ kind: "confirm", key: crypto.randomUUID() })}
                      >
                        {t("tenant.connection.authorization.passkey.confirmCode")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="connection-detail-note">
                    {t("tenant.connection.authorization.refreshForAction")}
                  </p>
                )}
                {authorizationPending ? (
                  <p className="connection-detail-note" role="status" aria-live="polite">
                    {t("tenant.connection.authorization.completing")}
                  </p>
                ) : null}
                {authorizationNotice ? (
                  <div className="connection-detail-alert connection-detail-alert-success connection-detail-auth-feedback" role="status" aria-live="polite">
                    <span>✓</span>
                    <p>{typeof authorizationNotice === "string" ? authorizationNotice : !qr || qrExpired
                      ? t("tenant.connection.authorization.qr.notReady")
                      : t("tenant.connection.authorization.qr.refreshed", { expiresAt: exactTimeWithSeconds(qr.expiresAt, locale, t("tenant.time.invalid")) })}</p>
                  </div>
                ) : null}
                {authorizationError || sessionExpired ? (
                  <div className="connection-detail-alert connection-detail-alert-danger connection-detail-auth-feedback" role="alert">
                    <span>!</span>
                    <div>
                      <b>{t("tenant.connection.authorization.failedTitle")}</b>
                      <p>{authorizationError ?? t("tenant.connection.authorization.signInRequired")}</p>
                      <div className="connection-detail-inline-actions">
                        {authorizationRetry ? (
                          <button
                            className="button small"
                            disabled={authorizationPending}
                            onClick={retryAuthorization}
                          >
                            {t("tenant.actions.retrySameRequest")}
                          </button>
                        ) : null}
                        {sessionExpired ? (
                          <a className="button small secondary" href={signInHref}>
                            {t("tenant.connection.signInAgain")}
                          </a>
                        ) : null}
                        <button
                          className="text-button"
                          onClick={() => {
                            setAuthorizationError(null);
                            setAuthorizationRetry(null);
                          }}
                        >
                          {t("tenant.connection.dismiss")}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}

            {detail.provider === "WAHA" && canReadSettings ? (
              <WahaGroupInitiationPolicy
                connectionId={id}
                canWrite={canWriteSettings}
                mutationHeaders={mutationHeaders}
                draftChanged={setSafetyDraftDirty}
              />
            ) : null}

            {detail.provider === "META" ? (
              <>
                {!sessionExpired ? <MetaTemplatePreparation connectionId={id} tenantId={tenantId} actorId={actorId} canWrite={canConfigure} mutationHeaders={mutationHeaders} /> : null}
                {!sessionExpired ? <MetaLegacyMigration connectionId={id} tenantId={tenantId} actorId={actorId} canWrite={canConfigure} mutationHeaders={mutationHeaders} /> : null}
                {canConfigure && state !== "REVOKED" ? <div className="connection-detail-section">
                  {metaReconnectOpen && !sessionExpired ? null : <div className="connection-detail-section-head"><div>
                    <h3 id="meta-reconnect-title">{t("tenant.metaSignup.reconnect.title")}</h3>
                    <p>{t("tenant.metaSignup.reconnect.body")}</p>
                  </div></div>}
                  {metaReconnectOpen && !sessionExpired ? <MetaSignup
                    key={id} name={t("tenant.metaSignup.reconnect.title")} target={{ connectionId: id, name: String(detail.name ?? ""), canPrepare: state === "PAUSED" && !operationPending, canContinue: state === "PAUSED" }}
                    isTargetConnectionRevoked={() => metaReconnectTargetRevoked.current}
                    mutationHeaders={mutationHeaders} busyChanged={setMetaReconnectPending}
                    created={() => {
                      setMetaReconnectOpen(false); setDraftDirty("reconnect", false);
                      setMetaCredentialRevision(revision => revision + 1); void refresh();
                      restoreMetaReconnectFocus.current = true;
                    }}
                    back={() => {
                      setMetaReconnectOpen(false); setDraftDirty("reconnect", false);
                      restoreMetaReconnectFocus.current = true;
                    }}
                  /> : <>
                    {metaReconnectReview && !sessionExpired ? <button ref={metaReconnectTrigger} type="button" className="button secondary"
                      disabled={actionPending || authorizationPending || dirtyDrafts.size > 0}
                      onClick={() => { setMetaReconnectOpen(true); setDraftDirty("reconnect", true); }}>
                      {t("tenant.metaSignup.reconnect.open")}
                    </button> : !sessionExpired ? <p role="status">{t("tenant.metaSignup.reason.META_SIGNUP_RECONNECT_PAUSE_REQUIRED")}</p> : null}
                    {dirtyDrafts.size > 0 ? <p>{t("tenant.metaSignup.reconnect.finishChanges")}</p> : null}
                  </>}
                </div> : null}
                {!metaReconnectOpen && state !== "REVOKED" ? <MetaCredentialRotation
                  connectionId={id}
                  canConfigure={canConfigure}
                  mutationHeaders={mutationHeaders}
                  draftChanged={(dirty) => setDraftDirty("credential", dirty)}
                  rotated={async () => {
                    setDraftDirty("credential", false);
                    setMetaCredentialRevision((revision) => revision + 1);
                    await refresh();
                  }}
                /> : null}
                {canConfigure && !sessionExpired ? <MetaCoexistence connectionId={id} mutationHeaders={mutationHeaders} /> : null}
                <MetaBillingDiagnostics key={id} connectionId={id} canConfigure={canConfigure} mutationHeaders={mutationHeaders} refreshKey={metaCredentialRevision} />
                <MetaCustomerPaymentPolicy key={`policy-${tenantId}-${actorId}-${id}`} tenantId={tenantId} actorId={actorId} connectionId={id} canConfigure={canConfigure} mutationHeaders={mutationHeaders} refreshKey={metaCredentialRevision} />
                {!sessionExpired ? <MetaRoutingConfiguration connectionId={id} canConfigure={canConfigure} mutationHeaders={mutationHeaders} /> : null}
                {!metaReconnectOpen ? <MetaSavedAccessActivation connectionId={id} canConfigure={canConfigure} connectionRevoked={state === "REVOKED"}
                  mutationHeaders={mutationHeaders} refreshKey={metaCredentialRevision} changed={refresh}/> : null}
                <MetaOfficialGroups
                  connectionId={id}
                  connectionState={state}
                  canConfigure={canConfigure}
                  mutationHeaders={mutationHeaders}
                  refreshKey={metaCredentialRevision + (detail.disclosure_version ? 1 : 0)}
                  draftChanged={(dirty) => setDraftDirty("group", dirty)}
                  committed={() => setDraftDirty("group", false)}
                />
              </>
            ) : null}

            <section className="connection-detail-section" aria-labelledby="latest-operation-title">
              <div className="connection-detail-section-head">
                <div>
                  <h3 id="latest-operation-title">{t("tenant.connection.latestOperation.title")}</h3>
                  <p>{t("tenant.connection.latestOperation.body")}</p>
                </div>
                {detail.latest_operation_state ? (
                  <Status value={detail.latest_operation_state} />
                ) : null}
              </div>
              {detail.latest_operation_id ? (
                <div className="connection-detail-operation">
                  <span>
                    <small>{t("tenant.connection.latestOperation.operation")}</small>
                    <b>{lifecycleActionText(detail.latest_operation_type)}</b>
                  </span>
                  <span>
                    <small>{t("tenant.connection.latestOperation.attempts")}</small>
                    <b>{formatNumber(Number(detail.latest_operation_attempts ?? 0), locale)}</b>
                  </span>
                  <span>
                    <small>{t("tenant.connection.latestOperation.requested")}</small>
                    <b><RelativeTime value={detail.latest_operation_created_at} pastOnly/></b>
                  </span>
                </div>
              ) : (
                <Empty
                  title={t("tenant.connection.latestOperation.emptyTitle")}
                  body={t("tenant.connection.latestOperation.emptyBody")}
                />
              )}
              {detail.latest_operation_safe_error ? (
                <p className="connection-detail-operation-error" role="alert">
                  {t("tenant.errors.operationUnavailable")}
                </p>
              ) : null}
            </section>

            {notice ? (
              <div className="connection-detail-alert connection-detail-alert-success" role="status" aria-live="polite">
                <span>✓</span>
                <p>{notice}</p>
              </div>
            ) : null}
            {actionError ? (
              <div className="connection-detail-alert connection-detail-alert-danger" role="alert">
                <span>!</span>
                <div>
                  <b>{t("tenant.connection.requestFailedTitle")}</b>
                  <p>{actionError}</p>
                  <div className="connection-detail-inline-actions">
                    {requiresPrivilegedReauthentication(actionError) ? (
                      <a className="button small secondary" href={privilegedStepUpHref(`/app?view=connections&connection=${encodeURIComponent(id)}`)}>
                        {t("tenant.connection.reauthenticate")}
                      </a>
                    ) : null}
                    {retryIntent ? (
                      <button
                        className="button small"
                        disabled={actionPending}
                        onClick={() => void runAction(retryIntent.action, retryIntent)}
                      >
                        {t("tenant.actions.retrySameRequest")}
                      </button>
                    ) : null}
                    <button
                      className="text-button"
                      onClick={() => {
                        setActionError(null);
                        setRetryIntent(null);
                      }}
                    >
                      {t("tenant.connection.dismiss")}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            <section className="connection-detail-section" aria-labelledby="lifecycle-title">
              <div className="connection-detail-section-head">
                <div>
                  <h3 id="lifecycle-title">{t("tenant.connection.lifecycle.title")}</h3>
                  <p>{t("tenant.connection.lifecycle.body")}</p>
                  {detail.provider === "WAHA" ? <p>{t("tenant.connection.lifecycle.automaticGroups")}</p> : null}
                </div>
              </div>
              {duplicateIdentity ? (
                <p className="connection-detail-note">
                  {t("tenant.connection.lifecycle.duplicateDisabled")}
                </p>
              ) : !canConfigure ? (
                <p className="connection-detail-note">
                  {t("tenant.connection.lifecycle.readOnly")}
                </p>
              ) : (
                <div className="connection-detail-lifecycle-actions">
                  <button
                    className="button"
                    disabled={metaReconnectOpen || !canStart || operationPending || actionPending || authorizationPending}
                    onClick={() => void runAction("start")}
                    title={!canStart ? t("tenant.connection.lifecycle.unavailable", { action: t("tenant.connection.lifecycle.action.start"), state: connectionStateText(state, t) }) : undefined}
                  >
                    {t("tenant.connection.lifecycle.action.start")}
                  </button>
                  <button
                    className="button"
                    disabled={metaReconnectOpen || !canRestart || operationPending || actionPending || authorizationPending}
                    onClick={() => void runAction("restart")}
                    title={!canRestart ? t("tenant.connection.lifecycle.unavailable", { action: t("tenant.connection.lifecycle.action.restart"), state: connectionStateText(state, t) }) : undefined}
                  >
                    {t("tenant.connection.lifecycle.action.restart")}
                  </button>
                  <button
                    className="button"
                    disabled={metaReconnectOpen || !canPause || operationPending || actionPending || authorizationPending}
                    onClick={() => void runAction("pause")}
                    title={!canPause ? t("tenant.connection.lifecycle.unavailable", { action: t("tenant.connection.lifecycle.action.pause"), state: connectionStateText(state, t) }) : undefined}
                  >
                    {t("tenant.connection.lifecycle.action.pause")}
                  </button>
                  {detail.provider === "META" && !detail.disclosure_version ? (
                    <label className="check">
                      <input type="checkbox" checked={metaGroupsAccepted}
                        disabled={metaReconnectOpen || operationPending || actionPending || Boolean(retryIntent)}
                        onChange={(event) => { setMetaGroupsAccepted(event.target.checked); setDraftDirty("group", event.target.checked); }} />
                      {t("tenant.setup.review.metaGroupsAccept")}
                    </label>
                  ) : null}
                  {syncRecoveryNeeded ? (
                    <button
                      className="button"
                      disabled={metaReconnectOpen || !canSync || operationPending || actionPending || authorizationPending || (detail.provider === "META" && !detail.disclosure_version && !metaGroupsAccepted)}
                      onClick={() => void runAction("sync")}
                      title={!canSync ? t("tenant.connection.lifecycle.syncUnavailable") : undefined}
                    >
                      {t("tenant.connection.lifecycle.action.sync")}
                    </button>
                  ) : null}
                </div>
              )}
              {operationPending ? (
                <p className="connection-detail-note" role="status">
                  {t("tenant.connection.lifecycle.pending", { action: lifecycleActionText(detail.latest_operation_type), state: connectionStateText(operationState, t) })}
                </p>
              ) : null}
            </section>

            {canConfigure && canDisconnect ? (
              <section className="connection-detail-section connection-detail-danger" aria-labelledby="disconnect-title">
                <div className="connection-detail-section-head">
                  <div>
                    <h3 id="disconnect-title">{t("tenant.connection.disconnect.title")}</h3>
                    <p>{t("tenant.connection.disconnect.body")}</p>
                  </div>
                  {!disconnecting ? (
                    <button
                      className="button connection-detail-danger-button"
                      disabled={metaReconnectOpen || operationPending || actionPending || authorizationPending}
                      ref={disconnectTrigger}
                      onClick={() => setDisconnecting(true)}
                    >
                      {t("tenant.connection.disconnect.open")}
                    </button>
                  ) : null}
                </div>
                {disconnecting ? (
                  <div className="connection-detail-disconnect">
                    <label>
                      {t("tenant.connection.disconnect.typePrefix")} <code>{t("tenant.connection.disconnect.phrase")}</code> {t("tenant.connection.disconnect.typeSuffix")}
                      <input
                        ref={disconnectInput}
                        value={confirmation}
                        onChange={(event) => {
                          setConfirmation(event.target.value);
                          setDraftDirty("disconnect", event.target.value.length > 0);
                        }}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <div>
                      <button
                        className="button secondary"
                        onClick={() => {
                          restoreDisconnectFocus.current = true;
                          setDisconnecting(false);
                          setConfirmation("");
                          setDraftDirty("disconnect", false);
                        }}
                      >
                        {t("common.actions.cancel")}
                      </button>
                      <button
                        className="button connection-detail-danger-button"
                        disabled={metaReconnectOpen || confirmation !== "DISCONNECT" || actionPending || authorizationPending}
                        onClick={() => void runAction("disconnect")}
                      >
                        {t("tenant.connection.disconnect.confirm")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  );
}

type WahaOutboundPolicy={
  connection_id:string;enabled:boolean;inbound_response_only:boolean;allow_human_group_workspace_initiation:boolean;
  response_window_seconds:number;connection_capacity:number;connection_refill_tokens:number;connection_refill_seconds:number;
  number_capacity:number;number_refill_tokens:number;number_refill_seconds:number;minimum_spacing_seconds:number;version:number;
};

function WahaGroupInitiationPolicy({connectionId,canWrite,mutationHeaders,draftChanged}:{connectionId:string;canWrite:boolean;mutationHeaders:Record<string,string>;draftChanged:(dirty:boolean)=>void}){
  const{t}=useI18n();const[policy,setPolicy]=useState<WahaOutboundPolicy|null>(null);const[enabled,setEnabled]=useState(false);const[reason,setReason]=useState("");const[loading,setLoading]=useState(true);const[pending,setPending]=useState(false);const[error,setError]=useState<string|null>(null);const[notice,setNotice]=useState<string|null>(null);const toggleRef=useRef<HTMLButtonElement>(null);const loadGeneration=useRef(0);const saveAttempt=useRef<{fingerprint:string;key:string}|null>(null);
  const dirty=Boolean(policy&&enabled!==policy.allow_human_group_workspace_initiation);
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{const generation=++loadGeneration.current;if(!background)setLoading(true);try{const response=await fetch("/api/waha-outbound-safety",{cache:"no-store",signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const body=await response.json() as{policies?:WahaOutboundPolicy[]};const next=body.policies?.find(item=>item.connection_id===connectionId);if(!next)throw operatorLocalFailure(t("tenant.connection.sendPolicy.unavailable"));if(signal?.aborted||generation!==loadGeneration.current)return;setPolicy(next);setEnabled(next.allow_human_group_workspace_initiation);setReason("");setError(null)}catch(loadError){if(isAbortError(loadError)||signal?.aborted||generation!==loadGeneration.current)return;setError(operatorFailureMessage(loadError, t("tenant.connection.sendPolicy.errors.load")))}finally{if(!background&&generation===loadGeneration.current)setLoading(false)}},[connectionId,t]);
  useEffect(()=>{const controller=new AbortController();const timer=window.setTimeout(()=>void load(false,controller.signal),0);return()=>{controller.abort();window.clearTimeout(timer)}},[load]);
  useVisibleRefresh(signal=>load(true,signal),!dirty&&!pending);
  useEffect(()=>{draftChanged(dirty);return()=>draftChanged(false)},[dirty,draftChanged]);
  const focusAfterSave=useRef(false);
  useEffect(()=>{
    if(!pending&&!dirty&&focusAfterSave.current){
      focusAfterSave.current=false;
      toggleRef.current?.focus({preventScroll:true});
    }
  },[pending,dirty]);
  const restoreToggleFocus=()=>window.requestAnimationFrame(()=>toggleRef.current?.focus({preventScroll:true}));
  const discard=()=>{setEnabled(policy?.allow_human_group_workspace_initiation??false);setReason("");setError(null);setNotice(null);saveAttempt.current=null;restoreToggleFocus()};
  const save=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!policy||!dirty||!canWrite||pending||reason.trim().length<3)return;const body={connectionId,expectedVersion:policy.version,enabled:policy.enabled,inboundResponseOnly:policy.inbound_response_only,allowHumanGroupWorkspaceInitiation:enabled,responseWindowSeconds:policy.response_window_seconds,connectionCapacity:policy.connection_capacity,connectionRefillTokens:policy.connection_refill_tokens,connectionRefillSeconds:policy.connection_refill_seconds,numberCapacity:policy.number_capacity,numberRefillTokens:policy.number_refill_tokens,numberRefillSeconds:policy.number_refill_seconds,minimumSpacingSeconds:policy.minimum_spacing_seconds,reason:reason.trim()};const fingerprint=JSON.stringify(body);if(saveAttempt.current?.fingerprint!==fingerprint)saveAttempt.current={fingerprint,key:crypto.randomUUID()};setPending(true);setError(null);setNotice(null);try{const response=await fetch("/api/waha-outbound-safety",{method:"PATCH",headers:{...mutationHeaders,"idempotency-key":saveAttempt.current.key},body:fingerprint});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as WahaOutboundPolicy;saveAttempt.current=null;setPolicy(next);setEnabled(next.allow_human_group_workspace_initiation);setReason("");setNotice(t("tenant.connection.sendPolicy.saved"));focusAfterSave.current=true}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.connection.sendPolicy.errors.save")))}finally{setPending(false)}};
  return <section className="connection-detail-section" aria-labelledby="waha-send-policy-title"><div className="connection-detail-section-head"><div><h3 id="waha-send-policy-title">{t("tenant.connection.sendPolicy.title")}</h3><p>{t("tenant.connection.sendPolicy.body")}</p></div></div>{loading?<p className="connection-detail-note" role="status">{t("tenant.connection.sendPolicy.loading")}</p>:policy?<form data-unsaved={dirty||undefined} onSubmit={save}><div className="setting-row settings-toggle-row"><span><b>{t("tenant.connection.sendPolicy.initiationTitle")}</b><small id="waha-group-initiation-help">{t("tenant.connection.sendPolicy.initiationBody")}</small></span><button ref={toggleRef} type="button" className={`switch ${enabled?"on":""}`} aria-pressed={enabled} aria-expanded={dirty} aria-controls="waha-send-policy-change" aria-describedby="waha-group-initiation-help" aria-label={t("tenant.connection.sendPolicy.initiationToggle")} disabled={!canWrite||pending} onClick={()=>{setEnabled(value=>!value);setReason("");setError(null);setNotice(null)}}><span/></button></div>{dirty?<div id="waha-send-policy-change" role="status" aria-live="polite"><label htmlFor="waha-send-policy-reason">{t("tenant.connection.sendPolicy.reason")}<input id="waha-send-policy-reason" value={reason} minLength={3} maxLength={500} required dir="auto" aria-describedby="waha-send-policy-reason-help" onChange={event=>setReason(event.target.value)}/><small id="waha-send-policy-reason-help">{t("tenant.connection.sendPolicy.reasonHelp")}</small></label></div>:null}{!canWrite?<p className="connection-detail-note">{t("tenant.connection.sendPolicy.readOnly")}</p>:null}{error?<div className="connection-detail-alert connection-detail-alert-danger" role="alert"><span>!</span><p>{error}</p></div>:null}{notice?<div className="connection-detail-alert connection-detail-alert-success" role="status" aria-live="polite"><span>✓</span><p>{notice}</p></div>:null}{dirty?<div className="connection-detail-inline-actions"><button type="button" className="button secondary" disabled={pending} onClick={discard}>{t("tenant.settings.actions.discard")}</button><button className="button primary" type="submit" disabled={pending||reason.trim().length<3}>{t(pending?"tenant.settings.actions.saving":"tenant.settings.actions.save")}</button></div>:null}</form>:<div className="connection-detail-alert connection-detail-alert-danger" role="alert"><span>!</span><div><b>{t("tenant.connection.sendPolicy.unavailableTitle")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("common.actions.retry")}</button></div></div>}</section>;
}

function MetaCredentialRotation({
  connectionId,
  canConfigure,
  mutationHeaders,
  draftChanged,
  rotated,
}: {
  connectionId: string;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
  draftChanged: (dirty: boolean) => void;
  rotated: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [accessToken, setAccessToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attemptToken, setAttemptToken] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const inputId = `meta-access-token-${connectionId}`;
  const helpId = `${inputId}-help`;

  const replace = async () => {
    const token = attemptToken ?? accessToken;
    if (!canConfigure || token.length < 16 || pending) return;
    setAttemptToken(token);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(connectionId)}/meta/credentials`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": idempotencyKey },
          body: JSON.stringify({ accessToken: token }),
        },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setAccessToken("");
      setAttemptToken(null);
      setIdempotencyKey(crypto.randomUUID());
      setNotice(t("tenant.connection.metaCredential.success"));
      await rotated();
    } catch (requestError) {
      setError(
        operatorFailureMessage(requestError, t("tenant.connection.metaCredential.error")),
      );
    } finally {
      setPending(false);
    }
  };

  const resetAttempt = () => {
    if (pending) return;
    setAccessToken("");
    setAttemptToken(null);
    setIdempotencyKey(crypto.randomUUID());
    setError(null);
    setNotice(null);
    draftChanged(false);
  };

  return (
    <section className="connection-detail-section" aria-labelledby={`${inputId}-title`}>
      <div className="connection-detail-section-head">
        <div>
          <h3 id={`${inputId}-title`}>{t("tenant.connection.metaCredential.title")}</h3>
          <p>{t("tenant.connection.metaCredential.body")}</p>
        </div>
      </div>
      {canConfigure ? (
        <form
          className="meta-credential-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void replace();
          }}
        >
          <label className="meta-token-field" htmlFor={inputId}>
            {t("tenant.connection.metaCredential.label")}
            <small id={helpId}>{t("tenant.connection.metaCredential.help")}</small>
            <input
              id={inputId}
              type="password"
              dir="ltr"
              autoComplete="new-password"
              spellCheck={false}
              required
              minLength={16}
              maxLength={4096}
              aria-describedby={helpId}
              value={accessToken}
              disabled={pending || attemptToken !== null}
              onChange={(event) => {
                setAccessToken(event.target.value);
                draftChanged(event.target.value.length > 0);
              }}
            />
          </label>
          <div className="connection-detail-inline-actions">
            {attemptToken !== null && !pending ? (
              <button className="button secondary" type="button" onClick={resetAttempt}>
                {t("tenant.dialog.discard.confirm")}
              </button>
            ) : null}
            <button
              className="button primary"
              type="submit"
              disabled={pending || accessToken.length < 16}
            >
              {t(pending
                ? "tenant.connection.metaCredential.replacing"
                : attemptToken !== null
                  ? "tenant.actions.retrySameRequest"
                  : "tenant.connection.metaCredential.replace")}
            </button>
          </div>
        </form>
      ) : (
        <p className="connection-detail-note">{t("tenant.connection.metaCredential.readOnly")}</p>
      )}
      {notice ? (
        <div className="connection-detail-alert connection-detail-alert-success meta-groups-feedback" role="status" aria-live="polite">
          <span>✓</span><p>{notice}</p>
        </div>
      ) : null}
      {error ? (
        <div className="connection-detail-alert connection-detail-alert-danger meta-groups-feedback" role="alert">
          <span>!</span>
          <div>
            <b>{t("tenant.connection.metaCredential.errorTitle")}</b>
            <p>{error}</p>
            {requiresPrivilegedReauthentication(error) ? (
              <a className="button small secondary" href={privilegedStepUpHref(`/app?view=connections&connection=${encodeURIComponent(connectionId)}`)}>
                {t("tenant.connection.reauthenticate")}
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

type MetaCapabilityView = MetaGroupsCapability;

function MetaOfficialGroups({
  connectionId,
  connectionState,
  canConfigure,
  mutationHeaders,
  refreshKey,
  draftChanged,
  committed,
}: {
  connectionId: string;
  connectionState: string;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
  refreshKey: number;
  draftChanged: (dirty: boolean) => void;
  committed: () => void;
}) {
  const { locale, t } = useI18n();
  const [capability, setCapability] = useState<MetaCapabilityView | null>(null);
  const [loadingCapability, setLoadingCapability] = useState(false);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [joinApprovalMode, setJoinApprovalMode] = useState<
    "approval_required" | "auto_approve"
  >("approval_required");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);
  const [createKey, setCreateKey] = useState(() => crypto.randomUUID());
  const capabilityRequest = useRef<ReturnType<typeof createReplaceableRequestController> | null>(null);
  const requests = capabilityRequest.current ??= createReplaceableRequestController();

  const loadCapability = useCallback(async () => {
    const controller = requests.begin();
    setLoadingCapability(true);
    setCapabilityError(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(connectionId)}/meta/capabilities`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = (await response.json()) as MetaCapabilityView;
      if (controller.signal.aborted) return;
      setCapability(next);
    } catch (error) {
      if (controller.signal.aborted) return;
      setCapability(null);
      setCapabilityError(
        operatorFailureMessage(error, t("tenant.connection.officialGroups.errors.eligibility")),
      );
    } finally {
      requests.finish(controller);
      if (!controller.signal.aborted) setLoadingCapability(false);
    }
  }, [connectionId, requests, t]);

  useEffect(() => {
    if (connectionState !== "WORKING" && connectionState !== "DEGRADED") return;
    const timer = window.setTimeout(() => void loadCapability(), 0);
    return () => {
      requests.abort();
      window.clearTimeout(timer);
    };
  }, [connectionState, loadCapability, refreshKey, requests]);

  const createGroup = async () => {
    if (!capability?.eligible || !canConfigure || !subject.trim()) return;
    setCreating(true);
    setCreateError(null);
    setCreateNotice(null);
    try {
      const response = await fetch(
        `/api/connections/${encodeURIComponent(connectionId)}/meta/groups`,
        {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": createKey },
          body: JSON.stringify({
            subject: subject.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            joinApprovalMode,
          }),
        },
      );
      if (!response.ok) {
        // The server records a rejected create under its key; a definite rejection needs a fresh key so a corrected retry is not replayed as the same failure.
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) setCreateKey(crypto.randomUUID());
        throw operatorLocalFailure(await apiError(response));
      }
      const accepted = (await response.json()) as {
        requestId?: string;
        duplicate?: boolean;
      };
      setCreateNotice(
        t(accepted.duplicate
          ? "tenant.connection.officialGroups.existingAccepted"
          : "tenant.connection.officialGroups.newAccepted"),
      );
      setSubject("");
      setDescription("");
      setCreateKey(crypto.randomUUID());
      committed();
    } catch (error) {
      setCreateError(
        operatorFailureMessage(error, t("tenant.connection.officialGroups.errors.create")),
      );
    } finally {
      setCreating(false);
    }
  };

  const canProbe = connectionState === "WORKING" || connectionState === "DEGRADED";
  return (
    <section className="connection-detail-section meta-groups-panel" aria-labelledby="meta-groups-title">
      <div className="connection-detail-section-head">
        <div>
          <h3 id="meta-groups-title">{t("tenant.connection.officialGroups.title")}</h3>
          <p>{t("tenant.connection.officialGroups.body")}</p>
        </div>
        {capability ? <Status value={capability.state} /> : null}
      </div>
      {!canProbe ? (
        <p className="connection-detail-note">
          {t("tenant.connection.officialGroups.waitForConnection")}
        </p>
      ) : loadingCapability ? (
        <p className="connection-detail-note" role="status">{t("tenant.connection.officialGroups.verifying")}</p>
      ) : capabilityError ? (
        <div className="connection-detail-alert connection-detail-alert-danger meta-groups-feedback" role="alert">
          <span>!</span>
          <div>
            <b>{t("tenant.connection.officialGroups.unverifiedTitle")}</b>
            <p>{t("tenant.connection.officialGroups.unverifiedBody", { message: capabilityError })}</p>
            <button className="button small" onClick={() => void loadCapability()}>
              {t("tenant.connection.officialGroups.checkAgain")}
            </button>
          </div>
        </div>
      ) : capability?.state === "CONSENT_REQUIRED" ? (
        <p className="connection-detail-note">{t("tenant.connection.officialGroups.consentRequired")}</p>
      ) : capability && !capability.eligible ? (
        <div className="connection-detail-alert connection-detail-alert-warning meta-groups-feedback" role="status">
          <span>!</span>
          <div>
            <b>{t("tenant.connection.officialGroups.unavailableTitle")}</b>
            <p>{t("tenant.connection.officialGroups.unavailableBody")}</p>
            <button className="button small" onClick={() => void loadCapability()}>
              {t("tenant.connection.officialGroups.recheck")}
            </button>
          </div>
        </div>
      ) : capability?.eligible ? (
        <>
          <ul className="meta-constraints" aria-label={t("tenant.connection.officialGroups.constraintsLabel")}>
            <li>{t("tenant.connection.officialGroups.businessAccountRequired")}</li>
            <li>{t("tenant.connection.officialGroups.inviteOnly")}</li>
            <li>{t("tenant.connection.officialGroups.maxParticipants", { count: formatNumber(capability.constraints.maxParticipants, locale) })}</li>
            <li>{t("tenant.connection.officialGroups.unsupportedNumbers")}</li>
          </ul>
          {canConfigure ? (
            <div className="meta-group-form">
              <label>
                {t("tenant.connection.officialGroups.subject")}
                <input
                  dir="auto"
                  value={subject}
                  maxLength={128}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSubject(next);
                    draftChanged(Boolean(next || description || joinApprovalMode !== "approval_required"));
                  }}
                  placeholder={t("tenant.connection.officialGroups.subjectPlaceholder")}
                />
              </label>
              <label>
                {t("tenant.connection.officialGroups.joinApproval")}
                <select
                  value={joinApprovalMode}
                  onChange={(event) => {
                    const next = event.target.value as "approval_required" | "auto_approve";
                    setJoinApprovalMode(next);
                    draftChanged(Boolean(subject || description || next !== "approval_required"));
                  }}
                >
                  <option value="approval_required">{t("tenant.connection.officialGroups.approvalRequired")}</option>
                  <option value="auto_approve">{t("tenant.connection.officialGroups.autoApprove")}</option>
                </select>
              </label>
              <label className="meta-description-field">
                {t("tenant.connection.officialGroups.description")} <small>{t("tenant.connection.optional")}</small>
                <textarea
                  dir="auto"
                  value={description}
                  maxLength={2048}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDescription(next);
                    draftChanged(Boolean(subject || next || joinApprovalMode !== "approval_required"));
                  }}
                  placeholder={t("tenant.connection.officialGroups.descriptionPlaceholder")}
                />
              </label>
              <div className="meta-group-actions">
                <a href={capability.documentationUrl} target="_blank" rel="noreferrer">
                  {t("tenant.connection.officialGroups.requirements")}
                </a>
                <button
                  className="button primary"
                  disabled={creating || !subject.trim()}
                  onClick={() => void createGroup()}
                >
                  {t(creating ? "tenant.connection.officialGroups.requesting" : "tenant.connection.officialGroups.create")}
                </button>
              </div>
            </div>
          ) : (
            <p className="connection-detail-note">{t("tenant.connection.officialGroups.readOnly")}</p>
          )}
          {createNotice ? (
            <div className="connection-detail-alert connection-detail-alert-success meta-groups-feedback" role="status">
              <span>✓</span><p>{createNotice}</p>
            </div>
          ) : null}
          {createError ? (
            <div className="connection-detail-alert connection-detail-alert-danger meta-groups-feedback" role="alert">
              <span>!</span>
              <div>
                <b>{t("tenant.connection.officialGroups.requestFailedTitle")}</b>
                <p>{createError}</p>
                <button className="button small" disabled={creating} onClick={() => void createGroup()}>
                  {t("tenant.actions.retrySameRequest")}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const GROUP_ACTIVATION_CODES=new Set(["CONFIGURATION_REQUIRED","CONNECTION_NOT_WORKING","CONNECTION_OPERATION_PENDING","WEBHOOK_ROUTE_NOT_ACTIVE","PROVIDER_SESSION_NOT_WORKING","WAHA_WORKER_NOT_READY","GROUP_SYNC_STALE","ZAMMAD_NOT_WORKING","RULE_SET_NOT_ACTIVE","NO_ENABLED_RULES","ZAMMAD_ROUTING_NOT_READY","GROUP_BOT_ALREADY_DESIGNATED"]);
const GROUP_ACTIVATION_COPY:Record<string,string>={
  CONFIGURATION_REQUIRED:"tenant.group.configuration.blockers.configuration",
  CONNECTION_NOT_WORKING:"tenant.group.configuration.blockers.connection",
  CONNECTION_OPERATION_PENDING:"tenant.group.configuration.blockers.pendingOperation",
  WEBHOOK_ROUTE_NOT_ACTIVE:"tenant.group.configuration.blockers.webhook",
  PROVIDER_SESSION_NOT_WORKING:"tenant.group.configuration.blockers.session",
  WAHA_WORKER_NOT_READY:"tenant.group.configuration.blockers.worker",
  GROUP_SYNC_STALE:"tenant.group.configuration.blockers.syncStale",
  ZAMMAD_NOT_WORKING:"tenant.group.configuration.blockers.caseWorkspace",
  RULE_SET_NOT_ACTIVE:"tenant.group.configuration.blockers.ruleInactive",
  NO_ENABLED_RULES:"tenant.group.configuration.blockers.noTriggers",
  ZAMMAD_ROUTING_NOT_READY:"tenant.group.configuration.blockers.routingUnverified",
  GROUP_BOT_ALREADY_DESIGNATED:"tenant.group.configuration.blockers.designatedBot",
  READINESS_UNAVAILABLE:"tenant.group.configuration.blockers.readinessUnavailable",
};
function groupActivationCodes(row:RecordRow){
  const raw=Array.isArray(row.activation_blocker_codes)?row.activation_blocker_codes:[];
  const codes=raw.map(String).map(code=>GROUP_ACTIVATION_CODES.has(code)?code:"READINESS_UNAVAILABLE");
  if(row.activation_ready!==true&&!codes.length)codes.push("READINESS_UNAVAILABLE");
  return [...new Set(codes)];
}

function Groups({
  rows,
  connections,
  query,
  setQuery,
  toggle,
  canToggle,
  canConfigure,
  mutationHeaders,
  onSaved,
  reload,
}: {
  rows: RecordRow[];
  connections: RecordRow[];
  query: string;
  setQuery: (q: string) => void;
  toggle: (id: string, enabled: boolean, expectedRevision:number) => void;
  canToggle: boolean;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
  onSaved: () => void;
  reload: () => void;
}) {
  const { locale, t } = useI18n();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupStateOverrides, setGroupStateOverrides] = useState<Record<string, boolean>>({});
  // Bulk results are shown optimistically only until the reloaded rows carry the new state and revisions.
  const [overrideRows, setOverrideRows] = useState(rows);
  if (overrideRows !== rows) { setOverrideRows(rows); setGroupStateOverrides({}); }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [connectionFilter, setConnectionFilter] = useState("all");
  const [bulkAction, setBulkAction] = useState<boolean | null>(null);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkFeedback, setBulkFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [olderRows,setOlderRows]=useState<RecordRow[]>([]);
  const [loadingOlder,setLoadingOlder]=useState(false);
  const [olderError,setOlderError]=useState<string|null>(null);
  const [olderPageAvailable,setOlderPageAvailable]=useState(true);
  const [visibleGroupCount,setVisibleGroupCount]=useState(GROUP_DISPLAY_PAGE_SIZE);
  const [filteredRows,setFilteredRows]=useState<RecordRow[]>([]);
  const [filteredResultKey,setFilteredResultKey]=useState("");
  const [filterError,setFilterError]=useState<string|null>(null);
  const [filterPageAvailable,setFilterPageAvailable]=useState(false);
  const bulkOperation=useRef<{fingerprint:string;key:string}|null>(null);
  const groupFilterFence = useRef(createLatestRequestFence());
  const groupPageFence = useRef(createLatestRequestFence());
  const groupPageController = useRef<AbortController | null>(null);
  const allRows=[...rows,...olderRows.filter(row=>!rows.some(current=>current.id===row.id))];
  const groupRows = allRows.map((row) => {
    const id = String(row.id);
    return Object.hasOwn(groupStateOverrides, id)
      ? { ...row, enabled: groupStateOverrides[id] ? 1 : 0 }
      : row;
  });
  const connectionNames = new Map(connections.map((connection) => [String(connection.id), String(connection.name)]));
  const connectionIds = connections.map((connection) => String(connection.id));
  const remoteFilter=Boolean(query.trim()||connectionFilter!=="all");
  const filterKey=`${query.trim()}\0${connectionFilter}`;
  const filterLoading=remoteFilter&&filteredResultKey!==filterKey;
  useEffect(()=>{
    const filterFence = groupFilterFence.current;
    const pageFence = groupPageFence.current;
    const pageController = groupPageController;
    const request = filterFence.begin();
    pageFence.invalidate();
    pageController.current?.abort();
    queueMicrotask(() => {
      if (filterFence.isCurrent(request)) { setLoadingOlder(false); setOlderError(null); }
    });
    if(!remoteFilter)return()=>{filterFence.invalidate();pageFence.invalidate();pageController.current?.abort()};
    const controller=new AbortController();
    const isCurrent = () => !controller.signal.aborted && filterFence.isCurrent(request);
    const timer=window.setTimeout(()=>{
      setFilterError(null);
      const params=new URLSearchParams({limit:"200"});
      if(query.trim())params.set("q",query.trim());
      if(connectionFilter!=="all")params.set("connection",connectionFilter);
      void fetch(`/api/groups?${params}`,{cache:"no-store",signal:controller.signal})
        .then(async response=>{if(!response.ok)throw operatorLocalFailure(await apiError(response));return response.json() as Promise<RecordRow[]>})
        .then(next=>{if(!isCurrent())return;setFilteredRows(next);setFilterPageAvailable(next.length===200);setFilteredResultKey(filterKey)})
        .catch(problem=>{if(isCurrent()&&!isAbortError(problem)){setFilteredRows([]);setFilterError(operatorFailureMessage(problem, t("common.errors.network")));setFilteredResultKey(filterKey)}});

    },250);
    return()=>{window.clearTimeout(timer);controller.abort();filterFence.invalidate();pageFence.invalidate();pageController.current?.abort()};
  },[connectionFilter,filterKey,query,remoteFilter,rows,t]);
  const filtered = (remoteFilter&&filteredResultKey===filterKey?filteredRows:remoteFilter?[]:groupRows).map((row) => {
    const id=String(row.id);
    return Object.hasOwn(groupStateOverrides,id)?{...row,enabled:groupStateOverrides[id]?1:0}:row;
  });
  const displayedRows=filtered.slice(0,visibleGroupCount);
  const apiPageAvailable=olderRows.length?olderPageAvailable:rows.length===200;
  const canLoadOlder=visibleGroupCount<filtered.length||(remoteFilter?filterPageAvailable:apiPageAvailable);
  const visibleIds = displayedRows.map((row) => String(row.id));
  const allVisibleSelected = Boolean(visibleIds.length) && visibleIds.every((id) => selected.has(id));
  const selectedRows = filtered.filter((row) => selected.has(String(row.id)));
  const selectedActivationCodes=[...new Set(selectedRows.flatMap(groupActivationCodes))];
  const bulkSelectionTooLarge = selected.size > 100;
  const toggleSelection = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleVisible = () => setSelected((current) => {
    const next = new Set(current);
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });
  const loadOlder=async()=>{
    if(visibleGroupCount<filtered.length){setVisibleGroupCount(current=>current+GROUP_DISPLAY_PAGE_SIZE);return}
    const after=(remoteFilter?filteredRows:allRows).at(-1)?.id;if(!after||loadingOlder)return;setLoadingOlder(true);setOlderError(null);
    const request = groupPageFence.current.begin();
    groupPageController.current?.abort();
    const controller = new AbortController();
    groupPageController.current = controller;
    const isCurrent = () => !controller.signal.aborted && groupPageFence.current.isCurrent(request);
    try{const params=new URLSearchParams({limit:"200",after:String(after)});if(remoteFilter&&query.trim())params.set("q",query.trim());if(remoteFilter&&connectionFilter!=="all")params.set("connection",connectionFilter);const response=await fetch(`/api/groups?${params}`,{cache:"no-store",signal:controller.signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as RecordRow[];if(!isCurrent())return;if(remoteFilter){setFilteredRows(current=>[...current,...next.filter(row=>!current.some(item=>item.id===row.id))]);setFilterPageAvailable(next.length===200)}else{setOlderRows(current=>[...current,...next.filter(row=>!current.some(item=>item.id===row.id)&&!rows.some(item=>item.id===row.id))]);setOlderPageAvailable(next.length===200)}setVisibleGroupCount(current=>current+GROUP_DISPLAY_PAGE_SIZE)}
    catch(problem){if(isCurrent()&&!isAbortError(problem))setOlderError(operatorFailureMessage(problem, t("common.errors.network")))}finally{if(isCurrent())setLoadingOlder(false);if(groupPageController.current===controller)groupPageController.current=null}

  };
  const runBulk = async () => {
    if (bulkAction === null || !selected.size || bulkSelectionTooLarge || bulkPending || bulkAction&&selectedActivationCodes.length) return;
    setBulkPending(true);
    setBulkFeedback(null);
    try {
      const expectedRevisions=Object.fromEntries(selectedRows.map(row=>[String(row.id),Number(row.binding_revision)]));
      const fingerprint=JSON.stringify({ids:[...selected].sort(),enabled:bulkAction,expectedRevisions});
      if(bulkOperation.current?.fingerprint!==fingerprint)bulkOperation.current={fingerprint,key:crypto.randomUUID()};
      const response = await fetch("/api/groups/bulk-toggle", {
        method: "POST",
        headers: {...mutationHeaders,"idempotency-key":bulkOperation.current.key},
        body: JSON.stringify({ ids: [...selected], enabled: bulkAction,expectedRevisions }),
      });
      const result = await response.json().catch(() => ({})) as {
        succeeded?: number;
        failed?: number;
        results?: Array<{ id: string; ok: boolean; error?: string }>;
        error?: string;
      };
      if (!response.ok && response.status !== 207) throw new Error(response.status >= 500 ? t("tenant.group.bulk.error") : result.error ?? t("tenant.group.bulk.error"));
      bulkOperation.current=null;
      const succeededIds = new Set((result.results ?? []).filter((item) => item.ok).map((item) => item.id));
      setGroupStateOverrides((current) => {
        const next = { ...current };
        succeededIds.forEach((id) => { next[id] = bulkAction; });
        return next;
      });
      const failed = Number(result.failed ?? 0);
      setBulkFeedback({
        tone: failed ? "error" : "success",
        message: failed
          ? t("tenant.group.bulk.partial", { succeeded: formatNumber(Number(result.succeeded ?? 0), locale), failed: formatNumber(failed, locale) })
          : t(`${bulkAction ? "tenant.group.bulk.activated" : "tenant.group.bulk.paused"}${Number(result.succeeded ?? selected.size) === 1 ? ".one" : ""}`, { count: formatNumber(Number(result.succeeded ?? selected.size), locale) }),
      });
      setSelected(new Set((result.results ?? []).filter((item) => !item.ok).map((item) => item.id)));
      setBulkAction(null);
      reload();
    } catch (problem) {
      setBulkFeedback({ tone: "error", message: operatorFailureMessage(problem, t("tenant.group.bulk.error")) });
    } finally {
      setBulkPending(false);
    }
  };
  return (
    <>
      <section className="panel table-panel">
        <Toolbar
          query={query}
          setQuery={(value)=>{setVisibleGroupCount(GROUP_DISPLAY_PAGE_SIZE);setSelected(new Set());setQuery(value)}}
          placeholder={t("tenant.group.search")}
        >
          <label className="filter-select"><span className="sr-only">{t("tenant.group.filterByConnection")}</span><select value={connectionFilter} onChange={(event) => {setVisibleGroupCount(GROUP_DISPLAY_PAGE_SIZE);setSelected(new Set());setConnectionFilter(event.target.value)}}><option value="all">{t("tenant.group.allConnections")}</option>{connectionIds.map((connection) => <option value={connection} key={connection}>{connectionNames.get(connection) ?? t("tenant.group.connectionUnavailable")}</option>)}</select></label>
        </Toolbar>
        {selected.size && canToggle ? <div className="bulk-action-bar" role="region" aria-label={t("tenant.group.bulk.actionsLabel")}><span><b>{t("tenant.group.bulk.selected", { count: formatNumber(selected.size, locale) })}</b><small>{t("tenant.group.bulk.selectionSummary", { active: formatNumber(selectedRows.filter((row) => Boolean(row.enabled)).length, locale), paused: formatNumber(selectedRows.filter((row) => !row.enabled).length, locale) })}</small>{bulkSelectionTooLarge?<small className="danger-text" role="status">{t("tenant.group.bulk.limit", { count: formatNumber(100, locale) })}</small>:selectedActivationCodes.length?<small className="danger-text">{t("tenant.group.bulk.notReady")}</small>:null}</span><div><button className="button small secondary" onClick={() => setSelected(new Set())}>{t("tenant.group.bulk.clear")}</button><button className="button small secondary" disabled={bulkSelectionTooLarge} onClick={() => setBulkAction(false)}>{t("tenant.group.bulk.pauseSelectedOpen")}</button><button className="button small primary" disabled={bulkSelectionTooLarge||selectedActivationCodes.length>0} onClick={() => setBulkAction(true)}>{t("tenant.group.bulk.activateSelectedOpen")}</button></div></div> : null}
        {bulkFeedback ? <div className={`bulk-feedback ${bulkFeedback.tone}`} role={bulkFeedback.tone === "error" ? "alert" : "status"}><span>{bulkFeedback.tone === "success" ? "✓" : "!"}</span><p>{bulkFeedback.message}</p><button className="text-button" aria-label={t("tenant.group.bulk.dismissLabel")} onClick={() => setBulkFeedback(null)}>{t("tenant.connection.dismiss")}</button></div> : null}
        <WideTable>
          <table>
            <thead>
              <tr>
                {canToggle ? <th className="select-column"><input type="checkbox" checked={allVisibleSelected} aria-label={t(allVisibleSelected ? "tenant.group.selection.clearVisible" : "tenant.group.selection.selectVisible")} onChange={toggleVisible} /></th> : null}
                <th>{t("tenant.group.columns.group")}</th>
                <th>{t("tenant.group.columns.destination")}</th>
                <th>{t("tenant.group.columns.rule")}</th>
                <th>{t("tenant.group.columns.members")}</th>
                <th>{t("tenant.group.columns.lastMessage")}</th>
                <th>{t("tenant.group.columns.active")}</th>
                <th><span className="sr-only">{t("tenant.group.columns.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((row) => {const activationCodes=groupActivationCodes(row);return(
                <tr key={String(row.id)}>
                  {canToggle ? <td className="select-column"><input type="checkbox" checked={selected.has(String(row.id))} aria-label={t("tenant.group.selection.selectNamed", { name: String(row.name) })} onChange={() => toggleSelection(String(row.id))} /></td> : null}
                  <td>
                    <div className="cell-main">
                      <span className="group-logo">#</span>
                      <span>
                        <b><bdi dir="auto">{String(row.name)}</bdi></b>
                        <small><bdi dir="auto">{String(connections.find((connection) => connection.id === row.connection_id)?.name ?? "")}</bdi></small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="tag"><bdi dir="auto">{(() => {
                      return groupDestination(row.zammad_group, t);
                    })()}</bdi></span>
                  </td>
                  <td>
                    <b><bdi dir="auto">{String(row.rule_name) === "Not configured" ? t("tenant.group.destinationNotConfigured") : String(row.rule_name)}</bdi></b>
                  </td>
                  <td>{row.members === null ? <span title={t("tenant.group.membersUnavailable")}>—</span> : Number.isFinite(Number(row.members)) ? formatNumber(Number(row.members), locale) : <bdi dir="auto">{String(row.members)}</bdi>}</td>
                  <td><RelativeTime value={row.last_message_at} pastOnly/></td>
                  <td>
                    <div className="group-activation-control">
                    <button
                      disabled={!canToggle||!row.enabled&&activationCodes.length>0}
                      aria-label={t(row.enabled ? "tenant.group.pauseNamed" : "tenant.group.activateNamed", { name: String(row.name) })}
                      aria-pressed={Boolean(row.enabled)}
                      onClick={() => toggle(String(row.id), !row.enabled,Number(row.binding_revision))}
                      className={`switch ${row.enabled ? "on" : ""}`}
                    >
                      <span />
                    </button>
                    {!row.enabled&&activationCodes[0]?<small>{t(GROUP_ACTIVATION_COPY[activationCodes[0]]!)}</small>:null}
                    </div>
                  </td>
                  <td className="group-row-action">
                    <button
                      type="button"
                      className="button small secondary"
                      aria-label={t(canConfigure ? "tenant.group.configureNamed" : "tenant.group.viewNamed", { name: String(row.name) })}
                      onClick={() => setSelectedGroupId(String(row.id))}
                    >
                      {t(canConfigure ? "tenant.group.configure" : "tenant.group.view")}
                    </button>
                  </td>
                </tr>
              )})}
              {filterLoading ? <tr><td colSpan={canToggle?8:7}><div className="empty-state" role="status">{t("common.status.loading")}</div></td></tr> : null}
              {!filterLoading&&!filtered.length&&!(remoteFilter&&filterError) ? (
                <tr>
                  <td colSpan={canToggle ? 8 : 7}>
                    <Empty
                      title={t(allRows.length ? "tenant.group.empty.noMatchTitle" : "tenant.group.empty.noneTitle")}
                      body={t(allRows.length ? "tenant.group.empty.noMatchBody" : "tenant.group.empty.noneBody")}
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </WideTable>
        {!filterLoading&&canLoadOlder?<div className="audit-pagination"><button className="button secondary" disabled={loadingOlder} onClick={()=>void loadOlder()}>{t(loadingOlder?"tenant.group.loadingOlder":"tenant.group.loadOlder")}</button></div>:null}
        {remoteFilter&&filterError?<p className="audit-load-error" role="alert">{filterError}</p>:null}
        {olderError?<p className="audit-load-error" role="alert">{olderError}</p>:null}
      </section>
      {selectedGroupId ? (
        <GroupConfigurationDrawer
          groupId={selectedGroupId}
          close={() => setSelectedGroupId(null)}
          canConfigure={canConfigure}
          mutationHeaders={mutationHeaders}
          onSaved={onSaved}
        />
      ) : null}
      {bulkAction !== null ? <ModalDialog close={() => setBulkAction(null)} className="modal-backdrop" aria-labelledby="bulk-group-title"><div className="modal bulk-confirm"><div className="modal-head"><div><span className="eyebrow">{t("tenant.group.bulk.eyebrow")}</span><h2 id="bulk-group-title">{t(`${bulkAction ? "tenant.group.bulk.activateTitle" : "tenant.group.bulk.pauseTitle"}${selected.size === 1 ? ".one" : ""}`, { count: formatNumber(selected.size, locale) })}</h2><p>{t(bulkAction ? "tenant.group.bulk.activateBody" : "tenant.group.bulk.pauseBody")}</p></div><button aria-label={t("tenant.group.bulk.cancelLabel")} onClick={() => setBulkAction(null)}>×</button></div><div className="bulk-confirm-list">{selectedRows.slice(0, 5).map((row) => <span key={String(row.id)}><b><bdi dir="auto">{String(row.name)}</bdi></b><small><bdi dir="auto">{groupDestination(row.zammad_group, t)}</bdi></small></span>)}{selectedRows.length > 5 ? <em>{t("tenant.group.bulk.more", { count: formatNumber(selectedRows.length - 5, locale) })}</em> : null}</div><div className="modal-actions"><button className="button secondary" disabled={bulkPending} onClick={() => setBulkAction(null)}>{t("common.actions.cancel")}</button><button className={bulkAction ? "button primary" : "button connection-detail-danger-button"} disabled={bulkPending||bulkAction&&selectedActivationCodes.length>0} onClick={() => void runBulk()}>{t(bulkPending ? "tenant.group.bulk.updating" : bulkAction ? "tenant.group.bulk.activateSelected" : "tenant.group.bulk.pauseSelected")}</button></div></div></ModalDialog> : null}
    </>
  );
}

type GroupRuleSetOption = {
  id: string;
  name: string;
  version: number;
  state: string;
  enabled_rule_count: number;
};

type GroupConfigurationDetail = RecordRow & {
  id: string;
  display_name?: string;
  provider_display_name?: string;
  external_group_id?: string;
  provider?: string;
  phone_e164?: string;
  connection_state?: string;
  zammad_state?: string | null;
  working_session_count?: number;
  rule_set_id?: string | null;
  zammad_group_id?: string | null;
  default_priority?: string | null;
  assignment_mode?: string | null;
  fixed_owner_id?: string | null;
  sla_policy_id?: string | null;
  business_hours_mode?: string | null;
  business_hours_calendar_id?: string | null;
  ticket_events_managed?: { reference_received: boolean; before_agent_reply: boolean };
  acknowledgement_template?: string | null;
  agent_prefix?: string | null;
  agent_identity_placement?: "HEADER" | "FOOTER" | "OFF" | null;
  max_identifiers?: number | null;
  media_enabled?: boolean | null;
  retention_days?: number | null;
  binding_state?: string | null;
  binding_revision?: number | null;
  available_rule_sets?: GroupRuleSetOption[];
};

type GroupConfigurationForm = {
  displayName: string;
  ruleSetId: string;
  zammadGroupId: string;
  defaultPriority: "low" | "normal" | "high";
  assignmentMode: "zammad_auto" | "fixed_owner" | "unassigned";
  fixedOwnerId: string;
  slaPolicyId: string;
  businessHoursMode: "ALWAYS" | "ZAMMAD_CALENDAR";
  businessHoursCalendarId: string;
  acknowledgementTemplate: string;
  agentPrefix: string;
  agentIdentityPlacement: "HEADER" | "FOOTER" | "OFF";
  maxIdentifiers: string;
  mediaEnabled: boolean;
  retentionDays: string;
  state: "DRAFT" | "ACTIVE" | "PAUSED";
};

type GroupHistoryDetail = {
  capture_enabled: boolean;
  enabled_at: string | null;
  retention_days: number;
  visibility: "RESTRICTED" | "ALL_AGENTS";
  agent_prefix: string;
  agent_identity_placement: "HEADER" | "FOOTER" | "OFF";
  version: number;
  group_workspace_enabled: boolean;
  grants: Array<{ id: string; subject_type: "USER" | "TEAM"; subject_external_id: string }>;
};
type GroupHistoryForm = { captureEnabled: boolean; retentionDays: string; visibility: "RESTRICTED" | "ALL_AGENTS"; agentPrefix: string; agentIdentityPlacement: "HEADER" | "FOOTER" | "OFF" };

function groupHistoryFormFromDetail(detail: Partial<GroupHistoryDetail>): GroupHistoryForm | null {
  const retentionDays = Number(detail.retention_days);
  if (
    typeof detail.capture_enabled !== "boolean" ||
    !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650 ||
    !["RESTRICTED", "ALL_AGENTS"].includes(String(detail.visibility)) ||
    typeof detail.agent_prefix !== "string" ||
    !["HEADER", "FOOTER", "OFF"].includes(String(detail.agent_identity_placement))
  ) return null;
  return {
    captureEnabled: detail.capture_enabled,
    retentionDays: String(retentionDays),
    visibility: detail.visibility as GroupHistoryForm["visibility"],
    agentPrefix: detail.agent_prefix,
    agentIdentityPlacement: detail.agent_identity_placement as GroupHistoryForm["agentIdentityPlacement"],
  };
}

type ZammadRoutingCatalog = {
  instanceId: string;
  fetchedAt: string;
  expiresAt: string;
  groups: Array<{ id: string; name: string; active: boolean; serviceIdentityCanCreate: boolean }>;
  owners: Array<{ id: string; name: string; login: string; active: boolean; groupIds: string[] }>;
  slas: Array<{ id: string; name: string; active: boolean; calendarId?: string }>;
  calendars: Array<{ id: string; name: string; active: boolean; timezone?: string }>;
};

type RoutingSelectOption = { value: string; label: string; description?: string; disabled?: boolean };

function RoutingCatalogSelect({
  id,
  label: fieldLabel,
  value,
  options,
  onChange,
  disabled,
  optional = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  options: RoutingSelectOption[];
  onChange: (value: string) => void;
  disabled: boolean;
  optional?: boolean;
  placeholder: string;
}) {
  const { locale, t } = useI18n();
  const selected = options.find((option) => option.value === value);
  const [search, setSearch] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = `${id}-options`;
  const query = search ?? selected?.label ?? (value && options.length ? t("tenant.group.routing.unavailableSelection") : "");
  const filtered = options.filter((option) => {
    const language = locale === "ar" ? "ar-SA" : "en-US";
    const needle = query.trim().toLocaleLowerCase(language);
    return !needle || `${option.label} ${option.description ?? ""}`.toLocaleLowerCase(language).includes(needle);
  });

  const choose = (option: RoutingSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setSearch(null);
    setOpen(false);
  };

  return (
    <div className="routing-catalog-field">
      <label htmlFor={id}>{fieldLabel}{optional ? <small>{t("tenant.group.routing.optional")}</small> : null}</label>
      <div className="routing-combobox">
        <input
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && filtered[activeIndex] ? `${listId}-${filtered[activeIndex].value}` : undefined}
          autoComplete="off"
          dir="auto"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => { setSearch(""); setOpen(true); setActiveIndex(0); }}
          onBlur={() => window.setTimeout(() => { setOpen(false); setSearch(null); }, 100)}
          onChange={(event) => { setSearch(event.target.value); setOpen(true); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.max(0, Math.min(filtered.length - 1, index + 1))); }
            if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
            if (event.key === "Enter" && open && filtered[activeIndex]) { event.preventDefault(); choose(filtered[activeIndex]); }
            if (event.key === "Escape") { event.preventDefault(); setOpen(false); setSearch(null); }
          }}
        />
        {optional && value && !disabled ? <button type="button" className="routing-combobox-clear" onClick={() => onChange("")} aria-label={t("tenant.group.routing.clear", { field: fieldLabel })}>×</button> : null}
        {open && !disabled ? (
          <div id={listId} className="routing-combobox-options" role="listbox" aria-label={t("tenant.group.routing.options", { field: fieldLabel })}>
            {filtered.length ? filtered.map((option, index) => (
              <button
                id={`${listId}-${option.value}`}
                key={option.value}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={index === activeIndex ? "is-active" : undefined}
                disabled={option.disabled}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
              >
                <span><bdi dir="auto">{option.label}</bdi></span><small>{option.description ?? t("tenant.group.routing.available")}</small>
              </button>
            )) : <p role="status">{t("tenant.group.routing.noMatches")}</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function groupFormFromDetail(detail: GroupConfigurationDetail): GroupConfigurationForm {
  return {
    displayName: String(detail.display_name ?? detail.provider_display_name ?? ""),
    ruleSetId: String(detail.rule_set_id ?? ""),
    zammadGroupId: String(detail.zammad_group_id ?? ""),
    defaultPriority: (["low", "normal", "high"].includes(String(detail.default_priority))
      ? String(detail.default_priority)
      : "normal") as GroupConfigurationForm["defaultPriority"],
    assignmentMode: (["zammad_auto", "fixed_owner", "unassigned"].includes(String(detail.assignment_mode))
      ? String(detail.assignment_mode)
      : "zammad_auto") as GroupConfigurationForm["assignmentMode"],
    fixedOwnerId: String(detail.fixed_owner_id ?? ""),
    slaPolicyId: String(detail.sla_policy_id ?? ""),
    businessHoursMode: (detail.business_hours_mode === "ZAMMAD_CALENDAR" ? "ZAMMAD_CALENDAR" : "ALWAYS"),
    businessHoursCalendarId: String(detail.business_hours_calendar_id ?? ""),
    acknowledgementTemplate: String(detail.acknowledgement_template ?? "Case {{tickets}} is now being tracked by WasalX."),
    agentPrefix: String(detail.agent_prefix ?? "Support"),
    agentIdentityPlacement: (["HEADER", "FOOTER", "OFF"].includes(String(detail.agent_identity_placement))
      ? String(detail.agent_identity_placement)
      : "HEADER") as GroupConfigurationForm["agentIdentityPlacement"],
    maxIdentifiers: String(detail.max_identifiers ?? 20),
    mediaEnabled: detail.media_enabled == null ? true : Boolean(detail.media_enabled),
    retentionDays: String(detail.retention_days ?? 30),
    state: (["DRAFT", "ACTIVE", "PAUSED"].includes(String(detail.binding_state))
      ? String(detail.binding_state)
      : "DRAFT") as GroupConfigurationForm["state"],
  };
}

function GroupConfigurationDrawer({
  groupId,
  close,
  canConfigure,
  mutationHeaders,
  onSaved,
}: {
  groupId: string;
  close: () => void;
  canConfigure: boolean;
  mutationHeaders: Record<string, string>;
  onSaved: () => void;
}) {
  const { locale, t } = useI18n();
  const renderedAt = useRelativeClock();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [detail, setDetail] = useState<GroupConfigurationDetail | null>(null);
  const [form, setForm] = useState<GroupConfigurationForm | null>(null);
  const [savedForm, setSavedForm] = useState<GroupConfigurationForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [routingCatalog, setRoutingCatalog] = useState<ZammadRoutingCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [history, setHistory] = useState<GroupHistoryDetail | null>(null);
  const [historyForm, setHistoryForm] = useState<GroupHistoryForm | null>(null);
  const [savedHistoryForm, setSavedHistoryForm] = useState<GroupHistoryForm | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historySaving, setHistorySaving] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [grantType, setGrantType] = useState<"USER" | "TEAM">("TEAM");
  const [grantSubject, setGrantSubject] = useState("");
  const [grantPending, setGrantPending] = useState(false);
  const historySaveKey = useRef<string | null>(null);
  const bindingSaveIntent=useRef<{fingerprint:string;key:string}|null>(null);
  const grantOperationKeys = useRef(new Map<string, string>());
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/binding`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const nextDetail = await response.json() as GroupConfigurationDetail;
      const baseForm = groupFormFromDetail(nextDetail);
      const nextForm = {
        ...baseForm,
        acknowledgementTemplate: nextDetail.acknowledgement_template == null
          ? t("tenant.group.configuration.defaultAcknowledgement")
          : baseForm.acknowledgementTemplate,
        agentPrefix: nextDetail.agent_prefix == null
          ? t("tenant.group.configuration.defaultAgentPrefix")
          : baseForm.agentPrefix,
      };
      setDetail(nextDetail);
      setForm(nextForm);
      setSavedForm(nextForm);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(operatorFailureMessage(error, t("tenant.group.configuration.errors.load")));
    } finally {
      setLoading(false);
    }
  }, [groupId, t]);

  const loadCatalog = useCallback(async (signal?: AbortSignal, background = false) => {
    // Background refreshes keep the routing fields enabled so an operator's selection is not interrupted.
    if (!background) { setCatalogLoading(true); setCatalogError(null); }
    try {
      const response = await fetch("/api/zammad/routing-catalogs", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setRoutingCatalog(await response.json() as ZammadRoutingCatalog);
      setCatalogError(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setCatalogError(operatorFailureMessage(error, t("tenant.group.configuration.errors.routingLoad")));
    } finally {
      if (!background) setCatalogLoading(false);
    }
  }, [t]);

  const loadHistory = useCallback(async (background = false, signal?: AbortSignal) => {
    if (!background) setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await fetch(`/api/group-workspace/groups/${encodeURIComponent(groupId)}`, { cache: "no-store", signal });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as Partial<GroupHistoryDetail>;
      const nextForm = groupHistoryFormFromDetail(next);
      const grantsValid = Array.isArray(next.grants) && next.grants.every((grant) =>
        typeof grant?.id === "string" &&
        ["USER", "TEAM"].includes(String(grant.subject_type)) &&
        typeof grant.subject_external_id === "string",
      );
      if (
        !nextForm || !Number.isInteger(next.version) ||
        typeof next.group_workspace_enabled !== "boolean" ||
        !(next.enabled_at === null || typeof next.enabled_at === "string") ||
        !grantsValid
      ) throw operatorLocalFailure(t("tenant.group.history.errors.load"));
      setHistory(next as GroupHistoryDetail); setHistoryForm(nextForm); setSavedHistoryForm(nextForm);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHistoryError(operatorFailureMessage(error, t("tenant.group.history.errors.load")));
    } finally { if (!background) setHistoryLoading(false); }
  }, [groupId, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal);
      void loadCatalog(controller.signal);
      void loadHistory(false, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, loadCatalog, loadHistory]);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  const bindingDirty = Boolean(form && savedForm && JSON.stringify(form) !== JSON.stringify(savedForm));
  const historyDirty = Boolean(historyForm && savedHistoryForm && JSON.stringify(historyForm) !== JSON.stringify(savedHistoryForm));
  const dirty = bindingDirty || historyDirty;
  useVisibleRefresh((signal) => loadCatalog(signal, true));
  useVisibleRefresh((signal) => loadHistory(true, signal), !historyDirty && !historySaving);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const ruleSets = detail?.available_rule_sets;
  const selectedRuleSet = ruleSets?.find((ruleSet) => ruleSet.id === form?.ruleSetId);
  const acknowledgementManaged = detail?.ticket_events_managed?.reference_received === true;
  const replyManaged = detail?.ticket_events_managed?.before_agent_reply === true;
  const formBlockers: string[] = [];
  if (form) {
    if (!form.displayName.trim()) formBlockers.push(t("tenant.group.configuration.blockers.name"));
    if (!form.zammadGroupId.trim()) formBlockers.push(t("tenant.group.configuration.blockers.destination"));
    if (!form.ruleSetId) formBlockers.push(t("tenant.group.configuration.blockers.ruleSet"));
    if (!acknowledgementManaged && !form.acknowledgementTemplate.trim()) formBlockers.push(t("tenant.group.configuration.blockers.acknowledgement"));
    if (!replyManaged && !form.agentPrefix.trim()) formBlockers.push(t("tenant.group.configuration.blockers.agentPrefix"));
    if (!Number.isInteger(Number(form.maxIdentifiers)) || Number(form.maxIdentifiers) < 1 || Number(form.maxIdentifiers) > 100) {
      formBlockers.push(t("tenant.group.configuration.blockers.identifierLimit", { min: formatNumber(1, locale), max: formatNumber(100, locale) }));
    }
    if (!Number.isInteger(Number(form.retentionDays)) || Number(form.retentionDays) < 1 || Number(form.retentionDays) > 3650) {
      formBlockers.push(t("tenant.group.configuration.blockers.retention", { min: formatNumber(1, locale), max: formatNumber(3650, locale) }));
    }
    if (form.assignmentMode === "fixed_owner" && !/^[1-9]\d{0,9}$/.test(form.fixedOwnerId)) {
      formBlockers.push(t("tenant.group.configuration.blockers.fixedOwner"));
    }
    if (form.businessHoursMode === "ZAMMAD_CALENDAR" && !form.businessHoursCalendarId.trim()) {
      formBlockers.push(t("tenant.group.configuration.blockers.calendar"));
    }
  }
  const runtimeBlockers: string[] = detail?groupActivationCodes(detail).filter(code=>!["CONFIGURATION_REQUIRED","RULE_SET_NOT_ACTIVE","NO_ENABLED_RULES","ZAMMAD_ROUTING_NOT_READY"].includes(code)).map(code=>t(GROUP_ACTIVATION_COPY[code]!)):[];
  if (!ruleSets) runtimeBlockers.push(t("tenant.group.configuration.blockers.ruleReadiness"));
  if (form?.ruleSetId && selectedRuleSet && selectedRuleSet.state !== "ACTIVE") runtimeBlockers.push(t("tenant.group.configuration.blockers.ruleInactive"));
  if (form?.ruleSetId && selectedRuleSet && Number(selectedRuleSet.enabled_rule_count) < 1) runtimeBlockers.push(t("tenant.group.configuration.blockers.noTriggers"));
  if (form?.ruleSetId && ruleSets && !selectedRuleSet) runtimeBlockers.push(t("tenant.group.configuration.blockers.ruleUnavailable"));
  if (catalogLoading) runtimeBlockers.push(t("tenant.group.configuration.blockers.routingLoading"));
  if (catalogError || !routingCatalog) runtimeBlockers.push(t("tenant.group.configuration.blockers.routingUnverified"));
  const selectedZammadGroup = routingCatalog?.groups.find((group) => group.id === form?.zammadGroupId);
  if (form?.zammadGroupId && routingCatalog && !selectedZammadGroup) runtimeBlockers.push(t("tenant.group.configuration.blockers.destinationUnavailable"));
  if (selectedZammadGroup && (!selectedZammadGroup.active || !selectedZammadGroup.serviceIdentityCanCreate)) runtimeBlockers.push(t("tenant.group.configuration.blockers.destinationDenied"));
  const selectedOwner = routingCatalog?.owners.find((owner) => owner.id === form?.fixedOwnerId);
  if (form?.assignmentMode === "fixed_owner" && routingCatalog && (!selectedOwner || !selectedOwner.active || !selectedOwner.groupIds.includes(form.zammadGroupId))) runtimeBlockers.push(t("tenant.group.configuration.blockers.ownerUnavailable"));
  const selectedSla = routingCatalog?.slas.find((sla) => sla.id === form?.slaPolicyId);
  if (form?.slaPolicyId && routingCatalog && (!selectedSla || !selectedSla.active)) runtimeBlockers.push(t("tenant.group.configuration.blockers.servicePolicyUnavailable"));
  const selectedCalendar = routingCatalog?.calendars.find((calendar) => calendar.id === form?.businessHoursCalendarId);
  if (form?.businessHoursMode === "ZAMMAD_CALENDAR" && routingCatalog && (!selectedCalendar || !selectedCalendar.active)) runtimeBlockers.push(t("tenant.group.configuration.blockers.calendarUnavailable"));
  const historyRetentionInvalid=Boolean(historyForm&&(!Number.isInteger(Number(historyForm.retentionDays))||Number(historyForm.retentionDays)<1||Number(historyForm.retentionDays)>3650));
  const historyAgentPrefixInvalid=Boolean(!replyManaged&&historyForm&&historyForm.agentIdentityPlacement!=="OFF"&&(!historyForm.agentPrefix.trim()||[...historyForm.agentPrefix.trim()].length>80));
  const captureOnly=!detail?.binding_state;
  const grantedSubjects=new Set((history?.grants??[]).map(grant=>`${grant.subject_type}:${grant.subject_external_id}`));
  const grantOptions=(grantType==="TEAM"?(routingCatalog?.groups??[]).map(group=>({value:group.id,label:group.name,disabled:!group.active})):(routingCatalog?.owners??[]).map(owner=>({value:owner.id,label:owner.name,description:owner.login,disabled:!owner.active}))).filter(option=>!grantedSubjects.has(`${grantType}:${option.value}`));
  const grantLabel=(grant:{subject_type:"USER"|"TEAM";subject_external_id:string})=>grant.subject_type==="TEAM"?routingCatalog?.groups.find(group=>group.id===grant.subject_external_id)?.name??t("tenant.group.history.access.unknownTeam"):routingCatalog?.owners.find(owner=>owner.id===grant.subject_external_id)?.name??t("tenant.group.history.access.unknownMember");
  const readinessBlockers = [...formBlockers, ...runtimeBlockers];
  const saveBlocked = Boolean(formBlockers.length || (form?.state === "ACTIVE" && runtimeBlockers.length));

  const requestClose = () => {
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    close();
  };

  const update = <K extends keyof GroupConfigurationForm>(key: K, value: GroupConfigurationForm[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setSaveError(null);
    setSaveSuccess(null);
  };

  const updateHistory = <K extends keyof GroupHistoryForm>(key: K, value: GroupHistoryForm[K]) => {
    setHistoryForm((current) => current ? { ...current, [key]: value } : current);
    setHistoryError(null); setHistoryNotice(null);
  };

  const saveHistory = async () => {
    if (!history || !historyForm || !canConfigure || historySaving) return;
    const retentionDays=Number(historyForm.retentionDays);
    if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>3650||historyAgentPrefixInvalid)return;
    setHistorySaving(true);setHistoryError(null);setHistoryNotice(null);
    try{
      const submit=(expectedVersion:number,idempotencyKey:string)=>fetch(`/api/group-workspace/groups/${encodeURIComponent(groupId)}`,{method:"PUT",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},body:JSON.stringify({...historyForm,retentionDays,expectedVersion})});
      const idempotencyKey=historySaveKey.current??crypto.randomUUID();historySaveKey.current=idempotencyKey;
      let response=await submit(history.version,idempotencyKey);
      if(response.status===409){
        const currentResponse=await fetch(`/api/group-workspace/groups/${encodeURIComponent(groupId)}`,{cache:"no-store"});
        if(!currentResponse.ok)throw operatorLocalFailure(await apiError(currentResponse));
        const current=await currentResponse.json() as Partial<GroupHistoryDetail>;const currentForm=groupHistoryFormFromDetail(current);
        if(!currentForm||!Number.isSafeInteger(current.version)||Number(current.version)<0)throw operatorLocalFailure(t("tenant.group.history.errors.load"));
        setHistory(current as GroupHistoryDetail);setSavedHistoryForm(currentForm);historySaveKey.current=null;
        if(savedHistoryForm&&JSON.stringify(currentForm)===JSON.stringify(savedHistoryForm)){
          const retryKey=crypto.randomUUID();historySaveKey.current=retryKey;response=await submit(Number(current.version),retryKey);
        }
      }
      if(!response.ok)throw operatorLocalFailure(await apiError(response));
      const updated=await response.json() as Partial<GroupHistoryDetail>;
      const nextForm=groupHistoryFormFromDetail(updated);
      if(!nextForm||!Number.isSafeInteger(updated.version)||Number(updated.version)<0||!(updated.enabled_at===null||typeof updated.enabled_at==="string"))throw operatorLocalFailure(t("tenant.group.history.errors.save"));
      historySaveKey.current=null;
      setHistory(current=>current?{...current,capture_enabled:nextForm.captureEnabled,enabled_at:updated.enabled_at!,retention_days:Number(nextForm.retentionDays),visibility:nextForm.visibility,agent_prefix:nextForm.agentPrefix,agent_identity_placement:nextForm.agentIdentityPlacement,version:Number(updated.version)}:current);setHistoryForm(nextForm);setSavedHistoryForm(nextForm);setHistoryNotice(t("tenant.group.history.saved"));
    }catch(error){setHistoryError(operatorFailureMessage(error, t("tenant.group.history.errors.save")))}finally{setHistorySaving(false)}
  };

  const mutateGrant = async (grantId?:string) => {
    if(!history||!canConfigure||grantPending||historyDirty||(!grantId&&!grantSubject))return;
    setGrantPending(true);setHistoryError(null);setHistoryNotice(null);
    try{
      const operation=grantId?`revoke:${grantId}`:`grant:${grantType}:${grantSubject}`;const idempotencyKey=grantOperationKeys.current.get(operation)??crypto.randomUUID();grantOperationKeys.current.set(operation,idempotencyKey);
      const response=await fetch(grantId?`/api/group-workspace/groups/${encodeURIComponent(groupId)}/grants/${encodeURIComponent(grantId)}`:`/api/group-workspace/groups/${encodeURIComponent(groupId)}/grants`,{method:grantId?"DELETE":"POST",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},...(grantId?{}:{body:JSON.stringify({subjectType:grantType,subjectExternalId:grantSubject})})});
      if(!response.ok)throw operatorLocalFailure(await apiError(response));
      grantOperationKeys.current.delete(operation);
      setGrantSubject("");await loadHistory(true);setHistoryNotice(t(grantId?"tenant.group.history.access.revoked":"tenant.group.history.access.granted"));
    }catch(error){setHistoryError(operatorFailureMessage(error, t("tenant.group.history.errors.access")))}finally{setGrantPending(false)}
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || saveBlocked || saving || !canConfigure) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    try {
      const body={
        ...form,
        fixedOwnerId: form.assignmentMode === "fixed_owner" ? form.fixedOwnerId : "",
        businessHoursCalendarId: form.businessHoursMode === "ZAMMAD_CALENDAR" ? form.businessHoursCalendarId : "",
        maxIdentifiers: Number(form.maxIdentifiers),
        retentionDays: Number(form.retentionDays),
        expectedRevision:Number(detail?.binding_revision??0),
      };
      const fingerprint=JSON.stringify(body);
      if(bindingSaveIntent.current?.fingerprint!==fingerprint)bindingSaveIntent.current={fingerprint,key:crypto.randomUUID()};
      const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/binding`, {
        method: "PUT",
        headers: {...mutationHeaders,"idempotency-key":bindingSaveIntent.current.key},
        body: JSON.stringify(body),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const saved=await response.json() as {revision?:number};
      bindingSaveIntent.current=null;
      setSavedForm(form);
      setDetail((current) => current ? {
        ...current,
        display_name: form.displayName,
        rule_set_id: form.ruleSetId,
        zammad_group_id: form.zammadGroupId,
        binding_state: form.state,
        binding_revision:saved.revision??current.binding_revision,
      } : current);
      setSaveSuccess(t("tenant.group.configuration.saved"));
      onSaved();
      // Re-read live activation blockers without resetting the form the operator just saved.
      void fetch(`/api/groups/${encodeURIComponent(groupId)}/binding`, { cache: "no-store" }).then((next) => next.ok ? next.json() as Promise<GroupConfigurationDetail> : null).then((next) => { if (next) setDetail(next); }).catch(() => undefined);
    } catch (error) {
      setSaveError(operatorFailureMessage(error, t("tenant.group.configuration.errors.save")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalDialog
      close={requestClose}
      className="modal-backdrop group-configuration-backdrop"
      aria-labelledby="group-config-title"
      aria-describedby="group-config-description"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="modal group-drawer">
        <div className="modal-head group-drawer-head">
          <div>
            <span className="eyebrow">{t("tenant.group.configuration.eyebrow")}</span>
            <h2 id="group-config-title">{detail?.display_name ? <bdi dir="auto">{detail.display_name}</bdi> : t("tenant.group.configuration.title")}</h2>
            <p id="group-config-description">
              {detail
                ? <>{connectionMethod(detail.provider, t)} · <bdi dir="auto">{detail.provider_display_name ?? t("tenant.group.configuration.whatsAppGroup")}</bdi></>
                : t("tenant.group.configuration.loadingDescription")}
            </p>
          </div>
          <button ref={closeButton} type="button" onClick={requestClose} aria-label={t("tenant.group.configuration.closeLabel")}>×</button>
        </div>

        <NativeRoutingSync canWrite={canConfigure} mutationHeaders={mutationHeaders} refreshKey={JSON.stringify(savedForm)} />

        {loading ? (
          <div className="group-drawer-loading" role="status" aria-live="polite">
            <span className="group-skeleton group-skeleton-title" />
            <span className="group-skeleton" />
            <span className="group-skeleton" />
            <b>{t("tenant.group.configuration.loading")}</b>
          </div>
        ) : loadError ? (
          <div className="connection-detail-error" role="alert">
            <span>!</span>
            <div>
              <b>{t("tenant.group.configuration.unavailable")}</b>
              <p>{loadError}</p>
              <button type="button" className="button small" onClick={() => void load()}>{t("common.actions.retry")}</button>
            </div>
          </div>
        ) : !form || !detail ? (
          <Empty title={t("tenant.group.configuration.notFoundTitle")} body={t("tenant.group.configuration.notFoundBody")} />
        ) : (
          <form className="group-config-form" onSubmit={save}>
            {!canConfigure ? (
              <div className="group-config-readonly" role="status">
                <span>i</span>
                <p><b>{t("tenant.group.configuration.readOnlyTitle")}</b>{t("tenant.group.configuration.readOnlyBody")}</p>
              </div>
            ) : null}
            {saveSuccess ? (
              <div className="connection-detail-alert connection-detail-alert-success group-config-feedback" role="status" aria-live="polite">
                <span>✓</span><p>{saveSuccess}</p>
              </div>
            ) : null}
            {saveError ? (
              <div className="connection-detail-alert connection-detail-alert-danger group-config-feedback" role="alert">
                <span>!</span><div><b>{t("tenant.group.configuration.saveFailedTitle")}</b><p>{saveError}</p></div>
              </div>
            ) : null}
            {!ruleSets ? (
              <div className="connection-detail-alert connection-detail-alert-warning group-config-feedback" role="status">
                <span>!</span><p>{t("tenant.group.configuration.ruleOptionsUnavailable")}</p>
              </div>
            ) : ruleSets.length === 0 ? (
              <div className="connection-detail-alert connection-detail-alert-warning group-config-feedback" role="status">
                <span>!</span><p>{t("tenant.group.configuration.noRuleSets")}</p>
              </div>
            ) : null}

            <section className="group-config-section" aria-labelledby="group-context-heading">
              <div className="group-config-section-head">
                <div><h3 id="group-context-heading">{t("tenant.group.configuration.context.title")}</h3><p>{t("tenant.group.configuration.context.body")}</p></div>
                <Status value={form.state} />
              </div>
              <div className="group-config-grid">
                <label className="group-config-wide" htmlFor="group-wasalx-name">{t("tenant.group.configuration.context.name")}<input id="group-wasalx-name" dir="auto" value={form.displayName} maxLength={160} disabled={!canConfigure} onChange={(event) => update("displayName", event.target.value)} /><small>{t("tenant.group.configuration.context.sourceName", { name: String(detail.provider_display_name ?? t("tenant.connection.notReported")) })}</small></label>
                <label htmlFor="group-state">{t("tenant.group.configuration.context.state")}<select id="group-state" value={form.state} disabled={!canConfigure} onChange={(event) => update("state", event.target.value as GroupConfigurationForm["state"])}><option value="DRAFT">{t("tenant.group.configuration.state.draft")}</option><option value="ACTIVE">{t("common.status.active")}</option><option value="PAUSED">{t("tenant.status.paused")}</option></select></label>
                <RoutingCatalogSelect id="group-zammad" label={t("tenant.group.configuration.routing.destination")} value={form.zammadGroupId} options={(routingCatalog?.groups ?? []).map((group) => ({ value: group.id, label: group.name, description: t(group.serviceIdentityCanCreate ? "tenant.group.configuration.routing.availableForCases" : "tenant.group.configuration.routing.cannotCreateCases"), disabled: !group.active || !group.serviceIdentityCanCreate }))} disabled={!canConfigure || catalogLoading || Boolean(catalogError)} onChange={(value) => { update("zammadGroupId", value); if (form.fixedOwnerId && !routingCatalog?.owners.find((owner) => owner.id === form.fixedOwnerId)?.groupIds.includes(value)) update("fixedOwnerId", ""); }} placeholder={t("tenant.group.configuration.routing.searchTeams")} />
                <label htmlFor="group-rule-set">{t("tenant.group.configuration.context.ruleSet")}<select id="group-rule-set" dir="auto" value={form.ruleSetId} disabled={!canConfigure || !ruleSets} onChange={(event) => update("ruleSetId", event.target.value)}><option value="">{t("tenant.group.configuration.context.selectRuleSet")}</option>{ruleSets?.map((ruleSet) => <option key={ruleSet.id} value={ruleSet.id}>{t("tenant.group.configuration.context.ruleOption", { name: ruleSet.name, version: formatNumber(ruleSet.version, locale), state: t(ruleSet.state === "ACTIVE" ? "common.status.active" : "common.status.inactive") })}</option>)}</select></label>
              </div>
            </section>

            <section className="group-config-section" aria-labelledby="group-routing-heading">
              <div className="group-config-section-head"><div><h3 id="group-routing-heading">{t("tenant.group.configuration.routing.title")}</h3><p>{t("tenant.group.configuration.routing.body")}</p></div></div>
              <div className={`routing-catalog-status ${catalogError ? "has-error" : ""}`} role={catalogError ? "alert" : "status"} aria-live="polite">
                <div><b>{t(catalogLoading ? "tenant.group.configuration.routing.loading" : catalogError ? "tenant.group.configuration.routing.unavailable" : "tenant.group.configuration.routing.verified")}</b><small>{catalogError ? t("tenant.errors.routingCatalogUnavailable") : routingCatalog ? t("tenant.group.configuration.routing.refreshed", { time: formatRelativeTime(routingCatalog.fetchedAt, locale, renderedAt) }) : t("tenant.group.configuration.routing.selectionPreserved")}</small></div>
                {catalogError ? <button type="button" className="button small" disabled={catalogLoading} onClick={() => void loadCatalog()}>{t(catalogLoading ? "common.status.loading" : "common.actions.retry")}</button> : null}
              </div>
              <div className="group-config-grid">
                <label htmlFor="group-priority">{t("tenant.group.configuration.routing.priority")}<select id="group-priority" value={form.defaultPriority} disabled={!canConfigure} onChange={(event) => update("defaultPriority", event.target.value as GroupConfigurationForm["defaultPriority"])}><option value="low">{t("tenant.group.configuration.routing.priorityLow")}</option><option value="normal">{t("tenant.group.configuration.routing.priorityNormal")}</option><option value="high">{t("tenant.group.configuration.routing.priorityHigh")}</option></select></label>
                <label htmlFor="group-assignment">{t("tenant.group.configuration.routing.assignment")}<select id="group-assignment" value={form.assignmentMode} disabled={!canConfigure} onChange={(event) => update("assignmentMode", event.target.value as GroupConfigurationForm["assignmentMode"])}><option value="zammad_auto">{t("tenant.group.configuration.routing.assignmentAutomatic")}</option><option value="fixed_owner">{t("tenant.group.configuration.routing.assignmentFixed")}</option><option value="unassigned">{t("tenant.group.configuration.routing.assignmentUnassigned")}</option></select></label>
                {form.assignmentMode === "fixed_owner" ? <RoutingCatalogSelect id="group-fixed-owner" label={t("tenant.group.configuration.routing.fixedOwner")} value={form.fixedOwnerId} options={(routingCatalog?.owners ?? []).filter((owner) => owner.groupIds.includes(form.zammadGroupId)).map((owner) => ({ value: owner.id, label: owner.name, description: t("tenant.group.configuration.routing.ownerAvailable"), disabled: !owner.active }))} disabled={!canConfigure || catalogLoading || Boolean(catalogError) || !form.zammadGroupId} onChange={(value) => update("fixedOwnerId", value)} placeholder={t("tenant.group.configuration.routing.searchMembers")} /> : null}
                <RoutingCatalogSelect id="group-sla" label={t("tenant.group.configuration.routing.servicePolicy")} optional value={form.slaPolicyId} options={(routingCatalog?.slas ?? []).map((sla) => ({ value: sla.id, label: sla.name, description: t("tenant.group.configuration.routing.servicePolicyDescription"), disabled: !sla.active }))} disabled={!canConfigure || catalogLoading || Boolean(catalogError)} onChange={(value) => update("slaPolicyId", value)} placeholder={t("tenant.group.configuration.routing.searchPolicies")} />
                <label htmlFor="group-business-hours">{t("tenant.group.configuration.routing.businessHours")}<select id="group-business-hours" value={form.businessHoursMode} disabled={!canConfigure} onChange={(event) => update("businessHoursMode", event.target.value as GroupConfigurationForm["businessHoursMode"])}><option value="ALWAYS">{t("tenant.group.configuration.routing.alwaysActive")}</option><option value="ZAMMAD_CALENDAR">{t("tenant.group.configuration.routing.followCalendar")}</option></select></label>
                {form.businessHoursMode === "ZAMMAD_CALENDAR" ? <RoutingCatalogSelect id="group-business-hours-calendar" label={t("tenant.group.configuration.routing.calendar")} value={form.businessHoursCalendarId} options={(routingCatalog?.calendars ?? []).map((calendar) => ({ value: calendar.id, label: calendar.name, description: calendar.timezone ?? t("tenant.group.configuration.routing.workspaceTimezone"), disabled: !calendar.active }))} disabled={!canConfigure || catalogLoading || Boolean(catalogError)} onChange={(value) => update("businessHoursCalendarId", value)} placeholder={t("tenant.group.configuration.routing.searchCalendars")} /> : null}
              </div>
            </section>

            <section className="group-config-section" aria-labelledby="group-history-heading">
              <div className="group-config-section-head"><div><h3 id="group-history-heading">{t("tenant.group.history.title")}</h3><p>{t("tenant.group.history.body")}</p></div>{historyForm ? <Status value={historyForm.captureEnabled?"ACTIVE":"PAUSED"}/> : null}</div>
              {historyLoading ? <div className="group-history-status" role="status">{t("tenant.group.history.loading")}</div> : historyError&&!historyForm ? <div className="group-history-status error" role="alert"><span>{historyError}</span><button type="button" className="button small" onClick={()=>void loadHistory()}>{t("common.actions.retry")}</button></div> : history&&historyForm ? <>
                {!history.group_workspace_enabled?<div className="group-history-status warning" role="status"><span>{t("tenant.group.history.workspaceDisabled")}</span></div>:null}
                {historyError?<div className="group-history-status error" role="alert"><span>{historyError}</span></div>:null}
                {historyNotice?<div className="group-history-status success" role="status"><span>{historyNotice}</span></div>:null}
                <div className="group-config-grid">
                  <label className="group-config-check group-config-wide" htmlFor="group-history-capture"><input id="group-history-capture" type="checkbox" aria-label={t("tenant.group.history.captureTitle")} checked={historyForm.captureEnabled} disabled={!canConfigure||!history.group_workspace_enabled} onChange={event=>updateHistory("captureEnabled",event.target.checked)}/><span><b>{t("tenant.group.history.captureTitle")}</b><small>{t("tenant.group.history.captureBody")}</small></span></label>
                  <label htmlFor="group-history-retention">{t("tenant.group.history.retention")}<input id="group-history-retention" type="number" min="1" max="3650" value={historyForm.retentionDays} disabled={!canConfigure||!history.group_workspace_enabled} aria-invalid={historyRetentionInvalid||undefined} aria-describedby="group-history-retention-help" onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();if(historyDirty)void saveHistory()}}} onChange={event=>updateHistory("retentionDays",event.target.value)}/><small id="group-history-retention-help">{historyRetentionInvalid?t("tenant.group.configuration.blockers.retention",{min:formatNumber(1,locale),max:formatNumber(3650,locale)}):t("tenant.group.history.retentionHelp")}</small></label>
                  <label htmlFor="group-history-visibility">{t("tenant.group.history.visibility")}<select id="group-history-visibility" value={historyForm.visibility} disabled={!canConfigure||!history.group_workspace_enabled} onChange={event=>updateHistory("visibility",event.target.value as GroupHistoryForm["visibility"])}><option value="RESTRICTED">{t("tenant.group.history.visibilityRestricted")}</option><option value="ALL_AGENTS">{t("tenant.group.history.visibilityAll")}</option></select><small>{t(historyForm.visibility==="RESTRICTED"?"tenant.group.history.visibilityRestrictedHelp":"tenant.group.history.visibilityAllHelp")}</small></label>
                  {captureOnly?<><label htmlFor="group-history-agent-identity-placement">{t("tenant.group.configuration.messages.agentIdentityPlacement")}<select id="group-history-agent-identity-placement" value={historyForm.agentIdentityPlacement} disabled={!canConfigure||!history.group_workspace_enabled||replyManaged} aria-describedby="group-history-agent-workflow-help" onChange={event=>updateHistory("agentIdentityPlacement",event.target.value as GroupHistoryForm["agentIdentityPlacement"])}><option value="HEADER">{t("tenant.group.configuration.messages.agentIdentityHeader")}</option><option value="FOOTER">{t("tenant.group.configuration.messages.agentIdentityFooter")}</option><option value="OFF">{t("tenant.group.configuration.messages.agentIdentityOff")}</option></select><small id="group-history-agent-workflow-help">{t(replyManaged ? "tenant.group.configuration.messages.workflowManaged" : "tenant.group.configuration.messages.agentIdentityHelp")}</small></label><label htmlFor="group-history-agent-prefix">{t("tenant.group.configuration.messages.agentPrefix")}<input id="group-history-agent-prefix" dir="auto" value={historyForm.agentPrefix} maxLength={80} disabled={!canConfigure||!history.group_workspace_enabled||replyManaged||historyForm.agentIdentityPlacement==="OFF"} aria-describedby="group-history-agent-workflow-help" aria-invalid={historyAgentPrefixInvalid||undefined} onChange={event=>updateHistory("agentPrefix",event.target.value)}/></label>{!replyManaged ? <div className="group-agent-preview group-config-wide" aria-live="polite"><small>{t("tenant.group.configuration.messages.preview")}</small><div dir="auto">{historyForm.agentIdentityPlacement==="HEADER"?<b>{`${historyForm.agentPrefix||t("tenant.group.configuration.defaultAgentPrefix")} ${t("tenant.group.configuration.messages.previewAgent")}`}</b>:null}<span>{t("tenant.group.configuration.messages.previewMessage")}</span>{historyForm.agentIdentityPlacement==="FOOTER"?<b>{`${historyForm.agentPrefix||t("tenant.group.configuration.defaultAgentPrefix")} ${t("tenant.group.configuration.messages.previewAgent")}`}</b>:null}</div></div> : null}</>:null}
                </div>
                <div className="group-history-actions"><span>{history.enabled_at?t("tenant.group.history.started",{time:formatRelativeTime(history.enabled_at,locale,renderedAt)}):t("tenant.group.history.notStarted")}</span><button type="button" className="button primary" disabled={!canConfigure||!history.group_workspace_enabled||!historyDirty||historySaving||historyRetentionInvalid||historyAgentPrefixInvalid} onClick={()=>void saveHistory()}>{t(historySaving?"tenant.group.history.saving":"tenant.group.history.save")}</button></div>
                {historyForm.visibility==="RESTRICTED"?<div className="group-history-access"><div className="group-config-section-head"><div><h3>{t("tenant.group.history.access.title")}</h3><p>{t("tenant.group.history.access.body")}</p></div></div><div className="group-config-grid"><label htmlFor="group-history-subject-type">{t("tenant.group.history.access.type")}<select id="group-history-subject-type" value={grantType} disabled={!canConfigure||grantPending||historyDirty} onChange={event=>{setGrantType(event.target.value as "USER"|"TEAM");setGrantSubject("")}}><option value="TEAM">{t("tenant.group.history.access.team")}</option><option value="USER">{t("tenant.group.history.access.member")}</option></select></label><RoutingCatalogSelect id="group-history-subject" label={t(grantType==="TEAM"?"tenant.group.history.access.team":"tenant.group.history.access.member")} value={grantSubject} options={grantOptions} disabled={!canConfigure||grantPending||historyDirty||catalogLoading||Boolean(catalogError)} onChange={setGrantSubject} placeholder={t(grantType==="TEAM"?"tenant.group.history.access.searchTeams":"tenant.group.history.access.searchMembers")}/></div><div className="group-history-actions"><span>{historyDirty?t("tenant.group.history.access.saveFirst"):t("tenant.group.history.access.help")}</span><button type="button" className="button secondary" disabled={!canConfigure||grantPending||historyDirty||!grantSubject} onClick={()=>void mutateGrant()}>{t(grantPending?"tenant.group.history.access.updating":"tenant.group.history.access.add")}</button></div><div className="group-history-grants">{history.grants.length?history.grants.map(grant=><div key={grant.id}><span><bdi dir="auto">{grantLabel(grant)}</bdi><small>{t(grant.subject_type==="TEAM"?"tenant.group.history.access.team":"tenant.group.history.access.member")}</small></span>{canConfigure?<button type="button" className="button small" disabled={grantPending||historyDirty} aria-label={`${t("common.actions.remove")}: ${grantLabel(grant)}`} onClick={()=>void mutateGrant(grant.id)}>{t("common.actions.remove")}</button>:null}</div>):<p>{t("tenant.group.history.access.empty")}</p>}</div></div>:null}
              </>:null}
            </section>

            <section className="group-config-section" aria-labelledby="group-message-heading">
              <div className="group-config-section-head"><div><h3 id="group-message-heading">{t("tenant.group.configuration.messages.title")}</h3><p>{t("tenant.group.configuration.messages.body")}</p></div></div>
              <div className="group-config-grid">
                <label className="group-config-wide" htmlFor="group-acknowledgement">{t("tenant.group.configuration.messages.acknowledgement")}<textarea id="group-acknowledgement" dir="auto" value={form.acknowledgementTemplate} maxLength={1000} disabled={!canConfigure || acknowledgementManaged} aria-describedby="group-acknowledgement-help" onChange={(event) => update("acknowledgementTemplate", event.target.value)} /><small id="group-acknowledgement-help">{t(acknowledgementManaged ? "tenant.group.configuration.messages.workflowManaged" : "tenant.group.configuration.messages.acknowledgementHelp")}</small></label>
                <label htmlFor="group-agent-identity-placement">{t("tenant.group.configuration.messages.agentIdentityPlacement")}<select id="group-agent-identity-placement" value={form.agentIdentityPlacement} disabled={!canConfigure || replyManaged} aria-describedby="group-agent-workflow-help" onChange={(event) => update("agentIdentityPlacement", event.target.value as GroupConfigurationForm["agentIdentityPlacement"])}><option value="HEADER">{t("tenant.group.configuration.messages.agentIdentityHeader")}</option><option value="FOOTER">{t("tenant.group.configuration.messages.agentIdentityFooter")}</option><option value="OFF">{t("tenant.group.configuration.messages.agentIdentityOff")}</option></select><small id="group-agent-workflow-help">{t(replyManaged ? "tenant.group.configuration.messages.workflowManaged" : "tenant.group.configuration.messages.agentIdentityHelp")}</small></label>
                <label htmlFor="group-agent-prefix">{t("tenant.group.configuration.messages.agentPrefix")}<input id="group-agent-prefix" dir="auto" value={form.agentPrefix} maxLength={80} disabled={!canConfigure || replyManaged || form.agentIdentityPlacement === "OFF"} aria-describedby="group-agent-workflow-help" onChange={(event) => update("agentPrefix", event.target.value)} placeholder={t("tenant.group.configuration.defaultAgentPrefix")} /></label>
                {!replyManaged ? <div className="group-agent-preview group-config-wide" aria-live="polite"><small>{t("tenant.group.configuration.messages.preview")}</small><div dir="auto">{form.agentIdentityPlacement === "HEADER" ? <b>{`${form.agentPrefix || t("tenant.group.configuration.defaultAgentPrefix")} ${t("tenant.group.configuration.messages.previewAgent")}`}</b> : null}<span>{t("tenant.group.configuration.messages.previewMessage")}</span>{form.agentIdentityPlacement === "FOOTER" ? <b>{`${form.agentPrefix || t("tenant.group.configuration.defaultAgentPrefix")} ${t("tenant.group.configuration.messages.previewAgent")}`}</b> : null}</div></div> : null}
                <label htmlFor="group-max-identifiers">{t("tenant.group.configuration.messages.maxIdentifiers")}<input id="group-max-identifiers" type="number" min="1" max="100" value={form.maxIdentifiers} disabled={!canConfigure} onChange={(event) => update("maxIdentifiers", event.target.value)} /></label>
                <label htmlFor="group-retention">{t("tenant.group.configuration.messages.retentionDays")}<input id="group-retention" type="number" min="1" max="3650" value={form.retentionDays} disabled={!canConfigure} onChange={(event) => update("retentionDays", event.target.value)} /></label>
                <label className="group-config-check group-config-wide" htmlFor="group-media" aria-label={t("tenant.group.configuration.messages.mediaLabel")}><input id="group-media" type="checkbox" checked={form.mediaEnabled} disabled={!canConfigure} onChange={(event) => update("mediaEnabled", event.target.checked)} /><span><b>{t("tenant.group.configuration.messages.mediaTitle")}</b><small>{t("tenant.group.configuration.messages.mediaBody")}</small></span></label>
              </div>
            </section>

            <section className={`group-readiness ${readinessBlockers.length ? "has-blockers" : "is-ready"}`} aria-labelledby="group-readiness-heading">
              <div className="group-readiness-head"><span>{readinessBlockers.length ? "!" : "✓"}</span><div><h3 id="group-readiness-heading">{t(readinessBlockers.length ? form.state === "ACTIVE" && !formBlockers.length ? "tenant.group.configuration.readiness.activeRefreshTitle" : "tenant.group.configuration.readiness.blockedTitle" : "tenant.group.configuration.readiness.readyTitle")}</h3><p>{t(readinessBlockers.length ? form.state === "ACTIVE" && !formBlockers.length ? "tenant.group.configuration.readiness.activeRefreshBody" : "tenant.group.configuration.readiness.blockedBody" : "tenant.group.configuration.readiness.readyBody")}</p></div></div>
              {readinessBlockers.length ? <ul>{readinessBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}
            </section>

            {confirmClose ? (
              <InlineConfirmation className="group-discard-confirm" aria-labelledby="group-discard-title" aria-describedby="group-discard-description" cancel={() => setConfirmClose(false)}>
                <div><b id="group-discard-title">{t("tenant.group.configuration.discard.title")}</b><p id="group-discard-description">{t("tenant.group.configuration.discard.body")}</p></div>
                <div><button type="button" className="button small" data-inline-confirm-initial-focus onClick={() => setConfirmClose(false)}>{t("tenant.group.configuration.discard.keepEditing")}</button><button type="button" className="button small group-discard-button" onClick={close}>{t("tenant.group.configuration.discard.confirm")}</button></div>
              </InlineConfirmation>
            ) : null}

            <footer className="group-drawer-footer">
              <span aria-live="polite">{t(dirty ? "tenant.group.configuration.footer.unsaved" : saveSuccess ? "tenant.group.configuration.footer.saved" : "tenant.group.configuration.footer.clean")}</span>
              <div><button type="button" className="button secondary" onClick={requestClose}>{t("common.actions.close")}</button>{canConfigure ? <button type="submit" className="button primary" disabled={!bindingDirty || saving || saveBlocked}>{t(saving ? "tenant.group.configuration.footer.saving" : form.state === "ACTIVE" ? "tenant.group.configuration.footer.saveActivate" : "tenant.group.configuration.footer.save")}</button> : null}</div>
            </footer>
          </form>
        )}
      </div>
    </ModalDialog>
  );
}

function Rules({
  rows,
  groups,
  onSaved,
  mutationHeaders,
  canCreate,
}: {
  rows: TriggerRule[];
  groups: RecordRow[];
  onSaved: () => void;
  mutationHeaders: Record<string, string>;
  canCreate: boolean;
}) {
  const { locale, t } = useI18n();
  const [sample, setSample] = useState(
    t("tenant.rules.sample.default"),
  );
  const [result, setResult] = useState<{
    normalized: string;
    matches: RuleMatch[];
    warnings?: Array<{ code?: string }>;
  } | null>(null);
  const [testGroupId, setTestGroupId] = useState(() => String(groups[0]?.id ?? ""));
  const [testSender,setTestSender]=useState<"customer"|"team"|"unknown">("customer");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRule, setSelectedRule] = useState<TriggerRule | null>(null);
  const [additionalRuleGroups, setAdditionalRuleGroups] = useState<RecordRow[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupLoadError, setGroupLoadError] = useState<string | null>(null);
  const [loadedPageHasMore, setLoadedPageHasMore] = useState<boolean | null>(null);
  const testOutput = useRef<HTMLDivElement>(null);
  const ruleGroups = [...new Map([...groups, ...additionalRuleGroups].map((group) => [String(group.id), group])).values()];
  const canLoadMoreGroups = loadedPageHasMore ?? groups.length === 200;
  const testGroup = ruleGroups.find((group) => String(group.id) === testGroupId) ?? ruleGroups[0];
  const testGroupNameCounts = new Map<string, number>();
  for (const group of ruleGroups) {
    const name = String(group.name ?? group.display_name ?? t("tenant.rules.tester.defaultGroup"));
    testGroupNameCounts.set(name, (testGroupNameCounts.get(name) ?? 0) + 1);
  }
  const configuredLimit = Number(testGroup?.max_identifiers ?? 20);
  const maxIdentifiers = Number.isInteger(configuredLimit) && configuredLimit >= 1 && configuredLimit <= 100 ? configuredLimit : 20;
  const limitExceeded = Boolean(result && result.matches.length > maxIdentifiers);
  const warningCodes = [...new Set((result?.warnings ?? []).map((warning) => String(warning.code ?? "")).filter((code) => ["OVERLAPPING_RULES", "BROAD_MATCH", "MATCH_LIMIT_REACHED", "TEAM_SENDER_EXCLUDED"].includes(code)))];
  const loadMoreGroups = async () => {
    const after = String(ruleGroups.at(-1)?.id ?? "");
    if (!after || loadingGroups) return;
    setLoadingGroups(true); setGroupLoadError(null);
    try {
      const response = await fetch(`/api/groups?limit=200&after=${encodeURIComponent(after)}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as RecordRow[];
      setAdditionalRuleGroups((current) => [...new Map([...current, ...next].map((group) => [String(group.id), group])).values()]);
      setLoadedPageHasMore(next.length === 200);
    } catch (problem) {
      setGroupLoadError(operatorFailureMessage(problem, t("tenant.rules.tester.groupLoadFailed")));
    } finally { setLoadingGroups(false); }
  };
  const run = async () => {
    if (!rows.length) return;
    setTesting(true);
    setTestError(null);
    try {
      const r = await fetch("/api/rules/test", {
        method: "POST",
        headers: idempotentHeaders(mutationHeaders),
        body: JSON.stringify({ message: sample, sender:testSender, rules: rows }),
      });
      if (!r.ok) throw operatorLocalFailure(await apiError(r));
      setResult(await r.json());
    } catch (problem) {
      setResult(null);
      setTestError(operatorFailureMessage(problem, t("tenant.rules.errors.test")));
    } finally {
      setTesting(false);
      window.requestAnimationFrame(() => testOutput.current?.focus({ preventScroll: true }));
    }
  };
  return (
    <div className="rules-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t(rows.length ? "tenant.rules.activeSet" : "tenant.rules.noActiveSet")}</h2>
            <p>{rows.length ? <>{t("tenant.rules.governedVersion")} <bdi>{formatNumber(Number(rows[0]?.version ?? 0), locale)}</bdi></> : t("tenant.rules.noActiveSetBody")}</p>
          </div>
          {canCreate && <button className="button" onClick={() => setCreating(true)}>＋ {t("tenant.rules.new")}</button>}
        </div>
        <div className="rule-list">
          {rows.map((rule) => (
            <div className="rule-card" key={rule.id}>
              <div className="drag">⠿</div>
              <div className="rule-index">{formatNumber(rule.priority, locale)}</div>
              <div className="rule-info">
                <div>
                  <b><bdi>{rule.name}</bdi></b>
                  <Status value={rule.enabled ? "Active" : "Paused"} />
                </div>
                <small className="rule-matcher-summary">{t(`tenant.rules.matcher.${rule.matcherType}`)}</small>
                <small>
                  {t("tenant.rules.versionShort")}<bdi>{formatNumber(rule.version, locale)}</bdi> · <bdi>{formatNumber(rule.matchCount, locale)}</bdi> {t(rule.matchCount === 1 ? "tenant.rules.matches.one" : "tenant.rules.matches")}
                </small>
              </div>
              <button className="more" aria-label={t("tenant.rules.inspectNamed", { name: rule.name })} onClick={() => setSelectedRule(rule)}>•••</button>
            </div>
          ))}
        </div>
        <div className="panel-footer">
          <span>
            {t("tenant.rules.priorityHelp")}
          </span>
          <button className="text-button" onClick={() => setHistoryOpen(true)}>{t("tenant.rules.compareVersions")}</button>
        </div>
      </section>
      <section className="panel tester">
        <div className="panel-heading">
          <div>
            <h2>{t("tenant.rules.tester.title")}</h2>
            <p>{t("tenant.rules.tester.body")}</p>
          </div>
        </div>
        <label htmlFor="rule-test-sender">{t("tenant.rules.tester.sender")}<select id="rule-test-sender" value={testSender} onChange={event=>{setTestSender(event.target.value as "customer"|"team"|"unknown");setResult(null);setTestError(null)}}><option value="customer">{t("tenant.rules.tester.sender.customer")}</option><option value="team">{t("tenant.rules.tester.sender.team")}</option><option value="unknown">{t("tenant.rules.tester.sender.unknown")}</option></select></label>
        <label htmlFor="rule-test-sample">
          <span id="rule-test-sample-label">{t("tenant.rules.tester.sampleLabel")}</span>
          <textarea
            id="rule-test-sample"
            aria-labelledby="rule-test-sample-label"
            value={sample}
            onChange={(e) => { setSample(e.target.value); setResult(null); setTestError(null); }}
            rows={5}
          />
        </label>
        {ruleGroups.length ? <label>{t("tenant.rules.tester.groupLabel")}<select value={String(testGroup?.id ?? "")} onChange={(event) => { setTestGroupId(event.target.value); setResult(null); }}>{ruleGroups.map((group) => { const name=String(group.name??group.display_name??t("tenant.rules.tester.defaultGroup"));return <option dir="auto" key={String(group.id)} value={String(group.id)}>{(testGroupNameCounts.get(name)??0)>1?t(group.members===null?"tenant.rules.tester.groupOptionDetailedUnknown":"tenant.rules.tester.groupOptionDetailed",{name,connection:String(group.connection_name??t("tenant.rules.tester.unknownConnection")),members:group.members===null?"":formatNumber(Number(group.members??0),locale)}):name}</option> })}</select><small>{t("tenant.rules.tester.groupLimit", { limit: formatNumber(maxIdentifiers, locale) })}</small>{canLoadMoreGroups?<button type="button" className="text-button" disabled={loadingGroups} onClick={()=>void loadMoreGroups()}>{t(loadingGroups?"tenant.rules.tester.loadingGroups":"tenant.rules.tester.loadMoreGroups")}</button>:null}{groupLoadError?<small role="alert" className="bot-inline-error">{groupLoadError}</small>:null}</label> : null}
        <div className="tester-actions">
          <button className="button primary" onClick={run} disabled={testing || !rows.length} aria-controls="rule-test-output">
            {t(testing ? "tenant.rules.actions.testing" : "tenant.rules.actions.runTest")}
          </button>
          <span>{t("tenant.rules.tester.digitHelp")}</span>
        </div>
        <div id="rule-test-output" className="rule-test-output" ref={testOutput} tabIndex={-1} aria-live="polite" aria-atomic="true">
        {!rows.length ? (
          <div className="test-placeholder">
            <p>{t("tenant.rules.tester.noRules")}</p>
            {canCreate ? <button className="button small" onClick={() => setCreating(true)}>{t("tenant.rules.new")}</button> : null}
          </div>
        ) : null}
        {rows.length && testError ? <div className="settings-feedback error rule-test-feedback" role="alert"><span>!</span><p>{testError}</p></div> : null}
        {rows.length && !testError && result ? (
          <div className="test-result">
            <div className={`result-head ${limitExceeded ? "warning" : ""}`}>
              <span className="health-icon">{limitExceeded ? "!" : "✓"}</span>
              <span>
                <b>{t(`tenant.rules.tester.references.${countForm(result.matches.length)}`, { count: formatNumber(result.matches.length, locale) })}</b>
                <small>
                  {limitExceeded ? t("tenant.rules.tester.limitExceeded", { limit: formatNumber(maxIdentifiers, locale) }) : t(`tenant.rules.tester.supportCases.${countForm(result.matches.length)}`, { count: formatNumber(result.matches.length, locale) })}
                </small>
              </span>
            </div>
            {warningCodes.length ? <ul className="rule-test-warnings">{warningCodes.map((code) => <li key={code}>{t(`tenant.rules.tester.warning.${code}`)}</li>)}</ul> : null}
            <div className="normalized">
              <small>{t("tenant.rules.normalizedInput")}</small>
              <code><bdi>{result.normalized}</bdi></code>
            </div>
            {result.matches.map((m) => (
              <div className="match" key={`${m.ruleId}-${m.start}`}>
                <span><bdi>{m.normalizedValue}</bdi></span>
                <small><bdi>{m.ruleName}</bdi></small>
              </div>
            ))}
          </div>
        ) : rows.length ? (
          <div className="test-placeholder">
            {t("tenant.rules.tester.placeholder")}
          </div>
        ) : null}
        </div>
      </section>
      {creating && canCreate && (
        <RuleModal
          mutationHeaders={mutationHeaders}
          close={() => setCreating(false)}
          saved={() => {
            setCreating(false);
            setHistoryOpen(true);
            onSaved();
          }}
        />
      )}
      {selectedRule ? <ModalDialog close={() => setSelectedRule(null)} className="modal-backdrop" aria-labelledby="rule-inspector-title"><div className="modal rule-inspector"><div className="modal-head"><div><span className="eyebrow">{t("tenant.rules.inspector.eyebrow")}</span><h2 id="rule-inspector-title"><bdi>{selectedRule.name}</bdi></h2><p>{t("tenant.rules.inspector.body")}</p></div><button aria-label={t("tenant.rules.inspector.close")} onClick={() => setSelectedRule(null)}>×</button></div><dl className="rule-inspector-facts"><div><dt>{t("tenant.rules.matcher")}</dt><dd>{t(`tenant.rules.matcher.${selectedRule.matcherType}`)}</dd></div><div><dt>{t("tenant.rules.priority")}</dt><dd>{formatNumber(selectedRule.priority, locale)}</dd></div><div><dt>{t("tenant.rules.version")}</dt><dd>{t("tenant.rules.versionShort")}<bdi>{formatNumber(selectedRule.version, locale)}</bdi></dd></div><div><dt>{t("tenant.rules.state")}</dt><dd>{t(selectedRule.enabled ? "common.status.active" : "tenant.status.paused")}</dd></div></dl><RuleMatcherCondition rule={selectedRule} locale={locale} t={t} /><div className="modal-actions"><button className="button secondary" onClick={() => setSelectedRule(null)}>{t("tenant.rules.actions.close")}</button><button className="button primary" onClick={() => { const example = selectedRule.matcherType === "exact_length" ? "1".repeat(selectedRule.digitLength ?? 10) : selectedRule.matcherType === "prefix_length" ? `${selectedRule.prefix ?? "ABC"}${"1".repeat(selectedRule.digitLength ?? 7)}` : selectedRule.matcherType === "advanced" ? null : selectedRule.pattern; setSample(example ? t("tenant.rules.sample.investigate", { example }) : t("tenant.rules.sample.default")); setResult(null); setTestError(null); setSelectedRule(null); }}>{t("tenant.rules.actions.useInTester")}</button></div></div></ModalDialog> : null}
      {historyOpen ? <RuleGovernanceDialog canManage={canCreate} mutationHeaders={mutationHeaders} close={() => setHistoryOpen(false)} changed={onSaved} /> : null}
    </div>
  );
}

function RuleMatcherCondition({ rule, locale, t }: { rule: TriggerRule; locale: "en" | "ar"; t: TenantTranslator }) {
  if (rule.matcherType === "advanced") return <details className="rule-expression-details"><summary>{t("tenant.rules.advancedDetails")}</summary><div className="normalized"><small>{t("tenant.rules.expression")}</small><code><bdi>{rule.pattern}</bdi></code></div></details>;
  const hasDigitLength = rule.matcherType === "exact_length" || rule.matcherType === "prefix_length";
  return <div className="normalized">
    <small>{t("tenant.rules.condition")}</small>
    {hasDigitLength ? <>
      {rule.matcherType === "prefix_length" ? <div><b>{t("tenant.rules.modal.prefix")}: </b><code><bdi dir="auto">{rule.prefix || t("tenant.rules.inspector.notConfigured")}</bdi></code></div> : null}
      <div><b>{t("tenant.rules.modal.digitLength")}: </b><bdi>{rule.digitLength == null ? t("tenant.rules.inspector.notConfigured") : formatNumber(rule.digitLength, locale)}</bdi></div>
    </> : <code><bdi dir="auto">{rule.pattern}</bdi></code>}
  </div>;
}

type RuleSetVersionRow = RecordRow & {
  id: string;
  family_id?: string;
  familyId?: string;
  name: string;
  version: number;
  state: "DRAFT" | "ACTIVE" | "RETIRED";
  revision: number;
  rules?: RecordRow[];
};

function ruleReadinessIssue(value: unknown, t: TenantTranslator) {
  const key = ({
    NO_ENABLED_RULES: "tenant.rules.readiness.issue.noEnabledRules",
    DUPLICATE_MATCHER: "tenant.rules.readiness.issue.duplicateMatcher",
    NO_SAVED_EXAMPLES: "tenant.rules.readiness.issue.noSavedExamples",
    INVALID_SAVED_EXAMPLE: "tenant.rules.readiness.issue.invalidSavedExample",
    SAVED_EXAMPLE_MISMATCH: "tenant.rules.readiness.issue.savedExampleMismatch",
    OVERLAPPING_RULES: "tenant.rules.readiness.issue.overlappingRules",
    BROAD_MATCH: "tenant.rules.readiness.issue.broadMatch",
    MATCH_LIMIT_REACHED: "tenant.rules.readiness.issue.matchLimitReached",
  } as Record<string, string>)[String(value)] ?? "tenant.rules.readiness.issue.unknown";
  return t(key);
}

function RuleGovernanceDialog({
  canManage,
  mutationHeaders,
  close,
  changed,
}: {
  canManage: boolean;
  mutationHeaders: Record<string, string>;
  close: () => void;
  changed: () => void;
}) {
  const { locale, t } = useI18n();
  const [versions, setVersions] = useState<RuleSetVersionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder,setLoadingOlder]=useState(false);
  const [canLoadOlder,setCanLoadOlder]=useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [comparison, setComparison] = useState<RecordRow | null>(null);
  const [comparing, setComparing] = useState(false);
  const [operation, setOperation] = useState<{ kind: "activate" | "rollback"; target: RuleSetVersionRow } | null>(null);
  const [clonePolicies,setClonePolicies]=useState<Record<string,"include"|"exclude">>({});
  const cloneRequest = useRef<{ sourceId: string; key: string; pending: boolean; body: string } | null>(null);
  const [cloneSourceId, setCloneSourceId] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<RecordRow | null>(null);
  const [operating, setOperating] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const readinessTarget = useRef<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/rule-sets?limit=200", { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const value = await response.json() as RuleSetVersionRow[];
      setVersions(value);
      setCanLoadOlder(value.length===200);
      const active = value.find((item) => item.state === "ACTIVE");
      const family = active ? ruleSetFamily(active) : value[0] ? ruleSetFamily(value[0]) : "";
      const prior = value.find((item) => item.state === "RETIRED" && ruleSetFamily(item) === family);
      const draft = value.find((item) => item.state === "DRAFT" && ruleSetFamily(item) === family);
      setLeftId((current) => value.some((item) => item.id === current) ? current : (prior ?? draft ?? active)?.id ?? "");
      setRightId((current) => value.some((item) => item.id === current) ? current : active?.id ?? draft?.id ?? "");
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.versionsLoad")));
    } finally {
      setLoading(false);
    }
  }, [t]);
  const loadOlder=async()=>{
    const before=versions?.at(-1)?.id;if(!before||loadingOlder)return;setLoadingOlder(true);setError(null);
    try{const response=await fetch(`/api/rule-sets?limit=200&before=${encodeURIComponent(before)}`,{cache:"no-store"});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as RuleSetVersionRow[];setVersions(current=>[...(current??[]),...next.filter(item=>!current?.some(existing=>existing.id===item.id))]);setCanLoadOlder(next.length===200)}
    catch(problem){setError(operatorFailureMessage(problem, t("tenant.rules.errors.versionsLoad")))}finally{setLoadingOlder(false)}
  };
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const compare = async () => {
    if (!leftId || !rightId || comparing) return;
    setComparing(true);
    setError(null);
    setComparison(null);
    try {
      const response = await fetch(`/api/rule-sets/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(rightId)}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setComparison(await response.json() as RecordRow);
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.compare")));
    } finally {
      setComparing(false);
    }
  };
  const prepare = async (kind: "activate" | "rollback", target: RuleSetVersionRow) => {
    if (operating || cloneRequest.current?.pending) return;
    setError(null);
    setReadiness(null);
    setConfirmation("");
    readinessTarget.current = target.id;
    setOperation({ kind, target });
    try {
      const response = await fetch(`/api/rule-sets/${encodeURIComponent(target.id)}/readiness`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as RecordRow;
      // Ignore a readiness answer for a version the operator has already moved away from.
      if (readinessTarget.current === target.id) setReadiness(next);
    } catch (problem) {
      if (readinessTarget.current !== target.id) return;
      setOperation(null);
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.readiness")));
    }
  };
  const execute = async () => {
    if (!operation || operating || readiness?.ready !== true) return;
    const active = versions?.find((item) => item.state === "ACTIVE" && ruleSetFamily(item) === ruleSetFamily(operation.target));
    setOperating(true);
    setError(null);
    try {
      const body = operation.kind === "activate"
        ? { expectedRevision: Number(operation.target.revision), expectedActiveRuleSetId: active?.id ?? null, expectedActiveRevision: active ? Number(active.revision) : null }
        : { expectedSourceRevision: Number(operation.target.revision), expectedActiveRuleSetId: active?.id ?? null, expectedActiveRevision: active ? Number(active.revision) : null };
      const response = await fetch(`/api/rule-sets/${encodeURIComponent(operation.target.id)}/${operation.kind}`, {
        method: "POST",
        headers: idempotentHeaders(mutationHeaders),
        body: JSON.stringify(body),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      setNotice(t(operation.kind === "activate" ? "tenant.rules.notice.activated" : "tenant.rules.notice.restored", { version: formatNumber(operation.target.version, locale) }));
      setOperation(null);
      setReadiness(null);
      await load();
      changed();
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.operation")));
    } finally {
      setOperating(false);
    }
  };
  const cloneVersion = async (target: RuleSetVersionRow) => {
    if (operating || cloneRequest.current?.pending) return;
    if (cloneRequest.current && cloneRequest.current.sourceId !== target.id) return;
    const rules=(target.rules??[]).map((rule,index)=>({name:rule.name,matcherType:rule.matcherType,pattern:rule.pattern,matcherOptions:{...(rule.matcherOptions as Record<string,unknown>??{}),teamSenderPolicy:clonePolicies[`${target.id}:${index}`]??(rule.matcherOptions as Record<string,unknown>|undefined)?.teamSenderPolicy??"include"},priority:rule.priority,enabled:rule.enabled,savedExamples:rule.savedExamples}));
    const request = cloneRequest.current ?? { sourceId: target.id, key: crypto.randomUUID(), pending: false, body: JSON.stringify({rules}) };
    cloneRequest.current = request;
    setCloneSourceId(request.sourceId);
    request.pending = true;
    setOperating(true);setError(null);
    let rejected = false;
    try {
      const response = await fetch(`/api/rule-sets/${encodeURIComponent(target.id)}/clone`, {
        method: "POST", headers: { ...mutationHeaders, "idempotency-key": request.key }, body: request.body,
      });
      if (!response.ok) { rejected = response.status < 500; throw operatorLocalFailure(await apiError(response)); }
      const result = await response.json() as { resultId: string };
      cloneRequest.current = null;
      setCloneSourceId(null);
      setNotice(t("tenant.rules.notice.cloned"));setLeftId(result.resultId);
      await load();changed();
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("common.errors.network")));
      // A definite rejection releases the other clone actions; an unknown outcome keeps the retry key.
      if (rejected) { cloneRequest.current = null; setCloneSourceId(null); }
    } finally {
      request.pending = false;setOperating(false);
    }
  };
  const items = versions ?? [];
  const left = items.find((item) => item.id === leftId);
  const comparable = left ? items.filter((item) => ruleSetFamily(item) === ruleSetFamily(left) && item.id !== left.id) : items;
  const changes = Array.isArray(comparison?.changes) ? comparison.changes as RecordRow[] : [];
  const presentedChanges = changes.map((change) => {
    const fields = change.kind === "CHANGED" ? describeRuleChange(change) : [];
    return {
      change,
      fields,
      kind: change.kind === "CHANGED" && fields.length === 0 ? "UNCHANGED" : String(change.kind),
    };
  });
  const comparisonSummary = {
    added: presentedChanges.filter((change) => change.kind === "ADDED").length,
    removed: presentedChanges.filter((change) => change.kind === "REMOVED").length,
    changed: presentedChanges.filter((change) => change.kind === "CHANGED").length,
    unchanged: presentedChanges.filter((change) => change.kind === "UNCHANGED").length,
  };
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers as RecordRow[] : [];
  const warnings = Array.isArray(readiness?.warnings) ? readiness.warnings as RecordRow[] : [];
  return <ModalDialog close={operating ? () => {} : close} className="modal-backdrop" aria-labelledby="rule-history-title"><div className="modal rule-governance-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.rules.governance.eyebrow")}</span><h2 id="rule-history-title">{t("tenant.rules.governance.title")}</h2><p>{t("tenant.rules.governance.body")}</p></div><button disabled={operating} aria-label={t("tenant.rules.governance.close")} onClick={close}>×</button></div>
    {notice ? <div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div> : null}
    {error ? <div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p>{versions === null ? <button className="button small" disabled={loading} onClick={() => void load()}>{t("common.actions.retry")}</button> : <button className="text-button" onClick={() => setError(null)}>{t("tenant.rules.actions.dismiss")}</button>}</div> : null}
    {loading && versions === null ? <div className="review-loading" role="status"><span /><span /><b>{t("tenant.rules.governance.loading")}</b></div> : error && versions === null ? null : items.length ? <div className="rule-governance-body">
      <section className="rule-version-list" aria-labelledby="version-list-heading"><div className="connection-detail-section-head"><div><h3 id="version-list-heading">{t("tenant.rules.governance.history")}</h3><p>{t("tenant.rules.governance.historyBody")}</p></div><button className="button small secondary" disabled={loading} onClick={() => void load()}>{t(loading ? "tenant.rules.actions.refreshing" : "tenant.rules.actions.refresh")}</button></div>{items.map((item) => <article key={item.id}><span className="rule-version-number">{t("tenant.rules.versionShort")}<bdi>{formatNumber(item.version, locale)}</bdi></span><span><b><bdi>{item.name}</bdi></b><small><bdi>{formatNumber(Array.isArray(item.rules) ? item.rules.length : 0, locale)}</bdi> {t("tenant.rules.rulesCountLabel")} · {t("tenant.rules.revision")} <bdi>{formatNumber(item.revision, locale)}</bdi></small></span><Status value={item.state} /><span className="rule-version-actions">{canManage?(item.rules??[]).map((rule,index)=><label key={`${item.id}:${index}`}>{String(rule.name)} — {t("tenant.rules.teamPolicy")}<select disabled={operating||cloneSourceId!==null} value={clonePolicies[`${item.id}:${index}`]??String((rule.matcherOptions as Record<string,unknown>|undefined)?.teamSenderPolicy??"include")} onChange={event=>setClonePolicies(current=>({...current,[`${item.id}:${index}`]:event.target.value as "include"|"exclude"}))}><option value="include">{t("tenant.rules.teamPolicy.include")}</option><option value="exclude">{t("tenant.rules.teamPolicy.exclude")}</option></select></label>):null}{canManage ? <button className="button small secondary" disabled={operating || Boolean(cloneSourceId && cloneSourceId !== item.id)} onClick={() => void cloneVersion(item)}>{t(operating && cloneSourceId === item.id ? "tenant.rules.actions.recording" : "tenant.rules.actions.clone")}</button> : null}<button className="text-button" onClick={() => { setLeftId(item.id); setComparison(null); setRightId((current) => { const right = items.find((other) => other.id === current); return right && right.id !== item.id && ruleSetFamily(right) === ruleSetFamily(item) ? current : items.find((other) => other.id !== item.id && ruleSetFamily(other) === ruleSetFamily(item))?.id ?? ""; }); }}>{t("tenant.rules.actions.compare")}</button>{canManage && item.state === "DRAFT" ? <button className="button small" onClick={() => void prepare("activate", item)}>{t("tenant.rules.actions.activateEllipsis")}</button> : null}{canManage && item.state === "RETIRED" ? <button className="button small secondary" onClick={() => void prepare("rollback", item)}>{t("tenant.rules.actions.rollbackEllipsis")}</button> : null}</span></article>)}{canLoadOlder?<div className="audit-pagination"><button className="button secondary" disabled={loadingOlder} onClick={()=>void loadOlder()}>{t(loadingOlder?"tenant.rules.governance.loadingOlder":"tenant.rules.governance.loadOlder")}</button></div>:null}</section>
      <section className="rule-compare-panel" aria-labelledby="rule-compare-heading"><div className="connection-detail-section-head"><div><h3 id="rule-compare-heading">{t("tenant.rules.comparison.title")}</h3><p>{t("tenant.rules.comparison.body")}</p></div></div><div className="rule-compare-selectors"><label>{t("tenant.rules.comparison.from")}<select value={leftId} onChange={(event) => { setLeftId(event.target.value); setComparison(null); const selected = items.find((item) => item.id === event.target.value); const candidate = items.find((item) => selected && ruleSetFamily(item) === ruleSetFamily(selected) && item.id !== selected.id); setRightId(candidate?.id ?? ""); }}>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {t("tenant.rules.versionShort")}{formatNumber(item.version, locale)} · {t(`tenant.rules.state.${item.state.toLowerCase()}`)}</option>)}</select></label><span aria-hidden="true">→</span><label>{t("tenant.rules.comparison.to")}<select value={rightId} onChange={(event) => { setRightId(event.target.value); setComparison(null); }}>{comparable.map((item) => <option key={item.id} value={item.id}>{item.name} · {t("tenant.rules.versionShort")}{formatNumber(item.version, locale)} · {t(`tenant.rules.state.${item.state.toLowerCase()}`)}</option>)}</select></label><button className="button primary" disabled={!leftId || !rightId || leftId === rightId || comparing} onClick={() => void compare()}>{t(comparing ? "tenant.rules.actions.comparing" : "tenant.rules.actions.compare")}</button></div>{comparison ? <div className="rule-comparison-result"><div className="rule-comparison-summary"><span><b>{formatNumber(comparisonSummary.added, locale)}</b><small>{t("tenant.rules.comparison.added")}</small></span><span><b>{formatNumber(comparisonSummary.removed, locale)}</b><small>{t("tenant.rules.comparison.removed")}</small></span><span><b>{formatNumber(comparisonSummary.changed, locale)}</b><small>{t("tenant.rules.comparison.changed")}</small></span><span><b>{formatNumber(comparisonSummary.unchanged, locale)}</b><small>{t("tenant.rules.comparison.unchanged")}</small></span></div><div className="rule-change-list">{presentedChanges.map(({ change, fields, kind }, index) => <div key={`${String(change.name)}-${index}`}><Status value={kind} /><span><b><bdi>{String(change.name)}</bdi></b>{kind === "CHANGED" ? <ul className="rule-change-evidence" aria-label={t("tenant.rules.comparison.changedFields", { name: String(change.name) })}>{fields.map((field) => <li key={field.key}><bdi>{field.summary}</bdi></li>)}</ul> : <small>{t(kind === "UNCHANGED" && change.kind === "CHANGED" ? "tenant.rules.comparison.noMaterialChanges" : `tenant.rules.change.${kind.toLowerCase()}`)}</small>}</span></div>)}</div></div> : <div className="rule-history-empty"><span>◇</span><div><b>{t("tenant.rules.comparison.selectTwo")}</b><p>{t("tenant.rules.comparison.readOnly")}</p></div></div>}</section>
      {operation ? <InlineConfirmation busy={operating} className={`rule-operation-confirm ${operation.kind}`} aria-labelledby="rule-operation-title" cancel={() => { setOperation(null); setReadiness(null); setConfirmation(""); }}><div><span className="eyebrow">{t(operation.kind === "activate" ? "tenant.rules.operation.activation" : "tenant.rules.operation.rollback")}</span><h3 id="rule-operation-title">{t(operation.kind === "activate" ? "tenant.rules.operation.activateTitle" : "tenant.rules.operation.restoreTitle", { version: formatNumber(operation.target.version, locale) })}</h3><p>{t(operation.kind === "activate" ? "tenant.rules.operation.activateBody" : "tenant.rules.operation.restoreBody")}</p></div>{readiness ? <div className={`rule-readiness ${readiness.ready === true ? "ready" : "blocked"}`}><span>{readiness.ready === true ? "✓" : "!"}</span><div><b>{t(readiness.ready === true ? "tenant.rules.readiness.passed" : "tenant.rules.readiness.blocked")}</b><small><bdi>{formatNumber(Number(readiness.enabledRuleCount ?? 0), locale)}</bdi> {t("tenant.rules.readiness.enabledRules")} · <bdi>{formatNumber(Number(readiness.checkedExamples ?? 0), locale)}</bdi> {t("tenant.rules.readiness.examplesChecked")}</small></div></div> : <div className="review-loading compact" role="status"><span /><b>{t("tenant.rules.readiness.checking")}</b></div>}{blockers.length ? <ul className="rule-issue-list blockers">{blockers.map((item, index) => <li key={`${String(item.code)}-${index}`}><b>{ruleReadinessIssue(item.code, t)}</b></li>)}</ul> : null}{warnings.length ? <ul className="rule-issue-list warnings">{warnings.map((item, index) => <li key={`${String(item.code)}-${index}`}><b>{ruleReadinessIssue(item.code, t)}</b></li>)}</ul> : null}{operation.kind === "rollback" ? <label className="rule-rollback-confirmation">{t("tenant.rules.operation.typeRollback")} <code>{t("tenant.rules.operation.rollbackConfirmation")}</code> {t("tenant.rules.operation.typeRollbackSuffix")}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label> : null}<div className="modal-actions"><button className="button secondary" data-inline-confirm-initial-focus disabled={operating} onClick={() => { setOperation(null); setReadiness(null); setConfirmation(""); }}>{t("tenant.rules.actions.cancel")}</button><button className={operation.kind === "activate" ? "button primary" : "button connection-detail-danger-button"} disabled={operating || readiness?.ready !== true || (operation.kind === "rollback" && confirmation !== "ROLLBACK")} onClick={() => void execute()}>{t(operating ? "tenant.rules.actions.recording" : operation.kind === "activate" ? "tenant.rules.actions.activateVersion" : "tenant.rules.actions.createRollback")}</button></div></InlineConfirmation> : null}
    </div> : <Empty title={t("tenant.rules.empty.title")} body={t("tenant.rules.empty.body")} />}
  </div></ModalDialog>;
}

function ruleSetFamily(item: RuleSetVersionRow) {
  return String(item.family_id ?? item.familyId ?? "");
}

/* eslint-disable jsx-a11y/label-has-associated-control -- translated text and nested controls are associated structurally */
function RuleModal({
  close,
  saved,
  mutationHeaders,
}: {
  close: () => void;
  saved: () => void;
  mutationHeaders: Record<string, string>;
}) {
  const { t } = useI18n();
  const saveKey = useRef<{ body: string; key: string } | null>(null);
  const [form, setForm] = useState({
    name: "",
    matcherType: "exact_length" as TriggerRule["matcherType"],
    pattern: "",
    prefix: "",
    digitLength: 10,
    teamSenderPolicy: "include" as "include" | "exclude",
    groupCommand: false,
    actionId: "",
    successReply: t("tenant.rules.command.successDefault"),
    failureReply: t("tenant.rules.command.failureDefault"),
  });
  const [commandInputs,setCommandInputs]=useState([{key:"query",value:"{{message.argument}}"}]);
  const [commandActions,setCommandActions]=useState<Array<{action_key:string;name:string}>>([]);
  const [sample, setSample] = useState(t("tenant.rules.modal.sampleDefault"));
  const [testedSignature, setTestedSignature] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ normalized?: string; matches?: RuleMatch[] } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidatePattern = form.matcherType === "exact_length"
    ? `(?<!\\d)\\d{${form.digitLength}}(?!\\d)`
    : form.matcherType === "prefix_length"
      ? `\\b${form.prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\d{${form.digitLength}}\\b`
      : form.pattern;
  const candidate = {
    id: "candidate-rule",
    name: form.name.trim(),
    teamSenderPolicy: form.teamSenderPolicy,
    matcherType: form.matcherType,
    pattern: candidatePattern,
    prefix: form.matcherType === "prefix_length" ? form.prefix.trim() : null,
    digitLength: ["exact_length", "prefix_length"].includes(form.matcherType) ? Number(form.digitLength) : null,
    priority: 10,
    enabled: true,
    matchCount: 0,
    version: 1,
    ...(form.groupCommand?{groupCommand:{actionId:form.actionId,input:Object.fromEntries(commandInputs.filter(row=>row.key.trim()).map(row=>[row.key.trim(),row.value])),successReply:form.successReply,failureReply:form.failureReply}}:{}),
  } satisfies TriggerRule;
  const signature = JSON.stringify({ candidate, sample });
  const safeTestCurrent = testedSignature === signature && Boolean(testResult?.matches?.length);
  const updateForm = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTestedSignature(null);
    setTestResult(null);
    setError(null);
  };
  useEffect(()=>{if(!form.groupCommand)return;let active=true;void fetch("/api/bot-flows/actions",{cache:"no-store"}).then(async response=>{if(!response.ok)throw operatorLocalFailure(await apiError(response));return response.json() as Promise<Array<Record<string,unknown>>|{actions:Array<Record<string,unknown>>}>}).then(value=>{if(!active)return;const rows=Array.isArray(value)?value:value.actions??[];const actions=rows.filter(row=>row.state==="ACTIVE"&&hasBotActionCapability(row,"GROUP_COMMAND")).map(row=>({action_key:String(row.action_key),name:String(row.name)}));setCommandActions(actions);setForm(current=>current.actionId||!actions[0]?current:{...current,actionId:actions[0].action_key})}).catch(()=>{if(active)setError(t("tenant.rules.errors.actions"))});return()=>{active=false}},[form.groupCommand,t]);
  const testCandidate = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await fetch("/api/rules/test", {
        method: "POST",
        headers: idempotentHeaders(mutationHeaders),
        body: JSON.stringify({ message: sample, sender: "customer", rules: [candidate] }),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const result = await response.json() as { normalized?: string; matches?: RuleMatch[] };
      if (!result.matches?.length) throw operatorLocalFailure(t("tenant.rules.errors.noReference"));
      setTestResult(result);
      setTestedSignature(signature);
    } catch (problem) {
      setTestedSignature(null);
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.safeTest")));
    } finally {
      setTesting(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !safeTestCurrent || saving) {
      setError(t("tenant.rules.errors.testBeforeSave"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = JSON.stringify({
        ...candidate,
        savedExamples: [{
          name: t("tenant.rules.modal.creationValidation"),
          message: sample,
          sender: "customer",
          expectedMatches: testResult?.matches?.map((match) => match.normalizedValue) ?? [],
        }],
      });
      // Retrying the same rule after a lost response reuses its key, so the server cannot create it twice.
      if (saveKey.current?.body !== body) saveKey.current = { body, key: crypto.randomUUID() };
      const r = await fetch("/api/rules", {
        method: "POST",
        headers: { ...mutationHeaders, "idempotency-key": saveKey.current.key },
        body,
      });
      if (!r.ok) throw operatorLocalFailure(await apiError(r));
      saveKey.current = null;
      saved();
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.rules.errors.save")));
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModalDialog
      close={close}
      className="modal-backdrop"
      aria-labelledby="create-rule-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <div>
            <span className="eyebrow">{t("tenant.rules.modal.eyebrow")}</span>
            <h2 id="create-rule-title">{t("tenant.rules.modal.title")}</h2>
            <p>{t("tenant.rules.modal.body")}</p>
          </div>
          <button type="button" aria-label={t("tenant.rules.modal.close")} onClick={close}>
            ×
          </button>
        </div>
        <label>
          {t("tenant.rules.modal.name")}
          <input
            required
            value={form.name}
            onChange={(e) => updateForm("name", e.target.value)}
            placeholder={t("tenant.rules.modal.namePlaceholder")}
          />
        </label>
        <label>
          {t("tenant.rules.modal.matcherType")}
          <select
            value={form.matcherType}
            onChange={(e) => updateForm("matcherType", e.target.value as TriggerRule["matcherType"])}
          >
            <option value="exact_length">{t("tenant.rules.matcher.exact_length")}</option>
            <option value="prefix_length">{t("tenant.rules.matcher.prefix_length")}</option>
            <option value="starts_with">{t("tenant.rules.matcher.starts_with")}</option>
            <option value="contains">{t("tenant.rules.matcher.contains")}</option>
            <option value="advanced">{t("tenant.rules.matcher.advanced")}</option>
          </select>
        </label>
        <label htmlFor="rule-team-policy">{t("tenant.rules.teamPolicy")}<select id="rule-team-policy" value={form.teamSenderPolicy} onChange={(event)=>updateForm("teamSenderPolicy",event.target.value as "include"|"exclude")}><option value="include">{t("tenant.rules.teamPolicy.include")}</option><option value="exclude">{t("tenant.rules.teamPolicy.exclude")}</option></select><small>{t("tenant.rules.teamPolicy.help")}</small></label>
        {form.matcherType === "exact_length" || form.matcherType === "prefix_length" ? <div className="rule-modal-grid">{form.matcherType === "prefix_length" ? <label>{t("tenant.rules.modal.prefix")}<input required maxLength={64} value={form.prefix} onChange={(event) => updateForm("prefix", event.target.value)} placeholder={t("tenant.rules.modal.prefixPlaceholder")} /></label> : null}<label>{t("tenant.rules.modal.digitLength")}<input type="number" min={1} max={64} value={form.digitLength} onChange={(event) => updateForm("digitLength", Number(event.target.value))} /></label></div> : <label>{t(form.matcherType === "advanced" ? "tenant.rules.modal.safeExpression" : "tenant.rules.modal.literalPattern")}<input className="mono" required maxLength={240} value={form.pattern} onChange={(event) => updateForm("pattern", event.target.value)} placeholder={t(form.matcherType === "advanced" ? "tenant.rules.modal.advancedPlaceholder" : "tenant.rules.modal.literalPlaceholder")} /><small>{t(form.matcherType === "advanced" ? "tenant.rules.modal.advancedHelp" : "tenant.rules.modal.literalHelp")}</small></label>}
        <fieldset className="rule-command-config"><legend>{t("tenant.rules.command.title")}</legend><label className="check"><input type="checkbox" checked={form.groupCommand} onChange={event=>{const enabled=event.target.checked;setForm(current=>({...current,groupCommand:enabled,...(enabled?{matcherType:"starts_with",pattern:"/status"}:{}),actionId:current.actionId||commandActions[0]?.action_key||""}));if(enabled)setSample("/status ORD-42");setTestedSignature(null);setTestResult(null);setError(null)}}/><span><b>{t("tenant.rules.command.enable")}</b><small>{t("tenant.rules.command.enableBody")}</small></span></label>{form.groupCommand?<div className="rule-command-fields"><label>{t("tenant.rules.command.action")}<select required value={form.actionId} onChange={event=>updateForm("actionId",event.target.value)}><option value="">{t("tenant.rules.command.selectAction")}</option>{commandActions.map(action=><option key={action.action_key} value={action.action_key}>{action.name}</option>)}</select><small>{commandActions.length?t("tenant.rules.command.getOnly"):t("tenant.rules.command.noActions")}</small></label><div><b>{t("tenant.rules.command.input")}</b><small>{t("tenant.rules.command.inputBody")}</small>{commandInputs.map((row,index)=><div className="rule-command-input" key={index}><input aria-label={t("tenant.rules.command.inputKey")} placeholder={t("tenant.rules.command.inputKey")} value={row.key} maxLength={128} onChange={event=>{setCommandInputs(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,key:event.target.value}:item));setTestedSignature(null)}}/><input aria-label={t("tenant.rules.command.inputValue")} placeholder="{{message.argument}}" value={row.value} maxLength={500} onChange={event=>{setCommandInputs(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,value:event.target.value}:item));setTestedSignature(null)}}/><button type="button" className="button small secondary" disabled={commandInputs.length===1} onClick={()=>setCommandInputs(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>{t("tenant.rules.command.remove")}</button></div>)}<button type="button" className="text-button" onClick={()=>setCommandInputs(current=>[...current,{key:"",value:""}])}>{t("tenant.rules.command.addInput")}</button></div><label>{t("tenant.rules.command.successReply")}<textarea rows={2} required maxLength={1000} value={form.successReply} onChange={event=>updateForm("successReply",event.target.value)}/></label><label>{t("tenant.rules.command.failureReply")}<textarea rows={2} required maxLength={1000} value={form.failureReply} onChange={event=>updateForm("failureReply",event.target.value)}/></label><p className="form-note">{t("tenant.rules.command.variables")}</p></div>:null}</fieldset>
        <label>{t("tenant.rules.modal.representativeMessage")}<textarea rows={3} required value={sample} onChange={(event) => { setSample(event.target.value); setTestedSignature(null); setTestResult(null); setError(null); }} /></label>
        <div className="candidate-expression"><small>{t("tenant.rules.modal.generatedExpression")}</small><code><bdi>{candidatePattern || t("tenant.rules.modal.addPattern")}</bdi></code></div>
        {error ? <div className="settings-feedback error rule-modal-feedback" role="alert"><span>!</span><p>{error}</p></div> : null}
        {safeTestCurrent ? <div className="settings-feedback success rule-modal-feedback" role="status"><span>✓</span><p>{t("tenant.rules.modal.testPassed")} <bdi>{testResult?.matches?.map((match) => match.normalizedValue).join(", ")}</bdi>.</p></div> : <div className="rule-test-required" role="status"><span>◇</span><p><b>{t("tenant.rules.modal.testRequired")}</b><small>{t("tenant.rules.modal.testRequiredBody")}</small></p></div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            {t("tenant.rules.actions.cancel")}
          </button>
          <button type="button" className="button" disabled={testing || saving || !form.name.trim() || !sample.trim()} onClick={() => void testCandidate()}>{t(testing ? "tenant.rules.actions.testingSafely" : "tenant.rules.actions.runSafeTest")}</button>
          <button className="button primary" disabled={!form.name.trim() || !safeTestCurrent || saving}>{t(saving ? "tenant.rules.actions.saving" : "tenant.rules.actions.saveRule")}</button>
        </div>
      </form>
    </ModalDialog>
  );
}

function countForm(count: number) {
  if (count === 0) return "zero";
  if (count === 1) return "one";
  return "many";
}

/* eslint-enable jsx-a11y/label-has-associated-control */
function DeliveryTable({
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
      <table>
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

function Deliveries({
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
    {/* Keyboard users must be able to focus and scroll this overflow region. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    {loading?<div className="review-loading" role="status"><span/><span/><b>{t("tenant.deliveries.detail.loading")}</b></div>:error?<div className="connection-detail-error" role="alert"><span>!</span><div><b>{t("tenant.deliveries.detail.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("tenant.deliveries.actions.retry")}</button></div></div>:detail?<div className="operational-drawer-body" role="region" aria-labelledby="delivery-detail-title" tabIndex={0}>
<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.detail.currentState")}</h3><p>{t("tenant.deliveries.detail.currentStateBody")}</p></div><Status value={detail.state}/></div><dl className="connection-detail-facts"><div><dt>{t("tenant.deliveries.detail.channel")}</dt><dd>WhatsApp</dd></div><div><dt>{t("tenant.deliveries.table.group")}</dt><dd><bdi>{String(detail.group_name)}</bdi></dd></div><div><dt>{t("tenant.deliveries.detail.attempts")}</dt><dd>{formatNumber(Number(detail.attempts),locale)}</dd></div>{detail.hold_reason?<><div><dt>{t("tenant.deliveries.hold.reasonLabel")}</dt><dd>{deliveryHoldReason(detail,t)}</dd></div>{detail.available_at&&detail.hold_reason!=="WAITING_FOR_EARLIER_DELIVERY"?<div><dt>{t("tenant.deliveries.hold.nextAttempt")}</dt><dd><RelativeTime value={detail.available_at}/></dd></div>:null}{detail.hold_expires_at&&detail.hold_reason!=="WAITING_FOR_EARLIER_DELIVERY"?<div><dt>{t("tenant.deliveries.hold.expires")}</dt><dd><RelativeTime value={detail.hold_expires_at}/></dd></div>:null}</>:null}</dl>{detail.safe_error?<p className={`connection-detail-operation-error ${deliveryRetriesAutomatically(detail.state)?"delivery-pending-text":""}`}>{t(deliveryFailureGuidance(detail)??(deliveryRetriesAutomatically(detail.state)?"tenant.deliveries.automaticRetry":"tenant.errors.deliveryReview"))}</p>:null}</section>
      {detail.ordering_predecessor_id?<a className="button secondary" href={`/app?view=deliveries&delivery=${encodeURIComponent(String(detail.ordering_predecessor_id))}`}>{t("tenant.deliveries.hold.inspectEarlier")}</a>:null}
      {canRetry?<DeliveryStopRetry detail={detail} mutationHeaders={mutationHeaders} changed={async()=>{setDetail(current=>current?{...current,manual_retry_allowed:false,retry_stopped:true}:current);await load(true)}} busy={setMutationPending}/>:detail.retry_stopped?<p className="tag">{t("tenant.deliveries.stopRetry.stopped")}</p>:null}
<section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.detail.receiptTimeline")}</h3><p>{t("tenant.deliveries.detail.receiptTimelineBody")}</p></div><span className="tag">{formatNumber(detail.receipts?.length??0,locale)} {t((detail.receipts?.length??0)===1?"tenant.deliveries.detail.receipts.one":"tenant.deliveries.detail.receipts")}</span></div>{detail.receipts?.length?<div className="receipt-timeline">{detail.receipts.map(receipt=>{const observed=receipt.receipt_scope==="PARTICIPANT_OBSERVED";return <div className="receipt-event" key={String(receipt.id)}><span className={`receipt-node ${receipt.applied_state==="IGNORED"||observed?"muted":""}`}/><div><div><Status value={receipt.receipt_status}/>{observed?<span className="tag">{t("tenant.deliveries.detail.participantObserved")}</span>:null}</div><p>{t(observed?"tenant.deliveries.detail.observedBody":receipt.applied_state==="IGNORED"?"tenant.deliveries.detail.ignoredBody":"tenant.deliveries.detail.appliedAs",{state:t(`tenant.deliveries.detail.applied.${String(receipt.applied_state).toLowerCase()}`)})}</p><small><RelativeTime value={receipt.provider_timestamp} pastOnly/></small></div></div>})}</div>:<Empty title={t("tenant.deliveries.detail.noReceipts")} body={t("tenant.deliveries.detail.noReceiptsBody")}/>}</section>
      <section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.deliveries.detail.sendAttempts")}</h3><p>{t("tenant.deliveries.detail.sendAttemptsBody")}</p></div></div><div className="attempt-list">{detail.delivery_attempts?.map(attempt=><div key={String(attempt.id)}><span><b>{t("tenant.deliveries.detail.attempt")} {formatNumber(Number(attempt.attempt_number),locale)}</b><small><RelativeTime value={attempt.started_at} pastOnly/></small></span><Status value={attempt.state}/></div>)}</div></section>
    </div>:null}
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
    {/* Keyboard users must be able to focus and scroll this overflow region. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    {loading?<div className="review-loading" role="status"><span/><span/><b>{t("tenant.deliveries.review.loadingEvidence")}</b></div>:error?<div className="connection-detail-error" role="alert"><span>!</span><div><b>{t("tenant.deliveries.review.itemUnavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("tenant.deliveries.actions.retry")}</button></div></div>:detail?<div className="operational-drawer-body" role="region" aria-labelledby="review-detail-title" tabIndex={0}>
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
    </div>:null}
  </div></ModalDialog>;
}

type SupportAccessRequest = RecordRow & {
  id: string;
  operator_email: string;
  operator_display_name: string;
  reason: string;
  scope: string;
  requested_duration_seconds: number;
  state: string;
  requested_at: string;
  request_expires_at: string;
  access_expires_at?: string | null;
  decision_reason?: string | null;
  version: number;
};

function SupportAccess({
  canApprove,
  mutationHeaders,
}: {
  canApprove: boolean;
  mutationHeaders: Record<string, string>;
}) {
  const { locale, t } = useI18n();
  const [rows, setRows] = useState<SupportAccessRequest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SupportAccessRequest | null>(null);
  const loadFence = useRef(createLatestRequestFence());
  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    const request = loadFence.current.begin();
    const isCurrent = () => !signal?.aborted && loadFence.current.isCurrent(request);
    if (!background) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/support-access", { cache: "no-store", signal });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const value = await response.json() as SupportAccessRequest[];
      if (!isCurrent()) return;
      setRows(value);
      setSelected((current) => current ? value.find((item) => item.id === current.id) ?? null : null);
    } catch (problem) {
      if (isCurrent() && !isAbortError(problem)) setError(operatorFailureMessage(problem, t("tenant.support.errors.load")));
    } finally {
      if (!background && isCurrent()) setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    const fence = loadFence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(false, controller.signal), 0);
    return () => { controller.abort(); window.clearTimeout(timer); fence.invalidate(); };
  }, [load]);
  useVisibleRefresh((signal) => load(true, signal), selected === null);
  const requests = rows ?? [];
  const pending = requests.filter((item) => item.state === "PENDING").length;
  const approved = requests.filter((item) => item.state === "APPROVED").length;
  return (
    <div className="support-layout">
      <section className="support-summary" aria-label={t("tenant.support.summaryLabel")}>
        <div><small>{t("tenant.support.pendingDecision")}</small><strong>{formatNumber(pending,locale)}</strong><span>{t(pending ? "tenant.support.accessBlocked" : "tenant.support.noneWaiting")}</span></div>
        <div><small>{t("tenant.support.activeSessions")}</small><strong>{formatNumber(approved,locale)}</strong><span>{t("tenant.support.maxOneHour")}</span></div>
        <div><small>{t("tenant.support.authorizedScope")}</small><strong className="support-scope-value">{t("tenant.support.operationalMetadata")}</strong><span>{t("tenant.support.noMessageContent")}</span></div>
      </section>
      <section className="panel support-boundary" aria-labelledby="support-boundary-title">
        <div className="panel-heading"><div><h2 id="support-boundary-title">{t("tenant.support.boundaryTitle")}</h2><p>{t("tenant.support.boundaryBody")}</p></div><span className="status status-success"><i />{t("tenant.support.metadataOnly")}</span></div>
        <div className="support-boundary-grid">
          <div><b>{t("tenant.support.visibleTitle")}</b><ul><li>{t("tenant.support.visibleConnections")}</li><li>{t("tenant.support.visibleDeliveries")}</li><li>{t("tenant.support.visibleRouting")}</li></ul></div>
          <div><b>{t("tenant.support.neverVisibleTitle")}</b><ul><li>{t("tenant.support.neverMessages")}</li><li>{t("tenant.support.neverDetails")}</li><li>{t("tenant.support.neverCredentials")}</li></ul></div>
        </div>
        <p className="support-origin-note"><span>i</span>{t("tenant.support.originNote")}</p>
      </section>
      <section className="panel table-panel support-requests">
        <div className="panel-heading"><div><h2>{t("tenant.support.requestsTitle")}</h2><p>{t("tenant.support.requestsBody")}</p></div></div>
        {loading && rows === null ? <div className="review-loading" role="status"><span /><span /><b>{t("tenant.support.loading")}</b></div>
          : error && rows === null ? <div className="connection-detail-error" role="alert"><span>!</span><div><b>{t("tenant.support.unavailable")}</b><p>{error}</p><button className="button small" onClick={() => void load()}>{t("tenant.support.actions.retry")}</button></div></div>
            : requests.length ? <WideTable><table><thead><tr><th>{t("tenant.support.operator")}</th><th>{t("tenant.support.reason")}</th><th>{t("tenant.support.requested")}</th><th>{t("tenant.support.status")}</th><th>{t("tenant.support.requestedAt")}</th><th><span className="sr-only">{t("tenant.support.action")}</span></th></tr></thead><tbody>{requests.map((item) => <tr key={item.id}><td><div className="cell-main"><span className="avatar small">{item.operator_display_name.split(/\s+/u).map((part) => part[0]).join("").slice(0, 2)}</span><span><b><bdi>{item.operator_display_name}</bdi></b><small><bdi>{item.operator_email}</bdi></small></span></div></td><td><span className="support-reason"><bdi>{item.reason}</bdi></span></td><td>{formatDuration(Number(item.requested_duration_seconds),locale)}</td><td><Status value={item.state} /></td><td><RelativeTime value={item.requested_at} pastOnly/></td><td><button className="button small secondary" onClick={() => setSelected(item)}>{t("tenant.support.actions.review")}</button></td></tr>)}</tbody></table></WideTable>
              : error ? null : <Empty title={t("tenant.support.emptyTitle")} body={t("tenant.support.emptyBody")} />}
        {error && rows !== null ? <div className="review-inline-error" role="alert"><span>{t("tenant.data.refreshFailed")}</span><button className="text-button" onClick={() => void load()}>{t("tenant.support.actions.retry")}</button></div> : null}
      </section>
      {selected ? <SupportAccessDrawer request={selected} canApprove={canApprove} mutationHeaders={mutationHeaders} close={() => setSelected(null)} changed={async (value) => { setSelected(value); await load(); }} /> : null}
    </div>
  );
}

function SupportAccessDrawer({
  request,
  canApprove,
  mutationHeaders,
  close,
  changed,
}: {
  request: SupportAccessRequest;
  canApprove: boolean;
  mutationHeaders: Record<string, string>;
  close: () => void;
  changed: (value: SupportAccessRequest) => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [action, setAction] = useState<"approve" | "deny" | "revoke" | null>(null);
  const [minutes, setMinutes] = useState(String(Math.max(5, Math.floor(Number(request.requested_duration_seconds) / 60))));
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async () => {
    if (!action || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/support-access/${encodeURIComponent(request.id)}/${action}`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({
          expectedVersion: Number(request.version),
          ...(action === "approve" ? { durationSeconds: Number(minutes) * 60 } : { reason: reason.trim() }),
        }),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      await changed(await response.json() as SupportAccessRequest);
      setAction(null);
    } catch (problem) {
      setError(operatorFailureMessage(problem, t("tenant.support.errors.decision")));
    } finally {
      setPending(false);
    }
  };
  const active = request.state === "APPROVED";
  // Keyboard users must be able to focus and scroll this overflow region.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
  return <ModalDialog close={pending ? () => {} : close} className="modal-backdrop group-drawer-backdrop" aria-labelledby="support-access-title" onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) close(); }}><div className="modal group-drawer operational-drawer"><div className="modal-head group-drawer-head"><div><span className="eyebrow">{t("tenant.support.drawer.eyebrow")}</span><h2 id="support-access-title"><bdi>{request.operator_display_name}</bdi></h2><p><bdi>{request.operator_email}</bdi></p></div><button disabled={pending} aria-label={t("tenant.support.drawer.close")} onClick={close}>×</button></div><div className="operational-drawer-body" role="region" aria-labelledby="support-access-title" tabIndex={0}>
    {!canApprove ? <div className="group-config-readonly"><span>i</span><p><b>{t("tenant.support.drawer.readOnly")}</b>{t("tenant.support.drawer.readOnlyBody")}</p></div> : null}
    {error ? <div className="connection-detail-alert connection-detail-alert-danger" role="alert"><span>!</span><div><b>{t("tenant.support.drawer.decisionUnconfirmed")}</b><p>{error}</p>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=support")}>{t("tenant.support.actions.reauthenticate")}</a>:null}</div></div> : null}
    <section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.support.drawer.investigation")}</h3><p><bdi>{request.reason}</bdi></p></div><Status value={request.state} /></div><dl className="support-request-facts"><div><dt>{t("tenant.support.drawer.scope")}</dt><dd>{t(`tenant.support.scope.${request.scope.toLowerCase()}`)}</dd></div><div><dt>{t("tenant.support.drawer.requestedDuration")}</dt><dd>{formatDuration(Number(request.requested_duration_seconds),locale)}</dd></div><div><dt>{t("tenant.support.drawer.requestExpires")}</dt><dd>{exactTime(request.request_expires_at, locale, t("tenant.time.invalid"))}</dd></div>{active ? <div><dt>{t("tenant.support.drawer.accessExpires")}</dt><dd>{exactTime(request.access_expires_at, locale, t("tenant.time.invalid"))}</dd></div> : null}</dl></section>
    <section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.support.drawer.evidenceTitle")}</h3><p>{t("tenant.support.drawer.evidenceBody")}</p></div></div><div className="support-metadata-preview"><span><b>{t("tenant.support.drawer.connectionHealth")}</b><small>{t("tenant.support.drawer.connectionHealthBody")}</small></span><span><b>{t("tenant.support.drawer.deliveryHealth")}</b><small>{t("tenant.support.drawer.deliveryHealthBody")}</small></span><span><b>{t("tenant.support.drawer.auditMetadata")}</b><small>{t("tenant.support.drawer.auditMetadataBody")}</small></span></div></section>
    {request.decision_reason ? <section className="connection-detail-section"><div className="connection-detail-section-head"><div><h3>{t("tenant.support.drawer.decisionReason")}</h3><p><bdi>{request.decision_reason}</bdi></p></div></div></section> : null}
    {canApprove && request.state === "PENDING" && !action ? <div className="support-decision-actions"><button className="button secondary" onClick={() => setAction("deny")}>{t("tenant.support.actions.denyEllipsis")}</button><button className="button primary" onClick={() => setAction("approve")}>{t("tenant.support.actions.approveEllipsis")}</button></div> : null}
    {canApprove && active && !action ? <div className="support-decision-actions"><button className="button connection-detail-danger-button" onClick={() => setAction("revoke")}>{t("tenant.support.actions.revokeEllipsis")}</button></div> : null}
    {action ? <InlineConfirmation busy={pending} className={`support-decision-confirm ${action === "approve" ? "approve" : "danger"}`} aria-labelledby="support-decision-title" cancel={() => { setAction(null); setError(null); }}><div><h3 id="support-decision-title">{t(action === "approve" ? "tenant.support.drawer.approveTitle" : action === "deny" ? "tenant.support.drawer.denyTitle" : "tenant.support.drawer.revokeTitle")}</h3><p>{t(action === "approve" ? "tenant.support.drawer.approveBody" : "tenant.support.drawer.reasonBody")}</p></div>{action === "approve" ? <label>{t("tenant.support.drawer.grantedMinutes")}<input type="number" min={5} max={Math.floor(Number(request.requested_duration_seconds) / 60)} value={minutes} onChange={(event) => setMinutes(event.target.value)} /></label> : <label>{t("tenant.support.drawer.decisionReason")}<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder={t("tenant.support.drawer.reasonPlaceholder")} /></label>}<div><button className="button secondary" data-inline-confirm-initial-focus disabled={pending} onClick={() => { setAction(null); setError(null); }}>{t("tenant.support.actions.cancel")}</button><button className={action === "approve" ? "button primary" : "button connection-detail-danger-button"} disabled={pending || (action !== "approve" && reason.trim().length < 3) || (action === "approve" && (Number(minutes) < 5 || Number(minutes) * 60 > Number(request.requested_duration_seconds)))} onClick={() => void decide()}>{t(pending ? "tenant.support.actions.recording" : action === "approve" ? "tenant.support.actions.approve" : action === "deny" ? "tenant.support.actions.deny" : "tenant.support.actions.revoke")}</button></div></InlineConfirmation> : null}
  </div></div></ModalDialog>;
}

function friendlyAuditAction(value: unknown, t: TenantTranslator) {
  const action = String(value ?? "");
  if (action === "connection.reauth_requested") return t("tenant.audit.action.connectionReauthentication");
  if (action === "connection.meta_number_released") return t("tenant.audit.action.metaNumberReleased");
  if (action === "delivery.retry_scheduled") return t("tenant.audit.action.deliveryRetryScheduled");
  if (action === "bot_action.qualification_queued") return t("tenant.audit.action.pluginActionTested");
  const knownAction = ({
    "bot_action.created": "tenant.audit.action.pluginActionCreated",
    "bot_action.updated": "tenant.audit.action.pluginActionUpdated",
    "bot_action.restored": "tenant.audit.action.pluginActionRestored",
    "bot_action.credential_staged": "tenant.audit.action.pluginCredentialPrepared",
    "group_workspace.ticket_linked": "tenant.audit.action.groupTicketLinked",
    "group_workspace.read": "tenant.audit.action.groupRead",
    "group_workspace.message_queued": "tenant.audit.action.groupMessageQueued",
    "group_workspace.reaction_queued": "tenant.audit.action.groupReactionQueued",
    "group_workspace.reaction_removal_queued": "tenant.audit.action.groupReactionRemovalQueued",
    "workspace_email.route_pinned": "tenant.audit.action.mailRoutePinned",
    "workspace_email.route_applied": "tenant.audit.action.mailRouteApplied",
    "workspace_email.route_manually_overridden": "tenant.audit.action.mailRouteOverridden",
    "delivery.retry_requested_from_workspace": "tenant.audit.action.workspaceDeliveryRetry",
  } as Record<string, string>)[action];
  if (knownAction) return t(knownAction);
  const root = action.startsWith("bot_action.") ? "plugin" : action.split(/[._]/u, 1)[0];
  const category = ({
    audit: "audit",
    case: "case",
    client: "routing",
    conversation: "bot",
    review: "review",
    waha: "connection",
    zammad: "workspaceIntegration",
  } as Record<string, string>)[root] ?? root;
  return t([
    "audit", "bot", "case", "connection", "delivery", "group", "invitation", "plugin", "privacy", "review", "routing", "rule", "settings", "support", "team", "workspaceIntegration",
  ].includes(category) ? `tenant.audit.category.${category}` : "tenant.audit.category.workspace");
}

function Audit({ rows, showDiagnostics, canExport }: { rows: RecordRow[]; showDiagnostics: boolean; canExport: boolean }) {
  const { locale, t } = useI18n();
  const [entries, setEntries] = useState(rows);
  const [query, setQuery] = useState("");
  const [canLoadOlder, setCanLoadOlder] = useState(rows.length === 100);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadedOlder, setLoadedOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const [exportOpen, setExportOpen] = useState(false);
  const [from, setFrom] = useState(() => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [limit, setLimit] = useState("5000");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [includeRoutine, setIncludeRoutine] = useState(false);
  const [scopeLoading, setScopeLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setEntries((current) => {
        const incoming = new Set(rows.map((row) => String(row.id)));
        return [...rows, ...current.filter((row) => !incoming.has(String(row.id)))];
      });
    });
    return () => { cancelled = true; };
  }, [rows]);
  const presentation = (row: RecordRow) => {
    const action = String(row.action ?? "");
    const detail = String(row.detail ?? "");
    const target = String(row.target ?? "");
    const actorType = String(row.actor_type ?? "");
    const human = ["USER", "WORKSPACE_USER", "WORKSPACE_AGENT", "PLATFORM_OPERATOR"].includes(actorType);
    const displayName = actorType === "USER" ? String(row.actor_display_name ?? row.actor ?? "").trim() : "";
    const actorName = human
      ? displayName && !isOpaqueIdentifier(displayName) ? displayName : t(actorType === "PLATFORM_OPERATOR" ? "tenant.audit.actor.support" : actorType === "WORKSPACE_AGENT" ? "tenant.audit.actor.agent" : "tenant.audit.actor.member")
      : t("tenant.audit.actor.automation");
    const actorId = String(row.actor_id ?? "");
    const actor = showDiagnostics && actorId && actorId !== actorName ? `${actorName} · ${actorId}` : actorName;
    const visibleDetail = detail && detail !== action && (showDiagnostics || !isOpaqueIdentifier(detail)) ? detail : "";
    const visibleTarget = showDiagnostics || !isOpaqueIdentifier(target) ? target : "";
    return {
      action: friendlyAuditAction(action, t),
      actor,
      detail: visibleDetail,
      target: visibleDetail || showDiagnostics ? visibleTarget : "",
    };
  };
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const filteredEntries = normalizedQuery
    ? entries.filter((row) => Object.values(presentation(row)).some((value) => value.toLocaleLowerCase(locale).includes(normalizedQuery)))
    : entries;
  const loadOlder = async () => {
    const last = entries.at(-1);
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    setLoadError(null);
    try {
      const query = new URLSearchParams({ cursor: String(last.created_at), cursorId: String(last.id), routine: includeRoutine ? "include" : "exclude" });
      const response = await fetch(`/api/audit?${query}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as RecordRow[];
      setEntries((current) => {
        const known = new Set(current.map((row) => String(row.id)));
        return [...current, ...next.filter((row) => !known.has(String(row.id)))];
      });
      setCanLoadOlder(next.length === 100);
      setLoadedOlder(true);
    } catch {
      setLoadError(t("tenant.audit.errors.loadOlder"));
    } finally {
      setLoadingOlder(false);
    }
  };
  const changeRoutineScope = async (next: boolean) => {
    if (scopeLoading || next === includeRoutine) return;
    setScopeLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/audit?routine=${next ? "include" : "exclude"}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const replacement = await response.json() as RecordRow[];
      setEntries(replacement);
      setCanLoadOlder(replacement.length === 100);
      setLoadedOlder(false);
      setIncludeRoutine(next);
    } catch {
      setLoadError(t("tenant.audit.errors.refresh"));
    } finally {
      setScopeLoading(false);
    }
  };
  const exportCsv = async (event: React.FormEvent) => {
    event.preventDefault();
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const query = new URLSearchParams({
        from: new Date(`${from}T00:00:00.000Z`).toISOString(),
        to: new Date(`${to}T23:59:59.999Z`).toISOString(),
        limit,
      });
      const response = await fetch(`/api/audit/export?${query}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition");
      const filename = disposition?.match(/filename="([A-Za-z0-9._-]+)"/u)?.[1] ?? `wasalx-audit-${from}-${to}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.documentElement.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      setExportNotice(t("tenant.audit.export.notice", { from: formatDateTime(new Date(`${from}T00:00:00.000Z`), locale, { dateStyle: "medium", timeZone: "UTC" }), to: formatDateTime(new Date(`${to}T00:00:00.000Z`), locale, { dateStyle: "medium", timeZone: "UTC" }) }));
    } catch (problem) {
      setExportError(operatorFailureMessage(problem, t("tenant.audit.errors.export")));
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
    <section className="panel table-panel" aria-busy={scopeLoading||loadingOlder||undefined}>
      <div className="toolbar">
        <div className="audit-note">
          <span>◫</span>
          <span>
            <b>{t("tenant.audit.appendOnly")}</b>
            <small>
              {t("tenant.audit.retentionBody")}
            </small>
          </span>
        </div>
        {canExport ? <button className="button secondary" onClick={() => { setExportError(null); setExportOpen(true); }}>{t("tenant.audit.export.open")}</button> : null}
      </div>
      {exportNotice ? <div className="bulk-feedback success" role="status"><span>✓</span><p>{exportNotice}</p><button className="text-button" aria-label={t("tenant.audit.export.dismissLabel")} onClick={() => setExportNotice(null)}>{t("tenant.audit.actions.dismiss")}</button></div> : null}
      <Toolbar query={query} setQuery={setQuery} placeholder={t("tenant.audit.search")}>
        <label className="filter-select"><span className="sr-only">{t("tenant.audit.scope.label")}</span><select disabled={scopeLoading} value={includeRoutine ? "include" : "exclude"} onChange={(event)=>void changeRoutineScope(event.target.value==="include")}><option value="exclude">{t("tenant.audit.scope.relevant")}</option><option value="include">{t("tenant.audit.scope.all")}</option></select></label>
        <span className="tag" role="status" aria-live="polite">{t(filteredEntries.length === 1 ? "tenant.audit.filteredCount.one" : "tenant.audit.filteredCount", { count: formatNumber(filteredEntries.length, locale) })}</span>
      </Toolbar>
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style:none can hide list semantics in Safari/VoiceOver. */}
      <ol className="timeline" role="list">
        {filteredEntries.map((row) => {
          const { action, actor, detail, target } = presentation(row);
          // Only a named person gets initials; generic WasalX actors share one product mark.
          const person = String(row.actor_type ?? "") === "USER" ? String(row.actor_display_name ?? row.actor ?? "").trim() : "";
          return <li className="audit-row" key={String(row.id)}>
            <span className="avatar small" aria-hidden="true">
              {person && !isOpaqueIdentifier(person) ? person.split(/\s+/u).map((part) => Array.from(part)[0] ?? "").join("").slice(0, 2).toLocaleUpperCase(locale) : "WX"}
            </span>
            <span className="audit-line" aria-hidden="true" />
            <div>
              <b><bdi>{actor}</bdi></b> <span><bdi>{action}</bdi></span>
              {detail ? <p><bdi>{detail}</bdi>{target ? <> · <strong><bdi>{target}</bdi></strong></> : null}</p> : target ? <p><strong><bdi>{target}</bdi></strong></p> : null}
              <small>
                <RelativeTime value={row.created_at} pastOnly/>
              </small>
            </div>
          </li>;
        })}
      </ol>
      {!filteredEntries.length ? <Empty title={t(entries.length ? "tenant.audit.noMatchesTitle" : "tenant.audit.emptyTitle")} body={t(entries.length ? "tenant.audit.noMatchesBody" : "tenant.audit.emptyBody")} /> : null}
      {loadError ? <p className="audit-load-error" role="alert">{loadError}</p> : null}
      {canLoadOlder ? <div className="audit-pagination"><button className="button secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>{t(loadingOlder ? "tenant.audit.loadingOlder" : "tenant.audit.loadOlder")}</button></div> : loadedOlder ? <p className="audit-all-loaded" role="status">{t("tenant.audit.allLoaded")}</p> : null}
    </section>
    {canExport && exportOpen ? <ModalDialog close={() => setExportOpen(false)} className="modal-backdrop" aria-labelledby="audit-export-title"><form className="modal audit-export-dialog" onSubmit={exportCsv}><div className="modal-head"><div><span className="eyebrow">{t("tenant.audit.export.eyebrow")}</span><h2 id="audit-export-title">{t("tenant.audit.export.title")}</h2><p>{t("tenant.audit.export.body")}</p></div><button type="button" aria-label={t("tenant.audit.export.close")} onClick={() => setExportOpen(false)}>×</button></div>{exportError ? <div className="settings-feedback error" role="alert"><span>!</span><p>{exportError}</p></div> : null}<div className="audit-export-fields"><label>{t("tenant.audit.export.from")}<input type="date" required value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label><label>{t("tenant.audit.export.through")}<input type="date" required value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} /></label><label>{t("tenant.audit.export.maximumRows")}<select value={limit} onChange={(event) => setLimit(event.target.value)}><option value="1000">{formatNumber(1000,locale)}</option><option value="5000">{formatNumber(5000,locale)}</option><option value="10000">{formatNumber(10000,locale)}</option></select></label></div><div className="audit-export-note"><span>⌁</span><p><b>{t("tenant.audit.export.audited")}</b><small>{t("tenant.audit.export.auditedBody")}</small></p></div><div className="modal-actions"><button type="button" className="button secondary" disabled={exporting} onClick={() => setExportOpen(false)}>{t("tenant.audit.actions.cancel")}</button><button className="button primary" disabled={exporting || !from || !to || from > to}>{t(exporting ? "tenant.audit.export.preparing" : "tenant.audit.export.download")}</button></div></form></ModalDialog> : null}
    </>
  );
}

type WorkspaceSettings = {
  id: string;
  name: string;
  slug: string;
  accent_color: string;
  default_theme: "LIGHT" | "DARK" | "SYSTEM";
  group_disclosure_enabled: boolean;
  group_disclosure_message: string;
  sso_enforcement_state: "DISABLED" | "REQUESTED" | "ACTIVE";
  sso_provider_name: string | null;
  sso_issuer: string | null;
  sso_email_domains: string[];
  mfa_required_roles: string[];
  session_timeout_minutes: number;
  privileged_reauth_minutes: number;
  support_access_requires_approval: boolean;
  security_policy_state: "REQUESTED" | "ACTIVE";
  policy_verified_at: string | null;
  version: number;
  updated_at: string;
};

type SettingsSection = "general" | "identity" | "security" | "groupHistory" | "privacy";
const SETTINGS_SECTION_STORAGE_KEY = "wasalx:settings-section";

type WorkspaceForm = {
  name: string;
  slug: string;
  accentColor: string;
  defaultTheme: "LIGHT" | "DARK" | "SYSTEM";
  groupDisclosureEnabled: boolean;
  groupDisclosureMessage: string;
  ssoEnforcementRequested: boolean;
  ssoProviderName: string;
  ssoIssuer: string;
  ssoEmailDomains: string;
  mfaRequiredRoles: string[];
  sessionTimeoutMinutes: string;
  privilegedReauthMinutes: string;
  supportAccessRequiresApproval: boolean;
};

function workspaceForm(settings: WorkspaceSettings): WorkspaceForm {
  return {
    name: settings.name,
    slug: settings.slug,
    accentColor: settings.accent_color,
    defaultTheme: settings.default_theme,
    groupDisclosureEnabled: settings.group_disclosure_enabled,
    groupDisclosureMessage: settings.group_disclosure_message,
    ssoEnforcementRequested: settings.sso_enforcement_state !== "DISABLED",
    ssoProviderName: settings.sso_provider_name ?? "",
    ssoIssuer: settings.sso_issuer ?? "",
    ssoEmailDomains: settings.sso_email_domains.join(", "),
    mfaRequiredRoles: settings.mfa_required_roles,
    sessionTimeoutMinutes: String(settings.session_timeout_minutes),
    privilegedReauthMinutes: String(settings.privileged_reauth_minutes),
    supportAccessRequiresApproval: settings.support_access_requires_approval,
  };
}

type GroupWorkspaceDefaults={group_workspace_enabled:boolean;group_history_default_retention_days:number;group_history_default_visibility:"RESTRICTED"|"ALL_AGENTS";version:number};
function GroupHistoryDefaults({editable,mutationHeaders}:{editable:boolean;mutationHeaders:Record<string,string>}){
  const{locale,t}=useI18n();const[settings,setSettings]=useState<GroupWorkspaceDefaults|null>(null);const[form,setForm]=useState<{enabled:boolean;retentionDays:string;visibility:"RESTRICTED"|"ALL_AGENTS"}|null>(null);const[saved,setSaved]=useState<typeof form>(null);const[loading,setLoading]=useState(true);const[saving,setSaving]=useState(false);const[error,setError]=useState<string|null>(null);const[notice,setNotice]=useState<string|null>(null);const saveKey=useRef<string|null>(null);
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{if(!background)setLoading(true);setError(null);try{const response=await fetch("/api/group-workspace/settings",{cache:"no-store",signal});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as GroupWorkspaceDefaults;const nextForm={enabled:next.group_workspace_enabled,retentionDays:String(next.group_history_default_retention_days),visibility:next.group_history_default_visibility};setSettings(next);setForm(nextForm);setSaved(nextForm)}catch(loadError){if(loadError instanceof DOMException&&loadError.name==="AbortError")return;setError(operatorFailureMessage(loadError, t("tenant.settings.groupHistory.errors.load")))}finally{if(!background)setLoading(false)}},[t]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);const dirty=Boolean(form&&saved&&JSON.stringify(form)!==JSON.stringify(saved));useVisibleRefresh(signal=>load(true,signal),!dirty&&!saving);
  const retentionInvalid=Boolean(form&&(!Number.isInteger(Number(form.retentionDays))||Number(form.retentionDays)<1||Number(form.retentionDays)>3650));
  const update=<K extends keyof NonNullable<typeof form>>(key:K,value:NonNullable<typeof form>[K])=>{setForm(current=>current?{...current,[key]:value}:current);setError(null);setNotice(null)};
  const save=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!settings||!form||!editable||saving||retentionInvalid)return;setSaving(true);setError(null);setNotice(null);try{const idempotencyKey=saveKey.current??crypto.randomUUID();saveKey.current=idempotencyKey;const response=await fetch("/api/group-workspace/settings",{method:"PUT",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},body:JSON.stringify({...form,retentionDays:Number(form.retentionDays),expectedVersion:settings.version})});if(!response.ok)throw operatorLocalFailure(await apiError(response));const next=await response.json() as GroupWorkspaceDefaults;saveKey.current=null;const nextForm={enabled:next.group_workspace_enabled,retentionDays:String(next.group_history_default_retention_days),visibility:next.group_history_default_visibility};setSettings(next);setForm(nextForm);setSaved(nextForm);setNotice(t("tenant.settings.groupHistory.saved"))}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.settings.groupHistory.errors.save")))}finally{setSaving(false)}};
  if(loading)return <section className="panel settings-skeleton" role="status">{t("tenant.settings.groupHistory.loading")}</section>;
  if(!settings||!form)return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.settings.groupHistory.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("common.actions.retry")}</button></div></section>;
  return <form className="panel settings-form" data-unsaved={dirty||undefined} onSubmit={save}><div className="panel-heading settings-heading"><div><h2>{t("tenant.settings.groupHistory.title")}</h2><p>{t("tenant.settings.groupHistory.body")}</p></div><span className="settings-version mono"><bdi>v{formatNumber(settings.version,locale,{useGrouping:false})}</bdi></span></div>{!editable?<div className="settings-readonly"><span>i</span><p><b>{t("tenant.settings.readOnly.title")}</b><small>{t("tenant.settings.groupHistory.ownerOnly")}</small></p></div>:null}<div className="settings-fields"><div className="setting-row settings-toggle-row"><span><b>{t("tenant.settings.groupHistory.enableTitle")}</b><small>{t("tenant.settings.groupHistory.enableBody")}</small></span><button type="button" className={`switch ${form.enabled?"on":""}`} aria-pressed={form.enabled} aria-label={t("tenant.settings.groupHistory.enableToggle")} disabled={!editable} onClick={()=>update("enabled",!form.enabled)}><span/></button></div><label htmlFor="group-history-default-retention">{t("tenant.settings.groupHistory.retention")}<input id="group-history-default-retention" type="number" min="1" max="3650" value={form.retentionDays} readOnly={!editable} aria-invalid={retentionInvalid||undefined} aria-describedby="group-history-default-retention-help" onChange={event=>update("retentionDays",event.target.value)}/><small id="group-history-default-retention-help">{retentionInvalid?t("tenant.group.configuration.blockers.retention",{min:formatNumber(1,locale),max:formatNumber(3650,locale)}):t("tenant.settings.groupHistory.retentionHelp")}</small></label><label htmlFor="group-history-default-visibility">{t("tenant.settings.groupHistory.visibility")}<select id="group-history-default-visibility" value={form.visibility} disabled={!editable} onChange={event=>update("visibility",event.target.value as NonNullable<typeof form>["visibility"])}><option value="RESTRICTED">{t("tenant.group.history.visibilityRestricted")}</option><option value="ALL_AGENTS">{t("tenant.group.history.visibilityAll")}</option></select><small>{t("tenant.settings.groupHistory.visibilityHelp")}</small></label><div className="settings-secret-boundary settings-wide"><span>i</span><p><b>{t("tenant.settings.groupHistory.noBackfillTitle")}</b><small>{t("tenant.settings.groupHistory.noBackfillBody")}</small></p></div></div>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p></div>:null}{notice?<div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div>:null}<div className="save-bar"><span>{dirty?t("tenant.settings.state.unsaved"):t("tenant.settings.state.saved")}</span><div>{dirty?<button type="button" className="button secondary" onClick={()=>setForm(saved)}>{t("tenant.settings.actions.discard")}</button>:null}<button className="button primary" disabled={!editable||!dirty||saving||retentionInvalid}>{t(saving?"tenant.settings.actions.saving":"tenant.settings.actions.save")}</button></div></div></form>;
}

function Settings({
  recoveryScope,
  editable,
  role,
  isPrivateDemo,
  isFixturePreview,
  mutationHeaders,
}: {
  recoveryScope: string;
  editable: boolean;
  role: string;
  isPrivateDemo: boolean;
  isFixturePreview: boolean;
  mutationHeaders: Record<string, string>;
}) {
  const { locale, t } = useI18n();
  const canReadPrivacy = role === "tenant_owner" || role === "tenant_admin" || role === "auditor";
  const [section, setSection] = useState<SettingsSection>(isPrivateDemo ? "privacy" : "general");
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [form, setForm] = useState<WorkspaceForm | null>(null);
  const [savedForm, setSavedForm] = useState<WorkspaceForm | null>(null);
  const [loading, setLoading] = useState(!isPrivateDemo);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const settingsNav = useRef<HTMLDivElement>(null);
  const settingsSections: SettingsSection[] = canReadPrivacy
    ? ["general","identity","security","groupHistory","privacy"]
    : ["general","identity","security","groupHistory"];
  const settingsPanelId = "settings-panel";
  useEffect(() => {
    if (isPrivateDemo) return;
    const timer = window.setTimeout(() => {
      try {
        const stored = window.sessionStorage.getItem(SETTINGS_SECTION_STORAGE_KEY);
        const allowed = stored === "general" || stored === "identity" || stored === "security" || stored === "groupHistory" || stored === "privacy";
        setSection(allowed && (stored !== "privacy" || canReadPrivacy) ? stored : "general");
      } catch { /* Storage is optional; the safe default remains General. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canReadPrivacy, isPrivateDemo]);
  const selectSection = (next: typeof section) => {
    if (section === next) return true;
    if (!confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) return false;
    if (dirty) {
      setForm(savedForm);
      setError(null);
      setNotice(null);
    }
    try { window.sessionStorage.setItem(SETTINGS_SECTION_STORAGE_KEY, next); } catch { /* Navigation still works when storage is unavailable. */ }
    setSection(next);
    return true;
  };
  useLayoutEffect(()=>{if(!loading)settingsNav.current?.querySelector<HTMLElement>(`#settings-tab-${section}`)?.scrollIntoView({block:"nearest",inline:"nearest"})},[loading,section]);
  const moveSettingsTab=(event:React.KeyboardEvent<HTMLElement>)=>{
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
    event.preventDefault();
    const current=Math.max(0,settingsSections.indexOf(section));
    const index=event.key==="Home"?0:event.key==="End"?settingsSections.length-1:(current+(["ArrowRight","ArrowDown"].includes(event.key)?1:-1)+settingsSections.length)%settingsSections.length;
    const next=settingsSections[index]!;
    if(selectSection(next))window.requestAnimationFrame(()=>document.getElementById(`settings-tab-${next}`)?.focus());
  };

  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    if (isPrivateDemo) return;
    if (!background) setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/settings", { cache: "no-store", signal });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const next = await response.json() as WorkspaceSettings;
      const nextForm = workspaceForm(next);
      setSettings(next);
      setForm(nextForm);
      setSavedForm(nextForm);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(operatorFailureMessage(loadError, t("tenant.settings.errors.load")));
    } finally { if (!background) setLoading(false); }
  }, [isPrivateDemo, t]);

  useEffect(() => { if (isPrivateDemo) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [isPrivateDemo, load]);
  const dirty = Boolean(form && savedForm && JSON.stringify(form) !== JSON.stringify(savedForm));
  useVisibleRefresh((signal) => load(true, signal), !isPrivateDemo && !dirty && !saving);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = <K extends keyof WorkspaceForm>(key: K, value: WorkspaceForm[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setError(null);
    setNotice(null);
  };
  const blockers: string[] = [];
  if (form) {
    if (form.name.trim().length < 2) blockers.push(t("tenant.settings.validation.name"));
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(form.slug) || form.slug.includes("--")) blockers.push(t("tenant.settings.validation.slug"));
    if (!/^#[0-9a-f]{6}$/iu.test(form.accentColor)) blockers.push(t("tenant.settings.validation.accent"));
    if (!form.groupDisclosureMessage.trim()) blockers.push(t("tenant.settings.validation.disclosure"));
    if (form.ssoEnforcementRequested && (!form.ssoProviderName.trim() || !form.ssoIssuer.trim() || !form.ssoEmailDomains.trim())) blockers.push(t("tenant.settings.validation.sso"));
    if (!form.mfaRequiredRoles.includes("tenant_owner")) blockers.push(t("tenant.settings.validation.ownerMfa"));
    const sessionMinutes = Number(form.sessionTimeoutMinutes);
    if (!Number.isInteger(sessionMinutes) || sessionMinutes < 15 || sessionMinutes > 1440) blockers.push(t("tenant.settings.validation.session"));
    const reauthMinutes = Number(form.privilegedReauthMinutes);
    if (!Number.isInteger(reauthMinutes) || reauthMinutes < 5 || reauthMinutes > 120) blockers.push(t("tenant.settings.validation.reauth"));
  }

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || !settings || !editable || blockers.length || saving) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify({
          expectedVersion: settings.version,
          ...form,
          name: form.name.trim(), slug: form.slug.trim().toLowerCase(), accentColor: form.accentColor.toUpperCase(),
          ssoProviderName: form.ssoProviderName.trim() || null,
          ssoIssuer: form.ssoIssuer.trim() || null,
          ssoEmailDomains: form.ssoEmailDomains.split(",").map((domain) => domain.trim()).filter(Boolean),
          sessionTimeoutMinutes: Number(form.sessionTimeoutMinutes),
          privilegedReauthMinutes: Number(form.privilegedReauthMinutes),
        }),
      });
      if (!response.ok) throw operatorLocalFailure(await apiError(response));
      const updated = await response.json() as WorkspaceSettings;
      const nextForm = workspaceForm(updated);
      setSettings(updated); setForm(nextForm); setSavedForm(nextForm);
      setNotice(t("tenant.settings.notice.saved"));
    } catch (saveError) {
      setError(operatorFailureMessage(saveError, t("tenant.settings.errors.save")));
    } finally { setSaving(false); }
  };

  if (isPrivateDemo) return <div className="settings-grid settings-grid-privacy"><div className="panel settings-nav" role="tablist" aria-label={t("tenant.settings.sections.label")}><button id="settings-tab-privacy" type="button" role="tab" aria-selected="true" aria-controls={settingsPanelId} className="active">{t("tenant.settings.sections.privacy")}</button></div><div id={settingsPanelId} role="tabpanel" aria-labelledby="settings-tab-privacy"><PrivacySettings recoveryScope={recoveryScope} role={role} isPrivateDemo isFixturePreview={false} mutationHeaders={mutationHeaders}/></div></div>;
  if (loading) return <SettingsSkeleton />;
  if (!settings || !form) {
    return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.settings.errors.unavailable")}</b><p>{error ?? t("tenant.settings.errors.empty")}</p><button className="button small" onClick={() => void load()}>{t("tenant.settings.actions.tryAgain")}</button></div></section>;
  }
  return (
    <div className={`settings-grid ${section === "privacy" ? "settings-grid-privacy" : ""}`}>
      <div ref={settingsNav} className="panel settings-nav" role="tablist" aria-label={t("tenant.settings.sections.label")}>
        {settingsSections.map(item=><button key={item} id={`settings-tab-${item}`} type="button" role="tab" aria-selected={section===item} aria-controls={settingsPanelId} tabIndex={section===item?0:-1} className={section===item?"active":""} onKeyDown={moveSettingsTab} onClick={()=>{if(!selectSection(item))window.requestAnimationFrame(()=>document.getElementById(`settings-tab-${section}`)?.focus())}}>{t(`tenant.settings.sections.${item}`)}</button>)}
      </div>
      {section === "privacy" && canReadPrivacy ? <div id={settingsPanelId} role="tabpanel" aria-labelledby="settings-tab-privacy"><PrivacySettings recoveryScope={recoveryScope} role={role} isPrivateDemo={isPrivateDemo} isFixturePreview={isFixturePreview} mutationHeaders={mutationHeaders} /></div> : section === "groupHistory" ? <div id={settingsPanelId} role="tabpanel" aria-labelledby="settings-tab-groupHistory"><GroupHistoryDefaults editable={editable} mutationHeaders={mutationHeaders}/></div> : <form id={settingsPanelId} role="tabpanel" aria-labelledby={`settings-tab-${section}`} className="panel settings-form" data-unsaved={dirty||undefined} onSubmit={save}>
        <div className="panel-heading settings-heading">
          <div>
            <h2>{t(`tenant.settings.heading.${section}`)}</h2>
            <p>{t(`tenant.settings.description.${section}`)}</p>
          </div>
          <span className="settings-version mono"><bdi>v{formatNumber(settings.version, locale, { useGrouping: false })}</bdi></span>
        </div>
        {!editable ? <div className="settings-readonly"><span>◉</span><p><b>{t("tenant.settings.readOnly.title")}</b><small>{t("tenant.settings.readOnly.body")}</small></p></div> : null}
        {section === "general" ? (
          <div className="settings-fields">
            <label htmlFor="workspace-name">{t("tenant.settings.general.name")}<input id="workspace-name" dir="auto" value={form.name} maxLength={100} readOnly={!editable} onChange={(event) => update("name", event.target.value)} /></label>
            <label htmlFor="workspace-slug">{t("tenant.settings.general.slug")}<div className="input-prefix"><span dir="ltr"><bdi>{t("tenant.settings.general.slugPrefix")}</bdi></span><input id="workspace-slug" dir="ltr" value={form.slug} maxLength={48} readOnly={!editable} onChange={(event) => update("slug", event.target.value.toLowerCase())} /></div></label>
            <label htmlFor="workspace-accent">{t("tenant.settings.general.accent")}<div className="color-input"><i style={{ backgroundColor: /^#[0-9a-f]{6}$/iu.test(form.accentColor) ? form.accentColor : "transparent" }} /><input id="workspace-accent" dir="ltr" value={form.accentColor} maxLength={7} readOnly={!editable} spellCheck={false} onChange={(event) => update("accentColor", event.target.value)} /></div></label>
            <label htmlFor="workspace-theme">{t("tenant.settings.general.theme")}<select id="workspace-theme" value={form.defaultTheme} disabled={!editable} onChange={(event) => update("defaultTheme", event.target.value as WorkspaceForm["defaultTheme"])}><option value="SYSTEM">{t("tenant.settings.general.themeSystem")}</option><option value="DARK">{t("tenant.settings.general.themeDark")}</option><option value="LIGHT">{t("tenant.settings.general.themeLight")}</option></select></label>
            <div className="setting-row settings-toggle-row"><span><b>{t("tenant.settings.general.disclosureTitle")}</b><small>{t("tenant.settings.general.disclosureBody")}</small></span><button type="button" className={`switch ${form.groupDisclosureEnabled ? "on" : ""}`} aria-pressed={form.groupDisclosureEnabled} aria-label={t("tenant.settings.general.disclosureToggle")} disabled={!editable} onClick={() => update("groupDisclosureEnabled", !form.groupDisclosureEnabled)}><span /></button></div>
            <label htmlFor="workspace-disclosure" className="settings-wide">{t("tenant.settings.general.disclosureMessage")}<textarea id="workspace-disclosure" dir="auto" value={form.groupDisclosureMessage} maxLength={500} readOnly={!editable} rows={4} onChange={(event) => update("groupDisclosureMessage", event.target.value)} /><small>{t("tenant.settings.general.disclosureHelp", { count: formatNumber(form.groupDisclosureMessage.length, locale), max: formatNumber(500, locale) })}</small></label>
          </div>
        ) : section === "identity" ? (
          <div className="settings-fields">
            <div className="setting-row settings-toggle-row settings-wide"><span><b>{t("tenant.settings.identity.enforceTitle")}</b><small>{t(settings.sso_enforcement_state === "ACTIVE" ? "tenant.settings.identity.enforceActive" : "tenant.settings.identity.enforcePending")}</small></span><button type="button" className={`switch ${form.ssoEnforcementRequested ? "on" : ""}`} aria-pressed={form.ssoEnforcementRequested} aria-label={t("tenant.settings.identity.enforceToggle")} disabled={!editable} onClick={() => update("ssoEnforcementRequested", !form.ssoEnforcementRequested)}><span /></button></div>
            <label htmlFor="sso-provider">{t("tenant.settings.identity.provider")}<input id="sso-provider" dir="auto" value={form.ssoProviderName} maxLength={100} readOnly={!editable} placeholder={t("tenant.settings.identity.providerPlaceholder")} onChange={(event) => update("ssoProviderName", event.target.value)} /></label>
            <label htmlFor="sso-issuer">{t("tenant.settings.identity.issuer")}<input id="sso-issuer" dir="ltr" value={form.ssoIssuer} maxLength={500} readOnly={!editable} inputMode="url" placeholder={t("tenant.settings.identity.issuerPlaceholder")} onChange={(event) => update("ssoIssuer", event.target.value)} /></label>
            <label htmlFor="sso-domains" className="settings-wide">{t("tenant.settings.identity.domains")}<input id="sso-domains" dir="ltr" value={form.ssoEmailDomains} readOnly={!editable} placeholder={t("tenant.settings.identity.domainsPlaceholder")} onChange={(event) => update("ssoEmailDomains", event.target.value)} /><small>{t("tenant.settings.identity.domainsHelp")}</small></label>
            <div className="settings-secret-boundary settings-wide"><span>⌁</span><p><b>{t("tenant.settings.identity.metadataTitle")}</b><small>{t("tenant.settings.identity.metadataBody")}</small></p></div>
          </div>
        ) : (
          <div className="settings-fields">
            <div className="settings-secret-boundary settings-wide"><span>{settings.security_policy_state === "ACTIVE" ? "✓" : "…"}</span><p><b>{t(settings.security_policy_state === "ACTIVE" ? "tenant.settings.security.activeTitle" : "tenant.settings.security.pendingTitle")}</b><small>{settings.security_policy_state === "ACTIVE" ? <>{t("tenant.settings.security.verified")} <RelativeTime value={settings.policy_verified_at} pastOnly/>. {t("tenant.settings.security.enforced")}</> : t("tenant.settings.security.pendingBody")}</small></p></div>
            <fieldset className="settings-role-grid settings-wide"><legend>{t("tenant.settings.security.mfaRoles")}</legend>{(["tenant_owner","tenant_admin","supervisor","agent","auditor"] as const).map((role) => <label key={role}><input type="checkbox" checked={form.mfaRequiredRoles.includes(role)} disabled={!editable || role === "tenant_owner"} onChange={(event) => update("mfaRequiredRoles", event.target.checked ? [...form.mfaRequiredRoles, role] : form.mfaRequiredRoles.filter((item) => item !== role))} />{t(`tenant.role.${role}`)}</label>)}</fieldset>
            <label htmlFor="session-timeout">{t("tenant.settings.security.sessionTimeout")}<input id="session-timeout" type="number" min={15} max={1440} value={form.sessionTimeoutMinutes} readOnly={!editable} onChange={(event) => update("sessionTimeoutMinutes", event.target.value)} /></label>
            <label htmlFor="reauth-timeout">{t("tenant.settings.security.reauthTimeout")}<input id="reauth-timeout" type="number" min={5} max={120} value={form.privilegedReauthMinutes} readOnly={!editable} onChange={(event) => update("privilegedReauthMinutes", event.target.value)} /></label>
            <div className="setting-row settings-toggle-row settings-wide"><span><b>{t("tenant.settings.security.supportApprovalTitle")}</b><small>{t("tenant.settings.security.supportApprovalBody")}</small></span><Status value="active" /></div>
          </div>
        )}
        {error ? <div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p><button type="button" className="button small" onClick={() => { if (confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))) void load(); }}>{t("tenant.settings.actions.reload")}</button></div> : null}
        {notice ? <div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div> : null}
        {blockers.length ? <div className="settings-validation" role="status"><b>{t("tenant.settings.validation.title")}</b><ul>{blockers.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
        <div className="save-bar"><span>{dirty ? t("tenant.settings.state.unsaved") : <>{t("tenant.settings.state.saved")} <RelativeTime value={settings.updated_at} pastOnly/></>}{!editable ? ` · ${t("tenant.settings.state.ownerRequired")}` : ""}</span><div>{dirty ? <button type="button" className="button secondary" onClick={() => { setForm(savedForm); setError(null); setNotice(null); }}>{t("tenant.settings.actions.discard")}</button> : null}<button className="button primary" type="submit" disabled={!editable || !dirty || blockers.length > 0 || saving}>{saving ? t("tenant.settings.actions.saving") : t("tenant.settings.actions.save")}</button></div></div>
      </form>}
    </div>
  );
}

function SettingsSkeleton() {
  const { t } = useI18n();
  return <div className="settings-grid" role="status" aria-live="polite" aria-busy="true" aria-label={t("tenant.settings.loading")}><section aria-hidden="true" className="panel settings-nav settings-skeleton-nav"><span /><span /><span /></section><section aria-hidden="true" className="panel settings-skeleton"><span className="group-skeleton group-skeleton-title" /><span className="group-skeleton" /><span className="group-skeleton" /><span className="group-skeleton" /></section></div>;
}

type PrivacyPolicy = {
  state: "ACTIVE" | "PAUSED"; resolved_case_days: number; include_open_cases: boolean;
  media_days: number; unmatched_diagnostic_hours: number; export_ttl_hours: number;
  next_sweep_at: string; version: number; updated_at: string; zammad_privacy_configured: boolean;
};
type PrivacyHold = {
  id: string; scope_type: string; scope_value: string | null; scope_sha256: string;
  reason: string; state: string; expires_at: string | null; created_at: string; updated_at: string;
};
type PrivacyRequest = {
  id: string; request_type: "EXPORT" | "DELETE"; scope_type: string; scope_value: string | null;
  scope_sha256: string; disposition: string; state: string; error_code: string | null;
  safe_error: string | null; completed_at: string | null; created_at: string; updated_at: string;
  stage?: string; attempts?: number; max_attempts?: number; summary?: Record<string, unknown>;
  artifact_id: string | null; artifact_byte_size: number | null; artifact_expires_at: string | null;
};
type PrivacyPolicyForm = {
  state: "ACTIVE" | "PAUSED"; resolvedCaseDays: string; includeOpenCases: boolean;
  mediaDays: string; unmatchedDiagnosticHours: string; exportTtlHours: string;
};

function privacyPolicyForm(policy: PrivacyPolicy): PrivacyPolicyForm {
  return { state: policy.state, resolvedCaseDays: String(policy.resolved_case_days), includeOpenCases: policy.include_open_cases, mediaDays: String(policy.media_days), unmatchedDiagnosticHours: String(policy.unmatched_diagnostic_hours), exportTtlHours: String(policy.export_ttl_hours) };
}

function PrivacySettings({ recoveryScope, role, isPrivateDemo, isFixturePreview, mutationHeaders }: { recoveryScope: string; role: string; isPrivateDemo: boolean; isFixturePreview: boolean; mutationHeaders: Record<string,string> }) {
  const {locale,t}=useI18n();
  const [policy,setPolicy]=useState<PrivacyPolicy|null>(null);const [policyForm,setPolicyForm]=useState<PrivacyPolicyForm|null>(null);const [savedPolicyForm,setSavedPolicyForm]=useState<PrivacyPolicyForm|null>(null);
  const [holds,setHolds]=useState<PrivacyHold[]>([]);const [requests,setRequests]=useState<PrivacyRequest[]>([]);const [loading,setLoading]=useState(!isPrivateDemo);const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);const [busy,setBusy]=useState<string|null>(null);
  const [holdOpen,setHoldOpen]=useState(false);const [requestType,setRequestType]=useState<"EXPORT"|"DELETE"|null>(null);const [releaseHold,setReleaseHold]=useState<PrivacyHold|null>(null);const [retryRequest,setRetryRequest]=useState<PrivacyRequest|null>(null);const [detailId,setDetailId]=useState<string|null>(null);
  const [download,setDownload]=useState<{requestId:string;url:string;expiresIn:number}|null>(null);
  const canManagePolicy=role==="tenant_owner";const canManageHolds=role==="tenant_owner";const canExport=role==="tenant_owner"||role==="tenant_admin";const canDelete=role==="tenant_owner";
  const privacyLoadFence=useRef(createLatestRequestFence());
  const privacyLifetime=useRef({mounted:false});
  const dirty=Boolean(policyForm&&savedPolicyForm&&JSON.stringify(policyForm)!==JSON.stringify(savedPolicyForm));
  const privacyDirty=useRef(dirty);
  useLayoutEffect(()=>{privacyDirty.current=dirty},[dirty]);
  useEffect(()=>{const state=privacyLifetime.current,fence=privacyLoadFence.current;state.mounted=true;return()=>{state.mounted=false;fence.invalidate()}},[]);
  const load=useCallback(async(background=false,signal?:AbortSignal)=>{
    if(isPrivateDemo)return;
    const execution=privacyLoadFence.current.begin();
    const current=()=>privacyLifetime.current.mounted&&!signal?.aborted&&privacyLoadFence.current.isCurrent(execution);
    if(!background)setLoading(true);setError(null);
    try{
      const responses=await Promise.all([fetch("/api/privacy/policy",{cache:"no-store",signal}),fetch("/api/privacy/holds",{cache:"no-store",signal}),fetch("/api/privacy/requests",{cache:"no-store",signal})]);
      if(!current())return;
      for(const response of responses)if(!response.ok)throw Object.assign(operatorLocalFailure(await apiError(response)),{status:response.status});
      const [nextPolicy,nextHolds,nextRequests]=await Promise.all(responses.map(response=>response.json())) as [PrivacyPolicy,PrivacyHold[],PrivacyRequest[]];
      if(!current())return;
      if(!privacyDirty.current){const nextForm=privacyPolicyForm(nextPolicy);setPolicy(nextPolicy);setPolicyForm(nextForm);setSavedPolicyForm(nextForm);}
      setHolds(nextHolds);setRequests(nextRequests);
    }catch(cause){
      if(!current()||isAbortError(cause))return;
      if([401,403].includes((cause as {status?:number}).status??0)){
        privacyLoadFence.current.invalidate();setPolicy(null);setPolicyForm(null);setSavedPolicyForm(null);setHolds([]);setRequests([]);
        setHoldOpen(false);setRequestType(null);setReleaseHold(null);setRetryRequest(null);setDetailId(null);setDownload(null);setBusy(null);setLoading(false);
      }
      setError(operatorFailureMessage(cause, t("tenant.privacy.error.load")));
    }finally{if(current())setLoading(false);}
  },[isPrivateDemo,t]);
  useEffect(()=>{if(isPrivateDemo)return;const controller=new AbortController();const timer=window.setTimeout(()=>void load(false,controller.signal),0);return()=>{window.clearTimeout(timer);controller.abort()}},[isPrivateDemo,load]);
  useVisibleRefresh(signal=>load(true,signal),!isPrivateDemo&&!dirty&&busy===null&&!holdOpen&&!requestType&&!releaseHold&&!retryRequest&&!detailId);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn)},[dirty]);
  if(isPrivateDemo)return <section className="panel privacy-demo-state" aria-labelledby="privacy-demo-heading"><div className="panel-heading"><div><h2 id="privacy-demo-heading">{t("tenant.privacy.demo.title")}</h2><p>{t("tenant.privacy.demo.body")}</p></div><span className="tag">{t("tenant.privacy.demo.readOnly")}</span></div><div className="demo-boundary"><span aria-hidden="true">◇</span><p><b>{t("tenant.privacy.demo.noOperations")}</b><small>{t("tenant.privacy.demo.noOperationsBody")}</small></p></div><div className="privacy-demo-grid"><div><small>{t("tenant.privacy.policy.label")}</small><b>{t("tenant.privacy.demo.liveOnly")}</b><span>{t("tenant.privacy.demo.liveOnlyBody")}</span></div><div><small>{t("tenant.privacy.demo.content")}</small><b>{t("tenant.privacy.demo.hidden")}</b><span>{t("tenant.privacy.demo.hiddenBody")}</span></div><div><small>{t("tenant.privacy.demo.destructive")}</small><b>{t("tenant.privacy.common.unavailable")}</b><span>{t("tenant.privacy.demo.destructiveBody")}</span></div></div></section>;
  if(loading&&!policy)return <section className="panel privacy-loading" role="status" aria-live="polite" aria-busy="true" aria-label={t("tenant.privacy.loading")}><span aria-hidden="true" className="group-skeleton group-skeleton-title"/><span aria-hidden="true" className="group-skeleton"/><span aria-hidden="true" className="group-skeleton"/><span aria-hidden="true" className="group-skeleton"/></section>;
  if(!policy||!policyForm)return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.privacy.error.unavailable")}</b><p>{error??t("tenant.privacy.error.missingPolicy")}</p><button className="button small" onClick={()=>void load()}>{t("tenant.privacy.common.tryAgain")}</button></div></section>;
  const scopeNames:Record<string,string>={TENANT:t("tenant.privacy.scope.tenant"),ZAMMAD_TICKET:t("tenant.privacy.scope.case"),REFERENCE:t("tenant.privacy.scope.reference"),PARTICIPANT:t("tenant.privacy.scope.participant"),GROUP_BINDING:t("tenant.privacy.scope.group"),WHATSAPP_GROUP:t("tenant.privacy.scope.groupHistory"),ZAMMAD_USER:t("tenant.privacy.scope.user")};
  const requestNames:Record<string,string>={EXPORT:t("tenant.privacy.request.export"),DELETE:t("tenant.privacy.request.delete")};
  const policyBlockers:string[]=[];for(const [value,min,max,name] of [[policyForm.resolvedCaseDays,1,3650,t("tenant.privacy.policy.resolvedRetention")],[policyForm.mediaDays,1,3650,t("tenant.privacy.policy.mediaRetention")],[policyForm.unmatchedDiagnosticHours,1,24,t("tenant.privacy.policy.unmatchedDiagnostics")],[policyForm.exportTtlHours,1,168,t("tenant.privacy.policy.exportLifetime")]] as const){const number=Number(value);if(!Number.isInteger(number)||number<min||number>max)policyBlockers.push(t("tenant.privacy.validation.range",{name,min:formatNumber(min,locale),max:formatNumber(max,locale)}))}
  const updatePolicy=<K extends keyof PrivacyPolicyForm>(key:K,value:PrivacyPolicyForm[K])=>{if(busy==="policy")return;privacyDirty.current=true;setPolicyForm(current=>current?{...current,[key]:value}:current);setError(null);setNotice(null)};
  const savePolicy=async()=>{if(!canManagePolicy||!dirty||policyBlockers.length||busy)return;privacyLoadFence.current.invalidate();setBusy("policy");setError(null);setNotice(null);try{const response=await fetch("/api/privacy/policy",{method:"PUT",headers:mutationHeaders,body:JSON.stringify({state:policyForm.state,resolvedCaseDays:Number(policyForm.resolvedCaseDays),includeOpenCases:policyForm.includeOpenCases,mediaDays:Number(policyForm.mediaDays),unmatchedDiagnosticHours:Number(policyForm.unmatchedDiagnosticHours),exportTtlHours:Number(policyForm.exportTtlHours),expectedVersion:policy.version})});if(!response.ok)throw operatorLocalFailure(await apiError(response));const updated=await response.json() as PrivacyPolicy;if(!privacyLifetime.current.mounted)return;privacyLoadFence.current.invalidate();const next=privacyPolicyForm(updated);setPolicy(updated);setPolicyForm(next);setSavedPolicyForm(next);setNotice(t("tenant.privacy.notice.policySaved"));}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.privacy.error.savePolicy")));}finally{setBusy(null)}};
  const release=async()=>{if(!releaseHold||busy)return;setBusy(`hold:${releaseHold.id}`);setError(null);try{const response=await fetch(`/api/privacy/holds/${encodeURIComponent(releaseHold.id)}/release`,{method:"POST",headers:mutationHeaders,body:"{}"});if(!response.ok)throw operatorLocalFailure(await apiError(response));const releasedId=releaseHold.id;setHolds(current=>current.map(hold=>hold.id===releasedId?{...hold,state:"RELEASED",updated_at:new Date().toISOString()}:hold));setReleaseHold(null);setNotice(t("tenant.privacy.notice.holdReleased"));}catch(releaseError){setReleaseHold(null);setError(operatorFailureMessage(releaseError, t("tenant.privacy.error.releaseHold")));}finally{setBusy(null)}};
  const retry=async(confirmation:string|undefined,idempotencyKey:string)=>{if(!retryRequest||busy)return;setBusy(`retry:${retryRequest.id}`);setError(null);try{const response=await fetch(`/api/privacy/requests/${encodeURIComponent(retryRequest.id)}/retry`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},body:JSON.stringify({confirmation})});if(!response.ok)throw operatorLocalFailure(await apiError(response));const retriedId=retryRequest.id;setRequests(current=>current.map(request=>request.id===retriedId?{...request,state:"QUEUED",error_code:null,safe_error:null,updated_at:new Date().toISOString()}:request));setRetryRequest(null);setNotice(t("tenant.privacy.notice.requestRetried"));}catch(retryError){setRetryRequest(null);setError(operatorFailureMessage(retryError, t("tenant.privacy.error.retryRequest")));}finally{setBusy(null)}};
  const prepareDownload=async(request:PrivacyRequest)=>{if(busy)return;setBusy(`download:${request.id}`);setError(null);setDownload(null);try{const response=await fetch(`/api/privacy/requests/${encodeURIComponent(request.id)}/download`,{method:"POST",headers:mutationHeaders,body:"{}"});if(!response.ok)throw operatorLocalFailure(await apiError(response));const result=await response.json() as {url?:string;expiresIn?:number};const ttl=Number(result.expiresIn);if(!result.url||!Number.isInteger(ttl)||ttl<1||ttl>300||new URL(result.url).protocol!=="https:")throw operatorLocalFailure(t("tenant.privacy.error.invalidDownload"));setDownload({requestId:request.id,url:result.url,expiresIn:ttl});window.setTimeout(()=>setDownload(current=>current?.url===result.url?null:current),ttl*1000);setNotice(t("tenant.privacy.notice.downloadReady"));}catch(downloadError){setError(operatorFailureMessage(downloadError, t("tenant.privacy.error.prepareDownload")));}finally{setBusy(null)}};
  const activeHolds=holds.filter(hold=>hold.state==="ACTIVE").length;const pendingRequests=requests.filter(request=>["QUEUED","RUNNING"].includes(request.state)).length;const failedRequests=requests.filter(request=>request.state.startsWith("FAILED")||request.state==="BLOCKED_LEGAL_HOLD").length;
  return <div className="privacy-settings" data-unsaved={dirty||undefined}>
    <section className="privacy-summary" aria-label={t("tenant.privacy.summary.aria")}><div><small>{t("tenant.privacy.policy.label")}</small><strong>{policy.state==="ACTIVE"?t("tenant.privacy.value.active"):t("tenant.privacy.value.paused")}</strong><span>{t("tenant.privacy.summary.versionReview",{version:formatNumber(policy.version,locale)})} <RelativeTime value={policy.next_sweep_at}/></span></div><div><small>{t("tenant.privacy.summary.activeHolds")}</small><strong>{formatNumber(activeHolds,locale)}</strong><span>{activeHolds?t("tenant.privacy.summary.scopesProtected"):t("tenant.privacy.summary.noActiveHold")}</span></div><div><small>{t("tenant.privacy.summary.requestsProgress")}</small><strong>{formatNumber(pendingRequests,locale)}</strong><span>{failedRequests?t("tenant.privacy.summary.needRecovery",{count:formatNumber(failedRequests,locale)}):t("tenant.privacy.summary.noFailed")}</span></div></section>
    {error?<div className="settings-feedback error privacy-feedback" role="alert"><span>!</span><p>{error}</p><button className="button small" onClick={()=>{if(confirmUnsavedNavigation(t("tenant.settings.confirmLeave"))){privacyDirty.current=false;setPolicyForm(savedPolicyForm);void load()}}}>{t("tenant.privacy.action.reload")}</button>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a>:null}</div>:null}
    {notice?<div className="settings-feedback success privacy-feedback" role="status"><span>✓</span><p>{notice}</p></div>:null}
    {download?<div className="privacy-download-ready" role="status"><span>↗</span><p><b>{t("tenant.privacy.download.title")}</b><small>{t("tenant.privacy.download.body",{seconds:formatNumber(download.expiresIn,locale)})}</small></p>{isFixturePreview?<span className="tag">{t("tenant.privacy.download.previewVerified")}</span>:<a className="button small primary" href={download.url} target="_blank" rel="noreferrer">{t("tenant.privacy.action.openExport")}</a>}</div>:null}
    <section className="panel privacy-policy-panel"><div className="panel-heading"><div><h2>{t("tenant.privacy.policy.title")}</h2><p>{t("tenant.privacy.policy.body")}</p></div><Status value={policy.state}/></div>{!canManagePolicy?<div className="settings-readonly"><span>◉</span><p><b>{t("tenant.privacy.policy.readOnly")}</b><small>{role==="auditor"?t("tenant.privacy.policy.auditorBody"):t("tenant.privacy.policy.ownerOnly")}</small></p></div>:null}<div className="privacy-policy-fields"><label>{t("tenant.privacy.policy.lifecycle")}<select value={policyForm.state} disabled={!canManagePolicy||busy==="policy"} onChange={event=>updatePolicy("state",event.target.value as PrivacyPolicyForm["state"])}><option value="ACTIVE">{t("tenant.privacy.value.active")}</option><option value="PAUSED">{t("tenant.privacy.policy.pausedCleanup")}</option></select><small>{t("tenant.privacy.policy.lifecycleHelp")}</small></label><label>{t("tenant.privacy.policy.resolvedDays")}<input type="number" min={1} max={3650} value={policyForm.resolvedCaseDays} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("resolvedCaseDays",event.target.value)}/><small>{t("tenant.privacy.policy.resolvedHelp")}</small></label><label>{t("tenant.privacy.policy.mediaDays")}<input type="number" min={1} max={3650} value={policyForm.mediaDays} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("mediaDays",event.target.value)}/><small>{t("tenant.privacy.policy.mediaHelp")}</small></label><label>{t("tenant.privacy.policy.diagnosticHours")}<input type="number" min={1} max={24} value={policyForm.unmatchedDiagnosticHours} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("unmatchedDiagnosticHours",event.target.value)}/><small>{t("tenant.privacy.policy.diagnosticHelp")}</small></label><label>{t("tenant.privacy.policy.exportHours")}<input type="number" min={1} max={168} value={policyForm.exportTtlHours} readOnly={!canManagePolicy} disabled={busy==="policy"} onChange={event=>updatePolicy("exportTtlHours",event.target.value)}/><small>{t("tenant.privacy.policy.exportHelp")}</small></label><div className="setting-row settings-toggle-row"><span><b>{t("tenant.privacy.policy.includeOpen")}</b><small>{t("tenant.privacy.policy.includeOpenHelp")}</small></span><button type="button" className={`switch ${policyForm.includeOpenCases?"on":""}`} aria-pressed={policyForm.includeOpenCases} aria-label={t("tenant.privacy.policy.includeOpenAria")} disabled={!canManagePolicy||busy==="policy"} onClick={()=>updatePolicy("includeOpenCases",!policyForm.includeOpenCases)}><span/></button></div></div><div className="privacy-policy-evidence"><span className={policy.zammad_privacy_configured?"ready":"blocked"}>{policy.zammad_privacy_configured?"✓":"!"}</span><p><b>{policy.zammad_privacy_configured?t("tenant.privacy.policy.accessReady"):t("tenant.privacy.policy.accessMissing")}</b><small>{t("tenant.privacy.policy.accessHelp")}</small></p></div>{policyBlockers.length?<div className="settings-validation" role="status"><b>{t("tenant.privacy.validation.resolve")}</b><ul>{policyBlockers.map(item=><li key={item}>{item}</li>)}</ul></div>:null}<div className="save-bar"><span>{dirty?t("tenant.privacy.policy.unsaved"):<>{t("tenant.privacy.policy.saved")} <RelativeTime value={policy.updated_at} pastOnly/></>}{!canManagePolicy?t("tenant.privacy.policy.ownerRequired"):""}</span><div>{dirty?<button type="button" className="button secondary" disabled={busy==="policy"} onClick={()=>{if(busy==="policy")return;setPolicyForm(savedPolicyForm);setError(null)}}>{t("tenant.privacy.action.discard")}</button>:null}<button type="button" className="button primary" disabled={!canManagePolicy||!dirty||Boolean(policyBlockers.length)||busy!==null} onClick={()=>void savePolicy()}>{busy==="policy"?t("tenant.privacy.action.saving"):t("tenant.privacy.action.savePolicy")}</button></div></div></section>
    <section className="panel table-panel privacy-panel"><div className="panel-heading"><div><h2>{t("tenant.privacy.holds.title")}</h2><p>{t("tenant.privacy.holds.body")}</p></div>{canManageHolds?<button className="button primary" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setHoldOpen(true)}}>＋ {t("tenant.privacy.action.createHold")}</button>:<span className="tag">{t("tenant.privacy.common.readOnly")}</span>}</div>{holds.length?<WideTable><table><thead><tr><th>{t("tenant.privacy.table.scope")}</th><th>{t("tenant.privacy.table.reason")}</th><th>{t("tenant.privacy.table.status")}</th><th>{t("tenant.privacy.table.expiry")}</th><th><span className="sr-only">{t("tenant.privacy.table.actions")}</span></th></tr></thead><tbody>{holds.map(hold=><tr key={hold.id}><td><div className="cell-main"><span className="privacy-scope-icon">⌁</span><span><b>{scopeNames[hold.scope_type]??t("tenant.privacy.common.unavailable")}</b><small><bdi>{privacyScopeReadback(hold.scope_type,hold.scope_value,t)}</bdi></small></span></div></td><td><span className="privacy-safe-text"><bdi>{hold.reason}</bdi></span></td><td><Status value={hold.state}/></td><td>{hold.expires_at?<RelativeTime value={hold.expires_at}/>:t("tenant.privacy.holds.noExpiry")}</td><td>{canManageHolds&&hold.state==="ACTIVE"?<button className="text-button danger-text" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setReleaseHold(hold)}}>{t("tenant.privacy.action.release")}</button>:<span className="team-protected">—</span>}</td></tr>)}</tbody></table></WideTable>:<Empty title={t("tenant.privacy.holds.emptyTitle")} body={t("tenant.privacy.holds.emptyBody")}/>}</section>
    <section className="panel table-panel privacy-panel"><div className="panel-heading"><div><h2>{t("tenant.privacy.requests.title")}</h2><p>{t("tenant.privacy.requests.body")}</p></div><div className="privacy-request-actions">{canExport?<button className="button secondary" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setRequestType("EXPORT")}}>{t("tenant.privacy.action.requestExport")}</button>:null}{canDelete?<button className="button connection-detail-danger-button" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setRequestType("DELETE")}}>{t("tenant.privacy.action.requestDeletion")}</button>:null}</div></div>{requests.length?<WideTable><table><thead><tr><th>{t("tenant.privacy.table.request")}</th><th>{t("tenant.privacy.table.scope")}</th><th>{t("tenant.privacy.table.status")}</th><th>{t("tenant.privacy.table.exportFile")}</th><th>{t("tenant.privacy.table.updated")}</th><th><span className="sr-only">{t("tenant.privacy.table.actions")}</span></th></tr></thead><tbody>{requests.map(request=><tr key={request.id}><td><div className="cell-main"><span className={`privacy-request-icon ${request.request_type.toLowerCase()}`}>{request.request_type==="EXPORT"?"↗":"×"}</span><span><b>{requestNames[request.request_type]??t("tenant.privacy.common.unavailable")}</b></span></div></td><td><span className="privacy-scope"><b>{scopeNames[request.scope_type]??t("tenant.privacy.common.unavailable")}</b><small><bdi>{privacyScopeReadback(request.scope_type,request.scope_value,t)}</bdi></small></span></td><td><Status value={request.state}/>{request.safe_error?<small className="privacy-request-error">{t("tenant.errors.privacyReview")}</small>:null}</td><td>{request.artifact_id?<span className="privacy-artifact"><b>{formatBytes(request.artifact_byte_size,locale)}</b><small>{t("tenant.privacy.requests.expires")} <RelativeTime value={request.artifact_expires_at}/></small></span>:"—"}</td><td><RelativeTime value={request.updated_at} pastOnly/></td><td><div className="privacy-row-actions"><button className="text-button" onClick={()=>{privacyLoadFence.current.invalidate();setLoading(false);setDetailId(request.id)}}>{t("tenant.privacy.action.inspect")}</button>{canExport&&request.request_type==="EXPORT"&&request.state==="SUCCEEDED"&&request.artifact_expires_at?<button className="text-button" disabled={busy!==null} onClick={()=>void prepareDownload(request)}>{busy===`download:${request.id}`?t("tenant.privacy.action.preparing"):t("tenant.privacy.action.download")}</button>:null}{["FAILED_RETRYABLE","FAILED_TERMINAL","BLOCKED_LEGAL_HOLD"].includes(request.state)&&((request.request_type==="EXPORT"&&canExport)||(request.request_type==="DELETE"&&canDelete))?<button className="text-button" onClick={()=>{setError(null);setNotice(null);privacyLoadFence.current.invalidate();setLoading(false);setRetryRequest(request)}}>{t("tenant.privacy.action.retry")}</button>:null}</div></td></tr>)}</tbody></table></WideTable>:<Empty title={t("tenant.privacy.requests.emptyTitle")} body={t("tenant.privacy.requests.emptyBody")}/>}</section>
    {holdOpen?<PrivacyHoldDialog recoveryScope={recoveryScope} recovered={()=>{privacyLoadFence.current.invalidate();setHoldOpen(false);setRequestType(null);setNotice(t("tenant.privacy.recovery.confirmed"));void load(true)}} beforeSubmit={()=>{privacyLoadFence.current.invalidate();setLoading(false)}} mutationHeaders={mutationHeaders} close={()=>setHoldOpen(false)} complete={async hold=>{privacyLoadFence.current.invalidate();setLoading(false);setHolds(current=>[hold,...current]);setHoldOpen(false);setNotice(t("tenant.privacy.notice.holdCreated"))}}/>:null}
    {requestType?<PrivacyRequestDialog recoveryScope={recoveryScope} recovered={()=>{privacyLoadFence.current.invalidate();setHoldOpen(false);setRequestType(null);setNotice(t("tenant.privacy.recovery.confirmed"));void load(true)}} beforeSubmit={()=>{privacyLoadFence.current.invalidate();setLoading(false)}} key={requestType} requestType={requestType} mutationHeaders={mutationHeaders} close={()=>setRequestType(null)} complete={async request=>{privacyLoadFence.current.invalidate();setLoading(false);setRequests(current=>[request,...current]);setRequestType(null);setNotice(t(requestType==="EXPORT"?"tenant.privacy.notice.exportSubmitted":"tenant.privacy.notice.deleteSubmitted"))}}/>:null}
    {releaseHold?<ModalDialog close={()=>setReleaseHold(null)} className="modal-backdrop" aria-labelledby="release-hold-title"><div className="modal privacy-confirm-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.release.eyebrow")}</span><h2 id="release-hold-title">{t("tenant.privacy.release.title")}</h2><p>{t("tenant.privacy.release.body")}</p></div><button aria-label={t("tenant.privacy.release.cancelAria")} onClick={()=>setReleaseHold(null)}>×</button></div><div className="privacy-confirm-facts"><span><small>{t("tenant.privacy.table.scope")}</small><b>{scopeNames[releaseHold.scope_type]??t("tenant.privacy.common.unavailable")}</b></span><span><small>{t("tenant.privacy.release.value")}</small><b className="mono"><bdi>{privacyScopeReadback(releaseHold.scope_type,releaseHold.scope_value,t)}</bdi></b></span></div><div className="privacy-danger-note"><span>!</span><p><b>{t("tenant.privacy.release.confirmOwner")}</b><small>{t("tenant.privacy.release.confirmOwnerBody")}</small></p></div><div className="modal-actions"><button className="button secondary" onClick={()=>setReleaseHold(null)}>{t("tenant.privacy.action.keepHold")}</button><button className="button connection-detail-danger-button" disabled={busy!==null} onClick={()=>void release()}>{busy===`hold:${releaseHold.id}`?t("tenant.privacy.action.releasing"):t("tenant.privacy.action.releaseHold")}</button></div></div></ModalDialog>:null}
    {retryRequest?<PrivacyRetryDialog request={retryRequest} busy={busy!==null} close={()=>setRetryRequest(null)} retry={retry}/>:null}
    {detailId?<PrivacyRequestDetail key={detailId} id={detailId} close={()=>setDetailId(null)}/>:null}
  </div>;
}

type PrivacySubmissionKind = "EXPORT" | "DELETE" | "HOLD";
type PrivacyPendingSubmission = { operationId: string; kind: PrivacySubmissionKind };

function privacyFriendlyScopeValue(scopeType: string, value: string) {
  return scopeType === "ZAMMAD_TICKET" ? value.trim().replace(/^#/u, "") : value.trim();
}

function parsePrivacyPendingSubmission(raw: string): PrivacyPendingSubmission {
  if (raw.length > 256) throw new Error("Invalid pending submission");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pending submission");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "kind,operationId" || typeof row.operationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.operationId)
    || typeof row.kind !== "string" || !["EXPORT", "DELETE", "HOLD"].includes(row.kind)) throw new Error("Invalid pending submission");
  return { operationId: row.operationId, kind: row.kind as PrivacySubmissionKind };
}

function parsePrivacyMutationAcknowledgement(value: unknown, kind: PrivacySubmissionKind, scopeType: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Unconfirmed submission");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.id)
    || typeof row.state !== "string" || !(kind === "HOLD" ? ["ACTIVE"] : ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "BLOCKED_LEGAL_HOLD"]).includes(row.state)
    || row.request_type !== undefined && row.request_type !== kind || row.kind !== undefined && row.kind !== kind
    || row.scope_type !== undefined && row.scope_type !== scopeType) throw new Error("Unconfirmed submission");
  return { id: row.id, state: row.state };
}

function parsePrivacySubmissionReceipt(value: unknown): { state: "APPLIED"; id: string } | { state: "UNKNOWN" } | { state: "NOT_APPLIED"; terminal: true; effect: "NONE" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid receipt");
  const row = value as Record<string, unknown>;
  if (row.state === "APPLIED" && typeof row.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.id)) return { state: "APPLIED", id: row.id };
  if (row.state === "UNKNOWN") return { state: "UNKNOWN" };
  if (row.state === "NOT_APPLIED" && row.terminal === true && row.effect === "NONE") return { state: "NOT_APPLIED", terminal: true, effect: "NONE" };
  throw new Error("Invalid receipt");
}

function usePrivacySubmissionRecovery(recoveryScope: string, kind: PrivacySubmissionKind, mutationHeaders: Record<string, string>, recovered: () => void) {
  const { t } = useI18n();
  const key = `wasalx:privacy-submission:v1:${recoveryScope}`;
  const [ready, setReady] = useState(false), [pending, setPending] = useState<PrivacyPendingSubmission | null>(null);
  const [checking, setChecking] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const state = useRef({ mounted: false, key, pending: null as PrivacyPendingSubmission | null, ready: false, checking: false });
  const requests = useRef(createReplaceableRequestController());
  useLayoutEffect(() => {
    const current = state.current, controller = requests.current;
    current.mounted = true; current.key = key; current.ready = false;
    const timer = window.setTimeout(() => {
      try { const raw = sessionStorage.getItem(key); const value = raw === null ? null : parsePrivacyPendingSubmission(raw);
        current.pending = value; current.ready = true; setPending(value); setReady(true);
      } catch { setError(t("tenant.privacy.recovery.storage")); }
    }, 0);
    return () => { current.mounted = false; current.ready = false; window.clearTimeout(timer); controller.abort(); };
  }, [key, t]);
  const start = () => {
    if (!state.current.mounted || !state.current.ready || state.current.pending || state.current.checking) return null;
    try {
      const existing = sessionStorage.getItem(key);
      if (existing !== null) { const value = parsePrivacyPendingSubmission(existing); state.current.pending = value; setPending(value); return null; }
      const intent = { operationId: crypto.randomUUID(), kind };
      sessionStorage.setItem(key, JSON.stringify(intent)); state.current.pending = intent; setPending(intent); setNotice(null);
      return intent;
    } catch { state.current.ready = false; setReady(false); setError(t("tenant.privacy.recovery.storage")); return null; }
  };
  const finish = (intent: PrivacyPendingSubmission) => {
    if (!state.current.mounted || state.current.key !== key || state.current.pending?.operationId !== intent.operationId) return false;
    try {
      const raw = sessionStorage.getItem(key);
      if (raw === null || parsePrivacyPendingSubmission(raw).operationId !== intent.operationId) throw new Error("Changed pending submission");
      sessionStorage.removeItem(key); state.current.pending = null; setPending(null); return true;
    } catch { state.current.ready = false; setReady(false); setError(t("tenant.privacy.recovery.storage")); return false; }
  };
  const reconcile = async (cancel: boolean) => {
    const intent = state.current.pending;
    if (!intent || !state.current.ready || state.current.checking) return;
    state.current.checking = true; setChecking(true); setError(null); setNotice(null);
    const controller = requests.current.begin();
    const current = () => state.current.mounted && state.current.key === key && !controller.signal.aborted && state.current.pending?.operationId === intent.operationId;
    try {
      const response = await fetch("/api/privacy/receipt", { method: "POST", headers: mutationHeaders, cache: "no-store", signal: controller.signal,
        body: JSON.stringify({ ...intent, action: cancel ? "CANCEL_IF_UNADMITTED" : "LOOKUP" }) });
      if (!current()) return;
      if (!response.ok) { const message = await apiError(response); if (current()) setError(message); return; }
      const receipt = parsePrivacySubmissionReceipt(await response.json());
      if (!current()) return;
      if (receipt.state === "APPLIED") { if (finish(intent)) recovered(); }
      else if (receipt.state === "NOT_APPLIED") { if (finish(intent)) setNotice(t("tenant.privacy.recovery.cancelled")); }
      else setError(t("tenant.privacy.recovery.unknown"));
    } catch { if (current()) setError(t("tenant.privacy.recovery.unknown")); }
    finally { if (state.current.mounted && state.current.key === key) { state.current.checking = false; setChecking(false); } }
  };
  return { ready: ready && !pending && !checking, pending, checking, error, notice, start, finish, reconcile };
}

function PrivacySubmissionRecovery({ recovery, saving }: { recovery: ReturnType<typeof usePrivacySubmissionRecovery>; saving: boolean }) {
  const { t } = useI18n();
  if (!recovery.pending && !recovery.error && !recovery.notice) return null;
  return <div className="privacy-dialog-wide">
    {recovery.pending ? <div className="settings-feedback" role="status"><p>{t("tenant.privacy.recovery.unknown")}<br /><small>{t("tenant.privacy.recovery.help")}</small></p>
      <button type="button" className="button small secondary" disabled={saving || recovery.checking} onClick={() => void recovery.reconcile(false)}>{t("tenant.privacy.recovery.check")}</button>
      <button type="button" className="button small secondary" disabled={saving || recovery.checking} onClick={() => void recovery.reconcile(true)}>{t("tenant.privacy.recovery.cancel")}</button></div> : null}
    {recovery.notice ? <p role="status">{recovery.notice}</p> : null}
    {recovery.error ? <div className="settings-feedback error" role="alert"><p>{recovery.error}</p>{requiresPrivilegedReauthentication(recovery.error) ? <a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a> : null}</div> : null}
  </div>;
}


type PrivacyTargetSelection = { scope_type: string; display: string; selection_sha256: string };

function parsePrivacyTargetSelection(value: unknown, scopeType: string): PrivacyTargetSelection {
  if (scopeType !== "ZAMMAD_TICKET" && scopeType !== "ZAMMAD_USER") throw new Error("Invalid target readback");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid target readback");
  const row = value as Record<string, unknown>;
  if (row.scope_type !== scopeType || typeof row.display !== "string" || !row.display.trim() || row.display.length > 1000
    || typeof row.selection_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(row.selection_sha256)) throw new Error("Invalid target readback");
  return { scope_type: scopeType, display: row.display, selection_sha256: row.selection_sha256 };
}

function privacyScopeReadback(scopeType: string, value: string | null, t: TenantTranslator) {
  if (scopeType === "ZAMMAD_USER" || scopeType === "ZAMMAD_TICKET" && !/^#[0-9]{1,32}$/u.test(value ?? "")) return t("tenant.privacy.common.restricted");
  return value ?? t("tenant.privacy.common.restricted");
}

function usePrivacyTargetSelection(scopeType: string, scopeValue: string, mode: string, mutationHeaders: Record<string, string>) {
  const { t } = useI18n();
  const context = JSON.stringify([scopeType, scopeValue, mode]);
  const [snapshot, setSnapshot] = useState<{ context: string; value: PrivacyTargetSelection } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = useRef(createReplaceableRequestController());
  const fence = useRef(createLatestRequestFence());
  const current = useRef({ context, mounted: false });
  useLayoutEffect(() => {
    const state = current.current, pending = requests.current, generation = fence.current;
    state.context = context; state.mounted = true;
    return () => { state.mounted = false; pending.abort(); generation.invalidate(); };
  }, [context]);
  const native = scopeType === "ZAMMAD_TICKET" || scopeType === "ZAMMAD_USER";
  const selection = snapshot?.context === context ? snapshot.value : null;
  const isActive = () => current.current.mounted && current.current.context === context;
  const clear = () => { requests.current.abort(); fence.current.invalidate(); setSnapshot(null); setLoading(false); setError(null); };
  const begin = () => {
    const execution = fence.current.begin(), controller = requests.current.begin();
    return { signal: controller.signal, isCurrent: () => isActive() && fence.current.isCurrent(execution) && !controller.signal.aborted };
  };
  const canLookup = scopeType === "ZAMMAD_TICKET" ? /^#?[0-9]{1,32}$/u.test(scopeValue.trim())
    : scopeType === "ZAMMAD_USER" && scopeValue.trim().length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(scopeValue.trim());
  const lookup = async () => {
    if (!canLookup) return;
    const execution = begin();
    let message = t("tenant.privacy.target.failed");
    setSnapshot(null); setLoading(true); setError(null);
    try {
      const response = await fetch("/api/privacy/target", { method: "POST", cache: "no-store", headers: mutationHeaders,
        signal: execution.signal, body: JSON.stringify({ scopeType, scopeValue: privacyFriendlyScopeValue(scopeType,scopeValue) }) });
      if (!execution.isCurrent()) return;
      if (!response.ok) { message = response.status === 409 ? t("tenant.privacy.target.stale")
        : response.status === 404 ? t("tenant.privacy.target.notFound") : await apiError(response); throw new Error("Lookup rejected"); }
      const value = parsePrivacyTargetSelection(await response.json(), scopeType);
      if (execution.isCurrent()) setSnapshot({ context, value });
    } catch {
      if (execution.isCurrent()) setError(message);
    } finally { if (execution.isCurrent()) setLoading(false); }
  };
  // The server re-resolves the friendly input; this fingerprint detects a changed selection and grants no authority.
  return { native, selection, ready: !native || Boolean(selection) && !loading, loading, error, canLookup, lookup, clear, begin, isActive };
}

function PrivacyScopeTarget({ scopeType, scopeValue, change, target, disabled, hold }: {
  scopeType: string; scopeValue: string; change: (value: string) => void;
  target: ReturnType<typeof usePrivacyTargetSelection>; disabled: boolean; hold: boolean;
}) {
  const { t } = useI18n();
  const customer = scopeType === "ZAMMAD_USER";
  const inputId = hold ? "privacy-hold-target" : "privacy-request-target";
  return <>
    <label htmlFor={inputId}>{t(target.native ? customer ? "tenant.privacy.target.customerEmail" : "tenant.privacy.target.caseNumber" : "tenant.privacy.common.exactScope")}
      <input id={inputId} required type={customer ? "email" : "text"} dir={target.native ? "ltr" : "auto"} inputMode={scopeType === "ZAMMAD_TICKET" ? "numeric" : customer ? "email" : "text"}
        maxLength={customer ? 320 : scopeType === "ZAMMAD_TICKET" ? 33 : 512} disabled={disabled} value={scopeValue} onChange={event => change(event.target.value)}
        aria-describedby={`${inputId}-help`} />
      <small id={`${inputId}-help`}>{t(target.native ? customer ? "tenant.privacy.target.customerHelp" : "tenant.privacy.target.caseHelp"
        : hold ? "tenant.privacy.holdDialog.scopeHelp" : "tenant.privacy.requestDialog.scopeHelp")}</small>
    </label>
    {target.native ? <div className="privacy-dialog-wide"><button type="button" className="button secondary" disabled={disabled || target.loading || !target.canLookup} onClick={() => { change(scopeValue); void target.lookup(); }}>
      {t(target.loading ? "tenant.privacy.target.loading" : customer ? "tenant.privacy.target.checkCustomer" : "tenant.privacy.target.checkCase")}</button>
    {target.selection ? <div className="settings-feedback success" role="status"><p className="privacy-target-readback"><b>{t(customer ? "tenant.privacy.target.selectedCustomer" : "tenant.privacy.target.selectedCase")}</b><br />
      <bdi dir="auto">{target.selection.display}</bdi><br /><small>{t("tenant.privacy.target.review")}</small></p></div> : null}
    {target.error ? <div className="settings-feedback error" role="alert"><p>{target.error}</p>{requiresPrivilegedReauthentication(target.error)
      ? <a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a> : null}</div> : null}</div> : null}
  </>;
}


export function PrivacyHoldDialog({mutationHeaders,close,complete,beforeSubmit,recoveryScope,recovered}:{recoveryScope:string;recovered:()=>void;mutationHeaders:Record<string,string>;beforeSubmit?:()=>void;close:()=>void;complete:(hold:PrivacyHold)=>Promise<void>}) {
  const {locale,t}=useI18n();
  const [scopeType,setScopeType]=useState("TENANT");const [scopeValue,setScopeValue]=useState("");const [reason,setReason]=useState("");const [expiresAt,setExpiresAt]=useState("");const [minimumExpiry]=useState(()=>new Date(Date.now()+86_400_000).toISOString().slice(0,10));const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);
  const target=usePrivacyTargetSelection(scopeType,scopeValue,"HOLD",mutationHeaders);const inFlight=useRef(false);const recovery=usePrivacySubmissionRecovery(recoveryScope,"HOLD",mutationHeaders,recovered);const needsValue=scopeType!=="TENANT";const valid=recovery.ready&&target.ready&&(!needsValue||scopeValue.trim().length>0)&&reason.trim().length>=3;
  const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!valid||saving||inFlight.current)return;
    const intent=recovery.start();if(!intent)return;
    beforeSubmit?.();
    const execution=target.begin();inFlight.current=true;setSaving(true);setError(null);
    try {
      const expiry=expiresAt?new Date(`${expiresAt}T23:59:59`).toISOString():null;
      const response=await fetch("/api/privacy/holds",{method:"POST",headers:{...mutationHeaders,"idempotency-key":intent.operationId},signal:execution.signal,
        body:JSON.stringify({scopeType,scopeValue:needsValue?privacyFriendlyScopeValue(scopeType,scopeValue):undefined,selection_sha256:target.selection?.selection_sha256,reason:reason.trim(),expiresAt:expiry??undefined})});
      if(!execution.isCurrent())return;
      if(!response.ok){
        const message=response.status===409?t("tenant.privacy.target.stale"):await apiError(response);
        if(execution.isCurrent()){if([401,403,409].includes(response.status))target.clear();setError(message);}
        return;
      }
      const returned=parsePrivacyMutationAcknowledgement(await response.json(),"HOLD",scopeType);
      if(!execution.isCurrent()||!recovery.finish(intent))return;
      const timestamp=new Date().toISOString();
      await complete({id:returned.id,scope_type:scopeType,scope_value:target.native?null:(needsValue?scopeValue.trim():t("tenant.privacy.scope.tenant")),scope_sha256:"pending-authoritative-hash",reason:reason.trim(),state:returned.state,expires_at:expiry,created_at:timestamp,updated_at:timestamp});
    }catch{if(execution.isCurrent())setError(t("tenant.privacy.recovery.unknown"));}
    finally{if(target.isActive()){inFlight.current=false;setSaving(false);}}
  };
  return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="create-hold-title"><form className="modal privacy-dialog" onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.holdDialog.eyebrow")}</span><h2 id="create-hold-title">{t("tenant.privacy.holdDialog.title")}</h2><p>{t("tenant.privacy.holdDialog.body")}</p></div><button type="button" aria-label={t("tenant.privacy.holdDialog.closeAria")} onClick={close}>×</button></div>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a>:null}</div>:null}<div className="privacy-dialog-fields"><PrivacySubmissionRecovery recovery={recovery} saving={saving}/><label>{t("tenant.privacy.holdDialog.protectedScope")}<select value={scopeType} disabled={saving} onChange={event=>{target.clear();setScopeType(event.target.value);setScopeValue("");setError(null);}}><option value="TENANT">{t("tenant.privacy.scope.tenant")}</option><option value="ZAMMAD_TICKET">{t("tenant.privacy.scope.case")}</option><option value="REFERENCE">{t("tenant.privacy.scope.reference")}</option><option value="PARTICIPANT">{t("tenant.privacy.scope.participant")}</option><option value="GROUP_BINDING">{t("tenant.privacy.scope.group")}</option><option value="WHATSAPP_GROUP">{t("tenant.privacy.scope.groupHistory")}</option><option value="ZAMMAD_USER">{t("tenant.privacy.scope.user")}</option></select></label>{needsValue?<PrivacyScopeTarget scopeType={scopeType} scopeValue={scopeValue} target={target} disabled={saving} hold={true} change={value=>{target.clear();setScopeValue(value);setError(null);}}/>:null}<label className="privacy-dialog-wide">{t("tenant.privacy.table.reason")}<textarea disabled={saving} required rows={4} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} placeholder={t("tenant.privacy.placeholder.holdReason")}/><small>{t("tenant.privacy.common.characterCount",{count:formatNumber(reason.length,locale),max:formatNumber(500,locale)})}</small></label><label>{t("tenant.privacy.holdDialog.optionalExpiry")}<input disabled={saving} type="date" min={minimumExpiry} value={expiresAt} onChange={event=>setExpiresAt(event.target.value)}/><small>{t("tenant.privacy.holdDialog.expiryHelp")}</small></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={close}>{t("tenant.privacy.action.cancel")}</button><button className="button primary" disabled={!valid||saving}>{saving?t("tenant.privacy.action.creating"):t("tenant.privacy.action.createHold")}</button></div></form></ModalDialog>
}

export function PrivacyRequestDialog({requestType,mutationHeaders,close,complete,beforeSubmit,recoveryScope,recovered}:{requestType:"EXPORT"|"DELETE";recoveryScope:string;recovered:()=>void;mutationHeaders:Record<string,string>;beforeSubmit?:()=>void;close:()=>void;complete:(request:PrivacyRequest)=>Promise<void>}) {
  const {t}=useI18n();
  const [scopeType,setScopeType]=useState("REFERENCE");const [scopeValue,setScopeValue]=useState("");const [confirmation,setConfirmation]=useState("");const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);const target=usePrivacyTargetSelection(scopeType,scopeValue,requestType,mutationHeaders);const inFlight=useRef(false);const recovery=usePrivacySubmissionRecovery(recoveryScope,requestType,mutationHeaders,recovered);const needsValue=scopeType!=="TENANT";const phrase=scopeType==="TENANT"?"DELETE TENANT DATA":"DELETE";const valid=recovery.ready&&target.ready&&(!needsValue||scopeValue.trim().length>0)&&(requestType==="EXPORT"||confirmation===phrase);
  const submit=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(!valid||saving||inFlight.current)return;
    const intent=recovery.start();if(!intent)return;
    beforeSubmit?.();
    const execution=target.begin();inFlight.current=true;setSaving(true);setError(null);
    try {
      const response=await fetch("/api/privacy/requests",{method:"POST",headers:{...mutationHeaders,"idempotency-key":intent.operationId},signal:execution.signal,
        body:JSON.stringify({requestType,scopeType,scopeValue:needsValue?privacyFriendlyScopeValue(scopeType,scopeValue):undefined,selection_sha256:target.selection?.selection_sha256,confirmation:requestType==="DELETE"?confirmation:undefined})});
      if(!execution.isCurrent())return;
      if(!response.ok){
        const message=response.status===409?t("tenant.privacy.target.stale"):await apiError(response);
        if(execution.isCurrent()){if([401,403,409].includes(response.status))target.clear();setError(message);}
        return;
      }
      const returned=parsePrivacyMutationAcknowledgement(await response.json(),requestType,scopeType);
      if(!execution.isCurrent()||!recovery.finish(intent))return;
      const timestamp=new Date().toISOString();
      await complete({id:returned.id,request_type:requestType,scope_type:scopeType,scope_value:target.native?null:needsValue?scopeValue.trim():t("tenant.privacy.scope.tenant"),scope_sha256:"pending-authoritative-hash",disposition:requestType==="EXPORT"?"EXPORT_ONLY":scopeType==="ZAMMAD_USER"?"ZAMMAD_USER_DATA_PRIVACY":"DELETE_TICKETS",state:returned.state,error_code:null,safe_error:null,completed_at:null,created_at:timestamp,updated_at:timestamp,artifact_id:null,artifact_byte_size:null,artifact_expires_at:null});
    }catch{if(execution.isCurrent())setError(t("tenant.privacy.recovery.unknown"));}
    finally{if(target.isActive()){inFlight.current=false;setSaving(false);}}
  };
  const isExport=requestType==="EXPORT";
  return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="privacy-request-title"><form className={`modal privacy-dialog ${requestType==="DELETE"?"privacy-delete-dialog":""}`} onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{t(isExport?"tenant.privacy.requestDialog.exportEyebrow":"tenant.privacy.requestDialog.deleteEyebrow")}</span><h2 id="privacy-request-title">{t(isExport?"tenant.privacy.requestDialog.exportTitle":"tenant.privacy.requestDialog.deleteTitle")}</h2><p>{t(isExport?"tenant.privacy.requestDialog.exportBody":"tenant.privacy.requestDialog.deleteBody")}</p></div><button type="button" aria-label={t("tenant.privacy.requestDialog.closeAria")} onClick={close}>×</button></div>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p>{requiresPrivilegedReauthentication(error)?<a className="button small secondary" href={privilegedStepUpHref("/app?view=settings")}>{t("tenant.privacy.action.reauthenticate")}</a>:null}</div>:null}<div className="privacy-dialog-fields"><PrivacySubmissionRecovery recovery={recovery} saving={saving}/><label>{t("tenant.privacy.table.scope")}<select value={scopeType} disabled={saving} onChange={event=>{target.clear();setScopeType(event.target.value);setScopeValue("");setError(null);setConfirmation("")}}><option value="TENANT">{t("tenant.privacy.scope.tenant")}</option><option value="ZAMMAD_TICKET">{t("tenant.privacy.scope.case")}</option><option value="REFERENCE">{t("tenant.privacy.scope.reference")}</option><option value="PARTICIPANT">{t("tenant.privacy.scope.participant")}</option><option value="ZAMMAD_USER">{t("tenant.privacy.scope.user")}</option></select></label>{needsValue?<PrivacyScopeTarget scopeType={scopeType} scopeValue={scopeValue} target={target} disabled={saving} hold={false} change={value=>{target.clear();setScopeValue(value);setError(null);setConfirmation("")}}/>:null}</div>{isExport?<div className="privacy-export-contract"><span>⌁</span><p><b>{t("tenant.privacy.requestDialog.exportLimits")}</b><small>{t("tenant.privacy.requestDialog.exportLimitsBody")}</small></p></div>:<><div className="privacy-danger-note"><span>!</span><p><b>{t("tenant.privacy.requestDialog.irreversible")}</b><small>{t("tenant.privacy.requestDialog.irreversibleBody")}</small></p></div><label className="privacy-confirm-input">{t("tenant.privacy.requestDialog.typeToConfirm")} <code dir="ltr"><bdi>{phrase}</bdi></code><input disabled={saving} aria-label={t("tenant.privacy.requestDialog.confirmationAria",{phrase})} autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)} spellCheck={false}/></label></>}<div className="modal-actions"><button type="button" className="button secondary" onClick={close}>{t("tenant.privacy.action.cancel")}</button><button className={requestType==="DELETE"?"button connection-detail-danger-button":"button primary"} disabled={!valid||saving}>{saving?t("tenant.privacy.action.submitting"):t(isExport?"tenant.privacy.action.requestExport":"tenant.privacy.action.permanentDelete")}</button></div></form></ModalDialog>
}

function PrivacyRetryDialog({request,busy,close,retry}:{request:PrivacyRequest;busy:boolean;close:()=>void;retry:(confirmation:string|undefined,idempotencyKey:string)=>Promise<void>}){const {t}=useI18n();const [confirmation,setConfirmation]=useState("");const [idempotencyKey]=useState(()=>crypto.randomUUID());const isDelete=request.request_type==="DELETE";const phrase=request.scope_type==="TENANT"?"DELETE TENANT DATA":"DELETE";return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="privacy-retry-title"><div className="modal privacy-confirm-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.retry.eyebrow")}</span><h2 id="privacy-retry-title">{t(isDelete?"tenant.privacy.retry.deleteTitle":"tenant.privacy.retry.exportTitle")}</h2><p>{t("tenant.privacy.retry.body")}</p></div><button aria-label={t("tenant.privacy.retry.cancelAria")} onClick={close}>×</button></div>{request.safe_error?<div className="settings-feedback error"><span>!</span><p>{t("tenant.errors.privacyReview")}</p></div>:null}{isDelete?<><div className="privacy-danger-note"><span>!</span><p><b>{t("tenant.privacy.retry.authRequired")}</b><small>{t("tenant.privacy.retry.authRequiredBody")}</small></p></div><label className="privacy-confirm-input">{t("tenant.privacy.requestDialog.typeToConfirm")} <code dir="ltr"><bdi>{phrase}</bdi></code><input aria-label={t("tenant.privacy.requestDialog.confirmationAria",{phrase})} value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off" spellCheck={false}/></label></>:<div className="privacy-export-contract"><span>↻</span><p><b>{t("tenant.privacy.retry.safeExport")}</b><small>{t("tenant.privacy.retry.safeExportBody")}</small></p></div>}<div className="modal-actions"><button className="button secondary" onClick={close}>{t("tenant.privacy.action.cancel")}</button><button className={isDelete?"button connection-detail-danger-button":"button primary"} disabled={busy||(isDelete&&confirmation!==phrase)} onClick={()=>void retry(isDelete?confirmation:undefined,idempotencyKey)}>{busy?t("tenant.privacy.action.scheduling"):t("tenant.privacy.action.retryRequest")}</button></div></div></ModalDialog>}

function PrivacyRequestDetail({id,close}:{id:string;close:()=>void}) {
  const {locale,t}=useI18n();const [detail,setDetail]=useState<PrivacyRequest|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState<string|null>(null);
  const load=useCallback(async()=>{setLoading(true);setError(null);try{const response=await fetch(`/api/privacy/requests/${encodeURIComponent(id)}`,{cache:"no-store"});if(!response.ok)throw operatorLocalFailure(await apiError(response));setDetail(await response.json() as PrivacyRequest)}catch(loadError){setError(operatorFailureMessage(loadError, t("tenant.privacy.error.loadDetail")))}finally{setLoading(false)}},[id,t]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer)},[load]);
  const scopeNames:Record<string,string>={TENANT:t("tenant.privacy.scope.tenant"),ZAMMAD_TICKET:t("tenant.privacy.scope.case"),REFERENCE:t("tenant.privacy.scope.reference"),PARTICIPANT:t("tenant.privacy.scope.participant"),GROUP_BINDING:t("tenant.privacy.scope.group"),WHATSAPP_GROUP:t("tenant.privacy.scope.groupHistory"),ZAMMAD_USER:t("tenant.privacy.scope.user")};
  const requestNames:Record<string,string>={EXPORT:t("tenant.privacy.request.export"),DELETE:t("tenant.privacy.request.delete")};
  const stageNames:Record<string,string>={PENDING:t("tenant.privacy.stage.pending"),DISCOVER:t("tenant.privacy.stage.discovery"),DISCOVERY:t("tenant.privacy.stage.discovery"),WRITE_ARTIFACT:t("tenant.privacy.stage.writeArtifact"),COMPLETED:t("tenant.privacy.stage.completed")};
  const summaryNames:Record<string,string>={ticket_count:t("tenant.privacy.summary.ticketCount"),message_count:t("tenant.privacy.summary.messageCount"),byte_size:t("tenant.privacy.summary.byteSize"),targets_discovered:t("tenant.privacy.summary.targetsDiscovered"),metaCostSourcesPurged:t("cost.statement.financeSourcesPurged"),metaCostSourcesRetained:t("cost.statement.financeSourcesRetained"),metaCostRecordsPurged:t("cost.statement.financeRecordsPurged"),metaCostRecordsRetained:t("cost.statement.financeRecordsRetained")};
  const summaryEntries=Object.entries(detail?.summary??{}).filter(([key,value])=>key in summaryNames&&typeof value==="number"&&Number.isFinite(value));
  const retainedFinance=[detail?.summary?.metaCostSourcesRetained,detail?.summary?.metaCostRecordsRetained].some(value=>typeof value==="number"&&Number.isFinite(value)&&value>0);
  const financeReviewRequired=["FINANCE_SOURCE_REVIEW_REQUIRED","FINANCE_RETENTION_REVIEW_REQUIRED"].includes(detail?.error_code??"");
  return <ModalDialog close={close} className="modal-backdrop" aria-labelledby="privacy-detail-title"><div className="modal privacy-detail-dialog"><div className="modal-head"><div><span className="eyebrow">{t("tenant.privacy.detail.eyebrow")}</span><h2 id="privacy-detail-title">{t("tenant.privacy.detail.title")}</h2><p>{t("tenant.privacy.detail.body")}</p></div><button aria-label={t("tenant.privacy.detail.closeAria")} onClick={close}>×</button></div>{loading?<div className="privacy-detail-loading" role="status" aria-live="polite" aria-busy="true" aria-label={t("tenant.privacy.detail.loading")}><span aria-hidden="true" className="group-skeleton"/><span aria-hidden="true" className="group-skeleton"/></div>:error?<section className="settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.privacy.detail.unavailable")}</b><p>{error}</p><button className="button small" onClick={()=>void load()}>{t("tenant.privacy.common.tryAgain")}</button></div></section>:detail?<><dl className="privacy-detail-facts"><div><dt>{t("tenant.privacy.detail.type")}</dt><dd>{requestNames[detail.request_type]??t("tenant.privacy.common.unavailable")}</dd></div><div><dt>{t("tenant.privacy.detail.state")}</dt><dd><Status value={detail.state}/></dd></div><div><dt>{t("tenant.privacy.table.scope")}</dt><dd>{scopeNames[detail.scope_type]??t("tenant.privacy.common.unavailable")}</dd></div><div><dt>{t("tenant.privacy.detail.scopeValue")}</dt><dd className="mono"><bdi>{privacyScopeReadback(detail.scope_type,detail.scope_value,t)}</bdi></dd></div><div><dt>{t("tenant.privacy.detail.stage")}</dt><dd>{stageNames[String(detail.stage??"PENDING").toUpperCase()]??t("tenant.privacy.common.unavailable")}</dd></div><div><dt>{t("tenant.privacy.detail.attempts")}</dt><dd className="mono">{formatNumber(detail.attempts??0,locale)} / {formatNumber(detail.max_attempts??8,locale)}</dd></div><div><dt>{t("tenant.privacy.detail.created")}</dt><dd>{exactTime(detail.created_at,locale,t("tenant.time.invalid"))}</dd></div><div><dt>{t("tenant.privacy.table.updated")}</dt><dd>{exactTime(detail.updated_at,locale,t("tenant.time.invalid"))}</dd></div></dl>{detail.safe_error?<div className="settings-feedback error"><span>!</span><p>{t(financeReviewRequired?"cost.statement.financePrivacyReview":"tenant.errors.privacyReview")}</p></div>:null}<div className="privacy-detail-summary"><b>{t("tenant.privacy.detail.summary")}</b>{retainedFinance?<p>{t("cost.statement.financePrivacyRetained")}</p>:null}{summaryEntries.length?<dl>{summaryEntries.map(([key,value])=><div key={key}><dt>{summaryNames[key]}</dt><dd className="mono">{key==="byte_size"?formatBytes(value as number,locale):formatNumber(value as number,locale)}</dd></div>)}</dl>:<p>{t("tenant.privacy.detail.noSummary")}</p>}</div></>:null}<div className="modal-actions"><button className="button secondary" onClick={close}>{t("tenant.privacy.action.close")}</button></div></div></ModalDialog>
}

function formatBytes(value:number|null,locale:"en"|"ar"){if(value==null)return"—";const units=["byte","kilobyte","megabyte"] as const;const unitIndex=value<1024?0:value<1024*1024?1:2;return formatNumber(value/1024**unitIndex,locale,{style:"unit",unit:units[unitIndex],unitDisplay:"short",maximumFractionDigits:unitIndex?1:0})}

type TeamMember = {
  id: string; user_id: string; email: string; display_name: string;
  role: "tenant_owner" | "tenant_admin" | "supervisor" | "agent" | "auditor";
  state: "ACTIVE" | "SUSPENDED"; version: number; created_at: string; updated_at: string; is_current_user: boolean; whatsapp_numbers?: string[]; nativeObservation?: NativeAccountObservation;
};
type TeamInvitation = {
  id: string; email: string; display_name: string | null; role: TeamMember["role"];
  state: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED"; expires_at: string;
  version: number; created_at: string; updated_at: string; delivery_state: string | null;
  delivery_attempts?: number; delivery_error_code?: string | null; delivery_error?: string | null; delivery_updated_at?: string | null;
};
type TeamData = { members: TeamMember[]; invitations: TeamInvitation[]; capabilities: { can_invite: boolean; can_manage_members: boolean; can_manage_owners: boolean } };
const invitationDeliveryUnknown = (invitation: TeamInvitation) => invitation.delivery_state === "FAILED_TERMINAL" && invitation.delivery_error_code === "INVITATION_DELIVERY_OUTCOME_UNKNOWN";

function TeamAccess({ role, currentUserId, canManage, mutationHeaders }: { role: string; currentUserId: string; canManage: boolean; mutationHeaders: Record<string,string> }) {
  const { locale, t } = useI18n();
  const [data, setData] = useState<TeamData | null>(null);
  const [nativeAccountRead, setNativeAccountRead] = useState<{ observations: Record<string, NativeAccountObservation | undefined>; unavailable: boolean }>({ observations: {}, unavailable: false });
  const nativeObservationFence = useRef(createLatestRequestFence());
  const beginNativeObservationRead = useCallback(() => nativeObservationFence.current.begin(), []);
  const completeNativeObservationRead = useCallback((request: number, members: Array<{user_id: string; nativeObservation?: NativeAccountObservation}> | null) => {
    if (!nativeObservationFence.current.isCurrent(request)) return;
    setNativeAccountRead({ observations: Object.fromEntries((members ?? []).map(member => [member.user_id, member.nativeObservation])), unavailable: members === null });
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteKey, setInviteKey] = useState(() => crypto.randomUUID());
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resendConfirmation, setResendConfirmation] = useState<TeamInvitation | null>(null);
  const [resendText, setResendText] = useState("");
  const resendTrigger = useRef<HTMLButtonElement | null>(null);
  const actionKeys = useRef(new Map<string,string>());
  const loadFence = useRef(createLatestRequestFence());
  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    const request=loadFence.current.begin();const isCurrent=()=>!signal?.aborted&&loadFence.current.isCurrent(request);
    const observationRequest = beginNativeObservationRead();
    if (!background) setLoading(true); setError(null);
    try { const response = await fetch("/api/team", { cache: "no-store", signal }); if (!response.ok) throw operatorLocalFailure(await apiError(response));const next=await response.json() as TeamData;if(isCurrent()){setData(next);completeNativeObservationRead(observationRequest, next.members);} }
    catch (loadError) { if(isCurrent()&&!isAbortError(loadError)){completeNativeObservationRead(observationRequest, null);setError(operatorFailureMessage(loadError, t("tenant.team.errors.load")));} }
    finally { if (!background&&isCurrent()) setLoading(false); }
  }, [t, beginNativeObservationRead, completeNativeObservationRead]);
  useEffect(() => { const fence=loadFence.current;const controller=new AbortController();const timer = window.setTimeout(() => void load(false,controller.signal), 0); return () => {controller.abort();window.clearTimeout(timer);fence.invalidate()}; }, [load]);
  useVisibleRefresh((signal) => load(true, signal), !inviteOpen && editing === null && busyId === null);
  const keyFor = (action: string) => { const existing = actionKeys.current.get(action); if (existing) return existing; const next = crypto.randomUUID(); actionKeys.current.set(action,next); return next; };
  const completeAction = (action: string) => actionKeys.current.delete(action);
  const mutateInvitation = async (invitation: TeamInvitation, action: "resend" | "revoke", confirmUnknownDelivery = false) => {
    const actionId = `${action}:${invitation.id}`; setBusyId(actionId); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/team/invitations/${encodeURIComponent(invitation.id)}/${action}`, { method:"POST", headers: action === "resend" ? { ...mutationHeaders, "idempotency-key": keyFor(actionId) } : mutationHeaders, body:JSON.stringify(action === "resend" ? { expiresInDays:7, confirmUnknownDelivery } : { expectedVersion:invitation.version }) });
      if (!response.ok) throw operatorLocalFailure(await apiError(response)); completeAction(actionId); setNotice(t(action === "resend" ? "tenant.team.notice.resent" : "tenant.team.notice.revoked", { email: `\u2068${invitation.email}\u2069` })); await load();
    } catch (actionError) { setError(operatorFailureMessage(actionError, t(action === "resend" ? "tenant.team.errors.resend" : "tenant.team.errors.revoke"))); }
    finally { setBusyId(null); }
  };
  const closeResendConfirmation = () => { setResendConfirmation(null); setResendText(""); window.requestAnimationFrame(() => resendTrigger.current?.focus()); };
  if (loading && !data) return <section className="panel team-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label={t("tenant.team.loading")}><span aria-hidden="true" className="group-skeleton group-skeleton-title" /><span aria-hidden="true" className="group-skeleton" /><span aria-hidden="true" className="group-skeleton" /></section>;
  if (!data) return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.team.errors.unavailable")}</b><p>{error ?? t("tenant.team.errors.empty")}</p><button className="button small" onClick={() => void load()}>{t("tenant.team.actions.tryAgain")}</button></div></section>;
  const active = data.members.filter((member) => member.state === "ACTIVE").length;
  const pending = data.invitations.filter((invitation) => invitation.state === "PENDING").length;
  return <div className="team-layout">
    <WorkspaceAccess members={data.members} owner={role==="tenant_owner"} mutationHeaders={mutationHeaders} nativeObservations={nativeAccountRead.observations} nativeObservationUnavailable={nativeAccountRead.unavailable} beginNativeObservationRead={beginNativeObservationRead} completeNativeObservationRead={completeNativeObservationRead}/>
    <section className="team-summary" aria-label={t("tenant.team.summary.label")}><div><small>{t("tenant.team.summary.active")}</small><strong>{formatNumber(active, locale)}</strong><span>{t("tenant.team.summary.identities", { count: formatNumber(data.members.length, locale) })}</span></div><div><small>{t("tenant.team.summary.pending")}</small><strong className={data.capabilities.can_invite ? undefined : "team-role-value"}>{data.capabilities.can_invite ? formatNumber(pending, locale) : t("tenant.team.readOnly")}</strong><span>{t(data.capabilities.can_invite ? pending ? "tenant.team.summary.awaiting" : "tenant.team.summary.none" : "tenant.team.invitations.restrictedTitle")}</span></div><div><small>{t("tenant.team.summary.yourRole")}</small><strong className="team-role-value">{t(`tenant.role.${role}`)}</strong><span>{t(canManage ? "tenant.team.summary.management" : "tenant.team.summary.readOnly")}</span></div></section>
    {error ? <div className="settings-feedback error team-feedback" role="alert"><span>!</span><p>{error}</p><button className="button small" onClick={() => void load()}>{t("tenant.team.actions.reload")}</button></div> : null}
    {notice ? <div className="settings-feedback success team-feedback" role="status"><span>✓</span><p>{notice}</p></div> : null}
    <section className="panel table-panel team-panel">
      <div className="panel-heading"><div><h2>{t("tenant.team.members.title")}</h2><p>{t("tenant.team.members.body")}</p></div>{data.capabilities.can_invite ? <button className="button primary" onClick={() => setInviteOpen(true)}>＋ {t("tenant.team.actions.invite")}</button> : <span className="tag">{t("tenant.team.readOnly")}</span>}</div>
      <WideTable><table><thead><tr><th>{t("tenant.team.columns.member")}</th><th>{t("tenant.team.columns.role")}</th><th>{t("tenant.team.columns.access")}</th><th>{t("tenant.team.columns.changed")}</th><th><span className="sr-only">{t("tenant.team.columns.actions")}</span></th></tr></thead><tbody>{data.members.map((member) => <tr key={member.id}><td><div className="cell-main"><span className="avatar" aria-hidden="true">{member.display_name.split(" ").map((part) => part[0]).join("").slice(0,2).toUpperCase()}</span><span><b><bdi>{member.display_name}</bdi>{member.user_id === currentUserId || member.is_current_user ? ` (${t("tenant.team.you")})` : ""}</b><small dir="ltr"><bdi>{member.email}</bdi></small></span></div></td><td><span className="tag">{t(`tenant.role.${member.role}`)}</span></td><td><Status value={member.state} /><br/><NativeAccountStatus observation={teamNativeAccountObservation(nativeAccountRead.observations[member.user_id], member.nativeObservation)} unavailable={nativeAccountRead.unavailable}/></td><td><RelativeTime value={member.updated_at} pastOnly/></td><td className="team-row-actions">{data.capabilities.can_manage_members && !(role === "tenant_admin" && member.role === "tenant_owner") ? <button className="button small secondary" onClick={() => setEditing(member)}>{t("tenant.team.actions.manage")}</button> : <span className="team-protected">{t(member.is_current_user ? "tenant.team.protected" : !data.capabilities.can_manage_members ? "tenant.team.readOnly" : "tenant.team.ownerOnly")}</span>}</td></tr>)}</tbody></table></WideTable>
    </section>
    <section className="panel table-panel team-panel">
      <div className="panel-heading"><div><h2>{t("tenant.team.invitations.title")}</h2><p>{t("tenant.team.invitations.body")}</p></div></div>
      {data.capabilities.can_invite ? data.invitations.length ? <div className="team-invitations">{data.invitations.map((invitation) => <article key={invitation.id}><span className="team-invite-icon">↗</span><div><b><bdi>{invitation.display_name || invitation.email}</bdi></b><small dir={invitation.display_name ? "ltr" : undefined}><bdi>{invitation.display_name ? invitation.email : t(`tenant.role.${invitation.role}`)}</bdi></small><p><Status value={invitation.state} /> <span className="tag">{t(`tenant.role.${invitation.role}`)}</span> <span className="team-delivery">{t("tenant.team.invitations.emailState")} <Status value={invitation.delivery_state ?? "UNKNOWN"} /></span></p>{invitationDeliveryUnknown(invitation) ? <em>{t("tenant.team.errors.deliveryUnknown")}</em> : invitation.delivery_state === "SENDING" ? <em>{t("tenant.team.invitations.deliveryInProgress")}</em> : invitation.delivery_error ? <em>{t("tenant.team.errors.delivery")}</em> : null}</div><div className="team-invite-meta">{invitation.state === "PENDING" ? <small>{t("tenant.team.invitations.expires")} <RelativeTime value={invitation.expires_at} /></small> : null}{invitation.state !== "ACCEPTED" && invitation.state !== "REVOKED" && !(role === "tenant_admin" && invitation.role === "tenant_owner") ? <span><button className="button small secondary" disabled={busyId !== null || invitation.delivery_state === "SENDING"} onClick={(event) => { if (invitationDeliveryUnknown(invitation)) { resendTrigger.current=event.currentTarget; setResendText(""); setResendConfirmation(invitation); } else void mutateInvitation(invitation,"resend"); }}>{t(busyId === `resend:${invitation.id}` ? "tenant.team.actions.scheduling" : invitationDeliveryUnknown(invitation) ? "tenant.team.actions.reviewResend" : invitation.delivery_state === "SENDING" ? "tenant.team.actions.sending" : "tenant.team.actions.resend")}</button><button className="text-button danger-text" disabled={busyId !== null || invitation.delivery_state === "SENDING"} onClick={() => void mutateInvitation(invitation,"revoke")}>{t(busyId === `revoke:${invitation.id}` ? "tenant.team.actions.revoking" : "tenant.team.actions.revoke")}</button></span> : null}</div></article>)}</div> : <Empty title={t("tenant.team.invitations.emptyTitle")} body={t("tenant.team.invitations.emptyBody")} /> : <div className="team-readonly-invitations"><span>◉</span><p><b>{t("tenant.team.invitations.restrictedTitle")}</b><small>{t("tenant.team.invitations.restrictedBody")}</small></p></div>}
    </section>
    {resendConfirmation ? <InlineConfirmation className="team-remove-confirm" aria-labelledby="invitation-resend-title" cancel={closeResendConfirmation}><div><b id="invitation-resend-title">{t("tenant.team.resendConfirmation.title")}</b><p>{t("tenant.team.resendConfirmation.body")}</p><label htmlFor="invitation-resend-confirmation">{t("tenant.team.resendConfirmation.type")} <code dir="ltr">{t("tenant.team.resendConfirmation.token")}</code><input id="invitation-resend-confirmation" data-inline-confirm-initial-focus dir="ltr" required pattern="RESEND" maxLength={6} autoComplete="off" spellCheck={false} value={resendText} onChange={(event)=>setResendText(event.target.value)} /></label><span><button className="button secondary" onClick={closeResendConfirmation}>{t("tenant.team.actions.cancel")}</button><button className="button connection-detail-danger-button" disabled={resendText!=="RESEND"} onClick={()=>{const invitation=resendConfirmation;setResendConfirmation(null);setResendText("");void mutateInvitation(invitation,"resend",true)}}>{t("tenant.team.actions.verifiedResend")}</button></span></div></InlineConfirmation> : null}
    {inviteOpen ? <InviteMemberDialog role={role} mutationHeaders={mutationHeaders} idempotencyKey={inviteKey} close={() => setInviteOpen(false)} complete={async () => { setInviteKey(crypto.randomUUID()); setInviteOpen(false); setNotice(t("tenant.team.notice.scheduled")); await load(); }} /> : null}
    {editing ? <MemberAccessDialog member={editing} role={role} mutationHeaders={mutationHeaders} close={() => setEditing(null)} complete={async (message) => { setEditing(null); setNotice(message); await load(); }} /> : null}
  </div>;
}

function InviteMemberDialog({ role, mutationHeaders, idempotencyKey, close, complete }: { role:string; mutationHeaders:Record<string,string>; idempotencyKey:string; close:()=>void; complete:()=>Promise<void> }) {
  const { t } = useI18n();
  const [email,setEmail]=useState("");const [displayName,setDisplayName]=useState("");const [memberRole,setMemberRole]=useState<TeamMember["role"]>("agent");const [expires,setExpires]=useState("7");const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);
  const closeGuard=useDialogCloseGuard(close,saving);
  const valid=/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)&&Number(expires)>=1&&Number(expires)<=30;
  const submit=async(event:React.FormEvent<HTMLFormElement>)=>{event.preventDefault();if(!valid||saving)return;setSaving(true);setError(null);try{const response=await fetch("/api/team/invitations",{method:"POST",headers:{...mutationHeaders,"idempotency-key":idempotencyKey},body:JSON.stringify({email:email.trim().toLowerCase(),displayName:displayName.trim()||undefined,role:memberRole,expiresInDays:Number(expires)})});if(!response.ok)throw operatorLocalFailure(await apiError(response));await complete();}catch(inviteError){setError(operatorFailureMessage(inviteError, t("tenant.team.errors.schedule")));}finally{setSaving(false)}};
  return <ModalDialog close={closeGuard.requestClose} className="modal-backdrop" aria-labelledby="invite-member-title"><form className="modal team-dialog" data-unsaved={closeGuard.dirty||undefined} onChangeCapture={closeGuard.markDirty} onSubmit={submit}><div className="modal-head"><div><span className="eyebrow">{t("tenant.team.invite.eyebrow")}</span><h2 id="invite-member-title">{t("tenant.team.invite.title")}</h2><p>{t("tenant.team.invite.body")}</p></div><button type="button" aria-label={t("tenant.team.invite.close")} onClick={closeGuard.requestClose}>×</button></div><DirtyCloseConfirmation guard={closeGuard}/>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p></div>:null}<label htmlFor="invite-email">{t("tenant.team.invite.email")}<input id="invite-email" data-modal-initial-focus dir="ltr" type="email" required value={email} onChange={(event)=>setEmail(event.target.value)} placeholder={t("tenant.team.invite.emailPlaceholder")} /></label><label htmlFor="invite-name">{t("tenant.team.invite.name")} <small>{t("tenant.team.optional")}</small><input id="invite-name" value={displayName} maxLength={120} onChange={(event)=>setDisplayName(event.target.value)} /></label><div className="team-dialog-grid"><label htmlFor="invite-role">{t("tenant.team.invite.role")}<select id="invite-role" value={memberRole} onChange={(event)=>setMemberRole(event.target.value as TeamMember["role"])}>{role==="tenant_owner"?<option value="tenant_owner">{t("tenant.role.tenant_owner")}</option>:null}<option value="tenant_admin">{t("tenant.role.tenant_admin")}</option><option value="supervisor">{t("tenant.role.supervisor")}</option><option value="agent">{t("tenant.role.agent")}</option><option value="auditor">{t("tenant.role.auditor")}</option></select></label><label htmlFor="invite-expiry">{t("tenant.team.invite.expiry")}<input id="invite-expiry" type="number" min={1} max={30} value={expires} onChange={(event)=>setExpires(event.target.value)} /></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={closeGuard.requestClose}>{t("tenant.team.actions.cancel")}</button><button className="button primary" disabled={!valid||saving}>{t(saving?"tenant.team.actions.scheduling":"tenant.team.invite.send")}</button></div></form></ModalDialog>;
}

function MemberAccessDialog({ member, role, mutationHeaders, close, complete }: { member:TeamMember; role:string; mutationHeaders:Record<string,string>; close:()=>void; complete:(message:string)=>Promise<void> }) {
  const { t } = useI18n();
  const [whatsappNumber,setWhatsappNumber]=useState((member.whatsapp_numbers??[]).join("\n"));const [memberRole,setMemberRole]=useState(member.role);const [state,setState]=useState(member.state);const [saving,setSaving]=useState(false);const [error,setError]=useState<string|null>(null);const [removeOpen,setRemoveOpen]=useState(false);
  const closeGuard=useDialogCloseGuard(close,saving);
  const save=async()=>{setSaving(true);setError(null);try{const numbers=whatsappNumber.split(/[,\n]/).map(value=>value.trim()).filter(Boolean);const normalized=numbers.map(value=>value.replace(/[\s()-]/g,""));if(normalized.some(value=>!/^\+[1-9][0-9]{1,14}$/.test(value)))throw operatorLocalFailure(t("tenant.team.errors.numberFormat"));if(new Set(normalized).size!==normalized.length)throw operatorLocalFailure(t("tenant.team.errors.numberDuplicate"));const response=await fetch(`/api/team/members/${encodeURIComponent(member.id)}`,{method:"PATCH",headers:mutationHeaders,body:JSON.stringify({role:memberRole,state,expectedVersion:member.version,whatsappNumbers:numbers})});if(!response.ok)throw operatorLocalFailure(await apiError(response));await complete(t("tenant.team.notice.updated",{name:`\u2068${member.display_name}\u2069`}));}catch(saveError){setError(operatorFailureMessage(saveError, t("tenant.team.errors.update")));}finally{setSaving(false)}};
  const remove=async()=>{setSaving(true);setError(null);try{const response=await fetch(`/api/team/members/${encodeURIComponent(member.id)}`,{method:"DELETE",headers:mutationHeaders,body:JSON.stringify({expectedVersion:member.version})});if(!response.ok)throw operatorLocalFailure(await apiError(response));await complete(t("tenant.team.notice.removed",{name:`\u2068${member.display_name}\u2069`}));}catch(removeError){setError(operatorFailureMessage(removeError, t("tenant.team.errors.remove")));}finally{setSaving(false)}};
  return <ModalDialog close={closeGuard.requestClose} className="modal-backdrop" aria-labelledby="member-access-title"><div className="modal team-dialog" data-unsaved={closeGuard.dirty||undefined} onChangeCapture={closeGuard.markDirty}><div className="modal-head"><div><span className="eyebrow">{t("tenant.team.member.eyebrow")}</span><h2 id="member-access-title">{t("tenant.team.member.title")} <bdi>{member.display_name}</bdi></h2><p dir="ltr"><bdi>{member.email}</bdi></p></div><button aria-label={t("tenant.team.member.close")} onClick={closeGuard.requestClose}>×</button></div><DirtyCloseConfirmation guard={closeGuard}/>{error?<div className="settings-feedback error" role="alert"><span>!</span><p>{error}</p></div>:null}{removeOpen?<InlineConfirmation busy={saving} className="team-remove-confirm" aria-labelledby="team-remove-title" cancel={() => setRemoveOpen(false)}><span className="warning-box">!</span><div><b id="team-remove-title">{t("tenant.team.member.removeTitle")}</b><p>{t("tenant.team.member.removeBody")}</p><span><button className="button secondary" data-inline-confirm-initial-focus disabled={saving} onClick={()=>setRemoveOpen(false)}>{t("tenant.team.member.keep")}</button><button className="button connection-detail-danger-button" disabled={saving} onClick={()=>void remove()}>{t(saving?"tenant.team.member.removing":"tenant.team.member.removeAccess")}</button></span></div></InlineConfirmation>:<><div className="team-dialog-grid"><label htmlFor="member-role">{t("tenant.team.invite.role")}<select id="member-role" disabled={member.is_current_user} value={memberRole} onChange={(event)=>setMemberRole(event.target.value as TeamMember["role"])}>{role==="tenant_owner"?<option value="tenant_owner">{t("tenant.role.tenant_owner")}</option>:null}<option value="tenant_admin">{t("tenant.role.tenant_admin")}</option><option value="supervisor">{t("tenant.role.supervisor")}</option><option value="agent">{t("tenant.role.agent")}</option><option value="auditor">{t("tenant.role.auditor")}</option></select></label><label htmlFor="member-state">{t("tenant.team.member.state")}<select id="member-state" disabled={member.is_current_user} value={state} onChange={(event)=>setState(event.target.value as TeamMember["state"])}><option value="ACTIVE">{t("tenant.team.member.stateActive")}</option><option value="SUSPENDED">{t("tenant.team.member.stateSuspended")}</option></select></label></div><label htmlFor="member-whatsapp">{t("tenant.team.member.whatsapp")}<textarea id="member-whatsapp" rows={3} dir="ltr" autoComplete="off" value={whatsappNumber} onChange={(event)=>setWhatsappNumber(event.target.value)} aria-describedby="member-whatsapp-help"/><small id="member-whatsapp-help">{t("tenant.team.member.whatsappHelp")}</small></label><div className="team-access-note"><span>⌁</span><p>{t("tenant.team.member.protection")}</p></div><div className="modal-actions team-member-actions"><button className="text-button danger-text" disabled={member.is_current_user} onClick={()=>setRemoveOpen(true)}>{t("tenant.team.member.remove")}</button><span><button className="button secondary" onClick={closeGuard.requestClose}>{t("tenant.team.actions.cancel")}</button><button className="button primary" disabled={saving||(memberRole===member.role&&state===member.state&&whatsappNumber===(member.whatsapp_numbers??[]).join("\n"))} onClick={()=>void save()}>{t(saving?"tenant.team.actions.saving":"tenant.team.member.save")}</button></span></div></>}</div></ModalDialog>;
}

function ConnectionModal({
  close,
  mutationHeaders,
  dashboardChanged,
  created,
}: {
  close: () => void;
  mutationHeaders: Record<string, string>;
  dashboardChanged: () => Promise<boolean>;
  created: (id: string) => void;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<"waha" | "meta">("waha");
  const [step, setStep] = useState(1);
  const [creating, setCreating] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState(() => t("tenant.setup.defaultName"));
  const nameValid = Boolean(name.trim()) && (provider !== "meta" || (name.trim().length <= 100 && !/\p{Cc}/u.test(name)));
  const [metaAccessToken, setMetaAccessToken] = useState("");
  const [metaManual, setMetaManual] = useState(false);
  const [metaPurpose, setMetaPurpose] = useState<"NEW_NUMBER" | "ADD_ACCESS">("NEW_NUMBER");
  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState("");
  const [metaWabaId, setMetaWabaId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [assetConflict, setAssetConflict] = useState(false);
  const [result, setResult] = useState<{
    id: string;
    state?: string;
    operation?: { id?: string; state?: string };
  } | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const closeGuard = useDialogCloseGuard(close, creating);
  const metaConfigurationReady =
    /^\d{5,32}$/u.test(metaPhoneNumberId) &&
    /^\d{5,32}$/u.test(metaWabaId) &&
    metaAccessToken.length >= 16;
  const create = async () => {
    if (
      (provider === "waha" && !accepted) ||
      !nameValid ||
      (provider === "meta" && !metaConfigurationReady)
    ) return;
    setCreating(true);
    setError(null);
    setAssetConflict(false);
    try {
      const response = await fetch("/api/connections", {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          provider,
          name: name.trim(),
          engine: provider === "waha" ? "GOWS" : undefined,
          disclosureAccepted: provider === "waha" ? accepted : undefined,
          disclosureVersion: provider === "waha" ? "2026-08-09" : undefined,
          accessToken: provider === "meta" ? metaAccessToken : undefined,
          phoneNumberId: provider === "meta" ? metaPhoneNumberId : undefined,
          wabaId: provider === "meta" ? metaWabaId : undefined,
          eligibilityAccepted: provider === "meta" && accepted ? true : undefined,
          eligibilityVersion: provider === "meta" && accepted ? "2026-08-09" : undefined,
        }),
      });
      if (!response.ok) {
        if (provider === "meta" && response.status === 409) {
          const failure = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
          if (failure?.code === "META_SIGNUP_ASSET_CONFLICT") {
            setAssetConflict(true);
            throw operatorLocalFailure(t("tenant.metaSignup.reason.META_SIGNUP_ASSET_CONFLICT"));
          }
        }
        throw operatorLocalFailure(await apiError(response));
      }
      const acceptedResult = (await response.json()) as {
        id: string;
        state?: string;
        operation?: { id?: string; state?: string };
      };
      setResult(acceptedResult);
      setStep(4);
      closeGuard.resetDirty();
      void dashboardChanged();
    } catch (requestError) {
      setError(
        operatorFailureMessage(requestError, t("tenant.setup.errors.request")),
      );
    } finally {
      // Provider credentials live only in this transient setup form. The
      // control plane stores the accepted token in the private secret manager.
      setMetaAccessToken("");
      setCreating(false);
    }
  };
  return (
    <ModalDialog
      close={closeGuard.requestClose}
      focusVersion={step}
      className="modal-backdrop"
      aria-label={t("tenant.setup.ariaLabel")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeGuard.requestClose();
      }}
    >
      <div
        className="modal connection-modal"
        data-unsaved={closeGuard.dirty || undefined}
        onChangeCapture={closeGuard.markDirty}
      >
        <div className="modal-head">
          <div>
            {provider === "meta" && step === 2 && !metaManual ? null : <span className="eyebrow">
              {t("tenant.setup.eyebrow", { step: Math.min(step, 3) })}
            </span>}
            <h2 data-modal-initial-focus tabIndex={-1}>
              {step === 1
                ? t("tenant.setup.steps.chooseTitle")
                : step === 2
                  ? t("tenant.setup.steps.reviewTitle")
                  : step === 3
                    ? t("tenant.setup.steps.readyTitle")
                    : t("tenant.setup.steps.startedTitle")}
            </h2>
            <p>
              {step === 1
                ? t("tenant.setup.steps.chooseBody")
                : step === 2
                  ? t("tenant.setup.steps.reviewBody")
                  : step === 3
                    ? t("tenant.setup.steps.readyBody")
                    : t("tenant.setup.steps.startedBody")}
            </p>
          </div>
          <button type="button" aria-label={t("tenant.setup.actions.close")} onClick={closeGuard.requestClose}>×</button>
        </div>
        <DirtyCloseConfirmation guard={closeGuard} />
        {step === 1 ? (
          <>
            <fieldset className="provider-options">
              <legend className="sr-only">{t("tenant.setup.ariaLabel")}</legend>
              <label
                className={provider === "waha" ? "selected" : ""}
              >
                <input className="sr-only" type="radio" name="connection-provider" value="waha" checked={provider === "waha"} onChange={() => { setProvider("waha"); setAccepted(false); }} />
                <span className="provider-big" aria-hidden="true">W</span>
                <span>
                  <b>{t("tenant.setup.providers.linkedTitle")}</b>
                  <small>{t("tenant.setup.providers.linkedBody")}</small>
                  <em>{t("tenant.setup.providers.linkedMeta")}</em>
                </span>
                <i aria-hidden="true">✓</i>
              </label>
              <label className={provider === "meta" ? "selected" : ""}>
                <input className="sr-only" type="radio" name="connection-provider" value="meta" aria-describedby="meta-connector-status" checked={provider === "meta"} onChange={() => { setProvider("meta"); setAccepted(false); }} />
                <span className="provider-big meta" aria-hidden="true">M</span>
                <span>
                  <b>{t("tenant.setup.providers.metaTitle")}</b>
                  <small>{t("tenant.setup.providers.metaBody")}</small>
                  <em id="meta-connector-status">
                    {t("tenant.setup.providers.metaMeta")}
                  </em>
                </span>
                <i aria-hidden="true">✓</i>
              </label>
            </fieldset>
            {provider === "waha" ? (
              <section className="waha-engine-selector" aria-labelledby="qualified-waha-engine">
                <h3 id="qualified-waha-engine">{t("tenant.setup.mode.legend")}</h3>
                <div>
                  <div className="selected">
                    <span>
                      <b>{t("tenant.setup.mode.recommended")}</b>
                      <em>{t("tenant.setup.mode.default")}</em>
                      <small>{t("tenant.setup.mode.recommendedBody")}</small>
                    </span>
                  </div>
                </div>
              </section>
            ) : null}
            <label>
              {t("tenant.setup.name.label")}
              <input
                required
                maxLength={provider === "meta" ? 100 : 160}
                value={name}
                dir="auto"
                aria-invalid={!nameValid || undefined}
                aria-describedby="connection-name-help"
                onChange={(event) => setName(event.target.value)}
                placeholder={t("tenant.setup.name.placeholder")}
              />
              <small id="connection-name-help">{t(provider === "meta" ? "tenant.metaSignup.nameHelp" : "tenant.setup.name.help")}</small>
            </label>
          </>
        ) : step === 2 && provider === "meta" && !metaManual ? (
          <>
          <fieldset className="provider-options" disabled={creating}>
            <legend>{t("tenant.metaSignup.addAccess.purposeLabel")}</legend>
            {(["NEW_NUMBER", "ADD_ACCESS"] as const).map(value => <label key={value} className="check">
              <input type="radio" name="meta-connection-purpose" value={value} checked={metaPurpose === value} onChange={() => setMetaPurpose(value)} />
              <span>{t(`tenant.metaSignup.addAccess.purpose.${value}`)}</span>
            </label>)}
          </fieldset>
          <MetaSignup name={name} purpose={metaPurpose} mutationHeaders={mutationHeaders} busyChanged={setCreating}
            created={(id) => { closeGuard.resetDirty(); void dashboardChanged(); created(id); }}
            back={() => setStep(1)} manual={() => setMetaManual(true)} />
          </>
        ) : step === 2 ? (
          <div className="meta-setup-step">
            <div className="disclosure">
              <span className="warning-box">!</span>
              <div>
                <b>
                  {provider === "waha"
                    ? t("tenant.setup.review.linkedTitle")
                    : t("tenant.setup.review.metaTitle")}
                </b>
                <p>
                  {provider === "waha"
                    ? t("tenant.setup.review.linkedBody")
                    : t("tenant.setup.review.metaBody")}
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(event) => setAccepted(event.target.checked)}
                  />{" "}
                  {t(provider === "meta" ? "tenant.setup.review.metaGroupsAccept" : "tenant.setup.review.accept")}
                </label>
              </div>
            </div>
            {provider === "meta" ? (
              <div className="meta-credential-grid">
                <label>
                  {t("tenant.setup.meta.phoneId")}
                  <input
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    maxLength={32}
                    value={metaPhoneNumberId}
                    onChange={(event) => setMetaPhoneNumberId(event.target.value.trim())}
                    placeholder={t("tenant.setup.meta.phoneIdPlaceholder")}
                  />
                </label>
                <label>
                  {t("tenant.setup.meta.wabaId")}
                  <input
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    maxLength={32}
                    value={metaWabaId}
                    onChange={(event) => setMetaWabaId(event.target.value.trim())}
                    placeholder={t("tenant.setup.meta.wabaIdPlaceholder")}
                  />
                </label>
                <label className="meta-token-field">
                  {t("tenant.setup.meta.token")}
                  <input
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={4096}
                    value={metaAccessToken}
                    onChange={(event) => setMetaAccessToken(event.target.value)}
                    placeholder={t("tenant.setup.meta.tokenPlaceholder")}
                  />
                  <small>
                    {t("tenant.setup.meta.tokenHelp")}
                  </small>
                </label>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="ready-state">
            <span className={`radar ${step === 4 && result?.state === "WORKING" ? "" : "neutral"}`}>
              <i />
            </span>
            <h3>
              {step === 4
                ? t("tenant.setup.ready.requestedTitle")
                : t("tenant.setup.ready.planTitle")}
            </h3>
            <p>
              {step === 4
                ? provider === "meta"
                  ? t("tenant.setup.ready.metaAccepted")
                  : t("tenant.setup.ready.linkedAccepted")
                : t("tenant.setup.ready.next")}
            </p>
            <div>
              <span>{t("tenant.setup.ready.mode")}</span>
              <b>{provider === "waha" ? t("tenant.setup.mode.recommended") : t("tenant.setup.ready.official")}</b>
            </div>
            {provider === "waha" ? (
              <div>
                <span>{t("tenant.setup.ready.capacity")}</span>
                <b>{t("tenant.setup.ready.capacityValue")}</b>
              </div>
            ) : null}
            <div>
              <span>{t("tenant.setup.ready.protection")}</span>
              <b>{t("tenant.setup.ready.protectionValue")}</b>
            </div>
            {result?.operation ? (
              <div>
                <span>{t("tenant.setup.ready.status")}</span>
                <b><Status value={result.operation.state ?? "QUEUED"} /></b>
              </div>
            ) : null}
          </div>
        )}
        {error ? (
          <div className="disclosure" role="alert">
            <span className="warning-box">!</span>
            <div>
              <b>{t("tenant.setup.errors.title")}</b>
              <p>{error}</p>
              {!assetConflict && (
                <small>
                  {t("tenant.setup.errors.retry")}{provider === "meta" ? ` ${t("tenant.setup.errors.reenterToken")}` : ""}
                </small>
              )}
            </div>
          </div>
        ) : null}
        {step === 2 && provider === "meta" && !metaManual ? null : <div className="modal-actions">
          {step < 4 && (
            <button
              className="button secondary"
              onClick={() => { if (step === 1) { closeGuard.requestClose(); return; } if (step === 2) setMetaManual(false); setStep(step - 1); }}
            >
              {t(step === 1 ? "tenant.setup.actions.cancel" : "tenant.setup.actions.back")}
            </button>
          )}
          <button
            className="button primary"
            disabled={
              creating ||
              (step === 1 && !nameValid) ||
              (step === 2 && ((provider === "waha" && !accepted) || (provider === "meta" && !metaConfigurationReady))) ||
              (provider === "meta" && step === 3 && !metaConfigurationReady)
            }
            onClick={() =>
              step < 3
                ? (setError(null), setStep(step + 1))
                : step === 3
                  ? create()
                  : result
                    ? created(result.id)
                    : closeGuard.requestClose()
            }
          >
            {step < 3
              ? t("tenant.setup.actions.continue")
              : step === 3
                ? creating
                  ? t("tenant.setup.actions.creating")
                  : t("tenant.setup.actions.start")
                : t("tenant.setup.actions.view")}
          </button>
        </div>}
      </div>
    </ModalDialog>
  );
}
