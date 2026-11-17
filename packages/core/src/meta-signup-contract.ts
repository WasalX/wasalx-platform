/** Customer-paid signup HTTP contract. No provider identifiers or credentials in views. */
import type { MetaCoexistenceConsent } from "./meta-coexistence-contract.js";
export type MetaSignupVariant = "STANDARD" | "BUSINESS_APP";
export type MetaSignupSdk = { appId: string; configId: string; graphVersion: string; variant?: MetaSignupVariant;
  extras?: { featureType: "whatsapp_business_app_onboarding"; sessionInfoVersion: "3"; setup: Record<string, never> } };
export type MetaSignupStatus =
  | "AWAITING_AUTHORIZATION" | "EXCHANGING" | "OUTCOME_UNKNOWN"
  | "SELECTION_REQUIRED" | "NUMBER_REQUIRED" | "ACTION_REQUIRED"
  | "PROVISIONING" | "COMPLETED" | "FAILED" | "CANCELLED" | "EXPIRED";
export type MetaSignupNextAction =
  | "AUTHORIZE" | "SELECT_NUMBER" | "COMPLETE_META_SETUP" | "REVIEW_EXISTING_NUMBER"
  | "REVIEW_COEXISTENCE" | "WAIT" | "REVIEW_OUTCOME" | "START_AGAIN" | "DONE";
export type MetaSignupReason =
  | "META_SIGNUP_NOT_CONFIGURED" | "META_SIGNUP_EXPIRED" | "META_SIGNUP_CONSUMED"
  | "META_SIGNUP_STATE_INVALID" | "META_SIGNUP_REVISION_CONFLICT" | "META_SIGNUP_EXCHANGE_REJECTED"
  | "META_SIGNUP_EXCHANGE_UNKNOWN" | "META_SIGNUP_CREDENTIAL_UNAVAILABLE"
  | "META_SIGNUP_PERMISSION_REQUIRED" | "META_SIGNUP_DISCOVERY_UNAVAILABLE"
  | "META_SIGNUP_NO_PHONE" | "META_SIGNUP_OWNER_UNVERIFIED" | "META_SIGNUP_PHONE_UNVERIFIED"
  | "META_SIGNUP_MODE_UNKNOWN" | "META_SIGNUP_COEXISTENCE_REQUIRED" | "META_SIGNUP_EXISTING_NUMBER_REVIEW"
  | "META_SIGNUP_ASSET_CONFLICT" | "META_SIGNUP_REGISTRATION_REJECTED"
  | "META_SIGNUP_REGISTRATION_UNKNOWN" | "META_SIGNUP_PROVIDER_UNAVAILABLE"
  | "META_SIGNUP_PAYMENT_ACTION_REQUIRED" | "META_SIGNUP_CANCELLED"
  | "META_SIGNUP_RECONNECT_TARGET_CHANGED" | "META_SIGNUP_RECONNECT_PAUSE_REQUIRED"
  | "META_SIGNUP_ADD_ACCESS_ACTIVATION_REQUIRED" | "META_SIGNUP_ADD_ACCESS_STAGE_CHANGED";

export type MetaSignupCapabilities = {
  enabled: boolean;
  unavailableReason?: "META_SIGNUP_NOT_CONFIGURED";
  payerModes: readonly ["CUSTOMER"];
  sdk?: MetaSignupSdk;
  businessAppEnabled?: boolean;
};
export type MetaSignupChoice = {
  choiceId: string; // Attempt-scoped opaque choice, never a caller-supplied Graph ID.
  businessName: string;
  accountName: string;
  displayPhoneNumber: string;
  verifiedName?: string;
  mode: "STANDARD" | "COEXISTENCE" | "UNKNOWN";
  numberState: "REGISTRATION_REQUIRED" | "REGISTERED" | "ACTION_REQUIRED" | "UNKNOWN";
  selectable: boolean;
  reasonCode?: MetaSignupReason;
  existingConnection?: { connectionId: string; name: string }; // Same-tenant exact phone/account only; never foreign/revoked history.
};
export type MetaSignupReadiness = {
  authorization: "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
  number: "PENDING" | "REGISTRATION_REQUIRED" | "REGISTERED" | "UNKNOWN";
  subscription: "PENDING" | "CONFIRMED" | "UNKNOWN";
  messaging: "AVAILABLE" | "LIMITED" | "BLOCKED" | "UNKNOWN";
  payment: {
    requestedPayer: "CUSTOMER";
    status: "MANAGED_IN_META" | "ACTION_REQUIRED" | "UNKNOWN";
    paymentMethodVerified: false; // No read here proves a card, liability or funding arrangement.
  };
};
export type MetaSignupAttemptView = {
  variant?: MetaSignupVariant;
  coexistenceConsent?: MetaCoexistenceConsent;
  purpose: "NEW_NUMBER" | "RECONNECT" | "ADD_ACCESS" | "TRANSITION_READBACK" | "LEGACY_MIGRATION";
  target?: { connectionId: string; name: string; state: "PAUSED" | "WORKING"; mode?: "STANDARD" | "COEXISTENCE" }; // Expected captured state; currentness is rechecked for every mutation.
  targetTransitionId?: string; // Exact local transition, never a provider ID.
  targetLegacyMigrationId?: string;
  outcome?: "ACCESS_RENEWED_PAUSED" | "ACCESS_ADDED_PAUSED" | "READBACK_ACCESS_RENEWED" | "MIGRATION_ACCESS_VERIFIED";
  attemptId: string;
  revision: number;
  expiresAt: string;
  status: MetaSignupStatus;
  nextAction: MetaSignupNextAction;
  reasonCode?: MetaSignupReason;
  readiness: MetaSignupReadiness;
  canCancel: boolean;
  canStartAgain: boolean;
  choices: MetaSignupChoice[];
  selectionRevision?: number;
  connectionId?: string;
  operationId?: string;
};
export type MetaSignupStartRequest = { name: string; /* Trimmed 1..100 characters; Unicode Cc rejected. */ payerMode: "CUSTOMER"; idempotencyKey: string; targetConnectionId?: string; targetTransitionId?: string; targetLegacyMigrationId?: string; purpose?: "NEW_NUMBER" | "ADD_ACCESS" /* Mutually exclusive with targetConnectionId, which derives RECONNECT. */; variant?: MetaSignupVariant; coexistenceConsent?: MetaCoexistenceConsent };
export type MetaSignupStartResponse = MetaSignupAttemptView & {
  challenge?: string; // Only initial creation. Never persist in browser storage.
  sdk: MetaSignupSdk;
};
export type MetaSignupExchangeRequest = { challenge: string; code: string; expectedRevision: number };
export type MetaSignupSelectRequest = {
  expectedRevision: number;
  selectionRevision: number;
  choiceId: string;
  registrationPin?: string; // Exactly six digits for STANDARD NEW_NUMBER only. RECONNECT, ADD_ACCESS and BUSINESS_APP reject every present property.
};
export type MetaSignupRevisionRequest = { expectedRevision: number };

/* Routes: portal /api/connections/meta/signup; control /v1/connections/meta/signup.
 * GET  /capabilities -> MetaSignupCapabilities
 * GET  /attempts[?targetConnectionId=<local UUID>|purpose=NEW_NUMBER|ADD_ACCESS] -> {attempt: MetaSignupAttemptView | null}
 *      With target: this actor's latest RECONNECT for that exact local target.
 *      Without target: this actor's latest selected purpose (default NEW_NUMBER). No other-purpose resume.
 *      targetConnectionId and purpose must never both be supplied; duplicate query fields reject.
 * POST /attempts (StartRequest) -> StartResponse
 * GET  /attempts/:id -> AttemptView
 * POST /attempts/:id/exchange (ExchangeRequest) -> AttemptView
 * POST /attempts/:id/discover (RevisionRequest) -> AttemptView
 * POST /attempts/:id/select (SelectRequest) -> AttemptView
 * POST /attempts/:id/cancel (RevisionRequest) -> AttemptView
 * POST /attempts/:id/session-log -> bounded advisory Business app session event
 *
 * Owner/admin connection:write required throughout. Portal mutation exact origin,
 * JSON and CSRF. Server repeats privileged-authentication + actor/tenant checks.
 * Portal forwards its already verified Origin header to control API on mutations.
 * Control API compares Origin to its configured PORTAL_PUBLIC_ORIGIN and the
 * immutable attempt origin; it never accepts a caller-selected redirect/origin.
 * All no-store. Fixed customer-paid configuration selected on server.
 * No request parameter may supply app, solution, account/phone ID, Graph origin,
 * token or secret reference. Optional PIN never logs or returns.
 *
 * Provider/operation failures after a durable attempt exists return its typed view;
 * invalid auth/input/state/CAS use incumbent {error: safe localized text, code?}
 * HTTP errors (400/401/403/404/409). Do not expose raw Meta payload/error text.
 * STANDARD ignores custom postMessage. BUSINESS_APP logs only documented,
 * strictly validated session events from its active invocation; none is authority.
 * SDK callback code is immediately submitted in its invocation closure.
 * A final popup close is not cancellation proof.
 * Poll authenticated status for EXCHANGING/PROVISIONING, not exchange replay.
 * GET /attempts returns only this tenant and actor's latest non-expired resumable
 * attempt, or null; do not enumerate another actor's attempts. Reload uses this
 * authenticated read rather than storing challenge/code in browser storage.
 * An awaiting attempt after reload must cancel/start afresh; an exchanged attempt
 * resumes status/discovery/selection using the current actor.
 * Capabilities exposes only public SDK configuration after configured secret and
 * sidecar readiness; POST start repeats preflight before returning challenge.
 * UI loads SDK and prepares the validated attempt first, then a deliberate
 * Connect button synchronously invokes FB.login in the user gesture. No automatic
 * attempts per keystroke or automatic new SDK invocation after reload.
 */
