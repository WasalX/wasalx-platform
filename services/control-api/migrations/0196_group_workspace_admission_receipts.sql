BEGIN;

-- Admission/cancellation metadata survives content retention; this is not a work queue.
CREATE TABLE group_workspace_operation_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_instance_id uuid NOT NULL,
  zammad_user_id text NOT NULL CHECK (zammad_user_id ~ '^[1-9][0-9]{0,15}$'),
  whatsapp_group_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SEND','REACTION')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255 AND idempotency_key ~ '^[A-Za-z0-9:_-]+$'),
  target_message_id uuid,
  request_sha256 text CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('ADMITTED','CANCELLED')),
  delivery_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  CHECK ((kind='SEND' AND target_message_id IS NULL) OR (kind='REACTION' AND target_message_id IS NOT NULL)),
  CHECK ((disposition='ADMITTED' AND delivery_id IS NOT NULL AND request_sha256 IS NOT NULL)
    OR (disposition='CANCELLED' AND delivery_id IS NULL AND request_sha256 IS NULL)),
  FOREIGN KEY (tenant_id,zammad_instance_id) REFERENCES zammad_instances(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,whatsapp_group_id) REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE,
  -- PrivacyRepository.finalize redacts deliveries in place; retain admission metadata with that stable row.
  FOREIGN KEY (tenant_id,delivery_id) REFERENCES delivery_outbox(tenant_id,id)
);

ALTER TABLE group_workspace_operation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_workspace_operation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_workspace_operation_receipts
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT ON group_workspace_operation_receipts TO wasalx_app;
REVOKE UPDATE,DELETE,TRUNCATE ON group_workspace_operation_receipts FROM PUBLIC,wasalx_app;

COMMIT;
