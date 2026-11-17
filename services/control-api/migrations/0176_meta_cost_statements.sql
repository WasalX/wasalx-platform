-- Private P10c source; delivery ordinal assigned by root before integration.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('app.meta_cost_usage_snapshot(uuid,uuid,timestamp with time zone,timestamp with time zone)') IS NULL
 OR to_regprocedure('app.meta_accepted_terms_projection(uuid,uuid,uuid)') IS NULL THEN
  RAISE EXCEPTION 'Historical Meta account/terms and cost assessment contracts are required';
 END IF;
END $$;

ALTER TABLE retention_policies ADD COLUMN finance_policy jsonb;
ALTER TABLE retention_policies ADD CONSTRAINT retention_finance_policy_shape CHECK(finance_policy IS NULL OR
 (jsonb_typeof(finance_policy)='object' AND octet_length(finance_policy::text)<=4096
  AND finance_policy ?& ARRAY['evidenceMode','sourceDays','recordDays','basisSha256','approvedAt','approvedBy','policyVersionId','commercialTermsVersionId']
  AND finance_policy->>'evidenceMode' IN('LIVE','SIMULATED')
  AND (finance_policy->>'sourceDays')::integer BETWEEN 1 AND 3650
  AND (finance_policy->>'recordDays')::integer BETWEEN (finance_policy->>'sourceDays')::integer AND 3650
  AND finance_policy->>'basisSha256'~'^[0-9a-f]{64}$') IS TRUE);
CREATE FUNCTION app.preserve_meta_finance_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF ((TG_OP='INSERT' AND NEW.finance_policy IS NOT NULL) OR(TG_OP='UPDATE' AND NEW.finance_policy IS DISTINCT FROM OLD.finance_policy))
  AND NOT pg_has_role(current_user,'wasalx_platform_operations_client','MEMBER') THEN
  RAISE EXCEPTION 'Finance retention requires platform authority' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_finance_policy_authority BEFORE INSERT OR UPDATE OF finance_policy ON retention_policies
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_finance_policy();

CREATE TABLE meta_cost_statement_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),
 account_id uuid NOT NULL,policy_version_id uuid NOT NULL,commercial_terms_version_id uuid NOT NULL,
 basis_kind text NOT NULL CHECK(basis_kind IN('UPSTREAM_SOURCE','CUSTOMER_TARIFF_DERIVATION')),
 purpose text NOT NULL CHECK(purpose IN('UPSTREAM_CHARGE','CUSTOMER_CHARGE')),
 evidence_mode text NOT NULL CHECK(evidence_mode IN('LIVE','SIMULATED','UNKNOWN')),
 currency text NOT NULL CHECK(currency~'^[A-Z]{3}$'),minor_units smallint NOT NULL CHECK(minor_units BETWEEN 0 AND 3),
 period_from timestamptz NOT NULL,period_to timestamptz NOT NULL,
 timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 64),
 normalized_input jsonb NOT NULL CHECK(jsonb_typeof(normalized_input)='object' AND octet_length(normalized_input::text)<=524288),
 input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),
 source_identity_sha256 text CHECK(source_identity_sha256~'^[0-9a-f]{64}$'),
 lifecycle text NOT NULL DEFAULT 'SOURCE_PENDING' CHECK(lifecycle IN('SOURCE_PENDING','SOURCE_READY','REVIEWED','PUBLISHED','REJECTED','EXPIRED')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 object_key text,original_sha256 text CHECK(original_sha256~'^[0-9a-f]{64}$'),
 original_byte_size integer CHECK(original_byte_size BETWEEN 1 AND 10485760),
 original_mime text CHECK(original_mime IN('application/pdf','text/csv','application/json')),
 source_state text NOT NULL CHECK(source_state IN('NONE','RESERVED','UPLOADING','READY','UNKNOWN','PURGE_PENDING','PURGED','REJECTED')),
 write_attempt_id uuid,write_admitted_at timestamptz,
 write_disposition text CHECK(write_disposition IN('ADMITTED','WRITTEN','NOT_WRITTEN','UNKNOWN')),
 write_settled_at timestamptz,scan_sha256 text CHECK(scan_sha256~'^[0-9a-f]{64}$'),
 source_ready_at timestamptz,source_delete_after timestamptz,source_purged_at timestamptz,
 retention_snapshot jsonb NOT NULL CHECK(jsonb_typeof(retention_snapshot)='object' AND octet_length(retention_snapshot::text)<=4096),
 source_subject_coverage text NOT NULL DEFAULT 'UNKNOWN' CHECK(source_subject_coverage IN('UNKNOWN','VERIFIED_NO_SUBJECT_DATA','VERIFIED_COMPLETE_SUBJECT_MAPPING')),
 subject_attestation jsonb CHECK(subject_attestation IS NULL OR(jsonb_typeof(subject_attestation)='object' AND octet_length(subject_attestation::text)<=524288)),
 verification jsonb CHECK(verification IS NULL OR(jsonb_typeof(verification)='object' AND octet_length(verification::text)<=16384)),
 preview jsonb CHECK(preview IS NULL OR(jsonb_typeof(preview)='object' AND octet_length(preview::text)<=10485760)),
 publication jsonb CHECK(publication IS NULL OR(jsonb_typeof(publication)='object' AND octet_length(publication::text)<=10485760)),
 publication_sha256 text CHECK(publication_sha256~'^[0-9a-f]{64}$'),published_at timestamptz,record_delete_after timestamptz,
 predecessor_id uuid,
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,source_identity_sha256),
 FOREIGN KEY(tenant_id,account_id) REFERENCES meta_messaging_accounts(tenant_id,id),
 FOREIGN KEY(tenant_id,policy_version_id) REFERENCES meta_billing_policy_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,predecessor_id) REFERENCES meta_cost_statement_versions(tenant_id,id),
 CHECK(period_from<period_to AND period_to-period_from<=interval '366 days'),
 CHECK((basis_kind='UPSTREAM_SOURCE')=(purpose='UPSTREAM_CHARGE')),
 CHECK((basis_kind='UPSTREAM_SOURCE')=(object_key IS NOT NULL AND original_sha256 IS NOT NULL AND original_byte_size IS NOT NULL AND original_mime IS NOT NULL AND source_identity_sha256 IS NOT NULL)),
 CHECK(basis_kind<>'CUSTOMER_TARIFF_DERIVATION' OR source_state='NONE'),
 CHECK(basis_kind<>'CUSTOMER_TARIFF_DERIVATION' OR(object_key IS NULL AND original_sha256 IS NULL AND original_byte_size IS NULL AND original_mime IS NULL AND source_identity_sha256 IS NULL)),
 CHECK(object_key IS NULL OR object_key='tenants/'||tenant_id::text||'/meta-cost-sources/'||id::text||'/'||original_sha256||'.bin'),
 CHECK((write_attempt_id IS NULL)=(write_disposition IS NULL)),
 CHECK((write_attempt_id IS NULL)=(write_admitted_at IS NULL)),
 CHECK(write_disposition NOT IN('WRITTEN','NOT_WRITTEN') OR write_settled_at IS NOT NULL),
 CHECK(source_state NOT IN('READY','PURGED') OR write_disposition IN('WRITTEN','NOT_WRITTEN') OR write_attempt_id IS NULL),
 CHECK(source_state<>'READY' OR(write_disposition='WRITTEN' AND source_ready_at IS NOT NULL AND source_delete_after IS NOT NULL AND scan_sha256 IS NOT NULL)),
 CHECK(source_state<>'PURGED' OR source_purged_at IS NOT NULL),
 CHECK((lifecycle='PUBLISHED')=(publication IS NOT NULL AND publication_sha256 IS NOT NULL AND published_at IS NOT NULL AND record_delete_after IS NOT NULL))
);
CREATE UNIQUE INDEX meta_cost_statement_initial_publication ON meta_cost_statement_versions
 (tenant_id,account_id,purpose,evidence_mode,currency,period_from,period_to) WHERE lifecycle='PUBLISHED' AND predecessor_id IS NULL;
CREATE UNIQUE INDEX meta_cost_statement_successor ON meta_cost_statement_versions(tenant_id,predecessor_id)
 WHERE lifecycle='PUBLISHED' AND predecessor_id IS NOT NULL;
CREATE INDEX meta_cost_statement_history ON meta_cost_statement_versions(tenant_id,account_id,period_from,created_at,id);
CREATE INDEX meta_cost_statement_source_due ON meta_cost_statement_versions(source_delete_after,tenant_id,id)
 WHERE source_state IN('READY','PURGE_PENDING');
CREATE INDEX meta_cost_statement_staging_due ON meta_cost_statement_versions(expires_at,tenant_id,id)
 WHERE lifecycle IN('SOURCE_PENDING','SOURCE_READY','REVIEWED');
ALTER TABLE meta_cost_statement_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_cost_statement_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY meta_cost_statement_tenant ON meta_cost_statement_versions
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());

CREATE FUNCTION app.preserve_meta_cost_statement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF NOT app.meta_cost_record_purge_admitted(OLD) THEN RAISE EXCEPTION 'Statement retention purge requires its checked domain operation' USING ERRCODE='42501'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.account_id,NEW.policy_version_id,NEW.commercial_terms_version_id,NEW.basis_kind,NEW.purpose,
  NEW.evidence_mode,NEW.currency,NEW.minor_units,NEW.period_from,NEW.period_to,NEW.timezone,NEW.normalized_input,NEW.input_sha256,
  NEW.source_identity_sha256,NEW.object_key,NEW.original_sha256,NEW.original_byte_size,NEW.original_mime,NEW.retention_snapshot,NEW.created_at,NEW.created_by,NEW.expires_at)
 IS DISTINCT FROM
 (OLD.id,OLD.tenant_id,OLD.account_id,OLD.policy_version_id,OLD.commercial_terms_version_id,OLD.basis_kind,OLD.purpose,
  OLD.evidence_mode,OLD.currency,OLD.minor_units,OLD.period_from,OLD.period_to,OLD.timezone,OLD.normalized_input,OLD.input_sha256,
  OLD.source_identity_sha256,OLD.object_key,OLD.original_sha256,OLD.original_byte_size,OLD.original_mime,OLD.retention_snapshot,OLD.created_at,OLD.created_by,OLD.expires_at)
 OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'Statement source identity is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.publication IS NOT NULL AND (NEW.publication,NEW.publication_sha256,NEW.published_at,NEW.predecessor_id,NEW.lifecycle,NEW.record_delete_after)
  IS DISTINCT FROM(OLD.publication,OLD.publication_sha256,OLD.published_at,OLD.predecessor_id,OLD.lifecycle,OLD.record_delete_after) THEN
  RAISE EXCEPTION 'Published statement is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.write_attempt_id IS NOT NULL AND (NEW.write_attempt_id,NEW.write_admitted_at,NEW.scan_sha256) IS DISTINCT FROM(OLD.write_attempt_id,OLD.write_admitted_at,OLD.scan_sha256) THEN
  RAISE EXCEPTION 'Admitted source write is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.write_disposition IN('WRITTEN','NOT_WRITTEN') AND (NEW.write_disposition,NEW.write_settled_at,NEW.scan_sha256)
  IS DISTINCT FROM(OLD.write_disposition,OLD.write_settled_at,OLD.scan_sha256) THEN
  RAISE EXCEPTION 'Terminal source write evidence is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.source_state='PURGED' AND NEW.source_state<>'PURGED' THEN RAISE EXCEPTION 'Purged source cannot be restored' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_cost_statement_immutable BEFORE UPDATE OR DELETE ON meta_cost_statement_versions
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_cost_statement();
CREATE TRIGGER meta_cost_statement_privacy_fence BEFORE INSERT OR UPDATE ON meta_cost_statement_versions
 FOR EACH STATEMENT EXECUTE FUNCTION app.lock_privacy_scoped_write();

CREATE FUNCTION app.meta_cost_statement_lock(tenant_value uuid,account_value uuid,purpose_value text,mode_value text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE selected_purpose text;selected_mode text;
BEGIN
 IF purpose_value NOT IN('UPSTREAM_CHARGE','CUSTOMER_CHARGE') OR mode_value NOT IN('LIVE','SIMULATED','UNKNOWN') THEN
  RAISE EXCEPTION 'Invalid statement lock scope' USING ERRCODE='22023'; END IF;
 -- The incumbent snapshot freezes both purposes and all three modes in one
 -- bounded set. Hold that exact finite set of existing locks, in fixed order,
 -- before reading its digest. Published rows/totals still select one mode and
 -- purpose. This avoids inventing a second current-assessment selector.
 FOREACH selected_purpose IN ARRAY ARRAY['CUSTOMER_TARIFF','UPSTREAM_REFERENCE'] LOOP
  FOREACH selected_mode IN ARRAY ARRAY['LIVE','SIMULATED','UNKNOWN'] LOOP
   PERFORM app.lock_meta_cost_scope(tenant_value,account_value,selected_purpose,selected_mode);
  END LOOP;
 END LOOP;
END $$;

-- Align the incumbent two-purpose fact writer with the publication lock order.
-- Historical 0175 bytes remain unchanged; only this new migration replaces it.
CREATE OR REPLACE FUNCTION app.assess_meta_delivery_cost(delivery_value uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 PERFORM app.assess_meta_cost_internal(delivery_value,'CUSTOMER_TARIFF',NULL,false,NULL,'worker');
 PERFORM app.assess_meta_cost_internal(delivery_value,'UPSTREAM_REFERENCE',NULL,false,NULL,'worker');
END $$;

CREATE FUNCTION app.meta_cost_statement_privacy_admission(tenant_value uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF tenant_value IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Invalid tenant context' USING ERRCODE='42501'; END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0))
  OR EXISTS(SELECT 1 FROM privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN
  RAISE EXCEPTION 'Source is fenced by privacy' USING ERRCODE='40001'; END IF;
END $$;

CREATE FUNCTION app.meta_cost_source_projection(source_value meta_cost_statement_versions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('id',source_value.id,'tenantId',source_value.tenant_id,'objectKey',source_value.object_key,
  'sha256',source_value.original_sha256,'byteSize',source_value.original_byte_size,'mimeType',source_value.original_mime,
  'version',source_value.version,'sourceState',source_value.source_state,'writeAttemptId',source_value.write_attempt_id)
$$;

CREATE FUNCTION app.meta_cost_source_access(tenant_value uuid,source_value uuid,reading boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source_row meta_cost_statement_versions%ROWTYPE;
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 SELECT * INTO source_row FROM meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=source_value;
 IF NOT FOUND OR source_row.basis_kind<>'UPSTREAM_SOURCE' OR source_row.source_state IN('PURGED','PURGE_PENDING','REJECTED')
  OR source_row.lifecycle IN('REJECTED','EXPIRED') OR(source_row.lifecycle<>'PUBLISHED' AND source_row.expires_at<=clock_timestamp()) THEN
  RAISE EXCEPTION 'Source unavailable' USING ERRCODE='P0002'; END IF;
 IF (reading AND source_row.source_state<>'READY') OR(source_row.source_state='READY' AND source_row.source_delete_after<=clock_timestamp()) THEN
  RAISE EXCEPTION 'Source original is not available' USING ERRCODE='55000'; END IF;
 RETURN app.meta_cost_source_projection(source_row);
END $$;

CREATE FUNCTION app.admit_meta_cost_source_write(tenant_value uuid,source_value uuid,version_value bigint,attempt_value uuid,scan_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source_row meta_cost_statement_versions%ROWTYPE;
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 SELECT * INTO source_row FROM meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=source_value FOR UPDATE;
 IF NOT FOUND OR source_row.basis_kind<>'UPSTREAM_SOURCE' OR source_row.version<>version_value OR attempt_value IS NULL OR COALESCE(scan_value,'')!~'^[0-9a-f]{64}$'
  OR source_row.lifecycle<>'SOURCE_PENDING' OR source_row.source_state<>'RESERVED' OR source_row.write_attempt_id IS NOT NULL
  OR source_row.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Source reservation changed' USING ERRCODE='40001'; END IF;
 UPDATE meta_cost_statement_versions SET source_state='UPLOADING',write_attempt_id=attempt_value,write_admitted_at=clock_timestamp(),
  write_disposition='ADMITTED',scan_sha256=scan_value,version=version+1 WHERE tenant_id=tenant_value AND id=source_value RETURNING * INTO source_row;
 RETURN app.meta_cost_source_projection(source_row);
END $$;

CREATE FUNCTION app.settle_meta_cost_source_write(tenant_value uuid,source_value uuid,attempt_value uuid,outcome_value text,scan_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source_row meta_cost_statement_versions%ROWTYPE; ready_value boolean; at_value timestamptz:=clock_timestamp();
BEGIN
 IF tenant_value IS DISTINCT FROM app.current_tenant_id() OR outcome_value NOT IN('WRITTEN','NOT_WRITTEN','UNKNOWN')
  OR COALESCE(scan_value,'')!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid source settlement' USING ERRCODE='22023'; END IF;
 -- This records an already admitted external outcome even if privacy started.
 -- The statement's write-fence trigger serializes with privacy, but terminal
 -- evidence cannot restore readiness after reservation expiry/deletion intent.
 SELECT * INTO source_row FROM meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=source_value FOR UPDATE;
 IF NOT FOUND OR source_row.write_attempt_id IS DISTINCT FROM attempt_value OR attempt_value IS NULL OR source_row.scan_sha256 IS DISTINCT FROM scan_value THEN
  RAISE EXCEPTION 'Source attempt not found' USING ERRCODE='P0002'; END IF;
 IF source_row.write_disposition IN('WRITTEN','NOT_WRITTEN') THEN
  IF source_row.write_disposition<>outcome_value OR source_row.scan_sha256 IS DISTINCT FROM scan_value THEN
   RAISE EXCEPTION 'Source outcome conflict' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('state',source_row.source_state);
 END IF;
 ready_value:=outcome_value='WRITTEN' AND source_row.lifecycle='SOURCE_PENDING' AND source_row.expires_at>at_value
  AND source_row.source_state IN('UPLOADING','UNKNOWN') AND NOT EXISTS(SELECT 1 FROM privacy_jobs
    WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE'));
 UPDATE meta_cost_statement_versions SET write_disposition=outcome_value,write_settled_at=CASE WHEN outcome_value<>'UNKNOWN' THEN at_value END,
  scan_sha256=scan_value,source_state=CASE WHEN ready_value THEN 'READY' WHEN outcome_value='UNKNOWN' THEN 'UNKNOWN' ELSE 'PURGE_PENDING' END,
  lifecycle=CASE WHEN ready_value THEN 'SOURCE_READY' ELSE lifecycle END,
  source_ready_at=CASE WHEN ready_value THEN at_value ELSE source_ready_at END,
  source_delete_after=CASE WHEN ready_value THEN at_value+make_interval(days=>(retention_snapshot->>'sourceDays')::integer) ELSE source_delete_after END,
  version=version+1 WHERE tenant_id=tenant_value AND id=source_value RETURNING * INTO source_row;
 RETURN jsonb_build_object('state',source_row.source_state);
END $$;

CREATE FUNCTION app.reject_meta_cost_source_before_write(tenant_value uuid,source_value uuid,version_value bigint,reason_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE changed integer;
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 IF reason_value NOT IN('SCAN_REJECTED','SOURCE_INVALID') THEN RAISE EXCEPTION 'Invalid source rejection' USING ERRCODE='22023'; END IF;
 UPDATE meta_cost_statement_versions SET lifecycle='REJECTED',source_state='REJECTED',version=version+1
 WHERE tenant_id=tenant_value AND id=source_value AND version=version_value AND source_state='RESERVED' AND write_attempt_id IS NULL;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'Source changed' USING ERRCODE='40001'; END IF;
 RETURN jsonb_build_object('state','REJECTED');
END $$;

REVOKE ALL ON meta_cost_statement_versions FROM PUBLIC,wasalx_app,wasalx_connector_worker,wasalx_platform_operations_client;
REVOKE ALL ON FUNCTION app.preserve_meta_finance_policy(),app.preserve_meta_cost_statement(),
 app.meta_cost_statement_lock(uuid,uuid,text,text),app.meta_cost_statement_privacy_admission(uuid),
 app.meta_cost_source_projection(meta_cost_statement_versions),app.meta_cost_source_access(uuid,uuid,boolean),
 app.admit_meta_cost_source_write(uuid,uuid,bigint,uuid,text),app.settle_meta_cost_source_write(uuid,uuid,uuid,text,text),
 app.reject_meta_cost_source_before_write(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_cost_source_access(uuid,uuid,boolean),app.admit_meta_cost_source_write(uuid,uuid,bigint,uuid,text),
 app.settle_meta_cost_source_write(uuid,uuid,uuid,text,text),app.reject_meta_cost_source_before_write(uuid,uuid,bigint,text) TO wasalx_connector_worker;


-- Appended inside the single P10c migration. Internal functions are not public
-- command surfaces; the finite platform operator dispatcher owns authorization,
-- idempotency and audit in the same transaction.
CREATE FUNCTION app.validate_meta_statement_input(value jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source_value jsonb;line_value jsonb;line_total numeric;quantity_total numeric;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR octet_length(value::text)>524288
  OR value->>'schemaVersion' IS DISTINCT FROM '1'
  OR COALESCE(value->>'basisKind','') NOT IN('UPSTREAM_SOURCE','CUSTOMER_TARIFF_DERIVATION')
  OR COALESCE(value->>'currency','')!~'^[A-Z]{3}$'
  OR COALESCE(value->>'minorUnits','')!~'^[0-3]$'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['accountId','policyVersionId','commercialTermsVersionId']) key
    WHERE COALESCE(value->>key,'')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=value->>'timezone')
  OR COALESCE(value->>'periodFrom','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR COALESCE(value->>'periodTo','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR (value->>'periodFrom')::timestamptz IS NULL OR(value->>'periodTo')::timestamptz IS NULL
  OR to_char((value->>'periodFrom')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM value->>'periodFrom'
  OR to_char((value->>'periodTo')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM value->>'periodTo'
  OR (value->>'periodFrom')::timestamptz>=(value->>'periodTo')::timestamptz
  OR (value->>'periodTo')::timestamptz-(value->>'periodFrom')::timestamptz>interval '366 days' THEN
  RAISE EXCEPTION 'Invalid statement scope' USING ERRCODE='22023'; END IF;
 IF value->>'basisKind'='CUSTOMER_TARIFF_DERIVATION' THEN
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) k) IS DISTINCT FROM
   ARRAY['accountId','basisKind','commercialTermsVersionId','currency','minorUnits','periodFrom','periodTo','policyVersionId','schemaVersion','tariffVersionId','timezone','upstreamStatementVersionIds']::text[]
   OR COALESCE(value->>'tariffVersionId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
   OR jsonb_typeof(value->'upstreamStatementVersionIds') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid customer statement basis' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(value->'upstreamStatementVersionIds') NOT BETWEEN 1 AND 100
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(value->'upstreamStatementVersionIds') id WHERE id!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
   OR (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(value->'upstreamStatementVersionIds') id)<>jsonb_array_length(value->'upstreamStatementVersionIds') THEN
   RAISE EXCEPTION 'Invalid upstream revision selection' USING ERRCODE='22023'; END IF;
  RETURN;
 END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(value) k) IS DISTINCT FROM
  ARRAY['accountId','basisKind','commercialTermsVersionId','currency','lines','minorUnits','periodFrom','periodTo','policyVersionId','schemaVersion','source','timezone']::text[]
  OR jsonb_typeof(value->'source') IS DISTINCT FROM 'object' OR jsonb_typeof(value->'lines') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Invalid original statement basis' USING ERRCODE='22023'; END IF;
 source_value:=value->'source';
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(source_value) k) IS DISTINCT FROM
  ARRAY['coverage','documentId','documentRevision','excludedOriginalAmount','grossOriginalTotal','issuerAuthorityVersionId','issuerKind','originalByteSize','originalMime','originalSha256','priorStatementVersionId','sourceAccountIdentifier','sourceAccountIdentifierKind','sourceIssuedAt','sourceKind','sourceQuantity','sourceScopeLocator','sourceTotal','supportedSubtotalLocator']::text[]
  OR COALESCE(source_value->>'issuerKind','') NOT IN('META','APPROVED_PARTNER')
  OR ((source_value->>'issuerKind'='APPROVED_PARTNER') IS DISTINCT FROM(source_value->>'issuerAuthorityVersionId' IS NOT NULL))
  OR (source_value->>'issuerAuthorityVersionId' IS NOT NULL AND source_value->>'issuerAuthorityVersionId'!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
  OR source_value->>'sourceAccountIdentifierKind' IS DISTINCT FROM 'MESSAGING_ACCOUNT_ID'
  OR COALESCE(source_value->>'sourceAccountIdentifier','')!~'^[0-9]{5,32}$'
  OR COALESCE(source_value->>'originalSha256','')!~'^[a-f0-9]{64}$'
  OR COALESCE(source_value->>'originalByteSize','')!~'^[1-9][0-9]{0,7}$'
  OR (source_value->>'originalByteSize')::integer>10485760
  OR COALESCE(source_value->>'originalMime','') NOT IN('application/pdf','text/csv','application/json')
  OR COALESCE(source_value->>'coverage','') NOT IN('ACCOUNT_PERIOD','MESSAGE_EFFECTS')
  OR COALESCE(source_value->>'sourceKind','') NOT IN('FULL_REPLACEMENT','CREDIT_DEBIT_ADJUSTMENT')
  OR COALESCE(source_value->>'sourceIssuedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR (source_value->>'sourceIssuedAt')::timestamptz IS NULL
  OR to_char((source_value->>'sourceIssuedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM source_value->>'sourceIssuedAt'
  OR (source_value->>'priorStatementVersionId' IS NOT NULL AND source_value->>'priorStatementVersionId'!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
  OR (source_value->>'sourceKind'='CREDIT_DEBIT_ADJUSTMENT' AND source_value->>'priorStatementVersionId' IS NULL)
  OR jsonb_typeof(source_value->'sourceTotal') IS DISTINCT FROM 'string'
  OR COALESCE(source_value->>'sourceTotal','')!~'^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,12})?$'
  OR (source_value->>'sourceKind'='FULL_REPLACEMENT' AND(source_value->>'sourceTotal')::numeric<0)
  OR (source_value->>'sourceQuantity' IS NOT NULL AND source_value->>'sourceQuantity'!~'^(0|[1-9][0-9]{0,11})$')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['documentId','documentRevision','sourceScopeLocator']) key
    WHERE COALESCE(length(source_value->>key),0) NOT BETWEEN 1 AND 256 OR source_value->>key~'[[:cntrl:]]') THEN
  RAISE EXCEPTION 'Invalid source description' USING ERRCODE='22023'; END IF;
 IF num_nonnulls(source_value->>'grossOriginalTotal',source_value->>'excludedOriginalAmount',source_value->>'supportedSubtotalLocator') NOT IN(0,3) THEN
  RAISE EXCEPTION 'Incomplete messaging subtotal evidence' USING ERRCODE='22023'; END IF;
 IF source_value->>'grossOriginalTotal' IS NOT NULL AND(
  jsonb_typeof(source_value->'grossOriginalTotal') IS DISTINCT FROM 'string' OR jsonb_typeof(source_value->'excludedOriginalAmount') IS DISTINCT FROM 'string'
  OR source_value->>'grossOriginalTotal'!~'^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,12})?$'
  OR source_value->>'excludedOriginalAmount'!~'^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,12})?$'
  OR (source_value->>'grossOriginalTotal')::numeric-(source_value->>'excludedOriginalAmount')::numeric<>(source_value->>'sourceTotal')::numeric
  OR length(source_value->>'supportedSubtotalLocator') NOT BETWEEN 1 AND 256 OR source_value->>'supportedSubtotalLocator'~'[[:cntrl:]]') THEN
  RAISE EXCEPTION 'Messaging subtotal is not independently complete' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(value->'lines')>1000 OR(source_value->>'coverage'='MESSAGE_EFFECTS' AND jsonb_array_length(value->'lines')=0) THEN
  RAISE EXCEPTION 'Statement line limit exceeded' USING ERRCODE='22023'; END IF;
 FOR line_value IN SELECT e FROM jsonb_array_elements(value->'lines') e LOOP
  IF jsonb_typeof(line_value) IS DISTINCT FROM 'object' OR(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(line_value) k) IS DISTINCT FROM
   ARRAY['amount','kind','priorSourceLineId','providerMessageId','quantity','sourceLineId','sourceLocator']::text[]
   OR COALESCE(line_value->>'kind','') NOT IN('CHARGE','CREDIT','DEBIT')
   OR jsonb_typeof(line_value->'amount') IS DISTINCT FROM 'string'
   OR COALESCE(line_value->>'amount','')!~'^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,12})?$'
   OR ((line_value->>'kind'='CREDIT') IS DISTINCT FROM(left(line_value->>'amount',1)='-'))
   OR COALESCE(length(line_value->>'sourceLineId'),0) NOT BETWEEN 1 AND 128 OR line_value->>'sourceLineId'~'[[:cntrl:]]'
   OR COALESCE(length(line_value->>'sourceLocator'),0) NOT BETWEEN 1 AND 256 OR line_value->>'sourceLocator'~'[[:cntrl:]]'
   OR(line_value->>'providerMessageId' IS NOT NULL AND(length(line_value->>'providerMessageId') NOT BETWEEN 1 AND 512 OR line_value->>'providerMessageId'~'[[:cntrl:]]'))
   OR(line_value->>'quantity' IS NOT NULL AND line_value->>'quantity'!~'^(0|[1-9][0-9]{0,11})$')
   OR(line_value->>'priorSourceLineId' IS NOT NULL AND(length(line_value->>'priorSourceLineId') NOT BETWEEN 1 AND 128 OR line_value->>'priorSourceLineId'~'[[:cntrl:]]')) THEN
   RAISE EXCEPTION 'Invalid statement line' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT e->>'sourceLineId') FROM jsonb_array_elements(value->'lines') e)<>jsonb_array_length(value->'lines') THEN
  RAISE EXCEPTION 'Duplicate statement line' USING ERRCODE='22023'; END IF;
 IF source_value->>'coverage'='MESSAGE_EFFECTS' THEN
  SELECT sum((e->>'amount')::numeric),sum((e->>'quantity')::numeric) INTO line_total,quantity_total FROM jsonb_array_elements(value->'lines') e;
  IF line_total IS DISTINCT FROM(source_value->>'sourceTotal')::numeric
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'lines') e WHERE e->>'providerMessageId' IS NULL)
   OR(source_value->>'sourceQuantity' IS NOT NULL AND(quantity_total IS DISTINCT FROM(source_value->>'sourceQuantity')::numeric
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(value->'lines') e WHERE e->>'quantity' IS NULL))) THEN
   RAISE EXCEPTION 'Message source lines are incomplete' USING ERRCODE='22023'; END IF;
 END IF;
END $$;

CREATE FUNCTION app.reserve_meta_cost_statement(tenant_value uuid,input_value jsonb,actor_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE account_value public.meta_messaging_accounts;policy_value public.meta_billing_policy_versions;
 accepted record;retention_value public.retention_policies;source_row public.meta_cost_statement_versions;
 id_value uuid:=gen_random_uuid();mode_value text;purpose_value text;identity_sha text;input_sha text;
 normalized jsonb;line_value jsonb;lines_value jsonb:='[]'::jsonb;effect jsonb;delivery_value uuid;matches integer;
 original_sha text;source_key text;source_value jsonb;upstream_value uuid;tariff_value public.meta_cost_tariff_versions;
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);PERFORM app.validate_meta_statement_input(input_value);
 SELECT * INTO account_value FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value AND id=(input_value->>'accountId')::uuid;
 SELECT * INTO policy_value FROM public.meta_billing_policy_versions WHERE tenant_id=tenant_value AND id=(input_value->>'policyVersionId')::uuid AND account_id=account_value.id;
 IF account_value.id IS NULL OR policy_value.id IS NULL THEN RAISE EXCEPTION 'Historical statement account is unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO accepted FROM app.meta_accepted_terms_projection(tenant_value,policy_value.id,(input_value->>'commercialTermsVersionId')::uuid);
 IF NOT FOUND OR accepted.account_id IS DISTINCT FROM account_value.id OR accepted.evidence_mode NOT IN('LIVE','SIMULATED') THEN
  RAISE EXCEPTION 'Historical documentary authority is unavailable' USING ERRCODE='55000'; END IF;
 mode_value:=accepted.evidence_mode;purpose_value:=CASE WHEN input_value->>'basisKind'='UPSTREAM_SOURCE' THEN 'UPSTREAM_CHARGE' ELSE 'CUSTOMER_CHARGE' END;
 PERFORM app.meta_cost_statement_lock(tenant_value,account_value.id,purpose_value,mode_value);
 SELECT * INTO retention_value FROM public.retention_policies WHERE tenant_id=tenant_value FOR SHARE;
 IF retention_value.finance_policy IS NULL OR retention_value.finance_policy->>'evidenceMode' IS DISTINCT FROM mode_value THEN
  RAISE EXCEPTION 'Approved finance retention is unavailable' USING ERRCODE='55000'; END IF;
 input_sha:=encode(digest(input_value::text,'sha256'),'hex');normalized:=input_value;
 IF purpose_value='UPSTREAM_CHARGE' THEN
  source_value:=input_value->'source';original_sha:=source_value->>'originalSha256';
  IF source_value->>'sourceAccountIdentifier' IS DISTINCT FROM account_value.provider_account_id
   OR(source_value->>'issuerKind'='APPROVED_PARTNER' AND(accepted.payer_authority_version_id IS NULL
      OR source_value->>'issuerAuthorityVersionId' IS DISTINCT FROM accepted.payer_authority_version_id::text)) THEN
   RAISE EXCEPTION 'Exact source issuer or account authority is unavailable' USING ERRCODE='55000'; END IF;
  identity_sha:=encode(digest(jsonb_build_array(source_value->>'issuerKind',source_value->>'issuerAuthorityVersionId',source_value->>'documentId',
   source_value->>'documentRevision',source_value->>'sourceScopeLocator',account_value.id,mode_value,input_value->>'currency',
   (input_value->>'periodFrom')::timestamptz,(input_value->>'periodTo')::timestamptz)::text,'sha256'),'hex');
  SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND source_identity_sha256=identity_sha;
  IF FOUND THEN
   IF source_row.input_sha256 IS DISTINCT FROM input_sha THEN RAISE EXCEPTION 'Source identity has conflicting bytes or description' USING ERRCODE='23505'; END IF;
   RETURN jsonb_build_object('id',source_row.id,'version',source_row.version,'state',source_row.lifecycle,'inputSha256',source_row.input_sha256,'duplicateSource',true);
  END IF;
  IF source_value->>'priorStatementVersionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.meta_cost_statement_versions prior
   WHERE prior.tenant_id=tenant_value AND prior.id=(source_value->>'priorStatementVersionId')::uuid AND prior.account_id=account_value.id
    AND prior.purpose=purpose_value AND prior.evidence_mode=mode_value AND prior.currency=input_value->>'currency'
    AND prior.minor_units=(input_value->>'minorUnits')::smallint AND prior.period_from=(input_value->>'periodFrom')::timestamptz
    AND prior.period_to=(input_value->>'periodTo')::timestamptz AND prior.lifecycle='PUBLISHED') THEN
   RAISE EXCEPTION 'Prior published source scope is unavailable' USING ERRCODE='55000'; END IF;
  FOR line_value IN SELECT e FROM jsonb_array_elements(input_value->'lines') e LOOP
   effect:=NULL;delivery_value:=NULL;
   IF line_value->>'providerMessageId' IS NOT NULL THEN
    SELECT count(*),(array_agg(id ORDER BY id))[1] INTO matches,delivery_value FROM public.delivery_outbox
     WHERE tenant_id=tenant_value AND external_message_id=line_value->>'providerMessageId';
    IF matches=1 THEN
     effect:=app.resolve_meta_message_effect(tenant_value,delivery_value,line_value->>'providerMessageId');
     IF effect->>'state' IS DISTINCT FROM 'ATTRIBUTED' OR effect#>>'{admission,snapshot,accountId}' IS DISTINCT FROM account_value.id::text
      OR effect#>>'{admission,execution,mode}' IS DISTINCT FROM mode_value THEN effect:=NULL;delivery_value:=NULL; END IF;
    ELSE delivery_value:=NULL; END IF;
   END IF;
   -- Keep only exact local references and receipt digests. Unmatched identifiers
   -- remain unknown, never guesses from current connection/account/policy.
   lines_value:=lines_value||jsonb_build_array((line_value-'providerMessageId')||jsonb_build_object(
    'providerMessageSha256',CASE WHEN line_value->>'providerMessageId' IS NULL THEN NULL ELSE encode(digest(line_value->>'providerMessageId','sha256'),'hex') END,
    'deliveryId',delivery_value,'attemptId',effect#>>'{effect,attemptId}','admissionSha256',effect#>>'{effect,admissionDigest,sha256}',
    'attribution',CASE WHEN effect IS NULL THEN 'UNKNOWN_ATTRIBUTION' ELSE 'ATTRIBUTED' END));
  END LOOP;
  normalized:=jsonb_set(input_value,'{lines}',lines_value);source_key:='tenants/'||tenant_value::text||'/meta-cost-sources/'||id_value::text||'/'||original_sha||'.bin';
 ELSE
  SELECT * INTO tariff_value FROM public.meta_cost_tariff_versions WHERE tenant_id=tenant_value AND id=(input_value->>'tariffVersionId')::uuid;
  IF policy_value.mode<>'MANAGED' OR accepted.payer_authority_version_id IS NULL OR accepted.allocation_line_version_id IS NULL
   OR tariff_value.id IS NULL OR tariff_value.account_id IS DISTINCT FROM account_value.id OR tariff_value.purpose<>'CUSTOMER_TARIFF'
   OR tariff_value.evidence_mode IS DISTINCT FROM mode_value OR tariff_value.state<>'ACTIVE' OR accepted.accepted_tariff_version_id IS DISTINCT FROM tariff_value.id
   OR tariff_value.commercial_terms_version_id IS DISTINCT FROM accepted.commercial_terms_version_id
   OR tariff_value.definition->>'currency' IS DISTINCT FROM input_value->>'currency'
   OR tariff_value.definition->>'minorUnits' IS DISTINCT FROM input_value->>'minorUnits'
   OR tariff_value.effective_from>(input_value->>'periodFrom')::timestamptz OR tariff_value.effective_to<(input_value->>'periodTo')::timestamptz THEN
   RAISE EXCEPTION 'Accepted managed customer tariff is unavailable' USING ERRCODE='55000'; END IF;
  FOR upstream_value IN SELECT id::uuid FROM jsonb_array_elements_text(input_value->'upstreamStatementVersionIds') id LOOP
   IF NOT EXISTS(SELECT 1 FROM public.meta_cost_statement_versions upstream WHERE upstream.tenant_id=tenant_value AND upstream.id=upstream_value
    AND upstream.account_id=account_value.id AND upstream.purpose='UPSTREAM_CHARGE' AND upstream.evidence_mode=mode_value AND upstream.lifecycle='PUBLISHED'
    AND upstream.period_from=(input_value->>'periodFrom')::timestamptz AND upstream.period_to=(input_value->>'periodTo')::timestamptz) THEN
    RAISE EXCEPTION 'Published upstream source scope is unavailable' USING ERRCODE='55000'; END IF;
  END LOOP;
 END IF;
 INSERT INTO public.meta_cost_statement_versions(id,tenant_id,account_id,policy_version_id,commercial_terms_version_id,basis_kind,purpose,evidence_mode,
  currency,minor_units,period_from,period_to,timezone,normalized_input,input_sha256,source_identity_sha256,lifecycle,created_by,
  object_key,original_sha256,original_byte_size,original_mime,source_state,retention_snapshot)
 VALUES(id_value,tenant_value,account_value.id,policy_value.id,accepted.commercial_terms_version_id,input_value->>'basisKind',purpose_value,mode_value,
  input_value->>'currency',(input_value->>'minorUnits')::smallint,(input_value->>'periodFrom')::timestamptz,(input_value->>'periodTo')::timestamptz,input_value->>'timezone',
  normalized,input_sha,identity_sha,CASE WHEN purpose_value='UPSTREAM_CHARGE' THEN 'SOURCE_PENDING' ELSE 'SOURCE_READY' END,actor_value,
  source_key,original_sha,(source_value->>'originalByteSize')::integer,source_value->>'originalMime',CASE WHEN purpose_value='UPSTREAM_CHARGE' THEN 'RESERVED' ELSE 'NONE' END,
  retention_value.finance_policy||jsonb_build_object('retentionVersion',retention_value.version));
 RETURN jsonb_build_object('id',id_value,'version',1,'state',CASE WHEN purpose_value='UPSTREAM_CHARGE' THEN 'SOURCE_PENDING' ELSE 'SOURCE_READY' END,
  'inputSha256',input_sha,'duplicateSource',false);
END $$;

REVOKE ALL ON FUNCTION app.validate_meta_statement_input(jsonb),app.reserve_meta_cost_statement(uuid,jsonb,text) FROM PUBLIC;

-- One scope head and one bounded immutable publication. Cost locks are the same
-- locks used by assessment correction writers, not a timestamp watermark.
CREATE FUNCTION app.meta_cost_statement_head(source_value public.meta_cost_statement_versions) RETURNS uuid
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT s.id FROM public.meta_cost_statement_versions s WHERE s.tenant_id=source_value.tenant_id AND s.account_id=source_value.account_id
  AND s.purpose=source_value.purpose AND s.evidence_mode=source_value.evidence_mode AND s.currency=source_value.currency
  AND s.period_from=source_value.period_from AND s.period_to=source_value.period_to AND s.lifecycle='PUBLISHED'
  AND NOT EXISTS(SELECT 1 FROM public.meta_cost_statement_versions next WHERE next.tenant_id=s.tenant_id AND next.predecessor_id=s.id AND next.lifecycle='PUBLISHED')
$$;

CREATE FUNCTION app.review_meta_cost_statement(tenant_value uuid,id_value uuid,body_value jsonb,actor_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE source_row public.meta_cost_statement_versions;head_id uuid;head_row public.meta_cost_statement_versions;
 adjustments jsonb;verification_value jsonb;subject_value jsonb;item jsonb;reviewed_at timestamptz:=clock_timestamp();
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found' USING ERRCODE='P0002'; END IF;
 PERFORM app.meta_cost_statement_lock(tenant_value,source_row.account_id,source_row.purpose,source_row.evidence_mode);
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value FOR UPDATE;
 IF jsonb_typeof(body_value) IS DISTINCT FROM 'object' OR octet_length(body_value::text)>524288
  OR(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM
   ARRAY['expectedCurrentHeadId','expectedInputSha256','expectedVersion','originalSha256','priorAdjustments','reviewSha256','subjectCoverage','subjectRefs']::text[]
  OR source_row.version IS DISTINCT FROM(body_value->>'expectedVersion')::bigint OR source_row.input_sha256 IS DISTINCT FROM body_value->>'expectedInputSha256'
  OR source_row.lifecycle NOT IN('SOURCE_READY','REVIEWED') OR source_row.expires_at<=reviewed_at
  OR COALESCE(body_value->>'reviewSha256','')!~'^[a-f0-9]{64}$'
  OR COALESCE(body_value->>'subjectCoverage','') NOT IN('UNKNOWN','VERIFIED_NO_SUBJECT_DATA','VERIFIED_COMPLETE_SUBJECT_MAPPING')
  OR jsonb_typeof(body_value->'subjectRefs') IS DISTINCT FROM 'array' OR jsonb_typeof(body_value->'priorAdjustments') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'Statement review changed or is invalid' USING ERRCODE='40001'; END IF;
 IF source_row.basis_kind='UPSTREAM_SOURCE' AND(source_row.source_state<>'READY' OR source_row.write_disposition<>'WRITTEN'
   OR source_row.source_delete_after<=reviewed_at OR source_row.original_sha256 IS DISTINCT FROM body_value->>'originalSha256') THEN
  RAISE EXCEPTION 'Verified original is unavailable' USING ERRCODE='55000'; END IF;
 IF source_row.basis_kind='CUSTOMER_TARIFF_DERIVATION' AND(body_value->>'originalSha256' IS NOT NULL OR body_value->>'subjectCoverage'<>'VERIFIED_NO_SUBJECT_DATA') THEN
  RAISE EXCEPTION 'Derived statement owns no original' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(body_value->'subjectRefs')>1000 OR jsonb_array_length(body_value->'priorAdjustments')>1000
  OR(body_value->>'subjectCoverage'<>'VERIFIED_COMPLETE_SUBJECT_MAPPING' AND jsonb_array_length(body_value->'subjectRefs')<>0)
  OR(body_value->>'subjectCoverage'='VERIFIED_COMPLETE_SUBJECT_MAPPING' AND jsonb_array_length(body_value->'subjectRefs')=0) THEN
  RAISE EXCEPTION 'Invalid source subject review' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT e FROM jsonb_array_elements(body_value->'subjectRefs') e LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM ARRAY['scopeSha256','scopeType']::text[]
   OR COALESCE(item->>'scopeType','') NOT IN('PARTICIPANT','ZAMMAD_TICKET','REFERENCE','GROUP_BINDING','ZAMMAD_USER')
   OR COALESCE(item->>'scopeSha256','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid subject reference' USING ERRCODE='22023'; END IF;
 END LOOP;
 head_id:=app.meta_cost_statement_head(source_row);
 IF head_id IS DISTINCT FROM(body_value->>'expectedCurrentHeadId')::uuid THEN RAISE EXCEPTION 'Statement head changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO head_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=head_id;
 adjustments:=COALESCE(head_row.publication->'adjustments','[]'::jsonb);
 IF source_row.basis_kind='UPSTREAM_SOURCE' AND source_row.normalized_input#>>'{source,sourceKind}'='FULL_REPLACEMENT' THEN
  -- Every earlier delta receives one explicit include/exclude decision. A
  -- replacement cannot silently erase, duplicate or guess an older credit.
  IF jsonb_array_length(body_value->'priorAdjustments')<>jsonb_array_length(adjustments)
   OR(SELECT count(DISTINCT e->>'statementVersionId') FROM jsonb_array_elements(body_value->'priorAdjustments') e)<>jsonb_array_length(adjustments) THEN
   RAISE EXCEPTION 'Prior adjustments require complete review' USING ERRCODE='55000'; END IF;
  FOR item IN SELECT e FROM jsonb_array_elements(body_value->'priorAdjustments') e LOOP
   IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(item) k) IS DISTINCT FROM ARRAY['statementVersionId','treatment']::text[]
    OR COALESCE(item->>'treatment','') NOT IN('INCLUDED_IN_REPLACEMENT','EXCLUDED_FROM_REPLACEMENT')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(adjustments) old WHERE old->>'statementVersionId'=item->>'statementVersionId') THEN
    RAISE EXCEPTION 'Prior adjustment treatment is unavailable' USING ERRCODE='55000'; END IF;
  END LOOP;
 ELSIF jsonb_array_length(body_value->'priorAdjustments')<>0 THEN RAISE EXCEPTION 'Unexpected replacement adjustment treatment' USING ERRCODE='22023'; END IF;
 subject_value:=jsonb_build_object('schemaVersion',1,'reviewSha256',body_value->>'reviewSha256','sourceSha256',source_row.original_sha256,
  'inputSha256',source_row.input_sha256,'coverage',body_value->>'subjectCoverage','refs',body_value->'subjectRefs','reviewedBy',actor_value,'reviewedAt',reviewed_at);
 verification_value:=jsonb_build_object('schemaVersion',1,'claim',CASE WHEN source_row.basis_kind='UPSTREAM_SOURCE' THEN 'OPERATOR_VERIFIED_ORIGINAL' ELSE 'HISTORICAL_TARIFF_DERIVATION_REVIEWED' END,
  'originalSha256',source_row.original_sha256,'inputSha256',source_row.input_sha256,'reviewSha256',body_value->>'reviewSha256',
  'expectedCurrentHeadId',head_id,'priorAdjustments',body_value->'priorAdjustments','reviewedBy',actor_value,'reviewedAt',reviewed_at);
 UPDATE public.meta_cost_statement_versions SET verification=verification_value,subject_attestation=subject_value,
  source_subject_coverage=body_value->>'subjectCoverage',lifecycle='REVIEWED',preview=NULL,version=version+1
 WHERE tenant_id=tenant_value AND id=id_value RETURNING * INTO source_row;
 RETURN jsonb_build_object('id',id_value,'version',source_row.version,'state','REVIEWED','verificationSha256',encode(digest(verification_value::text,'sha256'),'hex'));
END $$;

CREATE FUNCTION app.meta_cost_statement_basis(source_value public.meta_cost_statement_versions) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE usage_value jsonb;rows_value jsonb;totals_value jsonb;head_id uuid;head_row public.meta_cost_statement_versions;
 accepted record;total_value numeric;estimate_value numeric;unresolved integer;adjustments jsonb:='[]'::jsonb;item jsonb;old_item jsonb;
 upstream jsonb:='[]'::jsonb;upstream_row public.meta_cost_statement_versions;upstream_head uuid;upstream_id uuid;
 tariff public.meta_cost_tariff_versions;quantity_value bigint;coverage_value text;selected_tariff uuid;unknown_mode_count integer;
BEGIN
 usage_value:=app.meta_cost_usage_snapshot(source_value.tenant_id,source_value.account_id,source_value.period_from,source_value.period_to);
 IF usage_value->>'complete' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Statement assessment set is too large' USING ERRCODE='54000'; END IF;
 head_id:=app.meta_cost_statement_head(source_value);
 IF head_id IS DISTINCT FROM(source_value.verification->>'expectedCurrentHeadId')::uuid THEN RAISE EXCEPTION 'Statement head changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO head_row FROM public.meta_cost_statement_versions WHERE tenant_id=source_value.tenant_id AND id=head_id;
 SELECT * INTO accepted FROM app.meta_accepted_terms_projection(source_value.tenant_id,source_value.policy_version_id,source_value.commercial_terms_version_id);
 IF NOT FOUND OR accepted.account_id IS DISTINCT FROM source_value.account_id OR accepted.evidence_mode IS DISTINCT FROM source_value.evidence_mode THEN
  RAISE EXCEPTION 'Historical statement authority is unavailable' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.meta_cost_statement_versions s WHERE s.tenant_id=source_value.tenant_id AND s.account_id=source_value.account_id
  AND s.purpose=source_value.purpose AND s.evidence_mode=source_value.evidence_mode AND s.currency=source_value.currency AND s.lifecycle='PUBLISHED'
  AND s.period_from<source_value.period_to AND s.period_to>source_value.period_from
  AND(s.period_from,s.period_to) IS DISTINCT FROM(source_value.period_from,source_value.period_to)) THEN
  RAISE EXCEPTION 'Published statement periods overlap' USING ERRCODE='40001'; END IF;
 IF head_row.id IS NOT NULL AND(head_row.minor_units,head_row.timezone) IS DISTINCT FROM(source_value.minor_units,source_value.timezone) THEN
  RAISE EXCEPTION 'Statement currency or period convention changed' USING ERRCODE='40001'; END IF;
 SELECT COALESCE(jsonb_agg(e ORDER BY e->>'deliveryId'),'[]'::jsonb) INTO rows_value FROM jsonb_array_elements(usage_value->'rows') e
  WHERE e->>'purpose'=CASE WHEN source_value.purpose='UPSTREAM_CHARGE' THEN 'UPSTREAM_REFERENCE' ELSE 'CUSTOMER_TARIFF' END
   AND e->>'evidenceMode'=source_value.evidence_mode;
 SELECT count(*) INTO unknown_mode_count FROM jsonb_array_elements(usage_value->'rows') e
  WHERE e->>'purpose'=CASE WHEN source_value.purpose='UPSTREAM_CHARGE' THEN 'UPSTREAM_REFERENCE' ELSE 'CUSTOMER_TARIFF' END AND e->>'evidenceMode'='UNKNOWN';
 SELECT count(*) INTO unresolved FROM jsonb_array_elements(rows_value) e WHERE e->>'state'<>'ESTIMATED'
  OR e->>'currency' IS DISTINCT FROM source_value.currency OR e->>'evidenceRedacted' IS DISTINCT FROM 'false';
 SELECT COALESCE(jsonb_agg(e ORDER BY e->>'tariffVersionId'),'[]'::jsonb) INTO totals_value FROM jsonb_array_elements(usage_value->'totals') e
  WHERE e->>'purpose'=CASE WHEN source_value.purpose='UPSTREAM_CHARGE' THEN 'UPSTREAM_REFERENCE' ELSE 'CUSTOMER_TARIFF' END
   AND e->>'evidenceMode'=source_value.evidence_mode AND e->>'currency'=source_value.currency;
 SELECT CASE WHEN count(*) FILTER(WHERE e->>'amount' IS NULL)=0 THEN sum((e->>'amount')::numeric) END INTO estimate_value FROM jsonb_array_elements(totals_value) e;
 IF source_value.purpose='UPSTREAM_CHARGE' THEN
  IF source_value.source_state<>'READY' OR source_value.write_disposition<>'WRITTEN' OR source_value.source_delete_after<=clock_timestamp()
   OR source_value.original_sha256 IS DISTINCT FROM source_value.verification->>'originalSha256' THEN
   RAISE EXCEPTION 'Reviewed original is unavailable' USING ERRCODE='55000'; END IF;
  total_value:=(source_value.normalized_input#>>'{source,sourceTotal}')::numeric;
  IF source_value.normalized_input#>>'{source,sourceKind}'='CREDIT_DEBIT_ADJUSTMENT' THEN
   IF head_row.id IS NULL THEN RAISE EXCEPTION 'Adjustment needs a current published basis' USING ERRCODE='55000'; END IF;
   -- Referenced older revision must be in this one current lineage.
   IF NOT EXISTS(WITH RECURSIVE chain AS(SELECT head_row.id AS id,head_row.predecessor_id AS predecessor_id,1 depth UNION ALL
    SELECT prior.id,prior.predecessor_id,chain.depth+1 FROM chain JOIN public.meta_cost_statement_versions prior
     ON prior.tenant_id=source_value.tenant_id AND prior.id=chain.predecessor_id WHERE chain.depth<=1000)
    SELECT 1 FROM chain WHERE id=(source_value.normalized_input#>>'{source,priorStatementVersionId}')::uuid) THEN
    RAISE EXCEPTION 'Adjustment reference is not in the current lineage' USING ERRCODE='55000'; END IF;
   adjustments:=COALESCE(head_row.publication->'adjustments','[]'::jsonb)||jsonb_build_array(jsonb_build_object('statementVersionId',source_value.id,
    'amount',total_value::text,'treatment','EXCLUDED_FROM_REPLACEMENT'));
   total_value:=(head_row.publication->>'amount')::numeric+total_value;
  ELSE
   FOR item IN SELECT e FROM jsonb_array_elements(source_value.verification->'priorAdjustments') e LOOP
    SELECT e INTO old_item FROM jsonb_array_elements(COALESCE(head_row.publication->'adjustments','[]'::jsonb)) e WHERE e->>'statementVersionId'=item->>'statementVersionId';
    IF old_item IS NULL THEN RAISE EXCEPTION 'Replacement adjustment changed' USING ERRCODE='40001'; END IF;
    adjustments:=adjustments||jsonb_build_array(old_item||jsonb_build_object('treatment',item->>'treatment'));
    IF item->>'treatment'='EXCLUDED_FROM_REPLACEMENT' THEN total_value:=total_value+(old_item->>'amount')::numeric; END IF;
   END LOOP;
  END IF;
  IF jsonb_array_length(adjustments)>1000 THEN RAISE EXCEPTION 'Adjustment lineage is too large' USING ERRCODE='54000'; END IF;
  -- A delta's optional quantity describes that document, not the cumulative
  -- current scope. Do not present it as a reconstructed full-period quantity.
  quantity_value:=CASE WHEN source_value.normalized_input#>>'{source,sourceKind}'='CREDIT_DEBIT_ADJUSTMENT' THEN NULL
   ELSE(source_value.normalized_input#>>'{source,sourceQuantity}')::bigint END;
  coverage_value:=CASE WHEN source_value.normalized_input#>>'{source,coverage}'='ACCOUNT_PERIOD' THEN 'ACCOUNT_PERIOD_SOURCE_CONFIRMED'
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(source_value.normalized_input->'lines') e WHERE e->>'attribution'<>'ATTRIBUTED') THEN 'SOURCE_CONFIRMED_ALLOCATION_UNKNOWN'
   ELSE 'MESSAGE_EFFECT_SOURCE_CONFIRMED' END;
 ELSE
  selected_tariff:=(source_value.normalized_input->>'tariffVersionId')::uuid;
  SELECT * INTO tariff FROM public.meta_cost_tariff_versions WHERE tenant_id=source_value.tenant_id AND id=selected_tariff;
  IF accepted.accepted_tariff_version_id IS DISTINCT FROM selected_tariff OR accepted.payer_authority_version_id IS NULL
   OR accepted.allocation_line_version_id IS NULL OR tariff.state IS DISTINCT FROM 'ACTIVE' OR unresolved<>0 OR unknown_mode_count<>0 OR estimate_value IS NULL
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(rows_value) e WHERE e->>'tariffVersionId' IS DISTINCT FROM selected_tariff::text
    OR e->>'paymentMode'<>'MANAGED' OR e->>'payerState'<>'APPROVED_SOLUTION_PARTNER' OR e->>'admissionSha256' IS NULL)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(totals_value) e WHERE e->>'partialPeriod' IS DISTINCT FROM 'false') THEN
   RAISE EXCEPTION 'Complete historical customer tariff quantity is unavailable' USING ERRCODE='55000'; END IF;
  FOR upstream_id IN SELECT e::uuid FROM jsonb_array_elements_text(source_value.normalized_input->'upstreamStatementVersionIds') e LOOP
   SELECT * INTO upstream_row FROM public.meta_cost_statement_versions WHERE tenant_id=source_value.tenant_id AND id=upstream_id;
   IF upstream_row.lifecycle IS DISTINCT FROM 'PUBLISHED' OR upstream_row.account_id IS DISTINCT FROM source_value.account_id
    OR upstream_row.evidence_mode IS DISTINCT FROM source_value.evidence_mode OR upstream_row.purpose IS DISTINCT FROM 'UPSTREAM_CHARGE'
    OR(upstream_row.period_from,upstream_row.period_to) IS DISTINCT FROM(source_value.period_from,source_value.period_to) THEN
    RAISE EXCEPTION 'Upstream publication changed' USING ERRCODE='40001'; END IF;
   upstream_head:=app.meta_cost_statement_head(upstream_row);
   IF NOT((source_value.normalized_input->'upstreamStatementVersionIds') ? upstream_head::text) THEN
    RAISE EXCEPTION 'Current upstream revision must be selected' USING ERRCODE='40001'; END IF;
   upstream:=upstream||jsonb_build_array(jsonb_build_object('statementVersionId',upstream_id,'publicationSha256',upstream_row.publication_sha256,
    'purpose','UPSTREAM_CHARGE','currency',upstream_row.currency,'currentHeadId',upstream_head));
  END LOOP;
  quantity_value:=jsonb_array_length(rows_value);total_value:=estimate_value;coverage_value:='HISTORICAL_MANAGED_TARIFF_CONFIRMED';
 END IF;
 RETURN jsonb_build_object('schemaVersion',1,'id',source_value.id,'accountId',source_value.account_id,'purpose',source_value.purpose,
  'basisKind',source_value.basis_kind,'evidenceMode',source_value.evidence_mode,'currency',source_value.currency,'minorUnits',source_value.minor_units,
  'periodFrom',source_value.period_from,'periodTo',source_value.period_to,'timezone',source_value.timezone,'inputSha256',source_value.input_sha256,
  'verificationSha256',encode(digest(source_value.verification::text,'sha256'),'hex'),'currentHeadId',head_id,
  'selectedCount',usage_value->'selectedCount','selectedSha256',usage_value->>'selectedSha256','selectedRows',rows_value,
  'coverage',coverage_value,'unresolvedAssessments',unresolved,'unknownModeAssessments',unknown_mode_count,'amount',total_value::text,'quantity',quantity_value,
  'estimatedAmount',estimate_value::text,'difference',CASE WHEN estimate_value IS NULL THEN NULL ELSE(total_value-estimate_value)::text END,
  'adjustments',adjustments,'upstreamPublications',upstream,'policyVersionId',source_value.policy_version_id,
  'commercialTermsVersionId',source_value.commercial_terms_version_id,'acceptedTariffVersionId',accepted.accepted_tariff_version_id,
  'payerAuthorityVersionId',accepted.payer_authority_version_id,'allocationLineVersionId',accepted.allocation_line_version_id);
END $$;

CREATE FUNCTION app.preview_meta_cost_statement(tenant_value uuid,id_value uuid,body_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE source_row public.meta_cost_statement_versions;basis_value jsonb;
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found' USING ERRCODE='P0002'; END IF;
 PERFORM app.meta_cost_statement_lock(tenant_value,source_row.account_id,source_row.purpose,source_row.evidence_mode);
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value FOR UPDATE;
 IF source_row.lifecycle<>'REVIEWED' OR source_row.version IS DISTINCT FROM(body_value->>'expectedVersion')::bigint
  OR source_row.expires_at<=clock_timestamp() OR source_row.verification IS NULL
  OR encode(digest(source_row.verification::text,'sha256'),'hex') IS DISTINCT FROM body_value->>'expectedVerificationSha256' THEN
  RAISE EXCEPTION 'Statement review changed' USING ERRCODE='40001'; END IF;
 basis_value:=app.meta_cost_statement_basis(source_row);
 IF octet_length(basis_value::text)>10485760 THEN RAISE EXCEPTION 'Statement snapshot is too large' USING ERRCODE='54000'; END IF;
 UPDATE public.meta_cost_statement_versions SET preview=basis_value,version=version+1 WHERE tenant_id=tenant_value AND id=id_value RETURNING * INTO source_row;
 RETURN jsonb_build_object('id',id_value,'version',source_row.version,'previewSha256',encode(digest(basis_value::text,'sha256'),'hex'),'preview',basis_value);
END $$;

CREATE FUNCTION app.publish_meta_cost_statement(tenant_value uuid,id_value uuid,body_value jsonb,actor_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE source_row public.meta_cost_statement_versions;basis_value jsonb;at_value timestamptz:=clock_timestamp();
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value;
 IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found' USING ERRCODE='P0002'; END IF;
 PERFORM app.meta_cost_statement_lock(tenant_value,source_row.account_id,source_row.purpose,source_row.evidence_mode);
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value FOR UPDATE;
 IF source_row.lifecycle<>'REVIEWED' OR source_row.version IS DISTINCT FROM(body_value->>'expectedVersion')::bigint
  OR source_row.expires_at<=at_value OR source_row.preview IS NULL
  OR source_row.input_sha256 IS DISTINCT FROM body_value->>'expectedInputSha256'
  OR encode(digest(source_row.verification::text,'sha256'),'hex') IS DISTINCT FROM body_value->>'expectedVerificationSha256'
  OR encode(digest(source_row.preview::text,'sha256'),'hex') IS DISTINCT FROM body_value->>'expectedPreviewSha256'
  OR(source_row.preview->>'currentHeadId')::uuid IS DISTINCT FROM(body_value->>'expectedCurrentHeadId')::uuid THEN
  RAISE EXCEPTION 'Statement publication intent changed' USING ERRCODE='40001'; END IF;
 basis_value:=app.meta_cost_statement_basis(source_row);
 IF basis_value IS DISTINCT FROM source_row.preview THEN RAISE EXCEPTION 'Statement evidence changed; preview again' USING ERRCODE='40001'; END IF;
 -- Correction writers cannot pass the same purpose lock until this immutable
 -- snapshot commits. Subsequent corrections do not rewrite published bytes.
 basis_value:=basis_value||jsonb_build_object('publishedAt',at_value,'publishedBy',actor_value,'claim','DOCUMENTARY_RECONCILIATION_NOT_PAYMENT');
 UPDATE public.meta_cost_statement_versions SET publication=basis_value,publication_sha256=encode(digest(basis_value::text,'sha256'),'hex'),
  published_at=at_value,record_delete_after=at_value+make_interval(days=>(retention_snapshot->>'recordDays')::integer),
  predecessor_id=(basis_value->>'currentHeadId')::uuid,lifecycle='PUBLISHED',version=version+1
 WHERE tenant_id=tenant_value AND id=id_value RETURNING * INTO source_row;
 RETURN jsonb_build_object('id',id_value,'version',source_row.version,'state','PUBLISHED','publicationSha256',source_row.publication_sha256);
END $$;

REVOKE ALL ON FUNCTION app.meta_cost_statement_head(public.meta_cost_statement_versions),app.review_meta_cost_statement(uuid,uuid,jsonb,text),
 app.meta_cost_statement_basis(public.meta_cost_statement_versions),app.preview_meta_cost_statement(uuid,uuid,jsonb),app.publish_meta_cost_statement(uuid,uuid,jsonb,text) FROM PUBLIC;

CREATE FUNCTION app.approve_meta_finance_retention(tenant_value uuid,body_value jsonb,actor_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE policy_row public.retention_policies;accepted record;finance_value jsonb;
BEGIN
 PERFORM app.meta_cost_statement_privacy_admission(tenant_value);
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM
  ARRAY['basisSha256','commercialTermsVersionId','expectedVersion','policyVersionId','recordDays','sourceDays']::text[]
  OR COALESCE(body_value->>'basisSha256','')!~'^[a-f0-9]{64}$'
  OR COALESCE(body_value->>'sourceDays','')!~'^[1-9][0-9]{0,3}$' OR COALESCE(body_value->>'recordDays','')!~'^[1-9][0-9]{0,3}$'
  OR(body_value->>'recordDays')::integer NOT BETWEEN(body_value->>'sourceDays')::integer AND 3650 THEN
  RAISE EXCEPTION 'Invalid finance retention approval' USING ERRCODE='22023'; END IF;
 SELECT * INTO accepted FROM app.meta_accepted_terms_projection(tenant_value,(body_value->>'policyVersionId')::uuid,(body_value->>'commercialTermsVersionId')::uuid);
 IF NOT FOUND OR accepted.evidence_mode NOT IN('LIVE','SIMULATED') THEN RAISE EXCEPTION 'Historical retention authority is unavailable' USING ERRCODE='55000'; END IF;
 SELECT * INTO policy_row FROM public.retention_policies WHERE tenant_id=tenant_value FOR UPDATE;
 IF NOT FOUND OR policy_row.version IS DISTINCT FROM(body_value->>'expectedVersion')::bigint THEN RAISE EXCEPTION 'Retention policy changed' USING ERRCODE='40001'; END IF;
 finance_value:=jsonb_build_object('sourceDays',(body_value->>'sourceDays')::integer,'recordDays',(body_value->>'recordDays')::integer,
  'basisSha256',body_value->>'basisSha256','evidenceMode',accepted.evidence_mode,'policyVersionId',accepted.policy_version_id,
  'commercialTermsVersionId',accepted.commercial_terms_version_id,'approvedAt',clock_timestamp(),'approvedBy',actor_value);
 UPDATE public.retention_policies SET finance_policy=finance_value,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=tenant_value RETURNING * INTO policy_row;
 RETURN jsonb_build_object('version',policy_row.version,'financePolicy',finance_value);
END $$;

CREATE FUNCTION app.reconcile_meta_cost_source_write(tenant_value uuid,id_value uuid,body_value jsonb,actor_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE source_row public.meta_cost_statement_versions;result_value jsonb;
BEGIN
 -- Recording an admitted write's positive terminal evidence is allowed while
 -- deletion is pending. It cannot create a new writer or grant READY through a
 -- privacy fence. The ordinary settle function makes that decision separately.
 IF tenant_value IS DISTINCT FROM app.current_tenant_id() OR(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM
  ARRAY['expectedVersion','originalSha256','outcome','scanSha256','terminalDispositionEvidenceSha256','writeAttemptId']::text[]
  OR COALESCE(body_value->>'terminalDispositionEvidenceSha256','')!~'^[a-f0-9]{64}$'
  OR COALESCE(body_value->>'outcome','') NOT IN('WRITTEN','NOT_WRITTEN') THEN RAISE EXCEPTION 'Invalid terminal write evidence' USING ERRCODE='22023'; END IF;
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value FOR UPDATE;
 IF NOT FOUND OR source_row.version IS DISTINCT FROM(body_value->>'expectedVersion')::bigint
  OR source_row.original_sha256 IS DISTINCT FROM body_value->>'originalSha256'
  OR source_row.write_attempt_id IS DISTINCT FROM(body_value->>'writeAttemptId')::uuid
  OR source_row.write_disposition NOT IN('ADMITTED','UNKNOWN') THEN RAISE EXCEPTION 'Source write changed' USING ERRCODE='40001'; END IF;
 result_value:=app.settle_meta_cost_source_write(tenant_value,id_value,source_row.write_attempt_id,body_value->>'outcome',body_value->>'scanSha256');
 INSERT INTO public.platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(actor_value,'meta.cost.source.terminal_disposition_reviewed','meta_cost_statement',id_value::text,
  jsonb_build_object('tenantId',tenant_value,'writeAttemptId',source_row.write_attempt_id,'sourceSha256',source_row.original_sha256,
   'claim','OPERATOR_VERIFIED_TERMINAL_WRITE','evidenceMode',source_row.evidence_mode,'outcome',body_value->>'outcome',
   'terminalDispositionEvidenceSha256',body_value->>'terminalDispositionEvidenceSha256'),'meta-cost-write-review');
 RETURN result_value;
END $$;

ALTER TABLE platform_metering_operator_requests DROP CONSTRAINT platform_metering_operator_requests_action_check;
ALTER TABLE platform_metering_operator_requests ADD CONSTRAINT platform_metering_operator_requests_action_check
 CHECK(action IN('SET_QUOTA','CREATE_RATE','META_COST_DRAFT','META_COST_ACTIVATE','META_COST_REASSESS',
 'META_STATEMENT_RESERVE','META_STATEMENT_REVIEW','META_STATEMENT_PREVIEW','META_STATEMENT_PUBLISH','META_FINANCE_RETENTION','META_SOURCE_RECONCILE','META_SOURCE_PRIVACY_REVIEW'));

CREATE FUNCTION app.operator_meta_statement(action_value text,tenant_value uuid,object_value uuid,body_value jsonb,
 key_value text,actor_value text,audit_request_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE request_key text;request_hash text;request_row public.platform_metering_operator_requests;request_id uuid;
 response_value jsonb;previous_tenant text;
BEGIN
 IF COALESCE(action_value,'') NOT IN('META_STATEMENT_RESERVE','META_STATEMENT_REVIEW','META_STATEMENT_PREVIEW','META_STATEMENT_PUBLISH',
   'META_FINANCE_RETENTION','META_SOURCE_RECONCILE','META_SOURCE_PRIVACY_REVIEW')
  OR tenant_value IS NULL OR jsonb_typeof(body_value) IS DISTINCT FROM 'object' OR octet_length(body_value::text)>524288
  OR COALESCE(length(key_value),0) NOT BETWEEN 1 AND 255 OR key_value~'[[:cntrl:]]'
  OR COALESCE(length(actor_value),0) NOT BETWEEN 1 AND 255 OR actor_value~'[[:cntrl:]]'
  OR COALESCE(length(audit_request_value),0) NOT BETWEEN 1 AND 255 OR audit_request_value~'[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Invalid statement action' USING ERRCODE='22023'; END IF;
 request_key:='meta-statement:'||encode(digest(jsonb_build_array(actor_value,tenant_value,key_value)::text,'sha256'),'hex');
 request_hash:=encode(digest(jsonb_build_array(action_value,tenant_value,object_value,body_value)::text,'sha256'),'hex');
 INSERT INTO public.platform_metering_operator_requests(idempotency_key,request_sha256,action,tenant_id,operator_subject)
 VALUES(request_key,request_hash,action_value,tenant_value,actor_value) ON CONFLICT(idempotency_key) DO NOTHING RETURNING id INTO request_id;
 IF request_id IS NULL THEN
  SELECT * INTO request_row FROM public.platform_metering_operator_requests WHERE idempotency_key=request_key;
  IF request_row.request_sha256 IS DISTINCT FROM request_hash OR request_row.operator_subject IS DISTINCT FROM actor_value
   OR request_row.tenant_id IS DISTINCT FROM tenant_value OR request_row.action IS DISTINCT FROM action_value THEN
   RAISE EXCEPTION 'Statement request key belongs to another intent' USING ERRCODE='23505'; END IF;
  RETURN request_row.response||jsonb_build_object('duplicate',true);
 END IF;
 PERFORM 1 FROM public.tenants WHERE id=tenant_value AND state IN('ACTIVE','SUSPENDED') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workspace not found' USING ERRCODE='P0002'; END IF;
 previous_tenant:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',tenant_value::text,true);
 IF action_value='META_STATEMENT_RESERVE' THEN
  IF object_value IS NOT NULL THEN RAISE EXCEPTION 'Unexpected statement identity' USING ERRCODE='22023'; END IF;
  response_value:=app.reserve_meta_cost_statement(tenant_value,body_value,actor_value);
 ELSIF action_value='META_FINANCE_RETENTION' THEN
  IF object_value IS NOT NULL THEN RAISE EXCEPTION 'Unexpected retention identity' USING ERRCODE='22023'; END IF;
  response_value:=app.approve_meta_finance_retention(tenant_value,body_value,actor_value);
 ELSE
  IF object_value IS NULL THEN RAISE EXCEPTION 'Statement identity required' USING ERRCODE='22023'; END IF;
  CASE action_value
   WHEN 'META_STATEMENT_REVIEW' THEN response_value:=app.review_meta_cost_statement(tenant_value,object_value,body_value,actor_value);
   WHEN 'META_STATEMENT_PREVIEW' THEN
    IF(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM ARRAY['expectedVerificationSha256','expectedVersion']::text[] THEN
     RAISE EXCEPTION 'Invalid preview intent' USING ERRCODE='22023'; END IF;
    response_value:=app.preview_meta_cost_statement(tenant_value,object_value,body_value);
   WHEN 'META_STATEMENT_PUBLISH' THEN
    IF(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM
     ARRAY['expectedCurrentHeadId','expectedInputSha256','expectedPreviewSha256','expectedVerificationSha256','expectedVersion']::text[] THEN
     RAISE EXCEPTION 'Invalid publish intent' USING ERRCODE='22023'; END IF;
    response_value:=app.publish_meta_cost_statement(tenant_value,object_value,body_value,actor_value);
   WHEN 'META_SOURCE_RECONCILE' THEN response_value:=app.reconcile_meta_cost_source_write(tenant_value,object_value,body_value,actor_value);
   WHEN 'META_SOURCE_PRIVACY_REVIEW' THEN response_value:=app.review_meta_cost_source_privacy(tenant_value,object_value,body_value,actor_value);
  END CASE;
 END IF;
 response_value:=response_value||jsonb_build_object('duplicate',false);
 UPDATE public.platform_metering_operator_requests SET response=response_value WHERE id=request_id;
 INSERT INTO public.platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(actor_value,lower(action_value),'meta_cost_statement',COALESCE(object_value,(response_value->>'id')::uuid,tenant_value)::text,
  jsonb_build_object('tenantId',tenant_value,'requestSha256',request_hash,'resultSha256',encode(digest(response_value::text,'sha256'),'hex')),audit_request_value);
 PERFORM set_config('app.tenant_id',COALESCE(previous_tenant,''),true);RETURN response_value;
END $$;

-- Tenant summaries never contain original files, private provider IDs, raw
-- statement descriptions, issuer evidence, storage keys or operator subjects.
CREATE FUNCTION app.meta_cost_statement_summaries(tenant_value uuid,account_value uuid,from_value timestamptz,to_value timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'purpose',s.purpose,'basisKind',s.basis_kind,'evidenceMode',s.evidence_mode,
  'currency',s.currency,'periodFrom',s.period_from,'periodTo',s.period_to,'amount',s.publication->>'amount','coverage',s.publication->>'coverage',
  'quantity',s.publication->'quantity','estimatedAmount',s.publication->'estimatedAmount','difference',s.publication->'difference',
  'adjustments',s.publication->'adjustments','publishedAt',s.published_at,'predecessorId',s.predecessor_id,'publicationSha256',s.publication_sha256,
  'superseded',EXISTS(SELECT 1 FROM public.meta_cost_statement_versions next WHERE next.tenant_id=s.tenant_id AND next.predecessor_id=s.id AND next.lifecycle='PUBLISHED'),
  'sourceAvailability',CASE WHEN s.source_state='NONE' THEN 'REFERENCED_UPSTREAM' WHEN s.source_state='READY' AND s.source_delete_after>clock_timestamp() THEN 'RETAINED_RESTRICTED'
   WHEN s.source_state='PURGED' THEN 'PURGED' ELSE 'UNAVAILABLE' END) ORDER BY s.published_at,s.id),'[]'::jsonb)
 FROM(SELECT * FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND tenant_value=app.current_tenant_id()
  AND account_id=account_value AND lifecycle='PUBLISHED' AND period_from<to_value AND period_to>from_value ORDER BY published_at,id LIMIT 1001) s
$$;

CREATE FUNCTION app.operator_meta_statement_read(tenant_value uuid,account_value uuid,id_value uuid,from_value timestamptz,to_value timestamptz,
 actor_value text,request_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE previous_tenant text;result_value jsonb;
BEGIN
 previous_tenant:=current_setting('app.tenant_id',true);PERFORM set_config('app.tenant_id',tenant_value::text,true);
 IF id_value IS NULL THEN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'accountId',s.account_id,'version',s.version,'state',s.lifecycle,'purpose',s.purpose,
   'evidenceMode',s.evidence_mode,'currency',s.currency,'periodFrom',s.period_from,'periodTo',s.period_to,'inputSha256',s.input_sha256,
   'sourceState',s.source_state,'publicationSha256',s.publication_sha256,'publishedAt',s.published_at) ORDER BY s.created_at,s.id),'[]'::jsonb) INTO result_value
  FROM(SELECT * FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND account_id=account_value
   AND period_from<to_value AND period_to>from_value ORDER BY created_at,id LIMIT 1001) s;
  result_value:=jsonb_build_object('statements',result_value);
 ELSE
  SELECT jsonb_build_object('id',id,'accountId',account_id,'version',version,'state',lifecycle,'purpose',purpose,'evidenceMode',evidence_mode,
   'inputSha256',input_sha256,'description',normalized_input,'sourceState',source_state,'originalSha256',original_sha256,'originalByteSize',original_byte_size,
   'originalMime',original_mime,'writeAttemptId',write_attempt_id,'writeDisposition',write_disposition,'scanSha256',scan_sha256,'verification',verification,
   'verificationSha256',CASE WHEN verification IS NULL THEN NULL ELSE encode(digest(verification::text,'sha256'),'hex') END,
   'previewSha256',CASE WHEN preview IS NULL THEN NULL ELSE encode(digest(preview::text,'sha256'),'hex') END,
   'currentHeadId',app.meta_cost_statement_head(meta_cost_statement_versions),
   'priorAdjustments',COALESCE((SELECT head.publication->'adjustments' FROM public.meta_cost_statement_versions head
     WHERE head.tenant_id=tenant_value AND head.id=app.meta_cost_statement_head(meta_cost_statement_versions)),'[]'::jsonb),
   'sourceFenced',EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE' AND state IN('QUEUED','RUNNING','FAILED_RETRYABLE')),
   'subjectCoverage',source_subject_coverage,'preview',preview,'publication',publication,'publicationSha256',publication_sha256,
   'retention',retention_snapshot,'expiresAt',expires_at,'sourceDeleteAfter',source_delete_after,'recordDeleteAfter',record_delete_after) INTO result_value
  FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'Statement not found' USING ERRCODE='P0002'; END IF;
  result_value:=result_value||jsonb_build_object('privacyReviews',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'targetId',target.id,'state',target.state,'bindingSha256',encode(digest(target.finance_binding::text,'sha256'),'hex'),
    'policyVersion',policy.version,'outcome',target.finance_review->>'outcome','jobState',job.state,'scopeType',job.scope_type)
    ORDER BY target.created_at,target.id) FROM public.privacy_job_targets target
    JOIN public.privacy_jobs job ON job.tenant_id=target.tenant_id AND job.id=target.job_id
    JOIN public.retention_policies policy ON policy.tenant_id=target.tenant_id
    WHERE target.tenant_id=tenant_value AND target.target_id=id_value::text AND target.target_type='FINANCE_SOURCE_REVIEW'),'[]'::jsonb));
 END IF;
 INSERT INTO public.platform_operations_audit_events(operator_subject,action,target_type,target_id,safe_metadata,request_id)
 VALUES(actor_value,'meta.statement.viewed','meta_cost_statement',COALESCE(id_value,account_value,tenant_value)::text,jsonb_build_object('tenantId',tenant_value),request_value);
 PERFORM set_config('app.tenant_id',COALESCE(previous_tenant,''),true);RETURN result_value;
END $$;

CREATE FUNCTION app.meta_cost_statement_publication(tenant_value uuid,id_value uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT jsonb_build_object('id',s.id,'publicationSha256',s.publication_sha256,'predecessorId',s.predecessor_id,
  'superseded',EXISTS(SELECT 1 FROM public.meta_cost_statement_versions next WHERE next.tenant_id=s.tenant_id AND next.predecessor_id=s.id AND next.lifecycle='PUBLISHED'),
  'statement',jsonb_build_object('schemaVersion',s.publication->'schemaVersion','purpose',s.purpose,'basisKind',s.basis_kind,
   'evidenceMode',s.evidence_mode,'currency',s.currency,'minorUnits',s.minor_units,'periodFrom',s.period_from,'periodTo',s.period_to,
   'timezone',s.timezone,'amount',s.publication->'amount','quantity',s.publication->'quantity','estimatedAmount',s.publication->'estimatedAmount',
   'difference',s.publication->'difference','coverage',s.publication->'coverage','unresolvedAssessments',s.publication->'unresolvedAssessments',
   'unknownModeAssessments',s.publication->'unknownModeAssessments','adjustments',s.publication->'adjustments',
   'upstreamPublications',s.publication->'upstreamPublications','publishedAt',s.published_at,'claim',s.publication->'claim'))
 FROM public.meta_cost_statement_versions s WHERE s.tenant_id=tenant_value AND tenant_value=app.current_tenant_id() AND s.id=id_value AND s.lifecycle='PUBLISHED'
$$;

REVOKE ALL ON FUNCTION app.approve_meta_finance_retention(uuid,jsonb,text),app.reconcile_meta_cost_source_write(uuid,uuid,jsonb,text),
 app.operator_meta_statement(text,uuid,uuid,jsonb,text,text,text),app.meta_cost_statement_summaries(uuid,uuid,timestamptz,timestamptz),
 app.operator_meta_statement_read(uuid,uuid,uuid,timestamptz,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meta_cost_statement_publication(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.operator_meta_statement(text,uuid,uuid,jsonb,text,text,text),
 app.operator_meta_statement_read(uuid,uuid,uuid,timestamptz,timestamptz,text,text) TO wasalx_platform_operations_client;
GRANT EXECUTE ON FUNCTION app.meta_cost_statement_summaries(uuid,uuid,timestamptz,timestamptz) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.meta_cost_statement_publication(uuid,uuid) TO wasalx_app;

-- Compose the incumbent identity/coexistence target kinds; the integration
-- carrier verifies this finite union against preceding delivered migrations.
ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_target_type_check;
ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_job_targets_target_type_check CHECK(target_type IN(
 'ZAMMAD_TICKET','ZAMMAD_USER','MEDIA_OBJECT','EXPORT_ARTIFACT','EXPORT_OBJECT','NORMALIZED_MESSAGE','DELIVERY','META_DIRECT_ALIAS','META_DIRECT_IDENTITY_EVENT',
 'META_COEXISTENCE_MESSAGE','META_COEXISTENCE_CONTACT','META_COEXISTENCE_EVENT','META_COEXISTENCE_SUBJECT_CUTOFF',
 'META_ROUTING_EVENT','META_ROUTING_ACTION','META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD'));
ALTER TABLE privacy_job_targets ADD COLUMN finance_binding jsonb;
ALTER TABLE privacy_job_targets ADD COLUMN finance_review jsonb;
ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_finance_binding_shape CHECK(
 (target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD'))=(finance_binding IS NOT NULL)
 AND(finance_binding IS NULL OR(jsonb_typeof(finance_binding)='object' AND octet_length(finance_binding::text)<=8192))
 AND(finance_review IS NULL OR(jsonb_typeof(finance_review)='object' AND octet_length(finance_review::text)<=8192)));
ALTER TABLE privacy_job_targets DROP CONSTRAINT privacy_job_targets_object_key_snapshot_check;
ALTER TABLE privacy_job_targets ADD CONSTRAINT privacy_job_targets_object_key_snapshot_check CHECK(object_key_snapshot IS NULL
 OR(target_type='MEDIA_OBJECT' AND object_key_snapshot~('^'||tenant_id::text||'/sha256/[0-9a-f]{2}/[0-9a-f]{64}$') AND split_part(object_key_snapshot,'/',3)=substr(right(object_key_snapshot,64),1,2))
 OR(target_type IN('EXPORT_ARTIFACT','EXPORT_OBJECT') AND object_key_snapshot~('^tenants/'||tenant_id::text||'/privacy-exports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9]+)?\.json$'))
 OR(target_type='META_COST_SOURCE' AND object_key_snapshot='tenants/'||tenant_id::text||'/meta-cost-sources/'||target_id||'/'||(finance_binding->>'originalSha256')||'.bin'));

-- Original file coverage and financial-record subject linkage are separate.
-- Immutable selected effects remain discoverable after live assessment changes.
CREATE FUNCTION app.meta_cost_statement_delivery_refs(source_value public.meta_cost_statement_versions)
RETURNS TABLE(delivery_id text) LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT DISTINCT item->>'deliveryId' FROM jsonb_array_elements(
  COALESCE(source_value.normalized_input->'lines','[]'::jsonb)||
  COALESCE(source_value.preview->'selectedRows','[]'::jsonb)||
  COALESCE(source_value.publication->'selectedRows','[]'::jsonb)) item
 WHERE item->>'deliveryId' IS NOT NULL
$$;
CREATE FUNCTION app.meta_cost_record_subject_targeted(source_value public.meta_cost_statement_versions,job_value public.privacy_jobs)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT job_value.tenant_id=source_value.tenant_id AND job_value.tenant_id=app.current_tenant_id()
  AND (EXISTS(SELECT 1 FROM app.meta_cost_statement_delivery_refs(source_value) ref
   JOIN public.privacy_job_targets target ON target.tenant_id=source_value.tenant_id AND target.job_id=job_value.id
    AND target.target_type='DELIVERY' AND target.target_id=ref.delivery_id)
   OR EXISTS(SELECT 1 FROM public.privacy_job_targets prior
    WHERE prior.tenant_id=source_value.tenant_id AND prior.target_id=source_value.id::text
     AND prior.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD')
     AND prior.finance_binding->>'scopeType'=job_value.scope_type
     AND prior.finance_binding->>'scopeSha256'=encode(digest(convert_to(job_value.scope_type,'UTF8')||decode('00','hex')||convert_to(job_value.scope_value,'UTF8'),'sha256'),'hex')
     AND prior.finance_binding->>'recordSubjectMatched'='true'))
$$;
CREATE FUNCTION app.meta_cost_record_subject_uncertain(source_value public.meta_cost_statement_versions)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.meta_cost_statement_delivery_refs(source_value) ref
  LEFT JOIN public.delivery_outbox delivery ON delivery.tenant_id=source_value.tenant_id AND delivery.id::text=ref.delivery_id
  WHERE delivery.id IS NULL OR delivery.content_redacted_at IS NOT NULL)
$$;

CREATE FUNCTION app.meta_cost_privacy_binding(source_value public.meta_cost_statement_versions,job_value public.privacy_jobs,policy_version bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT jsonb_build_object('schemaVersion',1,'sourceId',source_value.id,'inputSha256',source_value.input_sha256,'originalSha256',source_value.original_sha256,
  'requestId',job_value.request_id,'jobId',job_value.id,'scopeType',job_value.scope_type,
  'scopeSha256',encode(digest(convert_to(job_value.scope_type,'UTF8')||decode('00','hex')||convert_to(job_value.scope_value,'UTF8'),'sha256'),'hex'),
  'retentionSnapshotSha256',encode(digest(source_value.retention_snapshot::text,'sha256'),'hex'),'policyVersion',policy_version,
  'originalSubjectCoverage',source_value.source_subject_coverage,
  'recordSubjectMatched',app.meta_cost_record_subject_targeted(source_value,job_value),
  'recordEvidenceSha256',encode(digest(jsonb_build_array(source_value.preview->'selectedRows',source_value.publication->'selectedRows',source_value.normalized_input->'lines')::text,'sha256'),'hex'))
$$;

CREATE FUNCTION app.meta_cost_privacy_review_deadline(source_value public.meta_cost_statement_versions) RETURNS timestamptz
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT CASE WHEN source_value.source_state IN('NONE','PURGED','REJECTED') THEN COALESCE(source_value.record_delete_after,source_value.expires_at)
  WHEN source_value.lifecycle='PUBLISHED' THEN source_value.source_delete_after
  ELSE LEAST(COALESCE(source_value.source_delete_after,source_value.expires_at),source_value.expires_at) END
$$;

CREATE FUNCTION app.meta_cost_privacy_candidates(job_value public.privacy_jobs) RETURNS SETOF public.meta_cost_statement_versions
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT source.* FROM public.meta_cost_statement_versions source WHERE source.tenant_id=job_value.tenant_id
  AND job_value.tenant_id=app.current_tenant_id() AND job_value.job_type<>'EXPORT'
  AND(job_value.job_type='DELETE' OR(source.source_state NOT IN('NONE','PURGED','REJECTED') AND(source.source_state='PURGE_PENDING'
    OR source.source_delete_after<=clock_timestamp() OR(source.lifecycle<>'PUBLISHED' AND source.expires_at<=clock_timestamp())))
    OR COALESCE(source.record_delete_after,source.expires_at)<=clock_timestamp())
  AND(job_value.job_type='RETENTION_SWEEP' OR job_value.scope_type='TENANT' OR source.source_subject_coverage='UNKNOWN'
   OR app.meta_cost_record_subject_uncertain(source)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(source.subject_attestation->'refs','[]'::jsonb)) ref WHERE ref->>'scopeType'=job_value.scope_type
    AND ref->>'scopeSha256'=encode(digest(convert_to(job_value.scope_type,'UTF8')||decode('00','hex')||convert_to(job_value.scope_value,'UTF8'),'sha256'),'hex'))
   OR app.meta_cost_record_subject_targeted(source,job_value))
  AND NOT EXISTS(SELECT 1 FROM public.privacy_job_targets target WHERE target.tenant_id=source.tenant_id AND target.job_id=job_value.id
    AND target.target_id=source.id::text AND target.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD'))
  AND NOT app.has_applicable_privacy_hold('TENANT',source.tenant_id::text)
  AND(job_value.job_type<>'RETENTION_SWEEP' OR NOT EXISTS(SELECT 1 FROM public.privacy_legal_holds WHERE tenant_id=source.tenant_id
    AND state='ACTIVE' AND(expires_at IS NULL OR expires_at>clock_timestamp())))
 ORDER BY source.account_id,source.purpose,source.evidence_mode,source.id LIMIT 1000
$$;

CREATE FUNCTION app.meta_cost_privacy_has_remaining(job_value uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.privacy_jobs job CROSS JOIN LATERAL app.meta_cost_privacy_candidates(job) source
  WHERE job.tenant_id=app.current_tenant_id() AND job.id=job_value AND job.state='RUNNING')
$$;

CREATE FUNCTION app.discover_meta_cost_privacy(job_value uuid,lease_value uuid,fence_value bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE job public.privacy_jobs;source_row public.meta_cost_statement_versions;policy public.retention_policies;
 binding jsonb;kind text;
BEGIN
 SELECT * INTO job FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value AND state='RUNNING'
  AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Privacy lease changed' USING ERRCODE='40001'; END IF;
 IF job.job_type='EXPORT' THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||job.tenant_id::text,0));
 SELECT * INTO policy FROM public.retention_policies WHERE tenant_id=job.tenant_id;
 -- A changed policy reopens its decision without rewriting the immutable
 -- source/request binding or discarding the original audit receipt.
 UPDATE public.privacy_job_targets target SET state='PENDING',completed_at=NULL,updated_at=clock_timestamp()
  FROM public.meta_cost_statement_versions source WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id
   AND target.target_type='FINANCE_SOURCE_REVIEW' AND target.target_id=source.id::text AND source.tenant_id=target.tenant_id
   AND target.state='SKIPPED' AND(target.finance_review->>'policyVersion' IS DISTINCT FROM policy.version::text
    OR(target.finance_review->>'outcome'='POLICY_RETAINED' AND app.meta_cost_privacy_review_deadline(source)<=clock_timestamp()));
 -- Existing deferred job claims carry the next bounded batch. An existing
 -- target is not rediscovered, and the completion guard checks for any tail.
 FOR source_row IN SELECT * FROM app.meta_cost_privacy_candidates(job) LOOP
  binding:=app.meta_cost_privacy_binding(source_row,job,policy.version);
  IF source_row.source_state NOT IN('NONE','PURGED','REJECTED') THEN
   kind:=CASE WHEN source_row.write_disposition IN('ADMITTED','UNKNOWN')
     OR(job.job_type='DELETE' AND(source_row.source_subject_coverage='UNKNOWN' OR app.meta_cost_record_subject_uncertain(source_row)
       OR source_row.source_delete_after>clock_timestamp())) THEN 'FINANCE_SOURCE_REVIEW' ELSE 'META_COST_SOURCE' END;
   INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,object_key_snapshot,finance_binding)
   VALUES(job.tenant_id,job.id,kind,source_row.id::text,encode(digest(source_row.id::text,'sha256'),'hex'),
    CASE WHEN kind='META_COST_SOURCE' THEN source_row.object_key END,binding) ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING;
   -- A deletion intent removes future admission before any external DELETE. An
   -- unresolved admitted PUT remains owned and cannot become PURGED here.
   IF kind='META_COST_SOURCE' THEN
    UPDATE public.meta_cost_statement_versions SET source_state='PURGE_PENDING',lifecycle=CASE WHEN lifecycle='PUBLISHED' THEN lifecycle ELSE 'EXPIRED' END,version=version+1
     WHERE tenant_id=job.tenant_id AND id=source_row.id AND source_state<>'PURGE_PENDING';
   END IF;
  END IF;
  IF source_row.source_state IN('NONE','PURGED','REJECTED') AND job.job_type='DELETE'
   AND COALESCE(source_row.record_delete_after,source_row.expires_at)>clock_timestamp() THEN
   INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,finance_binding)
   VALUES(job.tenant_id,job.id,'FINANCE_SOURCE_REVIEW',source_row.id::text,encode(digest(source_row.id::text,'sha256'),'hex'),binding)
   ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING;
  END IF;
  IF COALESCE(source_row.record_delete_after,source_row.expires_at)<=clock_timestamp() THEN
   INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,finance_binding)
   VALUES(job.tenant_id,job.id,'META_COST_RECORD',source_row.id::text,encode(digest(source_row.id::text,'sha256'),'hex'),binding)
   ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING;
  END IF;
 END LOOP;
END $$;

CREATE FUNCTION app.review_meta_cost_source_privacy(tenant_value uuid,id_value uuid,body_value jsonb,actor_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE target public.privacy_job_targets;job public.privacy_jobs;source_row public.meta_cost_statement_versions;policy public.retention_policies;review_value jsonb;
BEGIN
 IF tenant_value IS DISTINCT FROM app.current_tenant_id() OR(SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(body_value) k) IS DISTINCT FROM
  ARRAY['expectedBindingSha256','expectedPolicyVersion','expectedVersion','outcome','reviewSha256','targetId']::text[]
  OR COALESCE(body_value->>'outcome','') NOT IN('NO_SUBJECT_MATCH','POLICY_RETAINED','PURGE_REQUIRED')
  OR COALESCE(body_value->>'reviewSha256','')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid finance source review' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||tenant_value::text,0));
 SELECT * INTO target FROM public.privacy_job_targets WHERE tenant_id=tenant_value AND id=(body_value->>'targetId')::uuid
  AND target_id=id_value::text AND target_type='FINANCE_SOURCE_REVIEW' AND state IN('PENDING','SKIPPED') FOR UPDATE;
 IF NOT FOUND OR encode(digest(target.finance_binding::text,'sha256'),'hex') IS DISTINCT FROM body_value->>'expectedBindingSha256' THEN
  RAISE EXCEPTION 'Privacy source review changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=tenant_value AND id=id_value FOR UPDATE;
 SELECT * INTO job FROM public.privacy_jobs WHERE tenant_id=tenant_value AND id=target.job_id;
 SELECT * INTO policy FROM public.retention_policies WHERE tenant_id=tenant_value;
 IF source_row.id IS NULL OR source_row.version IS DISTINCT FROM(body_value->>'expectedVersion')::bigint
  OR target.finance_binding IS DISTINCT FROM app.meta_cost_privacy_binding(source_row,job,(target.finance_binding->>'policyVersion')::bigint)
  OR policy.version IS DISTINCT FROM(body_value->>'expectedPolicyVersion')::bigint
  OR job.state NOT IN('FAILED_TERMINAL','QUEUED','RUNNING','FAILED_RETRYABLE') THEN RAISE EXCEPTION 'Privacy source evidence changed' USING ERRCODE='40001'; END IF;
 IF body_value->>'outcome'='NO_SUBJECT_MATCH' AND(job.scope_type='TENANT' OR target.finance_binding->>'recordSubjectMatched'='true') THEN
  RAISE EXCEPTION 'Retained financial subject linkage cannot be denied by original-file review' USING ERRCODE='22023'; END IF;
 IF source_row.write_disposition IN('ADMITTED','UNKNOWN') THEN
  RAISE EXCEPTION 'Admitted source write remains unresolved' USING ERRCODE='55000'; END IF;
 IF body_value->>'outcome'='POLICY_RETAINED' AND app.meta_cost_privacy_review_deadline(source_row)<=clock_timestamp() THEN
  RAISE EXCEPTION 'Approved source retention expired' USING ERRCODE='55000'; END IF;
 IF body_value->>'outcome'='PURGE_REQUIRED' THEN
  IF source_row.write_disposition IN('ADMITTED','UNKNOWN') OR EXISTS(SELECT 1 FROM public.privacy_legal_holds WHERE tenant_id=tenant_value
    AND state='ACTIVE' AND(expires_at IS NULL OR expires_at>clock_timestamp())) THEN
   RAISE EXCEPTION 'Source write or legal hold remains unresolved' USING ERRCODE='55000'; END IF;
  IF source_row.source_state NOT IN('NONE','PURGED','REJECTED') THEN
   INSERT INTO public.privacy_job_targets(tenant_id,job_id,target_type,target_id,target_sha256,object_key_snapshot,finance_binding)
  VALUES(tenant_value,job.id,'META_COST_SOURCE',id_value::text,encode(digest(id_value::text,'sha256'),'hex'),source_row.object_key,target.finance_binding)
  ON CONFLICT(tenant_id,job_id,target_type,target_sha256) DO NOTHING;
  UPDATE public.meta_cost_statement_versions SET source_state='PURGE_PENDING',lifecycle=CASE WHEN lifecycle='PUBLISHED' THEN lifecycle ELSE 'EXPIRED' END,version=version+1
   WHERE tenant_id=tenant_value AND id=id_value;
  END IF;
 END IF;
 review_value:=jsonb_build_object('schemaVersion',1,'outcome',body_value->>'outcome','reviewSha256',body_value->>'reviewSha256',
  'bindingSha256',body_value->>'expectedBindingSha256','policyVersion',policy.version,'reviewedBy',actor_value,'reviewedAt',clock_timestamp());
 UPDATE public.privacy_job_targets SET state='SKIPPED',finance_review=review_value,completed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE tenant_id=tenant_value AND id=target.id;
 RETURN jsonb_build_object('id',id_value,'targetId',target.id,'outcome',body_value->>'outcome','requiresRequestRetry',job.state='FAILED_TERMINAL');
END $$;

-- Ordinary target membership stays frozen after DISCOVER. The two existing
-- bounded finance admissions may add only their validated financial targets.
-- Match their actual definer owner, never a caller role or caller-set flag;
-- direct runtime INSERTs cannot acquire this authority. The finance target
-- and source validators still check every admitted row.
CREATE OR REPLACE FUNCTION app.guard_privacy_target_membership()
RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD')
  AND NEW.tenant_id=app.current_tenant_id()
  AND current_user::regrole=(SELECT proowner FROM pg_catalog.pg_proc
    WHERE oid='app.discover_meta_cost_privacy(uuid,uuid,bigint)'::regprocedure)
  AND current_user::regrole=(SELECT proowner FROM pg_catalog.pg_proc
    WHERE oid='app.review_meta_cost_source_privacy(uuid,uuid,jsonb,text)'::regprocedure) THEN
  RETURN NEW;
 END IF;
 IF (TG_OP IN('INSERT','UPDATE') AND EXISTS(
      SELECT 1 FROM public.privacy_jobs job WHERE job.tenant_id=NEW.tenant_id AND job.id=NEW.job_id AND job.stage<>'DISCOVER'))
  OR (TG_OP IN('DELETE','UPDATE') AND EXISTS(
      SELECT 1 FROM public.privacy_jobs job WHERE job.tenant_id=OLD.tenant_id AND job.id=OLD.job_id AND job.stage<>'DISCOVER')) THEN
  RAISE EXCEPTION 'privacy target membership is frozen after discovery' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION app.guard_meta_finance_privacy_target() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD') AND NEW.target_type IS DISTINCT FROM OLD.target_type THEN
  RAISE EXCEPTION 'Finance privacy target kind is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.target_type NOT IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT pg_has_role(current_user,'wasalx_connector_worker','MEMBER') AND NOT pg_has_role(current_user,'wasalx_platform_operations_client','MEMBER') THEN
   RAISE EXCEPTION 'Finance privacy target requires its domain admission' USING ERRCODE='42501'; END IF;
 ELSE
  IF(NEW.tenant_id,NEW.job_id,NEW.target_type,NEW.target_id,NEW.target_sha256,NEW.finance_binding,NEW.object_key_snapshot)
   IS DISTINCT FROM(OLD.tenant_id,OLD.job_id,OLD.target_type,OLD.target_id,OLD.target_sha256,OLD.finance_binding,OLD.object_key_snapshot) THEN
   RAISE EXCEPTION 'Finance privacy scope is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.finance_review IS DISTINCT FROM OLD.finance_review AND NOT pg_has_role(current_user,'wasalx_platform_operations_client','MEMBER') THEN
   RAISE EXCEPTION 'Finance source review requires platform authority' USING ERRCODE='42501'; END IF;
 END IF;
 IF NEW.target_type='FINANCE_SOURCE_REVIEW' AND(NEW.state='COMPLETE' OR(NEW.state='SKIPPED' AND NEW.finance_review IS NULL)) THEN
  RAISE EXCEPTION 'Unresolved source review cannot complete erasure' USING ERRCODE='55000'; END IF;
 IF NEW.target_type IN('META_COST_SOURCE','META_COST_RECORD') AND NEW.state='SKIPPED' THEN
  RAISE EXCEPTION 'Financial deletion cannot be skipped as a review' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_finance_privacy_target BEFORE INSERT OR UPDATE ON privacy_job_targets FOR EACH ROW EXECUTE FUNCTION app.guard_meta_finance_privacy_target();

-- Role-sensitive admission remains in the invoker trigger; this validator only reads private finance state.
CREATE FUNCTION app.guard_meta_finance_privacy_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE source_row public.meta_cost_statement_versions;job public.privacy_jobs;
BEGIN
 IF NEW.target_type NOT IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD') THEN RETURN NEW; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'Finance privacy tenant does not match' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id::uuid;
  SELECT * INTO job FROM public.privacy_jobs WHERE tenant_id=NEW.tenant_id AND id=NEW.job_id;
  IF NEW.state<>'PENDING' OR NEW.finance_review IS NOT NULL OR NEW.external_started_at IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR source_row.id IS NULL OR job.id IS NULL
   OR job.job_type='EXPORT' OR job.state NOT IN('RUNNING','FAILED_TERMINAL','FAILED_RETRYABLE','QUEUED')
   OR NEW.target_sha256 IS DISTINCT FROM encode(digest(NEW.target_id,'sha256'),'hex')
   OR NEW.finance_binding IS DISTINCT FROM app.meta_cost_privacy_binding(source_row,job,(NEW.finance_binding->>'policyVersion')::bigint) THEN
   RAISE EXCEPTION 'Finance privacy target does not match its source and request' USING ERRCODE='42501'; END IF;
 END IF;
 IF NEW.target_type='META_COST_RECORD' AND NEW.state='COMPLETE' AND EXISTS(SELECT 1 FROM public.meta_cost_statement_versions WHERE tenant_id=NEW.tenant_id AND id::text=NEW.target_id) THEN
  RAISE EXCEPTION 'Financial record has not been purged' USING ERRCODE='55000'; END IF;
 IF NEW.target_type='META_COST_SOURCE' AND(NEW.external_started_at IS NOT NULL OR NEW.state IN('EXTERNAL_COMPLETE','COMPLETE')) THEN
  SELECT * INTO source_row FROM public.meta_cost_statement_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.target_id::uuid;
  IF NEW.state='COMPLETE' AND(source_row.source_state IS DISTINCT FROM 'PURGED' OR OLD.state NOT IN('EXTERNAL_COMPLETE','COMPLETE')) THEN
   RAISE EXCEPTION 'Financial source deletion has not been finalized' USING ERRCODE='55000'; END IF;
  IF source_row.id IS NULL OR source_row.write_disposition IN('ADMITTED','UNKNOWN') OR source_row.source_state NOT IN('PURGE_PENDING','PURGED')
   OR source_row.object_key IS DISTINCT FROM NEW.object_key_snapshot OR source_row.input_sha256 IS DISTINCT FROM NEW.finance_binding->>'inputSha256'
   OR EXISTS(SELECT 1 FROM public.privacy_legal_holds WHERE tenant_id=NEW.tenant_id AND state='ACTIVE' AND(expires_at IS NULL OR expires_at>clock_timestamp())) THEN
   RAISE EXCEPTION 'Source cleanup is not terminally fenced' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_finance_privacy_target_source BEFORE INSERT OR UPDATE ON privacy_job_targets FOR EACH ROW EXECUTE FUNCTION app.guard_meta_finance_privacy_source();

CREATE FUNCTION app.preserve_meta_finance_privacy_target() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF OLD.target_type NOT IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD') THEN RETURN OLD; END IF;
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'Finance privacy tenant does not match' USING ERRCODE='42501'; END IF;
 IF (OLD.state NOT IN('COMPLETE','SKIPPED')
  OR EXISTS(SELECT 1 FROM public.meta_cost_statement_versions WHERE tenant_id=OLD.tenant_id AND id::text=OLD.target_id)
  OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=OLD.tenant_id AND id=OLD.job_id AND state<>'SUCCEEDED')) THEN
  RAISE EXCEPTION 'Finance privacy obligation is still retained' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER meta_finance_privacy_target_delete BEFORE DELETE ON privacy_job_targets FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_finance_privacy_target();

CREATE FUNCTION app.guard_meta_finance_privacy_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF NEW.state<>'SUCCEEDED' OR OLD.state='SUCCEEDED' THEN RETURN NEW; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'Finance privacy tenant does not match' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.meta_cost_privacy_candidates(NEW)) THEN
  RAISE EXCEPTION 'Finance privacy discovery remains incomplete' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.privacy_job_targets target
  LEFT JOIN public.retention_policies policy ON policy.tenant_id=target.tenant_id
  LEFT JOIN public.meta_cost_statement_versions source ON source.tenant_id=target.tenant_id AND source.id::text=target.target_id
  WHERE target.tenant_id=NEW.tenant_id AND target.job_id=NEW.id AND target.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD')
   AND CASE WHEN target.target_type='FINANCE_SOURCE_REVIEW' THEN
    target.state<>'SKIPPED' OR target.finance_review IS NULL
    OR target.finance_review->>'policyVersion' IS DISTINCT FROM policy.version::text
    OR(target.finance_review->>'outcome'='POLICY_RETAINED' AND source.id IS NOT NULL AND app.meta_cost_privacy_review_deadline(source)<=clock_timestamp())
    ELSE target.state<>'COMPLETE' END) THEN
  RAISE EXCEPTION 'Finance source privacy review remains unresolved' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_finance_privacy_completion BEFORE UPDATE OF state ON privacy_jobs FOR EACH ROW EXECUTE FUNCTION app.guard_meta_finance_privacy_completion();

CREATE FUNCTION app.meta_cost_record_purge_admitted(source_value public.meta_cost_statement_versions) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT source_value.tenant_id=app.current_tenant_id()
 AND COALESCE(source_value.record_delete_after,source_value.expires_at)<=clock_timestamp()
 AND source_value.source_state IN('NONE','PURGED','REJECTED')
 AND(source_value.write_attempt_id IS NULL OR source_value.write_disposition IN('WRITTEN','NOT_WRITTEN'))
 AND NOT EXISTS(SELECT 1 FROM public.privacy_legal_holds WHERE tenant_id=source_value.tenant_id AND state='ACTIVE'
   AND(expires_at IS NULL OR expires_at>clock_timestamp()))
 AND EXISTS(SELECT 1 FROM public.privacy_job_targets target JOIN public.privacy_jobs job ON job.tenant_id=target.tenant_id AND job.id=target.job_id
  WHERE target.tenant_id=source_value.tenant_id AND target.target_id=source_value.id::text AND target.target_type='META_COST_RECORD' AND target.state='PENDING'
   AND job.state='RUNNING' AND job.stage='LOCAL' AND job.lease_id IS NOT NULL AND job.lease_expires_at>=clock_timestamp())
$$;

CREATE FUNCTION app.finalize_meta_cost_source_privacy(job_value uuid,lease_value uuid,fence_value bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE job public.privacy_jobs;changed integer;retained integer;removed integer:=0;pass_count integer;source_row public.meta_cost_statement_versions;
BEGIN
 SELECT * INTO job FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value AND state='RUNNING' AND stage='LOCAL'
  AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Privacy finalization lease changed' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM public.privacy_job_targets WHERE tenant_id=job.tenant_id AND job_id=job.id AND target_type='FINANCE_SOURCE_REVIEW' AND state='PENDING') THEN
  RAISE EXCEPTION 'Finance source review required' USING ERRCODE='55000'; END IF;
 UPDATE public.meta_cost_statement_versions source SET source_state='PURGED',source_purged_at=clock_timestamp(),version=version+1
 WHERE source.tenant_id=job.tenant_id AND source.source_state='PURGE_PENDING' AND(source.write_attempt_id IS NULL OR source.write_disposition IN('WRITTEN','NOT_WRITTEN'))
  AND EXISTS(SELECT 1 FROM public.privacy_job_targets target WHERE target.tenant_id=source.tenant_id AND target.job_id=job.id
   AND target.target_type='META_COST_SOURCE' AND target.target_id=source.id::text AND target.state='EXTERNAL_COMPLETE' AND target.external_started_at IS NOT NULL
   AND target.object_key_snapshot=source.object_key);
 GET DIAGNOSTICS changed=ROW_COUNT;
 UPDATE public.privacy_job_targets target SET state='COMPLETE',completed_at=clock_timestamp(),updated_at=clock_timestamp()
  WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id AND target.target_type='META_COST_SOURCE' AND target.state='EXTERNAL_COMPLETE'
   AND EXISTS(SELECT 1 FROM public.meta_cost_statement_versions source WHERE source.tenant_id=target.tenant_id AND source.id::text=target.target_id AND source.source_state='PURGED');
 SELECT count(*) INTO retained FROM public.privacy_job_targets WHERE tenant_id=job.tenant_id AND job_id=job.id
  AND target_type='FINANCE_SOURCE_REVIEW' AND state='SKIPPED' AND finance_review->>'outcome'='POLICY_RETAINED';
 -- Delete only expired leaves. A published successor or customer statement
 -- retaining this revision under its own approved lifetime prevents early
 -- destruction; it remains an explicit pending obligation, never a false pass.
 LOOP
  pass_count:=0;
  FOR source_row IN SELECT source.* FROM public.meta_cost_statement_versions source
   JOIN public.privacy_job_targets target ON target.tenant_id=source.tenant_id AND target.target_id=source.id::text
   WHERE source.tenant_id=job.tenant_id AND target.job_id=job.id AND target.target_type='META_COST_RECORD' AND target.state='PENDING'
    AND app.meta_cost_record_purge_admitted(source)
    AND NOT EXISTS(SELECT 1 FROM public.meta_cost_statement_versions dependent WHERE dependent.tenant_id=source.tenant_id
     AND(dependent.predecessor_id=source.id OR COALESCE(dependent.normalized_input->'upstreamStatementVersionIds','[]'::jsonb) ? source.id::text))
    -- Retain the newest revision while any ancestor remains under its own
    -- approved retention. Removing only the newest row would make the head
    -- query expose that older revision as current again. The whole eligible
    -- chain is deleted leaf-first in this single transaction.
    AND NOT EXISTS(WITH RECURSIVE ancestors AS (
      SELECT prior.* FROM public.meta_cost_statement_versions prior WHERE prior.tenant_id=source.tenant_id AND prior.id=source.predecessor_id
      UNION ALL SELECT prior.* FROM public.meta_cost_statement_versions prior JOIN ancestors child
       ON prior.tenant_id=child.tenant_id AND prior.id=child.predecessor_id
     ) SELECT 1 FROM ancestors WHERE NOT app.meta_cost_record_purge_admitted(ROW(ancestors.*)::public.meta_cost_statement_versions))
   ORDER BY source.account_id,source.purpose,source.evidence_mode,source.id LOOP
   PERFORM app.meta_cost_statement_lock(job.tenant_id,source_row.account_id,source_row.purpose,source_row.evidence_mode);
   DELETE FROM public.meta_cost_statement_versions WHERE tenant_id=job.tenant_id AND id=source_row.id;
   UPDATE public.privacy_job_targets SET state='COMPLETE',completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE tenant_id=job.tenant_id AND job_id=job.id AND target_type='META_COST_RECORD' AND target_id=source_row.id::text;
   pass_count:=pass_count+1;removed:=removed+1;
  END LOOP;
  EXIT WHEN pass_count=0;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.privacy_job_targets WHERE tenant_id=job.tenant_id AND job_id=job.id AND target_type='META_COST_RECORD' AND state='PENDING') THEN
  RAISE EXCEPTION 'Finance record dependency or retention remains unresolved' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('metaCostSourcesPurged',changed,'metaCostSourcesRetained',retained,'metaCostRecordsPurged',removed,
  'metaCostRecordsRetained',(SELECT count(*) FROM public.meta_cost_statement_versions source WHERE source.tenant_id=job.tenant_id
    AND EXISTS(SELECT 1 FROM public.privacy_job_targets target WHERE target.tenant_id=source.tenant_id AND target.job_id=job.id AND target.target_id=source.id::text
     AND target.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD'))));
END $$;

CREATE FUNCTION app.export_meta_cost_statements(job_value uuid,lease_value uuid,fence_value bigint,tickets_value text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE job public.privacy_jobs;scope_sha text;statements jsonb;status_value jsonb;selected_count integer;
BEGIN
 SELECT * INTO job FROM public.privacy_jobs WHERE tenant_id=app.current_tenant_id() AND id=job_value AND job_type='EXPORT' AND state='RUNNING'
  AND lease_id=lease_value AND fencing_token=fence_value AND lease_expires_at>=clock_timestamp();
 IF NOT FOUND OR COALESCE(cardinality(tickets_value),0)>5000 THEN RAISE EXCEPTION 'Privacy export lease or scope changed' USING ERRCODE='40001'; END IF;
 scope_sha:=encode(digest(convert_to(job.scope_type,'UTF8')||decode('00','hex')||convert_to(job.scope_value,'UTF8'),'sha256'),'hex');
 SELECT COALESCE(jsonb_agg(item ORDER BY created_at,id),'[]'::jsonb),count(*) INTO statements,selected_count FROM(
  SELECT source.created_at,source.id,jsonb_build_object('id',source.id,'purpose',source.purpose,'mode',source.evidence_mode,
    'periodFrom',source.period_from,'periodTo',source.period_to,'state',source.lifecycle,'sourceState',source.source_state,
    'sourceDeleteAfter',source.source_delete_after,'recordDeleteAfter',COALESCE(source.record_delete_after,source.expires_at),
    'publicationSha256',source.publication_sha256,'predecessorId',source.predecessor_id,
    'accountId',CASE WHEN job.scope_type='TENANT' THEN source.account_id END,
    'currency',CASE WHEN job.scope_type='TENANT' THEN source.currency END,
    'amount',CASE WHEN job.scope_type='TENANT' THEN source.publication->'amount' END) item
   FROM public.meta_cost_statement_versions source WHERE source.tenant_id=job.tenant_id AND(job.scope_type='TENANT'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(source.subject_attestation->'refs','[]'::jsonb)) ref
      WHERE ref->>'scopeType'=job.scope_type AND ref->>'scopeSha256'=scope_sha)
    OR EXISTS(SELECT 1 FROM app.meta_cost_statement_delivery_refs(source) ref
      JOIN public.delivery_outbox delivery ON delivery.tenant_id=source.tenant_id AND delivery.id::text=ref.delivery_id
      WHERE delivery.content_redacted_at IS NULL AND((job.scope_type='PARTICIPANT' AND app.meta_cost_subject_delivery_matches(delivery,job.scope_value))
       OR delivery.zammad_ticket_id=ANY(tickets_value) OR EXISTS(SELECT 1 FROM public.delivery_ticket_links link WHERE link.tenant_id=delivery.tenant_id
        AND link.delivery_id=delivery.id AND link.zammad_ticket_id=ANY(tickets_value))))
    -- A prior qualified deletion target retains only the hashed scope binding.
    -- It permits minimal record/retention metadata after delivery redaction,
    -- never restoration of the selected effect's content, identifiers or totals.
    OR EXISTS(SELECT 1 FROM public.privacy_job_targets prior WHERE prior.tenant_id=source.tenant_id AND prior.target_id=source.id::text
      AND prior.target_type IN('META_COST_SOURCE','FINANCE_SOURCE_REVIEW','META_COST_RECORD')
      AND prior.finance_binding->>'scopeType'=job.scope_type AND prior.finance_binding->>'scopeSha256'=scope_sha
      AND prior.finance_binding->>'recordSubjectMatched'='true')) ORDER BY source.created_at,source.id LIMIT 1001) selected;
 IF selected_count>1000 THEN RAISE EXCEPTION 'Finance export scope exceeds its bound' USING ERRCODE='54000'; END IF;
 -- Unmapped originals disclose an uncertainty count, never another subject's
 -- account-period amounts, identifiers, original bytes, keys or source fields.
 SELECT jsonb_build_object('unknownSubjectCoverage',count(*) FILTER(WHERE source_subject_coverage='UNKNOWN' AND source_state NOT IN('NONE','PURGED','REJECTED')),
  'unknownRecordSubjectCoverage',count(*) FILTER(WHERE app.meta_cost_record_subject_uncertain(meta_cost_statement_versions)),
  'unresolvedWrites',count(*) FILTER(WHERE write_disposition IN('ADMITTED','UNKNOWN'))) INTO status_value
  FROM public.meta_cost_statement_versions WHERE tenant_id=job.tenant_id;
 RETURN jsonb_build_object('metaCostStatements',statements,'metaCostSourceReviewStatus',jsonb_build_array(status_value));
END $$;

REVOKE ALL ON FUNCTION app.meta_cost_statement_delivery_refs(public.meta_cost_statement_versions),
 app.meta_cost_record_subject_uncertain(public.meta_cost_statement_versions),
 app.meta_cost_record_subject_targeted(public.meta_cost_statement_versions,public.privacy_jobs),app.meta_cost_privacy_binding(public.meta_cost_statement_versions,public.privacy_jobs,bigint),
 app.meta_cost_privacy_review_deadline(public.meta_cost_statement_versions),
 app.meta_cost_privacy_candidates(public.privacy_jobs),app.meta_cost_privacy_has_remaining(uuid),app.preserve_meta_finance_privacy_target(),
 app.discover_meta_cost_privacy(uuid,uuid,bigint),app.review_meta_cost_source_privacy(uuid,uuid,jsonb,text),
 app.guard_meta_finance_privacy_target(),app.guard_meta_finance_privacy_source(),app.guard_meta_finance_privacy_completion(),app.meta_cost_record_purge_admitted(public.meta_cost_statement_versions),app.finalize_meta_cost_source_privacy(uuid,uuid,bigint),
 app.export_meta_cost_statements(uuid,uuid,bigint,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.discover_meta_cost_privacy(uuid,uuid,bigint),app.meta_cost_privacy_has_remaining(uuid),app.finalize_meta_cost_source_privacy(uuid,uuid,bigint),app.export_meta_cost_statements(uuid,uuid,bigint,text[]) TO wasalx_connector_worker;

COMMIT;
