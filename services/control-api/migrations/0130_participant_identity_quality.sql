-- Preserve the last active owner for suspended tenants too. This supersedes
-- the narrower 0129 function without modifying the already-applied migration.
CREATE OR REPLACE FUNCTION app.preserve_last_active_tenant_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
BEGIN
  IF OLD.role<>'tenant_owner' OR OLD.state<>'ACTIVE'
     OR (TG_OP='UPDATE' AND NEW.role='tenant_owner' AND NEW.state='ACTIVE') THEN
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM 1 FROM tenants WHERE id=OLD.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships
     WHERE tenant_id=OLD.tenant_id AND id<>OLD.id
       AND role='tenant_owner' AND state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'WASALX_LAST_ACTIVE_OWNER' USING ERRCODE='P0001';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

ALTER TABLE participant_identities
  ADD COLUMN display_name_quality smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT participant_identities_display_name_quality_check
    CHECK (display_name_quality BETWEEN 0 AND 3);
