import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import {
  compileRule,
  normalizeMessage,
  testRules,
  type MatcherType,
  type RuleMatch,
  type RuleSender,
  type TriggerRule,
} from "@wasalx/core/domain";

export type RuleTestMatcherType = MatcherType;

export type RuleTestRequest = {
  message?: unknown;
  rules?: unknown;
  sender?: unknown;
};

type ValidRule = TriggerRule;
type Occurrence = RuleMatch;
const MATCHER_TYPES = new Set<RuleTestMatcherType>([
  "exact_length",
  "prefix_length",
  "starts_with",
  "contains",
  "advanced",
]);
const MAX_SAMPLE_CHARACTERS = 10_000;
const MAX_SAMPLE_BYTES = 40_000;
const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 240;
const MAX_PREFIX_LENGTH = 64;
const MAX_DIGIT_LENGTH = 64;
const MAX_MATCHES_PER_RULE = 500;
const MAX_TOTAL_OCCURRENCES = 2_000;

@Injectable()
export class RuleTestService {
  evaluate(input: RuleTestRequest) {
    const { message, rules, sender } = validateRequest(input);
    const evaluated = testRules(message, rules, {
      maxMatchesPerRule: MAX_MATCHES_PER_RULE,
      maxTotalOccurrences: MAX_TOTAL_OCCURRENCES,
      sender,
    });
    const normalized = evaluated.normalized;
    const occurrences = evaluated.occurrences;
    const truncatedRules = new Set(evaluated.truncatedRuleIds);

    occurrences.sort((left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.ruleId.localeCompare(right.ruleId),
    );
    const collisionPairs = findCollisionPairs(occurrences);
    const warnings = buildWarnings(normalized, rules, occurrences, collisionPairs, truncatedRules, sender);
    return {
      original: message,
      normalized,
      spanSource: "normalized" as const,
      matches: uniqueMatches(occurrences),
      highlights: buildHighlights(occurrences, collisionPairs),
      warnings,
      occurrenceCount: occurrences.length,
      truncated: truncatedRules.size > 0,
    };
  }
}

export const normalizeRuleTestMessage = normalizeMessage;

function validateRequest(input: RuleTestRequest) {
  if (!isPlainObject(input)) throw new BadRequestException("Request body must be a JSON object");
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new BadRequestException("A non-empty sample message is required");
  }
  if (
    input.message.length > MAX_SAMPLE_CHARACTERS ||
    Buffer.byteLength(input.message, "utf8") > MAX_SAMPLE_BYTES
  ) {
    throw new PayloadTooLargeException("Sample message exceeds the 10000-character limit");
  }
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    throw new BadRequestException("At least one rule is required");
  }
  if (input.rules.length > MAX_RULES) {
    throw new BadRequestException(`At most ${MAX_RULES} rules can be tested at once`);
  }
  const identifiers = new Set<string>();
  const sender = input.sender === undefined ? "unknown" : input.sender;
  if (sender !== "team" && sender !== "customer" && sender !== "unknown") {
    throw new BadRequestException("Sample sender must be team, customer or unknown");
  }
  const rules = input.rules.map((candidate, index) => validateRule(candidate, index, identifiers));
  return { message: input.message, rules, sender: sender as RuleSender };
}

function validateRule(candidate: unknown, index: number, identifiers: Set<string>): ValidRule {
  if (!isPlainObject(candidate)) throw new BadRequestException(`Rule ${index + 1} must be an object`);
  const matcherType = candidate.matcherType;
  if (typeof matcherType !== "string" || !MATCHER_TYPES.has(matcherType as RuleTestMatcherType)) {
    throw new BadRequestException(`Rule ${index + 1} has an unsupported matcher type`);
  }
  const id = optionalBoundedText(candidate.id, 160) ?? `test-rule-${index + 1}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(id)) {
    throw new BadRequestException(`Rule ${index + 1} has an invalid identifier`);
  }
  if (identifiers.has(id)) throw new BadRequestException("Rule identifiers must be unique");
  identifiers.add(id);
  const name = optionalBoundedText(candidate.name, 160) ?? `Rule ${index + 1}`;
  const pattern = optionalBoundedText(candidate.pattern, MAX_PATTERN_LENGTH, true) ?? "";
  if (candidate.matcherOptions !== undefined && !isPlainObject(candidate.matcherOptions)) {
    throw new BadRequestException(`Rule ${index + 1} matcher options must be an object`);
  }
  const options = isPlainObject(candidate.matcherOptions) ? candidate.matcherOptions : {};
  const teamSenderPolicy = candidate.teamSenderPolicy === undefined ? options.teamSenderPolicy : candidate.teamSenderPolicy;
  if (teamSenderPolicy !== undefined && teamSenderPolicy !== "include" && teamSenderPolicy !== "exclude") {
    throw new BadRequestException(`Rule ${index + 1} team sender policy must be include or exclude`);
  }
  if (candidate.teamSenderPolicy !== undefined && options.teamSenderPolicy !== undefined &&
      candidate.teamSenderPolicy !== options.teamSenderPolicy) {
    throw new BadRequestException(`Rule ${index + 1} has conflicting team sender policies`);
  }
  const priority = candidate.priority ?? index + 1;
  if (!Number.isSafeInteger(priority) || Number(priority) < 1 || Number(priority) > 10_000) {
    throw new BadRequestException(`Rule ${index + 1} priority must be an integer between 1 and 10000`);
  }
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
    throw new BadRequestException(`Rule ${index + 1} enabled must be a boolean`);
  }

  let prefix: string | null = null;
  let digitLength: number | null = null;
  if (matcherType === "exact_length" || matcherType === "prefix_length") {
    const value = candidate.digitLength ?? options.digitLength;
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_DIGIT_LENGTH) {
      throw new BadRequestException(`Rule ${index + 1} digit length must be between 1 and ${MAX_DIGIT_LENGTH}`);
    }
    digitLength = Number(value);
  }
  if (matcherType === "prefix_length") {
    prefix = requiredBoundedText(candidate.prefix ?? options.prefix, MAX_PREFIX_LENGTH, `Rule ${index + 1} prefix`);
  }
  if (matcherType === "starts_with" || matcherType === "contains" || matcherType === "advanced") {
    requiredBoundedText(pattern, MAX_PATTERN_LENGTH, `Rule ${index + 1} pattern`);
  }
  const rule: ValidRule = {
    id,
    name,
    matcherType: matcherType as RuleTestMatcherType,
    pattern,
    prefix,
    digitLength,
    priority: Number(priority),
    enabled: candidate.enabled ?? true,
    matchCount: 0,
    version: 1,
    ...(teamSenderPolicy === undefined ? {} : { teamSenderPolicy }),
  };
  if (matcherType === "advanced") validateAdvanced(rule, index);
  return rule;
}

function validateAdvanced(rule: ValidRule, index: number) {
  try {
    const matcher = compileRule(rule);
    if (matcher.test("")) {
      throw new BadRequestException(`Rule ${index + 1} advanced expression must not match an empty value`);
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(`Rule ${index + 1} advanced expression is not supported by RE2`);
  }
}

function uniqueMatches(occurrences: Occurrence[]) {
  const seen = new Set<string>();
  return occurrences.filter((occurrence) => {
    const key = `${occurrence.ruleId}:${occurrence.normalizedValue}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findCollisionPairs(occurrences: Occurrence[]) {
  const pairs = new Set<string>();
  for (let leftIndex = 0; leftIndex < occurrences.length; leftIndex += 1) {
    const left = occurrences[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < occurrences.length; rightIndex += 1) {
      const right = occurrences[rightIndex]!;
      if (right.start >= left.end && right.normalizedValue !== left.normalizedValue) break;
      if (left.ruleId === right.ruleId) continue;
      if (
        (left.start < right.end && right.start < left.end) ||
        left.normalizedValue === right.normalizedValue
      ) {
        pairs.add([left.ruleId, right.ruleId].sort().join(":"));
      }
    }
  }
  return pairs;
}

function buildHighlights(occurrences: Occurrence[], collisionPairs: Set<string>) {
  const grouped = new Map<string, {
    start: number;
    end: number;
    text: string;
    normalizedValue: string;
    ruleIds: string[];
    ruleNames: string[];
  }>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.start}:${occurrence.end}:${occurrence.normalizedValue}`;
    const current = grouped.get(key) ?? {
      start: occurrence.start,
      end: occurrence.end,
      text: occurrence.value,
      normalizedValue: occurrence.normalizedValue,
      ruleIds: [],
      ruleNames: [],
    };
    if (!current.ruleIds.includes(occurrence.ruleId)) current.ruleIds.push(occurrence.ruleId);
    if (!current.ruleNames.includes(occurrence.ruleName)) current.ruleNames.push(occurrence.ruleName);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((highlight) => ({
    ...highlight,
    collision: highlight.ruleIds.some((ruleId) =>
      [...collisionPairs].some((pair) => pair.split(":").includes(ruleId)),
    ),
  }));
}

function buildWarnings(
  normalized: string,
  rules: ValidRule[],
  occurrences: Occurrence[],
  collisionPairs: Set<string>,
  truncatedRules: Set<string>,
  sender: RuleSender,
) {
  const warnings: Array<{
    code: "OVERLAPPING_RULES" | "BROAD_MATCH" | "MATCH_LIMIT_REACHED" | "TEAM_SENDER_EXCLUDED";
    message: string;
    ruleIds: string[];
  }> = [];
  const excluded = sender !== "customer" ? rules.filter(rule => rule.enabled && rule.teamSenderPolicy === "exclude") : [];
  if (excluded.length) warnings.push({code:"TEAM_SENDER_EXCLUDED",message:"Team and unresolved senders are excluded by the selected rule policy.",ruleIds:excluded.map(rule=>rule.id)});
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  for (const pair of collisionPairs) {
    const ruleIds = pair.split(":");
    warnings.push({
      code: "OVERLAPPING_RULES",
      message: `Rules ${ruleIds.map((id) => byId.get(id)?.name ?? id).join(" and ")} match overlapping or identical references.`,
      ruleIds,
    });
  }
  for (const rule of rules.filter((candidate) => candidate.enabled)) {
    const matches = occurrences.filter((occurrence) => occurrence.ruleId === rule.id);
    const covered = matches.reduce((total, occurrence) => total + occurrence.end - occurrence.start, 0);
    const shortLiteral =
      (rule.matcherType === "contains" || rule.matcherType === "starts_with") &&
      rule.pattern.length < 3;
    const shortDigits = rule.matcherType === "exact_length" && (rule.digitLength ?? 0) < 4;
    if (
      shortLiteral ||
      shortDigits ||
      matches.length >= 10 ||
      (normalized.length > 0 && covered / normalized.length >= 0.5)
    ) {
      warnings.push({
        code: "BROAD_MATCH",
        message: `${rule.name} matches a large or low-specificity part of this sample. Test more negative examples before activation.`,
        ruleIds: [rule.id],
      });
    }
  }
  if (truncatedRules.size > 0) {
    warnings.push({
      code: "MATCH_LIMIT_REACHED",
      message: "The bounded tester reached its match limit; narrow the rule before activation.",
      ruleIds: [...truncatedRules],
    });
  }
  return warnings.slice(0, 200);
}

function requiredBoundedText(value: unknown, maximum: number, label: string) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new BadRequestException(`${label} must contain between 1 and ${maximum} characters`);
  }
  return value.trim();
}

function optionalBoundedText(value: unknown, maximum: number, allowEmpty = false) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
    throw new BadRequestException(`Text fields must not exceed ${maximum} characters`);
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
