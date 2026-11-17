/** Public DTOs only. Importing these does not grant routing or provider authority. */
export const META_ROUTING_ROLES = ["ai_agent", "ctwa", "customer_service", "escalation", "marketing", "utility"] as const;
export type MetaRoutingRole = typeof META_ROUTING_ROLES[number];
export type MetaRoutingAction = "take" | "pass" | "release";
export type MetaThreadControlCommand = {action: MetaRoutingAction; targetRole?: MetaRoutingRole;
  expectedRoutingEpoch: number; expectedConfigurationVersion: number; expectedReviewVersion: number};
export type MetaRoutingReviewBody = { expectedSessionId: string; expectedConfigurationVersion: number; expectedReviewVersion: number;
  disposition: "REVIEWED" | "REVOKED"; observedAt: string; evidenceSha256: string; evidenceReference: string;
  scope: "PHONE_OVERRIDE" | "ACCOUNT_DEFAULT"; roles: MetaRoutingRole[]; targets: MetaRoutingRole[]; fields: string[];
  termsAccepted: boolean; threadControlEnabled: boolean; personallyObserved: true };
export type MetaRoutingOperatorDto = {
  connectionId: string; sessionId: string; phoneNumberId: string; accountId: string | null;
  declaration: {version: number; declaredAt: string; fallback: "HOLD"} | null;
  review: {id: string; version: number; disposition: "REVIEWED" | "REVOKED"; observedAt: string; configurationVersion: number;
    runtime: {mode: "LIVE" | "SIMULATED"; graphOrigin: string; graphVersion: string; simulationBindingSha256?: string};
    observation: Omit<MetaRoutingReviewBody,"expectedSessionId"|"expectedConfigurationVersion"|"expectedReviewVersion"> } | null;
};
export type MetaRoutingReviewResult = {id: string; version: number; disposition: "REVIEWED" | "REVOKED"; duplicate: boolean};
export type MetaRoutingConfigurationDto = {
  sessionId: string; configurationVersion: number; reviewVersion: number;
  readiness: "OBSERVED_AWAITING_THREAD" | "LEGACY_COMPATIBILITY" | "PRIMARY_DELIVERY" | "REVIEW_REQUIRED";
  declared: { fallback: "HOLD" } | null;
  observed: { current: boolean; disposition: "REVIEWED" | "REVOKED"; observedAt: string;
    mode: "LIVE" | "SIMULATED"; scope: "PHONE_OVERRIDE" | "ACCOUNT_DEFAULT";
    roles: MetaRoutingRole[]; targets: MetaRoutingRole[]; threadControlEnabled: boolean } | null;
  providerConfigurationReadback: false; accountFundingProof: "SEPARATE_REQUIRED";
};
export type MetaThreadActionDto = {
  id: string; action: MetaRoutingAction; targetRole: MetaRoutingRole | null;
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  requestId: string | null; reason: string | null; retryable: false;
};
export type MetaThreadRoutingDto = {
  connectionId: string;
  ownership: { allowed: boolean; epoch: number | null;
    claim: "OWN" | "STANDBY" | "IDLE" | "UNKNOWN" | "HELD" | "LEGACY_COMPATIBILITY" | "PRIMARY_DELIVERY";
    reason: string | null; configurationVersion: number; reviewVersion: number };
  actions: MetaThreadActionDto[]; internalOwnershipUnchanged: true;
  correlation: null | {state: "ABSENT"} | {state: "MATCHED"; action: MetaThreadActionDto; command: MetaThreadControlCommand};
  availability: {actions: MetaRoutingAction[]; passTargets: MetaRoutingRole[]; untargetedPass: boolean;
    admission: "ROUTING_SNAPSHOT_ONLY"; currentnessRecheckedAtExecution: true};
  reconciliation: "ORIGINAL_PROVIDER_EVIDENCE_REQUIRED";
};
