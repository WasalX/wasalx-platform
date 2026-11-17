ALTER TABLE bot_conversations
  ADD COLUMN resolution_kind text;

UPDATE bot_conversations
   SET resolution_kind='FLOW'
 WHERE state='RESOLVED';

ALTER TABLE bot_conversations
  ADD CONSTRAINT bot_conversations_resolution_kind_check CHECK (
    (state='RESOLVED' AND resolution_kind IN ('FLOW','OPERATOR'))
    OR (state<>'RESOLVED' AND resolution_kind IS NULL)
  );
