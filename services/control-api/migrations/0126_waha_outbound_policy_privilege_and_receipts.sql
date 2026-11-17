-- Migration 0124 added this least-privilege column after the original grant.
-- Grant only the new write surface required by the tenant policy mutation.
GRANT UPDATE (allow_human_group_workspace_initiation)
  ON public.waha_outbound_connection_policies TO wasalx_app;

-- Reuse the tenant-scoped operation receipt table for replay-safe settings
-- changes instead of introducing a second idempotency mechanism.
ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN (
    'CREATE','CLONE','ACTIVATE','ASSIGN','ASSIGNMENT_STATE','ASSIGNMENT_ATTRIBUTION',
    'CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE',
    'GROUP_WORKSPACE_DEFAULTS','GROUP_WORKSPACE_CAPTURE','GROUP_WORKSPACE_GRANT','GROUP_WORKSPACE_REVOKE',
    'GROUP_BINDING_SAVE','GROUP_BINDING_TOGGLE','DELIVERY_RETRY',
    'WAHA_OUTBOUND_TENANT_CONTROL','WAHA_OUTBOUND_CONNECTION_POLICY'
  ));
