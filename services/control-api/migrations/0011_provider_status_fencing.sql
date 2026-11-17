-- Provider status webhooks are asynchronous and can arrive after a newer
-- lifecycle command. Keep a durable observation fence on the singular active
-- provider-session generation so an old event cannot revive a paused or
-- revoked connection.
ALTER TABLE provider_sessions
  ADD COLUMN last_provider_status_at timestamptz;

CREATE INDEX provider_sessions_status_fence_idx
  ON provider_sessions (tenant_id, connection_id, last_provider_status_at DESC)
  WHERE ownership_state = 'ACTIVE';

-- Repair privileges for databases where migration 0007 was applied before
-- its explicit PUBLIC revocations were added.
REVOKE ALL ON FUNCTION app.claim_connection_operations(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_connection_operation(uuid, uuid, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_connection_operation(uuid, uuid, bigint, boolean, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.acquire_provider_session_lease(uuid, text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.renew_provider_session_lease(uuid, text, bigint, interval) FROM PUBLIC;
