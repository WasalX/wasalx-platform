BEGIN;

-- Authorization codes and challenge plaintext never enter PostgreSQL. The SDK
-- owns its OAuth transaction; challenge_sha256 binds our invocation, not echoed Meta state.
CREATE TABLE meta_signup_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  requested_by uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  challenge_sha256 text NOT NULL CHECK (challenge_sha256 ~ '^[0-9a-f]{64}$'),
  code_sha256 text UNIQUE CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object' AND config->>'payerMode'='CUSTOMER'),
  status text NOT NULL DEFAULT 'AWAITING_AUTHORIZATION' CHECK (status IN (
    'AWAITING_AUTHORIZATION','EXCHANGING','OUTCOME_UNKNOWN','SELECTION_REQUIRED','NUMBER_REQUIRED',
    'ACTION_REQUIRED','PROVISIONING','COMPLETED','FAILED','CANCELLED','EXPIRED')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  selection_revision integer NOT NULL DEFAULT 0 CHECK (selection_revision>=0),
  reason_code text,
  readiness jsonb NOT NULL DEFAULT '{}'::jsonb,
  choices jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(choices)='array' AND jsonb_array_length(choices)<=100),
  selected_choice jsonb,
  credential_metadata jsonb,
  credential_fingerprint text CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  secret_reference text NOT NULL,
  exchange_claimed_at timestamptz,
  credential_stored_at timestamptz,
  registration_claimed_at timestamptz,
  registration_pin_fingerprint text CHECK (registration_pin_fingerprint ~ '^[0-9a-f]{64}$'),
  connection_id uuid,
  operation_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,requested_by,idempotency_key),
  UNIQUE (tenant_id,secret_reference),
  CHECK (secret_reference='secret://'||tenant_id::text||'/meta-signup/'||id::text),
  CHECK ((connection_id IS NULL)=(operation_id IS NULL)),
  FOREIGN KEY (tenant_id,requested_by) REFERENCES tenant_memberships(tenant_id,user_id) ON DELETE SET NULL (requested_by),
  FOREIGN KEY (tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY (tenant_id,operation_id) REFERENCES connection_operations(tenant_id,id)
);
CREATE INDEX meta_signup_actor_latest ON meta_signup_attempts(tenant_id,requested_by,created_at DESC);
ALTER TABLE meta_signup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_signup_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_signup_attempts USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON meta_signup_attempts TO wasalx_app;
GRANT SELECT (tenant_id,id,connection_id,operation_id,status,selected_choice,credential_fingerprint,registration_claimed_at)
  ON meta_signup_attempts TO wasalx_connector_worker;
GRANT UPDATE (registration_claimed_at,updated_at) ON meta_signup_attempts TO wasalx_connector_worker;
GRANT SELECT (tenant_id,id,secret_reference,status,expires_at,connection_id,operation_id),UPDATE(updated_at)
  ON meta_signup_attempts TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,released_at) ON privacy_legal_holds TO wasalx_secret_cleanup_executor;

CREATE FUNCTION app.meta_signup_immutable_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.tenant_id,NEW.idempotency_key,NEW.challenge_sha256,NEW.config,NEW.secret_reference,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.idempotency_key,OLD.challenge_sha256,OLD.config,OLD.secret_reference,OLD.expires_at,OLD.created_at)
    OR (NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL)
    OR (NEW.name IS DISTINCT FROM OLD.name AND NEW.name<>'[removed]')
    OR (OLD.registration_pin_fingerprint IS NOT NULL AND NEW.registration_pin_fingerprint IS DISTINCT FROM OLD.registration_pin_fingerprint)
    OR (OLD.exchange_claimed_at IS NOT NULL AND (NEW.exchange_claimed_at,NEW.code_sha256) IS DISTINCT FROM (OLD.exchange_claimed_at,OLD.code_sha256))
    OR (OLD.credential_fingerprint IS NOT NULL AND NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint)
    OR (OLD.registration_claimed_at IS NOT NULL AND NEW.registration_claimed_at IS DISTINCT FROM OLD.registration_claimed_at)
    OR (OLD.connection_id IS NOT NULL AND (NEW.connection_id,NEW.operation_id,NEW.selected_choice) IS DISTINCT FROM (OLD.connection_id,OLD.operation_id,OLD.selected_choice)) THEN
    RAISE EXCEPTION 'signup authorization binding is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_signup_binding BEFORE UPDATE ON meta_signup_attempts FOR EACH ROW EXECUTE FUNCTION app.meta_signup_immutable_binding();
REVOKE ALL ON FUNCTION app.meta_signup_immutable_binding() FROM PUBLIC;

-- Worker admission reads membership without granting broad membership access.
CREATE FUNCTION app.meta_signup_operation_current(tenant_value uuid,attempt_value uuid,connection_value uuid,operation_value uuid,
  config_value jsonb,phone_value text,waba_value text,business_value text,fingerprint_value text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
  SELECT tenant_value=app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM meta_signup_attempts attempt
    JOIN tenant_memberships membership ON membership.tenant_id=attempt.tenant_id AND membership.user_id=attempt.requested_by
    JOIN tenants tenant ON tenant.id=attempt.tenant_id
    JOIN provider_sessions session ON session.tenant_id=attempt.tenant_id AND session.connection_id=attempt.connection_id
    JOIN connections connection ON connection.tenant_id=attempt.tenant_id AND connection.id=attempt.connection_id
    WHERE attempt.tenant_id=tenant_value AND attempt.id=attempt_value AND attempt.connection_id=connection_value
      AND attempt.operation_id=operation_value AND attempt.status='PROVISIONING'
      AND membership.state='ACTIVE' AND membership.role IN ('tenant_owner','tenant_admin') AND tenant.state='ACTIVE'
      AND attempt.config=config_value AND attempt.credential_fingerprint=fingerprint_value
      AND attempt.selected_choice->>'phoneId'=phone_value AND attempt.selected_choice->>'wabaId'=waba_value
      AND attempt.selected_choice->>'businessId'=business_value
      AND session.ownership_state='ACTIVE' AND session.opaque_session_id=phone_value
      AND session.provider_state_data->'metaSignup'->>'attemptId'=attempt_value::text
      AND session.provider_state_data->'metaSignup'->>'businessId'=business_value
      AND session.provider_state_data->'metaSignup'->>'phoneId'=phone_value
      AND session.provider_state_data->'metaSignup'->>'wabaId'=waba_value
      AND connection.secret_reference='secret://'||tenant_value::text||'/connections/'||connection_value::text||'/meta'
    FOR SHARE OF membership,tenant,attempt,session,connection
  );
$$;
REVOKE ALL ON FUNCTION app.meta_signup_operation_current(uuid,uuid,uuid,uuid,jsonb,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_signup_operation_current(uuid,uuid,uuid,uuid,jsonb,text,text,text,text) TO wasalx_connector_worker;

-- No cross-tenant information is returned. Existing/manual bindings count too.
CREATE FUNCTION app.meta_signup_phone_available(phone_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
  SELECT phone_id ~ '^[0-9]{5,32}$' AND NOT EXISTS (
    SELECT 1 FROM webhook_routes WHERE provider='META' AND external_key=phone_id
  );
$$;
REVOKE ALL ON FUNCTION app.meta_signup_phone_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_signup_phone_available(text) TO wasalx_app;

ALTER TABLE secret_cleanup_outbox ADD COLUMN meta_signup_attempt_id uuid;
ALTER TABLE secret_cleanup_outbox ADD CONSTRAINT secret_cleanup_signup_fk
  FOREIGN KEY (tenant_id,meta_signup_attempt_id) REFERENCES meta_signup_attempts(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE secret_cleanup_outbox ADD CONSTRAINT secret_cleanup_signup_key UNIQUE(tenant_id,meta_signup_attempt_id,secret_reference);
ALTER TABLE secret_cleanup_outbox DROP CONSTRAINT secret_cleanup_outbox_cleanup_kind_check;
ALTER TABLE secret_cleanup_outbox ADD CONSTRAINT secret_cleanup_outbox_cleanup_kind_check CHECK (
  cleanup_kind IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL','ROUTING_INTEGRATION_SECRET','BOT_ACTION_CREDENTIAL_STAGE','META_SIGNUP_CREDENTIAL'));
ALTER TABLE secret_cleanup_outbox DROP CONSTRAINT secret_cleanup_outbox_owner_check;
ALTER TABLE secret_cleanup_outbox ADD CONSTRAINT secret_cleanup_outbox_owner_check CHECK (
  (cleanup_kind IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL') AND connection_id IS NOT NULL AND connection_operation_id IS NOT NULL
    AND routing_integration_id IS NULL AND bot_action_credential_stage_id IS NULL AND meta_signup_attempt_id IS NULL)
  OR (cleanup_kind='ROUTING_INTEGRATION_SECRET' AND connection_id IS NULL AND connection_operation_id IS NULL
    AND routing_integration_id IS NOT NULL AND bot_action_credential_stage_id IS NULL AND meta_signup_attempt_id IS NULL)
  OR (cleanup_kind='BOT_ACTION_CREDENTIAL_STAGE' AND connection_id IS NULL AND connection_operation_id IS NULL
    AND routing_integration_id IS NULL AND bot_action_credential_stage_id IS NOT NULL AND meta_signup_attempt_id IS NULL)
  OR (cleanup_kind='META_SIGNUP_CREDENTIAL' AND connection_id IS NULL AND connection_operation_id IS NULL
    AND routing_integration_id IS NULL AND bot_action_credential_stage_id IS NULL AND meta_signup_attempt_id IS NOT NULL));

-- The existing executor remains the sole cleanup engine. The new kind is claimed
-- only with its exact attempt owner and no unknown/promoted/current references.

CREATE OR REPLACE FUNCTION app.secret_cleanup_reference_is_owned(
  cleanup_kind_value text,
  tenant_id_value uuid,
  connection_id_value uuid,
  connection_operation_id_value uuid,
  routing_integration_id_value uuid,
  bot_action_credential_stage_id_value uuid,
  secret_reference_value text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp
SET row_security=off AS $$
DECLARE
  base_reference text;
  rotation_suffix text;
  owner_operation record;
BEGIN
  IF cleanup_kind_value IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL') THEN
    SELECT operation.operation_type,operation.payload,connection.provider
      INTO owner_operation
      FROM connection_operations operation
      JOIN connections connection
        ON connection.tenant_id=operation.tenant_id AND connection.id=operation.connection_id
     WHERE operation.tenant_id=tenant_id_value
       AND operation.id=connection_operation_id_value
       AND operation.connection_id=connection_id_value;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    base_reference := format(
      'secret://%s/connections/%s/%s',
      tenant_id_value,
      connection_id_value,
      CASE cleanup_kind_value WHEN 'WEBHOOK_SECRET' THEN 'webhook' ELSE 'meta' END
    );
    IF cleanup_kind_value='WEBHOOK_SECRET' THEN
      IF secret_reference_value<>base_reference THEN
        RETURN false;
      END IF;
      RETURN (
        owner_operation.provider='WAHA'
        AND owner_operation.operation_type='PROVISION'
        AND owner_operation.payload->>'webhookSecretReference'=secret_reference_value
      ) OR (
        owner_operation.provider='WAHA'
        AND owner_operation.operation_type='DISCONNECT'
        AND EXISTS (
          SELECT 1 FROM webhook_routes route
           WHERE route.tenant_id=tenant_id_value
             AND route.connection_id=connection_id_value
             AND route.provider='WAHA'
             AND route.hmac_secret_reference=secret_reference_value
        )
      );
    END IF;

    IF secret_reference_value<>base_reference
       AND secret_reference_value NOT LIKE base_reference||'/rotations/%' THEN
      RETURN false;
    END IF;
    IF secret_reference_value<>base_reference THEN
      rotation_suffix := substring(secret_reference_value FROM length(base_reference)+12);
      IF length(rotation_suffix)<>64 OR rotation_suffix ~ '[^0-9a-f]' THEN
        RETURN false;
      END IF;
    END IF;
    RETURN (
      owner_operation.provider='META'
      AND owner_operation.operation_type='PROVISION'
      AND owner_operation.payload->>'credentialReference'=secret_reference_value
    ) OR (
      owner_operation.provider='META'
      AND owner_operation.operation_type='ROTATE_META_CREDENTIAL'
      AND secret_reference_value IN (
        owner_operation.payload->>'oldSecretReference',
        owner_operation.payload->>'newSecretReference'
      )
    ) OR (
      owner_operation.provider='META'
      AND owner_operation.operation_type='DISCONNECT'
      AND EXISTS (
        SELECT 1 FROM connections connection
         WHERE connection.tenant_id=tenant_id_value
           AND connection.id=connection_id_value
           AND connection.provider='META'
           AND connection.secret_reference=secret_reference_value
      )
    );
  END IF;

  IF cleanup_kind_value='ROUTING_INTEGRATION_SECRET' THEN
    RETURN EXISTS (
      SELECT 1 FROM client_routing_integrations integration
       WHERE integration.tenant_id=tenant_id_value
         AND integration.id=routing_integration_id_value
         AND integration.secret_reference=secret_reference_value
    );
  END IF;

  IF cleanup_kind_value='BOT_ACTION_CREDENTIAL_STAGE' THEN
    RETURN EXISTS (
      SELECT 1 FROM bot_action_credential_stages stage
       WHERE stage.tenant_id=tenant_id_value
         AND stage.id=bot_action_credential_stage_id_value
         AND stage.secret_reference=secret_reference_value
    );
  END IF;

  IF cleanup_kind_value='META_SIGNUP_CREDENTIAL' THEN
    RETURN EXISTS (SELECT 1 FROM meta_signup_attempts attempt
      WHERE attempt.tenant_id=tenant_id_value AND attempt.secret_reference=secret_reference_value
        AND secret_reference_value='secret://'||attempt.tenant_id::text||'/meta-signup/'||attempt.id::text);
  END IF;

  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION app.enforce_secret_cleanup_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp
SET row_security=off AS $$
BEGIN
  IF app.secret_cleanup_reference_is_owned(
    NEW.cleanup_kind,
    NEW.tenant_id,
    NEW.connection_id,
    NEW.connection_operation_id,
    NEW.routing_integration_id,
    NEW.bot_action_credential_stage_id,
    NEW.secret_reference
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'secret cleanup reference does not match its owner' USING ERRCODE='23514';
  END IF;
  IF NEW.cleanup_kind='META_SIGNUP_CREDENTIAL' AND NOT EXISTS (
    SELECT 1 FROM meta_signup_attempts attempt WHERE attempt.tenant_id=NEW.tenant_id
      AND attempt.id=NEW.meta_signup_attempt_id AND attempt.secret_reference=NEW.secret_reference
  ) THEN RAISE EXCEPTION 'signup cleanup owner mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS secret_cleanup_reference_guard ON secret_cleanup_outbox;
CREATE TRIGGER secret_cleanup_reference_guard
BEFORE INSERT OR UPDATE OF tenant_id,connection_id,connection_operation_id,
  routing_integration_id,bot_action_credential_stage_id,meta_signup_attempt_id,cleanup_kind,secret_reference
ON secret_cleanup_outbox
FOR EACH ROW EXECUTE FUNCTION app.enforce_secret_cleanup_reference();

CREATE FUNCTION app.expire_meta_signup_attempts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
  UPDATE meta_signup_attempts attempt SET status='EXPIRED',reason_code='META_SIGNUP_EXPIRED',revision=revision+1,updated_at=clock_timestamp()
    WHERE attempt.id IN (SELECT id FROM meta_signup_attempts WHERE expires_at<=clock_timestamp()
      AND connection_id IS NULL AND status IN ('AWAITING_AUTHORIZATION','SELECTION_REQUIRED','NUMBER_REQUIRED','ACTION_REQUIRED')
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED);
  -- Bounded metadata retention follows tenant policy and every legal hold. Unknown
  -- exchanges/registrations and active operations retain their reconciliation evidence.
  UPDATE meta_signup_attempts attempt SET name='[removed]',choices='[]'::jsonb,credential_metadata=NULL,updated_at=clock_timestamp()
    WHERE attempt.id IN (SELECT a.id FROM meta_signup_attempts a JOIN tenants tenant ON tenant.id=a.tenant_id
      JOIN retention_policies policy ON policy.tenant_id=a.tenant_id
      WHERE a.status IN ('COMPLETED','CANCELLED','EXPIRED','FAILED') AND a.expires_at<clock_timestamp() AND policy.state='ACTIVE'
        AND (tenant.state='DELETING' OR a.created_at<clock_timestamp()-make_interval(days=>tenant.retention_days))
        AND (a.name<>'[removed]' OR a.choices<>'[]'::jsonb OR a.credential_metadata IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds hold WHERE hold.tenant_id=a.tenant_id AND hold.state='ACTIVE')
        AND (a.operation_id IS NULL OR EXISTS (SELECT 1 FROM connection_operations operation WHERE operation.tenant_id=a.tenant_id
          AND operation.id=a.operation_id AND operation.state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED')))
      ORDER BY a.created_at LIMIT 100 FOR UPDATE OF a SKIP LOCKED);
END $$;
REVOKE ALL ON FUNCTION app.expire_meta_signup_attempts() FROM PUBLIC,wasalx_app;
GRANT EXECUTE ON FUNCTION app.expire_meta_signup_attempts() TO wasalx_secret_cleanup_executor;

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
SET search_path=pg_catalog,public,app,pg_temp
SET row_security=off
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE='22023';
  END IF;
  IF claim_limit<1 OR claim_limit>100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;

  PERFORM app.expire_secret_provisioning_stages();
  PERFORM app.expire_meta_signup_attempts();

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
        AND app.secret_cleanup_reference_is_owned(
          candidate.cleanup_kind,
          candidate.tenant_id,
          candidate.connection_id,
          candidate.connection_operation_id,
          candidate.routing_integration_id,
          candidate.bot_action_credential_stage_id,
          candidate.secret_reference
        )
        AND (candidate.cleanup_kind NOT IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL') OR EXISTS (
          SELECT 1
            FROM connection_operations operation
            JOIN tenants tenant ON tenant.id=operation.tenant_id
           WHERE operation.tenant_id=candidate.tenant_id
             AND operation.id=candidate.connection_operation_id
             AND operation.state<>'STAGED'
             AND (
               tenant.state='DELETING'
               OR (candidate.cleanup_kind='WEBHOOK_SECRET' AND NOT EXISTS (
                 SELECT 1 FROM webhook_routes route
                  WHERE route.tenant_id=candidate.tenant_id
                    AND route.hmac_secret_reference=candidate.secret_reference
                    AND route.state<>'REVOKED'
               ))
               OR (candidate.cleanup_kind='CONNECTION_CREDENTIAL' AND NOT EXISTS (
                 SELECT 1 FROM connections connection
                  WHERE connection.tenant_id=candidate.tenant_id
                    AND connection.secret_reference=candidate.secret_reference
                    AND connection.state<>'REVOKED'
               ))
             )
        ))
        AND (candidate.cleanup_kind<>'ROUTING_INTEGRATION_SECRET' OR EXISTS (
          SELECT 1 FROM client_routing_integrations integration
          JOIN tenants tenant ON tenant.id=integration.tenant_id
          WHERE integration.tenant_id=candidate.tenant_id
            AND integration.id=candidate.routing_integration_id
            AND (integration.state='REVOKED' OR tenant.state='DELETING')
        ) AND NOT EXISTS (
          SELECT 1 FROM client_routing_source_state source
           WHERE source.tenant_id=candidate.tenant_id
             AND source.secret_reference=candidate.secret_reference
             AND source.state<>'RETIRED'
        ) AND NOT EXISTS (
          SELECT 1 FROM bot_action_definitions action
           WHERE action.tenant_id=candidate.tenant_id
             AND action.secret_reference=candidate.secret_reference
             AND action.state='ACTIVE'
        ) AND NOT EXISTS (
          SELECT 1 FROM bot_action_jobs job
          JOIN bot_action_revisions revision
            ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
           WHERE job.tenant_id=candidate.tenant_id
             AND revision.secret_reference=candidate.secret_reference
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
        ) AND NOT EXISTS (
          SELECT 1 FROM group_action_executions execution
           WHERE execution.tenant_id=candidate.tenant_id
             AND execution.action_snapshot->>'secretReference'=candidate.secret_reference
             AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
        ) AND NOT EXISTS (
          SELECT 1 FROM client_routing_sync_jobs job
          JOIN client_routing_source_state source
            ON source.tenant_id=job.tenant_id AND source.id=job.source_state_id
           WHERE job.tenant_id=candidate.tenant_id
             AND source.secret_reference=candidate.secret_reference
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
        ))
        AND (candidate.cleanup_kind<>'BOT_ACTION_CREDENTIAL_STAGE' OR EXISTS (
          SELECT 1 FROM bot_action_credential_stages stage
          JOIN tenants tenant ON tenant.id=stage.tenant_id
          WHERE stage.tenant_id=candidate.tenant_id
            AND stage.id=candidate.bot_action_credential_stage_id
            AND (
              (stage.state='STAGED' AND stage.expires_at<=clock_timestamp())
              OR (stage.state='BOUND' AND (tenant.state='DELETING' OR (
                NOT EXISTS (
                  SELECT 1 FROM bot_action_definitions action
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=action.tenant_id AND revision.id=action.active_revision_id
                  WHERE action.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                ) AND NOT EXISTS (
                  SELECT 1 FROM automation_action_revision_pins pin
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
                  LEFT JOIN bot_flow_versions flow
                    ON flow.tenant_id=pin.tenant_id AND flow.id=pin.bot_flow_version_id
                  LEFT JOIN rule_sets rule_set
                    ON rule_set.tenant_id=pin.tenant_id AND rule_set.id=pin.rule_set_id
                  WHERE pin.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                    AND ((pin.bot_flow_version_id IS NOT NULL AND (
                      flow.state='ACTIVE' OR EXISTS (
                        SELECT 1 FROM bot_conversations conversation
                        WHERE conversation.tenant_id=flow.tenant_id
                          AND conversation.flow_version_id=flow.id
                          AND conversation.state<>'RESOLVED'
                      )
                    )) OR (pin.rule_set_id IS NOT NULL AND (
                      rule_set.state='ACTIVE' OR EXISTS (
                        SELECT 1 FROM event_inbox inbox
                        WHERE inbox.tenant_id=rule_set.tenant_id
                          AND inbox.governing_rule_set_id=rule_set.id
                          AND inbox.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')
                      )
                    )))
                ) AND NOT EXISTS (
                  SELECT 1 FROM bot_action_jobs job
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
                  WHERE job.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                    AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                ) AND NOT EXISTS (
                  SELECT 1 FROM group_action_executions execution
                  WHERE execution.tenant_id=stage.tenant_id
                    AND execution.action_snapshot->>'secretReference'=stage.secret_reference
                    AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                )
              )))
            )
          FOR UPDATE OF stage SKIP LOCKED
        ))
        AND (candidate.cleanup_kind<>'META_SIGNUP_CREDENTIAL' OR EXISTS (
          SELECT 1 FROM meta_signup_attempts attempt JOIN tenants tenant ON tenant.id=attempt.tenant_id
          WHERE attempt.tenant_id=candidate.tenant_id AND attempt.id=candidate.meta_signup_attempt_id
            AND attempt.secret_reference=candidate.secret_reference
            AND attempt.status NOT IN ('EXCHANGING','OUTCOME_UNKNOWN','PROVISIONING')
            AND (attempt.status IN ('CANCELLED','EXPIRED','FAILED') OR attempt.expires_at<clock_timestamp() OR tenant.state='DELETING')
            AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds hold WHERE hold.tenant_id=attempt.tenant_id AND hold.released_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM connections connection WHERE connection.tenant_id=attempt.tenant_id
              AND connection.secret_reference=attempt.secret_reference AND connection.state<>'REVOKED')
            AND (attempt.connection_id IS NULL OR EXISTS (
              SELECT 1 FROM connection_operations operation WHERE operation.tenant_id=attempt.tenant_id AND operation.id=attempt.operation_id
                AND operation.state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED')
            ))
          FOR UPDATE OF attempt SKIP LOCKED
        ))
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING cleanup.id,cleanup.tenant_id,cleanup.secret_reference,
            cleanup.attempts,cleanup.max_attempts,cleanup.fencing_token;
END
$$;

REVOKE ALL ON FUNCTION app.secret_cleanup_reference_is_owned(text,uuid,uuid,uuid,uuid,uuid,text)
  FROM PUBLIC,wasalx_app;
REVOKE ALL ON FUNCTION app.enforce_secret_cleanup_reference() FROM PUBLIC,wasalx_app;
GRANT EXECUTE ON FUNCTION app.secret_cleanup_reference_is_owned(text,uuid,uuid,uuid,uuid,uuid,text)
  TO wasalx_secret_cleanup_executor;


-- Reachable nested routines must not reset the safe caller lookup path.
ALTER FUNCTION app.expire_secret_provisioning_stages() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.enqueue_routing_integration_secret_cleanup() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.enforce_audit_event_actor_membership() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.enforce_consent_actor_membership() SET search_path=pg_catalog,public,app,pg_temp;
COMMIT;
