import { Pool, type PoolClient } from "pg";

export type RequestedIdentityPolicy = {
  tenant_id: string;
  version: string;
  sso_enforcement_state: "DISABLED" | "REQUESTED";
  sso_provider_name: string | null;
  sso_issuer: string | null;
  sso_email_domains: string[];
  mfa_required_roles: string[];
  session_timeout_minutes: number;
  privileged_reauth_minutes: number;
  support_access_requires_approval: boolean;
  security_policy_state: "REQUESTED";
};

export interface IdentityPolicyStore {
  withRequestedPolicy<T>(
    tenantId: string,
    version: number,
    operation: (policy: RequestedIdentityPolicy, activate: (evidenceSha256: string) => Promise<boolean>) => Promise<T>,
  ): Promise<T | null>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresIdentityPolicyStore implements IdentityPolicyStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      statement_timeout: 15_000,
      application_name: "wasalx-identity-policy-activator",
    });
  }

  async withRequestedPolicy<T>(
    tenantId: string,
    version: number,
    operation: (policy: RequestedIdentityPolicy, activate: (evidenceSha256: string) => Promise<boolean>) => Promise<T>,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<RequestedIdentityPolicy>(
        "SELECT * FROM app.requested_tenant_identity_policy($1,$2)",
        [tenantId, version],
      );
      const policy = result.rows[0];
      if (!policy) {
        await client.query("ROLLBACK");
        return null;
      }
      const output = await operation(policy, (evidenceSha256) => activate(client, tenantId, version, evidenceSha256));
      await client.query("COMMIT");
      return output;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
}

async function activate(
  client: PoolClient,
  tenantId: string,
  version: number,
  evidenceSha256: string,
) {
  const result = await client.query<{ activated: boolean }>(
    "SELECT app.activate_tenant_identity_policy($1,$2,$3) AS activated",
    [tenantId, version, evidenceSha256],
  );
  return result.rows[0]?.activated === true;
}
