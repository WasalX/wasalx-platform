import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { ProviderError, type ProviderRequest, type ProviderResponse } from "./types.js";

export type Claim = { kind: "CLAIMED"; token: string } | { kind: "REPLAY"; response: ProviderResponse };

export interface ProviderStore {
  claim(input: ProviderRequest): Promise<Claim>;
  complete(input: ProviderRequest, claimToken: string, response: ProviderResponse): Promise<void>;
  release(input: ProviderRequest, claimToken: string, code: string): Promise<void>;
  fail(input: ProviderRequest, claimToken: string, code: string, rollbackPending: boolean): Promise<void>;
  rollbackIfAuthoritative(
    input: ProviderRequest,
    claimToken: string,
    rollback: () => Promise<void>,
  ): Promise<boolean>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresProviderStore implements ProviderStore {
  private readonly pool: Pool;
  constructor(connectionString: string, private readonly leaseSeconds = 30) {
    this.pool = new Pool({ connectionString, max: 10, statement_timeout: 15_000, application_name: "wasalx-workspace-provider" });
  }

  async claim(input: ProviderRequest): Promise<Claim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenant_id]);
      await client.query("INSERT INTO workspace_provider.tenants (tenant_id, highest_fencing_token) VALUES ($1,$2) ON CONFLICT DO NOTHING", [input.tenant_id, input.fencing_token]);
      const tenant = await client.query<{ highest_fencing_token: string }>("SELECT highest_fencing_token FROM workspace_provider.tenants WHERE tenant_id=$1 FOR UPDATE", [input.tenant_id]);
      const highest = Number(tenant.rows[0]?.highest_fencing_token);
      if (input.fencing_token < highest) throw new ProviderError(409, "STALE_FENCING_TOKEN", "A newer provider operation already exists.");
      if (input.fencing_token > highest) {
        await client.query("UPDATE workspace_provider.tenants SET highest_fencing_token=$2, updated_at=clock_timestamp() WHERE tenant_id=$1", [input.tenant_id, input.fencing_token]);
        await client.query("UPDATE workspace_provider.operations SET state='SUPERSEDED', claim_token=NULL, claim_expires_at=NULL, updated_at=clock_timestamp() WHERE tenant_id=$1 AND fencing_token<$2 AND state IN ('PENDING','ROLLBACK_PENDING')", [input.tenant_id, input.fencing_token]);
      }
      const requestSha = sha256(JSON.stringify(input));
      const existing = await client.query<{ request_sha256: string; action: string; fencing_token: string; state: string; response_json: ProviderResponse | null; claim_expires_at: Date | null }>(
        "SELECT request_sha256, action, fencing_token, state, response_json, claim_expires_at FROM workspace_provider.operations WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [input.tenant_id, input.idempotency_key],
      );
      const row = existing.rows[0];
      if (row && (row.request_sha256 !== requestSha || row.action !== input.action || Number(row.fencing_token) !== input.fencing_token)) {
        throw new ProviderError(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different request.");
      }
      if (row?.state === "READY" && row.response_json) {
        await this.appendAudit(client, input, "REPLAYED", { state: "READY" });
        await client.query("COMMIT");
        return { kind: "REPLAY", response: row.response_json };
      }
      if (row?.claim_expires_at && row.claim_expires_at.getTime() > Date.now()) {
        throw new ProviderError(503, "OPERATION_IN_PROGRESS", "The provider operation is already in progress.", true);
      }
      const claimToken = randomUUID();
      await client.query(
        `INSERT INTO workspace_provider.operations (tenant_id,idempotency_key,operation_id,action,fencing_token,request_sha256,request_json,state,claim_token,claim_expires_at,attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,clock_timestamp()+($9 || ' seconds')::interval,1)
         ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET state='PENDING', claim_token=EXCLUDED.claim_token, claim_expires_at=EXCLUDED.claim_expires_at, attempts=workspace_provider.operations.attempts+1, updated_at=clock_timestamp()`,
        [input.tenant_id, input.idempotency_key, input.operation_id, input.action, input.fencing_token, requestSha, input, claimToken, this.leaseSeconds],
      );
      await this.appendAudit(client, input, row ? "RETRY_CLAIMED" : "CLAIMED", { action: input.action });
      await client.query("COMMIT");
      return { kind: "CLAIMED", token: claimToken };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async complete(input: ProviderRequest, claimToken: string, response: ProviderResponse) {
    await this.transition(input, claimToken, "READY", "READY", response);
  }
  async release(input: ProviderRequest, claimToken: string, code: string) {
    await this.transition(input, claimToken, "PENDING", code);
  }
  async fail(input: ProviderRequest, claimToken: string, code: string, rollbackPending: boolean) {
    await this.transition(input, claimToken, rollbackPending ? "ROLLBACK_PENDING" : "FAILED", code);
  }
  async rollbackIfAuthoritative(
    input: ProviderRequest,
    claimToken: string,
    rollback: () => Promise<void>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenant_id]);
      const tenant = await client.query<{ highest_fencing_token: string }>(
        "SELECT highest_fencing_token FROM workspace_provider.tenants WHERE tenant_id=$1 FOR UPDATE",
        [input.tenant_id],
      );
      const operation = await client.query<{ state: string; claim_token: string | null }>(
        "SELECT state,claim_token FROM workspace_provider.operations WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE",
        [input.tenant_id, input.idempotency_key],
      );
      if (
        Number(tenant.rows[0]?.highest_fencing_token) !== input.fencing_token ||
        operation.rows[0]?.state !== "ROLLBACK_PENDING" ||
        operation.rows[0]?.claim_token !== claimToken
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      // Holding the per-tenant row lock makes rollback and a newer claim
      // mutually exclusive. An older fence can therefore never patch Absent
      // after a newer fence has started restoring the resource.
      await rollback();
      await client.query(
        "UPDATE workspace_provider.operations SET state='ROLLED_BACK', claim_token=NULL, claim_expires_at=NULL, updated_at=clock_timestamp() WHERE tenant_id=$1 AND idempotency_key=$2 AND claim_token=$3",
        [input.tenant_id, input.idempotency_key, claimToken],
      );
      await this.appendAudit(client, input, "ROLLED_BACK", { state: "ROLLED_BACK" });
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async ready() {
    try { return (await this.pool.query<{ ok: boolean }>("SELECT to_regclass('workspace_provider.operations') IS NOT NULL AND COALESCE(has_table_privilege(to_regclass('workspace_provider.operations'),'SELECT'),false) AS ok")).rows[0]?.ok === true; }
    catch { return false; }
  }
  async close() { await this.pool.end(); }

  private async transition(input: ProviderRequest, claimToken: string, state: string, event: string, response?: ProviderResponse) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.tenant_id]);
      await client.query("SELECT highest_fencing_token FROM workspace_provider.tenants WHERE tenant_id=$1 FOR UPDATE", [input.tenant_id]);
      const updated = await client.query(
        `UPDATE workspace_provider.operations
            SET state=$4,response_json=$5,
                error_code=CASE WHEN $4='READY' THEN NULL ELSE $6 END,
                claim_token=CASE WHEN $4='ROLLBACK_PENDING' THEN claim_token ELSE NULL END,
                claim_expires_at=CASE WHEN $4='ROLLBACK_PENDING' THEN claim_expires_at ELSE NULL END,
                updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND idempotency_key=$2 AND claim_token=$3 AND fencing_token=$7`,
        [input.tenant_id, input.idempotency_key, claimToken, state, response ?? null, event, input.fencing_token],
      );
      if (updated.rowCount !== 1) throw new ProviderError(409, "CLAIM_LOST", "The provider operation lease was lost.");
      await this.appendAudit(client, input, event, { state });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async appendAudit(client: PoolClient, input: ProviderRequest, eventType: string, details: Record<string, unknown>) {
    const prior = await client.query<{ event_sha256: string }>("SELECT event_sha256 FROM workspace_provider.audit_events WHERE tenant_id=$1 ORDER BY event_id DESC LIMIT 1", [input.tenant_id]);
    const previous = prior.rows[0]?.event_sha256 ?? null;
    const safe = { ...details, idempotency_key_sha256: sha256(input.idempotency_key) };
    const hash = sha256(JSON.stringify([previous, input.tenant_id, input.operation_id, eventType, input.fencing_token, safe]));
    await client.query("INSERT INTO workspace_provider.audit_events (tenant_id,operation_id,event_type,fencing_token,previous_event_sha256,event_sha256,safe_details) VALUES ($1,$2,$3,$4,$5,$6,$7)", [input.tenant_id, input.operation_id, eventType, input.fencing_token, previous, hash, safe]);
  }
}

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
