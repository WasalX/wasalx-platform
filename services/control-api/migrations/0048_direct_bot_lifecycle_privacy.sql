ALTER TABLE bot_conversations
  DROP CONSTRAINT bot_conversations_tenant_id_assignment_id_external_chat_id_key;

CREATE UNIQUE INDEX bot_conversations_active_identity_uq
  ON bot_conversations (tenant_id,assignment_id,external_chat_id)
  WHERE state<>'RESOLVED';

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
               SELECT 1
                 FROM message_links AS link
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
           OR (requested_scope_type='PARTICIPANT' AND conversation.external_chat_id=requested_scope_value)
         )
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
         OR (
           requested_scope_type<>'ZAMMAD_USER'
           AND (
             (hold.scope_type='ZAMMAD_TICKET' AND hold.scope_value IN (SELECT zammad_ticket_id FROM impacted_tickets))
             OR (
               hold.scope_type='REFERENCE'
               AND EXISTS (
                 SELECT 1 FROM case_correlations AS correlation
                  WHERE correlation.tenant_id=hold.tenant_id
                    AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                    AND correlation.normalized_reference=hold.scope_value
               )
             )
             OR (
               hold.scope_type='GROUP_BINDING'
               AND EXISTS (
                 SELECT 1 FROM case_correlations AS correlation
                  WHERE correlation.tenant_id=hold.tenant_id
                    AND correlation.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                    AND correlation.group_binding_id::text=hold.scope_value
               )
             )
             OR (
               hold.scope_type='PARTICIPANT'
               AND EXISTS (
                 SELECT 1
                   FROM message_links AS link
                   JOIN normalized_messages AS message
                     ON message.tenant_id=link.tenant_id
                    AND message.connection_id=link.connection_id
                    AND message.external_message_id=link.external_message_id
                  WHERE link.tenant_id=hold.tenant_id
                    AND link.zammad_ticket_id IN (SELECT zammad_ticket_id FROM impacted_tickets)
                    AND message.external_participant_id=hold.scope_value
               )
             )
           )
         )
       )
  );
END;
$$;
