import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import assert from "node:assert/strict";
import test from "node:test";
import { createDemoWorkspace, receiveGroupMessage, validDemoRule, type DemoRule, type DemoWorkspace } from "../app/marketing-workspace.ts";
import { englishMarketingMessages } from "../lib/i18n/messages/en/marketing.ts";
import { arabicMarketingMessages } from "../lib/i18n/messages/ar/marketing.ts";
import { createTranslator } from "../lib/i18n/translate.ts";

const seed = () => createDemoWorkspace(createTranslator(englishMarketingMessages));
const receive = (state: DemoWorkspace, group: number, text: string) => receiveGroupMessage(state, group, text, "Ahmed", "10:00");
const activate = (state: DemoWorkspace, group: number, rule: Partial<DemoRule>): DemoWorkspace => ({ ...state, groups: state.groups.map((item, index) => index === group ? { ...item, rule: { ...item.rule, ...rule } } : item) });

test("six populated groups have independent rules, owners and open/closed ticket histories", () => {
  const state = seed();
  assert.deepEqual(state.groups.map(group => group.members), [25, 32, 28, 36, 42, 26]);
  assert.equal(state.tickets.length, 18);
  assert.equal(state.tickets.filter(ticket => ticket.icon === "email").length, 4);
  state.groups.forEach((group, index) => {
    assert.equal(validDemoRule(group.rule), true);
    assert.deepEqual(state.tickets.filter(ticket => ticket.group === index).map(ticket => ticket.status), ["open", "closed"]);
  });
  state.tickets.forEach((ticket, index) => assert.ok(state.history.some(message => message.tickets.includes(index))));
});

test("every bilingual sample has chronological, correctly linked content and matching trigger references", () => {
  for (const messages of [englishMarketingMessages, arabicMarketingMessages]) {
    const state = createDemoWorkspace(createTranslator(messages));
    for (const message of state.history) {
      if (!message.outbound) assert.ok([messages["marketing.inbox.ahmed"], messages["marketing.inbox.mona"]].some(name => name === message.author));
      else if (message.author !== messages["marketing.channels.bot"]) assert.ok(message.tickets.every(index => state.tickets[index].owner === message.author));
    }
    for (let group = 0; group < state.groups.length; group++) {
      const history = state.history.filter(message => message.group === group);
      assert.deepEqual(history.map(message => message.time), history.map(message => message.time).sort());
    }
    state.tickets.forEach((ticket, index) => {
      const thread = state.history.filter(message => message.tickets.includes(index));
      assert.ok(thread.length > 0);
      assert.ok(thread.every(message => message.group === ticket.group));
      if (ticket.group !== null) {
        assert.notEqual(ticket.title, ticket.reference);
        assert.ok(thread[0].text.includes(ticket.reference!));
        const replay = receive(state, ticket.group, thread[0].text);
        assert.equal(replay.tickets.length, state.tickets.length);
        assert.deepEqual(replay.history.at(-1)!.tickets, [index]);
      }
      if (ticket.status === "closed") {
        assert.equal(thread.at(-1)!.outbound, true);
        assert.equal(thread.at(-1)!.author, ticket.owner);
      }
      thread.forEach((message, position) => {
        if (message.quote) assert.ok(thread.slice(0, position).some(previous => previous.author === message.quote!.author && previous.text === message.quote!.text));
        if (message.outbound || message.group === null || message.quote) assert.equal(message.triggerRanges?.length ?? 0, 0);
      });
      if (ticket.group !== null) assert.deepEqual(thread[0].triggerRanges?.map(range => thread[0].text.slice(range.start, range.end)), [ticket.reference]);
    });
    const bot = state.history.filter(message => message.tickets.includes(1));
    assert.ok(bot.some(message => message.author === messages["marketing.channels.bot"]));
    assert.equal(bot.at(-1)!.author, state.tickets[1].owner);
  }
});

test("activation preserves history and affects only future messages in its own group", () => {
  const before = seed();
  const next = activate(before, 0, { count: "7" });
  assert.equal(next.history, before.history);
  assert.deepEqual(next.history.find(message => message.tickets.includes(0))!.triggerRanges, before.history.find(message => message.tickets.includes(0))!.triggerRanges);
  assert.equal(next.tickets, before.tickets);
  assert.equal(next.groups[1], before.groups[1]);
  const noMatch = receive(next, 0, "Old reference 1234567890");
  assert.deepEqual(noMatch.history.at(-1)?.tickets, []);
  assert.equal(noMatch.tickets.length, 18);
  const match = receive(noMatch, 0, "New reference 1234567");
  assert.deepEqual(match.history.at(-1)?.tickets, [18]);
  assert.equal(match.tickets[18].owner, before.groups[0].owner);
  assert.equal(match.history[0], before.history[0]);
});

test("trigger highlights retain exact customer text across normalization, repeats and rule changes", () => {
  const cases: [Partial<DemoRule>, string, string[]][] = [
    [{ count: "10" }, "Parcel ١٢٣٤٥٦٧٨٩٠", ["١٢٣٤٥٦٧٨٩٠"]],
    [{ count: "10" }, "Parcel ۱۲۳۴۵۶۷۸۹۰", ["۱۲۳۴۵۶۷۸۹۰"]],
    [{ count: "10" }, "📦\u200b 12345\u200b67890", ["12345\u200b67890"]],
    [{ kind: "prefix", prefix: "WX-", count: "4" }, "📦 wx-٠٠١٢", ["wx-٠٠١٢"]],
    [{ kind: "contains", text: "Café" }, "A Cafe\u0301 request", ["Cafe\u0301"]],
    [{ kind: "contains", text: "ORDER" }, "<b>order</b> and ORDER", ["order", "ORDER"]],
    [{ count: "10" }, "9876543210 2222222222 2222222222", ["9876543210", "2222222222", "2222222222"]],
    [{ count: "10" }, "Nothing to match", []],
    // Shared matcher case-expansion offsets are not reliable; do not highlight an unrelated slice.
    [{ kind: "contains", text: "bc" }, "ß abc z", []],
    [{ kind: "contains", text: "bc" }, "ß abc", []],
  ];
  for (const [rule, text, expected] of cases) {
    const state = receive(activate(seed(), 0, rule), 0, text);
    const message = state.history.at(-1)!;
    assert.equal(message.text, text);
    assert.deepEqual(message.triggerRanges?.map(range => text.slice(range.start, range.end)), expected);
    assert.equal(activate(state, 0, { count: "7" }).history.at(-1), message);
  }
});

test("normalized repeats reuse a group reference, closed matches reopen, multiple references all link", () => {
  const before = seed();
  const next = receive(before, 0, "١٢٣٤٥٦٧٨٩٠ 9876543210 2222222222 2222222222");
  assert.deepEqual(next.history.at(-1)?.tickets, [0, 4, 18]);
  assert.equal(next.tickets.length, 19);
  assert.equal(next.tickets[4].status, "open");
  assert.equal(before.tickets[4].status, "closed");
  const repeat = receive(activate(next, 0, { kind: "contains", text: "1234567890" }), 0, "Same 1234567890");
  assert.deepEqual(repeat.history.at(-1)?.tickets, [0]);
  assert.equal(repeat.tickets.length, 19);
  const otherGroup = receive(activate(repeat, 1, { kind: "digits", count: "10" }), 1, "1234567890");
  assert.deepEqual(otherGroup.history.at(-1)?.tickets, [19]);
  assert.equal(otherGroup.tickets[19].group, 1);
});

test("configurable rules validate counts and literal prefix boundaries", () => {
  const state = seed(), rule = state.groups[0].rule;
  for (const count of ["", "0", "65", "1.5"]) assert.equal(validDemoRule({ ...rule, count }), false);
  for (const count of ["1", "7", "64"]) assert.equal(validDemoRule({ ...rule, count }), true);
  assert.equal(validDemoRule({ ...rule, kind: "contains", text: "\u200b" }), false);
  assert.equal(validDemoRule({ ...rule, kind: "prefix", prefix: " " }), false);
  const configured = activate(state, 0, { kind: "prefix", prefix: "WX-", count: "4" });
  assert.deepEqual(receive(configured, 0, "WX-٠٠١٢ wx-0012").history.at(-1)?.tickets, [18]);
  assert.deepEqual(receive(configured, 0, "aWX-0012 WX-00123").history.at(-1)?.tickets, []);
  assert.deepEqual(receive(activate(state, 0, { kind: "contains", text: "٤٨٢١" }), 0, "4821").history.at(-1)?.tickets, []);
  assert.equal(validDemoRule({ ...rule, kind: "prefix", prefix: "X".repeat(65) }), false);
  assert.throws(() => receive(activate(state, 0, { count: "3" }), 0, Array.from({ length: 101 }, (_, index) => String(100 + index)).join(" ")), RangeError);
  assert.equal(state.tickets.length, 18);
});

test("marketing channels render an authored decorative placeholder and preserve ordinary icons", () => {
  const source = readFileSync(new URL("../app/MarketingIcon.tsx", import.meta.url), "utf8");
  const emitted = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } });
  const exports: Record<string, any> = {};
  new Function("require", "exports", emitted.outputText)(createRequire(import.meta.url), exports);
  const paths = new Set<string>();
  for (const name of ["slack", "whatsapp", "x", "tiktok", "instagram"]) {
    const html = renderToStaticMarkup(createElement(exports.MarketingIcon, { name }));
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /width="24" height="24" viewBox="0 0 24 24"/);
    assert.match(html, /fill="none" stroke="currentColor"/);
    assert.match(html, new RegExp(`marketing-icon-${name}`));
    paths.add(html.match(/<path d="([^"]+)"/)![1]);
  }
  assert.deepEqual([...paths], ["M4 5h16v14H4ZM8 9h8M8 13h5"]);
  const ordinary = renderToStaticMarkup(createElement(exports.MarketingIcon, { name: "arrow" }));
  assert.match(ordinary, /d="M4 12h16m-6-6 6 6-6 6"/);
});
