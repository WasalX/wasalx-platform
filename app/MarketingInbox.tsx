"use client";

import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createDemoWorkspace, receiveGroupMessage, validDemoRule, type DemoRule, type DemoTicket, type DemoMessage as HistoryMessage } from "./marketing-workspace.ts";
import type { englishMarketingMessages } from "../lib/i18n/messages/en/marketing.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import { MarketingIcon } from "./MarketingIcon";
import { ScrollRegion } from "./tenant-ui";
import { MarketingMotionToggle, useMarketingMotion } from "./MarketingMotion";

export function MarketingInbox({ messages, locale }: { messages: Record<keyof typeof englishMarketingMessages, string>; locale: "en" | "ar" }) {
  const t = createTranslator(messages);
  const [workspace, setWorkspace] = useState(() => createDemoWorkspace(t));
  const { groups, tickets } = workspace;
  const [ruleDraft, setRuleDraft] = useState<DemoRule>(groups[0].rule);
  const [ruleError, setRuleError] = useState(false);
  const [view, setView] = useState<"groups" | "tickets">("groups");
  const [selected, setSelected] = useState(0);
  const [group, setGroup] = useState(0);
  const [team, setTeam] = useState("");
  const [member, setMember] = useState("");
  const [status, setStatus] = useState("");
  const [groupBy, setGroupBy] = useState("team");
  const [panel, setPanel] = useState<"filter" | "group" | "sort" | null>(null);
  const [sort, setSort] = useState("recent");
  const [activity, setActivity] = useState<Record<number, number>>({});
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedFilter, setRelatedFilter] = useState("all");
  const relatedToggle = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const triggerToggle = useRef<HTMLButtonElement>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ticketReply, setTicketReply] = useState<number | null>(null);
  const [sender, setSender] = useState<"customer" | "team">("customer");
  const [interacting, setInteracting] = useState(false);
  const [exampleReply, setExampleReply] = useState(false);
  const [phase, setPhase] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [sendError, setSendError] = useState(false);
  const [scrollTarget, setScrollTarget] = useState("original");
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLElement>(null);
  const browseToggle = useRef<HTMLButtonElement>(null);
  const manual = useRef(false);
  const { ref, running, enabled } = useMarketingMotion<HTMLElement>();
  useEffect(() => {
    if (!running || interacting) return;
    const timer = window.setTimeout(() => setPhase(value => (value + 1) % 5), phase === 4 ? 6000 : 2600);
    return () => window.clearTimeout(timer);
  }, [running, interacting, phase]);

  const autoplay = enabled && !interacting;
  const currentView = autoplay ? (phase === 2 || phase === 3 ? "tickets" : "groups") : view;
  const available = tickets.map((ticket, index) => ({ ...ticket, index }));
  const related = available.filter(ticket => ticket.group === group);
  const latest = new Map<number, number>();
  for (const message of workspace.history) for (const id of message.tickets) latest.set(id, Math.max(latest.get(id) ?? 0, Number(message.time.replace(":", ""))));
  const filtered = available.filter(ticket => (!team || ticket.team === team) && (!member || ticket.owner === member) && (!status || ticket.status === status)).sort((a, b) => sort === "name" ? a.title.localeCompare(b.title, locale) : (activity[b.index] ?? latest.get(b.index) ?? 0) - (activity[a.index] ?? latest.get(a.index) ?? 0));
  const activeIndex = currentView === "groups" ? (related.find(ticket => ticket.index === (ticketReply ?? selected))?.index ?? related[0]?.index) : filtered.find(ticket => ticket.index === selected)?.index ?? filtered[0]?.index;
  const active = activeIndex === undefined ? undefined : tickets[activeIndex];
  const isGroupTicket = active?.group !== null && active?.group !== undefined;
  const replyingOnTicket = currentView === "tickets" || (ticketReply !== null && isGroupTicket);
  const currentSender = replyingOnTicket ? "team" : sender;
  const senderName = currentSender === "customer" ? t("marketing.inbox.ahmed") : replyingOnTicket ? active?.owner ?? "" : groups[group].owner;
  const senderLabel = t(currentSender === "team" ? "marketing.demo.teamMessage" : "marketing.demo.memberMessage", { name: senderName });
  const composerLabel = t(currentSender === "team" ? "marketing.demo.replyPlaceholder" : "marketing.demo.placeholder");
  const draftKey = replyingOnTicket ? `ticket-${activeIndex}` : `group-${group}-${currentSender}`;
  const draft = drafts[draftKey] ?? "";
  const showExampleReply = exampleReply || (!interacting && (!enabled || phase >= 3));
  const history = workspace.history.filter(message => message.phase !== 3 || showExampleReply);
  const visibleMessages = history.filter(message => currentView === "groups" ? message.group === group : activeIndex !== undefined && message.tickets.includes(activeIndex));
  const replyTarget = history.findLast(message => activeIndex !== undefined && message.tickets.includes(activeIndex));
  const activeRule = groups[group].rule;
  const ruleSummary = activeRule.kind === "contains" ? t("marketing.demo.ruleContains", { text: activeRule.text }) : activeRule.kind === "prefix" ? t("marketing.demo.rulePrefix", { prefix: activeRule.prefix, count: activeRule.count }) : t("marketing.demo.ruleDigits", { count: activeRule.count });
  useEffect(() => {
    const container = transcript.current;
    if (!container) return;
    const original = container.querySelector<HTMLElement>(`[data-origin~="${activeIndex ?? 0}"]`);
    container.scrollTop = (autoplay ? phase >= 3 : scrollTarget === "latest") ? container.scrollHeight : original ? container.scrollTop + original.getBoundingClientRect().top - container.getBoundingClientRect().top - 12 : 0;
  }, [currentView, activeIndex, group, visibleMessages.length, scrollTarget, autoplay, phase, ticketReply]);
  const groupName = (ticket: DemoTicket) => groupBy === "team" ? ticket.team : groupBy === "member" ? ticket.owner : groupBy === "status" ? t(`marketing.demo.${ticket.status}`) : "";
  const groupNames = [...new Set(filtered.map(groupName))];
  const takeOver = () => {
    if (manual.current) return;
    manual.current = true;
    setView(currentView); setExampleReply(showExampleReply); setInteracting(true);
  };
  const revealDetail = () => window.requestAnimationFrame(() => {
    conversation.current?.focus({ preventScroll: true });
    conversation.current?.scrollIntoView({ block: window.matchMedia("(max-width: 680px)").matches ? "start" : "nearest", behavior: "instant" });
  });
  const chooseDetail = () => { setSendError(false); setBrowseOpen(false); setPanel(null); revealDetail(); };
  const clearFilters = () => { setTeam(""); setMember(""); setStatus(""); };
  const openTicket = (index: number) => { takeOver(); clearFilters(); setSelected(index); setRelatedOpen(false); setTriggerOpen(false); setView("tickets"); setScrollTarget("latest"); chooseDetail(); };
  const openGroup = () => { takeOver(); setGroup(active?.group ?? group); setView("groups"); setSender("customer"); setTriggerOpen(false); setTicketReply(null); setScrollTarget("latest"); chooseDetail(); };
  const chooseSender = (next: typeof sender) => {
    takeOver(); setSendError(false); setSender(next);
    if (next === "customer") {
      setTicketReply(null);
      if (currentView === "tickets" && isGroupTicket) {
        openGroup();
        setAnnouncement(t("marketing.demo.customerInGroup", { group: groups[active!.group!].name }));
      }
    }
    window.requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
  };
  const ticketLabel = `${t("marketing.demo.ticket")} #${1042 + (activeIndex ?? 0)}`;
  const changeStatus = (next: DemoTicket["status"]) => {
    if (activeIndex === undefined) return;
    setWorkspace(current => ({ ...current, tickets: current.tickets.map((ticket, index) => index === activeIndex ? { ...ticket, status: next } : ticket) }));
    setSelected(activeIndex);
    setActivity(current => ({ ...current, [activeIndex]: Date.now() }));
    // Keep the reply and its draft on this ticket when it leaves the current status filter.
    if (status && status !== next) setStatus("");
    setAnnouncement(`${ticketLabel} · ${t(`marketing.demo.${next}`)}${status && status !== next ? `. ${t("marketing.demo.statusFilterCleared")}` : ""}`);
  };
  const groupReply = (index: number) => { takeOver(); setSendError(false); setSender("team"); setSelected(index); setTicketReply(index); setScrollTarget("latest"); window.requestAnimationFrame(() => composer.current?.focus()); };
  const selectRow = (event: MouseEvent<HTMLButtonElement>) => {
    takeOver();
    const index = Number(event.currentTarget.value);
    if (currentView === "groups") { setGroup(index); setRelatedOpen(false); setRelatedFilter("all"); setTicketReply(null); } else setSelected(index);
    setTriggerOpen(false); setScrollTarget("latest"); chooseDetail();
  };
  const reset = () => {
    manual.current = false;
    setWorkspace(createDemoWorkspace(t)); setRuleError(false); setSendError(false);
    setView("groups"); setGroup(0); setSelected(0); clearFilters(); setGroupBy("team"); setSort("recent"); setActivity({}); setPanel(null); setTriggerOpen(false); setRelatedOpen(false); setRelatedFilter("all");
    setDrafts({}); setSender("customer"); setTicketReply(null); setExampleReply(false); setPhase(0); setInteracting(false); setAnnouncement(""); setScrollTarget("original"); setBrowseOpen(false);
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setSendError(false);
    takeOver();
    if (replyingOnTicket && active && activeIndex !== undefined) {
      setWorkspace(current => ({ ...current, history: [...current.history, { text, author: active.owner, group: active.group, tickets: [activeIndex], time: "09:45", outbound: true, ...(isGroupTicket && replyTarget ? { quote: { author: replyTarget!.author, text: replyTarget!.text } } : {}) }] }));
      setActivity(current => ({ ...current, [activeIndex]: Date.now() }));
      setAnnouncement(t(isGroupTicket ? "marketing.demo.sentLinked" : "marketing.inbox.sent"));
    } else if (currentSender === "team") {
      setWorkspace(current => ({ ...current, history: [...current.history, { text, author: senderName, group, tickets: [], time: "09:45", outbound: true }] }));
      setAnnouncement(t("marketing.demo.sentGroup"));
    } else {
      let next;
      try { next = receiveGroupMessage(workspace, group, text, t("marketing.inbox.ahmed"), "09:45"); }
      catch (error) { if (!(error instanceof RangeError)) throw error; setSendError(true); return; }
      const linked = next.history.at(-1)!.tickets;
      setWorkspace(next);
      setActivity(current => ({ ...current, ...Object.fromEntries(linked.map(id => [id, Date.now()])) }));
      setAnnouncement(t(linked.length ? "marketing.demo.matchedTickets" : "marketing.demo.sentGroup", { count: linked.length }));
    }
    setDrafts(current => ({ ...current, [draftKey]: "" }));
    setScrollTarget("latest");
  };
  const activateTrigger = () => {
    if (!validDemoRule(ruleDraft)) { setRuleError(true); return; }
    setWorkspace(current => ({ ...current, groups: current.groups.map((item, index) => index === group ? { ...item, rule: { ...ruleDraft, prefix: ruleDraft.prefix.trim(), text: ruleDraft.text.trim() } } : item) }));
    setTriggerOpen(false); setAnnouncement(t("marketing.demo.activated"));
    triggerToggle.current?.focus();
  };
  const closePanel = () => {
    const current = panel;
    setPanel(null);
    toolbar.current?.querySelector<HTMLButtonElement>(`[data-panel="${current}"]`)?.focus();
  };

  return <figure className="marketing-inbox" id="product" tabIndex={-1} ref={ref} data-running={running && !interacting} data-view={currentView}>
    <div className="inbox-window">
      <div className="inbox-label"><span className="inbox-wordmark" dir="ltr">W<span>X</span></span><span>{t("marketing.inbox.label")}</span><div className="inbox-demo-controls"><button type="button" className="inbox-text-button" onClick={reset}>{t("marketing.demo.reset")}</button><MarketingMotionToggle pause={t("marketing.motion.pause")} play={t("marketing.motion.play")}/></div></div>
      <div className="inbox-layout" onPointerDownCapture={takeOver} onFocusCapture={takeOver}>
        <div className="inbox-sidebar">
          <nav className="inbox-views" aria-label={t("marketing.demo.navigation")}>
            {(["groups", "tickets"] as const).map(next => <button key={next} type="button" aria-pressed={currentView === next} onClick={() => { takeOver(); setView(next); setSender(next === "groups" ? "customer" : "team"); setPanel(null); setRelatedOpen(false); setTriggerOpen(false); setTicketReply(null); setScrollTarget("latest"); chooseDetail(); }}><MarketingIcon name={next === "groups" ? "groups" : "ticket"}/>{t(`marketing.demo.${next}`)}<span>{next === "groups" ? groups.length : tickets.length}</span></button>)}
          </nav>
          <button type="button" ref={browseToggle} className="inbox-browse-toggle inbox-text-button" aria-expanded={browseOpen} aria-controls="inbox-browser" onClick={() => setBrowseOpen(value => !value)}>{t(currentView === "groups" ? "marketing.demo.browseGroups" : "marketing.demo.browseTickets")}<MarketingIcon name="arrow"/></button>
          <div className="inbox-browser" id="inbox-browser" role="group" aria-label={t(currentView === "groups" ? "marketing.demo.browseGroups" : "marketing.demo.browseTickets")} data-open={browseOpen} onKeyDownCapture={event => { if (event.key === "Escape" && browseOpen && !panel) { setBrowseOpen(false); browseToggle.current?.focus(); } }}>
          {currentView === "tickets" && <div className="inbox-tools" role="group" aria-label={t("marketing.demo.filters")} onKeyDownCapture={event => { if (event.key === "Escape" && panel) { event.stopPropagation(); closePanel(); } }}>
            <div className="inbox-toolbar" ref={toolbar}>{(["filter", "group", "sort"] as const).map(tool => <button type="button" key={tool} data-panel={tool} aria-expanded={panel === tool} aria-controls="demo-filters" title={t(tool === "filter" ? "marketing.demo.filters" : tool === "group" ? "marketing.demo.groupControl" : "marketing.demo.sort")} className="inbox-text-button" onClick={() => setPanel(panel === tool ? null : tool)}><MarketingIcon name={tool}/>{t(tool === "filter" ? "marketing.demo.filters" : tool === "group" ? "marketing.demo.groupControl" : "marketing.demo.sort")}{tool === "filter" && (team || member || status) && <span className="inbox-filter-dot"/>}</button>)}</div>
            {panel && <div className="inbox-filters" id="demo-filters">
              {panel === "filter" && <><label>{t("marketing.demo.team")}<select name="demo-team" value={team} onChange={event => setTeam(event.target.value)}><option value="">{t("marketing.inbox.teams")}</option>{[...new Set(tickets.map(ticket => ticket.team))].map(name => <option key={name}>{name}</option>)}</select></label>
              <label>{t("marketing.demo.member")}<select name="demo-member" value={member} onChange={event => setMember(event.target.value)}><option value="">{t("marketing.demo.everyone")}</option>{[...new Set(tickets.map(ticket => ticket.owner))].map(name => <option key={name}>{name}</option>)}</select></label><label>{t("marketing.demo.status")}<select name="demo-status-filter" value={status} onChange={event => setStatus(event.target.value)}><option value="">{t("marketing.demo.all")}</option><option value="open">{t("marketing.demo.open")}</option><option value="closed">{t("marketing.demo.closed")}</option></select></label>{(team || member || status) && <button type="button" className="inbox-text-button" onClick={clearFilters}>{t("marketing.demo.clear")}</button>}</>}
              {panel === "group" && <label>{t("marketing.demo.groupBy")}<select name="demo-group-by" value={groupBy} onChange={event => setGroupBy(event.target.value)}><option value="">{t("marketing.demo.none")}</option><option value="team">{t("marketing.demo.team")}</option><option value="member">{t("marketing.demo.member")}</option><option value="status">{t("marketing.demo.status")}</option></select></label>}
              {panel === "sort" && <label>{t("marketing.demo.sort")}<select name="demo-sort" value={sort} onChange={event => setSort(event.target.value)}><option value="recent">{t("marketing.demo.recent")}</option><option value="name">{t("marketing.demo.name")}</option></select></label>}
            </div>}
          </div>}
          <div className="inbox-list-heading"><h2>{t(currentView === "groups" ? "marketing.demo.groups" : "marketing.inbox.title")}</h2><span>{currentView === "groups" ? groups.length : filtered.length}</span></div>
          <div className="inbox-list-scroll">
            {currentView === "groups" ? <ul className="inbox-list">{groups.map((item, index) => <li key={item.name}><button type="button" className="inbox-row" value={index} aria-pressed={index === group} onClick={selectRow}><span className="inbox-source-icon"><MarketingIcon name="whatsapp"/></span><span className="inbox-row-copy"><strong>{item.name}</strong><small>{t("marketing.demo.members", { count: item.members })} · {t("marketing.demo.tickets")} · {available.filter(ticket => ticket.group === index).length}</small></span></button></li>)}</ul> : groupNames.map(name => <div key={name}>{name && <h3 className="inbox-team-heading">{name}</h3>}<ul className="inbox-list">{filtered.filter(ticket => groupName(ticket) === name).map(ticket => <li key={ticket.index}><button type="button" className="inbox-row" value={ticket.index} aria-pressed={ticket.index === activeIndex} onClick={selectRow}><span className="inbox-source-icon"><MarketingIcon name={ticket.icon}/></span><span className="inbox-row-copy"><strong>{ticket.title}</strong><small>{ticket.source} · <bdi>#{1042 + ticket.index}</bdi></small><small>{ticket.owner} · <span className="inbox-ticket-state" data-state={ticket.status}>{t(`marketing.demo.${ticket.status}`)}</span></small></span></button></li>)}</ul></div>)}
            {currentView === "tickets" && !filtered.length && <p className="inbox-empty">{t("marketing.demo.empty")}</p>}
          </div>
          <div className="inbox-upcoming"><strong>{t(currentView === "groups" ? "marketing.demo.groupsSoon" : "marketing.demo.botsSoon")}</strong><ul>{(currentView === "groups" ? ["slack"] as const : ["instagram", "x", "tiktok", "slack"] as const).map(channel => <li key={channel}><MarketingIcon name={channel}/><bdi>{t(`marketing.channels.${channel}`)}</bdi></li>)}</ul></div>
          </div>
        </div>
        {currentView === "groups" || active ? <section className="inbox-conversation" id="inbox-conversation" ref={conversation} tabIndex={-1} aria-label={currentView === "groups" ? groups[group].name : active?.title}>
          <div className="inbox-conversation-header"><div className="inbox-conversation-heading"><span className="inbox-active-title"><MarketingIcon name={currentView === "groups" ? "whatsapp" : active!.icon}/><span><strong>{currentView === "groups" ? groups[group].name : <>{ticketLabel} · {active!.title}</>}</strong><small>{currentView === "groups" ? <>{t("marketing.demo.customerGroup")} · {t("marketing.demo.members", { count: groups[group].members })}</> : active!.source}</small></span></span>
            {currentView === "tickets" && active && <div className="inbox-assignment" data-assigned={!autoplay || phase >= 1}><span>{t("marketing.inbox.assigned")}</span><strong><span className="inbox-avatar" aria-hidden="true">{active.owner.slice(0, 1)}</span>{active.owner} · {active.team}</strong><label className="inbox-status-control" data-state={active.status}><span className="wx-visually-hidden">{t("marketing.demo.status")}</span><select name="demo-ticket-status" value={active.status} onChange={event => changeStatus(event.target.value as DemoTicket["status"])}><option value="open">{t("marketing.demo.open")}</option><option value="closed">{t("marketing.demo.closed")}</option></select></label></div>}
          </div><div className="inbox-header-actions">{currentView === "groups" ? <button ref={triggerToggle} type="button" className="inbox-text-button inbox-rule-toggle" aria-label={t("marketing.demo.trigger")} aria-expanded={triggerOpen} aria-controls="demo-trigger" onClick={() => { if (!triggerOpen) { setRuleDraft({ ...activeRule }); setRuleError(false); } setTriggerOpen(value => !value); setRelatedOpen(false); }}><MarketingIcon name="settings"/>{t("marketing.demo.trigger")}</button> : isGroupTicket && <button type="button" className="inbox-text-button" onClick={openGroup}><MarketingIcon name="groups"/>{t("marketing.demo.viewGroup")}</button>}{currentView === "tickets" && <button type="button" className="inbox-origin inbox-text-button" onClick={() => setScrollTarget(value => value === "original" ? "origin-again" : "original")}><MarketingIcon name="link"/>{t("marketing.demo.viewOrigin")}</button>}</div></div>
          {currentView === "groups" && <div className="inbox-active-rule"><MarketingIcon name="settings"/><strong>{t("marketing.groups.ruleLabel")}</strong><bdi>{ruleSummary}</bdi><span><MarketingIcon name="check"/>{t("marketing.demo.active")}</span></div>}
          {currentView === "groups" && triggerOpen && <form className="inbox-trigger-editor" id="demo-trigger" aria-label={t("marketing.demo.trigger")} onChange={() => setRuleError(false)} onKeyDownCapture={event => { if (event.key === "Escape") { setTriggerOpen(false); triggerToggle.current?.focus(); } }} onSubmit={event => { event.preventDefault(); activateTrigger(); }}>
            <label>{t("marketing.demo.ruleType")}<select name="demo-rule" value={ruleDraft.kind} onChange={event => setRuleDraft(current => ({ ...current, kind: event.target.value as DemoRule["kind"] }))}><option value="digits">{t("marketing.demo.exactDigits")}</option><option value="prefix">{t("marketing.demo.prefixDigits")}</option><option value="contains">{t("marketing.demo.contains")}</option></select></label>
            {ruleDraft.kind !== "contains" && <div className="inbox-trigger-fields">
              {ruleDraft.kind === "prefix" && <label>{t("marketing.demo.prefix")}<input name="demo-prefix" dir="auto" pattern={".*\\S.*"} required value={ruleDraft.prefix} maxLength={64} onChange={event => setRuleDraft(current => ({ ...current, prefix: event.target.value }))}/></label>}
              <label><span>{t(ruleDraft.kind === "prefix" ? "marketing.demo.digitsAfterPrefix" : "marketing.demo.digitCount")} <bdi dir="ltr">(1–64)</bdi></span><input name="demo-digits" type="number" inputMode="numeric" min={1} max={64} step={1} required value={ruleDraft.count} onChange={event => setRuleDraft(current => ({ ...current, count: event.target.value }))}/></label>
            </div>}
            {ruleDraft.kind === "contains" && <label>{t("marketing.demo.contains")}<input name="demo-pattern" dir="auto" pattern={".*\\S.*"} required value={ruleDraft.text} maxLength={240} onChange={event => setRuleDraft(current => ({ ...current, text: event.target.value }))}/></label>}
            {ruleError && <p className="inbox-trigger-error" role="alert">{t("marketing.demo.ruleError")}</p>}
            <div className="inbox-trigger-actions"><button type="button" className="inbox-text-button" onClick={() => { setTriggerOpen(false); triggerToggle.current?.focus(); }}>{t("marketing.demo.cancel")}</button><button type="submit" className="wx-button wx-button-primary">{t("marketing.demo.activate")}</button></div><small>{t("marketing.demo.activationHint")}</small>
          </form>}
          {currentView === "groups" && <div className="inbox-related" onKeyDownCapture={event => { if (event.key === "Escape" && relatedOpen) { setRelatedOpen(false); relatedToggle.current?.focus(); } }}>
            <button ref={relatedToggle} type="button" className="inbox-text-button inbox-related-toggle" aria-expanded={relatedOpen} aria-controls="demo-related" onClick={() => { setRelatedOpen(value => !value); setTriggerOpen(false); }}><MarketingIcon name="ticket"/>{t("marketing.demo.related")}<span>{related.filter(ticket => ticket.status === "open").length} {t("marketing.demo.open")} · {related.filter(ticket => ticket.status === "closed").length} {t("marketing.demo.closed")}</span><MarketingIcon name="arrow"/></button>
            {relatedOpen && <div id="demo-related" className="inbox-related-panel"><div className="inbox-related-filters" role="group" aria-label={t("marketing.demo.status")}>
              {(["all", "open", "closed"] as const).map(state => <button key={state} type="button" className="inbox-text-button" aria-pressed={relatedFilter === state} onClick={() => setRelatedFilter(state)}>{t(`marketing.demo.${state}`)}</button>)}</div>
              <ul>{related.filter(ticket => relatedFilter === "all" || ticket.status === relatedFilter).map(ticket => <li key={ticket.index}><button type="button" className="inbox-related-row" onClick={() => openTicket(ticket.index)}><span><strong><bdi>#{1042 + ticket.index}</bdi> · {ticket.title}</strong><small>{ticket.owner} · {ticket.team}</small></span><span className="inbox-ticket-state" data-state={ticket.status}>{t(`marketing.demo.${ticket.status}`)}</span><MarketingIcon name="arrow"/></button></li>)}</ul>
              {!related.some(ticket => relatedFilter === "all" || ticket.status === relatedFilter) && <p className="inbox-empty">{t("marketing.demo.noRelated")}</p>}
            </div>}
          </div>}
          <ScrollRegion className="inbox-messages" ref={transcript} key={`${currentView}-${activeIndex}-${group}`} aria-label={t(currentView === "groups" ? "marketing.demo.groupHistory" : "marketing.demo.tickets")}>
            <span className="inbox-day">{t("marketing.inbox.today")}</span>
            {visibleMessages.map((message, index) => {
              // ponytail: linear lookup is sufficient for this small local demo; index origins if history grows.
              const origins = message.tickets.filter(id => history.find(entry => entry.tickets.includes(id)) === message);
              const original = origins.includes(0);
              const roleLabel = t(message.author === t("marketing.channels.bot") ? "marketing.demo.botRole" : message.outbound ? "marketing.demo.teamRole" : "marketing.demo.customerRole");
              return <div key={index} className={`inbox-history-entry${original ? " inbox-original" : message.phase === 2 ? " inbox-message-followup" : ""}`} data-origin={origins.join(" ") || undefined} data-highlighted={activeIndex !== undefined && origins.includes(activeIndex) && (autoplay ? phase < 2 : scrollTarget.startsWith("orig"))} data-revealed={message.phase !== 2 || !autoplay || phase >= 2}>
                <DemoMessage author={message.author} roleLabel={roleLabel} text={message.text} time={message.time} outbound={message.outbound} triggerLabel={message.triggerRanges?.length ? t("marketing.demo.triggerMessage") : undefined} triggerRanges={message.triggerRanges} quote={message.quote ? <><strong>{message.quote.author}</strong><span>{message.quote.text}</span></> : undefined} note={message.tickets.length > 0 && message.group !== null ? currentView === "groups" ? <span className="inbox-trigger" data-created={!autoplay || !original || phase >= 1}>{message.tickets.map(id => <span key={id}><button type="button" onClick={() => openTicket(id)} disabled={autoplay && original && phase < 1}><MarketingIcon name="ticket"/>{autoplay && original && phase < 1 ? t("marketing.groups.opening") : <>{t("marketing.demo.ticket")} <bdi>#{1042 + id}</bdi></>}</button><button type="button" className="inbox-request-reply" onClick={() => groupReply(id)}><MarketingIcon name="reply"/>{t("marketing.demo.replyToTicket")}</button></span>)}</span> : activeIndex !== undefined && origins.includes(activeIndex) ? t("marketing.demo.origin") : t("marketing.demo.linkedReply") : undefined}/>
              </div>;
            })}
          </ScrollRegion>
          <form className="inbox-composer" onSubmit={event => { event.preventDefault(); send(); }}>
            {sendError && <p className="inbox-send-error" role="alert">{t("marketing.demo.referenceLimit")}</p>}
            {(currentView === "groups" || isGroupTicket) && <div className="inbox-composer-toolbar"><div className="inbox-sender-switch" role="group" aria-label={t("marketing.demo.sendAs")}>
              {(["customer", "team"] as const).map(role => <button key={role} type="button" aria-pressed={currentSender === role} title={role === "customer" && currentView === "tickets" ? t("marketing.demo.customerInGroup", { group: groups[active!.group!].name }) : undefined} onClick={() => chooseSender(role)}>{t(role === "customer" ? "marketing.demo.customerRole" : "marketing.demo.teamRole")}</button>)}
            </div><span className="inbox-sender-name">{senderName}</span></div>}
            <div className="inbox-composer-context">{isGroupTicket && replyingOnTicket ? <><div className="inbox-reply-context"><MarketingIcon name="reply"/><strong>{t("marketing.demo.replyingTo")} · {replyTarget!.author} · <bdi>#{1042 + (activeIndex ?? 0)}</bdi></strong>{currentView === "groups" && <button type="button" className="inbox-icon-button" title={t("marketing.demo.clearQuote")} aria-label={t("marketing.demo.clearQuote")} onClick={() => setTicketReply(null)}><MarketingIcon name="close"/></button>}</div><blockquote aria-label={`${t("marketing.demo.replyingTo")} · ${replyTarget!.author}`}><span>{replyTarget!.text}</span></blockquote></> : <span>{currentView === "tickets" ? senderLabel : currentSender === "customer" ? t("marketing.demo.customerHint", { rule: ruleSummary }) : t("marketing.demo.groupOnly")}</span>}</div>
            <label className="wx-visually-hidden" htmlFor="demo-reply">{composerLabel}</label><textarea id="demo-reply" ref={composer} rows={1} maxLength={500} value={draft} placeholder={composerLabel} onChange={event => { setSendError(false); setDrafts(current => ({ ...current, [draftKey]: event.target.value })); }}/><button type="submit" className="wx-button wx-button-primary" title={t(replyingOnTicket ? "marketing.inbox.send" : "marketing.demo.sendMessage")} aria-label={t(replyingOnTicket ? "marketing.inbox.send" : "marketing.demo.sendMessage")} disabled={!draft.trim()}><MarketingIcon name="arrow"/></button>
          </form>
        </section> : <div className="inbox-empty inbox-empty-detail"><p>{t("marketing.demo.empty")}</p><button type="button" className="wx-button" onClick={clearFilters}>{t("marketing.demo.clear")}</button></div>}
      </div>
      <span className="wx-visually-hidden" role="status">{announcement}</span>
    </div>
    <figcaption>{t("marketing.inbox.caption")}</figcaption>
  </figure>;
}

function DemoMessage({ author, roleLabel, text, time, quote, note, triggerLabel, triggerRanges = [], outbound = false }: { author: string; roleLabel: string; text: string; time: string; quote?: ReactNode; note?: ReactNode; triggerLabel?: string; triggerRanges?: HistoryMessage["triggerRanges"]; outbound?: boolean }) {
  return <div className={`inbox-message${outbound ? " inbox-message-outbound" : ""}${triggerLabel ? " inbox-message-trigger" : ""}`}><span className="inbox-avatar" aria-hidden="true">{author.slice(0, 1)}</span><div><div className="inbox-message-meta"><strong>{author}</strong><span className="inbox-author-role">{roleLabel}</span><time>{time}</time>{triggerLabel && <span className="inbox-trigger-label"><MarketingIcon name="settings"/>{triggerLabel}</span>}</div><div className="inbox-bubble">{quote && <blockquote>{quote}</blockquote>}<p>{triggerRanges.map((range, index) => <Fragment key={range.start}>{text.slice(triggerRanges[index - 1]?.end ?? 0, range.start)}<mark>{text.slice(range.start, range.end)}</mark></Fragment>)}{text.slice(triggerRanges.at(-1)?.end ?? 0)}{outbound && <> <MarketingIcon name="check"/></>}</p></div>{note && <div className="inbox-ticket-note">{note}</div>}</div></div>;
}
