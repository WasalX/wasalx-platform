/** Public finite template preparation contract. No provider IDs or body content. */
export type MetaTemplatePreparationAction = 'OBSERVE' | 'COPY' | 'RECONCILE';
export type MetaTemplatePreparationRequest = {
  targetConnectionId: string;
  expectedAccountRevision: number;
  expectedBindingRevision: number;
};
export type MetaTemplatePreparationActionRequest = {
  expectedRevision: number;
  expectedObservationSha256: string | null;
  /** Opaque source inventory choices. Present only for COPY; no provider IDs. */
  choices?: string[];
};
export type MetaTemplatePreparationReason = 'CURRENT_PERMISSION_REQUIRED' | 'BINDING_CHANGED'
  | 'ACCOUNT_ACCESS_UNVERIFIED' | 'SAME_BUSINESS_UNVERIFIED' | 'INVENTORY_INCOMPLETE'
  | 'DEPENDENCIES_CHANGED' | 'UNSUPPORTED_TEMPLATE' | 'TARGET_CONTENT_CHANGED'
  | 'TARGET_NOT_APPROVED' | 'COPY_PARTIAL' | 'COPY_OUTCOME_UNRESOLVED'
  | 'SIGNED_TEMPLATE_CHANGE' | 'RUNTIME_UNQUALIFIED' | 'PROVIDER_READ_UNAVAILABLE';
export type MetaTemplatePreparationView = {
  id: string; revision: number;
  sourceConnection: { id: string; name: string | null };
  targetConnection: { id: string; name: string | null };
  state: 'PENDING' | 'REVIEW' | 'COPYING' | 'PARTIAL' | 'OUTCOME_UNKNOWN' | 'READY' | 'HELD' | 'CANCELLED';
  observationSha256: string | null;
  observedAt: string | null; expiresAt: string | null;
  choices: Array<{ id: string; name: string; language: string; selectable: boolean;
    compatibility: 'EQUIVALENT' | 'MISSING' | 'DIFFERENT' | 'UNSUPPORTED' | 'UNAVAILABLE' }>;
  reasons: MetaTemplatePreparationReason[];
  actions: { observe: boolean; copy: boolean; reconcile: boolean; cancel: boolean };
  /** Unknown copy is never settled by an equivalent target GET. */
  originalCopy: null | { outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN'; attemptedAt: string };
  pendingAction: null | { operationId: string; requestKey: string; action: MetaTemplatePreparationAction;
    requestRevision: number; state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED_TERMINAL' | 'CANCELLED' };
  /** Template readiness alone cannot grant a phone transfer or activation. */
  canCutOver: false;
};
export type MetaTemplatePreparationPage = {
  prepare: null | { accountRevision: number; bindingRevision: number; targets: Array<{ id: string; name: string | null }> };
  currentPlan: MetaTemplatePreparationView | null;
};
export type MetaTemplatePreparationActionResult = {
  id: string; operationId: string; duplicate: boolean;
  pendingAction: NonNullable<MetaTemplatePreparationView['pendingAction']>;
};
export type MetaTemplatePreparationCreateResult = {
  operationId: string; duplicate: boolean; requestKey: string;
  /** Exact original validated body, including the originally submitted UUID case. */
  request: MetaTemplatePreparationRequest;
} & ({ state: 'ADMITTED'; id: string; pendingAction: NonNullable<MetaTemplatePreparationView['pendingAction']> }
  | { state: 'NO_EFFECT'; id: null; pendingAction: null });
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function object(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('META_TEMPLATE_REQUEST_INVALID');
  return v as Record<string, unknown>;
}
export function parseMetaTemplatePreparationRequest(value: unknown): MetaTemplatePreparationRequest {
  const v = object(value);
  if (Object.keys(v).length !== 3 || !uuid(v.targetConnectionId)
    || !revision(v.expectedAccountRevision) || !revision(v.expectedBindingRevision)) throw new Error('META_TEMPLATE_REQUEST_INVALID');
  return { targetConnectionId: v.targetConnectionId, expectedAccountRevision: v.expectedAccountRevision,
    expectedBindingRevision: v.expectedBindingRevision };
}
export function parseMetaTemplatePreparationActionRequest(value: unknown, action: MetaTemplatePreparationAction): MetaTemplatePreparationActionRequest {
  const v = object(value), copy = action === 'COPY';
  if (Object.keys(v).length !== (copy ? 3 : 2) || !revision(v.expectedRevision)
    || (v.expectedObservationSha256 !== null && (typeof v.expectedObservationSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(v.expectedObservationSha256)))
    || (copy && v.expectedObservationSha256 === null)
    || (copy && (!Array.isArray(v.choices) || v.choices.length < 1 || v.choices.length > 500
      || v.choices.some(choice => !uuid(choice)) || new Set(v.choices.map(choice => String(choice).toLowerCase())).size !== v.choices.length)))
    throw new Error('META_TEMPLATE_REQUEST_INVALID');
  return { expectedRevision: v.expectedRevision, expectedObservationSha256: v.expectedObservationSha256 as string | null,
    ...(copy ? { choices: v.choices as string[] } : {}) };
}
