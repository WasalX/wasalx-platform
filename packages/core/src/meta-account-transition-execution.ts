/** P09 server-only normalized authority. Public bodies never contain these facts. */
export type MetaMigrationStatus = 'INITIATED' | 'ACCEPTED' | 'IN_PROGRESS' | 'READY_TO_COMPLETE' | 'COMPLETED' | 'FAILED' | 'FAILED_TO_COMPLETE' | 'REJECTED';
export type MetaTransitionStage = 'INITIATE' | 'COMPLETE';
export type MetaTransitionFundingPath = 'RETAIN_CUSTOMER_CARD' | 'CARD_TO_APPROVED_LINE' | 'LINE_TO_APPROVED_LINE';
export type MetaTransitionEligibility = {
  graphVersionQualified: boolean;
  adminAuthorityCurrent: boolean;
  variant: 'STANDARD' | 'COEXISTENCE' | 'AUTHORIZED_AGENT' | 'UNKNOWN';
  sourceCurrency: string | null;
  targetCurrency: string;
  endpointCurrencyQualified: boolean;
  requestedMode: 'CUSTOMER' | 'WASALX_MANAGED';
  sourcePayment: 'CARD' | 'LINE' | 'UNKNOWN';
  /** Retaining a card while changing currency is not a card-to-card replacement. */
  replaceCustomerCard: boolean;
  managedAuthorityCurrent: boolean;
};
export type MetaTransitionHold =
  | 'PROVIDER_CONTRACT_UNQUALIFIED' | 'ADMIN_AUTHORITY_UNVERIFIED' | 'ACCOUNT_VARIANT_UNVERIFIED'
  | 'COEXISTENCE_UNSUPPORTED' | 'AUTHORIZED_AGENT_UNSUPPORTED' | 'CURRENCY_UNAVAILABLE'
  | 'SAME_CURRENCY_UNSUPPORTED' | 'PAYMENT_METHOD_UNVERIFIED' | 'PAYMENT_TRANSITION_UNSUPPORTED'
  | 'MANAGED_AUTHORITY_UNAVAILABLE' | 'RESERVATION_CHANGED' | 'SCOPE_CHANGED' | 'EXTERNAL_IMPACT_UNRESOLVED'
  | 'IN_FLIGHT_EFFECTS' | 'SOURCE_AUTHORITY_CHANGED' | 'RUNTIME_UNQUALIFIED' | 'CONFIRMATION_CHANGED'
  | 'STAGE_ALREADY_ATTEMPTED' | 'PROVIDER_OUTCOME_UNRESOLVED' | 'PROVIDER_NOT_READY'
  | 'TARGET_NOT_VERIFIED' | 'PAYMENT_ACTION_REQUIRED' | 'ASSET_CONTINUITY_UNVERIFIED';

/** Necessary local predicates only. SQL resolves these from retained provider,
 * operator and runtime evidence; a true caller flag is not proof or permission. */
export function metaTransitionFundingPath(facts: MetaTransitionEligibility):
  { path: MetaTransitionFundingPath | null; holds: MetaTransitionHold[] } {
  const holds: MetaTransitionHold[] = [];
  if (!facts.graphVersionQualified) holds.push('PROVIDER_CONTRACT_UNQUALIFIED');
  if (!facts.adminAuthorityCurrent) holds.push('ADMIN_AUTHORITY_UNVERIFIED');
  if (facts.variant === 'COEXISTENCE') holds.push('COEXISTENCE_UNSUPPORTED');
  else if (facts.variant === 'AUTHORIZED_AGENT') holds.push('AUTHORIZED_AGENT_UNSUPPORTED');
  else if (facts.variant !== 'STANDARD') holds.push('ACCOUNT_VARIANT_UNVERIFIED');
  if (!/^[A-Z]{3}$/u.test(facts.sourceCurrency ?? '') || !/^[A-Z]{3}$/u.test(facts.targetCurrency)
    || !facts.endpointCurrencyQualified) holds.push('CURRENCY_UNAVAILABLE');
  else if (facts.sourceCurrency === facts.targetCurrency) holds.push('SAME_CURRENCY_UNSUPPORTED');
  let path: MetaTransitionFundingPath | null = null;
  if (facts.sourcePayment === 'UNKNOWN') holds.push('PAYMENT_METHOD_UNVERIFIED');
  else if (facts.requestedMode === 'CUSTOMER') {
    if (facts.sourcePayment !== 'CARD' || facts.replaceCustomerCard) holds.push('PAYMENT_TRANSITION_UNSUPPORTED');
    else path = 'RETAIN_CUSTOMER_CARD';
  } else {
    if (!facts.managedAuthorityCurrent) holds.push('MANAGED_AUTHORITY_UNAVAILABLE');
    path = facts.sourcePayment === 'CARD' ? 'CARD_TO_APPROVED_LINE' : 'LINE_TO_APPROVED_LINE';
  }
  return { path: holds.length ? null : path, holds };
}

export type MetaTransitionStageFacts = {
  eligibility: MetaTransitionEligibility;
  reservationCurrent: boolean;
  scopeCurrent: boolean;
  externalImpactSettled: boolean;
  drainClear: boolean;
  sourceAuthorityCurrent: boolean;
  runtimeCurrent: boolean;
  confirmationCurrent: boolean;
  /** Original stable transition+stage checkpoint, never a successor job's slot. */
  existingStage: 'NONE' | 'ATTEMPTED' | 'UNKNOWN' | 'SUCCEEDED' | 'REJECTED';
  initiationSettlement: 'NONE' | 'EXACT_MIGRATION_ID_ACCEPTED' | 'UNRESOLVED';
  observedStatus: MetaMigrationStatus | null;
  targetVerified: boolean;
  targetPaymentReady: boolean;
  continuityVerified: boolean;
};
export function metaTransitionStageHolds(stage: MetaTransitionStage, facts: MetaTransitionStageFacts): MetaTransitionHold[] {
  const holds = metaTransitionFundingPath(facts.eligibility).holds;
  if (!facts.reservationCurrent) holds.push('RESERVATION_CHANGED');
  if (!facts.scopeCurrent) holds.push('SCOPE_CHANGED');
  if (!facts.externalImpactSettled) holds.push('EXTERNAL_IMPACT_UNRESOLVED');
  if (!facts.drainClear) holds.push('IN_FLIGHT_EFFECTS');
  if (!facts.sourceAuthorityCurrent) holds.push('SOURCE_AUTHORITY_CHANGED');
  if (!facts.runtimeCurrent) holds.push('RUNTIME_UNQUALIFIED');
  if (!facts.confirmationCurrent) holds.push('CONFIRMATION_CHANGED');
  if (facts.existingStage !== 'NONE') holds.push('STAGE_ALREADY_ATTEMPTED');
  if (stage === 'COMPLETE') {
    if (facts.initiationSettlement !== 'EXACT_MIGRATION_ID_ACCEPTED') holds.push('PROVIDER_OUTCOME_UNRESOLVED');
    if (facts.observedStatus !== 'READY_TO_COMPLETE') holds.push('PROVIDER_NOT_READY');
    if (!facts.targetVerified) holds.push('TARGET_NOT_VERIFIED');
    if (!facts.targetPaymentReady) holds.push('PAYMENT_ACTION_REQUIRED');
    if (!facts.continuityVerified) holds.push('ASSET_CONTINUITY_UNVERIFIED');
  }
  return holds;
}

export {parseMetaTransitionExecutionActionRequest as parseMetaTransitionExecutionAction} from './meta-account-transition-contract.js';
