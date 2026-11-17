CREATE OR REPLACE FUNCTION app.resolve_meta_lifecycle_routes(
  target_waba_id text,
  expected_app_id text
)
RETURNS TABLE (
  tenant_id uuid,
  connection_id uuid,
  provider text,
  hmac_secret_reference text,
  route_state text,
  provider_session_id uuid,
  session_ownership_state text,
  phone_number_id text,
  waba_id text,
  display_phone_number text,
  app_id text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ranked AS (
    SELECT route.tenant_id,route.connection_id,route.provider,route.hmac_secret_reference,
           route.state AS route_state,route.external_key,connection.state AS connection_state,
           session.id AS provider_session_id,session.ownership_state AS session_ownership_state,
           session.opaque_session_id AS phone_number_id,session.provider_state_data,
           proof.value->>'wabaId' AS waba_id,
           proof.value->>'displayPhoneNumber' AS display_phone_number,
           expected_app_id AS app_id,
           dense_rank() OVER (
             PARTITION BY route.tenant_id,route.connection_id
             ORDER BY CASE session.ownership_state WHEN 'ACTIVE' THEN 0 ELSE 1 END,
                      session.created_at DESC
           ) AS generation_rank
      FROM webhook_routes route
      JOIN connections connection
        ON connection.tenant_id=route.tenant_id AND connection.id=route.connection_id
      JOIN provider_sessions session
        ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
      CROSS JOIN LATERAL (SELECT session.provider_state_data->'metaAccountProof' AS value) proof
     WHERE route.provider='META' AND connection.provider='META' AND connection.engine='CLOUD_API'
       AND route.state IN ('ACTIVE','PAUSED','REVOKED')
       AND session.ownership_state IN ('ACTIVE','RETIRED')
       AND (
         (connection.state NOT IN ('PAUSED','REVOKED') AND route.state='ACTIVE')
         OR (connection.state='PAUSED' AND route.state='PAUSED')
         OR (connection.state='REVOKED' AND route.state='REVOKED')
       )
  ), candidates AS (
    SELECT ranked.*,
           count(*) FILTER (WHERE ranked.generation_rank=1) OVER (
             PARTITION BY ranked.tenant_id,ranked.connection_id
           ) AS generation_peer_count
      FROM ranked
  )
  SELECT candidate.tenant_id,candidate.connection_id,candidate.provider,
         candidate.hmac_secret_reference,candidate.route_state,candidate.provider_session_id,
         candidate.session_ownership_state,candidate.phone_number_id,candidate.waba_id,
         candidate.display_phone_number,candidate.app_id
    FROM candidates candidate
   WHERE candidate.generation_rank=1
     AND candidate.generation_peer_count=1
     AND jsonb_typeof(candidate.provider_state_data->'metaAccountProof')='object'
     AND candidate.provider_state_data->'metaAccountProof'->>'claim'='PHONE_ACCOUNT_RELATION_VERIFIED'
     AND candidate.provider_state_data->'metaAccountProof'->>'tenantId'=candidate.tenant_id::text
     AND candidate.provider_state_data->'metaAccountProof'->>'connectionId'=candidate.connection_id::text
     AND candidate.provider_state_data->'metaAccountProof'->>'providerSessionId'=candidate.provider_session_id::text
     AND candidate.provider_state_data->'metaAccountProof'->>'phoneNumberId'=candidate.phone_number_id
     AND candidate.provider_state_data->'metaAccountProof'->>'wabaId'~'^[0-9]{5,32}$'
     AND candidate.provider_state_data->'metaAccountProof'->>'wabaId'=candidate.provider_state_data->>'wabaId'
     AND candidate.external_key=candidate.phone_number_id
     AND candidate.waba_id=target_waba_id
     AND (NOT (candidate.provider_state_data->'metaAccountProof' ? 'credentialMetadata')
          OR (
            jsonb_typeof(candidate.provider_state_data->'metaAccountProof'->'credentialMetadata')='object'
            AND candidate.provider_state_data->'metaAccountProof'->'credentialMetadata'->>'appId'=expected_app_id
          ))
   ORDER BY candidate.tenant_id,candidate.connection_id;
$$;

REVOKE ALL ON FUNCTION app.resolve_meta_lifecycle_routes(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.meta_lifecycle_guard(
  expected_connection_id uuid,
  expected_provider_session_id uuid,
  expected_phone_number_id text,
  expected_waba_id text,
  expected_app_id text,
  expected_revision bigint
)
RETURNS TABLE (
  lifecycle_revision bigint,
  revision_matches boolean,
  blocked boolean,
  unresolved_hold boolean
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH pending_block AS (
    SELECT EXISTS (
      SELECT 1 FROM event_inbox event
       WHERE event.tenant_id=app.current_tenant_id()
         AND event.connection_id=expected_connection_id
         AND event.provider='META'
         AND event.event_type='meta.account.lifecycle.block'
         AND event.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE','FAILED_TERMINAL')
         AND CASE
           WHEN jsonb_typeof(event.payload->'admission'->'asset') IS DISTINCT FROM 'object' THEN true
           WHEN NOT COALESCE((event.payload->'admission'->'asset'->>'providerSessionId')
                  ~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',false) THEN true
           WHEN NOT COALESCE((event.payload->'admission'->'asset'->>'appId')~'^[0-9]{5,32}$',false) THEN true
           ELSE event.payload->'admission'->'asset'->>'providerSessionId'=expected_provider_session_id::text
             AND (NULLIF(expected_app_id,'') IS NULL
                  OR event.payload->'admission'->'asset'->>'appId'=expected_app_id)
         END
    ) AS unresolved_hold
  ), selected AS (
    SELECT session.provider_state_data,
           session.provider_state_data ? 'metaLifecycle' AS lifecycle_present,
           session.provider_state_data->'metaLifecycle' AS lifecycle,
           pending.unresolved_hold
      FROM connections connection
      JOIN provider_sessions session
        ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
      CROSS JOIN pending_block pending
     WHERE connection.tenant_id=app.current_tenant_id()
       AND connection.id=expected_connection_id
       AND connection.provider='META'
       AND session.id=expected_provider_session_id
       AND session.ownership_state='ACTIVE'
       AND (
         (
           (jsonb_typeof(session.provider_state_data->'metaAccountProof') IS NULL
            OR jsonb_typeof(session.provider_state_data->'metaAccountProof')='null')
           AND NOT (session.provider_state_data ? 'metaLifecycle')
         )
         OR (
           jsonb_typeof(session.provider_state_data->'metaAccountProof')='object'
           AND session.provider_state_data->'metaAccountProof'->>'claim'='PHONE_ACCOUNT_RELATION_VERIFIED'
           AND session.provider_state_data->'metaAccountProof'->>'tenantId'=connection.tenant_id::text
           AND session.provider_state_data->'metaAccountProof'->>'connectionId'=connection.id::text
           AND session.provider_state_data->'metaAccountProof'->>'providerSessionId'=session.id::text
           AND session.provider_state_data->'metaAccountProof'->>'phoneNumberId'=session.opaque_session_id
           AND session.provider_state_data->'metaAccountProof'->>'wabaId'=session.provider_state_data->>'wabaId'
           AND (
             NOT (session.provider_state_data->'metaAccountProof' ? 'credentialMetadata')
             OR (
               NULLIF(expected_app_id,'') IS NOT NULL
               AND jsonb_typeof(session.provider_state_data->'metaAccountProof'->'credentialMetadata')='object'
               AND session.provider_state_data->'metaAccountProof'->'credentialMetadata'->>'appId'=expected_app_id
             )
           )
         )
       )
       AND (NULLIF(expected_app_id,'') IS NOT NULL OR NOT (session.provider_state_data ? 'metaLifecycle'))
       AND (
         (session.opaque_session_id=expected_phone_number_id
          AND session.provider_state_data->>'wabaId' IS NOT DISTINCT FROM expected_waba_id)
         OR pending.unresolved_hold
       )
  ), projected AS (
    SELECT selected.lifecycle_present,selected.lifecycle,selected.unresolved_hold,
           CASE WHEN NOT selected.lifecycle_present THEN 0::bigint
                WHEN jsonb_typeof(selected.lifecycle)='object'
                 AND selected.lifecycle->'schemaVersion'='1'::jsonb
                 AND jsonb_typeof(selected.lifecycle->'revision')='number'
                 AND (selected.lifecycle->>'revision')~'^[1-9][0-9]{0,15}$'
                 AND jsonb_typeof(selected.lifecycle->'reasonStates')='array'
                THEN CASE WHEN (selected.lifecycle->>'revision')::numeric<=9007199254740991
                           AND jsonb_array_length(selected.lifecycle->'reasonStates')<=11
                           AND NOT EXISTS (
                             SELECT 1 FROM jsonb_array_elements(selected.lifecycle->'reasonStates') reason
                              WHERE jsonb_typeof(reason) IS DISTINCT FROM 'object'
                                 OR jsonb_typeof(reason->'blocked') IS DISTINCT FROM 'boolean'
                           )
                          THEN (selected.lifecycle->>'revision')::bigint ELSE NULL END
                ELSE NULL END AS lifecycle_revision
      FROM selected
  )
  SELECT projected.lifecycle_revision,
         projected.lifecycle_revision=expected_revision AS revision_matches,
         CASE WHEN projected.lifecycle_present AND projected.lifecycle_revision IS NOT NULL THEN EXISTS (
           SELECT 1 FROM jsonb_array_elements(projected.lifecycle->'reasonStates') reason
            WHERE jsonb_typeof(reason)='object' AND reason->'blocked'='true'::jsonb
         ) ELSE false END AS blocked,
         projected.unresolved_hold
    FROM projected
   WHERE projected.lifecycle_revision IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app.meta_lifecycle_guard(uuid,uuid,text,text,text,bigint) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_app') THEN
    GRANT EXECUTE ON FUNCTION app.resolve_meta_lifecycle_routes(text,text) TO wasalx_app;
    GRANT EXECUTE ON FUNCTION app.meta_lifecycle_guard(uuid,uuid,text,text,text,bigint) TO wasalx_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_connector_worker') THEN
    GRANT EXECUTE ON FUNCTION app.meta_lifecycle_guard(uuid,uuid,text,text,text,bigint) TO wasalx_connector_worker;
  END IF;
END $$;
