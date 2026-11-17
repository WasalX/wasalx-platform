import { parseBotFlow, type BotFlowDefinition, type BotFlowNode } from "../packages/core/src/bot-flow.ts";

export type WorkflowNodePosition = { x: number; y: number };
export type WorkflowPresentation = { nodePositions: Record<string, WorkflowNodePosition> };
export type WorkflowExecutionState = "success" | "retry" | "failure" | "outcome_unknown" | "handoff";
export type WorkflowDefinitionComparison = {
  settings: Array<{
    field: "name" | "start" | "maxSteps" | "keepOpenPolicy" | "welcomeResendMinutes" | "mainMenuNodeId" | "entryCommands";
    before: string | number;
    after: string | number;
  }>;
  nodes: Array<{
    id: string;
    kind: "added" | "removed" | "changed" | "unchanged";
    before?: BotFlowNode;
    after?: BotFlowNode;
    changedFields: string[];
  }>;
  summary: { added: number; removed: number; changed: number; unchanged: number };
};

export const emptyWorkflowPresentation = (): WorkflowPresentation => ({ nodePositions: {} });

export function parseWorkflowDraftRecovery(value: unknown): {
  definition: BotFlowDefinition;
  presentation: WorkflowPresentation;
} {
  const record = isRecord(value) && "definition" in value ? value : { definition: value };
  const definition = parseBotFlow(record.definition);
  const positions = isRecord(record.presentation) && isRecord(record.presentation.nodePositions)
    ? record.presentation.nodePositions
    : {};
  return {
    definition,
    presentation: {
      nodePositions: Object.fromEntries(definition.nodes.flatMap((node) => {
        const position = positions[node.id];
        return isRecord(position) && finiteCoordinate(position.x) && finiteCoordinate(position.y)
          ? [[node.id, { x: position.x, y: position.y }]]
          : [];
      })),
    },
  };
}

export function serializeWorkflowDraftRecovery(
  definition: BotFlowDefinition,
  presentation: WorkflowPresentation,
) {
  return JSON.stringify({ definition, presentation });
}

export function workflowExecutionOverlays(rows: ReadonlyArray<Record<string, unknown>>) {
  const overlays: Record<string, WorkflowExecutionState> = {};
  const priority: Record<WorkflowExecutionState, number> = {
    success: 1,
    handoff: 2,
    retry: 3,
    failure: 4,
    outcome_unknown: 5,
  };
  const record = (target: Record<string, WorkflowExecutionState>, nodeId: unknown, state: WorkflowExecutionState) => {
    if (typeof nodeId !== "string" || !nodeId) return;
    target[nodeId] = state;
  };

  for (const row of rows) {
    const rowOverlays: Record<string, WorkflowExecutionState> = {};
    if (Array.isArray(row.timeline)) {
      for (const event of row.timeline) {
        if (!isRecord(event)) continue;
        const kind = String(event.kind ?? "");
        if (kind === "ACTION_SUCCEEDED") record(rowOverlays, event.from, "success");
        else if (kind === "ACTION_RETRY_REQUESTED") record(rowOverlays, event.from, "retry");
        else if (kind === "ACTION_FAILED") record(rowOverlays, event.from, "failure");
        else if (kind === "ACTION_OUTCOME_UNKNOWN") record(rowOverlays, event.from, "outcome_unknown");
        else if (kind === "HANDOFF_REQUESTED" || kind === "HANDOFF_COMPLETED" || kind === "HANDOFF_SUCCEEDED") {
          record(rowOverlays, event.to ?? event.from, "handoff");
        }
      }
    }
    const actionState = String(row.action_state ?? "");
    if (actionState === "SUCCEEDED") record(rowOverlays, row.action_node_id, "success");
    else if (actionState === "FAILED_RETRYABLE") record(rowOverlays, row.action_node_id, "retry");
    else if (actionState === "FAILED_TERMINAL") record(rowOverlays, row.action_node_id, "failure");
    else if (actionState === "OUTCOME_UNKNOWN") record(rowOverlays, row.action_node_id, "outcome_unknown");
    if (row.state === "HUMAN" || row.state === "HANDOFF_PENDING" || typeof row.handoff_state === "string") {
      record(rowOverlays, row.current_node_id, "handoff");
    }
    for (const [nodeId, state] of Object.entries(rowOverlays)) {
      if (!overlays[nodeId] || priority[state] > priority[overlays[nodeId]]) overlays[nodeId] = state;
    }
  }
  return overlays;
}

export function compareWorkflowDefinitions(
  leftValue: unknown,
  rightValue: unknown,
): WorkflowDefinitionComparison {
  const left = parseBotFlow(leftValue);
  const right = parseBotFlow(rightValue);
  const settings: WorkflowDefinitionComparison["settings"] = (["name", "start", "maxSteps"] as const).flatMap((field) =>
    canonicalEqual(left[field], right[field])
      ? []
      : [{ field, before: left[field], after: right[field] }],
  );
  if (!canonicalEqual(left.keepOpenPolicy, right.keepOpenPolicy)) settings.push({
    field: "keepOpenPolicy", before: JSON.stringify(left.keepOpenPolicy ?? null), after: JSON.stringify(right.keepOpenPolicy ?? null),
  });
  for (const field of ["welcomeResendMinutes", "mainMenuNodeId", "entryCommands"] as const) {
    if (!canonicalEqual(left[field], right[field])) settings.push({
      field, before: JSON.stringify(left[field] ?? null), after: JSON.stringify(right[field] ?? null),
    });
  }
  const before = new Map(left.nodes.map((node) => [node.id, node]));
  const after = new Map(right.nodes.map((node) => [node.id, node]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const nodes = ids.map((id) => {
    const previous = before.get(id);
    const next = after.get(id);
    if (!previous) return { id, kind: "added" as const, after: next!, changedFields: [] };
    if (!next) return { id, kind: "removed" as const, before: previous, changedFields: [] };
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(next)])]
      .filter((field) => field !== "id" && !canonicalEqual(
        (previous as unknown as Record<string, unknown>)[field],
        (next as unknown as Record<string, unknown>)[field],
      ))
      .sort();
    return {
      id,
      kind: changedFields.length ? "changed" as const : "unchanged" as const,
      before: previous,
      after: next,
      changedFields,
    };
  });
  return {
    settings,
    nodes,
    summary: {
      added: nodes.filter((node) => node.kind === "added").length,
      removed: nodes.filter((node) => node.kind === "removed").length,
      changed: nodes.filter((node) => node.kind === "changed").length + settings.length,
      unchanged: nodes.filter((node) => node.kind === "unchanged").length,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
}

function canonicalEqual(left: unknown, right: unknown) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
  return value;
}

export type WorkflowTransition = {
  handle: string;
  kind: "next" | "choice" | "success" | "failure";
  label?: string;
  target: string;
};

export function workflowTransitions(node: BotFlowNode): WorkflowTransition[] {
  if (node.type === "choice") {
    return node.options.map((option) => ({
      handle: `choice:${option.id}`,
      kind: "choice",
      label: option.label,
      target: option.next,
    }));
  }
  if (node.type === "action") {
    return [
      { handle: "action:success", kind: "success", target: node.onSuccess },
      { handle: "action:failure", kind: "failure", target: node.onFailure },
    ];
  }
  if (
    node.type === "send_text" ||
    node.type === "send_media" ||
    node.type === "request_location" ||
    node.type === "send_location" ||
    node.type === "send_template" ||
    node.type === "whatsapp_flow"
  ) {
    return [{ handle: "next", kind: "next", target: node.next }];
  }
  return [];
}

export function reconnectWorkflowNode<T extends BotFlowNode>(node: T, handle: string, target: string): T {
  if (!target) throw new Error("Workflow connection target is required");
  if (node.type === "choice" && handle.startsWith("choice:")) {
    const optionId = handle.slice("choice:".length);
    if (!node.options.some((option) => option.id === optionId)) throw new Error("Workflow choice output is invalid");
    return {
      ...node,
      options: node.options.map((option) => option.id === optionId ? { ...option, next: target } : option),
    } as T;
  }
  if (node.type === "action" && handle === "action:success") return { ...node, onSuccess: target } as T;
  if (node.type === "action" && handle === "action:failure") return { ...node, onFailure: target } as T;
  if (handle === "next" && "next" in node) return { ...node, next: target } as T;
  throw new Error("Workflow output is invalid");
}

/** Declarations are references even when an entry command is disabled. */
export function canRemoveWorkflowNode(definition: BotFlowDefinition, nodeId: string) {
  return nodeId !== definition.start && nodeId !== definition.mainMenuNodeId &&
    !definition.entryCommands?.some(entry => entry.target === nodeId) &&
    !definition.nodes.some(node => node.id !== nodeId && workflowTransitions(node).some(edge => edge.target === nodeId));
}

export function replaceWorkflowHandoffTarget(
  node: Extract<BotFlowNode, { type: "handoff" }>,
  target: "FIXED" | "CLIENT_PRIMARY" | "CLIENT_ESCALATION",
  defaultTeamId: string,
): Extract<BotFlowNode, { type: "handoff" }> {
  const base = {
    id: node.id, type: node.type, priority: node.priority,
    ...(node.message ? { message: node.message } : {}),
    ...(node.mainMenuReturn ? { mainMenuReturn: node.mainMenuReturn } : {}),
  };
  return target === "FIXED"
    ? { ...base, target, zammadGroupId: node.target === "FIXED" ? node.zammadGroupId : defaultTeamId,
      ...(node.target === "FIXED" && node.zammadOwnerId ? { zammadOwnerId: node.zammadOwnerId } : {}) }
    : { ...base, target };
}
