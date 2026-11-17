ALTER TABLE bot_conversations DROP CONSTRAINT bot_conversations_state_check;
ALTER TABLE bot_conversations ADD CONSTRAINT bot_conversations_state_check
  CHECK (state IN ('BOT','ACTION_PENDING','HANDOFF_PENDING','HUMAN','RESOLVED'));

CREATE TABLE bot_action_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_key text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 1 AND 160 AND name !~ '[[:cntrl:]]'),
  kind text NOT NULL CHECK (kind IN ('HTTP_JSON','NOTION_CREATE_PAGE')),
  endpoint_url text NOT NULL CHECK (endpoint_url ~ '^https://[^[:space:]]{1,2000}$'),
  http_method text NOT NULL CHECK (http_method IN ('GET','POST')),
  auth_scheme text NOT NULL CHECK (auth_scheme IN ('NONE','BEARER')),
  secret_reference text CHECK (secret_reference IS NULL OR secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]{0,500}$'),
  headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(headers)='object' AND octet_length(headers::text)<=8192),
  response_mapping jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_mapping)='object' AND octet_length(response_mapping::text)<=8192),
  timeout_ms integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 1000 AND 10000),
  max_response_bytes integer NOT NULL DEFAULT 262144 CHECK (max_response_bytes BETWEEN 1024 AND 1048576),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,action_key),
  CHECK ((auth_scheme='NONE' AND secret_reference IS NULL) OR (auth_scheme='BEARER' AND secret_reference IS NOT NULL))
);

CREATE TABLE bot_action_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  action_definition_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  action_node_id text NOT NULL CHECK (action_node_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  request_input jsonb NOT NULL CHECK (jsonb_typeof(request_input)='object' AND octet_length(request_input::text)<=65536),
  on_success_node_id text NOT NULL CHECK (on_success_node_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  on_failure_node_id text NOT NULL CHECK (on_failure_node_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','SUCCEEDED','FAILED_TERMINAL','OUTCOME_UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 25),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  response_variables jsonb CHECK (response_variables IS NULL OR (jsonb_typeof(response_variables)='object' AND octet_length(response_variables::text)<=65536)),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error)<=500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,conversation_id,source_event_id,action_node_id),
  FOREIGN KEY (tenant_id,conversation_id) REFERENCES bot_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,action_definition_id) REFERENCES bot_action_definitions(tenant_id,id),
  FOREIGN KEY (tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE,
  CHECK (
    (state IN ('QUEUED','FAILED_RETRYABLE') AND lease_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
    OR (state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
    OR (state IN ('SUCCEEDED','FAILED_TERMINAL','OUTCOME_UNKNOWN') AND lease_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX bot_action_jobs_due_idx ON bot_action_jobs (available_at,tenant_id)
  WHERE state IN ('QUEUED','FAILED_RETRYABLE','RUNNING');

CREATE OR REPLACE FUNCTION app.claim_bot_action_jobs(worker_lease uuid,claim_limit integer DEFAULT 25)
RETURNS SETOF bot_action_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF claim_limit<1 OR claim_limit>100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT job.id FROM bot_action_jobs job
     JOIN bot_conversations conversation ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
     WHERE job.tenant_id=app.current_tenant_id() AND conversation.state='ACTION_PENDING'
       AND ((job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now())
         OR (job.state='RUNNING' AND job.lease_expires_at<now()))
     ORDER BY job.available_at,job.created_at,job.id FOR UPDATE OF job SKIP LOCKED LIMIT claim_limit
  )
  UPDATE bot_action_jobs job SET state='RUNNING',attempts=job.attempts+1,
         fencing_token=job.fencing_token+1,lease_id=worker_lease,
         lease_expires_at=now()+interval '90 seconds',safe_error=NULL,updated_at=now()
    FROM candidates WHERE job.id=candidates.id RETURNING job.*;
END
$$;

ALTER TABLE bot_action_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_action_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE bot_action_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_action_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bot_action_definitions
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
CREATE POLICY tenant_isolation ON bot_action_jobs
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

GRANT SELECT,INSERT,UPDATE ON bot_action_definitions,bot_action_jobs TO wasalx_app;
REVOKE ALL ON FUNCTION app.claim_bot_action_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_bot_action_jobs(uuid,integer) TO wasalx_app;

GRANT SELECT (tenant_id,state,available_at,lease_expires_at) ON bot_action_jobs TO wasalx_scheduler_reader;

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
