ALTER TABLE bot_action_definitions
  DROP CONSTRAINT bot_action_definitions_tenant_secret_check,
  ADD CONSTRAINT bot_action_definitions_tenant_secret_check
  CHECK (
    secret_reference IS NULL
    OR secret_reference ~ (
      '^secret://tenants/' || tenant_id::text || '/bot-actions/[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
    )
    OR (
      kind = 'NOTION_CREATE_PAGE'
      AND secret_reference ~ (
        '^secret://tenants/' || tenant_id::text || '/routing/integrations/[0-9a-f-]{36}$'
      )
    )
  );
