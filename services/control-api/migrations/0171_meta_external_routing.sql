BEGIN;

-- This admission preserves existing product behavior; it is not Meta ownership
-- or configuration evidence. No runtime role may create another admission.
CREATE TABLE meta_routing_legacy_admissions (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,provider_session_id uuid NOT NULL,
 phone_number_id text NOT NULL,account_id text,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),disabled_at timestamptz,
 PRIMARY KEY(tenant_id,provider_session_id),
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id) ON DELETE RESTRICT
);
INSERT INTO meta_routing_legacy_admissions(tenant_id,connection_id,provider_session_id,phone_number_id,account_id)
 SELECT session.tenant_id,session.connection_id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId'
 FROM provider_sessions session JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
 WHERE connection.provider='META' AND session.ownership_state='ACTIVE'
 AND NOT session.provider_state_data ?| ARRAY['metaSignup','metaShared','metaRouting','metaRoutingEvidence'];
ALTER TABLE meta_routing_legacy_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_routing_legacy_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_routing_legacy_admissions USING(tenant_id=app.current_tenant_id());
GRANT SELECT ON meta_routing_legacy_admissions TO wasalx_app,wasalx_connector_worker;

-- Independent operator observation is immutable source evidence, never OWN.
CREATE TABLE meta_routing_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,connection_id uuid NOT NULL,
 provider_session_id uuid NOT NULL,phone_number_id text NOT NULL,account_id text NOT NULL,app_id text NOT NULL,
 configuration_version bigint NOT NULL CHECK(configuration_version>=0),review_version bigint NOT NULL CHECK(review_version>0),
 disposition text NOT NULL CHECK(disposition IN('REVIEWED','REVOKED')),runtime_binding jsonb NOT NULL,
 observation jsonb NOT NULL,observed_at timestamptz NOT NULL,operator_subject text NOT NULL,
 idempotency_key text NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,connection_id,review_version),UNIQUE(operator_subject,idempotency_key),
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id) ON DELETE RESTRICT,
 CHECK(phone_number_id~'^[0-9]{1,32}$' AND account_id~'^[0-9]{1,32}$' AND app_id~'^[0-9]{1,32}$'),
 CHECK(length(operator_subject) BETWEEN 1 AND 255 AND length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key!~'[[:cntrl:]]')
);
ALTER TABLE meta_routing_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_routing_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_routing_reviews USING(tenant_id=app.current_tenant_id());
GRANT SELECT ON meta_routing_reviews TO wasalx_app,wasalx_connector_worker;

ALTER TABLE event_inbox ADD COLUMN meta_routing_evidence jsonb,
 ADD COLUMN meta_routing_participant_id uuid,ADD COLUMN meta_routing_epoch bigint,
 ADD CONSTRAINT meta_routing_participant_fk FOREIGN KEY(tenant_id,connection_id,meta_routing_participant_id)
 REFERENCES participant_identities(tenant_id,connection_id,id) ON DELETE RESTRICT;
CREATE INDEX meta_routing_pending_idx ON event_inbox(tenant_id,connection_id)
 WHERE meta_routing_evidence IS NOT NULL;

CREATE TABLE meta_thread_ownership (
 tenant_id uuid NOT NULL,connection_id uuid NOT NULL,provider_session_id uuid NOT NULL,participant_identity_id uuid NOT NULL,
 phone_number_id text NOT NULL,account_id text NOT NULL,state text NOT NULL CHECK(state IN('OWN','STANDBY','IDLE','UNKNOWN')),
 epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),configuration_version bigint NOT NULL,
 review_version bigint NOT NULL,observed_at timestamptz NOT NULL,epoch_started_at timestamptz NOT NULL,last_customer_message_at timestamptz,
 source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),source_event_id uuid,source_action_id uuid,
 PRIMARY KEY(tenant_id,connection_id,provider_session_id,participant_identity_id),
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,connection_id,participant_identity_id) REFERENCES participant_identities(tenant_id,connection_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE meta_thread_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_thread_ownership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_thread_ownership USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON meta_thread_ownership TO wasalx_app,wasalx_connector_worker;
CREATE TRIGGER meta_routing_ownership_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON meta_thread_ownership
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE TABLE meta_thread_control_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,connection_id uuid NOT NULL,
 provider_session_id uuid NOT NULL,participant_identity_id uuid,conversation_id uuid,
 phone_number_id text NOT NULL,account_id text NOT NULL,app_id text NOT NULL,
 routing_epoch bigint NOT NULL,configuration_version bigint NOT NULL,review_version bigint NOT NULL,
 action text NOT NULL CHECK(action IN('take','pass','release')),target_role text,
 recipient_snapshot jsonb NOT NULL,runtime_binding jsonb NOT NULL,credential_context jsonb NOT NULL,actor_id uuid NOT NULL,
 idempotency_key text NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256~'^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'RUNNING' CHECK(state IN('RUNNING','SUCCEEDED','FAILED','OUTCOME_UNKNOWN')),
 dispatched_at timestamptz,expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '60 seconds'),
 provider_request_id text,error_code text,completed_at timestamptz,redacted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,connection_id,participant_identity_id) REFERENCES participant_identities(tenant_id,connection_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(tenant_id,conversation_id) REFERENCES bot_conversations(tenant_id,id) ON DELETE RESTRICT,
 CHECK(length(idempotency_key) BETWEEN 1 AND 255 AND idempotency_key!~'[[:cntrl:]]'),
 CHECK(target_role IS NULL OR(action='pass' AND target_role IN('ai_agent','ctwa','customer_service','escalation','marketing','utility'))),
 CHECK(provider_request_id IS NULL OR(length(provider_request_id) BETWEEN 1 AND 512 AND provider_request_id!~'[[:cntrl:]]')),
 CHECK(error_code IS NULL OR error_code~'^[A-Z0-9_]{1,100}$')
);
ALTER TABLE meta_thread_control_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_thread_control_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_thread_control_actions USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON meta_thread_control_actions TO wasalx_app,wasalx_connector_worker;
CREATE UNIQUE INDEX meta_thread_control_unresolved_idx ON meta_thread_control_actions(tenant_id,connection_id,participant_identity_id)
 WHERE state IN('RUNNING','OUTCOME_UNKNOWN');
CREATE TRIGGER meta_routing_action_privacy_fence BEFORE INSERT OR UPDATE OR DELETE ON meta_thread_control_actions
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
ALTER TABLE meta_thread_ownership ADD CONSTRAINT meta_routing_action_fk FOREIGN KEY(tenant_id,source_action_id)
 REFERENCES meta_thread_control_actions(tenant_id,id) ON DELETE RESTRICT;

-- All consumers query this same authority. No receipt, review, alias or caller
-- flag can clear an unresolved action or an unscoped negative observation.
CREATE FUNCTION app.meta_direct_routing_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
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
REVOKE ALL ON FUNCTION app.meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean) TO wasalx_app,wasalx_connector_worker;

ALTER TABLE delivery_outbox ADD COLUMN meta_routing_epoch bigint,ADD COLUMN meta_routing_source_event_id uuid,
 ADD CONSTRAINT meta_routing_delivery_source_fk FOREIGN KEY(tenant_id,meta_routing_source_event_id) REFERENCES event_inbox(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE direct_native_reply_intents ADD COLUMN meta_routing_epoch bigint;

CREATE FUNCTION app.operator_meta_routing_review(tenant_value uuid,connection_value uuid,actor_subject text,audit_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE result_value jsonb;
BEGIN
 SELECT jsonb_build_object('connectionId',connection.id,'sessionId',session.id,'phoneNumberId',session.opaque_session_id,
  'accountId',session.provider_state_data->>'wabaId','declaration',session.provider_state_data->'metaRouting',
  'review',CASE WHEN review.id IS NULL THEN NULL ELSE jsonb_build_object('id',review.id,'version',review.review_version,
   'disposition',review.disposition,'observedAt',review.observed_at,'configurationVersion',review.configuration_version,
   'runtime',review.runtime_binding,'observation',review.observation) END)
 INTO result_value FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
 LEFT JOIN LATERAL(SELECT item.* FROM meta_routing_reviews item WHERE item.tenant_id=connection.tenant_id AND item.connection_id=connection.id ORDER BY item.review_version DESC LIMIT 1) review ON true
 WHERE connection.tenant_id=tenant_value AND connection.id=connection_value AND connection.provider='META' AND session.ownership_state='ACTIVE';
 IF result_value IS NULL THEN RAISE EXCEPTION 'connection not found' USING ERRCODE='P0002';END IF;
 INSERT INTO platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(actor_subject,'platform.meta_routing.inspected','connection',connection_value::text,jsonb_build_object('tenantId',tenant_value),audit_request_id);
 RETURN result_value;
END;
$$;

CREATE FUNCTION app.operator_record_meta_routing_review(tenant_value uuid,connection_value uuid,body_value jsonb,
 app_value text,runtime_value jsonb,request_key text,request_hash text,actor_subject text,audit_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE session_row provider_sessions%ROWTYPE;previous_row meta_routing_reviews%ROWTYPE;inserted_row meta_routing_reviews%ROWTYPE;
 config_version bigint;latest_version bigint;result_value jsonb;
BEGIN
 IF (request_hash~'^[0-9a-f]{64}$' AND length(request_key) BETWEEN 1 AND 255 AND request_key!~'[[:cntrl:]]'
  AND length(actor_subject) BETWEEN 1 AND 255 AND app_value~'^[0-9]{1,32}$'
  AND jsonb_typeof(body_value)='object' AND body_value ?& ARRAY['expectedSessionId','expectedConfigurationVersion','expectedReviewVersion','disposition','observedAt','evidenceSha256','evidenceReference','scope','roles','targets','fields','termsAccepted','threadControlEnabled','personallyObserved']
  AND body_value-ARRAY['expectedSessionId','expectedConfigurationVersion','expectedReviewVersion','disposition','observedAt','evidenceSha256','evidenceReference','scope','roles','targets','fields','termsAccepted','threadControlEnabled','personallyObserved']='{}'::jsonb
  AND jsonb_typeof(body_value->'expectedSessionId')='string' AND body_value->>'expectedSessionId'~'^[0-9a-f-]{36}$'
  AND jsonb_typeof(body_value->'expectedConfigurationVersion')='number' AND body_value->>'expectedConfigurationVersion'~'^[0-9]{1,15}$'
  AND jsonb_typeof(body_value->'expectedReviewVersion')='number' AND body_value->>'expectedReviewVersion'~'^[0-9]{1,15}$'
  AND jsonb_typeof(body_value->'observedAt')='string' AND body_value->>'observedAt'~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND body_value->>'disposition' IN('REVIEWED','REVOKED') AND body_value->'personallyObserved'='true'::jsonb
  AND body_value->>'evidenceSha256'~'^[0-9a-f]{64}$' AND body_value->>'evidenceReference'~'^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  AND body_value->>'scope' IN('PHONE_OVERRIDE','ACCOUNT_DEFAULT') AND jsonb_typeof(body_value->'termsAccepted')='boolean' AND jsonb_typeof(body_value->'threadControlEnabled')='boolean'
  AND jsonb_typeof(body_value->'roles')='array' AND jsonb_typeof(body_value->'targets')='array' AND jsonb_typeof(body_value->'fields')='array'
  AND jsonb_typeof(runtime_value)='object' AND runtime_value->>'mode' IN('LIVE','SIMULATED') AND runtime_value->>'graphVersion'~'^v[0-9]{1,3}\.[0-9]{1,3}$'
  AND runtime_value-ARRAY['mode','graphOrigin','graphVersion','simulationBindingSha256']='{}'::jsonb
  AND((runtime_value->>'mode'='LIVE' AND runtime_value->>'graphOrigin'='https://graph.facebook.com' AND NOT runtime_value ? 'simulationBindingSha256')
   OR(runtime_value->>'mode'='SIMULATED' AND runtime_value->>'graphOrigin'~'^https://[^/@?#]+(:[0-9]+)?$' AND runtime_value->>'simulationBindingSha256'~'^[0-9a-f]{64}$'))) IS NOT TRUE
  THEN RAISE EXCEPTION 'invalid routing observation' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(body_value->'roles')>6 OR jsonb_array_length(body_value->'targets')>6 OR jsonb_array_length(body_value->'fields')>3
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text((body_value->'roles')||(body_value->'targets')) item(value) WHERE value IS NULL OR value NOT IN('ai_agent','ctwa','customer_service','escalation','marketing','utility'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(body_value->'fields') item(value) WHERE value IS NULL OR value NOT IN('messages','standby','messaging_handovers'))
  OR jsonb_array_length(body_value->'roles')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(body_value->'roles'))
  OR jsonb_array_length(body_value->'targets')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(body_value->'targets'))
  OR jsonb_array_length(body_value->'fields')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(body_value->'fields'))
  OR(body_value->>'disposition'='REVIEWED' AND(jsonb_array_length(body_value->'roles')=0 OR body_value->'termsAccepted'<>'true'::jsonb OR NOT(body_value->'fields') ?& ARRAY['messages','messaging_handovers']))
  OR (body_value->>'observedAt')::timestamptz IS NULL OR (body_value->>'observedAt')::timestamptz<='epoch'::timestamptz
  THEN RAISE EXCEPTION 'invalid routing observation' USING ERRCODE='22023';END IF;
 PERFORM 1 FROM connections WHERE tenant_id=tenant_value AND id=connection_value AND provider='META' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'connection not found' USING ERRCODE='P0002';END IF;
 SELECT * INTO previous_row FROM meta_routing_reviews WHERE operator_subject=actor_subject AND idempotency_key=request_key;
 IF FOUND THEN
  IF previous_row.tenant_id<>tenant_value OR previous_row.connection_id<>connection_value OR previous_row.request_sha256<>request_hash
   THEN RAISE EXCEPTION 'idempotency key reused' USING ERRCODE='23505';END IF;
  RETURN jsonb_build_object('id',previous_row.id,'version',previous_row.review_version,'disposition',previous_row.disposition,'duplicate',true);
 END IF;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=tenant_value AND connection_id=connection_value AND ownership_state='ACTIVE' FOR UPDATE;
 IF NOT FOUND OR session_row.id::text IS DISTINCT FROM body_value->>'expectedSessionId'
  OR session_row.provider_state_data->>'wabaId' IS NULL OR session_row.provider_state_data#>>'{metaRouting,version}' IS NULL
  THEN RAISE EXCEPTION 'routing session changed' USING ERRCODE='40001';END IF;
 config_version:=(session_row.provider_state_data#>>'{metaRouting,version}')::bigint;
 SELECT COALESCE(max(review.review_version),0) INTO latest_version FROM meta_routing_reviews review WHERE review.tenant_id=tenant_value AND review.connection_id=connection_value;
 IF config_version IS DISTINCT FROM(body_value->>'expectedConfigurationVersion')::bigint
  OR latest_version IS DISTINCT FROM(body_value->>'expectedReviewVersion')::bigint
  OR(body_value->>'observedAt')::timestamptz>clock_timestamp()
  OR(body_value->>'observedAt')::timestamptz<(session_row.provider_state_data#>>'{metaRouting,declaredAt}')::timestamptz
  THEN RAISE EXCEPTION 'routing observation changed' USING ERRCODE='40001';END IF;
 INSERT INTO meta_routing_reviews(tenant_id,connection_id,provider_session_id,phone_number_id,account_id,app_id,configuration_version,
  review_version,disposition,runtime_binding,observation,observed_at,operator_subject,idempotency_key,request_sha256)
 VALUES(tenant_value,connection_value,session_row.id,session_row.opaque_session_id,session_row.provider_state_data->>'wabaId',app_value,
  config_version,latest_version+1,body_value->>'disposition',runtime_value,
  body_value-ARRAY['expectedSessionId','expectedConfigurationVersion','expectedReviewVersion'],(body_value->>'observedAt')::timestamptz,
  actor_subject,request_key,request_hash) RETURNING * INTO inserted_row;
 result_value:=jsonb_build_object('id',inserted_row.id,'version',inserted_row.review_version,'disposition',inserted_row.disposition,'duplicate',false);
 INSERT INTO platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(actor_subject,'platform.meta_routing.reviewed','connection',connection_value::text,
  jsonb_build_object('tenantId',tenant_value,'sessionId',session_row.id,'configurationVersion',config_version,'reviewVersion',inserted_row.review_version,
   'disposition',inserted_row.disposition,'evidenceSha256',body_value->>'evidenceSha256','mode',runtime_value->>'mode'),audit_request_id);
 RETURN result_value;
END;
$$;
REVOKE ALL ON FUNCTION app.operator_meta_routing_review(uuid,uuid,text,text),app.operator_record_meta_routing_review(uuid,uuid,jsonb,text,jsonb,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_routing_review(uuid,uuid,text,text),app.operator_record_meta_routing_review(uuid,uuid,jsonb,text,jsonb,text,text,text,text) TO wasalx_platform_operations_client;

CREATE FUNCTION app.resolve_meta_routing_routes(account_value text,phone_value text,app_value text,secret_value text)
RETURNS TABLE(tenant_id uuid,connection_id uuid,provider text,hmac_secret_reference text,provider_session_id uuid,phone_number_id text,account_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT connection.tenant_id,connection.id,'META'::text,route.hmac_secret_reference,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId'
 FROM connections connection JOIN tenants tenant ON tenant.id=connection.tenant_id
 JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
 JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id AND route.provider='META'
 WHERE connection.provider='META' AND connection.engine='CLOUD_API' AND tenant.state='ACTIVE'
  AND route.hmac_secret_reference=secret_value AND route.external_key=session.opaque_session_id
  AND(phone_value IS NULL OR session.opaque_session_id=phone_value)
  AND(session.provider_state_data->>'wabaId'=account_value OR(phone_value IS NOT NULL AND session.provider_state_data->>'wabaId' IS NULL))
  AND(session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=app_value
   OR session.provider_state_data#>'{metaAccountProof,credentialMetadata}' IS NULL)
$$;
REVOKE ALL ON FUNCTION app.resolve_meta_routing_routes(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_meta_routing_routes(text,text,text,text) TO wasalx_app;

CREATE FUNCTION app.preserve_meta_routing_source() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE evidence jsonb:=NEW.meta_routing_evidence;field_value text;category text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.meta_routing_evidence IS NOT NULL AND OLD.meta_routing_evidence->'redacted' IS DISTINCT FROM 'true'::jsonb
   AND NEW.meta_routing_evidence=(OLD.meta_routing_evidence-'peer')||'{"redacted":true}'::jsonb
   AND NEW.meta_routing_participant_id IS NULL AND NEW.meta_routing_epoch IS NOT DISTINCT FROM OLD.meta_routing_epoch
   AND NEW.status='REDACTED' AND NEW.payload='{}'::jsonb AND app.meta_direct_privacy_target_authorized('META_ROUTING_EVENT',OLD.id::text) THEN RETURN NEW;END IF;
  IF NEW.meta_routing_evidence IS DISTINCT FROM OLD.meta_routing_evidence
   OR(OLD.meta_routing_participant_id IS NOT NULL AND NEW.meta_routing_participant_id IS DISTINCT FROM OLD.meta_routing_participant_id)
   OR(OLD.meta_routing_epoch IS NOT NULL AND NEW.meta_routing_epoch IS DISTINCT FROM OLD.meta_routing_epoch)
   THEN RAISE EXCEPTION 'routing admission is immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF evidence IS NULL THEN RETURN NEW;END IF;
 category:=evidence->>'category';field_value:=NEW.payload#>>'{entry,0,changes,0,field}';
 IF NEW.provider<>'META' OR evidence->'schemaVersion' IS DISTINCT FROM '1'::jsonb
  OR evidence->>'payloadSha256' IS DISTINCT FROM NEW.payload_sha256
  OR COALESCE(evidence->>'providerSessionId','')!~'^[0-9a-f-]{36}$'
  OR COALESCE(evidence->>'phoneNumberId','')!~'^[0-9]{1,32}$' OR COALESCE(evidence->>'appId','')!~'^[0-9]{1,32}$'
  OR COALESCE(evidence->>'accountId','')!~'^[0-9]{1,32}$' OR category IS NULL
  OR COALESCE(evidence->>'observedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR NOT EXISTS(SELECT 1 FROM provider_sessions session WHERE session.tenant_id=NEW.tenant_id AND session.connection_id=NEW.connection_id
   AND session.id::text=evidence->>'providerSessionId' AND session.ownership_state='ACTIVE' AND session.opaque_session_id=evidence->>'phoneNumberId'
   AND(session.provider_state_data->>'wabaId' IS NULL OR session.provider_state_data->>'wabaId'=evidence->>'accountId')
   AND(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' IS NULL OR session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=evidence->>'appId'))
  OR(CASE category
   WHEN 'PRIMARY_MESSAGE' THEN NEW.event_type='messages' AND field_value='messages' AND NEW.meta_direct_asset IS NOT NULL
   WHEN 'OWN_MESSAGE_STATUS' THEN NEW.event_type='message.status' AND field_value='messages'
   WHEN 'STANDBY_MESSAGE' THEN NEW.event_type='meta.routing.passive' AND field_value='standby'
   WHEN 'STANDBY_ECHO' THEN NEW.event_type='meta.routing.passive' AND field_value='standby'
   WHEN 'STANDBY_STATUS' THEN NEW.event_type='meta.routing.passive' AND field_value='standby'
   WHEN 'CONTROL_PASSED' THEN NEW.event_type='meta.routing.passive' AND field_value='messaging_handovers'
   WHEN 'CONTROL_TAKEN' THEN NEW.event_type='meta.routing.passive' AND field_value='messaging_handovers'
   WHEN 'UNRESOLVED_ROUTING' THEN NEW.event_type='meta.routing.unresolved' AND NEW.payload->'redacted'='true'::jsonb
   ELSE false END) IS NOT TRUE
  THEN RAISE EXCEPTION 'invalid routing admission' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_routing_source_immutable BEFORE INSERT OR UPDATE OF meta_routing_evidence,meta_routing_participant_id,meta_routing_epoch ON event_inbox
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_routing_source();

-- Applicability is monotonic even if later connection refresh replaces its JSON
-- or privacy removes passive content. A retired original session never regains it.
CREATE FUNCTION app.disable_meta_routing_legacy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF TG_TABLE_NAME='provider_sessions' THEN
  IF NEW.ownership_state<>'ACTIVE' OR NEW.opaque_session_id IS DISTINCT FROM OLD.opaque_session_id
   OR NEW.provider_state_data->>'wabaId' IS DISTINCT FROM OLD.provider_state_data->>'wabaId'
   OR NEW.provider_state_data ?| ARRAY['metaSignup','metaShared','metaRouting','metaRoutingEvidence'] THEN
   UPDATE meta_routing_legacy_admissions SET disabled_at=COALESCE(disabled_at,clock_timestamp())
    WHERE tenant_id=NEW.tenant_id AND provider_session_id=NEW.id;
  END IF;
 ELSIF NEW.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','STANDBY_ECHO','STANDBY_STATUS','CONTROL_PASSED','CONTROL_TAKEN','UNRESOLVED_ROUTING') THEN
  UPDATE meta_routing_legacy_admissions SET disabled_at=COALESCE(disabled_at,clock_timestamp())
   WHERE tenant_id=NEW.tenant_id AND provider_session_id::text=NEW.meta_routing_evidence->>'providerSessionId';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.disable_meta_routing_legacy() FROM PUBLIC;
CREATE TRIGGER meta_routing_legacy_session_fence AFTER UPDATE ON provider_sessions FOR EACH ROW EXECUTE FUNCTION app.disable_meta_routing_legacy();
CREATE TRIGGER meta_routing_legacy_event_fence AFTER INSERT ON event_inbox FOR EACH ROW EXECUTE FUNCTION app.disable_meta_routing_legacy();

-- Capture ownership when the work is created. Dispatch must never repin it.
CREATE FUNCTION app.snapshot_meta_routing_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE session_row provider_sessions%ROWTYPE;review_row meta_routing_reviews%ROWTYPE;participant_value uuid;guard_row record;
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
 SELECT * INTO guard_row FROM app.meta_direct_routing_guard(NEW.connection_id,session_row.id,session_row.opaque_session_id,
  session_row.provider_state_data->>'wabaId',participant_value,COALESCE(review_row.app_id,''),review_row.runtime_binding,NEW.meta_routing_epoch,
  CASE WHEN NEW.meta_routing_source_event_id IS NULL THEN NULL ELSE ARRAY[NEW.meta_routing_source_event_id] END);
 IF guard_row.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'routing effect held' USING ERRCODE='23514';END IF;
 NEW.meta_routing_epoch:=guard_row.epoch;RETURN NEW;
END;
$$;
CREATE TRIGGER meta_routing_delivery_snapshot BEFORE INSERT ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION app.snapshot_meta_routing_delivery();
CREATE FUNCTION app.preserve_meta_routing_delivery() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.meta_routing_epoch IS DISTINCT FROM OLD.meta_routing_epoch OR NEW.meta_routing_source_event_id IS DISTINCT FROM OLD.meta_routing_source_event_id
  THEN RAISE EXCEPTION 'routing effect provenance is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
$$;

-- Only the exact already-existing asset is eligible for queue compatibility.
UPDATE delivery_outbox delivery SET meta_routing_epoch=0 FROM meta_routing_legacy_admissions admission
 WHERE delivery.tenant_id=admission.tenant_id AND delivery.connection_id=admission.connection_id
 AND delivery.bot_conversation_id IS NOT NULL
 AND delivery.meta_direct_recipient#>>'{asset,providerSessionId}'=admission.provider_session_id::text
 AND delivery.meta_direct_recipient#>>'{asset,phoneNumberId}'=admission.phone_number_id
 AND delivery.meta_direct_recipient#>>'{asset,wabaId}' IS NOT DISTINCT FROM admission.account_id;
CREATE TRIGGER meta_routing_delivery_immutable BEFORE UPDATE OF meta_routing_epoch,meta_routing_source_event_id ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_routing_delivery();

CREATE FUNCTION app.snapshot_meta_routing_native_intent() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE conversation_row bot_conversations%ROWTYPE;session_row provider_sessions%ROWTYPE;review_row meta_routing_reviews%ROWTYPE;
 participant_value uuid;guard_row record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.meta_routing_epoch IS DISTINCT FROM OLD.meta_routing_epoch THEN RAISE EXCEPTION 'native routing epoch is immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO conversation_row FROM bot_conversations WHERE tenant_id=NEW.tenant_id AND id=NEW.conversation_id;
 IF NOT EXISTS(SELECT 1 FROM connections WHERE tenant_id=NEW.tenant_id AND id=conversation_row.connection_id AND provider='META') THEN
  IF NEW.meta_routing_epoch IS NOT NULL THEN RAISE EXCEPTION 'routing epoch on unsupported native route' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 PERFORM 1 FROM connections WHERE tenant_id=NEW.tenant_id AND id=conversation_row.connection_id FOR UPDATE;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=NEW.tenant_id AND connection_id=conversation_row.connection_id AND ownership_state='ACTIVE';
 SELECT id INTO participant_value FROM participant_identities WHERE tenant_id=NEW.tenant_id AND connection_id=conversation_row.connection_id AND external_participant_id=conversation_row.external_chat_id;
 SELECT review.* INTO review_row FROM meta_routing_reviews review WHERE review.tenant_id=NEW.tenant_id AND review.connection_id=conversation_row.connection_id ORDER BY review.review_version DESC LIMIT 1;
 SELECT * INTO guard_row FROM app.meta_direct_routing_guard(conversation_row.connection_id,session_row.id,session_row.opaque_session_id,
  session_row.provider_state_data->>'wabaId',participant_value,COALESCE(review_row.app_id,''),review_row.runtime_binding,NEW.meta_routing_epoch);
 IF guard_row.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'native routing held' USING ERRCODE='23514';END IF;
 NEW.meta_routing_epoch:=guard_row.epoch;RETURN NEW;
END;
$$;
-- Old native intents have no original provider-session/asset snapshot. Leave
-- them unbound; historical completion is readable but no new send can repin one.
CREATE TRIGGER meta_routing_native_snapshot BEFORE INSERT OR UPDATE OF meta_routing_epoch ON direct_native_reply_intents
 FOR EACH ROW EXECUTE FUNCTION app.snapshot_meta_routing_native_intent();

-- Extend the incumbent target allowlist without removing sibling privacy types.
DO $$ DECLARE predicate text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT predicate FROM pg_constraint
  WHERE conrelid='privacy_job_targets'::regclass AND conname='privacy_job_targets_target_type_check';
 ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_target_type_check;
 EXECUTE 'ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_job_targets_target_type_check CHECK (('||predicate||') OR target_type IN (''META_ROUTING_EVENT'',''META_ROUTING_ACTION''))';
END $$;
GRANT SELECT(meta_routing_evidence,meta_routing_participant_id,meta_routing_epoch),UPDATE(meta_routing_evidence,meta_routing_participant_id,meta_routing_epoch)
 ON event_inbox TO wasalx_app,wasalx_connector_worker;
GRANT INSERT(meta_routing_evidence) ON event_inbox TO wasalx_app;
GRANT DELETE ON meta_thread_ownership TO wasalx_app,wasalx_connector_worker;

CREATE FUNCTION app.preserve_meta_thread_action() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.participant_identity_id IS NULL OR NEW.conversation_id IS NULL OR NEW.state<>'RUNNING' OR NEW.dispatched_at IS NOT NULL
   OR NEW.redacted_at IS NOT NULL OR NEW.provider_request_id IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM bot_conversations conversation JOIN participant_identities participant
     ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
     WHERE conversation.tenant_id=NEW.tenant_id AND conversation.id=NEW.conversation_id AND conversation.connection_id=NEW.connection_id AND participant.id=NEW.participant_identity_id)
   OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id
     AND alias.participant_identity_id=NEW.participant_identity_id AND alias.provider_session_id=NEW.provider_session_id
     AND alias.phone_number_id=NEW.phone_number_id AND alias.waba_id=NEW.account_id AND alias.state='ACTIVE'
     AND NEW.recipient_snapshot=jsonb_build_object('kind',alias.kind,'value',alias.value))
   THEN RAISE EXCEPTION 'invalid routing action reservation' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL AND OLD.state IN('SUCCEEDED','FAILED')
  AND NEW.recipient_snapshot=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.recipient_snapshot::text,'sha256'),'hex'))
  AND NEW.participant_identity_id IS NULL AND NEW.conversation_id IS NULL
  AND(to_jsonb(NEW)-ARRAY['recipient_snapshot','participant_identity_id','conversation_id','redacted_at'])=(to_jsonb(OLD)-ARRAY['recipient_snapshot','participant_identity_id','conversation_id','redacted_at'])
  AND app.meta_direct_privacy_target_authorized('META_ROUTING_ACTION',OLD.id::text) THEN RETURN NEW;END IF;
 IF (to_jsonb(NEW)-ARRAY['state','dispatched_at','provider_request_id','error_code','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','dispatched_at','provider_request_id','error_code','completed_at'])
  OR OLD.state IN('SUCCEEDED','FAILED') OR(OLD.state='OUTCOME_UNKNOWN' AND NEW.state NOT IN('OUTCOME_UNKNOWN','SUCCEEDED','FAILED'))
  OR(OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
  OR(NEW.state='SUCCEEDED' AND(NEW.dispatched_at IS NULL OR NEW.provider_request_id IS NULL))
  OR(NEW.state='RUNNING' AND(NEW.completed_at IS NOT NULL OR NEW.provider_request_id IS NOT NULL OR NEW.error_code IS NOT NULL))
  OR(NEW.state<>'RUNNING' AND NEW.completed_at IS NULL)
  THEN RAISE EXCEPTION 'routing action intent or receipt is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_thread_action_immutable BEFORE INSERT OR UPDATE ON meta_thread_control_actions FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_thread_action();

CREATE FUNCTION app.guard_meta_thread_ownership() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;action meta_thread_control_actions%ROWTYPE;review meta_routing_reviews%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF app.meta_direct_privacy_target_authorized('META_ROUTING_EVENT',OLD.source_event_id::text)
   OR app.meta_direct_privacy_target_authorized('META_ROUTING_ACTION',OLD.source_action_id::text)
   OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.participant_identity_id=OLD.participant_identity_id
      AND app.meta_direct_privacy_target_authorized('META_DIRECT_ALIAS',alias.id::text)) THEN RETURN OLD;END IF;
  RAISE EXCEPTION 'routing ownership requires privacy authority to remove' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND((NEW.tenant_id,NEW.connection_id,NEW.provider_session_id,NEW.participant_identity_id,NEW.phone_number_id,NEW.account_id)
   IS DISTINCT FROM(OLD.tenant_id,OLD.connection_id,OLD.provider_session_id,OLD.participant_identity_id,OLD.phone_number_id,OLD.account_id)
   OR NEW.epoch<OLD.epoch OR NEW.observed_at<OLD.observed_at OR(NEW.state<>OLD.state AND NEW.epoch<=OLD.epoch)
   OR(NEW.epoch=OLD.epoch AND NEW.epoch_started_at IS DISTINCT FROM OLD.epoch_started_at)
   OR(NEW.observed_at=OLD.observed_at AND NEW.state<>'UNKNOWN' AND(OLD.state='UNKNOWN' OR NEW.state<>OLD.state)))
  THEN RAISE EXCEPTION 'routing ownership generation cannot be rewritten' USING ERRCODE='23514';END IF;
 IF NEW.epoch_started_at>NEW.observed_at OR((TG_OP='INSERT' OR NEW.epoch>OLD.epoch) AND NEW.epoch_started_at<>NEW.observed_at)
  THEN RAISE EXCEPTION 'routing ownership generation source changed' USING ERRCODE='23514';END IF;
 IF(NEW.source_event_id IS NULL)=(NEW.source_action_id IS NULL) THEN RAISE EXCEPTION 'routing ownership requires one source' USING ERRCODE='23514';END IF;
 IF NEW.source_event_id IS NOT NULL THEN
  SELECT * INTO source FROM event_inbox WHERE tenant_id=NEW.tenant_id AND connection_id=NEW.connection_id AND id=NEW.source_event_id;
  IF NOT FOUND OR source.meta_routing_evidence->>'providerSessionId' IS DISTINCT FROM NEW.provider_session_id::text
   OR source.meta_routing_evidence->>'phoneNumberId' IS DISTINCT FROM NEW.phone_number_id OR source.meta_routing_evidence->>'accountId' IS DISTINCT FROM NEW.account_id
   OR source.meta_routing_evidence->>'payloadSha256' IS DISTINCT FROM NEW.source_hash OR source.payload_sha256<>NEW.source_hash
   OR source.meta_routing_evidence->'redacted'='true'::jsonb OR (source.meta_routing_evidence->>'observedAt')::timestamptz IS DISTINCT FROM NEW.observed_at
   OR source.status IN('REDACTED','QUARANTINED','IGNORED','UNMATCHED') OR source.meta_routing_epoch IS NOT NULL
   OR(source.meta_routing_evidence->>'category' IN('PRIMARY_MESSAGE','CONTROL_PASSED') AND(source.status<>'PROCESSING' OR source.lease_id IS NULL OR source.lease_expires_at<=clock_timestamp()))
   OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id
    AND alias.participant_identity_id=NEW.participant_identity_id AND alias.provider_session_id=NEW.provider_session_id AND alias.phone_number_id=NEW.phone_number_id AND alias.waba_id=NEW.account_id
    AND alias.kind=source.meta_routing_evidence#>>'{peer,kind}' AND alias.value=source.meta_routing_evidence#>>'{peer,value}' AND alias.state='ACTIVE')
   OR(NEW.state='OWN' AND source.meta_routing_evidence->>'category' NOT IN('PRIMARY_MESSAGE','CONTROL_PASSED'))
   OR(NEW.state='STANDBY' AND source.meta_routing_evidence->>'category' NOT IN('STANDBY_MESSAGE','CONTROL_TAKEN'))
   THEN RAISE EXCEPTION 'routing ownership source changed' USING ERRCODE='23514';END IF;
  IF NEW.last_customer_message_at IS DISTINCT FROM (CASE WHEN source.meta_routing_evidence->>'category' IN('PRIMARY_MESSAGE','STANDBY_MESSAGE')
    THEN NEW.observed_at WHEN TG_OP='UPDATE' THEN OLD.last_customer_message_at ELSE NULL END)
   THEN RAISE EXCEPTION 'routing customer window requires a customer message' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO action FROM meta_thread_control_actions WHERE tenant_id=NEW.tenant_id AND id=NEW.source_action_id;
  IF NOT FOUND OR action.state<>'SUCCEEDED' OR action.redacted_at IS NOT NULL
   OR(action.connection_id,action.provider_session_id,action.participant_identity_id,action.phone_number_id,action.account_id,action.request_sha256)
    IS DISTINCT FROM(NEW.connection_id,NEW.provider_session_id,NEW.participant_identity_id,NEW.phone_number_id,NEW.account_id,NEW.source_hash)
   OR(NEW.state<>'UNKNOWN' AND NEW.state<>CASE action.action WHEN 'take' THEN 'OWN' WHEN 'pass' THEN 'STANDBY' ELSE 'IDLE' END)
   OR NEW.observed_at IS DISTINCT FROM action.completed_at
   OR NEW.last_customer_message_at IS DISTINCT FROM (CASE WHEN TG_OP='UPDATE' THEN OLD.last_customer_message_at ELSE NULL END)
   THEN RAISE EXCEPTION 'routing ownership receipt changed' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.state='OWN' THEN
  SELECT item.* INTO review FROM meta_routing_reviews item WHERE item.tenant_id=NEW.tenant_id AND item.connection_id=NEW.connection_id ORDER BY item.review_version DESC LIMIT 1;
  IF NOT FOUND OR review.disposition<>'REVIEWED' OR(review.provider_session_id,review.phone_number_id,review.account_id,review.configuration_version,review.review_version)
   IS DISTINCT FROM(NEW.provider_session_id,NEW.phone_number_id,NEW.account_id,NEW.configuration_version,NEW.review_version)
   OR NEW.observed_at<review.observed_at THEN RAISE EXCEPTION 'routing ownership has no current observation' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_thread_ownership_authority BEFORE INSERT OR UPDATE OR DELETE ON meta_thread_ownership FOR EACH ROW EXECUTE FUNCTION app.guard_meta_thread_ownership();

-- Purging a routing marker would erase an unresolved hold or break source FKs.
CREATE OR REPLACE FUNCTION app.purge_expired_unmatched_events(retain_for interval,cutoff_at timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE affected bigint;
BEGIN
 IF retain_for<interval '1 hour' OR retain_for>interval '24 hours' OR cutoff_at IS NULL THEN RAISE EXCEPTION 'invalid unmatched diagnostic retention cutoff' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM privacy_legal_holds WHERE tenant_id=app.current_tenant_id() AND state='ACTIVE'
  AND(expires_at IS NULL OR expires_at>clock_timestamp()) AND scope_type='TENANT') THEN RETURN 0;END IF;
 DELETE FROM event_inbox inbox WHERE inbox.tenant_id=app.current_tenant_id() AND inbox.meta_direct_identity_change IS NULL AND inbox.meta_routing_evidence IS NULL
  AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=inbox.tenant_id AND alias.source_event_id=inbox.id)
  AND inbox.status IN('UNMATCHED','IGNORED','DUPLICATE','REDACTED') AND COALESCE(inbox.processed_at,inbox.received_at)<=cutoff_at-retain_for
  AND NOT EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=inbox.tenant_id AND message.event_inbox_id=inbox.id);
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected;
END $$;
REVOKE ALL ON FUNCTION app.preserve_meta_thread_action(),app.guard_meta_thread_ownership() FROM PUBLIC;

COMMIT;
