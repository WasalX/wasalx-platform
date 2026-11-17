BEGIN;

ALTER TABLE tenant_settings
  ADD COLUMN group_workspace_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN group_history_default_retention_days integer NOT NULL DEFAULT 90
    CHECK (group_history_default_retention_days BETWEEN 1 AND 3650),
  ADD COLUMN group_history_default_visibility text NOT NULL DEFAULT 'RESTRICTED'
    CHECK (group_history_default_visibility IN ('RESTRICTED','ALL_AGENTS'));

CREATE TABLE group_workspace_settings (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_group_id uuid NOT NULL,
  capture_enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  visibility text NOT NULL CHECK (visibility IN ('RESTRICTED','ALL_AGENTS')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,whatsapp_group_id),
  FOREIGN KEY (tenant_id,whatsapp_group_id)
    REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE,
  CHECK (
    (capture_enabled AND enabled_at IS NOT NULL)
    OR (NOT capture_enabled)
  )
);

CREATE TABLE group_workspace_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_group_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('USER','TEAM')),
  subject_external_id text NOT NULL CHECK (subject_external_id ~ '^[1-9][0-9]{0,15}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,whatsapp_group_id,subject_type,subject_external_id),
  FOREIGN KEY (tenant_id,whatsapp_group_id)
    REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE group_workspace_read_cursors (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_instance_id uuid NOT NULL,
  zammad_user_id text NOT NULL CHECK (zammad_user_id ~ '^[1-9][0-9]{0,15}$'),
  whatsapp_group_id uuid NOT NULL,
  last_message_id uuid,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,zammad_instance_id,zammad_user_id,whatsapp_group_id),
  FOREIGN KEY (tenant_id,zammad_instance_id)
    REFERENCES zammad_instances(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,whatsapp_group_id)
    REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE
);

ALTER TABLE normalized_messages
  ADD COLUMN history_captured_at timestamptz,
  ADD CONSTRAINT normalized_messages_tenant_id_id_key UNIQUE (tenant_id,id);

ALTER TABLE group_workspace_read_cursors
  ADD CONSTRAINT group_workspace_cursor_message_tenant_fk
    FOREIGN KEY (tenant_id,last_message_id)
    REFERENCES normalized_messages(tenant_id,id) ON DELETE SET NULL (last_message_id);

ALTER TABLE message_links
  ADD COLUMN zammad_article_id text CHECK (
    zammad_article_id IS NULL OR zammad_article_id ~ '^[1-9][0-9]{0,15}$'
  );

CREATE INDEX normalized_messages_group_history_idx
  ON normalized_messages (tenant_id,connection_id,external_group_id,provider_timestamp DESC,id DESC)
  WHERE history_captured_at IS NOT NULL;
CREATE INDEX group_workspace_grants_subject_idx
  ON group_workspace_grants (tenant_id,subject_type,subject_external_id,whatsapp_group_id);

ALTER TABLE group_workspace_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_workspace_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_workspace_settings
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE group_workspace_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_workspace_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_workspace_grants
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

ALTER TABLE group_workspace_read_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_workspace_read_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_workspace_read_cursors
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

GRANT SELECT,INSERT,UPDATE,DELETE ON
  group_workspace_settings,group_workspace_grants,group_workspace_read_cursors
TO wasalx_app;

COMMIT;
