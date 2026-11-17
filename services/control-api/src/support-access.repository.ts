import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type { PlatformOperatorPrincipal } from "./tenant-provisioning.types.js";

type OperatorCall = {
  idempotencyKey: string;
  requestSha256: string;
  operator: PlatformOperatorPrincipal;
  requestId: string;
};

@Injectable()
export class SupportAccessRepository implements OnModuleDestroy {
  private readonly pool?: Pool;

  constructor() {
    const connectionString = process.env.SUPPORT_ACCESS_DATABASE_URL;
    if (!connectionString) return;
    this.pool = new Pool({
      connectionString,
      options: "-c role=wasalx_support_client",
      max: boundedInteger(process.env.SUPPORT_ACCESS_DATABASE_POOL_SIZE, 3, 1, 8),
      statement_timeout: 15_000,
      application_name: "wasalx-platform-support-access",
    });
  }

  isConfigured() {
    return Boolean(this.pool);
  }

  async request(
    tenantId: string,
    reason: string,
    durationSeconds: number,
    input: OperatorCall,
  ) {
    const result = await this.requiredPool().query<{ result: unknown }>(
      "SELECT app.operator_request_support_access($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      [
        tenantId,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        input.operator.email.toLowerCase(),
        input.operator.displayName,
        reason,
        durationSeconds,
        input.requestId,
      ],
    );
    return requiredRecord(result.rows[0]?.result);
  }

  async get(id: string, operator: PlatformOperatorPrincipal, requestId: string) {
    const result = await this.requiredPool().query<{ result: unknown }>(
      "SELECT app.operator_get_support_access($1,$2,$3) AS result",
      [id, operator.subject, requestId],
    );
    return optionalRecord(result.rows[0]?.result);
  }

  async overview(id: string, operator: PlatformOperatorPrincipal, requestId: string) {
    const result = await this.requiredPool().query<{ result: unknown }>(
      "SELECT app.operator_support_overview($1,$2,$3) AS result",
      [id, operator.subject, requestId],
    );
    return optionalRecord(result.rows[0]?.result);
  }

  async cancel(id: string, input: OperatorCall) {
    const result = await this.requiredPool().query<{ result: unknown }>(
      "SELECT app.operator_cancel_support_access($1,$2,$3,$4,$5) AS result",
      [
        id,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        input.requestId,
      ],
    );
    return requiredRecord(result.rows[0]?.result);
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private requiredPool() {
    if (!this.pool) {
      throw new Error(
        "SUPPORT_ACCESS_DATABASE_URL for the least-privilege support role is required",
      );
    }
    return this.pool;
  }
}

function requiredRecord(value: unknown) {
  const record = optionalRecord(value);
  if (!record) throw new Error("Support access operation returned no result");
  return record;
}

function optionalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Support access database pool size must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
