-- Qualify immutable family columns so PL/pgSQL output variables cannot shadow them.
CREATE OR REPLACE FUNCTION app.create_rule_set_snapshot(
  requested_family_id uuid,
  requested_name text,
  requested_version integer,
  requested_supersedes_rule_set_id uuid,
  requested_rollback_source_rule_set_id uuid,
  requested_by uuid,
  requested_rules jsonb
)
RETURNS TABLE (
  id uuid,
  family_id uuid,
  version integer,
  state text,
  revision bigint,
  snapshot_sha256 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
DECLARE current_tenant uuid;
DECLARE created_set public.rule_sets%ROWTYPE;
DECLARE requested_rule jsonb;
BEGIN
  current_tenant := app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_memberships
     WHERE tenant_id=current_tenant
       AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'rule snapshot actor is not authorized'
      USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.rule_families AS family
     WHERE family.tenant_id=current_tenant
       AND family.id=requested_family_id
       AND family.name=requested_name
  ) THEN
    RAISE EXCEPTION 'rule family was not found in the tenant'
      USING ERRCODE='23503';
  END IF;
  IF jsonb_typeof(requested_rules)<>'array'
     OR jsonb_array_length(requested_rules) NOT BETWEEN 1 AND 100
     OR octet_length(requested_rules::text)>6000000 THEN
    RAISE EXCEPTION 'a rule snapshot must contain between 1 and 100 rules'
      USING ERRCODE='22023';
  END IF;

  INSERT INTO public.rule_sets (
    tenant_id,family_id,name,version,state,revision,snapshot_sha256,
    supersedes_rule_set_id,rollback_source_rule_set_id,created_by
  ) VALUES (
    current_tenant,requested_family_id,requested_name,requested_version,
    'DRAFT',1,encode(public.digest(requested_rules::text,'sha256'),'hex'),
    requested_supersedes_rule_set_id,requested_rollback_source_rule_set_id,
    requested_by
  ) RETURNING * INTO created_set;

  FOR requested_rule IN SELECT value FROM jsonb_array_elements(requested_rules)
  LOOP
    IF jsonb_typeof(requested_rule)<>'object' THEN
      RAISE EXCEPTION 'rule snapshot entries must be objects'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(requested_rule) AS entry(field_name)
       WHERE entry.field_name NOT IN (
         'name','matcherType','pattern','matcherOptions','priority','enabled',
         'savedExamples'
       )
    ) THEN
      RAISE EXCEPTION 'rule snapshot entry contains unsupported fields'
        USING ERRCODE='22023';
    END IF;
    INSERT INTO public.trigger_rules (
      tenant_id,rule_set_id,name,matcher_type,pattern,matcher_options,
      priority,enabled,saved_examples
    ) VALUES (
      current_tenant,created_set.id,requested_rule->>'name',
      requested_rule->>'matcherType',requested_rule->>'pattern',
      COALESCE(requested_rule->'matcherOptions','{}'::jsonb),
      (requested_rule->>'priority')::integer,
      COALESCE((requested_rule->>'enabled')::boolean,true),
      COALESCE(requested_rule->'savedExamples','[]'::jsonb)
    );
  END LOOP;

  RETURN QUERY SELECT created_set.id,created_set.family_id,
    created_set.version,created_set.state,created_set.revision,
    created_set.snapshot_sha256;
END;
$$;

REVOKE ALL ON FUNCTION app.create_rule_set_snapshot(uuid,text,integer,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_rule_set_snapshot(uuid,text,integer,uuid,uuid,uuid,jsonb) TO wasalx_app;
