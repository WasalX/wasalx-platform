/** Public local review/recovery only. A registration or SDK event never grants
 * legacy eligibility. The current live capability remains unavailable. */
export type MetaLegacyMigrationAction = 'OBSERVE' | 'REGISTER' | 'RECONCILE';
export type MetaLegacyMigrationReason = 'LEGACY_PROVIDER_CONTRACT_UNAVAILABLE' | 'CUSTOMER_TRANSFER_CONTRACT_UNAVAILABLE'
  | 'PHONE_MAPPING_UNAVAILABLE' | 'CURRENT_PERMISSION_REQUIRED' | 'CURRENT_SCOPE_CHANGED' | 'DESTINATION_AUTHORIZATION_REQUIRED'
  | 'DESTINATION_ACCESS_EXPIRED' | 'PAYMENT_REVIEW_REQUIRED' | 'TEMPLATES_UNREADY' | 'TEMPLATE_COPY_UNRESOLVED'
  | 'SOURCE_TWO_STEP_REVIEW_REQUIRED' | 'ACTIVE_EFFECTS_PENDING' | 'PROVIDER_OUTCOME_UNRESOLVED'
  | 'PROVIDER_READ_UNAVAILABLE' | 'REGISTRATION_REJECTED' | 'PRIVACY_HELD';
export type MetaLegacyMigrationIntent = { operationId: string; requestKey: string; action: MetaLegacyMigrationAction;
  requestRevision: number; state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED_TERMINAL' | 'CANCELLED' };
export type MetaLegacyMigrationRequest = { templateObservationOperationId: string;
  expectedSourceBindingRevision: number; expectedTargetBindingRevision: number };
export type MetaLegacyMigrationActionRequest = { expectedRevision: number; expectedReviewSha256: string;
  /** Present only for REGISTER. This confirms the exact server review digest;
   * it is never provider applicability or source ownership evidence. */
  confirmCutover?: true };
export type MetaLegacyMigrationCancelRequest = { expectedRevision: number };
export type MetaLegacyMigrationCancelResult = { id: string; duplicate: boolean };
export type MetaLegacyMigrationView = {
  id: string; revision: number; sourceConnection: { id: string; name: string | null };
  destinationAccount: { label: string | null; paymentResponsibility: 'CUSTOMER' | 'WASALX_MANAGED' };
  state: 'REVIEW' | 'PREREQUISITE_REQUIRED' | 'AUTHORIZATION_REQUIRED' | 'READY' | 'REGISTERING'
    | 'OUTCOME_UNKNOWN' | 'READBACK_REQUIRED' | 'RECONCILED_PAUSED' | 'CANCELLED' | 'HELD';
  reviewSha256: string; expiresAt: string | null; reasons: MetaLegacyMigrationReason[];
  /** Only server-derived capability is shown. No eligibility override field. */
  capability: { live: false; qualificationOnly: boolean };
  impact: { sourceConnections: number; destinationConnections: number; inheritedFlowVersions: number;
    templates: number; keepsOriginalHistory: true; result: 'PAUSED' };
  authorization: null | { targetConnectionId: string; targetLegacyMigrationId: string; canPrepare: boolean; canContinue: boolean };
  actions: { observe: boolean; register: boolean; reconcile: boolean; cancel: boolean };
  originalRegistration: null | { outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'REJECTED' | 'UNKNOWN'; attemptedAt: string };
  pendingAction: MetaLegacyMigrationIntent | null;
};
export type MetaLegacyMigrationPage = { prepare: null | { templateObservationOperationId: string;
  sourceBindingRevision: number; targetBindingRevision: number }; currentPlan: MetaLegacyMigrationView | null };
export type MetaLegacyMigrationCreateResult = { id: string | null; operationId: string; requestKey: string;
  request: MetaLegacyMigrationRequest; state: 'ADMITTED' | 'NO_EFFECT'; duplicate: boolean };
export type MetaLegacyMigrationActionResult = { id: string; operationId: string; pendingAction: MetaLegacyMigrationIntent; duplicate: boolean };

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid migration request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) throw new Error('Invalid migration request');
  return input;
}
export function parseMetaLegacyMigrationRequest(value: unknown): MetaLegacyMigrationRequest {
  const input = object(value, ['templateObservationOperationId', 'expectedSourceBindingRevision', 'expectedTargetBindingRevision']);
  if (!uuid(input.templateObservationOperationId) || !positive(input.expectedSourceBindingRevision)
    || !positive(input.expectedTargetBindingRevision)) throw new Error('Invalid migration request');
  return input as MetaLegacyMigrationRequest;
}
export function parseMetaLegacyMigrationActionRequest(value: unknown, action: MetaLegacyMigrationAction): MetaLegacyMigrationActionRequest {
  if (!['OBSERVE', 'REGISTER', 'RECONCILE'].includes(action)) throw new Error('Invalid migration action');
  const input = object(value, action === 'REGISTER' ? ['expectedRevision', 'expectedReviewSha256', 'confirmCutover']
    : ['expectedRevision', 'expectedReviewSha256']);
  if (!positive(input.expectedRevision) || !digest(input.expectedReviewSha256)
    || (action === 'REGISTER' && input.confirmCutover !== true)) throw new Error('Invalid migration action');
  return input as MetaLegacyMigrationActionRequest;
}
export function parseMetaLegacyMigrationCancelRequest(value: unknown): MetaLegacyMigrationCancelRequest {
  const input = object(value, ['expectedRevision']);
  if (!positive(input.expectedRevision)) throw new Error('Invalid migration request');
  return input as MetaLegacyMigrationCancelRequest;
}
