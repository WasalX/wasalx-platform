-- Opt-in projection of accepted immutable identities. Native teams remain native-owned.
ALTER TABLE tenant_settings ADD COLUMN native_membership_sync_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE native_membership_projections (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  oidc_subject text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('tenant_owner','tenant_admin','supervisor','agent','auditor')),
  member_state text NOT NULL CHECK (member_state IN ('ACTIVE','SUSPENDED','REMOVED')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  zammad_instance_id uuid,
  native_user_id text CHECK (native_user_id ~ '^[1-9][0-9]{0,15}$'),
  requested_native_user_id text CHECK (requested_native_user_id ~ '^[1-9][0-9]{0,15}$'),
  applied_revision bigint NOT NULL DEFAULT 0 CHECK (applied_revision>=0 AND applied_revision<=revision),
  sync_state text NOT NULL DEFAULT 'PENDING' CHECK (sync_state IN ('PENDING','READY','ADOPTION_REQUIRED','CONFLICT','PROTECTED','UNAVAILABLE')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id),
  UNIQUE (tenant_id,oidc_subject),
  UNIQUE (tenant_id,native_user_id),
  FOREIGN KEY (tenant_id,zammad_instance_id) REFERENCES zammad_instances(tenant_id,id),
  CHECK ((sync_state='READY')=(applied_revision=revision))
);
ALTER TABLE native_membership_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE native_membership_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON native_membership_projections
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
-- user_id identifies the lifecycle subject, including suspended/removed members.
-- Only the membership writer may create or alter that authoritative snapshot;
-- application SQL may persist synchronization results and owner-reviewed retries.
REVOKE ALL ON native_membership_projections FROM PUBLIC;
REVOKE INSERT,UPDATE,DELETE ON native_membership_projections FROM wasalx_app;
GRANT SELECT ON native_membership_projections TO wasalx_app;
GRANT UPDATE (zammad_instance_id,native_user_id,requested_native_user_id,revision,applied_revision,sync_state,updated_at)
  ON native_membership_projections TO wasalx_app;
GRANT SELECT,INSERT,UPDATE ON native_membership_projections TO wasalx_tenant_admin_writer;

CREATE FUNCTION app.queue_native_membership() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE member tenant_memberships%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN member:=OLD; ELSE member:=NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.role,NEW.state) IS NOT DISTINCT FROM ROW(OLD.role,OLD.state) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_settings WHERE tenant_id=member.tenant_id AND native_membership_sync_enabled) THEN
    RETURN NULL;
  END IF;
  INSERT INTO native_membership_projections (tenant_id,user_id,oidc_subject,email,display_name,role,member_state)
    SELECT member.tenant_id,u.id,u.oidc_subject,u.email,u.display_name,member.role,
      CASE WHEN TG_OP='DELETE' THEN 'REMOVED' ELSE member.state END
    FROM users u WHERE u.id=member.user_id
  ON CONFLICT (tenant_id,user_id) DO UPDATE SET role=EXCLUDED.role,member_state=EXCLUDED.member_state,
    revision=native_membership_projections.revision+1,sync_state='PENDING',updated_at=now();
  RETURN NULL;
END $$;
ALTER FUNCTION app.queue_native_membership() OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.queue_native_membership() FROM PUBLIC;
CREATE TRIGGER native_membership_lifecycle AFTER INSERT OR DELETE OR UPDATE OF role,state ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.queue_native_membership();

-- The same tenant lock is taken by opt-in before reading the membership snapshot.
-- A BEFORE STATEMENT lock is not tenant-addressable; the BEFORE ROW trigger runs
-- before the AFTER trigger takes its fresh READ COMMITTED settings snapshot.
CREATE FUNCTION app.lock_native_membership() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE tenant_value uuid;
BEGIN
  tenant_value:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-membership:'||tenant_value::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_membership_serialization BEFORE INSERT OR DELETE OR UPDATE OF role,state ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app.lock_native_membership();

-- Preserve the existing settings-write boundary; ordinary application SQL may
-- not update tenant_settings directly.
CREATE FUNCTION app.enable_native_membership_sync(requested_by uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tenant_value uuid:=app.current_tenant_id();
DECLARE changed integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('native-membership:'||tenant_value::text,0));
  PERFORM 1 FROM tenants WHERE id=tenant_value AND state='ACTIVE' FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=tenant_value AND user_id=requested_by AND role='tenant_owner' AND state='ACTIVE') THEN
    RAISE EXCEPTION 'Active workspace ownership is required' USING ERRCODE='42501';
  END IF;
  UPDATE tenant_settings SET native_membership_sync_enabled=true,version=version+1,updated_at=now()
    WHERE tenant_id=tenant_value AND NOT native_membership_sync_enabled;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed=0 THEN RETURN false; END IF;
  INSERT INTO native_membership_projections(tenant_id,user_id,oidc_subject,email,display_name,role,member_state)
    SELECT m.tenant_id,u.id,u.oidc_subject,u.email,u.display_name,m.role,m.state FROM tenant_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.tenant_id=tenant_value ON CONFLICT(tenant_id,user_id) DO NOTHING;
  RETURN true;
END $$;
ALTER FUNCTION app.enable_native_membership_sync(uuid) OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.enable_native_membership_sync(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enable_native_membership_sync(uuid) TO wasalx_app;

-- Discovery returns only tenant UUIDs, never identities or credentials.
CREATE FUNCTION app.pending_native_membership_tenants() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT DISTINCT tenant_id FROM native_membership_projections
   WHERE sync_state='PENDING' ORDER BY tenant_id LIMIT 25
$$;
ALTER FUNCTION app.pending_native_membership_tenants() OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.pending_native_membership_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_native_membership_tenants() TO wasalx_app;

CREATE FUNCTION app.protect_native_membership_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.user_id,NEW.oidc_subject,NEW.email) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.user_id,OLD.oidc_subject,OLD.email)
    OR (OLD.native_user_id IS NOT NULL AND NEW.native_user_id IS DISTINCT FROM OLD.native_user_id)
    OR (OLD.zammad_instance_id IS NOT NULL AND NEW.zammad_instance_id IS DISTINCT FROM OLD.zammad_instance_id)
    OR NEW.revision<OLD.revision OR NEW.applied_revision<OLD.applied_revision THEN
    RAISE EXCEPTION 'Native identity binding is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_membership_immutable BEFORE UPDATE ON native_membership_projections
  FOR EACH ROW EXECUTE FUNCTION app.protect_native_membership_identity();
