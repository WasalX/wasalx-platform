import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessage, containsMatches, exactLengthMatches, prefixLengthMatches } from "../lib/literal-matcher.ts";
import { testRules, type TriggerRule } from "../lib/domain.ts";

test("public contains example uses the same normalized literal matches as product rules", () => {
  for (const [message, pattern, matches] of [
    ["Shipment ٤٨٢١", " 4821 ", true],
    ["Shipment ۴۸۲۱", "4821", true],
    ["abc\u200B123", "AbC", true],
    ["preorder", "ORDER", true],
    ["No request", "4821", false],
    ["4821", "٤٨٢١", false],
  ] as const) {
    const rule: TriggerRule = { id: "example", name: "Example", matcherType: "contains", pattern, prefix: null, digitLength: null, priority: 1, enabled: true, matchCount: 0, version: 1 };
    const local = containsMatches(normalizeMessage(message), pattern.trim(), 1).length > 0;
    assert.equal(local, matches);
    assert.equal(local, testRules(message, [rule]).matches.length > 0);
  }
});

test("digit and prefix presets retain product boundaries and normalization", () => {
  for (const [message, prefix, length, expected] of [
    ["1234567890", null, 10, ["1234567890"]],
    ["012345678901", null, 12, ["012345678901"]],
    ["012345678901", null, 10, []],
    ["a1234567890z", null, 10, ["1234567890"]],
    ["١٢٣٤٥٦٧٨٩٠ / ۱۲۳۴۵۶۷۸۹۰", null, 10, ["1234567890", "1234567890"]],
    ["1234567890 9876543210", null, 10, ["1234567890", "9876543210"]],
    ["(wx-0012)", "WX-", 4, ["wx-0012"]],
    ["WX-٠٠١٢", "WX-", 4, ["WX-0012"]],
    ["aWX-0012 WX-00123 WX-0012z WX- 0012", "WX-", 4, []],
    ["WX.0012", "WX.", 4, ["WX.0012"]],
    ["No reference here", null, 10, []],
  ] as const) {
    const rule: TriggerRule = { id: "example", name: "Example", matcherType: prefix === null ? "exact_length" : "prefix_length", pattern: "", prefix, digitLength: length, priority: 1, enabled: true, matchCount: 0, version: 1 };
    const input = normalizeMessage(message);
    const local = prefix === null ? exactLengthMatches(input, length, 500) : prefixLengthMatches(input, prefix, length, 500);
    assert.deepEqual(local.map(match => match.value), expected);
    assert.deepEqual(local.map(({ value, start, end }) => ({ value, start, end })), testRules(message, [rule]).occurrences.map(({ value, start, end }) => ({ value, start, end })));
  }
});
