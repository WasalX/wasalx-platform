-- Durable tenant provisioning is a platform-plane workflow. It never runs
-- through the ordinary tenant API role and never treats an in-process stub as
-- infrastructure completion.
ALTER TABLE provisioning_operations
  ADD COLUMN operation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN action text NOT NULL DEFAULT 'PROVISION',
  ADD COLUMN spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN step_results jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 25,
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_id uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN requested_by text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

UPDATE provisioning_operations
   SET status = 'FAILED',
       error_code = COALESCE(error_code, 'LEGACY_OPERATION_REQUIRES_RETRY'),
       error_detail = COALESCE(error_detail, 'Legacy provisioning work must be retried through the durable runtime.'),
       current_step = NULL
 WHERE status = 'RUNNING';

UPDATE provisioning_operations
   SET completed_at = COALESCE(completed_at, updated_at)
 WHERE status = 'COMPLETE';

ALTER TABLE provisioning_operations
  ADD CONSTRAINT provisioning_operations_operation_id_unique UNIQUE (operation_id),
  ADD CONSTRAINT provisioning_operations_action_check
    CHECK (action IN ('PROVISION','SUSPEND')),
  ADD CONSTRAINT provisioning_operations_status_check
    CHECK (status IN (
      'PENDING','RUNNING','FAILED_RETRYABLE','FAILED','COMPLETE',
      'SUSPEND_PENDING','SUSPENDING','SUSPENDED'
    )),
  ADD CONSTRAINT provisioning_operations_step_check
    CHECK (current_step IS NULL OR current_step IN (
      'identity','database','search','storage','secrets',
      'zammad','package','oidc','defaults','health','suspend'
    )),
  ADD CONSTRAINT provisioning_operations_json_check
    CHECK (
      jsonb_typeof(completed_steps) = 'array'
      AND jsonb_typeof(spec) = 'object'
      AND jsonb_typeof(step_results) = 'object'
    ),
  ADD CONSTRAINT provisioning_operations_attempts_check
    CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 100 AND attempts <= max_attempts),
  ADD CONSTRAINT provisioning_operations_error_check
    CHECK (
      (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100)
      AND (error_detail IS NULL OR length(error_detail) BETWEEN 1 AND 500)
    ),
  ADD CONSTRAINT provisioning_operations_lease_check
    CHECK (
      (status IN ('RUNNING','SUSPENDING') AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status NOT IN ('RUNNING','SUSPENDING') AND lease_id IS NULL AND lease_expires_at IS NULL)
    ),
  ADD CONSTRAINT provisioning_operations_completion_check
    CHECK (
      (status IN ('COMPLETE','SUSPENDED') AND completed_at IS NOT NULL)
      OR (status NOT IN ('COMPLETE','SUSPENDED') AND completed_at IS NULL)
    );

CREATE INDEX provisioning_operations_claim_idx
  ON provisioning_operations (available_at, updated_at, tenant_id)
  WHERE status IN ('PENDING','FAILED_RETRYABLE','RUNNING','SUSPEND_PENDING','SUSPENDING');

CREATE TABLE provisioning_operator_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action IN ('CREATE','RETRY','SUSPEND')),
  tenant_id uuid,
  actor_subject text NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 255),
  response jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.provisioning_operator_requests FROM PUBLIC, wasalx_app, wasalx_provisioner;
REVOKE INSERT, UPDATE, DELETE ON public.tenants, public.users,
  public.tenant_memberships, public.provisioning_operations,
  public.zammad_instances, public.secret_references FROM wasalx_provisioner;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_provisioning_executor') THEN
    CREATE ROLE wasalx_provisioning_executor NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE wasalx_provisioning_executor NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_provisioning_client') THEN
    CREATE ROLE wasalx_provisioning_client NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_provisioning_client NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO wasalx_provisioning_executor;
GRANT SELECT, INSERT, UPDATE ON public.tenants, public.users,
  public.tenant_memberships, public.provisioning_operations,
  public.provisioning_operator_requests, public.audit_events
  TO wasalx_provisioning_executor;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wasalx_provisioning_executor;

CREATE OR REPLACE FUNCTION app.operator_create_tenant(
  request_key text,
  request_hash text,
  tenant_name text,
  tenant_slug text,
  retention_days_value integer,
  provisioning_spec jsonb,
  owner_subject text,
  owner_email text,
  owner_display_name text,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  inserted_request uuid;
  existing_request provisioning_operator_requests%ROWTYPE;
  tenant_value uuid := gen_random_uuid();
  operation_value uuid := gen_random_uuid();
  user_value uuid;
  response_value jsonb;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF request_hash !~ '^[0-9a-f]{64}$' OR jsonb_typeof(provisioning_spec) <> 'object' THEN
    RAISE EXCEPTION 'invalid provisioning request' USING ERRCODE = '22023';
  END IF;

  INSERT INTO provisioning_operator_requests
    (idempotency_key,request_sha256,action,actor_subject)
  VALUES (request_key,request_hash,'CREATE',actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO inserted_request;

  IF inserted_request IS NULL THEN
    SELECT * INTO existing_request
      FROM provisioning_operator_requests
     WHERE idempotency_key = request_key;
    IF existing_request.action <> 'CREATE'
       OR existing_request.request_sha256 <> request_hash
       OR existing_request.actor_subject <> actor_subject THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  INSERT INTO tenants (id,name,slug,state,retention_days)
  VALUES (tenant_value,tenant_name,tenant_slug,'PROVISIONING',retention_days_value);

  INSERT INTO users (oidc_subject,email,display_name)
  VALUES (owner_subject,owner_email,owner_display_name)
  ON CONFLICT (oidc_subject) DO NOTHING;
  SELECT id INTO user_value FROM users WHERE oidc_subject = owner_subject;
  IF user_value IS NULL THEN
    RAISE EXCEPTION 'owner identity could not be resolved' USING ERRCODE = '23503';
  END IF;

  INSERT INTO tenant_memberships (tenant_id,user_id,role)
  VALUES (tenant_value,user_value,'tenant_owner');

  INSERT INTO provisioning_operations
    (tenant_id,operation_id,status,action,spec,completed_steps,step_results,requested_by)
  VALUES
    (tenant_value,operation_value,'PENDING','PROVISION',provisioning_spec,'[]'::jsonb,'{}'::jsonb,actor_subject);

  response_value := jsonb_build_object(
    'tenant_id',tenant_value,
    'operation_id',operation_value,
    'tenant_state','PROVISIONING',
    'status','PENDING',
    'duplicate',false
  );
  UPDATE provisioning_operator_requests
     SET tenant_id = tenant_value,
         response = response_value
   WHERE id = inserted_request;

  INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  VALUES
    (tenant_value,'PLATFORM_OPERATOR',actor_subject,'tenant.provisioning_created',
     'tenant',tenant_value::text,
     jsonb_build_object('operation_id',operation_value,'slug',tenant_slug,'status','PENDING'),
     audit_request_id);
  RETURN response_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_tenant_provisioning_status(
  tenant_value uuid,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE result_value jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant_id',t.id,'tenant_name',t.name,'tenant_slug',t.slug,'tenant_state',t.state,
    'operation_id',p.operation_id,'action',p.action,'status',p.status,
    'completed_steps',p.completed_steps,'current_step',p.current_step,
    'step_results',p.step_results,'attempts',p.attempts,'max_attempts',p.max_attempts,
    'fencing_token',p.fencing_token,'error_code',p.error_code,
    'error_detail',p.error_detail,'available_at',p.available_at,
    'lease_expires_at',p.lease_expires_at,'completed_at',p.completed_at,
    'updated_at',p.updated_at
  ) INTO result_value
  FROM tenants t
  JOIN provisioning_operations p ON p.tenant_id=t.id
  WHERE t.id=tenant_value;
  IF result_value IS NULL THEN RETURN NULL; END IF;
  INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  VALUES
    (tenant_value,'PLATFORM_OPERATOR',actor_subject,'tenant.provisioning_inspected',
     'tenant',tenant_value::text,jsonb_build_object('support_access',true),audit_request_id);
  RETURN result_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_retry_tenant_provisioning(
  tenant_value uuid,
  request_key text,
  request_hash text,
  actor_subject text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  inserted_request uuid;
  existing_request provisioning_operator_requests%ROWTYPE;
  operation_value provisioning_operations%ROWTYPE;
  response_value jsonb;
BEGIN
  INSERT INTO provisioning_operator_requests
    (idempotency_key,request_sha256,action,tenant_id,actor_subject)
  VALUES (request_key,request_hash,'RETRY',tenant_value,actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO inserted_request;
  IF inserted_request IS NULL THEN
    SELECT * INTO existing_request FROM provisioning_operator_requests WHERE idempotency_key=request_key;
    IF existing_request.action <> 'RETRY'
       OR existing_request.request_sha256 <> request_hash
       OR existing_request.actor_subject <> actor_subject THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  SELECT * INTO operation_value FROM provisioning_operations
   WHERE tenant_id=tenant_value FOR UPDATE;
  IF operation_value.tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant provisioning operation not found' USING ERRCODE = 'P0002';
  END IF;
  IF operation_value.status NOT IN ('FAILED','FAILED_RETRYABLE') THEN
    RAISE EXCEPTION 'only failed provisioning can be retried' USING ERRCODE = '55000';
  END IF;
  UPDATE provisioning_operations
     SET status = CASE WHEN action='SUSPEND' THEN 'SUSPEND_PENDING' ELSE 'PENDING' END,
         attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
         error_code=NULL,error_detail=NULL,completed_at=NULL,updated_at=now()
   WHERE tenant_id=tenant_value
   RETURNING * INTO operation_value;
  response_value := jsonb_build_object(
    'tenant_id',tenant_value,'operation_id',operation_value.operation_id,
    'status',operation_value.status,'duplicate',false
  );
  UPDATE provisioning_operator_requests SET response=response_value WHERE id=inserted_request;
  INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  VALUES
    (tenant_value,'PLATFORM_OPERATOR',actor_subject,'tenant.provisioning_retry_requested',
     'tenant',tenant_value::text,response_value,audit_request_id);
  RETURN response_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.operator_suspend_tenant(
  tenant_value uuid,
  request_key text,
  request_hash text,
  actor_subject text,
  reason_value text,
  audit_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  inserted_request uuid;
  existing_request provisioning_operator_requests%ROWTYPE;
  tenant_state text;
  operation_value provisioning_operations%ROWTYPE;
  response_value jsonb;
BEGIN
  INSERT INTO provisioning_operator_requests
    (idempotency_key,request_sha256,action,tenant_id,actor_subject)
  VALUES (request_key,request_hash,'SUSPEND',tenant_value,actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO inserted_request;
  IF inserted_request IS NULL THEN
    SELECT * INTO existing_request FROM provisioning_operator_requests WHERE idempotency_key=request_key;
    IF existing_request.action <> 'SUSPEND'
       OR existing_request.request_sha256 <> request_hash
       OR existing_request.actor_subject <> actor_subject THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  SELECT state INTO tenant_state FROM tenants WHERE id=tenant_value FOR UPDATE;
  SELECT * INTO operation_value FROM provisioning_operations WHERE tenant_id=tenant_value FOR UPDATE;
  IF tenant_state IS NULL OR operation_value.tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant provisioning operation not found' USING ERRCODE = 'P0002';
  END IF;
  IF tenant_state = 'SUSPENDED' THEN
    response_value := jsonb_build_object(
      'tenant_id',tenant_value,'operation_id',operation_value.operation_id,
      'status','SUSPENDED','duplicate',true
    );
  ELSE
    IF tenant_state <> 'ACTIVE' OR operation_value.status <> 'COMPLETE' THEN
      RAISE EXCEPTION 'only an active, completely provisioned tenant can be suspended' USING ERRCODE = '55000';
    END IF;
    UPDATE provisioning_operations
       SET action='SUSPEND',status='SUSPEND_PENDING',current_step=NULL,
           attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
           error_code=NULL,error_detail=NULL,completed_at=NULL,updated_at=now()
     WHERE tenant_id=tenant_value
     RETURNING * INTO operation_value;
    response_value := jsonb_build_object(
      'tenant_id',tenant_value,'operation_id',operation_value.operation_id,
      'status','SUSPEND_PENDING','duplicate',false
    );
  END IF;
  UPDATE provisioning_operator_requests SET response=response_value WHERE id=inserted_request;
  INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
  VALUES
    (tenant_value,'PLATFORM_OPERATOR',actor_subject,'tenant.suspension_requested',
     'tenant',tenant_value::text,jsonb_build_object('state',tenant_state),
     jsonb_build_object('status',response_value->>'status','reason',left(reason_value,500)),audit_request_id);
  RETURN response_value;
END;
$$;

CREATE OR REPLACE FUNCTION app.claim_tenant_provisioning_tasks(
  worker_lease uuid,
  claim_limit integer DEFAULT 5
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 25 THEN
    RAISE EXCEPTION 'invalid provisioning claim' USING ERRCODE = '22023';
  END IF;
  UPDATE provisioning_operations
     SET status='FAILED',lease_id=NULL,lease_expires_at=NULL,
         error_code=COALESCE(error_code,'MAX_ATTEMPTS_EXHAUSTED'),
         error_detail=COALESCE(error_detail,'Tenant provisioning exhausted its retry limit.'),
         updated_at=now()
   WHERE attempts >= max_attempts
     AND (status IN ('PENDING','FAILED_RETRYABLE','SUSPEND_PENDING')
       OR (status IN ('RUNNING','SUSPENDING') AND lease_expires_at < now()));

  RETURN QUERY
  WITH candidates AS (
    SELECT p.tenant_id
      FROM provisioning_operations p
      JOIN tenants t ON t.id=p.tenant_id
     WHERE p.attempts < p.max_attempts
       AND p.available_at <= now()
       AND (
         p.status IN ('PENDING','FAILED_RETRYABLE','SUSPEND_PENDING')
         OR (p.status IN ('RUNNING','SUSPENDING') AND p.lease_expires_at < now())
       )
       AND ((p.action='PROVISION' AND t.state='PROVISIONING')
         OR (p.action='SUSPEND' AND t.state='ACTIVE'))
     ORDER BY p.available_at,p.updated_at,p.tenant_id
     FOR UPDATE OF p SKIP LOCKED
     LIMIT claim_limit
  ), claimed AS (
    UPDATE provisioning_operations p
       SET status=CASE WHEN p.action='SUSPEND' THEN 'SUSPENDING' ELSE 'RUNNING' END,
           lease_id=worker_lease,lease_expires_at=now()+interval '120 seconds',
           fencing_token=p.fencing_token+1,attempts=p.attempts+1,
           error_code=NULL,error_detail=NULL,updated_at=now()
      FROM candidates c
     WHERE p.tenant_id=c.tenant_id
    RETURNING p.*
  )
  SELECT jsonb_build_object(
    'operationId',p.operation_id,'tenantId',p.tenant_id,'action',p.action,
    'status',p.status,'completedSteps',p.completed_steps,
    'currentStep',p.current_step,'stepResults',p.step_results,'spec',p.spec,
    'attempts',p.attempts,'maxAttempts',p.max_attempts,'fencingToken',p.fencing_token
  ) FROM claimed p;
END;
$$;

CREATE OR REPLACE FUNCTION app.start_tenant_provisioning_step(
  tenant_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  step_value text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE affected integer;
BEGIN
  IF step_value NOT IN ('identity','database','search','storage','secrets','zammad','package','oidc','defaults','health') THEN
    RAISE EXCEPTION 'invalid provisioning step' USING ERRCODE = '22023';
  END IF;
  UPDATE provisioning_operations
     SET current_step=step_value,updated_at=now()
   WHERE tenant_id=tenant_value AND action='PROVISION' AND status='RUNNING'
     AND lease_id=worker_lease AND fencing_token=expected_fencing_token
     AND lease_expires_at>=now()
     AND (current_step IS NULL OR current_step=step_value)
     AND completed_steps = CASE step_value
       WHEN 'identity' THEN '[]'::jsonb
       WHEN 'database' THEN '["identity"]'::jsonb
       WHEN 'search' THEN '["identity","database"]'::jsonb
       WHEN 'storage' THEN '["identity","database","search"]'::jsonb
       WHEN 'secrets' THEN '["identity","database","search","storage"]'::jsonb
       WHEN 'zammad' THEN '["identity","database","search","storage","secrets"]'::jsonb
       WHEN 'package' THEN '["identity","database","search","storage","secrets","zammad"]'::jsonb
       WHEN 'oidc' THEN '["identity","database","search","storage","secrets","zammad","package"]'::jsonb
       WHEN 'defaults' THEN '["identity","database","search","storage","secrets","zammad","package","oidc"]'::jsonb
       WHEN 'health' THEN '["identity","database","search","storage","secrets","zammad","package","oidc","defaults"]'::jsonb
     END;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_tenant_provisioning_step(
  tenant_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  step_value text,
  result_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  affected integer;
  tenant_affected integer;
BEGIN
  IF jsonb_typeof(result_value) <> 'object' OR octet_length(result_value::text) > 32768 THEN
    RAISE EXCEPTION 'invalid provisioning step result' USING ERRCODE = '22023';
  END IF;
  UPDATE provisioning_operations
     SET completed_steps=CASE
           WHEN completed_steps @> jsonb_build_array(step_value) THEN completed_steps
           ELSE completed_steps || jsonb_build_array(step_value)
         END,
         step_results=jsonb_set(step_results,ARRAY[step_value],result_value,true),
         current_step=NULL,status=CASE WHEN step_value='health' THEN 'COMPLETE' ELSE 'PENDING' END,
         lease_id=NULL,lease_expires_at=NULL,error_code=NULL,error_detail=NULL,
         completed_at=CASE WHEN step_value='health' THEN now() ELSE NULL END,
         available_at=now(),updated_at=now()
   WHERE tenant_id=tenant_value AND action='PROVISION' AND status='RUNNING'
     AND current_step=step_value AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 AND step_value='health' THEN
    UPDATE tenants SET state='ACTIVE',updated_at=now() WHERE id=tenant_value AND state='PROVISIONING';
    GET DIAGNOSTICS tenant_affected=ROW_COUNT;
    IF tenant_affected <> 1 THEN
      RAISE EXCEPTION 'tenant state changed before provisioning completed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_tenant_suspension(
  tenant_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  result_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE
  affected integer;
  tenant_affected integer;
BEGIN
  IF jsonb_typeof(result_value) <> 'object' OR octet_length(result_value::text) > 32768 THEN
    RAISE EXCEPTION 'invalid suspension result' USING ERRCODE = '22023';
  END IF;
  UPDATE provisioning_operations
     SET status='SUSPENDED',current_step=NULL,
         step_results=jsonb_set(step_results,ARRAY['suspend'],result_value,true),
         lease_id=NULL,lease_expires_at=NULL,error_code=NULL,error_detail=NULL,
         completed_at=now(),updated_at=now()
   WHERE tenant_id=tenant_value AND action='SUSPEND' AND status='SUSPENDING'
     AND lease_id=worker_lease AND fencing_token=expected_fencing_token
     AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN
    UPDATE tenants SET state='SUSPENDED',updated_at=now() WHERE id=tenant_value AND state='ACTIVE';
    GET DIAGNOSTICS tenant_affected=ROW_COUNT;
    IF tenant_affected <> 1 THEN
      RAISE EXCEPTION 'tenant state changed before suspension completed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.fail_tenant_provisioning_task(
  tenant_value uuid,
  worker_lease uuid,
  expected_fencing_token bigint,
  retryable boolean,
  failure_code text,
  failure_detail text,
  retry_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE affected integer;
BEGIN
  IF failure_code IS NULL OR length(failure_code) NOT BETWEEN 1 AND 100
     OR failure_detail IS NULL OR length(failure_detail) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid provisioning failure' USING ERRCODE = '22023';
  END IF;
  UPDATE provisioning_operations
     SET status=CASE WHEN retryable AND attempts<max_attempts THEN 'FAILED_RETRYABLE' ELSE 'FAILED' END,
         lease_id=NULL,lease_expires_at=NULL,error_code=failure_code,error_detail=failure_detail,
         available_at=CASE WHEN retryable AND attempts<max_attempts
           THEN COALESCE(retry_at,now()+interval '30 seconds') ELSE available_at END,
         updated_at=now()
   WHERE tenant_id=tenant_value AND status IN ('RUNNING','SUSPENDING')
     AND lease_id=worker_lease AND fencing_token=expected_fencing_token
     AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END;
$$;

GRANT CREATE ON SCHEMA app TO wasalx_provisioning_executor;
ALTER FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.operator_tenant_provisioning_status(uuid,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.operator_retry_tenant_provisioning(uuid,text,text,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.operator_suspend_tenant(uuid,text,text,text,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.start_tenant_provisioning_step(uuid,uuid,bigint,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.complete_tenant_provisioning_step(uuid,uuid,bigint,text,jsonb)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.complete_tenant_suspension(uuid,uuid,bigint,jsonb)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.fail_tenant_provisioning_task(uuid,uuid,bigint,boolean,text,text,timestamptz)
  OWNER TO wasalx_provisioning_executor;
REVOKE CREATE ON SCHEMA app FROM wasalx_provisioning_executor;

REVOKE ALL ON FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.operator_tenant_provisioning_status(uuid,text,text) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.operator_retry_tenant_provisioning(uuid,text,text,text,text) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.operator_suspend_tenant(uuid,text,text,text,text,text) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.start_tenant_provisioning_step(uuid,uuid,bigint,text) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.complete_tenant_provisioning_step(uuid,uuid,bigint,text,jsonb) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.complete_tenant_suspension(uuid,uuid,bigint,jsonb) FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.fail_tenant_provisioning_task(uuid,uuid,bigint,boolean,text,text,timestamptz) FROM PUBLIC,wasalx_app,wasalx_provisioner;

GRANT USAGE ON SCHEMA app TO wasalx_provisioning_client;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO wasalx_provisioning_client',current_database()); END $$;
GRANT EXECUTE ON FUNCTION app.operator_create_tenant(text,text,text,text,integer,jsonb,text,text,text,text,text) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.operator_tenant_provisioning_status(uuid,text,text) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.operator_retry_tenant_provisioning(uuid,text,text,text,text) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.operator_suspend_tenant(uuid,text,text,text,text,text) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.start_tenant_provisioning_step(uuid,uuid,bigint,text) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.complete_tenant_provisioning_step(uuid,uuid,bigint,text,jsonb) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.complete_tenant_suspension(uuid,uuid,bigint,jsonb) TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.fail_tenant_provisioning_task(uuid,uuid,bigint,boolean,text,text,timestamptz) TO wasalx_provisioning_client;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_provisioning_runtime') THEN
    GRANT wasalx_provisioning_client TO wasalx_provisioning_runtime;
  END IF;
END
$$;
