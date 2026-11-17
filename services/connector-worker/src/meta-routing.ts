import type { PoolClient } from "pg";
import { metaLifecyclePayloadSha256 } from "../../../packages/core/src/meta-account-relation.js";
import { MetaRoutingError, metaRoutingRuntime, reduceMetaRouting, type MetaRoutingEvidence, type MetaRoutingState } from "../../../packages/core/src/meta-routing.js";
import type { InboundEvent } from "./types.js";

type Asset = { providerSessionId:string;phoneNumberId:string;wabaId:string|null };
type Evidence = MetaRoutingEvidence & { providerSessionId:string;appId:string };
type Source = { id:string;meta_routing_evidence:Evidence;meta_routing_epoch:string|null;meta_routing_participant_id:string|null;payload_sha256:string };
type Ownership = { state:MetaRoutingState["state"];epoch:string;observed_at:Date;epoch_started_at:Date;source_hash:string;last_customer_message_at:Date|null;configuration_version:string;review_version:string };
type Guard = { allowed:boolean;epoch:string|null;claim:string;configuration_version:string;review_version:string };
const runtime = () => JSON.stringify(metaRoutingRuntime(process.env));

async function guard(client:PoolClient,connectionId:string,asset:Asset,participantId:string|null,appId:string,sourceIds:string[]|null,own=true){
  return(await client.query<Guard>("SELECT * FROM app.meta_direct_routing_guard($1,$2,$3,$4,$5,$6,$7::jsonb,NULL,$8::uuid[],NULL,$9)",
    [connectionId,asset.providerSessionId,asset.phoneNumberId,asset.wabaId,participantId,appId,runtime(),sourceIds,own])).rows[0];
}

async function project(client:PoolClient,tenantId:string,connectionId:string,source:Source,participantId:string,configuration?:Guard){
  if(source.meta_routing_epoch!==null)return;
  const e=source.meta_routing_evidence;
  const previous=(await client.query<Ownership>(`SELECT state,epoch,observed_at,epoch_started_at,source_hash,last_customer_message_at,configuration_version,review_version
    FROM meta_thread_ownership WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4 FOR UPDATE`,
    [tenantId,connectionId,e.providerSessionId,participantId])).rows[0];
  const old:MetaRoutingState|undefined=previous?{state:previous.state,epoch:Number(previous.epoch),observedAt:previous.observed_at.toISOString(),sourceHash:previous.source_hash,
    ...(previous.last_customer_message_at?{lastCustomerMessageAt:previous.last_customer_message_at.toISOString()}:{})}:undefined;
  const positive=e.category==="PRIMARY_MESSAGE"||e.category==="CONTROL_PASSED";
  const configured=configuration?.allowed===true&&configuration.claim!=="LEGACY_COMPATIBILITY";
  const next=reduceMetaRouting(old,e,configured);if(!next)return;
  // An old event cannot be relabeled with a newer ownership generation.
  if(previous&&Date.parse(e.observedAt)<previous.epoch_started_at.getTime()){
    await client.query("UPDATE event_inbox SET meta_routing_participant_id=$1,meta_routing_epoch=0 WHERE tenant_id=$2 AND id=$3 AND meta_routing_epoch IS NULL",[participantId,tenantId,source.id]);
    return;
  }
  if(previous&&(e.observedAt<previous.observed_at.toISOString()||e.payloadSha256===previous.source_hash)){
    await client.query("UPDATE event_inbox SET meta_routing_participant_id=$1,meta_routing_epoch=$2 WHERE tenant_id=$3 AND id=$4 AND meta_routing_epoch IS NULL",[participantId,previous.epoch,tenantId,source.id]);
    return;
  }
  if(positive&&configured&&previous&&(Number(previous.configuration_version)!==Number(configuration!.configuration_version)||Number(previous.review_version)!==Number(configuration!.review_version)))next.epoch=Math.max(next.epoch,Number(previous.epoch)+1);
  // The existing ownership row is locked above. An upsert would first run the
  // INSERT trigger and reject a valid later observation in the same generation.
  // Preserve the exact database generation boundary, including microseconds.
  const projected=await client.query(previous?`UPDATE meta_thread_ownership SET state=$7,epoch=$8,
    configuration_version=$9,review_version=$10,observed_at=$11,
    epoch_started_at=CASE WHEN epoch=$8 THEN epoch_started_at ELSE $12::timestamptz END,
    last_customer_message_at=$13,source_hash=$14,source_event_id=$15,source_action_id=NULL
    WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND participant_identity_id=$4 AND phone_number_id=$5 AND account_id=$6`
    :`INSERT INTO meta_thread_ownership(tenant_id,connection_id,provider_session_id,participant_identity_id,phone_number_id,account_id,state,epoch,
      configuration_version,review_version,observed_at,epoch_started_at,last_customer_message_at,source_hash,source_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [tenantId,connectionId,e.providerSessionId,participantId,e.phoneNumberId,e.accountId,next.state,next.epoch,
      Number(configuration?.configuration_version??previous?.configuration_version??0),Number(configuration?.review_version??previous?.review_version??0),
      next.observedAt,e.observedAt,next.lastCustomerMessageAt??null,next.sourceHash,source.id]);
  if(projected.rowCount!==1)throw new MetaRoutingError();
  await client.query("UPDATE event_inbox SET meta_routing_participant_id=$1,meta_routing_epoch=$2 WHERE tenant_id=$3 AND id=$4 AND meta_routing_epoch IS NULL",
    [participantId,next.epoch,tenantId,source.id]);
}

/** Ordinary P03 identity resolution precedes this; passive data cannot create an alias. */
export async function bindMetaPrimaryRouting(client:PoolClient,event:InboundEvent,asset:Asset,participantId:string|null,appId:string){
  const source=(await client.query<Source>(`SELECT id,meta_routing_evidence,meta_routing_epoch,meta_routing_participant_id,payload_sha256
    FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND event_type='messages' AND status='PROCESSING' FOR UPDATE`,
    [event.tenantId,event.connectionId,event.id])).rows[0];
  if(source&&!source.meta_routing_evidence){
    // Only migration-bound original ordinary work can retain epoch zero. The
    // shared guard checks admission time and the immutable original asset.
    await client.query("UPDATE event_inbox SET meta_routing_epoch=0 WHERE tenant_id=$1 AND id=$2 AND meta_routing_epoch IS NULL",[event.tenantId,event.id]);
    await assertMetaInboundRouting(client,event,asset,participantId,appId);return;
  }
  if(!source?.meta_routing_evidence||source.meta_routing_evidence.category!=="PRIMARY_MESSAGE"||source.meta_routing_evidence.providerSessionId!==asset.providerSessionId
    ||source.payload_sha256!==source.meta_routing_evidence.payloadSha256)throw new MetaRoutingError();
  if(participantId){
    // A later ordinary signed identity can bind older passive observations via its
    // existing exact asset alias. It does not grant aliases from import content.
    const pending=(await client.query<Source>(`SELECT source.id,source.meta_routing_evidence,source.meta_routing_epoch,source.meta_routing_participant_id,source.payload_sha256
      FROM event_inbox source WHERE source.tenant_id=$1 AND source.connection_id=$2 AND source.meta_routing_epoch IS NULL
      AND source.meta_routing_evidence->>'providerSessionId'=$3
      AND source.meta_routing_evidence->>'category' IN('STANDBY_MESSAGE','CONTROL_TAKEN')
      AND EXISTS(SELECT 1 FROM meta_direct_identity_aliases alias WHERE alias.tenant_id=source.tenant_id AND alias.connection_id=source.connection_id
       AND alias.participant_identity_id=$4 AND alias.provider_session_id=$3::uuid AND alias.state='ACTIVE'
       AND alias.kind=source.meta_routing_evidence#>>'{peer,kind}' AND alias.value=source.meta_routing_evidence#>>'{peer,value}')
      ORDER BY source.meta_routing_evidence->>'observedAt',source.id FOR UPDATE`,[event.tenantId,event.connectionId,asset.providerSessionId,participantId])).rows;
    for(const negative of pending)await project(client,event.tenantId,event.connectionId,negative,participantId);
  }
  const current=await guard(client,event.connectionId,asset,participantId,appId,null,false);
  if(current?.claim==="LEGACY_COMPATIBILITY"&&current.allowed){
    await client.query("UPDATE event_inbox SET meta_routing_participant_id=$1,meta_routing_epoch=0 WHERE tenant_id=$2 AND id=$3 AND meta_routing_epoch IS NULL",[participantId,event.tenantId,event.id]);
  }else if(current?.claim==="PRIMARY_DELIVERY"&&current.allowed&&participantId){
    if(source.meta_routing_epoch===null){
      await client.query(`INSERT INTO meta_primary_delivery_admissions(tenant_id,connection_id,provider_session_id,participant_identity_id,
        source_event_id,source_hash,observed_at,phone_number_id,account_id,app_id,runtime_binding,secret_reference,proof_sha256)
        SELECT $1,$2,session.id,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,connection.secret_reference,
          app.meta_account_proof_sha256(session.provider_state_data->'metaAccountProof')
        FROM provider_sessions session JOIN connections connection ON connection.tenant_id=session.tenant_id AND connection.id=session.connection_id
        WHERE session.tenant_id=$1 AND session.connection_id=$2 AND session.id=$11 AND session.ownership_state='ACTIVE'`,
        [event.tenantId,event.connectionId,participantId,event.id,source.payload_sha256,source.meta_routing_evidence.observedAt,
          asset.phoneNumberId,asset.wabaId,appId,runtime(),asset.providerSessionId]);
      await client.query("UPDATE event_inbox SET meta_routing_participant_id=$1,meta_routing_epoch=0 WHERE tenant_id=$2 AND id=$3 AND meta_routing_epoch IS NULL",[participantId,event.tenantId,event.id]);
    }
  }else if(participantId)await project(client,event.tenantId,event.connectionId,source,participantId,current);
  await assertMetaInboundRouting(client,event,asset,participantId,appId);
}

export async function assertMetaInboundRouting(client:PoolClient,event:InboundEvent,asset:Asset,participantId:string|null,appId:string){
  const current=await guard(client,event.connectionId,asset,participantId,appId,[event.id]);
  if(current?.allowed!==true)throw new MetaRoutingError();
}

export async function applyMetaPassiveRouting(client:PoolClient,event:InboundEvent,leaseId:string,appId:string){
  await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' FOR UPDATE",[event.tenantId,event.connectionId]);
  const source=(await client.query<Source&{payload:unknown}>(`SELECT id,payload,payload_sha256,meta_routing_evidence,meta_routing_epoch,meta_routing_participant_id FROM event_inbox
    WHERE tenant_id=$1 AND connection_id=$2 AND id=$3 AND event_type IN('meta.routing.passive','meta.routing.unresolved')
    AND status='PROCESSING' AND lease_id=$4 AND lease_expires_at>clock_timestamp() FOR UPDATE`,[event.tenantId,event.connectionId,event.id,leaseId])).rows[0];
  if(!source?.meta_routing_evidence||source.meta_routing_evidence.appId!==appId)throw new MetaRoutingError();
  const e=source.meta_routing_evidence;
  if(e.category!=="UNRESOLVED_ROUTING"&&metaLifecyclePayloadSha256(source.payload)!==e.payloadSha256)throw new MetaRoutingError();
  const session=(await client.query<{id:string;opaque_session_id:string;account_id:string|null}>(`SELECT id,opaque_session_id,provider_state_data->>'wabaId' AS account_id FROM provider_sessions
    WHERE tenant_id=$1 AND connection_id=$2 AND ownership_state='ACTIVE' FOR SHARE`,[event.tenantId,event.connectionId])).rows[0];
  const same=session?.id===e.providerSessionId&&session.opaque_session_id===e.phoneNumberId&&session.account_id===e.accountId;
  if(same&&e.peer&&["STANDBY_MESSAGE","CONTROL_TAKEN","CONTROL_PASSED"].includes(e.category)){
    const aliases=(await client.query<{participant_identity_id:string}>(`SELECT DISTINCT participant_identity_id FROM meta_direct_identity_aliases
      WHERE tenant_id=$1 AND connection_id=$2 AND provider_session_id=$3 AND phone_number_id=$4 AND waba_id=$5 AND kind=$6 AND value=$7 AND state='ACTIVE'`,
      [event.tenantId,event.connectionId,e.providerSessionId,e.phoneNumberId,e.accountId,e.peer.kind,e.peer.value])).rows;
    if(aliases.length===1){const participant=aliases[0]!.participant_identity_id;
      const current=await guard(client,event.connectionId,{providerSessionId:e.providerSessionId,phoneNumberId:e.phoneNumberId,wabaId:e.accountId},participant,appId,null,false);
      await project(client,event.tenantId,event.connectionId,source,participant,current);
    }
  }
  // Keep immutable minimal source markers after content erasure. A missing peer
  // remains an asset hold; neither processing nor expiry silently clears it.
  const completed=await client.query(`UPDATE event_inbox SET status='PROCESSED',payload=jsonb_build_object('redacted',true,'payload_sha256',payload_sha256),
    provider_event_id='redacted:'||provider_event_id_sha256,processed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL
    WHERE tenant_id=$1 AND id=$2 AND status='PROCESSING' AND lease_id=$3 AND lease_expires_at>clock_timestamp()`,[event.tenantId,event.id,leaseId]);
  if(completed.rowCount!==1)throw new MetaRoutingError();
}
