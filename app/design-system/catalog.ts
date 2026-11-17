export const typographyTokens = [
  ["Interface 12", "--wx-font-size-1"],
  ["Interface 13", "--wx-font-size-2"],
  ["Operational 14", "--wx-font-size-3"],
  ["Body 16", "--wx-font-size-4"],
  ["Heading 20", "--wx-font-size-5"],
  ["Heading 24", "--wx-font-size-6"],
  ["Display 32", "--wx-font-size-7"],
] as const;

export const spacingTokens = ["1", "2", "3", "4", "6", "8", "12", "16"] as const;

export const semanticColorTokens = [
  ["Page", "--wx-color-page"],
  ["Surface", "--wx-color-surface"],
  ["Raised", "--wx-color-surface-raised"],
  ["Selected", "--wx-color-surface-selected"],
  ["Border", "--wx-color-border"],
  ["Text", "--wx-color-text"],
  ["Muted", "--wx-color-text-muted"],
  ["Accent", "--wx-color-accent"],
  ["Success", "--wx-color-success"],
  ["Warning", "--wx-color-warning"],
  ["Danger", "--wx-color-danger"],
] as const;
