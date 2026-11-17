import { createHash } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { can } from "./rbac.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import type { AuthenticatedRequest } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DetachInput = { expectedVersion?: number; confirmation?: string };
type CorrelationRow = {
  id: string;
  normalized_reference: string;
  zammad_ticket_id: string;
  zammad_ticket_number: string;
  state: "OPEN" | "RESOLVED" | "DETACHED";
  generation: number;
  version: string | number;
  group_binding_id: string;
  replaced_by_correlation_id: string | null;
};
type DetachOperationRow = { request_sha256: string; result: Record<string, unknown> };
type CaseDestinationRow = { zammad_ticket_number: string };

@Controller("v1/cases")
export class CasesController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Requires("case:read")
  list(
    @Req() request: AuthenticatedRequest,
    @Query("before") before?: string,
    @Query("limit") limitValue?: string,
    @Query("ticket") ticketNumber?: string,
  ) {
    if(before!==undefined&&!UUID.test(before))throw new BadRequestException("Case cursor is invalid");
    if(ticketNumber!==undefined&&!validTicketNumber(ticketNumber))throw new BadRequestException("Case ticket number is invalid");
    const limit=boundedCaseLimit(limitValue);
    return this.database.rows(
      request.principal.tenantId,
      `WITH cursor AS (
         SELECT updated_at,generation,id FROM case_correlations WHERE tenant_id=$1 AND id=$2
       ) SELECT correlation.id,
              correlation.group_binding_id,
              correlation.normalized_reference,
              correlation.zammad_ticket_id,
              correlation.zammad_ticket_number,
              correlation.state,
              correlation.generation,
              correlation.version,
              correlation.predecessor_correlation_id,
              correlation.replaced_by_correlation_id,
              correlation.zammad_state_id,
              correlation.zammad_state_observed_at,
              correlation.detached_at,
              correlation.created_at,
              correlation.updated_at,
              COALESCE(group_record.wasalx_name,group_record.display_name) AS group_name,
              connection.provider,
              binding.zammad_group_id,
              EXISTS (
                SELECT 1 FROM zammad_instances instance
                 WHERE instance.tenant_id=correlation.tenant_id
                   AND instance.state='WORKING'
                   AND instance.agent_base_url IS NOT NULL
              ) AS zammad_agent_available
         FROM case_correlations correlation
         JOIN group_bindings binding
           ON binding.id=correlation.group_binding_id
          AND binding.tenant_id=correlation.tenant_id
         JOIN whatsapp_groups group_record
           ON group_record.id=binding.whatsapp_group_id
          AND group_record.tenant_id=binding.tenant_id
         JOIN connections connection
           ON connection.id=group_record.connection_id
          AND connection.tenant_id=group_record.tenant_id
        WHERE correlation.tenant_id=$1
          AND ($2::uuid IS NULL OR (correlation.updated_at,correlation.generation,correlation.id)<(SELECT updated_at,generation,id FROM cursor))
          AND ($4::text IS NULL OR correlation.zammad_ticket_number=$4)
        ORDER BY correlation.updated_at DESC,correlation.generation DESC,correlation.id DESC
        LIMIT $3`,
      [request.principal.tenantId,before??null,limit,ticketNumber??null],
    );
  }

  @Get(":id/workspace-ticket")
  @Requires("case:read")
  async agentDestination(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    if (!can(request.principal.role, "ticket:read")) throw new ForbiddenException("Workspace access is unavailable");
    if (!UUID.test(id)) throw new BadRequestException("Case correlation ID is invalid");
    const row = (
      await this.database.rows<CaseDestinationRow>(
        request.principal.tenantId,
        `SELECT correlation.zammad_ticket_number
           FROM case_correlations correlation
          WHERE correlation.tenant_id=$1
            AND correlation.id=$2`,
        [request.principal.tenantId, id],
      )
    )[0];
    if (!row || !/^[1-9][0-9]{0,15}$/u.test(row.zammad_ticket_number)) {
      throw new NotFoundException("The support case workspace is unavailable");
    }
    return { ticket_number: row.zammad_ticket_number };
  }

  @Post(":id/detach")
  @Requires("case:detach")
  async detach(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: DetachInput,
  ) {
    if (!UUID.test(id)) throw new BadRequestException("Case correlation ID is invalid");
    const expectedVersion = validateExpectedVersion(body.expectedVersion);
    if (body.confirmation !== "START_NEW_CASE") {
      throw new BadRequestException("Confirmation START_NEW_CASE is required");
    }
    const key = cleanIdempotencyKey(idempotencyKey);
    const requestSha256 = createHash("sha256")
      .update(JSON.stringify({ correlationId: id, expectedVersion, confirmation: body.confirmation }))
      .digest("hex");

    return this.database.withTenant(request.principal.tenantId, async (client) => {
      // Serialize equal idempotency keys before reading their operation row.
      // Without this fence, two concurrent retries can both miss the replay,
      // after which one succeeds and the other reports an incorrect
      // "already detached" conflict instead of returning the stored result.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `case-detach:${request.principal.tenantId}:${key}`,
      ]);

      const replay = (
        await client.query<DetachOperationRow>(
          `SELECT request_sha256,result
             FROM case_detach_operations
            WHERE tenant_id=$1 AND idempotency_key=$2`,
          [request.principal.tenantId, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.request_sha256 !== requestSha256) {
          throw new ConflictException("Idempotency key was already used for a different detach request");
        }
        return { ...replay.result, duplicate: true };
      }

      await requirePrivilegedAuthentication(
        client,
        request.principal,
        "starting a new case generation",
      );

      const previous = (
        await client.query<CorrelationRow>(
          `SELECT id,normalized_reference,zammad_ticket_id,zammad_ticket_number,state,
                  generation,version,group_binding_id,replaced_by_correlation_id
             FROM case_correlations
            WHERE tenant_id=$1 AND id=$2
            FOR UPDATE`,
          [request.principal.tenantId, id],
        )
      ).rows[0];
      if (!previous) throw new NotFoundException("Case correlation was not found");
      if (previous.state === "DETACHED") throw new ConflictException("Case correlation is already detached");
      if (previous.replaced_by_correlation_id) throw new ConflictException("Case correlation was already replaced");
      if (Number(previous.version) !== expectedVersion) {
        throw new ConflictException("Case correlation changed; refresh before starting a new case");
      }

      const detached = (
        await client.query<{
          id: string;
          state: "DETACHED";
          version: string | number;
          detached_at: string | Date;
        }>(
          `UPDATE case_correlations
              SET state='DETACHED',
                  detached_at=now(),
                  detached_by=$1,
                  version=version+1,
                  updated_at=now()
            WHERE tenant_id=$2 AND id=$3 AND version=$4 AND state<>'DETACHED'
          RETURNING id,state,version,detached_at`,
          [request.principal.userId, request.principal.tenantId, id, expectedVersion],
        )
      ).rows[0];
      if (!detached) throw new ConflictException("Case correlation changed; refresh before starting a new case");

      const result = {
        id: detached.id,
        state: detached.state,
        version: Number(detached.version),
        generation: Number(previous.generation),
        normalized_reference: previous.normalized_reference,
        zammad_ticket_id: previous.zammad_ticket_id,
        zammad_ticket_number: previous.zammad_ticket_number,
        detached_at: new Date(detached.detached_at).toISOString(),
        next_generation: Number(previous.generation) + 1,
        successor_correlation_id: null,
        message: "The next matching message will create a linked case generation.",
      };
      await client.query(
        `INSERT INTO case_detach_operations (
           tenant_id,correlation_id,idempotency_key,request_sha256,expected_version,result
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [request.principal.tenantId, id, key, requestSha256, expectedVersion, result],
      );
      await appendAudit(client, request.principal, {
        action: "case.correlation_detached",
        targetType: "case_correlation",
        targetId: id,
        requestId: request.id,
        previousValue: {
          state: previous.state,
          version: Number(previous.version),
          generation: Number(previous.generation),
          zammad_ticket_id: previous.zammad_ticket_id,
        },
        newValue: result,
      });
      return { ...result, duplicate: false };
    });
  }
}

function boundedCaseLimit(value:string|undefined){if(value===undefined)return 200;if(!/^[1-9][0-9]{0,2}$/u.test(value)||Number(value)>200)throw new BadRequestException("Case limit is invalid");return Number(value)}

function validTicketNumber(value:string){return /^\d{1,32}$/u.test(value)}

function validateExpectedVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BadRequestException("expectedVersion must be a positive integer");
  }
  return Number(value);
}

function cleanIdempotencyKey(value: string | undefined) {
  if (!value || value.length > 255 || /[\p{Cc}\p{Cf}\s]/u.test(value)) {
    throw new BadRequestException("A valid Idempotency-Key is required");
  }
  return value;
}
