ALTER TABLE bot_conversations DROP CONSTRAINT bot_conversations_step_count_check;
ALTER TABLE bot_conversations ADD CONSTRAINT bot_conversations_step_count_check CHECK (step_count>=0);
