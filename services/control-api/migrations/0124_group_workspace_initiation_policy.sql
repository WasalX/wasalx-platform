-- Human-authored ticketless group notifications may initiate a conversation
-- only when a tenant administrator explicitly enables that behavior for the
-- exact WAHA connection. All kill switches, destination checks, token buckets,
-- minimum spacing, and idempotency fencing remain in the canonical authorizer.
ALTER TABLE public.waha_outbound_connection_policies
  ADD COLUMN allow_human_group_workspace_initiation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.waha_outbound_connection_policies.allow_human_group_workspace_initiation IS
  'Allows only GROUP_WORKSPACE deliveries to bypass the inbound response window; all other WAHA outbound safety controls still apply.';

-- Keep one authorization implementation rather than copying its security-
-- definer body into another migration. Fail closed if the pinned predecessor
-- no longer has the source-verified condition this migration is designed for.
DO $migration$
DECLARE
  definition text;
  previous_condition constant text := 'AND delivery_row.group_workspace_group_id IS NULL';
  next_condition constant text := 'AND (delivery_row.group_workspace_group_id IS NULL
       OR policy_row.allow_human_group_workspace_initiation IS DISTINCT FROM true)';
BEGIN
  SELECT pg_get_functiondef('app.authorize_waha_outbound_send(uuid)'::regprocedure)
    INTO definition;
  IF definition IS NULL OR strpos(definition,previous_condition)=0 THEN
    RAISE EXCEPTION 'Pinned WAHA authorization function is incompatible with migration 0124';
  END IF;
  IF strpos(definition,next_condition)>0 THEN
    RAISE EXCEPTION 'WAHA group-workspace initiation policy was unexpectedly already installed';
  END IF;
  EXECUTE replace(definition,previous_condition,next_condition);
END;
$migration$;

REVOKE ALL ON FUNCTION app.authorize_waha_outbound_send(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.authorize_waha_outbound_send(uuid) TO wasalx_app;
