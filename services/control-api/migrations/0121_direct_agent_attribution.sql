BEGIN;

ALTER TABLE bot_assignments
  ADD COLUMN agent_prefix text NOT NULL DEFAULT 'Agent:'
    CHECK (char_length(btrim(agent_prefix)) BETWEEN 1 AND 80),
  ADD COLUMN agent_identity_placement text NOT NULL DEFAULT 'HEADER'
    CHECK (agent_identity_placement IN ('HEADER','FOOTER','OFF'));

COMMIT;
