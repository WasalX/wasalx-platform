"use client";
import { useEffect, useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { useI18n } from "./I18nProvider";
import { formatDateTime, formatNumber } from "../lib/i18n/format.ts";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui.ts";
import { type RecordRow, RelativeTime, type TenantTranslator, apiError, isOpaqueIdentifier, Empty, Toolbar } from "./tenant-ui";

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

export function Audit({ rows, showDiagnostics, canExport }: { rows: RecordRow[]; showDiagnostics: boolean; canExport: boolean }) {
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
