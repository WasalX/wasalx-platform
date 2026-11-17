import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("workspace provider image is pinned, non-root, TLS-only, and includes migrations", async () => {
  const dockerfile = await read("Dockerfile.workspace-provider");
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}/mu);
  assert.match(dockerfile, /USER 65532:65532/u);
  assert.match(dockerfile, /services\/workspace-provider\/migrations/u);
  assert.match(dockerfile, /https.*health\/live/u);
});

test("workspace provider Helm contract is isolated, least-privilege, and fail-closed", async () => {
  const [template, values, schema, crd] = await Promise.all([
    read("infra/helm/wasalx/templates/workspace-provider.yaml"),
    read("infra/helm/wasalx/values.yaml"),
    read("infra/helm/wasalx/values.schema.json"),
    read("infra/helm/wasalx/crds/providers.wasalx.io_workspaceproviderresources.yaml"),
  ]);
  assert.match(template, /automountServiceAccountToken: false/u);
  assert.match(template, /resources: \[workspaceproviderresources\]/u);
  assert.doesNotMatch(template, /resources: \[\*\]|verbs: \[\*\]/u);
  assert.match(template, /policyTypes: \[Ingress, Egress\]/u);
  assert.match(template, /WORKSPACE_PROVIDER_MIGRATION_DATABASE_URL/u);
  assert.match(template, /WORKSPACE_PROVIDER_TLS_CERT_FILE/u);
  assert.match(template, /WORKSPACE_PROVIDER_OPERATOR_DEPLOYMENTS_JSON/u);
  assert.match(template, /name: wasalx-workspace-provider-migration[\s\S]*helm\.sh\/hook-weight: "-6"[\s\S]*argocd\.argoproj\.io\/hook: PreSync/u);
  assert.match(values, /workspaceProvider:\r?\n {2}enabled: false/u);
  assert.match(schema, /"image": \{ "pattern": "@sha256:/u);
  assert.match(schema, /"allowedEgressCidrs": \{ "minItems": 1 \}/u);
  assert.match(crd, /immutableProperties:[\s\S]*instance_id/u);
  assert.match(crd, /wasalx\.io\/contract-version: "commercial-go-v1"/u);
  assert.match(crd, /enum: \[identity, database, search, storage, secrets, zammad, package, oidc, defaults, health, suspend\]/u);
  assert.match(crd, /self\.fencingToken >= oldSelf\.fencingToken/u);
  assert.match(crd, /self\.operationId == oldSelf\.operationId/u);
  assert.match(crd, /self\.idempotencyKey == oldSelf\.idempotencyKey/u);
  assert.match(crd, /self\.refreshSequence > oldSelf\.refreshSequence/u);
  assert.match(crd, /self\.requestContextSha256 == oldSelf\.requestContextSha256/u);
  assert.match(crd, /self\.lifecycle == 'Absent'/u);
  assert.match(crd, /Provider resource tenant, type, and secret bindings are immutable/u);
  assert.match(crd, /self\.desired == oldSelf\.desired/u);
  assert.match(crd, /self\.requestContextSha256 != oldSelf\.requestContextSha256/u);
  assert.match(crd, /self\.idempotencyKey\.startsWith\('controller:' \+ self\.tenantId/u);
  assert.match(crd, /self\.idempotencyKey\.matches\('\^controller:\[0-9a-f-\]\{36\}/u);
  assert.match(crd, /int\(self\.idempotencyKey\.substring[\s\S]*== self\.refreshSequence/u);
  assert.match(crd, /self\.desired\.tenant_id == self\.tenantId/u);
  assert.equal((crd.match(/required: \[instance_id, redis_host, redis_username\]/gu) ?? []).length, 2);
});

test("workspace provider persistence has fencing, tenant isolation, replay, rollback, and chained audit contracts", async () => {
  const [sql, repeatedVerify, tenantSecurity, repository, migrator] = await Promise.all([
    read("services/workspace-provider/migrations/0001_workspace_provider.sql"),
    read("services/workspace-provider/migrations/0002_repeated_verify_operations.sql"),
    read("services/workspace-provider/migrations/0003_tenant_security.sql"),
    read("services/workspace-provider/src/repository.ts"),
    read("services/workspace-provider/src/migrate.ts"),
  ]);
  assert.match(sql, /highest_fencing_token bigint NOT NULL/u);
  assert.match(sql, /UNIQUE \(tenant_id, operation_id, action\)/u);
  assert.match(repeatedVerify, /DROP CONSTRAINT IF EXISTS operations_tenant_id_operation_id_action_key/u);
  assert.match(repeatedVerify, /tenant_id, operation_id, action, fencing_token/u);
  assert.match(repeatedVerify, /'verify','suspend','resume'/u);
  assert.match(repository, /SELECT highest_fencing_token[\s\S]*FOR UPDATE/u);
  assert.equal((repository.match(/await client\.query\("BEGIN"\);\s+await client\.query\("SELECT set_config\('app\.tenant_id',\$1,true\)", \[input\.tenant_id\]\);/gu) ?? []).length, 3);
  assert.match(repository, /COALESCE\(has_table_privilege\(to_regclass\('workspace_provider\.operations'\),'SELECT'\),false\) AS ok/u);
  assert.match(repository, /await rollback\(\)/u);
  assert.match(migrator, /readdir\(directory\)/u);
  assert.match(migrator, /pg_advisory_lock/u);
  assert.match(migrator, /for \(const migration of migrations\)/u);
  assert.match(sql, /'ROLLBACK_PENDING','ROLLED_BACK'/u);
  assert.match(sql, /previous_event_sha256 char\(64\)/u);
  assert.match(sql, /REVOKE ALL ON ALL TABLES/u);
  assert.match(tenantSecurity, /current_setting\('app\.tenant_id', true\)/u);
  assert.match(tenantSecurity, /tenant context is required/u);
  assert.equal((tenantSecurity.match(/FORCE ROW LEVEL SECURITY/gu) ?? []).length, 3);
  assert.equal((tenantSecurity.match(/DROP POLICY IF EXISTS tenant_isolation/gu) ?? []).length, 3);
  assert.equal((tenantSecurity.match(/tenant_id = workspace_provider\.current_tenant_id\(\)/gu) ?? []).length, 6);
  assert.match(tenantSecurity, /DROP TRIGGER IF EXISTS workspace_provider_audit_events_append_only/u);
  assert.match(tenantSecurity, /workspace_provider_audit_events_append_only/u);
  assert.match(tenantSecurity, /GRANT SELECT, INSERT ON workspace_provider\.audit_events/u);
  assert.doesNotMatch(tenantSecurity, /GRANT[^;]*UPDATE[^;]*audit_events/u);
});
