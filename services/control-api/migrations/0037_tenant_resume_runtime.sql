-- Reactivation is a distinct, fenced lifecycle operation. A suspended tenant
-- remains inaccessible until the workspace driver returns fresh health and
-- isolation evidence and the completion transaction restores both tenant and
-- Zammad state atomically.

ALTER TABLE provisioning_operations
  DROP CONSTRAINT provisioning_operations_action_check,
  DROP CONSTRAINT provisioning_operations_status_check,
  DROP CONSTRAINT provisioning_operations_step_check,
  DROP CONSTRAINT provisioning_operations_lease_check,
  DROP CONSTRAINT provisioning_operations_completion_check;

ALTER TABLE provisioning_operations
  ADD CONSTRAINT provisioning_operations_action_check
    CHECK (action IN ('PROVISION','SUSPEND','RESUME')),
  ADD CONSTRAINT provisioning_operations_status_check
    CHECK (status IN (
      'PENDING','RUNNING','FAILED_RETRYABLE','FAILED','COMPLETE',
      'SUSPEND_PENDING','SUSPENDING','SUSPENDED',
      'RESUME_PENDING','RESUMING'
    )),
  ADD CONSTRAINT provisioning_operations_step_check
    CHECK (current_step IS NULL OR current_step IN (
      'identity','database','search','storage','secrets',
      'zammad','package','oidc','defaults','health','suspend',
      'resume_prepare','resume_publish'
    )),
  ADD CONSTRAINT provisioning_operations_lease_check
    CHECK (
      (status IN ('RUNNING','SUSPENDING','RESUMING') AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status NOT IN ('RUNNING','SUSPENDING','RESUMING') AND lease_id IS NULL AND lease_expires_at IS NULL)
    ),
  ADD CONSTRAINT provisioning_operations_completion_check
    CHECK (
      (status IN ('COMPLETE','SUSPENDED') AND completed_at IS NOT NULL)
      OR (status NOT IN ('COMPLETE','SUSPENDED') AND completed_at IS NULL)
    );

ALTER TABLE provisioning_operator_requests
  DROP CONSTRAINT provisioning_operator_requests_action_check;
ALTER TABLE provisioning_operator_requests
  ADD CONSTRAINT provisioning_operator_requests_action_check
    CHECK (action IN ('CREATE','RETRY','SUSPEND','RESUME'));

DROP INDEX provisioning_operations_claim_idx;
CREATE INDEX provisioning_operations_claim_idx
  ON provisioning_operations (available_at, updated_at, tenant_id)
  WHERE status IN (
    'PENDING','FAILED_RETRYABLE','RUNNING',
    'SUSPEND_PENDING','SUSPENDING','RESUME_PENDING','RESUMING'
  );

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
     SET status = CASE action
           WHEN 'SUSPEND' THEN 'SUSPEND_PENDING'
           WHEN 'RESUME' THEN 'RESUME_PENDING'
           ELSE 'PENDING'
         END,
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

CREATE OR REPLACE FUNCTION app.operator_resume_tenant(
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
  instance_state text;
  operation_value provisioning_operations%ROWTYPE;
  response_value jsonb;
BEGIN
  INSERT INTO provisioning_operator_requests
    (idempotency_key,request_sha256,action,tenant_id,actor_subject)
  VALUES (request_key,request_hash,'RESUME',tenant_value,actor_subject)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO inserted_request;
  IF inserted_request IS NULL THEN
    SELECT * INTO existing_request FROM provisioning_operator_requests WHERE idempotency_key=request_key;
    IF existing_request.action <> 'RESUME'
       OR existing_request.request_sha256 <> request_hash
       OR existing_request.actor_subject <> actor_subject THEN
      RAISE EXCEPTION 'idempotency key was already used for a different request' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_set(existing_request.response,'{duplicate}','true'::jsonb,true);
  END IF;

  SELECT state INTO tenant_state FROM tenants WHERE id=tenant_value FOR UPDATE;
  SELECT * INTO operation_value FROM provisioning_operations WHERE tenant_id=tenant_value FOR UPDATE;
  SELECT state INTO instance_state FROM zammad_instances WHERE tenant_id=tenant_value FOR UPDATE;
  IF tenant_state IS NULL OR operation_value.tenant_id IS NULL OR instance_state IS NULL THEN
    RAISE EXCEPTION 'tenant resume target not found' USING ERRCODE = 'P0002';
  END IF;
  IF tenant_state <> 'SUSPENDED'
     OR instance_state <> 'SUSPENDED'
     OR operation_value.status <> 'SUSPENDED' THEN
    RAISE EXCEPTION 'only a fully suspended tenant can be resumed' USING ERRCODE = '55000';
  END IF;
  IF reason_value IS NULL OR length(reason_value) NOT BETWEEN 3 AND 500
     OR reason_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid resumption reason' USING ERRCODE = '22023';
  END IF;

  UPDATE provisioning_operations
     SET action='RESUME',status='RESUME_PENDING',current_step='resume_prepare',
         attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
         error_code=NULL,error_detail=NULL,completed_at=NULL,
         requested_by=actor_subject,updated_at=now()
   WHERE tenant_id=tenant_value
   RETURNING * INTO operation_value;
  response_value := jsonb_build_object(
    'tenant_id',tenant_value,'operation_id',operation_value.operation_id,
    'status','RESUME_PENDING','duplicate',false
  );
  UPDATE provisioning_operator_requests SET response=response_value WHERE id=inserted_request;
  INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
  VALUES
    (tenant_value,'PLATFORM_OPERATOR',actor_subject,'tenant.resumption_requested',
     'tenant',tenant_value::text,
     jsonb_build_object('state',tenant_state,'zammad_state',instance_state),
     jsonb_build_object('status','RESUME_PENDING','reason',reason_value),audit_request_id);
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
     AND (status IN ('PENDING','FAILED_RETRYABLE','SUSPEND_PENDING','RESUME_PENDING')
       OR (status IN ('RUNNING','SUSPENDING','RESUMING') AND lease_expires_at < now()));

  RETURN QUERY
  WITH candidates AS (
    SELECT p.tenant_id
      FROM provisioning_operations p
      JOIN tenants t ON t.id=p.tenant_id
     WHERE p.attempts < p.max_attempts
       AND p.available_at <= now()
       AND (
         p.status IN ('PENDING','FAILED_RETRYABLE','SUSPEND_PENDING','RESUME_PENDING')
         OR (p.status IN ('RUNNING','SUSPENDING','RESUMING') AND p.lease_expires_at < now())
       )
       AND ((p.action='PROVISION' AND t.state='PROVISIONING')
         OR (p.action='SUSPEND' AND t.state='ACTIVE')
         OR (p.action='RESUME' AND p.current_step='resume_prepare' AND t.state='SUSPENDED')
         OR (p.action='RESUME' AND p.current_step='resume_publish' AND t.state='ACTIVE'))
     ORDER BY p.available_at,p.updated_at,p.tenant_id
     FOR UPDATE OF p SKIP LOCKED
     LIMIT claim_limit
  ), claimed AS (
    UPDATE provisioning_operations p
       SET status=CASE p.action
             WHEN 'SUSPEND' THEN 'SUSPENDING'
             WHEN 'RESUME' THEN 'RESUMING'
             ELSE 'RUNNING'
           END,
           lease_id=worker_lease,lease_expires_at=now()+interval '120 seconds',
           fencing_token=p.fencing_token+1,attempts=p.attempts+1,
           error_code=NULL,error_detail=NULL,updated_at=now()
      FROM candidates c
     WHERE p.tenant_id=c.tenant_id
    RETURNING p.*
  )
  SELECT jsonb_build_object(
    'operationId',p.operation_id,'zammadInstanceId',p.zammad_instance_id,
    'tenantId',p.tenant_id,'action',p.action,
    'status',p.status,'completedSteps',p.completed_steps,
    'currentStep',p.current_step,'stepResults',p.step_results,'spec',p.spec,
    'attempts',p.attempts,'maxAttempts',p.max_attempts,'fencingToken',p.fencing_token
  ) FROM claimed p;
END;
$$;

-- Migration 0034 accepted missing JSON booleans through SQL NULL and did not
-- require fresh suspension evidence. Replace it before RESUME can trust the
-- persisted SUSPENDED state as an authorization precondition.
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
  instance_affected integer;
  suspended_at timestamptz;
BEGIN
  IF jsonb_typeof(result_value) <> 'object'
     OR octet_length(result_value::text) > 32768
     OR result_value->'suspended' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'credentials_disabled' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'workloads_scaled_to_zero' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'ingress_disabled' IS DISTINCT FROM 'true'::jsonb
     OR result_value - ARRAY['suspended','credentials_disabled','workloads_scaled_to_zero','ingress_disabled','suspended_at']::text[] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid suspension result' USING ERRCODE = '22023';
  END IF;
  BEGIN
    suspended_at := (result_value->>'suspended_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid suspension evidence timestamp' USING ERRCODE = '22023';
  END;
  IF suspended_at IS NULL
     OR suspended_at < now()-interval '5 minutes'
     OR suspended_at > now()+interval '1 minute' THEN
    RAISE EXCEPTION 'suspension evidence is stale' USING ERRCODE = '22023';
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
    UPDATE zammad_instances SET state='SUSPENDED'
     WHERE tenant_id=tenant_value AND state='WORKING';
    GET DIAGNOSTICS instance_affected=ROW_COUNT;
    IF instance_affected <> 1 THEN
      RAISE EXCEPTION 'tenant Zammad instance was not active during suspension' USING ERRCODE = '55000';
    END IF;
    UPDATE tenants SET state='SUSPENDED',updated_at=now()
     WHERE id=tenant_value AND state='ACTIVE';
    GET DIAGNOSTICS tenant_affected=ROW_COUNT;
    IF tenant_affected <> 1 THEN
      RAISE EXCEPTION 'tenant state changed before suspension completed' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.authorize_tenant_resumption(
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
  instance_affected integer;
  operation_value provisioning_operations%ROWTYPE;
  instance_url text;
  checked_at timestamptz;
  provider_resumed_at timestamptz;
BEGIN
  IF jsonb_typeof(result_value) <> 'object'
     OR octet_length(result_value::text) > 32768
     OR result_value->'prepared' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'credentials_enabled' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'workloads_ready' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'healthy' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'isolation_verified' IS DISTINCT FROM 'true'::jsonb
     OR result_value->>'zammad_base_url' IS NULL
     OR result_value ? 'ingress_enabled'
     OR result_value - ARRAY['prepared','credentials_enabled','workloads_ready','healthy','isolation_verified','zammad_base_url','provider_resumed_at','checked_at']::text[] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid resumption result' USING ERRCODE = '22023';
  END IF;
  BEGIN
    checked_at := (result_value->>'checked_at')::timestamptz;
    provider_resumed_at := (result_value->>'provider_resumed_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid resumption evidence timestamps' USING ERRCODE = '22023';
  END;
  IF checked_at IS NULL OR provider_resumed_at IS NULL THEN
    RAISE EXCEPTION 'invalid resumption evidence timestamps' USING ERRCODE = '22023';
  END IF;
  IF checked_at < now()-interval '5 minutes' OR checked_at > now()+interval '1 minute'
     OR provider_resumed_at < now()-interval '5 minutes' OR provider_resumed_at > now()+interval '1 minute' THEN
    RAISE EXCEPTION 'resumption evidence is stale' USING ERRCODE = '22023';
  END IF;

  SELECT base_url INTO instance_url FROM zammad_instances
   WHERE tenant_id=tenant_value AND state='SUSPENDED' FOR UPDATE;
  IF instance_url IS NULL OR result_value->>'zammad_base_url' <> instance_url THEN
    RAISE EXCEPTION 'resumption evidence does not match the suspended workspace' USING ERRCODE = '22023';
  END IF;

  UPDATE provisioning_operations
     SET status='RESUME_PENDING',current_step='resume_publish',
         step_results=jsonb_set(step_results,ARRAY['resume_prepare'],result_value,true),
         lease_id=NULL,lease_expires_at=NULL,available_at=now(),
         error_code=NULL,error_detail=NULL,updated_at=now()
   WHERE tenant_id=tenant_value AND action='RESUME' AND status='RESUMING'
     AND current_step='resume_prepare'
     AND lease_id=worker_lease AND fencing_token=expected_fencing_token
     AND lease_expires_at>=now()
  RETURNING * INTO operation_value;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN
    UPDATE zammad_instances SET state='WORKING',last_healthy_at=checked_at
     WHERE tenant_id=tenant_value AND state='SUSPENDED';
    GET DIAGNOSTICS instance_affected=ROW_COUNT;
    IF instance_affected <> 1 THEN
      RAISE EXCEPTION 'tenant Zammad instance was not suspended during resumption' USING ERRCODE = '55000';
    END IF;
    UPDATE tenants SET state='ACTIVE',updated_at=now()
     WHERE id=tenant_value AND state='SUSPENDED';
    GET DIAGNOSTICS tenant_affected=ROW_COUNT;
    IF tenant_affected <> 1 THEN
      RAISE EXCEPTION 'tenant state changed before resumption completed' USING ERRCODE = '55000';
    END IF;
    INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
    VALUES
      (tenant_value,'SYSTEM',COALESCE(operation_value.requested_by,'tenant-provisioning-worker'),
       'tenant.resumption_authorized','tenant',tenant_value::text,
       jsonb_build_object('state','SUSPENDED','zammad_state','SUSPENDED'),
       jsonb_build_object('state','ACTIVE','zammad_state','WORKING',
                          'checked_at',checked_at,'fencing_token',expected_fencing_token),
       'resume-authorize:'||operation_value.operation_id::text||':'||expected_fencing_token::text);
  END IF;
  RETURN affected=1;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_tenant_resumption(
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
  operation_value provisioning_operations%ROWTYPE;
  instance_url text;
  checked_at timestamptz;
  resumed_at timestamptz;
  prepared jsonb;
BEGIN
  IF jsonb_typeof(result_value) <> 'object'
     OR octet_length(result_value::text) > 32768
     OR result_value->'resumed' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'ingress_enabled' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'healthy' IS DISTINCT FROM 'true'::jsonb
     OR result_value->'isolation_verified' IS DISTINCT FROM 'true'::jsonb
     OR result_value->>'zammad_base_url' IS NULL
     OR result_value - ARRAY['resumed','ingress_enabled','healthy','isolation_verified','zammad_base_url','resumed_at','checked_at']::text[] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid resumption publication result' USING ERRCODE = '22023';
  END IF;
  BEGIN
    checked_at := (result_value->>'checked_at')::timestamptz;
    resumed_at := (result_value->>'resumed_at')::timestamptz;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'invalid resumption publication timestamps' USING ERRCODE = '22023';
  END;
  IF checked_at IS NULL OR resumed_at IS NULL
     OR checked_at < now()-interval '5 minutes' OR checked_at > now()+interval '1 minute'
     OR resumed_at < now()-interval '5 minutes' OR resumed_at > now()+interval '1 minute' THEN
    RAISE EXCEPTION 'resumption publication evidence is stale' USING ERRCODE = '22023';
  END IF;

  SELECT p.step_results->'resume_prepare',z.base_url
    INTO prepared,instance_url
    FROM provisioning_operations p
    JOIN tenants t ON t.id=p.tenant_id AND t.state='ACTIVE'
    JOIN zammad_instances z ON z.tenant_id=p.tenant_id AND z.state='WORKING'
   WHERE p.tenant_id=tenant_value AND p.action='RESUME' AND p.status='RESUMING'
     AND p.current_step='resume_publish' AND p.lease_id=worker_lease
     AND p.fencing_token=expected_fencing_token AND p.lease_expires_at>=now()
   FOR UPDATE OF p,t,z;
  IF prepared->'prepared' IS DISTINCT FROM 'true'::jsonb
     OR prepared->'credentials_enabled' IS DISTINCT FROM 'true'::jsonb
     OR prepared->'workloads_ready' IS DISTINCT FROM 'true'::jsonb
     OR prepared->'healthy' IS DISTINCT FROM 'true'::jsonb
     OR prepared->'isolation_verified' IS DISTINCT FROM 'true'::jsonb
     OR prepared->>'zammad_base_url' IS DISTINCT FROM instance_url
     OR instance_url IS NULL OR result_value->>'zammad_base_url' <> instance_url THEN
    RAISE EXCEPTION 'resumption publication is not authorized' USING ERRCODE = '55000';
  END IF;

  UPDATE provisioning_operations
     SET status='COMPLETE',current_step=NULL,
         step_results=jsonb_set(step_results,ARRAY['resume'],result_value,true),
         lease_id=NULL,lease_expires_at=NULL,error_code=NULL,error_detail=NULL,
         completed_at=now(),updated_at=now()
   WHERE tenant_id=tenant_value AND action='RESUME' AND status='RESUMING'
     AND current_step='resume_publish' AND lease_id=worker_lease
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now()
  RETURNING * INTO operation_value;
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN
    UPDATE zammad_instances SET last_healthy_at=checked_at
     WHERE tenant_id=tenant_value AND state='WORKING';
    INSERT INTO audit_events
      (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
    VALUES
      (tenant_value,'SYSTEM',COALESCE(operation_value.requested_by,'tenant-provisioning-worker'),
       'tenant.resumption_completed','tenant',tenant_value::text,
       jsonb_build_object('state','ACTIVE','ingress','PRIVATE'),
       jsonb_build_object('state','ACTIVE','zammad_state','WORKING','ingress','PUBLISHED',
                          'checked_at',checked_at,'fencing_token',expected_fencing_token),
       'resume-complete:'||operation_value.operation_id::text||':'||expected_fencing_token::text);
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
   WHERE tenant_id=tenant_value AND status IN ('RUNNING','SUSPENDING','RESUMING')
     AND lease_id=worker_lease AND fencing_token=expected_fencing_token
     AND lease_expires_at>=now();
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END;
$$;

ALTER FUNCTION app.operator_retry_tenant_provisioning(uuid,text,text,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.operator_resume_tenant(uuid,text,text,text,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.authorize_tenant_resumption(uuid,uuid,bigint,jsonb)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.complete_tenant_resumption(uuid,uuid,bigint,jsonb)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.fail_tenant_provisioning_task(uuid,uuid,bigint,boolean,text,text,timestamptz)
  OWNER TO wasalx_provisioning_executor;

REVOKE ALL ON FUNCTION app.operator_resume_tenant(uuid,text,text,text,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.authorize_tenant_resumption(uuid,uuid,bigint,jsonb)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.complete_tenant_resumption(uuid,uuid,bigint,jsonb)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
GRANT EXECUTE ON FUNCTION app.operator_resume_tenant(uuid,text,text,text,text,text)
  TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.authorize_tenant_resumption(uuid,uuid,bigint,jsonb)
  TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.complete_tenant_resumption(uuid,uuid,bigint,jsonb)
  TO wasalx_provisioning_client;

-- Keep the platform tenant-operations filter truthful while a resume is
-- queued or running. This function remains owned/granted exactly as before.
CREATE OR REPLACE FUNCTION app.operator_list_tenant_operations(
  actor_subject text,
  audit_request_id text,
  state_filter text DEFAULT NULL,
  query_filter text DEFAULT NULL,
  result_limit integer DEFAULT 50,
  cursor_value text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
DECLARE result_value jsonb;
BEGIN
  IF result_limit NOT BETWEEN 1 AND 100
     OR (state_filter IS NOT NULL AND state_filter NOT IN (
       'PROVISIONING','ACTIVE','SUSPENDED','DELETING','PENDING','RUNNING',
       'FAILED_RETRYABLE','FAILED','COMPLETE','SUSPEND_PENDING','SUSPENDING',
       'RESUME_PENDING','RESUMING'
     ))
     OR (query_filter IS NOT NULL AND (
       length(query_filter) NOT BETWEEN 1 AND 160
       OR query_filter ~ '[[:cntrl:]]'
     ))
     OR (cursor_value IS NOT NULL AND cursor_value !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'invalid tenant operations filter' USING ERRCODE='22023';
  END IF;

  WITH selected AS (
    SELECT t.id,t.name,t.slug,t.state,t.created_at,t.updated_at,
           p.operation_id,p.action,p.status,p.current_step,p.completed_steps,
           p.attempts,p.max_attempts,p.error_code,p.error_detail,
           p.available_at,p.lease_expires_at,p.completed_at,
           z.state AS zammad_state,z.version AS zammad_version,
           count(*) OVER () AS result_count
      FROM public.tenants t
      LEFT JOIN public.provisioning_operations p ON p.tenant_id=t.id
      LEFT JOIN public.zammad_instances z ON z.tenant_id=t.id
     WHERE (state_filter IS NULL OR t.state=state_filter OR p.status=state_filter)
       AND (query_filter IS NULL OR lower(t.name) LIKE '%'||lower(query_filter)||'%'
         OR lower(t.slug) LIKE '%'||lower(query_filter)||'%')
       AND (cursor_value IS NULL OR t.id::text>cursor_value)
     ORDER BY t.id
     LIMIT result_limit+1
  ), visible AS (
    SELECT * FROM selected ORDER BY id LIMIT result_limit
  )
  SELECT jsonb_build_object(
    'items',COALESCE(jsonb_agg(jsonb_build_object(
      'tenant_id',id,'name',name,'slug',slug,'tenant_state',state,
      'operation_id',operation_id,'action',action,'status',status,
      'current_step',current_step,'completed_steps',completed_steps,
      'progress_percent',LEAST(100,jsonb_array_length(COALESCE(completed_steps,'[]'::jsonb))*10),
      'attempts',attempts,'max_attempts',max_attempts,'error_code',error_code,
      'safe_error',error_detail,'available_at',available_at,
      'lease_expires_at',lease_expires_at,'completed_at',completed_at,
      'zammad_state',zammad_state,'zammad_version',zammad_version,
      'created_at',created_at,'updated_at',updated_at
    ) ORDER BY id),'[]'::jsonb),
    'next_cursor',CASE WHEN (SELECT count(*) FROM selected)>result_limit
      THEN (SELECT id::text FROM visible ORDER BY id DESC LIMIT 1) ELSE NULL END,
    'limit',result_limit
  ) INTO result_value FROM visible;

  INSERT INTO public.platform_operations_audit_events
    (operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES (
    actor_subject,'platform.tenants_inspected','tenant_collection','all',
    jsonb_build_object('state_filter',state_filter,'has_query',query_filter IS NOT NULL,
      'limit',result_limit),audit_request_id
  );
  RETURN result_value;
END;
$$;

-- Resume work must contribute to the same aggregate queue telemetry as
-- provisioning and suspension work.
CREATE OR REPLACE FUNCTION app.observability_runtime_metrics()
RETURNS TABLE(metric text, dimension text, value double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
SET row_security = off
AS $$
  WITH queue_names(queue) AS (
    VALUES
      ('inbound'::text),('delivery'::text),('zammad_status'::text),
      ('connection'::text),('privacy'::text),('provisioning'::text),
      ('quarantine'::text)
  ),
  pending(queue,created_at) AS (
    SELECT 'inbound'::text,received_at FROM event_inbox
     WHERE status IN ('ACCEPTED','FAILED_RETRYABLE')
        OR (status='PROCESSING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'delivery',created_at FROM delivery_outbox
     WHERE state IN ('QUEUED','FAILED_RETRYABLE')
        OR (state='SENDING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'zammad_status',created_at FROM zammad_status_outbox
     WHERE completed_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at<now())
    UNION ALL
    SELECT 'connection',created_at FROM connection_operations
     WHERE state IN ('QUEUED','FAILED_RETRYABLE')
        OR (state='RUNNING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'privacy',created_at FROM privacy_jobs
     WHERE state IN ('QUEUED','FAILED_RETRYABLE')
        OR (state='RUNNING' AND lease_expires_at<now())
    UNION ALL
    SELECT 'provisioning',updated_at FROM provisioning_operations
     WHERE status IN (
       'PENDING','RUNNING','FAILED_RETRYABLE','SUSPEND_PENDING','SUSPENDING',
       'RESUME_PENDING','RESUMING'
     ) AND available_at<=now()
    UNION ALL
    SELECT 'quarantine',created_at FROM quarantine_records
     WHERE state IN ('OPEN','REPROCESS_QUEUED')
  ),
  queue_rollup AS (
    SELECT names.queue,
           count(pending.created_at)::double precision AS depth,
           COALESCE(EXTRACT(epoch FROM now()-min(pending.created_at)),0)::double precision AS age
      FROM queue_names names
      LEFT JOIN pending ON pending.queue=names.queue
     GROUP BY names.queue
  ),
  connection_states(state) AS (
    VALUES
      ('PROVISIONING'::text),('AWAITING_AUTH'::text),('CONNECTING'::text),
      ('WORKING'::text),('DEGRADED'::text),('ACTION_REQUIRED'::text),
      ('FAILED'::text),('PAUSED'::text),('REVOKED'::text)
  ),
  connection_rollup AS (
    SELECT states.state,count(connections.id)::double precision AS count
      FROM connection_states states
      LEFT JOIN connections ON connections.state=states.state
     GROUP BY states.state
  )
  SELECT 'queue_depth',queue,depth FROM queue_rollup
  UNION ALL
  SELECT 'queue_age_seconds',queue,age FROM queue_rollup
  UNION ALL
  SELECT 'connection_state',lower(state),count FROM connection_rollup;
$$;
