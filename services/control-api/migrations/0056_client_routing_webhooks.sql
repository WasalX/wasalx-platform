ALTER TABLE client_routing_source_state
  ADD COLUMN webhook_route_sha256 text CHECK (webhook_route_sha256 IS NULL OR webhook_route_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT client_routing_source_webhook_route_check CHECK (
    (sync_mode IN ('WEBHOOK','HYBRID') AND (state<>'ACTIVE' OR webhook_route_sha256 IS NOT NULL))
    OR (sync_mode='SCHEDULED' AND webhook_route_sha256 IS NULL)
  ) NOT VALID;

UPDATE client_routing_source_state SET state='CONFLICT',safe_error='Reactivate this routing version to create its secure webhook route.',updated_at=now()
 WHERE state='ACTIVE' AND sync_mode IN ('WEBHOOK','HYBRID') AND webhook_route_sha256 IS NULL;

CREATE UNIQUE INDEX client_routing_source_webhook_route
  ON client_routing_source_state(webhook_route_sha256) WHERE state<>'RETIRED' AND webhook_route_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION app.reconcile_client_routing_sources(requested_version_id uuid,requested_by uuid,webhook_route_hashes jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE requested_definition jsonb;DECLARE queued integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin')) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT definition INTO requested_definition FROM client_routing_versions
   WHERE tenant_id=current_tenant AND id=requested_version_id AND state='ACTIVE' FOR SHARE;
  IF requested_definition IS NULL THEN RAISE EXCEPTION 'active client routing version was not found' USING ERRCODE='22023';END IF;
  IF jsonb_typeof(webhook_route_hashes)<>'object' OR
     (SELECT count(*) FROM jsonb_object_keys(webhook_route_hashes))<>(SELECT count(*) FROM jsonb_array_elements(requested_definition->'sources') source WHERE source->>'syncMode' IN ('WEBHOOK','HYBRID')) OR
     EXISTS (SELECT 1 FROM jsonb_array_elements(requested_definition->'sources') source
       WHERE source->>'syncMode' IN ('WEBHOOK','HYBRID') AND COALESCE(webhook_route_hashes->>(source->>'id'),'')!~'^[0-9a-f]{64}$') OR
     EXISTS (SELECT 1 FROM jsonb_object_keys(webhook_route_hashes) key
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(requested_definition->'sources') source WHERE source->>'id'=key AND source->>'syncMode' IN ('WEBHOOK','HYBRID'))) THEN
    RAISE EXCEPTION 'routing webhook routes are invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(requested_definition->'sources') source
    WHERE source->>'kind'<>'MANUAL' AND source->>'secretReference' NOT LIKE 'secret://tenants/'||current_tenant::text||'/routing/%') THEN
    RAISE EXCEPTION 'routing source secret is outside the tenant namespace' USING ERRCODE='42501';
  END IF;
  UPDATE client_routing_source_state state SET state='RETIRED',next_due_at=NULL,updated_at=now()
   WHERE state.tenant_id=current_tenant AND state.state<>'RETIRED' AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(requested_definition->'sources') source
      WHERE source->>'kind'<>'MANUAL' AND source->>'id'=state.source_id
        AND encode(digest(source::text,'sha256'),'hex')=state.config_sha256
   );
  INSERT INTO client_routing_source_state(tenant_id,source_id,routing_version_id,config_sha256,kind,sync_mode,secret_reference,endpoint_url,schedule_minutes,field_mapping,next_due_at,webhook_route_sha256)
  SELECT current_tenant,source->>'id',requested_version_id,encode(digest(source::text,'sha256'),'hex'),source->>'kind',source->>'syncMode',source->>'secretReference',
    NULLIF(source->>'endpointUrl',''),NULLIF(source->>'scheduleMinutes','')::integer,COALESCE(source->'fieldMapping','{}'::jsonb),now(),webhook_route_hashes->>(source->>'id')
    FROM jsonb_array_elements(requested_definition->'sources') source WHERE source->>'kind'<>'MANUAL'
  ON CONFLICT (tenant_id,source_id,config_sha256) DO UPDATE SET routing_version_id=EXCLUDED.routing_version_id,state='ACTIVE',next_due_at=now(),
    safe_error=NULL,webhook_route_sha256=EXCLUDED.webhook_route_sha256,updated_at=now();
  INSERT INTO client_routing_sync_jobs(tenant_id,source_state_id,config_sha256,trigger_key,trigger_kind,expected_snapshot_revision)
  SELECT current_tenant,state.id,state.config_sha256,'activation:'||requested_version_id::text,'ACTIVATION',state.snapshot_revision
    FROM client_routing_source_state state WHERE state.tenant_id=current_tenant AND state.state='ACTIVE'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS queued=ROW_COUNT;RETURN queued;
END
$$;

CREATE OR REPLACE FUNCTION app.resolve_client_routing_webhook_route(route_hash text)
RETURNS TABLE(tenant_id uuid,source_state_id uuid,source_id text,kind text,secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
  SELECT source.tenant_id,source.id,source.source_id,source.kind,source.secret_reference
    FROM client_routing_source_state source JOIN tenants tenant ON tenant.id=source.tenant_id
   WHERE source.webhook_route_sha256=route_hash AND source.state='ACTIVE' AND source.sync_mode IN ('WEBHOOK','HYBRID') AND tenant.state='ACTIVE'
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.enqueue_client_routing_webhook_sync(requested_source_state_id uuid,event_sha256 text)
RETURNS TABLE(job_id uuid,duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE source client_routing_source_state%ROWTYPE;DECLARE created_id uuid;
BEGIN
  IF event_sha256!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'routing webhook event is invalid' USING ERRCODE='22023';END IF;
  SELECT * INTO source FROM client_routing_source_state WHERE tenant_id=current_tenant AND id=requested_source_state_id
    AND state='ACTIVE' AND sync_mode IN ('WEBHOOK','HYBRID') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'routing webhook route is unavailable' USING ERRCODE='55000';END IF;
  INSERT INTO client_routing_sync_jobs(tenant_id,source_state_id,config_sha256,trigger_key,trigger_kind,expected_snapshot_revision)
    VALUES(current_tenant,source.id,source.config_sha256,'webhook:'||event_sha256,'WEBHOOK',source.snapshot_revision)
    ON CONFLICT DO NOTHING RETURNING id INTO created_id;
  IF created_id IS NULL THEN
    SELECT id INTO created_id FROM client_routing_sync_jobs WHERE tenant_id=current_tenant AND source_state_id=source.id AND trigger_key='webhook:'||event_sha256;
    IF created_id IS NULL THEN RAISE EXCEPTION 'routing webhook could not be accepted' USING ERRCODE='55000';END IF;
    RETURN QUERY SELECT created_id,true;RETURN;
  END IF;
  RETURN QUERY SELECT created_id,false;
END
$$;

ALTER TABLE client_routing_source_state VALIDATE CONSTRAINT client_routing_source_webhook_route_check;
REVOKE ALL ON FUNCTION app.reconcile_client_routing_sources(uuid,uuid) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.reconcile_client_routing_sources(uuid,uuid,jsonb),app.resolve_client_routing_webhook_route(text),app.enqueue_client_routing_webhook_sync(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconcile_client_routing_sources(uuid,uuid,jsonb),app.resolve_client_routing_webhook_route(text),app.enqueue_client_routing_webhook_sync(uuid,text) TO wasalx_app;
