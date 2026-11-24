import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { parseTicketEventFlow, planTicketEvent, selectTicketQuote, TicketCommandAuthorizationError, ticketCommandAllowed, validateTicketEventCapabilities } from "../packages/core/dist/ticket-event-flow.js";
const memberId = "10100000-0000-4000-8000-000000000001";
const base = { schemaVersion: 1, kind: "TICKET_EVENT", name: "Ticket feedback", event: "reference_received", start: "send", maxSteps: 8, nodes: [{ id: "send", type: "send_text", text: "Received {{case.number}}", quote: "ORIGINAL", next: "done" }, { id: "done", type: "end" }] };
const input = { provider: "WAHA" as const, reactions: true, variables: { "event.kind": "reference_received", "provider.kind": "WAHA", "case.number": "42" }, quotes: { original: { messageId: "original", authorized: true }, latest: { messageId: "latest", authorized: true } } };
test("uses shared strict rendering and produces plans without provider effects", () => {
  assert.deepEqual(planTicketEvent(parseTicketEventFlow(base), input).effects, [{ type: "send_text", nodeId: "send", text: "Received 42", replyToMessageId: "original" }]);
  assert.throws(() => planTicketEvent(parseTicketEventFlow(base), { ...input, variables: { "event.kind": "reference_received", "provider.kind": "WAHA" } }), /unavailable/);
});
test("matched-reference reactions target the exact event message and never fall back", () => {
  const flow = parseTicketEventFlow({ ...base, start: "matched", nodes: [
    { id: "matched", type: "condition", variable: "message.matches_reference", operator: "eq", value: true, onTrue: "react", onFalse: "done" },
    { id: "react", type: "reaction", emoji: "⏳", quote: "CURRENT", next: "done" }, { id: "done", type: "end" },
  ] });
  const context = { ...input, variables: { ...input.variables, "message.matches_reference": true }, quotes: { ...input.quotes, current: { messageId: "delayed-current", authorized: true } } };
  assert.deepEqual(planTicketEvent(flow, context).effects, [{ nodeId: "react", type: "reaction", emoji: "⏳", replyToMessageId: "delayed-current" }]);
  assert.equal(selectTicketQuote("CURRENT", { ...context.quotes, explicitRequested: true, explicit: { messageId: "older-quoted-message", authorized: true } }), "delayed-current");
  assert.throws(() => selectTicketQuote("CURRENT", { ...input.quotes, explicitRequested: true, explicit: { messageId: "older-quoted-message", authorized: true } }), /unavailable/);
  assert.deepEqual(planTicketEvent(flow, { ...context, variables: { ...context.variables, "message.matches_reference": false } }).effects, []);
  assert.throws(() => planTicketEvent(flow, { ...context, quotes: input.quotes }), /unavailable/);
  assert.throws(() => planTicketEvent(flow, { ...context, quotes: { current: { messageId: "other", authorized: false } } }), /authorized/);
  for (const event of ["ticket_closed", "quoted_command", "before_agent_reply"]) {
    assert.throws(() => parseTicketEventFlow({ ...base, event, ...(event === "quoted_command" ? { permission: { mode: "AGENTS" }, command: "/close" } : {}), nodes: [
      { id: "send", type: event === "before_agent_reply" ? "format_reply" : "send_text", text: event === "before_agent_reply" ? "{{reply.text}}" : "Closed", quote: "CURRENT", next: "done" }, base.nodes[1],
    ] }), /Current message/);
  }
});
test("rejects cycles, missing/unreachable/duplicate nodes and inadequate bounds", () => {
  assert.throws(() => parseTicketEventFlow({ ...base, nodes: [{ ...base.nodes[0], next: "send" }] }), /acyclic/);
  assert.throws(() => parseTicketEventFlow({ ...base, maxSteps: 1 }), /step bound/);
  assert.throws(() => parseTicketEventFlow({ ...base, nodes: [base.nodes[0]] }), /Missing/);
  assert.throws(() => parseTicketEventFlow({ ...base, nodes: [...base.nodes, base.nodes[1]] }), /Duplicated/);
  assert.throws(() => parseTicketEventFlow({ ...base, nodes: [...base.nodes, { id: "orphan", type: "end" }] }), /Unreachable/);
});
test("fixed variable catalog rejects typos, expressions and event-inappropriate variables", () => {
  for (const text of ["{{unknown}}", "{{reply.text}}", "{{ case.number }}", "{{case.number + 1}}"]) assert.throws(() => parseTicketEventFlow({ ...base, nodes: [{ ...base.nodes[0], text }, base.nodes[1]] }));
  assert.throws(() => planTicketEvent(parseTicketEventFlow(base), { ...input, variables: { ...input.variables, "provider.kind": "META" } }), /identity/);
});
test("explicit optional skip never substitutes a partial message", () => {
  const flow = parseTicketEventFlow({ ...base, nodes: [{ ...base.nodes[0], missingVariable: "SKIP" }, base.nodes[1]] });
  const result = planTicketEvent(flow, { ...input, variables: { "event.kind": "reference_received", "provider.kind": "WAHA" } });
  assert.deepEqual(result.effects, []); assert.deepEqual(result.skippedNodeIds, ["send"]);
});
const reply = { ...base, event: "before_agent_reply", start: "check", nodes: [{ id: "check", type: "condition", variable: "agent.name", operator: "exists", onTrue: "format", onFalse: "done" }, { id: "format", type: "format_reply", text: "{{agent.name}}: {{reply.text}}", quote: "LATEST", next: "done" }, { id: "done", type: "end" }] };
test("reply exception preserves original, other path transforms once with same renderer", () => {
  const flow = parseTicketEventFlow(reply), vars = { "event.kind": "before_agent_reply", "provider.kind": "WAHA", "reply.text": "Hello" };
  const unchanged = planTicketEvent(flow, { ...input, variables: vars });
  assert.equal(unchanged.replyTransformed, false); assert.deepEqual(unchanged.effects, []);
  const changed = planTicketEvent(flow, { ...input, variables: { ...vars, "agent.name": "Mariam" } });
  assert.equal(changed.replyTransformed, true); assert.equal(changed.effects[0]?.type, "format_reply"); assert.equal((changed.effects[0] as { text: string }).text, "Mariam: Hello");
});
test("reply formatting requires one reply.text token and never permits sends or duplicate transformations", () => {
  for (const text of ["Missing reply", "{{reply.text}} {{reply.text}}"] ) assert.throws(() => parseTicketEventFlow({ ...reply, nodes: reply.nodes.map(node => node.id === "format" ? { ...node, text } : node) }), /exactly once/);
  assert.throws(() => parseTicketEventFlow({ ...reply, nodes: reply.nodes.map(node => node.id === "format" ? { ...node, type: "send_text" } : node) }));
  assert.throws(() => parseTicketEventFlow({ ...reply, nodes: [...reply.nodes.map(node => node.id === "format" ? { ...node, next: "format2" } : node), { id: "format2", type: "format_reply", text: "{{reply.text}}", quote: "NONE", next: "done" }] }), /Duplicate/);
});
test("typed conditions reject literal/type mismatches and missing non-exists values", () => {
  const flow = { ...base, start: "check", nodes: [{ id: "check", type: "condition", variable: "message.has_media", operator: "eq", value: true, onTrue: "send", onFalse: "done" }, ...base.nodes] };
  assert.throws(() => parseTicketEventFlow({ ...flow, nodes: [{ ...flow.nodes[0], value: "true" }, ...base.nodes] }), /type mismatch/);
  assert.throws(() => planTicketEvent(parseTicketEventFlow(flow), input), /Condition variable/);
  assert.deepEqual(planTicketEvent(parseTicketEventFlow(flow), { ...input, variables: { ...input.variables, "message.has_media": false } }).effects, []);
});
test("explicit quote overrides all policies, invalid explicit quote never falls back", () => {
  const context = { ...input.quotes, explicitRequested: true, explicit: { messageId: "selected", authorized: true } };
  for (const policy of ["LATEST", "ORIGINAL", "NONE"] as const) assert.equal(selectTicketQuote(policy, context), "selected");
  assert.throws(() => selectTicketQuote("LATEST", { ...context, explicit: undefined }), /fallback prohibited/);
  assert.throws(() => selectTicketQuote("LATEST", { ...context, explicit: { messageId: "other-tenant", authorized: false } }), /authorized/);
  assert.equal(selectTicketQuote("NONE", {}), undefined);
});
test("reaction capability rejects Meta and disabled WAHA at activation and execution", () => {
  const flow = parseTicketEventFlow({ ...base, nodes: [{ id: "send", type: "reaction", emoji: "✅", quote: "ORIGINAL", next: "done" }, base.nodes[1]] });
  assert.throws(() => validateTicketEventCapabilities(flow, "META", true), /capability/);
  assert.throws(() => planTicketEvent(flow, { ...input, reactions: false }), /capability/);
  assert.equal(planTicketEvent(flow, input).effects[0]?.type, "reaction");
  assert.throws(() => parseTicketEventFlow({ ...flow, nodes: flow.nodes.map(node => node.type === "reaction" ? { ...node, emoji: "✅🔥" } : node) }), /reaction/);
});
test("command permissions never bypass source authorization and SPECIFIC binds stable membership IDs", () => {
  assert.equal(ticketCommandAllowed({ mode: "ANYONE" }, { sourceAuthorized: false, activeAgent: true, activeMember: true, memberId }), false);
  assert.equal(ticketCommandAllowed({ mode: "AGENTS" }, { sourceAuthorized: true, activeAgent: true, activeMember: true }), false);
  assert.equal(ticketCommandAllowed({ mode: "AGENTS" }, { sourceAuthorized: true, activeAgent: false, activeMember: true, memberId }), false);
  assert.equal(ticketCommandAllowed({ mode: "ANYONE" }, { sourceAuthorized: "true" as unknown as boolean, activeAgent: true, activeMember: true }), false);
  assert.equal(ticketCommandAllowed({ mode: "SPECIFIC", memberIds: [memberId] }, { sourceAuthorized: true, activeAgent: false, activeMember: true, memberId }), true);
  assert.throws(() => ticketCommandAllowed({ mode: "SPECIFIC", memberIds: ["phone"] }, { sourceAuthorized: true, activeAgent: true, activeMember: true }), /identities/);
});
test("quoted closing is confined to authorized quoted commands", () => {
  const flow = parseTicketEventFlow({ ...base, event: "quoted_command", command: "/close", permission: { mode: "AGENTS" }, nodes: [{ id: "send", type: "close_ticket", next: "done" }, base.nodes[1]] });
  const context = { ...input, variables: { "event.kind": "quoted_command", "provider.kind": "WAHA", "command.text": "/close" }, actor: { sourceAuthorized: true, activeAgent: true, activeMember: true, memberId } };
  assert.throws(() => planTicketEvent(flow, context), /explicit authorized target/);
  assert.deepEqual(planTicketEvent(flow, { ...context, quotes: { explicitRequested: true, explicit: { messageId: "selected", authorized: true } } }).effects, [{ type: "close_ticket", nodeId: "send" }]);
  assert.throws(() => parseTicketEventFlow({ ...base, nodes: [{ id: "send", type: "close_ticket", next: "done" }, base.nodes[1]] }), /quoted commands/);
  assert.throws(() => parseTicketEventFlow({ ...flow, nodes: [{ id: "send", type: "close_ticket", next: "close2" }, { id: "close2", type: "close_ticket", next: "done" }, base.nodes[1]] }), /Duplicate close/);
});
test("AGENTS and SPECIFIC denials retain a typed permanent command classification", () => {
  for (const permission of [{ mode: "AGENTS" }, { mode: "SPECIFIC", memberIds: [memberId] }] as const) {
    const flow = parseTicketEventFlow({ ...base, event: "quoted_command", command: "/close", permission, nodes: [{ id: "send", type: "close_ticket", next: "done" }, base.nodes[1]] });
    assert.throws(() => planTicketEvent(flow, {
      ...input,
      variables: { "event.kind": "quoted_command", "provider.kind": "WAHA", "command.text": "/close" },
      quotes: { explicitRequested: true, explicit: { messageId: "selected", authorized: true } },
      actor: { sourceAuthorized: true, activeAgent: false, activeMember: false, memberId },
    }), error => error instanceof TicketCommandAuthorizationError && error.code === "QUOTED_COMMAND_NOT_AUTHORIZED");
  }
});
test("quoted commands require a bounded configured token and exact full trimmed input", () => {
  const definition = { ...base, event: "quoted_command", permission: { mode: "ANYONE" }, command: "/close" };
  for (const command of [undefined, "close", "/", "/close now", "/close\n", "/" + "a".repeat(33)]) assert.throws(() => parseTicketEventFlow({ ...definition, command }));
  const flow = parseTicketEventFlow(definition);
  const context = { ...input, variables: { "event.kind": "quoted_command", "provider.kind": "WAHA", "command.text": "/close", "case.number": "42" }, quotes: { explicitRequested: true, explicit: { messageId: "selected", authorized: true } }, actor: { sourceAuthorized: true, activeAgent: false, activeMember: false } };
  for (const command of ["hello", "/close now", "/close\nnow", "/Close", ""]) assert.throws(() => planTicketEvent(flow, { ...context, variables: { ...context.variables, "command.text": command } }), /does not match/);
  assert.equal(planTicketEvent(flow, { ...context, variables: { ...context.variables, "command.text": "  /close  " } }).effects.length, 1);
});
test("SPECIFIC policy rejects removed members regardless of agent classification", () => {
  for (const activeAgent of [true, false]) assert.equal(ticketCommandAllowed({ mode: "SPECIFIC", memberIds: [memberId] }, { sourceAuthorized: true, memberId, activeAgent, activeMember: false }), false);
});
test("quote IDs reject control and formatting characters without restricting text line breaks", () => {
  for (const suffix of ["\n", "\r", "\t", "\u0000", "\u0085", "\u200D", "\u202E", "\u2066"]) assert.throws(() => selectTicketQuote("ORIGINAL", { original: { messageId: "message" + suffix, authorized: true } }), /authorized/);
  const flow = parseTicketEventFlow({ ...base, nodes: [{ ...base.nodes[0], text: "Received\n{{case.number}}" }, base.nodes[1]] });
  assert.equal((planTicketEvent(flow, input).effects[0] as { text: string }).text, "Received\n42");
});

test("rendered feedback respects the existing outbox bound of eleven messages", () => {
  const chain = (count: number, prefix = "send", missingVariable = "ERROR") => Array.from({ length: count }, (_, index) => ({
    id: prefix + index, type: "send_text", text: "Received {{case.number}}", quote: "NONE", missingVariable,
    next: index + 1 === count ? "done" : prefix + (index + 1),
  }));
  const make = (count: number) => parseTicketEventFlow({ ...base, start: "send0", maxSteps: 32,
    nodes: [...chain(count), { id: "done", type: "end" }] });
  for (const count of [1, 2, 11]) assert.equal(planTicketEvent(make(count), input).effects.length, count);
  assert.throws(() => planTicketEvent(make(12), input), /11-message limit/);
  const branched = parseTicketEventFlow({ ...base, start: "branch", maxSteps: 32, nodes: [
    { id: "branch", type: "condition", variable: "message.has_media", operator: "eq", value: true, onTrue: "a0", onFalse: "b0" },
    ...chain(11, "a"), ...chain(11, "b"), { id: "done", type: "end" },
  ] });
  for (const hasMedia of [true, false]) assert.equal(planTicketEvent(branched,
    { ...input, variables: { ...input.variables, "message.has_media": hasMedia } }).effects.length, 11,
    "unselected branches do not consume the rendered-effect limit");
  const skipped = parseTicketEventFlow({ ...base, start: "send0", maxSteps: 32,
    nodes: [...chain(12, "send", "SKIP"), { id: "done", type: "end" }] });
  assert.equal(planTicketEvent(skipped, { ...input, variables: { "event.kind": "reference_received", "provider.kind": "WAHA" } }).effects.length, 0,
    "skipped missing-variable messages do not consume the effect limit");
});


test("all reference messages is one configurable closure reaction, never a text quote", () => {
  const definition={...base,event:"ticket_closed",nodes:[
    {id:"send",type:"reaction",emoji:"✅",quote:"REFERENCE_MESSAGES",next:"done"},{id:"done",type:"end"},
  ]};
  const flow=parseTicketEventFlow(definition);
  const plan=planTicketEvent(flow,{...input,variables:{"event.kind":"ticket_closed","provider.kind":"WAHA"}});
  assert.deepEqual(plan.effects,[{type:"reaction",nodeId:"send",emoji:"✅",referenceMessages:true}]);
  for(const event of ["reference_received","quoted_command"]){
    assert.throws(()=>parseTicketEventFlow({...definition,event, ...(event==="quoted_command"?{command:"/close",permission:{mode:"AGENTS"}}:{})}),/closure reactions/);
  }
  assert.throws(()=>parseTicketEventFlow({...definition,nodes:[{...base.nodes[0],quote:"REFERENCE_MESSAGES"},base.nodes[1]]}),/quote policy/);
  assert.throws(()=>planTicketEvent(flow,{...input,provider:"META",variables:{"event.kind":"ticket_closed","provider.kind":"META"}}),/capability/);
});

const parsePortalTsx = async (name: string) => ts.createSourceFile(name, await readFile(new URL(`../app/${name}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test("the saved editor and preview reset together without sharing sibling keys", async () => {
  const workflows = await parsePortalTsx("TicketEventWorkflows.tsx");
  const attribute = (tag: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) =>
    tag.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(workflows) === name);
  const findSavedEditor = (node: ts.Node): ts.JsxSelfClosingElement | undefined => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(workflows) === "TicketEventEditor") {
      const disabled = attribute(node, "disabled");
      if (disabled && !disabled.initializer) return node;
    }
    return ts.forEachChild(node, findSavedEditor);
  };

  const group = findSavedEditor(workflows)?.parent;
  assert.ok(group && ts.isJsxElement(group) && group.openingElement.tagName.getText(workflows) === "Fragment");
  const key = attribute(group.openingElement, "key");
  assert.ok(key?.initializer && ts.isJsxExpression(key.initializer));
  assert.equal(key.initializer.expression?.getText(workflows), "selected");
  const children = group.children.filter(ts.isJsxSelfClosingElement);
  assert.deepEqual(children.map(child => child.tagName.getText(workflows)), ["TicketEventEditor", "TicketEventPreviewPanel"]);
  assert.ok(children.every(child => !attribute(child, "key")));
});

test("the preview renders outside the draft form, so Enter in a preview value cannot save a version", async () => {
  const tags = (file: ts.SourceFile, node: ts.Node, found: string[] = []) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) found.push(node.tagName.getText(file));
    ts.forEachChild(node, child => { tags(file, child, found); });
    return found;
  };
  const component = (file: ts.SourceFile, name: string) => file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const editor = await parsePortalTsx("TicketEventEditor.tsx"), workflows = await parsePortalTsx("TicketEventWorkflows.tsx");
  // Implicit submission only reaches controls the form owns; the editor sits in the draft form, so it must not render the preview.
  assert.deepEqual(tags(editor, component(editor, "TicketEventEditor")).filter(tag => tag.startsWith("TicketEventPreview")), []);
  const findForm = (node: ts.Node): ts.JsxElement | undefined => ts.isJsxElement(node) && node.openingElement.tagName.getText(workflows) === "form" && /onSubmit=\{saveDraft\}/u.test(node.openingElement.getText(workflows)) ? node : ts.forEachChild(node, findForm);
  const draftForm = findForm(workflows);
  assert.ok(draftForm);
  const inside = tags(workflows, draftForm);
  assert.ok(inside.includes("TicketEventEditor"));
  assert.ok(!inside.some(tag => tag.startsWith("TicketEventPreview")));
  assert.ok(tags(workflows, draftForm.parent).includes("TicketEventPreviewPanel"));
  assert.doesNotMatch(component(editor, "TicketEventPreview").getText(editor), /onKeyDown/u);
});
