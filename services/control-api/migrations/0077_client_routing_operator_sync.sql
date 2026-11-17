CREATE OR REPLACE FUNCTION app.request_client_routing_source_sync(
  requested_source_id text,expected_revision bigint,requested_by uuid,request_key text
)
RETURNS TABLE(job_id uuid,snapshot_revision bigint,duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE source client_routing_source_state%ROWTYPE;DECLARE created_id uuid;
BEGIN
  IF requested_source_id!~'^[a-z][a-z0-9_.-]{0,127}$' OR expected_revision<0 OR request_key!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'routing sync request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin')) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT * INTO source FROM client_routing_source_state
   WHERE tenant_id=current_tenant AND source_id=requested_source_id AND state IN ('ACTIVE','CONFLICT') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'routing source is unavailable' USING ERRCODE='55000';END IF;
  IF source.snapshot_revision<>expected_revision THEN
    RAISE EXCEPTION 'routing source changed; refresh before syncing' USING ERRCODE='40001';
  END IF;
  SELECT job.id INTO created_id FROM client_routing_sync_jobs job
   WHERE job.tenant_id=current_tenant AND job.source_state_id=source.id AND job.expected_snapshot_revision=expected_revision
     AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') ORDER BY job.created_at LIMIT 1;
  IF created_id IS NOT NULL THEN RETURN QUERY SELECT created_id,source.snapshot_revision,true;RETURN;END IF;
  UPDATE client_routing_source_state SET state='ACTIVE',safe_error=NULL,updated_at=now()
   WHERE tenant_id=current_tenant AND id=source.id;
  INSERT INTO client_routing_sync_jobs(tenant_id,source_state_id,config_sha256,trigger_key,trigger_kind,expected_snapshot_revision)
    VALUES(current_tenant,source.id,source.config_sha256,'manual:'||request_key,'MANUAL',source.snapshot_revision)
    ON CONFLICT (tenant_id,source_state_id,trigger_key) DO NOTHING RETURNING id INTO created_id;
  IF created_id IS NULL THEN
    SELECT id INTO created_id FROM client_routing_sync_jobs
     WHERE tenant_id=current_tenant AND source_state_id=source.id AND trigger_key='manual:'||request_key;
  END IF;
  IF created_id IS NULL THEN RAISE EXCEPTION 'routing sync could not be requested' USING ERRCODE='55000';END IF;
  RETURN QUERY SELECT created_id,source.snapshot_revision,false;
END
$$;

REVOKE ALL ON FUNCTION app.request_client_routing_source_sync(text,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_client_routing_source_sync(text,bigint,uuid,text) TO wasalx_app;
