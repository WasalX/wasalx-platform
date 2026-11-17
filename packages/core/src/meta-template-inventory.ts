/** Private provider inventory. No item or template text belongs in a public DTO. */
export type MetaTemplateJson = null | boolean | number | string | MetaTemplateJson[] | { [key: string]: MetaTemplateJson };
export type MetaTemplateInventoryItem = {
  id: string;
  name: string;
  language: string;
  status: 'APPROVED' | 'ARCHIVED' | 'DELETED' | 'DISABLED' | 'IN_APPEAL' | 'LIMIT_EXCEEDED'
    | 'PAUSED' | 'PENDING' | 'PENDING_DELETION' | 'REJECTED';
  category: 'AUTHENTICATION' | 'FREE_SERVICE' | 'MARKETING' | 'UTILITY';
  parameterFormat: 'NAMED' | 'POSITIONAL' | null;
  qualityScore: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN' | null;
  /** Bounded complete returned definition; unsupported fields must not vanish during comparison. */
  definition: { [key: string]: MetaTemplateJson };
};
export type MetaTemplateInventory = {
  accountId: string;
  items: ReadonlyArray<MetaTemplateInventoryItem>;
  complete: boolean;
};

const statuses = new Set(['APPROVED', 'ARCHIVED', 'DELETED', 'DISABLED', 'IN_APPEAL', 'LIMIT_EXCEEDED',
  'PAUSED', 'PENDING', 'PENDING_DELETION', 'REJECTED']);
const categories = new Set(['AUTHENTICATION', 'FREE_SERVICE', 'MARKETING', 'UTILITY']);
const qualities = new Set(['GREEN', 'YELLOW', 'RED', 'UNKNOWN']);
const numericId = /^[0-9]{1,32}$/u;
function row(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}
function json(value: unknown, depth = 0): value is MetaTemplateJson {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 32_768;
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(item => json(item, depth + 1));
  const record = row(value);
  return record !== null && Object.keys(record).length <= 100 && Object.entries(record).every(([key, item]) =>
    key.length <= 128 && !['__proto__', 'constructor', 'prototype'].includes(key) && json(item, depth + 1));
}

/**
 * Meta's retained v24 MessageTemplate response contract. Missing optional format
 * or quality is unknown, never POSITIONAL or GREEN. Components are captured but
 * not declared compatible merely because their JSON is complete.
 */
export function parseMetaTemplateInventoryItem(value: unknown): MetaTemplateInventoryItem | null {
  const v = row(value);
  if (!v || typeof v.id !== 'string' || !numericId.test(v.id)
    || typeof v.name !== 'string' || !/^[a-z0-9_]{1,512}$/u.test(v.name)
    || typeof v.language !== 'string' || !/^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8}){0,2}$/u.test(v.language)
    || typeof v.status !== 'string' || !statuses.has(v.status)
    || typeof v.category !== 'string' || !categories.has(v.category)
    || !Array.isArray(v.components) || v.components.length > 100 || !json(v)
    || new TextEncoder().encode(JSON.stringify(v)).length > 65_536) return null;
  if (v.parameter_format !== undefined && v.parameter_format !== 'NAMED' && v.parameter_format !== 'POSITIONAL') return null;
  const quality = v.quality_score === undefined ? null : row(v.quality_score);
  if (v.quality_score !== undefined && (!quality || typeof quality.score !== 'string' || !qualities.has(quality.score))) return null;
  for (const component of v.components) {
    const c = row(component);
    if (!c || typeof c.type !== 'string' || !/^[A-Z_]{1,64}$/u.test(c.type)) return null;
  }
  return {
    id: v.id, name: v.name, language: v.language,
    status: v.status as MetaTemplateInventoryItem['status'], category: v.category as MetaTemplateInventoryItem['category'],
    parameterFormat: v.parameter_format as MetaTemplateInventoryItem['parameterFormat'] ?? null,
    qualityScore: quality?.score as MetaTemplateInventoryItem['qualityScore'] ?? null,
    // Detach the snapshot; no caller can mutate provider JSON after it is read.
    definition: JSON.parse(JSON.stringify(v)) as MetaTemplateInventoryItem['definition'],
  };
}
