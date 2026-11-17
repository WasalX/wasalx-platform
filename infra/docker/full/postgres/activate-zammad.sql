\set ON_ERROR_STOP on

BEGIN;

DO $activation$
DECLARE
  activated_rows integer;
BEGIN
  UPDATE zammad_instances
     SET state = 'WORKING',
         last_healthy_at = now()
   WHERE id = '00000000-0000-4000-8000-000000000003'
     AND tenant_id = '00000000-0000-4000-8000-000000000001'
     AND base_url = 'http://zammad-nginx:8080'
     AND version = '7.1.3-0000'
     AND service_secret_reference = 'secret://tenants/00000000-0000-4000-8000-000000000001/zammad/service'
     AND state IN ('PROVISIONING', 'WORKING');

  GET DIAGNOSTICS activated_rows = ROW_COUNT;
  IF activated_rows <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one verified local Zammad instance, updated %', activated_rows;
  END IF;
END
$activation$;

COMMIT;
