CREATE TABLE group_action_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_inbox_id uuid NOT NULL,
  trigger_rule_id uuid NOT NULL,
  action_definition_id uuid NOT NULL,
  action_key text NOT NULL CHECK (action_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  action_revision bigint NOT NULL CHECK (action_revision>0),
  action_snapshot jsonb NOT NULL CHECK (jsonb_typeof(action_snapshot)='object' AND octet_length(action_snapshot::text)<=32768),
  request_input jsonb NOT NULL CHECK (jsonb_typeof(request_input)='object' AND octet_length(request_input::text)<=65536),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'PREPARED'
    CHECK (state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','SUCCEEDED','FAILED_TERMINAL','OUTCOME_UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 25),
  response_variables jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(response_variables)='object' AND octet_length(response_variables::text)<=65536),
  safe_error text CHECK (safe_error IS NULL OR length(safe_error)<=500),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,event_inbox_id,trigger_rule_id),
  FOREIGN KEY (tenant_id,event_inbox_id) REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,trigger_rule_id) REFERENCES trigger_rules(tenant_id,id),
  FOREIGN KEY (tenant_id,action_definition_id) REFERENCES bot_action_definitions(tenant_id,id),
  CHECK (
    (state IN ('PREPARED','RUNNING','FAILED_RETRYABLE') AND completed_at IS NULL)
    OR (state IN ('SUCCEEDED','FAILED_TERMINAL','OUTCOME_UNKNOWN') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX group_action_executions_review_idx
  ON group_action_executions (tenant_id,updated_at,id)
  WHERE state='OUTCOME_UNKNOWN';

ALTER TABLE group_action_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_action_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_action_executions
  USING (tenant_id=app.current_tenant_id())
  WITH CHECK (tenant_id=app.current_tenant_id());

GRANT SELECT,INSERT,UPDATE ON group_action_executions TO wasalx_app;
