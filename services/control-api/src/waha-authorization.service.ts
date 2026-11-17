import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import type { AuthenticatedRequest } from "./types.js";
import {
  normalizeInternationalPhone,
  sanitizedPasskeyAssertion,
  WahaAuthorizationClientFactory,
  WahaAuthorizationProviderError,
  type WahaAuthorizationClient,
  type WahaPasskeyAssertion,
} from "./waha-authorization.client.js";
import {
  WahaAdminSecretError,
  WahaAdminSecretService,
} from "./waha-admin-secret.service.js";

type AuthorizationStep =
  | "QR"
  | "PAIRING_CODE"
  | "PASSKEY_CHALLENGE"
  | "PASSKEY_ASSERTION"
  | "PASSKEY_CONFIRMATION"
  | "PASSKEY_CONFIRM";

type MutatingAuthorizationStep = Extract<
  AuthorizationStep,
  "PAIRING_CODE" | "PASSKEY_ASSERTION" | "PASSKEY_CONFIRM"
>;

type AuthorizationContext = {
  connectionId: string;
  providerSessionId: string;
  adminSecretReference: string;
  workerBaseUrl: string;
  opaqueSessionId: string;
  wahaWorkerId: string;
  assignmentFencingToken: number;
  providerState: string;
  providerStateData: Record<string, unknown>;
  lastProviderStatusAt: Date | string | null;
};

type AuthorizationContextRow = {
  id: string;
  provider_session_id: string | null;
  provider: string;
  connection_state: string;
  secret_reference: string;
  opaque_session_id: string | null;
  provider_session_state: string | null;
  provider_state: string | null;
  provider_state_data: Record<string, unknown> | null;
  last_provider_status_at: Date | string | null;
  worker_id: string | null;
  lease_expires_at: Date | string | null;
  webhook_state: string | null;
  waha_worker_id: string | null;
  assignment_fencing_token: string | number | null;
  assignment_lease_expires_at: Date | string | null;
  worker_base_url: string | null;
  worker_secret_reference: string | null;
  worker_health_state: string | null;
  worker_lifecycle_state: string | null;
  worker_last_heartbeat_at: Date | string | null;
  worker_heartbeat_ttl_seconds: number | null;
  lifecycle_pending: boolean;
};

type AuthActionRow = {
  id: string;
  connection_id: string;
  action_type: MutatingAuthorizationStep;
  request_sha256: string;
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";
  safe_error: string | null;
  expires_at: Date | string;
};

type Reservation =
  | { kind: "reserved"; action: AuthActionRow; context: AuthorizationContext }
  | { kind: "replay"; action: AuthActionRow };

const EXPECTED_PROVIDER_STATE: Record<AuthorizationStep, string> = {
  QR: "SCAN_QR_CODE",
  PAIRING_CODE: "SCAN_QR_CODE",
  PASSKEY_CHALLENGE: "PASSKEY_REQUIRED",
  PASSKEY_ASSERTION: "PASSKEY_REQUIRED",
  PASSKEY_CONFIRMATION: "PASSKEY_CONFIRMATION_REQUIRED",
  PASSKEY_CONFIRM: "PASSKEY_CONFIRMATION_REQUIRED",
};

@Injectable()
export class WahaAuthorizationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly secrets: WahaAdminSecretService,
    private readonly clients: WahaAuthorizationClientFactory,
  ) {}

  async qr(request: AuthenticatedRequest, connectionId: string) {
    const { context, client } = await this.readClient(
      request.principal.tenantId,
      connectionId,
      "QR",
    );
    try {
      const freshness = wahaQrFreshness(
        context.providerStateData,
        context.lastProviderStatusAt,
      );
      const qr = freshness.expired ? null : await client.getQr();
      await this.auditRead(request, connectionId, "connection.auth_qr_viewed", context.providerState);
      return {
        imageDataUrl: qr ? `data:${qr.mimeType};base64,${qr.data}` : null,
        providerState: context.providerState,
        ...freshness,
      };
    } catch (error) {
      throw authorizationHttpError(error);
    }
  }

  async scanComplete(request: AuthenticatedRequest, connectionId: string) {
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      const session = (
        await client.query<{
          id: string;
          onboarding_scan_acknowledged_at: Date | string | null;
          onboarding_scan_completed_at: Date | string | null;
          onboarding_working_at: Date | string | null;
          onboarding_authorization_method: string | null;
        }>(
          `SELECT session.id,session.onboarding_scan_acknowledged_at,
                  session.onboarding_scan_completed_at,session.onboarding_working_at,
                  session.onboarding_authorization_method
             FROM provider_sessions session
             JOIN connections connection
               ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
            WHERE session.tenant_id=$1 AND session.connection_id=$2
              AND session.ownership_state='ACTIVE' AND connection.provider='WAHA'
              AND session.onboarding_authorization_method='QR'
              AND session.onboarding_qr_ready_at IS NOT NULL
              AND (
                (connection.state='AWAITING_AUTH' AND session.state='AWAITING_AUTH'
                  AND session.provider_state='SCAN_QR_CODE')
                OR
                (connection.state='WORKING' AND session.state='WORKING'
                  AND session.provider_state='WORKING' AND session.onboarding_working_at IS NOT NULL)
              )
            FOR UPDATE OF connection,session`,
          [request.principal.tenantId, connectionId],
        )
      ).rows[0];
      if (!session) {
        throw new ConflictException("The current WhatsApp session cannot accept a scan acknowledgement.");
      }
      const acknowledgedAt = session.onboarding_scan_acknowledged_at ?? (
        await client.query<{ acknowledged_at: Date | string }>(
          `UPDATE provider_sessions
              SET onboarding_scan_acknowledged_at=now(),updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND onboarding_scan_acknowledged_at IS NULL
            RETURNING onboarding_scan_acknowledged_at AS acknowledged_at`,
          [request.principal.tenantId, session.id],
        )
      ).rows[0]?.acknowledged_at;
      if (!acknowledgedAt) throw new ConflictException("The scan acknowledgement could not be recorded.");
      const timingEligible = Boolean(session.onboarding_scan_completed_at);
      const lateAcknowledgement = Boolean(
        session.onboarding_working_at
        && new Date(acknowledgedAt).getTime() > new Date(session.onboarding_working_at).getTime()
      );
      if (!session.onboarding_scan_acknowledged_at) {
        await appendAudit(client, request.principal, {
          action: "connection.auth_scan_completed",
          targetType: "connection",
          targetId: connectionId,
          requestId: String(request.id),
          newValue: {
            acknowledged_at: acknowledgedAt,
            provider_working_at_acknowledgement: Boolean(session.onboarding_working_at),
            ...(session.onboarding_working_at ? { late_acknowledgement: lateAcknowledgement } : {}),
          },
        });
      }
      return {
        recordedAt: acknowledgedAt,
        acknowledgedAt,
        scanCompletedAt: session.onboarding_scan_completed_at,
        providerWorkingAt: session.onboarding_working_at,
        timingEligible,
        lateAcknowledgement,
        duplicate: Boolean(session.onboarding_scan_acknowledged_at),
      };
    });
  }

  async pairingCode(
    request: AuthenticatedRequest,
    connectionId: string,
    idempotencyKey: string | undefined,
    phoneNumber: unknown,
  ) {
    if (typeof phoneNumber !== "string") {
      throw new BadRequestException(
        "A phone number in international format is required.",
      );
    }
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizeInternationalPhone(phoneNumber);
    } catch (error) {
      throw authorizationHttpError(error);
    }
    const result = await this.mutate(
      request,
      connectionId,
      "PAIRING_CODE",
      idempotencyKey,
      { phoneNumber: normalizedPhone },
      (client) => client.requestPairingCode(normalizedPhone),
    );
    return { code: result.code };
  }

  async passkeyChallenge(request: AuthenticatedRequest, connectionId: string) {
    const { context, client } = await this.readClient(
      request.principal.tenantId,
      connectionId,
      "PASSKEY_CHALLENGE",
    );
    try {
      const challenge = await client.getPasskeyChallenge();
      await this.auditRead(
        request,
        connectionId,
        "connection.auth_passkey_challenge_viewed",
        context.providerState,
      );
      return challenge;
    } catch (error) {
      throw authorizationHttpError(error);
    }
  }

  async submitPasskey(
    request: AuthenticatedRequest,
    connectionId: string,
    idempotencyKey: string | undefined,
    assertion: unknown,
  ) {
    let sanitized: WahaPasskeyAssertion;
    try {
      sanitized = sanitizedPasskeyAssertion(assertion);
    } catch (error) {
      throw authorizationHttpError(error);
    }
    return this.mutate(
      request,
      connectionId,
      "PASSKEY_ASSERTION",
      idempotencyKey,
      sanitized,
      (client) => client.submitPasskey(sanitized),
      { accepted: true },
    );
  }

  async passkeyConfirmation(
    request: AuthenticatedRequest,
    connectionId: string,
  ) {
    const { context, client } = await this.readClient(
      request.principal.tenantId,
      connectionId,
      "PASSKEY_CONFIRMATION",
    );
    try {
      const confirmation = await client.getPasskeyConfirmation();
      await this.auditRead(
        request,
        connectionId,
        "connection.auth_passkey_confirmation_viewed",
        context.providerState,
      );
      return confirmation;
    } catch (error) {
      throw authorizationHttpError(error);
    }
  }

  async confirmPasskey(
    request: AuthenticatedRequest,
    connectionId: string,
    idempotencyKey: string | undefined,
  ) {
    return this.mutate(
      request,
      connectionId,
      "PASSKEY_CONFIRM",
      idempotencyKey,
      {},
      (client) => client.confirmPasskey(),
      { confirmed: true },
    );
  }

  private async readClient(
    tenantId: string,
    connectionId: string,
    step: AuthorizationStep,
  ) {
    const context = await this.database.withTenant(tenantId, (client) =>
      selectAuthorizationContext(client, tenantId, connectionId, step),
    );
    let apiKey: string;
    try {
      apiKey = await this.secrets.resolveApiKey(context.adminSecretReference);
    } catch (error) {
      throw authorizationHttpError(error);
    }
    return {
      context,
      client: this.clients.create(apiKey, context.opaqueSessionId, context.workerBaseUrl),
    };
  }

  private async mutate<T extends Record<string, unknown>>(
    request: AuthenticatedRequest,
    connectionId: string,
    step: MutatingAuthorizationStep,
    rawIdempotencyKey: string | undefined,
    input: unknown,
    invoke: (client: WahaAuthorizationClient) => Promise<T>,
    replayValue?: T,
  ): Promise<T & { duplicate?: true }> {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const requestSha256 = createHash("sha256")
      .update(canonicalJson({ connectionId, step, input }))
      .digest("hex");
    const tenantId = request.principal.tenantId;
    const reservation = await this.database.withTenant(tenantId, async (client) => {
      await markExpiredReservationUnknown(client, tenantId, idempotencyKey);
      const existing = await selectAuthAction(client, tenantId, idempotencyKey);
      if (existing) {
        assertReplay(existing, connectionId, step, requestSha256);
        return { kind: "replay", action: existing } as Reservation;
      }
      const context = await selectAuthorizationContext(
        client,
        tenantId,
        connectionId,
        step,
        true,
      );
      const action = (
        await client.query<AuthActionRow>(
          `INSERT INTO connection_auth_actions
             (tenant_id,connection_id,action_type,idempotency_key,request_sha256)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
           RETURNING id,connection_id,action_type,request_sha256,state,safe_error,expires_at`,
          [tenantId, connectionId, step, idempotencyKey, requestSha256],
        )
      ).rows[0];
      if (!action) {
        const raced = await selectAuthAction(client, tenantId, idempotencyKey);
        if (!raced) throw new Error("Authorization idempotency race was not resolved");
        assertReplay(raced, connectionId, step, requestSha256);
        return { kind: "replay", action: raced } as Reservation;
      }
      return { kind: "reserved", action, context } as Reservation;
    });

    if (reservation.kind === "replay") {
      return replayResult(reservation.action, replayValue);
    }

    let client: WahaAuthorizationClient;
    try {
      const apiKey = await this.secrets.resolveApiKey(
        reservation.context.adminSecretReference,
      );
      client = this.clients.create(apiKey, reservation.context.opaqueSessionId, reservation.context.workerBaseUrl);
    } catch (error) {
      await this.failMutation(
        request,
        reservation.action,
        knownFailure(error),
      );
      throw authorizationHttpError(error);
    }

    let result: T;
    try {
      result = await invoke(client);
    } catch (error) {
      const failure = providerFailure(error);
      await this.failMutation(request, reservation.action, failure);
      throw authorizationHttpError(error);
    }
    try {
      await this.database.withTenant(tenantId, async (databaseClient) => {
        const generation = await databaseClient.query(
          `SELECT 1
             FROM connections connection
             JOIN provider_sessions session
               ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
            WHERE connection.tenant_id=$1 AND connection.id=$2
              AND connection.state='AWAITING_AUTH'
              AND session.id=$3 AND session.ownership_state='ACTIVE'
              AND session.state='AWAITING_AUTH' AND session.provider_state=$7
              AND session.opaque_session_id=$4
              AND session.waha_worker_id=$5 AND session.assignment_fencing_token=$6
              AND session.assignment_lease_expires_at>=now()
              AND NOT EXISTS (
                SELECT 1 FROM connection_operations pending
                 WHERE pending.tenant_id=connection.tenant_id
                   AND pending.connection_id=connection.id
                   AND pending.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
              )
              AND EXISTS (
                SELECT 1 FROM webhook_routes route
                 WHERE route.tenant_id=connection.tenant_id
                   AND route.connection_id=connection.id
                   AND route.provider='WAHA' AND route.state='ACTIVE'
              )
            FOR UPDATE OF connection,session`,
          [
            tenantId,
            connectionId,
            reservation.context.providerSessionId,
            reservation.context.opaqueSessionId,
            reservation.context.wahaWorkerId,
            reservation.context.assignmentFencingToken,
            reservation.context.providerState,
          ],
        );
        if (generation.rowCount !== 1) {
          throw new ConflictException(
            "The authorization session changed before the outcome could be finalized.",
          );
        }
        const completed = await databaseClient.query(
          `UPDATE connection_auth_actions
              SET state='SUCCEEDED',completed_at=now(),updated_at=now()
            WHERE tenant_id=$1 AND id=$2 AND state='RUNNING'`,
          [tenantId, reservation.action.id],
        );
        if (completed.rowCount !== 1) {
          throw new ConflictException(
            "The authorization action outcome could not be finalized safely.",
          );
        }
        const session = await databaseClient.query(
          `UPDATE provider_sessions
              SET onboarding_authorization_method=$3,
                  onboarding_scan_acknowledged_at=NULL,
                  onboarding_scan_completed_at=NULL,
                  updated_at=now()
            WHERE tenant_id=$1 AND connection_id=$2 AND id=$4
              AND ownership_state='ACTIVE' AND opaque_session_id=$5
              AND waha_worker_id=$6 AND assignment_fencing_token=$7`,
          [
            tenantId,
            connectionId,
            step === "PAIRING_CODE" ? "PAIRING_CODE" : "PASSKEY",
            reservation.context.providerSessionId,
            reservation.context.opaqueSessionId,
            reservation.context.wahaWorkerId,
            reservation.context.assignmentFencingToken,
          ],
        );
        if (session.rowCount !== 1) {
          throw new ConflictException(
            "The authorization session changed before the outcome could be finalized.",
          );
        }
        await appendAudit(databaseClient, request.principal, {
          action: `connection.auth_${step.toLowerCase()}_completed`,
          targetType: "connection",
          targetId: connectionId,
          requestId: String(request.id),
          newValue: {
            action_id: reservation.action.id,
            provider_state: reservation.context.providerState,
          },
        });
      });
      return result;
    } catch (error) {
      await this.failMutation(request, reservation.action, {
        state: "OUTCOME_UNKNOWN",
        code: "AUTH_ACTION_FINALIZATION_FAILED",
        safeError:
          "WhatsApp accepted the request, but WasalX could not finalize its status. Refresh the connection before trying again.",
      });
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException(
        "WhatsApp accepted the request, but WasalX could not finalize its status. Refresh the connection before trying again.",
      );
    }
  }

  private async failMutation(
    request: AuthenticatedRequest,
    action: AuthActionRow,
    failure: { state: "FAILED" | "OUTCOME_UNKNOWN"; code: string; safeError: string },
  ) {
    await this.database.withTenant(request.principal.tenantId, async (client) => {
      const failed = await client.query(
        `UPDATE connection_auth_actions
            SET state=$1,error_code=$2,safe_error=$3,completed_at=now(),updated_at=now()
          WHERE tenant_id=$4 AND id=$5 AND state='RUNNING'`,
        [
          failure.state,
          failure.code.slice(0, 100),
          failure.safeError.slice(0, 500),
          request.principal.tenantId,
          action.id,
        ],
      );
      if (failed.rowCount !== 1) return;
      await appendAudit(client, request.principal, {
        action: "connection.auth_action_failed",
        targetType: "connection",
        targetId: action.connection_id,
        requestId: String(request.id),
        newValue: {
          action_id: action.id,
          action_type: action.action_type,
          outcome: failure.state,
          error_code: failure.code.slice(0, 100),
        },
      });
    });
  }

  private async auditRead(
    request: AuthenticatedRequest,
    connectionId: string,
    action: string,
    providerState: string,
  ) {
    await this.database.withTenant(request.principal.tenantId, (client) =>
      appendAudit(client, request.principal, {
        action,
        targetType: "connection",
        targetId: connectionId,
        requestId: String(request.id),
        newValue: { provider_state: providerState },
      }),
    );
  }
}

async function selectAuthorizationContext(
  client: PoolClient,
  tenantId: string,
  connectionId: string,
  step: AuthorizationStep,
  lock = false,
) {
  const row = (
    await client.query<AuthorizationContextRow>(
      `SELECT c.id,c.provider,c.state AS connection_state,c.secret_reference,
              ps.provider_session_id,ps.opaque_session_id,ps.state AS provider_session_state,
              ps.provider_state,ps.provider_state_data,ps.last_provider_status_at,
              ps.worker_id,ps.lease_expires_at,
              ps.waha_worker_id,ps.assignment_fencing_token,ps.assignment_lease_expires_at,
              worker.base_url AS worker_base_url,
              worker.secret_reference AS worker_secret_reference,
              worker.health_state AS worker_health_state,
              worker.lifecycle_state AS worker_lifecycle_state,
              worker.last_heartbeat_at AS worker_last_heartbeat_at,
              worker.heartbeat_ttl_seconds AS worker_heartbeat_ttl_seconds,
              wr.state AS webhook_state,
              EXISTS (
                SELECT 1 FROM connection_operations pending
                 WHERE pending.tenant_id=c.tenant_id
                   AND pending.connection_id=c.id
                   AND pending.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
              ) AS lifecycle_pending
         FROM connections c
         LEFT JOIN LATERAL (
           SELECT candidate.id AS provider_session_id,
                  candidate.opaque_session_id,candidate.state,
                  candidate.provider_state,candidate.provider_state_data,
                  candidate.last_provider_status_at,candidate.worker_id,
                  candidate.lease_expires_at,candidate.waha_worker_id,
                  candidate.assignment_fencing_token,candidate.assignment_lease_expires_at
             FROM provider_sessions candidate
            WHERE candidate.tenant_id=c.tenant_id
              AND candidate.connection_id=c.id
              AND candidate.ownership_state='ACTIVE'
            ORDER BY candidate.created_at DESC,candidate.id DESC
            LIMIT 1
         ) ps ON true
         LEFT JOIN LATERAL app.current_waha_session_runtime(ps.provider_session_id) worker ON true
         LEFT JOIN webhook_routes wr
           ON wr.tenant_id=c.tenant_id
          AND wr.connection_id=c.id
          AND wr.provider=c.provider
        WHERE c.tenant_id=$1 AND c.id=$2${lock ? " FOR UPDATE OF c" : ""}`,
      [tenantId, connectionId],
    )
  ).rows[0];
  if (!row) throw new NotFoundException("Connection not found");
  if (row.provider !== "WAHA") {
    throw new ConflictException(
      "This authorization action is available only for WAHA connections.",
    );
  }
  if (row.connection_state !== "AWAITING_AUTH") {
    throw new ConflictException(
      `WhatsApp authorization is not available while the connection is ${row.connection_state}.`,
    );
  }
  if (row.lifecycle_pending) {
    throw new ConflictException(
      "A connection lifecycle operation is still running. Refresh after it completes.",
    );
  }
  if (row.webhook_state !== "ACTIVE") {
    throw new ConflictException(
      "The connection authorization route is not active.",
    );
  }
  if (!row.provider_session_id || !row.opaque_session_id || !row.provider_session_state) {
    throw new ConflictException(
      "The WhatsApp authorization session is not ready.",
    );
  }
  const workerHeartbeat = row.worker_last_heartbeat_at
    ? new Date(row.worker_last_heartbeat_at).getTime()
    : 0;
  const workerTtlMs = Number(row.worker_heartbeat_ttl_seconds ?? 0) * 1_000;
  if (
    !row.waha_worker_id ||
    !row.worker_base_url ||
    !row.worker_secret_reference ||
    row.worker_health_state !== "HEALTHY" ||
    !["ACTIVE", "DRAINING"].includes(row.worker_lifecycle_state ?? "") ||
    workerHeartbeat + workerTtlMs < Date.now() ||
    row.assignment_fencing_token === null
  ) {
    throw new ServiceUnavailableException(
      "The assigned WhatsApp worker is unavailable. Try again after service health recovers.",
    );
  }
  if (row.provider_session_state !== "AWAITING_AUTH") {
    throw new ConflictException(
      "The WhatsApp authorization session is no longer waiting for authorization.",
    );
  }
  const leaseExpiresAt = row.lease_expires_at
    ? new Date(row.lease_expires_at).getTime()
    : 0;
  if (row.worker_id && leaseExpiresAt > Date.now()) {
    throw new ConflictException(
      "The connection session is busy. Refresh after the current operation completes.",
    );
  }
  const expected = EXPECTED_PROVIDER_STATE[step];
  if (row.provider_state !== expected) {
    throw new ConflictException(
      `The connection currently requires ${humanProviderState(row.provider_state)}. Refresh and use the action shown there.`,
    );
  }
  const assignmentFence = Number(row.assignment_fencing_token);
  if (!Number.isSafeInteger(assignmentFence) || assignmentFence < 1) {
    throw new ServiceUnavailableException("The WhatsApp worker assignment is invalid.");
  }
  const renewed = await client.query(
    `SELECT waha_worker_id
       FROM app.renew_waha_session_assignment(
         (SELECT id FROM provider_sessions
           WHERE tenant_id=$1 AND connection_id=$2 AND opaque_session_id=$3
             AND ownership_state='ACTIVE'),
         $4,$5,interval '90 seconds'
       )`,
    [tenantId, connectionId, row.opaque_session_id, row.waha_worker_id, assignmentFence],
  );
  if (renewed.rowCount !== 1) {
    throw new ServiceUnavailableException(
      "The WhatsApp worker assignment changed. Refresh before trying again.",
    );
  }
  return {
    connectionId: row.id,
    providerSessionId: row.provider_session_id,
    adminSecretReference: row.worker_secret_reference,
    workerBaseUrl: row.worker_base_url,
    opaqueSessionId: row.opaque_session_id,
    wahaWorkerId: row.waha_worker_id,
    assignmentFencingToken: assignmentFence,
    providerState: expected,
    providerStateData: row.provider_state_data ?? {},
    lastProviderStatusAt: row.last_provider_status_at,
  } satisfies AuthorizationContext;
}

export function wahaQrFreshness(
  providerStateData: Record<string, unknown>,
  lastProviderStatusAt: Date | string | null,
  now = Date.now(),
) {
  const rawSequence = Number(providerStateData.qrSequence ?? 1);
  const sequence = Number.isSafeInteger(rawSequence) && rawSequence >= 1
    ? Math.min(rawSequence, 6)
    : 1;
  const issuedAtMs = lastProviderStatusAt
    ? new Date(lastProviderStatusAt).getTime()
    : Number.NaN;
  if (!Number.isFinite(issuedAtMs)) {
    return {
      issuedAt: null,
      expiresAt: null,
      sequence,
      expired: true,
    };
  }
  const expiresAtMs = issuedAtMs + (sequence === 1 ? 60_000 : 20_000);
  return {
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    sequence,
    expired: now >= expiresAtMs,
  };
}

async function selectAuthAction(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
) {
  return (
    await client.query<AuthActionRow>(
      `SELECT id,connection_id,action_type,request_sha256,state,safe_error,expires_at
         FROM connection_auth_actions
        WHERE tenant_id=$1 AND idempotency_key=$2
        FOR UPDATE`,
      [tenantId, idempotencyKey],
    )
  ).rows[0];
}

async function markExpiredReservationUnknown(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
) {
  await client.query(
    `UPDATE connection_auth_actions
        SET state='OUTCOME_UNKNOWN',
            error_code='AUTH_ACTION_RESERVATION_EXPIRED',
            safe_error='The previous authorization request outcome is unknown. Refresh the connection before trying again.',
            completed_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND idempotency_key=$2
        AND state='RUNNING' AND expires_at <= now()`,
    [tenantId, idempotencyKey],
  );
}

function assertReplay(
  action: AuthActionRow,
  connectionId: string,
  step: MutatingAuthorizationStep,
  requestSha256: string,
) {
  if (
    action.connection_id !== connectionId ||
    action.action_type !== step ||
    action.request_sha256 !== requestSha256
  ) {
    throw new ConflictException(
      "Idempotency-Key was already used for a different authorization request.",
    );
  }
}

function replayResult<T extends Record<string, unknown>>(
  action: AuthActionRow,
  replayValue: T | undefined,
) {
  if (action.state === "SUCCEEDED" && replayValue) {
    return { ...replayValue, duplicate: true as const };
  }
  if (action.state === "SUCCEEDED") {
    throw new ConflictException(
      "This pairing-code request already completed. Use the code already shown, or request a replacement with a new Idempotency-Key.",
    );
  }
  if (action.state === "RUNNING") {
    throw new ConflictException(
      "This authorization request is already in progress.",
    );
  }
  throw new ConflictException(
    action.safe_error ??
      "The previous authorization request did not complete safely. Refresh the connection before trying again.",
  );
}

function requireIdempotencyKey(value: string | undefined) {
  if (
    !value ||
    value.length > 255 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    throw new BadRequestException("A valid Idempotency-Key header is required.");
  }
  return value;
}

function providerFailure(error: unknown) {
  if (error instanceof WahaAuthorizationProviderError) {
    return {
      state: error.outcomeKnown ? ("FAILED" as const) : ("OUTCOME_UNKNOWN" as const),
      code: error.code,
      safeError: error.safeError,
    };
  }
  return knownFailure(error);
}

function knownFailure(error: unknown) {
  if (error instanceof WahaAdminSecretError) {
    return {
      state: "FAILED" as const,
      code: error.code,
      safeError: error.safeError,
    };
  }
  return {
    state: "FAILED" as const,
    code: "WAHA_AUTH_INTERNAL",
    safeError: "WhatsApp authorization could not be completed.",
  };
}

function authorizationHttpError(error: unknown) {
  if (error instanceof BadRequestException || error instanceof ConflictException) {
    return error;
  }
  if (error instanceof WahaAdminSecretError) {
    return new ServiceUnavailableException(error.safeError);
  }
  if (error instanceof WahaAuthorizationProviderError) {
    if (
      error.code === "WAHA_AUTH_INVALID_PHONE" ||
      error.code === "WAHA_AUTH_INVALID_ASSERTION"
    ) {
      return new BadRequestException(error.safeError);
    }
    if (error.code === "WAHA_AUTH_STATE_CHANGED") {
      return new ConflictException(error.safeError);
    }
    if (error.retryable) {
      return new ServiceUnavailableException(error.safeError);
    }
    return new BadGatewayException(error.safeError);
  }
  return new ServiceUnavailableException(
    "WhatsApp authorization is temporarily unavailable.",
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function humanProviderState(value: string | null) {
  if (!value) return "a provider state refresh";
  return value.toLowerCase().replaceAll("_", " ");
}
