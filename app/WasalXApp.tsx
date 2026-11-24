"use client";
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
import type { NativeAccountObservation } from "../lib/control-plane-data";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { NativeAccountStatus } from "./NativeAccountStatus";
import { teamNativeAccountObservation } from "../lib/native-account-observation";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import type { RuleMatch, TriggerRule } from "../lib/domain";
import { describeRuleChange } from "../lib/rule-version-diff";
import { useI18n } from "./I18nProvider";
import { MarketingIcon } from "./MarketingIcon";
import { formatDateTime, formatDuration, formatNumber } from "../lib/i18n/format.ts";
import { fetchAccessCheck, installShellFetch, shouldCoverOnReturn, trackAccessCheck } from "../lib/shell-validation";
import { operatorFailureMessage, operatorLocalFailure, confirmUnsavedNavigation, createLatestRequestFence, shouldPauseAutomaticRefresh, unmatchedReviewItems, visibleReviewMetadata, deliveryFailureGuidance } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { isAbortError } from "../lib/bot-conversations";
import { can, isTenantRole, type TenantRole } from "../lib/tenant-permissions.ts";
import { connectionDisplayState, connectionIsReady } from "../lib/connection-readiness.ts";
import { TENANT_VIEW_TITLES } from "../lib/tenant-view-titles.ts";
import { rememberBoundaryTheme, useBoundaryPreferences } from "./boundary-preferences.ts";
import { type RecordRow, type ConnectionDetailRow, isDuplicateIdentityRejection, RelativeTime, duration, exactTime, type TenantTranslator, connectionMethod, apiError, isOpaqueIdentifier, requiresPrivilegedReauthentication, privilegedStepUpHref, statusPresentation, Status, Empty, WorkspaceLoading, SectionLoading, WideTable, useDialogCloseGuard, DirtyCloseConfirmation, Toolbar } from "./tenant-ui";

const InboxWorkspace = lazy(async () => ({ default: (await import("./InboxWorkspace")).InboxWorkspace }));
const SupportTeams = lazy(async () => ({ default: (await import("./SupportTeams")).SupportTeams }));
const MailboxAdministration = lazy(async () => ({ default: (await import("./MailboxAdministration")).MailboxAdministration }));
const WorkspaceAccess = lazy(async () => ({ default: (await import("./WorkspaceAccess")).WorkspaceAccess }));
const MetaCostUsage = lazy(async () => ({ default: (await import("./MetaCostUsage")).MetaCostUsage }));
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
const ConnectionDetail = lazy(async () => ({ default: (await import("./ConnectionDetail")).ConnectionDetail }));
const ConnectionModal = lazy(async () => ({ default: (await import("./ConnectionDetail")).ConnectionModal }));
const Groups = lazy(async () => ({ default: (await import("./Groups")).Groups }));
const Settings = lazy(async () => ({ default: (await import("./TenantSettings")).Settings }));

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

const SESSION_EXPIRED_EVENT = "wasalx:session-expired";
const SIDEBAR_PIN_KEY = "wasalx.sidebar.pinned";
const LOCALE_FOCUS_KEY = "wasalx.locale.restore-focus";

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

function idempotentHeaders(headers:Record<string,string>){return{...headers,"idempotency-key":crypto.randomUUID()}}

const NAVIGATION_TARGET_KEYS = ["connection", "delivery", "ticket", "group", "message", "workspace", "review"] as const;

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
          {items.length ? <div className="notification-list">{items.map((item) => <button key={item.id} onClick={() => { close(true); navigate(item.view, item.target); }}><span className={`notification-mark ${item.tone}`} /><span><b><bdi>{item.title}</bdi></b><small>{item.body}</small></span><span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span></button>)}</div> : <Empty title={t("tenant.notifications.allClear")} body={t("tenant.notifications.allClearBody")} />}
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
              {!isPrivateDemo&&can(role,"billing:read")?<Suspense fallback={<SectionLoading />}><MetaCostUsage key={String(initialData.tenant.id)} canExport={can(role,"billing:export")}/></Suspense>:null}</>
            )}
            {view === "groups" && (
              <Suspense fallback={<WorkspaceLoading />}>
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
              </Suspense>
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
              {canManageTeam ? <Suspense fallback={<SectionLoading />}>
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
              <Suspense fallback={<WorkspaceLoading />}>
              <Settings key={inboxScope} recoveryScope={inboxRecoveryScope}
                editable={canWriteSettings}
                role={role}
                isPrivateDemo={isPrivateDemo}
                isFixturePreview={runtime === "FIXTURE"}
                mutationHeaders={mutationHeaders}
              />
              </Suspense>
              {canWriteSettings ? <Suspense fallback={<SectionLoading />}>
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
        {/* Overlays load their module on open; an inline fallback would shift the shell layout. */}
        {connectionModal && (
          <Suspense fallback={null}>
          <ConnectionModal
            mutationHeaders={mutationHeaders}
            dashboardChanged={loadDashboard}
            close={() => setConnectionModal(false)}
            created={(id) => {
              setConnectionModal(false);
              navigate("connections", { connection: id });
            }}
          />
          </Suspense>
        )}
        {selectedConnectionId && (
          <Suspense fallback={null}>
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
          </Suspense>
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
            {t("tenant.overview.workingConnections")}
          </span>
          <strong>
            {formatNumber(working, locale)}
            <small> / {formatNumber(data.connections.length, locale)}</small>
          </strong>
          <footer>
            <b className={connectionIssues||noneWorking?"warning-text":"positive"}>{connectionIssues?t("tenant.overview.requireAction", { count: formatNumber(connectionIssues, locale) }):noneWorking?t("tenant.health.noWorkingConnections"):t("tenant.overview.healthy")}</b>
            <span>{t("tenant.actions.viewAll")} <span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span></span>
          </footer>
        </button>
        <button onClick={() => navigate("groups")} className="metric">
          <span>
            {t("tenant.overview.activeGroups")}
          </span>
          <strong>{formatNumber(activeGroups, locale)}</strong>
          <footer>
            <b>{t("tenant.overview.bindingsConfigured", { count: formatNumber(data.groups.filter(group=>group.zammad_group&&group.zammad_group!=="Not configured").length, locale) })}</b>
            <span>{t("tenant.actions.manage")} <span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span></span>
          </footer>
        </button>
        <button onClick={() => navigate("deliveries")} className="metric">
          <span>
            {t("tenant.overview.deliverySuccess")}
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
            {t("tenant.overview.needsAttention")}
          </span>
          <strong>{formatNumber(attention, locale)}</strong>
          <footer>
            <b className={attention?"warning-text":"positive"}>{t(attention?"tenant.status.actionRequired":"tenant.overview.healthy")}</b>
            <span>{t("tenant.actions.resolve")} <span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span></span>
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
            {t("tenant.overview.viewAllDeliveries")} <span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span>
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
      <Suspense fallback={<SectionLoading />}>
        <ConnectedDataServices canWrite={canConfigure} mutationHeaders={mutationHeaders} />
      </Suspense>
    </div>
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
      <section className="rule-compare-panel" aria-labelledby="rule-compare-heading"><div className="connection-detail-section-head"><div><h3 id="rule-compare-heading">{t("tenant.rules.comparison.title")}</h3><p>{t("tenant.rules.comparison.body")}</p></div></div><div className="rule-compare-selectors"><label>{t("tenant.rules.comparison.from")}<select value={leftId} onChange={(event) => { setLeftId(event.target.value); setComparison(null); const selected = items.find((item) => item.id === event.target.value); const candidate = items.find((item) => selected && ruleSetFamily(item) === ruleSetFamily(selected) && item.id !== selected.id); setRightId(candidate?.id ?? ""); }}>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {t("tenant.rules.versionShort")}{formatNumber(item.version, locale)} · {t(`tenant.rules.state.${item.state.toLowerCase()}`)}</option>)}</select></label><span className="reading-arrow" aria-hidden="true"><MarketingIcon name="arrow" /></span><label>{t("tenant.rules.comparison.to")}<select value={rightId} onChange={(event) => { setRightId(event.target.value); setComparison(null); }}>{comparable.map((item) => <option key={item.id} value={item.id}>{item.name} · {t("tenant.rules.versionShort")}{formatNumber(item.version, locale)} · {t(`tenant.rules.state.${item.state.toLowerCase()}`)}</option>)}</select></label><button className="button primary" disabled={!leftId || !rightId || leftId === rightId || comparing} onClick={() => void compare()}>{t(comparing ? "tenant.rules.actions.comparing" : "tenant.rules.actions.compare")}</button></div>{comparison ? <div className="rule-comparison-result"><div className="rule-comparison-summary"><span><b>{formatNumber(comparisonSummary.added, locale)}</b><small>{t("tenant.rules.comparison.added")}</small></span><span><b>{formatNumber(comparisonSummary.removed, locale)}</b><small>{t("tenant.rules.comparison.removed")}</small></span><span><b>{formatNumber(comparisonSummary.changed, locale)}</b><small>{t("tenant.rules.comparison.changed")}</small></span><span><b>{formatNumber(comparisonSummary.unchanged, locale)}</b><small>{t("tenant.rules.comparison.unchanged")}</small></span></div><div className="rule-change-list">{presentedChanges.map(({ change, fields, kind }, index) => <div key={`${String(change.name)}-${index}`}><Status value={kind} /><span><b><bdi>{String(change.name)}</bdi></b>{kind === "CHANGED" ? <ul className="rule-change-evidence" aria-label={t("tenant.rules.comparison.changedFields", { name: String(change.name) })}>{fields.map((field) => <li key={field.key}><bdi>{field.summary}</bdi></li>)}</ul> : <small>{t(kind === "UNCHANGED" && change.kind === "CHANGED" ? "tenant.rules.comparison.noMaterialChanges" : `tenant.rules.change.${kind.toLowerCase()}`)}</small>}</span></div>)}</div></div> : <div className="rule-history-empty"><span>◇</span><div><b>{t("tenant.rules.comparison.selectTwo")}</b><p>{t("tenant.rules.comparison.readOnly")}</p></div></div>}</section>
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
        <fieldset className="rule-command-config"><legend>{t("tenant.rules.command.title")}</legend><label className="check"><input type="checkbox" checked={form.groupCommand} onChange={event=>{const enabled=event.target.checked;setForm(current=>({...current,groupCommand:enabled,...(enabled?{matcherType:"starts_with",pattern:"/status"}:{}),actionId:current.actionId||commandActions[0]?.action_key||""}));if(enabled)setSample("/status ORD-42");setTestedSignature(null);setTestResult(null);setError(null)}}/><span><b>{t("tenant.rules.command.enable")}</b><small>{t("tenant.rules.command.enableBody")}</small></span></label>{form.groupCommand?<div className="rule-command-fields"><label>{t("tenant.rules.command.action")}<select required value={form.actionId} onChange={event=>updateForm("actionId",event.target.value)}><option value="">{t("tenant.rules.command.selectAction")}</option>{commandActions.map(action=><option key={action.action_key} value={action.action_key}>{action.name}</option>)}</select><small>{commandActions.length?t("tenant.rules.command.getOnly"):t("tenant.rules.command.noActions")}</small></label><div><b>{t("tenant.rules.command.input")}</b><small>{t("tenant.rules.command.inputBody")}</small>{commandInputs.map((row,index)=><div className="rule-command-input" key={index}><input aria-label={t("tenant.rules.command.inputKey")} placeholder={t("tenant.rules.command.inputKey")} value={row.key} maxLength={128} onChange={event=>{setCommandInputs(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,key:event.target.value}:item));setTestedSignature(null)}}/><input aria-label={t("tenant.rules.command.inputValue")} placeholder={t("tenant.rules.command.inputValueExample")} value={row.value} maxLength={500} onChange={event=>{setCommandInputs(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,value:event.target.value}:item));setTestedSignature(null)}}/><button type="button" className="button small secondary" disabled={commandInputs.length===1} onClick={()=>setCommandInputs(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>{t("tenant.rules.command.remove")}</button></div>)}<button type="button" className="text-button" onClick={()=>setCommandInputs(current=>[...current,{key:"",value:""}])}>{t("tenant.rules.command.addInput")}</button></div><label>{t("tenant.rules.command.successReply")}<textarea rows={2} required maxLength={1000} value={form.successReply} onChange={event=>updateForm("successReply",event.target.value)}/></label><label>{t("tenant.rules.command.failureReply")}<textarea rows={2} required maxLength={1000} value={form.failureReply} onChange={event=>updateForm("failureReply",event.target.value)}/></label><p className="form-note">{t("tenant.rules.command.variables")}</p></div>:null}</fieldset>
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
  if (loading && !data) return <section className="panel team-skeleton" aria-busy="true"><p className="sr-only" role="status" aria-label={t("tenant.team.loading")}>{t("tenant.team.loading")}</p><span aria-hidden="true" className="group-skeleton group-skeleton-title" /><span aria-hidden="true" className="group-skeleton" /><span aria-hidden="true" className="group-skeleton" /></section>;
  if (!data) return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("tenant.team.errors.unavailable")}</b><p>{error ?? t("tenant.team.errors.empty")}</p><button className="button small" onClick={() => void load()}>{t("tenant.team.actions.tryAgain")}</button></div></section>;
  const active = data.members.filter((member) => member.state === "ACTIVE").length;
  const pending = data.invitations.filter((invitation) => invitation.state === "PENDING").length;
  return <div className="team-layout">
    <Suspense fallback={<SectionLoading />}><WorkspaceAccess members={data.members} owner={role==="tenant_owner"} mutationHeaders={mutationHeaders} nativeObservations={nativeAccountRead.observations} nativeObservationUnavailable={nativeAccountRead.unavailable} beginNativeObservationRead={beginNativeObservationRead} completeNativeObservationRead={completeNativeObservationRead}/></Suspense>
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
