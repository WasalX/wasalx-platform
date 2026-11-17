-- Migration 0005 installs broad default privileges for ordinary tenant-owned
-- tables. The invitation outbox was created later, so it inherited table-wide
-- SELECT/INSERT/UPDATE/DELETE before migration 0019 added its intended column
-- grants. Reset that inherited ACL and grant only what the tenant API needs.
-- The dedicated mailer ACL and tenant-scoped claim/complete/fail functions are
-- intentionally unchanged.

-- The invitation record inherited the same table-wide defaults. The tenant
-- API needs the invitation lifecycle fields, but it never reads token hashes
-- or creation idempotency evidence. Acceptance continues through the
-- SECURITY DEFINER function owned by wasalx_tenant_admin_writer.
REVOKE ALL PRIVILEGES ON TABLE public.tenant_invitations
  FROM PUBLIC,wasalx_app;

GRANT SELECT (
  id,tenant_id,email,display_name,role,state,expires_at,invited_by,
  accepted_by,accepted_at,revoked_by,revoked_at,version,created_at,updated_at
) ON TABLE public.tenant_invitations TO wasalx_app;

GRANT INSERT (
  tenant_id,email,display_name,role,token_hash,expires_at,invited_by,
  create_idempotency_key,create_request_sha256
) ON TABLE public.tenant_invitations TO wasalx_app;

GRANT UPDATE (
  token_hash,state,expires_at,revoked_by,revoked_at,version,updated_at
) ON TABLE public.tenant_invitations TO wasalx_app;

REVOKE SELECT (token_hash,create_idempotency_key,create_request_sha256)
  ON TABLE public.tenant_invitations FROM PUBLIC,wasalx_app;

REVOKE ALL PRIVILEGES ON TABLE public.tenant_invitation_email_outbox
  FROM PUBLIC,wasalx_app;

GRANT SELECT (
  id,tenant_id,invitation_id,action,idempotency_key,request_sha256,
  state,attempts,available_at,provider_message_id,error_code,safe_error,
  sent_at,created_at,updated_at
) ON TABLE public.tenant_invitation_email_outbox TO wasalx_app;

GRANT INSERT (
  tenant_id,invitation_id,action,recipient_email,token_ciphertext,
  token_key_version,idempotency_key,request_sha256
) ON TABLE public.tenant_invitation_email_outbox TO wasalx_app;

GRANT UPDATE (state,lease_id,lease_expires_at,updated_at)
  ON TABLE public.tenant_invitation_email_outbox TO wasalx_app;

-- These values are delivery-worker inputs, not tenant-API read models. Keep an
-- explicit denial next to the whitelist so later grant refactors fail closed.
REVOKE SELECT (recipient_email,token_ciphertext,token_key_version)
  ON TABLE public.tenant_invitation_email_outbox FROM PUBLIC,wasalx_app;
