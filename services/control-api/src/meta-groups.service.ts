import {parseMetaLifecycleState,assertMetaLifecycleAccess} from "@wasalx/core/meta-account-relation";
import {assertMetaCredentialProof} from "@wasalx/core/meta-account-relation";
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
import {
  MetaCredentialError,
  MetaCredentialService,
} from "./meta-credential.service.js";
import {
  MetaGraphClientError,
  MetaGroupsClientFactory,
  type CreateOfficialGroupInput,
  type MetaGroupsControlClient,
  type UpdateOfficialGroupInput,
} from "./meta-groups.client.js";
import type { AuthenticatedRequest } from "./types.js";

type MetaConnectionContext = {
  tenantId: string;
  connectionId: string;
  secretReference: string;
  phoneNumberId: string;
  groupsConsent: boolean;
  disclosureVersion: string | null;
  providerSessionId: string;
  wabaId: string | null;
  proof: unknown;
  lifecycle?: unknown;
  requireWorking: boolean;
};

type MetaContextRow = {
  id: string;
  provider: string;
  state: string;
  secret_reference: string;
  disclosure_version: string | null;
  opaque_session_id: string | null;
  provider_session_state: string | null;
  ownership_state: string | null;
  provider_session_id: string | null;
  waba_id: string | null;
  meta_account_proof: unknown;
  meta_lifecycle: unknown;
  meta_lifecycle_present: boolean;
};

type MetaGroupTarget = {
  id: string;
  external_group_id: string;
  connection_id: string;
};

type MetaGroupActionType = "CREATE_GROUP" | "RESET_INVITE_LINK" | "UPDATE_GROUP";
type MetaGroupActionState = "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTCOME_UNKNOWN";

type MetaGroupActionRow = {
  id: string;
  connection_id: string;
  whatsapp_group_id: string | null;
  external_group_id: string | null;
  action_type: MetaGroupActionType;
  request_sha256: string;
  state: MetaGroupActionState;
  provider_request_id: string | null;
  safe_error: string | null;
  expires_at: Date | string;
};

type Reservation =
  | {
      kind: "reserved";
      action: MetaGroupActionRow;
      context: MetaConnectionContext;
      target?: MetaGroupTarget;
    }
  | { kind: "replay"; action: MetaGroupActionRow };

@Injectable()
export class MetaGroupsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: MetaCredentialService,
    private readonly clients: MetaGroupsClientFactory,
  ) {}

  async capability(request: AuthenticatedRequest, connectionId: string) {
    const context = await this.database.withTenant(request.principal.tenantId, (client) =>
      selectMetaContext(client, request.principal.tenantId, connectionId, false),
    );
    if (!context.groupsConsent) {
      return { eligible: false, state: "CONSENT_REQUIRED", evidence: "local_policy", checkedAt: new Date().toISOString() };
    }
    const client = await this.client(context);
    let result;
    try {
      result = await client.capability();
    } catch (error) {
      throw metaHttpError(error);
    }
    await this.database.withTenant(request.principal.tenantId, async (databaseClient) => {
      if (result.state === "CREDENTIAL_INVALID" && await this.contextCurrent(databaseClient, context)) {
        const reason = "Meta credentials are invalid or expired.";
        const changed = await databaseClient.query(
          `UPDATE connections
              SET state='ACTION_REQUIRED',action_reason=$1,updated_at=now()
            WHERE tenant_id=$2 AND id=$3 AND provider='META'
              AND state NOT IN ('PAUSED','REVOKED') RETURNING id`,
          [reason, request.principal.tenantId, connectionId],
        );
        if (changed.rowCount === 1) await databaseClient.query(
          `UPDATE provider_sessions
              SET state='ACTION_REQUIRED',provider_state='CREDENTIAL_INVALID',updated_at=now()
            WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND ownership_state='ACTIVE'`,
          [request.principal.tenantId, connectionId, context.providerSessionId],
        );
      }
      await appendAudit(databaseClient, request.principal, {
        action: "connection.meta_groups_capability_checked",
        targetType: "connection",
        targetId: connectionId,
        requestId: String(request.id),
        newValue: {
          eligible: result.eligible,
          state: result.state,
          reason_code: result.reasonCode ?? null,
          evidence: result.evidence,
        },
      });
    });
    return result;
  }

  async createGroup(
    request: AuthenticatedRequest,
    connectionId: string,
    idempotencyKey: string | undefined,
    input: CreateOfficialGroupInput,
  ) {
    return this.mutate(
      request,
      connectionId,
      undefined,
      "CREATE_GROUP",
      idempotencyKey,
      input,
      async (client) => {
        await requireEligible(client);
        return client.createGroup(input);
      },
    );
  }

  async getInviteLink(
    request: AuthenticatedRequest,
    connectionId: string,
    groupId: string,
  ) {
    const { context, target } = await this.database.withTenant(
      request.principal.tenantId,
      async (client) => ({
        context: await selectMetaContext(client, request.principal.tenantId, connectionId, true),
        target: await selectGroupTarget(client, request.principal.tenantId, connectionId, groupId),
      }),
    );
    try {
      const result = await (await this.client(context)).getInviteLink(target.external_group_id);
      await this.database.withTenant(request.principal.tenantId, (databaseClient) =>
        appendAudit(databaseClient, request.principal, {
          action: "group.meta_invite_link_viewed",
          targetType: "whatsapp_group",
          targetId: target.id,
          requestId: String(request.id),
          // Invite links are bearer capabilities and must never enter audit.
          newValue: { connection_id: connectionId },
        }),
      );
      return result;
    } catch (error) {
      throw metaHttpError(error);
    }
  }

  async resetInviteLink(
    request: AuthenticatedRequest,
    connectionId: string,
    groupId: string,
    idempotencyKey: string | undefined,
  ) {
    return this.mutate(
      request,
      connectionId,
      groupId,
      "RESET_INVITE_LINK",
      idempotencyKey,
      {},
      async (client, target) => {
        await requireEligible(client);
        return client.resetInviteLink(requiredTarget(target).external_group_id);
      },
    );
  }

  async updateGroup(
    request: AuthenticatedRequest,
    connectionId: string,
    groupId: string,
    idempotencyKey: string | undefined,
    input: UpdateOfficialGroupInput,
  ) {
    return this.mutate(
      request,
      connectionId,
      groupId,
      "UPDATE_GROUP",
      idempotencyKey,
      input,
      async (client, target) => {
        await requireEligible(client);
        return client.updateGroup(requiredTarget(target).external_group_id, input);
      },
    );
  }

  private async mutate<T extends Record<string, unknown>>(
    request: AuthenticatedRequest,
    connectionId: string,
    groupId: string | undefined,
    actionType: MetaGroupActionType,
    rawIdempotencyKey: string | undefined,
    input: unknown,
    invoke: (client: MetaGroupsControlClient, target?: MetaGroupTarget) => Promise<T>,
  ): Promise<T & { duplicate: boolean; actionId: string }> {
    const idempotencyKey = requireIdempotencyKey(rawIdempotencyKey);
    const requestSha256 = createHash("sha256")
      .update(canonicalJson({ connectionId, groupId: groupId ?? null, actionType, input }))
      .digest("hex");
    const tenantId = request.principal.tenantId;
    const reservation = await this.database.withTenant(tenantId, async (client) => {
      await markExpiredUnknown(client, tenantId, idempotencyKey);
      const existing = await selectAction(client, tenantId, idempotencyKey);
      if (existing) {
        assertReplay(existing, connectionId, groupId, actionType, requestSha256);
        return { kind: "replay", action: existing } as Reservation;
      }
      const context = await selectMetaContext(client, tenantId, connectionId, true);
      const target = groupId
        ? await selectGroupTarget(client, tenantId, connectionId, groupId)
        : undefined;
      const action = (
        await client.query<MetaGroupActionRow>(
          `INSERT INTO meta_group_actions
             (tenant_id,connection_id,whatsapp_group_id,external_group_id,action_type,idempotency_key,request_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
           RETURNING id,connection_id,whatsapp_group_id,external_group_id,action_type,
                     request_sha256,state,provider_request_id,safe_error,expires_at`,
          [
            tenantId,
            connectionId,
            target?.id ?? null,
            target?.external_group_id ?? null,
            actionType,
            idempotencyKey,
            requestSha256,
          ],
        )
      ).rows[0];
      if (!action) {
        const raced = await selectAction(client, tenantId, idempotencyKey);
        if (!raced) throw new Error("Meta group idempotency race was not resolved");
        assertReplay(raced, connectionId, groupId, actionType, requestSha256);
        return { kind: "replay", action: raced } as Reservation;
      }
      return { kind: "reserved", action, context, ...(target ? { target } : {}) } as Reservation;
    });

    if (reservation.kind === "replay") {
      return this.replay(request, reservation.action) as unknown as Promise<
        T & { duplicate: boolean; actionId: string }
      >;
    }

    let providerClient: MetaGroupsControlClient;
    try {
      providerClient = await this.client(reservation.context);
    } catch (error) {
      await this.failAction(request, reservation.action, knownFailure(error));
      throw metaHttpError(error);
    }

    let result: T;
    try {
      result = await invoke(providerClient, reservation.target);
    } catch (error) {
      await this.failAction(request, reservation.action, providerFailure(error));
      throw metaHttpError(error);
    }

    try {
      await this.database.withTenant(tenantId, async (client) => {
        const providerRequestId = boundedProviderRequestId(result);
        const completed = await client.query(
          `UPDATE meta_group_actions
              SET state='SUCCEEDED',provider_request_id=$1,completed_at=now(),updated_at=now()
            WHERE tenant_id=$2 AND id=$3 AND state='RUNNING'`,
          [providerRequestId, tenantId, reservation.action.id],
        );
        if (completed.rowCount !== 1) {
          throw new ConflictException("The Meta group action could not be finalized safely.");
        }
        await appendAudit(client, request.principal, {
          action: `group.meta_${actionType.toLowerCase()}_completed`,
          targetType: reservation.target ? "whatsapp_group" : "connection",
          targetId: reservation.target?.id ?? connectionId,
          requestId: String(request.id),
          newValue: {
            action_id: reservation.action.id,
            action_type: actionType,
            provider_request_id: providerRequestId,
          },
        });
      });
    } catch {
      await this.markFinalizationUnknown(request, reservation.action);
      throw new ServiceUnavailableException(
        "Meta accepted the request, but WasalX could not finalize its status. Synchronize groups before trying another mutation.",
      );
    }
    return { ...result, duplicate: false, actionId: reservation.action.id };
  }

  private async replay(request: AuthenticatedRequest, action: MetaGroupActionRow) {
    if (action.state === "RUNNING") {
      throw new ConflictException("This Meta group action is already in progress.");
    }
    if (action.state !== "SUCCEEDED") {
      throw new ConflictException(
        action.safe_error ??
          "The previous Meta group action did not complete safely. Synchronize groups before trying again.",
      );
    }
    if (action.action_type === "CREATE_GROUP") {
      if (!action.provider_request_id) {
        throw new ConflictException("The completed Meta group request is missing its provider request identifier.");
      }
      return {
        requestId: action.provider_request_id,
        duplicate: true,
        actionId: action.id,
      };
    }
    if (action.action_type === "UPDATE_GROUP") {
      return { updated: true, duplicate: true, actionId: action.id };
    }

    const tenantId = request.principal.tenantId;
    const { context, target } = await this.database.withTenant(tenantId, async (client) => ({
      context: await selectMetaContext(client, tenantId, action.connection_id, true),
      target: await selectGroupTarget(
        client,
        tenantId,
        action.connection_id,
        requiredActionGroup(action),
      ),
    }));
    try {
      const result = await (await this.client(context)).getInviteLink(target.external_group_id);
      return { ...result, duplicate: true, actionId: action.id };
    } catch (error) {
      throw metaHttpError(error);
    }
  }

  private async contextCurrent(client:PoolClient,context:MetaConnectionContext){
    await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[context.tenantId,context.connectionId]);
    const rows=(await client.query<{current:boolean}>(`/* meta_api_credential_context_current */
      SELECT c.secret_reference=$3 AND ps.id=$4::uuid AND ps.opaque_session_id=$5
        AND (ps.provider_state_data->>'wabaId') IS NOT DISTINCT FROM $6::text
        AND COALESCE(ps.provider_state_data->'metaAccountProof','null'::jsonb)=$7::jsonb
        AND c.disclosure_version IS NOT DISTINCT FROM $8::text
        AND (NOT $9::boolean OR (c.state='WORKING' AND ps.state='WORKING')) AS current
      FROM connections c JOIN provider_sessions ps ON ps.tenant_id=c.tenant_id AND ps.connection_id=c.id
      WHERE c.tenant_id=$1 AND c.id=$2 AND c.provider='META' AND c.state<>'REVOKED'
        AND ps.ownership_state='ACTIVE' FOR UPDATE OF ps`,
      [context.tenantId,context.connectionId,context.secretReference,context.providerSessionId,context.phoneNumberId,context.wabaId,JSON.stringify(context.proof??null),context.disclosureVersion,context.requireWorking])).rows;
    if(rows.length!==1||rows[0].current!==true)return false;
    let revision:number;
    try{revision=parseMetaLifecycleState(context.lifecycle)?.revision??0;}catch{return false;}
    const guard=(await client.query<{revision_matches:boolean;blocked:boolean;unresolved_hold:boolean}>(
      "SELECT * FROM app.meta_lifecycle_guard($1,$2,$3,$4,$5,$6)",
      [context.connectionId,context.providerSessionId,context.phoneNumberId,context.wabaId,process.env.META_APP_ID??"",revision])).rows;
    return guard.length===1&&guard[0].revision_matches===true&&guard[0].blocked===false&&guard[0].unresolved_hold===false;
  }
  private async client(context: MetaConnectionContext) {
    const accessToken = await this.credentials.resolveAccessToken(context.secretReference,{
      tenantId:context.tenantId,connectionId:context.connectionId,
    });
    const assertProof=()=>{
      try{assertMetaCredentialProof(context.proof,{appId:process.env.META_APP_ID??"",accessToken});}
      catch{throw new MetaGraphClientError("META_CREDENTIAL_PROOF_INVALID","Meta credential proof is invalid or expired.",false,undefined,true);}
    };
    assertProof();
    const beforeRequest=async()=>{
      let current:boolean;
      try{current=await this.database.withTenant(context.tenantId,client=>this.contextCurrent(client,context));}
      catch{throw new MetaGraphClientError("META_CREDENTIAL_CONTEXT_UNAVAILABLE","Meta credential context could not be checked.",true,undefined,true);}
      if(!current)throw new MetaGraphClientError("META_CREDENTIAL_CONTEXT_CHANGED","Meta credential context changed before dispatch.",false,undefined,true);
      assertProof();
      try{assertMetaLifecycleAccess(context.lifecycle);}
      catch{throw new MetaGraphClientError("META_ACCOUNT_LIFECYCLE_HELD","Meta account access requires lifecycle reconciliation.",false,undefined,true);}
    };
    return this.clients.create(accessToken, context.phoneNumberId, beforeRequest);
  }

  private async failAction(
    request: AuthenticatedRequest,
    action: MetaGroupActionRow,
    failure: {
      state: "FAILED" | "OUTCOME_UNKNOWN";
      code: string;
      safeError: string;
    },
  ) {
    await this.database.withTenant(request.principal.tenantId, async (client) => {
      const failed = await client.query(
        `UPDATE meta_group_actions
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
        action: "group.meta_action_failed",
        targetType: action.whatsapp_group_id ? "whatsapp_group" : "connection",
        targetId: action.whatsapp_group_id ?? action.connection_id,
        requestId: String(request.id),
        newValue: {
          action_id: action.id,
          action_type: action.action_type,
          outcome: failure.state,
          error_code: failure.code,
        },
      });
    });
  }

  private async markFinalizationUnknown(request: AuthenticatedRequest, action: MetaGroupActionRow) {
    try {
      await this.failAction(request, action, {
        state: "OUTCOME_UNKNOWN",
        code: "META_ACTION_FINALIZATION_FAILED",
        safeError:
          "Meta accepted the request, but WasalX could not finalize its status. Synchronize groups before trying another mutation.",
      });
    } catch {
      // The RUNNING reservation expires into OUTCOME_UNKNOWN in the next read.
      // Never hide the original safe error with a second database failure.
    }
  }
}

async function selectMetaContext(
  client: PoolClient,
  tenantId: string,
  connectionId: string,
  requireWorking: boolean,
): Promise<MetaConnectionContext> {
  const row = (
    await client.query<MetaContextRow>(
      `SELECT c.id,c.provider,c.state,c.secret_reference,c.disclosure_version,
              ps.id AS provider_session_id,ps.provider_state_data->>'wabaId' AS waba_id,ps.provider_state_data->'metaAccountProof' AS meta_account_proof,
              ps.provider_state_data->'metaLifecycle' AS meta_lifecycle,ps.provider_state_data ? 'metaLifecycle' AS meta_lifecycle_present,
              ps.opaque_session_id,ps.state AS provider_session_state,ps.ownership_state
         FROM connections c
         LEFT JOIN provider_sessions ps
           ON ps.tenant_id=c.tenant_id
          AND ps.connection_id=c.id
          AND ps.ownership_state='ACTIVE'
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [tenantId, connectionId],
    )
  ).rows[0];
  if (!row) throw new NotFoundException("Connection not found.");
  if (row.provider !== "META") throw new ConflictException("This action requires an official Meta Groups connection.");
  if (row.state === "REVOKED" || row.ownership_state !== "ACTIVE" || !row.opaque_session_id || !row.provider_session_id) {
    throw new ConflictException("The official Meta connection is not active.");
  }
  if (requireWorking && (row.state !== "WORKING" || row.provider_session_state !== "WORKING")) {
    throw new ConflictException("The official Meta connection must be working before groups can be managed.");
  }
  if (requireWorking && !row.disclosure_version) {
    throw new ConflictException("Accept the official Groups constraints before managing groups.");
  }
  return {
    tenantId,
    connectionId: row.id,
    secretReference: row.secret_reference,
    phoneNumberId: row.opaque_session_id,
    groupsConsent: Boolean(row.disclosure_version),
    disclosureVersion: row.disclosure_version,
    providerSessionId: row.provider_session_id,
    wabaId: row.waba_id,
    proof: row.meta_account_proof ?? null,
    ...(row.meta_lifecycle_present ? {lifecycle:row.meta_lifecycle} : {}),
    requireWorking,
  };
}

async function selectGroupTarget(
  client: PoolClient,
  tenantId: string,
  connectionId: string,
  groupId: string,
) {
  const target = (
    await client.query<MetaGroupTarget>(
      `SELECT id,external_group_id,connection_id
         FROM whatsapp_groups
        WHERE tenant_id=$1 AND connection_id=$2 AND id=$3`,
      [tenantId, connectionId, groupId],
    )
  ).rows[0];
  if (!target) throw new NotFoundException("Official WhatsApp group not found.");
  return target;
}

async function selectAction(client: PoolClient, tenantId: string, idempotencyKey: string) {
  return (
    await client.query<MetaGroupActionRow>(
      `SELECT id,connection_id,whatsapp_group_id,external_group_id,action_type,
              request_sha256,state,provider_request_id,safe_error,expires_at
         FROM meta_group_actions
        WHERE tenant_id=$1 AND idempotency_key=$2
        FOR UPDATE`,
      [tenantId, idempotencyKey],
    )
  ).rows[0];
}

async function markExpiredUnknown(client: PoolClient, tenantId: string, idempotencyKey: string) {
  await client.query(
    `UPDATE meta_group_actions
        SET state='OUTCOME_UNKNOWN',
            error_code='META_ACTION_RESERVATION_EXPIRED',
            safe_error='The previous Meta group request outcome is unknown. Synchronize groups before trying another mutation.',
            completed_at=now(),updated_at=now()
      WHERE tenant_id=$1 AND idempotency_key=$2
        AND state='RUNNING' AND expires_at <= now()`,
    [tenantId, idempotencyKey],
  );
}

function assertReplay(
  action: MetaGroupActionRow,
  connectionId: string,
  groupId: string | undefined,
  actionType: MetaGroupActionType,
  requestSha256: string,
) {
  if (
    action.connection_id !== connectionId ||
    action.whatsapp_group_id !== (groupId ?? null) ||
    action.action_type !== actionType ||
    action.request_sha256 !== requestSha256
  ) {
    throw new ConflictException("Idempotency-Key was already used for a different Meta group request.");
  }
}

async function requireEligible(client: MetaGroupsControlClient) {
  const capability = await client.capability();
  if (capability.eligible) return;
  if (capability.state === "TEMPORARILY_UNAVAILABLE") {
    throw new MetaGraphClientError(
      capability.reasonCode ?? "META_CAPABILITY_UNAVAILABLE",
      "Meta Groups eligibility could not be verified. No provider mutation was attempted.",
      true,
      undefined,
      true,
    );
  }
  throw new MetaGraphClientError(
    capability.reasonCode ?? "META_GROUPS_NOT_ELIGIBLE",
    "This number is not currently eligible for the official Meta Groups API.",
    false,
    undefined,
    true,
  );
}

function providerFailure(error: unknown) {
  if (error instanceof MetaGraphClientError) {
    return {
      state: error.outcomeKnown ? ("FAILED" as const) : ("OUTCOME_UNKNOWN" as const),
      code: error.code,
      safeError: error.outcomeKnown
        ? error.safeError
        : "The Meta request outcome is unknown. Synchronize groups before trying another mutation.",
    };
  }
  return knownFailure(error);
}

function knownFailure(error: unknown) {
  if (error instanceof MetaGraphClientError) {
    return { state: "FAILED" as const, code: error.code, safeError: error.safeError };
  }
  if (error instanceof MetaCredentialError) {
    return { state: "FAILED" as const, code: error.code, safeError: error.safeError };
  }
  return {
    state: "FAILED" as const,
    code: "META_GROUP_ACTION_INTERNAL",
    safeError: "The Meta group action could not be completed.",
  };
}

function metaHttpError(error: unknown) {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException ||
    error instanceof ServiceUnavailableException
  ) {
    return error;
  }
  if (error instanceof MetaCredentialError) {
    return new ServiceUnavailableException(error.safeError);
  }
  if (error instanceof MetaGraphClientError) {
    if (error.code === "META_INVALID_REQUEST") return new BadRequestException(error.safeError);
    if (
      error.code === "META_CREDENTIAL_PROOF_INVALID" ||
      error.code === "META_CREDENTIAL_CONTEXT_CHANGED" ||
      error.code === "META_AUTHENTICATION_FAILED" ||
      error.code === "META_PERMISSION_REQUIRED" ||
      error.code === "META_GROUPS_UNAVAILABLE" ||
      error.code === "META_GROUPS_NOT_ELIGIBLE"
    ) {
      return new ConflictException(error.safeError);
    }
    if (!error.outcomeKnown) {
      return new ServiceUnavailableException(
        "The Meta request outcome is unknown. Synchronize groups before trying another mutation.",
      );
    }
    if (error.retryable) return new ServiceUnavailableException(error.safeError);
    return new BadGatewayException(error.safeError);
  }
  return new ServiceUnavailableException("Meta Groups is temporarily unavailable.");
}

function requiredTarget(value: MetaGroupTarget | undefined) {
  if (!value) throw new Error("Meta group target is unavailable");
  return value;
}

function requiredActionGroup(action: MetaGroupActionRow) {
  if (!action.whatsapp_group_id) throw new Error("Meta group action target is unavailable");
  return action.whatsapp_group_id;
}

function boundedProviderRequestId(result: Record<string, unknown>) {
  const value = result.requestId;
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
