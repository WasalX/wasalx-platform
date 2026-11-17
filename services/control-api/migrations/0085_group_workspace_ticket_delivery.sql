-- A ticket created from the Zammad group workspace may route through the
-- captured group itself when no automation binding exists. It remains a
-- ticket delivery because Zammad ticket/article identities are present.
ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_origin_shape,
  ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
    (delivery_origin='TICKET'
      AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
    OR
    (delivery_origin='GROUP_WORKSPACE' AND group_workspace_group_id IS NOT NULL
      AND group_binding_id IS NULL AND bot_conversation_id IS NULL
      AND external_chat_id IS NULL AND bot_content IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
  );
