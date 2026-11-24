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
import { LocaleSwitcher } from "./LocaleSwitcher";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import type { TriggerRule } from "../lib/domain";
import { useI18n } from "./I18nProvider";
import { MarketingIcon } from "./MarketingIcon";
import { formatDuration, formatNumber } from "../lib/i18n/format.ts";
import { fetchAccessCheck, installShellFetch, shouldCoverOnReturn, trackAccessCheck } from "../lib/shell-validation";
import { operatorFailureMessage, operatorLocalFailure, confirmUnsavedNavigation, createLatestRequestFence, shouldPauseAutomaticRefresh, unmatchedReviewItems } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { isAbortError } from "../lib/bot-conversations";
import { can, isTenantRole, type TenantRole } from "../lib/tenant-permissions.ts";
import { connectionDisplayState, connectionIsReady } from "../lib/connection-readiness.ts";
import { TENANT_VIEW_TITLES } from "../lib/tenant-view-titles.ts";
import { rememberBoundaryTheme, useBoundaryPreferences } from "./boundary-preferences.ts";
import { type RecordRow, type ConnectionDetailRow, isDuplicateIdentityRejection, RelativeTime, duration, exactTime, connectionMethod, apiError, requiresPrivilegedReauthentication, privilegedStepUpHref, statusPresentation, Status, Empty, WorkspaceLoading, SectionLoading, WideTable, Toolbar, reviewReason, safeNavigationTarget, DeliveryTable } from "./tenant-ui";

const InboxWorkspace = lazy(async () => ({ default: (await import("./InboxWorkspace")).InboxWorkspace }));
const SupportTeams = lazy(async () => ({ default: (await import("./SupportTeams")).SupportTeams }));
const MailboxAdministration = lazy(async () => ({ default: (await import("./MailboxAdministration")).MailboxAdministration }));
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
const Rules = lazy(async () => ({ default: (await import("./Rules")).Rules }));
const Deliveries = lazy(async () => ({ default: (await import("./Deliveries")).Deliveries }));
const Audit = lazy(async () => ({ default: (await import("./Audit")).Audit }));
const TeamAccess = lazy(async () => ({ default: (await import("./TeamAccess")).TeamAccess }));

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


function issueDeliveries(data: DashboardData) {
  return data.deliveries.filter((delivery) =>
    String(delivery.state).includes("FAILED") || String(delivery.state) === "OUTCOME_UNKNOWN"
  );
}

function unmatchedReviews(data: DashboardData) {
  return unmatchedReviewItems(issueDeliveries(data), data.reviews ?? []);
}

const NAVIGATION_TARGET_KEYS = ["connection", "delivery", "ticket", "group", "message", "workspace", "review"] as const;

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
    const result = await response.json() as { code?: string };
    if (!response.ok) throw Object.assign(new Error(t("teamsAdmin.failed")), { status: response.status, code: result.code });
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
              <Suspense fallback={<WorkspaceLoading />}>
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
              </Suspense>
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
              <Suspense fallback={<WorkspaceLoading />}>
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
              </Suspense>
            )}
            {view === "team" && (
              <>
              <Suspense fallback={<WorkspaceLoading />}>
              <TeamAccess
                role={role}
                currentUserId={user.userId}
                canManage={canManageTeam}
                mutationHeaders={mutationHeaders}
              />
              </Suspense>
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
            {view === "audit" && <Suspense fallback={<WorkspaceLoading />}><Audit rows={liveData.audit} showDiagnostics={role === "auditor"} canExport={canExportAudit} /></Suspense>}
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

