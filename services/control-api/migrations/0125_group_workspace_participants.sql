CREATE TABLE group_workspace_participants (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_group_id uuid NOT NULL,
  external_participant_id text NOT NULL CHECK (
    external_participant_id~'^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$'
  ),
  normalized_phone text CHECK (normalized_phone IS NULL OR normalized_phone~'^\+[1-9][0-9]{5,19}$'),
  display_name text CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 160),
  synchronized_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,whatsapp_group_id,external_participant_id),
  FOREIGN KEY (tenant_id,whatsapp_group_id)
    REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE
);

CREATE INDEX group_workspace_participants_lookup_idx
  ON group_workspace_participants (tenant_id,whatsapp_group_id,normalized_phone,external_participant_id);

ALTER TABLE group_workspace_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_workspace_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_workspace_participants
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

GRANT SELECT,INSERT,UPDATE,DELETE ON group_workspace_participants TO wasalx_app;
