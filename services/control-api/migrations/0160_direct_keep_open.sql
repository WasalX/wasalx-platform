-- Policy remains in the existing immutable flow definition; absent stays legacy-off.
ALTER TABLE bot_conversations
  ADD COLUMN human_ownership_epoch bigint NOT NULL DEFAULT 0 CHECK(human_ownership_epoch>=0),
  ADD COLUMN human_pause_started_at timestamptz,
  ADD COLUMN zammad_customer_id bigint CHECK(zammad_customer_id>0),
  ADD COLUMN customer_control jsonb CHECK(customer_control IS NULL OR
    (jsonb_typeof(customer_control)='object' AND octet_length(customer_control::text)<=8192));
ALTER TABLE delivery_outbox ADD COLUMN direct_ownership_epoch bigint CHECK(direct_ownership_epoch>=0);
ALTER TABLE bot_conversations DROP CONSTRAINT bot_conversations_resolution_kind_check;
ALTER TABLE bot_conversations ADD CONSTRAINT bot_conversations_resolution_kind_check CHECK(
  (state='RESOLVED' AND resolution_kind IN ('FLOW','OPERATOR','CUSTOMER_CONFIRMED'))
  OR (state<>'RESOLVED' AND resolution_kind IS NULL));

CREATE TABLE direct_native_reply_intents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  native_ticket_id text NOT NULL CHECK(native_ticket_id ~ '^[1-9][0-9]{0,15}$'),
  native_actor_id text NOT NULL CHECK(native_actor_id ~ '^[1-9][0-9]{0,15}$'),
  human_ownership_epoch bigint NOT NULL CHECK(human_ownership_epoch>=0),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','ADMITTED','OUTCOME_UNKNOWN','CANCELLED_PROVEN_ABSENT')),
  native_article_id text CHECK(native_article_id ~ '^[1-9][0-9]{0,15}$'),
  delivery_id uuid,
  reconciliation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES bot_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,instance_id) REFERENCES zammad_instances(tenant_id,id),
  FOREIGN KEY(tenant_id,delivery_id) REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE,
  CHECK((state='ADMITTED' AND native_article_id IS NOT NULL AND delivery_id IS NOT NULL)
    OR (state<>'ADMITTED' AND native_article_id IS NULL AND delivery_id IS NULL)),
  CHECK((state IN ('ADMITTED','CANCELLED_PROVEN_ABSENT'))=(completed_at IS NOT NULL)),
  CHECK(state<>'CANCELLED_PROVEN_ABSENT' OR (reconciliation IS NOT NULL AND jsonb_typeof(reconciliation)='object'
    AND (reconciliation->>'native_ticket_locked'='true') IS TRUE AND (reconciliation->>'article_absent'='true') IS TRUE))
);
CREATE INDEX direct_native_reply_intents_pending ON direct_native_reply_intents(tenant_id,conversation_id)
  WHERE state IN ('PENDING','OUTCOME_UNKNOWN');

CREATE TABLE direct_customer_close_commands (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  request_event_id uuid NOT NULL,
  confirmation_event_id uuid NOT NULL,
  confirmation_prompt_delivery_id uuid NOT NULL,
  human_ownership_epoch bigint NOT NULL CHECK(human_ownership_epoch>=0),
  conversation_fencing_token bigint NOT NULL CHECK(conversation_fencing_token>=0),
  request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED','FAILED_TERMINAL')),
  native_action_snapshot jsonb,
  native_attempted_at timestamptz,
  native_result jsonb,
  lease_id uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,confirmation_event_id),
  FOREIGN KEY(tenant_id,conversation_id) REFERENCES bot_conversations(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,request_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,confirmation_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,confirmation_prompt_delivery_id) REFERENCES delivery_outbox(tenant_id,id) ON DELETE CASCADE,
  CHECK((state='QUEUED' AND native_attempted_at IS NULL)
    OR (state IN ('ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED') AND native_attempted_at IS NOT NULL)
    OR (state='FAILED_TERMINAL' AND (native_attempted_at IS NOT NULL OR (native_result->>'state'='NOT_ATTEMPTED') IS TRUE))),
  CHECK(state='QUEUED' OR (native_action_snapshot IS NOT NULL AND jsonb_typeof(native_action_snapshot)='object')),
  CHECK((state IN ('SUCCEEDED','FAILED_TERMINAL'))=(completed_at IS NOT NULL AND native_result IS NOT NULL)),
  CHECK((lease_id IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX direct_customer_close_one_pending ON direct_customer_close_commands(tenant_id,conversation_id)
  WHERE state IN ('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN');

CREATE FUNCTION app.enforce_direct_native_reply_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.conversation_id,NEW.instance_id,NEW.native_ticket_id,NEW.native_actor_id,
    NEW.human_ownership_epoch,NEW.request_sha256,NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id,OLD.tenant_id,OLD.conversation_id,OLD.instance_id,OLD.native_ticket_id,OLD.native_actor_id,
    OLD.human_ownership_epoch,OLD.request_sha256,OLD.created_at)
    OR OLD.state NOT IN ('PENDING','OUTCOME_UNKNOWN') OR NEW.state NOT IN ('ADMITTED','OUTCOME_UNKNOWN','CANCELLED_PROVEN_ABSENT') THEN
    RAISE EXCEPTION 'Direct reply intent is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER direct_native_reply_intents_immutable BEFORE UPDATE ON direct_native_reply_intents
  FOR EACH ROW EXECUTE FUNCTION app.enforce_direct_native_reply_intent();
CREATE FUNCTION app.enforce_direct_customer_close_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.id,NEW.tenant_id,NEW.conversation_id,NEW.request_event_id,NEW.confirmation_event_id,
    NEW.confirmation_prompt_delivery_id,NEW.human_ownership_epoch,NEW.conversation_fencing_token,NEW.request_sha256,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.conversation_id,OLD.request_event_id,OLD.confirmation_event_id,
    OLD.confirmation_prompt_delivery_id,OLD.human_ownership_epoch,OLD.conversation_fencing_token,OLD.request_sha256,OLD.created_at)
    OR OLD.state IN ('SUCCEEDED','FAILED_TERMINAL') THEN
    RAISE EXCEPTION 'Customer close identity is immutable' USING ERRCODE='55000'; END IF;
  IF OLD.state<>'QUEUED' AND ROW(NEW.native_action_snapshot,NEW.native_attempted_at) IS DISTINCT FROM
    ROW(OLD.native_action_snapshot,OLD.native_attempted_at) THEN
    RAISE EXCEPTION 'Customer close native snapshot is immutable' USING ERRCODE='55000'; END IF;
  IF NOT ((OLD.state='QUEUED' AND NEW.state IN ('QUEUED','ATTEMPTED','FAILED_TERMINAL'))
    OR (OLD.state='ATTEMPTED' AND NEW.state IN ('ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED','FAILED_TERMINAL'))
    OR (OLD.state='OUTCOME_UNKNOWN' AND NEW.state IN ('OUTCOME_UNKNOWN','SUCCEEDED','FAILED_TERMINAL'))) THEN
    RAISE EXCEPTION 'Customer close outcome cannot be replayed' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER direct_customer_close_commands_immutable BEFORE UPDATE ON direct_customer_close_commands
  FOR EACH ROW EXECUTE FUNCTION app.enforce_direct_customer_close_command();
-- Parent privacy cascades must not erase unresolved native evidence. A completed
-- close is detached explicitly while its resolved conversation is still visible.
CREATE FUNCTION app.preserve_direct_native_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
  IF TG_TABLE_NAME='direct_native_reply_intents' AND OLD.state IN ('PENDING','OUTCOME_UNKNOWN') THEN
    RAISE EXCEPTION 'Unresolved direct reply evidence cannot be deleted' USING ERRCODE='55000';
  ELSIF TG_TABLE_NAME='direct_customer_close_commands' THEN
    IF OLD.state IN ('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN') OR (OLD.state='SUCCEEDED' AND NOT EXISTS (
      SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=OLD.tenant_id AND conversation.id=OLD.conversation_id
        AND (conversation.state='RESOLVED' OR conversation.fencing_token<>OLD.conversation_fencing_token))) THEN
      RAISE EXCEPTION 'Unresolved direct close evidence cannot be deleted' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER direct_native_reply_intents_preserve BEFORE DELETE ON direct_native_reply_intents
  FOR EACH ROW EXECUTE FUNCTION app.preserve_direct_native_evidence();
CREATE TRIGGER direct_customer_close_commands_preserve BEFORE DELETE ON direct_customer_close_commands
  FOR EACH ROW EXECUTE FUNCTION app.preserve_direct_native_evidence();
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['direct_native_reply_intents','direct_customer_close_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id())',t);
END LOOP; END $$;
GRANT SELECT,INSERT,UPDATE ON direct_native_reply_intents TO wasalx_app;
GRANT SELECT ON direct_native_reply_intents TO wasalx_connector_worker;
GRANT SELECT,INSERT,UPDATE ON direct_customer_close_commands TO wasalx_app,wasalx_connector_worker;
GRANT DELETE ON direct_customer_close_commands TO wasalx_connector_worker;
GRANT SELECT(tenant_id,id,job_type,state) ON privacy_jobs TO wasalx_connector_worker;
GRANT SELECT(tenant_id,job_id,target_type,target_id,state) ON privacy_job_targets TO wasalx_connector_worker;
