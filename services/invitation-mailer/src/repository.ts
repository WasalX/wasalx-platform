import { Pool, type PoolClient, type QueryResultRow } from "pg";

export type InvitationEmailJob = {
  id: string;
  tenant_id: string;
  invitation_id: string;
  action: "INVITE" | "RESEND";
  recipient_email: string;
  token_ciphertext: Buffer;
  token_key_version: string;
  idempotency_key: string;
  attempts: number;
  fencing_token: string;
  expires_at?: string;
};

export interface InvitationMailerStore {
  claim(workerId: string, batchSize: number): Promise<InvitationEmailJob[]>;
  complete(job: InvitationEmailJob, workerId: string, providerMessageId: string): Promise<boolean>;
  fail(job: InvitationEmailJob, workerId: string, input: {
    retryable: boolean;
    code: string;
    safeError: string;
    nextAttemptAt: Date;
  }): Promise<boolean>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresInvitationMailerStore implements InvitationMailerStore {
  private readonly pool: Pool;
  private readonly tenantId: string | undefined;

  constructor(
    connectionString: string,
    tenantId?: string,
  ) {
    this.tenantId = tenantId;
    this.pool = new Pool({
      connectionString,
      max: 4,
      statement_timeout: 15_000,
      application_name: "wasalx-invitation-mailer",
    });
  }

  async claim(workerId: string, batchSize: number) {
    const tenantIds = this.tenantId
      ? [this.tenantId]
      : (await this.pool.query<{ tenant_id: string }>(
          "SELECT app.pending_invitation_email_tenants($1) AS tenant_id",
          [batchSize],
        )).rows.map((row) => row.tenant_id);
    const jobs: InvitationEmailJob[] = [];
    for (const tenantId of tenantIds) {
      const remaining = batchSize - jobs.length;
      if (remaining < 1) break;
      jobs.push(...await this.claimTenant(tenantId, workerId, remaining));
    }
    return jobs;
  }

  private async claimTenant(tenantId: string, workerId: string, batchSize: number) {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<InvitationEmailJob & QueryResultRow>(
        `SELECT job.*, invitation.expires_at
           FROM app.claim_invitation_email_jobs($1,$2) job
           JOIN tenant_invitations invitation
             ON invitation.tenant_id=job.tenant_id AND invitation.id=job.invitation_id`,
        [workerId, batchSize],
      );
      return result.rows.map((row) => ({
        ...row,
        attempts: Number(row.attempts),
        expires_at: invitationExpiry(row.expires_at),
      }));
    });
  }

  async complete(job: InvitationEmailJob, workerId: string, providerMessageId: string) {
    this.assertTenant(job.tenant_id);
    return this.withTenant(job.tenant_id, async (client) => {
      const result = await client.query<{ completed: boolean }>(
        "SELECT app.complete_invitation_email_job($1,$2,$3,$4) AS completed",
        [job.id, workerId, job.fencing_token, providerMessageId],
      );
      return result.rows[0]?.completed === true;
    });
  }

  async fail(job: InvitationEmailJob, workerId: string, input: {
    retryable: boolean;
    code: string;
    safeError: string;
    nextAttemptAt: Date;
  }) {
    this.assertTenant(job.tenant_id);
    return this.withTenant(job.tenant_id, async (client) => {
      const result = await client.query<{ failed: boolean }>(
        "SELECT app.fail_invitation_email_job($1,$2,$3,$4,$5,$6,$7) AS failed",
        [job.id, workerId, job.fencing_token, input.retryable, input.code, input.safeError, input.nextAttemptAt],
      );
      return result.rows[0]?.failed === true;
    });
  }

  async ready() {
    try {
      const result = await this.pool.query<{ ok: number }>("SELECT 1 AS ok");
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }

  private async withTenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private assertTenant(tenantId: string) {
    if (this.tenantId && tenantId !== this.tenantId) {
      throw new Error("Invitation mailer tenant scope mismatch");
    }
  }
}

export function invitationExpiry(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid invitation expiry");
  return date.toISOString();
}
