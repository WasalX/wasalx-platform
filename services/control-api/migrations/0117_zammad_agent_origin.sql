ALTER TABLE zammad_instances
  ADD COLUMN agent_base_url text;

ALTER TABLE zammad_instances
  ADD CONSTRAINT zammad_instances_agent_base_url_check CHECK (
    agent_base_url IS NULL OR (
      octet_length(agent_base_url) <= 2048
      AND (
        agent_base_url ~ '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?$'
        OR agent_base_url ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?/?$'
      )
    )
  );

CREATE OR REPLACE FUNCTION app.verified_zammad_agent_base_url(
  tenant_value uuid,
  instance_value uuid,
  service_base_url_value text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
  SELECT operation.step_results #>> '{zammad,zammad_base_url}'
    FROM provisioning_operations operation
   WHERE operation.tenant_id=tenant_value
     AND operation.zammad_instance_id=instance_value
     AND operation.action='PROVISION'
     AND operation.status='COMPLETE'
     AND operation.completed_at IS NOT NULL
     AND operation.step_results #>> '{zammad,zammad_base_url}' = service_base_url_value
     AND operation.step_results #>> '{health,zammad_base_url}' = service_base_url_value
     AND operation.step_results #>> '{health,healthy}' = 'true'
     AND operation.step_results #>> '{health,isolation_verified}' = 'true'
     AND service_base_url_value ~ '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?$'
   LIMIT 1
$$;

WITH verified AS (
  SELECT instance.id,
         app.verified_zammad_agent_base_url(
           instance.tenant_id,
           instance.id,
           instance.base_url
         ) AS agent_base_url
    FROM zammad_instances instance
   WHERE instance.agent_base_url IS NULL
)
UPDATE zammad_instances instance
   SET agent_base_url=verified.agent_base_url
  FROM verified
 WHERE instance.id=verified.id
   AND verified.agent_base_url IS NOT NULL;

CREATE OR REPLACE FUNCTION app.apply_verified_zammad_agent_base_url()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app
SET row_security=off
AS $$
DECLARE verified_base_url text;
BEGIN
  IF TG_OP='INSERT' AND NEW.agent_base_url IS NOT NULL THEN
    RETURN NEW;
  ELSIF TG_OP='UPDATE' AND (
    NEW.agent_base_url IS DISTINCT FROM OLD.agent_base_url
    OR (OLD.agent_base_url IS NOT NULL AND OLD.agent_base_url IS DISTINCT FROM OLD.base_url)
  ) THEN
    RETURN NEW;
  END IF;
  verified_base_url := app.verified_zammad_agent_base_url(
    NEW.tenant_id,
    NEW.id,
    NEW.base_url
  );
  NEW.agent_base_url := verified_base_url;
  RETURN NEW;
END
$$;

CREATE TRIGGER zammad_instances_verified_agent_base_url
BEFORE INSERT OR UPDATE OF base_url ON zammad_instances
FOR EACH ROW EXECUTE FUNCTION app.apply_verified_zammad_agent_base_url();

REVOKE ALL ON FUNCTION app.verified_zammad_agent_base_url(uuid,uuid,text),
  app.apply_verified_zammad_agent_base_url() FROM PUBLIC;
