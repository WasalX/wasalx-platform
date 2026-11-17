-- Keep the observed native close durable when external effects need recovery.
ALTER TABLE zammad_ticket_state_events
  DROP CONSTRAINT zammad_ticket_state_events_processing_state_check,
  ADD CONSTRAINT zammad_ticket_state_events_processing_state_check
    CHECK (processing_state IN ('ACCEPTED','APPLIED','IGNORED_STALE','NO_CORRELATION','BLOCKED_EFFECTS'));
