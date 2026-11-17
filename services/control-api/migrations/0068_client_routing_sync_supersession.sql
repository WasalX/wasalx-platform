CREATE OR REPLACE FUNCTION app.complete_client_routing_sync_job(
  requested_job_id uuid,worker_lease uuid,expected_fence bigint,expected_revisions jsonb,
  requested_snapshot jsonb,requested_cursor text,requested_definition jsonb
)
RETURNS TABLE(routing_version_id uuid,version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE job client_routing_sync_jobs%ROWTYPE;DECLARE source client_routing_source_state%ROWTYPE;
DECLARE active client_routing_versions%ROWTYPE;DECLARE created client_routing_versions%ROWTYPE;DECLARE next_version integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('client-routing:'||current_tenant::text,0));
  SELECT * INTO job FROM client_routing_sync_jobs WHERE tenant_id=current_tenant AND id=requested_job_id FOR UPDATE;
  IF NOT FOUND OR job.state<>'RUNNING' OR job.lease_id<>worker_lease OR job.fencing_token<>expected_fence OR job.lease_expires_at<now() THEN
    RAISE EXCEPTION 'routing sync claim is stale' USING ERRCODE='40001';
  END IF;
  SELECT * INTO source FROM client_routing_source_state WHERE tenant_id=current_tenant AND id=job.source_state_id FOR UPDATE;
  IF NOT FOUND OR source.state<>'ACTIVE' OR source.config_sha256<>job.config_sha256 THEN
    RAISE EXCEPTION 'routing connector configuration changed' USING ERRCODE='40001';
  END IF;
  IF source.snapshot_revision>job.expected_snapshot_revision THEN
    UPDATE client_routing_sync_jobs SET state='DISCARDED',lease_id=NULL,lease_expires_at=NULL,
      result_routing_version_id=source.routing_version_id,safe_error=NULL,completed_at=now(),updated_at=now()
     WHERE tenant_id=current_tenant AND id=job.id;
    INSERT INTO audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
      VALUES(current_tenant,'SYSTEM','routing-sync','client_routing.sync_superseded','client_routing_sync_job',job.id::text,
        jsonb_build_object('state','RUNNING','expected_snapshot_revision',job.expected_snapshot_revision),
        jsonb_build_object('state','DISCARDED','source_id',source.source_id,'snapshot_revision',source.snapshot_revision),job.id::text);
    RETURN QUERY SELECT routing.id,routing.version FROM client_routing_versions routing
      WHERE routing.tenant_id=current_tenant AND routing.id=source.routing_version_id;
    RETURN;
  END IF;
  IF source.snapshot_revision<>job.expected_snapshot_revision THEN
    RAISE EXCEPTION 'routing connector configuration changed' USING ERRCODE='40001';
  END IF;
  PERFORM 1 FROM client_routing_source_state state WHERE state.tenant_id=current_tenant AND state.state='ACTIVE' ORDER BY state.source_id FOR UPDATE;
  IF jsonb_typeof(expected_revisions)<>'object' OR
     (SELECT count(*) FROM jsonb_object_keys(expected_revisions))<>(SELECT count(*) FROM client_routing_source_state WHERE tenant_id=current_tenant AND state='ACTIVE') OR
     EXISTS (SELECT 1 FROM client_routing_source_state state WHERE state.tenant_id=current_tenant AND state.state='ACTIVE'
       AND COALESCE(expected_revisions->>state.source_id,'')<>state.snapshot_revision::text) THEN
    RAISE EXCEPTION 'routing source snapshots changed' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(requested_snapshot)<>'array' OR octet_length(requested_snapshot::text)>5000000 OR
     jsonb_typeof(requested_definition)<>'object' OR requested_definition->>'schemaVersion'<>'1' OR
     jsonb_typeof(requested_definition->'sources')<>'array' OR jsonb_typeof(requested_definition->'clients')<>'array' OR
     octet_length(requested_definition::text)>5000000 OR requested_cursor IS NOT NULL AND length(requested_cursor)>1000 THEN
    RAISE EXCEPTION 'routing sync result is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO active FROM client_routing_versions WHERE tenant_id=current_tenant AND state='ACTIVE' FOR UPDATE;
  IF NOT FOUND OR requested_definition->'sources'<>active.definition->'sources' OR requested_definition->'fallback'<>active.definition->'fallback' OR
     requested_definition->>'name'<>active.definition->>'name' OR
     EXISTS (SELECT 1 FROM jsonb_array_elements(requested_definition->'clients') client
       WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(requested_definition->'sources') configured WHERE configured->>'id'=client->>'routeSourceId')) THEN
    RAISE EXCEPTION 'routing sync result changed protected configuration' USING ERRCODE='22023';
  END IF;
  UPDATE client_routing_source_state SET snapshot=requested_snapshot,snapshot_sha256=encode(digest(requested_snapshot::text,'sha256'),'hex'),
    snapshot_revision=snapshot_revision+1,cursor_value=requested_cursor,last_success_at=now(),safe_error=NULL,
    next_due_at=CASE WHEN sync_mode IN ('SCHEDULED','HYBRID') THEN now()+make_interval(mins=>schedule_minutes) ELSE NULL END,
    fencing_token=expected_fence,updated_at=now() WHERE tenant_id=current_tenant AND id=source.id;
  UPDATE client_routing_sync_jobs SET state='SUCCEEDED',lease_id=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now()
   WHERE tenant_id=current_tenant AND id=job.id;
  IF EXISTS (SELECT 1 FROM client_routing_source_state state WHERE state.tenant_id=current_tenant AND state.state='ACTIVE' AND state.snapshot_revision=0) THEN
    INSERT INTO audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
      VALUES(current_tenant,'SYSTEM','routing-sync','client_routing.source_synced','client_routing_source',source.id::text,
        jsonb_build_object('source_id',source.source_id,'snapshot_revision',source.snapshot_revision+1,'activation_deferred',true),job.id::text);
    RETURN QUERY SELECT NULL::uuid,NULL::integer;RETURN;
  END IF;
  SELECT COALESCE(max(item.version),0)+1 INTO next_version FROM client_routing_versions item WHERE item.tenant_id=current_tenant;
  INSERT INTO client_routing_versions(tenant_id,version,state,definition,snapshot_sha256,created_by,created_actor_type,created_sync_job_id)
    VALUES(current_tenant,next_version,'DRAFT',requested_definition,encode(digest(requested_definition::text,'sha256'),'hex'),NULL,'SYSTEM',job.id)
    RETURNING * INTO created;
  INSERT INTO client_routing_matchers(tenant_id,routing_version_id,source_id,route_source_id,client_id,client_name,zammad_group_id,
    owner_id,escalation_group_id,escalation_owner_id,kind,value,namespace,connection_id)
  SELECT current_tenant,created.id,matcher->>'sourceId',client->>'routeSourceId',client->>'id',client->>'name',client->>'zammadGroupId',
    NULLIF(client->>'ownerId',''),NULLIF(client->>'escalationGroupId',''),NULLIF(client->>'escalationOwnerId',''),matcher->>'kind',matcher->>'value',
    NULLIF(matcher->>'namespace',''),NULLIF(matcher->>'connectionId','')::uuid
    FROM jsonb_array_elements(requested_definition->'clients') client CROSS JOIN LATERAL jsonb_array_elements(client->'matchers') matcher;
  UPDATE client_routing_versions SET state='RETIRED',revision=revision+1,retired_at=now(),retired_by=NULL,
    retired_actor_type='SYSTEM',retired_sync_job_id=job.id WHERE tenant_id=current_tenant AND id=active.id;
  UPDATE client_routing_versions SET state='ACTIVE',revision=revision+1,activated_at=now(),activated_by=NULL,
    activated_actor_type='SYSTEM',activated_sync_job_id=job.id WHERE tenant_id=current_tenant AND id=created.id RETURNING * INTO created;
  UPDATE client_routing_source_state SET routing_version_id=created.id,updated_at=now() WHERE tenant_id=current_tenant AND state='ACTIVE';
  UPDATE client_routing_sync_jobs SET result_routing_version_id=created.id,updated_at=now() WHERE tenant_id=current_tenant AND id=job.id;
  INSERT INTO audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
    VALUES(current_tenant,'SYSTEM','routing-sync','client_routing.synced','client_routing_version',created.id::text,
      jsonb_build_object('active_routing_version_id',active.id),jsonb_build_object('active_routing_version_id',created.id,'source_id',source.source_id,'snapshot_revision',source.snapshot_revision+1),job.id::text);
  RETURN QUERY SELECT created.id,created.version;
END
$$;

REVOKE ALL ON FUNCTION app.complete_client_routing_sync_job(uuid,uuid,bigint,jsonb,jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_client_routing_sync_job(uuid,uuid,bigint,jsonb,jsonb,text,jsonb) TO wasalx_app;
