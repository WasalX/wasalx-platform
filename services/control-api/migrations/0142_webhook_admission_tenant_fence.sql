CREATE OR REPLACE FUNCTION app.lock_current_active_tenant_for_event_admission()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  PERFORM 1 FROM public.tenants tenant
   WHERE tenant.id=app.current_tenant_id() AND tenant.state='ACTIVE'
   FOR SHARE OF tenant;
  RETURN FOUND;
END;
$$;

ALTER FUNCTION app.lock_current_active_tenant_for_event_admission()
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.lock_current_active_tenant_for_event_admission()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_current_active_tenant_for_event_admission()
  TO wasalx_app;
