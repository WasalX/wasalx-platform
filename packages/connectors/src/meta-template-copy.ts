import { ProviderError } from './types.js';
const numeric = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,32}$/u.test(value);
const row = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
export type MetaTemplateCopyRequest = { sourceAccountId: string; targetAccountId: string; templateIds: readonly string[] };
export type MetaTemplateCopyResult = { migratedTemplateIds: string[]; failedSourceTemplateIds: string[]; completeResponse: boolean };
export function metaTemplateCopyBody(request: MetaTemplateCopyRequest): { source_waba_id: string; template_ids: string[] } {
  if (!numeric(request.sourceAccountId) || !numeric(request.targetAccountId) || request.sourceAccountId === request.targetAccountId
    || !Array.isArray(request.templateIds) || !request.templateIds.length || request.templateIds.length > 500
    || !request.templateIds.every(numeric) || new Set(request.templateIds).size !== request.templateIds.length)
    throw new ProviderError('Template preparation is not admitted.', false, 'META_TEMPLATE_COPY_NOT_ATTEMPTED', undefined, true);
  return { source_waba_id: request.sourceAccountId, template_ids: [...request.templateIds] };
}

/** No source-to-target mapping is inferred from returned IDs. Failure prose is
 * provider-private and excluded from this safe checkpoint projection. Unknown
 * shape is an unknown mutation result, never permission to reduce/retry a batch. */
export function parseMetaTemplateCopyResult(value: unknown, selectedSourceIds: readonly string[]): MetaTemplateCopyResult {
  const v = row(value), failed = row(v?.failed_templates), migrated = v?.migrated_templates;
  if (!v || !failed || !Array.isArray(migrated) || migrated.length > selectedSourceIds.length
    || migrated.length > 500 || !migrated.every(numeric) || new Set(migrated).size !== migrated.length
    || Object.keys(failed).length > selectedSourceIds.length || Object.keys(failed).some(id => !numeric(id) || !selectedSourceIds.includes(id))
    || Object.values(failed).some(reason => typeof reason !== 'string' || reason.length > 4096)
    || migrated.length + Object.keys(failed).length !== selectedSourceIds.length)
    throw new ProviderError('Template preparation outcome needs review.', false, 'META_TEMPLATE_COPY_OUTCOME_UNKNOWN', undefined, false);
  return { migratedTemplateIds: [...migrated], failedSourceTemplateIds: Object.keys(failed).sort(), completeResponse: true };
}
