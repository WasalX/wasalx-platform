CREATE OR REPLACE FUNCTION app.begin_client_routing_notion_oauth(
  requested_by uuid,
  state_hash text,
  requested_redirect_uri text
)
RETURNS TABLE(integration_id uuid,secret_reference text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
DECLARE current_tenant uuid:=app.current_tenant_id();DECLARE created_id uuid;DECLARE reference text;
BEGIN
  IF state_hash IS NULL OR state_hash!~'^[0-9a-f]{64}$' OR requested_redirect_uri IS NULL
     OR length(requested_redirect_uri) NOT BETWEEN 8 AND 2048 THEN
    RAISE EXCEPTION 'routing OAuth request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE tenant_id=current_tenant AND user_id=requested_by
      AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;

  PERFORM oauth.id
  FROM client_routing_oauth_states oauth
  JOIN client_routing_integrations integration
    ON integration.tenant_id=oauth.tenant_id
   AND integration.id=oauth.integration_id
   AND integration.provider=oauth.provider
   AND integration.created_by=oauth.requested_by
  WHERE integration.tenant_id=current_tenant
    AND integration.provider='NOTION'
    AND integration.state='CONNECTING'
    AND oauth.consumed_at IS NULL
    AND oauth.expires_at<=now()
    AND NOT EXISTS (
      SELECT 1 FROM client_routing_oauth_states pending
      WHERE pending.tenant_id=oauth.tenant_id
        AND pending.integration_id=oauth.integration_id
        AND pending.provider=oauth.provider
        AND pending.requested_by=oauth.requested_by
        AND pending.consumed_at IS NULL
        AND pending.expires_at>now()
    )
  ORDER BY oauth.id
  FOR UPDATE OF oauth;

  WITH retired AS (
    UPDATE client_routing_integrations integration
    SET state='REVOKED',revision=integration.revision+1,updated_at=now()
    WHERE integration.tenant_id=current_tenant
      AND integration.provider='NOTION'
      AND integration.state='CONNECTING'
      AND EXISTS (
        SELECT 1 FROM client_routing_oauth_states oauth
        WHERE oauth.tenant_id=integration.tenant_id
          AND oauth.integration_id=integration.id
          AND oauth.provider=integration.provider
          AND oauth.requested_by=integration.created_by
          AND oauth.consumed_at IS NULL
          AND oauth.expires_at<=now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM client_routing_oauth_states pending
        WHERE pending.tenant_id=integration.tenant_id
          AND pending.integration_id=integration.id
          AND pending.provider=integration.provider
          AND pending.requested_by=integration.created_by
          AND pending.consumed_at IS NULL
          AND pending.expires_at>now()
      )
    RETURNING integration.id,integration.revision
  )
  INSERT INTO audit_events
    (tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
  SELECT current_tenant,'USER',requested_by,'client_routing.integration_expired',
    'client_routing_integration',retired.id::text,
    jsonb_build_object('state','CONNECTING','revision',retired.revision-1),
    jsonb_build_object('state','REVOKED','revision',retired.revision,'reason','AUTHORIZATION_EXPIRED'),
    'oauth-expiry:'||state_hash
  FROM retired;

  created_id:=gen_random_uuid();
  reference:='secret://tenants/'||current_tenant::text||'/routing/integrations/'||created_id::text;
  INSERT INTO client_routing_integrations(id,tenant_id,provider,display_name,secret_reference,created_by)
    VALUES(created_id,current_tenant,'NOTION','Notion workspace',reference,requested_by);
  INSERT INTO client_routing_oauth_states(tenant_id,integration_id,provider,requested_by,state_sha256,redirect_uri,expires_at)
    VALUES(current_tenant,created_id,'NOTION',requested_by,state_hash,requested_redirect_uri,now()+interval '10 minutes');
  RETURN QUERY SELECT created_id,reference;
END
$$;

CREATE OR REPLACE FUNCTION app.list_client_routing_integrations()
RETURNS TABLE(
  id uuid,
  provider text,
  display_name text,
  secret_reference text,
  state text,
  revision bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app SET row_security=off AS $$
  WITH effective AS (
    SELECT integration.id,integration.provider,integration.display_name,integration.secret_reference,
      CASE WHEN integration.state='CONNECTING'
        AND EXISTS (
          SELECT 1 FROM client_routing_oauth_states oauth
          WHERE oauth.tenant_id=integration.tenant_id
            AND oauth.integration_id=integration.id
            AND oauth.provider=integration.provider
            AND oauth.requested_by=integration.created_by
            AND oauth.consumed_at IS NULL
            AND oauth.expires_at<=now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM client_routing_oauth_states pending
          WHERE pending.tenant_id=integration.tenant_id
            AND pending.integration_id=integration.id
            AND pending.provider=integration.provider
            AND pending.requested_by=integration.created_by
            AND pending.consumed_at IS NULL
            AND pending.expires_at>now()
        )
      THEN 'REVOKED' ELSE integration.state END AS state,
      integration.revision,integration.created_at,integration.updated_at
    FROM client_routing_integrations integration
    WHERE integration.tenant_id=app.current_tenant_id()
  ), ranked AS (
    SELECT effective.*,
      row_number() OVER (
        PARTITION BY effective.provider,effective.state
        ORDER BY effective.updated_at DESC,effective.created_at DESC,effective.id DESC
      ) AS state_rank
    FROM effective
  )
  SELECT ranked.id,ranked.provider,ranked.display_name,ranked.secret_reference,
    ranked.state,ranked.revision,ranked.created_at,ranked.updated_at
  FROM ranked
  WHERE ranked.state<>'REVOKED' OR ranked.state_rank=1
  ORDER BY CASE ranked.state WHEN 'CONNECTED' THEN 0 WHEN 'CONNECTING' THEN 1 ELSE 2 END,
    ranked.display_name,ranked.created_at,ranked.id
$$;

REVOKE ALL ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text),app.list_client_routing_integrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.begin_client_routing_notion_oauth(uuid,text,text),app.list_client_routing_integrations() TO wasalx_app;
