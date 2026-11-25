"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "./I18nProvider";
import { createLatestRequestFence } from "../lib/operator-ui";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./SupportTeams.module.css";
import { ServiceAccess } from "./ServiceAccess";
import type { IdentityOperation } from "../lib/service-access-contract";

type Access = "full" | "read" | "create" | "change" | "overview";
type Team = { id: string; name: string; note: string; active: boolean; version: string };
type Detail = Team & { can_manage: boolean; can_grant: boolean; members_next_cursor: string | null; members: Array<{ id: string; name: string; email: string; version: string; direct_access: Access[]; effective_access: Access[]; editable: boolean }> };
type Intent = { operation_id: string; kind: "TEAM_CREATE" | "TEAM_SAVE" | "TEAM_GRANT_SAVE"; team_id?: string; member_id?: string };
export type TeamOperation = Intent["kind"] | "TEAM_LIST" | "TEAM_SHOW" | "TEAM_RECEIPT" | IdentityOperation;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function recoveryIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.operation_id !== "string" || !UUID.test(row.operation_id) || typeof row.kind !== "string" || !["TEAM_CREATE", "TEAM_SAVE", "TEAM_GRANT_SAVE"].includes(row.kind)) return false;
  const keys = row.kind === "TEAM_CREATE" ? ["kind", "operation_id"] : row.kind === "TEAM_GRANT_SAVE" ? ["kind", "operation_id", "team_id", "member_id"] : ["kind", "operation_id", "team_id"];
  return Object.keys(row).sort().join(",") === keys.sort().join(",") && (row.kind === "TEAM_CREATE" || typeof row.team_id === "string" && /^[1-9][0-9]{0,15}$/u.test(row.team_id)) && (row.kind !== "TEAM_GRANT_SAVE" || typeof row.member_id === "string" && UUID.test(row.member_id));
}

export function parseTeamRecovery(raw: string | null): Intent | null {
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error("Oversized recovery identifiers");
  const value: unknown = JSON.parse(raw);
  if (!recoveryIntent(value)) throw new Error("Invalid recovery identifiers");
  return value;
}

export function SupportTeams({ execute, scope, owner = false }: { execute: <T>(operation: TeamOperation, input: Record<string, unknown>, signal?: AbortSignal) => Promise<T>; scope: string; owner?: boolean }) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState({ name: "", note: "", active: true });
  const [grants, setGrants] = useState<Record<string, Access[]>>({});
  const [grantVersions, setGrantVersions] = useState<Record<string, string>>({});
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Intent | null>(null);
  const [loading, setLoading] = useState(true);
  const [recoveryCorrupt, setRecoveryCorrupt] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const fence = useRef(createLatestRequestFence());
  const listFence = useRef(createLatestRequestFence());
  const inFlight = useRef(false);
  const lifecycle = useRef({ mounted: false, generation: 0 });
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [denied, setDenied] = useState(false);
  const hydratedStorage = useRef<string | null>(null);
  const live = useCallback((generation: number) => lifecycle.current.mounted && lifecycle.current.generation === generation, []);
  const request = useCallback(async <T,>(operation: Parameters<typeof execute>[0], input: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const generation = lifecycle.current.generation;
    try {
      const value = await execute<T>(operation, input, signal);
      if (!live(generation) || signal?.aborted) throw new DOMException("Stale administration request", "AbortError");
      return value;
    } catch (cause) {
      if (!live(generation) || signal?.aborted) throw new DOMException("Stale administration request", "AbortError");
      throw cause;
    }
  }, [execute, live]);
  const storageKey = `wasalx:team-operation:${scope}`;
  const dirty = selected === "new" ? Boolean(draft.name || draft.note) : Boolean(detail && (draft.name !== detail.name || draft.note !== detail.note || draft.active !== detail.active || Object.keys(grants).length));
  const blocked = busy || Boolean(pending) || recoveryCorrupt || !recoveryReady || denied;
  const listUnavailable = teams === null && !denied && !reauthenticate && !recoveryCorrupt && pending === null;

  const failure = useCallback((cause: unknown) => {
    if (!lifecycle.current.mounted || cause instanceof DOMException && cause.name === "AbortError") return;
    const status = (cause as { status?: number } | null)?.status;
    if ((cause as { code?: string } | null)?.code === "REAUTHENTICATION_REQUIRED") {
      setReauthenticate(true); setError(t("teamsAdmin.failed")); return;
    }
    if (status === 401 || status === 403) {
      lifecycle.current.generation++; inFlight.current = false; setDenied(true); setCursor(null);
      setTeams(null); setDetail(null); setSelected(null); setDraft({ name: "", note: "", active: true }); setGrants({}); setGrantVersions({}); setDraftVersion(null);
      fence.current.invalidate(); listFence.current.invalidate();
      setBusy(false); setLoading(false);
    }
    setError(t("teamsAdmin.failed"));
  }, [t]);

  const load = useCallback(async (signal?: AbortSignal, before?: string) => {
    const generation = lifecycle.current.generation;
    const execution = listFence.current.begin();
    const page = await request<{ items: Team[]; next_cursor: string | null }>("TEAM_LIST", { limit: 50, ...(before ? { before } : {}) }, signal).catch(cause => { if (!listFence.current.isCurrent(execution)) throw new DOMException("Stale list", "AbortError"); throw cause; });
    if (!live(generation) || signal?.aborted || !listFence.current.isCurrent(execution)) return;
    setTeams(current => before && current ? [...current, ...page.items.filter(row => !current.some(item => item.id === row.id))] : page.items);
    setCursor(page.next_cursor); setDenied(false); setError(null);
  }, [live, request]);

  useEffect(() => {
    const state = lifecycle.current, list = listFence.current, selection = fence.current;
    state.mounted = true;
    return () => { state.mounted = false; state.generation++; list.invalidate(); selection.invalidate(); };
  }, []);
  useEffect(() => {
    if (hydratedStorage.current === storageKey) return;
    const timer = window.setTimeout(() => {
      hydratedStorage.current = storageKey;
      try { setPending(parseTeamRecovery(sessionStorage.getItem(storageKey))); setRecoveryReady(true); }
      catch { setRecoveryCorrupt(true); setError(t("teamsAdmin.corruptRecovery")); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey, t]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal).catch(cause => { if (!controller.signal.aborted) failure(cause); })
        .finally(() => { if (!controller.signal.aborted && lifecycle.current.mounted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [failure, load]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      if (error && selected === null && !busy && !pending && recoveryReady && !recoveryCorrupt) await load(signal);
      else await request("TEAM_LIST", { limit: 1 }, signal);
    } catch (cause) { if (!signal?.aborted) failure(cause); }
  }, [error, selected, busy, pending, recoveryReady, recoveryCorrupt, load, request, failure]);
  useVisibleRefresh(refresh);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || pending) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);

  const reload = async (before?: string) => {
    if (inFlight.current || !recoveryReady || recoveryCorrupt) return;
    const generation = lifecycle.current.generation;
    inFlight.current = true; setBusy(true); setLoading(true); setError(null);
    try { await load(undefined, before); } catch (cause) { failure(cause); }
    finally { if (live(generation)) { inFlight.current = false; setBusy(false); setLoading(false); } }
  };

  const open = async (id: string) => {
    if (inFlight.current || blocked || dirty && !window.confirm(t("teamsAdmin.discard"))) return;
    const generation = lifecycle.current.generation;
    const execution = fence.current.begin();
    inFlight.current = true;
    setSelected(id); setDetail(null); setGrants({}); setGrantVersions({}); setDraftVersion(null); setError(null); setNotice(null);
    if (id === "new") { inFlight.current = false; setDraft({ name: "", note: "", active: true }); return; }
    setBusy(true);
    try {
      const next = await request<Detail>("TEAM_SHOW", { team_id: id });
      if (!fence.current.isCurrent(execution)) return;
      setDetail(next); setDraftVersion(next.version); setDraft({ name: next.name, note: next.note, active: next.active });
    } catch (cause) { if (fence.current.isCurrent(execution)) failure(cause); }
    finally { if (live(generation)) { inFlight.current = false; setBusy(false); } }
  };

  const moreMembers = async () => {
    if (inFlight.current || !detail?.members_next_cursor || blocked) return;
    const generation = lifecycle.current.generation; inFlight.current = true;
    const execution = fence.current.begin(); const id = detail.id;
    setBusy(true);
    try {
      const page = await request<Detail>("TEAM_SHOW", { team_id: id, members_after: detail.members_next_cursor });
      if (fence.current.isCurrent(execution)) setDetail(current => current?.id === id ? { ...current, members_next_cursor: page.members_next_cursor, members: [...current.members, ...page.members.filter(member => !current.members.some(existing => existing.id === member.id))] } : current);
    } catch (cause) { if (fence.current.isCurrent(execution)) failure(cause); }
    finally { if (live(generation)) { inFlight.current = false; setBusy(false); } }
  };

  const finish = async (result: { state: string; team_id?: string }, intent = pending) => {
    const generation = lifecycle.current.generation;
    if (result.state !== "APPLIED" && result.state !== "CANCELLED") return;
    sessionStorage.removeItem(storageKey); setPending(null);
    if (result.state === "APPLIED" && result.team_id) {
      const next = await request<Detail>("TEAM_SHOW", { team_id: result.team_id });
      if (!live(generation)) return;
      setSelected(next.id); setDetail(next);
      if (intent?.kind !== "TEAM_GRANT_SAVE" || detail?.id !== next.id) { setDraft({ name: next.name, note: next.note, active: next.active }); setDraftVersion(next.version); }
      if (intent?.member_id) setGrants(current => { const remaining = { ...current }; delete remaining[intent.member_id!]; return remaining; });
      if (intent?.member_id) setGrantVersions(current => { const remaining = { ...current }; delete remaining[intent.member_id!]; return remaining; });
    }
    setNotice(t(result.state === "APPLIED" ? "teamsAdmin.saved" : "teamsAdmin.cancelled"));
    await load();
  };

  const mutate = async (kind: Intent["kind"], input: Record<string, unknown>) => {
    if (inFlight.current || blocked) return;
    const generation = lifecycle.current.generation;
    const intent: Intent = { operation_id: crypto.randomUUID(), kind, ...(detail ? { team_id: detail.id } : {}), ...(typeof input.member_id === "string" ? { member_id: input.member_id } : {}) };
    // Fail closed if reload-safe receipt identifiers cannot be persisted before dispatch.
    try { sessionStorage.setItem(storageKey, JSON.stringify(intent)); } catch { setError(t("teamsAdmin.storage")); return; }
    inFlight.current = true; setBusy(true); setPending(intent); setError(null); setNotice(null);
    let confirmed = false;
    try { const result = await request<{ state: string; team_id?: string }>(kind, { ...input, operation_id: intent.operation_id }); if (!live(generation)) return; confirmed = result.state === "APPLIED" || result.state === "CANCELLED"; await finish(result, intent); }
    catch (cause) { if (confirmed || (cause as { code?: string }).code === "REAUTHENTICATION_REQUIRED" || [401, 403].includes((cause as { status?: number }).status ?? 0)) failure(cause); else if (live(generation)) setError(t("teamsAdmin.unknown")); }
    finally { if (live(generation)) { inFlight.current = false; setBusy(false); } }
  };

  const reconcile = async (cancel: boolean) => {
    if (!pending || inFlight.current || !recoveryReady || recoveryCorrupt || denied) return;
    const generation = lifecycle.current.generation;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await request<{ state: string; team_id?: string }>("TEAM_RECEIPT", { operation_id: pending.operation_id, kind: pending.kind,
        ...(pending.team_id ? { team_id: pending.team_id } : {}), ...(pending.member_id ? { member_id: pending.member_id } : {}), cancel_if_missing: cancel });
      if (!live(generation)) return;
      if (result.state === "UNKNOWN") setError(t("teamsAdmin.unknown")); else await finish(result);
    } catch (cause) { failure(cause); }
    finally { if (live(generation)) { inFlight.current = false; setBusy(false); } }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void mutate(detail ? "TEAM_SAVE" : "TEAM_CREATE", { name: draft.name, note: draft.note,
      ...(detail ? { team_id: detail.id, expected_version: draftVersion, active: draft.active } : {}) });
  };
  const updateGrant = (member: Detail["members"][number], access: Access[]) => {
    setGrantVersions(current => ({ ...current, [member.id]: current[member.id] ?? member.version }));
    setGrants(current => ({ ...current, [member.id]: access }));
  };

  return <section className="panel" aria-labelledby="support-teams-heading" data-unsaved={dirty || undefined}>
    <div className="panel-heading"><div><h2 id="support-teams-heading">{t("teamsAdmin.title")}</h2><p>{t("teamsAdmin.body")}</p></div>{teams !== null ? <button type="button" className="button primary" disabled={blocked} onClick={() => void open("new")}>{t("teamsAdmin.createTeam")}</button> : null}</div>
    {error ? <div className={`settings-feedback error ${styles.feedback}`}>
      <p role="alert">{listUnavailable ? t("teamsAdmin.listFailed") : error}</p>
      <button type="button" className={listUnavailable ? "wx-button wx-button-primary" : "button secondary"} disabled={busy || !recoveryReady || recoveryCorrupt} onClick={() => void reload()}>{t("common.actions.retry")}</button>
    </div> : null}
    {reauthenticate ? <a className="button secondary wx-button" href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dteam">{t("tenant.privacy.action.reauthenticate")}</a> : null}
    {notice ? <p role="status" className="settings-feedback success">{notice}</p> : null}
    {pending ? <div className="settings-validation"><p>{t("teamsAdmin.unknown")}</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile(false)}>{t("teamsAdmin.check")}</button><button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile(true)}>{t("teamsAdmin.cancelMissing")}</button></div> : null}
    {owner ? <ServiceAccess execute={execute} scope={scope} teamId={detail?.id ?? null}/> : null}
    {teams === null && loading ? <div className={styles.workspace}><p role="status">{t("teamsAdmin.loading")}</p></div> : null}
    {teams !== null ? <div className={styles.workspace}>
      <nav aria-label={t("teamsAdmin.title")}><ul className={styles.list}>{teams.map(team => <li key={team.id}><button type="button" className="button secondary" aria-current={selected === team.id ? "true" : undefined} disabled={blocked} onClick={() => void open(team.id)}><bdi>{team.name}</bdi> · {t(team.active ? "teamsAdmin.active" : "teamsAdmin.archived")}</button></li>)}</ul>{loading ? <p role="status">{t("teamsAdmin.loading")}</p> : !teams.length ? <p>{t("teamsAdmin.empty")}</p> : null}{cursor ? <button type="button" className="button secondary" disabled={blocked} onClick={() => void reload(cursor)}>{t("teamsAdmin.more")}</button> : null}</nav>
      {selected === "new" || detail ? <div><form className="settings-form" onSubmit={save}><fieldset disabled={blocked || detail?.can_manage === false}><legend>{t(detail ? "teamsAdmin.edit" : "teamsAdmin.createTeam")}</legend><label>{t("teamsAdmin.name")}<input required maxLength={160} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/></label><label>{t("teamsAdmin.note")}<input maxLength={250} value={draft.note} onChange={event => setDraft(current => ({ ...current, note: event.target.value }))}/></label>{detail ? <label>{t("teamsAdmin.status")}<select value={draft.active ? "active" : "archived"} onChange={event => setDraft(current => ({ ...current, active: event.target.value === "active" }))}><option value="active">{t("teamsAdmin.active")}</option><option value="archived">{t("teamsAdmin.archived")}</option></select></label> : null}<button className="button primary" disabled={!draft.name.trim()}>{t("teamsAdmin.save")}</button></fieldset></form>
      {detail ? <section aria-labelledby="team-grants-heading"><h3 id="team-grants-heading">{t("teamsAdmin.access")}</h3><p>{t("teamsAdmin.inherited")}</p>{detail.members.map(member => {
        const value = grants[member.id] ?? member.direct_access;
        return <form key={member.id} className={styles.member} onSubmit={event => { event.preventDefault(); void mutate("TEAM_GRANT_SAVE", { team_id: detail.id, member_id: member.id, expected_version: grantVersions[member.id] ?? member.version, access: value }); }}><fieldset disabled={blocked || !detail.can_grant || !member.editable}><legend><bdi>{member.name}</bdi></legend><p><bdi>{member.email}</bdi></p><p>{t("teamsAdmin.effective")}: {member.effective_access.length ? member.effective_access.map(item => t(`teamsAdmin.${item}`)).join(" · ") : t("teamsAdmin.none")}</p><label className="check"><input type="checkbox" checked={value.includes("full")} onChange={event => updateGrant(member, event.target.checked ? ["full"] : [])}/>{t("teamsAdmin.full")}</label>{(["read", "create", "change", "overview"] as const).map(access => <label className="check" key={access}><input type="checkbox" checked={value.includes("full") || value.includes(access)} disabled={value.includes("full")} onChange={event => updateGrant(member, event.target.checked ? [...value, access] : value.filter(item => item !== access))}/>{t(`teamsAdmin.${access}`)}</label>)}<button className="button secondary" disabled={!grants[member.id]}>{t("teamsAdmin.saveAccess")}</button></fieldset></form>;
      })}{detail.members_next_cursor ? <button type="button" className="button secondary" disabled={blocked} onClick={() => void moreMembers()}>{t("teamsAdmin.moreMembers")}</button> : null}</section> : null}</div> : <p>{t("teamsAdmin.choose")}</p>}
    </div> : null}
  </section>;
}
