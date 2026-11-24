import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  FixtureRuleTestError,
  testFixtureRules,
} from "../lib/fixture-rule-tester.ts";
import { arabicTenantMessages } from "../lib/i18n/messages/ar/tenant.ts";
import { englishTenantMessages } from "../lib/i18n/messages/en/tenant.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import { readTenantPortalSource } from "./helpers/tenant-portal-source.mjs";

const exact = {
  id: "ten",
  name: "Ten digits",
  matcherType: "exact_length",
  pattern: "(?<!\\d)\\d{10}(?!\\d)",
  prefix: null,
  digitLength: 10,
  priority: 1,
  enabled: true,
};

test("fixture preview honors explicit sender policy and rejects invalid inputs", () => {
  for (const sender of ["team", "customer", "unknown"]) {
    for (const teamSenderPolicy of ["include", "exclude"]) {
      const result=testFixtureRules({message:"1234567890",sender,rules:[{...exact,matcherOptions:{teamSenderPolicy}}]});
      assert.equal(result.matches.length,teamSenderPolicy==="exclude"&&sender!=="customer"?0:1);
    }
  }
  assert.throws(()=>testFixtureRules({message:"1234567890",sender:null,rules:[exact]}),FixtureRuleTestError);
  assert.throws(()=>testFixtureRules({message:"1234567890",rules:[{...exact,teamSenderPolicy:"include",matcherOptions:{teamSenderPolicy:"exclude"}}]}),FixtureRuleTestError);
});

test("Workers-safe fixture tester supports deterministic presets and Arabic digits", () => {
  const result = testFixtureRules({
    message: "Cases ١٢٣٤٥٦٧٨٩٠ and ABC۱۲۳۴۵۶۷",
    rules: [
      exact,
      {
        id: "abc",
        name: "ABC",
        matcherType: "prefix_length",
        pattern: "\\bABC\\d{7}\\b",
        prefix: "ABC",
        digitLength: 7,
        priority: 2,
        enabled: true,
      },
    ],
  });
  assert.equal(result.normalized, "Cases 1234567890 and ABC1234567");
  assert.deepEqual(
    result.matches.map((match) => match.normalizedValue),
    ["1234567890", "ABC1234567"],
  );
  assert.deepEqual(
    result.highlights.map((highlight) => result.normalized.slice(highlight.start, highlight.end)),
    ["1234567890", "ABC1234567"],
  );
});

test("fixture tester rejects advanced expressions instead of constructing RegExp", () => {
  assert.throws(
    () => testFixtureRules({
      message: "ABC123",
      rules: [{
        id: "advanced",
        name: "Advanced",
        matcherType: "advanced",
        pattern: ".*",
        priority: 1,
        enabled: true,
      }],
    }),
    (error) =>
      error instanceof FixtureRuleTestError &&
      error.status === 422 &&
      error.code === "ADVANCED_RULE_REQUIRES_CONTROL_PLANE",
  );
});

test("rule-test BFF is Edge-safe in preview and proxies the authenticated production path", async () => {
  const route = await readFile(
    new URL("../app/api/rules/test/route.ts", import.meta.url),
    "utf8",
  );
  const fixture = await readFile(
    new URL("../lib/fixture-rule-tester.ts", import.meta.url),
    "utf8",
  );
  const bridge = await readFile(
    new URL("../lib/control-plane-data.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /authenticatePortalRequest\(request, "rule:read"\)/u);
  assert.match(route, /isControlPlaneBackend\(\)/u);
  assert.match(route, /testRulesAtControlPlane/u);
  assert.match(route, /testFixtureRules/u);
  assert.match(route, /cache-control.*no-store/u);
  assert.doesNotMatch(route, /lib\/domain|re2-wasm/u);
  assert.doesNotMatch(fixture, /from "re2-wasm"|new RegExp|RegExp\(/u);
  assert.match(bridge, /"\/v1\/rules\/test"/u);
  assert.match(bridge, /method: "POST"/u);
});

test("rule tester mirrors the selected group's production identifier limit", async () => {
  const [portal, english, arabic] = await Promise.all([
    readTenantPortalSource(),
    readFile(new URL("../lib/i18n/messages/en/tenant.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/messages/ar/tenant.ts", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /groups=\{liveData\.groups\}/u);
  assert.match(portal, /<Rules[\s\S]*key=\{String\(liveData\.tenant\.id\)\}/u);
  assert.match(portal, /const \[additionalRuleGroups, setAdditionalRuleGroups\] = useState<RecordRow\[\]>\(\[\]\)/u);
  assert.match(portal, /const ruleGroups = \[\.\.\.new Map\(\[\.\.\.groups, \.\.\.additionalRuleGroups\]/u);
  assert.doesNotMatch(portal, /setRuleGroups\(/u);
  assert.match(portal, /testGroup\?\.max_identifiers \?\? 20/u);
  assert.match(portal, /result\.matches\.length > maxIdentifiers/u);
  assert.match(portal, /tenant\.rules\.tester\.limitExceeded/u);
  assert.match(portal, /tenant\.rules\.tester\.warning\./u);
  for (const messages of [english, arabic]) {
    assert.match(messages, /"tenant\.rules\.tester\.groupLimit":/u);
    assert.match(messages, /"tenant\.rules\.tester\.limitExceeded":/u);
  }
});

test("rule tester guides operators instead of submitting without active rules", async () => {
  const [portal, english, arabic] = await Promise.all([
    readTenantPortalSource(),
    readFile(new URL("../lib/i18n/messages/en/tenant.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/messages/ar/tenant.ts", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /if \(!rows\.length\) return;/u);
  assert.match(portal, /disabled=\{testing \|\| !rows\.length\}/u);
  assert.match(portal, /tenant\.rules\.tester\.noRules/u);
  assert.match(portal, /setCreating\(true\)/u);
  assert.match(english, /"tenant\.rules\.tester\.noRules": "Create and activate a rule before testing a message\."/u);
  assert.match(arabic, /"tenant\.rules\.tester\.noRules": "أنشئ قاعدة وفعّلها قبل اختبار الرسالة\."/u);
});

test("rule tester uses correct bilingual zero, one, and many result phrases", async () => {
  const portal = readTenantPortalSource();
  const english = createTranslator(englishTenantMessages);
  const arabic = createTranslator(arabicTenantMessages);

  assert.match(portal, /tenant\.rules\.tester\.references\.\$\{countForm\(result\.matches\.length\)\}/u);
  assert.match(portal, /tenant\.rules\.tester\.supportCases\.\$\{countForm\(result\.matches\.length\)\}/u);
  assert.equal(english("tenant.rules.tester.references.zero", { count: "0" }), "No references matched");
  assert.equal(english("tenant.rules.tester.references.one", { count: "1" }), "1 reference matched");
  assert.equal(english("tenant.rules.tester.references.many", { count: "2" }), "2 references matched");
  assert.equal(arabic("tenant.rules.tester.references.zero", { count: "٠" }), "لم تتطابق أي مراجع");
  assert.equal(arabic("tenant.rules.tester.references.one", { count: "١" }), "تطابق مرجع واحد");
  assert.equal(arabic("tenant.rules.tester.references.many", { count: "٢" }), "تطابق ٢ من المراجع");
  assert.equal(arabic("tenant.rules.tester.supportCases.one", { count: "١" }), "ستُنشأ أو تُحدّث حالة دعم واحدة");
});

test("rule creation is named as a rule in both operator languages", () => {
  assert.equal(englishTenantMessages["tenant.rules.modal.eyebrow"], "New rule");
  assert.equal(arabicTenantMessages["tenant.rules.modal.eyebrow"], "قاعدة جديدة");
});

test("every rule-modal control has an accessible name from a translated label or aria-label", async () => {
  const path = new URL("../app/Rules.tsx", import.meta.url);
  const file = ts.createSourceFile("Rules.tsx", await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const modal = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "RuleModal");
  assert.ok(modal);
  const attribute = (element, name) => element.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(file) === name)?.initializer?.getText(file);
  const controls = [], labels = new Map();
  const visit = node => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      if (["input", "select", "textarea"].includes(tag)) controls.push(node);
      if (tag === "label" && attribute(node, "htmlFor")) labels.set(attribute(node, "htmlFor"), node.parent.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(modal);
  // Covers every branch: name, matcher, team policy, prefix, digits, pattern, command toggle, action, two input rows, two replies, sample.
  assert.ok(controls.length >= 13, `found ${controls.length} controls`);
  const ids = [];
  for (const control of controls) {
    if (attribute(control, "aria-label")) continue;
    const id = attribute(control, "id");
    assert.match(id ?? "", /^\{`\$\{id\}-[a-z-]+`\}$/u, `${control.getText(file).slice(0, 80)} needs a useId-based id`);
    assert.match(labels.get(id) ?? "", /\bt\(/u, `${id} needs a translated label with a matching htmlFor`);
    ids.push(id);
  }
  assert.equal(new Set(ids).size, ids.length);
});
