ALTER TABLE delivery_outbox
  ADD COLUMN direct_origin text;

UPDATE delivery_outbox
   SET direct_origin=CASE
     WHEN idempotency_key LIKE 'bot:%' OR idempotency_key LIKE 'bot-action:%' THEN 'BOT'
     ELSE 'HUMAN'
   END
 WHERE bot_conversation_id IS NOT NULL;

ALTER TABLE delivery_outbox
  ADD CONSTRAINT delivery_outbox_direct_origin_check CHECK (
    (bot_conversation_id IS NULL AND direct_origin IS NULL)
    OR (bot_conversation_id IS NOT NULL AND direct_origin IN ('BOT','HUMAN'))
  );
