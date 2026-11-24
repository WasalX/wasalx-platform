import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { arabicAutomationMessages } from "../lib/i18n/messages/ar/automation.ts";
import { arabicCaseMessages } from "../lib/i18n/messages/ar/cases.ts";
import { englishAutomationMessages } from "../lib/i18n/messages/en/automation.ts";
import { englishCaseMessages } from "../lib/i18n/messages/en/cases.ts";
import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { createTranslator } from "../lib/i18n/translate.ts";

test("automation, routing, and case dictionaries have exact bilingual key parity", () => {
  assert.deepEqual(
    Object.keys(arabicAutomationMessages).sort(),
    Object.keys(englishAutomationMessages).sort(),
  );
  assert.deepEqual(
    Object.keys(arabicCaseMessages).sort(),
    Object.keys(englishCaseMessages).sort(),
  );

  for (const dictionary of [arabicAutomationMessages, arabicCaseMessages]) {
    const localized = Object.values(dictionary).filter((value) =>
      /[\u0600-\u06ff]/u.test(value),
    );
    assert.ok(
      localized.length / Object.keys(dictionary).length > 0.9,
      "Arabic copy must be localized except for provider names and protocol tokens",
    );
  }
});

test("ticket event workflow and managed group copy retains Arabic text", () => {
  const entries = Object.entries(arabicAutomationMessages).filter(([key]) => key.startsWith("ticketEvent.workspace."));
  entries.push(["tenant.group.configuration.messages.workflowManaged", arabicTenantMessages["tenant.group.configuration.messages.workflowManaged"]]);
  for (const [key, value] of entries) {
    assert.match(value, /[\u0600-\u06ff]/u, key);
    assert.doesNotMatch(value, /[\u2500-\u259f\ufffd]/u, key);
  }
});

test("Arabic operator copy interpolates identifiers without losing the localized sentence", () => {
  const automation = createTranslator(arabicAutomationMessages);
  const englishAutomation = createTranslator(englishAutomationMessages);
  const cases = createTranslator(arabicCaseMessages);

  assert.equal(
    automation("routing.detail.title", { name: "ACME", version: "٣" }),
    "ACME · الإصدار ٣",
  );
  assert.equal(cases("cases.count", { visible: "٢", total: "٥" }), "٢ من ٥");
  assert.match(automation("bot.command.handoffHelp"), /من دون إعادة إرسال/u);
  assert.match(automation("bot.flow.engineNotice"), /يدير WasalX تدفق البوت هذا بالكامل/u);
  assert.match(cases("cases.dialog.reauthenticate"), /المصادقة/u);
  assert.equal(englishAutomation("routing.versions.createdAt"), "Created");
  assert.equal(automation("routing.versions.createdAt"), "تاريخ الإنشاء");
});

test("localized operator surfaces declare direction, use native formatters, and keep case CSS logical", async () => {
  const [bot, routing, cases, styles] = await Promise.all([
    readFile(new URL("../app/BotAutomation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ClientRouting.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/CaseLifecycle.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/CaseLifecycle.module.css", import.meta.url),
      "utf8",
    ),
  ]);

  for (const source of [bot, routing, cases]) {
    assert.match(source, /useI18n/);
    assert.match(source, /dir=\{direction\}/);
    assert.match(source, /format(?:DateTime|Number|RelativeTime)/);
  }
  assert.match(bot, /t\("bot\.flow\.engineNotice"\)/u);
  assert.match(cases, /<bdi>/);
  assert.match(cases, /<bdi dir="auto">\{row\.group_name\}<\/bdi>/u);
  assert.match(cases, /\/api\/cases\?limit=200&before=/u);
  assert.match(cases, /cases\.loadOlder/u);
  assert.match(
    styles,
    /border-inline-end|padding-inline|margin-inline|text-align: end/u,
  );
  assert.doesNotMatch(
    styles,
    /(?:border|margin|padding)-(?:left|right)|text-align:\s*(?:left|right)/u,
  );
  assert.doesNotMatch(styles, /font(?:-size|):[^;]*(?:10|11)px/u);
  assert.match(styles, /font-size: var\(--wx-font-size-1\)/u);
});

test("operator failures and unknown states never expose raw internal copy", async () => {
  const [bot, routing, cases, shell, styles, operatorUi] = await Promise.all([
    readFile(new URL("../app/BotAutomation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ClientRouting.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/CaseLifecycle.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/WasalXApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/operator-ui.ts", import.meta.url), "utf8"),
  ]);

  assert.match(bot, /localizedUiError\(locale, \{ status: response\.status, code: body\.code \}\)\.message/u);
  assert.doesNotMatch(bot, /body\.(?:error|message)/u);
  assert.match(routing, /operatorResponseFailure\(response, requestError\(response\.status\)\)/u);
  assert.match(routing, /code === "UNKNOWN" \? fallback : localizedUiError\(locale, \{ code \}\)\.message/u);
  assert.doesNotMatch(routing, /body\.(?:error|message)/u);
  assert.match(cases, /throw await operatorResponseFailure\(response,[\s\S]*locale\)/u);
  assert.doesNotMatch(cases, /body\.(?:error|message)/u);
  assert.match(operatorUi, /localizedUiError\(locale, \{ status: response\.status, code: body\.code \}\)/u);
  assert.match(operatorUi, /Object\.assign\(operatorLocalFailure\(localized\.message \|\| fallback\), \{ code: localized\.code \}\)/u);
  assert.doesNotMatch(operatorUi, /body\.(?:error|message)/u);
  assert.match(bot, /return key \? t\(key\) : t\("tenant\.status\.unknown"\)/u);
  assert.match(routing, /t\("routing\.clients\.unknownMatcher"\)/u);
  assert.match(routing, /return key \? t\(key\) : t\("tenant\.status\.unknown"\)/u);
  assert.match(cases, /\? styles\[normalized as "open" \| "resolved" \| "detached"\][\s\S]*: ""/u);
  assert.match(cases, /"cases\.state\.unknown"/u);
  assert.match(shell, /function ruleReadinessIssue/u);
  assert.match(shell, /tenant\.rules\.readiness\.issue\.unknown/u);
  assert.doesNotMatch(shell, /String\(item\.message\)|label\(item\.code\)/u);
  assert.match(styles, /\.routing-table-wrap:focus-visible\{outline:2px solid var\(--accent\)/u);
  assert.doesNotMatch(styles, /var\(--focus\)/u);

  for (const dictionary of [englishTenantMessages, arabicTenantMessages]) {
    assert.ok(dictionary["tenant.rules.readiness.issue.noEnabledRules"]);
    assert.ok(dictionary["tenant.rules.readiness.issue.savedExampleMismatch"]);
    assert.ok(dictionary["tenant.rules.readiness.issue.unknown"]);
  }
  assert.equal(englishTenantMessages["tenant.description.cases"], "See current and past links between group references and support cases.");
  assert.match(arabicTenantMessages["tenant.description.cases"], /[\u0600-\u06ff]/u);
  assert.equal(englishAutomationMessages["routing.clients.unknownMatcher"], "Unavailable match type");
  assert.match(arabicAutomationMessages["routing.clients.unknownMatcher"], /[\u0600-\u06ff]/u);
  assert.equal(englishCaseMessages["cases.state.unknown"], "Status unavailable");
  assert.match(arabicCaseMessages["cases.state.unknown"], /[\u0600-\u06ff]/u);
});

test("workflow counts use singular English and retain disabled and legacy states", async () => {
  const [source, ts, format] = await Promise.all([
    readFile(new URL("../app/BotAutomation.tsx", import.meta.url), "utf8"),
    import("typescript"), import("../lib/i18n/format.ts"),
  ]);
  const parsed = ts.default.createSourceFile("BotAutomation.tsx", source, ts.default.ScriptTarget.Latest, true, ts.default.ScriptKind.TSX);
  const declaration = parsed.statements.find(node => ts.default.isFunctionDeclaration(node) && node.name?.text === "keepOpenPolicySummary");
  assert.ok(declaration);
  const compiled = ts.default.transpileModule(declaration.getText(parsed), { compilerOptions: { target: ts.default.ScriptTarget.ES2022 } }).outputText;
  const summary = new Function("formatNumber", `${compiled};return keepOpenPolicySummary;`)(format.formatNumber);
  for (const [locale, dictionary] of [["en", englishAutomationMessages], ["ar", arabicAutomationMessages]]) {
    const t = createTranslator(dictionary);
    const policy = { mainMenu: true, customerResolution: false };
    for (const minutes of [1, 2, 120]) {
      const actual = summary({ keepOpenPolicy: { ...policy, humanReplyPauseMinutes: minutes } }, locale, t);
      assert.equal(actual, t(minutes === 1 ? "bot.keepOpen.summaryOne" : "bot.keepOpen.summary", { minutes: format.formatNumber(minutes, locale), menu: t("bot.keepOpen.available"), resolution: t("bot.keepOpen.unavailable") }));
      if (locale === "en") assert.match(actual, new RegExp(`^Return after ${minutes} ${minutes === 1 ? "minute;" : "minutes;"}`, "u"));
    }
    assert.equal(summary(null, locale, t), t("bot.keepOpen.existing"));
    assert.equal(summary({ keepOpenPolicy: { ...policy, humanReplyPauseMinutes: null } }, locale, t), t("bot.keepOpen.summaryNoReturn", { menu: t("bot.keepOpen.available"), resolution: t("bot.keepOpen.unavailable") }));
    for (const count of [0, 1, 2]) {
      const preview = t("ticketEvent.preview.summary", { count, steps: count, skipped: count });
      assert.doesNotMatch(preview, /\{(?:count|steps|skipped)\}/u);
      if (locale === "en") assert.equal(preview, `Actions planned: ${count}; steps: ${count}; messages skipped: ${count}.`);
    }
  }
});

test("workflow step labels disambiguate duplicate types and use each version's own order", async () => {
  const [source, ts, format] = await Promise.all([
    readFile(new URL("../app/BotAutomation.tsx", import.meta.url), "utf8"),
    import("typescript"), import("../lib/i18n/format.ts"),
  ]);
  const parsed = ts.default.createSourceFile("BotAutomation.tsx", source, ts.default.ScriptTarget.Latest, true, ts.default.ScriptKind.TSX);
  const names = ["nodeTitle", "workflowStepLabel", "nodeDescription", "comparisonSettingValue", "isolate"];
  const declarations = names.map(name => {
    const declaration = parsed.statements.find(node => ts.default.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, name);
    return declaration.getText(parsed);
  });
  const compiled = ts.default.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.default.ScriptTarget.ES2022 } }).outputText;
  const helpers = new Function("formatNumber", `${compiled};return {workflowStepLabel,nodeDescription,comparisonSettingValue,isolate};`)(format.formatNumber);
  const nodes = [
    { id: "machine_action", type: "action", actionId: "approved.lookup", onSuccess: "machine_alpha", onFailure: "machine_beta" },
    { id: "machine_alpha", type: "send_text", text: "Repeated message", next: "machine_end" },
    { id: "machine_beta", type: "send_text", text: "Repeated message", next: "machine_end" },
    { id: "machine_menu", type: "choice", prompt: "Choose", options: [{ id: "sales", label: "Sales", next: "machine_alpha" }] },
    { id: "machine_end", type: "end" },
  ];
  const before = { nodes, start: "machine_action", mainMenuNodeId: "machine_menu", entryCommands: [{ aliases: ["Sales"], target: "machine_alpha", enabled: true }] };
  const after = { ...before, nodes: [nodes[2], nodes[3], nodes[4], nodes[0], nodes[1]] };
  const snapshots = [JSON.stringify(before), JSON.stringify(after)];
  for (const [locale, dictionary] of [["en", englishAutomationMessages], ["ar", arabicAutomationMessages]]) {
    const t = createTranslator(dictionary);
    const label = (number, type) => t("ticketEvent.stepLabel", { number: format.formatNumber(number, locale), type: t(`bot.node.title.${type}`) });
    for (const [definition, alpha, beta, menu, action] of [[before, 2, 3, 4, 1], [after, 5, 1, 2, 4]]) {
      const alphaLabel = label(alpha, "sendText"), betaLabel = label(beta, "sendText");
      assert.notEqual(alphaLabel, betaLabel);
      assert.equal(helpers.workflowStepLabel("machine_alpha", definition, "start", locale, t), alphaLabel);
      assert.equal(helpers.workflowStepLabel("machine_beta", definition, "start", locale, t), betaLabel);
      assert.equal(helpers.workflowStepLabel(null, definition, "start", locale, t), t("bot.conversations.start"));
      assert.equal(helpers.workflowStepLabel("", definition, "end", locale, t), t("bot.conversations.end"));
      assert.equal(helpers.workflowStepLabel("machine_missing", definition, "start", locale, t), t("bot.conversations.stepUnavailable"));
      assert.equal(helpers.workflowStepLabel("machine_alpha", null, "start", locale, t), t("bot.conversations.stepUnavailable"));
      const description = helpers.nodeDescription(nodes[0], locale, t, [], definition.nodes);
      assert.equal(description, t("bot.node.description.action", { action: helpers.isolate("approved.lookup"), success: helpers.isolate(alphaLabel), failure: helpers.isolate(betaLabel) }));
      const entrySummary = helpers.comparisonSettingValue("entryCommands", "", definition, locale, t);
      assert.equal(entrySummary, `${helpers.isolate("Sales")} ${locale === "ar" ? "←" : "→"} ${helpers.isolate(alphaLabel)} · ${t("bot.entry.enabled")}`);
      assert.equal(helpers.comparisonSettingValue("start", definition.start, definition, locale, t), label(action, "action"));
      assert.equal(helpers.comparisonSettingValue("mainMenuNodeId", "", definition, locale, t).split(" · ")[0], label(menu, "choice"));
      assert.doesNotMatch(`${description} ${entrySummary}`, /machine_/u);
    }
  }
  assert.deepEqual([JSON.stringify(before), JSON.stringify(after)], snapshots);
});

test("plugin credential instructions distinguish private token entry from saved references", () => {
  assert.doesNotMatch(englishAutomationMessages["bot.actionForm.help"], /never entered/iu);
  assert.match(englishAutomationMessages["plugins.form.credentialHelp"], /token itself, not a secret reference/u);
  assert.match(englishAutomationMessages["plugins.form.credentialRotateHelp"], /Leave blank.*new private token/u);
  assert.match(englishAutomationMessages["plugins.form.connectAccountHelp"], /Notion workspace.*private token.*recovery/u);
  assert.match(arabicAutomationMessages["plugins.form.credentialHelp"], /رمز الوصول الخاص نفسه، وليس مرجع سر/u);
  assert.match(arabicAutomationMessages["bot.actionForm.help"], /تُخزّن.*بأمان/u);
});
