BEGIN;

ALTER TABLE message_links
  ADD CONSTRAINT message_links_tenant_id_id_key UNIQUE (tenant_id,id);

CREATE TABLE group_workspace_ticket_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_instance_id uuid NOT NULL,
  zammad_user_id text NOT NULL CHECK (zammad_user_id ~ '^[1-9][0-9]{0,15}$'),
  whatsapp_group_id uuid NOT NULL,
  normalized_message_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 255
    AND idempotency_key ~ '^[A-Za-z0-9:_-]+$'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  message_link_id uuid NOT NULL,
  zammad_ticket_id text NOT NULL CHECK (zammad_ticket_id ~ '^[1-9][0-9]{0,15}$'),
  zammad_article_id text NOT NULL CHECK (zammad_article_id ~ '^[1-9][0-9]{0,15}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  CONSTRAINT group_workspace_ticket_receipt_instance_fk
    FOREIGN KEY (tenant_id,zammad_instance_id)
    REFERENCES zammad_instances(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT group_workspace_ticket_receipt_group_fk
    FOREIGN KEY (tenant_id,whatsapp_group_id)
    REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT group_workspace_ticket_receipt_message_fk
    FOREIGN KEY (tenant_id,normalized_message_id)
    REFERENCES normalized_messages(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT group_workspace_ticket_receipt_link_fk
    FOREIGN KEY (tenant_id,message_link_id)
    REFERENCES message_links(tenant_id,id) ON DELETE CASCADE
);

ALTER TABLE group_workspace_ticket_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_workspace_ticket_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_workspace_ticket_receipts
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

GRANT SELECT,INSERT ON group_workspace_ticket_receipts TO wasalx_app;
REVOKE UPDATE,DELETE,TRUNCATE ON group_workspace_ticket_receipts FROM PUBLIC,wasalx_app;

COMMIT;
