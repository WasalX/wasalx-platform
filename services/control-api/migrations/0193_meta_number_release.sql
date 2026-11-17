BEGIN;

-- Revocation continues to reserve a number. Only the explicit, audited release
-- below ends that reservation; historical keys and routes are never reassigned.
ALTER TABLE public.webhook_routes ADD COLUMN reservation_release_id uuid;
ALTER TABLE public.webhook_routes ADD CONSTRAINT webhook_routes_tenant_id_id_key UNIQUE(tenant_id,id);
CREATE TABLE public.meta_number_releases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL,
 route_id uuid NOT NULL UNIQUE,
 disconnect_operation_id uuid NOT NULL,
 phone_number_id text NOT NULL CHECK(phone_number_id ~ '^[0-9]{5,32}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 actor_id uuid NOT NULL REFERENCES public.users(id),
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 255),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES public.connections(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,route_id) REFERENCES public.webhook_routes(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,disconnect_operation_id) REFERENCES public.connection_operations(tenant_id,id),
 UNIQUE(tenant_id,idempotency_key), UNIQUE(tenant_id,connection_id)
);
CREATE INDEX meta_number_releases_phone_idx ON public.meta_number_releases(phone_number_id);
ALTER TABLE public.meta_number_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_number_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.meta_number_releases
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE TRIGGER tenant_actor_membership_guard BEFORE INSERT OR UPDATE OF tenant_id,actor_id ON public.meta_number_releases
 FOR EACH ROW EXECUTE FUNCTION app.enforce_bot_action_actor_membership('actor_id');
-- The sealed write trigger joins exact tenant/route release evidence; no reverse FK cycle.
ALTER TABLE public.webhook_routes ADD CONSTRAINT webhook_routes_release_state
 CHECK(reservation_release_id IS NULL OR(provider='META' AND state='REVOKED'));
ALTER TABLE public.webhook_routes DROP CONSTRAINT webhook_routes_provider_external_key_key;
-- Keep the index name: PostgreSQL reports it as the constraint in the existing
-- safe META_SIGNUP_ASSET_CONFLICT classifier, including concurrent claims.
CREATE UNIQUE INDEX webhook_routes_provider_external_key_key
 ON public.webhook_routes(provider,external_key) WHERE reservation_release_id IS NULL;
REVOKE ALL ON public.meta_number_releases FROM PUBLIC,wasalx_app,wasalx_connector_worker;
GRANT SELECT ON public.meta_number_releases TO wasalx_app;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='wasalx_meta_number_release_executor') THEN
  CREATE ROLE wasalx_meta_number_release_executor NOLOGIN;
 END IF;
END $$;
ALTER ROLE wasalx_meta_number_release_executor NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public,app TO wasalx_meta_number_release_executor;
GRANT SELECT ON public.connections,public.webhook_routes,public.provider_sessions,
 public.connection_operations,public.event_inbox,
 public.meta_number_releases,public.meta_connection_account_bindings,public.privacy_jobs TO wasalx_meta_number_release_executor;
GRANT INSERT ON public.meta_number_releases,public.audit_events TO wasalx_meta_number_release_executor;
GRANT UPDATE(state,revision,updated_at) ON public.meta_connection_account_bindings TO wasalx_meta_number_release_executor;
GRANT UPDATE(reservation_release_id) ON public.webhook_routes TO wasalx_meta_number_release_executor;
-- Locking the connection requires a narrow UPDATE privilege; the function never changes it.
GRANT UPDATE(updated_at) ON public.connections TO wasalx_meta_number_release_executor;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.meta_transition_actor_current(uuid),
 app.assert_meta_connection_account_unreserved(uuid),app.assert_meta_account_unreserved(uuid)
 TO wasalx_meta_number_release_executor;

CREATE FUNCTION app.guard_meta_number_release() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.reservation_release_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.tenants WHERE id=OLD.tenant_id) THEN
   RAISE EXCEPTION 'Released route history is immutable' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' AND NEW.reservation_release_id IS NOT NULL THEN
  RAISE EXCEPTION 'A new route cannot inherit a release' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.reservation_release_id IS NOT NULL AND
   (NEW.reservation_release_id IS DISTINCT FROM OLD.reservation_release_id OR NEW.state<>OLD.state
    OR NEW.tenant_id<>OLD.tenant_id OR NEW.connection_id<>OLD.connection_id
    OR NEW.provider<>OLD.provider OR NEW.external_key IS DISTINCT FROM OLD.external_key
    OR NEW.hmac_secret_reference<>OLD.hmac_secret_reference) THEN
   RAISE EXCEPTION 'Released route history is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.reservation_release_id IS DISTINCT FROM OLD.reservation_release_id THEN
   IF current_user<>'wasalx_meta_number_release_executor' OR OLD.reservation_release_id IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.meta_number_releases x WHERE x.id=NEW.reservation_release_id
     AND x.tenant_id=NEW.tenant_id AND x.connection_id=NEW.connection_id AND x.route_id=NEW.id
     AND x.phone_number_id=NEW.external_key) THEN
    RAISE EXCEPTION 'Explicit number release is required' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_number_release_write BEFORE INSERT OR UPDATE OR DELETE ON public.webhook_routes
 FOR EACH ROW EXECUTE FUNCTION app.guard_meta_number_release();
GRANT SELECT ON public.meta_number_releases TO wasalx_connector_worker;
-- The trigger must see release evidence when a connector updates other routes;
-- RLS still limits every read to the active tenant.

CREATE FUNCTION app.meta_number_effects_clear(connection_value uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.connections c WHERE c.tenant_id=app.current_tenant_id() AND c.id=connection_value)
 AND NOT EXISTS(SELECT 1 FROM public.bot_conversations c WHERE c.tenant_id=app.current_tenant_id()
  AND c.connection_id=connection_value AND(
   EXISTS(SELECT 1 FROM public.bot_action_jobs j WHERE j.tenant_id=c.tenant_id AND j.conversation_id=c.id
    AND(j.lease_id IS NOT NULL OR j.state NOT IN('SUCCEEDED','FAILED_TERMINAL')))
   OR EXISTS(SELECT 1 FROM public.bot_handoff_jobs j WHERE j.tenant_id=c.tenant_id AND j.conversation_id=c.id
    AND(j.lease_id IS NOT NULL OR j.state NOT IN('SUCCEEDED','FAILED_TERMINAL')))
   OR EXISTS(SELECT 1 FROM public.direct_native_reply_intents j WHERE j.tenant_id=c.tenant_id AND j.conversation_id=c.id AND j.state IN('PENDING','OUTCOME_UNKNOWN'))
   OR EXISTS(SELECT 1 FROM public.direct_customer_close_commands j WHERE j.tenant_id=c.tenant_id AND j.conversation_id=c.id
    AND(j.state IN('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN') OR(j.state='SUCCEEDED' AND c.state IN('BOT','HUMAN') AND c.fencing_token=j.conversation_fencing_token)))
   OR EXISTS(SELECT 1 FROM public.zammad_conversation_state_outbox j WHERE j.tenant_id=c.tenant_id AND j.conversation_id=c.id
    AND(j.completed_at IS NULL OR j.lease_id IS NOT NULL))))
 AND NOT EXISTS(SELECT 1 FROM public.meta_provider_effect_checkpoints e JOIN public.connection_operations o
  ON o.tenant_id=e.tenant_id AND o.id=e.original_operation_id
  WHERE o.tenant_id=app.current_tenant_id() AND o.connection_id=connection_value AND e.outcome IN('ATTEMPTED','UNKNOWN'))
 AND NOT EXISTS(SELECT 1 FROM public.group_action_executions x JOIN public.event_inbox e
  ON e.tenant_id=x.tenant_id AND e.id=x.event_inbox_id
  WHERE e.tenant_id=app.current_tenant_id() AND e.connection_id=connection_value
   AND x.state IN('PREPARED','RUNNING','FAILED_RETRYABLE','OUTCOME_UNKNOWN'))
 AND NOT EXISTS(SELECT 1 FROM public.ticket_event_executions x JOIN public.case_correlations c
  ON c.tenant_id=x.tenant_id AND c.id=x.correlation_id JOIN public.group_bindings b
  ON b.tenant_id=c.tenant_id AND b.id=c.group_binding_id JOIN public.whatsapp_groups g
  ON g.tenant_id=b.tenant_id AND g.id=b.whatsapp_group_id
  WHERE g.tenant_id=app.current_tenant_id() AND g.connection_id=connection_value
   AND(x.state='PENDING' OR x.native_action_state IN('PREPARED','ATTEMPTED','OUTCOME_UNKNOWN')))
 AND NOT EXISTS(SELECT 1 FROM public.zammad_status_outbox s JOIN public.delivery_outbox d
  ON d.tenant_id=s.tenant_id AND d.id=s.delivery_id
  WHERE d.tenant_id=app.current_tenant_id() AND d.connection_id=connection_value
   AND(s.completed_at IS NULL OR s.lease_id IS NOT NULL))
 AND NOT EXISTS(SELECT 1 FROM public.delivery_outbox d WHERE d.tenant_id=app.current_tenant_id()
  AND d.connection_id=connection_value AND(d.lease_id IS NOT NULL
   OR d.state IN('CLAIMED','SENDING','FAILED_RETRYABLE')
   OR(d.state IN('OUTCOME_UNKNOWN','BLOCKED') AND NOT app.delivery_no_further_attempts(d.tenant_id,d.id))
   OR(d.state='QUEUED' AND(d.attempts<>0 OR EXISTS(SELECT 1 FROM public.delivery_attempts a WHERE a.tenant_id=d.tenant_id AND a.delivery_id=d.id)))
   OR(d.state='FAILED_TERMINAL' AND d.manual_retry_allowed)))
$$;
REVOKE ALL ON FUNCTION app.meta_number_effects_clear(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_number_effects_clear(uuid) TO wasalx_meta_number_release_executor;

CREATE OR REPLACE FUNCTION app.guard_meta_account_policy_state() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 -- Number release retires only this phone binding; WABA ownership and payment policy stay intact.
 IF TG_TABLE_NAME='meta_connection_account_bindings' AND TG_OP='UPDATE' THEN
 -- Other executors must not plan a query against private release history.
 IF current_user='wasalx_meta_number_release_executor' THEN
 IF OLD.state IN('ACTIVE','HELD')
  AND NEW.state='RETIRED' AND NEW.revision=OLD.revision+1
  AND(to_jsonb(NEW)-ARRAY['state','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['state','revision','updated_at'])
  AND EXISTS(SELECT 1 FROM public.meta_number_releases x JOIN public.webhook_routes r
   ON r.tenant_id=x.tenant_id AND r.id=x.route_id AND r.reservation_release_id=x.id
   JOIN public.connections c ON c.tenant_id=x.tenant_id AND c.id=x.connection_id
   WHERE x.tenant_id=OLD.tenant_id AND x.connection_id=OLD.connection_id AND x.phone_number_id=OLD.phone_number_id
    AND c.state='REVOKED' AND r.state='REVOKED' AND r.provider='META' AND r.external_key=OLD.phone_number_id)
 THEN RETURN NEW; END IF;
 END IF;
 END IF;
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

CREATE FUNCTION app.release_meta_number(connection_value uuid,route_value uuid,disconnect_value uuid,
 phone_value text,key_value text,actor_value uuid,request_value text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE tenant_value uuid:=app.current_tenant_id(); c public.connections; r public.webhook_routes;
 prior public.meta_number_releases; release_value uuid:=gen_random_uuid();
BEGIN
 IF phone_value IS NULL OR phone_value !~ '^[0-9]{5,32}$' OR key_value IS NULL
  OR length(key_value) NOT BETWEEN 1 AND 128 OR key_value~'[[:cntrl:]]'
  OR request_value IS NULL OR length(request_value) NOT BETWEEN 1 AND 255 THEN
  RAISE EXCEPTION 'Invalid number release request' USING ERRCODE='22023'; END IF;
 PERFORM app.meta_transition_actor_current(actor_value);
 PERFORM pg_advisory_xact_lock(hashtextextended('meta-signup-phone:'||phone_value,0));
 SELECT * INTO prior FROM public.meta_number_releases WHERE tenant_id=tenant_value AND idempotency_key=key_value;
 IF FOUND THEN
  IF prior.connection_id<>connection_value OR prior.route_id<>route_value
   OR prior.disconnect_operation_id<>disconnect_value OR prior.phone_number_id<>phone_value THEN
   RAISE EXCEPTION 'Number release request changed' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('id',prior.id,'released',true,'duplicate',true,'reconnectRequiresNewConnection',true);
 END IF;
 SELECT * INTO c FROM public.connections WHERE tenant_id=tenant_value AND id=connection_value FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Connection not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO r FROM public.webhook_routes WHERE tenant_id=tenant_value AND connection_id=c.id AND id=route_value FOR UPDATE;
 IF NOT FOUND OR c.provider<>'META' OR c.engine IS DISTINCT FROM 'CLOUD_API' OR c.state<>'REVOKED'
  OR r.provider<>'META' OR r.state<>'REVOKED' OR r.external_key IS DISTINCT FROM phone_value OR r.reservation_release_id IS NOT NULL THEN
  RAISE EXCEPTION 'The disconnected number binding changed' USING ERRCODE='55000'; END IF;
 PERFORM app.assert_meta_connection_account_unreserved(c.id);
 IF NOT EXISTS(SELECT 1 FROM public.connection_operations o JOIN public.provider_sessions p
  ON p.tenant_id=o.tenant_id AND p.connection_id=o.connection_id
  WHERE o.tenant_id=tenant_value AND o.connection_id=c.id AND o.id=disconnect_value
   AND o.operation_type='DISCONNECT' AND o.state='SUCCEEDED'
   AND p.opaque_session_id=phone_value AND p.state='REVOKED' AND p.ownership_state='RETIRED'
   AND p.retired_at>=o.started_at AND p.retired_at<=o.completed_at)
  OR (SELECT count(*) FROM public.webhook_routes x WHERE x.tenant_id=tenant_value AND x.connection_id=c.id
   AND x.provider='META' AND x.reservation_release_id IS NULL)<>1
  OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.tenant_id=tenant_value AND o.connection_id=c.id
   AND(o.state IN('STAGED','QUEUED','RUNNING','FAILED_RETRYABLE') OR o.error_code LIKE '%UNKNOWN%'))
  OR EXISTS(SELECT 1 FROM public.provider_sessions p WHERE p.tenant_id=tenant_value AND p.connection_id=c.id
   AND(p.ownership_state<>'RETIRED' OR p.worker_id IS NOT NULL OR p.lease_expires_at IS NOT NULL))
  OR EXISTS(SELECT 1 FROM public.event_inbox e WHERE e.tenant_id=tenant_value AND e.connection_id=c.id
   AND e.lease_id IS NOT NULL)
  OR NOT app.meta_number_effects_clear(c.id) THEN
  RAISE EXCEPTION 'Number effects have not settled' USING ERRCODE='55000'; END IF;
 INSERT INTO public.meta_number_releases(id,tenant_id,connection_id,route_id,disconnect_operation_id,
  phone_number_id,idempotency_key,actor_id,request_id)
 VALUES(release_value,tenant_value,c.id,r.id,disconnect_value,phone_value,key_value,actor_value,request_value);
 UPDATE public.webhook_routes SET reservation_release_id=release_value WHERE id=r.id AND tenant_id=tenant_value;
 UPDATE public.meta_connection_account_bindings SET state='RETIRED',revision=revision+1,updated_at=clock_timestamp()
  WHERE tenant_id=tenant_value AND connection_id=c.id AND state IN('ACTIVE','HELD');
 INSERT INTO public.audit_events(tenant_id,actor_type,actor_id,action,target_type,target_id,previous_value,new_value,request_id)
 VALUES(tenant_value,'USER',actor_value::text,'connection.meta_number_released','connection',c.id::text,
  jsonb_build_object('routeId',r.id,'state',r.state),
  jsonb_build_object('releaseId',release_value,'disconnectOperationId',disconnect_value,'reconnectRequiresNewConnection',true),request_value);
 RETURN jsonb_build_object('id',release_value,'released',true,'duplicate',false,'reconnectRequiresNewConnection',true);
END $$;
ALTER FUNCTION app.release_meta_number(uuid,uuid,uuid,text,text,uuid,text) OWNER TO wasalx_meta_number_release_executor;
REVOKE ALL ON FUNCTION app.release_meta_number(uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_meta_number(uuid,uuid,uuid,text,text,uuid,text) TO wasalx_app;

-- A release is permanent for the historical connection/session. Recovery uses
-- normal fresh provisioning with a new credential reference, never an old
-- reference that a previously claimed cleanup operation can still delete.
CREATE FUNCTION app.guard_released_meta_connection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.tenants WHERE id=OLD.tenant_id) AND EXISTS(SELECT 1 FROM public.webhook_routes r
   WHERE r.tenant_id=OLD.tenant_id AND r.connection_id=OLD.id AND r.reservation_release_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Released connection history is immutable' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF EXISTS(SELECT 1 FROM public.webhook_routes r WHERE r.tenant_id=OLD.tenant_id
  AND r.connection_id=OLD.id AND r.reservation_release_id IS NOT NULL)
  AND(NEW.state<>OLD.state OR NEW.secret_reference<>OLD.secret_reference
   OR NEW.tenant_id<>OLD.tenant_id OR NEW.provider<>OLD.provider OR NEW.engine IS DISTINCT FROM OLD.engine) THEN
  RAISE EXCEPTION 'Reconnect a released number as a new connection' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_released_connection_write BEFORE UPDATE OR DELETE ON public.connections
 FOR EACH ROW EXECUTE FUNCTION app.guard_released_meta_connection();

CREATE FUNCTION app.guard_released_meta_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE tenant_value uuid; connection_value uuid;
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.webhook_routes r
  WHERE r.tenant_id=OLD.tenant_id AND r.connection_id=OLD.connection_id AND r.reservation_release_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Released session history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN tenant_value:=OLD.tenant_id;connection_value:=OLD.connection_id;
 ELSE tenant_value:=NEW.tenant_id;connection_value:=NEW.connection_id; END IF;
 IF EXISTS(SELECT 1 FROM public.webhook_routes r WHERE r.tenant_id=tenant_value
  AND r.connection_id=connection_value AND r.reservation_release_id IS NOT NULL)
  AND EXISTS(SELECT 1 FROM public.tenants WHERE id=tenant_value) THEN
  RAISE EXCEPTION 'Released session history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER meta_released_session_write BEFORE INSERT OR UPDATE OR DELETE ON public.provider_sessions
 FOR EACH ROW EXECUTE FUNCTION app.guard_released_meta_session();

-- A repeated phone has no provider connection-generation identifier. Require real
-- provider time after its fresh admission floor; receipt-time fallbacks cannot qualify.
CREATE FUNCTION app.meta_number_event_current(connection_value uuid,observed_value timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.webhook_routes r WHERE r.tenant_id=app.current_tenant_id()
  AND r.connection_id=connection_value AND r.provider='META' AND r.reservation_release_id IS NULL
  AND(NOT EXISTS(SELECT 1 FROM public.meta_number_releases x WHERE x.phone_number_id=r.external_key)
   OR(observed_value IS NOT NULL AND isfinite(observed_value) AND observed_value>=GREATEST(r.admission_opened_at,r.created_at))))
$$;
REVOKE ALL ON FUNCTION app.meta_number_event_current(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_number_event_current(uuid,timestamptz) TO wasalx_app;

CREATE OR REPLACE FUNCTION app.resolve_meta_webhook_route(route_external_key text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, provider text, hmac_secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.tenant_id, r.connection_id, r.provider, r.hmac_secret_reference
    FROM webhook_routes r
   WHERE r.provider = 'META'
     AND r.external_key = route_external_key
     AND r.state = 'ACTIVE' AND r.reservation_release_id IS NULL
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app.resolve_meta_lifecycle_routes(
  target_waba_id text,
  expected_app_id text
)
RETURNS TABLE (
  tenant_id uuid,
  connection_id uuid,
  provider text,
  hmac_secret_reference text,
  route_state text,
  provider_session_id uuid,
  session_ownership_state text,
  phone_number_id text,
  waba_id text,
  display_phone_number text,
  app_id text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH ranked AS (
    SELECT route.tenant_id,route.connection_id,route.provider,route.hmac_secret_reference,
           route.state AS route_state,route.external_key,connection.state AS connection_state,
           session.id AS provider_session_id,session.ownership_state AS session_ownership_state,
           session.opaque_session_id AS phone_number_id,session.provider_state_data,
           proof.value->>'wabaId' AS waba_id,
           proof.value->>'displayPhoneNumber' AS display_phone_number,
           expected_app_id AS app_id,
           dense_rank() OVER (
             PARTITION BY route.tenant_id,route.connection_id
             ORDER BY CASE session.ownership_state WHEN 'ACTIVE' THEN 0 ELSE 1 END,
                      session.created_at DESC
           ) AS generation_rank
      FROM webhook_routes route
      JOIN connections connection
        ON connection.tenant_id=route.tenant_id AND connection.id=route.connection_id
      JOIN provider_sessions session
        ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id
      CROSS JOIN LATERAL (SELECT session.provider_state_data->'metaAccountProof' AS value) proof
     WHERE route.reservation_release_id IS NULL AND route.provider='META' AND connection.provider='META' AND connection.engine='CLOUD_API'
       AND route.state IN ('ACTIVE','PAUSED','REVOKED')
       AND session.ownership_state IN ('ACTIVE','RETIRED')
       AND (
         (connection.state NOT IN ('PAUSED','REVOKED') AND route.state='ACTIVE')
         OR (connection.state='PAUSED' AND route.state='PAUSED')
         OR (connection.state='REVOKED' AND route.state='REVOKED')
       )
  ), candidates AS (
    SELECT ranked.*,
           count(*) FILTER (WHERE ranked.generation_rank=1) OVER (
             PARTITION BY ranked.tenant_id,ranked.connection_id
           ) AS generation_peer_count
      FROM ranked
  )
  SELECT candidate.tenant_id,candidate.connection_id,candidate.provider,
         candidate.hmac_secret_reference,candidate.route_state,candidate.provider_session_id,
         candidate.session_ownership_state,candidate.phone_number_id,candidate.waba_id,
         candidate.display_phone_number,candidate.app_id
    FROM candidates candidate
   WHERE candidate.generation_rank=1
     AND candidate.generation_peer_count=1
     AND jsonb_typeof(candidate.provider_state_data->'metaAccountProof')='object'
     AND candidate.provider_state_data->'metaAccountProof'->>'claim'='PHONE_ACCOUNT_RELATION_VERIFIED'
     AND candidate.provider_state_data->'metaAccountProof'->>'tenantId'=candidate.tenant_id::text
     AND candidate.provider_state_data->'metaAccountProof'->>'connectionId'=candidate.connection_id::text
     AND candidate.provider_state_data->'metaAccountProof'->>'providerSessionId'=candidate.provider_session_id::text
     AND candidate.provider_state_data->'metaAccountProof'->>'phoneNumberId'=candidate.phone_number_id
     AND candidate.provider_state_data->'metaAccountProof'->>'wabaId'~'^[0-9]{5,32}$'
     AND candidate.provider_state_data->'metaAccountProof'->>'wabaId'=candidate.provider_state_data->>'wabaId'
     AND candidate.external_key=candidate.phone_number_id
     AND candidate.waba_id=target_waba_id
     AND (NOT (candidate.provider_state_data->'metaAccountProof' ? 'credentialMetadata')
          OR (
            jsonb_typeof(candidate.provider_state_data->'metaAccountProof'->'credentialMetadata')='object'
            AND candidate.provider_state_data->'metaAccountProof'->'credentialMetadata'->>'appId'=expected_app_id
          ))
   ORDER BY candidate.tenant_id,candidate.connection_id;
$$;

CREATE OR REPLACE FUNCTION app.meta_signup_phone_available(phone_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
  SELECT phone_id ~ '^[0-9]{5,32}$' AND NOT EXISTS (
    SELECT 1 FROM webhook_routes WHERE provider='META' AND external_key=phone_id AND reservation_release_id IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION app.resolve_meta_routing_routes(account_value text,phone_value text,app_value text,secret_value text)
RETURNS TABLE(tenant_id uuid,connection_id uuid,provider text,hmac_secret_reference text,provider_session_id uuid,phone_number_id text,account_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
 SELECT connection.tenant_id,connection.id,'META'::text,route.hmac_secret_reference,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId'
 FROM connections connection JOIN tenants tenant ON tenant.id=connection.tenant_id
 JOIN provider_sessions session ON session.tenant_id=connection.tenant_id AND session.connection_id=connection.id AND session.ownership_state='ACTIVE'
 JOIN webhook_routes route ON route.tenant_id=connection.tenant_id AND route.connection_id=connection.id AND route.provider='META'
 WHERE route.reservation_release_id IS NULL AND connection.provider='META' AND connection.engine='CLOUD_API' AND tenant.state='ACTIVE'
  AND route.hmac_secret_reference=secret_value AND route.external_key=session.opaque_session_id
  AND(phone_value IS NULL OR session.opaque_session_id=phone_value)
  AND(session.provider_state_data->>'wabaId'=account_value OR(phone_value IS NOT NULL AND session.provider_state_data->>'wabaId' IS NULL))
  AND(session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=app_value
   OR session.provider_state_data#>'{metaAccountProof,credentialMetadata}' IS NULL)
$$;

CREATE OR REPLACE FUNCTION app.resolve_meta_identity_webhook_route(route_external_key text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, provider text, hmac_secret_reference text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT r.tenant_id,r.connection_id,r.provider,r.hmac_secret_reference
 FROM public.webhook_routes r
 WHERE r.provider='META' AND r.external_key=route_external_key AND r.state='PAUSED' AND r.reservation_release_id IS NULL
 LIMIT 1;
$$;

COMMIT;
