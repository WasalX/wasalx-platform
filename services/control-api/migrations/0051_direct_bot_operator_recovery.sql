ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN ('CREATE','CLONE','ACTIVATE','ASSIGN','CONVERSATION_COMMAND'));

ALTER TABLE bot_handoff_jobs DROP CONSTRAINT bot_handoff_jobs_tenant_id_conversation_id_key;
CREATE UNIQUE INDEX bot_handoff_jobs_one_active
  ON bot_handoff_jobs (tenant_id,conversation_id)
  WHERE state NOT IN ('SUCCEEDED','FAILED_TERMINAL');
