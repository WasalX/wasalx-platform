import type { MetaMigrationStatus } from '../../core/src/meta-account-transition-execution.js';
import { ProviderError } from './types.js';

export type MetaMigrationDestination = { id: string; currency: string };
export type MetaMigrationObservation = { migrationId: string; status: MetaMigrationStatus; destination: MetaMigrationDestination | null };
export type MetaTransitionRequest = (path: string, init: { method: 'GET' | 'POST'; body?: unknown },
  semantics: 'read' | 'mutation', financialMutation: boolean) => Promise<unknown>;
const statuses = new Set<MetaMigrationStatus>(['INITIATED','ACCEPTED','IN_PROGRESS','READY_TO_COMPLETE','COMPLETED','FAILED','FAILED_TO_COMPLETE','REJECTED']);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function numeric(value: unknown): value is string { return typeof value === 'string' && /^[0-9]{1,32}$/u.test(value); }
export function metaMigrationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}
const invalid = (known: boolean) => new ProviderError('Account transition evidence is unavailable.', false,
  'META_TRANSITION_INVALID_RESPONSE', undefined, known);
const input = () => new ProviderError('Account transition request is not admitted.', false,
  'META_TRANSITION_NOT_ATTEMPTED', undefined, true);

/** A bounded provider-returned ID from a malformed mutation can support GET-only
 * recovery. It never settles that mutation and is never accepted from the UI. */
export function metaMigrationRecoveryId(value: unknown, stage:'INITIATE'|'COMPLETE',expected?: string): string | null {
  const v = object(value), id = stage==='INITIATE'?v?.migration_id:v?.id;
  if(v?.migration_id!==undefined&&v.id!==undefined&&v.migration_id!==v.id)return null;
  return metaMigrationId(id) && (expected === undefined || id === expected) ? id : null;
}
export function parseMetaMigrationObservation(value: unknown, expectedMigrationId: string,
  targetCurrency: string, expectedDestinationId?: string): MetaMigrationObservation {
  const v = object(value);
  if (!metaMigrationId(expectedMigrationId) || v?.id !== expectedMigrationId || typeof v.status !== 'string'
    || !statuses.has(v.status as MetaMigrationStatus)) throw invalid(true);
  let destination: MetaMigrationDestination | null = null;
  if (v.destination_waba !== undefined && v.destination_waba !== null) {
    const target = object(v.destination_waba);
    if (!numeric(target?.id) || target.currency !== targetCurrency
      || (expectedDestinationId !== undefined && target.id !== expectedDestinationId)) throw invalid(true);
    destination = { id: target.id, currency: targetCurrency };
  }
  if (['READY_TO_COMPLETE','COMPLETED'].includes(v.status) && !destination) throw invalid(true);
  return { migrationId: expectedMigrationId, status: v.status as MetaMigrationStatus, destination };
}

/** Existing fixed-origin MetaGroupsAdapter supplies request; it must use the
 * incumbent durable beforeFinancialMutation callback immediately before POST. */
export class MetaAccountTransitionCalls {
  constructor(private readonly request: MetaTransitionRequest) {}
  async initiate(sourceAccountId: string, currency: string, approvedCreditLineId?: string): Promise<unknown> {
    if (!numeric(sourceAccountId) || !/^[A-Z]{3}$/u.test(currency)
      || (approvedCreditLineId !== undefined && !numeric(approvedCreditLineId))) throw input();
    // Deliberately preserve the bounded response for the worker's checkpoint
    // parser. A malformed accepted response must not lose a recoverable ID.
    return this.request(`/${sourceAccountId}/set_payment_method_migration_intent`, { method: 'POST',
      body: { currency, ...(approvedCreditLineId === undefined ? {} : { extended_credit_id: approvedCreditLineId }) } }, 'mutation', true);
  }
  async observe(migrationId: string): Promise<unknown> {
    if (!metaMigrationId(migrationId)) throw input();
    return this.request(`/${encodeURIComponent(migrationId)}`, { method: 'GET' }, 'read', false);
  }
  async complete(migrationId: string): Promise<unknown> {
    if (!metaMigrationId(migrationId)) throw input();
    // Documentation establishes no completion-body credit or currency field.
    return this.request(`/${encodeURIComponent(migrationId)}/resume_migration`, { method: 'POST' }, 'mutation', true);
  }
}
export function parseMetaMigrationInitiation(value: unknown): { migrationId: string; status: MetaMigrationStatus } {
  const v = object(value);
  if (!metaMigrationId(v?.migration_id) || typeof v.migration_status !== 'string'
    || !statuses.has(v.migration_status as MetaMigrationStatus)) throw invalid(false);
  return { migrationId: v.migration_id, status: v.migration_status as MetaMigrationStatus };
}
