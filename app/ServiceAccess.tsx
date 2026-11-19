"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "./I18nProvider";
import { ModalDialog } from "./ModalDialog";
import { useVisibleRefresh } from "./use-visible-refresh";
import { identityTerminal, parseIdentityRecovery, type IdentityExecute, type IdentityIntent, type IdentityKind, type IdentityReceipt, type IdentityStatus, type IdentityTeam } from "../lib/service-access-contract";

type Review = { kind: IdentityKind; status: IdentityStatus; team?: IdentityTeam };
export function ServiceAccess({ execute, scope, teamId }: { execute: IdentityExecute; scope: string; teamId: string | null }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [pending, setPending] = useState<IdentityIntent | null>(null);
  const [ready, setReady] = useState(false), [broken, setBroken] = useState(false), [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<"failed" | "unknown" | "storage" | "corrupt" | null>(null);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [review, setReview] = useState<Review | null>(null), [acknowledged, setAcknowledged] = useState(false), [enabled, setEnabled] = useState(false);
  const lifecycle = useRef({ mounted: false, generation: 0, request: 0, busy: false });
  const executor = useRef(execute);
  useLayoutEffect(() => { executor.current = execute; }, [execute]);
  const key = `wasalx:identity-operation:${scope}`;
  const live = (generation: number) => lifecycle.current.mounted && lifecycle.current.generation === generation;
  const failure = useCallback((cause: unknown) => {
    if (!lifecycle.current.mounted || cause instanceof DOMException && cause.name === "AbortError") return;
    const problem = cause as { status?: number; code?: string };
    if (problem.code === "REAUTHENTICATION_REQUIRED") { setReauthenticate(true); setError("failed"); return; }
    if (problem.status === 401 || problem.status === 403) {
      lifecycle.current.generation++; lifecycle.current.busy = false; setBusy(false); setStatus(null); setReview(null); setAcknowledged(false); setDenied(true);
    }
    setError("failed");
  }, []);
  const load = useCallback(async (signal?: AbortSignal, after?: string) => {
    const generation = lifecycle.current.generation, request = ++lifecycle.current.request;
    const value = await executor.current<IdentityStatus>("IDENTITY_STATUS", after ? { teams_after: after } : {}, signal).catch(cause => {
      if (!live(generation) || signal?.aborted || request !== lifecycle.current.request) throw new DOMException("Stale service-access read", "AbortError");
      throw cause;
    });
    if (!live(generation) || signal?.aborted || request !== lifecycle.current.request) return;
    setStatus(current => after && current && current.status_version === value.status_version ? { ...value, groups: [...current.groups, ...value.groups.filter(row => !current.groups.some(item => item.id === row.id))] } : value);
    setDenied(false); setError(current => current === "corrupt" || current === "storage" ? current : null); setReauthenticate(false);
  }, []);
  useEffect(() => {
    const state = lifecycle.current; state.mounted = true; state.generation++;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setReady(false); setBroken(false); setReview(null); setStatus(null); setDenied(false); setPending(null);
      try { setPending(parseIdentityRecovery(sessionStorage.getItem(key))); setReady(true); }
      catch { setBroken(true); setError("corrupt"); }
      void load(controller.signal).catch(cause => { if (!controller.signal.aborted) failure(cause); });
    }, 0);
    return () => { state.mounted = false; state.generation++; controller.abort(); window.clearTimeout(timer); };
  }, [key, load, failure]);
  useVisibleRefresh(signal => load(signal).catch(cause => { if (!signal?.aborted) failure(cause); }), ready && !review && !pending && !busy && !denied);
  const reload = async (after?: string) => {
    if (lifecycle.current.busy) return;
    const generation = lifecycle.current.generation; lifecycle.current.busy = true; setBusy(true);
    try { await load(undefined, after); } catch (cause) { if (live(generation)) failure(cause); }
    finally { if (live(generation)) { lifecycle.current.busy = false; setBusy(false); } }
  };
  const finish = async (receipt: IdentityReceipt) => {
    if (!identityTerminal(receipt)) { setError("unknown"); return; }
    try { sessionStorage.removeItem(key); } catch { setBroken(true); setError("storage"); return; }
    setPending(null); setReview(null); setAcknowledged(false); await load();
  };
  const reconcile = async (cancel: boolean) => {
    if (!pending || lifecycle.current.busy || !ready || broken || denied) return;
    const generation = lifecycle.current.generation; lifecycle.current.busy = true; setBusy(true);
    try {
      const receipt = await executor.current<IdentityReceipt>("IDENTITY_RECEIPT", { ...pending, action: cancel ? "CANCEL_IF_UNADMITTED" : "LOOKUP" });
      if (live(generation)) await finish(receipt);
    } catch (cause) { if (live(generation)) failure(cause); }
    finally { if (live(generation)) { lifecycle.current.busy = false; setBusy(false); } }
  };
  const mutate = async () => {
    if (!review || !acknowledged || lifecycle.current.busy || pending || !ready || broken || denied) return;
    const generation = lifecycle.current.generation;
    const intent: IdentityIntent = { request_id: crypto.randomUUID(), kind: review.kind, ...(review.team ? { team_id: review.team.id } : {}) };
    try { sessionStorage.setItem(key, JSON.stringify(intent)); } catch { setError("storage"); return; }
    const input = review.kind === "IDENTITY_INITIALIZE" ? { request_id: intent.request_id, expected_status_version: review.status.status_version }
      : review.team ? { request_id: intent.request_id, team_id: review.team.id, expected_version: review.team.version, enabled }
      : { request_id: intent.request_id, operation_id: review.status.operation_id ?? crypto.randomUUID(), expected_status_version: review.status.status_version, ...(review.kind === "IDENTITY_COMPLETE" ? { retire_legacy: true } : {}) };
    lifecycle.current.busy = true; setBusy(true); setPending(intent); setError(null);
    try { const receipt = await executor.current<IdentityReceipt>(review.kind, input); if (live(generation)) await finish(receipt); }
    catch (cause) {
      if (!live(generation)) return;
      const problem = cause as { status?: number; code?: string };
      if (problem.code === "REAUTHENTICATION_REQUIRED" || problem.status === 401 || problem.status === 403) failure(cause); else setError("unknown");
    } finally { if (live(generation)) { lifecycle.current.busy = false; setBusy(false); } }
  };
  const open = (kind: IdentityKind, team?: IdentityTeam) => {
    if (!status || busy || pending || !ready || broken || denied) return;
    setReview({ kind, status, team }); setEnabled(team?.enabled ?? false); setAcknowledged(false); setError(null);
  };
  const blocked = busy || Boolean(pending) || !ready || broken || denied;
  const team = status?.groups.find(row => row.id === teamId);
  const close = () => { if (!busy) { setReview(null); setAcknowledged(false); } };
  return <section className="settings-section" aria-labelledby="service-access-title">
    <div className="panel-heading"><div><h3 id="service-access-title">{t("serviceAccess.title")}</h3><p>{t("serviceAccess.body")}</p></div><button type="button" className="button secondary" disabled={busy} onClick={() => void reload()}>{t("common.actions.refresh")}</button></div>
    {error ? <p role="alert" className="settings-feedback error">{t(`serviceAccess.${error}`)}</p> : null}
    {reauthenticate ? <a className="button secondary wx-button" href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dteam">{t("tenant.privacy.action.reauthenticate")}</a> : null}
    {pending && !review ? <div className="settings-validation"><p>{t("serviceAccess.unknown")}</p><button type="button" className="button secondary" disabled={busy || denied || broken} onClick={() => void reconcile(false)}>{t("serviceAccess.check")}</button><button type="button" className="button secondary" disabled={busy || denied || broken} onClick={() => void reconcile(true)}>{t("serviceAccess.cancelMissing")}</button></div> : null}
    {status ? <><p role="status">{t(status.portal_ready === true && status.access_required === false ? "serviceAccess.ready" : `serviceAccess.phase.${status.phase}`)}</p>
      {status.can_initialize ? <div className="save-bar"><p>{t("serviceAccess.initializeHelp")}</p><button type="button" className="button primary" disabled={blocked} onClick={() => open("IDENTITY_INITIALIZE")}>{t("serviceAccess.initialize")}</button></div> : null}
      {(!status.portal_ready || status.access_required) && !status.can_initialize && status.mode === "FRESH" ? <p>{t("serviceAccess.fresh")}</p> : null}
      {status.mode === "LEGACY" && status.legacy_member ? <p>{t("serviceAccess.legacyMember")}: <bdi>{status.legacy_member.name}</bdi> · <bdi dir="ltr">{status.legacy_member.email}</bdi></p> : null}
      {status.mode === "LEGACY" ? <div className="save-bar"><p>{t("serviceAccess.legacy")}</p><div className="settings-actions">{status.can_prepare ? <button type="button" className="button secondary" disabled={blocked} onClick={() => open("IDENTITY_PREPARE")}>{t("serviceAccess.prepare")}</button> : null}{status.can_bind ? <button type="button" className="button primary" disabled={blocked} onClick={() => open("IDENTITY_BIND")}>{t("serviceAccess.bind")}</button> : null}{status.can_complete ? <button type="button" className="button secondary" disabled={blocked || !status.legacy_retirement_ready} onClick={() => open("IDENTITY_COMPLETE")}>{t("serviceAccess.complete")}</button> : null}{status.phase === "BOUND" && !status.legacy_retirement_ready ? <p>{t("serviceAccess.removeLegacyFirst")}</p> : null}</div></div> : null}
      {team ? <div className="save-bar"><div className="settings-summary"><b><bdi>{team.name}</bdi></b><p>{t(team.enabled ? "serviceAccess.granted" : "serviceAccess.notGranted")}</p></div><button type="button" className="button secondary" disabled={blocked || !team.active} onClick={() => open("IDENTITY_GRANT", team)}>{t("serviceAccess.reviewGrant")}</button></div> : teamId ? <p>{t("serviceAccess.teamUnavailable")}</p> : <p>{t("serviceAccess.chooseTeam")}</p>}
      {status.groups_next_cursor ? <button type="button" className="button secondary" disabled={busy} onClick={() => void reload(status.groups_next_cursor!)}>{t("serviceAccess.more")}</button> : null}
    </> : !error ? <p role="status">{t("teamsAdmin.loading")}</p> : null}
    {review ? <ModalDialog close={close} className="modal-backdrop" aria-labelledby="service-access-review"><form className="modal team-dialog service-access-review" data-unsaved={acknowledged || undefined} onSubmit={event => { event.preventDefault(); void mutate(); }}><div className="modal-head"><h2 id="service-access-review">{t(review.kind === "IDENTITY_INITIALIZE" ? "serviceAccess.initialize" : review.kind === "IDENTITY_GRANT" ? "serviceAccess.reviewGrant" : review.kind === "IDENTITY_COMPLETE" ? "serviceAccess.complete" : review.kind === "IDENTITY_BIND" ? "serviceAccess.bind" : "serviceAccess.prepare")}</h2><button type="button" disabled={busy} aria-label={t("tenant.team.invite.close")} onClick={close}>×</button></div>
      <p>{t(review.kind === "IDENTITY_INITIALIZE" ? "serviceAccess.initializeDetail" : review.kind === "IDENTITY_GRANT" ? "serviceAccess.grantDetail" : review.kind === "IDENTITY_COMPLETE" ? "serviceAccess.completeDetail" : review.kind === "IDENTITY_BIND" ? "serviceAccess.bindDetail" : "serviceAccess.prepareDetail")}</p>
      {review.team ? <><p><bdi>{review.team.name}</bdi></p><label className="check" htmlFor="service-team-enabled"><input id="service-team-enabled" type="checkbox" checked={enabled} disabled={blocked} onChange={event => { setEnabled(event.target.checked); setAcknowledged(false); }}/>{t("serviceAccess.fullTeamAccess")}</label></> : null}
      <label className="check" htmlFor="service-access-confirm"><input id="service-access-confirm" type="checkbox" checked={acknowledged} disabled={blocked} onChange={event => setAcknowledged(event.target.checked)}/>{t("serviceAccess.confirm")}</label>
      {error ? <p role="alert" className="settings-feedback error">{t(`serviceAccess.${error}`)}</p> : null}
      {reauthenticate ? <a className="button secondary wx-button" href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dteam">{t("tenant.privacy.action.reauthenticate")}</a> : null}
      {pending ? <div className="settings-validation"><p role="status">{t("serviceAccess.unknown")}</p><button type="button" className="button secondary" disabled={busy || denied || broken} onClick={() => void reconcile(false)}>{t("serviceAccess.check")}</button><button type="button" className="button secondary" disabled={busy || denied || broken} onClick={() => void reconcile(true)}>{t("serviceAccess.cancelMissing")}</button></div> : null}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>{t("tenant.team.actions.cancel")}</button><button className="button primary" disabled={blocked || !acknowledged || Boolean(review.team && enabled === review.team.enabled)}>{t("serviceAccess.apply")}</button></div>
    </form></ModalDialog> : null}
  </section>;
}
