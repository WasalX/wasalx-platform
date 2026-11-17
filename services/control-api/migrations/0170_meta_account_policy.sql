BEGIN;
-- Account access, connection credential binding and immutable declared policy
-- are separate concepts. None establishes customer legal ownership or payer title.
CREATE TABLE meta_messaging_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 provider_account_id text NOT NULL CHECK(provider_account_id ~ '^[0-9]{1,32}$'),
 observed_owner_business_id text CHECK(observed_owner_business_id ~ '^[0-9]{1,32}$'),
 independent_customer_ownership text NOT NULL DEFAULT 'UNVERIFIED' CHECK(independent_customer_ownership='UNVERIFIED'),
 state text NOT NULL DEFAULT 'HELD' CHECK(state IN('HELD','READY','RETIRED')),
 authority_revision bigint NOT NULL DEFAULT 1 CHECK(authority_revision BETWEEN 1 AND 9007199254740991),
 active_policy_version_id uuid, requested_policy_version_id uuid,
 funding_status text NOT NULL DEFAULT 'UNAVAILABLE' CHECK(funding_status IN('PRESENT','NONE','UNAVAILABLE')),
 primary_funding_id text CHECK(primary_funding_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 funding_response_sha256 text CHECK(funding_response_sha256 ~ '^[a-f0-9]{64}$'),
 funding_observed_at timestamptz, funding_expires_at timestamptz, last_observation_operation_id uuid,
 actual_payer text NOT NULL DEFAULT 'UNVERIFIED' CHECK(actual_payer='UNVERIFIED'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(provider_account_id),
 FOREIGN KEY(tenant_id,last_observation_operation_id) REFERENCES connection_operations(tenant_id,id)
);
CREATE TABLE meta_connection_account_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 account_id uuid NOT NULL,connection_id uuid NOT NULL,provider_session_id uuid NOT NULL,
 phone_number_id text NOT NULL CHECK(phone_number_id ~ '^[0-9]{1,32}$'),
 app_id text NOT NULL CHECK(app_id ~ '^[0-9]{1,32}$'),secret_reference text NOT NULL,
 credential_fingerprint text NOT NULL CHECK(credential_fingerprint ~ '^[a-f0-9]{64}$'),
 proof_sha256 text NOT NULL CHECK(proof_sha256 ~ '^[a-f0-9]{64}$'),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN('ACTIVE','HELD','RETIRED')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,connection_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES connections(tenant_id,id),
 FOREIGN KEY(tenant_id,connection_id,provider_session_id) REFERENCES provider_sessions(tenant_id,connection_id,id)
);
CREATE TABLE meta_billing_policy_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 account_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 mode text NOT NULL CHECK(mode='CUSTOMER'),requested_by uuid NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),idempotency_key text NOT NULL,
 terms_version text NOT NULL DEFAULT 'META_CUSTOMER_PAYMENT_V1' CHECK(terms_version='META_CUSTOMER_PAYMENT_V1'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,account_id,version),UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES tenant_memberships(tenant_id,user_id)
);
ALTER TABLE meta_messaging_accounts ADD FOREIGN KEY(tenant_id,active_policy_version_id) REFERENCES meta_billing_policy_versions(tenant_id,id);
ALTER TABLE meta_messaging_accounts ADD FOREIGN KEY(tenant_id,requested_policy_version_id) REFERENCES meta_billing_policy_versions(tenant_id,id);
CREATE FUNCTION app.preserve_meta_billing_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Meta billing policy history is immutable' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER meta_billing_policy_immutable BEFORE UPDATE OR DELETE ON meta_billing_policy_versions FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_billing_policy();
ALTER TABLE meta_messaging_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_messaging_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_messaging_accounts USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
ALTER TABLE meta_connection_account_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_connection_account_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_connection_account_bindings USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
ALTER TABLE meta_billing_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_billing_policy_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON meta_billing_policy_versions USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON meta_messaging_accounts,meta_connection_account_bindings TO wasalx_app;
GRANT SELECT,INSERT ON meta_billing_policy_versions TO wasalx_app;
GRANT SELECT,UPDATE ON meta_messaging_accounts,meta_connection_account_bindings TO wasalx_connector_worker;
GRANT SELECT ON meta_billing_policy_versions TO wasalx_connector_worker;
-- Reuse the existing privacy write fence; new authority/history cannot be born
-- while local deletion holds its exclusive tenant lock.
CREATE TRIGGER meta_account_privacy_statement_fence BEFORE INSERT OR UPDATE ON meta_messaging_accounts
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER meta_binding_privacy_statement_fence BEFORE INSERT OR UPDATE ON meta_connection_account_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE TRIGGER meta_policy_privacy_statement_fence BEFORE INSERT ON meta_billing_policy_versions
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();
CREATE FUNCTION app.guard_meta_account_policy_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
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
CREATE TRIGGER meta_account_state_guard BEFORE INSERT OR UPDATE ON meta_messaging_accounts FOR EACH ROW EXECUTE FUNCTION app.guard_meta_account_policy_state();
CREATE TRIGGER meta_binding_state_guard BEFORE INSERT OR UPDATE ON meta_connection_account_bindings FOR EACH ROW EXECUTE FUNCTION app.guard_meta_account_policy_state();

-- The bounded read outcome is now an authority input and retained history.
-- Only a live worker observation can create it; later ordinary writes cannot
-- replace it or its original policy/credential admission.
CREATE FUNCTION app.preserve_meta_funding_receipt() RETURNS trigger LANGUAGE plpgsql
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
    OR jsonb_typeof(next_value) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(next_value))<>9
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
CREATE TRIGGER meta_funding_receipt_immutable BEFORE INSERT OR UPDATE OR DELETE ON connection_operations
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_funding_receipt();

ALTER TABLE delivery_outbox ADD COLUMN meta_billing_snapshot jsonb;
ALTER TABLE delivery_attempts ADD COLUMN meta_billing_admission jsonb;
ALTER TABLE delivery_attempts ADD COLUMN external_message_id text;
CREATE FUNCTION app.meta_billing_birth_snapshot(connection_value uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE binding meta_connection_account_bindings;account meta_messaging_accounts;
BEGIN
 SELECT * INTO binding FROM meta_connection_account_bindings WHERE tenant_id=app.current_tenant_id() AND connection_id=connection_value FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',1,'claim','LEGACY_UNATTRIBUTED'); END IF;
 SELECT * INTO account FROM meta_messaging_accounts WHERE tenant_id=binding.tenant_id AND id=binding.account_id FOR SHARE;
 IF NOT FOUND OR account.requested_policy_version_id IS NULL THEN RAISE EXCEPTION 'Meta account policy is unavailable' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('schemaVersion',1,'claim','ACCOUNT_POLICY_BOUND','tenantId',binding.tenant_id::text,'connectionId',connection_value::text,
 'accountId',account.id::text,'providerAccountId',account.provider_account_id,'identifierKind','MESSAGING_ACCOUNT_ID',
 'bindingId',binding.id::text,'bindingRevision',binding.revision,'accountAuthorityRevision',account.authority_revision,
 'policyVersionId',account.requested_policy_version_id::text,'mode','CUSTOMER','actualPayer','UNVERIFIED',
 'fundingResponseSha256',account.funding_response_sha256,'fundingObservedAt',account.funding_observed_at);
END; $$;
CREATE FUNCTION app.snapshot_meta_billing() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE provider_value text;
BEGIN
 SELECT provider INTO provider_value FROM connections WHERE tenant_id=NEW.tenant_id AND id=NEW.connection_id FOR SHARE;
 IF provider_value='META' THEN
  IF NEW.meta_billing_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot supply Meta billing attribution' USING ERRCODE='23514'; END IF;
  -- The connection lock serializes explicit enrollment with every queue writer.
  NEW.meta_billing_snapshot:=app.meta_billing_birth_snapshot(NEW.connection_id);
 ELSIF NEW.meta_billing_snapshot IS NOT NULL THEN RAISE EXCEPTION 'Meta billing attribution on another provider' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER meta_billing_birth BEFORE INSERT ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION app.snapshot_meta_billing();

CREATE FUNCTION app.meta_billing_send_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
 expected_authority bigint,expected_binding bigint)
RETURNS TABLE(allowed boolean,enrolled boolean,provider_account_id text,account_id uuid,policy_version_id uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT
  binding.state='ACTIVE' AND account.state='READY' AND account.funding_status='PRESENT'
  AND account.primary_funding_id IS NOT NULL AND account.funding_expires_at>clock_timestamp()
  AND account.authority_revision=expected_authority AND binding.revision=expected_binding
  AND account.active_policy_version_id=account.requested_policy_version_id
  AND policy.mode='CUSTOMER' AND binding.provider_session_id=session_value AND binding.phone_number_id=phone_value
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
CREATE FUNCTION app.meta_billing_delivery_current(delivery_value uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM delivery_outbox delivery JOIN provider_sessions session
  ON session.tenant_id=delivery.tenant_id AND session.connection_id=delivery.connection_id AND session.ownership_state='ACTIVE'
  CROSS JOIN LATERAL app.meta_billing_send_guard(delivery.connection_id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId',
   CASE WHEN delivery.meta_billing_snapshot->>'claim'='ACCOUNT_POLICY_BOUND' THEN (delivery.meta_billing_snapshot->>'accountAuthorityRevision')::bigint ELSE NULL END,
   CASE WHEN delivery.meta_billing_snapshot->>'claim'='ACCOUNT_POLICY_BOUND' THEN (delivery.meta_billing_snapshot->>'bindingRevision')::bigint ELSE NULL END) guard
  WHERE delivery.tenant_id=app.current_tenant_id() AND delivery.id=delivery_value AND guard.allowed IS TRUE
   AND (NOT guard.enrolled OR (delivery.meta_billing_snapshot->>'claim'='ACCOUNT_POLICY_BOUND'
    AND delivery.meta_billing_snapshot->>'accountId'=guard.account_id::text AND delivery.meta_billing_snapshot->>'policyVersionId'=guard.policy_version_id::text
    AND delivery.meta_billing_snapshot->>'providerAccountId'=guard.provider_account_id
    AND delivery.meta_billing_snapshot->>'tenantId'=delivery.tenant_id::text
    AND delivery.meta_billing_snapshot->>'connectionId'=delivery.connection_id::text
    AND EXISTS(SELECT 1 FROM meta_connection_account_bindings b WHERE b.tenant_id=delivery.tenant_id AND b.connection_id=delivery.connection_id AND b.id::text=delivery.meta_billing_snapshot->>'bindingId'))))
$$;
CREATE FUNCTION app.preserve_meta_billing_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
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
    AND jsonb_typeof(new_value)='object' AND new_value->>'schemaVersion'='1' AND new_value->>'claim'='MESSAGES_REQUEST_ADMITTED'
    AND (SELECT count(*) FROM jsonb_object_keys(new_value))=9
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
CREATE TRIGGER meta_billing_birth_immutable BEFORE UPDATE OF meta_billing_snapshot ON delivery_outbox FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_billing_evidence();
CREATE TRIGGER meta_billing_attempt_immutable BEFORE UPDATE OF meta_billing_admission ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_billing_evidence();
CREATE TRIGGER meta_billing_attempt_no_caller_insert BEFORE INSERT ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_billing_evidence();
CREATE FUNCTION app.preserve_meta_attempt_effect() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.meta_billing_admission IS NOT NULL AND NOT(OLD.meta_billing_admission ? 'redacted') THEN
   RAISE EXCEPTION 'Meta attempted request evidence must be retained' USING ERRCODE='55000'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.external_message_id IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot insert provider effect evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF (OLD.meta_billing_admission IS NOT NULL OR NEW.meta_billing_admission IS NOT NULL
  OR OLD.external_message_id IS NOT NULL OR NEW.external_message_id IS NOT NULL)
  AND (NEW.id,NEW.tenant_id,NEW.delivery_id,NEW.attempt_number) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.delivery_id,OLD.attempt_number) THEN
  RAISE EXCEPTION 'Retained attempt identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.external_message_id IS NOT DISTINCT FROM OLD.external_message_id THEN RETURN NEW; END IF;
 IF OLD.external_message_id IS NULL AND NEW.external_message_id IS NOT NULL
  AND NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER') THEN
  RAISE EXCEPTION 'Only the connector worker may record provider effect evidence' USING ERRCODE='23514'; END IF;
 IF OLD.external_message_id IS NULL AND NEW.external_message_id IS NOT NULL AND OLD.state='SENDING' AND OLD.finished_at IS NULL
  AND (NEW.id,NEW.tenant_id,NEW.delivery_id,NEW.attempt_number) IS NOT DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.delivery_id,OLD.attempt_number)
  AND NEW.state IN('SENT','DELIVERED','READ') AND NEW.finished_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.tenant_id=NEW.tenant_id AND d.id=NEW.delivery_id
    AND d.state IN('SENT','DELIVERED','READ') AND d.external_message_id=NEW.external_message_id
    AND d.attempts=OLD.attempt_number
    AND EXISTS(SELECT 1 FROM connections c WHERE c.tenant_id=d.tenant_id AND c.id=d.connection_id
      AND (c.provider<>'META' OR (OLD.meta_billing_admission->>'claim'='MESSAGES_REQUEST_ADMITTED'
        AND OLD.meta_billing_admission->>'attemptId'=OLD.id::text
        AND OLD.meta_billing_admission->>'attemptNumber'=OLD.attempt_number::text
        AND OLD.meta_billing_admission->>'deliveryId'=d.id::text
        AND OLD.meta_billing_admission->'snapshot' IS NOT DISTINCT FROM COALESCE(d.meta_billing_snapshot,'null'::jsonb)))))
    THEN RETURN NEW; END IF;
 IF NEW.external_message_id IS NULL AND app.meta_direct_privacy_target_authorized('DELIVERY',OLD.delivery_id::text)
  AND EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=OLD.tenant_id AND delivery.id=OLD.delivery_id
    AND delivery.state NOT IN('SENDING','OUTCOME_UNKNOWN')
    AND NOT(delivery.state='CLAIMED' AND delivery.lease_expires_at>=clock_timestamp())) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Provider effect evidence is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER meta_attempt_effect_immutable BEFORE INSERT OR UPDATE OR DELETE ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_attempt_effect();
REVOKE ALL ON FUNCTION app.meta_billing_birth_snapshot(uuid),app.meta_billing_send_guard(uuid,uuid,text,text,bigint,bigint),app.meta_billing_delivery_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_billing_birth_snapshot(uuid),app.meta_billing_send_guard(uuid,uuid,text,text,bigint,bigint),app.meta_billing_delivery_current(uuid) TO wasalx_app,wasalx_connector_worker;
-- Reached by exact Meta success/batch receipts. Preserve0157 bytes and ACLs.
ALTER FUNCTION app.delivery_no_further_attempts(uuid,uuid) SET search_path=pg_catalog,public,app,pg_temp;
COMMIT;
