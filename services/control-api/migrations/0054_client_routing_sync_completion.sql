ALTER TABLE client_routing_matchers ADD COLUMN route_source_id text
  CHECK (route_source_id IS NULL OR route_source_id ~ '^[a-z][a-z0-9_.-]{0,127}$');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM client_routing_versions version CROSS JOIN LATERAL jsonb_array_elements(version.definition->'clients') client
    WHERE client->>'routeSourceId' IS NULL AND
      (SELECT count(DISTINCT matcher->>'sourceId') FROM jsonb_array_elements(client->'matchers') matcher
       WHERE matcher->>'sourceId' IN (SELECT source->>'id' FROM jsonb_array_elements(version.definition->'sources') source WHERE source->>'kind'='MANUAL'))<>1 AND
      (SELECT count(DISTINCT matcher->>'sourceId') FROM jsonb_array_elements(client->'matchers') matcher)<>1) THEN
    RAISE EXCEPTION 'existing client routing ownership source is ambiguous';
  END IF;
END
$$;
UPDATE client_routing_matchers matcher SET route_source_id=COALESCE(client->>'routeSourceId',
  (SELECT min(item->>'sourceId') FROM jsonb_array_elements(client->'matchers') item
    WHERE item->>'sourceId' IN (SELECT source->>'id' FROM jsonb_array_elements(version.definition->'sources') source WHERE source->>'kind'='MANUAL')),
  matcher.source_id)
 FROM client_routing_versions version CROSS JOIN LATERAL jsonb_array_elements(version.definition->'clients') client
 WHERE version.tenant_id=matcher.tenant_id AND version.id=matcher.routing_version_id AND client->>'id'=matcher.client_id;
ALTER TABLE client_routing_matchers ALTER COLUMN route_source_id SET NOT NULL;

ALTER TABLE client_routing_versions
  ADD COLUMN activated_actor_type text CHECK (activated_actor_type IN ('USER','SYSTEM')),
  ADD COLUMN activated_sync_job_id uuid,
  ADD COLUMN retired_actor_type text CHECK (retired_actor_type IN ('USER','SYSTEM')),
  ADD COLUMN retired_sync_job_id uuid,
  ADD CONSTRAINT client_routing_versions_activated_sync_job_fk
    FOREIGN KEY (tenant_id,activated_sync_job_id) REFERENCES client_routing_sync_jobs(tenant_id,id),
  ADD CONSTRAINT client_routing_versions_retired_sync_job_fk
    FOREIGN KEY (tenant_id,retired_sync_job_id) REFERENCES client_routing_sync_jobs(tenant_id,id);

UPDATE client_routing_versions SET activated_actor_type='USER' WHERE activated_by IS NOT NULL;
UPDATE client_routing_versions SET retired_actor_type='USER' WHERE retired_by IS NOT NULL;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
   WHERE conrelid='client_routing_versions'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%state = ''DRAFT''%activated_at IS NULL%retired_at IS NULL%';
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'client routing lifecycle constraint was not found';END IF;
  EXECUTE format('ALTER TABLE client_routing_versions DROP CONSTRAINT %I',constraint_name);
END
$$;

ALTER TABLE client_routing_versions ADD CONSTRAINT client_routing_versions_lifecycle_actor_check CHECK (
  (state='DRAFT' AND activated_at IS NULL AND activated_by IS NULL AND activated_actor_type IS NULL AND activated_sync_job_id IS NULL
    AND retired_at IS NULL AND retired_by IS NULL AND retired_actor_type IS NULL AND retired_sync_job_id IS NULL)
  OR
  (state='ACTIVE' AND activated_at IS NOT NULL
    AND ((activated_actor_type='USER' AND activated_by IS NOT NULL AND activated_sync_job_id IS NULL)
      OR (activated_actor_type='SYSTEM' AND activated_by IS NULL AND activated_sync_job_id IS NOT NULL))
    AND retired_at IS NULL AND retired_by IS NULL AND retired_actor_type IS NULL AND retired_sync_job_id IS NULL)
  OR
  (state='RETIRED' AND activated_at IS NOT NULL
    AND ((activated_actor_type='USER' AND activated_by IS NOT NULL AND activated_sync_job_id IS NULL)
      OR (activated_actor_type='SYSTEM' AND activated_by IS NULL AND activated_sync_job_id IS NOT NULL))
    AND retired_at IS NOT NULL
    AND ((retired_actor_type='USER' AND retired_by IS NOT NULL AND retired_sync_job_id IS NULL)
      OR (retired_actor_type='SYSTEM' AND retired_by IS NULL AND retired_sync_job_id IS NOT NULL)))
);

CREATE OR REPLACE FUNCTION app.create_client_routing_version(requested_definition jsonb,requested_by uuid)
RETURNS TABLE (id uuid,version integer,state text,revision bigint,snapshot_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE created client_routing_versions%ROWTYPE;DECLARE next_version integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin')) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client-routing:'||current_tenant::text,0));
  SELECT COALESCE(max(routing.version),0)+1 INTO next_version FROM client_routing_versions routing WHERE routing.tenant_id=current_tenant;
  INSERT INTO client_routing_versions(tenant_id,version,state,definition,snapshot_sha256,created_by,created_actor_type)
    VALUES(current_tenant,next_version,'DRAFT',requested_definition,encode(digest(requested_definition::text,'sha256'),'hex'),requested_by,'USER')
    RETURNING * INTO created;
  INSERT INTO client_routing_matchers(tenant_id,routing_version_id,source_id,route_source_id,client_id,client_name,zammad_group_id,
    owner_id,escalation_group_id,escalation_owner_id,kind,value,namespace,connection_id)
  SELECT current_tenant,created.id,matcher->>'sourceId',client->>'routeSourceId',client->>'id',client->>'name',client->>'zammadGroupId',
    NULLIF(client->>'ownerId',''),NULLIF(client->>'escalationGroupId',''),NULLIF(client->>'escalationOwnerId',''),matcher->>'kind',matcher->>'value',
    NULLIF(matcher->>'namespace',''),NULLIF(matcher->>'connectionId','')::uuid
    FROM jsonb_array_elements(requested_definition->'clients') client CROSS JOIN LATERAL jsonb_array_elements(client->'matchers') matcher;
  RETURN QUERY SELECT created.id,created.version,created.state,created.revision,created.snapshot_sha256;
END
$$;

ALTER FUNCTION app.reconcile_client_routing_sources(uuid,uuid) SET row_security=off;

CREATE OR REPLACE FUNCTION app.activate_client_routing_version(
  requested_version_id uuid,expected_revision bigint,expected_active_version_id uuid,requested_by uuid
)
RETURNS TABLE (active_version_id uuid,retired_version_id uuid,revision bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE target client_routing_versions%ROWTYPE;DECLARE active client_routing_versions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin')) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client-routing:'||current_tenant::text,0));
  SELECT * INTO target FROM client_routing_versions WHERE tenant_id=current_tenant AND id=requested_version_id FOR UPDATE;
  IF NOT FOUND OR target.state<>'DRAFT' OR target.revision<>expected_revision THEN
    RAISE EXCEPTION 'client routing draft changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  SELECT * INTO active FROM client_routing_versions WHERE tenant_id=current_tenant AND state='ACTIVE' FOR UPDATE;
  IF active.id IS DISTINCT FROM expected_active_version_id THEN
    RAISE EXCEPTION 'active client routing changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  IF active.id IS NOT NULL THEN
    UPDATE client_routing_versions routing SET state='RETIRED',revision=routing.revision+1,retired_at=now(),retired_by=requested_by,
      retired_actor_type='USER',retired_sync_job_id=NULL WHERE routing.tenant_id=current_tenant AND routing.id=active.id;
  END IF;
  UPDATE client_routing_versions routing SET state='ACTIVE',revision=routing.revision+1,activated_at=now(),activated_by=requested_by,
    activated_actor_type='USER',activated_sync_job_id=NULL WHERE routing.tenant_id=current_tenant AND routing.id=target.id RETURNING routing.revision INTO target.revision;
  RETURN QUERY SELECT target.id,active.id,target.revision;
END
$$;

CREATE OR REPLACE FUNCTION app.claim_client_routing_sync_jobs(worker_lease uuid,claim_limit integer DEFAULT 10)
RETURNS TABLE(job_id uuid,source_state_id uuid,source_id text,kind text,sync_mode text,secret_reference text,endpoint_url text,
  schedule_minutes integer,field_mapping jsonb,config_sha256 text,snapshot jsonb,snapshot_revision bigint,cursor_value text,attempts integer,fencing_token bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
BEGIN
  IF worker_lease IS NULL OR claim_limit<1 OR claim_limit>50 THEN RAISE EXCEPTION 'invalid routing sync claim' USING ERRCODE='22023';END IF;
  UPDATE client_routing_sync_jobs job SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
    safe_error=COALESCE(job.safe_error,'Routing connector exhausted its retry limit.'),completed_at=now(),updated_at=now()
   WHERE job.tenant_id=current_tenant AND job.attempts>=job.max_attempts AND
    (job.state IN ('QUEUED','FAILED_RETRYABLE') OR (job.state='RUNNING' AND job.lease_expires_at<now()));
  RETURN QUERY WITH claimed AS (
    UPDATE client_routing_sync_jobs job SET state='RUNNING',attempts=job.attempts+1,lease_id=worker_lease,
      lease_expires_at=now()+interval '2 minutes',fencing_token=job.fencing_token+1,safe_error=NULL,updated_at=now()
     WHERE job.id IN (SELECT candidate.id FROM client_routing_sync_jobs candidate
       JOIN client_routing_source_state state ON state.tenant_id=candidate.tenant_id AND state.id=candidate.source_state_id
      WHERE candidate.tenant_id=current_tenant AND state.state='ACTIVE' AND state.config_sha256=candidate.config_sha256
        AND candidate.attempts<candidate.max_attempts AND ((candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at<=now()) OR
          (candidate.state='RUNNING' AND candidate.lease_expires_at<now()))
      ORDER BY candidate.available_at,candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT claim_limit)
    RETURNING job.*
  ) SELECT job.id,state.id,state.source_id,state.kind,state.sync_mode,state.secret_reference,state.endpoint_url,state.schedule_minutes,
      state.field_mapping,state.config_sha256,state.snapshot,state.snapshot_revision,state.cursor_value,job.attempts,job.fencing_token
    FROM claimed job JOIN client_routing_source_state state ON state.tenant_id=job.tenant_id AND state.id=job.source_state_id;
END
$$;

CREATE OR REPLACE FUNCTION app.fail_client_routing_sync_job(requested_job_id uuid,worker_lease uuid,expected_fence bigint,retryable boolean,failure text,retry_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE affected integer;DECLARE current_tenant uuid:=app.current_tenant_id();
BEGIN
  UPDATE client_routing_sync_jobs SET state=CASE WHEN retryable AND attempts<max_attempts THEN 'FAILED_RETRYABLE' ELSE 'FAILED_TERMINAL' END,
    lease_id=NULL,lease_expires_at=NULL,available_at=CASE WHEN retryable AND attempts<max_attempts THEN COALESCE(retry_at,now()+interval '1 minute') ELSE available_at END,
    safe_error=left(failure,500),completed_at=CASE WHEN retryable AND attempts<max_attempts THEN NULL ELSE now() END,updated_at=now()
   WHERE tenant_id=current_tenant AND id=requested_job_id AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fence AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected=1;
END
$$;

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
  IF NOT FOUND OR source.state<>'ACTIVE' OR source.config_sha256<>job.config_sha256 OR source.snapshot_revision<>job.expected_snapshot_revision THEN
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
  UPDATE client_routing_sync_jobs SET state='SUCCEEDED',lease_id=NULL,lease_expires_at=NULL,result_routing_version_id=created.id,
    completed_at=now(),updated_at=now() WHERE tenant_id=current_tenant AND id=job.id;
  INSERT INTO audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
    VALUES(current_tenant,'SYSTEM','routing-sync','client_routing.synced','client_routing_version',created.id::text,
      jsonb_build_object('active_routing_version_id',active.id),jsonb_build_object('active_routing_version_id',created.id,'source_id',source.source_id,'snapshot_revision',source.snapshot_revision+1),job.id::text);
  RETURN QUERY SELECT created.id,created.version;
END
$$;

CREATE OR REPLACE FUNCTION app.enforce_client_routing_version_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.version<>OLD.version OR NEW.definition<>OLD.definition OR NEW.snapshot_sha256<>OLD.snapshot_sha256
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_actor_type<>OLD.created_actor_type
     OR NEW.created_sync_job_id IS DISTINCT FROM OLD.created_sync_job_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'client routing versions are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='DRAFT' AND NEW.state='ACTIVE') OR (OLD.state='ACTIVE' AND NEW.state='RETIRED')) OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'invalid client routing lifecycle transition' USING ERRCODE='55000';
  END IF;RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION app.complete_client_routing_sync_job(uuid,uuid,bigint,jsonb,jsonb,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_client_routing_sync_job(uuid,uuid,bigint,jsonb,jsonb,text,jsonb) TO wasalx_app;
