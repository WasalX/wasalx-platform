-- Bot articles are projected by the ordered delivery worker, including nonmedia replies.
ALTER TABLE delivery_outbox
  DROP CONSTRAINT delivery_outbox_origin_shape,
  ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
    (content_redacted_at IS NOT NULL
      AND group_binding_id IS NULL AND group_workspace_group_id IS NULL
      AND bot_conversation_id IS NULL AND external_chat_id IS NULL
      AND bot_content IS NULL AND direct_origin IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
    OR
    (content_redacted_at IS NULL
      AND delivery_origin='TICKET'
      AND (
        (zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
        OR
        (bot_conversation_id IS NOT NULL AND direct_origin='BOT'
          AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL)
        OR
        (group_binding_id IS NOT NULL AND bot_conversation_id IS NULL
          AND group_workspace_group_id IS NULL AND direct_origin IS NULL
          AND external_chat_id IS NULL AND bot_content IS NULL
          AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
          AND reply_to_message_id IS NOT NULL
          AND idempotency_key LIKE 'ack:%')
      ))
    OR
    (content_redacted_at IS NULL
      AND delivery_origin='GROUP_WORKSPACE' AND group_workspace_group_id IS NOT NULL
      AND group_binding_id IS NULL AND bot_conversation_id IS NULL
      AND external_chat_id IS NULL AND bot_content IS NULL
      AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL)
  );
