DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_provisioner') THEN
    CREATE ROLE wasalx_provisioner NOLOGIN;
  END IF;
END
$$;

-- The ordinary API/worker role may read identity and provisioning metadata but
-- cannot mutate global identities, tenant lifecycle, or service credentials.
REVOKE INSERT, UPDATE, DELETE ON public.tenants FROM wasalx_app;
REVOKE INSERT, UPDATE, DELETE ON public.users FROM wasalx_app;
REVOKE INSERT, UPDATE, DELETE ON public.tenant_memberships FROM wasalx_app;
REVOKE INSERT, UPDATE, DELETE ON public.zammad_instances FROM wasalx_app;
REVOKE INSERT, UPDATE, DELETE ON public.provisioning_operations FROM wasalx_app;
REVOKE INSERT, UPDATE, DELETE ON public.secret_references FROM wasalx_app;
GRANT SELECT ON public.tenants, public.users, public.tenant_memberships,
  public.zammad_instances, public.provisioning_operations, public.secret_references TO wasalx_app;

-- Stop the broad grant from 0005 propagating to future tables. New runtime
-- tables must be granted deliberately in their owning migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE ON TABLES FROM wasalx_app;

GRANT USAGE ON SCHEMA public, app TO wasalx_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants, public.users,
  public.tenant_memberships, public.zammad_instances,
  public.provisioning_operations, public.secret_references TO wasalx_provisioner;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wasalx_provisioner;

-- Tenant-owned rows remain protected by forced RLS even for the dedicated
-- provisioner. Its caller must set app.tenant_id before tenant-scoped work.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wasalx_provisioner;
