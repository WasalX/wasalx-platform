CREATE TABLE bot_action_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_definition_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  name text NOT NULL CHECK (name=btrim(name) AND length(name) BETWEEN 1 AND 160 AND name !~ '[[:cntrl:]]'),
  kind text NOT NULL CHECK (kind IN ('HTTP_JSON','NOTION_CREATE_PAGE')),
  endpoint_url text NOT NULL CHECK (
    length(endpoint_url) BETWEEN 10 AND 2048
    AND endpoint_url ~ '^https://[^[:space:]]+$'
  ),
  http_method text NOT NULL CHECK (http_method IN ('GET','POST')),
  auth_scheme text NOT NULL CHECK (auth_scheme IN ('NONE','BEARER')),
  secret_reference text CHECK (
    secret_reference IS NULL
    OR (
      length(secret_reference) BETWEEN 10 AND 509
      AND secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
    )
  ),
  headers jsonb NOT NULL CHECK (jsonb_typeof(headers)='object' AND octet_length(headers::text)<=8192),
  response_mapping jsonb NOT NULL CHECK (jsonb_typeof(response_mapping)='object' AND octet_length(response_mapping::text)<=8192),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 10000),
  max_response_bytes integer NOT NULL CHECK (max_response_bytes BETWEEN 1024 AND 1048576),
  state text NOT NULL CHECK (state IN ('ACTIVE','PAUSED')),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,action_definition_id,revision),
  UNIQUE (tenant_id,action_definition_id,id),
  FOREIGN KEY (tenant_id,action_definition_id)
    REFERENCES bot_action_definitions(tenant_id,id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((auth_scheme='NONE' AND secret_reference IS NULL) OR (auth_scheme='BEARER' AND secret_reference IS NOT NULL))
);

CREATE OR REPLACE FUNCTION app.enforce_bot_action_revision_secret()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app AS $$
DECLARE
  parent_action_key text;
  action_prefix text;
  integration_prefix text;
BEGIN
  SELECT action.action_key INTO parent_action_key
  FROM bot_action_definitions action
  WHERE action.tenant_id=NEW.tenant_id AND action.id=NEW.action_definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bot action revision requires its tenant action definition'
      USING ERRCODE='23503';
  END IF;
  IF NEW.secret_reference IS NULL THEN RETURN NEW; END IF;
  action_prefix:='secret://tenants/'||NEW.tenant_id::text||'/bot-actions/'||parent_action_key;
  integration_prefix:='secret://tenants/'||NEW.tenant_id::text||'/routing/integrations/';
  IF NEW.secret_reference=action_prefix
     OR (
       left(NEW.secret_reference,length(action_prefix))=action_prefix
       AND substring(NEW.secret_reference FROM length(action_prefix)+1)
         ~ '^/credentials/[0-9a-f]{64}$'
     )
     OR (
       NEW.kind='NOTION_CREATE_PAGE'
       AND left(NEW.secret_reference,length(integration_prefix))=integration_prefix
       AND substring(NEW.secret_reference FROM length(integration_prefix)+1)
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bot action revision secret reference crosses its tenant or action boundary'
    USING ERRCODE='23514';
END
$$;

CREATE TRIGGER bot_action_revisions_secret_boundary
BEFORE INSERT ON bot_action_revisions
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_revision_secret();

ALTER TABLE bot_action_definitions ADD COLUMN active_revision_id uuid;

-- Migration 0103 paused legacy actions whose credential belonged to another
-- action. Preserve that fail-closed state without copying an invalid secret
-- reference into immutable revision history.
UPDATE bot_action_definitions action
SET auth_scheme='NONE',secret_reference=NULL,updated_at=now()
WHERE action.state='PAUSED'
  AND action.secret_reference IS NOT NULL
  AND action.secret_reference<>(
    'secret://tenants/'||action.tenant_id::text||'/bot-actions/'||action.action_key
  )
  AND NOT (
    action.kind='NOTION_CREATE_PAGE'
    AND action.secret_reference~(
      '^secret://tenants/'||action.tenant_id::text||'/routing/integrations/[0-9a-f-]{36}$'
    )
  );

INSERT INTO bot_action_revisions(
  id,tenant_id,action_definition_id,revision,name,kind,endpoint_url,http_method,
  auth_scheme,secret_reference,headers,response_mapping,timeout_ms,
  max_response_bytes,state,snapshot_sha256,created_by,created_at
)
SELECT gen_random_uuid(),action.tenant_id,action.id,action.revision,action.name,
  action.kind,action.endpoint_url,action.http_method,action.auth_scheme,
  action.secret_reference,action.headers,action.response_mapping,action.timeout_ms,
  action.max_response_bytes,action.state,
  encode(digest(jsonb_build_object(
    'name',action.name,'kind',action.kind,'endpointUrl',action.endpoint_url,
    'httpMethod',action.http_method,'authScheme',action.auth_scheme,
    'secretReference',action.secret_reference,'headers',action.headers,
    'responseMapping',action.response_mapping,'timeoutMs',action.timeout_ms,
    'maxResponseBytes',action.max_response_bytes,'state',action.state
  )::text,'sha256'),'hex'),action.updated_by,action.updated_at
FROM bot_action_definitions action;

UPDATE bot_action_definitions action
SET active_revision_id=revision.id
FROM bot_action_revisions revision
WHERE revision.tenant_id=action.tenant_id
  AND revision.action_definition_id=action.id
  AND revision.revision=action.revision;

ALTER TABLE bot_action_definitions
  ALTER COLUMN active_revision_id SET NOT NULL,
  ADD CONSTRAINT bot_action_definitions_active_revision_fk
    FOREIGN KEY (tenant_id,id,active_revision_id)
    REFERENCES bot_action_revisions(tenant_id,action_definition_id,id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION app.enforce_bot_action_actor_membership()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app AS $$
DECLARE actor_id uuid;
BEGIN
  actor_id:=NULLIF(to_jsonb(NEW)->>TG_ARGV[0],'')::uuid;
  IF actor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tenant_memberships membership
    WHERE membership.tenant_id=NEW.tenant_id
      AND membership.user_id=actor_id
      AND membership.state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'bot action actor must be an active member of its tenant'
      USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_action_revision_actor_membership
BEFORE INSERT OR UPDATE OF tenant_id,created_by ON bot_action_revisions
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership('created_by');

CREATE OR REPLACE FUNCTION app.enforce_bot_action_projection()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app AS $$
DECLARE selected bot_action_revisions%ROWTYPE;
BEGIN
  SELECT revision.* INTO selected FROM bot_action_revisions revision
   WHERE revision.tenant_id=NEW.tenant_id
     AND revision.action_definition_id=NEW.id
     AND revision.id=NEW.active_revision_id;
  IF NOT FOUND
     OR NEW.revision<>selected.revision
     OR NEW.name<>selected.name OR NEW.kind<>selected.kind
     OR NEW.endpoint_url<>selected.endpoint_url OR NEW.http_method<>selected.http_method
     OR NEW.auth_scheme<>selected.auth_scheme
     OR NEW.secret_reference IS DISTINCT FROM selected.secret_reference
     OR NEW.headers<>selected.headers OR NEW.response_mapping<>selected.response_mapping
     OR NEW.timeout_ms<>selected.timeout_ms
     OR NEW.max_response_bytes<>selected.max_response_bytes
     OR NEW.state<>selected.state THEN
    RAISE EXCEPTION 'bot action projection must match its immutable active revision'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER bot_action_projection_matches_revision
AFTER INSERT OR UPDATE ON bot_action_definitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_projection();

CREATE OR REPLACE FUNCTION app.reject_bot_action_revision_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bot action revisions are immutable' USING ERRCODE='55000';
END
$$;

CREATE TRIGGER bot_action_revisions_immutable
BEFORE UPDATE ON bot_action_revisions
FOR EACH ROW EXECUTE FUNCTION app.reject_bot_action_revision_update();

CREATE TABLE bot_action_credential_stages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_key text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key=btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:][:space:]]'
  ),
  secret_reference text NOT NULL,
  credential_sha256 text NOT NULL CHECK (credential_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'STAGED' CHECK (state IN ('STAGED','BOUND')),
  bound_action_revision_id uuid,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '1 hour'),
  bound_at timestamptz,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  UNIQUE (tenant_id,secret_reference),
  FOREIGN KEY (tenant_id,bound_action_revision_id)
    REFERENCES bot_action_revisions(tenant_id,id),
  CHECK (secret_reference=(
    'secret://tenants/'||tenant_id::text||'/bot-actions/'||action_key||
    '/credentials/'||encode(digest(tenant_id::text||':'||idempotency_key,'sha256'),'hex')
  )),
  CHECK (
    (state='STAGED' AND bound_action_revision_id IS NULL AND bound_at IS NULL)
    OR (state='BOUND' AND bound_action_revision_id IS NOT NULL AND bound_at IS NOT NULL)
  ),
  CHECK (expires_at>created_at)
);

CREATE TRIGGER bot_action_credential_stage_actor_membership
BEFORE INSERT OR UPDATE OF tenant_id,created_by ON bot_action_credential_stages
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership('created_by');

ALTER TABLE secret_cleanup_outbox
  DROP CONSTRAINT secret_cleanup_outbox_cleanup_kind_check,
  DROP CONSTRAINT secret_cleanup_outbox_owner_check,
  ADD COLUMN bot_action_credential_stage_id uuid,
  ADD CONSTRAINT secret_cleanup_outbox_cleanup_kind_check CHECK (
    cleanup_kind IN ('WEBHOOK_SECRET','ROUTING_INTEGRATION_SECRET','BOT_ACTION_CREDENTIAL_STAGE')
  ),
  ADD CONSTRAINT secret_cleanup_outbox_owner_check CHECK (
    (cleanup_kind='WEBHOOK_SECRET' AND connection_id IS NOT NULL
      AND connection_operation_id IS NOT NULL AND routing_integration_id IS NULL
      AND bot_action_credential_stage_id IS NULL)
    OR
    (cleanup_kind='ROUTING_INTEGRATION_SECRET' AND connection_id IS NULL
      AND connection_operation_id IS NULL AND routing_integration_id IS NOT NULL
      AND bot_action_credential_stage_id IS NULL)
    OR
    (cleanup_kind='BOT_ACTION_CREDENTIAL_STAGE' AND connection_id IS NULL
      AND connection_operation_id IS NULL AND routing_integration_id IS NULL
      AND bot_action_credential_stage_id IS NOT NULL)
  ),
  ADD CONSTRAINT secret_cleanup_outbox_action_credential_stage_fk
    FOREIGN KEY (tenant_id,bot_action_credential_stage_id)
    REFERENCES bot_action_credential_stages(tenant_id,id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION app.track_bot_action_credential_stage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF NEW.expires_at>clock_timestamp()+interval '1 hour' THEN
    RAISE EXCEPTION 'bot action credential stage expiry exceeds one hour'
      USING ERRCODE='23514';
  END IF;
  INSERT INTO secret_cleanup_outbox(
    tenant_id,bot_action_credential_stage_id,cleanup_kind,secret_reference,available_at
  ) VALUES (
    NEW.tenant_id,NEW.id,'BOT_ACTION_CREDENTIAL_STAGE',NEW.secret_reference,NEW.expires_at
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_action_credential_stage_cleanup
AFTER INSERT ON bot_action_credential_stages
FOR EACH ROW EXECUTE FUNCTION app.track_bot_action_credential_stage();

CREATE OR REPLACE FUNCTION app.enforce_bot_action_credential_stage_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.action_key<>OLD.action_key
     OR NEW.idempotency_key<>OLD.idempotency_key
     OR NEW.secret_reference<>OLD.secret_reference
     OR NEW.credential_sha256<>OLD.credential_sha256
     OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'bot action credential stage identity is immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.state='BOUND' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'bound bot action credential stages are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.state='STAGED' AND NEW.state='STAGED' THEN
    IF NEW.bound_action_revision_id IS NOT NULL OR NEW.bound_at IS NOT NULL
       OR NEW.expires_at<OLD.expires_at
       OR NEW.expires_at>clock_timestamp()+interval '1 hour'
       OR NOT EXISTS (
         SELECT 1 FROM secret_cleanup_outbox cleanup
         WHERE cleanup.tenant_id=OLD.tenant_id
           AND cleanup.bot_action_credential_stage_id=OLD.id
           AND cleanup.cleanup_kind='BOT_ACTION_CREDENTIAL_STAGE'
           AND cleanup.state='QUEUED'
       ) THEN
      RAISE EXCEPTION 'bot action credential stage renewal is invalid'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state<>'STAGED' OR NEW.state<>'BOUND'
     OR NEW.expires_at<>OLD.expires_at
     OR clock_timestamp()>=OLD.expires_at
     OR NOT EXISTS (
       SELECT 1 FROM bot_action_revisions revision
       JOIN bot_action_definitions action
         ON action.tenant_id=revision.tenant_id
        AND action.id=revision.action_definition_id
       WHERE revision.tenant_id=OLD.tenant_id
         AND revision.id=NEW.bound_action_revision_id
         AND revision.secret_reference=OLD.secret_reference
         AND action.action_key=OLD.action_key
     )
     OR NOT EXISTS (
       SELECT 1 FROM secret_cleanup_outbox cleanup
       WHERE cleanup.tenant_id=OLD.tenant_id
         AND cleanup.bot_action_credential_stage_id=OLD.id
         AND cleanup.cleanup_kind='BOT_ACTION_CREDENTIAL_STAGE'
         AND cleanup.state='QUEUED'
     ) THEN
    RAISE EXCEPTION 'bot action credential stage binding is invalid or cleanup already started'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_action_credential_stage_transition
BEFORE UPDATE ON bot_action_credential_stages
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_credential_stage_transition();

CREATE OR REPLACE FUNCTION app.schedule_bound_bot_action_credential_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  UPDATE secret_cleanup_outbox
     SET available_at=LEAST(available_at,now()),updated_at=now()
   WHERE tenant_id=NEW.tenant_id
     AND bot_action_credential_stage_id=NEW.id
     AND cleanup_kind='BOT_ACTION_CREDENTIAL_STAGE'
     AND state='QUEUED';
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_action_credential_stage_bound_cleanup
AFTER UPDATE OF state ON bot_action_credential_stages
FOR EACH ROW WHEN (NEW.state='BOUND' AND OLD.state='STAGED')
EXECUTE FUNCTION app.schedule_bound_bot_action_credential_cleanup();

CREATE TABLE automation_action_revision_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_flow_version_id uuid,
  rule_set_id uuid,
  action_definition_id uuid NOT NULL,
  action_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,bot_flow_version_id)
    REFERENCES bot_flow_versions(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,rule_set_id)
    REFERENCES rule_sets(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,action_definition_id,action_revision_id)
    REFERENCES bot_action_revisions(tenant_id,action_definition_id,id),
  CHECK ((bot_flow_version_id IS NOT NULL)::integer+(rule_set_id IS NOT NULL)::integer=1)
);

CREATE UNIQUE INDEX automation_action_revision_pins_flow_action_idx
  ON automation_action_revision_pins(tenant_id,bot_flow_version_id,action_definition_id)
  WHERE bot_flow_version_id IS NOT NULL;
CREATE UNIQUE INDEX automation_action_revision_pins_rule_action_idx
  ON automation_action_revision_pins(tenant_id,rule_set_id,action_definition_id)
  WHERE rule_set_id IS NOT NULL;

INSERT INTO automation_action_revision_pins(
  tenant_id,bot_flow_version_id,action_definition_id,action_revision_id
)
SELECT DISTINCT flow.tenant_id,flow.id,action.id,action.active_revision_id
FROM bot_flow_versions flow
CROSS JOIN LATERAL jsonb_array_elements(flow.definition->'nodes') node
JOIN bot_action_definitions action
  ON action.tenant_id=flow.tenant_id AND action.action_key=node->>'actionId'
WHERE node->>'type'='action'
  AND (flow.state='ACTIVE' OR EXISTS (
    SELECT 1 FROM bot_conversations conversation
    WHERE conversation.tenant_id=flow.tenant_id
      AND conversation.flow_version_id=flow.id
      AND conversation.state<>'RESOLVED'
  ));

INSERT INTO automation_action_revision_pins(
  tenant_id,rule_set_id,action_definition_id,action_revision_id
)
SELECT DISTINCT rule_set.tenant_id,rule_set.id,action.id,action.active_revision_id
FROM rule_sets rule_set
JOIN trigger_rules rule
  ON rule.tenant_id=rule_set.tenant_id AND rule.rule_set_id=rule_set.id
JOIN bot_action_definitions action
  ON action.tenant_id=rule_set.tenant_id
 AND action.action_key=rule.matcher_options->'groupCommand'->>'actionId'
WHERE rule.enabled AND rule.matcher_options->'groupCommand'->>'actionId' IS NOT NULL;

ALTER TABLE group_action_executions ADD COLUMN action_revision_id uuid;
UPDATE group_action_executions execution
SET action_revision_id=revision.id
FROM bot_action_revisions revision
WHERE revision.tenant_id=execution.tenant_id
  AND revision.action_definition_id=execution.action_definition_id
  AND revision.revision=execution.action_revision;
ALTER TABLE group_action_executions
  ADD CONSTRAINT group_action_executions_action_revision_fk
    FOREIGN KEY (tenant_id,action_definition_id,action_revision_id)
    REFERENCES bot_action_revisions(tenant_id,action_definition_id,id);

CREATE OR REPLACE FUNCTION app.require_group_action_execution_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_revision_id IS NULL THEN
    RAISE EXCEPTION 'group action execution requires an immutable action revision'
      USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER group_action_execution_revision_required
BEFORE INSERT ON group_action_executions
FOR EACH ROW EXECUTE FUNCTION app.require_group_action_execution_revision();

CREATE OR REPLACE FUNCTION app.enforce_group_action_execution_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.event_inbox_id<>OLD.event_inbox_id
     OR NEW.trigger_rule_id<>OLD.trigger_rule_id
     OR NEW.action_definition_id<>OLD.action_definition_id
     OR NEW.action_revision_id IS DISTINCT FROM OLD.action_revision_id
     OR NEW.action_key<>OLD.action_key OR NEW.action_revision<>OLD.action_revision
     OR NEW.action_snapshot<>OLD.action_snapshot OR NEW.request_input<>OLD.request_input
     OR NEW.request_sha256<>OLD.request_sha256 OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'group action execution identity is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER group_action_execution_identity
BEFORE UPDATE ON group_action_executions
FOR EACH ROW EXECUTE FUNCTION app.enforce_group_action_execution_identity();

ALTER TABLE bot_action_jobs
  ADD COLUMN origin text NOT NULL DEFAULT 'DIRECT_FLOW'
    CHECK (origin IN ('DIRECT_FLOW','QUALIFICATION')),
  ADD COLUMN action_revision_id uuid,
  ADD COLUMN qualification_requested_by uuid REFERENCES users(id),
  ADD COLUMN qualification_idempotency_key text,
  ADD COLUMN qualification_request_sha256 text,
  ALTER COLUMN conversation_id DROP NOT NULL,
  ALTER COLUMN source_event_id DROP NOT NULL;

UPDATE bot_action_jobs job
SET action_revision_id=action.active_revision_id
FROM bot_action_definitions action
WHERE action.tenant_id=job.tenant_id AND action.id=job.action_definition_id;

ALTER TABLE bot_action_jobs
  ALTER COLUMN action_revision_id SET NOT NULL,
  ADD CONSTRAINT bot_action_jobs_action_revision_fk
    FOREIGN KEY (tenant_id,action_definition_id,action_revision_id)
    REFERENCES bot_action_revisions(tenant_id,action_definition_id,id),
  ADD CONSTRAINT bot_action_jobs_origin_context_check CHECK (
    (origin='DIRECT_FLOW' AND conversation_id IS NOT NULL AND source_event_id IS NOT NULL
      AND qualification_requested_by IS NULL AND qualification_idempotency_key IS NULL
      AND qualification_request_sha256 IS NULL)
    OR
    (origin='QUALIFICATION' AND conversation_id IS NULL AND source_event_id IS NULL
      AND qualification_requested_by IS NOT NULL
      AND qualification_idempotency_key IS NOT NULL
      AND qualification_request_sha256 ~ '^[0-9a-f]{64}$')
  );

CREATE TRIGGER bot_action_job_actor_membership
BEFORE INSERT OR UPDATE OF tenant_id,qualification_requested_by ON bot_action_jobs
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership('qualification_requested_by');

SET CONSTRAINTS ALL IMMEDIATE;

CREATE UNIQUE INDEX bot_action_jobs_qualification_idempotency
  ON bot_action_jobs(tenant_id,qualification_idempotency_key)
  WHERE origin='QUALIFICATION';

CREATE INDEX bot_action_jobs_revision_cleanup_idx
  ON bot_action_jobs(tenant_id,action_revision_id)
  WHERE state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN');

CREATE INDEX bot_action_definitions_active_revision_idx
  ON bot_action_definitions(tenant_id,active_revision_id);

CREATE INDEX bot_action_revisions_secret_cleanup_idx
  ON bot_action_revisions(tenant_id,secret_reference,id)
  WHERE secret_reference IS NOT NULL;

CREATE INDEX automation_action_revision_pins_revision_idx
  ON automation_action_revision_pins(tenant_id,action_revision_id);

CREATE INDEX bot_action_credential_stages_bound_revision_idx
  ON bot_action_credential_stages(tenant_id,bound_action_revision_id)
  WHERE state='BOUND';

CREATE OR REPLACE FUNCTION app.pin_bot_action_job_revision()
RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NEW.action_revision_id IS NULL AND NEW.origin='DIRECT_FLOW' THEN
    SELECT pin.action_revision_id INTO NEW.action_revision_id
    FROM bot_conversations conversation
    JOIN automation_action_revision_pins pin
      ON pin.tenant_id=conversation.tenant_id
     AND pin.bot_flow_version_id=conversation.flow_version_id
     AND pin.action_definition_id=NEW.action_definition_id
    WHERE conversation.tenant_id=NEW.tenant_id AND conversation.id=NEW.conversation_id;
  END IF;
  IF NEW.action_revision_id IS NULL THEN
    RAISE EXCEPTION 'bot action job requires an activated action revision'
      USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_action_jobs_pin_revision
BEFORE INSERT ON bot_action_jobs
FOR EACH ROW EXECUTE FUNCTION app.pin_bot_action_job_revision();

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
    LEFT JOIN bot_conversations conversation
      ON conversation.tenant_id=job.tenant_id AND conversation.id=job.conversation_id
    WHERE job.tenant_id=app.current_tenant_id()
      AND (job.origin='QUALIFICATION' OR conversation.state='ACTION_PENDING')
      AND ((job.state IN ('QUEUED','FAILED_RETRYABLE') AND job.available_at<=now())
        OR (job.state='RUNNING' AND job.lease_expires_at<now()))
    ORDER BY job.available_at,job.created_at,job.id
    FOR UPDATE OF job SKIP LOCKED LIMIT claim_limit
  )
  UPDATE bot_action_jobs job SET state='RUNNING',attempts=job.attempts+1,
         fencing_token=job.fencing_token+1,lease_id=worker_lease,
         lease_expires_at=now()+interval '90 seconds',safe_error=NULL,updated_at=now()
    FROM candidates WHERE job.id=candidates.id RETURNING job.*;
END
$$;

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
            JOIN bot_action_revisions revision
              ON revision.tenant_id=job.tenant_id
             AND revision.id=job.action_revision_id
             WHERE job.tenant_id=candidate.tenant_id
               AND revision.secret_reference=candidate.secret_reference
               AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
          )
          AND NOT EXISTS (
            SELECT 1 FROM group_action_executions execution
             WHERE execution.tenant_id=candidate.tenant_id
               AND execution.action_snapshot->>'secretReference'=candidate.secret_reference
               AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
          )
          AND NOT EXISTS (
            SELECT 1 FROM client_routing_sync_jobs job
            JOIN client_routing_source_state source
              ON source.tenant_id=job.tenant_id AND source.id=job.source_state_id
             WHERE job.tenant_id=candidate.tenant_id
               AND source.secret_reference=candidate.secret_reference
               AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
          )
        ))
        AND (candidate.cleanup_kind<>'BOT_ACTION_CREDENTIAL_STAGE' OR EXISTS (
          SELECT 1 FROM bot_action_credential_stages stage
          JOIN tenants tenant ON tenant.id=stage.tenant_id
          WHERE stage.tenant_id=candidate.tenant_id
            AND stage.id=candidate.bot_action_credential_stage_id
            AND (
              (stage.state='STAGED' AND stage.expires_at<=clock_timestamp())
              OR (
                stage.state='BOUND'
                AND (
                  tenant.state='DELETING'
                  OR (
                    NOT EXISTS (
                      SELECT 1 FROM bot_action_definitions action
                      JOIN bot_action_revisions revision
                        ON revision.tenant_id=action.tenant_id
                       AND revision.id=action.active_revision_id
                      WHERE action.tenant_id=stage.tenant_id
                        AND revision.secret_reference=stage.secret_reference
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM automation_action_revision_pins pin
                      JOIN bot_action_revisions revision
                        ON revision.tenant_id=pin.tenant_id
                       AND revision.id=pin.action_revision_id
                      LEFT JOIN bot_flow_versions flow
                        ON flow.tenant_id=pin.tenant_id AND flow.id=pin.bot_flow_version_id
                      LEFT JOIN rule_sets rule_set
                        ON rule_set.tenant_id=pin.tenant_id AND rule_set.id=pin.rule_set_id
                      WHERE pin.tenant_id=stage.tenant_id
                        AND revision.secret_reference=stage.secret_reference
                        AND (
                          (pin.bot_flow_version_id IS NOT NULL AND (
                            flow.state='ACTIVE'
                            OR EXISTS (
                              SELECT 1 FROM bot_conversations conversation
                              WHERE conversation.tenant_id=flow.tenant_id
                                AND conversation.flow_version_id=flow.id
                                AND conversation.state<>'RESOLVED'
                            )
                          ))
                          OR (pin.rule_set_id IS NOT NULL AND (
                            rule_set.state='ACTIVE'
                            OR EXISTS (
                              SELECT 1 FROM event_inbox inbox
                              WHERE inbox.tenant_id=rule_set.tenant_id
                                AND inbox.governing_rule_set_id=rule_set.id
                                AND inbox.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')
                            )
                          ))
                        )
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM bot_action_jobs job
                      JOIN bot_action_revisions revision
                        ON revision.tenant_id=job.tenant_id
                       AND revision.id=job.action_revision_id
                      WHERE job.tenant_id=stage.tenant_id
                        AND revision.secret_reference=stage.secret_reference
                        AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM group_action_executions execution
                      WHERE execution.tenant_id=stage.tenant_id
                        AND execution.action_snapshot->>'secretReference'=stage.secret_reference
                        AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                    )
                  )
                )
              )
            )
          FOR UPDATE OF stage SKIP LOCKED
        ))
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING cleanup.id,cleanup.tenant_id,cleanup.secret_reference,
            cleanup.attempts,cleanup.max_attempts,cleanup.fencing_token;
END
$$;

ALTER TABLE bot_action_definitions DROP CONSTRAINT bot_action_definitions_tenant_secret_check;
ALTER TABLE bot_action_definitions ADD CONSTRAINT bot_action_definitions_tenant_secret_check CHECK (
  secret_reference IS NULL
  OR (
    kind IN ('HTTP_JSON','NOTION_CREATE_PAGE')
    AND (
      secret_reference=('secret://tenants/'||tenant_id::text||'/bot-actions/'||action_key)
      OR (
        left(secret_reference,length('secret://tenants/'||tenant_id::text||'/bot-actions/'||action_key))=
          ('secret://tenants/'||tenant_id::text||'/bot-actions/'||action_key)
        AND substring(secret_reference FROM length('secret://tenants/'||tenant_id::text||'/bot-actions/'||action_key)+1)
          ~ '^/credentials/[0-9a-f]{64}$'
      )
    )
  )
  OR (
    kind='NOTION_CREATE_PAGE'
    AND left(secret_reference,length('secret://tenants/'||tenant_id::text||'/routing/integrations/'))=
      ('secret://tenants/'||tenant_id::text||'/routing/integrations/')
    AND substring(secret_reference FROM length('secret://tenants/'||tenant_id::text||'/routing/integrations/')+1)
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
);

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN (
    'CREATE','CLONE','ACTIVATE','ASSIGN','CONVERSATION_COMMAND',
    'ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE'
  ));

ALTER TABLE bot_action_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_action_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bot_action_revisions
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
ALTER TABLE bot_action_credential_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_action_credential_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bot_action_credential_stages
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
ALTER TABLE automation_action_revision_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_action_revision_pins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_action_revision_pins
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());

REVOKE INSERT,UPDATE,DELETE ON bot_action_revisions FROM wasalx_app;
GRANT SELECT,INSERT ON bot_action_revisions TO wasalx_app;
REVOKE ALL ON bot_action_credential_stages FROM wasalx_app;
GRANT SELECT,INSERT ON bot_action_credential_stages TO wasalx_app;
GRANT UPDATE (state,bound_action_revision_id,bound_at,expires_at)
  ON bot_action_credential_stages TO wasalx_app;
GRANT SELECT,INSERT ON automation_action_revision_pins TO wasalx_app;
REVOKE ALL ON bot_action_credential_stages FROM wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,secret_reference,state,expires_at,bound_action_revision_id)
  ON bot_action_credential_stages TO wasalx_secret_cleanup_executor;
GRANT UPDATE (id) ON bot_action_credential_stages TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,secret_reference)
  ON bot_action_revisions TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,active_revision_id)
  ON bot_action_definitions TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,action_revision_id,state)
  ON bot_action_jobs TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,bot_flow_version_id,rule_set_id,action_revision_id)
  ON automation_action_revision_pins TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,state)
  ON bot_flow_versions TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,flow_version_id,state)
  ON bot_conversations TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,state)
  ON rule_sets TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,governing_rule_set_id,status)
  ON event_inbox TO wasalx_secret_cleanup_executor;
GRANT SELECT (id,state)
  ON tenants TO wasalx_secret_cleanup_executor;
REVOKE ALL ON FUNCTION app.enforce_bot_action_projection() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_bot_action_revision_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_bot_action_actor_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reject_bot_action_revision_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.track_bot_action_credential_stage() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_bot_action_credential_stage_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.schedule_bound_bot_action_credential_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_group_action_execution_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_group_action_execution_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.pin_bot_action_job_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_bot_action_jobs(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_bot_action_jobs(uuid,integer) TO wasalx_app;
