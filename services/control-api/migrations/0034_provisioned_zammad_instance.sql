-- Bind every durable provisioning operation to one immutable Zammad instance
-- UUID. The UUID is carried through the signed provisioner request, written
-- into the tenant service secret by the workspace provider, and materialized
-- in zammad_instances only after fresh health/isolation evidence succeeds.
ALTER TABLE provisioning_operations
  ADD COLUMN zammad_instance_id uuid NOT NULL DEFAULT gen_random_uuid();

-- Preserve the already-authoritative instance identity during an in-place
-- upgrade. Only not-yet-materialized provisioning operations keep the newly
-- allocated UUID.
UPDATE provisioning_operations AS operation
   SET zammad_instance_id=instance.id
  FROM zammad_instances AS instance
 WHERE instance.tenant_id=operation.tenant_id;

ALTER TABLE provisioning_operations
  ADD CONSTRAINT provisioning_operations_zammad_instance_id_unique
  UNIQUE (zammad_instance_id);

GRANT SELECT, INSERT, UPDATE ON public.zammad_instances
  TO wasalx_provisioning_executor;

-- Tenant insertion fires default-policy triggers introduced after the original
-- provisioning runtime migration. The executor is a NOLOGIN function-owner
-- role, so grant only what those deterministic trigger bodies require.
GRANT SELECT, INSERT ON public.retention_policies, public.tenant_settings
  TO wasalx_provisioning_executor;

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
    'operation_id',p.operation_id,'zammad_instance_id',p.zammad_instance_id,
    'action',p.action,'status',p.status,
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
    'operationId',p.operation_id,'zammadInstanceId',p.zammad_instance_id,
    'tenantId',p.tenant_id,'action',p.action,
    'status',p.status,'completedSteps',p.completed_steps,
    'currentStep',p.current_step,'stepResults',p.step_results,'spec',p.spec,
    'attempts',p.attempts,'maxAttempts',p.max_attempts,'fencingToken',p.fencing_token
  ) FROM claimed p;
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
  instance_affected integer;
  operation_value provisioning_operations%ROWTYPE;
  database_reference_value text;
  search_namespace_value text;
  storage_prefix_value text;
  service_secret_reference_value text;
  privacy_secret_reference_value text;
  base_url_value text;
  health_base_url_value text;
  version_value text;
BEGIN
  IF step_value NOT IN ('identity','database','search','storage','secrets','zammad','package','oidc','defaults','health')
     OR jsonb_typeof(result_value) <> 'object'
     OR octet_length(result_value::text) > 32768 THEN
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
     AND fencing_token=expected_fencing_token AND lease_expires_at>=now()
  RETURNING * INTO operation_value;
  GET DIAGNOSTICS affected=ROW_COUNT;

  IF affected=1 AND step_value='health' THEN
    database_reference_value := operation_value.step_results #>> '{database,database_reference}';
    search_namespace_value := operation_value.step_results #>> '{search,search_namespace}';
    storage_prefix_value := operation_value.step_results #>> '{storage,storage_prefix}';
    service_secret_reference_value := operation_value.step_results #>> '{secrets,service_secret_reference}';
    privacy_secret_reference_value := operation_value.step_results #>> '{secrets,privacy_secret_reference}';
    base_url_value := operation_value.step_results #>> '{zammad,zammad_base_url}';
    health_base_url_value := operation_value.step_results #>> '{health,zammad_base_url}';
    version_value := operation_value.spec #>> '{deployment,zammadVersion}';

    IF operation_value.zammad_instance_id IS NULL
       OR database_reference_value IS NULL
       OR database_reference_value !~ '^postgres(ql)?://'
       OR database_reference_value ~ '://[^/@]+:[^/@]+@'
       OR search_namespace_value <> 'wasalx_' || replace(tenant_value::text,'-','')
       OR storage_prefix_value <> 'tenants/' || tenant_value::text || '/'
       OR service_secret_reference_value <> 'secret://tenants/' || tenant_value::text || '/zammad/service'
       OR privacy_secret_reference_value <> 'secret://tenants/' || tenant_value::text || '/zammad/privacy'
       OR base_url_value IS NULL
       OR base_url_value <> health_base_url_value
       OR base_url_value !~ '^https://[A-Za-z0-9.-]+(?::[0-9]+)?$'
       OR version_value IS NULL
       OR version_value !~ '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$'
       OR operation_value.step_results #>> '{health,healthy}' <> 'true'
       OR operation_value.step_results #>> '{health,isolation_verified}' <> 'true' THEN
      RAISE EXCEPTION 'verified tenant workspace evidence is incomplete or mismatched'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO zammad_instances
      (id,tenant_id,base_url,version,state,database_reference,search_namespace,
       storage_prefix,service_secret_reference,privacy_secret_reference,last_healthy_at)
    VALUES
      (operation_value.zammad_instance_id,tenant_value,base_url_value,version_value,'WORKING',
       database_reference_value,search_namespace_value,storage_prefix_value,
       service_secret_reference_value,privacy_secret_reference_value,now())
    ON CONFLICT (tenant_id) DO UPDATE
      SET base_url=EXCLUDED.base_url,version=EXCLUDED.version,state='WORKING',
          database_reference=EXCLUDED.database_reference,
          search_namespace=EXCLUDED.search_namespace,storage_prefix=EXCLUDED.storage_prefix,
          service_secret_reference=EXCLUDED.service_secret_reference,
          privacy_secret_reference=EXCLUDED.privacy_secret_reference,last_healthy_at=now()
      WHERE zammad_instances.id=EXCLUDED.id;
    GET DIAGNOSTICS instance_affected=ROW_COUNT;
    IF instance_affected <> 1 THEN
      RAISE EXCEPTION 'tenant is already bound to another Zammad instance'
        USING ERRCODE = '55000';
    END IF;

    UPDATE tenants SET state='ACTIVE',updated_at=now()
     WHERE id=tenant_value AND state='PROVISIONING';
    GET DIAGNOSTICS tenant_affected=ROW_COUNT;
    IF tenant_affected <> 1 THEN
      RAISE EXCEPTION 'tenant state changed before provisioning completed'
        USING ERRCODE = '55000';
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
DECLARE affected integer;
DECLARE tenant_affected integer;
DECLARE instance_affected integer;
BEGIN
  IF jsonb_typeof(result_value) <> 'object' OR octet_length(result_value::text) > 32768
     OR result_value->>'suspended' <> 'true'
     OR result_value->>'credentials_disabled' <> 'true'
     OR result_value->>'workloads_scaled_to_zero' <> 'true'
     OR result_value->>'ingress_disabled' <> 'true' THEN
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
    UPDATE zammad_instances SET state='SUSPENDED'
     WHERE tenant_id=tenant_value AND state='WORKING';
    GET DIAGNOSTICS instance_affected=ROW_COUNT;
    IF instance_affected <> 1 THEN
      RAISE EXCEPTION 'tenant Zammad instance was not active during suspension'
        USING ERRCODE = '55000';
    END IF;
    UPDATE tenants SET state='SUSPENDED',updated_at=now()
     WHERE id=tenant_value AND state='ACTIVE';
    GET DIAGNOSTICS tenant_affected=ROW_COUNT;
    IF tenant_affected <> 1 THEN
      RAISE EXCEPTION 'tenant state changed before suspension completed'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN affected=1;
END;
$$;

ALTER FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.operator_tenant_provisioning_status(uuid,text,text)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.complete_tenant_provisioning_step(uuid,uuid,bigint,text,jsonb)
  OWNER TO wasalx_provisioning_executor;
ALTER FUNCTION app.complete_tenant_suspension(uuid,uuid,bigint,jsonb)
  OWNER TO wasalx_provisioning_executor;

REVOKE ALL ON FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.operator_tenant_provisioning_status(uuid,text,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.complete_tenant_provisioning_step(uuid,uuid,bigint,text,jsonb)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;
REVOKE ALL ON FUNCTION app.complete_tenant_suspension(uuid,uuid,bigint,jsonb)
  FROM PUBLIC,wasalx_app,wasalx_provisioner;

GRANT EXECUTE ON FUNCTION app.claim_tenant_provisioning_tasks(uuid,integer)
  TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.operator_tenant_provisioning_status(uuid,text,text)
  TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.complete_tenant_provisioning_step(uuid,uuid,bigint,text,jsonb)
  TO wasalx_provisioning_client;
GRANT EXECUTE ON FUNCTION app.complete_tenant_suspension(uuid,uuid,bigint,jsonb)
  TO wasalx_provisioning_client;
