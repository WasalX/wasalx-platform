-- Ticket templates retain current routing and historical primary-source evidence.
-- The standard routing functions still require the customer-service window.
CREATE FUNCTION app.is_ticket_template(content jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(content->>'type'='template' AND content->>'ticketTemplateId' ~ '^[0-9]{1,32}$'
   AND content->>'ticketTemplateSha256' ~ '^[a-f0-9]{64}$',false);
$$;
REVOKE ALL ON FUNCTION app.is_ticket_template(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_ticket_template(jsonb) TO wasalx_app,wasalx_connector_worker,wasalx_meta_transition_executor;

ALTER TABLE delivery_outbox DROP CONSTRAINT delivery_outbox_origin_shape;
ALTER TABLE delivery_outbox ADD CONSTRAINT delivery_outbox_origin_shape CHECK (
  (content_redacted_at IS NOT NULL
    AND group_binding_id IS NULL AND group_workspace_group_id IS NULL
    AND bot_conversation_id IS NULL AND external_chat_id IS NULL
    AND bot_content IS NULL AND direct_origin IS NULL
    AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL
    AND ticket_event_execution_id IS NULL)
  OR
  (content_redacted_at IS NULL AND delivery_origin='TICKET'
    AND (
      (zammad_ticket_id IS NOT NULL AND zammad_article_id IS NOT NULL)
      OR (bot_conversation_id IS NOT NULL AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
        AND (direct_origin='BOT' OR
          (direct_origin='HUMAN' AND app.is_ticket_template(bot_content) AND direct_ownership_epoch IS NOT NULL
            AND reply_to_message_id IS NULL AND ticket_event_execution_id IS NULL)))
      OR (group_binding_id IS NOT NULL AND bot_conversation_id IS NULL
        AND group_workspace_group_id IS NULL AND direct_origin IS NULL
        AND external_chat_id IS NULL AND bot_content IS NULL
        AND zammad_ticket_id IS NOT NULL AND zammad_article_id IS NULL
        AND reply_to_message_id IS NOT NULL AND idempotency_key LIKE 'ack:%'
        AND ticket_event_execution_id IS NULL)
      OR (ticket_event_execution_id IS NOT NULL
        AND group_binding_id IS NOT NULL AND group_workspace_group_id IS NULL
        AND bot_conversation_id IS NULL AND direct_origin IS NULL
        AND external_chat_id IS NULL AND bot_content IS NULL
        AND zammad_ticket_id IS NOT NULL
        AND content_type IN ('text/plain','application/vnd.wasalx.whatsapp-reaction')
        AND (content_type='text/plain' OR reply_to_message_id IS NOT NULL))
    ))
  OR
  (content_redacted_at IS NULL AND delivery_origin='GROUP_WORKSPACE'
    AND group_workspace_group_id IS NOT NULL AND group_binding_id IS NULL
    AND bot_conversation_id IS NULL AND external_chat_id IS NULL
    AND bot_content IS NULL AND zammad_ticket_id IS NULL AND zammad_article_id IS NULL
    AND ticket_event_execution_id IS NULL)
);


CREATE FUNCTION app.meta_primary_delivery_source(connection_value uuid,session_value uuid,participant_value uuid,app_value text,runtime_value jsonb,source_value uuid, ticket_template boolean)
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
  AND (ticket_template IS TRUE OR admission.observed_at+interval '24 hours'>clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM public.privacy_jobs job JOIN public.privacy_job_targets target ON target.tenant_id=job.tenant_id AND target.job_id=job.id
   WHERE job.tenant_id=admission.tenant_id AND job.job_type IN('DELETE','RETENTION_SWEEP') AND job.state IN('QUEUED','RUNNING','FAILED_RETRYABLE')
   AND target.state IN('PENDING','EXTERNAL_COMPLETE','COMPLETE') AND target.target_type IN('META_ROUTING_EVENT','META_DIRECT_IDENTITY_EVENT')
   AND target.target_id=admission.source_event_id::text)
 ORDER BY admission.observed_at DESC,admission.source_event_id DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.meta_primary_delivery_source(uuid,uuid,uuid,text,jsonb,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_primary_delivery_source(uuid,uuid,uuid,text,jsonb,uuid,boolean) TO wasalx_app,wasalx_connector_worker;


CREATE OR REPLACE FUNCTION app.meta_primary_delivery_source(connection_value uuid,session_value uuid,participant_value uuid,app_value text,runtime_value jsonb,source_value uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT app.meta_primary_delivery_source(connection_value,session_value,participant_value,app_value,runtime_value,source_value,false);
$$;

CREATE FUNCTION app.meta_direct_routing_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
 participant_value uuid,app_value text,runtime_value jsonb,expected_epoch bigint,
 source_values uuid[],excluded_action uuid,require_own boolean,ticket_template boolean)
RETURNS TABLE(allowed boolean,epoch bigint,claim text,reason text,configuration_version bigint,review_version bigint)
LANGUAGE plpgsql STABLE ROWS 1 SET search_path=pg_catalog,public,app,pg_temp AS $$
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
   allowed:=app.meta_primary_delivery_source(connection_value,session_value,participant_value,app_value,runtime_value,NULL,ticket_template) IS NOT NULL;
  ELSIF cardinality(source_values) BETWEEN 1 AND 2 THEN
   allowed:=true;
   FOREACH source_id IN ARRAY source_values LOOP
    IF app.meta_primary_delivery_source(connection_value,session_value,participant_value,app_value,runtime_value,source_id,ticket_template) IS NULL THEN allowed:=false;EXIT;END IF;
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
  IF require_own AND ticket_template IS NOT TRUE AND(ownership_row.last_customer_message_at IS NULL OR ownership_row.last_customer_message_at+interval '24 hours'<=clock_timestamp())
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

REVOKE ALL ON FUNCTION app.meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_routing_guard(uuid,uuid,text,text,uuid,text,jsonb,bigint,uuid[],uuid,boolean,boolean) TO wasalx_app,wasalx_connector_worker;

CREATE OR REPLACE FUNCTION app.meta_direct_routing_guard(connection_value uuid,session_value uuid,phone_value text,account_value text,
 participant_value uuid,app_value text,runtime_value jsonb,expected_epoch bigint DEFAULT NULL,
 source_values uuid[] DEFAULT NULL,excluded_action uuid DEFAULT NULL,require_own boolean DEFAULT true)
RETURNS TABLE(allowed boolean,epoch bigint,claim text,reason text,configuration_version bigint,review_version bigint)
LANGUAGE sql STABLE ROWS 1 SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT * FROM app.meta_direct_routing_guard(connection_value,session_value,phone_value,account_value,
  participant_value,app_value,runtime_value,expected_epoch,source_values,excluded_action,require_own,false);
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
  CASE WHEN NEW.meta_routing_source_event_id IS NULL THEN NULL ELSE ARRAY[NEW.meta_routing_source_event_id] END,NULL,true,
  NEW.direct_origin IS NOT DISTINCT FROM 'HUMAN' AND NEW.delivery_origin='TICKET'
   AND NEW.zammad_article_id IS NULL AND app.is_ticket_template(NEW.bot_content));
 IF guard_row.allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'routing effect held' USING ERRCODE='23514';END IF;
 NEW.meta_routing_epoch:=guard_row.epoch;RETURN NEW;
END;
$$;

-- Unknown when there is no retained customer message to date the window.
CREATE FUNCTION app.meta_customer_window_open(connection_value uuid, chat_value text, now_value timestamptz DEFAULT clock_timestamp())
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT message.provider_timestamp + interval '24 hours' > now_value
 FROM normalized_messages message JOIN event_inbox source
   ON source.tenant_id=message.tenant_id AND source.id=message.event_inbox_id AND source.connection_id=message.connection_id
 WHERE message.tenant_id=app.current_tenant_id() AND message.connection_id=connection_value AND message.external_group_id=chat_value
   AND NOT message.from_me AND NOT message.from_api AND message.processing_status<>'REDACTED'
   AND source.provider='META' AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL
   AND source.status IN ('PROCESSING','PROCESSED')
 ORDER BY message.provider_timestamp DESC,message.id DESC LIMIT 1;
$$;
REVOKE ALL ON FUNCTION app.meta_customer_window_open(uuid,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_customer_window_open(uuid,text,timestamptz) TO wasalx_app,wasalx_connector_worker;

-- Use the same safety row as signed template invalidations. Generation zero
-- must also have a row so the final request transaction can lock it.
CREATE FUNCTION app.lock_meta_ticket_template_safety(delivery_value uuid,lease_value uuid,provider_account text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE account_value uuid;revision_value bigint;
BEGIN
 SELECT account.id INTO STRICT account_value
 FROM public.delivery_outbox delivery
 JOIN public.provider_sessions session ON session.tenant_id=delivery.tenant_id AND session.connection_id=delivery.connection_id
 JOIN public.meta_messaging_accounts account ON account.tenant_id=delivery.tenant_id
  AND account.provider_account_id=provider_account AND account.provider_account_id=session.provider_state_data->>'wabaId'
 WHERE delivery.tenant_id=app.current_tenant_id() AND delivery.id=delivery_value AND delivery.lease_id=lease_value
  AND delivery.state='SENDING' AND delivery.lease_expires_at>clock_timestamp() AND delivery.content_redacted_at IS NULL
  AND NOT app.delivery_has_active_privacy_target(delivery.id)
  AND delivery.direct_origin='HUMAN' AND delivery.delivery_origin='TICKET' AND delivery.zammad_article_id IS NULL
  AND app.is_ticket_template(delivery.bot_content) AND session.ownership_state='ACTIVE' AND session.state='WORKING'
 FOR SHARE OF account;
 INSERT INTO public.meta_template_account_safety(tenant_id,account_id)
 VALUES(app.current_tenant_id(),account_value) ON CONFLICT DO NOTHING;
 SELECT revision INTO STRICT revision_value FROM public.meta_template_account_safety
  WHERE tenant_id=app.current_tenant_id() AND account_id=account_value FOR SHARE;
 RETURN revision_value::text;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RETURN NULL;
END $$;
ALTER FUNCTION app.lock_meta_ticket_template_safety(uuid,uuid,text) OWNER TO wasalx_meta_transition_executor;
REVOKE ALL ON FUNCTION app.lock_meta_ticket_template_safety(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_meta_ticket_template_safety(uuid,uuid,text) TO wasalx_connector_worker;

CREATE OR REPLACE FUNCTION app.meta_inherited_template_send_context(delivery_value uuid,lease_value uuid) RETURNS jsonb
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
 -- Agents select from the current account, so no inherited flow mapping applies.
 IF d.direct_origin='HUMAN' AND d.delivery_origin='TICKET' AND d.zammad_article_id IS NULL
  AND app.is_ticket_template(d.bot_content) THEN RETURN NULL;END IF;
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
