ALTER TABLE webhook_routes
  ADD COLUMN admission_opened_at timestamptz;

UPDATE webhook_routes
   SET admission_opened_at=date_trunc('second',updated_at)+interval '1 second'
 WHERE state='ACTIVE';

ALTER TABLE webhook_routes
  ALTER COLUMN admission_opened_at SET DEFAULT date_trunc('second',clock_timestamp())+interval '1 second';

ALTER TABLE webhook_routes
  ADD CONSTRAINT webhook_routes_active_admission_clock_check
  CHECK (state<>'ACTIVE' OR admission_opened_at IS NOT NULL);

CREATE OR REPLACE FUNCTION app.preserve_webhook_event_admission_time()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'webhook event admission time is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preserve_webhook_event_admission_time
BEFORE UPDATE OF received_at ON event_inbox
FOR EACH ROW EXECUTE FUNCTION app.preserve_webhook_event_admission_time();

CREATE OR REPLACE FUNCTION app.claim_connection_operations(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS SETOF connection_operations
LANGUAGE plpgsql
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

CREATE OR REPLACE FUNCTION app.queue_due_group_syncs(scan_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE inserted_count integer;
BEGIN
  IF scan_limit<1 OR scan_limit>1000 THEN
    RAISE EXCEPTION 'scan limit must be between 1 and 1000' USING ERRCODE='22023';
  END IF;

  WITH candidates AS (
    SELECT connection.tenant_id,connection.id
      FROM public.connections connection
      JOIN public.tenants tenant ON tenant.id=connection.tenant_id
     WHERE tenant.state='ACTIVE'
       AND connection.provider='WAHA'
       AND connection.state IN ('WORKING','DEGRADED')
       AND EXISTS (
         SELECT 1 FROM public.provider_sessions session
          WHERE session.tenant_id=connection.tenant_id
            AND session.connection_id=connection.id
            AND session.ownership_state='ACTIVE'
            AND session.state='WORKING'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.connection_operations pending
          WHERE pending.tenant_id=connection.tenant_id
            AND pending.connection_id=connection.id
            AND pending.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.connection_operations recent
          WHERE recent.tenant_id=connection.tenant_id
            AND recent.connection_id=connection.id
            AND recent.operation_type='SYNC_GROUPS'
            AND recent.state='SUCCEEDED'
            AND recent.completed_at>=now()-interval '15 minutes'
       )
     ORDER BY (
       SELECT max(completed_at) FROM public.connection_operations previous
        WHERE previous.tenant_id=connection.tenant_id
          AND previous.connection_id=connection.id
          AND previous.operation_type='SYNC_GROUPS'
          AND previous.state='SUCCEEDED'
     ) NULLS FIRST,connection.id
     LIMIT scan_limit
  )
  INSERT INTO public.connection_operations (
    tenant_id,connection_id,operation_type,idempotency_key,payload,
    requested_by_type,requested_by_id,request_id
  )
  SELECT candidate.tenant_id,candidate.id,'SYNC_GROUPS',
         'automatic-group-sync:'||candidate.id||':'||
           floor(extract(epoch FROM statement_timestamp())/900)::bigint,
         jsonb_build_object('automatic',true,'reason','PERIODIC_RECONCILIATION'),
         'SYSTEM','connector-scheduler',
         'automatic-group-sync:'||candidate.id||':'||
           floor(extract(epoch FROM statement_timestamp())/900)::bigint
    FROM candidates candidate
  ON CONFLICT (tenant_id,idempotency_key) DO NOTHING;

  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION app.queue_due_group_syncs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_due_group_syncs(integer) TO wasalx_app,wasalx_connector_worker;

-- Bot-media uploads participate in the same tenant privacy fence as message
-- media. The media_objects fence was introduced by migration 0137.
CREATE TRIGGER bot_media_assets_privacy_statement_fence
BEFORE INSERT OR UPDATE ON bot_media_assets
FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE OR REPLACE FUNCTION app.guard_privacy_target_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE target_job_id uuid:=COALESCE(NEW.job_id,OLD.job_id);
DECLARE target_tenant_id uuid:=COALESCE(NEW.tenant_id,OLD.tenant_id);
BEGIN
  IF EXISTS (
    SELECT 1 FROM privacy_jobs job
     WHERE job.tenant_id=target_tenant_id AND job.id=target_job_id
       AND job.stage<>'DISCOVER'
  ) THEN
    RAISE EXCEPTION 'privacy target membership is frozen after discovery'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.guard_privacy_target_membership() FROM PUBLIC;
CREATE TRIGGER privacy_target_membership_guard
BEFORE INSERT OR DELETE ON privacy_job_targets
FOR EACH ROW EXECUTE FUNCTION app.guard_privacy_target_membership();

CREATE OR REPLACE FUNCTION app.purge_expired_unmatched_events(
  retain_for interval,
  cutoff_at timestamptz
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE affected bigint;
BEGIN
  IF retain_for<interval '1 hour' OR retain_for>interval '24 hours'
     OR cutoff_at IS NULL THEN
    RAISE EXCEPTION 'invalid unmatched diagnostic retention cutoff'
      USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM privacy_legal_holds
     WHERE tenant_id=app.current_tenant_id() AND state='ACTIVE'
       AND (expires_at IS NULL OR expires_at>clock_timestamp())
       AND scope_type='TENANT'
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM event_inbox inbox
   WHERE inbox.tenant_id=app.current_tenant_id()
     AND inbox.status IN ('UNMATCHED','IGNORED','DUPLICATE','REDACTED')
     AND COALESCE(inbox.processed_at,inbox.received_at)<=cutoff_at-retain_for
     AND NOT EXISTS (
       SELECT 1 FROM normalized_messages message
        WHERE message.tenant_id=inbox.tenant_id
          AND message.event_inbox_id=inbox.id
     );
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_unmatched_events(interval,timestamptz) TO wasalx_app,wasalx_connector_worker;

ALTER TABLE privacy_jobs
  ADD COLUMN unmatched_diagnostic_hours_snapshot integer CHECK (
    unmatched_diagnostic_hours_snapshot BETWEEN 1 AND 24
  );

UPDATE privacy_jobs job
   SET unmatched_diagnostic_hours_snapshot=policy.unmatched_diagnostic_hours
  FROM retention_policies policy
 WHERE job.tenant_id=policy.tenant_id
   AND job.job_type='RETENTION_SWEEP'
   AND job.unmatched_diagnostic_hours_snapshot IS NULL;

ALTER TABLE privacy_jobs
  ADD CONSTRAINT privacy_jobs_unmatched_snapshot_check CHECK (
    (job_type='RETENTION_SWEEP' AND unmatched_diagnostic_hours_snapshot IS NOT NULL)
    OR (job_type<>'RETENTION_SWEEP' AND unmatched_diagnostic_hours_snapshot IS NULL)
  );

CREATE OR REPLACE FUNCTION app.preserve_privacy_cutoff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (NEW.unmatched_diagnostic_hours_snapshot IS DISTINCT FROM OLD.unmatched_diagnostic_hours_snapshot
       AND (OLD.stage<>'DISCOVER' OR EXISTS (
         SELECT 1 FROM privacy_job_targets target
          WHERE target.tenant_id=OLD.tenant_id AND target.job_id=OLD.id
       ))) THEN
    RAISE EXCEPTION 'privacy cutoff is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.preserve_privacy_cutoff() FROM PUBLIC;
CREATE TRIGGER privacy_jobs_preserve_cutoff
BEFORE UPDATE OF created_at,unmatched_diagnostic_hours_snapshot ON privacy_jobs
FOR EACH ROW EXECUTE FUNCTION app.preserve_privacy_cutoff();

CREATE OR REPLACE FUNCTION app.preserve_async_source_admission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'async source admission is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.preserve_async_source_admission() FROM PUBLIC;
CREATE TRIGGER bot_action_jobs_preserve_source_admission
BEFORE UPDATE OF source_event_id,created_at ON bot_action_jobs
FOR EACH ROW EXECUTE FUNCTION app.preserve_async_source_admission();
CREATE TRIGGER bot_handoff_jobs_preserve_source_admission
BEFORE UPDATE OF source_event_id,created_at ON bot_handoff_jobs
FOR EACH ROW EXECUTE FUNCTION app.preserve_async_source_admission();

-- Let only pre-cutoff work drain while targets are still being discovered.
-- Once target membership is frozen, no asynchronous work may race external
-- deletion for either deletion or retention jobs.
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
          AND job.job_type IN ('DELETE','RETENTION_SWEEP')
          AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
          AND (job.stage<>'DISCOVER' OR job.created_at<admitted_at)
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.block_async_claim_during_privacy() FROM PUBLIC;
