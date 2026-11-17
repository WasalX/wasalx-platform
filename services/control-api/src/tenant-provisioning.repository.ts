import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import type {
  PlatformOperatorPrincipal,
  TenantProvisioningSpec,
  TenantProvisioningStep,
  TenantProvisioningTask,
} from "./tenant-provisioning.types.js";

type OperatorCall = {
  idempotencyKey: string;
  requestSha256: string;
  operator: PlatformOperatorPrincipal;
  requestId: string;
};

export interface TenantProvisioningStore {
  isConfigured(): boolean;
  replayCreate(input: OperatorCall): Promise<Record<string, unknown> | null>;
  create(input: OperatorCall & { spec: TenantProvisioningSpec }): Promise<Record<string, unknown>>;
  status(
    tenantId: string,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ): Promise<Record<string, unknown> | null>;
  retry(tenantId: string, input: OperatorCall): Promise<Record<string, unknown>>;
  suspend(
    tenantId: string,
    reason: string,
    input: OperatorCall,
  ): Promise<Record<string, unknown>>;
  resume(
    tenantId: string,
    reason: string,
    input: OperatorCall,
  ): Promise<Record<string, unknown>>;
  claim(leaseId: string, limit: number): Promise<TenantProvisioningTask[]>;
  startStep(
    task: TenantProvisioningTask,
    leaseId: string,
    step: TenantProvisioningStep,
  ): Promise<boolean>;
  completeStep(
    task: TenantProvisioningTask,
    leaseId: string,
    step: TenantProvisioningStep,
    outputs: Record<string, unknown>,
  ): Promise<boolean>;
  completeSuspension(
    task: TenantProvisioningTask,
    leaseId: string,
    outputs: Record<string, unknown>,
  ): Promise<boolean>;
  authorizeResumption(
    task: TenantProvisioningTask,
    leaseId: string,
    outputs: Record<string, unknown>,
  ): Promise<boolean>;
  completeResumption(
    task: TenantProvisioningTask,
    leaseId: string,
    outputs: Record<string, unknown>,
  ): Promise<boolean>;
  fail(
    task: TenantProvisioningTask,
    leaseId: string,
    failure: {
      retryable: boolean;
      code: string;
      safeError: string;
      retryAt?: string;
    },
  ): Promise<boolean>;
}

@Injectable()
export class TenantProvisioningRepository
  implements TenantProvisioningStore, OnModuleDestroy
{
  private readonly pool?: Pool;

  constructor() {
    const connectionString = process.env.PROVISIONING_DATABASE_URL;
    if (!connectionString) return;
    this.pool = new Pool({
      connectionString,
      // Force every session down to the migration-owned execution-only role.
      // A mistakenly over-privileged login therefore cannot widen this runtime.
      options: "-c role=wasalx_provisioning_client",
      max: boundedInteger(
        process.env.PROVISIONING_DATABASE_POOL_SIZE,
        4,
        1,
        10,
      ),
      statement_timeout: 20_000,
      application_name: "wasalx-tenant-provisioning",
    });
  }

  isConfigured() {
    return Boolean(this.pool);
  }

  async replayCreate(input: OperatorCall) {
    const result = await this.requiredPool().query<{ result: Record<string, unknown> | null }>(
      "SELECT app.replay_tenant_create_request($1,$2,$3) AS result",
      [input.idempotencyKey, input.requestSha256, input.operator.subject],
    );
    return result.rows[0]?.result ?? null;
  }

  async create(input: OperatorCall & { spec: TenantProvisioningSpec }) {
    const result = await this.requiredPool().query<{ result: Record<string, unknown> }>(
      "SELECT app.operator_create_tenant($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) AS result",
      [
        input.idempotencyKey,
        input.requestSha256,
        input.spec.tenant.name,
        input.spec.tenant.slug,
        input.spec.tenant.retentionDays,
        JSON.stringify(input.spec),
        input.spec.owner.oidcSubject,
        input.spec.owner.email,
        input.spec.owner.displayName,
        input.operator.subject,
        input.requestId,
      ],
    );
    return requiredResult(result.rows[0]?.result);
  }

  async status(
    tenantId: string,
    operator: PlatformOperatorPrincipal,
    requestId: string,
  ) {
    const result = await this.requiredPool().query<{
      result: Record<string, unknown> | null;
    }>(
      "SELECT app.operator_tenant_provisioning_status($1,$2,$3) AS result",
      [tenantId, operator.subject, requestId],
    );
    return result.rows[0]?.result ?? null;
  }

  async retry(tenantId: string, input: OperatorCall) {
    const result = await this.requiredPool().query<{ result: Record<string, unknown> }>(
      "SELECT app.operator_retry_tenant_provisioning($1,$2,$3,$4,$5) AS result",
      [
        tenantId,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        input.requestId,
      ],
    );
    return requiredResult(result.rows[0]?.result);
  }

  async suspend(tenantId: string, reason: string, input: OperatorCall) {
    const result = await this.requiredPool().query<{ result: Record<string, unknown> }>(
      "SELECT app.operator_suspend_tenant($1,$2,$3,$4,$5,$6) AS result",
      [
        tenantId,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        reason,
        input.requestId,
      ],
    );
    return requiredResult(result.rows[0]?.result);
  }

  async resume(tenantId: string, reason: string, input: OperatorCall) {
    const result = await this.requiredPool().query<{ result: Record<string, unknown> }>(
      "SELECT app.operator_resume_tenant($1,$2,$3,$4,$5,$6) AS result",
      [
        tenantId,
        input.idempotencyKey,
        input.requestSha256,
        input.operator.subject,
        reason,
        input.requestId,
      ],
    );
    return requiredResult(result.rows[0]?.result);
  }

  async claim(leaseId: string, limit: number) {
    const result = await this.requiredPool().query<{ task: unknown }>(
      "SELECT app.claim_tenant_provisioning_tasks($1,$2) AS task",
      [leaseId, limit],
    );
    return result.rows.map((row) => taskFromDatabase(row.task));
  }

  async startStep(
    task: TenantProvisioningTask,
    leaseId: string,
    step: TenantProvisioningStep,
  ) {
    return this.booleanFunction(
      "SELECT app.start_tenant_provisioning_step($1,$2,$3,$4) AS changed",
      [task.tenantId, leaseId, task.fencingToken, step],
    );
  }

  async completeStep(
    task: TenantProvisioningTask,
    leaseId: string,
    step: TenantProvisioningStep,
    outputs: Record<string, unknown>,
  ) {
    return this.booleanFunction(
      "SELECT app.complete_tenant_provisioning_step($1,$2,$3,$4,$5::jsonb) AS changed",
      [task.tenantId, leaseId, task.fencingToken, step, JSON.stringify(outputs)],
    );
  }

  async completeSuspension(
    task: TenantProvisioningTask,
    leaseId: string,
    outputs: Record<string, unknown>,
  ) {
    return this.booleanFunction(
      "SELECT app.complete_tenant_suspension($1,$2,$3,$4::jsonb) AS changed",
      [task.tenantId, leaseId, task.fencingToken, JSON.stringify(outputs)],
    );
  }

  async completeResumption(
    task: TenantProvisioningTask,
    leaseId: string,
    outputs: Record<string, unknown>,
  ) {
    return this.booleanFunction(
      "SELECT app.complete_tenant_resumption($1,$2,$3,$4::jsonb) AS changed",
      [task.tenantId, leaseId, task.fencingToken, JSON.stringify(outputs)],
    );
  }

  async authorizeResumption(
    task: TenantProvisioningTask,
    leaseId: string,
    outputs: Record<string, unknown>,
  ) {
    return this.booleanFunction(
      "SELECT app.authorize_tenant_resumption($1,$2,$3,$4::jsonb) AS changed",
      [task.tenantId, leaseId, task.fencingToken, JSON.stringify(outputs)],
    );
  }

  async fail(
    task: TenantProvisioningTask,
    leaseId: string,
    failure: {
      retryable: boolean;
      code: string;
      safeError: string;
      retryAt?: string;
    },
  ) {
    return this.booleanFunction(
      "SELECT app.fail_tenant_provisioning_task($1,$2,$3,$4,$5,$6,$7) AS changed",
      [
        task.tenantId,
        leaseId,
        task.fencingToken,
        failure.retryable,
        failure.code,
        failure.safeError,
        failure.retryAt ?? null,
      ],
    );
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  private requiredPool() {
    if (!this.pool) {
      throw new Error(
        "PROVISIONING_DATABASE_URL for the least-privilege provisioning role is required",
      );
    }
    return this.pool;
  }

  private async booleanFunction(sql: string, values: unknown[]) {
    const result = await this.requiredPool().query<{ changed: boolean }>(
      sql,
      values,
    );
    return result.rows[0]?.changed === true;
  }
}

function taskFromDatabase(value: unknown): TenantProvisioningTask {
  if (!isRecord(value)) throw new Error("Database returned an invalid provisioning task");
  const fencingToken = Number(value.fencingToken);
  const attempts = Number(value.attempts);
  const maxAttempts = Number(value.maxAttempts);
  if (
    typeof value.operationId !== "string" ||
    typeof value.zammadInstanceId !== "string" ||
    typeof value.tenantId !== "string" ||
    (value.action !== "PROVISION" &&
      value.action !== "SUSPEND" &&
      value.action !== "RESUME") ||
    typeof value.status !== "string" ||
    !Array.isArray(value.completedSteps) ||
    !isRecord(value.stepResults) ||
    !isRecord(value.spec) ||
    !Number.isSafeInteger(fencingToken) ||
    fencingToken < 0 ||
    !Number.isInteger(attempts) ||
    !Number.isInteger(maxAttempts)
  ) {
    throw new Error("Database returned an invalid provisioning task");
  }
  return {
    operationId: value.operationId,
    zammadInstanceId: value.zammadInstanceId,
    tenantId: value.tenantId,
    action: value.action,
    status: value.status,
    completedSteps: value.completedSteps as TenantProvisioningStep[],
    currentStep: isCurrentStep(value.currentStep) ? value.currentStep : null,
    stepResults: value.stepResults,
    spec: value.spec as TenantProvisioningSpec,
    attempts,
    maxAttempts,
    fencingToken,
  };
}

function isCurrentStep(value: unknown): value is TenantProvisioningTask["currentStep"] {
  return typeof value === "string" && [
    "identity", "database", "search", "storage", "secrets", "zammad",
    "package", "oidc", "defaults", "health", "resume_prepare", "resume_publish",
  ].includes(value);
}

function requiredResult(value: unknown) {
  if (!isRecord(value)) throw new Error("Provisioning operation returned no result");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
      `Provisioning database pool size must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
