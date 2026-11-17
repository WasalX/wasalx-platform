BEGIN;

CREATE FUNCTION app.meta_account_proof_canonical_json(value jsonb,depth integer DEFAULT 0) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE kind text:=jsonb_typeof(value);result text;item record;encoded text;number_value numeric;
BEGIN
 IF depth<0 OR depth>32 THEN RETURN NULL; END IF;
 IF kind IN('null','string','boolean') THEN RETURN value::text; END IF;
 IF kind='number' THEN
  number_value:=(value::text)::numeric;
  IF number_value<>trunc(number_value) OR abs(number_value)>9007199254740991 THEN RETURN NULL; END IF;
  RETURN trunc(number_value)::text;
 END IF;
 IF kind='array' THEN
  result:='';
  FOR item IN SELECT element FROM jsonb_array_elements(value) WITH ORDINALITY AS items(element,ordinal) ORDER BY ordinal LOOP
   encoded:=app.meta_account_proof_canonical_json(item.element,depth+1);IF encoded IS NULL THEN RETURN NULL; END IF;
   result:=result||CASE WHEN result='' THEN '' ELSE ',' END||encoded;
  END LOOP;
  RETURN '['||result||']';
 END IF;
 IF kind='object' THEN
  result:='';
  FOR item IN SELECT key,element FROM jsonb_each(value) AS items(key,element) ORDER BY key COLLATE "C" LOOP
   IF octet_length(item.key)<>char_length(item.key) THEN RETURN NULL; END IF;
   encoded:=app.meta_account_proof_canonical_json(item.element,depth+1);IF encoded IS NULL THEN RETURN NULL; END IF;
   result:=result||CASE WHEN result='' THEN '' ELSE ',' END||to_jsonb(item.key)::text||':'||encoded;
  END LOOP;
  RETURN '{'||result||'}';
 END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION app.meta_account_proof_canonical_json(jsonb,integer) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_proof_canonical_json(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_proof_canonical_json(jsonb,integer)
 TO wasalx_app,wasalx_connector_worker,wasalx_scheduler_reader,wasalx_meta_transition_executor;
CREATE FUNCTION app.meta_account_proof_sha256(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT encode(public.digest(app.meta_account_proof_canonical_json(value),'sha256'),'hex')
$$;
ALTER FUNCTION app.meta_account_proof_sha256(jsonb) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_proof_sha256(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_proof_sha256(jsonb)
 TO wasalx_app,wasalx_connector_worker,wasalx_scheduler_reader,wasalx_meta_transition_executor;



CREATE OR REPLACE FUNCTION app.meta_account_transition_context(connection_value uuid, actor_value uuid, app_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET row_security=off
SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE tenant_value uuid:=app.current_tenant_id(); connection_row public.connections;
 binding_row public.meta_connection_account_bindings; account_row public.meta_messaging_accounts;
 session_row public.provider_sessions; scope_value jsonb; flow_value jsonb; mode_value text; flow_ids uuid[];
BEGIN
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||tenant_value::text,0)) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.tenants WHERE id=tenant_value AND state='ACTIVE' FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.privacy_jobs WHERE tenant_id=tenant_value AND job_type='DELETE'
   AND state IN ('QUEUED','RUNNING','FAILED_RETRYABLE')) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.tenant_memberships WHERE tenant_id=tenant_value AND user_id=actor_value
   AND state='ACTIVE' AND role IN ('tenant_owner','tenant_admin') FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO connection_row FROM public.connections WHERE tenant_id=tenant_value AND id=connection_value
   AND provider='META' AND state IN ('WORKING','PAUSED') FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
   AND connection_id=connection_value AND state='ACTIVE';
 IF NOT FOUND OR binding_row.app_id<>app_value OR binding_row.secret_reference<>connection_row.secret_reference THEN RETURN NULL; END IF;
 SELECT * INTO account_row FROM public.meta_messaging_accounts WHERE tenant_id=tenant_value
   AND id=binding_row.account_id AND state<>'RETIRED' FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Match P08's connection -> account -> binding order; do not upgrade an
 -- account SHARE lock after taking a binding lock.
 SELECT * INTO binding_row FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
   AND connection_id=connection_value AND account_id=account_row.id AND state='ACTIVE' FOR SHARE;
 IF NOT FOUND OR binding_row.app_id<>app_value OR binding_row.secret_reference<>connection_row.secret_reference THEN RETURN NULL; END IF;
 SELECT * INTO session_row FROM public.provider_sessions WHERE tenant_id=tenant_value AND connection_id=connection_value
   AND id=binding_row.provider_session_id AND ownership_state='ACTIVE' AND state IN ('WORKING','PAUSED') FOR SHARE;
 IF NOT FOUND OR session_row.opaque_session_id<>binding_row.phone_number_id
   OR session_row.provider_state_data->>'wabaId' IS DISTINCT FROM account_row.provider_account_id
   OR NOT EXISTS(SELECT 1 FROM public.webhook_routes WHERE tenant_id=tenant_value AND connection_id=connection_value
     AND provider='META' AND state IN ('ACTIVE','PAUSED')) THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.meta_lifecycle_guard(connection_value,session_row.id,session_row.opaque_session_id,
   account_row.provider_account_id,app_value,CASE WHEN NOT(session_row.provider_state_data ? 'metaLifecycle') THEN 0
     WHEN session_row.provider_state_data#>>'{metaLifecycle,revision}' ~ '^[1-9][0-9]{0,15}$'
       THEN (session_row.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE NULL END) guard
   WHERE guard.revision_matches AND NOT guard.blocked AND NOT guard.unresolved_hold) THEN RETURN NULL; END IF;
 IF (SELECT count(*) FROM (SELECT id FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
   AND account_id=account_row.id AND state<>'RETIRED' LIMIT 2001) bounded)>2000 THEN RETURN NULL; END IF;
 IF (SELECT COALESCE(sum(octet_length(s.provider_state_data::text)),0) FROM public.meta_connection_account_bindings b
   JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
   WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED')>4194304 THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('bindingId',b.id,'bindingRevision',b.revision,'connectionId',b.connection_id,
   'providerSessionId',b.provider_session_id,'phoneNumberId',b.phone_number_id,'appId',b.app_id,
   'secretReference',b.secret_reference,'credentialFingerprint',b.credential_fingerprint,'proofSha256',b.proof_sha256,
    'canonicalProofSha256',app.meta_account_proof_sha256(s.provider_state_data->'metaAccountProof'),
    'sessionProofSha256',encode(public.digest((s.provider_state_data->'metaAccountProof')::text,'sha256'),'hex'),
   'bindingState',b.state,'connectionState',c.state,'currentSecretReference',c.secret_reference,
   'ownershipState',s.ownership_state,'sessionState',s.state,'providerStateData',s.provider_state_data)
   ORDER BY b.id),'[]'::jsonb) INTO scope_value
   FROM (SELECT * FROM public.meta_connection_account_bindings WHERE tenant_id=tenant_value
     AND account_id=account_row.id AND state<>'RETIRED' ORDER BY id LIMIT 2001) b
   JOIN public.connections c ON c.tenant_id=b.tenant_id AND c.id=b.connection_id
   JOIN public.provider_sessions s ON s.tenant_id=b.tenant_id AND s.id=b.provider_session_id
   WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED';
 -- Both selected assignments and older conversation-pinned immutable versions
 -- affect a future transition. The preview merely observes them.
 SELECT COALESCE(array_agg(f.id),'{}'::uuid[]) INTO flow_ids FROM (SELECT f.id FROM public.bot_flow_versions f WHERE f.tenant_id=tenant_value AND f.id IN (
   SELECT a.flow_version_id FROM public.bot_assignments a JOIN public.meta_connection_account_bindings b
     ON b.tenant_id=a.tenant_id AND b.connection_id=a.connection_id WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED'
   UNION SELECT c.flow_version_id FROM public.bot_conversations c JOIN public.meta_connection_account_bindings b
     ON b.tenant_id=c.tenant_id AND b.connection_id=c.connection_id WHERE b.tenant_id=tenant_value AND b.account_id=account_row.id AND b.state<>'RETIRED')
   ORDER BY f.id LIMIT 2001) f;
 IF cardinality(flow_ids)>2000 THEN RETURN NULL; END IF;
 IF (SELECT COALESCE(sum(octet_length(definition::text)),0) FROM public.bot_flow_versions
   WHERE tenant_id=tenant_value AND id=ANY(flow_ids))>4194304 THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',f.id,'snapshotSha256',f.snapshot_sha256,'definition',f.definition)
   ORDER BY f.id),'[]'::jsonb) INTO flow_value FROM public.bot_flow_versions f WHERE f.tenant_id=tenant_value AND f.id=ANY(flow_ids);
 SELECT mode INTO mode_value FROM public.meta_billing_policy_versions WHERE tenant_id=tenant_value AND id=account_row.active_policy_version_id;
 RETURN jsonb_build_object('tenantId',tenant_value,'connectionId',connection_value,'actorId',actor_value,
   'accountId',account_row.id,'providerAccountId',account_row.provider_account_id,'accountRevision',account_row.authority_revision,
   'bindingId',binding_row.id,'bindingRevision',binding_row.revision,'declaredMode',COALESCE(mode_value,'UNSELECTED'),
   'secretReference',connection_row.secret_reference,'session',jsonb_build_object('id',session_row.id,
     'opaqueSessionId',session_row.opaque_session_id,'providerStateData',session_row.provider_state_data),
   'bindingProofSha256',binding_row.proof_sha256,
    'canonicalProofSha256',app.meta_account_proof_sha256(session_row.provider_state_data->'metaAccountProof'),
    'sessionProofSha256',encode(public.digest((session_row.provider_state_data->'metaAccountProof')::text,'sha256'),'hex'),
    'credentialFingerprint',binding_row.credential_fingerprint,
   'scope',scope_value,'flows',flow_value);
END $$;

CREATE OR REPLACE FUNCTION app.operator_queue_meta_funding_attachment(arrangement_value uuid,expected_authority bigint,key_value text,operator_value text,request_value text)
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
  'proofSha256',app.meta_account_proof_sha256(session.provider_state_data->'metaAccountProof'),'appId',binding.app_id,'lifecycleRevision',CASE WHEN session.provider_state_data ? 'metaLifecycle' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE 0 END),
  'metaAccountPolicy',jsonb_build_object('accountId',account.id,'bindingId',binding.id,'bindingRevision',binding.revision,'authorityRevision',account.authority_revision,
   'policyVersionId',policy.id,'observationOperationId',account.last_observation_operation_id),
  'metaManagedFunding',jsonb_build_object('schemaVersion',1,'ownerKind','FUNDING_ATTACHMENT','ownerId',operation_value,
  'stage','ATTACH','accountId',account.id,'arrangementVersionId',arrangement.id,'authorityRevision',account.authority_revision,
  'policyVersionId',policy.id,'bindingId',binding.id,'bindingRevision',binding.revision,'appId',arrangement.app_id,'currency',arrangement.requested_currency));
 INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,max_attempts,requested_by_type,requested_by_id,request_id)
 VALUES(operation_value,account.tenant_id,binding.connection_id,'VERIFY_META_BILLING','meta-funding:'||key_value,payload_value,'QUEUED',1,'SYSTEM',operator_value,request_value);
 RETURN jsonb_build_object('operationId',operation_value,'state','QUEUED','replay',false);
END;$$;

CREATE OR REPLACE FUNCTION app.operator_queue_meta_funding_readback(checkpoint_value uuid,expected_authority bigint,key_value text,operator_value text,request_value text)
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
  'proofSha256',app.meta_account_proof_sha256(session.provider_state_data->'metaAccountProof'),'appId',binding.app_id,'lifecycleRevision',CASE WHEN session.provider_state_data ? 'metaLifecycle' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE 0 END),
  'metaAccountPolicy',jsonb_build_object('accountId',account.id,'bindingId',binding.id,'bindingRevision',binding.revision,'authorityRevision',account.authority_revision,
   'policyVersionId',policy.id,'observationOperationId',account.last_observation_operation_id),
  'metaManagedFunding',jsonb_build_object('schemaVersion',1,'ownerKind','FUNDING_ATTACHMENT','ownerId',checkpoint.owner_id,'checkpointId',checkpoint.id,
  'stage','RECONCILE','accountId',account.id,'arrangementVersionId',arrangement.id,'authorityRevision',account.authority_revision,
  'policyVersionId',policy.id,'bindingId',binding.id,'bindingRevision',binding.revision,'appId',arrangement.app_id,'currency',arrangement.requested_currency));
 INSERT INTO connection_operations(id,tenant_id,connection_id,operation_type,idempotency_key,payload,state,max_attempts,requested_by_type,requested_by_id,request_id)
 VALUES(operation_value,account.tenant_id,binding.connection_id,'VERIFY_META_BILLING','meta-funding-readback:'||key_value,payload_value,'QUEUED',1,'SYSTEM',operator_value,request_value);
 RETURN jsonb_build_object('operationId',operation_value,'state','QUEUED','replay',false);
END;$$;

-- The sealed executor can check activation without exposing its helper to callers.
ALTER FUNCTION app.guard_meta_successor_activation() SECURITY DEFINER;
ALTER FUNCTION app.guard_meta_successor_activation() OWNER TO wasalx_meta_transition_executor;
ALTER FUNCTION app.guard_meta_successor_activation() SET row_security=on;

-- Keep the scheduler's column fence; expose only the existing sealed lineage verdict.
CREATE FUNCTION app.meta_account_alias_has_valid_successor(alias_value uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM public.meta_direct_identity_aliases successor
  WHERE successor.tenant_id=app.current_tenant_id() AND successor.predecessor_alias_id=alias_value
   AND app.meta_account_alias_lineage_valid(successor.id));
$$;
ALTER FUNCTION app.meta_account_alias_has_valid_successor(uuid) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.meta_account_alias_has_valid_successor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_account_alias_has_valid_successor(uuid)
 TO wasalx_app,wasalx_connector_worker,wasalx_scheduler_reader,wasalx_meta_transition_executor;

-- Successor migration: preserves the published 0179 bytes and receipt truth.
CREATE OR REPLACE FUNCTION app.meta_direct_transition_receipt_valid(event_value uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;receipt jsonb;applied event_inbox%ROWTYPE;item jsonb;anchor_id uuid;participant_id uuid;asset jsonb;successor_alias record;consuming_candidate record;successor_valid boolean;
BEGIN
 SELECT id,tenant_id,connection_id,provider,status,payload_sha256,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_direct_identity_resolution,lease_id,lease_expires_at,safe_error INTO source.id,source.tenant_id,source.connection_id,source.provider,source.status,source.payload_sha256,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.lease_id,source.lease_expires_at,source.safe_error FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 receipt:=source.meta_direct_identity_resolution;
 IF NOT FOUND OR source.provider<>'META' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR source.meta_direct_identity_transition IS NULL
  OR source.meta_direct_identity_transition->'redacted'='true' OR source.meta_direct_identity_change->'redacted'='true'
  OR receipt->'schemaVersion' IS DISTINCT FROM '1' OR COALESCE(receipt->>'state','') NOT IN('APPLIED','DUPLICATE')
  OR receipt->>'evidenceSha256' IS DISTINCT FROM encode(digest(source.meta_direct_identity_transition::text,'sha256'),'hex')
  OR source.meta_direct_identity_transition->>'payloadSha256' IS DISTINCT FROM source.payload_sha256
  OR COALESCE(receipt->>'participantId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'anchorEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'appliedEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'nativeCustomerId','')!~'^[1-9][0-9]{0,15}$'
  OR jsonb_typeof(receipt->'predecessorAliases') IS DISTINCT FROM 'array' OR jsonb_typeof(receipt->'successorAliases') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 asset:=app.meta_direct_transition_asset(source.id);
 IF asset IS NULL THEN RETURN false; END IF;
 participant_id:=(receipt->>'participantId')::uuid;anchor_id:=(receipt->>'anchorEventId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM participant_identities p WHERE p.tenant_id=source.tenant_id AND p.connection_id=source.connection_id
  AND p.id=participant_id AND p.external_participant_id=receipt->>'canonical') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM event_inbox anchor LEFT JOIN normalized_messages message ON message.tenant_id=anchor.tenant_id AND message.event_inbox_id=anchor.id
  WHERE anchor.tenant_id=source.tenant_id AND anchor.connection_id=source.connection_id AND anchor.id=anchor_id
   AND app.meta_account_identity_asset_ancestor(source.connection_id,anchor.meta_direct_asset,asset) AND anchor.meta_direct_identity_change IS NULL AND anchor.status IN('PROCESSED','REDACTED')
   AND app.meta_direct_transition_anchor_valid(anchor.id,participant_id,receipt->>'nativeCustomerId',false)) THEN RETURN false; END IF;
 IF source.status<>'PROCESSED' OR receipt-ARRAY['schemaVersion','state','evidenceSha256','participantId','canonical','nativeCustomerId','anchorEventId','predecessorAliases','successorAliases','appliedEventId','accountTransitionId','targetAsset']<>'{}' THEN RETURN false; END IF;
 IF receipt->>'state'='DUPLICATE' THEN
  SELECT id,tenant_id,connection_id,meta_direct_identity_transition,meta_direct_identity_resolution INTO applied.id,applied.tenant_id,applied.connection_id,applied.meta_direct_identity_transition,applied.meta_direct_identity_resolution FROM event_inbox WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=(receipt->>'appliedEventId')::uuid;
  IF NOT FOUND OR applied.id=source.id OR applied.meta_direct_identity_resolution->>'state'<>'APPLIED'
   OR app.meta_direct_transition_edge(applied.meta_direct_identity_transition) IS DISTINCT FROM app.meta_direct_transition_edge(source.meta_direct_identity_transition)
   OR (receipt-ARRAY['state','evidenceSha256']) IS DISTINCT FROM (applied.meta_direct_identity_resolution-ARRAY['state','evidenceSha256'])
   OR NOT app.meta_direct_transition_receipt_valid(applied.id) THEN RETURN false; END IF;
  RETURN true;
 END IF;
 IF receipt->>'appliedEventId'<>source.id::text OR jsonb_array_length(receipt->'successorAliases') NOT BETWEEN 1 AND 2
  OR jsonb_array_length(receipt->'predecessorAliases')>2 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements((receipt->'predecessorAliases')||(receipt->'successorAliases')) LOOP
  IF COALESCE(item->>'id','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' OR jsonb_typeof(item->'revision') IS DISTINCT FROM 'number'
   OR (item->>'revision')!~'^[1-9][0-9]{0,15}$' OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
    WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.participant_identity_id=participant_id
     AND alias.id=(item->>'id')::uuid AND alias.revision>=(item->>'revision')::bigint
     AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=asset) THEN RETURN false; END IF;
 END LOOP;
 -- Successor slots bind the actual signed current identifiers. A later HELD
 -- marker or sealed consuming edge can advance its revision, but arbitrary
 -- older-revision equality is never accepted as current alias authority.
 FOR item IN SELECT value FROM jsonb_array_elements(receipt->'successorAliases') LOOP
  successor_valid:=false;
  FOR successor_alias IN SELECT alias.id,alias.tenant_id,alias.revision,alias.state FROM meta_direct_identity_aliases alias
   WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
    AND alias.id::text=item->>'id' AND alias.participant_identity_id=participant_id
    AND alias.value=CASE alias.kind WHEN 'PHONE' THEN source.meta_direct_identity_transition#>>'{change,current,phone}'
      ELSE source.meta_direct_identity_transition#>>'{change,current,bsuid}' END LOOP
   IF successor_alias.revision=(item->>'revision')::bigint
    OR(successor_alias.state='HELD' AND successor_alias.revision=(item->>'revision')::bigint+1) THEN
    successor_valid:=true;
   ELSIF successor_alias.state='RETIRED' AND successor_alias.revision>(item->>'revision')::bigint
    AND app.meta_account_alias_has_valid_successor(successor_alias.id) THEN
    successor_valid:=true;
   ELSE
    -- SQL AND does not impose evaluation order. Only an exact consuming slot
    -- may invoke the sealed asset/bridge validator; retain every original fence.
    FOR consuming_candidate IN SELECT consuming.id FROM event_inbox consuming
     WHERE consuming.tenant_id=source.tenant_id AND consuming.connection_id=source.connection_id
      AND consuming.status='PROCESSED' AND consuming.meta_direct_identity_resolution->>'state'='APPLIED'
      AND consuming.meta_direct_identity_resolution->>'participantId'=participant_id::text
      AND consuming.meta_direct_identity_resolution->>'anchorEventId'=anchor_id::text
      AND consuming.meta_direct_identity_resolution->>'evidenceSha256'=encode(digest(consuming.meta_direct_identity_transition::text,'sha256'),'hex')
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(consuming.meta_direct_identity_resolution->'predecessorAliases') slot
       WHERE slot->>'id'=successor_alias.id::text AND (slot->>'revision')::bigint IN((item->>'revision')::bigint,(item->>'revision')::bigint+1)
        AND successor_alias.revision>=(slot->>'revision')::bigint+1) LOOP
     IF app.meta_direct_transition_asset(consuming_candidate.id)=asset THEN
      successor_valid:=true;EXIT;
     END IF;
    END LOOP;
   END IF;
   EXIT WHEN successor_valid;
  END LOOP;
  IF NOT successor_valid THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

-- Only signed identity safety markers may request this paused-route lookup.
-- Ordinary webhook lookup and dispatch remain ACTIVE-only.
CREATE FUNCTION app.resolve_meta_identity_webhook_route(route_external_key text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, provider text, hmac_secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT r.tenant_id,r.connection_id,r.provider,r.hmac_secret_reference
 FROM public.webhook_routes r
 WHERE r.provider='META' AND r.external_key=route_external_key AND r.state='PAUSED'
 LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.resolve_meta_identity_webhook_route(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_meta_identity_webhook_route(text) TO wasalx_app;


-- Retained definer owners need the new pure helpers; do not assume a deployment role.
DO $$
DECLARE owner_name text;
BEGIN
 FOR owner_name IN SELECT DISTINCT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=ANY(ARRAY[
  'app.operator_queue_meta_funding_attachment(uuid,bigint,text,text,text)'::regprocedure,
  'app.operator_queue_meta_funding_readback(uuid,bigint,text,text,text)'::regprocedure]) LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION app.meta_account_proof_canonical_json(jsonb,integer),app.meta_account_proof_sha256(jsonb) TO %I',owner_name);
 END LOOP;
END $$;

COMMIT;
