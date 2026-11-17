-- Linked-device group rosters may identify participants with WhatsApp LIDs.
-- Keep the database contract aligned with the API's bounded mention format.
CREATE OR REPLACE FUNCTION app.valid_group_mentions(input_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT cardinality(input_values) <= 20
     AND cardinality(input_values) = (SELECT count(DISTINCT value) FROM unnest(input_values) value)
     AND COALESCE((SELECT bool_and(value ~ '^[1-9][0-9]{5,19}@(c\.us|s\.whatsapp\.net|lid)$') FROM unnest(input_values) value),true)
$$;
