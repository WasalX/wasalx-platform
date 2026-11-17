-- wasalx:non-transactional
-- Match historic native UUID casing without filtering away conflicting origins.
CREATE INDEX CONCURRENTLY IF NOT EXISTS delivery_outbox_group_workspace_uuid_key_idx
  ON delivery_outbox (tenant_id,lower(idempotency_key)) INCLUDE (id,idempotency_key)
  WHERE idempotency_key ~ '^group-workspace(-reaction)?:[1-9][0-9]{0,15}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';

-- wasalx:statement-break
CREATE INDEX CONCURRENTLY IF NOT EXISTS group_workspace_operation_receipts_uuid_key_idx
  ON group_workspace_operation_receipts (tenant_id,lower(idempotency_key))
  WHERE idempotency_key ~ '^group-workspace(-reaction)?:[1-9][0-9]{0,15}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
