CREATE INDEX bot_conversations_tenant_activity_page_idx
  ON bot_conversations (tenant_id,last_activity_at DESC,id DESC);

CREATE INDEX bot_conversation_events_timeline_idx
  ON bot_conversation_events (tenant_id,conversation_id,created_at DESC);

CREATE INDEX bot_handoff_jobs_history_idx
  ON bot_handoff_jobs (tenant_id,conversation_id,created_at DESC);
