import { createHash } from 'node:crypto';
import type { MetaTemplateInventory, MetaTemplateInventoryItem, MetaTemplateJson } from './meta-template-inventory.js';

export type MetaTemplateDependency = { flowVersionId: string; name: string; language: string; parameterCount: number };
export type MetaTemplateContinuityReason = 'INVENTORY_INCOMPLETE' | 'SOURCE_MISSING' | 'TARGET_MISSING' | 'AMBIGUOUS_TEMPLATE'
  | 'SOURCE_NOT_APPROVED' | 'TARGET_NOT_APPROVED' | 'UNSUPPORTED_DEFINITION' | 'CONTENT_CHANGED' | 'PARAMETERS_CHANGED';
export type MetaTemplateContinuity = { ready: boolean; reason: MetaTemplateContinuityReason | null;
  sourceTemplateId: string | null; targetTemplateId: string | null; semanticSha256: string | null };
const own = (value: unknown): value is Record<string, MetaTemplateJson> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, MetaTemplateJson>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
function canonical(value: MetaTemplateJson): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (own(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function parameters(text: string): number | null {
  const indices = [...text.matchAll(/\{\{([1-9][0-9]?)\}\}/gu)].map(match => Number(match[1]));
  // Braces with unknown syntax must not be stripped into apparently static text.
  if (/[{}]/u.test(text.replace(/\{\{[1-9][0-9]?\}\}/gu, ''))) return null;
  const maximum = Math.max(0, ...indices);
  return maximum <= 20 && Array.from({ length: maximum }, (_, i) => i + 1).every(index => indices.includes(index)) ? maximum : null;
}
const topFields = ['id', 'name', 'language', 'status', 'category', 'parameter_format', 'components', 'quality_score',
  'message_send_ttl_seconds', 'is_primary_device_delivery_only', 'is_sms_fallback_enabled', 'display_format', 'sub_category',
  'cta_url_link_tracking_opted_out', 'degrees_of_freedom_spec'] as const;
const ignored = new Set(['id', 'name', 'status', 'quality_score', 'components']);

/** Finite compatibility with WasalX's existing positional BODY-only sender.
 * Unknown semantics are unsupported, never discarded to manufacture equality.
 * Template examples are documented sample data; actual text, URLs and ordering
 * remain exact. Optional delivery options are compared with presence preserved. */
export function metaTemplateSendShape(item: MetaTemplateInventoryItem): { parameterCount: number; semanticSha256: string } | null {
  const definition = item.definition;
  if (item.parameterFormat !== 'POSITIONAL' || !exactKeys(definition, topFields) || !Array.isArray(definition.components)) return null;
  const components: MetaTemplateJson[] = [];
  let bodyCount = 0, parameterCount = 0;
  const types = new Set<string>();
  for (const component of definition.components) {
    if (!own(component) || typeof component.type !== 'string' || types.has(component.type)) return null;
    types.add(component.type);
    if (['BODY', 'HEADER', 'FOOTER'].includes(component.type)) {
      if (!exactKeys(component, ['type', 'text', 'format', 'example']) || typeof component.text !== 'string') return null;
      if (component.type === 'HEADER' ? component.format !== 'TEXT' : component.format !== undefined) return null;
      const count = parameters(component.text);
      if (count === null || (component.type !== 'BODY' && count !== 0)) return null;
      if (component.type === 'BODY') { bodyCount++; parameterCount = count; }
      components.push(Object.fromEntries(Object.entries(component).filter(([key]) => key !== 'example')));
    } else if (component.type === 'BUTTONS') {
      if (!exactKeys(component, ['type', 'buttons']) || !Array.isArray(component.buttons) || component.buttons.length > 10) return null;
      const buttons: MetaTemplateJson[] = [];
      for (const button of component.buttons) {
        if (!own(button) || typeof button.text !== 'string' || parameters(button.text) !== 0) return null;
        if (button.type === 'URL') {
          if (!exactKeys(button, ['type', 'text', 'url']) || typeof button.url !== 'string' || parameters(button.url) !== 0) return null;
        } else if (button.type === 'PHONE_NUMBER') {
          if (!exactKeys(button, ['type', 'text', 'phone_number']) || typeof button.phone_number !== 'string') return null;
        } else if (button.type === 'QUICK_REPLY') {
          if (!exactKeys(button, ['type', 'text'])) return null;
        } else return null; // FLOW/OTP/dynamic payloads need their own verified adapter contract.
        buttons.push(button);
      }
      components.push({ type: 'BUTTONS', buttons });
    } else return null;
  }
  if (bodyCount !== 1) return null;
  const semantic: Record<string, MetaTemplateJson> = Object.fromEntries(Object.entries(definition).filter(([key]) => !ignored.has(key)));
  semantic.components = components;
  return { parameterCount, semanticSha256: createHash('sha256').update(canonical(semantic)).digest('hex') };
}

export function metaTemplateContinuity(source: MetaTemplateInventory, target: MetaTemplateInventory, dependency: Pick<MetaTemplateDependency, 'name' | 'language' | 'parameterCount'>): MetaTemplateContinuity {
  const deny = (reason: MetaTemplateContinuityReason, a?: MetaTemplateInventoryItem, b?: MetaTemplateInventoryItem): MetaTemplateContinuity =>
    ({ ready: false, reason, sourceTemplateId: a?.id ?? null, targetTemplateId: b?.id ?? null, semanticSha256: null });
  if (!source.complete || !target.complete) return deny('INVENTORY_INCOMPLETE');
  const sources = source.items.filter(item => item.name === dependency.name && item.language === dependency.language);
  const targets = target.items.filter(item => item.name === dependency.name && item.language === dependency.language);
  if (sources.length > 1 || targets.length > 1) return deny('AMBIGUOUS_TEMPLATE');
  const a = sources[0], b = targets[0];
  if (!a) return deny('SOURCE_MISSING');
  if (!b) return deny('TARGET_MISSING', a);
  if (a.status !== 'APPROVED') return deny('SOURCE_NOT_APPROVED', a, b);
  if (b.status !== 'APPROVED') return deny('TARGET_NOT_APPROVED', a, b);
  const left = metaTemplateSendShape(a), right = metaTemplateSendShape(b);
  if (!left || !right) return deny('UNSUPPORTED_DEFINITION', a, b);
  if (left.parameterCount !== dependency.parameterCount || right.parameterCount !== dependency.parameterCount) return deny('PARAMETERS_CHANGED', a, b);
  if (left.semanticSha256 !== right.semanticSha256) return deny('CONTENT_CHANGED', a, b);
  return { ready: true, reason: null, sourceTemplateId: a.id, targetTemplateId: b.id, semanticSha256: left.semanticSha256 };
}

export function metaTemplateCopyEligible(item: MetaTemplateInventoryItem, kind: 'EXPLICIT_COPY' | 'LEGACY_AUTOMATIC'): boolean {
  return item.status === 'APPROVED' && (item.qualityScore === 'GREEN' || (kind === 'EXPLICIT_COPY' && item.qualityScore === 'UNKNOWN'));
}

/** Pure negative projection, called only after existing signature and exact
 * account/route authorization. It cannot verify a signature or clear a hold. */
export function metaTemplateSafetyMarker(field: string, value: unknown): { templateId: string | null; scope: 'TEMPLATE' | 'ACCOUNT' } | null {
  if (!field.startsWith('message_template_')) return null;
  if (field !== 'message_template_status_update' || !own(value)) return { templateId: null, scope: 'ACCOUNT' };
  const id = value.message_template_id;
  // The retained webhook specifies an integer. Unsafe/absent/changed shapes
  // conservatively invalidate only the authenticated account, not another asset.
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0
    ? { templateId: String(id), scope: 'TEMPLATE' } : { templateId: null, scope: 'ACCOUNT' };
}

/** Ticket sends use the same positional BODY contract as existing bot sends. */
export function approvedTicketTemplate(item: MetaTemplateInventoryItem) {
  if (item.status !== 'APPROVED' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(item.language)) return null;
  const shape = metaTemplateSendShape(item);
  const body = Array.isArray(item.definition.components)
    ? item.definition.components.find(component => own(component) && component.type === 'BODY')
    : undefined;
  if (!shape || !own(body) || typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > 4_096) return null;
  return { id: item.id, name: item.name, language: item.language, text: body.text, ...shape };
}
