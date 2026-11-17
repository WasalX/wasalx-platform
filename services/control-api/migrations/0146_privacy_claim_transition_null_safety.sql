-- Polymorphic rows have either status or state, never both.
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
    COALESCE(new_row->>'status'='PROCESSING' AND old_row->>'status'<>'PROCESSING',false)
    OR COALESCE(new_row->>'state'='RUNNING' AND old_row->>'state'<>'RUNNING',false)
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
