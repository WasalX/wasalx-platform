"use client";
import { operatorFailureMessage, operatorLocalFailure } from "../lib/operator-ui";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { AttachmentFilePicker } from "./AttachmentFilePicker";
import { ModalDialog } from "./ModalDialog";
import { isAbortError } from "../lib/bot-conversations";
import { useI18n } from "./I18nProvider";
import { ScrollRegion } from "./tenant-ui";
import { useVisibleRefresh } from "./use-visible-refresh";
import "./GroupInbox.css";

type Scope = "MY" | "TEAM" | "UNASSIGNED" | "ALL";
type Page<T> = { items: T[]; next_cursor: string | null };
type Upload = { id: string; filename: string; mime_type: string; size: number };
type Participant = { id: string; name: string; phone: string | null; mention_token: string };
type DeliveryState = "QUEUED" | "CLAIMED" | "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "OUTCOME_UNKNOWN" | "BLOCKED";
type Group = {
  id: string; name: string; access_scope: Scope; unread_count: number;
  send_available: boolean; reactions_available: boolean;
  media_capabilities: { accepted: { mime_type: string; maximum_bytes: number }[];
    voice_recording: boolean; maximum_files: number; maximum_total_bytes: number };
};
type Message = {
  id: string; participant_name: string | null; sender_phone: string | null;
  message_text: string | null; provider_timestamp: string; from_me: boolean;
  latest_mutation: "EDITED" | "REVOKED" | null; quote_allowed: boolean; ticket_creatable: boolean;
  quoted_message: { id: string; author: string; text: string | null } | null;
  quote_unavailable?: boolean;
  delivery_state: DeliveryState | null; delivery_hold_reason: string | null;
  reaction_active_emoji: string | null; reaction_delivery_state: DeliveryState | null;
  media_kind: "image" | "video" | "audio" | "document" | null;
  media_filename: string | null; media_mime_type: string | null; media_available: boolean;
};
type Ticket = { ticket_number: string; title: string; owner: string | null; team: string;
  state_category: "OPEN" | "CLOSED"; links: { message_id: string }[] };
type SendInput = { group_id: string; request_token: string; message: string;
  reply_to_message_id?: string; mentions: string[]; upload_cache_id: string; upload_store_ids: string[] };
type ActionInput = { group_id: string; message_id: string; request_token: string };
type Writes = {
  GROUP_SEND: SendInput;
  GROUP_REACTION: ActionInput & { emoji?: string; removed?: true };
  GROUP_CREATE_TICKET: ActionInput & { title: string; target_group_id: string };
  GROUP_LINK_TICKET: ActionInput & { ticket_number: string };
};
type Contract = {
  GROUP_CHECK: { input: { group_id?: string }; output: { allowed: true } };
  GROUP_LIST: { input: { scope: Scope; after?: string; selected?: string }; output: Page<Group> };
  GROUP_SHOW: { input: { group_id: string }; output: Group };
  GROUP_MESSAGES: { input: { group_id: string; before?: string }; output: Page<Message> };
  GROUP_CONTEXT: { input: { group_id: string; message_id: string }; output: Page<Message> };
  GROUP_TICKETS: { input: { group_id: string; state: "OPEN" | "CLOSED" | "ALL"; before?: string }; output: Page<Ticket> };
  GROUP_TEAMS: { input: Record<string, never>; output: { id: string; name: string }[] };
  GROUP_PARTICIPANTS: { input: { group_id: string; query: string }; output: Participant[] };
  GROUP_READ: { input: { group_id: string; message_id: string }; output: { acknowledged: true } };
  GROUP_REMOVE_UPLOAD: { input: { group_id: string; upload_cache_id: string; upload_store_id: string }; output: { removed: true } };
  GROUP_RECEIPT: { input: NetworkRecovery & { action: "LOOKUP" | "CANCEL_IF_UNADMITTED" };
    output: { state: "ADMITTED" | "CANCELLED" | "NOT_APPLIED" | "UNKNOWN"; terminal?: boolean } };
  GROUP_TICKET_RECEIPT: { input: SagaRecovery & { action: "LOOKUP" | "CANCEL_IF_UNADMITTED" };
    output: { state: "COMPLETE" | "PARTIAL" | "UNKNOWN" | "NOT_APPLIED" | "CANCELLED"; terminal?: boolean; ticket_number?: string } };
  GROUP_REPAIR_TICKET_LINK: { input: SagaRecovery; output: { state: "COMPLETE" | "PARTIAL" | "UNKNOWN"; ticket_number?: string } };
} & { [K in keyof Writes]: { input: Writes[K]; output: { accepted: true; ticket_number?: string } } };
type Intent = { [K in keyof Writes]: { operation: K; input: Writes[K] } }[keyof Writes];
type NetworkRecovery = { group_id: string; operation_id: string; kind: "SEND" | "REACTION"; target_message_id?: string };
type SagaRecovery = { group_id: string; message_id: string; operation_id: string; kind: "CREATE" | "LINK"; target_ticket_number?: string };
type Recovery = NetworkRecovery | SagaRecovery;
type Draft = { text: string; quote: Message | null; mentions: Participant[]; attachments: Upload[]; cache: string };
type Recording = { instance: MediaRecorder; stream: MediaStream; discard: boolean; group: string; scope: string; timer?: ReturnType<typeof setTimeout> };
const emptyDraft = (): Draft => ({ text: "", quote: null, mentions: [], attachments: [], cache: crypto.randomUUID() });
const mergeById = <T extends { id: string }>(a: T[], b: T[]) => [...a, ...b.filter(item => !a.some(old => old.id === item.id))];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// Gateway derives this numeric token from normalized phone or participant JID localpart.
export function groupMentionAppears(text: string, token: string) {
  return /^[0-9]{1,24}$/u.test(token) && new RegExp(`(^|[^0-9])@${token}(?![0-9])`, "u").test(text);
}
export function groupDraftMatchesSend(value: Draft, input: SendInput) {
  return value.text === input.message && value.cache === input.upload_cache_id && value.quote?.id === input.reply_to_message_id
    && JSON.stringify(value.mentions.map(item => item.id)) === JSON.stringify(input.mentions)
    && JSON.stringify(value.attachments.map(item => item.id)) === JSON.stringify(input.upload_store_ids);
}
export function parseGroupRecovery(raw: string | null): Recovery[] {
  if (!raw) return [];
  const items: unknown = JSON.parse(raw);
  if (!Array.isArray(items) || items.length > 100) throw new Error("Invalid recovery records");
  return items.flatMap((value): Recovery[] => {
    if (!value || typeof value !== "object" || typeof value.group_id !== "string" || typeof value.operation_id !== "string"
      || !uuid.test(value.group_id) || !uuid.test(value.operation_id)) throw new Error("Invalid recovery record");
    const base = { group_id: value.group_id as string, operation_id: value.operation_id as string };
    if (value.kind === "SEND") return [{ ...base, kind: "SEND" }];
    if (value.kind === "REACTION" && typeof value.target_message_id === "string" && uuid.test(value.target_message_id)) return [{ ...base, kind: "REACTION", target_message_id: value.target_message_id }];
    if (typeof value.message_id !== "string" || !uuid.test(value.message_id)) throw new Error("Invalid recovery target");
    if (value.kind === "CREATE") return [{ ...base, kind: "CREATE", message_id: value.message_id }];
    if (value.kind === "LINK" && typeof value.target_ticket_number === "string" && /^[1-9][0-9]{0,15}$/u.test(value.target_ticket_number)) return [{ ...base, kind: "LINK", message_id: value.message_id, target_ticket_number: value.target_ticket_number }];
    throw new Error("Invalid recovery kind");
  });
}

// Authorized binary response only; no native URLs, arbitrary URLs or autoplay.
function GroupMedia({ groupId, message, headers, accessDenied, visible }: { groupId: string; message: Message; headers: Record<string, string>; accessDenied: (groupId?: string) => void; visible: boolean }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true);
  const objectUrl = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = visible; return () => { active.current = false; controller.current?.abort();
    if (objectUrl.current) { URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; } }; }, [visible]);
  const load = async () => {
    if (busy || !visible) return;
    const executionController = new AbortController();
    controller.current = executionController;
    const currentLoad = () => active.current && controller.current === executionController && !executionController.signal.aborted;
    setBusy(true); setFailed(false);
    try {
      const response = await fetch("/api/inbox/group-media", { method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ group_id: groupId, message_id: message.id }), signal: executionController.signal });
      if (!currentLoad()) return;
      if (response.status === 401 || response.status === 403) {
        const failure = await response.json().catch(() => null) as { code?: string; group_id?: string } | null;
        if (!currentLoad()) return;
        accessDenied(response.status === 403 && failure?.code === "GROUP_ACCESS_DENIED" && failure.group_id === groupId ? groupId : undefined);
      }
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (!currentLoad()) return;
      // Server must enforce safe response MIME and nosniff; documents always download.
      objectUrl.current = URL.createObjectURL(blob); setUrl(objectUrl.current);
    } catch { if (currentLoad()) setFailed(true); }
    finally { if (currentLoad()) setBusy(false); }
  };
  return <div className="wx-group-media">
    {!url ? <button type="button" className="wx-button wx-button-secondary" disabled={busy} onClick={() => void load()}>
      {t(busy ? "groups.loading" : "groups.loadMedia", { filename: message.media_filename || t("groups.attachment") })}</button> : <>
      {/* eslint-disable-next-line @next/next/no-img-element -- Authorized in-memory blob URLs cannot use the remote image optimizer. */}
      {message.media_kind === "image" && /^image\/(png|jpeg|gif|webp)$/u.test(message.media_mime_type ?? "") ? <img src={url} alt={t("groups.imageAttachment")} /> : null}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Customer-provided audio has no supplied transcript; the limitation is disclosed below. */}
      {message.media_kind === "audio" ? <audio controls preload="none" src={url} aria-label={t("groups.audioAttachment")} /> : null}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- Customer-provided video has no supplied caption track; the limitation is disclosed below. */}
      {message.media_kind === "video" ? <video controls preload="none" src={url} aria-label={t("groups.videoAttachment")} /> : null}
      {message.media_kind === "video" || message.media_kind === "audio" ? <p>{t("groups.noTranscript")}</p> : null}
      <a className="wx-button wx-button-secondary" href={url} download={message.media_filename || "attachment"}>
        {t("groups.download", { filename: message.media_filename || t("groups.attachment") })}</a>
    </>}
    {failed ? <p role="alert">{t("groups.mediaFailed")}</p> : null}
  </div>;
}

type GroupInboxProps = {
  selectedGroup: string | null; selectedMessage?: string | null; selectGroup: (groupId: string | null) => void;
  selectTicket: (ticketNumber: string) => void; mutationHeaders: Record<string, string>;
  canWrite: boolean; scope: string; recoveryScope: string; active?: boolean;
};

export function GroupInbox(props: GroupInboxProps) {
  return <GroupInboxSession key={JSON.stringify([props.scope, props.recoveryScope])} {...props} />;
}

function GroupInboxSession({ selectedGroup, selectedMessage = null, selectGroup, selectTicket, mutationHeaders, canWrite, scope, recoveryScope, active = true }: GroupInboxProps) {
  const { t, locale, direction } = useI18n();
  const [groups, setGroups] = useState<Group[]>([]), [groupCursor, setGroupCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Scope>("MY"), [group, setGroup] = useState<Group | null>(null);
  const [messages, setMessages] = useState<Message[]>([]), [older, setOlder] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]), [ticketCursor, setTicketCursor] = useState<string | null>(null);
  const [ticketFilter, setTicketFilter] = useState<"OPEN" | "CLOSED" | "ALL">("OPEN");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [recovery, setRecovery] = useState<Recovery[]>([]), [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryStates, setRecoveryStates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [following, setFollowing] = useState(true), [incoming, setIncoming] = useState(0), [contextMode, setContextMode] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]), [participantQuery, setParticipantQuery] = useState("");
  const [participantOpen, setParticipantOpen] = useState(false);
  const [action, setAction] = useState<{ message: Message; mode: "create" | "link" } | null>(null);
  const [title, setTitle] = useState(""), [team, setTeam] = useState(""), [number, setNumber] = useState("");
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [recording, setRecording] = useState(false);
  const timeline = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null), chooser = useRef<HTMLSelectElement>(null);
  const heading = useRef<HTMLHeadingElement>(null), latest = useRef<HTMLLIElement>(null);
  const current = useRef({ group: selectedGroup, scope, filter, ticketFilter, active, canWrite, context: selectedMessage });
  const submittedSends = useRef(new Map<string, SendInput>());
  const mounted = useRef(true), inFlight = useRef(false), authorization = useRef(0);
  const deniedGroups = useRef(new Set<string>());
  const groupEpoch = useRef(new Map<string, number>());
  const messageSequence = useRef(0), listSequence = useRef(0), ticketSequence = useRef(0), participantSequence = useRef(0);
  useLayoutEffect(() => { messageSequence.current++; current.current.context = selectedMessage; }, [active, selectedGroup, selectedMessage, scope]);
  const messagesRef = useRef(messages);
  const [contextTarget, setContextTarget] = useState<{ id: string; sequence: number } | null>(null);
  const [readView, setReadView] = useState<{ groupId: string; sequence: number } | null>(null);
  const unreadSnapshot = useRef(new Set<string>()), readPending = useRef(false), lastRead = useRef("");
  const recorder = useRef<Recording | null>(null);
  const recordingGeneration = useRef(0);
  const recordStarting = useRef(false);
  const draftsRef = useRef(drafts);
  const recoveryRef = useRef(recovery);
  const followingRef = useRef(following);
  useLayoutEffect(() => {
    current.current = { ...current.current, group: selectedGroup, scope, filter, ticketFilter, active, canWrite };
    messagesRef.current = messages; draftsRef.current = drafts;
    recoveryRef.current = recovery; followingRef.current = following;
  }, [selectedGroup, scope, filter, ticketFilter, active, canWrite, messages, drafts, recovery, following]);
  // Stable tenant + portal-user namespace survives session/grant revisions; scope fences live access.
  const storageKey = `wasalx:group-receipts:${recoveryScope}`;
  const initializedStorage = useRef<string | null>(null);
  const draft = selectedGroup ? drafts[selectedGroup] : undefined;
  const unresolved = recovery.some(item => item.group_id === selectedGroup);
  const writable = Boolean(canWrite && group?.send_available && !busy && !unresolved && recoveryReady && !denied);
  const relevant = (groupId: string, boundary: string, generation: number, groupGeneration?: number) => mounted.current && current.current.group === groupId
    && current.current.active && current.current.scope === boundary && authorization.current === generation
    && (groupGeneration === undefined || (groupEpoch.current.get(groupId) ?? 0) === groupGeneration) && !deniedGroups.current.has(groupId);
  const stopRecording = (discard: boolean) => {
    const active = recorder.current;
    if (active) { active.discard = discard; clearTimeout(active.timer); if (active.instance.state !== "inactive") active.instance.stop(); active.stream.getTracks().forEach(track => track.stop()); }
    setRecording(false);
  };
  const clearAccess = useCallback(() => {
    authorization.current++; messageSequence.current++; listSequence.current++; ticketSequence.current++; participantSequence.current++;
    setDenied(true); setGroup(null); setGroups([]); setMessages([]); setTickets([]); setDrafts({}); draftsRef.current = {};
    submittedSends.current.clear(); setParticipants([]); setParticipantQuery(""); setAction(null); setTitle(""); setNumber(""); setTeam("");
    const active = recorder.current;
    if (active) { active.discard = true; clearTimeout(active.timer); if (active.instance.state !== "inactive") active.instance.stop(); active.stream.getTracks().forEach(track => track.stop()); }
    setRecording(false); setError(t("groups.denied"));
  }, [t]);
  const clearGroupAccess = useCallback((groupId: string) => {
    groupEpoch.current.set(groupId, (groupEpoch.current.get(groupId) ?? 0) + 1);
    deniedGroups.current.add(groupId);
    setGroups(values => values.filter(value => value.id !== groupId));
    setDrafts(values => { const next = { ...values }; delete next[groupId]; draftsRef.current = next; return next; });
    for (const [token, value] of submittedSends.current) if (value.group_id === groupId) submittedSends.current.delete(token);
    if (current.current.group !== groupId) return;
    messageSequence.current++; ticketSequence.current++; participantSequence.current++;
    setDenied(true); setGroup(null); setMessages([]); setTickets([]); setParticipants([]); setAction(null);
    setTitle(""); setNumber(""); setParticipantQuery("");
    const active = recorder.current;
    if (active?.group === groupId) { active.discard = true; clearTimeout(active.timer); active.stream.getTracks().forEach(track => track.stop()); if (active.instance.state !== "inactive") active.instance.stop(); }
    setRecording(false); setError(t("groups.denied"));
  }, [t]);
  const request = useCallback(async <K extends keyof Contract>(operation: K, input: Contract[K]["input"], signal?: AbortSignal): Promise<Contract[K]["output"]> => {
    const boundary = scope, generation = authorization.current;
    const groupId = "group_id" in input && typeof input.group_id === "string" ? input.group_id : null;
    const groupGeneration = groupId ? groupEpoch.current.get(groupId) ?? 0 : 0;
    const currentAccess = () => !signal?.aborted && mounted.current && current.current.scope === boundary
      && authorization.current === generation && (!groupId || (groupEpoch.current.get(groupId) ?? 0) === groupGeneration);
    const stale = () => new DOMException("Stale workspace", "AbortError");
    const response = await fetch("/api/inbox", { method: "POST", cache: "no-store", signal,
      headers: { ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({ operation, input }) });
    if (!currentAccess()) throw stale();
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { code?: string; effect?: string; terminal?: boolean; group_id?: string } | null;
      // A sibling denial may abort this body; it must not become a workspace-wide denial.
      if (!currentAccess()) throw stale();
      if (response.status === 401 || response.status === 403) {
        if (response.status === 403 && groupId && failure?.code === "GROUP_ACCESS_DENIED" && failure.group_id === groupId) clearGroupAccess(groupId);
        else clearAccess();
      }
      const noEffect = failure?.code === "GROUP_OPERATION_REJECTED" && failure.effect === "NONE" && failure.terminal === true;
      throw Object.assign(operatorLocalFailure(t(response.status === 409 ? "groups.conflict" : "groups.failed")), { status: response.status, noEffect });
    }
    const value = await response.json();
    if (!currentAccess()) throw stale();
    return value as Contract[K]["output"];
  }, [clearAccess, clearGroupAccess, mutationHeaders, scope, t]);
  const updateDraft = (groupId: string, change: (value: Draft) => Draft) => setDrafts(values => ({ ...values, [groupId]: change(values[groupId] ?? emptyDraft()) }));
  const persistRecovery = (items: Recovery[]) => {
    // No customer text, filenames, uploads, phone numbers or authentication material.
    if (items.length > 100) throw operatorLocalFailure(t("groups.recoveryLimit"));
    sessionStorage.setItem(storageKey, JSON.stringify(items));
    recoveryRef.current = items; setRecovery(items);
  };
  const removeRecovery = (token: string) => persistRecovery(recoveryRef.current.filter(item => item.operation_id !== token));
  useEffect(() => {
    mounted.current = true;
    const boundary = authorization;
    return () => { mounted.current = false; boundary.current++; const active = recorder.current;
      if (active) { active.discard = true; clearTimeout(active.timer); active.stream.getTracks().forEach(track => track.stop()); if (active.instance.state !== "inactive") active.instance.stop(); } };
  }, []);
  useEffect(() => {
    if (initializedStorage.current === storageKey) return;
    const timer = window.setTimeout(() => {
      initializedStorage.current = storageKey;
      try { const items = parseGroupRecovery(sessionStorage.getItem(storageKey)); recoveryRef.current = items; setRecovery(items); setRecoveryReady(true); }
      catch { setRecoveryReady(false); setError(t("groups.storageUnavailable")); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey, t]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.values(draftsRef.current).some(value => value.text || value.quote || value.attachments.length || value.mentions.length) || recoveryRef.current.length) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const loadGroups = useCallback(async (after?: string, signal?: AbortSignal) => {
    const sequence = ++listSequence.current, generation = authorization.current;
    const page = await request("GROUP_LIST", { scope: filter, ...(after ? { after } : {}), ...(selectedGroup ? { selected: selectedGroup } : {}) }, signal);
    if (signal?.aborted || sequence !== listSequence.current || authorization.current !== generation
      || !current.current.active || current.current.filter !== filter || current.current.group !== selectedGroup || current.current.scope !== scope) return;
    const visibleItems = page.items.filter(item => !deniedGroups.current.has(item.id));
    setGroups(values => after ? mergeById(values, visibleItems) : visibleItems); setGroupCursor(page.next_cursor);
  }, [filter, request, selectedGroup, scope]);
  const loadTickets = useCallback(async (before?: string, signal?: AbortSignal) => {
    if (!selectedGroup) return;
    const boundary = scope, groupId = selectedGroup, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0, sequence = ++ticketSequence.current;
    const page = await request("GROUP_TICKETS", { group_id: groupId, state: ticketFilter, ...(before ? { before } : {}) }, signal);
    if (signal?.aborted || !relevant(groupId, boundary, generation, groupGeneration) || sequence !== ticketSequence.current || current.current.ticketFilter !== ticketFilter) return;
    setTickets(values => before ? [...values, ...page.items.filter(item => !values.some(old => old.ticket_number === item.ticket_number))] : page.items);
    setTicketCursor(page.next_cursor);
  }, [request, scope, selectedGroup, ticketFilter]);
  const markVisibleRead = async () => {
    const region = timeline.current, item = latest.current;
    if (!active || !canWrite || !current.current.canWrite || denied || loading || !group || contextMode || current.current.context
      || !readView || readView.groupId !== group.id || readView.sequence !== messageSequence.current
      || !followingRef.current || !region || !item || document.visibilityState !== "visible" || !region.getClientRects().length) return;
    const box = item.getBoundingClientRect(), bounds = region.getBoundingClientRect();
    if (box.bottom > bounds.bottom + 2 || box.bottom < bounds.top || bounds.top >= innerHeight || bounds.bottom <= 0) return;
    const messageId = item.dataset.messageId;
    if (!messageId || readPending.current || lastRead.current === `${group.id}:${messageId}`) return;
    const groupId = group.id, boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0;
    if (!relevant(groupId, boundary, generation, groupGeneration)) return;
    const sequence = readView.sequence;
    readPending.current = true;
    try { await request("GROUP_READ", { group_id: groupId, message_id: messageId });
      if (relevant(groupId, boundary, generation, groupGeneration) && current.current.canWrite && !current.current.context && sequence === messageSequence.current) {
        lastRead.current = `${groupId}:${messageId}`; setGroups(values => values.map(value => value.id === groupId ? { ...value, unread_count: 0 } : value));
      }
    } catch { /* A read-marker failure never claims the messages were read. */ }
    finally { readPending.current = false; }
  };
  const loadMessages = useCallback(async (signal?: AbortSignal, before?: string, contextId?: string) => {
    if (!selectedGroup) return;
    const groupId = selectedGroup, boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0;
    if (!relevant(groupId, boundary, generation, groupGeneration)) return;
    const previousSequence = messageSequence.current, sequence = ++messageSequence.current;
    // Historical intent fences read markers and refreshes before its response arrives.
    if (!before) { current.current.context = contextId ?? null; if (contextId) setContextMode(true); }
    const region = timeline.current, previousHeight = region?.scrollHeight ?? 0, previousTop = region?.scrollTop ?? 0;
    const page = contextId ? await request("GROUP_CONTEXT", { group_id: groupId, message_id: contextId }, signal)
      : await request("GROUP_MESSAGES", { group_id: groupId, ...(before ? { before } : {}) }, signal);
    if (signal?.aborted || !relevant(groupId, boundary, generation, groupGeneration) || sequence !== messageSequence.current) return;
    if (contextId && !page.items.some(item => item.id === contextId)) throw operatorLocalFailure(t("inbox.sourceUnavailable"));
    const values = messagesRef.current;
    if (before) setMessages(mergeById(values, page.items));
    else if (!followingRef.current && !contextId) {
      page.items.filter(item => !values.some(old => old.id === item.id)).forEach(item => unreadSnapshot.current.add(item.id));
      setIncoming(unreadSnapshot.current.size);
      setMessages(values.map(old => page.items.find(item => item.id === old.id) ?? old));
    } else setMessages(page.items);
    setOlder(page.next_cursor);
    if (!before) { setContextMode(Boolean(contextId)); setContextTarget(contextId ? { id: contextId, sequence } : null); }
    if (!contextId) setReadView(previous => !before || (previous?.groupId === groupId && previous.sequence === previousSequence)
      ? { groupId, sequence } : null);
    // Revoke actions only on authoritative updated rows, never on an absent history row.
    const invalid = page.items.filter(item => item.latest_mutation === "REVOKED" || !item.quote_allowed).map(item => item.id);
    setDrafts(values => { const value = values[groupId]; return value?.quote && invalid.includes(value.quote.id)
      ? { ...values, [groupId]: { ...value, quote: null } } : values; });
    setAction(value => value && page.items.some(item => item.id === value.message.id && (item.latest_mutation === "REVOKED" || !item.ticket_creatable)) ? null : value);
    requestAnimationFrame(() => {
      if (!relevant(groupId, boundary, generation, groupGeneration) || sequence !== messageSequence.current || !timeline.current) return;
      if (contextId) return;
      if (before) timeline.current.scrollTop = previousTop + timeline.current.scrollHeight - previousHeight;
      else if (followingRef.current) timeline.current.scrollTop = timeline.current.scrollHeight;
    });
  }, [request, scope, selectedGroup, t]);
  const run = async (work: () => Promise<unknown>) => {
    if (inFlight.current) return;
    const boundary = scope, generation = authorization.current;
    inFlight.current = true; setBusy(true); setError(null);
    try { await work(); } catch (failure) { if (mounted.current && current.current.scope === boundary && authorization.current === generation
      && !(failure instanceof DOMException && failure.name === "AbortError")) setError(operatorFailureMessage(failure, t("groups.failed"))); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadGroups(undefined, controller.signal).catch(failure => { if (!controller.signal.aborted && !isAbortError(failure)) setError(operatorFailureMessage(failure, t("groups.failed"))); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, loadGroups, t]);
  useEffect(() => {
    recordingGeneration.current++;
    const capture = recorder.current;
    if (capture) { capture.discard = true; clearTimeout(capture.timer); capture.stream.getTracks().forEach(track => track.stop()); if (capture.instance.state !== "inactive") capture.instance.stop(); }
    const resetRecording = window.setTimeout(() => setRecording(false), 0);
    if (!active) return () => window.clearTimeout(resetRecording);
    const controller = new AbortController();
    const groupId = selectedGroup, boundary = scope, generation = authorization.current, groupGeneration = groupId ? groupEpoch.current.get(groupId) ?? 0 : 0;
    const sequenceFence = messageSequence;
    const timer = window.setTimeout(() => {
      setGroup(null); setMessages([]); setAction(null); setParticipants([]); setParticipantOpen(false); setIncoming(0); setFollowing(true); followingRef.current = true; setContextMode(false); setContextTarget(null); unreadSnapshot.current.clear(); lastRead.current = "";
      if (!groupId) return;
      setLoading(true);
      void Promise.all([request("GROUP_SHOW", { group_id: groupId }, controller.signal), loadMessages(controller.signal, undefined, current.current.context ?? undefined)]).then(([value]) => {
        if (!controller.signal.aborted && relevant(groupId, boundary, generation, groupGeneration)) {
          setGroup(value); setDenied(false);
        }
      }).catch(failure => { if (!controller.signal.aborted && !isAbortError(failure)) setError(operatorFailureMessage(failure, t("groups.failed"))); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(resetRecording); window.clearTimeout(timer); controller.abort(); sequenceFence.current++; };
  }, [active, selectedGroup, selectedMessage, request, loadMessages, scope, t]);
  useEffect(() => {
    if (!active || loading || !group?.id || contextTarget) return;
    const frame = requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [active, loading, group?.id, contextTarget]);
  useEffect(() => {
    if (!active || loading || !group?.id || !contextTarget) return;
    const frame = requestAnimationFrame(() => {
      if (contextTarget.sequence !== messageSequence.current) return;
      const target = document.getElementById(`wx-group-message-${contextTarget.id}`);
      target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, loading, group?.id, contextTarget]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setTickets([]);
      void loadTickets(undefined, controller.signal).catch(failure => { if (!controller.signal.aborted && !isAbortError(failure)) setError(operatorFailureMessage(failure, t("groups.failed"))); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [active, loadTickets, t]);
  useEffect(() => {
    if (!active || !participantOpen || !selectedGroup) return;
    const controller = new AbortController(), sequence = ++participantSequence.current;
    const boundary = scope, groupId = selectedGroup, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0;
    const timer = window.setTimeout(() => { void request("GROUP_PARTICIPANTS", { group_id: groupId, query: participantQuery }, controller.signal)
      .then(values => { if (!controller.signal.aborted && relevant(groupId, boundary, generation, groupGeneration) && sequence === participantSequence.current) setParticipants(values); })
      .catch(failure => { if (!controller.signal.aborted && !isAbortError(failure)) setError(t("groups.participantsFailed")); }); }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, participantOpen, participantQuery, request, scope, selectedGroup, t]);
  useVisibleRefresh(async signal => {
    try { await request("GROUP_CHECK", selectedGroup ? { group_id: selectedGroup } : {}, signal); }
    catch (failure) { if (!signal?.aborted && !isAbortError(failure) && ![401, 403].includes((failure as { status?: number }).status ?? 0)) setError(t("groups.stale")); }
  }, active);
  useVisibleRefresh(async signal => {
    try {
      await loadGroups(undefined, signal);
      if (selectedGroup) {
        const groupId = selectedGroup, boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0;
        const value = await request("GROUP_SHOW", { group_id: groupId }, signal);
        if (!signal?.aborted && relevant(groupId, boundary, generation, groupGeneration)) setGroup(value);
      }
      if (!current.current.context) await loadMessages(signal);
      await loadTickets(undefined, signal);
    }
    catch (failure) { if (!signal?.aborted && !isAbortError(failure)) setError(t("groups.stale")); }
  }, active && !busy && !denied);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void markVisibleRead());
    return () => cancelAnimationFrame(frame);
  });

  const mutate = async (intent: Intent) => {
    const groupId = intent.input.group_id, boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0;
    if (!canWrite || denied || !recoveryReady || recoveryRef.current.some(item => item.group_id === groupId)) return;
    const base = { group_id: groupId, operation_id: intent.input.request_token };
    const receipt: Recovery = intent.operation === "GROUP_SEND" ? { ...base, kind: "SEND" }
      : intent.operation === "GROUP_REACTION" ? { ...base, kind: "REACTION", target_message_id: intent.input.message_id }
      : intent.operation === "GROUP_CREATE_TICKET" ? { ...base, kind: "CREATE", message_id: intent.input.message_id }
      : { ...base, kind: "LINK", message_id: intent.input.message_id, target_ticket_number: intent.input.ticket_number };
    // Persist before dispatch; storage failure blocks the write rather than losing the retry fence.
    persistRecovery([...recoveryRef.current, receipt]);
    if (intent.operation === "GROUP_SEND") submittedSends.current.set(receipt.operation_id, intent.input);
    let result: { accepted: true; ticket_number?: string };
    try {
      // Discriminated union is split here so each gateway call preserves its typed input.
      switch (intent.operation) {
        case "GROUP_SEND": result = await request(intent.operation, intent.input); break;
        case "GROUP_REACTION": result = await request(intent.operation, intent.input); break;
        case "GROUP_CREATE_TICKET": result = await request(intent.operation, intent.input); break;
        case "GROUP_LINK_TICKET": result = await request(intent.operation, intent.input); break;
      }
    } catch (failure) {
      // A native saga may be partial even when its last HTTP step failed with 4xx.
      // Only authoritative operation recovery may release this fence.
      if (failure instanceof DOMException && failure.name === "AbortError") throw failure;
      if ((failure as { noEffect?: boolean }).noEffect === true) { removeRecovery(receipt.operation_id); submittedSends.current.delete(receipt.operation_id); throw operatorLocalFailure(t("groups.failed")); }
      throw operatorLocalFailure(t("groups.unknown"));
    }
    if (current.current.scope !== boundary || !mounted.current || authorization.current !== generation || (groupEpoch.current.get(groupId) ?? 0) !== groupGeneration) return;
    if (receipt.kind === "CREATE" || receipt.kind === "LINK") {
      const confirmation = await request("GROUP_TICKET_RECEIPT", { ...receipt, action: "LOOKUP" });
      setRecoveryStates(values => ({ ...values, [receipt.operation_id]: confirmation.state }));
      if (confirmation.state !== "COMPLETE") { setNotice(t(confirmation.state === "PARTIAL" ? "groups.partialLink" : "groups.pending")); return; }
    }
    removeRecovery(receipt.operation_id);
    if (intent.operation === "GROUP_SEND") setDrafts(values => {
      const value = values[groupId];
      return value && groupDraftMatchesSend(value, intent.input) ? { ...values, [groupId]: emptyDraft() } : values;
    });
    submittedSends.current.delete(receipt.operation_id);
    if (!relevant(groupId, boundary, generation, groupGeneration)) return;
    setNotice(t("groups.accepted")); setAction(null);
    if (result.ticket_number) setNotice(t("groups.ticketSaved", { number: result.ticket_number }));
    await loadMessages(undefined, undefined, current.current.context ?? undefined); await loadTickets();
  };
  const reconcile = async (receipt: Recovery, mode: "lookup" | "cancel" | "repair" = "lookup") => {
    const boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(receipt.group_id) ?? 0;
    if (mode !== "lookup" && (!canWrite || denied)) return;
    const result = "message_id" in receipt
      ? mode === "repair" ? await request("GROUP_REPAIR_TICKET_LINK", receipt)
        : await request("GROUP_TICKET_RECEIPT", { ...receipt, action: mode === "cancel" ? "CANCEL_IF_UNADMITTED" : "LOOKUP" })
      : await request("GROUP_RECEIPT", { ...receipt, action: mode === "cancel" ? "CANCEL_IF_UNADMITTED" : "LOOKUP" });
    if (!relevant(receipt.group_id, boundary, generation, groupGeneration)) return;
    setRecoveryStates(values => ({ ...values, [receipt.operation_id]: result.state }));
    if (result.state === "UNKNOWN" || result.state === "PARTIAL") { setNotice(t(result.state === "PARTIAL" ? "groups.partialLink" : "groups.pending")); return; }
    if ((result.state === "NOT_APPLIED" || result.state === "CANCELLED") && (!("terminal" in result) || result.terminal !== true)) { setNotice(t("groups.pending")); return; }
    removeRecovery(receipt.operation_id);
    const submitted = submittedSends.current.get(receipt.operation_id);
    if (result.state === "ADMITTED" && receipt.kind === "SEND" && submitted) setDrafts(values => {
      const value = values[receipt.group_id]; return value && groupDraftMatchesSend(value, submitted) ? { ...values, [receipt.group_id]: emptyDraft() } : values;
    });
    submittedSends.current.delete(receipt.operation_id);
    setNotice(t(result.state === "ADMITTED" ? "groups.admitted" : result.state === "COMPLETE" ? "groups.ticketLinkComplete" : "groups.notApplied"));
    await loadMessages(undefined, undefined, current.current.context ?? undefined); await loadTickets();
  };
  const upload = async (files: File[], target: string) => {
    const activeGroup = group;
    if (!activeGroup || activeGroup.id !== target || !writable) return;
    const boundary = scope, generation = authorization.current, value = draftsRef.current[target] ?? emptyDraft();
    const groupGeneration = groupEpoch.current.get(target) ?? 0;
    const currentUpload = () => mounted.current && current.current.scope === boundary && authorization.current === generation
      && !deniedGroups.current.has(target) && (groupEpoch.current.get(target) ?? 0) === groupGeneration;
    const caps = activeGroup.media_capabilities;
    if (value.attachments.length + files.length > caps.maximum_files || value.attachments.reduce((sum, file) => sum + file.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > caps.maximum_total_bytes
      || files.some(file => !caps.accepted.some(rule => rule.mime_type === file.type && file.size <= rule.maximum_bytes))) throw operatorLocalFailure(t("groups.fileRejected"));
    // Proposed actor/group/cache-bound binary adapter; gateway owns staging grants and validation.
    updateDraft(target, old => ({ ...old, cache: value.cache }));
    const headers = { ...mutationHeaders }; delete headers["content-type"]; delete headers["Content-Type"];
    for (const file of files) {
      if (!currentUpload()) return;
      const body = new FormData(); body.set("group_id", target); body.set("upload_cache_id", value.cache); body.append("files", file, file.name);
      const response = await fetch("/api/inbox/group-upload", { method: "POST", headers, body });
      if (response.status === 401 || response.status === 403) {
        const failure = await response.json().catch(() => null) as { code?: string; group_id?: string } | null;
        if (!currentUpload()) return;
        if (response.status === 403 && failure?.code === "GROUP_ACCESS_DENIED" && failure.group_id === target) clearGroupAccess(target);
        else clearAccess();
      }
      if (!response.ok) throw operatorLocalFailure(t("groups.uploadFailed"));
      const result: { items: Upload[] } = await response.json();
      if (!currentUpload()) {
        // Scope loss forbids sending cleanup with replacement credentials; the actor-bound cache expires server-side.
        return;
      }
      // Commit each acknowledged file before the next request; later failures retain earlier staged files.
      updateDraft(target, old => ({ ...old, attachments: [...old.attachments, ...result.items] }));
    }
  };
  const startVoice = async () => {
    if (!selectedGroup || !group?.media_capabilities.voice_recording || !writable || recordStarting.current || recorder.current) return;
    const mime = typeof MediaRecorder === "undefined" ? undefined : ["audio/webm;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
    if (!mime || !navigator.mediaDevices?.getUserMedia) { setError(t("groups.voiceUnavailable")); return; }
    const groupId = selectedGroup, boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0, captureGeneration = recordingGeneration.current;
    const media = group.media_capabilities, existing = draftsRef.current[groupId]?.attachments ?? [];
    const maxBytes = Math.min(media.accepted.find(rule => rule.mime_type === "audio/webm")?.maximum_bytes ?? 0,
      media.maximum_total_bytes - existing.reduce((sum, file) => sum + file.size, 0));
    if (maxBytes <= 0 || existing.length >= media.maximum_files) { setError(t("groups.fileRejected")); return; }
    recordStarting.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!relevant(groupId, boundary, generation, groupGeneration) || captureGeneration !== recordingGeneration.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const instance = new MediaRecorder(stream, { mimeType: mime });
      const active: Recording = { instance, stream, discard: false, group: groupId, scope: boundary };
      recorder.current = active;
      const chunks: BlobPart[] = [];
      let bytes = 0;
      instance.ondataavailable = event => {
        bytes += event.data.size;
        if (bytes > maxBytes) { active.discard = true; chunks.length = 0; stopRecording(true); setError(t("groups.recordingTooLarge")); return; }
        if (!active.discard && event.data.size) chunks.push(event.data);
      };
      instance.onstop = () => {
        clearTimeout(active.timer); stream.getTracks().forEach(track => track.stop()); recorder.current = null; setRecording(false);
        if (!active.discard && relevant(groupId, boundary, generation, groupGeneration)) void run(() => upload([new File(chunks, "voice-message.webm", { type: "audio/webm" })], groupId));
        else chunks.length = 0;
      };
      instance.onerror = () => { active.discard = true; clearTimeout(active.timer); stream.getTracks().forEach(track => track.stop()); recorder.current = null; setRecording(false); setError(t("groups.voiceFailed")); };
      instance.start(1000); setRecording(true);
      // Bounded recording; main must align this with advertised native byte/duration limits.
      active.timer = setTimeout(() => { if (recorder.current === active) stopRecording(false); }, 60_000);
    } catch { setError(t("groups.voiceFailed")); }
    finally { recordStarting.current = false; }
  };
  const openTicketAction = (message: Message, mode: "create" | "link") => {
    setAction({ message, mode }); setTitle((message.message_text || group?.name || "").slice(0, 200)); setNumber(""); setTeam(""); setTeams([]);
    if (mode === "create") void run(async () => {
      const groupId = selectedGroup, boundary = scope, generation = authorization.current, groupGeneration = groupId ? groupEpoch.current.get(groupId) ?? 0 : 0;
      const values = await request("GROUP_TEAMS", {});
      if (groupId && relevant(groupId, boundary, generation, groupGeneration)) { setTeams(values); setTeam(values[0]?.id ?? ""); }
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!group || !writable || !draft || recording || (!draft.text.trim() && !draft.attachments.length)) return;
    const input: SendInput = { group_id: group.id, request_token: crypto.randomUUID(), message: draft.text,
      mentions: draft.mentions.map(item => item.id), upload_cache_id: draft.cache, upload_store_ids: draft.attachments.map(item => item.id),
      ...(draft.quote ? { reply_to_message_id: draft.quote.id } : {}) };
    void run(() => mutate({ operation: "GROUP_SEND", input }));
  };
  const jumpLatest = () => { setFollowing(true); followingRef.current = true; setIncoming(0); unreadSnapshot.current.clear(); void run(() => loadMessages()); };
  const formatTime = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const actionable = (message: Message) => message.latest_mutation !== "REVOKED";
  const button = "wx-button wx-button-secondary";
  return <section className="wx-group" dir={direction} aria-label={t("groups.title")}>
    {error ? <div className="wx-group-feedback" role="alert"><p>{error}</p><button type="button" className={button} disabled={busy} onClick={() => void run(async () => {
      const groupId = selectedGroup, boundary = scope, generation = authorization.current;
      const groupGeneration = groupId ? groupEpoch.current.get(groupId) ?? 0 : 0;
      await request("GROUP_CHECK", groupId ? { group_id: groupId } : {});
      const value = groupId ? await request("GROUP_SHOW", { group_id: groupId }) : null;
      if (!mounted.current || current.current.scope !== boundary || current.current.group !== groupId || authorization.current !== generation
        || (groupId && (groupEpoch.current.get(groupId) ?? 0) !== groupGeneration)) return;
      if (groupId) deniedGroups.current.delete(groupId);
      setDenied(false); setError(null); if (value) setGroup(value);
      await loadGroups();
      if (groupId) { await loadMessages(undefined, undefined, current.current.context ?? undefined); await loadTickets(); }
    })}>{t("groups.reload")}</button></div> : null}
    <p role="status" className="wx-group-notice">{notice}</p>
    {recovery.filter(item => item.group_id === selectedGroup).map(item => <div className="wx-group-feedback" key={item.operation_id}>
      <p>{t("groups.unknown")}</p><button type="button" className={button} disabled={busy} onClick={() => void run(() => reconcile(item))}>{t("groups.checkSubmission")}</button>
      {recoveryStates[item.operation_id] === "PARTIAL" ? <button type="button" className={button} disabled={busy || !canWrite || denied}
        onClick={() => void run(() => reconcile(item, "repair"))}>{t("groups.finishTicketLink")}</button>
        : <button type="button" className={button} disabled={busy || !canWrite || denied}
          onClick={() => void run(() => reconcile(item, "cancel"))}>{t(item.kind === "SEND" || item.kind === "REACTION" ? "groups.cancelIfUnadmitted" : "groups.cancelTicketIfUnadmitted")}</button>}
    </div>)}
    <div className="wx-group-layout" data-selected={Boolean(selectedGroup)}>
      <aside className="wx-group-list" aria-label={t("groups.title")}>
        <label htmlFor="wx-group-scope">{t("groups.scope")}<select id="wx-group-scope" ref={chooser} value={filter} onChange={event => setFilter(event.target.value as Scope)}>
          {(["MY", "TEAM", "UNASSIGNED", "ALL"] as const).map(value => <option key={value} value={value}>{t(`groups.scope.${value}`)}</option>)}
        </select></label>
        {!groups.length ? <p>{t("groups.empty")}</p> : <ul>{groups.map(item => <li key={item.id}><button type="button" className="wx-group-choice"
          aria-current={selectedGroup === item.id ? "true" : undefined} onClick={() => selectGroup(item.id)}>
          <b dir="auto">{item.name}</b><span>{t(`groups.scope.${item.access_scope}`)}</span>
          {item.unread_count ? <span>{t("groups.unread", { count: new Intl.NumberFormat(locale).format(item.unread_count) })}</span> : null}
        </button></li>)}</ul>}
        {groupCursor ? <button type="button" className={button} disabled={busy} onClick={() => void run(() => loadGroups(groupCursor))}>{t("groups.moreGroups")}</button> : null}
      </aside>
      <div className="wx-group-conversation" aria-busy={loading}>
        <button type="button" className={`${button} wx-group-back`} onClick={() => { selectGroup(null); requestAnimationFrame(() => chooser.current?.focus()); }}>{t("groups.back")}</button>
        {loading ? <p>{t("groups.loading")}</p> : !group ? <p>{t(selectedGroup ? "groups.unavailable" : "groups.choose")}</p> : <>
          <header className="wx-group-header"><h2 ref={heading} tabIndex={-1} dir="auto">{group.name}</h2><span>{t("groups.whatsapp")}</span></header>
          <ScrollRegion ref={timeline} className="wx-group-history" aria-label={t("groups.history")} onScroll={() => {
            const region = timeline.current; if (!region) return;
            const near = region.scrollHeight - region.scrollTop - region.clientHeight < 64;
            setFollowing(near); followingRef.current = near; if (near) void markVisibleRead();
          }}>
            {older ? <button type="button" className={button} disabled={busy} onClick={() => void run(() => loadMessages(undefined, older))}>{t("groups.older")}</button> : null}
            <ol className="wx-group-messages">{[...messages].reverse().map(message => <li key={message.id} id={`wx-group-message-${message.id}`}
              tabIndex={-1} ref={message.id === messages.find(value => !value.from_me)?.id ? latest : undefined} data-message-id={message.id} data-team={message.from_me} data-source-target={contextTarget?.id === message.id || undefined}>
              <header><b><bdi>{message.participant_name || t(message.from_me ? "groups.yourTeam" : "groups.participant")}</bdi></b>
                {message.sender_phone ? <bdi dir="ltr">{message.sender_phone}</bdi> : null}
                <time dateTime={message.provider_timestamp}>{formatTime(message.provider_timestamp)}</time></header>
              {message.quoted_message ? <button type="button" className="wx-group-quote" onClick={() => void run(() => loadMessages(undefined, undefined, message.quoted_message!.id))}>
                <bdi>{message.quoted_message.author}</bdi><span dir="auto">{message.quoted_message.text || t("groups.attachment")}</span></button> : null}
              {message.quote_unavailable && !message.quoted_message ? <p className="wx-group-quote">{t("groups.quoteUnavailable")}</p> : null}
              <p dir="auto">{actionable(message) ? message.message_text || (message.media_kind ? "" : t("groups.emptyText")) : t("groups.revoked")}</p>
              {message.latest_mutation === "EDITED" ? <small>{t("groups.edited")}</small> : null}
              {active && actionable(message) && message.media_available ? <GroupMedia key={`${group.id}:${message.id}`} groupId={group.id} message={message} headers={mutationHeaders}
                accessDenied={groupId => groupId ? clearGroupAccess(groupId) : clearAccess()} visible={active} /> : null}
              {message.delivery_state ? <p className="wx-group-meta">{t(`groups.delivery.${message.delivery_state}`)}</p> : null}
              {message.delivery_hold_reason ? <p className="wx-group-meta">{t("groups.deliveryHeld")}</p> : null}
              {message.reaction_active_emoji ? <span>{t("groups.reactionCurrent", { emoji: message.reaction_active_emoji })}</span> : null}
              {message.reaction_delivery_state ? <span>{t("groups.reactionState", { state: t(`groups.delivery.${message.reaction_delivery_state}`) })}</span> : null}
              {canWrite && actionable(message) ? <div className="wx-group-actions">
                {message.quote_allowed ? <button type="button" className={button} disabled={!writable} onClick={() => {
                  updateDraft(group.id, value => ({ ...value, quote: message })); composer.current?.focus();
                }}>{t("groups.quoteReply")}</button> : null}
                {message.ticket_creatable ? <><button type="button" className={button} disabled={busy || unresolved || !recoveryReady || denied} onClick={() => openTicketAction(message, "create")}>{t("groups.createTicket")}</button>
                  <button type="button" className={button} disabled={busy || unresolved || !recoveryReady || denied} onClick={() => openTicketAction(message, "link")}>{t("groups.linkTicket")}</button></> : null}
                {group.reactions_available ? <label htmlFor={`wx-group-reaction-${message.id}`}>{t("groups.react")}<select id={`wx-group-reaction-${message.id}`} value="" disabled={busy || unresolved || !recoveryReady || denied}
                  onChange={event => { const emoji = event.target.value; if (!emoji) return; void run(() => mutate({ operation: "GROUP_REACTION", input: {
                    group_id: group.id, message_id: message.id, request_token: crypto.randomUUID(), ...(emoji === "remove" ? { removed: true } : { emoji }) } })); }}>
                  <option value="">{t("groups.chooseReaction")}</option><option value="👍">{t("groups.reactionLike")}</option><option value="❤️">{t("groups.reactionThanks")}</option>
                  {message.reaction_active_emoji ? <option value="remove">{t("groups.removeReaction")}</option> : null}
                </select></label> : null}
              </div> : null}
            </li>)}</ol>
            {!messages.length ? <p>{t("groups.noMessages")}</p> : null}
          </ScrollRegion>
          {incoming || contextMode || !following ? <button type="button" className={button} disabled={busy} onClick={jumpLatest}>{t(incoming ? "groups.newMessages" : "groups.latest", { count: incoming })}</button> : null}
          <details className="wx-group-related"><summary>{t("groups.relatedTickets")}</summary>
            <label htmlFor="wx-group-ticket-filter">{t("groups.ticketStatus")}<select id="wx-group-ticket-filter" value={ticketFilter} onChange={event => setTicketFilter(event.target.value as typeof ticketFilter)}>
              {(["OPEN", "CLOSED", "ALL"] as const).map(value => <option key={value} value={value}>{t(`groups.ticketStatus.${value}`)}</option>)}</select></label>
            {!tickets.length ? <p>{t("groups.noTickets")}</p> : <ul>{tickets.map(ticket => <li key={ticket.ticket_number}>
              <button type="button" className={button} onClick={() => selectTicket(ticket.ticket_number)}><bdi>#{ticket.ticket_number}</bdi> <bdi>{ticket.title}</bdi></button>
              <p><bdi>{ticket.team}</bdi> · <bdi>{ticket.owner || t("groups.unassigned")}</bdi> · {t(`groups.ticketStatus.${ticket.state_category}`)}</p>
              {ticket.links.map(link => <button type="button" key={link.message_id} className={button} disabled={busy} onClick={() => void run(() => loadMessages(undefined, undefined, link.message_id))}>{t("groups.sourceMessage")}</button>)}
            </li>)}</ul>}
            {ticketCursor ? <button type="button" className={button} disabled={busy} onClick={() => void run(() => loadTickets(ticketCursor))}>{t("groups.moreTickets")}</button> : null}
          </details>
          {canWrite ? <form className="wx-group-composer" onSubmit={submit}>
            <p>{t("groups.senderTeam")}</p>
            {draft?.quote ? <div className="wx-group-quote"><bdi>{draft.quote.participant_name || t("groups.participant")}</bdi><p dir="auto">{draft.quote.message_text || t("groups.attachment")}</p>
              <button type="button" className={button} disabled={busy || unresolved} onClick={() => { updateDraft(group.id, value => ({ ...value, quote: null })); composer.current?.focus(); }}>{t("groups.cancelQuote")}</button></div> : null}
            <label htmlFor="wx-group-message">{t("groups.message")}<textarea id="wx-group-message" ref={composer} dir="auto" rows={4} maxLength={4096} disabled={!writable || recording}
              value={draft?.text ?? ""} onChange={event => updateDraft(group.id, value => ({ ...value, text: event.target.value,
                mentions: value.mentions.filter(person => groupMentionAppears(event.target.value, person.mention_token)) }))} /></label>
            <div className="wx-group-actions"><button type="button" className={button} disabled={!writable || recording} aria-expanded={participantOpen} onClick={() => setParticipantOpen(value => !value)}>{t("groups.mention")}</button>
              {group.media_capabilities.accepted.length ? <AttachmentFilePicker id="wx-group-files" disabled={!writable || recording} empty={!draft?.attachments.length && !busy}
                accept={group.media_capabilities.accepted.map(rule => rule.mime_type).join(",")}
                onSelect={files => void run(() => upload(files, group.id))} /> : null}
              {group.media_capabilities.voice_recording ? recording ? <><button type="button" className={button} onClick={() => stopRecording(false)}>{t("groups.stopVoice")}</button>
                <button type="button" className={button} onClick={() => stopRecording(true)}>{t("groups.discardVoice")}</button></> : <button type="button" className={button} disabled={!writable} onClick={() => void startVoice()}>{t("groups.recordVoice")}</button> : null}
            </div>
            {recording ? <p role="status">{t("groups.recording")}</p> : null}
            {participantOpen ? <fieldset><legend>{t("groups.participants")}</legend><label htmlFor="wx-group-participant">{t("groups.findParticipant")}<input id="wx-group-participant" type="search" maxLength={160} value={participantQuery} disabled={!writable} onChange={event => setParticipantQuery(event.target.value)} /></label>
              <ul>{participants.map(person => <li key={person.id}><button type="button" className={button} disabled={!writable || !/^[0-9]{1,24}$/u.test(person.mention_token)
                || (draft?.mentions.length ?? 0) >= 20 || (draft?.text.length ?? 0) + person.mention_token.length + 3 > 4096 || draft?.mentions.some(value => value.id === person.id)} onClick={() => {
                updateDraft(group.id, value => ({ ...value, text: `${value.text}${value.text && !value.text.endsWith(" ") ? " " : ""}@${person.mention_token} `, mentions: [...value.mentions, person] }));
                setParticipantOpen(false); composer.current?.focus();
              }}><bdi>{person.name}</bdi> {person.phone ? <bdi dir="ltr">{person.phone}</bdi> : null}</button></li>)}</ul>
              {!participants.length ? <p>{t("groups.noParticipants")}</p> : null}
            </fieldset> : null}
            {draft?.mentions.length ? <ul className="wx-group-actions">{draft.mentions.map(person => <li key={person.id}><bdi>{person.name}</bdi>
              <button type="button" className={button} disabled={!writable} onClick={() => updateDraft(group.id, value => ({ ...value, mentions: value.mentions.filter(item => item.id !== person.id) }))}>{t("groups.removeMention", { name: person.name })}</button></li>)}</ul> : null}
            {draft?.attachments.length ? <ul>{draft.attachments.map(file => <li key={file.id}><bdi>{file.filename}</bdi>
              <button type="button" className={button} disabled={!writable} onClick={() => void run(async () => {
                const groupId = group.id, boundary = scope, generation = authorization.current, groupGeneration = groupEpoch.current.get(groupId) ?? 0, cache = draft.cache;
                await request("GROUP_REMOVE_UPLOAD", { group_id: groupId, upload_cache_id: cache, upload_store_id: file.id });
                if (mounted.current && current.current.scope === boundary && authorization.current === generation && (groupEpoch.current.get(groupId) ?? 0) === groupGeneration)
                  updateDraft(groupId, value => ({ ...value, attachments: value.attachments.filter(item => item.id !== file.id) }));
              })}>{t("groups.removeAttachment", { filename: file.filename })}</button></li>)}</ul> : null}
            <p className="wx-group-meta">{t("groups.draftHelp")}</p>
            {!group.send_available ? <p>{t("groups.sendUnavailable")}</p> : null}
            <button className="wx-button wx-button-primary" disabled={!writable || recording || (!draft?.text.trim() && !draft?.attachments.length)}>{t(busy ? "groups.saving" : "groups.send")}</button>
          </form> : <p>{t("groups.readOnly")}</p>}
        </>}
      </div>
    </div>
    {action && group ? <ModalDialog className="wx-group-modal" aria-labelledby="wx-group-ticket-title" close={() => { if (!busy) setAction(null); }}>
      <h2 id="wx-group-ticket-title">{t(action.mode === "create" ? "groups.createTicket" : "groups.linkTicket")}</h2>
      <form onSubmit={event => { event.preventDefault(); if (busy || !actionable(action.message)) return;
        const base = { group_id: group.id, message_id: action.message.id, request_token: crypto.randomUUID() };
        void run(() => mutate(action.mode === "create" ? { operation: "GROUP_CREATE_TICKET", input: { ...base, title, target_group_id: team } }
          : { operation: "GROUP_LINK_TICKET", input: { ...base, ticket_number: number } }));
      }}>
        {action.mode === "create" ? <><label htmlFor="wx-group-ticket-subject">{t("groups.ticketTitle")}<input id="wx-group-ticket-subject" data-modal-initial-focus required maxLength={200} value={title} disabled={busy || unresolved} onChange={event => setTitle(event.target.value)} /></label>
          <label htmlFor="wx-group-ticket-team">{t("groups.ticketTeam")}<select id="wx-group-ticket-team" required value={team} disabled={busy || unresolved} onChange={event => setTeam(event.target.value)}>
            <option value="">{t("groups.chooseTeam")}</option>{teams.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></>
          : <label htmlFor="wx-group-ticket-number">{t("groups.ticketNumber")}<input id="wx-group-ticket-number" data-modal-initial-focus required inputMode="numeric" pattern="[1-9][0-9]{0,15}" maxLength={16} value={number} disabled={busy || unresolved} onChange={event => setNumber(event.target.value)} /></label>}
        {error ? <p role="alert">{error}</p> : null}
        <div className="wx-group-actions"><button type="button" className={button} disabled={busy} onClick={() => setAction(null)}>{t("groups.cancel")}</button>
          <button className="wx-button wx-button-primary" disabled={busy || unresolved || !canWrite || denied || (action.mode === "create" && !team)}>{t(busy ? "groups.saving" : "groups.save")}</button></div>
      </form>
    </ModalDialog> : null}
  </section>;
}
