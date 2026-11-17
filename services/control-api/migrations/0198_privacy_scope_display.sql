-- Friendly target readback only; native scope_value remains worker/hold SSOT.
ALTER TABLE privacy_requests ADD COLUMN scope_display text CHECK (scope_display IS NULL OR char_length(scope_display) <= 512);
ALTER TABLE privacy_legal_holds ADD COLUMN scope_display text CHECK (scope_display IS NULL OR char_length(scope_display) <= 512);
-- Historical native IDs cannot be safely guessed as ticket numbers/customer identities.

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check CHECK (action IN (
  'CREATE','CLONE','ACTIVATE','ASSIGN','ASSIGNMENT_STATE','ASSIGNMENT_ATTRIBUTION',
  'CONVERSATION_COMMAND','ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE',
  'GROUP_WORKSPACE_DEFAULTS','GROUP_WORKSPACE_CAPTURE','GROUP_WORKSPACE_GRANT','GROUP_WORKSPACE_REVOKE',
  'GROUP_BINDING_SAVE','GROUP_BINDING_TOGGLE','DELIVERY_RETRY','DELIVERY_STOP_RETRY',
  'WAHA_OUTBOUND_TENANT_CONTROL','WAHA_OUTBOUND_CONNECTION_POLICY','PRIVACY_REQUEST_RETRY','TICKET_EVENT_BIND','PRIVACY_EXPORT_CREATE','PRIVACY_DELETE_CREATE','PRIVACY_HOLD_CREATE'
));
