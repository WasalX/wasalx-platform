import { parseMetaTemplateInventoryItem, type MetaTemplateInventory, type MetaTemplateInventoryItem } from '../../core/src/meta-template-inventory.js';

export type MetaTemplateRead = (path: string, query: Record<string, string>) => Promise<unknown>;
/** Explicit documented v24 fields, including options whose omission could hide content differences. */
export const META_TEMPLATE_INVENTORY_FIELDS = 'id,name,language,status,category,parameter_format,components,quality_score,'
  + 'message_send_ttl_seconds,is_primary_device_delivery_only,is_sms_fallback_enabled,display_format,sub_category,'
  + 'cta_url_link_tracking_opted_out,degrees_of_freedom_spec';
const PAGE_LIMIT = 20, ITEM_LIMIT = 2_000, BYTE_LIMIT = 4_194_304;
function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
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
