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
    'NON_RETRYABLE_REVIEW',
    'GROUP_ACTION_OUTCOME_UNKNOWN'
  )),
  ADD COLUMN group_action_execution_id uuid,
  ADD CONSTRAINT quarantine_group_action_execution_fk
    FOREIGN KEY (tenant_id,group_action_execution_id)
    REFERENCES group_action_executions(tenant_id,id) ON DELETE CASCADE,
  ADD CONSTRAINT quarantine_group_action_source_check CHECK (
    (group_action_execution_id IS NULL AND reason_code<>'GROUP_ACTION_OUTCOME_UNKNOWN')
    OR (
      group_action_execution_id IS NOT NULL
      AND source_kind='INBOUND'
      AND reason_code='GROUP_ACTION_OUTCOME_UNKNOWN'
      AND source_event_inbox_id IS NOT NULL
      AND delivery_id IS NULL
    )
  );

DROP INDEX quarantine_event_once_idx;
CREATE UNIQUE INDEX quarantine_event_once_idx
  ON quarantine_records (tenant_id,source_event_inbox_id)
  WHERE source_event_inbox_id IS NOT NULL
    AND group_action_execution_id IS NULL;
CREATE UNIQUE INDEX quarantine_group_action_once_idx
  ON quarantine_records (tenant_id,group_action_execution_id)
  WHERE group_action_execution_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.open_group_action_operator_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
DECLARE
  event_connection_id uuid;
  binding_id uuid;
BEGIN
  SELECT event.connection_id,binding.id
    INTO event_connection_id,binding_id
    FROM event_inbox event
    LEFT JOIN normalized_messages message
      ON message.tenant_id=event.tenant_id
     AND message.event_inbox_id=event.id
    LEFT JOIN whatsapp_groups group_record
      ON group_record.tenant_id=message.tenant_id
     AND group_record.connection_id=message.connection_id
     AND group_record.external_group_id=message.external_group_id
    LEFT JOIN group_bindings binding
      ON binding.tenant_id=group_record.tenant_id
     AND binding.whatsapp_group_id=group_record.id
   WHERE event.tenant_id=NEW.tenant_id
     AND event.id=NEW.event_inbox_id
   LIMIT 1;

  INSERT INTO quarantine_records
    (tenant_id,source_kind,reason_code,state,connection_id,group_binding_id,
     source_event_inbox_id,group_action_execution_id,safe_summary,safe_metadata)
  VALUES
    (NEW.tenant_id,'INBOUND','GROUP_ACTION_OUTCOME_UNKNOWN','OPEN',event_connection_id,binding_id,
     NEW.event_inbox_id,NEW.id,
     'External action acceptance could not be confirmed; no retry is scheduled',
     jsonb_build_object(
       'action_key',NEW.action_key,
       'attempt_count',NEW.attempts
     ))
  ON CONFLICT (tenant_id,group_action_execution_id)
    WHERE group_action_execution_id IS NOT NULL
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
END
$$;

CREATE TRIGGER group_action_operator_review
AFTER UPDATE OF state ON group_action_executions
FOR EACH ROW
WHEN (NEW.state='OUTCOME_UNKNOWN' AND OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION app.open_group_action_operator_review();

INSERT INTO quarantine_records
  (tenant_id,source_kind,reason_code,state,connection_id,group_binding_id,
   source_event_inbox_id,group_action_execution_id,safe_summary,safe_metadata)
SELECT execution.tenant_id,'INBOUND','GROUP_ACTION_OUTCOME_UNKNOWN','OPEN',event.connection_id,binding.id,
       execution.event_inbox_id,execution.id,
       'External action acceptance could not be confirmed; no retry is scheduled',
       jsonb_build_object('action_key',execution.action_key,'attempt_count',execution.attempts)
  FROM group_action_executions execution
  JOIN event_inbox event
    ON event.tenant_id=execution.tenant_id
   AND event.id=execution.event_inbox_id
  LEFT JOIN normalized_messages message
    ON message.tenant_id=event.tenant_id
   AND message.event_inbox_id=event.id
  LEFT JOIN whatsapp_groups group_record
    ON group_record.tenant_id=message.tenant_id
   AND group_record.connection_id=message.connection_id
   AND group_record.external_group_id=message.external_group_id
  LEFT JOIN group_bindings binding
    ON binding.tenant_id=group_record.tenant_id
   AND binding.whatsapp_group_id=group_record.id
 WHERE execution.state='OUTCOME_UNKNOWN'
ON CONFLICT (tenant_id,group_action_execution_id)
  WHERE group_action_execution_id IS NOT NULL
DO NOTHING;

REVOKE ALL ON FUNCTION app.open_group_action_operator_review() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.open_group_action_operator_review() TO wasalx_app;
