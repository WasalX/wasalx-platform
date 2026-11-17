"use client";

import "./TicketEventEditor.css";

import { useId, useRef, useState } from "react";
import {
  parseTicketEventFlow, planTicketEvent, ticketEvents, ticketEventVariables,
  type TicketEvent, type TicketEventDefinition, type TicketEventNode, type TicketQuote,
} from "../packages/core/src/ticket-event-flow.ts";
import { useI18n } from "./I18nProvider.tsx";

type Translate = ReturnType<typeof useI18n>["t"];
type NodeType = TicketEventNode["type"];
type Condition = Extract<TicketEventNode, { type: "condition" }>;
type VariableSpec = (typeof ticketEventVariables)[TicketEvent][string];
type MemberOption = { id: string; label: string };
type Props = {
  definition: TicketEventDefinition;
  onChange: (definition: TicketEventDefinition) => void;
  disabled?: boolean;
  memberOptions?: readonly MemberOption[];
};
const sampleMember = "00000000-0000-4000-8000-000000000001";
const targets = (node: TicketEventNode): string[] => node.type === "condition"
  ? [node.onTrue, node.onFalse] : node.type === "end" ? [] : [node.next];
const actionTypes = (event: TicketEvent): NodeType[] => event === "before_agent_reply"
  ? ["condition", "format_reply", "end"]
  : ["condition", "send_text", "reaction", ...(event === "quoted_command" ? ["close_ticket" as const] : []), "end"];
const variableDefault = (spec: VariableSpec): string | boolean | number =>
  typeof spec !== "string" ? spec[0] ?? "" : spec === "boolean" ? false : spec === "number" ? 0 : "";

function reroute(node: TicketEventNode, from: string, to: string): TicketEventNode {
  if (node.type === "condition") return { ...node, onTrue: node.onTrue === from ? to : node.onTrue, onFalse: node.onFalse === from ? to : node.onFalse };
  return node.type === "end" ? node : { ...node, next: node.next === from ? to : node.next };
}

function newNode(type: NodeType, id: string, next: string, event: TicketEvent, t: Translate): TicketEventNode {
  if (type === "end") return { id, type };
  if (type === "condition") return { id, type, variable: "case.state", operator: "eq", value: "OPEN", onTrue: next, onFalse: next };
  if (type === "reaction") return { id, type, emoji: "✅", quote: "ORIGINAL", next };
  if (type === "close_ticket") return { id, type, next };
  if (type === "format_reply") return { id, type, text: t("ticketEvent.template.reply"), quote: "ORIGINAL", next };
  return { id, type, text: t(event === "ticket_closed" ? "ticketEvent.template.closed" : "ticketEvent.template.reference"), quote: "ORIGINAL", missingVariable: "ERROR", next };
}

/** Pure starters; applying one replaces only the controlled, unsaved definition. */
export function ticketEventStarter(event: TicketEvent, t: Translate): TicketEventDefinition {
  const finish: TicketEventNode = { id: "finish", type: "end" };
  const base = { schemaVersion: 1 as const, kind: "TICKET_EVENT" as const, name: t(`ticketEvent.event.${event}`), event, maxSteps: 16 };
  if (event === "before_agent_reply") return { ...base, start: "attachments", nodes: [
    { id: "attachments", type: "condition", variable: "reply.has_attachments", operator: "eq", value: true, onTrue: "finish", onFalse: "format" },
    newNode("format_reply", "format", "finish", event, t), finish,
  ] };
  if (event === "quoted_command") return { ...base, command: "/close", permission: { mode: "AGENTS" }, start: "close", nodes: [
    { id: "close", type: "close_ticket", next: "finish" }, finish,
  ] };
  return { ...base, start: "message", nodes: [newNode("send_text", "message", "finish", event, t), finish] };
}

function TypedValue({ id, label, spec, value, onChange }: {
  id: string; label: string; spec: VariableSpec; value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const { t } = useI18n();
  return <label htmlFor={id}>{label}{typeof spec !== "string" || spec === "boolean"
    ? <select id={id} name={id} value={String(value)} onChange={event => onChange(spec === "boolean" ? event.target.value === "true" : event.target.value)}>
      {(typeof spec !== "string" ? spec : ["false", "true"]).map(option => <option key={option} value={option}>{t(`ticketEvent.value.${option}`)}</option>)}
    </select>
    : <input id={id} name={id} type={spec === "number" ? "number" : "text"} step={spec === "number" ? "any" : undefined} dir="auto" value={String(value)} onChange={event => onChange(spec === "number" ? event.target.valueAsNumber : event.target.value)} />}
  </label>;
}

function TemplateField({ node, event, id, replace }: {
  node: Extract<TicketEventNode, { type: "send_text" | "format_reply" }>;
  event: TicketEvent; id: string; replace: (node: TicketEventNode) => void;
}) {
  const { t } = useI18n();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [variable, setVariable] = useState("case.number");
  const keys = Object.keys(ticketEventVariables[event]);
  const selected = keys.includes(variable) ? variable : keys[0]!;
  function insert() {
    const element = textarea.current;
    const start = element?.selectionStart ?? node.text.length, end = element?.selectionEnd ?? start;
    const token = `{{${selected}}}`;
    replace({ ...node, text: node.text.slice(0, start) + token + node.text.slice(end) });
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  }
  return <div className="bot-form-wide ticket-event-stack">
    <label htmlFor={`${id}-text`}>{t("ticketEvent.text")}
      <textarea ref={textarea} id={`${id}-text`} name={`${id}-text`} dir="auto" value={node.text} required aria-describedby={node.type === "format_reply" ? `${id}-template-help` : undefined} onChange={event => replace({ ...node, text: event.target.value })} />
    </label>
    {node.type === "format_reply" ? <small id={`${id}-template-help`}>{t("ticketEvent.replyHelp")}</small> : null}
    <div className="ticket-event-inline">
      <label htmlFor={`${id}-variable`}>{t("ticketEvent.insertVariable")}
        <select id={`${id}-variable`} name={`${id}-variable`} value={selected} onChange={event => setVariable(event.target.value)}>
          {keys.map(key => <option key={key} value={key}>{t(`ticketEvent.variable.${key}`)}</option>)}
        </select>
      </label>
      <button className="button secondary" type="button" onClick={insert}>{t("ticketEvent.insert")}</button>
    </div>
  </div>;
}

export function TicketEventEditor({ definition, onChange, disabled = false, memberOptions = [] }: Props) {
  const { t, direction } = useI18n();
  const id = useId();
  const [starter, setStarter] = useState<TicketEvent>(definition.event);
  const [newType, setNewType] = useState<NodeType>("condition");
  const [insertAt, setInsertAt] = useState(definition.start);
  const [checked, setChecked] = useState(false);
  const available = actionTypes(definition.event);
  const selectedType = available.includes(newType) ? newType : available[0]!;
  const insertionTarget = definition.nodes.some(node => node.id === insertAt) ? insertAt : definition.start;
  const vars = ticketEventVariables[definition.event];
  const stepLabel = (key: string) => {
    const index = definition.nodes.findIndex(node => node.id === key), node = definition.nodes[index];
    return node ? t("ticketEvent.stepLabel", { number: index + 1, type: t(`ticketEvent.node.${node.type}`) }) : t("ticketEvent.missingStep");
  };
  const change = (next: TicketEventDefinition) => { setChecked(false); onChange(next); };
  const replace = (node: TicketEventNode) => change({ ...definition, nodes: definition.nodes.map(item => item.id === node.id ? node : item) });
  const permission = definition.permission;
  const missingMembers = definition.event === "quoted_command" && permission?.mode === "SPECIFIC"
    && (!memberOptions.length || permission.memberIds.some(member => !memberOptions.some(option => option.id === member)));
  let valid = false;
  try { parseTicketEventFlow(definition); valid = !missingMembers; } catch { /* Validation is announced only on request. */ }
  function insertNode() {
    let number = 1;
    while (definition.nodes.some(node => node.id === `step_${number}`)) number += 1;
    const key = `step_${number}`;
    // End nodes have no output: append one for an explicit branch target, without silently dropping a path.
    const terminal = selectedType === "end";
    const node = newNode(selectedType, key, insertionTarget, definition.event, t);
    const nodes = definition.nodes.map(item => terminal ? item : reroute(item, insertionTarget, key));
    const index = nodes.findIndex(item => item.id === insertionTarget);
    nodes.splice(terminal ? nodes.length : Math.max(index, 0), 0, node);
    change({ ...definition, start: !terminal && definition.start === insertionTarget ? key : definition.start, nodes });
  }
  function edgeSelect(node: TicketEventNode, field: "next" | "onTrue" | "onFalse", target: string, label: string) {
    return <label htmlFor={`${id}-${node.id}-${field}`}>{label}
      <select id={`${id}-${node.id}-${field}`} name={`${id}-${node.id}-${field}`} value={target} onChange={event => replace({ ...node, [field]: event.target.value } as TicketEventNode)}>
        {!definition.nodes.some(item => item.id === target) ? <option value={target}>{t("ticketEvent.missingStep")}</option> : null}
        {definition.nodes.filter(item => item.id !== node.id).map(item => <option key={item.id} value={item.id}>{stepLabel(item.id)}</option>)}
      </select>
    </label>;
  }
  return <section className="ticket-event-editor bot-flow-editor bot-editor-layout" dir={direction} aria-label={t("ticketEvent.title")}>
    <fieldset className="bot-flow-settings" disabled={disabled}>
      <legend>{t("ticketEvent.settings")}</legend>
      <div className="bot-form-grid">
        <label htmlFor={`${id}-name`}>{t("ticketEvent.name")}<input id={`${id}-name`} name={`${id}-name`} required maxLength={160} dir="auto" value={definition.name} onChange={event => change({ ...definition, name: event.target.value })} /></label>
        <label htmlFor={`${id}-max`}>{t("ticketEvent.maxSteps")}<input id={`${id}-max`} name={`${id}-max`} type="number" min={1} max={32} step={1} value={Number.isFinite(definition.maxSteps) ? definition.maxSteps : ""} onChange={event => change({ ...definition, maxSteps: event.target.valueAsNumber })} /></label>
        <label htmlFor={`${id}-start`}>{t("ticketEvent.start")}<select id={`${id}-start`} name={`${id}-start`} value={definition.start} onChange={event => change({ ...definition, start: event.target.value })}>{definition.nodes.map(node => <option key={node.id} value={node.id}>{stepLabel(node.id)}</option>)}</select></label>
        <p className="bot-node-note">{t("ticketEvent.currentEvent", { event: t(`ticketEvent.event.${definition.event}`) })}</p>
        <div className="bot-form-wide ticket-event-inline">
          <label htmlFor={`${id}-starter`}>{t("ticketEvent.starter")}<select id={`${id}-starter`} name={`${id}-starter`} value={starter} onChange={event => setStarter(event.target.value as TicketEvent)}>{ticketEvents.map(event => <option key={event} value={event}>{t(`ticketEvent.event.${event}`)}</option>)}</select></label>
          <button type="button" className="button secondary" aria-describedby={`${id}-starter-help`} onClick={() => change(ticketEventStarter(starter, t))}>{t("ticketEvent.applyStarter")}</button>
        </div>
        <p className="bot-node-note" id={`${id}-starter-help`}>{t("ticketEvent.starterHelp")}</p>
      </div>
    </fieldset>
    {definition.event === "quoted_command" ? <fieldset className="bot-flow-settings" disabled={disabled}>
      <legend>{t("ticketEvent.commandPolicy")}</legend>
      <div className="bot-form-grid">
        <label htmlFor={`${id}-command`}>{t("ticketEvent.command")}<input id={`${id}-command`} name={`${id}-command`} value={definition.command ?? ""} dir="ltr" required maxLength={33} pattern="/[a-zA-Z][a-zA-Z0-9_-]{0,31}" autoCapitalize="none" spellCheck={false} onChange={event => change({ ...definition, command: event.target.value })} aria-describedby={`${id}-command-help`} /></label>
        <label htmlFor={`${id}-permission`}>{t("ticketEvent.permission")}<select id={`${id}-permission`} name={`${id}-permission`} value={permission?.mode ?? "AGENTS"} onChange={event => change({ ...definition, permission: event.target.value === "SPECIFIC" ? { mode: "SPECIFIC", memberIds: [] } : { mode: event.target.value as "AGENTS" | "ANYONE" } })}>{["AGENTS", "SPECIFIC", "ANYONE"].map(mode => <option key={mode} value={mode}>{t(`ticketEvent.permission.${mode}`)}</option>)}</select></label>
        <p className="bot-node-note" id={`${id}-command-help`}>{t("ticketEvent.commandHelp")}</p>
        {permission?.mode === "SPECIFIC" ? <fieldset className="bot-choice-editor"><legend>{t("ticketEvent.members")}</legend>
          {memberOptions.map(member => <label className="ticket-event-check" key={member.id}><input type="checkbox" name={`${id}-members`} value={member.id} checked={permission.memberIds.includes(member.id)} onChange={event => change({ ...definition, permission: { mode: "SPECIFIC", memberIds: event.target.checked ? [...permission.memberIds, member.id] : permission.memberIds.filter(value => value !== member.id) } })} /><span>{member.label}</span></label>)}
          {missingMembers || !permission.memberIds.length ? <p className="bot-node-note">{t(missingMembers ? "ticketEvent.membersUnavailable" : "ticketEvent.membersRequired")}</p> : null}
        </fieldset> : null}
      </div>
    </fieldset> : null}
    <section className="bot-node-editor" aria-labelledby={`${id}-steps`}>
      <div className="bot-section-head"><div><h3 id={`${id}-steps`}>{t("ticketEvent.steps")}</h3><p>{t("ticketEvent.stepsHelp")}</p></div></div>
      <ol>{definition.nodes.map(node => {
        const nodeId = `${id}-${node.id}`;
        const canRemove = node.id !== definition.start && !definition.nodes.some(item => item.id !== node.id && targets(item).includes(node.id));
        return <li key={node.id}><fieldset className="bot-node-card" disabled={disabled}><legend>{stepLabel(node.id)}{node.id === definition.start ? <span className="tag">{t("bot.node.first")}</span> : null}</legend>
          <div className="bot-node-fields">
            {node.type === "condition" ? <>
              <label htmlFor={`${nodeId}-condition`}>{t("ticketEvent.conditionVariable")}<select id={`${nodeId}-condition`} name={`${nodeId}-condition`} value={node.variable} onChange={event => replace({ ...node, variable: event.target.value, operator: "eq", value: variableDefault(vars[event.target.value]!) })}>{Object.keys(vars).map(key => <option key={key} value={key}>{t(`ticketEvent.variable.${key}`)}</option>)}</select></label>
              <label htmlFor={`${nodeId}-operator`}>{t("ticketEvent.operator")}<select id={`${nodeId}-operator`} name={`${nodeId}-operator`} value={node.operator} onChange={event => { const operator = event.target.value as Condition["operator"]; replace({ id: node.id, type: "condition", variable: node.variable, onTrue: node.onTrue, onFalse: node.onFalse, operator, ...(operator === "exists" ? {} : { value: variableDefault(vars[node.variable] ?? "string") }) }); }}>{["exists", "eq", "ne", ...(vars[node.variable] === "number" ? ["gt", "gte", "lt", "lte"] : [])].map(operator => <option key={operator} value={operator}>{t(`ticketEvent.operator.${operator}`)}</option>)}</select></label>
              {node.operator !== "exists" ? <TypedValue id={`${nodeId}-value`} label={t("ticketEvent.value")} spec={vars[node.variable] ?? "string"} value={node.value ?? variableDefault(vars[node.variable] ?? "string")} onChange={value => replace({ ...node, value })} /> : null}
              {edgeSelect(node, "onTrue", node.onTrue, t("ticketEvent.onTrue"))}
              {edgeSelect(node, "onFalse", node.onFalse, t("ticketEvent.onFalse"))}
            </> : null}
            {node.type === "send_text" || node.type === "format_reply" ? <TemplateField node={node} event={definition.event} id={nodeId} replace={replace} /> : null}
            {node.type === "reaction" ? <label htmlFor={`${nodeId}-emoji`}>{t("ticketEvent.emoji")}<input id={`${nodeId}-emoji`} name={`${nodeId}-emoji`} dir="auto" required value={node.emoji} onChange={event => replace({ ...node, emoji: event.target.value })} aria-describedby={`${nodeId}-reaction-help`} /><small id={`${nodeId}-reaction-help`}>{t("ticketEvent.reactionHelp")}</small></label> : null}
            {"quote" in node ? <label htmlFor={`${nodeId}-quote`}>{t("ticketEvent.quote")}<select id={`${nodeId}-quote`} name={`${nodeId}-quote`} value={node.quote} onChange={event => replace({ ...node, quote: event.target.value as TicketQuote } as TicketEventNode)}>{["LATEST", "ORIGINAL", ...(definition.event === "reference_received" ? ["CURRENT"] : []), ...(node.type === "reaction" && definition.event === "ticket_closed" ? ["REFERENCE_MESSAGES"] : []), ...(node.type === "reaction" ? [] : ["NONE"])].map(quote => <option key={quote} value={quote}>{t(`ticketEvent.quote.${quote}`)}</option>)}</select><small>{t(node.type === "reaction" && node.quote === "REFERENCE_MESSAGES" ? "ticketEvent.referenceMessagesHelp" : "ticketEvent.quoteHelp")}</small></label> : null}
            {node.type === "send_text" ? <label htmlFor={`${nodeId}-missing`}>{t("ticketEvent.missingVariable")}<select id={`${nodeId}-missing`} name={`${nodeId}-missing`} value={node.missingVariable} onChange={event => replace({ ...node, missingVariable: event.target.value as "ERROR" | "SKIP" })}>{["ERROR", "SKIP"].map(policy => <option key={policy} value={policy}>{t(`ticketEvent.missing.${policy}`)}</option>)}</select></label> : null}
            {node.type !== "condition" && node.type !== "end" ? edgeSelect(node, "next", node.next, t("ticketEvent.next")) : null}
            {node.type === "end" || node.type === "close_ticket" ? <p className="bot-node-note">{t(node.type === "end" ? "ticketEvent.endHelp" : "ticketEvent.closeHelp")}</p> : null}
            <div className="bot-form-wide"><button type="button" className="button secondary" disabled={!canRemove} aria-describedby={`${nodeId}-remove-help`} onClick={() => change({ ...definition, nodes: definition.nodes.filter(item => item.id !== node.id) })}>{t("ticketEvent.remove")}</button><p id={`${nodeId}-remove-help`} className="ticket-event-help">{t("ticketEvent.removeHelp")}</p></div>
          </div>
        </fieldset></li>;
      })}</ol>
      <fieldset className="bot-add-step" disabled={disabled || definition.nodes.length >= 100}><legend>{t("ticketEvent.addStep")}</legend>
        <label htmlFor={`${id}-new-type`}>{t("ticketEvent.stepType")}<select id={`${id}-new-type`} name={`${id}-new-type`} value={selectedType} onChange={event => setNewType(event.target.value as NodeType)}>{available.map(type => <option key={type} value={type}>{t(`ticketEvent.node.${type}`)}</option>)}</select></label>
        {selectedType !== "end" ? <label htmlFor={`${id}-insert`}>{t("ticketEvent.insertBefore")}<select id={`${id}-insert`} name={`${id}-insert`} value={insertionTarget} onChange={event => setInsertAt(event.target.value)}>{definition.nodes.map(node => <option key={node.id} value={node.id}>{stepLabel(node.id)}</option>)}</select></label> : null}
        <button type="button" className="button secondary" onClick={insertNode}>{t("ticketEvent.addStep")}</button>
      </fieldset>
      <p className="ticket-event-help">{t("ticketEvent.addHelp")}</p>
    </section>
    <div className="ticket-event-stack"><button type="button" className="button secondary" onClick={() => setChecked(true)}>{t("ticketEvent.check")}</button>{checked ? <p role="status" className={valid ? "settings-feedback success" : "settings-feedback error"}>{t(valid ? "ticketEvent.valid" : missingMembers ? "ticketEvent.membersUnavailable" : "ticketEvent.invalid")}</p> : null}</div>
    <TicketEventPreview key={definition.event} definition={definition} memberOptions={memberOptions} />
  </section>;
}

function TicketEventPreview({ definition, memberOptions }: Pick<Props, "definition" | "memberOptions">) {
  const { t } = useI18n();
  const id = useId();
  const [provider, setProvider] = useState<"WAHA" | "META">("WAHA");
  const [reactions, setReactions] = useState(true);
  const [shown, setShown] = useState(false);
  const [values, setValues] = useState<Record<string, string | number | boolean | undefined>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [latest, setLatest] = useState(true), [original, setOriginal] = useState(true);
  const [current, setCurrent] = useState(true);
  const [explicit, setExplicit] = useState(definition.event === "quoted_command"), [authorized, setAuthorized] = useState(true);
  const [actor, setActor] = useState(sampleMember);
  const [agent, setAgent] = useState(true), [activeMember, setActiveMember] = useState(true), [sourceAuthorized, setSourceAuthorized] = useState(true);
  const catalog = ticketEventVariables[definition.event];
  const variables = Object.fromEntries(Object.entries(catalog).map(([key, spec]) => {
    const fallback = key === "event.kind" ? definition.event : key === "provider.kind" ? provider : key === "command.text" ? definition.command ?? "" : key === "case.number" ? "50001" : key === "case.reference" ? "REF-50001" : key === "reply.text" || key === "message.text" ? t("ticketEvent.preview.sampleText") : key === "group.name" ? t("ticketEvent.preview.sampleGroup") : key === "agent.name" ? t("ticketEvent.preview.sampleAgent") : key === "case.closed_at" ? "2026-10-05T12:00:00Z" : variableDefault(spec);
    return [key, missing.includes(key) ? undefined : values[key] ?? fallback];
  }));
  variables["event.kind"] = definition.event;
  variables["provider.kind"] = provider;
  if (Object.hasOwn(catalog, "reply.has_explicit_quote")) variables["reply.has_explicit_quote"] = explicit;
  let plan: ReturnType<typeof planTicketEvent> | undefined;
  let error = false;
  if (shown) try {
    plan = planTicketEvent(definition, { provider, reactions, variables, quotes: {
      ...(latest ? { latest: { messageId: "preview-latest", authorized } } : {}),
      ...(original ? { original: { messageId: "preview-original", authorized } } : {}),
      ...(definition.event === "reference_received" && current ? { current: { messageId: "preview-current", authorized } } : {}),
      explicitRequested: explicit,
      ...(explicit ? { explicit: { messageId: "preview-explicit", authorized } } : {}),
    }, actor: { memberId: actor, activeAgent: agent, activeMember, sourceAuthorized } });
  } catch { error = true; }
  const checks: [string, boolean, (value: boolean) => void][] = [
    ["reactions", reactions, setReactions], ["latest", latest, setLatest], ["original", original, setOriginal], ["explicit", explicit, setExplicit], ["authorized", authorized, setAuthorized],
    ...(definition.event === "reference_received" ? [["current", current, setCurrent]] as [string, boolean, (value: boolean) => void][] : []),
    ...(definition.event === "quoted_command" ? [["sourceAuthorized", sourceAuthorized, setSourceAuthorized], ["agent", agent, setAgent], ["activeMember", activeMember, setActiveMember]] as [string, boolean, (value: boolean) => void][] : []),
  ];
  // The preview sits inside the draft form; Enter in a preview value must not save a new version.
  // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- delegated guard for the inputs inside, not an interaction on the section
  return <section className="bot-simulator ticket-event-stack" aria-labelledby={`${id}-title`} onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <div className="bot-section-head"><div><h3 id={`${id}-title`}>{t("ticketEvent.preview.title")}</h3><p>{t("ticketEvent.preview.help")}</p></div></div>
    <fieldset className="bot-flow-settings"><legend>{t("ticketEvent.preview.context")}</legend><div className="bot-form-grid">
      <label htmlFor={`${id}-provider`}>{t("ticketEvent.preview.provider")}<select id={`${id}-provider`} name={`${id}-provider`} value={provider} onChange={event => setProvider(event.target.value as "WAHA" | "META")}><option value="WAHA">{t("ticketEvent.value.WAHA")}</option><option value="META">{t("ticketEvent.value.META")}</option></select></label>
      {definition.event === "quoted_command" ? <label htmlFor={`${id}-actor`}>{t("ticketEvent.preview.actor")}<select id={`${id}-actor`} name={`${id}-actor`} value={actor} onChange={event => setActor(event.target.value)}><option value={sampleMember}>{t("ticketEvent.preview.sampleAgent")}</option>{memberOptions?.map(member => <option key={member.id} value={member.id}>{member.label}</option>)}</select></label> : null}
      {checks.map(([key, checked, setChecked]) => <label className="ticket-event-check" key={key}><input type="checkbox" name={`${id}-${key}`} checked={checked} onChange={event => setChecked(event.target.checked)} /><span>{t(`ticketEvent.preview.${key}`)}</span></label>)}
    </div></fieldset>
    <details><summary>{t("ticketEvent.preview.variables")}</summary><div className="ticket-event-stack">
      {Object.entries(catalog).filter(([key]) => key !== "event.kind" && key !== "provider.kind" && key !== "reply.has_explicit_quote").map(([key, spec]) => <fieldset className="bot-node-card" key={key}><legend>{t(`ticketEvent.variable.${key}`)}</legend><div className="bot-node-fields">
        <label className="ticket-event-check"><input type="checkbox" name={`${id}-${key}-available`} checked={!missing.includes(key)} onChange={event => setMissing(event.target.checked ? missing.filter(item => item !== key) : [...missing, key])} /><span>{t("ticketEvent.preview.available")}</span></label>
        {!missing.includes(key) ? <TypedValue id={`${id}-${key}`} label={t("ticketEvent.preview.value")} spec={spec} value={variables[key] ?? variableDefault(spec)} onChange={value => setValues({ ...values, [key]: value })} /> : null}
      </div></fieldset>)}
    </div></details>
    <button type="button" className="button secondary" onClick={() => setShown(true)}>{t("ticketEvent.preview.run")}</button>
    {shown ? <div role="status" aria-live="polite" className="ticket-event-stack">
      {error ? <p className="settings-feedback error">{t("ticketEvent.preview.blocked")}</p> : plan ? <>
        <p>{t("ticketEvent.preview.summary", { count: plan.effects.length, steps: plan.steps, skipped: plan.skippedNodeIds.length })}</p>
        {plan.effects.length ? <ol className="ticket-event-preview-results">{plan.effects.map(effect => <li key={effect.nodeId}><b>{t(`ticketEvent.node.${effect.type}`)}</b>{"text" in effect ? <p dir="auto">{effect.text}</p> : "emoji" in effect ? <p>{effect.emoji}</p> : null}{effect.type === "reaction" && effect.referenceMessages ? <small>{t("ticketEvent.preview.targetReferenceMessages")}</small> : "replyToMessageId" in effect && effect.replyToMessageId ? <small>{t(`ticketEvent.preview.${effect.replyToMessageId === "preview-explicit" ? "targetExplicit" : effect.replyToMessageId === "preview-original" ? "targetOriginal" : effect.replyToMessageId === "preview-current" ? "targetCurrent" : "targetLatest"}`)}</small> : null}</li>)}</ol> : <p>{t("ticketEvent.preview.noEffects")}</p>}
      </> : null}
    </div> : null}
  </section>;
}
