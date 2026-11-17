CREATE OR REPLACE FUNCTION app.claim_bot_handoff_jobs(worker_lease uuid,claim_limit integer)
RETURNS SETOF bot_handoff_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE tenant_value uuid:=app.current_tenant_id();
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid bot handoff claim' USING ERRCODE='22023';
  END IF;

  UPDATE bot_handoff_jobs job
     SET available_at=GREATEST(
       job.available_at,
       now()+interval '5 seconds',
       COALESCE((
         SELECT min(delivery.available_at)
           FROM delivery_outbox delivery
          WHERE delivery.tenant_id=job.tenant_id
            AND delivery.bot_conversation_id=job.conversation_id
            AND delivery.state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE')
       ),job.available_at)
     ),updated_at=now()
   WHERE job.tenant_id=tenant_value
     AND job.state IN ('QUEUED','FAILED_RETRYABLE')
     AND job.available_at<=now()
     AND EXISTS (
       SELECT 1 FROM delivery_outbox delivery
        WHERE delivery.tenant_id=job.tenant_id
          AND delivery.bot_conversation_id=job.conversation_id
          AND delivery.state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE')
     );

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id FROM bot_handoff_jobs job
     WHERE job.tenant_id=tenant_value
       AND job.state IN ('QUEUED','FAILED_RETRYABLE','RUNNING')
       AND job.available_at<=now()
       AND (job.state<>'RUNNING' OR job.lease_expires_at<now())
       AND job.attempts<8
       AND NOT EXISTS (
         SELECT 1 FROM delivery_outbox delivery
          WHERE delivery.tenant_id=job.tenant_id
            AND delivery.bot_conversation_id=job.conversation_id
            AND delivery.state IN ('QUEUED','CLAIMED','SENDING','FAILED_RETRYABLE')
       )
     ORDER BY job.available_at,job.created_at,job.id
     FOR UPDATE SKIP LOCKED LIMIT claim_limit
  )
  UPDATE bot_handoff_jobs job SET state='RUNNING',attempts=job.attempts+1,
    fencing_token=job.fencing_token+1,lease_id=worker_lease,lease_expires_at=now()+interval '60 seconds',
    safe_error=NULL,updated_at=now()
  FROM candidates WHERE job.tenant_id=tenant_value AND job.id=candidates.id
  RETURNING job.*;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_bot_handoff_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_bot_handoff_jobs(uuid,integer) TO wasalx_app;
