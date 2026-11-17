import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { appendAudit } from "./audit.js";
import { DatabaseService } from "./database.service.js";
import { SupportAccessRepository } from "./support-access.repository.js";
import { requirePrivilegedAuthentication } from "./privileged-auth.js";
import type { PlatformOperatorPrincipal } from "./tenant-provisioning.types.js";
import type { Principal } from "./types.js";

type OperatorCall = {
  idempotencyKey: string;
  operator: PlatformOperatorPrincipal;
  requestId: string;
};

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: SupportAccessRepository,
  ) {}

  async request(
    tenantId: string,
    reason: string,
    durationSeconds: number,
    input: OperatorCall,
  ) {
    this.assertOperatorRuntime();
    try {
      return await this.repository.request(tenantId, reason, durationSeconds, {
        ...input,
        requestSha256: hashRequest({
          action: "REQUEST",
          tenantId,
          reason,
          durationSeconds,
          operatorSubject: input.operator.subject,
        }),
      });
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  async operatorGet(
    id: string,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    this.assertOperatorRuntime();
    try {
      const result = await this.repository.get(id, operator, requestId);
      if (!result) throw new NotFoundException("Support access request not found");
      return result;
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  async overview(
    id: string,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    this.assertOperatorRuntime();
    try {
      const result = await this.repository.overview(id, operator, requestId);
      if (!result) throw new NotFoundException("Support access request not found");
      if ((result as { active?: boolean }).active === false) {
        throw new ForbiddenException("Support access is not active");
      }
      return result;
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  async cancel(id: string, input: OperatorCall) {
    this.assertOperatorRuntime();
    try {
      return await this.repository.cancel(id, {
        ...input,
        requestSha256: hashRequest({
          action: "CANCEL",
          id,
          operatorSubject: input.operator.subject,
        }),
      });
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  async list(principal: Principal) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      await expireSupportAccess(client);
      return (
        await client.query(
          `SELECT id,operator_email,operator_display_name,reason,scope,
                  requested_duration_seconds,state,requested_at,request_expires_at,
                  approved_at,access_expires_at,denied_at,revoked_at,cancelled_at,
                  decision_reason,version,created_at,updated_at
             FROM platform_support_access_requests
            WHERE tenant_id=$1
            ORDER BY created_at DESC
            LIMIT 100`,
          [principal.tenantId],
        )
      ).rows;
    });
  }

  async approve(
    principal: Principal,
    id: string,
    expectedVersion: number,
    durationSeconds: number | undefined,
    requestId: string,
  ) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      await requirePrivilegedAuthentication(
        client,
        principal,
        "approving platform support access",
      );
      await expireSupportAccess(client);
      if (
        durationSeconds !== undefined &&
        (!Number.isInteger(durationSeconds) ||
          durationSeconds < 300 ||
          durationSeconds > 3_600)
      ) {
        throw new ConflictException(
          "Granted duration must be between five minutes and the requested duration",
        );
      }
      let updated: Record<string, unknown> | undefined;
      try {
        updated = (
          await client.query<Record<string, unknown>>(
            "SELECT * FROM app.tenant_decide_support_access($1,$2,'APPROVE',$3,$4,NULL)",
            [id, expectedVersion, principal.userId, durationSeconds ?? null],
          )
        ).rows[0];
      } catch (error) {
        throw mapTenantSupportError(error);
      }
      if (!updated) throw new ConflictException("Support access request has changed");
      const grantedDuration = durationSeconds ?? Number(updated.requested_duration_seconds);
      await appendAudit(client, principal, {
        action: "support_access.approved",
        targetType: "platform_support_access",
        targetId: id,
        requestId,
        previousValue: { state: "PENDING", version: expectedVersion },
        newValue: {
          state: "APPROVED",
          granted_duration_seconds: grantedDuration,
          access_expires_at: updated.access_expires_at,
        },
      });
      return updated;
    });
  }

  deny(
    principal: Principal,
    id: string,
    expectedVersion: number,
    reason: string,
    requestId: string,
  ) {
    return this.tenantTransition(
      principal,
      id,
      expectedVersion,
      "PENDING",
      [principal.userId, reason],
      "support_access.denied",
      "DENIED",
      requestId,
    );
  }

  revoke(
    principal: Principal,
    id: string,
    expectedVersion: number,
    reason: string,
    requestId: string,
  ) {
    return this.tenantTransition(
      principal,
      id,
      expectedVersion,
      "APPROVED",
      [principal.userId, reason],
      "support_access.revoked",
      "REVOKED",
      requestId,
    );
  }

  private async tenantTransition(
    principal: Principal,
    id: string,
    expectedVersion: number,
    fromState: "PENDING" | "APPROVED",
    values: [string, string],
    action: string,
    toState: string,
    requestId: string,
  ) {
    return this.database.withTenant(principal.tenantId, async (client) => {
      await requirePrivilegedAuthentication(
        client,
        principal,
        `${toState === "DENIED" ? "denying" : "revoking"} platform support access`,
      );
      await expireSupportAccess(client);
      let updated;
      try {
        updated = (
          await client.query(
            "SELECT * FROM app.tenant_decide_support_access($1,$2,$3,$4,NULL,$5)",
            [id, expectedVersion, toState === "DENIED" ? "DENY" : "REVOKE", values[0], values[1]],
          )
        ).rows[0];
      } catch (error) {
        throw mapTenantSupportError(error);
      }
      if (!updated) throw new ConflictException("Support access request has changed");
      await appendAudit(client, principal, {
        action,
        targetType: "platform_support_access",
        targetId: id,
        requestId,
        previousValue: { state: fromState, version: expectedVersion },
        newValue: { state: toState, reason: values[1] },
      });
      return updated;
    });
  }

  private assertOperatorRuntime() {
    if (!this.repository.isConfigured()) {
      throw new ServiceUnavailableException(
        "The least-privilege platform support database role is not configured",
      );
    }
  }
}

async function expireSupportAccess(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
) {
  await client.query("SELECT app.expire_tenant_support_access()");
}

function hashRequest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported support access idempotency input");
}

function mapSupportError(error: unknown) {
  if (
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException ||
    error instanceof ServiceUnavailableException
  ) {
    return error;
  }
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "23505" || code === "55000") {
    return new ConflictException(
      code === "23505"
        ? "The idempotency key or an existing support request conflicts"
        : "The support access transition is not allowed",
    );
  }
  if (code === "P0002") return new NotFoundException("Support access request not found");
  if (code === "42501") return new ForbiddenException("Support access is not active");
  return new ServiceUnavailableException(
    "The platform support access service is temporarily unavailable",
  );
}

function mapTenantSupportError(error: unknown) {
  if (
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  ) {
    return error;
  }
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "P0002") return new NotFoundException("Support access request not found");
  if (code === "42501") {
    return new ForbiddenException("An active tenant owner is required");
  }
  if (code === "40001" || code === "55000" || code === "22023") {
    return new ConflictException("Support access request has changed or is no longer eligible");
  }
  return new ServiceUnavailableException(
    "The tenant support access service is temporarily unavailable",
  );
}
