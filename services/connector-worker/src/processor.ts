import {currentMetaRuntimeCandidate} from "./meta-request-provenance.js";
import {currentMetaTransportBinding} from "./meta-transport-binding.js";
import {isVerifiedNonMarketingTemplate,verifyApprovedTicketTemplateSend,verifyMetaInheritedTemplateSend} from "./meta-template-send.js";
import {parseMetaBillingSnapshot} from "../../../packages/core/src/meta-account-policy.js";
import {assertMetaLifecycleAccess} from "../../../packages/core/src/meta-account-relation.js";
import {assertMetaCredentialProof} from "../../../packages/core/src/meta-account-relation.js";
import {MetaDirectEffectNotAttempted,assertMetaDirectAccountProof,MetaDirectIdentityError,parseMetaDirectRecipientSnapshot} from "../../../packages/core/src/meta-direct-identity.js";
import { renderNumberedChoices, renderOutboundText } from "../../../packages/core/src/outbound-text.js";
import type { MessagingProviderAdapter } from "../../../packages/connectors/src/types.js";
import { Buffer } from "node:buffer";
import timers from "node:timers/promises";
import { MetaGroupsAdapter, assertMetaTestOutboundAllowed } from "../../../packages/connectors/src/meta.js";
import { parseWahaTestRecipientAllowlist } from "../../../packages/core/src/waha-test-recipient-scope.js";
import { ProviderError } from "../../../packages/connectors/src/types.js";
import { WahaAdapter, assertWahaTestOutboundAllowed } from "../../../packages/connectors/src/waha.js";
import {
  backoffMs,
  botHandoffMaxAttemptsFromEnvironment,
  boundedAttempts,
  DEFAULT_MAX_ATTEMPTS,
  MAX_BOT_HANDOFF_ATTEMPTS,
} from "../../../packages/core/src/delivery.js";
import { advanceBotFlow, parseBotFlow } from "../../../packages/core/src/bot-flow.js";
import { ZammadClient, ZammadError } from "../../../packages/zammad/src/client.js";
import { MediaRuntimeError, isQuarantinedMediaError, isRetryableMediaError, type OutboundMediaPipeline } from "./media-runtime.js";
import { OutboxRepository } from "./repository.js";
import { executeBotAction } from "./bot-action.js";
import { SecretResolutionError, type SecretResolver } from "./secrets.js";
import type { BotActionJob, BotHandoffJob, ConversationStateJob, DirectCustomerCloseJob, DeliveryJob, StatusJob } from "./types.js";
import {
  currentTraceCarrier,
  observeDuration,
  recordDeliveryState,
  recordMetric,
  recordStructuredLog,
  safeErrorCode as telemetryErrorCode,
} from "@wasalx/observability";

const GROUP_REACTION_CONTENT_TYPE="application/vnd.wasalx.whatsapp-reaction";
const AGENT_REPLY_SIGNAL_TIMEOUT_MS = 2_000;
const AGENT_REPLY_SIGNAL_MAX_ATTEMPTS = 3;

export class DeliveryProcessor{
  private readonly repository:OutboxRepository;private readonly secrets:SecretResolver;private readonly providerConfig:{wahaBaseUrl?:string;metaGraphVersion:string;metaAppId?:string};private readonly retryPolicy:Required<DeliveryRetryPolicy>;private readonly outboundMedia?:OutboundMediaPipeline;private readonly mediaSlots:AsyncSemaphore;
  constructor(repository:OutboxRepository,secrets:SecretResolver,providerConfig:{wahaBaseUrl?:string;metaGraphVersion:string;metaAppId?:string},retryPolicy:number|DeliveryRetryPolicy=DEFAULT_RETRY_POLICY,outboundMedia?:OutboundMediaPipeline,maxConcurrentMedia=2){if(!Number.isInteger(maxConcurrentMedia)||maxConcurrentMedia<1||maxConcurrentMedia>10)throw new Error("Outbound media concurrency is invalid");this.repository=repository;this.secrets=secrets;this.providerConfig=providerConfig;this.retryPolicy=normalizeRetryPolicy(retryPolicy);this.outboundMedia=outboundMedia;this.mediaSlots=new AsyncSemaphore(maxConcurrentMedia)}
  async drainTenant(tenantId:string,metaTransitionEventIds:string[]=[]){if(metaTransitionEventIds.length>32||metaTransitionEventIds.some(id=>!(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u).test(id)))throw new Error("Invalid transition wake");const actionLease=crypto.randomUUID();const actions=await this.repository.claimBotActions(tenantId,actionLease);await Promise.all(actions.map(job=>this.runBotAction(job,actionLease)));const deliveryLease=crypto.randomUUID();const jobs=await this.repository.claimDeliveries(tenantId,deliveryLease);const replySignals:Promise<void>[]=[];await Promise.all(groupDeliveriesByDestination(jobs).map(async destination=>{for(const job of destination)if(!await(job.media?this.mediaSlots.run(()=>this.deliver(job,deliveryLease,replySignals)):this.deliver(job,deliveryLease,replySignals)))break}));const handoffLease=crypto.randomUUID();const handoffs=(await this.repository.claimBotHandoffs?.(tenantId,handoffLease))??[];await Promise.all(handoffs.map(job=>this.runBotHandoff(job,handoffLease)));const closeLease=crypto.randomUUID();const closes=(await this.repository.claimDirectCustomerCloses?.(tenantId,closeLease))??[];for(const job of closes)await this.runDirectCustomerClose(job,closeLease);const conversationStateLease=crypto.randomUUID();const conversationStates=(await this.repository.claimConversationStates?.(tenantId,conversationStateLease))??[];await Promise.all(conversationStates.map(job=>this.reportConversationState(job,conversationStateLease)));const statusLease=crypto.randomUUID();const statuses=await this.repository.claimStatuses(tenantId,statusLease);await Promise.all(statuses.map(job=>this.reportStatus(job,statusLease)));await this.repository.reconsiderMetaIdentityTransitions?.(tenantId,{conversationIds:[...new Set([...actions.filter(job=>job.origin==="DIRECT_FLOW").map(job=>job.conversationId),...handoffs.map(job=>job.conversationId),...conversationStates.map(job=>job.conversationId)])],deliveryIds:[...new Set([...jobs.map(job=>job.id),...statuses.map(job=>job.deliveryId)])],ticketIds:closes.map(job=>job.ticketId),sourceEventIds:metaTransitionEventIds},this.providerConfig.metaAppId??"");await Promise.all(replySignals);return{actions:actions.length,deliveries:jobs.length,statuses:statuses.length}}
  private async runBotAction(job:BotActionJob,leaseId:string){
    const retriesRemain = job.attempts < this.retryPolicy.botAction;
    let result:Awaited<ReturnType<typeof executeBotAction>>=job.recordedResult??{state:"FAILED_TERMINAL",safeError:"Bot action result is unavailable"};
    if(!job.recordedResult){
      try{
        if(job.credentialAvailable===false)throw new Error("Bot action credential connection is unavailable");
        if(job.authScheme==="BEARER"&&(!job.secretReference||!job.actionKey))throw new Error("Bot action credential is unavailable");
        const secret=job.authScheme==="BEARER"?await this.secrets.resolve(job.secretReference!,{kind:"bot-action",tenantId:job.tenantId,actionKey:job.actionKey!,actionKind:job.kind}):undefined;
        result=await executeBotAction(job,secret?.accessToken??secret?.token??secret?.value,undefined,job.origin==="DIRECT_FLOW"?()=>this.repository.assertBotActionIdentityCurrent(job,leaseId,this.providerConfig.metaAppId??""):undefined);
      }catch(error){
        if(error instanceof MetaDirectEffectNotAttempted&&job.origin==="DIRECT_FLOW"){if(error.reason==="BUSY"&&retriesRemain)await this.repository.retryBotAction(job,leaseId,safeError(error),new Date(Date.now()+backoffMs(job.attempts)).toISOString());else await this.repository.holdUnattemptedBotActionIdentity(job,leaseId);return;}
        const retryable=error instanceof SecretResolutionError&&error.retryable&&retriesRemain;
        if(retryable){await this.repository.retryBotAction(job,leaseId,safeError(error),new Date(Date.now()+backoffMs(job.attempts)).toISOString());return}
        result={state:"FAILED_TERMINAL",safeError:safeError(error)};
      }
      if(result.state==="FAILED_RETRYABLE"&&retriesRemain){await this.repository.retryBotAction(job,leaseId,result.safeError,new Date(Date.now()+result.retryAfterMs).toISOString());return}
      if(result.state==="OUTCOME_UNKNOWN"){await this.repository.outcomeUnknownBotAction(job,leaseId,result.safeError);return}
      await this.repository.recordBotActionResult(job,leaseId,result.state==="SUCCEEDED"?"SUCCEEDED":"FAILED_TERMINAL",result.state==="SUCCEEDED"?result.variables:{},result.state==="SUCCEEDED"?undefined:result.safeError);
    }
    const succeeded=result.state==="SUCCEEDED";
    const variables=result.state==="SUCCEEDED"?result.variables:{};
    const actionError=result.state==="SUCCEEDED"?undefined:result.safeError;
    const terminalState=succeeded?"SUCCEEDED":"FAILED_TERMINAL";
    if(job.origin==="QUALIFICATION"){
      await this.repository.completeBotActionQualification(job,leaseId,terminalState,variables,actionError);
      return;
    }
    const next=succeeded?job.onSuccessNodeId:job.onFailureNodeId;
    const advanced=advanceBotFlow(parseBotFlow(job.flowDefinition),next,undefined,{...job.conversationVariables,...variables});
    await this.repository.completeBotAction(job,leaseId,terminalState,variables,advanced,actionError);
  }
  private async runBotHandoff(job:BotHandoffJob,leaseId:string){
    try{
      const secret=await this.secrets.resolve(job.zammadSecretReference,{kind:"zammad",tenantId:job.tenantId,purpose:"service"});if(!secret.token)throw new Error("Zammad service token is missing");
      const ticketId=Number(job.zammadTicketId);if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new Error("Invalid Zammad ticket ID");
      const ownerId=job.zammadOwnerId===undefined?undefined:Number(job.zammadOwnerId);if(ownerId!==undefined&&(!Number.isSafeInteger(ownerId)||ownerId<=0))throw new Error("Invalid Zammad owner ID");
      const client=new ZammadClient({baseUrl:job.zammadBaseUrl,token:secret.token,beforeRequest:()=>this.repository.assertBotHandoffIdentityCurrent(job,leaseId,this.providerConfig.metaAppId??"")});
      const routing=/^[1-9]\d{0,15}$/u.test(job.zammadGroupId)&&Number.isSafeInteger(Number(job.zammadGroupId))?{group_id:Number(job.zammadGroupId)}:{group:job.zammadGroupId};
      await client.updateTicket(ticketId,{...routing,...(ownerId?{owner_id:ownerId}:{}),priority:job.priority,state:"open"});
      const observed=await client.getTicket(ticketId);
      // Native create-time defaults may choose an owner for legacy group-only flows.
      // An explicitly requested owner must be read back exactly before success.
      if(("group_id" in routing?observed.group_id!==routing.group_id:observed.group!==routing.group)||(ownerId!==undefined&&observed.owner_id!==ownerId))throw new ZammadError("Native handoff assignment could not be verified",false);
      const key=`bot-handoff:${job.id}`;
      if(!await client.hasTicketArticlePreference(ticketId,"wasalx_handoff_key",key))await client.addArticle(ticketId,{body:"WasalX bot handed this WhatsApp conversation to a person.",content_type:"text/plain",type:"note",internal:true,sender:"System",subject:"Human handoff",preferences:{wasalx_handoff_key:key}});
      await this.repository.completeBotHandoff(job,leaseId);
    }catch(error){if(error instanceof MetaDirectEffectNotAttempted&&error.reason!=="BUSY"){await this.repository.failBotHandoff(job,leaseId,safeError(error));return;}const retryable=job.attempts<this.retryPolicy.botHandoff&&(!(error instanceof ZammadError)||error.retryable)&&(!(error instanceof SecretResolutionError)||error.retryable);const detail=safeError(error);if(retryable)await this.repository.retryBotHandoff(job,leaseId,detail,new Date(Date.now()+backoffMs(job.attempts)).toISOString());else await this.repository.failBotHandoff(job,leaseId,detail)}
  }
  private async adapter(job:DeliveryJob,leaseId:string,authorizeTestRecipient?: (bsuid:string)=>Promise<string|undefined>,checkTestRecipient?:()=>Promise<void>):Promise<MessagingProviderAdapter>{
    const secret=await this.secrets.resolve(job.connectionSecretReference,job.provider==="waha"?{kind:"exact",expectedReference:job.connectionSecretReference}:{kind:"meta-connection",tenantId:job.tenantId,connectionId:job.connectionId});
    if(job.provider==="waha"){
      if(!secret.apiKey)throw new Error("WAHA API key is missing");
      if(!job.providerBaseUrl||!job.wahaWorkerId||job.wahaAssignmentFencingToken===undefined)throw new Error("WAHA worker assignment is unavailable");
      return new WahaAdapter({baseUrl:job.providerBaseUrl,apiKey:secret.apiKey,sessionFor:()=>job.sessionId});
    }
    if(!secret.accessToken)throw new Error("Meta access token is missing");
    const accessToken=secret.accessToken;
    const assertProof=()=>{
      if(!job.metaCredentialContext)throw new ProviderError("Meta credential context is unavailable.",false,"META_CREDENTIAL_CONTEXT_CHANGED",undefined,true);
      try{
        assertMetaCredentialProof(job.metaCredentialContext.proof,{appId:this.providerConfig.metaAppId??"",accessToken});
        if(job.recipientType==="DIRECT"&&parseMetaDirectRecipientSnapshot(job.metaDirectRecipientSnapshot).claim==="ALIAS_VERIFIED"){
          assertMetaDirectAccountProof(job.metaCredentialContext.proof,{...job.metaCredentialContext,tenantId:job.tenantId,connectionId:job.connectionId,
            secretReference:job.connectionSecretReference,appId:this.providerConfig.metaAppId??"",accessToken});
        }
      }
      catch{throw new ProviderError("Meta credential proof is invalid or expired.",false,"META_CREDENTIAL_PROOF_INVALID",undefined,true);}
    };
    // Reject invalid metadata before staging any source/article/provider work.
    assertProof();
    const beforeRequest=async(purpose?: "agent-reply-signal")=>{
      try{if(purpose!=="agent-reply-signal")await this.repository.assertMetaDeliveryContextCurrent(job,leaseId);}
      catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError("Meta credential context could not be checked.",true,"META_CREDENTIAL_CONTEXT_UNAVAILABLE",undefined,true);}
      await checkTestRecipient?.();
      assertProof();
      try{assertMetaLifecycleAccess(job.metaCredentialContext?.lifecycle);}
      catch{throw new ProviderError("Meta account access requires lifecycle reconciliation.",false,"META_ACCOUNT_LIFECYCLE_HELD",undefined,true);}
    };
    const beforeMessageSend=async(hash:string,phoneNumberId:string)=>{
      try{
        assertProof();
        const ticketTemplateProof=await verifyApprovedTicketTemplateSend(job,adapter,
          ()=>this.repository.metaTicketTemplateSafetyRevision(job,leaseId));
        const templateProof=await verifyMetaInheritedTemplateSend(job,leaseId,
          {context:(currentJob,currentLease)=>this.repository.metaInheritedTemplateContext(currentJob,currentLease)},adapter);
        // A failed/missing local descriptor is UNKNOWN, never a caller-selected mode.
        let runtime;
        try{runtime=await currentMetaRuntimeCandidate({...await currentMetaTransportBinding(this.providerConfig.metaGraphVersion),graphVersion:this.providerConfig.metaGraphVersion});}catch{/* UNKNOWN */}
        const nonMarketing=Boolean(job.template&&await this.repository.whatsAppMarketingOptedOut(job)
          &&(ticketTemplateProof?.nonMarketing??await isVerifiedNonMarketingTemplate(job,adapter)));
        await this.repository.admitMetaMessageRequest(job,leaseId,hash,runtime,phoneNumberId,templateProof,nonMarketing,ticketTemplateProof);assertProof();
        await checkTestRecipient?.();
      }
      catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError("Message request admission is unavailable.",true,"META_MESSAGE_ADMISSION_UNAVAILABLE",undefined,true);}
    };
    const adapter:MetaGroupsAdapter=new MetaGroupsAdapter({accessToken,graphVersion:this.providerConfig.metaGraphVersion,phoneNumberIdFor:()=>job.sessionId,
      wabaIdFor:()=>job.metaCredentialContext?.wabaId??"",beforeRequest,beforeMessageSend,authorizeTestRecipient});
    return adapter;
  }
  private async deliver(job:DeliveryJob,leaseId:string,replySignals:Promise<void>[]){
    let adapter:MessagingProviderAdapter;
    let sendInput!:Parameters<MessagingProviderAdapter["send"]>[0];
    let checkTestRecipient=async()=>{};
    const beforeNativeRequest=job.provider==="meta"&&job.recipientType==="DIRECT"
      ?async()=>{await this.repository.assertMetaDeliveryContextCurrent(job,leaseId);await checkTestRecipient();await this.repository.assertMetaBillingSendCurrent(job,leaseId);}:undefined;
    try{
      const reaction=job.contentType===GROUP_REACTION_CONTENT_TYPE&&job.replyToMessageId
        ?{messageId:job.replyToMessageId,emoji:job.text,removed:job.text===""}:undefined;
      sendInput={connectionId:job.connectionId,groupId:job.groupId,recipientType:job.recipientType??"GROUP",
        ...(job.provider==="meta"&&job.recipientType==="DIRECT"?{metaDirectRecipient:parseMetaDirectRecipientSnapshot(job.metaDirectRecipientSnapshot).recipient}:{}),
        text:reaction?"":outboundText(job),...(reaction?{reaction}:{replyToMessageId:job.replyToMessageId}),
        ...(job.mentions?{mentions:job.mentions}:{}),idempotencyKey:job.idempotencyKey,...(job.choices?{choices:job.choices}:{}),
         ...(job.location?{location:job.location}:{}),...(job.template?{template:job.template}:{}),...(job.flow?{flow:job.flow}:{})};
      if(job.provider==="meta"&&job.metaBillingSnapshot!==null&&job.metaBillingSnapshot!==undefined){const billing=parseMetaBillingSnapshot(job.metaBillingSnapshot);if(billing.claim==="ACCOUNT_POLICY_BOUND")sendInput.messagingAccountId=billing.providerAccountId;}
      if(job.provider==="waha")assertWahaTestOutboundAllowed(sendInput);
      let authorizeTestRecipient:((bsuid:string)=>Promise<string|undefined>)|undefined;
      if(job.provider==="meta"){
        const snapshot=job.recipientType==="DIRECT"?parseMetaDirectRecipientSnapshot(job.metaDirectRecipientSnapshot):undefined;
        if(parseWahaTestRecipientAllowlist(process.env.WASALX_TEST_RECIPIENT_ALLOWLIST)!==undefined
          && (sendInput.metaDirectRecipient?.kind==="BSUID" || (snapshot?.claim==="ALIAS_VERIFIED"&&snapshot.testPhoneSender===true))){
          const admission=await this.repository.metaTestRecipientAdmission(job);
          if(admission.state==="PENDING"){
            await this.repository.deferMetaTestRecipient(job,leaseId);
            return false;
          }
          const link=admission.state==="READY"?admission.link:undefined;
          if(!link||!sendInput.metaDirectRecipient||sendInput.metaDirectRecipient.value!==(sendInput.metaDirectRecipient.kind==="PHONE"?link.phone:link.bsuid))
            throw new ProviderError("The test recipient identity is unavailable.",false,"META_TEST_RECIPIENT_NOT_ALLOWED",undefined,true);
          if(link){
            const pinned=JSON.stringify(link);
            authorizeTestRecipient=async bsuid=>{
              if(bsuid!==link.bsuid)return undefined;
              try{
                const current=await this.repository.metaTestRecipientLink(job);
                return current&&JSON.stringify(current)===pinned?current.phone:undefined;
              }catch(error){if(error instanceof ProviderError)throw error;throw new ProviderError("The test recipient identity could not be checked.",true,"META_TEST_RECIPIENT_UNAVAILABLE",undefined,true);}
            };
            checkTestRecipient=async()=>{if(!await authorizeTestRecipient!(link.bsuid))throw new ProviderError("The test recipient identity is unavailable.",false,"META_TEST_RECIPIENT_NOT_ALLOWED",undefined,true);};
          }
        }else assertMetaTestOutboundAllowed(sendInput);
      }
      adapter=await this.adapter(job,leaseId,authorizeTestRecipient,checkTestRecipient);
      // SENDING is the single durable privacy/handoff boundary for every
      // external mutation, including source cleanup and provider media upload.
      if(await this.repository.beginSend(job,leaseId)===false)return false;
      const ticketEventText=Boolean(job.ticketEventExecutionId)&&job.contentType==="text/plain";
      if(((job.directOrigin==="BOT"&&job.botConversationId)||ticketEventText)&&!job.articleId&&!job.media){
        if(!await this.repository.renewDeliveryLease(job,leaseId))return false;
        const secret=await this.secrets.resolve(job.zammadSecretReference,{kind:"zammad",tenantId:job.tenantId,purpose:"service"});
        if(!secret.token)throw new Error("Zammad service token is missing");
        const ticketId=Number(job.ticketId);if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new Error("Invalid Zammad ticket ID");
        const client=new ZammadClient({baseUrl:job.zammadBaseUrl,token:secret.token,beforeRequest:beforeNativeRequest});
        // Reuse the original key, including articles orphaned before this projection moved here.
        const existing=await client.findTicketArticlePreference(ticketId,"wasalx_bot_delivery_key",job.idempotencyKey);
        const article=existing??await client.addArticle(ticketId,{body:renderNumberedChoices(sendInput.text,job.choices?.options),content_type:"text/plain",type:"note",internal:false,sender:"Agent",subject:ticketEventText?"WasalX automated reply":"WasalX bot reply",preferences:{wasalx_origin:"bot",wasalx_bot_delivery_key:job.idempotencyKey,...(ticketEventText?{wasalx_ticket_event_execution_id:job.ticketEventExecutionId}:{})}});
        await persistMediaState(()=>this.repository.linkBotArticle(job,leaseId,String(article.id)),"Bot article state could not be persisted");
        job.articleId=String(article.id);
      }
      if(job.media){
        if(!await this.repository.renewDeliveryLease(job,leaseId))return false;
        if(!this.outboundMedia)throw new MediaRuntimeError("Outbound media runtime is unavailable","MEDIA_RUNTIME_UNAVAILABLE",false,false);
        let zammadToken="";
        if(!job.media.mediaObjectId||job.media.zammadUploadId||(job.botConversationId&&!job.articleId)){const zammadSecret=await this.secrets.resolve(job.zammadSecretReference,{kind:"zammad",tenantId:job.tenantId,purpose:"service"});if(!zammadSecret.token)throw new MediaRuntimeError("Zammad media credentials are unavailable","ZAMMAD_SECRET_INVALID",false,false);zammadToken=zammadSecret.token}
        const prepared=await this.outboundMedia.prepare(job,zammadToken,beforeNativeRequest);
        if(prepared.newlyLinked)await persistMediaState(
          ()=>this.repository.linkMediaObject(job,leaseId,prepared.mediaObjectId),
          "Media staging state could not be persisted",
        );
        if(prepared.cleanupSource){
          if(!await persistMediaState(()=>this.repository.renewDeliveryLease(job,leaseId),"Delivery lease could not be renewed before source cleanup"))return false;
          await prepared.cleanupSource();
        }
        if(job.directOrigin==="BOT"&&job.botConversationId&&!job.articleId){
          if(!await persistMediaState(()=>this.repository.renewDeliveryLease(job,leaseId),"Delivery lease could not be renewed before recording bot media"))return false;
          const ticketId=Number(job.ticketId);if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new MediaRuntimeError("Bot ticket identity is invalid","ZAMMAD_TICKET_INVALID",false,false);
          const client=new ZammadClient({baseUrl:job.zammadBaseUrl,token:zammadToken,beforeRequest:beforeNativeRequest});const key=`bot-media:${job.id}`;
          const existing=await client.findTicketArticlePreference(ticketId,"wasalx_bot_delivery_key",key);
          const article=existing??await client.addArticle(ticketId,{body:job.text||prepared.filename,content_type:"text/plain",type:"note",internal:false,sender:"Agent",subject:"WhatsApp bot media",attachments:[{filename:prepared.filename,data:Buffer.from(prepared.bytes).toString("base64"),"mime-type":prepared.mimeType}],preferences:{wasalx_origin:"bot",wasalx_bot_delivery_key:key}});
          await persistMediaState(()=>this.repository.linkBotArticle(job,leaseId,String(article.id)),"Bot media article state could not be persisted");job.articleId=String(article.id);
        }
        const mediaInput={filename:prepared.filename,mimeType:prepared.mimeType,bytes:prepared.bytes,providerMediaId:job.media.providerMediaId};
        sendInput={...sendInput,media:mediaInput};
        if(adapter.prepareMedia&&!mediaInput.providerMediaId){
          if(!await persistMediaState(()=>this.repository.renewDeliveryLease(job,leaseId),"Delivery lease could not be renewed before provider media upload"))return false;
          const providerMedia=await adapter.prepareMedia(sendInput);
          try{
            await this.repository.linkProviderMedia(job,leaseId,providerMedia.providerMediaId);
          }catch{
            await this.repository.outcomeUnknown(job,leaseId,"Provider media was uploaded but its durable reference could not be saved. Verify the provider state before retrying.");
            recordStructuredLog("error","delivery.provider_media_persistence_failed",{tenant_id:job.tenantId,delivery_id:job.id});
            recordMetric("wasalx_delivery_persistence_failure_total",1,{provider:job.provider});
            recordDeliveryState(job.provider,"OUTCOME_UNKNOWN","MEDIA_STATE_PERSIST");
            return false;
          }
          sendInput={...sendInput,media:{...mediaInput,providerMediaId:providerMedia.providerMediaId}};
        }else if(job.provider==="meta"&&!mediaInput.providerMediaId){
          throw new MediaRuntimeError("Meta media upload is unavailable","META_MEDIA_UNAVAILABLE",false,false);
        }
      }
    }catch(error){
      const retryableFailure=preSendRetryable(error);
      const retryable=retryableFailure&&job.attempts<this.retryPolicy[job.provider];
      const detail=safeError(error);
      const quarantineMediaCode=job.media&&!retryable&&isQuarantinedMediaError(error)?workerErrorCode(error):undefined;
      await this.repository.fail(job,leaseId,retryable,detail,retryable?new Date(Date.now()+backoffMs(job.attempts)).toISOString():undefined,retryableFailure,undefined,quarantineMediaCode);
      if(quarantineMediaCode)recordMetric("wasalx_media_quarantine_total",1,{source:"outbound",reason:telemetryErrorCode(error),result:"created"});
      recordDeliveryState(job.provider,retryable?"FAILED_RETRYABLE":"FAILED_TERMINAL",telemetryErrorCode(error));
      if(retryable)recordMetric("wasalx_delivery_retry_total",1,{provider:job.provider,reason:telemetryErrorCode(error)});
      return false;
    }
    const sendStartedAt=Date.now();let result:Awaited<ReturnType<MessagingProviderAdapter["send"]>>;
    let replySending = true;
    if (job.directOrigin==="HUMAN"&&job.botConversationId&&job.ticketId&&job.articleId&&(job.batchSequence??0)===0) {
      replySignals.push(this.signalAgentReply(job, leaseId, adapter, sendInput, () => replySending));
    }
    try{
      result=await adapter.send(sendInput).finally(() => { replySending = false; });
    }catch(error){
      const detail=safeError(error);
      if(!(error instanceof ProviderError)||!error.outcomeKnown){await this.repository.outcomeUnknown(job,leaseId,detail,error instanceof ProviderError?error.code:undefined);observeDuration("wasalx_provider_send_seconds",sendStartedAt,{provider:job.provider,result:"outcome_unknown"});observeOutboundToProvider(job,"outcome_unknown");recordDeliveryState(job.provider,"OUTCOME_UNKNOWN",telemetryErrorCode(error));return false}
      const retryable=error.retryable&&job.attempts<this.retryPolicy[job.provider];
      await this.repository.fail(job,leaseId,retryable,detail,retryable?new Date(Date.now()+backoffMs(job.attempts)).toISOString():undefined,error.retryable,error.code);
      observeDuration("wasalx_provider_send_seconds",sendStartedAt,{provider:job.provider,result:retryable?"retryable_failure":"terminal_failure"});
      observeOutboundToProvider(job,retryable?"retryable_failure":"terminal_failure");
      recordDeliveryState(job.provider,retryable?"FAILED_RETRYABLE":"FAILED_TERMINAL",telemetryErrorCode(error));
      if(retryable)recordMetric("wasalx_delivery_retry_total",1,{provider:job.provider,reason:telemetryErrorCode(error)});
      return false;
    }
    try{await this.repository.complete(job,leaseId,result.state,result.externalMessageId)}catch(error){recordStructuredLog("error","delivery.success_persistence_failed",{tenant_id:job.tenantId,delivery_id:job.id,error_code:telemetryErrorCode(error)});recordMetric("wasalx_delivery_persistence_failure_total",1,{provider:job.provider});return false}
    observeDuration("wasalx_provider_send_seconds",sendStartedAt,{provider:job.provider,result:"succeeded"});
    observeOutboundToProvider(job,"succeeded");
    recordDeliveryState(job.provider,result.state);
    return true;
  }
  private async signalAgentReply(
    job: DeliveryJob,
    leaseId: string,
    adapter: MessagingProviderAdapter,
    input: Parameters<MessagingProviderAdapter["send"]>[0],
    replySending: () => boolean,
  ) {
    const { traceparent, requestId } = currentTraceCarrier();
    const record = (signal: string, result: string) =>
      recordMetric("wasalx_agent_reply_signal_total", 1, { provider: job.provider, operation: signal, result });
    const recordFailure = (signal: string, error: unknown) => {
      record(signal, "failed");
      recordStructuredLog("warn", "delivery.agent_reply_signal_failed", {
        request_id: traceparent?.split("-")[1] ?? requestId,
        tenant_id: job.tenantId, delivery_id: job.id, provider: job.provider,
        signal, error_code: telemetryErrorCode(error),
      });
    };
    try {
      const source = await this.repository.admitAgentReplySignal(job, leaseId);
      if (!source) return;
      const operations = adapter.agentReplySignals?.({
        connectionId: input.connectionId,
        groupId: input.groupId,
        metaDirectRecipient: input.metaDirectRecipient,
        inboundMessageId: source.messageId,
      });
      if (!operations?.length) {
        record("read-and-typing", "unsupported");
        return;
      }
      await Promise.all(operations.map(async operation => {
        for (let attempt = 1; attempt <= AGENT_REPLY_SIGNAL_MAX_ATTEMPTS; attempt++) {
          try {
            const current = await this.repository.admitAgentReplySignal(job, leaseId, source.id);
            if (!current) {
              record(operation.kind, "no-longer-eligible");
              return;
            }
            const result = await operation.send(AbortSignal.timeout(AGENT_REPLY_SIGNAL_TIMEOUT_MS),
              () => current.canType && replySending());
            record(operation.kind, result);
            return;
          } catch (error) {
            if (!(error instanceof ProviderError && error.retryable) || attempt === AGENT_REPLY_SIGNAL_MAX_ATTEMPTS) {
              recordFailure(operation.kind, error);
              return;
            }
            await timers.setTimeout(backoffMs(attempt));
          }
        }
      }));
    } catch (error) {
      recordFailure("read-and-typing", error);
    }
  }
  private async runDirectCustomerClose(job:DirectCustomerCloseJob,leaseId:string){
    let attempted=job.state==='OUTCOME_UNKNOWN';let context:Awaited<ReturnType<ZammadClient['readDirectCustomerCloseContext']>>|undefined;
    try{
      const secret=await this.secrets.resolve(job.zammadSecretReference,{kind:'zammad',tenantId:job.tenantId,purpose:'service'});
      if(!secret.token)throw new Error('Zammad service token is missing');
      const ticketId=Number(job.ticketId);if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new Error('Invalid direct ticket ID');
      const client=new ZammadClient({baseUrl:job.zammadBaseUrl,token:secret.token});
      if(job.state==='OUTCOME_UNKNOWN'){
        const receipt=await client.readDirectCustomerCloseReceipt(ticketId,job.id);
        if((receipt as {state?:string})?.state==='SUCCEEDED')await this.repository.completeDirectCustomerClose(job,receipt);
        else await this.repository.holdDirectCustomerClose(job,leaseId);
        return;
      }
      const guardedClient=new ZammadClient({baseUrl:job.zammadBaseUrl,token:secret.token,beforeRequest:()=>this.repository.assertDirectCustomerCloseIdentityCurrent(job,leaseId,this.providerConfig.metaAppId??"")});
      context=await guardedClient.readDirectCustomerCloseContext(ticketId);
      await this.repository.prepareDirectCustomerClose(job,leaseId,context,this.providerConfig.metaAppId??"");
      attempted=true; // ATTEMPTED is now durably committed. NEVER repeat this POST.
      const receipt=await guardedClient.closeDirectCustomerTicket(ticketId,job.id);
      await this.repository.completeDirectCustomerClose(job,receipt);
    }catch(error){if(!attempted&&error instanceof MetaDirectEffectNotAttempted&&error.reason!=="BUSY"){await this.repository.holdUnattemptedDirectCustomerCloseIdentity(job,leaseId);return;}if(!attempted&&context&&error instanceof Error&&['DIRECT_CLOSE_NATIVE_ALREADY_CLOSED','DIRECT_CLOSE_CONVERSATION_CHANGED','DIRECT_CLOSE_NATIVE_IDENTITY_CHANGED','DIRECT_PRIVACY_HOLD'].includes(error.message)&&await this.repository.rejectUnattemptedDirectCustomerClose(job,leaseId,context,error.message))return;await this.repository.holdDirectCustomerClose(job,leaseId);recordStructuredLog('warn','direct_customer_close.held',{tenant_id:job.tenantId,command_id:job.id,outcome_unknown:attempted});}
  }
  private async reportConversationState(job:ConversationStateJob,leaseId:string){const startedAt=Date.now();try{if(!await this.repository.beginConversationState(job,leaseId))return;const secret=await this.secrets.resolve(job.zammadSecretReference,{kind:"zammad",tenantId:job.tenantId,purpose:"service"});if(!secret.token)throw new Error("Zammad service token is missing");const ticketId=Number(job.ticketId);if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new Error("Invalid Zammad ticket ID");const client=new ZammadClient({baseUrl:job.zammadBaseUrl,token:secret.token});await client.updateTicket(ticketId,{wasalx_bot_conversation:"true",wasalx_bot_state:job.state,wasalx_bot_keep_open:job.keepOpenEnabled?"true":"false"});await this.repository.completeConversationState(job,leaseId);recordMetric("wasalx_ticket_operation_total",1,{operation:"conversation_state",result:"succeeded"});observeDuration("wasalx_ticket_operation_seconds",startedAt,{operation:"conversation_state",result:"succeeded"})}catch(error){const detail=safeError(error);const terminal=job.attempts>=this.retryPolicy.zammadStatus||error instanceof SecretResolutionError&&!error.retryable;try{if(terminal)await this.repository.failConversationState(job,leaseId,detail);else await this.repository.retryConversationState(job,leaseId,detail,new Date(Date.now()+backoffMs(job.attempts)).toISOString())}catch{return}recordMetric("wasalx_ticket_operation_total",1,{operation:"conversation_state",result:terminal?"terminal_failure":"retryable_failure"});observeDuration("wasalx_ticket_operation_seconds",startedAt,{operation:"conversation_state",result:terminal?"terminal_failure":"retryable_failure"})}}
  private async reportStatus(job:StatusJob,leaseId:string){const startedAt=Date.now();try{const secret=await this.secrets.resolve(job.zammadSecretReference,{kind:"zammad",tenantId:job.tenantId,purpose:"service"});if(!secret.token)throw new Error("Zammad service token is missing");const ticketId=Number(job.ticketId);if(!Number.isSafeInteger(ticketId)||ticketId<=0)throw new Error("Invalid Zammad ticket ID");const client=new ZammadClient({baseUrl:job.zammadBaseUrl,token:secret.token});await client.updateTicket(ticketId,{wasalx_delivery_status:job.state});await this.repository.completeStatus(job,leaseId);recordMetric("wasalx_ticket_operation_total",1,{operation:"delivery_status",result:"succeeded"});observeDuration("wasalx_ticket_operation_seconds",startedAt,{operation:"delivery_status",result:"succeeded"})}catch(error){const detail=safeError(error);const terminal=job.attempts>=this.retryPolicy.zammadStatus||error instanceof SecretResolutionError&&!error.retryable;if(terminal)await this.repository.failStatus(job,leaseId,detail);else await this.repository.retryStatus(job,leaseId,detail,new Date(Date.now()+backoffMs(job.attempts)).toISOString());recordMetric("wasalx_ticket_operation_total",1,{operation:"delivery_status",result:terminal?"terminal_failure":"retryable_failure"});observeDuration("wasalx_ticket_operation_seconds",startedAt,{operation:"delivery_status",result:terminal?"terminal_failure":"retryable_failure"})}}
}
function groupDeliveriesByDestination(jobs:DeliveryJob[]){const destinations=new Map<string,DeliveryJob[]>();for(const job of jobs){const key=JSON.stringify([job.connectionId,job.groupId]);const destination=destinations.get(key);if(destination)destination.push(job);else destinations.set(key,[job])}return[...destinations.values()].map(destination=>{const unitCreatedAt=new Map<string,string>();for(const job of destination){const unit=job.batchId??job.id;const createdAt=job.createdAt??"";const current=unitCreatedAt.get(unit);if(current===undefined||createdAt<current)unitCreatedAt.set(unit,createdAt)}return destination.sort((left,right)=>compareDeliveryOrder(left,right,unitCreatedAt))})}
function compareDeliveryOrder(left:DeliveryJob,right:DeliveryJob,unitCreatedAt:Map<string,string>){if(left.batchId&&left.batchId===right.batchId)return(left.batchSequence??0)-(right.batchSequence??0)||left.id.localeCompare(right.id);const leftUnit=left.batchId??left.id;const rightUnit=right.batchId??right.id;return(unitCreatedAt.get(leftUnit)??"").localeCompare(unitCreatedAt.get(rightUnit)??"")||leftUnit.localeCompare(rightUnit)}
export type DeliveryRetryPolicy = {
  waha: number;
  meta: number;
  zammadStatus: number;
  botAction?: number;
  botHandoff?: number;
};
export const DEFAULT_RETRY_POLICY: Required<DeliveryRetryPolicy> = {
  waha: DEFAULT_MAX_ATTEMPTS,
  meta: DEFAULT_MAX_ATTEMPTS,
  zammadStatus: DEFAULT_MAX_ATTEMPTS,
  botAction: DEFAULT_MAX_ATTEMPTS,
  botHandoff: DEFAULT_MAX_ATTEMPTS,
};

export function retryPolicyFromEnvironment(env: Record<string, string | undefined>): Required<DeliveryRetryPolicy> {
  return {
    waha: boundedAttempts(env.WAHA_DELIVERY_MAX_ATTEMPTS, "WAHA_DELIVERY_MAX_ATTEMPTS"),
    meta: boundedAttempts(env.META_DELIVERY_MAX_ATTEMPTS, "META_DELIVERY_MAX_ATTEMPTS"),
    zammadStatus: boundedAttempts(env.ZAMMAD_STATUS_MAX_ATTEMPTS, "ZAMMAD_STATUS_MAX_ATTEMPTS"),
    botAction: boundedAttempts(env.BOT_ACTION_MAX_ATTEMPTS, "BOT_ACTION_MAX_ATTEMPTS"),
    botHandoff: botHandoffMaxAttemptsFromEnvironment(env),
  };
}

function normalizeRetryPolicy(value: number | DeliveryRetryPolicy): Required<DeliveryRetryPolicy> {
  if (typeof value === "number") {
    const attempts = boundedAttempts(String(value), "delivery retry attempts");
    return { ...DEFAULT_RETRY_POLICY, waha: attempts, meta: attempts, zammadStatus: attempts };
  }
  return {
    waha: boundedAttempts(String(value.waha), "WAHA retry attempts"),
    meta: boundedAttempts(String(value.meta), "Meta retry attempts"),
    zammadStatus: boundedAttempts(String(value.zammadStatus), "Zammad status retry attempts"),
    botAction: boundedAttempts(String(value.botAction ?? DEFAULT_RETRY_POLICY.botAction), "BOT_ACTION_MAX_ATTEMPTS"),
    botHandoff: boundedAttempts(String(value.botHandoff ?? DEFAULT_RETRY_POLICY.botHandoff), "BOT_HANDOFF_MAX_ATTEMPTS", MAX_BOT_HANDOFF_ATTEMPTS),
  };
}
function observeOutboundToProvider(job:DeliveryJob,result:string){if(!job.createdAt)return;const createdAt=new Date(job.createdAt).getTime();if(Number.isFinite(createdAt)&&createdAt<=Date.now())observeDuration("wasalx_outbound_to_provider_seconds",createdAt,{provider:job.provider,result})}
function safeError(error:unknown){return(error instanceof Error?error.message:"Unknown worker error").replace(/(token|secret|authorization|api[-_ ]?key)\s*[=:]\s*\S+/gi,"$1=[REDACTED]").slice(0,500)}
function workerErrorCode(error:unknown){return error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"?error.code:"OUTBOUND_MEDIA_REJECTED"}
function preSendRetryable(error:unknown){if(error instanceof MetaDirectIdentityError)return false;if(error instanceof ProviderError)return error.retryable&&error.outcomeKnown;if(error instanceof SecretResolutionError||error instanceof ZammadError)return error.retryable;if(error instanceof MediaRuntimeError||isQuarantinedMediaError(error)||isRetryableMediaError(error))return isRetryableMediaError(error);return true}
function outboundText(job:DeliveryJob){const text=renderOutboundText(job);if(text.length>65_536)throw new MediaRuntimeError("Outbound message is too large after applying the agent identity","MESSAGE_TOO_LARGE",false);return text}
async function persistMediaState<T>(operation:()=>Promise<T>,safeError:string){try{return await operation()}catch{throw new MediaRuntimeError(safeError,"MEDIA_STATE_PERSIST",true,false)}}
class AsyncSemaphore{private active=0;private readonly waiters:Array<()=>void>=[];constructor(private readonly maximum:number){}private acquire(){if(this.active<this.maximum){this.active+=1;return Promise.resolve()}return new Promise<void>(resolve=>this.waiters.push(()=>{this.active+=1;resolve()}))}async run<T>(operation:()=>Promise<T>){await this.acquire();try{return await operation()}finally{this.active-=1;this.waiters.shift()?.()}}}
