ALTER TABLE group_bindings
  ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE TABLE group_binding_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_binding_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  changed_by uuid REFERENCES users(id),
  request_id text NOT NULL CHECK (
    length(request_id) BETWEEN 1 AND 255
    AND request_id !~ '[[:cntrl:]]'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, group_binding_id, revision),
  FOREIGN KEY (tenant_id, group_binding_id)
    REFERENCES group_bindings(tenant_id, id) ON DELETE CASCADE
);

INSERT INTO group_binding_versions (
  tenant_id, group_binding_id, revision, snapshot, snapshot_sha256, request_id, created_at
)
SELECT binding.tenant_id,
       binding.id,
       binding.revision,
       snapshot.value,
       encode(digest(snapshot.value::text, 'sha256'), 'hex'),
       'migration-0113',
       binding.created_at
  FROM group_bindings binding
  JOIN whatsapp_groups group_record
    ON group_record.tenant_id = binding.tenant_id
   AND group_record.id = binding.whatsapp_group_id
 CROSS JOIN LATERAL (
   SELECT jsonb_build_object(
     'displayName', COALESCE(group_record.wasalx_name, group_record.display_name),
     'ruleSetId', binding.rule_set_id,
     'zammadGroupId', binding.zammad_group_id,
     'defaultPriority', binding.default_priority,
     'assignmentMode', binding.assignment_mode,
     'fixedOwnerId', binding.fixed_owner_id,
     'slaPolicyId', binding.sla_policy_id,
     'businessHoursMode', binding.business_hours_mode,
     'businessHoursCalendarId', binding.business_hours_calendar_id,
     'acknowledgementTemplate', binding.acknowledgement_template,
     'agentPrefix', binding.agent_prefix,
     'agentIdentityPlacement', binding.agent_identity_placement,
     'maxIdentifiers', binding.max_identifiers,
     'mediaEnabled', binding.media_enabled,
     'retentionDays', binding.retention_days,
     'state', binding.state
   ) AS value
 ) snapshot;

ALTER TABLE group_binding_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_binding_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON group_binding_versions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE TRIGGER group_binding_versions_append_only
BEFORE UPDATE OR DELETE ON group_binding_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_audit_mutation();

CREATE OR REPLACE FUNCTION app.record_group_binding_version(
  binding_id_value uuid,
  revision_value bigint,
  changed_by_value uuid,
  request_id_value text
)
RETURNS void
LANGUAGE plpgsql
SET search_path=pg_catalog,public,app AS $$
BEGIN
  INSERT INTO group_binding_versions (
    tenant_id,group_binding_id,revision,snapshot,snapshot_sha256,changed_by,request_id
  )
  SELECT binding.tenant_id,binding.id,binding.revision,snapshot.value,
         encode(digest(snapshot.value::text,'sha256'),'hex'),changed_by_value,request_id_value
    FROM group_bindings binding
    JOIN whatsapp_groups group_record
      ON group_record.tenant_id=binding.tenant_id AND group_record.id=binding.whatsapp_group_id
   CROSS JOIN LATERAL (SELECT jsonb_build_object(
     'displayName',COALESCE(group_record.wasalx_name,group_record.display_name),
     'ruleSetId',binding.rule_set_id,'zammadGroupId',binding.zammad_group_id,
     'defaultPriority',binding.default_priority,'assignmentMode',binding.assignment_mode,
     'fixedOwnerId',binding.fixed_owner_id,'slaPolicyId',binding.sla_policy_id,
     'businessHoursMode',binding.business_hours_mode,'businessHoursCalendarId',binding.business_hours_calendar_id,
     'acknowledgementTemplate',binding.acknowledgement_template,'agentPrefix',binding.agent_prefix,
     'agentIdentityPlacement',binding.agent_identity_placement,'maxIdentifiers',binding.max_identifiers,
     'mediaEnabled',binding.media_enabled,'retentionDays',binding.retention_days,'state',binding.state
   ) AS value) snapshot
   WHERE binding.tenant_id=app.current_tenant_id()
     AND binding.id=binding_id_value AND binding.revision=revision_value
     AND (changed_by_value IS NULL OR EXISTS (
       SELECT 1 FROM tenant_memberships membership
        WHERE membership.tenant_id=binding.tenant_id AND membership.user_id=changed_by_value
     ));
  IF NOT FOUND THEN RAISE EXCEPTION 'Group binding revision could not be captured'; END IF;
END
$$;

ALTER TABLE bot_flow_operations DROP CONSTRAINT bot_flow_operations_action_check;
ALTER TABLE bot_flow_operations ADD CONSTRAINT bot_flow_operations_action_check
  CHECK (action IN (
    'CREATE','CLONE','ACTIVATE','ASSIGN','ASSIGNMENT_STATE','CONVERSATION_COMMAND',
    'ROUTING_CREATE','ROUTING_ACTIVATE','ROUTING_SYNC','ACTION_SAVE',
    'GROUP_WORKSPACE_DEFAULTS','GROUP_WORKSPACE_CAPTURE','GROUP_WORKSPACE_GRANT','GROUP_WORKSPACE_REVOKE',
    'GROUP_BINDING_SAVE','GROUP_BINDING_TOGGLE','DELIVERY_RETRY'
  ));

GRANT SELECT, INSERT ON group_binding_versions TO wasalx_app;
REVOKE UPDATE, DELETE, TRUNCATE ON group_binding_versions FROM PUBLIC, wasalx_app;
REVOKE ALL ON FUNCTION app.record_group_binding_version(uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_group_binding_version(uuid,bigint,uuid,text) TO wasalx_app;
