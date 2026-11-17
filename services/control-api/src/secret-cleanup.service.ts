import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { randomInt, randomUUID } from "node:crypto";
import {
  SecretSidecarWriteError,
  SecretProvisioningService,
} from "./secret-provisioning.service.js";
import {
  SecretCleanupRepository,
  type SecretCleanupStore,
  type SecretCleanupTask,
} from "./secret-cleanup.repository.js";
import { isTenantOwnedSecretReference } from "./connection-secret-reference.js";

export type SecretCleanupDrainResult = {
  claimed: number;
  succeeded: number;
  failedRetryable: number;
  failedTerminal: number;
  leaseLost: number;
};

type SecretWriter = Pick<SecretProvisioningService, "deleteSecret">;
type CleanupResult = "succeeded" | "failed-retryable" | "failed-terminal" | "lease-lost";

export class SecretCleanupProcessor {
  constructor(
    private readonly repository: SecretCleanupStore,
    private readonly secrets: SecretWriter,
    private readonly batchSize = 25,
  ) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new Error("Secret cleanup batch size must be between 1 and 100");
    }
  }

  async drain(): Promise<SecretCleanupDrainResult> {
    const leaseId = randomUUID();
    const tasks = await this.repository.claim(leaseId, this.batchSize);
    const outcomes = await Promise.all(tasks.map((task) => this.process(task, leaseId)));
    return {
      claimed: tasks.length,
      succeeded: count(outcomes, "succeeded"),
      failedRetryable: count(outcomes, "failed-retryable"),
      failedTerminal: count(outcomes, "failed-terminal"),
      leaseLost: count(outcomes, "lease-lost"),
    };
  }

  private async process(task: SecretCleanupTask, leaseId: string): Promise<CleanupResult> {
    if (!isTenantOwnedSecretReference(task.secretReference, task.tenantId)) {
      const persisted = await this.repository.fail(task, leaseId, {
        retryable: false,
        code: "SECRET_REFERENCE_INVALID",
        safeError: "Secret cleanup ownership validation failed.",
      });
      return persisted ? "failed-terminal" : "lease-lost";
    }
    try {
      await this.secrets.deleteSecret(task.secretReference);
      return (await this.repository.complete(task, leaseId)) ? "succeeded" : "lease-lost";
    } catch (error) {
      const classified = classifyCleanupFailure(error);
      const retryable = classified.retryable && task.attempts < task.maxAttempts;
      const persisted = await this.repository.fail(task, leaseId, {
        retryable,
        code: retryable ? classified.code : terminalCode(classified.code, task),
        safeError: retryable
          ? classified.safeError
          : terminalMessage(classified.safeError, classified.retryable, task),
        ...(retryable ? { retryAt: retryTimestamp(task.attempts) } : {}),
      });
      if (!persisted) return "lease-lost";
      return retryable ? "failed-retryable" : "failed-terminal";
    }
  }
}

@Injectable()
export class SecretCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly processor: SecretCleanupProcessor;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private active?: Promise<SecretCleanupDrainResult>;

  constructor(repository: SecretCleanupRepository, secrets: SecretProvisioningService) {
    this.processor = new SecretCleanupProcessor(
      repository,
      secrets,
      boundedInteger("SECRET_CLEANUP_BATCH_SIZE", 25, 1, 100),
    );
    this.intervalMs = boundedInteger("SECRET_CLEANUP_INTERVAL_MS", 10_000, 1_000, 300_000);
  }

  onApplicationBootstrap() {
    void this.runScheduled();
    this.timer = setInterval(() => void this.runScheduled(), this.intervalMs);
    this.timer.unref();
  }

  drainOnce() {
    if (this.active) return this.active;
    const running = this.processor.drain();
    const tracked = running.finally(() => {
      if (this.active === tracked) this.active = undefined;
    });
    this.active = tracked;
    return tracked;
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.active?.catch(() => undefined);
  }

  private async runScheduled() {
    try {
      await this.drainOnce();
    } catch {
      // References and provider details are intentionally excluded from logs.
      process.stderr.write(`${JSON.stringify({ level: "error", event: "secret-cleanup.tick.failed" })}\n`);
    }
  }
}

export function classifyCleanupFailure(error: unknown) {
  if (error instanceof SecretSidecarWriteError) {
    return {
      retryable: error.retryable,
      code: boundedCode(error.code),
      safeError: boundedMessage(error.safeError),
    };
  }
  return {
    retryable: true,
    code: "SECRET_CLEANUP_UNEXPECTED_FAILURE",
    safeError: "Secret cleanup failed temporarily.",
  };
}

function retryTimestamp(attempts: number) {
  const exponential = Math.min(900_000, 1_000 * 2 ** Math.min(attempts, 10));
  const jitter = randomInt(0, Math.max(1, Math.floor(exponential / 4)));
  return new Date(Date.now() + exponential + jitter).toISOString();
}

function terminalCode(code: string, task: SecretCleanupTask) {
  return task.attempts >= task.maxAttempts && !code.endsWith("_EXHAUSTED")
    ? `${code}_EXHAUSTED`.slice(0, 100)
    : code;
}

function terminalMessage(message: string, wasRetryable: boolean, task: SecretCleanupTask) {
  if (!wasRetryable || task.attempts < task.maxAttempts) return message;
  return `${message} The retry limit was reached.`.slice(0, 500);
}

function boundedCode(value: string) {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/gu, "_").slice(0, 100);
  return normalized || "SECRET_CLEANUP_FAILED";
}

function boundedMessage(value: string) {
  return value.trim().slice(0, 500) || "Secret cleanup failed.";
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function count(values: CleanupResult[], expected: CleanupResult) {
  return values.filter((value) => value === expected).length;
}
