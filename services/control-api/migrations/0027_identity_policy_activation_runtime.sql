-- Identity-policy activation is isolated from the tenant API. A dedicated
-- provisioning identity can read only one REQUESTED version at a time and can
-- activate it only through the already fenced activation function.

-- A shared mailer still uses the tenant-scoped claim/complete/fail functions
-- from migration 0019. This discovery function reveals only tenant UUIDs that
-- currently have eligible work; it never returns recipients or ciphertext.
CREATE OR REPLACE FUNCTION app.pending_invitation_email_tenants(
  batch_size integer DEFAULT 25
)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  IF batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid invitation tenant discovery' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  SELECT job.tenant_id
    FROM tenant_invitation_email_outbox job
    JOIN tenant_invitations invitation
      ON invitation.tenant_id=job.tenant_id AND invitation.id=job.invitation_id
   WHERE invitation.state='PENDING'
     AND invitation.expires_at>now()
     AND (
       (job.state IN ('PENDING','FAILED_RETRYABLE') AND job.available_at<=now())
       OR (job.state='SENDING' AND job.lease_expires_at<now())
     )
   GROUP BY job.tenant_id
   ORDER BY min(job.available_at),job.tenant_id
   LIMIT batch_size;
END;
$$;

ALTER FUNCTION app.pending_invitation_email_tenants(integer)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.pending_invitation_email_tenants(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.pending_invitation_email_tenants(integer)
  FROM wasalx_app,wasalx_provisioner,wasalx_provisioning_client,
       wasalx_support_client;
GRANT EXECUTE ON FUNCTION app.pending_invitation_email_tenants(integer)
  TO wasalx_invitation_mailer;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wasalx_invitation_mailer',current_database());
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_identity_policy_activator') THEN
    CREATE ROLE wasalx_identity_policy_activator NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_identity_policy_activator NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app.requested_tenant_identity_policy(
  tenant_id_value uuid,
  expected_version_value bigint
)
RETURNS TABLE (
  tenant_id uuid,
  version bigint,
  sso_enforcement_state text,
  sso_provider_name text,
  sso_issuer text,
  sso_email_domains text[],
  mfa_required_roles text[],
  session_timeout_minutes integer,
  privileged_reauth_minutes integer,
  support_access_requires_approval boolean,
  security_policy_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
BEGIN
  IF tenant_id_value IS NULL OR expected_version_value IS NULL OR expected_version_value < 1 THEN
    RAISE EXCEPTION 'identity policy request is invalid' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT settings.tenant_id,settings.version,settings.sso_enforcement_state,
         settings.sso_provider_name,settings.sso_issuer,settings.sso_email_domains,
         settings.mfa_required_roles,settings.session_timeout_minutes,
         settings.privileged_reauth_minutes,settings.support_access_requires_approval,
         settings.security_policy_state
    FROM tenant_settings settings
    JOIN tenants tenant ON tenant.id=settings.tenant_id
   WHERE settings.tenant_id=tenant_id_value
     AND settings.version=expected_version_value
     AND settings.security_policy_state='REQUESTED'
     AND tenant.state IN ('ACTIVE','PROVISIONING')
   FOR UPDATE OF settings,tenant;
END;
$$;

ALTER FUNCTION app.requested_tenant_identity_policy(uuid,bigint)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.requested_tenant_identity_policy(uuid,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.requested_tenant_identity_policy(uuid,bigint)
  FROM wasalx_app,wasalx_provisioner,wasalx_provisioning_client,
       wasalx_invitation_mailer,wasalx_support_client;

GRANT USAGE ON SCHEMA app TO wasalx_identity_policy_activator;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wasalx_identity_policy_activator',current_database());
END
$$;
GRANT EXECUTE ON FUNCTION app.requested_tenant_identity_policy(uuid,bigint)
  TO wasalx_identity_policy_activator;
GRANT EXECUTE ON FUNCTION app.activate_tenant_identity_policy(uuid,bigint,text)
  TO wasalx_identity_policy_activator;

-- Reassert the activation boundary after adding the new identity. Ordinary
-- application, support, invitation, and connector identities remain denied.
REVOKE ALL ON FUNCTION app.activate_tenant_identity_policy(uuid,bigint,text)
  FROM PUBLIC,wasalx_app,wasalx_provisioner,wasalx_invitation_mailer,
       wasalx_support_client;
