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

export type MetaTemplateRead = (path: string, query: Record<string, string>) => Promise<unknown>;
/** Explicit documented v24 fields, including options whose omission could hide content differences. */
export const META_TEMPLATE_INVENTORY_FIELDS = 'id,name,language,status,category,parameter_format,components,quality_score,'
  + 'message_send_ttl_seconds,is_primary_device_delivery_only,is_sms_fallback_enabled,display_format,sub_category,'
  + 'cta_url_link_tracking_opted_out,degrees_of_freedom_spec';
const PAGE_LIMIT = 20, ITEM_LIMIT = 2_000, BYTE_LIMIT = 4_194_304;
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value);
}

/** GET only, supplied by the adapter's existing fixed-origin/currentness-guarded request closure. */
export async function readMetaTemplateInventory(accountId: string, request: MetaTemplateRead): Promise<MetaTemplateInventory> {
  if (!/^[0-9]{1,32}$/u.test(accountId)) throw new Error('META_TEMPLATE_ACCOUNT_INVALID');
  const items: MetaTemplateInventoryItem[] = [], ids = new Set<string>(), names = new Set<string>(), cursors = new Set<string>();
  let after: string | undefined, bytes = 0;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const response = row(await request(`/${encodeURIComponent(accountId)}/message_templates`, {
      fields: META_TEMPLATE_INVENTORY_FIELDS, limit: '100', ...(after ? { after } : {}),
    }));
    if (!response || !Array.isArray(response.data) || response.data.length > 100) return { accountId, items, complete: false };
    for (const value of response.data) {
      const item = parseMetaTemplateInventoryItem(value);
      if (!item) return { accountId, items, complete: false };
      const nameKey = JSON.stringify([item.name, item.language]);
      bytes += new TextEncoder().encode(JSON.stringify(item.definition)).length;
      if (ids.has(item.id) || names.has(nameKey) || items.length >= ITEM_LIMIT || bytes > BYTE_LIMIT)
        return { accountId, items, complete: false };
      ids.add(item.id); names.add(nameKey); items.push(item);
    }
    if (response.paging === undefined) return { accountId, items, complete: true };
    const paging = row(response.paging);
    if (!paging) return { accountId, items, complete: false };
    if (paging.next === undefined || paging.next === null) return { accountId, items, complete: true };
    const cursor = row(paging.cursors)?.after;
    if (!boundedText(paging.next, 8_192) || !boundedText(cursor, 2_048) || cursors.has(cursor))
      return { accountId, items, complete: false };
    // Provider next URLs may contain tokens. Never follow, retain, or log them.
    cursors.add(cursor); after = cursor;
  }
  return { accountId, items, complete: false };
}
