BEGIN;

ALTER TABLE privacy_legal_holds
  DROP CONSTRAINT privacy_legal_holds_scope_type_check,
  ADD CONSTRAINT privacy_legal_holds_scope_type_check CHECK (
    scope_type IN (
      'TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT',
      'GROUP_BINDING','WHATSAPP_GROUP','ZAMMAD_USER'
    )
  );

-- Earlier GROUP_BINDING holds accepted case-insensitive UUID input. Normalize
-- those rows before enforcing one canonical text representation. If two active
-- holds differ only by UUID case, stop the upgrade so an operator can release
-- the duplicate without silently rewriting legal evidence.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM privacy_legal_holds
     WHERE scope_type IN ('GROUP_BINDING','WHATSAPP_GROUP') AND state='ACTIVE'
     GROUP BY tenant_id,scope_type,lower(scope_value)
    HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION 'duplicate case-variant group legal holds must be resolved before migration'
      USING ERRCODE='23505';
  END IF;
END;
$$;

UPDATE privacy_legal_holds
   SET scope_value=lower(scope_value),
       scope_sha256=encode(digest(
         convert_to(scope_type,'UTF8') || decode('00','hex') || convert_to(lower(scope_value),'UTF8'),
         'sha256'
       ),'hex'),
       updated_at=now()
 WHERE scope_type IN ('GROUP_BINDING','WHATSAPP_GROUP')
   AND scope_value<>lower(scope_value);

ALTER TABLE privacy_legal_holds
  ADD CONSTRAINT privacy_legal_holds_group_uuid_canonical_check CHECK (
    scope_type NOT IN ('GROUP_BINDING','WHATSAPP_GROUP')
    OR scope_value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

-- A workspace hold uses the stable whatsapp_groups identity. This covers
-- captured groups that intentionally have no ticket-trigger binding.
CREATE OR REPLACE FUNCTION app.has_applicable_privacy_hold(
  requested_scope_type text,
  requested_scope_value text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF requested_scope_type NOT IN ('TENANT','ZAMMAD_TICKET','REFERENCE','PARTICIPANT','ZAMMAD_USER')
     OR requested_scope_value IS NULL OR length(requested_scope_value) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'invalid privacy hold scope' USING ERRCODE='22023';
  END IF;

  RETURN EXISTS (
    WITH impacted_tickets AS (
      SELECT DISTINCT correlation.zammad_ticket_id
        FROM case_correlations AS correlation
       WHERE correlation.tenant_id=app.current_tenant_id()
         AND (
           requested_scope_type='TENANT'
           OR (requested_scope_type='ZAMMAD_TICKET' AND correlation.zammad_ticket_id=requested_scope_value)
           OR (requested_scope_type='REFERENCE' AND correlation.normalized_reference=requested_scope_value)
           OR (
             requested_scope_type='PARTICIPANT'
             AND EXISTS (
               SELECT 1 FROM message_links AS link
               JOIN normalized_messages AS message
                 ON message.tenant_id=link.tenant_id
                AND message.connection_id=link.connection_id
                AND message.external_message_id=link.external_message_id
              WHERE link.tenant_id=correlation.tenant_id
                AND link.zammad_ticket_id=correlation.zammad_ticket_id
                AND message.external_participant_id=requested_scope_value
             )
           )
         )
      UNION
      SELECT DISTINCT conversation.zammad_ticket_id
        FROM bot_conversations AS conversation
       WHERE conversation.tenant_id=app.current_tenant_id()
         AND conversation.zammad_ticket_id IS NOT NULL
         AND (
           requested_scope_type='TENANT'
           OR (requested_scope_type='ZAMMAD_TICKET' AND conversation.zammad_ticket_id=requested_scope_value)
           OR (requested_scope_type='REFERENCE' AND conversation.normalized_reference=requested_scope_value)
           OR (requested_scope_type='PARTICIPANT' AND conversation.external_chat_id=requested_scope_value)
         )
      UNION
      SELECT DISTINCT link.zammad_ticket_id
        FROM normalized_messages AS message
        JOIN message_links AS link
          ON link.tenant_id=message.tenant_id
         AND link.connection_id=message.connection_id
         AND link.external_message_id=message.external_message_id
       WHERE message.tenant_id=app.current_tenant_id()
         AND requested_scope_type='ZAMMAD_USER'
         AND message.provider_metadata->>'zammad_customer_id'=requested_scope_value
      UNION
      SELECT requested_scope_value
       WHERE requested_scope_type='ZAMMAD_TICKET'
    )
    SELECT 1
      FROM privacy_legal_holds AS hold
     WHERE hold.tenant_id=app.current_tenant_id()
       AND hold.state='ACTIVE'
       AND (hold.expires_at IS NULL OR hold.expires_at>now())
       AND (
         requested_scope_type='TENANT'
         OR hold.scope_type='TENANT'
         OR (hold.scope_type=requested_scope_type AND hold.scope_value=requested_scope_value)
         OR (hold.scope_type='ZAMMAD_TICKET' AND hold.scope_value IN (SELECT zammad_ticket_id FROM impacted_tickets))
         OR (
           hold.scope_type='REFERENCE'
           AND (
             EXISTS (
               SELECT 1 FROM case_correlations AS correlation
                WHERE correlation.tenant_id=hold.tenant_id
                  AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  AND correlation.normalized_reference=hold.scope_value
             )
             OR EXISTS (
               SELECT 1 FROM bot_conversations AS conversation
                WHERE conversation.tenant_id=hold.tenant_id
                  AND conversation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  AND conversation.normalized_reference=hold.scope_value
             )
           )
         )
         OR (
           hold.scope_type IN ('GROUP_BINDING','WHATSAPP_GROUP')
           AND (
             EXISTS (
               SELECT 1 FROM case_correlations AS correlation
               JOIN group_bindings AS binding
                 ON binding.tenant_id=correlation.tenant_id AND binding.id=correlation.group_binding_id
              WHERE correlation.tenant_id=hold.tenant_id
                AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                AND (
                  (hold.scope_type='GROUP_BINDING' AND binding.id::text=lower(hold.scope_value))
                  OR (hold.scope_type='WHATSAPP_GROUP' AND binding.whatsapp_group_id::text=lower(hold.scope_value))
                )
             )
             OR EXISTS (
               SELECT 1 FROM normalized_messages AS message
               JOIN whatsapp_groups AS group_record
                 ON group_record.tenant_id=message.tenant_id
                AND group_record.connection_id=message.connection_id
                AND group_record.external_group_id=message.external_group_id
               LEFT JOIN group_bindings AS binding
                 ON binding.tenant_id=group_record.tenant_id
                AND binding.whatsapp_group_id=group_record.id
               LEFT JOIN message_links AS link
                 ON link.tenant_id=message.tenant_id
                AND link.connection_id=message.connection_id
                AND link.external_message_id=message.external_message_id
              WHERE message.tenant_id=hold.tenant_id
                AND (
                  (hold.scope_type='GROUP_BINDING' AND binding.id::text=lower(hold.scope_value))
                  OR (hold.scope_type='WHATSAPP_GROUP' AND group_record.id::text=lower(hold.scope_value))
                )
                AND (
                  (requested_scope_type='PARTICIPANT' AND message.external_participant_id=requested_scope_value)
                  OR (requested_scope_type='ZAMMAD_USER' AND message.provider_metadata->>'zammad_customer_id'=requested_scope_value)
                  OR link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                )
             )
           )
         )
         OR (
           hold.scope_type='ZAMMAD_USER'
           AND EXISTS (
             SELECT 1 FROM normalized_messages AS message
             LEFT JOIN message_links AS link
               ON link.tenant_id=message.tenant_id
              AND link.connection_id=message.connection_id
              AND link.external_message_id=message.external_message_id
              WHERE message.tenant_id=hold.tenant_id
                AND message.provider_metadata->>'zammad_customer_id'=hold.scope_value
                AND (
                  link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  OR (
                    requested_scope_type='PARTICIPANT'
                    AND message.external_participant_id=requested_scope_value
                  )
                )
           )
         )
         OR (
           hold.scope_type='PARTICIPANT'
           AND (
             EXISTS (
               SELECT 1 FROM message_links AS link
               JOIN normalized_messages AS message
                 ON message.tenant_id=link.tenant_id
                AND message.connection_id=link.connection_id
                AND message.external_message_id=link.external_message_id
              WHERE link.tenant_id=hold.tenant_id
                AND link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                AND message.external_participant_id=hold.scope_value
             )
             OR EXISTS (
               SELECT 1 FROM bot_conversations AS conversation
                WHERE conversation.tenant_id=hold.tenant_id
                  AND conversation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                  AND conversation.external_chat_id=hold.scope_value
             )
           )
         )
       )
  );
END;
$$;

COMMIT;
