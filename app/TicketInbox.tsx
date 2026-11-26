"use client";

/* Additive ticket controls; all authorization and durable mutation handling stay in Inbox. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AttachmentFilePicker } from "./AttachmentFilePicker";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import { formatNumber } from "../lib/i18n/format";
import { useI18n } from "./I18nProvider";
import "./TicketInbox.css";

import type { InboxUpload as TicketUpload, InboxUploadConstraints as UploadConstraints, InboxCreateOptions as CreateOptions, InboxCreateInput as CreateTicketInput, InboxArticleContent as FullArticlePage, InboxCompletenessContract as TicketCompletenessContract } from "../lib/inbox-contract";

export function filesFitTicketPolicy(existing: TicketUpload[], files: File[], limits: UploadConstraints) {
  return existing.length + files.length <= limits.maximum_files
    && existing.reduce((sum, item) => sum + item.bytes, 0) + files.reduce((sum, item) => sum + item.size, 0) <= limits.maximum_total_bytes
    && files.every(file => file.size <= limits.maximum_file_bytes && (limits.accepted === null || limits.accepted.some(rule => rule.mime_type === file.type && file.size <= rule.maximum_bytes)));
}
export function validTicketArticlePage(page: FullArticlePage, articleId: string, offset: number, total: number, sha256: string) {
  const end = offset + Array.from(page.body).length;
  return page.article_id === articleId && page.total_characters === total && page.body_sha256 === sha256 && /^[a-f0-9]{64}$/u.test(sha256) && end <= total
    && Array.from(page.body).length <= 50_000 && (page.next_offset === null ? end === total : page.next_offset === end && end > offset);
}

// Reuse this same picker inside the existing reply composer and the create form.
// Main's binary helper serializes single-file staging and retains each acknowledged item.
export function TicketAttachmentPicker({ id, files, limits, disabled, upload, remove }: {
  id: string; files: TicketUpload[]; limits: UploadConstraints | null; disabled: boolean;
  upload: (files: File[]) => Promise<void>; remove: (file: TicketUpload) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true), working = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (work: () => Promise<void>) => {
    if (working.current || disabled) return;
    working.current = true; setPending(true); setError(null);
    try { await work(); } catch { if (mounted.current) setError(t("ticketExtras.attachmentFailed")); }
    finally { working.current = false; if (mounted.current) setPending(false); }
  };
  return <div className="wx-ticket-attachments">
    {limits && (limits.accepted === null || limits.accepted.length) ? <AttachmentFilePicker id={id} disabled={disabled || pending} empty={!files.length && !pending}
      accept={limits.accepted?.map(rule => rule.mime_type).join(",")} onSelect={selected => {
        if (!filesFitTicketPolicy(files, selected, limits)) { setError(t("ticketExtras.filesRejected")); return; }
        void run(() => upload(selected));
      }} /> : <p>{t("ticketExtras.attachmentsUnavailable")}</p>}
    {files.length ? <ul>{files.map(file => <li key={file.id}><bdi>{file.name}</bdi><span>{formatNumber(file.bytes, locale)} {t("ticketExtras.bytes")}</span>
      <button type="button" className="wx-button wx-button-secondary" disabled={disabled || pending} onClick={() => void run(() => remove(file))}>{t("ticketExtras.removeFile", { filename: file.name })}</button></li>)}</ul> : null}
    {pending ? <p role="status">{t("ticketExtras.staging")}</p> : null}{error ? <p role="alert">{error}</p> : null}
  </div>;
}

export function TicketTeamPicker({ id, teams, value, disabled, change }: {
  id: string; teams: { id: string; name: string }[]; value: string; disabled: boolean; change: (teamId: string) => void;
}) {
  const { t } = useI18n();
  return <label htmlFor={id}>{t("ticketExtras.team")}<select id={id} value={value} disabled={disabled} onChange={event => change(event.target.value)}>
    <option value="">{t("ticketExtras.chooseTeam")}</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
  </select></label>;
}

export function FullTicketArticle({ ticketId, articleId, body, bodySha256, complete, totalCharacters, scope, read }: {
  ticketId: string; articleId: string; body: string; bodySha256: string; complete: boolean; totalCharacters: number; scope: string;
  read: (input: TicketCompletenessContract["ARTICLE_CONTENT"]["input"], signal: AbortSignal) => Promise<FullArticlePage>;
}) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState<{ key: string; body: string; next: number | null; total: number } | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const key = `${scope}:${ticketId}:${articleId}:${bodySha256}:${complete}`;
  const active = useRef(key); useLayoutEffect(() => { active.current = key; }, [key]);
  const request = useRef<AbortController | null>(null), working = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => { setPending(false); setError(null); }, 0);
    return () => { clearTimeout(timer); request.current?.abort(); working.current = false; };
  }, [key]);
  const value = expanded?.key === key ? expanded : { key, body, next: complete ? null : Array.from(body).length, total: totalCharacters };
  const more = async () => {
    if (working.current || value.next === null) return;
    working.current = true; setPending(true); setError(null);
    const controller = new AbortController(); request.current = controller;
    try {
      const page = await read({ ticket_id: ticketId, article_id: articleId, offset: value.next, limit: 50_000, expected_sha256: bodySha256 }, controller.signal);
      if (controller.signal.aborted || active.current !== key) return;
      if (!validTicketArticlePage(page, articleId, value.next, value.total, bodySha256)) throw new Error();
      setExpanded({ key, body: value.body + page.body, next: page.next_offset, total: page.total_characters });
    } catch { if (!controller.signal.aborted && active.current === key) setError(t("ticketExtras.articleFailed")); }
    finally { if (!controller.signal.aborted && active.current === key) { working.current = false; setPending(false); } }
  };
  return <div className="wx-ticket-full-article"><p dir="auto">{value.body}</p>
    {value.next !== null ? <><p>{t("ticketExtras.articleProgress", { shown: formatNumber(Array.from(value.body).length, locale), total: formatNumber(value.total, locale) })}</p>
      <button type="button" className="wx-button wx-button-secondary" disabled={pending} onClick={() => void more()}>{t(pending ? "ticketExtras.loading" : "ticketExtras.readMore")}</button></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}

export function NewTicketDialog({ close, loadOptions, submit, blocked, busy, error, recoveryActions, renderAttachments, attachmentIds, formId, recoveryState, groupChanged }: {
  close: () => void;
  loadOptions: (input: TicketCompletenessContract["CREATE_OPTIONS"]["input"], signal: AbortSignal) => Promise<CreateOptions>;
  submit: (input: CreateTicketInput) => Promise<"APPLIED" | "UNKNOWN" | "REJECTED">;
  blocked: boolean; busy: boolean; error: string | null; recoveryActions: ReactNode;
  renderAttachments: (groupId: string, disabled: boolean, limits: UploadConstraints | null) => ReactNode;
  groupChanged: (groupId: string) => void; attachmentIds: string[]; formId: string | null;
  recoveryState: "APPLIED" | "UNKNOWN" | "NOT_APPLIED" | null;
}) {
  const { t } = useI18n();
  const [options, setOptions] = useState<CreateOptions | null>(null), [loading, setLoading] = useState(true);
  const [group, setGroup] = useState(""), [customer, setCustomer] = useState(""), [query, setQuery] = useState("");
  const [customerMode, setCustomerMode] = useState<"existing" | "new">("existing");
  const [newCustomerEmail, setNewCustomerEmail] = useState(""), [newCustomerName, setNewCustomerName] = useState("");
  const [owner, setOwner] = useState(""), [state, setState] = useState(""), [title, setTitle] = useState(""), [body, setBody] = useState("");
  const [internal, setInternal] = useState(true), [uncertain, setUncertain] = useState(false), [localError, setLocalError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  const disabled = blocked || busy || uncertain || loading;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const timer = setTimeout(() => { if (recoveryState === "NOT_APPLIED") setUncertain(false); if (recoveryState === "APPLIED") close(); }, 0);
    return () => clearTimeout(timer);
  }, [recoveryState, close]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { setLoading(true); setLocalError(null); void loadOptions({ ...(group ? { group_id: group } : {}), ...(query.trim().length >= 2 ? { query: query.trim() } : {}) }, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setOptions(value); setOwner(old => value.owners.some(item => item.id === old) ? old : "");
        setState(old => value.states.some(item => item.id === old) ? old : value.states.find(item => !item.closed)?.id ?? "");
        if (!value.channels.email) setInternal(true);
      }).catch(() => { if (!controller.signal.aborted) { setOptions(null); setLocalError(t("ticketExtras.optionsFailed")); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [group, query, loadOptions, t]);
  const selectedCustomer = options?.customers.find(item => item.id === customer);
  const customerEmail = customerMode === "new" ? newCustomerEmail.trim() : selectedCustomer?.email;
  const customerReady = customerMode === "new" ? Boolean(newCustomerEmail.trim()) : Boolean(selectedCustomer);
  const dirty = Boolean(title || body || customer || newCustomerEmail || newCustomerName || attachmentIds.length);
  const requestClose = () => { if (busy || pending.current) return; if (dirty || uncertain) setConfirmClose(true); else close(); };
  return <ModalDialog className="wx-ticket-create" data-unsaved={dirty || uncertain || undefined} aria-labelledby="wx-ticket-create-title" close={requestClose}>
    <h2 id="wx-ticket-create-title">{t("ticketExtras.newTicket")}</h2>
    <form onSubmit={event => {
      event.preventDefault(); if (pending.current || disabled || !options?.can_create || !customerReady || !group || !state || !title.trim() || (!body.trim() && !attachmentIds.length)) return;
      if (!internal && (!options.channels.email || !customerEmail)) return;
      pending.current = true;
      // Native chooses sender/type/routing; browser supplies only the exact acknowledged staging set.
      const input: CreateTicketInput = { operation_id: crypto.randomUUID(), title, group_id: group,
        ...(customerMode === "existing" ? { customer_id: selectedCustomer!.id } : { customer: { email: newCustomerEmail.trim(), ...(newCustomerName.trim() ? { name: newCustomerName.trim() } : {}) } }),
        state_id: state, body, internal, ...(owner ? { owner_id: owner } : {}), ...(formId ? { form_id: formId, attachment_ids: [...attachmentIds] } : {}) };
      void submit(input).then(result => {
        if (!mounted.current) return;
        if (result === "APPLIED") close();
        else if (result === "UNKNOWN") setUncertain(true);
      }).catch(() => { if (mounted.current) setUncertain(true); })
        .finally(() => { pending.current = false; });
    }}>
      <TicketTeamPicker id="wx-ticket-create-team" teams={options?.groups ?? []} value={group} disabled={busy || blocked || uncertain || attachmentIds.length > 0} change={value => { setLoading(true); setGroup(value); setCustomer(""); groupChanged(value); }} />
      {attachmentIds.length ? <p>{t("ticketExtras.removeBeforeTeamChange")}</p> : null}
      <label htmlFor="wx-ticket-customer-mode">{t("ticketExtras.customer")}<select id="wx-ticket-customer-mode" value={customerMode} disabled={disabled} onChange={event => setCustomerMode(event.target.value as "existing" | "new")}>
        <option value="existing">{t("ticketExtras.existingCustomer")}</option><option value="new">{t("ticketExtras.firstContact")}</option>
      </select></label>
      {customerMode === "existing" ? <><label htmlFor="wx-ticket-customer-query">{t("ticketExtras.findCustomer")}<input id="wx-ticket-customer-query" type="search" maxLength={160} value={query} disabled={busy || blocked || uncertain} onChange={event => { setLoading(true); setQuery(event.target.value); setCustomer(""); }} /></label>
      <label htmlFor="wx-ticket-customer">{t("ticketExtras.customer")}<select id="wx-ticket-customer" required value={customer} disabled={disabled} onChange={event => setCustomer(event.target.value)}>
        <option value="">{t("ticketExtras.chooseCustomer")}</option>{options?.customers.map(item => <option value={item.id} key={item.id}>{item.name}{item.email ? ` · ${item.email}` : ""}</option>)}
      </select></label></> : <><label htmlFor="wx-ticket-new-email">{t("ticketExtras.customerEmail")}<input id="wx-ticket-new-email" type="email" autoComplete="email" required maxLength={320} value={newCustomerEmail} disabled={disabled} onChange={event => setNewCustomerEmail(event.target.value)} /></label>
        <label htmlFor="wx-ticket-new-name">{t("ticketExtras.customerName")}<input id="wx-ticket-new-name" autoComplete="name" maxLength={100} value={newCustomerName} disabled={disabled} onChange={event => setNewCustomerName(event.target.value)} /></label></>}
      <label htmlFor="wx-ticket-title">{t("ticketExtras.subject")}<input id="wx-ticket-title" required maxLength={200} value={title} disabled={disabled} onChange={event => setTitle(event.target.value)} /></label>
      <label htmlFor="wx-ticket-mode">{t("ticketExtras.messageKind")}<select id="wx-ticket-mode" value={internal ? "note" : "email"} disabled={disabled} onChange={event => setInternal(event.target.value === "note")}>
        <option value="note" disabled={!options?.channels.note}>{t("ticketExtras.internalNote")}</option>
        <option value="email" disabled={!options?.channels.email || !customerEmail}>{t("ticketExtras.emailCustomer")}</option>
      </select></label>
      {!internal && customerEmail ? <p>{t("ticketExtras.emailRecipient", { email: customerEmail })}</p> : null}
      <label htmlFor="wx-ticket-create-owner">{t("ticketExtras.owner")}<select id="wx-ticket-create-owner" value={owner} disabled={disabled} onChange={event => setOwner(event.target.value)}>
        <option value="">{t("ticketExtras.unassigned")}</option>{options?.owners.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label htmlFor="wx-ticket-create-state">{t("ticketExtras.state")}<select id="wx-ticket-create-state" required value={state} disabled={disabled} onChange={event => setState(event.target.value)}>
        <option value="">{t("ticketExtras.chooseState")}</option>{options?.states.map(item => <option key={item.id} value={item.id}>{t(item.closed ? "ticketExtras.closed" : "ticketExtras.open")}</option>)}
      </select></label>
      <label htmlFor="wx-ticket-create-body">{t("ticketExtras.message")}<textarea id="wx-ticket-create-body" dir="auto" rows={6} maxLength={4096} required={!attachmentIds.length} value={body} disabled={disabled} onChange={event => setBody(event.target.value)} /></label>
      {renderAttachments(group, disabled || !group, options?.upload_constraints ?? null)}
      {loading ? <p role="status">{t("ticketExtras.loading")}</p> : null}
      {!loading && !options?.can_create ? <p>{t("ticketExtras.createUnavailable")}</p> : null}
      {localError || error ? <p role="alert">{localError || error}</p> : null}
      {uncertain || blocked ? <div role="status"><p>{t("ticketExtras.createUnknown")}</p>{recoveryActions}</div> : null}
      <div className="wx-ticket-create-actions"><button type="button" className="wx-button wx-button-secondary" disabled={busy} onClick={requestClose}>{t("ticketExtras.cancel")}</button>
        <button className="wx-button wx-button-primary" disabled={disabled || !options?.can_create || !group || !customerReady || !state}>{t(internal ? "ticketExtras.createNoteTicket" : "ticketExtras.createEmailTicket")}</button></div>
    </form>
    {confirmClose ? <InlineConfirmation cancel={() => setConfirmClose(false)} aria-label={t("ticketExtras.closeDraft")}>
      <p>{t(uncertain || blocked ? "ticketExtras.closeUnknownHelp" : "ticketExtras.closeDraftHelp")}</p>
      <div className="wx-ticket-create-actions"><button type="button" data-inline-confirm-initial-focus className="wx-button wx-button-secondary" onClick={() => setConfirmClose(false)}>{t("ticketExtras.keepDraft")}</button>
        <button type="button" className="wx-button wx-button-primary" onClick={close}>{t("ticketExtras.closeDraft")}</button></div>
    </InlineConfirmation> : null}
  </ModalDialog>;
}
