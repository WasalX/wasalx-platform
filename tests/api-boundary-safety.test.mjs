import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { formatNumber } from "../lib/i18n/format.ts";
import { arabicPlatformMessages } from "../lib/i18n/messages/ar/platform.ts";
import { englishPlatformMessages } from "../lib/i18n/messages/en/platform.ts";
import { createTranslator } from "../lib/i18n/translate.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("logical UI retries retain one idempotency key through every bridge", async () => {
  const [botUi, routingUi, botRoute, bridge, botController, botService, retryRoute, deliveries] = await Promise.all([
    read("app/BotAutomation.tsx"), read("app/ClientRouting.tsx"),
    read("app/api/bot-flows/assignments/[id]/state/route.ts"), read("lib/control-plane-data.ts"),
    read("services/control-api/src/bot-flows.controller.ts"), read("services/control-api/src/bot-flows.service.ts"),
    read("app/api/deliveries/[id]/retry/route.ts"), read("services/control-api/src/deliveries.controller.ts"),
  ]);
  assert.match(botUi,/mutationIntents\.current\.get\(intent\)[\s\S]*mutationIntents\.current\.delete\(intent\)/u);
  assert.match(botUi,/assignments\/\$\{encodeURIComponent[\s\S]*bot\.assignments[\s\S]*true/u);
  assert.match(routingUi,/credentialOperation\.current\?\.fingerprint[\s\S]*credentialOperation\.current=null/u);
  assert.match(routingUi,/mutationKeys\.current\.get\(intent\)[\s\S]*mutationKeys\.current\.delete\(intent\)/u);
  assert.match(botRoute,/request\.headers\.get\("idempotency-key"\)/u);
  assert.match(botRoute,/setBotAssignmentState\([\s\S]*,key\)/u);
  assert.match(bridge,/setBotAssignmentState[\s\S]*headers:\{"idempotency-key":idempotencyKey\}/u);
  assert.match(botController,/assignments\/:id\/state[\s\S]*@Headers\("idempotency-key"\)/u);
  assert.match(botService,/ASSIGNMENT_STATE[\s\S]*withOperation\(client,principal,"ASSIGNMENT_STATE"/u);
  assert.match(retryRoute,/request\.headers\.get\("idempotency-key"\)[\s\S]*retryDelivery\([^)]*key/u);
  assert.match(deliveries,/withOperationReceipt\(client, request\.principal, "DELIVERY_RETRY"[\s\S]*await this\.drain\.wake/u);
});

test("group mutations are revision fenced, immutable, and reject missing keys", async () => {
  const [migration, controller, drawer, bindingRoute, workspaceSettings, workspaceGroup, grants, revoke] = await Promise.all([
    read("services/control-api/migrations/0113_group_binding_revision_and_operation_receipts.sql"),
    read("services/control-api/src/groups.controller.ts"), readTenantPortalSource(),
    read("app/api/groups/[id]/binding/route.ts"), read("app/api/group-workspace/settings/route.ts"),
    read("app/api/group-workspace/groups/[id]/route.ts"), read("app/api/group-workspace/groups/[id]/grants/route.ts"),
    read("app/api/group-workspace/groups/[id]/grants/[grantId]/route.ts"),
  ]);
  assert.match(migration,/ADD COLUMN revision bigint NOT NULL DEFAULT 1/u);
  assert.match(migration,/CREATE TABLE group_binding_versions[\s\S]*UNIQUE \(tenant_id, group_binding_id, revision\)/u);
  assert.match(migration,/group_binding_versions_append_only[\s\S]*app\.reject_audit_mutation/u);
  assert.match(migration,/GROUP_BINDING_SAVE[\s\S]*GROUP_BINDING_TOGGLE[\s\S]*DELIVERY_RETRY/u);
  assert.match(controller,/expectedRevision[\s\S]*Group configuration changed; refresh before saving it/u);
  assert.match(migration,/app\.record_group_binding_version[\s\S]*INSERT INTO group_binding_versions/u);
  assert.match(controller,/recordRevision[\s\S]*app\.record_group_binding_version/u);
  const governance = await read("services/control-api/src/rule-governance.service.ts");
  assert.match(governance,/UPDATE group_bindings[\s\S]*revision=revision\+1[\s\S]*RETURNING id,revision[\s\S]*app\.record_group_binding_version/u);
  assert.match(drawer,/bindingSaveIntent\.current\?\.fingerprint/u);
  assert.match(drawer,/expectedRevision:Number\(detail\?\.binding_revision\?\?0\)/u);
  assert.match(bindingRoute,/request\.headers\.get\("idempotency-key"\)[\s\S]*status:400/u);
  for(const source of [workspaceSettings,workspaceGroup,grants,revoke]){
    assert.match(source,/request\.headers\.get\("idempotency-key"\)/u);
    assert.doesNotMatch(source,/randomUUID/u);
    assert.match(source,/status:400/u);
  }
});

test("group, case, and rule lists expose bounded cursor pagination without changing array responses", async () => {
  const [groups, cases, rules, ruleController, groupRoute, caseRoute, ruleRoute, shell, caseUi] = await Promise.all([
    read("services/control-api/src/groups.controller.ts"), read("services/control-api/src/cases.controller.ts"),
    read("services/control-api/src/rule-governance.service.ts"), read("services/control-api/src/rules.controller.ts"),
    read("app/api/groups/route.ts"), read("app/api/cases/route.ts"), read("app/api/rule-sets/route.ts"),
    readTenantPortalSource(),read("app/CaseLifecycle.tsx"),
  ]);
  assert.match(groups,/@Query\("after"\)[\s\S]*@Query\("q"\)[\s\S]*position\(lower\(\$4\)[\s\S]*LIMIT \$3/u);
  assert.match(cases,/@Query\("before"\)[\s\S]*LIMIT \$3/u);
  assert.match(ruleController,/@Query\("before"\)[\s\S]*@Query\("limit"\)[\s\S]*@Query\("state"\)/u);
  assert.match(rules,/ruleListLimit[\s\S]*LIMIT \$4/u);
  assert.match(groupRoute,/searchParams\.get\("after"\)[\s\S]*searchParams\.get\("q"\)[\s\S]*getGroups\(\{after,limit,query,connectionId\}\)/u);
  assert.match(caseRoute,/searchParams\.get\("before"\)[\s\S]*searchParams\.get\("ticket"\)[\s\S]*getCases\(\{before,limit,ticket\}\)/u);
  assert.match(ruleRoute,/searchParams\.get\("before"\)[\s\S]*getRuleSetVersions\(\{before,state,limit\}\)/u);
  assert.match(shell,/new URLSearchParams\(\{limit:"200",after:String\(after\)\}\)/u);
  assert.match(shell,/GROUP_DISPLAY_PAGE_SIZE=50/u);
  assert.match(shell,/displayedRows=filtered\.slice\(0,visibleGroupCount\)/u);
  assert.match(shell,/visibleGroupCount<filtered\.length/u);
  assert.match(shell,/window\.setTimeout\([\s\S]*\/api\/groups\?\$\{params\}[\s\S]*controller\.abort\(\)/u);
  assert.match(shell,/\/api\/rule-sets\?limit=200&before=/u);
  assert.match(caseUi,/\/api\/cases\?limit=200&before=/u);
});

test("operator-visible API errors never name the control plane (#339)", async () => {
  // Portal routes and their server libraries return these messages to operator screens; the catalogues have their own test.
  // Identifiers and module paths have no spaces; a message that never reaches an operator is listed here.
  const internal = new Set(["lib/data.ts: Use the managed control-plane webhook ingress"]);
  const files = [
    ...(await readdir(new URL("../app/api", import.meta.url), { recursive: true })).map((path) => `app/api/${path.replaceAll("\\", "/")}`),
    ...(await readdir(new URL("../lib", import.meta.url))).map((path) => `lib/${path}`),
  ].filter((path) => /\.tsx?$/u.test(path));
  assert.ok(files.length > 50);
  const findings = [];
  for (const path of files) {
    for (const line of (await read(path)).split("\n")) {
      if (/^\s*(?:\/\/|\*)/u.test(line)) continue;
      for (const [, double, single, template] of line.matchAll(/"([^"\n]* [^"\n]*)"|'([^'\n]* [^'\n]*)'|`([^`\n]* [^`\n]*)`/gu)) {
        const text = double ?? single ?? template;
        if (/control[ -]plane/iu.test(text) && !internal.has(`${path}: ${text}`)) findings.push(`${path}: ${text}`);
      }
    }
  }
  assert.deepEqual(findings, [], "use operator words such as \"the managed service\"");
});

test("a view given an unmapped API error shows the translated fallback, never the API text (#358)", async () => {
  const source = await read("app/platform/PlatformConsole.tsx");
  const parsed = ts.createSourceFile("PlatformConsole.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "Progress");
  assert.ok(component);
  const compiled = ts.transpileModule(component.getText(parsed), { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
  const apiText = "Provisioning step failed after the upstream returned 502";
  for (const [locale, dictionary] of [["en", englishPlatformMessages], ["ar", arabicPlatformMessages]]) {
    const t = createTranslator(dictionary);
    const Progress = new Function("React", "useI18n", "formatNumber", "stateLabel", "styles", `${compiled};return Progress;`)(React, () => ({ locale, t }), formatNumber, (value) => value, {});
    const html = renderToStaticMarkup(React.createElement(Progress, { tenant: { progress_percent: 40, error_code: "UNMAPPED_PROVISIONING_FAILURE", safe_error: apiText } }));
    assert.ok(dictionary["platform.tenants.operationFailed"], `${locale} catalogue has the fallback`);
    assert.ok(html.includes(dictionary["platform.tenants.operationFailed"]), `${locale} shows the fallback`);
    assert.ok(!html.includes(apiText), `${locale} hides the API text`);
  }
});

test("views never render or rethrow an API's own error text (#358)", async () => {
  // API error text is English only. Views show catalogue text: operatorFailureMessage, apiError or a t() key.
  const files = (await readdir(new URL("../app", import.meta.url), { recursive: true }))
    .map((path) => `app/${path.replaceAll("\\", "/")}`)
    .filter((path) => /\.tsx?$/u.test(path) && !path.startsWith("app/api/") && !/\.stories\.tsx$/u.test(path));
  assert.ok(files.length > 40);
  const raw = [
    /\b(?:result|body|payload)\??\.(?:error|message)\b/u, // a parsed response body's own text
    /\{\s*(?:String\()?[\w.?]+\.(?:\w*safe_error|error_message)\)?\s*\}/u, // a stored API error rendered as is
  ];
  const findings = [];
  for (const path of files) {
    (await read(path)).split("\n").forEach((line, index) => {
      if (raw.some((pattern) => pattern.test(line))) findings.push(`${path}:${index + 1}`);
    });
  }
  assert.deepEqual(findings, [], "map the code with operatorFailureMessage or show a catalogue key instead");
});
