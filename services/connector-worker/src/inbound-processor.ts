import {ticketEventSourceHash} from '../../../packages/core/src/ticket-event-runtime.js';
import {TicketCommandAuthorizationError} from '../../../packages/core/src/ticket-event-flow.js';
import { nativeCommandOnce } from './native-command-once.js';
import { MetaGroupsAdapter } from "../../../packages/connectors/src/meta.js";
import { ProviderError } from "../../../packages/connectors/src/types.js";
import { MetaDirectIdentityError } from "../../../packages/core/src/meta-direct-identity.js";
import type { DirectProviderMessage, ProviderMessage, ProviderMessageMutation } from "../../../packages/connectors/src/types.js";
import { WahaAdapter, normalizeWahaPhone, type WahaReceiptRejection } from "../../../packages/connectors/src/waha.js";
import { backoffMs } from "../../../packages/core/src/delivery.js";
import { assertMetaCredentialProof, assertMetaLifecycleAccess, MetaLifecycleError, MetaCredentialMetadataError } from "../../../packages/core/src/meta-account-relation.js";
import type { ZammadAttachment } from "../../../packages/zammad/src/client.js";
import { formatZammadTicketTitle, ZammadClient, ZammadError } from "../../../packages/zammad/src/client.js";
import { normalizeMessage, rulesAllowUnmatchedAssociation, testRules, type RuleMatch, type TriggerRule } from "../../../lib/domain.js";
import {
  observeDuration,
  recordDeliveryState,
  recordMetric,
  recordWebhook,
} from "@wasalx/observability";
import { InboundAssociationError, InboundRepository } from "./inbound-repository.js";
import { directLocationText } from "./direct-location.js";
import { validatedPrivateWorkerUrl } from "./connection-operation-repository.js";
import { executeBotAction, type BotActionTransport } from "./bot-action.js";
import {
  MediaRuntimeError,
  isQuarantinedMediaError,
  isRetryableMediaError,
  type InboundMediaPipeline,
  type PreparedInboundMedia,
} from "./media-runtime.js";
import { isBotActionSecretReference, SecretResolutionError, type SecretResolver } from "./secrets.js";
import type { DirectBotContext, InboundContext, InboundEvent, InboundMediaContext } from "./types.js";

export class InboundProcessor {
  constructor(
    private readonly repository: InboundRepository,
    private readonly secrets: SecretResolver,
    private readonly media?: InboundMediaPipeline,
    private readonly maxAttempts = 8,
    private readonly actionTransport?:BotActionTransport,
    private readonly appId=process.env.META_APP_ID,
  ) {}

  async drainTenant(tenantId: string) {
    const leaseId = crypto.randomUUID();
    const events = await this.repository.claim(tenantId, leaseId);
    const results = await Promise.all(events.map((event) => this.process(event, leaseId)));
    return { events: events.length, acknowledgements: results.filter(Boolean).length };
  }

  private async process(event: InboundEvent, leaseId: string) {
    const appId = event.metaWebhookAppId ?? this.appId ?? "";
    let reviewContext: (InboundContext|DirectBotContext) | undefined;
    let reviewMessage: ProviderMessage | undefined;
    let reprocessReplyToMessageId: string | undefined;
    try {
      if (event.eventType.startsWith("meta.coexistence.")) {
        await this.repository.projectCoexistence(event, leaseId, appId);
        return false;
      }
      if(event.eventType==="meta.routing.passive"||event.eventType==="meta.routing.unresolved"){
        await this.repository.applyMetaRouting(event,leaseId,appId);
        return false;
      }
      if(event.eventType.startsWith("meta.account.lifecycle.")){
        await this.repository.applyMetaLifecycle(event,leaseId,appId);
        return false;
      }
      let receiptRejection: WahaReceiptRejection | undefined;
      const receipts = await normalizeReceipts(event, (reason) => { receiptRejection = reason; });
      if (receipts.length > 0) {
        if(receipts.length>100)throw new InboundValidationError("Receipt event exceeds the safe item limit");
        // A single provider webhook can carry several receipt records. Commit
        // the complete bounded set atomically before acknowledging the inbox.
        const ordered=orderReceipts(receipts);
        const receiptResults=await this.repository.applyDeliveryReceipts(event,receipts);
        for(const [index,result] of receiptResults.entries()){
          const receipt=ordered[index];
          if(!receipt)continue;
          recordMetric("wasalx_delivery_receipts_total",1,{
            provider:event.provider,
            status:receipt.status,
            scope:receipt.scope,
            result,
          });
          if(result==="APPLIED"){
            const state=receipt.status==="FAILED"?"FAILED_TERMINAL":receipt.status;
            recordDeliveryState(event.provider,state,receipt.providerStatus);
            if(receipt.status==="FAILED"){
              recordMetric("wasalx_media_quarantine_total",1,{
                source:"outbound",
                reason:"provider_delivery_failed",
                result:"created",
              });
            }
          }
        }
        if (receiptResults.includes("UNMATCHED")) {
          if (event.attempts < this.maxAttempts) throw new ProviderTargetPendingError("Provider delivery target is not available yet");
          await this.repository.complete(event, leaseId, "UNMATCHED", true, "PROVIDER_TARGET_UNAVAILABLE");
          return false;
        }
        const applied=receiptResults.includes("APPLIED");
        await this.repository.complete(event, leaseId, "PROCESSED", true);
        // A true result immediately wakes the delivery worker so the durable
        // Zammad status projection does not wait for the periodic scheduler.
        return applied;
      }
      if (event.eventType === "session.status") {
        const observation = providerStatusObservation(event);
        let identity: { phoneE164: string; pinnedWahaWorkerId: string } | undefined;
        if (event.provider === "waha" && observation.providerState === "WORKING") {
          const context = await this.repository.wahaIdentityContext(event, observation.opaqueSessionId);
          if (!context) throw new Error("WAHA working identity context is unavailable");
          const secret = await this.secrets.resolve(context.secretReference,{kind:"exact",expectedReference:context.secretReference});
          if (!secret.apiKey || secret.apiKey.length > 4_096) {
            throw new InboundValidationError("WAHA administrative credentials are unavailable");
          }
          const adapter = new WahaAdapter({
            baseUrl: validatedPrivateWorkerUrl(context.baseUrl),
            apiKey: secret.apiKey,
            sessionFor: () => context.opaqueSessionId,
          });
          const providerIdentity = await adapter.getIdentity(event.connectionId);
          const phoneE164 = normalizeWahaPhone(providerIdentity.phone);
          if (!phoneE164) throw new InboundValidationError("WAHA returned an invalid connected WhatsApp number");
          identity = { phoneE164, pinnedWahaWorkerId: context.wahaWorkerId };
        }
        const outcome = await this.repository.applyProviderStatus(event, observation, identity);
        recordMetric("wasalx_connection_transition_total",1,{
          provider:event.provider,
          source:"provider_status",
          state:observation.connectionState,
          result:outcome.toLowerCase(),
        });
        if(outcome==="APPLIED"&&observation.connectionState==="ACTION_REQUIRED"){
          recordMetric("wasalx_connection_reauthentication_total",1,{provider:event.provider,reason:"provider_status"});
        }
        await this.repository.complete(event, leaseId, "PROCESSED", true);
        return false;
      }

      if(event.eventType==="meta.error"){
        await this.repository.complete(event,leaseId,"QUARANTINED",true,"META_PROVIDER_ERROR");
        return false;
      }

      const mutation = await normalizeMutation(event);
      if (mutation) {
        if (mutation.fromApi) {
          await this.repository.complete(event, leaseId, "IGNORED", true, "PROVIDER_API_MUTATION");
          return false;
        }
        if(!await this.repository.messageIsWithinAdmissionWindow(event,mutation.timestamp)){
          await this.repository.complete(event,leaseId,"IGNORED",true,"PROVIDER_MESSAGE_BEFORE_ADMISSION_WINDOW");
          return false;
        }
        const directMutation=!mutation.groupId.endsWith("@g.us");
        const routingContext=directMutation?await this.repository.directContext(event,mutation.groupId):await this.repository.context(event,mutation.groupId);
        const workspaceContext=!directMutation&&!routingContext?await this.repository.workspaceMutationContext(event,mutation.groupId):null;
        const context=routingContext??workspaceContext;
        if (!context) {
          await this.repository.complete(event, leaseId, "IGNORED", true, directMutation?"DIRECT_BOT_NOT_ASSIGNED":"ROUTING_CONTEXT_UNAVAILABLE");
          return false;
        }
        const recorded=await this.repository.recordMessageMutation(event,mutation,Boolean(workspaceContext&&!routingContext));
        if (!recorded) {
          if (event.attempts < this.maxAttempts) throw new ProviderTargetPendingError("Provider message mutation target is not available yet");
          await this.repository.complete(event, leaseId, "UNMATCHED", true);
          return false;
        }
        if(recorded.supersededByRevocation){
          await this.repository.complete(event,leaseId,"PROCESSED",true,"EDIT_AFTER_REVOKE_SUPPRESSED");
          return false;
        }
        if(recorded.ticketIds.length===0){
          await this.repository.complete(event,leaseId,"PROCESSED",true,"UNLINKED_MESSAGE_MUTATION");
          return false;
        }
        if(!context.zammadBaseUrl||!context.zammadSecretReference){
          throw new Error("Zammad mutation projection is temporarily unavailable");
        }
        const secret = await this.secrets.resolve(context.zammadSecretReference,{kind:"zammad",tenantId:event.tenantId,purpose:"service"});
        if (!secret.token) throw new InboundValidationError("Zammad service token is missing");
        const zammad = new ZammadClient({ baseUrl: context.zammadBaseUrl, token: secret.token });
        for (const ticketId of new Set(recorded.ticketIds)) {
          const numericTicketId=ticketNumber(ticketId);
          const exists=await observeZammad(
            "find_message_mutation",
            () => zammad.hasTicketArticlePreference(numericTicketId,"wasalx_mutation_event_id",event.providerEventId),
          );
          if(exists)continue;
          await observeZammad("add_message_mutation",() => zammad.addArticle(
            numericTicketId,
            mutationArticle(mutation,event.providerEventId,recorded.targetExternalMessageId),
          ));
        }
        await this.repository.complete(event, leaseId, "PROCESSED", true);
        return false;
      }

      if(event.provider==="meta"&&event.eventType==="messages"){
        const change=await new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v1.0",phoneNumberIdFor:()=>"unused"})
          .normalizeIdentityChangeWebhook(event.connectionId,event.payload);
        if(change){
          await this.repository.applyMetaIdentityTransition(event,leaseId,change.change,appId);
          return false;
        }
      }
      let direct=await normalizeDirect(event);
      if(direct){
        if(direct.fromApi){
          await this.repository.complete(event,leaseId,"IGNORED",true,"PROVIDER_API_DIRECT_MESSAGE");
          return false;
        }
        if(!await this.repository.messageIsWithinAdmissionWindow(event,direct.timestamp)){
          await this.repository.complete(event,leaseId,"IGNORED",true,"PROVIDER_MESSAGE_BEFORE_ADMISSION_WINDOW");
          return false;
        }
        if(event.provider==="meta")direct=await this.repository.resolveMetaDirectMessage(event,leaseId,direct,appId);
        const canonical=direct.chatId;
        const assertIdentity=async()=>{if(event.provider==="meta")await this.repository.assertMetaDirectIdentityCurrent(event,leaseId,canonical,appId);};
        const context=await this.repository.directContext(event,direct.chatId,direct.senderId,direct.senderPhone);
        if(!context){
          await this.repository.complete(event,leaseId,"IGNORED",true,"DIRECT_BOT_NOT_ASSIGNED");
          return false;
        }
        const secret=await this.secrets.resolve(context.zammadSecretReference,{kind:"zammad",tenantId:event.tenantId,purpose:"service"});
        if(!secret.token)throw new InboundValidationError("Zammad service token is missing");
        const zammad=new ZammadClient({baseUrl:context.zammadBaseUrl,token:secret.token,...(event.provider==="meta"?{beforeRequest:assertIdentity}:{})});
        const providerMessage=directAsProviderMessage(direct,context);
        const customerIdentity=direct.fromMe
          ? {...providerMessage,participantName:context.participantName,participantPhone:context.participantPhone}
          : providerMessage;
        reviewContext=context;reviewMessage=providerMessage;
        const preparedMedia=await this.prepareMedia(event,context,providerMessage,assertIdentity);
        const customerLogin=await zammadCustomerLogin(event,customerIdentity);
        const customerMobile=zammadCustomerMobile(customerIdentity);
        const customer=await observeZammad("ensure_direct_customer",()=>zammad.ensureCustomer({
          login:customerLogin,
          firstname:zammadCustomerName(customerIdentity),
          ...(customerMobile?{mobile:customerMobile}:{}),
        }));
        const desiredTitle=formatZammadTicketTitle({kind:"direct",customerName:zammadCustomerName(customerIdentity)});
        const replaceableTitles=new Set([formatZammadTicketTitle({kind:"direct"}),...(customerMobile?[formatZammadTicketTitle({kind:"direct",customerName:customerMobile})]:[])]);
        const refreshDirectTicket=async(existing:{id:number;state:string;title:string})=>{
          const changes:Record<string,string>={wasalx_latest_external_message_id:providerMessage.messageId};
          if(existing.state.trim().toLocaleLowerCase("en-US")==="closed")changes.state="open";
          if(replaceableTitles.has(existing.title)&&existing.title!==desiredTitle)changes.title=desiredTitle;
          await observeZammad("refresh_direct_ticket",()=>zammad.updateTicket(existing.id,changes));
        };
        const appendDirectArticle=async(ticketId:string,skipRefresh=false)=>{
          const numeric=ticketNumber(ticketId);
          if(!skipRefresh)await refreshDirectTicket(await observeZammad("get_direct_ticket",()=>zammad.getTicket(numeric)));
          const existing=await observeZammad("find_direct_article",()=>zammad.findTicketArticlePreference(numeric,"wasalx_external_message_id",providerMessage.messageId));
          if(existing)return String(existing.id);
          const added=await observeZammad("append_direct_article",()=>zammad.addArticle(numeric,directArticle(providerMessage,customer.id,preparedMedia?.attachment)));
          return String(added.id);
        };
        const result=await this.repository.processDirectMessage(event,context,direct,{id:customer.id,login:customer.login},{
          create:async(correlationKey,reference)=>{
            const existing=await observeZammad("find_direct_conversation",()=>zammad.findByCorrelationKey(correlationKey));
            if(existing){
              await refreshDirectTicket(existing);
              const articleId=await appendDirectArticle(String(existing.id),true);
              return{id:String(existing.id),number:existing.number,...(articleId?{articleId}:{})};
            }
            const created=await observeZammad("create_direct_ticket",()=>zammad.createTicket({
              title:formatZammadTicketTitle({kind:"direct",customerName:zammadCustomerName(customerIdentity)}),group:context.zammadGroup,customerId:customer.id,
              body:messageBody(providerMessage),reference,priority:"2 normal",ownerId:directOwnerId(context),
              articleSender:providerMessage.fromMe?"Agent":"Customer",
              articlePreferences:providerArticlePreferences(providerMessage),
              attachments:preparedMedia?[preparedMedia.attachment]:undefined,
              metadata:{wasalx_correlation_key:correlationKey,wasalx_group_id:canonical,
                wasalx_connection_id:event.connectionId,wasalx_provider:event.provider.toUpperCase(),
                wasalx_source_message_id:providerMessage.messageId,wasalx_latest_external_message_id:providerMessage.messageId,
                wasalx_bot_conversation:"true",wasalx_bot_state:"BOT",...clientRoutingMetadata(context.clientRoute)},
            }));
            const createdArticle=await observeZammad("find_created_direct_article",()=>zammad.findTicketArticlePreference(created.id,"wasalx_external_message_id",providerMessage.messageId));
            return{id:String(created.id),number:created.number,...(createdArticle?{articleId:String(createdArticle.id)}:{})};
          },
          append:appendDirectArticle,
        });
        if (result.pendingTarget) {
          if (event.attempts < this.maxAttempts) throw new ProviderTargetPendingError("Provider choice prompt is not available yet");
          await this.repository.complete(event, leaseId, "UNMATCHED", true, "PROVIDER_TARGET_UNAVAILABLE");
          return false;
        }
        if(result.ignored){
          await this.repository.complete(event,leaseId,"IGNORED",true,result.ignoreReason??"DIRECT_BOT_NOT_ASSIGNED");
          return false;
        }
        if(preparedMedia)await this.repository.linkMediaObject(event,providerMessage,preparedMedia.mediaObjectId,preparedMedia.attachment.filename,preparedMedia.attachment["mime-type"]);
        await this.repository.complete(event,leaseId,result.duplicate?"DUPLICATE":"PROCESSED",false);
        return result.queued;
      }

      const message = event.eventType === "quarantine.reprocess"
        ? quarantineReprocessMessage(event)
        : await normalize(event);
      if (!message) {
        const reason = receiptRejection ? `UNSUPPORTED_WAHA_RECEIPT_${receiptRejection}` : "UNSUPPORTED_EVENT_PAYLOAD";
        await this.repository.complete(event, leaseId, "IGNORED", true, reason);
        return false;
      }
      if(event.eventType==="quarantine.reprocess"){
        const original=await this.repository.originalReprocessParticipant(event,message.groupId);
        if(!original)throw new InboundValidationError("Original message identity is unavailable or privacy processing is active");
        if(original.fromApi)throw new InboundValidationError("Provider API messages cannot be reprocessed as customer messages");
        const{replyToMessageId:rawReplyToMessageId,...identity}=original,replyToMessageId=boundedPayloadString(rawReplyToMessageId,1024);if(!replyToMessageId)throw new InboundValidationError("Original provider reply target is unavailable");Object.assign(message,identity);reprocessReplyToMessageId=replyToMessageId;
      }
      if (message.fromApi) {
        await this.repository.complete(event, leaseId, "IGNORED", true, "PROVIDER_API_MESSAGE");
        return false;
      }
      if(event.eventType!=="quarantine.reprocess"&&!await this.repository.messageIsWithinAdmissionWindow(event,message.timestamp)){
        await this.repository.complete(event,leaseId,"IGNORED",true,"PROVIDER_MESSAGE_BEFORE_ADMISSION_WINDOW");
        return false;
      }
      const history=event.eventType==="quarantine.reprocess"?"skipped":await this.repository.normalize(event,message,true);
      if(history==="duplicate"){
        await this.repository.complete(event,leaseId,"DUPLICATE",true);
        return false;
      }
      if(message.eventKind==="REACTION"){
        await this.repository.complete(event,leaseId,"PROCESSED",true,"REACTION_RECORDED");
        return false;
      }
      const context = await this.repository.context(event, message.groupId, message.participantId);
      reviewMessage=message;
      if(context)reviewContext=context;
      let preparedMedia:PreparedInboundMedia|undefined;
      if(history!=="skipped"&&message.media){
        const mediaContext=context??await this.repository.workspaceMediaContext(event,message.groupId);
        if(mediaContext){preparedMedia=await this.prepareMedia(event,mediaContext,message);if(preparedMedia)await this.repository.linkMediaObject(event,message,preparedMedia.mediaObjectId,preparedMedia.attachment.filename,preparedMedia.attachment["mime-type"])}
      }
      if (!context) {
        if(event.eventType==="quarantine.reprocess")throw new InboundValidationError("Review routing context is no longer active");
        if(await this.repository.hasRunnableGroupBinding(event,message.groupId))throw new ProviderTargetPendingError("Group routing context is temporarily unavailable");
        await this.repository.complete(event,leaseId,history==="skipped"?"IGNORED":"UNMATCHED",true,history==="skipped"?"ROUTING_CONTEXT_UNAVAILABLE":undefined);
        return false;
      }
      if(message.fromMe){
        message.participantName??=context.connectionName;
        message.participantPhone??=context.connectionPhone;
      }else{
        message.participantPhone??=context.participantPhone;
      }
      reviewContext = context;
      reviewMessage = message;
      const quotedCommand=await this.runQuotedTicketCommand(event,leaseId,context,message);
      if(quotedCommand.handled)return quotedCommand.queued;
      const rules = event.eventType === "quarantine.reprocess"
        ? reprocessRules(event, context)
        : asRules(context);
      const ruleStartedAt=Date.now();
      const sender = rules.some(rule=>rule.enabled&&rule.teamSenderPolicy==="exclude")
        ? await this.repository.groupRuleSender(event,message)
        : "unknown";
      const evaluation = testRules(message.text, rules, { sender });
      const matches=evaluation.matches.filter(match=>{const rule=context.rules.find(candidate=>candidate.id===match.ruleId);return!rule?.groupCommand||!message.fromMe&&match.start===0&&isGroupCommandMatch(message.text,rule)});
      const commandMatch=matches.find(match=>context.rules.find(rule=>rule.id===match.ruleId)?.groupCommand);
      const commandRule=commandMatch?context.rules.find(rule=>rule.id===commandMatch.ruleId):undefined;
      const references = [...new Set((commandMatch?[commandMatch]:matches).map((match) => match.normalizedValue))];
      const matchedReferences = commandMatch ? [] : references;
      const ruleOutcome=references.length>0?"matched":"unmatched";
      observeDuration("wasalx_rule_evaluation_seconds",ruleStartedAt,{result:ruleOutcome});
      recordMetric("wasalx_rule_matches_total",references.length||1,{result:ruleOutcome});
      if (evaluation.truncatedRuleIds.length > 0 || references.length > context.maxIdentifiers) {
        const truncated = evaluation.truncatedRuleIds.length > 0;
        await this.repository.quarantineInbound(event, {
          bindingId: context.bindingId,
          reasonCode: "IDENTIFIER_LIMIT_EXCEEDED",
          safeSummary: truncated
            ? "Rule evaluation reached its safe processing limit"
            : "Message exceeded the configured identifier limit",
          safeMetadata: truncated
            ? { configured_limit: context.maxIdentifiers }
            : { reference_count: references.length, configured_limit: context.maxIdentifiers },
        });
        recordMetric("wasalx_media_quarantine_total",1,{
          source:"inbound",
          reason:"identifier_limit_exceeded",
          result:"created",
        });
        await this.repository.complete(event, leaseId, "QUARANTINED", true, "IDENTIFIER_LIMIT_EXCEEDED");
        return false;
      }
      // Persist one body-free observation per evaluated rule. The repository's
      // unique key makes retrying the same provider event metrics-idempotent.
      await this.repository.recordRuleObservations?.(event, context, rules, matches);
      if (event.eventType === "quarantine.reprocess") validateReprocessReference(event, references);
      if (references.length===0 && !rulesAllowUnmatchedAssociation(rules,sender)) {
        await this.repository.complete(event,leaseId,"UNMATCHED",true,"TEAM_SENDER_EXCLUDED");
        return false;
      }
      const quotedTickets = message.quotedMessageId
        ? await this.repository.ticketsForQuotedMessage(event,message.quotedMessageId,context,references)
        : [];
      // An explicit quote cannot fall through to another reference or case.
      if(message.quotedMessageId&&quotedTickets.length===0){
        if(event.attempts<this.maxAttempts)throw new ProviderTargetPendingError("Quoted provider message is not available yet");
        await this.repository.complete(event,leaseId,"UNMATCHED",true,"PROVIDER_TARGET_UNAVAILABLE");
        return false;
      }
      const caseTickets = !message.quotedMessageId && references.length === 0
        ? await this.repository.ticketsForCaseNumbers?.(
            event,
            context,
            extractConfiguredCaseNumbers(message.text),
          ) ?? []
        : [];
      if (references.length === 0 && quotedTickets.length === 0 && caseTickets.length === 0) {
        await this.repository.complete(event, leaseId, "UNMATCHED", true, message.quotedMessageId?"PROVIDER_TARGET_UNAVAILABLE":undefined);
        return false;
      }
      const normalized = history==="skipped"?await this.repository.normalize(event,message):history;
      if (normalized === "duplicate") {
        recordWebhook(event.provider,"duplicate","message");
        await this.repository.complete(event, leaseId, "DUPLICATE", true);
        return false;
      }

      if(!preparedMedia&&message.media){preparedMedia=await this.prepareMedia(event,context,message);if(preparedMedia)await this.repository.linkMediaObject(event,message,preparedMedia.mediaObjectId,preparedMedia.attachment.filename,preparedMedia.attachment["mime-type"])}
      const secret = await this.secrets.resolve(context.zammadSecretReference,{kind:"zammad",tenantId:event.tenantId,purpose:"service"});
      if (!secret.token) throw new InboundValidationError("Zammad service token is missing");
      const zammad = new ZammadClient({ baseUrl: context.zammadBaseUrl, token: secret.token });
      const customerMobile=zammadCustomerMobile(message);
      const customer = await observeZammad("ensure_customer",async () => zammad.ensureCustomer({
        login: await zammadCustomerLogin(event, message),
        firstname: zammadCustomerName(message),
        ...(customerMobile?{mobile:customerMobile}:{}),
      }));
      await this.repository.linkZammadCustomer(event, message, { id: customer.id, login: customer.login });

      if (quotedTickets.length>0 || references.length === 0) {
        let feedbackQueued=false;
        for (const ticketId of new Set([...quotedTickets, ...caseTickets])) {
          const linked=await this.repository.linkQuotedMessage(event,message,ticketId,context,{
            reopen:()=>observeZammad("reopen_ticket",()=>zammad.updateTicket(
              ticketNumber(ticketId),{state:"open",wasalx_correlation_status:"OPEN"},
            )).then(ticket=>ticket.updated_at),
            append:async () => {
            const existing=await observeZammad("find_quoted_article",()=>zammad.findTicketArticlePreference(
              ticketNumber(ticketId),"wasalx_external_message_id",message.messageId,
            ));
            if(existing)return String(existing.id);
            const added=await observeZammad("add_quoted_article",() => zammad.addArticle(
              ticketNumber(ticketId),
              article(message, customer.id, preparedMedia?.attachment),
            ));
            return String(added.id);
            },
          },matchedReferences);
          feedbackQueued ||= linked?.feedbackQueued===true;
        }
        observeInboundToZammad(event);
        await this.repository.complete(event, leaseId, "PROCESSED", false);
        return feedbackQueued;
      }

      const tickets: Array<{ id: string; number: string; feedbackQueued?:boolean }> = [];
      for (const reference of references) {
        const ticket = await this.repository.correlate(event, context, message, reference, {
          create: async (rawKey) => {
            const correlationKey = await sha256(rawKey);
            const existing = await observeZammad(
              "find_correlation",
              () => zammad.findByCorrelationKey(correlationKey),
            );
            if(existing){const article=await observeZammad("find_existing_correlation_article",()=>zammad.findTicketArticlePreference(existing.id,"wasalx_external_message_id",message.messageId));return{id:String(existing.id),number:existing.number,...(article?{articleId:String(article.id)}:{})}}
            const created = await observeZammad("create_ticket",() => zammad.createTicket({
              title:formatZammadTicketTitle({kind:"group",groupName:context.groupName,
                ruleName:matches.find(match=>match.normalizedValue===reference)?.ruleName,reference}),
              group: context.zammadGroup,
              customerId: customer.id,
              body: messageBody(message),
              reference,
              priority: zammadPriority(context.defaultPriority),
              ownerId: zammadOwnerId(context),
              articleSender: message.fromMe ? "Agent" : "Customer",
              articlePreferences: providerArticlePreferences(message),
              attachments: preparedMedia ? [preparedMedia.attachment] : undefined,
              metadata: {
                wasalx_correlation_key: correlationKey,
                wasalx_group_id: message.groupId,
                wasalx_connection_id: event.connectionId,
                wasalx_provider: event.provider.toUpperCase(),
                wasalx_source_message_id: message.messageId,
                wasalx_latest_external_message_id: message.messageId,
                wasalx_rule_version: String(context.ruleVersion),
                wasalx_correlation_status: "OPEN",
                ...zammadRoutingMetadata(context),
              },
            }));
            const createdArticle=await observeZammad("find_created_article",()=>zammad.findTicketArticlePreference(created.id,"wasalx_external_message_id",message.messageId));
            return { id: String(created.id), number: created.number, ...(createdArticle?{articleId:String(createdArticle.id)}:{}) };
          },
          append: async (ticketId) => {
            const existing=await observeZammad("find_article",()=>zammad.findTicketArticlePreference(
              ticketNumber(ticketId),"wasalx_external_message_id",message.messageId,
            ));
            if(existing)return String(existing.id);
            const added=await observeZammad("add_article",() => zammad.addArticle(
              ticketNumber(ticketId),
              article(message, customer.id, preparedMedia?.attachment),
            ));
            return String(added.id);
          },
          reopen: (ticketId) => observeZammad(
            "reopen_ticket",
            () => zammad.updateTicket(ticketNumber(ticketId), { state: "open", wasalx_correlation_status: "OPEN" }),
          ).then((ticket) => ticket.updated_at),
        },undefined,matchedReferences.includes(reference));
        tickets.push(ticket);
      }

      let queued = tickets.some(ticket=>ticket.feedbackQueued===true);
      if (!message.fromMe) {
        const response=commandRule?.groupCommand
          ?await this.runGroupCommand(event,context,message,commandMatch!,commandRule.groupCommand,tickets,{id:String(customer.id),login:customer.login,name:zammadCustomerName(message)},zammad)
          :renderAcknowledgement(context.acknowledgementTemplate,tickets.map(ticket=>ticket.number));
        const acknowledgement=await this.repository.enqueueAcknowledgement(
          event,
          context,
          message,
          response,
          tickets.map((ticket) => ticket.id),
          context.groupDisclosureEnabled ? context.groupDisclosureMessage : null,
          reprocessReplyToMessageId,
          Boolean(commandRule?.groupCommand),
        );
        queued ||= acknowledgement!==null;
      }
      if (event.eventType === "quarantine.reprocess") {
        await this.repository.completeQuarantineReprocess(event, tickets.map((ticket) => ticket.id));
        recordMetric("wasalx_media_quarantine_total",1,{
          source:"inbound",
          reason:"reprocess",
          result:"resolved",
        });
      }
      observeInboundToZammad(event);
      await this.repository.complete(event, leaseId, "PROCESSED", false);
      return queued;
    } catch (error) {
      if(error instanceof TicketCommandAuthorizationError){
        await this.repository.quarantineInbound(event,{
          bindingId:reviewContext&&"bindingId" in reviewContext?reviewContext.bindingId:undefined,
          reasonCode:"NON_RETRYABLE_REVIEW",
          safeSummary:"Quoted command actor is not authorized by the active workflow.",
          safeMetadata:{error_code:error.code},
        });
        await this.repository.complete(event,leaseId,"QUARANTINED",true,error.code);
        return false;
      }
      if(error instanceof InboundAssociationError){
        await this.repository.quarantineInbound(event,{
          bindingId:reviewContext&&"bindingId" in reviewContext?reviewContext.bindingId:undefined,
          reasonCode:"NON_RETRYABLE_REVIEW",safeSummary:error.message,safeMetadata:{error_code:error.code},
        });
        await this.repository.complete(event,leaseId,"QUARANTINED",true,error.code);
        return false;
      }
      if (isQuarantinedMediaError(error)) {
        // Provider payloads and media URLs are always removed from terminal
        // quarantine rows. Operators receive only the bounded safe error code.
        if (reviewMessage) {
          const code = mediaErrorCode(error);
          await this.repository.quarantineInbound(event, {
            bindingId:reviewContext&&"bindingId" in reviewContext?reviewContext.bindingId:undefined,
            reasonCode: mediaQuarantineReason(code),
            safeSummary: mediaQuarantineSummary(code),
            safeMetadata: {
              error_code: code,
              ...(reviewMessage.media?.mimeType ? { media_type: reviewMessage.media.mimeType.slice(0,120) } : {}),
            },
          });
          recordMetric("wasalx_media_quarantine_total",1,{
            source:"inbound",
            reason:mediaQuarantineReason(code),
            result:"created",
          });
        }
        await this.repository.complete(event, leaseId, "QUARANTINED", true, mediaErrorCode(error));
        return false;
      }
      const retryable = (
        !(error instanceof InboundValidationError)
        && !(error instanceof MetaDirectIdentityError)
        && (!(error instanceof ProviderError) || error.retryable)
        && !(error instanceof MetaCredentialMetadataError)
        && !(error instanceof MetaLifecycleError)
        && (!(error instanceof ZammadError) || error.retryable)
        && (!(error instanceof SecretResolutionError) || error.retryable)
        && (!(error instanceof MediaRuntimeError) || isRetryableMediaError(error))
        && event.attempts < this.maxAttempts
      );
      await this.repository.fail(
        event,
        leaseId,
        retryable,
        safeError(error),
        retryable ? new Date(Date.now() + backoffMs(event.attempts)).toISOString() : undefined,
      );
      if (!retryable && event.eventType === "quarantine.reprocess") {
        await this.repository.reopenQuarantineReprocess(event, error instanceof InboundValidationError ? "REFERENCE_NO_LONGER_VALID" : "REPROCESS_FAILED");
        recordMetric("wasalx_media_quarantine_total",1,{
          source:"inbound",
          reason:error instanceof InboundValidationError?"reference_no_longer_valid":"reprocess_failed",
          result:"reopened",
        });
      }
      return false;
    }
  }

  private async runQuotedTicketCommand(event:InboundEvent,leaseId:string,context:InboundContext,message:ProviderMessage){
    const input={tenantId:event.tenantId,connectionId:event.connectionId,inboxId:event.id,bindingId:context.bindingId,
      groupId:message.groupId,participantId:message.participantId,messageId:message.messageId,quotedMessageId:message.quotedMessageId,
      text:message.text,fromMe:message.fromMe,fromApi:message.fromApi,hasMedia:!!message.media,provider:event.provider==='waha'?'WAHA' as const:'META' as const};
    if(!/^\/[a-z][a-z0-9_-]{0,31}$/iu.test(input.text.trim()))return {handled:false,queued:false};
    const previous=await this.repository.storedQuotedCommand(input);
    if(previous&&previous.receipt.state!=='PENDING'){
      await this.repository.complete(event,leaseId,'PROCESSED',true);return {handled:true,queued:false};
    }
    const resume=previous&&['ATTEMPTED','OUTCOME_UNKNOWN','SUCCEEDED','FAILED_TERMINAL'].includes(previous.nativeActionState??'')?previous:null;
    if(resume?.nativeActionState==='FAILED_TERMINAL'){
      await this.repository.complete(event,leaseId,'QUARANTINED',true,'QUOTED_COMMAND_FAILED_TERMINAL');return {handled:true,queued:false};
    }
    let candidate;
    if(!resume){try{candidate=await this.repository.quotedCommandCandidate(input);}catch{
      await this.repository.quarantineInbound(event,{bindingId:context.bindingId,reasonCode:'NON_RETRYABLE_REVIEW',safeSummary:'Quoted command target or access could not be verified.',safeMetadata:{error_code:'QUOTED_COMMAND_REJECTED'}});
      await this.repository.complete(event,leaseId,'QUARANTINED',true,'QUOTED_COMMAND_REJECTED');return {handled:true,queued:false};
    }}
    if(!resume&&!candidate)return {handled:false,queued:false};
    let resumedQuoteMessageId:string|undefined;
    if(resume){
      const snapshot=resume.snapshot;
      const quoteMessageId=snapshot?.resolved_quoted_message_id??snapshot?.quoted_message_id;
      if(!snapshot||snapshot.connection_id!==input.connectionId||snapshot.message_id!==input.messageId||
        snapshot.source_sha256!==ticketEventSourceHash('INBOUND',input.connectionId,input.messageId)||
        typeof snapshot.ticket_id!=='string'||!/^[1-9][0-9]*$/u.test(snapshot.ticket_id)||
        typeof quoteMessageId!=='string'||!quoteMessageId){
        await this.repository.quarantineInbound(event,{bindingId:context.bindingId,reasonCode:'NON_RETRYABLE_REVIEW',safeSummary:'Pinned quoted command receipt requires integrity review.',safeMetadata:{error_code:'QUOTED_COMMAND_RECEIPT_INVALID'}});
        await this.repository.complete(event,leaseId,'QUARANTINED',true,'QUOTED_COMMAND_RECEIPT_INVALID');return {handled:true,queued:false};
      }
      resumedQuoteMessageId=quoteMessageId;
    }
    const secret=await this.secrets.resolve(context.zammadSecretReference,{kind:'zammad',tenantId:event.tenantId,purpose:'service'});
    const token=secret.token??secret.apiKey;if(!token)throw new Error('Zammad service credential is unavailable');
    const zammad=new ZammadClient({baseUrl:context.zammadBaseUrl,token});
    let prepared:Awaited<ReturnType<InboundRepository['prepareQuotedCommand']>>;
    let targetTicketId:string;
    if(resume){
      const snapshot=resume.snapshot!;
      targetTicketId=String(snapshot.ticket_id);
      prepared={receipt:resume.receipt,plan:snapshot.plan as ReturnType<typeof import('../../../packages/core/src/ticket-event-flow.js').planTicketEvent>,
        quoteMessageId:resumedQuoteMessageId!,state:resume.nativeActionState!,snapshot,result:resume.result};
    }else{
      if(!candidate)throw new Error('Command target unavailable');targetTicketId=candidate.ticketId;
      await this.repository.normalize(event,message);
      const actor=await this.repository.quotedCommandActor(input);
      const native=await zammad.readQuotedCommandContext(ticketNumber(candidate.ticketId),actor?.member_email??null);
      prepared=await this.repository.prepareQuotedCommand(input,candidate,native);
      if(prepared.state==='TERMINAL'){await this.repository.complete(event,leaseId,'PROCESSED',true);return {handled:true,queued:false};}
    }
    const id=prepared.receipt.id;
    const valid=(result:{state:string;execution_id?:string;ticket_id?:string;request_sha256?:string;article_id?:string;disposition?:string;outcome?:string})=>result.state==='SUCCEEDED'&&result.execution_id===id&&result.ticket_id===targetTicketId&&result.request_sha256===prepared.snapshot?.request_sha256&&/^[1-9][0-9]*$/u.test(result.article_id??'')&&
      (prepared.snapshot?.disposition!=='TRANSCRIPT_ONLY_DENIED'||(result.disposition==='TRANSCRIPT_ONLY_DENIED'&&result.outcome==='REJECTED'));

    if(prepared.state!=='NO_NATIVE_ACTION'&&prepared.state!=='SUCCEEDED'){
      const outcome=await nativeCommandOnce({state:prepared.state},{
        readReceipt:()=>zammad.readQuotedCommandReceipt(ticketNumber(targetTicketId),id),validReceipt:valid,
        recordSuccess:result=>this.repository.recordQuotedCommandNative(event.tenantId,id,'SUCCEEDED',result),
        claimAttempt:()=>this.repository.claimQuotedCommand(input,id),
        closeOnce:()=>zammad.closeQuotedCommand(ticketNumber(targetTicketId),id),
        recordUnknown:()=>this.repository.recordQuotedCommandNative(event.tenantId,id,'OUTCOME_UNKNOWN'),
      });
      if(outcome.state==='HELD')throw new Error('QUOTED_COMMAND_EFFECT_HOLD');
      if(outcome.state!=='SUCCEEDED'){
        await this.repository.quarantineInbound(event,{bindingId:context.bindingId,reasonCode:'NON_RETRYABLE_REVIEW',safeSummary:'Ticket command outcome requires review; no automatic repeat.',safeMetadata:{error_code:'QUOTED_COMMAND_OUTCOME_UNKNOWN'}});
        await this.repository.complete(event,leaseId,'QUARANTINED',true,'QUOTED_COMMAND_OUTCOME_UNKNOWN');return {handled:true,queued:false};
      }
    }
    if(prepared.state!=='NO_NATIVE_ACTION')await this.repository.linkQuotedCommandReceipt(input,id);
    const queued=await this.repository.finishQuotedCommand(input,prepared);await this.repository.complete(event,leaseId,'PROCESSED',true);
    return {handled:true,queued:queued>0};
  }

  private async runGroupCommand(
    event:InboundEvent,
    context:InboundContext,
    message:ProviderMessage,
    match:RuleMatch,
    command:NonNullable<InboundContext["rules"][number]["groupCommand"]>,
    tickets:Array<{id:string;number:string}>,
    customer:{id:string;login:string;name:string},
    zammad:ZammadClient,
  ){
    const variables={
      "channel.kind":"group","channel.provider":event.provider,"channel.connection_id":event.connectionId,
      "message.id":message.messageId,"message.text":message.text,"message.argument":message.text.slice(match.end).trim(),
      "group.id":message.groupId,"group.name":context.groupName,"customer.zammad_id":customer.id,"customer.login":customer.login,"customer.name":customer.name,
      "match.value":match.normalizedValue,"ticket.id":tickets[0]?.id??"","ticket.number":tickets[0]?.number??"",
    };
    const requestInput=groupCommandRequestInput(command.input,variables);
    let execution=await this.repository.beginGroupCommandAction(event,match.ruleId,command.actionId,requestInput,this.maxAttempts);
    if(!execution)throw new InboundValidationError("The configured group command action is unavailable");
    if(execution.action.authScheme==="BEARER"&&!isBotActionSecretReference(event.tenantId,execution.action.kind,execution.action.secretReference,execution.action.actionId))throw new InboundValidationError("Group command credential is outside the action namespace");
    if(execution.state==="PREPARED"||execution.state==="FAILED_RETRYABLE"){
      const secret=execution.action.authScheme==="BEARER"?await this.secrets.resolve(execution.action.secretReference!,{kind:"bot-action",tenantId:event.tenantId,actionKey:execution.action.actionId,actionKind:execution.action.kind}):undefined;
      const bearer=secret?.accessToken??secret?.token??secret?.value;
      if(execution.action.authScheme==="BEARER"&&(!bearer||bearer.length>8192))throw new InboundValidationError("Group command credential is unavailable");
      const claimed=await this.repository.claimGroupCommandAction(event,execution.id);
      if(!claimed)throw new GroupCommandRetryError("Group action execution is currently fenced");
      const result=await executeBotAction({...claimed.action,id:claimed.id,requestInput:claimed.requestInput},bearer,this.actionTransport);
      execution=await this.repository.completeGroupCommandAction(event,claimed.id,match.ruleId,result);
    }
    if(execution.state==="RUNNING")throw new GroupCommandRetryError("Group action execution is currently running");
    if(execution.state==="FAILED_RETRYABLE")throw new GroupCommandRetryError(execution.safeError??"Group action will be retried");
    if(execution.state==="OUTCOME_UNKNOWN")throw new GroupCommandOutcomeUnknownError(execution.safeError??"Group action result requires operator review");
    const response=execution.state==="SUCCEEDED"
      ?renderGroupCommand(command.successReply,{...variables,...execution.responseVariables})
      :renderGroupCommand(command.failureReply,{...variables,"action.error":execution.safeError??"Group action failed"});
    for(const ticket of tickets){
      const ticketId=ticketNumber(ticket.id);const key=`group-command:${event.id}:${match.ruleId}`;
      if(!await observeZammad("find_group_command_reply",()=>zammad.hasTicketArticlePreference(ticketId,"wasalx_group_command_key",key)))await observeZammad("add_group_command_reply",()=>zammad.addArticle(ticketId,{body:response,content_type:"text/plain",type:"note",internal:false,sender:"Agent",subject:"WasalX group automation",preferences:{wasalx_origin:"bot",wasalx_group_command_key:key}}));
    }
    return response;
  }

  private async prepareMedia(event: InboundEvent, context: InboundMediaContext, message: ProviderMessage, beforeIdentityRequest?:()=>Promise<void>): Promise<PreparedInboundMedia | undefined> {
    if (!message.media || context.mediaEnabled === false) return undefined;
    if (!this.media) throw new MediaRuntimeError("Inbound media processing is unavailable", "MEDIA_RUNTIME_UNAVAILABLE", false);
    const providerContext = event.provider === "waha"
      ? await this.repository.renewWahaWorkerAssignment(event, context)
      : context;
    const beforeMetaRequest=event.provider==="meta"?async(accessToken:string)=>{
      await beforeIdentityRequest?.();
      if(!providerContext.metaCredentialContext)throw new InboundValidationError("Meta credential context is unavailable");
      assertMetaLifecycleAccess(providerContext.metaCredentialContext.lifecycle);
      const proof=await this.repository.currentMetaCredentialProof(event,providerContext.connectionSecretReference,providerContext.metaCredentialContext);
      assertMetaCredentialProof(proof,{appId:event.metaWebhookAppId??this.appId??"",accessToken});
    }:undefined;
    return this.media.prepare({
      tenantId: event.tenantId,
      connectionId: event.connectionId,
      provider: event.provider,
      connectionSecretReference: providerContext.connectionSecretReference,
      providerBaseUrl: providerContext.providerBaseUrl,
      providerSessionId: providerContext.providerSessionId,
      ...(beforeMetaRequest?{beforeMetaRequest}:{}),
      retentionDays: context.retentionDays,
      media: message.media,
    });
  }
}

function observeInboundToZammad(event:InboundEvent){
  if(!event.receivedAt)return;
  const receivedAt=new Date(event.receivedAt).getTime();
  if(!Number.isFinite(receivedAt)||receivedAt>Date.now())return;
  observeDuration("wasalx_inbound_to_zammad_seconds",receivedAt,{provider:event.provider,result:"succeeded"});
}

async function observeZammad<T>(operation:string,task:()=>Promise<T>){
  const startedAt=Date.now();
  try{
    const result=await task();
    recordMetric("wasalx_ticket_operation_total",1,{operation,component:"inbound",result:"succeeded"});
    observeDuration("wasalx_ticket_operation_seconds",startedAt,{operation,component:"inbound",result:"succeeded"});
    return result;
  }catch(error){
    recordMetric("wasalx_ticket_operation_total",1,{operation,component:"inbound",result:"failed"});
    observeDuration("wasalx_ticket_operation_seconds",startedAt,{operation,component:"inbound",result:"failed"});
    throw error;
  }
}

class InboundValidationError extends Error {}
class ProviderTargetPendingError extends Error {}
class GroupCommandRetryError extends Error {}
class GroupCommandOutcomeUnknownError extends InboundValidationError {}

function asRules(context: InboundContext): TriggerRule[] {
  return context.rules.map((rule) => ({ ...rule, matchCount: 0 }));
}

async function normalize(event: InboundEvent): Promise<ProviderMessage | null> {
  if (event.provider === "waha") {
    return new WahaAdapter({ baseUrl: "http://private.invalid", apiKey: "unused", sessionFor: () => "unused" })
      .normalizeWebhook(event.connectionId, event.payload, new Headers());
  }
  return new MetaGroupsAdapter({ accessToken: "unused-token-value", graphVersion: "v1.0", phoneNumberIdFor: () => "unused" })
    .normalizeWebhook(event.connectionId, event.payload);
}

async function normalizeDirect(event:InboundEvent):Promise<DirectProviderMessage|null>{
  if(event.eventType==="quarantine.reprocess"||event.eventType==="session.status")return null;
  if(event.provider==="waha")return new WahaAdapter({baseUrl:"http://private.invalid",apiKey:"unused",sessionFor:()=>"unused"}).normalizeDirectWebhook(event.connectionId,event.payload,new Headers());
  return new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v1.0",phoneNumberIdFor:()=>"unused"}).normalizeDirectWebhook(event.connectionId,event.payload);
}

async function normalizeReceipts(event:InboundEvent,reject?:(reason:WahaReceiptRejection)=>void){
  if(event.provider==="waha")return new WahaAdapter({baseUrl:"http://private.invalid",apiKey:"unused",sessionFor:()=>"unused"}).normalizeReceipts(event.connectionId,event.payload,event.receivedAt,event.providerEngine==="GOWS"||event.providerEngine==="NOWEB"?event.providerEngine:undefined,reject);
  return new MetaGroupsAdapter({accessToken:"unused-token-value",graphVersion:"v1.0",phoneNumberIdFor:()=>"unused"}).normalizeReceipts(event.connectionId,event.payload);
}

async function normalizeMutation(event:InboundEvent):Promise<ProviderMessageMutation|null>{
  if(event.provider!=="waha")return null;
  return new WahaAdapter({baseUrl:"http://private.invalid",apiKey:"unused",sessionFor:()=>"unused"})
    .normalizeMutationWebhook(event.connectionId,event.payload,new Headers());
}

function orderReceipts<T extends {timestamp:string;status:string;receiptKey:string}>(receipts:T[]){
  return[...receipts].sort((left,right)=>{
    const time=new Date(left.timestamp).getTime()-new Date(right.timestamp).getTime();
    return time||receiptRank(left.status)-receiptRank(right.status)||left.receiptKey.localeCompare(right.receiptKey);
  });
}

function receiptRank(status:string){
  if(status==="SENT")return 1;
  if(status==="DELIVERED")return 2;
  if(status==="READ")return 3;
  return 4;
}

function quarantineReprocessMessage(event:InboundEvent):ProviderMessage{
  const groupId=boundedPayloadString(event.payload.externalGroupId,512);
  const reference=boundedPayloadString(event.payload.normalizedReference,256);
  const quarantineId=boundedPayloadString(event.payload.quarantineId,64);
  const requestedAt=boundedPayloadString(event.payload.requestedAt,64);
  const timestamp=requestedAt?new Date(requestedAt):new Date(Number.NaN);
  if(!groupId||!reference||!quarantineId||!Number.isFinite(timestamp.getTime()))throw new InboundValidationError("Review reprocess payload is invalid");
  return{provider:event.provider,connectionId:event.connectionId,eventId:event.providerEventId,messageId:`review:${quarantineId}:${event.id}`,groupId,participantId:"wasalx-review",participantName:"WasalX review",text:reference,fromApi:false,fromMe:false,timestamp:timestamp.toISOString()};
}

function reprocessRules(event:InboundEvent,context:InboundContext){
  const ruleId=boundedPayloadString(event.payload.ruleId,64);
  const rules=asRules(context).filter(rule=>rule.id===ruleId);
  if(rules.length!==1)throw new InboundValidationError("The corrected identifier rule is no longer active");
  return rules;
}

function validateReprocessReference(event:InboundEvent,references:string[]){
  const expected=boundedPayloadString(event.payload.normalizedReference,256);
  if(!expected||references.length!==1||references[0]!==expected)throw new InboundValidationError("The corrected reference does not deterministically match the selected rule");
}

function boundedPayloadString(value:unknown,maximum:number){if(typeof value!=="string"||value.length<1||value.length>maximum||hasUnsafeControl(value))return undefined;return value}
function hasUnsafeControl(value:string){return Array.from(value).some(character=>{const code=character.charCodeAt(0);return code<32||code===127})}

function article(message: ProviderMessage, customerId:number, attachment?: ZammadAttachment) {
  return {
    body: messageBody(message),
    content_type: "text/plain" as const,
    type: "wasalx group message" as const,
    internal: false,
    sender: message.fromMe ? "Agent" as const : "Customer" as const,
    ...(message.fromMe?{}:{origin_by_id:customerId}),
    subject: message.fromMe ? providerSenderSubject(message) : "WhatsApp group message",
    preferences: providerArticlePreferences(message),
    ...(attachment ? { attachments: [attachment] } : {}),
  };
}

function directAsProviderMessage(message:DirectProviderMessage,context:DirectBotContext):ProviderMessage{
  return{provider:message.provider,connectionId:message.connectionId,eventId:message.eventId,messageId:message.messageId,
    groupId:message.chatId,participantId:message.senderId,participantName:message.senderName??(message.fromMe?context.connectionName:context.participantName),
    participantPhone:message.senderPhone??(message.fromMe?context.connectionPhone:context.participantPhone),text:directMessageText(message),
    fromApi:message.fromApi,fromMe:message.fromMe,timestamp:message.timestamp,
    ...(message.quotedMessageId?{quotedMessageId:message.quotedMessageId}:{}),...(message.media?{media:message.media}:{})};
}

function directMessageText(message:DirectProviderMessage){
  if(message.input.type==="text"||message.input.type==="unsupported")return message.input.text;
  if(message.input.type==="choice")return message.input.label;
  if(message.input.type==="flow_response")return ["Form response",...Object.entries(message.input.data).sort(([left],[right])=>left.localeCompare(right)).map(([key,value])=>`${key}: ${value.replace(/\s+/gu," ")}`)].join("\n");
  if(message.input.type==="reaction")return message.input.removed?"Removed a reaction":message.input.emoji?`Reacted with ${message.input.emoji}`:"Reaction received";
  return directLocationText(message.input);
}

function directArticle(message:ProviderMessage,customerId:number,attachment?:ZammadAttachment){
  return{body:messageBody(message),content_type:"text/plain" as const,type:"wasalx group message" as const,
    internal:false,sender:message.fromMe?"Agent" as const:"Customer" as const,...(message.fromMe?{}:{origin_by_id:customerId}),
    subject:message.fromMe?providerSenderSubject(message):"WhatsApp direct message",preferences:providerArticlePreferences(message),...(attachment?{attachments:[attachment]}:{})};
}

function providerArticlePreferences(message: ProviderMessage) {
  const phone = zammadCustomerMobile(message);
  return { wasalx_origin: "provider" as const, wasalx_external_message_id: message.messageId,
    ...(message.participantName?{wasalx_sender_name:message.participantName}:{}),
    ...(phone?{wasalx_sender_phone:phone}:{}) };
}

function providerSenderSubject(message:ProviderMessage){
  const identity=[message.participantName,message.participantPhone].filter(Boolean).join(" · ");
  return identity?`WhatsApp · ${identity}`:"WhatsApp · linked device";
}

function mutationArticle(
  mutation:ProviderMessageMutation,
  providerEventId:string,
  targetExternalMessageId:string,
) {
  const body=mutation.kind==="EDITED"
    ? `WhatsApp message edited\n\n${mutation.replacementText??"(The edited message is empty.)"}`
    : "A WhatsApp participant deleted a previously correlated message.";
  return{
    body,
    content_type:"text/plain" as const,
    type:"note" as const,
    internal:true,
    sender:"Agent" as const,
    subject:mutation.kind==="EDITED"?"WhatsApp message edited":"WhatsApp message deleted",
    preferences:{
      wasalx_origin:"provider" as const,
      wasalx_external_message_id:mutation.actionMessageId,
      wasalx_mutation_event_id:providerEventId,
      wasalx_mutation_kind:mutation.kind,
      wasalx_mutation_target_message_id:targetExternalMessageId,
    },
  };
}

function zammadPriority(priority:InboundContext["defaultPriority"]){
  const values={low:"1 low",normal:"2 normal",high:"3 high"} as const;
  return values[priority]??values.normal;
}

function zammadOwnerId(context:InboundContext){
  if(!context.assignmentMode||context.assignmentMode==="zammad_auto")return undefined;
  if(context.assignmentMode==="unassigned")return 1;
  const value=Number(context.fixedOwnerId);
  if(!Number.isSafeInteger(value)||value<=0)throw new InboundValidationError("Fixed Zammad owner is invalid");
  return value;
}

function zammadRoutingMetadata(context:InboundContext){
  return{
    wasalx_default_priority:context.defaultPriority??"normal",
    wasalx_assignment_mode:context.assignmentMode??"zammad_auto",
    wasalx_business_hours_mode:context.businessHoursMode??"ALWAYS",
    ...(context.slaPolicyId?{wasalx_sla_policy_id:context.slaPolicyId}:{}),
    ...(context.businessHoursCalendarId?{wasalx_business_hours_calendar_id:context.businessHoursCalendarId}:{}),
    ...clientRoutingMetadata(context.clientRoute),
  };
}

function directOwnerId(context:DirectBotContext){
  if(!context.ownerId)return undefined;const value=Number(context.ownerId);
  if(!Number.isSafeInteger(value)||value<=0)throw new InboundValidationError("Client routing Zammad owner is invalid");
  return value;
}

function clientRoutingMetadata(route:InboundContext["clientRoute"]){
  if(!route)return{};return{wasalx_client_routing_version_id:route.versionId,wasalx_client_route_status:route.status,
    wasalx_client_route_matched_by:route.matchedBy,...(route.clientId?{wasalx_client_id:route.clientId}:{}),
    ...(route.escalationGroupId?{wasalx_escalation_group_id:route.escalationGroupId}:{}),
    ...(route.escalationOwnerId?{wasalx_escalation_owner_id:route.escalationOwnerId}:{})};
}

async function zammadCustomerLogin(event: InboundEvent, message: ProviderMessage) {
  // A customer is intentionally scoped to one WasalX tenant and one provider
  // connection. The opaque login prevents raw WhatsApp JIDs from becoming
  // Zammad credentials and prevents implicit cross-number identity merging.
  return `wasalx-${await sha256(`${event.tenantId}\u001f${event.connectionId}\u001f${message.participantId}`)}`;
}

function zammadCustomerName(message: ProviderMessage) {
  const name = (message.participantName ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return name || zammadCustomerMobile(message) || "WhatsApp participant";
}

function zammadCustomerMobile(message:ProviderMessage){
  if(/^\+[1-9][0-9]{5,14}$/u.test(message.participantPhone??""))return message.participantPhone;
  const jid=message.participantId.match(/^([1-9][0-9]{5,14})@(c\.us|s\.whatsapp\.net)$/u);
  if(jid)return`+${jid[1]}`;
  return message.provider==="meta"&&/^[1-9][0-9]{5,14}$/u.test(message.participantId)?`+${message.participantId}`:undefined;
}

function messageBody(message: ProviderMessage) {
  return message.text.trim() || (message.media ? `[${message.media.type} attachment]` : "WhatsApp group message");
}

function ticketNumber(value: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new InboundValidationError("Invalid Zammad ticket ID");
  return parsed;
}

function renderAcknowledgement(template: string, tickets: string[]) {
  return template
    .replaceAll("{{tickets}}", tickets.join(", "))
    .replaceAll("{{count}}", String(tickets.length))
    .replaceAll("{{reference}}", tickets.join(", "));
}

function renderGroupCommand(template:string,variables:Record<string,string>){return template.replace(/\{\{([a-z][a-z0-9_.-]{0,127})\}\}/giu,(_token,key:string)=>{const value=variables[key];if(value===undefined)throw new InboundValidationError(`Group command variable ${key} is unavailable`);return value})}
function groupCommandRequestInput(input:Record<string,string>,variables:Record<string,string>){
  const rendered=Object.fromEntries(Object.entries(input).map(([key,template])=>{
    const value=renderGroupCommand(template,variables);
    if([...value].length>4096)throw new InboundValidationError(`Group command input ${key} is too large`);
    return[key,value];
  }));
  if(Buffer.byteLength(JSON.stringify(rendered),"utf8")>65_536)throw new InboundValidationError("Group command input is too large");
  return rendered;
}
function isGroupCommandMatch(message:string,rule:InboundContext["rules"][number]){const normalized=normalizeMessage(message);return normalized.slice(0,rule.pattern.length).toLocaleUpperCase("en-US")===rule.pattern.toLocaleUpperCase("en-US")&&(normalized.length===rule.pattern.length||/^\s/u.test(normalized.slice(rule.pattern.length)))}

function extractConfiguredCaseNumbers(message: string) {
  const normalized = normalizeMessage(message);
  const values = new Set<string>();
  const matcher = /\b(?:case|ticket|wasalx)\s*(?:#|no\.?|number)?\s*[:-]?\s*([0-9]{1,32})\b/giu;
  for (const match of normalized.matchAll(matcher)) {
    const value = match[1];
    if (value) values.add(value);
    if (values.size >= 20) break;
  }
  return [...values];
}

function sessionStatus(payload: Record<string, unknown>) {
  const nested = payload.payload as Record<string, unknown> | undefined;
  return String(nested?.status ?? payload.status ?? nested?.state ?? payload.state ?? "UNKNOWN").toUpperCase();
}

function mapConnectionState(status: string) {
  const states: Record<string, string> = {
    WORKING: "WORKING",
    SCAN_QR_CODE: "AWAITING_AUTH",
    STARTING: "CONNECTING",
    CONNECTING: "CONNECTING",
    FAILED: "FAILED",
    STOPPED: "ACTION_REQUIRED",
    LOGGED_OUT: "ACTION_REQUIRED",
    DISCONNECTED: "DEGRADED",
  };
  const state = states[status] ?? "DEGRADED";
  return { state, reason: ["WORKING", "AWAITING_AUTH", "CONNECTING"].includes(state) ? undefined : `Provider session reported ${status}` };
}

function providerStatusObservation(event: InboundEvent) {
  if (event.provider !== "waha") throw new InboundValidationError("Session status event has an invalid provider");
  const opaqueSessionId = typeof event.payload.session === "string" ? event.payload.session.trim() : "";
  const rawTimestamp = event.payload.timestamp;
  const observedAt = typeof rawTimestamp === "number" && Number.isSafeInteger(rawTimestamp) && rawTimestamp >= 946_684_800_000
    ? new Date(rawTimestamp)
    : typeof rawTimestamp === "string" ? new Date(rawTimestamp) : new Date(Number.NaN);
  if (!opaqueSessionId || opaqueSessionId.length > 512 || !Number.isFinite(observedAt.getTime())) {
    throw new InboundValidationError("Session status event is missing its generation or timestamp");
  }
  const providerState = sessionStatus(event.payload);
  const mapped = mapConnectionState(providerState);
  return { opaqueSessionId, observedAt: observedAt.toISOString(), providerState, connectionState: mapped.state, reason: mapped.reason };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown inbound error")
    .replace(/(token|secret|authorization|api[-_ ]?key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .slice(0, 500);
}

function mediaErrorCode(error: unknown) {
  return error instanceof MediaRuntimeError || (error instanceof Error && "code" in error && typeof error.code === "string")
    ? String(error.code).replace(/[^A-Z0-9_]/g, "_").slice(0, 120)
    : "MEDIA_QUARANTINED";
}

function mediaQuarantineReason(code:string):"MEDIA_MALWARE_DETECTED"|"MEDIA_TOO_LARGE"|"MEDIA_TYPE_UNSAFE"|"MEDIA_DOWNLOAD_REJECTED"|"NON_RETRYABLE_REVIEW"{
  if(code==="MALWARE")return"MEDIA_MALWARE_DETECTED";
  if(code.includes("SIZE"))return"MEDIA_TOO_LARGE";
  if(code.includes("MIME")||code.includes("TYPE")||code==="UNSUPPORTED_MIME")return"MEDIA_TYPE_UNSAFE";
  if(code.includes("URL")||code.includes("DOWNLOAD")||code.startsWith("WAHA_MEDIA"))return"MEDIA_DOWNLOAD_REJECTED";
  return"NON_RETRYABLE_REVIEW";
}
function mediaQuarantineSummary(code:string){if(code==="MALWARE")return"Media was rejected by malware scanning";if(code.includes("SIZE"))return"Media exceeded a configured safety limit";if(code.includes("MIME")||code.includes("TYPE"))return"Media type could not be safely verified";return"Media could not be accepted safely"}
