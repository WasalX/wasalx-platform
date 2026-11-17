import { normalizeMessage, containsMatches, exactLengthMatches, prefixLengthMatches, isAsciiWord } from "./literal-matcher.ts";
export { normalizeMessage } from "./literal-matcher.ts";
import { RE2, type RE2ExecArray } from "re2-wasm";

export type MatcherType =
  | "exact_length"
  | "prefix_length"
  | "starts_with"
  | "contains"
  | "advanced";

export type GroupCommand = {
  actionId: string;
  input: Record<string, string>;
  successReply: string;
  failureReply: string;
};

export type TriggerRule = {
  id: string;
  name: string;
  matcherType: MatcherType;
  pattern: string;
  prefix: string | null;
  digitLength: number | null;
  priority: number;
  enabled: boolean;
  matchCount: number;
  version: number;
  groupCommand?: GroupCommand;
  teamSenderPolicy?: "include" | "exclude";
};

export type RuleSender = "team" | "customer" | "unknown";

export function ruleAllowsSender(rule: TriggerRule, sender: RuleSender): boolean {
  // An unresolved identity cannot prove that a sender is outside the team.
  return rule.teamSenderPolicy === undefined || rule.teamSenderPolicy === "include" ||
    (rule.teamSenderPolicy === "exclude" && sender === "customer");
}

export function rulesAllowUnmatchedAssociation(rules: TriggerRule[], sender: RuleSender): boolean {
  // A quote or case number has no matched rule to authorize bypassing an exclusion.
  return rules.every(rule => !rule.enabled || ruleAllowsSender(rule, sender));
}

export type RuleMatch = {
  ruleId: string;
  ruleName: string;
  value: string;
  normalizedValue: string;
  start: number;
  end: number;
};

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_PATTERN_LENGTH = 240;
const MAX_DIGIT_LENGTH = 64;
const MAX_MATCHES_PER_RULE = 1_000;
const MAX_TOTAL_OCCURRENCES = 10_000;

function requiredDigitLength(rule: TriggerRule): number {
  const length = rule.digitLength ?? (rule.matcherType === "exact_length" ? 10 : 7);
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_DIGIT_LENGTH) {
    throw new Error(`Digit length must be between 1 and ${MAX_DIGIT_LENGTH}.`);
  }
  return length;
}

function requiredLiteral(value: string | null, label: string): string {
  const literal = value?.trim() ?? "";
  if (!literal) throw new Error(`${label} is required.`);
  if (literal.length > MAX_PATTERN_LENGTH) {
    throw new Error(`${label} exceeds ${MAX_PATTERN_LENGTH} characters.`);
  }
  return literal;
}

/**
 * Compiles a rule with RE2 so validation and advanced matching cannot trigger
 * catastrophic backtracking. Preset matchers are evaluated by deterministic
 * scanners below; their compiled expression is still useful for validation and
 * compatibility with callers that only need to validate a rule.
 */
export function compileRule(rule: TriggerRule): RE2 {
  switch (rule.matcherType) {
    case "exact_length":
      return new RE2(`[0-9]{${requiredDigitLength(rule)}}`, "giu");
    case "prefix_length":
      return new RE2(
        `${escapeRegex(requiredLiteral(rule.prefix, "Prefix"))}[0-9]{${requiredDigitLength(rule)}}`,
        "giu",
      );
    case "starts_with":
      return new RE2(`${escapeRegex(requiredLiteral(rule.pattern, "Pattern"))}[A-Z0-9-]*`, "giu");
    case "contains":
      return new RE2(escapeRegex(requiredLiteral(rule.pattern, "Pattern")), "giu");
    case "advanced":
      if (!rule.pattern) throw new Error("Expression is required.");
      if (rule.pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error(`Expression exceeds ${MAX_PATTERN_LENGTH} characters.`);
      }
      try {
        return new RE2(rule.pattern, "giu");
      } catch (error) {
        throw new Error(
          `Expression is not supported by the safe RE2 engine: ${error instanceof Error ? error.message : "invalid expression"}`,
        );
      }
  }
}

type LocatedMatch = { value: string; start: number; end: number };

function startsWithMatches(input: string, literal: string, limit: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  const upperInput = input.toUpperCase();
  const upperLiteral = literal.toUpperCase();
  let cursor = 0;
  while (cursor <= input.length - literal.length && matches.length < limit) {
    const start = upperInput.indexOf(upperLiteral, cursor);
    if (start < 0) break;
    let end = start + literal.length;
    if (!isAsciiWord(input[start - 1])) {
      while (end < input.length && (isAsciiWord(input[end]) || input[end] === "-")) end += 1;
      matches.push({ value: input.slice(start, end), start, end });
    }
    cursor = start + Math.max(1, literal.length);
  }
  return matches;
}

function re2Matches(input: string, matcher: RE2, limit: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  let result: RE2ExecArray | null;
  while ((result = matcher.exec(input)) !== null) {
    const value = result[0] ?? "";
    const start = result.index;
    matches.push({ value, start, end: start + value.length });
    if (matches.length >= limit) break;
    if (value.length === 0) matcher.lastIndex += 1;
  }
  return matches;
}

function evaluateRule(input: string, rule: TriggerRule, limit: number): LocatedMatch[] {
  switch (rule.matcherType) {
    case "exact_length":
      compileRule(rule);
      return exactLengthMatches(input, requiredDigitLength(rule), limit);
    case "prefix_length":
      compileRule(rule);
      return prefixLengthMatches(
        input,
        requiredLiteral(rule.prefix, "Prefix"),
        requiredDigitLength(rule),
        limit,
      );
    case "starts_with":
      compileRule(rule);
      return startsWithMatches(input, requiredLiteral(rule.pattern, "Pattern"), limit);
    case "contains":
      compileRule(rule);
      return containsMatches(input, requiredLiteral(rule.pattern, "Pattern"), limit);
    case "advanced":
      return re2Matches(input, compileRule(rule), limit);
  }
}

export type RuleTestLimits = {
  maxMatchesPerRule?: number;
  maxTotalOccurrences?: number;
  sender?: RuleSender;
};

export function testRules(message: string, rules: TriggerRule[], limits: RuleTestLimits = {}) {
  const normalized = normalizeMessage(message);
  const occurrences: RuleMatch[] = [];
  const truncatedRuleIds = new Set<string>();
  const perRule = boundedLimit(limits.maxMatchesPerRule, MAX_MATCHES_PER_RULE);
  const total = boundedLimit(limits.maxTotalOccurrences, MAX_TOTAL_OCCURRENCES);

  for (const rule of [...rules].filter((r) => r.enabled && ruleAllowsSender(r, limits.sender ?? "unknown")).sort((a, b) => a.priority - b.priority)) {
    const remaining = total - occurrences.length;
    if (remaining === 0) {
      if (evaluateRule(normalized, rule, 1).length > 0) {
        truncatedRuleIds.add(rule.id);
        break;
      }
      continue;
    }
    const accepted = Math.min(perRule, remaining);
    const located = evaluateRule(normalized, rule, accepted + 1);
    if (located.length > accepted) truncatedRuleIds.add(rule.id);
    for (const result of located.slice(0, accepted)) {
      const value = result.value;
      const normalizedValue = value.toUpperCase();
      occurrences.push({
        ruleId: rule.id,
        ruleName: rule.name,
        value,
        normalizedValue,
        start: result.start,
        end: result.end,
      });
    }
  }

  const seen = new Set<string>();
  const matches = occurrences.filter((occurrence) => {
    const key = `${occurrence.ruleId}:${occurrence.normalizedValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    original: message,
    normalized,
    matches,
    occurrences,
    truncatedRuleIds: [...truncatedRuleIds],
  };
}

function boundedLimit(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, fallback)
    : fallback;
}
