BEGIN;
-- Additive historical readers. Do not rewrite old birth/admission records.
-- The ordinal is intentionally unassigned until actual delivery integration.
ALTER TABLE delivery_outbox ADD COLUMN meta_billing_snapshot_sha256 text
 CHECK(meta_billing_snapshot_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE delivery_attempts ADD COLUMN meta_billing_admission_sha256 text
 CHECK(meta_billing_admission_sha256 ~ '^[a-f0-9]{64}$');
CREATE FUNCTION app.meta_billing_evidence_digest() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,app AS $$
DECLARE value jsonb;old_digest text;new_digest text;stamp_now boolean:=false;
BEGIN
 IF TG_TABLE_NAME='delivery_outbox' THEN
  value:=NEW.meta_billing_snapshot;new_digest:=NEW.meta_billing_snapshot_sha256;
  IF TG_OP='UPDATE' THEN old_digest:=OLD.meta_billing_snapshot_sha256;END IF;
 ELSE
  value:=NEW.meta_billing_admission;new_digest:=NEW.meta_billing_admission_sha256;
  IF TG_OP='UPDATE' THEN old_digest:=OLD.meta_billing_admission_sha256;END IF;
 END IF;
 IF TG_OP='INSERT' AND new_digest IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot supply payment evidence digest' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' AND new_digest IS DISTINCT FROM old_digest THEN RAISE EXCEPTION 'Payment evidence digest is immutable' USING ERRCODE='23514';END IF;
 -- A tombstone retains the original digest, never a digest of the tombstone.
 IF value ? 'redacted' THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN stamp_now:=true;
 ELSIF TG_TABLE_NAME='delivery_attempts' THEN stamp_now:=OLD.meta_billing_admission IS NULL AND value IS NOT NULL;END IF;
 IF stamp_now THEN
  new_digest:=CASE WHEN value IS NULL THEN NULL ELSE encode(digest(value::text,'sha256'),'hex') END;
  IF TG_TABLE_NAME='delivery_outbox' THEN NEW.meta_billing_snapshot_sha256:=new_digest;
  ELSE NEW.meta_billing_admission_sha256:=new_digest;END IF;
 END IF;
 RETURN NEW;
END;$$;
-- Run after incumbent snapshot/admission checks; immutable authority is unchanged.
CREATE TRIGGER zz_meta_billing_birth_digest BEFORE INSERT OR UPDATE ON delivery_outbox
 FOR EACH ROW EXECUTE FUNCTION app.meta_billing_evidence_digest();
CREATE TRIGGER zz_meta_billing_admission_digest BEFORE INSERT OR UPDATE ON delivery_attempts
 FOR EACH ROW EXECUTE FUNCTION app.meta_billing_evidence_digest();

CREATE FUNCTION app.resolve_meta_message_effect(p_tenant_id uuid,p_delivery_id uuid,p_external_message_id text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE delivery delivery_outbox;attempt delivery_attempts;matched integer;conflicting boolean;admission jsonb;birth_digest text;
BEGIN
 -- Deliberately identical response for absent and foreign evidence.
 IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() OR p_external_message_id IS NULL
  OR length(p_external_message_id) NOT BETWEEN 1 AND 512 OR p_external_message_id ~ '[[:cntrl:]]' THEN
  RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','NO_UNIQUE_SUCCESS');END IF;
 SELECT * INTO delivery FROM delivery_outbox WHERE tenant_id=p_tenant_id AND id=p_delivery_id;
 IF NOT FOUND OR delivery.external_message_id IS DISTINCT FROM p_external_message_id THEN
  RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','NO_UNIQUE_SUCCESS');END IF;
 IF delivery.content_redacted_at IS NOT NULL OR COALESCE(delivery.meta_billing_snapshot ? 'redacted',false) THEN
  RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','REDACTED_EVIDENCE');END IF;
 SELECT count(*)::integer INTO matched FROM delivery_attempts
  WHERE tenant_id=p_tenant_id AND delivery_id=p_delivery_id AND external_message_id=p_external_message_id
    AND state IN('SENT','DELIVERED','READ') AND finished_at IS NOT NULL;
 IF matched<>1 THEN RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','NO_UNIQUE_SUCCESS');END IF;
 SELECT * INTO attempt FROM delivery_attempts WHERE tenant_id=p_tenant_id AND delivery_id=p_delivery_id
  AND external_message_id=p_external_message_id AND state IN('SENT','DELIVERED','READ') AND finished_at IS NOT NULL;
 SELECT EXISTS(SELECT 1 FROM delivery_attempts other WHERE other.tenant_id=p_tenant_id AND other.delivery_id=p_delivery_id AND other.id<>attempt.id
  AND (other.external_message_id IS NOT NULL OR other.state IN('SENDING','OUTCOME_UNKNOWN'))) INTO conflicting;
 IF conflicting THEN RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','CONFLICTING_EVIDENCE');END IF;
 admission:=attempt.meta_billing_admission;
 IF COALESCE(admission ? 'redacted',false) THEN RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','REDACTED_EVIDENCE');END IF;
 IF admission IS NULL OR admission->>'schemaVersion' IS DISTINCT FROM '2' OR admission->>'claim' IS DISTINCT FROM 'MESSAGES_REQUEST_ADMITTED'
  OR attempt.meta_billing_admission_sha256 IS NULL THEN
  RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','MISSING_ADMISSION');END IF;
 birth_digest:=CASE WHEN delivery.meta_billing_snapshot IS NULL THEN NULL ELSE encode(digest(delivery.meta_billing_snapshot::text,'sha256'),'hex') END;
 IF admission->>'attemptId' IS DISTINCT FROM attempt.id::text OR admission->>'attemptNumber' IS DISTINCT FROM attempt.attempt_number::text
  OR admission->>'deliveryId' IS DISTINCT FROM delivery.id::text
  OR admission->'snapshot' IS DISTINCT FROM COALESCE(delivery.meta_billing_snapshot,'null'::jsonb)
  OR admission->'birthDigest' IS DISTINCT FROM (CASE WHEN birth_digest IS NULL THEN 'null'::jsonb
    ELSE jsonb_build_object('format','pg-jsonb-text-v1','sha256',birth_digest) END)
  OR attempt.meta_billing_admission_sha256<>encode(digest(admission::text,'sha256'),'hex') THEN
  RETURN jsonb_build_object('state','UNKNOWN_ATTRIBUTION','reason','CONFLICTING_EVIDENCE');END IF;
 -- Every value below comes from that immutable historical attempt; never current policy.
 RETURN jsonb_build_object('state','ATTRIBUTED','effect',jsonb_build_object('tenantId',p_tenant_id::text,
  'deliveryId',delivery.id::text,'attemptId',attempt.id::text,'attemptNumber',attempt.attempt_number,
  'externalMessageId',p_external_message_id,'admissionDigest',jsonb_build_object('format','pg-jsonb-text-v1','sha256',attempt.meta_billing_admission_sha256),
  'correlation','UNIQUE_KNOWN_SUCCESS'),'admission',admission);
END;$$;
REVOKE ALL ON FUNCTION app.resolve_meta_message_effect(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_meta_message_effect(uuid,uuid,text) TO wasalx_app,wasalx_connector_worker;

-- Reuse the execution-only platform approval role and its append-only audit.
-- No tenant/API/worker role can issue a mode registration or withdrawal.
CREATE FUNCTION app.operator_register_meta_simulated_runtime(candidate jsonb,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE receipt uuid:=gen_random_uuid();descriptor json;descriptor_sha text;tenant_value uuid;account_value uuid;expires_value timestamptz;
BEGIN
 IF candidate IS NULL OR jsonb_typeof(candidate)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(candidate))<>11
  OR NOT(candidate ?& ARRAY['schemaVersion','mode','tenantId','accountId','workerImageDigest','sourceTree','graphVersion','releaseEvidenceSha256','sourceEvidenceSha256','transportBindingSha256','expiresAt'])
  OR candidate->>'schemaVersion' IS DISTINCT FROM '1' OR candidate->>'mode' IS DISTINCT FROM 'SIMULATED'
  OR COALESCE(candidate->>'workerImageDigest','') !~ '^sha256:[a-f0-9]{64}$'
  OR COALESCE(candidate->>'sourceTree','') !~ '^[a-f0-9]{40,64}$' OR COALESCE(candidate->>'graphVersion','') !~ '^v[0-9]+\.[0-9]+$'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['releaseEvidenceSha256','sourceEvidenceSha256','transportBindingSha256']) key WHERE COALESCE(candidate->>key,'') !~ '^[a-f0-9]{64}$')
  OR operator_value IS NULL OR length(operator_value) NOT BETWEEN 1 AND 255 OR operator_value ~ '[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 OR request_value ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Meta runtime evidence is invalid' USING ERRCODE='23514'; END IF;
 tenant_value:=(candidate->>'tenantId')::uuid;account_value:=(candidate->>'accountId')::uuid;expires_value:=(candidate->>'expiresAt')::timestamptz;
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
   'descriptor',descriptor::jsonb,'descriptorSha256',descriptor_sha,'sourceEvidenceSha256',candidate->>'sourceEvidenceSha256','expiresAt',expires_value),request_value);
 RETURN jsonb_build_object('receiptId',receipt,'descriptorSha256',descriptor_sha,'descriptorText',descriptor::text||E'\n');
END; $$;
CREATE FUNCTION app.operator_withdraw_meta_runtime(receipt_value uuid,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 PERFORM 1 FROM platform_operations_audit_events WHERE id=receipt_value AND action='meta.runtime.simulated.registered' FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Meta runtime receipt is unavailable' USING ERRCODE='55000'; END IF;
 INSERT INTO platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(operator_value,'meta.runtime.withdrawn','meta.runtime_receipt',receipt_value::text,'{}',request_value);
 RETURN jsonb_build_object('receiptId',receipt_value,'withdrawn',true);
END; $$;
CREATE FUNCTION app.resolve_meta_runtime_execution(tenant_value uuid,account_value uuid,receipt_value uuid,descriptor_value jsonb,descriptor_sha text,transport_sha text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT COALESCE((SELECT jsonb_build_object('mode',receipt.safe_metadata->>'mode','runtimeEvidenceReceiptId',receipt.id,
  'runtimeEvidenceSha256',receipt.safe_metadata->>'descriptorSha256','transportBindingSha256',transport_sha)
 FROM platform_operations_audit_events receipt JOIN meta_messaging_accounts account ON account.tenant_id=tenant_value AND account.id=account_value
 JOIN tenants tenant ON tenant.id=account.tenant_id AND tenant.state='ACTIVE'
 WHERE tenant_value=app.current_tenant_id() AND receipt.id=receipt_value AND receipt.action='meta.runtime.simulated.registered'
  AND account.state<>'RETIRED' AND receipt.safe_metadata->>'tenantId'=tenant_value::text AND receipt.safe_metadata->>'accountId'=account_value::text
  AND receipt.safe_metadata->'descriptor'=descriptor_value AND receipt.safe_metadata->>'descriptorSha256'=descriptor_sha
  AND descriptor_value->>'transportBindingSha256'=transport_sha AND (receipt.safe_metadata->>'expiresAt')::timestamptz>clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM platform_operations_audit_events withdrawal WHERE withdrawal.action='meta.runtime.withdrawn' AND withdrawal.target_id=receipt.id::text)),
 jsonb_build_object('mode','UNKNOWN','runtimeEvidenceReceiptId',NULL,'runtimeEvidenceSha256',NULL,'transportBindingSha256',NULL))
$$;
REVOKE ALL ON FUNCTION app.operator_register_meta_simulated_runtime(jsonb,text,text),app.operator_withdraw_meta_runtime(uuid,text,text),app.resolve_meta_runtime_execution(uuid,uuid,uuid,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_register_meta_simulated_runtime(jsonb,text,text),app.operator_withdraw_meta_runtime(uuid,text,text) TO wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.resolve_meta_runtime_execution(uuid,uuid,uuid,jsonb,text,text) TO wasalx_connector_worker;

-- Only newly born rows adopt schema2; no UPDATE/backfill of historical birth.
CREATE OR REPLACE FUNCTION app.meta_billing_birth_snapshot(connection_value uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE binding meta_connection_account_bindings;account meta_messaging_accounts;
BEGIN
 SELECT * INTO binding FROM meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',1,'claim','LEGACY_UNATTRIBUTED'); END IF;
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR SHARE;
 IF NOT FOUND OR account.requested_policy_version_id IS NULL THEN RAISE EXCEPTION 'Meta account policy is unavailable' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND','tenantId',binding.tenant_id::text,'connectionId',connection_value::text,
  'accountId',account.id::text,'providerAccountId',account.provider_account_id,'identifierKind','MESSAGING_ACCOUNT_ID','accountModel','PHASE1_WABA_ALIAS',
  'bindingId',binding.id::text,'bindingRevision',binding.revision,'accountAuthorityRevision',account.authority_revision,
  'policyVersionId',account.requested_policy_version_id::text,'payment',jsonb_build_object('mode','CUSTOMER','actualPayer','UNVERIFIED','managed',NULL),
  'funding',jsonb_build_object('responseSha256',account.funding_response_sha256,'observedAt',account.funding_observed_at));
END; $$;
CREATE FUNCTION app.meta_runtime_message_admission_current(snapshot_value jsonb,execution_value jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE receipt platform_operations_audit_events;account_value uuid;
BEGIN
 IF jsonb_typeof(execution_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(execution_value))<>4
  OR NOT(execution_value ?& ARRAY['mode','runtimeEvidenceReceiptId','runtimeEvidenceSha256','transportBindingSha256']) THEN RETURN false; END IF;
 IF execution_value->>'mode'='UNKNOWN' THEN
  RETURN execution_value=jsonb_build_object('mode','UNKNOWN','runtimeEvidenceReceiptId',NULL,'runtimeEvidenceSha256',NULL,'transportBindingSha256',NULL)
   AND COALESCE(snapshot_value#>>'{payment,mode}','CUSTOMER')='CUSTOMER';
 END IF;
 IF snapshot_value->>'claim' IS DISTINCT FROM 'ACCOUNT_POLICY_BOUND' OR snapshot_value->>'schemaVersion' IS DISTINCT FROM '2'
  OR snapshot_value->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text THEN RETURN false; END IF;
 account_value:=(snapshot_value->>'accountId')::uuid;
 SELECT * INTO receipt FROM platform_operations_audit_events WHERE id=(execution_value->>'runtimeEvidenceReceiptId')::uuid
  AND action='meta.runtime.simulated.registered' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN execution_value=app.resolve_meta_runtime_execution(app.current_tenant_id(),account_value,receipt.id,receipt.safe_metadata->'descriptor',
  execution_value->>'runtimeEvidenceSha256',execution_value->>'transportBindingSha256');
END; $$;
REVOKE ALL ON FUNCTION app.meta_runtime_message_admission_current(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_runtime_message_admission_current(jsonb,jsonb) TO wasalx_connector_worker;
-- New admissions retain the verified phase-1 namespace mapping at the actual
-- Messages boundary. Historical readers never resolve this from current state.
CREATE FUNCTION app.meta_message_provider_context(connection_value uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
DECLARE observation jsonb;operation_value uuid;currency_value jsonb:=NULL;
BEGIN
 SELECT b.* INTO binding FROM public.meta_connection_account_bindings b
  JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id AND c.provider='META'
  JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id AND s.connection_id=b.connection_id
  WHERE b.tenant_id=app.current_tenant_id() AND b.connection_id=connection_value AND b.state='ACTIVE'
   AND c.secret_reference=b.secret_reference AND s.ownership_state='ACTIVE' AND s.opaque_session_id=b.phone_number_id
   AND s.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND s.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=b.phone_number_id
   AND s.provider_state_data#>>'{metaAccountProof,tenantId}'=b.tenant_id::text
   AND s.provider_state_data#>>'{metaAccountProof,connectionId}'=b.connection_id::text
   AND s.provider_state_data#>>'{metaAccountProof,providerSessionId}'=b.provider_session_id::text
   AND s.provider_state_data#>>'{metaAccountProof,secretReference}'=b.secret_reference
   AND s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=b.credential_fingerprint
   AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=b.app_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT a.* INTO account FROM public.meta_messaging_accounts a JOIN public.provider_sessions s
  ON s.tenant_id=a.tenant_id AND s.id=binding.provider_session_id
  WHERE a.tenant_id=binding.tenant_id AND a.id=binding.account_id
   AND s.provider_state_data#>>'{metaAccountProof,wabaId}'=a.provider_account_id
   AND s.provider_state_data->>'wabaId'=a.provider_account_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT op.id,op.result#>'{metaAccountFundingProof,currency}' INTO operation_value,observation
  FROM public.connection_operations op WHERE op.tenant_id=account.tenant_id AND op.id=account.last_observation_operation_id
   AND op.operation_type='VERIFY_META_BILLING' AND op.state='SUCCEEDED'
   AND op.result#>>'{metaAccountFundingProof,accountId}'=account.provider_account_id
   AND op.result#>>'{metaAccountFundingProof,responseSha256}'=account.funding_response_sha256;
 IF observation IS NOT NULL AND observation->>'accountId'=account.provider_account_id
  AND observation->>'source'='META_WABA_NODE' AND observation->>'identifierKind'='WABA_ID'
  AND (observation->>'observedAt')::timestamptz<=clock_timestamp()+interval '5 seconds'
  AND (observation->>'expiresAt')::timestamptz>clock_timestamp() THEN
  currency_value:=jsonb_build_object('operationId',operation_value,'observation',observation);
 END IF;
 RETURN jsonb_build_object('schemaVersion',1,'mapping','PHASE1_WABA_ALIAS_VERIFIED_BINDING',
  'phoneNumberId',binding.phone_number_id,'envelopeAccount',jsonb_build_object('identifierKind','WABA_ID','id',account.provider_account_id),
  'messagingAccount',jsonb_build_object('identifierKind','MESSAGING_ACCOUNT_ID','id',account.provider_account_id),
  'bindingId',binding.id::text,'bindingRevision',binding.revision,'proofSha256',binding.proof_sha256,'currencyEvidence',currency_value);
END; $$;
REVOKE ALL ON FUNCTION app.meta_message_provider_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_message_provider_context(uuid) TO wasalx_connector_worker;

-- Validation is independent of funding availability. A denied optional currency
-- field does not revoke an otherwise valid funding observation.
CREATE FUNCTION app.meta_currency_observation_valid(value jsonb,account_value text,observed_value timestamptz,expires_value timestamptz)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(value))<>10
  OR NOT(value ?& ARRAY['schemaVersion','source','identifierKind','accountId','state','currency','graphVersion','observedAt','expiresAt','responseSha256'])
  OR value->>'schemaVersion' IS DISTINCT FROM '1' OR value->>'source' IS DISTINCT FROM 'META_WABA_NODE'
  OR value->>'identifierKind' IS DISTINCT FROM 'WABA_ID' OR value->>'accountId' IS DISTINCT FROM account_value
  OR COALESCE(value->>'state','') NOT IN('OBSERVED','NONE','UNAVAILABLE')
  OR COALESCE(value->>'graphVersion','') !~ '^v[0-9]{1,3}\.[0-9]{1,2}$'
  OR COALESCE(value->>'responseSha256','') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(value->'observedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'expiresAt') IS DISTINCT FROM 'string'
  OR (value->>'observedAt')::timestamptz IS DISTINCT FROM observed_value
  OR (value->>'expiresAt')::timestamptz IS DISTINCT FROM expires_value THEN RETURN false; END IF;
 IF value->>'state'='OBSERVED' THEN
  RETURN value->>'graphVersion'='v24.0' AND COALESCE(value->>'currency','') ~ '^[A-Z]{3}$';
 END IF;
 RETURN value->'currency'='null'::jsonb AND (value->>'state'='UNAVAILABLE' OR value->>'graphVersion'='v24.0');
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END; $$;
REVOKE ALL ON FUNCTION app.meta_currency_observation_valid(jsonb,text,timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_currency_observation_valid(jsonb,text,timestamptz,timestamptz) TO wasalx_app,wasalx_connector_worker;

CREATE OR REPLACE FUNCTION app.preserve_meta_billing_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE old_value jsonb;new_value jsonb;delivery_value uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.meta_billing_admission IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot insert Meta request admission' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='delivery_outbox' THEN old_value:=OLD.meta_billing_snapshot;new_value:=NEW.meta_billing_snapshot;delivery_value:=OLD.id;
 ELSE old_value:=OLD.meta_billing_admission;new_value:=NEW.meta_billing_admission;delivery_value:=OLD.delivery_id; END IF;
 IF new_value IS NOT DISTINCT FROM old_value THEN RETURN NEW; END IF;
 IF old_value IS NULL AND TG_TABLE_NAME='delivery_attempts' THEN
  IF NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER') THEN
   RAISE EXCEPTION 'Only the connector worker may admit a Messages request' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=NEW.tenant_id AND delivery.id=delivery_value
    AND delivery.state='SENDING' AND delivery.lease_id IS NOT NULL AND delivery.lease_expires_at>clock_timestamp()
    AND NEW.state='SENDING' AND NEW.attempt_number=delivery.attempts AND NEW.finished_at IS NULL
    AND jsonb_typeof(new_value)='object' AND new_value->>'claim'='MESSAGES_REQUEST_ADMITTED'
    AND ((new_value->>'schemaVersion'='1' AND delivery.meta_billing_snapshot->>'schemaVersion' IS DISTINCT FROM '2' AND (SELECT count(*) FROM jsonb_object_keys(new_value))=10)
     OR (new_value->>'schemaVersion'='2' AND (SELECT count(*) FROM jsonb_object_keys(new_value))=13
      AND new_value ? 'providerContext'
      AND new_value->'providerContext' IS NOT DISTINCT FROM CASE WHEN delivery.meta_billing_snapshot->>'claim'='ACCOUNT_POLICY_BOUND'
       THEN app.meta_message_provider_context(delivery.connection_id) ELSE 'null'::jsonb END
      AND (delivery.meta_billing_snapshot->>'claim' IS DISTINCT FROM 'ACCOUNT_POLICY_BOUND' OR new_value->'providerContext'<>'null'::jsonb)
      AND new_value->'birthDigest' IS NOT DISTINCT FROM CASE WHEN delivery.meta_billing_snapshot IS NULL THEN 'null'::jsonb ELSE
       jsonb_build_object('format','pg-jsonb-text-v1','sha256',encode(digest(delivery.meta_billing_snapshot::text,'sha256'),'hex')) END
      AND app.meta_runtime_message_admission_current(delivery.meta_billing_snapshot,new_value->'execution')))
    AND jsonb_typeof(new_value->'requestPhoneNumberId')='string'
    AND new_value->>'requestPhoneNumberId' ~ '^[0-9]{1,32}$'
    AND EXISTS(SELECT 1 FROM public.provider_sessions session WHERE session.tenant_id=delivery.tenant_id
      AND session.connection_id=delivery.connection_id AND session.ownership_state='ACTIVE' AND session.state='WORKING'
      AND session.opaque_session_id=new_value->>'requestPhoneNumberId')
    AND (new_value->'providerContext' IS NULL OR new_value->'providerContext'='null'::jsonb
      OR new_value#>>'{providerContext,phoneNumberId}'=new_value->>'requestPhoneNumberId')
    AND new_value->'snapshot' IS NOT DISTINCT FROM COALESCE(delivery.meta_billing_snapshot,'null'::jsonb) AND new_value->>'attemptId'=NEW.id::text
    AND new_value->>'attemptNumber'=NEW.attempt_number::text AND new_value->>'deliveryId'=delivery.id::text
    AND new_value->>'admittedAt' IS NOT NULL
    AND new_value->>'requestSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(new_value->'funding')='object'
    AND new_value->'funding' ?& ARRAY['responseSha256','observedAt','expiresAt']
    AND (SELECT count(*) FROM jsonb_object_keys(new_value->'funding'))=3
    AND EXISTS(SELECT 1 FROM connections connection
      LEFT JOIN meta_connection_account_bindings binding ON binding.tenant_id=connection.tenant_id AND binding.connection_id=connection.id
      LEFT JOIN meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
      WHERE connection.tenant_id=delivery.tenant_id AND connection.id=delivery.connection_id AND connection.provider='META'
        AND (new_value#>>'{funding,responseSha256}') IS NOT DISTINCT FROM account.funding_response_sha256
        AND (new_value#>>'{funding,observedAt}')::timestamptz IS NOT DISTINCT FROM account.funding_observed_at
        AND (new_value#>>'{funding,expiresAt}')::timestamptz IS NOT DISTINCT FROM account.funding_expires_at)
    AND app.meta_billing_delivery_current(delivery.id)) THEN RAISE EXCEPTION 'Meta request admission is unavailable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF old_value IS NOT NULL AND new_value=jsonb_build_object('redacted',true,'sha256',encode(digest(old_value::text,'sha256'),'hex'))
  AND app.meta_direct_privacy_target_authorized('DELIVERY',delivery_value::text)
  AND EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=OLD.tenant_id AND delivery.id=delivery_value
    AND delivery.state NOT IN('SENDING','OUTCOME_UNKNOWN')
    AND NOT(delivery.state='CLAIMED' AND delivery.lease_expires_at>=clock_timestamp())) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Meta billing evidence is immutable' USING ERRCODE='23514';
END; $$;

-- Commercial terms are versioned domain receipts in the incumbent platform audit,
-- not a second policy registry. Tenant acceptance is born with its policy row.
ALTER TABLE meta_billing_policy_versions ADD COLUMN commercial_terms_version_id uuid REFERENCES platform_operations_audit_events(id);
ALTER TABLE meta_billing_policy_versions ADD COLUMN accepted_tariff_version_id uuid;
CREATE FUNCTION app.operator_register_meta_simulated_terms(candidate jsonb,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE receipt uuid:=gen_random_uuid();tenant_value uuid;account_value uuid;
BEGIN
 IF jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(candidate)) NOT IN(6,7)
  OR NOT(candidate ?& ARRAY['schemaVersion','tenantId','accountId','evidenceMode','documentSha256','termsVersion'])
  OR candidate->>'schemaVersion' IS DISTINCT FROM '1' OR candidate->>'evidenceMode' IS DISTINCT FROM 'SIMULATED'
  OR COALESCE(candidate->>'documentSha256','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(candidate->>'termsVersion','') !~ '^[A-Za-z0-9._-]{1,128}$'
  OR ((SELECT count(*) FROM jsonb_object_keys(candidate))=7 AND NOT(candidate ? 'documentText'))
  OR (candidate ? 'documentText' AND (jsonb_typeof(candidate->'documentText') IS DISTINCT FROM 'string'
   OR octet_length(candidate->>'documentText') NOT BETWEEN 1 AND 32768
   OR encode(digest(convert_to(candidate->>'documentText','UTF8'),'sha256'),'hex') IS DISTINCT FROM candidate->>'documentSha256')) THEN
  RAISE EXCEPTION 'Meta commercial terms evidence is invalid' USING ERRCODE='23514'; END IF;
 tenant_value:=(candidate->>'tenantId')::uuid;account_value:=(candidate->>'accountId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM meta_messaging_accounts account JOIN tenants tenant ON tenant.id=account.tenant_id AND tenant.state='ACTIVE'
  WHERE account.tenant_id=tenant_value AND account.id=account_value AND account.state<>'RETIRED') THEN
  RAISE EXCEPTION 'Meta commercial terms scope is unavailable' USING ERRCODE='55000'; END IF;
 INSERT INTO platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(receipt,operator_value,'meta.commercial_terms.simulated.versioned','meta.messaging_account',account_value::text,candidate,request_value);
 RETURN jsonb_build_object('commercialTermsVersionId',receipt,'evidenceMode','SIMULATED');
END; $$;
CREATE FUNCTION app.meta_terms_receipt_scope(tenant_value uuid,account_value uuid,terms_value uuid,tariff_value uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT receipt.safe_metadata FROM platform_operations_audit_events receipt
 WHERE tenant_value=app.current_tenant_id() AND receipt.id=terms_value AND receipt.action='meta.commercial_terms.simulated.versioned'
  AND receipt.safe_metadata->>'tenantId'=tenant_value::text AND receipt.safe_metadata->>'accountId'=account_value::text
 -- tariff_value is accepted immutably on the policy row, not on this
 -- antecedent terms document. P10 drafts only after this terms ID exists.
$$;
CREATE FUNCTION app.guard_meta_policy_terms_acceptance() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.commercial_terms_version_id IS NULL THEN
  IF NEW.accepted_tariff_version_id IS NOT NULL THEN RAISE EXCEPTION 'Tariff acceptance requires exact terms' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF app.meta_terms_receipt_scope(NEW.tenant_id,NEW.account_id,NEW.commercial_terms_version_id,NEW.accepted_tariff_version_id) IS NULL THEN
  RAISE EXCEPTION 'Meta accepted terms belong to another account or tariff' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER meta_policy_terms_acceptance BEFORE INSERT ON meta_billing_policy_versions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_policy_terms_acceptance();
CREATE FUNCTION app.meta_accepted_terms_projection(p_tenant_id uuid,p_policy_version_id uuid,p_terms_version_id uuid)
RETURNS TABLE(tenant_id uuid,account_id uuid,policy_version_id uuid,evidence_mode text,commercial_terms_version_id uuid,document_sha256 text,accepted_tariff_version_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT policy.tenant_id,policy.account_id,policy.id,receipt->>'evidenceMode',policy.commercial_terms_version_id,receipt->>'documentSha256',policy.accepted_tariff_version_id
 FROM meta_billing_policy_versions policy CROSS JOIN LATERAL app.meta_terms_receipt_scope(policy.tenant_id,policy.account_id,policy.commercial_terms_version_id,policy.accepted_tariff_version_id) AS evidence(receipt)
 WHERE p_tenant_id=app.current_tenant_id() AND policy.tenant_id=p_tenant_id AND policy.id=p_policy_version_id AND policy.commercial_terms_version_id=p_terms_version_id
  AND receipt IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.operator_register_meta_simulated_terms(jsonb,text,text),app.meta_terms_receipt_scope(uuid,uuid,uuid,uuid),app.meta_accepted_terms_projection(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_register_meta_simulated_terms(jsonb,text,text) TO wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.meta_terms_receipt_scope(uuid,uuid,uuid,uuid),app.meta_accepted_terms_projection(uuid,uuid,uuid) TO wasalx_app,wasalx_connector_worker;


-- Account-scoped diagnostic admission, restricted to the incumbent platform
-- role. Reads remain auth/lifecycle/privacy bound even while manually PAUSED.
CREATE FUNCTION app.operator_meta_managed_approval_context(tenant_value uuid,account_value uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE account public.meta_messaging_accounts;binding public.meta_connection_account_bindings;guard record;
BEGIN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0))
  OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=tenant_value AND state='ACTIVE')
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Account approval is held' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value AND id=account_value AND state<>'RETIRED' FOR SHARE;
 SELECT b.* INTO binding FROM public.meta_connection_account_bindings b
  JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id AND c.provider='META' AND c.state IN('WORKING','PAUSED')
  JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.connection_id=b.connection_id AND s.id=b.provider_session_id AND s.ownership_state='ACTIVE' AND s.state IN('WORKING','PAUSED')
  WHERE b.tenant_id=tenant_value AND b.account_id=account.id AND b.state='ACTIVE' AND c.secret_reference=b.secret_reference
   AND s.opaque_session_id=b.phone_number_id AND s.provider_state_data->>'wabaId'=account.provider_account_id
   AND s.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=b.credential_fingerprint
   AND s.provider_state_data#>>'{metaAccountProof,secretReference}'=b.secret_reference
   AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=b.app_id
   AND s.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1' AND s.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND s.provider_state_data#>>'{metaAccountProof,tenantId}'=b.tenant_id::text AND s.provider_state_data#>>'{metaAccountProof,connectionId}'=b.connection_id::text
   AND s.provider_state_data#>>'{metaAccountProof,providerSessionId}'=b.provider_session_id::text
   AND s.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=b.phone_number_id AND s.provider_state_data#>>'{metaAccountProof,wabaId}'=account.provider_account_id
   AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,claim}'='CREDENTIAL_METADATA_VERIFIED'
   AND jsonb_typeof(s.provider_state_data#>'{metaAccountProof,credentialMetadata}')='object'
   AND s.provider_state_data#>>'{metaAccountProof,credentialMetadata,schemaVersion}'='1'
   AND jsonb_typeof(s.provider_state_data#>'{metaAccountProof,credentialMetadata,scopes}')='array'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.provider_state_data#>'{metaAccountProof,credentialMetadata,scopes}')='array'
      THEN s.provider_state_data#>'{metaAccountProof,credentialMetadata,scopes}' ELSE '[]'::jsonb END) scope WHERE jsonb_typeof(scope)<>'string')
   AND COALESCE(s.provider_state_data#>'{metaAccountProof,credentialMetadata,scopes}','[]'::jsonb) ?& ARRAY['whatsapp_business_management','whatsapp_business_messaging']
   AND CASE WHEN s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}' ~ '^[0-9]{1,15}$'
      THEN (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0
        OR (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END
   AND CASE WHEN NOT (s.provider_state_data#>'{metaAccountProof,credentialMetadata}') ? 'dataAccessExpiresAt' THEN true
      WHEN s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}' ~ '^[0-9]{1,15}$'
      THEN (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0
        OR (s.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch FROM clock_timestamp()) ELSE false END
   AND EXISTS(SELECT 1 FROM public.webhook_routes r WHERE r.tenant_id=b.tenant_id AND r.connection_id=b.connection_id AND r.provider='META' AND r.state IN('ACTIVE','PAUSED'))
  ORDER BY b.connection_id LIMIT 1 FOR SHARE OF b,c,s;
 IF account.id IS NULL OR binding.id IS NULL THEN RAISE EXCEPTION 'Account approval is held' USING ERRCODE='55000';END IF;
 PERFORM set_config('app.tenant_id',tenant_value::text,true);
 SELECT * INTO guard FROM app.meta_lifecycle_guard(binding.connection_id,binding.provider_session_id,binding.phone_number_id,account.provider_account_id,binding.app_id,NULL);
 IF NOT FOUND OR guard.blocked IS NOT FALSE OR guard.unresolved_hold IS NOT FALSE THEN RAISE EXCEPTION 'Account approval is held' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('bindingId',binding.id,'bindingRevision',binding.revision,'authorityRevision',account.authority_revision,
  'appId',binding.app_id,'phoneNumberId',binding.phone_number_id,'proofSha256',binding.proof_sha256);
END;$$;
REVOKE ALL ON FUNCTION app.operator_meta_managed_approval_context(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_managed_approval_context(uuid,uuid) TO wasalx_platform_operations_client;

-- Root-reserved unapplied 0173: consumed P08 managed domain, not a generic ledger.
CREATE TABLE meta_funding_arrangement_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,account_id uuid NOT NULL,
 family_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 kind text NOT NULL CHECK(kind IN('OWN_SOLUTION_PARTNER_LINE','MULTI_PARTNER_SOLUTION')),
 app_id text NOT NULL CHECK(app_id ~ '^[0-9]{1,32}$'),holder_business_id text NOT NULL CHECK(holder_business_id ~ '^[0-9]{1,32}$'),
 credit_line_id text NOT NULL CHECK(credit_line_id ~ '^[0-9]{1,32}$'),solution_id text CHECK(solution_id ~ '^[0-9]{1,32}$'),
 receiving_business_id text NOT NULL CHECK(receiving_business_id ~ '^[0-9]{1,32}$'),
 financial_secret_reference text NOT NULL CONSTRAINT meta_arrangement_secret_reference_check CHECK(char_length(financial_secret_reference)<=512 AND financial_secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'),
 financial_credential_fingerprint text NOT NULL CHECK(financial_credential_fingerprint ~ '^[a-f0-9]{64}$'),
 financial_credential_metadata jsonb NOT NULL CHECK(jsonb_typeof(financial_credential_metadata)='object'),
 graph_version text NOT NULL CHECK(graph_version ~ '^v[0-9]+\.[0-9]+$'),
 requested_currency text NOT NULL CHECK(requested_currency IN('AUD','EUR','GBP','IDR','INR','USD')),
 evidence_mode text NOT NULL CHECK(evidence_mode IN('LIVE','SIMULATED')),
 payer_authority_version_id uuid NOT NULL REFERENCES platform_operations_audit_events(id),
 effective_scope_sha256 text NOT NULL CHECK(effective_scope_sha256 ~ '^[a-f0-9]{64}$'),
 commercial_terms_version_id uuid NOT NULL REFERENCES platform_operations_audit_events(id),
 allocation_line_version_id uuid REFERENCES platform_operations_audit_events(id),
 allocation_observed_at timestamptz,allocation_expires_at timestamptz,
 state text NOT NULL DEFAULT 'APPROVED' CHECK(state IN('APPROVED','REVOKED')),
 approval_sha256 text NOT NULL CHECK(approval_sha256 ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,family_id,version),
 FOREIGN KEY(tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
 CHECK((kind='MULTI_PARTNER_SOLUTION')=(solution_id IS NOT NULL))
);
ALTER TABLE meta_funding_arrangement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_funding_arrangement_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_funding_arrangement_versions USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
-- Financial identifiers do not belong in tenant-facing DTOs or general results.
GRANT SELECT ON meta_funding_arrangement_versions TO wasalx_connector_worker;
CREATE TRIGGER meta_arrangement_privacy_fence BEFORE INSERT OR UPDATE ON meta_funding_arrangement_versions
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE FUNCTION app.preserve_meta_arrangement_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Managed authority history must be retained' USING ERRCODE='55000';END IF;
 IF (to_jsonb(NEW)-ARRAY['state','allocation_line_version_id','allocation_observed_at','allocation_expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','allocation_line_version_id','allocation_observed_at','allocation_expires_at'])
  OR (OLD.state='REVOKED' AND NEW.state<>'REVOKED')
  OR (OLD.allocation_line_version_id IS NOT NULL AND NEW.allocation_line_version_id IS DISTINCT FROM OLD.allocation_line_version_id) THEN
  RAISE EXCEPTION 'Managed authority versions are immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER meta_arrangement_immutable BEFORE UPDATE OR DELETE ON meta_funding_arrangement_versions FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_arrangement_version();

-- Software-qualified SIMULATED approvals are useful in DEV but can never be
-- promoted to LIVE by tenant input, NODE_ENV, a hostname, or provider access.
CREATE FUNCTION app.operator_approve_meta_simulated_arrangement(candidate jsonb,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE tenant_value uuid;account_value uuid;arrangement uuid:=gen_random_uuid();authority uuid:=gen_random_uuid();scope jsonb;scope_sha text;version_value integer;family uuid;account meta_messaging_accounts;
BEGIN
 IF jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(candidate))<>20
  OR NOT(candidate ?& ARRAY['schemaVersion','tenantId','accountId','familyId','kind','appId','holderBusinessId','creditLineId','solutionId','receivingBusinessId','financialSecretReference','financialCredentialFingerprint','financialCredentialMetadata','graphVersion','evidenceMode','commercialTermsVersionId','approvalSha256','expiresAt','requestedCurrency','admission'])
  OR candidate->>'schemaVersion' IS DISTINCT FROM '1' OR candidate->>'evidenceMode' IS DISTINCT FROM 'SIMULATED'
  OR COALESCE(candidate->>'requestedCurrency','') NOT IN('AUD','EUR','GBP','IDR','INR','USD')
  OR COALESCE(candidate->>'kind','') NOT IN('OWN_SOLUTION_PARTNER_LINE','MULTI_PARTNER_SOLUTION')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['appId','holderBusinessId','creditLineId','receivingBusinessId']) key WHERE COALESCE(candidate->>key,'') !~ '^[0-9]{1,32}$')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['financialCredentialFingerprint','approvalSha256']) key WHERE COALESCE(candidate->>key,'') !~ '^[a-f0-9]{64}$')
  OR (candidate->>'kind'='MULTI_PARTNER_SOLUTION' AND COALESCE(candidate->>'solutionId','') !~ '^[0-9]{1,32}$')
  OR (candidate->>'kind'='OWN_SOLUTION_PARTNER_LINE' AND candidate->'solutionId' IS DISTINCT FROM 'null'::jsonb)
  OR char_length(COALESCE(candidate->>'financialSecretReference',''))>512
  OR COALESCE(candidate->>'financialSecretReference','') !~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$'
  OR jsonb_typeof(candidate->'financialCredentialMetadata') IS DISTINCT FROM 'object'
  OR candidate#>>'{financialCredentialMetadata,schemaVersion}' IS DISTINCT FROM '1'
  OR candidate#>>'{financialCredentialMetadata,claim}' IS DISTINCT FROM 'CREDENTIAL_METADATA_VERIFIED'
  OR candidate#>>'{financialCredentialMetadata,appId}' IS DISTINCT FROM candidate->>'appId'
  OR NOT(COALESCE(candidate#>'{financialCredentialMetadata,scopes}','[]'::jsonb) ? 'business_management')
  OR COALESCE(candidate->>'graphVersion','') !~ '^v[0-9]+\.[0-9]+$' THEN
  RAISE EXCEPTION 'Managed arrangement approval is invalid' USING ERRCODE='23514';END IF;
 tenant_value:=(candidate->>'tenantId')::uuid;account_value:=(candidate->>'accountId')::uuid;
 -- Common account lock serializes all same-account policy/enrollment/activation.
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=tenant_value AND id=account_value FOR UPDATE;
 IF NOT FOUND OR account.state='RETIRED' OR NOT EXISTS(SELECT 1 FROM tenants WHERE id=tenant_value AND state='ACTIVE')
  OR (candidate->>'expiresAt')::timestamptz<=clock_timestamp() OR (candidate->>'expiresAt')::timestamptz>clock_timestamp()+interval '24 hours'
  OR NOT EXISTS(SELECT 1 FROM platform_operations_audit_events terms WHERE terms.id=(candidate->>'commercialTermsVersionId')::uuid
    AND terms.action='meta.commercial_terms.simulated.versioned' AND terms.safe_metadata->>'tenantId'=tenant_value::text
    AND terms.safe_metadata->>'accountId'=account_value::text AND terms.safe_metadata->>'evidenceMode'='SIMULATED') THEN
  RAISE EXCEPTION 'Managed arrangement approval scope is unavailable' USING ERRCODE='55000';END IF;
 IF candidate->'admission' IS DISTINCT FROM app.operator_meta_managed_approval_context(tenant_value,account_value) THEN
  RAISE EXCEPTION 'Managed approval binding changed' USING ERRCODE='55000';END IF;
 family:=COALESCE((candidate->>'familyId')::uuid,arrangement);
 SELECT COALESCE(max(version),0)+1 INTO version_value FROM meta_funding_arrangement_versions WHERE tenant_id=tenant_value AND account_id=account_value AND family_id=family;
 scope:=jsonb_build_object('tenantId',tenant_value,'accountId',account_value,'providerAccountId',account.provider_account_id,
  'appId',candidate->>'appId','holderBusinessId',candidate->>'holderBusinessId','creditLineId',candidate->>'creditLineId',
  'solutionId',candidate->'solutionId','receivingBusinessId',candidate->>'receivingBusinessId','requestedCurrency',candidate->>'requestedCurrency','evidenceMode','SIMULATED');
 scope_sha:=encode(digest(scope::text,'sha256'),'hex');
 INSERT INTO platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(authority,operator_value,'meta.managed.simulated.authority.approved','meta.messaging_account',account_value::text,
  jsonb_build_object('schemaVersion',1,'scope',scope,'effectiveScopeSha256',scope_sha,'approvalSha256',candidate->>'approvalSha256'),request_value);
 INSERT INTO meta_funding_arrangement_versions(id,tenant_id,account_id,family_id,version,kind,app_id,holder_business_id,credit_line_id,solution_id,
  receiving_business_id,financial_secret_reference,financial_credential_fingerprint,financial_credential_metadata,graph_version,requested_currency,evidence_mode,payer_authority_version_id,
  effective_scope_sha256,commercial_terms_version_id,approval_sha256,expires_at)
 VALUES(arrangement,tenant_value,account_value,family,version_value,candidate->>'kind',candidate->>'appId',candidate->>'holderBusinessId',candidate->>'creditLineId',candidate->>'solutionId',
  candidate->>'receivingBusinessId',candidate->>'financialSecretReference',candidate->>'financialCredentialFingerprint',candidate->'financialCredentialMetadata',candidate->>'graphVersion',candidate->>'requestedCurrency','SIMULATED',authority,
  scope_sha,(candidate->>'commercialTermsVersionId')::uuid,candidate->>'approvalSha256',(candidate->>'expiresAt')::timestamptz);
 RETURN jsonb_build_object('arrangementVersionId',arrangement,'payerAuthorityVersionId',authority,'effectiveScopeSha256',scope_sha,'evidenceMode','SIMULATED');
END;$$;
CREATE FUNCTION app.operator_revoke_meta_arrangement(arrangement_value uuid,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE arrangement meta_funding_arrangement_versions;account meta_messaging_accounts;
BEGIN
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE id=arrangement_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Managed arrangement is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=arrangement.tenant_id AND id=arrangement.account_id FOR UPDATE;
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE id=arrangement_value FOR UPDATE;
 IF arrangement.state='REVOKED' THEN RETURN jsonb_build_object('arrangementVersionId',arrangement.id,'state','REVOKED');END IF;
 UPDATE meta_funding_arrangement_versions SET state='REVOKED' WHERE id=arrangement.id;
 -- Revocation/reapproval advances semantic authority, never resurrects old birth.
 UPDATE meta_messaging_accounts SET state='HELD',authority_revision=authority_revision+1,updated_at=now() WHERE id=account.id;
 INSERT INTO platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(operator_value,'meta.managed.arrangement.revoked','meta.messaging_account',account.id::text,
  jsonb_build_object('tenantId',account.tenant_id,'arrangementVersionId',arrangement.id),request_value);
 RETURN jsonb_build_object('arrangementVersionId',arrangement.id,'state','REVOKED');
 -- This is LOCAL authority revocation, never provider DELETE/automatic credit revoke.
END;$$;
REVOKE ALL ON FUNCTION app.operator_approve_meta_simulated_arrangement(jsonb,text,text),app.operator_revoke_meta_arrangement(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_approve_meta_simulated_arrangement(jsonb,text,text),app.operator_revoke_meta_arrangement(uuid,text,text) TO wasalx_platform_operations_client;

ALTER TABLE meta_billing_policy_versions DROP CONSTRAINT meta_billing_policy_versions_mode_check;
ALTER TABLE meta_billing_policy_versions ADD CHECK(mode IN('CUSTOMER','MANAGED'));
ALTER TABLE meta_billing_policy_versions DROP CONSTRAINT meta_billing_policy_versions_terms_version_check;
ALTER TABLE meta_billing_policy_versions ADD CHECK(terms_version IN('META_CUSTOMER_PAYMENT_V1','META_MANAGED_PAYMENT_V1'));
ALTER TABLE meta_billing_policy_versions ADD COLUMN arrangement_version_id uuid;
ALTER TABLE meta_billing_policy_versions ADD FOREIGN KEY(tenant_id,arrangement_version_id) REFERENCES meta_funding_arrangement_versions(tenant_id,id);
ALTER TABLE meta_billing_policy_versions ADD CHECK((mode='CUSTOMER' AND arrangement_version_id IS NULL AND terms_version='META_CUSTOMER_PAYMENT_V1')
 OR (mode='MANAGED' AND arrangement_version_id IS NOT NULL AND commercial_terms_version_id IS NOT NULL AND terms_version='META_MANAGED_PAYMENT_V1'));
CREATE FUNCTION app.meta_account_payment_ready(account_value uuid,primary_value text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM meta_messaging_accounts account JOIN meta_billing_policy_versions policy
  ON policy.tenant_id=account.tenant_id AND policy.id=account.requested_policy_version_id
 LEFT JOIN meta_funding_arrangement_versions arrangement ON arrangement.tenant_id=account.tenant_id AND arrangement.id=policy.arrangement_version_id AND arrangement.account_id=account.id
 LEFT JOIN platform_operations_audit_events allocation ON allocation.id=arrangement.allocation_line_version_id
 WHERE account.tenant_id=app.current_tenant_id() AND account.id=account_value AND account.state<>'RETIRED' AND primary_value IS NOT NULL
  AND (policy.mode='CUSTOMER' OR (policy.mode='MANAGED' AND arrangement.state='APPROVED' AND arrangement.expires_at>clock_timestamp()
    AND arrangement.allocation_expires_at>clock_timestamp() AND arrangement.commercial_terms_version_id=policy.commercial_terms_version_id
    AND allocation.action='meta.managed.allocation.verified' AND allocation.safe_metadata->>'tenantId'=account.tenant_id::text
    AND allocation.safe_metadata->>'accountId'=account.id::text AND allocation.safe_metadata->>'arrangementVersionId'=arrangement.id::text
    AND allocation.safe_metadata->>'receivingCredential'=primary_value
    AND allocation.safe_metadata->>'evidenceMode'=arrangement.evidence_mode)))
$$;
REVOKE ALL ON FUNCTION app.meta_account_payment_ready(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_payment_ready(uuid,text) TO wasalx_app,wasalx_connector_worker;
CREATE FUNCTION app.guard_meta_managed_policy_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Foreign managed policy' USING ERRCODE='23514';END IF;
 IF NEW.mode='MANAGED' AND NOT EXISTS(SELECT 1 FROM meta_funding_arrangement_versions arrangement
  WHERE arrangement.tenant_id=NEW.tenant_id AND arrangement.account_id=NEW.account_id AND arrangement.id=NEW.arrangement_version_id
    AND arrangement.state='APPROVED' AND arrangement.expires_at>clock_timestamp()
    AND arrangement.commercial_terms_version_id=NEW.commercial_terms_version_id) THEN
  RAISE EXCEPTION 'Managed policy requires exact approved arrangement/terms' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER meta_managed_policy_scope BEFORE INSERT ON meta_billing_policy_versions FOR EACH ROW EXECUTE FUNCTION app.guard_meta_managed_policy_scope();

CREATE FUNCTION app.guard_meta_financial_operation_admission() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.payload ? 'metaManagedFunding' AND NOT pg_has_role(current_user,'wasalx_platform_operations_client','MEMBER') THEN
   RAISE EXCEPTION 'Financial operation requires restricted platform admission' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN
  IF OLD.payload ? 'metaManagedFunding' THEN RAISE EXCEPTION 'Financial operation history must be retained' USING ERRCODE='55000';END IF;
  RETURN OLD;
 END IF;
 IF (OLD.payload ? 'metaManagedFunding' OR NEW.payload ? 'metaManagedFunding')
  AND ((NEW.id,NEW.tenant_id,NEW.connection_id,NEW.operation_type,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.connection_id,OLD.operation_type,OLD.created_at)
    OR NEW.payload->'metaManagedFunding' IS DISTINCT FROM OLD.payload->'metaManagedFunding') THEN
  RAISE EXCEPTION 'Financial admission is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER meta_financial_operation_admission BEFORE INSERT OR UPDATE OR DELETE ON connection_operations FOR EACH ROW EXECUTE FUNCTION app.guard_meta_financial_operation_admission();
CREATE FUNCTION app.operator_queue_meta_funding_attachment(arrangement_value uuid,expected_authority bigint,key_value text,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE arrangement meta_funding_arrangement_versions;account meta_messaging_accounts;binding meta_connection_account_bindings;policy meta_billing_policy_versions;
 operation connection_operations;session provider_sessions;operation_value uuid:=gen_random_uuid();payload_value jsonb;
BEGIN
 IF COALESCE(key_value,'') !~ '^[A-Za-z0-9._:-]{1,128}$' OR expected_authority IS NULL OR expected_authority NOT BETWEEN 1 AND 9007199254740991 THEN
  RAISE EXCEPTION 'Financial operation admission is invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE id=arrangement_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Managed arrangement is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO operation FROM connection_operations WHERE tenant_id=arrangement.tenant_id AND idempotency_key='meta-funding:'||key_value;
 IF FOUND THEN
  IF operation.payload#>>'{metaManagedFunding,arrangementVersionId}' IS DISTINCT FROM arrangement_value::text
   OR operation.payload#>>'{metaManagedFunding,authorityRevision}' IS DISTINCT FROM expected_authority::text THEN
   RAISE EXCEPTION 'Financial request key belongs to another admission' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('operationId',operation.id,'state',operation.state,'replay',true);
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||arrangement.tenant_id::text,0)) THEN
  RAISE EXCEPTION 'Financial admission is fenced by privacy' USING ERRCODE='40001';END IF;
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=arrangement.tenant_id AND id=arrangement.account_id FOR UPDATE;
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE id=arrangement_value FOR SHARE;
 SELECT * INTO policy FROM meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND id=account.requested_policy_version_id;
 IF account.id IS NULL OR account.state='RETIRED' OR account.authority_revision IS DISTINCT FROM expected_authority
  OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp()
  OR policy.mode IS DISTINCT FROM 'MANAGED' OR policy.arrangement_version_id IS DISTINCT FROM arrangement.id
  OR account.funding_status<>'NONE' OR account.primary_funding_id IS NOT NULL OR account.funding_expires_at IS NULL OR account.funding_expires_at<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints e WHERE e.tenant_id=account.tenant_id AND e.account_id=account.id AND e.stage='ATTACH' AND e.outcome IN('ATTEMPTED','UNKNOWN','SUCCEEDED'))
  OR NOT EXISTS(SELECT 1 FROM tenants WHERE id=account.tenant_id AND state='ACTIVE')
  OR EXISTS(SELECT 1 FROM privacy_jobs j WHERE j.tenant_id=account.tenant_id AND j.job_type='DELETE' AND j.scope_type='TENANT' AND j.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Fresh explicit funding attachment is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO binding FROM meta_connection_account_bindings WHERE tenant_id=account.tenant_id AND account_id=account.id AND state='ACTIVE' AND app_id=arrangement.app_id ORDER BY connection_id LIMIT 1 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified dispatch binding is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO session FROM public.provider_sessions WHERE tenant_id=account.tenant_id AND id=binding.provider_session_id AND ownership_state='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified dispatch session is unavailable' USING ERRCODE='55000';END IF;
 payload_value:=jsonb_build_object('metaBillingDiagnostic',jsonb_build_object('schemaVersion',1,'secretReference',binding.secret_reference,
  'providerSessionId',binding.provider_session_id,'phoneNumberId',binding.phone_number_id,'wabaId',account.provider_account_id,
  'proofSha256',binding.proof_sha256,'appId',binding.app_id,'lifecycleRevision',CASE WHEN session.provider_state_data ? 'metaLifecycle' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE 0 END),
  'metaAccountPolicy',jsonb_build_object('accountId',account.id,'bindingId',binding.id,'bindingRevision',binding.revision,'authorityRevision',account.authority_revision,
   'policyVersionId',policy.id,'observationOperationId',account.last_observation_operation_id),
  'metaManagedFunding',jsonb_build_object('schemaVersion',1,'ownerKind','FUNDING_ATTACHMENT','ownerId',operation_value,
  'stage','ATTACH','accountId',account.id,'arrangementVersionId',arrangement.id,'authorityRevision',account.authority_revision,
  'policyVersionId',policy.id,'bindingId',binding.id,'bindingRevision',binding.revision,'appId',arrangement.app_id,'currency',arrangement.requested_currency));
 INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,max_attempts,requested_by_type,requested_by_id,request_id)
 VALUES(operation_value,account.tenant_id,binding.connection_id,'VERIFY_META_BILLING','meta-funding:'||key_value,payload_value,'QUEUED',1,'SYSTEM',operator_value,request_value);
 RETURN jsonb_build_object('operationId',operation_value,'state','QUEUED','replay',false);
END;$$;
REVOKE ALL ON FUNCTION app.operator_queue_meta_funding_attachment(uuid,bigint,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_queue_meta_funding_attachment(uuid,bigint,text,text,text) TO wasalx_platform_operations_client;

-- One durable effect slot, shared with P09. The operation is its dispatcher,
-- not its uniqueness owner: replacement leases cannot obtain another POST slot.
CREATE TABLE meta_provider_effect_checkpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,account_id uuid NOT NULL,
 owner_kind text NOT NULL CHECK(owner_kind IN('FUNDING_ATTACHMENT','ACCOUNT_TRANSITION')),
 owner_id uuid NOT NULL,stage text NOT NULL CHECK(stage IN('ATTACH','INITIATE','COMPLETE','REVOKE')),
 original_operation_id uuid NOT NULL,original_fencing_token bigint NOT NULL CHECK(original_fencing_token>=0),
 reservation_token uuid NOT NULL DEFAULT gen_random_uuid(),
 authority_revision bigint NOT NULL CHECK(authority_revision BETWEEN 1 AND 9007199254740991),
 policy_version_id uuid NOT NULL,arrangement_version_id uuid NOT NULL,
 runtime_execution jsonb NOT NULL CHECK(jsonb_typeof(runtime_execution)='object'),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL DEFAULT 'ATTEMPTED' CHECK(outcome IN('ATTEMPTED','SUCCEEDED','REJECTED','UNKNOWN')),
 result jsonb,result_sha256 text CHECK(result_sha256 ~ '^[a-f0-9]{64}$'),
 attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),settled_at timestamptz,
 UNIQUE(owner_kind,owner_id,stage),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,original_operation_id) REFERENCES connection_operations(tenant_id,id),
 FOREIGN KEY(tenant_id,policy_version_id) REFERENCES meta_billing_policy_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,arrangement_version_id) REFERENCES meta_funding_arrangement_versions(tenant_id,id),
 CHECK((outcome='ATTEMPTED' AND settled_at IS NULL AND result IS NULL AND result_sha256 IS NULL)
    OR (outcome<>'ATTEMPTED' AND settled_at IS NOT NULL AND result IS NOT NULL AND result_sha256 IS NOT NULL))
);
ALTER TABLE meta_provider_effect_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_provider_effect_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_provider_effect_checkpoints USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
-- No app/worker direct writes. Narrow functions enforce the leased original slot.
GRANT SELECT ON meta_provider_effect_checkpoints TO wasalx_connector_worker;
CREATE TRIGGER meta_financial_privacy_fence BEFORE INSERT OR UPDATE ON meta_provider_effect_checkpoints
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE FUNCTION app.preserve_meta_financial_checkpoint() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Financial effect history must be retained' USING ERRCODE='55000';END IF;
 IF (to_jsonb(NEW)-ARRAY['outcome','result','result_sha256','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['outcome','result','result_sha256','settled_at'])
  OR (OLD.outcome<>'ATTEMPTED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
  RAISE EXCEPTION 'Financial checkpoint is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER meta_financial_checkpoint_immutable BEFORE UPDATE OR DELETE ON meta_provider_effect_checkpoints FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_financial_checkpoint();

CREATE FUNCTION app.reserve_meta_funding_attachment(operation_value uuid,lease_value uuid,request_sha text,execution_value jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE operation connection_operations;account meta_messaging_accounts;arrangement meta_funding_arrangement_versions;prior meta_provider_effect_checkpoints;checkpoint meta_provider_effect_checkpoints;
BEGIN
 IF app.current_tenant_id() IS NULL OR COALESCE(request_sha,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Financial request is not admitted' USING ERRCODE='55000';END IF;
 -- Privacy first, before the common account/operation lock order.
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Financial request is fenced by privacy' USING ERRCODE='40001';END IF;
 SELECT * INTO operation FROM connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF NOT FOUND OR operation.payload#>>'{metaManagedFunding,stage}' IS DISTINCT FROM 'ATTACH'
  OR operation.payload#>>'{metaManagedFunding,ownerKind}' IS DISTINCT FROM 'FUNDING_ATTACHMENT'
  OR operation.payload#>>'{metaManagedFunding,ownerId}' IS DISTINCT FROM operation.id::text THEN
  RAISE EXCEPTION 'Financial request has no server-bound owner' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=operation.tenant_id AND id=(operation.payload#>>'{metaManagedFunding,accountId}')::uuid FOR UPDATE;
 SELECT * INTO operation FROM connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value FOR UPDATE;
 SELECT * INTO prior FROM meta_provider_effect_checkpoints WHERE owner_kind='FUNDING_ATTACHMENT' AND owner_id=operation.id AND stage='ATTACH';
 IF FOUND THEN RETURN jsonb_build_object('disposition','HISTORICAL_NO_POST','checkpointId',prior.id,'outcome',prior.outcome);END IF;
 IF operation.state<>'RUNNING' OR operation.lease_id IS DISTINCT FROM lease_value OR operation.lease_expires_at<=clock_timestamp()
  OR operation.operation_type<>'VERIFY_META_BILLING' OR account.id IS NULL OR account.state='RETIRED'
  OR account.authority_revision::text IS DISTINCT FROM operation.payload#>>'{metaManagedFunding,authorityRevision}'
  OR account.requested_policy_version_id::text IS DISTINCT FROM operation.payload#>>'{metaManagedFunding,policyVersionId}'
  OR EXISTS(SELECT 1 FROM meta_provider_effect_checkpoints other WHERE other.tenant_id=account.tenant_id AND other.account_id=account.id AND other.stage='ATTACH' AND other.outcome IN('ATTEMPTED','UNKNOWN','SUCCEEDED'))
  OR EXISTS(SELECT 1 FROM privacy_jobs j WHERE j.tenant_id=account.tenant_id AND j.job_type='DELETE' AND j.scope_type='TENANT' AND j.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Financial request admission changed' USING ERRCODE='55000';END IF;
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE tenant_id=account.tenant_id AND account_id=account.id
  AND id=(operation.payload#>>'{metaManagedFunding,arrangementVersionId}')::uuid FOR SHARE;
 IF NOT FOUND OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp()
  OR execution_value->>'mode' IS DISTINCT FROM arrangement.evidence_mode
  OR NOT app.meta_runtime_message_admission_current(jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND',
    'tenantId',account.tenant_id,'accountId',account.id,'payment',jsonb_build_object('mode','MANAGED')),execution_value)
  OR account.funding_status<>'NONE' OR account.primary_funding_id IS NOT NULL OR account.funding_expires_at IS NULL OR account.funding_expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'Approved empty funding/current runtime is required' USING ERRCODE='55000';END IF;
 -- Historical slots returned above remain no-POST even after current access
 -- changes. Only a genuinely new slot must pass the current operation, exact
 -- binding/session/secret/proof and lifecycle fence in this same transaction.
 PERFORM app.meta_funding_operation_context(operation.id,lease_value,operation.fencing_token,arrangement.app_id);
 INSERT INTO meta_provider_effect_checkpoints(tenant_id,account_id,owner_kind,owner_id,stage,original_operation_id,original_fencing_token,
  authority_revision,policy_version_id,arrangement_version_id,runtime_execution,request_sha256)
 VALUES(account.tenant_id,account.id,'FUNDING_ATTACHMENT',operation.id,'ATTACH',operation.id,operation.fencing_token,
  account.authority_revision,account.requested_policy_version_id,arrangement.id,execution_value,request_sha) RETURNING * INTO checkpoint;
 RETURN jsonb_build_object('disposition','NEW_ATTEMPT','checkpointId',checkpoint.id,'reservationToken',checkpoint.reservation_token,
  'operationId',operation.id,'fencingToken',operation.fencing_token,'requestSha256',request_sha);
 -- Caller commits this slot before invoking HTTP. No automatic replay if it
 -- crashes, loses its lease, or receives a malformed/timeout outcome.
END;$$;
CREATE FUNCTION app.record_meta_financial_response(checkpoint_value uuid,reservation_value uuid,outcome_value text,result_value jsonb,result_sha text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE checkpoint meta_provider_effect_checkpoints;
BEGIN
 SELECT * INTO checkpoint FROM meta_provider_effect_checkpoints WHERE tenant_id=app.current_tenant_id() AND id=checkpoint_value FOR UPDATE;
 IF NOT FOUND OR checkpoint.reservation_token IS DISTINCT FROM reservation_value OR COALESCE(outcome_value,'') NOT IN('SUCCEEDED','REJECTED','UNKNOWN')
  OR jsonb_typeof(result_value) IS DISTINCT FROM 'object' OR COALESCE(result_sha,'') !~ '^[a-f0-9]{64}$'
  OR octet_length(result_value::text)>8192 THEN RAISE EXCEPTION 'Original financial response is unavailable' USING ERRCODE='55000';END IF;
 -- Known original response is retained even after a newer lease/authority. That
 -- evidence does not activate policy; activation requires a separate fresh CAS.
 IF checkpoint.outcome<>'ATTEMPTED' THEN RETURN checkpoint.outcome=outcome_value AND checkpoint.result=result_value AND checkpoint.result_sha256=result_sha;END IF;
 IF outcome_value='SUCCEEDED' AND (checkpoint.stage<>'ATTACH'
   OR NOT(result_value ?& ARRAY['allocationConfigId','messagingAccountId'])
   OR (SELECT count(*) FROM jsonb_object_keys(result_value))<>2
   OR COALESCE(result_value->>'allocationConfigId','') !~ '^[0-9]{1,32}$'
   OR NOT EXISTS(SELECT 1 FROM meta_messaging_accounts a WHERE a.tenant_id=checkpoint.tenant_id AND a.id=checkpoint.account_id
     AND a.provider_account_id=result_value->>'messagingAccountId')) THEN
  RAISE EXCEPTION 'Successful financial response requires exact attachment evidence' USING ERRCODE='23514';END IF;
 IF outcome_value<>'SUCCEEDED' AND (result_value IS DISTINCT FROM jsonb_build_object('reason',CASE WHEN outcome_value='REJECTED' THEN 'KNOWN_PROVIDER_REJECTION' ELSE 'PROVIDER_OUTCOME_UNRESOLVED' END)) THEN
  RAISE EXCEPTION 'Financial failure evidence must be redacted' USING ERRCODE='23514';END IF;
 UPDATE meta_provider_effect_checkpoints SET outcome=outcome_value,result=result_value,result_sha256=result_sha,settled_at=clock_timestamp() WHERE id=checkpoint.id;
 RETURN true;
END;$$;
REVOKE ALL ON FUNCTION app.reserve_meta_funding_attachment(uuid,uuid,text,jsonb),app.record_meta_financial_response(uuid,uuid,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reserve_meta_funding_attachment(uuid,uuid,text,jsonb),app.record_meta_financial_response(uuid,uuid,text,jsonb,text) TO wasalx_connector_worker;

-- Worker-only current authorization. Reads never bypass credential/lifecycle,
-- route, tenant, privacy or the original leased operation binding.
CREATE FUNCTION app.meta_funding_operation_context(operation_value uuid,lease_value uuid,fence_value bigint,app_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE operation public.connection_operations;account public.meta_messaging_accounts;binding public.meta_connection_account_bindings;
 arrangement public.meta_funding_arrangement_versions;connection public.connections;session public.provider_sessions;guard record;
BEGIN
 IF app.current_tenant_id() IS NULL OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0))
  OR NOT app.lock_current_active_tenant_for_event_admission() THEN RAISE EXCEPTION 'Financial access is held' USING ERRCODE='55000';END IF;
 SELECT * INTO operation FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value;
 IF NOT FOUND OR COALESCE(operation.payload#>>'{metaManagedFunding,stage}','') NOT IN('ATTACH','RECONCILE') THEN RAISE EXCEPTION 'Financial access is held' USING ERRCODE='55000';END IF;
 IF operation.payload#>>'{metaManagedFunding,stage}'='RECONCILE' AND NOT EXISTS(
  SELECT 1 FROM public.meta_provider_effect_checkpoints c WHERE c.tenant_id=operation.tenant_id
   AND c.id::text=operation.payload#>>'{metaManagedFunding,checkpointId}' AND c.owner_id::text=operation.payload#>>'{metaManagedFunding,ownerId}'
   AND c.account_id::text=operation.payload#>>'{metaManagedFunding,accountId}' AND c.arrangement_version_id::text=operation.payload#>>'{metaManagedFunding,arrangementVersionId}'
   AND c.stage='ATTACH' AND c.outcome='SUCCEEDED' AND NOT(c.result ? 'redacted')) THEN RAISE EXCEPTION 'Original success readback is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=operation.tenant_id AND id=(operation.payload#>>'{metaManagedFunding,accountId}')::uuid FOR SHARE;
 SELECT * INTO operation FROM public.connection_operations WHERE tenant_id=app.current_tenant_id() AND id=operation_value FOR UPDATE;
 IF operation.id IS NULL OR operation.state<>'RUNNING' OR operation.lease_id IS DISTINCT FROM lease_value OR operation.fencing_token IS DISTINCT FROM fence_value
  OR operation.lease_expires_at IS NULL OR operation.lease_expires_at<=clock_timestamp() OR operation.operation_type<>'VERIFY_META_BILLING'
  OR account.id IS NULL OR account.state='RETIRED' OR account.authority_revision::text IS DISTINCT FROM operation.payload#>>'{metaManagedFunding,authorityRevision}'
  OR account.requested_policy_version_id::text IS DISTINCT FROM operation.payload#>>'{metaManagedFunding,policyVersionId}'
  OR EXISTS(SELECT 1 FROM public.privacy_jobs j WHERE j.tenant_id=operation.tenant_id AND j.job_type='DELETE' AND j.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Financial access is held' USING ERRCODE='55000';END IF;
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=operation.tenant_id AND connection_id=operation.connection_id
  AND id=(operation.payload#>>'{metaManagedFunding,bindingId}')::uuid AND account_id=account.id AND state='ACTIVE' FOR SHARE;
 SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=operation.tenant_id AND account_id=account.id
  AND id=(operation.payload#>>'{metaManagedFunding,arrangementVersionId}')::uuid FOR SHARE;
 IF binding.id IS NULL OR binding.revision::text IS DISTINCT FROM operation.payload#>>'{metaManagedFunding,bindingRevision}'
  OR binding.app_id IS DISTINCT FROM app_value OR arrangement.id IS NULL OR arrangement.app_id IS DISTINCT FROM app_value
  OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Financial access is held' USING ERRCODE='55000';END IF;
 SELECT * INTO connection FROM public.connections WHERE tenant_id=operation.tenant_id AND id=operation.connection_id AND provider='META' FOR SHARE;
 SELECT * INTO session FROM public.provider_sessions WHERE tenant_id=operation.tenant_id AND connection_id=operation.connection_id AND id=binding.provider_session_id AND ownership_state='ACTIVE' FOR SHARE;
 IF connection.id IS NULL OR connection.state NOT IN('WORKING','PAUSED') OR connection.secret_reference IS DISTINCT FROM binding.secret_reference
  OR session.id IS NULL OR session.state NOT IN('WORKING','PAUSED') OR session.opaque_session_id IS DISTINCT FROM binding.phone_number_id
  OR session.provider_state_data->>'wabaId' IS DISTINCT FROM account.provider_account_id
  OR session.provider_state_data#>>'{metaAccountProof,secretReference}' IS DISTINCT FROM binding.secret_reference
  OR session.provider_state_data#>>'{metaAccountProof,credentialFingerprint}' IS DISTINCT FROM binding.credential_fingerprint
  OR session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}' IS DISTINCT FROM app_value
  OR session.provider_state_data#>>'{metaAccountProof,tenantId}' IS DISTINCT FROM operation.tenant_id::text
  OR session.provider_state_data#>>'{metaAccountProof,connectionId}' IS DISTINCT FROM operation.connection_id::text
  OR session.provider_state_data#>>'{metaAccountProof,providerSessionId}' IS DISTINCT FROM binding.provider_session_id::text
  OR session.provider_state_data#>>'{metaAccountProof,phoneNumberId}' IS DISTINCT FROM binding.phone_number_id
  OR session.provider_state_data#>>'{metaAccountProof,wabaId}' IS DISTINCT FROM account.provider_account_id
  OR session.provider_state_data#>>'{metaAccountProof,claim}' IS DISTINCT FROM 'PHONE_ACCOUNT_RELATION_VERIFIED'
  OR session.provider_state_data#>>'{metaAccountProof,schemaVersion}' IS DISTINCT FROM '1'
  OR NOT EXISTS(SELECT 1 FROM public.webhook_routes route WHERE route.tenant_id=operation.tenant_id AND route.connection_id=operation.connection_id AND route.provider='META' AND route.state IN('ACTIVE','PAUSED')) THEN
  RAISE EXCEPTION 'Financial access is held' USING ERRCODE='55000';END IF;
 SELECT * INTO guard FROM app.meta_lifecycle_guard(operation.connection_id,session.id,binding.phone_number_id,account.provider_account_id,app_value,
  (operation.payload#>>'{metaBillingDiagnostic,lifecycleRevision}')::bigint);
 IF NOT FOUND OR guard.revision_matches IS NOT TRUE OR guard.blocked IS NOT FALSE OR guard.unresolved_hold IS NOT FALSE THEN
  RAISE EXCEPTION 'Financial access is held' USING ERRCODE='55000';END IF;
 UPDATE public.connection_operations SET lease_expires_at=clock_timestamp()+interval '60 seconds' WHERE id=operation.id AND tenant_id=operation.tenant_id;
 RETURN jsonb_build_object('accountId',account.id,'messagingAccountId',account.provider_account_id,'connectionSecretReference',binding.secret_reference,
  'phoneNumberId',binding.phone_number_id,'accountProof',session.provider_state_data->'metaAccountProof','arrangementVersionId',arrangement.id,
  'kind',arrangement.kind,'appId',arrangement.app_id,'holderBusinessId',arrangement.holder_business_id,'creditLineId',arrangement.credit_line_id,
  'solutionId',arrangement.solution_id,'receivingBusinessId',arrangement.receiving_business_id,'financialSecretReference',arrangement.financial_secret_reference,
  'financialCredentialFingerprint',arrangement.financial_credential_fingerprint,'financialCredentialMetadata',arrangement.financial_credential_metadata,
  'graphVersion',arrangement.graph_version,'currency',arrangement.requested_currency,
  'evidenceMode',arrangement.evidence_mode);
END;$$;
REVOKE ALL ON FUNCTION app.meta_funding_operation_context(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_funding_operation_context(uuid,uuid,bigint,text) TO wasalx_connector_worker;

-- Provider POST result was committed first. A later lease/authority loss never
-- destroys that result; it simply prevents current allocation authorization.
CREATE FUNCTION app.record_meta_allocation_readback(operation_value uuid,lease_value uuid,fence_value bigint,checkpoint_value uuid,
 readback jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE context jsonb;checkpoint public.meta_provider_effect_checkpoints;arrangement public.meta_funding_arrangement_versions;
 account public.meta_messaging_accounts;receipt uuid;existing public.platform_operations_audit_events;funding jsonb;projection jsonb;
BEGIN
 IF jsonb_typeof(readback) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(readback))<>5
  OR NOT(readback ?& ARRAY['allocationConfigId','receivingCredential','receivingBusinessId','creditLineId','fundingProof']) THEN
  RAISE EXCEPTION 'Allocation readback is invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO checkpoint FROM public.meta_provider_effect_checkpoints WHERE tenant_id=app.current_tenant_id() AND id=checkpoint_value;
 IF NOT FOUND OR checkpoint.outcome<>'SUCCEEDED' OR NOT(
  checkpoint.original_operation_id=operation_value OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=checkpoint.tenant_id AND o.id=operation_value
   AND o.payload#>>'{metaManagedFunding,stage}'='RECONCILE' AND o.payload#>>'{metaManagedFunding,checkpointId}'=checkpoint.id::text
   AND o.payload#>>'{metaManagedFunding,ownerId}'=checkpoint.owner_id::text AND o.payload#>>'{metaManagedFunding,accountId}'=checkpoint.account_id::text
   AND o.payload#>>'{metaManagedFunding,arrangementVersionId}'=checkpoint.arrangement_version_id::text))
  OR checkpoint.result->>'allocationConfigId' IS DISTINCT FROM readback->>'allocationConfigId' THEN RETURN false;END IF;
 -- Keep the common account-before-operation/arrangement order.
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=checkpoint.tenant_id AND id=checkpoint.account_id FOR UPDATE;
 SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=checkpoint.tenant_id AND id=checkpoint.arrangement_version_id FOR UPDATE;
 context:=app.meta_funding_operation_context(operation_value,lease_value,fence_value,arrangement.app_id);
 funding:=readback->'fundingProof';
 IF jsonb_typeof(funding) IS DISTINCT FROM 'object'
   OR (SELECT count(*) FROM jsonb_object_keys(funding))<>(CASE WHEN funding ? 'currency' THEN 10 ELSE 9 END)
   OR (funding ? 'currency' AND NOT app.meta_currency_observation_valid(funding->'currency',funding->>'accountId',
     (funding->>'observedAt')::timestamptz,(funding->>'expiresAt')::timestamptz))
  OR NOT(funding ?& ARRAY['schemaVersion','accountId','observedOwnerBusinessId','primaryFundingId','status','actualPayer','responseSha256','observedAt','expiresAt'])
  OR jsonb_typeof(funding->'observedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(funding->'expiresAt') IS DISTINCT FROM 'string'
  OR COALESCE(readback->>'receivingCredential','') !~ '^[A-Za-z0-9._:-]{1,128}$'
  OR readback->>'creditLineId' IS DISTINCT FROM arrangement.credit_line_id OR readback->>'receivingBusinessId' IS DISTINCT FROM arrangement.receiving_business_id
  OR funding->>'schemaVersion' IS DISTINCT FROM '1' OR funding->>'accountId' IS DISTINCT FROM account.provider_account_id
  OR funding->>'actualPayer' IS DISTINCT FROM 'UNVERIFIED' OR funding->>'status' IS DISTINCT FROM 'PRESENT'
  OR funding->>'primaryFundingId' IS DISTINCT FROM readback->>'receivingCredential'
  OR funding->>'observedOwnerBusinessId' IS DISTINCT FROM arrangement.receiving_business_id
  OR COALESCE(funding->>'responseSha256','') !~ '^[a-f0-9]{64}$'
  OR (funding->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
  OR (funding->>'expiresAt')::timestamptz IS DISTINCT FROM (funding->>'observedAt')::timestamptz+interval '15 minutes'
  OR (funding->>'expiresAt')::timestamptz<=clock_timestamp() THEN
  RAISE EXCEPTION 'Exact allocation and funding evidence is unavailable' USING ERRCODE='23514';END IF;
 projection:=jsonb_build_object('schemaVersion',1,'tenantId',account.tenant_id,'accountId',account.id,'arrangementVersionId',arrangement.id,
  'allocationConfigId',readback->>'allocationConfigId','receivingCredential',readback->>'receivingCredential','receivingBusinessId',arrangement.receiving_business_id,
  'creditLineId',arrangement.credit_line_id,'checkpointId',checkpoint.id,'evidenceMode',arrangement.evidence_mode,
  'payerAuthorityVersionId',arrangement.payer_authority_version_id,'effectiveScopeSha256',arrangement.effective_scope_sha256);
 IF arrangement.allocation_line_version_id IS NOT NULL THEN
  SELECT * INTO existing FROM public.platform_operations_audit_events WHERE id=arrangement.allocation_line_version_id AND action='meta.managed.allocation.verified';
  IF NOT FOUND OR existing.safe_metadata IS DISTINCT FROM projection THEN RAISE EXCEPTION 'Allocation authority changed; a new account is required' USING ERRCODE='55000';END IF;
  receipt:=existing.id;
 ELSE
  receipt:=gen_random_uuid();
  INSERT INTO public.platform_operations_audit_events(id,operator_subject,action,target_type,target_id,safe_metadata,request_id)
  VALUES(receipt,'connector-worker','meta.managed.allocation.verified','meta.messaging_account',account.id::text,projection,operation_value::text);
 END IF;
 UPDATE public.meta_funding_arrangement_versions SET allocation_line_version_id=receipt,allocation_observed_at=(funding->>'observedAt')::timestamptz,
  allocation_expires_at=(funding->>'expiresAt')::timestamptz WHERE tenant_id=arrangement.tenant_id AND id=arrangement.id;
 RETURN true;
 -- Account readiness remains derived by incumbent exact private-funding
 -- completion after this committed readback. There is no direct READY write.
END;$$;
REVOKE ALL ON FUNCTION app.record_meta_allocation_readback(uuid,uuid,bigint,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_meta_allocation_readback(uuid,uuid,bigint,uuid,jsonb) TO wasalx_connector_worker;

CREATE FUNCTION app.operator_queue_meta_funding_readback(checkpoint_value uuid,expected_authority bigint,key_value text,operator_value text,request_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE arrangement meta_funding_arrangement_versions;account meta_messaging_accounts;binding meta_connection_account_bindings;policy meta_billing_policy_versions;
 operation connection_operations;session provider_sessions;checkpoint public.meta_provider_effect_checkpoints;operation_value uuid:=gen_random_uuid();payload_value jsonb;
BEGIN
 IF COALESCE(key_value,'') !~ '^[A-Za-z0-9._:-]{1,128}$' OR expected_authority IS NULL OR expected_authority NOT BETWEEN 1 AND 9007199254740991 THEN
  RAISE EXCEPTION 'Financial operation admission is invalid' USING ERRCODE='23514';END IF;
 SELECT * INTO checkpoint FROM public.meta_provider_effect_checkpoints WHERE id=checkpoint_value AND stage='ATTACH' AND outcome='SUCCEEDED' AND NOT(result ? 'redacted');
 IF NOT FOUND THEN RAISE EXCEPTION 'An exact known-success financial receipt is required' USING ERRCODE='55000';END IF;
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE id=checkpoint.arrangement_version_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Managed arrangement is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO operation FROM connection_operations WHERE tenant_id=arrangement.tenant_id AND idempotency_key='meta-funding-readback:'||key_value;
 IF FOUND THEN
  IF operation.payload#>>'{metaManagedFunding,checkpointId}' IS DISTINCT FROM checkpoint.id::text
   OR operation.payload#>>'{metaManagedFunding,ownerId}' IS DISTINCT FROM checkpoint.owner_id::text
   OR operation.payload#>>'{metaManagedFunding,stage}' IS DISTINCT FROM 'RECONCILE'
   OR operation.payload#>>'{metaManagedFunding,arrangementVersionId}' IS DISTINCT FROM arrangement.id::text
   OR operation.payload#>>'{metaManagedFunding,authorityRevision}' IS DISTINCT FROM expected_authority::text THEN
   RAISE EXCEPTION 'Financial request key belongs to another admission' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('operationId',operation.id,'state',operation.state,'replay',true);
 END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||arrangement.tenant_id::text,0)) THEN
  RAISE EXCEPTION 'Financial admission is fenced by privacy' USING ERRCODE='40001';END IF;
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=arrangement.tenant_id AND id=arrangement.account_id FOR UPDATE;
 SELECT * INTO arrangement FROM meta_funding_arrangement_versions WHERE id=arrangement.id FOR SHARE;
 SELECT * INTO policy FROM meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND id=account.requested_policy_version_id;
 IF account.id IS NULL OR account.state='RETIRED' OR account.authority_revision IS DISTINCT FROM expected_authority
  OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp()
  OR policy.mode IS DISTINCT FROM 'MANAGED' OR policy.arrangement_version_id IS DISTINCT FROM arrangement.id
  OR checkpoint.account_id IS DISTINCT FROM account.id OR checkpoint.tenant_id IS DISTINCT FROM account.tenant_id
  OR NOT EXISTS(SELECT 1 FROM tenants WHERE id=account.tenant_id AND state='ACTIVE')
  OR EXISTS(SELECT 1 FROM privacy_jobs j WHERE j.tenant_id=account.tenant_id AND j.job_type='DELETE' AND j.scope_type='TENANT' AND j.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Fresh explicit financial readback is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO binding FROM meta_connection_account_bindings WHERE tenant_id=account.tenant_id AND account_id=account.id AND state='ACTIVE' AND app_id=arrangement.app_id ORDER BY connection_id LIMIT 1 FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified dispatch binding is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO session FROM public.provider_sessions WHERE tenant_id=account.tenant_id AND id=binding.provider_session_id AND ownership_state='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified dispatch session is unavailable' USING ERRCODE='55000';END IF;
 payload_value:=jsonb_build_object('metaBillingDiagnostic',jsonb_build_object('schemaVersion',1,'secretReference',binding.secret_reference,
  'providerSessionId',binding.provider_session_id,'phoneNumberId',binding.phone_number_id,'wabaId',account.provider_account_id,
  'proofSha256',binding.proof_sha256,'appId',binding.app_id,'lifecycleRevision',CASE WHEN session.provider_state_data ? 'metaLifecycle' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE 0 END),
  'metaAccountPolicy',jsonb_build_object('accountId',account.id,'bindingId',binding.id,'bindingRevision',binding.revision,'authorityRevision',account.authority_revision,
   'policyVersionId',policy.id,'observationOperationId',account.last_observation_operation_id),
  'metaManagedFunding',jsonb_build_object('schemaVersion',1,'ownerKind','FUNDING_ATTACHMENT','ownerId',checkpoint.owner_id,'checkpointId',checkpoint.id,
  'stage','RECONCILE','accountId',account.id,'arrangementVersionId',arrangement.id,'authorityRevision',account.authority_revision,
  'policyVersionId',policy.id,'bindingId',binding.id,'bindingRevision',binding.revision,'appId',arrangement.app_id,'currency',arrangement.requested_currency));
 INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,max_attempts,requested_by_type,requested_by_id,request_id)
 VALUES(operation_value,account.tenant_id,binding.connection_id,'VERIFY_META_BILLING','meta-funding-readback:'||key_value,payload_value,'QUEUED',1,'SYSTEM',operator_value,request_value);
 RETURN jsonb_build_object('operationId',operation_value,'state','QUEUED','replay',false);
END;$$;
REVOKE ALL ON FUNCTION app.operator_queue_meta_funding_readback(uuid,bigint,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_queue_meta_funding_readback(uuid,bigint,text,text,text) TO wasalx_platform_operations_client;

-- Private successor; placed AFTER managed-domain and checkpoint definitions.
-- Only new birth rows acquire managed historical references. Old snapshots are
-- neither adopted nor retargeted when account authority changes.
CREATE OR REPLACE FUNCTION app.meta_billing_birth_snapshot(connection_value uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
 policy public.meta_billing_policy_versions;arrangement public.meta_funding_arrangement_versions;payment jsonb;
BEGIN
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',1,'claim','LEGACY_UNATTRIBUTED');END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR SHARE;
 IF NOT FOUND OR account.requested_policy_version_id IS NULL THEN RAISE EXCEPTION 'Meta account policy is unavailable' USING ERRCODE='55000';END IF;
 SELECT * INTO policy FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND account_id=account.id AND id=account.requested_policy_version_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meta account policy is unavailable' USING ERRCODE='55000';END IF;
 IF policy.mode='CUSTOMER' THEN
  payment:=jsonb_build_object('mode','CUSTOMER','actualPayer','UNVERIFIED','managed',NULL);
 ELSIF policy.mode='MANAGED' THEN
  SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=account.tenant_id AND account_id=account.id AND id=policy.arrangement_version_id FOR SHARE;
  IF NOT FOUND OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp()
   OR arrangement.allocation_line_version_id IS NULL OR arrangement.commercial_terms_version_id IS DISTINCT FROM policy.commercial_terms_version_id THEN
   RAISE EXCEPTION 'Managed authority is unavailable' USING ERRCODE='55000';END IF;
  payment:=jsonb_build_object('mode','MANAGED','actualPayer','APPROVED_SOLUTION_PARTNER','managed',jsonb_build_object(
   'arrangementVersionId',arrangement.id::text,'arrangementKind',arrangement.kind,
   'payerAuthorityVersionId',arrangement.payer_authority_version_id::text,'effectiveScopeSha256',arrangement.effective_scope_sha256,
   'allocationLineVersionId',arrangement.allocation_line_version_id::text,'commercialTermsVersionId',arrangement.commercial_terms_version_id::text,'evidenceMode',arrangement.evidence_mode));
 ELSE RAISE EXCEPTION 'Meta payment mode is unsupported' USING ERRCODE='55000';END IF;
 RETURN jsonb_build_object('schemaVersion',2,'claim','ACCOUNT_POLICY_BOUND','tenantId',binding.tenant_id::text,'connectionId',connection_value::text,
  'accountId',account.id::text,'providerAccountId',account.provider_account_id,'identifierKind','MESSAGING_ACCOUNT_ID','accountModel','PHASE1_WABA_ALIAS',
  'bindingId',binding.id::text,'bindingRevision',binding.revision,'accountAuthorityRevision',account.authority_revision,
  'policyVersionId',policy.id::text,'payment',payment,'funding',jsonb_build_object('responseSha256',account.funding_response_sha256,'observedAt',account.funding_observed_at));
END;$$;

-- This typed selector does not authorize an account transition. It accepts only
-- the current account and one previously platform-approved arrangement.
CREATE FUNCTION app.accept_meta_managed_policy(connection_value uuid,arrangement_value uuid,terms_value uuid,tariff_value uuid,
 expected_authority bigint,actor_value uuid,key_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
 arrangement public.meta_funding_arrangement_versions;policy public.meta_billing_policy_versions;prior public.meta_billing_policy_versions;request_sha text;
BEGIN
 IF app.current_tenant_id() IS NULL OR expected_authority IS NULL OR expected_authority NOT BETWEEN 1 AND 9007199254740991
  OR COALESCE(key_value,'') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'Managed policy admission is invalid' USING ERRCODE='23514';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Managed policy admission is fenced by privacy' USING ERRCODE='40001';END IF;
 request_sha:=encode(digest(jsonb_build_object('connectionId',connection_value,'arrangementVersionId',arrangement_value,'termsVersionId',terms_value,
  'acceptedTariffVersionId',tariff_value,'expectedRevision',expected_authority,'requestedBy',actor_value)::text,'sha256'),'hex');
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified account binding is required' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR UPDATE;
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value FOR UPDATE;
 SELECT * INTO prior FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND idempotency_key='meta-managed:'||key_value;
 IF FOUND THEN
  IF prior.account_id IS DISTINCT FROM account.id OR prior.request_sha256 IS DISTINCT FROM request_sha THEN
   RAISE EXCEPTION 'Managed policy key belongs to another admission' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('policyVersionId',prior.id,'requestedMode','MANAGED','replay',true);END IF;
 -- Exact active owner/admin membership and same-account binding, never global
 -- financial IDs chosen through arbitrary tenant payloads.
 IF account.id IS NULL OR account.state='RETIRED' OR account.authority_revision IS DISTINCT FROM expected_authority OR binding.state<>'ACTIVE'
  OR NOT EXISTS(SELECT 1 FROM public.tenant_memberships m WHERE m.tenant_id=account.tenant_id AND m.user_id=actor_value AND m.state='ACTIVE' AND m.role IN('tenant_owner','tenant_admin'))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs j WHERE j.tenant_id=account.tenant_id AND j.job_type='DELETE' AND j.scope_type='TENANT' AND j.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Managed policy authority changed' USING ERRCODE='55000';END IF;
 SELECT * INTO arrangement FROM public.meta_funding_arrangement_versions WHERE tenant_id=account.tenant_id AND account_id=account.id AND id=arrangement_value FOR SHARE;
 IF NOT FOUND OR arrangement.state<>'APPROVED' OR arrangement.expires_at<=clock_timestamp() OR arrangement.app_id IS DISTINCT FROM binding.app_id
  OR arrangement.commercial_terms_version_id IS DISTINCT FROM terms_value OR app.meta_terms_receipt_scope(account.tenant_id,account.id,terms_value,tariff_value) IS NULL THEN
  RAISE EXCEPTION 'Exact approved managed arrangement is required' USING ERRCODE='55000';END IF;
 INSERT INTO public.meta_billing_policy_versions(tenant_id,account_id,version,mode,terms_version,requested_by,idempotency_key,request_sha256,
  commercial_terms_version_id,accepted_tariff_version_id,arrangement_version_id)
 SELECT account.tenant_id,account.id,COALESCE(max(version),0)+1,'MANAGED','META_MANAGED_PAYMENT_V1',actor_value,'meta-managed:'||key_value,request_sha,
  terms_value,tariff_value,arrangement_value FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND account_id=account.id RETURNING * INTO policy;
 UPDATE public.meta_messaging_accounts SET requested_policy_version_id=policy.id,active_policy_version_id=NULL,state='HELD',authority_revision=authority_revision+1,updated_at=now() WHERE id=account.id AND tenant_id=account.tenant_id;
 RETURN jsonb_build_object('policyVersionId',policy.id,'requestedMode','MANAGED','replay',false);
 -- Intent is held until exact allocation readback and fresh funding receipt.
END;$$;
REVOKE ALL ON FUNCTION app.accept_meta_managed_policy(uuid,uuid,uuid,uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_meta_managed_policy(uuid,uuid,uuid,uuid,bigint,uuid,text) TO wasalx_app;

-- Existing credential/lease/lifecycle and birth-generation gates remain intact.
CREATE OR REPLACE FUNCTION app.meta_billing_send_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
 expected_authority bigint,expected_binding bigint)
RETURNS TABLE(allowed boolean,enrolled boolean,provider_account_id text,account_id uuid,policy_version_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT
  binding.state='ACTIVE' AND account.state='READY' AND account.funding_status='PRESENT'
  AND account.primary_funding_id IS NOT NULL AND account.funding_expires_at>clock_timestamp()
  AND account.authority_revision=expected_authority AND binding.revision=expected_binding
  AND account.active_policy_version_id=account.requested_policy_version_id
  AND policy.mode IN('CUSTOMER','MANAGED') AND app.meta_account_payment_ready(account.id,account.primary_funding_id)
  AND binding.provider_session_id=session_value AND binding.phone_number_id=phone_value
  AND account.provider_account_id=account_value AND connection.secret_reference=binding.secret_reference
  AND session.ownership_state='ACTIVE' AND session.opaque_session_id=binding.phone_number_id
  AND session.provider_state_data->>'wabaId'=account.provider_account_id
  AND session.provider_state_data#>>'{metaAccountProof,credentialFingerprint}'=binding.credential_fingerprint
  AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=binding.secret_reference
  AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=binding.tenant_id::text
  AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=binding.connection_id::text
  AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=binding.provider_session_id::text
  AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=binding.phone_number_id
  AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=account.provider_account_id
  AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
  AND session.provider_state_data#>>'{metaAccountProof,schemaVersion}'='1'
  AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=binding.app_id,
  true,account.provider_account_id,account.id,account.active_policy_version_id
 FROM meta_connection_account_bindings binding JOIN meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
 JOIN connections connection ON connection.tenant_id=binding.tenant_id AND connection.id=binding.connection_id
 JOIN provider_sessions session ON session.tenant_id=binding.tenant_id AND session.id=binding.provider_session_id
 LEFT JOIN meta_billing_policy_versions policy ON policy.tenant_id=account.tenant_id AND policy.id=account.active_policy_version_id
 WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value
 UNION ALL SELECT true,false,NULL::text,NULL::uuid,NULL::uuid
 WHERE NOT EXISTS(SELECT 1 FROM meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value)
$$;

-- Explicit CUSTOMER acceptance is a new immutable version. It does not update
-- an older declaration or claim that the operator owns the account/payment card.
CREATE FUNCTION app.accept_meta_customer_terms(connection_value uuid,terms_value uuid,tariff_value uuid,
 expected_authority bigint,actor_value uuid,key_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE binding public.meta_connection_account_bindings;account public.meta_messaging_accounts;
 policy public.meta_billing_policy_versions;prior public.meta_billing_policy_versions;request_sha text;
BEGIN
 IF app.current_tenant_id() IS NULL OR expected_authority IS NULL OR expected_authority NOT BETWEEN 1 AND 9007199254740991
  OR terms_value IS NULL OR COALESCE(key_value,'') !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
  RAISE EXCEPTION 'Customer terms admission is invalid' USING ERRCODE='23514';END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN
  RAISE EXCEPTION 'Customer terms admission is fenced by privacy' USING ERRCODE='40001';END IF;
 request_sha:=encode(digest(jsonb_build_object('connectionId',connection_value,'termsVersionId',terms_value,
  'acceptedTariffVersionId',tariff_value,'expectedRevision',expected_authority,'requestedBy',actor_value)::text,'sha256'),'hex');
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Verified account binding is required' USING ERRCODE='55000';END IF;
 SELECT * INTO account FROM public.meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR UPDATE;
 SELECT * INTO binding FROM public.meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value FOR UPDATE;
 SELECT * INTO prior FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND idempotency_key='meta-customer-terms:'||key_value;
 IF FOUND THEN
  IF prior.account_id IS DISTINCT FROM account.id OR prior.request_sha256 IS DISTINCT FROM request_sha THEN
   RAISE EXCEPTION 'Customer terms key belongs to another admission' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('policyVersionId',prior.id,'requestedMode','CUSTOMER','replay',true);END IF;
 IF account.id IS NULL OR account.state='RETIRED' OR account.authority_revision IS DISTINCT FROM expected_authority OR binding.state<>'ACTIVE'
  OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=account.tenant_id AND state='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=account.tenant_id AND user_id=actor_value AND state='ACTIVE' AND role IN('tenant_owner','tenant_admin'))
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=account.tenant_id AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
  OR app.meta_terms_receipt_scope(account.tenant_id,account.id,terms_value,tariff_value) IS NULL THEN
  RAISE EXCEPTION 'Customer terms authority changed' USING ERRCODE='55000';END IF;
 INSERT INTO public.meta_billing_policy_versions(tenant_id,account_id,version,mode,terms_version,requested_by,idempotency_key,request_sha256,
  commercial_terms_version_id,accepted_tariff_version_id)
 SELECT account.tenant_id,account.id,COALESCE(max(version),0)+1,'CUSTOMER','META_CUSTOMER_PAYMENT_V1',actor_value,'meta-customer-terms:'||key_value,request_sha,
  terms_value,tariff_value FROM public.meta_billing_policy_versions WHERE tenant_id=account.tenant_id AND account_id=account.id RETURNING * INTO policy;
 UPDATE public.meta_messaging_accounts SET requested_policy_version_id=policy.id,active_policy_version_id=NULL,state='HELD',authority_revision=authority_revision+1,updated_at=now()
  WHERE id=account.id AND tenant_id=account.tenant_id;
 RETURN jsonb_build_object('policyVersionId',policy.id,'requestedMode','CUSTOMER','replay',false);
END;$$;
REVOKE ALL ON FUNCTION app.accept_meta_customer_terms(uuid,uuid,uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_meta_customer_terms(uuid,uuid,uuid,bigint,uuid,text) TO wasalx_app;

-- Historical acceptance is independent of current arrangement state. No holder,
-- line, credential, allocation identifier or raw financial receipt is exposed.
-- Appenditive references let P10 match an exact historical issuer-authority ID.
DROP FUNCTION app.meta_accepted_terms_projection(uuid,uuid,uuid);
CREATE FUNCTION app.meta_accepted_terms_projection(p_tenant_id uuid,p_policy_version_id uuid,p_terms_version_id uuid)
RETURNS TABLE(tenant_id uuid,account_id uuid,policy_version_id uuid,evidence_mode text,commercial_terms_version_id uuid,
 document_sha256 text,accepted_tariff_version_id uuid,arrangement_version_id uuid,payer_authority_version_id uuid,
 effective_scope_sha256 text,allocation_line_version_id uuid)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT policy.tenant_id,policy.account_id,policy.id,receipt->>'evidenceMode',policy.commercial_terms_version_id,receipt->>'documentSha256',
  policy.accepted_tariff_version_id,arrangement.id,arrangement.payer_authority_version_id,arrangement.effective_scope_sha256,arrangement.allocation_line_version_id
 FROM public.meta_billing_policy_versions policy
 CROSS JOIN LATERAL app.meta_terms_receipt_scope(policy.tenant_id,policy.account_id,policy.commercial_terms_version_id,policy.accepted_tariff_version_id) AS evidence(receipt)
 LEFT JOIN public.meta_funding_arrangement_versions arrangement ON arrangement.tenant_id=policy.tenant_id AND arrangement.account_id=policy.account_id AND arrangement.id=policy.arrangement_version_id
 WHERE p_tenant_id=app.current_tenant_id() AND policy.tenant_id=p_tenant_id AND policy.id=p_policy_version_id
  AND policy.commercial_terms_version_id=p_terms_version_id AND receipt IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.meta_accepted_terms_projection(uuid,uuid,uuid) FROM PUBLIC;
-- App lacks financial-table SELECT. Keep the private lookup behind one safe
-- role-bound definer rather than widening arrangement visibility.
ALTER FUNCTION app.meta_accepted_terms_projection(uuid,uuid,uuid) SECURITY DEFINER;
ALTER FUNCTION app.meta_accepted_terms_projection(uuid,uuid,uuid) SET row_security=off;
GRANT EXECUTE ON FUNCTION app.meta_accepted_terms_projection(uuid,uuid,uuid) TO wasalx_app,wasalx_connector_worker;

-- Tenant presentation is a safe projection, never a financial mutation grant.
-- Historic hash-only terms remain valid history but cannot create a UI choice.
CREATE FUNCTION app.meta_managed_policy_choices(connection_value uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('choiceId',choice.id,'kind',choice.kind,
  'evidenceMode',choice.evidence_mode,'expiresAt',choice.expires_at,
  'documentSha256',choice.document_sha256,'documentText',choice.document_text) ORDER BY choice.id),'[]'::jsonb)
 FROM (SELECT arrangement.id,arrangement.kind,arrangement.evidence_mode,arrangement.expires_at,
   terms.safe_metadata->>'documentSha256' AS document_sha256,terms.safe_metadata->>'documentText' AS document_text
  FROM public.meta_connection_account_bindings binding
  JOIN public.meta_messaging_accounts account ON account.tenant_id=binding.tenant_id AND account.id=binding.account_id
  JOIN public.meta_funding_arrangement_versions arrangement ON arrangement.tenant_id=account.tenant_id AND arrangement.account_id=account.id AND arrangement.app_id=binding.app_id
  JOIN public.platform_operations_audit_events terms ON terms.id=arrangement.commercial_terms_version_id
  WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND binding.state='ACTIVE'
   AND account.state<>'RETIRED' AND arrangement.state='APPROVED' AND arrangement.expires_at>clock_timestamp()
   AND terms.action='meta.commercial_terms.simulated.versioned'
   AND terms.safe_metadata->>'tenantId'=account.tenant_id::text AND terms.safe_metadata->>'accountId'=account.id::text
   AND terms.safe_metadata->>'evidenceMode'=arrangement.evidence_mode
   AND jsonb_typeof(terms.safe_metadata->'documentText')='string'
   AND octet_length(terms.safe_metadata->>'documentText') BETWEEN 1 AND 32768
   AND encode(digest(convert_to(terms.safe_metadata->>'documentText','UTF8'),'sha256'),'hex')=terms.safe_metadata->>'documentSha256'
   AND EXISTS(SELECT 1 FROM public.tenants WHERE id=account.tenant_id AND state='ACTIVE')
   AND NOT EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=account.tenant_id AND job_type='DELETE' AND scope_type='TENANT' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'))
  ORDER BY arrangement.id LIMIT 8) choice
$$;
CREATE FUNCTION app.select_meta_managed_policy(connection_value uuid,choice_value uuid,document_sha text,
 expected_authority bigint,actor_value uuid,key_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE arrangement public.meta_funding_arrangement_versions;
BEGIN
 SELECT a.* INTO arrangement FROM public.meta_funding_arrangement_versions a
  JOIN public.meta_connection_account_bindings binding ON binding.tenant_id=a.tenant_id AND binding.account_id=a.account_id
  WHERE binding.tenant_id=app.current_tenant_id() AND binding.connection_id=connection_value AND a.id=choice_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Managed option is unavailable' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(app.meta_managed_policy_choices(connection_value)) choice
  WHERE choice->>'choiceId'=choice_value::text AND choice->>'documentSha256'=document_sha) THEN
  RAISE EXCEPTION 'Managed terms changed; refresh the available option' USING ERRCODE='55000';END IF;
 RETURN app.accept_meta_managed_policy(connection_value,choice_value,arrangement.commercial_terms_version_id,NULL,expected_authority,actor_value,key_value);
 -- No attachment operation, payer refresh, connection state or send grant here.
END;$$;
REVOKE ALL ON FUNCTION app.meta_managed_policy_choices(uuid),app.select_meta_managed_policy(uuid,uuid,text,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_managed_policy_choices(uuid),app.select_meta_managed_policy(uuid,uuid,text,bigint,uuid,text) TO wasalx_app;

-- Reuse the current privacy job/lease/stage and exclusive tenant fence. No
-- caller flag can redact managed evidence; attempted/UNKNOWN finance blocks it.
ALTER TABLE meta_funding_arrangement_versions ADD COLUMN redacted_at timestamptz;
ALTER TABLE meta_funding_arrangement_versions ADD COLUMN private_evidence_sha256 text CHECK(private_evidence_sha256 ~ '^[a-f0-9]{64}$');
CREATE FUNCTION app.meta_managed_privacy_authorized(tenant_value uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT tenant_value=app.current_tenant_id()
 AND NOT app.has_applicable_privacy_hold('TENANT',tenant_value::text)
 AND NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints effect WHERE effect.tenant_id=tenant_value AND effect.outcome IN('ATTEMPTED','UNKNOWN'))
 AND EXISTS(SELECT 1 FROM public.privacy_jobs job WHERE job.tenant_id=tenant_value AND job.job_type='DELETE' AND job.scope_type='TENANT'
   AND job.scope_value=tenant_value::text AND job.state='RUNNING' AND job.stage='LOCAL'
   AND job.lease_id IS NOT NULL AND job.lease_expires_at>=clock_timestamp())
$$;
REVOKE ALL ON FUNCTION app.meta_managed_privacy_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_managed_privacy_authorized(uuid) TO wasalx_connector_worker;

-- Retain economic/version references and redacted digests; discard the secret
-- reference, inspected credential metadata and raw private result on deletion.
-- The foreign financial holder/line/account mapping is platform business
-- history, not a tenant credential, and is never a provider revoke instruction.
ALTER TABLE meta_funding_arrangement_versions DROP CONSTRAINT meta_arrangement_secret_reference_check;
ALTER TABLE meta_funding_arrangement_versions ADD CHECK((char_length(financial_secret_reference)<=512 AND financial_secret_reference ~ '^secret://[A-Za-z0-9][A-Za-z0-9._~:/-]*$')
 OR (redacted_at IS NOT NULL AND financial_secret_reference='[removed]'));
CREATE OR REPLACE FUNCTION app.preserve_meta_arrangement_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Managed authority history must be retained' USING ERRCODE='55000';END IF;
 IF NEW.redacted_at IS NOT NULL AND OLD.redacted_at IS NULL THEN
  IF NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER') OR NOT app.meta_managed_privacy_authorized(OLD.tenant_id)
   OR NEW.state<>'REVOKED' OR NEW.financial_secret_reference<>'[removed]'
   OR NEW.financial_credential_metadata IS DISTINCT FROM jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.financial_credential_metadata::text,'sha256'),'hex'))
   OR NEW.private_evidence_sha256 IS DISTINCT FROM encode(digest((to_jsonb(OLD)-ARRAY['redacted_at','private_evidence_sha256'])::text,'sha256'),'hex')
   OR (to_jsonb(NEW)-ARRAY['state','financial_secret_reference','financial_credential_metadata','redacted_at','private_evidence_sha256']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','financial_secret_reference','financial_credential_metadata','redacted_at','private_evidence_sha256']) THEN
   RAISE EXCEPTION 'Managed private evidence requires current tenant privacy authority' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF OLD.redacted_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
  RAISE EXCEPTION 'Redacted managed authority cannot be restored' USING ERRCODE='23514';END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT pg_has_role(current_user,'wasalx_platform_operations_client','MEMBER')
  AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID)) THEN
  RAISE EXCEPTION 'Local arrangement revoke requires platform authority' USING ERRCODE='23514';END IF;
 IF (to_jsonb(NEW)-ARRAY['state','allocation_line_version_id','allocation_observed_at','allocation_expires_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','allocation_line_version_id','allocation_observed_at','allocation_expires_at'])
  OR (OLD.state='REVOKED' AND NEW.state<>'REVOKED')
  OR (OLD.allocation_line_version_id IS NOT NULL AND NEW.allocation_line_version_id IS DISTINCT FROM OLD.allocation_line_version_id) THEN
  RAISE EXCEPTION 'Managed authority versions are immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
CREATE OR REPLACE FUNCTION app.preserve_meta_financial_checkpoint() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Financial effect history must be retained' USING ERRCODE='55000';END IF;
 IF OLD.outcome NOT IN('ATTEMPTED','UNKNOWN') AND NOT(OLD.result ? 'redacted')
  AND NEW.result=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.result::text,'sha256'),'hex'))
  AND pg_has_role(current_user,'wasalx_connector_worker','MEMBER') AND app.meta_managed_privacy_authorized(OLD.tenant_id)
  AND (to_jsonb(NEW)-'result') IS NOT DISTINCT FROM (to_jsonb(OLD)-'result') THEN RETURN NEW;END IF;
 IF NEW.result IS DISTINCT FROM OLD.result AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID)) THEN
  RAISE EXCEPTION 'Financial evidence may change only through the original receipt or leased privacy authority' USING ERRCODE='23514';END IF;
 IF (to_jsonb(NEW)-ARRAY['outcome','result','result_sha256','settled_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['outcome','result','result_sha256','settled_at'])
  OR (OLD.outcome<>'ATTEMPTED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
  RAISE EXCEPTION 'Financial checkpoint is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;$$;
-- Only the incumbent leased privacy worker can make these two narrow writes.
GRANT UPDATE(state,financial_secret_reference,financial_credential_metadata,redacted_at,private_evidence_sha256) ON meta_funding_arrangement_versions TO wasalx_connector_worker;
GRANT UPDATE(result) ON meta_provider_effect_checkpoints TO wasalx_connector_worker;

CREATE OR REPLACE FUNCTION app.preserve_meta_funding_receipt() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE prior jsonb;next_value jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF COALESCE(NEW.result ? 'metaAccountFundingProof',false) THEN RAISE EXCEPTION 'Caller cannot insert funding read evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 prior:=OLD.result->'metaAccountFundingProof';
 IF TG_OP='DELETE' THEN
  IF prior IS NOT NULL AND NOT(prior ? 'redacted') THEN RAISE EXCEPTION 'Funding read evidence must be retained' USING ERRCODE='55000'; END IF;
  RETURN OLD;
 END IF;
 next_value:=NEW.result->'metaAccountFundingProof';
 IF OLD.payload ? 'metaAccountPolicy' OR NEW.payload ? 'metaAccountPolicy' OR prior IS NOT NULL THEN
  IF (NEW.tenant_id,NEW.id,NEW.connection_id,NEW.operation_type,NEW.created_at) IS DISTINCT FROM
     (OLD.tenant_id,OLD.id,OLD.connection_id,OLD.operation_type,OLD.created_at)
    OR NEW.payload->'metaAccountPolicy' IS DISTINCT FROM OLD.payload->'metaAccountPolicy'
    OR NEW.payload->'metaBillingDiagnostic' IS DISTINCT FROM OLD.payload->'metaBillingDiagnostic' THEN
   RAISE EXCEPTION 'Funding observation admission is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF next_value IS NOT DISTINCT FROM prior THEN RETURN NEW; END IF;
 IF prior IS NULL THEN
  IF NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER') OR OLD.operation_type<>'VERIFY_META_BILLING'
    OR NOT(OLD.payload ? 'metaAccountPolicy') OR OLD.state<>'RUNNING' OR OLD.lease_id IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<clock_timestamp()
    OR (NEW.state<>'SUCCEEDED' AND NOT(NEW.state='RUNNING' AND next_value->>'status'='UNAVAILABLE'))
    OR jsonb_typeof(next_value) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(next_value))<>(CASE WHEN next_value ? 'currency' THEN 10 ELSE 9 END)
    OR (next_value ? 'currency' AND NOT app.meta_currency_observation_valid(next_value->'currency',next_value->>'accountId',
      (next_value->>'observedAt')::timestamptz,(next_value->>'expiresAt')::timestamptz))
    OR next_value->>'schemaVersion' IS DISTINCT FROM '1' OR next_value->>'actualPayer' IS DISTINCT FROM 'UNVERIFIED'
    OR next_value->>'accountId' IS DISTINCT FROM OLD.payload#>>'{metaBillingDiagnostic,wabaId}'
    OR COALESCE(next_value->>'status','') NOT IN('PRESENT','NONE','UNAVAILABLE')
    OR COALESCE(next_value->>'responseSha256','') !~ '^[a-f0-9]{64}$'
    OR NOT(next_value ?& ARRAY['schemaVersion','accountId','observedOwnerBusinessId','primaryFundingId','status','actualPayer','responseSha256','observedAt','expiresAt'])
    OR jsonb_typeof(next_value->'observedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(next_value->'expiresAt') IS DISTINCT FROM 'string'
    OR (next_value->>'status'='PRESENT' AND COALESCE(next_value->>'primaryFundingId','') !~ '^[A-Za-z0-9._:-]{1,128}$')
    OR (next_value->>'status'<>'PRESENT' AND next_value->'primaryFundingId' IS DISTINCT FROM 'null'::jsonb)
    OR (next_value->>'expiresAt')::timestamptz<>(next_value->>'observedAt')::timestamptz+interval '15 minutes'
    OR (next_value->>'observedAt')::timestamptz>clock_timestamp()+interval '5 seconds'
    OR NOT EXISTS(SELECT 1 FROM meta_connection_account_bindings b JOIN meta_messaging_accounts a ON a.tenant_id=b.tenant_id AND a.id=b.account_id
      WHERE b.tenant_id=OLD.tenant_id AND b.connection_id=OLD.connection_id AND b.id::text=OLD.payload#>>'{metaAccountPolicy,bindingId}'
        AND a.id::text=OLD.payload#>>'{metaAccountPolicy,accountId}' AND a.provider_account_id=next_value->>'accountId') THEN
   RAISE EXCEPTION 'Funding receipt requires the admitted live worker observation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NOT(prior ? 'redacted') AND next_value=jsonb_build_object('redacted',true,'sha256',encode(digest(prior::text,'sha256'),'hex'))
    AND EXISTS(SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=OLD.tenant_id AND job.job_type='DELETE'
      AND job.scope_type='TENANT' AND job.scope_value=OLD.tenant_id::text AND job.state='RUNNING' AND job.stage='LOCAL'
      AND job.lease_id IS NOT NULL AND job.lease_expires_at>=clock_timestamp())
    AND NOT app.has_applicable_privacy_hold('TENANT',OLD.tenant_id::text)
    AND NOT EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.tenant_id=OLD.tenant_id
      AND (d.state IN('SENDING','OUTCOME_UNKNOWN') OR (d.state='CLAIMED' AND d.lease_expires_at>=clock_timestamp()))) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Funding read receipt is immutable' USING ERRCODE='23514';
END; $$;

COMMIT;
