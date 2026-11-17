BEGIN;

CREATE OR REPLACE FUNCTION app.update_group_workspace_defaults(
  expected_version_value bigint,
  enabled_value boolean,
  retention_days_value integer,
  visibility_value text,
  actor_id_value uuid
)
RETURNS TABLE (
  group_workspace_enabled boolean,
  group_history_default_retention_days integer,
  group_history_default_visibility text,
  version bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  UPDATE tenant_settings AS settings
     SET group_workspace_enabled=enabled_value,
         group_history_default_retention_days=retention_days_value,
         group_history_default_visibility=visibility_value,
         version=settings.version+1,
         updated_by=actor_id_value,
         updated_at=now()
   WHERE settings.tenant_id=app.current_tenant_id()
     AND settings.version=expected_version_value
  RETURNING settings.group_workspace_enabled,
            settings.group_history_default_retention_days,
            settings.group_history_default_visibility,
            settings.version;
$$;

ALTER FUNCTION app.update_group_workspace_defaults(bigint,boolean,integer,text,uuid)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.update_group_workspace_defaults(bigint,boolean,integer,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.update_group_workspace_defaults(bigint,boolean,integer,text,uuid) TO wasalx_app;

COMMIT;
