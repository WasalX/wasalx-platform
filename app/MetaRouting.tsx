"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MetaRoutingAction, MetaRoutingConfigurationDto, MetaRoutingRole, MetaThreadActionDto, MetaThreadControlCommand, MetaThreadRoutingDto } from "../lib/meta-routing-contract";
import { metaThreadActionMatches, metaThreadIntentSettled, parseMetaThreadIntent, type MetaThreadIntent } from "../lib/meta-thread-intent";
import { formatDateTime, formatList } from "../lib/i18n/format";
import { localizedUiError } from "../lib/ui-error";
import { createLatestRequestFence } from "../lib/operator-ui";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import { useI18n } from "./I18nProvider";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./MetaRouting.module.css";

async function request<T>(url: string, headers: Record<string, string>, body?: unknown, key?: string, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(20_000);
  const response = await fetch(url, { cache: "no-store", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    ...(body === undefined && key ? { headers: { "idempotency-key": key } } : {}),
    ...(body === undefined ? {} : { method: "POST", headers: { ...headers, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[A-Z_]{1,80}$/u.test(value.code) ? value.code : undefined;
    throw Object.assign(new Error("META_ROUTING_REQUEST_FAILED"), { status: response.status, code });
  }
  return response.json() as Promise<T>;
}

type ConnectionProps = { connectionId: string; canConfigure: boolean; mutationHeaders: Record<string, string> };
export function MetaRoutingConfiguration(props: ConnectionProps) {
  return <ConnectionRouting key={`${props.connectionId}:${props.mutationHeaders["x-wasalx-csrf"] ?? ""}`} {...props} />;
}
function ConnectionRouting({ connectionId, canConfigure, mutationHeaders }: ConnectionProps) {
  const { t, locale } = useI18n();
  const url = `/api/connections/${encodeURIComponent(connectionId)}/meta/routing`;
  const [data, setData] = useState<MetaRoutingConfigurationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false);
  const writing = useRef(false), loadFence = useRef(createLatestRequestFence());
  const intent = useRef<{ key: string; expectedVersion: number; expectedSessionId: string } | null>(null);
  async function read(signal?: AbortSignal) {
    if (writing.current) return;
    const version = loadFence.current.begin();
    const isCurrent = () => !signal?.aborted && loadFence.current.isCurrent(version);
    try {
      const result = await request<MetaRoutingConfigurationDto>(url, mutationHeaders, undefined, undefined, signal);
      if (!isCurrent()) return;
      setData(result); setError(null);
      // A newly observed declaration prevents another submission. No request is replayed.
      if (result.declared && (!intent.current || result.configurationVersion > intent.current.expectedVersion)) setUncertain(false);
    } catch (failure) {
      if (isCurrent()) {
        // Keep the last known configuration through a transient background failure; drop it only when access is denied.
        const status = failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : 0;
        if (!signal || status === 401 || status === 403) setData(null);
        setError(localizedUiError(locale, failure).message);
      }
    } finally { if (isCurrent()) setLoading(false); }
  }
  // The key owns connection and authentication context, so the first read runs once per lifetime.
  const readOnMount = useEffectEvent(read);
  useEffect(() => {
    const controller = new AbortController(), fence = loadFence.current;
    queueMicrotask(() => { if (!controller.signal.aborted) void readOnMount(controller.signal); });
    return () => { fence.invalidate(); controller.abort(); };
  }, []);
  useVisibleRefresh(read, !saving);
  async function declare() {
    if (!data || data.declared || !canConfigure || writing.current || uncertain || loading) return;
    writing.current = true; const version = loadFence.current.begin(), isCurrent = () => loadFence.current.isCurrent(version);
    setSaving(true); setError(null);
    intent.current ??= { key: crypto.randomUUID(), expectedVersion: data.configurationVersion, expectedSessionId: data.sessionId };
    try {
      const { key, ...expected } = intent.current;
      const result = await request<MetaRoutingConfigurationDto>(url, mutationHeaders, { ...expected, fallback: "HOLD" }, key);
      if (isCurrent()) { setData(result); setUncertain(false); }
    } catch (failure) { if (isCurrent()) {
      setError(localizedUiError(locale, failure).message);
      const status = failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : 0;
      // Only a lost response or server failure leaves the outcome unknown; a definite rejection releases the form with a fresh request.
      if (status >= 400 && status < 500 && status !== 408) intent.current = null; else setUncertain(true);
      if (status === 401 || status === 403) setData(null);
    } }
    finally { if (isCurrent()) { writing.current = false; setSaving(false); } }
  }
  return <section className={`connection-detail-section ${styles.section}`} aria-labelledby="meta-routing-title" aria-busy={loading || saving}>
    <div className="connection-detail-section-head"><div><h3 id="meta-routing-title">{t("tenant.metaRouting.title")}</h3><p>{t("tenant.metaRouting.intro")}</p></div></div>
    {error ? <p role="alert">{error}</p> : null}
    {loading ? <p role="status">{t("tenant.metaRouting.loading")}</p> : null}
    {uncertain ? <p role="status">{t("tenant.metaRouting.declarationUnknown")}</p> : null}
    {data ? <>
      <p>{t(`tenant.metaRouting.readiness.${data.readiness}`)}</p>
      <p>{t(data.declared ? "tenant.metaRouting.declared" : "tenant.metaRouting.notDeclared")}</p>
      <p>{t("tenant.metaRouting.hold")}</p>
      {data.observed ? <dl className={styles.facts}>
        <div><dt>{t("tenant.metaRouting.review")}</dt><dd>{t(data.observed.disposition === "REVOKED" ? "tenant.metaRouting.revoked" : data.observed.current ? "tenant.metaRouting.current" : "tenant.metaRouting.superseded")}</dd></div>
        <div><dt>{t("tenant.metaRouting.observedAt")}</dt><dd>{Number.isFinite(Date.parse(data.observed.observedAt)) ? formatDateTime(data.observed.observedAt, locale) : t("tenant.metaRouting.none")}</dd></div>
        <div><dt>{t("tenant.metaRouting.provenance")}</dt><dd>{t(`tenant.metaRouting.mode.${data.observed.mode}`)}</dd></div>
        <div><dt>{t("tenant.metaRouting.roles")}</dt><dd>{data.observed.roles.length ? formatList(data.observed.roles.map(role => t(`tenant.metaRouting.role.${role}`)), locale) : t("tenant.metaRouting.none")}</dd></div>
      </dl> : <p>{t("tenant.metaRouting.noReview")}</p>}
      <p>{t("tenant.metaRouting.proofBoundary")}</p>
      {!data.declared && canConfigure ? <button className="button secondary" type="button" disabled={loading || saving || uncertain} onClick={() => void declare()}>{t("tenant.metaRouting.declare")}</button> : null}
    </> : null}
    <div className={styles.actions}><button className="button secondary" type="button" disabled={loading || saving} onClick={() => { setLoading(true); void read(); }}>{t("tenant.metaRouting.refresh")}</button></div>
  </section>;
}

type ThreadProps = { conversationId: string; connectionId: string; workspaceId: string; label: string; mutationHeaders: Record<string, string> };
export function MetaThreadControl(props: ThreadProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return <><button className="button secondary small" type="button" onClick={() => setOpen(true)}>{t("tenant.metaRouting.inspect")}</button>
    {open ? <ThreadSession key={`${props.workspaceId}:${props.conversationId}:${props.connectionId}:${props.mutationHeaders["x-wasalx-csrf"] ?? ""}`} {...props} close={() => setOpen(false)} /> : null}</>;
}
function ThreadSession({ conversationId, connectionId, workspaceId, label, mutationHeaders, close }: ThreadProps & { close: () => void }) {
  const { t, locale } = useI18n();
  const url = `/api/bot-flows/conversations/${encodeURIComponent(conversationId)}/meta-thread-control`;
  const storageKey = `wasalx.meta.thread-hold:${workspaceId}:${conversationId}`;
  const [data, setData] = useState<MetaThreadRoutingDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [held, setHeld] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [action, setAction] = useState<MetaRoutingAction | null>(null), [target, setTarget] = useState<MetaRoutingRole | "">("");
  const writing = useRef(false), loadFence = useRef(createLatestRequestFence());
  const intent = useRef<MetaThreadIntent | null>(null);
  async function read(signal?: AbortSignal) {
    if (writing.current) return;
    const version = loadFence.current.begin();
    const isCurrent = () => !signal?.aborted && loadFence.current.isCurrent(version);
    try {
      const result = await request<MetaThreadRoutingDto>(url, mutationHeaders, undefined, intent.current?.key, signal);
      if (result.connectionId !== connectionId) throw new Error("META_ROUTING_SCOPE_CHANGED");
      if (isCurrent()) {
        setData(result); setError(null); setAction(null);
        if (intent.current && metaThreadIntentSettled(intent.current, result.correlation)) {
          try { window.sessionStorage.removeItem(storageKey); intent.current = null; setHeld(false); }
          catch { setStorageUnavailable(true); }
        }
      }
    } catch (failure) { if (isCurrent()) { setData(null); setError(localizedUiError(locale, failure).message); } }
    finally { if (isCurrent()) setLoading(false); }
  }
  // The keyed dialog owns this workspace, conversation and authentication context, so recovery runs once per lifetime.
  const restoreAndRead = useEffectEvent((signal: AbortSignal) => {
    // The hold contains only a local action key/body. Never credentials or provider identifiers.
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      intent.current = saved === null ? null : parseMetaThreadIntent(saved);
      setHeld(saved !== null); // Malformed recovery also stays held; never manufacture a fresh key.
    }
    catch { setStorageUnavailable(true); }
    void read(signal);
  });
  useEffect(() => {
    const controller = new AbortController(), fence = loadFence.current;
    Promise.resolve().then(() => { if (!controller.signal.aborted) restoreAndRead(controller.signal); });
    return () => { fence.invalidate(); controller.abort(); };
  }, []);
  useVisibleRefresh(read, !saving && action === null);
  const serverHeld = data?.actions.some(item => item.state === "RUNNING" || item.state === "OUTCOME_UNKNOWN") ?? false;
  const unavailable = loading || saving || held || storageUnavailable || serverHeld || data?.ownership.epoch == null;
  const actionAvailable = action && data?.availability.actions.includes(action)
    && (action !== "pass" || (target ? data.availability.passTargets.includes(target) : data.availability.untargetedPass));
  async function execute() {
    if (!data || !action || !actionAvailable || unavailable || writing.current || data.ownership.epoch === null) return;
    const body: MetaThreadControlCommand = { action, ...(action === "pass" && target ? { targetRole: target } : {}),
      expectedRoutingEpoch: data.ownership.epoch, expectedConfigurationVersion: data.ownership.configurationVersion, expectedReviewVersion: data.ownership.reviewVersion };
    const value = { key: crypto.randomUUID(), body };
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { setStorageUnavailable(true); return; } // Dispatch requires a durable local ambiguity fence.
    intent.current = value; writing.current = true; const version = loadFence.current.begin(), isCurrent = () => loadFence.current.isCurrent(version);
    setSaving(true); setHeld(true); setError(null);
    try {
      const result = await request<MetaThreadActionDto>(url, mutationHeaders, value.body, value.key);
      if (!isCurrent()) return;
      if (!metaThreadActionMatches(body, result)) throw new Error("META_ROUTING_RESPONSE_UNAVAILABLE");
      setData(previous => previous ? { ...previous, actions: [result, ...previous.actions.filter(item => item.id !== result.id)], availability: { ...previous.availability, actions: [] } } : previous);
      if (result.state === "SUCCEEDED" || result.state === "FAILED") {
        try { window.sessionStorage.removeItem(storageKey); intent.current = null; setHeld(false); }
        catch { setStorageUnavailable(true); }
      }
      setAction(null);
    } catch (failure) { if (isCurrent()) {
      setError(localizedUiError(locale, failure).message); setHeld(true); setAction(null);
      if (failure && typeof failure === "object" && "status" in failure && (failure.status === 401 || failure.status === 403)) setData(null);
    } }
    finally { if (isCurrent()) { writing.current = false; setSaving(false); } }
  }
  return <ModalDialog close={saving ? () => {} : close} className="modal-backdrop" aria-labelledby="meta-thread-title"><div className={`modal ${styles.section}`}>
    <div className="modal-head"><div><h2 id="meta-thread-title">{t("tenant.metaRouting.threadTitle")}</h2><p><bdi>{label}</bdi></p></div><button type="button" disabled={saving} aria-label={t("tenant.metaRouting.close")} onClick={close}>×</button></div>
    <p>{t("tenant.metaRouting.noninterference")}</p>
    {error ? <p role="alert">{error}</p> : null}
    {loading ? <p role="status">{t("tenant.metaRouting.loading")}</p> : null}
    {storageUnavailable ? <p role="alert">{t("tenant.metaRouting.storageUnavailable")}</p> : null}
    {held || serverHeld ? <p role="status">{t("tenant.metaRouting.outcomeHold")}</p> : null}
    {data ? <>
      <p>{t(`tenant.metaRouting.claim.${data.ownership.claim}`)}</p>
      <p>{t("tenant.metaRouting.snapshot")}</p>
      {data.actions.length ? <ul className={styles.history}>{data.actions.map(item => <li key={item.id}>
        <strong>{t(`tenant.metaRouting.action.${item.action}`)}{item.targetRole ? ` · ${t(`tenant.metaRouting.role.${item.targetRole}`)}` : ""}</strong>
        <span>{t(`tenant.metaRouting.actionState.${item.state}`)}</span>
      </li>)}</ul> : <p>{t("tenant.metaRouting.noActions")}</p>}
      {!unavailable ? <div className={styles.actions}>{data.availability.actions.map(item => <button className="button secondary" type="button" key={item} onClick={() => { loadFence.current.invalidate(); setTarget(""); setAction(item); }}>{t(`tenant.metaRouting.action.${item}`)}</button>)}</div> : null}
      {action && !unavailable ? <InlineConfirmation className={styles.confirm} busy={saving} aria-labelledby="meta-thread-confirm" cancel={() => setAction(null)}>
        <h3 id="meta-thread-confirm">{t("tenant.metaRouting.confirm", { action: t(`tenant.metaRouting.action.${action}`) })}</h3>
        <p>{t("tenant.metaRouting.effect")}</p>
        {action === "pass" ? <label>{t("tenant.metaRouting.target")}<select value={target} onChange={event => setTarget(event.target.value as MetaRoutingRole | "")}>
          <option value="" disabled={!data.availability.untargetedPass}>{t(data.availability.untargetedPass ? "tenant.metaRouting.defaultTarget" : "tenant.metaRouting.chooseTarget")}</option>
          {data.availability.passTargets.map(role => <option key={role} value={role}>{t(`tenant.metaRouting.role.${role}`)}</option>)}
        </select></label> : null}
        <div className={styles.actions}><button className="button secondary" type="button" data-inline-confirm-initial-focus onClick={() => setAction(null)}>{t("tenant.metaRouting.cancel")}</button>
          <button className="button" type="button" disabled={!actionAvailable} onClick={() => void execute()}>{t("tenant.metaRouting.confirmAction")}</button></div>
      </InlineConfirmation> : null}
    </> : null}
    <div className={styles.actions}><button className="button secondary" type="button" disabled={loading || saving} onClick={() => { setLoading(true); void read(); }}>{t("tenant.metaRouting.refresh")}</button><button className="button secondary" type="button" disabled={saving} onClick={close}>{t("tenant.metaRouting.close")}</button></div>
  </div></ModalDialog>;
}
