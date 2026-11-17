BEGIN;

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
SET search_path=pg_catalog,public,app
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

  RETURN false;
END
$$;

CREATE OR REPLACE FUNCTION app.enforce_secret_cleanup_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
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
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS secret_cleanup_reference_guard ON secret_cleanup_outbox;
CREATE TRIGGER secret_cleanup_reference_guard
BEFORE INSERT OR UPDATE OF tenant_id,connection_id,connection_operation_id,
  routing_integration_id,bot_action_credential_stage_id,cleanup_kind,secret_reference
ON secret_cleanup_outbox
FOR EACH ROW EXECUTE FUNCTION app.enforce_secret_cleanup_reference();

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

  PERFORM app.expire_secret_provisioning_stages();

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

COMMIT;
