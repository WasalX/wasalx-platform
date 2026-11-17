ALTER TABLE secret_cleanup_outbox
  DROP CONSTRAINT secret_cleanup_outbox_cleanup_kind_check,
  ALTER COLUMN connection_id DROP NOT NULL,
  ALTER COLUMN connection_operation_id DROP NOT NULL,
  ADD COLUMN routing_integration_id uuid,
  ADD CONSTRAINT secret_cleanup_outbox_cleanup_kind_check
    CHECK (cleanup_kind IN ('WEBHOOK_SECRET','ROUTING_INTEGRATION_SECRET')),
  ADD CONSTRAINT secret_cleanup_outbox_owner_check CHECK (
    (cleanup_kind='WEBHOOK_SECRET' AND connection_id IS NOT NULL
      AND connection_operation_id IS NOT NULL AND routing_integration_id IS NULL)
    OR
    (cleanup_kind='ROUTING_INTEGRATION_SECRET' AND connection_id IS NULL
      AND connection_operation_id IS NULL AND routing_integration_id IS NOT NULL)
  ),
  ADD CONSTRAINT secret_cleanup_outbox_routing_integration_fk
    FOREIGN KEY (tenant_id,routing_integration_id)
    REFERENCES client_routing_integrations(tenant_id,id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX secret_cleanup_outbox_routing_integration
  ON secret_cleanup_outbox(tenant_id,routing_integration_id,cleanup_kind)
  WHERE routing_integration_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enqueue_routing_integration_secret_cleanup()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF NEW.state='REVOKED' AND OLD.state IS DISTINCT FROM NEW.state THEN
    INSERT INTO secret_cleanup_outbox(
      tenant_id,routing_integration_id,cleanup_kind,secret_reference
    ) VALUES (
      NEW.tenant_id,NEW.id,'ROUTING_INTEGRATION_SECRET',NEW.secret_reference
    ) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS client_routing_integration_secret_cleanup
  ON client_routing_integrations;
CREATE TRIGGER client_routing_integration_secret_cleanup
AFTER UPDATE OF state ON client_routing_integrations
FOR EACH ROW EXECUTE FUNCTION app.enqueue_routing_integration_secret_cleanup();

INSERT INTO secret_cleanup_outbox(
  tenant_id,routing_integration_id,cleanup_kind,secret_reference
)
SELECT tenant_id,id,'ROUTING_INTEGRATION_SECRET',secret_reference
FROM client_routing_integrations
WHERE state='REVOKED'
ON CONFLICT DO NOTHING;

GRANT SELECT (tenant_id,id,secret_reference,state)
  ON client_routing_source_state TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,secret_reference,state)
  ON bot_action_definitions TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,action_definition_id,state,lease_expires_at)
  ON bot_action_jobs TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,action_snapshot,state)
  ON group_action_executions TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,source_state_id,state,lease_expires_at)
  ON client_routing_sync_jobs TO wasalx_secret_cleanup_executor;

CREATE OR REPLACE FUNCTION app.claim_secret_cleanup_tasks(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS TABLE (
  task_id uuid,
  tenant_id uuid,
  secret_reference text,
  attempts integer,
  max_attempts integer,
  fencing_token bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE='22023';
  END IF;
  IF claim_limit<1 OR claim_limit>100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;

  UPDATE public.secret_cleanup_outbox AS exhausted
     SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
         error_code=COALESCE(exhausted.error_code,'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error=COALESCE(exhausted.safe_error,'Secret cleanup exhausted its retry limit.'),
         completed_at=now(),updated_at=now()
   WHERE exhausted.attempts>=exhausted.max_attempts
     AND (exhausted.state IN ('QUEUED','FAILED_RETRYABLE')
       OR (exhausted.state='RUNNING' AND exhausted.lease_expires_at<now()));

  RETURN QUERY
  UPDATE public.secret_cleanup_outbox AS cleanup
     SET lease_id=worker_lease,lease_expires_at=now()+interval '60 seconds',
         fencing_token=cleanup.fencing_token+1,state='RUNNING',
         attempts=cleanup.attempts+1,error_code=NULL,safe_error=NULL,updated_at=now()
   WHERE cleanup.id IN (
     SELECT candidate.id
       FROM public.secret_cleanup_outbox AS candidate
      WHERE candidate.attempts<candidate.max_attempts
        AND ((candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at<=now())
          OR (candidate.state='RUNNING' AND candidate.lease_expires_at<now()))
        AND (candidate.cleanup_kind<>'ROUTING_INTEGRATION_SECRET' OR (
          NOT EXISTS (
            SELECT 1 FROM client_routing_source_state source
             WHERE source.tenant_id=candidate.tenant_id
               AND source.secret_reference=candidate.secret_reference
               AND source.state<>'RETIRED'
          )
          AND NOT EXISTS (
            SELECT 1 FROM bot_action_definitions action
             WHERE action.tenant_id=candidate.tenant_id
               AND action.secret_reference=candidate.secret_reference
               AND action.state='ACTIVE'
          )
          AND NOT EXISTS (
            SELECT 1 FROM bot_action_jobs job
            JOIN bot_action_definitions action
              ON action.tenant_id=job.tenant_id AND action.id=job.action_definition_id
             WHERE job.tenant_id=candidate.tenant_id
               AND action.secret_reference=candidate.secret_reference
               AND job.state='RUNNING' AND job.lease_expires_at>=now()
          )
          AND NOT EXISTS (
            SELECT 1 FROM group_action_executions execution
             WHERE execution.tenant_id=candidate.tenant_id
               AND execution.action_snapshot->>'secretReference'=candidate.secret_reference
               AND execution.state='RUNNING'
          )
          AND NOT EXISTS (
            SELECT 1 FROM client_routing_sync_jobs job
            JOIN client_routing_source_state source
              ON source.tenant_id=job.tenant_id AND source.id=job.source_state_id
             WHERE job.tenant_id=candidate.tenant_id
               AND source.secret_reference=candidate.secret_reference
               AND job.state='RUNNING' AND job.lease_expires_at>=now()
          )
        ))
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING cleanup.id,cleanup.tenant_id,cleanup.secret_reference,
            cleanup.attempts,cleanup.max_attempts,cleanup.fencing_token;
END
$$;

REVOKE ALL ON FUNCTION app.enqueue_routing_integration_secret_cleanup() FROM PUBLIC;
