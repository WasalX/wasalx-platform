import {
  parseMetaTemplatePreparationActionRequest,
  parseMetaTemplatePreparationRequest,
  type MetaTemplatePreparationAction,
  type MetaTemplatePreparationActionRequest,
  type MetaTemplatePreparationCreateResult,
  type MetaTemplatePreparationPage,
  type MetaTemplatePreparationRequest,
  type MetaTemplatePreparationView,
} from '../packages/core/src/meta-template-preparation-contract.ts';

export const templateUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const revision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const digest = (v: unknown) => v === null || typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const timestamp = (v: unknown) => v === null || typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const connection = (v: unknown) => record(v) && templateUuid(v.id) && (v.name === null || typeof v.name === 'string' && v.name.length <= 1000);
const actions: MetaTemplatePreparationAction[] = ['OBSERVE', 'COPY', 'RECONCILE'];
const terminal = (state: string) => ['SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].includes(state);
type Pending = NonNullable<MetaTemplatePreparationView['pendingAction']>;
function pending(v: unknown): v is Pending {
  return record(v) && templateUuid(v.operationId) && templateUuid(v.requestKey) && revision(v.requestRevision)
    && actions.some(action => action === v.action) && ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_TERMINAL', 'CANCELLED'].some(state => state === v.state);
}

/** Reject a malformed mutation-bearing projection; never infer an action from state. */
export function isTemplateView(v: unknown, sourceId: string, planId?: string): v is MetaTemplatePreparationView {
  if (!record(v) || !templateUuid(v.id) || planId !== undefined && v.id !== planId || !revision(v.revision)
    || !connection(v.sourceConnection) || !record(v.sourceConnection) || v.sourceConnection.id !== sourceId || !connection(v.targetConnection)
    || !['PENDING', 'REVIEW', 'COPYING', 'PARTIAL', 'OUTCOME_UNKNOWN', 'READY', 'HELD', 'CANCELLED'].some(state => state === v.state)
    || !digest(v.observationSha256) || !timestamp(v.observedAt) || !timestamp(v.expiresAt) || v.canCutOver !== false
    || !record(v.actions) || !['observe', 'copy', 'reconcile', 'cancel'].every(key => typeof (v.actions as Record<string, unknown>)[key] === 'boolean')
    || !Array.isArray(v.reasons) || v.reasons.length > 32 || !v.reasons.every(reason => typeof reason === 'string' && /^[A-Z_]{1,80}$/u.test(reason))
    || !Array.isArray(v.choices) || v.choices.length > 5000 || !v.choices.every(choice => record(choice) && templateUuid(choice.id)
      && typeof choice.name === 'string' && choice.name.length <= 1000 && typeof choice.language === 'string' && choice.language.length <= 100
      && typeof choice.selectable === 'boolean' && (!choice.selectable || choice.compatibility === 'MISSING') && ['EQUIVALENT', 'MISSING', 'DIFFERENT', 'UNSUPPORTED', 'UNAVAILABLE'].includes(String(choice.compatibility)))
    || new Set(v.choices.map(choice => choice.id.toLowerCase())).size !== v.choices.length
    || !(v.pendingAction === null || pending(v.pendingAction))) return false;
  const original = v.originalCopy;
  return original === null || record(original)
    && ['ATTEMPTED', 'SUCCEEDED', 'REJECTED', 'UNKNOWN'].some(state => state === original.outcome)
    && original.attemptedAt !== null && timestamp(original.attemptedAt);
}
export function isTemplatePage(v: unknown, sourceId: string): v is MetaTemplatePreparationPage {
  if (!record(v) || !(v.currentPlan === null || isTemplateView(v.currentPlan, sourceId))) return false;
  if (v.prepare === null) return true;
  return record(v.prepare) && revision(v.prepare.accountRevision) && revision(v.prepare.bindingRevision)
    && Array.isArray(v.prepare.targets) && v.prepare.targets.length <= 5000 && v.prepare.targets.every(connection);
}

/** Non-secret tab-local original intent. It grants no permission and never permits replay. */
export type TemplateIntent = { version: 1; key: string; operationId: string | null } & (
  { action: 'CREATE'; planId: string | null; body: MetaTemplatePreparationRequest }
  | { action: MetaTemplatePreparationAction; planId: string; body: MetaTemplatePreparationActionRequest }
  | { action: 'CANCEL'; planId: string; body: { expectedRevision: number } }
);
export function templateIntentKey(tenantId: string, actorId: string, sourceId: string) {
  return `wasalx:meta-template:v1:${encodeURIComponent(tenantId)}:${encodeURIComponent(actorId)}:${sourceId}`;
}
export function parseTemplateIntent(raw: string | null): TemplateIntent | null {
  if (raw === null) return null;
  if (raw.length > 32768) throw new Error('META_TEMPLATE_INTENT_UNAVAILABLE');
  let v: unknown; try { v = JSON.parse(raw); } catch { throw new Error('META_TEMPLATE_INTENT_UNAVAILABLE'); }
  if (!record(v) || Object.keys(v).length !== 6 || v.version !== 1 || !templateUuid(v.key)
    || !(v.operationId === null || templateUuid(v.operationId)) || !(v.planId === null || templateUuid(v.planId))) throw new Error('META_TEMPLATE_INTENT_UNAVAILABLE');
  if (v.action === 'CREATE') return { version: 1, action: v.action, key: v.key, operationId: v.operationId, planId: v.planId, body: parseMetaTemplatePreparationRequest(v.body) };
  if (!templateUuid(v.planId)) throw new Error('META_TEMPLATE_INTENT_UNAVAILABLE');
  if (v.action === 'CANCEL' && record(v.body) && Object.keys(v.body).length === 1 && revision(v.body.expectedRevision)) {
    return { version: 1, action: v.action, key: v.key, operationId: v.operationId, planId: v.planId, body: { expectedRevision: v.body.expectedRevision } };
  }
  const action = actions.find(action => action === v.action);
  if (!action) throw new Error('META_TEMPLATE_INTENT_UNAVAILABLE');
  return { version: 1, action, key: v.key, operationId: v.operationId, planId: v.planId, body: parseMetaTemplatePreparationActionRequest(v.body, action) };
}
export function templatePendingMatches(intent: TemplateIntent, value: unknown): value is Pending {
  if (intent.action === 'CANCEL') return false;
  return pending(value) && value.requestKey === intent.key && value.action === (intent.action === 'CREATE' ? 'OBSERVE' : intent.action)
    && value.requestRevision === (intent.action === 'CREATE' ? 1 : intent.body.expectedRevision)
    && (intent.operationId === null || value.operationId === intent.operationId);
}
export function templateIntentSettled(intent: TemplateIntent, value: unknown, sourceId: string): boolean {
  if (!intent.planId || !isTemplateView(value, sourceId, intent.planId)) return false;
  if (intent.action === 'CANCEL') return value.state === 'CANCELLED' && value.revision === intent.body.expectedRevision + 1;
  if (intent.action === 'CREATE' && value.targetConnection.id !== intent.body.targetConnectionId.toLowerCase()) return false;
  return templatePendingMatches(intent, value.pendingAction) && terminal(value.pendingAction.state);
}
/** Only local cancellation uses monotonic CAS impossibility; never a provider action. */
export function templateCancelSuperseded(intent: TemplateIntent, value: unknown, sourceId: string): boolean {
  return intent.action === 'CANCEL' && isTemplateView(value, sourceId, intent.planId)
    && value.state !== 'CANCELLED' && value.revision > intent.body.expectedRevision;
}
export function templateCreateResultMatches(intent: TemplateIntent, v: unknown): v is MetaTemplatePreparationCreateResult {
  if (intent.action !== 'CREATE' || !record(v) || !templateUuid(v.operationId) || typeof v.duplicate !== 'boolean'
    || v.requestKey !== intent.key || !record(v.request) || Object.keys(v.request).length !== 3
    || v.request.targetConnectionId !== intent.body.targetConnectionId || v.request.expectedAccountRevision !== intent.body.expectedAccountRevision
    || v.request.expectedBindingRevision !== intent.body.expectedBindingRevision || intent.operationId !== null && v.operationId !== intent.operationId) return false;
  if (v.state === 'NO_EFFECT') return v.id === null && v.pendingAction === null && intent.planId === null;
  return v.state === 'ADMITTED' && templateUuid(v.id) && (intent.planId === null || intent.planId === v.id)
    && templatePendingMatches(intent, v.pendingAction) && v.pendingAction.operationId === v.operationId;
}
export function templateActionResultMatches(intent: TemplateIntent, v: unknown): v is { id: string; operationId: string; pendingAction: Pending; duplicate: boolean } {
  return intent.action !== 'CREATE' && intent.action !== 'CANCEL' && record(v) && v.id === intent.planId && typeof v.duplicate === 'boolean'
    && templatePendingMatches(intent, v.pendingAction) && v.operationId === v.pendingAction.operationId;
}
