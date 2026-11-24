-- The overview's month must follow the UTC dates stored in usage_daily_rollups.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('app.operator_platform_operations_overview(text,text)'::regprocedure);
  previous_cutoff constant text := 'usage_day>=date_trunc(''month'',current_date)::date';
  utc_cutoff constant text := 'usage_day>=date_trunc(''month'',now() AT TIME ZONE ''UTC'')::date';
BEGIN
  IF cardinality(string_to_array(definition,previous_cutoff)) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'Platform operations overview must contain exactly one expected month cutoff';
  END IF;
  EXECUTE replace(definition,previous_cutoff,utc_cutoff);
END;
$migration$;
