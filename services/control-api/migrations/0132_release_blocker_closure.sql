DROP INDEX public.connections_active_waha_identity_unique;
CREATE UNIQUE INDEX connections_active_waha_identity_unique
  ON public.connections (phone_e164)
  WHERE provider='WAHA' AND phone_e164 IS NOT NULL AND state<>'REVOKED';

CREATE OR REPLACE FUNCTION app.queue_duplicate_waha_identity_cleanup(
  target_connection_id uuid,target_provider_session_id uuid,pinned_waha_worker_id uuid,
  claimed_phone_e164 text,request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE cleanup_operation_id uuid;
DECLARE inserted_operation_id uuid;
BEGIN
  IF claimed_phone_e164 !~ '^\+[1-9][0-9]{5,19}$' OR request_id IS NULL OR length(btrim(request_id)) NOT BETWEEN 1 AND 320 THEN
    RAISE EXCEPTION 'invalid duplicate identity cleanup request' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(claimed_phone_e164,0));
  PERFORM 1 FROM public.connections connection
    JOIN public.provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
    WHERE connection.tenant_id=app.current_tenant_id() AND connection.id=target_connection_id AND connection.provider='WAHA'
      AND session.id=target_provider_session_id AND session.waha_worker_id=pinned_waha_worker_id
    FOR UPDATE OF connection,session;
  IF NOT FOUND THEN RAISE EXCEPTION 'duplicate identity target is unavailable' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.connections existing WHERE existing.id<>target_connection_id
    AND existing.provider='WAHA' AND existing.phone_e164=claimed_phone_e164 AND existing.state<>'REVOKED') THEN RETURN NULL; END IF;
  UPDATE public.connections SET state='ACTION_REQUIRED',
    action_reason='This WhatsApp account is already connected to WasalX. Removing the duplicate linked session.',updated_at=now()
    WHERE tenant_id=app.current_tenant_id() AND id=target_connection_id;
  UPDATE public.provider_sessions SET state='ACTION_REQUIRED',updated_at=now()
    WHERE tenant_id=app.current_tenant_id() AND id=target_provider_session_id AND ownership_state='ACTIVE';
  UPDATE public.webhook_routes SET state='PAUSED',updated_at=now()
    WHERE tenant_id=app.current_tenant_id() AND connection_id=target_connection_id AND state<>'REVOKED';
  IF NOT FOUND THEN RAISE EXCEPTION 'duplicate identity webhook route is unavailable' USING ERRCODE='P0001'; END IF;
  INSERT INTO public.connection_operations
    (tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id)
  VALUES (app.current_tenant_id(),target_connection_id,'DISCONNECT','duplicate-identity:'||target_provider_session_id,
    jsonb_build_object('reason','DUPLICATE_IDENTITY','pinnedWahaWorkerId',pinned_waha_worker_id),'SYSTEM','connector-worker',request_id)
  ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id INTO inserted_operation_id;
  IF inserted_operation_id IS NULL THEN
    SELECT id INTO cleanup_operation_id FROM public.connection_operations
      WHERE tenant_id=app.current_tenant_id() AND idempotency_key='duplicate-identity:'||target_provider_session_id;
  ELSE
    cleanup_operation_id:=inserted_operation_id;
    INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,request_id)
      VALUES (app.current_tenant_id(),'SYSTEM','connector-worker','connection.duplicate_identity_rejected','connection',target_connection_id,request_id);
  END IF;
  RETURN cleanup_operation_id;
END;
$$;
REVOKE ALL ON FUNCTION app.queue_duplicate_waha_identity_cleanup(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_duplicate_waha_identity_cleanup(uuid,uuid,uuid,text,text) TO wasalx_app;

CREATE OR REPLACE FUNCTION app.accept_tenant_invitation(
  token_hash_value text,oidc_subject_value text,email_value text,display_name_value text
)
RETURNS TABLE (tenant_id uuid,tenant_name text,tenant_slug text,user_id uuid,membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE invitation tenant_invitations%ROWTYPE;
DECLARE user_value uuid;
DECLARE email_normalized text;
BEGIN
  email_normalized:=lower(email_value);
  SELECT * INTO invitation FROM tenant_invitations WHERE token_hash=token_hash_value FOR UPDATE;
  IF NOT FOUND OR invitation.expires_at<=now() THEN RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002'; END IF;
  IF invitation.email<>email_normalized THEN RAISE EXCEPTION 'invitation identity does not match' USING ERRCODE='42501'; END IF;
  IF invitation.state='ACCEPTED' THEN
    SELECT member.user_id INTO user_value FROM tenant_memberships member JOIN users existing ON existing.id=member.user_id
      WHERE member.tenant_id=invitation.tenant_id AND member.user_id=invitation.accepted_by AND member.role=invitation.role
        AND member.state='ACTIVE' AND existing.oidc_subject=oidc_subject_value AND lower(existing.email)=email_normalized;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation identity does not match' USING ERRCODE='42501'; END IF;
    RETURN QUERY SELECT tenant.id,tenant.name,tenant.slug,user_value,invitation.role FROM tenants tenant WHERE tenant.id=invitation.tenant_id;
    RETURN;
  END IF;
  IF invitation.state<>'PENDING' THEN RAISE EXCEPTION 'invitation is invalid or expired' USING ERRCODE='P0002'; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE lower(email)=email_normalized AND oidc_subject<>oidc_subject_value) THEN
    RAISE EXCEPTION 'email is linked to another identity' USING ERRCODE='23505';
  END IF;
  INSERT INTO users (oidc_subject,email,display_name) VALUES (oidc_subject_value,email_normalized,display_name_value)
    ON CONFLICT (oidc_subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name RETURNING id INTO user_value;
  IF EXISTS (SELECT 1 FROM tenant_memberships member WHERE member.tenant_id=invitation.tenant_id AND member.user_id=user_value) THEN
    RAISE EXCEPTION 'membership already exists' USING ERRCODE='23505';
  END IF;
  INSERT INTO tenant_memberships (tenant_id,user_id,role,state,updated_by)
    VALUES (invitation.tenant_id,user_value,invitation.role,'ACTIVE',user_value);
  UPDATE tenant_invitations SET state='ACCEPTED',accepted_by=user_value,accepted_at=now(),version=version+1,updated_at=now() WHERE id=invitation.id;
  UPDATE tenant_invitation_email_outbox SET state='CANCELLED',lease_id=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE tenant_id=invitation.tenant_id AND invitation_id=invitation.id AND state IN ('PENDING','FAILED_RETRYABLE');
  INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
    VALUES (invitation.tenant_id,'USER',user_value::text,'team.invitation_accepted','tenant_invitation',invitation.id::text,
      jsonb_build_object('state','PENDING'),jsonb_build_object('state','ACCEPTED','role',invitation.role),'invitation-accept-'||invitation.id::text);
  RETURN QUERY SELECT tenant.id,tenant.name,tenant.slug,user_value,invitation.role FROM tenants tenant WHERE tenant.id=invitation.tenant_id;
END;
$$;
ALTER FUNCTION app.accept_tenant_invitation(text,text,text,text) OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.accept_tenant_invitation(text,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.purge_expired_unmatched_events(retain_for interval DEFAULT interval '24 hours')
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE affected bigint;
BEGIN
  IF retain_for<interval '1 hour' OR retain_for>interval '24 hours' THEN
    RAISE EXCEPTION 'unmatched diagnostic retention must be between 1 and 24 hours' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM privacy_legal_holds WHERE tenant_id=app.current_tenant_id() AND state='ACTIVE'
    AND (expires_at IS NULL OR expires_at>now()) AND scope_type='TENANT') THEN RETURN 0; END IF;
  UPDATE event_inbox inbox SET payload='{}'::jsonb,status='REDACTED',safe_error=NULL,
    processed_at=COALESCE(inbox.processed_at,now()),lease_id=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE inbox.tenant_id=app.current_tenant_id()
      AND inbox.status IN ('UNMATCHED','IGNORED','DUPLICATE')
      AND COALESCE(inbox.processed_at,inbox.received_at)<now()-retain_for
      AND NOT EXISTS (SELECT 1 FROM normalized_messages message WHERE message.tenant_id=inbox.tenant_id AND message.event_inbox_id=inbox.id);
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END;
$$;
CREATE OR REPLACE FUNCTION app.redact_expired_unmatched_events(retain_for interval DEFAULT interval '24 hours')
RETURNS bigint LANGUAGE sql AS $$ SELECT app.purge_expired_unmatched_events(retain_for) $$;
REVOKE ALL ON FUNCTION app.purge_expired_unmatched_events(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_unmatched_events(interval) TO wasalx_app;
