ALTER TABLE bot_action_definitions
  ADD CONSTRAINT bot_action_definitions_tenant_secret_check
  CHECK (
    secret_reference IS NULL
    OR secret_reference ~ (
      '^secret://tenants/' || tenant_id::text || '/bot-actions/[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
    )
  );
