import { parseMetaLegacyMigrationRequest, parseMetaLegacyMigrationActionRequest, parseMetaLegacyMigrationCancelRequest,
  type MetaLegacyMigrationAction, type MetaLegacyMigrationActionRequest, type MetaLegacyMigrationCreateResult,
  type MetaLegacyMigrationPage, type MetaLegacyMigrationRequest, type MetaLegacyMigrationView } from '../packages/core/src/meta-legacy-migration-contract.ts';

export const legacyUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const time = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const label = (v: unknown) => v === null || typeof v === 'string' && v.length <= 1000;
const actions: MetaLegacyMigrationAction[] = ['OBSERVE', 'REGISTER', 'RECONCILE'];
export const legacyReasons = ['LEGACY_PROVIDER_CONTRACT_UNAVAILABLE', 'CUSTOMER_TRANSFER_CONTRACT_UNAVAILABLE', 'PHONE_MAPPING_UNAVAILABLE',
  'CURRENT_PERMISSION_REQUIRED', 'CURRENT_SCOPE_CHANGED', 'DESTINATION_AUTHORIZATION_REQUIRED', 'DESTINATION_ACCESS_EXPIRED', 'PAYMENT_REVIEW_REQUIRED',
  'TEMPLATES_UNREADY', 'TEMPLATE_COPY_UNRESOLVED', 'SOURCE_TWO_STEP_REVIEW_REQUIRED', 'ACTIVE_EFFECTS_PENDING', 'PROVIDER_OUTCOME_UNRESOLVED',
  'PROVIDER_READ_UNAVAILABLE', 'REGISTRATION_REJECTED', 'PRIVACY_HELD'] as const;
type Pending = NonNullable<MetaLegacyMigrationView['pendingAction']>;
function pending(v: unknown): v is Pending {
  return record(v) && legacyUuid(v.operationId) && legacyUuid(v.requestKey) && revision(v.requestRevision)
    && actions.some(action => action === v.action) && ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].some(state => state === v.state);
}
export function isLegacyView(v: unknown, sourceId: string, planId?: string): v is MetaLegacyMigrationView {
  if (!record(v) || !legacyUuid(v.id) || planId !== undefined && v.id !== planId || !revision(v.revision)
    || !record(v.sourceConnection) || v.sourceConnection.id !== sourceId || !label(v.sourceConnection.name)
    || !record(v.destinationAccount) || !label(v.destinationAccount.label) || typeof v.destinationAccount.paymentResponsibility !== 'string' || !['CUSTOMER', 'WASALX_MANAGED'].includes(v.destinationAccount.paymentResponsibility)
    || typeof v.state !== 'string' || !['REVIEW', 'PREREQUISITE_REQUIRED', 'AUTHORIZATION_REQUIRED', 'READY', 'REGISTERING', 'OUTCOME_UNKNOWN', 'READBACK_REQUIRED', 'RECONCILED_PAUSED', 'CANCELLED', 'HELD'].includes(v.state)
    || !digest(v.reviewSha256) || !(v.expiresAt === null || time(v.expiresAt))
    || !Array.isArray(v.reasons) || v.reasons.length > legacyReasons.length || !v.reasons.every(reason => legacyReasons.some(known => known === reason))
    || !record(v.capability) || v.capability.live !== false || typeof v.capability.qualificationOnly !== 'boolean'
    || !record(v.impact) || v.impact.result !== 'PAUSED' || v.impact.keepsOriginalHistory !== true
    || !['sourceConnections', 'destinationConnections', 'inheritedFlowVersions', 'templates'].every(key => {
      const value = (v.impact as Record<string, unknown>)[key]; return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    }) || !record(v.actions) || !['observe', 'register', 'reconcile', 'cancel'].every(key => typeof (v.actions as Record<string, unknown>)[key] === 'boolean')
    || !(v.pendingAction === null || pending(v.pendingAction))) return false;
  if (v.authorization !== null && (!record(v.authorization) || v.authorization.targetConnectionId !== sourceId
    || v.authorization.targetLegacyMigrationId !== v.id || typeof v.authorization.canPrepare !== 'boolean' || typeof v.authorization.canContinue !== 'boolean')) return false;
  const original = v.originalRegistration;
  if (!(original === null || record(original) && typeof original.outcome === 'string' && ['ATTEMPTED', 'SUCCEEDED', 'REJECTED', 'UNKNOWN'].includes(original.outcome) && time(original.attemptedAt))) return false;
  // Inconsistent mutation-bearing views fail closed, even if an action flag is true.
  if (v.actions.register && (!v.capability.qualificationOnly || original !== null)) return false;
  if (v.actions.cancel && original !== null) return false;
  return !v.actions.reconcile || record(original) && original.outcome === 'SUCCEEDED';
}
export function isLegacyPage(v: unknown, sourceId: string): v is MetaLegacyMigrationPage {
  return record(v) && (v.currentPlan === null || isLegacyView(v.currentPlan, sourceId)) && (v.prepare === null || record(v.prepare)
    && legacyUuid(v.prepare.templateObservationOperationId) && revision(v.prepare.sourceBindingRevision) && revision(v.prepare.targetBindingRevision));
}
export type LegacyIntent = { version: 1; key: string; operationId: string | null } & (
  { action: 'CREATE'; planId: string | null; body: MetaLegacyMigrationRequest }
  | { action: MetaLegacyMigrationAction; planId: string; body: MetaLegacyMigrationActionRequest }
  | { action: 'CANCEL'; planId: string; body: { expectedRevision: number } }
);
export function legacyIntentKey(tenant: string, actor: string, source: string) {
  return `wasalx:meta-legacy:v1:${encodeURIComponent(tenant)}:${encodeURIComponent(actor)}:${source}`;
}
export function parseLegacyIntent(raw: string | null): LegacyIntent | null {
  if (raw === null) return null;
  if (raw.length > 8192) throw new Error('META_MIGRATION_INTENT_UNAVAILABLE');
  let v: unknown; try { v = JSON.parse(raw); } catch { throw new Error('META_MIGRATION_INTENT_UNAVAILABLE'); }
  if (!record(v) || Object.keys(v).length !== 6 || v.version !== 1 || !legacyUuid(v.key)
    || !(v.operationId === null || legacyUuid(v.operationId)) || !(v.planId === null || legacyUuid(v.planId))) throw new Error('META_MIGRATION_INTENT_UNAVAILABLE');
  if (v.action === 'CREATE') return { version: 1, action: v.action, key: v.key, operationId: v.operationId, planId: v.planId, body: parseMetaLegacyMigrationRequest(v.body) };
  if (!legacyUuid(v.planId)) throw new Error('META_MIGRATION_INTENT_UNAVAILABLE');
  if (v.action === 'CANCEL') return { version: 1, action: v.action, key: v.key, operationId: v.operationId, planId: v.planId, body: parseMetaLegacyMigrationCancelRequest(v.body) };
  const action = actions.find(action => action === v.action);
  if (!action) throw new Error('META_MIGRATION_INTENT_UNAVAILABLE');
  return { version: 1, action, key: v.key, operationId: v.operationId, planId: v.planId, body: parseMetaLegacyMigrationActionRequest(v.body, action) };
}
export function legacyPendingMatches(intent: LegacyIntent, v: unknown): v is Pending {
  return intent.action !== 'CREATE' && intent.action !== 'CANCEL' && pending(v) && v.requestKey === intent.key
    && v.action === intent.action && v.requestRevision === intent.body.expectedRevision && (intent.operationId === null || v.operationId === intent.operationId);
}
export function legacyIntentSettled(intent: LegacyIntent, v: unknown, sourceId: string): boolean {
  if (!intent.planId || !isLegacyView(v, sourceId, intent.planId)) return false;
  if (intent.action === 'CANCEL') return v.state === 'CANCELLED' && v.revision === intent.body.expectedRevision + 1;
  // CREATE is settled only by its exact original-key response plus exact-plan GET.
  return legacyPendingMatches(intent, v.pendingAction) && ['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(v.pendingAction.state);
}
export function legacyCancelSuperseded(intent: LegacyIntent, v: unknown, sourceId: string): boolean {
  return intent.action === 'CANCEL' && isLegacyView(v, sourceId, intent.planId) && v.state !== 'CANCELLED' && v.revision > intent.body.expectedRevision;
}
export function legacyCreateResultMatches(intent: LegacyIntent, v: unknown): v is MetaLegacyMigrationCreateResult {
  if (intent.action !== 'CREATE' || !record(v) || !legacyUuid(v.operationId) || typeof v.duplicate !== 'boolean' || v.requestKey !== intent.key
    || !record(v.request) || Object.keys(v.request).length !== 3 || v.request.templateObservationOperationId !== intent.body.templateObservationOperationId
    || v.request.expectedSourceBindingRevision !== intent.body.expectedSourceBindingRevision || v.request.expectedTargetBindingRevision !== intent.body.expectedTargetBindingRevision
    || intent.operationId !== null && v.operationId !== intent.operationId) return false;
  return v.state === 'NO_EFFECT' ? v.id === null && intent.planId === null : v.state === 'ADMITTED' && legacyUuid(v.id) && (intent.planId === null || intent.planId === v.id);
}
export function legacyActionResultMatches(intent: LegacyIntent, v: unknown): v is { id: string; operationId: string; pendingAction: Pending; duplicate: boolean } {
  return intent.action !== 'CREATE' && intent.action !== 'CANCEL' && record(v) && v.id === intent.planId && typeof v.duplicate === 'boolean'
    && legacyPendingMatches(intent, v.pendingAction) && v.operationId === v.pendingAction.operationId;
}
