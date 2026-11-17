ALTER TABLE privacy_job_targets
  DROP CONSTRAINT privacy_job_targets_target_type_check,
  ADD CONSTRAINT privacy_job_targets_target_type_check CHECK (target_type IN (
    'ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT',
    'NORMALIZED_MESSAGE','DELIVERY'
  ));

CREATE OR REPLACE FUNCTION app.webhook_event_id_sha256(
  tenant_value uuid,
  connection_value uuid,
  provider_value text,
  provider_event_value text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path=pg_catalog,public,app
AS $$
  SELECT encode(digest(
    'wasalx-webhook-event'||chr(31)||tenant_value::text||chr(31)||
    connection_value::text||chr(31)||provider_value||chr(31)||provider_event_value,
    'sha256'
  ),'hex')
$$;

ALTER TABLE event_inbox ADD COLUMN provider_event_id_sha256 text;
UPDATE event_inbox
   SET provider_event_id_sha256=app.webhook_event_id_sha256(
     tenant_id,connection_id,provider,provider_event_id
   );
ALTER TABLE event_inbox
  ALTER COLUMN provider_event_id_sha256 SET NOT NULL,
  ADD CONSTRAINT event_inbox_provider_event_digest_check
    CHECK (provider_event_id_sha256~'^[0-9a-f]{64}$'),
  ADD CONSTRAINT event_inbox_provider_event_digest_unique
    UNIQUE (provider,connection_id,provider_event_id_sha256);

CREATE OR REPLACE FUNCTION app.preserve_webhook_event_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.provider_event_id_sha256:=app.webhook_event_id_sha256(
      NEW.tenant_id,NEW.connection_id,NEW.provider,NEW.provider_event_id
    );
    RETURN NEW;
  END IF;
  IF NEW.provider_event_id_sha256 IS DISTINCT FROM OLD.provider_event_id_sha256 THEN
    RAISE EXCEPTION 'webhook event digest is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'webhook event route identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     AND NOT (
       (NEW.status='REDACTED' OR NEW.payload->>'redacted'='true')
       AND NEW.provider_event_id='redacted:'||OLD.provider_event_id_sha256
     ) THEN
    RAISE EXCEPTION 'webhook event identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_inbox_provider_event_identity
BEFORE INSERT OR UPDATE OF tenant_id,connection_id,provider,provider_event_id,provider_event_id_sha256 ON event_inbox
FOR EACH ROW EXECUTE FUNCTION app.preserve_webhook_event_identity();

CREATE OR REPLACE FUNCTION app.delivery_external_message_sha256(
  tenant_value uuid,
  connection_value uuid,
  external_message_value text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path=pg_catalog,public,app
AS $$
  SELECT encode(digest(
    'wasalx-delivery-message'||chr(31)||tenant_value::text||chr(31)||
    connection_value::text||chr(31)||external_message_value,
    'sha256'
  ),'hex')
$$;

ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_one_route,
  DROP CONSTRAINT delivery_outbox_origin_shape,
  DROP CONSTRAINT delivery_outbox_bot_conversation_fk,
  ADD COLUMN content_redacted_at timestamptz,
  ADD COLUMN external_message_id_sha256 text
    CHECK (external_message_id_sha256 IS NULL OR external_message_id_sha256~'^[0-9a-f]{64}$'),
  ADD CONSTRAINT delivery_outbox_bot_conversation_fk
    FOREIGN KEY (tenant_id,bot_conversation_id)
    REFERENCES bot_conversations(tenant_id,id),
  ADD CONSTRAINT delivery_outbox_one_route CHECK (
    (content_redacted_at IS NULL AND (
      (group_binding_id IS NOT NULL)::integer+
      (bot_conversation_id IS NOT NULL)::integer+
      (group_workspace_group_id IS NOT NULL)::integer=1
    ))
    OR (
      content_redacted_at IS NOT NULL
      AND group_binding_id IS NULL
      AND bot_conversation_id IS NULL
      AND group_workspace_group_id IS NULL
    )
  ),
  ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
    (content_redacted_at IS NOT NULL
      AND group_binding_id IS NULL AND group_workspace_group_id IS NULL
      AND bot_conversation_id IS NULL AND external_chat_id IS NULL
      AND bot_content IS NULL AND direct_origin IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
    OR
    (content_redacted_at IS NULL
      AND delivery_origin='TICKET'
      AND (
        (zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
        OR
        (bot_conversation_id IS NOT NULL AND direct_origin='BOT'
          AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
          AND bot_content IS NOT NULL AND bot_content->>'type' IS NOT DISTINCT FROM 'media')
        OR
        (group_binding_id IS NOT NULL AND bot_conversation_id IS NULL
          AND group_workspace_group_id IS NULL AND direct_origin IS NULL
          AND external_chat_id IS NULL AND bot_content IS NULL
          AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
          AND reply_to_message_id IS NOT NULL
          AND idempotency_key LIKE 'ack:%')
      ))
    OR
    (content_redacted_at IS NULL
      AND delivery_origin='GROUP_WORKSPACE' AND group_workspace_group_id IS NOT NULL
      AND group_binding_id IS NULL AND bot_conversation_id IS NULL
      AND external_chat_id IS NULL AND bot_content IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
  ),
  ADD CONSTRAINT delivery_outbox_content_redaction_check CHECK (
    content_redacted_at IS NULL OR (
      message_body=''
      AND content_type='text/plain'
      AND cardinality(mentions)=0
      AND reply_to_message_id IS NULL
      AND bot_content IS NULL
      AND agent_display_name IS NULL
      AND agent_prefix_snapshot IS NULL
      AND agent_identity_placement_snapshot IS NULL
      AND NOT manual_retry_allowed
      AND blocked_by_delivery_id IS NULL
      AND external_message_id IS NULL
      AND lease_id IS NULL
      AND lease_expires_at IS NULL
      AND state IN ('SENT','DELIVERED','READ','FAILED_TERMINAL','PRIVACY_CANCELLED')
    )
  );

UPDATE delivery_outbox
   SET external_message_id_sha256=app.delivery_external_message_sha256(
     tenant_id,connection_id,external_message_id
   )
 WHERE external_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.preserve_delivery_external_message_digest()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
DECLARE expected_digest text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.external_message_id IS NOT NULL THEN
      NEW.external_message_id_sha256:=app.delivery_external_message_sha256(
        NEW.tenant_id,NEW.connection_id,NEW.external_message_id
      );
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.external_message_id_sha256 IS NOT NULL
     AND NEW.external_message_id_sha256 IS DISTINCT FROM OLD.external_message_id_sha256 THEN
    RAISE EXCEPTION 'delivery external-message digest is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.external_message_id IS NOT NULL THEN
    expected_digest:=app.delivery_external_message_sha256(
      NEW.tenant_id,NEW.connection_id,NEW.external_message_id
    );
    IF OLD.external_message_id_sha256 IS NOT NULL
       AND OLD.external_message_id_sha256<>expected_digest THEN
      RAISE EXCEPTION 'delivery external-message identity is immutable' USING ERRCODE='23514';
    END IF;
    NEW.external_message_id_sha256:=expected_digest;
  ELSE
    NEW.external_message_id_sha256:=OLD.external_message_id_sha256;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_external_message_digest
BEFORE INSERT OR UPDATE OF tenant_id,connection_id,external_message_id,external_message_id_sha256
ON delivery_outbox
FOR EACH ROW EXECUTE FUNCTION app.preserve_delivery_external_message_digest();

CREATE UNIQUE INDEX delivery_outbox_external_message_digest_unique
  ON delivery_outbox (tenant_id,connection_id,external_message_id_sha256)
  WHERE external_message_id_sha256 IS NOT NULL;

UPDATE delivery_outbox delivery
   SET idempotency_key='ack:'||encode(digest(
     'wasalx-ack'||chr(31)||delivery.tenant_id::text||chr(31)||
     delivery.connection_id::text||chr(31)||substring(
       delivery.idempotency_key FROM length('ack:'||delivery.connection_id::text||':')+1
     ),
     'sha256'
   ),'hex')
 WHERE delivery.idempotency_key LIKE 'ack:'||delivery.connection_id::text||':%';

ALTER TABLE delivery_receipts
  DROP CONSTRAINT delivery_receipts_external_message_id_check,
  ALTER COLUMN external_message_id DROP NOT NULL,
  ADD CONSTRAINT delivery_receipts_external_message_id_check CHECK (
    external_message_id IS NULL OR (
      length(external_message_id) BETWEEN 1 AND 512
      AND external_message_id !~ '[[:cntrl:]]'
    )
  );

DROP TRIGGER delivery_receipts_append_only ON delivery_receipts;
CREATE OR REPLACE FUNCTION app.preserve_delivery_receipt_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.external_message_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM delivery_outbox delivery
       WHERE delivery.tenant_id=NEW.tenant_id AND delivery.id=NEW.delivery_id
         AND delivery.content_redacted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'redacted delivery receipt identity cannot be restored' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE'
     AND OLD.external_message_id IS NOT NULL
     AND NEW.external_message_id IS NULL
     AND (to_jsonb(NEW)-'external_message_id')=(to_jsonb(OLD)-'external_message_id')
     AND EXISTS (
       SELECT 1 FROM delivery_outbox delivery
        WHERE delivery.tenant_id=OLD.tenant_id AND delivery.id=OLD.delivery_id
          AND delivery.content_redacted_at IS NOT NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'delivery receipt evidence is immutable' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER delivery_receipts_append_only
BEFORE INSERT OR UPDATE OR DELETE ON delivery_receipts
FOR EACH ROW EXECUTE FUNCTION app.preserve_delivery_receipt_evidence();

CREATE OR REPLACE FUNCTION app.delivery_has_active_privacy_target(delivery_value uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path=pg_catalog,public,app
AS $$
  SELECT EXISTS (
    SELECT 1 FROM delivery_outbox delivery
    JOIN privacy_jobs job ON job.tenant_id=delivery.tenant_id
    LEFT JOIN group_bindings binding
      ON binding.tenant_id=delivery.tenant_id AND binding.id=delivery.group_binding_id
    WHERE delivery.tenant_id=app.current_tenant_id() AND delivery.id=delivery_value
      AND job.job_type IN ('DELETE','RETENTION_SWEEP')
      AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
      AND (
        -- ponytail: one tenant-wide delete fence is safer and cheaper for the
        -- first-client beta; narrow it only if measured delete latency demands it.
        job.job_type='DELETE'
        OR EXISTS (
          SELECT 1 FROM privacy_job_targets target
           WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
             AND target.target_type='DELIVERY' AND target.target_id=delivery.id::text
             AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
        )
        OR (job.job_type='DELETE' AND job.scope_type='TENANT')
        OR EXISTS (
          SELECT 1 FROM privacy_job_targets target
           WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
             AND target.target_type='ZAMMAD_TICKET'
             AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
             AND (target.target_id=delivery.zammad_ticket_id OR EXISTS (
               SELECT 1 FROM delivery_ticket_links link
                WHERE link.tenant_id=delivery.tenant_id AND link.delivery_id=delivery.id
                  AND link.zammad_ticket_id=target.target_id
             ))
        )
        OR (job.job_type='DELETE' AND job.scope_type='PARTICIPANT'
          AND (job.scope_value=delivery.external_chat_id OR job.scope_value=ANY(delivery.mentions)))
        OR EXISTS (
          SELECT 1 FROM privacy_job_targets target
          JOIN normalized_messages message
            ON message.tenant_id=target.tenant_id AND message.id::text=target.target_id
          JOIN whatsapp_groups message_group
            ON message_group.tenant_id=message.tenant_id
           AND message_group.connection_id=message.connection_id
           AND message_group.external_group_id=message.external_group_id
          WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
            AND target.target_type='NORMALIZED_MESSAGE'
            AND target.state IN ('PENDING','EXTERNAL_COMPLETE')
            AND message.connection_id=delivery.connection_id
            AND message.external_message_id=delivery.reply_to_message_id
            AND message_group.id=COALESCE(delivery.group_workspace_group_id,binding.whatsapp_group_id)
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION app.lock_privacy_scoped_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
DECLARE tenant_value text;
BEGIN
  tenant_value:=NULLIF(current_setting('app.tenant_id',true),'')::uuid::text;
  IF tenant_value IS NOT NULL AND tenant_value<>'' THEN
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value,0)) THEN
      RAISE EXCEPTION 'delivery write is fenced by privacy processing' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER delivery_privacy_statement_fence
BEFORE INSERT OR UPDATE ON delivery_outbox
FOR EACH STATEMENT
EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE TRIGGER event_inbox_privacy_statement_fence BEFORE INSERT OR UPDATE ON event_inbox
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER normalized_messages_privacy_statement_fence BEFORE INSERT OR UPDATE ON normalized_messages
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER message_links_privacy_statement_fence BEFORE INSERT OR UPDATE ON message_links
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER case_correlations_privacy_statement_fence BEFORE INSERT OR UPDATE ON case_correlations
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER bot_conversations_privacy_statement_fence BEFORE INSERT OR UPDATE ON bot_conversations
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER bot_conversation_events_privacy_statement_fence BEFORE INSERT OR UPDATE ON bot_conversation_events
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER bot_action_jobs_privacy_statement_fence BEFORE INSERT OR UPDATE ON bot_action_jobs
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER group_action_executions_privacy_statement_fence BEFORE INSERT OR UPDATE ON group_action_executions
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER group_workspace_participants_privacy_statement_fence BEFORE INSERT OR UPDATE ON group_workspace_participants
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER delivery_media_privacy_statement_fence BEFORE INSERT OR UPDATE ON delivery_media
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER delivery_receipts_privacy_statement_fence BEFORE INSERT OR UPDATE ON delivery_receipts
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER delivery_ticket_links_privacy_statement_fence BEFORE INSERT OR UPDATE OR DELETE ON delivery_ticket_links
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER group_disclosure_privacy_statement_fence BEFORE INSERT OR UPDATE ON group_disclosure_deliveries
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER quarantine_privacy_statement_fence BEFORE INSERT OR UPDATE ON quarantine_records
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER bot_handoff_jobs_privacy_statement_fence BEFORE INSERT OR UPDATE ON bot_handoff_jobs
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER media_objects_privacy_statement_fence BEFORE INSERT OR UPDATE ON media_objects
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE OR REPLACE FUNCTION app.block_async_claim_during_privacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
DECLARE
  old_row jsonb:=to_jsonb(OLD);
  new_row jsonb:=to_jsonb(NEW);
  admitted_at timestamptz;
BEGIN
  IF NOT (
    (new_row->>'status'='PROCESSING' AND old_row->>'status'<>'PROCESSING')
    OR (new_row->>'state'='RUNNING' AND old_row->>'state'<>'RUNNING')
  ) THEN
    RETURN NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'event_inbox' THEN
      admitted_at:=NEW.received_at;
    WHEN 'bot_action_jobs' THEN
      SELECT COALESCE(event.received_at,NEW.created_at) INTO admitted_at
        FROM (SELECT 1) singleton
        LEFT JOIN event_inbox event
          ON event.tenant_id=NEW.tenant_id AND event.id=NEW.source_event_id;
    WHEN 'bot_handoff_jobs' THEN
      SELECT event.received_at INTO admitted_at
        FROM event_inbox event
       WHERE event.tenant_id=NEW.tenant_id AND event.id=NEW.source_event_id;
    WHEN 'group_action_executions' THEN
      SELECT event.received_at INTO admitted_at
        FROM event_inbox event
       WHERE event.tenant_id=NEW.tenant_id AND event.id=NEW.event_inbox_id;
  END CASE;

  IF admitted_at IS NULL OR EXISTS (
       SELECT 1 FROM privacy_jobs job
        WHERE job.tenant_id=(new_row->>'tenant_id')::uuid
          AND job.job_type='DELETE'
          AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
          AND job.created_at<=admitted_at
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_inbox_delete_claim_fence BEFORE UPDATE OF status ON event_inbox
FOR EACH ROW EXECUTE FUNCTION app.block_async_claim_during_privacy();
CREATE TRIGGER bot_action_jobs_delete_claim_fence BEFORE UPDATE OF state ON bot_action_jobs
FOR EACH ROW EXECUTE FUNCTION app.block_async_claim_during_privacy();
CREATE TRIGGER bot_handoff_jobs_delete_claim_fence BEFORE UPDATE OF state ON bot_handoff_jobs
FOR EACH ROW EXECUTE FUNCTION app.block_async_claim_during_privacy();
CREATE TRIGGER group_action_executions_delete_claim_fence BEFORE UPDATE OF state ON group_action_executions
FOR EACH ROW EXECUTE FUNCTION app.block_async_claim_during_privacy();

CREATE OR REPLACE FUNCTION app.prevent_redacted_delivery_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM delivery_outbox delivery
     WHERE delivery.tenant_id=NEW.tenant_id AND delivery.id=NEW.delivery_id
       AND delivery.content_redacted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'redacted delivery cannot be linked to a ticket' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_ticket_links_redaction_fence
BEFORE INSERT OR UPDATE ON delivery_ticket_links
FOR EACH ROW EXECUTE FUNCTION app.prevent_redacted_delivery_link();

CREATE OR REPLACE FUNCTION app.prevent_disclosure_external_id_resurrection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF NEW.external_message_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM delivery_outbox delivery
        WHERE delivery.tenant_id=NEW.tenant_id AND delivery.id=NEW.delivery_id
          AND delivery.content_redacted_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'redacted disclosure identity cannot be restored' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER group_disclosure_external_id_redaction_fence
BEFORE INSERT OR UPDATE ON group_disclosure_deliveries
FOR EACH ROW EXECUTE FUNCTION app.prevent_disclosure_external_id_resurrection();

CREATE OR REPLACE FUNCTION app.block_delivery_claim_during_privacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF NEW.state IN ('CLAIMED','SENDING') THEN
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||NEW.tenant_id::text,0))
       OR app.delivery_has_active_privacy_target(OLD.id) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_privacy_claim_fence
BEFORE UPDATE OF state ON delivery_outbox
FOR EACH ROW
EXECUTE FUNCTION app.block_delivery_claim_during_privacy();

CREATE OR REPLACE FUNCTION app.preserve_delivery_content_redaction()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'delivery identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.content_redacted_at IS NOT NULL
     AND NEW.content_redacted_at IS DISTINCT FROM OLD.content_redacted_at THEN
    RAISE EXCEPTION 'delivery content redaction is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_content_redaction_immutable
BEFORE UPDATE OF tenant_id,id,idempotency_key,content_redacted_at ON delivery_outbox
FOR EACH ROW
EXECUTE FUNCTION app.preserve_delivery_content_redaction();

ALTER TABLE quarantine_records
  DROP CONSTRAINT quarantine_records_reason_code_check,
  ADD CONSTRAINT quarantine_records_reason_code_check CHECK (reason_code IN (
    'IDENTIFIER_LIMIT_EXCEEDED',
    'MEDIA_MALWARE_DETECTED',
    'MEDIA_TOO_LARGE',
    'MEDIA_TYPE_UNSAFE',
    'MEDIA_DOWNLOAD_REJECTED',
    'OUTBOUND_MEDIA_REJECTED',
    'PROVIDER_DELIVERY_FAILED',
    'PROVIDER_OUTCOME_UNKNOWN',
    'NON_RETRYABLE_REVIEW',
    'GROUP_ACTION_OUTCOME_UNKNOWN'
  ));

ALTER TABLE quarantine_records
  DROP CONSTRAINT quarantine_delivery_fk,
  DROP CONSTRAINT quarantine_source_check,
  ADD CONSTRAINT quarantine_delivery_fk
    FOREIGN KEY (tenant_id,delivery_id)
    REFERENCES delivery_outbox(tenant_id,id)
    ON DELETE SET NULL (delivery_id),
  ADD CONSTRAINT quarantine_source_check CHECK (
    (source_kind='INBOUND' AND source_event_inbox_id IS NOT NULL AND delivery_id IS NULL)
    OR (
      source_kind='OUTBOUND'
      AND source_event_inbox_id IS NULL
      AND (delivery_id IS NOT NULL OR state IN ('RESOLVED','DISCARDED'))
    )
  );

CREATE OR REPLACE FUNCTION app.open_delivery_outcome_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;

  UPDATE group_disclosure_deliveries
     SET state='OUTCOME_UNKNOWN',updated_at=now()
   WHERE tenant_id=NEW.tenant_id AND delivery_id=NEW.id AND state='QUEUED';

  INSERT INTO quarantine_records
    (tenant_id,source_kind,reason_code,state,connection_id,group_binding_id,
     delivery_id,safe_summary,safe_metadata)
  VALUES
    (NEW.tenant_id,'OUTBOUND','PROVIDER_OUTCOME_UNKNOWN','OPEN',NEW.connection_id,
     NEW.group_binding_id,NEW.id,
     'Provider acceptance could not be confirmed; verify the destination before deciding the outcome',
     jsonb_build_object('attempt_count',NEW.attempts,'retry_requires_confirmation',true))
  ON CONFLICT (tenant_id,delivery_id,reason_code)
    WHERE delivery_id IS NOT NULL
  DO UPDATE SET
    state='OPEN',
    safe_summary=EXCLUDED.safe_summary,
    safe_metadata=EXCLUDED.safe_metadata,
    version=quarantine_records.version+1,
    reprocess_event_id=NULL,
    resolution_code=NULL,
    resolved_by=NULL,
    resolved_at=NULL,
    updated_at=now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_outcome_operator_review
AFTER INSERT OR UPDATE OF state ON delivery_outbox
FOR EACH ROW
WHEN (NEW.state='OUTCOME_UNKNOWN')
EXECUTE FUNCTION app.open_delivery_outcome_review();

UPDATE group_disclosure_deliveries disclosure
   SET state='OUTCOME_UNKNOWN',updated_at=now()
  FROM delivery_outbox delivery
 WHERE disclosure.tenant_id=delivery.tenant_id
   AND disclosure.delivery_id=delivery.id
   AND disclosure.state='QUEUED'
   AND delivery.state='OUTCOME_UNKNOWN';

INSERT INTO quarantine_records
  (tenant_id,source_kind,reason_code,state,connection_id,group_binding_id,
   delivery_id,safe_summary,safe_metadata)
SELECT delivery.tenant_id,'OUTBOUND','PROVIDER_OUTCOME_UNKNOWN','OPEN',delivery.connection_id,
       delivery.group_binding_id,delivery.id,
       'Provider acceptance could not be confirmed; verify the destination before deciding the outcome',
       jsonb_build_object('attempt_count',delivery.attempts,'retry_requires_confirmation',true)
  FROM delivery_outbox delivery
 WHERE delivery.state='OUTCOME_UNKNOWN'
ON CONFLICT (tenant_id,delivery_id,reason_code)
  WHERE delivery_id IS NOT NULL
DO UPDATE SET
  state='OPEN',
  safe_summary=EXCLUDED.safe_summary,
  safe_metadata=EXCLUDED.safe_metadata,
  version=quarantine_records.version+1,
  reprocess_event_id=NULL,
  resolution_code=NULL,
  resolved_by=NULL,
  resolved_at=NULL,
  updated_at=now();

REVOKE ALL ON FUNCTION app.preserve_delivery_content_redaction() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.open_delivery_outcome_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delivery_has_active_privacy_target(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.block_delivery_claim_during_privacy() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lock_privacy_scoped_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.preserve_delivery_receipt_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.block_async_claim_during_privacy() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.webhook_event_id_sha256(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.preserve_webhook_event_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delivery_external_message_sha256(uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.preserve_delivery_external_message_digest() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_redacted_delivery_link() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_disclosure_external_id_resurrection() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.open_delivery_outcome_review() TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.delivery_has_active_privacy_target(uuid) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.webhook_event_id_sha256(uuid,uuid,text,text) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.delivery_external_message_sha256(uuid,uuid,text) TO wasalx_app,wasalx_connector_worker;
GRANT DELETE ON delivery_media TO wasalx_connector_worker;
GRANT DELETE ON group_action_executions TO wasalx_connector_worker;
GRANT UPDATE (external_message_id) ON delivery_receipts TO wasalx_connector_worker;
REVOKE DELETE ON delivery_outbox FROM PUBLIC,wasalx_app,wasalx_connector_worker;
