BEGIN;

-- A primary delivery proves receipt by this app, not exclusive thread ownership.
ALTER TABLE provider_sessions ADD COLUMN meta_primary_delivery_disabled_at timestamptz;
GRANT SELECT(meta_primary_delivery_disabled_at) ON provider_sessions TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.fence_meta_primary_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF TG_TABLE_NAME='provider_sessions' THEN
  IF TG_OP='UPDATE' AND OLD.meta_primary_delivery_disabled_at IS NOT NULL THEN
   NEW.meta_primary_delivery_disabled_at:=OLD.meta_primary_delivery_disabled_at;
  ELSIF NEW.ownership_state='ACTIVE' AND NEW.provider_state_data ?| ARRAY['metaSignup','metaShared','metaRouting','metaRoutingEvidence'] THEN
   NEW.meta_primary_delivery_disabled_at:=clock_timestamp();
  END IF;
 ELSIF NEW.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','STANDBY_ECHO','STANDBY_STATUS','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING') THEN
  UPDATE public.provider_sessions SET meta_primary_delivery_disabled_at=COALESCE(meta_primary_delivery_disabled_at,clock_timestamp())
   WHERE tenant_id=NEW.tenant_id AND connection_id=NEW.connection_id AND id::text=NEW.meta_routing_evidence->>'providerSessionId';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.fence_meta_primary_delivery() FROM PUBLIC;
CREATE TRIGGER meta_primary_delivery_session_fence BEFORE INSERT OR UPDATE ON provider_sessions
 FOR EACH ROW EXECUTE FUNCTION app.fence_meta_primary_delivery();
CREATE TRIGGER meta_primary_delivery_event_fence AFTER INSERT ON event_inbox
 FOR EACH ROW EXECUTE FUNCTION app.fence_meta_primary_delivery();
UPDATE provider_sessions session SET meta_primary_delivery_disabled_at=clock_timestamp()
 WHERE session.ownership_state='ACTIVE' AND (session.provider_state_data ?| ARRAY['metaSignup','metaShared','metaRouting','metaRoutingEvidence']
 OR EXISTS(SELECT 1 FROM meta_routing_reviews review WHERE review.tenant_id=session.tenant_id AND review.connection_id=session.connection_id)
 OR EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=session.tenant_id AND source.connection_id=session.connection_id
  AND source.meta_routing_evidence->>'providerSessionId'=session.id::text
  AND source.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','STANDBY_ECHO','STANDBY_STATUS','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING')));

CREATE TABLE meta_primary_delivery_admissions (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,provider_session_id uuid NOT NULL,participant_identity_id uuid NOT NULL,
 source_event_id uuid NOT NULL,source_hash text NOT NULL,observed_at timestamptz NOT NULL,
 phone_number_id text NOT NULL,account_id text NOT NULL,app_id text NOT NULL,runtime_binding jsonb NOT NULL,
 secret_reference text NOT NULL,proof_sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 PRIMARY KEY(tenant_id,source_event_id),
 FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,connection_id,participant_identity_id) REFERENCES participant_identities(tenant_id,connection_id,id) ON DELETE RESTRICT,
 CHECK(source_hash~'^[0-9a-f]{64}$' AND proof_sha256~'^[0-9a-f]{64}$')
);
CREATE INDEX meta_primary_delivery_participant_idx ON meta_primary_delivery_admissions
 (tenant_id,connection_id,provider_session_id,participant_identity_id,observed_at DESC);
ALTER TABLE meta_primary_delivery_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_primary_delivery_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_primary_delivery_admissions
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,DELETE ON meta_primary_delivery_admissions TO wasalx_app,wasalx_connector_worker;
GRANT INSERT ON meta_primary_delivery_admissions TO wasalx_connector_worker;
CREATE TRIGGER meta_primary_delivery_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON meta_primary_delivery_admissions
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE FUNCTION app.meta_primary_delivery_eligible(connection_value uuid,session_value uuid,phone_value text,account_value text,app_value text,runtime_value jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.connections connection JOIN public.provider_sessions session
  ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
  CROSS JOIN LATERAL(SELECT session.provider_state_data->'metaAccountProof' AS value) proof
  CROSS JOIN LATERAL(SELECT proof.value->'credentialMetadata' AS value) credential
  WHERE connection.tenant_id=app.current_tenant_id() AND connection.id=connection_value AND connection.provider='META'
  AND connection.state='WORKING' AND session.id=session_value AND session.ownership_state='ACTIVE' AND session.state='WORKING'
  AND session.opaque_session_id=phone_value AND session.provider_state_data->>'wabaId'=account_value
  AND session.meta_primary_delivery_disabled_at IS NULL
  AND NOT session.provider_state_data ?| ARRAY['metaSignup','metaShared','metaRouting','metaRoutingEvidence']
  AND proof.value->>'schemaVersion'='1' AND proof.value->>'claim'='PHONE_ACCOUNT_RELATION_VERIFIED'
  AND proof.value->>'tenantId'=connection.tenant_id::text AND proof.value->>'connectionId'=connection_value::text
  AND proof.value->>'providerSessionId'=session_value::text AND proof.value->>'phoneNumberId'=phone_value AND proof.value->>'wabaId'=account_value
  AND proof.value->>'secretReference'=connection.secret_reference AND proof.value->>'credentialFingerprint'~'^[0-9a-f]{64}$'
  AND credential.value->>'schemaVersion'='1' AND credential.value->>'claim'='CREDENTIAL_METADATA_VERIFIED'
  AND credential.value->>'appId'=app_value AND credential.value->'scopes' ?& ARRAY['whatsapp_business_management','whatsapp_business_messaging']
  AND CASE WHEN credential.value->>'expiresAt'~'^[0-9]{1,16}$' THEN (credential.value->>'expiresAt')::numeric=0
   OR (credential.value->>'expiresAt')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END
  AND CASE WHEN NOT credential.value ? 'dataAccessExpiresAt' THEN true
   WHEN credential.value->>'dataAccessExpiresAt'~'^[0-9]{1,16}$' THEN (credential.value->>'dataAccessExpiresAt')::numeric=0
   OR (credential.value->>'dataAccessExpiresAt')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END
  AND runtime_value->>'graphVersion'=proof.value->>'graphVersion'
  AND runtime_value-ARRAY['mode','graphOrigin','graphVersion','simulationBindingSha256']='{}'::jsonb
  AND ((runtime_value->>'mode'='LIVE' AND runtime_value->>'graphOrigin'='https://graph.facebook.com' AND NOT runtime_value ? 'simulationBindingSha256')
   OR(runtime_value->>'mode'='SIMULATED' AND runtime_value->>'graphOrigin'~'^https://[^/@?#]+(:[0-9]+)?$' AND runtime_value->>'simulationBindingSha256'~'^[0-9a-f]{64}$'))
  AND NOT EXISTS(SELECT 1 FROM public.meta_routing_legacy_admissions admission WHERE admission.tenant_id=connection.tenant_id AND admission.connection_id=connection_value)
  AND NOT EXISTS(SELECT 1 FROM public.meta_routing_reviews review WHERE review.tenant_id=connection.tenant_id AND review.connection_id=connection_value)
  AND NOT EXISTS(SELECT 1 FROM public.meta_thread_ownership ownership WHERE ownership.tenant_id=connection.tenant_id AND ownership.connection_id=connection_value)
  AND NOT EXISTS(SELECT 1 FROM public.meta_thread_control_actions action WHERE action.tenant_id=connection.tenant_id AND action.connection_id=connection_value)
  AND NOT EXISTS(SELECT 1 FROM public.event_inbox source WHERE source.tenant_id=connection.tenant_id AND source.connection_id=connection_value
   AND source.meta_routing_evidence->>'providerSessionId'=session_value::text
   AND source.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','STANDBY_ECHO','STANDBY_STATUS','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING')));
$$;
REVOKE ALL ON FUNCTION app.meta_primary_delivery_eligible(uuid,uuid,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_primary_delivery_eligible(uuid,uuid,text,text,text,jsonb) TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.preserve_meta_primary_delivery() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source public.event_inbox%ROWTYPE;session_row public.provider_sessions%ROWTYPE;reference_value text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF app.meta_direct_privacy_target_authorized('META_ROUTING_EVENT',OLD.source_event_id::text) THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'primary delivery requires privacy authority to remove' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'primary delivery admission is immutable' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.connections WHERE tenant_id=NEW.tenant_id AND id=NEW.connection_id FOR UPDATE;
 SELECT * INTO source FROM public.event_inbox WHERE tenant_id=NEW.tenant_id AND connection_id=NEW.connection_id AND id=NEW.source_event_id;
 SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=NEW.tenant_id AND id=NEW.provider_session_id;
 SELECT secret_reference INTO reference_value FROM public.connections WHERE tenant_id=NEW.tenant_id AND id=NEW.connection_id;
 IF app.meta_primary_delivery_eligible(NEW.connection_id,NEW.provider_session_id,NEW.phone_number_id,NEW.account_id,NEW.app_id,NEW.runtime_binding) IS DISTINCT FROM true
  OR source.id IS NULL OR source.provider<>'META' OR source.event_type<>'messages' OR source.status<>'PROCESSING'
  OR source.lease_id IS NULL OR source.lease_expires_at<=clock_timestamp() OR source.meta_routing_epoch IS NOT NULL
  OR source.payload_sha256 IS DISTINCT FROM NEW.source_hash OR source.meta_direct_identity_change IS NOT NULL
  OR source.meta_direct_asset IS DISTINCT FROM jsonb_build_object('providerSessionId',NEW.provider_session_id,'phoneNumberId',NEW.phone_number_id,'wabaId',NEW.account_id)
  OR source.meta_routing_evidence->>'category' IS DISTINCT FROM 'PRIMARY_MESSAGE'
  OR source.meta_routing_evidence->>'appId' IS DISTINCT FROM NEW.app_id
  OR source.meta_routing_evidence->>'payloadSha256' IS DISTINCT FROM NEW.source_hash
  OR (source.meta_routing_evidence->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
  OR NEW.observed_at<date_trunc('second',session_row.created_at) OR source.received_at<session_row.created_at
  OR NEW.observed_at+interval '24 hours'<=clock_timestamp() OR NEW.observed_at>clock_timestamp()+interval '5 minutes'
  OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
  OR NEW.secret_reference IS DISTINCT FROM reference_value
  OR NEW.proof_sha256 IS DISTINCT FROM app.meta_account_proof_sha256(session_row.provider_state_data->'metaAccountProof')
  OR NOT EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases alias WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id
   AND alias.provider_session_id=NEW.provider_session_id AND alias.participant_identity_id=NEW.participant_identity_id
   AND alias.phone_number_id=NEW.phone_number_id AND alias.waba_id=NEW.account_id AND alias.state='ACTIVE'
   AND alias.kind=source.meta_routing_evidence#>>'{peer,kind}' AND alias.value=source.meta_routing_evidence#>>'{peer,value}')
  THEN RAISE EXCEPTION 'primary delivery source changed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_meta_primary_delivery() FROM PUBLIC;
CREATE TRIGGER meta_primary_delivery_immutable BEFORE INSERT OR UPDATE OR DELETE ON meta_primary_delivery_admissions
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_primary_delivery();

CREATE FUNCTION app.meta_primary_delivery_source(connection_value uuid,session_value uuid,participant_value uuid,app_value text,runtime_value jsonb,source_value uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT admission.source_event_id FROM public.meta_primary_delivery_admissions admission
 JOIN public.event_inbox source ON source.tenant_id=admission.tenant_id AND source.id=admission.source_event_id
 JOIN public.provider_sessions session ON session.tenant_id=admission.tenant_id AND session.id=admission.provider_session_id
 JOIN public.connections connection ON connection.tenant_id=admission.tenant_id AND connection.id=admission.connection_id
 WHERE admission.tenant_id=app.current_tenant_id() AND admission.connection_id=connection_value AND admission.provider_session_id=session_value
  AND admission.participant_identity_id=participant_value AND admission.app_id=app_value AND admission.runtime_binding=runtime_value
  AND(source_value IS NULL OR admission.source_event_id=source_value)
  AND admission.proof_sha256=app.meta_account_proof_sha256(session.provider_state_data->'metaAccountProof') AND admission.secret_reference=connection.secret_reference
  AND app.meta_primary_delivery_eligible(connection_value,session_value,admission.phone_number_id,admission.account_id,app_value,runtime_value)
  AND source.status IN('PROCESSING','PROCESSED') AND(source.status='PROCESSED' OR(source.lease_id IS NOT NULL AND source.lease_expires_at>clock_timestamp()))
  AND source.meta_routing_participant_id=participant_value AND source.meta_routing_epoch=0 AND source.meta_direct_identity_change IS NULL
  AND source.meta_routing_evidence->>'category'='PRIMARY_MESSAGE' AND source.meta_routing_evidence->'redacted' IS DISTINCT FROM 'true'::jsonb
  AND source.payload_sha256=admission.source_hash AND source.meta_routing_evidence->>'payloadSha256'=admission.source_hash
  AND admission.observed_at+interval '24 hours'>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.privacy_jobs job JOIN public.privacy_job_targets target ON target.tenant_id=job.tenant_id AND target.job_id=job.id
   WHERE job.tenant_id=admission.tenant_id AND job.job_type IN('DELETE','RETENTION_SWEEP') AND job.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')
   AND target.state IN('PENDING','EXTERNAL_COMPLETE','COMPLETE') AND target.target_type IN('META_ROUTING_EVENT','META_DIRECT_IDENTITY_EVENT')
   AND target.target_id=admission.source_event_id::text)
 ORDER BY admission.observed_at DESC,admission.source_event_id DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.meta_primary_delivery_source(uuid,uuid,uuid,text,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_primary_delivery_source(uuid,uuid,uuid,text,jsonb,uuid) TO wasalx_app,wasalx_connector_worker;

ALTER TABLE direct_native_reply_intents ADD COLUMN meta_primary_source_event_id uuid,
 ADD CONSTRAINT meta_primary_native_source_fk FOREIGN KEY(tenant_id,meta_primary_source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION app.meta_direct_routing_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
 participant_value uuid,app_value text,runtime_value jsonb,expected_epoch bigint DEFAULT NULL,
 source_values uuid[] DEFAULT NULL,excluded_action uuid DEFAULT NULL,require_own boolean DEFAULT true)
RETURNS TABLE(allowed boolean,epoch bigint,claim text,reason text,configuration_version bigint,review_version bigint)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE session_row provider_sessions%ROWTYPE;review_row meta_routing_reviews%ROWTYPE;ownership_row meta_thread_ownership%ROWTYPE;
 action_row meta_thread_control_actions%ROWTYPE;
 config_version bigint;legacy boolean;source_id uuid;source_row event_inbox%ROWTYPE;
BEGIN
 allowed:=false;epoch:=NULL;claim:='HELD';reason:='CONFIGURATION_REQUIRED';configuration_version:=0;review_version:=0;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value
  AND id=session_value AND ownership_state='ACTIVE' AND opaque_session_id=phone_value
  AND provider_state_data->>'wabaId' IS NOT DISTINCT FROM account_value;
 IF NOT FOUND THEN reason:='ASSET_CHANGED';RETURN NEXT;RETURN;END IF;
 IF excluded_action IS NOT NULL THEN
  SELECT action.* INTO action_row FROM meta_thread_control_actions action WHERE action.tenant_id=app.current_tenant_id()
   AND action.id=excluded_action AND action.connection_id=connection_value AND action.provider_session_id=session_value
   AND action.participant_identity_id=participant_value AND action.phone_number_id=phone_value AND action.account_id IS NOT DISTINCT FROM account_value
   AND action.app_id=app_value AND action.runtime_binding=runtime_value AND action.state='RUNNING' AND action.expires_at>clock_timestamp();
  IF NOT FOUND THEN reason:='ACTION_CHANGED';RETURN NEXT;RETURN;END IF;
  IF action_row.credential_context->'proof' IS DISTINCT FROM session_row.provider_state_data->'metaAccountProof'
   OR NOT EXISTS(SELECT 1 FROM connections connection WHERE connection.tenant_id=app.current_tenant_id() AND connection.id=connection_value
    AND connection.secret_reference=action_row.credential_context->>'secretReference')
   THEN reason:='ACTION_CHANGED';RETURN NEXT;RETURN;END IF;
  expected_epoch:=action_row.routing_epoch;require_own:=action_row.action<>'take';
 END IF;
 IF EXISTS(SELECT 1 FROM meta_thread_control_actions action WHERE action.tenant_id=app.current_tenant_id()
  AND action.connection_id=connection_value AND action.state IN('RUNNING','OUTCOME_UNKNOWN')
  AND(action.participant_identity_id=participant_value OR(action.participant_identity_id IS NULL AND action.phone_number_id=phone_value AND action.app_id=app_value))
  AND action.id IS DISTINCT FROM excluded_action) THEN reason:='ACTION_UNRESOLVED';RETURN NEXT;RETURN;END IF;
 IF EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.connection_id=connection_value
  AND source.meta_routing_evidence->>'providerSessionId'=session_value::text
  AND source.meta_routing_evidence->>'phoneNumberId'=phone_value
  AND source.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','CONTROL_TAKEN','UNRESOLVED_ROUTING')
  AND(source.meta_routing_evidence->'redacted' IS DISTINCT FROM 'true'::jsonb OR source.meta_routing_epoch IS NULL)
  AND (source.meta_routing_participant_id IS NULL OR(source.meta_routing_participant_id=participant_value AND source.meta_routing_epoch IS NULL)))
 THEN reason:='NEGATIVE_PENDING';RETURN NEXT;RETURN;END IF;
 IF excluded_action IS NULL AND app.meta_primary_delivery_eligible(connection_value,session_value,phone_value,account_value,app_value,runtime_value) THEN
  claim:='PRIMARY_DELIVERY';epoch:=0;
  IF expected_epoch IS NOT NULL AND expected_epoch<>0 THEN reason:='EPOCH_CHANGED';RETURN NEXT;RETURN;END IF;
  IF NOT require_own AND source_values IS NULL THEN allowed:=true;reason:=NULL;RETURN NEXT;RETURN;END IF;
  IF source_values IS NULL THEN
   allowed:=app.meta_primary_delivery_source(connection_value,session_value,participant_value,app_value,runtime_value) IS NOT NULL;
  ELSIF cardinality(source_values) BETWEEN 1 AND 2 THEN
   allowed:=true;
   FOREACH source_id IN ARRAY source_values LOOP
    IF app.meta_primary_delivery_source(connection_value,session_value,participant_value,app_value,runtime_value,source_id) IS NULL THEN allowed:=false;EXIT;END IF;
   END LOOP;
  END IF;
  reason:=CASE WHEN allowed THEN NULL ELSE 'PRIMARY_DELIVERY_REQUIRED' END;RETURN NEXT;RETURN;
 END IF;
 SELECT EXISTS(SELECT 1 FROM meta_routing_legacy_admissions admission WHERE admission.tenant_id=app.current_tenant_id()
  AND admission.connection_id=connection_value AND admission.provider_session_id=session_value
  AND admission.phone_number_id=phone_value AND admission.account_id IS NOT DISTINCT FROM account_value AND admission.disabled_at IS NULL)
  AND NOT session_row.provider_state_data ?| ARRAY['metaSignup','metaShared','metaRouting','metaRoutingEvidence']
  AND NOT EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.connection_id=connection_value
   AND source.meta_routing_evidence->>'providerSessionId'=session_value::text
   AND source.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','STANDBY_ECHO','STANDBY_STATUS','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING'))
 INTO legacy;
 IF legacy THEN
  IF excluded_action IS NOT NULL THEN reason:='CONFIGURATION_REQUIRED';RETURN NEXT;RETURN;END IF;
  claim:='LEGACY_COMPATIBILITY';epoch:=0;allowed:=expected_epoch IS NULL OR expected_epoch=0;
  reason:=CASE WHEN allowed THEN NULL ELSE 'EPOCH_CHANGED' END;
 ELSE
  IF COALESCE(session_row.provider_state_data#>>'{metaRouting,version}','')!~'^[0-9]{1,15}$' THEN RETURN NEXT;RETURN;END IF;
  config_version:=(session_row.provider_state_data#>>'{metaRouting,version}')::bigint;configuration_version:=config_version;
  SELECT review.* INTO review_row FROM meta_routing_reviews review WHERE review.tenant_id=app.current_tenant_id() AND review.connection_id=connection_value ORDER BY review.review_version DESC LIMIT 1;
  IF NOT FOUND OR review_row.disposition<>'REVIEWED' OR review_row.provider_session_id<>session_value
   OR review_row.phone_number_id<>phone_value OR review_row.account_id IS DISTINCT FROM account_value OR review_row.app_id<>app_value
   OR review_row.configuration_version<>config_version OR review_row.runtime_binding IS DISTINCT FROM runtime_value
   THEN RETURN NEXT;RETURN;END IF;
  review_version:=review_row.review_version;
  IF excluded_action IS NOT NULL AND(action_row.configuration_version<>config_version OR action_row.review_version<>review_row.review_version
   OR review_row.observation->'threadControlEnabled' IS DISTINCT FROM 'true'::jsonb
   OR(action_row.action='take' AND NOT(review_row.observation->'roles' ? 'escalation'))
   OR(action_row.action='pass' AND action_row.target_role IS NULL AND review_row.observation->'roles' ? 'escalation')
   OR(action_row.action='pass' AND action_row.target_role IS NOT NULL AND NOT(review_row.observation->'targets' ? action_row.target_role)))
   THEN reason:='ACTION_NOT_AVAILABLE';RETURN NEXT;RETURN;END IF;
  SELECT * INTO ownership_row FROM meta_thread_ownership WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value
   AND provider_session_id=session_value AND participant_identity_id=participant_value;
  epoch:=COALESCE(ownership_row.epoch,0);claim:=COALESCE(ownership_row.state,'UNKNOWN');
  IF expected_epoch IS NOT NULL AND expected_epoch<>epoch THEN reason:='EPOCH_CHANGED';RETURN NEXT;RETURN;END IF;
  IF require_own AND(ownership_row.state IS DISTINCT FROM 'OWN' OR ownership_row.configuration_version<>config_version
   OR ownership_row.review_version<>review_row.review_version OR ownership_row.phone_number_id<>phone_value
   OR ownership_row.account_id IS DISTINCT FROM account_value OR ownership_row.observed_at<review_row.observed_at)
   THEN reason:='OWNERSHIP_REQUIRED';RETURN NEXT;RETURN;END IF;
  IF require_own AND(ownership_row.last_customer_message_at IS NULL OR ownership_row.last_customer_message_at+interval '24 hours'<=clock_timestamp())
   THEN claim:='IDLE';reason:='USER_WINDOW_EXPIRED';RETURN NEXT;RETURN;END IF;
  allowed:=true;reason:=NULL;
 END IF;
 IF source_values IS NOT NULL THEN
  IF cardinality(source_values) NOT BETWEEN 1 AND 2 THEN allowed:=false;reason:='SOURCE_CHANGED';RETURN NEXT;RETURN;END IF;
  FOREACH source_id IN ARRAY source_values LOOP
   SELECT * INTO source_row FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value AND id=source_id;
   IF FOUND AND legacy AND source_row.meta_routing_evidence IS NULL AND source_row.event_type='messages'
    AND source_row.meta_direct_asset=jsonb_build_object('providerSessionId',session_value,'phoneNumberId',phone_value,'wabaId',account_value)
    AND source_row.meta_direct_identity_change IS NULL AND source_row.payload#>>'{entry,0,changes,0,field}'='messages'
    AND source_row.payload#>>'{entry,0,changes,0,value,messages,0,type}' IS DISTINCT FROM 'system'
    AND source_row.payload#>'{entry,0,changes,0,value,messages,0,group_id}' IS NULL
    AND source_row.meta_routing_epoch IS NOT DISTINCT FROM 0::bigint
    AND source_row.status NOT IN('REDACTED','QUARANTINED','IGNORED','UNMATCHED')
    AND EXISTS(SELECT 1 FROM meta_routing_legacy_admissions admission WHERE admission.tenant_id=app.current_tenant_id()
     AND admission.provider_session_id=session_value AND source_row.received_at<=admission.admitted_at) THEN CONTINUE;END IF;
   IF NOT FOUND OR source_row.meta_routing_evidence->>'category' IS DISTINCT FROM 'PRIMARY_MESSAGE'
    OR source_row.meta_routing_evidence->>'providerSessionId' IS DISTINCT FROM session_value::text
    OR source_row.meta_routing_epoch IS DISTINCT FROM epoch OR(NOT legacy AND(source_row.meta_routing_participant_id IS DISTINCT FROM participant_value
      OR(source_row.meta_routing_evidence->>'observedAt')::timestamptz<review_row.observed_at
      OR(source_row.meta_routing_evidence->>'observedAt')::timestamptz<ownership_row.epoch_started_at))
    OR source_row.status IN('REDACTED','QUARANTINED','IGNORED','UNMATCHED') THEN allowed:=false;reason:='SOURCE_CHANGED';EXIT;END IF;
  END LOOP;
 END IF;
 RETURN NEXT;
END;
$$;
CREATE OR REPLACE FUNCTION app.snapshot_meta_routing_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE session_row provider_sessions%ROWTYPE;review_row meta_routing_reviews%ROWTYPE;participant_value uuid;guard_row record;primary_row public.meta_primary_delivery_admissions%ROWTYPE;
BEGIN
 IF NEW.bot_conversation_id IS NULL OR NOT EXISTS(SELECT 1 FROM connections WHERE tenant_id=NEW.tenant_id AND id=NEW.connection_id AND provider='META') THEN
  IF NEW.meta_routing_epoch IS NOT NULL OR NEW.meta_routing_source_event_id IS NOT NULL THEN RAISE EXCEPTION 'routing snapshot on unsupported route' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=NEW.tenant_id AND delivery.idempotency_key=NEW.idempotency_key) THEN RETURN NEW;END IF;
 PERFORM 1 FROM connections WHERE tenant_id=NEW.tenant_id AND id=NEW.connection_id FOR UPDATE;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=NEW.tenant_id AND connection_id=NEW.connection_id AND ownership_state='ACTIVE';
 SELECT participant.id INTO participant_value FROM participant_identities participant WHERE participant.tenant_id=NEW.tenant_id
  AND participant.connection_id=NEW.connection_id AND participant.external_participant_id=NEW.external_chat_id;
 SELECT review.* INTO review_row FROM meta_routing_reviews review WHERE review.tenant_id=NEW.tenant_id AND review.connection_id=NEW.connection_id ORDER BY review.review_version DESC LIMIT 1;
 IF NEW.direct_origin='BOT' AND NEW.meta_routing_source_event_id IS NULL THEN RAISE EXCEPTION 'original routing source required' USING ERRCODE='23514';END IF;
 IF review_row.id IS NULL THEN
  SELECT admission.* INTO primary_row FROM public.meta_primary_delivery_admissions admission
   WHERE admission.tenant_id=NEW.tenant_id AND admission.connection_id=NEW.connection_id AND admission.provider_session_id=session_row.id
   AND admission.participant_identity_id=participant_value
   AND(NEW.meta_routing_source_event_id IS NULL OR admission.source_event_id=NEW.meta_routing_source_event_id)
   ORDER BY admission.observed_at DESC,admission.source_event_id DESC LIMIT 1;
  IF primary_row.source_event_id IS NOT NULL THEN
   NEW.meta_routing_source_event_id:=primary_row.source_event_id;
   IF NEW.created_at<primary_row.created_at THEN RAISE EXCEPTION 'routing effect predates primary delivery' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 SELECT * INTO guard_row FROM app.meta_direct_routing_guard(NEW.connection_id,session_row.id,session_row.opaque_session_id,
  session_row.provider_state_data->>'wabaId',participant_value,COALESCE(review_row.app_id,primary_row.app_id,''),COALESCE(review_row.runtime_binding,primary_row.runtime_binding),NEW.meta_routing_epoch,
  CASE WHEN NEW.meta_routing_source_event_id IS NULL THEN NULL ELSE ARRAY[NEW.meta_routing_source_event_id] END);
 IF guard_row.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'routing effect held' USING ERRCODE='23514';END IF;
 NEW.meta_routing_epoch:=guard_row.epoch;RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.snapshot_meta_routing_native_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE conversation_row bot_conversations%ROWTYPE;session_row provider_sessions%ROWTYPE;review_row meta_routing_reviews%ROWTYPE;
 participant_value uuid;guard_row record;primary_row public.meta_primary_delivery_admissions%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.meta_routing_epoch IS DISTINCT FROM OLD.meta_routing_epoch OR NEW.meta_primary_source_event_id IS DISTINCT FROM OLD.meta_primary_source_event_id THEN RAISE EXCEPTION 'native routing epoch is immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO conversation_row FROM bot_conversations WHERE tenant_id=NEW.tenant_id AND id=NEW.conversation_id;
 IF NOT EXISTS(SELECT 1 FROM connections WHERE tenant_id=NEW.tenant_id AND id=conversation_row.connection_id AND provider='META') THEN
  IF NEW.meta_routing_epoch IS NOT NULL OR NEW.meta_primary_source_event_id IS NOT NULL THEN RAISE EXCEPTION 'routing epoch on unsupported native route' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 PERFORM 1 FROM connections WHERE tenant_id=NEW.tenant_id AND id=conversation_row.connection_id FOR UPDATE;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=NEW.tenant_id AND connection_id=conversation_row.connection_id AND ownership_state='ACTIVE';
 SELECT id INTO participant_value FROM participant_identities WHERE tenant_id=NEW.tenant_id AND connection_id=conversation_row.connection_id AND external_participant_id=conversation_row.external_chat_id;
 SELECT review.* INTO review_row FROM meta_routing_reviews review WHERE review.tenant_id=NEW.tenant_id AND review.connection_id=conversation_row.connection_id ORDER BY review.review_version DESC LIMIT 1;
 IF NEW.meta_primary_source_event_id IS NOT NULL THEN RAISE EXCEPTION 'primary native source must be snapshotted' USING ERRCODE='23514';END IF;
 IF review_row.id IS NULL THEN
  SELECT admission.* INTO primary_row FROM public.meta_primary_delivery_admissions admission
   WHERE admission.tenant_id=NEW.tenant_id AND admission.connection_id=conversation_row.connection_id AND admission.provider_session_id=session_row.id
   AND admission.participant_identity_id=participant_value ORDER BY admission.observed_at DESC,admission.source_event_id DESC LIMIT 1;
  NEW.meta_primary_source_event_id:=primary_row.source_event_id;
  IF NEW.meta_primary_source_event_id IS NOT NULL AND NEW.created_at<primary_row.created_at THEN
   RAISE EXCEPTION 'native intent predates primary delivery' USING ERRCODE='23514';END IF;
 ELSIF NEW.meta_primary_source_event_id IS NOT NULL THEN RAISE EXCEPTION 'primary source on reviewed native route' USING ERRCODE='23514';
 END IF;
 SELECT * INTO guard_row FROM app.meta_direct_routing_guard(conversation_row.connection_id,session_row.id,session_row.opaque_session_id,
  session_row.provider_state_data->>'wabaId',participant_value,COALESCE(review_row.app_id,primary_row.app_id,''),COALESCE(review_row.runtime_binding,primary_row.runtime_binding),NEW.meta_routing_epoch,
  CASE WHEN NEW.meta_primary_source_event_id IS NULL THEN NULL ELSE ARRAY[NEW.meta_primary_source_event_id] END);
 IF guard_row.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'native routing held' USING ERRCODE='23514';END IF;
 NEW.meta_routing_epoch:=guard_row.epoch;RETURN NEW;
END;
$$;

DROP TRIGGER meta_routing_native_snapshot ON direct_native_reply_intents;
CREATE TRIGGER meta_routing_native_snapshot BEFORE INSERT OR UPDATE OF meta_routing_epoch,meta_primary_source_event_id ON direct_native_reply_intents
 FOR EACH ROW EXECUTE FUNCTION app.snapshot_meta_routing_native_intent();

-- Readiness polls must not scan historical or rejected callbacks after reconnect.
CREATE INDEX event_inbox_meta_message_readiness_idx
 ON public.event_inbox(tenant_id,connection_id,(meta_direct_asset->>'providerSessionId'),received_at DESC)
 WHERE provider='META' AND event_type='messages' AND status='PROCESSED' AND meta_routing_epoch IS NOT NULL;
CREATE INDEX event_inbox_meta_primary_negative_idx
 ON public.event_inbox(tenant_id,connection_id,(meta_routing_evidence->>'providerSessionId'))
 WHERE meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','STANDBY_ECHO','STANDBY_STATUS','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING');

COMMIT;
