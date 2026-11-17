"use client";

import { MetaThreadControl } from "./MetaRouting";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import {
  appendBotConversationPage,
  botConversationTicketNumber,
  botSupportTeamName,
  appendBotConversationEventPage,
  BotConversationPageError,
  fetchBotConversationEventPage,
  fetchBotConversationPage,
  isAbortError,
  refreshBotConversationEventPage,
  refreshBotConversationPage,
  type BotConversationEventPage,
  type BotConversationPage,
} from "../lib/bot-conversations";
import { formatDateTime, formatNumber } from "../lib/i18n/format";
import { localizedUiError } from "../lib/ui-error";
import { mediaAssetCatalogPath, mediaUploadSha256 } from "../lib/media-upload";
import {
  emptyWorkflowPresentation,
  canRemoveWorkflowNode,
  replaceWorkflowHandoffTarget,
  compareWorkflowDefinitions,
  parseWorkflowDraftRecovery,
  serializeWorkflowDraftRecovery,
  workflowExecutionOverlays,
  type WorkflowPresentation,
} from "../lib/workflow-graph";
import {
  advanceBotFlow,
  resolveBotEntryCommand,
  defaultBotKeepOpenPolicy,
  MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES,
  directMessageCapabilities,
  parseBotFlow,
  type BotFlowAdvance,
  type BotFlowDefinition,
  type BotFlowInput,
  type BotFlowNode,
} from "../packages/core/src/bot-flow";
import { operatorFailureMessage, operatorLocalFailure, createLatestRequestFence, operatorResponseFailure, type CodedOperatorError } from "../lib/operator-ui";
import { useI18n } from "./I18nProvider";
import { InlineConfirmation, ModalDialog } from "./ModalDialog";
import { useVisibleRefresh } from "./use-visible-refresh";
import { TicketEventWorkflows, isTicketEventFlowRow } from "./TicketEventWorkflows";
import { NativeRoutingSync } from "./NativeRoutingSync";

type Row = Record<string, unknown>;
type CatalogPage = { items: Row[]; next_cursor: string | null };
type Props = {
  canWrite: boolean;
  canOperate: boolean;
  mutationHeaders: Record<string, string>;
  connections: Row[];
  workspaceId: string;
  openTicket?: (ticket: string) => void;
};
type Tab = "flows" | "assignments" | "conversations" | "ticket-events";
type SupportTeam = {
  id: string;
  name: string;
  active: boolean;
  serviceIdentityCanCreate: boolean;
};
type SupportOwner = { id: string; name: string; active: boolean; groupIds: string[] };
type BotMediaAsset={id:string;filename:string;mime_type:string;byte_size:number;state:string};

const WorkflowCanvas = lazy(() => import("./WorkflowCanvas").then((module) => ({ default: module.WorkflowCanvas })));

const starters = (t: ReturnType<typeof useI18n>["t"]): Record<string, BotFlowDefinition> => ({
  support: {
    schemaVersion: 1,
    name: t("bot.starter.support.name"),
    start: "welcome",
    maxSteps: 30,
    nodes: [
      {
        id: "welcome",
        type: "choice",
        prompt: t("bot.starter.support.prompt"),
        options: [
          { id: "agent", label: t("bot.starter.support.agent"), next: "handoff" },
          { id: "location", label: t("bot.starter.support.location"), next: "location" },
        ],
      },
      {
        id: "location",
        type: "request_location",
        prompt: t("bot.starter.support.locationPrompt"),
        next: "handoff",
      },
      {
        id: "handoff",
        type: "handoff",
        target: "CLIENT_PRIMARY",
        priority: "2 normal",
        message: t("bot.starter.handoff.message"),
      },
    ],
  },
  lookup: {
    schemaVersion: 1,
    name: t("bot.starter.lookup.name"),
    start: "welcome",
    maxSteps: 30,
    nodes: [
      {
        id: "welcome",
        type: "send_text",
        text: t("bot.starter.lookup.prompt"),
        next: "lookup",
      },
      {
        id: "lookup",
        type: "action",
        actionId: "orders.lookup",
        input: { query: "{{message.text}}" },
        onSuccess: "answer",
        onFailure: "handoff",
      },
      {
        id: "answer",
        type: "send_text",
        text: t("bot.starter.lookup.answer"),
        next: "done",
      },
      {
        id: "handoff",
        type: "handoff",
        target: "CLIENT_ESCALATION",
        priority: "3 high",
        message: t("bot.starter.lookup.failure"),
      },
      { id: "done", type: "end" },
    ],
  },
  handoff: {
    schemaVersion: 1,
    name: t("bot.starter.handoff.name"),
    start: "welcome",
    maxSteps: 10,
    nodes: [
      {
        id: "welcome",
        type: "send_text",
        text: t("bot.starter.handoff.thanks"),
        next: "handoff",
      },
      {
        id: "handoff",
        type: "handoff",
        target: "CLIENT_PRIMARY",
        priority: "2 normal",
        message: t("bot.starter.handoff.message"),
      },
    ],
  },
});

function forgetDraftRecovery(storageKey: string) {
  try { window.localStorage.removeItem(storageKey); } catch { /* recovery storage unavailable */ }
}

export function BotAutomation({
  canWrite,
  canOperate,
  mutationHeaders,
  connections,
  workspaceId,
  openTicket,
}: Props) {
  const { direction, locale, t } = useI18n();
  const requestError = useCallback((status: number) => t("automation.common.requestFailed", { status }), [t]);
  const [tab, setTab] = useState<Tab>("flows");
  const [flows, setFlows] = useState<Row[]>([]);
  const [flowCursor, setFlowCursor] = useState<string | null>(null);
  const [loadingMoreFlows, setLoadingMoreFlows] = useState(false);
  const [flowPaginationError, setFlowPaginationError] = useState<string | null>(null);
  const flowPagesExtended = useRef(false);
  const rememberEventFlow = useCallback((row: Row) => {
    flowPagesExtended.current = true;
    setFlows((current) => appendCatalogRows(current, [row], "flow_version_id"));
  }, []);
  const [actions, setActions] = useState<Row[]>([]);
  const [mediaAssets,setMediaAssets]=useState<BotMediaAsset[]>([]);
  const [assignments, setAssignments] = useState<Row[]>([]);
  const [conversationPage, setConversationPage] = useState<BotConversationPage>({
    items: [],
    next_cursor: null,
  });
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [conversationPaginationError, setConversationPaginationError] = useState<string | null>(null);
  const [conversationPaginationNotice, setConversationPaginationNotice] = useState<string | null>(null);
  const conversationPagesExtended = useRef(false);
  const loadMoreController = useRef<AbortController | null>(null);
  const conversations = conversationPage.items;
  const conversationCursor = conversationPage.next_cursor;
  const [supportTeams, setSupportTeams] = useState<SupportTeam[]>([]);
  const [supportOwners, setSupportOwners] = useState<SupportOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorExecutionId, setEditorExecutionId] = useState("");
  const [editorOverlayResult, setEditorOverlayResult] = useState<{
    executionId: string;
    events: Row[];
    error: boolean;
  }>({ executionId: "", events: [], error: false });
  const [editor, setEditor] = useState<{
    sourceId?: string;
    definition: BotFlowDefinition;
    presentation: WorkflowPresentation;
    storageKey: string;
    initialSnapshot: string;
  } | null>(null);
  const editorReturnFocus = useRef<HTMLElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [activationTarget, setActivationTarget] = useState<Row | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<Row | null>(null);
  const [commandTarget, setCommandTarget] = useState<{
    row: Row;
    action: "RESUME_BOT" | "RETRY_ACTION" | "HANDOFF_TO_HUMAN" | "CLOSE";
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lastCreatedId = useRef<string | null>(null);
  const applyData = useCallback(
    ([nextFlowPage, nextActionPage, nextAssignments, nextConversations]: Awaited<
      ReturnType<typeof botData>
    >) => {
      setLoaded(true);
      setFlows((current) => refreshCatalogRows(current, nextFlowPage.items, flowPagesExtended.current, "flow_version_id"));
      setFlowCursor((current) => flowPagesExtended.current ? current : nextFlowPage.next_cursor);
      setFlowPaginationError(null);
      setActions(nextActionPage.items);
      setAssignments(nextAssignments);
      setConversationPage((current) =>
        refreshBotConversationPage(
          current,
          nextConversations,
          conversationPagesExtended.current,
        ),
      );
      setConversationPaginationError(null);
      setSelectedId((current) =>
        current &&
        (flowPagesExtended.current || nextFlowPage.items.some((flow) => !isTicketEventFlowRow(flow) && String(flow.flow_version_id) === current))
          ? current
          : String(nextFlowPage.items.find((flow) => !isTicketEventFlowRow(flow))?.flow_version_id ?? ""),
      );
    },
    [],
  );
  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    if (!background) { setLoading(true); setError(null); }
    try {
      applyData(await botData(requestError, signal));
      void supportTeamData(requestError, signal)
        .then(catalog => { setSupportTeams(catalog.teams); setSupportOwners(catalog.owners); })
        .catch((problem) => { if (!isAbortError(problem)) { setSupportTeams([]); setSupportOwners([]); } });
    } catch (problem) {
      if (isAbortError(problem)) return;
      setError(
        problem instanceof BotConversationPageError
          ? t("bot.conversations.loadFailed")
          : operatorFailureMessage(problem, t("bot.errors.unavailable")),
      );
    } finally {
      if (!background) setLoading(false);
    }
  }, [applyData, requestError, t]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void botData(requestError, controller.signal)
      .then((data) => {
        if (active) applyData(data);
      })
      .catch((problem) => {
        if (active && !isAbortError(problem))
          setError(
            problem instanceof BotConversationPageError
              ? t("bot.conversations.loadFailed")
              : operatorFailureMessage(problem, t("bot.errors.unavailable")),
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void supportTeamData(requestError, controller.signal)
      .then((catalog) => { if (active) { setSupportTeams(catalog.teams); setSupportOwners(catalog.owners); } })
      .catch((problem) => { if (active && !isAbortError(problem)) { setSupportTeams([]); setSupportOwners([]); } });
    return () => {
      active = false;
      controller.abort();
    };
  }, [applyData, requestError, t, workspaceId]);
  useVisibleRefresh((signal) => load(true, signal), !saving && !loadingMoreConversations && editor === null && activationTarget === null && assignmentTarget === null && commandTarget === null);
  useEffect(() => () => loadMoreController.current?.abort(), []);
  useEffect(() => {
    document
      .getElementById(`bot-tab-${tab}`)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [tab]);
  const directFlows = flows.filter((flow) => !isTicketEventFlowRow(flow));
  const selected =
    directFlows.find((flow) => String(flow.flow_version_id) === selectedId) ?? null;
  const [selectedDetailError, setSelectedDetailError] = useState<{ id: string; message: string } | null>(null);
  const selectedDetailErrorMessage = selectedDetailError?.id === selectedId ? selectedDetailError.message : null;
  useEffect(() => {
    if (!selectedId || selected?.definition !== undefined) return;
    const controller = new AbortController();
    void fetch(`/api/bot-flows/${encodeURIComponent(selectedId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw operatorLocalFailure(await responseError(response, requestError(response.status)));
        return response.json() as Promise<Row>;
      })
      .then((detail) => setFlows((current) => mergeCatalogDetail(current, detail, "flow_version_id")))
      .catch((problem) => { if (!isAbortError(problem)) setSelectedDetailError({ id: selectedId, message: operatorFailureMessage(problem, t("bot.errors.unavailable")) }); });
    return () => controller.abort();
  }, [requestError, selected?.definition, selectedId, t]);
  const loadMoreFlows = useCallback(async () => {
    if (!flowCursor || loadingMoreFlows) return;
    setLoadingMoreFlows(true);
    setFlowPaginationError(null);
    try {
      const page = await catalogData(`/api/bot-flows/catalog?limit=25&cursor=${encodeURIComponent(flowCursor)}`, requestError);
      flowPagesExtended.current = true;
      setFlows((current) => appendCatalogRows(current, page.items, "flow_version_id"));
      setFlowCursor(page.next_cursor);
    } catch {
      setFlowPaginationError(t("bot.flows.loadMoreFailed"));
    } finally {
      setLoadingMoreFlows(false);
    }
  }, [flowCursor, loadingMoreFlows, requestError, t]);
  const editorSourceId = editor?.sourceId;
  const editorStorageKey = editor?.storageKey;
  const editorMediaIds=editor?[...new Set(editor.definition.nodes.flatMap(node=>node.type==="send_media"&&node.assetId?[node.assetId]:[]))]:[];
  const editorMediaQuery=editorMediaIds.join(",");
  useEffect(()=>{if(!editorStorageKey)return;const controller=new AbortController();void fetch(mediaAssetCatalogPath(editorMediaQuery?editorMediaQuery.split(","):[]),{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw operatorLocalFailure(await responseError(response,requestError(response.status)));return response.json() as Promise<BotMediaAsset[]>}).then(setMediaAssets).catch(problem=>{if(!isAbortError(problem))setError(operatorFailureMessage(problem, t("bot.errors.unavailable")))});return()=>controller.abort()},[editorMediaQuery,editorStorageKey,requestError,t,workspaceId]);
  const editorExecutions = useMemo(() => editorSourceId
    ? conversations.filter((row) => String(row.flow_version_id) === editorSourceId)
    : [], [conversations, editorSourceId]);
  const effectiveEditorExecutionId = editorExecutions.some((row) => String(row.id) === editorExecutionId)
    ? editorExecutionId
    : String(editorExecutions[0]?.id ?? "");
  useEffect(() => {
    if (!effectiveEditorExecutionId) return;
    const controller = new AbortController();
    void fetchBotConversationEventPage({ conversationId: effectiveEditorExecutionId, limit: 1, signal: controller.signal })
      .then((page) => setEditorOverlayResult({ executionId: effectiveEditorExecutionId, events: page.overlay_events, error: false }))
      .catch((problem) => {
        if (!isAbortError(problem)) setEditorOverlayResult({ executionId: effectiveEditorExecutionId, events: [], error: true });
      });
    return () => controller.abort();
  }, [effectiveEditorExecutionId, workspaceId]);
  const editorExecution = editorExecutions.find((row) => String(row.id) === effectiveEditorExecutionId);
  const editorOverlayLoading = Boolean(effectiveEditorExecutionId) && editorOverlayResult.executionId !== effectiveEditorExecutionId;
  const editorOverlayError = editorOverlayResult.executionId === effectiveEditorExecutionId && editorOverlayResult.error;
  const editorOverlays = useMemo(() => editorExecution
    ? workflowExecutionOverlays([{
        ...editorExecution,
        timeline: editorOverlayResult.executionId === effectiveEditorExecutionId ? editorOverlayResult.events : [],
      }])
    : {}, [editorExecution, editorOverlayResult, effectiveEditorExecutionId]);
  const mutationIntents = useRef(new Map<string,string>());
  const openEditor = useCallback((definition: BotFlowDefinition, sourceId?: string, recoveryKey = sourceId ?? "new") => {
    const storageKey = `wasalx:workflow-draft:${workspaceId}:${recoveryKey}`;
    const initialSnapshot = serializeWorkflowDraftRecovery(definition, emptyWorkflowPresentation());
    let recovered = definition;
    let presentation = emptyWorkflowPresentation();
    editorReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored) {
        ({ definition: recovered, presentation } = parseWorkflowDraftRecovery(JSON.parse(stored)));
        setNotice(t("bot.notice.recovered"));
      }
    } catch {
      forgetDraftRecovery(storageKey);
    }
    setEditor({ sourceId, definition: recovered, presentation, storageKey, initialSnapshot });
  }, [t, workspaceId]);
  const closeEditor = useCallback(() => {
    if (editor) forgetDraftRecovery(editor.storageKey);
    setEditor(null);
    window.requestAnimationFrame(() => editorReturnFocus.current?.focus({ preventScroll: true }));
  }, [editor]);
  useEffect(() => {
    if (!editorStorageKey) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById("bot-flow-editor-title");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorStorageKey]);
  const mutate = async (
    url: string,
    body: unknown,
    success: string,
    idempotent = false,
  ) => {
    const intent=JSON.stringify([url,body]);
    const idempotencyKey=idempotent?(mutationIntents.current.get(intent)??crypto.randomUUID()):null;
    if(idempotencyKey)mutationIntents.current.set(intent,idempotencyKey);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...mutationHeaders,
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw operatorLocalFailure(await responseError(response, t("automation.common.requestFailed", { status: response.status })));
      if(idempotencyKey)mutationIntents.current.delete(intent);
      const result = await response.json().catch(() => null) as { id?: unknown } | null;
      lastCreatedId.current = typeof result?.id === "string" ? result.id : null;
      setNotice(success);
      await load(true);
      return true;
    } catch (problem) {
      setError(
        operatorFailureMessage(problem, t("bot.errors.change")),
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  const uploadMediaAsset=useCallback(async(file:File,replacedAssetId?:string)=>{
    const contentSha256=await mediaUploadSha256(file);const intent=`media:${contentSha256}`;const operationKey=mutationIntents.current.get(intent)??crypto.randomUUID();mutationIntents.current.set(intent,operationKey);
    const response=await fetch("/api/bot-flows/media-assets",{method:"POST",headers:{...mutationHeaders,"idempotency-key":operationKey,"x-file-name":encodeURIComponent(file.name),"x-content-sha256":contentSha256,"content-type":file.type||"application/octet-stream"},body:file});
    if(!response.ok){if(response.status>=400&&response.status<500&&response.status!==408&&response.status!==429)mutationIntents.current.delete(intent);throw operatorLocalFailure(await responseError(response,t("bot.media.uploadFailed")))}
    const result=await response.json() as {id:string};const list=await fetch(mediaAssetCatalogPath(editorMediaQuery?editorMediaQuery.split(","):[],result.id,replacedAssetId),{cache:"no-store"});if(!list.ok)throw operatorLocalFailure(t("bot.media.uploadFailed"));
    const assets=await list.json() as BotMediaAsset[];setMediaAssets(assets);mutationIntents.current.delete(intent);return assets.find(asset=>asset.id===result.id)??null;
  },[editorMediaQuery,mutationHeaders,t]);
  const saveFlow = async () => {
    if (!editor) return;
    let definition: BotFlowDefinition;
    try {
      definition = parseBotFlow(editor.definition);
    } catch (problem) {
      setError(
        operatorFailureMessage(problem, t("bot.errors.flowInvalid")),
      );
      return;
    }
    const url = editor.sourceId
      ? `/api/bot-flows/${encodeURIComponent(editor.sourceId)}/clone`
      : "/api/bot-flows";
    if (await mutate(
        url,
        definition,
        editor.sourceId
          ? t("bot.notice.newVersion")
          : t("bot.notice.created"),
        true,
      )) {
      forgetDraftRecovery(editor.storageKey);
      setEditor(null);
      // Select the draft that was just saved so it can be reviewed and activated.
      if (lastCreatedId.current) setSelectedId(lastCreatedId.current);
      window.requestAnimationFrame(() => editorReturnFocus.current?.focus({ preventScroll: true }));
    }
  };
  const activate = async () => {
    if (!activationTarget) return;
    const family = String(activationTarget.family_id);
    const active = flows.find(
      (flow) => String(flow.family_id) === family && flow.state === "ACTIVE",
    );
    if (
      await mutate(
        `/api/bot-flows/${encodeURIComponent(String(activationTarget.flow_version_id))}/activate`,
        {
          expectedRevision: Number(activationTarget.revision),
          expectedActiveFlowVersionId: active?.flow_version_id ?? null,
        },
        t("bot.notice.activated"),
        true,
      )
    )
      setActivationTarget(null);
  };
  const confirmCommand = async () => {
    if (!commandTarget) return;
    const { row, action } = commandTarget;
    const success =
      action === "RESUME_BOT"
        ? t("bot.notice.resume")
        : action === "RETRY_ACTION"
          ? t("bot.notice.retryAction")
          : action === "HANDOFF_TO_HUMAN"
            ? t("bot.notice.handoff")
            : t("bot.notice.closed");
    if (
      await mutate(
        `/api/bot-flows/conversations/${encodeURIComponent(String(row.id))}/command`,
        { action, expectedFencingToken: Number(row.fencing_token) },
        success,
        true,
      )
    )
      setCommandTarget(null);
  };
  const confirmAssignmentState = async () => {
    if (!assignmentTarget) return;
    const state = assignmentTarget.state === "ACTIVE" ? "PAUSED" : "ACTIVE";
    if (
      await mutate(
        `/api/bot-flows/assignments/${encodeURIComponent(String(assignmentTarget.id))}/state`,
        { state, expectedRevision: Number(assignmentTarget.revision) },
        t(state === "PAUSED" ? "bot.assignments.paused" : "bot.assignments.active"),
        true,
      )
    )
      setAssignmentTarget(null);
  };
  const loadMoreConversations = useCallback(async () => {
    if (!conversationCursor || loadingMoreConversations) return;
    loadMoreController.current?.abort();
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMoreConversations(true);
    setConversationPaginationError(null);
    setConversationPaginationNotice(null);
    try {
      const page = await fetchBotConversationPage({
        cursor: conversationCursor,
        signal: controller.signal,
      });
      conversationPagesExtended.current = true;
      setConversationPage((current) => appendBotConversationPage(current, page));
      setConversationPaginationError(null);
      setConversationPaginationNotice(t("bot.conversations.loadedMore"));
    } catch (problem) {
      if (!isAbortError(problem))
        setConversationPaginationError(t("bot.conversations.loadMoreFailed"));
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMoreConversations(false);
      }
    }
  }, [conversationCursor, loadingMoreConversations, t]);
  const summary = {
    active: directFlows.filter((flow) => flow.state === "ACTIVE").length,
    assigned: assignments.filter((item) => item.state === "ACTIVE").length,
    actions: actions.filter((item) => item.state === "ACTIVE").length,
    human: conversations.filter(
      (item) => item.state === "HUMAN" || item.state === "HANDOFF_PENDING",
    ).length,
  };
  const moveTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ),
    ];
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  // Until the first load succeeds, show loading or the load failure, never "no flows yet".
  if (!loaded && error)
    return <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("bot.errors.unavailable")}</b><p>{error}</p><button className="button small" disabled={loading} onClick={() => void load()}>{t("automation.common.reload")}</button></div></section>;
  if (!loaded)
    return (
      <section
        className="panel bot-loading"
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label={t("bot.loading")}
      >
        <span aria-hidden="true" />
        <span aria-hidden="true" />
        <span aria-hidden="true" />
      </section>
    );
  return (
    <div className="bot-automation" dir={direction}>
      <section className="bot-command-bar" aria-label={t("bot.summary.label")}>
        <div>
          <strong>{formatNumber(summary.active, locale)}</strong>
          <span>{t("bot.summary.active")}</span>
        </div>
        <div>
          <strong>{formatNumber(summary.assigned, locale)}</strong>
          <span>{t(summary.assigned === 1 ? "bot.summary.assignedOne" : "bot.summary.assigned")}</span>
        </div>
        <div>
          <strong>{formatNumber(summary.actions, locale)}</strong>
          <span>{t("bot.summary.actions")}</span>
        </div>
        <div>
          <strong>{formatNumber(summary.human, locale)}</strong>
          <span>{t("bot.summary.human")}</span>
        </div>
        <p>
          {t("bot.summary.help")}
        </p>
      </section>
      <div
        className="tabs bot-tabs"
        role="tablist"
        tabIndex={-1}
        aria-label={t("bot.tabs.label")}
        onKeyDown={moveTab}
      >
        <button
          id="bot-tab-flows"
          role="tab"
          aria-controls="bot-panel-flows"
          aria-selected={tab === "flows"}
          tabIndex={tab === "flows" ? 0 : -1}
          className={tab === "flows" ? "active" : ""}
          onClick={() => setTab("flows")}
        >
          {t("bot.tabs.flows")}
        </button>
        <button
          id="bot-tab-ticket-events"
          role="tab"
          aria-controls="bot-panel-ticket-events"
          aria-selected={tab === "ticket-events"}
          tabIndex={tab === "ticket-events" ? 0 : -1}
          className={tab === "ticket-events" ? "active" : ""}
          onClick={() => setTab("ticket-events")}
        >
          {t("ticketEvent.workspace.tab")}
        </button>
        <button
          id="bot-tab-conversations"
          role="tab"
          aria-controls="bot-panel-conversations"
          aria-selected={tab === "conversations"}
          tabIndex={tab === "conversations" ? 0 : -1}
          className={tab === "conversations" ? "active" : ""}
          onClick={() => setTab("conversations")}
        >
          {t("bot.tabs.conversations")}
        </button>
        <button
          id="bot-tab-assignments"
          role="tab"
          aria-controls="bot-panel-assignments"
          aria-selected={tab === "assignments"}
          tabIndex={tab === "assignments" ? 0 : -1}
          className={tab === "assignments" ? "active" : ""}
          onClick={() => setTab("assignments")}
        >
          {t("bot.tabs.assignments")}
        </button>
      </div>
      {error ? (
        <div
          id="bot-feedback"
          className="settings-feedback error bot-feedback"
          role="alert"
        >
          <span>!</span>
          <p>{error}</p>
          <button className="button small" onClick={() => void load()}>
            {t("automation.common.reload")}
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="settings-feedback success bot-feedback" role="status">
          <span>✓</span>
          <p>{notice}</p>
        </div>
      ) : null}
      {tab === "flows" || tab === "assignments" ? <NativeRoutingSync canWrite={canWrite} mutationHeaders={mutationHeaders} refreshKey={JSON.stringify([directFlows.map(row => [row.flow_version_id, row.revision, row.state]), assignments.map(row => [row.id, row.revision, row.state])])} /> : null}
      {tab === "flows" ? (
        <div
          id="bot-panel-flows"
          role="tabpanel"
          aria-labelledby="bot-tab-flows"
        >
          <Flows
            supportTeams={supportTeams}
            flows={directFlows}
            selected={selected}
            select={setSelectedId}
            canWrite={canWrite}
            actions={actions}
            assignments={assignments}
            connections={connections}
            start={openEditor}
            activate={(row: Row) => { setError(null); setActivationTarget(row); }}
            loadingDetail={Boolean(selected && selected.definition === undefined && !selectedDetailErrorMessage)}
            detailError={selectedDetailErrorMessage}
            retryDetail={() => { setFlows((current) => current.map((row) => String(row.flow_version_id) === selectedId ? { ...row, definition: undefined } : row)); setSelectedDetailError(null); }}
            nextCursor={flowCursor}
            loadingMore={loadingMoreFlows}
            paginationError={flowPaginationError}
            loadMore={loadMoreFlows}
          />
        </div>
      ) : null}
      <div
        id="bot-panel-ticket-events"
        role="tabpanel"
        aria-labelledby="bot-tab-ticket-events"
        hidden={tab !== "ticket-events"}
      >
        <TicketEventWorkflows
          key={workspaceId}
          active={tab === "ticket-events"}
          flows={flows}
          canWrite={canWrite}
          workspaceId={workspaceId}
          mutationHeaders={mutationHeaders}
          onFlow={rememberEventFlow}
          nextCursor={flowCursor}
          loadingMore={loadingMoreFlows}
          paginationError={flowPaginationError}
          loadMore={loadMoreFlows}
        />
      </div>
      {tab === "conversations" ? (
        <div
          id="bot-panel-conversations"
          role="tabpanel"
          aria-labelledby="bot-tab-conversations"
        >
          <Conversations
            openTicket={openTicket}
            workspaceId={workspaceId}
            mutationHeaders={mutationHeaders}
            rows={conversations}
            flows={directFlows}
            nextCursor={conversationCursor}
            loadingMore={loadingMoreConversations}
            paginationError={conversationPaginationError}
            paginationNotice={conversationPaginationNotice}
            loadMore={loadMoreConversations}
            canOperate={canOperate}
            saving={saving}
            mutate={mutate}
            confirm={(target: NonNullable<typeof commandTarget>) => { setError(null); setCommandTarget(target); }}
          />
        </div>
      ) : null}
      {tab === "assignments" ? (
        <div
          id="bot-panel-assignments"
          role="tabpanel"
          aria-labelledby="bot-tab-assignments"
        >
          <Assignments
            rows={assignments}
            flows={directFlows}
            connections={connections}
            canWrite={canWrite}
            saving={saving}
            mutate={mutate}
            supportTeams={supportTeams}
            confirmState={(row: Row) => { setError(null); setAssignmentTarget(row); }}
            error={error}
          />
        </div>
      ) : null}
      {editor ? (
        <FlowEditor
          value={editor.definition}
          setValue={(update) =>
            setEditor((current) =>
              current ? { ...current, definition: typeof update === "function" ? update(current.definition) : update } : null,
            )
          }
          presentation={editor.presentation}
          setPresentation={(update) =>
            setEditor((current) => current ? {
              ...current,
              presentation: typeof update === "function" ? update(current.presentation) : update,
            } : null)
          }
          executionOverlays={editorOverlays}
          executionRows={editorExecutions}
          executionId={effectiveEditorExecutionId}
          setExecutionId={setEditorExecutionId}
          executionLoading={editorOverlayLoading}
          executionError={editorOverlayError}
          actions={actions}
          mediaAssets={mediaAssets}
          uploadMediaAsset={uploadMediaAsset}
          supportTeams={supportTeams}
          supportOwners={supportOwners}
          cancel={closeEditor}
          save={() => void saveFlow()}
          saving={saving}
          storageKey={editor.storageKey}
          initialSnapshot={editor.initialSnapshot}
        />
      ) : null}
      {activationTarget ? (
        <ModalDialog
          close={() => setActivationTarget(null)}
          className="modal-backdrop"
          aria-labelledby="bot-activate-title"
        >
          <div className="modal bot-confirm">
            <div>
              <h2 id="bot-activate-title">
                {t("bot.activation.title", { version: formatNumber(Number(activationTarget.version), locale) })}
              </h2>
              <p>
                {t("bot.activation.description")}
              </p>
              {error ? <p className="bot-inline-error" role="alert">{error}</p> : null}
            </div>
            <span>
              <button
                data-modal-initial-focus
                className="button secondary"
                onClick={() => setActivationTarget(null)}
              >
                {t("automation.common.cancel")}
              </button>
              <button
                className="button primary"
                disabled={saving}
                onClick={() => void activate()}
              >
                {t(saving ? "bot.activation.activating" : "bot.activation.confirm")}
              </button>
            </span>
          </div>
        </ModalDialog>
      ) : null}
      {commandTarget ? (
        <ModalDialog
          close={() => setCommandTarget(null)}
          className="modal-backdrop"
          aria-labelledby="bot-command-title"
        >
          <div className="modal bot-confirm">
            <div>
              <h2 id="bot-command-title">
                {commandTarget.action === "RESUME_BOT"
                  ? t("bot.command.resumeTitle")
                  : commandTarget.action === "RETRY_ACTION"
                    ? t("bot.command.retryTitle")
                    : commandTarget.action === "HANDOFF_TO_HUMAN"
                      ? t("bot.command.handoffTitle")
                      : t("bot.command.closeTitle")}
              </h2>
              <p>
                {commandTarget.action === "RESUME_BOT"
                  ? t("bot.command.resumeHelp")
                  : commandTarget.action === "RETRY_ACTION"
                    ? t("bot.command.retryHelp")
                    : commandTarget.action === "HANDOFF_TO_HUMAN"
                      ? t("bot.command.handoffHelp")
                      : t("bot.command.closeHelp")}
              </p>
              {error ? <p className="bot-inline-error" role="alert">{error}</p> : null}
            </div>
            <span>
              <button
                data-modal-initial-focus
                className="button secondary"
                onClick={() => setCommandTarget(null)}
              >
                {t("automation.common.cancel")}
              </button>
              <button
                className="button primary"
                disabled={saving}
                onClick={() => void confirmCommand()}
              >
                {saving
                  ? t("bot.command.saving")
                  : commandTarget.action === "RESUME_BOT"
                    ? t("bot.command.resume")
                    : commandTarget.action === "RETRY_ACTION"
                      ? t("bot.command.retry")
                      : commandTarget.action === "HANDOFF_TO_HUMAN"
                        ? t("bot.command.handoff")
                        : t("bot.command.close")}
              </button>
            </span>
          </div>
        </ModalDialog>
      ) : null}
      {assignmentTarget ? (
        <ModalDialog
          close={() => setAssignmentTarget(null)}
          className="modal-backdrop"
          aria-labelledby="bot-assignment-state-title"
        >
          <div className="modal bot-confirm">
            <div>
              <h2 id="bot-assignment-state-title">
                {t(assignmentTarget.state === "ACTIVE" ? "bot.assignments.pause" : "bot.assignments.resume")} · {String(assignmentTarget.connection_name)}
              </h2>
              <p>
                {t(assignmentTarget.state === "ACTIVE" ? "bot.assignments.paused" : "bot.assignments.active")}
              </p>
              {error ? <p className="bot-inline-error" role="alert">{error}</p> : null}
            </div>
            <span>
              <button
                data-modal-initial-focus
                className="button secondary"
                onClick={() => setAssignmentTarget(null)}
              >
                {t("automation.common.cancel")}
              </button>
              <button
                className="button primary"
                disabled={saving}
                onClick={() => void confirmAssignmentState()}
              >
                {t(assignmentTarget.state === "ACTIVE" ? "bot.assignments.pause" : "bot.assignments.resume")}
              </button>
            </span>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
}

function Flows({
  flows,
  selected,
  select,
  canWrite,
  actions,
  supportTeams,
  assignments,
  connections,
  start,
  activate,
  loadingDetail,
  detailError,
  retryDetail,
  nextCursor,
  loadingMore,
  paginationError,
  loadMore,
}: {
  flows: Row[];
  selected: Row | null;
  select: (id: string) => void;
  canWrite: boolean;
  actions: Row[];
  supportTeams: SupportTeam[];
  assignments: Row[];
  connections: Row[];
  start: (flow: BotFlowDefinition, sourceId?: string, recoveryKey?: string) => void;
  activate: (row: Row) => void;
  loadingDetail: boolean;
  detailError: string | null;
  retryDetail: () => void;
  nextCursor: string | null;
  loadingMore: boolean;
  paginationError: string | null;
  loadMore: () => void;
}) {
  const { locale, t } = useI18n();
  const [starter, setStarter] = useState("support");
  return (
    <div className="bot-workspace">
      <aside className="panel bot-version-list">
        <div className="panel-heading">
          <div>
            <h2>{t("bot.flows.title")}</h2>
            <p>{t("bot.flows.help")}</p>
          </div>
          {canWrite ? (
            <button
              className="button primary small"
              onClick={() => start({ ...starters(t)[starter], keepOpenPolicy: defaultBotKeepOpenPolicy() }, undefined, `new:${starter}`)}
            >
              {t("bot.flows.new")}
            </button>
          ) : (
            <span className="tag">{t("automation.common.readOnly")}</span>
          )}
        </div>
        {canWrite ? (
          <label className="bot-starter">
            {t("bot.flows.starter")}
            <select
              value={starter}
              onChange={(event) => setStarter(event.target.value)}
            >
              <option value="support">{t("bot.flows.supportMenu")}</option>
              <option value="lookup">{t("bot.flows.externalLookup")}</option>
              <option value="handoff">{t("bot.flows.humanHandoff")}</option>
            </select>
          </label>
        ) : null}
        <div>
          {flows.length ? (
            flows.map((flow) => (
              <button
                key={String(flow.flow_version_id)}
                className={
                  String(flow.flow_version_id) ===
                  String(selected?.flow_version_id)
                    ? "selected"
                    : ""
                }
                type="button"
                aria-pressed={String(flow.flow_version_id) === String(selected?.flow_version_id)}
                onClick={() => select(String(flow.flow_version_id))}
              >
                <span>
                  <b>{String(flow.name)}</b>
                  <small>
                    {t("bot.flows.versionSummary", { version: formatNumber(Number(flow.version), locale), assignments: formatNumber(Number(flow.assignment_count), locale) })}
                  </small>
                </span>
                <State value={flow.state} />
              </button>
            ))
          ) : (
            <EmptyState
              title={t("bot.flows.emptyTitle")}
              body={t("bot.flows.emptyBody")}
            />
          )}
        </div>
        {paginationError ? <p className="bot-inline-error" role="alert">{paginationError}</p> : null}
        {nextCursor ? <button type="button" className="routing-version-toggle" disabled={loadingMore} onClick={loadMore}>{t(loadingMore ? "bot.flows.loadingMore" : "bot.flows.loadMore")}</button> : null}
      </aside>
      {loadingDetail ? (
        <section className="panel bot-loading" role="status" aria-live="polite" aria-busy="true" aria-label={t("bot.flows.loadingDetail")}><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></section>
      ) : detailError ? (
        <section className="panel settings-load-error" role="alert"><span>!</span><div><b>{t("bot.flows.detailUnavailable")}</b><p>{detailError}</p><button className="button small" onClick={retryDetail}>{t("automation.common.reload")}</button></div></section>
      ) : selected?.definition !== undefined ? (
          <FlowDetail
            supportTeams={supportTeams}
            row={selected}
            versions={flows.filter((flow) => String(flow.family_id) === String(selected.family_id))}
          canWrite={canWrite}
          actions={actions}
          assignments={assignments}
          connections={connections}
          clone={() =>
            start(
              parseBotFlow(selected.definition),
              String(selected.flow_version_id),
            )
          }
          activate={() => activate(selected)}
        />
      ) : (
        <section className="panel">
          <EmptyState
            title={t("bot.flows.chooseTitle")}
            body={t("bot.flows.chooseBody")}
          />
        </section>
      )}
    </div>
  );
}

function FlowDetail({
  row,
  versions,
  canWrite,
  actions,
  supportTeams,
  assignments,
  connections,
  clone,
  activate,
}: {
  row: Row;
  versions: Row[];
  canWrite: boolean;
  actions: Row[];
  supportTeams: SupportTeam[];
  assignments: Row[];
  connections: Row[];
  clone: () => void;
  activate: () => void;
}) {
  const { locale, t } = useI18n();
  const comparable = versions.filter((version) => String(version.flow_version_id) !== String(row.flow_version_id));
  const [comparisonId, setComparisonId] = useState("");
  const effectiveComparisonId = comparable.some((version) => String(version.flow_version_id) === comparisonId)
    ? comparisonId
    : String(comparable[0]?.flow_version_id ?? "");
  const [comparisonDetail, setComparisonDetail] = useState<{ id: string; row: Row } | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const comparisonSummary = comparable.find((version) => String(version.flow_version_id) === effectiveComparisonId);
  useEffect(() => {
    if (!effectiveComparisonId || comparisonSummary?.definition !== undefined) return;
    const controller = new AbortController();
    void fetch(`/api/bot-flows/${encodeURIComponent(effectiveComparisonId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<Row> : Promise.reject(new Error()))
      .then((row) => { setComparisonDetail({ id: effectiveComparisonId, row }); setComparisonError(null); })
      .catch((problem) => { if (!isAbortError(problem)) setComparisonError(effectiveComparisonId); });
    return () => controller.abort();
  }, [comparisonSummary?.definition, effectiveComparisonId]);
  let definition: BotFlowDefinition | null = null;
  let parseError = "";
  try {
    definition = parseBotFlow(row.definition);
  } catch {
    parseError = t("bot.flow.invalid");
  }
  const comparisonRow = comparisonSummary?.definition !== undefined
    ? comparisonSummary
    : comparisonDetail?.id === effectiveComparisonId
      ? comparisonDetail.row
      : null;
  const comparisonLoading = Boolean(effectiveComparisonId && !comparisonRow && comparisonError !== effectiveComparisonId);
  let comparison: ReturnType<typeof compareWorkflowDefinitions> | null = null;
  let comparisonDefinition: BotFlowDefinition | null = null;
  if (definition && comparisonRow) try {
    comparisonDefinition = parseBotFlow(comparisonRow.definition);
    comparison = compareWorkflowDefinitions(comparisonRow.definition, definition);
  } catch {
    comparison = null;
  }
  const assignedConnectionIds = new Set(
    assignments
      .filter((assignment) =>
        assignment.state === "ACTIVE" &&
        String(assignment.flow_family_id) === String(row.family_id),
      )
      .map((assignment) => String(assignment.connection_id)),
  );
  const providers = [
    ...new Set(
      connections
        .filter((connection) =>
          connection.state === "WORKING" && assignedConnectionIds.has(String(connection.id)),
        )
        .map((connection) => String(connection.provider).toLowerCase())
        .filter((value) => value === "waha" || value === "meta"),
    ),
  ] as Array<"waha" | "meta">;
  return (
    <section className="panel bot-flow-detail">
      <div className="panel-heading">
        <div>
          <h2>
            {t("bot.flow.title", { name: String(row.name), version: formatNumber(Number(row.version), locale) })}
          </h2>
          <p>{statusLabel(row.state, t)}</p>
        </div>
        {canWrite ? (
          <div className="bot-heading-actions">
            <button className="button secondary small" disabled={!definition} onClick={clone}>
              {t(row.state === "RETIRED" ? "bot.flow.restore" : "bot.flow.clone")}
            </button>
            {row.state === "DRAFT" ? (
              <button className="button primary small" onClick={activate}>
                {t("bot.flow.review")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {parseError ? (
        <div className="settings-feedback error" role="alert">
          <span>!</span>
          <p>{parseError}</p>
        </div>
      ) : definition ? (
        <>
          <div className="bot-capabilities">
            <h3>{t("bot.flow.behavior")}</h3>
            <p><span>{t("bot.flow.engineNotice")}</span></p>
            <p><b>{t("bot.keepOpen.title")}</b><span>{keepOpenPolicySummary(definition, locale, t)}</span></p>
            {(["welcomeResendMinutes", "mainMenuNodeId", "entryCommands"] as const).map(field => <p key={field}>
              <b>{t(`bot.comparison.setting.${field}`)}</b><span>{comparisonSettingValue(field, "", definition, locale, t)}</span>
            </p>)}
            {providers.length ? (
              providers.map((provider) => {
                const capability = directMessageCapabilities(provider);
                return (
                  <p key={provider}>
                    <b>
                      {provider === "waha"
                        ? t("bot.flow.linked")
                        : t("bot.flow.official")}
                    </b>
                    <span>
                      {t("bot.flow.capability", { choices: t(capability.choices === "NUMBERED_TEXT" ? "bot.flow.numberedText" : "bot.flow.buttons"), forms: t(capability.metaFlows ? "bot.flow.formsAvailable" : "bot.flow.formsUnavailable"), templates: t(capability.templates ? "bot.flow.templatesAvailable" : "bot.flow.templatesUnavailable") })}
                    </span>
                  </p>
                );
              })
            ) : (
              <p>
                <span>
                  {t("bot.flow.assignHelp")}
                </span>
              </p>
            )}
          </div>
          <div className="bot-capabilities">
            <h3>{t("bot.comparison.title")}</h3>
            <p><span>{t("bot.comparison.help")}</span></p>
            {comparable.length ? (
              <label className="bot-starter">
                {t("bot.comparison.compareWith")}
                <select value={effectiveComparisonId} onChange={(event) => setComparisonId(event.target.value)}>
                  {comparable.map((version) => <option key={String(version.flow_version_id)} value={String(version.flow_version_id)}>
                    {t("bot.comparison.versionOption", { version: formatNumber(Number(version.version), locale), state: statusLabel(version.state, t) })}
                  </option>)}
                </select>
              </label>
            ) : <p><span>{t("bot.comparison.noOtherVersion")}</span></p>}
            {comparisonLoading ? <p role="status"><span>{t("bot.comparison.loading")}</span></p> : comparison ? <WorkflowComparison supportTeams={supportTeams} comparison={comparison} beforeDefinition={comparisonDefinition} afterDefinition={definition} locale={locale} t={t} /> : comparisonError === effectiveComparisonId || comparisonRow ? <p role="alert"><span>{t("bot.comparison.unavailable")}</span></p> : null}
          </div>
          <ol className="bot-node-list">
            {definition.nodes.map((node, index) => (
              <li key={node.id}>
                <span>{formatNumber(index + 1, locale)}</span>
                <div>
                  <b>{nodeTitle(node.type, t)}</b>
                  <p>{nodeDescription(node, locale, t, supportTeams, definition.nodes)}</p>
                </div>
              </li>
            ))}
          </ol>
          {canWrite ? (
            <details className="routing-raw">
              <summary>{t("bot.flow.schema.title")}</summary>
              <p>{t("bot.flow.schema.help")}</p>
              <pre aria-label={t("bot.flow.schema.label")}><code>{JSON.stringify(definition, null, 2)}</code></pre>
            </details>
          ) : null}
          <FlowSimulator key={String(row.flow_version_id)} definition={definition} actions={actions} supportTeams={supportTeams} />
        </>
      ) : null}
    </section>
  );
}

function FlowSimulator({
  definition,
  actions,
  supportTeams,
}: {
  definition: BotFlowDefinition;
  actions: Row[];
  supportTeams: SupportTeam[];
}) {
  const { locale, t } = useI18n();
  const [advance, setAdvance] = useState<BotFlowAdvance | null>(null);
  const [transcript, setTranscript] = useState<
    Array<{ side: "bot" | "user" | "system"; text: string }>
  >([]);
  const [variablesText, setVariablesText] = useState(
    '{"message.text":"ORD-42","action.status":"shipped"}',
  );
  const [variablesError, setVariablesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entryText, setEntryText] = useState("");
  const variables = () => {
    const value = JSON.parse(variablesText) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    const parsed = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
    );
    for (const node of definition.nodes)
      if (node.type === "whatsapp_flow") parsed[`flow.${node.id}.token`] ??= `simulator-${node.id}`;
    return parsed;
  };
  const apply = (nodeId: string | undefined, input?: BotFlowInput) => {
    let inputVariables: Record<string, string>;
    try {
      inputVariables = variables();
      setVariablesError(null);
    } catch {
      setVariablesError(t("bot.simulator.valuesInvalid"));
      setError(null);
      return;
    }
    try {
      const entry = input ? resolveBotEntryCommand(definition, nodeId, input, inputVariables) : null;
      const next = advanceBotFlow(definition, entry?.target ?? nodeId ?? definition.start, entry ? undefined : input, inputVariables);
      setAdvance(next);
      setTranscript((current) => [...current, ...effects(next, t, supportTeams)]);
      setError(null);
    } catch {
      setError(t("bot.errors.simulation"));
    }
  };
  const reset = () => {
    setTranscript([]);
    setAdvance(null);
    apply(definition.start);
  };
  return (
    <div className="bot-simulator">
      <div className="bot-section-head">
        <div>
          <h3>{t("bot.simulator.title")}</h3>
          <p>{t("bot.simulator.help")}</p>
        </div>
        <button className="button secondary small" onClick={reset}>
          {t("bot.simulator.start")}
        </button>
      </div>
      {definition.entryCommands?.some(entry => entry.enabled) ? <div className="bot-form-grid">
        <label htmlFor="bot-simulator-entry">{t("bot.entry.preview")}
          <input id="bot-simulator-entry" dir="auto" value={entryText} aria-describedby="bot-simulator-entry-help" onChange={event => setEntryText(event.target.value)} />
          <small id="bot-simulator-entry-help">{t("bot.entry.previewHelp")}</small>
        </label>
        <button type="button" className="button secondary small" disabled={!entryText.trim() || advance?.state === "ACTION" || advance?.state === "HANDOFF" || advance?.state === "RESOLVED"} onClick={() => {
          setTranscript(current => [...current, { side: "user", text: entryText }]);
          apply(advance?.currentNodeId, { type: "text", text: entryText });
        }}>{t("bot.entry.try")}</button>
      </div> : null}
      {definition.welcomeResendMinutes != null ? <p>{t("bot.welcome.previewHelp")}</p> : null}
      <label htmlFor="bot-simulator-variables">
        {t("bot.simulator.values")}
        <textarea
          id="bot-simulator-variables"
          value={variablesText}
          onChange={(event) => {
            setVariablesText(event.target.value);
            setVariablesError(null);
          }}
          aria-invalid={Boolean(variablesError)}
          aria-errormessage={variablesError ? "bot-simulator-variables-error" : undefined}
          spellCheck={false}
        />
      </label>
      {variablesError ? (
        <p id="bot-simulator-variables-error" className="bot-inline-error" role="alert">
          {variablesError}
        </p>
      ) : null}
      {error ? (
        <p className="bot-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bot-transcript" aria-live="polite">
        {transcript.length ? (
          transcript.map((item, index) => (
            <p key={index} className={item.side}>
              <b>
                {item.side === "bot"
                  ? t("bot.simulator.bot")
                  : item.side === "user"
                    ? t("bot.simulator.customer")
                    : t("bot.simulator.boundary")}
              </b>
              <span>{item.text}</span>
            </p>
          ))
        ) : (
          <EmptyState
            title={t("bot.simulator.emptyTitle")}
            body={t("bot.simulator.emptyBody")}
          />
        )}
      </div>
      {advance?.state === "WAITING" ? (
        <SimulatorInput
          advance={advance}
          definition={definition}
          choose={(input) => {
            setTranscript((current) => [
              ...current,
              {
                side: "user",
                text:
                  input.type === "choice"
                    ? input.choiceId
                    : input.type === "location"
                      ? t("bot.simulator.exampleLocation")
                      : input.type === "flow_response"
                        ? t("bot.simulator.formCompleted")
                        : input.text,
              },
            ]);
            apply(advance.currentNodeId, input);
          }}
        />
      ) : advance?.state === "ACTION" ? (
        <div className="bot-action-boundary">
          <p>{t("bot.simulator.actionBoundary", { action: isolate(String(advance.effects.find((effect) => effect.type === "action")?.type === "action" ? advance.effects.find((effect) => effect.type === "action")?.actionId : "")) })}</p>
          <button
            className="button small secondary"
            onClick={() => {
              const action = advance.effects.find(
                (effect) => effect.type === "action",
              );
              if (action?.type === "action") apply(action.onSuccess);
            }}
          >
            {t("bot.simulator.success")}
          </button>
          <button
            className="button small secondary"
            onClick={() => {
              const action = advance.effects.find(
                (effect) => effect.type === "action",
              );
              if (action?.type === "action") apply(action.onFailure);
            }}
          >
            {t("bot.simulator.failure")}
          </button>
          <small>
            {t(actions.length === 1 ? "bot.simulator.actionsAvailableOne" : "bot.simulator.actionsAvailable", { count: formatNumber(actions.length, locale) })}
          </small>
        </div>
      ) : advance?.state === "HANDOFF" && definition.keepOpenPolicy?.mainMenu ? <div className="bot-action-boundary">
        <p>{t("bot.mainMenu.previewHelp")}</p>
        <button type="button" className="button secondary small" onClick={() => apply(definition.mainMenuNodeId ?? definition.start)}>
          {(() => { const node = definition.nodes.find(node => node.id === advance.currentNodeId); return node?.type === "handoff" ? node.mainMenuReturn?.label ?? t("bot.mainMenu.defaultLabel") : t("bot.mainMenu.defaultLabel"); })()}
        </button>
      </div> : null}
    </div>
  );
}

function WorkflowComparison({
  comparison,
  supportTeams,
  beforeDefinition,
  afterDefinition,
  locale,
  t,
}: {
  comparison: ReturnType<typeof compareWorkflowDefinitions>;
  supportTeams: SupportTeam[];
  beforeDefinition: BotFlowDefinition | null;
  afterDefinition: BotFlowDefinition;
  locale: ReturnType<typeof useI18n>["locale"];
  t: ReturnType<typeof useI18n>["t"];
}) {
  const changedNodes = comparison.nodes.filter((node) => node.kind !== "unchanged");
  const totalChanges = comparison.summary.added + comparison.summary.removed + comparison.summary.changed;
  return <>
    <p><span>{totalChanges
      ? t("bot.comparison.summary", {
          added: formatNumber(comparison.summary.added, locale),
          removed: formatNumber(comparison.summary.removed, locale),
          changed: formatNumber(comparison.summary.changed, locale),
        })
      : t("bot.comparison.identical")}</span></p>
    {comparison.settings.length || changedNodes.length ? <ol className="bot-node-list">
      {comparison.settings.map((setting, index) => <li key={setting.field}>
        <span>{formatNumber(index + 1, locale)}</span>
        <div><b>{t(`bot.comparison.setting.${setting.field}`)}</b><p><bdi>{comparisonSettingValue(setting.field, setting.before, beforeDefinition, locale, t)}</bdi> → <bdi>{comparisonSettingValue(setting.field, setting.after, afterDefinition, locale, t)}</bdi></p></div>
      </li>)}
      {changedNodes.map((change, index) => {
        const node = change.after ?? change.before!;
        const before = change.before ? nodeDescription(change.before, locale, t, supportTeams, beforeDefinition?.nodes) : "";
        const after = change.after ? nodeDescription(change.after, locale, t, supportTeams, afterDefinition.nodes) : "";
        return <li key={change.id}>
          <span>{formatNumber(comparison.settings.length + index + 1, locale)}</span>
          <div>
            <b>{t(`bot.comparison.${change.kind}`)} · {nodeTitle(node.type, t)}</b>
            <p>{change.kind === "added" ? <bdi>{after}</bdi> : change.kind === "removed" ? <bdi>{before}</bdi> : <><bdi>{before}</bdi><span aria-hidden="true"> → </span><bdi>{after}</bdi></>}</p>
          </div>
        </li>;
      })}
    </ol> : null}
  </>;
}

function SimulatorInput({
  advance,
  definition,
  choose,
}: {
  advance: BotFlowAdvance;
  definition: BotFlowDefinition;
  choose: (input: BotFlowInput) => void;
}) {
  const { t } = useI18n();
  const node = definition.nodes.find(
    (item) => item.id === advance.currentNodeId,
  );
  if (node?.type === "choice")
    return (
      <div className="bot-simulator-input">
        <span>{t("bot.simulator.reply")}</span>
        {node.options.map((option) => (
          <button
            className="button secondary small"
            key={option.id}
            onClick={() => choose({ type: "choice", choiceId: option.id })}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  if (node?.type === "request_location")
    return (
      <div className="bot-simulator-input">
        <span>{t("bot.simulator.reply")}</span>
        <button
          className="button secondary small"
          onClick={() =>
            choose({ type: "location", latitude: 24.7136, longitude: 46.6753 })
          }
        >
          {t("bot.simulator.shareRiyadh")}
        </button>
      </div>
    );
  if (node?.type === "whatsapp_flow")
    return (
      <div className="bot-simulator-input">
        <span>{t("bot.simulator.reply")}</span>
        <button className="button secondary small" onClick={() => choose({ type: "flow_response", flowToken: `simulator-${node.id}`, data: { result: "completed" } })}>
          {t("bot.simulator.completeForm")}
        </button>
      </div>
    );
  return null;
}

async function botData(
  requestError: (status: number) => string,
  signal?: AbortSignal,
) {
  const [flowsResponse, actionsResponse, assignmentsResponse, conversations] =
    await Promise.all([
      fetch("/api/bot-flows/catalog?limit=25", { cache: "no-store", signal }),
      fetch("/api/bot-flows/actions/catalog?limit=100", { cache: "no-store", signal }),
      fetch("/api/bot-flows/assignments", { cache: "no-store", signal }),
      fetchBotConversationPage({ signal }),
    ]);
  const responses = [flowsResponse, actionsResponse, assignmentsResponse];
  for (const response of responses) {
    if (!response.ok)
      throw operatorLocalFailure(await responseError(response, requestError(response.status)));
  }
  const [flows, actions, assignments] = await Promise.all([
    flowsResponse.json() as Promise<CatalogPage>,
    actionsResponse.json() as Promise<CatalogPage>,
    assignmentsResponse.json() as Promise<Row[]>,
  ]);
  return [flows, actions, assignments, conversations] as const;
}

async function catalogData(url: string, requestError: (status: number) => string, signal?: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw operatorLocalFailure(await responseError(response, requestError(response.status)));
  return await response.json() as CatalogPage;
}

function appendCatalogRows(current: Row[], incoming: Row[], key: string) {
  const rows = new Map(current.map((row) => [String(row[key]), row]));
  for (const row of incoming) rows.set(String(row[key]), row);
  return [...rows.values()];
}

function refreshCatalogRows(current: Row[], incoming: Row[], extended: boolean, key: string) {
  if (!extended) return incoming.map((row) => {
    const existing = current.find((item) => String(item[key]) === String(row[key]));
    return existing?.definition === undefined ? row : { ...row, definition: existing.definition };
  });
  const refreshed = new Map(incoming.map((row) => [String(row[key]), row]));
  return current.map((row) => {
    const replacement = refreshed.get(String(row[key]));
    if (!replacement) return row;
    refreshed.delete(String(row[key]));
    return row.definition === undefined ? replacement : { ...replacement, definition: row.definition };
  }).concat([...refreshed.values()]);
}

function mergeCatalogDetail(current: Row[], detail: Row, key: string) {
  return current.map((row) => String(row[key]) === String(detail[key]) ? { ...row, ...detail } : row);
}

async function supportTeamData(
  requestError: (status: number) => string,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/zammad/routing-catalogs", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw operatorLocalFailure(await responseError(response, requestError(response.status)));
  const catalog = await response.json() as { groups?: SupportTeam[]; owners?: SupportOwner[] };
  return { teams: (catalog.groups ?? []).filter((team) => team.active && team.serviceIdentityCanCreate), owners: catalog.owners ?? [] };
}

function Conversations({
  workspaceId,
  openTicket,
  mutationHeaders,
  rows,
  flows,
  nextCursor,
  loadingMore,
  paginationError,
  paginationNotice,
  loadMore,
  canOperate,
  saving,
  mutate,
  confirm,
}: {
  workspaceId: string;
  openTicket?: (ticket: string) => void;
  mutationHeaders: Record<string, string>;
  rows: Row[];
  flows: Row[];
  nextCursor: string | null;
  loadingMore: boolean;
  paginationError: string | null;
  paginationNotice: string | null;
  loadMore: () => Promise<void>;
  canOperate: boolean;
  saving: boolean;
  mutate: (
    url: string,
    body: unknown,
    success: string,
    idempotent?: boolean,
  ) => Promise<boolean>;
  confirm: (target: {
    row: Row;
    action: "RESUME_BOT" | "RETRY_ACTION" | "HANDOFF_TO_HUMAN" | "CLOSE";
  }) => void;
}) {
  const { locale, t } = useI18n();
  const [executionTarget, setExecutionTarget] = useState<Row | null>(null);
  const [eventPage, setEventPage] = useState<BotConversationEventPage>({ items: [], next_cursor: null, overlay_events: [] });
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsLoadingMore, setEventsLoadingMore] = useState(false);
  const [eventsError, setEventsError] = useState(false);
  const [eventsMoreError, setEventsMoreError] = useState(false);
  const eventPagesExtended = useRef(false);
  const eventController = useRef<AbortController | null>(null);
  const activeExecutionId = useRef("");
  const activeExecutionVersion = useRef("");
  const [executionFlow, setExecutionFlow] = useState<Row | null>(null);
  const executionId = String(executionTarget?.id ?? "");
  const currentExecutionTarget = rows.find((row) => String(row.id) === executionId) ?? executionTarget;
  const executionDefinition = currentExecutionTarget
    ? flowDefinition(executionFlow && executionFlow.flow_version_id === currentExecutionTarget.flow_version_id
      ? executionFlow.definition
      : flows.find((flow) => String(flow.flow_version_id) === String(currentExecutionTarget.flow_version_id))?.definition)
    : null;
  const loadEvents = useCallback(async (
    conversationId: string,
    cursor?: string,
    mode: "open" | "refresh" | "append" = "open",
    signal?: AbortSignal,
  ) => {
    if (!conversationId) return;
    const controller = signal ? null : new AbortController();
    if (controller) {
      eventController.current?.abort();
      eventController.current = controller;
    }
    if (mode === "append") setEventsLoadingMore(true);
    else if (mode === "open") setEventsLoading(true);
    if (mode === "open") setEventsError(false);
    if (mode === "append") setEventsMoreError(false);
    try {
      const requestSignal = signal ?? controller!.signal;
      const requestedVersion = activeExecutionVersion.current;
      const [page, detail] = await Promise.all([
        fetchBotConversationEventPage({ conversationId, cursor, signal: requestSignal }),
        mode === "open" ? fetch(`/api/bot-flows/${encodeURIComponent(requestedVersion)}`, { cache: "no-store", signal: requestSignal })
          .then(async response => {
            if (!response.ok) throw new Error("Execution workflow unavailable");
            const detail = await response.json() as Row;
            if (String(detail.flow_version_id) !== requestedVersion || !flowDefinition(detail.definition)) throw new Error("Execution workflow unavailable");
            return detail;
          }) : Promise.resolve(null),
      ]);
      if (requestSignal.aborted || activeExecutionId.current !== conversationId) return;
      if (detail) setExecutionFlow(detail);
      setEventPage((current) => mode === "append"
        ? appendBotConversationEventPage(current, page)
        : refreshBotConversationEventPage(current, page, mode === "refresh" && eventPagesExtended.current));
    } catch (problem) {
      if (!(signal ?? controller?.signal)?.aborted && activeExecutionId.current === conversationId && !isAbortError(problem)) {
        if (mode === "open") setEventsError(true);
        else if (mode === "append") setEventsMoreError(true);
      }
    } finally {
      if (!signal && eventController.current === controller) eventController.current = null;
      if (!(signal ?? controller?.signal)?.aborted && activeExecutionId.current === conversationId) {
        if (mode === "append") setEventsLoadingMore(false);
        else if (mode === "open") setEventsLoading(false);
      }
    }
  }, []);
  useEffect(() => () => {
    activeExecutionId.current = "";
    eventController.current?.abort();
  }, []);
  useVisibleRefresh(
    (signal) => executionId ? loadEvents(executionId, undefined, "refresh", signal) : undefined,
    Boolean(executionId) && !eventsLoading && !eventsLoadingMore,
  );
  const openExecution = (row: Row) => {
    eventController.current?.abort();
    activeExecutionId.current = String(row.id);
    activeExecutionVersion.current = String(row.flow_version_id);
    setExecutionFlow(null);
    eventPagesExtended.current = false;
    setEventPage({ items: [], next_cursor: null, overlay_events: [] });
    setExecutionTarget(row);
    setEventsMoreError(false);
    void loadEvents(String(row.id));
  };
  const closeExecution = () => {
    eventController.current?.abort();
    eventController.current = null;
    activeExecutionId.current = "";
    setExecutionTarget(null);
    setExecutionFlow(null);
    setEventsError(false);
    setEventsMoreError(false);
  };
  return (
    <section className="panel bot-conversations">
      <div className="panel-heading">
        <div>
          <h2>{t("bot.conversations.title")}</h2>
          <p>{t("bot.conversations.help")}</p>
        </div>
        {canOperate ? (
          <span className="tag">{t("bot.conversations.operator")}</span>
        ) : (
          <span className="tag">{t("automation.common.readOnly")}</span>
        )}
      </div>
      {rows.length ? (
        <>
          <div className="bot-conversation-list">
            {rows.map((row) => {
              const ticketNumber = openTicket ? botConversationTicketNumber(row.zammad_ticket_number) : null;
              const failed =
                row.state === "HANDOFF_PENDING" &&
                row.handoff_state === "FAILED_TERMINAL";
              const retryable = failed || (row.state === "HANDOFF_PENDING" && row.handoff_state === "FAILED_RETRYABLE");
              const unknown =
                row.state === "ACTION_PENDING" &&
                row.action_state === "OUTCOME_UNKNOWN";
              const operable = row.state === "HUMAN" || failed || unknown;
              const retry = () =>
                mutate(
                  `/api/bot-flows/conversations/${encodeURIComponent(String(row.id))}/command`,
                  {
                    action: "RETRY_HANDOFF",
                    expectedFencingToken: Number(row.fencing_token),
                  },
                  t("bot.conversations.retryNotice"),
                  true,
                );
              return (
              <article key={String(row.id)}>
                <header>
                  <div>
                    <b>
                      {t("bot.conversations.case", { ticket: isolate(`#${String(row.zammad_ticket_number ?? t("bot.conversations.pending"))}`) })}
                    </b>
                    <small>
                      {String(row.connection_name)} · {String(row.flow_name)} {t("bot.versionShort", { version: formatNumber(Number(row.version), locale) })}
                    </small>
                  </div>
                  <State value={row.state} />
                </header>
                <dl>
                  <div>
                    <dt>{t("bot.conversations.lastActivity")}</dt>
                    <dd>{formatTime(row.last_activity_at, locale, t)}</dd>
                  </div>
                  <div>
                    <dt>{t("bot.conversations.steps")}</dt>
                    <dd>{formatNumber(Number(row.step_count), locale)}</dd>
                  </div>
                  <div>
                    <dt>{t("bot.conversations.handoff")}</dt>
                    <dd>
                      {row.handoff_state ? statusLabel(row.handoff_state, t) : t("bot.conversations.notRequested")}
                    </dd>
                  </div>
                </dl>
                {row.handoff_safe_error ? (
                  <p className="bot-inline-error">
                    {t("bot.conversations.handoffFailed")}
                  </p>
                ) : null}
                {unknown ? (
                  <p className="bot-inline-error">
                    {t("bot.conversations.unknownAction")}
                  </p>
                ) : null}
                {canOperate && (operable || retryable) ? (
                  <div className="bot-conversation-actions">
                    {retryable ? (
                      <button
                        className="button primary small"
                        disabled={saving}
                        onClick={() => void retry()}
                      >
                        {t("bot.conversations.retryHandoff")}
                      </button>
                    ) : null}
                    {unknown ? (
                      <button
                        className="button primary small"
                        disabled={saving}
                        onClick={() => confirm({ row, action: "RETRY_ACTION" })}
                      >
                        {t("bot.command.retry")}
                      </button>
                    ) : null}
                    {unknown ? (
                      <button
                        className="button secondary small"
                        disabled={saving}
                        onClick={() =>
                          confirm({ row, action: "HANDOFF_TO_HUMAN" })
                        }
                      >
                        {t("bot.command.handoff")}
                      </button>
                    ) : null}
                    {operable && !unknown ? (
                      <button
                        className="button secondary small"
                        disabled={saving}
                        onClick={() => confirm({ row, action: "RESUME_BOT" })}
                      >
                        {t("bot.command.resume")}
                      </button>
                    ) : null}
                    {operable ? <button
                      className="button secondary small"
                      disabled={saving}
                      onClick={() => confirm({ row, action: "CLOSE" })}
                    >
                      {t("bot.command.close")}
                    </button> : null}
                  </div>
                ) : null}
                <div className="bot-conversation-actions">
                  {ticketNumber ? <a
                    className="button secondary small"
                    href={`/app?view=inbox&ticket=${encodeURIComponent(ticketNumber)}`}
                    onClick={event => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      openTicket?.(ticketNumber);
                    }}
                  >{t("cases.action.open", { ticket: isolate(`#${ticketNumber}`) })}</a> : null}
                  <button type="button" className="button secondary small" onClick={() => openExecution(row)}>
                    {t("bot.conversations.viewExecution")}
                  </button>
                  {row.connection_provider === "META" ? <MetaThreadControl conversationId={String(row.id)} connectionId={String(row.connection_id)} workspaceId={workspaceId} label={`${String(row.connection_name)} · ${t("bot.conversations.case", { ticket: isolate(`#${String(row.zammad_ticket_number ?? t("bot.conversations.pending"))}`) })}`} mutationHeaders={mutationHeaders} /> : null}
                </div>
              </article>
            );
            })}
          </div>
          {paginationError ? (
            <p className="bot-conversation-pagination-error" role="alert">
              {paginationError}
            </p>
          ) : null}
          {nextCursor ? (
            <div className="bot-conversation-pagination">
              <button
                type="button"
                className="button secondary"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {t(
                  loadingMore
                    ? "bot.conversations.loadingMore"
                    : "bot.conversations.loadMore",
                )}
              </button>
            </div>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">
            {paginationNotice}
          </p>
        </>
      ) : (
        <EmptyState
          title={t("bot.conversations.emptyTitle")}
          body={t("bot.conversations.emptyBody")}
        />
      )}
      {currentExecutionTarget ? <ModalDialog close={closeExecution} className="modal-backdrop" aria-labelledby="bot-execution-title">
        <div className="modal">
          <div className="modal-head">
            <div><h2 id="bot-execution-title">{t("bot.conversations.executionTitle", { ticket: isolate(`#${String(currentExecutionTarget.zammad_ticket_number ?? t("bot.conversations.pending"))}`) })}</h2><p>{t("bot.conversations.executionHelp")}</p></div>
            <button type="button" aria-label={t("bot.conversations.closeExecution")} onClick={closeExecution}>{t("bot.conversations.close")}</button>
          </div>
          {eventsLoading ? <section className="bot-loading" role="status" aria-live="polite" aria-busy="true" aria-label={t("bot.conversations.loadingExecution")}><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></section>
          : eventsError ? <div className="settings-feedback error" role="alert"><span>!</span><p>{t("bot.conversations.executionFailed")}</p><button type="button" className="button small" onClick={() => void loadEvents(executionId)}>{t("automation.common.reload")}</button></div>
          : eventPage.items.length ? <ol className="bot-node-list">
              {[...eventPage.items].reverse().map((event, index) => <li key={event.id}>
                <span>{formatNumber(index + 1, locale)}</span>
                <div><b>{workflowEventLabel(event.kind, t)}</b><p>{workflowStepLabel(event.from, executionDefinition, "start", locale, t)} → {workflowStepLabel(event.to, executionDefinition, "end", locale, t)} · {formatTime(event.at, locale, t)}</p></div>
              </li>)}
            </ol>
          : <EmptyState title={t("bot.conversations.noTimeline")} body={t("bot.conversations.noTimelineHelp")} />}
          <div className="modal-actions">
            {eventsMoreError ? <p className="settings-feedback error" role="alert">{t("bot.conversations.olderEventsFailed")}</p> : null}
            {eventPage.next_cursor ? <button type="button" className="button secondary" disabled={eventsLoadingMore} onClick={() => {
              eventPagesExtended.current = true;
              void loadEvents(executionId, eventPage.next_cursor!, "append");
            }}>{t(eventsLoadingMore ? "bot.conversations.loadingOlderEvents" : "bot.conversations.loadOlderEvents")}</button> : null}
            <button type="button" className="button secondary" onClick={closeExecution}>{t("bot.conversations.close")}</button>
          </div>
        </div>
      </ModalDialog> : null}
    </section>
  );
}

function Assignments({
  rows,
  flows,
  connections,
  canWrite,
  saving,
  mutate,
  supportTeams,
  confirmState,
  error,
}: {
  rows: Row[];
  flows: Row[];
  connections: Row[];
  canWrite: boolean;
  saving: boolean;
  error: string | null;
  mutate: (
    url: string,
    body: unknown,
    success: string,
    idempotent?: boolean,
  ) => Promise<boolean>;
  supportTeams: SupportTeam[];
  confirmState: (row: Row) => void;
}) {
  const { locale, t } = useI18n();
  const activeFamilies = flows.filter((flow) => flow.state === "ACTIVE");
  const assignedConnectionIds = new Set(
    rows.filter((row) => row.state === "ACTIVE").map((row) => String(row.connection_id)),
  );
  const availableConnections = connections.filter(
    (connection) => connection.state === "WORKING" && !assignedConnectionIds.has(String(connection.id)),
  );
  const [connectionId, setConnectionId] = useState(
    String(availableConnections[0]?.id ?? ""),
  );
  const [familyId, setFamilyId] = useState(
    String(activeFamilies[0]?.family_id ?? ""),
  );
  const [zammadGroupId, setZammadGroupId] = useState("");
  const [attributionTarget, setAttributionTarget] = useState<Row | null>(null);
  const [agentPrefix, setAgentPrefix] = useState("");
  const [agentIdentityPlacement, setAgentIdentityPlacement] = useState<"HEADER" | "FOOTER" | "OFF">("HEADER");
  const selectedSupportTeamId = zammadGroupId || supportTeams[0]?.id || "";
  const fallbackConnectionId = String(availableConnections[0]?.id ?? "");
  const selectedConnectionId = availableConnections.some((connection) => String(connection.id) === connectionId)
    ? connectionId
    : fallbackConnectionId;
  const fallbackFamilyId = String(activeFamilies[0]?.family_id ?? "");
  const selectedFamilyId = activeFamilies.some((flow) => String(flow.family_id) === familyId)
    ? familyId
    : fallbackFamilyId;
  const assignmentBlocker = !availableConnections.length
    ? t("bot.assignments.noConnection")
    : !activeFamilies.length
      ? t("bot.assignments.noActiveFlow")
      : !supportTeams.length
        ? t("bot.assignments.noSupportTeam")
        : null;
  return (
    <div className="bot-assignment-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t("bot.assignments.title")}</h2>
            <p>{t("bot.assignments.help")}</p>
          </div>
        </div>
        {rows.length ? (
          <div className="bot-assignment-list">
            {rows.map((row) => (
              <article key={String(row.id)}>
                <div>
                  <b>{String(row.connection_name)}</b>
                  <small>
                    {String(row.provider).toLowerCase() === "meta"
                      ? t("bot.assignments.official")
                      : t("bot.assignments.linked")}
                  </small>
                </div>
                <div>
                  <span>
                    {String(row.flow_name)} · {t("bot.versionShort", { version: formatNumber(Number(row.version), locale) })}
                  </span>
                  <small>{t("bot.assignments.teamNamed", { team: supportTeams.find((team) => team.id === String(row.zammad_group_id))?.name ?? t("bot.assignments.teamUnavailable") })}</small>
                  <small className="bot-assignment-health">{t("bot.assignments.connectionHealth")} <State value={row.connection_state} /></small>
                </div>
                <State value={row.state} />
                {canWrite ? <div className="bot-assignment-actions"><button className="button secondary small" disabled={saving} onClick={() => { setAttributionTarget(row); setAgentPrefix(String(row.agent_prefix ?? "Agent:")); setAgentIdentityPlacement((row.agent_identity_placement === "FOOTER" || row.agent_identity_placement === "OFF") ? row.agent_identity_placement : "HEADER"); }}>{t("bot.assignments.attribution.configure")}</button><button className="button secondary small" disabled={saving} onClick={() => confirmState(row)}>{t(row.state === "ACTIVE" ? "bot.assignments.pause" : "bot.assignments.resume")}</button></div> : null}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title={t("bot.assignments.emptyTitle")}
            body={t("bot.assignments.emptyBody")}
          />
        )}
      </section>
      {canWrite ? (
        <form
          className="panel bot-assignment-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              "/api/bot-flows/assignments",
              { connectionId: selectedConnectionId, familyId: selectedFamilyId, zammadGroupId: selectedSupportTeamId },
              t("bot.assignments.notice"),
              true,
            );
          }}
        >
          <div className="panel-heading">
            <div>
              <h2>{t("bot.assignments.formTitle")}</h2>
              <p>{t("bot.assignments.formHelp")}</p>
            </div>
          </div>
          {assignmentBlocker ? <p id="bot-assignment-blocker" className="bot-inline-error" role="status">{assignmentBlocker}</p> : null}
          <label htmlFor="bot-assignment-connection">
            {t("bot.assignments.connection")}
            <select
              id="bot-assignment-connection"
              required
              value={selectedConnectionId}
              aria-describedby={assignmentBlocker ? "bot-assignment-blocker" : undefined}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              <option value="" disabled>{t("bot.assignments.connection")}</option>
              {availableConnections.map((connection) => (
                <option
                  key={String(connection.id)}
                  value={String(connection.id)}
                >
                  {String(connection.name)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="bot-assignment-flow">
            {t("bot.assignments.flow")}
            <select
              id="bot-assignment-flow"
              required
              value={selectedFamilyId}
              aria-describedby={assignmentBlocker ? "bot-assignment-blocker" : undefined}
              onChange={(event) => setFamilyId(event.target.value)}
            >
              {activeFamilies.map((flow) => (
                <option
                  key={String(flow.family_id)}
                  value={String(flow.family_id)}
                >
                  {String(flow.name)} · {t("bot.versionShort", { version: formatNumber(Number(flow.version), locale) })}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="bot-assignment-zammad">
            {t("bot.assignments.teamReference")}
            <select
              id="bot-assignment-zammad"
              required
              value={selectedSupportTeamId}
              aria-describedby={assignmentBlocker ? "bot-assignment-blocker bot-assignment-team-help" : "bot-assignment-team-help"}
              onChange={(event) => setZammadGroupId(event.target.value)}
            >
              <option value="" disabled>{t("bot.assignments.selectTeam")}</option>
              {supportTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
            <small id="bot-assignment-team-help">
              {t("bot.assignments.teamHelp")}
            </small>
          </label>
          <button
            className="button primary"
            disabled={saving || Boolean(assignmentBlocker) || !selectedConnectionId || !selectedFamilyId || !selectedSupportTeamId}
          >
            {t(saving ? "bot.assignments.assigning" : "bot.assignments.confirm")}
          </button>
        </form>
      ) : null}
      {attributionTarget ? <ModalDialog close={() => setAttributionTarget(null)} className="modal-backdrop" aria-labelledby="bot-assignment-attribution-title"><form className="modal bot-confirm bot-attribution-form" onSubmit={(event) => { event.preventDefault(); void mutate(`/api/bot-flows/assignments/${encodeURIComponent(String(attributionTarget.id))}/attribution`, { agentPrefix: agentPrefix.trim(), agentIdentityPlacement, expectedRevision: Number(attributionTarget.revision) }, t("bot.assignments.attribution.notice"), true).then((saved) => { if (saved) setAttributionTarget(null); }); }}><div><span className="eyebrow">{t("bot.assignments.attribution.eyebrow")}</span><h2 id="bot-assignment-attribution-title">{t("bot.assignments.attribution.title", { name: String(attributionTarget.connection_name) })}</h2><p>{t("bot.assignments.attribution.help")}</p>{error ? <p className="bot-inline-error" role="alert">{error}</p> : null}</div><label htmlFor="bot-assignment-agent-prefix">{t("bot.assignments.attribution.prefix")}<input id="bot-assignment-agent-prefix" required maxLength={80} value={agentPrefix} onChange={(event) => setAgentPrefix(event.target.value)} aria-describedby="bot-assignment-agent-prefix-help"/><small id="bot-assignment-agent-prefix-help">{t("bot.assignments.attribution.prefixHelp")}</small></label><label htmlFor="bot-assignment-agent-placement">{t("bot.assignments.attribution.placement")}<select id="bot-assignment-agent-placement" value={agentIdentityPlacement} onChange={(event) => setAgentIdentityPlacement(event.target.value as "HEADER" | "FOOTER" | "OFF")}><option value="HEADER">{t("bot.assignments.attribution.header")}</option><option value="FOOTER">{t("bot.assignments.attribution.footer")}</option><option value="OFF">{t("bot.assignments.attribution.off")}</option></select></label><p className="bot-attribution-preview"><small>{t("bot.assignments.attribution.preview")}</small><bdi>{agentIdentityPlacement === "OFF" ? t("bot.assignments.attribution.previewOff") : agentIdentityPlacement === "HEADER" ? `${agentPrefix.trim()} ${t("bot.assignments.attribution.agentExample")}\n${t("bot.assignments.attribution.messageExample")}` : `${t("bot.assignments.attribution.messageExample")}\n${agentPrefix.trim()} ${t("bot.assignments.attribution.agentExample")}`}</bdi></p><div className="modal-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => setAttributionTarget(null)}>{t("automation.common.cancel")}</button><button className="button primary" disabled={saving || !agentPrefix.trim()}>{t(saving ? "bot.assignments.attribution.saving" : "bot.assignments.attribution.save")}</button></div></form></ModalDialog> : null}
    </div>
  );
}

export function PluginCatalog({
  canWrite,
  mutationHeaders,
}: {
  canWrite: boolean;
  mutationHeaders: Record<string, string>;
}) {
  const { t } = useI18n();
  const requestError = useCallback((status: number) => t("automation.common.requestFailed", { status }), [t]);
  const [actions, setActions] = useState<Row[]>([]);
  const [actionCursor, setActionCursor] = useState<string | null>(null);
  const [loadingMoreActions, setLoadingMoreActions] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const actionPagesExtended = useRef(false);
  const [integrations, setIntegrations] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<CodedOperatorError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saveIntent = useRef<{ fingerprint: string; credentialKey: string; actionKey: string } | null>(null);
  const restoreKeys = useRef(new Map<string,string>());
  const loadFence = useRef(createLatestRequestFence());
  const load = useCallback(async (background = false, signal?: AbortSignal) => {
    const request=loadFence.current.begin();const isCurrent=()=>!signal?.aborted&&loadFence.current.isCurrent(request);
    if (!background) setLoading(true);
    setLoadError(null);
    try {
      const [actionsResponse, integrationsResponse] = await Promise.all([
        fetch("/api/bot-flows/actions/catalog?limit=50", { cache: "no-store", signal }),
        fetch("/api/client-routing/integrations", { cache: "no-store", signal }),
      ]);
      if (!actionsResponse.ok) throw operatorLocalFailure(await responseError(actionsResponse, requestError(actionsResponse.status)));
      if (!integrationsResponse.ok) throw operatorLocalFailure(await responseError(integrationsResponse, requestError(integrationsResponse.status)));
      const page = await actionsResponse.json() as CatalogPage;
      const nextIntegrations = await integrationsResponse.json() as Row[];
      if(!isCurrent())return;
      setActions((current) => refreshCatalogRows(current, page.items, actionPagesExtended.current, "id"));
      setActionCursor((current) => actionPagesExtended.current ? current : page.next_cursor);
      setPaginationError(null);
      setIntegrations(nextIntegrations);
    } catch (problem) {
      if(isCurrent()&&!isAbortError(problem))setLoadError(operatorFailureMessage(problem, t("bot.errors.unavailable")));
    } finally {
      if (!background&&isCurrent()) setLoading(false);
    }
  }, [requestError, t]);
  useEffect(() => {
    const fence=loadFence.current;const controller=new AbortController();const timer = window.setTimeout(() => void load(false,controller.signal), 0);
    return () => {controller.abort();window.clearTimeout(timer);fence.invalidate()};
  }, [load]);
  useVisibleRefresh((signal) => load(true, signal), !saving);
  const loadMoreActions = async () => {
    if (!actionCursor || loadingMoreActions) return;
    setLoadingMoreActions(true); setPaginationError(null);
    try {
      const page = await catalogData(`/api/bot-flows/actions/catalog?limit=50&cursor=${encodeURIComponent(actionCursor)}`, requestError);
      actionPagesExtended.current = true;
      setActions((current) => appendCatalogRows(current, page.items, "id"));
      setActionCursor(page.next_cursor);
    } catch {
      setPaginationError(t("plugins.catalog.loadMoreFailed"));
    } finally { setLoadingMoreActions(false); }
  };
  const saveAction = async (body: Record<string, unknown>, credential: string) => {
    const fingerprint = JSON.stringify({ body, credential });
    if (saveIntent.current?.fingerprint !== fingerprint) {
      saveIntent.current = { fingerprint, credentialKey: crypto.randomUUID(), actionKey: crypto.randomUUID() };
    }
    const intent = saveIntent.current;
    setSaving(true);
    setMutationError(null);
    setNotice(null);
    try {
      if (credential) {
        const credentialResponse = await fetch("/api/bot-flows/actions/credential", {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": intent.credentialKey },
          body: JSON.stringify({ actionKey: body.actionKey, credential }),
        });
        if (!credentialResponse.ok) throw await operatorResponseFailure(credentialResponse, requestError(credentialResponse.status));
        body.secretReference = String((await credentialResponse.json() as { secretReference: string }).secretReference);
      }
      const response = await fetch("/api/bot-flows/actions", {
        method: "POST",
        headers: { ...mutationHeaders, "idempotency-key": intent.actionKey },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await operatorResponseFailure(response, requestError(response.status));
      saveIntent.current = null;
      setNotice(t("bot.actions.notice"));
      await load(true);
      return true;
    } catch (problem) {
      setMutationError(problem instanceof Error && "code" in problem
        ? problem as CodedOperatorError
        : Object.assign(new Error(operatorFailureMessage(problem, t("bot.errors.change"))), { code: "UNKNOWN" as const }));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const restoreAction = async (actionKey:string,revision:number,expectedRevision:number) => {
    const intent=`${actionKey}:${revision}:${expectedRevision}`;const key=restoreKeys.current.get(intent)??crypto.randomUUID();restoreKeys.current.set(intent,key);
    setSaving(true);setMutationError(null);setNotice(null);
    try{
      const response=await fetch(`/api/bot-flows/actions/${encodeURIComponent(actionKey)}/revisions/${revision}/restore`,{method:"POST",headers:{...mutationHeaders,"idempotency-key":key},body:JSON.stringify({expectedRevision})});
      if(!response.ok)throw await operatorResponseFailure(response,requestError(response.status));
      restoreKeys.current.delete(intent);setNotice(t("plugins.history.restored",{revision}));await load(true);return true;
    }catch(problem){setMutationError(problem instanceof Error&&"code" in problem?problem as CodedOperatorError:Object.assign(new Error(operatorFailureMessage(problem, t("bot.errors.change"))),{code:"UNKNOWN" as const}));return false}
    finally{setSaving(false)}
  };
  if (loadError && !loading && !actions.length) return <section className="panel settings-load-error" role="alert"><span>!</span><div><p>{loadError}</p><button className="button small" onClick={() => void load()}>{t("automation.common.reload")}</button></div></section>;
  if (loading && !actions.length) return <section className="panel bot-loading" role="status" aria-live="polite" aria-busy="true" aria-label={t("plugins.loading")}><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></section>;
  return <div className="plugin-catalog">
    {loadError ? <div className="settings-feedback error bot-feedback" role="alert"><span>!</span><p>{loadError}</p><button className="button small" onClick={() => void load()}>{t("automation.common.reload")}</button></div> : null}
    {notice ? <div className="settings-feedback success bot-feedback" role="status"><span>✓</span><p>{notice}</p></div> : null}
    <Actions rows={actions} integrations={integrations} canWrite={canWrite} saving={saving} mutationError={mutationError} clearMutationError={() => setMutationError(null)} mutationHeaders={mutationHeaders} saveAction={saveAction} restoreAction={restoreAction} nextCursor={actionCursor} loadingMore={loadingMoreActions} paginationError={paginationError} loadMore={loadMoreActions} />
  </div>;
}

function Actions({
  rows,
  integrations,
  canWrite,
  saving,
  mutationError,
  clearMutationError,
  mutationHeaders,
  saveAction,
  restoreAction,
  nextCursor,
  loadingMore,
  paginationError,
  loadMore,
}: {
  rows: Row[];
  integrations: Row[];
  canWrite: boolean;
  saving: boolean;
  mutationError: CodedOperatorError | null;
  clearMutationError: () => void;
  mutationHeaders: Record<string, string>;
  saveAction: (body: Record<string, unknown>, credential: string) => Promise<boolean>;
  restoreAction: (actionKey:string,revision:number,expectedRevision:number) => Promise<boolean>;
  nextCursor: string | null;
  loadingMore: boolean;
  paginationError: string | null;
  loadMore: () => void;
}) {
  const { locale, t } = useI18n();
  const [editing, setEditing] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const editAction = async (row: Row) => {
    setDetailLoading(true); setDetailError(null);
    try {
      const response = await fetch(`/api/bot-flows/actions/${encodeURIComponent(String(row.action_key))}`, { cache: "no-store" });
      if (!response.ok) throw operatorLocalFailure(t("plugins.catalog.detailUnavailable"));
      clearMutationError();
      setEditing(await response.json() as Row);
    } catch (problem) {
      setDetailError(operatorFailureMessage(problem, t("plugins.catalog.detailUnavailable")));
    } finally { setDetailLoading(false); }
  };
  const plugins = groupActions(rows);
  return (
    <div className="bot-action-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{t("plugins.catalog.title")}</h2>
            <p>{t("plugins.catalog.help")}</p>
          </div>
          {canWrite ? (
            <button
              className="button primary small"
              onClick={() => { clearMutationError(); setEditing({}); }}
            >
              {t("plugins.actions.new")}
            </button>
          ) : (
            <span className="tag">{t("automation.common.readOnly")}</span>
          )}
        </div>
        {plugins.length ? (
          <div className="plugin-list">
            {plugins.map(({ key, actions: pluginActions }) => <section key={key} className="plugin-group" aria-labelledby={`plugin-${key}`}>
              <header><span className="plugin-mark" aria-hidden="true">{key.slice(0, 1).toUpperCase()}</span><div><h3 id={`plugin-${key}`}>{pluginLabel(key)}</h3><p>{t(pluginActions.length === 1 ? "plugins.catalog.actionCountOne" : "plugins.catalog.actionCount", { count: formatNumber(pluginActions.length, locale) })}</p></div></header>
              <div className="bot-action-list">
              {pluginActions.map((row) => (
              <article key={String(row.id)}>
                <div>
                  <b>{String(row.name)}</b>
                  <code>{actionPart(row.action_key)}</code>
                  <small>{String(row.http_method)} · {t(String(row.kind).toUpperCase().startsWith("NOTION") ? "plugins.catalog.kindNotion" : "plugins.catalog.kindHttps")}</small>
                </div>
                <span>
                  <State value={row.state} />
                  <small>{t("bot.actions.revision", { revision: formatNumber(Number(row.revision), locale) })}</small>
                </span>
                {canWrite ? (
                  <button
                    className="button secondary small"
                    aria-disabled={detailLoading}
                    aria-busy={detailLoading || undefined}
                    onClick={() => { if (!detailLoading) void editAction(row); }}
                  >
                      {t("plugins.actions.configure")}
                  </button>
                ) : null}
              </article>
              ))}
              </div>
            </section>)}
          </div>
        ) : (
          <EmptyState
            title={t("bot.actions.emptyTitle")}
            body={t("bot.actions.emptyBody")}
          />
        )}
        {detailError ? <p className="bot-inline-error" role="alert">{detailError}</p> : null}
        {paginationError ? <p className="bot-inline-error" role="alert">{paginationError}</p> : null}
        {nextCursor ? <button type="button" className="routing-version-toggle" disabled={loadingMore} onClick={loadMore}>{t(loadingMore ? "plugins.catalog.loadingMore" : "plugins.catalog.loadMore")}</button> : null}
      </section>
      {editing ? (
        <ActionForm
          row={editing}
          integrations={integrations}
          saving={saving}
          mutationError={mutationError}
          mutationHeaders={mutationHeaders}
          cancel={() => { clearMutationError(); setEditing(null); }}
          save={async (body, credential) => {
            if (await saveAction(body, credential)) setEditing(null);
          }}
          restore={async (actionKey,revision,expectedRevision)=>{if(await restoreAction(actionKey,revision,expectedRevision))setEditing(null)}}
        />
      ) : null}
    </div>
  );
}

type ActionQualification = {
  qualificationId?: string;
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  outcome: null | "SUCCESS" | "ERROR" | "TIMEOUT" | "OUTCOME_UNKNOWN";
};

function qualificationResponse(value: unknown): ActionQualification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Qualification response is invalid");
  const response = value as Record<string, unknown>;
  const states = new Set(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN"]);
  const outcomes = new Set(["SUCCESS", "ERROR", "TIMEOUT", "OUTCOME_UNKNOWN"]);
  if (!states.has(String(response.state))) throw new Error("Qualification state is invalid");
  const outcome = response.outcome == null ? null : String(response.outcome);
  if (outcome !== null && !outcomes.has(outcome)) throw new Error("Qualification outcome is invalid");
  return {
    qualificationId: typeof response.qualificationId === "string" ? response.qualificationId : undefined,
    state: String(response.state) as ActionQualification["state"],
    outcome: outcome as ActionQualification["outcome"],
  };
}

function qualificationMessage(qualification: ActionQualification) {
  if (qualification.outcome === "SUCCESS") return "plugins.qualification.success";
  if (qualification.outcome === "TIMEOUT") return "plugins.qualification.timeout";
  if (qualification.outcome === "OUTCOME_UNKNOWN" || qualification.state === "OUTCOME_UNKNOWN") return "plugins.qualification.unknown";
  if (qualification.outcome === "ERROR" || qualification.state === "FAILED") return "plugins.qualification.failed";
  return "plugins.qualification.inProgress";
}

function qualificationTone(qualification: ActionQualification) {
  if (qualification.outcome === "SUCCESS") return "success";
  if (qualification.state === "QUEUED" || qualification.state === "RUNNING") return "";
  return "error";
}

const QUALIFICATION_POLL_HORIZON_MS = 75_000;
const QUALIFICATION_POLL_INTERVAL_MS = 1_000;
const QUALIFICATION_POLL_MAX_BACKOFF_MS = 5_000;

function retryableQualificationStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

type FieldRow = { key: string; value: string };
const fieldRows = (value: unknown): FieldRow[] => {
  const rows = value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, value: String(item ?? "") }))
    : [];
  return rows.length ? rows : [{ key: "", value: "" }];
};
const fieldRecord = (rows: FieldRow[]) => Object.fromEntries(rows.filter(row => row.key.trim()).map(row => [row.key.trim(), row.value]));

function FieldRows({ rows, setRows, addLabel, keyLabel, valueLabel, removeLabel }: {
  rows: FieldRow[];
  setRows: React.Dispatch<React.SetStateAction<FieldRow[]>>;
  addLabel: string;
  keyLabel: string;
  valueLabel: string;
  removeLabel: string;
}) {
  return <div>{rows.map((row,index)=><div className="rule-command-input" key={index}>
    <input aria-label={keyLabel} placeholder={keyLabel} maxLength={128} value={row.key} onChange={event=>setRows(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,key:event.target.value}:item))}/>
    <input aria-label={valueLabel} placeholder={valueLabel} maxLength={1000} value={row.value} onChange={event=>setRows(current=>current.map((item,itemIndex)=>itemIndex===index?{...item,value:event.target.value}:item))}/>
    <button type="button" className="button small secondary" aria-label={removeLabel} disabled={rows.length===1} onClick={()=>setRows(current=>current.filter((_,itemIndex)=>itemIndex!==index))}>×</button>
  </div>)}<button type="button" className="text-button" onClick={()=>setRows(current=>[...current,{key:"",value:""}])}>{addLabel}</button></div>;
}

function ActionForm({
  row,
  integrations,
  saving,
  mutationError,
  mutationHeaders,
  cancel,
  save,
  restore,
}: {
  row: Row;
  integrations: Row[];
  saving: boolean;
  mutationError: CodedOperatorError | null;
  mutationHeaders: Record<string, string>;
  cancel: () => void;
  save: (body: Record<string, unknown>, credential: string) => Promise<void>;
  restore: (actionKey:string,revision:number,expectedRevision:number) => Promise<void>;
}) {
  const { t } = useI18n();
  const originalKey = String(row.action_key ?? "");
  const initialParts = actionParts(originalKey);
  const [pluginKey, setPluginKey] = useState(initialParts.plugin);
  const [actionKey, setActionKey] = useState(initialParts.action);
  const [name, setName] = useState(String(row.name ?? ""));
  const [kind, setKind] = useState(String(row.kind ?? "HTTP_JSON"));
  const [endpoint, setEndpoint] = useState(
    String(row.endpoint_url ?? "https://"),
  );
  const [method, setMethod] = useState(String(row.http_method ?? "POST"));
  const [auth, setAuth] = useState(String(row.auth_scheme ?? "NONE"));
  const existingSecretReference = String(row.secret_reference ?? "");
  const connectedIntegrations=integrations.filter(integration=>integration.provider==="NOTION"&&integration.state==="CONNECTED"&&integration.binding_reference);
  const [integrationReference, setIntegrationReference] = useState(
    connectedIntegrations.some((integration) => integration.binding_reference === existingSecretReference) ? existingSecretReference : "",
  );
  const [credential, setCredential] = useState("");
  const [state, setState] = useState(String(row.state ?? "PAUSED"));
  const [timeoutMs, setTimeoutMs] = useState(Number(row.timeout_ms ?? 5000));
  const [maxResponseBytes, setMaxResponseBytes] = useState(Number(row.max_response_bytes ?? 262144));
  const [headerRows, setHeaderRows] = useState(() => fieldRows(row.headers));
  const [mappingRows, setMappingRows] = useState(() => fieldRows(row.response_mapping));
  const [qualificationInputs,setQualificationInputs]=useState<FieldRow[]>([{key:"",value:""}]);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [qualification, setQualification] = useState<ActionQualification | null>(null);
  const [qualificationError,setQualificationError]=useState<CodedOperatorError|null>(null);
  const [qualificationStatusUnavailable, setQualificationStatusUnavailable] = useState(false);
  const [qualifying, setQualifying] = useState(false);
  const qualificationRequest = useRef<AbortController | null>(null);
  const qualificationKey = useRef<string | null>(null);
  const [revisions,setRevisions]=useState<Row[]>([]);
  const [historyError,setHistoryError]=useState(false);
  const [restoreRevision,setRestoreRevision]=useState<number|null>(null);
  useEffect(() => () => qualificationRequest.current?.abort(), []);
  useEffect(()=>{if(!row.id)return;const controller=new AbortController();void fetch(`/api/bot-flows/actions/${encodeURIComponent(originalKey)}/revisions`,{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error();setRevisions(await response.json() as Row[]);setHistoryError(false)}).catch(problem=>{if(!isAbortError(problem))setHistoryError(true)});return()=>controller.abort()},[originalKey,row.id]);
  const [initialSnapshot] = useState(() => JSON.stringify({
    pluginKey,
    actionKey,
    name,
    kind,
    endpoint,
    method,
    auth,
    integrationReference,
    state,
    timeoutMs,
    maxResponseBytes,
    headerRows,
    mappingRows,
  }));
  const dirty = initialSnapshot !== JSON.stringify({
    pluginKey,
    actionKey,
    name,
    kind,
    endpoint,
    method,
    auth,
    integrationReference,
    state,
    timeoutMs,
    maxResponseBytes,
    headerRows,
    mappingRows,
  }) || credential.length > 0;
  useEffect(() => {
    if (!dirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [dirty]);
  const requestClose = () => {
    if (saving) return;
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    cancel();
  };
  const capabilities = row.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities)
    ? row.capabilities as Row
    : {};
  const qualificationSupported = row.qualification_supported === true
    && row.state === "ACTIVE"
    && capabilities.retry_semantics === "REPLAY_SAFE"
    && Boolean(row.id);
  const qualificationPending = qualification?.state === "QUEUED" || qualification?.state === "RUNNING";
  const qualify = async () => {
    if (!qualificationSupported || dirty || qualifying) return;
    qualificationRequest.current?.abort();
    const controller = new AbortController();
    qualificationRequest.current = controller;
    setQualifying(true);
    setQualificationError(null);
    setQualificationStatusUnavailable(false);
    const actionPath = encodeURIComponent(originalKey);
    try {
      let queued = qualificationPending && qualification?.qualificationId ? qualification : null;
      if (!queued) {
        setQualification({ state: "QUEUED", outcome: null });
        qualificationKey.current ??= crypto.randomUUID();
        const response = await fetch(`/api/bot-flows/actions/${actionPath}/qualifications`, {
          method: "POST",
          headers: { ...mutationHeaders, "idempotency-key": qualificationKey.current },
          body: JSON.stringify({ expectedRevision: Number(row.active_action_revision ?? row.revision), input: fieldRecord(qualificationInputs) }),
          signal: controller.signal,
        });
        if (!response.ok) {
          setQualificationError(await operatorResponseFailure(response,t("plugins.qualification.failed")));
          setQualification({ state: "FAILED", outcome: "ERROR" });
          return;
        }
        queued = qualificationResponse(await response.json());
        qualificationKey.current = null;
      }
      if (!queued.qualificationId) throw new Error("Qualification ID is missing");
      setQualification(queued);
      const deadline = Date.now() + QUALIFICATION_POLL_HORIZON_MS;
      let pollDelay = QUALIFICATION_POLL_INTERVAL_MS;
      let statusUnavailable = false;
      while (Date.now() < deadline && !controller.signal.aborted) {
        await abortableDelay(Math.min(pollDelay, deadline - Date.now()), controller.signal);
        if (document.visibilityState !== "visible") continue;
        try {
          const statusResponse = await fetch(`/api/bot-flows/actions/${actionPath}/qualifications/${encodeURIComponent(queued.qualificationId)}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (!statusResponse.ok) {
            if (!retryableQualificationStatus(statusResponse.status)) {
              setQualificationStatusUnavailable(true);
              return;
            }
            statusUnavailable = true;
            pollDelay = Math.min(pollDelay * 2, QUALIFICATION_POLL_MAX_BACKOFF_MS);
            continue;
          }
          statusUnavailable = false;
          pollDelay = QUALIFICATION_POLL_INTERVAL_MS;
          const status = qualificationResponse(await statusResponse.json());
          setQualification(status);
          if (status.state === "SUCCEEDED" || status.state === "FAILED" || status.state === "OUTCOME_UNKNOWN") return;
        } catch (problem) {
          if (controller.signal.aborted || isAbortError(problem)) throw problem;
          statusUnavailable = true;
          pollDelay = Math.min(pollDelay * 2, QUALIFICATION_POLL_MAX_BACKOFF_MS);
        }
      }
      if (!controller.signal.aborted && statusUnavailable) setQualificationStatusUnavailable(true);
    } catch (problem) {
      if (!controller.signal.aborted && !isAbortError(problem)) setQualificationStatusUnavailable(true);
    } finally {
      if (qualificationRequest.current === controller) qualificationRequest.current = null;
      setQualifying(false);
    }
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const headerMap = fieldRecord(headerRows);
      const responseMap = fieldRecord(mappingRows);
      const uniqueKeys=(rows:FieldRow[])=>{const keys=rows.filter(row=>row.key.trim()).map(row=>row.key.trim());return new Set(keys).size===keys.length};
      if(!uniqueKeys(headerRows)||!uniqueKeys(mappingRows))throw new Error();
      setError(null);
      if(!row.id&&`${pluginKey}.${actionKey}`.length>128){setError(t("plugins.form.keyTooLong"));return;}
      if (auth === "BEARER" && !integrationReference && !existingSecretReference && !credential) {
        setError(t("plugins.form.credentialRequired"));
        return;
      }
      void save({
        actionKey: row.id ? originalKey : `${pluginKey}.${actionKey}`,
        name,
        kind,
        endpointUrl: endpoint,
        httpMethod: method,
        authScheme: auth,
        secretReference: auth === "BEARER" ? integrationReference || existingSecretReference || null : null,
        headers: headerMap,
        responseMapping: responseMap,
        timeoutMs,
        maxResponseBytes,
        state,
        expectedRevision: row.revision == null ? null : Number(row.revision),
      }, credential);
    } catch {
      setError(t("bot.actionForm.jsonError"));
    }
  };
  return (
    <ModalDialog className="modal-backdrop" close={requestClose} aria-labelledby="plugin-action-dialog-title">
    <form className="modal plugin-action-form bot-action-form" data-unsaved={dirty || undefined} onSubmit={submit}>
      <div className="modal-head">
        <div>
          <h2 id="plugin-action-dialog-title">{t(row.id ? "bot.actionForm.configure" : "bot.actionForm.new")}</h2>
          <p>{t("bot.actionForm.help")}</p>
        </div>
        <button type="button" aria-label={t("plugins.form.close")} onClick={requestClose}>×</button>
      </div>
      {confirmClose ? (
        <InlineConfirmation className="inline-warning" aria-labelledby="plugin-action-discard-title" cancel={() => setConfirmClose(false)}>
          <strong id="plugin-action-discard-title">{t("plugins.form.discardTitle")}</strong>
          <p>{t("plugins.form.discardBody")}</p>
          <div className="bot-form-actions">
            <button type="button" className="button secondary" data-inline-confirm-initial-focus onClick={() => setConfirmClose(false)}>{t("plugins.form.keepEditing")}</button>
            <button type="button" className="button" onClick={cancel}>{t("plugins.form.discard")}</button>
          </div>
        </InlineConfirmation>
      ) : <>
      {mutationError ? (
        <div className="settings-feedback error bot-feedback" role="alert">
          <span aria-hidden="true">!</span>
          <p>{mutationError.message}</p>
          {mutationError.code === "REAUTHENTICATION_REQUIRED" ? (
            <a
              className="button small secondary"
              href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dplugins"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("plugins.form.reauthenticate")}
              <span className="sr-only"> {t("plugins.form.opensInNewTab")}</span>
            </a>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p id="bot-action-json-error" className="bot-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="bot-form-grid">
        <label htmlFor="bot-plugin-key">
          {t("plugins.form.pluginKey")}
          <input
            id="bot-plugin-key"
            data-modal-initial-focus
            required
            pattern={"[a-z][a-z0-9_\\-]{0,63}"}
            value={pluginKey}
            readOnly={Boolean(row.id)}
            onChange={(event) => setPluginKey(event.target.value)}
          />
          <small>{t("plugins.form.pluginKeyHelp")}</small>
        </label>
        <label htmlFor="bot-action-key">
          {t("plugins.form.actionKey")}
          <input
            id="bot-action-key"
            required
            pattern={"[a-z][a-z0-9_.\\-]{0,63}"}
            value={actionKey}
            readOnly={Boolean(row.id)}
            onChange={(event) => setActionKey(event.target.value)}
          />
          <small>{t("plugins.form.actionKeyHelp", { key: `${pluginKey || "plugin"}.${actionKey || "action"}` })}</small>
        </label>
        <label htmlFor="bot-action-name">
          {t("bot.actionForm.name")}
          <input
            id="bot-action-name"
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor="bot-action-kind">
          {t("bot.actionForm.connector")}
          <select
            id="bot-action-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              if (event.target.value !== "NOTION_CREATE_PAGE") setIntegrationReference("");
              if (event.target.value === "NOTION_CREATE_PAGE") {
                setEndpoint("https://api.notion.com/v1/pages");
                setMethod("POST");
                setAuth("BEARER");
              }
            }}
          >
            <option value="HTTP_JSON">{t("bot.actionForm.http")}</option>
            <option value="NOTION_CREATE_PAGE">{t("bot.actionForm.notion")}</option>
          </select>
        </label>
        <label htmlFor="bot-action-method">
          {t("bot.actionForm.method")}
          <select
            id="bot-action-method"
            value={method}
            disabled={kind === "NOTION_CREATE_PAGE"}
            onChange={(event) => setMethod(event.target.value)}
          >
            <option>GET</option>
            <option>POST</option>
          </select>
        </label>
        <label className="bot-form-wide" htmlFor="bot-action-endpoint">
          {t("bot.actionForm.endpoint")}
          <input
            id="bot-action-endpoint"
            required
            type="url"
            pattern="https://.*"
            value={endpoint}
            readOnly={kind === "NOTION_CREATE_PAGE"}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label htmlFor="bot-action-auth">
          {t("bot.actionForm.auth")}
          <select
            id="bot-action-auth"
            value={auth}
            disabled={kind === "NOTION_CREATE_PAGE"}
            onChange={(event) => setAuth(event.target.value)}
          >
            <option value="NONE">{t("bot.actionForm.none")}</option>
            <option value="BEARER">{t("bot.actionForm.bearer")}</option>
          </select>
        </label>
        {kind === "NOTION_CREATE_PAGE" ? <label htmlFor="bot-action-integration">
          {t("plugins.form.connectedAccount")}
          <select id="bot-action-integration" value={integrationReference} onChange={(event) => setIntegrationReference(event.target.value)}>
            <option value="">{t("plugins.form.chooseConnectedAccount")}</option>
            {connectedIntegrations.map((integration) => <option key={String(integration.id)} value={String(integration.binding_reference)}>{String(integration.display_name)}</option>)}
          </select>
          <small>{connectedIntegrations.length ? t("plugins.form.connectedAccountHelp") : t("plugins.form.connectAccountHelp")}</small>
          <a className="text-link" href="/app?view=connections" target="_blank" rel="noopener noreferrer">{t("plugins.form.manageConnections")}<span className="sr-only"> {t("plugins.form.opensInNewTab")}</span></a>
        </label> : null}
        {auth === "BEARER" && !integrationReference ? <label htmlFor="bot-action-credential">
          {t("plugins.form.credential")}
          <input
            id="bot-action-credential"
            type="password"
            autoComplete="new-password"
            required={auth === "BEARER" && !existingSecretReference}
            disabled={auth !== "BEARER"}
            minLength={16}
            maxLength={4096}
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
          <small>{t(existingSecretReference ? "plugins.form.credentialRotateHelp" : "plugins.form.credentialHelp")}</small>
        </label> : null}
        <label htmlFor="bot-action-state">
          {t("bot.actionForm.availability")}
          <select
            id="bot-action-state"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="PAUSED">{t("automation.status.paused")}</option>
            <option value="ACTIVE">{t("automation.status.active")}</option>
          </select>
        </label>
        <label htmlFor="bot-action-timeout">
          {t("bot.actionForm.timeout")}
          <input id="bot-action-timeout" required type="number" min={1000} max={10000} step={1000} value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} />
        </label>
        <label htmlFor="bot-action-response-limit">
          {t("bot.actionForm.responseLimit")}
          <input id="bot-action-response-limit" required type="number" min={1024} max={1048576} step={1024} value={maxResponseBytes} onChange={(event) => setMaxResponseBytes(Number(event.target.value))} />
        </label>
        <fieldset className="bot-form-wide">
          <legend>
          {t("bot.actionForm.headers")}
          </legend>
          <FieldRows rows={headerRows} setRows={setHeaderRows} addLabel={t("plugins.form.addHeader")} keyLabel={t("plugins.form.headerName")} valueLabel={t("plugins.form.headerValue")} removeLabel={t("plugins.form.removeField")}/>
        </fieldset>
        <fieldset className="bot-form-wide">
          <legend>
          {t("bot.actionForm.mapping")}
          </legend>
          <FieldRows rows={mappingRows} setRows={setMappingRows} addLabel={t("plugins.form.addMapping")} keyLabel={t("plugins.form.variableName")} valueLabel={t("plugins.form.jsonPointer")} removeLabel={t("plugins.form.removeField")}/>
          <small>
            {t("bot.actionForm.mappingHelp", { example: isolate(`{"action.status":"/status"}`) })}
          </small>
        </fieldset>
      </div>
      {row.id ? <section className="connection-detail-section" aria-labelledby="plugin-qualification-title">
        <div className="connection-detail-section-head">
          <div>
            <h3 id="plugin-qualification-title">{t("plugins.qualification.title")}</h3>
            <p>{t(qualificationSupported ? "plugins.qualification.help" : "plugins.qualification.unavailable")}</p>
          </div>
          <button type="button" className="button secondary small" disabled={!qualificationSupported || dirty || qualifying} onClick={() => void qualify()}>
            {t(qualifying ? "plugins.qualification.running" : qualificationPending ? "plugins.qualification.checkStatus" : "plugins.qualification.run")}
          </button>
        </div>
        <FieldRows rows={qualificationInputs} setRows={setQualificationInputs} addLabel={t("plugins.qualification.addInput")} keyLabel={t("plugins.qualification.inputName")} valueLabel={t("plugins.qualification.inputValue")} removeLabel={t("plugins.form.removeField")}/>
        {dirty ? <p className="inline-warning">{t("plugins.qualification.saveFirst")}</p> : null}
        {qualificationError?<div className="settings-feedback error bot-feedback" role="alert"><span aria-hidden="true">!</span><p>{qualificationError.message}</p>{qualificationError.code==="REAUTHENTICATION_REQUIRED"?<a className="button small secondary" href="/auth/login?step_up=privileged&return_to=%2Fapp%3Fview%3Dplugins" target="_blank" rel="noopener noreferrer">{t("plugins.form.reauthenticate")}<span className="sr-only"> {t("plugins.form.opensInNewTab")}</span></a>:null}</div>:null}
        {!dirty&&!qualificationError&&qualification ? <div className={`settings-feedback bot-feedback ${qualificationStatusUnavailable ? "error" : qualificationTone(qualification)}`} role={qualificationStatusUnavailable || (qualification.state !== "QUEUED" && qualification.state !== "RUNNING" && qualification.outcome !== "SUCCESS") ? "alert" : "status"} aria-live="polite">
          <span aria-hidden="true">{qualification.outcome === "SUCCESS" ? "✓" : qualification.state === "QUEUED" || qualification.state === "RUNNING" ? "…" : "!"}</span>
          <p>{t(qualificationStatusUnavailable ? "plugins.qualification.statusUnavailable" : qualificationMessage(qualification))}</p>
        </div> : null}
      </section> : null}
      {row.id ? <section className="connection-detail-section" aria-labelledby="plugin-history-title">
        <div className="connection-detail-section-head"><div><h3 id="plugin-history-title">{t("plugins.history.title")}</h3><p>{t("plugins.history.help")}</p></div></div>
        {historyError?<p className="bot-inline-error" role="alert">{t("plugins.history.unavailable")}</p>:null}
        {revisions.length?<ol className="plugin-revision-list">{revisions.map(revision=><li key={String(revision.id)}><span><b>{t("bot.actions.revision",{revision:Number(revision.revision)})}</b><small>{String(revision.name)}</small></span><State value={revision.state}/>{revision.active===true?<span className="tag">{t("plugins.history.current")}</span>:<button type="button" className="button secondary small" disabled={dirty||saving||restoreRevision!==null} onClick={()=>setRestoreRevision(Number(revision.revision))}>{t("plugins.history.restore")}</button>}</li>)}</ol>:!historyError?<p className="muted">{t("plugins.history.loading")}</p>:null}
        {restoreRevision!==null?<InlineConfirmation busy={saving} className="inline-warning" aria-labelledby="plugin-restore-title" cancel={()=>setRestoreRevision(null)}><strong id="plugin-restore-title">{t("plugins.history.confirmTitle",{revision:restoreRevision})}</strong><p>{t("plugins.history.confirmBody")}</p><div className="bot-form-actions"><button type="button" className="button secondary" data-inline-confirm-initial-focus disabled={saving} onClick={()=>setRestoreRevision(null)}>{t("automation.common.cancel")}</button><button type="button" className="button" disabled={saving} onClick={()=>void restore(originalKey,restoreRevision,Number(row.revision))}>{t("plugins.history.confirm")}</button></div></InlineConfirmation>:null}
      </section>:null}
      <div className="bot-form-actions modal-actions">
        <button type="button" className="button secondary" data-modal-cancel onClick={requestClose}>
          {t("automation.common.cancel")}
        </button>
        <button className="button primary" disabled={saving || qualifying}>
          {t(saving ? "bot.command.saving" : "bot.actionForm.save")}
        </button>
      </div>
      </>}
    </form>
    </ModalDialog>
  );
}

function FlowEditor({
  value,
  setValue,
  presentation,
  setPresentation,
  executionOverlays,
  executionRows,
  executionId,
  setExecutionId,
  executionLoading,
  executionError,
  actions,
  mediaAssets,
  uploadMediaAsset,
  supportTeams,
  supportOwners,
  cancel,
  save,
  saving,
  storageKey,
  initialSnapshot,
}: {
  value: BotFlowDefinition;
  setValue: (value: SetStateAction<BotFlowDefinition>) => void;
  presentation: WorkflowPresentation;
  setPresentation: (value: SetStateAction<WorkflowPresentation>) => void;
  executionOverlays: ReturnType<typeof workflowExecutionOverlays>;
  executionRows: Row[];
  executionId: string;
  setExecutionId: (id: string) => void;
  executionLoading: boolean;
  executionError: boolean;
  actions: Row[];
  mediaAssets:BotMediaAsset[];
  uploadMediaAsset:(file:File,replacedAssetId?:string)=>Promise<BotMediaAsset|null>;
  supportTeams: SupportTeam[];
  supportOwners: SupportOwner[];
  cancel: () => void;
  save: () => void;
  saving: boolean;
  storageKey: string;
  initialSnapshot: string;
}) {
  const { locale, t } = useI18n();
  const [newType, setNewType] = useState<BotFlowNode["type"]>("send_text");
  const [direction, setDirection] = useState<"auto" | "ltr" | "rtl">("auto");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const serializedValue = serializeWorkflowDraftRecovery(value, presentation);
  let parsed: BotFlowDefinition | null = null;
  let error = "";
  let entryError = false;
  try {
    parsed = parseBotFlow(value);
  } catch (problem) {
    entryError = problem instanceof Error && /entry command/iu.test(problem.message);
    const pause = value.keepOpenPolicy?.humanReplyPauseMinutes;
    const resend = value.welcomeResendMinutes;
    const invalidReturn = value.nodes.some(node => node.type === "handoff" && node.mainMenuReturn &&
      (!value.keepOpenPolicy?.mainMenu || !node.mainMenuReturn.label || node.mainMenuReturn.label !== node.mainMenuReturn.label.trim() || [...node.mainMenuReturn.label].length > 20));
    error = pause !== undefined && pause !== null && (!Number.isInteger(pause) || pause < 1 || pause > MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES)
      ? t("bot.keepOpen.minutesError", { max: formatNumber(MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES, locale) })
      : resend != null && (!Number.isInteger(resend) || resend < 1 || resend > 1440)
        ? t("bot.welcome.minutesError")
        : resend != null && value.nodes.find(node => node.id === value.start)?.type !== "choice"
          ? t("bot.welcome.choiceRequired")
          : invalidReturn ? t("bot.mainMenu.labelError")
          : entryError ? t("bot.entry.invalid")
          : value.mainMenuNodeId != null && value.nodes.find(node => node.id === value.mainMenuNodeId)?.type !== "choice" ? t("bot.mainMenu.destinationError")
          : operatorFailureMessage(problem, t("bot.errors.flowInvalid"));
  }
  // Functional update: an async media upload must not overwrite edits made while it was in flight.
  const replace = (node: BotFlowNode) =>
    setValue((current) => ({
      ...current,
      nodes: current.nodes.map((item) => (item.id === node.id ? node : item)),
    }));
  const move = (index: number, offset: number) => {
    const nodes = [...value.nodes];
    const target = index + offset;
    if (target < 0 || target >= nodes.length) return;
    [nodes[index], nodes[target]] = [nodes[target]!, nodes[index]!];
    setValue({ ...value, nodes });
  };
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // Blocked site storage only disables local draft recovery; it must not break editing.
      try { window.localStorage.setItem(storageKey, serializedValue); setSavedSnapshot(serializedValue); } catch { /* recovery unavailable */ }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [serializedValue, storageKey]);
  const add = (type = newType) => {
    const id = nextNodeId(value.nodes);
    const fallback = value.nodes.at(-1)?.id ?? id;
    setValue({
      ...value,
      nodes: [...value.nodes, nodeForType(type, id, fallback, actions,mediaAssets, t)],
    });
  };
  const focusNode = useCallback((nodeId: string) => {
    const target = document.getElementById(`bot-node-${nodeId}`);
    target?.scrollIntoView({ behavior: "auto", block: "center" });
    target?.querySelector<HTMLElement>("select, input, textarea, button")?.focus({ preventScroll: true });
  }, []);
  const canvasNodeTitle = useCallback((type: BotFlowNode["type"]) => nodeTitle(type, t), [t]);
  const canvasStepLabel = useCallback((nodeId: string) => workflowStepLabel(nodeId, { nodes: value.nodes }, "start", locale, t), [value.nodes, locale, t]);
  const canvasNodeDescription = useCallback((node: BotFlowNode) => nodeDescription(node, locale, t, supportTeams, value.nodes), [locale, t, supportTeams, value.nodes]);
  const setCanvasNodePosition = useCallback((nodeId: string, position: { x: number; y: number }) => {
    setPresentation((current) => {
      const previous = current.nodePositions[nodeId];
      return previous?.x === position.x && previous.y === position.y
        ? current
        : { nodePositions: { ...current.nodePositions, [nodeId]: position } };
    });
  }, [setPresentation]);
  return (
    <form
      className="panel bot-flow-editor"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="panel-heading">
        <div>
          <h2 id="bot-flow-editor-title" tabIndex={-1}>{t("bot.editor.title")}</h2>
          <p>{t("bot.editor.help")}</p>
        </div>
        <div className="workflow-draft-state"><State value={parsed ? "VALID" : "NEEDS_ATTENTION"} /><small aria-hidden="true">{t(savedSnapshot === serializedValue ? "bot.editor.localSaved" : "bot.editor.localSaving")}</small><span className="sr-only" role="status" aria-live="polite">{savedSnapshot === serializedValue ? t("bot.editor.draftSaved") : ""}</span></div>
      </div>
      <div
        className="bot-editor-layout"
        dir={direction === "auto" ? undefined : direction}
      >
        <fieldset className="bot-flow-settings">
          <legend>{t("bot.editor.settings")}</legend>
          <div className="bot-form-grid">
            <label htmlFor="bot-flow-name">
              {t("bot.editor.name")}
              <input
                id="bot-flow-name"
                name="flow_name"
                required
                maxLength={160}
                dir="auto"
                value={value.name}
                onChange={(event) =>
                  setValue({ ...value, name: event.target.value })
                }
              />
            </label>
            <label htmlFor="bot-flow-start">
              {t("bot.editor.firstStep")}
              <select
                id="bot-flow-start"
                name="flow_start"
                required
                value={value.start}
                onChange={(event) =>
                  setValue({ ...value, start: event.target.value })
                }
              >
                {value.nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {workflowStepLabel(node.id, value, "start", locale, t)}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="bot-flow-max-steps">
              {t("bot.editor.maxSteps")}
              <input
                id="bot-flow-max-steps"
                name="max_steps"
                required
                type="number"
                min={1}
                max={100}
                inputMode="numeric"
                value={value.maxSteps}
                onChange={(event) =>
                  setValue({ ...value, maxSteps: Number(event.target.value) })
                }
              />
              <small>
                {t("bot.editor.maxStepsHelp")}
              </small>
            </label>
            <label htmlFor="bot-flow-direction">
              {t("bot.editor.direction")}
              <select
                id="bot-flow-direction"
                name="editing_direction"
                value={direction}
                onChange={(event) =>
                  setDirection(event.target.value as "auto" | "ltr" | "rtl")
                }
              >
                <option value="auto">{t("bot.editor.directionAuto")}</option>
                <option value="ltr">{t("bot.editor.directionLtr")}</option>
                <option value="rtl">{t("bot.editor.directionRtl")}</option>
              </select>
              <small>
                {t("bot.editor.directionHelp")}
              </small>
            </label>
          </div>
        </fieldset>
        <fieldset className="bot-flow-settings" disabled={saving}>
          <legend>{t("bot.keepOpen.title")}</legend>
          <div className="bot-form-grid">
            <label className="bot-form-wide" htmlFor="bot-keep-open-mode">
              {t("bot.keepOpen.mode")}
              <select id="bot-keep-open-mode" name="keep_open_mode" aria-describedby="bot-keep-open-help" value={value.keepOpenPolicy ? "enabled" : "existing"} onChange={event => {
                const next = { ...value };
                if (event.target.value === "enabled") next.keepOpenPolicy = defaultBotKeepOpenPolicy();
                else delete next.keepOpenPolicy;
                setValue(next);
              }}>
                <option value="existing">{t("bot.keepOpen.existing")}</option>
                <option value="enabled">{t("bot.keepOpen.enabled")}</option>
              </select>
              <small id="bot-keep-open-help">{t(value.keepOpenPolicy ? "bot.keepOpen.help" : "bot.keepOpen.existingHelp")}</small>
            </label>
            {value.keepOpenPolicy ? <>
              <label htmlFor="bot-keep-open-return">
                {t("bot.keepOpen.return")}
                <select id="bot-keep-open-return" name="bot_return" aria-describedby="bot-keep-open-return-help" value={value.keepOpenPolicy.humanReplyPauseMinutes === null ? "off" : "on"} onChange={event => setValue({ ...value, keepOpenPolicy: { ...value.keepOpenPolicy!, humanReplyPauseMinutes: event.target.value === "off" ? null : defaultBotKeepOpenPolicy().humanReplyPauseMinutes } })}>
                  <option value="on">{t("bot.keepOpen.returnOn")}</option>
                  <option value="off">{t("bot.keepOpen.returnOff")}</option>
                </select>
                <small id="bot-keep-open-return-help">{t(value.keepOpenPolicy.humanReplyPauseMinutes === null ? "bot.keepOpen.returnOffHelp" : "bot.keepOpen.returnHelp")}</small>
              </label>
              {value.keepOpenPolicy.humanReplyPauseMinutes !== null ? <label htmlFor="bot-keep-open-minutes">
                {t("bot.keepOpen.minutes")}
                <input id="bot-keep-open-minutes" name="human_reply_pause_minutes" type="number" inputMode="numeric" min={1} max={MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES} step={1} required aria-describedby="bot-keep-open-minutes-help" value={value.keepOpenPolicy.humanReplyPauseMinutes || ""} onChange={event => setValue({ ...value, keepOpenPolicy: { ...value.keepOpenPolicy!, humanReplyPauseMinutes: Number(event.target.value) } })}/>
                <small id="bot-keep-open-minutes-help">{t("bot.keepOpen.minutesHelp", { max: formatNumber(MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES, locale) })}</small>
              </label> : null}
              <label htmlFor="bot-keep-open-menu">
                {t("bot.keepOpen.mainMenu")}
                <select id="bot-keep-open-menu" name="customer_main_menu" aria-describedby="bot-keep-open-menu-help" value={String(value.keepOpenPolicy.mainMenu)} onChange={event => setValue({ ...value, keepOpenPolicy: { ...value.keepOpenPolicy!, mainMenu: event.target.value === "true" } })}>
                  <option value="true">{t("bot.keepOpen.available")}</option>
                  <option value="false">{t("bot.keepOpen.unavailable")}</option>
                </select>
                <small id="bot-keep-open-menu-help">{t("bot.keepOpen.mainMenuHelp")}</small>
              </label>
              <label htmlFor="bot-keep-open-resolution">
                {t("bot.keepOpen.customerResolution")}
                <select id="bot-keep-open-resolution" name="customer_resolution" aria-describedby="bot-keep-open-resolution-help" value={String(value.keepOpenPolicy.customerResolution)} onChange={event => setValue({ ...value, keepOpenPolicy: { ...value.keepOpenPolicy!, customerResolution: event.target.value === "true" } })}>
                  <option value="true">{t("bot.keepOpen.available")}</option>
                  <option value="false">{t("bot.keepOpen.unavailable")}</option>
                </select>
                <small id="bot-keep-open-resolution-help">{t("bot.keepOpen.customerResolutionHelp")}</small>
              </label>
            </> : null}
          </div>
        </fieldset>
        <BotFlowEntrySettings value={value} setValue={setValue} saving={saving} entryError={entryError} />
        {executionRows.length ? <fieldset className="bot-flow-settings">
          <legend>{t("bot.executionOverlay.title")}</legend>
          <div className="bot-form-grid">
            <label className="bot-form-wide" htmlFor="bot-execution-overlay">
              {t("bot.executionOverlay.execution")}
              <select id="bot-execution-overlay" value={executionId} onChange={(event) => setExecutionId(event.target.value)}>
                {executionRows.map((row) => <option key={String(row.id)} value={String(row.id)}>
                  {t("bot.executionOverlay.option", { ticket: isolate(`#${String(row.zammad_ticket_number ?? t("bot.conversations.pending"))}`), time: formatTime(row.last_activity_at, locale, t) })}
                </option>)}
              </select>
              <small>{t(executionLoading ? "bot.executionOverlay.loading" : executionError ? "bot.executionOverlay.failed" : "bot.executionOverlay.help")}</small>
            </label>
          </div>
        </fieldset> : null}
        <Suspense fallback={<section className="workflow-canvas bot-loading" role="status" aria-live="polite" aria-busy="true" aria-label={t("bot.canvas.loading")}><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></section>}>
          <WorkflowCanvas
            definition={value}
            palette={NODE_TYPES.map((type) => ({ type, label: nodeTitle(type, t) }))}
            addNode={add}
            describeNode={canvasNodeDescription}
            nodeTitle={canvasNodeTitle}
            stepLabel={canvasStepLabel}
            setDefinition={setValue}
            focusNode={focusNode}
            positions={presentation.nodePositions}
            setNodePosition={setCanvasNodePosition}
            executionOverlays={executionOverlays}
          />
        </Suspense>
        <section className="bot-node-editor" aria-labelledby="bot-steps-title">
          <div className="bot-section-head">
            <div>
              <h3 id="bot-steps-title">{t("bot.editor.steps")}</h3>
              <p>{t("bot.editor.stepsHelp")}</p>
            </div>
          </div>
          <ol>
            {value.nodes.map((node, index) => (
              <li key={node.id}>
                <BotNodeEditor
                  node={node}
                  nodes={value.nodes}
                  actions={actions}
                  mediaAssets={mediaAssets}
                  uploadMediaAsset={uploadMediaAsset}
                  supportTeams={supportTeams}
                  supportOwners={supportOwners}
                  isStart={node.id === value.start}
                  isEntry={Boolean(value.entryCommands?.some(entry => entry.target === node.id))}
                  mainMenuEnabled={value.keepOpenPolicy?.mainMenu === true}
                  replace={replace}
                  remove={() =>
                    setValue({
                      ...value,
                      nodes: value.nodes.filter((item) => item.id !== node.id),
                    })
                  }
                  canRemove={canRemoveWorkflowNode(value, node.id)}
                  moveUp={() => move(index, -1)}
                  moveDown={() => move(index, 1)}
                  first={index === 0}
                  last={index === value.nodes.length - 1}
                />
              </li>
            ))}
          </ol>
          <div className="bot-add-step">
            <label htmlFor="bot-new-step-type">
              {t("bot.editor.newStepType")}
              <select
                id="bot-new-step-type"
                value={newType}
                onChange={(event) =>
                  setNewType(event.target.value as BotFlowNode["type"])
                }
              >
                {NODE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {nodeTitle(type, t)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button secondary" onClick={() => add()}>
              {t("bot.editor.addStep")}
            </button>
          </div>
        </section>
        {error ? (
          <div
            id="bot-flow-error"
            className="settings-feedback error bot-flow-error"
            role="alert"
          >
            <span>!</span>
            <p>
              <b>{t("bot.editor.attention")}</b> {error}
            </p>
          </div>
        ) : (
          <div
            className="settings-feedback success bot-flow-error"
            role="status"
          >
            <span>✓</span>
            <p>{t("bot.editor.ready")}</p>
          </div>
        )}
      </div>
      <div className="bot-form-actions">
        <button type="button" className="button secondary" onClick={() => serializedValue === initialSnapshot ? cancel() : setConfirmDiscard(true)}>
          {t("bot.editor.close")}
        </button>
        <button className="button primary" disabled={saving}>
          {t(saving ? "bot.command.saving" : "bot.editor.save")}
        </button>
      </div>
      {confirmDiscard ? (
        <ModalDialog
          close={() => setConfirmDiscard(false)}
          className="modal-backdrop"
          aria-labelledby="bot-discard-draft-title"
        >
          <div className="modal bot-confirm">
            <div>
              <h2 id="bot-discard-draft-title">{t("bot.editor.discardTitle")}</h2>
              <p>{t("bot.editor.discardHelp")}</p>
            </div>
            <span>
              <button data-modal-initial-focus className="button secondary" type="button" onClick={() => setConfirmDiscard(false)}>{t("bot.editor.keepEditing")}</button>
              <button className="button primary" type="button" onClick={cancel}>{t("bot.editor.discard")}</button>
            </span>
          </div>
        </ModalDialog>
      ) : null}
    </form>
  );
}

const META_CAPABILITIES = directMessageCapabilities("meta");
const NODE_TYPES = ([
  "send_text",
  "send_media",
  "choice",
  "request_location",
  "send_location",
  "send_template",
  "whatsapp_flow",
  "action",
  "handoff",
  "end",
] satisfies BotFlowNode["type"][]).filter((type) =>
  (type !== "send_template" || META_CAPABILITIES.templates) &&
  (type !== "whatsapp_flow" || META_CAPABILITIES.metaFlows),
);

function BotFlowEntrySettings({ value, setValue, saving, entryError }: {
  value: BotFlowDefinition;
  setValue: (value: SetStateAction<BotFlowDefinition>) => void;
  saving: boolean;
  entryError: boolean;
}) {
  const { locale, t } = useI18n();
  const entries = value.entryCommands ?? [];
  const resend = value.welcomeResendMinutes;
  const choiceStart = value.nodes.find(node => node.id === value.start)?.type === "choice";
  const invalidMinutes = resend != null && (!Number.isInteger(resend) || resend < 1 || resend > 1440);
  const updateEntry = (id: string, update: Partial<NonNullable<BotFlowDefinition["entryCommands"]>[number]>) => setValue(current => ({
    ...current, entryCommands: current.entryCommands?.map(entry => entry.id === id ? { ...entry, ...update } : entry),
  }));
  return <>
    <fieldset className="bot-flow-settings" disabled={saving}>
      <legend>{t("bot.welcome.title")}</legend>
      <div className="bot-form-grid">
        <label htmlFor="bot-welcome-mode">{t("bot.welcome.mode")}
          <select id="bot-welcome-mode" name="welcome_resend" value={resend == null ? "off" : "on"} aria-describedby="bot-welcome-help" onChange={event => setValue({ ...value, welcomeResendMinutes: event.target.value === "on" ? 60 : null })}>
            <option value="off">{t("bot.welcome.off")}</option>
            <option value="on" disabled={!choiceStart}>{t("bot.welcome.on")}</option>
          </select>
          <small id="bot-welcome-help">{t(choiceStart ? "bot.welcome.help" : "bot.welcome.choiceRequired")}</small>
        </label>
        {resend != null ? <label htmlFor="bot-welcome-minutes">{t("bot.welcome.minutes")}
          <input id="bot-welcome-minutes" name="welcome_resend_minutes" type="number" inputMode="numeric" min={1} max={1440} step={1} required value={resend || ""}
            aria-invalid={invalidMinutes || !choiceStart} aria-describedby="bot-welcome-minutes-help" onChange={event => setValue({ ...value, welcomeResendMinutes: Number(event.target.value) })} />
          <small id="bot-welcome-minutes-help">{t("bot.welcome.minutesError")}</small>
        </label> : null}
        <label className="bot-form-wide" htmlFor="bot-main-menu-node">{t("bot.mainMenu.destination")}
          <select id="bot-main-menu-node" name="main_menu_node" value={value.mainMenuNodeId ?? ""} aria-describedby="bot-main-menu-node-help" onChange={event => setValue({ ...value, mainMenuNodeId: event.target.value || null })}>
            <option value="">{t("bot.mainMenu.start")}</option>
            {value.mainMenuNodeId != null && !value.nodes.some(node => node.id === value.mainMenuNodeId && node.type === "choice") ? <option value={value.mainMenuNodeId} disabled>{t("bot.mainMenu.destinationError")}</option> : null}
            {value.nodes.filter(node => node.type === "choice").map(node => <option key={node.id} value={node.id}>{workflowStepLabel(node.id, value, "start", locale, t)}</option>)}
          </select>
          <small id="bot-main-menu-node-help">{t("bot.mainMenu.destinationHelp")}</small>
        </label>
      </div>
    </fieldset>
    <fieldset className="bot-flow-settings" disabled={saving}>
      <legend>{t("bot.entry.title")}</legend>
      <p id="bot-entry-help">{t("bot.entry.help")}</p>
      {entries.map((entry, index) => <fieldset key={entry.id} className="bot-choice-editor" aria-describedby="bot-entry-help">
        <legend>{t("bot.entry.row", { number: formatNumber(index + 1, locale) })}</legend>
        <div className="bot-form-grid">
          <label className="bot-form-wide" htmlFor={`bot-entry-${entry.id}-aliases`}>{t("bot.entry.aliases")}
            <textarea id={`bot-entry-${entry.id}-aliases`} name={`${entry.id}_aliases`} dir="auto" required rows={2} value={entry.aliases.join("\n")} aria-invalid={entryError} aria-describedby={entryError ? "bot-entry-help bot-flow-error" : "bot-entry-help"} onChange={event => updateEntry(entry.id, { aliases: event.target.value.split("\n") })} />
          </label>
          <label htmlFor={`bot-entry-${entry.id}-target`}>{t("bot.entry.target")}
            <select id={`bot-entry-${entry.id}-target`} name={`${entry.id}_target`} required value={entry.target} onChange={event => updateEntry(entry.id, { target: event.target.value })}>
              {value.nodes.map(node => <option key={node.id} value={node.id}>{workflowStepLabel(node.id, value, "start", locale, t)}</option>)}
            </select>
          </label>
          <label htmlFor={`bot-entry-${entry.id}-enabled`}>{t("bot.entry.status")}
            <select id={`bot-entry-${entry.id}-enabled`} name={`${entry.id}_enabled`} value={String(entry.enabled)} onChange={event => updateEntry(entry.id, { enabled: event.target.value === "true" })}>
              <option value="false">{t("bot.entry.disabled")}</option><option value="true">{t("bot.entry.enabled")}</option>
            </select>
          </label>
        </div>
        <button type="button" className="button secondary small" aria-label={t("bot.entry.removeRow", { number: formatNumber(index + 1, locale) })} onClick={() => setValue(current => ({ ...current, entryCommands: current.entryCommands?.filter(item => item.id !== entry.id) }))}>{t("bot.entry.remove")}</button>
      </fieldset>)}
      <button type="button" className="button secondary small" onClick={() => setValue(current => {
        const existing = current.entryCommands ?? [];
        let ordinal = 1;
        while (existing.some(entry => entry.id === `entry_${ordinal}`)) ordinal++;
        return { ...current, entryCommands: [...existing, { id: `entry_${ordinal}`, aliases: [""], target: current.start, enabled: false }] };
      })}>{t("bot.entry.add")}</button>
    </fieldset>
  </>;
}

function BotNodeEditor({
  node,
  nodes,
  actions,
  mediaAssets,
  uploadMediaAsset,
  supportTeams,
  supportOwners,
  isStart,
  isEntry,
  mainMenuEnabled,
  replace,
  remove,
  canRemove,
  moveUp,
  moveDown,
  first,
  last,
}: {
  node: BotFlowNode;
  nodes: BotFlowNode[];
  actions: Row[];
  mediaAssets:BotMediaAsset[];
  uploadMediaAsset:(file:File,replacedAssetId?:string)=>Promise<BotMediaAsset|null>;
  supportTeams: SupportTeam[];
  supportOwners: SupportOwner[];
  isStart: boolean;
  isEntry: boolean;
  mainMenuEnabled: boolean;
  replace: (node: BotFlowNode) => void;
  remove: () => void;
  canRemove: boolean;
  moveUp: () => void;
  moveDown: () => void;
  first: boolean;
  last: boolean;
}) {
  const { locale, t } = useI18n();
  const [uploading,setUploading]=useState(false);const [uploadError,setUploadError]=useState("");
  const id = `bot-node-${node.id}`;
  const fallback = nodes.find((item) => item.id !== node.id)?.id ?? node.id;
  const changeType = (type: BotFlowNode["type"]) =>
    replace(nodeForType(type, node.id, fallback, actions,mediaAssets, t));
  return (
    <fieldset id={id} className="bot-node-card" disabled={uploading} aria-busy={uploading}>
      <legend>
        <span>{workflowStepLabel(node.id, { nodes }, "start", locale, t)}</span>
        {isStart ? <span className="tag">{t("bot.node.first")}</span> : null}
        {isEntry ? <span className="tag">{t("bot.entry.point")}</span> : null}
      </legend>
      <div className="bot-node-toolbar">
        <label htmlFor={`${id}-type`}>
          {t("bot.node.type")}
          <select
            id={`${id}-type`}
            value={node.type}
            onChange={(event) =>
              changeType(event.target.value as BotFlowNode["type"])
            }
          >
            {!NODE_TYPES.includes(node.type) ? (
              <option value={node.type} disabled>{nodeTitle(node.type, t)}</option>
            ) : null}
            {NODE_TYPES.map((type) => (
              <option key={type} value={type}>
                {nodeTitle(type, t)}
              </option>
            ))}
          </select>
        </label>
        <span>
          <button
            type="button"
            className="button secondary small"
            disabled={first}
            onClick={moveUp}
          >
            {t("bot.node.moveUp")}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={last}
            onClick={moveDown}
          >
            {t("bot.node.moveDown")}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={!canRemove}
            title={
              canRemove
                ? t("bot.node.removeTitle")
                : t("bot.node.removeBlocked")
            }
            onClick={remove}
          >
            {t("bot.node.remove")}
          </button>
        </span>
      </div>
      <div className="bot-node-fields">
        {node.type === "send_text" ? (
          <>
            <label htmlFor={`${id}-text`}>
              {t("bot.node.message")}
              <textarea
                id={`${id}-text`}
                required
                maxLength={4096}
                dir="auto"
                value={node.text}
                onChange={(event) =>
                  replace({ ...node, text: event.target.value })
                }
              />
            </label>
            <NextNodeSelect
              id={`${id}-next`}
              value={node.next}
              nodes={nodes}
              onChange={(next) => replace({ ...node, next })}
            />
          </>
        ) : null}
        {node.type==="send_media"?(
          <>
            <label htmlFor={`${id}-asset`}>
              {t("bot.media.file")}
              <select id={`${id}-asset`} required value={node.assetId} onChange={(event)=>replace({...node,assetId:event.target.value})}>
                <option value="">{t("bot.media.choose")}</option>
                {mediaAssets.map(asset=><option key={asset.id} value={asset.id}>{asset.filename}</option>)}
              </select>
            </label>
            <label htmlFor={`${id}-upload`}>
              {t("bot.media.upload")}
              <input id={`${id}-upload`} type="file" disabled={uploading} accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,application/zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,audio/ogg,audio/mpeg,audio/mp4,audio/webm,video/mp4" aria-describedby={`${id}-upload-help`} onChange={async(event)=>{const file=event.target.files?.[0];if(!file)return;setUploading(true);setUploadError("");try{const asset=await uploadMediaAsset(file,node.assetId||undefined);if(asset)replace({...node,assetId:asset.id})}catch(problem){setUploadError(operatorFailureMessage(problem, t("bot.media.uploadFailed")))}finally{setUploading(false);event.target.value=""}}}/>
              <small id={`${id}-upload-help`}>{t(uploading?"bot.media.uploading":"bot.media.uploadHelp")}</small>
              {uploadError?<small role="alert">{uploadError}</small>:null}
            </label>
            <label className="bot-form-wide" htmlFor={`${id}-caption`}>
              {t("bot.media.caption")}
              <textarea id={`${id}-caption`} maxLength={1024} dir="auto" value={node.caption??""} onChange={(event)=>replace({...node,caption:event.target.value||undefined})}/>
              <small>{t("bot.media.captionHelp")}</small>
            </label>
            <NextNodeSelect id={`${id}-next`} value={node.next} nodes={nodes} onChange={(next)=>replace({...node,next})}/>
          </>
        ):null}
        {node.type === "choice" ? (
          <>
            <label className="bot-form-wide" htmlFor={`${id}-prompt`}>
              {t("bot.node.question")}
              <textarea
                id={`${id}-prompt`}
                required
                maxLength={1024}
                dir="auto"
                value={node.prompt}
                onChange={(event) =>
                  replace({ ...node, prompt: event.target.value })
                }
              />
            </label>
            <label htmlFor={`${id}-button-label`}>
              {t("bot.node.listButtonLabel")}
              <input
                id={`${id}-button-label`}
                maxLength={20}
                dir="auto"
                aria-describedby={`${id}-button-label-help`}
                value={node.buttonLabel ?? ""}
                onChange={(event) => replace({ ...node, buttonLabel: event.target.value || undefined })}
              />
              <small id={`${id}-button-label-help`}>{t("bot.node.listButtonLabelHelp")}</small>
            </label>
            <fieldset className="bot-choice-editor">
              <legend>{t("bot.node.options")}</legend>
              {node.options.map((option, index) => (
                <div className="bot-choice-row" key={index}>
                  <label htmlFor={`${id}-choice-${index}-id`}>
                    {t("bot.node.optionId")}
                    <input
                      id={`${id}-choice-${index}-id`}
                      required
                      pattern={"[a-z][a-z0-9_\\-]{0,63}"}
                      dir="ltr"
                      value={option.id}
                      onChange={(event) =>
                        replace({
                          ...node,
                          options: node.options.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, id: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <label htmlFor={`${id}-choice-${index}-label`}>
                    {t("bot.node.optionLabel")}
                    <input
                      id={`${id}-choice-${index}-label`}
                      required
                      maxLength={80}
                      dir="auto"
                      value={option.label}
                      onChange={(event) =>
                        replace({
                          ...node,
                          options: node.options.map((item, itemIndex) =>
                            itemIndex === index
                              ? { ...item, label: event.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                  <NextNodeSelect
                    id={`${id}-choice-${index}-next`}
                    value={option.next}
                    nodes={nodes}
                    onChange={(next) =>
                      replace({
                        ...node,
                        options: node.options.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, next } : item,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={node.options.length === 1}
                    onClick={() =>
                      replace({
                        ...node,
                        options: node.options.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    {t("bot.node.removeOption")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button secondary small"
                disabled={node.options.length >= 10}
                onClick={() =>
                  replace({
                    ...node,
                    options: [
                      ...node.options,
                      {
                        id: nextChoiceId(node),
                        label: t("bot.node.newOption"),
                        next: fallback,
                      },
                    ],
                  })
                }
              >
                {t("bot.node.addOption")}
              </button>
            </fieldset>
          </>
        ) : null}
        {node.type === "request_location" ? (
          <>
            <label htmlFor={`${id}-prompt`}>
              {t("bot.node.requestMessage")}
              <textarea
                id={`${id}-prompt`}
                required
                maxLength={1024}
                dir="auto"
                value={node.prompt}
                onChange={(event) =>
                  replace({ ...node, prompt: event.target.value })
                }
              />
            </label>
            <NextNodeSelect
              id={`${id}-next`}
              value={node.next}
              nodes={nodes}
              onChange={(next) => replace({ ...node, next })}
            />
          </>
        ) : null}
        {node.type === "send_location" ? (
          <>
            <label htmlFor={`${id}-latitude`}>
              {t("bot.node.latitude")}
              <input
                id={`${id}-latitude`}
                required
                type="number"
                min={-90}
                max={90}
                step="any"
                inputMode="decimal"
                value={node.latitude}
                onChange={(event) =>
                  replace({ ...node, latitude: Number(event.target.value) })
                }
              />
            </label>
            <label htmlFor={`${id}-longitude`}>
              {t("bot.node.longitude")}
              <input
                id={`${id}-longitude`}
                required
                type="number"
                min={-180}
                max={180}
                step="any"
                inputMode="decimal"
                value={node.longitude}
                onChange={(event) =>
                  replace({ ...node, longitude: Number(event.target.value) })
                }
              />
            </label>
            <label htmlFor={`${id}-name`}>
              {t("bot.node.locationName")}
              <input
                id={`${id}-name`}
                maxLength={160}
                dir="auto"
                value={node.name ?? ""}
                onChange={(event) =>
                  replace({ ...node, name: event.target.value || undefined })
                }
              />
            </label>
            <label htmlFor={`${id}-address`}>
              {t("bot.node.address")}
              <input
                id={`${id}-address`}
                maxLength={500}
                dir="auto"
                value={node.address ?? ""}
                onChange={(event) =>
                  replace({ ...node, address: event.target.value || undefined })
                }
              />
            </label>
            <NextNodeSelect
              id={`${id}-next`}
              value={node.next}
              nodes={nodes}
              onChange={(next) => replace({ ...node, next })}
            />
          </>
        ) : null}
        {node.type === "send_template" ? (
          <>
            <label htmlFor={`${id}-template-name`}>
              {t("bot.node.templateName")}
              <input id={`${id}-template-name`} required pattern="[a-z0-9_]{1,512}" maxLength={512} dir="ltr" value={node.templateName} onChange={(event) => replace({ ...node, templateName: event.target.value })} />
            </label>
            <label htmlFor={`${id}-template-language`}>
              {t("bot.node.templateLanguage")}
              <input id={`${id}-template-language`} required pattern="[a-z]{2,3}(_[A-Z]{2})?" maxLength={16} dir="ltr" value={node.languageCode} onChange={(event) => replace({ ...node, languageCode: event.target.value })} />
            </label>
            <label className="bot-form-wide" htmlFor={`${id}-template-transcript`}>
              {t("bot.node.templateTranscript")}
              <textarea id={`${id}-template-transcript`} required maxLength={4096} dir="auto" value={node.transcriptText} onChange={(event) => replace({ ...node, transcriptText: event.target.value })} />
              <small>{t("bot.node.templateTranscriptHelp")}</small>
            </label>
            <fieldset className="bot-action-inputs">
              <legend>{t("bot.node.templateParameters")}</legend>
              {node.bodyParameters.map((parameter, index) => (
                <div key={index}>
                  <label htmlFor={`${id}-template-parameter-${index}`}>
                    {t("bot.node.templateParameter", { number: String(index + 1) })}
                    <input id={`${id}-template-parameter-${index}`} required maxLength={1024} dir="auto" value={parameter} onChange={(event) => replace({ ...node, bodyParameters: node.bodyParameters.map((value, itemIndex) => itemIndex === index ? event.target.value : value) })} />
                  </label>
                  <button type="button" className="button secondary small" onClick={() => replace({ ...node, bodyParameters: node.bodyParameters.filter((_, itemIndex) => itemIndex !== index) })}>{t("bot.node.removeValue")}</button>
                </div>
              ))}
              <button type="button" className="button secondary small" disabled={node.bodyParameters.length >= 20} onClick={() => replace({ ...node, bodyParameters: [...node.bodyParameters, t("bot.node.newParameter")] })}>{t("bot.node.addParameter")}</button>
              <small>{t("bot.node.templateParametersHelp")}</small>
            </fieldset>
            <NextNodeSelect id={`${id}-next`} value={node.next} nodes={nodes} onChange={(next) => replace({ ...node, next })} />
          </>
        ) : null}
        {node.type === "whatsapp_flow" ? (
          <>
            <label htmlFor={`${id}-flow-id`}>
              {t("bot.node.flowId")}
              <input id={`${id}-flow-id`} required pattern="[1-9][0-9]{0,31}" maxLength={32} inputMode="numeric" dir="ltr" value={node.flowId} onChange={(event) => replace({ ...node, flowId: event.target.value })} />
            </label>
            <label htmlFor={`${id}-flow-screen`}>
              {t("bot.node.flowScreen")}
              <input id={`${id}-flow-screen`} pattern="[A-Za-z][A-Za-z0-9_]{0,63}" maxLength={64} dir="ltr" value={node.screen ?? ""} onChange={(event) => replace({ ...node, screen: event.target.value || undefined })} />
            </label>
            <label className="bot-form-wide" htmlFor={`${id}-flow-prompt`}>
              {t("bot.node.flowPrompt")}
              <textarea id={`${id}-flow-prompt`} required maxLength={1024} dir="auto" value={node.prompt} onChange={(event) => replace({ ...node, prompt: event.target.value })} />
            </label>
            <label htmlFor={`${id}-flow-button`}>
              {t("bot.node.flowButton")}
              <input id={`${id}-flow-button`} required maxLength={30} dir="auto" value={node.buttonLabel} onChange={(event) => replace({ ...node, buttonLabel: event.target.value })} />
            </label>
            <NextNodeSelect id={`${id}-next`} value={node.next} nodes={nodes} onChange={(next) => replace({ ...node, next })} />
            <fieldset className="bot-action-inputs">
              <legend>{t("bot.node.flowData")}</legend>
              {Object.entries(node.data).map(([key, inputValue], index) => (
                <div key={index}>
                  <label htmlFor={`${id}-flow-data-${index}-key`}>
                    {t("bot.node.field")}
                    <input id={`${id}-flow-data-${index}-key`} required pattern="[a-z][a-z0-9_.\-]{0,127}" dir="ltr" value={key} onChange={(event) => replace({ ...node, data: renameActionInput(node.data, key, event.target.value) })} />
                  </label>
                  <label htmlFor={`${id}-flow-data-${index}-value`}>
                    {t("bot.node.template")}
                    <input id={`${id}-flow-data-${index}-value`} required maxLength={2000} dir="auto" value={inputValue} onChange={(event) => replace({ ...node, data: { ...node.data, [key]: event.target.value } })} />
                  </label>
                  <button type="button" className="button secondary small" onClick={() => replace({ ...node, data: Object.fromEntries(Object.entries(node.data).filter(([inputKey]) => inputKey !== key)) })}>{t("bot.node.removeValue")}</button>
                </div>
              ))}
              <button type="button" className="button secondary small" disabled={Object.keys(node.data).length >= 25} onClick={() => { const key = nextActionInputKey(node.data); replace({ ...node, data: { ...node.data, [key]: "{{message.text}}" } }); }}>{t("bot.node.addFlowData")}</button>
              <small>{t("bot.node.flowDataHelp")}</small>
            </fieldset>
          </>
        ) : null}
        {node.type === "action" ? (
          <>
            <label htmlFor={`${id}-action`}>
              {t("bot.node.action")}
              <select
                id={`${id}-action`}
                required
                value={node.actionId}
                onChange={(event) =>
                  replace({ ...node, actionId: event.target.value })
                }
              >
                {!actions.some(
                  (action) => String(action.action_key) === node.actionId,
                ) ? (
                  <option value={node.actionId}>
                    {node.actionId} · {t("automation.common.unavailable")}
                  </option>
                ) : null}
                {groupActions(actions.filter((action) => action.state === "ACTIVE"))
                  .map((plugin) => <optgroup key={plugin.key} label={pluginLabel(plugin.key)}>
                  {plugin.actions.map((action) => (
                    <option
                      key={String(action.id)}
                      value={String(action.action_key)}
                    >
                      {String(action.name)} · {actionPart(action.action_key)}
                    </option>
                  ))}
                  </optgroup>)}
              </select>
            </label>
            <NextNodeSelect
              id={`${id}-success`}
              label={t("bot.node.onSuccess")}
              value={node.onSuccess}
              nodes={nodes}
              onChange={(onSuccess) => replace({ ...node, onSuccess })}
            />
            <NextNodeSelect
              id={`${id}-failure`}
              label={t("bot.node.onFailure")}
              value={node.onFailure}
              nodes={nodes}
              onChange={(onFailure) => replace({ ...node, onFailure })}
            />
            <fieldset className="bot-action-inputs">
              <legend>{t("bot.node.requestValues")}</legend>
              {Object.entries(node.input).map(([key, inputValue], index) => (
                <div key={index}>
                  <label htmlFor={`${id}-input-${index}-key`}>
                    {t("bot.node.field")}
                    <input
                      id={`${id}-input-${index}-key`}
                      required
                      pattern={"[a-z][a-z0-9_.\\-]{0,127}"}
                      dir="ltr"
                      value={key}
                      onChange={(event) =>
                        replace({
                          ...node,
                          input: renameActionInput(
                            node.input,
                            key,
                            event.target.value,
                          ),
                        })
                      }
                    />
                  </label>
                  <label htmlFor={`${id}-input-${index}-value`}>
                    {t("bot.node.template")}
                    <input
                      id={`${id}-input-${index}-value`}
                      required
                      maxLength={2000}
                      dir="auto"
                      value={inputValue}
                      onChange={(event) =>
                        replace({
                          ...node,
                          input: { ...node.input, [key]: event.target.value },
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() =>
                      replace({
                        ...node,
                        input: Object.fromEntries(
                          Object.entries(node.input).filter(
                            ([inputKey]) => inputKey !== key,
                          ),
                        ),
                      })
                    }
                  >
                    {t("bot.node.removeValue")}
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button secondary small"
                onClick={() => {
                  const key = nextActionInputKey(node.input);
                  replace({
                    ...node,
                    input: { ...node.input, [key]: "{{message.text}}" },
                  });
                }}
              >
                {t("bot.node.addValue")}
              </button>
              <small>
                {t("bot.node.templateHelp", { example: isolate("{{message.text}}") })}
              </small>
            </fieldset>
          </>
        ) : null}
        {node.type === "handoff" ? (
          <>
            <label htmlFor={`${id}-target`}>
              {t("bot.node.handoffDestination")}
              <select
                id={`${id}-target`}
                value={node.target}
                onChange={(event) =>
                  replace(
                    replaceWorkflowHandoffTarget(
                      node,
                      event.target.value as
                        | "FIXED"
                        | "CLIENT_PRIMARY"
                        | "CLIENT_ESCALATION",
                      supportTeams[0]?.id ?? "",
                    ),
                  )
                }
              >
                <option value="CLIENT_PRIMARY">{t("bot.node.clientPrimary")}</option>
                <option value="CLIENT_ESCALATION">
                  {t("bot.node.clientEscalation")}
                </option>
                <option value="FIXED">{t("bot.node.fixedTeam")}</option>
              </select>
              <small>
                {t("bot.node.escalationHelp")}
              </small>
            </label>
            {node.target === "FIXED" ? (
              <>
              <label htmlFor={`${id}-group`}>
                {t("bot.node.teamReference")}
                <select
                  id={`${id}-group`}
                  required
                  value={node.zammadGroupId}
                  onChange={(event) =>
                    replace({ ...node, zammadGroupId: event.target.value })
                  }
                >
                  {!supportTeams.some((team) => team.id === node.zammadGroupId) ? <option value={node.zammadGroupId}>{node.zammadGroupId ? t("bot.node.unavailableTeam") : t("bot.assignments.selectTeam")}</option> : null}
                  {supportTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </label>
              <label htmlFor={`${id}-owner`}>
                {t("bot.node.fixedOwner")}
                <select id={`${id}-owner`} value={node.zammadOwnerId ?? ""} onChange={event => {
                  const { zammadOwnerId: _previousOwner, ...fixed } = node;
                  void _previousOwner;
                  replace({ ...fixed, ...(event.target.value ? { zammadOwnerId: event.target.value } : {}) });
                }}>
                  <option value="">{t("bot.node.automaticOwner")}</option>
                  {node.zammadOwnerId && !supportOwners.some(owner => owner.id === node.zammadOwnerId && owner.active && owner.groupIds.includes(node.zammadGroupId)) ? <option value={node.zammadOwnerId}>{t("bot.node.unavailableOwner")}</option> : null}
                  {supportOwners.filter(owner => owner.active && owner.groupIds.includes(node.zammadGroupId)).map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}
                </select>
                <small>{t("bot.node.fixedOwnerHelp")}</small>
                {node.zammadOwnerId && !supportOwners.some(owner => owner.id === node.zammadOwnerId && owner.active && owner.groupIds.includes(node.zammadGroupId)) ? <small className="bot-inline-error" role="alert">{t("bot.node.unavailableOwner")}</small> : null}
              </label>
              </>
            ) : null}
            <label className="bot-form-wide" htmlFor={`${id}-main-menu-mode`}>
              {t("bot.mainMenu.handoff")}
              <select id={`${id}-main-menu-mode`} name={`${node.id}_main_menu_mode`} aria-describedby={`${id}-main-menu-help`} value={node.mainMenuReturn ? "custom" : "generated"} onChange={event => {
                const next = { ...node };
                if (event.target.value === "custom") next.mainMenuReturn = { label: t("bot.mainMenu.defaultLabel") };
                else delete next.mainMenuReturn;
                replace(next);
              }}>
                <option value="generated">{t("bot.mainMenu.generated")}</option>
                <option value="custom" disabled={!mainMenuEnabled}>{t("bot.mainMenu.custom")}</option>
              </select>
              <small id={`${id}-main-menu-help`}>{t(mainMenuEnabled ? "bot.mainMenu.handoffHelp" : "bot.mainMenu.enableHelp")}</small>
            </label>
            {node.mainMenuReturn ? <label className="bot-form-wide" htmlFor={`${id}-main-menu-label`}>
              {t("bot.mainMenu.label")}
              <input id={`${id}-main-menu-label`} name={`${node.id}_main_menu_label`} dir="auto" required value={node.mainMenuReturn.label}
                aria-invalid={!mainMenuEnabled || !node.mainMenuReturn.label || node.mainMenuReturn.label !== node.mainMenuReturn.label.trim() || [...node.mainMenuReturn.label].length > 20}
                aria-describedby={`${id}-main-menu-label-help`}
                onChange={event => replace({ ...node, mainMenuReturn: { label: event.target.value } })} />
              <small id={`${id}-main-menu-label-help`}>{t("bot.mainMenu.labelError")}</small>
            </label> : null}
            <label htmlFor={`${id}-priority`}>
              {t("bot.node.priority")}
              <select
                id={`${id}-priority`}
                value={node.priority}
                onChange={(event) =>
                  replace({
                    ...node,
                    priority: event.target.value as typeof node.priority,
                  })
                }
              >
                <option value="1 low">{t("bot.node.low")}</option>
                <option value="2 normal">{t("bot.node.normal")}</option>
                <option value="3 high">{t("bot.node.high")}</option>
              </select>
            </label>
            <label className="bot-form-wide" htmlFor={`${id}-message`}>
              {t("bot.node.customerMessage")}
              <textarea
                id={`${id}-message`}
                maxLength={1024}
                dir="auto"
                value={node.message ?? ""}
                onChange={(event) =>
                  replace({ ...node, message: event.target.value || undefined })
                }
              />
            </label>
          </>
        ) : null}
        {node.type === "end" ? (
          <p className="bot-node-note">
            {t("bot.node.endHelp")}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

function NextNodeSelect({
  id,
  value,
  nodes,
  onChange,
  label,
}: {
  id: string;
  value: string;
  nodes: BotFlowNode[];
  onChange: (value: string) => void;
  label?: string;
}) {
  const { locale, t } = useI18n();
  return (
    <label htmlFor={id}>
      {label ?? t("bot.node.next")}
      <select
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {nodes.map((node) => (
          <option key={node.id} value={node.id}>
            {workflowStepLabel(node.id, { nodes }, "start", locale, t)}
          </option>
        ))}
      </select>
    </label>
  );
}

function nodeForType(
  type: BotFlowNode["type"],
  id: string,
  next: string,
  actions: Row[],
  mediaAssets:BotMediaAsset[],
  t: ReturnType<typeof useI18n>["t"],
): BotFlowNode {
  if (type === "send_text") return { id, type, text: t("bot.node.newMessage"), next };
  if(type==="send_media")return{id,type,assetId:"",next};
  if (type === "choice")
    return {
      id,
      type,
      prompt: t("bot.node.chooseOption"),
      buttonLabel: t("bot.node.chooseButton"),
      options: [{ id: "option_1", label: t("bot.node.newOption"), next }],
    };
  if (type === "request_location")
    return { id, type, prompt: t("bot.node.shareLocation"), next };
  if (type === "send_location")
    return { id, type, latitude: 24.7136, longitude: 46.6753, next };
  if (type === "send_template")
    return { id, type, templateName: "approved_template", languageCode: "en", bodyParameters: [], transcriptText: t("bot.node.templateTranscriptDefault"), next };
  if (type === "whatsapp_flow")
    return { id, type, flowId: "1", prompt: t("bot.node.flowPromptDefault"), buttonLabel: t("bot.node.flowButtonDefault"), data: {}, next };
  if (type === "action")
    return {
      id,
      type,
      actionId: String(
        actions.find((action) => action.state === "ACTIVE")?.action_key ??
          "action.configure",
      ),
      input: {},
      onSuccess: next,
      onFailure: next,
    };
  if (type === "handoff")
    return {
      id,
      type,
      target: "CLIENT_PRIMARY",
      priority: "2 normal",
      message: t("bot.starter.handoff.message"),
    };
  return { id, type: "end" };
}
function nextNodeId(nodes: BotFlowNode[]) {
  const used = new Set(nodes.map((node) => node.id));
  for (let index = 1; ; index++) {
    const id = `step_${index}`;
    if (!used.has(id)) return id;
  }
}
function nextChoiceId(node: Extract<BotFlowNode, { type: "choice" }>) {
  const used = new Set(node.options.map((option) => option.id));
  for (let index = 1; ; index++) {
    const id = `option_${index}`;
    if (!used.has(id)) return id;
  }
}
function nextActionInputKey(input: Record<string, string>) {
  for (let index = 1; ; index++) {
    const key = index === 1 ? "value" : `value_${index}`;
    if (!(key in input)) return key;
  }
}
function renameActionInput(
  input: Record<string, string>,
  oldKey: string,
  newKey: string,
) {
  if (newKey !== oldKey && newKey in input) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key === oldKey ? newKey : key,
      value,
    ]),
  );
}

function State({ value }: { value: unknown }) {
  const { t } = useI18n();
  const normalized = String(value).toLowerCase();
  const tone =
    normalized.includes("active") || normalized.includes("valid") || normalized.includes("working")
      ? "success"
      : normalized.includes("pause") ||
          normalized.includes("draft") ||
          normalized.includes("attention") || normalized.includes("connecting") ||
          normalized.includes("action_required") || normalized.includes("degraded")
        ? "warning"
        : normalized.includes("fail") || normalized.includes("revoked")
          ? "danger"
          : "neutral";
  return (
    <span className={`status status-${tone}`}>
      <i />
      {statusLabel(value, t)}
    </span>
  );
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
function actionParts(value: unknown) {
  const key = String(value ?? "");
  const separator = key.indexOf(".");
  return separator > 0
    ? { plugin: key.slice(0, separator), action: key.slice(separator + 1) }
    : { plugin: "general", action: key };
}
function actionPart(value: unknown) {
  return actionParts(value).action;
}
function pluginLabel(value: string) {
  return value.replace(/[._-]+/gu, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
function groupActions(rows: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = actionParts(row.action_key).plugin;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, actions]) => ({ key, actions }));
}
function formatTime(value: unknown, locale: "en" | "ar", t: ReturnType<typeof useI18n>["t"]) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime())
    ? t("automation.common.notRecorded")
    : formatDateTime(date, locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
function nodeTitle(type: string, t: ReturnType<typeof useI18n>["t"]) {
  return (
    (
      {
        send_text: t("bot.node.title.sendText"),
        send_media:t("bot.node.title.sendMedia"),
        choice: t("bot.node.title.choice"),
        request_location: t("bot.node.title.requestLocation"),
        send_location: t("bot.node.title.sendLocation"),
        send_template: t("bot.node.title.sendTemplate"),
        whatsapp_flow: t("bot.node.title.whatsappFlow"),
        action: t("bot.node.title.action"),
        handoff: t("bot.node.title.handoff"),
        end: t("bot.node.title.end"),
      } as Record<string, string>
    )[type] ?? type
  );
}
function nodeDescription(node: BotFlowDefinition["nodes"][number], locale: "en" | "ar", t: ReturnType<typeof useI18n>["t"], supportTeams: SupportTeam[] = [], nodes: readonly BotFlowNode[] = []) {
  if (node.type === "send_text") return node.text;
  if(node.type==="send_media")return node.caption||t("bot.media.configured");
  if (node.type === "choice")
    return t(node.options.length === 1 ? "bot.node.description.choicesOne" : "bot.node.description.choices", { prompt: node.prompt, count: formatNumber(node.options.length, locale) });
  if (node.type === "request_location") return node.prompt;
  if (node.type === "send_location")
    return `${node.name ?? t("bot.node.description.pinnedLocation")} · ${formatNumber(node.latitude, locale)}, ${formatNumber(node.longitude, locale)}`;
  if (node.type === "send_template")
    return t("bot.node.description.template", { name: isolate(node.templateName), language: isolate(node.languageCode) });
  if (node.type === "whatsapp_flow")
    return t("bot.node.description.flow", { id: isolate(node.flowId), button: node.buttonLabel });
  if (node.type === "action")
    return t("bot.node.description.action", { action: isolate(node.actionId), success: isolate(workflowStepLabel(node.onSuccess, { nodes }, "end", locale, t)), failure: isolate(workflowStepLabel(node.onFailure, { nodes }, "end", locale, t)) });
  if (node.type === "handoff")
    return `${node.target === "FIXED" ? t("bot.node.description.fixedTeam", { team: isolate(botSupportTeamName(node.zammadGroupId, supportTeams, t("bot.assignments.teamUnavailable"))) }) : node.target === "CLIENT_ESCALATION" ? t("bot.node.clientEscalation") : t("bot.node.clientPrimary")} · ${t(node.priority==="1 low"?"bot.node.low":node.priority==="3 high"?"bot.node.high":"bot.node.normal")}${node.mainMenuReturn ? ` · ${node.mainMenuReturn.label}` : ""}`;
  return t("bot.node.description.resolve");
}
function effects(result: BotFlowAdvance, t: ReturnType<typeof useI18n>["t"], supportTeams: SupportTeam[]) {
  return result.effects.map((effect) => {
    if (effect.type === "send_text")
      return { side: "bot" as const, text: effect.text };
    if(effect.type==="send_media")return{side:"bot" as const,text:effect.caption||t("bot.media.simulated")};
    if (effect.type === "send_choices")
      return {
        side: "bot" as const,
        text: `${effect.prompt} · ${effect.options.map((option) => option.label).join(" / ")}`,
      };
    if (effect.type === "request_location")
      return { side: "bot" as const, text: effect.prompt };
    if (effect.type === "send_location")
      return {
        side: "bot" as const,
        text: t("bot.effect.location", { location: effect.name ?? `${effect.latitude}, ${effect.longitude}` }),
      };
    if (effect.type === "send_template")
      return { side: "bot" as const, text: t("bot.effect.template", { name: isolate(effect.templateName), text: effect.transcriptText }) };
    if (effect.type === "send_whatsapp_flow")
      return { side: "bot" as const, text: t("bot.effect.flow", { prompt: effect.prompt, button: effect.buttonLabel }) };
    if (effect.type === "action")
      return {
        side: "system" as const,
        text: t("bot.effect.action", { action: isolate(effect.actionId) }),
      };
    if (effect.type === "handoff")
      return {
        side: "system" as const,
        text: t("bot.effect.handoff", { message: effect.message ? `${effect.message} · ` : "", target: effect.target === "FIXED" ? t("bot.effect.team", { team: isolate(botSupportTeamName(effect.zammadGroupId, supportTeams, t("bot.assignments.teamUnavailable"))) }) : effect.target === "CLIENT_ESCALATION" ? t("bot.effect.escalation") : t("bot.effect.primary") }),
      };
    return { side: "system" as const, text: t("bot.effect.resolved") };
  });
}
function statusLabel(value: unknown, t: ReturnType<typeof useI18n>["t"]) {
  const normalized = String(value).toLowerCase();
  const key = ({ active: "automation.status.active", draft: "automation.status.draft", paused: "automation.status.paused", retired: "automation.status.retired", valid: "automation.status.valid", needs_attention: "automation.status.needsAttention", human: "automation.status.human", handoff_pending: "automation.status.handoffPending", action_pending: "automation.status.actionPending", outcome_unknown: "automation.status.outcomeUnknown", failed_terminal: "automation.status.failedTerminal", failed_retryable: "automation.status.failedRetryable", failed: "automation.status.failed", succeeded: "automation.status.succeeded", queued: "automation.status.queued", handoff_succeeded: "automation.status.handoffSucceeded", handoff_requested: "automation.status.handoffRequested", action_outcome_unknown: "automation.status.actionOutcomeUnknown", bot: "automation.status.bot", resolved: "automation.status.resolved", ready: "automation.status.ready", running: "automation.status.running", error: "automation.status.error", degraded: "automation.status.degraded", waiting: "automation.status.waiting", conflict: "automation.status.conflict", working: "tenant.status.working", connecting: "tenant.status.connecting", action_required: "tenant.status.actionRequired", revoked: "tenant.status.revoked", start: "bot.conversations.start", end: "bot.conversations.end" } as Record<string, string>)[normalized];
  return key ? t(key) : t("tenant.status.unknown");
}
function workflowEventLabel(value: unknown, t: ReturnType<typeof useI18n>["t"]) {
  const key = ({
    STARTED: "bot.events.started",
    MESSAGE: "bot.events.message",
    CHOICE: "bot.events.choice",
    LOCATION: "bot.events.location",
    FLOW_RESPONSE: "bot.events.flowResponse",
    ACTION_SUCCEEDED: "bot.events.actionSucceeded",
    ACTION_FAILED: "bot.events.actionFailed",
    ACTION_OUTCOME_UNKNOWN: "bot.events.actionOutcomeUnknown",
    ACTION_RETRY_REQUESTED: "bot.events.actionRetryRequested",
    HANDOFF_REQUESTED: "bot.events.handoffRequested",
    HANDOFF_COMPLETED: "bot.events.handoffCompleted",
    RESUMED: "bot.events.resumed",
    RESOLVED: "bot.events.resolved",
  } as Record<string, string>)[String(value).toUpperCase()];
  return t(key ?? "bot.events.unavailable");
}
function flowDefinition(value: unknown) {
  try { return parseBotFlow(value); } catch { return null; }
}
function workflowStepLabel(
  value: unknown,
  definition: { nodes: readonly BotFlowNode[] } | null,
  boundary: "start" | "end",
  locale: "en" | "ar",
  t: ReturnType<typeof useI18n>["t"],
) {
  if (value === null || value === undefined || value === "") return t(`bot.conversations.${boundary}`);
  const index = definition?.nodes.findIndex((candidate) => candidate.id === String(value)) ?? -1;
  const node = definition?.nodes[index];
  return node ? t("ticketEvent.stepLabel", { number: formatNumber(index + 1, locale), type: nodeTitle(node.type, t) }) : t("bot.conversations.stepUnavailable");
}
function keepOpenPolicySummary(definition: BotFlowDefinition | null, locale: "en" | "ar", t: ReturnType<typeof useI18n>["t"]) {
  const policy = definition?.keepOpenPolicy;
  if (!policy) return t("bot.keepOpen.existing");
  return t(policy.humanReplyPauseMinutes === null ? "bot.keepOpen.summaryNoReturn" : policy.humanReplyPauseMinutes === 1 ? "bot.keepOpen.summaryOne" : "bot.keepOpen.summary", {
    minutes: policy.humanReplyPauseMinutes === null ? "" : formatNumber(policy.humanReplyPauseMinutes, locale),
    menu: t(policy.mainMenu ? "bot.keepOpen.available" : "bot.keepOpen.unavailable"),
    resolution: t(policy.customerResolution ? "bot.keepOpen.available" : "bot.keepOpen.unavailable"),
  });
}
function comparisonSettingValue(
  field: "name" | "start" | "maxSteps" | "keepOpenPolicy" | "welcomeResendMinutes" | "mainMenuNodeId" | "entryCommands",
  value: string | number,
  definition: BotFlowDefinition | null,
  locale: "en" | "ar",
  t: ReturnType<typeof useI18n>["t"],
) {
  if (field === "keepOpenPolicy") return keepOpenPolicySummary(definition, locale, t);
  if (field === "welcomeResendMinutes") return definition?.welcomeResendMinutes == null ? t("bot.welcome.off") : t("bot.welcome.summary", { minutes: formatNumber(definition.welcomeResendMinutes, locale) });
  if (field === "entryCommands") return definition?.entryCommands?.length
    ? definition.entryCommands.map(entry => `${entry.aliases.join(" / ")} → ${isolate(workflowStepLabel(entry.target, definition, "start", locale, t))} · ${t(entry.enabled ? "bot.entry.enabled" : "bot.entry.disabled")}`).join("; ")
    : t("bot.entry.none");
  if (field === "mainMenuNodeId") value = definition?.mainMenuNodeId ?? definition?.start ?? "";
  else if (field !== "start") return String(value);
  const node = definition?.nodes.find((candidate) => candidate.id === String(value));
  if (!node) return t("bot.conversations.stepUnavailable");
  const safeDescription = ["send_text", "send_media", "choice", "request_location", "send_location", "end"].includes(node.type)
    ? nodeDescription(node, locale, t)
    : "";
  const label = workflowStepLabel(value, definition, "start", locale, t);
  return safeDescription ? `${label} · ${safeDescription}` : label;
}
function isolate(value: string) { return `\u2068${value}\u2069`; }
async function responseError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as {
    code?: unknown;
  };
  const locale = typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("ar") ? "ar" : "en";
  return localizedUiError(locale, { status: response.status, code: body.code }).message || fallback;
}
