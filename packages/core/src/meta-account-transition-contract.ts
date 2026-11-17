/** Public preview contract. This module has no Node, provider or secret dependency. */
export type MetaTransitionRequestedMode = "CUSTOMER" | "WASALX_MANAGED";
export type MetaTransitionPreviewRequest = {
  requestedMode: MetaTransitionRequestedMode;
  targetCurrency: string;
  expectedAccountRevision: number;
  expectedBindingRevision: number;
};
export type MetaTransitionPreviewAction = { expectedRevision: number };
/** Revisions are local optimistic-concurrency hints, never provider authority. */
export type MetaTransitionPreviewPage = {
  prepare: { accountRevision: number; bindingRevision: number } | null;
  currentPlan: MetaTransitionPreviewView | null;
};
export type MetaTransitionPreviewState = "PENDING" | "PREVIEW" | "BLOCKED" | "EXPIRED" | "CANCELLED";
export type MetaTransitionPreviewReason =
  | "CURRENCY_UNKNOWN" | "SAME_CURRENCY_TRANSITION_UNSUPPORTED"
  | "ACCOUNT_VARIANT_UNVERIFIED"
  | "COEXISTENCE_UNSUPPORTED" | "AUTHORIZED_AGENT_UNSUPPORTED"
  | "ADMIN_AUTHORITY_UNVERIFIED" | "PROVIDER_VERSION_UNQUALIFIED"
  | "PHONE_SCOPE_INCOMPLETE" | "EXTERNAL_PHONE_IMPACT"
  | "LOCAL_SCOPE_CHANGED" | "TEMPLATE_INVENTORY_INCOMPLETE"
  | "MANAGED_ARRANGEMENT_UNAVAILABLE" | "MANAGED_ARRANGEMENT_STALE"
  | "PROVIDER_READ_UNAVAILABLE" | "CURRENT_BINDING_CHANGED";
export type MetaTransitionPreviewView = {
  id: string;
  revision: number;
  state: MetaTransitionPreviewState;
  requestedMode: MetaTransitionRequestedMode;
  targetCurrency: string;
  current: {
    declaredMode: MetaTransitionRequestedMode | "UNSELECTED";
    actualPayer: "UNVERIFIED";
    currency: string | null;
  };
  impact: {
    connections: ReadonlyArray<{ id: string; name: string | null }>;
    phoneInventory: "COMPLETE" | "INCOMPLETE" | "UNAVAILABLE";
    externalPhoneCount: number | null;
    sourceTemplateCount: number | null;
    affectedFlowVersionCount: number | null;
    templateCompatibility: "NOT_ASSESSED";
  };
  reasons: ReadonlyArray<MetaTransitionPreviewReason>;
  observedAt: string | null;
  expiresAt: string | null;
  canRefresh: boolean;
  canCancel: boolean;
  /** Preview never gives permission to initiate, complete, attach, revoke or activate. */
  canExecute: false;
  execution?: MetaTransitionExecutionView;
};

export type MetaTransitionExecutionAction = 'INITIATE'|'COMPLETE'|'OBSERVE'|'RECONCILE';
export type MetaTransitionExecutionActionRequest = { expectedRevision:number;expectedPreviewSha256:string };
export type MetaTransitionExecutionReason = 'PREREQUISITES_UNVERIFIED'|'AUTHORIZATION_EXPIRED'|'SCOPE_CHANGED'|'IN_FLIGHT_EFFECTS'
 |'PROVIDER_OUTCOME_UNRESOLVED'|'TARGET_PROOF_REQUIRED'|'PAYMENT_ACTION_REQUIRED'|'TEMPLATE_ACTION_REQUIRED'|'IDENTITY_ACTION_REQUIRED'
 |'RUNTIME_UNQUALIFIED'|'PRIVACY_HOLD'|'CURRENT_PERMISSION_REQUIRED'|'STAGE_ALREADY_ATTEMPTED';
export type MetaTransitionExecutionView = {
 revision:number;state:'UNPREPARED'|'RESERVED'|'INITIATED'|'READY_TO_COMPLETE'|'PROVIDER_COMPLETED'|'RECONCILED_PAUSED'|'HELD';
 previewSha256:string|null;requestedMode:MetaTransitionRequestedMode;sourceCurrency:string|null;targetCurrency:string;impactConnectionCount:number;
 actions:{initiate:boolean;complete:boolean;observe:boolean;reconcile:boolean;cancel:boolean};reasons:MetaTransitionExecutionReason[];
 providerStatus:'INITIATED'|'ACCEPTED'|'IN_PROGRESS'|'READY_TO_COMPLETE'|'COMPLETED'|'FAILED'|'FAILED_TO_COMPLETE'|'REJECTED'|null;
 history:Array<{stage:'INITIATE'|'COMPLETE';outcome:'ATTEMPTED'|'SUCCEEDED'|'REJECTED'|'UNKNOWN';attemptedAt:string}>;
 observedAt:string|null;
 /** Local source connections only. Preparing a one-use renewal grants readback, not completion or sending. */
 renewals:Array<{connectionId:string;name:string;canPrepare:boolean;access:'ORIGINAL'|'RENEWED'}>;
 completionApprovalRequired:boolean;
 /** Restricted target terms; source-account agreement is never copied. */
 terms:null|{documentText:string;documentSha256:string;version:string};
 pendingAction:{operationId:string;requestKey:string;action:MetaTransitionExecutionAction;state:'QUEUED'|'RUNNING'|'SUCCEEDED'|'FAILED_TERMINAL'|'CANCELLED';requestRevision:number}|null;
};

export type MetaTransitionExecutionActionResult={id:string;operationId:string;duplicate:boolean};
export type MetaTransitionExecutionResolutionResult=MetaTransitionExecutionActionResult & {
 pendingAction:NonNullable<MetaTransitionExecutionView['pendingAction']>;
};

export function parseMetaTransitionExecutionActionRequest(value:unknown):MetaTransitionExecutionActionRequest {
 const v=object(value);
 if(Object.keys(v).length!==2||!positiveRevision(v.expectedRevision)||typeof v.expectedPreviewSha256!=='string'
  ||!/^[a-f0-9]{64}$/u.test(v.expectedPreviewSha256))throw new Error('META_TRANSITION_REQUEST_INVALID');
 return{expectedRevision:v.expectedRevision,expectedPreviewSha256:v.expectedPreviewSha256};
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("META_TRANSITION_REQUEST_INVALID");
  return value as Record<string, unknown>;
}
function positiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** Syntactic ISO-style code only; this does not claim Meta supports that currency. */
export function isMetaTransitionCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/u.test(value);
}
export function parseMetaTransitionPreviewRequest(value: unknown): MetaTransitionPreviewRequest {
  const v = object(value);
  if (Object.keys(v).length !== 4 || Object.keys(v).some(key => ![
    "requestedMode", "targetCurrency", "expectedAccountRevision", "expectedBindingRevision",
  ].includes(key)) || !["CUSTOMER", "WASALX_MANAGED"].includes(v.requestedMode as string)
    || !isMetaTransitionCurrency(v.targetCurrency)
    || !positiveRevision(v.expectedAccountRevision) || !positiveRevision(v.expectedBindingRevision))
    throw new Error("META_TRANSITION_REQUEST_INVALID");
  return { requestedMode: v.requestedMode as MetaTransitionRequestedMode, targetCurrency: v.targetCurrency,
    expectedAccountRevision: v.expectedAccountRevision, expectedBindingRevision: v.expectedBindingRevision };
}
export function parseMetaTransitionPreviewAction(value: unknown): MetaTransitionPreviewAction {
  const v = object(value);
  if (Object.keys(v).length !== 1 || !positiveRevision(v.expectedRevision))
    throw new Error("META_TRANSITION_REQUEST_INVALID");
  return { expectedRevision: v.expectedRevision };
}
