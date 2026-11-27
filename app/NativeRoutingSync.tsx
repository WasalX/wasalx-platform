"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { DepartmentDefaultPolicy, NativeRoutingSyncCommand, NativeRoutingSyncStatus } from "../packages/core/src/native-routing-contract";
import { formatDateTime, formatNumber } from "../lib/i18n/format";
import { operatorFailureMessage, createLatestRequestFence, operatorResponseFailure } from "../lib/operator-ui";
import { nativeRoutingCanRetry, nativeRoutingDefaultsValid, nativeRoutingDisplayState, type NativeRoutingCatalog } from "../lib/native-routing-ui";
import { useI18n } from "./I18nProvider";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./NativeRoutingSync.module.css";

type Props = {
  canWrite: boolean;
  mutationHeaders: Record<string, string>;
  refreshKey: string;
  catalog?: NativeRoutingCatalog;
};

export function NativeRoutingSync({ canWrite, mutationHeaders, refreshKey, catalog }: Props) {
  const { locale, t } = useI18n();
  const titleId = useId();
  const [receipt, setReceipt] = useState<{ status: NativeRoutingSyncStatus; sourceKey: string } | null>(null);
  const status = receipt?.sourceKey === refreshKey ? receipt.status : null;
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ revision: number; policies: DepartmentDefaultPolicy[] } | null>(null);
  const fence = useRef(createLatestRequestFence());
  const operation = useRef<{ body: string; key: string } | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = fence.current.begin();
    try {
      const response = await fetch("/api/zammad/routing-sync", { cache: "no-store", signal });
      if (!response.ok) throw await operatorResponseFailure(response, t("nativeRouting.unavailable"), locale);
      const next = await response.json() as NativeRoutingSyncStatus;
      if (signal?.aborted || !fence.current.isCurrent(request)) return;
      setReceipt({ status: next, sourceKey: refreshKey });
      setError(null);
    } catch (problem) {
      if (!signal?.aborted && fence.current.isCurrent(request)) {
        // Do not keep presenting a stale green receipt after readback fails.
        setReceipt(null);
        setError(operatorFailureMessage(problem, t("nativeRouting.unavailable")));
      }
    } finally {
      if (!signal?.aborted && fence.current.isCurrent(request)) setLoading(false);
    }
  }, [locale, refreshKey, t]);
  useEffect(() => {
    const controller = new AbortController();
    const requestFence = fence.current;
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); requestFence.invalidate(); };
  }, [load, refreshKey]);
  useVisibleRefresh(signal => load(signal), !busy && editor === null);
  useEffect(() => {
    if (!status || busy || editor || !["PENDING", "APPLYING"].includes(status.state)) return;
    const timer = window.setTimeout(() => { if (document.visibilityState === "visible") void load(); }, 3_000);
    return () => window.clearTimeout(timer);
  }, [busy, editor, load, status]);

  const command = async (input: NativeRoutingSyncCommand) => {
    if (busy || !canWrite || !status) return;
    if (input.action === "RECONCILE" && !nativeRoutingCanRetry(status)) return;
    const body = JSON.stringify(input);
    const key = operation.current?.body === body ? operation.current.key : crypto.randomUUID();
    operation.current = { body, key };
    fence.current.invalidate();
    setReceipt(null);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/zammad/routing-sync", {
        method: "POST", headers: { ...mutationHeaders, "idempotency-key": key }, body,
      });
      if (!response.ok) throw await operatorResponseFailure(response, t("nativeRouting.commandFailed"), locale);
      operation.current = null;
      if (input.action === "SAVE_DEFAULTS") setEditor(null);
      await load();
    } catch (problem) {
      const failure = operatorFailureMessage(problem, t("nativeRouting.commandFailed"));
      // A lost response may have applied. Only read back; never repeat APPLY here.
      await load();
      setError(failure);
    } finally { setBusy(false); }
  };
  const displayState = status ? nativeRoutingDisplayState(status) : null;
  const updatePolicy = (id: string, change: Partial<DepartmentDefaultPolicy>) => {
    setEditor(current => current ? { ...current, policies: current.policies.map(policy => policy.id === id ? { ...policy, ...change } : policy) } : current);
  };

  return <section className={`panel ${styles.panel}`} aria-labelledby={titleId} aria-busy={loading || busy}>
    <div className="panel-heading">
      <div><h2 id={titleId}>{t("nativeRouting.title")}</h2><p>{t("nativeRouting.description")}</p></div>
      <button type="button" className="button secondary small" disabled={busy} onClick={() => void load()}>{t("nativeRouting.refresh")}</button>
    </div>
    <div className={styles.body}>
    <div role="status">
      <b>{t(displayState ? `nativeRouting.state.${displayState}` : loading || busy ? "nativeRouting.loading" : "nativeRouting.unavailable")}</b>
      {status?.lastCheckedAt ? <p>{t("nativeRouting.checked", { time: formatDateTime(status.lastCheckedAt, locale) })}</p> : null}
      {displayState && ["DRIFT", "FAILED", "OUTCOME_UNKNOWN"].includes(displayState) ? <p>{t(`nativeRouting.help.${displayState}`)}</p> : null}
    </div>
    {error ? <p className="bot-inline-error" role="alert">{error}</p> : null}
    {canWrite && status ? <div className={styles.actions}>
      <button type="button" className="button secondary small" disabled={busy || editor !== null} onClick={() => void command({ action: "CHECK", expectedRevision: status.desiredRevision })}>{t("nativeRouting.check")}</button>
      {nativeRoutingCanRetry(status) ? <button type="button" className="button secondary small" disabled={busy || editor !== null} onClick={() => void command({ action: "RECONCILE", expectedRevision: status.desiredRevision })}>{t("nativeRouting.retry")}</button> : null}
      {catalog && !editor ? <button type="button" className="button secondary small" disabled={busy} onClick={() => setEditor({ revision: status.desiredRevision, policies: structuredClone(status.departmentDefaults) })}>{t("nativeRouting.defaults.edit")}</button> : null}
    </div> : null}
    {catalog ? <p>{t("nativeRouting.defaults.description")}</p> : null}
    {catalog && !editor && status ? <>
      <p>{t("nativeRouting.defaults.count", { count: formatNumber(status.departmentDefaults.length, locale) })}</p>
      <ul>{status.departmentDefaults.map(policy => <li key={policy.id}>
        <bdi dir="auto">{catalog.groups.find(group => group.id === policy.zammadGroupId)?.name ?? t("nativeRouting.defaults.unavailableQueue")}</bdi>{" · "}
        <bdi dir="auto">{catalog.owners.find(owner => owner.id === policy.zammadOwnerId)?.name ?? t("nativeRouting.defaults.unavailableOwner")}</bdi>{" · "}
        {t(policy.enabled ? "nativeRouting.defaults.enabled" : "nativeRouting.defaults.disabled")}
      </li>)}</ul>
    </> : null}
    {editor && catalog && canWrite ? <form data-unsaved="true" className={styles.editor} onSubmit={event => {
      event.preventDefault();
      if (nativeRoutingDefaultsValid(editor.policies, catalog)) void command({ action: "SAVE_DEFAULTS", expectedRevision: editor.revision, departmentDefaults: editor.policies });
    }}>
      <h3>{t("nativeRouting.defaults.title")}</h3>
      {editor.policies.length === 0 ? <p>{t("nativeRouting.defaults.empty")}</p> : null}
      {editor.policies.map((policy, index) => {
        const groups = catalog.groups.filter(group => group.active && group.serviceIdentityCanCreate);
        const owners = catalog.owners.filter(owner => owner.active && owner.groupIds.includes(policy.zammadGroupId));
        const duplicateQueue = Boolean(policy.zammadGroupId) && editor.policies.some(item => item.id !== policy.id && item.zammadGroupId === policy.zammadGroupId);
        const policyErrorId = `${titleId}-${policy.id}-error`;
        return <fieldset key={policy.id} className={styles.policy} disabled={busy}>
          <legend>{t("nativeRouting.defaults.policy", { number: formatNumber(index + 1, locale) })}</legend>
          <div className="routing-editor-grid">
            <label>{t("nativeRouting.defaults.queue")}<select required value={policy.zammadGroupId} aria-invalid={duplicateQueue || undefined} aria-describedby={duplicateQueue ? policyErrorId : undefined} onChange={event => updatePolicy(policy.id, { zammadGroupId: event.target.value })}>
              <option value="">{t("nativeRouting.defaults.selectQueue")}</option>
              {policy.zammadGroupId && !groups.some(group => group.id === policy.zammadGroupId) ? <option value={policy.zammadGroupId}>{t("nativeRouting.defaults.unavailableQueue")}</option> : null}
              {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select></label>
            <label>{t("nativeRouting.defaults.owner")}<select required value={policy.zammadOwnerId} disabled={!policy.zammadGroupId} onChange={event => updatePolicy(policy.id, { zammadOwnerId: event.target.value })}>
              <option value="">{t("nativeRouting.defaults.selectOwner")}</option>
              {policy.zammadOwnerId && !owners.some(owner => owner.id === policy.zammadOwnerId) ? <option value={policy.zammadOwnerId}>{t("nativeRouting.defaults.unavailableOwner")}</option> : null}
              {owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
            </select></label>
          </div>
          {duplicateQueue ? <p id={policyErrorId} className="bot-inline-error" role="alert">{t("nativeRouting.defaults.duplicate")}</p> : null}
          <label className={styles.enabled}><input type="checkbox" checked={policy.enabled} onChange={event => updatePolicy(policy.id, { enabled: event.target.checked })} />{t("nativeRouting.defaults.enabled")}</label>
          <button type="button" className="button secondary small" onClick={() => setEditor(current => current ? { ...current, policies: current.policies.filter(item => item.id !== policy.id) } : current)}>{t("nativeRouting.defaults.remove")}</button>
        </fieldset>;
      })}
      {editor.policies.length > 0 && !nativeRoutingDefaultsValid(editor.policies, catalog) ? <p className="bot-inline-error" role="alert">{t("nativeRouting.defaults.invalid")}</p> : null}
      {status && editor.revision !== status.desiredRevision ? <p className="bot-inline-error" role="alert">{t("nativeRouting.defaults.stale")}</p> : null}
      <div className={styles.actions}>
        <button type="button" className="button secondary small" disabled={busy || editor.policies.length >= 100} onClick={() => { const id = crypto.randomUUID(); setEditor(current => current ? { ...current, policies: [...current.policies, { id, zammadGroupId: "", zammadOwnerId: "", enabled: true }] } : current); }}>{t("nativeRouting.defaults.add")}</button>
        <button type="button" className="button secondary small" disabled={busy} onClick={() => setEditor(null)}>{t("automation.common.cancel")}</button>
        <button type="submit" className="button primary small" disabled={busy || !status || editor.revision !== status.desiredRevision || !nativeRoutingDefaultsValid(editor.policies, catalog)}>{t(busy ? "nativeRouting.defaults.saving" : "nativeRouting.defaults.save")}</button>
      </div>
    </form> : null}
    </div>
  </section>;
}
