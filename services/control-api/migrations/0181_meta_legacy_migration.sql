-- P05b2 private typed legacy successor. Root reserved ordinal 0181.
BEGIN;

-- Fragment: META_LEGACY_MIGRATION.sql
-- Private, unapplied WIP. Root assigns an ordinal only with the full consumer
-- and destination-authorization composition. No live legacy capability exists.

ALTER TABLE public.meta_account_transitions DROP CONSTRAINT meta_account_transitions_transition_kind_check;
ALTER TABLE public.meta_account_transitions ADD CONSTRAINT meta_account_transitions_transition_kind_check
 CHECK(transition_kind IN('CURRENCY','TEMPLATE_PREPARATION','LEGACY_PHONE'));
ALTER TABLE public.meta_account_transitions
 ADD COLUMN legacy_template_operation_id uuid,
 ADD COLUMN legacy_target_binding_id uuid,
 ADD COLUMN legacy_authorization_operation_id uuid,
 ADD COLUMN legacy_readback_operation_id uuid,
 ADD COLUMN legacy_review_operation_id uuid,
 ADD COLUMN legacy_operation_id uuid,
 ADD COLUMN legacy_runtime_receipt_id uuid REFERENCES public.platform_operations_audit_events(id),
 ADD COLUMN legacy_target_scope_sha256 text CHECK(legacy_target_scope_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN legacy_state text CHECK(legacy_state IN('REVIEW','PREREQUISITE_REQUIRED','AUTHORIZATION_REQUIRED','READY',
  'REGISTERING','OUTCOME_UNKNOWN','READBACK_REQUIRED','RECONCILED_PAUSED','HELD')),
 ADD FOREIGN KEY(tenant_id,legacy_template_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,legacy_target_binding_id) REFERENCES public.meta_connection_account_bindings(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,legacy_authorization_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,legacy_readback_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,legacy_review_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 ADD FOREIGN KEY(tenant_id,legacy_operation_id) REFERENCES public.connection_operations(tenant_id,id);
ALTER TABLE public.meta_account_transitions DROP CONSTRAINT meta_transition_kind_shape;
ALTER TABLE public.meta_account_transitions ADD CONSTRAINT meta_transition_kind_shape CHECK(
 (transition_kind='CURRENCY' AND target_currency IS NOT NULL AND template_target_connection_id IS NULL
  AND template_target_binding_id IS NULL AND template_operation_id IS NULL AND template_observation IS NULL
  AND template_state IS NULL AND legacy_state IS NULL AND legacy_template_operation_id IS NULL AND legacy_target_binding_id IS NULL)
 OR (transition_kind='TEMPLATE_PREPARATION' AND target_currency IS NULL AND template_target_connection_id IS NOT NULL
  AND template_target_binding_id IS NOT NULL AND template_operation_id IS NOT NULL AND template_state IS NOT NULL
  AND legacy_state IS NULL AND legacy_template_operation_id IS NULL AND legacy_target_binding_id IS NULL)
 OR (transition_kind='LEGACY_PHONE' AND target_currency IS NULL AND template_target_connection_id IS NULL
  AND template_target_binding_id IS NULL AND template_operation_id IS NULL AND template_observation IS NULL
  AND template_state IS NULL AND legacy_state IS NOT NULL AND legacy_template_operation_id IS NOT NULL AND legacy_target_binding_id IS NOT NULL));
ALTER TABLE public.meta_provider_effect_checkpoints DROP CONSTRAINT meta_provider_effect_checkpoints_stage_check;
ALTER TABLE public.meta_provider_effect_checkpoints ADD CONSTRAINT meta_provider_effect_checkpoints_stage_check
 CHECK(stage IN('ATTACH','INITIATE','COMPLETE','REVOKE','TEMPLATE_COPY','LEGACY_REGISTER'));
ALTER TABLE public.meta_provider_effect_checkpoints DROP CONSTRAINT meta_transition_arrangement_scope;
ALTER TABLE public.meta_provider_effect_checkpoints ADD CONSTRAINT meta_transition_arrangement_scope CHECK(
 arrangement_version_id IS NOT NULL OR (owner_kind='ACCOUNT_TRANSITION' AND stage IN('INITIATE','COMPLETE','TEMPLATE_COPY','LEGACY_REGISTER')));

CREATE OR REPLACE FUNCTION app.meta_template_stage_kind() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE kind_value text;
BEGIN
 IF NEW.owner_kind='ACCOUNT_TRANSITION' THEN
  SELECT transition_kind INTO kind_value FROM public.meta_account_transitions WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id;
  IF kind_value IS NULL OR NOT(
   (kind_value='TEMPLATE_PREPARATION' AND NEW.stage='TEMPLATE_COPY')
   OR (kind_value='LEGACY_PHONE' AND NEW.stage='LEGACY_REGISTER')
   OR (kind_value='CURRENCY' AND NEW.stage IN('INITIATE','COMPLETE'))) THEN
   RAISE EXCEPTION 'Provider stage belongs to another transition purpose' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;

CREATE FUNCTION app.preserve_meta_legacy_migration() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF NEW.transition_kind<>'LEGACY_PHONE' THEN
  IF NEW.legacy_state IS NOT NULL OR NEW.legacy_template_operation_id IS NOT NULL OR NEW.legacy_target_binding_id IS NOT NULL
   OR NEW.legacy_authorization_operation_id IS NOT NULL OR NEW.legacy_readback_operation_id IS NOT NULL
   OR NEW.legacy_review_operation_id IS NOT NULL OR NEW.legacy_operation_id IS NOT NULL OR NEW.legacy_runtime_receipt_id IS NOT NULL
   OR NEW.legacy_target_scope_sha256 IS NOT NULL THEN
   RAISE EXCEPTION 'Legacy data belongs only to a legacy intent' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.legacy_target_scope_sha256 IS NOT NULL AND NEW.legacy_target_scope_sha256 IS DISTINCT FROM OLD.legacy_target_scope_sha256 THEN
   RAISE EXCEPTION 'Original destination scope is immutable' USING ERRCODE='23514';END IF;
  IF (NEW.legacy_template_operation_id,NEW.legacy_target_binding_id,NEW.legacy_review_operation_id,NEW.legacy_runtime_receipt_id)
   IS DISTINCT FROM (OLD.legacy_template_operation_id,OLD.legacy_target_binding_id,OLD.legacy_review_operation_id,OLD.legacy_runtime_receipt_id) THEN
   RAISE EXCEPTION 'Original legacy preparation is immutable' USING ERRCODE='23514';END IF;
  IF NEW.requested_by IS NULL AND OLD.requested_by IS NOT NULL AND (to_jsonb(NEW)-'requested_by')=(to_jsonb(OLD)-'requested_by') THEN
     IF pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
       IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW; END IF;
     ELSE
       IF NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=OLD.tenant_id AND user_id=OLD.requested_by) THEN RETURN NEW; END IF;
       IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW; END IF;
     END IF;
   END IF;
 END IF;
 IF current_user<>'wasalx_meta_transition_executor' THEN
  RAISE EXCEPTION 'Legacy migration requires its sealed coordinator' USING ERRCODE='42501';END IF;
 IF NEW.provider_migration_id IS NOT NULL OR NEW.provider_status IS NOT NULL OR NEW.observer_operations<>'{}'::jsonb THEN
  RAISE EXCEPTION 'Registration is not a currency migration receipt' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_legacy_intent_guard BEFORE INSERT OR UPDATE ON public.meta_account_transitions
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_legacy_migration();
REVOKE ALL ON FUNCTION app.preserve_meta_legacy_migration() FROM PUBLIC;

-- This constant is intentional. Current docs do not establish an exact live
-- applicability or changed-phone mapping producer. Neither tenant settings,
-- operator forms nor successful registration may turn it on.
CREATE FUNCTION app.meta_live_legacy_migration_available() RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION app.meta_live_legacy_migration_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_live_legacy_migration_available() TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

-- The context function in the companion pins source/target authorization,
-- original post-quiesce scope, template receipt, actor, reservations and lease.
-- It supplies a SIMULATED-only grant derived from approved runtime provenance;
-- no request JSON boolean supplies that grant. This function is never exported.
CREATE FUNCTION app.reserve_meta_legacy_registration(operation_value uuid,lease_value uuid,fence_value bigint,
 request_sha text,context_sha text,execution_value jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;c public.meta_provider_effect_checkpoints;
 ctx jsonb;target public.meta_messaging_accounts;policy public.meta_billing_policy_versions;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaLegacyMigration,id}')::uuid
  AND initiating_connection_id=o.connection_id AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL OR o.payload#>>'{metaLegacyMigration,stage}' IS DISTINCT FROM 'REGISTER'
  OR COALESCE(request_sha,'') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Original registration is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,p.target_account_id]);
 SELECT * INTO c FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='LEGACY_REGISTER';
 IF FOUND THEN RETURN jsonb_build_object('disposition','HISTORICAL_NO_POST','checkpoint',jsonb_build_object('id',c.id,'outcome',c.outcome));END IF;
 ctx:=app.meta_legacy_migration_context(o.id,lease_value,fence_value,o.payload#>>'{metaLegacyMigration,appId}','BEFORE_REGISTER');
 SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
 SELECT * INTO policy FROM public.meta_billing_policy_versions WHERE tenant_id=p.tenant_id AND id=target.active_policy_version_id;
 IF ctx->>'contextSha256' IS DISTINCT FROM context_sha OR ctx->>'stage' IS DISTINCT FROM 'REGISTER'
  OR ctx#>>'{registerAdmission,evidenceMode}' IS DISTINCT FROM 'SIMULATED'
  OR execution_value->>'mode' IS DISTINCT FROM 'SIMULATED'
  OR ctx#>>'{registerAdmission,runtimeEvidenceReceiptId}' IS DISTINCT FROM execution_value->>'runtimeEvidenceReceiptId'
  OR target.id IS NULL OR policy.id IS NULL
  OR policy.account_id<>target.id OR target.state<>'READY'
  OR target.requested_policy_version_id IS DISTINCT FROM target.active_policy_version_id
  OR NOT app.meta_runtime_message_admission_current(jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND',
    'tenantId',p.tenant_id,'accountId',target.id,'payment',jsonb_build_object('mode',policy.mode)),execution_value)
  OR ctx#>>'{registerAdmission,scopeCurrent}' IS DISTINCT FROM 'true'
  OR ctx#>>'{registerAdmission,drainClear}' IS DISTINCT FROM 'true'
  OR ctx#>>'{registerAdmission,sourceServiceQuiesced}' IS DISTINCT FROM 'true'
  OR ctx#>>'{registerAdmission,destinationFunding}' IS DISTINCT FROM 'VERIFIED'
  OR (ctx#>>'{registerAdmission,expiresAt}')::timestamptz<=clock_timestamp() THEN
  RAISE EXCEPTION 'Legacy registration prerequisites are unavailable' USING ERRCODE='55000';END IF;
 INSERT INTO public.meta_provider_effect_checkpoints(tenant_id,account_id,owner_kind,owner_id,stage,original_operation_id,
  original_fencing_token,authority_revision,policy_version_id,arrangement_version_id,runtime_execution,request_sha256)
 VALUES(p.tenant_id,target.id,'ACCOUNT_TRANSITION',p.id,'LEGACY_REGISTER',o.id,o.fencing_token,target.authority_revision,
  policy.id,policy.arrangement_version_id,execution_value,request_sha) RETURNING * INTO c;
 RETURN jsonb_build_object('disposition','NEW_ATTEMPT','id',c.id,'reservationToken',c.reservation_token);
END $$;
ALTER FUNCTION app.reserve_meta_legacy_registration(uuid,uuid,bigint,text,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.reserve_meta_legacy_registration(uuid,uuid,bigint,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_meta_legacy_registration(uuid,uuid,bigint,text,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.record_meta_legacy_registration(checkpoint_value uuid,reservation_value uuid,outcome_value text,result_value jsonb)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE c public.meta_provider_effect_checkpoints;result_sha text;
BEGIN
 SELECT * INTO c FROM public.meta_provider_effect_checkpoints WHERE tenant_id=app.current_tenant_id() AND id=checkpoint_value FOR UPDATE;
 IF c.id IS NULL OR c.owner_kind<>'ACCOUNT_TRANSITION' OR c.stage<>'LEGACY_REGISTER'
  OR c.reservation_token IS DISTINCT FROM reservation_value OR NOT EXISTS(SELECT 1 FROM public.meta_account_transitions p
    WHERE p.tenant_id=c.tenant_id AND p.id=c.owner_id AND p.transition_kind='LEGACY_PHONE')
  OR COALESCE(outcome_value,'') NOT IN('SUCCEEDED','REJECTED','UNKNOWN')
  OR jsonb_typeof(result_value) IS DISTINCT FROM 'object' OR octet_length(result_value::text)>1024 THEN
  RAISE EXCEPTION 'Original registration response is unavailable' USING ERRCODE='55000';END IF;
 IF (outcome_value='SUCCEEDED' AND result_value IS DISTINCT FROM '{"registered":true}'::jsonb)
  OR (outcome_value='REJECTED' AND result_value IS DISTINCT FROM '{"reason":"KNOWN_PROVIDER_REJECTION"}'::jsonb)
  OR (outcome_value='UNKNOWN' AND result_value IS DISTINCT FROM '{"reason":"PROVIDER_OUTCOME_UNRESOLVED"}'::jsonb) THEN
  RAISE EXCEPTION 'Registration response has an unsupported shape' USING ERRCODE='23514';END IF;
 result_sha:=encode(public.digest(result_value::text,'sha256'),'hex');
 IF c.outcome<>'ATTEMPTED' THEN RETURN c.outcome=outcome_value AND c.result_sha256=result_sha;END IF;
 UPDATE public.meta_provider_effect_checkpoints SET outcome=outcome_value,result=result_value,result_sha256=result_sha,settled_at=clock_timestamp()
  WHERE tenant_id=c.tenant_id AND id=c.id;
 -- Recording an original response never promotes plan/binding readiness. A
 -- separate current read/reconcile owns that CAS, even after lease replacement.
 RETURN true;
END $$;
ALTER FUNCTION app.record_meta_legacy_registration(uuid,uuid,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.record_meta_legacy_registration(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_legacy_registration(uuid,uuid,text,jsonb) TO wasalx_connector_worker;


-- Fragment: META_LEGACY_SYNTHETIC_CAPABILITY.sql
-- Private B2. Extend only the existing simulated runtime receipt, not live eligibility.

CREATE FUNCTION app.meta_legacy_runtime_binding_current(tenant_value uuid,binding_value uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.meta_connection_account_bindings b
 JOIN public.meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
 JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
 JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id AND s.connection_id=c.id
 WHERE b.tenant_id=tenant_value AND b.id=binding_value AND b.state='ACTIVE' AND a.state<>'RETIRED'
  AND c.provider='META' AND c.state IN('WORKING','PAUSED') AND c.secret_reference=b.secret_reference
  AND s.ownership_state='ACTIVE' AND s.state IN('WORKING','PAUSED') AND s.opaque_session_id=b.phone_number_id
  AND s.provider_state_data->>'wabaId'=a.provider_account_id
  AND s.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1'
  AND s.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
  AND s.provider_state_data#>>'{metaAccountProof,tenantId}'=b.tenant_id::text
  AND s.provider_state_data#>>'{metaAccountProof,connectionId}'=b.connection_id::text
  AND s.provider_state_data#>>'{metaAccountProof,providerSessionId}'=b.provider_session_id::text
  AND s.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=b.phone_number_id
  AND s.provider_state_data#>>'{metaAccountProof,wabaId}'=a.provider_account_id
  AND s.provider_state_data#>>'{metaAccountProof,secretReference}'=b.secret_reference
  AND s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=b.credential_fingerprint
  AND encode(public.digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex')=b.proof_sha256
  AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=b.app_id
  AND COALESCE(s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}','') ~ '^[0-9]+$'
  AND COALESCE(s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}','') ~ '^[0-9]+$'
  AND (CASE WHEN COALESCE(s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}','') ~ '^[0-9]+$'
   THEN (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0
    OR (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END)
  AND (CASE WHEN COALESCE(s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}','') ~ '^[0-9]+$'
   THEN (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0
    OR (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END));
$$;
REVOKE ALL ON FUNCTION app.meta_legacy_runtime_binding_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_runtime_binding_current(uuid,uuid) TO wasalx_meta_transition_executor;
CREATE OR REPLACE FUNCTION app.operator_register_meta_simulated_runtime(candidate jsonb,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE receipt uuid:=gen_random_uuid();descriptor json;descriptor_sha text;tenant_value uuid;account_value uuid;expires_value timestamptz;
 source_value uuid;source_count integer;legacy_value jsonb;
BEGIN
 IF candidate IS NULL OR jsonb_typeof(candidate)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(candidate))<>(CASE WHEN candidate ? 'legacyMigration' THEN 12 ELSE 11 END)
  OR NOT(candidate ?& ARRAY['schemaVersion','mode','tenantId','accountId','workerImageDigest','sourceTree','graphVersion','releaseEvidenceSha256','sourceEvidenceSha256','transportBindingSha256','expiresAt'])
  OR candidate->>'schemaVersion' IS DISTINCT FROM '1' OR candidate->>'mode' IS DISTINCT FROM 'SIMULATED'
  OR COALESCE(candidate->>'workerImageDigest','') !~ '^sha256:[a-f0-9]{64}$'
  OR COALESCE(candidate->>'sourceTree','') !~ '^[a-f0-9]{40,64}$' OR COALESCE(candidate->>'graphVersion','') !~ '^v[0-9]+\.[0-9]+$'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['releaseEvidenceSha256','sourceEvidenceSha256','transportBindingSha256']) key WHERE COALESCE(candidate->>key,'') !~ '^[a-f0-9]{64}$')
  OR operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value ~ '[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Meta runtime evidence is invalid' USING ERRCODE='23514'; END IF;
 tenant_value:=(candidate->>'tenantId')::uuid;account_value:=(candidate->>'accountId')::uuid;expires_value:=(candidate->>'expiresAt')::timestamptz;
 IF candidate ? 'legacyMigration' THEN
  IF jsonb_typeof(candidate->'legacyMigration') IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(candidate->'legacyMigration'))<>10
   OR NOT(candidate->'legacyMigration' ?& ARRAY['schemaVersion','claim','tenantId','targetAccountId',
    'sourceProviderAccountId','targetProviderAccountId','phoneId','appId','graphVersion','fixtureSha256'])
   OR candidate#>>'{legacyMigration,schemaVersion}' IS DISTINCT FROM '1'
   OR candidate#>>'{legacyMigration,claim}' IS DISTINCT FROM 'SYNTHETIC_LEGACY_SAME_PHONE'
   OR candidate#>>'{legacyMigration,tenantId}' IS DISTINCT FROM tenant_value::text
   OR candidate#>>'{legacyMigration,targetAccountId}' IS DISTINCT FROM account_value::text
   OR candidate#>>'{legacyMigration,graphVersion}' IS DISTINCT FROM 'v24.0'
   OR candidate->>'graphVersion' IS DISTINCT FROM 'v24.0'
   OR COALESCE(candidate#>>'{legacyMigration,fixtureSha256}','') !~ '^[a-f0-9]{64}$'
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['sourceProviderAccountId','targetProviderAccountId','phoneId','appId']) field
    WHERE jsonb_typeof(candidate->'legacyMigration'->field) IS DISTINCT FROM 'string'
     OR COALESCE(candidate->'legacyMigration'->>field,'') !~ '^[1-9][0-9]{0,31}$')
   OR candidate#>>'{legacyMigration,sourceProviderAccountId}'=candidate#>>'{legacyMigration,targetProviderAccountId}'
   OR NOT EXISTS(SELECT 1 FROM public.meta_messaging_accounts source JOIN public.meta_messaging_accounts target
    ON target.tenant_id=source.tenant_id WHERE source.tenant_id=tenant_value
     AND source.id<>target.id AND target.id=account_value
     AND source.provider_account_id=candidate#>>'{legacyMigration,sourceProviderAccountId}'
     AND target.provider_account_id=candidate#>>'{legacyMigration,targetProviderAccountId}'
     AND source.state<>'RETIRED' AND target.state<>'RETIRED'
     AND EXISTS(SELECT 1 FROM public.meta_connection_account_bindings binding WHERE binding.tenant_id=tenant_value
      AND binding.account_id=source.id AND binding.state='ACTIVE' AND binding.phone_number_id=candidate#>>'{legacyMigration,phoneId}'
      AND binding.app_id=candidate#>>'{legacyMigration,appId}' AND app.meta_legacy_runtime_binding_current(tenant_value,binding.id))
     AND EXISTS(SELECT 1 FROM public.meta_connection_account_bindings binding WHERE binding.tenant_id=tenant_value
      AND binding.account_id=target.id AND binding.app_id=candidate#>>'{legacyMigration,appId}'
      AND app.meta_legacy_runtime_binding_current(tenant_value,binding.id))) THEN
   RAISE EXCEPTION 'Exact synthetic migration fixture is unavailable' USING ERRCODE='23514';END IF;
  SELECT count(*),min(source.id::text)::uuid INTO source_count,source_value
  FROM public.meta_messaging_accounts source
  JOIN public.meta_connection_account_bindings binding ON binding.tenant_id=source.tenant_id AND binding.account_id=source.id
  WHERE source.tenant_id=tenant_value AND source.id<>account_value AND source.state<>'RETIRED'
   AND source.provider_account_id=candidate#>>'{legacyMigration,sourceProviderAccountId}'
   AND binding.state='ACTIVE' AND binding.phone_number_id=candidate#>>'{legacyMigration,phoneId}'
   AND binding.app_id=candidate#>>'{legacyMigration,appId}' AND app.meta_legacy_runtime_binding_current(tenant_value,binding.id);
  IF source_count<>1 THEN RAISE EXCEPTION 'Synthetic source scope is ambiguous' USING ERRCODE='55000';END IF;
  legacy_value:=(candidate->'legacyMigration')||jsonb_build_object('sourceAccountId',source_value);
 END IF;
 IF expires_value IS NULL OR expires_value<=clock_timestamp() OR expires_value>clock_timestamp()+interval '24 hours'
  OR NOT EXISTS(SELECT 1 FROM meta_messaging_accounts a JOIN tenants t ON t.id=a.tenant_id
   WHERE a.tenant_id=tenant_value AND a.id=account_value AND a.state<>'RETIRED' AND t.state='ACTIVE') THEN
  RAISE EXCEPTION 'Meta runtime scope is unavailable' USING ERRCODE='55000'; END IF;
 -- JSON (not jsonb) construction preserves this literal descriptor byte order.
 descriptor:=json_build_object('schemaVersion',1,'receiptId',receipt::text,'workerImageDigest',candidate->>'workerImageDigest',
  'sourceTree',candidate->>'sourceTree','graphVersion',candidate->>'graphVersion','releaseEvidenceSha256',candidate->>'releaseEvidenceSha256',
  'transportBindingSha256',candidate->>'transportBindingSha256');
 -- json_build_object formatting is not a JS serializer. The server returns its
 -- exact produced descriptor bytes; the producer writes them without reserializing.
 descriptor_sha:=encode(digest(descriptor::text||E'\n','sha256'),'hex');
 INSERT INTO platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(receipt,operator_value,'meta.runtime.simulated.registered','meta.messaging_account',account_value::text,
  jsonb_build_object('schemaVersion',1,'mode','SIMULATED','tenantId',tenant_value::text,'accountId',account_value::text,
   'descriptor',descriptor::jsonb,'descriptorSha256',descriptor_sha,'sourceEvidenceSha256',candidate->>'sourceEvidenceSha256','expiresAt',expires_value)
   ||CASE WHEN legacy_value IS NOT NULL THEN jsonb_build_object('legacyMigration',legacy_value) ELSE '{}'::jsonb END,request_value);
 RETURN jsonb_build_object('receiptId',receipt,'descriptorSha256',descriptor_sha,'descriptorText',descriptor::text||E'\n');
END; $$;

-- The same immutable platform runtime audit is the only capability source.
-- A tenant cannot register it, choose an unrelated receipt, or upgrade mode.
CREATE FUNCTION app.meta_legacy_fixture_capability(source_binding_value uuid,target_binding_value uuid,receipt_value uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE source public.meta_connection_account_bindings;target public.meta_connection_account_bindings;
 receipt public.platform_operations_audit_events;source_account public.meta_messaging_accounts;target_account public.meta_messaging_accounts;
BEGIN
 SELECT * INTO source FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND id=source_binding_value AND state='ACTIVE';
 SELECT * INTO target FROM public.meta_connection_account_bindings WHERE tenant_id=source.tenant_id AND id=target_binding_value AND state='ACTIVE';
 SELECT * INTO source_account FROM public.meta_messaging_accounts WHERE tenant_id=source.tenant_id AND id=source.account_id;
 SELECT * INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=source.tenant_id AND id=target.account_id;
 IF source.id IS NULL OR target.id IS NULL OR source.account_id=target.account_id OR source.app_id<>target.app_id
  OR NOT app.meta_legacy_runtime_binding_current(source.tenant_id,source.id)
  OR NOT app.meta_legacy_runtime_binding_current(target.tenant_id,target.id)
  OR source_account.state='RETIRED' OR target_account.state='RETIRED'
  OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=source.tenant_id AND state='ACTIVE') THEN RETURN NULL;END IF;
 SELECT * INTO receipt FROM public.platform_operations_audit_events r
 WHERE r.action='meta.runtime.simulated.registered' AND (receipt_value IS NULL OR r.id=receipt_value)
  AND r.safe_metadata->>'mode'='SIMULATED' AND r.safe_metadata->>'tenantId'=source.tenant_id::text
  AND r.safe_metadata->>'accountId'=target.account_id::text AND (r.safe_metadata->>'expiresAt')::timestamptz>clock_timestamp()
  AND r.safe_metadata#>>'{legacyMigration,claim}'='SYNTHETIC_LEGACY_SAME_PHONE'
  AND r.safe_metadata#>>'{legacyMigration,sourceAccountId}'=source.account_id::text
  AND r.safe_metadata#>>'{legacyMigration,targetAccountId}'=target.account_id::text
  AND r.safe_metadata#>>'{legacyMigration,sourceProviderAccountId}'=source_account.provider_account_id
  AND r.safe_metadata#>>'{legacyMigration,targetProviderAccountId}'=target_account.provider_account_id
  AND r.safe_metadata#>>'{legacyMigration,phoneId}'=source.phone_number_id
  AND r.safe_metadata#>>'{legacyMigration,appId}'=source.app_id
  AND r.safe_metadata#>>'{legacyMigration,graphVersion}'='v24.0'
  AND NOT EXISTS(SELECT 1 FROM public.platform_operations_audit_events withdrawn
   WHERE withdrawn.action='meta.runtime.withdrawn' AND withdrawn.target_id=r.id::text)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
 IF receipt.id IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('claim','SYNTHETIC_LEGACY_SAME_PHONE','runtimeEvidenceReceiptId',receipt.id,
  'runtimeEvidenceSha256',receipt.safe_metadata->>'descriptorSha256',
  'transportBindingSha256',receipt.safe_metadata#>>'{descriptor,transportBindingSha256}',
  'fixtureSha256',receipt.safe_metadata#>>'{legacyMigration,fixtureSha256}',
  'sourceAccountId',source.account_id,'targetAccountId',target.account_id,'phoneId',source.phone_number_id,
  'appId',source.app_id,'expiresAt',receipt.safe_metadata->>'expiresAt');
END $$;
REVOKE ALL ON FUNCTION app.meta_legacy_fixture_capability(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_fixture_capability(uuid,uuid,uuid) TO wasalx_meta_transition_executor;


-- Fragment: META_LEGACY_MIGRATION_CONTEXT.sql
-- Private WIP. Original-effect recovery is separate from new effect authority.
-- The live eligibility producer remains unavailable; no caller field supplies it.

CREATE FUNCTION app.meta_legacy_destination_ready(plan_value uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT COALESCE((SELECT account.state='READY' AND account.funding_status='PRESENT'
  AND account.primary_funding_id IS NOT NULL AND account.funding_expires_at>clock_timestamp()
  AND account.active_policy_version_id=account.requested_policy_version_id
  AND policy.account_id=account.id AND policy.mode=CASE WHEN plan.requested_mode='WASALX_MANAGED' THEN 'MANAGED' ELSE 'CUSTOMER' END
  AND app.meta_account_payment_ready(account.id,account.primary_funding_id)
 FROM public.meta_account_transitions plan JOIN public.meta_connection_account_bindings binding
  ON binding.tenant_id=plan.tenant_id AND binding.id=plan.legacy_target_binding_id AND binding.state='ACTIVE'
 JOIN public.meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
 JOIN public.meta_billing_policy_versions policy ON policy.tenant_id=account.tenant_id AND policy.id=account.active_policy_version_id
 WHERE plan.tenant_id=app.current_tenant_id() AND plan.id=plan_value AND plan.transition_kind='LEGACY_PHONE'),false)
$$;
ALTER FUNCTION app.meta_legacy_destination_ready(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_destination_ready(uuid) FROM PUBLIC;
CREATE FUNCTION app.meta_legacy_authorized_credential(plan_value uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;a public.meta_signup_attempts;proof jsonb;
 source_binding public.meta_connection_account_bindings;target_binding public.meta_connection_account_bindings;
 target_account public.meta_messaging_accounts;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL OR p.legacy_authorization_operation_id IS NULL THEN RETURN NULL;END IF;
 PERFORM app.meta_transition_actor_current(p.requested_by);
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.legacy_authorization_operation_id;
 SELECT * INTO a FROM public.meta_signup_attempts WHERE tenant_id=p.tenant_id AND operation_id=o.id AND target_transition_id=p.id;
 SELECT * INTO source_binding FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.initiating_binding_id;
 SELECT * INTO target_binding FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
 SELECT * INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=target_binding.account_id;
 proof:=o.result->'metaLegacyAuthorizationProof';
 IF o.state<>'SUCCEEDED' OR o.operation_type<>'ROTATE_META_CREDENTIAL' OR o.connection_id<>p.initiating_connection_id
  OR a.id IS NULL OR a.purpose<>'LEGACY_MIGRATION' OR a.status<>'COMPLETED' OR a.connection_credential_write_claimed_at IS NULL
  OR a.connection_id<>p.initiating_connection_id OR a.target_connection_id<>p.initiating_connection_id
  OR a.requested_by IS NULL OR o.requested_by_id IS DISTINCT FROM a.requested_by::text
  OR proof->>'schemaVersion' IS DISTINCT FROM '1' OR proof->>'claim' IS DISTINCT FROM 'LEGACY_TARGET_ACCESS_VERIFIED'
  OR proof->>'transitionId' IS DISTINCT FROM p.id::text OR proof->>'attemptId' IS DISTINCT FROM a.id::text
  OR proof->>'sourceBindingId' IS DISTINCT FROM source_binding.id::text
  OR proof->>'sourcePhoneId' IS DISTINCT FROM source_binding.phone_number_id
  OR proof->>'targetAccountId' IS DISTINCT FROM target_account.provider_account_id
  OR proof->>'appId' IS DISTINCT FROM source_binding.app_id
  OR proof->>'secretReference' IS DISTINCT FROM 'secret://'||p.tenant_id||'/connections/'||p.initiating_connection_id||'/meta/rotations/'
   ||encode(public.digest('meta-legacy-authorization-'||a.id,'sha256'),'hex')
  OR COALESCE(proof->>'credentialFingerprint','') !~ '^[a-f0-9]{64}$'
  OR proof#>>'{credentialMetadata,appId}' IS DISTINCT FROM source_binding.app_id
  OR jsonb_typeof(proof->'credentialMetadata') IS DISTINCT FROM 'object'
  OR proof#>>'{credentialMetadata,expiresAt}' IS NULL OR proof#>>'{credentialMetadata,dataAccessExpiresAt}' IS NULL
  OR ((proof#>>'{credentialMetadata,expiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,expiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR ((proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR proof->>'expiresAt' IS NULL OR (proof->>'expiresAt')::timestamptz<=clock_timestamp()
  OR proof->>'verifiedAt' IS NULL OR (proof->>'verifiedAt')::timestamptz>clock_timestamp()
  OR proof->>'sourceScopeSha256' IS DISTINCT FROM (SELECT payload#>>'{metaLegacyMigration,reviewSha256}' FROM public.connection_operations
   WHERE tenant_id=p.tenant_id AND id=p.legacy_review_operation_id)
  OR EXISTS(SELECT 1 FROM public.secret_cleanup_outbox x WHERE x.tenant_id=p.tenant_id AND x.secret_reference=proof->>'secretReference'
   AND (x.attempts>0 OR x.state NOT IN('QUEUED','FAILED_RETRYABLE'))) THEN
  RAISE EXCEPTION 'The selected migration credential is no longer current' USING ERRCODE='55000';END IF;
 RETURN proof;
END $$;
ALTER FUNCTION app.meta_legacy_authorized_credential(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_authorized_credential(uuid) FROM PUBLIC;

CREATE FUNCTION app.meta_legacy_migration_context(operation_value uuid,lease_value uuid,fence_value bigint,app_value text,phase_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;review public.connection_operations;templates public.connection_operations;
 b public.meta_connection_account_bindings;t public.meta_connection_account_bindings;s public.provider_sessions;
 a public.meta_messaging_accounts;destination public.meta_messaging_accounts;slot public.meta_provider_effect_checkpoints;
 scope_value jsonb;original_binding jsonb;credential jsonb;observation jsonb;ctx jsonb;source_asset jsonb;target_asset jsonb;
 capability jsonb;registration jsonb;source_safety bigint;target_safety bigint;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF o.id IS NULL OR o.operation_type<>'EXECUTE_META_ACCOUNT_TRANSITION' OR o.requested_by_type<>'USER'
  OR COALESCE(o.payload#>>'{metaLegacyMigration,stage}','') NOT IN('OBSERVE','REGISTER','RECONCILE')
  OR COALESCE(phase_value,'') NOT IN('BEFORE_REGISTER','READBACK') THEN
  RAISE EXCEPTION 'Migration operation is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.meta_transition_actor_current(o.requested_by_id::uuid);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaLegacyMigration,id}')::uuid
  AND transition_kind='LEGACY_PHONE' AND initiating_connection_id=o.connection_id;
 SELECT * INTO t FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
 IF p.id IS NULL OR t.id IS NULL THEN RAISE EXCEPTION 'Migration account scope is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,t.account_id]);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=p.id FOR UPDATE NOWAIT;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=o.tenant_id AND id=o.id FOR UPDATE NOWAIT;
 IF o.state<>'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token<>fence_value OR o.lease_expires_at<=clock_timestamp()
  OR p.legacy_operation_id<>o.id OR p.revision::text IS DISTINCT FROM o.payload#>>'{metaLegacyMigration,revision}'
  OR p.state='CANCELLED' OR p.reconciled_at IS NOT NULL OR p.execution_scope IS NULL OR p.execution_scope_sha256 IS NULL
  OR p.target_account_id IS DISTINCT FROM t.account_id
  OR p.execution_operation_id IS DISTINCT FROM o.id
  OR encode(public.digest(app.meta_transition_scope(t.account_id)::text,'sha256'),'hex') IS DISTINCT FROM p.legacy_target_scope_sha256
  OR EXISTS(SELECT account_id FROM (VALUES(p.source_account_id),(t.account_id)) x(account_id) WHERE NOT EXISTS(
   SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id AND r.transition_id=p.id
    AND r.account_id=x.account_id AND r.released_at IS NULL)) THEN
  RAISE EXCEPTION 'Migration operation lost its current lease or reservation' USING ERRCODE='55000';END IF;
 SELECT * INTO b FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.initiating_binding_id AND state='ACTIVE';
 SELECT * INTO s FROM public.provider_sessions WHERE tenant_id=p.tenant_id AND id=b.provider_session_id AND ownership_state='ACTIVE';
 SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.source_account_id;
 SELECT * INTO destination FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=t.account_id;
 SELECT value INTO original_binding FROM jsonb_array_elements(p.execution_scope->'bindings') WHERE value->>'id'=b.id::text;
 -- Recovery pins the exact current identity snapshot at queue time. The
 -- original nonidentity scope stays immutable, and REGISTER stays exact.
 scope_value:=app.meta_transition_scope(p.source_account_id);
 IF b.id IS NULL OR s.id IS NULL OR b.app_id<>app_value OR original_binding IS NULL
  OR b.connection_id<>p.initiating_connection_id OR b.phone_number_id<>s.opaque_session_id
  OR original_binding->>'phoneId' IS DISTINCT FROM b.phone_number_id OR original_binding->>'sessionId' IS DISTINCT FROM s.id::text
  OR original_binding->>'secretReference' IS DISTINCT FROM b.secret_reference OR original_binding->>'revision' IS DISTINCT FROM b.revision::text
  OR s.provider_state_data->>'wabaId' IS DISTINCT FROM a.provider_account_id
  OR s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}' IS DISTINCT FROM b.credential_fingerprint
  OR a.provider_account_id=destination.provider_account_id OR s.state<>'PAUSED'
  OR NOT EXISTS(SELECT 1 FROM public.connections WHERE tenant_id=p.tenant_id AND id=b.connection_id AND state='PAUSED' AND secret_reference=b.secret_reference)
  OR app.meta_transition_nonidentity_scope(scope_value) IS DISTINCT FROM app.meta_transition_nonidentity_scope(p.execution_scope)
  OR (o.payload#>>'{metaLegacyMigration,stage}'='REGISTER' AND scope_value IS DISTINCT FROM p.execution_scope)
  OR (o.payload#>>'{metaLegacyMigration,stage}' IN('OBSERVE','RECONCILE')
   AND app.meta_transition_identity_snapshot(scope_value) IS DISTINCT FROM o.payload#>'{metaLegacyMigration,localIdentityScope}') THEN
  RAISE EXCEPTION 'Original migration scope changed' USING ERRCODE='55000';END IF;
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='LEGACY_REGISTER';
 IF (phase_value='READBACK' AND slot.id IS NULL) OR (phase_value='BEFORE_REGISTER' AND slot.id IS NOT NULL)
  OR (o.payload#>>'{metaLegacyMigration,stage}'='RECONCILE' AND slot.outcome IS DISTINCT FROM 'SUCCEEDED') THEN
  RAISE EXCEPTION 'Original registration outcome does not permit this operation' USING ERRCODE='55000';END IF;
 credential:=app.meta_legacy_authorized_credential(p.id);
 IF credential IS NULL OR credential->>'operationId' IS DISTINCT FROM o.payload#>>'{metaLegacyMigration,authorizationOperationId}' THEN
  RAISE EXCEPTION 'The exact destination authorization is required' USING ERRCODE='55000';END IF;
 SELECT * INTO review FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.legacy_review_operation_id;
 SELECT * INTO templates FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.legacy_template_operation_id AND state='SUCCEEDED';
 observation:=templates.result#>'{metaTemplatePreparation,observation}';
 source_safety:=app.meta_template_safety_revision(a.id);target_safety:=app.meta_template_safety_revision(destination.id);
 IF templates.id IS NULL OR observation->>'observationOperationId' IS DISTINCT FROM templates.id::text
  OR observation#>>'{source,complete}' IS DISTINCT FROM 'true' OR observation#>>'{target,complete}' IS DISTINCT FROM 'true'
  OR observation->>'metaFlowDependencyCount' IS DISTINCT FROM '0'
  OR (phase_value='BEFORE_REGISTER' AND (source_safety<>(observation->>'sourceSafetyRevision')::bigint
   OR target_safety<>(observation->>'targetSafetyRevision')::bigint)) THEN
  RAISE EXCEPTION 'Original template continuity is no longer current' USING ERRCODE='55000';END IF;
 source_asset:=jsonb_build_object('accountId',a.id,'providerAccountId',a.provider_account_id,'connectionId',b.connection_id,
  'phoneId',b.phone_number_id,'observedOwnerBusinessId',a.observed_owner_business_id,'secretReference',b.secret_reference,
  'credentialProof',s.provider_state_data->'metaAccountProof');
 target_asset:=jsonb_build_object('accountId',destination.id,'providerAccountId',destination.provider_account_id,'connectionId',b.connection_id,
  'phoneId',b.phone_number_id,'observedOwnerBusinessId',destination.observed_owner_business_id,'secretReference',credential->>'secretReference',
  'credentialProof',jsonb_build_object('credentialFingerprint',credential->>'credentialFingerprint','credentialMetadata',credential->'credentialMetadata'));
 IF o.payload#>>'{metaLegacyMigration,stage}'='REGISTER' AND p.legacy_runtime_receipt_id IS NOT NULL THEN
  capability:=app.meta_legacy_fixture_capability(b.id,t.id,p.legacy_runtime_receipt_id);
  IF capability IS NULL OR NOT app.meta_legacy_destination_ready(p.id)
   OR NOT app.meta_transition_drained(a.id,o.id) OR NOT app.meta_transition_drained(destination.id,o.id)
   OR o.payload#>>'{metaLegacyMigration,runtimeEvidenceReceiptId}' IS DISTINCT FROM p.legacy_runtime_receipt_id::text
   OR o.payload#>>'{metaLegacyMigration,fixtureSha256}' IS DISTINCT FROM capability->>'fixtureSha256' THEN
   RAISE EXCEPTION 'Exact synthetic migration admission changed' USING ERRCODE='55000';END IF;
  registration:=jsonb_build_object('evidenceMode','SIMULATED','eligibilityReceiptId',p.legacy_runtime_receipt_id,
   'providerContractSha256',capability->>'fixtureSha256','runtimeEvidenceReceiptId',p.legacy_runtime_receipt_id,
   'authorizationOperationId',credential->>'operationId','confirmationOperationId',o.id,
   'templateObservationOperationId',templates.id,'sourceTwoStepRequirement','PROVIDER_CONFIRMED',
   'destinationFunding','VERIFIED','scopeCurrent',true,'drainClear',true,'sourceServiceQuiesced',true,'expiresAt',capability->>'expiresAt');
 END IF;
 ctx:=jsonb_build_object('transitionId',p.id,'revision',p.revision,'stage',o.payload#>>'{metaLegacyMigration,stage}','appId',app_value,
  'graphVersion','v24.0','originalScopeSha256',p.execution_scope_sha256,'currentScopeSha256',encode(public.digest(scope_value::text,'sha256'),'hex'),
  'source',source_asset,'destination',target_asset,'templateObservation',observation,
  'templateObservationOperationId',templates.id,'templateObservationSha256',templates.result#>>'{metaTemplatePreparation,observationSha256}',
  'currentTemplateSafety',jsonb_build_object('source',source_safety,'target',target_safety),
  -- This finite fixture grant cannot establish any live provider eligibility.
  'registerAdmission',registration);
 RETURN ctx||jsonb_build_object('contextSha256',encode(public.digest(ctx::text,'sha256'),'hex'));
END $$;
ALTER FUNCTION app.meta_legacy_migration_context(uuid,uuid,bigint,text,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_migration_context(uuid,uuid,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_migration_context(uuid,uuid,bigint,text,text) TO wasalx_connector_worker;


-- Fragment: META_LEGACY_MIGRATION_REVIEW.sql
-- Private WIP companion. The review is local and does not claim provider
-- eligibility. Creation/resolve share the existing request ledger and lock.

CREATE FUNCTION app.meta_legacy_preparation_frame(connection_value uuid,actor_value uuid,app_value text,observation_value uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;frames jsonb;obs jsonb;slot public.meta_provider_effect_checkpoints;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=observation_value
  AND connection_id=connection_value AND state='SUCCEEDED';
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id
  AND id=(o.payload#>>'{metaTemplatePreparation,id}')::uuid AND transition_kind='TEMPLATE_PREPARATION'
  AND initiating_connection_id=connection_value;
 IF p.id IS NULL OR p.state='CANCELLED' OR p.template_state<>'READY' OR p.expires_at<=clock_timestamp()
  OR p.template_observation->>'observationOperationId' IS DISTINCT FROM o.id::text
  OR o.result#>>'{metaTemplatePreparation,state}' IS DISTINCT FROM 'READY'
  OR o.result#>>'{metaTemplatePreparation,complete}' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'A complete current template review is required' USING ERRCODE='55000';END IF;
 frames:=app.meta_template_frames(connection_value,p.template_target_connection_id,actor_value,app_value);
 IF NOT app.meta_template_observation_scope_current(p.id,frames) THEN
  RAISE EXCEPTION 'The reviewed account scope has changed' USING ERRCODE='55000';END IF;
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='TEMPLATE_COPY';
 IF slot.outcome IN('ATTEMPTED','UNKNOWN') OR (slot.outcome='SUCCEEDED' AND jsonb_array_length(slot.result->'failedSourceTemplateIds')>0) THEN
  RAISE EXCEPTION 'Original template copy is unresolved or partial' USING ERRCODE='55000';END IF;
 obs:=o.result#>'{metaTemplatePreparation,observation}';
 IF obs IS DISTINCT FROM p.template_observation OR obs#>>'{source,complete}' IS DISTINCT FROM 'true'
  OR obs#>>'{target,complete}' IS DISTINCT FROM 'true' OR obs->>'metaFlowDependencyCount' IS DISTINCT FROM '0'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(obs->'dependencies') item WHERE item->>'ready' IS DISTINCT FROM 'true')
  OR app.meta_template_safety_revision((frames#>>'{source,accountId}')::uuid)<>(obs->>'sourceSafetyRevision')::bigint
  OR app.meta_template_safety_revision((frames#>>'{target,accountId}')::uuid)<>(obs->>'targetSafetyRevision')::bigint THEN
  RAISE EXCEPTION 'Template continuity must be reviewed again' USING ERRCODE='55000';END IF;
 RETURN frames||jsonb_build_object('templatePlanId',p.id,'templatePlanRevision',p.revision,
  'templateObservationOperationId',o.id,'templateObservationSha256',o.result#>>'{metaTemplatePreparation,observationSha256}');
END $$;
ALTER FUNCTION app.meta_legacy_preparation_frame(uuid,uuid,text,uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_preparation_frame(uuid,uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION app.meta_legacy_create_result(operation_value uuid,duplicate_value boolean) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('id',o.payload#>>'{metaLegacyMigration,id}','operationId',o.id,'requestKey',o.idempotency_key,
  'request',o.payload#>'{metaLegacyMigration,createRequest}','duplicate',duplicate_value,
  'state',CASE WHEN o.payload#>>'{metaLegacyMigration,localResolution}'='NO_ADMISSION' THEN 'NO_EFFECT' ELSE 'ADMITTED' END)
 FROM public.connection_operations o WHERE o.tenant_id=app.current_tenant_id() AND o.id=operation_value
  AND o.payload#>>'{metaLegacyMigration,requestKind}'='CREATE'
$$;
ALTER FUNCTION app.meta_legacy_create_result(uuid,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_create_result(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION app.request_meta_legacy_migration(connection_value uuid,actor_value uuid,app_value text,
 key_value text,body_value jsonb,request_value text,resolve_value boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;frames jsonb;source_frame jsonb;target_frame jsonb;
 plan_id uuid:=gen_random_uuid();operation_id uuid:=gen_random_uuid();review_sha text;mode_value text;capability jsonb;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);PERFORM app.lock_meta_transition_request(key_value);
 IF jsonb_typeof(body_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(body_value))<>3
  OR COALESCE(body_value->>'templateObservationOperationId','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR jsonb_typeof(body_value->'expectedSourceBindingRevision') IS DISTINCT FROM 'number'
  OR jsonb_typeof(body_value->'expectedTargetBindingRevision') IS DISTINCT FROM 'number'
  OR COALESCE(body_value->>'expectedSourceBindingRevision','') !~ '^[1-9][0-9]{0,15}$'
  OR COALESCE(body_value->>'expectedTargetBindingRevision','') !~ '^[1-9][0-9]{0,15}$'
  OR (body_value->>'expectedSourceBindingRevision')::numeric>9007199254740991
  OR (body_value->>'expectedTargetBindingRevision')::numeric>9007199254740991 THEN
  RAISE EXCEPTION 'Invalid migration review request' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM public.connections WHERE tenant_id=app.current_tenant_id() AND id=connection_value AND provider='META';
 IF NOT FOUND THEN RAISE EXCEPTION 'Meta connection is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND idempotency_key=key_value;
 IF FOUND THEN
  IF o.connection_id<>connection_value OR o.requested_by_type<>'USER' OR o.requested_by_id<>actor_value::text
   OR o.payload#>>'{metaLegacyMigration,requestKind}' IS DISTINCT FROM 'CREATE'
   OR o.payload#>'{metaLegacyMigration,createRequest}' IS DISTINCT FROM body_value THEN
   RAISE EXCEPTION 'Request key belongs to another intent' USING ERRCODE='23514';END IF;
  RETURN app.meta_legacy_create_result(o.id,true);
 END IF;
 IF resolve_value THEN
  INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
   requested_by_id,request_id,max_attempts,state,completed_at,result)
  VALUES(operation_id,app.current_tenant_id(),connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
   jsonb_build_object('metaLegacyMigration',jsonb_build_object('requestKind','CREATE','createRequest',body_value,'localResolution','NO_ADMISSION')),
   'USER',actor_value::text,request_value,1,'CANCELLED',clock_timestamp(),jsonb_build_object('metaLegacyResolution','NOT_ADMITTED'));
  RETURN app.meta_legacy_create_result(operation_id,false);
 END IF;
 frames:=app.meta_legacy_preparation_frame(connection_value,actor_value,app_value,(body_value->>'templateObservationOperationId')::uuid);
 source_frame:=frames->'source';target_frame:=frames->'target';
 IF source_frame->>'bindingRevision' IS DISTINCT FROM body_value->>'expectedSourceBindingRevision'
  OR target_frame->>'bindingRevision' IS DISTINCT FROM body_value->>'expectedTargetBindingRevision' THEN
  RAISE EXCEPTION 'Migration account selection has changed' USING ERRCODE='55000';END IF;
 PERFORM app.assert_meta_account_unreserved((source_frame->>'accountId')::uuid);
 PERFORM app.assert_meta_account_unreserved((target_frame->>'accountId')::uuid);
 IF EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value
  AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Connection work is still active' USING ERRCODE='55000';END IF;
 -- Explicitly close the completed local preparation in the same transaction.
 -- Its original operation, immutable inventories/mapping and any settled copy
 -- checkpoint remain untouched. Failure below rolls this closure back too.
 PERFORM app.cancel_meta_template_preparation((frames->>'templatePlanId')::uuid,connection_value,actor_value,
  (frames->>'templatePlanRevision')::bigint);
 mode_value:=CASE WHEN target_frame->>'declaredMode'='MANAGED' THEN 'WASALX_MANAGED' ELSE 'CUSTOMER' END;
 capability:=app.meta_legacy_fixture_capability((source_frame->>'bindingId')::uuid,(target_frame->>'bindingId')::uuid,NULL);
 review_sha:=encode(public.digest(frames::text,'sha256'),'hex');
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
  requested_by_id,request_id,max_attempts,state,completed_at)
 VALUES(operation_id,app.current_tenant_id(),connection_value,'PREVIEW_META_ACCOUNT_TRANSITION',key_value,
  jsonb_build_object('metaAccountTransition',jsonb_build_object('id',plan_id,'accountId',source_frame->>'accountId'),
   'metaLegacyMigration',jsonb_build_object('id',plan_id,'requestKind','CREATE','createRequest',body_value,'appId',app_value,
    'reviewFrame',frames,'reviewSha256',review_sha)),'USER',actor_value::text,request_value,1,'SUCCEEDED',clock_timestamp());
 INSERT INTO public.meta_account_transitions(id,tenant_id,source_account_id,initiating_connection_id,initiating_binding_id,requested_by,
  requested_mode,target_currency,request_sha256,idempotency_key,initial_account_revision,initial_binding_revision,current_observation_operation_id,
  transition_kind,legacy_template_operation_id,legacy_target_binding_id,legacy_review_operation_id,legacy_operation_id,legacy_state,legacy_runtime_receipt_id)
 VALUES(plan_id,app.current_tenant_id(),(source_frame->>'accountId')::uuid,connection_value,(source_frame->>'bindingId')::uuid,actor_value,
  mode_value,NULL,encode(public.digest(body_value::text,'sha256'),'hex'),key_value,(source_frame->>'accountRevision')::bigint,
  (source_frame->>'bindingRevision')::bigint,operation_id,'LEGACY_PHONE',(body_value->>'templateObservationOperationId')::uuid,
  (target_frame->>'bindingId')::uuid,operation_id,operation_id,CASE WHEN capability IS NULL THEN 'PREREQUISITE_REQUIRED' ELSE 'AUTHORIZATION_REQUIRED' END,
  (capability->>'runtimeEvidenceReceiptId')::uuid);
 -- No quiesce, credential write, account reservation or provider request is
 -- performed merely because a user opens this disabled-capability review.
 RETURN app.meta_legacy_create_result(operation_id,false);
END $$;
ALTER FUNCTION app.request_meta_legacy_migration(uuid,uuid,text,text,jsonb,text,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.request_meta_legacy_migration(uuid,uuid,text,text,jsonb,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_meta_legacy_migration(uuid,uuid,text,text,jsonb,text,boolean) TO wasalx_app;

CREATE FUNCTION app.cancel_meta_legacy_migration(plan_value uuid,connection_value uuid,actor_value uuid,revision_value bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;target_account uuid;slot public.meta_provider_effect_checkpoints;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL THEN RAISE EXCEPTION 'Migration review is unavailable' USING ERRCODE='55000';END IF;
 SELECT account_id INTO target_account FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,target_account]);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE;
 IF p.state='CANCELLED' AND p.revision=revision_value+1 THEN RETURN jsonb_build_object('id',p.id,'duplicate',true);END IF;
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='LEGACY_REGISTER';
 IF p.state='CANCELLED' OR p.revision<>revision_value OR (slot.id IS NOT NULL AND slot.outcome IS DISTINCT FROM 'REJECTED') OR p.reconciled_at IS NOT NULL THEN
  RAISE EXCEPTION 'Original provider migration cannot be cancelled' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET state='CANCELLED',completed_at=clock_timestamp(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL
  WHERE tenant_id=p.tenant_id AND id=p.legacy_operation_id AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE');
 UPDATE public.meta_account_transitions SET state='CANCELLED',cancelled_at=clock_timestamp(),revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=p.id;
 UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='PRE_EFFECT_CANCEL',revision=revision+1
  WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 -- No prior outbox birth, source lifecycle, template review or account policy
 -- is revived. Resume is a separate normal current-authority operation.
 RETURN jsonb_build_object('id',p.id,'duplicate',false);
END $$;
ALTER FUNCTION app.cancel_meta_legacy_migration(uuid,uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.cancel_meta_legacy_migration(uuid,uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_meta_legacy_migration(uuid,uuid,uuid,bigint) TO wasalx_app;


-- Fragment: META_LEGACY_AUTHORIZATION.sql
-- Private B2. Existing one-use signup/rotation stage and secret cleanup; no
-- ordinary session rotation, provider mutation, or financial authority here.

DO $$ DECLARE boundary_name text;boundary_count integer;expression text;item text;extra text;
BEGIN
 -- The earlier observer relation was intentionally unnamed. Identify its exact
 -- column dependency and expression, never an assumed generated ordinal.
 SELECT count(*),min(c.conname::text) INTO boundary_count,boundary_name
  FROM pg_catalog.pg_constraint c WHERE c.conrelid='public.meta_signup_attempts'::regclass AND c.contype='c'
   AND replace(regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]','','g'),'::text','')
    = 'purpose=''TRANSITION_READBACK''=target_transition_idISNOTNULL';
 IF boundary_count<>1 THEN RAISE EXCEPTION 'Exact observer purpose boundary is absent or ambiguous';END IF;
 EXECUTE format('ALTER TABLE public.meta_signup_attempts DROP CONSTRAINT %I',boundary_name);
 ALTER TABLE public.meta_signup_attempts ADD CONSTRAINT meta_signup_transition_purpose_check
  CHECK((purpose IN('TRANSITION_READBACK','LEGACY_MIGRATION'))=(target_transition_id IS NOT NULL));
 FOR item,extra IN SELECT * FROM (VALUES
  ('meta_signup_attempts_purpose_check','purpose=''LEGACY_MIGRATION'''),
  ('meta_signup_registration_purpose_check','purpose=''LEGACY_MIGRATION'' AND registration_claimed_at IS NULL'),
  ('meta_signup_reconnect_target_check','purpose=''LEGACY_MIGRATION'' AND target_connection_id IS NOT NULL AND target_binding IS NOT NULL AND jsonb_typeof(target_binding)=''object'' AND target_binding->>''contextSha256'' ~ ''^[a-f0-9]{64}$'' AND target_transition_id IS NOT NULL AND (connection_id IS NULL OR connection_id=target_connection_id)'),
  ('meta_signup_connection_write_purpose_check','purpose=''LEGACY_MIGRATION'' AND target_transition_id IS NOT NULL AND connection_id IS NOT NULL')) x(name,extension)
 LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_catalog.pg_constraint WHERE conrelid='public.meta_signup_attempts'::regclass AND conname=item;
  IF expression IS NULL THEN RAISE EXCEPTION 'Expected signup boundary is absent';END IF;
  EXECUTE format('ALTER TABLE public.meta_signup_attempts DROP CONSTRAINT %I',item);
  EXECUTE format('ALTER TABLE public.meta_signup_attempts ADD CONSTRAINT %I CHECK ((%s) OR ((%s) IS TRUE))',item,expression,extra);
 END LOOP;
END $$;
GRANT UPDATE(registration_pin_fingerprint) ON public.meta_signup_attempts TO wasalx_meta_transition_executor;

CREATE FUNCTION app.meta_legacy_authorization_target(plan_value uuid,connection_value uuid,actor_value uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;b public.meta_connection_account_bindings;t public.meta_connection_account_bindings;
 c public.connections;s public.provider_sessions;a public.meta_messaging_accounts;r public.connection_operations;v jsonb;scope_value jsonb;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value AND transition_kind='LEGACY_PHONE';
 SELECT * INTO t FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id AND state='ACTIVE';
 IF p.id IS NULL OR t.id IS NULL OR p.state='CANCELLED' OR p.reconciled_at IS NOT NULL THEN
  RAISE EXCEPTION 'Original migration is unavailable' USING ERRCODE='55000';END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,t.account_id]);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE NOWAIT;
 SELECT * INTO b FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.initiating_binding_id AND state='ACTIVE';
 SELECT * INTO c FROM public.connections WHERE tenant_id=p.tenant_id AND id=connection_value;
 SELECT * INTO s FROM public.provider_sessions WHERE tenant_id=p.tenant_id AND id=b.provider_session_id AND ownership_state='ACTIVE';
 SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=t.account_id;
 SELECT * INTO r FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.legacy_review_operation_id;
 IF b.id IS NULL OR b.connection_id<>connection_value OR b.account_id<>p.source_account_id OR b.app_id<>t.app_id
  OR c.state NOT IN('WORKING','PAUSED') OR s.state<>c.state OR c.secret_reference<>b.secret_reference
  OR s.opaque_session_id<>b.phone_number_id OR p.legacy_runtime_receipt_id IS NULL
  OR (p.execution_scope IS NULL AND app.meta_legacy_fixture_capability(b.id,t.id,p.legacy_runtime_receipt_id) IS NULL)
  OR b.revision::text IS DISTINCT FROM r.payload#>>'{metaLegacyMigration,reviewFrame,source,bindingRevision}'
  OR EXISTS(SELECT 1 FROM public.connection_operations work WHERE work.tenant_id=p.tenant_id AND work.id=p.legacy_operation_id
   AND work.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'The captured migration authorization target changed' USING ERRCODE='55000';END IF;
 IF p.execution_scope IS NOT NULL THEN
  scope_value:=app.meta_transition_scope(p.source_account_id);
  IF app.meta_transition_nonidentity_scope(scope_value) IS DISTINCT FROM app.meta_transition_nonidentity_scope(p.execution_scope)
   -- After the original stage is committed, fresh destination authorization is
   -- readback-only. Expiry of the historical source token cannot demand another
   -- provider effect or replace the original immutable capability/checkpoint.
   OR NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints slot
    WHERE slot.tenant_id=p.tenant_id AND slot.owner_kind='ACCOUNT_TRANSITION' AND slot.owner_id=p.id
     AND slot.stage='LEGACY_REGISTER' AND slot.outcome IN('ATTEMPTED','UNKNOWN','SUCCEEDED')
     AND slot.account_id=t.account_id AND slot.runtime_execution->>'mode'='SIMULATED'
     AND slot.runtime_execution->>'runtimeEvidenceReceiptId'=p.legacy_runtime_receipt_id::text)
   OR c.state<>'PAUSED' OR NOT EXISTS(SELECT 1 FROM public.meta_account_transition_reservations reservation
    WHERE reservation.tenant_id=p.tenant_id AND reservation.transition_id=p.id AND reservation.account_id=p.source_account_id AND reservation.released_at IS NULL)
   THEN RAISE EXCEPTION 'Reserved source binding changed' USING ERRCODE='55000';END IF;
 END IF;
 v:=jsonb_build_object('state',c.state,'transitionId',p.id,'scopeSha256',r.payload#>>'{metaLegacyMigration,reviewSha256}',
  'sourceBindingId',b.id,'sourceBindingRevision',b.revision,'connectionId',c.id,'providerSessionId',s.id,
  'phoneNumberId',b.phone_number_id,'wabaId',a.provider_account_id,'appId',b.app_id,'secretReference',b.secret_reference);
 RETURN v||jsonb_build_object('contextSha256',encode(public.digest(v::text,'sha256'),'hex'));
END $$;
ALTER FUNCTION app.meta_legacy_authorization_target(uuid,uuid,uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_authorization_target(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_authorization_target(uuid,uuid,uuid) TO wasalx_app;

CREATE FUNCTION app.stage_meta_legacy_authorization(attempt_value uuid,actor_value uuid,revision_value integer,
 choice_value uuid,selection jsonb,metadata jsonb,pin_fingerprint text,request_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;o public.connection_operations;t jsonb;choice jsonb;id_value uuid:=gen_random_uuid();reference_value text;
BEGIN
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value;
 IF attempt.id IS NULL OR attempt.purpose<>'LEGACY_MIGRATION' THEN RAISE EXCEPTION 'Migration authorization unavailable' USING ERRCODE='55000';END IF;
 t:=app.meta_legacy_authorization_target(attempt.target_transition_id,attempt.target_connection_id,actor_value);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=attempt.tenant_id AND id=attempt.id FOR UPDATE NOWAIT;
 IF attempt.target_binding IS DISTINCT FROM t OR attempt.revision<>revision_value OR COALESCE(pin_fingerprint,'') !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Migration authorization changed' USING ERRCODE='55000';END IF;
 IF attempt.connection_id IS NOT NULL THEN
  SELECT * INTO o FROM public.connection_operations WHERE tenant_id=attempt.tenant_id AND id=attempt.operation_id FOR UPDATE NOWAIT;
  IF o.state IS DISTINCT FROM 'STAGED' OR o.payload#>>'{metaLegacyAuthorization,attemptId}' IS DISTINCT FROM attempt.id::text
   OR attempt.selected_choice->>'choiceId' IS DISTINCT FROM choice_value::text
   OR attempt.registration_pin_fingerprint IS DISTINCT FROM pin_fingerprint THEN
   RAISE EXCEPTION 'Original credential stage changed' USING ERRCODE='55000';END IF;
  RETURN jsonb_build_object('operation',to_jsonb(o),'attemptRevision',attempt.revision,'claimed',attempt.connection_credential_write_claimed_at IS NOT NULL);
 END IF;
 SELECT value INTO choice FROM jsonb_array_elements(attempt.choices) WHERE value->>'choiceId'=choice_value::text;
 IF attempt.status<>'SELECTION_REQUIRED' OR attempt.expires_at<=clock_timestamp() OR attempt.credential_fingerprint IS NULL
  OR choice IS NULL OR choice->>'selectable' IS DISTINCT FROM 'true' OR choice->>'mode' IS DISTINCT FROM 'STANDARD'
  OR choice->>'phoneId' IS DISTINCT FROM t->>'phoneNumberId' OR choice->>'wabaId' IS DISTINCT FROM t->>'wabaId'
  OR selection->>'phoneId' IS DISTINCT FROM choice->>'phoneId' OR selection->>'wabaId' IS DISTINCT FROM choice->>'wabaId'
  OR selection->>'businessId' IS DISTINCT FROM choice->>'businessId' OR selection->>'mode' IS DISTINCT FROM 'STANDARD'
  OR COALESCE(selection->>'proofSha256','') !~ '^[a-f0-9]{64}$' OR metadata->>'appId' IS DISTINCT FROM t->>'appId'
  OR metadata->>'claim' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED' OR attempt.config->>'appId' IS DISTINCT FROM t->>'appId'
  OR attempt.registration_claimed_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.connection_operations work
   WHERE work.tenant_id=attempt.tenant_id AND work.connection_id=attempt.target_connection_id AND work.state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Verified destination selection is unavailable' USING ERRCODE='55000';END IF;
 reference_value:='secret://'||attempt.tenant_id||'/connections/'||attempt.target_connection_id||'/meta/rotations/'
  ||encode(public.digest('meta-legacy-authorization-'||attempt.id,'sha256'),'hex');
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,max_attempts,requested_by_type,requested_by_id,request_id)
 VALUES(id_value,attempt.tenant_id,attempt.target_connection_id,'ROTATE_META_CREDENTIAL','meta-legacy-authorization-'||attempt.id,
  jsonb_build_object('metaSignupAttemptId',attempt.id,'metaSignupPurpose','LEGACY_MIGRATION','oldSecretReference',t->>'secretReference',
   'newSecretReference',reference_value,'metaLegacyAuthorization',jsonb_build_object('transitionId',attempt.target_transition_id,
    'sourceBindingId',t->>'sourceBindingId','scopeSha256',t->>'scopeSha256','attemptId',attempt.id)),
  'STAGED',1,'USER',actor_value::text,request_value) RETURNING * INTO o;
 UPDATE public.meta_signup_attempts SET connection_id=target_connection_id,operation_id=o.id,status='PROVISIONING',
  selected_choice=jsonb_build_object('choiceId',choice_value,'businessId',selection->>'businessId','wabaId',selection->>'wabaId',
   'phoneId',selection->>'phoneId','mode','STANDARD','numberState',selection->>'numberState','proofSha256',selection->>'proofSha256'),
  credential_metadata=metadata,registration_pin_fingerprint=pin_fingerprint,revision=revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=attempt.tenant_id AND id=attempt.id RETURNING * INTO attempt;
 INSERT INTO public.secret_cleanup_outbox(tenant_id,connection_id,connection_operation_id,cleanup_kind,secret_reference)
 VALUES(attempt.tenant_id,attempt.connection_id,o.id,'CONNECTION_CREDENTIAL',reference_value);
 RETURN jsonb_build_object('operation',to_jsonb(o),'attemptRevision',attempt.revision,'claimed',false);
END $$;
ALTER FUNCTION app.stage_meta_legacy_authorization(uuid,uuid,integer,uuid,jsonb,jsonb,text,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.stage_meta_legacy_authorization(uuid,uuid,integer,uuid,jsonb,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stage_meta_legacy_authorization(uuid,uuid,integer,uuid,jsonb,jsonb,text,text) TO wasalx_app;

CREATE FUNCTION app.claim_meta_legacy_authorization_write(attempt_value uuid,actor_value uuid,revision_value integer) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;t jsonb;
BEGIN
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value AND purpose='LEGACY_MIGRATION';
 IF attempt.id IS NULL THEN RAISE EXCEPTION 'Authorization unavailable' USING ERRCODE='55000';END IF;
 t:=app.meta_legacy_authorization_target(attempt.target_transition_id,attempt.target_connection_id,actor_value);
 IF t IS DISTINCT FROM attempt.target_binding THEN RAISE EXCEPTION 'Authorization target changed' USING ERRCODE='55000';END IF;
 UPDATE public.meta_signup_attempts SET connection_credential_write_claimed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
 WHERE tenant_id=attempt.tenant_id AND id=attempt.id AND revision=revision_value AND status='PROVISIONING' AND connection_credential_write_claimed_at IS NULL
  AND EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=attempt.tenant_id AND o.id=attempt.operation_id AND o.state='STAGED'
   AND o.payload#>>'{metaLegacyAuthorization,attemptId}'=attempt.id::text) RETURNING * INTO attempt;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original credential write may already have run' USING ERRCODE='55000';END IF;
 RETURN attempt.revision;
END $$;
ALTER FUNCTION app.claim_meta_legacy_authorization_write(uuid,uuid,integer) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.claim_meta_legacy_authorization_write(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_meta_legacy_authorization_write(uuid,uuid,integer) TO wasalx_app;

CREATE FUNCTION app.complete_meta_legacy_authorization(attempt_value uuid,actor_value uuid,revision_value integer,proof jsonb,pin_fingerprint text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;o public.connection_operations;t jsonb;receipt jsonb;
BEGIN
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value AND purpose='LEGACY_MIGRATION';
 IF attempt.id IS NULL THEN RAISE EXCEPTION 'Authorization unavailable' USING ERRCODE='55000';END IF;
 t:=app.meta_legacy_authorization_target(attempt.target_transition_id,attempt.target_connection_id,actor_value);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=attempt.tenant_id AND id=attempt.id FOR UPDATE NOWAIT;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=attempt.tenant_id AND id=attempt.operation_id FOR UPDATE NOWAIT;
 IF attempt.target_binding IS DISTINCT FROM t OR attempt.revision<>revision_value OR attempt.status<>'PROVISIONING'
  OR attempt.connection_credential_write_claimed_at IS NULL OR attempt.registration_pin_fingerprint IS DISTINCT FROM pin_fingerprint
  OR o.state IS DISTINCT FROM 'STAGED' OR o.result IS NOT NULL OR jsonb_typeof(proof) IS DISTINCT FROM 'object'
  OR proof->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED' OR proof->>'schemaVersion' IS DISTINCT FROM '1'
  OR proof->>'tenantId' IS DISTINCT FROM attempt.tenant_id::text OR proof->>'connectionId' IS DISTINCT FROM attempt.connection_id::text
  OR proof->>'providerSessionId' IS DISTINCT FROM t->>'providerSessionId' OR proof->>'phoneNumberId' IS DISTINCT FROM t->>'phoneNumberId'
  OR proof->>'wabaId' IS DISTINCT FROM t->>'wabaId' OR proof->>'operationId' IS DISTINCT FROM o.id::text
  OR proof->>'secretReference' IS DISTINCT FROM o.payload->>'newSecretReference' OR proof->>'credentialFingerprint' IS DISTINCT FROM attempt.credential_fingerprint
  OR proof->>'graphVersion' IS DISTINCT FROM attempt.config->>'graphVersion' OR proof->>'fencingToken' IS DISTINCT FROM '0'
  OR COALESCE(proof->>'responseSha256','') !~ '^[a-f0-9]{64}$'
  OR proof#>>'{credentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
  OR proof#>>'{credentialMetadata,appId}' IS DISTINCT FROM t->>'appId'
  OR proof#>>'{credentialMetadata,schemaVersion}' IS DISTINCT FROM '1'
  OR COALESCE(proof#>>'{credentialMetadata,responseSha256}','') !~ '^[a-f0-9]{64}$'
  OR proof#>>'{credentialMetadata,verifiedAt}' IS NULL
  OR (proof#>>'{credentialMetadata,verifiedAt}')::timestamptz NOT BETWEEN clock_timestamp()-interval '2 minutes' AND clock_timestamp()
  OR NOT COALESCE(proof#>'{credentialMetadata,scopes}' @> '["whatsapp_business_management","whatsapp_business_messaging"]'::jsonb,false)
  OR proof#>>'{credentialMetadata,expiresAt}' IS NULL OR proof#>>'{credentialMetadata,dataAccessExpiresAt}' IS NULL
  OR ((proof#>>'{credentialMetadata,expiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,expiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR ((proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<>0 AND (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric<=extract(epoch FROM clock_timestamp()))
  OR proof->>'verifiedAt' IS NULL OR (proof->>'verifiedAt')::timestamptz NOT BETWEEN clock_timestamp()-interval '2 minutes' AND clock_timestamp() THEN
  RAISE EXCEPTION 'Exact destination credential proof changed' USING ERRCODE='55000';END IF;
 receipt:=jsonb_build_object('schemaVersion',1,'claim','LEGACY_TARGET_ACCESS_VERIFIED','transitionId',attempt.target_transition_id,
  'operationId',o.id,'attemptId',attempt.id,'sourceBindingId',t->>'sourceBindingId','sourcePhoneId',t->>'phoneNumberId',
  'targetAccountId',t->>'wabaId','appId',t->>'appId','secretReference',proof->>'secretReference',
  'credentialFingerprint',proof->>'credentialFingerprint','credentialMetadata',proof->'credentialMetadata',
  'verifiedAt',proof->>'verifiedAt','expiresAt',clock_timestamp()+interval '24 hours','sourceScopeSha256',t->>'scopeSha256','accountProof',proof);
 UPDATE public.connection_operations SET state='SUCCEEDED',completed_at=clock_timestamp(),updated_at=clock_timestamp(),
  result=jsonb_build_object('metaLegacyAuthorizationReady',true,'metaLegacyAuthorizationProof',receipt) WHERE tenant_id=o.tenant_id AND id=o.id;
 UPDATE public.meta_signup_attempts SET status='COMPLETED',reason_code=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=attempt.tenant_id AND id=attempt.id;
 UPDATE public.meta_account_transitions SET legacy_authorization_operation_id=o.id,
  legacy_state=CASE WHEN execution_scope IS NULL THEN 'READY' ELSE legacy_state END,revision=revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=attempt.tenant_id AND id=attempt.target_transition_id;
 RETURN true;
END $$;
ALTER FUNCTION app.complete_meta_legacy_authorization(uuid,uuid,integer,jsonb,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.complete_meta_legacy_authorization(uuid,uuid,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.complete_meta_legacy_authorization(uuid,uuid,integer,jsonb,text) TO wasalx_app;
CREATE FUNCTION app.cancel_meta_legacy_authorization(attempt_value uuid,actor_value uuid,revision_value integer,stored_fingerprint text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE attempt public.meta_signup_attempts;o public.connection_operations;p public.meta_account_transitions;target_account uuid;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=app.current_tenant_id() AND id=attempt_value AND requested_by=actor_value AND purpose='LEGACY_MIGRATION';
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=attempt.tenant_id AND id=attempt.target_transition_id;
 SELECT account_id INTO target_account FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
 IF attempt.id IS NULL OR p.id IS NULL THEN RETURN false;END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,target_account]);
 SELECT * INTO attempt FROM public.meta_signup_attempts WHERE tenant_id=p.tenant_id AND id=attempt.id FOR UPDATE NOWAIT;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=attempt.operation_id FOR UPDATE NOWAIT;
 IF attempt.revision<>revision_value OR attempt.status<>'PROVISIONING' OR o.state IS DISTINCT FROM 'STAGED'
  OR o.payload#>>'{metaLegacyAuthorization,attemptId}' IS DISTINCT FROM attempt.id::text
  OR p.legacy_authorization_operation_id=o.id
  OR (stored_fingerprint IS NOT NULL AND stored_fingerprint IS DISTINCT FROM attempt.credential_fingerprint)
  OR (attempt.connection_credential_write_claimed_at IS NOT NULL AND stored_fingerprint IS NULL) THEN RETURN false;END IF;
 UPDATE public.connection_operations SET state='CANCELLED',result=jsonb_build_object('stageReconciled',true,'promoted',false),
  error_code='META_SIGNUP_CANCELLED',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=o.tenant_id AND id=o.id;
 UPDATE public.meta_signup_attempts SET status='CANCELLED',reason_code='META_SIGNUP_CANCELLED',choices='[]',revision=revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=attempt.tenant_id AND id=attempt.id;
 RETURN true;
END $$;
ALTER FUNCTION app.cancel_meta_legacy_authorization(uuid,uuid,integer,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.cancel_meta_legacy_authorization(uuid,uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_meta_legacy_authorization(uuid,uuid,integer,text) TO wasalx_app;

CREATE FUNCTION app.guard_meta_legacy_authorization() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='meta_signup_attempts' THEN
  IF NEW.purpose='LEGACY_MIGRATION' AND TG_OP='UPDATE' AND current_user<>'wasalx_meta_transition_executor'
   AND (NEW.connection_id,NEW.operation_id,NEW.selected_choice,NEW.registration_pin_fingerprint,NEW.connection_credential_write_claimed_at)
    IS DISTINCT FROM (OLD.connection_id,OLD.operation_id,OLD.selected_choice,OLD.registration_pin_fingerprint,OLD.connection_credential_write_claimed_at) THEN
   RAISE EXCEPTION 'Migration credential stage requires sealed admission' USING ERRCODE='42501';END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   IF NEW.payload ? 'metaLegacyAuthorization' AND (current_user<>'wasalx_meta_transition_executor'
    OR NEW.state<>'STAGED' OR NEW.operation_type<>'ROTATE_META_CREDENTIAL') THEN
    RAISE EXCEPTION 'Migration authorization is not ordinary rotation' USING ERRCODE='42501';END IF;
  ELSIF OLD.payload ? 'metaLegacyAuthorization' THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Migration authorization history is retained' USING ERRCODE='55000';END IF;
   IF current_user='wasalx_meta_transition_executor'
    AND OLD.state='SUCCEEDED' AND OLD.result ? 'metaLegacyAuthorizationProof'
    AND NOT(OLD.result->'metaLegacyAuthorizationProof' ? 'redacted')
    AND NEW.result=jsonb_set(OLD.result,'{metaLegacyAuthorizationProof}',jsonb_build_object('redacted',true,'sha256',
     encode(public.digest((OLD.result->'metaLegacyAuthorizationProof')::text,'sha256'),'hex')))
    AND (to_jsonb(NEW)-'result')=(to_jsonb(OLD)-'result') THEN
    IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
   END IF;
   IF (NEW.payload,NEW.connection_id,NEW.tenant_id,NEW.operation_type,NEW.idempotency_key,NEW.requested_by_id)
    IS DISTINCT FROM (OLD.payload,OLD.connection_id,OLD.tenant_id,OLD.operation_type,OLD.idempotency_key,OLD.requested_by_id)
    OR NEW.state NOT IN('STAGED','SUCCEEDED','CANCELLED') OR (OLD.state<>'STAGED' AND NEW.state<>OLD.state)
    OR (NEW.state IS DISTINCT FROM OLD.state AND current_user<>'wasalx_meta_transition_executor')
    OR (NEW.result IS DISTINCT FROM OLD.result AND (current_user<>'wasalx_meta_transition_executor' OR OLD.result IS NOT NULL)) THEN
    RAISE EXCEPTION 'Migration authorization cannot dispatch or change authority' USING ERRCODE='23514';END IF;
  ELSIF TG_OP='UPDATE' AND NEW.payload ? 'metaLegacyAuthorization' THEN
   RAISE EXCEPTION 'Migration authorization purpose is immutable' USING ERRCODE='23514';END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
REVOKE ALL ON FUNCTION app.guard_meta_legacy_authorization() FROM PUBLIC;
CREATE TRIGGER meta_legacy_authorization_attempt BEFORE UPDATE ON public.meta_signup_attempts FOR EACH ROW EXECUTE FUNCTION app.guard_meta_legacy_authorization();
CREATE TRIGGER meta_legacy_authorization_operation BEFORE INSERT OR UPDATE OR DELETE ON public.connection_operations FOR EACH ROW EXECUTE FUNCTION app.guard_meta_legacy_authorization();


-- Fragment: META_LEGACY_MIGRATION_REQUESTS.sql
-- Private WIP. Finite local read/cancel and original-key no-admission recovery.
-- This file does not grant the missing live legacy provider capability.

CREATE FUNCTION app.meta_legacy_action_result(plan_value uuid,operation_value uuid,duplicate_value boolean) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('id',plan_value,'operationId',o.id,'duplicate',duplicate_value,
  'pendingAction',jsonb_build_object('operationId',o.id,'requestKey',o.idempotency_key,
   'action',o.payload#>>'{metaLegacyMigration,stage}','requestRevision',(o.payload#>>'{metaLegacyMigration,requestRevision}')::bigint,
   'state',CASE WHEN o.state='FAILED_RETRYABLE' THEN 'FAILED_TERMINAL' ELSE o.state END))
 FROM public.connection_operations o WHERE o.tenant_id=app.current_tenant_id() AND o.id=operation_value
  AND o.payload#>>'{metaLegacyMigration,id}'=plan_value::text
$$;
ALTER FUNCTION app.meta_legacy_action_result(uuid,uuid,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_action_result(uuid,uuid,boolean) FROM PUBLIC;

CREATE FUNCTION app.request_meta_legacy_migration_action(plan_value uuid,connection_value uuid,actor_value uuid,app_value text,
 key_value text,action_value text,body_value jsonb,request_value text,resolve_value boolean) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;o public.connection_operations;operation_id uuid:=gen_random_uuid();
 target_account uuid;slot public.meta_provider_effect_checkpoints;credential jsonb;scope_value jsonb;review_sha text;
 capability jsonb;review_frame jsonb;frames jsonb;target_scope jsonb;source_revision bigint;target_revision bigint;
BEGIN
 PERFORM app.meta_transition_actor_current(actor_value);PERFORM app.lock_meta_transition_request(key_value);
 IF COALESCE(action_value,'') NOT IN('OBSERVE','REGISTER','RECONCILE') OR jsonb_typeof(body_value) IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(body_value))<>(CASE WHEN action_value='REGISTER' THEN 3 ELSE 2 END)
  OR jsonb_typeof(body_value->'expectedRevision') IS DISTINCT FROM 'number'
  OR COALESCE(body_value->>'expectedRevision','') !~ '^[1-9][0-9]{0,15}$'
  OR (body_value->>'expectedRevision')::numeric>9007199254740991
  OR COALESCE(body_value->>'expectedReviewSha256','') !~ '^[a-f0-9]{64}$'
  OR (action_value='REGISTER' AND body_value->'confirmCutover' IS DISTINCT FROM 'true'::jsonb) THEN
  RAISE EXCEPTION 'Invalid migration action' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL THEN RAISE EXCEPTION 'Migration review is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND idempotency_key=key_value;
 IF FOUND THEN
  IF o.connection_id<>connection_value OR o.requested_by_type<>'USER' OR o.requested_by_id<>actor_value::text
   OR o.payload#>>'{metaLegacyMigration,id}' IS DISTINCT FROM p.id::text
   OR o.payload#>>'{metaLegacyMigration,stage}' IS DISTINCT FROM action_value
   OR o.payload#>'{metaLegacyMigration,actionRequest}' IS DISTINCT FROM body_value THEN
   RAISE EXCEPTION 'Request key belongs to another intent' USING ERRCODE='23514';END IF;
  RETURN app.meta_legacy_action_result(p.id,o.id,true);
 END IF;
 IF resolve_value THEN
  INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
   requested_by_id,request_id,max_attempts,state,completed_at,result)
  VALUES(operation_id,p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
   jsonb_build_object('metaLegacyMigration',jsonb_build_object('id',p.id,'stage',action_value,'actionRequest',body_value,
    'requestRevision',(body_value->>'expectedRevision')::bigint,'localResolution','NO_ADMISSION')),
   'USER',actor_value::text,request_value,1,'CANCELLED',clock_timestamp(),jsonb_build_object('metaLegacyResolution','NOT_ADMITTED'));
  RETURN app.meta_legacy_action_result(p.id,operation_id,false);
 END IF;
 SELECT account_id INTO target_account FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,target_account]);
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE NOWAIT;
 SELECT payload#>>'{metaLegacyMigration,reviewSha256}',payload#>'{metaLegacyMigration,reviewFrame}' INTO review_sha,review_frame FROM public.connection_operations
  WHERE tenant_id=p.tenant_id AND id=p.legacy_review_operation_id;
 IF p.state='CANCELLED' OR p.reconciled_at IS NOT NULL OR p.revision::text IS DISTINCT FROM body_value->>'expectedRevision'
  OR review_sha IS DISTINCT FROM body_value->>'expectedReviewSha256' THEN
  RAISE EXCEPTION 'Migration review changed' USING ERRCODE='55000';END IF;
 -- The default-off simulator tuple was recorded by the existing trusted
 -- installed-manifest producer, not by this tenant command. LIVE stays denied.
 IF action_value='REGISTER' THEN
  IF p.execution_scope IS NOT NULL OR p.legacy_runtime_receipt_id IS NULL
   OR EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id
    AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='LEGACY_REGISTER') THEN
   RAISE EXCEPTION 'Original migration stage cannot be replaced' USING ERRCODE='55000';END IF;
  capability:=app.meta_legacy_fixture_capability(p.initiating_binding_id,p.legacy_target_binding_id,p.legacy_runtime_receipt_id);
  credential:=app.meta_legacy_authorized_credential(p.id);
  IF capability IS NULL OR credential IS NULL OR p.expires_at<=clock_timestamp()
   OR NOT app.meta_transition_drained(p.source_account_id,NULL) OR NOT app.meta_transition_drained(target_account,NULL) THEN
   RAISE EXCEPTION 'Synthetic migration prerequisites are unavailable' USING ERRCODE='55000';END IF;
  frames:=app.meta_template_frames(connection_value,(review_frame#>>'{target,connectionId}')::uuid,actor_value,app_value);
  IF frames->'source' IS DISTINCT FROM review_frame->'source' OR frames->'target' IS DISTINCT FROM review_frame->'target'
   OR NOT app.meta_legacy_destination_ready(p.id) THEN
   RAISE EXCEPTION 'Reviewed migration scope or target funding changed' USING ERRCODE='55000';END IF;
  PERFORM app.assert_meta_account_unreserved(p.source_account_id);PERFORM app.assert_meta_account_unreserved(target_account);
  -- These are the existing account-wide locks/drain/generation barriers. The
  -- one selected phone moves; all affected historical account births stay old.
  UPDATE public.connections SET state='PAUSED',updated_at=now() WHERE tenant_id=p.tenant_id AND id IN(
   SELECT connection_id FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND account_id=p.source_account_id AND state<>'RETIRED');
  UPDATE public.provider_sessions SET state='PAUSED',updated_at=now() WHERE tenant_id=p.tenant_id AND id IN(
   SELECT provider_session_id FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND account_id=p.source_account_id AND state<>'RETIRED');
  UPDATE public.webhook_routes SET state='PAUSED',updated_at=now() WHERE tenant_id=p.tenant_id AND provider='META' AND connection_id IN(
   SELECT connection_id FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND account_id=p.source_account_id AND state<>'RETIRED');
  UPDATE public.meta_messaging_accounts SET state='HELD',authority_revision=authority_revision+1,updated_at=now()
   WHERE tenant_id=p.tenant_id AND id=p.source_account_id RETURNING authority_revision INTO source_revision;
  SELECT authority_revision INTO target_revision FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=target_account;
  scope_value:=app.meta_transition_scope(p.source_account_id);target_scope:=app.meta_transition_scope(target_account);
  INSERT INTO public.meta_account_transition_reservations(tenant_id,account_id,transition_id,account_role,scope_sha256,authority_revision)
  VALUES(p.tenant_id,p.source_account_id,p.id,'SOURCE',encode(public.digest(scope_value::text,'sha256'),'hex'),source_revision),
   (p.tenant_id,target_account,p.id,'TARGET',encode(public.digest(target_scope::text,'sha256'),'hex'),target_revision);
  INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
   requested_by_id,request_id,max_attempts)
  VALUES(operation_id,p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
   jsonb_build_object('metaLegacyMigration',jsonb_build_object('id',p.id,'stage','REGISTER','actionRequest',body_value,
    'requestRevision',p.revision,'revision',p.revision+1,'appId',app_value,'authorizationOperationId',credential->>'operationId',
    'runtimeEvidenceReceiptId',p.legacy_runtime_receipt_id,'fixtureSha256',capability->>'fixtureSha256',
    'originalScopeSha256',encode(public.digest(scope_value::text,'sha256'),'hex'),
    'localIdentityScope',app.meta_transition_identity_snapshot(scope_value))),
   'USER',actor_value::text,request_value,1);
  UPDATE public.meta_account_transitions SET target_account_id=target_account,execution_scope=scope_value,
   execution_scope_sha256=encode(public.digest(scope_value::text,'sha256'),'hex'),execution_state='RESERVED',
   legacy_target_scope_sha256=encode(public.digest(target_scope::text,'sha256'),'hex'),
   execution_operation_id=operation_id,legacy_operation_id=operation_id,legacy_state='REGISTERING',revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
  RETURN app.meta_legacy_action_result(p.id,operation_id,false);
 END IF;
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='LEGACY_REGISTER';
 IF slot.id IS NULL OR slot.outcome='REJECTED' OR (action_value='RECONCILE' AND slot.outcome<>'SUCCEEDED')
  OR p.execution_scope IS NULL OR p.target_account_id IS DISTINCT FROM target_account
  OR EXISTS(SELECT account_id FROM (VALUES(p.source_account_id),(target_account)) x(account_id) WHERE NOT EXISTS(
   SELECT 1 FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id AND r.transition_id=p.id
    AND r.account_id=x.account_id AND r.released_at IS NULL)) THEN
  RAISE EXCEPTION 'Only the original retained registration permits recovery' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=p.tenant_id AND connection_id=connection_value
  AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Current connection work must finish first' USING ERRCODE='55000';END IF;
 credential:=app.meta_legacy_authorized_credential(p.id);
 scope_value:=app.meta_transition_scope(p.source_account_id);
 IF credential IS NULL OR app.meta_transition_nonidentity_scope(scope_value) IS DISTINCT FROM app.meta_transition_nonidentity_scope(p.execution_scope)
  OR (action_value='RECONCILE' AND (NOT app.meta_transition_drained(p.source_account_id,NULL)
   OR NOT app.meta_transition_drained(target_account,NULL))) THEN
  RAISE EXCEPTION 'Migration recovery prerequisites are unavailable' USING ERRCODE='55000';END IF;
 INSERT INTO public.connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,requested_by_type,
  requested_by_id,request_id,max_attempts)
 VALUES(operation_id,p.tenant_id,connection_value,'EXECUTE_META_ACCOUNT_TRANSITION',key_value,
  jsonb_build_object('metaLegacyMigration',jsonb_build_object('id',p.id,'stage',action_value,'actionRequest',body_value,
   'requestRevision',p.revision,'revision',p.revision+1,'appId',app_value,'authorizationOperationId',credential->>'operationId',
   'originalScopeSha256',p.execution_scope_sha256,'localIdentityScope',app.meta_transition_identity_snapshot(scope_value))),
  'USER',actor_value::text,request_value,1);
 UPDATE public.meta_account_transitions SET execution_operation_id=operation_id,legacy_operation_id=operation_id,revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN app.meta_legacy_action_result(p.id,operation_id,false);
END $$;
ALTER FUNCTION app.request_meta_legacy_migration_action(uuid,uuid,uuid,text,text,text,jsonb,text,boolean) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.request_meta_legacy_migration_action(uuid,uuid,uuid,text,text,text,jsonb,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.request_meta_legacy_migration_action(uuid,uuid,uuid,text,text,text,jsonb,text,boolean) TO wasalx_app;

CREATE FUNCTION app.meta_legacy_migration_view(plan_value uuid,connection_value uuid,actor_value uuid,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;r public.connection_operations;o public.connection_operations;
 c public.connections;slot public.meta_provider_effect_checkpoints;frame jsonb;frames jsonb;reasons jsonb:='[]'::jsonb;
 permitted boolean:=false;current_value boolean:=false;unknown_value boolean;state_value text;pending jsonb;
 credential jsonb;scope_value jsonb;readable boolean:=false;reconcilable boolean:=false;pending_work boolean;
 capability jsonb;authorization_value jsonb;registerable boolean:=false;
BEGIN
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=plan_value
  AND initiating_connection_id=connection_value AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO c FROM public.connections WHERE tenant_id=p.tenant_id AND id=p.initiating_connection_id;
 SELECT * INTO r FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.legacy_review_operation_id;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=p.legacy_operation_id;
 frame:=r.payload#>'{metaLegacyMigration,reviewFrame}';
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='LEGACY_REGISTER';
 pending_work:=EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=p.tenant_id AND connection_id=connection_value
  AND state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE'));
 BEGIN
  PERFORM app.meta_transition_actor_current(actor_value);permitted:=true;
  IF p.reconciled_at IS NOT NULL OR p.state='CANCELLED' THEN current_value:=true;
  ELSE
  IF p.legacy_runtime_receipt_id IS NOT NULL THEN
   capability:=app.meta_legacy_fixture_capability(p.initiating_binding_id,p.legacy_target_binding_id,p.legacy_runtime_receipt_id);
  END IF;
  IF p.execution_scope IS NULL THEN
   frames:=app.meta_template_frames(connection_value,(frame#>>'{target,connectionId}')::uuid,actor_value,app_value);
   current_value:=frames->'source'=frame->'source' AND frames->'target'=frame->'target';
   BEGIN credential:=app.meta_legacy_authorized_credential(p.id);
   EXCEPTION WHEN SQLSTATE '55000' THEN credential:=NULL;reasons:=reasons||'"DESTINATION_ACCESS_EXPIRED"'::jsonb;END;
   registerable:=current_value AND credential IS NOT NULL AND capability IS NOT NULL AND NOT pending_work AND slot.id IS NULL
    AND p.state<>'CANCELLED' AND p.reconciled_at IS NULL AND p.expires_at>clock_timestamp() AND app.meta_legacy_destination_ready(p.id)
    AND app.meta_transition_drained(p.source_account_id,NULL) AND app.meta_transition_drained((capability->>'targetAccountId')::uuid,NULL);
  ELSE
   PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,p.target_account_id]);
   scope_value:=app.meta_transition_scope(p.source_account_id);
   current_value:=app.meta_transition_nonidentity_scope(scope_value)=app.meta_transition_nonidentity_scope(p.execution_scope)
    AND encode(public.digest(app.meta_transition_scope(p.target_account_id)::text,'sha256'),'hex')=p.legacy_target_scope_sha256;
   BEGIN credential:=app.meta_legacy_authorized_credential(p.id);
   EXCEPTION WHEN SQLSTATE '55000' THEN credential:=NULL;reasons:=reasons||'"DESTINATION_ACCESS_EXPIRED"'::jsonb;END;
   readable:=current_value AND credential IS NOT NULL AND slot.id IS NOT NULL
    AND slot.outcome<>'REJECTED' AND NOT pending_work AND p.state<>'CANCELLED' AND p.reconciled_at IS NULL;
   reconcilable:=current_value AND credential IS NOT NULL AND slot.outcome='SUCCEEDED' AND NOT pending_work
    AND p.state<>'CANCELLED' AND p.reconciled_at IS NULL AND app.meta_transition_drained(p.source_account_id,NULL)
    AND app.meta_transition_drained(p.target_account_id,NULL) AND app.meta_legacy_destination_ready(p.id);
  END IF;
  IF p.state<>'CANCELLED' AND p.reconciled_at IS NULL THEN
   BEGIN
    PERFORM app.meta_legacy_authorization_target(p.id,connection_value,actor_value);
    authorization_value:=jsonb_build_object('targetConnectionId',connection_value,'targetLegacyMigrationId',p.id,
     'canPrepare',NOT pending_work,'canContinue',true);
   EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '55000' OR lock_not_available THEN authorization_value:=NULL;END;
  END IF;
  IF current_value AND authorization_value IS NOT NULL AND credential IS NULL THEN
   reasons:=reasons||'"DESTINATION_AUTHORIZATION_REQUIRED"'::jsonb;END IF;
  END IF;
 EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '55000' OR lock_not_available THEN
  current_value:=false;readable:=false;reconcilable:=false;registerable:=false;authorization_value:=NULL;
 END;
 unknown_value:=COALESCE(slot.outcome IN('ATTEMPTED','UNKNOWN'),false);
 IF NOT permitted THEN reasons:=reasons||'"CURRENT_PERMISSION_REQUIRED"'::jsonb;END IF;
 IF NOT current_value THEN reasons:=reasons||'"CURRENT_SCOPE_CHANGED"'::jsonb;END IF;
 IF capability IS NULL AND p.execution_scope IS NULL AND p.reconciled_at IS NULL AND p.state<>'CANCELLED' THEN reasons:=reasons||'"LEGACY_PROVIDER_CONTRACT_UNAVAILABLE"'::jsonb;END IF;
 IF capability IS NULL AND p.execution_scope IS NULL AND p.requested_mode='CUSTOMER' AND p.reconciled_at IS NULL AND p.state<>'CANCELLED' THEN reasons:=reasons||'"CUSTOMER_TRANSFER_CONTRACT_UNAVAILABLE"'::jsonb;END IF;
 IF unknown_value THEN reasons:=reasons||'"PROVIDER_OUTCOME_UNRESOLVED"'::jsonb;END IF;
 IF slot.outcome='REJECTED' THEN reasons:=reasons||'"REGISTRATION_REJECTED"'::jsonb;END IF;
 state_value:=CASE WHEN p.state='CANCELLED' THEN 'CANCELLED' WHEN p.reconciled_at IS NOT NULL THEN 'RECONCILED_PAUSED'
  WHEN unknown_value THEN 'OUTCOME_UNKNOWN' WHEN NOT current_value THEN 'HELD'
  WHEN registerable THEN 'READY' WHEN slot.id IS NULL AND capability IS NOT NULL AND credential IS NULL THEN 'AUTHORIZATION_REQUIRED'
  ELSE p.legacy_state END;
 IF o.requested_by_id=actor_value::text AND o.payload#>>'{metaLegacyMigration,stage}' IN('OBSERVE','REGISTER','RECONCILE') THEN
  pending:=app.meta_legacy_action_result(p.id,o.id,false)->'pendingAction';END IF;
 RETURN jsonb_build_object('id',p.id,'revision',p.revision,'sourceConnection',jsonb_build_object('id',c.id,'name',c.name),
  'destinationAccount',jsonb_build_object('label',NULL,'paymentResponsibility',p.requested_mode),'state',state_value,
  'reviewSha256',r.payload#>>'{metaLegacyMigration,reviewSha256}','expiresAt',CASE WHEN p.execution_scope IS NULL THEN p.expires_at ELSE NULL END,'reasons',reasons,
  'capability',jsonb_build_object('live',false,'qualificationOnly',capability IS NOT NULL),
  'impact',jsonb_build_object('sourceConnections',jsonb_array_length(frame#>'{source,scope}'),
   'destinationConnections',jsonb_array_length(frame#>'{target,scope}'),'inheritedFlowVersions',jsonb_array_length(frame#>'{source,flows}'),
   'templates',(SELECT jsonb_array_length(result#>'{metaTemplatePreparation,observation,dependencies}') FROM public.connection_operations
    WHERE tenant_id=p.tenant_id AND id=p.legacy_template_operation_id),'keepsOriginalHistory',true,'result','PAUSED'),
  'authorization',authorization_value,'actions',jsonb_build_object('observe',readable,'register',registerable,'reconcile',reconcilable,
   'cancel',permitted AND p.state<>'CANCELLED' AND (slot.id IS NULL OR slot.outcome='REJECTED') AND p.reconciled_at IS NULL),
  'originalRegistration',CASE WHEN slot.id IS NULL THEN NULL ELSE jsonb_build_object('outcome',slot.outcome,'attemptedAt',slot.attempted_at) END,
  'pendingAction',pending);
END $$;
ALTER FUNCTION app.meta_legacy_migration_view(uuid,uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_migration_view(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_migration_view(uuid,uuid,uuid,text) TO wasalx_app;

CREATE FUNCTION app.meta_legacy_migration_page(connection_value uuid,actor_value uuid,app_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;template_plan public.meta_account_transitions;frames jsonb;prepare_value jsonb;
BEGIN
 PERFORM 1 FROM public.connections WHERE tenant_id=app.current_tenant_id() AND id=connection_value AND provider='META';
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id()
  AND initiating_connection_id=connection_value AND transition_kind='LEGACY_PHONE' ORDER BY created_at DESC LIMIT 1;
 IF p.id IS NULL OR p.state='CANCELLED' OR p.reconciled_at IS NOT NULL THEN
  SELECT * INTO template_plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id()
   AND initiating_connection_id=connection_value AND transition_kind='TEMPLATE_PREPARATION' AND state<>'CANCELLED'
   AND template_state='READY' ORDER BY created_at DESC LIMIT 1;
  IF template_plan.id IS NOT NULL THEN
   BEGIN
    frames:=app.meta_legacy_preparation_frame(connection_value,actor_value,app_value,
     (template_plan.template_observation->>'observationOperationId')::uuid);
    prepare_value:=jsonb_build_object('templateObservationOperationId',frames->>'templateObservationOperationId',
     'sourceBindingRevision',(frames#>>'{source,bindingRevision}')::bigint,'targetBindingRevision',(frames#>>'{target,bindingRevision}')::bigint);
   EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '55000' OR lock_not_available THEN prepare_value:=NULL;
   END;
  END IF;
 END IF;
 RETURN jsonb_build_object('prepare',prepare_value,'currentPlan',CASE WHEN p.id IS NULL THEN NULL
  ELSE app.meta_legacy_migration_view(p.id,connection_value,actor_value,app_value) END);
END $$;
ALTER FUNCTION app.meta_legacy_migration_page(uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_migration_page(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_migration_page(uuid,uuid,text) TO wasalx_app;


-- Fragment: META_LEGACY_SUCCESSOR_CONTEXT.sql
-- Only the original synthetic same-phone registration can create this lineage.
-- Historical validity never depends on today's runtime/token expiry.

CREATE FUNCTION app.meta_legacy_original_register_valid(plan_value uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM public.meta_account_transitions p
 JOIN public.meta_provider_effect_checkpoints slot ON slot.tenant_id=p.tenant_id AND slot.owner_kind='ACCOUNT_TRANSITION'
  AND slot.owner_id=p.id AND slot.stage='LEGACY_REGISTER'
 JOIN public.connection_operations original ON original.tenant_id=p.tenant_id AND original.id=slot.original_operation_id
 JOIN public.meta_connection_account_bindings source ON source.tenant_id=p.tenant_id AND source.id=p.initiating_binding_id
 JOIN public.meta_messaging_accounts source_account ON source_account.tenant_id=p.tenant_id AND source_account.id=p.source_account_id
 JOIN public.meta_messaging_accounts target_account ON target_account.tenant_id=p.tenant_id AND target_account.id=p.target_account_id
 JOIN public.platform_operations_audit_events runtime ON runtime.id=p.legacy_runtime_receipt_id
 WHERE p.tenant_id=app.current_tenant_id() AND p.id=plan_value AND p.transition_kind='LEGACY_PHONE'
  AND p.provider_migration_id IS NULL AND p.provider_status IS NULL
  AND slot.account_id=p.target_account_id AND slot.outcome='SUCCEEDED'
  AND slot.result='{"registered":true}'::jsonb
  AND slot.result_sha256=encode(public.digest(slot.result::text,'sha256'),'hex')
  AND slot.runtime_execution->>'mode'='SIMULATED'
  AND slot.runtime_execution->>'runtimeEvidenceReceiptId'=runtime.id::text
  AND original.operation_type='EXECUTE_META_ACCOUNT_TRANSITION' AND original.connection_id=p.initiating_connection_id
  AND original.payload#>>'{metaLegacyMigration,id}'=p.id::text AND original.payload#>>'{metaLegacyMigration,stage}'='REGISTER'
  AND original.payload#>>'{metaLegacyMigration,originalScopeSha256}'=p.execution_scope_sha256
  AND original.payload#>>'{metaLegacyMigration,runtimeEvidenceReceiptId}'=runtime.id::text
  AND original.payload#>>'{metaLegacyMigration,fixtureSha256}'=runtime.safe_metadata#>>'{legacyMigration,fixtureSha256}'
  AND runtime.action='meta.runtime.simulated.registered'
  AND runtime.safe_metadata#>>'{legacyMigration,schemaVersion}'='1'
  AND runtime.safe_metadata#>>'{legacyMigration,claim}'='SYNTHETIC_LEGACY_SAME_PHONE'
  AND runtime.safe_metadata#>>'{legacyMigration,tenantId}'=p.tenant_id::text
  AND runtime.safe_metadata#>>'{legacyMigration,sourceAccountId}'=p.source_account_id::text
  AND runtime.safe_metadata#>>'{legacyMigration,targetAccountId}'=p.target_account_id::text
  AND runtime.safe_metadata#>>'{legacyMigration,sourceProviderAccountId}'=source_account.provider_account_id
  AND runtime.safe_metadata#>>'{legacyMigration,targetProviderAccountId}'=target_account.provider_account_id
  AND runtime.safe_metadata#>>'{legacyMigration,phoneId}'=source.phone_number_id
  AND runtime.safe_metadata#>>'{legacyMigration,appId}'=source.app_id
  AND runtime.safe_metadata#>>'{legacyMigration,graphVersion}'='v24.0'
  AND source.account_id=p.source_account_id AND source.connection_id=p.initiating_connection_id
  AND source_account.provider_account_id<>target_account.provider_account_id)
$$;
ALTER FUNCTION app.meta_legacy_original_register_valid(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_original_register_valid(uuid) FROM PUBLIC;

-- Invoker predicate, also used by binding and alias guards. Runtime callers
-- return before protected relations are planned; there is no caller flag.
CREATE FUNCTION app.meta_legacy_successor_pending(plan_value uuid,sealed_value boolean) RETURNS boolean
 LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF current_user<>'wasalx_meta_transition_executor'
  OR NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.meta_account_transitions p
  JOIN public.connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id AND o.id=p.legacy_operation_id
  JOIN public.tenants tenant ON tenant.id=p.tenant_id
  JOIN public.tenant_memberships member ON member.tenant_id=p.tenant_id AND member.user_id::text=o.requested_by_id
  WHERE p.tenant_id=app.current_tenant_id() AND p.id=plan_value AND p.transition_kind='LEGACY_PHONE'
   AND p.state<>'CANCELLED' AND p.execution_state=CASE WHEN sealed_value THEN 'RECONCILED_PAUSED' ELSE 'RESERVED' END
   AND (p.identity_successor_receipt IS NOT NULL)=sealed_value
   AND o.operation_type='EXECUTE_META_ACCOUNT_TRANSITION' AND o.state='RUNNING' AND o.result IS NULL
   AND o.lease_id IS NOT NULL AND o.lease_expires_at>clock_timestamp()
   AND o.payload#>>'{metaLegacyMigration,id}'=p.id::text AND o.payload#>>'{metaLegacyMigration,stage}'='RECONCILE'
   AND o.payload#>>'{metaLegacyMigration,revision}'=(p.revision-CASE WHEN sealed_value THEN 1 ELSE 0 END)::text
   AND o.payload#>>'{metaLegacyMigration,originalScopeSha256}'=p.execution_scope_sha256
   AND o.payload#>>'{metaLegacyMigration,authorizationOperationId}'=p.legacy_authorization_operation_id::text
   AND jsonb_typeof(o.payload#>'{metaLegacyMigration,localIdentityScope}')='array'
   AND tenant.state='ACTIVE' AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin')
   AND app.meta_legacy_original_register_valid(p.id)
   AND 2=(SELECT count(*) FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id
    AND r.transition_id=p.id AND r.released_at IS NULL AND
     ((r.account_role='SOURCE' AND r.account_id=p.source_account_id AND r.scope_sha256=p.execution_scope_sha256)
      OR(r.account_role='TARGET' AND r.account_id=p.target_account_id AND r.scope_sha256=p.legacy_target_scope_sha256))));
END $$;
REVOKE ALL ON FUNCTION app.meta_legacy_successor_pending(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_legacy_successor_pending(uuid,boolean) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;


-- Fragment: META_LEGACY_TEMPLATE_SEND.sql
-- Private WIP companion. Birth remains the incumbent immutable P08 snapshot;
-- a receipt is added to the existing exact attempt, not a new effect ledger.

ALTER TABLE public.meta_connection_account_bindings ADD COLUMN template_mapping_operation_id uuid,
 ADD FOREIGN KEY(tenant_id,template_mapping_operation_id) REFERENCES public.connection_operations(tenant_id,id);
ALTER TABLE public.delivery_attempts ADD COLUMN meta_template_admission jsonb,
 ADD CONSTRAINT meta_template_admission_object CHECK(meta_template_admission IS NULL OR jsonb_typeof(meta_template_admission)='object');
-- Exact tenant-RLS dependency of the existing invoker privacy predicate.
GRANT SELECT(tenant_id,delivery_id,zammad_ticket_id) ON public.delivery_ticket_links TO wasalx_meta_transition_executor;
GRANT SELECT ON public.delivery_attempts TO wasalx_meta_transition_executor;
GRANT UPDATE(meta_template_admission) ON public.delivery_attempts TO wasalx_meta_transition_executor;
GRANT EXECUTE ON FUNCTION app.delivery_has_active_privacy_target(uuid),app.meta_direct_privacy_target_authorized(text,text)
 TO wasalx_meta_transition_executor;

CREATE FUNCTION app.preserve_meta_template_mapping_reference() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE p public.meta_account_transitions;observation public.connection_operations;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.template_mapping_operation_id IS DISTINCT FROM OLD.template_mapping_operation_id THEN
   RAISE EXCEPTION 'Original template mapping is immutable' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF NEW.template_mapping_operation_id IS NULL THEN
  IF NEW.account_transition_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.meta_account_transitions
   WHERE tenant_id=NEW.tenant_id AND id=NEW.account_transition_id AND transition_kind='LEGACY_PHONE') THEN
   RAISE EXCEPTION 'Legacy successor requires its original template mapping' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=NEW.tenant_id AND id=NEW.account_transition_id AND transition_kind='LEGACY_PHONE';
 SELECT * INTO observation FROM public.connection_operations WHERE tenant_id=NEW.tenant_id AND id=NEW.template_mapping_operation_id;
 IF current_user<>'wasalx_meta_transition_executor' OR p.id IS NULL OR NEW.predecessor_binding_id IS DISTINCT FROM p.initiating_binding_id
  OR NEW.connection_id<>p.initiating_connection_id OR NEW.account_id IS DISTINCT FROM p.target_account_id OR NEW.state<>'HELD'
  OR observation.id IS DISTINCT FROM p.execution_operation_id
  OR observation.state IS DISTINCT FROM 'RUNNING' OR observation.result IS NOT NULL
  OR observation.payload#>>'{metaLegacyMigration,stage}' IS DISTINCT FROM 'RECONCILE'
  OR NOT app.meta_legacy_successor_pending(p.id,false) THEN
  RAISE EXCEPTION 'Original template mapping is unavailable' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_template_mapping_reference BEFORE INSERT OR UPDATE ON public.meta_connection_account_bindings
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_template_mapping_reference();
REVOKE ALL ON FUNCTION app.preserve_meta_template_mapping_reference() FROM PUBLIC;

CREATE FUNCTION app.meta_inherited_template_send_context(delivery_value uuid,lease_value uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE d public.delivery_outbox;b public.meta_connection_account_bindings;a public.meta_messaging_accounts;
 p public.meta_account_transitions;o public.connection_operations;conversation public.bot_conversations;
 ctx jsonb;mapping jsonb;item jsonb;count_value integer;template_value jsonb;flow_value uuid;safety_value bigint;
BEGIN
 SELECT * INTO d FROM public.delivery_outbox WHERE tenant_id=app.current_tenant_id() AND id=delivery_value;
 IF d.id IS NULL OR d.state<>'SENDING' OR d.lease_id IS DISTINCT FROM lease_value OR d.lease_expires_at<=clock_timestamp()
  OR d.content_redacted_at IS NOT NULL OR app.delivery_has_active_privacy_target(d.id) THEN
  RAISE EXCEPTION 'Current template delivery is unavailable' USING ERRCODE='55000';END IF;
 PERFORM 1 FROM public.connections WHERE tenant_id=d.tenant_id AND id=d.connection_id FOR SHARE;
 SELECT * INTO b FROM public.meta_connection_account_bindings WHERE tenant_id=d.tenant_id AND connection_id=d.connection_id AND state='ACTIVE' FOR SHARE;
 IF b.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=d.tenant_id AND id=b.account_transition_id AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL THEN RETURN NULL;END IF;
 -- A pre-cutover queued birth never adopts a successor account, even if no
 -- template is present. The normal billing/identity guards still run as well.
 IF d.meta_billing_snapshot->>'bindingId' IS DISTINCT FROM b.id::text
  OR d.meta_billing_snapshot->>'accountId' IS DISTINCT FROM b.account_id::text
  OR d.meta_billing_snapshot->>'bindingRevision' IS DISTINCT FROM b.revision::text
  OR p.execution_state<>'RECONCILED_PAUSED' OR p.reconciled_at IS NULL OR b.template_mapping_operation_id IS NULL THEN
  RAISE EXCEPTION 'Original delivery account cannot be changed' USING ERRCODE='55000';END IF;
 IF d.bot_content->>'type' IS DISTINCT FROM 'template' THEN RETURN NULL;END IF;
 SELECT * INTO conversation FROM public.bot_conversations WHERE tenant_id=d.tenant_id AND id=d.bot_conversation_id AND connection_id=d.connection_id;
 IF conversation.id IS NULL THEN RAISE EXCEPTION 'Template flow origin is unavailable' USING ERRCODE='55000';END IF;
 flow_value:=conversation.flow_version_id;
 -- Versions published after the transition use the ordinary target account
 -- contract. They never acquire an inherited mapping by a matching name.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.execution_scope->'flows') f WHERE f->>'id'=flow_value::text) THEN RETURN NULL;END IF;
 SELECT * INTO a FROM public.meta_messaging_accounts WHERE tenant_id=d.tenant_id AND id=b.account_id FOR SHARE;
 -- Materialize generation zero so the final transaction can hold the exact
 -- safety row against signed invalidation through the Messages admission stamp.
 -- An account SHARE lock alone does not serialize another SHARE-lock ingress.
 INSERT INTO public.meta_template_account_safety(tenant_id,account_id) VALUES(a.tenant_id,a.id) ON CONFLICT DO NOTHING;
 SELECT revision INTO safety_value FROM public.meta_template_account_safety
  WHERE tenant_id=a.tenant_id AND account_id=a.id FOR SHARE;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=d.tenant_id AND id=b.template_mapping_operation_id AND state='SUCCEEDED';
 mapping:=o.result#>'{metaLegacyMigration,templateMapping}';
 IF o.id IS NULL OR o.result#>>'{metaLegacyMigration,originalOutcome}' IS DISTINCT FROM 'SUCCEEDED'
  OR mapping->>'claim' IS DISTINCT FROM 'EXACT_TEMPLATE_SEMANTICS'
  OR mapping->>'targetAccountId' IS DISTINCT FROM a.provider_account_id THEN
  RAISE EXCEPTION 'Inherited template mapping is unavailable' USING ERRCODE='55000';END IF;
 template_value:=d.bot_content;
 IF jsonb_typeof(template_value->'bodyParameters') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Original template parameters are unavailable' USING ERRCODE='55000';END IF;
 SELECT count(*),min(x::text)::jsonb INTO count_value,item FROM jsonb_array_elements(mapping->'mappings') x
  WHERE x->>'flowVersionId'=flow_value::text AND x->>'name'=template_value->>'name'
   AND x->>'language'=template_value->>'languageCode'
   AND (x->>'parameterCount')::integer=jsonb_array_length(template_value->'bodyParameters');
 IF count_value<>1 THEN RAISE EXCEPTION 'Inherited template needs an explicit mapping' USING ERRCODE='55000';END IF;
 ctx:=jsonb_build_object('schemaVersion',1,'claim','INHERITED_TEMPLATE_SEND','transitionId',p.id,
  'mappingOperationId',o.id,'bindingId',b.id,'bindingRevision',b.revision,'providerAccountId',a.provider_account_id,
  'phoneId',b.phone_number_id,'flowVersionId',flow_value,'targetSafetyRevision',safety_value,
  'mapping',mapping,'template',jsonb_build_object('name',template_value->>'name','languageCode',template_value->>'languageCode',
   'parameterCount',jsonb_array_length(template_value->'bodyParameters')));
 RETURN ctx||jsonb_build_object('contextSha256',encode(public.digest(ctx::text,'sha256'),'hex'));
END $$;
ALTER FUNCTION app.meta_inherited_template_send_context(uuid,uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_inherited_template_send_context(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_inherited_template_send_context(uuid,uuid) TO wasalx_connector_worker;

CREATE FUNCTION app.record_meta_inherited_template_admission(delivery_value uuid,lease_value uuid,request_sha text,proof_value jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE ctx jsonb;d public.delivery_outbox;attempt public.delivery_attempts;entry_value jsonb;receipt jsonb;
BEGIN
 ctx:=app.meta_inherited_template_send_context(delivery_value,lease_value);
 IF ctx IS NULL THEN
  IF proof_value IS NOT NULL THEN RAISE EXCEPTION 'Unexpected template mapping proof' USING ERRCODE='23514';END IF;
  RETURN true;
 END IF;
 IF jsonb_typeof(proof_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(proof_value))<>12
  OR proof_value->>'schemaVersion' IS DISTINCT FROM '1' OR proof_value->>'claim' IS DISTINCT FROM 'CURRENT_INHERITED_TEMPLATE'
  OR proof_value->>'contextSha256' IS DISTINCT FROM ctx->>'contextSha256'
  OR proof_value->>'transitionId' IS DISTINCT FROM ctx->>'transitionId' OR proof_value->>'mappingOperationId' IS DISTINCT FROM ctx->>'mappingOperationId'
  OR proof_value->>'bindingId' IS DISTINCT FROM ctx->>'bindingId' OR proof_value->>'bindingRevision' IS DISTINCT FROM ctx->>'bindingRevision'
  OR proof_value->>'targetSafetyRevision' IS DISTINCT FROM ctx->>'targetSafetyRevision'
  OR COALESCE(proof_value->>'inventoryResponseSha256','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(request_sha,'') !~ '^[a-f0-9]{64}$'
  OR proof_value->>'observedAt' IS NULL OR (proof_value->>'observedAt')::timestamptz>clock_timestamp()
  OR (proof_value->>'observedAt')::timestamptz<clock_timestamp()-interval '2 minutes' THEN
  RAISE EXCEPTION 'Fresh inherited template proof is unavailable' USING ERRCODE='55000';END IF;
 SELECT x INTO entry_value FROM jsonb_array_elements(ctx#>'{mapping,mappings}') x WHERE x->>'flowVersionId'=ctx->>'flowVersionId'
  AND x->>'name'=ctx#>>'{template,name}' AND x->>'language'=ctx#>>'{template,languageCode}'
  AND x->>'parameterCount'=ctx#>>'{template,parameterCount}';
 IF entry_value IS NULL OR proof_value->>'targetTemplateId' IS DISTINCT FROM entry_value->>'targetTemplateId'
  OR proof_value->>'semanticSha256' IS DISTINCT FROM entry_value->>'semanticSha256' THEN
  RAISE EXCEPTION 'Inherited template identity changed' USING ERRCODE='55000';END IF;
 SELECT * INTO d FROM public.delivery_outbox WHERE tenant_id=app.current_tenant_id() AND id=delivery_value FOR UPDATE;
 SELECT * INTO attempt FROM public.delivery_attempts WHERE tenant_id=d.tenant_id AND delivery_id=d.id AND attempt_number=d.attempts FOR UPDATE;
 IF attempt.id IS NULL OR attempt.state<>'SENDING' OR attempt.finished_at IS NOT NULL OR attempt.meta_template_admission IS NOT NULL
  OR attempt.meta_billing_admission->>'requestSha256' IS DISTINCT FROM request_sha
  OR attempt.meta_billing_admission->>'attemptId' IS DISTINCT FROM attempt.id::text
  OR attempt.meta_billing_admission->>'deliveryId' IS DISTINCT FROM d.id::text THEN
  RAISE EXCEPTION 'Original message admission is unavailable' USING ERRCODE='55000';END IF;
 receipt:=proof_value||jsonb_build_object('attemptId',attempt.id,'deliveryId',d.id,'attemptNumber',attempt.attempt_number,'requestSha256',request_sha);
 UPDATE public.delivery_attempts SET meta_template_admission=receipt WHERE tenant_id=attempt.tenant_id AND id=attempt.id;
 RETURN true;
END $$;
ALTER FUNCTION app.record_meta_inherited_template_admission(uuid,uuid,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.record_meta_inherited_template_admission(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_inherited_template_admission(uuid,uuid,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.preserve_meta_template_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.meta_template_admission IS NOT NULL THEN RAISE EXCEPTION 'Template request proof is admitted later' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF OLD.meta_template_admission IS NOT DISTINCT FROM NEW.meta_template_admission THEN RETURN NEW;END IF;
 IF OLD.meta_template_admission IS NULL AND NEW.meta_template_admission IS NOT NULL AND current_user='wasalx_meta_transition_executor'
  AND NEW.state='SENDING' AND NEW.finished_at IS NULL THEN RETURN NEW;END IF;
 IF OLD.meta_template_admission IS NOT NULL
  AND NEW.meta_template_admission=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.meta_template_admission::text,'sha256'),'hex'))
  AND app.meta_direct_privacy_target_authorized('DELIVERY',OLD.delivery_id::text)
  AND EXISTS(SELECT 1 FROM public.delivery_outbox d WHERE d.tenant_id=OLD.tenant_id AND d.id=OLD.delivery_id
   AND d.state NOT IN('SENDING','OUTCOME_UNKNOWN') AND NOT(d.state='CLAIMED' AND d.lease_expires_at>=clock_timestamp())) THEN RETURN NEW;END IF;
 RAISE EXCEPTION 'Original template admission is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER meta_template_attempt_admission BEFORE INSERT OR UPDATE OF meta_template_admission ON public.delivery_attempts
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_template_admission();
REVOKE ALL ON FUNCTION app.preserve_meta_template_admission() FROM PUBLIC;

CREATE FUNCTION app.redact_meta_template_admissions(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE count_value integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||app.current_tenant_id()::text,0));
 IF NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value
  AND job_type='DELETE' AND state='RUNNING' AND stage='LOCAL' AND lease_id=lease_value AND fencing_token=fence_value
  AND lease_expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Current local privacy authority is required' USING ERRCODE='42501';END IF;
 UPDATE public.delivery_attempts a SET meta_template_admission=jsonb_build_object('redacted',true,'sha256',
  encode(public.digest(a.meta_template_admission::text,'sha256'),'hex'))
 FROM public.delivery_outbox d WHERE d.tenant_id=app.current_tenant_id() AND a.tenant_id=d.tenant_id AND a.delivery_id=d.id
  AND a.meta_template_admission IS NOT NULL AND NOT(a.meta_template_admission ? 'redacted')
  AND d.state NOT IN('SENDING','OUTCOME_UNKNOWN') AND NOT(d.state='CLAIMED' AND d.lease_expires_at>=clock_timestamp())
  AND app.meta_direct_privacy_target_authorized('DELIVERY',d.id::text);
 GET DIAGNOSTICS count_value=ROW_COUNT;
 RETURN count_value;
END $$;
ALTER FUNCTION app.redact_meta_template_admissions(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.redact_meta_template_admissions(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redact_meta_template_admissions(uuid,uuid,bigint) TO wasalx_connector_worker;


-- Fragment: META_LEGACY_IDENTITY_SUCCESSOR.sql
-- Extends the existing sealed lineage with a distinct, synthetic-only legacy receipt.


CREATE OR REPLACE FUNCTION app.meta_account_identity_receipt_valid(transition_value uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE plan public.meta_account_transitions; receipt jsonb; observation jsonb;
 initiate public.meta_provider_effect_checkpoints; complete public.meta_provider_effect_checkpoints;
 pair jsonb; predecessor public.meta_connection_account_bindings; successor public.meta_connection_account_bindings;
 source_account text;target_account text;legacy boolean;legacy_slot public.meta_provider_effect_checkpoints;legacy_operation public.connection_operations;
BEGIN
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value;
 legacy:=plan.transition_kind='LEGACY_PHONE';
 receipt:=plan.identity_successor_receipt;
 IF plan.id IS NULL OR plan.execution_state<>'RECONCILED_PAUSED' OR plan.reconciled_at IS NULL
  OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>4194304
  OR receipt->'schemaVersion' IS DISTINCT FROM '1' OR receipt->>'claim' IS DISTINCT FROM
   (CASE WHEN legacy THEN 'SAME_GRAPH_PHONE_LEGACY_SUCCESSOR' ELSE 'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR' END)
  OR receipt->>'transitionId' IS DISTINCT FROM plan.id::text
  OR receipt->>'sourceAccountId' IS DISTINCT FROM plan.source_account_id::text
  OR receipt->>'targetAccountId' IS DISTINCT FROM plan.target_account_id::text
  OR receipt->>'migrationId' IS DISTINCT FROM plan.provider_migration_id
  OR receipt->>'sourceScopeSha256' IS DISTINCT FROM plan.execution_scope_sha256
  OR receipt->>'completionObservationOperationId' IS DISTINCT FROM
   (CASE WHEN legacy THEN plan.legacy_readback_operation_id ELSE plan.provider_observation_operation_id END)::text
  OR receipt->>'operationId' IS DISTINCT FROM plan.execution_operation_id::text
  OR jsonb_typeof(receipt->'assets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(receipt->'assets') NOT BETWEEN 1 AND 2000
  OR receipt-ARRAY['schemaVersion','claim','transitionId','operationId','sourceAccountId','targetAccountId','migrationId',
     'initiateCheckpointId','completeCheckpointId','completionObservationOperationId','sourceScopeSha256','targetProofSha256','assets','appliedAt',
     'registrationCheckpointId','authorizationOperationId']<>'{}'
 THEN RETURN false; END IF;
 SELECT * INTO initiate FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='INITIATE';
 SELECT * INTO complete FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='COMPLETE';
 SELECT result->'metaTransitionObservation' INTO observation FROM public.connection_operations
  WHERE tenant_id=plan.tenant_id AND id=plan.provider_observation_operation_id;
 SELECT provider_account_id INTO source_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.source_account_id;
 SELECT provider_account_id INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.target_account_id;
 IF legacy THEN
  SELECT * INTO legacy_slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
   AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='LEGACY_REGISTER';
  SELECT * INTO legacy_operation FROM public.connection_operations WHERE tenant_id=plan.tenant_id AND id=plan.legacy_readback_operation_id;
  IF NOT app.meta_legacy_original_register_valid(plan.id) OR legacy_operation.id IS DISTINCT FROM plan.execution_operation_id
   OR receipt->>'registrationCheckpointId' IS DISTINCT FROM legacy_slot.id::text
   OR receipt->>'authorizationOperationId' IS DISTINCT FROM legacy_operation.payload#>>'{metaLegacyMigration,authorizationOperationId}'
   OR receipt->>'initiateCheckpointId' IS NOT NULL OR receipt->>'completeCheckpointId' IS NOT NULL
   OR receipt->>'migrationId' IS NOT NULL OR jsonb_array_length(receipt->'assets')<>1
   OR receipt#>>'{assets,0,sourceBindingId}' IS DISTINCT FROM plan.initiating_binding_id::text
   OR legacy_operation.payload#>>'{metaLegacyMigration,id}' IS DISTINCT FROM plan.id::text
   OR legacy_operation.payload#>>'{metaLegacyMigration,stage}' IS DISTINCT FROM 'RECONCILE'
   OR legacy_operation.payload#>>'{metaLegacyMigration,originalScopeSha256}' IS DISTINCT FROM plan.execution_scope_sha256 THEN RETURN false;END IF;
  IF legacy_operation.result IS NULL THEN
   -- This receipt is not visible outside the open successor transaction. Only
   -- the current worker's sealed metadata pass can consume it before first result.
   IF NOT app.meta_legacy_successor_pending(plan.id,true) THEN RETURN false;END IF;
  ELSIF receipt->>'targetProofSha256' IS DISTINCT FROM encode(digest((legacy_operation.result#>'{metaLegacySuccessor,targetAssets}')::text,'sha256'),'hex')
   OR legacy_operation.result#>>'{metaLegacyMigration,originalCheckpointId}' IS DISTINCT FROM legacy_slot.id::text
   OR legacy_operation.result#>>'{metaLegacyMigration,originalOutcome}' IS DISTINCT FROM 'SUCCEEDED'
   OR legacy_operation.result#>>'{metaTransitionIdentityReconciliation,status}' IS DISTINCT FROM 'SETTLED' THEN RETURN false;END IF;
 ELSE
 IF receipt ? 'registrationCheckpointId' OR receipt ? 'authorizationOperationId'
  OR plan.provider_migration_id IS NULL OR source_account IS NULL OR target_account IS NULL
  OR initiate.id IS NULL OR complete.id IS NULL OR initiate.outcome='REJECTED' OR complete.outcome='REJECTED'
  OR initiate.account_id IS DISTINCT FROM plan.source_account_id OR complete.account_id IS DISTINCT FROM plan.source_account_id
  OR initiate.result->>'migrationId' IS DISTINCT FROM plan.provider_migration_id
  OR receipt->>'initiateCheckpointId' IS DISTINCT FROM initiate.id::text
  OR receipt->>'completeCheckpointId' IS DISTINCT FROM complete.id::text
  OR observation->>'migrationId' IS DISTINCT FROM plan.provider_migration_id OR observation->>'status' IS DISTINCT FROM 'COMPLETED'
  OR observation#>>'{destination,id}' IS DISTINCT FROM target_account
  OR observation#>>'{destination,currency}' IS DISTINCT FROM plan.target_currency
  OR receipt->>'targetProofSha256' IS DISTINCT FROM encode(digest((observation->'targetAssets')::text,'sha256'),'hex')
  OR jsonb_array_length(receipt->'assets')<>jsonb_array_length(plan.execution_scope->'bindings')
  OR (SELECT count(DISTINCT item->>'connectionId') FROM jsonb_array_elements(receipt->'assets') item)<>jsonb_array_length(receipt->'assets')
  OR NOT EXISTS(SELECT 1 FROM public.connection_operations operation WHERE operation.tenant_id=plan.tenant_id AND operation.id=plan.execution_operation_id
   AND operation.payload#>>'{metaAccountTransitionExecution,id}'=plan.id::text
   AND operation.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
   AND operation.payload#>>'{metaAccountTransitionExecution,scopeSha256}'=plan.execution_scope_sha256)
 THEN RETURN false; END IF;
 END IF;
 IF source_account IS NULL OR target_account IS NULL OR source_account=target_account
  OR (SELECT count(DISTINCT item->>'connectionId') FROM jsonb_array_elements(receipt->'assets') item)<>jsonb_array_length(receipt->'assets') THEN RETURN false;END IF;
 FOR pair IN SELECT value FROM jsonb_array_elements(receipt->'assets') LOOP
  SELECT * INTO predecessor FROM public.meta_connection_account_bindings
   WHERE tenant_id=plan.tenant_id AND id::text=pair->>'sourceBindingId';
  SELECT * INTO successor FROM public.meta_connection_account_bindings
   WHERE tenant_id=plan.tenant_id AND id::text=pair->>'targetBindingId';
  IF predecessor.id IS NULL OR successor.id IS NULL OR predecessor.state<>'RETIRED'
   OR predecessor.account_id IS DISTINCT FROM plan.source_account_id OR successor.account_id IS DISTINCT FROM plan.target_account_id
   OR successor.predecessor_binding_id IS DISTINCT FROM predecessor.id OR successor.account_transition_id IS DISTINCT FROM plan.id
   OR successor.connection_id IS DISTINCT FROM predecessor.connection_id OR pair->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text
   OR successor.phone_number_id IS DISTINCT FROM predecessor.phone_number_id OR successor.app_id IS DISTINCT FROM predecessor.app_id
   OR pair->>'appId' IS DISTINCT FROM predecessor.app_id
   OR pair->'sourceAsset' IS DISTINCT FROM jsonb_build_object('providerSessionId',predecessor.provider_session_id::text,'phoneNumberId',predecessor.phone_number_id,'wabaId',source_account)
   OR pair->'targetAsset' IS DISTINCT FROM jsonb_build_object('providerSessionId',successor.provider_session_id::text,'phoneNumberId',successor.phone_number_id,'wabaId',target_account)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan.execution_scope->'bindings') original
    WHERE original->>'id'=predecessor.id::text AND original->>'revision'=pair->>'sourceRevision'
     AND original->>'connectionId'=predecessor.connection_id::text AND original->>'sessionId'=predecessor.provider_session_id::text
     AND original->>'phoneId'=predecessor.phone_number_id AND original->>'appId'=predecessor.app_id)
   OR COALESCE(pair->>'targetRevision','')!~'^[1-9][0-9]{0,15}$'
   OR successor.revision<(pair->>'targetRevision')::bigint
   OR pair-ARRAY['connectionId','sourceBindingId','sourceRevision','targetBindingId','targetRevision','appId','sourceAsset','targetAsset']<>'{}'
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.meta_account_identity_apply_pending(transition_value uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 -- Runtime callers lack tenant SELECT. Reject them procedurally before the
 -- protected statement is prepared, preserving invoker/RLS semantics.
 IF current_user<>pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc
  WHERE oid='app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint)'::regprocedure))
  OR NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN RETURN false; END IF;
 IF app.meta_legacy_successor_pending(transition_value,false) THEN RETURN true;END IF;
 RETURN (SELECT EXISTS(SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations o
  ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id JOIN public.tenants t ON t.id=p.tenant_id
  JOIN public.tenant_memberships member ON member.tenant_id=p.tenant_id AND member.user_id::text=o.requested_by_id
  WHERE p.tenant_id=app.current_tenant_id() AND p.id=transition_value AND p.identity_successor_receipt IS NULL
   AND p.provider_status='COMPLETED' AND p.state<>'CANCELLED' AND p.execution_state='PROVIDER_COMPLETED'
   AND o.state='RUNNING' AND o.lease_id IS NOT NULL AND o.lease_expires_at>clock_timestamp()
   AND o.payload#>>'{metaAccountTransitionExecution,id}'=p.id::text
   AND o.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
   AND o.payload#>>'{metaAccountTransitionExecution,revision}'=p.revision::text
   AND o.payload#>>'{metaAccountTransitionExecution,scopeSha256}'=p.execution_scope_sha256
   AND o.payload#>'{metaAccountTransitionExecution,observerOperationIds}'=p.observer_operations
   AND t.state='ACTIVE' AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin')
   AND 2=(SELECT count(*) FROM public.meta_account_transition_reservations r WHERE r.tenant_id=p.tenant_id
    AND r.transition_id=p.id AND r.released_at IS NULL AND r.scope_sha256=p.execution_scope_sha256
    AND ((r.account_role='SOURCE' AND r.account_id=p.source_account_id) OR(r.account_role='TARGET' AND r.account_id=p.target_account_id)))));
END;
$$;

CREATE FUNCTION app.apply_meta_account_identity_successor(transition_value uuid,operation_value uuid,lease_value uuid,fence_value bigint,legacy_observation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE plan public.meta_account_transitions; operation_row public.connection_operations;
 initiate public.meta_provider_effect_checkpoints; complete public.meta_provider_effect_checkpoints;
 predecessor public.meta_connection_account_bindings; successor public.meta_connection_account_bindings;
 session_row public.provider_sessions; connection_row public.connections; alias_row public.meta_direct_identity_aliases;
 source_account text;target_account text;observation jsonb;original jsonb;verified jsonb;proof jsonb;receipt jsonb;pairs jsonb:='[]';
 source_asset jsonb;target_asset jsonb;subject record;customer text;customers integer;scope_value jsonb;values_value text[];local_scope jsonb;local_digest text;
 observer jsonb;observer_operation uuid;expected_reference text;expected_fingerprint text;credential_metadata jsonb;
 legacy boolean;legacy_slot public.meta_provider_effect_checkpoints;
BEGIN
 -- A repeated sealed call is historical and cannot append aliases to a later
 -- account/session. It does not acquire a new lease or restore authority.
 IF NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
  RAISE EXCEPTION 'Account identity succession is worker-only' USING ERRCODE='42501'; END IF;
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value;
 legacy:=plan.transition_kind='LEGACY_PHONE';
 IF (legacy_observation IS NOT NULL) IS DISTINCT FROM legacy THEN RAISE EXCEPTION 'Typed successor proof is unavailable' USING ERRCODE='23514';END IF;
 IF plan.identity_successor_receipt IS NOT NULL THEN
  IF app.meta_account_identity_receipt_valid(plan.id) AND plan.identity_successor_receipt->>'operationId'=operation_value::text THEN
   RETURN plan.identity_successor_receipt;
  END IF;
  RAISE EXCEPTION 'Account identity successor is already sealed' USING ERRCODE='55000';
 END IF;
 IF NOT app.lock_current_active_tenant_for_event_admission()
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Account identity privacy or tenant is unavailable' USING ERRCODE='55000'; END IF;
 IF plan.id IS NULL THEN RAISE EXCEPTION 'Account identity transition is unavailable' USING ERRCODE='55000'; END IF;
 PERFORM app.lock_meta_transition_accounts(ARRAY[plan.source_account_id,plan.target_account_id]);
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value FOR UPDATE NOWAIT;
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=plan.tenant_id AND id=operation_value FOR UPDATE NOWAIT;
 IF operation_row.id IS NULL OR operation_row.id IS DISTINCT FROM plan.execution_operation_id
  OR operation_row.lease_id IS DISTINCT FROM lease_value OR operation_row.fencing_token IS DISTINCT FROM fence_value
  OR (NOT legacy AND operation_row.payload#>'{metaAccountTransitionExecution,observerOperationIds}' IS DISTINCT FROM plan.observer_operations)
  OR NOT app.meta_account_identity_apply_pending(plan.id) THEN
  RAISE EXCEPTION 'Account identity lease or original reservation changed' USING ERRCODE='55000'; END IF;
 PERFORM app.meta_transition_actor_current(operation_row.requested_by_id::uuid);
 local_scope:=CASE WHEN legacy THEN operation_row.payload#>'{metaLegacyMigration,localIdentityScope}' ELSE operation_row.payload#>'{metaAccountTransitionExecution,localIdentityScope}' END;
 IF jsonb_typeof(local_scope) IS DISTINCT FROM 'array' OR jsonb_array_length(local_scope)<>jsonb_array_length(plan.execution_scope->'bindings')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(local_scope) item WHERE item-ARRAY['bindingId','identitySha256']<>'{}'
   OR COALESCE(item->>'identitySha256','')!~'^[0-9a-f]{64}$'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(plan.execution_scope->'bindings') original_binding WHERE original_binding->>'id'=item->>'bindingId'))
  OR (SELECT count(DISTINCT item->>'bindingId') FROM jsonb_array_elements(local_scope) item)<>jsonb_array_length(local_scope) THEN
  RAISE EXCEPTION 'Explicit local identity reconciliation scope is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO initiate FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='INITIATE' FOR SHARE NOWAIT;
 SELECT * INTO complete FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='COMPLETE' FOR SHARE NOWAIT;
 SELECT result->'metaTransitionObservation' INTO observation FROM public.connection_operations
  WHERE tenant_id=plan.tenant_id AND id=plan.provider_observation_operation_id FOR SHARE NOWAIT;
 SELECT provider_account_id INTO source_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.source_account_id;
 SELECT provider_account_id INTO target_account FROM public.meta_messaging_accounts WHERE tenant_id=plan.tenant_id AND id=plan.target_account_id;
 IF legacy THEN
  SELECT * INTO legacy_slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=plan.tenant_id
   AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=plan.id AND stage='LEGACY_REGISTER' FOR SHARE NOWAIT;
  observation:=legacy_observation;
  IF NOT app.meta_legacy_successor_pending(plan.id,false) OR source_account IS NULL OR target_account IS NULL OR source_account=target_account
   OR jsonb_typeof(observation->'targetAssets') IS DISTINCT FROM 'array' OR jsonb_array_length(observation->'targetAssets')<>1
   OR observation#>>'{targetAssets,0,sourceBindingId}' IS DISTINCT FROM plan.initiating_binding_id::text
   OR observation->>'originalCheckpointId' IS DISTINCT FROM legacy_slot.id::text
   OR observation->>'authorizationOperationId' IS DISTINCT FROM plan.legacy_authorization_operation_id::text
   OR encode(digest(plan.execution_scope::text,'sha256'),'hex') IS DISTINCT FROM plan.execution_scope_sha256 THEN
   RAISE EXCEPTION 'Original legacy same-phone completion is unavailable' USING ERRCODE='23514';END IF;
 ELSE
 IF plan.provider_migration_id IS NULL OR source_account IS NULL OR target_account IS NULL
  OR initiate.id IS NULL OR complete.id IS NULL OR initiate.outcome='REJECTED' OR complete.outcome='REJECTED'
  OR initiate.account_id IS DISTINCT FROM plan.source_account_id OR complete.account_id IS DISTINCT FROM plan.source_account_id
  OR initiate.result->>'migrationId' IS DISTINCT FROM plan.provider_migration_id
  OR observation->>'migrationId' IS DISTINCT FROM plan.provider_migration_id OR observation->>'status' IS DISTINCT FROM 'COMPLETED'
  OR observation#>>'{destination,id}' IS DISTINCT FROM target_account OR source_account IS NOT DISTINCT FROM target_account
  OR observation#>>'{destination,currency}' IS DISTINCT FROM plan.target_currency
  OR observation#>>'{targetReadiness,assets}' IS DISTINCT FROM 'VERIFIED'
  OR observation#>>'{targetReadiness,continuity}' IS DISTINCT FROM 'SAME_GRAPH_PHONE_IDS'
  OR jsonb_typeof(observation->'targetAssets') IS DISTINCT FROM 'array'
  OR jsonb_array_length(plan.execution_scope->'bindings') NOT BETWEEN 1 AND 2000
  OR jsonb_array_length(observation->'targetAssets')<>jsonb_array_length(plan.execution_scope->'bindings')
  OR encode(digest(plan.execution_scope::text,'sha256'),'hex') IS DISTINCT FROM plan.execution_scope_sha256 THEN
  RAISE EXCEPTION 'Original provider completion and scope are unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 FOR original IN SELECT value FROM jsonb_array_elements(plan.execution_scope->'bindings')
  WHERE NOT legacy OR value->>'id'=plan.initiating_binding_id::text ORDER BY value->>'connectionId',value->>'id' LOOP
  SELECT * INTO predecessor FROM public.meta_connection_account_bindings WHERE tenant_id=plan.tenant_id AND id::text=original->>'id' FOR UPDATE NOWAIT;
  SELECT * INTO successor FROM public.meta_connection_account_bindings WHERE tenant_id=plan.tenant_id
   AND predecessor_binding_id=predecessor.id AND account_transition_id=plan.id FOR UPDATE NOWAIT;
  SELECT * INTO connection_row FROM public.connections WHERE tenant_id=plan.tenant_id AND id=predecessor.connection_id FOR UPDATE NOWAIT;
  SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=plan.tenant_id AND id=successor.provider_session_id FOR UPDATE NOWAIT;
  IF predecessor.id IS NULL OR successor.id IS NULL OR predecessor.state<>'RETIRED' OR successor.state<>'HELD'
   OR predecessor.account_id IS DISTINCT FROM plan.source_account_id OR successor.account_id IS DISTINCT FROM plan.target_account_id
   OR successor.connection_id IS DISTINCT FROM predecessor.connection_id OR original->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text
   OR predecessor.provider_session_id::text IS DISTINCT FROM original->>'sessionId'
   OR predecessor.secret_reference IS DISTINCT FROM original->>'secretReference'
   OR predecessor.credential_fingerprint IS DISTINCT FROM original->>'fingerprint'
   OR predecessor.phone_number_id IS DISTINCT FROM original->>'phoneId' OR successor.phone_number_id IS DISTINCT FROM predecessor.phone_number_id
   OR predecessor.app_id IS DISTINCT FROM original->>'appId' OR successor.app_id IS DISTINCT FROM predecessor.app_id
   OR predecessor.revision IS DISTINCT FROM (original->>'revision')::bigint+1
   OR connection_row.state<>'PAUSED' OR session_row.state<>'PAUSED' OR session_row.ownership_state<>'ACTIVE'
   OR session_row.connection_id IS DISTINCT FROM predecessor.connection_id OR session_row.opaque_session_id IS DISTINCT FROM predecessor.phone_number_id
   OR session_row.provider_state_data->>'wabaId' IS DISTINCT FROM target_account
   OR successor.secret_reference IS DISTINCT FROM connection_row.secret_reference
   OR NOT EXISTS(SELECT 1 FROM public.provider_sessions old WHERE old.tenant_id=plan.tenant_id
    AND old.connection_id=predecessor.connection_id AND old.id=predecessor.provider_session_id AND old.ownership_state='RETIRED'
    AND old.opaque_session_id=predecessor.phone_number_id AND old.provider_state_data->>'wabaId'=source_account)
  THEN RAISE EXCEPTION 'Account identity predecessor or exact target changed' USING ERRCODE='55000'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(observation->'targetAssets') item WHERE item->>'sourceBindingId'=predecessor.id::text)<>1 THEN
   RAISE EXCEPTION 'Account identity target proof is ambiguous' USING ERRCODE='23514'; END IF;
  SELECT value INTO verified FROM jsonb_array_elements(observation->'targetAssets') WHERE value->>'sourceBindingId'=predecessor.id::text;
  IF legacy THEN
   observer:=app.meta_legacy_authorized_credential(plan.id);
   IF observer IS NULL OR verified->>'authorizationOperationId' IS DISTINCT FROM observer->>'operationId'
    OR observer->>'sourceBindingId' IS DISTINCT FROM predecessor.id::text
    OR observer->>'sourcePhoneId' IS DISTINCT FROM predecessor.phone_number_id
    OR observer->>'targetAccountId' IS DISTINCT FROM target_account THEN
    RAISE EXCEPTION 'Exact legacy authorization is unavailable' USING ERRCODE='23514';END IF;
   expected_reference:=observer->>'secretReference';expected_fingerprint:=observer->>'credentialFingerprint';
   credential_metadata:=observer->'credentialMetadata';
  ELSE
  IF NOT(verified ? 'observerOperationId') OR jsonb_typeof(verified->'observerOperationId') NOT IN('string','null')
   OR (verified->'observerOperationId'<>'null'::jsonb AND COALESCE(verified->>'observerOperationId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN
   RAISE EXCEPTION 'Account identity observer selection is unavailable' USING ERRCODE='23514'; END IF;
  observer_operation:=(verified->>'observerOperationId')::uuid;
  -- Resolve the exact observer recorded by the immutable target read. A
  -- selected-but-invalid observer raises; it never falls back to the old token.
  observer:=app.meta_transition_observer_credential(plan.id,predecessor.id,observer_operation);
  IF observer IS NULL THEN
   expected_reference:=original->>'secretReference';expected_fingerprint:=original->>'fingerprint';
   credential_metadata:=original#>'{providerState,metaAccountProof,credentialMetadata}';
  ELSE
   IF observer->>'operationId' IS DISTINCT FROM observer_operation::text
    OR observer->>'sourceBindingId' IS DISTINCT FROM predecessor.id::text
    OR observer->>'scopeSha256' IS DISTINCT FROM plan.execution_scope_sha256
    OR observer->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id
    OR observer->>'appId' IS DISTINCT FROM predecessor.app_id THEN
    RAISE EXCEPTION 'Account identity observer scope changed' USING ERRCODE='23514'; END IF;
   expected_reference:=observer->>'secretReference';expected_fingerprint:=observer->>'credentialFingerprint';
   credential_metadata:=observer#>'{accountProof,credentialMetadata}';
  END IF;
  END IF;
  proof:=session_row.provider_state_data->'metaAccountProof';
  IF verified->>'sourceBindingRevision' IS DISTINCT FROM original->>'revision'
   OR verified->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text OR verified->>'providerSessionId' IS DISTINCT FROM predecessor.provider_session_id::text
   OR verified->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id OR verified->>'appId' IS DISTINCT FROM predecessor.app_id
   OR verified->>'secretReference' IS DISTINCT FROM connection_row.secret_reference
   OR verified->>'credentialFingerprint' IS DISTINCT FROM successor.credential_fingerprint
   OR successor.secret_reference IS DISTINCT FROM expected_reference
   OR successor.credential_fingerprint IS DISTINCT FROM expected_fingerprint
   OR proof->'credentialMetadata' IS DISTINCT FROM credential_metadata
   OR proof IS DISTINCT FROM (verified->'accountProof')||jsonb_build_object('providerSessionId',session_row.id::text)
   OR proof->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED' OR proof->'schemaVersion' IS DISTINCT FROM '1'
   OR proof->>'tenantId' IS DISTINCT FROM plan.tenant_id::text OR proof->>'connectionId' IS DISTINCT FROM predecessor.connection_id::text
   OR proof->>'secretReference' IS DISTINCT FROM connection_row.secret_reference OR proof->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id
   OR proof->>'wabaId' IS DISTINCT FROM target_account OR proof#>>'{credentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
   OR proof#>>'{credentialMetadata,appId}' IS DISTINCT FROM predecessor.app_id
   OR proof->>'verifiedAt' IS NULL
   OR (proof->>'verifiedAt')::timestamptz<=clock_timestamp()-interval '5 minutes' OR (proof->>'verifiedAt')::timestamptz>clock_timestamp()
   OR NOT (CASE WHEN proof#>>'{credentialMetadata,expiresAt}'~'^[0-9]{1,16}$' THEN
      (proof#>>'{credentialMetadata,expiresAt}')::numeric=0 OR (proof#>>'{credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END)
   OR NOT (CASE WHEN NOT(proof->'credentialMetadata' ? 'dataAccessExpiresAt') THEN true
    WHEN proof#>>'{credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$' THEN
      (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (proof#>>'{credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END)
  THEN RAISE EXCEPTION 'Account identity target credential proof changed' USING ERRCODE='23514'; END IF;
  source_asset:=jsonb_build_object('providerSessionId',predecessor.provider_session_id::text,'phoneNumberId',predecessor.phone_number_id,'wabaId',source_account);
  target_asset:=jsonb_build_object('providerSessionId',successor.provider_session_id::text,'phoneNumberId',successor.phone_number_id,'wabaId',target_account);
  IF NOT EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(predecessor.connection_id,successor.provider_session_id,successor.phone_number_id,target_account,successor.app_id,
    CASE WHEN NOT(session_row.provider_state_data ? 'metaLifecycle') THEN 0 ELSE (session_row.provider_state_data#>>'{metaLifecycle,revision}')::bigint END) life
    WHERE life.revision_matches AND NOT life.blocked AND NOT life.unresolved_hold) THEN
   RAISE EXCEPTION 'Account identity target lifecycle is held' USING ERRCODE='55000'; END IF;
  PERFORM id FROM public.participant_identities WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM public.meta_direct_identity_aliases WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM public.bot_conversations WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id FOR UPDATE NOWAIT;
  scope_value:=app.meta_account_identity_scope(predecessor.connection_id,predecessor.provider_session_id,predecessor.phone_number_id,source_account);
  SELECT item->>'identitySha256' INTO local_digest FROM jsonb_array_elements(local_scope) item WHERE item->>'bindingId'=predecessor.id::text;
  IF encode(digest(scope_value::text,'sha256'),'hex') IS DISTINCT FROM local_digest THEN
   RAISE EXCEPTION 'Explicit local identity reconciliation scope changed' USING ERRCODE='55000'; END IF;
  FOR subject IN SELECT * FROM public.participant_identities WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id ORDER BY id LOOP
   SELECT array_agg(value) INTO values_value FROM public.meta_direct_identity_aliases WHERE tenant_id=plan.tenant_id AND participant_identity_id=subject.id;
   values_value:=array_append(COALESCE(values_value,ARRAY[]::text[]),subject.external_participant_id);
   IF NOT app.meta_direct_transition_effects_clear(predecessor.connection_id,subject.id)
    OR NOT app.meta_direct_transition_privacy_clear(predecessor.connection_id,subject.id,values_value,NULL)
    OR EXISTS(SELECT 1 FROM unnest(values_value) value WHERE app.has_applicable_privacy_hold('PARTICIPANT',value)) THEN
    RAISE EXCEPTION 'Account identity subject has unresolved effects or privacy' USING ERRCODE='55000'; END IF;
   SELECT count(DISTINCT zammad_customer_id),min(zammad_customer_id)::text INTO customers,customer
    FROM public.bot_conversations WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id AND external_chat_id=subject.external_participant_id;
   IF customers>1 THEN RAISE EXCEPTION 'Account identity native customer is ambiguous' USING ERRCODE='23514'; END IF;
   IF customer IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.event_inbox anchor WHERE anchor.tenant_id=plan.tenant_id
    AND anchor.connection_id=predecessor.connection_id AND anchor.meta_direct_identity_change IS NULL
    AND app.meta_account_identity_asset_ancestor(predecessor.connection_id,anchor.meta_direct_asset,source_asset)
    AND app.meta_direct_transition_anchor_valid(anchor.id,subject.id,customer,true)) THEN
    RAISE EXCEPTION 'Account identity ordinary native anchor is unavailable' USING ERRCODE='23514'; END IF;
   FOR alias_row IN SELECT * FROM public.meta_direct_identity_aliases WHERE tenant_id=plan.tenant_id AND connection_id=predecessor.connection_id
    AND participant_identity_id=subject.id AND state<>'RETIRED' ORDER BY kind,id LOOP
    IF alias_row.state NOT IN('ACTIVE','HELD') OR alias_row.provider_session_id<>predecessor.provider_session_id
     OR alias_row.phone_number_id<>predecessor.phone_number_id OR alias_row.waba_id<>source_account OR customer IS NULL
     OR NOT app.meta_account_alias_retained_source_valid(alias_row.id,subject.external_participant_id,customer)
     OR EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases collision WHERE collision.tenant_id=plan.tenant_id
      AND collision.connection_id=predecessor.connection_id AND collision.provider_session_id=successor.provider_session_id
      AND collision.phone_number_id=successor.phone_number_id AND collision.waba_id=target_account
      AND ((collision.participant_identity_id=subject.id AND collision.kind=alias_row.kind) OR(collision.kind=alias_row.kind AND collision.value=alias_row.value))) THEN
     RAISE EXCEPTION 'Account identity source or target alias is unavailable' USING ERRCODE='23514'; END IF;
    INSERT INTO public.meta_direct_identity_aliases(tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,
     kind,value,state,source_event_id,source_payload_sha256,account_transition_id,predecessor_alias_id)
    VALUES(plan.tenant_id,predecessor.connection_id,subject.id,successor.provider_session_id,successor.phone_number_id,target_account,
     alias_row.kind,alias_row.value,alias_row.state,alias_row.source_event_id,alias_row.source_payload_sha256,plan.id,alias_row.id);
   END LOOP;
  END LOOP;
  UPDATE public.meta_direct_identity_aliases SET state='RETIRED',revision=revision+1 WHERE tenant_id=plan.tenant_id
   AND connection_id=predecessor.connection_id AND provider_session_id=predecessor.provider_session_id
   AND phone_number_id=predecessor.phone_number_id AND waba_id=source_account AND state IN('ACTIVE','HELD');
  pairs:=pairs||jsonb_build_array(jsonb_build_object('connectionId',predecessor.connection_id::text,'sourceBindingId',predecessor.id::text,
   'sourceRevision',(original->>'revision')::bigint,'targetBindingId',successor.id::text,'targetRevision',successor.revision,
   'appId',successor.app_id,'sourceAsset',source_asset,'targetAsset',target_asset));
 END LOOP;
 receipt:=jsonb_build_object('schemaVersion',1,'claim',CASE WHEN legacy THEN 'SAME_GRAPH_PHONE_LEGACY_SUCCESSOR' ELSE 'SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR' END,'transitionId',plan.id::text,'operationId',operation_row.id::text,
  'sourceAccountId',plan.source_account_id::text,'targetAccountId',plan.target_account_id::text,'migrationId',plan.provider_migration_id,
  'initiateCheckpointId',initiate.id::text,'completeCheckpointId',complete.id::text,'completionObservationOperationId',CASE WHEN legacy THEN operation_row.id ELSE plan.provider_observation_operation_id END::text,
  'sourceScopeSha256',plan.execution_scope_sha256,'targetProofSha256',encode(digest((observation->'targetAssets')::text,'sha256'),'hex'),
  'assets',pairs,'appliedAt',clock_timestamp());
 IF octet_length(receipt::text)>4194304 THEN RAISE EXCEPTION 'Account identity receipt exceeds scope bound' USING ERRCODE='54000'; END IF;
 IF legacy THEN receipt:=receipt||jsonb_build_object('registrationCheckpointId',legacy_slot.id,'authorizationOperationId',plan.legacy_authorization_operation_id);END IF;
 RETURN receipt;
END $$;

ALTER FUNCTION app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.apply_meta_account_identity_successor(uuid,uuid,uuid,bigint,jsonb) FROM PUBLIC;
-- The existing public four-argument currency entry retains its ACL and cannot
-- supply a legacy proof. The extra argument is internal to the sealed owner.
CREATE OR REPLACE FUNCTION app.apply_meta_account_identity_successor(transition_value uuid,operation_value uuid,lease_value uuid,fence_value bigint)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT app.apply_meta_account_identity_successor(transition_value,operation_value,lease_value,fence_value,NULL)
$$;

CREATE OR REPLACE FUNCTION app.meta_account_identity_metadata_current(connection_value uuid,asset_value jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
BEGIN
 -- This invoker predicate is callable by runtime roles without tenant SELECT.
 -- Return before the protected query is prepared; SQL AND is not an ACL gate.
 IF current_user<>'wasalx_meta_transition_executor'
  OR NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN RETURN false; END IF;
 RETURN EXISTS(
  SELECT 1 FROM public.meta_connection_account_bindings binding
  JOIN public.meta_account_transitions plan ON plan.tenant_id=binding.tenant_id AND plan.id=binding.account_transition_id
  JOIN public.connection_operations operation ON operation.tenant_id=plan.tenant_id AND operation.id=plan.execution_operation_id
  JOIN public.connections connection ON connection.tenant_id=binding.tenant_id AND connection.id=binding.connection_id
  JOIN public.provider_sessions session ON session.tenant_id=binding.tenant_id AND session.connection_id=binding.connection_id AND session.id=binding.provider_session_id
  JOIN public.tenants tenant ON tenant.id=plan.tenant_id
  JOIN public.tenant_memberships member ON member.tenant_id=plan.tenant_id AND member.user_id::text=operation.requested_by_id
  WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND binding.state='HELD'
   AND connection.provider='META' AND connection.state='PAUSED' AND session.state='PAUSED' AND session.ownership_state='ACTIVE'
   AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=asset_value
   AND binding.secret_reference=connection.secret_reference
   AND binding.proof_sha256=encode(digest((session.provider_state_data->'metaAccountProof')::text,'sha256'),'hex')
   AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=binding.tenant_id::text
   AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=binding.connection_id::text
   AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=binding.provider_session_id::text
   AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=connection.secret_reference
   AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=binding.phone_number_id
   AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=asset_value->>'wabaId'
   AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=binding.app_id
   AND CASE WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}'~'^[0-9]{1,16}$'
    THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0
     OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND CASE WHEN NOT(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' ? 'dataAccessExpiresAt') THEN true
    WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$'
    THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0
     OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(binding.connection_id,session.id,binding.phone_number_id,asset_value->>'wabaId',binding.app_id,
    CASE WHEN NOT(session.provider_state_data ? 'metaLifecycle') THEN 0
     WHEN session.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE -1 END) life
    WHERE life.revision_matches AND NOT life.blocked AND NOT life.unresolved_hold)
   AND plan.execution_state='RECONCILED_PAUSED' AND plan.state<>'CANCELLED'
   AND app.meta_account_identity_receipt_valid(plan.id)
   AND plan.identity_successor_receipt->>'operationId'=operation.id::text
   AND operation.state='RUNNING' AND operation.result IS NULL AND operation.lease_id IS NOT NULL AND operation.lease_expires_at>clock_timestamp()
   AND (app.meta_legacy_successor_pending(plan.id,true) OR (plan.transition_kind='CURRENCY' AND plan.provider_status='COMPLETED'
   AND operation.payload#>>'{metaAccountTransitionExecution,id}'=plan.id::text
   AND operation.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
   AND operation.payload#>>'{metaAccountTransitionExecution,revision}'=(plan.revision-1)::text
   AND operation.payload#>>'{metaAccountTransitionExecution,scopeSha256}'=plan.execution_scope_sha256
   AND operation.payload#>'{metaAccountTransitionExecution,observerOperationIds}'=plan.observer_operations
   AND jsonb_typeof(operation.payload#>'{metaAccountTransitionExecution,localIdentityScope}')='array'
   AND 2=(SELECT count(*) FROM public.meta_account_transition_reservations reservation
    WHERE reservation.tenant_id=plan.tenant_id AND reservation.transition_id=plan.id AND reservation.released_at IS NULL
     AND reservation.scope_sha256=plan.execution_scope_sha256
     AND ((reservation.account_role='SOURCE' AND reservation.account_id=plan.source_account_id)
       OR(reservation.account_role='TARGET' AND reservation.account_id=plan.target_account_id)))))
   AND tenant.state='ACTIVE' AND member.state='ACTIVE' AND member.role IN('tenant_owner','tenant_admin'));
END;
$$;

CREATE OR REPLACE FUNCTION app.meta_account_transition_identity_reconciliation(transition_value uuid,operation_value uuid,lease_value uuid,fence_value bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE plan public.meta_account_transitions;operation_row public.connection_operations;pair jsonb;source public.event_inbox;
 target_asset jsonb;result jsonb;owned_lease uuid;pending_ids uuid[];event_value uuid;receipt jsonb;
 assets jsonb:='[]';sources jsonb:='[]';original_digest text;queued_digest text;result_scope jsonb;connection_value uuid;local_scope jsonb;
BEGIN
 IF NOT pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
  RAISE EXCEPTION 'Account identity reconciliation is worker-only' USING ERRCODE='42501'; END IF;
 IF NOT app.lock_current_active_tenant_for_event_admission()
  OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Account identity reconciliation is busy or unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO plan FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=transition_value FOR UPDATE NOWAIT;
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value FOR UPDATE NOWAIT;
 IF plan.id IS NULL OR operation_row.id IS NULL OR plan.execution_operation_id IS DISTINCT FROM operation_row.id
  OR operation_row.lease_id IS DISTINCT FROM lease_value OR operation_row.fencing_token IS DISTINCT FROM fence_value
  OR operation_row.state<>'RUNNING' OR operation_row.result IS NOT NULL OR operation_row.lease_expires_at<=clock_timestamp()
  OR NOT app.meta_account_identity_receipt_valid(plan.id) THEN
  RAISE EXCEPTION 'Original account identity reconciliation lease changed' USING ERRCODE='55000'; END IF;
 PERFORM app.meta_transition_actor_current(operation_row.requested_by_id::uuid);
 local_scope:=CASE WHEN plan.transition_kind='LEGACY_PHONE' THEN operation_row.payload#>'{metaLegacyMigration,localIdentityScope}'
  ELSE operation_row.payload#>'{metaAccountTransitionExecution,localIdentityScope}' END;
 FOR pair IN SELECT value FROM jsonb_array_elements(plan.identity_successor_receipt->'assets') ORDER BY value->>'connectionId' LOOP
  connection_value:=(pair->>'connectionId')::uuid;target_asset:=pair->'targetAsset';
  PERFORM id FROM public.connections WHERE tenant_id=plan.tenant_id AND id=connection_value FOR UPDATE NOWAIT;
  PERFORM id FROM public.provider_sessions WHERE tenant_id=plan.tenant_id AND connection_id=connection_value AND ownership_state='ACTIVE' FOR UPDATE NOWAIT;
  IF NOT app.meta_account_identity_metadata_current(connection_value,target_asset) THEN
   RAISE EXCEPTION 'Exact paused metadata reconciliation context changed' USING ERRCODE='55000'; END IF;
  SELECT array_agg(id ORDER BY id) INTO pending_ids FROM public.event_inbox
   WHERE tenant_id=plan.tenant_id AND connection_id=connection_value AND provider='META'
    AND meta_direct_identity_change IS NOT NULL AND NOT app.meta_direct_transition_receipt_valid(id)
    AND app.meta_account_identity_asset_ancestor(connection_value,meta_direct_asset,target_asset);
  IF COALESCE(cardinality(pending_ids),0)>32 THEN
   RAISE EXCEPTION 'Account identity reconciliation exceeds its bounded marker scope' USING ERRCODE='54000'; END IF;
  -- Complete signed evidence is required for every marker. Sorting by provider
  -- order lets A->B precede B->C; conflicts remain the incumbent P03 decision.
  FOR event_value IN SELECT id FROM public.event_inbox WHERE tenant_id=plan.tenant_id AND id=ANY(COALESCE(pending_ids,ARRAY[]::uuid[]))
    ORDER BY meta_direct_identity_transition->>'providerTimestamp',id LOOP
   SELECT * INTO source FROM public.event_inbox WHERE tenant_id=plan.tenant_id AND id=event_value FOR NO KEY UPDATE NOWAIT;
   IF app.meta_direct_transition_receipt_valid(source.id) THEN CONTINUE; END IF;
   IF source.meta_direct_identity_transition IS NULL OR source.meta_direct_identity_transition->'redacted'='true'
    OR source.meta_direct_identity_transition->>'payloadSha256' IS DISTINCT FROM source.payload_sha256
    OR source.meta_direct_identity_transition->'asset' IS DISTINCT FROM source.meta_direct_asset
    OR source.meta_direct_identity_change->>'scope'='ASSET'
    OR source.meta_direct_identity_change->'redacted'='true' THEN
    RAISE EXCEPTION 'Account identity source requires review' USING ERRCODE='55000'; END IF;
   owned_lease:=NULL;
   IF source.status='QUARANTINED' AND source.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PENDING_CURRENT') THEN
    NULL; -- Existing metadata reconsideration, never raw event replay.
   ELSIF source.status IN('ACCEPTED','FAILED_RETRYABLE','PROCESSING')
    AND (source.lease_id IS NULL OR source.lease_expires_at<=clock_timestamp()) THEN
    owned_lease:=gen_random_uuid();
    UPDATE public.event_inbox SET status='PROCESSING',lease_id=owned_lease,lease_expires_at=operation_row.lease_expires_at,
     attempts=attempts+1,updated_at=now() WHERE tenant_id=plan.tenant_id AND id=source.id
      AND status=source.status AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp());
    IF NOT FOUND THEN RAISE EXCEPTION 'Account identity source claim changed' USING ERRCODE='55000'; END IF;
   ELSE
    RAISE EXCEPTION 'Account identity source is held or owned by another worker' USING ERRCODE='55000';
   END IF;
   result:=app.drain_meta_direct_transitions(source.id,owned_lease,false);
   IF result->>'state' NOT IN('APPLIED','DUPLICATE') OR result->'remainingHeld'='true' THEN
    RAISE EXCEPTION 'Account identity metadata cannot settle completely' USING ERRCODE='55000'; END IF;
  END LOOP;
  IF NOT app.meta_account_identity_metadata_current(connection_value,target_asset)
   OR NOT app.meta_direct_identity_guard(connection_value,(target_asset->>'providerSessionId')::uuid,target_asset->>'phoneNumberId',target_asset->>'wabaId',NULL) THEN
   RAISE EXCEPTION 'Account identity markers or aliases remain held' USING ERRCODE='55000'; END IF;
  FOR source IN SELECT * FROM public.event_inbox WHERE tenant_id=plan.tenant_id AND id=ANY(COALESCE(pending_ids,ARRAY[]::uuid[])) ORDER BY id LOOP
   IF NOT app.meta_direct_transition_receipt_valid(source.id) THEN
    RAISE EXCEPTION 'Account identity settlement receipt is unavailable' USING ERRCODE='55000'; END IF;
   sources:=sources||jsonb_build_array(jsonb_build_object('eventId',source.id,'payloadSha256',source.payload_sha256,
    'evidenceSha256',encode(digest(source.meta_direct_identity_transition::text,'sha256'),'hex'),
    'resolutionSha256',encode(digest(source.meta_direct_identity_resolution::text,'sha256'),'hex'),
    'appliedEventId',source.meta_direct_identity_resolution->>'appliedEventId'));
  END LOOP;
  SELECT item->>'identitySha256' INTO original_digest FROM jsonb_array_elements(plan.execution_scope->'bindings') item WHERE item->>'id'=pair->>'sourceBindingId';
  SELECT item->>'identitySha256' INTO queued_digest FROM jsonb_array_elements(local_scope) item WHERE item->>'bindingId'=pair->>'sourceBindingId';
  result_scope:=app.meta_account_identity_scope(connection_value,(target_asset->>'providerSessionId')::uuid,target_asset->>'phoneNumberId',target_asset->>'wabaId');
  IF original_digest IS NULL OR queued_digest IS NULL THEN RAISE EXCEPTION 'Original identity scope is unavailable' USING ERRCODE='23514'; END IF;
  assets:=assets||jsonb_build_array(jsonb_build_object('sourceBindingId',pair->>'sourceBindingId','targetBindingId',pair->>'targetBindingId',
   'originalIdentitySha256',original_digest,'queuedIdentitySha256',queued_digest,'resultIdentitySha256',encode(digest(result_scope::text,'sha256'),'hex')));
 END LOOP;
 receipt:=jsonb_build_object('schemaVersion',1,'status','SETTLED','transitionId',plan.id,'operationId',operation_row.id,
  'sourceScopeSha256',plan.execution_scope_sha256,'localIdentityScopeSha256',encode(digest(local_scope::text,'sha256'),'hex'),
  'assets',assets,'sources',sources,'settledAt',clock_timestamp());
 IF octet_length(receipt::text)>4194304 THEN RAISE EXCEPTION 'Account identity reconciliation receipt exceeds scope bound' USING ERRCODE='54000'; END IF;
 RETURN receipt;
END $$;



-- Fragment: META_LEGACY_MIGRATION_READBACK.sql
-- Private WIP. Immutable readbacks never settle the original registration.

CREATE FUNCTION app.meta_legacy_readback_current(operation_value uuid,lease_value uuid,fence_value bigint,
 context_sha text,observation_value jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;slot public.meta_provider_effect_checkpoints;
 ctx jsonb;original jsonb;mapping jsonb;item jsonb;dependency jsonb;count_value integer;account_value uuid;safety_value bigint;
 funding jsonb;target public.meta_messaging_accounts;policy public.meta_billing_policy_versions;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 ctx:=app.meta_legacy_migration_context(o.id,lease_value,fence_value,o.payload#>>'{metaLegacyMigration,appId}','READBACK');
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(ctx->>'transitionId')::uuid;
 SELECT * INTO slot FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id AND owner_kind='ACCOUNT_TRANSITION'
  AND owner_id=p.id AND stage='LEGACY_REGISTER';
 IF ctx->>'contextSha256' IS DISTINCT FROM context_sha OR slot.id IS NULL OR slot.outcome='REJECTED'
  OR jsonb_typeof(observation_value) IS DISTINCT FROM 'object' OR octet_length(observation_value::text)>4194304
  OR (SELECT count(*) FROM jsonb_object_keys(observation_value))<>13
  OR observation_value->>'schemaVersion' IS DISTINCT FROM '1'
  OR observation_value->>'claim' IS DISTINCT FROM 'LEGACY_TARGET_REGISTRATION_OBSERVED'
  OR observation_value->>'sourceAccountId' IS DISTINCT FROM ctx#>>'{source,providerAccountId}'
  OR observation_value->>'destinationAccountId' IS DISTINCT FROM ctx#>>'{destination,providerAccountId}'
  OR observation_value->>'phoneId' IS DISTINCT FROM ctx#>>'{source,phoneId}'
  OR observation_value->>'phoneId' IS DISTINCT FROM ctx#>>'{destination,phoneId}'
  OR observation_value#>>'{relation,phoneNumberId}' IS DISTINCT FROM observation_value->>'phoneId'
  OR observation_value#>>'{relation,wabaId}' IS DISTINCT FROM observation_value->>'destinationAccountId'
  OR observation_value->'appSubscribed' IS DISTINCT FROM 'true'::jsonb
  OR observation_value->>'originalCheckpointId' IS DISTINCT FROM slot.id::text
  OR observation_value->>'originalOutcome' IS DISTINCT FROM slot.outcome
  OR observation_value->>'templateObservationOperationId' IS DISTINCT FROM p.legacy_template_operation_id::text
  OR observation_value->>'observedAt' IS NULL OR (observation_value->>'observedAt')::timestamptz>clock_timestamp()
  OR (observation_value->>'observedAt')::timestamptz<clock_timestamp()-interval '2 minutes' THEN
  RAISE EXCEPTION 'Fresh original migration readback is unavailable' USING ERRCODE='55000';END IF;
 funding:=observation_value->'fundingProof';
 IF ctx->>'stage'='OBSERVE' AND slot.outcome='SUCCEEDED' THEN
  SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
  SELECT * INTO policy FROM public.meta_billing_policy_versions WHERE tenant_id=p.tenant_id AND id=target.active_policy_version_id;
  IF jsonb_typeof(funding) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(funding))<>9
   OR funding->>'schemaVersion' IS DISTINCT FROM '1' OR funding->>'accountId' IS DISTINCT FROM target.provider_account_id
   OR funding->>'actualPayer' IS DISTINCT FROM 'UNVERIFIED' OR funding->>'status' IS DISTINCT FROM 'PRESENT'
   OR funding->>'primaryFundingId' IS DISTINCT FROM target.primary_funding_id OR target.primary_funding_id IS NULL
   OR funding->>'observedOwnerBusinessId' IS DISTINCT FROM target.observed_owner_business_id
   OR COALESCE(funding->>'responseSha256','') !~ '^[a-f0-9]{64}$'
   OR funding->>'observedAt' IS NULL OR (funding->>'observedAt')::timestamptz>clock_timestamp()
   OR (funding->>'observedAt')::timestamptz<clock_timestamp()-interval '2 minutes'
   OR funding->>'expiresAt' IS NULL
   OR (funding->>'expiresAt')::timestamptz<>(funding->>'observedAt')::timestamptz+interval '15 minutes'
   OR (funding->>'expiresAt')::timestamptz<=clock_timestamp()
   OR target.state<>'READY' OR target.funding_status<>'PRESENT'
   OR target.active_policy_version_id IS DISTINCT FROM target.requested_policy_version_id
   OR policy.id IS NULL OR policy.account_id<>target.id
   OR policy.mode IS DISTINCT FROM (CASE WHEN p.requested_mode='WASALX_MANAGED' THEN 'MANAGED' ELSE 'CUSTOMER' END)
   OR NOT app.meta_account_payment_ready(target.id,target.primary_funding_id) THEN
   RAISE EXCEPTION 'Original target funding cannot be refreshed' USING ERRCODE='55000';END IF;
 ELSIF funding IS DISTINCT FROM 'null'::jsonb THEN
  RAISE EXCEPTION 'Only known-success observation may refresh funding' USING ERRCODE='55000';
 END IF;
 mapping:=observation_value->'templateMapping';original:=ctx->'templateObservation';
 IF jsonb_typeof(mapping) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(mapping))<>9
  OR mapping->>'schemaVersion' IS DISTINCT FROM '1' OR mapping->>'claim' IS DISTINCT FROM 'EXACT_TEMPLATE_SEMANTICS'
  OR mapping->>'sourceAccountId' IS DISTINCT FROM observation_value->>'sourceAccountId'
  OR mapping->>'targetAccountId' IS DISTINCT FROM observation_value->>'destinationAccountId'
  OR mapping->>'sourceSafetyRevision' IS DISTINCT FROM ctx#>>'{currentTemplateSafety,source}'
  OR mapping->>'targetSafetyRevision' IS DISTINCT FROM ctx#>>'{currentTemplateSafety,target}'
  OR COALESCE(mapping->>'sourceInventorySha256','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(mapping->>'targetInventorySha256','') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(mapping->'mappings') IS DISTINCT FROM 'array' OR jsonb_array_length(mapping->'mappings')>2000 THEN
  RAISE EXCEPTION 'Exact template continuity is unavailable' USING ERRCODE='55000';END IF;
 -- Same per-flow template IDs and semantics as the original immutable B1
 -- observation, not a later equal-name inventory or a copy-result ID list.
 FOR dependency IN SELECT value FROM jsonb_array_elements(original->'dependencies') LOOP
  SELECT count(*),min(x::text)::jsonb INTO count_value,item FROM jsonb_array_elements(mapping->'mappings') x
   WHERE lower(x->>'flowVersionId')=lower(dependency->>'flowVersionId') AND x->>'name'=dependency->>'name'
    AND x->>'language'=dependency->>'language' AND x->>'parameterCount'=dependency->>'parameterCount';
  IF count_value<>1 OR dependency->>'ready' IS DISTINCT FROM 'true'
   OR item->>'sourceTemplateId' IS DISTINCT FROM dependency->>'sourceTemplateId'
   OR item->>'targetTemplateId' IS DISTINCT FROM dependency->>'targetTemplateId'
   OR item->>'semanticSha256' IS DISTINCT FROM dependency->>'semanticSha256' THEN
   RAISE EXCEPTION 'An inherited template mapping changed' USING ERRCODE='55000';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(mapping->'mappings') x WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(original->'dependencies') d WHERE lower(d->>'flowVersionId')=lower(x->>'flowVersionId')
   AND d->>'name'=x->>'name' AND d->>'language'=x->>'language' AND d->>'parameterCount'=x->>'parameterCount')) THEN
  RAISE EXCEPTION 'Template mapping extends the original scope' USING ERRCODE='23514';END IF;
 -- The original B1 semantic receipt stays immutable. A later signed negative
 -- requires another explicit target GET; its captured generation must still be
 -- current at commit. A callback alone never clears or settles any effect.
 FOR account_value IN SELECT value FROM unnest(ARRAY[p.source_account_id,p.target_account_id]) value ORDER BY value LOOP
  INSERT INTO public.meta_template_account_safety(tenant_id,account_id) VALUES(p.tenant_id,account_value) ON CONFLICT DO NOTHING;
  SELECT revision INTO safety_value FROM public.meta_template_account_safety
   WHERE tenant_id=p.tenant_id AND account_id=account_value FOR UPDATE;
  IF safety_value<>(CASE WHEN account_value=p.source_account_id THEN (ctx#>>'{currentTemplateSafety,source}')::bigint
   ELSE (ctx#>>'{currentTemplateSafety,target}')::bigint END) THEN
   RAISE EXCEPTION 'Signed template change supersedes migration readback' USING ERRCODE='55000';END IF;
 END LOOP;
 RETURN ctx;
END $$;
ALTER FUNCTION app.meta_legacy_readback_current(uuid,uuid,bigint,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_legacy_readback_current(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;

CREATE FUNCTION app.record_meta_legacy_readback(operation_value uuid,lease_value uuid,fence_value bigint,
 context_sha text,observation_value jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE ctx jsonb;p public.meta_account_transitions;o public.connection_operations;outcome_value text;
BEGIN
 ctx:=app.meta_legacy_readback_current(operation_value,lease_value,fence_value,context_sha,observation_value);
 IF ctx->>'stage'='RECONCILE' THEN RAISE EXCEPTION 'Reconciliation and readback must commit together' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=app.current_tenant_id() AND id=(ctx->>'transitionId')::uuid;
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=p.tenant_id AND id=operation_value;
 IF o.result IS NOT NULL THEN RAISE EXCEPTION 'Original migration observation is immutable' USING ERRCODE='23514';END IF;
 outcome_value:=observation_value->>'originalOutcome';
 UPDATE public.connection_operations SET result=jsonb_build_object('metaLegacyMigration',observation_value),state='SUCCEEDED',
  completed_at=clock_timestamp(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL WHERE tenant_id=o.tenant_id AND id=o.id;
 IF ctx->>'stage'='OBSERVE' AND outcome_value='SUCCEEDED' THEN
  -- The immutable operation receipt is installed first. The table guard allows
  -- only these evidence columns under the exact original target reservation.
  UPDATE public.meta_messaging_accounts SET
   funding_response_sha256=observation_value#>>'{fundingProof,responseSha256}',
   funding_observed_at=(observation_value#>>'{fundingProof,observedAt}')::timestamptz,
   funding_expires_at=(observation_value#>>'{fundingProof,expiresAt}')::timestamptz,
   last_observation_operation_id=o.id,updated_at=now()
   WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
  IF NOT FOUND OR NOT app.meta_legacy_destination_ready(p.id) THEN
   RAISE EXCEPTION 'Fresh original target funding is unavailable' USING ERRCODE='55000';END IF;
 END IF;
 UPDATE public.meta_account_transitions SET legacy_readback_operation_id=o.id,legacy_state=CASE WHEN outcome_value='SUCCEEDED'
  THEN 'READBACK_REQUIRED' ELSE 'OUTCOME_UNKNOWN' END,revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 -- Outcome/slot/request digest/reservations remain original and untouched.
 RETURN true;
END $$;
ALTER FUNCTION app.record_meta_legacy_readback(uuid,uuid,bigint,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.record_meta_legacy_readback(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_legacy_readback(uuid,uuid,bigint,text,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.fail_meta_legacy_operation(operation_value uuid,lease_value uuid,fence_value bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE o public.connection_operations;p public.meta_account_transitions;target_account uuid;outcome_value text;
BEGIN
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(o.payload#>>'{metaLegacyMigration,id}')::uuid
  AND transition_kind='LEGACY_PHONE';
 IF p.id IS NULL THEN RETURN false;END IF;
 SELECT account_id INTO target_account FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
 PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,target_account]);
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=o.tenant_id AND id=o.id FOR UPDATE NOWAIT;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE NOWAIT;
 IF o.state<>'RUNNING' OR o.lease_id IS DISTINCT FROM lease_value OR o.fencing_token<>fence_value OR o.lease_expires_at<=clock_timestamp()
  OR p.legacy_operation_id<>o.id OR p.revision::text IS DISTINCT FROM o.payload#>>'{metaLegacyMigration,revision}' THEN RETURN false;END IF;
 SELECT outcome INTO outcome_value FROM public.meta_provider_effect_checkpoints WHERE tenant_id=p.tenant_id
  AND owner_kind='ACCOUNT_TRANSITION' AND owner_id=p.id AND stage='LEGACY_REGISTER';
 UPDATE public.connection_operations SET state='FAILED_TERMINAL',completed_at=clock_timestamp(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL,
  safe_error='Migration requires an explicit current review.' WHERE tenant_id=o.tenant_id AND id=o.id;
 UPDATE public.meta_account_transitions SET legacy_state=CASE WHEN outcome_value IN('ATTEMPTED','UNKNOWN') THEN 'OUTCOME_UNKNOWN'
  WHEN outcome_value='SUCCEEDED' THEN 'READBACK_REQUIRED' ELSE 'HELD' END,revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN true;
END $$;
ALTER FUNCTION app.fail_meta_legacy_operation(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.fail_meta_legacy_operation(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fail_meta_legacy_operation(uuid,uuid,bigint) TO wasalx_connector_worker;


-- Fragment: META_LEGACY_SUCCESSOR.sql
-- Typed legacy completion reuses the sealed same-Graph-phone identity loop.
-- Provider history, source policy and existing delivery births stay unchanged.

CREATE FUNCTION app.reconcile_meta_legacy_migration(operation_value uuid,lease_value uuid,fence_value bigint,
 context_sha text,observation_value jsonb) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE ctx jsonb;p public.meta_account_transitions;o public.connection_operations;
 predecessor public.meta_connection_account_bindings;old_session public.provider_sessions;target public.meta_messaging_accounts;
 authorization_value jsonb;relation jsonb;proof jsonb;asset jsonb;sealed_observation jsonb;receipt jsonb;settlement jsonb;
 session_value uuid:=gen_random_uuid();binding_value uuid:=gen_random_uuid();
BEGIN
 ctx:=app.meta_legacy_readback_current(operation_value,lease_value,fence_value,context_sha,observation_value);
 SELECT * INTO o FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 SELECT * INTO p FROM public.meta_account_transitions WHERE tenant_id=o.tenant_id AND id=(ctx->>'transitionId')::uuid;
 IF ctx->>'stage' IS DISTINCT FROM 'RECONCILE' OR o.result IS NOT NULL
  OR NOT app.meta_legacy_successor_pending(p.id,false) OR NOT app.meta_legacy_destination_ready(p.id)
  OR NOT app.meta_transition_drained(p.source_account_id,o.id) OR NOT app.meta_transition_drained(p.target_account_id,o.id)
  OR observation_value->>'originalOutcome' IS DISTINCT FROM 'SUCCEEDED' THEN
  RAISE EXCEPTION 'Original migration cannot be reconciled' USING ERRCODE='55000';END IF;
 SELECT * INTO predecessor FROM public.meta_connection_account_bindings
  WHERE tenant_id=p.tenant_id AND id=p.initiating_binding_id AND state='ACTIVE' FOR UPDATE NOWAIT;
 SELECT * INTO old_session FROM public.provider_sessions
  WHERE tenant_id=p.tenant_id AND id=predecessor.provider_session_id AND ownership_state='ACTIVE' FOR UPDATE NOWAIT;
 SELECT * INTO target FROM public.meta_messaging_accounts WHERE tenant_id=p.tenant_id AND id=p.target_account_id;
 authorization_value:=app.meta_legacy_authorized_credential(p.id);
 relation:=observation_value->'relation';
 IF predecessor.id IS NULL OR old_session.id IS NULL OR target.id IS NULL OR authorization_value IS NULL
  OR predecessor.connection_id<>p.initiating_connection_id OR predecessor.account_id<>p.source_account_id
  OR authorization_value->>'operationId' IS DISTINCT FROM o.payload#>>'{metaLegacyMigration,authorizationOperationId}'
  OR authorization_value->>'sourceBindingId' IS DISTINCT FROM predecessor.id::text
  OR authorization_value->>'sourcePhoneId' IS DISTINCT FROM predecessor.phone_number_id
  OR authorization_value->>'targetAccountId' IS DISTINCT FROM target.provider_account_id
  OR jsonb_typeof(relation) IS DISTINCT FROM 'object' OR relation->>'schemaVersion' IS DISTINCT FROM '1'
  OR relation->>'claim' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED'
  OR relation->>'phoneNumberId' IS DISTINCT FROM predecessor.phone_number_id
  OR relation->>'wabaId' IS DISTINCT FROM target.provider_account_id OR relation->>'graphVersion' IS DISTINCT FROM 'v24.0'
  OR COALESCE(relation->>'responseSha256','') !~ '^[a-f0-9]{64}$'
  OR relation->>'verifiedAt' IS NULL OR (relation->>'verifiedAt')::timestamptz>clock_timestamp()
  OR (relation->>'verifiedAt')::timestamptz<clock_timestamp()-interval '2 minutes' THEN
  RAISE EXCEPTION 'Exact fresh legacy target proof is unavailable' USING ERRCODE='55000';END IF;
 -- Whitelist the provider relation. Private account proof authority is derived
 -- only from this operation and its separately sealed one-use authorization.
 proof:=jsonb_build_object('schemaVersion',1,'claim','PHONE_ACCOUNT_RELATION_VERIFIED',
  'phoneNumberId',predecessor.phone_number_id,'wabaId',target.provider_account_id,'graphVersion','v24.0',
  'verifiedAt',relation->'verifiedAt','responseSha256',relation->'responseSha256',
  'tenantId',p.tenant_id,'connectionId',predecessor.connection_id,'providerSessionId',old_session.id,
  'secretReference',authorization_value->>'secretReference','credentialFingerprint',authorization_value->>'credentialFingerprint',
  'credentialMetadata',authorization_value->'credentialMetadata','operationId',o.id,'fencingToken',fence_value);
 asset:=jsonb_build_object('sourceBindingId',predecessor.id,'sourceBindingRevision',predecessor.revision,
  'connectionId',predecessor.connection_id,'providerSessionId',old_session.id,'phoneNumberId',predecessor.phone_number_id,
  'appId',predecessor.app_id,'secretReference',authorization_value->>'secretReference',
  'credentialFingerprint',authorization_value->>'credentialFingerprint','authorizationOperationId',p.legacy_authorization_operation_id,
  'accountProof',proof);
 sealed_observation:=jsonb_build_object('targetAssets',jsonb_build_array(asset),
  'originalCheckpointId',observation_value->'originalCheckpointId','authorizationOperationId',p.legacy_authorization_operation_id);
 UPDATE public.meta_connection_account_bindings SET state='RETIRED',revision=revision+1,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=predecessor.id;
 UPDATE public.provider_sessions SET ownership_state='RETIRED',retired_at=now(),worker_id=NULL,lease_expires_at=NULL,updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=old_session.id;
 INSERT INTO public.provider_sessions(id,tenant_id,connection_id,opaque_session_id,state,session_storage_reference,ownership_state,provider_state,provider_state_data)
  VALUES(session_value,p.tenant_id,predecessor.connection_id,predecessor.phone_number_id,'PAUSED','meta-cloud://'||target.provider_account_id||'/'||predecessor.phone_number_id,'ACTIVE','PAUSED',
   jsonb_build_object('wabaId',target.provider_account_id,'metaAccountProof',proof||jsonb_build_object('providerSessionId',session_value),
    'metaAccountTransition',jsonb_build_object('id',p.id,'predecessorSessionId',old_session.id,'purpose','LEGACY_SUCCESSOR')));
 -- The existing binding trigger checks this current reference on INSERT.
 UPDATE public.connections SET secret_reference=authorization_value->>'secretReference',updated_at=now()
  WHERE tenant_id=p.tenant_id AND id=predecessor.connection_id;
 INSERT INTO public.meta_connection_account_bindings(id,tenant_id,account_id,connection_id,provider_session_id,phone_number_id,app_id,
  secret_reference,credential_fingerprint,proof_sha256,state,predecessor_binding_id,account_transition_id,template_mapping_operation_id)
  VALUES(binding_value,p.tenant_id,target.id,predecessor.connection_id,session_value,predecessor.phone_number_id,predecessor.app_id,
   authorization_value->>'secretReference',authorization_value->>'credentialFingerprint',
   encode(public.digest((proof||jsonb_build_object('providerSessionId',session_value))::text,'sha256'),'hex'),
   'HELD',predecessor.id,p.id,o.id);
 receipt:=app.apply_meta_account_identity_successor(p.id,o.id,lease_value,fence_value,sealed_observation);
 IF receipt->>'claim' IS DISTINCT FROM 'SAME_GRAPH_PHONE_LEGACY_SUCCESSOR' THEN
  RAISE EXCEPTION 'Typed legacy identity successor is unavailable' USING ERRCODE='55000';END IF;
 UPDATE public.meta_account_transitions SET identity_successor_receipt=receipt,reconciled_at=clock_timestamp(),
  execution_state='RECONCILED_PAUSED',legacy_state='RECONCILED_PAUSED',legacy_readback_operation_id=o.id,
  revision=revision+1,updated_at=now() WHERE tenant_id=p.tenant_id AND id=p.id;
 -- Publish only inside this transaction, then settle complete signed metadata
 -- under sealed lineage. Every failure rolls back bindings, aliases and receipt.
 settlement:=app.meta_account_transition_identity_reconciliation(p.id,o.id,lease_value,fence_value);
 IF settlement->>'status' IS DISTINCT FROM 'SETTLED' THEN
  RAISE EXCEPTION 'Signed identity reconciliation is incomplete' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET result=jsonb_build_object('metaLegacyMigration',observation_value,
  'metaLegacySuccessor',sealed_observation,'metaTransitionIdentityReconciliation',settlement),
  state='SUCCEEDED',completed_at=clock_timestamp(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL
  WHERE tenant_id=o.tenant_id AND id=o.id AND result IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original reconciliation result is occupied' USING ERRCODE='55000';END IF;
 UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='VERIFIED_SUCCESSOR',revision=revision+1
  WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
 -- Explicit existing activation must re-prove routing, credentials and funding.
 -- Other source-account phones remain PAUSED; no historical effect is retargeted.
 RETURN true;
END $$;
ALTER FUNCTION app.reconcile_meta_legacy_migration(uuid,uuid,bigint,text,jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.reconcile_meta_legacy_migration(uuid,uuid,bigint,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reconcile_meta_legacy_migration(uuid,uuid,bigint,text,jsonb) TO wasalx_connector_worker;


-- Fragment: META_LEGACY_SUCCESSOR_GUARDS.sql
-- Existing guard/activation/export bodies with only typed legacy successor admission.

CREATE OR REPLACE FUNCTION app.guard_meta_account_policy_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='meta_connection_account_bindings' THEN
  IF TG_OP='UPDATE' AND (NEW.predecessor_binding_id,NEW.account_transition_id) IS DISTINCT FROM (OLD.predecessor_binding_id,OLD.account_transition_id) THEN
   RAISE EXCEPTION 'Account lineage is immutable' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' AND NEW.predecessor_binding_id IS NOT NULL AND NOT(current_user='wasalx_meta_transition_executor' AND EXISTS(
   SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id
   JOIN public.meta_connection_account_bindings predecessor ON predecessor.tenant_id=p.tenant_id AND predecessor.id=NEW.predecessor_binding_id
   WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.account_transition_id AND p.target_account_id=NEW.account_id
    AND p.source_account_id=predecessor.account_id AND predecessor.state='RETIRED' AND predecessor.connection_id=NEW.connection_id
    AND predecessor.phone_number_id=NEW.phone_number_id AND predecessor.app_id=NEW.app_id AND NEW.state='HELD'
    AND ((p.provider_status='COMPLETED' AND o.state='RUNNING' AND o.lease_expires_at>=clock_timestamp()
     AND o.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE')
     OR (p.initiating_binding_id=predecessor.id AND app.meta_legacy_successor_pending(p.id,false))))) THEN
   RAISE EXCEPTION 'Successor account requires the sealed same-phone transition' USING ERRCODE='42501';END IF;
 END IF;
 IF TG_TABLE_NAME='meta_connection_account_bindings' THEN
 IF current_user='wasalx_meta_transition_executor' AND TG_OP='UPDATE'
  AND OLD.state='ACTIVE' AND NEW.state='RETIRED' AND NEW.revision=OLD.revision+1
  AND (to_jsonb(NEW)-ARRAY['state','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['state','revision','updated_at'])
  AND EXISTS(SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations o ON o.tenant_id=p.tenant_id AND o.id=p.execution_operation_id
   JOIN public.meta_account_transition_reservations r ON r.tenant_id=p.tenant_id AND r.transition_id=p.id AND r.account_id=OLD.account_id AND r.released_at IS NULL
   WHERE p.tenant_id=OLD.tenant_id AND p.source_account_id=OLD.account_id
    AND ((p.provider_status='COMPLETED' AND o.state='RUNNING' AND o.lease_expires_at>=clock_timestamp()
     AND o.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
     AND p.revision::text=o.payload#>>'{metaAccountTransitionExecution,revision}')
     OR (p.initiating_binding_id=OLD.id AND app.meta_legacy_successor_pending(p.id,false)))) THEN RETURN NEW;END IF;
 END IF;
 IF NEW.state='RETIRED' AND (TG_OP='INSERT' OR OLD.state<>'RETIRED') AND NOT EXISTS(
  SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=NEW.tenant_id AND job.job_type='DELETE' AND job.scope_type='TENANT'
    AND job.scope_value=NEW.tenant_id::text AND job.stage='LOCAL' AND job.state='RUNNING'
    AND job.lease_id IS NOT NULL AND job.lease_expires_at>=clock_timestamp()) THEN
  RAISE EXCEPTION 'Meta account retirement requires current tenant privacy authority' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='meta_connection_account_bindings' THEN
 IF NEW.state<>'RETIRED' AND NOT EXISTS(
  SELECT 1 FROM connections connection JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
    JOIN meta_messaging_accounts account ON account.tenant_id=NEW.tenant_id AND account.id=NEW.account_id
  WHERE connection.tenant_id=NEW.tenant_id AND connection.id=NEW.connection_id AND connection.provider='META'
    AND session.id=NEW.provider_session_id AND session.ownership_state='ACTIVE' AND session.opaque_session_id=NEW.phone_number_id
    AND session.provider_state_data->>'wabaId'=account.provider_account_id AND connection.secret_reference=NEW.secret_reference
    AND session.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1'
    AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
    AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=NEW.tenant_id::text
    AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=NEW.connection_id::text
    AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=NEW.provider_session_id::text
    AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=NEW.phone_number_id
    AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=account.provider_account_id
    AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=NEW.secret_reference
    AND session.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=NEW.credential_fingerprint
    AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=NEW.app_id) THEN
  RAISE EXCEPTION 'Meta account binding requires the current exact credential proof' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='INSERT' AND TG_TABLE_NAME='meta_messaging_accounts' THEN
  IF NEW.state<>'HELD' OR NEW.authority_revision<>1 OR NEW.active_policy_version_id IS NOT NULL
    OR NEW.requested_policy_version_id IS NOT NULL OR NEW.funding_status<>'UNAVAILABLE'
    OR NEW.primary_funding_id IS NOT NULL OR NEW.funding_response_sha256 IS NOT NULL
    OR NEW.funding_observed_at IS NOT NULL OR NEW.funding_expires_at IS NOT NULL
    OR NEW.observed_owner_business_id IS NOT NULL OR NEW.last_observation_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'A Meta account starts without payment authority' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='meta_messaging_accounts' THEN
  IF (NEW.tenant_id,NEW.id,NEW.provider_account_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.provider_account_id,OLD.created_at)
   OR NEW.authority_revision<OLD.authority_revision OR (OLD.state='RETIRED' AND NEW.state<>'RETIRED') THEN
   RAISE EXCEPTION 'Meta account authority is immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.state,NEW.active_policy_version_id,NEW.requested_policy_version_id,NEW.funding_status,NEW.primary_funding_id,NEW.observed_owner_business_id)
     IS DISTINCT FROM (OLD.state,OLD.active_policy_version_id,OLD.requested_policy_version_id,OLD.funding_status,OLD.primary_funding_id,OLD.observed_owner_business_id)
     AND NEW.authority_revision<>OLD.authority_revision+1 THEN RAISE EXCEPTION 'Meta account semantic generation must advance' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM meta_billing_policy_versions p WHERE p.tenant_id=NEW.tenant_id AND p.id IN(NEW.active_policy_version_id,NEW.requested_policy_version_id) AND p.account_id<>NEW.id)
    THEN RAISE EXCEPTION 'Meta policy belongs to another account' USING ERRCODE='23514'; END IF;
  IF NEW.state<>'RETIRED' AND ((NEW.funding_status,NEW.primary_funding_id,NEW.funding_response_sha256,NEW.funding_observed_at,NEW.funding_expires_at,NEW.observed_owner_business_id)
     IS DISTINCT FROM (OLD.funding_status,OLD.primary_funding_id,OLD.funding_response_sha256,OLD.funding_observed_at,OLD.funding_expires_at,OLD.observed_owner_business_id)
     OR NEW.last_observation_operation_id IS DISTINCT FROM OLD.last_observation_operation_id
     OR (NEW.state='READY' AND OLD.state<>'READY')) AND NOT EXISTS(
    SELECT 1 FROM connection_operations operation JOIN meta_connection_account_bindings binding
      ON binding.tenant_id=operation.tenant_id AND binding.connection_id=operation.connection_id AND binding.account_id=NEW.id
    WHERE operation.tenant_id=NEW.tenant_id AND operation.id=NEW.last_observation_operation_id
      AND operation.operation_type='VERIFY_META_BILLING'
      AND (operation.state='SUCCEEDED' OR (operation.state='FAILED_TERMINAL' AND NEW.funding_status='UNAVAILABLE'))
      AND operation.payload#>>'{metaAccountPolicy,accountId}'=NEW.id::text
      AND operation.payload#>>'{metaAccountPolicy,authorityRevision}'=OLD.authority_revision::text
      AND (operation.payload#>>'{metaAccountPolicy,observationOperationId}') IS NOT DISTINCT FROM OLD.last_observation_operation_id::text
      AND operation.payload#>>'{metaAccountPolicy,policyVersionId}'=NEW.requested_policy_version_id::text
      AND operation.payload#>>'{metaAccountPolicy,bindingId}'=binding.id::text
      AND operation.payload#>>'{metaAccountPolicy,bindingRevision}'=binding.revision::text
      AND operation.result#>>'{metaAccountFundingProof,schemaVersion}'='1'
      AND operation.result#>>'{metaAccountFundingProof,accountId}'=NEW.provider_account_id
      AND operation.result#>>'{metaAccountFundingProof,actualPayer}'='UNVERIFIED'
      AND operation.result#>>'{metaAccountFundingProof,status}'=NEW.funding_status
      AND (operation.result#>>'{metaAccountFundingProof,primaryFundingId}') IS NOT DISTINCT FROM NEW.primary_funding_id
      AND (operation.result#>>'{metaAccountFundingProof,observedOwnerBusinessId}') IS NOT DISTINCT FROM NEW.observed_owner_business_id
      AND operation.result#>>'{metaAccountFundingProof,responseSha256}'=NEW.funding_response_sha256
      AND (operation.result#>>'{metaAccountFundingProof,observedAt}')::timestamptz=NEW.funding_observed_at
      AND (operation.result#>>'{metaAccountFundingProof,expiresAt}')::timestamptz=NEW.funding_expires_at)
    AND NOT(current_user='wasalx_meta_transition_executor' AND EXISTS(
     SELECT 1 FROM public.meta_account_transitions p JOIN public.connection_operations operation ON operation.tenant_id=p.tenant_id
      AND operation.id=p.provider_observation_operation_id
     JOIN public.connection_operations coordinator ON coordinator.tenant_id=p.tenant_id AND coordinator.id=p.execution_operation_id
     WHERE p.tenant_id=NEW.tenant_id AND p.target_account_id=NEW.id AND p.provider_status='COMPLETED'
      AND coordinator.state='RUNNING' AND coordinator.lease_expires_at>=clock_timestamp()
      AND coordinator.payload#>>'{metaAccountTransitionExecution,action}'='RECONCILE'
      AND operation.id=NEW.last_observation_operation_id AND operation.operation_type='EXECUTE_META_ACCOUNT_TRANSITION'
      AND operation.result#>>'{metaTransitionObservation,migrationId}'=p.provider_migration_id
      AND operation.result#>>'{metaTransitionObservation,status}'='COMPLETED'
      AND operation.result#>>'{metaTransitionObservation,fundingProof,accountId}'=NEW.provider_account_id
      AND operation.result#>>'{metaTransitionObservation,fundingProof,actualPayer}'='UNVERIFIED'
      AND operation.result#>>'{metaTransitionObservation,fundingProof,status}'=NEW.funding_status
      AND operation.result#>>'{metaTransitionObservation,fundingProof,primaryFundingId}'=NEW.primary_funding_id
      AND operation.result#>>'{metaTransitionObservation,fundingProof,responseSha256}'=NEW.funding_response_sha256
      AND (operation.result#>>'{metaTransitionObservation,fundingProof,observedAt}')::timestamptz=NEW.funding_observed_at
      AND (operation.result#>>'{metaTransitionObservation,fundingProof,expiresAt}')::timestamptz=NEW.funding_expires_at
      AND NEW.funding_expires_at>clock_timestamp() AND app.meta_transition_target_review(p.id) IS NOT NULL))
    AND NOT(current_user='wasalx_meta_transition_executor' AND
     (to_jsonb(NEW)-ARRAY['funding_response_sha256','funding_observed_at','funding_expires_at','last_observation_operation_id','updated_at'])
      =(to_jsonb(OLD)-ARRAY['funding_response_sha256','funding_observed_at','funding_expires_at','last_observation_operation_id','updated_at'])
     AND NEW.state='READY' AND NEW.funding_status='PRESENT' AND NEW.primary_funding_id IS NOT NULL
     AND NEW.active_policy_version_id=NEW.requested_policy_version_id
     AND NEW.funding_expires_at>clock_timestamp() AND app.meta_account_payment_ready(NEW.id,NEW.primary_funding_id)
     AND EXISTS(SELECT 1 FROM public.meta_account_transitions p
      JOIN public.connection_operations operation ON operation.tenant_id=p.tenant_id AND operation.id=p.legacy_operation_id
      JOIN public.meta_provider_effect_checkpoints slot ON slot.tenant_id=p.tenant_id AND slot.owner_kind='ACCOUNT_TRANSITION'
       AND slot.owner_id=p.id AND slot.stage='LEGACY_REGISTER' AND slot.outcome='SUCCEEDED'
      JOIN public.meta_billing_policy_versions policy ON policy.tenant_id=p.tenant_id AND policy.id=NEW.active_policy_version_id
      WHERE p.tenant_id=NEW.tenant_id AND p.target_account_id=NEW.id AND p.transition_kind='LEGACY_PHONE'
       AND p.state<>'CANCELLED' AND p.reconciled_at IS NULL AND p.execution_operation_id=operation.id
       AND policy.account_id=NEW.id AND policy.mode=CASE WHEN p.requested_mode='WASALX_MANAGED' THEN 'MANAGED' ELSE 'CUSTOMER' END
       AND operation.id=NEW.last_observation_operation_id AND operation.operation_type='EXECUTE_META_ACCOUNT_TRANSITION'
       AND operation.state='SUCCEEDED' AND operation.payload#>>'{metaLegacyMigration,stage}'='OBSERVE'
       AND operation.payload#>>'{metaLegacyMigration,id}'=p.id::text
       AND operation.payload#>>'{metaLegacyMigration,revision}'=p.revision::text
       AND operation.result#>>'{metaLegacyMigration,originalCheckpointId}'=slot.id::text
       AND operation.result#>>'{metaLegacyMigration,originalOutcome}'='SUCCEEDED'
       AND operation.result#>>'{metaLegacyMigration,fundingProof,accountId}'=NEW.provider_account_id
       AND operation.result#>>'{metaLegacyMigration,fundingProof,actualPayer}'='UNVERIFIED'
       AND operation.result#>>'{metaLegacyMigration,fundingProof,status}'=NEW.funding_status
       AND operation.result#>>'{metaLegacyMigration,fundingProof,primaryFundingId}'=NEW.primary_funding_id
       AND operation.result#>>'{metaLegacyMigration,fundingProof,observedOwnerBusinessId}' IS NOT DISTINCT FROM NEW.observed_owner_business_id
       AND operation.result#>>'{metaLegacyMigration,fundingProof,responseSha256}'=NEW.funding_response_sha256
       AND (operation.result#>>'{metaLegacyMigration,fundingProof,observedAt}')::timestamptz=NEW.funding_observed_at
       AND (operation.result#>>'{metaLegacyMigration,fundingProof,expiresAt}')::timestamptz=NEW.funding_expires_at
       AND NEW.funding_observed_at<=clock_timestamp() AND NEW.funding_observed_at>=clock_timestamp()-interval '2 minutes'
       AND NEW.funding_expires_at=NEW.funding_observed_at+interval '15 minutes'
       AND encode(public.digest(app.meta_transition_scope(NEW.id)::text,'sha256'),'hex')=p.legacy_target_scope_sha256
       AND app.meta_transition_nonidentity_scope(app.meta_transition_scope(p.source_account_id))
        =app.meta_transition_nonidentity_scope(p.execution_scope)
       AND NOT EXISTS(SELECT value FROM unnest(ARRAY[p.source_account_id,p.target_account_id]) value WHERE NOT EXISTS(
        SELECT 1 FROM public.meta_account_transition_reservations reservation WHERE reservation.tenant_id=p.tenant_id
         AND reservation.transition_id=p.id AND reservation.account_id=value AND reservation.released_at IS NULL))))
    THEN RAISE EXCEPTION 'Meta funding requires its exact private read receipt' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.tenant_id,NEW.id,NEW.account_id,NEW.connection_id,NEW.created_at) IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.account_id,OLD.connection_id,OLD.created_at)
    OR NEW.revision<OLD.revision OR (OLD.state='RETIRED' AND NEW.state<>'RETIRED') THEN RAISE EXCEPTION 'Meta binding identity is immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.provider_session_id,NEW.phone_number_id,NEW.app_id,NEW.secret_reference,NEW.credential_fingerprint,NEW.proof_sha256,NEW.state)
    IS DISTINCT FROM (OLD.provider_session_id,OLD.phone_number_id,OLD.app_id,OLD.secret_reference,OLD.credential_fingerprint,OLD.proof_sha256,OLD.state)
    AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Meta binding generation must advance' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION app.meta_account_successor_activation(connection_value uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('transitionId',p.id,'sessionId',b.provider_session_id,
  'identityReceiptSha256',encode(public.digest(p.identity_successor_receipt::text,'sha256'),'hex'))
 FROM public.meta_connection_account_bindings b
 JOIN public.meta_account_transitions p ON p.tenant_id=b.tenant_id AND p.id=b.account_transition_id AND p.target_account_id=b.account_id
 JOIN public.meta_connection_account_bindings predecessor ON predecessor.tenant_id=b.tenant_id AND predecessor.id=b.predecessor_binding_id
 JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id AND s.connection_id=b.connection_id
 WHERE b.tenant_id=app.current_tenant_id() AND b.connection_id=connection_value AND b.state<>'RETIRED'
  AND p.execution_state='RECONCILED_PAUSED' AND p.reconciled_at IS NOT NULL
  AND ((p.transition_kind<>'LEGACY_PHONE' AND p.identity_successor_receipt->>'claim'='SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR')
   OR (p.transition_kind='LEGACY_PHONE' AND p.identity_successor_receipt->>'claim'='SAME_GRAPH_PHONE_LEGACY_SUCCESSOR'
    AND app.meta_account_identity_receipt_valid(p.id)))
  AND predecessor.state='RETIRED' AND predecessor.account_id=p.source_account_id
  AND predecessor.connection_id=b.connection_id AND predecessor.phone_number_id=b.phone_number_id
  AND predecessor.app_id=b.app_id AND s.ownership_state='ACTIVE' AND s.opaque_session_id=b.phone_number_id
  AND s.provider_state_data#>>'{metaAccountTransition,purpose}'=CASE WHEN p.transition_kind='LEGACY_PHONE' THEN 'LEGACY_SUCCESSOR' ELSE 'ACCOUNT_SUCCESSOR' END
  AND s.provider_state_data#>>'{metaAccountTransition,id}'=p.id::text
$$;
CREATE OR REPLACE FUNCTION app.meta_account_alias_export_receipt(alias_value uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT jsonb_build_object('schemaVersion',1,'claim',p.identity_successor_receipt->'claim',
  'transitionId',p.id,'operationId',p.identity_successor_receipt->'operationId',
  'sourceAccountId',p.source_account_id,'targetAccountId',p.target_account_id,
  'migrationId',p.provider_migration_id,'initiateCheckpointId',p.identity_successor_receipt->'initiateCheckpointId',
  'completeCheckpointId',p.identity_successor_receipt->'completeCheckpointId',
  'completionObservationOperationId',p.identity_successor_receipt->'completionObservationOperationId',
  'sourceScopeSha256',p.execution_scope_sha256,'targetProofSha256',p.identity_successor_receipt->'targetProofSha256',
  'asset',pair,'appliedAt',p.identity_successor_receipt->'appliedAt')
  || CASE WHEN p.transition_kind='LEGACY_PHONE' THEN jsonb_build_object(
   'registrationCheckpointId',p.identity_successor_receipt->'registrationCheckpointId',
   'authorizationOperationId',p.identity_successor_receipt->'authorizationOperationId') ELSE '{}'::jsonb END
 FROM public.meta_direct_identity_aliases a JOIN public.meta_account_transitions p ON p.tenant_id=a.tenant_id AND p.id=a.account_transition_id
 CROSS JOIN LATERAL jsonb_array_elements(p.identity_successor_receipt->'assets') pair
 WHERE a.tenant_id=app.current_tenant_id() AND a.id=alias_value AND app.meta_account_alias_lineage_valid(a.id)
  AND pair->>'connectionId'=a.connection_id::text
  AND pair->'targetAsset'=jsonb_build_object('providerSessionId',a.provider_session_id::text,'phoneNumberId',a.phone_number_id,'wabaId',a.waba_id)
$$;


-- Fragment: META_LEGACY_MIGRATION_PRIVACY.sql
-- Private WIP. Reuse the existing LOCAL tenant erasure and operation audit.

CREATE FUNCTION app.redact_meta_legacy_migrations(job_value uuid,lease_value uuid,fence_value bigint) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE j public.privacy_jobs;p public.meta_account_transitions;target_account uuid;count_value integer:=0;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||app.current_tenant_id()::text,0));
 SELECT * INTO j FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value FOR UPDATE;
 IF j.id IS NULL OR j.job_type<>'DELETE' OR j.scope_type<>'TENANT' OR j.scope_value<>j.tenant_id::text
  OR j.state<>'RUNNING' OR j.stage<>'LOCAL' OR j.lease_id IS DISTINCT FROM lease_value OR j.fencing_token IS DISTINCT FROM fence_value
  OR j.lease_expires_at<=clock_timestamp() OR NOT app.meta_managed_privacy_authorized(j.tenant_id) THEN
  RAISE EXCEPTION 'Current tenant privacy authority is required' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c JOIN public.meta_account_transitions transition_row
  ON transition_row.tenant_id=c.tenant_id AND transition_row.id=c.owner_id AND transition_row.transition_kind='LEGACY_PHONE'
  WHERE c.tenant_id=j.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.stage='LEGACY_REGISTER'
   AND (c.outcome IN('ATTEMPTED','UNKNOWN') OR (c.outcome='SUCCEEDED' AND transition_row.reconciled_at IS NULL)))
  OR EXISTS(SELECT 1 FROM public.connection_operations WHERE tenant_id=j.tenant_id AND payload ? 'metaLegacyMigration'
   AND state='RUNNING' AND lease_expires_at>=clock_timestamp()) THEN
  RAISE EXCEPTION 'Original migration recovery must finish before erasure' USING ERRCODE='55000';END IF;
 FOR p IN SELECT * FROM public.meta_account_transitions WHERE tenant_id=j.tenant_id AND transition_kind='LEGACY_PHONE' ORDER BY id LOOP
  SELECT account_id INTO target_account FROM public.meta_connection_account_bindings WHERE tenant_id=p.tenant_id AND id=p.legacy_target_binding_id;
  PERFORM app.lock_meta_transition_accounts(ARRAY[p.source_account_id,target_account]);
  UPDATE public.connection_operations SET state='CANCELLED',completed_at=clock_timestamp(),updated_at=now(),lease_id=NULL,lease_expires_at=NULL
   WHERE tenant_id=p.tenant_id AND id=p.legacy_operation_id AND state IN('STAGED','QUEUED','FAILED_RETRYABLE','RUNNING');
  IF p.state<>'CANCELLED' AND p.reconciled_at IS NULL THEN
   UPDATE public.meta_account_transitions SET state='CANCELLED',cancelled_at=clock_timestamp(),revision=revision+1,updated_at=now()
    WHERE tenant_id=p.tenant_id AND id=p.id;
   UPDATE public.meta_account_transition_reservations SET released_at=clock_timestamp(),release_reason='PRE_EFFECT_CANCEL',revision=revision+1
    WHERE tenant_id=p.tenant_id AND transition_id=p.id AND released_at IS NULL;
  END IF;
 END LOOP;
 UPDATE public.connection_operations SET result=jsonb_set(result,'{metaLegacyAuthorizationProof}',jsonb_build_object('redacted',true,
  'sha256',encode(public.digest((result->'metaLegacyAuthorizationProof')::text,'sha256'),'hex')))
 WHERE tenant_id=j.tenant_id AND state='SUCCEEDED' AND payload ? 'metaLegacyAuthorization'
  AND result ? 'metaLegacyAuthorizationProof' AND NOT(result->'metaLegacyAuthorizationProof' ? 'redacted');
 UPDATE public.connection_operations SET payload=jsonb_build_object('redacted',true,'sha256',encode(public.digest(payload::text,'sha256'),'hex')),
  result=CASE WHEN result IS NULL OR result ? 'redacted' THEN result ELSE jsonb_build_object('redacted',true,'sha256',encode(public.digest(result::text,'sha256'),'hex')) END,
  updated_at=now() WHERE tenant_id=j.tenant_id AND payload ? 'metaLegacyMigration' AND state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED');
 GET DIAGNOSTICS count_value=ROW_COUNT;
 -- Immutable operation actor/key/IDs and original checkpoint hashes retain
 -- existing audit policy. No provider receipt or unknown effect is destroyed.
 RETURN count_value;
END $$;
ALTER FUNCTION app.redact_meta_legacy_migrations(uuid,uuid,bigint) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.redact_meta_legacy_migrations(uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.redact_meta_legacy_migrations(uuid,uuid,bigint) TO wasalx_connector_worker;


-- Fragment: META_ACCOUNT_TRANSITION_SECRET_RETENTION.sql
-- Unapplied P09 observer extension to the reviewed P05 cleanup SSOT.
-- Preserve role ownership and ACLs; apply after P05/observer tables.

-- No broad operation-payload or transition-table grant to the cleanup login.
-- Only its existing ungranted executor can read this exact-owner hold predicate.
CREATE OR REPLACE FUNCTION app.meta_transition_observer_secret_retained(tenant_value uuid,connection_value uuid,operation_value uuid,reference_value text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.connection_operations observer
          JOIN public.meta_signup_attempts attempt ON attempt.tenant_id=observer.tenant_id AND attempt.operation_id=observer.id
          JOIN public.meta_account_transitions transition ON transition.tenant_id=attempt.tenant_id AND transition.id=attempt.target_transition_id
          WHERE observer.tenant_id=tenant_value
            AND observer.id=operation_value AND observer.connection_id=connection_value
            AND observer.payload->>'newSecretReference'=reference_value
            AND ((attempt.purpose='TRANSITION_READBACK' AND (
              (EXISTS(SELECT 1 FROM jsonb_each_text(transition.observer_operations) selected WHERE selected.value=observer.id::text)
               AND EXISTS(SELECT 1 FROM public.meta_account_transition_reservations reservation
                WHERE reservation.tenant_id=transition.tenant_id AND reservation.transition_id=transition.id AND reservation.released_at IS NULL))
              OR EXISTS(SELECT 1 FROM public.connection_operations original
               JOIN public.meta_provider_effect_checkpoints checkpoint ON checkpoint.tenant_id=original.tenant_id AND checkpoint.original_operation_id=original.id
               WHERE original.tenant_id=observer.tenant_id AND checkpoint.owner_kind='ACCOUNT_TRANSITION' AND checkpoint.owner_id=transition.id
                AND checkpoint.outcome IN('ATTEMPTED','UNKNOWN') AND EXISTS(
                 SELECT 1 FROM jsonb_each_text(original.payload#>'{metaAccountTransitionExecution,observerOperationIds}') selected
                  WHERE selected.value=observer.id::text))
            )) OR (attempt.purpose='LEGACY_MIGRATION' AND transition.transition_kind='LEGACY_PHONE' AND (
              (transition.legacy_authorization_operation_id=observer.id AND transition.state<>'CANCELLED' AND transition.reconciled_at IS NULL)
              OR EXISTS(SELECT 1 FROM public.connection_operations original
               JOIN public.meta_provider_effect_checkpoints checkpoint ON checkpoint.tenant_id=original.tenant_id AND checkpoint.original_operation_id=original.id
               WHERE original.tenant_id=observer.tenant_id AND checkpoint.owner_kind='ACCOUNT_TRANSITION' AND checkpoint.owner_id=transition.id
                AND checkpoint.stage='LEGACY_REGISTER' AND checkpoint.outcome IN('ATTEMPTED','UNKNOWN')
                AND original.payload#>>'{metaLegacyMigration,authorizationOperationId}'=observer.id::text)
            ))));
$$;
REVOKE ALL ON FUNCTION app.meta_transition_observer_secret_retained(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_transition_observer_secret_retained(uuid,uuid,uuid,text) TO wasalx_secret_cleanup_executor;

CREATE OR REPLACE FUNCTION app.expire_secret_provisioning_stages()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE candidate record;prior_tenant text:=current_setting('app.tenant_id',true);
BEGIN
  -- A removed actor or stale target may need operator review. This finite status
  -- is evidence of a retained stage, not evidence of absence or permission to delete.
  UPDATE connection_operations SET error_code='META_SIGNUP_STAGE_REVIEW_REQUIRED',
    safe_error='Review or cancel this retained account access stage after confirming its exact credential state.',updated_at=clock_timestamp()
    WHERE id IN (SELECT id FROM connection_operations WHERE state='STAGED'
      AND payload->>'metaSignupPurpose' IN ('RECONNECT','ADD_ACCESS','TRANSITION_READBACK','LEGACY_MIGRATION') AND updated_at<=clock_timestamp()-interval '1 hour'
      AND error_code IS DISTINCT FROM 'META_SIGNUP_STAGE_REVIEW_REQUIRED'
      ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED);
  FOR candidate IN
    SELECT operation.id,operation.tenant_id,operation.connection_id,
           operation.operation_type,operation.requested_by_id,operation.request_id
      FROM connection_operations operation
     WHERE operation.state='STAGED'
       AND COALESCE(operation.payload->>'metaSignupPurpose','') NOT IN ('RECONNECT','ADD_ACCESS','TRANSITION_READBACK','LEGACY_MIGRATION')
       AND operation.updated_at<=clock_timestamp()-interval '1 hour'
     ORDER BY operation.updated_at,operation.id
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    -- Bind only the selected maintenance row; restore the caller context before the next candidate.
    PERFORM set_config('app.tenant_id',candidate.tenant_id::text,true);
    UPDATE connection_operations
       SET state='FAILED_TERMINAL',error_code='CREDENTIAL_STAGE_EXPIRED',
           safe_error='Credential provisioning expired before it completed.',
           completed_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE tenant_id=candidate.tenant_id AND id=candidate.id AND state='STAGED';
    IF FOUND THEN
      IF candidate.operation_type='PROVISION' THEN
        UPDATE connections
           SET state='REVOKED',action_reason='Credential provisioning expired.',
               updated_at=clock_timestamp()
         WHERE tenant_id=candidate.tenant_id AND id=candidate.connection_id
           AND state='PROVISIONING';
        UPDATE webhook_routes
           SET state='REVOKED',updated_at=clock_timestamp()
         WHERE tenant_id=candidate.tenant_id AND connection_id=candidate.connection_id
           AND state<>'REVOKED';
      END IF;
      INSERT INTO audit_events(
        tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
      ) VALUES (
        candidate.tenant_id,'SYSTEM','secret-cleanup','connection.credential_stage_expired',
        'connection',candidate.connection_id::text,
        jsonb_build_object('operation_id',candidate.id,'operation_type',candidate.operation_type),
        candidate.request_id
      );
    END IF;
    PERFORM set_config('app.tenant_id',COALESCE(prior_tenant,''),true);
  END LOOP;

  FOR candidate IN
    SELECT integration.id,integration.tenant_id
      FROM client_routing_integrations integration
     WHERE integration.state='CONNECTING'
       AND integration.updated_at<=clock_timestamp()-interval '1 hour'
     ORDER BY integration.updated_at,integration.id
     FOR UPDATE SKIP LOCKED
     LIMIT 100
  LOOP
    -- Bind only the selected maintenance row; restore the caller context before the next candidate.
    PERFORM set_config('app.tenant_id',candidate.tenant_id::text,true);
    UPDATE client_routing_integrations
       SET state='REVOKED',revision=revision+1,updated_at=clock_timestamp()
     WHERE tenant_id=candidate.tenant_id AND id=candidate.id AND state='CONNECTING';
    IF FOUND THEN
      INSERT INTO audit_events(
        tenant_id,actor_type,actor_id,action,target_type,target_id,new_value,request_id
      ) VALUES (
        candidate.tenant_id,'SYSTEM','secret-cleanup','client_routing.integration_expired',
        'client_routing_integration',candidate.id::text,
        jsonb_build_object('reason','CREDENTIAL_STAGE_EXPIRED'),
        'secret-cleanup:'||candidate.id::text
      );
    END IF;
    PERFORM set_config('app.tenant_id',COALESCE(prior_tenant,''),true);
  END LOOP;
END
$$;

-- Preserve legal holds for all rotation-owned references before claim selection.
CREATE OR REPLACE FUNCTION app.claim_secret_cleanup_tasks(
  worker_lease uuid,
  claim_limit integer DEFAULT 25
)
RETURNS TABLE (
  task_id uuid,
  tenant_id uuid,
  secret_reference text,
  attempts integer,
  max_attempts integer,
  fencing_token bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp
SET row_security=off
AS $$
BEGIN
  IF worker_lease IS NULL THEN
    RAISE EXCEPTION 'worker lease is required' USING ERRCODE='22023';
  END IF;
  IF claim_limit<1 OR claim_limit>100 THEN
    RAISE EXCEPTION 'claim limit must be between 1 and 100' USING ERRCODE='22023';
  END IF;

  PERFORM app.expire_secret_provisioning_stages();
  PERFORM app.expire_meta_signup_attempts();

  UPDATE public.secret_cleanup_outbox AS exhausted
     SET state='FAILED_TERMINAL',lease_id=NULL,lease_expires_at=NULL,
         error_code=COALESCE(exhausted.error_code,'MAX_ATTEMPTS_EXHAUSTED'),
         safe_error=COALESCE(exhausted.safe_error,'Secret cleanup exhausted its retry limit.'),
         completed_at=now(),updated_at=now()
   WHERE exhausted.attempts>=exhausted.max_attempts
     AND (exhausted.state IN ('QUEUED','FAILED_RETRYABLE')
       OR (exhausted.state='RUNNING' AND exhausted.lease_expires_at<now()));

  RETURN QUERY
  UPDATE public.secret_cleanup_outbox AS cleanup
     SET lease_id=worker_lease,lease_expires_at=now()+interval '60 seconds',
         fencing_token=cleanup.fencing_token+1,state='RUNNING',
         attempts=cleanup.attempts+1,error_code=NULL,safe_error=NULL,updated_at=now()
   WHERE cleanup.id IN (
     SELECT candidate.id
       FROM public.secret_cleanup_outbox AS candidate
      WHERE candidate.attempts<candidate.max_attempts
        AND ((candidate.state IN ('QUEUED','FAILED_RETRYABLE') AND candidate.available_at<=now())
          OR (candidate.state='RUNNING' AND candidate.lease_expires_at<now()))
        AND app.secret_cleanup_reference_is_owned(
          candidate.cleanup_kind,
          candidate.tenant_id,
          candidate.connection_id,
          candidate.connection_operation_id,
          candidate.routing_integration_id,
          candidate.bot_action_credential_stage_id,
          candidate.secret_reference
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta_signup_attempts attempt
          JOIN privacy_legal_holds hold ON hold.tenant_id=attempt.tenant_id AND hold.released_at IS NULL
          WHERE attempt.tenant_id=candidate.tenant_id AND attempt.operation_id=candidate.connection_operation_id
            AND attempt.purpose IN ('RECONNECT','ADD_ACCESS','TRANSITION_READBACK','LEGACY_MIGRATION')
        )
        AND (candidate.cleanup_kind<>'CONNECTION_CREDENTIAL' OR NOT app.meta_transition_observer_secret_retained(
          candidate.tenant_id,candidate.connection_id,candidate.connection_operation_id,candidate.secret_reference))
        AND (candidate.cleanup_kind NOT IN ('WEBHOOK_SECRET','CONNECTION_CREDENTIAL') OR EXISTS (
          SELECT 1
            FROM connection_operations operation
            JOIN tenants tenant ON tenant.id=operation.tenant_id
           WHERE operation.tenant_id=candidate.tenant_id
             AND operation.id=candidate.connection_operation_id
             AND operation.state<>'STAGED'
             AND (
               tenant.state='DELETING'
               OR (candidate.cleanup_kind='WEBHOOK_SECRET' AND NOT EXISTS (
                 SELECT 1 FROM webhook_routes route
                  WHERE route.tenant_id=candidate.tenant_id
                    AND route.hmac_secret_reference=candidate.secret_reference
                    AND route.state<>'REVOKED'
               ))
               OR (candidate.cleanup_kind='CONNECTION_CREDENTIAL' AND NOT EXISTS (
                 SELECT 1 FROM connections connection
                  WHERE connection.tenant_id=candidate.tenant_id
                    AND connection.secret_reference=candidate.secret_reference
                    AND connection.state<>'REVOKED'
               ))
             )
        ))
        AND (candidate.cleanup_kind<>'ROUTING_INTEGRATION_SECRET' OR EXISTS (
          SELECT 1 FROM client_routing_integrations integration
          JOIN tenants tenant ON tenant.id=integration.tenant_id
          WHERE integration.tenant_id=candidate.tenant_id
            AND integration.id=candidate.routing_integration_id
            AND (integration.state='REVOKED' OR tenant.state='DELETING')
        ) AND NOT EXISTS (
          SELECT 1 FROM client_routing_source_state source
           WHERE source.tenant_id=candidate.tenant_id
             AND source.secret_reference=candidate.secret_reference
             AND source.state<>'RETIRED'
        ) AND NOT EXISTS (
          SELECT 1 FROM bot_action_definitions action
           WHERE action.tenant_id=candidate.tenant_id
             AND action.secret_reference=candidate.secret_reference
             AND action.state='ACTIVE'
        ) AND NOT EXISTS (
          SELECT 1 FROM bot_action_jobs job
          JOIN bot_action_revisions revision
            ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
           WHERE job.tenant_id=candidate.tenant_id
             AND revision.secret_reference=candidate.secret_reference
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
        ) AND NOT EXISTS (
          SELECT 1 FROM group_action_executions execution
           WHERE execution.tenant_id=candidate.tenant_id
             AND execution.action_snapshot->>'secretReference'=candidate.secret_reference
             AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
        ) AND NOT EXISTS (
          SELECT 1 FROM client_routing_sync_jobs job
          JOIN client_routing_source_state source
            ON source.tenant_id=job.tenant_id AND source.id=job.source_state_id
           WHERE job.tenant_id=candidate.tenant_id
             AND source.secret_reference=candidate.secret_reference
             AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')
        ))
        AND (candidate.cleanup_kind<>'BOT_ACTION_CREDENTIAL_STAGE' OR EXISTS (
          SELECT 1 FROM bot_action_credential_stages stage
          JOIN tenants tenant ON tenant.id=stage.tenant_id
          WHERE stage.tenant_id=candidate.tenant_id
            AND stage.id=candidate.bot_action_credential_stage_id
            AND (
              (stage.state='STAGED' AND stage.expires_at<=clock_timestamp())
              OR (stage.state='BOUND' AND (tenant.state='DELETING' OR (
                NOT EXISTS (
                  SELECT 1 FROM bot_action_definitions action
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=action.tenant_id AND revision.id=action.active_revision_id
                  WHERE action.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                ) AND NOT EXISTS (
                  SELECT 1 FROM automation_action_revision_pins pin
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=pin.tenant_id AND revision.id=pin.action_revision_id
                  LEFT JOIN bot_flow_versions flow
                    ON flow.tenant_id=pin.tenant_id AND flow.id=pin.bot_flow_version_id
                  LEFT JOIN rule_sets rule_set
                    ON rule_set.tenant_id=pin.tenant_id AND rule_set.id=pin.rule_set_id
                  WHERE pin.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                    AND ((pin.bot_flow_version_id IS NOT NULL AND (
                      flow.state='ACTIVE' OR EXISTS (
                        SELECT 1 FROM bot_conversations conversation
                        WHERE conversation.tenant_id=flow.tenant_id
                          AND conversation.flow_version_id=flow.id
                          AND conversation.state<>'RESOLVED'
                      )
                    )) OR (pin.rule_set_id IS NOT NULL AND (
                      rule_set.state='ACTIVE' OR EXISTS (
                        SELECT 1 FROM event_inbox inbox
                        WHERE inbox.tenant_id=rule_set.tenant_id
                          AND inbox.governing_rule_set_id=rule_set.id
                          AND inbox.status IN ('ACCEPTED','PROCESSING','FAILED_RETRYABLE')
                      )
                    )))
                ) AND NOT EXISTS (
                  SELECT 1 FROM bot_action_jobs job
                  JOIN bot_action_revisions revision
                    ON revision.tenant_id=job.tenant_id AND revision.id=job.action_revision_id
                  WHERE job.tenant_id=stage.tenant_id
                    AND revision.secret_reference=stage.secret_reference
                    AND job.state IN ('QUEUED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                ) AND NOT EXISTS (
                  SELECT 1 FROM group_action_executions execution
                  WHERE execution.tenant_id=stage.tenant_id
                    AND execution.action_snapshot->>'secretReference'=stage.secret_reference
                    AND execution.state IN ('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN')
                )
              )))
            )
          FOR UPDATE OF stage SKIP LOCKED
        ))
        AND (candidate.cleanup_kind<>'META_SIGNUP_CREDENTIAL' OR EXISTS (
          SELECT 1 FROM meta_signup_attempts attempt JOIN tenants tenant ON tenant.id=attempt.tenant_id
          WHERE attempt.tenant_id=candidate.tenant_id AND attempt.id=candidate.meta_signup_attempt_id
            AND attempt.secret_reference=candidate.secret_reference
            AND attempt.status NOT IN ('EXCHANGING','OUTCOME_UNKNOWN','PROVISIONING')
            AND (attempt.status IN ('CANCELLED','EXPIRED','FAILED') OR attempt.expires_at<clock_timestamp() OR tenant.state='DELETING')
            AND NOT EXISTS (SELECT 1 FROM privacy_legal_holds hold WHERE hold.tenant_id=attempt.tenant_id AND hold.released_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM connections connection WHERE connection.tenant_id=attempt.tenant_id
              AND connection.secret_reference=attempt.secret_reference AND connection.state<>'REVOKED')
            AND (attempt.connection_id IS NULL OR EXISTS (
              SELECT 1 FROM connection_operations operation WHERE operation.tenant_id=attempt.tenant_id AND operation.id=attempt.operation_id
                AND operation.state IN ('SUCCEEDED','FAILED_TERMINAL','CANCELLED')
            ))
          FOR UPDATE OF attempt SKIP LOCKED
        ))
      ORDER BY candidate.available_at,candidate.created_at,candidate.id
      FOR UPDATE SKIP LOCKED
      LIMIT claim_limit
   )
  RETURNING cleanup.id,cleanup.tenant_id,cleanup.secret_reference,
            cleanup.attempts,cleanup.max_attempts,cleanup.fencing_token;
END
$$;


-- Fragment: META_TEMPLATE_COMPANION_GUARDS.sql
-- Exact inherited guard bodies with finite template-purpose extensions.

CREATE OR REPLACE FUNCTION app.preserve_meta_transition_observation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE privacy_current boolean;
BEGIN
 IF TG_OP='UPDATE' AND current_user='wasalx_meta_transition_executor' AND (OLD.payload ? 'metaTemplatePreparation' OR OLD.payload ? 'metaLegacyMigration')
  AND NEW.payload=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.payload::text,'sha256'),'hex'))
  AND NEW.result IS NOT DISTINCT FROM (CASE WHEN OLD.result IS NULL OR OLD.result ? 'redacted' THEN OLD.result
    ELSE jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex')) END)
  AND (to_jsonb(NEW)-ARRAY['payload','result','updated_at'])=(to_jsonb(OLD)-ARRAY['payload','result','updated_at'])
  AND OLD.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED') THEN
  IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.operation_type='PREVIEW_META_ACCOUNT_TRANSITION' AND NEW.result IS NOT NULL THEN
     RAISE EXCEPTION 'Preview observations require a claimed read operation' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.operation_type<>'PREVIEW_META_ACCOUNT_TRANSITION' AND (TG_OP='DELETE' OR NEW.operation_type<>'PREVIEW_META_ACCOUNT_TRANSITION') THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 SELECT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE' AND scope_type='TENANT'
   AND scope_value=OLD.tenant_id::text AND state='RUNNING' AND stage='LOCAL' AND lease_id IS NOT NULL AND lease_expires_at>=clock_timestamp())
   INTO privacy_current;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Preview observation history is retained' USING ERRCODE='23514'; END IF;
 IF (NEW.id,NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.payload,NEW.requested_by_type,NEW.requested_by_id,NEW.idempotency_key)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.payload,OLD.requested_by_type,OLD.requested_by_id,OLD.idempotency_key)
   THEN RAISE EXCEPTION 'Preview operation identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.result IS DISTINCT FROM OLD.result THEN
   IF privacy_current AND OLD.result IS NOT NULL AND NEW.result=jsonb_build_object('redacted',true,
     'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex')) THEN RETURN NEW; END IF;
   IF OLD.result IS NOT NULL OR OLD.state<>'RUNNING' OR OLD.lease_id IS NULL OR OLD.lease_expires_at<clock_timestamp()
     OR NOT(pg_has_role(current_user,'wasalx_connector_worker','member') OR (current_user='wasalx_meta_transition_executor'
      AND OLD.payload ? 'metaTemplatePreparation' AND EXISTS(SELECT 1 FROM public.meta_account_transitions p
       WHERE p.tenant_id=OLD.tenant_id AND p.id=(OLD.payload#>>'{metaTemplatePreparation,id}')::uuid
        AND p.transition_kind='TEMPLATE_PREPARATION' AND p.template_operation_id=OLD.id))) THEN
     RAISE EXCEPTION 'Preview result requires its current worker lease' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.preserve_meta_transition_execution_operation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_user='wasalx_meta_transition_executor' AND (OLD.payload ? 'metaTemplatePreparation' OR OLD.payload ? 'metaLegacyMigration')
  AND NEW.payload=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.payload::text,'sha256'),'hex'))
  AND NEW.result IS NOT DISTINCT FROM (CASE WHEN OLD.result IS NULL OR OLD.result ? 'redacted' THEN OLD.result
    ELSE jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex')) END)
  AND (to_jsonb(NEW)-ARRAY['payload','result','updated_at'])=(to_jsonb(OLD)-ARRAY['payload','result','updated_at'])
  AND OLD.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED') THEN
  IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.operation_type='EXECUTE_META_ACCOUNT_TRANSITION' AND current_user<>'wasalx_meta_transition_executor' THEN
   RAISE EXCEPTION 'Execution requires sealed transition admission' USING ERRCODE='42501';END IF;RETURN NEW;
 END IF;
 IF OLD.operation_type<>'EXECUTE_META_ACCOUNT_TRANSITION' THEN
  IF TG_OP='UPDATE' AND NEW.operation_type='EXECUTE_META_ACCOUNT_TRANSITION' THEN RAISE EXCEPTION 'Operation kind is immutable' USING ERRCODE='23514';END IF;
  RETURN COALESCE(NEW,OLD);
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Original transition operation is retained' USING ERRCODE='55000';END IF;
 IF (NEW.id,NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.idempotency_key,NEW.payload,NEW.requested_by_id,NEW.requested_by_type,NEW.max_attempts)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.idempotency_key,OLD.payload,OLD.requested_by_id,OLD.requested_by_type,OLD.max_attempts) THEN
  RAISE EXCEPTION 'Original transition operation is immutable' USING ERRCODE='23514';END IF;
 IF OLD.state IN('SUCCEEDED','FAILED_TERMINAL','CANCELLED') AND NEW.state<>OLD.state THEN
  RAISE EXCEPTION 'Terminal transition operation cannot dispatch again' USING ERRCODE='23514';END IF;
 IF NEW.result IS DISTINCT FROM OLD.result THEN
  IF OLD.result IS NOT NULL AND NEW.result=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.result::text,'sha256'),'hex'))
   AND EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND scope_type='TENANT' AND scope_value=OLD.tenant_id::text
    AND job_type='DELETE' AND stage='LOCAL' AND state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at>=clock_timestamp()) THEN RETURN NEW;END IF;
  IF current_user<>'wasalx_meta_transition_executor' OR OLD.result IS NOT NULL THEN
   RAISE EXCEPTION 'Transition observation requires its exact sealed lease' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.preserve_meta_transition() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE operation_row public.connection_operations;
BEGIN
 IF TG_OP='UPDATE' AND OLD.transition_kind='TEMPLATE_PREPARATION' AND current_user='wasalx_meta_transition_executor'
  AND NEW.template_observation=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.template_observation::text,'sha256'),'hex'))
  AND (to_jsonb(NEW)-ARRAY['template_observation','updated_at'])=(to_jsonb(OLD)-ARRAY['template_observation','updated_at']) THEN
  IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW;END IF;
 END IF;
 IF TG_OP='UPDATE' AND current_user='wasalx_meta_transition_executor'
  AND NEW.execution_scope=jsonb_build_object('redacted',true,'sha256',encode(public.digest(OLD.execution_scope::text,'sha256'),'hex'))
  AND (to_jsonb(NEW)-ARRAY['execution_scope','updated_at'])=(to_jsonb(OLD)-ARRAY['execution_scope','updated_at'])
  AND EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE' AND scope_type='TENANT'
   AND scope_value=OLD.tenant_id::text AND stage='LOCAL' AND state='RUNNING' AND lease_id IS NOT NULL AND lease_expires_at>clock_timestamp()) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
   IF (OLD.execution_scope IS NOT NULL OR OLD.execution_scope_sha256 IS NOT NULL)
    AND (NEW.execution_scope,NEW.execution_scope_sha256) IS DISTINCT FROM (OLD.execution_scope,OLD.execution_scope_sha256) THEN
    RAISE EXCEPTION 'Original transition execution scope is immutable' USING ERRCODE='23514';END IF;
   IF (NEW.tenant_id,NEW.id,NEW.source_account_id,NEW.initiating_connection_id,NEW.initiating_binding_id,
     NEW.requested_mode,NEW.target_currency,NEW.request_sha256,NEW.idempotency_key,NEW.initial_account_revision,NEW.initial_binding_revision,NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.source_account_id,OLD.initiating_connection_id,OLD.initiating_binding_id,
     OLD.requested_mode,OLD.target_currency,OLD.request_sha256,OLD.idempotency_key,OLD.initial_account_revision,OLD.initial_binding_revision,OLD.created_at)
     THEN RAISE EXCEPTION 'Transition intent is immutable' USING ERRCODE='23514'; END IF;
   IF OLD.requested_by IS NOT NULL AND NEW.requested_by IS NULL AND
     (to_jsonb(NEW)-'requested_by')=(to_jsonb(OLD)-'requested_by') THEN
     IF pg_has_role(session_user,'wasalx_connector_worker','MEMBER') THEN
       IF app.meta_managed_privacy_authorized(OLD.tenant_id) THEN RETURN NEW; END IF;
     ELSE
       IF (NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=OLD.tenant_id AND user_id=OLD.requested_by)
       OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND job_type='DELETE'
         AND scope_type='TENANT' AND scope_value=OLD.tenant_id::text AND state='RUNNING' AND stage='LOCAL'
         AND lease_id IS NOT NULL AND lease_expires_at>=clock_timestamp())) THEN RETURN NEW; END IF;
     END IF;
   END IF;
   IF NEW.requested_by IS DISTINCT FROM OLD.requested_by OR OLD.state='CANCELLED' OR NEW.revision<>OLD.revision+1
     THEN RAISE EXCEPTION 'Transition revision is not current' USING ERRCODE='23514'; END IF;
 ELSE
   IF NEW.requested_by IS NULL OR NEW.revision<>1 OR NEW.state<>'PENDING' THEN
     RAISE EXCEPTION 'Transition creation is invalid' USING ERRCODE='23514'; END IF;
 END IF;
 SELECT * INTO operation_row FROM public.connection_operations WHERE tenant_id=NEW.tenant_id AND id=NEW.current_observation_operation_id;
 IF NOT FOUND OR operation_row.operation_type<>'PREVIEW_META_ACCOUNT_TRANSITION'
   OR operation_row.payload#>>'{metaAccountTransition,id}' IS DISTINCT FROM NEW.id::text
   OR operation_row.payload#>>'{metaAccountTransition,accountId}' IS DISTINCT FROM NEW.source_account_id::text THEN
   RAISE EXCEPTION 'Transition observation binding is invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND current_user<>'wasalx_meta_transition_executor' AND
  (NEW.execution_state,NEW.execution_scope,NEW.execution_scope_sha256,NEW.execution_authorization_id,NEW.execution_operation_id,
   NEW.execution_confirmation_sha256,NEW.provider_migration_id,NEW.target_account_id,NEW.provider_status,
   NEW.provider_observation_operation_id,NEW.identity_successor_receipt,NEW.reconciled_at)
  IS DISTINCT FROM (OLD.execution_state,OLD.execution_scope,OLD.execution_scope_sha256,OLD.execution_authorization_id,OLD.execution_operation_id,
   OLD.execution_confirmation_sha256,OLD.provider_migration_id,OLD.target_account_id,OLD.provider_status,
   OLD.provider_observation_operation_id,OLD.identity_successor_receipt,OLD.reconciled_at) THEN
  RAISE EXCEPTION 'Execution state requires its sealed coordinator' USING ERRCODE='42501';END IF;
 IF TG_OP='INSERT' AND (NEW.execution_state<>'UNPREPARED' OR NEW.execution_scope IS NOT NULL OR NEW.execution_authorization_id IS NOT NULL
  OR NEW.execution_operation_id IS NOT NULL OR NEW.provider_migration_id IS NOT NULL OR NEW.target_account_id IS NOT NULL
  OR NEW.identity_successor_receipt IS NOT NULL) THEN RAISE EXCEPTION 'Caller cannot insert execution evidence' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND OLD.execution_state<>'UNPREPARED' AND current_user<>'wasalx_meta_transition_executor' THEN
  RAISE EXCEPTION 'Reserved transition cannot be refreshed or relabelled' USING ERRCODE='55000';END IF;
 IF TG_OP='UPDATE' AND OLD.identity_successor_receipt IS NOT NULL AND NEW.identity_successor_receipt IS DISTINCT FROM OLD.identity_successor_receipt THEN
  RAISE EXCEPTION 'Identity successor receipt is immutable' USING ERRCODE='23514';END IF;
 IF NEW.state IN ('PREVIEW','BLOCKED') AND current_user<>'wasalx_meta_transition_executor' AND NOT pg_has_role(current_user,'wasalx_connector_worker','member') THEN
   RAISE EXCEPTION 'Only a qualified observation can update the preview' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION app.preserve_meta_financial_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Financial effect history must be retained' USING ERRCODE='55000';END IF;
 IF OLD.outcome NOT IN('ATTEMPTED','UNKNOWN') AND NOT(OLD.result ? 'redacted')
  AND NEW.result=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.result::text,'sha256'),'hex'))
  AND pg_has_role(current_user,'wasalx_connector_worker','MEMBER') AND app.meta_managed_privacy_authorized(OLD.tenant_id)
  AND (to_jsonb(NEW)-'result') IS NOT DISTINCT FROM (to_jsonb(OLD)-'result') THEN RETURN NEW;END IF;
 IF NEW.result IS DISTINCT FROM OLD.result AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID))
  AND NOT(current_user='wasalx_meta_transition_executor' AND OLD.owner_kind='ACCOUNT_TRANSITION' AND (OLD.stage IN('INITIATE','COMPLETE') OR EXISTS(
   SELECT 1 FROM public.meta_account_transitions p WHERE p.tenant_id=OLD.tenant_id AND p.id=OLD.owner_id
    AND ((OLD.stage='TEMPLATE_COPY' AND p.transition_kind='TEMPLATE_PREPARATION') OR (OLD.stage='LEGACY_REGISTER' AND p.transition_kind='LEGACY_PHONE'))))) THEN
  RAISE EXCEPTION 'Financial evidence may change only through the original receipt or leased privacy authority' USING ERRCODE='23514';END IF;
 IF (to_jsonb(NEW)-ARRAY['outcome','result','result_sha256','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['outcome','result','result_sha256','settled_at'])
  OR (OLD.outcome<>'ATTEMPTED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
  RAISE EXCEPTION 'Financial checkpoint is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;

CREATE OR REPLACE FUNCTION app.preserve_meta_transition_reservation() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reservation history is retained' USING ERRCODE='55000';END IF;
 IF current_user<>'wasalx_meta_transition_executor' OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
  OR NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['released_at','release_reason','revision']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['released_at','release_reason','revision']) THEN
  RAISE EXCEPTION 'Reservation requires its sealed current release' USING ERRCODE='23514';END IF;
 IF NEW.release_reason='PRE_EFFECT_CANCEL' THEN
  IF EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=OLD.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION'
   AND c.owner_id=OLD.transition_id AND c.outcome IN('ATTEMPTED','SUCCEEDED','UNKNOWN')) THEN
   RAISE EXCEPTION 'Original effects prevent local cancellation' USING ERRCODE='55000';END IF;
 ELSIF NEW.release_reason='VERIFIED_SUCCESSOR' THEN
  IF NOT EXISTS(SELECT 1 FROM public.meta_account_transitions p WHERE p.tenant_id=OLD.tenant_id AND p.id=OLD.transition_id
   AND p.execution_state='RECONCILED_PAUSED'
   AND ((p.transition_kind<>'LEGACY_PHONE' AND p.identity_successor_receipt->>'claim'='SAME_GRAPH_PHONE_ACCOUNT_SUCCESSOR')
    OR (p.transition_kind='LEGACY_PHONE' AND p.identity_successor_receipt->>'claim'='SAME_GRAPH_PHONE_LEGACY_SUCCESSOR'
     AND app.meta_account_identity_receipt_valid(p.id)))
   AND p.identity_successor_receipt->>'transitionId'=p.id::text AND p.reconciled_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Verified successor receipt is required' USING ERRCODE='55000';END IF;
 ELSIF NEW.release_reason='SETTLED_TEMPLATE_COPY' THEN
  IF NOT EXISTS(SELECT 1 FROM public.meta_account_transitions p JOIN public.meta_provider_effect_checkpoints c
    ON c.tenant_id=p.tenant_id AND c.owner_kind='ACCOUNT_TRANSITION' AND c.owner_id=p.id AND c.stage='TEMPLATE_COPY'
    WHERE p.tenant_id=OLD.tenant_id AND p.id=OLD.transition_id AND p.transition_kind='TEMPLATE_PREPARATION' AND c.outcome IN('SUCCEEDED','REJECTED')) THEN
   RAISE EXCEPTION 'Unknown copy retains its original reservation' USING ERRCODE='55000';END IF;
 ELSE RAISE EXCEPTION 'Unknown reservation release' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

COMMIT;
