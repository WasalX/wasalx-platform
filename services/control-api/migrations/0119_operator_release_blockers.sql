ALTER TABLE public.bot_conversation_events
  DROP CONSTRAINT bot_conversation_events_event_kind_check;

ALTER TABLE public.bot_conversation_events
  ADD CONSTRAINT bot_conversation_events_event_kind_check CHECK (event_kind IN (
    'STARTED','MESSAGE','CHOICE','LOCATION','FLOW_RESPONSE','REACTION',
    'ACTION_SUCCEEDED','ACTION_FAILED','ACTION_OUTCOME_UNKNOWN','ACTION_RETRY_REQUESTED',
    'HANDOFF_REQUESTED','HANDOFF_COMPLETED','RESUMED','RESOLVED'
  ));

ALTER TABLE public.tenant_settings
  ADD COLUMN active_mfa_required_roles text[] NOT NULL DEFAULT ARRAY['tenant_owner']::text[],
  ADD COLUMN active_session_timeout_minutes integer NOT NULL DEFAULT 480,
  ADD CONSTRAINT tenant_settings_active_mfa_roles_check CHECK (
    active_mfa_required_roles <@ ARRAY['tenant_owner','tenant_admin','supervisor','agent','auditor']::text[]
    AND cardinality(active_mfa_required_roles) BETWEEN 1 AND 5
  ),
  ADD CONSTRAINT tenant_settings_active_session_timeout_check CHECK (
    active_session_timeout_minutes BETWEEN 15 AND 1440
  );

UPDATE public.tenant_settings
SET active_mfa_required_roles=CASE WHEN security_policy_state='ACTIVE' THEN mfa_required_roles ELSE ARRAY['tenant_owner']::text[] END,
    active_session_timeout_minutes=CASE WHEN security_policy_state='ACTIVE' THEN session_timeout_minutes ELSE 480 END;

CREATE OR REPLACE FUNCTION app.activate_tenant_identity_policy(
  tenant_id_value uuid,expected_version_value bigint,evidence_sha256_value text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected bigint;
BEGIN
  IF evidence_sha256_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'identity policy evidence is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE public.tenant_settings
     SET sso_enforcement_state=CASE WHEN sso_enforcement_state='REQUESTED' THEN 'ACTIVE' ELSE sso_enforcement_state END,
         active_mfa_required_roles=mfa_required_roles,
         active_session_timeout_minutes=session_timeout_minutes,
         security_policy_state='ACTIVE',policy_verified_at=now(),
         policy_verification_evidence_sha256=evidence_sha256_value,
         version=version+1,updated_at=now()
   WHERE tenant_id=tenant_id_value AND version=expected_version_value
     AND security_policy_state='REQUESTED'
     AND (sso_enforcement_state='DISABLED' OR (
       sso_provider_name IS NOT NULL AND sso_issuer IS NOT NULL AND cardinality(sso_email_domains)>0
     ));
  GET DIAGNOSTICS affected=ROW_COUNT;
  IF affected=1 THEN
    INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
    VALUES(tenant_id_value,'SYSTEM','identity-policy-provisioner','settings.identity_policy_activated','tenant',tenant_id_value::text,
      jsonb_build_object('evidence_sha256',evidence_sha256_value),
      'identity-policy-activation-'||tenant_id_value::text||'-'||expected_version_value::text);
  END IF;
  RETURN affected=1;
END
$$;

CREATE OR REPLACE FUNCTION app.begin_client_routing_notion_oauth(
  requested_by uuid,
  state_hash text,
  requested_redirect_uri text,
  requested_integration_id uuid
)
RETURNS TABLE(integration_id uuid,secret_reference text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();
DECLARE selected public.client_routing_integrations%ROWTYPE;
BEGIN
  IF state_hash!~'^[0-9a-f]{64}$' OR length(requested_redirect_uri) NOT BETWEEN 8 AND 2048 THEN
    RAISE EXCEPTION 'routing OAuth request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenant_memberships WHERE tenant_id=current_tenant AND user_id=requested_by AND role IN ('tenant_owner','tenant_admin') AND state='ACTIVE') THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF requested_integration_id IS NULL THEN
    INSERT INTO public.client_routing_integrations(tenant_id,provider,display_name,secret_reference,created_by)
      VALUES(current_tenant,'NOTION','Notion workspace','secret://tenants/'||current_tenant::text||'/routing/integrations/'||gen_random_uuid()::text,requested_by)
      RETURNING * INTO selected;
    UPDATE public.client_routing_integrations SET secret_reference='secret://tenants/'||current_tenant::text||'/routing/integrations/'||selected.id::text
      WHERE tenant_id=current_tenant AND id=selected.id RETURNING * INTO selected;
  ELSE
    UPDATE public.client_routing_integrations SET state='CONNECTING',revision=revision+1,updated_at=now()
      WHERE tenant_id=current_tenant AND id=requested_integration_id AND provider='NOTION'
      RETURNING * INTO selected;
    IF selected.id IS NULL THEN RAISE EXCEPTION 'Notion connection was not found' USING ERRCODE='23503'; END IF;
    DELETE FROM public.client_routing_oauth_states WHERE tenant_id=current_tenant AND integration_id=selected.id AND consumed_at IS NULL;
  END IF;
  INSERT INTO public.client_routing_oauth_states(tenant_id,integration_id,provider,requested_by,state_sha256,redirect_uri,expires_at)
    VALUES(current_tenant,selected.id,'NOTION',requested_by,state_hash,requested_redirect_uri,now()+interval '10 minutes');
  RETURN QUERY SELECT selected.id,selected.secret_reference;
END
$$;

REVOKE ALL ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text,uuid) TO wasalx_app;

UPDATE public.tenant_settings SET support_access_requires_approval=true
 WHERE support_access_requires_approval=false;
ALTER TABLE public.tenant_settings
  ADD CONSTRAINT tenant_settings_support_approval_required CHECK (support_access_requires_approval);
