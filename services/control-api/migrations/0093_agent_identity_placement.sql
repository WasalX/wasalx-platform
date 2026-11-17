ALTER TABLE group_bindings
  ADD COLUMN agent_identity_placement text NOT NULL DEFAULT 'HEADER',
  ADD CONSTRAINT group_bindings_agent_identity_placement_check
    CHECK (agent_identity_placement IN ('HEADER', 'FOOTER', 'OFF'));

ALTER TABLE delivery_outbox
  ADD COLUMN agent_identity_placement_snapshot text,
  ADD CONSTRAINT delivery_outbox_agent_identity_placement_snapshot_check
    CHECK (
      agent_identity_placement_snapshot IS NULL
      OR agent_identity_placement_snapshot IN ('HEADER', 'FOOTER', 'OFF')
    );
