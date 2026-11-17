import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException, SetMetadata, UnauthorizedException } from "@nestjs/common";
import { PUBLIC_ROUTE } from "./auth.guard.js";
import { DatabaseService, type MetaLifecycleEventType, type MetaLifecycleRoute, type MetaRoutingRoute, type WebhookRoute } from "./database.service.js";
import { admitMetaTemplateSafety } from "./meta-template-ingress.js";
import { classifyMetaLifecycleValue, metaLifecycleAccountId, metaLifecyclePayloadSha256, normalizeMetaDisplayPhoneNumber } from "@wasalx/core/meta-account-relation";
import { metaCoexistenceUnits } from "@wasalx/core/meta-coexistence";
import type { CoexistenceIngressInput } from "./meta-coexistence-ingress.js";
import { metaRoutingUnits, type MetaRoutingEvidence } from "@wasalx/core/meta-routing";
import { metaDirectIdentityChangeEvidence } from "@wasalx/core/meta-direct-identity";
import { metaPricingObservation, metaStatusPayloadSha256 } from "@wasalx/core/meta-pricing-observation";
import { TenantDrainService } from "./tenant-drain.service.js";
import { META_WEBHOOK_MAX_BYTES, sha256Hex, verifyProviderHmac, verifyWebhookTimestamp } from "./webhook-security.js";
import { WebhookSecretService } from "./webhook-secret.service.js";
import { recordWebhook } from "@wasalx/observability";
import { RoutingConnectorsConfig } from "./routing-connectors.config.js";
import { SecretProvisioningService } from "./secret-provisioning.service.js";
import { parseWahaTestRecipientAllowlist, wahaTestWebhookAllowed } from "@wasalx/core/waha-test-recipient-scope";
import { metaTestCoexistenceUnit, metaTestLifecycleValue, metaTestRoutingEvidence, metaTestWebhookUnits } from "@wasalx/core/meta-test-recipient-scope";
import type { MetaTestRecipientLink } from "@wasalx/core/meta-test-recipient-link";

type RawWebhookRequest={rawBody?:Uint8Array;headers:Record<string,string|string[]|undefined>};
type MetaBody={object?:string;entry?:Array<{id?:string;time?:number;changes?:Array<{field?:string;value?:Record<string,unknown>}>}>};
type MetaPlan={route:WebhookRoute|MetaLifecycleRoute;input:Parameters<DatabaseService["acceptWebhookEvent"]>[1]|{providerEventId:string;eventType:MetaLifecycleEventType;payload:unknown;payloadSha256:string};lifecycle:boolean};
const WAHA_EVENTS=new Set(["message","message.any","message.edited","message.revoked","message.reaction","poll.vote","message.ack.group","session.status"]);

@Controller("webhooks")
@SetMetadata(PUBLIC_ROUTE,true)
export class WebhookIngressController{
  private readonly testRecipients=parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST);
  constructor(private readonly database:DatabaseService,private readonly secrets:WebhookSecretService,private readonly drains:TenantDrainService,private readonly routingConnectors?:RoutingConnectorsConfig,private readonly secretProvisioning?:SecretProvisioningService){}

  @Post("waha/:token")@HttpCode(202)
  async waha(@Param("token")token:string,@Req()request:RawWebhookRequest,@Body()body:Record<string,unknown>){
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))rejectWaha("route",new NotFoundException("Webhook route was not found"));
    const routeKey=await sha256Hex(token);const route=await this.database.resolveWahaWebhookRoute(routeKey);
    if(!route)rejectWaha("route",new NotFoundException("Webhook route was not found"));
    const raw=rawBody(request);const algorithm=header(request,"x-webhook-hmac-algorithm");
    if(algorithm?.toLowerCase()!=="sha512")rejectWaha("algorithm",new UnauthorizedException("Unsupported webhook signature algorithm"));
    if(!isRecord(body))rejectWaha("event",new BadRequestException("Webhook structure is invalid"));
    const timestamp=header(request,"x-webhook-timestamp");
    if(typeof body.timestamp!=="number"||!Number.isSafeInteger(body.timestamp)||body.timestamp<=0||timestamp!==String(body.timestamp))
      rejectWaha("timestamp",new UnauthorizedException("Invalid webhook timestamp"));
    const secret=await this.resolveSecret(route);const verification=await verifyProviderHmac({rawBody:raw,secret,provided:header(request,"x-webhook-hmac")??"",algorithm:"sha512",timestamp,requireTimestamp:true});
    if(!verification.valid)rejectWaha(verification.reason==="stale"?"stale":verification.reason==="timestamp"?"timestamp":"signature",new UnauthorizedException(verification.reason==="stale"?"Stale webhook request":verification.reason==="timestamp"?"Invalid webhook timestamp":"Invalid webhook signature"));
    const providerEventId=stringValue(body.id)??`body:${await sha256Hex(raw)}`;const eventType=stringValue(body.event);
    const providerSessionKey=boundedIdentifier(body.session,256);const providerEngine=body.engine===undefined?"GOWS":stringValue(body.engine)?.toUpperCase();const metadataConnectionId=stringValue(isRecord(body.metadata)?body.metadata.connectionId:undefined);
    if(!eventType||!WAHA_EVENTS.has(eventType)||providerEventId.length>512)rejectWaha("event",new BadRequestException("Webhook event ownership is invalid"));
    if(!providerSessionKey||!providerEngine||metadataConnectionId!==route.connection_id)rejectWaha("ownership",new BadRequestException("Webhook event ownership is invalid"));
    // Use the same engine default as ownership admission; WAHA may omit it.
    if(!wahaTestWebhookAllowed(this.testRecipients,{...body,engine:providerEngine})){recordWebhook("waha","rejected","test_recipient_scope");return{accepted:false,dropped:true}}
    const accepted=await this.database.acceptWebhookEvent(route,{providerEventId,eventType,payload:body,payloadSha256:await sha256Hex(raw),routeKey,providerSessionKey,providerEngine});recordWebhook("waha",accepted.duplicate?"duplicate":"accepted");if(!accepted.duplicate)await this.drains.wakeInbound(route.tenant_id);return{accepted:true,duplicate:accepted.duplicate,event_id:accepted.id}
  }

  @Get("meta")
  verifyMeta(@Query("hub.mode")mode?:string,@Query("hub.verify_token")token?:string,@Query("hub.challenge")challenge?:string){const expected=process.env.META_VERIFY_TOKEN;if(!expected)throw new ServiceUnavailableException("Meta verification is unavailable");if(mode!=="subscribe"||!constantTimeEqual(token??"",expected)||!challenge)throw new UnauthorizedException("Meta verification failed");return challenge}

  @Post("meta")@HttpCode(200)
  async meta(@Req()request:RawWebhookRequest,@Body()body:MetaBody){
    const reference=process.env.META_APP_SECRET_REFERENCE;const appId=process.env.META_APP_ID;
    if(!reference)throw new ServiceUnavailableException("Meta webhook verification is unavailable");
    const raw=rawBody(request,META_WEBHOOK_MAX_BYTES);const secret=await this.resolveSecret({tenant_id:"",connection_id:"",provider:"META",hmac_secret_reference:reference});
    const verification=await verifyProviderHmac({rawBody:raw,secret,provided:header(request,"x-hub-signature-256")??"",algorithm:"sha256"});if(!verification.valid)throw new UnauthorizedException("Invalid webhook signature");
    if(!isRecord(body))throw new BadRequestException("Meta webhook structure is invalid");
    if(this.testRecipients?.size===0)return{accepted:true,count:0,duplicates:0,unrouted:0};
    // Finish the full template safety scan, retaining its failure until the
    // independently attributable routing negatives have also been admitted.
    let templateSafety={accepted:0,duplicates:0,unrouted:0};
    let templateSafetyError:unknown;
    try{templateSafety=await admitMetaTemplateSafety(this.database,body,appId)}catch(error){templateSafetyError=error}
    if(!Array.isArray(body.entry)||!body.entry.length)throw new BadRequestException("Meta webhook contains no events");
    const plans:MetaPlan[]=[];
    const guardedNegatives:MetaPlan[]=[];
    const coexistencePlans: Array<{ route: WebhookRoute; input: CoexistenceIngressInput }> = [];
    const routingPlans:Array<{route:MetaRoutingRoute;input:Parameters<DatabaseService["acceptMetaRoutingEvent"]>[1]}>=[];
    let unroutedCount=templateSafety.unrouted;
    let guardedSafetyError:unknown;
    const commitSafety=async(negativeOnly:boolean)=>{
      const tenants=new Set<string>(),errors:unknown[]=[];
      let acceptedCount=0,duplicateCount=0;
      const attempt=async(tenantId:string,accept:()=>Promise<{duplicate:boolean}>)=>{
        try{const accepted=await accept();if(accepted.duplicate){duplicateCount++;if(negativeOnly&&this.testRecipients===undefined)tenants.add(tenantId)}else{acceptedCount++;tenants.add(tenantId)}}
        catch(error){if(this.testRecipients===undefined)throw error;errors.push(error)}
      };
      for(const plan of routingPlans){
        if(this.testRecipients!==undefined&&!["STANDBY_MESSAGE","CONTROL_TAKEN","UNRESOLVED_ROUTING"].includes(plan.input.evidence.category))continue;
        await attempt(plan.route.tenant_id,()=>this.database.acceptMetaRoutingEvent(plan.route,plan.input));
      }
      for(const plan of guardedNegatives)await attempt(plan.route.tenant_id,()=>plan.lifecycle?this.database.acceptMetaLifecycleEvent(plan.route as MetaLifecycleRoute,plan.input as never):this.database.acceptWebhookEvent(plan.route as WebhookRoute,plan.input as never));
      return{tenants,acceptedCount,duplicateCount,errors};
    };
    try{
    if(this.testRecipients!==undefined){
      // Complete the signed safety scan before a bad ordinary neighbor can fail.
      // Only negative plans survive a later parser failure; no activation grant.
      for(const entry of body.entry){
        if(!isRecord(entry)||!Array.isArray(entry.changes))continue;
        for(const change of entry.changes){
          if(!isRecord(change)||!isRecord(change.value))continue;
          try{
            if(change.field==="account_update"&&classifyLifecycle(change.value,appId??"").kind==="BLOCK"){
              const negative=await this.metaLifecyclePlans(body.object,entry,change,appId);
              if(!negative.length)unroutedCount++;
              guardedNegatives.push(...negative);
            }
            if(change.field==="messages"&&Array.isArray(change.value.messages)&&change.value.messages.some(message=>isRecord(message)&&message.type==="system")){
              if(body.object!=="whatsapp_business_account"||typeof entry.id!=="string"||!/^[0-9]{1,32}$/u.test(entry.id))throw new BadRequestException("Meta identity source is invalid");
              const externalKey=metaExternalKey(change.value);if(!externalKey){unroutedCount++;continue}
              const route=await this.database.resolveMetaWebhookRoute(externalKey)??await this.database.resolveMetaIdentityWebhookRoute(externalKey);
              if(!route){unroutedCount++;continue}
              // Ordinary expansion remains bounded below; this scan retains
              // attributable system holds even in an oversized ordinary batch.
              const identityValue={...change.value};delete identityValue.statuses;delete identityValue.errors;
              for(const value of metaTestWebhookUnits(this.testRecipients,{...identityValue,messages:change.value.messages.filter(message=>isRecord(message)&&message.type==="system")}).values){
                const message=Array.isArray(value.messages)?value.messages[0]:undefined;
                if(!isRecord(message)||message.type!=="system")continue;
                const payload={entry:[{id:entry.id,changes:[{field:"messages",value}]}]};
                guardedNegatives.push({route,lifecycle:false,input:{providerEventId:String(message.id),eventType:"messages",payload,payloadSha256:await sha256Hex(JSON.stringify(payload)),routeKey:externalKey,providerSessionKey:externalKey,providerEngine:"CLOUD_API"}});
              }
            }
          }catch(error){guardedSafetyError??=error}
        }
      }
    }
    // Scan all identifiable passive sources before ordinary validation. A bad
    // neighbor appearing first cannot prevent a signed negative from fencing.
    for(const entry of body.entry){
      if(!isRecord(entry)||!Array.isArray(entry.changes))continue;
      for(const change of entry.changes){
        if(!isRecord(change))continue;
        try{
        if(change.field==="standby"||change.field==="messaging_handovers"){
          if(typeof entry.id!=="string"||!/^[0-9]{1,32}$/u.test(entry.id)
            )continue;
          if(!appId||!/^[0-9]{1,32}$/u.test(appId))throw new ServiceUnavailableException("Meta routing verification is unavailable");
          let units:ReturnType<typeof metaRoutingUnits>;
          try{if(body.object!=="whatsapp_business_account")throw new Error("invalid object");units=metaRoutingUnits(entry.id,change.field,change.value)}catch{
            // Signed applicability/negative evidence must survive malformed content.
            // Resolve only the documented account/phone envelope; never invent a user.
            const v=isRecord(change.value)?change.value:{};
            const m=isRecord(v.metadata)?v.metadata:{},r=isRecord(v.recipient)?v.recipient:{};
            const candidate=change.field==="standby"?m.phone_number_id:r.phone_number_id;
            const phone=typeof candidate==="string"&&/^[0-9]{1,32}$/u.test(candidate)?candidate:null;
            const routes=await this.database.resolveMetaRoutingRoutes(entry.id,phone,appId,reference);
            const hash=hashLifecycle({object:body.object,entry:[{id:entry.id,changes:[change]}]});
            for(const route of routes){const evidence:MetaRoutingEvidence={schemaVersion:1,category:"UNRESOLVED_ROUTING",accountId:entry.id,
              phoneNumberId:route.phone_number_id,observedAt:new Date().toISOString(),payloadSha256:hash};
              routingPlans.push({route,input:{providerEventId:`routing:${hash}`,eventType:"meta.routing.unresolved",payload:{redacted:true},payloadSha256:hash,evidence}})}
            if(!routes.length)unroutedCount++;continue;
          }
          for(const unit of units){const routes=await this.database.resolveMetaRoutingRoutes(entry.id,unit.evidence.phoneNumberId,appId,reference);
            if(routes.length>1){
              if(this.testRecipients===undefined)throw new BadRequestException("Meta routing source is ambiguous");
              for(const route of routes){const evidence={...unit.evidence};delete evidence.peer;routingPlans.push({route,input:{providerEventId:`routing:${evidence.payloadSha256}`,eventType:"meta.routing.unresolved",payload:{redacted:true},payloadSha256:evidence.payloadSha256,evidence:{...evidence,category:"UNRESOLVED_ROUTING"}}})}
              continue;
            }
            if(!routes.length){unroutedCount++;continue}
            if(change.field==="messaging_handovers"&&!unit.evidence.peer){
              routingPlans.push({route:routes[0]!,input:{providerEventId:`routing:${unit.evidence.payloadSha256}`,eventType:"meta.routing.unresolved",payload:{redacted:true},payloadSha256:unit.evidence.payloadSha256,evidence:{...unit.evidence,category:"UNRESOLVED_ROUTING"}}});
              continue;
            }
            const payload={object:body.object,entry:[{id:entry.id,changes:[{field:unit.field,value:unit.value}]}]};
            const evidence=metaTestRoutingEvidence(this.testRecipients,unit.evidence);
            if(!evidence){recordWebhook("meta","rejected","test_recipient_scope");continue}
            routingPlans.push({route:routes[0]!,input:{providerEventId:`routing:${evidence.payloadSha256}`,eventType:evidence.category==="UNRESOLVED_ROUTING"?"meta.routing.unresolved":"meta.routing.passive",payload:this.testRecipients===undefined?payload:{redacted:true},payloadSha256:evidence.payloadSha256,evidence}});
          }continue;
        }
        }catch(error){if(this.testRecipients===undefined)throw error;guardedSafetyError??=error}
      }
    }
    // The catch below commits only safety holds, never ordinary work.
    if(templateSafetyError!==undefined)throw templateSafetyError;
    if(guardedSafetyError!==undefined)throw guardedSafetyError;
    for(const entry of body.entry){
      if(!isRecord(entry)||!Array.isArray(entry.changes))throw new BadRequestException("Meta webhook structure is invalid");
      for(const change of entry.changes){
        if(!isRecord(change))throw new BadRequestException("Meta webhook structure is invalid");
        if(typeof change.field==="string"&&change.field.startsWith("message_template_"))continue;
        if(change.field==="standby"||change.field==="messaging_handovers"){
          if(typeof entry.id!=="string"||!/^[0-9]{1,32}$/u.test(entry.id))throw new BadRequestException("Meta routing source is invalid");
          continue;
        }
        if(!isRecord(change.value))throw new BadRequestException("Meta webhook structure is invalid");
        if (["history", "smb_app_state_sync", "smb_message_echoes"].includes(String(change.field))) {
          if (body.object !== "whatsapp_business_account" || !appId || !/^[0-9]{5,32}$/u.test(appId)) throw new BadRequestException("Business app webhook context is invalid");
          let units;
          try { units = metaCoexistenceUnits(entry.id, change.field, change.value); }
          catch { throw new BadRequestException("Business app webhook structure is invalid"); }
          for (const original of units) {
            const unit=metaTestCoexistenceUnit(this.testRecipients,original);
            if(!unit){recordWebhook("meta","rejected","test_recipient_scope");continue}
            if(unit.messages.length!==original.messages.length||unit.contacts.length!==original.contacts.length)recordWebhook("meta","rejected","test_recipient_scope");
            const route = await this.database.resolveMetaWebhookRoute(unit.phoneId);
            if (!route) { unroutedCount++; continue; }
            coexistencePlans.push({ route, input: { unit, appId, sourceSha256: unit.sourceSha256 } });
          }
          continue;
        }
        if(change.field==="messages"){
          if(body.object!=="whatsapp_business_account")throw new BadRequestException("Meta message object is invalid");
          if (this.testRecipients===undefined&&(["history", "state_sync", "message_echoes"].some(key => Object.hasOwn(change.value!, key))
            || (Array.isArray(change.value.messages) && change.value.messages.some(message => isRecord(message) && Object.hasOwn(message, "history_context"))))) {
            throw new BadRequestException("Business app data cannot use the live message field");
          }
          const externalKey=metaExternalKey(change.value);if(!externalKey){unroutedCount++;continue}
          const ordinaryRoute=await this.database.resolveMetaWebhookRoute(externalKey);
          if(!ordinaryRoute&&!(Array.isArray(change.value.messages)&&change.value.messages.some(message=>isRecord(message)&&message.type==="system"&&!message.group_id))){unroutedCount++;continue}
          if(this.testRecipients!==undefined){
            const count=(Array.isArray(change.value.messages)?change.value.messages.filter(isRecord).length:0)
              +(Array.isArray(change.value.statuses)?change.value.statuses.filter(isRecord).length:0)
              +(Array.isArray(change.value.errors)&&change.value.errors.some(error=>safeMetaWebhookError(error))?1:0);
            if(count>1_000)throw new BadRequestException("Meta webhook contains too many events");
          }
          const linkedStatuses=new Map<Record<string,unknown>,MetaTestRecipientLink>();
          if(this.testRecipients!==undefined&&ordinaryRoute&&Array.isArray(change.value.statuses))for(const status of change.value.statuses){
            if(!isRecord(status)||typeof status.recipient_user_id!=="string")continue;
            const link=await this.database.metaTestStatusRecipientLink(ordinaryRoute,status);
            if(link)linkedStatuses.set(status,link);
          }
          const scoped=metaTestWebhookUnits(this.testRecipients,change.value,Date.now(),status=>linkedStatuses.has(status));
          for(let index=0;index<scoped.dropped;index++)recordWebhook("meta","rejected","test_recipient_scope");
          for(const value of scoped.values)for(const unit of await metaEventUnits(value,entry.id)){
            if(this.testRecipients!==undefined&&unit.eventType==="messages"&&Array.isArray(unit.value.messages)&&isRecord(unit.value.messages[0])&&unit.value.messages[0].type==="system")continue; // already a redacted negative
            // Every pinned message needs its signed account context. Keep the
            // existing status/error projections and fail-closed historical hashes.
            const payload={entry:[{...(unit.eventType==="messages"?{id:entry.id}:unit.observedEnvelopeAccountId?{id:unit.observedEnvelopeAccountId}:{}),changes:[{field:"messages",value:unit.value}]}]};
            const payloadSha256=unit.eventType==="message.status"?metaStatusPayloadSha256(payload):await sha256Hex(JSON.stringify(payload));
            const identitySafety=unit.eventType==="messages"?metaDirectIdentityChangeEvidence(payload,payloadSha256):null;
            const route=ordinaryRoute??(identitySafety?await this.database.resolveMetaIdentityWebhookRoute(externalKey):null);
            if(!route){unroutedCount++;continue}
            if(unit.eventType!=="meta.error")assertMetaEventFresh(unit.value);
            let evidence:MetaRoutingEvidence|undefined;
            const messages=unit.value.messages;
            const direct=Array.isArray(messages)&&isRecord(messages[0])&&!messages[0].group_id&&messages[0].type!=="system";
            if(direct||unit.eventType==="message.status"){
              if(!appId||!/^[0-9]{1,32}$/u.test(appId))throw new ServiceUnavailableException("Meta routing verification is unavailable");
              try{evidence=metaRoutingUnits(entry.id,"messages",unit.value)[0]?.evidence}catch{throw new BadRequestException("Meta routing source is invalid")}
            }
            // Routing evidence binds the exact existing stored projection, preserving ordinary/status/error idempotency hashes.
            if(evidence)evidence={...evidence,payloadSha256};
            const providerEventId=this.testRecipients!==undefined&&unit.eventType==="message.status"
              ?`status:test:v1:${metaStatusPayloadSha256({statusEventId:unit.providerEventId,sourceSha256:unit.value.test_recipient_source_sha256})}`:unit.providerEventId;
            const status=Array.isArray(unit.value.statuses)&&isRecord(unit.value.statuses[0])?unit.value.statuses[0]:undefined;
            const linkedStatus=status?[...linkedStatuses].find(([original])=>original.id===status.id&&original.recipient_user_id===status.recipient_user_id)?.[1]:undefined;
            plans.push({route,lifecycle:false,input:{providerEventId,eventType:unit.eventType,payload,payloadSha256,routeKey:externalKey,providerSessionKey:externalKey,providerEngine:"CLOUD_API",...(evidence?{metaRoutingEvidence:evidence}:{}),...(linkedStatus?{metaTestRecipientLink:linkedStatus}:{})}});
          }
          continue;
        }
        if(change.field!=="account_update"){unroutedCount++;continue}
        if(this.testRecipients!==undefined&&classifyLifecycle(change.value,appId??"").kind==="BLOCK")continue; // safety pre-scan
        const lifecycle=await this.metaLifecyclePlans(body.object,entry,change,appId);
        if(!lifecycle.length)unroutedCount++;
        plans.push(...lifecycle);
      }
    }
    }catch(error){
      // Signed negative markers survive independently of ordinary content.
      const safety=await commitSafety(true);
      for(const tenantId of safety.tenants)await this.drains.wakeInbound(tenantId);
      if(safety.errors.length)throw new AggregateError([error,...safety.errors],"Meta safety admission failed");
      throw error;
    }
    const safety=await commitSafety(false),tenants=safety.tenants;
    if(safety.errors.length){for(const tenantId of tenants)await this.drains.wakeInbound(tenantId);throw new AggregateError(safety.errors,"Meta safety admission failed")}
    let acceptedCount=templateSafety.accepted+safety.acceptedCount,duplicateCount=templateSafety.duplicates+safety.duplicateCount;
    // Commit negatives before any ordinary event can be dispatched, even in a mixed envelope.
    if(this.testRecipients!==undefined)for(const plan of routingPlans){
      if(["STANDBY_MESSAGE","CONTROL_TAKEN","UNRESOLVED_ROUTING"].includes(plan.input.evidence.category))continue;
      const accepted=await this.database.acceptMetaRoutingEvent(plan.route,plan.input);
      if(accepted.duplicate)duplicateCount++;else{acceptedCount++;tenants.add(plan.route.tenant_id)}
    }
    for(const plan of plans){const accepted=plan.lifecycle?await this.database.acceptMetaLifecycleEvent(plan.route as MetaLifecycleRoute,plan.input as never):await this.database.acceptWebhookEvent(plan.route as WebhookRoute,plan.input as never);recordWebhook("meta",accepted.duplicate?"duplicate":"accepted");if(accepted.duplicate)duplicateCount++;else{acceptedCount++;tenants.add(plan.route.tenant_id)}}
    for (const plan of coexistencePlans) {
      const accepted = await this.database.acceptMetaCoexistenceEvent(plan.route, plan.input);
      if (accepted.duplicate) duplicateCount++; else { acceptedCount++; tenants.add(plan.route.tenant_id); }
    }
    for(const tenantId of tenants)await this.drains.wakeInbound(tenantId);
    return{accepted:true,count:acceptedCount,duplicates:duplicateCount,unrouted:unroutedCount};
  }

  private async metaLifecyclePlans(object:unknown,entry:{id?:string;time?:number},change:{field?:string;value?:Record<string,unknown>},appId:string|undefined):Promise<MetaPlan[]>{
        if(!isRecord(change.value))throw new BadRequestException("Meta lifecycle value is invalid");
        if(object!=="whatsapp_business_account")throw new BadRequestException("Meta lifecycle object is invalid");
        if(!appId||!/^[0-9]{5,32}$/.test(appId))throw new ServiceUnavailableException("Meta lifecycle verification is unavailable");
        const configuredAppId=appId;const classified=classifyLifecycle(change.value,configuredAppId);
        const isolatedEntry=metaLifecycleEntry(entry,{...change,value:metaTestLifecycleValue(this.testRecipients,change.value)});
        const display=change.value.phone_number===undefined?undefined:normalizeMetaDisplayPhoneNumber(change.value.phone_number);if(change.value.phone_number!==undefined&&!display)throw new BadRequestException("Meta lifecycle phone number is invalid");
        const targetWaba=metaLifecycleWaba(entry,change.value);const routes=await this.database.resolveMetaLifecycleRoutes(targetWaba,configuredAppId);if(new Set(routes.map(route=>route.connection_id)).size!==routes.length)throw new BadRequestException("Meta lifecycle route is ambiguous");
        if(!routes.length)return [];
        let selected=routes;let phoneScope:"ACCOUNT"|"EXACT_DISPLAY"|"UNRESOLVED_DISPLAY"="ACCOUNT";let effectiveKind=classified.kind;
        if(change.value.phone_number!==undefined){const matched=display?routes.filter(route=>route.display_phone_number===display):[];if(matched.length===1){selected=matched;phoneScope="EXACT_DISPLAY"}else{phoneScope="UNRESOLVED_DISPLAY";if(classified.kind==="RECOVERY")effectiveKind="OBSERVATION"}}
        const providerPayload={object:"whatsapp_business_account",entry:[isolatedEntry]};const payloadSha256=hashLifecycle(providerPayload);
        const eventType=metaLifecycleEventType(effectiveKind);const providerEventId=`lifecycle:${payloadSha256}`;
        return selected.map(route=>{const payload={...providerPayload,admission:{schemaVersion:1,observedAt:new Date(isolatedEntry.time*1000).toISOString(),providerPayloadSha256:payloadSha256,kind:classified.kind,reasons:classified.reasons,asset:{providerSessionId:route.provider_session_id,phoneNumberId:route.phone_number_id,wabaId:route.waba_id,appId:configuredAppId},phoneScope}};return{route,lifecycle:true,input:{providerEventId,eventType,payload,payloadSha256}}});
  }
  @Post("routing/:token")@HttpCode(202)
  async routing(@Param("token")token:string,@Req()request:RawWebhookRequest,@Body()body:Record<string,unknown>){
    if(this.routingConnectors?.externalConnectorsEnabled!==true)throw new NotFoundException("Webhook route was not found");
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new NotFoundException("Webhook route was not found");if(!header(request,"content-type")?.toLowerCase().startsWith("application/json"))throw new BadRequestException("Webhook content type must be application/json");
    const route=await this.database.resolveClientRoutingWebhookRoute(await sha256Hex(token));if(!route)throw new NotFoundException("Webhook route was not found");const raw=rawBody(request,1_000_000);const secret=await this.resolveRoutingSecret(route.secret_reference,route.tenant_id);let eventId:string|undefined;
    if(route.kind==="NOTION"){
      const verificationToken=boundedSecret(stringValue(body.verification_token));
      if(verificationToken){if(!this.secretProvisioning)throw new ServiceUnavailableException("Notion webhook verification is temporarily unavailable");const credential=await this.secrets.resolveRoutingCredential(route.secret_reference,{kind:"routing",tenantId:route.tenant_id});await this.secretProvisioning.storeRoutingCredential(route.secret_reference,{...credential,hmacKey:verificationToken});return{accepted:true,verification:true}}
      eventId=boundedIdentifier(body.id);const verification=await verifyProviderHmac({rawBody:raw,secret,provided:header(request,"x-notion-signature")??"",algorithm:"sha256"});if(!verification.valid)throw new UnauthorizedException("Invalid webhook signature");
    }else if(route.kind==="ZOHO"){
      const timestamp=String(body.server_time??"");const freshness=verifyWebhookTimestamp(timestamp);if(!freshness.valid)throw new UnauthorizedException(freshness.reason==="stale"?"Stale webhook request":"Invalid webhook timestamp");if(!constantTimeEqual(stringValue(body.token)??"",secret))throw new UnauthorizedException("Invalid webhook token");eventId=await sha256Hex(raw);
    }else{
      eventId=`body:${await sha256Hex(raw)}`;const verification=await verifyProviderHmac({rawBody:raw,secret,provided:header(request,"x-wasalx-signature")??"",algorithm:"sha256"});if(!verification.valid)throw new UnauthorizedException("Invalid webhook signature");
    }
    if(!eventId||eventId.length>512)throw new BadRequestException("Webhook event ID is required");const accepted=await this.database.enqueueClientRoutingWebhook(route,await sha256Hex(`${route.kind}:${eventId}`));recordWebhook("unknown",accepted.duplicate?"duplicate":"accepted","routing");if(!accepted.duplicate)await this.drains.wakeRouting(route.tenant_id);return{accepted:true,duplicate:accepted.duplicate,event_id:accepted.job_id}
  }

  private async resolveSecret(route:WebhookRoute){try{return await this.secrets.resolveHmac(route.hmac_secret_reference,route.provider==="META"?{kind:"exact",expectedReference:process.env.META_APP_SECRET_REFERENCE??""}:{kind:"waha-webhook",tenantId:route.tenant_id,connectionId:route.connection_id})}catch{throw new ServiceUnavailableException("Webhook verification is temporarily unavailable")}}
  private async resolveRoutingSecret(reference:string,tenantId:string){try{return await this.secrets.resolveHmac(reference,{kind:"routing",tenantId})}catch{throw new ServiceUnavailableException("Webhook verification is temporarily unavailable")}}
}

function classifyLifecycle(value:unknown,appId:string){try{return classifyMetaLifecycleValue(value,appId)}catch{throw new BadRequestException("Meta lifecycle event is invalid")}}
function hashLifecycle(value:unknown){try{return metaLifecyclePayloadSha256(value)}catch{throw new BadRequestException("Meta lifecycle event is invalid")}}
function metaLifecycleEntry(entry:{id?:string;time?:number},change:{field?:string;value?:Record<string,unknown>}){const now=Math.floor(Date.now()/1000);if(typeof entry.id!=="string"||!/^[0-9]{5,32}$/.test(entry.id)||!Number.isSafeInteger(entry.time)||Number(entry.time)<=0||Number(entry.time)>now+300)throw new BadRequestException("Meta lifecycle event is invalid");return{id:entry.id,time:entry.time!,changes:[{field:"account_update",value:change.value!}]}}
function metaLifecycleWaba(entry:{id?:string},value:Record<string,unknown>){try{return metaLifecycleAccountId(entry.id,value)}catch{throw new BadRequestException("Meta lifecycle account is invalid")}}
function metaLifecycleEventType(kind:"BLOCK"|"RECOVERY"|"OBSERVATION"):MetaLifecycleEventType{return kind==="BLOCK"?"meta.account.lifecycle.block":kind==="RECOVERY"?"meta.account.lifecycle.recovery":"meta.account.lifecycle.observation"}
function rawBody(request:RawWebhookRequest,maxBytes=2_000_000){if(!request.rawBody)throw new ServiceUnavailableException("Raw webhook body is unavailable");if(request.rawBody.byteLength>maxBytes)throw new BadRequestException("Webhook body is too large");return Uint8Array.from(request.rawBody)}
function header(request:RawWebhookRequest,name:string){const value=request.headers[name];return Array.isArray(value)?value[0]:value}
function stringValue(value:unknown){return typeof value==="string"&&value.length?value:undefined}
function metaExternalKey(value:Record<string,unknown>){const metadata=value.metadata as Record<string,unknown>|undefined;return stringValue(metadata?.phone_number_id)}
async function metaEventUnits(value:Record<string,unknown>,accountId?:unknown){
  const messages=Array.isArray(value.messages)?value.messages.filter(isRecord):[];
  const statuses=Array.isArray(value.statuses)?value.statuses.filter(isRecord):[];
  const errors=(Array.isArray(value.errors)?value.errors:[]).flatMap(error=>{const safe=safeMetaWebhookError(error);return safe?[safe]:[]});
  const base={...value};delete base.messages;delete base.statuses;delete base.errors;
  const units:Array<{providerEventId:string;eventType:string;value:Record<string,unknown>;observedEnvelopeAccountId?:string}>=[];
  for(const message of messages){const id=boundedIdentifier(message.id);if(!id)throw new BadRequestException("Meta message ID is invalid");units.push({providerEventId:id,eventType:"messages",value:{...base,messages:[message]}})}
  for(const status of statuses){
    const id=boundedIdentifier(status.id);const state=boundedIdentifier(status.status,64);const timestamp=boundedIdentifier(status.timestamp,32);if(!id||!state||!timestamp)throw new BadRequestException("Meta receipt is invalid");
    const observation=metaPricingObservation(status,accountId,metaExternalKey(value));
    units.push({providerEventId:`status:v1:${metaStatusPayloadSha256({id,state,timestamp,revision:observation.revisionSha256})}`,eventType:"message.status",value:{...base,statuses:[status]},...(observation.observedEnvelopeAccountId?{observedEnvelopeAccountId:observation.observedEnvelopeAccountId}:{})});
  }
  if(errors.length){const errorValue={messaging_product:stringValue(value.messaging_product)??"whatsapp",metadata:{phone_number_id:metaExternalKey(value)},errors};units.push({providerEventId:`error:${await sha256Hex(JSON.stringify(errorValue))}`,eventType:"meta.error",value:errorValue})}
  if(!units.length)throw new BadRequestException("Meta webhook contains no supported events");
  if(units.length>1_000)throw new BadRequestException("Meta webhook contains too many events");
  return units;
}
function safeMetaWebhookError(value:unknown){if(!isRecord(value))return undefined;const code=Number(value.code);if(!Number.isSafeInteger(code)||code<0)return undefined;const subcode=Number(value.error_subcode);const type=stringValue(value.type);return{code,...(Number.isSafeInteger(subcode)&&subcode>=0?{error_subcode:subcode}:{}),...(type&&type.length<=64&&/^[A-Za-z0-9_.-]+$/u.test(type)?{type}:{})}}
function assertMetaEventFresh(value:Record<string,unknown>){const item=(Array.isArray(value.messages)?value.messages[0]:Array.isArray(value.statuses)?value.statuses[0]:undefined) as Record<string,unknown>|undefined;const seconds=Number(item?.timestamp);const now=Math.floor(Date.now()/1_000);if(!Number.isSafeInteger(seconds)||seconds<now-7*24*60*60||seconds>now+5*60)throw new UnauthorizedException("Stale or invalid Meta webhook timestamp")}
function boundedIdentifier(value:unknown,maximum=512){const result=stringValue(value);return result&&result.length<=maximum&&/^[A-Za-z0-9._:=+@-]+$/u.test(result)?result:undefined}
function boundedSecret(value:string|undefined){return value&&value.length>=16&&value.length<=4096&&!Array.from(value).some(character=>{const code=character.codePointAt(0)??0;return code<32||code===127})?value:undefined}
function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value)}
function constantTimeEqual(left:string,right:string){if(left.length!==right.length)return false;let mismatch=0;for(let index=0;index<left.length;index++)mismatch|=left.charCodeAt(index)^right.charCodeAt(index);return mismatch===0}
function rejectWaha(reason:"route"|"algorithm"|"timestamp"|"stale"|"signature"|"ownership"|"event",error:Error):never{recordWebhook("waha","rejected",reason);throw error}
