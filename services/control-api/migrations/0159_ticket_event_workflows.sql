-- Event graphs share the immutable bot-flow store. Only their scope and
-- execution receipts differ from a stateful direct conversation.
CREATE TABLE ticket_event_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_group_id uuid,
  event text NOT NULL CHECK (event IN ('reference_received','before_agent_reply','ticket_closed','quoted_command')),
  mode text NOT NULL CHECK (mode IN ('INHERIT','CUSTOM','OFF')),
  flow_version_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id,whatsapp_group_id,event),
  FOREIGN KEY (tenant_id,whatsapp_group_id) REFERENCES whatsapp_groups(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,flow_version_id) REFERENCES bot_flow_versions(tenant_id,id),
  CHECK ((mode='CUSTOM')=(flow_version_id IS NOT NULL)),
  CHECK (mode<>'INHERIT' OR whatsapp_group_id IS NOT NULL)
);

CREATE TABLE ticket_event_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  correlation_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('reference_received','before_agent_reply','ticket_closed','quoted_command')),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  flow_version_id uuid,
  mode text NOT NULL CHECK (mode IN ('CUSTOM','OFF','LEGACY')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPLIED','SKIPPED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id,correlation_id,event,source_sha256),
  FOREIGN KEY (tenant_id,correlation_id) REFERENCES case_correlations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,flow_version_id) REFERENCES bot_flow_versions(tenant_id,id),
  CHECK ((mode='CUSTOM')=(flow_version_id IS NOT NULL)),
  CHECK ((state='PENDING')=(completed_at IS NULL))
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['ticket_event_bindings','ticket_event_executions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id())',table_name);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON ticket_event_bindings,ticket_event_executions TO wasalx_app;
GRANT SELECT ON ticket_event_bindings TO wasalx_connector_worker;
GRANT SELECT,INSERT,UPDATE ON ticket_event_executions TO wasalx_connector_worker;

CREATE TRIGGER tenant_actor_membership_guard
  BEFORE INSERT OR UPDATE OF tenant_id,updated_by ON ticket_event_bindings
  FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership('updated_by');

CREATE FUNCTION app.enforce_ticket_event_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.correlation_id,NEW.event,NEW.source_sha256,NEW.flow_version_id,NEW.mode,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.correlation_id,OLD.event,OLD.source_sha256,OLD.flow_version_id,OLD.mode,OLD.created_at)
    OR OLD.state<>'PENDING' OR NEW.state NOT IN ('APPLIED','SKIPPED') THEN
    RAISE EXCEPTION 'Ticket event decisions are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_event_executions_immutable BEFORE UPDATE ON ticket_event_executions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_ticket_event_execution();

CREATE FUNCTION app.enforce_ticket_event_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.mode='CUSTOM' AND NOT EXISTS (
    SELECT 1 FROM bot_flow_versions version WHERE version.tenant_id=NEW.tenant_id AND version.id=NEW.flow_version_id
      AND version.state IN ('ACTIVE','RETIRED') AND version.definition->>'kind'='TICKET_EVENT'
      AND version.definition->>'event'=NEW.event
  ) THEN RAISE EXCEPTION 'A published ticket event version is required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ticket_event_bindings_version_guard BEFORE INSERT OR UPDATE ON ticket_event_bindings
  FOR EACH ROW EXECUTE FUNCTION app.enforce_ticket_event_binding();

CREATE FUNCTION app.enforce_bot_assignment_kind() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bot_flow_versions version WHERE version.tenant_id=NEW.tenant_id
    AND version.id=NEW.flow_version_id AND version.definition->>'kind'='TICKET_EVENT') THEN
    RAISE EXCEPTION 'Ticket event workflows cannot own direct conversations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bot_assignments_kind_guard BEFORE INSERT OR UPDATE OF flow_version_id ON bot_assignments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_assignment_kind();

CREATE FUNCTION app.enforce_workflow_family_kind() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bot_flow_versions previous WHERE previous.tenant_id=NEW.tenant_id
    AND previous.family_id=NEW.family_id AND (
      COALESCE(previous.definition->>'kind','DIRECT')<>COALESCE(NEW.definition->>'kind','DIRECT')
      OR previous.definition->>'event' IS DISTINCT FROM NEW.definition->>'event')) THEN
    RAISE EXCEPTION 'Workflow families must retain their event type' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bot_flow_versions_kind_guard BEFORE INSERT ON bot_flow_versions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_workflow_family_kind();

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check CHECK (action IN (
  'CREATE','CLONE','ACTIVATE','ASSIGN','ASSIGNMENT_STATE','ASSIGNMENT_ATTRIBUTION',
  'CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE',
  'GROUP_WORKSPACE_DEFAULTS','GROUP_WORKSPACE_CAPTURE','GROUP_WORKSPACE_GRANT','GROUP_WORKSPACE_REVOKE',
  'GROUP_BINDING_SAVE','GROUP_BINDING_TOGGLE','DELIVERY_RETRY','DELIVERY_STOP_RETRY',
  'WAHA_OUTBOUND_TENANT_CONTROL','WAHA_OUTBOUND_CONNECTION_POLICY','PRIVACY_REQUEST_RETRY','TICKET_EVENT_BIND'
));

-- Append to the still-unreleased 0159 migration after the existing tables.
-- Original means the immutable case trigger, not the oldest remaining message.
ALTER TABLE case_correlations ADD COLUMN original_external_message_id text
  CHECK (original_external_message_id IS NULL OR
    (length(original_external_message_id) BETWEEN 1 AND 512 AND original_external_message_id !~ '[[:cntrl:]]'));
UPDATE case_correlations correlation
   SET original_external_message_id=(
     SELECT link.external_message_id
       FROM message_links link
       JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
       JOIN whatsapp_groups group_record ON group_record.tenant_id=binding.tenant_id AND group_record.id=binding.whatsapp_group_id
      WHERE link.tenant_id=correlation.tenant_id AND link.connection_id=group_record.connection_id
        AND link.zammad_ticket_id=correlation.zammad_ticket_id AND link.direction='INBOUND'
      ORDER BY link.created_at,link.id LIMIT 1
   )
 WHERE original_external_message_id IS NULL;
-- Keep this ID even after provider deletion/privacy removal: quote eligibility
-- is checked separately, and an unavailable original must not shift targets.

ALTER TABLE ticket_event_executions ADD CONSTRAINT ticket_event_executions_tenant_id_key UNIQUE (tenant_id,id);
ALTER TABLE delivery_outbox ADD COLUMN ticket_event_execution_id uuid;
ALTER TABLE delivery_outbox ADD CONSTRAINT delivery_outbox_ticket_event_fk
  FOREIGN KEY (tenant_id,ticket_event_execution_id) REFERENCES ticket_event_executions(tenant_id,id);
CREATE INDEX delivery_outbox_ticket_event_lookup ON delivery_outbox (tenant_id,ticket_event_execution_id)
  WHERE ticket_event_execution_id IS NOT NULL;

ALTER TABLE delivery_outbox DROP CONSTRAINT delivery_outbox_origin_shape;
ALTER TABLE delivery_outbox ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
  (content_redacted_at IS NOT NULL
    AND group_binding_id IS NULL AND group_workspace_group_id IS NULL
    AND bot_conversation_id IS NULL AND external_chat_id IS NULL
    AND bot_content IS NULL AND direct_origin IS NULL
    AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL
    AND ticket_event_execution_id IS NULL)
  OR
  (content_redacted_at IS NULL AND delivery_origin='TICKET'
    AND (
      (zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
      OR (bot_conversation_id IS NOT NULL AND direct_origin='BOT'
        AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL)
      OR (group_binding_id IS NOT NULL AND bot_conversation_id IS NULL
        AND group_workspace_group_id IS NULL AND direct_origin IS NULL
        AND external_chat_id IS NULL AND bot_content IS NULL
        AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
        AND reply_to_message_id IS NOT NULL AND idempotency_key LIKE 'ack:%'
        AND ticket_event_execution_id IS NULL)
      OR (ticket_event_execution_id IS NOT NULL
        AND group_binding_id IS NOT NULL AND group_workspace_group_id IS NULL
        AND bot_conversation_id IS NULL AND direct_origin IS NULL
        AND external_chat_id IS NULL AND bot_content IS NULL
        AND zammad_ticket_id IS NOT NULL
        AND content_type IN ('text/plain','application/vnd.wasalx.whatsapp-reaction')
        AND (content_type='text/plain' OR reply_to_message_id IS NOT NULL))
    ))
  OR
  (content_redacted_at IS NULL AND delivery_origin='GROUP_WORKSPACE'
    AND group_workspace_group_id IS NOT NULL AND group_binding_id IS NULL
    AND bot_conversation_id IS NULL AND external_chat_id IS NULL
    AND bot_content IS NULL AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL
    AND ticket_event_execution_id IS NULL)
);

CREATE FUNCTION app.enforce_ticket_event_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.ticket_event_execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ticket_event_executions execution
    JOIN case_correlations correlation ON correlation.tenant_id=execution.tenant_id AND correlation.id=execution.correlation_id
    JOIN group_bindings binding ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
    JOIN whatsapp_groups group_record ON group_record.tenant_id=binding.tenant_id AND group_record.id=binding.whatsapp_group_id
    WHERE execution.tenant_id=NEW.tenant_id AND execution.id=NEW.ticket_event_execution_id
      AND execution.mode='CUSTOM' AND execution.event IN ('reference_received','ticket_closed','quoted_command')
      AND correlation.zammad_ticket_id=NEW.zammad_ticket_id AND correlation.group_binding_id=NEW.group_binding_id
      AND group_record.connection_id=NEW.connection_id
  ) THEN RAISE EXCEPTION 'Ticket event delivery provenance is invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_outbox_ticket_event_guard
  BEFORE INSERT OR UPDATE OF ticket_event_execution_id,tenant_id,connection_id,group_binding_id,zammad_ticket_id
  ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION app.enforce_ticket_event_delivery();


-- Worker cannot inspect arbitrary users/memberships. Return only a resolved sender.
CREATE FUNCTION app.ticket_command_actor(p_tenant uuid,p_connection uuid,p_group text,p_participant text)
RETURNS TABLE(source_authorized boolean,member_id uuid,member_role text,member_email text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM app.current_tenant_id() THEN
    RAISE EXCEPTION 'Tenant mismatch' USING ERRCODE='42501';
  END IF;
  RETURN QUERY WITH source AS (
    SELECT roster.normalized_phone AS roster_phone,
      CASE WHEN p_participant ~ '^[1-9][0-9]{5,14}@(c\.us|s\.whatsapp\.net)$'
        THEN '+'||split_part(p_participant,'@',1) END AS canonical_phone
    FROM public.whatsapp_groups g JOIN public.group_workspace_participants roster
      ON roster.tenant_id=g.tenant_id AND roster.whatsapp_group_id=g.id
      AND roster.external_participant_id=p_participant
    JOIN public.connections c ON c.tenant_id=g.tenant_id AND c.id=g.connection_id AND c.state='WORKING'
    WHERE g.tenant_id=p_tenant AND g.connection_id=p_connection AND g.external_group_id=p_group
  ), resolved AS (
    SELECT CASE WHEN canonical_phone IS NOT NULL AND roster_phone IS NOT NULL
          AND canonical_phone<>roster_phone THEN NULL ELSE COALESCE(canonical_phone,roster_phone) END AS phone
      FROM source
  ), matched AS (
    SELECT m.id,m.role,u.email FROM resolved r JOIN public.tenant_memberships m
      ON m.tenant_id=p_tenant AND m.state='ACTIVE' AND r.phone=ANY(m.whatsapp_numbers)
      JOIN public.users u ON u.id=m.user_id WHERE r.phone ~ '^\+[1-9][0-9]{5,14}$'
  ) SELECT EXISTS(SELECT 1 FROM resolved WHERE phone ~ '^\+[1-9][0-9]{5,14}$'),
    CASE WHEN (SELECT count(*) FROM matched)=1 THEN (SELECT id FROM matched LIMIT 1) END,
    CASE WHEN (SELECT count(*) FROM matched)=1 THEN (SELECT role FROM matched LIMIT 1) END,
    CASE WHEN (SELECT count(*) FROM matched)=1 THEN (SELECT email FROM matched LIMIT 1) END;
END $$;
REVOKE ALL ON FUNCTION app.ticket_command_actor(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ticket_command_actor(uuid,uuid,text,text) TO wasalx_connector_worker,wasalx_app;

ALTER TABLE ticket_event_executions
 ADD COLUMN native_action_state text CHECK(native_action_state IN ('PREPARED','ATTEMPTED','SUCCEEDED','OUTCOME_UNKNOWN','FAILED_TERMINAL')),
 ADD COLUMN native_action_snapshot jsonb,
 ADD COLUMN native_attempted_at timestamptz,
 ADD COLUMN native_result jsonb,
 ADD CONSTRAINT ticket_event_native_action_shape CHECK(
   (native_action_state IS NULL AND native_action_snapshot IS NULL AND native_attempted_at IS NULL AND native_result IS NULL)
   OR (event='quoted_command' AND mode='CUSTOM' AND native_action_state IS NOT NULL AND native_action_snapshot IS NOT NULL
       AND jsonb_typeof(native_action_snapshot)='object'
       AND (native_action_state='PREPARED')=(native_attempted_at IS NULL)
       AND (native_action_state IN ('SUCCEEDED','FAILED_TERMINAL'))=(native_result IS NOT NULL)));
-- Native snapshots and outcomes are runtime-validated; this trigger enforces immutable identity and one-way state transitions.
CREATE OR REPLACE FUNCTION app.enforce_ticket_event_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE identity_unchanged boolean; native_unchanged boolean;
BEGIN
 identity_unchanged := ROW(NEW.tenant_id,NEW.correlation_id,NEW.event,NEW.source_sha256,NEW.flow_version_id,NEW.mode,NEW.created_at)
   IS NOT DISTINCT FROM ROW(OLD.tenant_id,OLD.correlation_id,OLD.event,OLD.source_sha256,OLD.flow_version_id,OLD.mode,OLD.created_at);
 native_unchanged := ROW(NEW.native_action_state,NEW.native_action_snapshot,NEW.native_attempted_at,NEW.native_result)
   IS NOT DISTINCT FROM ROW(OLD.native_action_state,OLD.native_action_snapshot,OLD.native_attempted_at,OLD.native_result);
 IF NOT identity_unchanged OR OLD.state<>'PENDING' THEN
   RAISE EXCEPTION 'Ticket event decisions are immutable' USING ERRCODE='55000';
 END IF;
 IF native_unchanged AND NEW.state IN ('APPLIED','SKIPPED') AND
   (NEW.native_action_state IS NULL OR
    (NEW.state='APPLIED' AND NEW.native_action_state='SUCCEEDED') OR
    (NEW.state='SKIPPED' AND NEW.native_action_state='FAILED_TERMINAL')) THEN RETURN NEW; END IF;
 IF OLD.event='quoted_command' AND OLD.mode='CUSTOM' AND NEW.state='PENDING'
   AND NEW.completed_at IS NULL THEN
   IF OLD.native_action_state IS NULL AND NEW.native_action_state='PREPARED'
      AND NEW.native_attempted_at IS NULL AND NEW.native_result IS NULL THEN RETURN NEW; END IF;
   IF NEW.native_action_snapshot IS NOT DISTINCT FROM OLD.native_action_snapshot THEN
     IF OLD.native_action_state='PREPARED' AND NEW.native_action_state='ATTEMPTED'
       AND NEW.native_attempted_at IS NOT NULL AND NEW.native_attempted_at>=NEW.created_at
       AND NEW.native_result IS NULL THEN RETURN NEW; END IF;
     IF NEW.native_attempted_at IS NOT DISTINCT FROM OLD.native_attempted_at AND
       ((OLD.native_action_state='ATTEMPTED' AND NEW.native_action_state IN ('SUCCEEDED','OUTCOME_UNKNOWN','FAILED_TERMINAL'))
        OR (OLD.native_action_state='OUTCOME_UNKNOWN' AND NEW.native_action_state IN ('SUCCEEDED','FAILED_TERMINAL')))
       THEN RETURN NEW; END IF;
   END IF;
 END IF;
 RAISE EXCEPTION 'Ticket event action transition is invalid' USING ERRCODE='55000';
END $$;

-- Trigger helpers are callable only through their installed triggers.
REVOKE ALL ON FUNCTION app.enforce_ticket_event_execution() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_ticket_event_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_bot_assignment_kind() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_workflow_family_kind() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_ticket_event_delivery() FROM PUBLIC;
