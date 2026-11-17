"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { ModalDialog } from "./ModalDialog";
import { useVisibleRefresh } from "./use-visible-refresh";
import { operatorFailureMessage, createLatestRequestFence, operatorResponseFailure, type CodedOperatorError } from "../lib/operator-ui";
import type { NativeAccountObservation } from "../lib/control-plane-data";
import { NativeAccountStatus } from "./NativeAccountStatus";

type Member = { user_id: string; display_name: string; email: string };
type Projection = { user_id: string; revision: string | number; applied_revision?: string | number; native_user_id?: string | null; sync_state: string; member_state: string; nativeObservation?: NativeAccountObservation };
type State = { enabled: boolean; available?: boolean; members: Projection[] };
type Candidate = { id: string; name: string; email: string; active: boolean };
type Failure = { message: string; code?: string };
type ObservationMember = { user_id: string; nativeObservation?: NativeAccountObservation };

export function WorkspaceAccess({ members, owner, mutationHeaders, nativeObservations, nativeObservationUnavailable, beginNativeObservationRead, completeNativeObservationRead }: {
  members: Member[]; owner: boolean; mutationHeaders: Record<string, string>;
  nativeObservations: Record<string, NativeAccountObservation | undefined>;
  nativeObservationUnavailable: boolean;
  beginNativeObservationRead: () => number;
  completeNativeObservationRead: (request: number, members: ObservationMember[] | null) => void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enable, setEnable] = useState(false);
  const [selected, setSelected] = useState<Projection | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidateId, setCandidateId] = useState("");
  const [prerequisite, setPrerequisite] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const fence = useRef(createLatestRequestFence());
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = fence.current.begin();
    const observationRequest = beginNativeObservationRead();
    try {
      const response = await fetch("/api/team/workspace-access", { cache: "no-store", signal });
      if (!response.ok) throw new Error();
      const next = await response.json() as State;
      if (!signal?.aborted && fence.current.isCurrent(request)) { setState(next); setError(false); completeNativeObservationRead(observationRequest, next.members); return next; }
    } catch { if (!signal?.aborted && fence.current.isCurrent(request)) { setError(true); completeNativeObservationRead(observationRequest, null); } }
    return null;
  }, [beginNativeObservationRead, completeNativeObservationRead]);
  // Role changes, suspensions and removals re-queue synchronization, so re-read whenever the team list reloads.
  useEffect(() => { const controller = new AbortController(); const guard = fence.current; const timer = window.setTimeout(() => void load(controller.signal), 0); return () => { window.clearTimeout(timer); controller.abort(); guard.invalidate(); }; }, [load, members]);
  useVisibleRefresh(async signal => { await load(signal); }, !busy && !enable && !selected);
  const close = () => { if (busy) return; setEnable(false); setSelected(null); setCandidates(null); setCandidateId(""); setAcknowledged(false); setPrerequisite(""); setFailure(null); };
  const fail = (cause: unknown) => setFailure({ message: operatorFailureMessage(cause, t("tenant.workspaceAccess.error")), code: (cause as Partial<CodedOperatorError> | null)?.code });
  const mutate = async () => {
    if (busy) return;
    setBusy(true); setFailure(null); setNotice(null);
    try {
      const body = enable ? { action: "enable" } : { action: "reconcile", userId: selected?.user_id, expectedRevision: Number(selected?.revision), adoptUserId: candidateId || undefined, prerequisiteChange: prerequisite.trim() || undefined };
      const response = await fetch("/api/team/workspace-access", { method: "POST", headers: mutationHeaders, body: JSON.stringify(body) });
      if (!response.ok) throw await operatorResponseFailure(response, t("tenant.workspaceAccess.error"));
      setNotice(t(enable ? "tenant.workspaceAccess.enabled" : "tenant.workspaceAccess.requested"));
      setEnable(false); setSelected(null); setCandidates(null); setAcknowledged(false); setCandidateId(""); setPrerequisite(""); await load();
    } catch (cause) {
      fail(cause);
      // A stale revision is rejected; refresh it so the reviewed action can be applied again without losing the owner's input.
      const next = await load();
      const row = selected ? next?.members.find(item => item.user_id === selected.user_id) : undefined;
      if (row) setSelected(row);
    } finally { setBusy(false); }
  };
  const review = async (row: Projection) => {
    setSelected(row); setCandidates(null); setCandidateId(""); setAcknowledged(false); setPrerequisite(""); setFailure(null); setNotice(null);
    if (row.sync_state !== "ADOPTION_REQUIRED") return;
    setBusy(true);
    try {
      const response = await fetch(`/api/team/workspace-access?userId=${encodeURIComponent(row.user_id)}`, { cache: "no-store" });
      if (!response.ok) throw await operatorResponseFailure(response, t("tenant.workspaceAccess.error"));
      const result = await response.json() as { candidates: Candidate[] }; setCandidates(result.candidates);
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  };
  const person = (id: string) => members.find(member => member.user_id === id);
  const states = new Set(["PENDING", "READY", "ADOPTION_REQUIRED", "CONFLICT", "PROTECTED", "UNAVAILABLE"]);
  const adoption = !enable && selected?.sync_state === "ADOPTION_REQUIRED";
  const ready = acknowledged && (enable || (adoption ? Boolean(candidateId) : prerequisite.trim().length >= 8));
  return <section className="panel team-members-panel" aria-labelledby="workspace-access-title">
    <div className="panel-heading"><div><h2 id="workspace-access-title">{t("tenant.workspaceAccess.title")}</h2><p>{t("tenant.workspaceAccess.body")}</p></div><button className="button small secondary" disabled={busy} onClick={() => void load()}>{t("tenant.team.actions.reload")}</button></div>
    <p className="team-access-note">{t("tenant.workspaceAccess.onboarding")}</p>
    {error && !enable && !selected ? <div className="settings-feedback error" role="alert"><span>!</span><p>{t("tenant.workspaceAccess.error")}</p></div> : null}
    {notice && !enable && !selected ? <div className="settings-feedback success" role="status"><span>✓</span><p>{notice}</p></div> : null}
    {!state ? error ? null : <p className="workspace-access-state" role="status">{t("tenant.team.loading")}</p> : !state.enabled ? <div className="workspace-access-state"><p>{t("tenant.workspaceAccess.disabled")}</p>{state.available === false ? <p>{t("tenant.workspaceAccess.unavailable")}</p> : owner ? <button className="button primary" onClick={() => { setAcknowledged(false); setFailure(null); setNotice(null); setEnable(true); }}>{t("tenant.workspaceAccess.enable")}</button> : <p>{t("tenant.workspaceAccess.ownerOnly")}</p>}</div> : !state.members.length ? <p className="workspace-access-state">{t("tenant.workspaceAccess.empty")}</p> : <ul className="team-invites">{state.members.map(row => <li key={row.user_id} className="team-invite"><div><b><bdi>{person(row.user_id)?.display_name ?? t("tenant.workspaceAccess.former")}</bdi></b>{person(row.user_id) ? <p><bdi dir="ltr">{person(row.user_id)?.email}</bdi></p> : null}<p>{t(`tenant.workspaceAccess.state.${states.has(row.sync_state) ? row.sync_state : "UNAVAILABLE"}`)}</p><NativeAccountStatus observation={row.sync_state === "READY" && Number(row.revision) === Number(row.applied_revision) ? nativeObservations[row.user_id] : undefined} expected={{revision:row.revision,nativeUserId:row.native_user_id ?? null}} unavailable={nativeObservationUnavailable}/>{row.member_state !== "ACTIVE" ? <p>{t("tenant.workspaceAccess.revoked")}</p> : null}</div>{owner && ["ADOPTION_REQUIRED", "CONFLICT", "UNAVAILABLE"].includes(row.sync_state) ? <button className="button small secondary" disabled={busy} onClick={() => void review(row)}>{t("tenant.workspaceAccess.review")}</button> : null}</li>)}</ul>}
    {enable || selected ? <ModalDialog className="modal-backdrop" close={close} aria-labelledby="workspace-access-review"><form className="modal team-dialog workspace-access-dialog" onSubmit={event => { event.preventDefault(); void mutate(); }}>
      <div className="modal-head"><div><h2 id="workspace-access-review">{t(enable ? "tenant.workspaceAccess.enable" : "tenant.workspaceAccess.review")}</h2>{selected ? <p><bdi>{person(selected.user_id)?.email ?? t("tenant.workspaceAccess.former")}</bdi></p> : null}</div><button type="button" disabled={busy} aria-label={t("tenant.team.invite.close")} onClick={close}>×</button></div>
      {enable ? <><p>{t("tenant.workspaceAccess.enableDetail")}</p><ul>{members.map(member => <li key={member.user_id}><bdi>{member.display_name} — {member.email}</bdi></li>)}</ul></> : adoption ? <><p>{t("tenant.workspaceAccess.adoptDetail")}</p><label htmlFor="workspace-account">{t("tenant.workspaceAccess.account")}<select id="workspace-account" required value={candidateId} disabled={busy || !candidates?.length} aria-describedby={candidates && !candidates.length ? "workspace-account-empty" : undefined} onChange={event => setCandidateId(event.target.value)}><option value="">{t(candidates ? "tenant.workspaceAccess.select" : "tenant.team.loading")}</option>{candidates?.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name} — {candidate.email} ({t(candidate.active ? "tenant.team.member.stateActive" : "tenant.team.member.stateSuspended")})</option>)}</select>{candidates && !candidates.length ? <small id="workspace-account-empty">{t("tenant.workspaceAccess.noCandidates")}</small> : null}</label></> : <label htmlFor="workspace-prerequisite">{t("tenant.workspaceAccess.prerequisite")}<textarea id="workspace-prerequisite" aria-describedby="workspace-prerequisite-help" required minLength={8} maxLength={240} disabled={busy} value={prerequisite} onChange={event => setPrerequisite(event.target.value)} /><small id="workspace-prerequisite-help">{t("tenant.workspaceAccess.noSecrets")}</small></label>}
      <label className="workspace-access-confirm"><input type="checkbox" required checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>{t("tenant.workspaceAccess.confirm")}</span></label>
      {failure ? <div className="settings-feedback error" role="alert"><span>!</span><p>{failure.message}</p>{failure.code === "REAUTHENTICATION_REQUIRED" ? <a className="button small secondary" href={`/auth/login?step_up=privileged&return_to=${encodeURIComponent("/app?view=team")}`}>{t("tenant.support.actions.reauthenticate")}</a> : null}</div> : null}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>{t("tenant.team.actions.cancel")}</button><button className="button primary" disabled={busy || !ready}>{t(busy ? "tenant.team.actions.saving" : "tenant.workspaceAccess.apply")}</button></div>
    </form></ModalDialog> : null}
  </section>;
}
