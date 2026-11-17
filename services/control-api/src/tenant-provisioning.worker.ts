import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  observeDuration,
  recordMetric,
  recordStructuredLog,
  safeErrorCode,
  withSpan,
} from "@wasalx/observability";
import {
  HttpTenantProvisioningDriver,
  ProvisioningDriverError,
  type TenantProvisioningDriver,
} from "./tenant-provisioning.driver.js";
import {
  TenantProvisioningRepository,
  type TenantProvisioningStore,
} from "./tenant-provisioning.repository.js";
import {
  tenantProvisioningSteps,
  type TenantProvisioningDriverRequest,
  type TenantProvisioningStep,
  type TenantProvisioningTask,
} from "./tenant-provisioning.types.js";

export class StaleTenantProvisioningLeaseError extends Error {}

@Injectable()
export class TenantProvisioningWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly leaseId = randomUUID();
  private readonly intervalMs: number;
  private readonly claimLimit: number;
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<number>;

  constructor(
    private readonly repository: TenantProvisioningRepository,
    private readonly driver: HttpTenantProvisioningDriver,
  ) {
    this.intervalMs = boundedInteger(
      process.env.PROVISIONING_WORKER_INTERVAL_MS,
      5_000,
      1_000,
      60_000,
    );
    this.claimLimit = boundedInteger(
      process.env.PROVISIONING_WORKER_CLAIM_LIMIT,
      5,
      1,
      25,
    );
  }

  onApplicationBootstrap() {
    if (!this.isOperational()) return;
    this.timer = setInterval(() => void this.drainOnce(), this.intervalMs);
    this.timer.unref?.();
    this.kick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  isOperational() {
    return this.repository.isConfigured() && this.driver.isConfigured();
  }

  kick() {
    if (!this.isOperational()) return false;
    queueMicrotask(() => void this.drainOnce());
    return true;
  }

  drainOnce() {
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain() {
    if (!this.isOperational()) return 0;
    let tasks: TenantProvisioningTask[];
    try {
      tasks = await this.repository.claim(this.leaseId, this.claimLimit);
    } catch (error) {
      recordMetric("wasalx_provisioning_operations_total", 1, {
        operation: "claim",
        component: "control_api",
        result: "failed",
        reason: safeErrorCode(error),
      });
      recordStructuredLog("error", "tenant_provisioning.claim_failed", {
        error_code: safeErrorCode(error),
      });
      return 0;
    }
    await Promise.all(tasks.map((task) => this.process(task)));
    return tasks.length;
  }

  private async process(task: TenantProvisioningTask) {
    const startedAt = Date.now();
    const operation = provisioningOperation(task);
    try {
      await withSpan("tenant provisioning task", {
        attributes: {
          "wasalx.component": "control_api",
          "wasalx.operation": operation,
        },
      }, async () => executeProvisioningTask(
          this.repository,
          this.driver,
          this.leaseId,
          task,
          () => this.kick(),
        ));
      recordProvisioningOutcome(operation, "succeeded", startedAt);
    } catch (error) {
      if (error instanceof StaleTenantProvisioningLeaseError) {
        recordProvisioningOutcome(operation, "lease_lost", startedAt);
        recordStructuredLog("warn", "tenant_provisioning.lease_lost", {
          operation,
        });
        return;
      }
      const failure = classifyFailure(error, task.attempts);
      try {
        const changed = await this.repository.fail(
          task,
          this.leaseId,
          failure,
        );
        if (!changed) {
          recordProvisioningOutcome(operation, "lease_lost", startedAt);
          recordStructuredLog("warn", "tenant_provisioning.failure_fence_lost", {
            operation,
            error_code: failure.code,
          });
        } else {
          recordProvisioningOutcome(
            operation,
            failure.retryable ? "retryable_failure" : "terminal_failure",
            startedAt,
            failure.code,
          );
        }
      } catch (persistenceError) {
        recordProvisioningOutcome(operation, "persistence_failure", startedAt, safeErrorCode(persistenceError));
        recordStructuredLog("error", "tenant_provisioning.failure_persistence_failed", {
          operation,
          error_code: safeErrorCode(persistenceError),
        });
      }
    }
  }
}

function provisioningOperation(task: TenantProvisioningTask) {
  if (task.action === "SUSPEND") return "suspend";
  if (task.action === "RESUME") return "resume";
  return tenantProvisioningSteps[task.completedSteps.length]?.toLowerCase() ?? "invalid_step";
}

function recordProvisioningOutcome(
  operation: string,
  result: string,
  startedAt: number,
  reason = "none",
) {
  const attributes = { operation, component: "control_api", result, reason };
  recordMetric("wasalx_provisioning_operations_total", 1, attributes);
  observeDuration("wasalx_provisioning_duration_seconds", startedAt, attributes);
}

export async function executeProvisioningTask(
  repository: TenantProvisioningStore,
  driver: TenantProvisioningDriver,
  leaseId: string,
  task: TenantProvisioningTask,
  kick: () => unknown = () => undefined,
) {
  if (task.action === "SUSPEND") {
    const request: TenantProvisioningDriverRequest = {
      version: 1,
      operationId: task.operationId,
      zammadInstanceId: task.zammadInstanceId,
      tenantId: task.tenantId,
      action: "SUSPEND",
      fencingToken: task.fencingToken,
      idempotencyKey: `suspend:${task.tenantId}:${task.operationId}`,
      spec: task.spec,
      completedSteps: task.completedSteps,
      priorResults: task.stepResults,
    };
    const result = await driver.execute(request);
    if (!(await repository.completeSuspension(task, leaseId, result.outputs))) {
      throw new StaleTenantProvisioningLeaseError();
    }
    return;
  }

  if (task.action === "RESUME") {
    const resumePhase = task.currentStep === "resume_publish" ? "PUBLISH" : "PREPARE";
    const request: TenantProvisioningDriverRequest = {
      version: 1,
      operationId: task.operationId,
      zammadInstanceId: task.zammadInstanceId,
      tenantId: task.tenantId,
      action: "RESUME",
      resumePhase,
      fencingToken: task.fencingToken,
      idempotencyKey: `resume:${task.tenantId}:${task.operationId}:${resumePhase.toLowerCase()}`,
      spec: task.spec,
      completedSteps: task.completedSteps,
      priorResults: task.stepResults,
    };
    const result = await driver.execute(request);
    const changed = resumePhase === "PREPARE"
      ? await repository.authorizeResumption(task, leaseId, result.outputs)
      : await repository.completeResumption(task, leaseId, result.outputs);
    if (!changed) {
      throw new StaleTenantProvisioningLeaseError();
    }
    if (resumePhase === "PREPARE") kick();
    return;
  }

  const step = nextStep(task.completedSteps);
  if (!step) {
    throw new ProvisioningDriverError(
      "PROVISIONING_STATE_INVALID",
      "Provisioning has no remaining step but is not complete.",
      false,
    );
  }
  if (!(await repository.startStep(task, leaseId, step))) {
    throw new StaleTenantProvisioningLeaseError();
  }
  const request: TenantProvisioningDriverRequest = {
    version: 1,
    operationId: task.operationId,
    zammadInstanceId: task.zammadInstanceId,
    tenantId: task.tenantId,
    action: "PROVISION",
    step,
    fencingToken: task.fencingToken,
    idempotencyKey: `provision:${task.tenantId}:${task.operationId}:${step}`,
    spec: task.spec,
    completedSteps: task.completedSteps,
    priorResults: task.stepResults,
  };
  const result = await driver.execute(request);
  if (!(await repository.completeStep(task, leaseId, step, result.outputs))) {
    throw new StaleTenantProvisioningLeaseError();
  }
  kick();
}

export function nextStep(
  completed: TenantProvisioningStep[],
): TenantProvisioningStep | null {
  const unique = new Set(completed);
  if (unique.size !== completed.length) {
    throw new ProvisioningDriverError(
      "PROVISIONING_STATE_INVALID",
      "Provisioning completion history is invalid.",
      false,
    );
  }
  for (let index = 0; index < completed.length; index += 1) {
    if (completed[index] !== tenantProvisioningSteps[index]) {
      throw new ProvisioningDriverError(
        "PROVISIONING_STATE_INVALID",
        "Provisioning completion history is out of order.",
        false,
      );
    }
  }
  return tenantProvisioningSteps[completed.length] ?? null;
}

function classifyFailure(error: unknown, attempts: number) {
  if (error instanceof ProvisioningDriverError) {
    return {
      retryable: error.retryable,
      code: error.code.slice(0, 100),
      safeError: error.safeError.slice(0, 500),
      ...(error.retryable ? { retryAt: retryTime(attempts) } : {}),
    };
  }
  return {
    retryable: true,
    code: "PROVISIONING_WORKER_FAILURE",
    safeError: "The provisioning worker encountered a temporary internal failure.",
    retryAt: retryTime(attempts),
  };
}

function retryTime(attempts: number) {
  const seconds = Math.min(900, 15 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1_000).toISOString();
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
      `Provisioning worker value must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
