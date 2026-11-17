-- Ticketless group-workspace batches have no Zammad ticket status to update.
-- Keep their delivery ordering in the durable outbox without inserting a
-- NULL ticket identifier into the ticket-only status outbox.
CREATE OR REPLACE FUNCTION app.apply_delivery_batch_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.batch_id IS NULL OR NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state IN ('FAILED_TERMINAL','OUTCOME_UNKNOWN') THEN
    WITH blocked AS (
      UPDATE delivery_outbox AS successor
         SET state = 'BLOCKED',
             available_at = 'infinity'::timestamptz,
             safe_error = 'Blocked because an earlier article part requires recovery.',
             manual_retry_allowed = false,
             blocked_by_delivery_id = NEW.id,
             lease_id = NULL,
             lease_expires_at = NULL,
             updated_at = now()
       WHERE successor.tenant_id = NEW.tenant_id
         AND successor.batch_id = NEW.batch_id
         AND successor.batch_sequence > NEW.batch_sequence
         AND successor.state IN ('QUEUED','BLOCKED')
      RETURNING successor.tenant_id, successor.id, successor.zammad_ticket_id,
                successor.safe_error
    )
    INSERT INTO zammad_status_outbox (
      tenant_id, delivery_id, zammad_ticket_id, delivery_state, safe_error
    )
    SELECT tenant_id, id, zammad_ticket_id, 'BLOCKED', safe_error
      FROM blocked WHERE zammad_ticket_id IS NOT NULL
    ON CONFLICT (tenant_id, delivery_id) DO UPDATE
      SET delivery_state = EXCLUDED.delivery_state,
          external_message_id = NULL,
          safe_error = EXCLUDED.safe_error,
          completed_at = NULL,
          available_at = now(),
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = now();
  ELSIF NEW.state IN ('SENT','DELIVERED','READ') THEN
    WITH resumed AS (
      UPDATE delivery_outbox AS successor
         SET state = 'QUEUED',
             available_at = now(),
             safe_error = NULL,
             manual_retry_allowed = false,
             blocked_by_delivery_id = NULL,
             lease_id = NULL,
             lease_expires_at = NULL,
             updated_at = now()
       WHERE successor.tenant_id = NEW.tenant_id
         AND successor.batch_id = NEW.batch_id
         AND successor.batch_sequence = NEW.batch_sequence + 1
         AND successor.state IN ('QUEUED','BLOCKED')
      RETURNING successor.tenant_id, successor.id, successor.zammad_ticket_id
    )
    INSERT INTO zammad_status_outbox (
      tenant_id, delivery_id, zammad_ticket_id, delivery_state
    )
    SELECT tenant_id, id, zammad_ticket_id, 'QUEUED'
      FROM resumed WHERE zammad_ticket_id IS NOT NULL
    ON CONFLICT (tenant_id, delivery_id) DO UPDATE
      SET delivery_state = EXCLUDED.delivery_state,
          external_message_id = NULL,
          safe_error = NULL,
          completed_at = NULL,
          available_at = now(),
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.apply_delivery_batch_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_delivery_batch_transition() TO wasalx_app;
