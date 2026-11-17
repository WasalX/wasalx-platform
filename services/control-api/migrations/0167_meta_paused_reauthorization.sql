BEGIN;

-- A reconnect target exists before authorization; connection_id/operation_id still
-- mean a durable effect stage. Pre-stage expiry/cancellation therefore stays intact.
ALTER TABLE meta_signup_attempts ADD COLUMN purpose text NOT NULL DEFAULT 'NEW_NUMBER'
  CHECK (purpose IN ('NEW_NUMBER','RECONNECT'));
ALTER TABLE meta_signup_attempts ADD COLUMN target_connection_id uuid;
ALTER TABLE meta_signup_attempts ADD COLUMN target_binding jsonb;
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_reconnect_target_fk
  FOREIGN KEY (tenant_id,target_connection_id) REFERENCES connections(tenant_id,id);
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_reconnect_target_check CHECK (
  (purpose='NEW_NUMBER' AND target_connection_id IS NULL AND target_binding IS NULL)
  OR (purpose='RECONNECT' AND target_connection_id IS NOT NULL AND target_binding IS NOT NULL AND jsonb_typeof(target_binding)='object'
    AND (target_binding->>'state'='PAUSED' AND target_binding->>'contextSha256' ~ '^[0-9a-f]{64}$'
      AND target_binding->>'providerSessionId' ~ '^[0-9a-f-]{36}$'
      AND target_binding->>'phoneNumberId' ~ '^[0-9]{5,32}$' AND target_binding->>'wabaId' ~ '^[0-9]{5,32}$'
      AND target_binding->>'secretReference' LIKE 'secret://%') IS TRUE
    AND registration_pin_fingerprint IS NULL AND registration_claimed_at IS NULL
    AND (connection_id IS NULL OR connection_id=target_connection_id)));

CREATE FUNCTION app.meta_signup_reconnect_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.purpose,NEW.target_connection_id,NEW.target_binding) IS DISTINCT FROM (OLD.purpose,OLD.target_connection_id,OLD.target_binding) THEN
    RAISE EXCEPTION 'signup reconnect target is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_signup_reconnect_binding BEFORE UPDATE ON meta_signup_attempts
  FOR EACH ROW EXECUTE FUNCTION app.meta_signup_reconnect_immutable();
REVOKE ALL ON FUNCTION app.meta_signup_reconnect_immutable() FROM PUBLIC;
GRANT SELECT (purpose) ON meta_signup_attempts TO wasalx_secret_cleanup_executor;

-- Unknown signup rotation stages require an explicit reconciled cancellation,
-- not timeout deletion. Excluding them before LIMIT avoids starving other cleanup.

-- Preserve legal holds for all rotation-owned references before claim selection.


-- Existing-number access shares the reconnect and credential cleanup boundary.

-- ADD_ACCESS is an immutable authorization purpose, never permission to register,
-- subscribe, send, move ownership or change the payer. Historical signup stays NEW_NUMBER.
ALTER TABLE meta_signup_attempts DROP CONSTRAINT meta_signup_attempts_purpose_check;
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_attempts_purpose_check
  CHECK (purpose IN ('NEW_NUMBER','RECONNECT','ADD_ACCESS'));
ALTER TABLE meta_signup_attempts DROP CONSTRAINT meta_signup_reconnect_target_check;
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_reconnect_target_check CHECK (
  (purpose IN ('NEW_NUMBER','ADD_ACCESS') AND target_connection_id IS NULL AND target_binding IS NULL)
  OR (purpose='RECONNECT' AND target_connection_id IS NOT NULL AND target_binding IS NOT NULL AND jsonb_typeof(target_binding)='object'
    AND (target_binding->>'state'='PAUSED' AND target_binding->>'contextSha256' ~ '^[0-9a-f]{64}$'
      AND target_binding->>'providerSessionId' ~ '^[0-9a-f-]{36}$'
      AND target_binding->>'phoneNumberId' ~ '^[0-9]{5,32}$' AND target_binding->>'wabaId' ~ '^[0-9]{5,32}$'
      AND target_binding->>'secretReference' LIKE 'secret://%') IS TRUE
    AND (connection_id IS NULL OR connection_id=target_connection_id)));
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_registration_purpose_check
  CHECK (purpose='NEW_NUMBER' OR (registration_pin_fingerprint IS NULL AND registration_claimed_at IS NULL));
ALTER TABLE meta_signup_attempts ADD COLUMN connection_credential_write_claimed_at timestamptz;
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_connection_write_purpose_check
  CHECK (connection_credential_write_claimed_at IS NULL OR (purpose='ADD_ACCESS' AND connection_id IS NOT NULL));
GRANT SELECT (purpose) ON meta_signup_attempts TO wasalx_connector_worker;

CREATE FUNCTION app.meta_signup_connection_write_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.connection_credential_write_claimed_at IS NOT NULL
    AND NEW.connection_credential_write_claimed_at IS DISTINCT FROM OLD.connection_credential_write_claimed_at THEN
    RAISE EXCEPTION 'signup credential write claim is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_signup_connection_write_claim BEFORE UPDATE ON meta_signup_attempts
  FOR EACH ROW EXECUTE FUNCTION app.meta_signup_connection_write_immutable();
REVOKE ALL ON FUNCTION app.meta_signup_connection_write_immutable() FROM PUBLIC;

-- Shared API/worker/database authority. A later explicit activation slice must
-- replace this hold with reviewed routing and funding admission; no caller flag can.
CREATE FUNCTION app.meta_add_access_enrolled(tenant_value uuid,connection_value uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
  SELECT EXISTS (
    SELECT 1 FROM meta_signup_attempts WHERE tenant_id=tenant_value AND connection_id=connection_value AND purpose='ADD_ACCESS'
  ) OR EXISTS (
    SELECT 1 FROM provider_sessions WHERE tenant_id=tenant_value AND connection_id=connection_value
      AND provider_state_data->'metaSignup'->>'purpose'='ADD_ACCESS'
  );
$$;
REVOKE ALL ON FUNCTION app.meta_add_access_enrolled(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION app.meta_add_access_activation_held(tenant_value uuid,connection_value uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
  SELECT tenant_value IS DISTINCT FROM app.current_tenant_id() OR app.meta_add_access_enrolled(tenant_value,connection_value);
$$;
REVOKE ALL ON FUNCTION app.meta_add_access_activation_held(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_add_access_activation_held(uuid,uuid) TO wasalx_app,wasalx_connector_worker;

-- Defense against a stale worker, manual lifecycle/rotation or forged staged job.
-- The attempt and exact trusted marker survive a same-account credential renewal.
CREATE FUNCTION app.meta_add_access_boundary() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE connection_value uuid; held boolean;
BEGIN
  IF TG_TABLE_NAME='connections' THEN connection_value:=NEW.id;
  ELSE connection_value:=NEW.connection_id; END IF;
  held:=app.meta_add_access_enrolled(NEW.tenant_id,connection_value);
  IF TG_TABLE_NAME='connection_operations' THEN
    IF TG_OP='UPDATE' AND OLD.payload->>'metaSignupPurpose'='ADD_ACCESS'
      AND (NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.payload->>'metaSignupPurpose',NEW.payload->>'metaSignupAttemptId',NEW.payload->>'credentialReference')
        IS DISTINCT FROM (OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.payload->>'metaSignupPurpose',OLD.payload->>'metaSignupAttemptId',OLD.payload->>'credentialReference') THEN
      RAISE EXCEPTION 'saved access operation binding is immutable' USING ERRCODE='23514';
    END IF;
    IF held AND NEW.operation_type IN ('PROVISION','START','RESTART','SYNC_GROUPS') AND NEW.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE') THEN
      RAISE EXCEPTION 'saved access requires separate activation' USING ERRCODE='23514';
    END IF;
    IF held AND NEW.operation_type IN ('DISCONNECT','ROTATE_META_CREDENTIAL') AND NEW.state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')
      AND EXISTS (SELECT 1 FROM meta_signup_attempts WHERE tenant_id=NEW.tenant_id AND connection_id=connection_value AND purpose='ADD_ACCESS' AND status='PROVISIONING') THEN
      RAISE EXCEPTION 'saved access credential stage requires reconciliation or cancellation' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='provider_sessions' THEN
    IF TG_OP='UPDATE' AND OLD.provider_state_data->'metaSignup'->>'purpose'='ADD_ACCESS'
      AND NEW.provider_state_data->'metaSignup' IS DISTINCT FROM OLD.provider_state_data->'metaSignup' THEN
      RAISE EXCEPTION 'saved access enrollment is immutable' USING ERRCODE='23514';
    END IF;
    IF held AND NEW.state IN ('CONNECTING','WORKING','DEGRADED') THEN
      RAISE EXCEPTION 'saved access session requires separate activation' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='connections' AND held AND NEW.state IN ('CONNECTING','WORKING','DEGRADED') THEN
    RAISE EXCEPTION 'saved access connection requires separate activation' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='webhook_routes' AND held AND NEW.state='ACTIVE' THEN
    RAISE EXCEPTION 'saved access route requires separate activation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_add_access_operation_boundary BEFORE INSERT OR UPDATE ON connection_operations
  FOR EACH ROW EXECUTE FUNCTION app.meta_add_access_boundary();
CREATE TRIGGER meta_add_access_connection_boundary BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION app.meta_add_access_boundary();
CREATE TRIGGER meta_add_access_session_boundary BEFORE INSERT OR UPDATE ON provider_sessions
  FOR EACH ROW EXECUTE FUNCTION app.meta_add_access_boundary();
CREATE TRIGGER meta_add_access_route_boundary BEFORE INSERT OR UPDATE ON webhook_routes
  FOR EACH ROW EXECUTE FUNCTION app.meta_add_access_boundary();
REVOKE ALL ON FUNCTION app.meta_add_access_boundary() FROM PUBLIC;

-- Replacements below preserve incumbent leasing, drains, cleanup ownership and
-- history while adding the exact purpose exclusions before claim LIMITs.

CREATE OR REPLACE FUNCTION app.meta_signup_operation_current(tenant_value uuid,attempt_value uuid,connection_value uuid,operation_value uuid,
  config_value jsonb,phone_value text,waba_value text,business_value text,fingerprint_value text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
  SELECT tenant_value=app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM meta_signup_attempts attempt
    JOIN tenant_memberships membership ON membership.tenant_id=attempt.tenant_id AND membership.user_id=attempt.requested_by
    JOIN tenants tenant ON tenant.id=attempt.tenant_id
    JOIN provider_sessions session ON session.tenant_id=attempt.tenant_id AND session.connection_id=attempt.connection_id
    JOIN connections connection ON connection.tenant_id=attempt.tenant_id AND connection.id=attempt.connection_id
    WHERE attempt.tenant_id=tenant_value AND attempt.id=attempt_value AND attempt.connection_id=connection_value
      AND attempt.operation_id=operation_value AND attempt.status='PROVISIONING' AND attempt.purpose='NEW_NUMBER'
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


CREATE OR REPLACE FUNCTION app.claim_connection_operations(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS SETOF connection_operations
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE = '22023';
  END IF;
  IF claim_limit < 1 OR claim_limit > 100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE = '22023';
  END IF;

  UPDATE connection_operations
     SET state = 'FAILED_TERMINAL',
         lease_id = NULL,
         lease_expires_at = NULL,
         error_code = COALESCE(error_code, 'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error = COALESCE(safe_error, 'Connection operation exhausted its retry limit.'),
         completed_at = now(),
         updated_at = now()
   WHERE tenant_id = app.current_tenant_id()
     AND attempts >= max_attempts
     AND (
       state IN ('QUEUED','FAILED_RETRYABLE')
       OR (state = 'RUNNING' AND lease_expires_at < now())
     );

  RETURN QUERY
  UPDATE connection_operations AS operation
     SET lease_id = worker_lease,
         lease_expires_at = now() + interval '60 seconds',
         fencing_token = operation.fencing_token + 1,
         state = 'RUNNING',
         attempts = operation.attempts + 1,
         started_at = COALESCE(operation.started_at, now()),
         error_code = NULL,
         safe_error = NULL,
         updated_at = now()
   WHERE operation.id IN (
     SELECT candidate.id
       FROM connection_operations AS candidate
      WHERE candidate.tenant_id = app.current_tenant_id()
        AND candidate.attempts < candidate.max_attempts
        AND NOT (candidate.operation_type IN ('PROVISION','START','RESTART','SYNC_GROUPS')
          AND app.meta_add_access_activation_held(candidate.tenant_id,candidate.connection_id))
        AND (
          (candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at <= now())
          OR (candidate.state = 'RUNNING' AND candidate.lease_expires_at < now())
        )
        AND (candidate.lease_expires_at IS NULL OR candidate.lease_expires_at < now())
        AND NOT EXISTS (
          SELECT 1 FROM connection_operations predecessor
           WHERE predecessor.tenant_id=candidate.tenant_id
             AND predecessor.connection_id=candidate.connection_id
             AND predecessor.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
             AND (predecessor.created_at,predecessor.id)<(candidate.created_at,candidate.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM connection_operations sibling
           WHERE sibling.tenant_id=candidate.tenant_id
             AND sibling.connection_id=candidate.connection_id
             AND sibling.id<>candidate.id
             AND sibling.state='RUNNING'
             AND sibling.lease_expires_at>=now()
        )
        AND NOT (
          candidate.operation_type IN ('START','RESTART','PAUSE','DISCONNECT')
          AND (
            EXISTS (
              SELECT 1 FROM delivery_outbox delivery
               WHERE delivery.tenant_id=candidate.tenant_id
                 AND delivery.connection_id=candidate.connection_id
                 AND delivery.state='SENDING'
            )
            OR EXISTS (
              SELECT 1 FROM event_inbox event
               WHERE event.tenant_id=candidate.tenant_id
                 AND event.connection_id=candidate.connection_id
                 AND event.event_type<>'quarantine.reprocess'
                 AND event.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')
                 AND event.received_at<=candidate.created_at
            )
          )
        )
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING operation.*;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_connection_operations(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_connection_operations(uuid,integer) TO wasalx_app,wasalx_connector_worker;


CREATE OR REPLACE FUNCTION app.expire_secret_provisioning_stages()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE candidate record;
BEGIN
  -- A removed actor or stale target may need operator review. This finite status
  -- is evidence of a retained stage, not evidence of absence or permission to delete.
  UPDATE connection_operations SET error_code='META_SIGNUP_STAGE_REVIEW_REQUIRED',
    safe_error='Review or cancel this retained account access stage after confirming its exact credential state.',updated_at=clock_timestamp()
    WHERE id IN (SELECT id FROM connection_operations WHERE state='STAGED'
      AND payload->>'metaSignupPurpose' IN ('RECONNECT','ADD_ACCESS') AND updated_at<=clock_timestamp()-interval '1 hour'
      AND error_code IS DISTINCT FROM 'META_SIGNUP_STAGE_REVIEW_REQUIRED'
      ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED);
  FOR candidate IN
    SELECT operation.id,operation.tenant_id,operation.connection_id,
           operation.operation_type,operation.requested_by_id,operation.request_id
      FROM connection_operations operation
     WHERE operation.state='STAGED'
       AND COALESCE(operation.payload->>'metaSignupPurpose','') NOT IN ('RECONNECT','ADD_ACCESS')
       AND operation.updated_at<=clock_timestamp()-interval '1 hour'
     ORDER BY operation.updated_at,operation.id
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    UPDATE connection_operations
       SET state='FAILED_TERMINAL',error_code='CREDENTIAL_STAGE_EXPIRED',
           safe_error='Credential provisioning expired before it completed.',
           completed_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=candidate.tenant_id AND id=candidate.id AND state='STAGED';
    IF FOUND THEN
      IF candidate.operation_type='PROVISION' THEN
        UPDATE connections
           SET state='REVOKED',action_reason='Credential provisioning expired.',
               updated_at=clock_timestamp()
         WHERE tenant_id=candidate.tenant_id AND id=candidate.connection_id
           AND state='PROVISIONING';
        UPDATE webhook_routes
           SET state='REVOKED',updated_at=clock_timestamp()
         WHERE tenant_id=candidate.tenant_id AND connection_id=candidate.connection_id
           AND state<>'REVOKED';
      END IF;
      INSERT INTO audit_events(
        tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
      ) VALUES (
        candidate.tenant_id,'SYSTEM','secret-cleanup','connection.credential_stage_expired',
        'connection',candidate.connection_id::text,
        jsonb_build_object('operation_id',candidate.id,'operation_type',candidate.operation_type),
        candidate.request_id
      );
    END IF;
  END LOOP;

  FOR candidate IN
    SELECT integration.id,integration.tenant_id
      FROM client_routing_integrations integration
     WHERE integration.state='CONNECTING'
       AND integration.updated_at<=clock_timestamp()-interval '1 hour'
     ORDER BY integration.updated_at,integration.id
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    UPDATE client_routing_integrations
       SET state='REVOKED',revision=revision+1,updated_at=clock_timestamp()
     WHERE tenant_id=candidate.tenant_id AND id=candidate.id AND state='CONNECTING';
    IF FOUND THEN
      INSERT INTO audit_events(
        tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
      ) VALUES (
        candidate.tenant_id,'SYSTEM','secret-cleanup','client_routing.integration_expired',
        'client_routing_integration',candidate.id::text,
        jsonb_build_object('reason','CREDENTIAL_STAGE_EXPIRED'),
        'secret-cleanup:'||candidate.id::text
      );
    END IF;
  END LOOP;
END
$$;

-- Preserve legal holds for all rotation-owned references before claim selection.
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
        AND NOT EXISTS (
          SELECT 1 FROM meta_signup_attempts attempt
          JOIN privacy_legal_holds hold ON hold.tenant_id=attempt.tenant_id AND hold.released_at IS NULL
          WHERE attempt.tenant_id=candidate.tenant_id AND attempt.operation_id=candidate.connection_operation_id
            AND attempt.purpose IN ('RECONNECT','ADD_ACCESS')
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


-- Every privileged helper in this access/cleanup closure resolves permanent
-- relations before an invoker's temporary schema. Historical SQL bytes, owners,
-- grants and RLS remain unchanged; helpers with their own SET must be hardened too.
ALTER FUNCTION app.meta_signup_phone_available(text) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.secret_cleanup_reference_is_owned(text,uuid,uuid,uuid,uuid,uuid,text) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.enforce_secret_cleanup_reference() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.expire_meta_signup_attempts() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.enforce_audit_event_actor_membership() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.enqueue_routing_integration_secret_cleanup() SET search_path=pg_catalog,public,app,pg_temp;

COMMIT;
