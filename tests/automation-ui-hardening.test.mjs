import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("workflow editing protects recovery drafts and manages operator focus", async () => {
  const [bot, canvas] = await Promise.all([
    read("app/BotAutomation.tsx"),
    read("app/WorkflowCanvas.tsx"),
  ]);

  assert.match(bot, /initialSnapshot: serializeWorkflowDraftRecovery|const initialSnapshot = serializeWorkflowDraftRecovery/u);
  assert.match(bot, /serializedValue === initialSnapshot \? cancel\(\) : setConfirmDiscard\(true\)/u);
  assert.match(bot, /aria-labelledby="bot-discard-draft-title"/u);
  assert.match(bot, /id="bot-flow-editor-title" tabIndex=\{-1\}/u);
  assert.match(bot, /editorReturnFocus\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(bot, /<small aria-hidden="true">/u);
  assert.match(bot, /className="sr-only" role="status" aria-live="polite">\{savedSnapshot === serializedValue \? t\("bot\.editor\.draftSaved"\) : ""\}/u);
  assert.match(canvas, /className="workflow-palette" role="group"/u);
  assert.match(canvas, /change\.dragging !== true/u);
  assert.match(canvas, /onNodeDragStop=\{finishNodeDrag\}/u);
  assert.match(bot, /setPresentation\(\(current\) => \{[\s\S]*\.\.\.current\.nodePositions, \[nodeId\]: position/u);
  assert.match(bot, /scrollIntoView\(\{ behavior: "auto", block: "center" \}\)/u);
  assert.match(bot, /<FlowSimulator key=\{String\(row\.flow_version_id\)\}/u);
  assert.doesNotMatch(bot, /<code>\{node\.id\}<\/code>/u);
  assert.doesNotMatch(bot, /\{nodeTitle\(node\.type, t\)\} · \{node\.id\}/u);
  assert.match(canvas, /ariaLabel: t\("bot\.canvas\.edge", \{ from: stepLabel\(node\.id\), to: stepLabel\(transition\.target\)/u);
});

test("automation validation and assignment blockers stay actionable and field-associated", async () => {
  const bot = await read("app/BotAutomation.tsx");

  assert.match(bot, /aria-errormessage=\{variablesError \? "bot-simulator-variables-error" : undefined\}/u);
  assert.match(bot, /id="bot-simulator-variables-error"[\s\S]*role="alert"/u);
  assert.match(bot, /t\("bot\.simulator\.valuesInvalid"\)/u);
  assert.doesNotMatch(bot, /problem instanceof Error \? problem\.message : t\("bot\.errors\.simulation"\)/u);
  for (const key of ["noConnection", "noActiveFlow", "noSupportTeam"]) {
    assert.match(bot, new RegExp(`t\\("bot\\.assignments\\.${key}"\\)`, "u"));
  }
  assert.match(bot, /disabled=\{saving \|\| Boolean\(assignmentBlocker\)/u);
  const flowEditorValidation = bot.match(/function FlowEditor\([\s\S]*?let error = "";([\s\S]*?)\n {2}\/\/ Functional update/u)?.[1];
  assert.ok(flowEditorValidation, "FlowEditor validation block must be covered");
  assert.match(flowEditorValidation, /operatorFailureMessage\(problem, t\("bot\.errors\.flowInvalid"\)\)/u);
  assert.doesNotMatch(flowEditorValidation, /problem instanceof Error \? problem\.message/u);
  assert.doesNotMatch(bot, /\{String\(row\.current_node_id\)\}/u);
  assert.doesNotMatch(bot, /\{String\(row\.handoff_safe_error\)\}/u);
  assert.doesNotMatch(bot, /row\.action_safe_error \?\?/u);
  assert.doesNotMatch(bot, /\?\.name \?\? String\(row\.zammad_group_id\)/u);
  assert.match(bot, /t\("bot\.conversations\.handoffFailed"\)/u);
  assert.match(bot, /t\("bot\.assignments\.teamUnavailable"\)/u);
  assert.match(bot, /activeExecutionId\.current !== conversationId/u);
  assert.match(bot, /activeExecutionId\.current === conversationId && !isAbortError\(problem\)/u);
  assert.match(bot, /activeExecutionId\.current = ""/u);
  assert.match(bot, /comparisonSettingValue\(setting\.field, setting\.before, beforeDefinition/u);
  assert.doesNotMatch(bot, /<bdi>\{String\(setting\.before\)\}<\/bdi>/u);
  assert.match(bot, /workflowEventLabel\(event\.kind, t\)/u);
  assert.match(bot, /workflowStepLabel\(event\.from, executionDefinition/u);
});

test("routing editor focus and sync errors are operator-safe", async () => {
  const routing = await read("app/ClientRouting.tsx");

  assert.match(routing, /id="routing-editor-title" tabIndex=\{-1\}/u);
  assert.match(routing, /editorReturnFocus\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(routing, /t\("routing\.sources\.syncFailed"\)/u);
  assert.doesNotMatch(routing, /String\(state\.safe_error \?\? state\.latest_job_safe_error\)/u);
  assert.match(routing, /const canonicalRaw = useMemo\(\(\) => JSON\.stringify\(value, null, 2\), \[value\]\)/u);
  assert.match(routing, /const updateValue = \(next: ClientRoutingDefinition\) =>/u);
  assert.match(routing, /rawDraft\.base !== canonicalRaw/u);
  assert.match(routing, /routing\.errors\.rawConflict/u);
  assert.match(routing, /aria-errormessage=\{rawError \? "routing-definition-error" : undefined\}/u);
  assert.match(routing, /window\.addEventListener\("beforeunload", protectDraft\)/u);
  assert.match(routing, /aria-labelledby="routing-discard-title"/u);
  assert.match(routing, /data-modal-initial-focus/u);
  assert.match(routing, /key=\{`\$\{String\(selected\.id\)\}:\$\{String\(selected\.revision\)\}:\$\{String\(selected\.snapshot_sha256\)\}`\}/u);
  assert.match(routing, /onChange=\{invalidateSimulation\}/u);
  assert.match(routing, /activeRequest\.current\?\.abort\(\)/u);
  assert.match(routing, /requestFence\.current\.isCurrent\(request\)/u);
  assert.match(routing, /error\.code === "REAUTHENTICATION_REQUIRED"/u);
  assert.doesNotMatch(routing, /requiresRoutingStepUp|reauthenticate\|أعد التحقق/u);
  assert.match(routing, /<span aria-hidden="true"> · <\/span>[\s\S]*routing\.versions\.createdAt[\s\S]*<bdi>/u);
});

test("new automation hardening copy is complete in English and Arabic", async () => {
  const [english, arabic] = await Promise.all([
    read("lib/i18n/messages/en/automation.ts"),
    read("lib/i18n/messages/ar/automation.ts"),
  ]);
  for (const key of [
    "bot.simulator.valuesInvalid",
    "bot.assignments.noConnection",
    "bot.assignments.noActiveFlow",
    "bot.assignments.noSupportTeam",
    "bot.assignments.teamUnavailable",
    "bot.conversations.handoffFailed",
    "bot.conversations.stepUnavailable",
    "bot.events.actionSucceeded",
    "bot.events.actionFailed",
    "bot.events.actionRetryRequested",
    "bot.events.handoffCompleted",
    "bot.events.unavailable",
    "bot.editor.draftSaved",
    "bot.editor.close",
    "bot.editor.discardTitle",
    "bot.editor.discardHelp",
    "bot.editor.keepEditing",
    "bot.editor.discard",
    "routing.sources.syncFailed",
    "routing.errors.rawConflict",
    "routing.errors.rawUnapplied",
    "routing.editor.discardTitle",
    "routing.editor.discardHelp",
    "routing.editor.keepEditing",
    "routing.editor.discard",
    "routing.versions.createdAt",
  ]) {
    const pattern = new RegExp(`"${key.replaceAll(".", "\\.")}":`, "u");
    assert.match(english, pattern);
    assert.match(arabic, pattern);
  }
});

test("plugin retries preserve the logical operation key", async () => {
  const bot = await read("app/BotAutomation.tsx");

  assert.match(bot, /saveIntent = useRef<\{ fingerprint: string; credentialKey: string; actionKey: string \} \| null>/u);
  assert.match(bot, /"idempotency-key": intent\.credentialKey/u);
  assert.match(bot, /"idempotency-key": intent\.actionKey/u);
  assert.match(bot, /qualificationKey\.current \?\?= crypto\.randomUUID\(\)/u);
  assert.match(bot, /"idempotency-key": qualificationKey\.current/u);
});
