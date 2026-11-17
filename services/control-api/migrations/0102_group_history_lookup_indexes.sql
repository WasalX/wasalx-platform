-- wasalx:non-transactional
-- Exact ticket jumps, group ticket pages, and the mention picker must stay
-- index-backed as opted-in group histories grow.
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_links_ticket_context_idx
  ON message_links (tenant_id,zammad_ticket_id,created_at,id);

-- wasalx:statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_links_group_timeline_idx
  ON message_links (tenant_id,connection_id,created_at DESC,id DESC)
  INCLUDE (external_message_id,zammad_ticket_id,zammad_article_id);

-- wasalx:statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS normalized_messages_group_participant_idx
  ON normalized_messages (
    tenant_id,connection_id,external_group_id,external_participant_id,
    provider_timestamp DESC,id DESC
  )
  WHERE history_captured_at IS NOT NULL AND NOT from_me;
