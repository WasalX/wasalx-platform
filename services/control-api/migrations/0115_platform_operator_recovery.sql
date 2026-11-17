-- Keep lifecycle action eligibility in the same execution-only database
-- boundary that authorizes the mutations. The browser must not reconstruct
-- this state machine from independently changing tenant, Zammad, and
-- provisioning fields.
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
           CASE
             WHEN p.status IN ('FAILED','FAILED_RETRYABLE')
               THEN jsonb_build_array('RETRY')
             WHEN t.state='ACTIVE' AND p.status='COMPLETE' AND z.state='WORKING'
               THEN jsonb_build_array('SUSPEND')
             WHEN t.state='SUSPENDED' AND p.status='SUSPENDED' AND z.state='SUSPENDED'
               THEN jsonb_build_array('RESUME')
             ELSE '[]'::jsonb
           END AS allowed_actions
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
      'allowed_actions',allowed_actions,
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
