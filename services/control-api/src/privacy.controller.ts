import type { PoolClient } from "pg";
import { PortalWorkspaceController } from "./portal-workspace.controller.js";
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
  Put,
  Req,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { Requires } from "./permission.guard.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import { requireOperationKey, withOperationReceipt } from "./idempotent-operation.js";
import { PrivacyArtifactService } from "./privacy-artifact.service.js";
import { can } from "./rbac.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import type { AuthenticatedRequest } from "./types.js";

type ScopeType = "TENANT" | "ZAMMAD_TICKET" | "REFERENCE" | "PARTICIPANT" | "GROUP_BINDING" | "WHATSAPP_GROUP" | "ZAMMAD_USER";
type RequestScopeType = Exclude<ScopeType, "GROUP_BINDING" | "WHATSAPP_GROUP">;
type PrivacyRequestType = "EXPORT" | "DELETE";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller("v1/privacy")
export class PrivacyController {
  constructor(
    private readonly database: DatabaseService,
    private readonly drains: TenantDrainService,
    private readonly artifacts: PrivacyArtifactService,
    private readonly workspace: PortalWorkspaceController,
  ) {}

  private async requirePrivacyPrincipal(client: PoolClient, request: AuthenticatedRequest, permission: Parameters<typeof can>[1], action: string) {
    const principal = request.principal;
    const current = (await client.query<{ current_role: typeof principal.role | null }>(
      "SELECT app.lock_current_operator_principal($1,$2,$3,$4) AS current_role",
      [principal.userId,principal.subject,principal.email,principal.role]).catch(mapPrivacyLockConflict)).rows[0];
    if (!current || current.current_role !== principal.role || !can(current.current_role, permission))
      throw new ForbiddenException("Privacy action is unavailable");
    await requirePrivilegedAuthentication(client, principal, action);
  }

  private async privacyAdmission(client: PoolClient, request: AuthenticatedRequest, kind: string, key: string, digest?: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${request.principal.tenantId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`bot-flow:${request.principal.tenantId}:${key}`]);
    const permission = kind === "HOLD" ? "privacy:hold:write" : kind === "DELETE" ? "privacy:delete" : "privacy:export";
    await this.requirePrivacyPrincipal(client, request, permission, "recovering or submitting a privacy action");
    const row = (await client.query("SELECT action,request_sha256,result,requested_by FROM bot_flow_operations WHERE tenant_id=$1 AND idempotency_key=$2", [request.principal.tenantId,key])).rows[0];
    if (row) {
      if (row.requested_by !== request.principal.userId) throw new ForbiddenException("Privacy receipt is unavailable");
      if (row.action !== `PRIVACY_${kind}_CREATE`) throw new ConflictException("The operation key belongs to another action");
      if (row.result.state !== "NOT_APPLIED" && digest && row.request_sha256 !== digest) throw new ConflictException("The operation key belongs to another privacy intent");
      return { ...row.result, duplicate: true };
    }
    // Historical requests already have their own durable admission record.
    if (kind !== "HOLD") {
      const old = (await client.query("SELECT id,request_sha256,state,requested_by,request_type FROM privacy_requests WHERE tenant_id=$1 AND idempotency_key=$2",[request.principal.tenantId,key])).rows[0];
      if (old) {
        if (old.requested_by !== request.principal.userId) throw new ForbiddenException("Privacy receipt is unavailable");
        if (old.request_type !== kind || digest && old.request_sha256 !== digest) throw new ConflictException("The operation key belongs to another privacy intent");
        return { id: old.id, state: old.state, duplicate: true };
      }
    }
    return null;
  }

  private async savePrivacyAdmission(client: PoolClient, request: AuthenticatedRequest, kind: string, key: string, digest: string, result: Record<string, unknown>) {
    await client.query("INSERT INTO bot_flow_operations (tenant_id,action,idempotency_key,request_sha256,result,requested_by,request_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [request.principal.tenantId,`PRIVACY_${kind}_CREATE`,key,digest,result,request.principal.userId,String(request.id)]);
  }

  @Post("receipt")
  @Requires("privacy:read")
  async receipt(@Req() request: AuthenticatedRequest, @Body() body: { operationId?: string; kind?: string; action?: string }) {
    const key = requireOperationKey(body.operationId), kind = body.kind;
    if (!kind || !["EXPORT","DELETE","HOLD"].includes(kind) || !["LOOKUP","CANCEL_IF_UNADMITTED"].includes(body.action ?? "")) throw new BadRequestException("Invalid privacy receipt");
    return this.database.withTenant(request.principal.tenantId, async client => {
      const saved = await this.privacyAdmission(client,request,kind,key);
      if (saved) {
        if (saved.state === "NOT_APPLIED") return { state: "NOT_APPLIED", terminal: true, effect: "NONE" };
        if (typeof saved.id !== "string" || !UUID.test(saved.id)) throw new ConflictException("Privacy receipt is unavailable");
        return { state: "APPLIED", id: saved.id };
      }
      if (body.action === "LOOKUP") return { state: "UNKNOWN" };
      const cancelled = { state: "NOT_APPLIED", terminal: true, effect: "NONE" };
      await this.savePrivacyAdmission(client,request,kind,key,stableHash({kind,cancelled:true}),cancelled);
      return cancelled;
    });
  }

  @Post("target")
  @Requires("privacy:read")
  async target(@Req() request: AuthenticatedRequest, @Body() body: { scopeType?: string; scopeValue?: string }) {
    if (!can(request.principal.role, "privacy:export") && !can(request.principal.role, "privacy:hold:write"))
      throw new ForbiddenException("Target selection is unavailable");
    const target = await this.resolveTarget(request, body);
    return { scope_type: target.type, display: target.display, selection_sha256: target.selection_sha256 };
  }

  private async resolveTarget(request: AuthenticatedRequest, body: { scopeType?: string; scopeValue?: string; selection_sha256?: string }, confirm = false) {
    if (!["ZAMMAD_TICKET", "ZAMMAD_USER"].includes(body.scopeType ?? "")) throw new BadRequestException("Choose a case or customer");
    if (confirm && !/^[a-f0-9]{64}$/u.test(body.selection_sha256 ?? "")) throw new BadRequestException("Confirm the selected target first");
    const result = await this.workspace.privacyTarget(request, { scope_type: body.scopeType, reference: body.scopeValue,
      ...(confirm ? { expected_sha256: body.selection_sha256 } : {}) }) as Record<string, unknown>;
    if (!result || result.scope_type !== body.scopeType || typeof result.scope_value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(result.scope_value)
      || typeof result.display !== "string" || result.display.length > 512 || typeof result.selection_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.selection_sha256))
      throw new BadRequestException("Target is unavailable");
    if (confirm && result.selection_sha256 !== body.selection_sha256) throw new ConflictException("Target changed. Confirm it again.");
    return { type: body.scopeType as ScopeType, value: result.scope_value, display: result.display, selection_sha256: result.selection_sha256 };
  }

  private async admissionScope(request: AuthenticatedRequest, body: { scopeType?: string; scopeValue?: string; selection_sha256?: string }, allowGroup: boolean) {
    if (["ZAMMAD_TICKET", "ZAMMAD_USER"].includes(body.scopeType?.toUpperCase() ?? ""))
      return this.resolveTarget(request, { ...body, scopeType: body.scopeType?.toUpperCase() }, true);
    return { ...validatedScope(request.principal.tenantId, body.scopeType, body.scopeValue, allowGroup), display: null };
  }

  @Get("retention-policy")
  @Requires("privacy:read")
  async policy(@Req() request: AuthenticatedRequest) {
    const row = (
      await this.database.rows<Record<string, unknown>>(
        request.principal.tenantId,
        `SELECT state,resolved_case_days,include_open_cases,media_days,
                unmatched_diagnostic_hours,export_ttl_hours,next_sweep_at,version,updated_at,
                EXISTS (
                  SELECT 1 FROM zammad_instances z
                   WHERE z.tenant_id=retention_policies.tenant_id
                     AND z.state='WORKING'
                     AND z.privacy_secret_reference IS NOT NULL
                ) AS zammad_privacy_configured
           FROM retention_policies
          WHERE tenant_id=$1`,
        [request.principal.tenantId],
      )
    )[0];
    if (!row) throw new NotFoundException("Retention policy not found");
    return row;
  }

  @Put("retention-policy")
  @Requires("privacy:policy:write")
  async updatePolicy(
    @Req() request: AuthenticatedRequest,
    @Body() body: {
      state?: string;
      resolvedCaseDays?: number;
      includeOpenCases?: boolean;
      mediaDays?: number;
      unmatchedDiagnosticHours?: number;
      exportTtlHours?: number;
      expectedVersion?: number;
    },
  ) {
    const input = validatedPolicy(body);
    const result = await this.database.withTenant(request.principal.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`privacy:${request.principal.tenantId}`]);
      await this.requirePrivacyPrincipal(client, request, "privacy:policy:write", "changing the retention policy");
      const previous = (
        await client.query<Record<string, unknown>>(
          `SELECT state,resolved_case_days,include_open_cases,media_days,
                  unmatched_diagnostic_hours,export_ttl_hours,version
             FROM retention_policies
            WHERE tenant_id=$1 FOR UPDATE`,
          [request.principal.tenantId],
        )
      ).rows[0];
      if (!previous) throw new NotFoundException("Retention policy not found");
      if (Number(previous.version) !== input.expectedVersion) {
        throw new ConflictException("The retention policy changed; reload it before saving");
      }
      const updated = (
        await client.query<Record<string, unknown>>(
          `UPDATE retention_policies
              SET state=$2,resolved_case_days=$3,include_open_cases=$4,media_days=$5,
                  unmatched_diagnostic_hours=$6,export_ttl_hours=$7,next_sweep_at=now(),
                  version=version+1,updated_by=$8,updated_at=now()
            WHERE tenant_id=$1
        RETURNING state,resolved_case_days,include_open_cases,media_days,
                  unmatched_diagnostic_hours,export_ttl_hours,next_sweep_at,version,updated_at`,
          [
            request.principal.tenantId,
            input.state,
            input.resolvedCaseDays,
            input.includeOpenCases,
            input.mediaDays,
            input.unmatchedDiagnosticHours,
            input.exportTtlHours,
            request.principal.userId,
          ],
        )
      ).rows[0]!;
      await appendAudit(client, request.principal, {
        action: "privacy.retention_policy_updated",
        targetType: "retention_policy",
        targetId: request.principal.tenantId,
        requestId: String(request.id),
        previousValue: previous,
        newValue: updated,
      });
      return updated;
    }).catch(mapPrivacyLockConflict);
    await this.drains.wakePrivacy(request.principal.tenantId);
    return result;
  }

  @Get("legal-holds")
  @Requires("privacy:read")
  listHolds(@Req() request: AuthenticatedRequest) {
    const reveal = request.principal.role !== "auditor";
    return this.database.rows(
      request.principal.tenantId,
      `SELECT id,scope_type,scope_sha256,
              CASE WHEN $2 THEN CASE WHEN scope_type IN ('ZAMMAD_TICKET','ZAMMAD_USER') THEN scope_display ELSE scope_value END ELSE NULL END AS scope_value,
              CASE WHEN $2 THEN reason ELSE 'Restricted' END AS reason,
              state,expires_at,created_by,released_by,released_at,created_at,updated_at
         FROM privacy_legal_holds
        WHERE tenant_id=$1
        ORDER BY created_at DESC LIMIT 200`,
      [request.principal.tenantId, reveal],
    );
  }

  @Post("legal-holds")
  @Requires("privacy:hold:write")
  async createHold(
    @Req() request: AuthenticatedRequest,
    @Body() body: { scopeType?: string; scopeValue?: string; selection_sha256?: string; reason?: string; expiresAt?: string },
    @Headers("idempotency-key") operationHeader?: string,
  ) {
    const operationId = requireOperationKey(operationHeader);
    const reason = cleanText(body.reason, 500, "A legal-hold reason is required");
    let expiresAt: string | null = null;
    const requestDigest = stableHash({scopeType:body.scopeType?.toUpperCase(),scopeValue:body.scopeValue,selection_sha256:body.selection_sha256,reason,expiresAt:body.expiresAt ?? null});
    const prior = await this.database.withTenant(request.principal.tenantId, client => this.privacyAdmission(client,request,"HOLD",operationId,requestDigest));
    if (prior) return prior;
    let scope: Awaited<ReturnType<PrivacyController["admissionScope"]>> | undefined, resolutionError: unknown;
    try { expiresAt=optionalFutureDate(body.expiresAt,10*365); scope=await this.admissionScope(request,body,true); } catch(error) { resolutionError=error; }
    const result = await this.database.withTenant(request.principal.tenantId, async (client) => {
      const raced = await this.privacyAdmission(client,request,"HOLD",operationId,requestDigest);
      if (raced) return raced;
      if (resolutionError) throw resolutionError;
      if (!scope) throw new BadRequestException("Target is unavailable");
      const digest = scopeHash(scope.type,scope.value);
      await requireHoldScopeTarget(client, request.principal.tenantId, scope);
      const activeDeletion = await client.query(
        "SELECT 1 FROM privacy_jobs WHERE tenant_id=$1 AND job_type IN ('RETENTION_SWEEP','DELETE') AND state='RUNNING' LIMIT 1",
        [request.principal.tenantId],
      );
      if (activeDeletion.rowCount) {
        throw new ConflictException("A privacy deletion is already running; create the hold after it completes");
      }
      const expired = (
        await client.query<{ id: string; scope_type: string; scope_sha256: string; expires_at: string }>(
          `UPDATE privacy_legal_holds
              SET state='EXPIRED',released_at=expires_at,updated_at=now()
            WHERE tenant_id=$1 AND scope_type=$2 AND scope_sha256=$3
              AND state='ACTIVE' AND expires_at<=now()
        RETURNING id,scope_type,scope_sha256,expires_at`,
          [request.principal.tenantId, scope.type, digest],
        )
      ).rows;
      for (const hold of expired) {
        await appendAudit(client, request.principal, {
          action: "privacy.legal_hold_expired",
          targetType: "privacy_legal_hold",
          targetId: hold.id,
          requestId: String(request.id),
          previousValue: { state: "ACTIVE", scope_type: hold.scope_type, scope_sha256: hold.scope_sha256 },
          newValue: { state: "EXPIRED", expires_at: hold.expires_at },
        });
      }
      const inserted = (
        await client.query<{ id: string; state: string }>(
          `INSERT INTO privacy_legal_holds
             (tenant_id,scope_type,scope_value,scope_sha256,reason,expires_at,created_by,scope_display)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (tenant_id,scope_type,scope_sha256) WHERE state='ACTIVE' DO NOTHING
           RETURNING id,state`,
          [
            request.principal.tenantId,
            scope.type,
            scope.value,
            digest,
            reason,
            expiresAt,
            request.principal.userId,
            scope.type === "ZAMMAD_TICKET" ? scope.display : null,
          ],
        )
      ).rows[0];
      if (!inserted) throw new ConflictException("An active legal hold already covers this scope");
      await appendAudit(client, request.principal, {
        action: "privacy.legal_hold_created",
        targetType: "privacy_legal_hold",
        targetId: inserted.id,
        requestId: String(request.id),
        newValue: { scope_type: scope.type, scope_sha256: digest, expires_at: expiresAt },
      });
      await this.savePrivacyAdmission(client,request,"HOLD",operationId,requestDigest,inserted);
      return inserted;
    });
    return result;
  }

  @Post("legal-holds/:id/release")
  @Requires("privacy:hold:write")
  async releaseHold(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    requireUuid(id, "Legal hold ID");
    return this.database.withTenant(request.principal.tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `privacy:${request.principal.tenantId}`,
      ]);
      await this.requirePrivacyPrincipal(client, request, "privacy:hold:write", "releasing a legal hold");
      const previous = (
        await client.query<{ scope_type: string; scope_sha256: string; expires_at: string | null }>(
          "SELECT scope_type,scope_sha256,expires_at FROM privacy_legal_holds WHERE tenant_id=$1 AND id=$2 AND state='ACTIVE' FOR UPDATE",
          [request.principal.tenantId, id],
        )
      ).rows[0];
      if (!previous) throw new NotFoundException("Active legal hold not found");
      const updated = (
        await client.query<{ id: string; state: string; released_at: string }>(
          `UPDATE privacy_legal_holds
              SET state='RELEASED',released_by=$3,released_at=now(),updated_at=now()
            WHERE tenant_id=$1 AND id=$2
        RETURNING id,state,released_at`,
          [request.principal.tenantId, id, request.principal.userId],
        )
      ).rows[0]!;
      await appendAudit(client, request.principal, {
        action: "privacy.legal_hold_released",
        targetType: "privacy_legal_hold",
        targetId: id,
        requestId: String(request.id),
        previousValue: previous,
        newValue: updated,
      });
      return updated;
    });
  }

  @Get("requests")
  @Requires("privacy:read")
  listRequests(@Req() request: AuthenticatedRequest) {
    const reveal = request.principal.role !== "auditor";
    return this.database.rows(
      request.principal.tenantId,
      `SELECT r.id,r.request_type,r.scope_type,r.scope_sha256,
              CASE WHEN $2 THEN CASE WHEN r.scope_type IN ('ZAMMAD_TICKET','ZAMMAD_USER') THEN r.scope_display ELSE r.scope_value END ELSE NULL END AS scope_value,
              r.disposition,r.state,r.error_code,r.safe_error,r.completed_at,r.created_at,r.updated_at,
              a.id AS artifact_id,a.byte_size AS artifact_byte_size,a.expires_at AS artifact_expires_at
         FROM privacy_requests r
         LEFT JOIN privacy_export_artifacts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id
        WHERE r.tenant_id=$1
        ORDER BY r.created_at DESC LIMIT 200`,
      [request.principal.tenantId, reveal],
    );
  }

  @Get("requests/:id")
  @Requires("privacy:read")
  async requestDetail(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    requireUuid(id, "Privacy request ID");
    const reveal = request.principal.role !== "auditor";
    const row = (
      await this.database.rows<Record<string, unknown>>(
        request.principal.tenantId,
        `SELECT r.id,r.request_type,r.scope_type,r.scope_sha256,
                CASE WHEN $3 THEN CASE WHEN r.scope_type IN ('ZAMMAD_TICKET','ZAMMAD_USER') THEN r.scope_display ELSE r.scope_value END ELSE NULL END AS scope_value,
                r.disposition,r.state,r.error_code,r.safe_error,r.completed_at,r.created_at,r.updated_at,
                j.stage,j.attempts,j.max_attempts,j.summary,
                a.id AS artifact_id,a.byte_size AS artifact_byte_size,a.expires_at AS artifact_expires_at
           FROM privacy_requests r
           JOIN privacy_jobs j ON j.tenant_id=r.tenant_id AND j.request_id=r.id
           LEFT JOIN privacy_export_artifacts a ON a.tenant_id=r.tenant_id AND a.request_id=r.id
          WHERE r.tenant_id=$1 AND r.id=$2`,
        [request.principal.tenantId, id, reveal],
      )
    )[0];
    if (!row) throw new NotFoundException("Privacy request not found");
    return row;
  }

  @Post("requests")
  @Requires("privacy:read")
  async createRequest(
    @Req() request: AuthenticatedRequest,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Body() body: {
      requestType?: string;
      scopeType?: string;
      scopeValue?: string;
      selection_sha256?: string;
      confirmation?: string;
    },
  ) {
    const requestType = body.requestType?.toUpperCase() as PrivacyRequestType | undefined;
    if (requestType !== "EXPORT" && requestType !== "DELETE") {
      throw new BadRequestException("Request type must be EXPORT or DELETE");
    }
    const permission = requestType === "EXPORT" ? "privacy:export" : "privacy:delete";
    if (!can(request.principal.role, permission)) throw new ForbiddenException(`Missing permission ${permission}`);
    const idempotencyKey = requireOperationKey(idempotencyHeader);
    const nativeScope = ["ZAMMAD_TICKET", "ZAMMAD_USER"].includes(body.scopeType?.toUpperCase() ?? "");
    if (nativeScope && !/^[a-f0-9]{64}$/u.test(body.selection_sha256 ?? "")) throw new BadRequestException("Confirm the selected target first");
    const intent = nativeScope ? { type: body.scopeType!.toUpperCase() as RequestScopeType,
      value: cleanText(body.scopeValue, 320, "Choose a case or customer") }
      : validatedScope(request.principal.tenantId, body.scopeType, body.scopeValue, false);
    if (requestType === "DELETE") {
      const expected = intent.type === "TENANT" ? "DELETE TENANT DATA" : "DELETE";
      if (body.confirmation !== expected) throw new BadRequestException(`Type "${expected}" to confirm deletion`);
    }
    const disposition = requestType === "EXPORT"
      ? "EXPORT_ONLY"
      : intent.type === "ZAMMAD_USER"
        ? "ZAMMAD_USER_DATA_PRIVACY"
        : "DELETE_TICKETS";
    const requestDigest = stableHash({ requestType, scopeType: intent.type, scopeValue: intent.value, disposition,
      ...(nativeScope ? { selection_sha256: body.selection_sha256 } : {}) });
    const prior = await this.database.withTenant(request.principal.tenantId, client => this.privacyAdmission(client,request,requestType,idempotencyKey,requestDigest));
    if (prior) { if(prior.state!=="NOT_APPLIED") await this.drains.wakePrivacy(request.principal.tenantId); return prior; }
    let scope: Awaited<ReturnType<PrivacyController["admissionScope"]>> | undefined, resolutionError: unknown;
    try { scope = await this.admissionScope(request,body,false); } catch (error) { resolutionError=error; }
    const created = await this.database.withTenant(request.principal.tenantId, async (client) => {
      const raced = await this.privacyAdmission(client,request,requestType,idempotencyKey,requestDigest);
      if (raced) return raced;
      if (resolutionError) throw resolutionError;
      if (!scope) throw new BadRequestException("Target is unavailable");
      const digest = scopeHash(scope.type,scope.value);
      if (requestType === "DELETE" && await hasApplicableHold(client, scope)) {
        throw new ConflictException("An active legal hold blocks this deletion scope");
      }
      const privacyRequest = (
        await client.query<{ id: string; state: string }>(
          `INSERT INTO privacy_requests
             (tenant_id,request_type,scope_type,scope_value,scope_sha256,disposition,
              idempotency_key,request_sha256,requested_by,scope_display)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id,state`,
          [
            request.principal.tenantId,
            requestType,
            scope.type,
            scope.value,
            digest,
            disposition,
            idempotencyKey,
            requestDigest,
            request.principal.userId,
            scope.type === "ZAMMAD_TICKET" ? scope.display : null,
          ],
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO privacy_jobs
           (tenant_id,request_id,job_type,scope_type,scope_value,disposition,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          request.principal.tenantId,
          privacyRequest.id,
          requestType,
          scope.type,
          scope.value,
          disposition,
          `request:${privacyRequest.id}`,
        ],
      );
      await appendAudit(client, request.principal, {
        action: requestType === "EXPORT" ? "privacy.export_requested" : "privacy.deletion_requested",
        targetType: "privacy_request",
        targetId: privacyRequest.id,
        requestId: String(request.id),
        newValue: { request_type: requestType, scope_type: scope.type, scope_sha256: digest, disposition },
      });
      await this.savePrivacyAdmission(client,request,requestType,idempotencyKey,requestDigest,privacyRequest);
      return { ...privacyRequest, duplicate: false };
    });
    await this.drains.wakePrivacy(request.principal.tenantId);
    return created;
  }

  @Post("requests/:id/retry")
  @Requires("privacy:read")
  async retryRequest(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Headers("idempotency-key") idempotencyHeader: string | undefined,
    @Body() body: { confirmation?: string },
  ) {
    requireUuid(id, "Privacy request ID");
    const idempotencyKey=requireOperationKey(idempotencyHeader);
    const result = await this.database.withTenant(request.principal.tenantId, async (client) => {
      const current = (
        await client.query<{
          request_type: PrivacyRequestType;
          scope_type: RequestScopeType;
          scope_value: string;
        }>(
          "SELECT request_type,scope_type,scope_value FROM privacy_requests WHERE tenant_id=$1 AND id=$2",
          [request.principal.tenantId, id],
        )
      ).rows[0];
      if (!current) throw new NotFoundException("Privacy request not found");
      const permission = current.request_type === "EXPORT" ? "privacy:export" : "privacy:delete";
      if (!can(request.principal.role, permission)) throw new ForbiddenException(`Missing permission ${permission}`);
      if(current.request_type==="DELETE"){
        const expected=current.scope_type==="TENANT"?"DELETE TENANT DATA":"DELETE";
        if(body.confirmation!==expected)throw new BadRequestException(`Type "${expected}" to confirm deletion`);
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`privacy:${request.principal.tenantId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`bot-flow:${request.principal.tenantId}:${idempotencyKey}`]);
      await this.requirePrivacyPrincipal(
        client, request, permission,
        current.request_type === "EXPORT" ? "retrying a privacy export" : "retrying permanent deletion",
      );
      return withOperationReceipt(client,request.principal,"PRIVACY_REQUEST_RETRY",idempotencyKey,
        stableHash({id,confirmation:current.request_type==="DELETE"?body.confirmation:null}),String(request.id),async()=>{
          const previous=(await client.query<{request_type:PrivacyRequestType;scope_type:RequestScopeType;scope_value:string;state:string;attempts:number;error_code:string|null}>(
            `SELECT r.request_type,r.scope_type,r.scope_value,r.state,j.attempts,j.error_code
               FROM privacy_requests r JOIN privacy_jobs j ON j.tenant_id=r.tenant_id AND j.request_id=r.id
              WHERE r.tenant_id=$1 AND r.id=$2 AND r.state IN ('FAILED_RETRYABLE','FAILED_TERMINAL','BLOCKED_LEGAL_HOLD')
              FOR UPDATE OF r,j`,[request.principal.tenantId,id])).rows[0];
          if(!previous)throw new BadRequestException("Privacy request is not retryable");
          if(previous.error_code==="ZAMMAD_PRIVACY_OUTCOME_UNKNOWN")
            throw new ConflictException("This Zammad privacy task requires operator reconciliation before it can be retried");
          if(previous.request_type==="DELETE"&&await hasApplicableHold(client,{type:previous.scope_type,value:previous.scope_value}))
            throw new ConflictException("An active legal hold still blocks this deletion");
          await client.query("UPDATE privacy_requests SET state='QUEUED',error_code=NULL,safe_error=NULL,completed_at=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2",[request.principal.tenantId,id]);
          await client.query(`UPDATE privacy_jobs SET state='QUEUED',available_at=now(),lease_id=NULL,lease_expires_at=NULL,
            error_code=NULL,safe_error=NULL,completed_at=NULL,attempts=0,updated_at=now() WHERE tenant_id=$1 AND request_id=$2`,[request.principal.tenantId,id]);
          await appendAudit(client,request.principal,{action:"privacy.request_retry_requested",targetType:"privacy_request",targetId:id,
            requestId:String(request.id),previousValue:previous,newValue:{state:"QUEUED"}});
          return{id,state:"QUEUED"};
        },"The idempotency key was already used for another privacy retry");
    });
    if(!result.duplicate)await this.drains.wakePrivacy(request.principal.tenantId);
    return result;
  }

  @Post("requests/:id/download")
  @Requires("privacy:export")
  async download(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    requireUuid(id, "Privacy request ID");
    await this.database.withTenant(request.principal.tenantId, (client) =>
      this.requirePrivacyPrincipal(client, request, "privacy:export", "downloading a privacy export"),
    );
    const artifact = (
      await this.database.rows<{ id: string; object_key: string; expires_at: string | Date }>(
        request.principal.tenantId,
        `SELECT a.id,a.object_key,a.expires_at
           FROM privacy_export_artifacts a
           JOIN privacy_requests r ON r.tenant_id=a.tenant_id AND r.id=a.request_id
          WHERE a.tenant_id=$1 AND a.request_id=$2 AND r.request_type='EXPORT'
            AND r.state='SUCCEEDED' AND a.expires_at>now()`,
        [request.principal.tenantId, id],
      )
    )[0];
    if (!artifact) throw new NotFoundException("A downloadable export artifact is not available");
    const url = await this.artifacts.signedDownloadUrl(artifact.object_key, 300);
    await this.database.withTenant(request.principal.tenantId, async (client) => {
      await this.requirePrivacyPrincipal(client, request, "privacy:export", "downloading a privacy export");
      await client.query(
        "UPDATE privacy_export_artifacts SET downloaded_at=now() WHERE tenant_id=$1 AND id=$2",
        [request.principal.tenantId, artifact.id],
      );
      await appendAudit(client, request.principal, {
        action: "privacy.export_downloaded",
        targetType: "privacy_request",
        targetId: id,
        requestId: String(request.id),
        newValue: { artifact_id: artifact.id, url_ttl_seconds: 300 },
      });
    });
    return { url, expiresIn: 300 };
  }
}

function validatedPolicy(body: {
  state?: string;
  resolvedCaseDays?: number;
  includeOpenCases?: boolean;
  mediaDays?: number;
  unmatchedDiagnosticHours?: number;
  exportTtlHours?: number;
  expectedVersion?: number;
}) {
  if (body.state !== "ACTIVE" && body.state !== "PAUSED") throw new BadRequestException("Policy state is invalid");
  const resolvedCaseDays = boundedInteger(body.resolvedCaseDays, 1, 3650, "Resolved-case retention");
  const mediaDays = boundedInteger(body.mediaDays, 1, 3650, "Media retention");
  const unmatchedDiagnosticHours = boundedInteger(body.unmatchedDiagnosticHours, 1, 24, "Unmatched diagnostic retention");
  const exportTtlHours = boundedInteger(body.exportTtlHours, 1, 168, "Export lifetime");
  const expectedVersion = boundedInteger(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER, "Policy version");
  if (typeof body.includeOpenCases !== "boolean") throw new BadRequestException("Open-case retention choice is required");
  return { state: body.state, resolvedCaseDays, includeOpenCases: body.includeOpenCases, mediaDays, unmatchedDiagnosticHours, exportTtlHours, expectedVersion };
}

function validatedScope(tenantId: string, rawType: string | undefined, rawValue: string | undefined, allowGroup: boolean) {
  const type = rawType?.toUpperCase() as ScopeType | undefined;
  const allowed = new Set<ScopeType>(["TENANT", "ZAMMAD_TICKET", "REFERENCE", "PARTICIPANT", "ZAMMAD_USER"]);
  if (allowGroup) {
    allowed.add("GROUP_BINDING");
    allowed.add("WHATSAPP_GROUP");
  }
  if (!type || !allowed.has(type)) throw new BadRequestException("Privacy scope type is invalid");
  let value = type === "TENANT" ? tenantId : cleanText(rawValue, 512, "Privacy scope value is required");
  if ((type === "ZAMMAD_TICKET" || type === "ZAMMAD_USER") && !/^[1-9]\d{0,18}$/u.test(value)) {
    throw new BadRequestException(`${type === "ZAMMAD_TICKET" ? "Zammad ticket" : "Zammad user"} ID is invalid`);
  }
  if (type === "GROUP_BINDING") {
    requireUuid(value, "Group binding ID");
    value = value.toLowerCase();
  }
  if (type === "WHATSAPP_GROUP") {
    requireUuid(value, "WhatsApp group ID");
    value = value.toLowerCase();
  }
  return { type: type as RequestScopeType | ScopeType, value };
}

async function requireHoldScopeTarget(
  client: { query: (sql: string, values: unknown[]) => Promise<{ rowCount: number | null }> },
  tenantId: string,
  scope: { type: RequestScopeType | ScopeType; value: string },
) {
  if (scope.type === "GROUP_BINDING") {
    const target = await client.query(
      "SELECT 1 FROM group_bindings WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE",
      [tenantId, scope.value],
    );
    if (target.rowCount !== 1) throw new NotFoundException("Group binding not found");
  }
  if (scope.type === "WHATSAPP_GROUP") {
    const target = await client.query(
      `SELECT 1 FROM group_workspace_settings workspace
        JOIN whatsapp_groups group_record
          ON group_record.tenant_id=workspace.tenant_id AND group_record.id=workspace.whatsapp_group_id
       WHERE workspace.tenant_id=$1 AND workspace.whatsapp_group_id=$2
       FOR KEY SHARE OF workspace,group_record`,
      [tenantId, scope.value],
    );
    if (target.rowCount !== 1) throw new NotFoundException("WhatsApp group workspace not found");
  }
}

async function hasApplicableHold(
  client: { query: <T>(sql: string, values: unknown[]) => Promise<{ rows: T[] }> },
  scope: { type: string; value: string },
) {
  return (await client.query<{ held: boolean }>(
    "SELECT app.has_applicable_privacy_hold($1,$2) AS held",
    [scope.type, scope.value],
  )).rows[0]?.held === true;
}

function requireUuid(value: string, label: string) {
  if (!UUID.test(value)) throw new BadRequestException(`${label} is invalid`);
}

function cleanText(value: string | undefined, maximum: number, message: string) {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maximum || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new BadRequestException(message);
  }
  return normalized;
}

function boundedInteger(value: number | undefined, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value! < minimum || value! > maximum) {
    throw new BadRequestException(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value!;
}

function optionalFutureDate(value: string | undefined, maximumDays: number) {
  if (!value) return null;
  const date = new Date(value);
  const now = Date.now();
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now || date.getTime() > now + maximumDays * 86_400_000) {
    throw new BadRequestException("Legal-hold expiry is invalid");
  }
  return date.toISOString();
}

function scopeHash(type: string, value: string) {
  return createHash("sha256").update(`${type}\0${value}`).digest("hex");
}

function stableHash(value: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(value).sort()))).digest("hex");
}

function mapPrivacyLockConflict(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "55P03")
    throw new ConflictException({ code: "CURRENT_PRINCIPAL_BUSY", message: "Privacy action is busy. Check the operation before trying again." });
  throw error;
}
