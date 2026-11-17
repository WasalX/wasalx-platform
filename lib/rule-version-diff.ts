export type RuleFieldDiff = {
  key: string;
  label: string;
  before: string;
  after: string;
  summary: string;
};

type RuleRecord = Record<string, unknown>;

const ORDERED_MATERIAL_FIELDS = [
  "name",
  "preset",
  "matcherPreset",
  "matcherType",
  "pattern",
  "matcherOptions",
  "priority",
  "enabled",
  "savedExamples",
] as const;

const NON_MATERIAL_FIELDS = new Set(["id", "matchCount", "version"]);

/**
 * Produces operator-safe evidence for every material rule field that changed.
 * Rule IDs and runtime counters are deliberately ignored because immutable
 * snapshots allocate new IDs even when routing behavior is identical.
 */
export function describeRuleChange(change: RuleRecord): RuleFieldDiff[] {
  const before = asRecord(change.before);
  const after = asRecord(change.after);
  if (!before || !after) return [];

  const presentKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const ordered = ORDERED_MATERIAL_FIELDS.filter((key) => presentKeys.has(key));
  const extras = [...presentKeys]
    .filter((key) => !NON_MATERIAL_FIELDS.has(key) && !ordered.includes(key as never))
    .sort();

  return [...ordered, ...extras].flatMap((key) => {
    const previous = normalizeFieldValue(key, before[key]);
    const next = normalizeFieldValue(key, after[key]);
    if (canonical(previous) === canonical(next)) return [];

    const fieldLabel = ruleFieldLabel(key);
    const beforeText = displayFieldValue(key, previous);
    const afterText = displayFieldValue(key, next);
    return [{
      key,
      label: fieldLabel,
      before: beforeText,
      after: afterText,
      summary: savedExampleSummary(previous, next) ?? `${fieldLabel} ${beforeText} → ${afterText}`,
    }];
  });
}

function asRecord(value: unknown): RuleRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RuleRecord
    : null;
}

function normalizeFieldValue(key: string, value: unknown): unknown {
  if (key === "matcherOptions") {
    const options = asRecord(value);
    if (!options) return {};
    return Object.fromEntries(
      Object.entries(options)
        .filter(([, option]) => option !== null && option !== undefined && option !== "")
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  if (key === "savedExamples") return Array.isArray(value) ? value : [];
  return value === undefined ? null : value;
}

function savedExampleSummary(previous: unknown, next: unknown) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return null;
  if (previous.length !== next.length) {
    return `Saved examples ${previous.length} → ${next.length}`;
  }
  const names = (values: unknown[]) => values
    .map((value) => asRecord(value)?.name)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  const beforeNames = names(previous);
  const afterNames = names(next);
  if (canonical(beforeNames) !== canonical(afterNames)) {
    return `Saved examples ${beforeNames.join(", ") || "None"} → ${afterNames.join(", ") || "None"}`;
  }
  const subject = afterNames.length ? afterNames.join(", ") : `${next.length} saved examples`;
  return `Saved example content updated: ${subject}`;
}

function displayFieldValue(key: string, value: unknown): string {
  if (key === "enabled") return value === true ? "Enabled" : "Disabled";
  if (key === "matcherType" || key === "preset" || key === "matcherPreset") {
    return humanize(String(value ?? "None"));
  }
  if (key === "matcherOptions") {
    const options = asRecord(value);
    if (!options || Object.keys(options).length === 0) return "None";
    return Object.entries(options)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([option, optionValue]) => `${humanize(option)}: ${displayScalar(optionValue)}`)
      .join(", ");
  }
  if (key === "savedExamples") {
    const count = Array.isArray(value) ? value.length : 0;
    return `${count} ${count === 1 ? "example" : "examples"}`;
  }
  return displayScalar(value);
}

function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === "") return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const serialized = canonical(value);
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}

function ruleFieldLabel(key: string) {
  const labels: Record<string, string> = {
    matcherPreset: "Preset",
    matcherType: "Matcher type",
    matcherOptions: "Matcher options",
    savedExamples: "Saved examples",
    enabled: "State",
  };
  return labels[key] ?? humanize(key);
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as RuleRecord;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
