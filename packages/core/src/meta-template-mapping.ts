import { createHash } from 'node:crypto';
import type { MetaTemplateInventory } from './meta-template-inventory.js';
import { metaTemplateContinuity, metaTemplateSendShape, type MetaTemplateDependency } from './meta-template-continuity.js';

/** Private immutable mapping; not a provider migration or payer authority. */
export type MetaTemplateMapping = MetaTemplateDependency & {
  sourceTemplateId: string; targetTemplateId: string; semanticSha256: string;
};
export type MetaTemplateMappingProof = {
  schemaVersion: 1; claim: 'EXACT_TEMPLATE_SEMANTICS';
  sourceAccountId: string; targetAccountId: string;
  sourceSafetyRevision: number; targetSafetyRevision: number;
  sourceInventorySha256: string; targetInventorySha256: string;
  mappings: MetaTemplateMapping[];
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonical(object[key])).join(',') + '}';
  }
  const encoded=JSON.stringify(value);
  if(encoded===undefined)throw new Error('Template evidence contains a non-JSON value');
  return encoded;
}
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
const providerId = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,32}$/u.test(value);
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const key = (item: MetaTemplateDependency) => JSON.stringify([item.flowVersionId.toLowerCase(), item.name, item.language, item.parameterCount]);
const itemOrder = (a: MetaTemplateMapping, b: MetaTemplateMapping) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/** Both inventories are from current same-token bounded GETs. No mapping is
 * created from a copy response, names alone, counts alone or an unknown copy.
 * A changed name/Meta Flow uses the existing flow publication path instead. */
export function buildMetaTemplateMapping(input: {
  source: MetaTemplateInventory; target: MetaTemplateInventory;
  sourceSafetyRevision: number; targetSafetyRevision: number;
  dependencies: readonly MetaTemplateDependency[]; metaFlowDependencyCount: number;
}): MetaTemplateMappingProof | null {
  const { source, target } = input;
  if (!source.complete || !target.complete || !providerId(source.accountId) || !providerId(target.accountId)
    || source.accountId === target.accountId || !revision(input.sourceSafetyRevision) || !revision(input.targetSafetyRevision)
    || input.metaFlowDependencyCount !== 0 || input.dependencies.length > 2000) return null;
  const mappings = new Map<string, MetaTemplateMapping>();
  for (const dependency of input.dependencies) {
    if (!uuid(dependency.flowVersionId) || !/^[a-z0-9_]{1,512}$/u.test(dependency.name)
      || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(dependency.language)
      || !Number.isSafeInteger(dependency.parameterCount) || dependency.parameterCount < 0 || dependency.parameterCount > 20) return null;
    const compared = metaTemplateContinuity(source, target, dependency);
    if (!compared.ready || !compared.sourceTemplateId || !compared.targetTemplateId || !compared.semanticSha256) return null;
    const mapping: MetaTemplateMapping = { name:dependency.name,language:dependency.language,parameterCount:dependency.parameterCount,
      flowVersionId: dependency.flowVersionId.toLowerCase(), sourceTemplateId: compared.sourceTemplateId,
      targetTemplateId: compared.targetTemplateId, semanticSha256: compared.semanticSha256 };
    const previous = mappings.get(key(dependency));
    if (previous && sha(previous) !== sha(mapping)) return null;
    mappings.set(key(dependency), mapping);
  }
  return { schemaVersion: 1, claim: 'EXACT_TEMPLATE_SEMANTICS', sourceAccountId: source.accountId,
    targetAccountId: target.accountId, sourceSafetyRevision: input.sourceSafetyRevision,
    targetSafetyRevision: input.targetSafetyRevision, sourceInventorySha256: sha(source), targetInventorySha256: sha(target),
    mappings: [...mappings.values()].sort(itemOrder) };
}

/** Narrow private parser for a sealed operation result. Receipt validity and
 * current send authority are deliberately separate: later expiry/negative
 * callbacks do not erase historical mappings. Current SQL checks them anew. */
export function parseMetaTemplateMapping(value: unknown): MetaTemplateMappingProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== ['schemaVersion', 'claim', 'sourceAccountId', 'targetAccountId',
    'sourceSafetyRevision', 'targetSafetyRevision', 'sourceInventorySha256', 'targetInventorySha256', 'mappings'].sort().join(',')
    || item.schemaVersion !== 1 || item.claim !== 'EXACT_TEMPLATE_SEMANTICS'
    || !providerId(item.sourceAccountId) || !providerId(item.targetAccountId) || item.sourceAccountId === item.targetAccountId
    || !revision(item.sourceSafetyRevision) || !revision(item.targetSafetyRevision)
    || !digest(item.sourceInventorySha256) || !digest(item.targetInventorySha256)
    || !Array.isArray(item.mappings) || item.mappings.length > 2000) return null;
  const seen = new Set<string>();
  for (const entry of item.mappings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== ['flowVersionId', 'name', 'language', 'parameterCount',
      'sourceTemplateId', 'targetTemplateId', 'semanticSha256'].sort().join(',')
      || !uuid(row.flowVersionId) || typeof row.name !== 'string' || !/^[a-z0-9_]{1,512}$/u.test(row.name)
      || typeof row.language !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/u.test(row.language)
      || !revision(row.parameterCount) || row.parameterCount > 20 || !providerId(row.sourceTemplateId)
      || !providerId(row.targetTemplateId) || !digest(row.semanticSha256)) return null;
    const identity = key(row as MetaTemplateDependency);
    if (seen.has(identity)) return null;
    seen.add(identity);
  }
  return item as MetaTemplateMappingProof;
}

/** A final send consumes the exact inherited flow mapping. This pure comparison
 * never admits a delivery: SQL separately pins the original binding/operation,
 * current target safety generation, delivery lease and existing effect guards.
 * A fresh GET with equal names but changed semantics cannot clear the hold. */
export function currentMetaMappedTemplate(input: {
  mapping: MetaTemplateMappingProof; target: MetaTemplateInventory;
  flowVersionId: string; name: string; language: string; parameterCount: number;
}): MetaTemplateMapping | null {
  const proof = parseMetaTemplateMapping(input.mapping);
  if (!proof || !uuid(input.flowVersionId) || !input.target.complete || input.target.accountId !== proof.targetAccountId) return null;
  const matches = proof.mappings.filter(item => key(item) === key({ flowVersionId: input.flowVersionId,
    name: input.name, language: input.language, parameterCount: input.parameterCount }));
  if (matches.length !== 1) return null;
  const mapping = matches[0]!;
  const items = input.target.items.filter(item => item.name === mapping.name && item.language === mapping.language);
  if (items.length !== 1 || items[0]!.id !== mapping.targetTemplateId || items[0]!.status !== 'APPROVED') return null;
  const shape = metaTemplateSendShape(items[0]!);
  return shape?.parameterCount === mapping.parameterCount && shape.semanticSha256 === mapping.semanticSha256 ? mapping : null;
}
