"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatCurrency, formatDateTime, formatDuration, formatNumber, formatRelativeTime } from "../../lib/i18n/format.ts";
import { useI18n, useRelativeClock } from "../I18nProvider";
import { ScrollRegion } from "../tenant-ui";
import { LocaleSwitcher } from "../LocaleSwitcher";
import { MetaDeletionReview } from "./MetaDeletionReview";
import { InlineConfirmation, ModalDialog } from "../ModalDialog";
import { useVisibleRefresh } from "../use-visible-refresh";
import { rememberBoundaryTheme } from "../boundary-preferences.ts";
import { MetaTransitionOperator } from "./MetaTransitionOperator";
import { platformRequest } from "../../lib/platform-client";
import { PlatformMetaCosts } from "./MetaCostManagement";
import styles from "./PlatformConsole.module.css";
import type { PlatformOverview, PlatformSupportAccessRequest, PlatformSupportOverview, TenantOperation, TenantOperationsPage, TenantUsage } from "./platform-types";

import { META_ROUTING_ROLES, type MetaRoutingOperatorDto, type MetaRoutingReviewBody, type MetaRoutingReviewResult, type MetaRoutingRole } from "../../lib/meta-routing-contract";
import { validMetaRoutingAssetId, validMetaRoutingReviewEvidence } from "../../lib/meta-routing-input";

type Operator = { displayName: string; email: string; authenticatedAt: number; expiresAt: number; csrfToken: string; recoveryScope: string };
type Modal =
  | { kind: "workspace" }
  | { kind: "meta-routing"; tenant: TenantOperation }
  | { kind: "meta-transition"; tenant: TenantOperation }
  | { kind: "support"; tenantId?: string }
  | { kind: "suspend"; tenant: TenantOperation }
  | { kind: "resume"; tenant: TenantOperation }
  | { kind: "worker"; worker: PlatformOverview["workers"][number] }
  | null;

const PLATFORM_THEME_KEY = "wasalx-platform-theme";
const PLATFORM_SECTION_IDS = ["overview", "tenants", "capacity", "support"] as const;
type PlatformSection = typeof PLATFORM_SECTION_IDS[number];
type SupportInspection = { request: PlatformSupportAccessRequest; overview?: PlatformSupportOverview; overviewUnavailable?: boolean };

export function PlatformConsole({ initialOverview, initialTenants, operator, initialTheme }: {
  initialOverview: PlatformOverview;
  initialTenants: TenantOperationsPage;
  operator: Operator;
  initialTheme?: "dark" | "light";
}) {
  const { locale, direction, t } = useI18n();
  const renderedAt = useRelativeClock();
  const [overview, setOverview] = useState(initialOverview);
  const [tenants, setTenants] = useState(initialTenants);
  const [modal, setModal] = useState<Modal>(null);
  const [usage, setUsage] = useState<TenantUsage | null>(null);
  const [supportInspection, setSupportInspection] = useState<SupportInspection | null>(null);
  const [loadingSupport, setLoadingSupport] = useState<string>();
  const [loadingUsage, setLoadingUsage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [tenantFailure, setTenantFailure] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme ?? "dark");
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<PlatformSection>("overview");
  const mobileNavigationButton = useRef<HTMLButtonElement>(null);
  const operationKeys = useRef(new Map<string, string>());
  const filterInitialized = useRef(false);
  const filterRequest = useRef(0);
  const visibleTenants = tenants.items;
  const assigned = number(overview.worker_summary.assigned_sessions);
  const capacity = number(overview.worker_summary.capacity);
  const utilization = capacity ? assigned / capacity : 0;
  const workerTotal = number(overview.worker_summary.workers);
  const healthyWorkers = number(overview.worker_summary.healthy);
  const workerAggregateState = workerTotal > 0 && healthyWorkers === workerTotal ? "HEALTHY" : workerTotal > 0 ? "UNHEALTHY" : "UNKNOWN";
  const captureLag = overview.metering_capture ? number(overview.metering_capture.lag_seconds) : undefined;
  const captureState = captureLag === undefined ? "UNKNOWN" : captureLag === 0 ? "HEALTHY" : "STALE";
  const monthCost = monthCostSummary(overview.month_cost_summary, locale, t);

  useLayoutEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      let next=initialTheme??"dark";
      try {
        const saved = window.localStorage.getItem(PLATFORM_THEME_KEY);
        if (saved === "dark" || saved === "light") next=saved;
      } catch { /* Blocked browser storage leaves the server-provided preferences intact. */ }
      setTheme(next);
      rememberBoundaryTheme("platform",next,false);
    });
    return () => { active = false; };
  }, [initialTheme]);

  useEffect(() => {
    const syncActiveSection = () => {
      const section = window.location.hash.slice(1);
      setActiveSection(PLATFORM_SECTION_IDS.includes(section as PlatformSection) ? section as PlatformSection : "overview");
    };
    syncActiveSection();
    window.addEventListener("hashchange", syncActiveSection);
    return () => window.removeEventListener("hashchange", syncActiveSection);
  }, []);

  async function refresh(signal?: AbortSignal) {
    const pageCount = Math.max(1, Math.ceil(tenants.items.length / 50));
    const [nextOverview, nextTenants] = await Promise.all([
      platformRequest<PlatformOverview>(operator, "operations/overview", { signal }),
      loadTenantPages(operator, query, stateFilter, pageCount, signal),
    ]);
    setOverview(nextOverview);
    setTenants(nextTenants);
  }
  useVisibleRefresh(async (signal) => {
    try { await refresh(signal); }
    catch { if (!signal?.aborted) setFeedback(t("platform.feedback.refreshFailed")); }
  }, !busy && modal === null);
  useVisibleRefresh(async (signal) => {
    const current = supportInspection;
    if (!current) return;
    try {
      const detail = await platformRequest<PlatformSupportAccessRequest>(operator, `support-access/${current.request.id}`, { signal });
      const request = { ...detail, tenant_name: current.request.tenant_name };
      if (request.state !== "APPROVED") {
        setSupportInspection({ request });
        return;
      }
      try {
        const supportOverview = await platformRequest<PlatformSupportOverview>(operator, `support-access/${request.id}/overview`, { signal });
        setSupportInspection({ request, overview: supportOverview });
      } catch {
        if (!signal?.aborted) setSupportInspection({ request, overviewUnavailable: true });
      }
    } catch { /* The visible drawer keeps its last verified state until the next bounded refresh. */ }
  }, Boolean(supportInspection) && !busy);

  useEffect(() => {
    if (!filterInitialized.current) {
      filterInitialized.current = true;
      return;
    }
    const request = ++filterRequest.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoadingTenants(true);
      setTenantFailure(false);
      try {
        const next = await loadTenantPages(operator, query, stateFilter, 1, controller.signal);
        if (filterRequest.current === request) setTenants(next);
      } catch {
        if (!controller.signal.aborted && filterRequest.current === request) setTenantFailure(true);
      } finally {
        if (filterRequest.current === request) setLoadingTenants(false);
      }
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [operator, query, stateFilter]);

  async function loadMoreTenants() {
    if (!tenants.next_cursor || loadingTenants) return;
    setLoadingTenants(true);
    setTenantFailure(false);
    try {
      const next = await platformRequest<TenantOperationsPage>(operator, tenantListPath(query, stateFilter, tenants.next_cursor));
      setTenants((current) => ({
        ...next,
        items: [...current.items, ...next.items.filter((item) => !current.items.some((currentItem) => currentItem.tenant_id === item.tenant_id))],
      }));
    } catch {
      setTenantFailure(true);
    } finally {
      setLoadingTenants(false);
    }
  }

  async function retryTenantLoad() {
    setLoadingTenants(true);
    setTenantFailure(false);
    try {
      setTenants(await loadTenantPages(operator, query, stateFilter, 1));
    } catch {
      setTenantFailure(true);
    } finally {
      setLoadingTenants(false);
    }
  }

  async function mutate(path: string, body: Record<string, unknown>, method = "POST") {
    setBusy(true);
    setFeedback(undefined);
    const operation = `${method}:${path}:${JSON.stringify(body)}`;
    const idempotencyKey = operationKeys.current.get(operation) ?? crypto.randomUUID();
    operationKeys.current.set(operation, idempotencyKey);
    try {
      await platformRequest(operator, path, { method, body, idempotencyKey });
    } catch {
      setFeedback(t("platform.feedback.failed"));
      setBusy(false);
      return false;
    }
    operationKeys.current.delete(operation);
    setModal(null);
    setFeedback(t("platform.feedback.accepted"));
    try {
      await refresh();
    } catch {
      setFeedback(t("platform.feedback.acceptedRefreshFailed"));
    } finally {
      setBusy(false);
    }
    return true;
  }

  async function inspectUsage(tenant: TenantOperation) {
    setLoadingUsage(tenant.tenant_id);
    setFeedback(undefined);
    try {
      setUsage(await platformRequest<TenantUsage>(operator, `metering/tenants/${tenant.tenant_id}`));
    } catch {
      setFeedback(t("platform.feedback.usageFailed"));
    } finally {
      setLoadingUsage(undefined);
    }
  }

  async function inspectSupport(summary: PlatformOverview["support_requests"][number]) {
    setLoadingSupport(summary.id);
    setFeedback(undefined);
    try {
      const detail = await platformRequest<PlatformSupportAccessRequest>(operator, `support-access/${summary.id}`);
      const request = { ...detail, tenant_name: summary.tenant_name };
      setSupportInspection({ request });
      if (request.state === "APPROVED") {
        try {
          const supportOverview = await platformRequest<PlatformSupportOverview>(operator, `support-access/${summary.id}/overview`);
          setSupportInspection({ request, overview: supportOverview });
        } catch {
          setSupportInspection({ request, overviewUnavailable: true });
        }
      }
    } catch {
      setFeedback(t("platform.feedback.supportFailed"));
    } finally {
      setLoadingSupport(undefined);
    }
  }

  async function cancelSupport(request: PlatformSupportAccessRequest) {
    const accepted = await mutate(`support-access/${request.id}/cancel`, {});
    if (accepted) setSupportInspection(null);
  }

  async function signOut() {
    setFeedback(undefined);
    try{
      const response=await fetch("/platform/auth/logout",{method:"POST",headers:{"content-type":"application/json","x-wasalx-platform-csrf":operator.csrfToken},body:"{}"});
      const result=await response.json().catch(()=>({})) as {redirectTo?:unknown};
      if(!response.ok||typeof result.redirectTo!=="string")throw new Error("platform_logout_failed");
      window.location.assign(result.redirectTo);
    }catch{setFeedback(t("platform.feedback.failed"))}
  }

  return (
    <div className={`theme-${theme} wx-design-system ${styles.shell}`} dir={direction} lang={locale}>
      <a className="skip-link" href="#platform-main">{t("platform.accessibility.skipToContent")}</a>
      <aside className={styles.sidebar} data-mobile-navigation-open={mobileNavigationOpen}>
        <div className={styles.brand}><span className={styles.operatorMark}>WX</span><span>WasalX</span><small>{t("platform.brand.badge")}</small></div>
        <div className={styles.scopeCard}><span className={styles.scopeDot} /><span><b>{t("platform.scope.title")}</b><small>{t("platform.scope.description")}</small></span></div>
        <button
          ref={mobileNavigationButton}
          type="button"
          className={styles.mobileNavigationButton}
          aria-expanded={mobileNavigationOpen}
          aria-controls="platform-navigation"
          onClick={() => setMobileNavigationOpen((open) => !open)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          {t(mobileNavigationOpen ? "platform.navigation.close" : "platform.navigation.open")}
        </button>
        <nav id="platform-navigation" aria-label={t("platform.navigation.label")} className={styles.navigation}>
          <a aria-current={activeSection === "overview" ? "page" : undefined} href="#overview" onClick={() => closeMobileNavigation(setMobileNavigationOpen, mobileNavigationButton)}>{t("platform.navigation.overview")}</a>
          <a aria-current={activeSection === "tenants" ? "page" : undefined} href="#tenants" onClick={() => closeMobileNavigation(setMobileNavigationOpen, mobileNavigationButton)}>{t("platform.navigation.tenants")}</a>
          <a aria-current={activeSection === "capacity" ? "page" : undefined} href="#capacity" onClick={() => closeMobileNavigation(setMobileNavigationOpen, mobileNavigationButton)}>{t("platform.navigation.capacity")}</a>
          <a aria-current={activeSection === "support" ? "page" : undefined} href="#support" onClick={() => closeMobileNavigation(setMobileNavigationOpen, mobileNavigationButton)}>{t("platform.navigation.support")}</a>
        </nav>
        <div className={styles.operatorCard}>
          <span className={styles.avatar}>{initials(operator.displayName)}</span>
          <span><b dir="auto">{operator.displayName}</b><small>{t("platform.operator.mfaTime", { time: formatDateTime(operator.authenticatedAt * 1_000, locale, { hour: "2-digit", minute: "2-digit" }) })}</small></span>
          <button aria-label={t("platform.actions.signOut")} onClick={signOut}>↗</button>
        </div>
      </aside>

      <main className={styles.main} id="platform-main" tabIndex={-1}>
        <header className={styles.topbar}>
          <div><span className={styles.liveDot} />{t("platform.topbar.managed")}</div>
          <span>{t("platform.topbar.expires", { time: formatDateTime(operator.expiresAt * 1_000, locale, { hour: "2-digit", minute: "2-digit" }) })}</span>
          <div className={styles.localeSwitcher}>
            <LocaleSwitcher locale={locale} label={t("common.locale.label")} errorMessage={t("common.errors.generic")} />
          </div>
          <button
            aria-label={t(theme === "dark" ? "platform.theme.useLightLabel" : "platform.theme.useDarkLabel")}
            className={styles.themeButton}
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              rememberBoundaryTheme("platform",next);
            }}
          >{t(theme === "dark" ? "platform.theme.light" : "platform.theme.dark")}</button>
        </header>
        <div className={styles.content}>
          <section className={styles.hero} id="overview">
            <div><p className={styles.eyebrow}>{t("platform.hero.eyebrow")}</p><h1>{t("platform.hero.title")}</h1><p>{t("platform.hero.description")}</p></div>
            <div className={styles.heroActions}>
              <button className={styles.secondaryButton} onClick={() => setModal({ kind: "support" })}>{t("platform.actions.support")}</button>
              <button className={styles.primaryButton} onClick={() => setModal({ kind: "workspace" })}>{t("platform.actions.newWorkspace")}</button>
            </div>
          </section>
          {feedback ? <div className={styles.feedback} role="status">{feedback}</div> : null}

          <section aria-label={t("platform.summary.label")} className={styles.metrics}>
            <Metric label={t("platform.summary.activeTenants")} value={formatNumber(number(overview.tenant_summary.active), locale)} detail={t("platform.summary.total", { count: formatNumber(number(overview.tenant_summary.total), locale) })} />
            <Metric label={t("platform.summary.provisioning")} value={formatNumber(number(overview.tenant_summary.provisioning), locale)} detail={t("platform.summary.needReview", { count: formatNumber(number(overview.tenant_summary.failed), locale) })} attention={number(overview.tenant_summary.failed) > 0} />
            <Metric label={t("platform.summary.workerUtilization")} value={formatNumber(utilization, locale, { style: "percent", maximumFractionDigits: 0 })} detail={t("platform.summary.sessions", { assigned: formatNumber(assigned, locale), capacity: formatNumber(capacity, locale) })} />
            <Metric label={t("platform.summary.meteringCapture")} value={t(captureState === "HEALTHY" ? "platform.summary.meteringCurrent" : captureState === "STALE" ? "platform.summary.meteringDelayed" : "platform.summary.meteringUnknown")} detail={monthCost} attention={captureState !== "HEALTHY"} />
          </section>

          <section aria-busy={loadingTenants} className={styles.panel} id="tenants">
            <div className={styles.panelHeader}><div><h2>{t("platform.tenants.title")}</h2><p>{t("platform.tenants.description")}</p></div><span>{t("platform.tenants.count", { count: formatNumber(visibleTenants.length, locale) })}</span></div>
            <div className={styles.toolbar}>
              <label><span className="wx-visually-hidden">{t("platform.tenants.searchLabel")}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("platform.tenants.searchPlaceholder")} /></label>
              <select aria-label={t("platform.tenants.filterLabel")} value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value="">{t("platform.states.all")}</option><option value="ACTIVE">{t("platform.states.active")}</option><option value="PROVISIONING">{t("platform.states.provisioning")}</option><option value="PENDING">{t("platform.states.pending")}</option><option value="RUNNING">{t("platform.states.running")}</option><option value="FAILED_RETRYABLE">{t("platform.states.failed_retryable")}</option><option value="FAILED">{t("platform.states.failed")}</option><option value="SUSPEND_PENDING">{t("platform.states.suspend_pending")}</option><option value="SUSPENDING">{t("platform.states.suspending")}</option><option value="SUSPENDED">{t("platform.states.suspended")}</option><option value="RESUME_PENDING">{t("platform.states.resume_pending")}</option><option value="RESUMING">{t("platform.states.resuming")}</option><option value="DELETING">{t("platform.states.deleting")}</option>
              </select>
            </div>
            <p className={styles.tableScrollCue} id="platform-tenant-table-cue">{t("platform.tenants.scrollHint")}</p>
            <ScrollRegion
              className={styles.tableScroll}
              aria-label={t("platform.tenants.tableLabel")}
              aria-describedby="platform-tenant-table-cue"
            >
              <table>
                <thead><tr><th>{t("platform.tenants.columns.workspace")}</th><th>{t("platform.tenants.columns.lifecycle")}</th><th>{t("platform.tenants.columns.progress")}</th><th>{t("platform.states.zammad")}</th><th>{t("platform.tenants.columns.updated")}</th><th><span className="wx-visually-hidden">{t("platform.tenants.columns.actions")}</span></th></tr></thead>
                <tbody>{visibleTenants.map((tenant) => {
                  const allowedActions = new Set(tenant.allowed_actions ?? []);
                  return <tr key={tenant.tenant_id}>
                    <td><b dir="auto">{tenant.name}</b><small className={styles.identifiers}><bdi dir="ltr">{tenant.slug}</bdi><span aria-hidden="true"> · </span><bdi dir="ltr">{tenant.tenant_id}</bdi></small></td>
                    <td><Status value={tenant.status ?? tenant.tenant_state} /></td>
                    <td><Progress tenant={tenant} /></td>
                    <td><b>{tenant.zammad_state ? stateLabel(tenant.zammad_state, t) : t("platform.zammad.notReady")}</b><small>{tenant.zammad_version ?? t("platform.zammad.pinned")}</small></td>
                    <td><time dateTime={tenant.updated_at}>{formatRelativeTime(tenant.updated_at, locale, renderedAt)}</time></td>
                    <td><div className={styles.rowActions}>
                      <button type="button" disabled={loadingTenants || busy} onClick={() => setModal({ kind: "meta-routing", tenant })}>{t("platform.metaRouting.open")}</button>
                      <button disabled={loadingTenants || busy} onClick={() => setModal({ kind: "meta-transition", tenant })}>{t("platform.metaTransition.open")}</button>
                      <button disabled={loadingTenants || loadingUsage === tenant.tenant_id} onClick={() => inspectUsage(tenant)}>{loadingUsage === tenant.tenant_id ? t("platform.actions.loadingUsage") : t("platform.navigation.usage")}</button>
                      {allowedActions.has("RETRY") ? <button disabled={loadingTenants || busy} onClick={() => void mutate(`tenants/${tenant.tenant_id}/provisioning/retry`, {})}>{t("platform.actions.retryLifecycle")}</button> : null}
                      {allowedActions.has("SUSPEND") ? <button disabled={loadingTenants || busy} className={styles.dangerAction} onClick={() => setModal({ kind: "suspend", tenant })}>{t("platform.actions.suspendShort")}</button> : null}
                      {allowedActions.has("RESUME") ? <button disabled={loadingTenants || busy} onClick={() => setModal({ kind: "resume", tenant })}>{t("platform.actions.reactivate")}</button> : null}
                      <button disabled={loadingTenants || busy} onClick={() => setModal({ kind: "support", tenantId: tenant.tenant_id })}>{t("platform.actions.supportShort")}</button>
                    </div></td>
                  </tr>;
                })}</tbody>
              </table>
            </ScrollRegion>
            {!visibleTenants.length ? <div className={styles.empty}>{t("platform.tenants.empty")}</div> : null}
            {tenantFailure ? <div className={styles.pagination} role="alert"><span>{t("platform.tenants.loadFailed")}</span><button className={styles.secondaryButton} disabled={loadingTenants} onClick={() => void retryTenantLoad()}>{t("platform.error.retry")}</button></div> : null}
            {!tenantFailure && tenants.next_cursor ? <div className={styles.pagination}><button className={styles.secondaryButton} disabled={loadingTenants} onClick={() => void loadMoreTenants()}>{t(loadingTenants ? "platform.tenants.loadingMore" : "platform.tenants.loadMore")}</button></div> : null}
          </section>

          <div className={styles.twoColumn}>
            <section className={styles.panel} id="capacity">
              <div className={styles.panelHeader}><div><h2>{t("platform.workers.title")}</h2><p>{t("platform.workers.description")}</p></div><Status value={workerAggregateState} label={t("platform.workers.healthyRatio", { healthy: formatNumber(healthyWorkers, locale), total: formatNumber(workerTotal, locale) })} /></div>
              <div className={styles.workerList}>
                {overview.workers.map((worker) => {
                  const sessions = number(worker.assigned_sessions);
                  const workerUtilization = worker.capacity ? sessions / worker.capacity : 1;
                  const reactivate = worker.lifecycle_state !== "ACTIVE";
                  return <article key={worker.worker_key}>
                    <span className={styles.workerEngine}>{worker.engine === "GOWS" ? "G" : "N"}</span>
                    <span><b><bdi className={styles.identifier} dir="ltr">{worker.worker_key}</bdi></b><small><bdi dir="ltr">{worker.engine}</bdi> · {stateLabel(worker.rollout_mode, t)}</small><small>{worker.last_heartbeat_at ? t("platform.workers.lastHeartbeat", { time: formatRelativeTime(worker.last_heartbeat_at, locale, renderedAt) }) : t("platform.workers.noHeartbeat")}</small></span>
                    <span className={styles.workerCapacity}><b>{formatNumber(sessions, locale)}/{formatNumber(worker.capacity, locale)}</b><small>{t("platform.workers.assigned", { percent: formatNumber(workerUtilization, locale, { style: "percent", maximumFractionDigits: 0 }) })}</small></span>
                    <Status value={worker.lifecycle_state} />
                    <Status value={worker.health_state} />
                    <button aria-label={t(reactivate ? "platform.workers.reactivateLabel" : "platform.workers.drainLabel", { worker: worker.worker_key })} className={styles.textButton} onClick={() => setModal({ kind: "worker", worker })}>{t(reactivate ? "platform.actions.reactivate" : "platform.actions.drain")}</button>
                  </article>;
                })}
                {!overview.workers.length ? <div className={styles.empty}>{t("platform.workers.empty")}</div> : null}
              </div>
            </section>

            <section className={styles.panel} id="support">
              <div className={styles.panelHeader}><div><h2>{t("platform.support.title")}</h2><p>{t("platform.support.description", { active: formatNumber(number(overview.support_summary.active), locale), pending: formatNumber(number(overview.support_summary.pending), locale) })}</p></div><button className={styles.textButton} onClick={() => setModal({ kind: "support" })}>{t("platform.support.newRequest")}</button></div>
              <div className={styles.supportList}>
                {overview.support_requests.map((request) => <article key={request.id}><span><b dir="auto">{request.tenant_name}</b><small dir="auto">{request.reason}</small></span><span><Status value={request.state} /><time dateTime={request.requested_at}>{formatRelativeTime(request.requested_at, locale, renderedAt)}</time></span><button className={styles.textButton} disabled={loadingSupport === request.id} aria-label={t("platform.support.inspectLabel", { tenant: request.tenant_name })} onClick={() => void inspectSupport(request)}>{loadingSupport === request.id ? t("platform.support.loading") : t("platform.support.inspect")}</button></article>)}
                {!overview.support_requests.length ? <div className={styles.empty}>{t("platform.support.empty")}</div> : null}
              </div>
            </section>
          </div>
          <MetaDeletionReview csrfToken={operator.csrfToken} />
          <section className={styles.boundaryNote}><span>i</span><p><b>{t("platform.boundary.title")}</b><small>{t("platform.boundary.description")}</small></p></section>
        </div>
      </main>

      {usage ? <UsageDrawer key={usage.tenant.id} usage={usage} operator={operator} close={() => setUsage(null)} /> : null}
      {supportInspection ? <SupportInspectionDrawer inspection={supportInspection} busy={busy} close={() => setSupportInspection(null)} cancel={() => void cancelSupport(supportInspection.request)} /> : null}
      {modal?.kind === "meta-routing" ? <MetaRoutingReviewDialog key={`${modal.tenant.tenant_id}:${operator.csrfToken}`} tenant={modal.tenant} operator={operator} close={() => setModal(null)} /> : null}
      {modal?.kind === "meta-transition" ? <MetaTransitionOperator key={`${operator.recoveryScope}:${operator.csrfToken}:${modal.tenant.tenant_id}`} tenantId={modal.tenant.tenant_id} tenantName={modal.tenant.name} recoveryScope={operator.recoveryScope} request={(path, options) => platformRequest(operator, path, options)} close={() => setModal(null)} /> : null}
      {modal?.kind === "workspace" ? <WorkspaceDialog busy={busy} feedback={feedback} close={() => setModal(null)} submit={(body) => mutate("tenants", body)} /> : null}
      {modal?.kind === "support" ? <SupportDialog busy={busy} feedback={feedback} tenants={tenants.items} tenantId={modal.tenantId} close={() => setModal(null)} submit={(body) => mutate("support-access", body)} /> : null}
      {modal?.kind === "suspend" ? <SuspendDialog busy={busy} feedback={feedback} tenant={modal.tenant} close={() => setModal(null)} submit={(body) => mutate(`tenants/${modal.tenant.tenant_id}/suspend`, body)} /> : null}
      {modal?.kind === "resume" ? <ResumeDialog busy={busy} feedback={feedback} tenant={modal.tenant} close={() => setModal(null)} submit={(body) => mutate(`tenants/${modal.tenant.tenant_id}/resume`, body)} /> : null}
      {modal?.kind === "worker" ? <WorkerModeDialog busy={busy} feedback={feedback} worker={modal.worker} close={() => setModal(null)} submit={(body) => mutate(`waha-workers/${encodeURIComponent(modal.worker.worker_key)}/mode`, body, "PATCH")} /> : null}
    </div>
  );
}

function MetaRoutingReviewDialog({ tenant, operator, close }: { tenant: TenantOperation; operator: Operator; close: () => void }) {
  const { t, locale } = useI18n();
  const [reference, setReference] = useState("");
  const [data, setData] = useState<MetaRoutingOperatorDto | null>(null);
  const [busy, setBusy] = useState(false), [held, setHeld] = useState(false), [saved, setSaved] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const alive = useRef(false), writing = useRef(false), generation = useRef(0);
  const pending = useRef<{ key: string; body: MetaRoutingReviewBody } | null>(null);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  const connectionId = reference.trim();
  const path = `operations/tenants/${encodeURIComponent(tenant.tenant_id)}/connections/${encodeURIComponent(connectionId)}/meta-routing-review`;
  useEffect(() => {
    alive.current = true; const counter = generation;
    return () => { alive.current = false; counter.current++; };
  }, []);
  function safeFailure(failure: unknown) {
    const status = failure && typeof failure === "object" && "status" in failure ? failure.status : null;
    return t(status === 401 || status === 403 ? "platform.metaRouting.authority" : status === 404 ? "platform.metaRouting.notFound" : status === 409 ? "platform.metaRouting.conflict" : "platform.metaRouting.unavailable");
  }
  async function resolve() {
    if (!uuid.test(connectionId) || writing.current) return;
    const version = ++generation.current; setBusy(true); setFeedback(undefined); setSaved(false);
    try {
      const result = await platformRequest<MetaRoutingOperatorDto>(operator, path, { signal: AbortSignal.timeout(20_000) });
      if (!alive.current || version !== generation.current) return;
      if (result.connectionId !== connectionId || !uuid.test(result.sessionId)
        || !validMetaRoutingAssetId(result.phoneNumberId)) throw new Error("routing_identity_unavailable");
      setData(result);
      const expected = pending.current?.body, observed = result.review?.observation;
      // This is an immutable observation read, never provider configuration readback.
      if (expected && result.review && observed && result.review.version === expected.expectedReviewVersion + 1
        && result.sessionId === expected.expectedSessionId && result.review.configurationVersion === expected.expectedConfigurationVersion
        && observed.disposition === expected.disposition && observed.observedAt === expected.observedAt
        && observed.evidenceSha256 === expected.evidenceSha256 && observed.evidenceReference === expected.evidenceReference
        && observed.scope === expected.scope && observed.termsAccepted === expected.termsAccepted
        && observed.threadControlEnabled === expected.threadControlEnabled && observed.personallyObserved === true
        && ["roles", "targets", "fields"].every(field => {
          const key = field as "roles" | "targets" | "fields";
          return [...observed[key]].sort().join("|") === [...expected[key]].sort().join("|");
        })) { pending.current = null; setHeld(false); setSaved(true); }
    } catch (failure) {
      if (alive.current && version === generation.current) { setData(null); setFeedback(safeFailure(failure)); }
    } finally { if (alive.current && version === generation.current) setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || busy || writing.current || held || data.connectionId !== connectionId) return;
    const form = new FormData(event.currentTarget);
    const disposition = form.get("disposition") === "REVOKED" ? "REVOKED" : "REVIEWED";
    const roles = form.getAll("roles").filter((value): value is MetaRoutingRole => typeof value === "string" && META_ROUTING_ROLES.some(role => role === value));
    const targets = form.getAll("targets").filter((value): value is MetaRoutingRole => typeof value === "string" && META_ROUTING_ROLES.some(role => role === value));
    const fields = form.getAll("fields").filter((value): value is string => typeof value === "string" && ["messages", "standby", "messaging_handovers"].includes(value));
    const timestamp = new Date(String(form.get("observedAt") ?? ""));
    const evidenceSha256 = String(form.get("evidenceSha256") ?? "").trim().toLowerCase();
    const evidenceReference = String(form.get("evidenceReference") ?? "").trim();
    const termsAccepted = form.get("termsAccepted") === "on";
    if (!validMetaRoutingReviewEvidence(timestamp.getTime(), evidenceSha256, evidenceReference)
      || form.get("personallyObserved") !== "on"
      || (disposition === "REVIEWED" && (!roles.length || !termsAccepted || !fields.includes("messages") || !fields.includes("messaging_handovers")))) {
      setFeedback(t("platform.metaRouting.validation")); return;
    }
    const body: MetaRoutingReviewBody = { expectedSessionId: data.sessionId,
      expectedConfigurationVersion: data.declaration?.version ?? 0, expectedReviewVersion: data.review?.version ?? 0,
      disposition, observedAt: timestamp.toISOString(), evidenceSha256, evidenceReference,
      scope: form.get("scope") === "PHONE_OVERRIDE" ? "PHONE_OVERRIDE" : "ACCOUNT_DEFAULT",
      roles, targets, fields, termsAccepted, threadControlEnabled: form.get("threadControlEnabled") === "on", personallyObserved: true };
    const value = { key: crypto.randomUUID(), body }; pending.current = value;
    writing.current = true; generation.current++; setBusy(true); setFeedback(undefined); setSaved(false);
    try {
      const result = await platformRequest<MetaRoutingReviewResult>(operator, path, { method: "POST", body, idempotencyKey: value.key, signal: AbortSignal.timeout(20_000) });
      if (!alive.current) return;
      if (!uuid.test(result.id) || result.version !== body.expectedReviewVersion + 1 || result.disposition !== body.disposition) throw new Error("routing_review_unconfirmed");
      pending.current = null; setHeld(false); setData(null); setSaved(true);
    } catch (failure) {
      if (alive.current) {
        const status = failure && typeof failure === "object" && "status" in failure ? failure.status : null;
        // Only a lost response or server failure leaves the original save unresolved; a definite rejection admitted nothing.
        if (typeof status !== "number" || status >= 500 || status === 408) setHeld(true); else pending.current = null;
        setFeedback(safeFailure(failure));
        if (failure && typeof failure === "object" && "status" in failure && (failure.status === 401 || failure.status === 403)) setData(null);
      }
    } finally { if (alive.current) { writing.current = false; setBusy(false); } }
  }
  return <Dialog eyebrow={tenant.name} title={t("platform.metaRouting.title")} busy={busy} close={close} feedback={feedback}>{requestClose => <>
    <p className={styles.routingDetails}>{t("platform.metaRouting.boundary")}</p>
    <form className={styles.formGrid} onSubmit={event => { event.preventDefault(); void resolve(); }}>
      <label>{t("platform.metaRouting.connectionReference")}<input dir="ltr" required maxLength={36} value={reference} disabled={busy || held} onChange={event => {
        generation.current++; setReference(event.target.value); setData(null); setFeedback(undefined); setSaved(false); pending.current = null;
      }} /></label>
      <button className={styles.secondaryButton} disabled={busy || !uuid.test(connectionId)}>{t("platform.metaRouting.resolve")}</button>
    </form>
    {held ? <p role="status">{t("platform.metaRouting.unknown")}</p> : null}
    {saved ? <div className={styles.routingDetails}><div className={styles.feedback} role="status">{t("platform.metaRouting.saved")}</div></div> : null}
    {data ? <>
      <dl className={`${styles.detailGrid} ${styles.routingDetails}`}>
        <div><dt>{t("platform.metaRouting.phone")}</dt><dd><bdi dir="ltr">{data.phoneNumberId}</bdi></dd></div>
        <div><dt>{t("platform.metaRouting.account")}</dt><dd><bdi dir="ltr">{data.accountId ?? t("platform.metaRouting.none")}</bdi></dd></div>
        <div><dt>{t("platform.metaRouting.session")}</dt><dd><bdi dir="ltr">{data.sessionId}</bdi></dd></div>
        <div><dt>{t("platform.metaRouting.declaration")}</dt><dd>{t(data.declaration ? "platform.metaRouting.hold" : "platform.metaRouting.none")}</dd></div>
      </dl>
      {data.review ? <p>{t(`platform.metaRouting.disposition.${data.review.disposition}`)} · {formatDateTime(data.review.observedAt, locale, { dateStyle: "medium", timeStyle: "short" })} · {t(`platform.metaRouting.mode.${data.review.runtime.mode}`)}</p> : null}
      <form key={`${data.sessionId}:${data.declaration?.version ?? 0}:${data.review?.version ?? 0}`} className={styles.formGrid} onSubmit={event => void submit(event)}>
        <fieldset className={styles.routingFields} disabled={busy || held}>
          <legend>{t("platform.metaRouting.observation")}</legend>
          <label>{t("platform.metaRouting.disposition")}<select name="disposition" defaultValue="REVIEWED"><option value="REVIEWED">{t("platform.metaRouting.disposition.REVIEWED")}</option><option value="REVOKED">{t("platform.metaRouting.disposition.REVOKED")}</option></select></label>
          <label>{t("platform.metaRouting.observedAt")}<input name="observedAt" type="datetime-local" required /></label>
          <label>{t("platform.metaRouting.scope")}<select name="scope" defaultValue="PHONE_OVERRIDE"><option value="PHONE_OVERRIDE">{t("platform.metaRouting.phoneScope")}</option><option value="ACCOUNT_DEFAULT">{t("platform.metaRouting.accountScope")}</option></select></label>
          {(["roles", "targets"] as const).map(field => <fieldset key={field}><legend>{t(`platform.metaRouting.${field}`)}</legend>{META_ROUTING_ROLES.map(role => <label key={role}><input type="checkbox" name={field} value={role} />{t(`platform.metaRouting.role.${role}`)}</label>)}</fieldset>)}
          <fieldset><legend>{t("platform.metaRouting.fields")}</legend>{["messages", "standby", "messaging_handovers"].map(field => <label key={field}><input type="checkbox" name="fields" value={field} />{t(`platform.metaRouting.field.${field}`)}</label>)}</fieldset>
          <label><input type="checkbox" name="termsAccepted" />{t("platform.metaRouting.terms")}</label>
          <label><input type="checkbox" name="threadControlEnabled" />{t("platform.metaRouting.controlEnabled")}</label>
          <label>{t("platform.metaRouting.evidenceReference")}<input name="evidenceReference" required maxLength={200} autoComplete="off" /></label>
          <label>{t("platform.metaRouting.evidenceHash")}<input name="evidenceSha256" dir="ltr" required pattern="[0-9A-Fa-f]{64}" maxLength={64} autoComplete="off" /></label>
          <label><input type="checkbox" name="personallyObserved" required />{t("platform.metaRouting.personallyObserved")}</label>
        </fieldset>
        <footer className={`${styles.dialogActions} ${styles.routingActions}`}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={requestClose}>{t("platform.actions.close")}</button><button className={styles.primaryButton} disabled={busy || held}>{t("platform.metaRouting.save")}</button></footer>
      </form>
    </> : <footer className={styles.dialogActions}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={requestClose}>{t("platform.actions.close")}</button></footer>}
  </>}</Dialog>;
}

function closeMobileNavigation(
  setOpen: (open: boolean) => void,
  button: { current: HTMLButtonElement | null },
) {
  if (!window.matchMedia("(max-width: 48rem)").matches) return;
  setOpen(false);
  window.requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
}

function Metric({ label, value, detail, attention = false }: { label: string; value: string | number; detail: string; attention?: boolean }) {
  return <article className={attention ? styles.metricAttention : undefined}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function Progress({ tenant }: { tenant: TenantOperation }) {
  const { locale, t } = useI18n();
  const progress = Math.min(100, Math.max(0, Number(tenant.progress_percent ?? 0)));
  const step = tenant.current_step ? stateLabel(tenant.current_step, t) : t(progress === 100 ? "platform.states.complete" : "platform.states.queued");
  return <div className={styles.progress}><span><i style={{ inlineSize: `${progress}%` }} /></span><small>{formatNumber(progress / 100, locale, { style: "percent", maximumFractionDigits: 0 })} · {step}</small>{tenant.safe_error ? <small className={styles.progressError}>{t("platform.tenants.operationFailed")}</small> : null}{tenant.attempts !== undefined && tenant.max_attempts !== undefined ? <small>{t("platform.tenants.attempts", { attempts: formatNumber(tenant.attempts, locale), maximum: formatNumber(tenant.max_attempts, locale) })}</small> : null}</div>;
}

function Status({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const normalized = value.toUpperCase();
  const state = ["FAILED", "UNHEALTHY", "REVOKED", "DENIED"].some((item) => normalized.includes(item)) ? "danger" : ["HEALTHY", "ACTIVE", "WORKING", "COMPLETE", "APPROVED"].some((item) => normalized.includes(item)) ? "success" : "warning";
  return <span className={`${styles.status} ${styles[state]}`}><i />{label ?? stateLabel(value, t)}</span>;
}

function WorkspaceDialog({ busy, close, submit, feedback }: DialogProps) {
  const { t } = useI18n();
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    submit({ name: String(data.get("name")), slug: String(data.get("slug")), retentionDays: Number(data.get("retentionDays")), owner: { oidcSubject: String(data.get("oidcSubject")), email: String(data.get("email")), displayName: String(data.get("displayName")) }, deployment: { region: String(data.get("region")), resourceProfile: String(data.get("resourceProfile")), zammadVersion: String(data.get("zammadVersion")) } });
  }
  return <Dialog title={t("platform.dialog.workspace.title")} eyebrow={t("platform.dialog.workspace.eyebrow")} feedback={feedback} busy={busy} close={close}>{(requestClose) => <form onSubmit={onSubmit}><div className={styles.formGrid}>
    <label>{t("platform.form.workspaceName")}<input name="name" required minLength={2} maxLength={120} placeholder={t("platform.form.workspaceNamePlaceholder")} /></label>
    <label>{t("platform.form.slug")}<input dir="ltr" name="slug" required pattern={"[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?"} placeholder={t("platform.form.slugPlaceholder")} /></label>
    <label>{t("platform.form.ownerName")}<input name="displayName" required maxLength={120} /></label><label>{t("platform.form.ownerEmail")}<input dir="ltr" name="email" required type="email" maxLength={320} /></label>
    <label className={styles.wide}>{t("platform.form.ownerOidc")}<input dir="ltr" name="oidcSubject" required maxLength={255} /></label><label>{t("platform.form.region")}<input dir="ltr" name="region" required maxLength={63} pattern={"[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?"} defaultValue="sa-riyadh-1" /></label>
    <label>{t("platform.form.resourceProfile")}<select name="resourceProfile" defaultValue="small"><option value="small">{t("platform.resource.small")}</option><option value="medium">{t("platform.resource.medium")}</option><option value="large">{t("platform.resource.large")}</option></select></label>
    <label>{t("platform.form.zammadVersion")}<select dir="ltr" name="zammadVersion" defaultValue="7.1.3"><option value="7.1.3">7.1.3</option></select></label><label>{t("platform.form.retentionDays")}<input name="retentionDays" required type="number" min={1} max={3650} defaultValue={90} /></label>
  </div><DialogActions busy={busy} close={requestClose} action={t("platform.actions.startProvisioning")} /></form>}</Dialog>;
}

function SupportDialog({ busy, close, submit, tenants, tenantId, feedback }: DialogProps & { tenants: TenantOperation[]; tenantId?: string }) {
  const { locale, t } = useI18n();
  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); submit({ tenantId: String(data.get("tenantId")), reason: String(data.get("reason")), durationSeconds: Number(data.get("durationSeconds")) }); }
  return <Dialog title={t("platform.dialog.support.title")} eyebrow={t("platform.dialog.support.eyebrow")} feedback={feedback} busy={busy} close={close}>{(requestClose) => <form onSubmit={onSubmit}><div className={styles.formGrid}>
    <label className={styles.wide}>{t("platform.form.workspace")}<select name="tenantId" required defaultValue={tenantId ?? ""}><option value="" disabled>{t("platform.form.selectWorkspace")}</option>{tenants.map((tenant) => <option key={tenant.tenant_id} value={tenant.tenant_id}>{tenant.name} · {tenant.slug}</option>)}</select></label>
    <label className={styles.wide}>{t("platform.form.operationalReason")}<textarea name="reason" required minLength={10} maxLength={500} placeholder={t("platform.form.supportReasonPlaceholder")} /></label>
    <label>{t("platform.form.requestedDuration")}<select name="durationSeconds" defaultValue="900"><option value="300">{formatDuration(300, locale)}</option><option value="900">{formatDuration(900, locale)}</option><option value="1800">{formatDuration(1800, locale)}</option><option value="3600">{formatDuration(3600, locale)}</option></select></label>
  </div><div className={styles.consentNote}><span>✓</span><p><b>{t("platform.dialog.support.consentTitle")}</b><small>{t("platform.dialog.support.consentDescription")}</small></p></div><DialogActions busy={busy} close={requestClose} action={t("platform.actions.sendRequest")} /></form>}</Dialog>;
}

function SuspendDialog({ busy, close, submit, tenant, feedback }: DialogProps & { tenant: TenantOperation }) {
  const { t } = useI18n();
  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); submit({ reason: String(new FormData(event.currentTarget).get("reason")) }); }
  return <Dialog title={<>{t("platform.dialog.suspend.titlePrefix")} <bdi dir="auto">{tenant.name}</bdi></>} eyebrow={t("platform.dialog.lifecycle.eyebrow")} feedback={feedback} busy={busy} close={close}>{(requestClose) => <form onSubmit={onSubmit}><div className={styles.warningBox}><span>!</span><p><b>{t("platform.dialog.suspend.warningTitle")}</b><small>{t("platform.dialog.suspend.warningDescription")}</small></p></div><div className={styles.formGrid}><label className={styles.wide}>{t("platform.form.suspensionReason")}<textarea name="reason" required minLength={3} maxLength={500} /></label></div><DialogActions busy={busy} close={requestClose} action={t("platform.actions.requestSuspension")} danger /></form>}</Dialog>;
}

function ResumeDialog({ busy, close, submit, tenant, feedback }: DialogProps & { tenant: TenantOperation }) {
  const { t } = useI18n();
  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); submit({ reason: String(new FormData(event.currentTarget).get("reason")) }); }
  return <Dialog title={<>{t("platform.dialog.resume.titlePrefix")} <bdi dir="auto">{tenant.name}</bdi></>} eyebrow={t("platform.dialog.lifecycle.eyebrow")} feedback={feedback} busy={busy} close={close}>{(requestClose) => <form onSubmit={onSubmit}><div className={styles.warningBox}><span>i</span><p><b>{t("platform.dialog.resume.warningTitle")}</b><small>{t("platform.dialog.resume.warningDescription")}</small></p></div><div className={styles.formGrid}><label className={styles.wide}>{t("platform.form.reactivationReason")}<textarea name="reason" required minLength={3} maxLength={500} placeholder={t("platform.form.reactivationPlaceholder")} /></label></div><DialogActions busy={busy} close={requestClose} action={t("platform.actions.requestReactivation")} /></form>}</Dialog>;
}

function WorkerModeDialog({ busy, close, submit, worker, feedback }: DialogProps & { worker: PlatformOverview["workers"][number] }) {
  const { t } = useI18n(); const targetState = worker.lifecycle_state === "ACTIVE" ? "DRAINING" : "ACTIVE"; const draining = targetState === "DRAINING";
  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); submit({ version: Number(worker.version), lifecycleState: targetState, rolloutMode: worker.rollout_mode, ...(worker.rollout_mode === "CANARY" ? { canarySessionLimit: worker.canary_session_limit } : {}), reason: String(new FormData(event.currentTarget).get("reason")) }); }
  return <Dialog title={<>{t(draining ? "platform.dialog.worker.drainPrefix" : "platform.dialog.worker.reactivatePrefix")} <bdi className={styles.identifier} dir="ltr">{worker.worker_key}</bdi></>} eyebrow={t("platform.dialog.worker.eyebrow")} feedback={feedback} busy={busy} close={close}>{(requestClose) => <form onSubmit={onSubmit}><div className={styles.warningBox}><span>i</span><p><b>{t(draining ? "platform.dialog.worker.drainTitle" : "platform.dialog.worker.reactivateTitle")}</b><small>{t("platform.dialog.worker.description")}</small></p></div><div className={styles.formGrid}><label className={styles.wide}>{t("platform.form.operationalReason")}<textarea name="reason" required minLength={3} maxLength={500} placeholder={t(draining ? "platform.form.drainPlaceholder" : "platform.form.workerReactivatePlaceholder")} /></label></div><DialogActions busy={busy} close={requestClose} action={t(draining ? "platform.actions.beginDrain" : "platform.actions.reactivateWorker")} danger={draining} /></form>}</Dialog>;
}

function Dialog({ title, eyebrow, close, feedback, busy, children }: { title: ReactNode; eyebrow: string; close: () => void; feedback?: string; busy: boolean; children: (requestClose: () => void) => ReactNode }) {
  const { t } = useI18n();
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else close();
  };
  return <ModalDialog close={requestClose} className={styles.backdrop} aria-labelledby="platform-dialog-title"><section className={styles.dialog} data-unsaved={dirty || undefined} onChangeCapture={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) setDirty(true);
  }}><header><div><p className={styles.eyebrow}>{eyebrow}</p><h2 id="platform-dialog-title">{title}</h2></div><button type="button" disabled={busy} aria-label={t("platform.actions.closeDialog")} onClick={requestClose}>×</button></header>{feedback ? <div className={styles.dialogFeedback} role="alert">{feedback}</div> : null}{children(requestClose)}{confirmClose ? <InlineConfirmation className={styles.discardConfirmation} aria-labelledby="platform-discard-title" cancel={() => setConfirmClose(false)}><div><b id="platform-discard-title">{t("platform.dialog.discard.title")}</b><p>{t("platform.dialog.discard.body")}</p></div><div><button type="button" className={styles.secondaryButton} data-inline-confirm-initial-focus onClick={() => setConfirmClose(false)}>{t("platform.dialog.discard.keepEditing")}</button><button type="button" className={styles.dangerButton} onClick={close}>{t("platform.dialog.discard.discard")}</button></div></InlineConfirmation> : null}</section></ModalDialog>;
}
type DialogProps = { busy: boolean; feedback?: string; close: () => void; submit: (body: Record<string, unknown>) => void };
function DialogActions({ busy, close, action, danger = false }: { busy: boolean; close: () => void; action: string; danger?: boolean }) {
  const { t } = useI18n();
  return <footer className={styles.dialogActions}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={close}>{t("platform.actions.cancel")}</button><button disabled={busy} className={danger ? styles.dangerButton : styles.primaryButton}>{busy ? t("platform.actions.submitting") : action}</button></footer>;
}

function UsageDrawer({ usage, operator, close }: { usage: TenantUsage; operator:Operator; close: () => void }) {
  const { locale, t } = useI18n();
  const estimatedByCurrency = new Map<string, number>();
  for (const row of usage.usage) {
    if (row.currency === "UNPRICED") continue;
    estimatedByCurrency.set(row.currency, (estimatedByCurrency.get(row.currency) ?? 0) + number(row.estimated_cost_micros));
  }
  return <ModalDialog close={close} className={`${styles.backdrop} ${styles.drawerBackdrop}`} aria-labelledby="usage-title"><aside className={styles.drawer}><header><div><p className={styles.eyebrow}>{t("platform.usage.eyebrow")}</p><h2 id="usage-title" dir="auto">{usage.tenant.name}</h2><p>{formatDateTime(usage.from, locale, { dateStyle: "medium" })} – {formatDateTime(usage.to, locale, { dateStyle: "medium" })}</p></div><button aria-label={t("platform.actions.closeUsage")} onClick={close}>×</button></header><div className={styles.usageSummary}><span><small>{t("platform.usage.estimatedCost")}</small><b className={styles.currencyTotals}>{estimatedByCurrency.size ? [...estimatedByCurrency].map(([currency, estimated]) => <bdi dir="ltr" key={currency}>{formatMicros(estimated, currency, locale)}</bdi>) : t("platform.usage.noPricedCost")}</b></span><span><small>{t("platform.usage.meterFamilies")}</small><b>{formatNumber(usage.usage.length, locale)}</b></span><span><small>{t("platform.usage.advisoryQuotas")}</small><b>{formatNumber(usage.quotas.length, locale)}</b></span></div><div className={styles.usageList}>{usage.usage.map((row) => <article key={`${row.meter}-${row.currency}`}><span><b>{stateLabel(row.meter, t)}</b><small>{t("platform.usage.idempotentEvents", { count: formatNumber(number(row.event_count), locale) })}</small></span><span><b>{formatQuantity(row.quantity, locale)}</b><small>{row.currency === "UNPRICED" ? t("platform.usage.rateMissing") : formatMicros(Number(row.estimated_cost_micros), row.currency, locale)}</small></span></article>)}{!usage.usage.length ? <div className={styles.empty}>{t("platform.usage.empty")}</div> : null}</div><section className={styles.quotaSection}><h3>{t("platform.usage.quotaPosture")}</h3>{usage.quotas.map((quota) => <div key={quota.id}><span><b>{stateLabel(quota.meter, t)}</b><small>{t("platform.usage.observeOnly", { period: stateLabel(quota.period, t) })}</small></span><span><b>{formatQuantity(quota.soft_limit, locale)}</b><small>{quota.hard_limit ? t("platform.usage.hardLimit", { limit: formatQuantity(quota.hard_limit, locale) }) : t("platform.usage.noHardLimit")}</small></span></div>)}{!usage.quotas.length ? <p>{t("platform.usage.noQuotas")}</p> : null}</section><PlatformMetaCosts tenantId={usage.tenant.id} csrfToken={operator.csrfToken}/></aside></ModalDialog>;
}

function SupportInspectionDrawer({ inspection, busy, close, cancel }: { inspection: SupportInspection; busy: boolean; close: () => void; cancel: () => void }) {
  const { locale, t } = useI18n();
  const renderedAt = useRelativeClock();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const request = inspection.request;
  const cancelable = request.state === "PENDING" || request.state === "APPROVED";
  const overview = inspection.overview;
  return <ModalDialog close={busy ? () => {} : close} className={`${styles.backdrop} ${styles.drawerBackdrop}`} aria-labelledby="support-inspection-title"><aside className={styles.drawer}><header><div><h2 id="support-inspection-title" dir="auto">{request.tenant_name ?? t("platform.support.workspaceFallback")}</h2><p>{t("platform.support.requested", { time: formatRelativeTime(request.requested_at, locale, renderedAt) })}</p></div><button disabled={busy} aria-label={t("platform.actions.closeSupport")} onClick={close}>×</button></header><div className={styles.usageSummary}><span><small>{t("platform.support.state")}</small><Status value={request.state} /></span><span><small>{t("platform.support.duration")}</small><b>{formatDuration(number(request.requested_duration_seconds ?? 0), locale)}</b></span><span><small>{t(request.state === "APPROVED" ? "platform.support.accessExpires" : "platform.support.requestExpires")}</small><b>{formatDateTime(request.state === "APPROVED" && request.access_expires_at ? request.access_expires_at : request.request_expires_at, locale, { dateStyle: "medium", timeStyle: "short" })}</b></span></div><section className={styles.detailSection}><h3>{t("platform.support.reason")}</h3><p dir="auto">{request.reason}</p></section>{overview ? <section className={styles.detailSection}><h3>{t("platform.support.authorizedMetadata")}</h3><dl className={styles.detailGrid}><div><dt>{t("platform.support.tenantState")}</dt><dd><Status value={overview.tenant.state} /></dd></div><div><dt>{t("platform.states.zammad")}</dt><dd><Status value={overview.zammad?.state ?? "UNKNOWN"} /></dd></div><div><dt>{t("platform.support.provisioningState")}</dt><dd><Status value={overview.provisioning?.status ?? "UNKNOWN"} /></dd></div><div><dt>{t("platform.support.connections")}</dt><dd>{formatNumber(overview.connections.length, locale)}</dd></div><div><dt>{t("platform.support.deliveries")}</dt><dd>{formatNumber(recordTotal(overview.delivery_summary), locale)}</dd></div><div><dt>{t("platform.support.inboundEvents")}</dt><dd>{formatNumber(recordTotal(overview.inbound_summary), locale)}</dd></div></dl></section> : request.state === "APPROVED" && inspection.overviewUnavailable ? <div className={styles.dialogFeedback} role="alert">{t("platform.support.overviewUnavailable")}</div> : <section className={styles.detailSection}><h3>{t("platform.support.authorization")}</h3><p>{t(request.state === "PENDING" ? "platform.support.awaitingApproval" : "platform.support.inactive")}</p></section>}{confirmCancel ? <InlineConfirmation busy={busy} className={styles.supportConfirmation} aria-labelledby="platform-support-cancel-title" cancel={() => setConfirmCancel(false)}><div><b id="platform-support-cancel-title">{t(request.state === "APPROVED" ? "platform.support.endConfirmTitle" : "platform.support.cancelConfirmTitle")}</b><p>{t(request.state === "APPROVED" ? "platform.support.endConfirmBody" : "platform.support.cancelConfirmBody")}</p></div><div><button type="button" className={styles.secondaryButton} data-inline-confirm-initial-focus disabled={busy} onClick={() => setConfirmCancel(false)}>{t("platform.actions.keepSupport")}</button><button type="button" className={styles.dangerButton} disabled={busy} onClick={cancel}>{busy ? t("platform.actions.submitting") : t(request.state === "APPROVED" ? "platform.actions.endSupport" : "platform.actions.cancelSupport")}</button></div></InlineConfirmation> : <footer className={styles.drawerActions}><button type="button" className={styles.secondaryButton} disabled={busy} onClick={close}>{t("platform.actions.close")}</button>{cancelable ? <button type="button" className={styles.dangerButton} disabled={busy} onClick={() => setConfirmCancel(true)}>{t(request.state === "APPROVED" ? "platform.actions.endSupport" : "platform.actions.cancelSupport")}</button> : null}</footer>}</aside></ModalDialog>;
}

async function loadTenantPages(operator: Operator, query: string, state: string, pageCount: number, signal?: AbortSignal) {
  const items: TenantOperation[] = [];
  let page = await platformRequest<TenantOperationsPage>(operator, tenantListPath(query, state), { signal });
  items.push(...page.items);
  for (let index = 1; index < pageCount && page.next_cursor; index += 1) {
    page = await platformRequest<TenantOperationsPage>(operator, tenantListPath(query, state, page.next_cursor), { signal });
    items.push(...page.items);
  }
  return { ...page, items };
}

function tenantListPath(query: string, state: string, cursor?: string) {
  const parameters = new URLSearchParams({ limit: "50" });
  if (query.trim()) parameters.set("query", query.trim());
  if (state) parameters.set("state", state);
  if (cursor) parameters.set("cursor", cursor);
  return `operations/tenants?${parameters}`;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;
function stateLabel(value: string, t: Translator) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "");
  const known = new Set([
    "active", "active_group_hours", "approved", "awaiting_auth", "cancelled", "canary", "complete", "connected_number_hours", "database", "day", "defaults", "deleting", "denied", "disabled", "draining", "expired", "failed", "failed_retryable", "full", "health", "healthy", "identity", "inbound_messages", "media_bytes", "month", "oidc", "outbound_messages", "package", "pending", "provisioning", "queued", "resume_pending", "resume_prepare", "resume_publish", "resuming", "revoked", "running", "search", "secrets", "stable", "stale", "storage", "suspend_pending", "suspended", "suspending", "unknown", "unhealthy", "waha_capacity_unit_hours", "waha_session_hours", "working", "zammad", "zammad_cpu_core_hours", "zammad_memory_gib_hours", "zammad_storage_gib_hours",
  ]);
  return known.has(normalized) ? t(`platform.states.${normalized}`) : t("platform.states.unavailable");
}
function number(value: number | string) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function initials(value: string) { return value.split(/\s+/u).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "OP"; }
function formatQuantity(value: string, locale: "en" | "ar") { const parsed = Number(value); return Number.isFinite(parsed) ? formatNumber(parsed, locale, { maximumFractionDigits: 2, notation: parsed > 999_999 ? "compact" : "standard" }) : value; }
function formatMicros(value: number, currency: string, locale: "en" | "ar") { return formatCurrency(value / 1_000_000, currency === "USD" ? "USD" : "SAR", locale); }
function recordTotal(value: Record<string, number | string>) { return Object.values(value).reduce<number>((total, entry) => total + number(entry), 0); }
function monthCostSummary(rows: PlatformOverview["month_cost_summary"], locale: "en" | "ar", t: Translator) {
  const priced = rows.filter((row) => row.currency === "SAR" || row.currency === "USD").map((row) => formatMicros(number(row.estimated_cost_micros), row.currency, locale));
  const unpriced = rows.reduce<number>((total, row) => total + number(row.unpriced_quantity), 0);
  const cost = priced.length ? priced.join(" · ") : t("platform.usage.noPricedCost");
  return unpriced > 0 ? t("platform.summary.monthCostUnpriced", { cost, quantity: formatQuantity(String(unpriced), locale) }) : t("platform.summary.monthCost", { cost });
}
