ALTER TABLE bot_action_definitions
  DROP CONSTRAINT IF EXISTS bot_action_definitions_tenant_secret_check;

INSERT INTO audit_events(
  tenant_id,actor_type,actor_id,action,target_type,target_id,
  previous_value,new_value,request_id
)
SELECT action.tenant_id,'SYSTEM','system:migration','bot_action.credential_rotation_required',
  'bot_action_definition',action.id::text,
  jsonb_build_object('state',action.state,'revision',action.revision),
  jsonb_build_object('state','PAUSED','revision',action.revision,'reason','CREDENTIAL_OWNERSHIP'),
  'migration:0103:bot-action-credential:'||action.id::text
FROM bot_action_definitions action
WHERE action.state<>'PAUSED'
  AND action.secret_reference IS NOT NULL
  AND action.secret_reference<>(
    'secret://tenants/'||action.tenant_id::text||'/bot-actions/'||action.action_key
  )
  AND NOT (
    action.kind='NOTION_CREATE_PAGE'
    AND action.secret_reference~(
      '^secret://tenants/'||action.tenant_id::text||'/routing/integrations/[0-9a-f-]{36}$'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_events event
    WHERE event.tenant_id=action.tenant_id
      AND event.request_id='migration:0103:bot-action-credential:'||action.id::text
  );

UPDATE bot_action_definitions action
SET state='PAUSED',updated_at=now()
WHERE action.state<>'PAUSED'
  AND action.secret_reference IS NOT NULL
  AND action.secret_reference<>(
    'secret://tenants/'||action.tenant_id::text||'/bot-actions/'||action.action_key
  )
  AND NOT (
    action.kind='NOTION_CREATE_PAGE'
    AND action.secret_reference~(
      '^secret://tenants/'||action.tenant_id::text||'/routing/integrations/[0-9a-f-]{36}$'
    )
  );

ALTER TABLE bot_action_definitions
  ADD CONSTRAINT bot_action_definitions_tenant_secret_check
  CHECK (
    secret_reference IS NULL
    OR (
      kind = 'HTTP_JSON'
      AND secret_reference = (
        'secret://tenants/' || tenant_id::text || '/bot-actions/' || action_key
      )
    )
    OR (
      kind = 'NOTION_CREATE_PAGE'
      AND (
        secret_reference = (
          'secret://tenants/' || tenant_id::text || '/bot-actions/' || action_key
        )
        OR secret_reference ~ (
          '^secret://tenants/' || tenant_id::text || '/routing/integrations/[0-9a-f-]{36}$'
        )
      )
    )
    OR (
      state='PAUSED'
      AND secret_reference~(
        '^secret://tenants/'||tenant_id::text||'/bot-actions/[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
      )
    )
  ) NOT VALID;

ALTER TABLE bot_action_definitions
  VALIDATE CONSTRAINT bot_action_definitions_tenant_secret_check;
