BEGIN;
-- A diagnostic operation performs provider reads only; it cannot change funding
-- or connection lifecycle. No account/payer enrollment schema is introduced.
ALTER TABLE connection_operations DROP CONSTRAINT connection_operations_operation_type_check;
ALTER TABLE connection_operations ADD CONSTRAINT connection_operations_operation_type_check CHECK (
 operation_type IN ('PROVISION','START','RESTART','PAUSE','DISCONNECT','SYNC_GROUPS','SYNC_META_APP','ROTATE_META_CREDENTIAL','VERIFY_META_BILLING')
);
-- Reuse the current-tenant boolean/lock boundary without granting tenant reads or writes.
GRANT EXECUTE ON FUNCTION app.lock_current_active_tenant_for_event_admission() TO wasalx_connector_worker;
COMMIT;
