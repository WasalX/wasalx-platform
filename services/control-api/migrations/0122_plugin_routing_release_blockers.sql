CREATE TABLE client_routing_source_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  routing_version_id uuid NOT NULL,
  source_id text NOT NULL CHECK (source_id ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  integration_id uuid NOT NULL,
  integration_revision bigint NOT NULL CHECK (integration_revision>0),
  source_definition jsonb NOT NULL CHECK (jsonb_typeof(source_definition)='object' AND octet_length(source_definition::text)<=32768),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,routing_version_id) REFERENCES client_routing_versions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,integration_id) REFERENCES client_routing_integrations(tenant_id,id)
);

ALTER TABLE client_routing_source_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_source_qualifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_source_qualifications
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
REVOKE INSERT,UPDATE,DELETE ON client_routing_source_qualifications FROM wasalx_app;
GRANT SELECT ON client_routing_source_qualifications TO wasalx_app;

ALTER TABLE client_routing_sync_jobs
  ALTER COLUMN source_state_id DROP NOT NULL,
  ADD COLUMN qualification_id uuid,
  ADD CONSTRAINT client_routing_sync_jobs_qualification_fk
    FOREIGN KEY (tenant_id,qualification_id) REFERENCES client_routing_source_qualifications(tenant_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT client_routing_sync_jobs_source_kind_check CHECK (
    (trigger_kind='QUALIFICATION' AND source_state_id IS NULL AND qualification_id IS NOT NULL)
    OR (trigger_kind<>'QUALIFICATION' AND source_state_id IS NOT NULL AND qualification_id IS NULL)
  );

ALTER TABLE client_routing_sync_jobs DROP CONSTRAINT client_routing_sync_jobs_trigger_kind_check;
ALTER TABLE client_routing_sync_jobs ADD CONSTRAINT client_routing_sync_jobs_trigger_kind_check
  CHECK (trigger_kind IN ('ACTIVATION','MANUAL','WEBHOOK','SCHEDULED','QUALIFICATION'));

CREATE UNIQUE INDEX client_routing_source_qualification_job
  ON client_routing_sync_jobs(tenant_id,qualification_id,trigger_key)
  WHERE qualification_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.request_client_routing_source_qualification(
  requested_version_id uuid,expected_version_revision bigint,requested_source_id text,requested_integration_id uuid,
  expected_integration_revision bigint,requested_by uuid,request_key text
)
RETURNS TABLE(job_id uuid,qualification_id uuid,duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE version_row client_routing_versions%ROWTYPE;DECLARE source jsonb;
DECLARE integration client_routing_integrations%ROWTYPE;DECLARE qualification uuid;DECLARE created_job uuid;
BEGIN
  IF requested_source_id!~'^[a-z][a-z0-9_.-]{0,127}$' OR request_key!~'^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'routing qualification request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by
      AND role IN ('tenant_owner','tenant_admin') AND state='ACTIVE') THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT * INTO version_row FROM client_routing_versions
   WHERE tenant_id=current_tenant AND id=requested_version_id AND state='DRAFT' AND revision=expected_version_revision FOR SHARE;
  IF version_row.id IS NULL THEN RAISE EXCEPTION 'draft routing version was not found' USING ERRCODE='22023';END IF;
  SELECT item INTO source FROM jsonb_array_elements(version_row.definition->'sources') item
   WHERE item->>'id'=requested_source_id AND item->>'kind'<>'MANUAL' LIMIT 1;
  IF source IS NULL THEN RAISE EXCEPTION 'external routing source was not found' USING ERRCODE='22023';END IF;
  SELECT * INTO integration FROM client_routing_integrations
   WHERE tenant_id=current_tenant AND id=requested_integration_id AND state='CONNECTED'
     AND revision=expected_integration_revision AND provider=source->>'kind'
     AND secret_reference=source->>'secretReference' FOR SHARE;
  IF integration.id IS NULL THEN RAISE EXCEPTION 'routing connection changed' USING ERRCODE='40001';END IF;
  SELECT job.id,job.qualification_id INTO created_job,qualification
    FROM client_routing_sync_jobs job JOIN client_routing_source_qualifications item
      ON item.tenant_id=job.tenant_id AND item.id=job.qualification_id
   WHERE job.tenant_id=current_tenant AND item.routing_version_id=requested_version_id
     AND item.source_id=requested_source_id AND job.trigger_key='qualification:'||request_key
   FOR UPDATE OF job;
  IF created_job IS NOT NULL THEN RETURN QUERY SELECT created_job,qualification,true;RETURN;END IF;
  INSERT INTO client_routing_source_qualifications(tenant_id,routing_version_id,source_id,integration_id,integration_revision,
    source_definition,source_sha256,created_by)
  VALUES(current_tenant,requested_version_id,requested_source_id,requested_integration_id,expected_integration_revision,
    source,encode(digest(source::text,'sha256'),'hex'),requested_by) RETURNING id INTO qualification;
  INSERT INTO client_routing_sync_jobs(tenant_id,source_state_id,qualification_id,config_sha256,trigger_key,trigger_kind,
    expected_snapshot_revision,max_attempts)
  VALUES(current_tenant,NULL,qualification,encode(digest(source::text,'sha256'),'hex'),'qualification:'||request_key,
    'QUALIFICATION',0,3) RETURNING id INTO created_job;
  RETURN QUERY SELECT created_job,qualification,false;
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
       LEFT JOIN client_routing_source_state state ON state.tenant_id=candidate.tenant_id AND state.id=candidate.source_state_id
       LEFT JOIN client_routing_source_qualifications qualification ON qualification.tenant_id=candidate.tenant_id AND qualification.id=candidate.qualification_id
       JOIN client_routing_integrations integration ON integration.tenant_id=candidate.tenant_id
        AND integration.secret_reference=COALESCE(state.secret_reference,qualification.source_definition->>'secretReference')
        AND integration.provider=COALESCE(state.kind,qualification.source_definition->>'kind') AND integration.state='CONNECTED'
      WHERE candidate.tenant_id=current_tenant
        AND ((candidate.trigger_kind='QUALIFICATION' AND qualification.id IS NOT NULL
              AND integration.id=qualification.integration_id AND integration.revision=qualification.integration_revision)
          OR (candidate.trigger_kind<>'QUALIFICATION' AND state.state='ACTIVE' AND state.config_sha256=candidate.config_sha256))
        AND candidate.attempts<candidate.max_attempts AND ((candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at<=now()) OR
          (candidate.state='RUNNING' AND candidate.lease_expires_at<now()))
      ORDER BY candidate.available_at,candidate.created_at FOR UPDATE OF candidate SKIP LOCKED LIMIT claim_limit)
    RETURNING job.*
  ) SELECT job.id,COALESCE(state.id,qualification.id),COALESCE(state.source_id,qualification.source_id),
      COALESCE(state.kind,qualification.source_definition->>'kind'),
      CASE WHEN qualification.id IS NOT NULL THEN 'QUALIFICATION' ELSE state.sync_mode END,
      COALESCE(state.secret_reference,qualification.source_definition->>'secretReference'),
      COALESCE(state.endpoint_url,qualification.source_definition->>'endpointUrl'),state.schedule_minutes,
      COALESCE(state.field_mapping,qualification.source_definition->'fieldMapping','{}'::jsonb),job.config_sha256,
      COALESCE(state.snapshot,'[]'::jsonb),COALESCE(state.snapshot_revision,0),state.cursor_value,job.attempts,job.fencing_token
    FROM claimed job
    LEFT JOIN client_routing_source_state state ON state.tenant_id=job.tenant_id AND state.id=job.source_state_id
    LEFT JOIN client_routing_source_qualifications qualification ON qualification.tenant_id=job.tenant_id AND qualification.id=job.qualification_id;
END
$$;

CREATE OR REPLACE FUNCTION app.complete_client_routing_source_qualification(
  requested_job_id uuid,worker_lease uuid,expected_fence bigint
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE affected integer;
BEGIN
  UPDATE client_routing_sync_jobs SET state='SUCCEEDED',lease_id=NULL,lease_expires_at=NULL,safe_error=NULL,
    completed_at=now(),updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=requested_job_id AND trigger_kind='QUALIFICATION'
     AND state='RUNNING' AND lease_id=worker_lease AND fencing_token=expected_fence AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected=1;
END
$$;

CREATE OR REPLACE FUNCTION app.revoke_client_routing_integration_for_sync(
  requested_job_id uuid,worker_lease uuid,expected_fence bigint,failure text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE reference text;DECLARE provider_kind text;DECLARE revoked_id uuid;
BEGIN
  SELECT COALESCE(source.secret_reference,qualification.source_definition->>'secretReference'),
         COALESCE(source.kind,qualification.source_definition->>'kind') INTO reference,provider_kind
    FROM client_routing_sync_jobs job
    LEFT JOIN client_routing_source_state source ON source.tenant_id=job.tenant_id AND source.id=job.source_state_id
    LEFT JOIN client_routing_source_qualifications qualification ON qualification.tenant_id=job.tenant_id AND qualification.id=job.qualification_id
   WHERE job.tenant_id=current_tenant AND job.id=requested_job_id AND job.state='RUNNING'
     AND job.lease_id=worker_lease AND job.fencing_token=expected_fence AND job.lease_expires_at>=now() FOR UPDATE OF job;
  IF reference IS NULL THEN RETURN NULL;END IF;
  UPDATE client_routing_integrations SET state='REVOKED',revision=revision+1,updated_at=now()
   WHERE tenant_id=current_tenant AND secret_reference=reference AND provider=provider_kind AND state='CONNECTED'
   RETURNING id INTO revoked_id;
  IF revoked_id IS NOT NULL THEN
    INSERT INTO audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
    VALUES(current_tenant,'SYSTEM','routing-sync-worker','client_routing.integration_revoked','client_routing_integration',revoked_id::text,
      jsonb_build_object('reason','AUTHORIZATION_REVOKED','safe_error',left(failure,500)),
      'routing-auth-revoked-'||requested_job_id::text||'-'||expected_fence::text);
  END IF;
  RETURN revoked_id;
END
$$;

REVOKE ALL ON FUNCTION app.request_client_routing_source_qualification(uuid,bigint,text,uuid,bigint,uuid,text),
  app.complete_client_routing_source_qualification(uuid,uuid,bigint),
  app.revoke_client_routing_integration_for_sync(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_client_routing_source_qualification(uuid,bigint,text,uuid,bigint,uuid,text),
  app.complete_client_routing_source_qualification(uuid,uuid,bigint),
  app.revoke_client_routing_integration_for_sync(uuid,uuid,bigint,text) TO wasalx_app;
