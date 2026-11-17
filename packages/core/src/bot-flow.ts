export type BotFlowNode =
  | { id: string; type: "send_text"; text: string; next: string }
  | { id: string; type: "send_media"; assetId: string; caption?: string; next: string }
  | { id: string; type: "choice"; prompt: string; buttonLabel?: string; options: Array<{ id: string; label: string; next: string }> }
  | { id: string; type: "request_location"; prompt: string; next: string }
  | { id: string; type: "send_location"; latitude: number; longitude: number; name?: string; address?: string; next: string }
  | { id: string; type: "send_template"; templateName: string; languageCode: string; bodyParameters: string[]; transcriptText: string; next: string }
  | { id: string; type: "whatsapp_flow"; flowId: string; prompt: string; buttonLabel: string; screen?: string; data: Record<string, string>; next: string }
  | { id: string; type: "action"; actionId: string; input: Record<string, string>; onSuccess: string; onFailure: string }
  | ({ id: string; type: "handoff"; priority: "1 low" | "2 normal" | "3 high"; message?: string; mainMenuReturn?: { label: string } } & (
      { target: "FIXED"; zammadGroupId: string; zammadOwnerId?: string } | { target: "CLIENT_PRIMARY" | "CLIENT_ESCALATION"; zammadGroupId?: never; zammadOwnerId?: never }
    ))
  | { id: string; type: "end" };

export type BotEntryCommand = { id: string; aliases: string[]; target: string; enabled: boolean };

export type BotKeepOpenPolicy = { humanReplyPauseMinutes: number | null; mainMenu: boolean; customerResolution: boolean };
export const MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES = 1440;
export function defaultBotKeepOpenPolicy(): BotKeepOpenPolicy {
  return { humanReplyPauseMinutes: 120, mainMenu: true, customerResolution: true };
}

export function parseBotKeepOpenPolicy(value: unknown): BotKeepOpenPolicy {
  const policy = record(value, "Keep-open bot policy");
  if (Object.keys(policy).some(key => !["humanReplyPauseMinutes", "mainMenu", "customerResolution"].includes(key))) throw new Error("Unknown keep-open bot policy field");
  const minutes = policy.humanReplyPauseMinutes;
  if (minutes !== null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BOT_HUMAN_REPLY_PAUSE_MINUTES)) throw new Error("Invalid human reply pause");
  if (typeof policy.mainMenu !== "boolean" || typeof policy.customerResolution !== "boolean") throw new Error("Invalid customer bot controls");
  return { humanReplyPauseMinutes: minutes as number | null, mainMenu: policy.mainMenu, customerResolution: policy.customerResolution };
}

export type BotFlowDefinition = {
  schemaVersion: 1;
  keepOpenPolicy?: BotKeepOpenPolicy;
  welcomeResendMinutes?: number | null;
  mainMenuNodeId?: string | null;
  entryCommands?: BotEntryCommand[];
  name: string;
  start: string;
  maxSteps: number;
  nodes: BotFlowNode[];
};

export type DirectMessageCapabilities = {
  choices: "BUTTONS" | "NUMBERED_TEXT";
  location: true;
  metaFlows: boolean;
  templates: boolean;
};

export type BotFlowInput =
  | { type: "text"; text: string }
  | { type: "choice"; choiceId: string }
  | { type: "location"; latitude: number; longitude: number }
  | { type: "flow_response"; flowToken: string; data: Record<string, string> };

export type BotFlowEffect =
  | { type: "send_text"; nodeId: string; text: string }
  | { type: "send_media"; nodeId: string; assetId: string; caption?: string }
  | { type: "send_choices"; nodeId: string; prompt: string; buttonLabel?: string; options: Array<{ id: string; label: string }> }
  | { type: "request_location"; nodeId: string; prompt: string }
  | { type: "send_location"; nodeId: string; latitude: number; longitude: number; name?: string; address?: string }
  | { type: "send_template"; nodeId: string; templateName: string; languageCode: string; bodyParameters: string[]; transcriptText: string }
  | { type: "send_whatsapp_flow"; nodeId: string; flowId: string; flowToken: string; prompt: string; buttonLabel: string; screen?: string; data: Record<string, string> }
  | { type: "action"; nodeId: string; actionId: string; input: Record<string, string>; onSuccess: string; onFailure: string }
  | ({ type: "handoff"; nodeId: string; priority: "1 low" | "2 normal" | "3 high"; message?: string; mainMenuReturn?: { label: string } } & (
      { target: "FIXED"; zammadGroupId: string; zammadOwnerId?: string } | { target: "CLIENT_PRIMARY" | "CLIENT_ESCALATION"; zammadGroupId?: never; zammadOwnerId?: never }
    ))
  | { type: "end"; nodeId: string };

export type BotFlowAdvance = {
  currentNodeId: string;
  state: "WAITING" | "ACTION" | "HANDOFF" | "RESOLVED";
  effects: BotFlowEffect[];
  steps: number;
};

export type BotHandoffRoute = {
  escalationGroupId?: string;
  escalationOwnerId?: string;
};

export type BotActionOutputSchemas = ReadonlyMap<string, readonly string[]>;

const ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const ACTION_ID = /^[a-z][a-z0-9_.-]{0,127}$/u;
const META_TEMPLATE = /^[a-z0-9_]{1,512}$/u;
const META_LANGUAGE = /^[a-z]{2,3}(?:_[A-Z]{2})?$/u;
const META_FLOW_ID = /^[1-9][0-9]{0,31}$/u;
const FLOW_SCREEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function directMessageCapabilities(provider: "waha" | "meta"): DirectMessageCapabilities {
  return provider === "meta"
    ? { choices: "BUTTONS", location: true, metaFlows: false, templates: true }
    : { choices: "NUMBERED_TEXT", location: true, metaFlows: false, templates: false };
}

export function resolveBotHandoff(effect: Extract<BotFlowEffect, { type: "handoff" }>, primaryGroupId: string, primaryOwnerId?: string, route?: BotHandoffRoute) {
  if (effect.target === "FIXED") return { groupId: effect.zammadGroupId, ...(effect.zammadOwnerId ? { ownerId: effect.zammadOwnerId } : {}) };
  if (effect.target === "CLIENT_ESCALATION" && route?.escalationGroupId) return { groupId: route.escalationGroupId, ...(route.escalationOwnerId ? { ownerId: route.escalationOwnerId } : {}) };
  return { groupId: primaryGroupId, ...(primaryOwnerId ? { ownerId: primaryOwnerId } : {}) };
}

export function parseBotFlow(value: unknown): BotFlowDefinition {
  const flow = record(value, "Bot flow");
  if (flow.kind === "TICKET_EVENT") throw new Error("Ticket event workflows cannot be used as conversation bots");
  if (flow.schemaVersion !== 1) throw new Error("Bot flow schemaVersion must be 1");
  const name = text(flow.name, "Bot flow name", 160);
  const start = identifier(flow.start, "Bot flow start");
  const maxSteps = integer(flow.maxSteps, "Bot flow maxSteps", 1, 100);
  if (!Array.isArray(flow.nodes) || flow.nodes.length < 1 || flow.nodes.length > 100) {
    throw new Error("Bot flow must contain between 1 and 100 nodes");
  }
  const nodes = flow.nodes.map(parseNode);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`Bot flow node ${node.id} is duplicated`);
    ids.add(node.id);
  }
  if (!ids.has(start)) throw new Error("Bot flow start node does not exist");
  for (const node of nodes) {
    for (const next of transitions(node)) {
      if (!ids.has(next)) throw new Error(`Bot flow node ${node.id} points to missing node ${next}`);
    }
  }
  const mainMenuNodeId = flow.mainMenuNodeId === undefined ? undefined
    : flow.mainMenuNodeId === null ? null : identifier(flow.mainMenuNodeId, "Bot flow main menu node");
  if (mainMenuNodeId != null && nodes.find(node => node.id === mainMenuNodeId)?.type !== "choice")
    throw new Error("Bot flow main menu node must be an existing choice node");
  const entryCommands = flow.entryCommands === undefined ? undefined : parseBotEntryCommands(flow.entryCommands, nodes);
  const reachable = new Set<string>();
  const pending = botFlowEntryRoots({ start, entryCommands, mainMenuNodeId });
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.find((candidate) => candidate.id === id)!;
    pending.push(...transitions(node));
  }
  const unreachable = nodes.find((node) => !reachable.has(node.id));
  if (unreachable) throw new Error(`Bot flow node ${unreachable.id} is unreachable`);
  // Absence remains absent: historical immutable flows do not silently opt in.
  const keepOpenPolicy = flow.keepOpenPolicy === undefined ? undefined : parseBotKeepOpenPolicy(flow.keepOpenPolicy);
  const welcomeResendMinutes = flow.welcomeResendMinutes === undefined ? undefined
    : flow.welcomeResendMinutes === null ? null
    : integer(flow.welcomeResendMinutes, "Welcome resend interval", 1, 1440);
  if (welcomeResendMinutes != null && nodes.find(node => node.id === start)?.type !== "choice")
    throw new Error("Welcome resend requires a choice start node");
  if (nodes.some(node => node.type === "handoff" && node.mainMenuReturn !== undefined) && keepOpenPolicy?.mainMenu !== true)
    throw new Error("Handoff Main Menu requires the customer Main menu policy");
  return { schemaVersion: 1, name, start, maxSteps, nodes, ...(keepOpenPolicy === undefined ? {} : { keepOpenPolicy }),
    ...(welcomeResendMinutes === undefined ? {} : { welcomeResendMinutes }),
    ...(mainMenuNodeId === undefined ? {} : { mainMenuNodeId }),
    ...(entryCommands === undefined ? {} : { entryCommands }) };
}

const BOT_MESSAGE_VARIABLES = [
  "message.text", "message.choice_id", "message.choice_label",
  "message.location.latitude", "message.location.longitude",
  "message.location.name", "message.location.address",
];

function withBotMessageDefaults(flow: BotFlowDefinition, variables: Record<string, string>) {
  if (flow.welcomeResendMinutes == null && flow.mainMenuNodeId == null && !flow.entryCommands?.length) return variables;
  // Fresh entry roots cannot inherit fields belonging to another input type.
  return { ...Object.fromEntries(BOT_MESSAGE_VARIABLES.map(name => [name, ""])), ...variables };
}

/**
 * Proves that every rendered variable is available on every path that can
 * reach the node. Action response keys are introduced only on success paths.
 */
export function validateBotFlowVariableProvenance(definition: BotFlowDefinition, actions: BotActionOutputSchemas) {
  const flow = parseBotFlow(definition);
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const base = new Set([
    ...BOT_MESSAGE_VARIABLES,
    ...flow.nodes.filter((node) => node.type === "whatsapp_flow").map((node) => `flow.${node.id}.token`),
  ]);
  const roots = botFlowEntryRoots(flow);
  const availableAt = new Map<string, Set<string>>(roots.map(root => [root, new Set(base)]));
  const pending = [...roots];
  while (pending.length) {
    const nodeId = pending.shift()!;
    const node = nodes.get(nodeId)!;
    const available = availableAt.get(nodeId)!;
    for (const template of nodeTemplates(node)) {
      for (const variable of templateVariables(template)) {
        if (!available.has(variable) && !variable.startsWith("message.flow.")) {
          throw new Error(`Bot flow node ${node.id} uses unavailable variable ${variable}`);
        }
      }
    }
    if (node.type === "action" && !actions.has(node.actionId)) throw new Error(`Bot action ${node.actionId} is unavailable`);
    const edges = node.type === "action"
      ? [{ next: node.onSuccess, addsActionOutput: true }, { next: node.onFailure, addsActionOutput: false }]
      : transitions(node).map((next) => ({ next, addsActionOutput: false }));
    for (const { next, addsActionOutput } of edges) {
      const outgoing = new Set(available);
      if (node.type === "action" && addsActionOutput) {
        for (const variable of actions.get(node.actionId) ?? []) outgoing.add(variable);
      }
      const current = availableAt.get(next);
      const merged = current ? new Set([...current].filter((variable) => outgoing.has(variable))) : outgoing;
      if (!current || merged.size !== current.size) {
        availableAt.set(next, merged);
        pending.push(next);
      }
    }
  }
}

/** Declared disabled commands still own their configured components. Other nodes
 * must remain reachable; the caller supplies only already validated roots. */
export function botFlowEntryRoots(flow: { start: string; entryCommands?: BotEntryCommand[]; mainMenuNodeId?: string | null }): string[] {
  return [...new Set([flow.start, ...(flow.entryCommands ?? []).map(command => command.target),
    ...(flow.mainMenuNodeId == null ? [] : [flow.mainMenuNodeId])])];
}

/** Pure dispatch lookup. Ownership, time and effect admission belong to the direct
 * runtime before calling this function. Undefined currentNodeId means no displayed current menu. */
export function resolveBotEntryCommand(flow: BotFlowDefinition, currentNodeId: string | undefined, input: BotFlowInput | undefined, variables: Record<string, string> = {}): { id: string; target: string } | null {
  if (input?.type !== "text") return null;
  variables = withBotMessageDefaults(flow, variables);
  const current = flow.nodes.find(node => node.id === currentNodeId);
  if (current?.type === "choice") {
    const options = current.options.map(option => ({ ...option, label: renderBotTemplate(option.label, variables) }));
    if (choice(options, input)) return null;
  }
  const alias = normalizedChoiceLabel(input.text);
  const command = flow.entryCommands?.find(command => command.enabled && command.aliases.some(value => normalizedChoiceLabel(value) === alias));
  return command ? { id: command.id, target: command.target } : null;
}

function parseBotEntryCommands(value: unknown, nodes: BotFlowNode[]): BotEntryCommand[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Bot flow must contain at most 100 entry commands");
  const ids = new Set<string>(), aliases = new Set<string>(), targets = new Set(nodes.map(node => node.id));
  const reserved = new Set(["main menu", "القائمة الرئيسية", "resolve my ticket", "حل تذكرتي"]);
  return value.map(item => {
    const entry = record(item, "Bot entry command");
    if (Object.keys(entry).some(key => !["id", "aliases", "target", "enabled"].includes(key))) throw new Error("Bot entry command has an unknown field");
    const id = identifier(entry.id, "Bot entry command id"), target = identifier(entry.target, "Bot entry command target");
    if (ids.has(id)) throw new Error("Bot entry command id is duplicated");
    ids.add(id);
    if (!targets.has(target)) throw new Error("Bot entry command target does not exist");
    if (typeof entry.enabled !== "boolean") throw new Error("Bot entry command enabled is invalid");
    if (!Array.isArray(entry.aliases) || entry.aliases.length < 1 || entry.aliases.length > 10) throw new Error("Bot entry command must contain between 1 and 10 aliases");
    const parsedAliases = entry.aliases.map(value => {
      const label = text(value, "Bot entry command alias", 80), normalized = normalizedChoiceLabel(label);
      if (/\p{Cf}|\p{Cc}/u.test(label) || /^\p{Nd}+$/u.test(normalized) || normalized.includes("{{") || normalized.includes("}}") || reserved.has(normalized)) throw new Error("Bot entry command alias is reserved or invalid");
      if (aliases.has(normalized)) throw new Error("Bot entry command alias is duplicated");
      aliases.add(normalized);
      for (const node of nodes) if (node.type === "choice") for (const option of node.options) {
        if (option.next !== target && [option.id, option.label].some(value => normalizedChoiceLabel(value) === normalized)) throw new Error("Bot entry command alias conflicts with a menu choice");
      }
      return label;
    });
    return { id, aliases: parsedAliases, target, enabled: entry.enabled };
  });
}

export function advanceBotFlow(definition: BotFlowDefinition, currentNodeId: string, input?: BotFlowInput, variables: Record<string, string> = {}): BotFlowAdvance {
  const flow = parseBotFlow(definition);
  variables = withBotMessageDefaults(flow, variables);
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  if (!nodes.has(currentNodeId)) throw new Error("Bot conversation points to a missing node");
  const effects: BotFlowEffect[] = [];
  let nodeId = currentNodeId;
  let remainingInput = input;
  for (let steps = 1; steps <= flow.maxSteps; steps += 1) {
    const node = nodes.get(nodeId)!;
    if (node.type === "send_text") {
      effects.push({ type: node.type, nodeId, text: renderBotTemplate(node.text, variables) });
      nodeId = node.next;
      continue;
    }
    if (node.type === "send_media") {
      const caption=node.caption===undefined?undefined:renderBotTemplate(node.caption,variables);
      if(caption!==undefined&&[...caption].length>1_024)throw new Error(`Bot flow node ${node.id} rendered caption is too large`);
      effects.push({ type: node.type, nodeId, assetId: node.assetId, ...(caption?{caption}:{}) });
      nodeId = node.next;
      continue;
    }
    if (node.type === "send_location") {
      effects.push({ type: node.type, nodeId, latitude: node.latitude, longitude: node.longitude, ...(node.name ? { name: renderBotTemplate(node.name, variables) } : {}), ...(node.address ? { address: renderBotTemplate(node.address, variables) } : {}) });
      nodeId = node.next;
      continue;
    }
    if (node.type === "send_template") {
      effects.push({ type: node.type, nodeId, templateName: node.templateName, languageCode: node.languageCode, bodyParameters: node.bodyParameters.map(value => renderBotTemplate(value, variables)), transcriptText: renderBotTemplate(node.transcriptText, variables) });
      nodeId = node.next;
      continue;
    }
    if (node.type === "whatsapp_flow") {
      const flowToken = variables[`flow.${node.id}.token`];
      if (!flowToken) throw new Error(`Bot flow node ${node.id} token is unavailable`);
      if (remainingInput?.type === "flow_response") {
        if (remainingInput.flowToken !== flowToken) throw new Error(`Bot flow node ${node.id} response token is invalid`);
        remainingInput = undefined;
        nodeId = node.next;
        continue;
      }
      effects.push({ type: "send_whatsapp_flow", nodeId, flowId: node.flowId, flowToken, prompt: renderBotTemplate(node.prompt, variables), buttonLabel: renderBotTemplate(node.buttonLabel, variables), ...(node.screen ? { screen: node.screen } : {}), data: Object.fromEntries(Object.entries(node.data).map(([key,value]) => [key,renderBotTemplate(value, variables)])) });
      return { currentNodeId: nodeId, state: "WAITING", effects, steps };
    }
    if (node.type === "choice") {
      const options = node.options.map(({ id, label, next }) => ({ id, label: renderBotTemplate(label, variables), next }));
      const labels = new Set<string>();
      for (const option of options) {
        const label = normalizedChoiceLabel(option.label);
        if (labels.has(label)) throw new Error(`Bot flow node ${node.id} rendered duplicate choice label ${option.label}`);
        labels.add(label);
      }
      const selected = choice(options, remainingInput);
      if (selected) {
        remainingInput = undefined;
        nodeId = selected.next;
        continue;
      }
      effects.push({ type: "send_choices", nodeId, prompt: renderBotTemplate(node.prompt, variables), ...(node.buttonLabel ? { buttonLabel: renderBotTemplate(node.buttonLabel, variables) } : {}), options: options.map(({ id, label }) => ({ id, label })) });
      return { currentNodeId: nodeId, state: "WAITING", effects, steps };
    }
    if (node.type === "request_location") {
      if (remainingInput?.type === "location") {
        remainingInput = undefined;
        nodeId = node.next;
        continue;
      }
      effects.push({ type: node.type, nodeId, prompt: renderBotTemplate(node.prompt, variables) });
      return { currentNodeId: nodeId, state: "WAITING", effects, steps };
    }
    if (node.type === "action") {
      effects.push({ type: node.type, nodeId, actionId: node.actionId, input: Object.fromEntries(Object.entries(node.input).map(([key,value])=>[key,renderBotTemplate(value,variables)])), onSuccess: node.onSuccess, onFailure: node.onFailure });
      return { currentNodeId: nodeId, state: "ACTION", effects, steps };
    }
    if (node.type === "handoff") {
      effects.push({ type: node.type, nodeId, target:node.target, ...(node.target==="FIXED"?{zammadGroupId:node.zammadGroupId,...(node.zammadOwnerId?{zammadOwnerId:node.zammadOwnerId}:{})}:{}), priority: node.priority, ...(node.message ? { message: node.message } : {}), ...(node.mainMenuReturn ? { mainMenuReturn: { ...node.mainMenuReturn } } : {}) } as BotFlowEffect);
      return { currentNodeId: nodeId, state: "HANDOFF", effects, steps };
    }
    effects.push({ type: "end", nodeId });
    return { currentNodeId: nodeId, state: "RESOLVED", effects, steps };
  }
  throw new Error("Bot flow exceeded its maximum step budget");
}

export function renderBotTemplate(value: string, variables: Record<string, string>) {
  const rendered=value.replace(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/gu,(_match,key:string)=>{
    const replacement=variables[key];
    if(replacement===undefined)throw new Error(`Bot template variable ${key} is unavailable`);
    return replacement;
  });
  if([...rendered].length>65_536)throw new Error("Rendered bot text is too large");
  return rendered;
}

export function botChoicePosition(value:string):number {
  const numericValue=value.trim().replace(/[\u0660-\u0669\u06f0-\u06f9]/gu,(digit)=>{
    const code=digit.charCodeAt(0);return String(code-(code<=0x0669?0x0660:0x06f0));
  });
  return /^[1-9]\d?$/u.test(numericValue)?Number(numericValue)-1:-1;
}

function choice(options: Array<{ id: string; label: string; next: string }>, input: BotFlowInput | undefined) {
  if (!input) return undefined;
  if (input.type === "choice") return options.find((option) => option.id === input.choiceId) ?? options.find((option) => normalizedChoiceLabel(option.label) === normalizedChoiceLabel(input.choiceId));
  if (input.type !== "text") return undefined;
  const value = input.text.trim();
  const position = botChoicePosition(value);
  return options[position] ?? options.find((option) => option.id === value) ?? options.find((option) => normalizedChoiceLabel(option.label) === normalizedChoiceLabel(value));
}

function parseNode(value: unknown): BotFlowNode {
  const node = record(value, "Bot flow node");
  const id = identifier(node.id, "Bot flow node id");
  switch (node.type) {
    case "send_text":
      return { id, type: node.type, text: text(node.text, `${id} text`, 4_096), next: identifier(node.next, `${id} next`) };
    case "send_media": {
      const assetId=text(node.assetId,`${id} media asset`,36);
      if(!UUID.test(assetId))throw new Error(`${id} media asset is invalid`);
      return{id,type:node.type,assetId,...(node.caption===undefined?{}:{caption:text(node.caption,`${id} caption`,1_024)}),next:identifier(node.next,`${id} next`)};
    }
    case "choice": {
      const prompt = text(node.prompt, `${id} prompt`, 1_024);
      if (!Array.isArray(node.options) || node.options.length < 1 || node.options.length > 10) {
        throw new Error(`${id} must contain between 1 and 10 choices`);
      }
      const optionIds = new Set<string>();
      const optionLabels = new Set<string>();
      const options = node.options.map((value) => {
        const option = record(value, `${id} choice`);
        const optionId = identifier(option.id, `${id} choice id`);
        if (optionIds.has(optionId)) throw new Error(`${id} choice ${optionId} is duplicated`);
        optionIds.add(optionId);
        const label=text(option.label, `${id} choice label`, 80);const normalizedLabel=normalizedChoiceLabel(label);
        if(optionLabels.has(normalizedLabel))throw new Error(`${id} choice label ${label} is duplicated`);
        optionLabels.add(normalizedLabel);
        return { id: optionId, label, next: identifier(option.next, `${id} choice next`) };
      });
      return { id, type: node.type, prompt, ...(node.buttonLabel === undefined ? {} : { buttonLabel: text(node.buttonLabel, `${id} button label`, 20) }), options };
    }
    case "request_location":
      return { id, type: node.type, prompt: text(node.prompt, `${id} prompt`, 1_024), next: identifier(node.next, `${id} next`) };
    case "send_location": {
      const latitude = coordinate(node.latitude, `${id} latitude`, -90, 90);
      const longitude = coordinate(node.longitude, `${id} longitude`, -180, 180);
      return {
        id,
        type: node.type,
        latitude,
        longitude,
        ...(node.name === undefined ? {} : { name: text(node.name, `${id} name`, 160) }),
        ...(node.address === undefined ? {} : { address: text(node.address, `${id} address`, 500) }),
        next: identifier(node.next, `${id} next`),
      };
    }
    case "send_template": {
      const templateName=text(node.templateName,`${id} template name`,512);
      const languageCode=text(node.languageCode,`${id} language code`,16);
      if(!META_TEMPLATE.test(templateName)||!META_LANGUAGE.test(languageCode))throw new Error(`${id} template identity is invalid`);
      if(!Array.isArray(node.bodyParameters)||node.bodyParameters.length>20)throw new Error(`${id} template parameters are invalid`);
      return{id,type:node.type,templateName,languageCode,bodyParameters:node.bodyParameters.map((value,index)=>text(value,`${id} template parameter ${index+1}`,1024)),transcriptText:text(node.transcriptText,`${id} transcript`,4096),next:identifier(node.next,`${id} next`)};
    }
    case "whatsapp_flow": {
      const flowId=text(node.flowId,`${id} flow ID`,32);if(!META_FLOW_ID.test(flowId))throw new Error(`${id} flow ID is invalid`);
      const buttonLabel=text(node.buttonLabel,`${id} button label`,30);
      const dataRecord=record(node.data??{},`${id} flow data`);const entries=Object.entries(dataRecord);if(entries.length>25)throw new Error(`${id} flow data has too many fields`);
      const data=Object.fromEntries(entries.map(([key,value])=>[actionIdentifier(key,`${id} flow data key`),text(value,`${id} flow data value`,2000)]));
      const screen=node.screen===undefined?undefined:text(node.screen,`${id} screen`,64);if(screen&&!FLOW_SCREEN.test(screen))throw new Error(`${id} screen is invalid`);
      return{id,type:node.type,flowId,prompt:text(node.prompt,`${id} prompt`,1024),buttonLabel,...(screen?{screen}:{}),data,next:identifier(node.next,`${id} next`)};
    }
    case "action": {
      const input = record(node.input, `${id} input`);
      const entries = Object.entries(input);
      if (entries.length > 25) throw new Error(`${id} input has too many fields`);
      const safeInput = Object.fromEntries(entries.map(([key, value]) => [identifier(key, `${id} input key`), text(value, `${id} input value`, 2_000)]));
      return {
        id,
        type: node.type,
        actionId: actionIdentifier(node.actionId, `${id} actionId`),
        input: safeInput,
        onSuccess: identifier(node.onSuccess, `${id} onSuccess`),
        onFailure: identifier(node.onFailure, `${id} onFailure`),
      };
    }
    case "handoff": {
      if (node.priority !== "1 low" && node.priority !== "2 normal" && node.priority !== "3 high") {
        throw new Error(`${id} priority is invalid`);
      }
      if(node.target!==undefined&&!['FIXED','CLIENT_PRIMARY','CLIENT_ESCALATION'].includes(String(node.target)))throw new Error(`${id} handoff target is invalid`);
      const target=(node.target??"FIXED") as "FIXED"|"CLIENT_PRIMARY"|"CLIENT_ESCALATION";
      if (node.zammadOwnerId !== undefined && (target !== "FIXED" || typeof node.zammadOwnerId !== "string" || !/^[1-9][0-9]{0,15}$/u.test(node.zammadOwnerId) || !Number.isSafeInteger(Number(node.zammadOwnerId)))) throw new Error(`${id} Zammad owner is invalid`);
      const menu = node.mainMenuReturn === undefined ? undefined : record(node.mainMenuReturn, `${id} Main Menu return`);
      if (menu && Object.keys(menu).some(key => key !== "label")) throw new Error(`${id} Main Menu return has an unknown field`);
      const mainMenuReturn = menu === undefined ? undefined : { label: text(menu.label, `${id} Main Menu label`, 20) };
      return {
        id,
        type: node.type,
        target,
        ...(target==="FIXED"?{zammadGroupId:text(node.zammadGroupId, `${id} Zammad group`, 80),...(node.zammadOwnerId?{zammadOwnerId:node.zammadOwnerId}:{})}:{}),
        priority: node.priority,
        ...(node.message === undefined ? {} : { message: text(node.message, `${id} message`, 1_024) }),
        ...(mainMenuReturn === undefined ? {} : { mainMenuReturn }),
      } as BotFlowNode;
    }
    case "end":
      return { id, type: node.type };
    default:
      throw new Error(`${id} type is unsupported`);
  }
}

function normalizedChoiceLabel(value:string){return value.trim().normalize("NFKC").toLocaleLowerCase("und")}

function transitions(node: BotFlowNode) {
  if (node.type === "choice") return node.options.map((option) => option.next);
  if (node.type === "action") return [node.onSuccess, node.onFailure];
  if (node.type === "send_text" || node.type === "send_media" || node.type === "request_location" || node.type === "send_location" || node.type === "send_template" || node.type === "whatsapp_flow") return [node.next];
  return [];
}

function nodeTemplates(node: BotFlowNode) {
  if (node.type === "send_text") return [node.text];
  if (node.type === "send_media") return node.caption?[node.caption]:[];
  if (node.type === "choice") return [node.prompt, ...(node.buttonLabel ? [node.buttonLabel] : []), ...node.options.map(({ label }) => label)];
  if (node.type === "request_location") return [node.prompt];
  if (node.type === "send_location") return [node.name, node.address].filter((value): value is string => value !== undefined);
  if (node.type === "send_template") return [...node.bodyParameters, node.transcriptText];
  if (node.type === "whatsapp_flow") return [node.prompt, node.buttonLabel, ...Object.values(node.data)];
  if (node.type === "action") return Object.values(node.input);
  return [];
}

function templateVariables(value: string) {
  return [...value.matchAll(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/giu)].map((match) => match[1]!);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || [...value].length > maximum || hasUnsafeControl(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function hasUnsafeControl(value: string) {
  return [...value].some(character => { const code=character.codePointAt(0)!; return code===127||(code<32&&code!==9&&code!==10&&code!==13) });
}

function identifier(value: unknown, label: string) {
  const result = text(value, label, 64);
  if (!ID.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function actionIdentifier(value: unknown, label: string) {
  const result = text(value, label, 128);
  if (!ACTION_ID.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function integer(value: unknown, label: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} is invalid`);
  return value as number;
}

function coordinate(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}
