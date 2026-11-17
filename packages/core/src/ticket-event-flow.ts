import { renderBotTemplate } from "./bot-flow.js";

export const ticketEvents = ["reference_received", "before_agent_reply", "ticket_closed", "quoted_command"] as const;
export type TicketEvent = typeof ticketEvents[number];
export type TicketQuote = "LATEST" | "ORIGINAL" | "CURRENT" | "NONE";
export type TicketCommandPermission = { mode: "AGENTS" } | { mode: "ANYONE" } | { mode: "SPECIFIC"; memberIds: string[] };
type MissingPolicy = "ERROR" | "SKIP";
export type TicketEventNode =
  | { id: string; type: "condition"; variable: string; operator: "exists" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value?: string | boolean | number; onTrue: string; onFalse: string }
  | { id: string; type: "send_text"; text: string; quote: TicketQuote; missingVariable: MissingPolicy; next: string }
  | { id: string; type: "format_reply"; text: string; quote: TicketQuote; next: string }
  | { id: string; type: "reaction"; emoji: string; quote: Exclude<TicketQuote, "NONE"> | "REFERENCE_MESSAGES"; next: string }
  | { id: string; type: "close_ticket"; next: string }
  | { id: string; type: "end" };
export type TicketEventDefinition = { schemaVersion: 1; kind: "TICKET_EVENT"; name: string; event: TicketEvent; start: string; maxSteps: number; nodes: TicketEventNode[]; permission?: TicketCommandPermission; command?: string };
type VariableSpec = "string" | "boolean" | "number" | readonly string[];
const common = { "event.kind": ticketEvents, "provider.kind": ["WAHA", "META"], "group.name": "string", "case.number": "string", "case.reference": "string", "case.state": ["OPEN", "RESOLVED"], "case.transition": ["CREATED", "REOPENED", "APPENDED", "CLOSED"] } as const;
const message = { "message.text": "string", "message.has_media": "boolean", "sender.kind": ["AGENT", "CUSTOMER", "UNKNOWN"] } as const;
export const ticketEventVariables: Readonly<Record<TicketEvent, Readonly<Record<string, VariableSpec>>>> = {
  reference_received: { ...common, ...message, "message.matches_reference": "boolean", "case.previous_state": ["NONE", "OPEN", "RESOLVED"] },
  before_agent_reply: { ...common, "reply.text": "string", "reply.has_attachments": "boolean", "reply.has_explicit_quote": "boolean", "agent.name": "string" },
  ticket_closed: { ...common, "case.closed_at": "string", "case.previous_state": ["OPEN", "RESOLVED"] },
  quoted_command: { ...common, ...message, "command.text": "string" },
};
const idPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const memberPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// Reject control bytes while allowing the tab and line breaks used in message templates.
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const quoteControls = /[\p{Cc}\p{Cf}]/u;
const commandPattern = /^\/[a-z][a-z0-9_-]{0,31}$/iu;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ticket event object required");
  return value as Record<string, unknown>;
}
function fields(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw new Error("Unknown ticket event field");
}
function text(value: unknown, limit = 4096): string {
  if (typeof value !== "string" || value !== value.trim() || !value || [...value].length > limit || controls.test(value)) throw new Error("Invalid ticket event text");
  return value;
}
function id(value: unknown): string {
  const result = text(value, 64);
  if (!idPattern.test(result)) throw new Error("Invalid ticket event node identity");
  return result;
}
function quote(value: unknown, event?: TicketEvent): TicketQuote {
  if (value !== "LATEST" && value !== "ORIGINAL" && value !== "CURRENT" && value !== "NONE") throw new Error("Invalid quote policy");
  if (value === "CURRENT" && event !== undefined && event !== "reference_received") throw new Error("Current message is only available for reference events");
  return value;
}
function missingPolicy(value: unknown): MissingPolicy {
  if (value !== undefined && value !== "ERROR" && value !== "SKIP") throw new Error("Invalid missing-variable policy");
  return value === "SKIP" ? "SKIP" : "ERROR";
}
function matchesType(value: unknown, spec: VariableSpec): boolean {
  return Array.isArray(spec) ? typeof value === "string" && spec.includes(value)
    : typeof value === spec && (spec !== "number" || Number.isFinite(value));
}
function variables(template: string, event: TicketEvent): string[] {
  const keys = [...template.matchAll(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/gu)].map(match => match[1]!);
  if (template.replace(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/gu, "").includes("{{") || template.replace(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/gu, "").includes("}}")) throw new Error("Malformed ticket event variable");
  if (keys.some(key => !Object.hasOwn(ticketEventVariables[event], key))) throw new Error("Unavailable ticket event variable");
  return keys;
}
export function parseTicketCommandPermission(value: unknown): TicketCommandPermission {
  const row = record(value);
  if (row.mode === "AGENTS" || row.mode === "ANYONE") {
    fields(row, ["mode"]);
    return { mode: row.mode };
  }
  fields(row, ["mode", "memberIds"]);
  if (row.mode !== "SPECIFIC" || !Array.isArray(row.memberIds) || row.memberIds.length < 1 || row.memberIds.length > 100 || row.memberIds.some(value => typeof value !== "string" || !memberPattern.test(value)) || new Set(row.memberIds).size !== row.memberIds.length) throw new Error("Invalid specific command identities");
  return { mode: "SPECIFIC", memberIds: [...row.memberIds] as string[] };
}
function edges(node: TicketEventNode): string[] {
  return node.type === "end" ? [] : node.type === "condition" ? [node.onTrue, node.onFalse] : [node.next];
}
export function parseTicketEventFlow(value: unknown): TicketEventDefinition {
  const row = record(value);
  fields(row, ["schemaVersion", "kind", "name", "event", "start", "maxSteps", "nodes", "permission", "command"]);
  if (row.schemaVersion !== 1 || row.kind !== "TICKET_EVENT" || !ticketEvents.includes(row.event as TicketEvent)) throw new Error("Invalid ticket event definition");
  const event = row.event as TicketEvent;
  if (!Number.isInteger(row.maxSteps) || (row.maxSteps as number) < 1 || (row.maxSteps as number) > 32) throw new Error("Invalid ticket event step bound");
  if (!Array.isArray(row.nodes) || row.nodes.length < 1 || row.nodes.length > 100) throw new Error("Invalid ticket event node bound");
  if (event !== "quoted_command" && row.permission !== undefined) throw new Error("Command policy belongs to quoted commands only");
  if (event !== "quoted_command" && row.command !== undefined) throw new Error("Command belongs to quoted commands only");
  const command = event === "quoted_command" ? text(row.command, 33) : undefined;
  if (command !== undefined && !commandPattern.test(command)) throw new Error("Invalid quoted command");
  const nodes = row.nodes.map(value => {
    const node = record(value), nodeId = id(node.id);
    if (node.type === "end") { fields(node, ["id", "type"]); return { id: nodeId, type: "end" } as const; }
    if (node.type === "condition") {
      fields(node, ["id", "type", "variable", "operator", "value", "onTrue", "onFalse"]);
      const variable = text(node.variable, 128), spec = ticketEventVariables[event][variable];
      if (!spec || !["exists", "eq", "ne", "gt", "gte", "lt", "lte"].includes(String(node.operator))) throw new Error("Invalid typed condition");
      if (node.operator === "exists" ? node.value !== undefined : !matchesType(node.value, spec)) throw new Error("Condition value type mismatch");
      if (["gt", "gte", "lt", "lte"].includes(String(node.operator)) && spec !== "number") throw new Error("Numeric condition requires a numeric variable");
      return { id: nodeId, type: "condition", variable, operator: node.operator, ...(node.value === undefined ? {} : { value: node.value }), onTrue: id(node.onTrue), onFalse: id(node.onFalse) } as TicketEventNode;
    }
    if (node.type === "close_ticket") {
      fields(node, ["id", "type", "next"]);
      if (event !== "quoted_command") throw new Error("Closing is only permitted for quoted commands");
      return { id: nodeId, type: "close_ticket", next: id(node.next) } as const;
    }
    if (node.type === "format_reply") {
      fields(node, ["id", "type", "text", "quote", "next"]);
      const template = text(node.text);
      if (event !== "before_agent_reply" || variables(template, event).filter(key => key === "reply.text").length !== 1) throw new Error("Reply formatting requires reply.text exactly once");
      return { id: nodeId, type: "format_reply", text: template, quote: quote(node.quote, event), next: id(node.next) } as const;
    }
    if (event === "before_agent_reply") throw new Error("Reply hook cannot send, react or close");
    if (node.type === "send_text") {
      fields(node, ["id", "type", "text", "quote", "missingVariable", "next"]);
      const template = text(node.text); variables(template, event);
      return { id: nodeId, type: "send_text", text: template, quote: quote(node.quote, event), missingVariable: missingPolicy(node.missingVariable), next: id(node.next) } as const;
    }
    if (node.type === "reaction") {
      fields(node, ["id", "type", "emoji", "quote", "next"]);
      const emoji = text(node.emoji, 16), target = node.quote === "REFERENCE_MESSAGES"
        ? event === "ticket_closed" ? "REFERENCE_MESSAGES" : (() => { throw new Error("All reference messages is only available for closure reactions"); })()
        : quote(node.quote, event);
      if (target === "NONE" || !/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}\p{Emoji_Modifier}]*$/u.test(emoji) || [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(emoji)].length !== 1) throw new Error("Invalid reaction or target policy");
      return { id: nodeId, type: "reaction", emoji, quote: target, next: id(node.next) } as const;
    }
    throw new Error("Unsupported ticket event node");
  });
  const map = new Map(nodes.map(node => [node.id, node]));
  if (map.size !== nodes.length) throw new Error("Duplicated ticket event node");
  const start = id(row.start);
  if (!map.has(start) || nodes.some(node => edges(node).some(edge => !map.has(edge)))) throw new Error("Missing ticket event node");
  const visiting = new Set<string>(), lengths = new Map<string, number>(), counts = new Map<string, number>(), closes = new Map<string, number>();
  function visit(key: string): number {
    if (visiting.has(key)) throw new Error("Ticket event graph must be acyclic");
    if (lengths.has(key)) return lengths.get(key)!;
    visiting.add(key);
    const node = map.get(key)!, next = edges(node);
    const length = 1 + Math.max(0, ...next.map(visit));
    const formats = (node.type === "format_reply" ? 1 : 0) + Math.max(0, ...next.map(key => counts.get(key)!));
    const closeCount = (node.type === "close_ticket" ? 1 : 0) + Math.max(0, ...next.map(key => closes.get(key)!));
    if (formats > 1) throw new Error("Duplicate reply transformation on one path");
    if (closeCount > 1) throw new Error("Duplicate close effect on one path");
    visiting.delete(key); lengths.set(key, length); counts.set(key, formats); closes.set(key, closeCount);
    return length;
  }
  if (visit(start) > (row.maxSteps as number)) throw new Error("Ticket event path exceeds its step bound");
  if (lengths.size !== nodes.length) throw new Error("Unreachable ticket event node");
  return { schemaVersion: 1, kind: "TICKET_EVENT", name: text(row.name, 160), event, start, maxSteps: row.maxSteps as number, nodes, ...(event === "quoted_command" ? { permission: parseTicketCommandPermission(row.permission), command } : {}) };
}

// The caller must resolve these targets through the existing tenant/group/case/privacy boundary.
export type TicketQuoteTarget = { messageId: string; authorized: boolean };
export type TicketQuoteContext = { explicitRequested?: boolean; explicit?: TicketQuoteTarget; latest?: TicketQuoteTarget; original?: TicketQuoteTarget; current?: TicketQuoteTarget };
export function selectTicketQuote(policy: TicketQuote, context: TicketQuoteContext): string | undefined {
  quote(policy);
  const candidate = policy === "CURRENT" ? context.current : context.explicitRequested ? context.explicit : policy === "LATEST" ? context.latest : policy === "ORIGINAL" ? context.original : undefined;
  if (policy !== "CURRENT" && context.explicitRequested && !candidate) throw new Error("Explicit quote is unavailable; fallback prohibited");
  if (candidate && (candidate.authorized !== true || typeof candidate.messageId !== "string" || !candidate.messageId || candidate.messageId.length > 512 || quoteControls.test(candidate.messageId))) throw new Error("Quote target is not authorized");
  if (policy !== "NONE" && !candidate) throw new Error("Quote target is unavailable");
  return candidate?.messageId;
}
export function ticketCommandAllowed(policy: TicketCommandPermission, actor: { sourceAuthorized: boolean; activeAgent: boolean; activeMember: boolean; memberId?: string }): boolean {
  const checked = parseTicketCommandPermission(policy);
  if (actor.sourceAuthorized !== true) return false;
  if (checked.mode === "ANYONE") return true;
  if (!actor.memberId || !memberPattern.test(actor.memberId)) return false;
  return checked.mode === "AGENTS" ? actor.activeAgent === true : actor.activeMember === true && checked.memberIds.includes(actor.memberId);
}
export class TicketCommandAuthorizationError extends Error {
  readonly code = "QUOTED_COMMAND_NOT_AUTHORIZED";
  constructor() { super("Quoted command is not authorized"); this.name = "TicketCommandAuthorizationError"; }
}
export type TicketEventEffect = { nodeId: string; type: "send_text" | "format_reply"; text: string; replyToMessageId?: string } | { nodeId: string; type: "reaction"; emoji: string; replyToMessageId?: string; referenceMessages?: true } | { nodeId: string; type: "close_ticket" };
export function validateTicketEventCapabilities(flow: TicketEventDefinition, provider: "WAHA" | "META", reactions: boolean) {
  if (parseTicketEventFlow(flow).nodes.some(node => node.type === "reaction") && (provider !== "WAHA" || !reactions)) throw new Error("Reaction capability is unavailable");
}
export function planTicketEvent(flow: TicketEventDefinition, input: { provider: "WAHA" | "META"; reactions: boolean; variables: Record<string, string | boolean | number | undefined>; quotes: TicketQuoteContext; actor?: Parameters<typeof ticketCommandAllowed>[1] }) {
  const definition = parseTicketEventFlow(flow);
  validateTicketEventCapabilities(definition, input.provider, input.reactions);
  for (const [key, value] of Object.entries(input.variables)) {
    const spec = ticketEventVariables[definition.event][key];
    if (!spec || (value !== undefined && (!matchesType(value, spec) || (typeof value === "string" && (value.length > 65536 || controls.test(value)))))) throw new Error("Invalid event variable value");
  }
  if (input.variables["event.kind"] !== definition.event || input.variables["provider.kind"] !== input.provider) throw new Error("Event identity mismatch");
  if (definition.event === "quoted_command" && (!input.actor || !ticketCommandAllowed(definition.permission!, input.actor))) throw new TicketCommandAuthorizationError();
  if (definition.event === "quoted_command") {
    if (typeof input.variables["command.text"] !== "string" || input.variables["command.text"].trim() !== definition.command) throw new Error("Quoted command text does not match the configured command");
    if (!input.quotes.explicitRequested) throw new Error("Quoted command requires an explicit authorized target");
    selectTicketQuote("ORIGINAL", input.quotes);
  }
  const effects: TicketEventEffect[] = [], skippedNodeIds: string[] = [], map = new Map(definition.nodes.map(node => [node.id, node]));
  let current = definition.start;
  for (let step = 1; step <= definition.maxSteps; step++) {
    const node = map.get(current)!;
    if (node.type === "end") {
      // Match the existing outbox batch bound on this rendered path only.
      if (effects.filter(effect => effect.type === "send_text" || effect.type === "reaction").length > 11)
        throw new Error("Ticket event feedback exceeds the 11-message limit");
      return { effects, skippedNodeIds, steps: step, replyTransformed: effects.some(effect => effect.type === "format_reply") };
    }
    if (node.type === "condition") {
      const actual = input.variables[node.variable];
      if (node.operator !== "exists" && actual === undefined) throw new Error("Condition variable is unavailable");
      const yes = node.operator === "exists" ? actual !== undefined : node.operator === "eq" ? actual === node.value : node.operator === "ne" ? actual !== node.value : node.operator === "gt" ? (actual as number) > (node.value as number) : node.operator === "gte" ? (actual as number) >= (node.value as number) : node.operator === "lt" ? (actual as number) < (node.value as number) : (actual as number) <= (node.value as number);
      current = yes ? node.onTrue : node.onFalse;
      continue;
    }
    if (node.type === "close_ticket") effects.push({ type: node.type, nodeId: node.id });
    else {
      const missing = (node.type === "reaction" ? [] : variables(node.text, definition.event)).some(key => input.variables[key] === undefined);
      if (missing && node.type === "send_text" && node.missingVariable === "SKIP") { skippedNodeIds.push(node.id); current = node.next; continue; }
      if (missing) throw new Error("Template variable is unavailable");
      if (node.quote === "REFERENCE_MESSAGES") {
        effects.push({ type: node.type, nodeId: node.id, emoji: node.emoji, referenceMessages: true });
        current = node.next;
        continue;
      }
      const replyToMessageId = selectTicketQuote(node.quote, input.quotes);
      if (node.type === "reaction") effects.push({ type: node.type, nodeId: node.id, emoji: node.emoji, replyToMessageId: replyToMessageId! });
      else {
        const rendered = renderBotTemplate(node.text, Object.fromEntries(Object.entries(input.variables).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])));
        if (!rendered || [...rendered].length > 4096) throw new Error("Rendered event text is invalid");
        effects.push({ type: node.type, nodeId: node.id, text: rendered, ...(replyToMessageId ? { replyToMessageId } : {}) });
      }
    }
    current = node.next;
  }
  throw new Error("Ticket event step bound exceeded");
}
