"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { InboxArticle, InboxDetail, InboxOperation, InboxPage, InboxTicket } from "../lib/inbox-contract";
import { formatDateTime } from "../lib/i18n/format";
import { operatorFailureMessage, operatorLocalFailure, createLatestRequestFence } from "../lib/operator-ui";
import { useI18n } from "./I18nProvider";
import { useVisibleRefresh } from "./use-visible-refresh";
import styles from "./Inbox.module.css";
import { FullTicketArticle, NewTicketDialog, TicketAttachmentPicker, TicketTeamPicker } from "./TicketInbox";
import type { InboxArticleContent, InboxCreateInput, InboxCreateOptions, InboxUpload } from "../lib/inbox-contract";
import { parseInboxPending, parseInboxCreatePending } from "../lib/inbox-contract";

type Intent = { operation: "REPLY" | "UPDATE"; input: Record<string, unknown>; draftKey?: string };
type UploadBinding = { ticket_id: string } | { create_group_id: string };
type Staged = { cache: string; files: InboxUpload[]; binding: UploadBinding };

// Owners are never told to ask the owner; a held case workspace (503) is unavailable, not missing access.
function inboxFailureKey(status: number | undefined, owner: boolean) {
  if (status === 401 || status === 403) return owner ? "inbox.accessDeniedOwner" : "inbox.accessDenied";
  return status === 503 ? "inbox.serviceUnavailable" : "inbox.failed";
}

export function Inbox({ mutationHeaders, targetTicketNumber, selectTicket, canWrite, scope, recoveryScope = scope, active = true, selectSource, isOwner = false }: {
  mutationHeaders: Record<string, string>; targetTicketNumber: string | null;
  selectSource?: (source: import("../lib/inbox-contract").InboxSourceContext) => void;
  selectTicket: (number: string | null) => void; canWrite: boolean; scope: string; recoveryScope?: string; active?: boolean; isOwner?: boolean;
}) {
  const { t, locale } = useI18n();
  const deniedKey = inboxFailureKey(403, isOwner);
  const [rows, setRows] = useState<InboxTicket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("open");
  const [loadedDetail, setDetail] = useState<InboxDetail | null>(null);
  const [articles, setArticles] = useState<InboxArticle[]>([]);
  const [articleCursor, setArticleCursor] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [internal, setInternal] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, { owner?: string; state?: string; team?: string }>>({});
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<Intent | null>(null);
  const pending = useRef(false), creating = useRef(false), uploading = useRef(false);
  const [recoveryNamespace, setRecoveryNamespace] = useState<string | null>(null), [createNamespace, setCreateNamespace] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false), [createBusy, setCreateBusy] = useState(false);
  const [pendingCreate, setPendingCreate] = useState<{ operation_id: string } | null>(null);
  const [createState, setCreateState] = useState<"APPLIED" | "UNKNOWN" | "NOT_APPLIED" | null>(null);
  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const [transferPreview, setTransferPreview] = useState<InboxDetail | null>(null);
  const [denied, setDenied] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [replyPreview, setReplyPreview] = useState<{ key: string; value: import("../lib/inbox-contract").InboxReplyPreview } | null>(null);
  const stagedRef = useRef(staged), assignmentsRef = useRef(assignments);
  const access = useRef({ scope, generation: 0, denied: false });
  useLayoutEffect(() => { stagedRef.current = staged; assignmentsRef.current = assignments; access.current.scope = scope; }, [staged, assignments, scope]);
  const heading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLInputElement>(null);
  const selection = useRef<{ id?: string; number: string | null }>({ number: null });
  const detailFence = useRef(createLatestRequestFence());
  const listFence = useRef(createLatestRequestFence());
  const sourceFence = useRef(0), sourceMounted = useRef(false);
  useLayoutEffect(() => {
    const fence = sourceFence;
    sourceMounted.current = true; fence.current++;
    return () => { sourceMounted.current = false; fence.current++; };
  }, [active, scope, targetTicketNumber]);
  const selectedNumber = targetTicketNumber?.replace(/^#/u, "") ?? null;
  const selected = rows.find(row => row.number === selectedNumber);
  const selectedId = selected?.id;
  const detail = loadedDetail?.number === selectedNumber ? loadedDetail : null;
  const owner = detail ? assignments[detail.id]?.owner ?? null : null;
  const state = detail ? assignments[detail.id]?.state ?? null : null;
  const targetTeam = detail ? assignments[detail.id]?.team ?? detail.team_id : "";
  const transfer = Boolean(detail && targetTeam !== detail.team_id);
  const effectiveOwners = transfer ? transferPreview?.owner_team_id === targetTeam ? transferPreview.owners : [] : detail?.owners ?? [];
  const draftKey = detail ? `${detail.id}:${internal ? "note" : "reply"}` : "";
  const draft = drafts[draftKey] ?? "";
  const dirty = Object.values(drafts).some(value => value.trim()) || Object.keys(assignments).length > 0 || Object.values(staged).some(value => value.files.length);
  const currentFiles = staged[draftKey]?.files ?? [];
  const previewInput = detail ? { ticket_id: detail.id, expected_updated_at: detail.updated_at, body: draft, internal,
    ...(currentFiles.length ? { form_id: staged[draftKey].cache, attachment_ids: currentFiles.map(file => file.id) } : {}) } : null;
  const previewKey = JSON.stringify([scope, previewRevision, previewInput]);
  const currentPreview = replyPreview?.key === previewKey ? replyPreview.value : null;
  const createStorageKey = `wasalx:inbox-create:${recoveryScope}`;
  const currentAccess = useCallback((generation: number) => access.current.scope === scope && access.current.generation === generation && !access.current.denied, [scope]);
  const clearPrivate = useCallback(() => {
    access.current.generation++; access.current.denied = true;
    listFence.current.invalidate(); detailFence.current.invalidate();
    setDenied(true); setDetail(null); setArticles([]); setRows([]); setDrafts({}); setAssignments({}); setStaged({}); stagedRef.current = {};
    setTransferPreview(null); setReplyPreview(null); setCreateOpen(false);
    setUnknown(value => value ? { operation: value.operation, input: { ticket_id: value.input.ticket_id, operation_id: value.input.operation_id } } : null); setError(t(deniedKey));
  }, [t, deniedKey]);
  const storageKey = `wasalx:inbox-operation:${recoveryScope}`;
  const recoveryReady = recoveryNamespace === storageKey, createReady = createNamespace === createStorageKey;
  const listContext = JSON.stringify([scope, filter, query.trim(), selectedNumber]);
  const activeListContext = useRef(listContext);
  useEffect(() => {
    activeListContext.current = listContext;
    listFence.current.invalidate();
  }, [listContext]);
  useEffect(() => { selection.current = { id: selectedId, number: selectedNumber }; }, [selectedId, selectedNumber]);

  const request = useCallback(async <T,>(operation: InboxOperation, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    const response = await fetch("/api/inbox", { method: "POST", cache: "no-store",
      headers: { ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({ operation, input }), signal });
    if (response.status === 401 || response.status === 403) {
      clearPrivate();
    }
    if (!response.ok) throw Object.assign(operatorLocalFailure(t(response.status === 409 ? "inbox.conflict" : inboxFailureKey(response.status, isOwner))), { status: response.status });
    return response.json() as Promise<T>;
  }, [clearPrivate, mutationHeaders, t, isOwner]);

  const loadList = useCallback(async (signal?: AbortSignal, before?: string) => {
    if (activeListContext.current !== listContext) return;
    const execution = listFence.current.begin();
    const current = () => !signal?.aborted && listFence.current.isCurrent(execution) && activeListContext.current === listContext;
    try {
    const page = await request<InboxPage<InboxTicket>>("LIST",
      { limit: 50, ...(query.trim() ? { query: query.trim() } : {}), ...(filter ? { state: filter } : {}), ...(before ? { before } : {}) }, signal);
    if (!current()) return;
    const exact = !before && selectedNumber && !page.items.some(row => row.number === selectedNumber)
      ? (await request<InboxPage<InboxTicket>>("LIST", { ticket_number: selectedNumber, limit: 1 }, signal)).items : [];
    if (!current()) return;
    setRows(current => before ? [...current, ...page.items.filter(row => !current.some(item => item.id === row.id))] :
      [...exact, ...page.items]);
    setCursor(page.next_cursor);
    } catch (failure) { if (current()) throw failure; }
  }, [filter, query, request, selectedNumber, listContext]);

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    if (selection.current.id !== id) return;
    const execution = detailFence.current.begin();
    const [ticket, page] = await Promise.all([
      request<InboxDetail>("SHOW", { ticket_id: id }, signal),
      request<InboxPage<InboxArticle>>("ARTICLES", { ticket_id: id, limit: 50 }, signal),
    ]);
    if (signal?.aborted || !detailFence.current.isCurrent(execution) || selection.current.id !== id) return;
    setDetail(ticket); setArticles(page.items); setArticleCursor(page.next_cursor);
  }, [request]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      // A background list refresh must preserve newer access and action failures.
      setLoading(true);
      void loadList(controller.signal).catch(() => {
        if (!controller.signal.aborted) { setRows([]); setDetail(null); setArticles([]); setError(t("inbox.failed")); }
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, loadList, t]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const fence = detailFence.current;
    const timer = window.setTimeout(() => {
      setDetail(null); setArticles([]);
      if (!selectedId) { setOpening(false); return; }
      setOpening(true);
      void loadDetail(selectedId, controller.signal).then(() => {
        window.requestAnimationFrame(() => { if (!controller.signal.aborted) heading.current?.focus({ preventScroll: true }); });
      }).catch(() => {
        if (!controller.signal.aborted) setError(t("inbox.failed"));
      }).finally(() => { if (!controller.signal.aborted) setOpening(false); });
    }, 0);
    return () => { controller.abort(); window.clearTimeout(timer); fence.invalidate(); };
  }, [active, selectedId, loadDetail, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const value = parseInboxPending(sessionStorage.getItem(storageKey));
        setUnknown(value ? { operation: value.kind, input: { ticket_id: value.ticket_id, operation_id: value.operation_id } } : null);
        setRecoveryNamespace(storageKey);
      } catch { setError(t("ticketExtras.storageUnavailable")); }
      try { setPendingCreate(parseInboxCreatePending(sessionStorage.getItem(createStorageKey))); setCreateNamespace(createStorageKey); }
      catch { setError(t("ticketExtras.storageUnavailable")); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey, createStorageKey, t]);

  const detailId = detail?.id;
  useEffect(() => {
    if (!active || !detailId || !transfer) return;
    const controller = new AbortController(), id = detailId, team = targetTeam, generation = access.current.generation;
    const timer = setTimeout(() => { void request<InboxDetail>("SHOW", { ticket_id: id, group_id: team }, controller.signal).then(value => {
      if (!controller.signal.aborted && currentAccess(generation) && selection.current.id === id && assignmentsRef.current[id]?.team === team) setTransferPreview(value);
    }).catch(() => { if (!controller.signal.aborted) setError(t("inbox.failed")); }); }, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, detailId, transfer, targetTeam, request, currentAccess, t]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || unknown || pendingCreate) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, unknown, pendingCreate]);

  // Access remains fresh even while drafts pause content refresh.
  useVisibleRefresh(async signal => {
    try { await request("CHECK", {}, signal); }
    catch (failure) {
      if (!signal?.aborted) {
        setDetail(null); setArticles([]); setRows([]); setError(t(inboxFailureKey((failure as { status?: number }).status, isOwner)));
      }
    }
  }, active);

  useVisibleRefresh(async signal => {
    try {
      await loadList(signal);
      if (selected) await loadDetail(selected.id, signal);
    } catch {
      // Revocation or backend loss clears cached content; it cannot stay apparently authorized.
      if (!signal?.aborted) { setDetail(null); setArticles([]); setRows([]); setError(t("inbox.failed")); }
    }
  }, active && !busy && !unknown && !dirty);

  const finish = async (intent: Intent) => {
    try { sessionStorage.removeItem(storageKey); } catch { setUnknown(intent); setError(t("ticketExtras.storageUnavailable")); return; }
    if (intent.draftKey) {
      const key = intent.draftKey;
      setDrafts(values => values[key] === intent.input.body ? { ...values, [key]: "" } : values);
      const value = stagedRef.current[key];
      if (value && value.cache === intent.input.form_id && JSON.stringify(value.files.map(file => file.id)) === JSON.stringify(intent.input.attachment_ids)) {
        const next = { ...stagedRef.current }; delete next[key]; stagedRef.current = next; setStaged(next);
      }
    }
    setUnknown(null);
    if (intent.operation === "UPDATE") setAssignments(values => {
      const id = String(intent.input.ticket_id), next = { ...values }, value = { ...next[id] };
      for (const [key, field] of [["owner", "owner_id"], ["state", "state_id"], ["team", "group_id"]] as const)
        if (intent.input[field] !== undefined && value[key] === intent.input[field]) delete value[key];
      if (Object.keys(value).length) next[id] = value; else delete next[id];
      return next;
    });
    setNotice(t("inbox.saved"));
    try { await loadList(); if (typeof intent.input.ticket_id === "string" && selection.current.id === intent.input.ticket_id) await loadDetail(intent.input.ticket_id); }
    catch { setError(t("inbox.savedRefreshFailed")); }
  };
  const mutate = async (intent: Intent) => {
    if (pending.current || uploading.current || unknown || !recoveryReady || !canWrite || denied) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    const generation = access.current.generation;
    try {
      try { sessionStorage.setItem(storageKey, JSON.stringify({ ticket_id: intent.input.ticket_id, operation_id: intent.input.operation_id, kind: intent.operation })); }
      catch { setRecoveryNamespace(null); setError(t("ticketExtras.storageUnavailable")); return; }
      setUnknown({ operation: intent.operation, input: { ticket_id: intent.input.ticket_id, operation_id: intent.input.operation_id } });
      try {
        const result = await request<{ state: string }>(intent.operation, intent.input);
        if (!currentAccess(generation)) return;
        if (result.state !== "APPLIED") { setUnknown(intent); setError(t("inbox.unknown")); return; }
      } catch (failure) {
        if (access.current.scope === scope) setUnknown(currentAccess(generation) ? intent : { operation: intent.operation, input: { ticket_id: intent.input.ticket_id, operation_id: intent.input.operation_id } });
        if (currentAccess(generation)) setError(operatorFailureMessage(failure, t("inbox.unknown")));
        return;
      }
      await finish(intent);
    } finally { pending.current = false; setBusy(false); }
  };
  const reconcile = async (action: "LOOKUP" | "CANCEL_IF_UNADMITTED" = "LOOKUP") => {
    if (!unknown || pending.current || (action !== "LOOKUP" && (!canWrite || denied))) return;
    pending.current = true; setBusy(true);
    const generation = access.current.generation;
    try {
      const result = await request<{ state: string; terminal?: boolean }>("RECEIPT", { ticket_id: unknown.input.ticket_id, operation_id: unknown.input.operation_id, action });
      if (!currentAccess(generation)) return;
      if (result.state === "NOT_APPLIED" && result.terminal === true) {
        sessionStorage.removeItem(storageKey); setUnknown(null); setError(null); setNotice(t("inbox.notApplied"));
      } else if (result.state === "APPLIED") await finish(unknown);
      else setError(t("inbox.unknown"));
    } catch { if (currentAccess(generation)) setError(t("inbox.unknown")); }
    finally { pending.current = false; setBusy(false); }
  };
  const loadCreateOptions = useCallback((input: Record<string, unknown>, signal: AbortSignal) => request<InboxCreateOptions>("CREATE_OPTIONS", input, signal), [request]);
  const readFullArticle = useCallback((input: Record<string, unknown>, signal: AbortSignal) => request<InboxArticleContent>("ARTICLE_CONTENT", input, signal), [request]);
  const performCreate = async (input: InboxCreateInput): Promise<"APPLIED" | "UNKNOWN" | "REJECTED"> => {
    if (creating.current || uploading.current || pendingCreate || !createReady || !canWrite || denied) return "REJECTED";
    creating.current = true; setCreateBusy(true); setCreateState(null); setError(null);
    const receipt = { operation_id: input.operation_id }, generation = access.current.generation;
    try {
      try { sessionStorage.setItem(createStorageKey, JSON.stringify(receipt)); }
      catch { setCreateNamespace(null); setError(t("ticketExtras.storageUnavailable")); return "REJECTED"; }
      setPendingCreate(receipt);
      const result = await request<{ state: string; ticket_number?: string; operation_id?: string; article_id?: string }>("CREATE_TICKET", input);
      if (!currentAccess(generation)) return "UNKNOWN";
      if (result.state !== "APPLIED" || result.operation_id !== input.operation_id || !result.ticket_number || !result.article_id) return "UNKNOWN";
      sessionStorage.removeItem(createStorageKey); setPendingCreate(null); setCreateState("APPLIED");
      const next = { ...stagedRef.current }; delete next.CREATE; stagedRef.current = next; setStaged(next);
      setNotice(t("ticketExtras.created")); selectTicket(result.ticket_number);
      try { await loadList(); } catch { setError(t("inbox.savedRefreshFailed")); }
      return "APPLIED";
    } catch { if (currentAccess(generation)) { setCreateState("UNKNOWN"); setError(t("ticketExtras.createUnknown")); } return "UNKNOWN"; }
    finally { creating.current = false; setCreateBusy(false); }
  };
  const reconcileCreate = async (action: "LOOKUP" | "CANCEL_IF_UNADMITTED") => {
    if (!pendingCreate || creating.current || (action !== "LOOKUP" && (!canWrite || denied))) return;
    creating.current = true; setCreateBusy(true); const generation = access.current.generation;
    try {
      const result = await request<{ state: string; terminal?: boolean; ticket_number?: string }>("CREATE_RECEIPT", { ...pendingCreate, action });
      if (!currentAccess(generation)) return;
      if (result.state === "APPLIED" || result.state === "NOT_APPLIED" && result.terminal === true) {
        sessionStorage.removeItem(createStorageKey); setPendingCreate(null); setError(null); setCreateState(result.state);
        if (result.state === "APPLIED") {
          const next = { ...stagedRef.current }; delete next.CREATE; stagedRef.current = next; setStaged(next);
          if (result.ticket_number) selectTicket(result.ticket_number); await loadList();
        }
      } else setCreateState("UNKNOWN");
    } catch { if (currentAccess(generation)) setError(t("ticketExtras.createUnknown")); }
    finally { creating.current = false; setCreateBusy(false); }
  };
  const uploadFiles = async (key: string, binding: UploadBinding, files: File[]) => {
    if (uploading.current || !canWrite || denied || (key === "CREATE" ? Boolean(pendingCreate) : Boolean(unknown))) return;
    uploading.current = true; setBusy(true); setError(null);
    const generation = access.current.generation;
    const existing = stagedRef.current[key] ?? { cache: crypto.randomUUID(), files: [], binding };
    const headers = { ...mutationHeaders }; delete headers["content-type"]; delete headers["Content-Type"];
    try {
      for (const file of files) {
        if (!currentAccess(generation)) return;
        const body = new FormData(); body.set("operation", "TICKET_UPLOAD"); body.set("input", JSON.stringify({ ...binding, upload_cache_id: existing.cache })); body.set("file", file, file.name);
        const response = await fetch("/api/inbox/upload", { method: "POST", headers, body });
        if ([401, 403].includes(response.status)) clearPrivate();
        if (!response.ok) throw new Error();
        const result = await response.json() as { items: Array<{ id: string; filename: string; mime_type: string; size: number }> };
        if (!currentAccess(generation)) return;
        const current = stagedRef.current[key] ?? existing;
        const next = { ...stagedRef.current, [key]: { ...current, files: [...current.files, ...result.items.map(item => ({ id: item.id, name: item.filename, bytes: item.size, mime_type: item.mime_type }))] } };
        stagedRef.current = next; setStaged(next); if (key !== "CREATE") { setReplyPreview(null); setPreviewRevision(value => value + 1); }
      }
    } catch { if (currentAccess(generation)) setError(t("ticketExtras.attachmentFailed")); throw new Error(); }
    finally { uploading.current = false; setBusy(false); }
  };
  const removeUpload = async (key: string, file: InboxUpload) => {
    const value = stagedRef.current[key]; if (!value || !canWrite || denied) return;
    if (uploading.current || pending.current || creating.current) return;
    uploading.current = true; setBusy(true);
    const generation = access.current.generation;
    try { await request("REMOVE_UPLOAD", { ...value.binding, upload_cache_id: value.cache, upload_store_id: file.id });
    if (!currentAccess(generation)) return;
    const current = stagedRef.current[key]; if (!current || current.cache !== value.cache) return;
    const next = { ...stagedRef.current, [key]: { ...current, files: current.files.filter(item => item.id !== file.id) } }; stagedRef.current = next; setStaged(next);
    if (key !== "CREATE") { setReplyPreview(null); setPreviewRevision(value => value + 1); }
    } finally { uploading.current = false; setBusy(false); }
  };
  const previewReply = async () => {
    if (!previewInput || busy || unknown || denied) return;
    setBusy(true); setError(null); const generation = access.current.generation, key = previewKey;
    try {
      const value = await request<import("../lib/inbox-contract").InboxReplyPreview>("PREVIEW", previewInput);
      if (currentAccess(generation) && value.ticket_updated_at === previewInput.expected_updated_at && /^[a-f0-9]{64}$/u.test(value.draft_sha256)) setReplyPreview({ key, value });
    } catch { if (currentAccess(generation)) setError(t("ticketExtras.previewFailed")); }
    finally { setBusy(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!detail || (!draft.trim() && !currentFiles.length) || !internal && !currentPreview?.can_send) return;
    void mutate({ operation: "REPLY", draftKey, input: { ticket_id: detail.id, operation_id: crypto.randomUUID(),
      expected_updated_at: detail.updated_at, body: draft, internal,
      ...(currentFiles.length ? { form_id: staged[draftKey].cache, attachment_ids: currentFiles.map(file => file.id) } : {}) } });
  };
  const saveAssignment = (event: FormEvent) => {
    event.preventDefault();
    if (!detail || (owner === null && state === null && !transfer) || (transfer && transferPreview?.owner_team_id !== targetTeam)) return;
    void mutate({ operation: "UPDATE", input: { ticket_id: detail.id, operation_id: crypto.randomUUID(),
      expected_updated_at: detail.updated_at, ...(owner === null ? {} : { owner_id: owner }), ...(state === null ? {} : { state_id: state }), ...(transfer ? { group_id: targetTeam } : {}) } });
  };
  const olderArticles = async () => {
    if (!detail || !articleCursor || busy) return;
    setBusy(true);
    const id = detail.id, execution = detailFence.current.begin();
    try {
      const page = await request<InboxPage<InboxArticle>>("ARTICLES", { ticket_id: id, before: articleCursor, limit: 50 });
      if (selection.current.id !== id || !detailFence.current.isCurrent(execution)) return;
      setArticles(current => [...current, ...page.items.filter(item => !current.some(row => row.id === item.id))]);
      setArticleCursor(page.next_cursor);
    } catch { setError(t("inbox.failed")); } finally { setBusy(false); }
  };
  const openSource = async (article: InboxArticle) => {
    if (!detail || !selectSource || busy || !active) return;
    const id = detail.id, sequence = ++sourceFence.current, generation = access.current.generation;
    setBusy(true); setError(null);
    try {
      const source = await request<import("../lib/inbox-contract").InboxSourceContext>("SOURCE_CONTEXT", { ticket_id: id, article_id: article.id });
      if (!sourceMounted.current || sequence !== sourceFence.current || !currentAccess(generation) || selection.current.id !== id) return;
      const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
      if (!uuid.test(source.group_id) || !uuid.test(source.message_id)) throw new Error();
      selectSource(source);
    } catch { if (sourceMounted.current && sequence === sourceFence.current && currentAccess(generation)) setError(t("inbox.sourceUnavailable")); }
    finally { if (sourceMounted.current) setBusy(false); }
  };
  const download = async (article: InboxArticle, file: InboxArticle["attachments"][number]) => {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/inbox/attachment", { method: "POST", headers: mutationHeaders,
        body: JSON.stringify({ ticket_id: detail.id, article_id: article.id, attachment_id: file.id }) });
      if ([401, 403].includes(response.status)) clearPrivate();
      if (!response.ok) throw operatorLocalFailure(t("inbox.downloadFailed"));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = file.filename; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setError(t("inbox.downloadFailed")); } finally { setBusy(false); }
  };
  const reload = async () => {
    setError(null);
    try {
      await request("CHECK", {}); access.current.denied = false; setDenied(false);
      await loadList();
      if (selection.current.id) await loadDetail(selection.current.id);
    } catch { setError(t("inbox.failed")); }
  };
  const editAssignment = (key: "owner" | "state" | "team", value: string) => {
    if (!detail) return;
    setAssignments(current => ({ ...current, [detail.id]: { ...current[detail.id], [key]: value, ...(key === "team" ? { owner: "1" } : {}) } }));
  };

  const createRecovery = <div className="wx-ticket-create-actions">
    <button type="button" className="wx-button wx-button-secondary" disabled={createBusy} onClick={() => void reconcileCreate("LOOKUP")}>{t("inbox.checkSubmission")}</button>
    <button type="button" className="wx-button wx-button-secondary" disabled={createBusy || !canWrite || denied} onClick={() => void reconcileCreate("CANCEL_IF_UNADMITTED")}>{t("ticketExtras.cancelUnstarted")}</button>
  </div>;
  return <section className={styles.workspace} data-unsaved={dirty || Boolean(unknown) || Boolean(pendingCreate) || undefined} aria-label={t("inbox.title")}>
    {error || unknown ? <div className={styles.feedback} role="alert"><p>{error || t("inbox.unknown")}</p>{unknown ?
      <><button className="wx-button wx-button-secondary" disabled={busy} onClick={() => void reconcile()}>{t("inbox.checkSubmission")}</button>
      <button className="wx-button wx-button-secondary" disabled={busy || !canWrite || denied} onClick={() => void reconcile("CANCEL_IF_UNADMITTED")}>{t("ticketExtras.cancelUnstarted")}</button></> :
      <button className="wx-button wx-button-secondary" disabled={busy} onClick={() => void reload()}>{t("inbox.reload")}</button>}</div> : null}
    <p className={styles.notice} role="status">{notice}</p>
    {pendingCreate && !createOpen ? <div className={styles.feedback}><p>{t("ticketExtras.createUnknown")}</p>{createRecovery}</div> : null}
    <div className={styles.layout} data-selected={Boolean(selectedNumber)}>
      <aside className={styles.list}>
        <div className={styles.filters}>
          {canWrite ? <button type="button" className="wx-button wx-button-primary" disabled={!createReady || denied} onClick={() => { setCreateState(null); setCreateOpen(true); }}>{t("ticketExtras.newTicket")}</button> : null}
          <label htmlFor="inbox-search">{t("inbox.search")}<input ref={listHeading} id="inbox-search" type="search" maxLength={160} value={query} onChange={event => setQuery(event.target.value)} /></label>
          <label htmlFor="inbox-filter">{t("inbox.filter")}<select id="inbox-filter" value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="open">{t("inbox.open")}</option><option value="closed">{t("inbox.closed")}</option><option value="">{t("inbox.all")}</option>
          </select></label>
        </div>
        {loading ? <p className={styles.empty} aria-busy="true">{t("inbox.loading")}</p> :
          rows.length ? <ul className={styles.tickets}>{rows.map(row => <li key={row.id}>
            <button className={styles.ticket} aria-current={row.number === selectedNumber ? "true" : undefined}
              onClick={() => { setInternal(false); selectTicket(row.number); }}>
              <span className={styles.ticketTop}><b><bdi>{row.customer || t("inbox.customer")}</bdi></b><small><bdi>#{row.number}</bdi></small></span>
              <strong dir="auto">{row.title}</strong>
              <span className={styles.ticketMeta}><span>{t(`inbox.channel.${row.channel}`)}</span><span>{t(row.closed ? "inbox.closed" : "inbox.open")}</span></span>
              <small dir="auto">{row.team} · {row.owner || t("inbox.unassigned")}</small>
            </button>
          </li>)}</ul> : <div className={styles.empty}><h2>{t("inbox.empty")}</h2><p>{t("inbox.emptyBody")}</p></div>}
        {cursor ? <button className="wx-button wx-button-secondary" disabled={busy} onClick={() => {
          setBusy(true); void loadList(undefined, cursor).catch(() => setError(t("inbox.failed"))).finally(() => setBusy(false));
        }}>{t("inbox.more")}</button> : null}
      </aside>
      <div className={styles.conversation} aria-busy={opening}>
        <button className={`wx-button wx-button-secondary ${styles.back}`} onClick={() => {
          selectTicket(null); window.requestAnimationFrame(() => listHeading.current?.focus());
        }}>{t("inbox.back")}</button>
        {opening ? <p className={styles.empty}>{t("inbox.loading")}</p> : detail ? <>
          <header className={styles.header}>
            <div><h2 ref={heading} tabIndex={-1} dir="auto">{detail.title}</h2><p><bdi>#{detail.number}</bdi> · {t(`inbox.channel.${detail.channel}`)} · <bdi dir="auto">{detail.customer}</bdi></p></div>
            <span className="badge">{t(detail.closed ? "inbox.closed" : "inbox.open")}</span>
          </header>
          {detail.recipient_delivery && detail.recipient_delivery.state !== "CLEAR" ? <p className={styles.recipientNotice} data-recipient-delivery={detail.recipient_delivery.state}>
            {t(detail.recipient_delivery.state === "UNCONFIRMED" ? "inbox.email.recipientUnconfirmed" : detail.recipient_delivery.reason === "INVALID_ADDRESS" ? "inbox.email.invalidAddress" : "inbox.email.recipientFailure")}
          </p> : null}
          <form className={styles.assignment} onSubmit={saveAssignment}>
            <TicketTeamPicker id="inbox-team" teams={detail.teams.some(team => team.id === detail.team_id) ? detail.teams : [{ id: detail.team_id, name: detail.team }, ...detail.teams]}
              value={targetTeam} disabled={!canWrite || !detail.can_update || busy || Boolean(unknown) || denied} change={value => editAssignment("team", value)} />
            <label htmlFor="inbox-owner">{t("inbox.owner")}<select id="inbox-owner" disabled={!canWrite || !detail.can_update || busy || Boolean(unknown)}
              value={owner ?? detail.owner_id} onChange={event => editAssignment("owner", event.target.value)}>
              {(owner ?? detail.owner_id) !== "1" && !effectiveOwners.some(item => item.id === (owner ?? detail.owner_id)) ? <option value={owner ?? detail.owner_id}>{detail.owner || t("inbox.unassigned")}</option> : null}
              <option value="1">{t("inbox.unassigned")}</option>
              {effectiveOwners.filter(item => item.id !== "1").map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label htmlFor="inbox-state">{t("inbox.state")}<select id="inbox-state" disabled={!canWrite || !detail.can_update || busy || Boolean(unknown)}
              value={state ?? detail.states.find(item => item.name === detail.state)?.id ?? ""} onChange={event => editAssignment("state", event.target.value)}>
              {!detail.states.some(item => item.name === detail.state) ? <option value="">{t("inbox.currentState")}</option> : null}
              {detail.states.map(item => <option key={item.id} value={item.id}>{t(item.closed ? "inbox.closed" : "inbox.open")}</option>)}
            </select></label>
            {owner !== null || state !== null || transfer ? <button className="wx-button wx-button-secondary" disabled={busy || Boolean(unknown) || !recoveryReady || denied || transfer && transferPreview?.owner_team_id !== targetTeam}>{t("inbox.save")}</button> : null}
          </form>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The separately scrolling transcript needs keyboard access. */}
          <div className={styles.history} role="region" aria-label={t("inbox.history")} tabIndex={0}>
            {articleCursor ? <button className="wx-button wx-button-secondary" disabled={busy} onClick={() => void olderArticles()}>{t("inbox.older")}</button> : null}
            <ol className={styles.articles}>{[...articles].reverse().map(article => <li key={article.id} className={styles.article} data-article-id={article.id} data-internal={article.internal}>
              <div className={styles.articleHead}><b dir="auto">{article.sender === "System" ? t("common.brand.name") : article.author || t("inbox.customer")}</b>
                <span>{t(article.internal ? "inbox.note" : article.sender === "System" ? "inbox.systemMessage" : article.sender === "Agent" ? "inbox.teamReply" : "inbox.customerMessage")}</span>
                <time dateTime={article.created_at}>{formatDateTime(article.created_at, locale, { dateStyle: "medium", timeStyle: "short" })}</time></div>
              <FullTicketArticle key={`${scope}:${detail.id}:${article.id}`} ticketId={detail.id} articleId={article.id} body={article.body}
                bodySha256={article.body_sha256} complete={article.body_complete} totalCharacters={article.total_characters} scope={scope} read={readFullArticle} />
              {article.delivery ? <p className={styles.delivery} data-email-delivery={article.delivery.state}>
                {t(article.delivery.state === "SENT" ? "inbox.email.sent" : article.delivery.automatic_attempts_ended ? "inbox.email.attemptsEnded" : "inbox.email.unconfirmed")}
              </p> : null}
              {article.has_source && selectSource ? <button type="button" className="wx-button wx-button-secondary" disabled={busy}
                onClick={() => void openSource(article)}>{t("groups.sourceMessage")}</button> : null}
              {article.attachments.length ? <ul>{article.attachments.map(file => <li key={file.id}>
                <button type="button" className="wx-button wx-button-secondary" disabled={busy} onClick={() => void download(article, file)}
                  aria-label={t("inbox.download", { filename: file.filename })}><bdi dir="auto">{file.filename}</bdi></button>
              </li>)}</ul> : null}
            </li>)}</ol>
          </div>
          {canWrite && detail.can_update ? <form className={styles.composer} onSubmit={submit}>
            <label htmlFor="inbox-kind">{t("inbox.messageKind")}<select id="inbox-kind" disabled={busy || Boolean(unknown)} value={internal ? "note" : "reply"} onChange={event => { setInternal(event.target.value === "note"); setReplyPreview(null); setPreviewRevision(value => value + 1); }}>
              <option value="reply" disabled={!detail.can_reply}>{t("inbox.reply")}</option><option value="note">{t("inbox.note")}</option>
            </select></label>
            <label htmlFor="inbox-message">{t(internal ? "inbox.note" : "inbox.reply")}<textarea id="inbox-message" dir="auto" required={!currentFiles.length} maxLength={4096} rows={4}
              disabled={busy || Boolean(unknown) || !internal && !detail.can_reply} value={draft}
              onChange={event => { setDrafts(current => ({ ...current, [draftKey]: event.target.value })); setReplyPreview(null); setPreviewRevision(value => value + 1); }} /></label>
            <TicketAttachmentPicker key={draftKey} id="inbox-files" files={currentFiles} limits={detail.upload_constraints}
              disabled={busy || Boolean(unknown) || !recoveryReady || denied || !internal && !detail.can_reply}
              upload={files => uploadFiles(draftKey, { ticket_id: detail.id }, files)} remove={file => removeUpload(draftKey, file)} />
            <button type="button" className="wx-button wx-button-secondary" disabled={busy || Boolean(unknown) || denied || (!draft.trim() && !currentFiles.length)} onClick={() => void previewReply()}>{t("ticketExtras.preview")}</button>
            {currentPreview ? <div className="wx-ticket-preview" role="status">
              <h3>{t("ticketExtras.preview")}</h3><p>{t(`ticketExtras.channel.${currentPreview.channel}`)}</p>
              {currentPreview.recipient ? <p>{t("ticketExtras.previewRecipient")} <bdi>{currentPreview.recipient}</bdi></p> : null}
              <p>{t("ticketExtras.team")} <bdi>{currentPreview.team}</bdi></p>
              <p>{t(`ticketExtras.routing.${currentPreview.routing_notice}`)}</p>
              {currentPreview.handover_required ? <p>{t("ticketExtras.handover")}</p> : null}
              {currentPreview.text ? <p dir="auto">{currentPreview.text}</p> : null}
            </div> : null}
            <div className={styles.composerActions}><p>{t(internal ? "inbox.noteHelp" : "inbox.replyHelp")}</p>
              <button className="wx-button wx-button-primary" disabled={busy || Boolean(unknown) || !recoveryReady || denied || (!draft.trim() && !currentFiles.length) || !internal && (!detail.can_reply || !currentPreview?.can_send)}>{t(busy ? "inbox.saving" : internal ? "inbox.addNote" : "inbox.send")}</button></div>
            {!detail.can_reply && !internal ? <p>{t("inbox.replyUnavailable")}</p> : null}
          </form> : <p className={styles.empty}>{t("inbox.readOnly")}</p>}
        </> : <div className={styles.empty}><h2>{t("inbox.choose")}</h2><p>{t(selectedNumber ? "inbox.unavailable" : "inbox.chooseBody")}</p></div>}
      </div>
    </div>
    {createOpen ? <NewTicketDialog close={() => setCreateOpen(false)} loadOptions={loadCreateOptions} submit={performCreate}
      blocked={Boolean(pendingCreate) || !createReady || denied} busy={createBusy || busy} error={error} recoveryState={createState} recoveryActions={createRecovery}
      formId={staged.CREATE?.cache ?? null} attachmentIds={staged.CREATE?.files.map(file => file.id) ?? []}
      groupChanged={() => { if (!stagedRef.current.CREATE?.files.length) { const next = { ...stagedRef.current }; delete next.CREATE; stagedRef.current = next; setStaged(next); } }}
      renderAttachments={(groupId, disabled, limits) => <TicketAttachmentPicker key={groupId} id="inbox-create-files" files={staged.CREATE?.files ?? []} limits={limits}
        disabled={disabled || busy || createBusy || !canWrite || denied} upload={files => uploadFiles("CREATE", { create_group_id: groupId }, files)} remove={file => removeUpload("CREATE", file)} />} /> : null}
  </section>;
}
