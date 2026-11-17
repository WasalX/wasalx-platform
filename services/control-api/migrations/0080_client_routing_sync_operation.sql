ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN ('CREATE','CLONE','ACTIVATE','ASSIGN','CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC'));
