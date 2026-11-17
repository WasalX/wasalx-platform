ALTER TABLE client_routing_versions
  ALTER COLUMN created_by DROP NOT NULL,
  ADD COLUMN created_actor_type text NOT NULL DEFAULT 'USER'
    CHECK (created_actor_type IN ('USER','SYSTEM')),
  ADD COLUMN created_sync_job_id uuid;

CREATE TABLE client_routing_source_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id text NOT NULL CHECK (source_id ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  routing_version_id uuid NOT NULL,
  config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('NOTION','ZOHO','HTTP_JSON')),
  sync_mode text NOT NULL CHECK (sync_mode IN ('WEBHOOK','SCHEDULED','HYBRID')),
  secret_reference text NOT NULL CHECK (secret_reference ~ '^secret://tenants/[0-9a-f-]+/routing/[A-Za-z0-9._~/-]+$'),
  endpoint_url text,
  schedule_minutes integer CHECK (schedule_minutes IS NULL OR schedule_minutes BETWEEN 5 AND 10080),
  field_mapping jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_mapping)='object'),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','CONFLICT','RETIRED')),
  snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(snapshot)='array' AND octet_length(snapshot::text)<=5000000),
  snapshot_sha256 text NOT NULL DEFAULT encode(digest('[]','sha256'),'hex') CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_revision bigint NOT NULL DEFAULT 0 CHECK (snapshot_revision>=0),
  cursor_value text CHECK (cursor_value IS NULL OR length(cursor_value)<=1000),
  last_success_at timestamptz,
  next_due_at timestamptz,
  safe_error text CHECK (safe_error IS NULL OR length(safe_error)<=500),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,source_id,config_sha256),
  FOREIGN KEY (tenant_id,routing_version_id) REFERENCES client_routing_versions(tenant_id,id)
);

CREATE UNIQUE INDEX client_routing_source_state_one_active
  ON client_routing_source_state(tenant_id,source_id) WHERE state<>'RETIRED';

CREATE TABLE client_routing_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_state_id uuid NOT NULL,
  config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  trigger_key text NOT NULL CHECK (length(trigger_key) BETWEEN 1 AND 200),
  trigger_kind text NOT NULL CHECK (trigger_kind IN ('ACTIVATION','MANUAL','WEBHOOK','SCHEDULED')),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','DISCARDED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token>=0),
  expected_snapshot_revision bigint NOT NULL CHECK (expected_snapshot_revision>=0),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error)<=500),
  result_routing_version_id uuid,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,source_state_id,trigger_key),
  FOREIGN KEY (tenant_id,source_state_id) REFERENCES client_routing_source_state(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,result_routing_version_id) REFERENCES client_routing_versions(tenant_id,id),
  CHECK ((state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state<>'RUNNING' AND lease_id IS NULL AND lease_expires_at IS NULL)),
  CHECK ((state IN ('SUCCEEDED','FAILED_TERMINAL','DISCARDED') AND completed_at IS NOT NULL) OR (state NOT IN ('SUCCEEDED','FAILED_TERMINAL','DISCARDED') AND completed_at IS NULL))
);

ALTER TABLE client_routing_versions
  ADD CONSTRAINT client_routing_versions_created_actor_check CHECK (
    (created_actor_type='USER' AND created_by IS NOT NULL AND created_sync_job_id IS NULL)
    OR (created_actor_type='SYSTEM' AND created_by IS NULL AND created_sync_job_id IS NOT NULL)
  ),
  ADD CONSTRAINT client_routing_versions_sync_job_fk
    FOREIGN KEY (tenant_id,created_sync_job_id) REFERENCES client_routing_sync_jobs(tenant_id,id);

CREATE INDEX client_routing_sync_jobs_claim
  ON client_routing_sync_jobs(tenant_id,available_at,created_at)
  WHERE state IN ('QUEUED','FAILED_RETRYABLE','RUNNING');

ALTER TABLE client_routing_source_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_source_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_source_state
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
ALTER TABLE client_routing_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_routing_sync_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON client_routing_sync_jobs
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

REVOKE INSERT,UPDATE,DELETE ON client_routing_source_state,client_routing_sync_jobs FROM wasalx_app;
GRANT SELECT ON client_routing_source_state,client_routing_sync_jobs TO wasalx_app;

CREATE OR REPLACE FUNCTION app.reconcile_client_routing_sources(requested_version_id uuid,requested_by uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE current_tenant uuid;DECLARE requested_definition jsonb;DECLARE queued integer;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin')) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  SELECT definition INTO requested_definition FROM client_routing_versions
   WHERE tenant_id=current_tenant AND id=requested_version_id AND state='ACTIVE' FOR SHARE;
  IF requested_definition IS NULL THEN RAISE EXCEPTION 'active client routing version was not found' USING ERRCODE='22023';END IF;
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
  INSERT INTO client_routing_source_state(tenant_id,source_id,routing_version_id,config_sha256,kind,sync_mode,secret_reference,endpoint_url,schedule_minutes,field_mapping,next_due_at)
  SELECT current_tenant,source->>'id',requested_version_id,encode(digest(source::text,'sha256'),'hex'),source->>'kind',source->>'syncMode',source->>'secretReference',
    NULLIF(source->>'endpointUrl',''),NULLIF(source->>'scheduleMinutes','')::integer,COALESCE(source->'fieldMapping','{}'::jsonb),now()
    FROM jsonb_array_elements(requested_definition->'sources') source WHERE source->>'kind'<>'MANUAL'
  ON CONFLICT (tenant_id,source_id,config_sha256) DO UPDATE SET
    routing_version_id=EXCLUDED.routing_version_id,state='ACTIVE',next_due_at=now(),safe_error=NULL,updated_at=now();
  INSERT INTO client_routing_sync_jobs(tenant_id,source_state_id,config_sha256,trigger_key,trigger_kind,expected_snapshot_revision)
  SELECT current_tenant,state.id,state.config_sha256,'activation:'||requested_version_id::text,'ACTIVATION',state.snapshot_revision
    FROM client_routing_source_state state WHERE state.tenant_id=current_tenant AND state.state='ACTIVE'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS queued=ROW_COUNT;RETURN queued;
END
$$;

CREATE OR REPLACE FUNCTION app.claim_client_routing_sync_jobs(worker_lease uuid,claim_limit integer DEFAULT 10)
RETURNS TABLE(job_id uuid,source_state_id uuid,source_id text,kind text,sync_mode text,secret_reference text,endpoint_url text,
  schedule_minutes integer,field_mapping jsonb,config_sha256 text,snapshot jsonb,snapshot_revision bigint,cursor_value text,attempts integer,fencing_token bigint)
LANGUAGE plpgsql AS $$
BEGIN
  IF worker_lease IS NULL OR claim_limit<1 OR claim_limit>50 THEN RAISE EXCEPTION 'invalid routing sync claim' USING ERRCODE='22023';END IF;
  UPDATE client_routing_sync_jobs job SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
    safe_error=COALESCE(job.safe_error,'Routing connector exhausted its retry limit.'),completed_at=now(),updated_at=now()
   WHERE job.tenant_id=app.current_tenant_id() AND job.attempts>=job.max_attempts AND
    (job.state IN ('QUEUED','FAILED_RETRYABLE') OR (job.state='RUNNING' AND job.lease_expires_at<now()));
  RETURN QUERY WITH claimed AS (
    UPDATE client_routing_sync_jobs job SET state='RUNNING',attempts=job.attempts+1,lease_id=worker_lease,
      lease_expires_at=now()+interval '2 minutes',fencing_token=job.fencing_token+1,safe_error=NULL,updated_at=now()
     WHERE job.id IN (SELECT candidate.id FROM client_routing_sync_jobs candidate
       JOIN client_routing_source_state state ON state.tenant_id=candidate.tenant_id AND state.id=candidate.source_state_id
      WHERE candidate.tenant_id=app.current_tenant_id() AND state.state='ACTIVE' AND state.config_sha256=candidate.config_sha256
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
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE affected integer;
BEGIN
  UPDATE client_routing_sync_jobs SET state=CASE WHEN retryable AND attempts<max_attempts THEN 'FAILED_RETRYABLE' ELSE 'FAILED_TERMINAL' END,
    lease_id=NULL,lease_expires_at=NULL,available_at=CASE WHEN retryable AND attempts<max_attempts THEN COALESCE(retry_at,now()+interval '1 minute') ELSE available_at END,
    safe_error=left(failure,500),completed_at=CASE WHEN retryable AND attempts<max_attempts THEN NULL ELSE now() END,updated_at=now()
   WHERE tenant_id=app.current_tenant_id() AND id=requested_job_id AND state='RUNNING' AND lease_id=worker_lease
     AND fencing_token=expected_fence AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected=1;
END
$$;

CREATE OR REPLACE FUNCTION app.enforce_client_routing_version_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.version<>OLD.version OR NEW.definition<>OLD.definition
     OR NEW.snapshot_sha256<>OLD.snapshot_sha256 OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_actor_type<>OLD.created_actor_type OR NEW.created_sync_job_id IS DISTINCT FROM OLD.created_sync_job_id OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'client routing versions are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='DRAFT' AND NEW.state='ACTIVE') OR (OLD.state='ACTIVE' AND NEW.state='RETIRED')) OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'invalid client routing lifecycle transition' USING ERRCODE='55000';
  END IF;RETURN NEW;
END
$$;

GRANT EXECUTE ON FUNCTION app.reconcile_client_routing_sources(uuid,uuid) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.claim_client_routing_sync_jobs(uuid,integer) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.fail_client_routing_sync_job(uuid,uuid,bigint,boolean,text,timestamptz) TO wasalx_app;
REVOKE ALL ON FUNCTION app.reconcile_client_routing_sources(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_client_routing_sync_jobs(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_client_routing_sync_job(uuid,uuid,bigint,boolean,text,timestamptz) FROM PUBLIC;
