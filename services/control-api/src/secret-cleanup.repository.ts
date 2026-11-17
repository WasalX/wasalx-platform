import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";

export type SecretCleanupTask = {
  id: string;
  tenantId: string;
  secretReference: string;
  attempts: number;
  maxAttempts: number;
  fencingToken: number;
};

type CleanupRow = {
  task_id: string;
  tenant_id: string;
  secret_reference: string;
  attempts: number;
  max_attempts: number;
  fencing_token: string | number;
};

export interface SecretCleanupStore {
  claim(leaseId: string, limit: number): Promise<SecretCleanupTask[]>;
  complete(task: SecretCleanupTask, leaseId: string): Promise<boolean>;
  fail(
    task: SecretCleanupTask,
    leaseId: string,
    failure: { retryable: boolean; code: string; safeError: string; retryAt?: string },
  ): Promise<boolean>;
}

@Injectable()
export class SecretCleanupRepository implements SecretCleanupStore, OnModuleDestroy {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.SECRET_CLEANUP_DATABASE_URL;
    if (!connectionString) throw new Error("SECRET_CLEANUP_DATABASE_URL is required");
    this.pool = new Pool({
      connectionString,
      max: boundedInteger(process.env.SECRET_CLEANUP_DATABASE_POOL_SIZE, 2, 1, 10),
      statement_timeout: 15_000,
      application_name: "wasalx-secret-cleanup",
    });
  }

  async claim(leaseId: string, limit: number) {
    const result = await this.pool.query<CleanupRow>(
      "SELECT * FROM app.claim_secret_cleanup_tasks($1, $2)",
      [leaseId, limit],
    );
    return result.rows.map((row) => ({
      id: row.task_id,
      tenantId: row.tenant_id,
      secretReference: row.secret_reference,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      fencingToken: safeFencingToken(row.fencing_token),
    }));
  }

  async complete(task: SecretCleanupTask, leaseId: string) {
    const result = await this.pool.query<{ completed: boolean }>(
      "SELECT app.complete_secret_cleanup_task($1, $2, $3) AS completed",
      [task.id, leaseId, task.fencingToken],
    );
    return result.rows[0]?.completed === true;
  }

  async fail(
    task: SecretCleanupTask,
    leaseId: string,
    failure: { retryable: boolean; code: string; safeError: string; retryAt?: string },
  ) {
    const result = await this.pool.query<{ failed: boolean }>(
      "SELECT app.fail_secret_cleanup_task($1, $2, $3, $4, $5, $6, $7) AS failed",
      [
        task.id,
        leaseId,
        task.fencingToken,
        failure.retryable,
        failure.code,
        failure.safeError,
        failure.retryAt ?? null,
      ],
    );
    return result.rows[0]?.failed === true;
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

function safeFencingToken(value: string | number) {
  const token = Number(value);
  if (!Number.isSafeInteger(token) || token < 0) {
    throw new Error("Database returned an invalid cleanup fencing token");
  }
  return token;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Secret cleanup database pool size must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
