BEGIN;

CREATE TABLE zammad_conversation_state_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  zammad_ticket_id text NOT NULL CHECK (zammad_ticket_id ~ '^[1-9][0-9]{0,15}$'),
  conversation_state text NOT NULL CHECK (conversation_state IN (
    'BOT','ACTION_PENDING','HANDOFF_PENDING','HUMAN','RESOLVED'
  )),
  conversation_fencing_token bigint NOT NULL CHECK (conversation_fencing_token>=0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  safe_error text CHECK (safe_error IS NULL OR char_length(safe_error)<=500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,conversation_id),
  FOREIGN KEY (tenant_id,conversation_id)
    REFERENCES bot_conversations(tenant_id,id) ON DELETE CASCADE,
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL))
);

CREATE INDEX zammad_conversation_state_outbox_claim_idx
  ON zammad_conversation_state_outbox (tenant_id,available_at,created_at)
  WHERE completed_at IS NULL;

ALTER TABLE zammad_conversation_state_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE zammad_conversation_state_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_zammad_conversation_state_outbox
  ON zammad_conversation_state_outbox
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.project_zammad_conversation_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF NEW.zammad_ticket_id IS NULL OR NEW.zammad_ticket_id='' THEN
    DELETE FROM zammad_conversation_state_outbox
     WHERE tenant_id=NEW.tenant_id AND conversation_id=NEW.id;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE'
     AND NEW.state=OLD.state
     AND NEW.zammad_ticket_id=OLD.zammad_ticket_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO zammad_conversation_state_outbox (
    tenant_id,conversation_id,zammad_ticket_id,conversation_state,
    conversation_fencing_token
  ) VALUES (
    NEW.tenant_id,NEW.id,NEW.zammad_ticket_id,NEW.state,NEW.fencing_token
  )
  ON CONFLICT (tenant_id,conversation_id) DO UPDATE SET
    zammad_ticket_id=EXCLUDED.zammad_ticket_id,
    conversation_state=EXCLUDED.conversation_state,
    conversation_fencing_token=EXCLUDED.conversation_fencing_token,
    attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
    completed_at=NULL,safe_error=NULL,updated_at=now();
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_conversations_project_zammad_state
AFTER INSERT OR UPDATE OF state,zammad_ticket_id ON bot_conversations
FOR EACH ROW EXECUTE FUNCTION app.project_zammad_conversation_state();

INSERT INTO zammad_conversation_state_outbox (
  tenant_id,conversation_id,zammad_ticket_id,conversation_state,
  conversation_fencing_token
)
SELECT conversation.tenant_id,conversation.id,conversation.zammad_ticket_id,
       conversation.state,conversation.fencing_token
  FROM bot_conversations conversation
 WHERE conversation.zammad_ticket_id ~ '^[1-9][0-9]{0,15}$'
ON CONFLICT (tenant_id,conversation_id) DO UPDATE SET
  zammad_ticket_id=EXCLUDED.zammad_ticket_id,
  conversation_state=EXCLUDED.conversation_state,
  conversation_fencing_token=EXCLUDED.conversation_fencing_token,
  attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
  completed_at=NULL,safe_error=NULL,updated_at=now();

CREATE OR REPLACE FUNCTION app.claim_zammad_conversation_state_jobs(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS SETOF zammad_conversation_state_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE tenant_value uuid:=app.current_tenant_id();
BEGIN
  IF worker_lease IS NULL OR claim_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid Zammad conversation-state claim' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT job.id FROM zammad_conversation_state_outbox job
     WHERE job.tenant_id=tenant_value AND job.completed_at IS NULL
       AND job.available_at<=now()
       AND (job.lease_expires_at IS NULL OR job.lease_expires_at<now())
     ORDER BY job.available_at,job.created_at,job.id
     FOR UPDATE SKIP LOCKED LIMIT claim_limit
  )
  UPDATE zammad_conversation_state_outbox job SET
    lease_id=worker_lease,lease_expires_at=now()+interval '60 seconds',
    attempts=job.attempts+1,safe_error=NULL,updated_at=now()
  FROM candidates
  WHERE job.tenant_id=tenant_value AND job.id=candidates.id
  RETURNING job.*;
END
$$;

REVOKE ALL ON zammad_conversation_state_outbox FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON zammad_conversation_state_outbox TO wasalx_app;
REVOKE ALL ON FUNCTION app.project_zammad_conversation_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_zammad_conversation_state_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_zammad_conversation_state_jobs(uuid,integer) TO wasalx_app;
GRANT SELECT (tenant_id,available_at,lease_expires_at,completed_at)
  ON zammad_conversation_state_outbox TO wasalx_scheduler_reader;

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN (
    'CREATE','CLONE','ACTIVATE','ASSIGN','ASSIGNMENT_STATE','ASSIGNMENT_ATTRIBUTION',
    'CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE',
    'GROUP_WORKSPACE_DEFAULTS','GROUP_WORKSPACE_CAPTURE','GROUP_WORKSPACE_GRANT','GROUP_WORKSPACE_REVOKE',
    'GROUP_BINDING_SAVE','GROUP_BINDING_TOGGLE','DELIVERY_RETRY'
  ));

-- Keep the scheduler's existing work discovery as the single source of truth,
-- adding the new projection beside the existing Zammad status outbox.
CREATE OR REPLACE FUNCTION app.list_due_worker_tenants(scan_limit integer DEFAULT 200)
RETURNS TABLE (tenant_id uuid,work_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF scan_limit<1 OR scan_limit>1000 THEN RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE='22023';END IF;
  RETURN QUERY SELECT candidate.tenant_id,candidate.work_type FROM (
    SELECT inbox.tenant_id,'inbound'::text AS work_type,min(inbox.available_at) AS available_at
      FROM event_inbox inbox JOIN tenants tenant ON tenant.id=inbox.tenant_id
     WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
       ((inbox.status IN ('ACCEPTED','FAILED_RETRYABLE') AND inbox.available_at<=now()) OR (inbox.status='PROCESSING' AND inbox.lease_expires_at<now())) GROUP BY inbox.tenant_id
    UNION ALL
    SELECT pending.tenant_id,'delivery'::text,min(pending.available_at) FROM (
      SELECT delivery.tenant_id,delivery.available_at FROM delivery_outbox delivery JOIN tenants tenant ON tenant.id=delivery.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND
         ((delivery.state='SENDING' AND delivery.lease_expires_at<now()) OR
          (((delivery.state IN ('QUEUED','FAILED_RETRYABLE') AND delivery.available_at<=now()) OR (delivery.state='CLAIMED' AND delivery.lease_expires_at<now()))
           AND EXISTS (SELECT 1 FROM connections connection WHERE connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id AND connection.state='WORKING')
           AND (EXISTS (SELECT 1 FROM group_bindings binding WHERE binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id AND binding.state='ACTIVE')
             OR EXISTS (SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=delivery.tenant_id AND conversation.id=delivery.bot_conversation_id)
             OR EXISTS (SELECT 1 FROM group_workspace_settings workspace WHERE workspace.tenant_id=delivery.tenant_id AND workspace.whatsapp_group_id=delivery.group_workspace_group_id AND workspace.capture_enabled))
           AND EXISTS (SELECT 1 FROM provider_sessions session WHERE session.tenant_id=delivery.tenant_id AND session.connection_id=delivery.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING')
           AND EXISTS (SELECT 1 FROM zammad_instances zammad WHERE zammad.tenant_id=delivery.tenant_id AND zammad.state='WORKING')
           AND EXISTS (SELECT 1 FROM retention_policies policy WHERE policy.tenant_id=delivery.tenant_id)))
      UNION ALL
      SELECT status.tenant_id,status.available_at FROM zammad_status_outbox status JOIN tenants tenant ON tenant.id=status.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND status.completed_at IS NULL AND status.available_at<=now()
         AND (status.lease_expires_at IS NULL OR status.lease_expires_at<now())
      UNION ALL
      SELECT state_job.tenant_id,state_job.available_at FROM zammad_conversation_state_outbox state_job JOIN tenants tenant ON tenant.id=state_job.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND state_job.completed_at IS NULL AND state_job.available_at<=now()
         AND (state_job.lease_expires_at IS NULL OR state_job.lease_expires_at<now())
      UNION ALL
      SELECT action.tenant_id,action.available_at FROM bot_action_jobs action JOIN tenants tenant ON tenant.id=action.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND ((action.state IN ('QUEUED','FAILED_RETRYABLE') AND action.available_at<=now()) OR (action.state='RUNNING' AND action.lease_expires_at<now()))
      UNION ALL
      SELECT handoff.tenant_id,handoff.available_at FROM bot_handoff_jobs handoff JOIN tenants tenant ON tenant.id=handoff.tenant_id
       WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND ((handoff.state IN ('QUEUED','FAILED_RETRYABLE') AND handoff.available_at<=now()) OR (handoff.state='RUNNING' AND handoff.lease_expires_at<now()))
    ) pending GROUP BY pending.tenant_id
    UNION ALL
    SELECT operation.tenant_id,'connection'::text,min(operation.available_at) FROM connection_operations operation JOIN tenants tenant ON tenant.id=operation.tenant_id
     WHERE tenant.state IN ('PROVISIONING','ACTIVE') AND ((operation.state IN ('QUEUED','FAILED_RETRYABLE') AND operation.available_at<=now()) OR (operation.state='RUNNING' AND operation.lease_expires_at<now())) GROUP BY operation.tenant_id
    UNION ALL
    SELECT due.tenant_id,'privacy'::text,min(due.available_at) FROM (
      SELECT policy.tenant_id,policy.next_sweep_at AS available_at FROM retention_policies policy JOIN tenants tenant ON tenant.id=policy.tenant_id
       WHERE tenant.state='ACTIVE' AND policy.next_sweep_at<=now()
      UNION ALL
      SELECT job.tenant_id,job.available_at FROM privacy_jobs job JOIN tenants tenant ON tenant.id=job.tenant_id
       WHERE tenant.state='ACTIVE' AND ((job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now()) OR (job.state='RUNNING' AND job.lease_expires_at<now()))
    ) due GROUP BY due.tenant_id
    UNION ALL
    SELECT routing.tenant_id,'routing'::text,min(routing.available_at) FROM client_routing_sync_jobs routing JOIN tenants tenant ON tenant.id=routing.tenant_id
     WHERE tenant.state='ACTIVE' AND ((routing.state IN ('QUEUED','FAILED_RETRYABLE') AND routing.available_at<=now()) OR (routing.state='RUNNING' AND routing.lease_expires_at<now())) GROUP BY routing.tenant_id
  ) candidate ORDER BY candidate.available_at,candidate.tenant_id,candidate.work_type LIMIT scan_limit;
END
$$;

ALTER FUNCTION app.list_due_worker_tenants(integer) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.list_due_worker_tenants(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_worker_tenants(integer) TO wasalx_app;

COMMIT;
