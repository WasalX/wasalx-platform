"use client";

import "@xyflow/react/dist/style.css";

import { memo, useCallback, useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type AriaLabelConfig,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  reconnectWorkflowNode,
  workflowTransitions,
  type WorkflowExecutionState,
  type WorkflowNodePosition,
} from "../lib/workflow-graph.ts";
import type { BotFlowDefinition, BotFlowNode } from "../packages/core/src/bot-flow.ts";
import { formatNumber } from "../lib/i18n/format.ts";
import { useI18n } from "./I18nProvider";

type CanvasNodeData = {
  description: string;
  outputs: Array<{ handle: string; label: string }>;
  start: boolean;
  startLabel: string;
  entryLabel?: string;
  title: string;
  overlay?: { label: string; state: WorkflowExecutionState };
};
type CanvasNode = Node<CanvasNodeData, "workflow">;
type PaletteItem = { label: string; type: BotFlowNode["type"] };

const WorkflowNode = memo(function WorkflowNode({ data }: NodeProps<CanvasNode>) {
  return <div className="workflow-graph-node">
    <Handle type="target" position={Position.Left} />
    <span className="workflow-node-type">{data.title}</span>
    <b><bdi>{data.description}</bdi></b>
    {data.start ? <small className="workflow-start-badge">{data.startLabel}</small> : null}
    {data.entryLabel ? <small className="workflow-start-badge">{data.entryLabel}</small> : null}
    {data.overlay ? <small className={`workflow-node-overlay status status-${overlayTone(data.overlay.state)}`}>
      <i aria-hidden="true" />{data.overlay.label}
    </small> : null}
    {data.outputs.map((output, index) => <span className="workflow-output" key={output.handle}>
      <small>{output.label}</small>
      <Handle
        aria-label={output.label}
        id={output.handle}
        position={Position.Right}
        style={{ top: `${((index + 1) / (data.outputs.length + 1)) * 100}%` }}
        type="source"
      />
    </span>)}
  </div>;
});

const nodeTypes = { workflow: WorkflowNode };

export function WorkflowCanvas({
  definition,
  palette,
  addNode,
  describeNode,
  nodeTitle,
  stepLabel,
  setDefinition,
  focusNode,
  positions,
  setNodePosition,
  executionOverlays,
}: {
  definition: BotFlowDefinition;
  palette: PaletteItem[];
  addNode: (type: BotFlowNode["type"]) => void;
  describeNode: (node: BotFlowNode) => string;
  nodeTitle: (type: BotFlowNode["type"]) => string;
  stepLabel: (nodeId: string) => string;
  setDefinition: (definition: BotFlowDefinition) => void;
  focusNode: (nodeId: string) => void;
  positions: Record<string, WorkflowNodePosition>;
  setNodePosition: (nodeId: string, position: WorkflowNodePosition) => void;
  executionOverlays: Record<string, WorkflowExecutionState>;
}) {
  const { locale, t } = useI18n();
  const overlayLabels = useMemo<Record<WorkflowExecutionState, string>>(() => ({
    success: t("automation.status.succeeded"),
    retry: t("automation.status.failedRetryable"),
    failure: t("automation.status.failedTerminal"),
    outcome_unknown: t("automation.status.outcomeUnknown"),
    handoff: nodeTitle("handoff"),
  }), [nodeTitle, t]);
  const projectedNodes = useMemo<CanvasNode[]>(() => definition.nodes.map((node, index) => {
    const transitions = workflowTransitions(node);
    const entryLabel = definition.entryCommands?.some(entry => entry.target === node.id) ? t("bot.entry.point") : undefined;
    const overlayState = executionOverlays[node.id];
    const overlay = overlayState ? { state: overlayState, label: overlayLabels[overlayState] } : undefined;
    return {
      id: node.id,
      type: "workflow",
      position: positions[node.id] ?? { x: (index % 4) * 270, y: Math.floor(index / 4) * 190 },
      data: {
        title: stepLabel(node.id),
        description: describeNode(node),
        start: node.id === definition.start,
        startLabel: t("bot.node.first"),
        entryLabel,
        overlay,
        outputs: transitions.map((transition) => ({
          handle: transition.handle,
          label: transition.label ?? t(`bot.canvas.${transition.kind}`),
        })),
      },
      ariaLabel: [t("bot.canvas.edit", { name: stepLabel(node.id) }), entryLabel, overlay?.label].filter(Boolean).join(" · "),
      ariaRole: "button",
      domAttributes: { "aria-roledescription": t("bot.canvas.nodeRole") },
    };
  }), [definition.nodes, definition.start, definition.entryCommands, describeNode, executionOverlays, overlayLabels, positions, stepLabel, t]);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(projectedNodes);

  useEffect(() => {
    setNodes((current) => projectedNodes.map((node) => {
      const previous = current.find((candidate) => candidate.id === node.id);
      return {
        ...node,
        selected: previous?.selected ?? node.selected,
        position: positions[node.id] ?? previous?.position ?? node.position,
      };
    }));
  }, [positions, projectedNodes, setNodes]);

  const changeNodes = useCallback((changes: NodeChange<CanvasNode>[]) => {
    onNodesChange(changes);
    for (const change of changes) {
      if (change.type === "position" && change.position && change.dragging !== true) {
        setNodePosition(change.id, change.position);
      }
    }
  }, [onNodesChange, setNodePosition]);

  const finishNodeDrag = useCallback((_: MouseEvent | TouchEvent, node: CanvasNode) => {
    setNodePosition(node.id, node.position);
  }, [setNodePosition]);

  const edges = useMemo<Edge[]>(() => definition.nodes.flatMap((node) =>
    workflowTransitions(node).map((transition) => ({
      id: `${node.id}:${transition.handle}`,
      source: node.id,
      sourceHandle: transition.handle,
      target: transition.target,
      label: transition.label ?? t(`bot.canvas.${transition.kind}`),
      ariaLabel: t("bot.canvas.edge", { from: stepLabel(node.id), to: stepLabel(transition.target), transition: transition.label ?? t(`bot.canvas.${transition.kind}`) }),
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      deletable: false,
      focusable: true,
      domAttributes: { "aria-roledescription": t("bot.canvas.edgeRole") },
    }))), [definition.nodes, stepLabel, t]);

  const connect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.sourceHandle || !connection.target) return;
    setDefinition({
      ...definition,
      nodes: definition.nodes.map((node) => node.id === connection.source
        ? reconnectWorkflowNode(node, connection.sourceHandle!, connection.target!)
        : node),
    });
  }, [definition, setDefinition]);

  const ariaLabels: Partial<AriaLabelConfig> = {
    "node.a11yDescription.default": t("bot.canvas.nodeKeyboardHelp"),
    "node.a11yDescription.keyboardDisabled": t("bot.canvas.nodeKeyboardHelp"),
    "node.a11yDescription.ariaLiveMessage": ({ x, y }) => t("bot.canvas.nodeMoved", { x: formatNumber(x, locale), y: formatNumber(y, locale) }),
    "edge.a11yDescription.default": t("bot.canvas.edgeKeyboardHelp"),
    "controls.ariaLabel": t("bot.canvas.controls"),
    "controls.zoomIn.ariaLabel": t("bot.canvas.zoomIn"),
    "controls.zoomOut.ariaLabel": t("bot.canvas.zoomOut"),
    "controls.fitView.ariaLabel": t("bot.canvas.fit"),
    "controls.interactive.ariaLabel": t("bot.canvas.interactive"),
    "minimap.ariaLabel": t("bot.canvas.minimap"),
    "handle.ariaLabel": t("bot.canvas.handle"),
  };

  return <section className="workflow-canvas" aria-labelledby="workflow-canvas-title">
    <div className="bot-section-head"><div><h3 id="workflow-canvas-title">{t("bot.canvas.title")}</h3><p>{t("bot.canvas.help")}</p></div></div>
    <div className="workflow-palette" role="group" aria-label={t("bot.canvas.palette")}>
      {palette.map((item) => <button type="button" className="button secondary small" key={item.type} onClick={() => addNode(item.type)}>+ {item.label}</button>)}
    </div>
    <div className="workflow-graph" role="region" aria-label={t("bot.canvas.region")}>
      <ReactFlow
        ariaLabelConfig={ariaLabels}
        defaultEdgeOptions={{ type: "smoothstep" }}
        deleteKeyCode={null}
        edges={edges}
        edgesFocusable
        edgesReconnectable={false}
        elementsSelectable
        fitView
        maxZoom={1.5}
        minZoom={0.35}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable
        nodesDraggable
        nodesFocusable
        onConnect={connect}
        onNodeClick={(_, node) => focusNode(node.id)}
        onNodeDragStop={finishNodeDrag}
        onNodesChange={changeNodes}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </section>;
}

function overlayTone(state: WorkflowExecutionState) {
  if (state === "success") return "success";
  if (state === "failure") return "danger";
  return "warning";
}
