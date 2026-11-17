import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  parseMetaTemplatePreparationRequest, parseMetaTemplatePreparationActionRequest,
  type MetaTemplatePreparationAction, type MetaTemplatePreparationPage, type MetaTemplatePreparationView,
  type MetaTemplatePreparationCreateResult, type MetaTemplatePreparationActionResult,
} from '@wasalx/core/meta-template-preparation-contract';
import { assertMetaTransitionWriter } from './meta-account-transition.js';
type Actor = { tenantId: string; connectionId: string; userId: string; appId: string; requestId: string };
type ObjectRow = Record<string, unknown>;
function record(v: unknown): ObjectRow { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectRow : {}; }
function parsed<T>(parser: (v: unknown) => T, body: unknown): T {
  try { return parser(body); } catch { throw new BadRequestException({ code: 'META_TEMPLATE_REQUEST_INVALID', message: 'Review the selected template preparation.' }); }
}
function date(v: Date | string | null): string | null { return v === null ? null : new Date(v).toISOString(); }
type Plan = { id: string; revision: string; state: string; template_state: MetaTemplatePreparationView['state'];
  initiating_connection_id: string; template_target_connection_id: string; source_name: string | null; target_name: string | null;
  template_observation: unknown; template_observation_sha256: string | null; observed_at: Date | null; expires_at: Date | null;
  operation_id: string; operation_state: string; payload: unknown; idempotency_key: string; requested_by_id: string;
  copy_outcome: NonNullable<MetaTemplatePreparationView['originalCopy']>['outcome'] | null; copy_partial: boolean; attempted_at: Date | null };

export async function requestMetaTemplatePreparation(client: PoolClient, actor: Actor, key: string, body: unknown, resolve: boolean) {
  await assertMetaTransitionWriter(client, actor);
  const request = parsed(parseMetaTemplatePreparationRequest, body);
  return (await client.query<{ value: MetaTemplatePreparationCreateResult }>(
    'SELECT app.request_meta_template_preparation($1,$2,$3,$4,$5,$6,$7) AS value',
    [actor.connectionId, actor.userId, actor.appId, key, request, actor.requestId, resolve])).rows[0]!.value;
}
export async function requestMetaTemplateAction(client: PoolClient, actor: Actor, planId: string, key: string,
  action: MetaTemplatePreparationAction, body: unknown, resolve: boolean) {
  await assertMetaTransitionWriter(client, actor);
  const request = parsed(v => parseMetaTemplatePreparationActionRequest(v, action), body);
  return (await client.query<{ value: MetaTemplatePreparationActionResult }>(
    'SELECT app.request_meta_template_action($1,$2,$3,$4,$5,$6,$7,$8,$9) AS value',
    [planId, actor.connectionId, actor.userId, actor.appId, key, action, request, actor.requestId, resolve])).rows[0]!.value;
}
export async function cancelMetaTemplatePreparation(client: PoolClient, actor: Actor, planId: string, body: unknown) {
  await assertMetaTransitionWriter(client, actor);
  const input = record(body);
  if (Object.keys(input).length !== 1 || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)
    throw new BadRequestException('Review the current preparation.');
  return (await client.query<{ value: { id: string; duplicate: boolean } }>(
    'SELECT app.cancel_meta_template_preparation($1,$2,$3,$4) AS value', [planId, actor.connectionId, actor.userId, input.expectedRevision])).rows[0]!.value;
}

export async function readMetaTemplatePreparation(client: PoolClient, actor: Actor, planId?: string): Promise<MetaTemplatePreparationView | null> {
  const plan = (await client.query<Plan>(`SELECT p.*,source.name AS source_name,target.name AS target_name,
    o.id AS operation_id,o.state AS operation_state,o.payload,o.idempotency_key,o.requested_by_id,
    c.outcome AS copy_outcome,c.attempted_at,
    COALESCE(c.outcome='SUCCEEDED' AND jsonb_array_length(c.result->'failedSourceTemplateIds')>0,false) AS copy_partial FROM meta_account_transitions p
    JOIN connections source ON source.tenant_id=p.tenant_id AND source.id=p.initiating_connection_id
    JOIN connections target ON target.tenant_id=p.tenant_id AND target.id=p.template_target_connection_id
    JOIN connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.template_operation_id
    LEFT JOIN meta_provider_effect_checkpoints c ON c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.owner_id=p.id AND c.stage='TEMPLATE_COPY'
    WHERE p.tenant_id=$1 AND p.initiating_connection_id=$2 AND p.transition_kind='TEMPLATE_PREPARATION'
      AND ($3::uuid IS NULL OR p.id=$3) ORDER BY p.created_at DESC LIMIT 1`, [actor.tenantId, actor.connectionId, planId ?? null])).rows[0];
  if (!plan) { if (planId) throw new NotFoundException('Template preparation not found.'); return null; }
  const status = (await client.query<{ value: { permitted: boolean; current: boolean; safetyCurrent: boolean; scopeCurrent: boolean } }>(
    'SELECT app.meta_template_preparation_status($1,$2,$3) AS value', [plan.id, actor.userId, actor.appId])).rows[0]!.value;
  const observation = record(plan.template_observation), source = record(observation.source), target = record(observation.target);
  const busy = ['QUEUED', 'RUNNING', 'FAILED_RETRYABLE', 'STAGED'].includes(plan.operation_state);
  const unknown = plan.copy_outcome === 'ATTEMPTED' || plan.copy_outcome === 'UNKNOWN';
  const fresh = plan.expires_at !== null && new Date(plan.expires_at).getTime() > Date.now();
  const rawChoices = Array.isArray(observation.choices) ? observation.choices : [];
  const choices: MetaTemplatePreparationView['choices'] = rawChoices.map(record).filter(c => typeof c.id === 'string'
    && typeof c.name === 'string' && typeof c.language === 'string'
    && ['EQUIVALENT', 'MISSING', 'DIFFERENT', 'UNSUPPORTED', 'UNAVAILABLE'].includes(String(c.compatibility)))
    .map(c => ({ id: c.id as string, name: c.name as string, language: c.language as string,
      compatibility: c.compatibility as MetaTemplatePreparationView['choices'][number]['compatibility'],
      selectable: c.selectable === true && c.compatibility === 'MISSING' && !plan.copy_outcome && status.current && status.safetyCurrent && status.scopeCurrent && fresh && !busy }));
  const reasons: MetaTemplatePreparationView['reasons'] = [];
  if (!status.permitted) reasons.push('CURRENT_PERMISSION_REQUIRED');
  if (!status.current || (plan.template_observation !== null && !status.scopeCurrent)) reasons.push('BINDING_CHANGED');
  if (!status.safetyCurrent && plan.template_observation !== null) reasons.push('SIGNED_TEMPLATE_CHANGE');
  if (source.complete !== true || target.complete !== true) reasons.push('INVENTORY_INCOMPLETE');
  if (unknown) reasons.push('COPY_OUTCOME_UNRESOLVED');
  if (Number(observation.metaFlowDependencyCount) > 0 || choices.some(c => c.compatibility === 'UNSUPPORTED')) reasons.push('UNSUPPORTED_TEMPLATE');
  if (plan.copy_partial) reasons.push('COPY_PARTIAL');
  if (plan.operation_state === 'FAILED_TERMINAL' && !unknown) reasons.push('PROVIDER_READ_UNAVAILABLE');
  let state = plan.state === 'CANCELLED' ? 'CANCELLED' as const : plan.template_state;
  if (state !== 'CANCELLED' && unknown) state = 'OUTCOME_UNKNOWN';
  else if (state !== 'CANCELLED' && !busy && (!status.current || !status.safetyCurrent || !status.scopeCurrent || !fresh)) state = 'HELD';
  const active = state !== 'CANCELLED' && status.permitted && status.current && !busy;
  const intent = record(record(plan.payload).metaTemplatePreparation);
  const pendingAction: MetaTemplatePreparationView['pendingAction'] = plan.requested_by_id === actor.userId
    && ['OBSERVE', 'COPY', 'RECONCILE'].includes(String(intent.stage))
    ? { operationId: plan.operation_id, requestKey: plan.idempotency_key, action: intent.stage as MetaTemplatePreparationAction,
      requestRevision: Number(intent.requestRevision), state: (plan.operation_state === 'FAILED_RETRYABLE' ? 'FAILED_TERMINAL' : plan.operation_state) as NonNullable<MetaTemplatePreparationView['pendingAction']>['state'] } : null;
  return { id: plan.id, revision: Number(plan.revision), sourceConnection: { id: plan.initiating_connection_id, name: plan.source_name },
    targetConnection: { id: plan.template_target_connection_id, name: plan.target_name }, state,
    observationSha256: plan.template_observation_sha256, observedAt: date(plan.observed_at), expiresAt: date(plan.expires_at), choices, reasons,
    actions: { observe: active, reconcile: active && !!plan.copy_outcome,
      copy: active && fresh && status.safetyCurrent && status.scopeCurrent && !plan.copy_outcome && choices.some(c => c.selectable),
      cancel: state !== 'CANCELLED' && status.permitted && !unknown },
    originalCopy: plan.copy_outcome && plan.attempted_at ? { outcome: plan.copy_outcome, attemptedAt: date(plan.attempted_at)! } : null,
    pendingAction, canCutOver: false };
}
export async function readMetaTemplatePreparationPage(client: PoolClient, actor: Actor): Promise<MetaTemplatePreparationPage> {
  const connection = (await client.query<{ provider: string }>('SELECT provider FROM connections WHERE tenant_id=$1 AND id=$2', [actor.tenantId, actor.connectionId])).rows[0];
  if (!connection || connection.provider !== 'META') throw new NotFoundException('Meta connection not found.');
  const prepare = (await client.query<{ value: MetaTemplatePreparationPage['prepare'] }>(
    'SELECT app.meta_template_preparation_targets($1,$2,$3) AS value', [actor.connectionId, actor.userId, actor.appId])).rows[0]?.value ?? null;
  return { prepare, currentPlan: await readMetaTemplatePreparation(client, actor) };
}
