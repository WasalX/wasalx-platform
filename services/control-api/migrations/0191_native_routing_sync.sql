-- Source configuration commits enqueue durable native intent; no RPC in these transactions.
CREATE TABLE native_routing_projections (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  zammad_instance_id uuid NOT NULL,
  desired_revision bigint NOT NULL DEFAULT 1 CHECK (desired_revision BETWEEN 1 AND 9007199254740991),
  applied_revision bigint NOT NULL DEFAULT 0 CHECK (applied_revision BETWEEN 0 AND 9007199254740991),
  desired_manifest jsonb, desired_sha256 text CHECK (desired_sha256 ~ '^[0-9a-f]{64}$'),
  observed_sha256 text CHECK (observed_sha256 ~ '^[0-9a-f]{64}$'),
  department_defaults jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(department_defaults)='array' AND jsonb_array_length(department_defaults)<=100),
  sync_state text NOT NULL DEFAULT 'PENDING' CHECK (sync_state IN ('PENDING','APPLYING','SYNCED','DRIFT','FAILED','OUTCOME_UNKNOWN')),
  next_action text CHECK (next_action IN ('APPLY','CHECK')) DEFAULT 'CHECK',
  -- This immutable attempted request survives newer desired revisions and process crashes.
  attempted_request jsonb,
  error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{0,100}$'),
  safe_retry boolean NOT NULL DEFAULT true,
  claim_id uuid, claim_expires_at timestamptz,
  last_checked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,zammad_instance_id) REFERENCES zammad_instances(tenant_id,id),
  CHECK (sync_state<>'SYNCED' OR (desired_revision=applied_revision AND desired_sha256=observed_sha256 AND desired_sha256 IS NOT NULL AND last_checked_at IS NOT NULL)),
  CHECK (sync_state NOT IN ('APPLYING','OUTCOME_UNKNOWN') OR (attempted_request IS NOT NULL AND NOT safe_retry)),
  CHECK (NOT safe_retry OR sync_state IN ('PENDING','FAILED'))
);
ALTER TABLE native_routing_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE native_routing_projections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON native_routing_projections USING (tenant_id=app.current_tenant_id()) WITH CHECK (tenant_id=app.current_tenant_id());
REVOKE ALL ON native_routing_projections FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON native_routing_projections TO wasalx_app,wasalx_tenant_admin_writer;
GRANT SELECT(id,tenant_id) ON public.zammad_instances TO wasalx_tenant_admin_writer;

CREATE FUNCTION app.queue_native_routing(tenant_value uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  -- Trusted schema/bootstrap superusers may seed multiple tenants. Runtime roles
  -- must always provide their exact tenant context, including worker-generated versions.
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    IF tenant_value IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Tenant context required' USING ERRCODE='42501'; END IF;
  END IF;
  INSERT INTO native_routing_projections(tenant_id,zammad_instance_id)
    SELECT tenant_value,id FROM zammad_instances WHERE tenant_id=tenant_value
  ON CONFLICT (tenant_id) DO UPDATE SET desired_revision=native_routing_projections.desired_revision+1,
    desired_manifest=NULL,desired_sha256=NULL,
    sync_state=CASE WHEN native_routing_projections.sync_state IN ('APPLYING','OUTCOME_UNKNOWN') THEN 'OUTCOME_UNKNOWN'
      WHEN native_routing_projections.sync_state='DRIFT' THEN 'DRIFT' ELSE 'PENDING' END,
    next_action=CASE WHEN native_routing_projections.sync_state IN ('APPLYING','OUTCOME_UNKNOWN') THEN 'CHECK'
      WHEN native_routing_projections.sync_state='DRIFT' THEN NULL ELSE 'APPLY' END,
    safe_retry=native_routing_projections.sync_state NOT IN ('APPLYING','OUTCOME_UNKNOWN','DRIFT'),
    error_code=CASE WHEN native_routing_projections.sync_state IN ('APPLYING','OUTCOME_UNKNOWN','DRIFT') THEN native_routing_projections.error_code ELSE NULL END,
    updated_at=now();
END $$;
REVOKE ALL ON FUNCTION app.queue_native_routing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_native_routing(uuid) TO wasalx_app,wasalx_tenant_admin_writer;

CREATE FUNCTION app.native_routing_configuration_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE before_row jsonb;DECLARE after_row jsonb;DECLARE tenant_value uuid;
DECLARE saved_tenant text:=current_setting('app.tenant_id',true);
BEGIN
  -- The already-authorized source row is the only authority for this private bridge.
  IF TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_RELID NOT IN (
    'public.group_bindings'::regclass,'public.bot_assignments'::regclass,'public.bot_flow_versions'::regclass,
    'public.client_routing_versions'::regclass,'public.connections'::regclass,'public.zammad_instances'::regclass
  ) THEN RAISE EXCEPTION 'Invalid native routing trigger source' USING ERRCODE='42501'; END IF;
  before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  tenant_value:=COALESCE((after_row->>'tenant_id')::uuid,(before_row->>'tenant_id')::uuid);
  IF TG_TABLE_NAME='connections' THEN
    IF TG_OP<>'DELETE' AND (after_row->>'state'='REVOKED') IS NOT DISTINCT FROM (before_row->>'state'='REVOKED') THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='zammad_instances' THEN
    IF TG_OP='UPDATE' AND after_row->>'state' IS NOT DISTINCT FROM before_row->>'state' THEN RETURN NULL; END IF;
  ELSE
    IF COALESCE(after_row->>'state','')<>'ACTIVE' AND COALESCE(before_row->>'state','')<>'ACTIVE' THEN RETURN NULL; END IF;
    -- Attribution/display-only updates do not invalidate native routing proof.
    IF TG_OP='UPDATE' AND (after_row-ARRAY['updated_at','updated_by','agent_prefix','agent_identity_placement'])
      IS NOT DISTINCT FROM (before_row-ARRAY['updated_at','updated_by','agent_prefix','agent_identity_placement']) THEN RETURN NULL; END IF;
  END IF;
  PERFORM set_config('app.tenant_id',tenant_value::text,true);
  PERFORM app.queue_native_routing(tenant_value);
  PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);RAISE;
END $$;
ALTER FUNCTION app.native_routing_configuration_changed() OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.native_routing_configuration_changed() FROM PUBLIC,wasalx_app;
CREATE TRIGGER native_routing_group_binding AFTER INSERT OR UPDATE OR DELETE ON group_bindings FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed();
CREATE TRIGGER native_routing_bot_assignment AFTER INSERT OR UPDATE OR DELETE ON bot_assignments FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed();
CREATE TRIGGER native_routing_flow_version AFTER INSERT OR UPDATE OR DELETE ON bot_flow_versions FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed();
CREATE TRIGGER native_routing_client_version AFTER INSERT OR UPDATE OR DELETE ON client_routing_versions FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed();
CREATE TRIGGER native_routing_connection AFTER UPDATE OF state OR DELETE ON connections FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed();
CREATE TRIGGER native_routing_instance AFTER INSERT OR UPDATE OF state ON zammad_instances FOR EACH ROW EXECUTE FUNCTION app.native_routing_configuration_changed();

CREATE FUNCTION app.pending_native_routing_tenants() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT p.tenant_id FROM native_routing_projections p JOIN tenants t ON t.id=p.tenant_id
   WHERE t.state='ACTIVE' AND (p.next_action IS NOT NULL OR (p.sync_state='APPLYING' AND p.claim_expires_at<now())
     OR (p.sync_state='SYNCED' AND p.last_checked_at<now()-interval '5 minutes'))
     AND (p.claim_expires_at IS NULL OR p.claim_expires_at<now()) ORDER BY p.updated_at LIMIT 25
$$;
ALTER FUNCTION app.pending_native_routing_tenants() OWNER TO wasalx_tenant_admin_writer;
REVOKE ALL ON FUNCTION app.pending_native_routing_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_native_routing_tenants() TO wasalx_app;

CREATE FUNCTION app.protect_native_routing_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.zammad_instance_id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.zammad_instance_id)
    OR NEW.desired_revision<OLD.desired_revision OR NEW.applied_revision<OLD.applied_revision THEN
    RAISE EXCEPTION 'Native routing binding is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_routing_immutable BEFORE UPDATE ON native_routing_projections FOR EACH ROW EXECUTE FUNCTION app.protect_native_routing_identity();

-- Seed current linked workspaces without claiming any native state was applied.
INSERT INTO native_routing_projections(tenant_id,zammad_instance_id) SELECT tenant_id,id FROM zammad_instances;
