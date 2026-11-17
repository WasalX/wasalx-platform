-- Mentions remain attached to the one durable outbound delivery. Only
-- provider participant IDs observed in the authorized group are accepted by
-- the control API; this database guard preserves the bounded wire shape.
CREATE FUNCTION app.valid_group_mentions(input_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(input_values) <= 20
     AND cardinality(input_values) = (SELECT count(DISTINCT value) FROM unnest(input_values) value)
     AND COALESCE((SELECT bool_and(value ~ '^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net)$') FROM unnest(input_values) value),true)
$$;

ALTER TABLE delivery_outbox
  ADD COLUMN mentions text[] NOT NULL DEFAULT '{}'::text[],
  ADD CONSTRAINT delivery_outbox_mentions_valid CHECK (app.valid_group_mentions(mentions));
