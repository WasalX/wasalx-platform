"use client";

import { Fragment, useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { parseTicketEventFlow, ticketEvents, type TicketEvent, type TicketEventDefinition } from "../packages/core/src/ticket-event-flow.ts";
import { operatorResponseFailure } from "../lib/operator-ui.ts";
import { localizedUiError } from "../lib/ui-error.ts";
import { useI18n } from "./I18nProvider.tsx";
import { InlineConfirmation } from "./ModalDialog.tsx";
import { TicketEventEditor, TicketEventPreviewPanel, ticketEventStarter } from "./TicketEventEditor.tsx";

type Row = Record<string, unknown>;
type Binding = { id: string; whatsapp_group_id: string | null; event: TicketEvent; mode: "CUSTOM" | "OFF" | "INHERIT"; flow_version_id: string | null; revision: number | string };
type Configuration = { bindings: Binding[]; groups: { id: string; display_name: string; provider: "WAHA" | "META" }[]; members: { id: string; display_name: string; role: string }[] };
type Draft = { definition: TicketEventDefinition; sourceId?: string; sourceEvent: TicketEvent; storageKey: string; initial: string; recoveryWritable: boolean };
type BindingDraft = { groupId: string | null; event: TicketEvent; mode: Binding["mode"]; flowVersionId: string | null; expectedRevision: number };
type Props = {
  active: boolean; flows: Row[]; canWrite: boolean; workspaceId: string;
  mutationHeaders: Record<string, string>; onFlow: (row: Row) => void;
  nextCursor: string | null; loadingMore: boolean; paginationError: string | null; loadMore: () => void;
};

export function isTicketEventFlowRow(row: Row) {
  return row.kind === "TICKET_EVENT" || Boolean(row.definition && typeof row.definition === "object" && "kind" in row.definition && row.definition.kind === "TICKET_EVENT");
}

export function TicketEventWorkflows({ active, flows, canWrite, workspaceId, mutationHeaders, onFlow, nextCursor, loadingMore, paginationError, loadMore }: Props) {
  const { t, locale } = useI18n();
  const id = useId();
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [configurationError, setConfigurationError] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [starter, setStarter] = useState<TicketEvent>("reference_received");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [discard, setDiscard] = useState(false);
  const [publish, setPublish] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [groupId, setGroupId] = useState("");
  const [event, setEvent] = useState<TicketEvent>("reference_received");
  const [bindingDraft, setBindingDraft] = useState<BindingDraft | null>(null);
  const intents = useRef(new Map<string, string>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestBusy = useRef(false);
  const rows = flows.filter(isTicketEventFlowRow);
  const selected = selectedId || String(rows[0]?.flow_version_id ?? "");
  const selectedDetail = detail && String(detail.flow_version_id) === selected ? detail : null;
  const members = configuration?.members.map(member => ({ id: member.id, label: member.display_name })) ?? [];
  const read = useCallback(async <T,>(url: string, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(url, { cache: "no-store", signal });
    if (!response.ok) throw await operatorResponseFailure(response, t("ticketEvent.workspace.loadFailed"), locale);
    return response.json() as Promise<T>;
  }, [locale, t]);
  const fetchDetail = useCallback(async (flowId: string, signal?: AbortSignal) => {
    const row = await read<Row>(`/api/bot-flows/${encodeURIComponent(flowId)}`, signal);
    const definition = parseTicketEventFlow(row.definition);
    if (String(row.flow_version_id) !== flowId) throw new Error(t("ticketEvent.workspace.loadFailed"));
    return { ...row, kind: "TICKET_EVENT", event: definition.event };
  }, [read, t]);
  useEffect(() => {
    if (!active || configuration) return;
    const controller = new AbortController();
    void read<Configuration>("/api/bot-flows/ticket-events", controller.signal).then(value => {
      if (!controller.signal.aborted) { setConfiguration(value); setConfigurationError(false); }
    }).catch(() => { if (!controller.signal.aborted) setConfigurationError(true); });
    return () => controller.abort();
  }, [active, configuration, read]);
  useEffect(() => {
    if (!active || !selected) return;
    const controller = new AbortController();
    void fetchDetail(selected, controller.signal).then(row => {
      if (!controller.signal.aborted) { setDetail(row); setDetailError(false); }
    }).catch(() => { if (!controller.signal.aborted) setDetailError(true); });
    return () => controller.abort();
  }, [active, fetchDetail, selected]);
  const draftText = draft ? JSON.stringify(draft.definition) : "";
  const dirty = Boolean(draft && draftText !== draft.initial) || bindingDraft !== null;
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  useEffect(() => {
    if (!draft?.recoveryWritable) return;
    const timer = window.setTimeout(() => {
      try { parseTicketEventFlow(JSON.parse(draftText)); window.localStorage.setItem(draft.storageKey, draftText); }
      catch { /* Keep the last valid recovery copy; incomplete edits remain in memory. */ }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft?.recoveryWritable, draft?.storageKey, draftText]);
  function showError(problem: unknown) {
    setError(problem instanceof Error && "code" in problem ? problem.message : localizedUiError(locale, problem).message);
  }
  async function refreshConfiguration() {
    try { setConfiguration(await read<Configuration>("/api/bot-flows/ticket-events")); setConfigurationError(false); }
    catch (problem) { setConfigurationError(true); showError(problem); }
  }
  async function post<T>(url: string, body: unknown): Promise<T> {
    const intent = JSON.stringify([url, body]);
    const key = intents.current.get(intent) ?? crypto.randomUUID();
    intents.current.set(intent, key);
    const response = await fetch(url, { method: "POST", headers: { ...mutationHeaders, "idempotency-key": key }, body: JSON.stringify(body) });
    if (!response.ok) throw await operatorResponseFailure(response, t("ticketEvent.workspace.saveFailed"), locale);
    const result = await response.json() as T;
    intents.current.delete(intent);
    return result;
  }
  function openDraft(definition: TicketEventDefinition, sourceId?: string) {
    const storageKey = `wasalx:ticket-event-draft:${workspaceId}:${sourceId ?? `new:${definition.event}`}`;
    let recovered = definition, recoveryWritable = true;
    setNotice(""); setError("");
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) { recovered = parseTicketEventFlow(JSON.parse(stored)); setNotice(t("ticketEvent.workspace.recovered")); }
    } catch { recoveryWritable = false; setNotice(t("ticketEvent.workspace.recoveryUnavailable")); }
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraft({ definition: recovered, sourceId, sourceEvent: definition.event, storageKey, initial: JSON.stringify(definition), recoveryWritable });
    window.requestAnimationFrame(() => document.getElementById(`${id}-draft-title`)?.focus());
  }
  function closeDraft() {
    if (draft?.recoveryWritable) try { window.localStorage.removeItem(draft.storageKey); } catch { /* The editor can still close. */ }
    setDraft(null); setDiscard(false);
    window.requestAnimationFrame(() => returnFocus.current?.focus());
  }
  function checkMembers(definition: TicketEventDefinition) {
    if (definition.permission?.mode === "SPECIFIC" && (!configuration || definition.permission.memberIds.some(member => !configuration.members.some(option => option.id === member)))) {
      throw Object.assign(new Error(t("ticketEvent.membersUnavailable")), { code: "VALIDATION_ERROR" });
    }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !draft || requestBusy.current) return;
    let definition: TicketEventDefinition;
    try { definition = parseTicketEventFlow(draft.definition); checkMembers(definition); }
    catch { setError(t("ticketEvent.invalid")); return; }
    requestBusy.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const sameFamily = draft.sourceId && draft.sourceEvent === definition.event;
      const result = await post<{ id: string }>(sameFamily ? `/api/bot-flows/${encodeURIComponent(draft.sourceId!)}/clone` : "/api/bot-flows", definition);
      // Acknowledged save is not repeated if the subsequent read fails.
      closeDraft(); setSelectedId(result.id); setNotice(t("ticketEvent.workspace.saved"));
      try { const row = await fetchDetail(result.id); setDetail(row); onFlow(row); }
      catch { setDetailError(true); setError(t("ticketEvent.workspace.savedReload")); }
    } catch (problem) { showError(problem); }
    finally { requestBusy.current = false; setSaving(false); }
  }
  async function publishDraft() {
    if (!canWrite || !selectedDetail || requestBusy.current) return;
    requestBusy.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const definition = parseTicketEventFlow(selectedDetail.definition); checkMembers(definition);
      if (!Object.hasOwn(selectedDetail, "active_flow_version_id")) throw new Error("Missing activation context");
      const result = await post<{ flowVersionId: string; retiredFlowVersionId: string | null; revision: number }>(`/api/bot-flows/${encodeURIComponent(selected)}/activate`, {
        expectedRevision: Number(selectedDetail.revision), expectedActiveFlowVersionId: selectedDetail.active_flow_version_id ?? null,
      });
      setPublish(false); setNotice(t("ticketEvent.workspace.published"));
      const acknowledged = { ...selectedDetail, state: "ACTIVE", revision: result.revision, active_flow_version_id: result.flowVersionId };
      setDetail(acknowledged); onFlow(acknowledged);
      try {
        const row = await fetchDetail(result.flowVersionId); setDetail(row); onFlow(row);
        if (result.retiredFlowVersionId) onFlow(await fetchDetail(result.retiredFlowVersionId));
      } catch { setError(t("ticketEvent.workspace.publishedReload")); }
    } catch (problem) { showError(problem); }
    finally { requestBusy.current = false; setSaving(false); }
  }
  const current = configuration?.bindings.find(binding => binding.event === event && binding.whatsapp_group_id === (groupId || null));
  const savedBinding: BindingDraft = { groupId: groupId || null, event, mode: current?.mode ?? (groupId ? "INHERIT" : "OFF"), flowVersionId: current?.flow_version_id ?? null, expectedRevision: Number(current?.revision ?? 0) };
  const binding = bindingDraft ?? savedBinding;
  const bindingChoices = rows.filter(row => row.event === event && (row.state === "ACTIVE" || row.state === "RETIRED"));
  const defaultBinding = configuration?.bindings.find(binding => binding.event === event && binding.whatsapp_group_id === null);
  // No binding preserves existing group behavior; absence is not an explicit OFF choice.
  const effective = current?.mode === "INHERIT" || (!current && groupId) ? defaultBinding : current;
  const effectiveRow = rows.find(row => String(row.flow_version_id) === effective?.flow_version_id);
  async function saveBinding(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || !bindingDraft || !configuration || requestBusy.current) return;
    requestBusy.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const result = await post<{ id: string; revision: number }>("/api/bot-flows/ticket-events", bindingDraft);
      const saved: Binding = { id: result.id, revision: result.revision, event: bindingDraft.event, whatsapp_group_id: bindingDraft.groupId, mode: bindingDraft.mode, flow_version_id: bindingDraft.flowVersionId };
      setConfiguration({ ...configuration, bindings: [...configuration.bindings.filter(item => item.event !== saved.event || item.whatsapp_group_id !== saved.whatsapp_group_id), saved] });
      setBindingDraft(null); setNotice(t("ticketEvent.workspace.bindingSaved"));
    } catch (problem) { showError(problem); }
    finally { requestBusy.current = false; setSaving(false); }
  }
  let selectedDefinition: TicketEventDefinition | null = null;
  try { if (selectedDetail) selectedDefinition = parseTicketEventFlow(selectedDetail.definition); } catch { /* Fail closed while loading an invalid version. */ }
  return <div className="ticket-event-workspace ticket-event-editor">
    <div className="bot-section-head"><div><h2>{t("ticketEvent.workspace.title")}</h2><p>{t("ticketEvent.workspace.help")}</p></div></div>
    {error ? <p className="settings-feedback error" role="alert">{error}</p> : null}
    {notice ? <p className="settings-feedback success" role="status">{notice}</p> : null}
    {configurationError ? <div className="settings-feedback error" role="alert"><p>{t("ticketEvent.workspace.loadFailed")}</p><button type="button" className="button secondary" onClick={() => void refreshConfiguration()}>{t("automation.common.reload")}</button></div> : null}
    <div className="bot-workspace">
      <aside className="panel bot-version-list"><div className="panel-heading"><h3>{t("ticketEvent.workspace.versions")}</h3></div>
        {canWrite ? <div className="bot-editor-layout"><label htmlFor={`${id}-new-event`}>{t("ticketEvent.starter")}<select id={`${id}-new-event`} name={`${id}-new-event`} value={starter} disabled={Boolean(draft) || saving} onChange={event => setStarter(event.target.value as TicketEvent)}>{ticketEvents.map(event => <option key={event} value={event}>{t(`ticketEvent.event.${event}`)}</option>)}</select></label><button type="button" className="button primary" disabled={Boolean(draft) || saving} onClick={() => openDraft(ticketEventStarter(starter, t))}>{t("ticketEvent.workspace.create")}</button></div> : null}
        <div>{rows.map(row => <button key={String(row.flow_version_id)} type="button" className={String(row.flow_version_id) === selected ? "selected" : ""} aria-pressed={String(row.flow_version_id) === selected} disabled={Boolean(draft) || saving || publish} onClick={() => { setSelectedId(String(row.flow_version_id)); setDetailError(false); }}><span><b>{String(row.name)}</b><small>{t("ticketEvent.workspace.version", { version: Number(row.version) })} · {t(`ticketEvent.event.${String(row.event)}`)}</small></span><span className="tag">{t(`ticketEvent.workspace.state.${String(row.state)}`)}</span></button>)}</div>
        {!rows.length ? <p className="bot-editor-layout">{t("ticketEvent.workspace.empty")}</p> : null}
        {paginationError ? <p role="alert" className="bot-inline-error">{paginationError}</p> : null}
        {nextCursor ? <button type="button" className="routing-version-toggle" disabled={loadingMore || saving} onClick={loadMore}>{t(loadingMore ? "bot.flows.loadingMore" : "bot.flows.loadMore")}</button> : null}
      </aside>
      <section className="panel bot-flow-detail">
        {selectedDefinition && selectedDetail ? <><div className="panel-heading"><div><h3>{String(selectedDetail.name)}</h3><p>{t("ticketEvent.workspace.version", { version: Number(selectedDetail.version) })} · {t(`ticketEvent.workspace.state.${String(selectedDetail.state)}`)}</p></div>
          {canWrite ? <div className="bot-heading-actions"><button type="button" className="button secondary" disabled={saving || publish} onClick={() => { void fetchDetail(selected).then(row => { setDetail(row); setDetailError(false); setError(""); onFlow(row); }).catch(showError); }}>{t("automation.common.reload")}</button><button type="button" className="button secondary" disabled={Boolean(draft) || saving || publish} onClick={() => openDraft(selectedDefinition, selected)}>{t("ticketEvent.workspace.edit")}</button>{selectedDetail.state === "DRAFT" ? <button type="button" className="button primary" disabled={Boolean(draft) || saving || !configuration || !Object.hasOwn(selectedDetail, "active_flow_version_id")} onClick={() => setPublish(true)}>{t("ticketEvent.workspace.publish")}</button> : null}</div> : null}
        </div>
        {publish ? <InlineConfirmation busy={saving} cancel={() => { if (!saving) setPublish(false); }} aria-labelledby={`${id}-publish-title`}><h4 id={`${id}-publish-title`}>{t("ticketEvent.workspace.publishTitle")}</h4><p>{t("ticketEvent.workspace.publishHelp")}</p><div className="bot-form-actions"><button type="button" data-inline-confirm-initial-focus className="button secondary" disabled={saving} onClick={() => setPublish(false)}>{t("automation.common.cancel")}</button><button type="button" className="button primary" disabled={saving} onClick={() => void publishDraft()}>{t("ticketEvent.workspace.publish")}</button></div></InlineConfirmation> : null}
        <Fragment key={selected}>
          <TicketEventEditor definition={selectedDefinition} onChange={() => {}} disabled memberOptions={members} />
          <TicketEventPreviewPanel definition={selectedDefinition} memberOptions={members} />
        </Fragment></>
          : selected ? <div className="bot-editor-layout"><p role={detailError ? "alert" : "status"}>{t(detailError ? "ticketEvent.workspace.loadFailed" : "bot.loading")}</p>{detailError ? <button type="button" className="button secondary" onClick={() => { void fetchDetail(selected).then(row => { setDetail(row); setDetailError(false); }).catch(showError); }}>{t("automation.common.reload")}</button> : null}</div> : <p className="bot-editor-layout">{t("ticketEvent.workspace.choose")}</p>}
      </section>
    </div>
    {draft ? <div className="panel bot-flow-editor"><form id={`${id}-draft`} onSubmit={saveDraft}>
      <div className="panel-heading"><div><h3 id={`${id}-draft-title`} tabIndex={-1}>{t("ticketEvent.workspace.draft")}</h3><p>{t("ticketEvent.workspace.draftHelp")}</p></div></div>
      <TicketEventEditor definition={draft.definition} onChange={definition => setDraft({ ...draft, definition })} disabled={!canWrite || saving} memberOptions={members} />
      </form>
      <TicketEventPreviewPanel definition={draft.definition} memberOptions={members} />
      <div className="bot-form-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => draftText === draft.initial ? closeDraft() : setDiscard(true)}>{t("automation.common.cancel")}</button><button type="submit" form={`${id}-draft`} className="button primary" disabled={!canWrite || saving}>{t(saving ? "bot.command.saving" : "ticketEvent.workspace.save")}</button></div>
      {discard ? <InlineConfirmation busy={saving} cancel={() => setDiscard(false)} aria-labelledby={`${id}-discard-title`}><h4 id={`${id}-discard-title`}>{t("ticketEvent.workspace.discardTitle")}</h4><div className="bot-form-actions"><button type="button" data-inline-confirm-initial-focus className="button secondary" onClick={() => setDiscard(false)}>{t("bot.editor.keepEditing")}</button><button type="button" className="button primary" onClick={closeDraft}>{t("bot.editor.discard")}</button></div></InlineConfirmation> : null}
    </div> : null}
    <section className="panel bot-flow-editor" aria-labelledby={`${id}-bindings-title`}><div className="panel-heading"><div><h3 id={`${id}-bindings-title`}>{t("ticketEvent.workspace.bindings")}</h3><p>{t("ticketEvent.workspace.bindingsHelp")}</p></div><button type="button" className="button secondary" disabled={saving} onClick={() => void refreshConfiguration()}>{t("automation.common.reload")}</button></div>
      {configuration ? <form onSubmit={saveBinding}><fieldset className="bot-form-grid" disabled={saving}>
        <label htmlFor={`${id}-scope`}>{t("ticketEvent.workspace.scope")}<select id={`${id}-scope`} name={`${id}-scope`} value={groupId} disabled={bindingDraft !== null} onChange={event => setGroupId(event.target.value)}><option value="">{t("ticketEvent.workspace.defaults")}</option>{configuration.groups.map(group => <option key={group.id} value={group.id}>{group.display_name}</option>)}</select></label>
        <label htmlFor={`${id}-binding-event`}>{t("ticketEvent.workspace.event")}<select id={`${id}-binding-event`} name={`${id}-binding-event`} value={event} disabled={bindingDraft !== null} onChange={event => setEvent(event.target.value as TicketEvent)}>{ticketEvents.map(event => <option key={event} value={event}>{t(`ticketEvent.event.${event}`)}</option>)}</select></label>
        <label htmlFor={`${id}-mode`}>{t("ticketEvent.workspace.mode")}<select id={`${id}-mode`} name={`${id}-mode`} disabled={!canWrite} value={!groupId && !current && !bindingDraft ? "LEGACY" : binding.mode} onChange={event => { const mode = event.target.value as Binding["mode"]; setBindingDraft({ ...binding, mode, flowVersionId: mode === "CUSTOM" ? binding.flowVersionId : null }); }}>{!groupId && !current && !bindingDraft ? <option value="LEGACY" disabled>{t("ticketEvent.workspace.mode.LEGACY")}</option> : null}{(groupId ? ["INHERIT", "CUSTOM", "OFF"] : ["CUSTOM", "OFF"]).map(mode => <option key={mode} value={mode}>{t(`ticketEvent.workspace.mode.${mode}`)}</option>)}</select></label>
        {binding.mode === "CUSTOM" ? <label htmlFor={`${id}-binding-version`}>{t("ticketEvent.workspace.publishedVersion")}<select id={`${id}-binding-version`} name={`${id}-binding-version`} disabled={!canWrite} required value={binding.flowVersionId ?? ""} onChange={event => setBindingDraft({ ...binding, flowVersionId: event.target.value || null })}><option value="">{t("ticketEvent.workspace.choose")}</option>{binding.flowVersionId && !bindingChoices.some(row => String(row.flow_version_id) === binding.flowVersionId) ? <option value={binding.flowVersionId}>{t("ticketEvent.workspace.currentVersion")}</option> : null}{bindingChoices.map(row => <option key={String(row.flow_version_id)} value={String(row.flow_version_id)}>{String(row.name)} · {t("ticketEvent.workspace.version", { version: Number(row.version) })}</option>)}</select></label> : null}
        <p className="bot-node-note">{!effective ? t("ticketEvent.workspace.effectiveLegacy") : effective.mode === "CUSTOM" ? t("ticketEvent.workspace.effective", { name: effectiveRow ? String(effectiveRow.name) : t("ticketEvent.workspace.currentVersion") }) : t("ticketEvent.workspace.effectiveOff")}</p>
        {nextCursor ? <p className="bot-node-note">{t("ticketEvent.workspace.moreVersions")}</p> : null}
      </fieldset>{canWrite ? <div className="bot-form-actions"><button type="button" className="button secondary" disabled={!bindingDraft || saving} onClick={() => setBindingDraft(null)}>{t("automation.common.cancel")}</button><button type="submit" className="button primary" disabled={!bindingDraft || saving}>{t(saving ? "bot.command.saving" : "ticketEvent.workspace.saveBinding")}</button></div> : null}</form> : <p className="bot-editor-layout" role="status">{t(configurationError ? "ticketEvent.workspace.loadFailed" : "bot.loading")}</p>}
    </section>
  </div>;
}
