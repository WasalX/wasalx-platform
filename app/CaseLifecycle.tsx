"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatNumber, formatPastRelativeTime } from "../lib/i18n/format";
import { operatorFailureMessage, createLatestRequestFence, operatorResponseFailure } from "../lib/operator-ui";
import type { UiErrorCode } from "../lib/ui-error";
import { useI18n, useRelativeClock } from "./I18nProvider";
import { ModalDialog } from "./ModalDialog";
import { WideTable } from "./tenant-ui";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./CaseLifecycle.module.css";

type CaseRow = {
  id: string;
  normalized_reference: string;
  zammad_ticket_id: string;
  zammad_ticket_number: string;
  state: "OPEN" | "RESOLVED" | "DETACHED";
  generation: number | string;
  version: number | string;
  predecessor_correlation_id?: string | null;
  replaced_by_correlation_id?: string | null;
  group_name: string;
  provider: string;
  zammad_group_id: string;
  updated_at: string;
  detached_at?: string | null;
  zammad_agent_available?: boolean;
};
type MutationError = { message: string; code: UiErrorCode | null };

export function CaseLifecycle({
  canDetach,
  openTicket,
  mutationHeaders,
  targetTicketNumber = null,
}: {
  canDetach: boolean;
  openTicket?: (ticket: string) => void;
  mutationHeaders: Record<string, string>;
  targetTicketNumber?: string | null;
}) {
  const { direction, locale, t } = useI18n();
  const renderedAt = useRelativeClock();
  const normalizedTargetTicket = targetTicketNumber?.trim().replace(/^#/u, "") ?? "";
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [canLoadOlder, setCanLoadOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(normalizedTargetTicket);
  const [state, setState] = useState<"ALL" | CaseRow["state"]>("ALL");
  const [selected, setSelected] = useState<CaseRow | null>(null);
  const [operationKey, setOperationKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<MutationError | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const previousTargetTicket = useRef(normalizedTargetTicket);
  const loadFence = useRef(createLatestRequestFence());

  useEffect(() => {
    if (previousTargetTicket.current === normalizedTargetTicket) return;
    previousTargetTicket.current = normalizedTargetTicket;
    setQuery(normalizedTargetTicket);
  }, [normalizedTargetTicket]);

  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    const request = loadFence.current.begin();
    const isCurrent = () => !signal?.aborted && loadFence.current.isCurrent(request);
    if (!background) setLoading(true);
    setError(null);
    try {
      const responses = await Promise.all([
        fetch("/api/cases?limit=200", { cache: "no-store", signal }),
        normalizedTargetTicket ? fetch(`/api/cases?limit=200&ticket=${encodeURIComponent(normalizedTargetTicket)}`, { cache: "no-store", signal }) : null,
      ]);
      for (const response of responses) if (response && !response.ok) throw await operatorResponseFailure(response, t("cases.errors.request", { status: response.status }), locale);
      const page = await responses[0].json() as CaseRow[];
      const exact = responses[1] ? await responses[1].json() as CaseRow[] : [];
      if (!isCurrent()) return;
      const next = [...exact, ...page.filter((row) => !exact.some((item) => item.id === row.id))];
      setRows((current) => background ? [...next, ...current.filter((row) => !next.some((item) => item.id === row.id))] : next);
      if (!background) setCanLoadOlder(page.length === 200);
    } catch (loadError) {
      // A failed background refresh keeps the visible list; only a foreground load replaces it with the error state.
      if (isCurrent() && !background) setError(operatorFailureMessage(loadError, t("cases.errors.load")));
    } finally {
      if (!background && isCurrent()) setLoading(false);
    }
  }, [locale, normalizedTargetTicket, t]);

  useEffect(() => {
    const fence = loadFence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(false, controller.signal), 0);
    return () => { controller.abort(); window.clearTimeout(timer); fence.invalidate(); };
  }, [load]);
  useVisibleRefresh((signal) => load(true, signal), !pending);

  const loadOlder = async () => {
    const cursor = rows.at(-1)?.id;
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const response = await fetch(`/api/cases?limit=200&before=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!response.ok) throw await operatorResponseFailure(response, t("cases.errors.request", { status: response.status }), locale);
      const next = await response.json() as CaseRow[];
      setRows((current) => [...current, ...next.filter((row) => !current.some((item) => item.id === row.id))]);
      setCanLoadOlder(next.length === 200);
    } catch (loadError) {
      setOlderError(operatorFailureMessage(loadError, t("cases.errors.load")));
    } finally {
      setLoadingOlder(false);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().replace(/^#/u, "").toLocaleLowerCase(locale);
    return rows.filter((row) => {
      if (state !== "ALL" && row.state !== state) return false;
      if (!needle) return true;
      return [row.normalized_reference, row.zammad_ticket_number, row.group_name, row.zammad_group_id]
        .some((value) => value.toLocaleLowerCase(locale).includes(needle));
    });
  }, [locale, query, rows, state]);

  const openDetach = (row: CaseRow) => {
    setSelected(row);
    setOperationKey(crypto.randomUUID());
    setMutationError(null);
  };

  const closeDetach = useCallback(() => {
    if (pendingRef.current) return;
    setSelected(null);
    setOperationKey(null);
    setMutationError(null);
  }, []);

  const detach = async () => {
    if (!selected || !operationKey || pending) return;
    pendingRef.current = true;
    setPending(true);
    setMutationError(null);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(selected.id)}/detach`, {
        method: "POST",
        headers: { ...mutationHeaders, "idempotency-key": operationKey },
        body: JSON.stringify({ expectedVersion: Number(selected.version), confirmation: "START_NEW_CASE" }),
      });
      if (!response.ok) throw await operatorResponseFailure(response, t("cases.errors.request", { status: response.status }), locale);
      closeDetachAfterSuccess();
      await load(true);
    } catch (detachError) {
      setMutationError(operatorMutationError(detachError, t("cases.errors.detach")));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const closeDetachAfterSuccess = () => {
    setSelected(null);
    setOperationKey(null);
    setMutationError(null);
  };

  const active = rows.filter((row) => row.state !== "DETACHED").length;
  const resolved = rows.filter((row) => row.state === "RESOLVED").length;
  const linked = rows.filter((row) => row.state === "DETACHED").length;
  const targetedCase = normalizedTargetTicket
    ? rows.find((row) => row.zammad_ticket_number.replace(/^#/u, "") === normalizedTargetTicket)
    : undefined;
  const targetFilterActive = Boolean(normalizedTargetTicket && query === normalizedTargetTicket);

  return <div className={styles.layout} dir={direction}>
    <section className={styles.summary} aria-label={t("cases.summary.label")}>
      <div><span>{t("cases.summary.active")}</span><strong>{formatNumber(active, locale)}</strong><small>{t("cases.summary.activeHelp")}</small></div>
      <div><span>{t("cases.summary.resolved")}</span><strong>{formatNumber(resolved, locale)}</strong><small>{t("cases.summary.resolvedHelp")}</small></div>
      <div><span>{t("cases.summary.history")}</span><strong>{formatNumber(linked, locale)}</strong><small>{t("cases.summary.historyHelp")}</small></div>
    </section>

    <section className={`panel table-panel ${styles.panel}`}>
      <div className={`panel-heading ${styles.heading}`}>
        <div><h2>{t("cases.title")}</h2><p>{t("cases.description")}</p></div>
      </div>
      {targetFilterActive && !loading && !error ? <div className={`bulk-feedback ${targetedCase ? "success" : "error"}`} role={targetedCase ? "status" : "alert"} aria-live="polite"><span>{targetedCase ? "✓" : "!"}</span><p>{t(targetedCase ? "cases.target.showing" : "cases.target.missing", { ticket: isolate(`#${normalizedTargetTicket}`) })}</p></div> : null}
      <div className={styles.toolbar}>
        <label><span className="sr-only">{t("cases.search.label")}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("cases.search.placeholder")} /></label>
        <label><span className="sr-only">{t("cases.filter.label")}</span><select value={state} onChange={(event) => setState(event.target.value as typeof state)}><option value="ALL">{t("cases.filter.all")}</option><option value="OPEN">{t("cases.filter.open")}</option><option value="RESOLVED">{t("cases.filter.resolved")}</option><option value="DETACHED">{t("cases.filter.detached")}</option></select></label>
        <span>{t("cases.count", { visible: formatNumber(visible.length, locale), total: formatNumber(rows.length, locale) })}</span>
      </div>

      {error ? <div className={styles.loadError} role="alert"><span>!</span><div><b>{t("cases.unavailable")}</b><p>{error}</p></div><button className="button small" onClick={() => void load()}>{t("cases.tryAgain")}</button></div> : null}
      {loading ? <div className={styles.skeleton} aria-busy="true"><p className="sr-only" role="status" aria-label={t("cases.loading")}>{t("cases.loading")}</p><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></div> : null}
      {!loading && !error && visible.length ? <WideTable>
        <table className={styles.table}>
        <thead><tr><th>{t("cases.table.reference")}</th><th>{t("cases.table.ticket")}</th><th>{t("cases.table.group")}</th><th>{t("cases.table.generation")}</th><th>{t("cases.table.state")}</th><th>{t("cases.table.updated")}</th><th><span className="sr-only">{t("cases.table.actions")}</span></th></tr></thead>
        <tbody>{visible.map((row) => <tr key={row.id} aria-current={targetFilterActive && row.id === targetedCase?.id ? "true" : undefined}>
          <td><b className="mono"><bdi>{row.normalized_reference}</bdi></b></td>
          <td>{openTicket ? <button type="button" className={`${styles.ticketLink} ticket`} onClick={() => openTicket(row.zammad_ticket_number)} aria-label={t("cases.action.open", { ticket: `#${row.zammad_ticket_number}` })}><bdi>#{row.zammad_ticket_number}</bdi></button> : <b className="ticket"><bdi>#{row.zammad_ticket_number}</bdi></b>}</td>
          <td><b><bdi dir="auto">{row.group_name}</bdi></b></td>
          <td><b>{t("cases.generation", { generation: formatNumber(Number(row.generation), locale) })}</b><small>{t(row.predecessor_correlation_id ? "cases.generation.prior" : row.replaced_by_correlation_id ? "cases.generation.replacement" : "cases.generation.original")}</small></td>
          <td><CaseState value={row.state} /></td>
          <td><b>{relativeTime(row.updated_at, locale, renderedAt, t)}</b><small>{row.detached_at ? t("cases.updated.detached", { time: relativeTime(row.detached_at, locale, renderedAt, t) }) : t("cases.updated.synced")}</small></td>
          <td className={styles.action}>{row.state !== "DETACHED" && canDetach ? <button className="button small secondary" aria-label={t("cases.action.startFor", { reference: isolate(row.normalized_reference), ticket: isolate(`#${row.zammad_ticket_number}`) })} onClick={() => openDetach(row)}>{t("cases.action.start")}</button> : <span>{t(row.state === "DETACHED" ? "cases.action.history" : "cases.action.readOnly")}</span>}</td>
        </tr>)}</tbody>
      </table></WideTable> : null}
      {!loading && !error && !visible.length ? <div className={styles.empty}><span>◎</span><b>{t(rows.length ? "cases.empty.filteredTitle" : "cases.empty.title")}</b><p>{t(rows.length ? "cases.empty.filteredBody" : "cases.empty.body")}</p></div> : null}
      {!loading && !error && canLoadOlder ? <div className="audit-pagination"><button className="button secondary" disabled={loadingOlder} onClick={() => void loadOlder()}>{t(loadingOlder ? "cases.loadingOlder" : "cases.loadOlder")}</button></div> : null}
      {olderError ? <p className="audit-load-error" role="alert">{olderError}</p> : null}
    </section>

    {selected ? <ModalDialog close={closeDetach} className="modal-backdrop" role="alertdialog" aria-labelledby="detach-title" aria-describedby="detach-description">
      <section className={styles.dialog}>
        <div className={styles.dialogIcon}>↗</div>
        <h2 id="detach-title">{t("cases.dialog.title")}</h2>
        <p id="detach-description">{t("cases.dialog.description", { reference: isolate(selected.normalized_reference), ticket: isolate(`#${selected.zammad_ticket_number}`), generation: formatNumber(Number(selected.generation) + 1, locale) })}</p>
        <div className={styles.guardrail}><b>{t("cases.dialog.guardrail")}</b><span>{t("cases.dialog.reauthHelp")}</span></div>
        {mutationError ? <div className={styles.mutationError} role="alert"><span>!</span><p>{mutationError.message}</p>{mutationError.code === "REAUTHENTICATION_REQUIRED" ? <a href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dcases">{t("cases.dialog.reauthenticate")}</a> : null}</div> : null}
        <div className={styles.dialogActions}><button data-modal-initial-focus className="button secondary" onClick={closeDetach} disabled={pending}>{t("cases.dialog.cancel")}</button><button className={`${styles.dangerButton} accessible-danger-button`} onClick={() => void detach()} disabled={pending}>{pending ? t("cases.dialog.starting") : t("cases.dialog.confirm", { generation: formatNumber(Number(selected.generation) + 1, locale) })}</button></div>
      </section>
    </ModalDialog> : null}
  </div>;
}

function CaseState({ value }: { value: CaseRow["state"] }) {
  const { t } = useI18n();
  const normalized = String(value).toLocaleLowerCase("en");
  const key = ({ open: "cases.state.open", resolved: "cases.state.resolved", detached: "cases.state.detached" } as Record<string, string>)[normalized] ?? "cases.state.unknown";
  const stateStyle = ["open", "resolved", "detached"].includes(normalized)
    ? styles[normalized as "open" | "resolved" | "detached"]
    : "";
  return <span className={`${styles.state} ${stateStyle}`}><i />{t(key)}</span>;
}

function relativeTime(value: string, locale: "en" | "ar", renderedAt: number, t: ReturnType<typeof useI18n>["t"]) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? formatPastRelativeTime(time, locale, renderedAt) : t("cases.time.unknown");
}

function isolate(value: string) { return `\u2068${value}\u2069`; }

function operatorMutationError(error: unknown, fallback: string): MutationError {
  if (error instanceof Error && "code" in error) {
    return {
      message: error.message,
      code: (error as Error & { code?: UiErrorCode }).code ?? null,
    };
  }
  return { message: fallback, code: null };
}
