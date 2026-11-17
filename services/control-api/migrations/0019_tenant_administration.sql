-- Tenant administration is deliberately separated from platform provisioning.
-- The ordinary runtime role can administer only the tenant in app.tenant_id;
-- global identity and tenant lifecycle writes remain unavailable.

ALTER TABLE tenant_memberships
  ADD COLUMN state text NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE','SUSPENDED')),
  ADD COLUMN updated_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  accent_color text NOT NULL DEFAULT '#5B5BD6'
    CHECK (accent_color ~ '^#[0-9A-F]{6}$'),
  default_theme text NOT NULL DEFAULT 'SYSTEM'
    CHECK (default_theme IN ('LIGHT','DARK','SYSTEM')),
  group_disclosure_enabled boolean NOT NULL DEFAULT true,
  group_disclosure_message text NOT NULL DEFAULT
    'Messages containing an operational reference may be copied to our support case system.'
    CHECK (length(group_disclosure_message) BETWEEN 1 AND 500
      AND group_disclosure_message !~ E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'),
  sso_enforcement_state text NOT NULL DEFAULT 'DISABLED'
    CHECK (sso_enforcement_state IN ('DISABLED','REQUESTED','ACTIVE')),
  sso_provider_name text CHECK (
    sso_provider_name IS NULL OR (
      length(sso_provider_name) BETWEEN 1 AND 100
      AND sso_provider_name !~ '[[:cntrl:]]'
    )
  ),
  sso_issuer text CHECK (
    sso_issuer IS NULL OR (
      length(sso_issuer) BETWEEN 12 AND 500
      AND sso_issuer ~ '^https://'
      AND sso_issuer !~ '[?#[:space:]]'
    )
  ),
  sso_email_domains text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (cardinality(sso_email_domains) <= 20),
  mfa_required_roles text[] NOT NULL DEFAULT ARRAY['tenant_owner']::text[]
    CHECK (
      mfa_required_roles <@ ARRAY['tenant_owner','tenant_admin','supervisor','agent','auditor']::text[]
      AND cardinality(mfa_required_roles) BETWEEN 1 AND 5
    ),
  session_timeout_minutes integer NOT NULL DEFAULT 480
    CHECK (session_timeout_minutes BETWEEN 15 AND 1440),
  privileged_reauth_minutes integer NOT NULL DEFAULT 15
    CHECK (privileged_reauth_minutes BETWEEN 5 AND 120),
  support_access_requires_approval boolean NOT NULL DEFAULT true,
  security_policy_state text NOT NULL DEFAULT 'REQUESTED'
    CHECK (security_policy_state IN ('REQUESTED','ACTIVE')),
  policy_verified_at timestamptz,
  policy_verification_evidence_sha256 text CHECK (
    policy_verification_evidence_sha256 IS NULL
    OR policy_verification_evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    sso_enforcement_state='DISABLED' OR (
      sso_provider_name IS NOT NULL
      AND sso_issuer IS NOT NULL
      AND cardinality(sso_email_domains) > 0
    )
  ),
  CHECK (
    (security_policy_state='ACTIVE' AND policy_verified_at IS NOT NULL
      AND policy_verification_evidence_sha256 IS NOT NULL)
    OR (security_policy_state='REQUESTED' AND policy_verified_at IS NULL
      AND policy_verification_evidence_sha256 IS NULL)
  )
);

INSERT INTO tenant_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app.initialize_tenant_settings()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tenant_settings (tenant_id) VALUES (NEW.id)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_settings_initialize
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION app.initialize_tenant_settings();

CREATE TABLE tenant_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (
    email=lower(email)
    AND length(email) BETWEEN 3 AND 320
    AND email !~ '[[:cntrl:][:space:]]'
  ),
  display_name text CHECK (
    display_name IS NULL OR (
      length(display_name) BETWEEN 1 AND 120
      AND display_name !~ '[[:cntrl:]]'
    )
  ),
  role text NOT NULL CHECK (
    role IN ('tenant_owner','tenant_admin','supervisor','agent','auditor')
  ),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  expires_at timestamptz NOT NULL,
  invited_by uuid NOT NULL REFERENCES users(id),
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  create_idempotency_key text NOT NULL CHECK (
    length(create_idempotency_key) BETWEEN 1 AND 255
    AND create_idempotency_key !~ '[[:cntrl:]]'
  ),
  create_request_sha256 text NOT NULL CHECK (create_request_sha256 ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,create_idempotency_key),
  CHECK (
    (state='PENDING' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (state='ACCEPTED' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (state='REVOKED' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
    OR (state='EXPIRED' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_by IS NULL AND revoked_at IS NULL)
  )
);

CREATE UNIQUE INDEX tenant_invitations_pending_email_idx
  ON tenant_invitations (tenant_id,email)
  WHERE state='PENDING';
CREATE INDEX tenant_invitations_time_idx
  ON tenant_invitations (tenant_id,created_at DESC);

-- The invite token is encrypted for the delivery worker.  Only its SHA-256
-- digest is kept on tenant_invitations; plaintext tokens are never persisted.
CREATE TABLE tenant_invitation_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invitation_id uuid NOT NULL REFERENCES tenant_invitations(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('INVITE','RESEND')),
  recipient_email text NOT NULL CHECK (
    recipient_email=lower(recipient_email)
    AND length(recipient_email) BETWEEN 3 AND 320
    AND recipient_email !~ '[[:cntrl:][:space:]]'
  ),
  token_ciphertext bytea NOT NULL CHECK (octet_length(token_ciphertext) BETWEEN 128 AND 2048),
  token_key_version text NOT NULL CHECK (
    length(token_key_version) BETWEEN 1 AND 100
    AND token_key_version !~ '[[:cntrl:]]'
  ),
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (
    state IN ('PENDING','SENDING','SENT','FAILED_RETRYABLE','FAILED_TERMINAL','CANCELLED')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  provider_message_id text CHECK (
    provider_message_id IS NULL OR (
      length(provider_message_id) BETWEEN 1 AND 512
      AND provider_message_id !~ '[[:cntrl:]]'
    )
  ),
  error_code text CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error) BETWEEN 1 AND 500),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key),
  CHECK (
    (state='SENDING' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state<>'SENDING' AND lease_id IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state='SENT' AND provider_message_id IS NOT NULL AND sent_at IS NOT NULL)
    OR (state<>'SENT' AND sent_at IS NULL)
  )
);

CREATE INDEX tenant_invitation_email_claim_idx
  ON tenant_invitation_email_outbox (tenant_id,available_at,created_at)
  WHERE state IN ('PENDING','FAILED_RETRYABLE','SENDING');

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenant_settings','tenant_invitations','tenant_invitation_email_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id())',
      table_name
    );
  END LOOP;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_tenant_admin_writer') THEN
    CREATE ROLE wasalx_tenant_admin_writer NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE wasalx_tenant_admin_writer NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public,app TO wasalx_tenant_admin_writer;
GRANT SELECT,UPDATE (name,slug,updated_at) ON tenants TO wasalx_tenant_admin_writer;
GRANT SELECT,INSERT,UPDATE ON tenant_settings TO wasalx_tenant_admin_writer;
GRANT SELECT,UPDATE ON tenant_invitations TO wasalx_tenant_admin_writer;
GRANT SELECT,INSERT,UPDATE ON users,tenant_memberships,audit_events,
  tenant_invitation_email_outbox TO wasalx_tenant_admin_writer;

CREATE OR REPLACE FUNCTION app.update_tenant_workspace(
  expected_version_value bigint,
  name_value text,
  slug_value text,
  accent_color_value text,
  default_theme_value text,
  group_disclosure_enabled_value boolean,
  group_disclosure_message_value text,
  sso_enforcement_requested_value boolean,
  sso_provider_name_value text,
  sso_issuer_value text,
  sso_email_domains_value text[],
  mfa_required_roles_value text[],
  session_timeout_minutes_value integer,
  privileged_reauth_minutes_value integer,
  support_access_requires_approval_value boolean,
  actor_id_value uuid
)
RETURNS TABLE (
  tenant_id uuid,name text,slug text,accent_color text,default_theme text,
  group_disclosure_enabled boolean,group_disclosure_message text,
  sso_enforcement_state text,sso_provider_name text,sso_issuer text,
  sso_email_domains text[],mfa_required_roles text[],session_timeout_minutes integer,
  privileged_reauth_minutes integer,support_access_requires_approval boolean,
  security_policy_state text,policy_verified_at timestamptz,
  policy_verification_evidence_sha256 text,version bigint,updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE tenant_value uuid;
BEGIN
  tenant_value := app.current_tenant_id();
  PERFORM 1 FROM tenant_settings
   WHERE tenant_settings.tenant_id=tenant_value
     AND tenant_settings.version=expected_version_value
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace version conflict' USING ERRCODE='40001';
  END IF;

  UPDATE tenants
     SET name=name_value,slug=slug_value,updated_at=now()
   WHERE id=tenant_value;

  RETURN QUERY
  UPDATE tenant_settings AS settings
     SET accent_color=accent_color_value,
         default_theme=default_theme_value,
         group_disclosure_enabled=group_disclosure_enabled_value,
         group_disclosure_message=group_disclosure_message_value,
         sso_enforcement_state=CASE WHEN sso_enforcement_requested_value THEN 'REQUESTED' ELSE 'DISABLED' END,
         sso_provider_name=sso_provider_name_value,
         sso_issuer=sso_issuer_value,
         sso_email_domains=sso_email_domains_value,
         mfa_required_roles=mfa_required_roles_value,
         session_timeout_minutes=session_timeout_minutes_value,
         privileged_reauth_minutes=privileged_reauth_minutes_value,
         support_access_requires_approval=support_access_requires_approval_value,
         security_policy_state='REQUESTED',
         policy_verified_at=NULL,
         policy_verification_evidence_sha256=NULL,
         version=settings.version+1,
         updated_by=actor_id_value,
         updated_at=now()
   WHERE settings.tenant_id=tenant_value
   RETURNING settings.tenant_id,name_value,slug_value,settings.accent_color,
     settings.default_theme,settings.group_disclosure_enabled,
     settings.group_disclosure_message,settings.sso_enforcement_state,
     settings.sso_provider_name,settings.sso_issuer,settings.sso_email_domains,
     settings.mfa_required_roles,settings.session_timeout_minutes,
     settings.privileged_reauth_minutes,settings.support_access_requires_approval,
     settings.security_policy_state,settings.policy_verified_at,
     settings.policy_verification_evidence_sha256,settings.version,settings.updated_at;
END;
$$;

-- Only the provisioning identity may mark requested values active, after it
-- has applied and independently verified the IdP/broker/session configuration.
CREATE OR REPLACE FUNCTION app.activate_tenant_identity_policy(
  tenant_id_value uuid,expected_version_value bigint,evidence_sha256_value text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE affected bigint;
BEGIN
  IF evidence_sha256_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'identity policy evidence is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE tenant_settings
     SET sso_enforcement_state=CASE
           WHEN sso_enforcement_state='REQUESTED' THEN 'ACTIVE'
           ELSE sso_enforcement_state
         END,
         security_policy_state='ACTIVE',policy_verified_at=now(),
         policy_verification_evidence_sha256=evidence_sha256_value,
         version=version+1,updated_at=now()
   WHERE tenant_id=tenant_id_value AND version=expected_version_value
     AND security_policy_state='REQUESTED'
     AND (sso_enforcement_state='DISABLED' OR (
       sso_provider_name IS NOT NULL AND sso_issuer IS NOT NULL
       AND cardinality(sso_email_domains)>0
     ));
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN
    INSERT INTO audit_events (
      tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
    ) VALUES (
      tenant_id_value,'SYSTEM','identity-policy-provisioner',
      'settings.identity_policy_activated','tenant',tenant_id_value::text,
      jsonb_build_object('evidence_sha256',evidence_sha256_value),
      'identity-policy-activation-'||tenant_id_value::text||'-'||expected_version_value::text
    );
  END IF;
  RETURN affected=1;
END;
$$;

ALTER FUNCTION app.activate_tenant_identity_policy(uuid,bigint,text)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.activate_tenant_identity_policy(uuid,bigint,text) FROM PUBLIC;

ALTER FUNCTION app.update_tenant_workspace(
  bigint,text,text,text,text,boolean,text,boolean,text,text,text[],text[],integer,integer,boolean,uuid
) OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.update_tenant_workspace(
  bigint,text,text,text,text,boolean,text,boolean,text,text,text[],text[],integer,integer,boolean,uuid
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.accept_tenant_invitation(
  token_hash_value text,
  oidc_subject_value text,
  email_value text,
  display_name_value text
)
RETURNS TABLE (
  tenant_id uuid,tenant_name text,tenant_slug text,user_id uuid,membership_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE invitation tenant_invitations%ROWTYPE;
DECLARE user_value uuid;
DECLARE email_normalized text;
BEGIN
  email_normalized := lower(email_value);
  SELECT * INTO invitation
    FROM tenant_invitations
   WHERE token_hash=token_hash_value
   FOR UPDATE;
  IF NOT FOUND OR invitation.state<>'PENDING' OR invitation.expires_at<=now() THEN
    RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002';
  END IF;
  IF invitation.email<>email_normalized THEN
    RAISE EXCEPTION 'invitation identity does not match' USING ERRCODE='42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM users
     WHERE lower(email)=email_normalized AND oidc_subject<>oidc_subject_value
  ) THEN
    RAISE EXCEPTION 'email is linked to another identity' USING ERRCODE='23505';
  END IF;

  INSERT INTO users (oidc_subject,email,display_name)
  VALUES (oidc_subject_value,email_normalized,display_name_value)
  ON CONFLICT (oidc_subject) DO UPDATE
    SET email=EXCLUDED.email,display_name=EXCLUDED.display_name
  RETURNING id INTO user_value;

  IF EXISTS (
    SELECT 1 FROM tenant_memberships
     WHERE tenant_memberships.tenant_id=invitation.tenant_id
       AND tenant_memberships.user_id=user_value
  ) THEN
    RAISE EXCEPTION 'membership already exists' USING ERRCODE='23505';
  END IF;

  INSERT INTO tenant_memberships (tenant_id,user_id,role,state,updated_by)
  VALUES (invitation.tenant_id,user_value,invitation.role,'ACTIVE',user_value);

  UPDATE tenant_invitations
     SET state='ACCEPTED',accepted_by=user_value,accepted_at=now(),
         version=version+1,updated_at=now()
   WHERE id=invitation.id;
  UPDATE tenant_invitation_email_outbox
     SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE tenant_invitation_email_outbox.tenant_id=invitation.tenant_id
     AND invitation_id=invitation.id
     AND state IN ('PENDING','FAILED_RETRYABLE');
  INSERT INTO audit_events (
    tenant_id,actor_type,actor_id,action,target_type,target_id,
    previous_value,new_value,request_id
  ) VALUES (
    invitation.tenant_id,'USER',user_value::text,'team.invitation_accepted',
    'tenant_invitation',invitation.id::text,
    jsonb_build_object('state','PENDING'),
    jsonb_build_object('state','ACCEPTED','role',invitation.role),
    'invitation-accept-'||invitation.id::text
  );

  RETURN QUERY
  SELECT t.id,t.name,t.slug,user_value,invitation.role
    FROM tenants t WHERE t.id=invitation.tenant_id;
END;
$$;

ALTER FUNCTION app.accept_tenant_invitation(text,text,text,text)
  OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.accept_tenant_invitation(text,text,text,text) FROM PUBLIC;

-- Claim/complete/fail functions make email delivery genuinely durable.  A row
-- can become SENT only when the delivery worker provides a provider receipt.
CREATE OR REPLACE FUNCTION app.claim_invitation_email_jobs(
  worker_id uuid,batch_size integer DEFAULT 25
)
RETURNS SETOF tenant_invitation_email_outbox
LANGUAGE plpgsql
AS $$
BEGIN
  IF worker_id IS NULL OR batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid invitation email claim' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
      FROM tenant_invitation_email_outbox job
      JOIN tenant_invitations invitation
        ON invitation.tenant_id=job.tenant_id
       AND invitation.id=job.invitation_id
     WHERE job.tenant_id=app.current_tenant_id()
       AND invitation.state='PENDING'
       AND invitation.expires_at>now()
       AND (
         (job.state IN ('PENDING','FAILED_RETRYABLE') AND job.available_at<=now())
         OR (job.state='SENDING' AND job.lease_expires_at<now())
       )
     ORDER BY job.available_at,job.created_at
     LIMIT batch_size
     FOR UPDATE OF job SKIP LOCKED
  )
  UPDATE tenant_invitation_email_outbox job
     SET state='SENDING',attempts=job.attempts+1,lease_id=worker_id,
         lease_expires_at=now()+interval '60 seconds',
         fencing_token=job.fencing_token+1,error_code=NULL,safe_error=NULL,
         updated_at=now()
    FROM candidates
   WHERE job.id=candidates.id
   RETURNING job.*;
END;
$$;

CREATE OR REPLACE FUNCTION app.complete_invitation_email_job(
  job_id uuid,worker_id uuid,expected_fencing_token bigint,provider_message_id_value text
)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH updated AS (
    UPDATE tenant_invitation_email_outbox
       SET state='SENT',provider_message_id=provider_message_id_value,
           sent_at=now(),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE tenant_id=app.current_tenant_id() AND id=job_id
       AND state='SENDING' AND lease_id=worker_id
       AND fencing_token=expected_fencing_token AND lease_expires_at>=now()
       AND provider_message_id_value IS NOT NULL
       AND length(provider_message_id_value) BETWEEN 1 AND 512
     RETURNING 1
  ) SELECT EXISTS(SELECT 1 FROM updated)
$$;

CREATE OR REPLACE FUNCTION app.fail_invitation_email_job(
  job_id uuid,worker_id uuid,expected_fencing_token bigint,retryable boolean,
  error_code_value text,safe_error_value text,next_attempt_at timestamptz
)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH updated AS (
    UPDATE tenant_invitation_email_outbox
       SET state=CASE WHEN retryable THEN 'FAILED_RETRYABLE' ELSE 'FAILED_TERMINAL' END,
           available_at=CASE WHEN retryable THEN next_attempt_at ELSE available_at END,
           error_code=error_code_value,safe_error=safe_error_value,
           lease_id=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE tenant_id=app.current_tenant_id() AND id=job_id
       AND state='SENDING' AND lease_id=worker_id
       AND fencing_token=expected_fencing_token AND lease_expires_at>=now()
       AND error_code_value IS NOT NULL AND safe_error_value IS NOT NULL
     RETURNING 1
  ) SELECT EXISTS(SELECT 1 FROM updated)
$$;

-- Membership discovery must fail closed for suspended users.
CREATE OR REPLACE FUNCTION app.resolve_oidc_memberships(subject_value text)
RETURNS TABLE (
  user_id uuid,email text,display_name text,tenant_id uuid,tenant_name text,
  tenant_slug text,tenant_state text,membership_role text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  SELECT u.id,u.email,u.display_name,t.id,t.name,t.slug,t.state,m.role
    FROM public.users u
    JOIN public.tenant_memberships m ON m.user_id=u.id
    JOIN public.tenants t ON t.id=m.tenant_id
   WHERE u.oidc_subject=subject_value
     AND m.state='ACTIVE'
     AND t.state IN ('ACTIVE','PROVISIONING')
   ORDER BY t.name,t.id
   LIMIT 100
$$;
GRANT SELECT (state) ON public.tenant_memberships TO wasalx_identity_reader;
ALTER FUNCTION app.resolve_oidc_memberships(text) OWNER TO wasalx_identity_reader;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_invitation_mailer') THEN
    CREATE ROLE wasalx_invitation_mailer NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE wasalx_invitation_mailer NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public,app TO wasalx_invitation_mailer;
GRANT SELECT (id,tenant_id,state,expires_at) ON tenant_invitations TO wasalx_invitation_mailer;
GRANT SELECT,UPDATE ON tenant_invitation_email_outbox TO wasalx_invitation_mailer;

GRANT SELECT ON tenant_settings,tenant_invitations TO wasalx_app;
GRANT SELECT (id,tenant_id,invitation_id,action,state,attempts,available_at,
  provider_message_id,error_code,safe_error,sent_at,created_at,updated_at)
  ON tenant_invitation_email_outbox TO wasalx_app;
GRANT INSERT ON tenant_invitation_email_outbox TO wasalx_app;
GRANT UPDATE (state,lease_id,lease_expires_at,updated_at)
  ON tenant_invitation_email_outbox TO wasalx_app;
GRANT INSERT,UPDATE,DELETE ON tenant_invitations TO wasalx_app;
GRANT UPDATE (role,state,updated_by,updated_at,version),DELETE ON tenant_memberships TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.update_tenant_workspace(
  bigint,text,text,text,text,boolean,text,boolean,text,text,text[],text[],integer,integer,boolean,uuid
) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.accept_tenant_invitation(text,text,text,text) TO wasalx_app;
GRANT EXECUTE ON FUNCTION app.resolve_oidc_memberships(text) TO wasalx_app;

GRANT EXECUTE ON FUNCTION app.claim_invitation_email_jobs(uuid,integer)
  TO wasalx_invitation_mailer;
GRANT EXECUTE ON FUNCTION app.complete_invitation_email_job(uuid,uuid,bigint,text)
  TO wasalx_invitation_mailer;
GRANT EXECUTE ON FUNCTION app.fail_invitation_email_job(uuid,uuid,bigint,boolean,text,text,timestamptz)
  TO wasalx_invitation_mailer;
GRANT EXECUTE ON FUNCTION app.activate_tenant_identity_policy(uuid,bigint,text)
  TO wasalx_provisioning_client;

REVOKE ALL ON FUNCTION app.claim_invitation_email_jobs(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_invitation_email_job(uuid,uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_invitation_email_job(uuid,uuid,bigint,boolean,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_invitation_email_jobs(uuid,integer) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.complete_invitation_email_job(uuid,uuid,bigint,text) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.fail_invitation_email_job(uuid,uuid,bigint,boolean,text,text,timestamptz) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.activate_tenant_identity_policy(uuid,bigint,text) FROM wasalx_app;
