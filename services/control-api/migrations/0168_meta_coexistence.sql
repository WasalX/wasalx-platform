BEGIN;

ALTER TABLE meta_signup_attempts DROP CONSTRAINT meta_signup_connection_write_purpose_check;
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_connection_write_purpose_check
  CHECK (connection_credential_write_claimed_at IS NULL OR (connection_id IS NOT NULL AND
    (purpose='ADD_ACCESS' OR (purpose='RECONNECT' AND target_connection_id=connection_id
      AND selected_choice->>'mode'='COEXISTENCE' AND selected_choice->>'numberState'='REGISTERED'
      AND (target_binding->'coexistence'->>'contextId' ~ '^[0-9a-f-]{36}$'
        AND target_binding->'coexistence'->>'credentialFingerprint' ~ '^[0-9a-f]{64}$'
        AND target_binding->'coexistence'->>'privacySnapshotSha256' ~ '^[0-9a-f]{64}$'
        AND target_binding->'coexistence'->>'snapshotSha256' ~ '^[0-9a-f]{64}$') IS TRUE)) IS TRUE));

ALTER TABLE meta_signup_attempts ADD COLUMN coexistence_consent jsonb,
  ADD COLUMN session_log jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(session_log)='array' AND jsonb_array_length(session_log)<=20);
ALTER TABLE meta_signup_attempts ADD CONSTRAINT meta_signup_coexistence_consent_check CHECK (
  (config->>'variant' IS DISTINCT FROM 'BUSINESS_APP' AND coexistence_consent IS NULL)
  OR (config->>'variant'='BUSINESS_APP' AND coexistence_consent @> '{"version":"2026-10-07","echoes":true}'
    AND jsonb_typeof(coexistence_consent->'history')='boolean' AND jsonb_typeof(coexistence_consent->'contacts')='boolean') IS TRUE);
CREATE FUNCTION app.meta_signup_consent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.coexistence_consent IS DISTINCT FROM OLD.coexistence_consent THEN
    RAISE EXCEPTION 'signup consent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_signup_consent_binding BEFORE UPDATE ON meta_signup_attempts FOR EACH ROW EXECUTE FUNCTION app.meta_signup_consent_immutable();

CREATE TABLE meta_coexistence_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL, provider_session_id uuid NOT NULL, signup_attempt_id uuid NOT NULL,
  app_id text NOT NULL CHECK(app_id ~ '^[0-9]{5,32}$'), phone_id text NOT NULL CHECK(phone_id ~ '^[0-9]{5,32}$'),
  waba_id text NOT NULL CHECK(waba_id ~ '^[0-9]{5,32}$'), business_phone text CHECK(business_phone ~ '^[1-9][0-9]{5,19}$'),
  graph_version text NOT NULL, credential_fingerprint text NOT NULL CHECK(credential_fingerprint ~ '^[0-9a-f]{64}$'),
  consent_history boolean NOT NULL, consent_contacts boolean NOT NULL, consent_echoes boolean NOT NULL,
  consent_version text NOT NULL CHECK(consent_version='2026-10-07'), consent_actor uuid,
  consent_at timestamptz NOT NULL DEFAULT clock_timestamp(), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  first_launch_at timestamptz NOT NULL, last_onboarded_time bigint CHECK(last_onboarded_time>0),
  contacts_request jsonb NOT NULL, history_request jsonb NOT NULL,
  history_observation text NOT NULL DEFAULT 'WAITING' CHECK(history_observation IN('WAITING','RECEIVING','PROVIDER_FINISHED','DECLINED','PARTIAL')),
  provider_progress integer CHECK(provider_progress BETWEEN 0 AND 100), processed_chunks integer NOT NULL DEFAULT 0,
  last_activity_at timestamptz, hold_reason text CHECK(hold_reason IN('STOPPED','REVIEW_REQUIRED','MEDIA_UNAVAILABLE')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,connection_id), UNIQUE(tenant_id,app_id,phone_id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id),
  FOREIGN KEY(tenant_id,signup_attempt_id) REFERENCES meta_signup_attempts(tenant_id,id),
  FOREIGN KEY(tenant_id,consent_actor) REFERENCES tenant_memberships(tenant_id,user_id) ON DELETE SET NULL(consent_actor),
  CHECK((contacts_request->>'state' IN('NOT_REQUESTED','QUEUED','CLAIMED','ACCEPTED','REJECTED','UNKNOWN','EXPIRED','STOPPED')) IS TRUE),
  CHECK((history_request->>'state' IN('NOT_REQUESTED','QUEUED','CLAIMED','ACCEPTED','REJECTED','UNKNOWN','EXPIRED','STOPPED','HELD_CONTACTS_UNKNOWN')) IS TRUE)
);
CREATE TABLE meta_coexistence_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, context_id uuid NOT NULL,
  connection_id uuid NOT NULL, external_message_id text NOT NULL CHECK(length(external_message_id) BETWEEN 1 AND 512),
  subject_digest text NOT NULL CHECK(subject_digest ~ '^[0-9a-f]{64}$'), subject_phone text NOT NULL,
  direction text NOT NULL CHECK(direction IN('INBOUND','OUTBOUND')), source text NOT NULL CHECK(source IN('HISTORY','ECHO')),
  echo_observed boolean NOT NULL DEFAULT false,
  provider_timestamp timestamptz NOT NULL, message_type text NOT NULL, message_text text,
  media_id text, quoted_id text, content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
  source_event_id uuid NOT NULL, source_sha256 text NOT NULL, phase integer, chunk_order integer,
  UNIQUE(tenant_id,id), UNIQUE(tenant_id,context_id,external_message_id),
  FOREIGN KEY(tenant_id,context_id) REFERENCES meta_coexistence_contexts(tenant_id,id),
  FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id),
  FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id)
);
CREATE INDEX meta_coexistence_thread ON meta_coexistence_messages(tenant_id,context_id,subject_digest,provider_timestamp,id);
CREATE TABLE meta_coexistence_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, context_id uuid NOT NULL,
  subject_digest text NOT NULL CHECK(subject_digest ~ '^[0-9a-f]{64}$'), subject_phone text,
  display_name text, action text NOT NULL CHECK(action IN('add','remove')), provider_timestamp timestamptz NOT NULL,
  content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'), source_event_id uuid NOT NULL,
  redacted_at timestamptz, UNIQUE(tenant_id,id), UNIQUE(tenant_id,context_id,subject_digest),
  FOREIGN KEY(tenant_id,context_id) REFERENCES meta_coexistence_contexts(tenant_id,id),
  FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id)
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['meta_coexistence_contexts','meta_coexistence_messages','meta_coexistence_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id())',table_name);
    EXECUTE format('GRANT SELECT ON %I TO wasalx_app,wasalx_connector_worker',table_name);
  END LOOP;
END $$;
GRANT INSERT,UPDATE,DELETE ON meta_coexistence_messages,meta_coexistence_contacts TO wasalx_connector_worker;
GRANT UPDATE(display_name,subject_phone,redacted_at),DELETE ON meta_coexistence_contacts TO wasalx_app;
GRANT DELETE ON meta_coexistence_messages TO wasalx_app;
GRANT UPDATE(consent_history,consent_contacts,consent_echoes,revision,hold_reason,updated_at,business_phone,consent_actor,last_onboarded_time) ON meta_coexistence_contexts TO wasalx_app;
GRANT UPDATE(history_observation,provider_progress,processed_chunks,last_activity_at,hold_reason,updated_at,consent_history,consent_contacts,consent_echoes,revision,business_phone,consent_actor,last_onboarded_time) ON meta_coexistence_contexts TO wasalx_connector_worker;

CREATE FUNCTION app.meta_coexistence_context_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE old_request jsonb; new_request jsonb; kind text;
BEGIN
  IF NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint THEN
    IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT proowner FROM pg_proc
        WHERE oid='app.rebind_meta_coexistence_credential(uuid,uuid)'::regprocedure))
      OR (to_jsonb(NEW)-ARRAY['credential_fingerprint','revision','updated_at']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['credential_fingerprint','revision','updated_at'])
      OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'coexistence credential repin requires the exact renewal function' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.business_phone,NEW.last_onboarded_time) IS DISTINCT FROM (OLD.business_phone,OLD.last_onboarded_time)
    AND NOT (NEW.business_phone IS NULL AND NEW.last_onboarded_time IS NULL AND NEW.consent_actor IS NULL
      AND NOT NEW.consent_history AND NOT NEW.consent_contacts AND NOT NEW.consent_echoes
      AND EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE' AND scope_type='TENANT'
        AND state='RUNNING' AND stage='LOCAL' AND lease_expires_at>=clock_timestamp())) THEN
    RAISE EXCEPTION 'coexistence personal metadata only permits privacy reduction' USING ERRCODE='23514';
  END IF;
  IF (NEW.id,NEW.tenant_id,NEW.connection_id,NEW.provider_session_id,NEW.signup_attempt_id,NEW.app_id,NEW.phone_id,NEW.waba_id,
    NEW.graph_version,NEW.consent_version,NEW.consent_at,NEW.first_launch_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.connection_id,OLD.provider_session_id,OLD.signup_attempt_id,OLD.app_id,OLD.phone_id,OLD.waba_id,
    OLD.graph_version,OLD.consent_version,OLD.consent_at,OLD.first_launch_at,OLD.created_at)
    OR (NEW.consent_actor IS DISTINCT FROM OLD.consent_actor AND NEW.consent_actor IS NOT NULL)
    OR (NEW.consent_history AND NOT OLD.consent_history) OR (NEW.consent_contacts AND NOT OLD.consent_contacts)
    OR (NEW.consent_echoes AND NOT OLD.consent_echoes) THEN
    RAISE EXCEPTION 'coexistence binding cannot be reset' USING ERRCODE='23514';
  END IF;
  FOREACH kind IN ARRAY ARRAY['contacts_request','history_request'] LOOP
    old_request:=to_jsonb(OLD)->kind; new_request:=to_jsonb(NEW)->kind;
    IF old_request ? 'claimedAt' AND (new_request->'claimedAt',new_request->'operationId',new_request->'fence',new_request->'requestHash')
      IS DISTINCT FROM (old_request->'claimedAt',old_request->'operationId',old_request->'fence',old_request->'requestHash')
      OR (old_request->>'state' IN('ACCEPTED','REJECTED','UNKNOWN','EXPIRED','STOPPED','HELD_CONTACTS_UNKNOWN') AND new_request IS DISTINCT FROM old_request) THEN
      RAISE EXCEPTION 'coexistence request cannot be replayed' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_coexistence_context_binding BEFORE UPDATE ON meta_coexistence_contexts FOR EACH ROW EXECUTE FUNCTION app.meta_coexistence_context_immutable();

-- Called only in the existing successful token-rotation transaction. No import generation changes.
-- The shared connection_credential_write_claimed_at primitive is declared once with ADD_ACCESS.
-- Bind existing privacy work, including jobs that finish between sidecar claim and promotion.
-- This is a private equality snapshot, not a replacement deletion cutoff or privacy authority.
CREATE FUNCTION app.meta_coexistence_privacy_snapshot() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(id,job_type,state,stage,created_at,updated_at)
    ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex') FROM privacy_jobs
  WHERE tenant_id=app.current_tenant_id() AND job_type IN ('DELETE','RETENTION_SWEEP')
$$;
REVOKE ALL ON FUNCTION app.meta_coexistence_privacy_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_coexistence_privacy_snapshot() TO wasalx_app;

CREATE FUNCTION app.rebind_meta_coexistence_credential(attempt_value uuid,operation_value uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE a meta_signup_attempts; o connection_operations; c connections; s provider_sessions; x meta_coexistence_contexts;
  target jsonb; proof jsonb; guard record;
BEGIN
  IF app.lock_current_active_tenant_for_event_admission() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'coexistence renewal tenant is inactive' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||app.current_tenant_id()::text,0));
  SELECT * INTO a FROM meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value;
  IF NOT FOUND OR a.purpose<>'RECONNECT' OR a.status<>'PROVISIONING' OR a.operation_id IS DISTINCT FROM operation_value
    OR a.connection_id IS DISTINCT FROM a.target_connection_id OR a.connection_credential_write_claimed_at IS NULL
    OR COALESCE(a.config->>'variant','STANDARD')<>'STANDARD' OR a.selected_choice->>'mode' IS DISTINCT FROM 'COEXISTENCE'
    OR a.selected_choice->>'numberState' IS DISTINCT FROM 'REGISTERED' THEN
    RAISE EXCEPTION 'coexistence renewal binding unavailable' USING ERRCODE='23514';
  END IF;
  target:=a.target_binding->'coexistence';
  SELECT * INTO c FROM connections WHERE tenant_id=a.tenant_id AND id=a.connection_id AND provider='META' AND state='PAUSED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coexistence renewal connection changed' USING ERRCODE='23514'; END IF;
  SELECT * INTO o FROM connection_operations WHERE tenant_id=a.tenant_id AND id=operation_value AND connection_id=c.id FOR UPDATE;
  IF NOT FOUND OR o.operation_type<>'ROTATE_META_CREDENTIAL' OR o.state<>'SUCCEEDED'
    OR o.payload->>'metaSignupAttemptId' IS DISTINCT FROM a.id::text OR o.payload->>'metaSignupPurpose' IS DISTINCT FROM 'RECONNECT'
    OR o.result->>'rotated' IS DISTINCT FROM 'true' OR o.result->>'pausePreserved' IS DISTINCT FROM 'true'
    OR c.secret_reference IS DISTINCT FROM o.payload->>'newSecretReference'
    OR o.payload->>'oldSecretReference' IS DISTINCT FROM a.target_binding->>'secretReference'
    OR o.payload->'request'->>'credentialFingerprint' IS DISTINCT FROM a.credential_fingerprint THEN
    RAISE EXCEPTION 'coexistence renewal operation changed' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM tenant_memberships WHERE tenant_id=a.tenant_id AND user_id=a.requested_by
    AND state='ACTIVE' AND role IN ('tenant_owner','tenant_admin') FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=a.tenant_id AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE'))
    OR app.meta_coexistence_privacy_snapshot() IS DISTINCT FROM target->>'privacySnapshotSha256' THEN
    RAISE EXCEPTION 'coexistence renewal actor or privacy changed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM provider_sessions WHERE tenant_id=a.tenant_id AND connection_id=c.id
    AND id::text=a.target_binding->>'providerSessionId' AND ownership_state='ACTIVE' AND state='PAUSED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'coexistence renewal session changed' USING ERRCODE='23514'; END IF;
  proof:=s.provider_state_data->'metaAccountProof';
  SELECT * INTO x FROM meta_coexistence_contexts WHERE tenant_id=a.tenant_id AND connection_id=c.id AND id::text=target->>'contextId' FOR UPDATE;
  IF NOT FOUND OR x.provider_session_id<>s.id OR x.revision::text IS DISTINCT FROM target->>'revision'
    OR x.credential_fingerprint IS DISTINCT FROM target->>'credentialFingerprint'
    OR encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex') IS DISTINCT FROM target->>'snapshotSha256'
    OR x.app_id IS DISTINCT FROM a.config->>'appId' OR x.graph_version IS DISTINCT FROM a.config->>'graphVersion'
    OR x.phone_id IS DISTINCT FROM a.selected_choice->>'phoneId' OR x.waba_id IS DISTINCT FROM a.selected_choice->>'wabaId'
    OR s.opaque_session_id<>x.phone_id OR s.provider_state_data->>'wabaId' IS DISTINCT FROM x.waba_id
    OR s.provider_state_data->'metaSignup'->>'attemptId' IS DISTINCT FROM x.signup_attempt_id::text
    OR s.provider_state_data->'metaSignup'->>'variant' IS DISTINCT FROM 'BUSINESS_APP'
    OR proof->>'operationId' IS DISTINCT FROM o.id::text OR proof->>'providerSessionId' IS DISTINCT FROM s.id::text
    OR proof->>'tenantId' IS DISTINCT FROM a.tenant_id::text OR proof->>'connectionId' IS DISTINCT FROM c.id::text
    OR proof->>'phoneNumberId' IS DISTINCT FROM x.phone_id OR proof->>'wabaId' IS DISTINCT FROM x.waba_id
    OR proof->'credentialMetadata'->>'appId' IS DISTINCT FROM x.app_id
    OR proof->>'credentialFingerprint' IS DISTINCT FROM a.credential_fingerprint OR proof->>'secretReference' IS DISTINCT FROM c.secret_reference
    OR o.result->'metaAccountProof' IS DISTINCT FROM proof THEN
    RAISE EXCEPTION 'coexistence renewal context changed' USING ERRCODE='23514';
  END IF;
  SELECT * INTO guard FROM app.meta_lifecycle_guard(c.id,s.id,x.phone_id,x.waba_id,x.app_id,
    COALESCE((s.provider_state_data->'metaLifecycle'->>'revision')::integer,0));
  IF guard.revision_matches IS DISTINCT FROM true OR guard.unresolved_hold IS DISTINCT FROM false
    OR EXISTS(SELECT 1 FROM connection_operations WHERE tenant_id=a.tenant_id AND connection_id=c.id AND id<>o.id
      AND state IN ('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE'))
    OR NOT EXISTS(SELECT 1 FROM webhook_routes WHERE tenant_id=a.tenant_id AND connection_id=c.id
      AND provider='META' AND external_key=x.phone_id AND state='PAUSED') THEN
    RAISE EXCEPTION 'coexistence renewal admission changed' USING ERRCODE='23514';
  END IF;
  UPDATE meta_coexistence_contexts SET credential_fingerprint=a.credential_fingerprint,revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=a.tenant_id AND id=x.id;
END $$;
REVOKE ALL ON FUNCTION app.rebind_meta_coexistence_credential(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rebind_meta_coexistence_credential(uuid,uuid) TO wasalx_app;

ALTER TABLE connection_operations DROP CONSTRAINT connection_operations_operation_type_check;
ALTER TABLE connection_operations ADD CONSTRAINT connection_operations_operation_type_check CHECK(operation_type IN
  ('PROVISION','START','RESTART','PAUSE','DISCONNECT','SYNC_GROUPS','ROTATE_META_CREDENTIAL','SYNC_META_APP'));

-- A committed ready route precedes the only sync operation. This never runs a provider call.
CREATE FUNCTION app.queue_meta_coexistence(operation_value uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE a meta_signup_attempts; s provider_sessions; c connections; context_value uuid;
BEGIN
  SELECT attempt.* INTO a FROM meta_signup_attempts attempt JOIN connection_operations operation
    ON operation.tenant_id=attempt.tenant_id AND operation.id=attempt.operation_id
    WHERE attempt.tenant_id=app.current_tenant_id() AND operation.id=operation_value AND operation.state='SUCCEEDED'
      AND operation.result->>'metaSignupReady'='true' AND attempt.config->>'variant'='BUSINESS_APP'
      AND attempt.selected_choice->>'mode'='COEXISTENCE' FOR SHARE OF attempt;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO c FROM connections WHERE tenant_id=a.tenant_id AND id=a.connection_id AND state='WORKING' AND provider='META' FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO s FROM provider_sessions WHERE tenant_id=a.tenant_id AND connection_id=a.connection_id AND ownership_state='ACTIVE'
    AND state='WORKING' AND opaque_session_id=a.selected_choice->>'phoneId'
    AND provider_state_data->'metaSignup'->>'attemptId'=a.id::text FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM webhook_routes WHERE tenant_id=a.tenant_id AND connection_id=c.id AND state='ACTIVE'
    AND provider='META' AND external_key=s.opaque_session_id) THEN RETURN; END IF;
  INSERT INTO meta_coexistence_contexts(tenant_id,connection_id,provider_session_id,signup_attempt_id,app_id,phone_id,waba_id,business_phone,
    graph_version,credential_fingerprint,consent_history,consent_contacts,consent_echoes,consent_version,consent_actor,first_launch_at,last_onboarded_time,contacts_request,history_request)
    VALUES(a.tenant_id,c.id,s.id,a.id,a.config->>'appId',s.opaque_session_id,a.selected_choice->>'wabaId',regexp_replace(c.phone_e164,'[^0-9]','','g'),
      a.config->>'graphVersion',a.credential_fingerprint,(a.coexistence_consent->>'history')::boolean,(a.coexistence_consent->>'contacts')::boolean,true,
      a.coexistence_consent->>'version',a.requested_by,a.created_at,(a.selected_choice->>'lastOnboardedTime')::bigint,
      jsonb_build_object('state',CASE WHEN (a.coexistence_consent->>'contacts')::boolean THEN 'QUEUED' ELSE 'NOT_REQUESTED' END),
      jsonb_build_object('state',CASE WHEN (a.coexistence_consent->>'history')::boolean THEN 'QUEUED' ELSE 'NOT_REQUESTED' END))
    ON CONFLICT DO NOTHING RETURNING id INTO context_value;
  IF context_value IS NULL THEN RETURN; END IF;
  IF (a.coexistence_consent->>'contacts')::boolean OR (a.coexistence_consent->>'history')::boolean THEN
    INSERT INTO connection_operations(tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,requested_by_id,request_id)
      VALUES(a.tenant_id,c.id,'SYNC_META_APP','meta-coexistence:'||context_value::text,
        jsonb_build_object('contextId',context_value,'metaLifecycleExpectedRevision',COALESCE((s.provider_state_data->'metaLifecycle'->>'revision')::integer,0)),
        'SYSTEM','meta-coexistence',a.id::text);
  END IF;
END $$;
REVOKE ALL ON FUNCTION app.queue_meta_coexistence(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.queue_meta_coexistence(uuid) TO wasalx_connector_worker;

-- Stable across token/session/context/consent changes. No raw subject is retained in the cutoff target.
CREATE FUNCTION app.meta_coexistence_subject_digest(app_value text,phone_value text,subject_value text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT encode(sha256(convert_to('meta-coexistence-v1:'||app.current_tenant_id()::text||':'||app_value||':'||phone_value||':PHONE:'||subject_value,'UTF8')),'hex') $$;
ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_target_type_check;
ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_job_targets_target_type_check CHECK(target_type IN(
 'ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','NORMALIZED_MESSAGE','DELIVERY','META_DIRECT_ALIAS','META_DIRECT_IDENTITY_EVENT',
 'META_COEXISTENCE_MESSAGE','META_COEXISTENCE_CONTACT','META_COEXISTENCE_EVENT','META_COEXISTENCE_SUBJECT_CUTOFF'));
CREATE FUNCTION app.meta_coexistence_subject_blocked(context_value uuid,subject_value text,kind_value text,time_value timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT NOT EXISTS(SELECT 1 FROM meta_coexistence_contexts WHERE tenant_id=app.current_tenant_id() AND id=context_value)
 OR EXISTS(SELECT 1 FROM meta_coexistence_contexts context JOIN privacy_job_targets target ON target.tenant_id=context.tenant_id
   AND target.target_type='META_COEXISTENCE_SUBJECT_CUTOFF'
   AND target.target_id=app.meta_coexistence_subject_digest(context.app_id,context.phone_id,subject_value)
   JOIN privacy_jobs job ON job.tenant_id=target.tenant_id AND job.id=target.job_id
   WHERE context.tenant_id=app.current_tenant_id() AND context.id=context_value
     AND (kind_value<>'ECHO' OR time_value<=job.created_at))
 OR EXISTS(SELECT 1 FROM privacy_jobs job JOIN meta_coexistence_contexts context ON context.tenant_id=job.tenant_id
   WHERE job.tenant_id=app.current_tenant_id() AND context.id=context_value AND job.job_type='DELETE'
     AND job.state<>'SUCCEEDED' AND (job.scope_type='TENANT'
       OR (job.scope_type='PARTICIPANT' AND (regexp_replace(job.scope_value,'[^0-9]','','g')=subject_value
         OR app.meta_direct_participant_matches(context.connection_id,subject_value,job.scope_value)))
       OR (job.scope_type='ZAMMAD_USER' AND EXISTS(SELECT 1 FROM normalized_messages message
         JOIN event_inbox source ON source.tenant_id=message.tenant_id AND source.id=message.event_inbox_id
         WHERE message.tenant_id=context.tenant_id AND message.connection_id=context.connection_id
           AND source.event_type='messages' AND source.meta_direct_asset IS NOT NULL
           AND message.provider_metadata->>'zammad_customer_id'=job.scope_value
           AND app.meta_direct_participant_matches(context.connection_id,message.external_participant_id,subject_value)))))
$$;
REVOKE ALL ON FUNCTION app.meta_coexistence_subject_blocked(uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_coexistence_subject_blocked(uuid,text,text,timestamptz) TO wasalx_app,wasalx_connector_worker;

ALTER TABLE event_inbox ADD COLUMN meta_coexistence_admission jsonb;
GRANT SELECT(meta_coexistence_admission) ON event_inbox TO wasalx_connector_worker;
GRANT INSERT(meta_coexistence_admission) ON event_inbox TO wasalx_app;
CREATE FUNCTION app.meta_coexistence_inbox_binding() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.event_type LIKE 'meta.coexistence.%' THEN
    IF NEW.provider<>'META' OR NEW.meta_direct_asset IS NOT NULL OR NEW.meta_coexistence_admission IS NULL
      OR NEW.payload->>'sourceSha256' IS DISTINCT FROM NEW.payload_sha256
      OR NOT EXISTS(SELECT 1 FROM meta_coexistence_contexts context WHERE context.tenant_id=NEW.tenant_id
        AND context.connection_id=NEW.connection_id AND context.id::text=NEW.meta_coexistence_admission->>'contextId'
        AND context.provider_session_id::text=NEW.meta_coexistence_admission->>'providerSessionId'
        AND context.app_id=NEW.meta_coexistence_admission->>'appId' AND context.phone_id=NEW.payload->>'phoneId'
        AND context.waba_id=NEW.payload->>'wabaId' AND context.business_phone=NEW.payload->>'businessPhone') THEN
      RAISE EXCEPTION 'invalid coexistence inbox binding' USING ERRCODE='23514';
    END IF;
    NEW.meta_coexistence_admission:=NEW.meta_coexistence_admission||jsonb_build_object('typedSha256',encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex'));
  ELSIF TG_OP='UPDATE' AND OLD.meta_coexistence_admission IS NOT NULL THEN
    IF NEW.meta_coexistence_admission IS DISTINCT FROM OLD.meta_coexistence_admission THEN
      RAISE EXCEPTION 'coexistence admission is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload NOT IN('{}'::jsonb,jsonb_build_object('redacted',true,'payload_sha256',OLD.payload_sha256))
      AND app.meta_direct_privacy_target_authorized('META_COEXISTENCE_EVENT',OLD.id::text) IS NOT TRUE THEN
      RAISE EXCEPTION 'coexistence payload reduction requires privacy authority' USING ERRCODE='23514';
    END IF;
    IF NEW.payload IS DISTINCT FROM OLD.payload THEN
      -- Privacy only removes complete items, never edits or adds retained content.
      IF NEW.payload NOT IN('{}'::jsonb,jsonb_build_object('redacted',true,'payload_sha256',OLD.payload_sha256)) AND (NEW.payload - 'messages' - 'contacts' IS DISTINCT FROM OLD.payload - 'messages' - 'contacts'
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload->'messages') item WHERE NOT OLD.payload->'messages' @> jsonb_build_array(item))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload->'contacts') item WHERE NOT OLD.payload->'contacts' @> jsonb_build_array(item))) THEN
        RAISE EXCEPTION 'coexistence privacy transformation must reduce data' USING ERRCODE='23514';
      END IF;
      NEW.meta_coexistence_admission:=OLD.meta_coexistence_admission||jsonb_build_object('typedSha256',encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex'));
    END IF;
  ELSIF NEW.meta_coexistence_admission IS NOT NULL THEN
    RAISE EXCEPTION 'coexistence admission requires an import event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_coexistence_inbox_guard BEFORE INSERT OR UPDATE ON event_inbox FOR EACH ROW EXECUTE FUNCTION app.meta_coexistence_inbox_binding();

CREATE FUNCTION app.meta_coexistence_request(operation_value uuid,lease_value uuid,fence_value bigint,
  session_worker text,session_fence bigint,kind_value text,outcome_value text,request_value text DEFAULT NULL,config_value jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE operation connection_operations; context meta_coexistence_contexts; session provider_sessions; request_data jsonb; column_name text;
BEGIN
  IF kind_value NOT IN('contacts','history') OR outcome_value NOT IN('CLAIMED','DISPATCH','ACCEPTED','REJECTED','UNKNOWN')
    OR (request_value IS NOT NULL AND (length(request_value)>512 OR request_value ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'invalid sync request' USING ERRCODE='22023';
  END IF;
  SELECT * INTO operation FROM connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value
    AND operation_type='SYNC_META_APP' AND state='RUNNING' AND lease_id=lease_value AND fencing_token=fence_value
    AND lease_expires_at>=clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO context FROM meta_coexistence_contexts WHERE tenant_id=operation.tenant_id
    AND connection_id=operation.connection_id AND id::text=operation.payload->>'contextId' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO session FROM provider_sessions WHERE tenant_id=context.tenant_id AND id=context.provider_session_id
    AND ownership_state='ACTIVE' AND worker_id=session_worker AND fencing_token=session_fence
    AND lease_expires_at>=clock_timestamp() AND opaque_session_id=context.phone_id
    AND provider_state_data->>'wabaId'=context.waba_id
    AND provider_state_data->'metaAccountProof'->>'credentialFingerprint'=context.credential_fingerprint FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  column_name:=kind_value||'_request'; request_data:=to_jsonb(context)->column_name;
  IF outcome_value IN('CLAIMED','DISPATCH') THEN
    IF outcome_value='CLAIMED' AND request_data->>'state'<>'QUEUED' THEN RETURN false; END IF;
    IF outcome_value='DISPATCH' AND (request_data->>'state'<>'CLAIMED' OR request_data->>'operationId'<>operation.id::text
      OR (request_data->>'fence')::bigint<>fence_value) THEN RETURN false; END IF;
    IF outcome_value='CLAIMED' AND context.contacts_request->>'state' IN('CLAIMED','UNKNOWN') AND kind_value='history' THEN
      UPDATE meta_coexistence_contexts SET history_request='{"state":"HELD_CONTACTS_UNKNOWN"}' WHERE id=context.id; RETURN false;
    END IF;
    -- This is a local stale-queue ceiling, not a claim about Meta's onboarding clock.
    -- Hosted last_onboarded_time is retained as evidence; coexistence/reconnect semantics remain unknown.
    IF context.first_launch_at<clock_timestamp()-interval '24 hours' THEN
      IF outcome_value='DISPATCH' THEN RETURN false; END IF;
      EXECUTE format('UPDATE meta_coexistence_contexts SET %I=$1 WHERE id=$2',column_name) USING jsonb_build_object('state','EXPIRED'),context.id;
      RETURN false;
    END IF;
    IF context.hold_reason IS NOT NULL OR NOT context.consent_echoes
      OR NOT EXISTS(SELECT 1 FROM meta_signup_attempts WHERE tenant_id=context.tenant_id AND id=context.signup_attempt_id AND config=config_value)
      OR (kind_value='contacts' AND NOT context.consent_contacts) OR (kind_value='history' AND NOT context.consent_history)
      OR NOT EXISTS(SELECT 1 FROM tenants WHERE id=context.tenant_id AND state='ACTIVE')
      OR NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=context.tenant_id AND user_id=context.consent_actor
        AND state='ACTIVE' AND role IN('tenant_owner','tenant_admin'))
      OR NOT EXISTS(SELECT 1 FROM connections WHERE tenant_id=context.tenant_id AND id=context.connection_id AND state='WORKING')
      OR session.state<>'WORKING'
      OR NOT EXISTS(SELECT 1 FROM webhook_routes WHERE tenant_id=context.tenant_id AND connection_id=context.connection_id AND state='ACTIVE' AND external_key=context.phone_id)
      OR NOT EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(context.connection_id,session.id,context.phone_id,context.waba_id,context.app_id,
        COALESCE((session.provider_state_data->'metaLifecycle'->>'revision')::integer,0)) WHERE revision_matches IS TRUE AND unresolved_hold IS FALSE)
      OR EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=context.tenant_id AND job_type='DELETE' AND scope_type='TENANT' AND state<>'CANCELLED') THEN
      IF outcome_value='CLAIMED' THEN
        EXECUTE format('UPDATE meta_coexistence_contexts SET %I=$1 WHERE id=$2',column_name) USING jsonb_build_object('state','STOPPED'),context.id;
      END IF;
      RETURN false;
    END IF;
    -- Read-only revalidation of the original consumed claim, immediately before HTTP.
    IF outcome_value='DISPATCH' THEN RETURN true; END IF;
    request_data:=jsonb_build_object('state','CLAIMED','claimedAt',clock_timestamp(),'operationId',operation.id,'fence',fence_value,
      'requestHash',encode(sha256(convert_to(context.phone_id||':'||kind_value,'UTF8')),'hex'));
  ELSE
    IF request_data->>'state'<>'CLAIMED' OR request_data->>'operationId'<>operation.id::text
      OR (request_data->>'fence')::bigint<>fence_value OR (outcome_value='ACCEPTED' AND request_value IS NULL) THEN RETURN false; END IF;
    request_data:=request_data||jsonb_build_object('state',outcome_value,'observedAt',clock_timestamp())
      || CASE WHEN request_value IS NOT NULL THEN jsonb_build_object('requestId',request_value) ELSE '{}'::jsonb END;
  END IF;
  EXECUTE format('UPDATE meta_coexistence_contexts SET %I=$1,updated_at=clock_timestamp() WHERE id=$2',column_name) USING request_data,context.id;
  IF kind_value='contacts' AND outcome_value='UNKNOWN' AND context.history_request->>'state'='QUEUED' THEN
    UPDATE meta_coexistence_contexts SET history_request='{"state":"HELD_CONTACTS_UNKNOWN"}' WHERE id=context.id;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.meta_coexistence_request(uuid,uuid,bigint,text,bigint,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_coexistence_request(uuid,uuid,bigint,text,bigint,text,text,text,jsonb) TO wasalx_connector_worker;

-- Lease reclamation/exhaustion must consume uncertainty, even if no processor runs again.
CREATE FUNCTION app.meta_coexistence_operation_abandoned() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
  IF OLD.operation_type='SYNC_META_APP'
    AND ((OLD.state='RUNNING' AND NEW.fencing_token<>OLD.fencing_token) OR NEW.state IN('FAILED_TERMINAL','SUCCEEDED','CANCELLED')) THEN
    UPDATE meta_coexistence_contexts SET
      contacts_request=CASE WHEN contacts_request->>'state'='CLAIMED' THEN contacts_request||'{"state":"UNKNOWN"}'
        WHEN contacts_request->>'state'='QUEUED' AND NEW.state IN('FAILED_TERMINAL','SUCCEEDED','CANCELLED') THEN '{"state":"STOPPED"}'::jsonb ELSE contacts_request END,
      history_request=CASE WHEN history_request->>'state'='CLAIMED' THEN history_request||'{"state":"UNKNOWN"}'
        WHEN contacts_request->>'state' IN('CLAIMED','UNKNOWN') AND history_request->>'state'='QUEUED' THEN '{"state":"HELD_CONTACTS_UNKNOWN"}'::jsonb
        WHEN history_request->>'state'='QUEUED' AND NEW.state IN('FAILED_TERMINAL','SUCCEEDED','CANCELLED') THEN '{"state":"STOPPED"}'::jsonb
        ELSE history_request END
      WHERE tenant_id=OLD.tenant_id AND id::text=OLD.payload->>'contextId';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_coexistence_abandoned BEFORE UPDATE ON connection_operations FOR EACH ROW EXECUTE FUNCTION app.meta_coexistence_operation_abandoned();

CREATE FUNCTION app.meta_coexistence_cutoff_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.target_type='META_COEXISTENCE_SUBJECT_CUTOFF' THEN
    IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.job_id,NEW.target_type,NEW.target_id,NEW.target_sha256)
      IS DISTINCT FROM (OLD.tenant_id,OLD.job_id,OLD.target_type,OLD.target_id,OLD.target_sha256) THEN
      RAISE EXCEPTION 'completed privacy cutoff must be retained' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER meta_coexistence_cutoff_guard BEFORE UPDATE OR DELETE ON privacy_job_targets FOR EACH ROW EXECUTE FUNCTION app.meta_coexistence_cutoff_immutable();

REVOKE ALL ON FUNCTION app.meta_signup_consent_immutable(),app.meta_coexistence_context_immutable(),app.meta_coexistence_inbox_binding(),app.meta_coexistence_operation_abandoned(),app.meta_coexistence_cutoff_immutable() FROM PUBLIC;

-- Meta import ingress and worker claims reach these existing relation readers.
-- Preserve historical migration bytes, function authority and runtime TEMP access.
ALTER FUNCTION app.pin_event_client_routing_version() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.block_async_claim_during_privacy() SET search_path=pg_catalog,public,app,pg_temp;
COMMIT;
