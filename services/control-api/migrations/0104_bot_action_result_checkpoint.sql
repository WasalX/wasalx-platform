ALTER TABLE bot_action_jobs
  ADD COLUMN execution_result_state text,
  ADD COLUMN execution_result_variables jsonb,
  ADD COLUMN execution_result_safe_error text,
  ADD COLUMN execution_result_recorded_at timestamptz,
  ADD CONSTRAINT bot_action_jobs_execution_result_check CHECK (
    (
      execution_result_state IS NULL
      AND execution_result_variables IS NULL
      AND execution_result_safe_error IS NULL
      AND execution_result_recorded_at IS NULL
    )
    OR (
      state IN ('RUNNING','SUCCEEDED','FAILED_TERMINAL')
      AND execution_result_state IS NOT NULL
      AND execution_result_state = 'SUCCEEDED'
      AND execution_result_variables IS NOT NULL
      AND jsonb_typeof(execution_result_variables) = 'object'
      AND octet_length(execution_result_variables::text) <= 65536
      AND execution_result_safe_error IS NULL
      AND execution_result_recorded_at IS NOT NULL
    )
    OR (
      state IN ('RUNNING','FAILED_TERMINAL')
      AND execution_result_state IS NOT NULL
      AND execution_result_state = 'FAILED_TERMINAL'
      AND execution_result_variables IS NOT NULL
      AND jsonb_typeof(execution_result_variables) = 'object'
      AND octet_length(execution_result_variables::text) <= 65536
      AND execution_result_safe_error IS NOT NULL
      AND length(execution_result_safe_error) BETWEEN 1 AND 500
      AND execution_result_recorded_at IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION app.enforce_bot_action_execution_result_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app
AS $$
BEGIN
  IF OLD.execution_result_recorded_at IS NOT NULL
     AND (
       NEW.execution_result_state IS DISTINCT FROM OLD.execution_result_state
       OR NEW.execution_result_variables IS DISTINCT FROM OLD.execution_result_variables
       OR NEW.execution_result_safe_error IS DISTINCT FROM OLD.execution_result_safe_error
       OR NEW.execution_result_recorded_at IS DISTINCT FROM OLD.execution_result_recorded_at
     ) THEN
    RAISE EXCEPTION 'bot action execution result is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER bot_action_execution_result_immutable
BEFORE UPDATE ON bot_action_jobs
FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_execution_result_immutable();

REVOKE ALL ON FUNCTION app.enforce_bot_action_execution_result_immutable() FROM PUBLIC;
