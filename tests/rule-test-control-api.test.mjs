import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BadRequestException,
  PayloadTooLargeException,
} from "../services/control-api/node_modules/@nestjs/common/index.js";
import { RuleTestController } from "../services/control-api/dist/rule-test.controller.js";
import { RuleTestService } from "../services/control-api/dist/rule-test.service.js";

const tenDigits = {
  id: "ten-digits",
  name: "Ten digits",
  matcherType: "exact_length",
  pattern: "(?<!\\d)\\d{10}(?!\\d)",
  prefix: null,
  digitLength: 10,
  priority: 1,
  enabled: true,
};

test("rule preview preserves sender policy and validates synthetic sender input", () => {
  const tester = new RuleTestService();
  for (const sender of ["team", "customer", "unknown"]) {
    for (const teamSenderPolicy of ["include", "exclude"]) {
      for (const policy of [{ teamSenderPolicy }, { matcherOptions: { teamSenderPolicy } }]) {
        const result = tester.evaluate({ message: "1234567890", sender, rules: [{ ...tenDigits, ...policy }] });
        assert.equal(result.matches.length, teamSenderPolicy === "exclude" && sender !== "customer" ? 0 : 1);
      }
    }
  }
  for (const input of [
    { sender: "staff" },
    { sender: null },
    { rules: [{ ...tenDigits, teamSenderPolicy: null }] },
    { rules: [{ ...tenDigits, teamSenderPolicy: "invalid" }] },
    { rules: [{ ...tenDigits, teamSenderPolicy: "include", matcherOptions: { teamSenderPolicy: "exclude" } }] },
  ]) {
    assert.throws(() => tester.evaluate({ message: "1234567890", rules: [tenDigits], ...input }), BadRequestException);
  }
});

test("Node rule tester normalizes both Arabic digit sets and returns collision-aware highlights", () => {
  const tester = new RuleTestService();
  const result = tester.evaluate({
    message: "Track ١٢٣٤٥٦٧٨٩٠ and ۱۲۳۴۵۶۷۸۹۰",
    rules: [
      tenDigits,
      {
        id: "advanced-digits",
        name: "Advanced digits",
        matcherType: "advanced",
        pattern: "[0-9]{10}",
        priority: 2,
        enabled: true,
      },
    ],
  });

  assert.equal(result.normalized, "Track 1234567890 and 1234567890");
  assert.equal(result.spanSource, "normalized");
  assert.equal(result.occurrenceCount, 4);
  assert.equal(result.highlights.length, 2);
  assert.ok(result.highlights.every((highlight) => highlight.collision));
  assert.deepEqual(
    result.matches.map((match) => [match.ruleId, match.normalizedValue]),
    [
      ["advanced-digits", "1234567890"],
      ["ten-digits", "1234567890"],
    ],
  );
  assert.ok(result.warnings.some((warning) => warning.code === "OVERLAPPING_RULES"));
});

test("Node rule tester reports low-specificity patterns and remains bounded", () => {
  const tester = new RuleTestService();
  const result = tester.evaluate({
    message: "a a a a a a a a a a a a",
    rules: [{
      id: "broad-a",
      name: "Broad A",
      matcherType: "contains",
      pattern: "a",
      priority: 1,
      enabled: true,
    }],
  });
  assert.equal(result.matches.length, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "BROAD_MATCH"));

  assert.throws(
    () => tester.evaluate({ message: "x".repeat(10_001), rules: [tenDigits] }),
    PayloadTooLargeException,
  );
  assert.throws(
    () => tester.evaluate({ message: "123", rules: Array.from({ length: 101 }, () => tenDigits) }),
    BadRequestException,
  );
});

test("advanced expressions use RE2 and reject unsupported or empty matches", () => {
  const tester = new RuleTestService();
  const safe = tester.evaluate({
    message: `${"a".repeat(9_000)}!`,
    rules: [{
      id: "safe-nested",
      name: "Safe nested",
      matcherType: "advanced",
      pattern: "(a+)+$",
      priority: 1,
      enabled: true,
    }],
  });
  assert.equal(safe.matches.length, 0);

  for (const pattern of ["(?<=ABC)\\d+", "a*"]) {
    assert.throws(
      () => tester.evaluate({
        message: "ABC123",
        rules: [{
          id: "invalid-advanced",
          name: "Invalid advanced",
          matcherType: "advanced",
          pattern,
          priority: 1,
          enabled: true,
        }],
      }),
      BadRequestException,
    );
  }
});

test("tenant route is read-authorized and has no database persistence dependency", async () => {
  const tester = new RuleTestService();
  const controller = new RuleTestController(tester);
  assert.equal(
    controller.test({ message: "ABC7654321", rules: [{
      id: "abc",
      name: "ABC",
      matcherType: "prefix_length",
      pattern: "\\bABC\\d{7}\\b",
      prefix: "ABC",
      digitLength: 7,
      priority: 1,
      enabled: true,
    }] }).matches[0]?.normalizedValue,
    "ABC7654321",
  );

  const controllerSource = await readFile(
    new URL("../services/control-api/src/rule-test.controller.ts", import.meta.url),
    "utf8",
  );
  const serviceSource = await readFile(
    new URL("../services/control-api/src/rule-test.service.ts", import.meta.url),
    "utf8",
  );
  assert.match(controllerSource, /@Controller\("v1\/rules"\)/u);
  assert.match(controllerSource, /@Post\("test"\)/u);
  assert.match(controllerSource, /@Requires\("rule:read"\)/u);
  assert.doesNotMatch(controllerSource, /DatabaseService|Repository/u);
  assert.doesNotMatch(serviceSource, /INSERT|UPDATE|DELETE FROM|DatabaseService/u);
});
