BEGIN;

INSERT INTO tenants (id, name, slug, state, retention_days)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'WasalX Qualification Workspace',
  'qualification-workspace',
  'ACTIVE',
  90
)
ON CONFLICT (id) DO UPDATE
SET name = CASE WHEN tenants.name = 'WasalX Demo Operations' THEN EXCLUDED.name ELSE tenants.name END,
    slug = CASE WHEN tenants.slug = 'demo-operations' THEN EXCLUDED.slug ELSE tenants.slug END,
    updated_at = CASE
      WHEN tenants.name = 'WasalX Demo Operations' OR tenants.slug = 'demo-operations' THEN now()
      ELSE tenants.updated_at
    END;

INSERT INTO tenants (id, name, slug, state, retention_days)
VALUES (
  '00000000-0000-4000-8000-000000000011',
  'WasalX Isolation Workspace',
  'isolation-workspace',
  'ACTIVE',
  90
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO users (id, oidc_subject, email, display_name)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'fixture-0006@example.test',
  'Qualification Owner'
)
ON CONFLICT (oidc_subject) DO UPDATE
SET email = EXCLUDED.email,
    display_name = EXCLUDED.display_name;

INSERT INTO tenant_memberships (tenant_id, user_id, role)
VALUES
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'tenant_owner'),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000002', 'tenant_owner')
ON CONFLICT (tenant_id, user_id) DO UPDATE
SET role = EXCLUDED.role;

INSERT INTO zammad_instances (
  id,
  tenant_id,
  base_url,
  agent_base_url,
  version,
  state,
  database_reference,
  search_namespace,
  storage_prefix,
  service_secret_reference,
  privacy_secret_reference
)
VALUES (
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000001',
  'http://zammad-nginx:8080',
  'http://127.0.0.1:8081',
  '7.1.3-0000',
  'PROVISIONING',
  'docker://zammad-postgresql/zammad_production',
  'wasalx-qualification',
  'tenant/00000000-0000-4000-8000-000000000001',
  'secret://tenants/00000000-0000-4000-8000-000000000001/zammad/service',
  'secret://tenants/00000000-0000-4000-8000-000000000001/zammad/privacy'
)
ON CONFLICT (tenant_id) DO UPDATE
SET base_url = EXCLUDED.base_url,
    agent_base_url = EXCLUDED.agent_base_url,
    version = EXCLUDED.version,
    database_reference = EXCLUDED.database_reference,
    search_namespace = EXCLUDED.search_namespace,
    storage_prefix = EXCLUDED.storage_prefix,
    service_secret_reference = EXCLUDED.service_secret_reference,
    privacy_secret_reference = EXCLUDED.privacy_secret_reference;

COMMIT;
