ALTER TABLE bot_conversation_events
  DROP CONSTRAINT bot_conversation_events_event_kind_check;

ALTER TABLE bot_conversation_events
  ADD CONSTRAINT bot_conversation_events_event_kind_check CHECK (event_kind IN (
    'STARTED','MESSAGE','CHOICE','LOCATION','ACTION_SUCCEEDED','ACTION_FAILED',
    'ACTION_OUTCOME_UNKNOWN','ACTION_RETRY_REQUESTED',
    'HANDOFF_REQUESTED','HANDOFF_COMPLETED','RESUMED','RESOLVED'
  ));
