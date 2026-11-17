ALTER TABLE bot_action_definitions
  DROP CONSTRAINT bot_action_definitions_endpoint_url_check,
  DROP CONSTRAINT bot_action_definitions_secret_reference_check;

ALTER TABLE bot_action_definitions
  ADD CONSTRAINT bot_action_definitions_endpoint_url_check
    CHECK (length(endpoint_url) BETWEEN 10 AND 2048 AND endpoint_url ~ '^https://[^[:space:]]+$'),
  ADD CONSTRAINT bot_action_definitions_secret_reference_check
    CHECK (
      secret_reference IS NULL
      OR (
        length(secret_reference) BETWEEN 10 AND 509
        AND secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
      )
    );
