"use client";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import { useI18n, useRelativeClock } from "./I18nProvider";
import { formatNumber, formatRelativeTime } from "../lib/i18n/format.ts";
import { operatorFailureMessage, operatorLocalFailure, createLatestRequestFence } from "../lib/operator-ui.ts";
import { useVisibleRefresh } from "./use-visible-refresh";
import { isAbortError } from "../lib/bot-conversations";
import { type RecordRow, RelativeTime, type TenantTranslator, connectionMethod, apiError, isOpaqueIdentifier, Status, Empty, SectionLoading, WideTable, Toolbar } from "./tenant-ui";

const NativeRoutingSync = lazy(async () => ({ default: (await import("./NativeRoutingSync")).NativeRoutingSync }));
const GROUP_DISPLAY_PAGE_SIZE=50;
function groupDestination(value: unknown, t: TenantTranslator) {
  const destination = String(value ?? "").trim();
  if (!destination || destination === "Not configured") return t("tenant.group.destinationNotConfigured");
  return isOpaqueIdentifier(destination) || /^\d+$/u.test(destination)
    ? t("tenant.group.destinationConfigured")
    : destination;
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

export function Groups({
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
        results?: Array<{ id: string; ok: boolean }>;
        code?: string;
      };
      // operatorFailureMessage maps the code or status to catalogue text; the API's English text is never shown.
      if (!response.ok && response.status !== 207) throw Object.assign(new Error(), { status: response.status, code: result.code });
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
          <table className="stacked-table group-table">
            <thead>
              <tr>
                {canToggle ? <th className="select-column"><label><input type="checkbox" checked={allVisibleSelected} aria-label={t(allVisibleSelected ? "tenant.group.selection.clearVisible" : "tenant.group.selection.selectVisible")} onChange={toggleVisible} /></label></th> : null}
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
                  {canToggle ? <td className="select-column"><label><input type="checkbox" checked={selected.has(String(row.id))} aria-label={t("tenant.group.selection.selectNamed", { name: String(row.name) })} onChange={() => toggleSelection(String(row.id))} /></label></td> : null}
                  <td>
                    <div className="cell-main">
                      <span className="group-logo">#</span>
                      <span>
                        <b><bdi dir="auto">{String(row.name)}</bdi></b>
                        <small><bdi dir="auto">{String(connections.find((connection) => connection.id === row.connection_id)?.name ?? "")}</bdi></small>
                      </span>
                    </div>
                  </td>
                  <td data-label={t("tenant.group.columns.destination")}>
                    <span className="tag"><bdi dir="auto">{(() => {
                      return groupDestination(row.zammad_group, t);
                    })()}</bdi></span>
                  </td>
                  <td data-label={t("tenant.group.columns.rule")}>
                    <b><bdi dir="auto">{String(row.rule_name) === "Not configured" ? t("tenant.group.destinationNotConfigured") : String(row.rule_name)}</bdi></b>
                  </td>
                  <td data-label={t("tenant.group.columns.members")}>{row.members === null ? <span title={t("tenant.group.membersUnavailable")}>—</span> : Number.isFinite(Number(row.members)) ? formatNumber(Number(row.members), locale) : <bdi dir="auto">{String(row.members)}</bdi>}</td>
                  <td data-label={t("tenant.group.columns.lastMessage")}><RelativeTime value={row.last_message_at} pastOnly/></td>
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

        <Suspense fallback={<SectionLoading />}><NativeRoutingSync canWrite={canConfigure} mutationHeaders={mutationHeaders} refreshKey={JSON.stringify(savedForm)} /></Suspense>

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
