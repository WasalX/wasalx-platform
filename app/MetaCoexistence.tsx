"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MetaCoexistenceContactView, MetaCoexistenceMessageView, MetaCoexistencePage, MetaCoexistenceSummary } from "../lib/meta-coexistence-contract";
import { localizedUiError } from "../lib/ui-error";
import { createLatestRequestFence } from "../lib/operator-ui";
import { useI18n } from "./I18nProvider";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./MetaCoexistence.module.css";

type Props = { connectionId: string; mutationHeaders: Record<string, string> };
export function MetaCoexistence(props: Props) {
  return <CoexistenceSession key={`${props.connectionId}:${props.mutationHeaders["x-wasalx-csrf"] ?? ""}`} {...props} />;
}

function CoexistenceSession({ connectionId, mutationHeaders }: Props) {
  const { t, locale } = useI18n();
  const base = `/api/connections/${encodeURIComponent(connectionId)}/meta/coexistence`;
  const [summary, setSummary] = useState<MetaCoexistenceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [contacts, setContacts] = useState<MetaCoexistencePage<MetaCoexistenceContactView> | null>(null);
  const [thread, setThread] = useState<MetaCoexistenceContactView | null>(null);
  const [messages, setMessages] = useState<MetaCoexistencePage<MetaCoexistenceMessageView> | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const alive = useRef(false), reading = useRef(false), writing = useRef(false), authorityLost = useRef(false);
  const summaryFence = useRef(createLatestRequestFence()), contentFence = useRef(createLatestRequestFence());
  const focusThread = useRef<HTMLHeadingElement>(null);
  const focusContacts = useRef<HTMLHeadingElement>(null);

  async function request<T>(path = "", body?: unknown, signal?: AbortSignal): Promise<T> {
    const deadline = AbortSignal.timeout(15_000);
    const response = await fetch(`${base}${path}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...mutationHeaders }, body: JSON.stringify(body) }) });
    if (!response.ok) {
      const value: unknown = await response.json().catch(() => null);
      const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
        && /^[A-Z_]{1,80}$/u.test(value.code) ? value.code : undefined;
      throw Object.assign(new Error("META_COEXISTENCE_REQUEST_FAILED"), { status: response.status, code });
    }
    return response.json() as Promise<T>;
  }

  function clearContent() {
    contentFence.current.invalidate(); reading.current = false;
    setContentLoading(false); setContentError(null); setContacts(null); setMessages(null); setThread(null);
  }

  function denied(failure: unknown) {
    if (!failure || typeof failure !== "object" || !("status" in failure) || ![401, 403].includes(Number(failure.status))) return false;
    authorityLost.current = true; summaryFence.current.invalidate();
    clearContent(); setSummary(null); setConfirmStop(false); setLoading(false);
    setError(localizedUiError(locale, failure).message);
    return true;
  }

  async function readSummary(signal?: AbortSignal) {
    if (writing.current) return;
    const version = summaryFence.current.begin();
    const isCurrent = () => !signal?.aborted && summaryFence.current.isCurrent(version);
    try {
      const result = await request<MetaCoexistenceSummary | null>("", undefined, signal);
      if (!isCurrent()) return;
      authorityLost.current = false;
      setSummary(previous => result && previous && previous.revision > result.revision ? previous : result);
      if (!result) clearContent();
      if (result && !result.consent.history && !result.consent.contacts && !result.consent.echoes) setUncertain(false);
      setError(null);
    } catch (failure) {
      if (!isCurrent()) return;
      if (denied(failure)) return;
      if (failure && typeof failure === "object" && "status" in failure && failure.status === 404) { clearContent(); setSummary(null); setError(null); }
      else setError(localizedUiError(locale, failure).message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  // The keyed session owns the exact connection and authenticated context, so the first read runs once per lifetime.
  const readOnMount = useEffectEvent(readSummary);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(), summaryLoads = summaryFence.current, contentLoads = contentFence.current;
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return readOnMount(controller.signal);
    });
    return () => { alive.current = false; summaryLoads.invalidate(); contentLoads.invalidate(); controller.abort(); };
  }, []);

  // Summary-only refresh preserves the open reader and never repeats a consent write.
  useVisibleRefresh(readSummary, !stopping);

  async function loadContacts(cursor?: string) {
    if (reading.current || writing.current || authorityLost.current || !summary) return;
    reading.current = true;
    const version = contentFence.current.begin(), isCurrent = () => contentFence.current.isCurrent(version);
    setContentLoading(true); setContentError(null); setThread(null); setMessages(null);
    try {
      const result = await request<MetaCoexistencePage<MetaCoexistenceContactView>>(`/contacts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!isCurrent()) return;
      setContacts(previous => ({ ...result, items: cursor && previous ? [...previous.items, ...result.items] : result.items }));
    } catch (failure) {
      if (isCurrent() && !denied(failure)) setContentError(localizedUiError(locale, failure).message);
    } finally {
      if (isCurrent()) { reading.current = false; setContentLoading(false); }
    }
  }

  async function loadMessages(contact: MetaCoexistenceContactView, cursor?: string) {
    if (reading.current || writing.current || authorityLost.current || !summary) return;
    reading.current = true;
    const version = contentFence.current.begin(), isCurrent = () => contentFence.current.isCurrent(version);
    setThread(contact); if (!cursor) setMessages(null);
    setContentLoading(true); setContentError(null);
    try {
      const result = await request<MetaCoexistencePage<MetaCoexistenceMessageView>>(`/threads/${encodeURIComponent(contact.threadId)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!isCurrent()) return;
      setMessages(previous => ({ ...result, items: cursor && previous ? [...previous.items, ...result.items] : result.items }));
      if (!cursor) requestAnimationFrame(() => { if (isCurrent()) focusThread.current?.focus(); });
    } catch (failure) {
      if (isCurrent() && !denied(failure)) setContentError(localizedUiError(locale, failure).message);
    } finally {
      if (isCurrent()) { reading.current = false; setContentLoading(false); }
    }
  }

  function refresh() {
    if (writing.current) return;
    setLoading(true); setConfirmStop(false);
    void readSummary();
  }

  async function stop() {
    if (!summary || !confirmStop || writing.current || authorityLost.current || uncertain || loading) return;
    writing.current = true; summaryFence.current.invalidate(); contentFence.current.invalidate(); reading.current = false;
    setContentLoading(false); setContacts(null); setMessages(null); setThread(null);
    setStopping(true); setError(null);
    try {
      const result = await request<MetaCoexistenceSummary>("/consent", { expectedRevision: summary.revision, history: false, contacts: false, echoes: false });
      if (!alive.current) return;
      setSummary(result); setConfirmStop(false); setUncertain(false);
    } catch (failure) {
      if (alive.current) {
        if (!denied(failure)) setError(localizedUiError(locale, failure).message);
        // A definite rejection (for example a stale revision) leaves capture unchanged; only an unknown outcome locks the stop action.
        const status = failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : 0;
        if (status >= 400 && status < 500 && status !== 408) queueMicrotask(() => void readSummary()); else setUncertain(true);
      }
    } finally {
      if (alive.current) { writing.current = false; setStopping(false); }
    }
  }

  if (!summary && !error) return null; // Ordinary Meta connections have no import context.
  const stamp = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : t("tenant.metaCoexistence.unknown");
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const captureActive = summary && (summary.consent.history || summary.consent.contacts || summary.consent.echoes);
  return <section className={`connection-detail-section ${styles.section}`} aria-labelledby="meta-coexistence-title" aria-busy={loading || stopping}>
    <div className="connection-detail-section-head"><div><h3 id="meta-coexistence-title">{t("tenant.metaCoexistence.title")}</h3><p>{t("tenant.metaCoexistence.intro")}</p></div></div>
    {error ? <p role="alert">{error}</p> : null}
    {uncertain ? <p role="status">{t("tenant.metaCoexistence.checkSaved")}</p> : null}
    {summary ? <>
      <dl className={styles.facts}>
        <div><dt>{t("tenant.metaCoexistence.contactsRequest")}</dt><dd>{t(`tenant.metaCoexistence.request.${summary.contactsRequest}`)}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.historyRequest")}</dt><dd>{t(`tenant.metaCoexistence.request.${summary.historyRequest}`)}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.observation")}</dt><dd>{t(`tenant.metaCoexistence.observation.${summary.historyObservation}`)}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.capture")}</dt><dd>{t(captureActive ? "tenant.metaCoexistence.captureOn" : "tenant.metaCoexistence.captureOff")}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.contactsCount")}</dt><dd>{number(summary.contactCount)}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.messagesCount")}</dt><dd>{number(summary.messageCount)}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.chunksCount")}</dt><dd>{number(summary.processedChunks)}</dd></div>
        <div><dt>{t("tenant.metaCoexistence.lastActivity")}</dt><dd>{summary.lastActivityAt ? stamp(summary.lastActivityAt) : t("tenant.metaCoexistence.notObserved")}</dd></div>
      </dl>
      <p>{t("tenant.metaCoexistence.countsHelp")}</p>
      {summary.providerProgress !== null ? <p>{t("tenant.metaCoexistence.providerProgress", { value: number(summary.providerProgress) })}</p> : null}
      <p>{t(summary.windowEvidence === "TIMESTAMP_OBSERVED" ? "tenant.metaCoexistence.windowObserved" : "tenant.metaCoexistence.windowUnknown")}</p>
      {summary.holdReason ? <p role="status">{t(`tenant.metaCoexistence.hold.${summary.holdReason}`)}</p> : null}
      {captureActive ? <div className={styles.stop}>
        <label><input type="checkbox" checked={confirmStop} disabled={loading || stopping || uncertain} onChange={event => setConfirmStop(event.target.checked)} /> <span>{t("tenant.metaCoexistence.stopConfirm")}</span></label>
        <p>{t("tenant.metaCoexistence.stopHelp")}</p>
        <button className="button secondary" type="button" disabled={!confirmStop || loading || stopping || uncertain} onClick={() => void stop()}>{t(stopping ? "tenant.metaCoexistence.stopping" : "tenant.metaCoexistence.stop")}</button>
      </div> : null}
    </> : null}
    <div className={styles.actions}>
      <button type="button" className="button secondary" disabled={loading || stopping} onClick={refresh}>{t("tenant.metaCoexistence.refresh")}</button>
      {summary && !contacts ? <button type="button" className="button secondary" disabled={contentLoading || loading || stopping} onClick={() => void loadContacts()}>{t("tenant.metaCoexistence.view")}</button> : null}
    </div>
    {contentLoading ? <p role="status">{t("tenant.metaCoexistence.loading")}</p> : null}
    {contentError ? <p role="alert">{contentError}</p> : null}
    {contacts && !thread ? <div>
      <h4 ref={focusContacts} tabIndex={-1}>{t("tenant.metaCoexistence.conversations")}</h4>
      {contacts.items.length ? <ul className={styles.contacts}>{contacts.items.map(contact => <li key={contact.threadId}>
        <button className="button secondary" type="button" disabled={contentLoading || stopping} onClick={() => void loadMessages(contact)}><bdi>{contact.name ?? contact.phone}</bdi>{contact.name ? <bdi dir="ltr">{contact.phone}</bdi> : null}</button>
        {contact.removed ? <small>{t("tenant.metaCoexistence.removed")}</small> : null}
      </li>)}</ul> : <p>{t("tenant.metaCoexistence.emptyContacts")}</p>}
      {contacts.nextCursor ? <button type="button" className="button secondary" disabled={contentLoading || stopping} onClick={() => void loadContacts(contacts.nextCursor!)}>{t("tenant.metaCoexistence.more")}</button> : null}
    </div> : null}
    {thread ? <div>
      <h4 ref={focusThread} tabIndex={-1}><bdi>{thread.name ?? thread.phone}</bdi></h4>
      <p>{t("tenant.metaCoexistence.readOnly")}</p>
      <button type="button" className="button secondary" disabled={stopping} onClick={() => { contentFence.current.invalidate(); reading.current = false; setContentLoading(false); setThread(null); setMessages(null); setContentError(null);
        requestAnimationFrame(() => { if (alive.current) focusContacts.current?.focus(); }); }}>
        {t("tenant.metaCoexistence.back")}
      </button>
      {messages && !messages.items.length ? <p>{t("tenant.metaCoexistence.emptyMessages")}</p> : null}
      {messages?.items.length ? <ol className={styles.messages}>{messages.items.map(message => <li key={message.id}>
        <div className={styles.messageMeta}><span>{t(`tenant.metaCoexistence.direction.${message.direction}`)}</span><span>{t(`tenant.metaCoexistence.source.${message.source}`)}</span><time dateTime={message.timestamp}>{stamp(message.timestamp)}</time></div>
        {message.text ? <p dir="auto">{message.text}</p> : null}
        {message.media !== "NOT_APPLICABLE" ? <p>{t("tenant.metaCoexistence.mediaPlaceholder")}</p> : !message.text ? <p>{t("tenant.metaCoexistence.noText")}</p> : null}
      </li>)}</ol> : null}
      {messages?.nextCursor ? <button type="button" className="button secondary" disabled={contentLoading || stopping} onClick={() => void loadMessages(thread, messages.nextCursor!)}>{t("tenant.metaCoexistence.more")}</button> : null}
    </div> : null}
  </section>;
}
