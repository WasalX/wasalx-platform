-- Historical receipt checks run repeatedly within the bounded identity drain.
-- The anchor existence test needs no message join; validated UUID slots use
-- UUID equality so their primary-key lookup remains indexable.
-- Preserve all receipt, revision, lineage, tenant and native-anchor fences.
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
 IF NOT EXISTS(SELECT 1 FROM event_inbox anchor
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
    AND alias.id=(item->>'id')::uuid AND alias.participant_identity_id=participant_id
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
