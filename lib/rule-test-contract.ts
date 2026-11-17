export type RuleTestRequest = {
  message?: unknown;
  rules?: unknown;
  sender?: unknown;
};

export type RuleTestMatch = {
  ruleId: string;
  ruleName: string;
  value: string;
  normalizedValue: string;
  start: number;
  end: number;
};

export type RuleTestHighlight = {
  start: number;
  end: number;
  text: string;
  normalizedValue: string;
  ruleIds: string[];
  ruleNames: string[];
  collision: boolean;
};

export type RuleTestWarning = {
  code: "OVERLAPPING_RULES" | "BROAD_MATCH" | "MATCH_LIMIT_REACHED";
  message: string;
  ruleIds: string[];
};

export type RuleTestResult = {
  original: string;
  normalized: string;
  spanSource: "normalized";
  matches: RuleTestMatch[];
  highlights: RuleTestHighlight[];
  warnings: RuleTestWarning[];
  occurrenceCount: number;
  truncated: boolean;
};
