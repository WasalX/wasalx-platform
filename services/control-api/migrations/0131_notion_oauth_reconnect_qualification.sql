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
  IF state_hash IS NULL OR state_hash!~'^[0-9a-f]{64}$' OR requested_redirect_uri IS NULL
     OR length(requested_redirect_uri) NOT BETWEEN 8 AND 2048 THEN
    RAISE EXCEPTION 'routing OAuth request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships AS membership
    WHERE membership.tenant_id=current_tenant AND membership.user_id=requested_by
      AND membership.role IN ('tenant_owner','tenant_admin') AND membership.state='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  IF requested_integration_id IS NULL THEN
    INSERT INTO public.client_routing_integrations(tenant_id,provider,display_name,secret_reference,created_by)
      VALUES(current_tenant,'NOTION','Notion workspace','secret://tenants/'||current_tenant::text||'/routing/integrations/'||gen_random_uuid()::text,requested_by)
      RETURNING * INTO selected;
    UPDATE public.client_routing_integrations AS integration
      SET secret_reference='secret://tenants/'||current_tenant::text||'/routing/integrations/'||selected.id::text
      WHERE integration.tenant_id=current_tenant AND integration.id=selected.id RETURNING * INTO selected;
  ELSE
    UPDATE public.client_routing_integrations AS integration
      SET state='CONNECTING',revision=integration.revision+1,updated_at=now()
      WHERE integration.tenant_id=current_tenant AND integration.id=requested_integration_id AND integration.provider='NOTION'
      RETURNING * INTO selected;
    IF selected.id IS NULL THEN RAISE EXCEPTION 'Notion connection was not found' USING ERRCODE='23503'; END IF;
    DELETE FROM public.client_routing_oauth_states AS oauth
      WHERE oauth.tenant_id=current_tenant AND oauth.integration_id=selected.id AND oauth.consumed_at IS NULL;
  END IF;
  INSERT INTO public.client_routing_oauth_states(tenant_id,integration_id,provider,requested_by,state_sha256,redirect_uri,expires_at)
    VALUES(current_tenant,selected.id,'NOTION',requested_by,state_hash,requested_redirect_uri,now()+interval '10 minutes');
  RETURN QUERY SELECT selected.id,selected.secret_reference;
END
$$;

REVOKE ALL ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text,uuid) TO wasalx_app;
