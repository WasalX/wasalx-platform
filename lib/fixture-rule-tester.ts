import type {
  RuleTestHighlight,
  RuleTestMatch,
  RuleTestRequest,
  RuleTestResult,
  RuleTestWarning,
} from "./rule-test-contract";

type PresetMatcherType =
  | "exact_length"
  | "prefix_length"
  | "starts_with"
  | "contains";

type PresetRule = {
  id: string;
  name: string;
  matcherType: PresetMatcherType;
  pattern: string;
  prefix: string | null;
  digitLength: number | null;
  priority: number;
  enabled: boolean;
  teamSenderPolicy?: "include" | "exclude";
};

type Occurrence = RuleTestMatch;
type LocatedMatch = { value: string; start: number; end: number };

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";
const PRESET_TYPES = new Set<PresetMatcherType>([
  "exact_length",
  "prefix_length",
  "starts_with",
  "contains",
]);
const MAX_SAMPLE_CHARACTERS = 10_000;
const MAX_SAMPLE_BYTES = 40_000;
const MAX_RULES = 100;
const MAX_PATTERN_LENGTH = 240;
const MAX_PREFIX_LENGTH = 64;
const MAX_MATCHES_PER_RULE = 500;
const MAX_TOTAL_OCCURRENCES = 2_000;

export class FixtureRuleTestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status = 400,
    code = "INVALID_RULE_TEST",
  ) {
    super(message);
    this.name = "FixtureRuleTestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Edge/Workers-safe preview evaluator. It intentionally contains no dynamic
 * expression engine: only deterministic preset scanners are supported.
 */
export function testFixtureRules(input: RuleTestRequest): RuleTestResult {
  const { message, rules, sender } = validateRequest(input);
  const normalized = normalizeFixtureRuleMessage(message);
  const occurrences: Occurrence[] = [];
  const truncatedRules = new Set<string>();

  for (const rule of rules
    .filter((candidate) => candidate.enabled && (candidate.teamSenderPolicy !== "exclude" || sender === "customer"))
    .sort((left, right) => left.priority - right.priority)) {
    const located = evaluatePreset(normalized, rule);
    if (located.length >= MAX_MATCHES_PER_RULE) truncatedRules.add(rule.id);
    for (const match of located) {
      if (occurrences.length >= MAX_TOTAL_OCCURRENCES) {
        truncatedRules.add(rule.id);
        break;
      }
      occurrences.push({
        ruleId: rule.id,
        ruleName: rule.name,
        value: match.value,
        normalizedValue: match.value.toUpperCase(),
        start: match.start,
        end: match.end,
      });
    }
    if (occurrences.length >= MAX_TOTAL_OCCURRENCES) break;
  }
  occurrences.sort((left, right) =>
    left.start - right.start ||
    left.end - right.end ||
    left.ruleId.localeCompare(right.ruleId),
  );
  const collisionPairs = findCollisionPairs(occurrences);
  return {
    original: message,
    normalized,
    spanSource: "normalized",
    matches: uniqueMatches(occurrences),
    highlights: buildHighlights(occurrences, collisionPairs),
    warnings: buildWarnings(normalized, rules, occurrences, collisionPairs, truncatedRules),
    occurrenceCount: occurrences.length,
    truncated: truncatedRules.size > 0,
  };
}

export function normalizeFixtureRuleMessage(input: string): string {
  const normalized = input
    .normalize("NFC")
    .replace(/[٠-٩]/gu, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/gu, (digit) => String(EASTERN_ARABIC_INDIC.indexOf(digit)))
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "");
  return Array.from(normalized)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
}

function validateRequest(input: RuleTestRequest) {
  if (!isPlainObject(input)) throw new FixtureRuleTestError("Request body must be a JSON object");
  if (typeof input.message !== "string" || input.message.trim().length === 0) {
    throw new FixtureRuleTestError("A non-empty sample message is required");
  }
  if (
    input.message.length > MAX_SAMPLE_CHARACTERS ||
    new TextEncoder().encode(input.message).byteLength > MAX_SAMPLE_BYTES
  ) {
    throw new FixtureRuleTestError("Sample message exceeds the 10000-character limit", 413, "SAMPLE_TOO_LARGE");
  }
  if (!Array.isArray(input.rules) || input.rules.length === 0) {
    throw new FixtureRuleTestError("At least one rule is required");
  }
  if (input.rules.length > MAX_RULES) {
    throw new FixtureRuleTestError(`At most ${MAX_RULES} rules can be tested at once`);
  }
  const identifiers = new Set<string>();
  const sender = input.sender === undefined ? "unknown" : input.sender;
  if (sender !== "team" && sender !== "customer" && sender !== "unknown") {
    throw new FixtureRuleTestError("Sample sender must be team, customer or unknown");
  }
  const rules = input.rules.map((candidate, index) => validateRule(candidate, index, identifiers));
  return { message: input.message, rules, sender };
}

function validateRule(candidate: unknown, index: number, identifiers: Set<string>): PresetRule {
  if (!isPlainObject(candidate)) throw new FixtureRuleTestError(`Rule ${index + 1} must be an object`);
  if (candidate.matcherType === "advanced") {
    throw new FixtureRuleTestError(
      "Advanced expression testing requires the managed service; the preview workspace supports deterministic presets only.",
      422,
      "ADVANCED_RULE_REQUIRES_CONTROL_PLANE",
    );
  }
  if (typeof candidate.matcherType !== "string" || !PRESET_TYPES.has(candidate.matcherType as PresetMatcherType)) {
    throw new FixtureRuleTestError(`Rule ${index + 1} has an unsupported matcher type`);
  }
  const id = optionalText(candidate.id, 160) ?? `test-rule-${index + 1}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(id)) {
    throw new FixtureRuleTestError(`Rule ${index + 1} has an invalid identifier`);
  }
  if (identifiers.has(id)) throw new FixtureRuleTestError("Rule identifiers must be unique");
  identifiers.add(id);
  const name = optionalText(candidate.name, 160) ?? `Rule ${index + 1}`;
  const pattern = optionalText(candidate.pattern, MAX_PATTERN_LENGTH, true) ?? "";
  if (candidate.matcherOptions !== undefined && !isPlainObject(candidate.matcherOptions)) {
    throw new FixtureRuleTestError(`Rule ${index + 1} matcher options must be an object`);
  }
  const options = isPlainObject(candidate.matcherOptions) ? candidate.matcherOptions : {};
  const teamSenderPolicy = candidate.teamSenderPolicy === undefined ? options.teamSenderPolicy : candidate.teamSenderPolicy;
  if (teamSenderPolicy !== undefined && teamSenderPolicy !== "include" && teamSenderPolicy !== "exclude") {
    throw new FixtureRuleTestError("Team sender policy must be include or exclude");
  }
  if (candidate.teamSenderPolicy !== undefined && options.teamSenderPolicy !== undefined && candidate.teamSenderPolicy !== options.teamSenderPolicy) {
    throw new FixtureRuleTestError("Conflicting team sender policies");
  }
  const priority = candidate.priority ?? index + 1;
  if (!Number.isSafeInteger(priority) || Number(priority) < 1 || Number(priority) > 10_000) {
    throw new FixtureRuleTestError(`Rule ${index + 1} priority must be an integer between 1 and 10000`);
  }
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
    throw new FixtureRuleTestError(`Rule ${index + 1} enabled must be a boolean`);
  }

  let prefix: string | null = null;
  let digitLength: number | null = null;
  if (candidate.matcherType === "exact_length" || candidate.matcherType === "prefix_length") {
    const value = candidate.digitLength ?? options.digitLength;
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 64) {
      throw new FixtureRuleTestError(`Rule ${index + 1} digit length must be between 1 and 64`);
    }
    digitLength = Number(value);
  }
  if (candidate.matcherType === "prefix_length") {
    prefix = requiredText(candidate.prefix ?? options.prefix, MAX_PREFIX_LENGTH, `Rule ${index + 1} prefix`);
  }
  if (candidate.matcherType === "starts_with" || candidate.matcherType === "contains") {
    requiredText(pattern, MAX_PATTERN_LENGTH, `Rule ${index + 1} pattern`);
  }
  return {
    id,
    name,
    matcherType: candidate.matcherType as PresetMatcherType,
    pattern,
    prefix,
    digitLength,
    priority: Number(priority),
    enabled: candidate.enabled ?? true,
    ...(teamSenderPolicy === undefined ? {} : { teamSenderPolicy }),
  };
}

function evaluatePreset(input: string, rule: PresetRule) {
  switch (rule.matcherType) {
    case "exact_length":
      return exactLengthMatches(input, rule.digitLength!);
    case "prefix_length":
      return prefixLengthMatches(input, rule.prefix!, rule.digitLength!);
    case "starts_with":
      return startsWithMatches(input, rule.pattern);
    case "contains":
      return containsMatches(input, rule.pattern);
  }
}

function exactLengthMatches(input: string, length: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  for (let index = 0; index < input.length && matches.length < MAX_MATCHES_PER_RULE; ) {
    if (!isAsciiDigit(input[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (isAsciiDigit(input[index])) index += 1;
    if (index - start === length) matches.push({ value: input.slice(start, index), start, end: index });
  }
  return matches;
}

function prefixLengthMatches(input: string, prefix: string, length: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  const upperInput = input.toUpperCase();
  const upperPrefix = prefix.toUpperCase();
  let cursor = 0;
  while (cursor <= input.length - prefix.length - length && matches.length < MAX_MATCHES_PER_RULE) {
    const start = upperInput.indexOf(upperPrefix, cursor);
    if (start < 0) break;
    const digitsStart = start + prefix.length;
    const end = digitsStart + length;
    const digits = input.slice(digitsStart, end);
    if (
      digits.length === length &&
      Array.from(digits).every(isAsciiDigit) &&
      !isAsciiWord(input[start - 1]) &&
      !isAsciiWord(input[end])
    ) {
      matches.push({ value: input.slice(start, end), start, end });
    }
    cursor = start + Math.max(1, prefix.length);
  }
  return matches;
}

function startsWithMatches(input: string, literal: string): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  const upperInput = input.toUpperCase();
  const upperLiteral = literal.toUpperCase();
  let cursor = 0;
  while (cursor <= input.length - literal.length && matches.length < MAX_MATCHES_PER_RULE) {
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

function containsMatches(input: string, literal: string): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  const upperInput = input.toUpperCase();
  const upperLiteral = literal.toUpperCase();
  let cursor = 0;
  while (cursor <= input.length - literal.length && matches.length < MAX_MATCHES_PER_RULE) {
    const start = upperInput.indexOf(upperLiteral, cursor);
    if (start < 0) break;
    const end = start + literal.length;
    matches.push({ value: input.slice(start, end), start, end });
    cursor = end;
  }
  return matches;
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
      ) pairs.add([left.ruleId, right.ruleId].sort().join(":"));
    }
  }
  return pairs;
}

function buildHighlights(occurrences: Occurrence[], collisionPairs: Set<string>): RuleTestHighlight[] {
  const grouped = new Map<string, Omit<RuleTestHighlight, "collision">>();
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
  rules: PresetRule[],
  occurrences: Occurrence[],
  collisionPairs: Set<string>,
  truncatedRules: Set<string>,
): RuleTestWarning[] {
  const warnings: RuleTestWarning[] = [];
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

function requiredText(value: unknown, maximum: number, label: string) {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw new FixtureRuleTestError(`${label} must contain between 1 and ${maximum} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, maximum: number, allowEmpty = false) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
    throw new FixtureRuleTestError(`Text fields must not exceed ${maximum} characters`);
  }
  return value.trim();
}

function isAsciiDigit(character: string | undefined) {
  return character !== undefined && character >= "0" && character <= "9";
}

function isAsciiWord(character: string | undefined) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "_"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
