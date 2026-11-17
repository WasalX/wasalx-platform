-- Preserve immutable bot flow versions while fencing assignment against a
-- concurrent activation. The application role cannot row-lock immutable flow
-- rows directly because PostgreSQL requires UPDATE privilege for that lock.
CREATE OR REPLACE FUNCTION app.assign_bot_flow(
  requested_connection_id uuid,
  requested_family_id uuid,
  requested_zammad_group_id text,
  expected_active_flow_version_id uuid,
  requested_by uuid
)
RETURNS TABLE (assignment_id uuid,flow_version_id uuid,revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE active_id uuid;
DECLARE assigned public.bot_assignments%ROWTYPE;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin') AND state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'bot assignment actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.connections AS connection
     WHERE connection.tenant_id=current_tenant AND connection.id=requested_connection_id
       AND connection.state='WORKING'
  ) THEN
    RAISE EXCEPTION 'bot connection is unavailable' USING ERRCODE='23503';
  END IF;
  PERFORM 1 FROM public.bot_flow_families AS family
   WHERE family.tenant_id=current_tenant AND family.id=requested_family_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bot flow family was not found' USING ERRCODE='23503';
  END IF;
  SELECT flow.id INTO active_id FROM public.bot_flow_versions AS flow
   WHERE flow.tenant_id=current_tenant AND flow.family_id=requested_family_id AND flow.state='ACTIVE'
   FOR SHARE;
  IF active_id IS NULL THEN
    RAISE EXCEPTION 'bot flow has no active version' USING ERRCODE='23503';
  END IF;
  IF active_id IS DISTINCT FROM expected_active_flow_version_id THEN
    RAISE EXCEPTION 'bot active flow changed' USING ERRCODE='40001';
  END IF;
  INSERT INTO public.bot_assignments (
    tenant_id,connection_id,flow_family_id,flow_version_id,zammad_group_id,
    state,created_by,updated_by
  ) VALUES (
    current_tenant,requested_connection_id,requested_family_id,active_id,
    requested_zammad_group_id,'ACTIVE',requested_by,requested_by
  ) ON CONFLICT (tenant_id,connection_id) DO UPDATE
    SET flow_family_id=EXCLUDED.flow_family_id,
        flow_version_id=EXCLUDED.flow_version_id,
        zammad_group_id=EXCLUDED.zammad_group_id,
        state='ACTIVE',revision=bot_assignments.revision+1,
        updated_by=EXCLUDED.updated_by,updated_at=now()
    WHERE bot_assignments.state='PAUSED'
  RETURNING * INTO assigned;
  IF assigned.id IS NULL THEN
    RAISE EXCEPTION 'bot assignment already active' USING ERRCODE='23505';
  END IF;
  RETURN QUERY SELECT assigned.id,assigned.flow_version_id,assigned.revision;
END
$$;

REVOKE ALL ON FUNCTION app.assign_bot_flow(uuid,uuid,text,uuid) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.assign_bot_flow(uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assign_bot_flow(uuid,uuid,text,uuid,uuid) TO wasalx_app;
