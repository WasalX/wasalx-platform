-- Invitation links are single-use; existing members use normal sign-in.
CREATE OR REPLACE FUNCTION app.accept_tenant_invitation(
  token_hash_value text,
  oidc_subject_value text,
  email_value text,
  display_name_value text
)
RETURNS TABLE (tenant_id uuid,tenant_name text,tenant_slug text,user_id uuid,membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE invitation tenant_invitations%ROWTYPE;
DECLARE tenant_record tenants%ROWTYPE;
DECLARE user_value uuid;
DECLARE existing_email text;
DECLARE email_normalized text;
DECLARE display_name_normalized text;
BEGIN
  IF token_hash_value IS NULL OR token_hash_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invitation token is invalid' USING ERRCODE='22023';
  END IF;
  IF oidc_subject_value IS NULL
     OR char_length(oidc_subject_value) NOT BETWEEN 1 AND 320
     OR oidc_subject_value<>btrim(oidc_subject_value)
     OR oidc_subject_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invitation subject is invalid' USING ERRCODE='22023';
  END IF;
  IF email_value IS NULL
     OR char_length(email_value) NOT BETWEEN 3 AND 320
     OR email_value<>btrim(email_value)
     OR email_value ~ '[[:cntrl:][:space:]]' THEN
    RAISE EXCEPTION 'invitation email is invalid' USING ERRCODE='22023';
  END IF;
  display_name_normalized:=btrim(display_name_value);
  IF display_name_normalized IS NULL
     OR char_length(display_name_normalized) NOT BETWEEN 1 AND 160
     OR display_name_normalized ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invitation display name is invalid' USING ERRCODE='22023';
  END IF;
  email_normalized:=lower(email_value);

  SELECT tenant.* INTO tenant_record
    FROM tenants tenant
    JOIN tenant_invitations pending ON pending.tenant_id=tenant.id
   WHERE pending.token_hash=token_hash_value
   FOR SHARE OF tenant;
  IF NOT FOUND OR tenant_record.state<>'ACTIVE' THEN
    RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002';
  END IF;

  SELECT candidate.* INTO invitation
    FROM tenant_invitations candidate
   WHERE candidate.tenant_id=tenant_record.id AND candidate.token_hash=token_hash_value
   FOR UPDATE OF candidate;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002'; END IF;
  IF invitation.email<>email_normalized THEN RAISE EXCEPTION 'invitation identity does not match' USING ERRCODE='42501'; END IF;
  IF invitation.expires_at<=now() OR invitation.state<>'PENDING' THEN
    RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002';
  END IF;

  SELECT existing.id,lower(existing.email) INTO user_value,existing_email
    FROM users existing
   WHERE existing.oidc_subject=oidc_subject_value
   FOR UPDATE OF existing;
  IF FOUND AND existing_email<>email_normalized THEN
    RAISE EXCEPTION 'identity is linked to another email' USING ERRCODE='23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM users existing
     WHERE lower(existing.email)=email_normalized
       AND existing.oidc_subject<>oidc_subject_value
  ) THEN
    RAISE EXCEPTION 'email is linked to another identity' USING ERRCODE='23505';
  END IF;
  IF user_value IS NULL THEN
    INSERT INTO users (oidc_subject,email,display_name)
      VALUES (oidc_subject_value,email_normalized,display_name_normalized)
      ON CONFLICT (oidc_subject) DO NOTHING;
    SELECT existing.id,lower(existing.email) INTO user_value,existing_email
      FROM users existing
     WHERE existing.oidc_subject=oidc_subject_value
     FOR UPDATE OF existing;
    IF user_value IS NULL OR existing_email<>email_normalized THEN
      RAISE EXCEPTION 'identity is linked to another email' USING ERRCODE='23505';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM tenant_memberships member
     WHERE member.tenant_id=invitation.tenant_id AND member.user_id=user_value
  ) THEN
    RAISE EXCEPTION 'membership already exists' USING ERRCODE='23505';
  END IF;

  INSERT INTO tenant_memberships (tenant_id,user_id,role,state,updated_by)
    VALUES (invitation.tenant_id,user_value,invitation.role,'ACTIVE',user_value);
  UPDATE tenant_invitations
     SET state='ACCEPTED',accepted_by=user_value,accepted_at=now(),version=version+1,updated_at=now()
   WHERE id=invitation.id;
  UPDATE tenant_invitation_email_outbox email_outbox
     SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE email_outbox.tenant_id=invitation.tenant_id
     AND email_outbox.invitation_id=invitation.id
     AND email_outbox.state IN ('PENDING','FAILED_RETRYABLE');
  INSERT INTO audit_events (
    tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id
  ) VALUES (
    invitation.tenant_id,'USER',user_value::text,'team.invitation_accepted','tenant_invitation',invitation.id::text,
    jsonb_build_object('state','PENDING'),jsonb_build_object('state','ACCEPTED','role',invitation.role),
    'invitation-accept-'||invitation.id::text
  );
  RETURN QUERY SELECT tenant_record.id,tenant_record.name,tenant_record.slug,user_value,invitation.role;
END;
$$;

ALTER FUNCTION app.accept_tenant_invitation(text,text,text,text) OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.accept_tenant_invitation(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_tenant_invitation(text,text,text,text) TO wasalx_app;
