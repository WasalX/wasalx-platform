import type {ManagedFundingStore,ManagedFundingContext,FinancialCheckpoint,FundingReservation} from "./meta-managed-funding.js";
import type {MetaActualRequestExecution} from "../../../packages/core/src/meta-account-policy.js";
import type {MetaRuntimeEvidenceCandidate} from "./meta-request-provenance.js";
import {createHash} from "node:crypto";
import {metaTemplatePreparationRepository} from './meta-template-preparation-repository.js';
import {metaLegacyMigrationRepository} from './meta-legacy-migration-repository.js';
import type {MetaLegacyMigrationStore} from './meta-legacy-migration.js';
import type {MetaTemplatePreparationStore} from './meta-template-preparation.js';
import {metaTransitionExecutionRepository} from './meta-account-transition-execution-repository.js';
import type {MetaTransitionExecutionStore} from './meta-account-transition-execution.js';
import {parseMetaLifecycleState,metaLifecycleBlockingReasons,recoverMetaLifecycleReasons,assertMetaLifecycleAccess,metaLifecyclePayloadSha256,type MetaLifecycleReason} from "../../../packages/core/src/meta-account-relation.js";
import {metaBillingDiagnosticBinding,metaBillingDiagnosticProofCurrent,unavailableMetaBillingDiagnostic,type MetaBillingDiagnostic} from "../../../packages/core/src/meta-billing-diagnostic.js";
import {metaAccountFundingProof,type MetaAccountFundingProof} from "../../../packages/core/src/meta-account-policy.js";
import { metaRoutingRuntime } from "../../../packages/core/src/meta-routing.js";
import { Pool, type PoolClient } from "pg";
import {metaTransitionContext,type MetaTransitionContext} from '../../../packages/core/src/meta-account-transition-context.js';
import {metaTransitionObservation,type MetaTransitionObservation} from '../../../packages/core/src/meta-account-transition-observation.js';
import type {MetaTransitionPreviewRequest} from '../../../packages/core/src/meta-account-transition-contract.js';
export type MetaTransitionReadFrame={context:MetaTransitionContext|null;current:boolean;revision:number;request:MetaTransitionPreviewRequest};
import { ProviderError, type ProviderGroup } from "../../../packages/connectors/src/types.js";
import { parseWahaTestRecipientAllowlist, wahaTestRecipientAllowed } from "../../../packages/core/src/waha-test-recipient-scope.js";
import { sameMetaConnectionBinding, type MetaConnectionBinding } from "../../../packages/core/src/meta-account-relation.js";

export type ConnectionOperationType =
  | "PROVISION"
  | "START"
  | "RESTART"
  | "PAUSE"
  | "DISCONNECT"
  | "SYNC_GROUPS"
  | "SYNC_META_APP"
  | "VERIFY_META_BILLING"
  | "PREVIEW_META_ACCOUNT_TRANSITION"
  | "EXECUTE_META_ACCOUNT_TRANSITION";

export type ConnectionRuntimeState =
  | "PROVISIONING"
  | "AWAITING_AUTH"
  | "CONNECTING"
  | "WORKING"
  | "DEGRADED"
  | "ACTION_REQUIRED"
  | "FAILED"
  | "PAUSED"
  | "REVOKED";

export type ConnectionOperationJob = {
  id: string;
  tenantId: string;
  connectionId: string;
  operationType: ConnectionOperationType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  fencingToken: number;
  provider: "WAHA" | "META";
  connectionState: ConnectionRuntimeState;
  connectionSecretReference: string;
  disclosureVersion?: string | null;
  engine?: string;
  providerSession?: {
    id: string;
    opaqueSessionId: string;
    state: string;
    fencingToken: number;
    providerStateData: Record<string, unknown>;
    wahaAssignment?: WahaWorkerAssignment;
  };
  webhookRoute?: {
    id: string;
    state: "ACTIVE" | "PAUSED" | "REVOKED";
    hmacSecretReference: string;
  };
};

export type WahaWorkerAssignment = {
  workerId: string;
  workerKey: string;
  engine: "GOWS" | "NOWEB";
  baseUrl: string;
  secretReference: string;
  fencingToken: number;
  leaseExpiresAt: string;
};

export type ProviderSessionLease = {
  id: string;
  workerIdentity: string;
  fencingToken: number;
  leaseExpiresAt: string;
  wahaAssignment?: WahaWorkerAssignment;
};

export type OperationCompletion = {
  connectionState: ConnectionRuntimeState;
  providerState: string;
  providerStateData: Record<string, unknown>;
  actionReason?: string | null;
  phoneE164?: string;
  engine?: string;
  groups?: ProviderGroup[];
  retireSession?: boolean;
  revokeWebhook?: boolean;
  webhookState?: "ACTIVE" | "PAUSED" | "REVOKED";
  result: Record<string, unknown>;
};

export type OperationFailure = {
  retryable: boolean;
  code: string;
  safeError: string;
  retryAt?: string;
  connectionState: ConnectionRuntimeState;
};

export interface ConnectionOperationStore extends ManagedFundingStore {
  coexistenceRequest?(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease,
    kind: "contacts" | "history", outcome: "CLAIMED" | "DISPATCH" | "ACCEPTED" | "REJECTED" | "UNKNOWN", requestId?: string): Promise<boolean>;
  finishCoexistence?(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease | undefined): Promise<void>;
  assertMetaSignupCurrent?(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease): Promise<void>;
  claimMetaSignupRegistration?(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease, attemptId: string): Promise<boolean>;
  templatePreparationStore():MetaTemplatePreparationStore;
  legacyMigrationStore():MetaLegacyMigrationStore;
  transitionExecutionStore():MetaTransitionExecutionStore;
  guardMetaTransitionPreview(job:ConnectionOperationJob,leaseId:string,appId:string):Promise<MetaTransitionReadFrame>;
  completeMetaTransitionPreview(job:ConnectionOperationJob,leaseId:string,appId:string,observation:MetaTransitionObservation):Promise<void>;
  guardMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string, appId: string): Promise<"CURRENT" | "HELD" | "CHANGED">;
  completeMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string, appId: string, result: MetaBillingDiagnostic, funding?:MetaAccountFundingProof): Promise<void>;
  failMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string, failure: OperationFailure, appId?: string): Promise<void>;
  claim(tenantId: string, operationLeaseId: string, limit?: number): Promise<ConnectionOperationJob[]>;
  acquireWahaWorkerAssignment(
    job: ConnectionOperationJob,
    leaseForSeconds?: number,
  ): Promise<WahaWorkerAssignment>;
  acquireProviderSessionLease(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    workerIdentity: string,
    leaseForSeconds?: number,
  ): Promise<ProviderSessionLease>;
  renewLeases(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    leaseForSeconds?: number,
  ): Promise<ProviderSessionLease>;
  complete(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    completion: OperationCompletion,
  ): Promise<OperationCompletion | void>;
  fail(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease | undefined,
    failure: OperationFailure,
  ): Promise<void>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

type OperationRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  operation_type: ConnectionOperationType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  fencing_token: string | number;
  provider: "WAHA" | "META";
  connection_state: ConnectionRuntimeState;
  connection_secret_reference: string;
  disclosure_version: string | null;
  engine: string | null;
  provider_session_id: string | null;
  opaque_session_id: string | null;
  provider_session_state: string | null;
  provider_session_fencing_token: string | number | null;
  provider_session_state_data: Record<string, unknown> | null;
  webhook_route_id: string | null;
  webhook_route_state: "ACTIVE" | "PAUSED" | "REVOKED" | null;
  webhook_hmac_secret_reference: string | null;
};

type SessionLeaseRow = {
  id: string;
  fencing_token: string | number;
  lease_expires_at: Date | string;
};

type WahaAssignmentRow = {
  waha_worker_id: string;
  worker_key: string;
  engine: "GOWS" | "NOWEB";
  base_url: string;
  secret_reference: string;
  assignment_fencing_token: string | number;
  assignment_lease_expires_at: Date | string;
};

/** Raised when another worker has reclaimed either the operation or provider session. */
export class ConnectionOperationLeaseLostError extends Error {
  constructor(message = "Connection operation lease was lost") {
    super(message);
    this.name = "ConnectionOperationLeaseLostError";
  }
}

/** Raised when a valid operation cannot acquire the connection's singular session owner. */
export class ProviderSessionLeaseUnavailableError extends Error {
  readonly retryable = true;
  readonly code = "PROVIDER_SESSION_LEASE_UNAVAILABLE";

  constructor() {
    super("The WhatsApp session is currently owned by another worker.");
    this.name = "ProviderSessionLeaseUnavailableError";
  }
}

/** No healthy, non-draining WAHA node can safely own this session. */
export class WahaWorkerAssignmentUnavailableError extends Error {
  readonly retryable = true;
  readonly code = "WAHA_WORKER_ASSIGNMENT_UNAVAILABLE";

  constructor() {
    super("No healthy WAHA worker has capacity for this session.");
    this.name = "WahaWorkerAssignmentUnavailableError";
  }
}

export class ConnectionOperationRepository implements ConnectionOperationStore {
  constructor(private readonly pool: Pool) {}
  templatePreparationStore():MetaTemplatePreparationStore{return metaTemplatePreparationRepository((tenantId,work)=>this.tenant(tenantId,work));}
  legacyMigrationStore():MetaLegacyMigrationStore{return metaLegacyMigrationRepository((tenantId,work)=>this.tenant(tenantId,work));}
  transitionExecutionStore():MetaTransitionExecutionStore{return metaTransitionExecutionRepository((tenantId,work)=>this.tenant(tenantId,work));}

  async coexistenceRequest(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease,
    kind: "contacts" | "history", outcome: "CLAIMED" | "DISPATCH" | "ACCEPTED" | "REJECTED" | "UNKNOWN", requestId?: string) {
    if (outcome === "DISPATCH" && (process.env.META_SIGNUP_ENABLED !== "true" || process.env.META_COEXISTENCE_ENABLED !== "true")) return false;
    const config = { appId: process.env.META_APP_ID ?? "", configId: process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID ?? "",
      graphVersion: process.env.META_GRAPH_VERSION ?? "", secretReference: process.env.META_APP_SECRET_REFERENCE ?? "",
      origin: process.env.PORTAL_PUBLIC_ORIGIN ?? "", payerMode: "CUSTOMER", variant: "BUSINESS_APP" };
    return this.tenant(job.tenantId, async client => {
      await this.lockOperationFence(client, job, operationLeaseId);
      if (!(await this.lockConnection(client, job)).metaBindingCurrent) throw new ConnectionOperationLeaseLostError();
      await this.lockSessionFence(client, job, sessionLease);
      return (await client.query<{ applied: boolean }>("SELECT app.meta_coexistence_request($1,$2,$3,$4,$5,$6,$7,$8,$9) AS applied",
        [job.id, operationLeaseId, job.fencingToken, sessionLease.workerIdentity, sessionLease.fencingToken, kind, outcome, requestId ?? null, config])).rows[0]?.applied === true;
    });
  }

  /** Import finalization deliberately does not use connection activation/diagnostic finalizers. */
  async finishCoexistence(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease | undefined) {
    await this.tenant(job.tenantId, async client => {
      await this.lockOperationFence(client, job, operationLeaseId);
      await this.releaseSupersededMetaLease(client, job, sessionLease);
      const completed = await client.query("SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)",
        [job.id, operationLeaseId, job.fencingToken, JSON.stringify({ importOnly: true })]);
      if (completed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
    });
  }

  async assertMetaSignupCurrent(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease) {
    await this.tenant(job.tenantId, async client => {
      await this.lockOperationFence(client, job, operationLeaseId);
      const current = await this.lockConnection(client, job);
      if (!current.metaBindingCurrent) throw new ConnectionOperationLeaseLostError();
      await this.lockSessionFence(client, job, sessionLease);
      await this.signupCurrent(client, job);
    });
  }

  private async signupCurrent(client: PoolClient, job: ConnectionOperationJob) {
    const marker = job.providerSession?.providerStateData.metaSignup as Record<string, unknown> | undefined;
    const businessApp = marker?.variant === "BUSINESS_APP";
    const config = { appId: process.env.META_APP_ID ?? "", configId: (businessApp ? process.env.META_SIGNUP_BUSINESS_APP_CONFIG_ID : process.env.META_SIGNUP_CUSTOMER_CONFIG_ID) ?? "",
      graphVersion: process.env.META_GRAPH_VERSION ?? "", secretReference: process.env.META_APP_SECRET_REFERENCE ?? "",
      origin: process.env.PORTAL_PUBLIC_ORIGIN ?? "", payerMode: "CUSTOMER", ...(businessApp ? { variant: "BUSINESS_APP" } : {}) };
    if (process.env.META_SIGNUP_ENABLED !== "true" || (businessApp && process.env.META_COEXISTENCE_ENABLED !== "true") || !marker) throw new ProviderError("Account setup configuration changed.", false, "META_SIGNUP_STATE_INVALID");
    const current = await client.query<{ current: boolean }>("SELECT app.meta_signup_operation_current($1,$2,$3,$4,$5,$6,$7,$8,$9) AS current",
      [job.tenantId, marker.attemptId, job.connectionId, job.id, config, job.providerSession?.opaqueSessionId,
        job.providerSession?.providerStateData.wabaId, marker.businessId,
        (job.providerSession?.providerStateData.metaAccountProof as Record<string, unknown> | undefined)?.credentialFingerprint]);
    if (current.rows[0]?.current !== true) throw new ProviderError("Account setup authorization changed.", false, "META_SIGNUP_STATE_INVALID");
  }

  async claimMetaSignupRegistration(job: ConnectionOperationJob, operationLeaseId: string, sessionLease: ProviderSessionLease, attemptId: string) {
    return this.tenant(job.tenantId, async client => {
      await this.lockOperationFence(client, job, operationLeaseId);
      const current = await this.lockConnection(client, job);
      if (!current.metaBindingCurrent) throw new ConnectionOperationLeaseLostError();
      await this.lockSessionFence(client, job, sessionLease);
      await this.signupCurrent(client, job);
      const attempt = (await client.query<{ registration_claimed_at: string | null }>(`SELECT registration_claimed_at FROM meta_signup_attempts
        WHERE tenant_id=$1 AND id=$2 AND connection_id=$3 AND operation_id=$4 AND status='PROVISIONING' AND purpose='NEW_NUMBER'
        AND selected_choice->>'phoneId'=$5 AND selected_choice->>'wabaId'=$6
        AND selected_choice->>'businessId'=$7 AND credential_fingerprint=$8 FOR UPDATE`,
      [job.tenantId, attemptId, job.connectionId, job.id, job.providerSession?.opaqueSessionId,
        job.providerSession?.providerStateData.wabaId,
        (job.providerSession?.providerStateData.metaSignup as Record<string, unknown> | undefined)?.businessId,
        (job.providerSession?.providerStateData.metaAccountProof as Record<string, unknown> | undefined)?.credentialFingerprint])).rows[0];
      if (!attempt) throw new ProviderError("Signup registration requires reconciliation.", false, "META_SIGNUP_REGISTRATION_UNKNOWN");
      if (attempt.registration_claimed_at) return false;
      await client.query(`UPDATE meta_signup_attempts SET registration_claimed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2`, [job.tenantId, attemptId]);
      return true;
    });
  }

  async claim(tenantId: string, operationLeaseId: string, limit = 1): Promise<ConnectionOperationJob[]> {
    return this.tenant(tenantId, async (client) => {
      const result = await client.query<OperationRow>(
        `WITH claimed AS (
           SELECT * FROM app.claim_connection_operations($1, $2)
         )
         SELECT operation.id,
                operation.tenant_id,
                operation.connection_id,
                operation.operation_type,
                operation.payload,
                operation.attempts,
                operation.max_attempts,
                operation.fencing_token,
                connection.provider,
                connection.state AS connection_state,
                connection.secret_reference AS connection_secret_reference,
                connection.disclosure_version,
                connection.engine,
                session.id AS provider_session_id,
                session.opaque_session_id,
                session.state AS provider_session_state,
                session.fencing_token AS provider_session_fencing_token,
                session.provider_state_data AS provider_session_state_data,
                route.id AS webhook_route_id,
                route.state AS webhook_route_state,
                route.hmac_secret_reference AS webhook_hmac_secret_reference
           FROM claimed AS operation
           JOIN connections AS connection
             ON connection.tenant_id = operation.tenant_id
            AND connection.id = operation.connection_id
           LEFT JOIN LATERAL (
             SELECT candidate.id,
                    candidate.opaque_session_id,
                    candidate.state,
                    candidate.fencing_token,
                    candidate.provider_state_data
               FROM provider_sessions AS candidate
              WHERE candidate.tenant_id = operation.tenant_id
                AND candidate.connection_id = operation.connection_id
                AND candidate.ownership_state = 'ACTIVE'
              ORDER BY candidate.created_at DESC, candidate.id DESC
              LIMIT 1
           ) AS session ON true
           LEFT JOIN webhook_routes AS route
             ON route.tenant_id = operation.tenant_id
            AND route.connection_id = operation.connection_id
            AND route.provider = connection.provider
          ORDER BY operation.created_at, operation.id`,
        [operationLeaseId, limit],
      );

      return result.rows.map(mapOperationRow);
    });
  }

  async acquireWahaWorkerAssignment(
    job: ConnectionOperationJob,
    leaseForSeconds = 120,
  ): Promise<WahaWorkerAssignment> {
    const sessionId = job.providerSession?.id;
    if (!sessionId || job.provider !== "WAHA") throw new WahaWorkerAssignmentUnavailableError();
    assertLeaseDuration(leaseForSeconds);
    const engine = job.engine?.toUpperCase();
    if (engine !== "GOWS" && engine !== "NOWEB") {
      throw new WahaWorkerAssignmentUnavailableError();
    }
    const pinnedWorkerId = duplicateCleanupWorkerId(job);
    return this.tenant(job.tenantId, async (client) => {
      const row = (
        await client.query<WahaAssignmentRow>(
          pinnedWorkerId
            ? `SELECT waha_worker_id,worker_key,engine,base_url,secret_reference,
                      assignment_fencing_token,assignment_lease_expires_at
                 FROM app.pin_waha_session_assignment_for_cleanup($1,$2,$3,$4,$5 * interval '1 second')`
            : `SELECT waha_worker_id,worker_key,engine,base_url,secret_reference,
                      assignment_fencing_token,assignment_lease_expires_at
                 FROM app.acquire_waha_session_assignment($1,$2,$3 * interval '1 second')`,
          pinnedWorkerId
            ? [sessionId, pinnedWorkerId, job.id, job.fencingToken, leaseForSeconds]
            : [sessionId, engine, leaseForSeconds],
        )
      ).rows[0];
      if (!row) throw new WahaWorkerAssignmentUnavailableError();
      const assignment = mapWahaAssignment(row);
      job.providerSession!.wahaAssignment = assignment;
      return assignment;
    });
  }

  async acquireProviderSessionLease(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    workerIdentity: string,
    leaseForSeconds = 120,
  ): Promise<ProviderSessionLease> {
    const sessionId = job.providerSession?.id;
    if (!sessionId) throw new ProviderSessionLeaseUnavailableError();
    if (job.provider === "WAHA" && !job.providerSession?.wahaAssignment) {
      throw new WahaWorkerAssignmentUnavailableError();
    }
    assertLeaseDuration(leaseForSeconds);

    return this.tenant(job.tenantId, async (client) => {
      await this.lockOperationFence(client, job, operationLeaseId);
      const session = (
        await client.query<SessionLeaseRow>(
          "SELECT id, fencing_token, lease_expires_at FROM app.acquire_provider_session_lease($1, $2, $3 * interval '1 second')",
          [sessionId, workerIdentity, leaseForSeconds],
        )
      ).rows[0];
      if (!session) throw new ProviderSessionLeaseUnavailableError();

      const operation = await client.query(
        `UPDATE connection_operations
            SET lease_expires_at = now() + $1 * interval '1 second',
                updated_at = now()
          WHERE tenant_id = $2
            AND id = $3
            AND state = 'RUNNING'
            AND lease_id = $4
            AND fencing_token = $5
            AND lease_expires_at >= now()`,
        [leaseForSeconds, job.tenantId, job.id, operationLeaseId, job.fencingToken],
      );
      if (operation.rowCount !== 1) throw new ConnectionOperationLeaseLostError();

      return {
        id: session.id,
        workerIdentity,
        fencingToken: numericToken(session.fencing_token),
        leaseExpiresAt: isoTimestamp(session.lease_expires_at),
        ...(job.providerSession?.wahaAssignment
          ? { wahaAssignment: job.providerSession.wahaAssignment }
          : {}),
      };
    });
  }

  async renewLeases(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    leaseForSeconds = 120,
  ): Promise<ProviderSessionLease> {
    assertLeaseDuration(leaseForSeconds);
    return this.tenant(job.tenantId, async (client) => {
      if(job.payload.metaAddAccessActivation)await this.lockOperationFence(client,job,operationLeaseId);
      const operation = await client.query(
        `UPDATE connection_operations
            SET lease_expires_at = now() + $1 * interval '1 second',
                updated_at = now()
          WHERE tenant_id = $2
            AND id = $3
            AND state = 'RUNNING'
            AND lease_id = $4
            AND fencing_token = $5
            AND lease_expires_at >= now()`,
        [leaseForSeconds, job.tenantId, job.id, operationLeaseId, job.fencingToken],
      );
      if (operation.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
      if (job.provider === "META" && !(await this.lockConnection(client, job)).metaBindingCurrent) {
        throw new ProviderError("The Meta credential or account selection was superseded.", false, "META_BINDING_SUPERSEDED");
      }


      const session = (
        await client.query<SessionLeaseRow>(
          "SELECT id, fencing_token, lease_expires_at FROM app.renew_provider_session_lease($1, $2, $3, $4 * interval '1 second')",
          [sessionLease.id, sessionLease.workerIdentity, sessionLease.fencingToken, leaseForSeconds],
        )
      ).rows[0];
      if (!session) throw new ConnectionOperationLeaseLostError("Provider session lease was lost");
      let wahaAssignment = sessionLease.wahaAssignment;
      if (job.provider === "WAHA") {
        if (!wahaAssignment) {
          throw new ConnectionOperationLeaseLostError("WAHA worker assignment was unavailable");
        }
        const assignment = (
          await client.query<WahaAssignmentRow>(
            `SELECT waha_worker_id,worker_key,engine,base_url,secret_reference,
                    assignment_fencing_token,assignment_lease_expires_at
               FROM app.renew_waha_session_assignment($1,$2,$3,$4 * interval '1 second')`,
            [sessionLease.id, wahaAssignment.workerId, wahaAssignment.fencingToken, leaseForSeconds],
          )
        ).rows[0];
        if (!assignment) {
          throw new ConnectionOperationLeaseLostError("WAHA worker assignment was lost");
        }
        wahaAssignment = mapWahaAssignment(assignment);
        if (job.providerSession) job.providerSession.wahaAssignment = wahaAssignment;
      }
      return {
        ...sessionLease,
        leaseExpiresAt: isoTimestamp(session.lease_expires_at),
        ...(wahaAssignment ? { wahaAssignment } : {}),
      };
    });
  }

  async complete(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease,
    completion: OperationCompletion,
  ): Promise<OperationCompletion | void> {
    return this.tenant(job.tenantId, async (client) => {
      await this.lockOperationFence(client, job, operationLeaseId);
      const current = await this.lockConnection(client,job);
      const currentConnectionState = current.state;
      if (job.provider === "META" && ["PAUSE", "DISCONNECT"].includes(job.operationType)) {
        completion.providerStateData = { ...completion.providerStateData, metaAccountProof: current.providerStateData?.metaAccountProof };
      }
      if (!current.metaBindingCurrent) {
        await this.releaseSupersededMetaLease(client, job, sessionLease);
        const result = { superseded: true, reason: "META_BINDING_SUPERSEDED", originalResult: completion.result };
        const completed = await client.query("SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)",
          [job.id, operationLeaseId, job.fencingToken, JSON.stringify(result)]);
        if (completed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
        return { ...completion, connectionState: currentConnectionState, result };
      }
      if(job.provider==="META"){
        // Preserve the current authority, including local PAUSE/DISCONNECT; never restore a claim snapshot.
        completion.providerStateData={...current.providerStateData,...completion.providerStateData};
        delete completion.providerStateData.metaLifecycle;
        if(current.providerStateData&&Object.hasOwn(current.providerStateData,"metaLifecycle")){
          completion.providerStateData.metaLifecycle=current.providerStateData.metaLifecycle;
          if(completion.connectionState==="WORKING"&&job.payload.metaLifecycleRecovery){
            completion.providerStateData.metaLifecycle=operationLifecycleCandidate(job,current.providerStateData.metaLifecycle);
          }
        }
      }
      await this.lockSessionFence(client, job, sessionLease);

      if(job.operationType==="SYNC_GROUPS"){
        const routeState=(await client.query<{state:string}>(
          "SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2 AND provider=$3 FOR SHARE",
          [job.tenantId,job.connectionId,job.provider],
        )).rows[0]?.state;
        const sessionState=(await client.query<{state:string}>(
          "SELECT state FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND id=$3",
          [job.tenantId,job.connectionId,sessionLease.id],
        )).rows[0]?.state;
        if(!["WORKING","DEGRADED"].includes(currentConnectionState)||routeState!=="ACTIVE"||sessionState!=="WORKING"){
          const released=await client.query(
            `UPDATE provider_sessions SET worker_id=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND worker_id=$4 AND fencing_token=$5`,
            [job.tenantId,job.connectionId,sessionLease.id,sessionLease.workerIdentity,sessionLease.fencingToken],
          );
          if(released.rowCount!==1)throw new ConnectionOperationLeaseLostError("Provider session lease was lost while superseding group sync");
          const result={superseded:true,reason:"CONNECTION_LIFECYCLE_CHANGED"};
          const completed=await client.query("SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)",[
            job.id,operationLeaseId,job.fencingToken,JSON.stringify(result),
          ]);
          if(completed.rowCount!==1)throw new ConnectionOperationLeaseLostError();
          return{...completion,connectionState:currentConnectionState,result};
        }
      }

      if (job.provider === "WAHA" && completion.phoneE164 && sessionLease.wahaAssignment) {
        const cleanupOperationId = (
          await client.query<{ cleanup_operation_id: string | null }>(
            "SELECT app.queue_duplicate_waha_identity_cleanup($1,$2,$3,$4,$5) AS cleanup_operation_id",
            [job.connectionId, sessionLease.id, sessionLease.wahaAssignment.workerId, completion.phoneE164, job.id],
          )
        ).rows[0]?.cleanup_operation_id;
        if (cleanupOperationId) {
          const providerStateData = JSON.stringify(completion.providerStateData);
          const session = await client.query(
            `UPDATE provider_sessions
                SET state='ACTION_REQUIRED',provider_state=$1,provider_state_data=$2::jsonb,
                    last_provider_status_at=now(),
                    onboarding_scan_completed_at=CASE
                      WHEN onboarding_authorization_method='QR'
                        AND onboarding_scan_completed_at IS NULL
                        AND onboarding_scan_acknowledged_at IS NOT NULL
                        AND onboarding_scan_acknowledged_at<=COALESCE(onboarding_working_at,now())
                        THEN onboarding_scan_acknowledged_at
                      ELSE onboarding_scan_completed_at END,
                    onboarding_working_at=CASE WHEN onboarding_qr_ready_at IS NOT NULL
                      THEN COALESCE(onboarding_working_at,now()) ELSE onboarding_working_at END,
                    worker_id=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$3 AND connection_id=$4 AND id=$5 AND ownership_state='ACTIVE'
                AND worker_id=$6 AND fencing_token=$7 AND lease_expires_at>=now()
                AND waha_worker_id=$8 AND assignment_fencing_token=$9
                AND assignment_lease_expires_at>=now()`,
            [
              completion.providerState,
              providerStateData,
              job.tenantId,
              job.connectionId,
              sessionLease.id,
              sessionLease.workerIdentity,
              sessionLease.fencingToken,
              sessionLease.wahaAssignment.workerId,
              sessionLease.wahaAssignment.fencingToken,
            ],
          );
          if (session.rowCount !== 1) {
            throw new ConnectionOperationLeaseLostError("Provider session lease was lost during duplicate rejection");
          }
          const result = { rejected: "DUPLICATE_IDENTITY", cleanupOperationId };
          const completed = await client.query(
            "SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)",
            [job.id, operationLeaseId, job.fencingToken, JSON.stringify(result)],
          );
          if (completed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
          return {
            connectionState: "ACTION_REQUIRED",
            providerState: completion.providerState,
            providerStateData: completion.providerStateData,
            actionReason: "This WhatsApp account is already connected in this workspace. Removing the duplicate linked session.",
            result,
          };
        }
      }

      if(job.payload.metaAddAccessActivation){
        if(job.operationType!=="START"||completion.result.metaAddAccessActivated!==true||completion.connectionState!=="WORKING"
          ||completion.webhookState!=="ACTIVE"||completion.groups!==undefined||completion.phoneE164!==undefined
          ||metaLifecyclePayloadSha256(completion.providerStateData)!==metaLifecyclePayloadSha256(current.providerStateData))
          throw new ConnectionOperationLeaseLostError("Saved access activation result changed");
        // This receipt and all local state changes commit together. The database
        // boundary repeats current routing/funding checks before each activation.
        await client.query("UPDATE connection_operations SET result=$1::jsonb WHERE tenant_id=$2 AND id=$3",
          [JSON.stringify(completion.result),job.tenantId,job.id]);
      }

      if (completion.groups !== undefined) {
        await synchronizeGroups(client, job, completion.groups);
      }

      const connection = await client.query(
        `UPDATE connections
            SET state = $1,
                engine = COALESCE($2, engine),
                phone_e164 = COALESCE($3, phone_e164),
                action_reason = $4,
                last_heartbeat_at = CASE WHEN $1 = 'WORKING' THEN now() ELSE last_heartbeat_at END,
                updated_at = now()
          WHERE tenant_id = $5
            AND id = $6`,
        [
          completion.connectionState,
          completion.engine ?? null,
          completion.phoneE164 ?? null,
          completion.actionReason ?? null,
          job.tenantId,
          job.connectionId,
        ],
      );
      if (connection.rowCount !== 1) throw new ConnectionOperationLeaseLostError("Connection was removed during finalization");

      const session = await client.query(
        `UPDATE provider_sessions
            SET state = $1,
                provider_state = $2,
                provider_state_data = $3::jsonb,
                ownership_state = CASE WHEN $4 THEN 'RETIRED' ELSE ownership_state END,
                retired_at = CASE WHEN $4 THEN now() ELSE retired_at END,
                last_provider_status_at = now(),
                onboarding_qr_ready_at = CASE WHEN $2 = 'SCAN_QR_CODE' THEN now() ELSE onboarding_qr_ready_at END,
                onboarding_authorization_method = CASE WHEN $2 = 'SCAN_QR_CODE' THEN 'QR' ELSE onboarding_authorization_method END,
                onboarding_scan_acknowledged_at = CASE
                  WHEN $2 = 'SCAN_QR_CODE' THEN NULL
                  ELSE onboarding_scan_acknowledged_at END,
                onboarding_scan_completed_at = CASE
                  WHEN $2 = 'SCAN_QR_CODE' THEN NULL
                  WHEN $2 = 'WORKING' AND onboarding_authorization_method='QR'
                    AND onboarding_scan_completed_at IS NULL
                    AND onboarding_scan_acknowledged_at IS NOT NULL
                    AND onboarding_scan_acknowledged_at<=COALESCE(onboarding_working_at,now())
                    THEN onboarding_scan_acknowledged_at
                  ELSE onboarding_scan_completed_at END,
                onboarding_working_at = CASE
                  WHEN $2 = 'SCAN_QR_CODE' THEN NULL
                  WHEN $2 = 'WORKING' AND onboarding_qr_ready_at IS NOT NULL THEN COALESCE(onboarding_working_at, now())
                  ELSE onboarding_working_at END,
                worker_id = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE tenant_id = $5
            AND connection_id = $6
            AND id = $7
            AND ownership_state = 'ACTIVE'
            AND worker_id = $8
            AND fencing_token = $9
            AND lease_expires_at >= now()
            AND ($10::uuid IS NULL OR waha_worker_id = $10)
            AND ($11::bigint IS NULL OR assignment_fencing_token = $11)
            AND ($12::timestamptz IS NULL OR assignment_lease_expires_at >= now())`,
        [
          completion.connectionState,
          completion.providerState,
          JSON.stringify(completion.providerStateData),
          completion.retireSession ?? false,
          job.tenantId,
          job.connectionId,
          sessionLease.id,
          sessionLease.workerIdentity,
          sessionLease.fencingToken,
          sessionLease.wahaAssignment?.workerId ?? null,
          sessionLease.wahaAssignment?.fencingToken ?? null,
          sessionLease.wahaAssignment?.leaseExpiresAt ?? null,
        ],
      );
      if (session.rowCount !== 1) throw new ConnectionOperationLeaseLostError("Provider session lease was lost during finalization");

      const requestedWebhookState = completion.webhookState ?? (completion.revokeWebhook ? "REVOKED" : undefined);
      if (requestedWebhookState) {
        const webhookSecretReference = job.webhookRoute?.hmacSecretReference;
        if (!webhookSecretReference) {
          throw new ConnectionOperationLeaseLostError("Webhook route was unavailable during finalization");
        }
        const route = await client.query(
          `UPDATE webhook_routes
              SET state = $1,
                  admission_opened_at = CASE WHEN $1='ACTIVE' AND state<>'ACTIVE' THEN clock_timestamp() ELSE admission_opened_at END,
                  updated_at = now()
            WHERE tenant_id = $2
              AND connection_id = $3
              AND id = $4`,
          [requestedWebhookState, job.tenantId, job.connectionId, job.webhookRoute?.id ?? "00000000-0000-0000-0000-000000000000"],
        );
        if (route.rowCount !== 1) throw new ConnectionOperationLeaseLostError("Webhook route was removed during finalization");

        if (
          job.provider === "WAHA" &&
          job.operationType === "DISCONNECT" &&
          requestedWebhookState === "REVOKED"
        ) {
          // The provider session has already been torn down at this point. The
          // cleanup reference is committed in the same transaction as the
          // revoked route and successful operation, so a cleanup processor can
          // never delete the webhook secret before teardown finalization is
          // durable. The connector worker only has INSERT permission here and
          // never receives a secret-manager write credential.
          await client.query(
            `INSERT INTO secret_cleanup_outbox
               (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
             VALUES ($1,$2,$3,'WEBHOOK_SECRET',$4)
             ON CONFLICT DO NOTHING`,
            [job.tenantId, job.connectionId, job.id, webhookSecretReference],
          );
        }
        if (
          job.provider === "META" &&
          job.operationType === "DISCONNECT" &&
          requestedWebhookState === "REVOKED"
        ) {
          await client.query(
            `INSERT INTO secret_cleanup_outbox
               (tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
             VALUES ($1,$2,$3,'CONNECTION_CREDENTIAL',$4)
             ON CONFLICT DO NOTHING`,
            [job.tenantId, job.connectionId, job.id, current.secretReference],
          );
        }
      }

      if((job.payload.metaAddAccessActivation as {setupPurpose?:string}|undefined)?.setupPurpose==='ACCOUNT_SUCCESSOR'){
        const promoted=await client.query<{ok:boolean}>('SELECT app.complete_meta_successor_activation($1,$2,$3) AS ok',[job.id,operationLeaseId,job.fencingToken]);
        if(promoted.rows[0]?.ok!==true)throw new ConnectionOperationLeaseLostError('Successor activation changed during finalization');
      }
      const completed = await client.query(
        "SELECT id FROM app.complete_connection_operation($1, $2, $3, $4::jsonb)",
        [job.id, operationLeaseId, job.fencingToken, JSON.stringify(completion.result)],
      );
      if (completed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
      if (job.operationType === "PROVISION" && completion.result.metaSignupReady === true) {
        await client.query("SELECT app.queue_meta_coexistence($1)", [job.id]);
      }
    });
  }

  async fail(
    job: ConnectionOperationJob,
    operationLeaseId: string,
    sessionLease: ProviderSessionLease | undefined,
    failure: OperationFailure,
  ): Promise<void> {
    if (job.operationType === "SYNC_META_APP") return this.finishCoexistence(job, operationLeaseId, sessionLease);
    await this.tenant(job.tenantId, async (client) => {
      await this.lockOperationFence(client, job, operationLeaseId);
      const current = await this.lockConnection(client,job);
      if (!current.metaBindingCurrent) {
        await this.releaseSupersededMetaLease(client, job, sessionLease);
        const failed = await client.query("SELECT id FROM app.fail_connection_operation($1,$2,$3,$4,$5,$6,$7)",
          [job.id, operationLeaseId, job.fencingToken, false, failure.code.slice(0,100),
            `Superseded Meta connection: ${failure.safeError}`.slice(0,500), null]);
        if (failed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
        return;
      }
      if (sessionLease) {
        await this.lockSessionFence(client, job, sessionLease);
        const released = await client.query(
          `UPDATE provider_sessions
              SET worker_id = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE tenant_id = $1
              AND connection_id = $2
              AND id = $3
              AND ownership_state = 'ACTIVE'
              AND worker_id = $4
              AND fencing_token = $5
              AND lease_expires_at >= now()
              AND ($6::uuid IS NULL OR waha_worker_id = $6)
              AND ($7::bigint IS NULL OR assignment_fencing_token = $7)
              AND ($8::timestamptz IS NULL OR assignment_lease_expires_at >= now())`,
          [
            job.tenantId,
            job.connectionId,
            sessionLease.id,
            sessionLease.workerIdentity,
            sessionLease.fencingToken,
            sessionLease.wahaAssignment?.workerId ?? null,
            sessionLease.wahaAssignment?.fencingToken ?? null,
            sessionLease.wahaAssignment?.leaseExpiresAt ?? null,
          ],
        );
        if (released.rowCount !== 1) throw new ConnectionOperationLeaseLostError("Provider session lease was lost during failure finalization");
      }

      const connection = await client.query(
        `UPDATE connections
            SET state = CASE WHEN $5 THEN state ELSE $1 END,
                action_reason = CASE WHEN $5 THEN action_reason ELSE $2 END,
                updated_at = now()
          WHERE tenant_id = $3
            AND id = $4`,
        [failure.connectionState, failure.safeError.slice(0, 500), job.tenantId, job.connectionId, job.operationType === "SYNC_GROUPS"],
      );
      if (connection.rowCount !== 1) throw new ConnectionOperationLeaseLostError("Connection was removed during failure finalization");

      const failed = await client.query(
        "SELECT id FROM app.fail_connection_operation($1, $2, $3, $4, $5, $6, $7)",
        [
          job.id,
          operationLeaseId,
          job.fencingToken,
          failure.retryable,
          failure.code.slice(0, 100),
          failure.safeError.slice(0, 500),
          failure.retryAt ?? null,
        ],
      );
      if (failed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
    });
  }

  /** Diagnostics own only their operation lease, never provider lifecycle ownership. */
  async guardMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string, appId: string) {
    return this.tenant(job.tenantId, async client => {
      const active = (await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0]?.active === true;
      await this.lockOperationFence(client, job, leaseId);
      const state = active ? await this.metaBillingDiagnosticState(client, job, appId) : "HELD";
      if (state === "CURRENT") await client.query(`UPDATE connection_operations
        SET lease_expires_at=now()+interval '60 seconds' WHERE tenant_id=$1 AND id=$2`, [job.tenantId, job.id]);
      return state;
    });
  }

  async completeMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string, appId: string, result: MetaBillingDiagnostic, funding?:MetaAccountFundingProof) {
    await this.tenant(job.tenantId, async client => {
      const active = (await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0]?.active === true;
      await this.lockOperationFence(client, job, leaseId);
      const current = active ? await this.metaBillingDiagnosticState(client, job, appId) : "HELD";
      const diagnostic = current === "CURRENT" ? result : unavailableMetaBillingDiagnostic(current === "CHANGED" ? "BINDING_CHANGED" : "ACCESS_HELD");
      if(!funding&&job.payload.metaAccountPolicy&&current!=="CHANGED"){
        const binding=job.payload.metaBillingDiagnostic as {wabaId:string};
        funding=metaAccountFundingProof(binding.wabaId,null,null).funding;
      }
      // Persist the historical read receipt before deriving current readiness.
      // Both remain atomic; a lease loss rolls back the entire transaction.
      const completed = await client.query("SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)",
        [job.id, leaseId, job.fencingToken, JSON.stringify({ metaBillingDiagnostic: diagnostic,...(funding?{metaAccountFundingProof:funding}:{}) })]);
      if (completed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
      if(current!=='CHANGED' && funding && job.payload.metaAccountPolicy && (current==='CURRENT'||funding.status==='UNAVAILABLE')) {
        const policy=job.payload.metaAccountPolicy as {accountId:string;bindingId:string;bindingRevision:number;authorityRevision:number;policyVersionId:string;observationOperationId:string|null};
        const binding=job.payload.metaBillingDiagnostic as {wabaId:string};
        if(funding.accountId!==binding.wabaId || funding.schemaVersion!==1 || funding.actualPayer!=='UNVERIFIED'
          || !Number.isFinite(Date.parse(funding.observedAt)) || Date.parse(funding.expiresAt)<=Date.now())throw new Error('Meta account read evidence is unavailable');
        // The fresh operation captures both revisions. Late reads cannot clear a newer hold.
        await client.query(`UPDATE meta_messaging_accounts account SET observed_owner_business_id=$1,
          funding_status=$2,primary_funding_id=$3,funding_response_sha256=$4,funding_observed_at=$5,funding_expires_at=$6,
          last_observation_operation_id=$7,state=CASE WHEN $2='PRESENT' AND app.meta_account_payment_ready(account.id,$3) THEN 'READY' ELSE 'HELD' END,
          active_policy_version_id=CASE WHEN $2='PRESENT' AND app.meta_account_payment_ready(account.id,$3) THEN $8::uuid ELSE active_policy_version_id END,
          authority_revision=authority_revision+CASE WHEN funding_response_sha256 IS DISTINCT FROM $4 OR state IS DISTINCT FROM CASE WHEN $2='PRESENT' AND app.meta_account_payment_ready(account.id,$3) THEN 'READY' ELSE 'HELD' END OR ($2='PRESENT' AND app.meta_account_payment_ready(account.id,$3) AND active_policy_version_id IS DISTINCT FROM $8::uuid) THEN 1 ELSE 0 END,updated_at=now()
          WHERE tenant_id=$9 AND id=$10 AND authority_revision=$11 AND requested_policy_version_id=$8 AND state<>'RETIRED' AND last_observation_operation_id IS NOT DISTINCT FROM $15::uuid
            AND EXISTS(SELECT 1 FROM meta_connection_account_bindings b WHERE b.tenant_id=account.tenant_id AND b.account_id=account.id AND b.id=$12 AND b.connection_id=$13 AND b.revision=$14 AND b.state='ACTIVE')`,
          [funding.observedOwnerBusinessId,funding.status,funding.primaryFundingId,funding.responseSha256,funding.observedAt,funding.expiresAt,
            job.id,policy.policyVersionId,job.tenantId,policy.accountId,policy.authorityRevision,policy.bindingId,job.connectionId,policy.bindingRevision,policy.observationOperationId]);
      }
    });
  }

  async failMetaBillingDiagnostic(job: ConnectionOperationJob, leaseId: string, failure: OperationFailure, appId=process.env.META_APP_ID??'') {
    await this.tenant(job.tenantId, async client => {
      const active=(await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0]?.active===true;
      await this.lockOperationFence(client, job, leaseId);
      const current=active?await this.metaBillingDiagnosticState(client,job,appId):"HELD";
      const policy=job.payload.metaAccountPolicy as {accountId:string;bindingId:string;bindingRevision:number;authorityRevision:number;policyVersionId:string;observationOperationId:string|null}|undefined;
      const binding=job.payload.metaBillingDiagnostic as {wabaId:string};
      const funding=policy?metaAccountFundingProof(binding.wabaId,null,null).funding:undefined;
      if(funding)await client.query(`UPDATE connection_operations SET result=jsonb_build_object('metaBillingDiagnostic',$1::jsonb,'metaAccountFundingProof',$2::jsonb)
        WHERE tenant_id=$3 AND id=$4`,[JSON.stringify(unavailableMetaBillingDiagnostic(current==='CHANGED'?'BINDING_CHANGED':'READ_UNAVAILABLE')),JSON.stringify(funding),job.tenantId,job.id]);
      const failed = await client.query("SELECT id FROM app.fail_connection_operation($1,$2,$3,$4,$5,$6,$7)",
        // An enrolled read outcome is immutable. A fresh explicit observation
        // restores readiness; retry must not overwrite this unavailable receipt.
        [job.id, leaseId, job.fencingToken, policy?false:failure.retryable, failure.code.slice(0,100), failure.safeError.slice(0,500), failure.retryAt ?? null]);
      if (failed.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
      if(policy&&funding&&current!=='CHANGED')await client.query(`UPDATE meta_messaging_accounts account SET
        observed_owner_business_id=NULL,funding_status='UNAVAILABLE',primary_funding_id=NULL,funding_response_sha256=$1,
        funding_observed_at=$2,funding_expires_at=$3,last_observation_operation_id=$4,state='HELD',
        authority_revision=authority_revision+CASE WHEN state<>'HELD' OR funding_status<>'UNAVAILABLE' OR funding_response_sha256 IS DISTINCT FROM $1 THEN 1 ELSE 0 END,updated_at=now()
        WHERE tenant_id=$5 AND id=$6 AND authority_revision=$7 AND requested_policy_version_id=$8 AND state<>'RETIRED' AND last_observation_operation_id IS NOT DISTINCT FROM $12::uuid
          AND EXISTS(SELECT 1 FROM meta_connection_account_bindings b WHERE b.tenant_id=account.tenant_id AND b.account_id=account.id AND b.id=$9 AND b.connection_id=$10 AND b.revision=$11 AND b.state='ACTIVE')`,
        [funding.responseSha256,funding.observedAt,funding.expiresAt,job.id,job.tenantId,policy.accountId,policy.authorityRevision,policy.policyVersionId,policy.bindingId,job.connectionId,policy.bindingRevision,policy.observationOperationId]);
    });
  }

  private async metaBillingDiagnosticState(client: PoolClient, job: ConnectionOperationJob, appId: string): Promise<"CURRENT" | "HELD" | "CHANGED"> {
    if (job.operationType !== "VERIFY_META_BILLING" || job.provider !== "META") return "HELD";
    const privacy = (await client.query<{ clear: boolean }>(`SELECT
      pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||$1::text,0))
      AND NOT EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=$1::uuid AND job_type='DELETE'
        AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) AS clear`, [job.tenantId])).rows[0];
    if (privacy?.clear !== true) return "HELD";
    const connection = (await client.query<{state: string; secret_reference: string}>(`SELECT state,secret_reference
      FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' FOR SHARE`, [job.tenantId, job.connectionId])).rows[0];
    const sessions = (await client.query<{id:string;opaque_session_id:string;state:string;provider_state_data:Record<string,unknown>}>(`SELECT id,opaque_session_id,state,provider_state_data
      FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR SHARE`, [job.tenantId, job.connectionId])).rows;
    if (!connection || sessions.length !== 1) return "CHANGED";
    const session = sessions[0]!;
    const binding = metaBillingDiagnosticBinding(connection.secret_reference, {id:session.id,opaqueSessionId:session.opaque_session_id,providerStateData:session.provider_state_data}, appId);
    if (metaLifecyclePayloadSha256(binding) !== metaLifecyclePayloadSha256(job.payload.metaBillingDiagnostic ?? null)) return "CHANGED";
    if(job.payload.metaAccountPolicy){
      const policy=job.payload.metaAccountPolicy as {accountId:string;bindingId:string;bindingRevision:number;authorityRevision:number;policyVersionId:string;observationOperationId:string|null};
      const current=await client.query(`SELECT 1 FROM meta_connection_account_bindings b JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
        WHERE b.tenant_id=$1 AND b.connection_id=$2 AND b.id=$3 AND b.revision=$4 AND b.state='ACTIVE'
          AND a.id=$5 AND a.authority_revision=$6 AND a.requested_policy_version_id=$7 AND a.state<>'RETIRED' AND a.last_observation_operation_id IS NOT DISTINCT FROM $8::uuid FOR SHARE OF b`,
        [job.tenantId,job.connectionId,policy.bindingId,policy.bindingRevision,policy.accountId,policy.authorityRevision,policy.policyVersionId,policy.observationOperationId]);
      if(current.rowCount!==1)return 'CHANGED';
    }
    if (!["WORKING","PAUSED"].includes(connection.state) || !["WORKING","PAUSED"].includes(session.state) || binding.lifecycleRevision === null) return "HELD";
    const route = (await client.query<{state:string}>("SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' FOR SHARE", [job.tenantId,job.connectionId])).rows;
    if (route.length !== 1 || !["ACTIVE","PAUSED"].includes(route[0]!.state)) return "HELD";
    const proof = session.provider_state_data.metaAccountProof as Record<string,unknown> | undefined;
    if (!metaBillingDiagnosticProofCurrent(binding,proof,job)) return "HELD";
    const guards = (await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>("SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
      [job.connectionId,session.id,session.opaque_session_id,binding.wabaId,appId,binding.lifecycleRevision])).rows;
    return guards.length === 1 && guards[0]!.revision_matches && !guards[0]!.blocked && !guards[0]!.unresolved_hold ? "CURRENT" : "HELD";
  }

  async guardMetaTransitionPreview(job:ConnectionOperationJob,leaseId:string,appId:string):Promise<MetaTransitionReadFrame>{
    return this.tenant(job.tenantId,async client=>{
      const frame=await this.metaTransitionReadFrame(client,job,appId);
      await this.lockOperationFence(client,job,leaseId);
      await client.query("UPDATE connection_operations SET lease_expires_at=now()+interval '120 seconds' WHERE tenant_id=$1 AND id=$2",[job.tenantId,job.id]);
      return frame;
    });
  }

  private async metaTransitionReadFrame(client:PoolClient,job:ConnectionOperationJob,appId:string):Promise<MetaTransitionReadFrame>{
    const p=job.payload.metaAccountTransition as {id?:unknown;revision?:unknown;accountId?:unknown;accountRevision?:unknown;bindingId?:unknown;bindingRevision?:unknown;scopeSha256?:unknown;appId?:unknown}|undefined;
    if(job.operationType!=='PREVIEW_META_ACCOUNT_TRANSITION'||job.provider!=='META'||!p||typeof p.id!=='string'||p.appId!==appId)
      throw new ConnectionOperationLeaseLostError();
    // Existing immutable audit attribution is the sole operation actor source.
    const operation=(await client.query<{requested_by_type:string;requested_by_id:string;connection_id:string;operation_type:string}>(
      'SELECT requested_by_type,requested_by_id,connection_id,operation_type FROM connection_operations WHERE tenant_id=$1 AND id=$2',[job.tenantId,job.id])).rows[0];
    if(!operation||operation.requested_by_type!=='USER'||operation.connection_id!==job.connectionId
      ||operation.operation_type!=='PREVIEW_META_ACCOUNT_TRANSITION'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(operation.requested_by_id))
      throw new ConnectionOperationLeaseLostError();
    let context:MetaTransitionContext|null=null;
    const raw=(await client.query<{value:unknown}>('SELECT app.meta_account_transition_context($1,$2,$3) AS value',[job.connectionId,operation.requested_by_id,appId])).rows[0]?.value;
    try{context=metaTransitionContext(raw,{tenantId:job.tenantId,connectionId:job.connectionId,actorId:operation.requested_by_id,appId});}catch{context=null;}
    const plan=(await client.query<{requested_mode:'CUSTOMER'|'WASALX_MANAGED';target_currency:string;initial_account_revision:string;initial_binding_revision:string;
      state:string;revision:string;source_account_id:string;current_observation_operation_id:string}>(
      'SELECT * FROM meta_account_transitions WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[job.tenantId,p.id])).rows[0];
    if(!plan)throw new ConnectionOperationLeaseLostError();
    const current=plan.state!=='CANCELLED'&&plan.current_observation_operation_id===job.id&&Number(plan.revision)===p.revision;
    if(!current||context?.accountId!==plan.source_account_id||context.accountId!==p.accountId||context.accountRevision!==p.accountRevision
      ||context.bindingId!==p.bindingId||context.bindingRevision!==p.bindingRevision||context.scopeSha256!==p.scopeSha256
      ||context.secretReference!==job.connectionSecretReference||context.session.id!==job.providerSession?.id
      ||context.session.opaqueSessionId!==job.providerSession?.opaqueSessionId)context=null;
    return{context,current,revision:Number(plan.revision),request:{requestedMode:plan.requested_mode,targetCurrency:plan.target_currency,
      expectedAccountRevision:Number(plan.initial_account_revision),expectedBindingRevision:Number(plan.initial_binding_revision)}};
  }

  async completeMetaTransitionPreview(job:ConnectionOperationJob,leaseId:string,appId:string,observation:MetaTransitionObservation):Promise<void>{
    await this.tenant(job.tenantId,async client=>{
      const frame=await this.metaTransitionReadFrame(client,job,appId);
      await this.lockOperationFence(client,job,leaseId);
      const projected=frame.context?observation:metaTransitionObservation(frame.request,null,null);
      const result={metaTransitionPreview:projected,...(frame.context?{}:{historicalMetaTransitionPreview:observation})};
      const done=await client.query('SELECT id FROM app.complete_connection_operation($1,$2,$3,$4::jsonb)',[job.id,leaseId,job.fencingToken,JSON.stringify(result)]);
      if(done.rowCount!==1)throw new ConnectionOperationLeaseLostError();
      if(frame.current){const p=job.payload.metaAccountTransition as {id:string};await client.query(`UPDATE meta_account_transitions SET
        state=$1,revision=revision+1,observed_at=$2,expires_at=$3,updated_at=now() WHERE tenant_id=$4 AND id=$5
        AND current_observation_operation_id=$6 AND revision=$7 AND state<>'CANCELLED'`,
        [projected.state,projected.observedAt,projected.expiresAt,job.tenantId,p.id,job.id,frame.revision]);}
    });
  }

  async managedFundingContext(job:ConnectionOperationJob,leaseId:string,appId:string):Promise<ManagedFundingContext>{
    return this.tenant(job.tenantId,async client=>{
      const value=(await client.query<{value:ManagedFundingContext}>("SELECT app.meta_funding_operation_context($1,$2,$3,$4) value",[job.id,leaseId,job.fencingToken,appId])).rows[0]?.value;
      if(!value)throw new ConnectionOperationLeaseLostError();return value;
    });
  }
  async managedFundingCheckpoint(job:ConnectionOperationJob):Promise<FinancialCheckpoint|undefined>{
    return this.tenant(job.tenantId,async client=>{
      const row=(await client.query<{id:string;outcome:FinancialCheckpoint["outcome"];result:FinancialCheckpoint["result"]}>(`SELECT id,outcome,result FROM public.meta_provider_effect_checkpoints
        WHERE tenant_id=$1 AND owner_kind='FUNDING_ATTACHMENT' AND owner_id=$2 AND stage='ATTACH'`,[job.tenantId,(job.payload.metaManagedFunding as {ownerId:string}).ownerId])).rows[0];
      return row?{checkpointId:row.id,outcome:row.outcome,result:row.result}:undefined;
    });
  }
  async resolveFinancialExecution(job:ConnectionOperationJob,context:ManagedFundingContext,candidate:MetaRuntimeEvidenceCandidate|undefined,transportSha:string):Promise<MetaActualRequestExecution>{
    if(!candidate)return{mode:"UNKNOWN",runtimeEvidenceReceiptId:null,runtimeEvidenceSha256:null,transportBindingSha256:null};
    return this.tenant(job.tenantId,async client=>(await client.query<{value:MetaActualRequestExecution}>("SELECT app.resolve_meta_runtime_execution($1,$2,$3,$4,$5,$6) value",
      [job.tenantId,context.accountId,candidate.receiptId,candidate.descriptor,candidate.descriptorSha256,transportSha])).rows[0]!.value);
  }
  async reserveManagedFunding(job:ConnectionOperationJob,leaseId:string,requestSha:string,execution:MetaActualRequestExecution):Promise<FundingReservation>{
    return this.tenant(job.tenantId,async client=>(await client.query<{value:FundingReservation}>("SELECT app.reserve_meta_funding_attachment($1,$2,$3,$4) value",[job.id,leaseId,requestSha,execution])).rows[0]!.value);
  }
  async recordFinancialResponse(job:ConnectionOperationJob,reservation:Extract<FundingReservation,{disposition:"NEW_ATTEMPT"}>,outcome:"SUCCEEDED"|"REJECTED"|"UNKNOWN",result:unknown){
    await this.tenant(job.tenantId,async client=>{
      // Literal produced response projection bytes; distinct from JSONB storage.
      const bytes=JSON.stringify(result),sha=createHash("sha256").update(bytes).digest("hex");
      const ok=(await client.query<{value:boolean}>("SELECT app.record_meta_financial_response($1,$2,$3,$4,$5) value",[reservation.checkpointId,reservation.reservationToken,outcome,bytes,sha])).rows[0]?.value;
      if(ok!==true)throw new Error("Original financial response differs from its retained checkpoint");
    });
  }
  async recordAllocationReadback(job:ConnectionOperationJob,leaseId:string,checkpointId:string,readback:unknown):Promise<boolean>{
    return this.tenant(job.tenantId,async client=>(await client.query<{value:boolean}>("SELECT app.record_meta_allocation_readback($1,$2,$3,$4,$5) value",[job.id,leaseId,job.fencingToken,checkpointId,readback])).rows[0]?.value===true);
  }

  async ready() {
    const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
    return result.rows[0]?.ok === 1;
  }

  async close() {
    await this.pool.end();
  }

  private async lockOperationFence(client: PoolClient, job: ConnectionOperationJob, operationLeaseId: string) {
    if(job.payload.metaAddAccessActivation){
      // Match API admission's tenant/member -> connection -> operation order.
      // A stale actor may still finalize the old job as held, never activate it.
      await client.query("SELECT app.meta_add_access_activation_actor(requested_by_id::uuid) FROM connection_operations WHERE tenant_id=$1 AND id=$2 AND requested_by_type='USER' AND requested_by_id~'^[0-9a-f-]{36}$'",[job.tenantId,job.id]);
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[job.tenantId,job.connectionId]);
    }
    const result = await client.query(
      `SELECT id
         FROM connection_operations
        WHERE tenant_id = $1
          AND id = $2
          AND state = 'RUNNING'
          AND lease_id = $3
          AND fencing_token = $4
          AND lease_expires_at >= now()
        FOR UPDATE`,
      [job.tenantId, job.id, operationLeaseId, job.fencingToken],
    );
    if (result.rowCount !== 1) throw new ConnectionOperationLeaseLostError();
  }

  private async lockConnection(client:PoolClient,job:ConnectionOperationJob){
    const row=(await client.query<{state:ConnectionRuntimeState;secret_reference:string}>(
      "SELECT state,secret_reference FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [job.tenantId,job.connectionId],
    )).rows[0];
    if(!row)throw new ConnectionOperationLeaseLostError("Connection was removed during finalization");
    if (job.provider !== "META") return { state: row.state, secretReference: row.secret_reference, metaBindingCurrent: true };
    const reservation = await client.query("SELECT id FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND reservation_release_id IS NULL FOR SHARE", [job.tenantId,job.connectionId]);
    if (reservation.rowCount !== 1) return { state: row.state, secretReference: row.secret_reference, metaBindingCurrent: false };
    if (!["PAUSE", "DISCONNECT"].includes(job.operationType)) {
      const admission = job.payload.metaAddAccessActivation
        ? await client.query<{held:boolean}>("SELECT NOT app.meta_add_access_activation_current($1,$2,$3::jsonb) AS held",
          [job.id,process.env.META_APP_ID??"",JSON.stringify(metaRoutingRuntime(process.env))])
        : await client.query<{ held: boolean }>("SELECT app.meta_add_access_activation_held($1,$2) AS held", [job.tenantId, job.connectionId]);
      if (admission.rows[0]?.held !== false) return { state: row.state, secretReference: row.secret_reference, metaBindingCurrent: false };
    }
    const session = (await client.query<{id:string;opaque_session_id:string;waba_id:string;proof_matches:boolean;provider_state_data:Record<string,unknown>}>(
      `SELECT id,opaque_session_id,provider_state_data,provider_state_data->>'wabaId' AS waba_id,
        COALESCE(provider_state_data->'metaAccountProof','null'::jsonb)=$3::jsonb AS proof_matches
        FROM provider_sessions WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR UPDATE`,
      [job.tenantId,job.connectionId,JSON.stringify(job.providerSession?.providerStateData.metaAccountProof ?? null)],
    )).rows[0];
    const snapshot = { secretReference: job.connectionSecretReference, providerSessionId: job.providerSession?.id ?? "",
      phoneNumberId: job.providerSession?.opaqueSessionId ?? "", wabaId: String(job.providerSession?.providerStateData.wabaId ?? "") };
    const expected = job.payload.metaBinding as MetaConnectionBinding | undefined;
    const current = session ? { secretReference: row.secret_reference, providerSessionId: session.id,
      phoneNumberId: session.opaque_session_id, wabaId: session.waba_id } : undefined;
    if (["PAUSE", "DISCONNECT"].includes(job.operationType)) return { state: row.state, secretReference: row.secret_reference, providerStateData: session?.provider_state_data,
      metaBindingCurrent: !!current && current.providerSessionId === snapshot.providerSessionId && current.phoneNumberId === snapshot.phoneNumberId && current.wabaId === snapshot.wabaId };
    let lifecycleCurrent=false;
    if(current){
      try{
        const lifecycle=session&&Object.hasOwn(session.provider_state_data,"metaLifecycle")?session.provider_state_data.metaLifecycle:undefined;
        const expectedRevision=operationLifecycleRevision(job);
        if((parseMetaLifecycleState(lifecycle)?.revision??0)===expectedRevision){
          operationLifecycleCandidate(job,lifecycle);
          const guard=(await client.query<{revision_matches:boolean;unresolved_hold:boolean}>(
            "SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
            [job.connectionId,current.providerSessionId,current.phoneNumberId,current.wabaId,process.env.META_APP_ID??"",expectedRevision])).rows;
          lifecycleCurrent=guard.length===1&&guard[0].revision_matches===true&&guard[0].unresolved_hold===false;
        }
      }catch{lifecycleCurrent=false;}
    }
    return { state: row.state, secretReference: row.secret_reference, providerStateData: session?.provider_state_data, metaBindingCurrent: lifecycleCurrent && !!current && session!.proof_matches
      && sameMetaConnectionBinding(snapshot,current) && (!expected || sameMetaConnectionBinding(expected,current))
      && (!job.payload.credentialReference || job.payload.credentialReference === current.secretReference) };
  }

  private async releaseSupersededMetaLease(client:PoolClient,job:ConnectionOperationJob,lease:ProviderSessionLease|undefined){
    if (!lease) return;
    // Release only this operation's lease; a newer credential/proof and another worker's lease remain untouched.
    await client.query(`UPDATE provider_sessions SET worker_id=NULL,lease_expires_at=NULL,updated_at=now()
      WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND worker_id=$4 AND fencing_token=$5`,
      [job.tenantId,job.connectionId,lease.id,lease.workerIdentity,lease.fencingToken]);
  }

  private async lockSessionFence(client: PoolClient, job: ConnectionOperationJob, sessionLease: ProviderSessionLease) {
    const result = await client.query(
      `SELECT id
         FROM provider_sessions
        WHERE tenant_id = $1
          AND connection_id = $2
          AND id = $3
          AND ownership_state = 'ACTIVE'
          AND worker_id = $4
          AND fencing_token = $5
          AND lease_expires_at >= now()
          AND ($6::uuid IS NULL OR waha_worker_id = $6)
          AND ($7::bigint IS NULL OR assignment_fencing_token = $7)
          AND ($8::timestamptz IS NULL OR assignment_lease_expires_at >= now())
        FOR UPDATE`,
      [
        job.tenantId,
        job.connectionId,
        sessionLease.id,
        sessionLease.workerIdentity,
        sessionLease.fencingToken,
        sessionLease.wahaAssignment?.workerId ?? null,
        sessionLease.wahaAssignment?.fencingToken ?? null,
        sessionLease.wahaAssignment?.leaseExpiresAt ?? null,
      ],
    );
    if (result.rowCount !== 1) throw new ConnectionOperationLeaseLostError("Provider session lease was lost");
  }

  private async tenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapWahaAssignment(row: WahaAssignmentRow): WahaWorkerAssignment {
  if (row.engine !== "GOWS" && row.engine !== "NOWEB") {
    throw new Error("Database returned an invalid WAHA worker engine");
  }
  return {
    workerId: row.waha_worker_id,
    workerKey: row.worker_key,
    engine: row.engine,
    baseUrl: validatedPrivateWorkerUrl(row.base_url),
    secretReference: row.secret_reference,
    fencingToken: numericToken(row.assignment_fencing_token),
    leaseExpiresAt: isoTimestamp(row.assignment_lease_expires_at),
  };
}

export function validatedPrivateWorkerUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Database returned an invalid WAHA worker endpoint");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const privateName = hostname === "localhost" || hostname === "::1" ||
    hostname.endsWith(".internal") || hostname.endsWith(".local") ||
    hostname.endsWith(".svc") || hostname.endsWith(".svc.cluster.local") ||
    (!hostname.includes(".") && /^[a-z0-9][a-z0-9-]*$/.test(hostname));
  const parts = hostname.split(".").map(Number);
  const privateIpv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
      (parts[0] === 192 && parts[1] === 168));
  const privateIpv6 = hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || !(privateName || privateIpv4 || privateIpv6)) {
    throw new Error("Database returned an unsafe WAHA worker endpoint");
  }
  return url.toString();
}

function duplicateCleanupWorkerId(job: ConnectionOperationJob) {
  if (job.operationType !== "DISCONNECT" || job.payload.reason !== "DUPLICATE_IDENTITY") return undefined;
  const value = job.payload.pinnedWahaWorkerId;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new WahaWorkerAssignmentUnavailableError();
  }
  return value;
}

function mapOperationRow(row: OperationRow): ConnectionOperationJob {
  const session = row.provider_session_id && row.opaque_session_id && row.provider_session_state
    ? {
        id: row.provider_session_id,
        opaqueSessionId: row.opaque_session_id,
        state: row.provider_session_state,
        fencingToken: numericToken(row.provider_session_fencing_token ?? 0),
        providerStateData: row.provider_session_state_data ?? {},
      }
    : undefined;
  const route = row.webhook_route_id && row.webhook_route_state && row.webhook_hmac_secret_reference
    ? {
        id: row.webhook_route_id,
        state: row.webhook_route_state,
        hmacSecretReference: row.webhook_hmac_secret_reference,
      }
    : undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    operationType: row.operation_type,
    payload: row.payload ?? {},
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    fencingToken: numericToken(row.fencing_token),
    provider: row.provider,
    connectionState: row.connection_state,
    connectionSecretReference: row.connection_secret_reference,
    disclosureVersion: row.disclosure_version,
    ...(row.engine ? { engine: row.engine } : {}),
    ...(session ? { providerSession: session } : {}),
    ...(route ? { webhookRoute: route } : {}),
  };
}

export async function synchronizeGroups(client: PoolClient, job: ConnectionOperationJob, groups: ProviderGroup[]) {
  const configuredScope = parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST);
  if (job.provider === "META" && configuredScope !== undefined) {
    if (groups.length) throw new ProviderError("Meta group is outside the configured test scope", false, "META_TEST_RECIPIENT_NOT_ALLOWED");
    return; // An excluded directory must not mark existing group rows stale.
  }
  const scope = job.provider === "WAHA" ? configuredScope : undefined;
  const scopedGroupIds = scope === undefined ? undefined : [...scope].filter(id => id.endsWith("@g.us"));
  if (scope !== undefined && groups.some(group => !group.id.endsWith("@g.us") || !wahaTestRecipientAllowed(scope, group.id))) {
    throw new ProviderError("WAHA group is outside the configured test scope", false, "WAHA_TEST_RECIPIENT_NOT_ALLOWED");
  }
  if (scope !== undefined && groups.some(group => group.participantRoster !== undefined)) {
    throw new ProviderError("WAHA returned unsafe test group metadata", false, "WAHA_TEST_GROUP_METADATA_INVALID");
  }
  if (scopedGroupIds?.length === 0) return;
  // ponytail: one tenant-scoped lock is enough; split it per group only if sync contention is measured.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`group-workspace-consent:${job.tenantId}`]);
  if (job.provider === "WAHA" && groups.length === 0) {
    const configured = (await client.query(
      `SELECT 1
         FROM whatsapp_groups group_record
         LEFT JOIN group_bindings binding
           ON binding.tenant_id=group_record.tenant_id AND binding.whatsapp_group_id=group_record.id
         LEFT JOIN group_workspace_settings workspace
           ON workspace.tenant_id=group_record.tenant_id AND workspace.whatsapp_group_id=group_record.id
        WHERE group_record.tenant_id=$1 AND group_record.connection_id=$2
          ${scopedGroupIds === undefined ? "" : "AND group_record.external_group_id=ANY($3::text[])"}
          AND (group_record.sync_state='ACTIVE' OR binding.id IS NOT NULL OR workspace.capture_enabled)
        LIMIT 1`,
      [job.tenantId, job.connectionId, ...(scopedGroupIds === undefined ? [] : [scopedGroupIds])],
    )).rowCount === 1;
    if (configured) {
      throw new ProviderError(
        "WAHA returned an empty group snapshot for a configured connection",
        true,
        "WAHA_GROUP_SNAPSHOT_EMPTY",
      );
    }
  }
  const captureGroups = scopedGroupIds === undefined ? (await client.query<{id:string;external_group_id:string}>(`SELECT group_record.id,group_record.external_group_id
      FROM tenant_settings tenant
      JOIN whatsapp_groups group_record ON group_record.tenant_id=tenant.tenant_id
      JOIN group_workspace_settings workspace
        ON workspace.tenant_id=group_record.tenant_id AND workspace.whatsapp_group_id=group_record.id
     WHERE tenant.tenant_id=$1 AND tenant.group_workspace_enabled
       AND group_record.connection_id=$2 AND workspace.capture_enabled`,
  [job.tenantId,job.connectionId])).rows : [];
  const captureGroupIds=captureGroups.map(group=>group.id);
  const captureExternalIds=new Set(captureGroups.map(group=>group.external_group_id));
  await client.query(
    `UPDATE whatsapp_groups
        SET sync_state = 'STALE', updated_at = now()
      WHERE tenant_id = $1
        AND connection_id = $2
        ${scopedGroupIds === undefined ? "" : "AND external_group_id=ANY($3::text[])"}`,
    [job.tenantId, job.connectionId, ...(scopedGroupIds === undefined ? [] : [scopedGroupIds])],
  );
  if (groups.length > 0) {
    const payload = groups.map((group) => ({
      external_group_id: group.id,
      display_name: group.name,
      participant_count: group.participants,
      participant_count_known: scopedGroupIds === undefined,
      provider_metadata: group.pictureUrl ? { pictureUrl: group.pictureUrl } : {},
    }));
    await client.query(
      `INSERT INTO whatsapp_groups (
       tenant_id, connection_id, external_group_id, display_name,
       participant_count, participant_count_known, provider_metadata, last_synced_at, sync_state, updated_at
     )
     SELECT $1,
            $2,
            discovered.external_group_id,
            discovered.display_name,
            CASE WHEN discovered.participant_count_known THEN discovered.participant_count ELSE 0 END,
            discovered.participant_count_known,
            discovered.provider_metadata,
            now(),
            'ACTIVE',
            now()
       FROM jsonb_to_recordset($3::jsonb) AS discovered(
         external_group_id text,
         display_name text,
         participant_count integer,
         participant_count_known boolean,
         provider_metadata jsonb
       )
     ON CONFLICT (connection_id, external_group_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           participant_count = CASE WHEN EXCLUDED.participant_count_known
                                    THEN EXCLUDED.participant_count
                                    ELSE whatsapp_groups.participant_count END,
           participant_count_known = EXCLUDED.participant_count_known,
           provider_metadata = EXCLUDED.provider_metadata,
           last_synced_at = EXCLUDED.last_synced_at,
           sync_state = 'ACTIVE',
           updated_at = now()`,
      [job.tenantId, job.connectionId, JSON.stringify(payload)],
    );
  }
  if (scopedGroupIds !== undefined) return;
  await client.query(
    `DELETE FROM group_workspace_participants participant
      USING whatsapp_groups group_record
      WHERE participant.tenant_id=$1
        AND participant.whatsapp_group_id=group_record.id
        AND group_record.tenant_id=$1
        AND group_record.connection_id=$2
        AND (group_record.sync_state='STALE' OR NOT (group_record.id=ANY($3::uuid[])))`,
    [job.tenantId,job.connectionId,captureGroupIds],
  );
  const rosterGroups = groups.filter((group) => group.participantRoster !== undefined && captureExternalIds.has(group.id));
  if (rosterGroups.length === 0) return;
  const roster = rosterGroups.flatMap((group) => (group.participantRoster ?? []).map((participant) => ({
    external_group_id: group.id,
    external_participant_id: participant.id,
    normalized_phone: participant.normalizedPhone ?? null,
    display_name: participant.displayName ?? null,
  })));
  await client.query(
    `WITH synchronized_group AS (
       SELECT group_record.id,group_record.external_group_id
         FROM whatsapp_groups group_record
        WHERE group_record.tenant_id=$1
          AND group_record.connection_id=$2
          AND group_record.id=ANY($5::uuid[])
          AND group_record.external_group_id=ANY($3::text[])
     ), synchronized_participant AS (
       SELECT synchronized_group.id AS whatsapp_group_id,member.external_participant_id,
              member.normalized_phone,member.display_name
         FROM jsonb_to_recordset($4::jsonb) AS member(
           external_group_id text,external_participant_id text,normalized_phone text,display_name text
         )
         JOIN synchronized_group ON synchronized_group.external_group_id=member.external_group_id
     ), removed AS (
       DELETE FROM group_workspace_participants current
        USING synchronized_group
        WHERE current.tenant_id=$1
          AND current.whatsapp_group_id=synchronized_group.id
          AND NOT EXISTS (
            SELECT 1 FROM synchronized_participant next
             WHERE next.whatsapp_group_id=current.whatsapp_group_id
               AND next.external_participant_id=current.external_participant_id
          )
     )
     INSERT INTO group_workspace_participants
       (tenant_id,whatsapp_group_id,external_participant_id,normalized_phone,display_name,synchronized_at)
     SELECT $1,participant.whatsapp_group_id,participant.external_participant_id,
            participant.normalized_phone,participant.display_name,now()
       FROM synchronized_participant participant
     ON CONFLICT (tenant_id,whatsapp_group_id,external_participant_id) DO UPDATE
       SET normalized_phone=EXCLUDED.normalized_phone,
           display_name=COALESCE(EXCLUDED.display_name,group_workspace_participants.display_name),
           synchronized_at=EXCLUDED.synchronized_at`,
    [job.tenantId,job.connectionId,rosterGroups.map((group) => group.id),JSON.stringify(roster),captureGroupIds],
  );
}

function numericToken(value: string | number) {
  const token = Number(value);
  if (!Number.isSafeInteger(token) || token < 0) throw new Error("Database returned an invalid fencing token");
  return token;
}

function isoTimestamp(value: Date | string) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Database returned an invalid lease expiry");
  return timestamp.toISOString();
}

function assertLeaseDuration(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Lease duration must be between 1 and 300 seconds");
}

// Missing admission revision belongs only to legacy revision-zero jobs, not a fresh claim revision.
function operationLifecycleRevision(job:ConnectionOperationJob){
  const revision=job.payload.metaLifecycleExpectedRevision??0;
  if(typeof revision!=="number"||!Number.isSafeInteger(revision)||revision<0)throw new Error("Meta lifecycle admission is invalid");
  return revision;
}
function operationLifecycleCandidate(job:ConnectionOperationJob,lifecycle:unknown){
  const revision=operationLifecycleRevision(job);
  if((parseMetaLifecycleState(lifecycle)?.revision??0)!==revision)throw new Error("Meta lifecycle admission changed");
  const recovery=job.payload.metaLifecycleRecovery as {expectedRevision?:unknown;reasons?:unknown}|undefined;
  if(!recovery){assertMetaLifecycleAccess(lifecycle);return parseMetaLifecycleState(lifecycle);}
  if(!["START","RESTART"].includes(job.operationType)||job.payload.sourceOperationId||recovery.expectedRevision!==revision
    ||!Array.isArray(recovery.reasons)||Object.keys(recovery).some(key=>!["expectedRevision","reasons"].includes(key)))throw new Error("Meta lifecycle recovery is invalid");
  const reasons=metaLifecycleBlockingReasons(lifecycle);
  if(JSON.stringify(recovery.reasons)!==JSON.stringify(reasons))throw new Error("Every Meta lifecycle blocker must be recovered");
  const candidate=recoverMetaLifecycleReasons(lifecycle,revision,reasons as MetaLifecycleReason[]);
  assertMetaLifecycleAccess(candidate);
  return candidate;
}
