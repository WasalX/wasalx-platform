BEGIN;

-- The invoker batch trigger runs under the sealed transition executor when
-- a signed direct identity edge cancels an unattempted batch. ON CONFLICT reads
-- these EXCLUDED columns and therefore requires their exact SELECT privileges.
-- Tenant RLS, existing write grants and executor membership remain unchanged.
GRANT SELECT(delivery_state,safe_error) ON public.zammad_status_outbox
 TO wasalx_meta_transition_executor;

COMMIT;
