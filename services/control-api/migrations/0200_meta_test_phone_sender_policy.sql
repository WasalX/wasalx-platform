-- Default-off TEST sender PHONE selection at new delivery birth only.
-- Existing snapshots, retry identity, RLS and provider-effect guards are unchanged.
CREATE OR REPLACE FUNCTION app.snapshot_meta_direct_recipient() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE session_row provider_sessions%ROWTYPE; alias_row meta_direct_identity_aliases%ROWTYPE;
 participant_row participant_identities%ROWTYPE; canonical_key text; customer_key text; snapshot jsonb;
 test_policy jsonb:=NULLIF(current_setting('app.meta_test_phone_policy',true),'')::jsonb; prefer_test_phone boolean:=false;
BEGIN
 IF NEW.direct_origin IS NULL OR NOT EXISTS(SELECT 1 FROM connections connection
  WHERE connection.tenant_id=NEW.tenant_id AND connection.id=NEW.connection_id AND connection.provider='META') THEN
  IF NEW.meta_direct_recipient IS NOT NULL THEN RAISE EXCEPTION 'Meta snapshot on non-Meta-direct route' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 -- A committed idempotent replay cannot rebind the existing row after identity changes.
 IF EXISTS(SELECT 1 FROM delivery_outbox prior WHERE prior.tenant_id=NEW.tenant_id AND prior.idempotency_key=NEW.idempotency_key) THEN
  IF NEW.meta_direct_recipient IS NOT NULL THEN RAISE EXCEPTION 'Caller cannot supply Meta snapshot on replay' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 SELECT conversation.external_chat_id,conversation.zammad_customer_id::text INTO canonical_key,customer_key FROM bot_conversations conversation
 WHERE conversation.tenant_id=NEW.tenant_id AND conversation.connection_id=NEW.connection_id AND conversation.id=NEW.bot_conversation_id;
 IF canonical_key IS NULL OR canonical_key IS DISTINCT FROM NEW.external_chat_id THEN
  RAISE EXCEPTION 'Meta direct conversation is unavailable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO session_row FROM provider_sessions session WHERE session.tenant_id=NEW.tenant_id
  AND session.connection_id=NEW.connection_id AND session.ownership_state='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Meta direct session is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO participant_row FROM participant_identities participant WHERE participant.tenant_id=NEW.tenant_id
  AND participant.connection_id=NEW.connection_id AND participant.external_participant_id=canonical_key;
 IF NOT app.meta_direct_identity_guard(NEW.connection_id,session_row.id,session_row.opaque_session_id,session_row.provider_state_data->>'wabaId',participant_row.id) THEN
  RAISE EXCEPTION 'Meta direct identity change requires reconciliation' USING ERRCODE='55000';
 END IF;
 IF participant_row.id IS NOT NULL AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
  WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id AND alias.participant_identity_id=participant_row.id
  AND alias.provider_session_id=session_row.id AND alias.state='HELD') THEN
  RAISE EXCEPTION 'Meta direct identity is held' USING ERRCODE='55000';
 END IF;
 -- Trusted runtime context is opt-in, nonproduction and bound to one current TEST sender.
 prefer_test_phone:=COALESCE(test_policy->>'environment' IN('development','test') AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(test_policy->'senders') sender
  JOIN connections connection ON connection.tenant_id=NEW.tenant_id AND connection.id=NEW.connection_id
  WHERE sender->>'tenantId'=NEW.tenant_id::text AND sender->>'connectionId'=NEW.connection_id::text
   AND sender->>'providerSessionId'=session_row.id::text AND sender->>'phoneNumberId'=session_row.opaque_session_id
   AND sender->>'wabaId'=session_row.provider_state_data->>'wabaId'
   AND session_row.provider_state_data->'metaAccountProof'->>'schemaVersion'='1'
   AND session_row.provider_state_data->'metaAccountProof'->>'claim'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND session_row.provider_state_data->'metaAccountProof'->>'tenantId'=NEW.tenant_id::text
   AND session_row.provider_state_data->'metaAccountProof'->>'connectionId'=NEW.connection_id::text
   AND session_row.provider_state_data->'metaAccountProof'->>'secretReference'=connection.secret_reference
   AND session_row.provider_state_data->'metaAccountProof'->>'providerSessionId'=session_row.id::text
   AND session_row.provider_state_data->'metaAccountProof'->>'phoneNumberId'=session_row.opaque_session_id
   AND session_row.provider_state_data->'metaAccountProof'->>'wabaId'=session_row.provider_state_data->>'wabaId'
   AND session_row.provider_state_data->'metaAccountProof'->'credentialMetadata'->>'appId'=sender->>'appId'),false);
 SELECT * INTO alias_row FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=NEW.tenant_id
  AND alias.connection_id=NEW.connection_id AND alias.participant_identity_id=participant_row.id AND alias.provider_session_id=session_row.id
  AND alias.phone_number_id=session_row.opaque_session_id AND alias.waba_id=session_row.provider_state_data->>'wabaId' AND alias.state='ACTIVE'
  AND (NOT prefer_test_phone OR(alias.kind='PHONE' AND test_policy->'recipients' ? alias.value))
 ORDER BY CASE alias.kind WHEN 'BSUID' THEN 0 ELSE 1 END,alias.created_at,alias.id LIMIT 1 FOR SHARE;
 IF prefer_test_phone AND NOT FOUND THEN
  RAISE EXCEPTION 'Meta TEST reply requires an allowlisted verified PHONE alias' USING ERRCODE='55000';
 END IF;
 IF FOUND THEN
  IF prefer_test_phone AND NOT EXISTS(
   SELECT 1 FROM meta_direct_identity_aliases bsuid
   JOIN event_inbox source ON source.tenant_id=NEW.tenant_id AND source.connection_id=NEW.connection_id
    AND source.provider='META' AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL
    AND (source.status='PROCESSED' OR(source.status='PROCESSING' AND source.lease_id IS NOT NULL AND source.lease_expires_at>clock_timestamp()))
    AND source.meta_direct_asset=jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',alias_row.waba_id)
   WHERE bsuid.tenant_id=NEW.tenant_id AND bsuid.connection_id=NEW.connection_id
    AND bsuid.participant_identity_id=participant_row.id AND bsuid.provider_session_id=session_row.id
    AND bsuid.phone_number_id=session_row.opaque_session_id AND bsuid.waba_id=alias_row.waba_id
    AND bsuid.kind='BSUID' AND bsuid.state='ACTIVE'
    AND app.meta_direct_alias_source_valid(alias_row.id,canonical_key,customer_key)
    AND app.meta_direct_alias_source_valid(bsuid.id,canonical_key,customer_key)
    AND ((NEW.direct_origin='BOT' AND source.id=NEW.meta_routing_source_event_id)
     OR EXISTS(SELECT 1 FROM bot_conversation_events event WHERE event.tenant_id=NEW.tenant_id
      AND event.conversation_id=NEW.bot_conversation_id AND event.event_inbox_id=source.id))
    AND CASE WHEN source.payload#>>'{entry,0,changes,0,field}'='messages' THEN EXISTS(
     SELECT 1 FROM app.meta_direct_source_identity(source.payload) identity
     WHERE identity.joint_contact AND identity.phone=alias_row.value AND identity.bsuid=bsuid.value) ELSE false END
  ) THEN RAISE EXCEPTION 'Meta TEST PHONE reply requires current joint conversation evidence' USING ERRCODE='55000'; END IF;
  snapshot:=jsonb_build_object('schemaVersion',1,'claim','ALIAS_VERIFIED','recipient',jsonb_build_object('kind',alias_row.kind,'value',alias_row.value),
   'asset',jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',alias_row.waba_id),
   'participantId',participant_row.id::text,'aliasId',alias_row.id::text,'aliasRevision',alias_row.revision);
  IF prefer_test_phone THEN snapshot:=snapshot||jsonb_build_object('testPhoneSender',true); END IF;
 ELSE
  IF canonical_key !~ '^[1-9][0-9]{2,14}$' OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias
    WHERE alias.tenant_id=NEW.tenant_id AND alias.connection_id=NEW.connection_id
    AND (alias.value=canonical_key OR alias.participant_identity_id=participant_row.id)) THEN
   RAISE EXCEPTION 'Meta direct recipient requires verified scoped alias' USING ERRCODE='23514';
  END IF;
  snapshot:=jsonb_build_object('schemaVersion',1,'claim','LEGACY_PHONE_CONTEXT','recipient',jsonb_build_object('kind','PHONE','value',canonical_key),
   'asset',jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,
    'wabaId',session_row.provider_state_data->>'wabaId'));
 END IF;
 IF NEW.meta_direct_recipient IS NOT NULL AND NEW.meta_direct_recipient IS DISTINCT FROM snapshot THEN
  RAISE EXCEPTION 'Meta direct snapshot does not match admitted alias' USING ERRCODE='23514';
 END IF;
 NEW.meta_direct_recipient:=snapshot;
 RETURN NEW;
END;
$$;
