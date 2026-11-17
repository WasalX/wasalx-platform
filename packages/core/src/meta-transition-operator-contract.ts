/** Pure HTTP boundary shared by the existing platform console and control API. */
export type MetaTransitionOperatorAction = 'PREREQUISITES' | 'TARGET' | 'COMPLETION';
export type MetaTransitionOperatorRequest = {
  expectedRevision: number;
  expectedReviewSha256: string;
  evidenceSha256: string;
  confirmed: true;
  sourcePayment?: 'CARD' | 'LINE';
  managed?: { arrangementVersionId: string; targetReceivingBusinessId: string;
    targetTermsDocumentText: string; targetTermsVersion: string };
  templateEvidenceSha256?: string;
  flowEvidenceSha256?: string;
};
export type MetaTransitionOperatorResult = {
  tenantId: string; planId: string; requestKey: string; action: MetaTransitionOperatorAction;
  request: MetaTransitionOperatorRequest; state: 'APPLIED' | 'NO_EFFECT';
  commandReceiptId: string; approvalReceiptId: string | null; duplicate: boolean;
};
export type MetaTransitionOperatorSummary = {
  id: string; name: string; revision: number; requestedMode: 'CUSTOMER' | 'WASALX_MANAGED';
  sourceCurrency: string | null; targetCurrency: string;
  phase: 'PREVIEW' | 'RESERVED' | 'IN_PROGRESS' | 'READY_TO_COMPLETE' | 'PROVIDER_COMPLETED' | 'RECONCILED_PAUSED' | 'CANCELLED' | 'HELD';
};
export type MetaTransitionOperatorReview = MetaTransitionOperatorSummary & {
  tenantId: string; evidenceMode: 'SIMULATED'; reviewSha256: string;
  connectionNames: string[]; connectionCount: number;
  providerStatus: 'INITIATED' | 'ACCEPTED' | 'IN_PROGRESS' | 'READY_TO_COMPLETE' | 'COMPLETED' | 'FAILED' | 'FAILED_TO_COMPLETE' | 'REJECTED' | null;
  checkpoints: Array<{ stage: 'INITIATE' | 'COMPLETE'; outcome: 'ATTEMPTED' | 'UNKNOWN' | 'SUCCEEDED' | 'REJECTED' }>;
  proof: { sourceScope: 'CURRENT' | 'UNAVAILABLE'; targetAccess: 'NONE' | 'CLONE' | 'FINAL';
    payment: 'VERIFIED' | 'UNAVAILABLE'; renewedObserver: 'CURRENT' | 'ABSENT' | 'UNAVAILABLE';
    prerequisiteApproval: 'CURRENT' | 'MISSING'; targetReview: 'CURRENT' | 'MISSING' };
  actions: Record<MetaTransitionOperatorAction, boolean>;
  reasons: Array<'PLAN_CLOSED' | 'SOURCE_SCOPE_UNAVAILABLE' | 'TARGET_READ_REQUIRED' | 'PAYMENT_READ_REQUIRED' |
    'OBSERVER_RENEWAL_REQUIRED' | 'ORIGINAL_INITIATION_UNRESOLVED' | 'COMPLETE_ALREADY_ATTEMPTED' | 'APPROVAL_REQUIRED' | 'TRANSITION_BUSY'>;
  arrangements: Array<{ id: string; label: string; expiresAt: string }>;
  originalGrant: null | { sourcePayment: 'CARD' | 'LINE'; managed: MetaTransitionOperatorRequest['managed'] | null };
  pendingCommand: MetaTransitionOperatorResult | null;
};

const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Parsing authorizes no provider/financial fact. SQL resolves current evidence. */
export function parseMetaTransitionOperatorRequest(action: MetaTransitionOperatorAction, value: unknown): MetaTransitionOperatorRequest | null {
  if (!object(value) || !['PREREQUISITES','TARGET','COMPLETION'].includes(action)) return null;
  const keys = ['expectedRevision','expectedReviewSha256','evidenceSha256','confirmed',
    ...(action === 'PREREQUISITES' ? ['sourcePayment','managed'] : action === 'TARGET' ? ['templateEvidenceSha256','flowEvidenceSha256'] : [])];
  if (Object.keys(value).some(key => !keys.includes(key)) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
    || !hex(value.expectedReviewSha256) || !hex(value.evidenceSha256) || value.confirmed !== true) return null;
  const result: MetaTransitionOperatorRequest = { expectedRevision: Number(value.expectedRevision), expectedReviewSha256: value.expectedReviewSha256,
    evidenceSha256: value.evidenceSha256, confirmed: true };
  if (action === 'PREREQUISITES') {
    if (value.sourcePayment !== 'CARD' && value.sourcePayment !== 'LINE') return null;
    result.sourcePayment = value.sourcePayment;
    if (Object.hasOwn(value,'managed')) {
      const managed = value.managed;
      if (!object(managed) || Object.keys(managed).length !== 4 || !uuid(managed.arrangementVersionId)
        || typeof managed.targetReceivingBusinessId !== 'string' || !/^[0-9]{1,32}$/u.test(managed.targetReceivingBusinessId)
        || typeof managed.targetTermsDocumentText !== 'string' || new TextEncoder().encode(managed.targetTermsDocumentText).byteLength < 1
        || new TextEncoder().encode(managed.targetTermsDocumentText).byteLength > 32768
        || typeof managed.targetTermsVersion !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(managed.targetTermsVersion)) return null;
      result.managed = { arrangementVersionId: managed.arrangementVersionId, targetReceivingBusinessId: managed.targetReceivingBusinessId,
        targetTermsDocumentText: managed.targetTermsDocumentText, targetTermsVersion: managed.targetTermsVersion };
    }
  } else if (action === 'TARGET') {
    if (!hex(value.templateEvidenceSha256) || !hex(value.flowEvidenceSha256)) return null;
    result.templateEvidenceSha256 = value.templateEvidenceSha256; result.flowEvidenceSha256 = value.flowEvidenceSha256;
  }
  return result;
}
