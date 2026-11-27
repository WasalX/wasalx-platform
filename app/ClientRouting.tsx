"use client";

import { draftSupportQueues, type SupportQueueOrigin } from "../lib/client-routing-draft";
import { clientRoutingQueueWarnings } from "../lib/client-routing-availability";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime as formatLocalizedDateTime, formatNumber } from "../lib/i18n/format";
import { createLatestRequestFence, operatorResponseFailure } from "../lib/operator-ui";
import { localizedUiError, normalizeUiErrorCode, type UiErrorCode } from "../lib/ui-error";
import {
  parseClientRouting,
  type ClientRoutingDefinition,
} from "../packages/core/src/client-routing";
import { ModalDialog } from "./ModalDialog";
import { useI18n } from "./I18nProvider";
import { WideTable } from "./tenant-ui";
import { useVisibleRefresh } from "./use-visible-refresh";
import { NativeRoutingSync } from "./NativeRoutingSync";

type Row = Record<string, unknown>;
type CatalogPage = { items: Row[]; next_cursor: string | null };
type Props = {
  canWrite: boolean;
  mutationHeaders: Record<string, string>;
  connections: Row[];
};
type RoutingCatalog = {
  groups: Array<{ id: string; name: string; active: boolean; serviceIdentityCanCreate: boolean }>;
  owners: Array<{ id: string; name: string; login: string; active: boolean; groupIds: string[] }>;
};
type RoutingIntegration = { id:string;provider:"NOTION"|"ZOHO"|"HTTP_JSON";display_name:string;auth_scheme:"BEARER"|"HMAC";binding_reference:string|null;state:string;revision:number;source_id?:string|null;last_success_at?:unknown;latest_test_state?:unknown;latest_test_safe_error?:unknown };
type RoutingCredentialForm = {integrationId:string|null;provider:"ZOHO"|"HTTP_JSON";displayName:string;authScheme:"BEARER"|"HMAC";credential:string;expectedRevision:number|null};
type IntegrationCallbackHint = { result:"refresh"|"failed"; integrationId:string|null };
type OperatorError = { message: string; code: UiErrorCode | null };
const pendingDataConnectionKey="wasalx:pending-data-connection";
const emptyCatalog: RoutingCatalog = { groups: [], owners: [] };
const starter = (t: ReturnType<typeof useI18n>["t"], catalog: RoutingCatalog): ClientRoutingDefinition => ({
  schemaVersion: 1,
  name: t("routing.starter.name"),
  supportGroupIds: [],
  fallback: { zammadGroupId: catalog.groups.find(group => group.active && group.serviceIdentityCanCreate)?.id ?? "2" },
  sources: [
    {
      id: "manual",
      name: t("routing.starter.source"),
      kind: "MANUAL",
      syncMode: "MANUAL",
      fieldMapping: {},
    },
  ],
  clients: [],
});

export function ConnectedDataServices({
  canWrite,
  mutationHeaders,
}: {
  canWrite: boolean;
  mutationHeaders: Record<string, string>;
}) {
  const { direction, locale, t } = useI18n();
  const requestError = useCallback((status: number) => t("automation.common.requestFailed", { status }), [t]);
  const [integrations, setIntegrations] = useState<RoutingIntegration[]>([]);
  const [externalConnectorsEnabled,setExternalConnectorsEnabled]=useState(false);
  const [notionOAuthEnabled, setNotionOAuthEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [credentialForm,setCredentialForm]=useState<RoutingCredentialForm|null>(null);
  const [savingCredential,setSavingCredential]=useState(false);
  const [testingCredential,setTestingCredential]=useState<string|null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<OperatorError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const callbackHint = useRef<IntegrationCallbackHint | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);
  const credentialOperation=useRef<{fingerprint:string;key:string}|null>(null);
  const credentialTestKeys=useRef(new Map<string,string>());
  const load = useCallback(async (background = false, sourceSignal?: AbortSignal) => {
    const sequence = ++loadSequence.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const abortFromSource = () => controller.abort();
    if (sourceSignal?.aborted) abortFromSource();
    else sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
    const isCurrent = () => !controller.signal.aborted && sequence === loadSequence.current;
    if (isCurrent() && !background) {
      setLoading(true);
      setError(null);
    }
    try {
      const [capabilities, rows] = await Promise.all([
        routingCapabilitiesData(requestError, controller.signal),
        routingIntegrationData(requestError, controller.signal),
      ]);
      if (!isCurrent()) return;
      setExternalConnectorsEnabled(capabilities.externalConnectorsEnabled);
      setNotionOAuthEnabled(capabilities.notionOAuthEnabled);
      setIntegrations(rows);
      const hint=callbackHint.current;
      if(hint?.result==="failed"){
        callbackHint.current=null;
        forgetPendingDataConnection();
        setNotice(null);
        setError({ message: t("routing.errors.integrationCallback"), code: null });
      }else if(hint?.result==="refresh"){
        const connected=Boolean(hint.integrationId)&&rows.some(row=>row.id===hint.integrationId&&row.state==="CONNECTED");
        if(connected){
          callbackHint.current=null;
          forgetPendingDataConnection();
          setError(null);
          setNotice(t("routing.notice.integrationConnected"));
        }else{
          setNotice(null);
          setError({ message: t("routing.errors.integrationNotReady"), code: null });
        }
      }
    } catch {
      if (isCurrent()) setError({ message: t("routing.errors.integrationStatus"), code: null });
    } finally {
      sourceSignal?.removeEventListener("abort", abortFromSource);
      if (loadController.current === controller) loadController.current = null;
      if (isCurrent()) setLoading(false);
    }
  }, [requestError, t]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("routingIntegration");
    if(result==="refresh"||result==="failed"){
      callbackHint.current={result,integrationId:readPendingDataConnection()};
      url.searchParams.delete("routingIntegration");
      window.history.replaceState(window.history.state, "", url);
    }
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      loadController.current?.abort();
    };
  }, [load]);
  useVisibleRefresh((signal) => load(true, signal), !loading && !refreshing && !connecting);
  const refresh=async()=>{setRefreshing(true);try{await load(true)}finally{setRefreshing(false)}};
  const connectNotion = async (integrationId?:string) => {
    loadController.current?.abort();
    setConnecting(true);
    setError(null);
    setNotice(null);
    callbackHint.current=null;
    try {
      const response = await fetch("/api/client-routing/integrations/notion/start", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({integrationId}),
      });
      if (!response.ok) throw await operatorResponseFailure(response, t("routing.errors.integration"));
      const value = await response.json() as { authorizationUrl?: unknown; integrationId?: unknown };
      if (typeof value.authorizationUrl !== "string" || typeof value.integrationId !== "string") throw new Error(t("routing.errors.integration"));
      rememberPendingDataConnection(value.integrationId);
      window.location.assign(value.authorizationUrl);
    } catch (problem) {
      forgetPendingDataConnection();
      setError(operatorError(problem, t("routing.errors.integration"), locale));
      setConnecting(false);
    }
  };
  const newCredential=(provider:"ZOHO"|"HTTP_JSON")=>{setError(null);setNotice(null);setCredentialForm({integrationId:null,provider,displayName:"",authScheme:"BEARER",credential:"",expectedRevision:null})};
  const editCredential=(integration:RoutingIntegration)=>{if(integration.provider==="NOTION")return;setError(null);setNotice(null);setCredentialForm({integrationId:integration.id,provider:integration.provider,displayName:integration.display_name,authScheme:integration.auth_scheme,credential:"",expectedRevision:integration.revision})};
  const saveCredential=async(event:React.FormEvent)=>{event.preventDefault();if(!credentialForm)return;const fingerprint=JSON.stringify(credentialForm);if(credentialOperation.current?.fingerprint!==fingerprint)credentialOperation.current={fingerprint,key:crypto.randomUUID()};setSavingCredential(true);setError(null);setNotice(null);try{const response=await fetch("/api/client-routing/integrations/credential",{method:"POST",headers:{...mutationHeaders,"idempotency-key":credentialOperation.current.key},body:fingerprint});if(!response.ok)throw await operatorResponseFailure(response,requestError(response.status));credentialOperation.current=null;setCredentialForm(null);setNotice(t(credentialForm.integrationId?"routing.notice.credentialUpdated":"routing.notice.credentialConnected"));await load(true)}catch(problem){setError(operatorError(problem,t("routing.errors.credential"), locale))}finally{setSavingCredential(false)}};
  const testCredential=async(integration:RoutingIntegration)=>{const intent=`${integration.id}:${integration.revision}`;const key=credentialTestKeys.current.get(intent)??crypto.randomUUID();credentialTestKeys.current.set(intent,key);setTestingCredential(integration.id);setError(null);setNotice(null);try{const response=await fetch(`/api/client-routing/integrations/${encodeURIComponent(integration.id)}/test`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":key},body:JSON.stringify({expectedRevision:integration.revision})});if(!response.ok)throw await operatorResponseFailure(response,requestError(response.status));credentialTestKeys.current.delete(intent);setNotice(t("routing.notice.credentialTestRequested"));await load(true)}catch(problem){setError(operatorError(problem,integration.source_id?t("routing.errors.credentialTest"):t("routing.errors.credentialTestNeedsSource"), locale))}finally{setTestingCredential(null)}};
  const connectionBusy=loading||refreshing||connecting||savingCredential||testingCredential!==null||credentialForm!==null;
  if(!error&&!integrations.length&&!externalConnectorsEnabled&&!notionOAuthEnabled)return null;
  return (
    <section className="panel data-connections" aria-labelledby="data-connections-title" dir={direction}>
      <div className="panel-heading">
        <div>
          <h2 id="data-connections-title">{t("routing.integrations.title")}</h2>
          <p>{t("routing.integrations.help")}</p>
        </div>
        <div className="data-connections-actions">
          {!canWrite ? <span className="tag">{t("automation.common.readOnly")}</span> : null}
          <button type="button" className="button secondary small" disabled={connectionBusy} onClick={() => void refresh()}>
            {t(refreshing ? "routing.integrations.refreshing" : "routing.integrations.refresh")}
          </button>
          {canWrite && notionOAuthEnabled ? (
            <button type="button" className="button secondary small" disabled={connectionBusy} onClick={() => void connectNotion()}>
              {t(connecting ? "routing.integrations.connecting" : "routing.integrations.connectNotion")}
            </button>
          ) : null}
          {canWrite&&externalConnectorsEnabled?<button type="button" className="button secondary small" disabled={connectionBusy} onClick={()=>newCredential("ZOHO")}>{t("routing.integrations.addZoho")}</button>:null}
          {canWrite&&externalConnectorsEnabled?<button type="button" className="button primary small" disabled={connectionBusy} onClick={()=>newCredential("HTTP_JSON")}>{t("routing.integrations.addHttps")}</button>:null}
        </div>
      </div>
      {error ? (
        <div className="settings-feedback error data-connections-feedback" role="alert">
          <span>!</span>
          <p>{error.message}</p>
          {error.code === "REAUTHENTICATION_REQUIRED"?<a className="button small secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent("/app?view=connections")}`}>{t("routing.integrations.reauthenticate")}</a>:null}
          <button type="button" className="button small" onClick={() => void refresh()}>{t("automation.common.reload")}</button>
        </div>
      ) : null}
      {notice ? (
        <div className="settings-feedback success data-connections-feedback" role="status">
          <span>✓</span>
          <p>{notice}</p>
        </div>
      ) : null}
      {credentialForm?<form className="data-credential-form" onSubmit={(event)=>void saveCredential(event)}>
        <div><h3>{t(credentialForm.integrationId?"routing.integrations.updateCredentialTitle":"routing.integrations.addCredentialTitle",{provider:sourceKindLabel(credentialForm.provider,t)})}</h3><p>{t("routing.integrations.credentialHelp")}</p></div>
        <div className="routing-editor-grid">
          <label htmlFor="routing-credential-name">{t("routing.integrations.connectionName")}<input id="routing-credential-name" required maxLength={160} autoComplete="organization" value={credentialForm.displayName} onChange={event=>setCredentialForm({...credentialForm,displayName:event.target.value})}/></label>
          {credentialForm.provider==="HTTP_JSON"?<label htmlFor="routing-credential-auth">{t("routing.integrations.authentication")}<select id="routing-credential-auth" value={credentialForm.authScheme} onChange={event=>setCredentialForm({...credentialForm,authScheme:event.target.value as "BEARER"|"HMAC"})}><option value="BEARER">{t("routing.integrations.bearer")}</option><option value="HMAC">{t("routing.integrations.hmac")}</option></select></label>:null}
          <label htmlFor="routing-credential-value">{credentialForm.authScheme==="HMAC"?t("routing.integrations.signingSecret"):t("routing.integrations.accessToken")}<input id="routing-credential-value" required minLength={16} maxLength={4096} type="password" autoComplete="new-password" aria-describedby="routing-credential-help" value={credentialForm.credential} onChange={event=>setCredentialForm({...credentialForm,credential:event.target.value})}/><small id="routing-credential-help">{t("routing.integrations.writeOnlyHelp")}</small></label>
        </div>
        <div className="bot-form-actions"><button type="button" className="button secondary" disabled={savingCredential} onClick={()=>setCredentialForm(null)}>{t("automation.common.cancel")}</button><button type="submit" className="button primary" disabled={savingCredential}>{t(savingCredential?"routing.integrations.savingCredential":"routing.integrations.saveCredential")}</button></div>
      </form>:null}
      {loading && !integrations.length ? (
        <div className="data-connections-loading" role="status">{t("routing.integrations.loading")}</div>
      ) : integrations.length ? (
        <ul className="data-connection-list">
          {integrations.map((integration) => {
            const connected=integration.state==="CONNECTED";
            const credentialProvider=integration.provider!=="NOTION";
            const recoveryKey=credentialProvider
              ? !canWrite
                ? "routing.integrations.recoveryCredentialReadOnly"
                : !externalConnectorsEnabled
                  ? "routing.integrations.recoveryUnavailable"
                  : integration.state==="CONNECTING"
                    ? "routing.integrations.recoveryCredentialConnecting"
                    : "routing.integrations.recoveryCredentialAttention"
              : !canWrite
              ? "routing.integrations.recoveryReadOnly"
              : !notionOAuthEnabled
                ? "routing.integrations.recoveryUnavailable"
                : integration.state==="CONNECTING"
                  ? "routing.integrations.recoveryConnecting"
                  : integration.state==="REVOKED"
                    ? "routing.integrations.recoveryRevoked"
                    : "routing.integrations.recoveryAttention";
            return <li key={integration.id} className={connected?"":"needs-recovery"}>
              <header>
                <span>
                  <b><bdi>{integration.display_name}</bdi></b>
                  <small>{t(credentialProvider?"routing.integrations.connectedService":"routing.integrations.connectedWorkspace", { provider: sourceKindLabel(integration.provider,t) })}</small>
                </span>
                <State value={integration.state} />
              </header>
              {connected&&credentialProvider?<div className="data-connection-verification">
                <p>{integration.source_id?t("routing.integrations.testReady"):t("routing.integrations.testNeedsSource")}</p>
                {integration.latest_test_state?<span>{t("routing.integrations.lastTest")} <State value={integration.latest_test_state}/></span>:null}
                {canWrite?<div><button type="button" className="button secondary small" disabled={connectionBusy} onClick={()=>editCredential(integration)}>{t("routing.integrations.updateCredential")}</button><button type="button" className="button secondary small" disabled={connectionBusy||!integration.source_id} onClick={()=>void testCredential(integration)}>{testingCredential===integration.id?t("routing.integrations.testing"):t("routing.integrations.test")}</button></div>:null}
              </div>:null}
              {!connected?<div className="data-connection-recovery">
                <p>{t(recoveryKey)}</p>
                {canWrite&&(integration.provider==="NOTION"?notionOAuthEnabled:externalConnectorsEnabled)?<button type="button" className="button secondary small" disabled={connectionBusy} aria-label={t("routing.integrations.reconnectNamed",{name:integration.display_name})} onClick={()=>integration.provider==="NOTION"?void connectNotion(String(integration.id)):editCredential(integration)}>{t("routing.integrations.reconnect")}</button>:null}
              </div>:null}
            </li>;
          })}
        </ul>
      ) : error ? null : (
        <Empty
          title={t("routing.integrations.emptyTitle")}
          body={!canWrite?t("routing.integrations.emptyReadOnly"):notionOAuthEnabled||externalConnectorsEnabled ? t("routing.integrations.emptyBody") : t("routing.integrations.unavailable")}
        />
      )}
    </section>
  );
}

function readPendingDataConnection(){try{return window.sessionStorage.getItem(pendingDataConnectionKey)}catch{return null}}
function rememberPendingDataConnection(integrationId:string){try{window.sessionStorage.setItem(pendingDataConnectionKey,integrationId)}catch{/* The callback will remain unconfirmed if session storage is unavailable. */}}
function forgetPendingDataConnection(){try{window.sessionStorage.removeItem(pendingDataConnectionKey)}catch{/* Storage can be unavailable in hardened browser contexts. */}}

export function ClientRouting({
  canWrite,
  mutationHeaders,
  connections,
}: Props) {
  const { direction, locale, t } = useI18n();
  const requestError = useCallback((status: number) => t("automation.common.requestFailed", { status }), [t]);
  const [versions, setVersions] = useState<Row[]>([]);
  const [sourceStates, setSourceStates] = useState<Row[]>([]);
  const [qualificationStates,setQualificationStates]=useState<Row[]>([]);
  const [catalog, setCatalog] = useState<RoutingCatalog>(emptyCatalog);
  const [catalogAvailable, setCatalogAvailable] = useState(false);
  const [integrations,setIntegrations]=useState<RoutingIntegration[]>([]);
  const [externalConnectorsEnabled, setExternalConnectorsEnabled] =
    useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [loadingMoreVersions, setLoadingMoreVersions] = useState(false);
  const [versionPaginationError, setVersionPaginationError] = useState<string | null>(null);
  const versionPagesExtended = useRef(false);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncingSource, setSyncingSource] = useState<string | null>(null);
  const [qualifyingSource,setQualifyingSource]=useState<string|null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<ClientRoutingDefinition | null>(null);
  const editorReturnFocus = useRef<HTMLElement | null>(null);
  const [activationTarget, setActivationTarget] = useState<{row:Row;definition:ClientRoutingDefinition}|null>(null);
  const previousActiveId = useRef<string | null>(null);
  const refreshFence = useRef(createLatestRequestFence());
  const sourceFence = useRef(createLatestRequestFence());
  const qualificationFence = useRef(createLatestRequestFence());
  const qualificationVersion = useRef<string | null>(null);
  const qualificationController = useRef<AbortController | null>(null);
  const mutationKeys=useRef(new Map<string,string>());
  const intentKey=(intent:string)=>{const key=mutationKeys.current.get(intent)??crypto.randomUUID();mutationKeys.current.set(intent,key);return key};
  const [supportOrigin, setSupportOrigin] = useState<SupportQueueOrigin>(null);
  const openEditor = useCallback((definition: ClientRoutingDefinition, origin: SupportQueueOrigin = null) => {
    editorReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setError(null);
    setSupportOrigin(origin);
    setEditor(definition);
  }, []);
  const closeEditor = useCallback(() => {
    setEditor(null);
    window.requestAnimationFrame(() => editorReturnFocus.current?.focus({ preventScroll: true }));
  }, []);
  const editorOpen = editor !== null;
  useEffect(() => {
    if (!editorOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById("routing-editor-title");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorOpen]);
  const applyRows = useCallback((page: CatalogPage) => {
    setVersions((current) => refreshCatalogRows(current, page.items, versionPagesExtended.current, "id"));
    setVersionCursor((current) => versionPagesExtended.current ? current : page.next_cursor);
    setVersionPaginationError(null);
    setSelectedId((current) =>
      current && page.items.some((row) => String(row.id) === current)
        ? current
        : String(
            page.items.find((row) => row.state === "ACTIVE")?.id ?? page.items[0]?.id ?? "",
          ),
    );
  }, []);
  const loadSources = useCallback(async (signal?: AbortSignal) => {
    const request = sourceFence.current.begin();
    const isCurrent = () => !signal?.aborted && sourceFence.current.isCurrent(request);
    try {
      const next = await routingSourceData(requestError, signal);
      if (!isCurrent()) return;
      setSourceStates(next);
      setSourceError(null);
    } catch (problem) {
      if (!isAbortError(problem) && isCurrent()) setSourceError(message(problem, t("routing.errors.connectorStatus"), locale));
    }
  }, [locale, requestError, t]);
  const loadQualifications = useCallback(async (versionId: string, signal?: AbortSignal) => {
    // A completed mutation for a previous selection must not replace the current
    // version's qualification status or cancel its request.
    if (qualificationVersion.current !== versionId || signal?.aborted) return;
    const request = qualificationFence.current.begin();
    qualificationController.current?.abort();
    const controller = new AbortController();
    qualificationController.current = controller;
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const isCurrent = () => !requestSignal.aborted && qualificationVersion.current === versionId && qualificationFence.current.isCurrent(request);
    try {
      const response = await fetch(`/api/client-routing/${encodeURIComponent(versionId)}/qualifications`, { cache: "no-store", signal: requestSignal });
      if (!response.ok) throw new Error();
      const next = await response.json() as Row[];
      if (isCurrent()) setQualificationStates(next);
    } catch (problem) {
      if (isCurrent() && !isAbortError(problem)) setQualificationStates([]);
    } finally {
      if (qualificationController.current === controller) qualificationController.current = null;
    }
  }, []);
  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    const request = refreshFence.current.begin();
    const isCurrent = () => !signal?.aborted && refreshFence.current.isCurrent(request);
    if (!background) { setLoading(true); setError(null); }
    try {
      const page = await routingData(requestError, undefined, signal);
      if (!isCurrent()) return;
      applyRows(page);
      setHasLoaded(true);
      const capabilities = await routingCapabilitiesData(requestError, signal);
      const [sources, nextCatalog, nextIntegrations] = await Promise.allSettled([
        routingSourceData(requestError, signal),
        routingCatalogData(requestError, signal),
        routingIntegrationData(requestError, signal),
      ]);
      if (!isCurrent()) return;
      setExternalConnectorsEnabled(capabilities.externalConnectorsEnabled);
      if(sources.status==="fulfilled"){setSourceStates(sources.value);setSourceError(null)}else setSourceError(message(sources.reason,t("routing.errors.connectorStatus"),locale));
      // Keep the last known catalog when a background refresh fails, so names do not flip to "unavailable".
      if(nextCatalog.status==="fulfilled")setCatalog(nextCatalog.value);
      setCatalogAvailable(nextCatalog.status === "fulfilled");
      if(nextIntegrations.status==="fulfilled")setIntegrations(nextIntegrations.value);
    } catch (problem) {
      if (isCurrent() && !isAbortError(problem)) setError(message(problem, t("routing.errors.unavailable"), locale));
    } finally {
      if (!background && isCurrent()) setLoading(false);
    }
  }, [applyRows, locale, requestError, t]);
  useEffect(() => {
    const fence = refreshFence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(false, controller.signal), 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      fence.invalidate();
    };
  }, [load]);
  useEffect(() => {
    const activeId = String(versions.find((row) => row.state === "ACTIVE")?.id ?? "");
    const previous = previousActiveId.current;
    if (previous && activeId && activeId !== previous)
      setSelectedId((current) => current === previous ? activeId : current);
    previousActiveId.current = activeId || null;
  }, [versions]);
  useEffect(() => {
    const fence = sourceFence.current;
    return () => fence.invalidate();
  }, [loadSources]);
  const sourceJobsPending = sourceStates.some(state => ["QUEUED", "RUNNING", "FAILED_RETRYABLE"].includes(String(state.latest_job_state)));
  useVisibleRefresh((signal) => loadSources(signal), sourceStates.length > 0, sourceJobsPending ? 3_000 : 30_000);
  const selected = versions.find((row) => String(row.id) === selectedId) ?? null;
  const visibleQualificationStates = selected?.state === "DRAFT" ? qualificationStates.filter(item => String(item.routing_version_id) === String(selected.id)) : [];
  useEffect(() => {
    const fence = qualificationFence.current;
    const controllerRef = qualificationController;
    const versionRef = qualificationVersion;
    const versionId = selected?.state === "DRAFT" ? String(selected.id) : null;
    versionRef.current = versionId;
    const timer = versionId ? window.setTimeout(() => void loadQualifications(versionId), 0) : null;
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      versionRef.current = null;
      fence.invalidate();
      controllerRef.current?.abort();
    };
  }, [loadQualifications, selected?.id, selected?.state]);
  const qualificationJobsPending = visibleQualificationStates.some(item => ["QUEUED", "RUNNING", "FAILED_RETRYABLE"].includes(String(item.state)));
  useVisibleRefresh((signal) => selected ? loadQualifications(String(selected.id), signal) : undefined, selected?.state === "DRAFT", qualificationJobsPending ? 3_000 : 30_000);
  useVisibleRefresh((signal) => load(true, signal), !loading && !busy && editor === null && activationTarget === null);
  const loadMoreVersions = async () => {
    if (!versionCursor || loadingMoreVersions) return;
    setLoadingMoreVersions(true); setVersionPaginationError(null);
    try {
      const page = await routingData(requestError, versionCursor);
      versionPagesExtended.current = true;
      setVersions((current) => appendCatalogRows(current, page.items, "id"));
      setVersionCursor(page.next_cursor);
    } catch { setVersionPaginationError(t("routing.versions.loadMoreFailed")); }
    finally { setLoadingMoreVersions(false); }
  };
  const [selectedDetailError, setSelectedDetailError] = useState<{ id: string; message: string } | null>(null);
  const selectedDetailErrorMessage = selectedDetailError?.id === selectedId ? selectedDetailError.message : null;
  useEffect(() => {
    if (!selectedId || selected?.definition !== undefined) return;
    const controller = new AbortController();
    void fetch(`/api/client-routing/${encodeURIComponent(selectedId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status)); return response.json() as Promise<Row>; })
      .then((detail) => setVersions((current) => mergeCatalogDetail(current, detail, "id")))
      .catch((problem) => { if (problem instanceof DOMException && problem.name === "AbortError") return; setSelectedDetailError({ id: selectedId, message: message(problem, t("routing.errors.unavailable"), locale) }); });
    return () => controller.abort();
  }, [detailRetry, locale, requestError, selected?.definition, selectedId, t]);
  const definition = useMemo(() => {
    try {
      return selected ? parseClientRouting(selected.definition) : null;
    } catch {
      return null;
    }
  }, [selected]);
  const newDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      if (selected && !definition) throw new Error(t("routing.errors.unavailable"));
      const active = versions.find((row) => row.state === "ACTIVE");
      let activeDefinition: ClientRoutingDefinition | undefined;
      if (active) {
        let detail = active;
        if (detail.definition === undefined) {
          const response = await fetch(`/api/client-routing/${encodeURIComponent(String(active.id))}`, { cache: "no-store" });
          if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
          detail = await response.json() as Row;
          if (String(detail.id) !== String(active.id) || detail.state !== "ACTIVE" || String(detail.revision) !== String(active.revision))
            throw new Error(t("routing.errors.unavailable"));
        }
        activeDefinition = parseClientRouting(detail.definition);
      }
      const base = definition ?? starter(t, catalog);
      const queues = draftSupportQueues({
        baseIds: base.supportGroupIds,
        baseIsActive: Boolean(selected && active && String(selected.id) === String(active.id)),
        activeIds: activeDefinition?.supportGroupIds,
        hasActiveVersion: Boolean(active),
        eligibleIds: catalog.groups.filter((group) => group.active && group.serviceIdentityCanCreate).map((group) => group.id),
      });
      openEditor({ ...base, supportGroupIds: queues.ids }, queues.origin);
    } catch (problem) {
      setError(message(problem, t("routing.errors.unavailable"), locale));
    } finally {
      setBusy(false);
    }
  };
  const qualifySource=async(sourceId:string)=>{if(!selected||!definition)return;const source=definition.sources.find(item=>item.id===sourceId);const integration=source&&"secretReference" in source?integrations.find(item=>item.binding_reference===source.secretReference&&item.provider===source.kind):undefined;if(!source||source.kind==="MANUAL"||!integration)return;const intent=JSON.stringify(["qualify",selected.id,selected.revision,sourceId,integration.id,integration.revision]);setQualifyingSource(sourceId);setError(null);setNotice(null);try{const response=await fetch(`/api/client-routing/${encodeURIComponent(String(selected.id))}/sources/${encodeURIComponent(sourceId)}/qualify`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":intentKey(intent)},body:JSON.stringify({integrationId:integration.id,expectedIntegrationRevision:integration.revision,expectedRoutingRevision:selected.revision})});if(!response.ok)throw await operatorResponseFailure(response,requestError(response.status));mutationKeys.current.delete(intent);setNotice(t("routing.notice.qualificationRequested",{source:source.name}));await loadQualifications(String(selected.id))}catch(problem){setError(message(problem,t("routing.errors.qualification"), locale))}finally{setQualifyingSource(null)}};
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editor === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const definition = parseClientRouting(editor);
      const intent=JSON.stringify(["create",definition]);
      if (
        !externalConnectorsEnabled &&
        definition.sources.some((source) => source.kind !== "MANUAL")
      ) {
        setError(t("routing.errors.externalDisabled"));
        return;
      }
      const response = await fetch("/api/client-routing", {
        method: "POST",
        headers: { ...mutationHeaders, "idempotency-key": intentKey(intent) },
        body: JSON.stringify(definition),
      });
      if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
      const created = await response.json().catch(() => ({})) as { id?: unknown };
      mutationKeys.current.delete(intent);
      closeEditor();
      setNotice(
        t("routing.notice.created"),
      );
      await load();
      // Show the draft that was just created so it can be reviewed and activated.
      if (typeof created.id === "string") setSelectedId(created.id);
    } catch (problem) {
      setError(message(problem, t("routing.errors.create"), locale));
    } finally {
      setBusy(false);
    }
  };
  const syncSource = async (sourceId: string, expectedSnapshotRevision: number) => {
    const intent=JSON.stringify(["sync",sourceId,expectedSnapshotRevision]);
    setSyncingSource(sourceId); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/client-routing/sources/${encodeURIComponent(sourceId)}/sync`, { method: "POST", headers: { ...mutationHeaders, "idempotency-key": intentKey(intent) }, body: JSON.stringify({ expectedSnapshotRevision }) });
      if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
      mutationKeys.current.delete(intent);setNotice(t("routing.notice.syncRequested")); await loadSources();
    } catch (problem) { setError(message(problem, t("routing.errors.sync"), locale)); }
    finally { setSyncingSource(null); }
  };
  const activate = async () => {
    if (!activationTarget) return;
    const selected=activationTarget.row;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const active = versions.find((row) => row.state === "ACTIVE");
      const body={expectedRevision:Number(selected.revision),expectedActiveRoutingVersionId:active?.id??null};
      const intent=JSON.stringify(["activate",selected.id,body]);
      const response = await fetch(
        `/api/client-routing/${encodeURIComponent(String(selected.id))}/activate`,
        {
          method: "POST",
          headers: {
            ...mutationHeaders,
            "idempotency-key": intentKey(intent),
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
      mutationKeys.current.delete(intent);
      setNotice(t("routing.notice.activated"));
      setActivationTarget(null);
      await load();
    } catch (problem) {
      setError(message(problem, t("routing.errors.activate"), locale));
    } finally {
      setBusy(false);
    }
  };
  if (loading && !versions.length)
    return (
      <section className="panel bot-loading" aria-busy="true">
        <p className="sr-only" role="status" aria-label={t("routing.loading")}>{t("routing.loading")}</p>
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </section>
    );
  if (error && !hasLoaded)
    return (
      <section className="panel settings-load-error" role="alert">
        <span>!</span>
        <div>
          <b>{t("routing.errors.unavailable")}</b>
          <p>{error}</p>
          <button className="button small" onClick={() => void load()}>{t("automation.common.reload")}</button>
        </div>
      </section>
    );
  return (
    <div className="routing-workspace" dir={direction}>
      {error ? (
        <div className="settings-feedback error bot-feedback" role="alert">
          <span>!</span>
          <p>{error}</p>
          <button className="button small" onClick={() => void load()}>
            {t("automation.common.reload")}
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="settings-feedback success bot-feedback" role="status">
          <span>✓</span>
          <p>{notice}</p>
        </div>
      ) : null}
      {hasLoaded && !error && !versionCursor && !versions.some((row) => row.state === "ACTIVE") ? (
        <div className="settings-feedback bot-feedback" role="status">
          <span>!</span>
          <p><b>{t("routing.versions.noActiveTitle")}</b> {t(canWrite ? "routing.versions.noActiveWriterBody" : "routing.versions.noActiveBody")}</p>
        </div>
      ) : null}
      <NativeRoutingSync canWrite={canWrite} mutationHeaders={mutationHeaders} catalog={catalog} refreshKey={JSON.stringify(versions.map(row => [row.id, row.revision, row.state]))} />
      <div className="bot-workspace">
        <aside className="panel bot-version-list">
          <div className="panel-heading">
            <div>
              <h2>{t("routing.versions.title")}</h2>
              <p>{t("routing.versions.help")}</p>
            </div>
            {canWrite ? (
              <button
                className="button primary small"
                disabled={editor !== null || busy || loading || Boolean(selected && !definition)}
                onClick={() => void newDraft()}
              >
                {t("routing.versions.new")}
              </button>
            ) : (
              <span className="tag">{t("automation.common.readOnly")}</span>
            )}
          </div>
          <div>
            {versions.length ? (
              versions.map((row) => (
                <button
                  key={String(row.id)}
                  className={String(row.id) === selectedId ? "selected" : ""}
                  aria-pressed={String(row.id) === selectedId}
                  onClick={() => setSelectedId(String(row.id))}
                >
                  <span>
                    <b>{t("routing.versions.version", { version: formatNumber(Number(row.version), locale) })}</b>
                    <small>
                      <span className="sr-only">{t("routing.versions.createdAt")} </span>
                      <bdi>{formatTime(row.created_at, locale, t)}</bdi>
                    </small>
                  </span>
                  <State value={row.state} />
                </button>
              ))
            ) : error ? null : (
              <Empty
                title={t("routing.versions.emptyTitle")}
                body={t("routing.versions.emptyBody")}
              />
            )}
          </div>
          {versionPaginationError ? <p className="bot-inline-error" role="alert">{versionPaginationError}</p> : null}
          {versionCursor ? <button type="button" className="routing-version-toggle" disabled={loadingMoreVersions} onClick={() => void loadMoreVersions()}>{t(loadingMoreVersions ? "routing.versions.loadingMore" : "routing.versions.loadMore")}</button> : null}
        </aside>
        {selected && selected.definition === undefined && !selectedDetailErrorMessage ? <section className="panel bot-loading" aria-busy="true"><p className="sr-only" role="status" aria-label={t("routing.detail.loading")}>{t("routing.detail.loading")}</p><span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/></section> : selectedDetailErrorMessage ? <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("routing.detail.unavailable")}</b><p>{selectedDetailErrorMessage}</p><button className="button small" onClick={() => { setSelectedDetailError(null); setDetailRetry((value) => value + 1); }}>{t("automation.common.reload")}</button></div></section> : selected && definition ? (
          <section className="panel routing-detail">
            <div className="panel-heading">
              <div>
                <h2>
                  {t("routing.detail.title", { name: definition.name, version: formatNumber(Number(selected.version), locale) })}
                </h2>
                <p>
                  {t("routing.detail.summary", { clients: formatNumber(definition.clients.length, locale), sources: formatNumber(definition.sources.length, locale) })}
                </p>
              </div>
              {canWrite && selected.state === "DRAFT" ? (
                <span><button className="button primary small" disabled={busy} aria-disabled={!externalConnectorsEnabled&&definition.sources.some(source=>source.kind!=="MANUAL")} aria-describedby="routing-activation-gate" onClick={()=>{if(externalConnectorsEnabled||definition.sources.every(source=>source.kind==="MANUAL")){setError(null);setActivationTarget({row:selected,definition})}}}>{t(busy?"routing.detail.activating":"routing.detail.review")}</button>{!externalConnectorsEnabled&&definition.sources.some(source=>source.kind!=="MANUAL")?<small id="routing-activation-gate" className="bot-inline-error">{t("routing.detail.externalGate")}</small>:null}</span>
              ) : null}
            </div>
            {!editor && catalogAvailable ? <RoutingQueueWarnings definition={definition} catalog={catalog} /> : null}
            <SourceList
              canWrite={canWrite}
              sources={definition.sources}
              states={selected.state === "ACTIVE" ? sourceStates : []}
              error={selected.state === "ACTIVE" ? sourceError : null}
              reload={loadSources}
              syncingSource={syncingSource}
              syncSource={syncSource}
              versionState={String(selected.state)}
              qualifications={visibleQualificationStates}
              integrations={integrations}
              qualifyingSource={qualifyingSource}
              qualifySource={qualifySource}
            />
            <ClientTable clients={definition.clients} sources={definition.sources} connections={connections} catalog={catalog} />
            <RoutingSimulator
              key={`${String(selected.id)}:${String(selected.revision)}:${String(selected.snapshot_sha256)}`}
              versionId={String(selected.id)}
              connections={connections}
              clients={definition.clients}
              catalog={catalog}
              mutationHeaders={mutationHeaders}
            />
            {canWrite ? (
              <details className="routing-raw">
                <summary>{t("routing.detail.raw")}</summary>
                <pre>{JSON.stringify(definition, null, 2)}</pre>
              </details>
            ) : null}
          </section>
        ) : error ? null : (
          <section className="panel">
            <Empty
              title={t("routing.detail.chooseTitle")}
              body={t("routing.detail.chooseBody")}
            />
          </section>
        )}
      </div>
      {editor !== null ? (
        <RoutingDraftEditor
          value={editor}
          error={error}
          supportOrigin={supportOrigin}
          connections={connections}
          busy={busy}
          externalConnectorsEnabled={externalConnectorsEnabled}
          setValue={setEditor}
          cancel={closeEditor}
          save={create}
          catalog={catalog}
          catalogAvailable={catalogAvailable}
          integrations={integrations}
        />
      ) : null}
      {activationTarget?<ModalDialog close={()=>setActivationTarget(null)} className="modal-backdrop" aria-labelledby="routing-activate-title"><div className="modal bot-confirm"><div><h2 id="routing-activate-title">{t("routing.activation.title", { version: formatNumber(Number(activationTarget.row.version), locale) })}</h2><p>{t("routing.activation.description", { activeVersion: versions.find(row=>row.state==="ACTIVE") ? t("routing.versions.version", { version: formatNumber(Number(versions.find(row=>row.state==="ACTIVE")?.version), locale) }) : t("routing.activation.none"), clients: formatNumber(activationTarget.definition.clients.length, locale), sources: formatNumber(activationTarget.definition.sources.length, locale) })}</p>{!activationTarget.definition.supportGroupIds?.length?<p className="routing-editor-help" role="note">{t("routing.activation.noSupportEntries")}</p>:null}{error?<p className="bot-inline-error" role="alert">{error}</p>:null}</div><span><button data-modal-initial-focus className="button secondary" onClick={()=>setActivationTarget(null)}>{t("automation.common.cancel")}</button><button className="button primary" disabled={busy} onClick={()=>void activate()}>{t(busy?"routing.detail.activating":"routing.activation.confirm")}</button></span></div></ModalDialog>:null}
    </div>
  );
}

function SourceList({
  canWrite,
  sources,
  states,
  error,
  reload,
  syncingSource,
  syncSource,
  versionState,
  qualifications,
  integrations,
  qualifyingSource,
  qualifySource,
}: {
  canWrite: boolean;
  sources: ClientRoutingDefinition["sources"];
  states: Row[];
  error: string | null;
  reload: () => Promise<void>;
  syncingSource: string | null;
  syncSource: (sourceId: string, expectedSnapshotRevision: number) => Promise<void>;
  versionState:string;
  qualifications:Row[];
  integrations:RoutingIntegration[];
  qualifyingSource:string|null;
  qualifySource:(sourceId:string)=>Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const stateById = new Map(
    states.map((state) => [String(state.source_id), state]),
  );
  const qualificationById=new Map(qualifications.map(item=>[String(item.source_id),item]));
  const copyWebhook = async (sourceName: string, path: string) => {
    try {
      await navigator.clipboard.writeText(
        new URL(path, window.location.origin).toString(),
      );
      setCopyStatus(t("routing.notice.copied", { source: isolate(sourceName) }));
    } catch {
      setCopyStatus(
        t("routing.errors.copy"),
      );
    }
  };
  return (
    <section
      className="routing-section"
      aria-labelledby="routing-sources-title"
    >
      <div className="bot-section-head">
        <div>
          <h3 id="routing-sources-title">{t("routing.sources.title")}</h3>
          <p>{t("routing.sources.help")}</p>
        </div>
      </div>
      {error ? (
        <div className="routing-source-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="button secondary small"
            onClick={() => void reload()}
          >
            {t("routing.sources.reload")}
          </button>
        </div>
      ) : null}
      <p className="routing-editor-help" role="status" aria-live="polite">
        {copyStatus}
      </p>
      <ul className="routing-source-list">
        {sources.map((source) => {
          const state = stateById.get(source.id);
          const qualification=qualificationById.get(source.id);
          const integration=source.kind!=="MANUAL"?integrations.find(item=>item.provider===source.kind&&item.binding_reference===source.secretReference):undefined;
          const webhookPath =
            canWrite && typeof state?.webhook_path === "string"
              ? state.webhook_path
              : null;
          return (
            <li key={source.id}>
              <header>
                <span>
                  <b>{source.name}</b>
                  <small>
                    {source.kind === "HTTP_JSON"
                      ? t("routing.sources.kind.httpJson")
                      : sourceKindLabel(source.kind, t)}{" "}
                    · {syncLabel(source, locale, t)}
                  </small>
                </span>
                {state ? <State value={state.state} /> : null}
              </header>
              {source.kind === "MANUAL" ? (
                <p>{t("routing.sources.manualHelp")}</p>
              ) : (
                <dl>
                  <div>
                    <dt>{t("routing.sources.lastPull")}</dt>
                    <dd>{formatDateTime(state?.last_success_at, locale, t)}</dd>
                  </div>
                  <div>
                    <dt>{t("routing.sources.nextRepair")}</dt>
                    <dd>
                      {source.syncMode === "WEBHOOK"
                        ? t("routing.sources.webhookOnly")
                        : formatDateTime(state?.next_due_at, locale, t)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("routing.sources.importedVersion")}</dt>
                    <dd>
                      {state
                        ? t("routing.sources.revision", { revision: formatNumber(Number(state.snapshot_revision), locale) })
                        : t("automation.common.notAvailable")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("routing.sources.latestJob")}</dt>
                    <dd>
                      {state?.latest_job_state
                        ? t(Number(state.latest_job_attempts) === 1 ? "routing.sources.job.one" : "routing.sources.job", { state: statusLabel(state.latest_job_state, t), attempts: formatNumber(Number(state.latest_job_attempts), locale) })
                        : t("automation.common.notStarted")}
                    </dd>
                  </div>
                </dl>
              )}
              {versionState==="DRAFT"&&source.kind!=="MANUAL"?<div className="routing-source-qualification"><span><b>{t("routing.sources.qualification")}</b><small>{qualification?t("routing.sources.qualificationState",{state:statusLabel(qualification.state,t)}):t("routing.sources.qualificationNotRun")}</small></span>{canWrite?<button type="button" className="button secondary small" disabled={!integration||qualifyingSource!==null||["QUEUED","RUNNING"].includes(String(qualification?.state))} onClick={()=>void qualifySource(source.id)}>{t(qualifyingSource===source.id?"routing.sources.qualifying":"routing.sources.qualify")}</button>:null}</div>:null}
              {state?.safe_error || state?.latest_job_safe_error ? (
                <p className="routing-source-safe-error">
                  {t("routing.sources.syncFailed")}
                </p>
              ) : null}
              {webhookPath || (canWrite && state) ? (
                <div className="routing-source-actions wx-card-actions">
                  {webhookPath ? (
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => void copyWebhook(source.name, webhookPath)}
                    >
                      {t("routing.sources.copy")}
                    </button>
                  ) : null}
                  {canWrite && state ? (
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={syncingSource !== null || ["QUEUED", "RUNNING"].includes(String(state.latest_job_state))}
                      onClick={() => void syncSource(source.id, Number(state.snapshot_revision))}
                    >
                      {syncingSource === source.id
                        ? t("routing.sources.requesting")
                        : String(state.state) === "CONFLICT" || String(state.latest_job_state) === "FAILED_TERMINAL"
                          ? t("routing.sources.retry")
                          : t("routing.sources.syncNow")}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RoutingQueueWarnings({ definition, catalog }: { definition: ClientRoutingDefinition; catalog: RoutingCatalog }) {
  const { t } = useI18n();
  const warnings = clientRoutingQueueWarnings(definition, catalog.groups);
  if (!warnings.length) return null;
  return <div className="routing-editor-help" role="status">
    <p><b>{t("routing.availability.title")}</b></p>
    <ul>{warnings.map(queue => <li key={queue.id}>
      <bdi dir="auto">{queue.name ?? t("routing.availability.queue", { id: queue.id })}</bdi>
      {queue.reasons.map(reason => <span key={reason}>{" · "}{t(`routing.availability.${reason}`)}</span>)}
    </li>)}</ul>
    <p>{t("routing.availability.help")}</p>
  </div>;
}

function ClientTable({
  clients,
  sources,
  connections,
  catalog,
}: {
  clients: ClientRoutingDefinition["clients"];
  sources: ClientRoutingDefinition["sources"];
  connections: Row[];
  catalog: RoutingCatalog;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const sourceNames = new Map(sources.map(source => [source.id, source.name]));
  const connectionNames = new Map(connections.map(connection => [String(connection.id), String(connection.name)]));
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const visible = clients.filter((client) =>
    !normalizedQuery
      ? true
      : [
          client.id,
          client.name,
          client.zammadGroupId,
          client.ownerId,
          client.escalationGroupId,
          client.escalationOwnerId,
          ...client.matchers.flatMap((matcher) => [
            matcher.kind,
            matcher.value,
            matcher.namespace,
          ]),
        ].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase(locale)
            .includes(normalizedQuery),
        ),
  );
  return (
    <section
      className="routing-section"
      aria-labelledby="routing-clients-title"
    >
      <div className="bot-section-head">
        <div>
          <h3 id="routing-clients-title">{t("routing.clients.title")}</h3>
          <p>{t("routing.clients.help")}</p>
        </div>
      </div>
      {clients.length ? (
        <>
          <label className="routing-search" htmlFor="routing-client-search">
            {t("routing.clients.searchLabel")}
            <input
              id="routing-client-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("routing.clients.searchPlaceholder")}
            />
          </label>
          <WideTable label={t("routing.clients.tableLabel")}>
            <table className="routing-table">
              <thead>
                <tr>
                  <th>{t("routing.clients.client")}</th>
                  <th>{t("routing.clients.matches")}</th>
                  <th>{t("routing.clients.route")}</th>
                  <th>{t("routing.clients.escalation")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((client) => (
                  <tr key={client.id}>
                    <th scope="row">
                      <b>{client.name}</b>
                      <small>{t("routing.clients.ownedBy", { source: sourceNames.get(client.routeSourceId) ?? t("routing.clients.unknownSource") })}</small>
                    </th>
                    <td>
                      <ul>
                        {client.matchers.map((matcher, index) => (
                          <li key={`${matcher.kind}-${matcher.value}-${index}`}>
                            <span>{matcherKindLabel(matcher.kind, t)} · {sourceNames.get(matcher.sourceId) ?? t("routing.clients.unknownSource")}</span>
                            {matcher.kind === "WHATSAPP_GROUP" ? (
                              <small>{t("routing.clients.whatsappConnection", { connection: connectionNames.get(matcher.connectionId ?? "") ?? t("routing.clients.unknownConnection") })}</small>
                            ) : (
                              <code dir="ltr">{breakAtSeparators(`${matcher.namespace ? `${matcher.namespace}:` : ""}${matcher.value}`)}</code>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <b>{groupLabel(catalog, client.zammadGroupId, t)}</b>
                      <small>
                        {client.ownerId
                          ? ownerLabel(catalog, client.ownerId, t)
                          : t("routing.clients.automaticOwner")}
                      </small>
                    </td>
                    <td>
                      {client.escalationGroupId ? (
                        <>
                          <b>{groupLabel(catalog, client.escalationGroupId, t)}</b>
                          <small>
                            {client.escalationOwnerId
                              ? ownerLabel(catalog, client.escalationOwnerId, t)
                              : t("routing.clients.automaticOwner")}
                          </small>
                        </>
                      ) : (
                        <span className="muted">{t("routing.clients.notConfigured")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </WideTable>
          {!visible.length ? (
            <Empty
              title={t("routing.clients.noMatchTitle")}
              body={t("routing.clients.noMatchBody")}
            />
          ) : null}
        </>
      ) : (
        <Empty
          title={t("routing.clients.fallbackTitle")}
          body={t("routing.clients.fallbackBody")}
        />
      )}
    </section>
  );
}

function RoutingDraftEditor({
  value,
  connections,
  busy,
  externalConnectorsEnabled,
  setValue,
  cancel,
  save,
  catalog,
  catalogAvailable,
  integrations,
  error,
  supportOrigin,
}: {
  value: ClientRoutingDefinition;
  error: string | null;
  supportOrigin: SupportQueueOrigin;
  connections: Row[];
  busy: boolean;
  externalConnectorsEnabled: boolean;
  setValue: (value: ClientRoutingDefinition) => void;
  cancel: () => void;
  save: (event: React.FormEvent) => Promise<void>;
  catalog: RoutingCatalog;
  catalogAvailable: boolean;
  integrations: RoutingIntegration[];
}) {
  const { t } = useI18n();
  const canonicalRaw = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [rawDraft, setRawDraft] = useState(() => {
    const initial = JSON.stringify(value, null, 2);
    return { initial, text: initial, base: initial };
  });
  const [rawError, setRawError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = canonicalRaw !== rawDraft.initial || rawDraft.text !== rawDraft.base;
  const updateValue = (next: ClientRoutingDefinition) => {
    const nextRaw = JSON.stringify(next, null, 2);
    setRawDraft((current) => current.text === current.base
      ? { ...current, text: nextRaw, base: nextRaw }
      : current);
    setValue(next);
  };
  useEffect(() => {
    if (!dirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [dirty]);
  const replaceSource = (
    index: number,
    source: ClientRoutingDefinition["sources"][number],
  ) =>
    updateValue({
      ...value,
      sources: value.sources.map((item, itemIndex) =>
        itemIndex === index ? source : item,
      ),
    });
  const replaceClient = (
    index: number,
    client: ClientRoutingDefinition["clients"][number],
  ) =>
    updateValue({
      ...value,
      clients: value.clients.map((item, itemIndex) =>
        itemIndex === index ? client : item,
      ),
    });
  const applyRaw = () => {
    if (rawDraft.base !== canonicalRaw) {
      setRawError(t("routing.errors.rawConflict"));
      return;
    }
    try {
      const parsed = parseClientRouting(JSON.parse(rawDraft.text));
      const normalized = JSON.stringify(parsed, null, 2);
      setValue(parsed);
      setRawDraft((current) => ({ ...current, text: normalized, base: normalized }));
      setRawError(null);
    } catch {
      setRawError(t("routing.errors.raw"));
    }
  };
  const submit = (event: React.FormEvent) => {
    if (rawDraft.text !== rawDraft.base) {
      event.preventDefault();
      setRawError(t("routing.errors.rawUnapplied"));
      document.getElementById("routing-definition")?.focus({ preventScroll: true });
      document.getElementById("routing-definition")?.scrollIntoView({ block: "center" });
      return;
    }
    void save(event);
  };
  return (
    <form
      className="panel routing-editor"
      data-unsaved={dirty || undefined}
      onSubmit={submit}
    >
      <div className="panel-heading">
        <div>
          <h2 id="routing-editor-title" tabIndex={-1}>{t("routing.editor.title")}</h2>
          <p>
            {externalConnectorsEnabled
              ? t("routing.editor.helpExternal")
              : t("routing.editor.helpManual")}
          </p>
        </div>
      </div>
      {catalogAvailable ? <RoutingQueueWarnings definition={value} catalog={catalog} /> : null}
      <fieldset className="routing-editor-section">
        <legend>{t("routing.editor.versionFallback")}</legend>
        <div className="routing-editor-grid">
          <label>
            {t("routing.editor.versionName")}
            <input
              required
              maxLength={160}
              value={value.name}
              onChange={(event) =>
                updateValue({ ...value, name: event.target.value })
              }
            />
          </label>
          <label>
            {t("routing.editor.fallbackTeam")}
            <GroupSelect
              catalog={catalog}
              value={value.fallback.zammadGroupId}
              onChange={(zammadGroupId) =>
                updateValue({
                  ...value,
                  fallback: {
                    ...value.fallback,
                    zammadGroupId,
                    ownerId: catalog.owners.some(owner => owner.id === value.fallback.ownerId && owner.groupIds.includes(zammadGroupId)) ? value.fallback.ownerId : undefined,
                  },
                })
              }
            />
          </label>
          <label>
            {t("routing.editor.fallbackOwner")}
            <OwnerSelect
              catalog={catalog}
              groupId={value.fallback.zammadGroupId}
              value={value.fallback.ownerId ?? ""}
              onChange={(ownerId) =>
                updateValue({
                  ...value,
                  fallback: {
                    ...value.fallback,
                    ownerId: ownerId || undefined,
                  },
                })
              }
            />
          </label>
        </div>
      </fieldset>
      <fieldset className="routing-editor-section">
        <legend>{t("routing.editor.supportEntries")}</legend>
        <p className="routing-editor-help">{t("routing.editor.supportEntriesHelp")}</p>
        {supportOrigin ? <p className="routing-editor-help routing-support-origin">{t(supportOrigin === "active" ? "routing.editor.supportFromActive" : "routing.editor.supportSingle")}</p> : null}
        <div className="routing-editor-grid">
          {catalog.groups.filter(group => group.active && group.serviceIdentityCanCreate).map(group => (
            <label key={group.id}>
              <input type="checkbox" checked={value.supportGroupIds?.includes(group.id) ?? false}
                onChange={event => updateValue({ ...value, supportGroupIds: event.target.checked
                  ? [...(value.supportGroupIds ?? []), group.id]
                  : (value.supportGroupIds ?? []).filter(id => id !== group.id) })} />
              {group.name}
            </label>
          ))}
        </div>
        <p className="routing-editor-help">{t("routing.editor.targetAccessHelp")}</p>
      </fieldset>
      <fieldset className="routing-editor-section">
        <legend>{t("routing.editor.sources")}</legend>
        <p className="routing-editor-help">
          {t("routing.editor.sourcesHelp")}
        </p>
        <div className="routing-editor-stack">
          {value.sources.map((source, index) => {
            const referenced = value.clients.some((client) =>
              client.routeSourceId === source.id ||
              client.matchers.some((matcher) => matcher.sourceId === source.id),
            );
            return (
              <article
                className="routing-editor-card"
                key={`${source.id}-${index}`}
              >
                <div className="routing-editor-grid">
                  <label>
                    {t("routing.editor.displayName")}
                    <input
                      required
                      maxLength={160}
                      value={source.name}
                      onChange={(event) =>
                        replaceSource(index, {
                          ...source,
                          name: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    {t("routing.editor.connector")}
                    <select
                      value={source.kind}
                      onChange={(event) => {
                        const kind = event.target.value as typeof source.kind;
                        replaceSource(
                          index,
                          kind === "MANUAL"
                            ? {
                                id: source.id,
                                name: source.name,
                                kind,
                                syncMode: "MANUAL",
                                fieldMapping: source.fieldMapping,
                              }
                            : {
                                ...source,
                                kind,
                                syncMode:
                                  source.syncMode === "MANUAL"
                                    ? "SCHEDULED"
                                    : source.syncMode,
                                scheduleMinutes: source.syncMode === "MANUAL" ? 60 : source.scheduleMinutes,
                                secretReference:
                                  (kind===source.kind?source.secretReference:undefined) ?? integrations.find(integration => integration.provider === kind && integration.binding_reference)?.binding_reference ?? "",
                              },
                        );
                      }}
                    >
                      <option value="MANUAL">{t("routing.sources.kind.manual")}</option>
                      {externalConnectorsEnabled ? (
                        <>
                          <option value="NOTION">{t("routing.sources.kind.notion")}</option>
                          <option value="ZOHO">{t("routing.sources.kind.zoho")}</option>
                          <option value="HTTP_JSON">{t("routing.sources.kind.httpJson")}</option>
                        </>
                      ) : source.kind !== "MANUAL" ? (
                        <option value={source.kind} disabled>
                          {sourceKindLabel(source.kind, t)} · {t("automation.common.unavailable")}
                        </option>
                      ) : null}
                    </select>
                  </label>
                  <label>
                    {t("routing.editor.syncMode")}
                    <select
                      value={source.syncMode}
                      disabled={source.kind === "MANUAL"}
                      onChange={(event) => {
                        const syncMode = event.target
                          .value as typeof source.syncMode;
                        replaceSource(index, {
                          ...source,
                          syncMode,
                          scheduleMinutes:
                            syncMode === "SCHEDULED" || syncMode === "HYBRID"
                              ? (source.scheduleMinutes ?? 60)
                              : undefined,
                        });
                      }}
                    >
                      <option value="MANUAL">{t("routing.editor.syncManual")}</option>
                      <option value="WEBHOOK">{t("routing.editor.syncWebhook")}</option>
                      <option value="SCHEDULED">{t("routing.editor.syncScheduled")}</option>
                      <option value="HYBRID">{t("routing.editor.syncHybrid")}</option>
                    </select>
                  </label>
                  {source.kind !== "MANUAL" ? (
                    <label>
                      {source.kind==="NOTION"?t("routing.editor.connectedWorkspace"):t("routing.editor.connectedService")}
                      <select
                        required
                        value={source.secretReference ?? ""}
                        onChange={(event) =>
                          replaceSource(index, {
                            ...source,
                            secretReference: event.target.value,
                          })
                        }
                      >
                        <option value="">{t(source.kind==="NOTION"?"routing.editor.chooseWorkspace":"routing.editor.chooseService")}</option>
                        {source.secretReference && !integrations.some(integration => integration.binding_reference === source.secretReference) ? <option value={source.secretReference}>{t("routing.editor.previouslyConfiguredCredential")}</option> : null}
                        {integrations.filter(integration => integration.provider === source.kind && integration.binding_reference).map(integration => <option key={integration.id} value={integration.binding_reference!}>{integration.display_name}</option>)}
                      </select>
                      <small>{integrations.some(integration=>integration.provider===source.kind&&integration.binding_reference)?t("routing.editor.connectedServiceHelp"):t(source.kind==="NOTION"?"routing.editor.connectWorkspaceFirst":"routing.editor.connectServiceFirst")}</small>
                    </label>
                  ) : null}
                  {source.kind !== "MANUAL" ? (
                    <label>
                      {source.kind === "NOTION"
                        ? t("routing.editor.notionUrl")
                        : source.kind === "ZOHO"
                          ? t("routing.editor.zohoUrl")
                          : t("routing.editor.httpsEndpoint")}
                      <input
                        required
                        type="url"
                        pattern="https://.*"
                        placeholder={
                          source.kind === "NOTION"
                            ? "https://api.notion.com/v1/data_sources/.../query"
                            : source.kind === "ZOHO"
                              ? "https://www.zohoapis.com/crm/v8/Accounts"
                              : "https://crm.example.com/client-routing"
                        }
                        value={source.endpointUrl ?? ""}
                        onChange={(event) =>
                          replaceSource(index, {
                            ...source,
                            endpointUrl: event.target.value,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {source.syncMode === "SCHEDULED" ||
                  source.syncMode === "HYBRID" ? (
                    <label>
                      {t("routing.editor.refreshMinutes")}
                      <input
                        required
                        type="number"
                        min={5}
                        max={10080}
                        value={source.scheduleMinutes ?? 60}
                        onChange={(event) =>
                          replaceSource(index, {
                            ...source,
                            scheduleMinutes: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
                <details className="routing-raw">
                  <summary>{t("routing.editor.advancedSource")}</summary>
                  <div className="routing-editor-grid">
                    <label>{t("routing.editor.sourceId")}<input required pattern={"[a-z][a-z0-9_.\\-]{0,127}"} value={source.id} onChange={event=>replaceSource(index,{...source,id:event.target.value})}/></label>
                  </div>
                </details>
                <FieldMappings
                  value={source.fieldMapping}
                  setValue={(fieldMapping) =>
                    replaceSource(index, { ...source, fieldMapping })
                  }
                />
                <button
                  type="button"
                  className="button secondary small"
                  disabled={value.sources.length === 1 || referenced}
                  title={
                    referenced
                      ? t("routing.editor.moveSourceMatchers")
                      : undefined
                  }
                  onClick={() =>
                    updateValue({
                      ...value,
                      sources: value.sources.filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                    })
                  }
                >
                  {t("routing.editor.removeSource")}
                </button>
              </article>
            );
          })}
        </div>
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            const id = nextId(
              "source",
              value.sources.map((source) => source.id),
            );
            updateValue({
              ...value,
              sources: [
                ...value.sources,
                {
                  id,
                  name: t("routing.editor.newSource"),
                  kind: "MANUAL",
                  syncMode: "MANUAL",
                  fieldMapping: {},
                },
              ],
            });
          }}
        >
          {t("routing.editor.addSource")}
        </button>
      </fieldset>
      <fieldset className="routing-editor-section">
        <legend>{t("routing.editor.clients")}</legend>
        <div className="routing-editor-stack">
          {value.clients.map((client, clientIndex) => (
            <article
              className="routing-editor-card"
              key={`${client.id}-${clientIndex}`}
            >
              <div className="routing-editor-grid">
                <label>
                  {t("routing.editor.clientName")}
                  <input
                    required
                    maxLength={160}
                    value={client.name}
                    onChange={(event) =>
                      replaceClient(clientIndex, {
                        ...client,
                        name: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  {t("routing.editor.ownershipSource")}
                  <select
                    value={client.routeSourceId}
                    onChange={(event) =>
                      replaceClient(clientIndex, {
                        ...client,
                        routeSourceId: event.target.value,
                      })
                    }
                  >
                    {value.sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("routing.editor.supportTeam")}
                  <GroupSelect
                    catalog={catalog}
                    value={client.zammadGroupId}
                    onChange={(zammadGroupId) =>
                      replaceClient(clientIndex, {
                        ...client,
                        zammadGroupId,
                        ownerId: catalog.owners.some(owner => owner.id === client.ownerId && owner.groupIds.includes(zammadGroupId)) ? client.ownerId : undefined,
                      })
                    }
                  />
                </label>
                <label>
                  {t("routing.editor.supportOwner")}
                  <OwnerSelect
                    catalog={catalog}
                    groupId={client.zammadGroupId}
                    value={client.ownerId ?? ""}
                    onChange={(ownerId) =>
                      replaceClient(clientIndex, {
                        ...client,
                        ownerId: ownerId || undefined,
                      })
                    }
                  />
                </label>
                <label>
                  {t("routing.editor.escalationGroup")}
                  <GroupSelect
                    catalog={catalog}
                    optional
                    value={client.escalationGroupId ?? ""}
                    onChange={(escalationGroupId) =>
                      replaceClient(clientIndex, {
                        ...client,
                        escalationGroupId: escalationGroupId || undefined,
                        escalationOwnerId: catalog.owners.some(owner => owner.id === client.escalationOwnerId && owner.groupIds.includes(escalationGroupId)) ? client.escalationOwnerId : undefined,
                      })
                    }
                  />
                </label>
                <label>
                  {t("routing.editor.escalationOwner")}
                  <OwnerSelect
                    catalog={catalog}
                    groupId={client.escalationGroupId ?? ""}
                    value={client.escalationOwnerId ?? ""}
                    onChange={(escalationOwnerId) =>
                      replaceClient(clientIndex, {
                        ...client,
                        escalationOwnerId: escalationOwnerId || undefined,
                      })
                    }
                  />
                </label>
              </div>
              <details className="routing-raw">
                <summary>{t("routing.editor.advancedClient")}</summary>
                <label>
                  {t("routing.editor.clientId")}
                  <input
                    required
                    pattern={"[a-z][a-z0-9_.\\-]{0,127}"}
                    value={client.id}
                    onChange={(event) =>
                      replaceClient(clientIndex, {
                        ...client,
                        id: event.target.value,
                      })
                    }
                  />
                </label>
              </details>
              <fieldset className="routing-matchers">
                <legend>{t("routing.editor.matchValues")}</legend>
                {client.matchers.map((matcher, matcherIndex) => (
                  <div
                    className="routing-matcher-row"
                    key={`${matcher.kind}-${matcherIndex}`}
                  >
                    <label>
                      {t("routing.editor.type")}
                      <select
                        value={matcher.kind}
                        onChange={(event) => {
                          const kind = event.target
                            .value as typeof matcher.kind;
                          const next = {
                            kind,
                            value: matcher.value,
                            sourceId: matcher.sourceId,
                            ...(kind === "CLIENT_IDENTIFIER"
                              ? { namespace: matcher.namespace ?? "crm" }
                              : {}),
                            ...(kind === "WHATSAPP_GROUP"
                              ? {
                                  connectionId:
                                    matcher.connectionId ??
                                    String(connections[0]?.id ?? ""),
                                }
                              : {}),
                          };
                          replaceClient(clientIndex, {
                            ...client,
                            matchers: client.matchers.map((item, itemIndex) =>
                              itemIndex === matcherIndex ? next : item,
                            ),
                          });
                        }}
                      >
                        <option value="DOMAIN">{t("routing.editor.domain")}</option>
                        <option value="EMAIL">{t("routing.editor.email")}</option>
                        <option value="CLIENT_IDENTIFIER">
                          {t("routing.editor.identifier")}
                        </option>
                        <option value="WHATSAPP_GROUP">{t("routing.editor.whatsappGroup")}</option>
                      </select>
                    </label>
                    <label>
                      {t("routing.editor.value")}
                      <input
                        required
                        value={matcher.value}
                        onChange={(event) =>
                          replaceClient(clientIndex, {
                            ...client,
                            matchers: client.matchers.map((item, itemIndex) =>
                              itemIndex === matcherIndex
                                ? { ...matcher, value: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      {t("routing.editor.source")}
                      <select
                        value={matcher.sourceId}
                        onChange={(event) =>
                          replaceClient(clientIndex, {
                            ...client,
                            matchers: client.matchers.map((item, itemIndex) =>
                              itemIndex === matcherIndex
                                ? { ...matcher, sourceId: event.target.value }
                                : item,
                            ),
                          })
                        }
                      >
                        {value.sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {matcher.kind === "CLIENT_IDENTIFIER" ? (
                      <label>
                        {t("routing.editor.namespace")}
                        <input
                          required
                          value={matcher.namespace ?? ""}
                          onChange={(event) =>
                            replaceClient(clientIndex, {
                              ...client,
                              matchers: client.matchers.map(
                                (item, itemIndex) =>
                                  itemIndex === matcherIndex
                                    ? {
                                        ...matcher,
                                        namespace: event.target.value,
                                      }
                                    : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                    {matcher.kind === "WHATSAPP_GROUP" ? (
                      <label>
                        {t("routing.editor.connection")}
                        <select
                          required
                          value={matcher.connectionId ?? ""}
                          onChange={(event) =>
                            replaceClient(clientIndex, {
                              ...client,
                              matchers: client.matchers.map(
                                (item, itemIndex) =>
                                  itemIndex === matcherIndex
                                    ? {
                                        ...matcher,
                                        connectionId: event.target.value,
                                      }
                                    : item,
                              ),
                            })
                          }
                        >
                          <option value="">{t("routing.editor.chooseConnection")}</option>
                          {connections.map((connection) => (
                            <option
                              key={String(connection.id)}
                              value={String(connection.id)}
                            >
                              {String(connection.name)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={client.matchers.length === 1}
                      onClick={() =>
                        replaceClient(clientIndex, {
                          ...client,
                          matchers: client.matchers.filter(
                            (_, itemIndex) => itemIndex !== matcherIndex,
                          ),
                        })
                      }
                    >
                      {t("routing.editor.removeMatch")}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() =>
                    replaceClient(clientIndex, {
                      ...client,
                      matchers: [
                        ...client.matchers,
                        {
                          kind: "DOMAIN",
                          value: "client.example",
                          sourceId: value.sources[0]!.id,
                        },
                      ],
                    })
                  }
                >
                  {t("routing.editor.addMatch")}
                </button>
              </fieldset>
              <button
                type="button"
                className="button secondary small"
                onClick={() =>
                  updateValue({
                    ...value,
                    clients: value.clients.filter(
                      (_, itemIndex) => itemIndex !== clientIndex,
                    ),
                  })
                }
              >
                {t("routing.editor.removeClient")}
              </button>
            </article>
          ))}
        </div>
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            const id = nextId(
              "client",
              value.clients.map((client) => client.id),
            );
            updateValue({
              ...value,
              clients: [
                ...value.clients,
                {
                  id,
                  name: t("routing.editor.newClient"),
                  routeSourceId: value.sources[0]!.id,
                  zammadGroupId: value.fallback.zammadGroupId,
                  matchers: [
                    {
                      kind: "DOMAIN",
                      value: "client.example",
                      sourceId: value.sources[0]!.id,
                    },
                  ],
                },
              ],
            });
          }}
        >
          {t("routing.editor.addClient")}
        </button>
      </fieldset>
      <details className="routing-raw routing-raw-editor">
        <summary>{t("routing.editor.rawTitle")}</summary>
        <p>
          {t("routing.editor.rawHelp")}
        </p>
        <label htmlFor="routing-definition">{t("routing.editor.rawLabel")}</label>
        <textarea
          id="routing-definition"
          spellCheck={false}
          value={rawDraft.text}
          onChange={(event) => {
            setRawDraft((current) => ({ ...current, text: event.target.value }));
            setRawError(null);
          }}
          aria-invalid={Boolean(rawError)}
          aria-errormessage={rawError ? "routing-definition-error" : undefined}
        />
        {rawError ? <p id="routing-definition-error" className="bot-inline-error" role="alert">{rawError}</p> : null}
        <div className="bot-form-actions">
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setRawDraft((current) => ({ ...current, text: canonicalRaw, base: canonicalRaw }));
              setRawError(null);
            }}
          >
            {t("routing.editor.loadFields")}
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={applyRaw}
          >
            {t("routing.editor.applyJson")}
          </button>
        </div>
      </details>
      {error ? <p className="bot-inline-error" role="alert">{error}</p> : null}
      <div className="bot-form-actions">
        <button type="button" className="button secondary" onClick={() => dirty ? setConfirmDiscard(true) : cancel()}>
          {t("automation.common.cancel")}
        </button>
        <button className="button primary" disabled={busy}>
          {t(busy ? "routing.editor.validating" : "routing.editor.create")}
        </button>
      </div>
      {confirmDiscard ? <ModalDialog close={() => setConfirmDiscard(false)} className="modal-backdrop" aria-labelledby="routing-discard-title">
        <div className="modal bot-confirm">
          <div>
            <h2 id="routing-discard-title">{t("routing.editor.discardTitle")}</h2>
            <p>{t("routing.editor.discardHelp")}</p>
          </div>
          <span>
            <button data-modal-initial-focus type="button" className="button secondary" onClick={() => setConfirmDiscard(false)}>{t("routing.editor.keepEditing")}</button>
            <button type="button" className="button primary" onClick={cancel}>{t("routing.editor.discard")}</button>
          </span>
        </div>
      </ModalDialog> : null}
    </form>
  );
}

function FieldMappings({
  value,
  setValue,
}: {
  value: Record<string, string>;
  setValue: (value: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const entries = Object.entries(value);
  return (
    <fieldset className="routing-field-mapping">
      <legend>{t("routing.fields.title")}</legend>
      {entries.map(([key, mapped], index) => (
        <div key={`${key}-${index}`}>
          <label>
            {t("routing.fields.wasalx")}
            <input
              required
              pattern={"[a-z][a-z0-9_.\\-]{0,127}"}
              value={key}
              onChange={(event) => {
                const nextKey = event.currentTarget.value;
                if (nextKey !== key && Object.hasOwn(value, nextKey)) {
                  event.currentTarget.setCustomValidity(
                    t("routing.fields.unique"),
                  );
                  event.currentTarget.reportValidity();
                  return;
                }
                event.currentTarget.setCustomValidity("");
                setValue(
                  Object.fromEntries(
                    entries.map(([entryKey, entryValue], entryIndex) => [
                      entryIndex === index ? nextKey : entryKey,
                      entryValue,
                    ]),
                  ),
                );
              }}
            />
          </label>
          <label>
            {t("routing.fields.connector")}
            <input
              required
              maxLength={160}
              value={mapped}
              onChange={(event) =>
                setValue({ ...value, [key]: event.target.value })
              }
            />
          </label>
          <button
            type="button"
            className="button secondary small"
            onClick={() =>
              setValue(
                Object.fromEntries(
                  entries.filter((_, itemIndex) => itemIndex !== index),
                ),
              )
            }
          >
            {t("routing.fields.remove")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary small"
        onClick={() =>
          setValue({
            ...value,
            [nextId("field", Object.keys(value))]: "source_field",
          })
        }
      >
        {t("routing.fields.add")}
      </button>
    </fieldset>
  );
}

function GroupSelect({catalog,value,onChange,optional=false}:{catalog:RoutingCatalog;value:string;onChange:(value:string)=>void;optional?:boolean}){
  const {t}=useI18n();const groups=catalog.groups.filter(group=>group.active&&group.serviceIdentityCanCreate);const known=groups.some(group=>group.id===value);
  return <select required={!optional} value={value} onChange={event=>onChange(event.target.value)}>
    {optional?<option value="">{t("routing.editor.noEscalationTeam")}</option>:null}
    {!known&&value?<option value={value}>{t("routing.editor.unavailableTeam")}</option>:null}
    {!groups.length&&!value?<option value="">{t("routing.editor.noAvailableTeams")}</option>:null}
    {groups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}
  </select>;
}

function OwnerSelect({catalog,groupId,value,onChange}:{catalog:RoutingCatalog;groupId:string;value:string;onChange:(value:string)=>void}){
  const {t}=useI18n();const owners=catalog.owners.filter(owner=>owner.active&&owner.groupIds.includes(groupId));const known=owners.some(owner=>owner.id===value);
  return <select value={value} disabled={!groupId} onChange={event=>onChange(event.target.value)}>
    <option value="">{t("routing.editor.automaticOwner")}</option>
    {!known&&value?<option value={value}>{t("routing.editor.unavailableOwner")}</option>:null}
    {owners.map(owner=><option key={owner.id} value={owner.id}>{owner.name}</option>)}
  </select>;
}

function nextId(prefix: string, values: string[]) {
  const used = new Set(values);
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function RoutingSimulator({
  versionId,
  connections,
  clients,
  catalog,
  mutationHeaders,
}: {
  versionId: string;
  connections: Row[];
  clients: ClientRoutingDefinition["clients"];
  catalog: RoutingCatalog;
  mutationHeaders: Record<string, string>;
}) {
  const { locale, t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const requestFence = useRef(createLatestRequestFence());
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  const simulate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const request = requestFence.current.begin();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = new FormData(event.currentTarget);
      const match = Object.fromEntries(
        [...data.entries()]
          .filter(([, value]) => String(value).trim())
          .map(([key, value]) => [key, String(value).trim()]),
      );
      const response = await fetch("/api/client-routing/simulate", {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ versionId, match }),
        signal: controller.signal,
      });
      if (!response.ok) throw await operatorResponseFailure(response, t("automation.common.requestFailed", { status: response.status }));
      const value = (await response.json()) as Row;
      if (requestFence.current.isCurrent(request)) setResult(value);
    } catch (problem) {
      if (requestFence.current.isCurrent(request) && !isAbortError(problem)) {
        setError(message(problem, t("routing.errors.simulate"), locale));
      }
    } finally {
      if (requestFence.current.isCurrent(request)) {
        activeRequest.current = null;
        setBusy(false);
      }
    }
  };
  const invalidateSimulation = () => {
    requestFence.current.invalidate();
    activeRequest.current?.abort();
    activeRequest.current = null;
    setBusy(false);
    setResult(null);
  };
  return (
    <form
      className="routing-section routing-simulator"
      onSubmit={(event) => void simulate(event)}
      onChange={invalidateSimulation}
    >
      <div className="bot-section-head">
        <div>
          <h3>{t("routing.simulator.title")}</h3>
          <p>{t("routing.simulator.help")}</p>
        </div>
        <button type="submit" className="button primary small" disabled={busy}>
          {t(busy ? "routing.simulator.testing" : "routing.simulator.test")}
        </button>
      </div>
      <div className="routing-simulator-fields">
        <label>
          {t("routing.simulator.entryGroup")}
          <select name="entryGroupId" defaultValue="" required>
            <option value="">{t("routing.simulator.notSpecified")}</option>
            {catalog.groups.filter(group => group.active).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label>
          {t("routing.simulator.email")}
          <input
            name="email"
            type="email"
            autoComplete="off"
            placeholder={t("routing.simulator.emailExample")}
          />
        </label>
        <label>
          {t("routing.simulator.identifier")}
          <input name="identifier" autoComplete="off" placeholder={t("routing.simulator.identifierExample")} />
        </label>
        <label>
          {t("routing.simulator.namespace")}
          <input
            name="identifierNamespace"
            autoComplete="off"
            placeholder={t("routing.simulator.namespaceExample")}
          />
        </label>
        <label>
          {t("routing.simulator.group")}
          <input
            name="whatsappGroupId"
            autoComplete="off"
            placeholder={t("routing.simulator.groupExample")}
            dir="ltr"
          />
        </label>
        <label>
          {t("routing.simulator.connection")}
          <select name="connectionId" defaultValue="">
            <option value="">{t("routing.simulator.notSpecified")}</option>
            {connections
              .filter((connection) =>
                /^[0-9a-f-]{36}$/iu.test(String(connection.id)),
              )
              .map((connection) => (
                <option
                  key={String(connection.id)}
                  value={String(connection.id)}
                >
                  {String(connection.name)}
                </option>
              ))}
          </select>
        </label>
      </div>
      {error ? <p className="bot-inline-error" role="alert">{error}</p> : null}
      {result ? (
        <div
          className={`routing-result ${result.status === "CONFLICT" ? "conflict" : ""}`}
          role="status"
        >
          <b>
            {result.status === "MATCHED"
              ? t("routing.simulator.matched", { client: String((result.client as Row)?.name) })
              : result.status === "CONFLICT"
                ? t("routing.simulator.conflict")
                : result.status === "DEPARTMENT" ? t("routing.simulator.department") : t("routing.simulator.fallback")}
          </b>
          <span>
            {result.status === "MATCHED"
              ? t("routing.simulator.matchedBy", { matcher: matcherKindLabel(String(result.matchedBy), t) })
              : result.status === "FALLBACK"
                ? t("routing.simulator.noWinner")
                : result.status === "DEPARTMENT" ? t("routing.simulator.departmentBody")
                : t("routing.simulator.reviewNames", { clients: (result.competingClientIds as string[]).map(id => clients.find(client => client.id === id)?.name ?? t("routing.clients.unknownClient")).join(", ") })}
          </span>
        </div>
      ) : null}
    </form>
  );
}

function syncLabel(source: ClientRoutingDefinition["sources"][number], locale: "en" | "ar", t: ReturnType<typeof useI18n>["t"]) {
  if (source.syncMode === "MANUAL") return t("routing.sources.sync.manual");
  if (source.syncMode === "WEBHOOK") return t("routing.sources.sync.webhook");
  const interval = t("routing.sources.sync.interval", { minutes: formatNumber(Number(source.scheduleMinutes), locale) });
  return source.syncMode === "HYBRID" ? t("routing.sources.sync.hybrid", { interval }) : interval;
}
function sourceKindLabel(kind: ClientRoutingDefinition["sources"][number]["kind"], t: ReturnType<typeof useI18n>["t"]){if(kind==="NOTION")return t("routing.sources.kind.notion");if(kind==="ZOHO")return t("routing.sources.kind.zoho");if(kind==="HTTP_JSON")return t("routing.sources.kind.httpJson");return t("routing.sources.kind.manual")}
function matcherKindLabel(value: string, t: ReturnType<typeof useI18n>["t"]) {
  const key = ({ DOMAIN: "routing.editor.domain", EMAIL: "routing.editor.email", CLIENT_IDENTIFIER: "routing.editor.identifier", WHATSAPP_GROUP: "routing.editor.whatsappGroup" } as Record<string, string>)[value.toUpperCase()];
  return key ? t(key) : t("routing.clients.unknownMatcher");
}
// Long identifiers wrap after @ . : / _ - rather than mid-word.
function breakAtSeparators(value: string) {
  return value.split(/(?<=[@.:/_-])/u).map((part, index) => <Fragment key={index}>{index ? <wbr /> : null}{part}</Fragment>);
}
function groupLabel(catalog:RoutingCatalog,id:string,t:ReturnType<typeof useI18n>["t"]){return catalog.groups.find(group=>group.id===id)?.name??t("routing.clients.unavailableTeam")}
function ownerLabel(catalog:RoutingCatalog,id:string,t:ReturnType<typeof useI18n>["t"]){return catalog.owners.find(owner=>owner.id===id)?.name??t("routing.clients.unavailableOwner")}
function formatTime(value: unknown, locale: "en" | "ar", t: ReturnType<typeof useI18n>["t"]) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime())
    ? t("automation.common.notRecorded")
    : formatLocalizedDateTime(date, locale, { dateStyle: "medium" });
}
function formatDateTime(value: unknown, locale: "en" | "ar", t: ReturnType<typeof useI18n>["t"]) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime())
    ? t("automation.common.notRecorded")
    : formatLocalizedDateTime(date, locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
function message(problem: unknown, fallback: string, locale: "en" | "ar") {
  const code = normalizeUiErrorCode(problem);
  return code === "UNKNOWN" ? fallback : localizedUiError(locale, { code }).message;
}
function State({ value }: { value: unknown }) {
  const { t } = useI18n();
  const normalized = String(value).toLowerCase();
  const tone = ["active", "connected"].includes(normalized)
    ? "success"
    : ["draft", "connecting"].includes(normalized)
      ? "warning"
      : normalized.includes("fail") || ["conflict", "revoked"].includes(normalized)
        ? "danger"
        : "neutral";
  return (
    <span className={`status status-${tone}`}>
      <i />
      {statusLabel(value, t)}
    </span>
  );
}
function statusLabel(value: unknown, t: ReturnType<typeof useI18n>["t"]) {
  const normalized = String(value).toLowerCase();
  const key = ({ active: "automation.status.active", inactive: "common.status.inactive", connected: "common.status.connected", connecting: "tenant.status.connecting", disconnected: "common.status.disconnected", revoked: "tenant.status.revoked", pending: "common.status.pending", draft: "automation.status.draft", paused: "automation.status.paused", retired: "automation.status.retired", failed: "automation.status.failed", failed_terminal: "automation.status.failedTerminal", failed_retryable: "automation.status.failedRetryable", conflict: "automation.status.conflict", valid: "automation.status.valid", needs_attention: "automation.status.needsAttention", succeeded: "automation.status.succeeded", queued: "automation.status.queued", ready: "automation.status.ready", running: "automation.status.running", error: "automation.status.error", degraded: "automation.status.degraded", waiting: "automation.status.waiting" } as Record<string, string>)[normalized];
  return key ? t(key) : t("tenant.status.unknown");
}
function isolate(value: string) { return `\u2068${value}\u2069`; }
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
async function routingData(requestError: (status: number) => string, cursor?: string, signal?: AbortSignal) {
  const query = cursor ? `?limit=25&cursor=${encodeURIComponent(cursor)}` : "?limit=25";
  const response = await fetch(`/api/client-routing/catalog${query}`, { cache: "no-store", signal });
  if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
  return (await response.json()) as CatalogPage;
}

function appendCatalogRows(current: Row[], incoming: Row[], key: string) {
  const rows = new Map(current.map((row) => [String(row[key]), row]));
  for (const row of incoming) rows.set(String(row[key]), row);
  return [...rows.values()];
}
function refreshCatalogRows(current: Row[], incoming: Row[], extended: boolean, key: string) {
  if (!extended) return incoming.map((row) => { const existing=current.find((item)=>String(item[key])===String(row[key]));return existing?.definition===undefined?row:{...row,definition:existing.definition}; });
  const refreshed=new Map(incoming.map((row)=>[String(row[key]),row]));
  return current.map((row)=>{const replacement=refreshed.get(String(row[key]));if(!replacement)return row;refreshed.delete(String(row[key]));return row.definition===undefined?replacement:{...replacement,definition:row.definition}}).concat([...refreshed.values()]);
}
function mergeCatalogDetail(current: Row[], detail: Row, key: string) { return current.map((row)=>String(row[key])===String(detail[key])?{...row,...detail}:row); }
async function routingCapabilitiesData(requestError: (status: number) => string, signal?: AbortSignal) {
  const response = await fetch("/api/client-routing/capabilities", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
  const value = (await response.json()) as {
    externalConnectorsEnabled?: unknown;
    notionOAuthEnabled?: unknown;
  };
  return { externalConnectorsEnabled: value.externalConnectorsEnabled === true,notionOAuthEnabled:value.notionOAuthEnabled===true };
}
async function routingSourceData(requestError: (status: number) => string, signal?: AbortSignal) {
  const response = await fetch("/api/client-routing/sources", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
  return (await response.json()) as Row[];
}
async function routingCatalogData(requestError:(status:number)=>string,signal?:AbortSignal){const response=await fetch("/api/zammad/routing-catalogs",{cache:"no-store",signal});if(!response.ok)throw await operatorResponseFailure(response,requestError(response.status));const value=await response.json() as Partial<RoutingCatalog>;return{groups:Array.isArray(value.groups)?value.groups:[],owners:Array.isArray(value.owners)?value.owners:[]}}
async function routingIntegrationData(requestError:(status:number)=>string,signal?:AbortSignal){const response=await fetch("/api/client-routing/integrations",{cache:"no-store",signal});if(!response.ok)throw await operatorResponseFailure(response,requestError(response.status));return await response.json() as RoutingIntegration[]}
function operatorError(problem: unknown, fallback: string, locale: "en" | "ar"): OperatorError {
  const code = normalizeUiErrorCode(problem);
  return { message: message(problem, fallback, locale), code: code === "UNKNOWN" ? null : code };
}
function isAbortError(problem: unknown) {
  return problem instanceof DOMException && problem.name === "AbortError";
}
