import assert from "node:assert/strict";
import test from "node:test";
import { compileRule, normalizeMessage, testRules, type TriggerRule } from "../lib/domain.ts";

const tenDigits: TriggerRule = {
  id: "ten", name: "Ten digits", matcherType: "exact_length",
  pattern: "(?<!\\d)\\d{10}(?!\\d)", prefix: null, digitLength: 10,
  priority: 1, enabled: true, matchCount: 0, version: 1,
};

const abc: TriggerRule = {
  id: "abc", name: "ABC reference", matcherType: "prefix_length",
  pattern: "\\bABC\\d{7}\\b", prefix: "ABC", digitLength: 7,
  priority: 2, enabled: true, matchCount: 0, version: 1,
};

test("normalizes Arabic-Indic and Eastern Arabic-Indic digits", () => {
  assert.equal(normalizeMessage("١٢٣ ۴۵۶"), "123 456");
});

test("removes zero-width characters while preserving message text", () => {
  assert.equal(normalizeMessage("ABC\u200B1234567"), "ABC1234567");
});

test("matches and deduplicates operational references", () => {
  const result = testRules("Track ١٢٣٤٥٦٧٨٩٠, again 1234567890 and abc7654321", [tenDigits, abc]);
  assert.deepEqual(result.matches.map((match) => match.normalizedValue), ["1234567890", "ABC7654321"]);
});

test("does not match digits embedded inside a longer number", () => {
  assert.equal(testRules("X12345678901Y", [tenDigits]).matches.length, 0);
});

test("evaluates nested quantifiers with RE2 without backtracking", () => {
  const rule = { ...abc, matcherType: "advanced" as const, pattern: "(a+)+$" };
  assert.doesNotThrow(() => compileRule(rule));
  assert.equal(testRules(`${"a".repeat(50_000)}!`, [rule]).matches.length, 0);
});

test("rejects expressions that RE2 cannot execute safely and consistently", () => {
  assert.throws(
    () => compileRule({ ...abc, matcherType: "advanced", pattern: "(?<=ABC)\\d+" }),
    /safe RE2 engine/,
  );
});

test("disabled rules are not evaluated", () => {
  assert.equal(testRules("ABC7654321", [{ ...abc, enabled: false }]).matches.length, 0);
});

test("team policy applies before matching and fails closed for unresolved senders", () => {
  for (const sender of ["team", "customer", "unknown"] as const) {
    for (const teamSenderPolicy of [undefined, "include", "exclude"] as const) {
      const result = testRules("1234567890", [{ ...tenDigits, teamSenderPolicy }], { sender });
      assert.equal(result.matches.length, teamSenderPolicy === "exclude" && sender !== "customer" ? 0 : 1);
      assert.deepEqual(result.truncatedRuleIds, []);
    }
  }
  assert.equal(testRules("1234567890", [{ ...tenDigits, teamSenderPolicy: "exclude" }]).matches.length, 0);
});

test("returns bounded occurrences without changing deduplicated production matches", () => {
  const repeated = testRules("a a a a", [{
    ...abc,
    id: "contains-a",
    matcherType: "contains",
    pattern: "a",
  }], { maxMatchesPerRule: 2, maxTotalOccurrences: 2 });
  assert.equal(repeated.occurrences.length, 2);
  assert.equal(repeated.matches.length, 1);
  assert.deepEqual(repeated.truncatedRuleIds, ["contains-a"]);
});

test("does not report truncation when the total cap is exact and later rules do not match", () => {
  const result = testRules("1234567890", [tenDigits, abc], { maxTotalOccurrences: 1 });
  assert.equal(result.occurrences.length, 1);
  assert.deepEqual(result.truncatedRuleIds, []);
});

test("reports truncation when a later matching rule is hidden by the total cap", () => {
  const result = testRules("1234567890 ABC7654321", [tenDigits, abc], { maxTotalOccurrences: 1 });
  assert.deepEqual(result.truncatedRuleIds, ["abc"]);
});
