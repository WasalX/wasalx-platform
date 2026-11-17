BEGIN;
ALTER TABLE event_inbox ADD COLUMN meta_direct_identity_transition jsonb;
ALTER TABLE event_inbox ADD COLUMN meta_direct_identity_resolution jsonb;
ALTER TABLE meta_direct_identity_aliases DROP CONSTRAINT meta_direct_identity_aliases_state_check;
ALTER TABLE meta_direct_identity_aliases ADD CONSTRAINT meta_direct_identity_aliases_state_check CHECK(state IN('ACTIVE','HELD','RETIRED'));
DO $$ DECLARE key_name text; BEGIN
 SELECT conname INTO key_name FROM pg_constraint WHERE conrelid='meta_direct_identity_aliases'::regclass AND contype='u'
  AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, connection_id, participant_identity_id, provider_session_id, phone_number_id, waba_id, kind)';
 IF key_name IS NULL THEN RAISE EXCEPTION 'Meta alias current-kind constraint is missing'; END IF;
 EXECUTE format('ALTER TABLE meta_direct_identity_aliases DROP CONSTRAINT %I',key_name);
END $$;
CREATE UNIQUE INDEX meta_direct_alias_current_kind ON meta_direct_identity_aliases
 (tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind) WHERE state IN('ACTIVE','HELD');

-- Same finite structured contract as the core parser. Invalid system units retain
-- the existing immutable hold marker, never an application grant.
CREATE FUNCTION app.meta_direct_source_transition(payload_value jsonb,hash_value text,asset_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE message jsonb:=payload_value#>'{entry,0,changes,0,value,messages,0}'; detail jsonb; previous_value jsonb:='{}';current_value jsonb:='{}';
 field_value text;kind_value text;seconds numeric;kind text;
BEGIN
 IF jsonb_typeof(payload_value->'entry') IS DISTINCT FROM 'array' OR jsonb_array_length(payload_value->'entry')<>1
  OR jsonb_typeof(payload_value#>'{entry,0,changes}') IS DISTINCT FROM 'array' OR jsonb_array_length(payload_value#>'{entry,0,changes}')<>1
  OR jsonb_typeof(payload_value#>'{entry,0,changes,0,value,messages}') IS DISTINCT FROM 'array'
  OR jsonb_array_length(payload_value#>'{entry,0,changes,0,value,messages}')<>1
  OR payload_value#>>'{entry,0,changes,0,field}' IS DISTINCT FROM 'messages'
  OR payload_value#>>'{entry,0,id}' IS DISTINCT FROM asset_value->>'wabaId'
  OR payload_value#>>'{entry,0,changes,0,value,metadata,phone_number_id}' IS DISTINCT FROM asset_value->>'phoneNumberId'
  OR message->>'type' IS DISTINCT FROM 'system' OR message ? 'group_id' THEN RETURN NULL; END IF;
 detail:=message->'system';
 IF jsonb_typeof(detail) IS DISTINCT FROM 'object' OR COALESCE(detail->>'type','') NOT IN('user_changed_number','user_changed_user_id') THEN RETURN NULL; END IF;
 FOR field_value,kind_value IN SELECT * FROM(VALUES('from','PHONE'),('from_user_id','BSUID'),('from_parent_user_id','PARENT_BSUID')) f(field,kind) LOOP
  IF message ? field_value AND (jsonb_typeof(message->field_value) IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid(kind_value,message->>field_value)) THEN RETURN NULL; END IF;
 END LOOP;
 FOR field_value,kind_value IN SELECT * FROM(VALUES('wa_id','PHONE'),('user_id','BSUID'),('previous_user_id','BSUID'),('parent_user_id','PARENT_BSUID'),('previous_parent_user_id','PARENT_BSUID')) f(field,kind) LOOP
  IF detail ? field_value AND (jsonb_typeof(detail->field_value) IS DISTINCT FROM 'string' OR NOT app.meta_direct_identifier_valid(kind_value,detail->>field_value)) THEN RETURN NULL; END IF;
 END LOOP;
 IF detail->>'wa_id' IS NULL AND detail->>'user_id' IS NULL THEN RETURN NULL; END IF;
 IF detail->>'type'='user_changed_user_id' AND (detail->>'previous_user_id' IS NULL OR detail->>'user_id' IS NULL) THEN RETURN NULL; END IF;
 IF jsonb_typeof(message->'id') IS DISTINCT FROM 'string' OR length(message->>'id') NOT BETWEEN 1 AND 512 OR message->>'id'~'[[:cntrl:][:space:]]'
  OR jsonb_typeof(message->'timestamp') IS DISTINCT FROM 'string' OR message->>'timestamp'!~'^[0-9]{1,13}$'
  OR hash_value!~'^[0-9a-f]{64}$' OR jsonb_typeof(asset_value) IS DISTINCT FROM 'object'
  OR asset_value-ARRAY['providerSessionId','phoneNumberId','wabaId']<>'{}'
  OR COALESCE(asset_value->>'providerSessionId','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR COALESCE(asset_value->>'phoneNumberId','')!~'^[0-9]{1,32}$' OR COALESCE(asset_value->>'wabaId','')!~'^[0-9]{1,32}$' THEN RETURN NULL; END IF;
 seconds:=(message->>'timestamp')::numeric;IF seconds<=0 OR seconds>253402300799 THEN RETURN NULL; END IF;
 IF message ? 'from' THEN previous_value:=previous_value||jsonb_build_object('phone',message->>'from'); END IF;
 IF detail ? 'previous_user_id' THEN previous_value:=previous_value||jsonb_build_object('bsuid',detail->>'previous_user_id'); END IF;
 IF detail ? 'previous_parent_user_id' THEN previous_value:=previous_value||jsonb_build_object('parentBsuid',detail->>'previous_parent_user_id'); END IF;
 IF detail ? 'wa_id' THEN current_value:=current_value||jsonb_build_object('phone',detail->>'wa_id'); END IF;
 IF detail ? 'user_id' THEN current_value:=current_value||jsonb_build_object('bsuid',detail->>'user_id'); END IF;
 IF detail ? 'parent_user_id' THEN current_value:=current_value||jsonb_build_object('parentBsuid',detail->>'parent_user_id'); END IF;
 kind:=CASE detail->>'type' WHEN 'user_changed_number' THEN 'USER_CHANGED_NUMBER' ELSE 'USER_CHANGED_USER_ID' END;
 RETURN jsonb_build_object('schemaVersion',1,'change',jsonb_build_object('kind',kind,'previous',previous_value,'current',current_value),
  'providerTimestamp',to_char(to_timestamp(seconds::double precision) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'messageIdSha256',encode(digest(message->>'id','sha256'),'hex'),'payloadSha256',hash_value,'asset',asset_value);
END;
$$;

CREATE FUNCTION app.meta_direct_transition_edge(evidence jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT encode(digest(jsonb_build_array(evidence->'asset',evidence#>'{change,kind}',evidence#>>'{change,previous,phone}',
  evidence#>>'{change,previous,bsuid}',evidence#>>'{change,current,phone}',evidence#>>'{change,current,bsuid}')::text,'sha256'),'hex')
$$;

CREATE FUNCTION app.preserve_meta_direct_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.meta_direct_identity_transition IS NOT NULL AND (NEW.provider<>'META' OR NEW.event_type<>'messages' OR NEW.meta_direct_asset IS NULL
   OR NEW.meta_direct_identity_transition IS DISTINCT FROM app.meta_direct_source_transition(NEW.payload,NEW.payload_sha256,NEW.meta_direct_asset)) THEN
   RAISE EXCEPTION 'Meta transition evidence does not match signed source' USING ERRCODE='23514'; END IF;
  IF NEW.meta_direct_identity_resolution IS NOT NULL THEN RAISE EXCEPTION 'Meta transition resolution cannot be supplied at ingress' USING ERRCODE='23514'; END IF;
 ELSIF NEW.meta_direct_identity_transition IS DISTINCT FROM OLD.meta_direct_identity_transition THEN
  IF OLD.meta_direct_identity_transition IS NULL OR NEW.meta_direct_identity_transition IS DISTINCT FROM jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.meta_direct_identity_transition::text,'sha256'),'hex'))
   OR NEW.status<>'REDACTED' OR NEW.payload<>'{}' OR NOT app.meta_direct_privacy_target_authorized('META_DIRECT_IDENTITY_EVENT',OLD.id::text) THEN
   RAISE EXCEPTION 'Meta transition evidence is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_transition_immutable BEFORE INSERT OR UPDATE OF meta_direct_identity_transition,meta_direct_identity_resolution ON event_inbox
 FOR EACH ROW EXECUTE FUNCTION app.preserve_meta_direct_transition();

-- One original ordinary root validator for both historical bridge evidence and
-- new transition admission. A retained capsule never grants queued-source replay.
CREATE FUNCTION app.meta_direct_transition_anchor_valid(event_value uuid,participant_value uuid,customer_value text,current_effect boolean DEFAULT true)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM event_inbox source JOIN participant_identities participant
  ON participant.tenant_id=source.tenant_id AND participant.connection_id=source.connection_id AND participant.id=participant_value
  WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value AND source.provider='META'
   AND source.event_type='messages' AND source.meta_direct_identity_change IS NULL AND source.status IN('PROCESSED','REDACTED')
   AND (app.meta_direct_native_anchor_valid(source.id,participant.id,customer_value,current_effect)
    OR(source.status='PROCESSED' AND source.payload#>>'{entry,0,changes,0,field}'='messages' AND EXISTS(
     SELECT 1 FROM normalized_messages message JOIN message_links link
      ON link.tenant_id=message.tenant_id AND link.connection_id=message.connection_id AND link.external_message_id=message.external_message_id
     JOIN bot_conversations conversation ON conversation.tenant_id=participant.tenant_id AND conversation.connection_id=participant.connection_id
      AND conversation.external_chat_id=participant.external_participant_id AND conversation.zammad_ticket_id=link.zammad_ticket_id
      AND conversation.zammad_customer_id::text=customer_value
     WHERE message.tenant_id=source.tenant_id AND message.connection_id=source.connection_id AND message.event_inbox_id=source.id
      AND message.processing_status='COMPLETE' AND message.external_group_id=participant.external_participant_id
      AND message.external_participant_id=participant.external_participant_id AND message.provider_metadata->'direct'='true'
      AND message.provider_metadata->>'zammad_customer_id'=customer_value))))
$$;

-- A historical applied receipt retains its consumed alias evidence even after
-- later edges retire those aliases. Current send authority is checked separately.
CREATE FUNCTION app.meta_direct_transition_receipt_valid(event_value uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;receipt jsonb;applied event_inbox%ROWTYPE;item jsonb;anchor_id uuid;participant_id uuid;
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
 participant_id:=(receipt->>'participantId')::uuid;anchor_id:=(receipt->>'anchorEventId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM participant_identities p WHERE p.tenant_id=source.tenant_id AND p.connection_id=source.connection_id
  AND p.id=participant_id AND p.external_participant_id=receipt->>'canonical') THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM event_inbox anchor LEFT JOIN normalized_messages message ON message.tenant_id=anchor.tenant_id AND message.event_inbox_id=anchor.id
  WHERE anchor.tenant_id=source.tenant_id AND anchor.connection_id=source.connection_id AND anchor.id=anchor_id
   AND anchor.meta_direct_asset=source.meta_direct_asset AND anchor.meta_direct_identity_change IS NULL AND anchor.status IN('PROCESSED','REDACTED')
   AND app.meta_direct_transition_anchor_valid(anchor.id,participant_id,receipt->>'nativeCustomerId',false)) THEN RETURN false; END IF;
 IF source.status<>'PROCESSED' OR receipt-ARRAY['schemaVersion','state','evidenceSha256','participantId','canonical','nativeCustomerId','anchorEventId','predecessorAliases','successorAliases','appliedEventId']<>'{}' THEN RETURN false; END IF;
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
     AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=source.meta_direct_asset) THEN RETURN false; END IF;
 END LOOP;
 -- Successor slots bind the actual signed current identifiers. A later HELD
 -- marker or sealed consuming edge can advance its revision, but arbitrary
 -- older-revision equality is never accepted as current alias authority.
 FOR item IN SELECT value FROM jsonb_array_elements(receipt->'successorAliases') LOOP
  IF NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id
   AND alias.connection_id=source.connection_id AND alias.id::text=item->>'id' AND alias.participant_identity_id=participant_id
   AND alias.value=CASE alias.kind WHEN 'PHONE' THEN source.meta_direct_identity_transition#>>'{change,current,phone}'
      ELSE source.meta_direct_identity_transition#>>'{change,current,bsuid}' END
   AND (alias.revision=(item->>'revision')::bigint
    OR(alias.state='HELD' AND alias.revision=(item->>'revision')::bigint+1)
    OR EXISTS(SELECT 1 FROM event_inbox consuming WHERE consuming.tenant_id=source.tenant_id
     AND consuming.connection_id=source.connection_id AND consuming.meta_direct_asset=source.meta_direct_asset
     AND consuming.status='PROCESSED' AND consuming.meta_direct_identity_resolution->>'state'='APPLIED'
     AND consuming.meta_direct_identity_resolution->>'participantId'=participant_id::text
     AND consuming.meta_direct_identity_resolution->>'anchorEventId'=anchor_id::text
     AND consuming.meta_direct_identity_resolution->>'evidenceSha256'=encode(digest(consuming.meta_direct_identity_transition::text,'sha256'),'hex')
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(consuming.meta_direct_identity_resolution->'predecessorAliases') slot
      WHERE slot->>'id'=alias.id::text AND (slot->>'revision')::bigint IN((item->>'revision')::bigint,(item->>'revision')::bigint+1)
       AND alias.revision>=(slot->>'revision')::bigint+1)))) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE FUNCTION app.meta_direct_transition_effects_clear(connection_value uuid,participant_value uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM bot_conversations conversation JOIN participant_identities participant
  ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
  WHERE conversation.tenant_id=app.current_tenant_id() AND conversation.connection_id=connection_value AND participant.id=participant_value AND (
   EXISTS(SELECT 1 FROM delivery_outbox delivery WHERE delivery.tenant_id=conversation.tenant_id AND delivery.connection_id=conversation.connection_id AND (delivery.bot_conversation_id=conversation.id OR(delivery.direct_origin IS NOT NULL AND delivery.external_chat_id=conversation.external_chat_id AND delivery.zammad_ticket_id=conversation.zammad_ticket_id))
    AND (delivery.lease_id IS NOT NULL OR delivery.state IN('CLAIMED','SENDING','FAILED_RETRYABLE','OUTCOME_UNKNOWN','BLOCKED') OR (delivery.state='QUEUED' AND (delivery.attempts<>0 OR EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.tenant_id=delivery.tenant_id AND attempt.delivery_id=delivery.id))) OR (delivery.state='FAILED_TERMINAL' AND delivery.manual_retry_allowed)))
   OR EXISTS(SELECT 1 FROM bot_action_jobs action WHERE action.tenant_id=conversation.tenant_id AND action.conversation_id=conversation.id AND (action.lease_id IS NOT NULL OR action.state NOT IN('SUCCEEDED','FAILED_TERMINAL')))
   OR EXISTS(SELECT 1 FROM bot_handoff_jobs handoff WHERE handoff.tenant_id=conversation.tenant_id AND handoff.conversation_id=conversation.id AND (handoff.lease_id IS NOT NULL OR handoff.state NOT IN('SUCCEEDED','FAILED_TERMINAL')))
   OR EXISTS(SELECT 1 FROM direct_native_reply_intents intent WHERE intent.tenant_id=conversation.tenant_id AND intent.conversation_id=conversation.id AND intent.state IN('PENDING','OUTCOME_UNKNOWN'))
   OR EXISTS(SELECT 1 FROM direct_customer_close_commands command WHERE command.tenant_id=conversation.tenant_id AND command.conversation_id=conversation.id AND
    (command.state IN('QUEUED','ATTEMPTED','OUTCOME_UNKNOWN') OR (command.state='SUCCEEDED' AND conversation.state IN('BOT','HUMAN') AND conversation.fencing_token=command.conversation_fencing_token)))
   OR EXISTS(SELECT 1 FROM zammad_conversation_state_outbox projection WHERE projection.tenant_id=conversation.tenant_id AND projection.conversation_id=conversation.id AND (projection.completed_at IS NULL OR projection.lease_id IS NOT NULL))
  ))
$$;

CREATE FUNCTION app.meta_direct_transition_privacy_clear(connection_value uuid,participant_value uuid,values_value text[],source_value uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=app.current_tenant_id() AND job.job_type IN('DELETE','RETENTION_SWEEP')
  AND job.state IN('QUEUED','RUNNING','FAILED_RETRYABLE') AND (job.job_type='DELETE' OR EXISTS(SELECT 1 FROM privacy_job_targets target
   WHERE target.tenant_id=job.tenant_id AND target.job_id=job.id AND target.state IN('PENDING','EXTERNAL_COMPLETE','COMPLETE') AND
    ((target.target_type='META_DIRECT_IDENTITY_EVENT' AND target.target_id=source_value::text)
     OR(target.target_type='META_DIRECT_ALIAS' AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=job.tenant_id
      AND alias.connection_id=connection_value AND alias.participant_identity_id=participant_value AND alias.id::text=target.target_id))
     OR(target.target_type IN('ZAMMAD_TICKET','ZAMMAD_USER') AND EXISTS(SELECT 1 FROM bot_conversations conversation JOIN participant_identities participant
      ON participant.tenant_id=conversation.tenant_id AND participant.connection_id=conversation.connection_id AND participant.external_participant_id=conversation.external_chat_id
      WHERE participant.tenant_id=job.tenant_id AND participant.id=participant_value AND conversation.connection_id=connection_value
       AND (target.target_id=conversation.zammad_ticket_id OR target.target_id=conversation.zammad_customer_id::text)))))))
 AND NOT EXISTS(SELECT 1 FROM privacy_jobs job WHERE job.tenant_id=app.current_tenant_id() AND job.job_type='DELETE'
  AND job.scope_type='PARTICIPANT' AND job.scope_value=ANY(values_value))
$$;

-- Resolution itself cannot be supplied as an arbitrary release flag. Its exact
-- source, prior owner/revisions, target collisions and unresolved effects are
-- checked before it can authorize the alias statements in this transaction.
CREATE FUNCTION app.guard_meta_direct_resolution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE receipt jsonb:=NEW.meta_direct_identity_resolution;item jsonb;owner uuid;prior event_inbox%ROWTYPE;anchor event_inbox%ROWTYPE;kind_value text;value_text text;
BEGIN
 IF receipt IS NOT DISTINCT FROM OLD.meta_direct_identity_resolution THEN RETURN NEW; END IF;
 IF OLD.meta_direct_identity_resolution IS NOT NULL THEN
  IF NEW.status='REDACTED' AND NEW.payload='{}' AND receipt=jsonb_build_object('redacted',true,'sha256',encode(digest(OLD.meta_direct_identity_resolution::text,'sha256'),'hex'))
   AND app.meta_direct_privacy_target_authorized('META_DIRECT_IDENTITY_EVENT',OLD.id::text) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Meta transition resolution is immutable' USING ERRCODE='23514';
 END IF;
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='app.apply_meta_direct_transition_edge(uuid,uuid,boolean)'::regprocedure)) THEN
  RAISE EXCEPTION 'Meta resolution requires sealed transition admission' USING ERRCODE='42501'; END IF;
 IF ((OLD.status='PROCESSING' AND OLD.lease_id IS NOT NULL AND OLD.lease_expires_at>clock_timestamp())
  OR(OLD.status='QUARANTINED' AND OLD.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT'))) IS NOT TRUE THEN
  RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
 IF NEW.meta_direct_identity_transition IS NULL OR OLD.status NOT IN('PROCESSING','QUARANTINED') OR NEW.status<>'PROCESSED'
  OR receipt->'schemaVersion' IS DISTINCT FROM '1' OR COALESCE(receipt->>'state','') NOT IN('APPLIED','DUPLICATE')
  OR receipt->>'evidenceSha256' IS DISTINCT FROM encode(digest(OLD.meta_direct_identity_transition::text,'sha256'),'hex')
  OR COALESCE(receipt->>'participantId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'anchorEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR COALESCE(receipt->>'appliedEventId','')!~'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
  OR jsonb_typeof(receipt->'predecessorAliases') IS DISTINCT FROM 'array' OR jsonb_typeof(receipt->'successorAliases') IS DISTINCT FROM 'array'
  OR receipt-ARRAY['schemaVersion','state','evidenceSha256','participantId','canonical','nativeCustomerId','anchorEventId','predecessorAliases','successorAliases','appliedEventId']<>'{}' THEN
  RAISE EXCEPTION 'Meta transition resolution does not match source' USING ERRCODE='23514'; END IF;
 owner:=(receipt->>'participantId')::uuid;
 IF receipt->>'state'='DUPLICATE' THEN
  SELECT id,tenant_id,connection_id,received_at,meta_direct_identity_transition,meta_direct_identity_resolution INTO prior.id,prior.tenant_id,prior.connection_id,prior.received_at,prior.meta_direct_identity_transition,prior.meta_direct_identity_resolution FROM event_inbox WHERE tenant_id=OLD.tenant_id AND connection_id=OLD.connection_id AND id=(receipt->>'appliedEventId')::uuid;
  IF NOT FOUND OR NOT app.meta_direct_transition_receipt_valid(prior.id) OR prior.meta_direct_identity_resolution->>'state'<>'APPLIED'
   OR app.meta_direct_transition_edge(prior.meta_direct_identity_transition) IS DISTINCT FROM app.meta_direct_transition_edge(OLD.meta_direct_identity_transition)
   OR receipt-ARRAY['state','evidenceSha256'] IS DISTINCT FROM prior.meta_direct_identity_resolution-ARRAY['state','evidenceSha256'] THEN
   RAISE EXCEPTION 'Meta duplicate transition lacks original receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF receipt->>'appliedEventId'<>OLD.id::text OR NOT EXISTS(SELECT 1 FROM participant_identities participant WHERE participant.tenant_id=OLD.tenant_id
  AND participant.connection_id=OLD.connection_id AND participant.id=owner AND participant.external_participant_id=receipt->>'canonical')
  OR NOT app.meta_direct_transition_effects_clear(OLD.connection_id,owner)
  OR NOT app.meta_direct_transition_privacy_clear(OLD.connection_id,owner,ARRAY[OLD.meta_direct_identity_transition#>>'{change,previous,phone}',OLD.meta_direct_identity_transition#>>'{change,previous,bsuid}',OLD.meta_direct_identity_transition#>>'{change,current,phone}',OLD.meta_direct_identity_transition#>>'{change,current,bsuid}'],OLD.id) THEN
  RAISE EXCEPTION 'Meta transition owner or effects changed' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
  WHERE session.tenant_id=OLD.tenant_id AND session.connection_id=OLD.connection_id AND session.ownership_state='ACTIVE'
   AND session.state='WORKING' AND connection.state='WORKING' AND connection.provider='META'
   AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=OLD.meta_direct_asset
   AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=OLD.tenant_id::text AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=OLD.connection_id::text
   AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=connection.secret_reference AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=session.id::text
   AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=session.opaque_session_id AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=session.provider_state_data->>'wabaId'
   AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,claim}'='CREDENTIAL_METADATA_VERIFIED'
   AND CASE WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND CASE WHEN NOT(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' ? 'dataAccessExpiresAt') THEN true
    WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END) THEN
  RAISE EXCEPTION 'Meta transition current account proof is unavailable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session CROSS JOIN LATERAL app.meta_lifecycle_guard(
    OLD.connection_id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId',
    session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}',
    CASE WHEN NOT(session.provider_state_data ? 'metaLifecycle') THEN 0
      WHEN session.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE -1 END) readiness
   WHERE session.tenant_id=OLD.tenant_id AND session.connection_id=OLD.connection_id AND session.ownership_state='ACTIVE'
    AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=OLD.meta_direct_asset
    AND readiness.revision_matches AND NOT readiness.blocked AND NOT readiness.unresolved_hold) THEN
  RAISE EXCEPTION 'Meta transition lifecycle authority changed' USING ERRCODE='55000'; END IF;
 SELECT * INTO anchor FROM event_inbox WHERE tenant_id=OLD.tenant_id AND connection_id=OLD.connection_id AND id=(receipt->>'anchorEventId')::uuid;
 IF NOT FOUND OR anchor.status NOT IN('PROCESSED','REDACTED') OR anchor.meta_direct_asset IS DISTINCT FROM OLD.meta_direct_asset
  OR NOT app.meta_direct_transition_anchor_valid(anchor.id,owner,receipt->>'nativeCustomerId',true) THEN
  RAISE EXCEPTION 'Meta transition ordinary customer anchor is unavailable' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(receipt->'predecessorAliases') LOOP
  IF jsonb_typeof(item->'revision') IS DISTINCT FROM 'number' OR COALESCE(item->>'revision','')!~'^[1-9][0-9]{0,15}$'
   OR NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id
    AND alias.id::text=item->>'id' AND alias.participant_identity_id=owner AND alias.state IN('ACTIVE','HELD') AND alias.revision=(item->>'revision')::bigint
    AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=OLD.meta_direct_asset) THEN
   RAISE EXCEPTION 'Meta transition predecessor changed' USING ERRCODE='55000'; END IF;
 END LOOP;
 FOR kind_value,value_text IN SELECT * FROM(VALUES('PHONE',OLD.meta_direct_identity_transition#>>'{change,previous,phone}'),('BSUID',OLD.meta_direct_identity_transition#>>'{change,previous,bsuid}')) pairs(kind,value) LOOP
  IF value_text IS NOT NULL AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id
   AND alias.participant_identity_id=owner AND alias.kind=kind_value AND alias.value=value_text AND alias.state IN('ACTIVE','HELD')
   AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=OLD.meta_direct_asset)
   AND NOT(kind_value='PHONE' AND receipt->>'canonical'=value_text AND OLD.meta_direct_identity_transition#>>'{change,previous,bsuid}' IS NULL
     AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.participant_identity_id=owner)) THEN
   RAISE EXCEPTION 'Meta transition supplied predecessor is not uniquely current' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=OLD.tenant_id AND alias.connection_id=OLD.connection_id AND alias.participant_identity_id=owner
  AND alias.state IN('ACTIVE','HELD') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipt->'predecessorAliases') slot WHERE slot->>'id'=alias.id::text AND slot->>'revision'=alias.revision::text)) THEN
  RAISE EXCEPTION 'Meta transition omits a current predecessor' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER meta_direct_resolution_guard BEFORE UPDATE OF meta_direct_identity_resolution ON event_inbox FOR EACH ROW EXECUTE FUNCTION app.guard_meta_direct_resolution();

CREATE FUNCTION app.meta_direct_transition_complete_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;
BEGIN
 IF NEW.meta_direct_identity_resolution IS NULL THEN RETURN NEW; END IF;
 -- Deferred checks validate the final row, including an authorized privacy
 -- tombstone written after an earlier receipt in this same transaction.
 SELECT status,payload,meta_direct_identity_resolution INTO source.status,source.payload,source.meta_direct_identity_resolution
  FROM event_inbox WHERE tenant_id=NEW.tenant_id AND tenant_id=app.current_tenant_id() AND id=NEW.id AND connection_id=NEW.connection_id;
 IF NOT FOUND OR source.meta_direct_identity_resolution IS NULL THEN
  RAISE EXCEPTION 'Meta transition receipt is incomplete' USING ERRCODE='23514'; END IF;
 IF source.status='REDACTED' AND source.payload='{}' AND source.meta_direct_identity_resolution->'redacted'='true'
  AND source.meta_direct_identity_resolution-ARRAY['redacted','sha256']='{}'
  AND jsonb_typeof(source.meta_direct_identity_resolution->'sha256')='string'
  AND source.meta_direct_identity_resolution->>'sha256'~'^[0-9a-f]{64}$' THEN RETURN NEW; END IF;
 IF NOT app.meta_direct_transition_receipt_valid(NEW.id) THEN
  RAISE EXCEPTION 'Meta transition receipt is incomplete' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER meta_direct_resolution_complete AFTER UPDATE ON event_inbox DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION app.meta_direct_transition_complete_check();

CREATE FUNCTION app.meta_direct_transition_admission(event_value uuid,worker_lease uuid,lock_rows boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;session_row provider_sessions%ROWTYPE;participant participant_identities%ROWTYPE;prior event_inbox%ROWTYPE;
 evidence jsonb;receipt jsonb;asset jsonb;previous_value jsonb;current_value jsonb;predecessors jsonb:='[]';successors jsonb:='[]';
 owned_values text[];owner_ids uuid[];owner uuid;anchor_id uuid;customer text;alias_row meta_direct_identity_aliases%ROWTYPE;
 kind_value text;target text;new_id uuid;contenders integer;edge_time timestamptz;last_time timestamptz;blocked boolean;connection_state text;predecessor record;candidate record;edge_key text;unresolved_edges jsonb:='[]';
BEGIN
 IF lock_rows THEN SELECT id,tenant_id,connection_id,provider,status,payload_sha256,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_direct_identity_resolution,lease_id,lease_expires_at,safe_error INTO source.id,source.tenant_id,source.connection_id,source.provider,source.status,source.payload_sha256,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.lease_id,source.lease_expires_at,source.safe_error FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value FOR NO KEY UPDATE NOWAIT;
 ELSE SELECT id,tenant_id,connection_id,provider,status,payload_sha256,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_direct_identity_resolution,lease_id,lease_expires_at,safe_error INTO source.id,source.tenant_id,source.connection_id,source.provider,source.status,source.payload_sha256,source.meta_direct_asset,source.meta_direct_identity_change,source.meta_direct_identity_transition,source.meta_direct_identity_resolution,source.lease_id,source.lease_expires_at,source.safe_error FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value; END IF;
 IF NOT FOUND OR source.provider<>'META' OR source.meta_direct_identity_transition IS NULL THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 -- Source-bound replay is historical, before live lease/current credentials.
 IF app.meta_direct_transition_receipt_valid(source.id) THEN RETURN jsonb_build_object('state','DUPLICATE','receipt',source.meta_direct_identity_resolution); END IF;
 IF source.meta_direct_identity_resolution IS NOT NULL OR source.status NOT IN('PROCESSING','QUARANTINED')
  OR(source.status='QUARANTINED' AND COALESCE(source.safe_error,'') NOT IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT'))
  OR (source.status='PROCESSING' AND (worker_lease IS NOT NULL AND source.lease_id=worker_lease AND source.lease_expires_at>clock_timestamp()) IS NOT TRUE) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 evidence:=source.meta_direct_identity_transition;asset:=source.meta_direct_asset;
 IF evidence->'redacted'='true' OR evidence->>'payloadSha256' IS DISTINCT FROM source.payload_sha256 OR evidence->'asset' IS DISTINCT FROM asset THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 previous_value:=evidence#>'{change,previous}';current_value:=evidence#>'{change,current}';
 IF previous_value ? 'parentBsuid' OR current_value ? 'parentBsuid' THEN RETURN jsonb_build_object('state','HELD','reason','UNSUPPORTED_PARENT'); END IF;
 edge_time:=(evidence->>'providerTimestamp')::timestamptz;
 IF lock_rows THEN
  PERFORM id FROM connections WHERE tenant_id=source.tenant_id AND id=source.connection_id FOR NO KEY UPDATE NOWAIT;
  PERFORM id FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE' FOR NO KEY UPDATE NOWAIT;
 END IF;
 SELECT state INTO connection_state FROM connections WHERE tenant_id=source.tenant_id AND id=source.connection_id AND provider='META';
 SELECT id,tenant_id,connection_id,ownership_state,state,opaque_session_id,provider_state_data INTO session_row.id,session_row.tenant_id,session_row.connection_id,session_row.ownership_state,session_row.state,session_row.opaque_session_id,session_row.provider_state_data FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE';
 IF NOT FOUND OR connection_state<>'WORKING' OR session_row.state<>'WORKING'
  OR jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',session_row.provider_state_data->>'wabaId') IS DISTINCT FROM asset THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
  WHERE session.tenant_id=source.tenant_id AND session.connection_id=source.connection_id AND session.ownership_state='ACTIVE'
   AND session.state='WORKING' AND connection.state='WORKING' AND connection.provider='META'
   AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=source.meta_direct_asset
   AND session.provider_state_data#>>'{metaAccountProof,tenantId}'=source.tenant_id::text AND session.provider_state_data#>>'{metaAccountProof,connectionId}'=source.connection_id::text
   AND session.provider_state_data#>>'{metaAccountProof,secretReference}'=connection.secret_reference AND session.provider_state_data#>>'{metaAccountProof,providerSessionId}'=session.id::text
   AND session.provider_state_data#>>'{metaAccountProof,phoneNumberId}'=session.opaque_session_id AND session.provider_state_data#>>'{metaAccountProof,wabaId}'=session.provider_state_data->>'wabaId'
   AND session.provider_state_data#>>'{metaAccountProof,claim}'='PHONE_ACCOUNT_RELATION_VERIFIED'
   AND session.provider_state_data#>>'{metaAccountProof,credentialMetadata,claim}'='CREDENTIAL_METADATA_VERIFIED'
   AND CASE WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,expiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END
   AND CASE WHEN NOT(session.provider_state_data#>'{metaAccountProof,credentialMetadata}' ? 'dataAccessExpiresAt') THEN true
    WHEN session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}'~'^[0-9]{1,16}$'
     THEN (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric=0 OR (session.provider_state_data#>>'{metaAccountProof,credentialMetadata,dataAccessExpiresAt}')::numeric>extract(epoch from clock_timestamp()) ELSE false END) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF NOT EXISTS(SELECT 1 FROM provider_sessions session CROSS JOIN LATERAL app.meta_lifecycle_guard(
    source.connection_id,session.id,session.opaque_session_id,session.provider_state_data->>'wabaId',
    session.provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}',
    CASE WHEN NOT(session.provider_state_data ? 'metaLifecycle') THEN 0
      WHEN session.provider_state_data#>>'{metaLifecycle,revision}'~'^[0-9]{1,15}$' THEN (session.provider_state_data#>>'{metaLifecycle,revision}')::bigint ELSE -1 END) readiness
   WHERE session.tenant_id=source.tenant_id AND session.connection_id=source.connection_id AND session.ownership_state='ACTIVE'
    AND jsonb_build_object('providerSessionId',session.id::text,'phoneNumberId',session.opaque_session_id,'wabaId',session.provider_state_data->>'wabaId')=source.meta_direct_asset
    AND readiness.revision_matches AND NOT readiness.blocked AND NOT readiness.unresolved_hold) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 -- Qualify the exact semantic edge before invoking the full historical validator.
 -- A SQL AND predicate does not establish evaluation order.
 FOR candidate IN SELECT id,meta_direct_identity_resolution FROM event_inbox
  WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND meta_direct_asset=asset
   AND meta_direct_identity_resolution->>'state'='APPLIED'
   AND app.meta_direct_transition_edge(meta_direct_identity_transition)=app.meta_direct_transition_edge(evidence)
  ORDER BY received_at,id LOOP
  IF app.meta_direct_transition_receipt_valid(candidate.id) THEN
   receipt:=(candidate.meta_direct_identity_resolution-ARRAY['state','evidenceSha256'])||jsonb_build_object('state','DUPLICATE','evidenceSha256',encode(digest(evidence::text,'sha256'),'hex'));
   RETURN jsonb_build_object('state','DUPLICATE','receipt',receipt);
  END IF;
 END LOOP;
 SELECT array_agg(DISTINCT alias.participant_identity_id) INTO owner_ids FROM meta_direct_identity_aliases alias
  WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.provider_session_id=session_row.id
   AND alias.phone_number_id=session_row.opaque_session_id AND alias.waba_id=asset->>'wabaId'
   AND ((alias.kind='PHONE' AND alias.value=previous_value->>'phone') OR(alias.kind='BSUID' AND alias.value=previous_value->>'bsuid'));
 IF COALESCE(cardinality(owner_ids),0)=0 AND previous_value->>'phone' IS NOT NULL AND previous_value->>'bsuid' IS NULL THEN
  SELECT array_agg(p.id) INTO owner_ids FROM participant_identities p WHERE p.tenant_id=source.tenant_id AND p.connection_id=source.connection_id
   AND p.external_participant_id=previous_value->>'phone' AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases a WHERE a.tenant_id=p.tenant_id AND a.participant_identity_id=p.id);
 END IF;
 IF COALESCE(cardinality(owner_ids),0)<>1 THEN RETURN jsonb_build_object('state','HELD','reason','PREDECESSOR_MISSING'); END IF;
 owner:=owner_ids[1];
 IF lock_rows THEN PERFORM id FROM participant_identities WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=owner FOR NO KEY UPDATE NOWAIT; END IF;
 SELECT id,tenant_id,connection_id,external_participant_id INTO participant.id,participant.tenant_id,participant.connection_id,participant.external_participant_id FROM participant_identities WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=owner;
 IF lock_rows THEN PERFORM id FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner ORDER BY id FOR UPDATE NOWAIT; END IF;
 IF EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.participant_identity_id=owner AND
  (alias.provider_session_id<>session_row.id OR alias.phone_number_id<>session_row.opaque_session_id OR alias.waba_id<>asset->>'wabaId')) THEN RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 FOR kind_value,target IN SELECT * FROM(VALUES('PHONE',previous_value->>'phone'),('BSUID',previous_value->>'bsuid')) pairs(kind,value) LOOP
  IF target IS NOT NULL AND NOT (kind_value='PHONE' AND target=participant.external_participant_id AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases a WHERE a.tenant_id=source.tenant_id AND a.participant_identity_id=owner)) AND NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
   AND alias.participant_identity_id=owner AND alias.kind=kind_value AND alias.value=target AND alias.state IN('ACTIVE','HELD')
   AND alias.provider_session_id=session_row.id AND alias.phone_number_id=session_row.opaque_session_id AND alias.waba_id=asset->>'wabaId') THEN
   IF NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases known WHERE known.tenant_id=source.tenant_id AND known.connection_id=source.connection_id
     AND known.provider_session_id=session_row.id AND known.phone_number_id=session_row.opaque_session_id AND known.waba_id=asset->>'wabaId'
     AND known.kind=kind_value AND known.value=target) THEN
    RETURN jsonb_build_object('state','HELD','reason','PREDECESSOR_MISSING'); END IF;
   RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 END LOOP;
 SELECT array_agg(alias.value) INTO owned_values FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.participant_identity_id=owner;
 owned_values:=COALESCE(owned_values,ARRAY[]::text[])||ARRAY[participant.external_participant_id,current_value->>'phone',current_value->>'bsuid'];
 -- One bounded unresolved edge set serves both the cardinality and fork tests.
 -- Iterate only cheap relevant candidates; stop at the original 33rd distinct
 -- semantic edge. Never materialize unbounded history or retain validity across
 -- an alias mutation. NULL resolution cannot satisfy the unchanged validator.
 FOR candidate IN SELECT id,meta_direct_identity_transition,meta_direct_identity_resolution FROM event_inbox
  WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND meta_direct_asset=asset
   AND meta_direct_identity_transition->'schemaVersion'='1'
   AND (meta_direct_identity_transition#>>'{change,previous,phone}'=ANY(owned_values)
    OR meta_direct_identity_transition#>>'{change,previous,bsuid}'=ANY(owned_values)
    OR meta_direct_identity_transition#>>'{change,current,phone}'=ANY(owned_values)
    OR meta_direct_identity_transition#>>'{change,current,bsuid}'=ANY(owned_values)) LOOP
  IF (CASE WHEN candidate.meta_direct_identity_resolution IS NULL THEN true
    ELSE NOT app.meta_direct_transition_receipt_valid(candidate.id) END) THEN
   edge_key:=app.meta_direct_transition_edge(candidate.meta_direct_identity_transition);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(unresolved_edges) edge WHERE edge->>'edge'=edge_key) THEN
    unresolved_edges:=unresolved_edges||jsonb_build_array(jsonb_build_object('edge',edge_key,
     'previousPhone',candidate.meta_direct_identity_transition#>>'{change,previous,phone}',
     'previousBsuid',candidate.meta_direct_identity_transition#>>'{change,previous,bsuid}',
     'currentPhone',candidate.meta_direct_identity_transition#>>'{change,current,phone}',
     'currentBsuid',candidate.meta_direct_identity_transition#>>'{change,current,bsuid}'));
    IF jsonb_array_length(unresolved_edges)>32 THEN RETURN jsonb_build_object('state','HELD','reason','CONTENDER_LIMIT'); END IF;
   END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(unresolved_edges) left_edge
   JOIN jsonb_array_elements(unresolved_edges) right_edge ON right_edge->>'edge'>left_edge->>'edge'
   WHERE (left_edge->>'previousPhone'=right_edge->>'previousPhone' AND left_edge->>'previousPhone'=ANY(owned_values)
      AND (left_edge->>'previousBsuid' IS NULL OR right_edge->>'previousBsuid' IS NULL OR left_edge->>'previousBsuid'=right_edge->>'previousBsuid'))
    OR(left_edge->>'previousBsuid'=right_edge->>'previousBsuid' AND left_edge->>'previousBsuid'=ANY(owned_values))
    OR(left_edge->>'currentPhone'=right_edge->>'currentPhone' AND left_edge->>'currentPhone'=ANY(owned_values)
      AND (left_edge->>'currentBsuid' IS NULL OR right_edge->>'currentBsuid' IS NULL OR left_edge->>'currentBsuid'=right_edge->>'currentBsuid'))
    OR(left_edge->>'currentBsuid'=right_edge->>'currentBsuid' AND left_edge->>'currentBsuid'=ANY(owned_values))) THEN
  RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 -- The immutable source parser emits fixed-width UTC ISO timestamps (or a
 -- redaction tombstone without one). C-order matches chronology without casting
 -- invalid history before receipt validation. Preserve MAX's NULL exclusion and
 -- fall back past invalid newer receipts; no asset predicate narrows the owner.
 FOR candidate IN SELECT old.id,old.meta_direct_identity_transition->>'providerTimestamp' provider_time FROM event_inbox old
  WHERE old.tenant_id=source.tenant_id AND old.connection_id=source.connection_id
   AND old.meta_direct_identity_resolution->>'participantId'=owner::text
   AND old.meta_direct_identity_resolution->>'state'='APPLIED'
  ORDER BY (old.meta_direct_identity_transition->>'providerTimestamp') COLLATE "C" DESC NULLS LAST,old.id LOOP
  IF candidate.provider_time IS NOT NULL THEN
   IF app.meta_direct_transition_receipt_valid(candidate.id) THEN
    last_time:=candidate.provider_time::timestamptz;EXIT;
   END IF;
  END IF;
 END LOOP;
 IF last_time IS NOT NULL AND edge_time<=last_time THEN RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
 -- Cheap ordinary source/address candidates precede either bridge or root
 -- validation. The loops retain the original earliest-valid-root semantics.
 FOR candidate IN SELECT anchor.id,COALESCE(message.provider_metadata->>'zammad_customer_id',anchor.meta_direct_native_anchor->>'nativeCustomerId') native_customer
  FROM event_inbox anchor LEFT JOIN normalized_messages message ON message.tenant_id=anchor.tenant_id AND message.event_inbox_id=anchor.id
  WHERE anchor.tenant_id=source.tenant_id AND anchor.connection_id=source.connection_id AND anchor.meta_direct_asset=asset
   AND anchor.meta_direct_identity_change IS NULL AND anchor.status IN('PROCESSED','REDACTED')
  ORDER BY anchor.received_at,anchor.id LOOP
  blocked:=NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases existing WHERE existing.tenant_id=source.tenant_id AND existing.participant_identity_id=owner)
   OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases origin WHERE origin.tenant_id=source.tenant_id AND origin.connection_id=source.connection_id
    AND origin.participant_identity_id=owner AND origin.source_event_id=candidate.id);
  IF NOT blocked THEN
   -- Each bridge candidate is already linked to this owner's alias and root.
   FOR predecessor IN SELECT DISTINCT bridge.id FROM meta_direct_identity_aliases origin JOIN event_inbox bridge
     ON bridge.tenant_id=origin.tenant_id AND bridge.connection_id=origin.connection_id AND bridge.id=origin.source_event_id
    WHERE origin.tenant_id=source.tenant_id AND origin.connection_id=source.connection_id AND origin.participant_identity_id=owner
     AND bridge.meta_direct_identity_resolution->>'anchorEventId'=candidate.id::text LOOP
    IF app.meta_direct_transition_receipt_valid(predecessor.id) THEN blocked:=true;EXIT; END IF;
   END LOOP;
  END IF;
  IF blocked THEN
   IF app.meta_direct_transition_anchor_valid(candidate.id,owner,candidate.native_customer,true) THEN
    anchor_id:=candidate.id;customer:=candidate.native_customer;EXIT;
   END IF;
  END IF;
 END LOOP;
 IF anchor_id IS NULL OR EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=source.tenant_id AND message.connection_id=source.connection_id
  AND message.external_group_id=participant.external_participant_id AND message.provider_metadata->'direct'='true' AND message.provider_metadata->>'zammad_customer_id'<>customer) THEN
  RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 IF lock_rows THEN PERFORM id FROM bot_conversations WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND external_chat_id=participant.external_participant_id ORDER BY id FOR NO KEY UPDATE NOWAIT; END IF;
 IF NOT app.meta_direct_transition_privacy_clear(source.connection_id,owner,owned_values,source.id) THEN RETURN jsonb_build_object('state','HELD','reason','PRIVACY'); END IF;
 FOR predecessor IN SELECT id,revision FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner AND state IN('ACTIVE','HELD') ORDER BY kind LOOP
  predecessors:=predecessors||jsonb_build_array(jsonb_build_object('id',predecessor.id::text,'revision',predecessor.revision));
 END LOOP;
 FOR kind_value,target IN SELECT * FROM(VALUES('PHONE',current_value->>'phone'),('BSUID',current_value->>'bsuid')) pairs(kind,value) LOOP
  IF target IS NULL THEN CONTINUE; END IF;
  SELECT id,tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,state,revision INTO alias_row.id,alias_row.tenant_id,alias_row.connection_id,alias_row.participant_identity_id,alias_row.provider_session_id,alias_row.phone_number_id,alias_row.waba_id,alias_row.kind,alias_row.value,alias_row.state,alias_row.revision FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id
   AND provider_session_id=session_row.id AND phone_number_id=session_row.opaque_session_id AND waba_id=asset->>'wabaId' AND kind=kind_value AND value=target;
  IF FOUND AND (alias_row.participant_identity_id<>owner OR alias_row.state='RETIRED') THEN RETURN jsonb_build_object('state','HELD','reason','CONFLICT'); END IF;
  IF FOUND THEN successors:=successors||jsonb_build_array(jsonb_build_object('id',alias_row.id::text,'revision',alias_row.revision+CASE WHEN alias_row.state='HELD' THEN 1 ELSE 0 END));
  ELSE successors:=successors||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'revision',1)); END IF;
 END LOOP;
 IF NOT app.meta_direct_transition_effects_clear(source.connection_id,owner) THEN RETURN jsonb_build_object('state','HELD','reason','PENDING_EFFECT'); END IF;
 RETURN jsonb_build_object('state','READY','participantId',owner::text,'canonical',participant.external_participant_id,'anchorEventId',anchor_id::text,'nativeCustomerId',customer,'predecessorAliases',predecessors,'successorAliases',successors);
END;
$$;

CREATE FUNCTION app.apply_meta_direct_transition_edge(event_value uuid,worker_lease uuid,hold_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE source event_inbox%ROWTYPE;session_row provider_sessions%ROWTYPE;participant participant_identities%ROWTYPE;prior event_inbox%ROWTYPE;
 evidence jsonb;receipt jsonb;asset jsonb;previous_value jsonb;current_value jsonb;predecessors jsonb:='[]';successors jsonb:='[]';
 owned_values text[];owner_ids uuid[];owner uuid;anchor_id uuid;customer text;alias_row meta_direct_identity_aliases%ROWTYPE;
 kind_value text;target text;new_id uuid;contenders integer;edge_time timestamptz;last_time timestamptz;blocked boolean;connection_state text;predecessor record;
BEGIN
 IF NOT pg_has_role(session_user,'wasalx_connector_worker','member') THEN RAISE EXCEPTION 'Meta transition mutation is worker-only' USING ERRCODE='42501'; END IF;
 -- Exact historical receipt is read-only even while privacy/current effects
 -- are held. Any new sealing, including a new duplicate source, shares privacy.
 IF app.meta_direct_transition_receipt_valid(event_value) THEN
  SELECT meta_direct_identity_resolution INTO receipt FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
  RETURN jsonb_build_object('state','DUPLICATE','receipt',receipt);
 END IF;
 IF hold_only IS NULL THEN RAISE EXCEPTION 'Meta transition mode is required' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value
  AND provider='META' AND event_type='messages') THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
 -- Scheduling is a hint. Lock current worker-eligible tenant authority before
 -- privacy/source locks; the existing definer owns this lock, not the caller.
 PERFORM id FROM tenants WHERE id=app.current_tenant_id() AND state IN('ACTIVE','PROVISIONING') FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','HELD','reason','TENANT_UNAVAILABLE'); END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('privacy:'||app.current_tenant_id()::text,0)) THEN RETURN jsonb_build_object('state','HELD','reason','BUSY'); END IF;
 -- Local runtime-proof denial or legacy evidence can only fence its original
 -- live source. It cannot enter positive admission, mint a receipt or follow edges.
 IF hold_only THEN
  SELECT * INTO source FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value FOR NO KEY UPDATE NOWAIT;
  IF source.status IS DISTINCT FROM 'PROCESSING' OR source.meta_direct_identity_resolution IS NOT NULL
   OR (worker_lease IS NOT NULL AND source.lease_id=worker_lease AND source.lease_expires_at>clock_timestamp()) IS NOT TRUE
   OR app.meta_direct_source_change_marker(source.payload,source.payload_sha256) IS NULL THEN
   RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
  PERFORM id FROM connections WHERE tenant_id=source.tenant_id AND id=source.connection_id AND provider='META' FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
  SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE' FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND OR(source.meta_direct_asset IS NOT NULL AND source.meta_direct_asset IS DISTINCT FROM
   jsonb_build_object('providerSessionId',session_row.id::text,'phoneNumberId',session_row.opaque_session_id,'wabaId',session_row.provider_state_data->>'wabaId')) THEN
   RETURN jsonb_build_object('state','HELD','reason','SOURCE_UNAVAILABLE'); END IF;
  RETURN jsonb_build_object('state','HELD','reason','REQUIRES_REVIEW');
 END IF;
 receipt:=app.meta_direct_transition_admission(event_value,worker_lease,true);
 IF receipt->>'state'='HELD' THEN RETURN receipt; END IF;
 SELECT * INTO source FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 IF receipt->>'state'='DUPLICATE' THEN
  IF source.meta_direct_identity_resolution IS NULL THEN
   UPDATE event_inbox SET meta_direct_identity_resolution=receipt->'receipt',status='PROCESSED',processed_at=now(),lease_id=NULL,lease_expires_at=NULL,
    payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),provider_event_id='redacted:'||provider_event_id_sha256,safe_error=NULL WHERE id=source.id AND tenant_id=source.tenant_id
     AND ((status='PROCESSING' AND worker_lease IS NOT NULL AND lease_id=worker_lease AND lease_expires_at>clock_timestamp())
       OR(status='QUARANTINED' AND safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT')));
   IF NOT FOUND THEN RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN receipt;
 END IF;
 owner:=(receipt->>'participantId')::uuid;anchor_id:=(receipt->>'anchorEventId')::uuid;customer:=receipt->>'nativeCustomerId';
 predecessors:=receipt->'predecessorAliases';successors:=receipt->'successorAliases';
 SELECT * INTO participant FROM participant_identities WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND id=owner;
 SELECT * INTO session_row FROM provider_sessions WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND ownership_state='ACTIVE';
 evidence:=source.meta_direct_identity_transition;asset:=source.meta_direct_asset;current_value:=evidence#>'{change,current}';
 -- Cancel only never-attempted, never-leased QUEUED work. Immutable recipient,
 -- content and idempotency remain history; no replacement reply is enqueued.
 UPDATE delivery_outbox delivery SET state='FAILED_TERMINAL',manual_retry_allowed=false,safe_error='Recipient changed before any dispatch.',updated_at=now()
  FROM bot_conversations conversation WHERE delivery.tenant_id=source.tenant_id AND conversation.tenant_id=delivery.tenant_id AND delivery.connection_id=conversation.connection_id AND (conversation.id=delivery.bot_conversation_id OR(delivery.direct_origin IS NOT NULL AND delivery.external_chat_id=conversation.external_chat_id AND delivery.zammad_ticket_id=conversation.zammad_ticket_id))
   AND conversation.connection_id=source.connection_id AND conversation.external_chat_id=participant.external_participant_id
   AND delivery.state='QUEUED' AND delivery.attempts=0 AND delivery.lease_id IS NULL AND NOT EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.tenant_id=delivery.tenant_id AND attempt.delivery_id=delivery.id);
 receipt:=jsonb_build_object('schemaVersion',1,'state','APPLIED','evidenceSha256',encode(digest(evidence::text,'sha256'),'hex'),'participantId',owner::text,
  'canonical',participant.external_participant_id,'nativeCustomerId',customer,'anchorEventId',anchor_id::text,'predecessorAliases',predecessors,'successorAliases',successors,'appliedEventId',source.id::text);
 UPDATE event_inbox SET meta_direct_identity_resolution=receipt,status='PROCESSED',processed_at=now(),lease_id=NULL,lease_expires_at=NULL,
  payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),provider_event_id='redacted:'||provider_event_id_sha256,safe_error=NULL WHERE id=source.id AND tenant_id=source.tenant_id
     AND ((status='PROCESSING' AND worker_lease IS NOT NULL AND lease_id=worker_lease AND lease_expires_at>clock_timestamp())
       OR(status='QUARANTINED' AND safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT')));
   IF NOT FOUND THEN RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
 UPDATE meta_direct_identity_aliases SET state='RETIRED',revision=revision+1 WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner
  AND state IN('ACTIVE','HELD') AND ((kind='PHONE' AND value IS DISTINCT FROM current_value->>'phone') OR(kind='BSUID' AND value IS DISTINCT FROM current_value->>'bsuid'));
 UPDATE meta_direct_identity_aliases SET state='ACTIVE',revision=revision+1 WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner AND state='HELD'
  AND ((kind='PHONE' AND value=current_value->>'phone') OR(kind='BSUID' AND value=current_value->>'bsuid'));
 FOR kind_value,target IN SELECT * FROM(VALUES('PHONE',current_value->>'phone'),('BSUID',current_value->>'bsuid')) pairs(kind,value) LOOP
  IF target IS NULL OR EXISTS(SELECT 1 FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id AND participant_identity_id=owner AND kind=kind_value AND value=target AND state='ACTIVE') THEN CONTINUE; END IF;
  SELECT (item->>'id')::uuid INTO new_id FROM jsonb_array_elements(successors) item WHERE NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases WHERE id=(item->>'id')::uuid) LIMIT 1;
  INSERT INTO meta_direct_identity_aliases(id,tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,source_event_id,source_payload_sha256)
   VALUES(new_id,source.tenant_id,source.connection_id,owner,session_row.id,session_row.opaque_session_id,asset->>'wabaId',kind_value,target,source.id,source.payload_sha256);
 END LOOP;
 -- Canonical participant/native profile is unchanged; active aliases own transport identity.
 RETURN jsonb_build_object('state','APPLIED','receipt',receipt);
-- Every reversed caller lock acquisition is finite: NOWAIT cannot wait on a
-- tenant/source/connection lock cycle, and the exception subtransaction rolls back.
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('state','HELD','reason','BUSY');
END;
$$;

CREATE FUNCTION app.drain_meta_direct_transitions(event_value uuid,worker_lease uuid,hold_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE first_result jsonb;result jsonb;source event_inbox%ROWTYPE;owner uuid;next_id uuid;step integer;applied_ids jsonb:='[]';known_values text[];
BEGIN
 first_result:=app.apply_meta_direct_transition_edge(event_value,worker_lease,hold_only);
 SELECT * INTO source FROM event_inbox WHERE tenant_id=app.current_tenant_id() AND id=event_value;
 IF first_result->>'state'='DUPLICATE' THEN RETURN first_result; END IF;
 IF first_result->>'state'='HELD' THEN
  -- Failure to obtain authority is read-only, including quarantine relabeling.
  IF first_result->>'reason' IN('BUSY','TENANT_UNAVAILABLE') OR source.provider IS DISTINCT FROM 'META'
    OR(hold_only AND first_result->>'reason' IS DISTINCT FROM 'REQUIRES_REVIEW')
    OR(NOT hold_only AND source.meta_direct_identity_transition IS NULL) THEN RETURN first_result; END IF;
  IF source.status='PROCESSING' AND (worker_lease IS NOT NULL AND source.lease_id=worker_lease AND source.lease_expires_at>clock_timestamp()) IS TRUE THEN
   UPDATE meta_direct_identity_aliases alias SET state='HELD',revision=revision+1 WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
    AND alias.state='ACTIVE' AND jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)=source.meta_direct_asset
    AND alias.participant_identity_id IN(SELECT prior.participant_identity_id FROM meta_direct_identity_aliases prior WHERE prior.tenant_id=source.tenant_id
      AND prior.connection_id=source.connection_id AND jsonb_build_object('providerSessionId',prior.provider_session_id::text,'phoneNumberId',prior.phone_number_id,'wabaId',prior.waba_id)=source.meta_direct_asset
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(source.meta_direct_identity_change,app.meta_direct_source_change_marker(source.payload,source.payload_sha256))->'previous') previous
        WHERE previous->>'kind'=prior.kind AND previous->>'value'=prior.value));
   UPDATE event_inbox SET status='QUARANTINED',payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),provider_event_id='redacted:'||provider_event_id_sha256,
    processed_at=now(),lease_id=NULL,lease_expires_at=NULL,safe_error=CASE WHEN hold_only THEN 'META_IDENTITY_CHANGE_REQUIRES_REVIEW' ELSE 'META_IDENTITY_TRANSITION_'||(first_result->>'reason') END,updated_at=now() WHERE tenant_id=source.tenant_id AND id=source.id
      AND status='PROCESSING' AND worker_lease IS NOT NULL AND lease_id=worker_lease AND lease_expires_at>clock_timestamp();
    -- An expiry while fencing aliases must roll back the whole statement.
    IF NOT FOUND THEN RAISE EXCEPTION 'Meta transition source lease is no longer current' USING ERRCODE='55000'; END IF;
  END IF;
  IF source.status='QUARANTINED' AND source.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT')
    AND first_result->>'reason' NOT IN('BUSY','PENDING_EFFECT','PREDECESSOR_MISSING') THEN
   UPDATE event_inbox SET safe_error='META_IDENTITY_TRANSITION_'||(first_result->>'reason'),updated_at=now() WHERE tenant_id=source.tenant_id AND id=source.id;
  END IF;
  RETURN first_result;
 END IF;
 owner:=(first_result#>>'{receipt,participantId}')::uuid;applied_ids:=jsonb_build_array(event_value::text);
 -- B->C held before A->B becomes reachable only after B is actually owned.
 -- No native/provider work or raw event replay occurs in this bounded drain.
 FOR step IN 2..32 LOOP
  SELECT array_agg(value) INTO known_values FROM meta_direct_identity_aliases WHERE tenant_id=source.tenant_id AND connection_id=source.connection_id
   AND participant_identity_id=owner AND state IN('ACTIVE','HELD');
  SELECT candidate.id INTO next_id FROM event_inbox candidate WHERE candidate.tenant_id=source.tenant_id AND candidate.connection_id=source.connection_id
   AND candidate.meta_direct_asset=source.meta_direct_asset AND candidate.status='QUARANTINED' AND candidate.meta_direct_identity_resolution IS NULL
   AND candidate.meta_direct_identity_transition->'schemaVersion'='1'
   AND candidate.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT')
   AND (candidate.meta_direct_identity_transition#>>'{change,previous,phone}'=ANY(known_values) OR candidate.meta_direct_identity_transition#>>'{change,previous,bsuid}'=ANY(known_values))
   ORDER BY (candidate.meta_direct_identity_transition->>'providerTimestamp')::timestamptz,candidate.id LIMIT 1;
  EXIT WHEN next_id IS NULL;
  result:=app.apply_meta_direct_transition_edge(next_id,NULL);
  IF result->>'state'='HELD' THEN
   IF result->>'reason' NOT IN('BUSY','TENANT_UNAVAILABLE','PENDING_EFFECT','PREDECESSOR_MISSING') THEN UPDATE event_inbox SET safe_error='META_IDENTITY_TRANSITION_'||(result->>'reason'),updated_at=now() WHERE tenant_id=source.tenant_id AND id=next_id; END IF;
   EXIT;
  END IF;
  applied_ids:=applied_ids||jsonb_build_array(next_id::text);
 END LOOP;
 IF jsonb_array_length(applied_ids)=32 AND EXISTS(SELECT 1 FROM event_inbox pending JOIN meta_direct_identity_aliases alias
   ON alias.tenant_id=pending.tenant_id AND alias.connection_id=pending.connection_id AND alias.participant_identity_id=owner
    AND alias.state IN('ACTIVE','HELD') AND ((alias.kind='PHONE' AND alias.value=pending.meta_direct_identity_transition#>>'{change,previous,phone}')
     OR(alias.kind='BSUID' AND alias.value=pending.meta_direct_identity_transition#>>'{change,previous,bsuid}'))
   WHERE pending.tenant_id=source.tenant_id AND pending.connection_id=source.connection_id AND pending.meta_direct_asset=source.meta_direct_asset
    AND pending.status='QUARANTINED' AND pending.meta_direct_identity_resolution IS NULL
    AND pending.safe_error IN('META_IDENTITY_TRANSITION_PREDECESSOR_MISSING','META_IDENTITY_TRANSITION_PENDING_EFFECT')) THEN
  RETURN first_result||jsonb_build_object('appliedEventIds',applied_ids,'remainingHeld',true,'reason','DRAIN_LIMIT');
 END IF;
 RETURN first_result||jsonb_build_object('appliedEventIds',applied_ids);
END;
$$;

-- Ordinary aliases retain the existing source validator. Only an already
-- sealed, effect-fenced transition may authorize its exact successor rows.
DO $$ DECLARE old_function text;new_function text; BEGIN
 old_function:=pg_get_functiondef('app.guard_meta_direct_alias()'::regprocedure);
 new_function:=replace(old_function,' IF TG_OP=''INSERT'' THEN', $body$
 IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=NEW.tenant_id AND source.connection_id=NEW.connection_id
   AND source.id=NEW.source_event_id AND source.meta_direct_identity_resolution->>'state'='APPLIED'
   AND source.meta_direct_identity_resolution->>'participantId'=NEW.participant_identity_id::text
   AND source.payload_sha256=NEW.source_payload_sha256 AND source.meta_direct_identity_transition->>'payloadSha256'=NEW.source_payload_sha256
   AND source.meta_direct_asset=jsonb_build_object('providerSessionId',NEW.provider_session_id::text,'phoneNumberId',NEW.phone_number_id,'wabaId',NEW.waba_id)
   AND NEW.value=CASE NEW.kind WHEN 'PHONE' THEN source.meta_direct_identity_transition#>>'{change,current,phone}' ELSE source.meta_direct_identity_transition#>>'{change,current,bsuid}' END
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_resolution->'successorAliases') slot WHERE slot->>'id'=NEW.id::text AND slot->>'revision'=NEW.revision::text)) THEN
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN$body$);
 new_function:=replace(new_function,' ELSIF TG_OP=''UPDATE'' THEN', $body$
 ELSIF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','revision']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision'])
  AND OLD.state IN('ACTIVE','HELD') AND NEW.revision=OLD.revision+1 AND EXISTS(SELECT 1 FROM event_inbox source
   WHERE source.tenant_id=OLD.tenant_id AND source.connection_id=OLD.connection_id AND source.meta_direct_identity_resolution->>'state'='APPLIED'
    AND source.meta_direct_identity_resolution->>'participantId'=OLD.participant_identity_id::text
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_resolution->'predecessorAliases') prior WHERE prior->>'id'=OLD.id::text AND prior->>'revision'=OLD.revision::text)
    AND ((NEW.state='RETIRED' AND NEW.value IS DISTINCT FROM CASE NEW.kind WHEN 'PHONE' THEN source.meta_direct_identity_transition#>>'{change,current,phone}' ELSE source.meta_direct_identity_transition#>>'{change,current,bsuid}' END)
     OR(OLD.state='HELD' AND NEW.state='ACTIVE' AND EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_resolution->'successorAliases') slot WHERE slot->>'id'=NEW.id::text AND slot->>'revision'=NEW.revision::text)))) THEN
  RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN$body$);
 -- Retired rows are history, not conflicting current slots during ordinary intake.
 new_function:=replace(new_function,'AND prior.participant_identity_id=NEW.participant_identity_id','AND prior.participant_identity_id=NEW.participant_identity_id AND prior.state<>''RETIRED''');
 IF new_function=old_function THEN RAISE EXCEPTION 'Meta alias source guard was not amended'; END IF;EXECUTE new_function;
END $$;

CREATE OR REPLACE FUNCTION app.meta_direct_identity_guard(connection_value uuid,session_value uuid,phone_value text,waba_value text,participant_value uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=app.current_tenant_id() AND alias.connection_id=connection_value
  AND alias.provider_session_id=session_value AND alias.phone_number_id=phone_value AND alias.waba_id IS NOT DISTINCT FROM waba_value
  AND alias.state='HELD' AND (participant_value IS NULL OR alias.participant_identity_id=participant_value))
 AND NOT EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.connection_id=connection_value AND source.provider='META'
  AND source.meta_direct_asset=jsonb_build_object('providerSessionId',session_value::text,'phoneNumberId',phone_value,'wabaId',waba_value)
  AND source.meta_direct_identity_change IS NOT NULL AND NOT app.meta_direct_transition_receipt_valid(source.id)
  AND (source.meta_direct_identity_change->>'payloadSha256' IS DISTINCT FROM source.payload_sha256 OR source.meta_direct_identity_change->'redacted'='true'
   OR source.meta_direct_identity_change->>'scope'='ASSET' OR participant_value IS NULL
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_change->'previous') previous
     JOIN meta_direct_identity_aliases alias ON alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
      AND alias.provider_session_id=session_value AND alias.phone_number_id=phone_value AND alias.waba_id IS NOT DISTINCT FROM waba_value
      AND alias.kind=previous->>'kind' AND alias.value=previous->>'value')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_change->'previous') previous JOIN meta_direct_identity_aliases alias
    ON alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id AND alias.participant_identity_id=participant_value
     AND alias.provider_session_id=session_value AND alias.phone_number_id=phone_value AND alias.waba_id IS NOT DISTINCT FROM waba_value
     AND alias.kind=previous->>'kind' AND alias.value=previous->>'value')))
$$;

-- The capsule remains rooted in its original ordinary source. A live successor
-- may retain that root through an immutable validated transition receipt; this
-- does not retain raw content or authorize an explicit old queued source.
CREATE OR REPLACE FUNCTION app.meta_direct_anchor_needed(event_value uuid,job_value uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM event_inbox source JOIN participant_identities participant
  ON participant.tenant_id=source.tenant_id AND participant.connection_id=source.connection_id AND
   (participant.id::text=source.meta_direct_native_anchor->>'participantId' OR(source.meta_direct_native_anchor IS NULL AND EXISTS(
    SELECT 1 FROM normalized_messages message WHERE message.tenant_id=source.tenant_id AND message.event_inbox_id=source.id
     AND message.external_participant_id=participant.external_participant_id AND message.external_group_id=participant.external_participant_id
     AND message.provider_metadata->'direct'='true')))
  JOIN meta_direct_identity_aliases alias ON alias.tenant_id=participant.tenant_id AND alias.connection_id=participant.connection_id
   AND alias.participant_identity_id=participant.id
  JOIN event_inbox origin ON origin.tenant_id=alias.tenant_id AND origin.connection_id=alias.connection_id AND origin.id=alias.source_event_id
  WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value AND alias.state IN('ACTIVE','HELD')
   AND (alias.source_event_id=source.id OR(origin.meta_direct_identity_resolution->>'anchorEventId'=source.id::text
     AND origin.meta_direct_identity_resolution->>'participantId'=participant.id::text AND app.meta_direct_transition_receipt_valid(origin.id)))
   AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=source.tenant_id AND target.job_id=job_value
    AND target.target_type='META_DIRECT_ALIAS' AND target.target_id=alias.id::text)
   AND EXISTS(SELECT 1 FROM bot_conversations conversation WHERE conversation.tenant_id=participant.tenant_id
    AND conversation.connection_id=participant.connection_id AND conversation.external_chat_id=participant.external_participant_id
    AND NOT EXISTS(SELECT 1 FROM privacy_job_targets target WHERE target.tenant_id=source.tenant_id AND target.job_id=job_value
     AND target.target_type='ZAMMAD_TICKET' AND target.target_id=conversation.zammad_ticket_id)))
$$;

-- Legacy numeric origins may have no P03a alias row. Only an already sealed
-- signed transition can bind that still-present ordinary completion as its root.
-- Keep all original 0164 capture/lease/raw/native/link/privacy checks unchanged.
DO $$ DECLARE before_definition text;after_definition text; BEGIN
 before_definition:=pg_get_functiondef('app.guard_meta_direct_native_anchor()'::regprocedure);
 after_definition:=replace(before_definition,$old$alias.source_event_id=OLD.id AND alias.source_payload_sha256=OLD.payload_sha256$old$,
  $new$(alias.source_event_id=OLD.id AND alias.source_payload_sha256=OLD.payload_sha256 OR EXISTS(
   SELECT 1 FROM event_inbox origin WHERE origin.tenant_id=OLD.tenant_id AND origin.connection_id=OLD.connection_id
    AND origin.id=alias.source_event_id AND origin.meta_direct_identity_resolution->>'anchorEventId'=OLD.id::text
    AND origin.meta_direct_identity_resolution->>'nativeCustomerId'=anchor->>'nativeCustomerId'
    AND origin.meta_direct_identity_resolution->>'participantId'=alias.participant_identity_id::text
    AND app.meta_direct_transition_receipt_valid(origin.id)))$new$);
 IF before_definition=after_definition THEN RAISE EXCEPTION 'Meta ordinary anchor guard source boundary was not amended'; END IF;
 EXECUTE after_definition;
 before_definition:=pg_get_functiondef('app.seal_meta_direct_native_anchor(uuid)'::regprocedure);
 after_definition:=replace(before_definition,$old$AND alias.source_event_id=source.id)$old$,
  $new$AND (alias.source_event_id=source.id OR EXISTS(SELECT 1 FROM event_inbox origin
    WHERE origin.tenant_id=source.tenant_id AND origin.connection_id=source.connection_id AND origin.id=alias.source_event_id
     AND origin.meta_direct_identity_resolution->>'anchorEventId'=source.id::text
     AND origin.meta_direct_identity_resolution->>'nativeCustomerId'=message.provider_metadata->>'zammad_customer_id'
     AND origin.meta_direct_identity_resolution->>'participantId'=participant.id::text AND app.meta_direct_transition_receipt_valid(origin.id))))$new$);
 IF before_definition=after_definition THEN RAISE EXCEPTION 'Meta ordinary anchor seal source boundary was not amended'; END IF;
 EXECUTE after_definition;
END $$;

CREATE OR REPLACE FUNCTION app.meta_direct_alias_source_valid(alias_value uuid,canonical_value text,customer_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias JOIN participant_identities participant
  ON participant.tenant_id=alias.tenant_id AND participant.connection_id=alias.connection_id AND participant.id=alias.participant_identity_id
  JOIN event_inbox source ON source.tenant_id=alias.tenant_id AND source.connection_id=alias.connection_id AND source.id=alias.source_event_id
  WHERE alias.tenant_id=app.current_tenant_id() AND alias.id=alias_value AND alias.state='ACTIVE' AND participant.external_participant_id=canonical_value
   AND source.payload_sha256=alias.source_payload_sha256
   AND source.meta_direct_asset=jsonb_build_object('providerSessionId',alias.provider_session_id::text,'phoneNumberId',alias.phone_number_id,'wabaId',alias.waba_id)
   AND ((source.meta_direct_identity_change IS NULL AND (app.meta_direct_native_anchor_valid(source.id,alias.participant_identity_id,customer_value,true) OR(source.status NOT IN('REDACTED','QUARANTINED','UNMATCHED','IGNORED') AND source.event_type='messages' AND source.payload#>>'{entry,0,changes,0,field}'='messages' AND EXISTS(SELECT 1 FROM normalized_messages message WHERE message.tenant_id=source.tenant_id
     AND message.connection_id=source.connection_id AND message.event_inbox_id=source.id AND message.external_group_id=canonical_value
     AND message.external_participant_id=canonical_value AND message.provider_metadata->'direct'='true' AND message.provider_metadata->>'zammad_customer_id'=customer_value AND message.processing_status<>'REDACTED'))))
    OR(app.meta_direct_transition_receipt_valid(source.id) AND source.meta_direct_identity_resolution->>'canonical'=canonical_value
     AND source.meta_direct_identity_resolution->>'nativeCustomerId'=customer_value AND source.meta_direct_identity_resolution->>'participantId'=alias.participant_identity_id::text
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(source.meta_direct_identity_resolution->'successorAliases') slot WHERE slot->>'id'=alias.id::text
      AND (slot->>'revision')::bigint<=alias.revision))))
$$;

CREATE OR REPLACE FUNCTION app.meta_direct_event_matches_scope(event_value uuid,scope_value text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM event_inbox source WHERE source.tenant_id=app.current_tenant_id() AND source.id=event_value AND (
  scope_value=ANY(ARRAY[source.meta_direct_identity_transition#>>'{change,previous,phone}',source.meta_direct_identity_transition#>>'{change,previous,bsuid}',
   source.meta_direct_identity_transition#>>'{change,previous,parentBsuid}',source.meta_direct_identity_transition#>>'{change,current,phone}',
   source.meta_direct_identity_transition#>>'{change,current,bsuid}',source.meta_direct_identity_transition#>>'{change,current,parentBsuid}'])
  OR EXISTS(SELECT 1 FROM participant_identities participant WHERE participant.tenant_id=source.tenant_id AND participant.connection_id=source.connection_id
   AND participant.id::text IN(source.meta_direct_native_anchor->>'participantId',source.meta_direct_identity_resolution->>'participantId')
   AND app.meta_direct_participant_matches(participant.connection_id,participant.external_participant_id,scope_value))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source.meta_direct_identity_change->'previous')='array' THEN source.meta_direct_identity_change->'previous' ELSE '[]'::jsonb END) previous
   WHERE app.meta_direct_participant_matches(source.connection_id,previous->>'value',scope_value))))
$$;

REVOKE ALL ON FUNCTION app.meta_direct_source_transition(jsonb,text,jsonb),app.meta_direct_transition_edge(jsonb),app.meta_direct_transition_anchor_valid(uuid,uuid,text,boolean),app.meta_direct_transition_receipt_valid(uuid),
 app.meta_direct_transition_effects_clear(uuid,uuid),app.meta_direct_transition_privacy_clear(uuid,uuid,text[],uuid),app.apply_meta_direct_transition_edge(uuid,uuid,boolean),app.drain_meta_direct_transitions(uuid,uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_meta_direct_transition_edge(uuid,uuid,boolean),app.drain_meta_direct_transitions(uuid,uuid,boolean) FROM wasalx_app;
REVOKE ALL ON FUNCTION app.meta_direct_alias_source_valid(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.meta_direct_event_matches_scope(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meta_direct_source_transition(jsonb,text,jsonb),app.meta_direct_transition_anchor_valid(uuid,uuid,text,boolean),app.meta_direct_transition_receipt_valid(uuid),app.meta_direct_alias_source_valid(uuid,text,text) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.meta_direct_event_matches_scope(uuid,text) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.meta_direct_transition_edge(jsonb),app.meta_direct_transition_effects_clear(uuid,uuid),app.meta_direct_transition_privacy_clear(uuid,uuid,text[],uuid) TO wasalx_app,wasalx_connector_worker;
GRANT EXECUTE ON FUNCTION app.apply_meta_direct_transition_edge(uuid,uuid,boolean),app.drain_meta_direct_transitions(uuid,uuid,boolean) TO wasalx_connector_worker;

CREATE INDEX meta_direct_transition_held_scan ON event_inbox(id,tenant_id)
 WHERE provider='META' AND status='QUARANTINED' AND meta_direct_identity_resolution IS NULL
  AND safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING');

-- Actual-scan continuation belongs to the existing scheduler process. This
-- reader returns the last examined UUID even when every candidate is held.
-- No source is claimed or mutated, and the cursor never grants authority.
CREATE FUNCTION app.scan_meta_direct_transition_work(scan_limit integer DEFAULT 32,after_event uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,app,pg_temp SET row_security=off AS $$
DECLARE candidate record;saved_tenant text:=current_setting('app.tenant_id',true);
 examined integer:=0;last_examined uuid;ready jsonb:='[]';page_start uuid:=after_event;
BEGIN
 IF scan_limit IS NULL OR scan_limit NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'Meta transition scan must be between 1 and 32' USING ERRCODE='22023'; END IF;
 -- At most one empty end-of-list probe, then one bounded wrapped page.
 IF page_start IS NOT NULL AND NOT EXISTS(SELECT 1 FROM event_inbox source JOIN tenants tenant ON tenant.id=source.tenant_id
  WHERE tenant.state IN('ACTIVE','PROVISIONING') AND source.provider='META' AND source.status='QUARANTINED'
   AND source.meta_direct_identity_resolution IS NULL AND source.safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING')
   AND source.id>page_start) THEN page_start:=NULL; END IF;
 FOR candidate IN SELECT source.id,source.tenant_id FROM event_inbox source JOIN tenants tenant ON tenant.id=source.tenant_id
  WHERE tenant.state IN('ACTIVE','PROVISIONING') AND source.provider='META' AND source.status='QUARANTINED'
   AND source.meta_direct_identity_resolution IS NULL AND source.safe_error IN('META_IDENTITY_TRANSITION_PENDING_EFFECT','META_IDENTITY_TRANSITION_PREDECESSOR_MISSING')
   AND (page_start IS NULL OR source.id>page_start) ORDER BY source.id LIMIT scan_limit LOOP
  examined:=examined+1;last_examined:=candidate.id;
  PERFORM set_config('app.tenant_id',candidate.tenant_id::text,true);
  IF app.meta_direct_transition_admission(candidate.id,NULL,false)->>'state'='READY' THEN
   ready:=ready||jsonb_build_array(jsonb_build_object('tenantId',candidate.tenant_id::text,'eventId',candidate.id::text));
  END IF;
 END LOOP;
 PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);
 RETURN jsonb_build_object('nextCursor',last_examined,'examined',examined,'ready',ready);
EXCEPTION WHEN OTHERS THEN
 PERFORM set_config('app.tenant_id',COALESCE(saved_tenant,''),true);RAISE;
END;
$$;
ALTER FUNCTION app.scan_meta_direct_transition_work(integer,uuid) OWNER TO wasalx_scheduler_reader;
REVOKE ALL ON FUNCTION app.scan_meta_direct_transition_work(integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.scan_meta_direct_transition_work(integer,uuid) TO wasalx_app,wasalx_connector_worker;
REVOKE ALL ON FUNCTION app.meta_direct_transition_admission(uuid,uuid,boolean) FROM PUBLIC,wasalx_app;
GRANT EXECUTE ON FUNCTION app.meta_direct_transition_admission(uuid,uuid,boolean) TO wasalx_connector_worker,wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,provider,event_type,status,payload,payload_sha256,meta_direct_asset,meta_direct_identity_change,
 meta_direct_identity_transition,meta_direct_identity_resolution,meta_direct_native_anchor,meta_direct_anchor_retention_job_id,
 lease_id,lease_expires_at,safe_error,received_at,processed_at) ON event_inbox TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,ownership_state,state,opaque_session_id,provider_state_data) ON provider_sessions TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,external_participant_id) ON participant_identities TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,participant_identity_id,provider_session_id,phone_number_id,waba_id,kind,value,state,revision,source_event_id,source_payload_sha256) ON meta_direct_identity_aliases TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,external_chat_id,zammad_ticket_id,zammad_customer_id,state,fencing_token) ON bot_conversations TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,event_inbox_id,external_message_id,external_group_id,external_participant_id,provider_metadata,processing_status) ON normalized_messages TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,connection_id,external_message_id,zammad_ticket_id) ON message_links TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,connection_id,bot_conversation_id,direct_origin,external_chat_id,zammad_ticket_id,state,attempts,lease_id,manual_retry_allowed) ON delivery_outbox TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,delivery_id) ON delivery_attempts TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,conversation_id,lease_id,state) ON bot_action_jobs,bot_handoff_jobs TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,conversation_id,state) ON direct_native_reply_intents TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,conversation_id,state,conversation_fencing_token) ON direct_customer_close_commands TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,conversation_id,completed_at,lease_id) ON zammad_conversation_state_outbox TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,job_type,state,scope_type,scope_value) ON privacy_jobs TO wasalx_scheduler_reader;
GRANT SELECT(tenant_id,job_id,target_type,target_id,state) ON privacy_job_targets TO wasalx_scheduler_reader;
GRANT SELECT(id,tenant_id,state,provider,secret_reference) ON connections TO wasalx_scheduler_reader;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.meta_direct_transition_receipt_valid(uuid),app.meta_direct_transition_edge(jsonb),
 app.meta_direct_transition_anchor_valid(uuid,uuid,text,boolean),app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean),
 app.meta_direct_anchor_needed(uuid,uuid),app.meta_direct_transition_effects_clear(uuid,uuid),app.meta_direct_transition_privacy_clear(uuid,uuid,text[],uuid),
 app.meta_lifecycle_guard(uuid,uuid,text,text,text,bigint) TO wasalx_scheduler_reader;
-- These inherited validators/triggers reset their own paths when called
-- by the privileged admission. Harden only this actual relation-reading
-- dependency graph, without editing the delivered capsule migration bytes.
ALTER FUNCTION app.guard_meta_direct_alias() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.preserve_meta_direct_asset() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.preserve_meta_direct_identity_change() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.guard_meta_direct_native_anchor() SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.seal_meta_direct_native_anchor(uuid) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.meta_direct_native_anchor_valid(uuid,uuid,text,boolean) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.meta_direct_participant_matches(uuid,text,text) SET search_path=pg_catalog,public,app,pg_temp;
ALTER FUNCTION app.meta_direct_privacy_target_authorized(text,text) SET search_path=pg_catalog,public,app,pg_temp;

COMMIT;
