CREATE OR REPLACE FUNCTION app.enforce_bot_action_actor_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE field_name text;
DECLARE actor_value uuid;
DECLARE new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH field_name IN ARRAY TG_ARGV LOOP
    actor_value:=NULLIF(new_row->>field_name,'')::uuid;
    IF actor_value IS NULL THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1 FROM public.tenant_memberships membership
       WHERE membership.tenant_id=NEW.tenant_id
         AND membership.user_id=actor_value AND membership.state='ACTIVE'
    ) THEN CONTINUE; END IF;
    IF TG_TABLE_NAME='tenant_memberships' AND field_name='updated_by'
       AND new_row->>'state'='ACTIVE' AND actor_value=NULLIF(new_row->>'user_id','')::uuid THEN
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'tenant actor must be an active member of its tenant'
      USING ERRCODE='23503';
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enforce_bot_action_actor_membership() FROM PUBLIC;
