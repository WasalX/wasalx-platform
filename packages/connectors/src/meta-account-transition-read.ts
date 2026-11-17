import { readMetaTemplateInventory } from './meta-template-read.js';
import type { MetaTemplateInventoryItem } from '../../core/src/meta-template-inventory.js';
/**
 * Read-only helper consumed by MetaGroupsAdapter through its incumbent fixed-origin
 * request(..., "read") closure. It accepts no host, token, URL or public evidence.
 */
export type MetaTransitionRead = (path: string, query: Record<string, string>) => Promise<unknown>;
export type MetaTransitionInventory = {
  sourceAccountId: string;
  currency: string | null;
  phoneIds: ReadonlyArray<string>;
  phonesComplete: boolean;
  templatesComplete: boolean;
  /** Private read evidence only; never copied into the public preview. */
  templates: ReadonlyArray<MetaTemplateInventoryItem>;
};

const NUMERIC_ID = /^[0-9]{1,32}$/u;
const PAGE_LIMIT = 20;
const ITEM_LIMIT = 2_000;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);
}
type PageResult<T> = { items: T[]; complete: boolean };
async function pages<T extends { id: string }>(request: MetaTransitionRead, path: string, fields: string,
  parse: (value: unknown) => T | null): Promise<PageResult<T>> {
  const items: T[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const response = record(await request(path, { fields, limit: "100", ...(after ? { after } : {}) }));
    if (!response || !Array.isArray(response.data)) return { items, complete: false };
    for (const value of response.data) {
      const item = parse(value);
      if (!item || ids.has(item.id) || items.length >= ITEM_LIMIT) return { items, complete: false };
      ids.add(item.id); items.push(item);
    }
    if (response.paging === undefined) return { items, complete: true };
    const paging = record(response.paging);
    if (!paging) return { items, complete: false };
    if (paging.next === undefined || paging.next === null) return { items, complete: true };
    // Never fetch provider-supplied next URLs; only carry a bounded cursor to the same exact edge.
    const cursor = record(paging.cursors)?.after;
    if (!text(paging.next, 8_192) || !text(cursor, 2_048) || cursors.has(cursor))
      return { items, complete: false };
    cursors.add(cursor); after = cursor;
  }
  return { items, complete: false };
}
function phone(value: unknown): { id: string } | null {
  const v = record(value);
  return typeof v?.id === "string" && NUMERIC_ID.test(v.id) ? { id: v.id } : null;
}
export async function readMetaTransitionInventory(sourceAccountId: string, request: MetaTransitionRead): Promise<MetaTransitionInventory> {
  if (!NUMERIC_ID.test(sourceAccountId)) throw new Error("META_TRANSITION_ACCOUNT_INVALID");
  const path = `/${encodeURIComponent(sourceAccountId)}`;
  const account = record(await request(path, { fields: "id,currency" }));
  if (account?.id !== sourceAccountId) throw new Error("META_TRANSITION_ACCOUNT_MISMATCH");
  const currency = typeof account.currency === "string" && /^[A-Z]{3}$/u.test(account.currency) ? account.currency : null;
  const phones = await pages(request, `${path}/phone_numbers`, "id", phone);
  const templates = await readMetaTemplateInventory(sourceAccountId, request);
  return { sourceAccountId, currency, phoneIds: phones.items.map(item => item.id), phonesComplete: phones.complete,
    templatesComplete: templates.complete, templates: templates.items };
}
