import { ConflictException, Injectable, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { metaDirectIdentityChangeEvidence,metaDirectTransitionEvidence } from "@wasalx/core/meta-direct-identity";
import { acceptCoexistence, type CoexistenceIngressInput } from "./meta-coexistence-ingress.js";
import type { MetaRoutingEvidence } from "@wasalx/core/meta-routing";
import { resolveMetaTestStatusRecipientLink, type MetaTestRecipientLink } from "@wasalx/core/meta-test-recipient-link";
import { parseWahaTestRecipientAllowlist } from "@wasalx/core/waha-test-recipient-scope";
import { setMetaTestPhoneTransaction } from "@wasalx/core/meta-test-phone-policy";

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool:Pool;
  constructor(){const connectionString=process.env.DATABASE_URL;if(!connectionString)throw new Error("DATABASE_URL is required");this.pool=new Pool({connectionString,max:Number(process.env.DATABASE_POOL_SIZE??20),statement_timeout:15_000,application_name:"wasalx-control-api"})}
  async withTenant<T>(tenantId:string,operation:(client:PoolClient)=>Promise<T>){const client=await this.pool.connect();try{await client.query("BEGIN");await setMetaTestPhoneTransaction(client,tenantId);const result=await operation(client);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}}
  async ready(){const result=await this.pool.query<{ok:number}>("SELECT 1 AS ok");return result.rows[0]?.ok===1}
  async pendingNativeMembershipTenants(){return(await this.pool.query<{tenant_id:string}>("SELECT app.pending_native_membership_tenants() AS tenant_id")).rows.map(row=>row.tenant_id)}
  async pendingNativeRoutingTenants(){return(await this.pool.query<{tenant_id:string}>("SELECT app.pending_native_routing_tenants() AS tenant_id")).rows.map(row=>row.tenant_id)}
  async receiveMetaDeletionReceipt(input:{appId:string;subjectDigest:string;payloadSha256:string;verificationKeyFingerprint:string;locator:string;issuedAt:number;expires?:number;maxAgeSeconds:number;retentionDays:number}) {
    const result=await this.pool.query<{result:{locator:string}}>("SELECT app.accept_meta_deletion_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",[input.appId,input.subjectDigest,input.payloadSha256,input.verificationKeyFingerprint,input.locator,input.issuedAt,input.expires??null,input.maxAgeSeconds,input.retentionDays]);
    if(!result.rows[0]?.result?.locator)throw new Error("Deletion receipt is unavailable");return result.rows[0].result;
  }
  async metaDeletionReceiptStatus(locator:string) {
    const result=await this.pool.query<{result:{state:string;reason?:string;receivedAt?:string;refusalPolicyUrl?:string|null}}>("SELECT app.meta_deletion_receipt_status($1) AS result",[locator]);
    return result.rows[0]?.result??{state:"UNAVAILABLE"};
  }
  async rows<T extends QueryResultRow>(tenantId:string,sql:string,values:unknown[]=[]){return this.withTenant(tenantId,async(client)=>(await client.query<T>(sql,values)).rows)}
  async acceptTenantInvitation(input:{tokenHash:string;oidcSubject:string;email:string;displayName:string}){
    const result=await this.pool.query<{
      tenant_id:string;tenant_name:string;tenant_slug:string;user_id:string;membership_role:string;
    }>("SELECT * FROM app.accept_tenant_invitation($1,$2,$3,$4)",[
      input.tokenHash,input.oidcSubject,input.email,input.displayName,
    ]);
    return result.rows[0]??null;
  }
  async resolveWahaWebhookRoute(routeHash:string){const result=await this.pool.query<WebhookRoute>("SELECT * FROM app.resolve_waha_webhook_route($1)",[routeHash]);return result.rows[0]??null}
  async resolveMetaWebhookRoute(externalKey:string){const result=await this.pool.query<WebhookRoute>("SELECT * FROM app.resolve_meta_webhook_route($1)",[externalKey]);return result.rows[0]??null}
  async metaTestStatusRecipientLink(route:WebhookRoute,status:Record<string,unknown>,appId=process.env.META_APP_ID??""){
    return this.withTenant(route.tenant_id,client=>resolveMetaTestStatusRecipientLink(client,{
      tenantId:route.tenant_id,connectionId:route.connection_id,appId,
      scope:parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST),status,
    }));
  }
  async resolveMetaIdentityWebhookRoute(externalKey:string){const result=await this.pool.query<WebhookRoute>("SELECT * FROM app.resolve_meta_identity_webhook_route($1)",[externalKey]);return result.rows[0]??null}
  async acceptMetaCoexistenceEvent(route: WebhookRoute, input: CoexistenceIngressInput, verifiedAppId?: string) {
    return this.withTenant(route.tenant_id, client => acceptCoexistence(client, route, input, verifiedAppId));
  }
  async resolveClientRoutingWebhookRoute(routeHash:string){const result=await this.pool.query<ClientRoutingWebhookRoute>("SELECT * FROM app.resolve_client_routing_webhook_route($1)",[routeHash]);return result.rows[0]??null}
  async enqueueClientRoutingWebhook(route:ClientRoutingWebhookRoute,eventSha256:string){return this.withTenant(route.tenant_id,async client=>(await client.query<{job_id:string;duplicate:boolean}>("SELECT * FROM app.enqueue_client_routing_webhook_sync($1,$2)",[route.source_state_id,eventSha256])).rows[0]!) }
  async resolveOidcMemberships(subject:string){const result=await this.pool.query<OidcMembership>("SELECT * FROM app.resolve_oidc_memberships($1)",[subject]);return result.rows}
  async acceptWebhookEvent(route:WebhookRoute,input:{providerEventId:string;eventType:string;payload:unknown;payloadSha256:string;routeKey:string;providerSessionKey:string;providerEngine:string;metaRoutingEvidence?:MetaRoutingEvidence;metaTestRecipientLink?:MetaTestRecipientLink},verifiedAppId?:string){return this.withTenant(route.tenant_id,async client=>{
    const appId=verifiedAppId??process.env.META_APP_ID;
    const tenant=(await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0];
    if(tenant?.active!==true)throw new NotFoundException("Webhook route was not found");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('webhook-admission:' || app.webhook_event_id_sha256($1,$2,$3,$4),0))",[route.tenant_id,route.connection_id,route.provider,input.providerEventId]);
    const duplicate=await client.query<{id:string;event_type:string;payload_sha256:string}>("SELECT id,event_type,payload_sha256 FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider=$3 AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,$3,$4)",[route.tenant_id,route.connection_id,route.provider,input.providerEventId]);
    if(duplicate.rows[0]){if(duplicate.rows[0].event_type!==input.eventType||duplicate.rows[0].payload_sha256!==input.payloadSha256)throw new ConflictException("Webhook event ID conflicts with an earlier payload");return{id:duplicate.rows[0].id,duplicate:true}}
    const identitySafety=route.provider==="META"&&input.eventType==="messages"?metaDirectIdentityChangeEvidence(input.payload,input.payloadSha256):null;
    const connection=(await client.query<{provider:string;engine:string;state:string}>("SELECT provider,engine,state FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[route.tenant_id,route.connection_id])).rows[0];
    if(!connection||connection.provider!==route.provider||connection.engine!==input.providerEngine||(connection.state==="REVOKED"||(connection.state==="PAUSED"&&!identitySafety)))throw new NotFoundException("Webhook route was not found");
    const activeRoute=await client.query(`SELECT state FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2 AND provider=$3 AND hmac_secret_reference=$4 AND reservation_release_id IS NULL AND (state='ACTIVE' OR (state='PAUSED' AND $6::boolean)) AND (($3='WAHA' AND route_token_sha256=$5) OR ($3='META' AND external_key=$5)) FOR SHARE`,[route.tenant_id,route.connection_id,route.provider,route.hmac_secret_reference,input.routeKey,identitySafety!==null]);
    if(activeRoute.rowCount!==1)throw new NotFoundException("Webhook route was not found");
    const session=await client.query<{id:string;state:string;opaque_session_id:string;waba_id:string|null}>(
      `SELECT id,state,opaque_session_id,provider_state_data->>'wabaId' AS waba_id FROM provider_sessions
       WHERE tenant_id=$1 AND connection_id=$2 AND opaque_session_id=$3 AND ownership_state='ACTIVE'
         AND ($4::text IS NULL OR provider_state_data#>'{metaAccountProof,credentialMetadata}' IS NULL
           OR provider_state_data#>>'{metaAccountProof,credentialMetadata,appId}'=$4) FOR SHARE`,
      [route.tenant_id,route.connection_id,input.providerSessionKey,verifiedAppId??null]);
    if(session.rowCount!==1)throw new NotFoundException("Webhook route was not found");
    const lifecycleEvent=(route.provider==="WAHA"&&input.eventType==="session.status")||(route.provider==="META"&&input.eventType==="message.status");
    if(!lifecycleEvent&&!identitySafety&&(connection.state!=="WORKING"||session.rows[0]?.state!=="WORKING"))throw new NotFoundException("Webhook route was not found");
    const currentSession=session.rows[0]!;
    if(route.provider==="META"&&input.eventType==="message.status"&&parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST)!==undefined){
      const payload=input.payload as {entry?:Array<{changes?:Array<{value?:{statuses?:Array<Record<string,unknown>>}}>}>};
      const status=payload.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
      if(status&&Object.hasOwn(status,"recipient_user_id")){
        const link=await resolveMetaTestStatusRecipientLink(client,{tenantId:route.tenant_id,connectionId:route.connection_id,
          appId:appId??"",scope:parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST),status});
        if(!link||JSON.stringify(link)!==JSON.stringify(input.metaTestRecipientLink))throw new NotFoundException("Webhook route was not found");
      }
    }
    // Bind delayed direct messages to the semantic asset that admitted the signed webhook.
    let metaDirectAsset=route.provider==="META"&&input.eventType==="messages"
      ? {providerSessionId:currentSession.id,phoneNumberId:currentSession.opaque_session_id,wabaId:currentSession.waba_id} : null;
    let identityChange=metaDirectAsset ? identitySafety : null;
    if(identitySafety){
      const body=input.payload as {entry?:Array<{id?:unknown}>},account=body.entry?.[0]?.id;
      // Existing WORKING/current-account safety admission retains P03's proof
      // boundary. Only the predecessor/PAUSED exception needs sealed ancestry.
      if(account!==currentSession.waba_id||connection.state!=="WORKING"||currentSession.state!=="WORKING"||activeRoute.rows[0]?.state==="PAUSED"){
        const resolved=(await client.query<{resolution:{asset:{providerSessionId:string;phoneNumberId:string;wabaId:string};attributed:boolean}|null}>(
          "SELECT app.resolve_meta_identity_source_asset($1,$2,$3,$4) AS resolution",
          [route.connection_id,input.providerSessionKey,typeof account==="string"?account:null,appId??null])).rows[0]?.resolution;
        if(resolved){
          metaDirectAsset=resolved.asset;
          if(!resolved.attributed)identityChange={schemaVersion:1,scope:"ASSET",previous:[],payloadSha256:input.payloadSha256};
        }else if(connection.state!=="WORKING"||currentSession.state!=="WORKING"||activeRoute.rows[0]?.state==="PAUSED")throw new NotFoundException("Webhook route was not found");
        // A missing exception leaves the original pin for the incumbent strict
        // signed-account trigger; it never silently attributes foreign input.
      }
    }
    const transition=metaDirectAsset?metaDirectTransitionEvidence(input.payload,input.payloadSha256,metaDirectAsset):null;
    const routingEvidence=input.metaRoutingEvidence?{...input.metaRoutingEvidence,providerSessionId:currentSession.id,appId}:null;
    if(routingEvidence&&(routingEvidence.phoneNumberId!==currentSession.opaque_session_id||routingEvidence.payloadSha256!==input.payloadSha256
      ||(currentSession.waba_id!==null&&routingEvidence.accountId!==currentSession.waba_id)))throw new NotFoundException("Webhook route was not found");
    const inserted=await client.query<{id:string}>("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,meta_direct_asset,meta_direct_identity_change,meta_direct_identity_transition,meta_routing_evidence,meta_webhook_app_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACCEPTED',clock_timestamp(),$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12) ON CONFLICT (provider,connection_id,provider_event_id_sha256) DO NOTHING RETURNING id",[route.tenant_id,route.connection_id,route.provider,input.providerEventId,input.eventType,input.payload,input.payloadSha256,metaDirectAsset,identityChange,transition,routingEvidence,verifiedAppId??null]);
    if(!inserted.rows[0]){
      const raced=(await client.query<{id:string;event_type:string;payload_sha256:string}>("SELECT id,event_type,payload_sha256 FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider=$3 AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,$3,$4)",[route.tenant_id,route.connection_id,route.provider,input.providerEventId])).rows[0];
      if(raced&&raced.event_type===input.eventType&&raced.payload_sha256===input.payloadSha256)return{id:raced.id,duplicate:true};
      throw new ConflictException("Webhook event admission conflicted with another request");
    }
    await client.query("UPDATE connections SET last_provider_event_at=clock_timestamp(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[route.tenant_id,route.connection_id]);
    return{id:inserted.rows[0].id,duplicate:false};
  })}
  async resolveMetaRoutingRoutes(accountId:string,phoneId:string|null,appId:string,secretReference:string){
    return(await this.pool.query<MetaRoutingRoute>("SELECT * FROM app.resolve_meta_routing_routes($1,$2,$3,$4)",[accountId,phoneId,appId,secretReference])).rows;
  }
  async acceptMetaRoutingEvent(route:MetaRoutingRoute,input:{providerEventId:string;eventType:string;payload:unknown;payloadSha256:string;evidence:MetaRoutingEvidence},verifiedAppId?:string){
    const appId=verifiedAppId??process.env.META_APP_ID;
    return this.withTenant(route.tenant_id,async client=>{
      const active=(await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0];
      if(active?.active!==true)throw new NotFoundException("Webhook route was not found");
      await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' FOR UPDATE",[route.tenant_id,route.connection_id]);
      const current=(await client.query<MetaRoutingRoute>("SELECT * FROM app.resolve_meta_routing_routes($1,$2,$3,$4) WHERE tenant_id=$5 AND connection_id=$6 AND app.meta_number_event_current($6,$7::timestamptz)",
        [input.evidence.accountId,route.phone_number_id,appId??"",route.hmac_secret_reference,route.tenant_id,route.connection_id,input.evidence.category==="UNRESOLVED_ROUTING"?null:input.evidence.observedAt])).rows;
      if(current.length!==1||current[0]!.provider_session_id!==route.provider_session_id)throw new NotFoundException("Webhook route was not found");
      const evidence={...input.evidence,providerSessionId:route.provider_session_id,phoneNumberId:route.phone_number_id,appId};
      const duplicate=(await client.query<{id:string;payload_sha256:string;event_type:string}>("SELECT id,payload_sha256,event_type FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'META',$3)",[route.tenant_id,route.connection_id,input.providerEventId])).rows[0];
      if(duplicate){if(duplicate.payload_sha256!==input.payloadSha256||duplicate.event_type!==input.eventType)throw new ConflictException("Webhook event ID conflicts with an earlier payload");return{id:duplicate.id,duplicate:true}}
      const inserted=(await client.query<{id:string}>(`INSERT INTO event_inbox(tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,meta_routing_evidence,meta_webhook_app_id)
        VALUES($1,$2,'META',$3,$4,$5,$6,'ACCEPTED',clock_timestamp(),$7,$8) RETURNING id`,[route.tenant_id,route.connection_id,input.providerEventId,input.eventType,input.payload,input.payloadSha256,evidence,verifiedAppId??null])).rows[0]!;
      return{id:inserted.id,duplicate:false};
    });
  }
  async resolveMetaLifecycleRoutes(wabaId:string,appId:string){
    const result=await this.pool.query<MetaLifecycleRoute>("SELECT * FROM app.resolve_meta_lifecycle_routes($1,$2)",[wabaId,appId]);
    return result.rows;
  }
  async acceptMetaLifecycleEvent(route:MetaLifecycleRoute,input:{providerEventId:string;eventType:MetaLifecycleEventType;payload:unknown;payloadSha256:string},verifiedAppId?:string){return this.withTenant(route.tenant_id,async client=>{
    const tenant=(await client.query<{active:boolean}>("SELECT app.lock_current_active_tenant_for_event_admission() AS active")).rows[0];
    if(tenant?.active!==true)throw new NotFoundException("Webhook route was not found");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('webhook-admission:' || app.webhook_event_id_sha256($1,$2,'META',$3),0))",[route.tenant_id,route.connection_id,input.providerEventId]);
    const duplicate=(await client.query<{id:string;event_type:string;payload_sha256:string}>("SELECT id,event_type,payload_sha256 FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'META',$3)",[route.tenant_id,route.connection_id,input.providerEventId])).rows[0];
    if(duplicate){if(duplicate.event_type!==input.eventType||duplicate.payload_sha256!==input.payloadSha256)throw new ConflictException("Webhook event ID conflicts with an earlier payload");return{id:duplicate.id,duplicate:true}}
    const connection=await client.query("SELECT id FROM connections WHERE tenant_id=$1 AND id=$2 AND provider='META' AND engine='CLOUD_API' FOR UPDATE",[route.tenant_id,route.connection_id]);if(connection.rowCount!==1)throw new NotFoundException("Webhook route was not found");
    const payload=input.payload as {admission?:{observedAt?:unknown};entry?:Array<{time?:unknown}>}|null;
    const observedAt=payload?.admission?.observedAt,providerTime=payload?.entry?.[0]?.time;
    const providerObservedAt=typeof observedAt==="string" && typeof providerTime==="number" && Number.isSafeInteger(providerTime)
      && Date.parse(observedAt)===providerTime*1000 ? observedAt : null;
    const webhook=await client.query("SELECT connection_id FROM webhook_routes WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND hmac_secret_reference=$3 AND state=$4 AND reservation_release_id IS NULL AND app.meta_number_event_current($2,$5::timestamptz) FOR SHARE",[route.tenant_id,route.connection_id,route.hmac_secret_reference,route.route_state,providerObservedAt]);if(webhook.rowCount!==1)throw new NotFoundException("Webhook route was not found");
    const session=await client.query("SELECT id FROM provider_sessions WHERE tenant_id=$1 AND id=$2 AND connection_id=$3 AND ownership_state=$4 FOR SHARE",[route.tenant_id,route.provider_session_id,route.connection_id,route.session_ownership_state]);if(session.rowCount!==1)throw new NotFoundException("Webhook route was not found");
    const current=(await client.query<MetaLifecycleRoute>("SELECT * FROM app.resolve_meta_lifecycle_routes($1,$2) WHERE tenant_id=$3 AND connection_id=$4",[route.waba_id,route.app_id,route.tenant_id,route.connection_id])).rows;
    if(current.length!==1||current[0]!.provider_session_id!==route.provider_session_id||current[0]!.phone_number_id!==route.phone_number_id||current[0]!.route_state!==route.route_state)throw new NotFoundException("Webhook route was not found");
    const inserted=await client.query<{id:string}>("INSERT INTO event_inbox (tenant_id,connection_id,provider,provider_event_id,event_type,payload,payload_sha256,status,received_at,meta_webhook_app_id) VALUES ($1,$2,'META',$3,$4,$5,$6,'ACCEPTED',clock_timestamp(),$7) ON CONFLICT (provider,connection_id,provider_event_id_sha256) DO NOTHING RETURNING id",[route.tenant_id,route.connection_id,input.providerEventId,input.eventType,input.payload,input.payloadSha256,verifiedAppId??null]);
    if(!inserted.rows[0]){const raced=(await client.query<{id:string;event_type:string;payload_sha256:string}>("SELECT id,event_type,payload_sha256 FROM event_inbox WHERE tenant_id=$1 AND connection_id=$2 AND provider='META' AND provider_event_id_sha256=app.webhook_event_id_sha256($1,$2,'META',$3)",[route.tenant_id,route.connection_id,input.providerEventId])).rows[0];if(raced&&raced.event_type===input.eventType&&raced.payload_sha256===input.payloadSha256)return{id:raced.id,duplicate:true};throw new ConflictException("Webhook event admission conflicted with another request")};
    await client.query("UPDATE connections SET last_provider_event_at=clock_timestamp(),updated_at=now() WHERE tenant_id=$1 AND id=$2",[route.tenant_id,route.connection_id]);
    return{id:inserted.rows[0].id,duplicate:false};
  })}  async onModuleDestroy(){await this.pool.end()}
}
export type WebhookRoute={tenant_id:string;connection_id:string;provider:"WAHA"|"META";hmac_secret_reference:string};
export type MetaRoutingRoute=WebhookRoute&{provider_session_id:string;phone_number_id:string;account_id:string|null};
export type ClientRoutingWebhookRoute={tenant_id:string;source_state_id:string;source_id:string;kind:"NOTION"|"ZOHO"|"HTTP_JSON";secret_reference:string};
export type OidcMembership={user_id:string;email:string;display_name:string;tenant_id:string;tenant_name:string;tenant_slug:string;tenant_state:string;membership_role:"tenant_owner"|"tenant_admin"|"supervisor"|"agent"|"auditor"};
export type MetaLifecycleEventType="meta.account.lifecycle.block"|"meta.account.lifecycle.recovery"|"meta.account.lifecycle.observation";
export type MetaLifecycleRoute={tenant_id:string;connection_id:string;provider:"META";hmac_secret_reference:string;route_state:"ACTIVE"|"PAUSED"|"REVOKED";provider_session_id:string;session_ownership_state:"ACTIVE"|"RETIRED";phone_number_id:string;waba_id:string;display_phone_number:string|null;app_id:string};
