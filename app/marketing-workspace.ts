import { containsMatches, exactLengthMatches, normalizeMessage, prefixLengthMatches } from "../lib/literal-matcher.ts";
import type { englishMarketingMessages } from "../lib/i18n/messages/en/marketing.ts";
import type { TranslationValues } from "../lib/i18n/translate.ts";

type Translate = (key: keyof typeof englishMarketingMessages, values?: TranslationValues) => string;
export type DemoRule = { kind: "digits" | "prefix" | "contains"; count: string; prefix: string; text: string };
export type DemoTicket = { title: string; source: string; owner: string; team: string; icon: "whatsapp" | "email"; group: number | null; status: "open" | "closed"; reference?: string };
export type DemoMessage = { author: string; text: string; time: string; group: number | null; tickets: number[]; outbound?: boolean; phase?: number; triggerRanges?: { start: number; end: number }[]; quote?: { author: string; text: string } };
export type DemoWorkspace = { groups: { name: string; members: number; owner: string; team: string; rule: DemoRule }[]; tickets: DemoTicket[]; history: DemoMessage[] };

export function createDemoWorkspace(t: Translate): DemoWorkspace {
  const people = ["fahad", "sara", "noura", "khalid"] as const;
  const teams = ["operations", "sales", "customerSupport", "technicalSupport"] as const;
  const groupNames = ["marketing.inbox.group", "marketing.demo.branchGroup", "marketing.demo.salesGroup", "marketing.demo.supportGroup", "marketing.demo.warehouseGroup", "marketing.demo.technicalGroup"] as const;
  const owners = [0, 1, 1, 2, 0, 3];
  const rules: DemoRule[] = [
    { kind: "digits", count: "10", prefix: "WX-", text: "" },
    { kind: "prefix", count: "4", prefix: "ST-", text: "" },
    { kind: "prefix", count: "4", prefix: "SO-", text: "" },
    { kind: "digits", count: "12", prefix: "WX-", text: "" },
    { kind: "prefix", count: "5", prefix: "WH-", text: "" },
    { kind: "prefix", count: "4", prefix: "IT-", text: "" },
  ];
  const groups = groupNames.map((key, index) => ({ name: t(key), members: [25, 32, 28, 36, 42, 26][index], owner: t(`marketing.inbox.${people[owners[index]]}`), team: t(`marketing.inbox.${teams[owners[index]]}`), rule: rules[index] }));
  const ticket = (title: string, owner: number, group: number | null, status: "open" | "closed" = "open", reference?: string, channel: "groups" | "bot" | "email" | "chats" = "groups"): DemoTicket => ({ title, owner: t(`marketing.inbox.${people[owner]}`), team: t(`marketing.inbox.${teams[owner]}`), source: t(`marketing.channels.${channel}`), icon: channel === "email" ? "email" : "whatsapp", group, status, reference });
  const tickets = [
    ticket(t("marketing.demo.shipment"), 0, 0, "open", "1234567890"),
    ticket(t("marketing.inbox.bot"), 1, null, "open", undefined, "bot"),
    ticket(t("marketing.inbox.email"), 2, null, "open", undefined, "email"),
    ticket(t("marketing.inbox.support"), 3, null, "open", undefined, "chats"),
    ticket(t("marketing.demo.delivered"), 2, 0, "closed", "9876543210"),
  ];
  const ahmed = t("marketing.inbox.ahmed"), mona = t("marketing.inbox.mona");
  const history: DemoMessage[] = [];
  const add = (index: number, text: string, author: string, time: string, options: Partial<DemoMessage> = {}) => {
    const group = tickets[index].group;
    const triggerRanges = group !== null && !options.outbound && !history.some(message => message.tickets.includes(index)) ? matchDemoTrigger(text, groups[group].rule).triggerRanges : undefined;
    history.push({ group, tickets: [index], text, author, time, triggerRanges, ...options });
  };
  add(4, t("marketing.demo.closedMessage"), ahmed, "09:38");
  add(4, t("marketing.demo.closedReply"), tickets[4].owner, "09:39", { outbound: true, quote: { author: ahmed, text: t("marketing.demo.closedMessage") } });
  add(0, t("marketing.demo.greeting"), mona, "09:40", { tickets: [] });
  add(0, t("marketing.demo.numberMessage"), ahmed, "09:41");
  add(0, t("marketing.inbox.followUp"), mona, "09:42", { phase: 2, quote: { author: ahmed, text: t("marketing.demo.numberMessage") } });
  add(0, t("marketing.demo.chatter"), mona, "09:43", { tickets: [] });
  add(0, t("marketing.inbox.reply"), tickets[0].owner, "09:44", { phase: 3, outbound: true, quote: { author: mona, text: t("marketing.inbox.followUp") } });
  add(1, t("marketing.inbox.botMessage"), ahmed, "09:38");
  add(1, t("marketing.demo.botQuestion"), t("marketing.channels.bot"), "09:39", { outbound: true });
  add(1, t("marketing.demo.botAnswer"), ahmed, "09:40");
  add(1, t("marketing.demo.botHandoff"), t("marketing.channels.bot"), "09:41", { outbound: true });
  add(1, t("marketing.demo.botReply"), tickets[1].owner, "09:43", { outbound: true });
  add(2, t("marketing.inbox.emailMessage"), ahmed, "09:41");
  add(2, t("marketing.demo.addressReply"), tickets[2].owner, "09:42", { outbound: true });
  add(3, t("marketing.inbox.supportMessage"), ahmed, "09:41");
  const stories = ["store", "sales", "customer", "warehouse", "technical"] as const;
  for (let group = 1; group < groups.length; group++) {
    history.push({ group, tickets: [], author: mona, text: t("marketing.demo.branchMessage"), time: "09:30" });
    for (let item = 0; item < 2; item++) {
      const rule = rules[group];
      const reference = rule.kind === "digits" ? `12345678901${item}` : `${rule.prefix}${String(1200 + item).padStart(Number(rule.count), "0")}`;
      const story = stories[group - 1];
      const text = t(`marketing.demo.${story}Request`, { reference });
      const index = tickets.length;
      tickets.push(ticket(`${t(`marketing.demo.${story}Title`)} · ${reference}`, owners[group], group, item === 1 ? "closed" : "open", reference));
      add(index, text, ahmed, item === 1 ? "09:33" : "09:31");
      add(index, t(item === 1 ? `marketing.demo.${story}Resolved` : "marketing.inbox.followUp"), item === 1 ? groups[group].owner : mona, item === 1 ? "09:34" : "09:32", { outbound: item === 1, quote: { author: ahmed, text } });
    }
  }
  for (const [key, owner, status] of [["quote", 1, "open"], ["invoice", 2, "closed"], ["access", 3, "open"]] as const) {
    const index = tickets.length;
    tickets.push(ticket(t(`marketing.demo.${key}Email`), owner, null, status, undefined, "email"));
    add(index, t(`marketing.demo.${key}Request`), mona, "09:35");
    add(index, t(`marketing.demo.${key}Reply`), tickets[index].owner, "09:40", { outbound: true });
  }
  return { groups, tickets, history };
}

export function validDemoRule(rule: DemoRule): boolean {
  return rule.kind === "contains" ? !!normalizeMessage(rule.text).trim() && rule.text.trim().length <= 240 : ["digits", "prefix"].includes(rule.kind) && Number.isInteger(Number(rule.count)) && Number(rule.count) >= 1 && Number(rule.count) <= 64 && (rule.kind !== "prefix" || (!!normalizeMessage(rule.prefix).trim() && rule.prefix.trim().length <= 64));
}

function matchDemoTrigger(text: string, rule: DemoRule) {
  const input = normalizeMessage(text);
  const matches = rule.kind === "contains" ? containsMatches(input, rule.text.trim(), 500) : rule.kind === "prefix" ? prefixLengthMatches(input, rule.prefix.trim(), Number(rule.count), 500) : exactLengthMatches(input, Number(rule.count), 500);
  let offset = 0;
  const segments = Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text), ({ segment, index }) => {
    const start = offset;
    offset += normalizeMessage(segment).length;
    return { start, end: offset, rawStart: index, rawEnd: index + segment.length };
  });
  const triggerRanges = matches.flatMap(match => {
    if (match.start < 0 || match.end > input.length || match.start >= match.end) return [];
    const start = segments.find(segment => segment.end > match.start)?.rawStart;
    const end = segments.find(segment => segment.end >= match.end)?.rawEnd;
    if (start === undefined || end === undefined || start >= end) return [];
    const value = normalizeMessage(text.slice(start, end));
    // Keep shared matcher behavior; ambiguous Unicode offsets must not mark unrelated text.
    if (value !== match.value || (rule.kind === "contains" && value.toUpperCase() !== rule.text.trim().toUpperCase()) || (rule.kind === "prefix" && !value.toUpperCase().startsWith(rule.prefix.trim().toUpperCase()))) return [];
    return [{ start, end }];
  }).reduce<{ start: number; end: number }[]>((ranges, range) => {
    const previous = ranges.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else ranges.push(range);
    return ranges;
  }, []);
  return { matches, triggerRanges };
}

export function receiveGroupMessage(workspace: DemoWorkspace, group: number, text: string, author: string, time: string): DemoWorkspace {
  const current = workspace.groups[group];
  const { matches, triggerRanges } = matchDemoTrigger(text, current.rule);
  const references = [...new Set(matches.map(match => match.value.toUpperCase()))];
  if (references.length > 100) throw new RangeError("Too many references");
  const tickets = [...workspace.tickets];
  const ids = references.map(reference => {
    const existing = tickets.findIndex(ticket => ticket.group === group && ticket.reference === reference);
    if (existing >= 0) { tickets[existing] = { ...tickets[existing], status: "open" }; return existing; }
    tickets.push({ title: reference, reference, group, owner: current.owner, team: current.team, source: workspace.tickets[0].source, icon: "whatsapp", status: "open" });
    return tickets.length - 1;
  });
  return { ...workspace, tickets, history: [...workspace.history, { text, author, time, group, tickets: ids, triggerRanges }] };
}
