CREATE OR REPLACE FUNCTION workspace_provider.current_tenant_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE value text;
BEGIN
  value := current_setting('app.tenant_id', true);
  IF value IS NULL OR value = '' THEN
    RAISE EXCEPTION 'tenant context is required' USING ERRCODE = '42501';
  END IF;
  RETURN value::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'tenant context is invalid' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION workspace_provider.current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION workspace_provider.current_tenant_id() TO wasalx_workspace_provider_runtime;

ALTER TABLE workspace_provider.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_provider.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_provider.tenants;
CREATE POLICY tenant_isolation ON workspace_provider.tenants
  USING (tenant_id = workspace_provider.current_tenant_id())
  WITH CHECK (tenant_id = workspace_provider.current_tenant_id());

ALTER TABLE workspace_provider.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_provider.operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_provider.operations;
CREATE POLICY tenant_isolation ON workspace_provider.operations
  USING (tenant_id = workspace_provider.current_tenant_id())
  WITH CHECK (tenant_id = workspace_provider.current_tenant_id());

ALTER TABLE workspace_provider.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_provider.audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_provider.audit_events;
CREATE POLICY tenant_isolation ON workspace_provider.audit_events
  USING (tenant_id = workspace_provider.current_tenant_id())
  WITH CHECK (tenant_id = workspace_provider.current_tenant_id());

CREATE OR REPLACE FUNCTION workspace_provider.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'workspace provider audit events are append-only' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION workspace_provider.reject_audit_mutation() FROM PUBLIC;
DROP TRIGGER IF EXISTS workspace_provider_audit_events_append_only ON workspace_provider.audit_events;
CREATE TRIGGER workspace_provider_audit_events_append_only
  BEFORE UPDATE OR DELETE ON workspace_provider.audit_events
  FOR EACH ROW EXECUTE FUNCTION workspace_provider.reject_audit_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA workspace_provider FROM wasalx_workspace_provider_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA workspace_provider FROM wasalx_workspace_provider_runtime;
GRANT SELECT, INSERT, UPDATE ON workspace_provider.tenants, workspace_provider.operations TO wasalx_workspace_provider_runtime;
GRANT SELECT, INSERT ON workspace_provider.audit_events TO wasalx_workspace_provider_runtime;
GRANT USAGE, SELECT ON SEQUENCE workspace_provider.audit_events_event_id_seq TO wasalx_workspace_provider_runtime;
