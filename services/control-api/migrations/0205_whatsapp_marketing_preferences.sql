CREATE TABLE whatsapp_marketing_preferences (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  subject text NOT NULL,
  opted_out boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, subject_kind, subject),
  UNIQUE (tenant_id, id),
  CHECK (subject_kind IN ('PHONE','BSUID') AND app.meta_direct_identifier_valid(subject_kind, subject))
);

ALTER TABLE whatsapp_marketing_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_marketing_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_marketing_preferences
  USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
REVOKE ALL ON whatsapp_marketing_preferences FROM PUBLIC, wasalx_app, wasalx_connector_worker;
GRANT SELECT ON whatsapp_marketing_preferences TO wasalx_app, wasalx_connector_worker;
GRANT DELETE ON whatsapp_marketing_preferences TO wasalx_connector_worker;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wasalx_marketing_preference_executor') THEN
    CREATE ROLE wasalx_marketing_preference_executor NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE wasalx_marketing_preference_executor NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public,app TO wasalx_marketing_preference_executor;
GRANT SELECT, INSERT, UPDATE (opted_out, observed_at) ON whatsapp_marketing_preferences
  TO wasalx_marketing_preference_executor;
GRANT SELECT (id, tenant_id) ON connections TO wasalx_marketing_preference_executor;
GRANT INSERT ON audit_events TO wasalx_marketing_preference_executor;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.meta_direct_identifier_valid(text,text)
  TO wasalx_marketing_preference_executor;

CREATE TRIGGER whatsapp_marketing_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON whatsapp_marketing_preferences
  FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE FUNCTION app.whatsapp_marketing_subject_matches(kind_value text, subject_value text, participants text[])
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
  SELECT subject_value=ANY(participants) OR EXISTS (
    SELECT 1 FROM meta_direct_identity_aliases alias CROSS JOIN unnest(participants) requested(value)
    WHERE alias.tenant_id=app.current_tenant_id() AND alias.kind=kind_value AND alias.value=subject_value
      AND app.meta_direct_participant_matches(alias.connection_id,alias.value,requested.value)
  )
$$;
REVOKE ALL ON FUNCTION app.whatsapp_marketing_subject_matches(text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_marketing_subject_matches(text,text,text[]) TO wasalx_connector_worker;

CREATE FUNCTION app.record_whatsapp_marketing_preference(
  phone_value text, bsuid_value text, stop_value boolean,
  observed_value timestamptz, reason_value text, connection_value uuid, request_value uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE tenant_value uuid := app.current_tenant_id();
BEGIN
  IF tenant_value IS NULL OR NOT (phone_value IS NOT NULL OR bsuid_value IS NOT NULL)
    OR reason_value IS NULL OR reason_value NOT IN ('PREFERENCE_WEBHOOK','PROVIDER_131050')
    OR (reason_value='PROVIDER_131050' AND stop_value IS DISTINCT FROM true)
    OR NOT EXISTS (SELECT 1 FROM connections WHERE tenant_id=tenant_value AND id=connection_value)
  THEN
    RAISE EXCEPTION 'WhatsApp marketing preference context is invalid' USING ERRCODE='23514';
  END IF;

  -- The final template dispatch takes the shared side of this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp-marketing:'||tenant_value::text,0));
  WITH subjects(subject_kind,subject) AS (
    SELECT * FROM (VALUES ('PHONE',phone_value),('BSUID',bsuid_value)) AS value(subject_kind,subject)
    WHERE subject IS NOT NULL
  ), previous AS MATERIALIZED (
    SELECT preference.id, preference.opted_out
    FROM whatsapp_marketing_preferences preference JOIN subjects USING (subject_kind,subject)
    WHERE preference.tenant_id=tenant_value
  ), updated AS (
    INSERT INTO whatsapp_marketing_preferences AS stored
      (tenant_id,subject_kind,subject,opted_out,observed_at)
    SELECT tenant_value,subject_kind,subject,stop_value,observed_value FROM subjects
    ON CONFLICT (tenant_id,subject_kind,subject) DO UPDATE
      SET opted_out=EXCLUDED.opted_out, observed_at=EXCLUDED.observed_at
      WHERE stored.observed_at<EXCLUDED.observed_at OR
        (stored.observed_at=EXCLUDED.observed_at AND EXCLUDED.opted_out AND NOT stored.opted_out)
    RETURNING id,opted_out
  )
  INSERT INTO audit_events (tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id)
  SELECT tenant_value,'SYSTEM',connection_value::text,'whatsapp.marketing_preference_changed',
    'whatsapp_marketing_preference',updated.id::text,
    jsonb_build_object('opted_out',updated.opted_out,'reason',reason_value),request_value::text
  FROM updated LEFT JOIN previous USING (id)
  WHERE previous.opted_out IS DISTINCT FROM updated.opted_out;
END;
$$;
ALTER FUNCTION app.record_whatsapp_marketing_preference(text,text,boolean,timestamptz,text,uuid,uuid)
  OWNER TO wasalx_marketing_preference_executor;
REVOKE ALL ON FUNCTION app.record_whatsapp_marketing_preference(text,text,boolean,timestamptz,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_whatsapp_marketing_preference(text,text,boolean,timestamptz,text,uuid,uuid)
  TO wasalx_app, wasalx_connector_worker;
