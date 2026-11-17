DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_identity_reader') THEN
    CREATE ROLE wasalx_identity_reader NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE wasalx_identity_reader NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public, app TO wasalx_identity_reader;
GRANT SELECT (id, oidc_subject, email, display_name) ON public.users TO wasalx_identity_reader;
GRANT SELECT (tenant_id, user_id, role) ON public.tenant_memberships TO wasalx_identity_reader;
GRANT SELECT (id, name, slug, state) ON public.tenants TO wasalx_identity_reader;

CREATE OR REPLACE FUNCTION app.resolve_oidc_memberships(subject_value text)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  tenant_id uuid,
  tenant_name text,
  tenant_slug text,
  tenant_state text,
  membership_role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.email, u.display_name, t.id, t.name, t.slug, t.state, m.role
    FROM public.users u
    JOIN public.tenant_memberships m ON m.user_id = u.id
    JOIN public.tenants t ON t.id = m.tenant_id
   WHERE u.oidc_subject = subject_value
     AND t.state IN ('ACTIVE','PROVISIONING')
   ORDER BY t.name, t.id
   LIMIT 100
$$;

GRANT CREATE ON SCHEMA app TO wasalx_identity_reader;
ALTER FUNCTION app.resolve_oidc_memberships(text) OWNER TO wasalx_identity_reader;
REVOKE CREATE ON SCHEMA app FROM wasalx_identity_reader;

REVOKE ALL ON FUNCTION app.resolve_oidc_memberships(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wasalx_app') THEN
    GRANT EXECUTE ON FUNCTION app.resolve_oidc_memberships(text) TO wasalx_app;
  END IF;
END
$$;
