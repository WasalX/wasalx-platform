"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "./I18nProvider";
import { useVisibleRefresh } from "./use-visible-refresh";
import { createLatestRequestFence } from "../lib/operator-ui";
import type { MailboxConfig, MailboxExecute, MailboxRow } from "../lib/mailbox-contract";

type Receipt = { state: "APPLIED" | "CANCELLED" | "UNKNOWN"; mailbox_id?: string };
type Intent = { operation_id: string; kind: string; mailbox_id?: string; team_id?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function isIntent(value: unknown): value is Intent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.operation_id !== "string" || !UUID.test(row.operation_id) || typeof row.kind !== "string" || !/^MAILBOX_(CREATE|SAVE|VERIFY_START|VERIFY_RECHECK|ACTIVATE|PAUSE|SIGNATURE_SAVE)$/u.test(row.kind)) return false;
  const target = row.kind === "MAILBOX_CREATE" ? null : row.kind === "MAILBOX_SIGNATURE_SAVE" ? "team_id" : "mailbox_id";
  return Object.keys(row).sort().join(",") === (target ? ["operation_id", "kind", target] : ["operation_id", "kind"]).sort().join(",") && (!target || typeof row[target] === "string" && /^[1-9][0-9]{0,15}$/u.test(row[target] as string));
}
export function parseMailboxRecovery(raw: string | null): Intent | null {
  if (raw === null) return null;
  if (raw.length > 1024) throw new Error("Oversized recovery identifiers");
  const value: unknown = JSON.parse(raw);
  if (!isIntent(value)) throw new Error("Invalid recovery identifiers");
  return value;
}

const empty = (team_id: string): MailboxConfig => ({ email: "", name: "", team_id,
  inbound: { host: "", port: 993, user: "", folder: "INBOX", security: "TLS" },
  outbound: { host: "", port: 587, user: "", security: "STARTTLS" } });

export function MailboxSettings({ execute, scope, teams }: { execute: MailboxExecute; scope: string; teams: Array<{ id: string; name: string }> }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<MailboxRow[]>([]);
  const [selected, setSelected] = useState<MailboxRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<MailboxConfig>(() => empty(teams[0]?.id ?? ""));
  const [passwords, setPasswords] = useState({ inbound: "", outbound: "" });
  const [pending, setPending] = useState<Intent | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<{ team_id: string; version: string; body: string; requires_plain_replacement: boolean } | null>(null);
  const [signatureDraft, setSignatureDraft] = useState("");
  const [replaceFormatting, setReplaceFormatting] = useState(false);
  const [recoveryCorrupt, setRecoveryCorrupt] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [canCreate, setCanCreate] = useState(false);
  const [mailReady, setMailReady] = useState(false);
  const active = useRef(false);
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
  const listFence = useRef(createLatestRequestFence());
  const selectionFence = useRef(createLatestRequestFence());
  const storageKey = `wasalx:mailbox-operation:${scope}`;
  const dirty = editing && (JSON.stringify(config) !== JSON.stringify(selected?.config ?? empty(teams[0]?.id ?? "")) || Boolean(passwords.inbound || passwords.outbound)) || Boolean(signature && signatureDraft !== signature.body);
  const disabled = busy || Boolean(pending) || recoveryCorrupt || !recoveryReady || denied;
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  const failure = useCallback((cause: unknown) => {
    if (!lifecycle.current.mounted || cause instanceof DOMException && cause.name === "AbortError") return;
    if ((cause as { code?: string } | null)?.code === "REAUTHENTICATION_REQUIRED") {
      setReauthenticate(true); setError(t("mailboxes.failed")); return;
    }
    if ([401, 403].includes((cause as { status?: number } | null)?.status ?? 0)) {
      lifecycle.current.generation++; active.current = false; setDenied(true); setBusy(false); setLoading(false); setCursor(null); setCanCreate(false); setMailReady(false);
      listFence.current.invalidate(); selectionFence.current.invalidate();
      setRows([]); setSelected(null); setConfig(empty("")); setSignature(null); setSignatureDraft(""); setEditing(false); setPasswords({ inbound: "", outbound: "" });
    }
    setError(t("mailboxes.failed"));
  }, [t]);
  const load = useCallback(async (signal?: AbortSignal, before?: string) => {
    const generation = lifecycle.current.generation;
    const execution = listFence.current.begin();
    const result = await request<{ items: MailboxRow[]; next_cursor: string | null; can_create: boolean; mail_ready: boolean }>("MAILBOX_LIST", before ? { before } : {}, signal).catch(cause => { if (!listFence.current.isCurrent(execution)) throw new DOMException("Stale list", "AbortError"); throw cause; });
    if (live(generation) && !signal?.aborted && listFence.current.isCurrent(execution)) { setRows(current => before ? [...current, ...result.items.filter(row => !current.some(existing => existing.id === row.id))] : result.items); setCursor(result.next_cursor); setCanCreate(result.can_create); setMailReady(result.mail_ready); setDenied(false); }
  }, [live, request]);
  useEffect(() => {
    const state = lifecycle.current, list = listFence.current, selection = selectionFence.current;
    state.mounted = true;
    return () => { state.mounted = false; state.generation++; list.invalidate(); selection.invalidate(); };
  }, []);
  useEffect(() => {
    if (hydratedStorage.current === storageKey) return;
    const timer = window.setTimeout(() => {
      hydratedStorage.current = storageKey;
      try { setPending(parseMailboxRecovery(sessionStorage.getItem(storageKey))); setRecoveryReady(true); }
      catch { setRecoveryCorrupt(true); setError(t("mailboxes.corruptRecovery")); }
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
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty || pending) event.preventDefault(); }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty, pending]);

  const reload = async (before?: string) => {
    if (active.current || !recoveryReady || recoveryCorrupt) return;
    const generation = lifecycle.current.generation;
    active.current = true; setBusy(true); setLoading(true); setError(null);
    try { await load(undefined, before); } catch (cause) { failure(cause); }
    finally { if (live(generation)) { active.current = false; setBusy(false); setLoading(false); } }
  };

  const open = async (row: MailboxRow | null) => {
    if (active.current || disabled || dirty && !window.confirm(t("mailboxes.discard"))) return;
    const generation = lifecycle.current.generation;
    const execution = selectionFence.current.begin();
    active.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      const next = row ? await request<MailboxRow>("MAILBOX_SHOW", { mailbox_id: row.id }) : null;
      if (!selectionFence.current.isCurrent(execution)) return;
      setSelected(next); setConfig(next?.config ?? empty(teams[0]?.id ?? "")); setPasswords({ inbound: "", outbound: "" }); setEditing(true); setSignature(null); setReplaceFormatting(false);
    } catch (cause) { if (selectionFence.current.isCurrent(execution)) failure(cause); } finally { if (live(generation)) { active.current = false; setBusy(false); } }
  };
  const mutate = async (kind: Intent["kind"], input: Record<string, unknown>) => {
    if (active.current || disabled) return;
    const generation = lifecycle.current.generation;
    const intent: Intent = { kind, operation_id: crypto.randomUUID(), ...(kind === "MAILBOX_SIGNATURE_SAVE" ? { team_id: String(input.team_id) } : selected ? { mailbox_id: selected.id } : {}) };
    try { sessionStorage.setItem(storageKey, JSON.stringify(intent)); } catch { setError(t("mailboxes.storage")); return; }
    active.current = true; setBusy(true); setPending(intent); setError(null);
    let confirmed = false;
    try {
      const result = await request<Receipt>(kind as Parameters<MailboxExecute>[0], { ...input, operation_id: intent.operation_id });
      if (!live(generation)) return;
      if (result.state !== "APPLIED") throw new Error("unconfirmed");
      confirmed = true;
      sessionStorage.removeItem(storageKey); setPending(null); setMessage(t("mailboxes.saved"));
      setPasswords({ inbound: "", outbound: "" });
      await load();
      if (!live(generation)) return;
      if (result.mailbox_id) { const row = await request<MailboxRow>("MAILBOX_SHOW", { mailbox_id: result.mailbox_id }); if (!live(generation)) return; setSelected(row); setConfig(row.config); }
      if (kind === "MAILBOX_SIGNATURE_SAVE") {
        const next = await request<{ team_id: string; version: string; body: string; requires_plain_replacement: boolean }>("MAILBOX_SIGNATURE_SHOW", { team_id: input.team_id });
        if (!live(generation)) return;
        setSignature(next); setSignatureDraft(next.body); setReplaceFormatting(false);
      }
    } catch (cause) { if (confirmed || (cause as { code?: string }).code === "REAUTHENTICATION_REQUIRED" || [401, 403].includes((cause as { status?: number }).status ?? 0)) failure(cause); else if (live(generation)) { setPasswords({ inbound: "", outbound: "" }); setError(t("mailboxes.unknown")); } }
    finally { if (live(generation)) { active.current = false; setBusy(false); } }
  };
  const reconcile = async (cancel = false) => {
    if (!pending || active.current || !recoveryReady || recoveryCorrupt || denied) return;
    const generation = lifecycle.current.generation;
    active.current = true; setBusy(true);
    try {
      const result = await request<Receipt>("MAILBOX_RECEIPT", { ...pending, cancel_if_missing: cancel });
      if (!live(generation)) return;
      if (result.state !== "APPLIED" && result.state !== "CANCELLED") { setError(t("mailboxes.unknown")); return; }
      sessionStorage.removeItem(storageKey); setPending(null); setError(null); setMessage(t(result.state === "APPLIED" ? "mailboxes.saved" : "mailboxes.cancelled")); await load();
      if (!live(generation)) return;
      if (result.state === "APPLIED" && result.mailbox_id) {
        const row = await request<MailboxRow>("MAILBOX_SHOW", { mailbox_id: result.mailbox_id });
        if (!live(generation)) return;
        setSelected(row); setConfig(row.config); setEditing(true); setPasswords({ inbound: "", outbound: "" });
      }
      if (result.state === "APPLIED" && pending.kind === "MAILBOX_SIGNATURE_SAVE") {
        const next = await request<{ team_id: string; version: string; body: string; requires_plain_replacement: boolean }>("MAILBOX_SIGNATURE_SHOW", { team_id: pending.team_id });
        if (!live(generation)) return;
        setSignature(next); setSignatureDraft(next.body); setReplaceFormatting(false);
      }
    } catch (cause) { failure(cause); } finally { if (live(generation)) { active.current = false; setBusy(false); } }
  };
  useVisibleRefresh(async signal => {
    try { await request("MAILBOX_LIST", {}, signal); }
    catch (cause) { if (!signal?.aborted) failure(cause); }
  });
  useVisibleRefresh(async signal => {
    if (active.current || !selected || selected.verification !== "RUNNING" || dirty) return;
    const execution = selectionFence.current.begin();
    try { const row = await request<MailboxRow>("MAILBOX_VERIFY_STATUS", { mailbox_id: selected.id, operation_id: selected.verification_operation_id }, signal); if (!signal?.aborted && selectionFence.current.isCurrent(execution) && !dirtyRef.current) { setSelected(row); await load(signal); } }
    catch (cause) { if (!signal?.aborted && selectionFence.current.isCurrent(execution)) failure(cause); }
  }, !disabled);
  const openSignature = async () => {
    if (!selected || active.current || disabled || dirty) return;
    const generation = lifecycle.current.generation, execution = selectionFence.current.begin();
    active.current = true; setBusy(true); setError(null);
    try {
      const value = await request<{ team_id: string; version: string; body: string; requires_plain_replacement: boolean }>("MAILBOX_SIGNATURE_SHOW", { team_id: selected.config.team_id });
      if (selectionFence.current.isCurrent(execution)) { setSignature(value); setSignatureDraft(value.body); setReplaceFormatting(false); }
    } catch (cause) { if (selectionFence.current.isCurrent(execution)) failure(cause); }
    finally { if (live(generation)) { active.current = false; setBusy(false); } }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void mutate(selected ? "MAILBOX_SAVE" : "MAILBOX_CREATE", { config,
      ...(selected ? { mailbox_id: selected.id, expected_version: selected.version } : {}),
      credentials: { ...(passwords.inbound ? { inbound: passwords.inbound } : {}), ...(passwords.outbound ? { outbound: passwords.outbound } : {}) } });
  };
  const fields = (direction: "inbound" | "outbound") => <fieldset disabled={disabled || Boolean(selected?.active) || selected?.editable === false}><legend>{t(direction === "inbound" ? "mailboxes.inbound" : "mailboxes.outbound")}</legend>
    <label>{t("mailboxes.host")}<input required value={config[direction].host} maxLength={253} autoComplete="off" onChange={event => setConfig(current => ({ ...current, [direction]: { ...current[direction], host: event.target.value } }))}/></label>
    <label>{t("mailboxes.port")}<input required type="number" min={1} max={65535} value={config[direction].port} onChange={event => setConfig(current => ({ ...current, [direction]: { ...current[direction], port: Number(event.target.value) } }))}/></label>
    <label>{t("mailboxes.security")}<select value={config[direction].security} onChange={event => setConfig(current => ({ ...current, [direction]: { ...current[direction], security: event.target.value as "TLS" | "STARTTLS" } }))}><option value="TLS">TLS</option><option value="STARTTLS">STARTTLS</option></select></label>
    <label>{t("mailboxes.user")}<input required value={config[direction].user} maxLength={320} autoComplete="off" onChange={event => setConfig(current => ({ ...current, [direction]: { ...current[direction], user: event.target.value } }))}/></label>
    <label>{t("mailboxes.password")}<input type="password" autoComplete="new-password" maxLength={4096} value={passwords[direction]} required={!selected || !(direction === "inbound" ? selected.inbound_credential_configured : selected.outbound_credential_configured)} onChange={event => setPasswords(current => ({ ...current, [direction]: event.target.value }))}/><small>{t("mailboxes.passwordHelp")}</small></label>
    {direction === "inbound" ? <label>{t("mailboxes.folder")}<input required maxLength={255} value={config.inbound.folder} onChange={event => setConfig(current => ({ ...current, inbound: { ...current.inbound, folder: event.target.value } }))}/></label> : null}
  </fieldset>;
  return <section className="panel" aria-labelledby="mailboxes-heading" data-unsaved={dirty || undefined}><div className="panel-heading"><div><h2 id="mailboxes-heading">{t("mailboxes.title")}</h2><p>{t("mailboxes.body")}</p></div><button type="button" className="button primary" disabled={disabled || !canCreate} onClick={() => void open(null)}>{t("mailboxes.create")}</button></div>
    {!canCreate && !loading ? <p role="status">{t("mailboxes.setupRequired")}</p> : null}{!mailReady && !loading ? <p role="status">{t("mailboxes.templateReview")}</p> : null}{error ? <><p className="settings-feedback error" role="alert">{error}</p><button type="button" className="button secondary" disabled={busy || !recoveryReady || recoveryCorrupt} onClick={() => void reload()}>{t("inbox.reload")}</button></> : null}{reauthenticate ? <a className="button secondary wx-button" href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dsettings">{t("tenant.privacy.action.reauthenticate")}</a> : null}{message ? <p className="settings-feedback success" role="status">{message}</p> : null}{pending ? <div className="settings-validation"><p>{t("mailboxes.unknown")}</p><button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile()}>{t("mailboxes.check")}</button><button type="button" className="button secondary" disabled={busy} onClick={() => void reconcile(true)}>{t("mailboxes.cancelMissing")}</button></div> : null}
    {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- list-style:none can hide list semantics in Safari/VoiceOver. */}
    <ul className="mailbox-list" role="list">{rows.map(row => <li key={row.id}><button type="button" className="button secondary" disabled={disabled} onClick={() => open(row)}><bdi>{row.config.email}</bdi> · {t(row.active ? "mailboxes.active" : "mailboxes.paused")}</button><span>{t(`mailboxes.verification.${row.verification}`)}</span></li>)}</ul>{loading ? <p role="status">{t("mailboxes.loading")}</p> : !rows.length ? <p>{t("mailboxes.empty")}</p> : null}{cursor ? <button type="button" className="button secondary" disabled={disabled} onClick={() => void reload(cursor)}>{t("mailboxes.more")}</button> : null}
    {editing ? <><form className="settings-form" onSubmit={submit}><fieldset disabled={disabled || Boolean(selected?.active) || selected?.editable === false}><legend>{t(selected ? "mailboxes.edit" : "mailboxes.create")}</legend><label>{t("mailboxes.address")}<input required type="email" maxLength={320} value={config.email} onChange={event => setConfig(current => ({ ...current, email: event.target.value }))}/></label><label>{t("mailboxes.name")}<input required maxLength={160} value={config.name} onChange={event => setConfig(current => ({ ...current, name: event.target.value }))}/></label><label>{t("mailboxes.team")}<select required value={config.team_id} onChange={event => setConfig(current => ({ ...current, team_id: event.target.value }))}><option value="">{t("mailboxes.chooseTeam")}</option>{selected && !teams.some(team => team.id === selected.config.team_id) ? <option value={selected.config.team_id}>{selected.team_name || t("mailboxes.currentTeam")}</option> : null}{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label></fieldset>{fields("inbound")}{fields("outbound")}<button className="button primary" disabled={disabled || Boolean(selected?.active) || selected?.editable === false}>{t("mailboxes.saveDraft")}</button></form>
    {selected ? <div className="save-bar"><p>{selected.active ? t("mailboxes.pauseHelp") : t("mailboxes.verifyHelp")}</p><div className="settings-actions"><button type="button" className="button secondary" disabled={disabled || dirty || selected.active || !selected.editable || selected.verification === "RUNNING"} onClick={() => void mutate("MAILBOX_VERIFY_START", { mailbox_id: selected.id, expected_version: selected.version })}>{t("mailboxes.verify")}</button>{selected.verification === "UNKNOWN" ? <button type="button" className="button secondary" disabled={disabled || dirty} onClick={() => void mutate("MAILBOX_VERIFY_RECHECK", { mailbox_id: selected.id, expected_version: selected.version })}>{t("mailboxes.recheck")}</button> : null}<button type="button" className="button primary" disabled={disabled || dirty || !selected.active && (!mailReady || !selected.editable || selected.verification !== "VERIFIED" || selected.verification_version !== selected.version)} onClick={() => void mutate(selected.active ? "MAILBOX_PAUSE" : "MAILBOX_ACTIVATE", { mailbox_id: selected.id, expected_version: selected.version })}>{t(selected.active ? "mailboxes.pause" : "mailboxes.activate")}</button><button type="button" className="button secondary" disabled={disabled || dirty} onClick={() => void openSignature()}>{t("mailboxes.signature")}</button></div></div> : null}
    </> : null}
    {signature ? <form className="settings-form" onSubmit={event => { event.preventDefault(); void mutate("MAILBOX_SIGNATURE_SAVE", { team_id: signature.team_id, expected_version: signature.version, body: signatureDraft, replace_formatting: replaceFormatting }); }}><label>{t("mailboxes.signature")}<textarea rows={5} maxLength={4000} value={signatureDraft} disabled={disabled} onChange={event => setSignatureDraft(event.target.value)}/><small>{t("mailboxes.signatureHelp")}</small></label>{signature.requires_plain_replacement ? <label className="check"><input type="checkbox" checked={replaceFormatting} disabled={disabled} onChange={event => setReplaceFormatting(event.target.checked)}/>{t("mailboxes.replaceFormatting")}</label> : null}<button className="button primary" disabled={disabled || signature.body === signatureDraft || signature.requires_plain_replacement && !replaceFormatting}>{t("mailboxes.saveSignature")}</button></form> : null}
  </section>;
}
