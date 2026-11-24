-- The inbound message owns the deduplication marker, so it follows existing retention.
ALTER TABLE normalized_messages ADD COLUMN agent_reply_signal_claimed_at timestamptz;
