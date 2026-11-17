GRANT SELECT (provider) ON public.connections TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.queue_due_group_syncs(scan_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE inserted_count integer;
BEGIN
  IF scan_limit<1 OR scan_limit>1000 THEN
    RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;

  WITH candidates AS (
    SELECT connection.tenant_id,connection.id
      FROM public.connections connection
      JOIN public.tenants tenant ON tenant.id=connection.tenant_id
     WHERE tenant.state='ACTIVE'
       AND connection.provider='WAHA'
       AND connection.state IN ('WORKING','DEGRADED')
       AND EXISTS (
         SELECT 1 FROM public.provider_sessions session
          WHERE session.tenant_id=connection.tenant_id
            AND session.connection_id=connection.id
            AND session.ownership_state='ACTIVE'
            AND session.state='WORKING'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.connection_operations pending
          WHERE pending.tenant_id=connection.tenant_id
            AND pending.connection_id=connection.id
            AND pending.operation_type='SYNC_GROUPS'
            AND pending.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.connection_operations recent
          WHERE recent.tenant_id=connection.tenant_id
            AND recent.connection_id=connection.id
            AND recent.operation_type='SYNC_GROUPS'
            AND recent.state='SUCCEEDED'
            AND recent.completed_at>=now()-interval '15 minutes'
       )
     ORDER BY (
       SELECT max(completed_at) FROM public.connection_operations previous
        WHERE previous.tenant_id=connection.tenant_id
          AND previous.connection_id=connection.id
          AND previous.operation_type='SYNC_GROUPS'
          AND previous.state='SUCCEEDED'
     ) NULLS FIRST,connection.id
     LIMIT scan_limit
  )
  INSERT INTO public.connection_operations (
    tenant_id,connection_id,operation_type,idempotency_key,payload,
    requested_by_type,requested_by_id,request_id
  )
  SELECT candidate.tenant_id,candidate.id,'SYNC_GROUPS',
         'automatic-group-sync:'||candidate.id||':'||
           floor(extract(epoch FROM statement_timestamp())/900)::bigint,
         jsonb_build_object('automatic',true,'reason','PERIODIC_RECONCILIATION'),
         'SYSTEM','connector-scheduler',
         'automatic-group-sync:'||candidate.id||':'||
           floor(extract(epoch FROM statement_timestamp())/900)::bigint
    FROM candidates candidate
  ON CONFLICT (tenant_id,idempotency_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION app.queue_due_group_syncs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_due_group_syncs(integer) TO wasalx_app;

WITH affected AS (
  SELECT connection.tenant_id,connection.id
    FROM public.connections connection
    JOIN public.provider_sessions session
      ON session.tenant_id=connection.tenant_id
     AND session.connection_id=connection.id
     AND session.ownership_state='ACTIVE'
   WHERE connection.provider='META'
     AND connection.state='ACTION_REQUIRED'
     AND session.state='WORKING'
     AND session.provider_state='AVAILABLE'
     AND NOT EXISTS (
       SELECT 1 FROM public.connection_operations pending
        WHERE pending.tenant_id=connection.tenant_id
          AND pending.connection_id=connection.id
          AND pending.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
     )
     AND EXISTS (
       SELECT 1 FROM public.connection_operations failed
       WHERE failed.tenant_id=connection.tenant_id
         AND failed.connection_id=connection.id
         AND failed.operation_type='SYNC_GROUPS'
         AND failed.state='FAILED_TERMINAL'
         AND failed.requested_by_type='SYSTEM'
         AND failed.requested_by_id='connector-scheduler'
         AND failed.payload->>'automatic'='true'
         AND failed.error_code LIKE 'META_AUTHENTICATION_FAILED%'
     )
)
UPDATE public.connections connection
   SET state='WORKING',action_reason=NULL,updated_at=now()
  FROM affected
 WHERE connection.tenant_id=affected.tenant_id
   AND connection.id=affected.id;
