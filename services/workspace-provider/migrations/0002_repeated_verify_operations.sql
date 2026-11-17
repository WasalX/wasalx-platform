-- A tenant provisioning operation legitimately performs a separate verified
-- readback after multiple ordered steps, and suspension/resumption reuse the
-- durable control-plane operation identity with newer fences. The primary key
-- on (tenant_id,idempotency_key) is the replay boundary; the legacy uniqueness
-- constraint on (tenant_id,operation_id,action) incorrectly collapsed these
-- distinct, fenced provider observations.

ALTER TABLE workspace_provider.operations
  DROP CONSTRAINT IF EXISTS operations_tenant_id_operation_id_action_key;

CREATE INDEX IF NOT EXISTS workspace_provider_operations_identity_idx
  ON workspace_provider.operations (tenant_id, operation_id, action, fencing_token);

ALTER TABLE workspace_provider.operations
  DROP CONSTRAINT IF EXISTS operations_action_check;
ALTER TABLE workspace_provider.operations
  ADD CONSTRAINT operations_action_check
    CHECK (action IN ('identity','database','search','storage','verify','suspend','resume'));
