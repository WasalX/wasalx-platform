BEGIN;

-- Secret writes cross a transaction boundary. Reuse the durable connection
-- operation and cleanup outbox rows as the staging record/tombstone rather
-- than introducing another executor or credential table.
ALTER TABLE connection_operations
  DROP CONSTRAINT connection_operations_operation_type_check,
  DROP CONSTRAINT connection_operations_state_check,
  DROP CONSTRAINT connection_operations_terminal_time_check,
  ADD CONSTRAINT connection_operations_operation_type_check CHECK (
    operation_type IN (
      'PROVISION','START','RESTART','PAUSE','DISCONNECT','SYNC_GROUPS',
      'ROTATE_META_CREDENTIAL'
    )
  ),
  ADD CONSTRAINT connection_operations_state_check CHECK (
    state IN (
      'STAGED','QUEUED','RUNNING','SUCCEEDED','FAILED_RETRYABLE',
      'FAILED_TERMINAL','CANCELLED'
    )
  ),
  ADD CONSTRAINT connection_operations_terminal_time_check CHECK (
    (state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED') AND completed_at IS NOT NULL)
    OR (state NOT IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED') AND completed_at IS NULL)
  );

ALTER TABLE connection_operations
  ADD CONSTRAINT connection_operations_tenant_id_id_key UNIQUE (tenant_id,id);

CREATE INDEX connection_operations_secret_stage_expiry_idx
  ON connection_operations(updated_at,id) WHERE state='STAGED';

CREATE INDEX client_routing_integrations_secret_stage_expiry_idx
  ON client_routing_integrations(updated_at,id) WHERE state='CONNECTING';

ALTER TABLE secret_cleanup_outbox
  DROP CONSTRAINT secret_cleanup_outbox_cleanup_kind_check,
  DROP CONSTRAINT secret_cleanup_outbox_owner_check,
  DROP CONSTRAINT secret_cleanup_outbox_tenant_id_connection_operation_id_cle_key,
  ADD CONSTRAINT secret_cleanup_outbox_cleanup_kind_check CHECK (
    cleanup_kind IN (
      'WEBHOOK_SECRET','CONNECTION_CREDENTIAL','ROUTING_INTEGRATION_SECRET',
      'BOT_ACTION_CREDENTIAL_STAGE'
    )
  ),
  ADD CONSTRAINT secret_cleanup_outbox_owner_check CHECK (
    (cleanup_kind IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL')
      AND connection_id IS NOT NULL AND connection_operation_id IS NOT NULL
      AND routing_integration_id IS NULL AND bot_action_credential_stage_id IS NULL)
    OR
    (cleanup_kind='ROUTING_INTEGRATION_SECRET'
      AND connection_id IS NULL AND connection_operation_id IS NULL
      AND routing_integration_id IS NOT NULL AND bot_action_credential_stage_id IS NULL)
    OR
    (cleanup_kind='BOT_ACTION_CREDENTIAL_STAGE'
      AND connection_id IS NULL AND connection_operation_id IS NULL
      AND routing_integration_id IS NULL AND bot_action_credential_stage_id IS NOT NULL)
  ),
  ADD CONSTRAINT secret_cleanup_outbox_connection_operation_reference_key
    UNIQUE (tenant_id,connection_operation_id,cleanup_kind,secret_reference),
  ADD CONSTRAINT secret_cleanup_outbox_connection_fk
    FOREIGN KEY (tenant_id,connection_id)
    REFERENCES connections(tenant_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT secret_cleanup_outbox_connection_operation_fk
    FOREIGN KEY (tenant_id,connection_operation_id)
    REFERENCES connection_operations(tenant_id,id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION app.track_client_routing_secret_cleanup()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
  INSERT INTO secret_cleanup_outbox(
    tenant_id,routing_integration_id,cleanup_kind,secret_reference
  ) VALUES (
    NEW.tenant_id,NEW.id,'ROUTING_INTEGRATION_SECRET',NEW.secret_reference
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_routing_integration_secret_stage
  ON client_routing_integrations;
CREATE TRIGGER client_routing_integration_secret_stage
AFTER INSERT ON client_routing_integrations
FOR EACH ROW EXECUTE FUNCTION app.track_client_routing_secret_cleanup();

INSERT INTO secret_cleanup_outbox(
  tenant_id,routing_integration_id,cleanup_kind,secret_reference
)
SELECT tenant_id,id,'ROUTING_INTEGRATION_SECRET',secret_reference
FROM client_routing_integrations
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION app.expire_secret_provisioning_stages()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE candidate record;
BEGIN
  FOR candidate IN
    SELECT operation.id,operation.tenant_id,operation.connection_id,
           operation.operation_type,operation.requested_by_id,operation.request_id
      FROM connection_operations operation
     WHERE operation.state='STAGED'
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

REVOKE ALL ON FUNCTION app.track_client_routing_secret_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.expire_secret_provisioning_stages() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_secret_cleanup_tasks(uuid,integer) FROM PUBLIC;
GRANT SELECT (tenant_id,id,state) ON connection_operations
  TO wasalx_secret_cleanup_executor;
GRANT SELECT (id,state) ON tenants TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,hmac_secret_reference,state) ON webhook_routes
  TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,secret_reference,state) ON connections
  TO wasalx_secret_cleanup_executor;
GRANT SELECT (tenant_id,id,state) ON client_routing_integrations
  TO wasalx_secret_cleanup_executor;
GRANT EXECUTE ON FUNCTION app.expire_secret_provisioning_stages()
  TO wasalx_secret_cleanup_executor;
GRANT EXECUTE ON FUNCTION app.claim_secret_cleanup_tasks(uuid,integer)
  TO wasalx_secret_cleanup_client;

COMMIT;
