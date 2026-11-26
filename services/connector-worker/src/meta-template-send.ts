import { createHash } from 'node:crypto';
import { MetaGroupsAdapter } from '../../../packages/connectors/src/meta.js';
import { ProviderError } from '../../../packages/connectors/src/types.js';
import { currentMetaMappedTemplate, parseMetaTemplateMapping, type MetaTemplateMappingProof } from '../../../packages/core/src/meta-template-mapping.js';
import type { DeliveryJob } from './types.js';

export type MetaTemplateSendContext = {
  schemaVersion: 1; claim: 'INHERITED_TEMPLATE_SEND'; contextSha256: string;
  transitionId: string; mappingOperationId: string; bindingId: string; bindingRevision: number;
  providerAccountId: string; phoneId: string; flowVersionId: string; targetSafetyRevision: number;
  mapping: MetaTemplateMappingProof;
  template: { name: string; languageCode: string; parameterCount: number };
};
export type MetaTemplateSendProof = {
  schemaVersion: 1; claim: 'CURRENT_INHERITED_TEMPLATE'; contextSha256: string;
  transitionId: string; mappingOperationId: string; bindingId: string; bindingRevision: number;
  targetSafetyRevision: number; targetTemplateId: string; semanticSha256: string;
  inventoryResponseSha256: string; observedAt: string;
};
export interface MetaTemplateSendStore {
  /** null means this exact current delivery has no inherited legacy template.
   * Missing/stale mapping or an old birth account throws; it is not null. */
  context(job: DeliveryJob, leaseId: string): Promise<MetaTemplateSendContext | null>;
}
const unavailable = () => new ProviderError('The inherited template requires a current review.', false,
  'META_TEMPLATE_SEND_HELD', undefined, true);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** GET-only prerequisite for the incumbent final Messages request admission.
 * Returned bytes are stamped on that exact delivery attempt, in the same DB
 * transaction as P08 billing admission. This function grants no route, window,
 * identity, funding, provider eligibility or retry authority. */
export async function verifyMetaInheritedTemplateSend(job: DeliveryJob, leaseId: string,
  store: MetaTemplateSendStore, adapter: MetaGroupsAdapter): Promise<MetaTemplateSendProof | null> {
  const initial = await store.context(job, leaseId);
  if (initial === null) return null;
  const template = job.template;
  if (job.provider !== 'meta' || !template || !/^[a-f0-9]{64}$/u.test(initial.contextSha256)
    || initial.phoneId !== job.sessionId || initial.providerAccountId !== job.metaCredentialContext?.wabaId
    || initial.template.name !== template.name || initial.template.languageCode !== template.languageCode
    || initial.template.parameterCount !== template.bodyParameters.length
    || !parseMetaTemplateMapping(initial.mapping)) throw unavailable();
  const inventory = await adapter.templatePreparationCalls().inventory(initial.providerAccountId);
  const mapping = currentMetaMappedTemplate({ mapping: initial.mapping, target: inventory,
    flowVersionId: initial.flowVersionId, name: template.name, language: template.languageCode,
    parameterCount: template.bodyParameters.length });
  if (!mapping) throw unavailable();
  // The ordinary adapter read guard checks credential/lifecycle authority on
  // every pagination request. The full post-GET comparison also fences signed
  // template invalidation, a replaced mapping, changed binding and lost lease.
  const current = await store.context(job, leaseId);
  if (current === null || digest(current) !== digest(initial)) throw unavailable();
  return { schemaVersion: 1, claim: 'CURRENT_INHERITED_TEMPLATE', contextSha256: initial.contextSha256,
    transitionId: initial.transitionId, mappingOperationId: initial.mappingOperationId,
    bindingId: initial.bindingId, bindingRevision: initial.bindingRevision, targetSafetyRevision: initial.targetSafetyRevision,
    targetTemplateId: mapping.targetTemplateId, semanticSha256: mapping.semanticSha256,
    inventoryResponseSha256: digest(inventory), observedAt: new Date().toISOString() };
}

export async function isVerifiedNonMarketingTemplate(job: DeliveryJob, adapter: MetaGroupsAdapter): Promise<boolean> {
  const template = job.template, accountId = job.metaCredentialContext?.wabaId;
  if (!template || !accountId) return false;
  try {
    const inventory = await adapter.templatePreparationCalls().inventory(accountId);
    const matches = inventory.items.filter(item => item.name === template.name && item.language === template.languageCode);
    return inventory.complete && matches.length === 1 && matches[0]!.status === "APPROVED"
      && matches[0]!.category !== "MARKETING";
  } catch {
    // Missing classification never authorizes a template to an opted-out contact.
    return false;
  }
}
