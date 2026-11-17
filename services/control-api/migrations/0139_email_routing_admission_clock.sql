CREATE OR REPLACE FUNCTION app.activate_client_routing_version(
  requested_version_id uuid,
  expected_revision bigint,
  expected_active_version_id uuid,
  requested_by uuid
)
RETURNS TABLE (active_version_id uuid,retired_version_id uuid,revision bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,app
SET row_security=off
AS $$
DECLARE current_tenant uuid;
DECLARE target public.client_routing_versions%ROWTYPE;
DECLARE active public.client_routing_versions%ROWTYPE;
DECLARE transition_time timestamptz;
BEGIN
  current_tenant:=app.current_tenant_id();
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_memberships
     WHERE tenant_id=current_tenant AND user_id=requested_by
       AND role IN ('tenant_owner','tenant_admin')
  ) THEN
    RAISE EXCEPTION 'client routing actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('client-routing:'||current_tenant::text,0));
  SELECT routing.* INTO target FROM public.client_routing_versions routing
   WHERE routing.tenant_id=current_tenant AND routing.id=requested_version_id FOR UPDATE;
  IF NOT FOUND OR target.state<>'DRAFT' OR target.revision<>expected_revision THEN
    RAISE EXCEPTION 'client routing draft changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  SELECT routing.* INTO active FROM public.client_routing_versions routing
   WHERE routing.tenant_id=current_tenant AND routing.state='ACTIVE' FOR UPDATE;
  IF active.id IS DISTINCT FROM expected_active_version_id THEN
    RAISE EXCEPTION 'active client routing changed; refresh before activation' USING ERRCODE='40001';
  END IF;
  transition_time:=clock_timestamp();
  IF active.id IS NOT NULL THEN
    UPDATE public.client_routing_versions routing
       SET state='RETIRED',revision=routing.revision+1,retired_at=transition_time,retired_by=requested_by,
           retired_actor_type='USER',retired_sync_job_id=NULL
     WHERE routing.tenant_id=current_tenant AND routing.id=active.id;
  END IF;
  UPDATE public.client_routing_versions routing
     SET state='ACTIVE',revision=routing.revision+1,activated_at=transition_time,activated_by=requested_by,
         activated_actor_type='USER',activated_sync_job_id=NULL
   WHERE routing.tenant_id=current_tenant AND routing.id=target.id
   RETURNING routing.revision INTO target.revision;
  RETURN QUERY SELECT target.id,active.id,target.revision;
END;
$$;

CREATE OR REPLACE FUNCTION app.pin_automatic_client_routing_transition_clock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE shared_transition_time timestamptz;
BEGIN
  IF OLD.state='ACTIVE' AND NEW.state='RETIRED'
     AND NEW.retired_actor_type='SYSTEM' AND NEW.retired_sync_job_id IS NOT NULL THEN
    NEW.retired_at:=clock_timestamp();
  ELSIF OLD.state='DRAFT' AND NEW.state='ACTIVE'
     AND NEW.activated_actor_type='SYSTEM' AND NEW.activated_sync_job_id IS NOT NULL THEN
    SELECT routing.retired_at INTO shared_transition_time
      FROM client_routing_versions routing
     WHERE routing.tenant_id=NEW.tenant_id
       AND routing.retired_sync_job_id=NEW.activated_sync_job_id
       AND routing.state='RETIRED'
     ORDER BY routing.retired_at DESC,routing.id
     LIMIT 1;
    IF shared_transition_time IS NULL THEN
      RAISE EXCEPTION 'automatic routing transition clock is unavailable'
        USING ERRCODE='23514';
    END IF;
    NEW.activated_at:=shared_transition_time;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.pin_automatic_client_routing_transition_clock() FROM PUBLIC;
CREATE TRIGGER client_routing_versions_pin_automatic_transition_clock
BEFORE UPDATE OF state ON client_routing_versions
FOR EACH ROW EXECUTE FUNCTION app.pin_automatic_client_routing_transition_clock();
