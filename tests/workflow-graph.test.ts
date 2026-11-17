import assert from "node:assert/strict";
import test from "node:test";
import {
  compareWorkflowDefinitions,
  canRemoveWorkflowNode,
  replaceWorkflowHandoffTarget,
  parseWorkflowDraftRecovery,
  reconnectWorkflowNode,
  serializeWorkflowDraftRecovery,
  workflowExecutionOverlays,
  workflowTransitions,
} from "../lib/workflow-graph.ts";

const definition = {
  schemaVersion: 1 as const,
  name: "Support",
  start: "welcome",
  maxSteps: 10,
  nodes: [
    { id: "welcome", type: "send_text" as const, text: "Welcome", next: "done" },
    { id: "done", type: "end" as const },
  ],
};

test("workflow graph exposes and reconnects every durable transition kind", () => {
  const choice = { id: "menu", type: "choice" as const, prompt: "Choose", options: [
    { id: "lookup", label: "Track shipment", next: "lookup" },
    { id: "agent", label: "Talk to support", next: "handoff" },
  ] };
  assert.deepEqual(workflowTransitions(choice).map(({ handle, target }) => ({ handle, target })), [
    { handle: "choice:lookup", target: "lookup" },
    { handle: "choice:agent", target: "handoff" },
  ]);
  assert.equal(reconnectWorkflowNode(choice, "choice:lookup", "status").options[0]?.next, "status");

  const action = { id: "lookup", type: "action" as const, actionId: "shipment.lookup", input: {}, onSuccess: "answer", onFailure: "handoff" };
  assert.deepEqual(workflowTransitions(action).map(({ handle, target }) => ({ handle, target })), [
    { handle: "action:success", target: "answer" },
    { handle: "action:failure", target: "handoff" },
  ]);
  assert.equal(reconnectWorkflowNode(action, "action:failure", "retry").onFailure, "retry");

  const text = { id: "welcome", type: "send_text" as const, text: "Welcome", next: "menu" };
  assert.equal(reconnectWorkflowNode(text, "next", "handoff").next, "handoff");
  const media={id:"media",type:"send_media" as const,assetId:"6f4fe8f1-67bb-4a06-945a-b6036d94fa92",next:"done"};
  assert.deepEqual(workflowTransitions(media),[{handle:"next",kind:"next",target:"done"}]);
  assert.equal(reconnectWorkflowNode(media,"next","handoff").next,"handoff");
  assert.deepEqual(workflowTransitions({ id: "done", type: "end" }), []);
  assert.throws(() => reconnectWorkflowNode(action, "unknown", "done"), /output is invalid/u);
});

test("workflow draft recovery keeps presentation positions outside the execution definition", () => {
  const serialized = serializeWorkflowDraftRecovery(definition, {
    nodePositions: { welcome: { x: 120, y: -24 }, removed: { x: 8, y: 9 } },
  });
  const record = JSON.parse(serialized);
  assert.deepEqual(record.definition, definition);
  assert.equal("presentation" in record.definition, false);
  assert.deepEqual(parseWorkflowDraftRecovery(record), {
    definition,
    presentation: { nodePositions: { welcome: { x: 120, y: -24 } } },
  });
  assert.deepEqual(parseWorkflowDraftRecovery(definition), {
    definition,
    presentation: { nodePositions: {} },
  });
  record.presentation.nodePositions.welcome.x = Number.POSITIVE_INFINITY;
  assert.deepEqual(parseWorkflowDraftRecovery(record).presentation.nodePositions, {});
});

test("workflow comparison follows immutable node identity and ignores presentation order", () => {
  const reordered = { ...definition, nodes: [...definition.nodes].reverse() };
  assert.deepEqual(compareWorkflowDefinitions(definition, reordered).summary, {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 2,
  });

  const revised = {
    ...definition,
    name: "الدعم Support",
    maxSteps: 12,
    nodes: [
      { ...definition.nodes[0], text: "أهلًا Welcome", next: "handoff" },
      { id: "handoff", type: "handoff" as const, target: "CLIENT_PRIMARY" as const, priority: "2 normal" },
    ],
  };
  const comparison = compareWorkflowDefinitions(definition, revised);
  assert.deepEqual(comparison.settings.map(({ field }) => field), ["name", "maxSteps"]);
  assert.deepEqual(comparison.summary, { added: 1, removed: 1, changed: 3, unchanged: 0 });
  assert.deepEqual(comparison.nodes.find(({ id }) => id === "welcome")?.changedFields, ["next", "text"]);
  assert.equal(comparison.nodes.find(({ id }) => id === "handoff")?.kind, "added");
  assert.equal(comparison.nodes.find(({ id }) => id === "done")?.kind, "removed");
});

test("workflow execution overlays project durable action and handoff evidence with fail-safe precedence", () => {
  assert.deepEqual(workflowExecutionOverlays([
    {
      state: "HUMAN",
      current_node_id: "handoff",
      handoff_state: "SUCCEEDED",
      timeline: [
        { kind: "ACTION_SUCCEEDED", from: "lookup" },
        { kind: "ACTION_FAILED", from: "retry" },
        { kind: "ACTION_RETRY_REQUESTED", from: "retry" },
        { kind: "ACTION_FAILED", from: "failed" },
        { kind: "ACTION_OUTCOME_UNKNOWN", from: "unknown" },
        { kind: "HANDOFF_REQUESTED", from: "welcome", to: "handoff" },
      ],
    },
    { action_node_id: "lookup", action_state: "OUTCOME_UNKNOWN" },
  ]), {
    lookup: "outcome_unknown",
    retry: "retry",
    failed: "failure",
    unknown: "outcome_unknown",
    handoff: "handoff",
  });
});


test("workflow recovery and comparison preserve the optional open-ticket policy", () => {
  const policy = { humanReplyPauseMinutes: 120, mainMenu: true, customerResolution: true };
  const enabled = { ...definition, keepOpenPolicy: policy };
  assert.deepEqual(parseWorkflowDraftRecovery(JSON.parse(serializeWorkflowDraftRecovery(enabled, { nodePositions: {} }))).definition, enabled);
  assert.equal("keepOpenPolicy" in parseWorkflowDraftRecovery(definition).definition, false);
  const disabled = { ...definition, keepOpenPolicy: { humanReplyPauseMinutes: null, mainMenu: false, customerResolution: false } };
  assert.deepEqual(parseWorkflowDraftRecovery(JSON.parse(serializeWorkflowDraftRecovery(disabled, { nodePositions: {} }))).definition, disabled);
  assert.deepEqual(compareWorkflowDefinitions(disabled, definition).settings.map(row => row.field), ["keepOpenPolicy"]);
  assert.equal(compareWorkflowDefinitions(disabled, definition).summary.unchanged, definition.nodes.length);
  const changes = compareWorkflowDefinitions(definition, enabled);
  assert.deepEqual(changes.settings.map(row => row.field), ["keepOpenPolicy"]);
  assert.equal(changes.summary.changed, 1);
  assert.equal(compareWorkflowDefinitions(enabled, { ...enabled, keepOpenPolicy: { ...policy, humanReplyPauseMinutes: null } }).summary.changed, 1);
  assert.equal(compareWorkflowDefinitions(enabled, { ...enabled, keepOpenPolicy: { ...policy, mainMenu: false } }).summary.changed, 1);
  assert.equal(compareWorkflowDefinitions(enabled, { ...enabled, keepOpenPolicy: { ...policy, customerResolution: false } }).summary.changed, 1);
  assert.equal(compareWorkflowDefinitions(enabled, { ...enabled, keepOpenPolicy: { customerResolution: true, mainMenu: true, humanReplyPauseMinutes: 120 } }).summary.changed, 0);
});


test("workflow editor protects declared disabled entry and Main menu targets without fake edges", () => {
  const flow = {
    ...definition, mainMenuNodeId: "menu",
    entryCommands: [{ id: "support", aliases: ["Help please", "أحتاج مساعدة"], target: "detached", enabled: false }],
    nodes: [...definition.nodes,
      { id: "menu", type: "choice" as const, prompt: "Menu", options: [{ id: "done", label: "Finish", next: "done" }] },
      { id: "detached", type: "end" as const },
      { id: "unreferenced", type: "end" as const }],
  };
  for (const id of ["welcome", "done", "menu", "detached"]) assert.equal(canRemoveWorkflowNode(flow, id), false, id);
  assert.equal(canRemoveWorkflowNode(flow, "unreferenced"), true);
  assert.equal(canRemoveWorkflowNode({ ...flow, entryCommands: [] }, "detached"), true);
  assert.equal(canRemoveWorkflowNode({ ...flow, mainMenuNodeId: null }, "menu"), true);
  assert.deepEqual(workflowTransitions(flow.nodes[0]!), [{ handle: "next", kind: "next", target: "done" }]);
  assert.deepEqual(workflowTransitions(flow.nodes[3]!), []);
});

test("workflow handoff route edits preserve custom Main menu labels for all six branches", () => {
  for (let index = 0; index < 6; index++) {
    const original = { id: `handoff_${index}`, type: "handoff" as const, target: "CLIENT_PRIMARY" as const,
      priority: "2 normal" as const, message: "A person can help", mainMenuReturn: { label: index % 2 ? "القائمة الرئيسية" : "Main menu" } };
    const fixed = replaceWorkflowHandoffTarget(original, "FIXED", "sample-team");
    assert.deepEqual(fixed.mainMenuReturn, original.mainMenuReturn);
    assert.equal(fixed.zammadGroupId, "sample-team");
    const owned = { ...fixed, target: "FIXED" as const, zammadGroupId: "sample-team", zammadOwnerId: "sample-owner" };
    assert.equal(replaceWorkflowHandoffTarget(owned, "FIXED", "ignored").zammadOwnerId, "sample-owner");
    const escalated = replaceWorkflowHandoffTarget(owned, "CLIENT_ESCALATION", "ignored");
    assert.deepEqual(escalated.mainMenuReturn, original.mainMenuReturn);
    assert.equal("zammadOwnerId" in escalated, false);
    assert.equal("zammadGroupId" in escalated, false);
    assert.deepEqual(replaceWorkflowHandoffTarget(escalated, "CLIENT_PRIMARY", "ignored"), original);
  }
  const legacy = { id: "legacy", type: "handoff" as const, target: "CLIENT_PRIMARY" as const, priority: "2 normal" as const };
  assert.equal("mainMenuReturn" in replaceWorkflowHandoffTarget(legacy, "CLIENT_ESCALATION", ""), false);
});

test("workflow RC2 recovery and history preserve optional fields and four declared entry roots", () => {
  const flow = {
    schemaVersion: 1 as const, name: "Synthetic customer care", start: "welcome", maxSteps: 30,
    keepOpenPolicy: { humanReplyPauseMinutes: 120, mainMenu: true, customerResolution: false },
    welcomeResendMinutes: 60, mainMenuNodeId: "menu",
    entryCommands: Array.from({ length: 4 }, (_, index) => ({ id: `entry_${index}`, aliases: [`Topic ${index}`, `موضوع ${index}`], target: `entry_node_${index}`, enabled: false })),
    nodes: [
      { id: "welcome", type: "choice" as const, prompt: "Welcome", options: [{ id: "care", label: "Care", next: "handoff" }] },
      { id: "menu", type: "choice" as const, prompt: "Main menu", options: [{ id: "care", label: "Care", next: "handoff" }] },
      { id: "handoff", type: "handoff" as const, target: "CLIENT_PRIMARY" as const, priority: "2 normal" as const, mainMenuReturn: { label: "القائمة الرئيسية" } },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `entry_node_${index}`, type: "send_text" as const, text: `Topic ${index}`, next: "handoff" })),
    ],
  };
  const recovered = parseWorkflowDraftRecovery(JSON.parse(serializeWorkflowDraftRecovery(flow, { nodePositions: { entry_node_0: { x: 10, y: 20 } } })));
  assert.deepEqual(recovered.definition, flow);
  assert.deepEqual(recovered.presentation.nodePositions, { entry_node_0: { x: 10, y: 20 } });
  const updated = { ...flow, welcomeResendMinutes: null, mainMenuNodeId: null, entryCommands: flow.entryCommands.map(entry => ({ ...entry, enabled: true })) };
  // Keep the former menu reachable through an explicit declaration when switching its setting to default.
  updated.entryCommands.push({ id: "menu_entry", aliases: ["Topics"], target: "menu", enabled: false });
  assert.deepEqual(compareWorkflowDefinitions(flow, updated).settings.map(row => row.field), ["welcomeResendMinutes", "mainMenuNodeId", "entryCommands"]);
  assert.equal(compareWorkflowDefinitions(flow, { ...flow, nodes: [...flow.nodes].reverse() }).summary.changed, 0);
});
