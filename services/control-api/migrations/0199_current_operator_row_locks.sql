-- Runtime cannot UPDATE global identity rows merely to acquire row locks.
CREATE FUNCTION app.lock_current_operator_principal(
  user_id_value uuid,subject_value text,email_value text,expected_role_value text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE tenant_id_value uuid := app.current_tenant_id();
BEGIN
  IF tenant_id_value IS NULL OR user_id_value IS NULL OR subject_value IS NULL
     OR email_value IS NULL OR expected_role_value IS NULL THEN RETURN NULL; END IF;

  -- Strong locks without new wait edges into membership and provisioning writers.
  PERFORM 1 FROM public.tenant_settings settings
   WHERE settings.tenant_id=tenant_id_value FOR SHARE OF settings NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.tenants tenant
   WHERE tenant.id=tenant_id_value AND tenant.state='ACTIVE' FOR SHARE OF tenant NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.users identity
   WHERE identity.id=user_id_value AND identity.oidc_subject=subject_value
     AND identity.email=email_value FOR SHARE OF identity NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.tenant_memberships member
   WHERE member.tenant_id=tenant_id_value AND member.user_id=user_id_value
     AND member.state='ACTIVE' AND member.role=expected_role_value FOR SHARE OF member NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN expected_role_value;
END;
$$;

ALTER FUNCTION app.lock_current_operator_principal(uuid,text,text,text)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.lock_current_operator_principal(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_current_operator_principal(uuid,text,text,text) TO wasalx_app;

CREATE FUNCTION app.lock_current_working_zammad_instance(instance_id_value uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  PERFORM 1 FROM public.zammad_instances instance
   WHERE instance.tenant_id=app.current_tenant_id() AND instance.id=instance_id_value
     AND instance.state='WORKING' FOR SHARE OF instance NOWAIT;
  RETURN FOUND;
END;
$$;

ALTER FUNCTION app.lock_current_working_zammad_instance(uuid)
  OWNER TO wasalx_provisioning_executor;
REVOKE ALL ON FUNCTION app.lock_current_working_zammad_instance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_current_working_zammad_instance(uuid) TO wasalx_app;

-- retention_policies is authoritative; tenants retains a compatibility projection.
CREATE FUNCTION app.sync_tenant_retention_days()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF TG_RELID<>'public.retention_policies'::regclass OR TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Invalid retention projection source' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.tenants tenant WHERE tenant.id=NEW.tenant_id
   FOR UPDATE OF tenant NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Retention workspace is unavailable' USING ERRCODE='55000';
  END IF;
  UPDATE public.tenants SET retention_days=NEW.resolved_case_days,updated_at=now()
   WHERE id=NEW.tenant_id;
  RETURN NULL;
END;
$$;

ALTER FUNCTION app.sync_tenant_retention_days() OWNER TO wasalx_provisioning_executor;
REVOKE ALL ON FUNCTION app.sync_tenant_retention_days() FROM PUBLIC,wasalx_app,wasalx_connector_worker;
CREATE TRIGGER retention_policy_tenant_projection
AFTER UPDATE OF resolved_case_days ON public.retention_policies
FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_retention_days();
