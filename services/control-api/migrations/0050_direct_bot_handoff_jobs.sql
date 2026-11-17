CREATE TABLE bot_handoff_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  handoff_node_id text NOT NULL CHECK (handoff_node_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  zammad_group_id text NOT NULL CHECK (length(zammad_group_id) BETWEEN 1 AND 80),
  priority text NOT NULL CHECK (priority IN ('1 low','2 normal','3 high')),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','RUNNING','FAILED_RETRYABLE','SUCCEEDED','FAILED_TERMINAL'
  )),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  safe_error text CHECK (safe_error IS NULL OR length(safe_error)<=500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,conversation_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES bot_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE,
  CHECK ((state='RUNNING')=(lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('SUCCEEDED','FAILED_TERMINAL'))=(completed_at IS NOT NULL))
);

CREATE INDEX bot_handoff_jobs_claim_idx ON bot_handoff_jobs (tenant_id,available_at,created_at)
  WHERE state IN ('QUEUED','FAILED_RETRYABLE','RUNNING');

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
  RETURN QUERY
  WITH candidates AS (
    SELECT job.id FROM bot_handoff_jobs job
     WHERE job.tenant_id=tenant_value
       AND job.state IN ('QUEUED','FAILED_RETRYABLE','RUNNING')
       AND job.available_at<=now()
       AND (job.state<>'RUNNING' OR job.lease_expires_at<now())
       AND job.attempts<8
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

ALTER TABLE bot_handoff_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_handoff_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_bot_handoff_jobs ON bot_handoff_jobs
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

REVOKE ALL ON bot_handoff_jobs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON bot_handoff_jobs TO wasalx_app;
REVOKE ALL ON FUNCTION app.claim_bot_handoff_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_bot_handoff_jobs(uuid,integer) TO wasalx_app;

GRANT SELECT (tenant_id,state,available_at,lease_expires_at) ON bot_handoff_jobs TO wasalx_scheduler_reader;

CREATE OR REPLACE FUNCTION app.list_due_worker_tenants(scan_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid,work_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF scan_limit<1 OR scan_limit>1000 THEN
    RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT candidate.tenant_id,candidate.work_type FROM (
    SELECT inbox.tenant_id,'inbound'::text AS work_type,min(inbox.available_at) AS available_at
      FROM event_inbox inbox JOIN tenants tenant ON tenant.id=inbox.tenant_id
     WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
       ((inbox.status IN ('ACCEPTED','FAILED_RETRYABLE') AND inbox.available_at<=now())
        OR (inbox.status='PROCESSING' AND inbox.lease_expires_at<now())) GROUP BY inbox.tenant_id
    UNION ALL
    SELECT pending.tenant_id,'delivery'::text,min(pending.available_at) FROM (
      SELECT delivery.tenant_id,delivery.available_at FROM delivery_outbox delivery JOIN tenants tenant ON tenant.id=delivery.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
         ((delivery.state='SENDING' AND delivery.lease_expires_at<now()) OR
          (((delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at<=now()) OR
             (delivery.state='CLAIMED' AND delivery.lease_expires_at<now()))
           AND EXISTS (SELECT 1 FROM connections connection WHERE connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id AND connection.state='WORKING')
           AND (EXISTS (SELECT 1 FROM group_bindings binding WHERE binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id AND binding.state='ACTIVE')
             OR EXISTS (SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=delivery.tenant_id AND conversation.id=delivery.bot_conversation_id))
           AND EXISTS (SELECT 1 FROM provider_sessions session WHERE session.tenant_id=delivery.tenant_id AND session.connection_id=delivery.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING')
           AND EXISTS (SELECT 1 FROM zammad_instances zammad WHERE zammad.tenant_id=delivery.tenant_id AND zammad.state='WORKING')
           AND EXISTS (SELECT 1 FROM retention_policies policy WHERE policy.tenant_id=delivery.tenant_id)))
      UNION ALL
      SELECT status.tenant_id,status.available_at FROM zammad_status_outbox status JOIN tenants tenant ON tenant.id=status.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND status.completed_at IS NULL AND status.available_at<=now()
         AND (status.lease_expires_at IS NULL OR status.lease_expires_at<now())
      UNION ALL
      SELECT action.tenant_id,action.available_at FROM bot_action_jobs action JOIN tenants tenant ON tenant.id=action.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
         ((action.state IN ('QUEUED','FAILED_RETRYABLE') AND action.available_at<=now()) OR
          (action.state='RUNNING' AND action.lease_expires_at<now()))
      UNION ALL
      SELECT handoff.tenant_id,handoff.available_at FROM bot_handoff_jobs handoff JOIN tenants tenant ON tenant.id=handoff.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
         ((handoff.state IN ('QUEUED','FAILED_RETRYABLE') AND handoff.available_at<=now()) OR
          (handoff.state='RUNNING' AND handoff.lease_expires_at<now()))
    ) pending GROUP BY pending.tenant_id
    UNION ALL
    SELECT operation.tenant_id,'connection'::text,min(operation.available_at) FROM connection_operations operation JOIN tenants tenant ON tenant.id=operation.tenant_id
     WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
       ((operation.state IN ('QUEUED','FAILED_RETRYABLE') AND operation.available_at<=now()) OR
        (operation.state='RUNNING' AND operation.lease_expires_at<now())) GROUP BY operation.tenant_id
    UNION ALL
    SELECT due.tenant_id,'privacy'::text,min(due.available_at) FROM (
      SELECT policy.tenant_id,policy.next_sweep_at AS available_at FROM retention_policies policy JOIN tenants tenant ON tenant.id=policy.tenant_id
       WHERE tenant.state='ACTIVE' AND policy.next_sweep_at<=now()
      UNION ALL
      SELECT job.tenant_id,job.available_at FROM privacy_jobs job JOIN tenants tenant ON tenant.id=job.tenant_id
       WHERE tenant.state='ACTIVE' AND ((job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now()) OR
         (job.state='RUNNING' AND job.lease_expires_at<now()))
    ) due GROUP BY due.tenant_id
  ) candidate ORDER BY candidate.available_at,candidate.tenant_id,candidate.work_type LIMIT scan_limit;
END
$$;

ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;
