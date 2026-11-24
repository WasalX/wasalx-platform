import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatNumber } from "../lib/i18n/format.ts";

test("rule inspection renders saved parameters, escaped literals, and explicit missing values in both locales", async () => {
  const source = readTenantPortalSource();
  const parsed = ts.createSourceFile("WasalXApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.match(source, /<RuleMatcherCondition rule=\{selectedRule\} locale=\{locale\} t=\{t\} \/>/u);
  assert.ok(!parsed.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === "RulePrefixFacts"));
  const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "RuleMatcherCondition");
  assert.ok(component);
  const compiled = ts.transpileModule(component.getText(parsed), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
  const RuleMatcherCondition = new Function("React", "formatNumber", `${compiled};return RuleMatcherCondition;`)(React, formatNumber);
  for (const [locale, dictionary] of [["en", englishTenantMessages], ["ar", arabicTenantMessages]]) {
    const t = createTranslator(dictionary);
    const render = rule => renderToStaticMarkup(React.createElement(RuleMatcherCondition, { rule, locale, t }));
    const rule = { matcherType: "prefix_length", prefix: "WXQA<literal>", digitLength: 6, pattern: "unused" };
    const prefixed = render(rule);
    assert.ok(prefixed.includes(dictionary["tenant.rules.modal.prefix"]));
    assert.match(prefixed, /<bdi dir="auto">WXQA&lt;literal&gt;<\/bdi>/u);
    assert.ok(prefixed.includes(dictionary["tenant.rules.modal.digitLength"]));
    assert.ok(prefixed.includes(formatNumber(6, locale)));
    assert.ok(!prefixed.includes("unused"));
    assert.deepEqual(rule, { matcherType: "prefix_length", prefix: "WXQA<literal>", digitLength: 6, pattern: "unused" });
    const exact = render({ matcherType: "exact_length", prefix: null, digitLength: 8 });
    assert.ok(exact.includes(formatNumber(8, locale)));
    assert.ok(!exact.includes(dictionary["tenant.rules.modal.prefix"]));
    const missingPrefix = render({ ...rule, prefix: null, digitLength: null });
    const missingExact = render({ matcherType: "exact_length", digitLength: null });
    assert.equal(missingPrefix.split(t("tenant.rules.inspector.notConfigured")).length - 1, 2);
    assert.equal(missingExact.split(t("tenant.rules.inspector.notConfigured")).length - 1, 1);
    assert.doesNotMatch(missingPrefix + missingExact, /ABC|111111|>7<|>10</u);
    assert.ok(render({ ...rule, prefix: "", digitLength: 0 }).includes(formatNumber(0, locale)));
    for (const matcherType of ["starts_with", "contains", "advanced"]) {
      const literal = render({ matcherType, pattern: "<order&ref>" });
      assert.ok(literal.includes("&lt;order&amp;ref&gt;"));
      assert.ok(!literal.includes("<order&ref>"));
      assert.equal(literal.includes("<details"), matcherType === "advanced");
      if (matcherType === "advanced") assert.match(literal, /^<details[^>]*><summary>/u);
    }
  }
});

test("audit events have distinct localized actions while direct-flow events retain their category", async () => {
  const source = readTenantPortalSource();
  const parsed = ts.createSourceFile("WasalXApp.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helper = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "friendlyAuditAction");
  assert.ok(helper);
  const compiled = ts.transpileModule(helper.getText(parsed), {}).outputText;
  const friendlyAuditAction = new Function(`${compiled};return friendlyAuditAction;`)();
  const actions = {
    "connection.meta_number_released": "tenant.audit.action.metaNumberReleased",
    "bot_action.created": "tenant.audit.action.pluginActionCreated",
    "bot_action.updated": "tenant.audit.action.pluginActionUpdated",
    "bot_action.restored": "tenant.audit.action.pluginActionRestored",
    "bot_action.credential_staged": "tenant.audit.action.pluginCredentialPrepared",
    "bot_action.qualification_queued": "tenant.audit.action.pluginActionTested",
    "bot_action.future_event": "tenant.audit.category.plugin",
    "group_workspace.ticket_linked": "tenant.audit.action.groupTicketLinked",
    "group_workspace.read": "tenant.audit.action.groupRead",
    "group_workspace.message_queued": "tenant.audit.action.groupMessageQueued",
    "group_workspace.reaction_queued": "tenant.audit.action.groupReactionQueued",
    "group_workspace.reaction_removal_queued": "tenant.audit.action.groupReactionRemovalQueued",
    "workspace_email.route_pinned": "tenant.audit.action.mailRoutePinned",
    "workspace_email.route_applied": "tenant.audit.action.mailRouteApplied",
    "workspace_email.route_manually_overridden": "tenant.audit.action.mailRouteOverridden",
    "delivery.retry_requested_from_workspace": "tenant.audit.action.workspaceDeliveryRetry",
  };
  for (const dictionary of [englishTenantMessages, arabicTenantMessages]) {
    const t = createTranslator(dictionary);
    for (const [action, key] of Object.entries(actions)) {
      assert.ok(dictionary[key]);
      assert.equal(friendlyAuditAction(action, t), dictionary[key]);
      assert.notEqual(friendlyAuditAction(action, t), dictionary["tenant.audit.category.bot"]);
    }
    assert.equal(friendlyAuditAction("bot_flow.updated", t), dictionary["tenant.audit.category.bot"]);
    assert.equal(friendlyAuditAction("conversation.created", t), dictionary["tenant.audit.category.bot"]);
    assert.equal(friendlyAuditAction("bot_actionish.updated", t), dictionary["tenant.audit.category.bot"]);
    assert.equal(friendlyAuditAction("unknown.updated", t), dictionary["tenant.audit.category.workspace"]);
  }
});

test("known uncertain and suspended states retain distinct truthful labels", async () => {
  const source=readTenantPortalSource();
  const parsed=ts.createSourceFile("WasalXApp.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const [helper,component]=["statusPresentation","Status"].map(name=>parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name));
  assert.ok(helper&&component);
  const compiled=ts.transpileModule(`${helper.getText(parsed)}\n${component.getText(parsed)}`.replace(/^export /gmu,""),{compilerOptions:{jsx:ts.JsxEmit.React}}).outputText;
  // The connections state filter reuses the row badge label, so a revoked row and its filter option read the same.
  assert.match(source,/<option key=\{value\} value=\{value\}>\{t\(statusPresentation\(value\)\[0\]\)\}<\/option>/u);
  for(const dictionary of [englishTenantMessages,arabicTenantMessages]){
    const Status=new Function("useI18n","React",`${compiled};return Status;`)(()=>({t:key=>dictionary[key]}),React);
    const label=value=>Status({value}).props.children[1];
    assert.equal(label("OUTCOME_UNKNOWN"),dictionary["tenant.status.outcomeUnknown"]);
    assert.equal(label("SUSPENDED"),dictionary["tenant.status.suspended"]);
    assert.equal(label("SENT"),dictionary["tenant.status.sent"]);
    assert.equal(label("CONSENT_REQUIRED"),dictionary["common.status.inactive"]);
    assert.equal(label("UNRECOGNIZED_STATE"),dictionary["tenant.status.unknown"]);
    assert.equal(label("REVOKED"),dictionary["tenant.status.revoked"]);
    assert.notEqual(label("OUTCOME_UNKNOWN"),label("SENT"));
    assert.notEqual(label("OUTCOME_UNKNOWN"),label("UNRECOGNIZED_STATE"));
  }
});

test("tenant shell uses the locale provider, explicit render time, and document direction", async () => {
  const [source, page] = await Promise.all([
    readTenantPortalSource(),
    readFile(new URL("../app/app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<I18nProvider/);
  assert.match(source, /const \{\s*t,\s*locale,\s*direction\s*\}\s*=\s*useI18n\(\)/u);
  assert.match(source, /data-locale=\{locale\}/u);
  assert.match(source, /lang=\{locale\}/u);
  assert.match(source, /dir=\{direction\}/u);
  assert.match(source, /formatRelativeTime\(date, locale, renderedAt\)/u);
  assert.match(source, /\[\["inactive", "disabled", "consent_required"\], "common\.status\.inactive"/u);
  assert.match(source, /\[\["succeeded", "completed"\], "tenant\.status\.completed"/u);
  assert.match(source, /\[\["released"\], "tenant\.status\.released"/u);
  assert.doesNotMatch(source, /useSyncExternalStore/u);
});

test("tenant errors are mapped to stable localized copy instead of raw provider detail", async () => {
  const source = readTenantPortalSource();
  assert.match(source, /localizedUiError\(locale, \{ status: response\.status, code: body\.code \}\)\.message/u);
  assert.match(source, /أعد التحقق/u);
  assert.doesNotMatch(source, /body\.(?:message|error)/u);
  assert.doesNotMatch(source, /\{String\((?:detail\.)?(?:action_reason|latest_operation_safe_error|safe_error|error_message)\)\}/u);
  assert.doesNotMatch(source, /<p>\{(?:request|detail)\.safe_error\}<\/p>/u);
  assert.doesNotMatch(source, /privacy-request-error">\{request\.safe_error\}/u);
});

test("tenant catalogs retain exact bilingual parity and meaningful Arabic shell copy", () => {
  assert.deepEqual(
    Object.keys(arabicTenantMessages).sort(),
    Object.keys(englishTenantMessages).sort(),
  );
  const en = createTranslator(englishTenantMessages);
  const ar = createTranslator(arabicTenantMessages);
  assert.equal(en("tenant.navigation.connections"), "Connections");
  assert.equal(ar("tenant.navigation.connections"), "الاتصالات");
  assert.equal(ar("tenant.errors.privacyReview"), "يحتاج طلب الخصوصية هذا إلى المراجعة قبل أن يتمكن من المتابعة.");
  assert.notEqual(en("tenant.title.overview"), ar("tenant.title.overview"));
});

test("tenant routes contain no unreviewed visible English literals", async () => {
  const source = readTenantPortalSource();
  const file = ts.createSourceFile(
    "app/WasalXApp.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visibleAttributes = new Set(["alt", "aria-label", "placeholder", "title"]);
  // These are product names, locale-independent examples, or exact operator
  // confirmation tokens validated by the API. They must remain unchanged.
  const reviewedBrandTerms = new Set([
    "{{message.argument}}",
    "+9665XXXXXXXX",
    "ABC",
    "N",
    "RETRY",
    "ROLLBACK",
    "VIP-",
    "W",
    "WX",
    "WasalX",
    "WhatsApp",
    "· WasalX",
  ]);
  const findings = [];
  const line = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const record = (node, value) => {
    const normalized = value.replace(/\s+/gu, " ").trim();
    if (/[A-Za-z]{2}/u.test(normalized) && !reviewedBrandTerms.has(normalized)) {
      findings.push(`${line(node)}: ${normalized}`);
    }
  };
  const inspectRenderedExpression = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      record(node, node.head.text + node.templateSpans.map((span) => span.literal.text).join(""));
    } else if (ts.isConditionalExpression(node)) {
      inspectRenderedExpression(node.whenTrue);
      inspectRenderedExpression(node.whenFalse);
    } else if (ts.isParenthesizedExpression(node)) {
      inspectRenderedExpression(node.expression);
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) record(node, node.text);
    if (
      ts.isJsxAttribute(node) &&
      visibleAttributes.has(node.name.getText(file)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      record(node, node.initializer.text);
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (!ts.isJsxAttribute(node.parent) || visibleAttributes.has(node.parent.name.getText(file)))
    ) {
      inspectRenderedExpression(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(findings, [], `Unlocalized visible tenant strings:\n${findings.join("\n")}`);
});

test("owner-facing health, access and settings states stay truthful and consistent", async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const source = readTenantPortalSource();
  const [inbox, mailboxes, mailboxAdmin, serviceAccess, routing] = await Promise.all(["app/Inbox.tsx",
    "app/MailboxSettings.tsx", "app/MailboxAdministration.tsx", "app/ServiceAccess.tsx", "app/NativeRoutingSync.tsx"].map(read));
  // Zero working connections is never reported as healthy.
  assert.match(source, /const noneWorking = data\.connections\.length > 0 && working === 0;/u);
  assert.match(source, /noneWorking\?t\("tenant\.health\.noWorkingConnections"\):t\("tenant\.overview\.healthy"\)/u);
  assert.match(source, /warn=\{connectionIssues>0\|\|noneWorking\}/u);
  // Only pending invitations show an expiry; generic audit actors share one mark.
  assert.match(source, /invitation\.state === "PENDING" \? <small>\{t\("tenant.[a-z]+.invitations.expires"\)\}/u);
  assert.match(source, /: "WX"\}\s*<\/span>\s*<span className="audit-line"/u);
  // Owners are never told to ask the owner, and a held service is not reported as missing access.
  assert.match(inbox, /return owner \? "inbox\.accessDeniedOwner" : "inbox\.accessDenied";/u);
  assert.match(inbox, /status === 503 \? "inbox\.serviceUnavailable"/u);
  assert.match(source, /owner=\{role === "tenant_owner"\}/u);
  // Settings never label a retry as reloading conversations, nor show an empty state over a load failure.
  for (const file of [mailboxes, mailboxAdmin, serviceAccess]) assert.doesNotMatch(file, /"inbox\.reload"/u);
  assert.match(mailboxes, /!rows\.length && !error \? <p>\{t\("mailboxes\.empty"\)\}/u);
  // Ticket routing shows one state without internal revision counters.
  assert.doesNotMatch(routing, /desiredRevision, locale|nativeRouting\.(?:revisions|notChecked)/u);
  for (const dictionary of [englishTenantMessages, arabicTenantMessages]) {
    for (const key of ["tenant.health.noWorkingConnections", "tenant.rules.matches.one"]) assert.ok(dictionary[key], key);
    assert.doesNotMatch(dictionary["tenant.rules.governedVersion"], /Governed|المحكوم/u);
  }
});
